/**
 * RETRY-12 defect 2 — a Short-only production export must not report Long as
 * a render failure.
 *
 * The API target subset is the request boundary: `target subset requested:
 * short_1` means ONLY short_1 is built, validated and rendered. Phase 6C
 * core still records the intentional `DELIVERY_TARGET_MISSING_PLAN
 * targetId=long` finding (a short-only set genuinely has no Long plan), and
 * `runPlanBasedProductionExport` already filters that finding from its
 * blocking pre-check. But the renderer derives its coverage from
 * `coveredDeliveryTargetIds(targetSet)`, which also includes targets named by
 * findings — so passing the ORIGINAL set made the ignored Long finding come
 * back as a per-target render FAILURE (`failedTargetIds: ["long", "short_1"]`)
 * and blocked status "ok" forever.
 *
 * The fix is localized to the product/orchestration boundary
 * (`runPlanBasedProductionExport`): the renderer receives the narrowed set,
 * while the returned/recorded target set keeps the finding.
 *
 * These gates prove, with the render boundary stubbed (no browser, no audio,
 * no full encode):
 *   - short_1-only  -> covered ["short_1"], no long failure, no
 *                      DELIVERY_TARGET_MISSING_PLAN for long anywhere in the
 *                      render result, and a successful short_1 yields status
 *                      "ok";
 *   - no hidden Long is generated or substituted (the renderer is invoked
 *     exactly once, for short_1's plan);
 *   - Long-only, Long+Short and multiple Shorts keep their coverage;
 *   - per-target failure isolation survives in the Short-only case;
 *   - the Phase 6C negative contract stays intact when Long IS required
 *     (blocking findings still throw) and for direct
 *     `renderProductionDeliveryTargets` callers (a set carrying a Long failure
 *     still reports it as a structured per-target failure).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RemotionCompositionPlan } from '@buildtrack/core';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-short-only-cover-'));
  return { dir: dir as string };
});

/** Scenario ids whose stubbed render FAILS (per-target isolation checks). */
const FAILING_SCENARIO = vi.hoisted(() => new Set<string>());
const renderCalls = vi.hoisted((): Array<{ outputFile: string; scenarioId: string }> => []);

/* Stub the Phase 6B render boundary BEFORE any service module is imported:
   plan/target-set/orchestration layers below it all run for real. */
vi.mock('../apps/api/src/services/render.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  return {
    ...actual,
    renderCompositionPlan: async (input: { outputFile: string; plan?: { scenarioId?: string; durationInFrames?: number } }) => {
      const scenarioId = input.plan?.scenarioId ?? '';
      renderCalls.push({ outputFile: input.outputFile, scenarioId });
      if (FAILING_SCENARIO.has(scenarioId)) {
        const err = new Error(`stubbed render failure for ${scenarioId}`) as Error & { code: string };
        err.code = 'PLAN_RENDER_FAILED';
        throw err;
      }
      nodeFs.mkdirSync(nodePath.dirname(input.outputFile), { recursive: true });
      nodeFs.writeFileSync(input.outputFile, Buffer.from(`%MP4-STUB-${scenarioId}`));
      return {
        outputFile: input.outputFile,
        durationInFrames: input.plan?.durationInFrames ?? 1,
        renderedFrameCount: input.plan?.durationInFrames ?? 1,
        policy: 'stub-no-render',
      };
    },
  };
});

import {
  buildFinalTargetSet,
  runPlanBasedProductionExport,
} from '../apps/api/src/services/plan-production.js';
import { renderProductionDeliveryTargets } from '../apps/api/src/services/plan-delivery.js';

/* ------------------------------------------------------------------ */
/*  Stub plans — same shape the Workstream D harness uses, so every     */
/*  Phase 6C per-target validation rule runs for real.                  */
/* ------------------------------------------------------------------ */

function makePlan(opts: {
  scenarioId: string;
  projectId?: string;
  targetFormat: 'Long' | 'Short';
  seconds: number;
}): RemotionCompositionPlan {
  const fps = 30;
  const width = opts.targetFormat === 'Long' ? 1920 : 1080;
  const height = opts.targetFormat === 'Long' ? 1080 : 1920;
  const totalFrames = Math.ceil(opts.seconds * fps);
  const sceneId = 'sc-a';
  return {
    version: '1.0.0',
    scenarioId: opts.scenarioId,
    projectId: opts.projectId ?? 'proj-cover',
    targetFormat: opts.targetFormat,
    fps,
    width,
    height,
    durationInFrames: totalFrames,
    totalActualDurationSeconds: opts.seconds,
    totalEstimatedDurationSeconds: Number((opts.seconds + 3).toFixed(2)),
    scenes: [
      {
        sceneId,
        rendererKey: 'explanation:key_statement',
        startFrame: 0,
        endFrame: totalFrames,
        durationInFrames: totalFrames,
        actualStartSeconds: 0,
        actualEndSeconds: opts.seconds,
        actualDurationSeconds: opts.seconds,
        assetRefs: [],
        audioRefs: [
          {
            clipId: `clip_${sceneId}_t1`,
            canonicalPath: `.production/COVER_TEST/audio/canonical/${sceneId}_t1.wav`,
            actualStartSeconds: 0,
            actualEndSeconds: opts.seconds,
            actualDurationSeconds: opts.seconds,
            durationInFrames: totalFrames,
          },
        ],
        captionCues: [
          {
            id: `cue-${sceneId}-1`,
            sceneId,
            sceneIndex: 0,
            turnId: `${sceneId}-t1`,
            turnIndex: 0,
            globalTurnIndex: 0,
            clipId: `clip_${sceneId}_t1`,
            text: `Reconciled dialogue for ${sceneId}`,
            speakerId: 'char-x',
            voiceSlot: 'voice_en_female_authority',
            startTimeSeconds: 0,
            endTimeSeconds: opts.seconds,
            startFrame: 0,
            endFrame: totalFrames,
            durationInFrames: totalFrames,
            localStartFrame: 0,
            localEndFrame: totalFrames,
            localStartSeconds: 0,
            localEndSeconds: opts.seconds,
          },
        ],
        beats: [],
      },
    ],
  } as unknown as RemotionCompositionPlan;
}

function outputs(...targets: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of targets) out[t] = path.join(tmp.dir, `${t}.mp4`);
  return out;
}

/* ------------------------------------------------------------------ */

beforeAll(() => {
  fs.mkdirSync(tmp.dir, { recursive: true });
});

afterAll(() => {
  try {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('Short-only export — render coverage follows the REQUESTED targets', () => {
  it('short_1-only: covered=["short_1"], status "ok", no Long failure anywhere in the render result', async () => {
    renderCalls.length = 0;
    const shortPlan = makePlan({ scenarioId: 'cover-s1', targetFormat: 'Short', seconds: 8 });
    const result = await runPlanBasedProductionExport({
      longPlan: null,
      shortPlans: { short_1: shortPlan },
      mediaMapByTarget: {},
      outputByTarget: outputs('short_1'),
      quality: 'final',
    });

    const rr = result.renderResult;
    // The requested Short is the ONLY covered target...
    expect(rr.targetCount).toBe(1);
    expect(rr.results.map((r) => r.targetId)).toEqual(['short_1']);
    expect(rr.succeededTargetIds).toEqual(['short_1']);
    // ...and a successful short_1 can now actually reach "ok".
    expect(rr.failedTargetIds).toEqual([]);
    expect(rr.status).toBe('ok');

    // No Long is reported as failed merely because it was not requested...
    expect(rr.failedTargetIds).not.toContain('long');
    expect(rr.results.some((r) => r.targetId === 'long')).toBe(false);
    expect(rr.findings.filter((f) => f.targetId === 'long')).toEqual([]);
    // ...and no DELIVERY_TARGET_MISSING_PLAN for long leaks into the result.
    const anyLongMissingPlan =
      rr.results.some((r) => r.error?.targetId === 'long' && r.error?.code === 'DELIVERY_TARGET_MISSING_PLAN') ||
      rr.findings.some((f) => f.targetId === 'long' && f.code === 'DELIVERY_TARGET_MISSING_PLAN');
    expect(anyLongMissingPlan).toBe(false);

    // No hidden Long was generated or substituted: the renderer ran EXACTLY
    // once, for the requested short_1 plan.
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]).toEqual({ outputFile: outputs('short_1').short_1, scenarioId: 'cover-s1' });
    expect(fs.existsSync(path.join(tmp.dir, 'short_1.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(tmp.dir, 'long.mp4'))).toBe(false);

    // The RETURNED target set still records the intentional finding: the set
    // is not rewritten, only the renderer's coverage is narrowed to the
    // request. (This is the gate the old bug failed in the opposite way.)
    expect(
      result.targetSet.findings.some((f) => f.targetId === 'long' && f.code === 'DELIVERY_TARGET_MISSING_PLAN'),
    ).toBe(true);
  }, 60_000);

  it('long-only still covers ["long"] with status ok', async () => {
    renderCalls.length = 0;
    const longPlan = makePlan({ scenarioId: 'cover-l', targetFormat: 'Long', seconds: 10 });
    const result = await runPlanBasedProductionExport({
      longPlan,
      shortPlans: {},
      mediaMapByTarget: {},
      outputByTarget: outputs('long'),
      quality: 'final',
    });
    expect(result.renderResult.results.map((r) => r.targetId)).toEqual(['long']);
    expect(result.renderResult.succeededTargetIds).toEqual(['long']);
    expect(result.renderResult.failedTargetIds).toEqual([]);
    expect(result.renderResult.status).toBe('ok');
    expect(renderCalls).toHaveLength(1);
  }, 60_000);

  it('long + short_1 covers both and stays independent of the Short-only path', async () => {
    renderCalls.length = 0;
    const longPlan = makePlan({ scenarioId: 'cover-l2', targetFormat: 'Long', seconds: 10 });
    const shortPlan = makePlan({ scenarioId: 'cover-s1b', targetFormat: 'Short', seconds: 8 });
    const result = await runPlanBasedProductionExport({
      longPlan,
      shortPlans: { short_1: shortPlan },
      mediaMapByTarget: {},
      outputByTarget: outputs('long', 'short_1'),
      quality: 'final',
    });
    expect(result.renderResult.results.map((r) => r.targetId)).toEqual(['long', 'short_1']);
    expect(result.renderResult.succeededTargetIds).toEqual(['long', 'short_1']);
    expect(result.renderResult.failedTargetIds).toEqual([]);
    expect(result.renderResult.status).toBe('ok');
    // With a real Long plan there is nothing to narrow: same findings object.
    expect(result.renderResult.findings).toEqual([]);
    expect(renderCalls).toHaveLength(2);
  }, 60_000);

  it('multiple requested Shorts cover ["short_1","short_2"] and never long', async () => {
    renderCalls.length = 0;
    const s1 = makePlan({ scenarioId: 'cover-s1c', targetFormat: 'Short', seconds: 8 });
    const s2 = makePlan({ scenarioId: 'cover-s2c', targetFormat: 'Short', seconds: 6 });
    const result = await runPlanBasedProductionExport({
      longPlan: null,
      shortPlans: { short_1: s1, short_2: s2 },
      mediaMapByTarget: {},
      outputByTarget: outputs('short_1', 'short_2'),
      quality: 'final',
    });
    expect(result.renderResult.results.map((r) => r.targetId)).toEqual(['short_1', 'short_2']);
    expect(result.renderResult.succeededTargetIds).toEqual(['short_1', 'short_2']);
    expect(result.renderResult.failedTargetIds).toEqual([]);
    expect(result.renderResult.status).toBe('ok');
    expect(result.renderResult.results.some((r) => r.targetId === 'long')).toBe(false);
    expect(renderCalls).toHaveLength(2);
  }, 60_000);

  it('per-target failure isolation survives the Short-only path', async () => {
    renderCalls.length = 0;
    FAILING_SCENARIO.add('cover-s1d');
    try {
      const s1 = makePlan({ scenarioId: 'cover-s1d', targetFormat: 'Short', seconds: 8 });
      const s2 = makePlan({ scenarioId: 'cover-s2d', targetFormat: 'Short', seconds: 6 });
      const result = await runPlanBasedProductionExport({
        longPlan: null,
        shortPlans: { short_1: s1, short_2: s2 },
        mediaMapByTarget: {},
        outputByTarget: outputs('short_1', 'short_2'),
        quality: 'final',
      });
      const rr = result.renderResult;
      expect(rr.succeededTargetIds).toEqual(['short_2']);
      expect(rr.failedTargetIds).toEqual(['short_1']);
      expect(rr.status).toBe('partial');
      expect(rr.results.find((r) => r.targetId === 'short_1')?.error?.code).toBe('PLAN_RENDER_FAILED');
      // The failure is per-target; Long stays out of BOTH lists.
      expect(rr.results.some((r) => r.targetId === 'long')).toBe(false);
    } finally {
      FAILING_SCENARIO.delete('cover-s1d');
    }
  }, 60_000);

  it('all Shorts failing still yields status "error" without inventing a Long failure', async () => {
    renderCalls.length = 0;
    FAILING_SCENARIO.add('cover-s1e');
    try {
      const s1 = makePlan({ scenarioId: 'cover-s1e', targetFormat: 'Short', seconds: 8 });
      const result = await runPlanBasedProductionExport({
        longPlan: null,
        shortPlans: { short_1: s1 },
        mediaMapByTarget: {},
        outputByTarget: outputs('short_1'),
        quality: 'final',
      });
      expect(result.renderResult.status).toBe('error');
      expect(result.renderResult.failedTargetIds).toEqual(['short_1']);
      expect(result.renderResult.results.some((r) => r.targetId === 'long')).toBe(false);
    } finally {
      FAILING_SCENARIO.delete('cover-s1e');
    }
  }, 60_000);
});

describe('Phase 6C negative contracts remain unweakened', () => {
  it('a Long plan that IS required but invalid still blocks the export', async () => {
    // hasLong === true: nothing is filtered, so an error-severity Long
    // finding must fail the blocking pre-check exactly as before.
    // A Short-shaped plan handed to the long slot is a format mismatch.
    const wrongFormatLong = makePlan({ scenarioId: 'cover-bad-l', targetFormat: 'Short', seconds: 10 });
    await expect(
      runPlanBasedProductionExport({
        longPlan: wrongFormatLong,
        shortPlans: {},
        mediaMapByTarget: {},
        outputByTarget: outputs('long'),
        quality: 'final',
      }),
    ).rejects.toThrow(/ProductionDeliveryTargetSet invalid/);
  });

  it('a short-only export with NO usable short target still blocks (empty coverage)', async () => {
    await expect(
      runPlanBasedProductionExport({
        longPlan: null,
        shortPlans: {},
        mediaMapByTarget: {},
        outputByTarget: outputs('short_1'),
        quality: 'final',
      }),
    ).rejects.toThrow(/requires at least one target/);
  });

  it('direct renderProductionDeliveryTargets callers keep the failed-target visibility contract', async () => {
    // Bypassing the orchestrator, the raw Short-only set (which legitimately
    // carries the Long MISSING_PLAN finding) must STILL surface Long as a
    // structured per-target failure - Phase 6C's "a failed target never
    // silently disappears" rule is untouched by the localized fix.
    const set = buildFinalTargetSet({
      longPlan: null,
      shortPlans: { short_1: makePlan({ scenarioId: 'cover-direct', targetFormat: 'Short', seconds: 8 }) },
      mediaMapByTarget: {},
    });
    expect(set.findings.some((f) => f.targetId === 'long' && f.code === 'DELIVERY_TARGET_MISSING_PLAN')).toBe(true);

    const rr = await renderProductionDeliveryTargets({
      targetSet: set,
      outputByTarget: outputs('long', 'short_1'),
      quality: 'final',
    });
    const longResult = rr.results.find((r) => r.targetId === 'long');
    expect(longResult).toBeDefined();
    expect(longResult!.success).toBe(false);
    expect(longResult!.error?.code).toBe('DELIVERY_TARGET_MISSING_PLAN');
    expect(rr.failedTargetIds).toContain('long');
    expect(rr.succeededTargetIds).toEqual(['short_1']);
    expect(rr.status).toBe('partial');
  }, 60_000);
});
