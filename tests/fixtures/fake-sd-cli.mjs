#!/usr/bin/env node
/**
 * LABELLED FIXTURE, not stable-diffusion.cpp. A stand-in for `sd-cli` used only by tests.
 * It writes a real PNG of the requested size so decode validation is exercised. It never generates
 * an image from a model and proves nothing about the owner's runtime or weights.
 *
 * Env controls (test only):
 *   FAKE_SD_MODE=ok|hang|corrupt|fail   (default ok)
 *   FAKE_SD_HELP_OMIT=--steps,-n        (drop flags from the -h text to test the probe)
 *   FAKE_SD_ARGV_OUT=<file>             (write the received argv as JSON, for the adapter test)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
// Test-only: record the argv this run received, so the adapter's argument pairs can be asserted.
if (process.env.FAKE_SD_ARGV_OUT) fs.writeFileSync(process.env.FAKE_SD_ARGV_OUT, JSON.stringify(args));
const mode = process.env.FAKE_SD_MODE || 'ok';
// The flags this adapter passes, as named in the pinned stable-diffusion.cpp source (examples/common/common.cpp @1d0a58a).
const flags = ['-m', '--model', '-p', '--prompt', '-n', '--negative-prompt', '-W', '--width', '-H', '--height', '-s', '--seed', '-o', '--output', '--steps', '--cfg-scale'];
const omit = new Set((process.env.FAKE_SD_HELP_OMIT || '').split(',').filter(Boolean));

if (args.includes('-h') || args.includes('--help')) {
  const lines = ['usage: sd-cli [options]', 'FIXTURE help text (not the real sd-cli)', ''];
  for (const f of flags) if (!omit.has(f)) lines.push(`  ${f} <value>    fixture option`);
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

const val = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const out = val('-o', null);
const w = Number(val('-W', '640'));
const h = Number(val('-H', '360'));
const seed = Number(val('-s', '1'));
const steps = Number(val('--steps', '20'));

if (!out) {
  process.stderr.write('error: missing -o\n');
  process.exit(2);
}

if (mode === 'fail') {
  process.stderr.write('fixture failure: simulated runtime error\n');
  process.exit(3);
}

if (mode === 'hang') {
  // Never finishes: the job must be cancelled or time out, and the runner is killed by the adapter.
  process.stderr.write(`  |>    | 0/${steps} - 0.0s/it\n`);
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
} else {
  for (let i = 1; i <= steps; i++) {
    process.stderr.write(`  |==>  | ${i}/${steps} - 0.01s/it\n`);
  }
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const stride = w * 3;
const raw = Buffer.alloc(h * (stride + 1));
for (let y = 0; y < h; y++) {
  raw[y * (stride + 1)] = 0;
  for (let x = 0; x < w; x++) {
    const o = y * (stride + 1) + 1 + x * 3;
    raw[o] = (x + seed) & 255;
    raw[o + 1] = (y * 2) & 255;
    raw[o + 2] = 128;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0);
ihdr.writeUInt32BE(h, 4);
ihdr[8] = 8;
ihdr[9] = 2; // RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;
let png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
if (mode === 'corrupt') png = Buffer.concat([png.subarray(0, 40), Buffer.from('GARBAGE-NOT-A-PNG')]);
fs.mkdirSync(require_dirname(out), { recursive: true });
fs.writeFileSync(out, png);
process.exit(0);

function require_dirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '.';
}
