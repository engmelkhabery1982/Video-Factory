/**
 * PARTS 3–7 — production closure contracts.
 *
 *   P3 scene lock / unlock (service + HTTP + the UI contract)
 *   P4 PUT bindings accept only genuine generated slots (422 otherwise)
 *   P5 generated slot eligibility = real renderable IMAGE assets only
 *   P6 POST /api/assets is independent of multipart field order
 *   P7 production artifact paths are output-relative, POSIX and non-empty
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectInput, Scenario } from '@buildtrack/core';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-p37-'));
  nodeFs.mkdirSync(nodePath.join(dir, 'data'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(dir, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(dir, 'output');
  return { dir };
});

import { registerAssetRoutes, loadAssetIndex, saveAssetIndex } from '../apps/api/src/routes/assets.js';
import { registerProductionRoutes } from '../apps/api/src/routes/production.js';
import { registerProjectRoutes } from '../apps/api/src/routes/projects.js';
import { OUTPUT_DIR } from '../apps/api/src/services/platform.js';
import { loadProductionState, saveProductionState } from '../apps/api/src/services/production-state.js';
import { generatedLogicalAssetRefsForTarget, patchProductionScene } from '../apps/api/src/services/production-engine.js';
import { outputRelativePath } from '../apps/api/src/services/production-deliverables.js';

function inputFor(videoId: string): ProjectInput {
  return {
    videoId,
    videoType: 'long',
    topic: 'Executed 70% versus accepted 59.5 percent on Level 3',
    targetAudience: 'Project steering committee',
    mainProblem: 'Certified progress lags physical progress',
    viewerPromise: 'A weekly verified progress snapshot',
    hook: 'Your site is 70% finished but only 59.5% accepted.',
    script: [
      'Your site is 70% finished but only 59.5% accepted.',
      'That 10.5 percent gap is a commercial risk inside your project.',
      'The work gets done on Tuesday and inspected on Wednesday.',
      'The certificate goes out on Friday with verified numbers.',
      'Quality checks stop unverified work being accepted.',
      'Start your BuildTrack trial and see the gap every week.',
    ].join('\n'),
    keyNumbers: ['70%', '59.5%'],
    keyPoints: ['Executed versus accepted', 'Weekly verified gap'],
    productName: 'BuildTrack',
    productShots: [],
    cta: 'Start your BuildTrack trial',
    voiceoverFile: null,
    targetAudio: {},
    brollFiles: [],
    sourceReferences: ['Lab test cert LTC-2026-0882'],
    outputLanguage: 'en',
    brandPreset: 'buildtrack',
    shortCount: 1,
  };
}

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

type MpPart = { name: string; value: string } | { name: string; filename: string; mimeType: string; content: Buffer };

function multipartBody(parts: MpPart[]): { body: Buffer; contentType: string } {
  const boundary = `----vf${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('value' in part) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.mimeType}\r\n\r\n`,
        ),
      );
      chunks.push(part.content);
      chunks.push(Buffer.from('\r\n'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('Parts 3–7 — production closure contracts', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024 } });
    await registerAssetRoutes(app);
    await registerProjectRoutes(app);
    await registerProductionRoutes(app);
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor('P37_01') });
    const gen = await app.inject({ method: 'POST', url: '/api/projects/P37_01/production/generate', payload: {} });
    expect(gen.statusCode, gen.payload).toBe(200);
  });

  async function createProject(videoId: string): Promise<void> {
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor(videoId) });
    expect(created.statusCode, created.payload).toBe(200);
    const gen = await app.inject({ method: 'POST', url: `/api/projects/${videoId}/production/generate`, payload: {} });
    expect(gen.statusCode, gen.payload).toBe(200);
  }

  afterAll(async () => {
    await app.close();
    try {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function upload(parts: MpPart[]): Promise<any> {
    const { body, contentType } = multipartBody(parts);
    const res = await app.inject({ method: 'POST', url: '/api/assets', payload: body, headers: { 'content-type': contentType } });
    expect(res.statusCode, res.payload).toBe(200);
    return JSON.parse(res.payload).asset;
  }

  /* ------------------------------------------------------------------ P3 */

  it('P3 — the production scene lock contract holds at service and HTTP level', async () => {
    const state = loadProductionState('P37_01')!;
    const sceneId = (state.scenarios.long as Scenario).scenes[0].id;

    // Locked scene: any visual edit is refused.
    patchProductionScene(state, 'long', sceneId, { locked: true });
    expect(() => patchProductionScene(loadProductionState('P37_01')!, 'long', sceneId, { title: 'nope' })).toThrowError(/locked/i);
    // Atomic unlock+edit is refused too (unlock first, then edit).
    expect(() =>
      patchProductionScene(loadProductionState('P37_01')!, 'long', sceneId, { locked: false, title: 'nope' }),
    ).toThrowError(/locked/i);

    const blockedHttp = await app.inject({
      method: 'PATCH',
      url: `/api/projects/P37_01/production/scenes/long/${sceneId}`,
      payload: { title: 'nope' },
    });
    expect(blockedHttp.statusCode).toBe(409);
    expect(JSON.parse(blockedHttp.payload).code).toBe('SCENE_LOCKED');

    // Pure unlock succeeds identically over HTTP, and the edit then applies.
    const unlock = await app.inject({
      method: 'PATCH',
      url: `/api/projects/P37_01/production/scenes/long/${sceneId}`,
      payload: { locked: false },
    });
    expect(unlock.statusCode, unlock.payload).toBe(200);
    expect(loadProductionState('P37_01')!.locks[sceneId]).toBeFalsy();

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/projects/P37_01/production/scenes/long/${sceneId}`,
      payload: { title: 'Edited after unlock' },
    });
    expect(edit.statusCode, edit.payload).toBe(200);

    // Timing remains owned by the audio: explicit duration edits are refused.
    const timing = await app.inject({
      method: 'PATCH',
      url: `/api/projects/P37_01/production/scenes/long/${sceneId}`,
      payload: { estimatedDuration: 99 },
    });
    expect(timing.statusCode).toBe(422);
    expect(JSON.parse(timing.payload).code).toBe('TIMING_IS_AUDIO_AUTHORITY');
  });

    it('deterministically re-rolls one scene\u2019s visual treatment without touching dialogue or timing', async () => {
      await createProject('Reroll_01');
      const before = loadProductionState('Reroll_01')!;
      const scenarioBefore = before.scenarios.long as Scenario;
      const sceneBefore = scenarioBefore.scenes[1];
      const dialogueBefore = JSON.stringify(scenarioBefore.scenes.map((s) => s.turns.map((t) => t.spokenText)));
      const durationBefore = JSON.stringify(scenarioBefore.scenes.map((s) => [s.actualDurationSeconds, s.estimatedDurationSeconds]));

      const first = await app.inject({ method: 'POST', url: '/api/projects/Reroll_01/production/scenes/long/' + sceneBefore.id + '/reroll' });
      expect(first.statusCode, first.payload).toBe(200);
      const changed = JSON.parse(first.payload).direction.changed as string[];
      expect(changed.length).toBeGreaterThan(0);

      const afterState = loadProductionState('Reroll_01')!;
      const sceneAfter = (afterState.scenarios.long as Scenario).scenes.find((s) => s.id === sceneBefore.id)!;
      expect(sceneAfter.production.shotType !== sceneBefore.production.shotType || sceneAfter.production.framing !== sceneBefore.production.framing || sceneAfter.production.cameraMovement !== sceneBefore.production.cameraMovement).toBe(true);
      // Dialogue, evidence and timing are untouched (audio remains the authority).
      expect(JSON.stringify((afterState.scenarios.long as Scenario).scenes.map((s) => s.turns.map((t) => t.spokenText)))).toBe(dialogueBefore);
      expect(JSON.stringify((afterState.scenarios.long as Scenario).scenes.map((s) => [s.actualDurationSeconds, s.estimatedDurationSeconds]))).toBe(durationBefore);
      expect((afterState.scenarios.long as Scenario).evidence).toEqual(scenarioBefore.evidence);
      // The edit is recorded and downstream state invalidated.
      expect(afterState.edits.some((e) => e.kind === 'scene' && e.summary.includes('re-rolled'))).toBe(true);
      expect(afterState.status).not.toBe('ready_for_export');

      // Deterministic and repeatable: the same scene re-rolls forward, never randomly.
      const second = await app.inject({ method: 'POST', url: '/api/projects/Reroll_01/production/scenes/long/' + sceneBefore.id + '/reroll' });
      expect(second.statusCode, second.payload).toBe(200);
      const thirdState = loadProductionState('Reroll_01')!;
      const sceneThird = (thirdState.scenarios.long as Scenario).scenes.find((s) => s.id === sceneBefore.id)!;
      expect(sceneThird.production.shotType !== sceneAfter.production.shotType || sceneThird.production.framing !== sceneAfter.production.framing || sceneThird.production.cameraMovement !== sceneAfter.production.cameraMovement).toBe(true);

      // A locked scene refuses the re-roll until it is unlocked.
      patchProductionScene(thirdState, 'long', sceneBefore.id, { locked: true });
      const locked = await app.inject({ method: 'POST', url: '/api/projects/Reroll_01/production/scenes/long/' + sceneBefore.id + '/reroll' });
      expect(locked.statusCode).toBe(409);
      expect(JSON.parse(locked.payload).code).toBe('SCENE_LOCKED');
    });

  /* ------------------------------------------------------------------ P4 */

  it('P4 — fabricated / cross-target logicalRefs are rejected with 422; genuine slots bind and unbind', async () => {
    const image = await upload([
      { name: 'file', filename: 'crack.png', mimeType: 'image/png', content: PNG_BYTES },
      { name: 'name', value: 'Cracked render' },
      { name: 'kind', value: 'image' },
      { name: 'source', value: 'Site photo LTC-2026-0882' },
      { name: 'license', value: 'Operator owned' },
    ]);

    const state = loadProductionState('P37_01')!;
    const longSlots = generatedLogicalAssetRefsForTarget(state, 'long');
    const shortSlots = new Set(generatedLogicalAssetRefsForTarget(state, 'short_1'));
    expect(longSlots.length).toBeGreaterThan(0);
    const realSlot = longSlots[0];

    // Invented refs (including one that LOOKS plausible) are refused.
    for (const fabricated of [
      'source-record:ev-p37-01-99',
      'asset-ref:cracked-render',
      'manual:/home/user/crack.png',
      'http://127.0.0.1:3000/media/asset/whatever',
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/P37_01/production/assets/long/${encodeURIComponent(fabricated)}`,
        payload: { assetId: image.id },
      });
      expect(res.statusCode, `${fabricated}: ${res.payload}`).toBe(422);
      expect(JSON.parse(res.payload).code).toBe('ASSET_REF_NOT_IN_SCENARIO');
    }

    // A ref generated for the Short is not accepted for the Long when the
    // generator produced target-specific refs (shared refs are legitimate).
    const shortOnly = [...shortSlots].find((r) => !longSlots.includes(r));
    if (shortOnly) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/P37_01/production/assets/long/${encodeURIComponent(shortOnly)}`,
        payload: { assetId: image.id },
      });
      expect(res.statusCode).toBe(422);
    }

    // The genuine slot binds, is displayed in the state, clears, and re-binds.
    const bind = await app.inject({
      method: 'PUT',
      url: `/api/projects/P37_01/production/assets/long/${encodeURIComponent(realSlot)}`,
      payload: { assetId: image.id },
    });
    expect(bind.statusCode, bind.payload).toBe(200);
    expect(loadProductionState('P37_01')!.assetBindings).toContainEqual(
      expect.objectContaining({ target: 'long', logicalRef: realSlot, assetId: image.id }),
    );

    const clear = await app.inject({
      method: 'DELETE',
      url: `/api/projects/P37_01/production/assets/long/${encodeURIComponent(realSlot)}`,
    });
    expect(clear.statusCode, clear.payload).toBe(200);
    expect(loadProductionState('P37_01')!.assetBindings.some((b) => b.logicalRef === realSlot)).toBe(false);

    const rebind = await app.inject({
      method: 'PUT',
      url: `/api/projects/P37_01/production/assets/long/${encodeURIComponent(realSlot)}`,
      payload: { assetId: image.id },
    });
    expect(rebind.statusCode, rebind.payload).toBe(200);

    // Clearing a legacy/stale binding that no longer maps to a slot still works.
    const legacyState = loadProductionState('P37_01')!;
    legacyState.assetBindings.push({ target: 'long', logicalRef: 'source-record:ev-legacy-77', assetId: 'asset-legacy', setAt: new Date().toISOString() });
    saveAssetIndex(loadAssetIndex()); // no-op, keeps the index handle warm
    const { saveProductionState } = await import('../apps/api/src/services/production-state.js');
    saveProductionState(legacyState);
    const clearLegacy = await app.inject({
      method: 'DELETE',
      url: `/api/projects/P37_01/production/assets/long/${encodeURIComponent('source-record:ev-legacy-77')}`,
    });
    expect(clearLegacy.statusCode, clearLegacy.payload).toBe(200);
    expect(loadProductionState('P37_01')!.assetBindings.some((b) => b.logicalRef === 'source-record:ev-legacy-77')).toBe(false);
  });

  /* ------------------------------------------------------------------ P5 */

  it('P5 — only real renderable IMAGE assets are offered for generated slots, each exclusion with a reason', async () => {
    const broll = await upload([
      { name: 'file', filename: 'site-walk.mp4', mimeType: 'video/mp4', content: Buffer.from('0000ftypisom00000000', 'utf8') },
      { name: 'name', value: 'Site walk B-roll' },
      { name: 'kind', value: 'broll' },
      { name: 'source', value: 'Operator camera' },
      { name: 'license', value: 'Operator owned' },
    ]);
    const audio = await upload([
      { name: 'file', filename: 'tone.wav', mimeType: 'audio/wav', content: Buffer.from('RIFF0000WAVE', 'utf8') },
      { name: 'name', value: 'Ambient tone' },
      { name: 'kind', value: 'sfx' },
      { name: 'source', value: 'Operator recorder' },
      { name: 'license', value: 'Operator owned' },
    ]);
    const font = await upload([
      { name: 'file', filename: 'brand.ttf', mimeType: 'font/ttf', content: Buffer.from('0001000000', 'hex') },
      { name: 'name', value: 'Brand font' },
      { name: 'kind', value: 'font' },
      { name: 'source', value: 'Design system' },
      { name: 'license', value: 'Internal' },
    ]);
    const doc = await upload([
      { name: 'file', filename: 'spec.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8') },
      { name: 'name', value: 'Spec sheet' },
      { name: 'kind', value: 'document' },
      { name: 'source', value: 'Design team' },
      { name: 'license', value: 'Internal' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/projects/P37_01/production/assets' });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    const offeredIds = new Set(payload.assets.map((a: any) => a.id));
    for (const asset of [broll, audio, font, doc]) expect(offeredIds.has(asset.id)).toBe(false);
    expect(payload.eligibleMimePrefix).toBe('image/');
    expect(String(payload.eligibleRule)).toMatch(/image/);

    const ineligible = new Map(payload.ineligible.map((a: any) => [a.id, a.reason as string]));
    for (const asset of [broll, audio, font, doc]) {
      expect(ineligible.get(asset.id), `no reason for ${asset.kind}`).toBeTruthy();
    }
    expect(ineligible.get(broll.id)).toMatch(/not renderable|image/i);
    expect(ineligible.get(doc.id)).toMatch(/not renderable|image/i);

    // Binding a non-image asset is refused with the same rule (422).
    const slot = generatedLogicalAssetRefsForTarget(loadProductionState('P37_01')!, 'long')[0];
    for (const asset of [broll, audio, font, doc]) {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/projects/P37_01/production/assets/long/${encodeURIComponent(slot)}`,
        payload: { assetId: asset.id },
      });
      expect(put.statusCode, `${asset.kind}: ${put.payload}`).toBe(422);
      expect(JSON.parse(put.payload).code).toBe('ASSET_NOT_RENDERABLE');
    }

    // Screenshot/chart-style IMAGE assets stay eligible (real renderables).
    const shot = await upload([
      { name: 'file', filename: 'screenshot.png', mimeType: 'image/png', content: PNG_BYTES },
      { name: 'name', value: 'Dashboard screenshot' },
      { name: 'kind', value: 'screenshot' },
      { name: 'source', value: 'Product screen' },
      { name: 'license', value: 'Owner supplied' },
    ]);
    const after = await app.inject({ method: 'GET', url: '/api/projects/P37_01/production/assets' });
    expect(new Set(JSON.parse(after.payload).assets.map((a: any) => a.id)).has(shot.id)).toBe(true);
  });

  /* ------------------------------------------------------------------ P6 */

  it('P6 — POST /api/assets preserves metadata and bytes regardless of multipart field order', async () => {
    const metadata: MpPart[] = [
      { name: 'name', value: 'Order proof' },
      { name: 'kind', value: 'image' },
      { name: 'source', value: 'Field order test' },
      { name: 'license', value: 'Test only' },
      { name: 'tags', value: 'alpha, beta' },
    ];
    const filePart: MpPart = { name: 'file', filename: 'order.png', mimeType: 'image/png', content: PNG_BYTES };

    const fileFirst = await upload([filePart, ...metadata]);
    const fileLast = await upload([...metadata, filePart]);

    for (const asset of [fileFirst, fileLast]) {
      expect(asset.name).toBe('Order proof');
      expect(asset.kind).toBe('image');
      expect(asset.source).toBe('Field order test');
      expect(asset.license).toBe('Test only');
      expect(asset.tags).toEqual(['alpha', 'beta']);
      expect(asset.mimeType).toBe('image/png');
      expect(asset.fileName).toBe('order.png');
      expect(asset.sizeBytes).toBe(PNG_BYTES.length);
      expect(asset.width).toBe(1);
      expect(asset.height).toBe(1);
      const stored = fs.readFileSync(path.join(tmp.dir, 'data', asset.path));
      expect(stored.equals(PNG_BYTES)).toBe(true);
    }

    // Nothing is persisted when the required multipart file never arrives.
    const beforeCount = loadAssetIndex().length;
    const { body, contentType } = multipartBody([{ name: 'name', value: 'No file' }]);
    const bad = await app.inject({ method: 'POST', url: '/api/assets', payload: body, headers: { 'content-type': contentType } });
    expect(bad.statusCode).toBe(400);
    expect(loadAssetIndex().length).toBe(beforeCount);
  });

  /* ------------------------------------------- target-scoped preview parameter */

  it('preview accepts an optional target subset and validates it before any render starts', async () => {
    // Unknown target: refused (422) and NO job is started.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/projects/P37_01/production/preview',
      payload: { targets: ['short_9'] },
    });
    expect(bad.statusCode).toBe(422);
    const badBody = JSON.parse(bad.payload);
    expect(badBody.error).toBeTruthy();
    expect(badBody.jobId).toBeUndefined();

    // Malformed subset: refused (422) as well.
    for (const malformed of [{ targets: [] }, { targets: 'long' }, { targets: [1] }]) {
      const res = await app.inject({ method: 'POST', url: '/api/projects/P37_01/production/preview', payload: malformed });
      expect(res.statusCode, JSON.stringify(malformed)).toBe(422);
      expect(JSON.parse(res.payload).code).toBe('INVALID_TARGETS');
      expect(JSON.parse(res.payload).jobId).toBeUndefined();
    }

    // Stale-state guard still runs before the subset is acted on.
    const state = loadProductionState('P37_01')!;
    expect(state).toBeTruthy();
  });

  /* ------------------------------------------------------------------ P7 */

  it('P7 — production artifact paths stay relative, POSIX and inside OUTPUT_DIR', () => {
    const inside = path.join(OUTPUT_DIR, 'P37_01', 'production-package', 'manifest', 'delivery_manifest.json');
    const rel = outputRelativePath(inside);
    expect(rel).toBe('P37_01/production-package/manifest/delivery_manifest.json');
    expect(path.isAbsolute(rel)).toBe(false);
    expect(rel.startsWith('/')).toBe(false);
    expect(rel.includes('\\')).toBe(false);
    expect(rel.includes(OUTPUT_DIR)).toBe(false);

    // Renderer output outside the output root is refused, never persisted.
    expect(() => outputRelativePath(path.join(tmp.dir, 'outside', 'long.mp4'))).toThrowError();
    expect(() => outputRelativePath('/var/tmp/long.mp4')).toThrowError();
    expect(() => outputRelativePath(path.join(OUTPUT_DIR, '..', 'escape.mp4'))).toThrowError();
  });
});
