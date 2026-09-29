/**
 * Phase 5C — Remotion Composition Integration Test
 *
 * Proves:
 * Scenario → Phase 4 DialogueProductionResult → Phase 5A VisualProductionPlan → Phase 5B SceneRenderPlan → Phase 5C Remotion composition/render tree
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getProgressMeetingScenario,
  compileScenarioVisualPlan,
  REMOTION_FPS,
  deterministicSecondsToFrame,
  resolveRendererKey,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';
import fs from 'node:fs';

describe('Phase 5C — Render Tree Integration', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = `tmp-test-phase5c-integration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('Scenario → Dialogue → Visual → SceneRender → Remotion composition', async () => {
    const scenario = getProgressMeetingScenario();
    expect(scenario.scenes.length).toBe(5);

    const visualRes = compileScenarioVisualPlan(scenario);
    expect(visualRes.ok).toBe(true);
    if (!visualRes.ok) return;

    const dialogueRes = await buildDialogueProductionPlan(scenario, {
      synthesisBasePath: `${tmpRoot}/audio/dialogue`,
      canonicalBasePath: `${tmpRoot}/audio/canonical`,
    });
    expect(dialogueRes.success).toBe(true);
    if (!dialogueRes.success) return;

    const visualProdRes = buildVisualProductionPlan({
      scenario,
      visualPlan: visualRes.plan,
      dialogueResult: dialogueRes.result,
    });
    expect(visualProdRes.success).toBe(true);
    if (!visualProdRes.success) return;

    const sceneRenderRes = buildSceneRenderPlan({
      scenario,
      visualProductionPlan: visualProdRes.plan,
    });
    expect(sceneRenderRes.success).toBe(true);
    if (!sceneRenderRes.success) return;

    const remotionRes = buildRemotionCompositionProps(sceneRenderRes.plan);
    expect(remotionRes.success).toBe(true);
    if (!remotionRes.success) return;

    const plan = remotionRes.plan;

    expect(plan.scenes.length).toBe(5);
    expect(plan.scenes.map(s => s.sourceSceneId)).toEqual(scenario.scenes.map(s => s.id));

    for (const scene of plan.scenes) {
      const resolved = resolveRendererKey(scene.rendererKey);
      expect(resolved.valid).toBe(true);
    }
    console.log(`Renderer keys: ${plan.scenes.map(s => s.rendererKey).join(', ')}`);

    const plan2 = buildRemotionCompositionProps(sceneRenderRes.plan);
    expect(plan2.success).toBe(true);
    if (!plan2.success) return;
    expect(plan.scenes.map(s => [s.startFrame, s.endFrame, s.durationInFrames])).toEqual(
      plan2.plan.scenes.map(s => [s.startFrame, s.endFrame, s.durationInFrames])
    );

    expect(plan.totalActualDurationSeconds).toBeCloseTo(118.74, 1);
    expect(plan.totalActualDurationSeconds).toBe(118.74);
    expect(plan.fps).toBe(30);
    expect(plan.durationInFrames).toBe(Math.ceil(plan.totalActualDurationSeconds * 30));
    expect(plan.durationInFrames).toBe(3563);
    expect(plan.durationInFrames / plan.fps).toBeGreaterThanOrEqual(plan.totalActualDurationSeconds);
    console.log(`Total actual: ${plan.totalActualDurationSeconds}s, fps: ${plan.fps}, total frames: ${plan.durationInFrames} (ceil)`);

    const frameRanges = plan.scenes.map(s => `[${s.startFrame},${s.endFrame}) ${s.durationInFrames}f ${s.actualStartSeconds.toFixed(2)}-${s.actualEndSeconds.toFixed(2)}s`);
    console.log(`Scene frame ranges: ${frameRanges.join(' | ')}`);

    const sumFrames = plan.scenes.reduce((sum, s) => sum + s.durationInFrames, 0);
    expect(sumFrames).toBe(plan.durationInFrames);

    expect(plan.summary.audioRefCount).toBeGreaterThan(0);
    expect(plan.scenes.flatMap(s => s.audioRefs).length).toBe(plan.summary.audioRefCount);
    for (const scene of plan.scenes) {
      for (const audio of scene.audioRefs) {
        expect(audio.canonicalPath).toContain('audio/canonical');
      }
    }
    console.log(`Audio refs: ${plan.summary.audioRefCount}`);

    expect(plan.summary.captionCueCount).toBeGreaterThan(0);
    console.log(`Caption cues: ${plan.summary.captionCueCount}`);

    expect(plan.summary.assetRefCount).toBeGreaterThanOrEqual(0);
    console.log(`Asset refs: ${plan.summary.assetRefCount}`);

    expect(plan.scenes.every(s => s.transition)).toBe(true);
    console.log(`Transitions: ${plan.scenes.length}`);

    for (const scene of plan.scenes) {
      expect(scene.startFrame).toBe(deterministicSecondsToFrame(scene.actualStartSeconds, REMOTION_FPS));
      if (scene.sceneIndex < plan.scenes.length - 1) {
        expect(scene.endFrame).toBe(deterministicSecondsToFrame(scene.actualEndSeconds, REMOTION_FPS));
      } else {
        expect(scene.endFrame).toBe(plan.durationInFrames);
        expect(scene.endFrame).toBe(3563);
      }
      expect(scene.actualStartSeconds).toBe(sceneRenderRes.plan.scenes[scene.sceneIndex].actualStartSeconds);
      expect(scene.actualEndSeconds).toBe(sceneRenderRes.plan.scenes[scene.sceneIndex].actualEndSeconds);
    }

    expect(plan.valid).toBe(true);
  });
});
