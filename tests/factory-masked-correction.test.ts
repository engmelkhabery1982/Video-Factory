/**
 * G7 REAL-ROUTE / REAL-STORE tests with a LABELLED MOCK RUNNER.
 * app.inject exercises the actual draft lock, asset index/bytes and job persistence.
 * No inpainting engine, visual-quality claim, provider or real generated output is involved.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'masked-correction-closeout04-'));
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  process.env.VF_PREVIEW_DISABLE = '1';
  return { root };
});

import { buildServerApp } from '../apps/api/src/server.js';
import {
  createMockRunner,
  maskedCorrectionResultSource,
  maskedCorrectionTestHooks,
  recoverMaskedCorrectionJobs,
  resetMaskedCorrectionForTests,
  setMaskedCorrectionRunner,
  type MaskedCorrectionJob,
} from '../apps/api/src/services/masked-correction.js';

let app: Awaited<ReturnType<typeof buildServerApp>>;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function call(method: Method, url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
  let json: any = null;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.statusCode, json };
}

function multipart(fileName: string, content: Buffer, fields: Record<string, string>) {
  const boundary = '----arenaMaskedCloseout04';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
  parts.push(content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

/** Small valid owned RGBA PNG; no image engine or external asset. */
function makePng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) Buffer.from(rgba).copy(row, 1 + x * 4);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Uploaded { id: string; sha256: string; width: number; height: number }
async function upload(name: string, bytes: Buffer): Promise<Uploaded> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/assets',
    ...multipart(name, bytes, {
      name: name.replace(/\.png$/, ''),
      kind: 'screenshot',
      source: 'Owned synthetic G7 route fixture',
      license: 'Test fixture owned by this test; no external rights',
    }),
  });
  expect(res.statusCode, res.body).toBe(200);
  const json = JSON.parse(res.body);
  expect(json.asset.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  expect(json.asset.width).toBeGreaterThan(0);
  expect(json.asset.height).toBeGreaterThan(0);
  return { id: json.asset.id, sha256: json.asset.sha256, width: json.asset.width, height: json.asset.height };
}

interface Fixture {
  draftId: string;
  sceneId: string;
  revision: number;
  original: Uploaded;
  result: Uploaded;
  newer: Uploaded;
  envelope: any;
}

async function setup(options: { twoScenes?: boolean } = {}): Promise<Fixture> {
  const [original, result, newer] = await Promise.all([
    upload('original.png', makePng(4, 3, [255, 0, 0, 255])),
    upload('corrected.png', makePng(4, 3, [0, 255, 0, 255])),
    upload('newer.png', makePng(4, 3, [0, 0, 255, 255])),
  ]);
  const storyboard = options.twoScenes ? {
    version: 1,
    scenes: [
      { id: 'panel-a', narration: 'First supplied panel.', speakerId: null, assetId: null, startSec: null, endSec: null, locked: false },
      { id: 'panel-b', narration: 'Second supplied panel.', speakerId: null, assetId: null, startSec: null, endSec: null, locked: false },
    ],
  } : null;
  const created = await call('POST', '/api/factory/drafts', {
    contentProfile: 'educational',
    format: 'landscape',
    channelBrandId: null,
    requestedSpeakers: [],
    referenceProjectId: null,
    visualLanguage: null,
    inputs: {
      brief: '',
      script: options.twoScenes ? null : 'The delivery window opens at dawn. Confirm the route.',
      audioAssetId: null,
      visualAssetIds: [],
      storyboard,
      narrationMode: 'none',
    },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const treatment = created.json.treatments.find((item: any) => item.id === created.json.selectedTreatmentId);
  expect(treatment.scenes.length).toBeGreaterThan(options.twoScenes ? 1 : 0);
  const sceneId = treatment.scenes[0].id;
  const bound = await call('POST', `/api/factory/drafts/${created.json.draftId}/bind-image`, {
    expectedRevision: created.json.revision,
    sceneId,
    assetId: original.id,
  });
  expect(bound.status, JSON.stringify(bound.json)).toBe(200);
  expect(bound.json.revision).toBe(created.json.revision + 1);
  return { draftId: created.json.draftId, sceneId, revision: bound.json.revision, original, result, newer, envelope: bound.json };
}

function maskFor(asset: Uploaded, overrides: Record<string, unknown> = {}): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    coordinateSpace: 'pixels',
    width: asset.width,
    height: asset.height,
    regions: [{ x: 0, y: 0, width: 1, height: 1 }],
    ...overrides,
  }), 'utf8').toString('base64');
}

function bodyFor(fixture: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sceneId: fixture.sceneId,
    expectedRevision: fixture.revision,
    maskData: maskFor(fixture.original),
    originalAssetId: fixture.original.id,
    originalHash: fixture.original.sha256,
    instructions: 'Correct only the marked pixel region',
    ...overrides,
  };
}

function createFixtureRunner(fixture: Fixture, options: { resultAssetId?: string; resultHash?: string; delayMs?: number; fail?: boolean } = {}): ReturnType<typeof createMockRunner> {
  const mock = createMockRunner(options);
  return {
    ...mock,
    async run(job, context) {
      const resultAssetId = options.resultAssetId ?? fixture.result.id;
      if (!options.fail) {
        // Model the runner's required canonical import step. Bytes were uploaded through the
        // real asset route; this isolated fixture attaches only the exact job/run provenance.
        const indexFile = path.join(process.env.BUILDTRAKE_DATA as string, 'assets', 'index.json');
        const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Array<Record<string, any>>;
        const asset = index.find((entry) => entry.id === resultAssetId);
        if (asset && resultAssetId !== fixture.original.id) {
          asset.source = maskedCorrectionResultSource(job);
          asset.tags = [...new Set([...(asset.tags ?? []), 'factory', 'masked-correction-result'])];
          fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
        }
      }
      return mock.run(job, context);
    },
  };
}

async function waitJob(jobId: string): Promise<MaskedCorrectionJob> {
  for (let i = 0; i < 600; i++) {
    const response = await call('GET', `/api/factory/masked-corrections/${jobId}`);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    if (!['pending', 'running'].includes(response.json.status)) return response.json;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('masked correction job did not finish');
}

async function createReviewed(fixture: Fixture, options: { resultHash?: string; body?: Record<string, unknown> } = {}) {
  setMaskedCorrectionRunner(createFixtureRunner(fixture, { resultAssetId: fixture.result.id, resultHash: options.resultHash ?? fixture.result.sha256 }));
  const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture, options.body));
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const done = await waitJob(created.json.id);
  expect(done.status, JSON.stringify(done)).toBe('completed');
  const reviewed = await call('POST', `/api/factory/masked-corrections/${created.json.id}/review`, { state: 'approved', notes: 'Fixture comparison reviewed' });
  expect(reviewed.status, JSON.stringify(reviewed.json)).toBe(200);
  expect(reviewed.json.status).toBe('reviewed');
  return { created: created.json as MaskedCorrectionJob, done, reviewed: reviewed.json as MaskedCorrectionJob };
}

function selectedScene(envelope: any, sceneId: string) {
  return envelope.treatments.find((item: any) => item.id === envelope.selectedTreatmentId).scenes.find((scene: any) => scene.id === sceneId);
}

beforeAll(async () => {
  app = await buildServerApp();
  await app.ready();
});

afterEach(() => {
  resetMaskedCorrectionForTests();
  maskedCorrectionTestHooks.afterDraftBindBeforeJobSave = null;
});

afterAll(async () => {
  resetMaskedCorrectionForTests();
  await app?.close();
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('G7 CLOSEOUT04 real-route safeguards (mock runner, real store)', () => {
  it('reports unconfigured readiness and refuses a valid job without persisting it', async () => {
    const fixture = await setup();
    setMaskedCorrectionRunner(null);
    const readiness = await call('GET', '/api/factory/masked-corrections/readiness');
    expect(readiness.status).toBe(200);
    expect(readiness.json.ready).toBe(false);
    const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture));
    expect(created.status).toBe(503);
    expect(created.json.code).toBe('FACTORY_RUNNER_NOT_SET');
    const jobs = await call('GET', `/api/factory/drafts/${fixture.draftId}/masked-corrections`);
    expect(jobs.status).toBe(200);
    expect(jobs.json).toEqual([]);
  });

  it('Case A: rejects an unknown scene 422 before accepting or running a job', async () => {
    const fixture = await setup();
    const run = vi.fn();
    setMaskedCorrectionRunner({ run });
    const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture, { sceneId: 'scene-does-not-exist' }));
    expect(created.status, JSON.stringify(created.json)).toBe(422);
    expect(created.json.code).toBe('FACTORY_VALIDATION');
    expect(run).not.toHaveBeenCalled();
    const jobs = await call('GET', `/api/factory/drafts/${fixture.draftId}/masked-corrections`);
    expect(jobs.json).toEqual([]);
  });

  it('Case B: rejects a false original fingerprint against actual library bytes', async () => {
    const fixture = await setup();
    const run = vi.fn();
    setMaskedCorrectionRunner({ run });
    const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture, { originalHash: '0'.repeat(64) }));
    expect(created.status, JSON.stringify(created.json)).toBe(409);
    expect(created.json.code).toBe('FACTORY_SOURCE_CHANGED');
    expect(run).not.toHaveBeenCalled();
  });

  it('Case C: Apply refuses a post-review index/result fingerprint mismatch and preserves the original', async () => {
    const fixture = await setup();
    const { created } = await createReviewed(fixture);
    const indexFile = path.join(process.env.BUILDTRAKE_DATA as string, 'assets', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Array<Record<string, any>>;
    const result = index.find((asset) => asset.id === fixture.result.id);
    if (!result) throw new Error('fixture result missing from index');
    result.sha256 = '0'.repeat(64);
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    const applied = await call('POST', `/api/factory/masked-corrections/${created.id}/apply`, { expectedRevision: fixture.revision });
    expect(applied.status, JSON.stringify(applied.json)).toBe(409);
    expect(applied.json.code).toBe('FACTORY_SOURCE_CHANGED');
    const current = await call('GET', `/api/factory/drafts/${fixture.draftId}`);
    expect(current.status).toBe(200);
    expect(current.json.revision).toBe(fixture.revision);
    expect(selectedScene(current.json, fixture.sceneId).assetId).toBe(fixture.original.id);
    const job = await call('GET', `/api/factory/masked-corrections/${created.id}`);
    expect(job.json.resultVerification).toBe('failed');
  });

  it('rejects a false runner-declared result hash before review', async () => {
    const fixture = await setup();
    setMaskedCorrectionRunner(createFixtureRunner(fixture, { resultAssetId: fixture.result.id, resultHash: '0'.repeat(64) }));
    const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture));
    expect(created.status).toBe(201);
    const done = await waitJob(created.json.id);
    expect(done.status).toBe('failed');
    expect(done.resultVerification).toBe('failed');
    const review = await call('POST', `/api/factory/masked-corrections/${created.json.id}/review`, { state: 'approved', notes: 'must not approve' });
    expect(review.status).toBe(422);
    const current = await call('GET', `/api/factory/drafts/${fixture.draftId}`);
    expect(selectedScene(current.json, fixture.sceneId).assetId).toBe(fixture.original.id);
  });

  it('rejects an otherwise valid but unrelated library result without exact job provenance', async () => {
    const fixture = await setup();
    setMaskedCorrectionRunner(createMockRunner({ resultAssetId: fixture.result.id, resultHash: fixture.result.sha256 }));
    const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture));
    expect(created.status).toBe(201);
    const done = await waitJob(created.json.id);
    expect(done.status).toBe('failed');
    expect(done.errorCode).toBe('FACTORY_ASSET_INVALID');
    expect(done.resultVerification).toBe('failed');
  });

  it('Case D: rejects a stale correction at the fresh revision and preserves the newer binding', async () => {
    const fixture = await setup();
    const { created } = await createReviewed(fixture);
    const newer = await call('POST', `/api/factory/drafts/${fixture.draftId}/bind-image`, {
      expectedRevision: fixture.revision,
      sceneId: fixture.sceneId,
      assetId: fixture.newer.id,
    });
    expect(newer.status, JSON.stringify(newer.json)).toBe(200);
    expect(newer.json.revision).toBe(fixture.revision + 1);
    const applied = await call('POST', `/api/factory/masked-corrections/${created.id}/apply`, { expectedRevision: newer.json.revision });
    expect(applied.status, JSON.stringify(applied.json)).toBe(409);
    expect(applied.json.code).toBe('FACTORY_CANDIDATE_STALE');
    const current = await call('GET', `/api/factory/drafts/${fixture.draftId}`);
    expect(current.json.revision).toBe(newer.json.revision);
    expect(selectedScene(current.json, fixture.sceneId).assetId).toBe(fixture.newer.id);
  });

  it('rejects a genuinely wrong create revision', async () => {
    const fixture = await setup();
    setMaskedCorrectionRunner(createFixtureRunner(fixture, { resultAssetId: fixture.result.id, resultHash: fixture.result.sha256 }));
    const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture, { expectedRevision: fixture.revision + 999 }));
    expect(created.status).toBe(409);
    expect(created.json.code).toBe('FACTORY_REVISION_CONFLICT');
  });

  it('rejects a genuinely wrong Apply revision', async () => {
    const fixture = await setup();
    const { created } = await createReviewed(fixture);
    const applied = await call('POST', `/api/factory/masked-corrections/${created.id}/apply`, { expectedRevision: fixture.revision + 999 });
    expect(applied.status).toBe(409);
    expect(applied.json.code).toBe('FACTORY_REVISION_CONFLICT');
  });

  it.each([
    ['arbitrary text', Buffer.from('mask').toString('base64')],
    ['empty regions', maskFor({ width: 4, height: 3 } as Uploaded, { regions: [] })],
    ['out-of-bounds region', maskFor({ width: 4, height: 3 } as Uploaded, { regions: [{ x: 3, y: 2, width: 2, height: 1 }] })],
    ['wrong dimensions', maskFor({ width: 4, height: 3 } as Uploaded, { width: 99 })],
  ])('rejects an invalid mask: %s', async (_label, maskData) => {
    const fixture = await setup();
    setMaskedCorrectionRunner(createFixtureRunner(fixture, { resultAssetId: fixture.result.id, resultHash: fixture.result.sha256 }));
    const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture, { maskData }));
    expect(created.status, JSON.stringify(created.json)).toBe(422);
    expect(created.json.code).toBe('FACTORY_VALIDATION');
  });

  it('applies a verified distinct result once, preserves the original and is idempotent', async () => {
    const fixture = await setup();
    const { created } = await createReviewed(fixture);
    const applied = await call('POST', `/api/factory/masked-corrections/${created.id}/apply`, { expectedRevision: fixture.revision });
    expect(applied.status, JSON.stringify(applied.json)).toBe(200);
    expect(applied.json.revision).toBe(fixture.revision + 1);
    expect(selectedScene(applied.json, fixture.sceneId).assetId).toBe(fixture.result.id);
    const repeated = await call('POST', `/api/factory/masked-corrections/${created.id}/apply`, { expectedRevision: fixture.revision });
    expect(repeated.status, JSON.stringify(repeated.json)).toBe(200);
    expect(repeated.json.revision).toBe(applied.json.revision);
    const originalBytes = await app.inject({ method: 'GET', url: `/media/asset/${fixture.original.id}` });
    expect(originalBytes.statusCode).toBe(200);
    expect(crypto.createHash('sha256').update(originalBytes.rawPayload).digest('hex')).toBe(fixture.original.sha256);
    const job = await call('GET', `/api/factory/masked-corrections/${created.id}`);
    expect(job.json.status).toBe('applied');
    expect(job.json.resultVerification).toBe('verified');
    expect(job.json.runner.fixture).toBe(true);
  });

  it('allows a precise rebase after an unrelated-scene edit but rechecks the target', async () => {
    const fixture = await setup({ twoScenes: true });
    const { created } = await createReviewed(fixture);
    const current = await call('GET', `/api/factory/drafts/${fixture.draftId}`);
    const treatment = current.json.treatments.find((item: any) => item.id === current.json.selectedTreatmentId);
    treatment.scenes[1].visualIntent = 'A different unrelated second panel composition';
    const patched = await call('PATCH', `/api/factory/drafts/${fixture.draftId}`, {
      expectedRevision: current.json.revision,
      selectedTreatmentId: current.json.selectedTreatmentId,
      scenes: treatment.scenes,
      speakers: current.json.speakers.map((speaker: any) => ({ id: speaker.id, voiceId: speaker.voiceId })),
    });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    const applied = await call('POST', `/api/factory/masked-corrections/${created.id}/apply`, { expectedRevision: patched.json.revision });
    expect(applied.status, JSON.stringify(applied.json)).toBe(200);
    expect(selectedScene(applied.json, fixture.sceneId).assetId).toBe(fixture.result.id);
  });

  it('cancels a running job and ignores its late completion', async () => {
    const fixture = await setup();
    setMaskedCorrectionRunner(createFixtureRunner(fixture, { resultAssetId: fixture.result.id, resultHash: fixture.result.sha256, delayMs: 100 }));
    const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture));
    expect(created.status).toBe(201);
    const cancelled = await call('POST', `/api/factory/masked-corrections/${created.json.id}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.json)).toBe(200);
    expect(cancelled.json.status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const job = await call('GET', `/api/factory/masked-corrections/${created.json.id}`);
    expect(job.json.status).toBe('cancelled');
    expect(job.json.resultAssetId).toBeNull();
  });

  it('retries a failed job within its attempt budget', async () => {
    const fixture = await setup();
    setMaskedCorrectionRunner(createMockRunner({ fail: true }));
    const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture));
    expect(created.status).toBe(201);
    expect((await waitJob(created.json.id)).status).toBe('failed');
    setMaskedCorrectionRunner(createFixtureRunner(fixture, { resultAssetId: fixture.result.id, resultHash: fixture.result.sha256 }));
    const retry = await call('POST', `/api/factory/masked-corrections/${created.json.id}/retry`);
    expect(retry.status, JSON.stringify(retry.json)).toBe(200);
    expect(retry.json.attempts).toBe(2);
    expect((await waitJob(created.json.id)).status).toBe('completed');
  });

  it('deduplicates the same idempotency key and refuses its reuse for different inputs', async () => {
    const fixture = await setup();
    setMaskedCorrectionRunner(createFixtureRunner(fixture, { resultAssetId: fixture.result.id, resultHash: fixture.result.sha256, delayMs: 20 }));
    const body = bodyFor(fixture, { idempotencyKey: 'route-fixture-key-0001' });
    const first = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, body);
    const second = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.json.id).toBe(first.json.id);
    const conflict = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture, { idempotencyKey: 'route-fixture-key-0001', instructions: 'Different input' }));
    expect(conflict.status).toBe(409);
    await waitJob(first.json.id);
    const jobs = await call('GET', `/api/factory/drafts/${fixture.draftId}/masked-corrections`);
    expect(jobs.json).toHaveLength(1);
  });

  it('recovers an active job as interrupted and permits an explicit retry', async () => {
    const fixture = await setup();
    setMaskedCorrectionRunner(createFixtureRunner(fixture, { resultAssetId: fixture.result.id, resultHash: fixture.result.sha256, delayMs: 500 }));
    const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture));
    expect(created.status).toBe(201);
    recoverMaskedCorrectionJobs(); // recovery-function evidence; not a claim that a process was killed
    const interrupted = await call('GET', `/api/factory/masked-corrections/${created.json.id}`);
    expect(interrupted.json.status).toBe('interrupted');
    resetMaskedCorrectionForTests();
    setMaskedCorrectionRunner(createFixtureRunner(fixture, { resultAssetId: fixture.result.id, resultHash: fixture.result.sha256 }));
    const retry = await call('POST', `/api/factory/masked-corrections/${created.json.id}/retry`);
    expect(retry.status, JSON.stringify(retry.json)).toBe(200);
    expect((await waitJob(created.json.id)).status).toBe('completed');
  });

  it('reconciles a post-bind job-save fault without double-apply', async () => {
    const fixture = await setup();
    const { created } = await createReviewed(fixture);
    maskedCorrectionTestHooks.afterDraftBindBeforeJobSave = () => { throw new Error('Injected post-bind job-save fault'); };
    const failed = await call('POST', `/api/factory/masked-corrections/${created.id}/apply`, { expectedRevision: fixture.revision });
    expect(failed.status).toBe(500);
    const bound = await call('GET', `/api/factory/drafts/${fixture.draftId}`);
    expect(bound.json.revision).toBe(fixture.revision + 1);
    expect(selectedScene(bound.json, fixture.sceneId).assetId).toBe(fixture.result.id);
    const applying = await call('GET', `/api/factory/masked-corrections/${created.id}`);
    expect(applying.json.status).toBe('applying');
    maskedCorrectionTestHooks.afterDraftBindBeforeJobSave = null;
    recoverMaskedCorrectionJobs();
    const recovered = await call('GET', `/api/factory/masked-corrections/${created.id}`);
    expect(recovered.json.status).toBe('applied');
    const repeated = await call('POST', `/api/factory/masked-corrections/${created.id}/apply`, { expectedRevision: fixture.revision });
    expect(repeated.status, JSON.stringify(repeated.json)).toBe(200);
    expect(repeated.json.revision).toBe(bound.json.revision);
  });

  it('cleans up terminal metadata without deleting source assets', async () => {
    const fixture = await setup();
    setMaskedCorrectionRunner(createMockRunner({ fail: true }));
    const created = await call('POST', `/api/factory/drafts/${fixture.draftId}/masked-corrections`, bodyFor(fixture));
    expect(created.status).toBe(201);
    expect((await waitJob(created.json.id)).status).toBe('failed');
    const deleted = await call('DELETE', `/api/factory/masked-corrections/${created.json.id}`);
    expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
    const missing = await call('GET', `/api/factory/masked-corrections/${created.json.id}`);
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe('FACTORY_MASKED_CORRECTION_NOT_FOUND');
    const assets = await call('GET', '/api/assets');
    expect(assets.json.assets.some((asset: any) => asset.id === fixture.original.id)).toBe(true);
  });

  it('verifies optional canonical binder provenance instead of ignoring it', async () => {
    const fixture = await setup();
    const rebound = await call('POST', `/api/factory/drafts/${fixture.draftId}/bind-image`, {
      expectedRevision: fixture.revision,
      sceneId: fixture.sceneId,
      assetId: fixture.result.id,
      sha256: fixture.result.sha256,
      source: 'Fabricated source that must not replace the asset record',
      license: 'Fabricated licence',
    });
    expect(rebound.status).toBe(422);
    const current = await call('GET', `/api/factory/drafts/${fixture.draftId}`);
    expect(current.json.revision).toBe(fixture.revision);
    expect(selectedScene(current.json, fixture.sceneId).assetId).toBe(fixture.original.id);
  });
});
