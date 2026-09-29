/**
 * Phase 5A — Visual Production Contract & Phase 4→5 Adapter Unit Tests
 *
 * Covers:
 * - correct Phase 4 → visual plan adaptation
 * - actual timing used instead of estimated
 * - longer/shorter actual scene duration mapping
 * - visual beat relative-position preservation
 * - scene order preservation
 * - canonical audio reference mapping
 * - caption mapping
 * - asset mapping
 * - deterministic output
 * - missing scene, wrong scene order, wrong scenarioId, missing actual timing, caption mismatch, audio mismatch, invalid asset, no estimated override
 */

import { describe, it, expect } from 'vitest';
import {
  getProgressMeetingScenario,
  planDialogueAudio,
  compileScenarioVisualPlan,
  compileScenarioCaptions,
  type Scenario,
} from '@buildtrack/core';
import { resolveDialogueAudioPlanVoices } from '../packages/core/src/scenario/voice-resolver.js';
import { LocalDialogueSynthesizer } from '../packages/core/src/scenario/local-dialogue-synthesizer.js';
import { synthesizeDialoguePlan } from '../packages/core/src/scenario/synthesize-dialogue.js';
import { createCanonicalDialogueAudioManifest } from '../packages/core/src/scenario/canonical-dialogue-audio.js';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan, validateVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { DialogueProductionResult } from '../packages/core/src/scenario/dialogue-production-types.js';

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

describe('Phase 5A — Visual Production Mapping', () => {
  let validInputs: {
    scenario: Scenario;
    visualPlan: any;
    dialogueResult: DialogueProductionResult;
  };

  // Build valid pipeline once per test file (using fake faster path without real audio for unit tests, but we need actual timing)
  // For unit tests, we will use buildDialogueProductionPlan with real SAM but in tmp dirs — we need to avoid heavy I/O for each test
  // Instead, we will build a minimal fake dialogueResult with actual timing using earlier Phase 4D test helper logic
  // For simplicity, we reuse real pipeline but cached

  // We'll create a helper to make fake canonical manifest with controlled durations
  async function buildRealDialogueResult(): Promise<{ scenario: Scenario; visualPlan: any; dialogueResult: DialogueProductionResult }> {
    const scenario = getProgressMeetingScenario();
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error('visual failed');
    const tmpRoot = `tmp-test-phase5a-unit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fs = await import('node:fs');
    fs.mkdirSync(tmpRoot, { recursive: true });
    try {
      const result = await buildDialogueProductionPlan(scenario, {
        synthesisBasePath: `${tmpRoot}/audio/dialogue`,
        canonicalBasePath: `${tmpRoot}/audio/canonical`,
      });
      if (!result.success) throw new Error(`dialogue production failed: ${result.error}`);
      return {
        scenario,
        visualPlan: visualRes.plan,
        dialogueResult: result.result,
      };
    } finally {
      const fs2 = await import('node:fs');
      if (fs2.existsSync(tmpRoot)) {
        fs2.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  }

  // We will lazily build once
  let cached: Awaited<ReturnType<typeof buildRealDialogueResult>> | null = null;
  async function getValid() {
    if (!cached) {
      cached = await buildRealDialogueResult();
    }
    return cached;
  }

  it('1. correct Phase 4 → visual plan adaptation — all scenes map', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.plan.scenes.length).toBe(scenario.scenes.length);
    expect(res.plan.scenes.map(s => s.sourceSceneId)).toEqual(scenario.scenes.map(s => s.id));
  });

  it('2. actual timing used instead of estimated timing', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;
    // total actual must match Phase 4 actual, not estimated
    expect(res.plan.totalActualDurationSeconds).toBe(dialogueResult.reconciledDialogue.actualTotalDurationSeconds);
    expect(res.plan.totalActualDurationSeconds).not.toBe(visualPlan.totalDurationSeconds);
    // Each scene actual must match reconciled
    for (let i = 0; i < res.plan.scenes.length; i++) {
      const vScene = res.plan.scenes[i];
      const rScene = dialogueResult.reconciledDialogue.scenes[i];
      expect(vScene.actualStartSeconds).toBe(rScene.actualStartTimeSeconds);
      expect(vScene.actualEndSeconds).toBe(rScene.actualEndTimeSeconds);
      expect(vScene.actualDurationSeconds).toBe(rScene.actualDurationSeconds);
    }
  });

  it('3. longer/shorter actual scene duration mapping', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;
    // At least one scene should have actual != estimated (SAM differs)
    let hasDiff = false;
    for (const scene of res.plan.scenes) {
      if (Math.abs(scene.actualDurationSeconds - scene.estimatedDurationSeconds) > 0.01) {
        hasDiff = true;
        break;
      }
    }
    expect(hasDiff).toBe(true);
  });

  it('4. visual beat relative-position preservation', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;

    for (let sIdx = 0; sIdx < visualPlan.scenes.length; sIdx++) {
      const origScene = visualPlan.scenes[sIdx];
      const prodScene = res.plan.scenes[sIdx];
      const origEstDur = origScene.durationSeconds;
      const prodActDur = prodScene.actualDurationSeconds;

      for (let bIdx = 0; bIdx < origScene.beats.length; bIdx++) {
        const origBeat = origScene.beats[bIdx];
        const prodBeat = prodScene.beats[bIdx];

        // Relative position preserved
        const origRelStart = (origBeat.startSeconds - origScene.startSeconds) / origEstDur;
        const origRelEnd = (origBeat.endSeconds - origScene.startSeconds) / origEstDur;

        expect(prodBeat.relativeStart).toBeCloseTo(Math.max(0, Math.min(1, origRelStart)), 1);
        expect(prodBeat.relativeEnd).toBeCloseTo(Math.max(0, Math.min(1, origRelEnd)), 1);

        // Actual timing = scene actual start + relative * actual duration
        const expectedActualStart = prodScene.actualStartSeconds + origRelStart * prodActDur;
        const expectedActualEnd = prodScene.actualStartSeconds + origRelEnd * prodActDur;

        // Allow small rounding, except last beat which is clamped to scene end
        if (bIdx !== origScene.beats.length - 1) {
          expect(prodBeat.actualStartSeconds).toBeCloseTo(expectedActualStart, 1);
        }
        // Order preserved
        expect(prodBeat.index).toBe(bIdx);
        expect(prodBeat.id).toBe(origBeat.id);
      }
    }
  });

  it('5. scene order preservation', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;
    const order = res.plan.scenes.map(s => s.sourceSceneId);
    expect(order).toEqual(scenario.scenes.map(s => s.id));
    for (let i = 0; i < res.plan.scenes.length; i++) {
      expect(res.plan.scenes[i].renderOrder).toBe(i);
      expect(res.plan.scenes[i].index).toBe(i);
    }
  });

  it('6. canonical audio reference mapping', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;

    for (const scene of res.plan.scenes) {
      for (const audioRef of scene.audioRefs) {
        // Must use canonical path, not source
        expect(audioRef.canonicalPath).toContain('audio/canonical');
        expect(audioRef.canonicalPath).not.toContain('audio/dialogue');
        // Must have actual duration
        expect(audioRef.actualDurationSeconds).toBeGreaterThan(0);
        // Must map to canonical manifest
        const canon = dialogueResult.canonicalManifest.byClipId[audioRef.clipId];
        expect(canon).toBeDefined();
        expect(canon.canonicalPath).toBe(audioRef.canonicalPath);
      }
      // Every dialogue beat must have audioRef
      for (const beat of scene.beats) {
        if (beat.kind === 'dialogue') {
          expect(beat.audioRef).not.toBeNull();
          expect(beat.audioRef!.canonicalPath).toBeDefined();
        }
      }
    }
  });

  it('7. caption mapping', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;

    for (const scene of res.plan.scenes) {
      for (const cue of scene.captionCues) {
        expect(scene.turnIds).toContain(cue.turnId);
        // Boundaries within actual speech
        const audioRef = scene.audioRefs.find(a => a.turnId === cue.turnId);
        if (audioRef) {
          expect(cue.startTimeSeconds).toBeGreaterThanOrEqual(audioRef.actualStartSeconds - 0.001);
          expect(cue.endTimeSeconds).toBeLessThanOrEqual(audioRef.actualEndSeconds + 0.001);
        }
        // Text unchanged (compared to dialogueResult)
        const origCue = dialogueResult.reconciledCaptions.cues.find(c => c.id === cue.id);
        expect(origCue).toBeDefined();
        expect(cue.text).toBe(origCue!.text);
      }
    }
  });

  it('8. asset mapping', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;

    // Asset refs should be collected from visual plan cues
    const totalAssetRefsInVisualPlan = visualPlan.scenes.reduce((sum: number, s: any) => {
      const sceneCues = s.sceneCues.filter((c: any) => c.assetRef).length;
      const beatCues = s.beats.reduce((bsum: number, b: any) => bsum + b.cues.filter((c: any) => c.assetRef).length, 0);
      return sum + sceneCues + beatCues;
    }, 0);

    expect(res.plan.summary.assetReferenceCount).toBe(totalAssetRefsInVisualPlan);
    for (const scene of res.plan.scenes) {
      for (const asset of scene.assetRefs) {
        expect(asset.assetRef).toBeDefined();
        expect(asset.sceneId).toBe(scene.sourceSceneId);
      }
    }
  });

  it('9. deterministic output', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res1 = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    const res2 = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    if (!res1.success || !res2.success) return;
    expect(JSON.stringify(res1.plan)).toBe(JSON.stringify(res2.plan));
  });

  it('10. missing scene rejects', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const badVisualPlan = clone(visualPlan);
    badVisualPlan.scenes = badVisualPlan.scenes.slice(0, -1); // remove last scene
    const res = buildVisualProductionPlan({ scenario, visualPlan: badVisualPlan, dialogueResult });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.findings.some(f => f.code === 'VISUAL_SCENE_MISMATCH' || f.code === 'MISSING_SCENE')).toBe(true);
    }
  });

  it('11. wrong scene order rejects', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const badVisualPlan = clone(visualPlan);
    badVisualPlan.scenes = [...badVisualPlan.scenes].reverse();
    const res = buildVisualProductionPlan({ scenario, visualPlan: badVisualPlan, dialogueResult });
    expect(res.success).toBe(false);
  });

  it('12. wrong scenarioId rejects', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const badScenario = clone(scenario);
    (badScenario as any).metadata.id = 'wrong-scenario-id';
    const res = buildVisualProductionPlan({ scenario: badScenario as any, visualPlan, dialogueResult });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.findings.some(f => f.code === 'PIPELINE_IDENTITY_MISMATCH')).toBe(true);
    }
  });

  it('13. missing actual timing rejects', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const badDialogueResult = clone(dialogueResult);
    (badDialogueResult as any).reconciledDialogue = null;
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult: badDialogueResult as any });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.findings.some(f => f.code === 'MISSING_ACTUAL_TIMING' || f.code === 'MISSING_PHASE_OUTPUT')).toBe(true);
    }
  });

  it('14. caption mismatch — cue outside interval should be caught by final invariants', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;

    // Corrupt caption cue to be outside interval
    const corruptedPlan = clone(res.plan);
    if (corruptedPlan.scenes.length > 0 && corruptedPlan.scenes[0].captionCues.length > 0) {
      const cue = corruptedPlan.scenes[0].captionCues[0];
      const audioRef = corruptedPlan.scenes[0].audioRefs.find(a => a.turnId === cue.turnId);
      if (audioRef) {
        cue.startTimeSeconds = audioRef.actualEndSeconds + 1;
        cue.endTimeSeconds = audioRef.actualEndSeconds + 2;
      }
      const validation = validateVisualProductionPlan(corruptedPlan);
      expect(validation.valid).toBe(false);
      expect(validation.findings.some(f => f.code === 'CAPTION_REFERENCE_MISMATCH')).toBe(true);
    }
  });

  it('15. audio mismatch — dialogue beat without audioRef should fail validation', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;

    const corruptedPlan = clone(res.plan);
    // Find a dialogue beat and remove its audioRef
    for (const scene of corruptedPlan.scenes) {
      const dlgBeat = scene.beats.find(b => b.kind === 'dialogue');
      if (dlgBeat) {
        (dlgBeat as any).audioRef = null;
        break;
      }
    }
    const validation = validateVisualProductionPlan(corruptedPlan);
    expect(validation.valid).toBe(false);
    expect(validation.findings.some(f => f.code === 'AUDIO_REFERENCE_MISMATCH')).toBe(true);
  });

  it('16. invalid asset reference — required asset invalid should fail', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;

    const corruptedPlan = clone(res.plan);
    // Add an invalid required asset
    if (corruptedPlan.scenes.length > 0) {
      corruptedPlan.scenes[0].assetRefs.push({
        assetRef: '/absolute/invalid/path.png',
        cueKind: 'overlay',
        cueId: 'cue-invalid',
        beatId: 'beat-invalid',
        sceneId: corruptedPlan.scenes[0].sourceSceneId,
        required: true,
      });
      const validation = validateVisualProductionPlan(corruptedPlan);
      expect(validation.valid).toBe(false);
      expect(validation.findings.some(f => f.code === 'ASSET_REFERENCE_INVALID')).toBe(true);
    }
  });

  it('17. no estimated timing override — total actual must match Phase 4', async () => {
    const { scenario, visualPlan, dialogueResult } = await getValid();
    const res = buildVisualProductionPlan({ scenario, visualPlan, dialogueResult });
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.plan.totalActualDurationSeconds).toBe(dialogueResult.reconciledDialogue.actualTotalDurationSeconds);
    expect(res.plan.totalActualDurationSeconds).toBe(res.plan.scenes[res.plan.scenes.length - 1].actualEndSeconds);
    // Ensure we didn't accidentally use estimated total
    expect(res.plan.totalActualDurationSeconds).not.toBe(visualPlan.totalDurationSeconds);
  });
});
