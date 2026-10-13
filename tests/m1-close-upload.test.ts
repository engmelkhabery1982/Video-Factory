/**
 * Gate 1: uploads are measured by the server. Real ffmpeg-made video and WAV
 * fixtures, a refused unreadable file, and a body larger than the old 64 MB limit.
 * Isolated data directory; never the owner's data.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'm1-close-upload');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(nodePath.join(root, 'data'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(root, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  return { root };
});

import { buildServerApp } from '../apps/api/src/server.js';

const FFMPEG = path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'linux-x64', 'ffmpeg');

function multipart(fileName: string, content: Buffer, mime: string, fields: Record<string, string> = {}) {
  const boundary = '----m1close' + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

function wav(seconds: number): Buffer {
  const rate = 8000;
  const n = Math.round(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe('library uploads are measured (Gate 1, HTTP, real files)', () => {
  let app: Awaited<ReturnType<typeof buildServerApp>>;
  const mp4 = path.join(tmp.root, 'vid.mp4');

  beforeAll(async () => {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', mp4]);
    app = await buildServerApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a WAV is added as audio with its measured duration; the library keeps the supplied source and licence', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/assets',
      ...multipart('tone.wav', wav(1.5), 'audio/wav', { name: 'tone', source: 'Owner recording', license: 'Owner-owned' }),
    });
    expect(res.statusCode).toBe(200);
    const asset = res.json().asset;
    expect(asset.mimeType).toBe('audio/wav');
    expect(asset.durationSec).toBeCloseTo(1.5, 2);
    expect(asset.source).toBe('Owner recording');
    expect(asset.license).toBe('Owner-owned');
  });

  it('a video is added with its measured duration and dimensions (video stays video)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/assets', ...multipart('vid.mp4', fs.readFileSync(mp4), 'video/mp4') });
    expect(res.statusCode).toBe(200);
    const asset = res.json().asset;
    expect(asset.mimeType).toBe('video/mp4');
    expect(asset.durationSec).toBeCloseTo(2, 1);
    expect(asset.width).toBe(320);
  });

  it('a file that cannot be read is refused with 422 and is NOT left in the library', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/assets', ...multipart('broken.wav', Buffer.from('not audio at all'), 'audio/wav') });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('UPLOAD_UNREADABLE');
    const list = (await app.inject({ method: 'GET', url: '/api/assets' })).json().assets as Array<{ fileName: string }>;
    expect(list.some((a) => a.fileName === 'broken.wav')).toBe(false);
  });

  it('a video declared as audio is refused (the measured type decides), not stored as audio', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/assets', ...multipart('clip-as-audio.wav', fs.readFileSync(mp4), 'audio/wav') });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('UPLOAD_TYPE_MISMATCH');
  });

  it('a body above the old 64 MB global limit is read, not cut off with a network error', async () => {
    const big = Buffer.alloc(70 * 1024 * 1024, 7);
    const res = await app.inject({ method: 'POST', url: '/api/assets', ...multipart('big.wav', big, 'audio/wav') });
    // The body is accepted and measured: 70 MB of non-audio bytes is refused with a reason, not a 413 transport error
    // and not stored as audio with a bogus duration.
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('UPLOAD_UNREADABLE');
    const list = (await app.inject({ method: 'GET', url: '/api/assets' })).json().assets as Array<{ fileName: string }>;
    expect(list.some((a) => a.fileName === 'big.wav')).toBe(false);
  }, 120000);
});
