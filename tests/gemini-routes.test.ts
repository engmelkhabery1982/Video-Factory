/**
 * Milestone 3 routes through the REAL registered server (buildServerApp), with no key set.
 * Checks: status is network-free, the key never appears in a response, and gates return
 * the documented codes before any provider call. globalThis.fetch is a labelled spy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const os = process.getBuiltinModule('node:os') as typeof import('node:os');
  const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'gemini-routes-'));
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  process.env.VF_PREVIEW_DISABLE = '1';
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_GENERATION_ENABLED;
  delete process.env.GEMINI_FREE_TIER_CONFIRMED;
  return { root };
});

import { buildServerApp } from '../apps/api/src/server.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  fetchSpy = vi.fn(async () => {
    throw new Error('TEST DOUBLE: a provider call was attempted, which must not happen here');
  });
  vi.stubGlobal('fetch', fetchSpy);
  app = await buildServerApp();
});
afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('Milestone 3 provider routes (no key configured)', () => {
  it('status reports credentials_missing, makes no network call, and exposes no key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/factory/ai/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.state).toBe('credentials_missing');
    expect(body.credentialsPresent).toBe(false);
    expect(res.body).not.toMatch(/AIza|GEMINI_API_KEY=/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('plan request returns 412 and makes no provider call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/factory/ai/plans',
      payload: { profile: 'educational', format: 'landscape', brief: 'A brief that is long enough.' },
    });
    expect(res.statusCode).toBe(412);
    expect((res.json() as any).code).toBe('FACTORY_PROVIDER_CREDENTIALS_MISSING');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('speech preview request returns 412 and makes no provider call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/factory/ai/speech-previews',
      payload: { text: 'Hello there.', voice: 'Kore', language: 'en' },
    });
    expect(res.statusCode).toBe(412);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('validation errors return 400 with stable codes, before any gate', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/factory/ai/plans', payload: { profile: 'other', format: 'landscape', brief: 'x' } });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as any).code).toBe('FACTORY_VALIDATION');
    const voice = await app.inject({ method: 'POST', url: '/api/factory/ai/speech-previews', payload: { text: 'Hi', voice: 'Nobody', language: 'en' } });
    expect(voice.statusCode).toBe(400);
  });

  it('unknown job ids return 404, and an invalid id cannot escape the job directory', async () => {
    const unknown = await app.inject({ method: 'GET', url: '/api/factory/ai/jobs/00000000-0000-4000-8000-000000000000' });
    expect(unknown.statusCode).toBe(404);
    const traversal = await app.inject({ method: 'GET', url: '/api/factory/ai/jobs/..%2F..%2Fsecret' });
    expect(traversal.statusCode).toBe(404);
    expect(traversal.body).not.toMatch(/ENOENT|\/home\//);
  });

  it('keeps the existing M2 capabilities route unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/factory/capabilities' });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(process.cwd(), 'apps/api/src/routes/factory.ts'))).toBe(true);
  });
});
