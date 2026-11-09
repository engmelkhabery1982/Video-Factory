/**
 * The listening-approval 415 was a real HTTP failure: the web client sent
 * `content-type` and `Content-Type`, fetch joined them, and Fastify rejected
 * the request before the route ran. This test uses that client and a listening
 * server. A fetch wrapper only turns the client's relative URL into the
 * server origin. It does not change headers or invent the response.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'approval-content-type');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(nodePath.join(root, 'data'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(root, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  return { root };
});

import { buildServerApp } from '../apps/api/src/server.js';
import { api } from '../apps/web/src/lib/api.js';
import { referenceWavBuffer } from './helpers/chatterbox-worker-fixtures.js';

const SCRIPT = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ.';

function multipart(content: Buffer) {
  const boundary = '----approvaltype';
  const fields = {
    scriptText: SCRIPT,
    sourceKind: 'authorized_external_synthesis',
    ownershipConfirmed: 'true',
    ownershipStatement: 'Fixture declaration. Not a human listening approval or a rights clearance.',
    speakerName: 'synthetic fixture speaker',
    engineName: 'fixture-engine',
    modelName: 'not-a-cloned-voice',
    voiceName: 'synthetic',
  };
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic-narration.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

describe('listening approval reaches the server with one JSON content type', () => {
  let app: Awaited<ReturnType<typeof buildServerApp>>;
  let origin = '';
  let nativeFetch: typeof fetch;

  beforeAll(async () => {
    app = await buildServerApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('The approval server did not bind a port.');
    origin = `http://127.0.0.1:${address.port}`;
    nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return nativeFetch(url.startsWith('/') ? `${origin}${url}` : url, init);
    }) as typeof fetch;

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        videoId: 'Approval_Type',
        videoType: 'long',
        topic: 'رحمة',
        script: SCRIPT,
        narrationSource: 'external_ready',
        outputLanguage: 'ar',
        shortCount: 0,
        keyPoints: [],
        keyNumbers: [],
        productShots: [],
        brollFiles: [],
        sourceReferences: [],
      },
    });
    expect(created.statusCode).toBe(200);
    const imported = await app.inject({
      method: 'POST',
      url: '/api/projects/Approval_Type/target-audio/long/external',
      ...multipart(referenceWavBuffer('Approval_Type', 4)),
    });
    expect(imported.statusCode, imported.body).toBe(201);
  });

  afterAll(async () => {
    globalThis.fetch = nativeFetch;
    await app.close();
    fs.rmSync(tmp.root, { recursive: true, force: true });
  });

  it('still rejects the duplicated content type that Fastify returned as 415', async () => {
    const response = await nativeFetch(`${origin}/api/projects/Approval_Type/target-audio/long/external/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json, application/json' },
      body: JSON.stringify({ decision: 'approved', listened: true, decidedBy: 'fixture-not-a-human' }),
    });
    expect(response.status).toBe(415);
  });

  it('records listening approval when the web client posts to the listening server', async () => {
    const result = await api.externalNarrationApproval('Approval_Type', 'long', {
      decision: 'approved',
      listened: true,
      decidedBy: 'fixture-not-a-human',
    });
    expect(result.approval.decision).toBe('approved');
    expect(result.approval.listened).toBe(true);
    const stored = await nativeFetch(`${origin}/api/projects/Approval_Type/external-narration`);
    expect(stored.status).toBe(200);
    const body = await stored.json() as { targets: Array<{ approval?: { decision?: string } }> };
    expect(body.targets[0]?.approval?.decision).toBe('approved');
  });
});
