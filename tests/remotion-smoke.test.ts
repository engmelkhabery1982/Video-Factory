/**
 * Phase 5C — Controlled Render Smoke Test (lightweight)
 */

import { describe, it, expect } from 'vitest';
import {
  getProgressMeetingScenario,
  compileScenarioVisualPlan,
  resolveRendererKey,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';

describe('Phase 5C — Smoke Render (component resolution)', () => {
  it('composition can be resolved and renderer components exist', async () => {
    const scenario = getProgressMeetingScenario();
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error('visual failed');

    const tmpRoot = `tmp-test-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fs = await import('node:fs');
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpRoot, { recursive: true });

    try {
      const dialogueRes = await buildDialogueProductionPlan(scenario, {
        synthesisBasePath: `${tmpRoot}/audio/dialogue`,
        canonicalBasePath: `${tmpRoot}/audio/canonical`,
      });
      if (!dialogueRes.success) throw new Error(`dialogue failed: ${dialogueRes.error}`);

      const visualProdRes = buildVisualProductionPlan({
        scenario,
        visualPlan: visualRes.plan,
        dialogueResult: dialogueRes.result,
      });
      if (!visualProdRes.success) throw new Error(`visual prod failed: ${visualProdRes.error}`);

      const sceneRenderRes = buildSceneRenderPlan({
        scenario,
        visualProductionPlan: visualProdRes.plan,
      });
      if (!sceneRenderRes.success) throw new Error(`scene render failed: ${sceneRenderRes.error}`);

      const remotionRes = buildRemotionCompositionProps(sceneRenderRes.plan);
      if (!remotionRes.success) throw new Error(`remotion failed: ${remotionRes.error}`);

      const plan = remotionRes.plan;

      expect(plan.scenes.length).toBe(5);
      expect(plan.durationInFrames).toBeGreaterThan(0);
      expect(plan.fps).toBe(30);

      for (const scene of plan.scenes) {
        const resolved = resolveRendererKey(scene.rendererKey);
        expect(resolved.valid).toBe(true);
        expect(resolved.category).toBeDefined();
      }

      for (let i = 0; i < plan.scenes.length; i++) {
        const scene = plan.scenes[i];
        expect(scene.startFrame).toBeGreaterThanOrEqual(0);
        expect(scene.endFrame).toBeGreaterThan(scene.startFrame);
        expect(scene.durationInFrames).toBeGreaterThan(0);
        if (i > 0) {
          expect(scene.startFrame).toBeGreaterThanOrEqual(plan.scenes[i - 1].startFrame);
        }
      }

      expect(plan.summary.beatCount).toBeGreaterThan(0);
      expect(plan.summary.audioRefCount).toBeGreaterThan(0);
      expect(plan.summary.captionCueCount).toBeGreaterThan(0);

      expect(plan.totalActualDurationSeconds).toBe(118.74);
      expect(plan.durationInFrames).toBe(3563);
      expect(plan.durationInFrames / plan.fps).toBeGreaterThanOrEqual(plan.totalActualDurationSeconds);

      const fsCheck = await import('node:fs');
      const videoPlanSource = fsCheck.readFileSync('packages/video/src/compositions/VideoCompositionPlan.tsx', 'utf-8');
      expect(videoPlanSource).not.toContain('volume={0}');
      expect(videoPlanSource).toContain('<Audio src={audio.canonicalPath}');

      console.log(`Smoke: plan valid, ${plan.scenes.length} scenes, ${plan.durationInFrames} frames (ceil 118.74s→3563), rendererKeys: ${plan.scenes.map(s => s.rendererKey).join(', ')}`);
    } finally {
      const fs2 = await import('node:fs');
      if (fs2.existsSync(tmpRoot)) {
        fs2.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  });

  it('PlanSceneRenderer resolver exists', async () => {
    const keys = [
      'hook:question',
      'explanation:key_statement',
      'explanation:number_comparison',
      'explanation:site_footage_callouts',
      'cta:cta_card',
      'generic:generic',
    ];
    for (const key of keys) {
      const resolved = resolveRendererKey(key);
      expect(resolved.valid).toBe(true);
    }
    const bad = resolveRendererKey('unknown:foobar');
    expect(bad.valid).toBe(false);
  });
});
