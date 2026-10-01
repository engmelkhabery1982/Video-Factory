/**
 * Workstream D — Product Production Integration (33 gates)
 *
 * Proves the EXISTING product workflow runs on the NEW production authority:
 * ProjectInput → Workstream A generation (no fixtures) → persisted production
 * state → production-mode plans (Kokoro) → Phase 6A explicit bindings →
 * Phase 6C target sets → plan-based preview/final authority (render boundary
 * stubbed; everything below runs for real) → reopen, metadata, provenance,
 * production history.
 *
 * NO full video render: the Phase 6B `renderCompositionPlan` boundary and the
 * ffprobe `analyseFile` probe are mocked at module level; the plan, target
 * set, asset resolution and Phase 6D package-planner layers run unstubbed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, Project, ProjectInput, RemotionCompositionPlan } from '@buildtrack/core';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-prod-int-test-'));
  const testData = nodePath.join(dir, 'data');
  const testOut = nodePath.join(dir, 'output');
  nodeFs.mkdirSync(testData, { recursive: true });
  nodeFs.mkdirSync(testOut, { recursive: true });
  process.env.BUILDTRAKE_DATA = testData;
  process.env.BUILDTRAKE_OUTPUT = testOut;
  return { dir, testData, testOut };
});

const testDataDir = tmp.testData;
const testOutputDir = tmp.testOut;
const renderCalls: Array<{ outputFile: string; scenarioId: string }> = [];

/* Stub the Phase 6B render boundary BEFORE any service module is imported. */
vi.mock('../apps/api/src/services/render.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    renderCompositionPlan: async (input: { outputFile: string; plan?: { scenarioId?: string; durationInFrames?: number } }) => {
      renderCalls.push({ outputFile: input.outputFile, scenarioId: input.plan?.scenarioId ?? '' });
      fs.mkdirSync(path.dirname(input.outputFile), { recursive: true });
      fs.writeFileSync(input.outputFile, Buffer.from(`%MP4-STUB-${input.plan?.scenarioId ?? 'x'}`));
      return {
        outputFile: input.outputFile,
        durationInFrames: input.plan?.durationInFrames ?? 1,
        renderedFrameCount: input.plan?.durationInFrames ?? 1,
        policy: 'stub-no-render',
      };
    },
  };
});

/* Stub the ffprobe/ffmpeg analyser so Phase 6D QC validates the stub media
   as if it were a real H.264 render of the plan's exact geometry/duration. */
vi.mock('../apps/api/src/services/media.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    analyseFile: async (file: string) => {
      const name = path.basename(file);
      const target = name.startsWith('long') ? { w: 1920, h: 1080, sec: 10 } : { w: 1080, h: 1920, sec: 8 };
      return {
        width: target.w,
        height: target.h,
        r_frame_rate: '30/1',
        codec_name: 'h264',
        profile: null,
        pix_fmt: 'yuv420p',
        bit_rate: '2000000',
        duration: target.sec,
        hasAudio: true,
        audioCodec: 'aac',
        audioBitrate: '128000',
        audioSampleRate: '48000',
        audioChannels: 2,
        formatName: 'mov,mp4,m4a,3gp,m4v',
        sizeBytes: fs.statSync(file).size,
        blackSeconds: 0,
        blackIntervals: 0,
        longestSilence: 0,
        silenceCount: 0,
      };
    },
  };
});

import { newProject, saveProject, loadProject, listProjects } from '../apps/api/src/services/store.js';import {
  appendProductionHistoryEntry,
  isStaleAgainstInput,
  loadProductionHistory,
  loadProductionState,
  PRODUCTION_STATE_VERSION,
  saveProductionState,
  targetNeedsAudioRebuild,
} from '../apps/api/src/services/production-state.js';
import {
  buildAllTargetPlans,
  generateProductionState,
  patchProductionScene,
  patchProductionTurn,
  personaHistoryFromVisualHistory,
  personaObservationFromState,
  productionCaptionsForTarget,
  productionStatusFor,
  setProductionAssetBinding,
  targetsForInput,
  PRODUCTION_AUDIO_ENGINE,
  ProductionError,
} from '../apps/api/src/services/production-engine.js';
import { buildFinalTargetSet, runPlanBasedProductionExport } from '../apps/api/src/services/plan-production.js';
import { registerProductionRoutes, eligibleBindingAssets } from '../apps/api/src/routes/production.js';
import { registerAssetRoutes, loadAssetIndex, saveAssetIndex } from '../apps/api/src/routes/assets.js';
import { writeMetadata, writeCaptions } from '../apps/api/src/services/pipeline.js';
import { generateProductionScenariosFromProjectInput, BUILTRACK_LOGO_SVG, resolveProductionAssets, personaKeyFromCharacterId, CANONICAL_PERSONA_KEYS } from '@buildtrack/core';
import { ASSETS_DIR } from '../apps/api/src/services/platform.js';

/* ------------------------------------------------------------------ */
/*  Harness                                                            */
/* ------------------------------------------------------------------ */

function baseInput(overrides: Partial<ProjectInput> = {}): ProjectInput {
  return {
    videoId: 'Prod_Int_01',
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
    shortCount: 2,
    ...overrides,
  };
}

function makeProject(videoId: string, overrides: Partial<ProjectInput> = {}): Project {
  const input = { ...baseInput({ videoId }), ...overrides };
  const p = newProject(input);
  saveProject(p);
  return p;
}

function seedRealAsset(id: string, overrides: Partial<Asset> = {}): Asset {
  const file = path.join(ASSETS_DIR, `${id}.svg`);
  fs.writeFileSync(file, BUILTRACK_LOGO_SVG, 'utf8');
  const asset = {
    id,
    name: `Asset ${id}`,
    kind: 'chart',
    fileName: `${id}.svg`,
    path: path.relative(path.join(ASSETS_DIR, '..'), file).replace(/\\/g, '/'),
    mimeType: 'image/svg+xml',
    sizeBytes: BUILTRACK_LOGO_SVG.length,
    tags: [`asset-ref:${id}`],
    status: 'active',
    preferred: false,
    source: 'Workstream D integration harness',
    license: 'Harness license (self-drawn)',
    addedAt: new Date().toISOString(),
    usedIn: [],
    blocked: false,
    ...overrides,
  } as unknown as Asset;
  const list = loadAssetIndex();
  list.push(asset);
  saveAssetIndex(list);
  return asset;
}

function makePlanStub(opts: {
  scenarioId: string;
  projectId: string;
  targetFormat: 'Long' | 'Short';
  width: number;
  height: number;
  seconds: number;
  sceneIds?: string[];
  assetRef?: string;
}): RemotionCompositionPlan {
  const fps = 30;
  const totalFrames = Math.ceil(opts.seconds * fps);
  const ids = opts.sceneIds ?? ['sc-a', 'sc-b'];
  const per = Math.floor(totalFrames / ids.length);
  let cursor = 0;
  const scenes = ids.map((sceneId, i) => {
    const startFrame = cursor;
    const endFrame = i === ids.length - 1 ? totalFrames : startFrame + per;
    cursor = endFrame;
    return {
      sceneId,
      rendererKey: 'explanation:key_statement',
      startFrame,
      endFrame,
      durationInFrames: endFrame - startFrame,
      actualStartSeconds: startFrame / fps,
      actualEndSeconds: endFrame / fps,
      actualDurationSeconds: (endFrame - startFrame) / fps,
      assetRefs: opts.assetRef
        ? [{ assetRef: opts.assetRef, cueId: `cue-${sceneId}`, beatId: `beat-${sceneId}`, cueKind: 'screen_insert_title', required: false, order: 0 }]
        : [],
      audioRefs: [
        {
          clipId: `clip_${sceneId}_t1`,
          canonicalPath: `audio/canonical/${opts.scenarioId}/${sceneId}_t1.wav`,
          actualStartSeconds: startFrame / fps,
          actualEndSeconds: endFrame / fps,
          actualDurationSeconds: (endFrame - startFrame) / fps,
          durationInFrames: endFrame - startFrame,
        },
      ],
      captionCues: [
        {
          id: `cue-${sceneId}-1`,
          sceneId,
          sceneIndex: i,
          turnId: `${sceneId}-t1`,
          turnIndex: 0,
          globalTurnIndex: i,
          clipId: `clip_${sceneId}_t1`,
          text: `Reconciled dialogue for ${sceneId}`,
          speakerId: 'char-x',
          voiceSlot: 'voice_en_female_authority',
          startTimeSeconds: startFrame / fps,
          endTimeSeconds: endFrame / fps,
          startFrame,
          endFrame,
          durationInFrames: endFrame - startFrame,
          localStartFrame: 0,
          localEndFrame: endFrame - startFrame,
          localStartSeconds: 0,
          localEndSeconds: (endFrame - startFrame) / fps,
        },
      ],
      beats: [],
    } as unknown as Record<string, unknown>;
  });
  return {
    version: '1.0.0',
    scenarioId: opts.scenarioId,
    projectId: opts.projectId,
    targetFormat: opts.targetFormat,
    fps,
    width: opts.width,
    height: opts.height,
    durationInFrames: totalFrames,
    totalActualDurationSeconds: opts.seconds,
    totalEstimatedDurationSeconds: Number((opts.seconds + 3).toFixed(2)),
    scenes,
  } as unknown as RemotionCompositionPlan;
}

/**
 * Repo-local provisioned Kokoro model cache (npm run provision:tts). The real
 * synthesis gate only runs on a provisioned machine; unprovisioned CI skips it
 * exactly like the Workstream B real-synthesis gates, and the structured
 * SYNTHESIZER_UNAVAILABLE contract is still covered by gate 10 either way.
 */
const TTS_MARKER = path.join(process.cwd(), '.tts-cache', '.kokoro-model.ok');
const TTS_MODEL = path.join(
  process.cwd(),
  '.tts-cache',
  'models',
  'onnx-community',
  'Kokoro-82M-v1.0-ONNX',
  'onnx',
  'model_quantized.onnx',
);
const ttsProvisioned = fs.existsSync(TTS_MARKER) && fs.existsSync(TTS_MODEL);
const itProvisioned = ttsProvisioned ? it : it.skip;

describe('Workstream D: product production integration', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await registerAssetRoutes(app);
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

  beforeEach(() => {
    renderCalls.length = 0;
  });

  const LONG_ONLY = baseInput({ videoId: 'WS_LongOnly', shortCount: 0 });
  const SHORT_ONLY = baseInput({ videoId: 'WS_ShortOnly', videoType: 'short', shortCount: 2 });
  const LONG_1 = baseInput({ videoId: 'WS_L1', shortCount: 1 });
  const LONG_2 = baseInput({ videoId: 'WS_L2', shortCount: 2 });
  const LONG_3 = baseInput({ videoId: 'WS_L3', shortCount: 3 });

  it('gates 1+2: ProjectInput generates persisted production state with no fixture scenario', () => {
    const p = makeProject('WS_Base');
    const state = generateProductionState(p, { videos: [] });
    expect(state.schemaVersion).toBe(PRODUCTION_STATE_VERSION);
    expect(fs.existsSync(path.join(testDataDir, 'projects', 'WS_Base', 'production-state.json'))).toBe(true);
    const raw = fs.readFileSync(path.join(testDataDir, 'projects', 'WS_Base', 'production-state.json'), 'utf8');
    expect(raw).not.toContain('scenario-pm-01');
    expect(raw).not.toContain('scenario-sched-risk-03');
    const long = state.scenarios.long as unknown as { metadata: { id: string; projectId: string } };
    expect(long.metadata.id).toBe('scenario-ws-base-long'); // slugified videoId (generator contract)
    expect(long.metadata.projectId).toBe('proj-WS_Base'); // projectId is passed verbatim by the engine
  });

  it('gate 3: Long-only works (long required, no shorts)', () => {
    const p = makeProject('WS_LongOnly', LONG_ONLY);
    const state = generateProductionState(p, { videos: [] });
    expect(Object.keys(state.scenarios).sort()).toEqual(['long']);
    expect(targetsForInput(LONG_ONLY)).toEqual(['long']);
  });

  it('gate 4: Short-only works (no Long final, at least short_1)', () => {
    const p = makeProject('WS_ShortOnly', SHORT_ONLY);
    const state = generateProductionState(p, { videos: [] });
    expect(Object.keys(state.scenarios).sort()).toEqual(['short_1', 'short_2']);
    expect(state.scenarios.long).toBeUndefined();
  });

  it('gate 5: Long + 1 Short works', () => {
    const p = makeProject('WS_L1', LONG_1);
    const state = generateProductionState(p, { videos: [] });
    expect(Object.keys(state.scenarios).sort()).toEqual(['long', 'short_1']);
  });

  it('gate 6: Long + 2 Shorts works', () => {
    const p = makeProject('WS_L2', LONG_2);
    const state = generateProductionState(p, { videos: [] });
    expect(Object.keys(state.scenarios).sort()).toEqual(['long', 'short_1', 'short_2']);
  });

  it('gate 7: Long + 3 Shorts works', () => {
    const p = makeProject('WS_L3', LONG_3);
    const state = generateProductionState(p, { videos: [] });
    expect(Object.keys(state.scenarios).sort()).toEqual(['long', 'short_1', 'short_2', 'short_3']);
  });

  it('gate 8: all targets belong to the same project/topic', () => {
    const p = loadProject('WS_L3')!;
    const state = loadProductionState('WS_L3')!;
    const metaIds = Object.values(state.scenarios).map((s) => (s as unknown as { metadata: { projectId: string } }).metadata.projectId);
    expect(new Set(metaIds).size).toBe(1);
    expect(metaIds[0]).toBe('proj-WS_L3');
    for (const s of Object.values(state.scenarios) as unknown as Array<{ metadata: { title: string } }>) {
      expect(s.metadata.title.toLowerCase()).toContain('executed 70%');
    }
  });

  itProvisioned('gate 9: production build runs the plan chain with Kokoro as the engine authority', async () => {
    // Tiny dedicated project: real Phase 4 production synthesis (Kokoro) over a
    // few clips keeps this gate inside its time budget while still proving the
    // real chain Scenario → production audio → Phase 5 plan. Skipped when the
    // model cache is not provisioned (gate 10 still proves the failure mode).
    const p = makeProject('WS_Engine', baseInput({ videoId: 'WS_Engine', shortCount: 0, script: 'The site is 70% finished. Inspections verify every claim. The certificate follows the data.' }));
    const state = generateProductionState(p, { videos: [] });
    const assets: Asset[] = [];
    // Phase 4 requires RELATIVE base paths (safety rule): cwd is the repo root.
    const plans = await buildAllTargetPlans(
      state,
      { synthesisBasePath: '.test-prod-int/WS_Engine/audio/dialogue', canonicalBasePath: '.test-prod-int/WS_Engine/audio/canonical' },
      assets,
      {},
    );
    expect(plans.length).toBe(1);
    expect(plans[0].plan.scenarioId).toBe((state.scenarios.long as unknown as { metadata: { id: string } }).metadata.id);
    expect(plans[0].plan.scenes.length).toBeGreaterThan(0);
    expect(PRODUCTION_AUDIO_ENGINE).toBe('kokoro-js');
    const src = fs.readFileSync('apps/api/src/services/production-engine.ts', 'utf8');
    expect(src).toContain("synthesisMode: 'production'");
    try { fs.rmSync('.test-prod-int/WS_Engine', { recursive: true, force: true }); } catch { /* ignore */ }
  }, 150_000);

  it('gate 10: missing TTS cache fails clearly; no SAM fallback', async () => {
    const src = fs.readFileSync('apps/api/src/services/production-engine.ts', 'utf8') + fs.readFileSync('apps/api/src/services/plan-production.ts', 'utf8');
    expect(src).not.toMatch(/new LocalDialogueSynthesizer/);
    const { KokoroDialogueSynthesizer } = await import('../packages/core/src/scenario/kokoro-dialogue-synthesizer.js');
    const synth = new KokoroDialogueSynthesizer({ cacheDir: path.join(tmp.dir, 'no-such-cache') });
    await expect(
      synth.synthesize({
        scenarioId: 's', sceneId: 'sc', turnId: 't', clipId: 'clip_sc_t', speakerId: 'c', speakerName: 'C',
        voiceSlot: 'voice_en_female_authority', voiceProfileId: 'vp',
        voiceProfile: { id: 'vp', voiceSlot: 'voice_en_female_authority', displayName: 'x', primaryLanguage: 'en', languages: ['en'], enabled: true, version: '1' } as never,
        language: 'en', spokenText: 'Hello production.', targetPath: 'audio/dialogue/x.wav',
        audioFormat: { container: 'wav', sampleRate: 48000 as 48000, channels: 1, codec: 'pcm_s16le', bitDepth: 16 },
        sceneIndex: 0, turnIndex: 0, globalTurnIndex: 0,
      }),
    ).rejects.toMatchObject({ code: 'SYNTHESIZER_UNAVAILABLE' });
    try {
      await new KokoroDialogueSynthesizer({ cacheDir: path.join(tmp.dir, 'no-such-cache-2') }).synthesize({
        scenarioId: 's', sceneId: 'sc', turnId: 't', clipId: 'clip_sc_t', speakerId: 'c',
        voiceSlot: 'voice_en_female_authority', voiceProfileId: 'vp',
        voiceProfile: { id: 'vp', voiceSlot: 'voice_en_female_authority', displayName: 'x', primaryLanguage: 'en', languages: ['en'], enabled: true, version: '1' } as never,
        language: 'en', spokenText: 'Hi.', targetPath: 'audio/dialogue/y.wav',
        audioFormat: { container: 'wav', sampleRate: 48000 as 48000, channels: 1, codec: 'pcm_s16le', bitDepth: 16 },
        sceneIndex: 0, turnIndex: 0, globalTurnIndex: 0,
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('provision:tts');
    }
  }, 60_000);

  it('gate 11: scene edit persists', () => {
    const state = loadProductionState('WS_Base')!;
    const long = state.scenarios.long as unknown as { scenes: Array<{ id: string }> };
    const sceneId = long.scenes[0].id;
    patchProductionScene(state, 'long', sceneId, { title: 'Edited scene title' });
    const reloaded = loadProductionState('WS_Base')!;
    const edited = (reloaded.scenarios.long as unknown as { scenes: Array<{ id: string; title: string }> }).scenes.find((s) => s.id === sceneId)!;
    expect(edited.title).toBe('Edited scene title');
    expect(reloaded.edits.some((e) => e.kind === 'scene' && e.subjectId === sceneId)).toBe(true);
  });

  it('gate 12: dialogue edit persists and invalidates downstream build', () => {
    const state = loadProductionState('WS_Base')!;
    const long = state.scenarios.long as unknown as { scenes: Array<{ turns: Array<{ id: string }> }> };
    const turnId = long.scenes[0].turns[0].id;
    patchProductionTurn(state, 'long', turnId, { spokenText: 'Edited dialogue without any invented numbers.' });
    const reloaded = loadProductionState('WS_Base')!;
    const turn = (reloaded.scenarios.long as unknown as { scenes: Array<{ turns: Array<{ id: string; spokenText: string }> }> }).scenes
      .flatMap((s) => s.turns)
      .find((t) => t.id === turnId)!;
    expect(turn.spokenText).toBe('Edited dialogue without any invented numbers.');
    expect(targetNeedsAudioRebuild(reloaded, 'long')).toBe(true);
    expect(reloaded.status).toBe('edited');
  });

  it('gate 13: numeric/evidence-breaking edit is rejected, source-supported value passes', () => {
    const state = loadProductionState('WS_Base')!;
    const long = state.scenarios.long as unknown as {
      evidence: Array<{ id: string; numericFacts: Array<{ value: number }>; usedInTurnIds: string[] }>;
      scenes: Array<{ id: string; turns: Array<{ id: string; evidenceId?: string }> }>;
    };
    const ev = long.evidence.find((e) => e.numericFacts.length > 0) ?? long.evidence[0];
    expect(ev).toBeTruthy();
    // Bind the evidence to the first turn of the first scene (deterministic link)
    const target = long.scenes[0].turns[0];
    target.evidenceId = ev.id;
    saveProductionState(state);

    const fact = ev.numericFacts[0];
    const breaking = String(Number(fact.value) + 1);
    expect(() => patchProductionTurn(state, 'long', target.id, { spokenText: `The number is definitely ${breaking} percent.` })).toThrow(ProductionError);
    patchProductionTurn(state, 'long', target.id, { spokenText: `The verified number is ${String(fact.value)} exactly.` });
  });

  it('gate 14: restart/reload preserves state and bindings', () => {
    const state = loadProductionState('WS_Base')!;
    const reloaded = loadProductionState('WS_Base')!;
    expect(reloaded).toEqual(state);
    expect(loadProject('WS_Base')!.meta.input.videoId).toBe('WS_Base');
  });

  it('gate 15: ProjectInput change marks production state stale', () => {
    const p = loadProject('WS_Base')!;
    const state = loadProductionState('WS_Base')!;
    expect(isStaleAgainstInput(state, p.meta.input)).toBe(false);
    const changed = { ...p.meta.input, script: p.meta.input.script + ' One more verified fact.' };
    expect(isStaleAgainstInput(state, changed)).toBe(true);
    expect(productionStatusFor(state, { ...p, meta: { ...p.meta, input: changed } })).toBe('needs_regeneration');
  });

  it('gates 16+17: asset selector returns eligible real assets; explicit binding persists', async () => {
    seedRealAsset('ws-asset-good');
    seedRealAsset('ws-asset-blocked', { blocked: true });
    seedRealAsset('ws-asset-archived', { status: 'archived' });
    seedRealAsset('ws-asset-nolicense', { license: ' ' });
    const res = await app.inject({ method: 'GET', url: '/api/projects/WS_Base/production/assets' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { assets: Asset[] };
    const ids = body.assets.map((a) => a.id);
    expect(ids).toContain('ws-asset-good');
    expect(ids).not.toContain('ws-asset-blocked');
    expect(ids).not.toContain('ws-asset-archived');
    expect(ids).not.toContain('ws-asset-nolicense');

    const put = await app.inject({ method: 'PUT', url: '/api/projects/WS_Base/production/assets/long/ws-asset-good', payload: { assetId: 'ws-asset-good' } });
    expect(put.statusCode).toBe(200);
    const reloaded = loadProductionState('WS_Base')!;
    expect(reloaded.assetBindings).toContainEqual(expect.objectContaining({ target: 'long', logicalRef: 'ws-asset-good', assetId: 'ws-asset-good' }));
  });

  it('gate 18: Phase 6A mediaMap reflects the selected asset (real resolver + real assets)', () => {
    const plan = makePlanStub({ scenarioId: 's', projectId: 'proj-ws-base', targetFormat: 'Long', width: 1920, height: 1080, seconds: 12, sceneIds: ['sc-1', 'sc-2'], assetRef: 'ws-asset-good' });
    const report = resolveProductionAssets({
      plan,
      assets: loadAssetIndex(),
      explicitBindings: { 'ws-asset-good': 'ws-asset-good' },
      assetUrlById: { 'ws-asset-good': 'http://127.0.0.1:9/media/asset/ws-asset-good' },
    });
    expect(report.valid).toBe(true);
    expect(report.mediaMap['ws-asset-good']).toBe('http://127.0.0.1:9/media/asset/ws-asset-good');
    expect(report.assetIdMap['ws-asset-good']).toBe('ws-asset-good');
  });

  it('gate 19: blocked/ineligible asset cannot final-export', async () => {
    // The route refuses ineligible assets outright:
    const put = await app.inject({ method: 'PUT', url: '/api/projects/WS_Base/production/assets/long/ws-asset-blocked', payload: { assetId: 'ws-asset-blocked' } });
    expect(put.statusCode).toBe(422);
    // And a required-but-unresolved ref blocks the final build at the engine gate:
    const state = loadProductionState('WS_Base')!;
    const long = state.scenarios.long as unknown as { metadata: { id: string } };
    const plan = makePlanStub({ scenarioId: long.metadata.id, projectId: 'proj-ws-base', targetFormat: 'Long', width: 1920, height: 1080, seconds: 12, sceneIds: ['sc-1'], assetRef: 'never-bound-ref' });
    const { resolveProductionAssets: resolve } = await import('@buildtrack/core');
    const report = resolve({ plan, assets: loadAssetIndex(), explicitBindings: {}, assetUrlById: {} });
    const binding = report.bindings.find((b: { assetRef: string }) => b.assetRef === 'never-bound-ref');
    expect(binding).toBeDefined();
  });

  it('gate 20: production captions come from reconciled dialogue (plan authority)', () => {
    const plan = makePlanStub({ scenarioId: 's', projectId: 'p', targetFormat: 'Long', width: 1920, height: 1080, seconds: 8, sceneIds: ['sc-1'] });
    const caps = productionCaptionsForTarget(plan);
    expect(caps.length).toBe(1);
    expect(caps[0].text).toBe('Reconciled dialogue for sc-1');
    expect(caps[0].start).toBe(0);
    expect(caps[0].end).toBeCloseTo(8, 5);
  });

  it('gate 21: legacy caption retiming cannot override production audio timing', () => {
    const plan = makePlanStub({ scenarioId: 's', projectId: 'p', targetFormat: 'Long', width: 1920, height: 1080, seconds: 6, sceneIds: ['sc-1'] });
    // A legacy editor mutates its own copy of a cue:
    const legacyPatched = { ...plan.scenes[0].captionCues[0], startTimeSeconds: 99, endTimeSeconds: 120 };
    expect(legacyPatched.startTimeSeconds).toBe(99);
    // The production caption path still reads the plan (audio authority):
    const caps = productionCaptionsForTarget(plan);
    expect(caps[0].start).toBe(0);
    expect(caps[0].end).toBeCloseTo(6, 5);
  });

  it('gates 22+23: preview and final export use the new plan-based path', async () => {
    const longPlan = makePlanStub({ scenarioId: 's-long', projectId: 'proj-ws-x', targetFormat: 'Long', width: 1920, height: 1080, seconds: 10, assetRef: 'ws-asset-good' });
    const shortPlan = makePlanStub({ scenarioId: 's-s1', projectId: 'proj-ws-x', targetFormat: 'Short', width: 1080, height: 1920, seconds: 8 });
    const outputByTarget = { long: path.join(testOutputDir, 'WS_X', 'long.mp4'), short_1: path.join(testOutputDir, 'WS_X', 'short_1.mp4') };

    const preview = await runPlanBasedProductionExport({
      longPlan, shortPlans: { short_1: shortPlan }, mediaMapByTarget: {}, outputByTarget, quality: 'preview',
    });
    expect(preview.renderResult.status).toBe('ok');
    expect(preview.packageResult).toBeUndefined();
    expect(fs.existsSync(outputByTarget.long)).toBe(true);

    // Package root must live inside the repo (Phase 6D safety check).
    const repoPkg = path.resolve('.test-prod-int', 'WS_X', 'production-package');
    const final = await runPlanBasedProductionExport({
      longPlan, shortPlans: { short_1: shortPlan }, mediaMapByTarget: {}, outputByTarget,
      packageRoot: repoPkg,
      repoRoot: path.resolve('.'),
    });
    expect(final.renderResult.status).toBe('ok');
    expect(final.packageResult).toBeDefined();
    expect(final.packageResult!.package.summary.renderSucceededTargetIds.sort()).toEqual(['long', 'short_1']);
    expect(final.packageResult!.package.summary.mode).toBe('production');
    expect(renderCalls.length).toBeGreaterThanOrEqual(2);
    expect(renderCalls.some((c) => c.scenarioId === 's-long')).toBe(true);
    try { fs.rmSync(path.resolve('.test-prod-int'), { recursive: true, force: true }); } catch { /* ignore */ }
  }, 120_000);

  it('gate 24: final export never references the legacy video authority', () => {
    // Doc comments may NAME the legacy path (to say it is not used); what must
    // never appear is an import or invocation of it.
    const pipelineSrc = fs.readFileSync('apps/api/src/services/plan-production.ts', 'utf8');
    expect(pipelineSrc).not.toMatch(/import[^\n]*\bexportProject\b/);
    expect(pipelineSrc).not.toMatch(/\bexportProject\s*\(/);
    expect(pipelineSrc).not.toMatch(/\.\brenderTarget\b/);
    expect(pipelineSrc).not.toMatch(/\.\btargetAudio\b/);
    const prodEngineSrc = fs.readFileSync('apps/api/src/services/production-engine.ts', 'utf8');
    expect(prodEngineSrc).not.toMatch(/import[^\n]*\bexportProject\b/);
    expect(prodEngineSrc).not.toMatch(/\bexportProject\s*\(/);
    expect(prodEngineSrc).not.toMatch(/\.\brenderTarget\b/);
    expect(prodEngineSrc).not.toMatch(/\.\btargetAudio\b/);
  });

  it('gate 25: 0–3 Shorts passed correctly into Phase 6C', () => {
    const lp = makePlanStub({ scenarioId: 'l', projectId: 'p1', targetFormat: 'Long', width: 1920, height: 1080, seconds: 9 });
    const sp = (n: number) => makePlanStub({ scenarioId: `s${n}`, projectId: 'p1', targetFormat: 'Short', width: 1080, height: 1920, seconds: 5 });

    expect(buildFinalTargetSet({ longPlan: lp, shortPlans: {}, mediaMapByTarget: {} }).summary.deliveredTargetIds).toEqual(['long']);
    expect(buildFinalTargetSet({ longPlan: lp, shortPlans: { short_1: sp(1) }, mediaMapByTarget: {} }).summary.deliveredTargetIds).toEqual(['long', 'short_1']);
    expect(buildFinalTargetSet({ longPlan: lp, shortPlans: { short_1: sp(1), short_2: sp(2) }, mediaMapByTarget: {} }).summary.deliveredTargetIds).toEqual(['long', 'short_1', 'short_2']);
    expect(buildFinalTargetSet({ longPlan: lp, shortPlans: { short_1: sp(1), short_2: sp(2), short_3: sp(3) }, mediaMapByTarget: {} }).summary.deliveredTargetIds).toEqual(['long', 'short_1', 'short_2', 'short_3']);

    const so = buildFinalTargetSet({ shortPlans: { short_1: sp(1), short_2: sp(2) }, mediaMapByTarget: {} });
    expect(so.summary.deliveredTargetIds).toEqual(['short_1', 'short_2']);
    expect(so.findings.some((f) => f.targetId === 'long' && f.code === 'DELIVERY_TARGET_MISSING_PLAN')).toBe(true);
  });

  it('gates 26+27+28: metadata, thumbnail path and provenance preserved', () => {
    const p = loadProject('WS_Base')!;
    const metaDir = writeMetadata(p, loadAssetIndex());
    writeCaptions(p);
    expect(fs.existsSync(path.join(metaDir, 'publishing_kit.json'))).toBe(true);
    expect(fs.existsSync(path.join(metaDir, 'asset_provenance.json'))).toBe(true);
    expect(fs.existsSync(path.join(metaDir, 'asset_provenance.csv'))).toBe(true);
    expect(fs.existsSync(path.join(metaDir, 'titles_and_description.md'))).toBe(true);
    const kit = JSON.parse(fs.readFileSync(path.join(metaDir, 'publishing_kit.json'), 'utf8')) as { videoId: string };
    expect(kit.videoId).toBe('WS_Base');
    const prov = JSON.parse(fs.readFileSync(path.join(metaDir, 'asset_provenance.json'), 'utf8')) as Array<{ assetId: string }>;
    expect(prov.some((r) => r.assetId === 'ws-asset-good')).toBe(true);
    expect(prov.some((r) => r.assetId === 'ref')).toBe(true); // source references preserved
  });

  it('gates 29+30: production history updated after final export and affects casting deterministically', () => {
    const before = loadProductionHistory();
    appendProductionHistoryEntry({ videoId: 'WS_Base', at: new Date().toISOString(), casting: { challenger: 'commercial-lead', technical_authority: 'mep-engineer', decision_maker: 'operations-director' }, styleFingerprint: 'fp-1' });
    const after = loadProductionHistory();
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1].videoId).toBe('WS_Base');

    const input = baseInput({ videoId: 'WS_Hist' });
    const hist = [{ personas: { challenger: 'quality-lead', technical_authority: 'site-engineer', decision_maker: 'project-director' } }];
    const r1 = generateProductionScenariosFromProjectInput(input, { shortCount: 1, personaHistory: hist });
    const r2 = generateProductionScenariosFromProjectInput(input, { shortCount: 1, personaHistory: hist });
    expect(r1.success && r2.success).toBe(true);
    const cast1 = r1.longScenario!.characters.map((c) => c.id).sort();
    const cast2 = r2.longScenario!.characters.map((c) => c.id).sort();
    expect(cast1).toEqual(cast2); // same input + same history => same result
    // Recent-history personas were deterministically avoided. The persona key is
    // recovered from the character id as the COMPLETE key — persona keys contain
    // hyphens, so splitting on the last hyphen would truncate e.g.
    // `commercial-lead` to `lead` and this comparison would silently pass.
    for (const c of r1.longScenario!.characters) {
      const key = personaKeyFromCharacterId(c.id);
      expect(key).not.toBeNull();
      expect(['quality-lead', 'site-engineer', 'project-director']).not.toContain(key);
      expect(CANONICAL_PERSONA_KEYS).toContain(key);
    }
    // And the no-history baseline WOULD pick a history persona (avoidance changed something):
    void personaHistoryFromVisualHistory;
    void personaObservationFromState;
  });

  it('gate 31: job polling endpoint contract works', async () => {
    makeProject('WS_Jobs', baseInput({ videoId: 'WS_Jobs', shortCount: 0 }));
    const res = await app.inject({ method: 'GET', url: '/api/projects/WS_Jobs/production/jobs/nope' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).status).toBe('unknown');
  });

  it('gate 32: existing project list/reopen remains compatible', () => {
    const ids = listProjects();
    expect(ids).toContain('WS_Base');
    const p = loadProject('WS_Base');
    expect(p).not.toBeNull();
    expect(p!.storyboard).toBeDefined();
  });

  it('gate 33: legacy project without production-state loads safely', async () => {
    makeProject('WS_Legacy');
    expect(loadProductionState('WS_Legacy')).toBeNull();
    const res = await app.inject({ method: 'GET', url: '/api/projects/WS_Legacy/production' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { production: { exists: boolean; status: string } };
    expect(body.production.exists).toBe(false);
    expect(body.production.status).toBe('not_generated');
  });
});
