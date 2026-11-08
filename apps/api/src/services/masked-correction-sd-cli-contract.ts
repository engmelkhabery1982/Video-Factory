/**
 * Dependency-free protocol for the existing pinned stable-diffusion.cpp sd-cli.
 *
 * Verified against upstream commit 1d0a58a35050d285b1d6fb1bc68a92924d35825e:
 * examples/common/common.cpp declares --init-img, --mask and --strength;
 * examples/cli/main.cpp loads a one-channel mask and preserves explicit W/H;
 * src/pipeline/image.cpp rounds the mask and uses 1 as the masked/inpaint region.
 * This module only builds inputs/arguments. It never claims an engine ran.
 */
import zlib from 'node:zlib';
import type { CanonicalMask } from './masked-correction-contract.js';

export const SD_CLI_INPAINT_RELEASE = 'master-964-1d0a58a' as const;
export const SD_CLI_INPAINT_COMMIT = '1d0a58a35050d285b1d6fb1bc68a92924d35825e' as const;
export const SD_CLI_INPAINT_PROJECT = 'leejet/stable-diffusion.cpp' as const;
export const SD_CLI_INPAINT_MODEL_LICENSE = 'CreativeML Open RAIL-M (use restrictions apply; owner review required)' as const;

/** Exact upstream artifacts already recorded in the engine decision sheet. */
export const SD_CLI_INPAINT_MODELS = Object.freeze([
  Object.freeze({
    file: 'sd-v1-5-inpainting.ckpt',
    sha256: 'c6bbc15e3224e6973459ba78de4998b80b50112b0ae5b5c67113d56b4e366b19',
    sizeBytes: 4_265_437_280,
  }),
  Object.freeze({
    file: 'sd-v1-5-inpainting.safetensors',
    sha256: '3a754af8bc8f427ad3c5eabe134ecd6edf02eb7d1ff9d71a5294ba7f19f0bb90',
    sizeBytes: 4_265_203_900,
  }),
]);

export const SD_CLI_INPAINT_REQUIRED_FLAGS = Object.freeze([
  '-m', '-p', '-n', '-i', '--mask', '-W', '-H', '-s', '-o',
  '--steps', '--cfg-scale', '--strength', '--vae-tiling',
] as const);

export const SD_CLI_INPAINT_DEFAULT_NEGATIVE_PROMPT =
  'text, watermark, logo, caption, signature, blurry, low quality, deformed';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function sdCliCrc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(sdCliCrc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

/**
 * Encode a complete, non-interlaced 8-bit grayscale PNG. Black preserves the
 * source; the union of canonical rectangles is white (the inpaint region).
 * Filter zero on every row keeps the exact pixels directly inspectable.
 */
export function encodeSdCliMaskPng(mask: CanonicalMask): Buffer {
  const { width, height } = mask;
  const pixels = new Uint8Array(width * height); // zero = preserved source
  for (const region of mask.regions) {
    for (let y = region.y; y < region.y + region.height; y += 1) {
      const start = y * width + region.x;
      pixels.fill(255, start, start + region.width); // one = region to inpaint
    }
  }
  const scanlines = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width + 1);
    scanlines[row] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width, width).copy(scanlines, row + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale, one channel as required by the pinned CLI loader
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface SdCliInpaintInvocation {
  modelPath: string;
  prompt: string;
  negativePrompt: string;
  initPath: string;
  maskPath: string;
  outputPath: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  strength: number;
  cfgScale: number;
}

/** Exact argument pairs; paths are separate argv entries, never shell-interpolated. */
export function sdCliInpaintArguments(input: SdCliInpaintInvocation): string[] {
  return [
    '-m', input.modelPath,
    '-p', input.prompt,
    '-n', input.negativePrompt,
    '-i', input.initPath,
    '--mask', input.maskPath,
    '-W', String(input.width),
    '-H', String(input.height),
    '-s', String(input.seed),
    '--steps', String(input.steps),
    '--cfg-scale', String(input.cfgScale),
    '--strength', String(input.strength),
    '--vae-tiling',
    '-o', input.outputPath,
  ];
}
