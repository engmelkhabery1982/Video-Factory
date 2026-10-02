/**
 * Phase 6D — production delivery package + QC CONTRACT.
 *
 * These tests prove the packaging contract end to end WITHOUT Remotion: the
 * authority is the real Phase 6C contract (plans built by the approved
 * Scenario -> Phase 5 pipeline, a real `ProductionDeliveryTargetSet` and a real
 * `ProductionDeliveryRenderResult`), and the media is genuinely encoded H.264 /
 * AAC MP4 produced locally with ffmpeg, so every probe, SHA256 and duration
 * assertion is made against real bytes on disk.
 *
 * The real Remotion render path is proven separately, and cost-controlled, in
 * `phase6d-real-package.test.ts`.
 *
 * Layout and authority rules under test (Phase 6D):
 *   §2  identity comes from the target set, never from a filename
 *   §3  target / render-result matching is strict and structured
 *   §4  ready / partial / blocked package status
 *   §5  deterministic package layout
 *   §6  stable in-package file names
 *   §7  media is COPIED, never moved or re-encoded
 *   §8  SHA256 for every packaged artifact
 *   §9  captions are plan-derived only
 *   §10 caption validation against the plan's authoritative timing
 *   §12 target descriptor
 *   §13 real media technical QC
 *   §14/§15 technical + duration QC against the target contract
 *   §16 audio QC
 *   §17 asset / media contract QC
 *   §18 plan validation delegated to Phase 6B
 *   §20 QC JSON + Markdown evidence
 *   §21/§22 manifest + determinism
 *   §23 package summary
 *   §24 package root safety
 *   §25/§26 partial and blocked delivery
 *   §30 production full-coverage rule
 *   §32 portable package
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  DELIVERY_TARGET_ORDER,
  PRODUCTION_DELIVERY_PACKAGE_VERSION,
  buildProductionDeliveryTargets,
  buildProductionDeliveryPackage,
  compileScenarioVisualPlan,
  getProgressMeetingScenario,
  loadScenarioFixture,
  packageTargetDirectory,
  packageTargetFile,
  validatePlanForRender,
  type DeliveryTargetId,
  type ProductionDeliveryPackage,
  type ProductionDeliveryRenderResult,
  type ProductionDeliveryTarget,
  type ProductionDeliveryTargetRenderResult,
  type ProductionDeliveryTargetSet,
  type ProductionPackageFindingCode,
  type RemotionCompositionPlan,
  type Scenario,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';
import {
  ProductionDeliveryPackageError,
  buildProductionDeliveryPackage as buildPackage,
  productionPackageErrorCodes,
  type ProductionDeliveryPackageBuildResult,
} from '../apps/api/src/services/plan-package.js';
import { ffmpegPath } from '../apps/api/src/services/platform.js';
import { cleanupPhase6dScratch, createPhase6dScratch } from './helpers/phase6d-scratch.js';

/* ------------------------------------------------------------------ */
/*  Scratch                                                             */
/* ------------------------------------------------------------------ */

/*
 * THIS suite's own scratch root. It used to be a SHARED parent
 * (`.test-phase6d`) that this suite deleted recursively, racing the phase-6D
 * real-render suite that kept its dialogue audio in `.test-phase6d/real-audio`.
 * Each suite now owns a unique root and removes only that root.
 */
const SCRATCH_ROOT = createPhase6dScratch('delivery');
const AUDIO_SCRATCH = `${SCRATCH_ROOT}/audio`;
const FIXTURE_DIR = `${SCRATCH_ROOT}/fixtures`;
const PACKAGE_DIR = `${SCRATCH_ROOT}/packages`;
const REPO_ROOT = process.cwd();
const CANONICAL_PROJECT_ID = 'proj-hospital-expansion';
const LONG_SCENARIO_ID = 'scenario-pm-01';
const LONG_ASSET_REF = 'asset-iva-progress-chart';

/** Real ffmpeg-encoded media; never checked into git. */
const FIXTURES = {
  longOk: path.join(FIXTURE_DIR, 'long-ok.mp4'),
  shortOk: path.join(FIXTURE_DIR, 'short-ok.mp4'),
  longWrongDims: path.join(FIXTURE_DIR, 'long-wrong-dims.mp4'),
  longWrongFps: path.join(FIXTURE_DIR, 'long-wrong-fps.mp4'),
  longNoAudio: path.join(FIXTURE_DIR, 'long-no-audio.mp4'),
  longMp3Audio: path.join(FIXTURE_DIR, 'long-mp3-audio.mp4'),
  longMpeg4: path.join(FIXTURE_DIR, 'long-mpeg4.mp4'),
  longSilent: path.join(FIXTURE_DIR, 'long-silent.mp4'),
  longTruncated: path.join(FIXTURE_DIR, 'long-truncated.mp4'),
  shortTruncated: path.join(FIXTURE_DIR, 'short-truncated.mp4'),
  longZero: path.join(FIXTURE_DIR, 'long-zero.mp4'),
} as const;

/* ------------------------------------------------------------------ */
/*  Fixture media                                                       */
/* ------------------------------------------------------------------ */

function encode(args: string[]): void {
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
}

/** Solid-tone video + audible tone, the cheapest real H.264/AAC MP4. */
function encodeAvi(
  file: string,
  opts: { w: number; h: number; fps: number; seconds: number; video?: string; audio?: string | null; tone?: boolean },
): void {
  const input: string[] = ['-f', 'lavfi', '-i', `color=c=0x3a6ea5:s=${opts.w}x${opts.h}:r=${opts.fps}:d=${opts.seconds}`];
  const audioKind = opts.audio === undefined ? 'aac' : opts.audio;
  if (audioKind !== null) {
    // The bundled ffmpeg build predates `anullsrc=d=`, so the silent source is
    // left infinite and bounded by `-shortest` against the 3s video.
    input.push('-f', 'lavfi', '-i', opts.tone === false ? 'anullsrc=r=48000:cl=mono' : `sine=frequency=440:sample_rate=48000:duration=${opts.seconds}`);
  }
  const codec: string[] = opts.video ?? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  const audioArgs: string[] =
    audioKind === null ? [] : audioKind === 'aac' ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-c:a', audioKind, '-b:a', '128k'];
  encode([...input, ...codec, ...audioArgs, '-shortest', file]);
}

/* ------------------------------------------------------------------ */
/*  Plans (the approved Scenario -> Phase 5 chain, never hand-built)    */
/* ------------------------------------------------------------------ */

let planSeq = 0;

async function buildPlan(scenario: Scenario): Promise<RemotionCompositionPlan> {
  const tag = `p6d-${++planSeq}`;
  const visual: any = compileScenarioVisualPlan(scenario);
  if (!visual.ok) throw new Error(`compileScenarioVisualPlan failed: ${JSON.stringify(visual.errors)}`);
  const dialogue: any = await buildDialogueProductionPlan(scenario, {
    synthesisBasePath: `${AUDIO_SCRATCH}/${tag}/audio/dialogue`,
    canonicalBasePath: `${AUDIO_SCRATCH}/${tag}/audio/canonical`,
  });
  if (!dialogue.success) throw new Error(`buildDialogueProductionPlan failed: ${dialogue.error}`);
  const visualProd: any = buildVisualProductionPlan({ scenario, visualPlan: visual.plan, dialogueResult: dialogue.result });
  if (!visualProd.success) throw new Error(`buildVisualProductionPlan failed: ${visualProd.error}`);
  const sceneRender: any = buildSceneRenderPlan({ scenario, visualProductionPlan: visualProd.plan });
  if (!sceneRender.success) throw new Error(`buildSceneRenderPlan failed: ${sceneRender.error}`);
  const remotion: any = buildRemotionCompositionProps(sceneRender.plan);
  if (!remotion.success) throw new Error(`buildRemotionCompositionProps failed: ${remotion.error}`);
  return remotion.plan as RemotionCompositionPlan;
}

function shortScenario(scenarioId: string, projectId = CANONICAL_PROJECT_ID): Scenario {
  const base = loadScenarioFixture('schedule-risk');
  base.metadata = { ...base.metadata, targetFormat: 'Short', projectId, id: scenarioId };
  return base;
}

let longPlan: RemotionCompositionPlan;
let shortPlan1: RemotionCompositionPlan;
let shortPlan2: RemotionCompositionPlan;

beforeAll(async () => {
  // Clean slate for THIS suite only: never another suite's directory.
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  fs.mkdirSync(AUDIO_SCRATCH, { recursive: true });
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.mkdirSync(PACKAGE_DIR, { recursive: true });

  longPlan = await buildPlan(structuredClone(getProgressMeetingScenario()));
  shortPlan1 = await buildPlan(structuredClone(shortScenario('scenario-sched-risk-03')));
  shortPlan2 = await buildPlan(structuredClone(shortScenario('scenario-sched-risk-03-s2')));

  // Real media sized to each target's own structural frame capacity.
  encodeAvi(FIXTURES.longOk, { w: 1920, h: 1080, fps: 30, seconds: 118.9 });
  encodeAvi(FIXTURES.shortOk, { w: 1080, h: 1920, fps: 30, seconds: 49.0 });
  // Cheap, deliberately wrong media.
  encodeAvi(FIXTURES.longWrongDims, { w: 1280, h: 720, fps: 30, seconds: 3 });
  encodeAvi(FIXTURES.longWrongFps, { w: 1920, h: 1080, fps: 24, seconds: 3 });
  encodeAvi(FIXTURES.longNoAudio, { w: 1920, h: 1080, fps: 30, seconds: 3, audio: null });
  encodeAvi(FIXTURES.longMp3Audio, { w: 1920, h: 1080, fps: 30, seconds: 3, audio: 'libmp3lame' });
  encodeAvi(FIXTURES.longMpeg4, { w: 1920, h: 1080, fps: 30, seconds: 3, video: ['-c:v', 'mpeg4', '-q:v', '8'] });
  encodeAvi(FIXTURES.longSilent, { w: 1920, h: 1080, fps: 30, seconds: 3, tone: false });
  encodeAvi(FIXTURES.longTruncated, { w: 1920, h: 1080, fps: 30, seconds: 3 });
  encodeAvi(FIXTURES.shortTruncated, { w: 1080, h: 1920, fps: 30, seconds: 3 });
  fs.writeFileSync(FIXTURES.longZero, '');
}, 600_000);

afterAll(() => {
  /* Remove exactly this suite's own scratch root; nothing shared, nothing else. */
  cleanupPhase6dScratch(SCRATCH_ROOT);
});

/* ------------------------------------------------------------------ */
/*  Test helpers                                                        */
/* ------------------------------------------------------------------ */

function makeSet(
  opts: { shorts?: DeliveryTargetId[]; long?: RemotionCompositionPlan | null } = {},
): ProductionDeliveryTargetSet {
  const shortPlans: Record<string, RemotionCompositionPlan> = {};
  for (const id of opts.shorts ?? []) {
    shortPlans[id] = id === 'short_2' ? shortPlan2 : shortPlan1;
  }
  return buildProductionDeliveryTargets({
    longPlan: opts.long === undefined ? longPlan : opts.long,
    shortPlans: Object.keys(shortPlans).length ? (shortPlans as any) : undefined,
    mediaMapByTarget: { long: { [LONG_ASSET_REF]: 'http://127.0.0.1/x/chart.png' } },
  });
}

/** A realistic, successful Phase 6C render entry for one target. */
function successEntry(
  target: ProductionDeliveryTarget,
  outputFile: string,
  overrides: Partial<ProductionDeliveryTargetRenderResult> = {},
): ProductionDeliveryTargetRenderResult {
  return {
    targetId: target.targetId,
    success: true,
    format: target.format,
    scenarioId: target.scenarioId,
    projectId: target.projectId,
    outputFile,
    renderResult: {
      outputFile,
      compositionId: 'VideoPlan',
      scenarioId: target.scenarioId,
      projectId: target.projectId,
      fps: target.fps,
      width: target.width,
      height: target.height,
      durationInFrames: target.durationInFrames,
      renderedFrameCount: target.durationInFrames,
      authoritativeDurationSeconds: target.authoritativeDurationSeconds,
      renderedWithAudio: true,
      mediaMapEntryCount: Object.keys(target.mediaMap).length,
      renderTimeMs: 1,
    },
    ...overrides,
  };
}

function failureEntry(target: ProductionDeliveryTarget, outputFile: string | null, code = 'PLAN_RENDER_FAILED'): ProductionDeliveryTargetRenderResult {
  return {
    targetId: target.targetId,
    success: false,
    format: target.format,
    scenarioId: target.scenarioId,
    projectId: target.projectId,
    outputFile,
    error: { code, message: `synthetic render failure for ${target.targetId}`, targetId: target.targetId },
  };
}

function makeRenderResult(results: ProductionDeliveryTargetRenderResult[]): ProductionDeliveryRenderResult {
  const succeeded = results.filter((r) => r.success).map((r) => r.targetId);
  const failed = results.filter((r) => !r.success).map((r) => r.targetId);
  return {
    version: '1.0.0',
    status: results.length === 0 || succeeded.length === 0 ? 'error' : failed.length === 0 ? 'ok' : 'partial',
    targetCount: results.length,
    succeededTargetIds: succeeded,
    failedTargetIds: failed,
    results,
    findings: [],
  };
}

let packageSeq = 0;
async function build(
  name: string,
  set: ProductionDeliveryTargetSet,
  renderResult: ProductionDeliveryRenderResult,
  opts: { mode?: 'production' | 'test-evidence' } = {},
): Promise<ProductionDeliveryPackageBuildResult> {
  return buildPackage({
    targetSet: set,
    renderResult,
    packageRoot: path.join(PACKAGE_DIR, name),
    mode: opts.mode ?? 'production',
    clean: 'full',
  });
}

/** A content digest of everything a build can turn into package content. */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex').slice(0, 16);
}

function signature(
  set: ProductionDeliveryTargetSet,
  renderResult: ProductionDeliveryRenderResult,
  opts: { mode?: 'production' | 'test-evidence'; name?: string },
): string {
  return [opts.name ?? '', opts.mode ?? 'production', digest(set), digest(renderResult)].join('|');
}

/**
 * Probing real media with `analyseFile` is the point of these tests, so it is
 * never stubbed - but the SAME logical package only has to be built (and
 * probed) once. Several `it` blocks read the very same on-disk package.
 */
const built = new Map<string, Promise<ProductionDeliveryPackageBuildResult>>();
function pkg(
  set: ProductionDeliveryTargetSet,
  renderResult: ProductionDeliveryRenderResult,
  opts: { mode?: 'production' | 'test-evidence'; name?: string } = {},
): Promise<ProductionDeliveryPackageBuildResult> {
  const key = signature(set, renderResult, opts);
  const cached = built.get(key);
  if (cached) return cached;
  const promise = build(opts.name ?? `p${++packageSeq}`, set, renderResult, opts);
  built.set(key, promise);
  return promise;
}

const abs = (root: string, relative: string) => path.join(root, ...relative.split('/'));
const read = (root: string, relative: string) => fs.readFileSync(abs(root, relative), 'utf8');
const exists = (root: string, relative: string) => fs.existsSync(abs(root, relative));
const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const codesFor = (p: ProductionDeliveryPackage, targetId: DeliveryTargetId) =>
  p.targets.find((t) => t.targetId === targetId)?.qc?.findings.map((f) => f.code) ?? [];
const targetOf = (set: ProductionDeliveryTargetSet, id: DeliveryTargetId) => set.targets.find((t) => t.targetId === id)!;
const errorCodesOf = (p: ProductionDeliveryPackage) => productionPackageErrorCodes(p.findings);
const targetErrors = (p: ProductionDeliveryPackage, id: DeliveryTargetId) =>
  p.targets.find((t) => t.targetId === id)?.error?.code ?? null;

/* ================================================================== */
/*  §1/§2 — the canonical Long and Short package contract              */
/* ================================================================== */

describe('Phase 6D §1/§2 — valid Long and Short package contracts', () => {
  it('packages the canonical Long target as a real 1920x1080 delivery', async () => {
    const set = makeSet();
    expect(set.valid).toBe(true);
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    const p = res.package;

    expect(p.version).toBe(PRODUCTION_DELIVERY_PACKAGE_VERSION);
    expect(p.status).toBe('ready');
    expect(p.readyForProductionDelivery).toBe(true);
    expect(p.projectId).toBe(CANONICAL_PROJECT_ID);
    expect(errorCodesOf(p)).toEqual([]);

    const long = p.targets.find((t) => t.targetId === 'long')!;
    expect(long.status).toBe('packaged');
    expect(long.productionReady).toBe(true);
    expect(long.directory).toBe('long');
    expect(long.qc!.status).toBe('pass');
    expect(long.descriptor!.width).toBe(1920);
    expect(long.descriptor!.height).toBe(1080);
    expect(long.descriptor!.authoritativeDurationSeconds).toBe(118.74);
    expect(long.descriptor!.durationInFrames).toBe(3563);
    expect(long.descriptor!.sceneCount).toBe(5);
    expect(long.descriptor!.canonicalAudioRefCount).toBe(12);
    expect(long.descriptor!.captionCueCount).toBe(28);
    expect(long.descriptor!.assetRefCount).toBe(2);
    expect(long.descriptor!.mediaMapEntryCount).toBe(1);
    expect(long.descriptor!.compositionId).toBe('VideoPlan');
    expect(long.descriptor!.renderedWithAudio).toBe(true);
    expect(long.descriptor!.fullFrameCoverage).toBe(true);

    // §13 real media technical QC of the COPIED packaged MP4.
    const m = long.qc!.metrics;
    expect(m.videoCodec).toBe('h264');
    expect(m.width).toBe(1920);
    expect(m.height).toBe(1080);
    expect(m.fps).toBe(30);
    expect(m.hasAudio).toBe(true);
    expect(m.audioCodec).toBe('aac');
    expect(m.audioSampleRate).toBe(48000);
    expect(m.sizeBytes).toBe(fs.statSync(FIXTURES.longOk).size);
    expect(m.containerFormat).toContain('mp4');
  }, 120_000);

  it('packages a real 1080x1920 Short target from its own plan', async () => {
    // The Long is always requested by Phase 6C, so a real ready package renders
    // and packages both targets.
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]));
    const p = res.package;
    expect(p.status).toBe('ready');
    expect(p.targets.find((t) => t.targetId === 'short_1')!.directory).toBe('shorts/short_1');

    const short = p.targets.find((t) => t.targetId === 'short_1')!;
    expect(short.descriptor!.width).toBe(1080);
    expect(short.descriptor!.height).toBe(1920);
    expect(short.descriptor!.authoritativeDurationSeconds).toBe(48.99);
    expect(short.descriptor!.durationInFrames).toBe(1470);
    expect(short.descriptor!.canonicalAudioRefCount).toBe(7);
    expect(short.descriptor!.captionCueCount).toBe(15);
    expect(short.qc!.metrics.videoCodec).toBe('h264');
    expect(short.qc!.metrics.audioCodec).toBe('aac');
  }, 120_000);

  it('§3 orders targets long -> short_1 -> short_2 -> short_3 regardless of input order', async () => {
    const set = makeSet({ shorts: ['short_1', 'short_2'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk), successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    // short_2 was requested but never rendered, so it stays visible as failed,
    // in canonical position, and the packaged targets keep the canonical order.
    expect(res.package.manifest.targets.map((t) => t.targetId)).toEqual(['long', 'short_1', 'short_2']);
    expect(res.package.manifest.requestedTargetIds).toEqual(['long', 'short_1', 'short_2']);
    expect(res.package.manifest.packagedTargetIds).toEqual(['long', 'short_1']);
    expect(res.package.manifest.targets[2]!.status).toBe('failed');
    expect(res.package.summary.targetOrder).toEqual(['long', 'short_1']);
    expect(DELIVERY_TARGET_ORDER).toEqual(['long', 'short_1', 'short_2', 'short_3']);
  }, 180_000);
});

/* ================================================================== */
/*  §3 — strict target / render-result matching                        */
/* ================================================================== */

describe('Phase 6D §3 — target matching never infers identity from filenames', () => {
  it('4. rejects a target whose render result reports a different scenario', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk, { scenarioId: 'scenario-somewhere-else' })]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_TARGET_MISMATCH');
    expect(res.package.status).toBe('blocked');
    expect(exists(res.packageRoot, 'long/video.mp4')).toBe(false);
  }, 120_000);

  it('4b. rejects a render result whose project disagrees with the target', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk, { projectId: 'proj-other' })]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_TARGET_MISMATCH');
    expect(res.package.status).toBe('blocked');
  }, 120_000);

  it('4c. rejects a render result whose format disagrees with the target', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk, { format: 'Short' })]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_TARGET_MISMATCH');
  }, 120_000);

  it('5. rejects a render result for a target the target set never delivered', async () => {
    const set = makeSet(); // Long only - short_3 was never requested
    const ghost: ProductionDeliveryTargetRenderResult = {
      targetId: 'short_3',
      success: true,
      format: 'Short',
      scenarioId: 'scenario-sched-risk-03',
      projectId: CANONICAL_PROJECT_ID,
      outputFile: FIXTURES.shortOk,
      renderResult: {
        outputFile: FIXTURES.shortOk,
        compositionId: 'VideoPlan',
        scenarioId: 'scenario-sched-risk-03',
        projectId: CANONICAL_PROJECT_ID,
        fps: 30,
        width: 1080,
        height: 1920,
        durationInFrames: 1470,
        renderedFrameCount: 1470,
        authoritativeDurationSeconds: 48.99,
        renderedWithAudio: true,
        mediaMapEntryCount: 0,
        renderTimeMs: 1,
      },
    };
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), ghost]));
    const ghost3 = res.package.targets.find((t) => t.targetId === 'short_3')!;
    expect(ghost3.status).toBe('failed');
    expect(ghost3.error!.code).toBe('PACKAGE_RENDER_RESULT_MISMATCH');
    // The valid Long is untouched by the ghost.
    expect(res.package.targets.find((t) => t.targetId === 'long')!.status).toBe('packaged');
    expect(res.package.status).toBe('partial');
  }, 180_000);

  it('5b. rejects a requested target the render result never covered', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    const short1 = res.package.targets.find((t) => t.targetId === 'short_1')!;
    expect(short1.status).toBe('failed');
    expect(short1.error!.code).toBe('PACKAGE_RENDER_RESULT_MISMATCH');
    expect(exists(res.packageRoot, 'shorts/short_1/video.mp4')).toBe(false);
  }, 180_000);

  it('5c. rejects a render result whose encoded geometry disagrees with the plan', async () => {
    const set = makeSet();
    const entry = successEntry(targetOf(set, 'long'), FIXTURES.longOk);
    entry.renderResult!.width = 1080;
    entry.renderResult!.height = 1920;
    const res = await pkg(set, makeRenderResult([entry]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_TARGET_MISMATCH');
  }, 120_000);

  it('5d. rejects a render result whose output file disagrees with the delivery output', async () => {
    const set = makeSet();
    const entry = successEntry(targetOf(set, 'long'), FIXTURES.longOk);
    entry.renderResult!.outputFile = path.join(FIXTURE_DIR, 'long-ok-renamed.mp4');
    const res = await pkg(set, makeRenderResult([entry]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_RENDER_RESULT_MISMATCH');
  }, 120_000);

  it('5e. never infers a target id from the output file name', async () => {
    // A file literally named `short_1.mp4` handed to the Long target stays Long.
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.shortOk)]));
    const p = res.package;
    expect(p.targets.map((t) => t.targetId)).toEqual(['long']);
    expect(p.targets[0]!.qc!.metrics.width).toBe(1080);
    expect(p.targets[0]!.status).toBe('failed');
    expect(codesFor(p, 'long')).toContain('PACKAGE_DIMENSIONS_MISMATCH');
  }, 120_000);
});

/* ================================================================== */
/*  §7/§8 — copy, never move; SHA256 integrity                         */
/* ================================================================== */

describe('Phase 6D §7/§8 — source integrity and packaged hashes', () => {
  it('6. rejects a successful render whose output file does not exist', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), path.join(FIXTURE_DIR, 'nope.mp4'))]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_FILE_MISSING');
    expect(res.package.status).toBe('blocked');
  }, 60_000);

  it('7. rejects a zero-byte MP4', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longZero)]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_FILE_EMPTY');
    expect(res.package.status).toBe('blocked');
    expect(exists(res.packageRoot, 'long/video.mp4')).toBe(false);
  }, 60_000);

  it('8. never mutates the source render output (Long) and 9. hashes match', async () => {
    const set = makeSet();
    const before = sha256(FIXTURES.longOk);
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    const after = sha256(FIXTURES.longOk);

    expect(after).toBe(before);
    expect(res.sourceIntegrity).toHaveLength(1);
    const integrity = res.sourceIntegrity[0]!;
    expect(integrity.targetId).toBe('long');
    expect(integrity.sha256Before).toBe(before);
    expect(integrity.sha256After).toBe(after);
    expect(integrity.unchanged).toBe(true);
    expect(integrity.packagedSha256).toBe(before);
    expect(integrity.packagedMatchesSource).toBe(true);

    // The source still exists in place, and the copy is a separate file.
    expect(fs.existsSync(FIXTURES.longOk)).toBe(true);
    expect(sha256(abs(res.packageRoot, 'long/video.mp4'))).toBe(before);
    expect(res.package.targets[0]!.qc!.metrics.sourceUnchanged).toBe(true);
  }, 120_000);

  it('8b. never mutates the source render output (Short) and 9b. hashes match', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const before = sha256(FIXTURES.shortOk);
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]));
    expect(sha256(FIXTURES.shortOk)).toBe(before);
    const integrity = res.sourceIntegrity[0]!;
    expect(integrity.targetId).toBe('short_1');
    expect(integrity.unchanged).toBe(true);
    expect(integrity.packagedSha256).toBe(before);
    expect(sha256(abs(res.packageRoot, 'shorts/short_1/video.mp4'))).toBe(before);
  }, 120_000);

  it('8c. leaves the source media bytes untouched: no re-encode, no remux', async () => {
    const set = makeSet();
    const beforeSize = fs.statSync(FIXTURES.longOk).size;
    const beforeHead = fs.readFileSync(FIXTURES.longOk).subarray(0, 32).toString('hex');
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    const packagedHead = fs.readFileSync(abs(res.packageRoot, 'long/video.mp4')).subarray(0, 32).toString('hex');
    expect(fs.statSync(FIXTURES.longOk).size).toBe(beforeSize);
    expect(packagedHead).toBe(beforeHead);
    expect(fs.readFileSync(abs(res.packageRoot, 'long/video.mp4')).equals(fs.readFileSync(FIXTURES.longOk))).toBe(true);
  }, 120_000);

  it('10/11. writes a deterministic, lexicographically sorted checksums file', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const renderResult = makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]);
    const first = await pkg(set, renderResult, { name: 'checksums-a' });
    const second = await pkg(set, renderResult, { name: 'checksums-b' });

    const text = read(first.packageRoot, 'manifest/checksums.sha256');
    expect(text).toBe(read(second.packageRoot, 'manifest/checksums.sha256'));

    const lines = text.trim().split('\n');
    const paths = lines.map((l) => l.split('  ')[1]!);
    expect([...paths].sort()).toEqual(paths);
    for (const line of lines) {
      expect(line).toMatch(/^[0-9a-f]{64}  \S+$/);
      expect(line.includes('..')).toBe(false);
      expect(path.isAbsolute(line.split('  ')[1]!)).toBe(false);
    }
    // Every packaged target artifact is checksummed, including the MP4.
    expect(paths).toEqual([
      'long/captions.json',
      'long/captions.srt',
      'long/captions.vtt',
      'long/qc.json',
      'long/qc.md',
      'long/target.json',
      'long/video.mp4',
      'shorts/short_1/captions.json',
      'shorts/short_1/captions.srt',
      'shorts/short_1/captions.vtt',
      'shorts/short_1/qc.json',
      'shorts/short_1/qc.md',
      'shorts/short_1/target.json',
      'shorts/short_1/video.mp4',
    ]);
    for (const line of lines) {
      const [digest, rel] = line.split('  ') as [string, string];
      expect(sha256(abs(first.packageRoot, rel))).toBe(digest);
    }
  }, 240_000);
});

/* ================================================================== */
/*  §9/§10/§11 — captions are plan-derived and validated               */
/* ================================================================== */

describe('Phase 6D §9/§10/§11 — plan-derived delivery captions', () => {
  it('12/13/14. writes valid SRT, VTT and caption JSON', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]));

    const srt = read(res.packageRoot, 'long/captions.srt');
    const vtt = read(res.packageRoot, 'long/captions.vtt');
    const json = JSON.parse(read(res.packageRoot, 'long/captions.json'));

    expect(srt).toMatch(/^1\n00:00:\d{2},\d{3} --> 00:00:\d{2},\d{3}\n/);
    expect(srt).toMatch(/-->/);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    // WebVTT uses a dot for the millisecond separator (cue TEXT may contain
    // commas; the timing line may not).
    expect(vtt).toMatch(/1\n00:00:\d{2}\.\d{3} --> 00:00:\d{2}\.\d{3}\n/);
    for (const line of vtt.split('\n')) {
      if (line.includes('-->')) expect(line).not.toMatch(/\d,\d{3}/);
    }

    expect(json.version).toBe(PRODUCTION_DELIVERY_PACKAGE_VERSION);
    expect(json.targetId).toBe('long');
    expect(json.scenarioId).toBe('scenario-pm-01');
    expect(json.projectId).toBe(CANONICAL_PROJECT_ID);
    expect(json.authoritativeDurationSeconds).toBe(118.74);
    expect(json.count).toBe(28);
    expect(json.cues).toHaveLength(28);
    for (const cue of json.cues) {
      expect(typeof cue.id).toBe('string');
      expect(typeof cue.sceneId).toBe('string');
      expect(cue.end).toBeGreaterThan(cue.start);
    }
    expect(json.cues.map((c: any) => c.index)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
  }, 240_000);

  it('15. takes every cue from the target plan, never from a legacy caption map', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]));
    const p = res.package;

    for (const id of ['long', 'short_1'] as DeliveryTargetId[]) {
      const target = targetOf(set, id);
      const planCues = target.plan.scenes.flatMap((s) => s.captionCues);
      const packaged = p.targets.find((t) => t.targetId === id)!.captions!;
      expect(packaged.count).toBe(planCues.length);
      expect(packaged.cues.map((c) => c.id).sort()).toEqual(planCues.map((c) => c.id).sort());
      expect(packaged.cues.map((c) => c.text)).toEqual(planCues.map((c) => c.text));
      expect(packaged.cues.map((c) => c.sceneId)).toEqual(planCues.map((c) => c.sceneId));
      expect(packaged.authoritativeDurationSeconds).toBe(target.authoritativeDurationSeconds);
    }

    // The Short never receives a Long cue.
    const longTexts = new Set(p.targets.find((t) => t.targetId === 'long')!.captions!.cues.map((c) => c.text));
    expect(p.targets.find((t) => t.targetId === 'short_1')!.captions!.cues.filter((c) => longTexts.has(c.text))).toEqual([]);
  }, 240_000);

  it('16. rejects a caption cue that runs beyond the authoritative target duration', async () => {
    const late = {
      ...shortPlan1,
      scenes: shortPlan1.scenes.map((scene, i) =>
        i === 0
          ? {
              ...scene,
              captionCues: [
                ...scene.captionCues,
                {
                  ...scene.captionCues[0]!,
                  id: 'late-cue-999',
                  startTimeSeconds: 400,
                  endTimeSeconds: 410,
                  durationSeconds: 10,
                  startFrame: 12000,
                  endFrame: 12300,
                  durationInFrames: 300,
                },
              ],
            }
          : scene,
      ),
    } as RemotionCompositionPlan;
    const set = makeSet({ shorts: ['short_1'], long: longPlan });
    const broken = buildProductionDeliveryTargets({ longPlan, shortPlans: { short_1: late } });
    const res = await pkg(broken, makeRenderResult([successEntry(targetOf(broken, 'short_1'), FIXTURES.shortOk)]));
    expect(codesFor(res.package, 'short_1')).toContain('PACKAGE_CAPTION_INVALID');
    expect(res.package.targets.find((t) => t.targetId === 'short_1')!.status).toBe('failed');
    expect(exists(res.packageRoot, 'shorts/short_1/captions.srt')).toBe(false);
  }, 120_000);

  it('17. rejects a Long caption cue leaking into a Short target', async () => {
    const longScene = longPlan.scenes[0]!;
    const longCue = longScene.captionCues[0]!;
    const leaked = {
      ...shortPlan1,
      scenes: shortPlan1.scenes.map((scene, i) =>
        i === 0 ? { ...scene, captionCues: [{ ...longCue, id: 'leaked-cue-001' }, ...scene.captionCues] } : scene,
      ),
    } as RemotionCompositionPlan;
    const set = buildProductionDeliveryTargets({ longPlan, shortPlans: { short_1: leaked } });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]));
    const findings = res.package.targets.find((t) => t.targetId === 'short_1')!.qc!.findings;
    expect(findings.map((f) => f.code)).toContain('PACKAGE_CAPTION_INVALID');
    expect(findings.some((f) => /cross-target|caption identity/i.test(f.message))).toBe(true);
    expect(res.package.status).toBe('blocked');
  }, 120_000);
});

/* ================================================================== */
/*  §12/§13/§14 — descriptor and technical QC                          */
/* ================================================================== */

describe('Phase 6D §12/§13/§14/§16/§17 — technical QC against the target contract', () => {
  it('18. rejects media whose dimensions do not match the target', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longWrongDims)]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_DIMENSIONS_MISMATCH');
    expect(res.package.status).toBe('blocked');
  }, 60_000);

  it('19. rejects media whose frame rate does not match the plan', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longWrongFps)]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_FPS_MISMATCH');
  }, 60_000);

  it('20. rejects media with no audio when the plan declares canonical audio', async () => {
    const set = makeSet();
    expect(targetOf(set, 'long').canonicalAudioRefCount).toBe(12);
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longNoAudio)]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_AUDIO_MISSING');
  }, 60_000);

  it('21. reports a video codec that is not H.264-family', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longMpeg4)]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_VIDEO_CODEC_MISMATCH');
  }, 60_000);

  it('21b. reports an audio codec that is not AAC-family', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longMp3Audio)]));
    const codes = codesFor(res.package, 'long');
    expect(codes).toContain('PACKAGE_AUDIO_CODEC_MISMATCH');
    expect(codes).not.toContain('PACKAGE_AUDIO_MISSING');
  }, 60_000);

  it('16b. rejects a fully silent audio stream but not an ordinary pause', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longSilent)]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_AUDIO_SILENT');

    // The canonical tone is audible, so it is never reported as silent.
    const ok = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    expect(codesFor(ok.package, 'long')).not.toContain('PACKAGE_AUDIO_SILENT');
  }, 180_000);

  it('22. a truncated video can never be production ready', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longTruncated)]));
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_DURATION_TRUNCATED');
    expect(res.package.status).toBe('blocked');
    expect(res.package.readyForProductionDelivery).toBe(false);
    expect(res.package.targets[0]!.productionReady).toBe(false);
  }, 60_000);

  it('22b. rejects a Short whose media is shorter than its own plan', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'short_1'), FIXTURES.shortTruncated)]));
    expect(codesFor(res.package, 'short_1')).toContain('PACKAGE_DURATION_TRUNCATED');
    expect(res.package.status).toBe('blocked');
  }, 60_000);

  it('22c. rejects an impossible excessive duration mismatch', async () => {
    // The Short plan runs 49s; the 118.9s Long media is not container padding.
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'short_1'), FIXTURES.longOk)]));
    expect(codesFor(res.package, 'short_1')).toContain('PACKAGE_DURATION_EXCESSIVE');
  }, 180_000);

  it('23. accepts expected positive container padding (118.922s over 118.7667s capacity)', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    const m = res.package.targets[0]!.qc!.metrics;
    expect(m.durationSeconds!).toBeGreaterThan(m.frameCapacitySeconds!);
    expect(m.containerPaddingSeconds!).toBeGreaterThan(0);
    expect(m.containerPaddingSeconds!).toBeLessThan(2);
    // The authoritative 118.74s is NOT required to equal the container duration.
    expect(m.durationSeconds).not.toBe(m.authoritativeDurationSeconds);
    expect(errorCodesOf(res.package)).toEqual([]);
    expect(res.package.status).toBe('ready');
  }, 120_000);

  it('17b. records asset / mediaMap contract counts without re-resolving assets', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    const long = res.package.targets[0]!;
    expect(long.qc!.metrics.assetRefCount).toBe(2);
    expect(long.qc!.metrics.mediaMapEntryCount).toBe(1);
    expect(long.descriptor!.assetRefCount).toBe(2);
    expect(long.descriptor!.mediaMapEntryCount).toBe(1);
    // The Phase 6A mediaMap contract is the same one Phase 6B validated.
    expect(validatePlanForRender(targetOf(set, 'long').plan, targetOf(set, 'long').mediaMap)).toEqual([]);
  }, 120_000);

  it('18b. delegates plan validation to Phase 6B and blocks an invalid plan', async () => {
    const set = makeSet();
    const ok = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    // Every plan finding is explicitly attributed to the Phase 6B validator.
    for (const finding of ok.package.targets[0]!.qc!.findings.filter((f) => f.code === 'PACKAGE_PLAN_INVALID')) {
      expect(finding.message).toMatch(/phase 6B (error|warning) \(PLAN_RENDER_/);
    }

    // Phase 6B itself rejects this plan, and Phase 6D re-runs the SAME
    // validator at package time rather than trusting the build-time result.
    const broken = structuredClone(set) as any;
    broken.targets[0].plan.scenes = broken.targets[0].plan.scenes.slice(0, 2);
    broken.long = broken.targets[0];
    const res = await pkg(broken as ProductionDeliveryTargetSet, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]), { name: 'delegation-broken' });
    const codes = codesFor(res.package, 'long');
    expect(codes).toContain('PACKAGE_PLAN_INVALID');
    expect(res.package.targets[0]!.qc!.findings.filter((f) => f.code === 'PACKAGE_PLAN_INVALID')[0]!.message).toMatch(/phase 6B error/);
    expect(res.package.status).toBe('blocked');
    expect(exists(res.packageRoot, 'long/video.mp4')).toBe(false);
  }, 180_000);
});

/* ================================================================== */
/*  §20 — QC JSON + Markdown evidence                                  */
/* ================================================================== */

describe('Phase 6D §20 — QC evidence', () => {
  it('writes qc.json and a human-readable qc.md with the full evidence table', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    const json = JSON.parse(read(res.packageRoot, 'long/qc.json'));
    const md = read(res.packageRoot, 'long/qc.md');

    expect(json.targetId).toBe('long');
    expect(json.status).toBe('pass');
    expect(json.findings).toEqual([]);
    expect(json.metrics.expectedWidth).toBe(1920);
    expect(json.metrics.width).toBe(1920);
    expect(json.metrics.authoritativeDurationSeconds).toBe(118.74);
    expect(json.metrics.fullFrameCoverage).toBe(true);
    expect(json.metrics.videoSha256).toMatch(/^[0-9a-f]{64}$/);

    for (const needle of [
      'Target id',
      'Verdict',
      '1920x1080',
      '30 fps',
      'Authoritative duration',
      'Frame capacity',
      'Rendered frame count',
      'Audio codec',
      'Caption cues',
      'Asset refs',
      'SHA256',
      'Findings',
    ]) {
      expect(md).toContain(needle);
    }
    // §20: no environment absolute paths in the human-readable evidence.
    expect(md).not.toContain(REPO_ROOT);
    expect(md).not.toContain(FIXTURE_DIR);
    expect(md).not.toMatch(/\/[A-Za-z]:\\/);
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  }, 120_000);
});

/* ================================================================== */
/*  §21/§22/§23 — manifest, determinism, summary                      */
/* ================================================================== */

describe('Phase 6D §21/§22/§23 — manifest authority and determinism', () => {
  it('21. writes a top-level manifest describing the whole package', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]));
    const manifest = JSON.parse(read(res.packageRoot, 'manifest/delivery_manifest.json'));

    expect(manifest.version).toBe(PRODUCTION_DELIVERY_PACKAGE_VERSION);
    expect(manifest.projectId).toBe(CANONICAL_PROJECT_ID);
    expect(manifest.status).toBe('ready');
    expect(manifest.requestedTargetIds).toEqual(['long', 'short_1']);
    expect(manifest.packagedTargetIds).toEqual(['long', 'short_1']);
    expect(manifest.failedTargetIds).toEqual([]);
    expect(manifest.checksumsFile).toBe('manifest/checksums.sha256');
    expect(manifest.targets.map((t: any) => t.targetId)).toEqual(['long', 'short_1']);
    expect(manifest.targets[0].video.path).toBe('long/video.mp4');
    expect(manifest.targets[0].videoSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.targets[0].captions).toEqual({ srt: 'long/captions.srt', vtt: 'long/captions.vtt', json: 'long/captions.json' });
    expect(manifest.targets[0].qc).toEqual({ json: 'long/qc.json', markdown: 'long/qc.md', status: 'pass' });
    expect(manifest.targets[0].descriptor).toBe('long/target.json');
    expect(manifest.targets[1].video.path).toBe('shorts/short_1/video.mp4');
    expect(manifest.artifacts.map((a: any) => a.path)).toEqual(res.package.checksums.map((c) => c.path));
  }, 240_000);

  it('29. the manifest contains no absolute paths, no temp dirs, no host names', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]));
    const text = read(res.packageRoot, 'manifest/delivery_manifest.json');

    expect(text).not.toContain(REPO_ROOT);
    expect(text).not.toContain(FIXTURE_DIR);
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain(require('node:os').hostname());
    expect(JSON.stringify(res.package.manifest)).not.toContain(REPO_ROOT);
    for (const pathValue of Object.values(res.package.manifest).flatMap((v) => (Array.isArray(v) ? v : [v]))) {
      if (typeof pathValue === 'string') expect(path.isAbsolute(pathValue)).toBe(false);
    }
    // Every path in the manifest is package-relative and resolvable.
    for (const target of res.package.manifest.targets) {
      for (const rel of [target.video?.path, target.captions?.srt, target.captions?.vtt, target.captions?.json, target.qc?.json, target.qc?.markdown, target.descriptor]) {
        if (rel === null || rel === undefined) continue;
        expect(exists(res.packageRoot, rel)).toBe(true);
        expect(path.isAbsolute(rel)).toBe(false);
      }
    }
  }, 240_000);

  it('30/36. repeated builds of the same logical input are byte-identical', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const renderResult = makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]);
    const a = await pkg(set, renderResult, { name: 'determinism-a' });
    const b = await pkg(set, renderResult, { name: 'determinism-b' });

    expect(read(b.packageRoot, 'manifest/delivery_manifest.json')).toBe(read(a.packageRoot, 'manifest/delivery_manifest.json'));
    expect(read(b.packageRoot, 'manifest/checksums.sha256')).toBe(read(a.packageRoot, 'manifest/checksums.sha256'));
    expect(read(b.packageRoot, 'evidence/package_summary.json')).toBe(read(a.packageRoot, 'evidence/package_summary.json'));
    for (const targetId of ['long', 'short_1'] as DeliveryTargetId[]) {
      for (const name of ['captions.srt', 'captions.vtt', 'captions.json', 'target.json', 'qc.json', 'qc.md']) {
        expect(read(b.packageRoot, `${packageTargetFile(targetId, name)}`)).toBe(read(a.packageRoot, `${packageTargetFile(targetId, name)}`));
      }
    }

    // No timestamps, no randomness, no machine names anywhere in the package.
    for (const rel of ['manifest/delivery_manifest.json', 'evidence/package_summary.json', 'long/target.json', 'long/qc.json', 'long/qc.md']) {
      const text = read(a.packageRoot, rel);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(text).not.toMatch(/generatedAt|createdAt|timestamp/i);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    }
  }, 300_000);

  it('23. writes a package summary with no environment-specific paths', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    const summary = JSON.parse(read(res.packageRoot, 'evidence/package_summary.json'));

    expect(summary.packageStatus).toBe('ready');
    expect(summary.projectId).toBe(CANONICAL_PROJECT_ID);
    expect(summary.requestedTargetIds).toEqual(['long']);
    expect(summary.renderSucceededTargetIds).toEqual(['long']);
    expect(summary.packagedTargetIds).toEqual(['long']);
    expect(summary.failedTargetIds).toEqual([]);
    expect(summary.qcPassCount).toBe(1);
    expect(summary.qcWarnCount).toBe(0);
    expect(summary.qcFailCount).toBe(0);
    expect(summary.artifactCount).toBe(7);
    expect(summary.checksumCount).toBe(7);
    expect(summary.totalPackagedBytes).toBeGreaterThan(0);
    expect(summary.targetOrder).toEqual(['long']);
    expect(read(res.packageRoot, 'evidence/package_summary.json')).not.toContain(REPO_ROOT);
  }, 120_000);
});

/* ================================================================== */
/*  §5/§6 — layout, naming, isolation                                  */
/* ================================================================== */

describe('Phase 6D §5/§6/§25/§32 — deterministic layout and isolation', () => {
  it('5/6. lays the package out deterministically with stable file names', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]));
    const walk = (dir: string, prefix = ''): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`]));
    expect(walk(res.packageRoot).sort()).toEqual([
      'evidence/package_summary.json',
      'long/captions.json',
      'long/captions.srt',
      'long/captions.vtt',
      'long/qc.json',
      'long/qc.md',
      'long/target.json',
      'long/video.mp4',
      'manifest/checksums.sha256',
      'manifest/delivery_manifest.json',
      'shorts/short_1/captions.json',
      'shorts/short_1/captions.srt',
      'shorts/short_1/captions.vtt',
      'shorts/short_1/qc.json',
      'shorts/short_1/qc.md',
      'shorts/short_1/target.json',
      'shorts/short_1/video.mp4',
    ]);
  }, 240_000);

  it('25. packages Long and Short fully isolated from one another', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]));
    const long = res.package.targets.find((t) => t.targetId === 'long')!;
    const short = res.package.targets.find((t) => t.targetId === 'short_1')!;

    expect(long.descriptor!.scenarioId).toBe('scenario-pm-01');
    expect(short.descriptor!.scenarioId).toBe('scenario-sched-risk-03');
    expect(long.captions!.cues.map((c) => c.id)).not.toEqual(short.captions!.cues.map((c) => c.id));
    expect(long.descriptor!.durationInFrames).toBe(3563);
    expect(short.descriptor!.durationInFrames).toBe(1470);
    // Separate media, separate hashes, separate files.
    expect(long.descriptor!.videoSha256).not.toBe(short.descriptor!.videoSha256);
    expect(exists(res.packageRoot, 'long/video.mp4')).toBe(true);
    expect(exists(res.packageRoot, 'shorts/short_1/video.mp4')).toBe(true);
  }, 240_000);

  it('32. never creates a directory for an unrequested Short', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]));
    expect(exists(res.packageRoot, 'shorts/short_2')).toBe(false);
    expect(exists(res.packageRoot, 'shorts/short_3')).toBe(false);
    expect(fs.existsSync(path.join(res.packageRoot, 'shorts', 'short_2'))).toBe(false);
  }, 240_000);

  it('32b. removes a stale target directory left by an earlier build', async () => {
    const set = makeSet({ shorts: ['short_1', 'short_2'] });
    const full = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk), successEntry(targetOf(set, 'short_2'), FIXTURES.shortOk)]), { name: 'stale' });
    expect(exists(full.packageRoot, 'shorts/short_2/video.mp4')).toBe(true);

    // A second build that only requests long + short_1 must not leave short_2 behind.
    const fewer = makeSet({ shorts: ['short_1'] });
    const res = await buildPackage({
      targetSet: fewer,
      renderResult: makeRenderResult([successEntry(targetOf(fewer, 'long'), FIXTURES.longOk), successEntry(targetOf(fewer, 'short_1'), FIXTURES.shortOk)]),
      packageRoot: full.packageRoot,
      clean: 'stale',
    });
    expect(exists(res.packageRoot, 'shorts/short_2/video.mp4')).toBe(false);
    expect(exists(res.packageRoot, 'shorts/short_1/video.mp4')).toBe(true);
  }, 300_000);

  it('25b/§27. a failed Short leaves the valid Long package completely intact', async () => {
    const set = makeSet({ shorts: ['short_1', 'short_2'] });
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk), failureEntry(targetOf(set, 'short_2'), path.join(FIXTURE_DIR, 'short_2.mp4'))]));

    expect(res.package.status).toBe('partial');
    expect(res.package.readyForProductionDelivery).toBe(false);
    expect(res.package.manifest.packagedTargetIds).toEqual(['long', 'short_1']);
    expect(res.package.manifest.failedTargetIds).toEqual(['short_2']);

    expect(exists(res.packageRoot, 'long/video.mp4')).toBe(true);
    expect(exists(res.packageRoot, 'long/captions.srt')).toBe(true);
    expect(exists(res.packageRoot, 'long/qc.md')).toBe(true);
    expect(exists(res.packageRoot, 'shorts/short_1/video.mp4')).toBe(true);
    expect(res.package.targets.find((t) => t.targetId === 'long')!.qc!.status).toBe('pass');

    // 33. the failed target gets no fake media package at all.
    expect(exists(res.packageRoot, 'shorts/short_2')).toBe(false);
    expect(exists(res.packageRoot, 'shorts/short_2/video.mp4')).toBe(false);
    const failed = res.package.manifest.targets.find((t) => t.targetId === 'short_2')!;
    expect(failed.status).toBe('failed');
    expect(failed.video).toBeNull();
    expect(failed.captions).toBeNull();
    expect(failed.qc).toBeNull();
    expect(failed.descriptor).toBeNull();
    expect(failed.error!.message).toMatch(/synthetic render failure/);
  }, 300_000);

  it('28/§26. blocks the package when no target can be safely packaged', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const res = await pkg(set, makeRenderResult([failureEntry(targetOf(set, 'long'), null), failureEntry(targetOf(set, 'short_1'), null)]));

    expect(res.package.status).toBe('blocked');
    expect(res.package.readyForProductionDelivery).toBe(false);
    expect(res.package.valid).toBe(false);
    expect(res.package.manifest.packagedTargetIds).toEqual([]);
    expect(res.package.summary.qcPassCount).toBe(0);
    expect(exists(res.packageRoot, 'long')).toBe(false);
    expect(exists(res.packageRoot, 'shorts/short_1')).toBe(false);

    // A blocked audit manifest may still be written, but it never claims readiness.
    const manifest = JSON.parse(read(res.packageRoot, 'manifest/delivery_manifest.json'));
    expect(manifest.status).toBe('blocked');
    expect(manifest.readyForProductionDelivery).toBe(false);
    expect(manifest.targets.map((t: any) => t.status)).toEqual(['failed', 'failed']);
    expect(manifest.targets.every((t: any) => t.video === null)).toBe(true);
  }, 120_000);

  it('§32. the package stands alone: no reference to the source render directory', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    const files = ['manifest/delivery_manifest.json', 'manifest/checksums.sha256', 'evidence/package_summary.json', 'long/target.json', 'long/qc.json', 'long/qc.md', 'long/captions.json'];
    for (const rel of files) {
      const text = read(res.packageRoot, rel);
      expect(text).not.toContain(FIXTURE_DIR);
      expect(text).not.toContain('.stills');
      expect(text).not.toContain('.browser');
      expect(text).not.toContain('node_modules');
      expect(text).not.toMatch(/127\.0\.0\.1|localhost/);
    }
    // The only environment-safe reference to the source is its basename.
    const descriptor = JSON.parse(read(res.packageRoot, 'long/target.json'));
    expect(descriptor.sourceRenderFile).toBe('long-ok.mp4');
    expect(res.package.manifest.targets[0]!.video!.sourceRenderFile).toBe('long-ok.mp4');
  }, 120_000);
});

/* ================================================================== */
/*  §24 — package root safety                                           */
/* ================================================================== */

describe('Phase 6D §24 — package root safety', () => {
  const set = () => makeSet();
  const render = () => makeRenderResult([successEntry(targetOf(set(), 'long'), FIXTURES.longOk)]);

  it('34. refuses an empty, dot, repo-root or filesystem-root package root', async () => {
    for (const root of ['', '   ', '.', './', REPO_ROOT, path.join(REPO_ROOT, '.'), '/', '..', path.join(REPO_ROOT, 'apps/../..')]) {
      await expect(
        buildPackage({ targetSet: set(), renderResult: render(), packageRoot: root, repoRoot: REPO_ROOT, clean: 'full' }),
      ).rejects.toBeInstanceOf(ProductionDeliveryPackageError);
    }
  }, 60_000);

  it('34b. reports a structured PACKAGE_ROOT_UNSAFE finding', async () => {
    try {
      await buildPackage({ targetSet: set(), renderResult: render(), packageRoot: '.', repoRoot: REPO_ROOT });
      throw new Error('expected the build to be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(ProductionDeliveryPackageError);
      const failure = err as ProductionDeliveryPackageError;
      expect(failure.code).toBe('PACKAGE_ROOT_UNSAFE');
      expect(failure.findings.map((f) => f.code)).toContain('PACKAGE_ROOT_UNSAFE');
    }
  });

  it('34c. writes nothing at all when the root is refused', async () => {
    // A path outside the repository is refused outright.
    const outside = path.join(os.tmpdir(), 'phase6d-outside-package');
    fs.rmSync(outside, { recursive: true, force: true });
    await expect(buildPackage({ targetSet: set(), renderResult: render(), packageRoot: outside, clean: 'full' })).rejects.toThrow();
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('34e. refuses to clear a directory that is not a delivery package', async () => {
    const root = path.join(PACKAGE_DIR, 'not-a-package');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'important.txt'), 'do not delete me');
    await expect(buildPackage({ targetSet: set(), renderResult: render(), packageRoot: root, clean: 'full' })).rejects.toThrow(/does not own/);
    expect(fs.readFileSync(path.join(root, 'important.txt'), 'utf8')).toBe('do not delete me');
  }, 60_000);

  it('34d. accepts a normal package-owned directory', async () => {
    const res = await pkg(set(), render());
    expect(exists(res.packageRoot, 'long/video.mp4')).toBe(true);
  }, 120_000);
});

/* ================================================================== */
/*  §30 — production full-coverage rule                                 */
/* ================================================================== */

describe('Phase 6D §29/§30 — frame-range renders are never full deliveries', () => {
  it('35. a frame sub-range render cannot claim production-ready coverage', async () => {
    const set = makeSet();
    const entry = successEntry(targetOf(set, 'long'), FIXTURES.longOk);
    entry.renderResult!.renderedFrameCount = 60;
    const res = await pkg(set, makeRenderResult([entry]));

    expect(codesFor(res.package, 'long')).toContain('PACKAGE_PARTIAL_FRAME_COVERAGE');
    expect(res.package.status).toBe('blocked');
    expect(res.package.readyForProductionDelivery).toBe(false);
    expect(res.package.manifest.targets[0]!.productionReady).toBe(false);
  }, 120_000);

  it('35b. test-evidence mode packages the mechanics but never claims readiness', async () => {
    const set = makeSet();
    const entry = successEntry(targetOf(set, 'long'), FIXTURES.longTruncated);
    entry.renderResult!.renderedFrameCount = 90;
    const res = await pkg(set, makeRenderResult([entry]), { mode: 'test-evidence' });

    const p = res.package;
    expect(p.mode).toBe('test-evidence');
    expect(p.status).toBe('partial');
    expect(p.readyForProductionDelivery).toBe(false);
    expect(p.manifest.mode).toBe('test-evidence');
    expect(p.manifest.readyForProductionDelivery).toBe(false);
    expect(p.targets[0]!.productionReady).toBe(false);
    // The findings are still reported, loudly, and only ever downgraded.
    const codes = codesFor(p, 'long');
    expect(codes).toContain('PACKAGE_PARTIAL_FRAME_COVERAGE');
    expect(codes).toContain('PACKAGE_DURATION_TRUNCATED');
    expect(p.targets[0]!.qc!.findings.filter((f) => f.code === 'PACKAGE_PARTIAL_FRAME_COVERAGE')[0]!.severity).toBe('warning');
    expect(p.targets[0]!.qc!.findings.filter((f) => f.code === 'PACKAGE_DURATION_TRUNCATED')[0]!.message).toMatch(/never a full delivery artifact/);
    // The media is still delivered as evidence.
    expect(exists(res.packageRoot, 'long/video.mp4')).toBe(true);
    expect(p.targets[0]!.qc!.status).toBe('warn');
  }, 60_000);

  it('35c. test-evidence mode does not relax any other QC rule', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longNoAudio)]), { mode: 'test-evidence' });
    expect(codesFor(res.package, 'long')).toContain('PACKAGE_AUDIO_MISSING');
    expect(res.package.status).toBe('blocked');
  }, 60_000);
});

/* ================================================================== */
/*  §38/§39/§40 — no mutation, no legacy authority                     */
/* ================================================================== */

describe('Phase 6D §38/§39/§40 — immutability and plan-only authority', () => {
  it('38/39. never mutates the target set or the render result', async () => {
    const set = makeSet({ shorts: ['short_1'] });
    const renderResult = makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk), successEntry(targetOf(set, 'short_1'), FIXTURES.shortOk)]);
    const setSnapshot = JSON.stringify(set);
    const renderSnapshot = JSON.stringify(renderResult);

    const res = await pkg(set, renderResult, { name: 'immutability' });

    expect(JSON.stringify(set)).toBe(setSnapshot);
    expect(JSON.stringify(renderResult)).toBe(renderSnapshot);
    expect(res.package.targetSet).toBe(set);
    expect(res.package.renderResult).toBe(renderResult);
  }, 240_000);

  it('40. legacy Project / Storyboard / targetAudio are never package authority', async () => {
    const set = makeSet();
    // A legacy export payload, complete with storyboard, voiceoverFile,
    // targetAudio and shortCaptions, deliberately contradicting the plan.
    const legacy = {
      storyboard: { scenes: [{ id: 'sc-01', narration: 'legacy narration' }] },
      voiceoverFile: 'output/legacy-long.wav',
      targetAudio: { long: 'output/legacy-long.wav' },
      shortCaptions: { short_1: [{ id: 'legacy-cue', start: 0, end: 1, text: 'LEGACY TEXT' }] },
      captions: [{ id: 'legacy-cue', start: 0, end: 1, text: 'LEGACY TEXT' }],
      durationSec: 42,
      audioDurationSec: 42,
    };
    const entry = successEntry(targetOf(set, 'long'), FIXTURES.longOk);
    const withLegacyJunk = { ...entry, storyboard: legacy.storyboard, voiceoverFile: legacy.voiceoverFile, targetAudio: legacy.targetAudio, captions: legacy.captions, shortCaptions: legacy.shortCaptions } as any;
    const res = await pkg(set, makeRenderResult([withLegacyJunk]));

    const captionsJson = read(res.packageRoot, 'long/captions.json');
    expect(captionsJson).not.toContain('LEGACY TEXT');
    expect(JSON.parse(captionsJson).count).toBe(28);
    expect(res.package.targets[0]!.descriptor!.authoritativeDurationSeconds).toBe(118.74);
    expect(res.package.status).toBe('ready');
  }, 120_000);

  it('40b. refuses a legacy Scene[] payload as a plan authority', async () => {
    const legacyScenes = longPlan.scenes.map((s) => ({ sceneId: s.sceneId, narration: 'legacy' }));
    const set = makeSet({ long: legacyScenes as unknown as RemotionCompositionPlan });
    expect(set.long).toBeNull();
    const res = await pkg(set, makeRenderResult([]));
    expect(res.package.status).toBe('blocked');
    expect(res.package.manifest.failedTargetIds).toEqual(['long']);
    expect(exists(res.packageRoot, 'long/video.mp4')).toBe(false);
  }, 60_000);

  it('40c. a target whose plan is invalid is blocked, never downgraded to a warning', async () => {
    // Phase 6B refuses this plan outright, so the Long target never delivers.
    const brokenPlan = { ...longPlan, totalActualDurationSeconds: 33.4 } as RemotionCompositionPlan;
    const built = buildProductionDeliveryTargets({ longPlan: brokenPlan, mediaMapByTarget: { long: { [LONG_ASSET_REF]: 'u' } } });
    expect(built.long).toBeNull();
    expect(built.findings.map((f) => f.code)).toContain('DELIVERY_TARGET_INVALID_PLAN');

    const ghost: ProductionDeliveryTargetRenderResult = {
      targetId: 'long',
      success: false,
      format: 'Long',
      scenarioId: LONG_SCENARIO_ID,
      projectId: CANONICAL_PROJECT_ID,
      outputFile: FIXTURES.longOk,
      error: { code: 'DELIVERY_TARGET_INVALID_PLAN', message: 'target long was not delivered by the target set', targetId: 'long' },
    };
    const res = await pkg(built, makeRenderResult([ghost]), { name: 'invalid-plan' });
    expect(res.package.status).toBe('blocked');
    expect(res.package.readyForProductionDelivery).toBe(false);
    expect(res.package.manifest.targets[0]!.error!.code).toBe('DELIVERY_TARGET_INVALID_PLAN');
    expect(exists(res.packageRoot, 'long/video.mp4')).toBe(false);
    expect(exists(res.packageRoot, 'long/target.json')).toBe(false);
  }, 60_000);
});

/* ================================================================== */
/*  §12 — the per-target descriptor                                    */
/* ================================================================== */

describe('Phase 6D §12 — target descriptor', () => {
  it('records the full plan contract for a packaged target', async () => {
    const set = makeSet();
    const res = await pkg(set, makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]));
    const descriptor = JSON.parse(read(res.packageRoot, 'long/target.json'));

    expect(Object.keys(descriptor).sort()).toEqual(
      [
        'assetRefCount',
        'authoritativeDurationSeconds',
        'canonicalAudioRefCount',
        'captionCueCount',
        'compositionId',
        'durationInFrames',
        'format',
        'fps',
        'fullFrameCoverage',
        'height',
        'mediaMapEntryCount',
        'packageContractVersion',
        'packagedVideoFile',
        'projectId',
        'qcStatus',
        'renderedFrameCount',
        'renderedWithAudio',
        'sceneCount',
        'scenarioId',
        'sourceRenderFile',
        'targetId',
        'videoSha256',
        'width',
      ].sort(),
    );
    expect(descriptor.packageContractVersion).toBe(PRODUCTION_DELIVERY_PACKAGE_VERSION);
    expect(descriptor.targetId).toBe('long');
    expect(descriptor.format).toBe('Long');
    expect(descriptor.width).toBe(1920);
    expect(descriptor.height).toBe(1080);
    expect(descriptor.fps).toBe(30);
    expect(descriptor.sourceRenderFile).toBe('long-ok.mp4');
    expect(descriptor.packagedVideoFile).toBe('long/video.mp4');
    expect(descriptor.videoSha256).toBe(sha256(FIXTURES.longOk));
    expect(descriptor.qcStatus).toBe('pass');
    expect(descriptor.sourceRenderFile).not.toContain('/');
  }, 120_000);
});

/* ================================================================== */
/*  Core / service split                                               */
/* ================================================================== */

describe('Phase 6D — the package planner is pure and filesystem-free', () => {
  it('produces the identical manifest with no filesystem access at all', async () => {
    const set = makeSet();
    const renderResult = makeRenderResult([successEntry(targetOf(set, 'long'), FIXTURES.longOk)]);

    // 1. The service measures, copies and probes, then hands over the evidence.
    const res = await pkg(set, renderResult, { name: 'split-service' });

    // 2. The core planner runs with the same measured evidence and no `fs`.
    const evidence = {
      long: {
        targetId: 'long' as const,
        sourceRenderFile: FIXTURES.longOk,
        sourceRenderFileName: path.basename(FIXTURES.longOk),
        sourceExists: true,
        sourceSizeBytes: fs.statSync(FIXTURES.longOk).size,
        sourceSha256: sha256(FIXTURES.longOk),
        copied: true,
        videoSha256: sha256(FIXTURES.longOk),
        sizeBytes: fs.statSync(FIXTURES.longOk).size,
        metrics: res.package.targets[0]!.qc!.metrics as any,
        error: null,
      },
    };
    const pure = buildProductionDeliveryPackage({
      targetSet: set,
      renderResult,
      packageRoot: path.join(PACKAGE_DIR, 'never-written'),
      repoRoot: REPO_ROOT,
      mediaByTarget: evidence,
    });

    expect(pure.status).toBe(res.package.status);
    expect(JSON.stringify(pure.manifest)).toBe(JSON.stringify(res.package.manifest));
    expect(fs.existsSync(path.join(PACKAGE_DIR, 'never-written'))).toBe(false);
  }, 120_000);
});

/* ================================================================== */
/*  Finding vocabulary                                                 */
/* ================================================================== */

describe('Phase 6D §19 — a small, closed QC vocabulary', () => {
  it('every emitted code is part of the declared package vocabulary', () => {
    const declared: ProductionPackageFindingCode[] = [
      'PACKAGE_ROOT_UNSAFE',
      'PACKAGE_RENDER_RESULT_MISMATCH',
      'PACKAGE_RENDER_FAILED',
      'PACKAGE_TARGET_MISMATCH',
      'PACKAGE_PLAN_INVALID',
      'PACKAGE_FILE_MISSING',
      'PACKAGE_FILE_EMPTY',
      'PACKAGE_MEDIA_PROBE_FAILED',
      'PACKAGE_CHECKSUM_MISMATCH',
      'PACKAGE_VIDEO_CODEC_MISMATCH',
      'PACKAGE_DIMENSIONS_MISMATCH',
      'PACKAGE_FPS_MISMATCH',
      'PACKAGE_AUDIO_MISSING',
      'PACKAGE_AUDIO_CODEC_MISMATCH',
      'PACKAGE_DURATION_TRUNCATED',
      'PACKAGE_DURATION_EXCESSIVE',
      'PACKAGE_AUDIO_SILENT',
      'PACKAGE_PARTIAL_FRAME_COVERAGE',
      'PACKAGE_CAPTION_INVALID',
    ];
    expect(declared).toHaveLength(19);
  });
});
