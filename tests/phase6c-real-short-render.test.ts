/**
 * Phase 6C §18 — REAL Short-format render gate.
 *
 * These tests drive the real Phase 6B renderer through the Phase 6C delivery
 * service:
 *
 *   renderProductionDeliveryTargets(...)
 *     -> renderCompositionPlan(...)
 *       -> VideoPlan -> @remotion/renderer -> real encoded MP4
 *
 * Cost control: the plan is never shortened or re-timed. A small INCLUSIVE
 * frame sub-range is encoded via Remotion's `frameRange`, so the plan's
 * `durationInFrames` stays the authority while the encode stays cheap. The
 * full 3563-frame canonical Long render is NOT repeated here; Phase 6B already
 * proved it (see PHASE6B_REAL_PRODUCTION_RENDER_HANDOFF.md and EVIDENCE/phase6b).
 *
 * Offline by construction: every audio clip is served by a local HTTP server
 * bound to 127.0.0.1 on a random port. The only thing rewritten is the
 * audit-only `canonicalPath` field of each audio ref (the plan stores a
 * repo-relative path; a browser needs a URL) - the same mapping Phase 6B uses,
 * and it is asserted to touch nothing else.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  buildProductionDeliveryTargets,
  compileScenarioVisualPlan,
  getProgressMeetingScenario,
  loadScenarioFixture,
  validatePlanForRender,
  type RemotionCompositionPlan,
  type Scenario,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';
import { renderProductionDeliveryTargets } from '../apps/api/src/services/plan-delivery.js';
import { analyseFile } from '../apps/api/src/services/media.js';
import { chromePath } from '../apps/api/src/services/platform.js';

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'render');
const SCRATCH = path.join(process.cwd(), '.stills', 'phase6c');
const AUDIO_SCRATCH = '.test-phase6c/render-audio';
const CANONICAL_PROJECT_ID = 'proj-hospital-expansion';
const LONG_ASSET_REF = 'asset-iva-progress-chart';
/** A Short-only logical ref, proving the Short's mediaMap is its own. */
const SHORT_MEDIA_REF = 'short-delivery-chart';

/**
 * The locally provisioned Chromium is required for a real render. It is 200 MB
 * and deliberately NOT installed in CI, so these tests SKIP when it is absent
 * instead of failing the suite. Locally they always run.
 */
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
  console.warn('[phase6c] no provisioned Chromium - skipping real render evidence (run `npm run provision`).');
}

/** Test-only transport mapping: repo-relative canonicalPath -> local HTTP URL. */
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
  const tag = `rplan-${++planSeq}`;
  const visual: any = compileScenarioVisualPlan(scenario);
  if (!visual.ok) throw new Error(`compileScenarioVisualPlan failed: ${JSON.stringify(visual.errors)}`);
  const dialogue: any = await buildDialogueProductionPlan(scenario, {
    synthesisBasePath: `${AUDIO_SCRATCH}/${tag}/audio/dialogue`,
    canonicalBasePath: `${AUDIO_SCRATCH}/${tag}/audio/canonical`,
  });
  if (!dialogue.success) throw new Error(`buildDialogueProductionPlan failed: ${dialogue.error}`);
  const visualProd: any = buildVisualProductionPlan({
    scenario,
    visualPlan: visual.plan,
    dialogueResult: dialogue.result,
  });
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

let server: http.Server;
let baseUrl = '';
let longPlan: RemotionCompositionPlan;
let shortPlan: RemotionCompositionPlan;
let brokenShortPlan: RemotionCompositionPlan;
/** Plan copies whose audio canonicalPath points at the local fixture server. */
let renderableLong: RemotionCompositionPlan;
let renderableShort: RemotionCompositionPlan;
let renderableBrokenShort: RemotionCompositionPlan;

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav' };

beforeAll(async () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.mkdirSync(AUDIO_SCRATCH, { recursive: true });

  server = http.createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const name = path.basename(rawPath);
    const file = path.join(FIXTURE_DIR, name);
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
  brokenShortPlan = { ...shortPlan, width: 1920, height: 1080 } as RemotionCompositionPlan;

  renderableLong = withRenderableAudio(longPlan, baseUrl);
  renderableShort = withRenderableAudio(shortPlan, baseUrl);
  renderableBrokenShort = withRenderableAudio(brokenShortPlan, baseUrl);
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A small window that definitely sits inside the first canonical audio clip. */
function audioWindow(plan: RemotionCompositionPlan, span: number): [number, number] {
  const audio = plan.scenes
    .flatMap((s) => s.audioRefs)
    .slice()
    .sort((a, b) => a.startFrame - b.startFrame)[0];
  const from = audio ? Math.max(0, audio.startFrame) : 0;
  const to = Math.min(plan.durationInFrames - 1, from + span - 1);
  return [from, to];
}

/* ================================================================== */

describe('Phase 6C §14/§18 — a real Short plan built by the pipeline', () => {
  it('is a genuine 1080x1920 / 30fps Short plan, not a resized Long', () => {
    expect(shortPlan.targetFormat).toBe('Short');
    expect(shortPlan.width).toBe(1080);
    expect(shortPlan.height).toBe(1920);
    expect(shortPlan.fps).toBe(30);
    expect(shortPlan.durationInFrames).toBe(1470);
    expect(shortPlan.totalActualDurationSeconds).toBe(48.99);
    expect(shortPlan.scenes.every((s) => s.width === 1080 && s.height === 1920)).toBe(true);
    expect(validatePlanForRender(shortPlan, {})).toEqual([]);
  });

  it('rewrites only the audit-only canonicalPath field for local transport', () => {
    expect(renderableShort.scenes.length).toBe(shortPlan.scenes.length);
    for (let i = 0; i < shortPlan.scenes.length; i++) {
      const before = shortPlan.scenes[i]!;
      const after = renderableShort.scenes[i]!;
      expect(after.audioRefs.length).toBe(before.audioRefs.length);
      for (let j = 0; j < before.audioRefs.length; j++) {
        const b = before.audioRefs[j]!;
        const a = after.audioRefs[j]!;
        expect({ ...a, canonicalPath: undefined }).toEqual({ ...b, canonicalPath: undefined });
        expect(a.canonicalPath.startsWith(`${baseUrl}/dialogue.wav?clip=`)).toBe(true);
      }
    }
  });
});

/* ================================================================== */

describeReal('Phase 6C §18 — real Short-format render through the delivery service', () => {
  it('encodes a real 1080x1920 H.264 MP4 with canonical audio and its own mediaMap', async () => {
    const set = buildProductionDeliveryTargets({
      longPlan: renderableLong,
      shortPlans: { short_1: renderableShort },
      mediaMapByTarget: {
        long: { [LONG_ASSET_REF]: `${baseUrl}/progress-chart.png` },
        short_1: { [SHORT_MEDIA_REF]: `${baseUrl}/progress-chart-alt.png` },
      },
    });
    expect(set.valid).toBe(true);
    expect(set.targets.map((t) => t.targetId)).toEqual(['long', 'short_1']);

    const longOut = path.join(SCRATCH, 'phase6c-long.mp4');
    const shortOut = path.join(SCRATCH, 'phase6c-short_1.mp4');

    const delivery = await renderProductionDeliveryTargets({
      targetSet: set,
      outputByTarget: { long: longOut, short_1: shortOut },
      quality: 'preview',
      frameRangeByTarget: {
        long: [0, 14],
        short_1: audioWindow(renderableShort, 60),
      },
    });

    // ── overall delivery outcome ──────────────────────────────────────
    expect(delivery.status).toBe('ok');
    expect(delivery.targetCount).toBe(2);
    expect(delivery.succeededTargetIds).toEqual(['long', 'short_1']);
    expect(delivery.failedTargetIds).toEqual([]);
    expect(delivery.results.map((r) => r.targetId)).toEqual(['long', 'short_1']);

    // ── the Short target is the deliverable under test ────────────────
    const shortResult = delivery.results.find((r) => r.targetId === 'short_1')!;
    expect(shortResult.success).toBe(true);
    expect(shortResult.scenarioId).toBe('scenario-sched-risk-03');
    expect(shortResult.projectId).toBe(CANONICAL_PROJECT_ID);

    const render = shortResult.renderResult!;
    expect(render.compositionId).toBe('VideoPlan');
    expect(render.width).toBe(1080);
    expect(render.height).toBe(1920);
    expect(render.fps).toBe(30);
    // The PLAN's duration stays authoritative, whatever sub-range was encoded.
    expect(render.durationInFrames).toBe(1470);
    expect(render.authoritativeDurationSeconds).toBe(48.99);
    expect(render.renderedFrameCount).toBe(60);
    expect(render.renderedWithAudio).toBe(true);
    // The per-target mediaMap reached the renderer.
    expect(render.mediaMapEntryCount).toBe(1);

    // ── the real encoded file ─────────────────────────────────────────
    expect(fs.existsSync(shortOut)).toBe(true);
    const size = fs.statSync(shortOut).size;
    expect(size).toBeGreaterThan(0);

    const analysis = await analyseFile(shortOut);
    expect(analysis.codec_name).toBe('h264');
    expect(analysis.width).toBe(1080);
    expect(analysis.height).toBe(1920);
    expect(analysis.r_frame_rate).toBe('30/1');
    expect(analysis.hasAudio).toBe(true);
    expect(analysis.audioCodec).toBe('aac');
    expect(analysis.sizeBytes).toBe(size);
    // The canonical clip is a tone: prove the stream is audible, not silence.
    expect(analysis.longestSilence).toBeLessThan(60 / 30 / 2);

    // ── output isolation: two targets, two distinct files ─────────────
    const longResult = delivery.results.find((r) => r.targetId === 'long')!;
    expect(longResult.success).toBe(true);
    expect(longResult.renderResult!.width).toBe(1920);
    expect(longResult.renderResult!.height).toBe(1080);
    expect(longResult.renderResult!.durationInFrames).toBe(3563);
    expect(longResult.renderResult!.renderedFrameCount).toBe(15);
    expect(fs.statSync(longOut).size).toBeGreaterThan(0);
    expect(longOut).not.toBe(shortOut);
  }, 900_000);
});

/* ================================================================== */

describeReal('Phase 6C §12 — real per-target failure isolation', () => {
  it('keeps successful renders visible when another target fails validation', async () => {
    const set = buildProductionDeliveryTargets({
      longPlan: renderableLong,
      shortPlans: { short_1: renderableShort, short_2: renderableBrokenShort },
      mediaMapByTarget: {
        long: { [LONG_ASSET_REF]: `${baseUrl}/progress-chart.png` },
        short_1: { [SHORT_MEDIA_REF]: `${baseUrl}/progress-chart-alt.png` },
        short_2: {},
      },
    });

    // short_2 never validates, so it is not delivered - but it stays visible.
    expect(set.valid).toBe(false);
    expect(set.targets.map((t) => t.targetId)).toEqual(['long', 'short_1']);

    const longOut = path.join(SCRATCH, 'phase6c-iso-long.mp4');
    const short1Out = path.join(SCRATCH, 'phase6c-iso-short_1.mp4');
    const short2Out = path.join(SCRATCH, 'phase6c-iso-short_2.mp4');
    for (const f of [longOut, short1Out, short2Out]) fs.rmSync(f, { force: true });

    const delivery = await renderProductionDeliveryTargets({
      targetSet: set,
      outputByTarget: { long: longOut, short_1: short1Out, short_2: short2Out },
      quality: 'preview',
      frameRangeByTarget: { long: [0, 9], short_1: [0, 9] },
    });

    // ── overall status is partial, not a silent substitution ──────────
    expect(delivery.status).toBe('partial');
    expect(delivery.targetCount).toBe(3);
    expect(delivery.succeededTargetIds).toEqual(['long', 'short_1']);
    expect(delivery.failedTargetIds).toEqual(['short_2']);
    expect(delivery.results.map((r) => r.targetId)).toEqual(['long', 'short_1', 'short_2']);

    // ── the successes survive intact ──────────────────────────────────
    expect(delivery.results[0]!.success).toBe(true);
    expect(delivery.results[0]!.renderResult!.width).toBe(1920);
    expect(fs.statSync(longOut).size).toBeGreaterThan(0);
    expect(delivery.results[1]!.success).toBe(true);
    expect(delivery.results[1]!.renderResult!.width).toBe(1080);
    expect(fs.statSync(short1Out).size).toBeGreaterThan(0);

    // ── the failure is structured and isolated ────────────────────────
    const failed = delivery.results[2]!;
    expect(failed.success).toBe(false);
    expect(failed.targetId).toBe('short_2');
    expect(failed.renderResult).toBeUndefined();
    expect(failed.error).toBeDefined();
    expect(failed.error!.code).toBe('DELIVERY_TARGET_DIMENSIONS_MISMATCH');
    expect(failed.error!.targetId).toBe('short_2');
    // It was blocked BEFORE rendering, so it wrote nothing.
    expect(fs.existsSync(short2Out)).toBe(false);
  }, 900_000);
});

/* ================================================================== */

describeReal('Phase 6C §11 — output path policy blocks rendering, not just metadata', () => {
  it('fails a target with no output path and never writes a file for it', async () => {
    const set = buildProductionDeliveryTargets({
      longPlan: renderableLong,
      shortPlans: { short_1: renderableShort },
      mediaMapByTarget: {
        long: { [LONG_ASSET_REF]: `${baseUrl}/progress-chart.png` },
        short_1: {},
      },
    });
    expect(set.valid).toBe(true);

    const longOut = path.join(SCRATCH, 'phase6c-nopath-long.mp4');
    fs.rmSync(longOut, { force: true });

    const delivery = await renderProductionDeliveryTargets({
      targetSet: set,
      outputByTarget: { long: longOut },
      quality: 'preview',
      frameRangeByTarget: { long: [0, 9] },
    });

    expect(delivery.status).toBe('partial');
    expect(delivery.succeededTargetIds).toEqual(['long']);
    expect(delivery.failedTargetIds).toEqual(['short_1']);
    expect(fs.statSync(longOut).size).toBeGreaterThan(0);

    const missing = delivery.results.find((r) => r.targetId === 'short_1')!;
    expect(missing.success).toBe(false);
    expect(missing.error!.code).toBe('DELIVERY_TARGET_OUTPUT_MISSING');
    expect(delivery.findings.map((f) => f.code)).toContain('DELIVERY_TARGET_OUTPUT_MISSING');
  }, 900_000);
});
