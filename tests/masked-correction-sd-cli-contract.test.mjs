import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  SD_CLI_INPAINT_MODELS,
  SD_CLI_INPAINT_REQUIRED_FLAGS,
  encodeSdCliMaskPng,
  sdCliCrc32,
  sdCliInpaintArguments,
} from '../apps/api/src/services/masked-correction-sd-cli-contract.ts';

function decodeMask(mask) {
  const png = encodeSdCliMaskPng(mask);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8;
  let ihdr = null;
  const idat = [];
  let ended = false;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    assert.equal(sdCliCrc32(png.subarray(offset + 4, offset + 8 + length)), crc, `${type} CRC`);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') { ended = true; offset += 12; break; }
    offset += length + 12;
  }
  assert.ok(ihdr);
  assert.equal(ended, true);
  assert.equal(offset, png.length);
  assert.equal(ihdr.readUInt32BE(0), mask.width);
  assert.equal(ihdr.readUInt32BE(4), mask.height);
  assert.equal(ihdr[8], 8);
  assert.equal(ihdr[9], 0, 'one-channel grayscale');
  assert.equal(ihdr[12], 0, 'non-interlaced');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, mask.height * (mask.width + 1));
  const pixels = [];
  for (let y = 0; y < mask.height; y += 1) {
    assert.equal(raw[y * (mask.width + 1)], 0, 'filter zero');
    pixels.push([...raw.subarray(y * (mask.width + 1) + 1, (y + 1) * (mask.width + 1))]);
  }
  return pixels;
}

const mask = (width, height, regions) => ({ version: 1, coordinateSpace: 'pixels', width, height, regions });

test('CRC matches the standard check value', () => {
  assert.equal(sdCliCrc32(Buffer.from('123456789')), 0xcbf43926);
});

test('one marked pixel is white and every unmarked source pixel is black', () => {
  assert.deepEqual(decodeMask(mask(4, 3, [{ x: 1, y: 1, width: 1, height: 1 }])), [
    [0, 0, 0, 0],
    [0, 255, 0, 0],
    [0, 0, 0, 0],
  ]);
});

test('multiple and overlapping rectangles form an exact binary union', () => {
  assert.deepEqual(decodeMask(mask(4, 3, [
    { x: 0, y: 0, width: 2, height: 2 },
    { x: 1, y: 1, width: 3, height: 2 },
  ])), [
    [255, 255, 0, 0],
    [255, 255, 255, 255],
    [0, 255, 255, 255],
  ]);
});

test('a full-frame mask is all white without changing dimensions', () => {
  const pixels = decodeMask(mask(2, 2, [{ x: 0, y: 0, width: 2, height: 2 }]));
  assert.deepEqual(pixels, [[255, 255], [255, 255]]);
});

test('mask PNG output is deterministic for canonical input', () => {
  const value = mask(3, 2, [{ x: 2, y: 1, width: 1, height: 1 }]);
  assert.ok(encodeSdCliMaskPng(value).equals(encodeSdCliMaskPng(value)));
});

test('sd-cli arguments use the verified init/mask/strength protocol and exact dimensions', () => {
  const args = sdCliInpaintArguments({
    modelPath: 'C:\\models\\inpaint model.ckpt',
    prompt: 'remove only the marked cone; preserve everything else',
    negativePrompt: 'text, watermark',
    initPath: '/tmp/frozen original.png',
    maskPath: '/tmp/mask.png',
    outputPath: '/tmp/result.png',
    width: 640,
    height: 384,
    seed: 1234,
    steps: 20,
    strength: 1,
    cfgScale: 7.5,
  });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('-m'), 'C:\\models\\inpaint model.ckpt');
  assert.equal(value('-i'), '/tmp/frozen original.png');
  assert.equal(value('--mask'), '/tmp/mask.png');
  assert.equal(value('-W'), '640');
  assert.equal(value('-H'), '384');
  assert.equal(value('-s'), '1234');
  assert.equal(value('--steps'), '20');
  assert.equal(value('--strength'), '1');
  assert.equal(value('--cfg-scale'), '7.5');
  assert.equal(value('-o'), '/tmp/result.png');
  assert.ok(args.includes('--vae-tiling'));
});

test('prompts and paths remain single argv entries, never shell source', () => {
  const args = sdCliInpaintArguments({
    modelPath: 'model', prompt: 'keep exact words; $(never execute)', negativePrompt: 'text',
    initPath: 'original;rm', maskPath: 'mask', outputPath: 'out', width: 1, height: 1,
    seed: 1, steps: 4, strength: 0.75, cfgScale: 7.5,
  });
  assert.equal(args[args.indexOf('-p') + 1], 'keep exact words; $(never execute)');
  assert.equal(args[args.indexOf('-i') + 1], 'original;rm');
});

test('required probe flags cover every argument the adapter sends', () => {
  for (const flag of ['-m', '-p', '-n', '-i', '--mask', '-W', '-H', '-s', '-o', '--steps', '--cfg-scale', '--strength', '--vae-tiling']) {
    assert.ok(SD_CLI_INPAINT_REQUIRED_FLAGS.includes(flag), flag);
  }
});

test('only the two recorded upstream inpainting artifacts are pinned for production', () => {
  assert.deepEqual(SD_CLI_INPAINT_MODELS.map((model) => model.sha256), [
    'c6bbc15e3224e6973459ba78de4998b80b50112b0ae5b5c67113d56b4e366b19',
    '3a754af8bc8f427ad3c5eabe134ecd6edf02eb7d1ff9d71a5294ba7f19f0bb90',
  ]);
  assert.ok(SD_CLI_INPAINT_MODELS.every((model) => model.sizeBytes > 4_000_000_000));
});
