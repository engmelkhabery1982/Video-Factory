/**
 * Phase 5C — Remotion Composition Wiring Unit Tests
 *
 * Covers:
 * - valid SceneRenderPlan → composition props mapping
 * - time-to-frame conversion
 * - no cumulative frame drift
 * - correct total composition duration
 * - rendererKey → component mapping
 * - exact scene order
 * - beat local/global timing mapping
 * - asset binding
 * - canonical audio binding
 * - caption binding
 * - transition binding
 * - unknown renderer key failure
 * - invalid frame range failure
 * - deterministic repeated output
 */

import { describe, it, expect } from 'vitest';
import {
  getProgressMeetingScenario,
  compileScenarioVisualPlan,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import {
  buildRemotionCompositionProps,
  deterministicSecondsToFrame,
  deterministicDurationToFrames,
  resolveRendererKey,
  validateRemotionCompositionPlan,
} from '../packages/core/src/scenario/remotion-composition-pipeline.js';
import { REMOTION_FPS } from '../packages/core/src/scenario/remotion-composition-types.js';

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

describe('Phase 5C — Remotion Composition', () => {
  let cached: any = null;

  async function getValid() {
    if (cached) return cached;
    const scenario = getProgressMeetingScenario();
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error('visual failed');
    const tmpRoot = `tmp-test-phase5c-unit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fs = await import('node:fs');
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpRoot, { recursive: true });
    try {
      const dialogueRes = await buildDialogueProductionPlan(scenario, {
        synthesisBasePath: `${tmpRoot}/audio/dialogue`,
        canonicalBasePath: `${tmpRoot}/audio/canonical`,
      });
      if (!dialogueRes.success) throw new Error(`dialogue production failed: ${dialogueRes.error}`);
      const visualProdRes = buildVisualProductionPlan({
        scenario,
        visualPlan: visualRes.plan,
        dialogueResult: dialogueRes.result,
      });
      if (!visualProdRes.success) throw new Error(`visual production failed: ${visualProdRes.error}`);
      const sceneRenderRes = buildSceneRenderPlan({
        scenario,
        visualProductionPlan: visualProdRes.plan,
      });
      if (!sceneRenderRes.success) throw new Error(`scene render failed: ${sceneRenderRes.error}`);

      const remotionRes = buildRemotionCompositionProps(sceneRenderRes.plan);
      if (!remotionRes.success) throw new Error(`remotion composition failed: ${remotionRes.error}`);

      cached = {
        scenario,
        visualPlan: visualRes.plan,
        dialogueResult: dialogueRes.result,
        visualProductionPlan: visualProdRes.plan,
        sceneRenderPlan: sceneRenderRes.plan,
        remotionPlan: remotionRes.plan,
      };
      return cached;
    } finally {
      const fs2 = await import('node:fs');
      if (fs2.existsSync(tmpRoot)) {
        fs2.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  }

  it('1. valid SceneRenderPlan → composition props mapping', async () => {
    const { sceneRenderPlan } = await getValid();
    const res = buildRemotionCompositionProps(sceneRenderPlan);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.plan.scenes.length).toBe(sceneRenderPlan.scenes.length);
    expect(res.plan.scenarioId).toBe(sceneRenderPlan.scenarioId);
    expect(res.plan.valid).toBe(true);
  });

  it('2. time-to-frame conversion deterministic', async () => {
    expect(deterministicSecondsToFrame(0, 30)).toBe(0);
    expect(deterministicSecondsToFrame(1, 30)).toBe(30);
    expect(deterministicSecondsToFrame(118.74, 30)).toBe(Math.round(118.74 * 30));
    expect(deterministicSecondsToFrame(118.74, 30)).toBe(3562);
    expect(deterministicDurationToFrames(0.5, 30)).toBe(15);
    // Same input → same output
    expect(deterministicSecondsToFrame(23.67, 30)).toBe(deterministicSecondsToFrame(23.67, 30));
  });

  it('3. no cumulative frame drift', async () => {
    const { remotionPlan } = await getValid();
    // Boundaries derived from absolute times, not summed durations
    // Check that sum of durationInFrames equals totalDurationInFrames
    const sum = remotionPlan.scenes.reduce((s: number, sc: any) => s + sc.durationInFrames, 0);
    expect(sum).toBe(remotionPlan.durationInFrames);
    // Check monotonic and adjacent boundaries deterministic
    for (let i = 1; i < remotionPlan.scenes.length; i++) {
      const prev = remotionPlan.scenes[i - 1];
      const curr = remotionPlan.scenes[i];
      // If actual timing contiguous, frames should be contiguous
      const timeGap = curr.actualStartSeconds - prev.actualEndSeconds;
      if (timeGap <= 0.001) {
        expect(curr.startFrame).toBe(prev.endFrame);
      }
      expect(curr.startFrame).toBeGreaterThanOrEqual(prev.startFrame);
      expect(curr.endFrame).toBeGreaterThan(curr.startFrame);
    }
  });

  it('4. correct total composition duration', async () => {
    const { sceneRenderPlan, remotionPlan } = await getValid();
    const expectedFrames = Math.round(sceneRenderPlan.totalActualDurationSeconds * REMOTION_FPS);
    expect(remotionPlan.durationInFrames).toBe(expectedFrames);
    expect(remotionPlan.totalActualDurationSeconds).toBe(sceneRenderPlan.totalActualDurationSeconds);
    // 118.74s * 30 = 3562.2 → 3562
    expect(remotionPlan.totalActualDurationSeconds).toBeCloseTo(118.74, 1);
    expect(remotionPlan.durationInFrames).toBe(3562);
  });

  it('5. rendererKey → component mapping deterministic', async () => {
    const { remotionPlan } = await getValid();
    for (const scene of remotionPlan.scenes) {
      const resolved = resolveRendererKey(scene.rendererKey);
      expect(resolved.valid).toBe(true);
      expect(resolved.category).toBeDefined();
    }
    // Check known keys from fixture
    const keys = remotionPlan.scenes.map((s: any) => s.rendererKey).sort();
    expect(keys.length).toBe(5);
    // Should contain expected keys
    expect(keys).toContain('cta:cta_card');
  });

  it('6. exact scene order preserved', async () => {
    const { scenario, remotionPlan } = await getValid();
    expect(remotionPlan.scenes.map((s: any) => s.sourceSceneId)).toEqual(scenario.scenes.map((s: any) => s.id));
    for (let i = 0; i < remotionPlan.scenes.length; i++) {
      expect(remotionPlan.scenes[i].renderOrder).toBe(i);
      expect(remotionPlan.scenes[i].sceneIndex).toBe(i);
    }
  });

  it('7. beat local/global timing mapping', async () => {
    const { remotionPlan } = await getValid();
    for (const scene of remotionPlan.scenes) {
      for (const beat of scene.beats) {
        // Global timing based on absolute
        expect(beat.startFrame).toBe(deterministicSecondsToFrame(beat.actualStartSeconds, REMOTION_FPS));
        expect(beat.endFrame).toBe(deterministicSecondsToFrame(beat.actualEndSeconds, REMOTION_FPS));
        // Local = global - scene start
        expect(beat.localStartFrame).toBe(beat.startFrame - scene.startFrame);
        expect(beat.localEndFrame).toBe(beat.endFrame - scene.startFrame);
        expect(beat.localStartSeconds).toBeCloseTo(beat.actualStartSeconds - scene.actualStartSeconds, 2);
        expect(beat.localEndSeconds).toBeCloseTo(beat.actualEndSeconds - scene.actualStartSeconds, 2);
        // Local within scene duration
        expect(beat.localStartFrame).toBeGreaterThanOrEqual(0);
        expect(beat.localEndFrame).toBeLessThanOrEqual(scene.durationInFrames);
      }
    }
  });

  it('8. asset binding preserved', async () => {
    const { sceneRenderPlan, remotionPlan } = await getValid();
    const totalAssets = sceneRenderPlan.scenes.reduce((sum: number, s: any) => sum + s.assetRefs.length, 0);
    expect(remotionPlan.summary.assetRefCount).toBe(totalAssets);
    for (const scene of remotionPlan.scenes) {
      for (let i = 0; i < scene.assetRefs.length; i++) {
        const asset = scene.assetRefs[i];
        expect(asset.sceneId).toBe(scene.sourceSceneId);
        expect(asset.order).toBe(i);
      }
    }
  });

  it('9. canonical audio binding', async () => {
    const { remotionPlan } = await getValid();
    for (const scene of remotionPlan.scenes) {
      for (const audio of scene.audioRefs) {
        expect(audio.canonicalPath).toContain('audio/canonical');
        expect(audio.sceneId).toBe(scene.sourceSceneId);
        expect(audio.startFrame).toBeGreaterThanOrEqual(scene.startFrame);
        expect(audio.endFrame).toBeLessThanOrEqual(scene.endFrame);
        expect(audio.localStartFrame).toBe(audio.startFrame - scene.startFrame);
        expect(audio.durationInFrames).toBeGreaterThan(0);
      }
    }
    // No raw SAM
    const allPaths = remotionPlan.scenes.flatMap((s: any) => s.audioRefs.map((a: any) => a.canonicalPath));
    expect(allPaths.every((p: string) => p.includes('audio/canonical'))).toBe(true);
  });

  it('10. caption binding exact text unchanged', async () => {
    const { sceneRenderPlan, remotionPlan } = await getValid();
    for (let sIdx = 0; sIdx < sceneRenderPlan.scenes.length; sIdx++) {
      const origScene = sceneRenderPlan.scenes[sIdx];
      const compScene = remotionPlan.scenes[sIdx];
      expect(compScene.captionCues.length).toBe(origScene.captionCues.length);
      for (let cIdx = 0; cIdx < origScene.captionCues.length; cIdx++) {
        const origCue = origScene.captionCues[cIdx];
        const compCue = compScene.captionCues[cIdx];
        expect(compCue.text).toBe(origCue.text);
        expect(compCue.sceneId).toBe(origCue.sceneId);
        expect(compCue.turnId).toBe(origCue.turnId);
        expect(compCue.startFrame).toBe(deterministicSecondsToFrame(compCue.startTimeSeconds, REMOTION_FPS));
      }
    }
  });

  it('11. transition binding preserved', async () => {
    const { sceneRenderPlan, remotionPlan } = await getValid();
    for (let i = 0; i < sceneRenderPlan.scenes.length; i++) {
      const orig = sceneRenderPlan.scenes[i];
      const comp = remotionPlan.scenes[i];
      expect(comp.transition.type).toBe(orig.transition.type);
      expect(comp.transition.rendererKey).toBe(orig.transition.rendererKey);
      expect(comp.transition.durationSeconds).toBe(orig.transition.durationSeconds);
      expect(comp.transition.source).toBe(orig.transition.source);
      expect(comp.transition.incomingSceneId).toBe(orig.sceneId);
      if (i > 0) {
        expect(comp.transition.outgoingSceneId).toBe(sceneRenderPlan.scenes[i - 1].sceneId);
      } else {
        expect(comp.transition.outgoingSceneId).toBeNull();
      }
    }
  });

  it('12. unknown renderer key failure', async () => {
    const { sceneRenderPlan } = await getValid();
    const badPlan = clone(sceneRenderPlan);
    (badPlan.scenes[0] as any).rendererKey = 'unknown:foobar';
    (badPlan.scenes[0] as any).fallbackUsed = false;
    const res = buildRemotionCompositionProps(badPlan);
    expect(res.success).toBe(false);
    if (!res.success) {
      const hasRendererError = res.findings.some(f =>
        f.code === 'UNKNOWN_RENDERER_KEY' ||
        f.code === 'RENDERER_MAPPING_INVALID' ||
        f.code === 'RENDERER_MAPPING_MISSING'
      );
      expect(hasRendererError).toBe(true);
    }
  });

  it('13. invalid frame range failure', async () => {
    const { remotionPlan } = await getValid();
    const corrupted = clone(remotionPlan);
    // Make invalid: end before start
    corrupted.scenes[0].endFrame = corrupted.scenes[0].startFrame - 10;
    corrupted.scenes[0].durationInFrames = corrupted.scenes[0].endFrame - corrupted.scenes[0].startFrame;
    const validation = validateRemotionCompositionPlan(corrupted);
    expect(validation.valid).toBe(false);
    expect(validation.findings.some(f => f.code === 'INVALID_FRAME_RANGE')).toBe(true);
  });

  it('14. deterministic repeated output', async () => {
    const { sceneRenderPlan } = await getValid();
    const res1 = buildRemotionCompositionProps(sceneRenderPlan);
    const res2 = buildRemotionCompositionProps(sceneRenderPlan);
    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    if (!res1.success || !res2.success) return;
    expect(JSON.stringify(res1.plan)).toBe(JSON.stringify(res2.plan));
  });

  it('15. fps and dimensions mapping', async () => {
    const { remotionPlan } = await getValid();
    expect(remotionPlan.fps).toBe(30);
    expect(remotionPlan.width).toBe(1920);
    expect(remotionPlan.height).toBe(1080);
    expect(remotionPlan.scenes[0].width).toBe(1920);
    expect(remotionPlan.scenes[0].height).toBe(1080);
  });
});
