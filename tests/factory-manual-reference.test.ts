/**
 * Manual approval of a reference picture, and conditioning readiness that does NOT depend on AI picture analysis.
 * Real routes (app.inject). The vision URL points at a closed port, so no vision server is running:
 * this proves conditioning readiness and vision readiness are independent.
 *
 * LABELLED TEST DOUBLES:
 *  - the local image runner is tests/fixtures/fake-sd-cli.mjs (writes a real PNG and records its argv). It is NOT
 *    stable-diffusion.cpp. Evidence here is HTTP and fixture evidence only.
 *  - no provider is called. A non-loopback fetch fails the test.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodeCrypto = process.getBuiltinModule('node:crypto') as typeof import('node:crypto');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'manual-reference-'));
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
  // A closed port: no vision server is running. Conditioning must not need one.
  process.env.VISION_URL = 'http://127.0.0.1:9';
  return { root, hash };
});

import { buildServerApp } from '../apps/api/src/server.js';
import { resetLocalImageWorkerForTests } from '../apps/api/src/services/local-image.js';
import { resetVisionForTests } from '../apps/api/src/services/local-vision.js';
import sharp from 'sharp';
import { observationVisualText } from '@buildtrack/core';
import { ASSETS_DIR } from '../apps/api/src/services/platform.js';
import { loadAssetIndex, saveAssetIndex } from '../apps/api/src/routes/assets.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

const realFetch = globalThis.fetch;
const providerCalls = vi.hoisted(() => ({ n: 0 }));

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const res = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'content-type': 'application/json' } });
  let json: any = null;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.statusCode, json };
}

function multipart(fileName: string, content: Buffer, mime: string, fields: Record<string, string>) {
  const boundary = '----arenaManual';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

async function waitLocal(id: string): Promise<any> {
  for (let i = 0; i < 1500; i++) {
    const r = await call('GET', `/api/local-images/jobs/${id}`);
    if (r.json.state !== 'queued' && r.json.state !== 'running') return r.json;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('local job did not finish');
}

const PICTURE_SOURCE = 'Owner test photograph (synthetic fixture, generated by the test)';
const PICTURE_LICENSE = 'Synthetic fixture, test only';
const OWNER_DESCRIPTION = {
  subject: 'a brass desk lamp', environment: 'a wooden table', lighting: 'soft window light', composition: 'centred object',
  shot: 'close-up', exclude: '', containsText: false, containsLogoOrBrand: false, containsPeople: false, uncertainties: [],
};
/** The owner's typed description, in the labelled format the validator requires. */
const DESCRIPTION = observationVisualText(OWNER_DESCRIPTION);
const NO_FLAGS = { containsText: false, containsLogoOrBrand: false, containsPeople: false };
const ids = { picture: '', sha: '', draftId: '', sceneId: '', revision: 0, jobId: '' };

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: any, init?: any) => {
    const u = String(input);
    if (u.startsWith('http://127.0.0.1:')) return realFetch(input, init);
    providerCalls.n += 1;
    throw new Error(`TEST DOUBLE: a provider call was not expected: ${u}`);
  });
  app = await buildServerApp();
  await app.ready();
  const png = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#4a7' } }).png().toBuffer();
  const res = await app.inject({
    method: 'POST', url: '/api/assets',
    ...multipart('manual-lamp.png', png, 'image/png', { name: 'manual-lamp', kind: 'screenshot', source: PICTURE_SOURCE, license: PICTURE_LICENSE }),
  });
  expect(res.statusCode, res.body).toBe(200);
  ids.picture = res.json().asset.id;
  ids.sha = crypto.createHash('sha256').update(png).digest('hex');
});

afterAll(async () => {
  vi.unstubAllGlobals();
  resetVisionForTests();
  resetLocalImageWorkerForTests();
  await app?.close();
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('manual reference approval and conditioning readiness (real routes; no vision server running)', () => {
  it('a script draft with the picture as a style reference, and no vision server reachable', async () => {
    const created = await call('POST', '/api/factory/drafts', {
      contentProfile: 'educational', format: 'landscape', channelBrandId: null, requestedSpeakers: [], referenceProjectId: null, visualLanguage: null,
      inputs: { brief: '', script: 'Deliveries must be confirmed the night before. Confirm the time.', audioAssetId: null, visualAssetIds: [], storyboard: null, narrationMode: 'none' },
    });
    expect(created.status).toBe(201);
    ids.draftId = created.json.draftId;
    const patched = await call('PATCH', `/api/factory/drafts/${ids.draftId}/intake`, {
      expectedRevision: created.json.revision, visualAssetIds: [ids.picture], visualRoles: { [ids.picture]: 'style_reference' },
    });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    ids.revision = patched.json.revision;
    const list = await call('GET', `/api/factory/drafts/${ids.draftId}/shot-list`);
    ids.sceneId = list.json.scenes[0].sceneId;
    // Vision is independent: its status is not ready, and it is not needed below.
    const vision = await call('GET', '/api/vision/status');
    expect(vision.status).toBe(200);
    expect(vision.json.state ?? vision.json.status ?? 'unavailable').not.toBe('ready');
    expect(providerCalls.n).toBe(0);
  });

  it('conditioning is refused before any review, and the refusal names manual approval as a way forward', async () => {
    const r = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, { expectedRevision: ids.revision, conditioning: { assetId: ids.picture, strength: 0.6 } });
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/approve it manually/);
  });

  it('a manual approval is refused when the source or licence is not exactly as the library records it', async () => {
    const wrong = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, {
      expectedRevision: ids.revision,
      visualReview: { [ids.picture]: { method: 'manual', state: 'reviewed', text: DESCRIPTION, useInPrompts: true, sha256: ids.sha, flags: NO_FLAGS, source: 'someone else', license: PICTURE_LICENSE } },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.json.error).toMatch(/source and licence exactly/);
    const wrongLicence = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, {
      expectedRevision: ids.revision,
      visualReview: { [ids.picture]: { method: 'manual', state: 'reviewed', text: DESCRIPTION, useInPrompts: true, sha256: ids.sha, flags: NO_FLAGS, source: PICTURE_SOURCE, license: 'Other licence' } },
    });
    expect(wrongLicence.status).toBe(422);
  });

  it('a manual approval is refused when the bytes the owner checked are not the current bytes', async () => {
    const stale = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, {
      expectedRevision: ids.revision,
      visualReview: { [ids.picture]: { method: 'manual', state: 'reviewed', text: DESCRIPTION, useInPrompts: true, sha256: '0'.repeat(64), flags: NO_FLAGS, source: PICTURE_SOURCE, license: PICTURE_LICENSE } },
    });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.json)).toMatch(/FACTORY_CANDIDATE_STALE/);
  });

  it('a manual approval must declare its flags explicitly', async () => {
    const r = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, {
      expectedRevision: ids.revision,
      visualReview: { [ids.picture]: { method: 'manual', state: 'reviewed', text: DESCRIPTION, useInPrompts: true, sha256: ids.sha, source: PICTURE_SOURCE, license: PICTURE_LICENSE } },
    });
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/Declare whether/);
  });

  it('an analysis-less record without the manual method is still refused (no silent manual path)', async () => {
    const r = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, {
      expectedRevision: ids.revision,
      visualReview: { [ids.picture]: { jobId: '', state: 'reviewed', text: DESCRIPTION, useInPrompts: true } },
    });
    expect(r.status).toBe(422);
  });

  it('a correct manual approval is saved as manual, with its source, licence, hash and flags', async () => {
    const r = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, {
      expectedRevision: ids.revision,
      visualReview: { [ids.picture]: { method: 'manual', state: 'reviewed', text: DESCRIPTION, useInPrompts: true, sha256: ids.sha, flags: NO_FLAGS, source: PICTURE_SOURCE, license: PICTURE_LICENSE } },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    ids.revision = r.json.revision;
    const rec = r.json.intake.visualReview[ids.picture];
    expect(rec).toMatchObject({ method: 'manual', jobId: '', state: 'reviewed', sha256: ids.sha, source: PICTURE_SOURCE, license: PICTURE_LICENSE });
    expect(rec.flags).toEqual(NO_FLAGS);
  });

  it('conditioning is accepted on the manual approval, with no vision job and no vision server', async () => {
    const r = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, { expectedRevision: ids.revision, conditioning: { assetId: ids.picture, strength: 0.6 } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    ids.revision = r.json.revision;
    expect(r.json.intake.conditioning).toEqual({ assetId: ids.picture, strength: 0.6 });
    const req = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.sceneId}/still-request`);
    expect(req.status).toBe(200);
    expect(req.json.prompt).toMatch(/reference \(reviewed\): a brass desk lamp/);
    expect(req.json.conditioning).toEqual({ assetId: ids.picture, strength: 0.6 });
    expect(req.json.conditioningIssues).toEqual([]);
  });

  it('a local still conditioned on the manual approval receives the picture bytes and the strength at the runner', async () => {
    const started = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.sceneId, expectedRevision: ids.revision });
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    const done = await waitLocal(started.json.id);
    expect(done.state).toBe('succeeded');
    expect(done.conditioning).toMatchObject({ assetId: ids.picture, sha256: ids.sha, strength: 0.6 });
    ids.jobId = done.id;
    const argv: string[] = JSON.parse(fs.readFileSync(process.env.FAKE_SD_ARGV_OUT!, 'utf8'));
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(after('--ip-adapter-strength')).toBe('0.60');
    expect(tmp.hash(after('--ip-adapter-image'))).toBe(ids.sha);
    expect(providerCalls.n).toBe(0);
  });

  it('changing the strength invalidates the candidate: the earlier job is stale and cannot be approved', async () => {
    const r = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, { expectedRevision: ids.revision, conditioning: { assetId: ids.picture, strength: 0.8 } });
    expect(r.status).toBe(200);
    ids.revision = r.json.revision;
    const req = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.sceneId}/still-request`);
    expect(req.json.conditioning).toEqual({ assetId: ids.picture, strength: 0.8 });
    // The candidate made at 0.60 no longer matches its settings, so approval refuses it.
    const approve = await call('POST', `/api/local-images/jobs/${ids.jobId}/approve`);
    expect(approve.status).toBe(409);
    expect(JSON.stringify(approve.json)).toMatch(/FACTORY_CANDIDATE_STALE/);
  });
});

describe('owner review integrity on actual library bytes (real routes)', () => {
  it('changed bytes with an unchanged index stale a candidate and refuse reusing the old manual approval', async () => {
    const start = await call('POST', '/api/local-images/jobs', { draftId: ids.draftId, sceneId: ids.sceneId, expectedRevision: ids.revision });
    expect(start.status).toBe(202);
    const job = await waitLocal(start.json.id);
    expect((await call('GET', `/api/local-images/jobs/${job.id}`)).json.candidate.current).toBe(true);
    const asset = loadAssetIndex().find(a => a.id === ids.picture)!;
    const file = path.join(ASSETS_DIR, path.basename(asset.path));
    const original = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, Buffer.concat([original, Buffer.from('changed bytes')]));
      expect((await call('GET', `/api/local-images/jobs/${job.id}`)).json.candidate.current).toBe(false);
      const r = await call('POST', `/api/factory/drafts/${ids.draftId}/visual-review`, {
        expectedRevision: ids.revision,
        visualReview: { [ids.picture]: { method: 'manual', state: 'reviewed', text: DESCRIPTION, useInPrompts: true, sha256: ids.sha, flags: NO_FLAGS, source: PICTURE_SOURCE, license: PICTURE_LICENSE } },
      });
      expect(r.status).toBe(409);
      expect(r.json.code).toBe('FACTORY_CANDIDATE_STALE');
    } finally { fs.writeFileSync(file, original); }
  });

  it('a changed library licence invalidates the existing conditioning review without another review save', async () => {
    const index = loadAssetIndex();
    try {
      saveAssetIndex(index.map(a => a.id === ids.picture ? { ...a, license: 'changed licence' } : a));
      const r = await call('GET', `/api/factory/drafts/${ids.draftId}/scenes/${ids.sceneId}/still-request`);
      expect(r.json.conditioningIssues.join(' ')).toMatch(/licence changed/);
    } finally { saveAssetIndex(index); }
  });
});

describe('manual approval and religious restrictions (real routes)', () => {
  it('a religious draft: a manual approval that declares lettering or a brand is refused and nothing is saved', async () => {
    const created = await call('POST', '/api/factory/drafts', {
      contentProfile: 'religious', format: 'landscape', channelBrandId: null, requestedSpeakers: [], referenceProjectId: null, visualLanguage: null,
      inputs: { brief: '', script: 'A quiet reading about patience.', audioAssetId: null, visualAssetIds: [ids.picture], storyboard: null, narrationMode: 'none' },
    });
    expect(created.status).toBe(201);
    const id = created.json.draftId;
    const p = await call('PATCH', `/api/factory/drafts/${id}/intake`, { expectedRevision: created.json.revision, visualAssetIds: [ids.picture], visualRoles: { [ids.picture]: 'style_reference' } });
    expect(p.status).toBe(200);
    const refused = await call('POST', `/api/factory/drafts/${id}/visual-review`, {
      expectedRevision: p.json.revision,
      visualReview: { [ids.picture]: { method: 'manual', state: 'reviewed', text: DESCRIPTION, useInPrompts: true, sha256: ids.sha, flags: { containsText: true, containsLogoOrBrand: true, containsPeople: false }, source: PICTURE_SOURCE, license: PICTURE_LICENSE } },
    });
    expect(refused.status).toBe(422);
    const after = await call('GET', `/api/factory/drafts/${id}`);
    expect(after.json.intake.visualReview ?? {}).toEqual({});
  });
});
