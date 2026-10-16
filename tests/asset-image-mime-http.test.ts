/**
 * Image uploads: the measured bytes decide the stored image type. A declared image that is not a supported raster
 * is refused before anything is written to the library. Real files only (sharp encodes a real PNG and JPEG).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'asset-image-mime');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(nodePath.join(root, 'data'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(root, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  return { root };
});

import sharp from 'sharp';
import { buildServerApp } from '../apps/api/src/server.js';
import { sniffImageMime } from '../apps/api/src/routes/assets.js';

function multipart(fileName: string, content: Buffer, mime: string, fields: Record<string, string> = {}) {
  const boundary = '----arenaImageMime';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

describe('image uploads use the measured type (HTTP, real files)', () => {
  let app: Awaited<ReturnType<typeof buildServerApp>>;
  let png: Buffer;
  let jpeg: Buffer;
  const fields = { name: 'panel', source: 'Owner photo', license: 'Owner-owned', kind: 'storyboard_panel' };

  beforeAll(async () => {
    png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#2a6' } }).png().toBuffer();
    jpeg = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#a62' } }).jpeg().toBuffer();
    app = await buildServerApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sniffs PNG, JPEG, WebP and GIF by their first bytes, and nothing else', () => {
    expect(sniffImageMime(png)).toBe('image/png');
    expect(sniffImageMime(jpeg)).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('GIF89a........'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
  });

  it('a PNG declared as JPEG is stored as image/png, the measured type', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/assets', ...multipart('panel.jpg', png, 'image/jpeg', fields) });
    expect(res.statusCode).toBe(200);
    expect(res.json().asset.mimeType).toBe('image/png');
    expect(res.json().asset.kind).toBe('storyboard_panel');
  });

  it('a JPEG declared as JPEG keeps image/jpeg', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/assets', ...multipart('panel2.jpg', jpeg, 'image/jpeg', fields) });
    expect(res.statusCode).toBe(200);
    expect(res.json().asset.mimeType).toBe('image/jpeg');
  });

  it('SVG markup declared as an image is refused and nothing is added to the library', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/assets' })).json().assets.length;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await app.inject({ method: 'POST', url: '/api/assets', ...multipart('x.svg', svg, 'image/svg+xml', fields) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/not PNG, JPEG, WebP or GIF/);
    expect((await app.inject({ method: 'GET', url: '/api/assets' })).json().assets.length).toBe(before);
  });

  it('text declared as a PNG is refused the same way', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/assets' })).json().assets.length;
    const res = await app.inject({ method: 'POST', url: '/api/assets', ...multipart('fake.png', Buffer.from('not a picture'), 'image/png', fields) });
    expect(res.statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/api/assets' })).json().assets.length).toBe(before);
    expect(fs.existsSync(path.join(tmp.root, 'data'))).toBe(true);
  });
});
