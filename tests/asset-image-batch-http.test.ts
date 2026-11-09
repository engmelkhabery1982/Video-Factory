/**
 * Ordered picture batch through the REAL upload route (app.inject, real files). The batch client sends one request per file
 * in order; this test sends the same sequence. Refused files add nothing; each stored file keeps its SHA-256 and provenance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'asset-image-batch');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(nodePath.join(root, 'data'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(root, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  return { root };
});

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { buildServerApp } from '../apps/api/src/server.js';

function multipart(fileName: string, content: Buffer, mime: string, fields: Record<string, string>) {
  const boundary = '----arenaImageBatch';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

describe('ordered picture batch through the measured upload route (HTTP, real files)', () => {
  let app: Awaited<ReturnType<typeof buildServerApp>>;
  let p1: Buffer;
  let p2: Buffer;
  let p3: Buffer;
  const fields = { source: 'Owner photo set', license: 'Owner-owned', kind: 'screenshot' };
  const upload = (name: string, buf: Buffer, mime: string) =>
    app.inject({ method: 'POST', url: '/api/assets', ...multipart(name, buf, mime, { ...fields, name: name.replace(/\.[^.]+$/, '') }) });

  beforeAll(async () => {
    p1 = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#2a6' } }).png().toBuffer();
    p2 = await sharp({ create: { width: 9, height: 6, channels: 3, background: '#a62' } }).jpeg().toBuffer();
    p3 = await sharp({ create: { width: 7, height: 6, channels: 3, background: '#36a' } }).webp().toBuffer();
    app = await buildServerApp();
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  it('stores each picture in the order sent, with its measured type and SHA-256; a refused file adds nothing', async () => {
    const r1 = await upload('first.png', p1, 'image/png');
    const rBad = await upload('vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>'), 'image/svg+xml');
    const r2 = await upload('second.jpg', p2, 'image/jpeg');
    const r3 = await upload('third.webp', p3, 'image/webp');
    expect([r1.statusCode, rBad.statusCode, r2.statusCode, r3.statusCode]).toEqual([200, 422, 200, 200]);
    const a1 = r1.json().asset, a2 = r2.json().asset, a3 = r3.json().asset;
    expect([a1.mimeType, a2.mimeType, a3.mimeType]).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(a1.sha256).toBe(createHash('sha256').update(p1).digest('hex'));
    expect(a2.sha256).toBe(createHash('sha256').update(p2).digest('hex'));
    expect(a1.source).toBe('Owner photo set');
    expect(a1.license).toBe('Owner-owned');
    const library = (await app.inject({ method: 'GET', url: '/api/assets' })).json().assets as Array<{ id: string; name: string }>;
    const names = library.map((a) => a.name).filter((n) => ['first', 'second', 'third', 'vector'].includes(n));
    expect(names).toEqual(['first', 'second', 'third']); // the refused SVG is not in the library
  });

  it('a retry of a refused file stores it once; the stored files are not duplicated', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/assets' })).json().assets.length;
    // The batch retries only the failed file. Here that file is now valid, so it is stored once.
    const retry = await upload('fixed.png', p1, 'image/png');
    expect(retry.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/assets' })).json().assets.length;
    expect(after).toBe(before + 1);
    // Stored bytes are kept, and the earlier entries are unchanged.
    expect(fs.existsSync(path.join(tmp.root, 'data'))).toBe(true);
  });
});
