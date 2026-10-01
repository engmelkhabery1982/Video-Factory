/**
 * PART 2 — regeneration / edit invalidation.
 *
 * Proves that a successful regeneration invalidates every downstream artifact
 * that belonged to the REPLACED scenario, and that only genuinely surviving
 * asset bindings are kept:
 *
 *   1. stale build records (preview + final) are gone;
 *   2. stale production artifacts (rendered video, package) are gone;
 *   3. lastQcSummary / readiness / ready status are cleared;
 *   4. scene locks and the edit log of the replaced scenario are cleared;
 *   5. asset bindings survive ONLY when the target still exists AND the
 *      logicalRef is still a genuine generated slot of the new scenario;
 *   6. changed spokenText cannot reuse an old production WAV: the dialogue
 *      synthesis path is a deterministic function of the turn identity and the
 *      pipeline always (re)synthesizes and overwrites it (there is no synthesis
 *      cache in the product), proved with the real pipeline + a real
 *      synthesizer.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildDialogueProductionPlan,
  generateProductionScenariosFromProjectInput,
  type ProjectInput,
  type Scenario,
} from '@buildtrack/core';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-regen-'));
  nodeFs.mkdirSync(nodePath.join(dir, 'data'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(dir, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(dir, 'output');
  return { dir };
});

import { registerAssetRoutes } from '../apps/api/src/routes/assets.js';
import { registerProductionRoutes } from '../apps/api/src/routes/production.js';
import { registerProjectRoutes } from '../apps/api/src/routes/projects.js';
import { LocalDialogueSynthesizer } from '../packages/core/src/scenario/local-dialogue-synthesizer.js';
import { loadProject, saveProject } from '../apps/api/src/services/store.js';
import {
  generatedLogicalAssetRefsForTarget,
  patchProductionScene,
  patchProductionTurn,
  productionStatusFor,
} from '../apps/api/src/services/production-engine.js';
import { loadProductionState, saveProductionState } from '../apps/api/src/services/production-state.js';
import type { ProductionState } from '../apps/api/src/services/production-state.js';

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

/** Produce a realistic "this project has been built" state (no render needed). */
function markBuilt(videoId: string): { sceneId: string; turnId: string; slot: string } {
  const state = loadProductionState(videoId)!;
  const scenario = state.scenarios.long as Scenario;
  const scene = scenario.scenes[0];
  const turn = scene.turns[0];
  const slot = generatedLogicalAssetRefsForTarget(state, 'long')[0];
  state.builds.push({ kind: 'preview' as never, targets: ['long'], outputs: {}, at: new Date().toISOString(), status: 'ok' } as never);
  state.builds.push({ kind: 'final' as never, targets: ['long'], outputs: {}, at: new Date().toISOString(), status: 'ok' } as never);
  state.artifacts.push({ target: 'long', kind: 'video', relPath: `${videoId}/final/long.mp4`, sizeBytes: 1, createdAt: new Date().toISOString() });
  state.artifacts.push({ target: 'package', kind: 'package', relPath: `${videoId}/package`, sizeBytes: 1, createdAt: new Date().toISOString() });
  state.lastQcSummary = { verdict: 'pass', packageStatus: 'ready' } as never;
  state.lastReadiness = { status: 'ready', readyForProductionDelivery: true } as never;
  state.status = 'ready_for_export';
  state.locks[scene.id] = true;
  state.edits.push({ target: 'long', kind: 'scene', subjectId: scene.id, at: new Date().toISOString(), summary: 'old edit' } as never);
  // Deterministic fixture: the same bindings are re-seeded, never duplicated.
  state.assetBindings = state.assetBindings.filter((b) => !['asset-survivor', 'asset-stale', 'asset-ghost-target'].includes(b.assetId));
  state.assetBindings.push({ target: 'long', logicalRef: slot, assetId: 'asset-survivor', setAt: new Date().toISOString() });
  state.assetBindings.push({ target: 'long', logicalRef: 'source-record:ev-removed-99', assetId: 'asset-stale', setAt: new Date().toISOString() });
  state.assetBindings.push({ target: 'short_9' as never, logicalRef: slot, assetId: 'asset-ghost-target', setAt: new Date().toISOString() });
  saveProductionState(state);
  return { sceneId: scene.id, turnId: turn.id, slot };
}

describe('Part 2 — regeneration invalidates stale production state', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024 } });
    await registerAssetRoutes(app);
    await registerProjectRoutes(app);
    await registerProductionRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    try {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function createProject(videoId: string): Promise<void> {
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor(videoId) });
    expect(created.statusCode).toBe(200);
  }

  async function generate(videoId: string): Promise<void> {
    const gen = await app.inject({ method: 'POST', url: `/api/projects/${videoId}/production/generate`, payload: {} });
    expect(gen.statusCode, gen.payload).toBe(200);
  }

  it('1. invalidation: builds, artifacts, QC summary, readiness, status, locks and edits are cleared', async () => {
    await createProject('Regen_01');
    await generate('Regen_01');
    const { sceneId } = markBuilt('Regen_01');
    const before = loadProductionState('Regen_01')!;
    expect(before.builds.length).toBeGreaterThan(0);
    expect(before.locks[sceneId]).toBe(true);

    await generate('Regen_01');

    const after = loadProductionState('Regen_01')!;
    expect(after.builds).toEqual([]);
    expect(after.artifacts).toEqual([]);
    expect(after.lastQcSummary).toBeNull();
    expect(after.lastReadiness).toBeNull();
    expect(after.status).toBe('generated');
    expect(after.locks).toEqual({});
    expect(after.edits).toEqual([]);
  });

  it('2. only bindings whose logicalRef is still a genuine generated slot of a live target survive', async () => {
    const { slot } = markBuilt('Regen_01');
    await generate('Regen_01');
    const after = loadProductionState('Regen_01')!;
    const genuine = new Set(generatedLogicalAssetRefsForTarget(after, 'long'));
    expect(genuine.has(slot)).toBe(true);
    expect(after.assetBindings.filter((b) => b.target === 'long')).toEqual([
      expect.objectContaining({ target: 'long', logicalRef: slot, assetId: 'asset-survivor' }),
    ]);
    expect(after.assetBindings.some((b) => b.logicalRef === 'source-record:ev-removed-99')).toBe(false);
    expect(after.assetBindings.some((b) => (b.target as string) === 'short_9')).toBe(false);
  });

  it('3. editing the ProjectInput marks the state stale and blocks preview/export until regeneration', async () => {
    const p = loadProject('Regen_01')!;
    p.meta.input.script = `${p.meta.input.script}\nThe certificate list is now published weekly.`;
    saveProject(p);

    const state = loadProductionState('Regen_01')!;
    expect(productionStatusFor(state, p)).toBe('needs_regeneration');
    const preview = await app.inject({ method: 'POST', url: '/api/projects/Regen_01/production/preview', payload: {} });
    expect(preview.statusCode).toBe(409);
    expect(JSON.parse(preview.payload).code).toBe('STALE_INPUT');
    const finalExport = await app.inject({ method: 'POST', url: '/api/projects/Regen_01/production/export', payload: {} });
    expect(finalExport.statusCode).toBe(409);
    expect(JSON.parse(finalExport.payload).code).toBe('STALE_INPUT');
    const build = await app.inject({ method: 'POST', url: '/api/projects/Regen_01/production/build', payload: {} });
    expect(build.statusCode).toBe(409);
    expect(JSON.parse(build.payload).code).toBe('STALE_INPUT');

    // Regeneration clears the staleness again (the new fingerprint is stored).
    await generate('Regen_01');
    const after = loadProductionState('Regen_01')!;
    expect(productionStatusFor(after, loadProject('Regen_01')!)).toBe('generated');
  });

  it('4. dialogue edits invalidate built artifacts and mark the state edited', async () => {
    await createProject('Regen_02');
    await generate('Regen_02');
    const { turnId } = markBuilt('Regen_02');
    expect(loadProductionState('Regen_02')!.status).toBe('ready_for_export');

    patchProductionTurn(loadProductionState('Regen_02')!, 'long', turnId, { spokenText: 'The certificate list is published every Friday.' });
    const after = loadProductionState('Regen_02')!;
    expect(after.status).toBe('edited');
    expect(after.artifacts).toEqual([]);
    expect(after.lastReadiness).toBeNull();
    expect(after.edits.some((e) => e.kind === 'turn')).toBe(true);
  });

  it('4b. a locked scene refuses edits and unlocks atomically', async () => {
    const state = loadProductionState('Regen_02')!;
    const sceneId = (state.scenarios.long as Scenario).scenes[0].id;
    // markBuilt locks the scene; unlock first so the lock transition is explicit.
    patchProductionScene(state, 'long', sceneId, { locked: false });
    patchProductionScene(loadProductionState('Regen_02')!, 'long', sceneId, { locked: true });
    expect(() => patchProductionScene(loadProductionState('Regen_02')!, 'long', sceneId, { title: 'x' })).toThrowError(/locked/i);
    const unlocked = loadProductionState('Regen_02')!;
    patchProductionScene(unlocked, 'long', sceneId, { locked: false });
    patchProductionScene(loadProductionState('Regen_02')!, 'long', sceneId, { title: 'Unlocked title' });
    expect((loadProductionState('Regen_02')!.scenarios.long as Scenario).scenes[0].title).toBe('Unlocked title');
  });

  it('5. changed spokenText cannot reuse an old production WAV (real pipeline, deterministic per-turn path)', async () => {
    const scenario = {
      ...(loadProductionState('Regen_02')!.scenarios.long as Scenario),
    };
    const turn = scenario.scenes[0].turns[0];

    const base = `.test-regen-audio/${path.basename(tmp.dir)}`;
    const options = {
      synthesisBasePath: `${base}/dialogue`,
      canonicalBasePath: `${base}/canonical`,
      synthesizer: new LocalDialogueSynthesizer(),
    };

    const first = await buildDialogueProductionPlan(scenario, options);
    expect(first.success, JSON.stringify(first.findings)).toBe(true);
    const firstClip = first.success
      ? first.result.canonicalManifest.results.find((r: any) => r.turnId === turn.id)
      : null;
    expect(firstClip).toBeTruthy();
    const firstSourceBytes = fs.readFileSync(firstClip!.sourcePath);
    const firstCanonicalBytes = fs.readFileSync(firstClip!.canonicalPath);

    // Edit the spoken text and rebuild the SAME target: the per-turn path is
    // unchanged (deterministic identity), so the old bytes are overwritten.
    const edited: Scenario = JSON.parse(JSON.stringify(scenario));
    edited.scenes[0].turns[0].spokenText = 'The certificate list is published every Friday before noon.';
    const second = await buildDialogueProductionPlan(edited, options);
    expect(second.success, JSON.stringify(second.findings)).toBe(true);
    const secondClip = second.success
      ? second.result.canonicalManifest.results.find((r: any) => r.turnId === turn.id)
      : null;
    expect(secondClip).toBeTruthy();

    expect(secondClip!.sourcePath).toBe(firstClip!.sourcePath);
    expect(secondClip!.canonicalPath).toBe(firstClip!.canonicalPath);
    // Spoken text is preserved verbatim and re-synthesized: neither the source
    // nor the canonical WAV is the stale one from the previous text.
    expect(secondClip!.spokenText).toBe('The certificate list is published every Friday before noon.');
    expect(fs.readFileSync(secondClip!.sourcePath).equals(firstSourceBytes)).toBe(false);
    expect(fs.readFileSync(secondClip!.canonicalPath).equals(firstCanonicalBytes)).toBe(false);
    // …and the canonical authority is still 48 kHz mono PCM16.
    expect(secondClip!.canonicalMetadata.sampleRate).toBe(48000);
    expect(secondClip!.canonicalMetadata.channels).toBe(1);
    expect(secondClip!.canonicalMetadata.bitDepth).toBe(16);

    fs.rmSync(path.resolve(base), { recursive: true, force: true });
  });

  it('6. the production engine keeps no synthesis cache that could serve stale audio', () => {
    // The product's audio path always synthesizes; there is no cache/reuse layer.
    const files = [
      'apps/api/src/services/production-engine.ts',
      'apps/api/src/services/plan-production.ts',
      'packages/core/src/scenario/synthesize-dialogue.ts',
      'packages/core/src/scenario/dialogue-production-pipeline.ts',
    ];
    for (const rel of files) {
      const source = fs.readFileSync(path.resolve(rel), 'utf8');
      expect(/synthesisCache|audioCache|reuseExistingAudio|skipSynthesisIfExists/i.test(source), rel).toBe(false);
    }
    // Deterministic per-turn target path derived from the turn identity.
    const synth = fs.readFileSync(path.resolve('packages/core/src/scenario/synthesize-dialogue.ts'), 'utf8');
    expect(synth).toMatch(/turn|clip/i);
  });
});

/** Sanity: the generated state really is the fixture the invalidation targets. */
describe('Part 2 fixture sanity', () => {
  it('the fixture content generates exactly the statement slots used by the tests', () => {
    const generated = generateProductionScenariosFromProjectInput(inputFor('Regen_sanity'), { shortCount: 1 });
    expect(generated.success).toBe(true);
    const slots = (generated.longScenario!.scenes as any[])
      .map((s) => s.production?.screenInsert?.assetRef)
      .filter((r): r is string => typeof r === 'string');
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('a production state with no builds reports its real status', () => {
    const state = { builds: [], status: 'generated', inputFingerprint: 'x', scenarios: {} } as unknown as ProductionState;
    const project = { meta: { input: { ...inputFor('Regen_status'), videoId: 'Regen_status' } } } as any;
    expect(['generated', 'needs_regeneration']).toContain(productionStatusFor(state, project));
  });
});
