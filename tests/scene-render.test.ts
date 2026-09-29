/**
 * Phase 5B — Scene Render Plan Unit Tests
 *
 * Covers:
 * - valid VisualProductionPlan mapping
 * - deterministic renderer mapping
 * - scene order
 * - beat preservation
 * - asset binding
 * - canonical audio binding
 * - caption binding
 * - transition mapping
 * - unsupported scene type
 * - explicit fallback behavior
 * - duplicate render order
 * - wrong scene audio
 * - wrong scene captions
 * - invalid asset association
 * - deterministic repeated output
 */

import { describe, it, expect } from 'vitest';
import {
  getProgressMeetingScenario,
  compileScenarioVisualPlan,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan, validateSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

describe('Phase 5B — Scene Render Plan', () => {
  let cached: any = null;

  async function getValid() {
    if (cached) return cached;
    const scenario = getProgressMeetingScenario();
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error('visual failed');
    const tmpRoot = `tmp-test-phase5b-unit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fs = await import('node:fs');
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
      cached = {
        scenario,
        visualPlan: visualRes.plan,
        dialogueResult: dialogueRes.result,
        visualProductionPlan: visualProdRes.plan,
      };
      return cached;
    } finally {
      const fs2 = await import('node:fs');
      if (fs2.existsSync(tmpRoot)) {
        fs2.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  }

  it('1. valid VisualProductionPlan mapping — all scenes map exactly once', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.plan.scenes.length).toBe(scenario.scenes.length);
    expect(res.plan.scenes.length).toBe(visualProductionPlan.scenes.length);
  });

  it('2. deterministic renderer mapping — same input → same rendererKey', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res1 = buildSceneRenderPlan({ scenario, visualProductionPlan });
    const res2 = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    if (!res1.success || !res2.success) return;
    expect(res1.plan.scenes.map(s => s.rendererKey)).toEqual(res2.plan.scenes.map(s => s.rendererKey));
    // All renderer keys should be known
    for (const scene of res1.plan.scenes) {
      expect(scene.rendererKey).toBeDefined();
      expect(typeof scene.rendererKey).toBe('string');
    }
  });

  it('3. scene order preserved', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.plan.scenes.map(s => s.sourceSceneId)).toEqual(scenario.scenes.map(s => s.id));
    for (let i = 0; i < res.plan.scenes.length; i++) {
      expect(res.plan.scenes[i].renderOrder).toBe(i);
      expect(res.plan.scenes[i].sceneIndex).toBe(i);
    }
  });

  it('4. beat preservation — timing unchanged from Phase 5A', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;

    for (let sIdx = 0; sIdx < visualProductionPlan.scenes.length; sIdx++) {
      const vScene = visualProductionPlan.scenes[sIdx];
      const rScene = res.plan.scenes[sIdx];
      expect(rScene.beats.length).toBe(vScene.beats.length);
      for (let bIdx = 0; bIdx < vScene.beats.length; bIdx++) {
        const vBeat = vScene.beats[bIdx];
        const rBeat = rScene.beats[bIdx];
        expect(rBeat.id).toBe(vBeat.id);
        expect(rBeat.actualStartSeconds).toBe(vBeat.actualStartSeconds);
        expect(rBeat.actualEndSeconds).toBe(vBeat.actualEndSeconds);
        expect(rBeat.actualDurationSeconds).toBe(vBeat.actualDurationSeconds);
        expect(rBeat.relativeStart).toBe(vBeat.relativeStart);
        expect(rBeat.relativeEnd).toBe(vBeat.relativeEnd);
      }
    }
  });

  it('5. asset binding — deterministic order, scene ownership preserved', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;

    const totalAssets = visualProductionPlan.scenes.reduce((sum: number, s: any) => sum + s.assetRefs.length, 0);
    expect(res.plan.summary.assetRefCount).toBe(totalAssets);

    for (const scene of res.plan.scenes) {
      for (const asset of scene.assetRefs) {
        expect(asset.sceneId).toBe(scene.sourceSceneId);
      }
    }
  });

  it('6. canonical audio binding — only canonical path, correct identity', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;

    for (const scene of res.plan.scenes) {
      for (const audio of scene.audioRefs) {
        expect(audio.canonicalPath).toContain('audio/canonical');
        expect(audio.sceneId).toBe(scene.sourceSceneId);
        expect(audio.actualDurationSeconds).toBeGreaterThan(0);
      }
    }
    // No raw SAM path
    const allAudioPaths = res.plan.scenes.flatMap(s => s.audioRefs.map(a => a.canonicalPath));
    expect(allAudioPaths.every(p => !p.includes('audio/dialogue') || p.includes('audio/canonical'))).toBe(true);
  });

  it('7. caption binding — correct scene/turn identity, timing within scene', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;

    for (const scene of res.plan.scenes) {
      for (const cue of scene.captionCues) {
        expect(cue.sceneId).toBe(scene.sourceSceneId);
        expect(scene.turnIds).toContain(cue.turnId);
        expect(cue.startTimeSeconds).toBeGreaterThanOrEqual(scene.actualStartSeconds - 0.001);
        expect(cue.endTimeSeconds).toBeLessThanOrEqual(scene.actualEndSeconds + 0.001);
      }
    }
    expect(res.plan.summary.captionCueCount).toBe(visualProductionPlan.summary.captionCueCount);
  });

  it('8. transition mapping — type and duration preserved', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;

    for (let i = 0; i < visualProductionPlan.scenes.length; i++) {
      const vScene = visualProductionPlan.scenes[i];
      const rScene = res.plan.scenes[i];
      expect(rScene.transition.type).toBe(vScene.transition.type);
      expect(rScene.transition.durationSeconds).toBe(vScene.transition.durationSeconds);
      expect(rScene.transition.source).toBe(vScene.transition.source);
      // actual interval mapped
      if (vScene.transition.actualDurationSeconds !== null) {
        expect(rScene.transition.actualDurationSeconds).toBe(vScene.transition.actualDurationSeconds);
      }
    }
  });

  it('9. unsupported scene type — explicit error without fallback', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const badPlan = clone(visualProductionPlan);
    // Corrupt narrativePurpose to unknown
    (badPlan.scenes[0] as any).narrativePurpose = 'unknown_purpose_xyz';
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan: badPlan });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.findings.some(f => f.code === 'UNSUPPORTED_SCENE_TYPE')).toBe(true);
    }
  });

  it('10. explicit fallback behavior if allowed', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const badPlan = clone(visualProductionPlan);
    (badPlan.scenes[0] as any).narrativePurpose = 'unknown_purpose_xyz';
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan: badPlan, options: { allowGenericFallback: true } });
    expect(res.success).toBe(true);
    if (!res.success) return;
    const firstScene = res.plan.scenes[0];
    expect(firstScene.fallbackUsed).toBe(true);
    expect(firstScene.fallbackFrom).toBe('unknown_purpose_xyz');
    expect(firstScene.rendererKey).toBe('generic:generic');
    expect(res.plan.summary.fallbackCount).toBeGreaterThan(0);
  });

  it('11. duplicate render order — validation fails', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;

    const corrupted = clone(res.plan);
    if (corrupted.scenes.length >= 2) {
      corrupted.scenes[1].renderOrder = corrupted.scenes[0].renderOrder; // duplicate
      const validation = validateSceneRenderPlan(corrupted);
      expect(validation.valid).toBe(false);
      expect(validation.findings.some(f => f.code === 'DUPLICATE_RENDER_ORDER')).toBe(true);
    }
  });

  it('12. wrong scene audio — audio from another scene should fail', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;

    const corrupted = clone(res.plan);
    if (corrupted.scenes.length >= 2 && corrupted.scenes[0].audioRefs.length > 0) {
      // Move audio from scene 0 to scene 1 but keep wrong sceneId
      const audio = corrupted.scenes[0].audioRefs[0];
      corrupted.scenes[1].audioRefs.push(audio); // audio.sceneId still points to scene 0
      const validation = validateSceneRenderPlan(corrupted);
      expect(validation.valid).toBe(false);
      expect(validation.findings.some(f => f.code === 'AUDIO_BINDING_MISMATCH')).toBe(true);
    }
  });

  it('13. wrong scene captions — caption from another scene should fail', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;

    const corrupted = clone(res.plan);
    if (corrupted.scenes.length >= 2 && corrupted.scenes[0].captionCues.length > 0) {
      const cue = corrupted.scenes[0].captionCues[0];
      corrupted.scenes[1].captionCues.push(cue);
      const validation = validateSceneRenderPlan(corrupted);
      expect(validation.valid).toBe(false);
      expect(validation.findings.some(f => f.code === 'CAPTION_BINDING_MISMATCH')).toBe(true);
    }
  });

  it('14. invalid asset association — asset bound to wrong scene should fail', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;

    const corrupted = clone(res.plan);
    if (corrupted.scenes.length >= 2 && corrupted.scenes[0].assetRefs.length > 0) {
      const asset = corrupted.scenes[0].assetRefs[0];
      corrupted.scenes[1].assetRefs.push(asset);
      const validation = validateSceneRenderPlan(corrupted);
      expect(validation.valid).toBe(false);
      expect(validation.findings.some(f => f.code === 'ASSET_BINDING_MISMATCH')).toBe(true);
    }
  });

  it('15. deterministic repeated output', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res1 = buildSceneRenderPlan({ scenario, visualProductionPlan });
    const res2 = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    if (!res1.success || !res2.success) return;
    expect(JSON.stringify(res1.plan)).toBe(JSON.stringify(res2.plan));
  });

  it('16. total duration matches Phase 5A actual', async () => {
    const { scenario, visualProductionPlan } = await getValid();
    const res = buildSceneRenderPlan({ scenario, visualProductionPlan });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.plan.totalActualDurationSeconds).toBe(visualProductionPlan.totalActualDurationSeconds);
    expect(res.plan.scenes[res.plan.scenes.length - 1].actualEndSeconds).toBe(res.plan.totalActualDurationSeconds);
  });
});
