/**
 * Paid still generation for one shot, through the REAL registered server.
 *
 * LABELLED TEST DOUBLES: the Gemini REST endpoint is a scripted fetch double (plan text and an
 * image response). The image bytes are a 1x1 PNG and a JPEG header written by this test. No live
 * provider was called. No owner media was touched. The budget ledger lives in a temporary root.
 *
 * Shows: nothing is sent while the feature is off or unconfirmed; a missing confirmation and a
 * stale revision cost nothing; a recording shot is never filled with a still; a generated still
 * binds to ONE shot and leaves the others alone; a replacement keeps the earlier image in the
 * library; invalid output and 401 keep the charged attempt and change nothing; the 4-call hard cap
 * stops the next call before the provider.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const os = process.getBuiltinModule('node:os') as typeof import('node:os');
  const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'factory-visual-'));
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  process.env.VF_PREVIEW_DISABLE = '1';
  process.env.GEMINI_API_KEY = 'FIXTURE-KEY-VISUAL-0123456789';
  process.env.GEMINI_GENERATION_ENABLED = '1';
  process.env.GEMINI_FREE_TIER_CONFIRMED = '1';
  process.env.GEMINI_IMAGE_GENERATION_ENABLED = '0';
  process.env.GEMINI_IMAGE_PAID_CONFIRMED = '0';
  process.env.GEMINI_BUDGET_IMAGE = '4';
  return { root };
});

import { buildServerApp } from '../apps/api/src/server.js';
import { DATA_DIR, ASSETS_DIR } from '../apps/api/src/services/platform.js';
import { loadAssetIndex } from '../apps/api/src/routes/assets.js';
import { credentialFingerprint } from '../apps/api/src/services/gemini-client.js';
import { geminiDeps } from '../apps/api/src/services/gemini-service.js';
import { fixtureEducationalPlan } from './gemini/helpers.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG_B64 = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex').toString('base64');
const TEXT_MODEL = 'gemini-2.5-flash';
const IMAGE_MODEL = 'gemini-3.1-flash-image';

/** LABELLED TEST DOUBLE. Counts every image call and keeps the request bodies to inspect. */
const double = vi.hoisted(() => ({
  imageCalls: 0,
  textCalls: 0,
  imageBodies: [] as any[],
  mode: 'png' as 'png' | 'jpeg' | 'gif' | 'unauthorized',
}));
const fetchSpy = vi.fn(async (url: string, init?: { body?: string }) => {
  const u = String(url);
  const json = (payload: unknown, status = 200) => ({ ok: status < 400, status, json: async () => payload });
  if (u.includes(`/models/${TEXT_MODEL}:generateContent`)) {
    double.textCalls += 1;
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(fixtureEducationalPlan()) }] }, finishReason: 'STOP' }] });
  }
  if (u.includes(`/models/${IMAGE_MODEL}:generateContent`)) {
    double.imageCalls += 1;
    double.imageBodies.push(JSON.parse(String(init?.body ?? '{}')));
    if (double.mode === 'unauthorized') return json({ error: { message: 'API key not valid' } }, 401);
    if (double.mode === 'gif') return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/gif', data: PNG_B64 } }] }, finishReason: 'STOP' }] });
    if (double.mode === 'jpeg') return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: JPEG_B64 } }] }, finishReason: 'STOP' }] });
    return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] }, finishReason: 'STOP' }] });
  }
  throw new Error(`TEST DOUBLE: unexpected provider URL ${u}`);
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

async function waitForJob(jobId: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const r = await call('GET', `/api/factory/ai/jobs/${jobId}`);
    if (r.json.job.status !== 'running') return r.json.job;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('job did not finish');
}

/** The envelope keeps scenes under treatments; the selected treatment is T1 in these tests. */
const scenesOf = (env: any): any[] => env.treatments.find((t: any) => t.id === 'T1').scenes;

const state = { draftId: '', stillSceneId: '', otherStillSceneId: '', recordingSceneId: '', firstAssetId: '' };

/** Sets the image gates on the shared server config. The route reads the same object. */
function setGates(enabled: boolean, paidConfirmed: boolean): void {
  const d = geminiDeps();
  d.cfg.imageGenerationEnabled = enabled;
  d.cfg.imagePaidConfirmed = paidConfirmed;
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);
  app = await buildServerApp();
  fs.mkdirSync(path.join(DATA_DIR, 'factory', 'ai'), { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, 'factory', 'ai', 'verification.json'),
    JSON.stringify({
      checkedAt: '2026-10-13T00:00:00Z', sessionId: 'default', catalogReachable: true,
      endpoint: 'v1beta/models/{model}:generateContent', credentialFingerprint: credentialFingerprint(process.env.GEMINI_API_KEY as string),
      textModel: TEXT_MODEL, ttsModel: 'gemini-3.8-flash-tts', textGenerationOk: true, speechGenerationOk: true, speechLanguagesLive: ['en'],
    }),
  );
  // A draft from a labelled fixture plan. Text only; no image call happens during setup.
  const created = await call('POST', '/api/factory/ai/plans', {
    profile: 'educational', format: 'landscape', brief: 'Explain why deliveries must be confirmed the night before.',
  });
  expect(created.status).toBe(202);
  const job = await waitForJob(created.json.job.id);
  expect(job.status).toBe('succeeded');
  const draft = await call('POST', `/api/factory/ai/plans/${job.id}/draft`, { format: 'landscape' });
  expect(draft.status).toBe(201);
  state.draftId = draft.json.draftId;
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('paid still per shot (labelled fetch double, fixture plan)', () => {
  it('select the treatment and find the still and recording shots; nothing is generated by selecting', async () => {
    const before = double.imageCalls;
    const d = await call('GET', `/api/factory/drafts/${state.draftId}`);
    const scenes = d.json.treatments.find((t: any) => t.id === 'T1').scenes;
    const patched = await call('PATCH', `/api/factory/drafts/${state.draftId}`, {
      expectedRevision: d.json.revision, selectedTreatmentId: 'T1', scenes, speakers: [],
    });
    expect(patched.status, patched.raw).toBe(200);
    const list = await call('GET', `/api/factory/drafts/${state.draftId}/shot-list`);
    // The fixture plan has three shots: a library-backed shot, a screen-recording shot, and one image shot.
    const stills = list.json.scenes.filter((s: any) => s.assetNeed === 'image_needed');
    expect(stills.length).toBe(1);
    state.stillSceneId = stills[0].sceneId;
    state.otherStillSceneId = list.json.scenes.find((s: any) => s.assetNeed === 'existing_library').sceneId;
    state.recordingSceneId = list.json.scenes.find((s: any) => s.assetNeed === 'screen_recording_needed').sceneId;
    expect(state.recordingSceneId).toBeTruthy();
    expect(double.imageCalls).toBe(before);
  });

  it('the status reports the paid route and that the feature is off by default, with no provider call', async () => {
    const r = await call('GET', '/api/factory/visual-generation');
    expect(r.status).toBe(200);
    expect(r.json.state).toBe('disabled');
    expect(r.json.ready).toBe(false);
    expect(r.json.freeTier).toBe('not_available');
    expect(r.json.paidOnly).toBe(true);
    expect(r.json.videoGeneration).toBe('not_implemented');
    expect(r.json.model).toBe(IMAGE_MODEL);
    expect(r.json.endpoint).toBe(`v1beta/models/${IMAGE_MODEL}:generateContent`);
    expect(r.json.budget).toEqual({ limit: 4, used: 0, remaining: 4 });
    expect(double.imageCalls).toBe(0);
  });

  it('off by default: the generate call is refused with no provider call and no ledger charge', async () => {
    setGates(false, false);
    const d = await call('GET', `/api/factory/drafts/${state.draftId}`);
    const r = await call('POST', `/api/factory/drafts/${state.draftId}/scenes/${state.stillSceneId}/generate-still`, {
      expectedRevision: d.json.revision, confirmSpend: true,
    });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('FACTORY_PROVIDER_DISABLED');
    expect(double.imageCalls).toBe(0);
    expect(geminiDeps().store.usage('default').image).toBe(0);
  });

  it('enabled but not paid-confirmed stays refused; the status says why', async () => {
    setGates(true, false);
    const status = await call('GET', '/api/factory/visual-generation');
    expect(status.json.state).toBe('paid_not_confirmed');
    const d = await call('GET', `/api/factory/drafts/${state.draftId}`);
    const r = await call('POST', `/api/factory/drafts/${state.draftId}/scenes/${state.stillSceneId}/generate-still`, {
      expectedRevision: d.json.revision, confirmSpend: true,
    });
    expect(r.status).toBe(403);
    expect(double.imageCalls).toBe(0);
  });

  it('a request without confirmSpend, or with a stale revision, is refused before any charge', async () => {
    setGates(true, true);
    const d = await call('GET', `/api/factory/drafts/${state.draftId}`);
    const noConfirm = await call('POST', `/api/factory/drafts/${state.draftId}/scenes/${state.stillSceneId}/generate-still`, {
      expectedRevision: d.json.revision,
    });
    expect(noConfirm.status).toBe(422);
    const stale = await call('POST', `/api/factory/drafts/${state.draftId}/scenes/${state.stillSceneId}/generate-still`, {
      expectedRevision: d.json.revision + 5, confirmSpend: true,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('FACTORY_REVISION_CONFLICT');
    expect(double.imageCalls).toBe(0);
    expect(geminiDeps().store.usage('default').image).toBe(0);
  });

  it('a screen-recording shot is never filled with a still: refused, no call, no charge', async () => {
    const d = await call('GET', `/api/factory/drafts/${state.draftId}`);
    const r = await call('POST', `/api/factory/drafts/${state.draftId}/scenes/${state.recordingSceneId}/generate-still`, {
      expectedRevision: d.json.revision, confirmSpend: true,
    });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('FACTORY_ASSET_INVALID');
    expect(r.json.error).toMatch(/screen recording/i);
    expect(double.imageCalls).toBe(0);
  });

  it('one confirmed call generates a still for ONE shot: that shot binds, the others stay missing, the request carries only the prompt', async () => {
    const d = await call('GET', `/api/factory/drafts/${state.draftId}`);
    const before = scenesOf(d.json).map((s: any) => ({ id: s.id, assetId: s.assetId }));
    const r = await call('POST', `/api/factory/drafts/${state.draftId}/scenes/${state.stillSceneId}/generate-still`, {
      expectedRevision: d.json.revision, confirmSpend: true,
    });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.generated.assetId).toMatch(/^gen_[0-9a-f]{16}$/);
    expect(r.json.generated.model).toBe(IMAGE_MODEL);
    expect(r.json.generated.budget).toEqual({ limit: 4, used: 1, remaining: 3 });
    expect(r.json.revision).toBe(d.json.revision + 1);
    state.firstAssetId = r.json.generated.assetId;

    // Only the prompt and the aspect ratio leave the server.
    expect(double.imageCalls).toBe(1);
    const body = double.imageBodies[0];
    expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig']);
    expect(body.generationConfig.responseModalities).toEqual(['IMAGE']);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '1K' });
    expect(JSON.stringify(body)).not.toMatch(/\/home\/|\.json|BUILDTRAKE/);

    // The file is in the library, labelled as AI-generated, with its licence note.
    const rec = loadAssetIndex().find((a: any) => a.id === state.firstAssetId) as any;
    expect(rec).toBeTruthy();
    expect(rec.source).toMatch(/AI-generated still/);
    expect(rec.source).toMatch(/Not a screen recording/);
    expect(rec.license).toMatch(/Owner review required/);
    expect(fs.existsSync(path.join(ASSETS_DIR, rec.fileName))).toBe(true);

    // The shot is bound; the other shots are untouched.
    const after = scenesOf(r.json).map((s: any) => ({ id: s.id, assetId: s.assetId }));
    for (const b of before) {
      const a = after.find((x: any) => x.id === b.id);
      if (b.id === state.stillSceneId) expect(a.assetId).toBe(state.firstAssetId);
      else expect(a.assetId).toBe(b.assetId);
    }
    const list = await call('GET', `/api/factory/drafts/${state.draftId}/shot-list`);
    const shot = list.json.scenes.find((s: any) => s.sceneId === state.stillSceneId);
    expect(shot.status).toBe('bound');
    expect(shot.mediaType).toBe('image');
    expect(shot.source).toMatch(/AI-generated/);
    const other = list.json.scenes.find((s: any) => s.sceneId === state.otherStillSceneId);
    expect(other.status).toBe('missing');
    expect(other.prompt).toBeNull(); // a library-backed shot takes no generated still

    // Apply stays blocked: other shots are still missing. Nothing is spent on speech.
    const preview = await call('GET', `/api/factory/drafts/${state.draftId}/apply-preview`);
    expect(preview.json.canApply).toBe(false);
  });

  it('a replacement generates a second image for the same shot; the earlier image stays in the library', async () => {
    double.mode = 'jpeg';
    const d = await call('GET', `/api/factory/drafts/${state.draftId}`);
    const r = await call('POST', `/api/factory/drafts/${state.draftId}/scenes/${state.stillSceneId}/generate-still`, {
      expectedRevision: d.json.revision, confirmSpend: true,
    });
    expect(r.status, r.raw).toBe(201);
    expect(r.json.generated.assetId).not.toBe(state.firstAssetId);
    expect(r.json.generated.budget.used).toBe(2);
    const scene = scenesOf(r.json).find((s: any) => s.id === state.stillSceneId);
    expect(scene.assetId).toBe(r.json.generated.assetId);
    expect(loadAssetIndex().some((a: any) => a.id === state.firstAssetId)).toBe(true);
    double.mode = 'png';
  });

  it('invalid output (a GIF) is refused: the attempt stays charged, nothing is saved, the shot keeps its image', async () => {
    double.mode = 'gif';
    const before = (await call('GET', `/api/factory/drafts/${state.draftId}`)).json;
    const shotBefore = scenesOf(before).find((s: any) => s.id === state.stillSceneId).assetId;
    const indexBefore = loadAssetIndex().length;
    const r = await call('POST', `/api/factory/drafts/${state.draftId}/scenes/${state.stillSceneId}/generate-still`, {
      expectedRevision: before.revision, confirmSpend: true,
    });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('FACTORY_AI_INVALID_OUTPUT');
    expect(loadAssetIndex().length).toBe(indexBefore);
    expect(geminiDeps().store.usage('default').image).toBe(3);
    const after = (await call('GET', `/api/factory/drafts/${state.draftId}`)).json;
    expect(after.revision).toBe(before.revision);
    expect(scenesOf(after).find((s: any) => s.id === state.stillSceneId).assetId).toBe(shotBefore);
    double.mode = 'png';
  });

  it('a 401 from the provider is stated plainly: the attempt stays charged, nothing changes', async () => {
    double.mode = 'unauthorized';
    const before = (await call('GET', `/api/factory/drafts/${state.draftId}`)).json;
    const r = await call('POST', `/api/factory/drafts/${state.draftId}/scenes/${state.stillSceneId}/generate-still`, {
      expectedRevision: before.revision, confirmSpend: true,
    });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('FACTORY_PROVIDER_AUTH');
    expect(r.raw).not.toContain('FIXTURE-KEY-VISUAL');
    expect(geminiDeps().store.usage('default').image).toBe(4);
    const after = (await call('GET', `/api/factory/drafts/${state.draftId}`)).json;
    expect(after.revision).toBe(before.revision);
    double.mode = 'png';
  });

  it('the session cap (4) stops the next call before the provider; the status shows the budget used up', async () => {
    const callsBefore = double.imageCalls;
    const d = await call('GET', `/api/factory/drafts/${state.draftId}`);
    const r = await call('POST', `/api/factory/drafts/${state.draftId}/scenes/${state.stillSceneId}/generate-still`, {
      expectedRevision: d.json.revision, confirmSpend: true,
    });
    expect(r.status).toBe(429);
    expect(r.json.code).toBe('FACTORY_BUDGET_EXHAUSTED');
    expect(double.imageCalls).toBe(callsBefore);
    const status = await call('GET', '/api/factory/visual-generation');
    expect(status.json.state).toBe('budget_exhausted');
    expect(status.json.budget).toEqual({ limit: 4, used: 4, remaining: 0 });
  });
});
