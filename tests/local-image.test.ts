/**
 * Local still-image generation (owner's computer runner), through the REAL registered server.
 *
 * LABELLED TEST DOUBLES, all of them:
 *  - the runner is tests/fixtures/fake-sd-cli.mjs. It is NOT stable-diffusion.cpp and does not
 *    run a model. It writes a real PNG so decode validation is exercised.
 *  - the model file is a few test bytes, not SD 1.5 weights. Its SHA-256 pin is computed here.
 *  - the semantic planner (used only to create the draft) is a scripted loopback double.
 * Code and fixture evidence only. Not local generation on the owner's machine, not owner acceptance.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodeCrypto = process.getBuiltinModule('node:crypto') as typeof import('node:crypto');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'local-image-'));
  const runner = nodePath.resolve('tests/fixtures/fake-sd-cli.mjs');
  nodeFs.chmodSync(runner, 0o755);
  const modelPath = nodePath.join(root, 'FIXTURE-model.safetensors');
  nodeFs.writeFileSync(modelPath, 'FIXTURE-WEIGHTS-NOT-A-MODEL');
  const modelSha = nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(modelPath)).digest('hex');
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  process.env.VF_PREVIEW_DISABLE = '1';
  process.env.LOCAL_IMAGE_ENABLED = '1';
  process.env.LOCAL_IMAGE_RUNNER = runner;
  process.env.LOCAL_IMAGE_MODEL = modelPath;
  process.env.LOCAL_IMAGE_MODEL_SHA256 = modelSha;
  process.env.LOCAL_IMAGE_ROOT = nodePath.join(root, 'local-images');
  process.env.LOCAL_IMAGE_STEPS = '4';
  process.env.FAKE_SD_ARGV_OUT = nodePath.join(root, 'sd-argv.json');
  process.env.LOCAL_LLM_ENABLED = '1';
  process.env.LOCAL_LLM_URL = 'http://127.0.0.1:8080';
  process.env.LOCAL_LLM_MODEL = 'FIXTURE-local-planner';
  process.env.LOCAL_LLM_MODEL_LICENSE = 'FIXTURE (test double, not a model)';
  return { root, modelSha };
});

import { buildServerApp } from '../apps/api/src/server.js';
import { DATA_DIR, ASSETS_DIR } from '../apps/api/src/services/platform.js';
import { loadAssetIndex } from '../apps/api/src/routes/assets.js';
import { fixtureEducationalPlan, localChatResponse } from './gemini/helpers.js';
import {
  localImageConfig,
  localImageStatus,
  recoverLocalJobs,
  resetLocalImageWorkerForTests,
  validatePng,
  crc32,
} from '../apps/api/src/services/local-image.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

/** LABELLED TEST DOUBLE for the local planner only (draft creation). Google is never called. */
const planner = vi.hoisted(() => ({ calls: 0 }));
const fetchSpy = vi.fn(async (url: string) => {
  const u = String(url);
  const json = (payload: unknown, status = 200) => ({ ok: status < 400, status, json: async () => payload });
  if (u === 'http://127.0.0.1:8080/v1/chat/completions') {
    planner.calls += 1;
    return json(localChatResponse(fixtureEducationalPlan()));
  }
  throw new Error(`TEST DOUBLE: unexpected URL ${u}`);
});

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
  let json: any = null;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.statusCode, json, raw: res.body };
}

async function waitForJob(jobId: string, terminal = true): Promise<any> {
  for (let i = 0; i < 1500; i++) {
    const r = await call('GET', `/api/local-images/jobs/${jobId}`);
    if (r.json.state !== 'queued' && r.json.state !== 'running') return r.json;
    if (!terminal) return r.json;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('local job did not finish');
}

async function waitForPlan(jobId: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const r = await call('GET', `/api/factory/ai/jobs/${jobId}`);
    if (r.json.job.status !== 'running') return r.json.job;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('plan job did not finish');
}

async function waitForIdle(): Promise<void> {
  for (let i = 0; i < 1500; i++) {
    const s = await call('GET', '/api/local-images/status');
    if (!s.json.busy) return;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('worker stayed busy');
}

const ids = { draftId: '', imageSceneId: '', recordingSceneId: '', revision: 0, jobId: '', assetId: '' };

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);
  app = await buildServerApp();
  fs.mkdirSync(path.join(DATA_DIR, 'factory', 'ai'), { recursive: true });
  // Create a draft from a local plan (labelled planner double).
  const created = await call('POST', '/api/factory/ai/plans', {
    profile: 'educational', format: 'landscape', brief: 'Explain why deliveries must be confirmed the night before.',
  });
  expect(created.status).toBe(202);
  const job = await waitForPlan(created.json.job.id);
  expect(job.status).toBe('succeeded');
  const draft = await call('POST', `/api/factory/ai/plans/${job.id}/draft`, { format: 'landscape' });
  expect(draft.status).toBe(201);
  ids.draftId = draft.json.draftId;
  const list = await call('GET', `/api/factory/drafts/${ids.draftId}/shot-list`);
  const still = list.json.scenes.find((s: any) => s.assetNeed === 'image_needed');
  const rec = list.json.scenes.find((s: any) => s.assetNeed === 'screen_recording_needed');
  ids.imageSceneId = still.sceneId;
  ids.recordingSceneId = rec.sceneId;
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  resetLocalImageWorkerForTests();
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('PNG validation (decode check)', () => {
  // A minimal valid 1x1 RGB PNG, produced by the same encoder shape as the fixture.
  const good = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

  it('accepts a complete PNG of the requested size', () => {
    expect(() => validatePng(good, 1, 1)).not.toThrow();
  });

  it('rejects a wrong size, a bad CRC, a truncated file, and non-PNG bytes', () => {
    expect(() => validatePng(good, 2, 1)).toThrow(/expected 2x1/);
    const badCrc = Buffer.from(good);
    badCrc[badCrc.length - 8] ^= 0xff; // flips a byte inside IDAT's data or CRC
    expect(() => validatePng(badCrc, 1, 1)).toThrow(/not a valid PNG/);
    expect(() => validatePng(good.subarray(0, 30), 1, 1)).toThrow(/not a valid PNG/);
    expect(() => validatePng(Buffer.from('GIF89a-not-png-bytes-here-xxxxxxxxxxxxxxxxxxxxx'), 1, 1)).toThrow(/signature/);
  });

  it('crc32 matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('status and setup (no generation)', () => {
  it('reports ready with the fixture runner, a matching pin, and no Google use', async () => {
    resetLocalImageWorkerForTests();
    const s = await localImageStatus();
    expect(s.ready, JSON.stringify(s.missing)).toBe(true);
    expect(s.state).toBe('ready');
    expect(s.googleUsed).toBe(false);
    expect(s.paidSpend).toBe(false);
    expect(s.model.sha256Matches).toBe(true);
    expect(s.flagsMissing).toEqual([]);
    expect(s.flagsChecked).toEqual(expect.arrayContaining(['-m', '-p', '-o', '--steps']));
  });

  it('shows setup required, with the missing item named, when the model hash does not match', async () => {
    const prior = localImageConfig().modelSha256;
    localImageConfig().modelSha256 = '0'.repeat(64);
    try {
      const s = await localImageStatus();
      expect(s.ready).toBe(false);
      expect(s.state).toBe('setup_required');
      expect(s.missing.join(' ')).toMatch(/does not match LOCAL_IMAGE_MODEL_SHA256/);
    } finally {
      localImageConfig().modelSha256 = prior;
    }
  });

  it('lists a flag the installed build does not print, and refuses to run', async () => {
    resetLocalImageWorkerForTests();
    process.env.FAKE_SD_HELP_OMIT = '--steps';
    try {
      const s = await localImageStatus();
      expect(s.ready).toBe(false);
      expect(s.flagsMissing).toEqual(['--steps']);
      const r = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: 0 });
      expect(r.status).toBe(503);
      expect(r.json.code).toBe('LOCAL_IMAGE_SETUP_REQUIRED');
    } finally {
      delete process.env.FAKE_SD_HELP_OMIT;
      resetLocalImageWorkerForTests();
    }
  });

  it('a missing runtime file shows setup required and names the runner', async () => {
    const prior = localImageConfig().runnerPath;
    localImageConfig().runnerPath = path.join(tmp.root, 'not-installed', 'sd-cli.exe');
    try {
      const s = await localImageStatus();
      expect(s.ready).toBe(false);
      expect(s.missing.join(' ')).toMatch(/LOCAL_IMAGE_RUNNER file was not found/);
    } finally {
      localImageConfig().runnerPath = prior;
    }
  });

  it('Vulkan without a recorded successful probe is not ready', async () => {
    const prior = localImageConfig().backend;
    localImageConfig().backend = 'vulkan';
    try {
      const s = await localImageStatus();
      expect(s.ready).toBe(false);
      expect(s.missing.join(' ')).toMatch(/Vulkan/);
    } finally {
      localImageConfig().backend = prior;
    }
  });

  it('a disabled local route reports setup required and never starts a job', async () => {
    localImageConfig().enabled = false;
    try {
      const r = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: ids.revision });
      expect(r.status).toBe(503);
      expect(r.json.code).toBe('LOCAL_IMAGE_SETUP_REQUIRED');
    } finally {
      localImageConfig().enabled = true;
    }
  });
});

describe('still request and revision (factory shot)', () => {
  it('returns the shot prompt for an image shot with the current revision', async () => {
    const r = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
    expect(r.status).toBe(200);
    // Composed from the shot's labelled visual description, not from vague instruction prose.
    expect(r.json.prompt).toMatch(/notice board/);
    expect(r.json.prompt).toMatch(/16:9 frame/);
    expect(r.json.prompt).not.toMatch(/Create a still image/);
    // Per-shot exclusions from this shot's Exclude part. Text is always excluded for stills.
    expect(r.json.negativePrompt).toMatch(/people/);
    expect(r.json.negativePrompt).toMatch(/watermark/);
    expect(r.json.aspect).toBe('landscape');
    ids.revision = r.json.revision;
  });

  it('refuses a screen-recording shot: a prompt or a still is not a recording', async () => {
    const r = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.recordingSceneId}/still-request`);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('FACTORY_VALIDATION');
  });

  it('refuses a job whose expectedRevision is stale, with no runner call', async () => {
    const r = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: ids.revision + 5 });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('FACTORY_REVISION_CONFLICT');
    expect(r.json.currentRevision).toBe(ids.revision);
  });
});

describe('one local job: progress, preview, approve, bind (fixture runner)', () => {
  it('runs one job to a validated PNG with provenance, and no Google or paid call', async () => {
    resetLocalImageWorkerForTests();
    const started = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: ids.revision, seed: 1234 });
    expect(started.status).toBe(202);
    expect(started.json.state).toBe('queued');
    ids.jobId = started.json.id;
    const done = await waitForJob(ids.jobId);
    // The argument pairs the adapter sends to sd-cli, checked against the pinned source's flag meanings.
    const argv: string[] = JSON.parse(fs.readFileSync(process.env.FAKE_SD_ARGV_OUT as string, 'utf8'));
    const arg = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv.includes('--rng')).toBe(false);
    expect(arg('-m')).toBe(process.env.LOCAL_IMAGE_MODEL);
    expect(arg('-s')).toBe('1234');
    expect(arg('--steps')).toBe('4');
    expect(arg('-W')).toBe(String(done.width));
    expect(arg('-H')).toBe(String(done.height));
    expect(arg('--cfg-scale')).toBe('7.5');
    expect(arg('-p')).toBe(done.prompt);
    expect(arg('-n')).toMatch(/watermark/);
    // This shot excludes people. The per-shot negative reaches the runner, and is recorded.
    expect(arg('-n')).toMatch(/people/);
    expect(done.negativePrompt).toBe(arg('-n'));
    expect(arg('-o')).toMatch(/\.png$/);
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.progress).toBe(1);
    expect(done.width).toBe(640);
    expect(done.height).toBe(360);
    expect(done.seed).toBe(1234);
    expect(done.provenance.modelSha256).toBe(tmp.modelSha);
    expect(done.provenance.release).toBe('master-964-1d0a58a');
    expect(done.provenance.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(done.provenance.outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(done.provenance.backend).toBe('cpu');
    // The prompt is taken from the server-side shot, not from the client.
    expect(done.prompt).toMatch(/notice board/);
    expect(done.provenance.negativePromptSha256).toMatch(/^[a-f0-9]{64}$/);
    // The candidate PNG is served only after it decodes again.
    const img = await app.inject({ method: 'GET', url: `/api/local-images/jobs/${ids.jobId}/image` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(() => validatePng(img.rawPayload, 640, 360)).not.toThrow();
    // Not in the library until approved.
    expect(loadAssetIndex().some((a: any) => a.id === `loc_${done.provenance.outputSha256.slice(0, 16)}`)).toBe(false);
    expect(planner.calls).toBeGreaterThan(0);
  });

  it('after a completed job the worker is idle again', async () => {
    await waitForIdle();
    const s = await call('GET', '/api/local-images/status');
    expect(s.json.busy).toBe(false);
  });

  it('approves the preview once, registers it with provenance, and is idempotent', async () => {
    const first = await call('POST', `/api/local-images/jobs/${ids.jobId}/approve`);
    expect(first.status).toBe(200);
    expect(first.json.assetId).toMatch(/^loc_[a-f0-9]{16}$/);
    ids.assetId = first.json.assetId;
    const again = await call('POST', `/api/local-images/jobs/${ids.jobId}/approve`);
    expect(again.json.assetId).toBe(ids.assetId);
    const records = loadAssetIndex().filter((a: any) => a.id === ids.assetId);
    expect(records).toHaveLength(1);
    const rec: any = records[0];
    expect(rec.mimeType).toBe('image/png');
    expect(rec.source).toMatch(/Generated locally on the owner's computer/);
    expect(rec.source).toMatch(/Not a screen recording/);
    expect(rec.license).toMatch(/CreativeML Open RAIL-M/);
    expect(rec.provenance.seed).toBe(1234);
    expect(fs.existsSync(path.join(ASSETS_DIR, `${ids.assetId}.png`))).toBe(true);
  });

  it('binds the approved still to the image shot at the revision the reviewer read', async () => {
    const stale = await call('POST', `/api/factory/drafts/${ids.draftId}/bind-image`, { expectedRevision: ids.revision + 1, sceneId: ids.imageSceneId, assetId: ids.assetId });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('FACTORY_REVISION_CONFLICT');
    const ok = await call('POST', `/api/factory/drafts/${ids.draftId}/bind-image`, { expectedRevision: ids.revision, sceneId: ids.imageSceneId, assetId: ids.assetId });
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.json.revision).toBe(ids.revision + 1);
    const list = await call('GET', `/api/factory/drafts/${ids.draftId}/shot-list`);
    const row = list.json.scenes.find((s: any) => s.sceneId === ids.imageSceneId);
    expect(row.status).toBe('bound');
    expect(row.boundAssetId).toBe(ids.assetId);
    expect(row.mediaType).toBe('image');
    ids.revision = ok.json.revision;
  });

  it('refuses to bind a still to a screen-recording shot', async () => {
    const r = await call('POST', `/api/factory/drafts/${ids.draftId}/bind-image`, { expectedRevision: ids.revision, sceneId: ids.recordingSceneId, assetId: ids.assetId });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('FACTORY_VALIDATION');
  });

  it('a candidate that was never approved cannot be bound, and an unknown asset is refused', async () => {
    const r = await call('POST', `/api/factory/drafts/${ids.draftId}/bind-image`, { expectedRevision: ids.revision, sceneId: ids.imageSceneId, assetId: 'loc_0000000000000000' });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('FACTORY_ASSET_INVALID');
  });

  it('a replacement generates a new candidate with a new seed (single-shot regenerate)', async () => {
    const req = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
    const started = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: req.json.revision, seed: 99 });
    expect(started.status).toBe(202);
    const done = await waitForJob(started.json.id);
    expect(done.state).toBe('succeeded');
    expect(done.seed).toBe(99);
    expect(done.id).not.toBe(ids.jobId);
  });
});

describe('failure paths: cancel, timeout, corrupt output, runner failure, interrupted restart', () => {
  it('cancel kills the runner: the job is cancelled, nothing is saved, and the worker is free', async () => {
    resetLocalImageWorkerForTests();
    process.env.FAKE_SD_MODE = 'hang';
    try {
      const req = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
      const started = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: req.json.revision, seed: 7 });
      await new Promise((r) => setTimeout(r, 150));
      const busy = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: req.json.revision, seed: 8 });
      expect(busy.status).toBe(409);
      expect(busy.json.code).toBe('LOCAL_IMAGE_BUSY');
      const c = await call('POST', `/api/local-images/jobs/${started.json.id}/cancel`);
      expect(c.status).toBe(200);
      const done = await waitForJob(started.json.id);
      expect(done.state).toBe('cancelled');
      expect(done.approvedAssetId).toBeNull();
      await waitForIdle();
      const again = await call('POST', `/api/local-images/jobs/${started.json.id}/cancel`);
      expect(again.status).toBe(409);
      const img = await call('GET', `/api/local-images/jobs/${started.json.id}/image`);
      expect(img.status).toBe(409);
    } finally {
      process.env.FAKE_SD_MODE = 'ok';
    }
  });

  it('a runner that never finishes is timed out, with an actionable message', async () => {
    resetLocalImageWorkerForTests();
    process.env.FAKE_SD_MODE = 'hang';
    const prior = localImageConfig().timeoutMs;
    localImageConfig().timeoutMs = 700; // test-only override below the 60 s config floor
    try {
      const req = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
      const started = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: req.json.revision });
      const done = await waitForJob(started.json.id);
      expect(done.state).toBe('timed_out');
      expect(done.error.code).toBe('LOCAL_IMAGE_TIMEOUT');
      expect(done.error.message).toMatch(/Lower the steps or raise the timeout/);
      await waitForIdle();
    } finally {
      localImageConfig().timeoutMs = prior;
      process.env.FAKE_SD_MODE = 'ok';
    }
  });

  it('a corrupt output is refused before it is registered', async () => {
    resetLocalImageWorkerForTests();
    process.env.FAKE_SD_MODE = 'corrupt';
    try {
      const req = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
      const started = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: req.json.revision, seed: 5 });
      const done = await waitForJob(started.json.id);
      expect(done.state).toBe('failed');
      expect(done.error.code).toBe('LOCAL_IMAGE_INVALID_OUTPUT');
      expect(done.approvedAssetId).toBeNull();
      const approve = await call('POST', `/api/local-images/jobs/${started.json.id}/approve`);
      expect(approve.status).toBe(409);
      await waitForIdle();
    } finally {
      process.env.FAKE_SD_MODE = 'ok';
    }
  });

  it('a runner failure is shown with its code, and no image is kept', async () => {
    resetLocalImageWorkerForTests();
    process.env.FAKE_SD_MODE = 'fail';
    try {
      const req = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
      const started = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: req.json.revision, seed: 6 });
      const done = await waitForJob(started.json.id);
      expect(done.state).toBe('failed');
      expect(done.error.code).toBe('LOCAL_IMAGE_FAILED');
      expect(done.error.message).toMatch(/code 3/);
      await waitForIdle();
    } finally {
      process.env.FAKE_SD_MODE = 'ok';
    }
  });

  it('a job that was running when the server stopped is marked interrupted on restart, never succeeded', async () => {
    const jobsDir = path.join(localImageConfig().root, 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });
    const id = 'lij_0123456789abcdef';
    fs.writeFileSync(path.join(jobsDir, `${id}.json`), JSON.stringify({ id, state: 'running', progress: 0.4, error: null, approvedAssetId: null, provenance: null, updatedAt: '', createdAt: '' }));
    recoverLocalJobs();
    const r = await call('GET', `/api/local-images/jobs/${id}`);
    expect(r.json.state).toBe('interrupted');
    expect(r.json.provenance).toBeNull();
  });

  it('a runner that vanishes is refused before any job is created, and the worker stays free', async () => {
    resetLocalImageWorkerForTests();
    const priorRunner = localImageConfig().runnerPath;
    const req = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
    localImageConfig().runnerPath = path.join(tmp.root, 'vanishing-runner');
    try {
      const started = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: req.json.revision, seed: 3 });
      expect(started.status).toBe(503);
      expect(started.json.code).toBe('LOCAL_IMAGE_SETUP_REQUIRED');
    } finally {
      localImageConfig().runnerPath = priorRunner;
    }
    const s = await call('GET', '/api/local-images/status');
    expect(s.json.busy).toBe(false);
  });

  it('unknown or malformed job ids are not found', async () => {
    expect((await call('GET', '/api/local-images/jobs/lij_nothing')).status).toBe(404);
    expect((await call('GET', '/api/local-images/jobs/lij_ffffffffffffffff')).status).toBe(404);
  });
});

describe('the factory shows images as local, not Google', () => {
  it('capabilities report the local image route and that Google is not used for images', async () => {
    const r = await call('GET', '/api/factory/capabilities');
    expect(r.json.image.route).toBe('local_stable_diffusion_cpp');
    expect(r.json.image.googleUsed).toBe(false);
    expect(r.json.image.available).toBe(false);
  });

  it('the plan route stays on the labelled local planner: no Google call during any local image step', () => {
    const googleCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('generativelanguage'));
    expect(googleCalls).toHaveLength(0);
  });
});

describe('still prompt correction: revision-checked, smallest change, server-owned fields kept', () => {
  const GOOD =
    'Subject: a plain white bowl of dates on a wooden table; Environment: an empty warm room with a window; ' +
    'Lighting: soft late afternoon light from the left; Composition: bowl on the right third, empty space on the left; ' +
    'Shot: still life; Exclude: none';
  const correctUrl = () => `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-prompt`;

  it('refuses a stale revision with 409 and leaves the stored description unchanged', async () => {
    const before = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
    const r = await call('POST', correctUrl(), { expectedRevision: before.json.revision + 7, visualDescription: GOOD });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('FACTORY_REVISION_CONFLICT');
    const after = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
    expect(after.json.revision).toBe(before.json.revision);
    expect(after.json.prompt).toBe(before.json.prompt);
  });

  it('refuses vague prose with 422 and the validator messages, and changes nothing', async () => {
    const cur = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
    const r = await call('POST', correctUrl(), { expectedRevision: cur.json.revision, visualDescription: 'a nice bright room' });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('FACTORY_VALIDATION');
    expect(r.json.error).toMatch(/labelled parts/);
    const after = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
    expect(after.json.revision).toBe(cur.json.revision);
  });

  it('refuses a screen-recording shot: the owner supplies the recording', async () => {
    const cur = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
    const r = await call('POST', `/api/factory/drafts/${ids.draftId}/scenes/${ids.recordingSceneId}/still-prompt`, { expectedRevision: cur.json.revision, visualDescription: GOOD });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('FACTORY_VALIDATION');
  });

  it('a valid correction bumps the revision once, changes only the description, and keeps the bound still and scene fields', async () => {
    const draftBefore = await call('GET', `/api/factory/drafts/${ids.draftId}`);
    const sceneBefore = draftBefore.json.treatments.flatMap((t: any) => t.scenes).find((s: any) => s.id === ids.imageSceneId);
    const rev = draftBefore.json.revision;
    const r = await call('POST', correctUrl(), { expectedRevision: rev, visualDescription: GOOD });
    expect(r.status).toBe(200);
    expect(r.json.revision).toBe(rev + 1);
    const draftAfter = await call('GET', `/api/factory/drafts/${ids.draftId}`);
    const sceneAfter = draftAfter.json.treatments.flatMap((t: any) => t.scenes).find((s: any) => s.id === ids.imageSceneId);
    // Only the visual intent may change. Asset binding, status, and other server-owned fields stay.
    const { visualIntent: beforeIntent, ...restBefore } = sceneBefore;
    const { visualIntent: afterIntent, ...restAfter } = sceneAfter;
    expect(afterIntent).toBe(GOOD);
    expect(restAfter).toEqual(restBefore);
    // The next prompt is composed from the corrected description, with the aspect of the draft.
    const still = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.imageSceneId}/still-request`);
    expect(still.json.prompt).toMatch(/white bowl of dates/);
    expect(still.json.prompt).toMatch(/16:9 frame/);
    expect(still.json.prompt).not.toMatch(/notice board/);
    ids.revision = still.json.revision;
  });

  it('after the correction, a job with the old revision is refused (no runner call)', async () => {
    const r = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.imageSceneId, expectedRevision: ids.revision - 1 });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('FACTORY_REVISION_CONFLICT');
  });
});
