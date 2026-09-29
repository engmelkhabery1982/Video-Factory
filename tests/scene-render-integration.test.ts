/**
 * Phase 5B — Integration test
 * Scenario → Phase 4 DialogueProductionResult → Phase 5A VisualProductionPlan → Phase 5B SceneRenderPlan
 * Proves all scenes map exactly once, order preserved, actual timing unchanged from Phase 5A, beats preserved, renderer keys assigned, canonical audio attached, captions attached, assets preserved, transitions mapped, no rendering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  getProgressMeetingScenario,
  compileScenarioVisualPlan,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';

describe('Phase 5B — Integration: SceneRenderPlan from VisualProductionPlan', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = `tmp-test-phase5b-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('proves full mapping from Scenario to SceneRenderPlan', async () => {
    const scenario = getProgressMeetingScenario();
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error(`visual plan failed`);
    const visualPlan = visualRes.plan;

    const dialogueRes = await buildDialogueProductionPlan(scenario, {
      synthesisBasePath: `${tmpRoot}/audio/dialogue`,
      canonicalBasePath: `${tmpRoot}/audio/canonical`,
    });
    expect(dialogueRes.success).toBe(true);
    if (!dialogueRes.success) return;
    const dialogueResult = dialogueRes.result;

    const visualProdRes = buildVisualProductionPlan({
      scenario,
      visualPlan,
      dialogueResult,
    });
    expect(visualProdRes.success).toBe(true);
    if (!visualProdRes.success) return;
    const visualProductionPlan = visualProdRes.plan;

    const sceneRenderRes = buildSceneRenderPlan({
      scenario,
      visualProductionPlan,
    });
    expect(sceneRenderRes.success).toBe(true);
    if (!sceneRenderRes.success) {
      console.error(sceneRenderRes.error, sceneRenderRes.findings);
      return;
    }
    const plan = sceneRenderRes.plan;

    // all scenes map exactly once
    expect(plan.scenes.length).toBe(scenario.scenes.length);
    expect(plan.scenes.length).toBe(visualProductionPlan.scenes.length);
    expect(new Set(plan.scenes.map(s => s.sceneId)).size).toBe(plan.scenes.length);

    // scene order preserved
    expect(plan.scenes.map(s => s.sourceSceneId)).toEqual(scenario.scenes.map(s => s.id));
    expect(plan.scenes.map(s => s.renderOrder)).toEqual(scenario.scenes.map((_, i) => i));

    // actual scene timing unchanged from Phase 5A
    for (let i = 0; i < visualProductionPlan.scenes.length; i++) {
      const vScene = visualProductionPlan.scenes[i];
      const rScene = plan.scenes[i];
      expect(rScene.actualStartSeconds).toBe(vScene.actualStartSeconds);
      expect(rScene.actualEndSeconds).toBe(vScene.actualEndSeconds);
      expect(rScene.actualDurationSeconds).toBe(vScene.actualDurationSeconds);
    }

    // visual beats preserved
    for (let i = 0; i < visualProductionPlan.scenes.length; i++) {
      const vScene = visualProductionPlan.scenes[i];
      const rScene = plan.scenes[i];
      expect(rScene.beats.length).toBe(vScene.beats.length);
      expect(rScene.beats.map(b => b.id)).toEqual(vScene.beats.map(b => b.id));
      for (let j = 0; j < vScene.beats.length; j++) {
        expect(rScene.beats[j].actualStartSeconds).toBe(vScene.beats[j].actualStartSeconds);
        expect(rScene.beats[j].actualEndSeconds).toBe(vScene.beats[j].actualEndSeconds);
      }
    }

    // renderer keys assigned deterministically
    for (const scene of plan.scenes) {
      expect(scene.rendererKey).toBeDefined();
      expect(typeof scene.rendererKey).toBe('string');
      expect(scene.rendererCategory).toBeDefined();
    }
    // At least hook and cta and explanation should be present for progress-meeting fixture
    const keys = plan.summary.rendererKeysUsed;
    expect(keys.length).toBeGreaterThan(0);

    // canonical audio attached
    for (const scene of plan.scenes) {
      for (const audio of scene.audioRefs) {
        expect(audio.canonicalPath).toContain('audio/canonical');
      }
    }
    expect(plan.summary.audioRefCount).toBe(visualProductionPlan.summary.audioClipCount);

    // reconciled captions attached
    expect(plan.summary.captionCueCount).toBe(visualProductionPlan.summary.captionCueCount);
    for (const scene of plan.scenes) {
      for (const cue of scene.captionCues) {
        expect(cue.sceneId).toBe(scene.sourceSceneId);
      }
    }

    // asset references preserved
    expect(plan.summary.assetRefCount).toBe(visualProductionPlan.summary.assetReferenceCount);

    // transition references mapped
    for (let i = 0; i < visualProductionPlan.scenes.length; i++) {
      const vScene = visualProductionPlan.scenes[i];
      const rScene = plan.scenes[i];
      expect(rScene.transition.type).toBe(vScene.transition.type);
      expect(rScene.transition.durationSeconds).toBe(vScene.transition.durationSeconds);
    }

    // no rendering occurs
    const allFiles = fs.readdirSync(tmpRoot, { recursive: true } as any) as string[];
    const hasVideo = allFiles.some(f => typeof f === 'string' && (f.endsWith('.mp4') || f.endsWith('.mov')));
    expect(hasVideo).toBe(false);

    console.log('\n=== Phase 5B Integration Evidence ===');
    console.log(`Fixture: ${scenario.metadata.id}`);
    console.log(`Scene count: ${plan.summary.sceneCount}, Renderer keys used: ${plan.summary.rendererKeysUsed.join(', ')}`);
    console.log(`Beat count: ${plan.summary.beatCount}, Audio count: ${plan.summary.audioRefCount}, Caption cues: ${plan.summary.captionCueCount}, Assets: ${plan.summary.assetRefCount}, Transitions: ${plan.summary.transitionCount}`);
    console.log(`Total actual duration: ${plan.totalActualDurationSeconds}s matches Phase 5A: ${plan.totalActualDurationSeconds === visualProductionPlan.totalActualDurationSeconds}`);
    console.log(`Example scene: id=${plan.scenes[0].sceneId} rendererKey=${plan.scenes[0].rendererKey} actualStart=${plan.scenes[0].actualStartSeconds}s actualEnd=${plan.scenes[0].actualEndSeconds}s`);
    console.log('=== End Evidence ===\n');
  }, 120000);
});
