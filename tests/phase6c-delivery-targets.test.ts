/**
 * Phase 6C — plan-based production delivery targets.
 *
 * These tests prove the delivery-target CONTRACT. They never render: rendering
 * is proven separately in `phase6c-real-short-render.test.ts`.
 *
 * Fixture policy (Phase 6C §14): a Short target is NEVER produced by patching
 * `width`/`height` on a finished Long plan. Every Short plan here is built by
 * running the approved Scenario -> Phase 5 pipeline on a canonical scenario
 * that is already a Short-format scenario.
 *
 *   Scenario -> DialogueProductionResult -> VisualProductionPlan
 *     -> SceneRenderPlan -> RemotionCompositionPlan
 *
 * The canonical `schedule-risk` fixture is an approved Short scenario (41.4s),
 * so it compiles to a genuine 1080x1920 / 30fps / Short plan. It is retargeted
 * to the Long's `projectId` so both targets belong to one production/project
 * while each keeps its own `scenarioId` (Phase 6C §9).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  PLAN_RENDER_CANONICAL,
  buildProductionDeliveryTargets,
  compileScenarioVisualPlan,
  coveredDeliveryTargetIds,
  getProgressMeetingScenario,
  loadScenarioFixture,
  validateDeliveryOutputPaths,
  validatePlanForRender,
  type RemotionCompositionPlan,
  type Scenario,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';

const AUDIO_SCRATCH = '.test-phase6c/audio';
const CANONICAL_PROJECT_ID = 'proj-hospital-expansion';
const LONG_SCENARIO_ID = 'scenario-pm-01';
const SHORT_SCENARIO_ID = 'scenario-sched-risk-03';

/** The Long asset ref the canonical plan declares twice on sc-02-context. */
const LONG_ASSET_REF = 'asset-iva-progress-chart';

let planSeq = 0;

/**
 * Run the approved Phase 4 -> Phase 5 chain for one scenario. This is the ONLY
 * way a plan enters these tests: nothing here hand-builds a composition plan.
 */
async function buildPlan(scenario: Scenario): Promise<RemotionCompositionPlan> {
  const tag = `plan-${++planSeq}`;
  const visual: any = compileScenarioVisualPlan(scenario);
  if (!visual.ok) throw new Error(`compileScenarioVisualPlan failed: ${JSON.stringify(visual.errors)}`);

  // The path shape matters: Phase 5B asserts canonical clips live under
  // `audio/canonical`, so the per-plan scratch keeps that segment verbatim.
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

/**
 * A canonical Short scenario, immutably copied and independently identified.
 * `targetFormat` is set BEFORE the pipeline runs - never after.
 */
function shortScenario(scenarioId: string, projectId: string = CANONICAL_PROJECT_ID): Scenario {
  const base = loadScenarioFixture('schedule-risk');
  base.metadata = { ...base.metadata, targetFormat: 'Short', projectId, id: scenarioId };
  return base;
}

let longPlan: RemotionCompositionPlan;
let shortPlan1: RemotionCompositionPlan;
let shortPlan2: RemotionCompositionPlan;
let shortPlan3: RemotionCompositionPlan;
let foreignShortPlan: RemotionCompositionPlan;

beforeAll(async () => {
  fs.rmSync('.test-phase6c', { recursive: true, force: true });
  fs.mkdirSync(AUDIO_SCRATCH, { recursive: true });

  longPlan = await buildPlan(structuredClone(getProgressMeetingScenario()));
  shortPlan1 = await buildPlan(structuredClone(shortScenario(SHORT_SCENARIO_ID)));
  shortPlan2 = await buildPlan(structuredClone(shortScenario(`${SHORT_SCENARIO_ID}-s2`)));
  shortPlan3 = await buildPlan(structuredClone(shortScenario(`${SHORT_SCENARIO_ID}-s3`)));
  // Same canonical Short scenario, left in its OWN project: the mismatch case.
  foreignShortPlan = await buildPlan(structuredClone(shortScenario(SHORT_SCENARIO_ID, 'proj-biotech-campus')));
}, 300_000);

const countBeats = (plan: RemotionCompositionPlan) =>
  plan.scenes.reduce((n, s) => n + (s.beats?.length ?? 0), 0);
const countAudio = (plan: RemotionCompositionPlan) =>
  plan.scenes.reduce((n, s) => n + (s.audioRefs?.length ?? 0), 0);
const countCues = (plan: RemotionCompositionPlan) =>
  plan.scenes.reduce((n, s) => n + (s.captionCues?.length ?? 0), 0);
const countAssets = (plan: RemotionCompositionPlan) =>
  plan.scenes.reduce((n, s) => n + (s.assetRefs?.length ?? 0), 0);

const errorCodes = (findings: readonly { severity: string; code: string }[]) =>
  findings.filter((f) => f.severity === 'error').map((f) => f.code);

/* ================================================================== */
/*  §15 — canonical Long target                                        */
/* ================================================================== */

describe('Phase 6C §15 — canonical Long plan is unchanged', () => {
  it('keeps the locked scenario-pm-01 geometry and timing', () => {
    expect(longPlan.scenarioId).toBe(LONG_SCENARIO_ID);
    expect(longPlan.projectId).toBe(CANONICAL_PROJECT_ID);
    expect(longPlan.targetFormat).toBe('Long');
    expect(longPlan.width).toBe(1920);
    expect(longPlan.height).toBe(1080);
    expect(longPlan.fps).toBe(30);
    expect(longPlan.durationInFrames).toBe(3563);
    expect(longPlan.totalActualDurationSeconds).toBe(118.74);
    expect(longPlan.valid).toBe(true);
  });

  it('keeps the canonical 5 scenes / 12 audio / 28 captions / 12 beats / 2 assets', () => {
    expect(longPlan.scenes.length).toBe(5);
    expect(countAudio(longPlan)).toBe(12);
    expect(countCues(longPlan)).toBe(28);
    expect(countBeats(longPlan)).toBe(12);
    expect(countAssets(longPlan)).toBe(2);
  });

  it('does not regress to the 102s estimator duration', () => {
    expect(longPlan.totalEstimatedDurationSeconds).toBe(102);
    expect(longPlan.durationInFrames).not.toBe(Math.ceil(102 * 30));
    expect(longPlan.durationInFrames).toBe(PLAN_RENDER_CANONICAL.durationInFrames);
    expect(longPlan.durationInFrames - 1).toBe(PLAN_RENDER_CANONICAL.lastValidFrame);
  });

  it('is structurally renderable under the reused Phase 6B contract', () => {
    expect(validatePlanForRender(longPlan, { [LONG_ASSET_REF]: 'http://127.0.0.1/x/chart.png' })).toEqual([]);
  });
});

/* ================================================================== */
/*  §14 — a real Short plan, built by the pipeline                     */
/* ================================================================== */

describe('Phase 6C §14 — the Phase 5 pipeline produces a real Short-format plan', () => {
  it('naturally yields 1080x1920 / 30fps / Short without any dimension patching', () => {
    expect(shortPlan1.targetFormat).toBe('Short');
    expect(shortPlan1.width).toBe(1080);
    expect(shortPlan1.height).toBe(1920);
    expect(shortPlan1.fps).toBe(30);
    expect(shortPlan1.valid).toBe(true);
  });

  it('carries Short geometry on EVERY scene, proving the pipeline set it', () => {
    expect(shortPlan1.scenes.length).toBeGreaterThan(0);
    for (const scene of shortPlan1.scenes) {
      expect(scene.targetFormat).toBe('Short');
      expect(scene.width).toBe(1080);
      expect(scene.height).toBe(1920);
    }
  });

  it('has its own duration, audio, captions and scene count - not the Long ones', () => {
    expect(shortPlan1.scenarioId).toBe(SHORT_SCENARIO_ID);
    expect(shortPlan1.durationInFrames).toBe(1470);
    expect(shortPlan1.totalActualDurationSeconds).toBe(48.99);
    expect(shortPlan1.scenes.length).toBe(3);
    expect(countAudio(shortPlan1)).toBe(7);
    expect(countCues(shortPlan1)).toBe(15);
    expect(countBeats(shortPlan1)).toBe(7);

    // Distinct from the Long by construction.
    expect(shortPlan1.durationInFrames).not.toBe(longPlan.durationInFrames);
    expect(shortPlan1.totalActualDurationSeconds).not.toBe(longPlan.totalActualDurationSeconds);
    expect(countAudio(shortPlan1)).not.toBe(countAudio(longPlan));
  });

  it('is structurally renderable under the reused Phase 6B contract', () => {
    expect(validatePlanForRender(shortPlan1, {})).toEqual([]);
  });
});

/* ================================================================== */
/*  §8 / §16 — long + short target set                                 */
/* ================================================================== */

describe('Phase 6C §16 — long + short_1 delivery target set', () => {
  const build = () =>
    buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: shortPlan1 },
      mediaMapByTarget: {
        long: { [LONG_ASSET_REF]: 'http://127.0.0.1/x/chart.png' },
        short_1: { 'short-only-ref': 'http://127.0.0.1/x/short.png' },
      },
    });

  it('is valid and ordered long -> short_1', () => {
    const set = build();
    expect(set.valid).toBe(true);
    expect(set.findings).toEqual([]);
    expect(set.targets.map((t) => t.targetId)).toEqual(['long', 'short_1']);
    expect(set.summary.deliveredTargetIds).toEqual(['long', 'short_1']);
    expect(set.long?.targetId).toBe('long');
    expect(set.shorts.map((s) => s.targetId)).toEqual(['short_1']);
  });

  it('keeps one shared projectId while preserving each target scenarioId', () => {
    const set = build();
    expect(set.summary.projectId).toBe(CANONICAL_PROJECT_ID);
    expect(set.long!.scenarioId).toBe(LONG_SCENARIO_ID);
    expect(set.long!.projectId).toBe(CANONICAL_PROJECT_ID);
    expect(set.shorts[0]!.scenarioId).toBe(SHORT_SCENARIO_ID);
    expect(set.shorts[0]!.projectId).toBe(CANONICAL_PROJECT_ID);
    // Different scenarioIds in one set are explicitly allowed (§9).
    expect(set.long!.scenarioId).not.toBe(set.shorts[0]!.scenarioId);
  });

  it('keeps dimensions and format independent per target', () => {
    const set = build();
    expect([set.long!.format, set.long!.width, set.long!.height, set.long!.fps]).toEqual(['Long', 1920, 1080, 30]);
    expect([set.shorts[0]!.format, set.shorts[0]!.width, set.shorts[0]!.height, set.shorts[0]!.fps]).toEqual([
      'Short',
      1080,
      1920,
      30,
    ]);
  });

  it('keeps timing plan-owned: each target reports its own authoritative seconds and frames', () => {
    const set = build();
    expect(set.long!.authoritativeDurationSeconds).toBe(118.74);
    expect(set.long!.durationInFrames).toBe(3563);
    expect(set.shorts[0]!.authoritativeDurationSeconds).toBe(48.99);
    expect(set.shorts[0]!.durationInFrames).toBe(1470);
  });

  it('reports per-target canonical audio, caption and asset counts from its own plan', () => {
    const set = build();
    expect([set.long!.canonicalAudioRefCount, set.long!.captionCueCount, set.long!.assetRefCount]).toEqual([12, 28, 2]);
    expect([
      set.shorts[0]!.canonicalAudioRefCount,
      set.shorts[0]!.captionCueCount,
      set.shorts[0]!.assetRefCount,
    ]).toEqual([7, 15, 0]);
  });

  it('keeps the two plans as independent objects', () => {
    const set = build();
    expect(set.long!.plan).not.toBe(longPlan);
    expect(set.shorts[0]!.plan).not.toBe(shortPlan1);
    expect(set.long!.plan).not.toBe(set.shorts[0]!.plan);
  });
});

/* ================================================================== */
/*  §17 — multiple short targets                                       */
/* ================================================================== */

describe('Phase 6C §17 — long + short_1 + short_2 + short_3', () => {
  const build = () =>
    buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_3: shortPlan3, short_1: shortPlan1, short_2: shortPlan2 },
      mediaMapByTarget: {
        long: { [LONG_ASSET_REF]: 'http://127.0.0.1/x/chart.png' },
        short_1: { a: '1' },
        short_3: { c: '3' },
      },
    });

  it('always orders targets long -> short_1 -> short_2 -> short_3 regardless of input key order', () => {
    const set = build();
    expect(set.valid).toBe(true);
    expect(set.targets.map((t) => t.targetId)).toEqual(['long', 'short_1', 'short_2', 'short_3']);
    expect(set.shorts.map((s) => s.targetId)).toEqual(['short_1', 'short_2', 'short_3']);
    expect(set.summary.targetCount).toBe(4);
    expect(set.summary.longCount).toBe(1);
    expect(set.summary.shortCount).toBe(3);
  });

  it('keeps every short independently identified and isolated', () => {
    const set = build();
    const ids = set.shorts.map((s) => s.scenarioId);
    expect(new Set(ids).size).toBe(3);
    expect(set.shorts.every((s) => s.width === 1080 && s.height === 1920 && s.fps === 30)).toBe(true);
    expect(set.shorts.every((s) => s.format === 'Short' && s.projectId === CANONICAL_PROJECT_ID)).toBe(true);
  });

  it('gives a target with no supplied mediaMap an empty map, never another target map', () => {
    const set = build();
    expect(set.targets.find((t) => t.targetId === 'short_2')!.mediaMap).toEqual({});
    expect(set.targets.find((t) => t.targetId === 'short_1')!.mediaMap).toEqual({ a: '1' });
    expect(set.targets.find((t) => t.targetId === 'short_3')!.mediaMap).toEqual({ c: '3' });
  });
});

/* ================================================================== */
/*  §24 — determinism                                                  */
/* ================================================================== */

describe('Phase 6C §24 — deterministic delivery target sets', () => {
  it('produces a structurally identical contract for repeated builds', () => {
    const input = {
      longPlan,
      shortPlans: { short_1: shortPlan1, short_2: shortPlan2 },
      mediaMapByTarget: { long: { [LONG_ASSET_REF]: 'u' }, short_1: { a: '1' } },
    };
    const first = buildProductionDeliveryTargets(input);
    const second = buildProductionDeliveryTargets(input);
    const third = buildProductionDeliveryTargets(structuredClone(input));

    const shape = (s: typeof first) =>
      JSON.stringify({ version: s.version, valid: s.valid, summary: s.summary, findings: s.findings, targets: s.targets });

    expect(shape(second)).toBe(shape(first));
    expect(shape(third)).toBe(shape(first));
  });

  it('emits no timestamps or environment-derived ordering', () => {
    const set = buildProductionDeliveryTargets({ longPlan, shortPlans: { short_1: shortPlan1 } });
    const json = JSON.stringify(set.summary);
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(set.version).toBe('1.0.0');
  });
});

/* ================================================================== */
/*  §6 — immutability and isolation                                    */
/* ================================================================== */

describe('Phase 6C §6 — no shared mutable authority', () => {
  it('never mutates or freezes the caller Long plan', () => {
    const input = structuredClone(longPlan);
    const set = buildProductionDeliveryTargets({ longPlan: input });
    expect(Object.isFrozen(input)).toBe(false);
    expect(input.width).toBe(1920);
    expect(input.height).toBe(1080);
    expect(input).toEqual(longPlan);
    // The target owns a deep-frozen copy instead.
    expect(Object.isFrozen(set.long!.plan)).toBe(true);
    expect(Object.isFrozen(set.long!.plan.scenes[0])).toBe(true);
  });

  it('never mutates or freezes the caller Short plan', () => {
    const input = structuredClone(shortPlan1);
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: input },
    });
    expect(Object.isFrozen(input)).toBe(false);
    expect(input).toEqual(shortPlan1);
    expect(Object.isFrozen(set.shorts[0]!.plan)).toBe(true);
  });

  it('rejects mutation attempts on a delivered target plan', () => {
    const set = buildProductionDeliveryTargets({ longPlan, shortPlans: { short_1: shortPlan1 } });
    expect(() => {
      (set.long!.plan as unknown as { width: number }).width = 999;
    }).toThrow();
    expect(set.long!.plan.width).toBe(1920);
    expect(longPlan.width).toBe(1920);

    expect(() => {
      (set.shorts[0]!.plan as unknown as { height: number }).height = 999;
    }).toThrow();
    expect(set.shorts[0]!.plan.height).toBe(1920);
    expect(shortPlan1.height).toBe(1920);
  });

  it('rejects mutation attempts on a delivered target mediaMap', () => {
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: shortPlan1 },
      mediaMapByTarget: { long: { [LONG_ASSET_REF]: 'u' }, short_1: { a: '1' } },
    });
    expect(() => {
      set.long!.mediaMap.injected = 'x';
    }).toThrow();
    expect(set.long!.mediaMap).toEqual({ [LONG_ASSET_REF]: 'u' });
    expect(set.shorts[0]!.mediaMap).toEqual({ a: '1' });
  });

  it('isolates a failure in short_2 from long, short_1 and short_3', () => {
    const brokenShort = { ...shortPlan2, width: 1920, height: 1080 } as RemotionCompositionPlan;
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: shortPlan1, short_2: brokenShort, short_3: shortPlan3 },
      mediaMapByTarget: { long: { [LONG_ASSET_REF]: 'u' } },
    });

    expect(set.valid).toBe(false);
    expect(set.targets.map((t) => t.targetId)).toEqual(['long', 'short_1', 'short_3']);
    expect(set.summary.errorCount).toBe(1);

    const short2Errors = set.findings.filter((f) => f.targetId === 'short_2' && f.severity === 'error');
    expect(short2Errors.map((f) => f.code)).toContain('DELIVERY_TARGET_DIMENSIONS_MISMATCH');

    // The surviving targets are untouched by short_2's failure.
    expect(set.long!.width).toBe(1920);
    expect(set.long!.canonicalAudioRefCount).toBe(12);
    expect(set.shorts.map((s) => s.targetId)).toEqual(['short_1', 'short_3']);
    expect(set.shorts.every((s) => s.width === 1080 && s.height === 1920)).toBe(true);
  });
});

/* ================================================================== */
/*  §7 — mediaMap is per target                                        */
/* ================================================================== */

describe('Phase 6C §7 — mediaMap isolation', () => {
  it('never copies the Long mediaMap onto a Short', () => {
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: shortPlan1, short_2: shortPlan2 },
      mediaMapByTarget: {
        long: { [LONG_ASSET_REF]: 'long-url', 'long-only': 'lo' },
        short_1: { 'short-only': 'so' },
      },
    });

    expect(set.long!.mediaMap).toEqual({ [LONG_ASSET_REF]: 'long-url', 'long-only': 'lo' });
    expect(set.targets.find((t) => t.targetId === 'short_1')!.mediaMap).toEqual({ 'short-only': 'so' });
    expect(set.targets.find((t) => t.targetId === 'short_2')!.mediaMap).toEqual({});
    expect(set.targets.find((t) => t.targetId === 'short_1')!.mediaMap[LONG_ASSET_REF]).toBeUndefined();
  });

  it('keeps the Phase 6A contract shape: logicalAssetRef -> render URL', () => {
    const set = buildProductionDeliveryTargets({
      longPlan,
      mediaMapByTarget: { long: { [LONG_ASSET_REF]: 'http://127.0.0.1/x/chart.png' } },
    });
    expect(set.long!.mediaMap[LONG_ASSET_REF]).toBe('http://127.0.0.1/x/chart.png');
    for (const value of Object.values(set.long!.mediaMap)) expect(typeof value).toBe('string');
  });
});

/* ================================================================== */
/*  §20 / §21 — audio and caption isolation                            */
/* ================================================================== */

describe('Phase 6C §20/§21 — canonical audio and caption isolation', () => {
  const set = () =>
    buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: shortPlan1 },
      mediaMapByTarget: { long: { [LONG_ASSET_REF]: 'u' } },
    });

  it('gives each target its own canonical Phase 4 audio refs', () => {
    const s = set();
    const longClips = s.long!.plan.scenes.flatMap((sc) => sc.audioRefs.map((a) => a.clipId));
    const shortClips = s.shorts[0]!.plan.scenes.flatMap((sc) => sc.audioRefs.map((a) => a.clipId));

    expect(longClips.length).toBe(12);
    expect(shortClips.length).toBe(7);
    // No overlap: the Short never reuses Long dialogue audio.
    expect(shortClips.filter((c) => longClips.includes(c))).toEqual([]);
  });

  it('gives each target its own caption timeline', () => {
    const s = set();
    const longCues = s.long!.plan.scenes.flatMap((sc) => sc.captionCues.map((c) => c.text));
    const shortCues = s.shorts[0]!.plan.scenes.flatMap((sc) => sc.captionCues.map((c) => c.text));

    expect(longCues.length).toBe(28);
    expect(shortCues.length).toBe(15);
    expect(shortCues.filter((t) => longCues.includes(t))).toEqual([]);
  });

  it('delivers a Short on its own authority even when the Long target is absent', () => {
    // No Long audio or captions exist for the Short to fall back to, and it
    // still validates with its own 7 clips / 15 cues.
    const s = buildProductionDeliveryTargets({ longPlan: null, shortPlans: { short_1: shortPlan1 } });
    expect(s.long).toBeNull();
    expect(s.shorts[0]!.canonicalAudioRefCount).toBe(7);
    expect(s.shorts[0]!.captionCueCount).toBe(15);
    expect(s.shorts[0]!.scenarioId).toBe(SHORT_SCENARIO_ID);
    expect(errorCodes(s.findings)).toContain('DELIVERY_TARGET_MISSING_PLAN');
  });
});

/* ================================================================== */
/*  §11 — output path policy                                           */
/* ================================================================== */

describe('Phase 6C §11 — caller-owned output paths', () => {
  it('rejects two targets writing the same file', () => {
    const findings = validateDeliveryOutputPaths(['long', 'short_1'], {
      long: '/tmp/delivery/long.mp4',
      short_1: '/tmp/delivery/long.mp4',
    });
    expect(findings.map((f) => f.code)).toContain('DELIVERY_TARGET_DUPLICATE_OUTPUT');
    expect(findings.find((f) => f.code === 'DELIVERY_TARGET_DUPLICATE_OUTPUT')!.targetId).toBe('short_1');
  });

  it('rejects a covered target with no output path', () => {
    const findings = validateDeliveryOutputPaths(['long', 'short_1'], { long: '/tmp/delivery/long.mp4' });
    expect(findings.map((f) => f.code)).toEqual(['DELIVERY_TARGET_OUTPUT_MISSING']);
    expect(findings[0]!.targetId).toBe('short_1');
  });

  it('accepts one distinct path per target', () => {
    expect(
      validateDeliveryOutputPaths(['long', 'short_1', 'short_2'], {
        long: '/tmp/delivery/long.mp4',
        short_1: '/tmp/delivery/short_1.mp4',
        short_2: '/tmp/delivery/short_2.mp4',
      }),
    ).toEqual([]);
  });

  it('lists every covered target in canonical order, including failed ones', () => {
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: shortPlan1, short_2: null },
    });
    expect(coveredDeliveryTargetIds(set)).toEqual(['long', 'short_1', 'short_2']);
  });
});

/* ================================================================== */
/*  §25 — required negative tests                                      */
/* ================================================================== */

describe('Phase 6C §25 — negative delivery-target contract', () => {
  const longMap = { [LONG_ASSET_REF]: 'u' };

  it('1. rejects a missing Long plan', () => {
    const set = buildProductionDeliveryTargets({ longPlan: null, mediaMapByTarget: { long: longMap } });
    expect(set.valid).toBe(false);
    expect(set.long).toBeNull();
    expect(errorCodes(set.findings)).toContain('DELIVERY_TARGET_MISSING_PLAN');
    expect(set.findings.find((f) => f.code === 'DELIVERY_TARGET_MISSING_PLAN')!.targetId).toBe('long');
  });

  it('2. rejects a Long plan marked invalid', () => {
    const invalid = { ...longPlan, valid: false } as RemotionCompositionPlan;
    const set = buildProductionDeliveryTargets({ longPlan: invalid, mediaMapByTarget: { long: longMap } });
    expect(set.long).toBeNull();
    expect(errorCodes(set.findings)).toContain('DELIVERY_TARGET_INVALID_PLAN');
  });

  it('3. rejects a Long target carrying a Short targetFormat', () => {
    const wrong = { ...longPlan, targetFormat: 'Short' } as unknown as RemotionCompositionPlan;
    const set = buildProductionDeliveryTargets({ longPlan: wrong, mediaMapByTarget: { long: longMap } });
    expect(set.long).toBeNull();
    expect(errorCodes(set.findings)).toContain('DELIVERY_TARGET_FORMAT_MISMATCH');
  });

  it('4. rejects a Long target with the wrong dimensions', () => {
    const wrong = { ...longPlan, width: 1080, height: 1920 } as RemotionCompositionPlan;
    const set = buildProductionDeliveryTargets({ longPlan: wrong, mediaMapByTarget: { long: longMap } });
    expect(set.long).toBeNull();
    expect(errorCodes(set.findings)).toContain('DELIVERY_TARGET_DIMENSIONS_MISMATCH');
  });

  it('5. rejects a Long target with the wrong fps', () => {
    const wrong = { ...longPlan, fps: 24 } as RemotionCompositionPlan;
    const set = buildProductionDeliveryTargets({ longPlan: wrong, mediaMapByTarget: { long: longMap } });
    expect(set.long).toBeNull();
    expect(errorCodes(set.findings)).toContain('DELIVERY_TARGET_FPS_MISMATCH');
  });

  it('6. rejects a Short target carrying a Long targetFormat', () => {
    const wrong = { ...shortPlan1, targetFormat: 'Long' } as unknown as RemotionCompositionPlan;
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: wrong },
      mediaMapByTarget: { long: longMap },
    });
    expect(set.shorts).toEqual([]);
    expect(errorCodes(set.findings)).toContain('DELIVERY_TARGET_FORMAT_MISMATCH');
  });

  it('7. rejects a Short target with the wrong dimensions', () => {
    const wrong = { ...shortPlan1, width: 1920, height: 1080 } as RemotionCompositionPlan;
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: wrong },
      mediaMapByTarget: { long: longMap },
    });
    expect(set.shorts).toEqual([]);
    expect(errorCodes(set.findings)).toContain('DELIVERY_TARGET_DIMENSIONS_MISMATCH');
  });

  it('8. rejects a Short target with the wrong fps', () => {
    const wrong = { ...shortPlan1, fps: 60 } as RemotionCompositionPlan;
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: wrong },
      mediaMapByTarget: { long: longMap },
    });
    expect(set.shorts).toEqual([]);
    expect(errorCodes(set.findings)).toContain('DELIVERY_TARGET_FPS_MISMATCH');
  });

  it('9. rejects a target from a different projectId without rewriting identity', () => {
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: foreignShortPlan },
      mediaMapByTarget: { long: longMap },
    });
    expect(set.valid).toBe(false);
    expect(set.shorts).toEqual([]);
    expect(set.targets.map((t) => t.targetId)).toEqual(['long']);
    const mismatch = set.findings.find((f) => f.code === 'DELIVERY_TARGET_PROJECT_MISMATCH')!;
    expect(mismatch.targetId).toBe('short_1');
    // The Long keeps its own identity; nothing was rewritten.
    expect(set.long!.projectId).toBe(CANONICAL_PROJECT_ID);
  });

  it('10. rejects a requested Short that has no plan', () => {
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: null },
      mediaMapByTarget: { long: longMap },
    });
    expect(set.valid).toBe(false);
    const missing = set.findings.find((f) => f.code === 'DELIVERY_TARGET_MISSING_PLAN')!;
    expect(missing.targetId).toBe('short_1');
    expect(missing.message).toMatch(/does not infer, crop or generate/i);
  });

  it('11. rejects duplicate target output paths', () => {
    const findings = validateDeliveryOutputPaths(['long', 'short_1', 'short_2'], {
      long: '/out/long.mp4',
      short_1: '/out/shared.mp4',
      short_2: '/out/shared.mp4',
    });
    expect(findings.map((f) => f.code)).toEqual(['DELIVERY_TARGET_DUPLICATE_OUTPUT']);
    expect(findings[0]!.targetId).toBe('short_2');
  });

  it('12. rejects a missing output path for a requested target', () => {
    const findings = validateDeliveryOutputPaths(['long', 'short_1'], {
      long: '/out/long.mp4',
      short_1: '   ',
    });
    expect(findings.map((f) => f.code)).toEqual(['DELIVERY_TARGET_OUTPUT_MISSING']);
  });

  it('13. isolates an invalid Short plan from a valid Long target', () => {
    const broken = { ...shortPlan1, width: 1920, height: 1080 } as RemotionCompositionPlan;
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: broken },
      mediaMapByTarget: { long: longMap },
    });
    expect(set.long).not.toBeNull();
    expect(set.long!.width).toBe(1920);
    expect(set.long!.durationInFrames).toBe(3563);
    expect(set.long!.canonicalAudioRefCount).toBe(12);
    expect(set.shorts).toEqual([]);
    expect(set.valid).toBe(false);
  });

  it('14. keeps mediaMaps isolated between targets', () => {
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: shortPlan1, short_2: shortPlan2 },
      mediaMapByTarget: { long: longMap, short_1: { onlyShort1: 'v1' } },
    });
    const short1 = set.targets.find((t) => t.targetId === 'short_1')!;
    const short2 = set.targets.find((t) => t.targetId === 'short_2')!;
    expect(short1.mediaMap).toEqual({ onlyShort1: 'v1' });
    expect(short2.mediaMap).toEqual({});
    expect(Object.keys(short1.mediaMap)).not.toContain(LONG_ASSET_REF);
  });

  it('15. does not mutate the Long plan', () => {
    const input = structuredClone(longPlan);
    const snapshot = JSON.stringify(input);
    buildProductionDeliveryTargets({ longPlan: input, shortPlans: { short_1: shortPlan1 } });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input).toEqual(longPlan);
  });

  it('16. does not mutate the Short plan', () => {
    const input = structuredClone(shortPlan1);
    const snapshot = JSON.stringify(input);
    buildProductionDeliveryTargets({ longPlan, shortPlans: { short_1: input } });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input).toEqual(shortPlan1);
  });

  it('17. is deterministic across repeated builds', () => {
    const input = {
      longPlan,
      shortPlans: { short_1: shortPlan1, short_2: shortPlan2, short_3: shortPlan3 },
      mediaMapByTarget: { long: longMap, short_2: { k: 'v' } },
    };
    const a = buildProductionDeliveryTargets(input);
    const b = buildProductionDeliveryTargets(input);
    expect(JSON.stringify(b.summary)).toBe(JSON.stringify(a.summary));
    expect(JSON.stringify(b.findings)).toBe(JSON.stringify(a.findings));
    expect(b.targets.map((t) => t.targetId)).toEqual(a.targets.map((t) => t.targetId));
    expect(JSON.stringify(b.targets)).toBe(JSON.stringify(a.targets));
  });

  it('18. always orders long -> short_1 -> short_2 -> short_3', () => {
    // Deliberately supplied in reverse order.
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_3: shortPlan3, short_2: shortPlan2, short_1: shortPlan1 },
      mediaMapByTarget: { long: longMap },
    });
    expect(set.targets.map((t) => t.targetId)).toEqual(['long', 'short_1', 'short_2', 'short_3']);
    expect(set.summary.deliveredTargetIds).toEqual(['long', 'short_1', 'short_2', 'short_3']);
  });

  it('19. rejects legacy Scene[] / TargetMedia payloads as plan authority', () => {
    // A legacy storyboard Scene[] is not a RemotionCompositionPlan.
    const legacyScenes = longPlan.scenes.map((s) => ({ sceneId: s.sceneId, narration: 'legacy' }));
    const fromArray = buildProductionDeliveryTargets({
      longPlan: legacyScenes as unknown as RemotionCompositionPlan,
    });
    expect(fromArray.long).toBeNull();
    expect(errorCodes(fromArray.findings)).toContain('DELIVERY_TARGET_INVALID_PLAN');
    expect(fromArray.findings[0]!.message).toMatch(/legacy Scene\[\]/);

    // A legacy TargetMedia payload is not a plan authority either.
    const legacyTargetMedia = {
      targetId: 'long',
      format: '16:9',
      scenes: legacyScenes,
      captions: [],
      audioFile: 'voiceover.wav',
      audioDurationSec: 118,
      durationSec: 118,
      narration: 'legacy narration',
    };
    const fromTargetMedia = buildProductionDeliveryTargets({
      longPlan: legacyTargetMedia as unknown as RemotionCompositionPlan,
    });
    expect(fromTargetMedia.long).toBeNull();
    expect(errorCodes(fromTargetMedia.findings)).toContain('DELIVERY_TARGET_INVALID_PLAN');
  });

  it('20. never falls back to Long audio or captions for a Short', () => {
    const set = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_1: shortPlan1 },
      mediaMapByTarget: { long: longMap },
    });
    const longClips = set.long!.plan.scenes.flatMap((s) => s.audioRefs.map((a) => a.clipId));
    const longCueTexts = set.long!.plan.scenes.flatMap((s) => s.captionCues.map((c) => c.text));
    const shortClips = set.shorts[0]!.plan.scenes.flatMap((s) => s.audioRefs.map((a) => a.clipId));
    const shortCueTexts = set.shorts[0]!.plan.scenes.flatMap((s) => s.captionCues.map((c) => c.text));

    expect(shortClips.length).toBe(7);
    expect(shortCueTexts.length).toBe(15);
    // No Long clip or cue leaked into the Short, and its mediaMap was never
    // populated from the Long map.
    expect(shortClips.filter((c) => longClips.includes(c))).toEqual([]);
    expect(shortCueTexts.filter((t) => longCueTexts.includes(t))).toEqual([]);
    expect(set.shorts[0]!.mediaMap).toEqual({});
    expect(set.shorts[0]!.canonicalAudioRefCount).toBe(7);
  });

  it('omits Short targets that were never requested instead of erroring', () => {
    const set = buildProductionDeliveryTargets({ longPlan, mediaMapByTarget: { long: longMap } });
    expect(set.valid).toBe(true);
    expect(set.shorts).toEqual([]);
    expect(set.summary.requestedTargetIds).toEqual(['long']);
    expect(set.findings).toEqual([]);

    const onlyShort3 = buildProductionDeliveryTargets({
      longPlan,
      shortPlans: { short_3: shortPlan3 },
      mediaMapByTarget: { long: longMap },
    });
    expect(onlyShort3.valid).toBe(true);
    expect(onlyShort3.targets.map((t) => t.targetId)).toEqual(['long', 'short_3']);
  });
});
