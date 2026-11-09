/**
 * Candidate freshness and the religious visual constraint, through the REAL registered server.
 *
 * LABELLED TEST DOUBLES, all of them:
 *  - the runner is tests/fixtures/fake-sd-cli.mjs. It is NOT stable-diffusion.cpp and runs no model. It writes
 *    a real PNG whose pixels depend on the seed. FAKE_SD_MODE=slow paces the steps so a test can change the
 *    shot while a job is still running.
 *  - the model file is a few test bytes, not SD 1.5 weights.
 *  - the planner (used only to create the educational draft) is a scripted loopback double.
 *
 * Shows: a candidate records the shot it was made for; changing that shot (description, composed prompt,
 * aspect or profile) makes it non-current, so approve and bind refuse it while the file is kept; unrelated saves
 * and a re-save of the same text keep it current; generic library images still bind; a religious still is
 * refused a brand, identity, lettering or scripture request at correction, at PATCH, at generation, and for a
 * tampered or legacy stored description. Code and fixture evidence only. Not visual quality, not owner acceptance.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodeCrypto = process.getBuiltinModule('node:crypto') as typeof import('node:crypto');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'local-fresh-'));
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
import { ASSETS_DIR } from '../apps/api/src/services/platform.js';
import { DRAFTS_DIR } from '../apps/api/src/services/factory-service.js';
import { loadAssetIndex, saveAssetIndex } from '../apps/api/src/routes/assets.js';
import { fixtureEducationalPlan, localChatResponse } from './gemini/helpers.js';
import { localImageConfig, resetLocalImageWorkerForTests } from '../apps/api/src/services/local-image.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

/** LABELLED TEST DOUBLE for the local planner (draft creation only). Google is never called. */
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

async function waitForJob(jobId: string): Promise<any> {
  for (let i = 0; i < 1500; i++) {
    const r = await call('GET', `/api/local-images/jobs/${jobId}`);
    if (r.json.state !== 'queued' && r.json.state !== 'running') return r.json;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('local job did not finish');
}

async function waitForIdle(): Promise<void> {
  for (let i = 0; i < 1500; i++) {
    const s = await call('GET', '/api/local-images/status');
    if (!s.json.busy) return;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('worker stayed busy');
}

async function waitForPlan(jobId: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const r = await call('GET', `/api/factory/ai/jobs/${jobId}`);
    if (r.json.job.status !== 'running') return r.json.job;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('plan job did not finish');
}

const ids = { eduDraft: '', eduImage: '', relDraft: '', relImage: '' };

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);
  app = await buildServerApp();
  fs.mkdirSync(path.join(process.env.BUILDTRAKE_DATA as string, 'factory', 'ai'), { recursive: true });
  // Educational draft from the labelled planner double (it has one image shot and one recording shot).
  const created = await call('POST', '/api/factory/ai/plans', {
    profile: 'educational', format: 'landscape', brief: 'Explain why deliveries must be confirmed the night before.',
  });
  expect(created.status).toBe(202);
  const job = await waitForPlan(created.json.job.id);
  expect(job.status).toBe('succeeded');
  const draft = await call('POST', `/api/factory/ai/plans/${job.id}/draft`, { format: 'landscape' });
  expect(draft.status).toBe(201);
  ids.eduDraft = draft.json.draftId;
  const list = await call('GET', `/api/factory/drafts/${ids.eduDraft}/shot-list`);
  ids.eduImage = list.json.scenes.find((s: any) => s.assetNeed === 'image_needed').sceneId;

  // Religious draft from a supplied script (local rules, no planner call).
  const rel = await call('POST', '/api/factory/drafts', {
    contentProfile: 'religious', format: 'landscape',
    inputs: { brief: 'A short reflection on patience at work.', script: 'Patience is practised one task at a time.\nWrite the next step down before you rest.', audioAssetId: null, visualAssetIds: [], storyboard: null },
    requestedSpeakers: [], referenceProjectId: null,
  });
  expect(rel.status).toBe(201);
  ids.relDraft = rel.json.draftId;
  const relList = await call('GET', `/api/factory/drafts/${ids.relDraft}/shot-list`);
  const relStill = relList.json.scenes.find((s: any) => s.assetNeed === 'image_needed');
  expect(relStill, 'the religious draft has an image shot').toBeTruthy();
  ids.relImage = relStill.sceneId;
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  resetLocalImageWorkerForTests();
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

const A_TEXT =
  'Subject: a plain white bowl of dates on a wooden table; Environment: an empty warm room with a window; ' +
  'Lighting: soft late afternoon light from the left; Composition: bowl on the right third, empty space on the left; Shot: still life; Exclude: none';
const B_TEXT =
  'Subject: a glass jar of dates on a wooden table; Environment: an empty warm room with a window; ' +
  'Lighting: soft late afternoon light from the left; Composition: jar on the right third, empty space on the left; Shot: still life; Exclude: none';
const BUILDTRACK_TEXT =
  'Subject: a BuildTrack logo printed on a plain leather book; Environment: quiet empty room; Lighting: soft warm light; Composition: book on table; Shot: close-up; Exclude: none';
const PLAIN_BOOK_TEXT =
  'Subject: a closed plain leather book on a low table; Environment: quiet empty room with a window; Lighting: soft warm light; Composition: book on the right third; Shot: close-up; Exclude: text, logo';

let seedCounter = 1000;

async function stillOf(draftId: string, sceneId: string) {
  return (await call('GET', `/api/factory/drafts/${draftId}/scenes/${sceneId}/still-request`)).json;
}

/** Saves a description at the current revision. Returns the new revision. Fails the test on any refusal. */
async function setPrompt(draftId: string, sceneId: string, text: string): Promise<number> {
  const cur = await stillOf(draftId, sceneId);
  const r = await call('POST', `/api/factory/drafts/${draftId}/scenes/${sceneId}/still-prompt`, { expectedRevision: cur.revision, visualDescription: text });
  expect(r.status, r.raw).toBe(200);
  return r.json.revision;
}

/** Starts one job at the current revision with a distinct seed, and waits for it to finish. */
async function runJob(draftId: string, sceneId: string): Promise<any> {
  await waitForIdle();
  const cur = await stillOf(draftId, sceneId);
  const r = await call('POST', '/api/local-images/jobs', { draftId, sceneId, expectedRevision: cur.revision, seed: seedCounter++ });
  expect(r.status, r.raw).toBe(202);
  const done = await waitForJob(r.json.id);
  await waitForIdle();
  return done;
}

const approve = (jobId: string) => call('POST', `/api/local-images/jobs/${jobId}/approve`);
const jobView = (jobId: string) => call('GET', `/api/local-images/jobs/${jobId}`);
const candidateFile = (jobId: string) => path.join(localImageConfig().root, 'jobs', jobId, 'candidate.png');

async function bindAsset(draftId: string, sceneId: string, assetId: string) {
  const cur = await stillOf(draftId, sceneId);
  return call('POST', `/api/factory/drafts/${draftId}/bind-image`, { expectedRevision: cur.revision, sceneId, assetId });
}

describe('candidate freshness: the server decides, not the page', () => {
  it('generate -> correct the prompt -> the old candidate cannot be approved; its file is kept', async () => {
    await setPrompt(ids.eduDraft, ids.eduImage, A_TEXT);
    const job = await runJob(ids.eduDraft, ids.eduImage);
    expect(job.state).toBe('succeeded');
    expect((await jobView(job.id)).json.candidate).toEqual({ current: true, reason: null, message: null });

    await setPrompt(ids.eduDraft, ids.eduImage, B_TEXT);

    const a = await approve(job.id);
    expect(a.status).toBe(409);
    expect(a.json.code).toBe('FACTORY_CANDIDATE_STALE');
    expect(a.json.reason).toBe('prompt_changed');
    expect(a.json.error).toMatch(/Generate a new candidate/);
    expect(a.json.error).toMatch(/earlier file is kept/);

    const after = (await jobView(job.id)).json;
    expect(after.candidate.current).toBe(false);
    expect(after.candidate.reason).toBe('prompt_changed');
    expect(after.approvedAssetId).toBeNull();
    expect(fs.existsSync(candidateFile(job.id))).toBe(true);
  });

  it('approve -> correct the prompt -> a bind of the stale candidate is refused; a new candidate binds', async () => {
    await setPrompt(ids.eduDraft, ids.eduImage, A_TEXT);
    const job1 = await runJob(ids.eduDraft, ids.eduImage);
    const ap1 = await approve(job1.id);
    expect(ap1.status).toBe(200);
    const assetId1: string = ap1.json.assetId;

    await setPrompt(ids.eduDraft, ids.eduImage, B_TEXT);

    const stale = await bindAsset(ids.eduDraft, ids.eduImage, assetId1);
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('FACTORY_CANDIDATE_STALE');
    expect(stale.json.reason).toBe('prompt_changed');
    expect((await stillOf(ids.eduDraft, ids.eduImage)).boundAssetId).not.toBe(assetId1);

    // A candidate generated for the current prompt approves and binds normally.
    const job2 = await runJob(ids.eduDraft, ids.eduImage);
    const ap2 = await approve(job2.id);
    expect(ap2.status).toBe(200);
    const assetId2: string = ap2.json.assetId;
    const ok = await bindAsset(ids.eduDraft, ids.eduImage, assetId2);
    expect(ok.status, ok.raw).toBe(200);
    expect((await stillOf(ids.eduDraft, ids.eduImage)).boundAssetId).toBe(assetId2);

    // The earlier candidate still cannot replace the newer bound still.
    const again = await bindAsset(ids.eduDraft, ids.eduImage, assetId1);
    expect(again.status).toBe(409);
    expect(again.json.reason).toBe('prompt_changed');
    expect((await stillOf(ids.eduDraft, ids.eduImage)).boundAssetId).toBe(assetId2);
  });

  it('a correction saved while the job is running: the job completes, but it cannot be approved as current', async () => {
    process.env.FAKE_SD_MODE = 'slow';
    process.env.FAKE_SD_STEP_MS = '300';
    try {
      await waitForIdle();
      await setPrompt(ids.eduDraft, ids.eduImage, A_TEXT);
      const cur = await stillOf(ids.eduDraft, ids.eduImage);
      const started = await call('POST', '/api/local-images/jobs', { draftId: ids.eduDraft, sceneId: ids.eduImage, expectedRevision: cur.revision, seed: seedCounter++ });
      expect(started.status).toBe(202);
      expect(['queued', 'running']).toContain((await jobView(started.json.id)).json.state);

      // The correction is accepted while the job runs. It does not cancel the job; it changes the shot.
      await setPrompt(ids.eduDraft, ids.eduImage, B_TEXT);
      expect(['queued', 'running']).toContain((await jobView(started.json.id)).json.state);

      const done = await waitForJob(started.json.id);
      expect(done.state).toBe('succeeded');
      expect(done.candidate.current).toBe(false);
      const a = await approve(started.json.id);
      expect(a.status).toBe(409);
      expect(a.json.reason).toBe('prompt_changed');
      await waitForIdle();
    } finally {
      process.env.FAKE_SD_MODE = 'ok';
      delete process.env.FAKE_SD_STEP_MS;
    }
  });

  it('an unchanged candidate still approves and binds, and re-saving the same text does not invalidate it', async () => {
    await setPrompt(ids.eduDraft, ids.eduImage, A_TEXT);
    const job = await runJob(ids.eduDraft, ids.eduImage);
    const a1 = await approve(job.id);
    expect(a1.status).toBe(200);
    // Re-save the same description: the revision changes, the shot's inputs do not.
    await setPrompt(ids.eduDraft, ids.eduImage, A_TEXT);
    expect((await jobView(job.id)).json.candidate.current).toBe(true);
    const a2 = await approve(job.id);
    expect(a2.status).toBe(200);
    expect(a2.json.assetId).toBe(a1.json.assetId);
    const b = await bindAsset(ids.eduDraft, ids.eduImage, a1.json.assetId);
    expect(b.status, b.raw).toBe(200);
    expect((await stillOf(ids.eduDraft, ids.eduImage)).boundAssetId).toBe(a1.json.assetId);
  });

  it('an unrelated draft save keeps the candidate usable; a generic library image still binds, and a stale local candidate still does not', async () => {
    await setPrompt(ids.eduDraft, ids.eduImage, A_TEXT);
    const job = await runJob(ids.eduDraft, ids.eduImage);
    const ap = await approve(job.id);
    expect(ap.status).toBe(200);
    const localAsset: string = ap.json.assetId;

    // Unrelated edit: save the same draft rows (same shots, same descriptions). The revision moves.
    const d = (await call('GET', `/api/factory/drafts/${ids.eduDraft}`)).json;
    const rows = d.treatments.find((t: any) => t.id === d.selectedTreatmentId).scenes;
    const patched = await call('PATCH', `/api/factory/drafts/${ids.eduDraft}`, { expectedRevision: d.revision, selectedTreatmentId: d.selectedTreatmentId, scenes: rows, speakers: [] });
    expect(patched.status, patched.raw).toBe(200);
    expect((await jobView(job.id)).json.candidate.current).toBe(true);
    const stillAfterSave = await stillOf(ids.eduDraft, ids.eduImage);
    expect(stillAfterSave.prompt).toMatch(/white bowl/);
    const reApprove = await approve(job.id);
    expect(reApprove.status).toBe(200);
    expect(reApprove.json.assetId).toBe(localAsset);

    // Ordinary library image: a supplied file, not generated locally. It binds whatever the local candidates say.
    const bytes = fs.readFileSync(candidateFile(job.id));
    const fileName = 'fx-freshness-library.png';
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ASSETS_DIR, fileName), bytes);
    saveAssetIndex([
      ...loadAssetIndex(),
      {
        id: 'fx-freshness-library', name: 'Fixture library still', kind: 'broll', fileName, path: fileName, mimeType: 'image/png',
        sizeBytes: bytes.length, tags: [], status: 'active', preferred: false, source: 'Fixture (synthetic, generated by the test)',
        license: 'Test fixture', addedAt: new Date().toISOString(), usedIn: [], blocked: false,
      } as never,
    ]);
    // Make the local candidate stale, then bind the ordinary library image: allowed.
    await setPrompt(ids.eduDraft, ids.eduImage, B_TEXT);
    const libBind = await bindAsset(ids.eduDraft, ids.eduImage, 'fx-freshness-library');
    expect(libBind.status, libBind.raw).toBe(200);
    // The stale local candidate is still refused, even though the shot now holds another still.
    const staleLocal = await bindAsset(ids.eduDraft, ids.eduImage, localAsset);
    expect(staleLocal.status).toBe(409);
    expect(staleLocal.json.reason).toBe('prompt_changed');
  });

  it('identical bytes approved again for the current description re-stamp the asset: the latest approved identity binds', async () => {
    // The fake runner's pixels depend on the seed, not the prompt. Same seed + different prompt = identical bytes = one asset.
    const runSeed = async (draftId: string, sceneId: string, seed: number) => {
      await waitForIdle();
      const cur = await stillOf(draftId, sceneId);
      const r = await call('POST', '/api/local-images/jobs', { draftId, sceneId, expectedRevision: cur.revision, seed });
      expect(r.status, r.raw).toBe(202);
      const done = await waitForJob(r.json.id);
      await waitForIdle();
      return done;
    };
    await setPrompt(ids.eduDraft, ids.eduImage, A_TEXT);
    const first = await runSeed(ids.eduDraft, ids.eduImage, 4242);
    expect(first.state).toBe('succeeded');
    const a1Ap = await approve(first.id);
    expect(a1Ap.status).toBe(200);
    const sameAsset: string = a1Ap.json.assetId;

    await setPrompt(ids.eduDraft, ids.eduImage, B_TEXT);
    const second = await runSeed(ids.eduDraft, ids.eduImage, 4242);
    expect(second.state).toBe('succeeded');
    const a2Ap = await approve(second.id);
    expect(a2Ap.status, a2Ap.raw).toBe(200);
    expect(a2Ap.json.assetId).toBe(sameAsset);

    // The asset now carries the latest approved identity, so it binds to the shot as it is now.
    const b = await bindAsset(ids.eduDraft, ids.eduImage, sameAsset);
    expect(b.status, b.raw).toBe(200);
    expect((await stillOf(ids.eduDraft, ids.eduImage)).boundAssetId).toBe(sameAsset);
  });

  it('a candidate recorded before this check (no shot identity) is never approved or bound as current', async () => {
    await setPrompt(ids.eduDraft, ids.eduImage, A_TEXT);
    const src = await runJob(ids.eduDraft, ids.eduImage);
    // Simulate a job file written before shot identity existed: same job, no shot record, no approval.
    const legacyId = `lij_${'a'.repeat(15)}1`;
    const jobsDir = path.join(localImageConfig().root, 'jobs');
    const legacy = JSON.parse(fs.readFileSync(path.join(jobsDir, `${src.id}.json`), 'utf8'));
    delete legacy.shot;
    legacy.id = legacyId;
    legacy.approvedAssetId = null;
    fs.mkdirSync(path.join(jobsDir, legacyId), { recursive: true });
    fs.copyFileSync(candidateFile(src.id), candidateFile(legacyId));
    fs.writeFileSync(path.join(jobsDir, `${legacyId}.json`), JSON.stringify(legacy, null, 2));

    const view = (await jobView(legacyId)).json;
    expect(view.candidate.current).toBe(false);
    expect(view.candidate.reason).toBe('no_identity');
    const a = await approve(legacyId);
    expect(a.status).toBe(409);
    expect(a.json.reason).toBe('no_identity');
    expect(fs.existsSync(candidateFile(legacyId))).toBe(true);
  });
});

describe('religious visual constraint: refused at correction, PATCH and generation; never by a negative prompt', () => {
  it('a correction asking for a BuildTrack logo is refused before anything is saved', async () => {
    const before = await stillOf(ids.relDraft, ids.relImage);
    const r = await call('POST', `/api/factory/drafts/${ids.relDraft}/scenes/${ids.relImage}/still-prompt`, { expectedRevision: before.revision, visualDescription: BUILDTRACK_TEXT });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('FACTORY_IDENTITY_REFUSED');
    expect(r.json.error).toMatch(/"BuildTrack" asks for a brand or identity in a religious still/);
    expect(r.json.error).toMatch(/Describe the object or scene instead/);
    const after = await stillOf(ids.relDraft, ids.relImage);
    expect(after.revision).toBe(before.revision);
    expect(after.prompt).not.toMatch(/buildtrack/i);
  });

  it('the counterexample is accepted: a plain closed book, a negated lettering request, and a people choice', async () => {
    await setPrompt(ids.relDraft, ids.relImage, PLAIN_BOOK_TEXT);
    const plain = await stillOf(ids.relDraft, ids.relImage);
    expect(plain.prompt).toMatch(/closed plain leather book/);
    expect(plain.prompt).toMatch(/16:9 frame/);
    expect(plain.negativePrompt).toMatch(/scripture/);
    expect(plain.refusals).toEqual([]);

    await setPrompt(ids.relDraft, ids.relImage, 'Subject: a closed plain leather book with no lettering on its cover; Environment: a quiet room; Lighting: soft warm light; Composition: book centred; Shot: close-up; Exclude: none');
    await setPrompt(ids.relDraft, ids.relImage, 'Subject: two people sharing a meal at a plain table in a quiet room; Environment: a warm kitchen; Lighting: soft window light; Composition: people on the right third; Shot: medium; Exclude: text');
    const people = await stillOf(ids.relDraft, ids.relImage);
    expect(people.prompt).toMatch(/two people sharing a meal/);
    // The people choice is this shot's own; the negative does not ban people for a shot that does not exclude them.
    expect(people.negativePrompt).toMatch(/text/);
    expect(people.refusals).toEqual([]);
  });

  it('generation refuses a tampered (legacy) stored description, with no job started and nothing saved', async () => {
    await setPrompt(ids.relDraft, ids.relImage, PLAIN_BOOK_TEXT);
    const file = path.join(DRAFTS_DIR, `${ids.relDraft}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const scene = stored.selection.find((x: any) => x.id === ids.relImage);
    scene.visualIntent = BUILDTRACK_TEXT;
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));

    const still = await stillOf(ids.relDraft, ids.relImage);
    expect(still.refusals.length).toBeGreaterThan(0);
    expect(still.refusals.join(' ')).toMatch(/BuildTrack/);
    const list = (await call('GET', `/api/factory/drafts/${ids.relDraft}/shot-list`)).json;
    const row = list.scenes.find((s: any) => s.sceneId === ids.relImage);
    expect(row.promptRefusals.length).toBeGreaterThan(0);

    const jobsDir = path.join(localImageConfig().root, 'jobs');
    const jobsBefore = fs.readdirSync(jobsDir).filter((f) => f.endsWith('.json')).length;
    const r = await call('POST', '/api/local-images/jobs', { draftId: ids.relDraft, sceneId: ids.relImage, expectedRevision: still.revision, seed: 7 });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('FACTORY_IDENTITY_REFUSED');
    expect(fs.readdirSync(jobsDir).filter((f) => f.endsWith('.json')).length).toBe(jobsBefore);
    expect((await call('GET', '/api/local-images/status')).json.busy).toBe(false);
  });

  it('PATCH refuses a changed religious description, but an unrelated save of an unchanged description is not refused', async () => {
    // Tamper first (the stored text now asks for a logo), so the unrelated save below is over a legacy description.
    const file = path.join(DRAFTS_DIR, `${ids.relDraft}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.selection.find((x: any) => x.id === ids.relImage).visualIntent = BUILDTRACK_TEXT;
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));
    const d = (await call('GET', `/api/factory/drafts/${ids.relDraft}`)).json;
    const rows = d.treatments.find((t: any) => t.id === d.selectedTreatmentId).scenes;
    // The stored description is currently the tampered one from the previous test: an unrelated save keeps it.
    const unrelated = await call('PATCH', `/api/factory/drafts/${ids.relDraft}`, { expectedRevision: d.revision, selectedTreatmentId: d.selectedTreatmentId, scenes: rows, speakers: [] });
    expect(unrelated.status, unrelated.raw).toBe(200);

    // Restore a permitted description, so the next PATCH really changes the stored text.
    await setPrompt(ids.relDraft, ids.relImage, PLAIN_BOOK_TEXT);
    const d2 = (await call('GET', `/api/factory/drafts/${ids.relDraft}`)).json;
    const rows2 = d2.treatments.find((t: any) => t.id === d2.selectedTreatmentId).scenes.map((s: any) =>
      s.id === ids.relImage ? { ...s, visualIntent: BUILDTRACK_TEXT } : s);
    const changed = await call('PATCH', `/api/factory/drafts/${ids.relDraft}`, { expectedRevision: d2.revision, selectedTreatmentId: d2.selectedTreatmentId, scenes: rows2, speakers: [] });
    expect(changed.status).toBe(422);
    expect(changed.json.code).toBe('FACTORY_IDENTITY_REFUSED');
    expect(changed.json.error).toMatch(/BuildTrack/);
  });

  it('a candidate made before the description was tampered cannot be approved or bound', async () => {
    await setPrompt(ids.relDraft, ids.relImage, PLAIN_BOOK_TEXT);
    const job = await runJob(ids.relDraft, ids.relImage);
    expect(job.state).toBe('succeeded');
    const ap = await approve(job.id);
    expect(ap.status).toBe(200);
    const assetId: string = ap.json.assetId;

    const file = path.join(DRAFTS_DIR, `${ids.relDraft}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.selection.find((x: any) => x.id === ids.relImage).visualIntent = BUILDTRACK_TEXT;
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));

    const bind = await bindAsset(ids.relDraft, ids.relImage, assetId);
    expect(bind.status).toBe(409);
    expect(bind.json.code).toBe('FACTORY_CANDIDATE_STALE');
    expect(bind.json.reason).toBe('prompt_refused');
    const reapprove = await approve(job.id);
    expect(reapprove.status).toBe(409);
    expect(reapprove.json.reason).toBe('prompt_refused');

    // Restoring the EXACT original description restores the candidate's inputs, so it is current again. The
    // fingerprint is over the inputs, not over the history of edits. A different description would refuse it.
    // The still-request read refuses the tampered draft (by design), so the revision comes from the draft itself.
    const draftRev = (await call('GET', `/api/factory/drafts/${ids.relDraft}`)).json.revision;
    expect(Number.isInteger(draftRev)).toBe(true);
    const restoreRes = await call('POST', `/api/factory/drafts/${ids.relDraft}/scenes/${ids.relImage}/still-prompt`, { expectedRevision: draftRev, visualDescription: PLAIN_BOOK_TEXT });
    expect(restoreRes.status, restoreRes.raw).toBe(200);
    const stillBind = await bindAsset(ids.relDraft, ids.relImage, assetId);
    expect(stillBind.status, stillBind.raw).toBe(200);
    await setPrompt(ids.relDraft, ids.relImage, PLAIN_BOOK_TEXT.replace('quiet empty room', 'quiet bare room'));
    const otherBind = await bindAsset(ids.relDraft, ids.relImage, assetId);
    expect(otherBind.status).toBe(409);
    expect(otherBind.json.reason).toBe('prompt_changed');
  });
});
