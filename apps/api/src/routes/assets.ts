import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Asset, AssetKind } from '@buildtrack/core';
import { BUILTRACK_LOGO_SVG } from '@buildtrack/core';
import { ASSETS_DIR, ensureDirs } from '../services/platform.js';
import { measureUpload } from '../services/media.js';

const INDEX = path.join(ASSETS_DIR, 'index.json');


/** Measured image type from the first bytes. Null when the bytes are not a supported raster image. */
export function sniffImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'))) return 'image/gif';
  return null;
}

export function loadAssetIndex(): Asset[] {
  ensureDirs();
  if (!fs.existsSync(INDEX)) return [];
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8')) as Asset[];
  } catch {
    return [];
  }
}

/**
 * Strict read for write paths that must never silently replace an unreadable index.
 * A corrupt or non-array index is surfaced precisely instead of being overwritten with [].
 */
export function readWritableAssetIndex(): Asset[] {
  ensureDirs();
  if (!fs.existsSync(INDEX)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  } catch (err) {
    throw new Error(`The asset index is not readable JSON, so it was not overwritten: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('The asset index is not an array, so it was not overwritten.');
  return parsed as Asset[];
}

/**
 * Atomic index write: serialize fully, write a sibling temp file, then rename over the index.
 * A crash can leave the old file or the new one, never a half-written index.
 */
export function saveAssetIndex(list: Asset[]) {
  ensureDirs();
  const tmp = path.join(ASSETS_DIR, `index.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, INDEX);
}

const KINDS: AssetKind[] = ['logo', 'screenshot', 'chart', 'icon', 'broll', 'document', 'texture', 'sfx', 'font'];

/**
 * Seed the library with the built-in brand mark. It is drawn by this project
 * (see brand.ts), so its provenance is unambiguous and no unknown-licence
 * stock is ever downloaded.
 */
export function seedBrandAssets() {
  ensureDirs();
  const list = loadAssetIndex();
  if (list.some((a) => a.id === 'brand-logo-buildtrack')) return list;
  const file = path.join(ASSETS_DIR, 'brand-logo-buildtrack.svg');
  if (!fs.existsSync(file)) fs.writeFileSync(file, BUILTRACK_LOGO_SVG, 'utf8');
  list.push({
    id: 'brand-logo-buildtrack',
    name: 'BuildTrack wordmark',
    kind: 'logo',
    fileName: 'brand-logo-buildtrack.svg',
    path: 'assets/brand-logo-buildtrack.svg',
    mimeType: 'image/svg+xml',
    sizeBytes: fs.statSync(file).size,
    tags: ['brand', 'logo'],
    status: 'active',
    preferred: true,
    source: 'Generated in-project (packages/core/src/brand.ts)',
    license: 'Project-owned / MIT',
    addedAt: new Date().toISOString(),
    usedIn: [],
    blocked: false,
  });
  saveAssetIndex(list);
  return list;
}

export async function registerAssetRoutes(app: FastifyInstance) {
  seedBrandAssets();

  app.get('/api/assets', async () => ({ assets: loadAssetIndex() }));

  /**
   * Asset upload.
   *
   * Multipart FIELD ORDER MUST NOT MATTER. The previous implementation read
   * metadata from `part.fields` while handling the file part, which only ever
   * contains the fields that happened to arrive BEFORE the file — so uploads
   * with `file` first silently lost source/license/name/kind/tags.
   *
   * The route now collects every text field as it arrives, buffers the file,
   * and only builds + persists the Asset after the whole multipart message has
   * been processed, so the resulting metadata is identical regardless of order.
   */
  // The whole multipart body must fit, not only the file. The global 64 MB bodyLimit
  // cut larger footage off mid-upload, which the browser reports as "Failed to fetch".
  // The per-file cap stays 512 MB (multipart limits in server.ts).
  app.post('/api/assets', { bodyLimit: 520 * 1024 * 1024 }, async (req, reply) => {
    const parts = (req as any).parts();
    const fields = new Map<string, string>();
    let file: { name: string; mimeType: string; buffer: Buffer } | null = null;

    for await (const part of parts) {
      if (part.type === 'file') {
        const name = sanitize(part.filename ?? 'upload.bin');
        const buf = await part.toBuffer();
        file = { name, mimeType: String(part.mimetype ?? ''), buffer: buf };
      } else {
        // Collect fields regardless of where they appear in the stream.
        const key = String(part.fieldname ?? '');
        if (key) fields.set(key, String(part.value ?? ''));
      }
    }

    if (!file) return reply.code(400).send({ error: 'No file received' });
    // The MEASURED type decides an image. A declared image that is not PNG, JPEG, WebP or GIF is refused:
    // SVG and other markup are never stored as pictures (no executable content from uploads).
    const measuredImage = sniffImageMime(file.buffer);
    if (measuredImage) file.mimeType = measuredImage;
    else if (file.mimeType.toLowerCase().startsWith('image/')) {
      return reply.code(422).send({ error: 'The file is declared as an image but is not PNG, JPEG, WebP or GIF. Nothing was added to the library.' });
    }

    const field = (key: string): string | undefined => fields.get(key);
    const name = file.name;
    const id = `${slug(path.basename(name, path.extname(name)))}-${randomUUID().slice(0, 8)}`;
    const dest = path.join(ASSETS_DIR, id + path.extname(name).toLowerCase());
    fs.writeFileSync(dest, file.buffer);

    const kind = (field('kind') as AssetKind) ?? guessKind(file.mimeType, name);
    let width: number | undefined;
    let height: number | undefined;
    let durationSec: number | undefined;
    let hasAudio: boolean | undefined;
    let unreadable: string | null = null;
    let mismatch: string | null = null;
    if (file.mimeType.startsWith('image/')) {
      const probe = await imageSize(dest);
      width = probe?.w;
      height = probe?.h;
    } else if (file.mimeType.startsWith('video/') || file.mimeType.startsWith('audio/')) {
      // The MEASURED type decides what the file is. A declared type that disagrees is refused, not guessed.
      const declared = file.mimeType.startsWith('video/') ? 'video' : 'audio';
      try {
        const m = await measureUpload(dest);
        if (!m.kind || m.durationSec === null) throw new Error(m.reason ?? 'could not be measured');
        if (m.kind !== declared) {
          mismatch = `The file was declared as ${declared} but contains ${m.kind}. Upload it as ${m.kind}. Nothing was added to the library.`;
        } else {
          durationSec = m.durationSec;
          width = m.width;
          height = m.height;
          hasAudio = m.hasAudio;
        }
      } catch (err) {
        unreadable = `The ${declared} could not be read (${(err as Error).message.split('\n')[0]}). Nothing was added to the library.`;
      }
    }
    if (mismatch) {
      try {
        fs.unlinkSync(dest);
      } catch {
        /* already gone */
      }
      return reply.code(422).send({ error: mismatch, code: 'UPLOAD_TYPE_MISMATCH' });
    }
    if (unreadable) {
      // A file we cannot measure is refused, not stored as a library entry with an unknown duration.
      try {
        fs.unlinkSync(dest);
      } catch {
        /* already gone */
      }
      return reply.code(422).send({ error: unreadable, code: 'UPLOAD_UNREADABLE' });
    }

    const saved: Asset = {
      id,
      name: field('name') ?? name,
      kind,
      fileName: name,
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      path: path.relative(path.join(ASSETS_DIR, '..'), dest).replace(/\\/g, '/'),
      mimeType: file.mimeType,
      sizeBytes: file.buffer.length,
      width,
      height,
      durationSec,
      ...(hasAudio !== undefined ? { hasAudio } : {}),
      tags: String(field('tags') ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      status: 'active',
      preferred: false,
      source: String(field('source') ?? 'Operator upload'),
      license: String(field('license') ?? 'Operator owned'),
      addedAt: new Date().toISOString(),
      usedIn: [],
      blocked: false,
    };

    // Persist only after the ENTIRE multipart message has been processed.
    const list = loadAssetIndex();
    list.push(saved);
    saveAssetIndex(list);
    return { asset: saved, assets: list };
  });

  app.patch('/api/assets/:id', async (req) => {
    const { id } = req.params as { id: string };
    const list = loadAssetIndex();
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) return { error: 'not found' };
    const body = req.body as Partial<Asset>;
    list[i] = { ...list[i], ...body, id: list[i].id };
    saveAssetIndex(list);
    return { asset: list[i], assets: list };
  });

  app.delete('/api/assets/:id', async (req) => {
    const { id } = req.params as { id: string };
    const list = loadAssetIndex();
    const a = list.find((x) => x.id === id);
    if (a) {
      try {
        fs.rmSync(path.join(ASSETS_DIR, '..', a.path));
      } catch {
        /* ignore */
      }
    }
    saveAssetIndex(list.filter((x) => x.id !== id));
    return { assets: list.filter((x) => x.id !== id) };
  });
}

function sanitize(n: string) {
  return n.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}
function slug(n: string) {
  return n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'asset';
}
function guessKind(mime: string, name: string): AssetKind {
  if (/logo|brand/i.test(name)) return 'logo';
  if (mime.startsWith('video/')) return 'broll';
  if (mime.startsWith('audio/')) return 'sfx';
  if (/doc|invoice|boq|wir|pdf/i.test(name)) return 'document';
  if (/chart|graph/i.test(name)) return 'chart';
  if (/icon/i.test(name)) return 'icon';
  if (/texture|bg|background/i.test(name)) return 'texture';
  return 'screenshot';
}

/** minimal PNG/JPEG dimension probe - avoids pulling in an image library */
async function imageSize(file: string): Promise<{ w: number; h: number } | null> {
  const buf = fs.readFileSync(file);
  if (buf.length > 24 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}
