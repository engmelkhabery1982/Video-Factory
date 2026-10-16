/**
 * Local picture analysis, reviewed descriptions and reference-conditioned stills, through the REAL routes (app.inject).
 *
 * LABELLED TEST DOUBLES (every one, nothing else is faked):
 *  - the vision model is a LOOPBACK HTTP stub of llama-server (answers /health and /v1/chat/completions with fixed JSON).
 *    It proves the protocol and the server's decisions. It does not prove that a real model reads pictures correctly.
 *  - the local image runner is tests/fixtures/fake-sd-cli.mjs: it writes a real PNG and records its argv. It is NOT
 *    stable-diffusion.cpp. The IP-Adapter and CLIP-Vision files are fixture bytes with matching SHA-256 pins.
 *  - no provider is called. A provider request fails the test.
 * Evidence here is HTTP and fixture evidence. It is not owner-runtime evidence and not visual-quality evidence.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodeCrypto = process.getBuiltinModule('node:crypto') as typeof import('node:crypto');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'visual-review-'));
  const runner = nodePath.resolve('tests/fixtures/fake-sd-cli.mjs');
  nodeFs.chmodSync(runner, 0o755);
  const hash = (f: string) => nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(f)).digest('hex');
  const model = nodePath.join(root, 'FIXTURE-model.safetensors');
  const clip = nodePath.join(root, 'FIXTURE-clip_vision_h.safetensors');
  const ipa = nodePath.join(root, 'FIXTURE-ip-adapter_sd15.safetensors');
  nodeFs.writeFileSync(model, 'FIXTURE-WEIGHTS-NOT-A-MODEL');
  nodeFs.writeFileSync(clip, 'FIXTURE-CLIP-VISION-NOT-A-MODEL');
  nodeFs.writeFileSync(ipa, 'FIXTURE-IP-ADAPTER-NOT-A-MODEL');
  const vModel = nodePath.join(root, 'FIXTURE-vision.gguf');
  const vProj = nodePath.join(root, 'FIXTURE-mmproj.gguf');
  nodeFs.writeFileSync(vModel, 'FIXTURE-VISION-NOT-A-MODEL');
  nodeFs.writeFileSync(vProj, 'FIXTURE-PROJECTOR-NOT-A-MODEL');
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  process.env.VF_PREVIEW_DISABLE = '1';
  process.env.LOCAL_IMAGE_ENABLED = '1';
  process.env.LOCAL_IMAGE_RUNNER = runner;
  process.env.LOCAL_IMAGE_MODEL = model;
  process.env.LOCAL_IMAGE_MODEL_SHA256 = hash(model);
  process.env.LOCAL_IMAGE_ROOT = nodePath.join(root, 'local-images');
  process.env.LOCAL_IMAGE_STEPS = '4';
  process.env.LOCAL_IMAGE_CLIP_VISION = clip;
  process.env.LOCAL_IMAGE_CLIP_VISION_SHA256 = hash(clip);
  process.env.LOCAL_IMAGE_IP_ADAPTER = ipa;
  process.env.LOCAL_IMAGE_IP_ADAPTER_SHA256 = hash(ipa);
  process.env.FAKE_SD_ARGV_OUT = nodePath.join(root, 'sd-argv.json');
  process.env.VISION_ENABLED = '1';
  process.env.VISION_MODEL_PATH = vModel;
  process.env.VISION_MODEL_SHA256 = hash(vModel);
  process.env.VISION_PROJECTOR_PATH = vProj;
  process.env.VISION_PROJECTOR_SHA256 = hash(vProj);
  process.env.VISION_ROOT = nodePath.join(root, 'vision');
  return { root, hash };
});

import { buildServerApp } from '../apps/api/src/server.js';
import { observationVisualText, type VisionObservation } from '@buildtrack/core';
import { resetLocalImageWorkerForTests } from '../apps/api/src/services/local-image.js';
import { resetVisionForTests } from '../apps/api/src/services/local-vision.js';
import sharp from 'sharp';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;
let server: http.Server;

const OBS: VisionObservation = {
  subject: 'a brass desk lamp', environment: 'a wooden table', lighting: 'soft window light', composition: 'centred object',
  shot: 'close-up', exclude: '', containsText: false, containsLogoOrBrand: false, containsPeople: false, uncertainties: [],
};
const LOGO: VisionObservation = { ...OBS, subject: 'a shop sign', containsText: true, containsLogoOrBrand: true };
let answerMode: 'good' | 'logo' | 'invalid' = 'good';
/** LABELLED TEST DOUBLE: loopback stub of llama-server. */
const stub = (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === '/health') { res.writeHead(200); res.end('{}'); return; }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const content = answerMode === 'good' ? JSON.stringify(OBS) : answerMode === 'logo' ? JSON.stringify(LOGO) : 'not json at all';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  });
};

/** LABELLED TEST DOUBLE. Any provider call fails the test. */
const providerCalls = vi.hoisted(() => ({ n: 0 }));
const fetchDouble = vi.fn(async (url: string) => {
  providerCalls.n += 1;
  throw new Error(`TEST DOUBLE: a provider call was not expected: ${url}`);
});

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const res = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'content-type': 'application/json' } });
  let json: any = null;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.statusCode, json };
}

function multipart(fileName: string, content: Buffer, mime: string, fields: Record<string, string>) {
  const boundary = '----arenaVisual';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

async function upload(name: string, mime: string, bytes: Buffer): Promise<{ id: string; sha256: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/assets', ...multipart(name, bytes, mime, { name: name.replace(/\.[^.]+$/, ''), kind: 'screenshot', source: 'Visual review fixture (synthetic, generated by the test)', license: 'Synthetic fixture, test only' }) });
  if (res.statusCode !== 200) throw new Error(`fixture upload failed for ${name}: ${res.statusCode} ${res.body}`);
  return res.json().asset;
}

async function waitVision(id: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const r = await call('GET', `/api/vision/jobs/${id}`);
    if (!['queued', 'running'].includes(r.json.state)) return r.json;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('vision job did not finish');
}
async function waitLocal(id: string): Promise<any> {
  for (let i = 0; i < 1500; i++) {
    const r = await call('GET', `/api/local-images/jobs/${id}`);
    if (r.json.state !== 'queued' && r.json.state !== 'running') return r.json;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('local job did not finish');
}

const realFetch = globalThis.fetch;
const ids = { style: '', webp: '', draftId: '', sceneId: '', revision: 0, jobId: '' };
let styleSha = '';

beforeAll(async () => {
  server = http.createServer(stub);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.VISION_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('fetch', (input: any, init?: any) => {
    const u = String(input);
    // The loopback stub is a real server: the vision adapter's own call to it is allowed. Everything else is refused.
    if (u.startsWith('http://127.0.0.1:')) return realFetch(input, init);
    return fetchDouble(u);
  });
  app = await buildServerApp();
  await app.ready();
  const png = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#36a' } }).png().toBuffer();
  const style = await upload('style-lamp.png', 'image/png', png);
  ids.style = style.id;
  styleSha = crypto.createHash('sha256').update(png).digest('hex');
  // The WebP picture is uploaded later, in its own test, so the still tests see only the reference picture in the library.
  const webp = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#963' } }).webp().toBuffer();
  ids.webp = '';
  void webp;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  resetVisionForTests();
  resetLocalImageWorkerForTests();
  await app?.close();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('local picture analysis and reference conditioning (real routes; fixture runner and loopback vision stub)', () => {
  it('a script draft with a style reference: the reference is kept as a reference and the draft has a scene to illustrate', async () => {
    const created = await call('POST', '/api/factory/drafts', {
      contentProfile: 'educational', format: 'landscape', channelBrandId: null, requestedSpeakers: [], referenceProjectId: null, visualLanguage: null,
      inputs: { brief: '', script: 'Deliveries must be confirmed the night before. Confirm the time.', audioAssetId: null, visualAssetIds: [], storyboard: null, narrationMode: 'none' },
    });
    expect(created.status).toBe(201);
    ids.draftId = created.json.draftId;
    const patched = await call('PATCH', `/api/factory/drafts/${ids.draftId}/intake`, {
      expectedRevision: created.json.revision, visualAssetIds: [ids.style], visualRoles: { [ids.style]: 'style_reference' },
    });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    ids.revision = patched.json.revision;
    const list = await call('GET', `/api/factory/drafts/${ids.draftId}/shot-list`);
    // The draft's first scene. Library pictures are the existing automatic fallback for shots, so this scene may be
    // bound to a library picture rather than image_needed; the still route accepts any scene of this draft.
    const scene = list.json.scenes[0];
    expect(scene).toBeTruthy();
    ids.sceneId = scene.sceneId;
    expect(providerCalls.n).toBe(0);
  });

  it('a vision job analyses the picture (the stored hash is the picture hash); it is not used until reviewed', async () => {
    const started = await call('POST', '/api/vision/jobs', { assetId: ids.style });
    expect(started.status).toBe(202);
    const done = await waitVision(started.json.id);
    expect(done.state).toBe('succeeded');
    expect(done.sha256).toBe(styleSha);
    expect(done.observation.subject).toBe(OBS.subject);
    // No review yet: the still prompt does not carry the description.
    const req = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.sceneId}/still-request`);
    expect(req.json.prompt).not.toMatch(/reference \(reviewed\)/);
    expect(req.json.conditioning).toBeNull();
  });

  it('a reviewed description is refused when it is not labelled, and accepted once it is', async () => {
    const started = await call('POST', '/api/vision/jobs', { assetId: ids.style });
    const job = await waitVision(started.json.id);
    const bad = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, {
      expectedRevision: ids.revision,
      visualReview: { [ids.style]: { jobId: job.id, state: 'reviewed', text: 'just words with no labels', useInPrompts: true } },
    });
    expect(bad.status).toBe(422);
    const good = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, {
      expectedRevision: ids.revision,
      visualReview: { [ids.style]: { jobId: job.id, state: 'reviewed', text: observationVisualText(OBS), useInPrompts: true } },
    });
    expect(good.status, JSON.stringify(good.json)).toBe(200);
    ids.revision = good.json.revision;
    expect(good.json.intake.visualReview[ids.style].state).toBe('reviewed');
    expect(good.json.intake.visualReview[ids.style].sha256).toBe(styleSha);
  });

  it('manual notes are kept as typed; the reviewed description is separate from them', async () => {
    const note = await call('PATCH', `/api/factory/drafts/${ids.draftId}/intake`, { expectedRevision: ids.revision, visualNotes: { [ids.style]: 'Owner note: keep the blue wash.' } });
    expect(note.status).toBe(200);
    ids.revision = note.json.revision;
    const cond = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, { expectedRevision: ids.revision, conditioning: { assetId: ids.style, strength: 0.65 } });
    expect(cond.status).toBe(200);
    ids.revision = cond.json.revision;
    expect(cond.json.intake.visualNotes[ids.style]).toBe('Owner note: keep the blue wash.');
    expect(cond.json.intake.conditioning).toEqual({ assetId: ids.style, strength: 0.65 });
  });

  it('the still prompt carries the reviewed reference; the candidate identity is fingerprinted with the conditioning', async () => {
    const req = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.sceneId}/still-request`);
    expect(req.status).toBe(200);
    expect(req.json.prompt).toMatch(/reference \(reviewed\): a brass desk lamp/);
    expect(req.json.conditioning).toEqual({ assetId: ids.style, strength: 0.65 });
    expect(req.json.conditioningIssues).toEqual([]);
  });

  it('a generated still is conditioned on the picture ITSELF: the runner receives the copied picture, the adapter, the encoder and the strength', async () => {
    const started = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.sceneId, expectedRevision: ids.revision });
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    const done = await waitLocal(started.json.id);
    expect(done.state).toBe('succeeded');
    expect(done.conditioning).toMatchObject({ assetId: ids.style, sha256: styleSha, strength: 0.65, mimeType: 'image/png' });
    expect(done.provenance.conditioning.sha256).toBe(styleSha);
    const argv: string[] = JSON.parse(fs.readFileSync(process.env.FAKE_SD_ARGV_OUT!, 'utf8'));
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv).toEqual(expect.arrayContaining(['--clip_vision', '--ip-adapter', '--ip-adapter-image', '--ip-adapter-strength']));
    expect(after('--clip_vision')).toBe(process.env.LOCAL_IMAGE_CLIP_VISION);
    expect(after('--ip-adapter')).toBe(process.env.LOCAL_IMAGE_IP_ADAPTER);
    expect(after('--ip-adapter-strength')).toBe('0.65');
    // The image passed is the copy inside the job folder, and its bytes are the reference's bytes.
    const passed = after('--ip-adapter-image');
    expect(fs.existsSync(passed)).toBe(true);
    expect(tmp.hash(passed)).toBe(styleSha);
    // The text prompt also carries the description; the image is passed separately and is not only text.
    expect(argv).toContain('-p');
    ids.jobId = done.id;
  });

  it('a changed strength makes the earlier candidate stale: it cannot be approved, and a new candidate can be approved and bound', async () => {
    const changed = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, { expectedRevision: ids.revision, conditioning: { assetId: ids.style, strength: 0.5 } });
    expect(changed.status).toBe(200);
    ids.revision = changed.json.revision;
    const old = await call('GET', `/api/local-images/jobs/${ids.jobId}`);
    expect(old.json.candidate.current).toBe(false);
    const refused = await call('POST', `/api/local-images/jobs/${ids.jobId}/approve`);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('FACTORY_CANDIDATE_STALE');

    const started = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.sceneId, expectedRevision: ids.revision });
    expect(started.status).toBe(202);
    const done = await waitLocal(started.json.id);
    expect(done.state).toBe('succeeded');
    const approved = await call('POST', `/api/local-images/jobs/${done.id}/approve`);
    expect(approved.status).toBe(200);
    const bound = await call('POST', `/api/factory/drafts/${ids.draftId}/bind-image`, { expectedRevision: ids.revision, sceneId: ids.sceneId, assetId: approved.json.assetId });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    ids.revision = bound.json.revision;
  });

  it('a failed analysis does not change the earlier review, and the reviewed picture stays as it was', async () => {
    answerMode = 'invalid';
    const failed = await call('POST', '/api/vision/jobs', { assetId: ids.style });
    const job = await waitVision(failed.json.id);
    expect(job.state).toBe('failed');
    expect(job.error.code).toBe('VISION_OUTPUT_INVALID');
    answerMode = 'good';
    const d = await call('GET', `/api/factory/drafts/${ids.draftId}`);
    expect(d.json.intake.visualReview[ids.style].state).toBe('reviewed');
    expect(d.json.intake.conditioning).toEqual({ assetId: ids.style, strength: 0.5 });
  });

  it('a picture that has not been reviewed cannot condition stills; once reviewed for this exact picture it can', async () => {
    const created = await call('POST', '/api/factory/drafts', {
      contentProfile: 'educational', format: 'landscape', channelBrandId: null, requestedSpeakers: [], referenceProjectId: null, visualLanguage: null,
      inputs: { brief: '', script: 'A second short script about checking the time.', audioAssetId: null, visualAssetIds: [], storyboard: null, narrationMode: 'none' },
    });
    expect(created.status).toBe(201);
    const id = created.json.draftId;
    const p = await call('PATCH', `/api/factory/drafts/${id}/intake`, { expectedRevision: created.json.revision, visualAssetIds: [ids.style], visualRoles: { [ids.style]: 'style_reference' } });
    expect(p.status).toBe(200);
    const unreviewed = await call('POST', `/api/factory/drafts/${id}/visual-review`, { expectedRevision: p.json.revision, conditioning: { assetId: ids.style, strength: 0.5 } });
    expect(unreviewed.status).toBe(422);
    expect(unreviewed.json.error).toMatch(/Review this picture before it conditions stills/);
    // Review it, then the same setting is accepted.
    const started = await call('POST', '/api/vision/jobs', { assetId: ids.style });
    const job = await waitVision(started.json.id);
    const reviewed = await call('POST', `/api/factory/drafts/${id}/visual-review`, {
      expectedRevision: p.json.revision,
      visualReview: { [ids.style]: { jobId: job.id, state: 'reviewed', text: observationVisualText(OBS), useInPrompts: false } },
      conditioning: { assetId: ids.style, strength: 0.5 },
    });
    expect(reviewed.status, JSON.stringify(reviewed.json)).toBe(200);
    expect(reviewed.json.intake.conditioning).toEqual({ assetId: ids.style, strength: 0.5 });
  });

  it('a conditioning picture that is WebP is refused: the runner accepts PNG or JPEG only', async () => {
    ids.webp = (await upload('style-webp.webp', 'image/webp', await sharp({ create: { width: 16, height: 9, channels: 3, background: '#963' } }).webp().toBuffer())).id;
    const patched = await call('PATCH', `/api/factory/drafts/${ids.draftId}/intake`, {
      expectedRevision: ids.revision, visualAssetIds: [ids.style, ids.webp], visualRoles: { [ids.style]: 'style_reference', [ids.webp]: 'style_reference' },
    });
    expect(patched.status).toBe(200);
    ids.revision = patched.json.revision;
    const r = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, { expectedRevision: ids.revision, conditioning: { assetId: ids.webp, strength: 0.5 } });
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/PNG or JPEG/);
  });

  it('a religious draft: a picture that shows lettering or a brand cannot be reviewed for use, and nothing is saved', async () => {
    const created = await call('POST', '/api/factory/drafts', {
      contentProfile: 'religious', format: 'landscape', channelBrandId: null, requestedSpeakers: [], referenceProjectId: null, visualLanguage: null,
      inputs: { brief: '', script: 'A quiet reading about patience.', audioAssetId: null, visualAssetIds: [ids.style], storyboard: null, narrationMode: 'none' },
    });
    expect(created.status).toBe(201);
    const id = created.json.draftId;
    const p = await call('PATCH', `/api/factory/drafts/${id}/intake`, { expectedRevision: created.json.revision, visualAssetIds: [ids.style], visualRoles: { [ids.style]: 'style_reference' } });
    expect(p.status).toBe(200);
    answerMode = 'logo';
    const started = await call('POST', '/api/vision/jobs', { assetId: ids.style });
    const job = await waitVision(started.json.id);
    answerMode = 'good';
    expect(job.observation.containsLogoOrBrand).toBe(true);
    const refused = await call('POST', `/api/factory/drafts/${id}/visual-review`, {
      expectedRevision: p.json.revision,
      visualReview: { [ids.style]: { jobId: job.id, state: 'reviewed', text: observationVisualText(LOGO), useInPrompts: true } },
    });
    expect(refused.status).toBe(422);
    expect(refused.json.error).toMatch(/lettering or a brand/);
    const after = await call('GET', `/api/factory/drafts/${id}`);
    expect(after.json.intake.visualReview ?? {}).toEqual({});
    // Rejecting is allowed, and nothing is used in a prompt.
    const rejected = await call('POST', `/api/factory/drafts/${id}/visual-review`, {
      expectedRevision: p.json.revision,
      visualReview: { [ids.style]: { jobId: job.id, state: 'rejected', text: '', useInPrompts: false } },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.json.intake.visualReview[ids.style].state).toBe('rejected');
    // A rejected picture cannot condition a religious still either.
    const cond = await call('POST', `/api/factory/drafts/${id}/visual-review`, { expectedRevision: rejected.json.revision, conditioning: { assetId: ids.style, strength: 0.5 } });
    expect(cond.status).toBe(422);
    expect(cond.json.error).toMatch(/Review this picture before it conditions stills/);
  });

  it('a review for a picture that is not a reference, or from another picture, is refused with a reason', async () => {
    const started = await call('POST', '/api/vision/jobs', { assetId: ids.style });
    const job = await waitVision(started.json.id);
    const notRef = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, {
      expectedRevision: ids.revision,
      visualReview: { [ids.webp]: { jobId: job.id, state: 'reviewed', text: observationVisualText(OBS), useInPrompts: true } },
    });
    expect(notRef.status).toBe(422);
    const wrongPicture = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, {
      expectedRevision: ids.revision,
      visualReview: { [ids.style]: { jobId: 'lvj_0123456789abcdef', state: 'reviewed', text: observationVisualText(OBS), useInPrompts: true } },
    });
    expect(wrongPicture.status).toBe(422);
  });

  it('a stale revision is refused and nothing is saved', async () => {
    const r = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, { expectedRevision: 0, conditioning: null });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('FACTORY_REVISION_CONFLICT');
  });

  it('save and reopen: the settings and the review are on the draft, read again from the stored record', async () => {
    const reopened = await call('GET', `/api/factory/drafts/${ids.draftId}`);
    expect(reopened.json.intake.conditioning).toEqual({ assetId: ids.style, strength: 0.5 });
    expect(reopened.json.intake.visualReview[ids.style].state).toBe('reviewed');
    expect(reopened.json.intake.visualNotes[ids.style]).toBe('Owner note: keep the blue wash.');
    expect(providerCalls.n).toBe(0);
  });
});
