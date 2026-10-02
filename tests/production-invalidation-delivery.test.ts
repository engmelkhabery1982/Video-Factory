/**
 * AUDIT ITEMS D + E — edit/regeneration invalidation and delivery readiness.
 *
 * D — nothing derived from replaced content may keep presenting itself as
 *     current. After a ProjectInput change, a scene edit, a spokenText
 *     (dialogue) edit, an asset-binding change or a regeneration, the previous
 *     video builds, Phase 6D package artifacts, QC summary, readiness result
 *     and product-kit link must be gone from the PERSISTED state and absent
 *     from every API summary — and they must stay gone after "reopening" the
 *     project in a fresh read (a new process reads the same sidecar).
 *
 * E — the final delivery may report readiness `ready` only when the Phase 6D
 *     package is `ready` and the kit deliverables were written; and production
 *     history receives an entry only after a genuinely successful, ready final
 *     delivery — never for a render that merely returned `ok`. Failed
 *     deliveries never enter history.
 *
 * No rendering happens here: states are seeded as the engine would leave them
 * and then driven through the REAL invalidation / gating code and the REAL HTTP
 * API with the real persisted sidecars.
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
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-inval-'));
  nodeFs.mkdirSync(nodePath.join(dir, 'data'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(dir, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(dir, 'output');
  return { dir };
});

import { registerAssetRoutes } from '../apps/api/src/routes/assets.js';
import { registerProductionRoutes, productionHistoryEligible } from '../apps/api/src/routes/production.js';
import { registerProjectRoutes } from '../apps/api/src/routes/projects.js';
import {
  finalDeliverySucceeded,
  loadProductionHistory,
  loadProductionState,
  recordBuild,
  saveProductionState,
  type ProductionState,
} from '../apps/api/src/services/production-state.js';
import {
  generatedLogicalAssetRefsForTarget,
  patchProductionScene,
  patchProductionTurn,
  productionStatusFor,
  setProductionAssetBinding,
} from '../apps/api/src/services/production-engine.js';
import { loadProject, saveProject } from '../apps/api/src/services/store.js';

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

function readinessFor(kind: 'preview' | 'final', overrides: Partial<ProductionState['lastReadiness'] & object> = {}): any {
  return {
    schemaVersion: 1,
    at: new Date().toISOString(),
    kind,
    status: 'ready',
    readyForProductionDelivery: kind === 'final',
    dimensions: [],
    findings: [],
    historyObservation: {
      source: 'none',
      productionEntryCount: 0,
      videoIds: [],
      personaKeyCount: 0,
      personas: {},
      styleFingerprint: null,
    },
    supersededLegacyQcDimensions: [],
    ...overrides,
  };
}

/** The state the engine would persist after a genuinely successful final delivery. */
function markSuccessfulFinal(videoId: string): { sceneId: string; turnId: string; slot: string } {
  const state = loadProductionState(videoId)!;
  const scenario = state.scenarios.long as Scenario;
  const scene = scenario.scenes[0];
  const turn = scene.turns[0];
  const slot = generatedLogicalAssetRefsForTarget(state, 'long')[0];
  const at = new Date().toISOString();
  state.builds.push({ kind: 'final' as never, targets: ['long'], outputs: { long: `${videoId}/long.mp4` }, at, status: 'ok', packageStatus: 'ready', packageRoot: `${videoId}/production-package` } as never);
  state.artifacts.push({ target: 'long', kind: 'video', relPath: `${videoId}/long.mp4`, sizeBytes: 1, createdAt: at });
  state.artifacts.push({ target: 'package', kind: 'package', relPath: `${videoId}/production-package`, sizeBytes: 1, createdAt: at });
  state.lastQcSummary = { verdict: 'pass', packageStatus: 'ready', mode: 'final', longCount: 1, shortCount: 1 } as never;
  state.lastReadiness = readinessFor('final');
  state.productKitPath = `${videoId}/production-kit`;
  state.status = 'ready_for_export';
  state.locks[scene.id] = true;
  saveProductionState(state);
  return { sceneId: scene.id, turnId: turn.id, slot };
}

function assertNoDerivedRecords(state: ProductionState, label: string): void {
  expect(state.builds, `${label}: builds`).toEqual([]);
  expect(state.artifacts, `${label}: artifacts`).toEqual([]);
  expect(state.lastQcSummary, `${label}: lastQcSummary`).toBeNull();
  expect(state.lastReadiness, `${label}: lastReadiness`).toBeNull();
  expect(state.productKitPath ?? null, `${label}: productKitPath`).toBeNull();
  expect(finalDeliverySucceeded(state), `${label}: finalDeliverySucceeded`).toBe(false);
}

describe('audit D — replaced content never keeps presenting derived records as current', () => {
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

  async function createAndGenerate(videoId: string): Promise<void> {
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor(videoId) });
    expect(created.statusCode, created.payload).toBe(200);
    const gen = await app.inject({ method: 'POST', url: `/api/projects/${videoId}/production/generate`, payload: {} });
    expect(gen.statusCode, gen.payload).toBe(200);
  }

  it('D1 — ProjectInput change invalidates persisted records and every API summary, and stays invalid after reopen', async () => {
    await createAndGenerate('Inv_01');
    markSuccessfulFinal('Inv_01');
    expect(finalDeliverySucceeded(loadProductionState('Inv_01')!)).toBe(true);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/projects/Inv_01',
      payload: { input: { script: `${inputFor('Inv_01').script}\nThe certificate list is now published weekly.` } },
    });
    expect(put.statusCode).toBe(200);

    // PERSISTED state (this is what a fresh process reads back).
    assertNoDerivedRecords(loadProductionState('Inv_01')!, 'after input change');
    expect(productionStatusFor(loadProductionState('Inv_01')!, loadProject('Inv_01')!)).toBe('needs_regeneration');

    // Production summary for the project page.
    const summary = await app.inject({ method: 'GET', url: '/api/projects/Inv_01/production' });
    expect(summary.statusCode).toBe(200);
    const prod = JSON.parse(summary.payload).production;
    expect(prod.status).toBe('needs_regeneration');
    expect(prod.stale).toBe(true);
    expect(prod.lastBuild).toBeNull();
    expect(prod.lastQcSummary).toBeNull();
    expect(prod.lastReadiness).toBeNull();
    expect(prod.productKitPath).toBeNull();
    expect(prod.artifacts).toEqual([]);
    expect(prod.deliveryReady).toBe(false);

    // Project-level summary (list + single project).
    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    const entry = JSON.parse(list.payload).projects.find((p: any) => p.videoId === 'Inv_01');
    expect(entry.production.buildCount).toBe(0);
    expect(entry.production.artifactCount).toBe(0);
    expect(entry.production.lastBuild).toBeNull();
    expect(entry.production.readiness).toBeNull();
    expect(entry.production.packageStatus).toBeNull();
    expect(entry.production.hasProductKit).toBe(false);

    // Reopen: a second independent read of the sidecar still shows nothing current.
    assertNoDerivedRecords(loadProductionState('Inv_01')!, 'reopened after input change');
    // And rendering is refused until regeneration.
    const preview = await app.inject({ method: 'POST', url: '/api/projects/Inv_01/production/preview', payload: {} });
    expect(preview.statusCode).toBe(409);
    expect(JSON.parse(preview.payload).code).toBe('STALE_INPUT');
  });

  it('D2 — scene edit drops that target’s build + kit link and the API reports them absent', async () => {
    await createAndGenerate('Inv_02');
    const { sceneId } = markSuccessfulFinal('Inv_02');

    // markSuccessfulFinal locked the scene (as a locked scene does in the engine);
    // unlock it first, then make the real content edit.
    patchProductionScene(loadProductionState('Inv_02')!, 'long', sceneId, { locked: false });
    patchProductionScene(loadProductionState('Inv_02')!, 'long', sceneId, { title: 'Edited scene title' });
    assertNoDerivedRecords(loadProductionState('Inv_02')!, 'after scene edit');
    expect(loadProductionState('Inv_02')!.edits.some((e) => e.kind === 'scene' && e.subjectId === sceneId)).toBe(true);

    const summary = await app.inject({ method: 'GET', url: '/api/projects/Inv_02/production' });
    const prod = JSON.parse(summary.payload).production;
    expect(prod.lastBuild).toBeNull();
    expect(prod.productKitPath).toBeNull();
    expect(prod.artifacts).toEqual([]);
    expect(prod.deliveryReady).toBe(false);

    assertNoDerivedRecords(loadProductionState('Inv_02')!, 'reopened after scene edit');
  });

  it('D3 — spokenText edit drops builds/artifacts/QC/readiness/kit (spoken text is render authority)', async () => {
    await createAndGenerate('Inv_03');
    const { turnId } = markSuccessfulFinal('Inv_03');

    patchProductionTurn(loadProductionState('Inv_03')!, 'long', turnId, {
      spokenText: 'The certificate list is published every Friday.',
    });
    const after = loadProductionState('Inv_03')!;
    assertNoDerivedRecords(after, 'after spokenText edit');
    expect(after.status).toBe('edited');
    expect(after.edits.some((e) => e.kind === 'turn' && e.subjectId === turnId)).toBe(true);

    assertNoDerivedRecords(loadProductionState('Inv_03')!, 'reopened after spokenText edit');
  });

  it('D4 — asset-binding change invalidates the build that used the old binding', async () => {
    await createAndGenerate('Inv_04');
    const { slot } = markSuccessfulFinal('Inv_04');

    setProductionAssetBinding(loadProductionState('Inv_04')!, 'long', slot, 'asset-new-choice');
    const after = loadProductionState('Inv_04')!;
    expect(after.assetBindings).toContainEqual(expect.objectContaining({ target: 'long', logicalRef: slot, assetId: 'asset-new-choice' }));
    assertNoDerivedRecords(after, 'after binding change');
    expect(after.edits.some((e) => e.kind === 'asset-binding' && e.subjectId === slot)).toBe(true);

    assertNoDerivedRecords(loadProductionState('Inv_04')!, 'reopened after binding change');
  });

  it('D5 — regeneration keeps the derived records cleared and only still-valid bindings/locks survive', async () => {
    await createAndGenerate('Inv_05');
    const { slot } = markSuccessfulFinal('Inv_05');
    const surviving = loadProductionState('Inv_05')!;
    surviving.assetBindings = surviving.assetBindings.filter((b) => b.assetId !== 'keep-me');
    surviving.assetBindings.push({ target: 'long', logicalRef: slot, assetId: 'keep-me', setAt: new Date().toISOString() });
    saveProductionState(surviving);

    const regen = await app.inject({ method: 'POST', url: '/api/projects/Inv_05/production/generate', payload: {} });
    expect(regen.statusCode, regen.payload).toBe(200);

    const after = loadProductionState('Inv_05')!;
    assertNoDerivedRecords(after, 'after regeneration');
    expect(Object.keys(after.locks)).toEqual([]);
    expect(after.edits).toEqual([]);
    expect(after.assetBindings).toEqual([expect.objectContaining({ target: 'long', logicalRef: slot, assetId: 'keep-me' })]);
    // Still true after reopen.
    assertNoDerivedRecords(loadProductionState('Inv_05')!, 'reopened after regeneration');
  });
});

describe('audit E — readiness/history require a genuinely successful, ready final delivery', () => {
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

  it('E1 — render ok is NOT enough: failed package, blocked readiness, missing kit or missing package artifact all fail the gate', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor('E1_01') });
    expect(created.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/projects/E1_01/production/generate', payload: {} });

    const base = (): ProductionState => {
      const s = JSON.parse(JSON.stringify(loadProductionState('E1_01')!)) as ProductionState;
      s.builds = [];
      s.artifacts = [];
      s.lastQcSummary = null;
      s.lastReadiness = null;
      s.productKitPath = null;
      return s;
    };

    // 1. no final build at all
    expect(finalDeliverySucceeded(base())).toBe(false);

    // 2. render ok but package failed → never ready
    const failedPackage = base();
    recordBuild(failedPackage, { kind: 'final', targets: ['long'], outputs: { long: 'E1_01/long.mp4' }, at: new Date().toISOString(), status: 'ok', packageStatus: 'failed', packageRoot: 'E1_01/production-package' } as never);
    failedPackage.lastReadiness = readinessFor('final');
    failedPackage.productKitPath = 'E1_01/production-kit';
    failedPackage.artifacts.push({ target: 'package', kind: 'package', relPath: 'E1_01/production-package', sizeBytes: 1, createdAt: new Date().toISOString() });
    expect(finalDeliverySucceeded(failedPackage)).toBe(false);
    expect(failedPackage.status).toBe('blocked');
    expect(productionStatusFor(failedPackage, loadProject('E1_01')!)).toBe('blocked');

    // 3. package ready but readiness is blocked on a package finding
    const blockedReadiness = base();
    recordBuild(blockedReadiness, { kind: 'final', targets: ['long'], outputs: { long: 'E1_01/long.mp4' }, at: new Date().toISOString(), status: 'ok', packageStatus: 'ready', packageRoot: 'E1_01/production-package' } as never);
    blockedReadiness.artifacts.push({ target: 'package', kind: 'package', relPath: 'E1_01/production-package', sizeBytes: 1, createdAt: new Date().toISOString() });
    blockedReadiness.productKitPath = 'E1_01/production-kit';
    blockedReadiness.lastReadiness = readinessFor('final', {
      status: 'blocked',
      readyForProductionDelivery: false,
      findings: [{ severity: 'error', code: 'READINESS_PACKAGE_NOT_READY', dimension: 'phase6d_package', message: 'blocked' }],
    });
    expect(finalDeliverySucceeded(blockedReadiness)).toBe(false);
    expect(productionStatusFor(blockedReadiness, loadProject('E1_01')!)).toBe('blocked');

    // 4. readiness claims ready but the deliverable writer never produced a kit
    const missingKit = base();
    recordBuild(missingKit, { kind: 'final', targets: ['long'], outputs: { long: 'E1_01/long.mp4' }, at: new Date().toISOString(), status: 'ok', packageStatus: 'ready', packageRoot: 'E1_01/production-package' } as never);
    missingKit.artifacts.push({ target: 'package', kind: 'package', relPath: 'E1_01/production-package', sizeBytes: 1, createdAt: new Date().toISOString() });
    missingKit.lastReadiness = readinessFor('final');
    expect(finalDeliverySucceeded(missingKit)).toBe(false);

    // 5. kit + readiness but no package artifact record
    const missingPackageArtifact = base();
    recordBuild(missingPackageArtifact, { kind: 'final', targets: ['long'], outputs: { long: 'E1_01/long.mp4' }, at: new Date().toISOString(), status: 'ok', packageStatus: 'ready', packageRoot: 'E1_01/production-package' } as never);
    missingPackageArtifact.productKitPath = 'E1_01/production-kit';
    missingPackageArtifact.lastReadiness = readinessFor('final');
    expect(finalDeliverySucceeded(missingPackageArtifact)).toBe(false);

    // 6. a PREVIEW readiness result can never authorize a final delivery
    const previewOnly = base();
    recordBuild(previewOnly, { kind: 'final', targets: ['long'], outputs: { long: 'E1_01/long.mp4' }, at: new Date().toISOString(), status: 'ok', packageStatus: 'ready', packageRoot: 'E1_01/production-package' } as never);
    previewOnly.artifacts.push({ target: 'package', kind: 'package', relPath: 'E1_01/production-package', sizeBytes: 1, createdAt: new Date().toISOString() });
    previewOnly.productKitPath = 'E1_01/production-kit';
    previewOnly.lastReadiness = readinessFor('preview');
    expect(finalDeliverySucceeded(previewOnly)).toBe(false);

    // 7. the fully consistent delivery passes
    const good = base();
    recordBuild(good, { kind: 'final', targets: ['long'], outputs: { long: 'E1_01/long.mp4' }, at: new Date().toISOString(), status: 'ok', packageStatus: 'ready', packageRoot: 'E1_01/production-package' } as never);
    good.artifacts.push({ target: 'package', kind: 'package', relPath: 'E1_01/production-package', sizeBytes: 1, createdAt: new Date().toISOString() });
    good.productKitPath = 'E1_01/production-kit';
    good.lastReadiness = readinessFor('final');
    expect(finalDeliverySucceeded(good)).toBe(true);
    expect(good.status).toBe('ready_for_export');
    expect(productionStatusFor(good, loadProject('E1_01')!)).toBe('ready_for_export');
  });

  it('E2 — the history gate admits ONLY a final delivery whose delivery succeeded, and history stays empty otherwise', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor('E2_01') });
    await app.inject({ method: 'POST', url: '/api/projects/E2_01/production/generate', payload: {} });
    const state = loadProductionState('E2_01')!;

    // preview delivery (even a successful one) never enters history
    const previewOk = JSON.parse(JSON.stringify(state)) as ProductionState;
    recordBuild(previewOk, { kind: 'preview', targets: ['long'], outputs: { long: 'E2_01/preview.mp4' }, at: new Date().toISOString(), status: 'ok' } as never);
    previewOk.lastReadiness = readinessFor('preview');
    expect(productionHistoryEligible('preview', previewOk)).toBe(false);

    // final render ok, package failed → no history
    const failedPackage = JSON.parse(JSON.stringify(state)) as ProductionState;
    recordBuild(failedPackage, { kind: 'final', targets: ['long'], outputs: { long: 'E2_01/long.mp4' }, at: new Date().toISOString(), status: 'ok', packageStatus: 'failed', packageRoot: 'E2_01/production-package' } as never);
    failedPackage.productKitPath = 'E2_01/production-kit';
    failedPackage.lastReadiness = readinessFor('final');
    failedPackage.artifacts.push({ target: 'package', kind: 'package', relPath: 'E2_01/production-package', sizeBytes: 1, createdAt: new Date().toISOString() });
    expect(productionHistoryEligible('final', failedPackage)).toBe(false);

    // final render FAILED entirely → no history
    const failedRender = JSON.parse(JSON.stringify(state)) as ProductionState;
    recordBuild(failedRender, { kind: 'final', targets: ['long'], outputs: {}, at: new Date().toISOString(), status: 'failed' } as never);
    expect(productionHistoryEligible('final', failedRender)).toBe(false);

    // genuine success → eligible
    const good = JSON.parse(JSON.stringify(state)) as ProductionState;
    recordBuild(good, { kind: 'final', targets: ['long'], outputs: { long: 'E2_01/long.mp4' }, at: new Date().toISOString(), status: 'ok', packageStatus: 'ready', packageRoot: 'E2_01/production-package' } as never);
    good.artifacts.push({ target: 'package', kind: 'package', relPath: 'E2_01/production-package', sizeBytes: 1, createdAt: new Date().toISOString() });
    good.productKitPath = 'E2_01/production-kit';
    good.lastReadiness = readinessFor('final');
    expect(productionHistoryEligible('final', good)).toBe(true);

    // The persisted history file is untouched by any of the failed paths above.
    const before = loadProductionHistory();
    for (const rejected of [previewOk, failedPackage, failedRender]) {
      expect(productionHistoryEligible(rejected.builds[rejected.builds.length - 1]?.kind === 'preview' ? 'preview' : 'final', rejected)).toBe(false);
    }
    expect(loadProductionHistory()).toEqual(before);
    expect(loadProductionHistory().some((e) => e.videoId === 'E2_01')).toBe(false);
  });

  it('E3 — a stale input can never report readiness ready or deliveryReady true, even if an old sidecar claimed ready', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor('E3_01') });
    await app.inject({ method: 'POST', url: '/api/projects/E3_01/production/generate', payload: {} });
    markSuccessfulFinal('E3_01');

    // Simulate a sidecar written BEFORE the input changed (defensive staleness).
    const p = loadProject('E3_01')!;
    p.meta.input.script = `${p.meta.input.script}\nA new closing line.`;
    saveProject(p); // no invalidation call: only the read-time guard protects us

    const summary = await app.inject({ method: 'GET', url: '/api/projects/E3_01/production' });
    const prod = JSON.parse(summary.payload).production;
    expect(prod.stale).toBe(true);
    expect(prod.status).toBe('needs_regeneration');
    expect(prod.lastReadiness).toBeNull();
    expect(prod.productKitPath).toBeNull();
    expect(prod.lastBuild).toBeNull();
    expect(prod.deliveryReady).toBe(false);
    expect(prod.lastQcSummary).toBeNull();
  });
});
