import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Asset, AssetKind } from '@buildtrack/core';
import { BUILTRACK_LOGO_SVG } from '@buildtrack/core';
import { ASSETS_DIR, ensureDirs } from '../services/platform.js';
import { analyseFile } from '../services/media.js';

const INDEX = path.join(ASSETS_DIR, 'index.json');

export function loadAssetIndex(): Asset[] {
  ensureDirs();
  if (!fs.existsSync(INDEX)) return [];
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8')) as Asset[];
  } catch {
    return [];
  }
}

export function saveAssetIndex(list: Asset[]) {
  ensureDirs();
  fs.writeFileSync(INDEX, JSON.stringify(list, null, 2), 'utf8');
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

  app.post('/api/assets', async (req, reply) => {
    const parts = (req as any).parts();
    let saved: Asset | null = null;
    for await (const part of parts) {
      if (part.type === 'file') {
        const name = sanitize(part.filename ?? 'upload.bin');
        const id = `${slug(path.basename(name, path.extname(name)))}-${randomUUID().slice(0, 8)}`;
        const dest = path.join(ASSETS_DIR, id + path.extname(name).toLowerCase());
        const buf = await part.toBuffer();
        fs.writeFileSync(dest, buf);
        const kind = (part.fields?.kind?.value as AssetKind) ?? guessKind(part.mimetype, name);
        let width: number | undefined;
        let height: number | undefined;
        let durationSec: number | undefined;
        if (String(part.mimetype).startsWith('image/')) {
          const probe = await imageSize(dest);
          width = probe?.w;
          height = probe?.h;
        } else if (String(part.mimetype).startsWith('video/') || String(part.mimetype).startsWith('audio/')) {
          try {
            const a = await analyseFile(dest);
            width = a.width;
            height = a.height;
            durationSec = a.duration;
          } catch {
            /* best effort */
          }
        }
        saved = {
          id,
          name: part.fields?.name?.value ?? name,
          kind,
          fileName: name,
          path: path.relative(path.join(ASSETS_DIR, '..'), dest).replace(/\\/g, '/'),
          mimeType: String(part.mimetype),
          sizeBytes: buf.length,
          width,
          height,
          durationSec,
          tags: String(part.fields?.tags?.value ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          status: 'active',
          preferred: false,
          source: String(part.fields?.source?.value ?? 'Operator upload'),
          license: String(part.fields?.license?.value ?? 'Operator owned'),
          addedAt: new Date().toISOString(),
          usedIn: [],
          blocked: false,
        };
      }
    }
    if (!saved) return reply.code(400).send({ error: 'No file received' });
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
