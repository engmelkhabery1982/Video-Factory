/**
 * Canonical production-journey harness (no dependencies).
 *
 * Drives the REAL factory service — the same `factory-service.ts` the HTTP
 * routes call — through input -> draft -> treatment -> scene completion ->
 * Apply -> edit -> reopen. It creates isolated disposable storage and owned
 * synthetic materials, and never touches owner data or `data/`/`output/`.
 *
 * It is a harness, not a test double: no fixture answers are injected, no
 * service function is replaced. Failures are reported as failures.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Create an isolated disposable data/output root and point the platform at it. */
export function isolatedStorage(prefix = 'vf-journey') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const data = path.join(base, 'data');
  const output = path.join(base, 'output');
  const scratch = path.join(base, 'scratch');
  for (const d of [data, output, scratch]) fs.mkdirSync(d, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  return {
    base,
    data,
    output,
    scratch,
    assertIsolated() {
      const repoData = path.join(REPO_ROOT, 'data');
      const repoOutput = path.join(REPO_ROOT, 'output');
      for (const p of [data, output]) {
        if (path.resolve(p) === path.resolve(repoData) || path.resolve(p) === path.resolve(repoOutput)) {
          throw new Error(`refusing to run against the repository data/output tree: ${p}`);
        }
        if (!path.resolve(p).startsWith(os.tmpdir())) {
          throw new Error(`refusing to run outside the system temp dir: ${p}`);
        }
      }
    },
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * A tiny owned synthetic PNG built by hand (no image library): a solid colour
 * square. Deterministic, so a byte hash can be asserted later.
 */
export function syntheticPng({ width = 64, height = 64, rgb = [30, 90, 160] } = {}) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = rgb[0];
      raw[row + 2 + x * 3] = rgb[1];
      raw[row + 3 + x * 3] = rgb[2];
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Register a file in the asset library exactly as the upload route would. */
export function registerAsset(assetsDir, { bytes, filename, mimeType = 'image/png', kind = 'image' }) {
  fs.mkdirSync(assetsDir, { recursive: true });
  const id = `ast_${crypto.randomBytes(6).toString('hex')}`;
  const ext = path.extname(filename) || '.bin';
  const file = path.join(assetsDir, `${id}${ext}`);
  fs.writeFileSync(file, bytes);
  const indexFile = path.join(assetsDir, 'index.json');
  // The real library index is a bare array of Asset rows (see routes/assets.ts).
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : [];
  const record = {
    id,
    filename,
    mimeType,
    kind,
    size: bytes.length,
    sha256: sha256(bytes),
    createdAt: new Date().toISOString(),
    path: file,
  };
  if (!Array.isArray(index)) throw new Error('asset index is not an array');
  index.push(record);
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  return record;
}

/** Small helper: run a step, and record pass/fail without throwing the run away. */
export function makeLog() {
  const rows = [];
  const step = async (label, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      if (typeof detail === 'string' && detail.startsWith('skipped:')) {
        rows.push({label, ok:null, skipped:true, detail, ms:Date.now()-started});
        console.log(`SKIP  ${label} :: ${detail}`);
        return {ok:null, skipped:true, detail};
      }
      rows.push({ label, ok: true, detail, ms: Date.now() - started });
      console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ''}`);
      return { ok: true, detail };
    } catch (err) {
      rows.push({ label, ok: false, detail: err?.message ?? String(err), ms: Date.now() - started });
      console.log(`FAIL  ${label} :: ${err?.message ?? err}`);
      return { ok: false, error: err };
    }
  };
  return { rows, step, summary: () => ({ pass: rows.filter((r) => r.ok === true).length, fail: rows.filter((r) => r.ok === false).length, skipped:rows.filter(r=>r.skipped).length }) };
}
