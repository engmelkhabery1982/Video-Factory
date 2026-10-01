/**
 * API / UI CONTRACT — generated logical asset slots reach the operator.
 *
 * Proves the full user flow at product-test level on FRESH generated content
 * (no fixture Scenario):
 *
 *   new project -> fresh ProjectInput -> generate Long + Short
 *     -> full generated Scenario reaches the production read surface
 *     -> at least one genuine generated logical asset ref exists
 *     -> the ref is discoverable while UNBOUND
 *     -> an eligible Asset Library item can be bound to it
 *     -> the explicit binding persists and survives a reload
 *     -> Phase 6A resolves the selected Asset ID into the mediaMap
 *
 * The UI ref-discovery rule is asserted directly (it is the same union +
 * deterministic-dedupe rule ProductionStoryboard applies), so the contract is
 * proven without a browser.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ProjectInput } from '../packages/core/src/index.js';

/**
 * The API modules resolve DATA_DIR / OUTPUT_DIR at import time, so the
 * isolated scratch environment must exist BEFORE they are imported. They are
 * therefore loaded dynamically inside beforeAll.
 */

/* ------------------------------------------------------------------ */
/*  Isolated scratch — never a real home directory                     */
/* ------------------------------------------------------------------ */

let DATA_DIR = '';
let OUTPUT_DIR = '';

const VIDEO_ID = 'GenAssetSlot_API_01';

const INPUT: ProjectInput = {
  videoId: VIDEO_ID,
  videoType: 'long',
  topic: 'Controlling an ageing RFI backlog before it becomes schedule delay',
  targetAudience: 'Package managers and document controllers',
  mainProblem: 'Ageing RFIs quietly turn into schedule delay',
  viewerPromise: 'A repeatable 48-hour control routine for the RFI register',
  hook: 'Twenty-four open RFIs, eight of them older than fourteen days.',
  script: [
    'This training example follows a fictional RFI register on a mid-size commercial fit-out.',
    'The register currently holds 24 open RFIs.',
    'Eight of those RFIs are older than 14 days.',
    'The control rule reviews the whole register every 48 hours.',
    'Any RFI still without a response after 7 days is escalated to the package manager.',
    'Three control actions stop the backlog from becoming schedule delay.',
    'First, age the register and flag every item past 14 days.',
    'Second, assign a single named owner to each open RFI.',
    'Third, escalate the aged items on a fixed 48-hour cycle.',
    'An ageing RFI only becomes delay when nobody owns the clock.',
    'Start your BuildTrack trial and put the register on a clock.',
  ].join('\n'),
  keyNumbers: ['24 open RFIs', '8 older than 14 days', '48 hours', '7 days', '3 control actions'],
  keyPoints: ['Age the register', 'Single named owner', 'Fixed escalation cycle'],
  productName: 'BuildTrack',
  productShots: [],
  cta: 'Start your BuildTrack trial',
  voiceoverFile: null,
  targetAudio: {},
  brollFiles: [],
  sourceReferences: ['Fictional training example — RFI Backlog Control, API contract test'],
  outputLanguage: 'en',
  brandPreset: 'buildtrack',
  shortCount: 1,
};

/** A tiny valid PNG, uploaded through the REAL Asset Library route. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

let app: FastifyInstance;

/**
 * The exact ref-discovery rule ProductionStoryboard applies: the union of the
 * generated Scenario's screenInsert.assetRef values and the persisted bindings,
 * deduplicated deterministically.
 */
function discoverRefs(input: {
  fullScenarios: Record<string, any>;
  assetBindings: Array<{ target: string; logicalRef: string }>;
  target: string;
}): string[] {
  const refs = new Set<string>();
  for (const scene of input.fullScenarios[input.target]?.scenes ?? []) {
    const ref = scene?.production?.screenInsert?.assetRef;
    if (typeof ref === 'string' && ref.trim()) refs.add(ref);
  }
  for (const b of input.assetBindings) {
    if (b.target === input.target) refs.add(b.logicalRef);
  }
  return Array.from(refs).sort();
}

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-asset-slot-api-'));
  DATA_DIR = path.join(root, 'data');
  OUTPUT_DIR = path.join(root, 'output');
  fs.mkdirSync(path.join(DATA_DIR, 'assets'), { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  process.env.BUILDTRAKE_DATA = DATA_DIR;
  process.env.BUILDTRAKE_OUTPUT = OUTPUT_DIR;

  const Fastify = (await import('fastify')).default;
  const multipart = (await import('@fastify/multipart')).default;
  const { registerAssetRoutes } = await import('../apps/api/src/routes/assets.js');
  const { registerProjectRoutes } = await import('../apps/api/src/routes/projects.js');
  const { registerProductionRoutes } = await import('../apps/api/src/routes/production.js');

  app = Fastify({ logger: false });
  await app.register(multipart);
  registerAssetRoutes(app);
  registerProjectRoutes(app);
  registerProductionRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  try {
    fs.rmSync(path.dirname(DATA_DIR), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/* ------------------------------------------------------------------ */

describe('API / UI contract — generated asset slots are bindable', () => {
  it('gate A1: new project -> generate Long + Short through the real production routes', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: INPUT });
    expect(created.statusCode).toBe(200);
    const gen = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/production/generate`,
      payload: {},
    });
    expect(gen.statusCode).toBe(200);

    const read = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/production` });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect([...body.production.targets].sort()).toEqual(['long', 'short_1']);
  });

  it('gate A2: GET /production gives the UI the complete generated Scenario data', async () => {
    const read = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/production` });
    const body = read.json();

    // Existing derived summaries are preserved (backward compatible).
    expect(body.scenarios.long).toMatchObject({
      scenarioId: expect.any(String),
      title: expect.any(String),
      sceneCount: expect.any(Number),
      characterCount: expect.any(Number),
    });

    // The additive full-scenario field carries what the UI renders and edits.
    const long = body.fullScenarios.long;
    const short = body.fullScenarios.short_1;
    expect(Array.isArray(long.scenes)).toBe(true);
    expect(long.scenes.length).toBeGreaterThan(0);
    expect(Array.isArray(long.characters)).toBe(true);
    expect(long.characters.length).toBeGreaterThanOrEqual(3);
    // Dialogue turns are present for the UI.
    expect(long.scenes.some((s: any) => (s.turns ?? []).length > 0)).toBe(true);
    // Production directions are present.
    expect(long.scenes.every((s: any) => s.production && typeof s.production === 'object')).toBe(true);
    // Short too.
    expect(short.scenes.length).toBeGreaterThan(0);
    expect(short.characters.length).toBeGreaterThanOrEqual(3);
    // Summary and full data agree.
    expect(body.scenarios.long.sceneCount).toBe(long.scenes.length);
    expect(body.scenarios.long.characterCount).toBe(long.characters.length);
  });

  it('gate A3: at least one genuine generated logical asset ref exists and is UNBOUND', async () => {
    const read = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/production` });
    const body = read.json();

    const generated = new Set<string>();
    for (const scene of body.fullScenarios.long.scenes) {
      const ref = scene.production?.screenInsert?.assetRef;
      if (typeof ref === 'string' && ref.trim()) generated.add(ref);
    }
    expect(generated.size).toBeGreaterThanOrEqual(1);
    for (const ref of generated) {
      expect(ref).not.toBe('rfi-ageing-summary');
      expect(ref.startsWith('source-record:')).toBe(true);
    }

    // Nothing is bound yet, so the discovery rule must still surface them.
    expect(body.production.assetBindings).toEqual([]);
    const discovered = discoverRefs({
      fullScenarios: body.fullScenarios,
      assetBindings: body.production.assetBindings,
      target: 'long',
    });
    expect(discovered.length).toBeGreaterThanOrEqual(1);
    for (const ref of generated) expect(discovered).toContain(ref);
    // Deterministic order.
    expect(discovered).toEqual([...discovered].sort());
  });

  it('gate A4: an eligible Asset Library item is selectable and the binding persists', async () => {
    const read = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/production` });
    const body = read.json();
    const ref = discoverRefs({
      fullScenarios: body.fullScenarios,
      assetBindings: body.production.assetBindings,
      target: 'long',
    })[0];

    // Upload a real asset through the real Asset Library multipart route.
    const form = new FormData();
    form.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'chart.png');
    form.append('name', 'RFI Ageing Summary (contract test)');
    form.append('kind', 'chart');
    form.append('source', 'Operator upload');
    form.append('license', 'Operator owned');
    form.append('tags', 'acceptance');
    const uploaded = await app.inject({ method: 'POST', url: '/api/assets', payload: form });
    expect(uploaded.statusCode).toBe(200);
    const asset = uploaded.json().asset;
    expect(asset.status).toBe('active');
    expect(asset.blocked).toBe(false);

    // It must be eligible for binding.
    const eligible = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/production/assets` });
    expect(eligible.statusCode).toBe(200);
    expect(eligible.json().assets.map((a: any) => a.id)).toContain(asset.id);

    // Explicit binding through the normal route, using the GENERATED ref.
    const bound = await app.inject({
      method: 'PUT',
      url: `/api/projects/${VIDEO_ID}/production/assets/long/${encodeURIComponent(ref)}`,
      payload: { assetId: asset.id },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().production.assetBindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'long', logicalRef: ref, assetId: asset.id })]),
    );

    // Binding survives a reload (fresh read of the persisted sidecar).
    const reloaded = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/production` });
    const rb = reloaded.json();
    expect(rb.production.assetBindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'long', logicalRef: ref, assetId: asset.id })]),
    );

    // The generated ref is still discoverable and now bound.
    const discovered = discoverRefs({
      fullScenarios: rb.fullScenarios,
      assetBindings: rb.production.assetBindings,
      target: 'long',
    });
    expect(discovered).toContain(ref);

    // Clearing it leaves the generated slot discoverable and unbound again.
    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${VIDEO_ID}/production/assets/long/${encodeURIComponent(ref)}`,
    });
    expect(cleared.statusCode).toBe(200);
    const afterClear = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/production` });
    const cb = afterClear.json();
    expect(cb.production.assetBindings).toEqual([]);
    expect(
      discoverRefs({ fullScenarios: cb.fullScenarios, assetBindings: cb.production.assetBindings, target: 'long' }),
    ).toContain(ref);

    // Re-bind so the mediaMap gate below has a live binding.
    const rebound = await app.inject({
      method: 'PUT',
      url: `/api/projects/${VIDEO_ID}/production/assets/long/${encodeURIComponent(ref)}`,
      payload: { assetId: asset.id },
    });
    expect(rebound.statusCode).toBe(200);
  });

  it('gate A5: Phase 6A resolves the bound Asset ID into the mediaMap', async () => {
    const read = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/production` });
    const body = read.json();
    const ref = discoverRefs({
      fullScenarios: body.fullScenarios,
      assetBindings: body.production.assetBindings,
      target: 'long',
    })[0];
    const binding = body.production.assetBindings.find((b: any) => b.logicalRef === ref);
    expect(binding).toBeTruthy();

    // Drive the product's real Phase 6A resolver with the real generated plan
    // and the real persisted explicit binding. This is the same resolver the
    // production build route calls, exercised without the audio-synthesis
    // stage (which needs the provisioned Kokoro model — see A7).
    const { compileScenarioVisualPlan, resolveProductionAssets } = await import('../packages/core/src/index.js');
    const visual = compileScenarioVisualPlan(body.fullScenarios.long);
    expect(visual.ok).toBe(true);
    if (!visual.ok) return;

    const assets = (await app.inject({ method: 'GET', url: '/api/assets' })).json().assets;
    const eligible = assets.filter(
      (a: any) => a.status === 'active' && !a.blocked && a.source?.trim() && a.license?.trim(),
    );
    const assetUrlById: Record<string, string> = {};
    for (const a of eligible) assetUrlById[a.id] = `/media/asset/${a.id}`;

    // Persisted explicit bindings, exactly as Phase 6A receives them.
    const explicitBindings: Record<string, string> = {};
    for (const b of body.production.assetBindings) {
      if (b.target === 'long' && b.assetId) explicitBindings[b.logicalRef] = b.assetId;
    }

    const plan = {
      scenarioId: body.fullScenarios.long.metadata.id,
      projectId: body.fullScenarios.long.metadata.projectId,
      scenes: (visual as any).plan.scenes.map((s: any) => ({
        sceneId: s.id,
        assetRefs: [...(s.sceneCues ?? []), ...(s.beats ?? []).flatMap((b: any) => b.cues ?? [])]
          .filter((c: any) => c.assetRef)
          .map((c: any) => ({ assetRef: c.assetRef, sceneId: s.id, required: false })),
      })),
    };

    const resolved = resolveProductionAssets({
      plan: plan as any,
      assets: eligible,
      assetUrlById,
      explicitBindings,
    });

    const hit = resolved.bindings.find((b: any) => b.assetRef === ref);
    expect(hit?.resolved).toBe(true);
    expect(hit?.assetId).toBe(binding.assetId);
    // The generated logical ref resolves into the mediaMap with a render URL.
    expect(Object.prototype.hasOwnProperty.call(resolved.mediaMap, ref)).toBe(true);
    expect(String(resolved.mediaMap[ref])).toContain(binding.assetId);
    // No error findings — an unresolved OPTIONAL slot is not an error.
    expect((resolved.findings ?? []).filter((f: any) => f.severity === 'error')).toEqual([]);
  });

  it('gate A6: the full HTTP build route reaches the same mediaMap when TTS is provisioned', async () => {
    const marker = '.tts-cache/.kokoro-model.ok';
    const model = '.tts-cache/models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx';
    const provisioned = fs.existsSync(marker) && fs.existsSync(model);
    if (!provisioned) {
      // Documented environment limitation: the build route synthesizes real
      // Kokoro production audio. A5 already proves Phase 6A on the real plan.
      console.warn('A6 skipped: Kokoro model not provisioned in this environment');
      return;
    }
    const built = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/production/build`,
      payload: {},
    });
    expect(built.statusCode).toBe(200);
    const long = built.json().targets.find((t: any) => t.target === 'long');
    const read = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/production` });
    const binding = read.json().production.assetBindings[0];
    expect(Object.values(long.mediaMap).some((v: any) => String(v).includes(binding.assetId))).toBe(true);
    expect(long.unresolvedRequired).toEqual([]);
  });

  it('gate A7: UI ref discovery includes unbound generated refs and unions bindings', () => {
    const fullScenarios = {
      long: {
        scenes: [
          { id: 's1', production: { screenInsert: { assetRef: 'source-record:ev-a-01' } } },
          { id: 's2', production: { screenInsert: { assetRef: 'source-record:ev-a-02' } } },
          { id: 's3', production: {} },
        ],
      },
    };
    // No bindings at all -> both generated refs are discoverable.
    expect(discoverRefs({ fullScenarios, assetBindings: [], target: 'long' })).toEqual([
      'source-record:ev-a-01',
      'source-record:ev-a-02',
    ]);
    // A custom/older binding is unioned in, not hidden, and deduplicated.
    expect(
      discoverRefs({
        fullScenarios,
        assetBindings: [
          { target: 'long', logicalRef: 'source-record:ev-a-01' },
          { target: 'long', logicalRef: 'legacy-custom-ref' },
          { target: 'short_1', logicalRef: 'other-target-only' },
        ],
        target: 'long',
      }),
    ).toEqual(['legacy-custom-ref', 'source-record:ev-a-01', 'source-record:ev-a-02']);
  });
});
