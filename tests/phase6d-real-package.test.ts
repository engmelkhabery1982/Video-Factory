/**
 * Phase 6D §27/§28 — REAL Long + Short delivery package, through the approved
 * Phase 6C renderer.
 *
 *   renderProductionDeliveryTargets(...)      (Phase 6C, approved)
 *     -> renderCompositionPlan(...)           (Phase 6B, approved)
 *       -> VideoPlan -> @remotion/renderer -> real encoded MP4
 *   buildProductionDeliveryPackage(...)       (Phase 6D)
 *
 * Cost control (Phase 6D §28/§29/§31):
 *   - the expensive 3563-frame / 118.74s canonical Long render is NOT repeated.
 *     Phase 6B already proved it; see PHASE6B_REAL_PRODUCTION_RENDER_HANDOFF.md
 *     and EVIDENCE/phase6b. The ignored full MP4 is gone and is not pretended
 *     to exist here.
 *   - instead a small INCLUSIVE frame sub-range is encoded for each target, so
 *     the plan's `durationInFrames` stays the authority and the encode stays
 *     cheap.
 *   - because a sub-range render is NOT a full delivery, these packages are
 *     built with `mode: 'test-evidence'`. They must prove the mechanics and
 *     must NOT claim production readiness. The canonical full-coverage rule is
 *     asserted separately and is never relaxed to make a short render pass.
 *
 * Offline by construction: every canonical audio clip is served by a local HTTP
 * server on 127.0.0.1. Only the audit-only `canonicalPath` field of each audio
 * ref is rewritten for transport - the same mapping Phase 6B/6C use, and it is
 * asserted to touch nothing else.
 *
 * No MP4 produced here is ever committed: everything lands under the
 * git-ignored `.stills/phase6d` scratch directory.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  PLAN_RENDER_CANONICAL,
  buildProductionDeliveryTargets,
  compileScenarioVisualPlan,
  getProgressMeetingScenario,
  loadScenarioFixture,
  packageTargetFile,
  type RemotionCompositionPlan,
  type Scenario,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';
import { renderProductionDeliveryTargets } from '../apps/api/src/services/plan-delivery.js';
import { buildProductionDeliveryPackage } from '../apps/api/src/services/plan-package.js';
import { chromePath } from '../apps/api/src/services/platform.js';
import { cleanupPhase6dScratch, createPhase6dScratch } from './helpers/phase6d-scratch.js';

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'render');
const SCRATCH = path.join(process.cwd(), '.stills', 'phase6d');
/*
 * THIS suite's own isolated dialogue-audio root (repo-relative: the production
 * dialogue pipeline rejects absolute base paths). It must NOT live under a
 * parent that another suite deletes — see `helpers/phase6d-scratch.ts`.
 */
const AUDIO_SCRATCH_ROOT = createPhase6dScratch('real');
const AUDIO_SCRATCH = `${AUDIO_SCRATCH_ROOT}/real-audio`;
const CANONICAL_PROJECT_ID = 'proj-hospital-expansion';
const LONG_ASSET_REF = 'asset-iva-progress-chart';
const SHORT_MEDIA_REF = 'short-delivery-chart';

/** A small window that definitely sits inside the first canonical audio clip. */
const LONG_RANGE: [number, number] = [0, 20];
const SHORT_RANGE: [number, number] = [0, 59];

function browserAvailable(): boolean {
  try {
    return !!chromePath() && fs.existsSync(chromePath());
  } catch {
    return false;
  }
}
const HAS_BROWSER = browserAvailable();
const describeReal = HAS_BROWSER ? describe : describe.skip;
if (!HAS_BROWSER) {
  // eslint-disable-next-line no-console
  console.warn('[phase6d] no provisioned Chromium - skipping real package evidence (run `npm run provision`).');
}

function toRenderableAudioUrl(audioRef: { clipId: string }, base: string): string {
  return `${base}/dialogue.wav?clip=${encodeURIComponent(audioRef.clipId)}`;
}

function withRenderableAudio(plan: RemotionCompositionPlan, base: string): RemotionCompositionPlan {
  return {
    ...plan,
    scenes: plan.scenes.map((scene) => ({
      ...scene,
      audioRefs: scene.audioRefs.map((a) => ({ ...a, canonicalPath: toRenderableAudioUrl(a, base) })),
    })),
  };
}

let planSeq = 0;
async function buildPlan(scenario: Scenario): Promise<RemotionCompositionPlan> {
  const tag = `real-${++planSeq}`;
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

function shortScenario(): Scenario {
  const base = loadScenarioFixture('schedule-risk');
  base.metadata = { ...base.metadata, targetFormat: 'Short', projectId: CANONICAL_PROJECT_ID };
  return base;
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav' };

let server: http.Server;
let baseUrl = '';
let longPlan: RemotionCompositionPlan;
let shortPlan: RemotionCompositionPlan;
let renderableLong: RemotionCompositionPlan;
let renderableShort: RemotionCompositionPlan;
let longOutput = '';
let shortOutput = '';
let longSet: ReturnType<typeof buildProductionDeliveryTargets>;
let renderResult: Awaited<ReturnType<typeof renderProductionDeliveryTargets>>;
let realPkg: Awaited<ReturnType<typeof buildProductionDeliveryPackage>>;

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const abs = (root: string, relative: string) => path.join(root, ...relative.split('/'));
const read = (root: string, relative: string) => fs.readFileSync(abs(root, relative), 'utf8');

beforeAll(async () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  // Clean slate for THIS suite's own isolated root only.
  fs.rmSync(AUDIO_SCRATCH_ROOT, { recursive: true, force: true });
  fs.mkdirSync(AUDIO_SCRATCH, { recursive: true });

  server = http.createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = path.join(FIXTURE_DIR, path.basename(rawPath));
    if (path.dirname(file) !== FIXTURE_DIR || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  longPlan = await buildPlan(structuredClone(getProgressMeetingScenario()));
  shortPlan = await buildPlan(structuredClone(shortScenario()));
  renderableLong = withRenderableAudio(longPlan, baseUrl);
  renderableShort = withRenderableAudio(shortPlan, baseUrl);

  longSet = buildProductionDeliveryTargets({
    longPlan: renderableLong,
    shortPlans: { short_1: renderableShort },
    mediaMapByTarget: {
      long: { [LONG_ASSET_REF]: `${baseUrl}/progress-chart.png` },
      short_1: { [SHORT_MEDIA_REF]: `${baseUrl}/progress-chart-alt.png` },
    },
  });

  longOutput = path.join(SCRATCH, 'phase6d-real-long.mp4');
  shortOutput = path.join(SCRATCH, 'phase6d-real-short_1.mp4');
  for (const f of [longOutput, shortOutput]) fs.rmSync(f, { force: true });

  // ── Phase 6C: the approved plan-based renderer, once per target ──
  renderResult = await renderProductionDeliveryTargets({
    targetSet: longSet,
    outputByTarget: { long: longOutput, short_1: shortOutput },
    quality: 'preview',
    frameRangeByTarget: { long: LONG_RANGE, short_1: SHORT_RANGE },
  });

  // ── Phase 6D: package the real media ──
  realPkg = await buildProductionDeliveryPackage({
    targetSet: longSet,
    renderResult,
    packageRoot: path.join(SCRATCH, 'package'),
    mode: 'test-evidence',
    clean: 'full',
  });
}, 1_800_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  /*
   * Remove ONLY this suite's own scratch: its isolated dialogue-audio root and
   * its own `.stills/phase6d` render/package outputs. Neither path belongs to
   * another suite, and no shared parent is ever deleted.
   */
  cleanupPhase6dScratch(AUDIO_SCRATCH_ROOT);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

/* ================================================================== */

describe('Phase 6D — real Phase 6C render feeding the package', () => {
  it('rendered a real Long and Short through the approved renderer', () => {
    expect(longSet.valid).toBe(true);
    expect(longSet.targets.map((t) => t.targetId)).toEqual(['long', 'short_1']);
    expect(renderResult.status).toBe('ok');
    expect(renderResult.succeededTargetIds).toEqual(['long', 'short_1']);
    expect(fs.existsSync(longOutput)).toBe(true);
    expect(fs.existsSync(shortOutput)).toBe(true);
    // The PLAN stays authoritative even though a sub-range was encoded.
    expect(renderResult.results[0]!.renderResult!.durationInFrames).toBe(PLAN_RENDER_CANONICAL.durationInFrames);
    expect(renderResult.results[0]!.renderResult!.authoritativeDurationSeconds).toBe(PLAN_RENDER_CANONICAL.authoritativeSeconds);
    expect(renderResult.results[0]!.renderResult!.renderedFrameCount).toBe(LONG_RANGE[1] - LONG_RANGE[0] + 1);
    expect(renderResult.results[1]!.renderResult!.renderedFrameCount).toBe(SHORT_RANGE[1] - SHORT_RANGE[0] + 1);
  });
});

describeReal('Phase 6D §28 — REAL Long delivery package', () => {
  it('carries a real H.264 1920x1080 MP4 with AAC audio, captions, descriptor, QC and a checksum', () => {
    const long = realPkg.package.targets.find((t) => t.targetId === 'long')!;
    expect(long.status).toBe('packaged');
    expect(long.directory).toBe('long');
    const m = long.qc!.metrics;

    // Real media technical QC of the COPIED packaged file.
    expect(m.exists).toBe(true);
    expect(m.sizeBytes).toBeGreaterThan(0);
    expect(m.videoCodec).toBe('h264');
    expect(m.width).toBe(1920);
    expect(m.height).toBe(1080);
    expect(m.fps).toBe(30);
    expect(m.hasAudio).toBe(true);
    expect(m.audioCodec).toBe('aac');
    expect(m.audioSampleRate).toBe(48000);
    expect(m.containerFormat).toContain('mp4');
    expect(m.durationSeconds!).toBeGreaterThan(0);

    // Duration QC: a sub-range render is evidence, and the package says so.
    expect(long.qc!.findings.map((f) => f.code)).toContain('PACKAGE_PARTIAL_FRAME_COVERAGE');
    expect(long.qc!.findings.map((f) => f.code)).toContain('PACKAGE_DURATION_TRUNCATED');
    // A 0.747s window is too short to judge full-silence, and `analyseFile`
    // reports longestSilence = 0 when it found NO silence. Neither may be
    // mistaken for a silent encode.
    expect(m.longestSilenceSeconds).toBe(0);
    expect(long.qc!.findings.map((f) => f.code)).not.toContain('PACKAGE_AUDIO_SILENT');
    expect(long.qc!.status).toBe('warn');
    expect(long.productionReady).toBe(false);

    // Descriptor + captions + QC evidence, all on disk.
    const descriptor = JSON.parse(read(realPkg.packageRoot, 'long/target.json'));
    expect(descriptor.targetId).toBe('long');
    expect(descriptor.width).toBe(1920);
    expect(descriptor.height).toBe(1080);
    expect(descriptor.fps).toBe(30);
    expect(descriptor.authoritativeDurationSeconds).toBe(118.74);
    expect(descriptor.durationInFrames).toBe(3563);
    expect(descriptor.sceneCount).toBe(5);
    expect(descriptor.canonicalAudioRefCount).toBe(12);
    expect(descriptor.captionCueCount).toBe(28);
    expect(descriptor.assetRefCount).toBe(2);
    expect(descriptor.compositionId).toBe('VideoPlan');
    expect(descriptor.renderedWithAudio).toBe(true);
    expect(descriptor.sourceRenderFile).toBe('phase6d-real-long.mp4');
    expect(descriptor.videoSha256).toMatch(/^[0-9a-f]{64}$/);

    const captions = JSON.parse(read(realPkg.packageRoot, 'long/captions.json'));
    expect(captions.targetId).toBe('long');
    expect(captions.scenarioId).toBe('scenario-pm-01');
    expect(captions.count).toBe(28);
    expect(read(realPkg.packageRoot, 'long/captions.srt')).toMatch(/-->/);
    expect(read(realPkg.packageRoot, 'long/captions.vtt').startsWith('WEBVTT')).toBe(true);
    expect(read(realPkg.packageRoot, 'long/qc.md')).toContain('Verdict');
  }, 600_000);

  it('copied the render output without mutating it', () => {
    const long = realPkg.package.targets.find((t) => t.targetId === 'long')!;
    const integrity = realPkg.sourceIntegrity.find((i) => i.targetId === 'long')!;
    expect(integrity.unchanged).toBe(true);
    expect(integrity.sha256Before).toBe(sha256(longOutput));
    expect(integrity.sha256After).toBe(sha256(longOutput));
    expect(integrity.packagedSha256).toBe(sha256(longOutput));
    expect(sha256(abs(realPkg.packageRoot, 'long/video.mp4'))).toBe(sha256(longOutput));
    // The source render output still exists in place.
    expect(fs.existsSync(longOutput)).toBe(true);
    expect(long.qc!.metrics.sourceUnchanged).toBe(true);
  }, 120_000);
});

describeReal('Phase 6D §28 — REAL Short delivery package', () => {
  it('carries a real H.264 1080x1920 MP4 with AAC audio, its own captions, descriptor, QC and a checksum', () => {
    const short = realPkg.package.targets.find((t) => t.targetId === 'short_1')!;
    expect(short.status).toBe('packaged');
    expect(short.directory).toBe('shorts/short_1');
    const m = short.qc!.metrics;

    expect(m.videoCodec).toBe('h264');
    expect(m.width).toBe(1080);
    expect(m.height).toBe(1920);
    expect(m.fps).toBe(30);
    expect(m.hasAudio).toBe(true);
    expect(m.audioCodec).toBe('aac');
    expect(short.qc!.status).toBe('warn');
    expect(short.productionReady).toBe(false);

    const descriptor = JSON.parse(read(realPkg.packageRoot, 'shorts/short_1/target.json'));
    expect(descriptor.targetId).toBe('short_1');
    expect(descriptor.width).toBe(1080);
    expect(descriptor.height).toBe(1920);
    expect(descriptor.durationInFrames).toBe(1470);
    expect(descriptor.authoritativeDurationSeconds).toBe(48.99);
    expect(descriptor.captionCueCount).toBe(15);
    expect(descriptor.canonicalAudioRefCount).toBe(7);
    expect(descriptor.sourceRenderFile).toBe('phase6d-real-short_1.mp4');

    // The Short's captions are its own, never the Long's.
    const shortCaptions = JSON.parse(read(realPkg.packageRoot, 'shorts/short_1/captions.json'));
    const longCaptions = JSON.parse(read(realPkg.packageRoot, 'long/captions.json'));
    expect(shortCaptions.targetId).toBe('short_1');
    expect(shortCaptions.count).toBe(15);
    expect(shortCaptions.cues.map((c: any) => c.id)).not.toEqual(longCaptions.cues.map((c: any) => c.id));
  }, 300_000);

  it('is fully isolated from the Long package', () => {
    const long = realPkg.package.targets.find((t) => t.targetId === 'long')!;
    const short = realPkg.package.targets.find((t) => t.targetId === 'short_1')!;
    expect(long.descriptor!.videoSha256).not.toBe(short.descriptor!.videoSha256);
    expect(sha256(abs(realPkg.packageRoot, 'shorts/short_1/video.mp4'))).toBe(sha256(shortOutput));
    expect(read(realPkg.packageRoot, 'manifest/checksums.sha256')).toContain('shorts/short_1/video.mp4');
    expect(read(realPkg.packageRoot, 'manifest/checksums.sha256')).toContain('long/video.mp4');
  }, 120_000);
});

describeReal('Phase 6D §29/§30 — a real sub-range render is evidence, never a delivery', () => {
  it('packages the Long + Short as a partial, test-evidence, not-ready package', () => {
    const p = realPkg.package;
    expect(p.mode).toBe('test-evidence');
    expect(p.status).toBe('partial');
    expect(p.readyForProductionDelivery).toBe(false);
    expect(p.manifest.status).toBe('partial');
    expect(p.manifest.readyForProductionDelivery).toBe(false);
    expect(p.manifest.targets.map((t) => t.targetId)).toEqual(['long', 'short_1']);
    expect(p.manifest.targets.every((t) => t.productionReady === false)).toBe(true);
    // The full-coverage failure is stated in the manifest, per target.
    expect(p.manifest.targets[0]!.qc!.status).toBe('warn');
  }, 120_000);

  it('§30 still refuses production readiness for a frame-range render in production mode', async () => {
    const strict = await buildProductionDeliveryPackage({
      targetSet: longSet,
      renderResult,
      packageRoot: path.join(SCRATCH, 'package-production-mode'),
      mode: 'production',
      clean: 'full',
    });
    // The SAME real media, judged in production mode, blocks both targets.
    expect(strict.package.status).toBe('blocked');
    expect(strict.package.readyForProductionDelivery).toBe(false);
    for (const id of ['long', 'short_1'] as const) {
      const codes = strict.package.targets.find((t) => t.targetId === id)!.qc!.findings.map((f) => f.code);
      expect(codes).toContain('PACKAGE_PARTIAL_FRAME_COVERAGE');
      expect(codes).toContain('PACKAGE_DURATION_TRUNCATED');
      expect(strict.package.targets.find((t) => t.targetId === id)!.qc!.status).toBe('fail');
    }
    // Blocked means no media shipped.
    expect(fs.existsSync(abs(strict.packageRoot, 'long'))).toBe(false);
    expect(fs.existsSync(abs(strict.packageRoot, 'shorts/short_1'))).toBe(false);
  }, 300_000);
});

describeReal('Phase 6D §31 — canonical Phase 6B evidence stays historical', () => {
  it('never pretends the ignored 3563-frame canonical MP4 still exists', () => {
    // The canonical full render is not repeated and is not present in the repo.
    expect(fs.existsSync(path.join(SCRATCH, 'phase6d-real-long.mp4'))).toBe(true);
    expect(renderResult.results[0]!.renderResult!.renderedFrameCount).toBeLessThan(PLAN_RENDER_CANONICAL.durationInFrames);
    // The package summary and manifest both record the partial coverage.
    const summary = JSON.parse(read(realPkg.packageRoot, 'evidence/package_summary.json'));
    expect(summary.readyForProductionDelivery).toBe(false);
    expect(summary.mode).toBe('test-evidence');
  }, 60_000);
});

describeReal('Phase 6D §32 — the real package is portable and deterministic', () => {
  it('rebuilds byte-identical metadata from the same real media', async () => {
    const again = await buildProductionDeliveryPackage({
      targetSet: longSet,
      renderResult,
      packageRoot: path.join(SCRATCH, 'package-again'),
      mode: 'test-evidence',
      clean: 'full',
    });
    for (const rel of ['manifest/delivery_manifest.json', 'manifest/checksums.sha256', 'evidence/package_summary.json', 'long/qc.md', 'long/target.json', 'shorts/short_1/captions.srt']) {
      expect(read(again.packageRoot, rel)).toBe(read(realPkg.packageRoot, rel));
    }
    const text = read(realPkg.packageRoot, 'manifest/delivery_manifest.json');
    expect(text).not.toContain(SCRATCH);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('.stills');
  }, 300_000);

  it('every checksummed artifact exists with the recorded digest', () => {
    for (const line of read(realPkg.packageRoot, 'manifest/checksums.sha256').trim().split('\n')) {
      const [digest, rel] = line.split('  ') as [string, string];
      expect(fs.existsSync(abs(realPkg.packageRoot, rel))).toBe(true);
      expect(sha256(abs(realPkg.packageRoot, rel))).toBe(digest);
    }
    expect(read(realPkg.packageRoot, 'manifest/checksums.sha256')).toContain(packageTargetFile('long', 'video.mp4'));
  }, 120_000);
});
