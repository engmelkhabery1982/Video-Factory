/**
 * @vitest-environment happy-dom
 *
 * Phase 6B — Real Production Render Pipeline: contract tests (no browser).
 *
 * Covers every acceptance item that does not require encoding media:
 * plan validation, colour of the composition contract, locked timing,
 * canonical audio policy, direct Phase 6A mediaMap passthrough, the canonical
 * asset-visibility fix (real DOM), structured failures, immutability and
 * determinism.
 *
 * The REAL render (bundling, real Chromium, real MP4, ffprobe) lives in
 * `tests/phase6b-real-render.test.ts`.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupIsolatedTmp, createIsolatedTmp } from './helpers/isolated-tmp.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  MEDIA_CONSUMING_RENDERER_KEYS,
  PLAN_RENDER_CANONICAL,
  PLAN_RENDER_COMPOSITION_ID,
  PlanRenderError,
  REMOTION_FPS,
  assertSceneMediaVisible,
  canonicalTimingFacts,
  compileScenarioVisualPlan,
  expectedFramesForPlan,
  firstPlanRenderError,
  getBrandPreset,
  getProgressMeetingScenario,
  resolveProductionAssets,
  sceneMediaUrl,
  validatePlanForRender,
  type Asset,
  type RemotionCompositionPlan,
  type RemotionSceneCompositionSpec,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';
import { VideoCompositionPlan, resolveSceneMediaUrl } from '../packages/video/src/compositions/VideoCompositionPlan.js';
import { PlanSceneRenderer, mapRendererKeyToVariant } from '../packages/video/src/scenes/PlanSceneRenderer.js';
import { normaliseFrameRange, videoPlanInputProps } from '../apps/api/src/services/render.js';

/* ── Remotion is mocked: this file must never spin up a browser ──────── */
vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  return {
    ...actual,
    useCurrentFrame: () => 0,
    useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080, durationInFrames: 3563 }),
    Sequence: (props: { children?: React.ReactNode }) => (props.children ?? null) as React.ReactElement,
    Audio: () => null,
  };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CANONICAL_SCENE = 'sc-02-context';
const CANONICAL_ASSET_REF = 'asset-iva-progress-chart';
const CANONICAL_URL = 'http://127.0.0.1:3000/media/asset/asset-progress-chart-real';

// buildDialogueProductionPlan requires RELATIVE base paths (safety rule).
// Per-suite scratch directory: unique per suite, so parallel suites cannot
// delete each other's audio scratch (the shared `.test-phase6b` race).
const TMP = createIsolatedTmp('phase6b-plan-render');

afterAll(() => {
  cleanupIsolatedTmp(TMP);
});

/** A real Phase 5C plan built from the canonical progress-meeting scenario. */
let cachedPlan: RemotionCompositionPlan | null = null;
async function canonicalPlan(): Promise<RemotionCompositionPlan> {
  if (cachedPlan) return cachedPlan;
  const scenario = getProgressMeetingScenario();
  const visual = compileScenarioVisualPlan(scenario);
  if (!visual.ok) throw new Error('compileScenarioVisualPlan failed');

  const dialogue = await buildDialogueProductionPlan(scenario, {
    synthesisBasePath: `${TMP}/audio/dialogue`,
    canonicalBasePath: `${TMP}/audio/canonical`,
  });
  if (!dialogue.success) throw new Error(`buildDialogueProductionPlan failed: ${dialogue.error}`);

  const visualProd = buildVisualProductionPlan({ scenario, visualPlan: visual.plan, dialogueResult: dialogue.result });
  if (!visualProd.success) throw new Error(`buildVisualProductionPlan failed: ${visualProd.error}`);

  const sceneRender = buildSceneRenderPlan({ scenario, visualProductionPlan: visualProd.plan });
  if (!sceneRender.success) throw new Error(`buildSceneRenderPlan failed: ${sceneRender.error}`);

  const remotion = buildRemotionCompositionProps(sceneRender.plan);
  if (!remotion.success) throw new Error(`buildRemotionCompositionProps failed: ${remotion.error}`);

  cachedPlan = remotion.plan;
  return cachedPlan;
}

/** The canonical asset resolved by the real Phase 6A API. */
function realChartAsset(): Asset {
  return {
    id: 'asset-progress-chart-real',
    name: 'Progress Chart',
    kind: 'chart',
    fileName: 'progress-chart.png',
    path: 'assets/progress-chart.png',
    mimeType: 'image/png',
    sizeBytes: 12345,
    tags: [`asset-ref:${CANONICAL_ASSET_REF}`],
    status: 'active',
    preferred: true,
    source: 'Operator upload',
    license: 'Operator owned',
    addedAt: '2026-09-30T00:00:00.000Z',
    usedIn: [],
    blocked: false,
  };
}

function canonicalMediaMap(plan: RemotionCompositionPlan): Record<string, string> {
  return resolveProductionAssets({
    plan,
    assets: [realChartAsset()],
    assetUrlById: { 'asset-progress-chart-real': CANONICAL_URL },
  }).mediaMap;
}

function renderToHtml(node: React.ReactElement): string {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root | null = null;
  act(() => {
    root = createRoot(host);
    root.render(node);
  });
  void root;
  return host.innerHTML;
}

const sceneOf = (plan: RemotionCompositionPlan, id = CANONICAL_SCENE): RemotionSceneCompositionSpec => {
  const found = plan.scenes.find((s) => s.sceneId === id);
  if (!found) throw new Error(`scene ${id} not found in plan`);
  return found;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Phase 6B — plan renderer accepts a valid RemotionCompositionPlan', () => {
  it('accepts the canonical Phase 5C plan with no findings at all', async () => {
    const plan = await canonicalPlan();
    expect(plan.valid).toBe(true);
    expect(validatePlanForRender(plan)).toEqual([]);
    expect(firstPlanRenderError(plan)).toBeNull();
  });

  it('exposes a small structured error vocabulary (no parallel framework)', () => {
    const err = new PlanRenderError('PLAN_RENDER_INVALID_PLAN', 'nope', { scenarioId: 'x' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PlanRenderError');
    expect(err.code).toBe('PLAN_RENDER_INVALID_PLAN');
    expect(err.details).toEqual({ scenarioId: 'x' });
    // codes required by the Phase 6B contract
    for (const code of [
      'PLAN_RENDER_INVALID_INPUT',
      'PLAN_RENDER_INVALID_PLAN',
      'PLAN_RENDER_COMPOSITION_NOT_FOUND',
      'PLAN_RENDER_FAILED',
      'PLAN_RENDER_OUTPUT_MISSING',
      'PLAN_RENDER_AUDIO_MISSING',
      'PLAN_RENDER_MEDIA_NOT_VISIBLE',
      'PLAN_RENDER_TIMING_MISMATCH',
    ]) {
      expect(new PlanRenderError(code as never, 'x').code).toBe(code);
    }
  });
});

describe('Phase 6B — renderer selects VideoPlan, never LongVideo/ShortVideo', () => {
  it('targets the VideoPlan composition id', () => {
    expect(PLAN_RENDER_COMPOSITION_ID).toBe('VideoPlan');
    expect(PLAN_RENDER_COMPOSITION_ID).not.toBe('LongVideo');
    expect(PLAN_RENDER_COMPOSITION_ID).not.toBe('ShortVideo');
  });

  it('declares VideoPlan in Root.tsx, wired to the plan composition', () => {
    const root = fs.readFileSync(path.join(process.cwd(), 'packages/video/src/Root.tsx'), 'utf8');
    expect(root).toContain('id="VideoPlan"');
    expect(root).toContain('VideoCompositionPlan');
    expect(root).toContain('props.plan?.durationInFrames');
  });

  it('hands the plan itself to the composition, never a legacy Scene[]', async () => {
    const plan = await canonicalPlan();
    const props = videoPlanInputProps(plan, { mediaMap: {} });
    expect(props.plan).toBe(plan);
    expect(Object.keys(props)).not.toContain('scenes');
    expect(Object.keys(props).sort()).toEqual(['burnedCaptions', 'captionStyle', 'format', 'mediaMap', 'plan']);
  });

  it('the plan render path in render.ts has no legacy-renderer or ffmpeg-mux reference', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'apps/api/src/services/render.ts'), 'utf8');
    const start = src.indexOf('export async function renderCompositionPlan');
    const end = src.indexOf('export async function renderPlanStill');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain('PLAN_RENDER_COMPOSITION_ID');
    expect(body).not.toContain('LongVideo');
    expect(body).not.toContain('ShortVideo');
    expect(body).not.toContain('muxAndEncode');
    expect(body).not.toContain('audioSrc');
  });

  it('the plan render path never consults Project.storyboard / LongPlan / ShortPlan', () => {
    const core = fs.readFileSync(path.join(process.cwd(), 'packages/core/src/scenario/plan-render-validation.ts'), 'utf8');
    const code = core.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('storyboard');
    expect(code).not.toContain('LongPlan');
    expect(code).not.toContain('ShortPlan');
    expect(code).not.toContain('Scene[]');
  });
});

describe('Phase 6B — selected metadata comes from the plan', () => {
  it('uses the plan fps', async () => {
    const plan = await canonicalPlan();
    expect(plan.fps).toBe(REMOTION_FPS);
    expect(plan.fps).toBe(30);
    expect(videoPlanInputProps(plan, { mediaMap: {} }).plan.fps).toBe(30);
  });

  it('uses the plan width and height', async () => {
    const plan = await canonicalPlan();
    expect([plan.width, plan.height]).toEqual([1920, 1080]);
  });

  it('uses the plan durationInFrames as the exclusive boundary', async () => {
    const plan = await canonicalPlan();
    expect(plan.durationInFrames).toBe(3563);
    expect(sceneOf(plan, plan.scenes[plan.scenes.length - 1]!.sceneId).endFrame).toBe(plan.durationInFrames);
  });

  it('derives the expected frame count from the plan’s own authoritative seconds', async () => {
    const plan = await canonicalPlan();
    expect(expectedFramesForPlan(plan)).toBe(plan.durationInFrames);
    expect(expectedFramesForPlan({ totalActualDurationSeconds: 118.74, fps: 30 })).toBe(3563);
    expect(expectedFramesForPlan({ totalActualDurationSeconds: 102, fps: 30 })).toBe(3060);
  });
});

describe('Phase 6B — canonical timing is locked (118.74s / 3563 frames)', () => {
  it('records the canonical timing facts', async () => {
    expect(canonicalTimingFacts()).toEqual({
      fps: 30,
      authoritativeSeconds: 118.74,
      rawFrameValue: 3562.2,
      durationInFrames: 3563,
      lastValidFrame: 3562,
      estimatorSeconds: 102,
    });
    expect(PLAN_RENDER_CANONICAL).toEqual(canonicalTimingFacts());
  });

  it('the canonical plan carries 118.74s -> 3563 frames, final index 3562', async () => {
    const plan = await canonicalPlan();
    expect(plan.totalActualDurationSeconds).toBe(118.74);
    expect(plan.durationInFrames).toBe(3563);
    expect(plan.durationInFrames - 1).toBe(3562);
    expect(118.74 * 30).toBeCloseTo(3562.2, 6);
    expect(Math.ceil(118.74 * 30)).toBe(3563);
  });

  it('does not fall back to the 102s estimator timing', async () => {
    const plan = await canonicalPlan();
    expect(plan.totalEstimatedDurationSeconds).toBe(102);
    expect(plan.totalEstimatedDurationSeconds).not.toBe(plan.totalActualDurationSeconds);
    expect(plan.durationInFrames).not.toBe(Math.ceil(102 * 30));
    expect(plan.durationInFrames).not.toBe(3060);
  });

  it('rejects a plan sized by the estimator with PLAN_RENDER_TIMING_MISMATCH', async () => {
    const plan = await canonicalPlan();
    const estimatorSized = { ...plan, durationInFrames: 3060 } as unknown;
    const codes = validatePlanForRender(estimatorSized)
      .filter((f) => f.severity === 'error')
      .map((f) => f.code);
    expect(codes).toContain('PLAN_RENDER_TIMING_MISMATCH');
  });

  it('rejects a plan whose timeline does not reach the authoritative end', async () => {
    const plan = await canonicalPlan();
    const truncated = {
      ...plan,
      scenes: plan.scenes.map((s, i) => (i === plan.scenes.length - 1 ? { ...s, endFrame: s.endFrame - 5, durationInFrames: s.durationInFrames - 5 } : s)),
    };
    const codes = validatePlanForRender(truncated)
      .filter((f) => f.severity === 'error')
      .map((f) => f.code);
    expect(codes).toContain('PLAN_RENDER_TIMING_MISMATCH');
  });

  it('rejects zero / invalid frame counts structurally', async () => {
    const plan = await canonicalPlan();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const codes = validatePlanForRender({ ...plan, durationInFrames: bad })
        .filter((f) => f.severity === 'error')
        .map((f) => f.code);
      expect(codes).toContain('PLAN_RENDER_INVALID_FRAME_COUNT');
    }
  });
});

describe('Phase 6B — canonical audio stays enabled and authoritative', () => {
  it('the canonical plan carries audio refs on every scene that has dialogue', async () => {
    const plan = await canonicalPlan();
    const audioRefCount = plan.scenes.reduce((n, s) => n + s.audioRefs.length, 0);
    expect(audioRefCount).toBeGreaterThan(0);
    expect(plan.summary.audioRefCount).toBe(audioRefCount);
    for (const scene of plan.scenes) {
      for (const a of scene.audioRefs) {
        expect(typeof a.canonicalPath).toBe('string');
        expect(a.canonicalPath.length).toBeGreaterThan(0);
      }
    }
  });

  it('the VideoPlan composition renders canonical audio with <Audio>, never muted', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'packages/video/src/compositions/VideoCompositionPlan.tsx'), 'utf8');
    expect(src).toContain('<Audio');
    expect(src).toContain('scene.audioRefs.map');
    expect(src).not.toContain('volume={0}');
    expect(src).not.toContain('muted');
  });

  it('a plan with no audio is a WARNING, never a silent failure', async () => {
    const plan = await canonicalPlan();
    const silent: RemotionCompositionPlan = { ...plan, scenes: plan.scenes.map((s) => ({ ...s, audioRefs: [] })) };
    const findings = validatePlanForRender(silent);
    expect(findings.filter((f) => f.code === 'PLAN_RENDER_AUDIO_MISSING').every((f) => f.severity === 'warning')).toBe(true);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('an audio ref with no canonical path is a hard error', async () => {
    const plan = await canonicalPlan();
    const broken: RemotionCompositionPlan = {
      ...plan,
      scenes: plan.scenes.map((s, i) =>
        i === 1 ? { ...s, audioRefs: s.audioRefs.map((a, j) => (j === 0 ? { ...a, canonicalPath: '' } : a)) } : s,
      ),
    };
    const codes = validatePlanForRender(broken)
      .filter((f) => f.severity === 'error')
      .map((f) => f.code);
    expect(codes).toContain('PLAN_RENDER_AUDIO_MISSING');
  });
});

describe('Phase 6B — Phase 6A mediaMap is passed through unchanged', () => {
  it('keys stay logical assetRefs; the report output is consumed verbatim', async () => {
    const plan = await canonicalPlan();
    const mediaMap = canonicalMediaMap(plan);
    expect(mediaMap).toEqual({ [CANONICAL_ASSET_REF]: CANONICAL_URL });
    expect(videoPlanInputProps(plan, { mediaMap }).mediaMap).toBe(mediaMap);
  });

  it('feeds report.mediaMap straight into the VideoPlan composition props', async () => {
    const plan = await canonicalPlan();
    const report = resolveProductionAssets({
      plan,
      assets: [realChartAsset()],
      assetUrlById: { 'asset-progress-chart-real': CANONICAL_URL },
    });
    const props = videoPlanInputProps(plan, { mediaMap: report.mediaMap });
    expect(props.mediaMap).toEqual({ [CANONICAL_ASSET_REF]: CANONICAL_URL });
    expect(props.mediaMap[CANONICAL_ASSET_REF]).toBe(CANONICAL_URL);
    expect(resolveSceneMediaUrl(sceneOf(plan), props.mediaMap)).toBe(CANONICAL_URL);
  });

  it('does not re-key to assetIds or fuzzy match', async () => {
    const plan = await canonicalPlan();
    const html = renderToHtml(
      React.createElement(VideoCompositionPlan, {
        plan,
        mediaMap: { 'asset-progress-chart-real': CANONICAL_URL, unrelated: 'https://example.invalid/x.png' },
        burnedCaptions: false,
      }),
    );
    expect(html).not.toContain('asset-progress-chart-real');
    expect(html).not.toContain('example.invalid');
  });

  it('a scene with unresolved optional media still renders and is only warned about', async () => {
    const plan = await canonicalPlan();
    const findings = validatePlanForRender(plan, {});
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(findings.some((f) => f.severity === 'warning' && f.code === 'PLAN_RENDER_MEDIA_NOT_VISIBLE')).toBe(true);

    const html = renderToHtml(React.createElement(VideoCompositionPlan, { plan, mediaMap: {}, burnedCaptions: false }));
    expect(html.length).toBeGreaterThan(0);
    expect(html).not.toContain('buildtrack-resolved-media');
    expect(html).not.toContain('url(http');
  });
});

describe('Phase 6B — canonical sc-02-context visibly uses its resolved asset', () => {
  it('the real scene uses rendererKey explanation:key_statement with the canonical ref', async () => {
    const plan = await canonicalPlan();
    const scene = sceneOf(plan);
    expect(scene.rendererKey).toBe('explanation:key_statement');
    expect(mapRendererKeyToVariant(scene.rendererKey).variant).toBe('key_statement');
    expect(scene.assetRefs.map((r) => r.assetRef)).toEqual([CANONICAL_ASSET_REF, CANONICAL_ASSET_REF]);
    expect(scene.assetRefs.map((r) => r.cueKind)).toEqual(['screen_insert_title', 'screen_insert_description']);
  });

  it('key_statement is registered as a media-consuming renderer', () => {
    expect(MEDIA_CONSUMING_RENDERER_KEYS.has('explanation:key_statement')).toBe(true);
  });

  it('renders the resolved URL in the DOM of the real canonical scene (no rendererKey change)', async () => {
    const plan = await canonicalPlan();
    const mediaMap = canonicalMediaMap(plan);
    const scene = sceneOf(plan);

    const html = renderToHtml(
      React.createElement(PlanSceneRenderer, {
        scene,
        brand: getBrandPreset('buildtrack'),
        format: 'long',
        mediaUrl: resolveSceneMediaUrl(scene, mediaMap),
      }),
    );

    expect(html).toContain(CANONICAL_URL);
    expect(html).toContain('buildtrack-resolved-media');
    expect(html).toContain('background-image: url(');
    // the rendererKey was not falsified to prove this
    expect(scene.rendererKey).toBe('explanation:key_statement');
  });

  it('the asset-visibility gate passes for the canonical scene and fails when the renderer cannot show media', async () => {
    const plan = await canonicalPlan();
    const mediaMap = canonicalMediaMap(plan);
    expect(assertSceneMediaVisible(sceneOf(plan), mediaMap)).toBe(CANONICAL_URL);

    // A dialogue scene with an evidence beat is visible regardless of its
    // legacy renderer key. Remove the evidence presentation to model a truly
    // blind scene while preserving the original negative safety assertion.
    const blindScene = {
      ...sceneOf(plan),
      rendererKey: 'explanation:myth_vs_reality',
      beats: sceneOf(plan).beats.map((beat) => ({
        ...beat,
        evidenceIds: [],
        shot: { ...beat.shot, speakerFocus: 'speaking_character' as const },
      })),
    } as RemotionSceneCompositionSpec;
    expect(() => assertSceneMediaVisible(blindScene, mediaMap)).toThrowError(PlanRenderError);
    try {
      assertSceneMediaVisible(blindScene, mediaMap);
    } catch (err) {
      expect((err as PlanRenderError).code).toBe('PLAN_RENDER_MEDIA_NOT_VISIBLE');
    }
    const codes = validatePlanForRender({ ...plan, scenes: [blindScene, ...plan.scenes.slice(1)] }, mediaMap)
      .filter((f) => f.severity === 'error')
      .map((f) => f.code);
    expect(codes).toContain('PLAN_RENDER_MEDIA_NOT_VISIBLE');
  });

  it('ignores the resolved URL entirely when the plan/mediaMap has none', async () => {
    const plan = await canonicalPlan();
    const scene = sceneOf(plan);
    const html = renderToHtml(
      React.createElement(PlanSceneRenderer, { scene, brand: getBrandPreset('buildtrack'), format: 'long', mediaUrl: null }),
    );
    expect(html).not.toContain(CANONICAL_URL);
    expect(html).not.toContain('buildtrack-resolved-media');
  });

  it('sceneMediaUrl follows assetRefs order and ignores empty values', () => {
    const scene = { assetRefs: [{ assetRef: 'a' }, { assetRef: 'b' }] } as unknown as RemotionSceneCompositionSpec;
    expect(sceneMediaUrl(scene, { a: '', b: 'http://x/b.png' })).toBe('http://x/b.png');
    expect(sceneMediaUrl(scene, { b: 'http://x/b.png' })).toBe('http://x/b.png');
    expect(sceneMediaUrl(scene, {})).toBeNull();
    expect(sceneMediaUrl(scene, undefined)).toBeNull();
  });

  it('the plan’s own resolved-media DOM is deterministic across renders', async () => {
    const plan = await canonicalPlan();
    const mediaMap = canonicalMediaMap(plan);
    const scene = sceneOf(plan);
    const a = renderToHtml(React.createElement(PlanSceneRenderer, { scene, mediaUrl: resolveSceneMediaUrl(scene, mediaMap) }));
    document.body.innerHTML = '';
    const b = renderToHtml(React.createElement(PlanSceneRenderer, { scene, mediaUrl: resolveSceneMediaUrl(scene, mediaMap) }));
    expect(a).toBe(b);
  });
});

describe('Retry 10 — generated dialogue hook with bound source-record media', () => {
  it('accepts and visibly renders media on the evidence beat despite hook:generic', async () => {
    const plan = await canonicalPlan();
    const source = sceneOf(plan);
    const url = 'http://127.0.0.1:3000/media/asset/short-evidence';
    const ref = 'source-record:ev-short-03';
    const hook: RemotionSceneCompositionSpec = {
      ...source,
      rendererKey: 'hook:generic',
      rendererCategory: 'hook',
      participantIds: ['speaker-a', 'speaker-b'],
      beats: [{
        ...source.beats[0],
        kind: 'dialogue',
        evidenceIds: ['ev-short-03'],
        shot: { ...source.beats[0].shot, speakerFocus: 'document' },
      }],
      assetRefs: [{ ...source.assetRefs[0], assetRef: ref }],
    };
    const mediaMap = { [ref]: url };

    expect(assertSceneMediaVisible(hook, mediaMap)).toBe(url);
    expect(validatePlanForRender({ ...plan, scenes: [hook, ...plan.scenes.slice(1)] }, mediaMap)
      .filter((finding) => finding.severity === 'error' && finding.code === 'PLAN_RENDER_MEDIA_NOT_VISIBLE')).toEqual([]);
    const html = renderToHtml(React.createElement(PlanSceneRenderer, {
      scene: hook,
      brand: getBrandPreset('buildtrack'),
      format: 'short',
      mediaUrl: url,
    }));
    expect(html).toContain('data-dialogue-evidence');
    expect(html).toContain('data-buildtrack-resolved-media');
    expect(html).toContain(url);
  });

  it('still rejects a bound dialogue hook whose beats never display evidence', async () => {
    const source = sceneOf(await canonicalPlan());
    const hook: RemotionSceneCompositionSpec = {
      ...source,
      rendererKey: 'hook:generic',
      rendererCategory: 'hook',
      participantIds: ['speaker-a', 'speaker-b'],
      beats: [{
        ...source.beats[0],
        kind: 'dialogue',
        evidenceIds: [],
        shot: { ...source.beats[0].shot, speakerFocus: 'speaking_character' },
      }],
    };
    expect(() => assertSceneMediaVisible(hook, { [CANONICAL_ASSET_REF]: CANONICAL_URL }))
      .toThrowError(PlanRenderError);
  });
});

describe('Phase 6B — invalid input fails structurally', () => {
  const errorCodes = (plan: unknown) =>
    validatePlanForRender(plan)
      .filter((f) => f.severity === 'error')
      .map((f) => f.code);

  it('rejects a missing plan', () => {
    expect(errorCodes(null)).toContain('PLAN_RENDER_INVALID_INPUT');
    expect(errorCodes(undefined)).toContain('PLAN_RENDER_INVALID_INPUT');
    expect(errorCodes('nope')).toContain('PLAN_RENDER_INVALID_INPUT');
  });

  it('rejects a plan with no scenes', async () => {
    const plan = await canonicalPlan();
    expect(errorCodes({ ...plan, scenes: [] })).toContain('PLAN_RENDER_INVALID_PLAN');
  });

  it('rejects a plan whose fps is not the locked 30', async () => {
    const plan = await canonicalPlan();
    expect(errorCodes({ ...plan, fps: 25 })).toContain('PLAN_RENDER_TIMING_MISMATCH');
    expect(errorCodes({ ...plan, fps: 24 })).toContain('PLAN_RENDER_TIMING_MISMATCH');
  });

  it('rejects a plan with non-positive dimensions', async () => {
    const plan = await canonicalPlan();
    expect(errorCodes({ ...plan, width: 0 })).toContain('PLAN_RENDER_INVALID_PLAN');
    expect(errorCodes({ ...plan, height: -10 })).toContain('PLAN_RENDER_INVALID_PLAN');
  });

  it('rejects a plan with a broken scene timeline', async () => {
    const plan = await canonicalPlan();
    const scenes = plan.scenes.map((s, i) => (i === 2 ? { ...s, endFrame: s.startFrame } : s));
    expect(errorCodes({ ...plan, scenes })).toContain('PLAN_RENDER_INVALID_FRAME_COUNT');
  });

  it('frame-range validation accepts an inclusive in-range sub-render and rejects the rest', async () => {
    const plan = await canonicalPlan();
    expect(normaliseFrameRange(null, plan)).toBeNull();
    expect(normaliseFrameRange([710, 739], plan)).toEqual([710, 739]);
    expect(normaliseFrameRange([0, 3562], plan)).toEqual([0, 3562]);
    for (const bad of [[-1, 10], [0, 3563], [900, 800], [0.5, 10], [3562, 3562.5]] as [number, number][]) {
      expect(() => normaliseFrameRange(bad, plan)).toThrowError(PlanRenderError);
    }
  });
});

describe('Phase 6B — no input mutation, deterministic render input props', () => {
  it('does not mutate the plan when building composition props', async () => {
    const plan = await canonicalPlan();
    const snapshot = JSON.stringify(plan);
    const mediaMap = canonicalMediaMap(plan);
    videoPlanInputProps(plan, { mediaMap });
    expect(JSON.stringify(plan)).toBe(snapshot);
    expect(mediaMap).toEqual({ [CANONICAL_ASSET_REF]: CANONICAL_URL });
  });

  it('does not mutate the media map when rendering the composition to DOM', async () => {
    const plan = await canonicalPlan();
    const mediaMap = canonicalMediaMap(plan);
    const snapshot = JSON.stringify(mediaMap);
    renderToHtml(React.createElement(VideoCompositionPlan, { plan, mediaMap, burnedCaptions: false }));
    expect(JSON.stringify(mediaMap)).toBe(snapshot);
  });

  it('produces identical composition props for identical inputs', async () => {
    const plan = await canonicalPlan();
    const mediaMap = canonicalMediaMap(plan);
    expect(videoPlanInputProps(plan, { mediaMap })).toEqual(videoPlanInputProps(plan, { mediaMap }));
    expect(JSON.stringify(videoPlanInputProps(plan, { mediaMap }))).toBe(JSON.stringify(videoPlanInputProps(plan, { mediaMap })));
  });

  it('validating a frozen plan does not throw and does not mutate', async () => {
    const plan = await canonicalPlan();
    const frozen = Object.freeze({
      ...plan,
      scenes: plan.scenes.map((s) => Object.freeze({ ...s, assetRefs: Object.freeze([...s.assetRefs]), audioRefs: Object.freeze([...s.audioRefs]) })),
    });
    expect(() => validatePlanForRender(frozen)).not.toThrow();
    expect(validatePlanForRender(frozen)).toEqual([]);
  });
});

describe('Phase 6B — Phase 6A contract remains intact', () => {
  it('the canonical resolution report is still valid/ok with 2 usages of 1 unique ref', async () => {
    const plan = await canonicalPlan();
    const report = resolveProductionAssets({
      plan,
      assets: [realChartAsset()],
      assetUrlById: { 'asset-progress-chart-real': CANONICAL_URL },
    });
    expect(report.valid).toBe(true);
    expect(report.summary.status).toBe('ok');
    expect(report.summary.totalUsages).toBe(2);
    expect(report.summary.totalUniqueLogicalRefs).toBe(1);
    expect(report.summary.totalRenderUrlsResolved).toBe(1);
    expect(report.assetIdMap[CANONICAL_ASSET_REF]).toBe('asset-progress-chart-real');
    expect(report.mediaMap).toEqual({ [CANONICAL_ASSET_REF]: CANONICAL_URL });
  });

  it('unresolved optional media keeps the report valid and the mediaMap empty', async () => {
    const plan = await canonicalPlan();
    const report = resolveProductionAssets({ plan, assets: [] });
    expect(report.valid).toBe(true);
    expect(report.summary.warningCount).toBe(1);
    expect(report.summary.errorCount).toBe(0);
    expect(report.mediaMap).toEqual({});
    expect(validatePlanForRender(plan, report.mediaMap).filter((f) => f.severity === 'error')).toEqual([]);
  });
});
