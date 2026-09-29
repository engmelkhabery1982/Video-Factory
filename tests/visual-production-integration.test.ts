/**
 * Phase 5A — Integration test
 * Scenario → Phase 3 VisualPlan + DialogueProductionResult → VisualProductionPlan
 * Proves actual Phase 4 duration used, all scenes map, beats order, timing adapted, canonical audio attached, captions attached, total matches Phase 4, no rendering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  getProgressMeetingScenario,
  compileScenarioVisualPlan,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';

describe('Phase 5A — Integration: VisualProductionPlan from Phase 4 result', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = `tmp-test-phase5a-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('proves actual Phase 4 duration used and full mapping', async () => {
    const scenario = getProgressMeetingScenario();
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error(`visual plan failed: ${visualRes.errors.map(e => e.ruleId).join(',')}`);
    const visualPlan = visualRes.plan;

    const dialogueResultRes = await buildDialogueProductionPlan(scenario, {
      synthesisBasePath: `${tmpRoot}/audio/dialogue`,
      canonicalBasePath: `${tmpRoot}/audio/canonical`,
    });
    expect(dialogueResultRes.success).toBe(true);
    if (!dialogueResultRes.success) return;
    const dialogueResult = dialogueResultRes.result;

    const visualProdRes = buildVisualProductionPlan({
      scenario,
      visualPlan,
      dialogueResult,
    });

    expect(visualProdRes.success).toBe(true);
    if (!visualProdRes.success) {
      console.error(visualProdRes.error, visualProdRes.findings);
      return;
    }
    const plan = visualProdRes.plan;

    // actual Phase 4 duration is used
    expect(plan.totalActualDurationSeconds).toBe(dialogueResult.reconciledDialogue.actualTotalDurationSeconds);
    expect(plan.totalActualDurationSeconds).toBe(dialogueResult.summary.totalActualDurationSeconds);

    // all scenes map
    expect(plan.scenes.length).toBe(scenario.scenes.length);
    expect(plan.scenes.map(s => s.sourceSceneId)).toEqual(scenario.scenes.map(s => s.id));

    // visual beats remain in correct order
    for (let sIdx = 0; sIdx < visualPlan.scenes.length; sIdx++) {
      const origScene = visualPlan.scenes[sIdx];
      const prodScene = plan.scenes[sIdx];
      expect(prodScene.beats.length).toBe(origScene.beats.length);
      expect(prodScene.beats.map(b => b.id)).toEqual(origScene.beats.map(b => b.id));
      // order preserved
      for (let bIdx = 0; bIdx < prodScene.beats.length; bIdx++) {
        expect(prodScene.beats[bIdx].index).toBe(bIdx);
      }
    }

    // beat timing adapted to actual scene boundaries
    let exampleOldBeatTiming: any = null;
    let exampleNewBeatTiming: any = null;
    for (let sIdx = 0; sIdx < visualPlan.scenes.length; sIdx++) {
      const origScene = visualPlan.scenes[sIdx];
      const prodScene = plan.scenes[sIdx];
      for (let bIdx = 0; bIdx < origScene.beats.length; bIdx++) {
        const origBeat = origScene.beats[bIdx];
        const prodBeat = prodScene.beats[bIdx];
        // relative position preserved
        const origRel = (origBeat.startSeconds - origScene.startSeconds) / origScene.durationSeconds;
        expect(prodBeat.relativeStart).toBeCloseTo(Math.max(0, Math.min(1, origRel)), 1);
        // actual beat inside actual scene
        expect(prodBeat.actualStartSeconds).toBeGreaterThanOrEqual(prodScene.actualStartSeconds - 0.001);
        expect(prodBeat.actualEndSeconds).toBeLessThanOrEqual(prodScene.actualEndSeconds + 0.001);

        if (!exampleOldBeatTiming && origBeat.kind === 'dialogue') {
          exampleOldBeatTiming = {
            beatId: origBeat.id,
            estimatedStart: origBeat.startSeconds,
            estimatedEnd: origBeat.endSeconds,
            sceneEstimatedStart: origScene.startSeconds,
            sceneEstimatedDuration: origScene.durationSeconds,
            relativeStart: origRel,
          };
          exampleNewBeatTiming = {
            beatId: prodBeat.id,
            actualStart: prodBeat.actualStartSeconds,
            actualEnd: prodBeat.actualEndSeconds,
            sceneActualStart: prodScene.actualStartSeconds,
            sceneActualDuration: prodScene.actualDurationSeconds,
            relativeStart: prodBeat.relativeStart,
          };
        }
      }
    }

    // canonical audio references attached
    for (const scene of plan.scenes) {
      for (const audioRef of scene.audioRefs) {
        expect(audioRef.canonicalPath).toContain('audio/canonical');
        expect(audioRef.actualDurationSeconds).toBeGreaterThan(0);
      }
      // every dialogue beat has audioRef
      for (const beat of scene.beats) {
        if (beat.kind === 'dialogue') {
          expect(beat.audioRef).not.toBeNull();
        }
      }
    }

    // reconciled captions attached
    for (const scene of plan.scenes) {
      for (const cue of scene.captionCues) {
        expect(scene.turnIds).toContain(cue.turnId);
      }
    }
    expect(plan.summary.captionCueCount).toBe(dialogueResult.reconciledCaptions.cueCount);

    // total duration matches Phase 4 total actual duration
    expect(plan.totalActualDurationSeconds).toBe(dialogueResult.reconciledDialogue.actualTotalDurationSeconds);
    expect(plan.scenes[plan.scenes.length - 1].actualEndSeconds).toBe(plan.totalActualDurationSeconds);

    // no rendering occurs — check no mp4 files created
    const allFiles = fs.readdirSync(tmpRoot, { recursive: true } as any) as string[];
    const hasVideo = allFiles.some(f => typeof f === 'string' && (f.endsWith('.mp4') || f.endsWith('.mov')));
    expect(hasVideo).toBe(false);

    // Print evidence
    console.log('\n=== Phase 5A Integration Evidence ===');
    console.log(`Fixture: ${scenario.metadata.id}`);
    console.log(`Phase 4 actual duration: ${dialogueResult.reconciledDialogue.actualTotalDurationSeconds}s`);
    console.log(`VisualProductionPlan total actual: ${plan.totalActualDurationSeconds}s`);
    console.log(`Scene count: ${plan.summary.sceneCount}, Beat count: ${plan.summary.visualBeatCount}, Audio count: ${plan.summary.audioClipCount}, Caption cues: ${plan.summary.captionCueCount}, Assets: ${plan.summary.assetReferenceCount}`);
    if (exampleOldBeatTiming) {
      console.log(`Example old beat timing: id=${exampleOldBeatTiming.beatId} estStart=${exampleOldBeatTiming.estimatedStart}s estEnd=${exampleOldBeatTiming.estimatedEnd}s sceneEstStart=${exampleOldBeatTiming.sceneEstimatedStart}s sceneEstDur=${exampleOldBeatTiming.sceneEstimatedDuration}s relStart=${exampleOldBeatTiming.relativeStart}`);
      console.log(`Example adapted actual timing: id=${exampleNewBeatTiming.beatId} actStart=${exampleNewBeatTiming.actualStart}s actEnd=${exampleNewBeatTiming.actualEnd}s sceneActStart=${exampleNewBeatTiming.sceneActualStart}s sceneActDur=${exampleNewBeatTiming.sceneActualDuration}s relStart=${exampleNewBeatTiming.relativeStart}`);
    }
    console.log(`Proof total duration matches Phase 4: ${plan.totalActualDurationSeconds === dialogueResult.reconciledDialogue.actualTotalDurationSeconds}`);
    console.log('=== End Evidence ===\n');
  }, 120000);
});
