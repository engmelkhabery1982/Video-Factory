/**
 * The imported-narration player seeks with HTTP Range.
 *
 * These are real route responses, not a mocked stream. The fixture is a
 * generated tone, not a user recording. No render and no speech engine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'external-audio-range');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  return { root, data, output };
});

import { PROJECT_SCHEMA_VERSION, buildStoryboard, emptyHistory, type Project, type ProjectInput } from '@buildtrack/core';
import { buildServerApp } from '../apps/api/src/server.js';
import { saveProject } from '../apps/api/src/services/store.js';
import { referenceWavBuffer } from './helpers/chatterbox-worker-fixtures.js';

const VIDEO_ID = 'Range_Fixture';
const wav = referenceWavBuffer('range-fixture-not-a-user-recording', 2);

function multipart(content: Buffer) {
  const boundary = '----range' + Math.random().toString(36).slice(2);
  const fields: Record<string, string> = {
    scriptText: 'A fixture tone. Not a person.',
    sourceKind: 'authorized_external_synthesis',
    ownershipConfirmed: 'true',
    ownershipStatement: 'TEST/FIXTURE',
    speakerName: 'fixture speaker',
    engineName: 'fixture-engine',
    modelName: 'not-a-cloned-voice',
    voiceName: 'synthetic',
  };
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

describe('imported narration byte ranges', () => {
  let app: Awaited<ReturnType<typeof buildServerApp>>;
  let stored: Buffer;

  beforeAll(async () => {
    app = await buildServerApp();
    await app.ready();
    const input: ProjectInput = {
      videoId: VIDEO_ID,
      videoType: 'long',
      topic: 'range fixture',
      targetAudience: 'none',
      mainProblem: '',
      viewerPromise: '',
      hook: '',
      script: 'A fixture tone. Not a person.',
      keyNumbers: [],
      keyPoints: [],
      productName: '',
      productShots: [],
      cta: '',
      voiceoverFile: null,
      targetAudio: {},
      brollFiles: [],
      sourceReferences: [],
      outputLanguage: 'en',
      brandPreset: 'buildtrack',
      shortCount: 0,
      narrationSource: 'external_ready',
    };
    const built = buildStoryboard({ input, history: emptyHistory(), audioDuration: 2 });
    const { historyEntry: _ignored, ...storyboard } = built;
    const now = new Date().toISOString();
    const project: Project = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      meta: { input, brand: built.brand, createdAt: now, updatedAt: now, status: 'storyboarded' },
      storyboard,
      artifacts: [],
      qc: [],
    };
    saveProject(project);
    const imported = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/target-audio/long/external`,
      ...multipart(wav),
    });
    expect(imported.statusCode).toBe(201);
    const storedRef = imported.json().import.storedRef as string;
    stored = fs.readFileSync(path.join(tmp.data, storedRef));
    expect(stored.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  afterAll(async () => {
    await app.close();
  });

  async function getAudio(headers?: Record<string, string>) {
    return app.inject({
      method: 'GET',
      url: `/api/projects/${VIDEO_ID}/target-audio/long/external/audio`,
      headers,
    });
  }

  it('sends the whole file with a length and Accept-Ranges', async () => {
    const res = await getAudio();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('audio/wav');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Number(res.headers['content-length'])).toBe(stored.length);
    expect(Buffer.from(res.rawPayload)).toEqual(stored);
    expect(res.body).not.toContain(tmp.data);
  });

  it('sends only the requested closed, open, and suffix slices', async () => {
    const closed = await getAudio({ range: 'bytes=44-75' });
    expect(closed.statusCode).toBe(206);
    expect(closed.headers['content-range']).toBe(`bytes 44-75/${stored.length}`);
    expect(Number(closed.headers['content-length'])).toBe(32);
    expect(Buffer.from(closed.rawPayload)).toEqual(stored.subarray(44, 76));

    const open = await getAudio({ range: 'bytes=100-' });
    expect(open.statusCode).toBe(206);
    expect(open.headers['content-range']).toBe(`bytes 100-${stored.length - 1}/${stored.length}`);
    expect(Buffer.from(open.rawPayload)).toEqual(stored.subarray(100));
    expect(open.rawPayload.length).toBeLessThan(stored.length);

    const suffix = await getAudio({ range: 'bytes=-20' });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers['content-range']).toBe(`bytes ${stored.length - 20}-${stored.length - 1}/${stored.length}`);
    expect(Buffer.from(suffix.rawPayload)).toEqual(stored.subarray(stored.length - 20));
  });

  it('clamps an end past the file and refuses a range that cannot be served', async () => {
    const clamped = await getAudio({ range: `bytes=10-${stored.length + 50}` });
    expect(clamped.statusCode).toBe(206);
    expect(clamped.headers['content-range']).toBe(`bytes 10-${stored.length - 1}/${stored.length}`);
    expect(Buffer.from(clamped.rawPayload)).toEqual(stored.subarray(10));

    const past = await getAudio({ range: `bytes=${stored.length}-${stored.length + 5}` });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${stored.length}`);
    expect(past.json().code).toBe('RANGE_NOT_SATISFIABLE');
    expect(past.body).not.toContain('RIFF');
    expect(past.body).not.toContain(tmp.data);
    expect(past.body).not.toContain('/home/');

    const malformed = await getAudio({ range: 'bytes=nope' });
    expect(malformed.statusCode).toBe(416);
    expect(malformed.headers['content-range']).toBe(`bytes */${stored.length}`);

    const multipartRange = await getAudio({ range: 'bytes=0-1,2-3' });
    expect(multipartRange.statusCode).toBe(416);
    expect(multipartRange.rawPayload.length).toBeLessThan(stored.length);
  });

  it('does not turn an unknown range unit into a partial body', async () => {
    const res = await getAudio({ range: 'items=0-1' });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.rawPayload)).toEqual(stored);
  });

  it('serves the same range bytes over a real socket, not only inject', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('The range server did not bind a port.');
    const url = `http://127.0.0.1:${address.port}/api/projects/${VIDEO_ID}/target-audio/long/external/audio`;

    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-type')).toContain('audio/wav');
    expect(Number(full.headers.get('content-length'))).toBe(stored.length);
    expect(Buffer.from(await full.arrayBuffer())).toEqual(stored);

    const partial = await fetch(url, { headers: { range: 'bytes=44-75' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 44-75/${stored.length}`);
    expect(Number(partial.headers.get('content-length'))).toBe(32);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(stored.subarray(44, 76));

    const open = await fetch(url, { headers: { range: 'bytes=8-' } });
    expect(open.status).toBe(206);
    expect(Buffer.from(await open.arrayBuffer())).toEqual(stored.subarray(8));

    const past = await fetch(url, { headers: { range: `bytes=${stored.length}-` } });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${stored.length}`);
    const body = await past.text();
    expect(body).toContain('RANGE_NOT_SATISFIABLE');
    expect(body).not.toContain(tmp.data);
    expect(body).not.toContain('/home/');
  });

  it('still refuses a project that has no imported narration', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/Range_Other/target-audio/long/external/audio',
      headers: { range: 'bytes=0-10' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(tmp.data);
  });
});
