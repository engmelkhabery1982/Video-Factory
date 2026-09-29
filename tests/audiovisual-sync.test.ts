/**
 * Phase 5D — Audiovisual Synchronization E2E + Negative Tests
 *
 * Validates:
 * - Scenario → Dialogue → Visual → SceneRender → Remotion → AudiovisualSyncReport
 * - Canonical fixture: 5 scenes, 12 turns, 12 audio clips, 28 captions, 12 beats, 118.74s, 30fps, 3563 frames, final valid 3562, exclusive 3563
 * - No orphan audio, no duplicate, no orphan caption, no caption outside audio, no audio outside scene, no beat outside scene, no estimated regression, production audio audible
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getProgressMeetingScenario,
  compileScenarioVisualPlan,
  REMOTION_FPS,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';
import { validateAudiovisualSync } from '../packages/core/src/scenario/audiovisual-sync-pipeline.js';
import fs from 'node:fs';

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

describe('Phase 5D — Audiovisual Sync E2E', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = `tmp-test-phase5d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  async function getValidSync() {
    const scenario = getProgressMeetingScenario();
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error('visual plan failed');

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
    if (!visualProdRes.success) throw new Error(`visual production failed: ${visualProdRes.error}`);

    const sceneRenderRes = buildSceneRenderPlan({
      scenario,
      visualProductionPlan: visualProdRes.plan,
    });
    if (!sceneRenderRes.success) throw new Error(`scene render failed: ${sceneRenderRes.error}`);

    const remotionRes = buildRemotionCompositionProps(sceneRenderRes.plan);
    if (!remotionRes.success) throw new Error(`remotion failed: ${remotionRes.error}`);

    const syncRes = validateAudiovisualSync({
      scenario,
      dialogueResult: dialogueRes.result,
      visualProductionPlan: visualProdRes.plan,
      sceneRenderPlan: sceneRenderRes.plan,
      remotionCompositionPlan: remotionRes.plan,
    });

    return {
      scenario,
      dialogueResult: dialogueRes.result,
      visualProductionPlan: visualProdRes.plan,
      sceneRenderPlan: sceneRenderRes.plan,
      remotionPlan: remotionRes.plan,
      syncRes,
    };
  }

  it('canonical E2E: scenario-pm-01 pipeline → sync report valid', async () => {
    const { scenario, dialogueResult, visualProductionPlan, sceneRenderPlan, remotionPlan, syncRes } = await getValidSync();

    if (!syncRes.success) {
      console.error('FINDINGS:', JSON.stringify(syncRes.findings, null, 2));
    }
    expect(syncRes.success).toBe(true);

    const report = syncRes.report;

    // Canonical fixture assertions
    expect(report.scenarioId).toBe('scenario-pm-01');
    expect(report.fps).toBe(30);
    expect(report.authoritativeDurationSeconds).toBe(118.74);
    expect(report.compositionDurationInFrames).toBe(3563);
    expect(report.summary.sceneCount).toBe(5);
    expect(report.summary.turnCount).toBe(12);
    expect(report.summary.audioClipCount).toBe(12);
    expect(report.summary.captionCueCount).toBe(28);
    expect(report.summary.visualBeatCount).toBe(12);
    expect(report.summary.authoritativeDurationSeconds).toBe(118.74);
    expect(report.summary.compositionDurationInFrames).toBe(3563);
    expect(report.summary.rawFramePosition).toBeCloseTo(3562.2, 1);
    expect(report.summary.finalValidFrameIndex).toBe(3562);
    expect(report.summary.finalExclusiveBoundary).toBe(3563);
    expect(report.summary.finalCapacityTailSeconds).toBeCloseTo(0.026666, 2);
    expect(report.summary.maximumBoundaryProjectionErrorFrames).toBeLessThan(1);
    expect(report.valid).toBe(true);
    expect(report.summary.status).toBe('ok');

    // No orphan audio, no duplicate, etc.
    expect(report.findings.filter(f => f.code === 'ORPHAN_AUDIO_REF').length).toBe(0);
    expect(report.findings.filter(f => f.code === 'DUPLICATE_AUDIO_ASSIGNMENT').length).toBe(0);
    expect(report.findings.filter(f => f.code === 'ORPHAN_CAPTION_REF').length).toBe(0);
    expect(report.findings.filter(f => f.code === 'ESTIMATED_TIMING_REGRESSION').length).toBe(0);
    expect(report.findings.filter(f => f.code === 'PRODUCTION_AUDIO_MUTED').length).toBe(0);
    expect(report.findings.filter(f => f.code === 'FINAL_CONTENT_TRUNCATION').length).toBe(0);

    // Detailed canonical checks
    expect(scenario.scenes.length).toBe(5);
    expect(dialogueResult.reconciledDialogue.clips.length).toBe(12);
    expect(visualProductionPlan.summary.audioClipCount).toBe(12);
    expect(sceneRenderPlan.summary.audioRefCount).toBe(12);
    expect(remotionPlan.summary.audioRefCount).toBe(12);
    expect(remotionPlan.summary.captionCueCount).toBe(28);
    expect(remotionPlan.fps).toBe(30);
    expect(remotionPlan.durationInFrames).toBe(3563);
    expect(remotionPlan.durationInFrames - 1).toBe(3562);

    // Final content coverage uses exclusive 3563 where required
    const allAudios = remotionPlan.scenes.flatMap((s: any) => s.audioRefs);
    // console.error('AUDIO ENDS:', allAudios.map((a: any) => `${a.clipId} ${a.actualEndSeconds}->${a.endFrame}`).join(' | '));
    // In canonical fixture, last audio ends at 118.14, not 118.74, total 118.74 includes pause/transition
    // So final audio should use ceil, not necessarily 3563
    const lastAudio = allAudios[allAudios.length - 1];
    expect(lastAudio).toBeDefined();
    expect(lastAudio.endFrame).toBe(Math.ceil(lastAudio.actualEndSeconds * 30));

    // Final scene must end at 3563
    const finalScene = remotionPlan.scenes[remotionPlan.scenes.length - 1];
    expect(finalScene.endFrame).toBe(3563);
    expect(finalScene.actualEndSeconds).toBe(118.74);

    const allCaptions = remotionPlan.scenes.flatMap((s: any) => s.captionCues);
    // console.error('CAPTION ENDS:', allCaptions.map((c: any) => `${c.id} ${c.endTimeSeconds}->${c.endFrame}`).slice(-5).join(' | '));
    // Captions should not necessarily end at 118.74 either, but if any does, it must use 3563
    const finalCaption = allCaptions.find((c: any) => Math.abs(c.endTimeSeconds - 118.74) < 0.001);
    if (finalCaption) {
      expect(finalCaption.endFrame).toBe(3563);
    }

    // 3563 never treated as rendered frame
    for (const scene of remotionPlan.scenes) {
      for (const audio of scene.audioRefs) {
        expect(audio.startFrame).toBeLessThan(3563);
      }
      for (const cue of scene.captionCues) {
        expect(cue.startFrame).toBeLessThan(3563);
      }
    }

    // Production audio not muted
    const planSource = fs.readFileSync('packages/video/src/compositions/VideoCompositionPlan.tsx', 'utf-8');
    expect(planSource).not.toContain('volume={0}');
    expect(planSource).toContain('<Audio src={audio.canonicalPath}');

    console.log(`Sync report: scenes=${report.summary.sceneCount}, turns=${report.summary.turnCount}, audio=${report.summary.audioClipCount}, captions=${report.summary.captionCueCount}, beats=${report.summary.visualBeatCount}, duration=${report.authoritativeDurationSeconds}s, frames=${report.compositionDurationInFrames}, maxError=${report.summary.maximumBoundaryProjectionErrorFrames}f`);
  });
});

describe('Phase 5D — Negative Tests', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = `tmp-test-phase5d-neg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  async function getValidSync() {
    const scenario = getProgressMeetingScenario();
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error('visual plan failed');
    const dialogueRes = await buildDialogueProductionPlan(scenario, {
      synthesisBasePath: `${tmpRoot}/audio/dialogue`,
      canonicalBasePath: `${tmpRoot}/audio/canonical`,
    });
    if (!dialogueRes.success) throw new Error(`dialogue failed`);
    const visualProdRes = buildVisualProductionPlan({
      scenario,
      visualPlan: visualRes.plan,
      dialogueResult: dialogueRes.result,
    });
    if (!visualProdRes.success) throw new Error(`visual production failed`);
    const sceneRenderRes = buildSceneRenderPlan({
      scenario,
      visualProductionPlan: visualProdRes.plan,
    });
    if (!sceneRenderRes.success) throw new Error(`scene render failed`);
    const remotionRes = buildRemotionCompositionProps(sceneRenderRes.plan);
    if (!remotionRes.success) throw new Error(`remotion failed`);
    return {
      scenario,
      dialogueResult: dialogueRes.result,
      visualProductionPlan: visualProdRes.plan,
      sceneRenderPlan: sceneRenderRes.plan,
      remotionPlan: remotionRes.plan,
    };
  }

  it('1. missing audio clip', async () => {
    const valid = await getValidSync();
    const dialogueResult = clone(valid.dialogueResult);
    dialogueResult.reconciledDialogue.clips.pop();
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: valid.remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'TURN_AUDIO_SYNC_MISMATCH' || f.code === 'MISSING_PHASE_OUTPUT')).toBe(true);
  });

  it('2. duplicate audio clip', async () => {
    const valid = await getValidSync();
    const dialogueResult = clone(valid.dialogueResult);
    const first = dialogueResult.reconciledDialogue.clips[0];
    dialogueResult.reconciledDialogue.clips.push(clone(first));
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: valid.remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'DUPLICATE_AUDIO_ASSIGNMENT')).toBe(true);
  });

  it('3. audio assigned to wrong scene', async () => {
    const valid = await getValidSync();
    const dialogueResult = clone(valid.dialogueResult);
    dialogueResult.reconciledDialogue.clips[0].sceneId = 'wrong-scene-id';
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: valid.remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'TURN_AUDIO_SYNC_MISMATCH' || f.code === 'ORPHAN_AUDIO_REF')).toBe(true);
  });

  it('4. audio assigned to wrong turn', async () => {
    const valid = await getValidSync();
    const dialogueResult = clone(valid.dialogueResult);
    dialogueResult.reconciledDialogue.clips[0].turnId = 'wrong-turn-id';
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: valid.remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'TURN_AUDIO_SYNC_MISMATCH' || f.code === 'ORPHAN_AUDIO_REF')).toBe(true);
  });

  it('5. audio frame shifted incorrectly', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    remotionPlan.scenes[0].audioRefs[0].startFrame += 10;
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'AUDIO_FRAME_SYNC_MISMATCH')).toBe(true);
  });

  it('6. caption before speech start', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    const firstCue = remotionPlan.scenes[0].captionCues[0];
    firstCue.startTimeSeconds = firstCue.startTimeSeconds - 5;
    firstCue.startFrame = Math.round(firstCue.startTimeSeconds * 30);
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'CAPTION_AUDIO_SYNC_MISMATCH' || f.code === 'CAPTION_IDENTITY_MISMATCH')).toBe(true);
  });

  it('7. caption after speech end', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    const firstScene = remotionPlan.scenes[0];
    const lastCue = firstScene.captionCues[firstScene.captionCues.length - 1];
    lastCue.endTimeSeconds = lastCue.endTimeSeconds + 5;
    lastCue.endFrame = Math.ceil(lastCue.endTimeSeconds * 30);
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'CAPTION_AUDIO_SYNC_MISMATCH')).toBe(true);
  });

  it('8. caption assigned to wrong turn', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    remotionPlan.scenes[0].captionCues[0].turnId = 'wrong-turn';
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'CAPTION_IDENTITY_MISMATCH' || f.code === 'CAPTION_AUDIO_SYNC_MISMATCH' || f.code === 'ORPHAN_CAPTION_REF')).toBe(true);
  });

  it('9. caption assigned to wrong scene', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    remotionPlan.scenes[0].captionCues[0].sceneId = 'wrong-scene';
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'CAPTION_IDENTITY_MISMATCH' || f.code === 'CAPTION_AUDIO_SYNC_MISMATCH')).toBe(true);
  });

  it('10. orphan caption', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    remotionPlan.scenes[0].captionCues.push({
      id: 'orphan-cue-123',
      sceneId: remotionPlan.scenes[0].sceneId,
      sceneIndex: 0,
      turnId: 'nonexistent-turn',
      turnIndex: 99,
      globalTurnIndex: 99,
      clipId: 'nonexistent-clip',
      text: 'orphan text',
      speakerId: 'char-sarah-pm',
      voiceSlot: 'voice_en_female_authority',
      startTimeSeconds: 0,
      endTimeSeconds: 1,
      durationSeconds: 1,
      estimatedStartTimeSeconds: 0,
      estimatedEndTimeSeconds: 1,
      estimatedDurationSeconds: 1,
      wordCount: 2,
      isSingleWord: false,
      globalCueIndex: 999,
      startFrame: 0,
      endFrame: 30,
      durationInFrames: 30,
      localStartFrame: 0,
      localEndFrame: 30,
      localStartSeconds: 0,
      localEndSeconds: 1,
    } as any);
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'ORPHAN_CAPTION_REF')).toBe(true);
  });

  it('11. beat outside scene', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    remotionPlan.scenes[0].beats[0].actualStartSeconds = remotionPlan.scenes[0].actualEndSeconds + 10;
    remotionPlan.scenes[0].beats[0].actualEndSeconds = remotionPlan.scenes[0].actualStartSeconds + 1;
    remotionPlan.scenes[0].beats[0].startFrame = Math.round(remotionPlan.scenes[0].beats[0].actualStartSeconds * 30);
    remotionPlan.scenes[0].beats[0].endFrame = Math.round(remotionPlan.scenes[0].beats[0].actualEndSeconds * 30);
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'VISUAL_BEAT_SYNC_MISMATCH')).toBe(true);
  });

  it('12. beat references missing turn', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    remotionPlan.scenes[0].beats[0].turnId = 'missing-turn-xyz';
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'VISUAL_AUDIO_SYNC_MISMATCH')).toBe(true);
  });

  it('13. wrong final frame count', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    remotionPlan.durationInFrames = 3562;
    remotionPlan.scenes[remotionPlan.scenes.length - 1].endFrame = 3562;
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'COMPOSITION_DURATION_MISMATCH' || f.code === 'SCENE_SYNC_MISMATCH')).toBe(true);
  });

  it('14. final audio truncation', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    const finalScene = remotionPlan.scenes[remotionPlan.scenes.length - 1];
    // Find any audio, preferably final, and truncate its coverage
    let finalAudio = finalScene.audioRefs.find((a: any) => Math.abs(a.actualEndSeconds - 118.74) < 0.001);
    if (!finalAudio) {
      finalAudio = finalScene.audioRefs[finalScene.audioRefs.length - 1];
    }
    expect(finalAudio).toBeDefined();
    const required = Math.ceil(finalAudio.actualEndSeconds * 30);
    finalAudio.endFrame = required - 1; // truncate by 1 frame
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'FINAL_CONTENT_TRUNCATION' || f.code === 'AUDIO_FRAME_SYNC_MISMATCH')).toBe(true);
  });

  it('15. final caption truncation', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    const finalScene = remotionPlan.scenes[remotionPlan.scenes.length - 1];
    let finalCaption = finalScene.captionCues.find((c: any) => Math.abs(c.endTimeSeconds - 118.74) < 0.001);
    if (!finalCaption) {
      finalCaption = finalScene.captionCues[finalScene.captionCues.length - 1];
    }
    expect(finalCaption).toBeDefined();
    const required = Math.ceil(finalCaption.endTimeSeconds * 30);
    finalCaption.endFrame = required - 1;
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'FINAL_CONTENT_TRUNCATION' || f.code === 'CAPTION_FRAME_SYNC_MISMATCH')).toBe(true);
  });

  it('16. production audio muted', async () => {
    const valid = await getValidSync();
    // Mock file system to simulate muted file
    const originalReadFileSync = fs.readFileSync;
    (fs as any).readFileSync = (p: string, ...args: any[]) => {
      if (typeof p === 'string' && p.includes('VideoCompositionPlan.tsx')) {
        return `import { Audio } from 'remotion'; <Audio src={audio.canonicalPath} volume={0} />`;
      }
      return (originalReadFileSync as any)(p, ...args);
    };
    try {
      const res = validateAudiovisualSync({
        scenario: valid.scenario,
        dialogueResult: valid.dialogueResult,
        visualProductionPlan: valid.visualProductionPlan,
        sceneRenderPlan: valid.sceneRenderPlan,
        remotionCompositionPlan: valid.remotionPlan,
      });
      expect(res.success).toBe(false);
      expect(res.findings.some(f => f.code === 'PRODUCTION_AUDIO_MUTED')).toBe(true);
    } finally {
      (fs as any).readFileSync = originalReadFileSync;
    }
  });

  it('17. estimated timing regressed to 102s', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    remotionPlan.totalActualDurationSeconds = 102;
    remotionPlan.durationInFrames = Math.ceil(102 * 30);
    // Adjust scenes to match 102s roughly
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'ESTIMATED_TIMING_REGRESSION')).toBe(true);
  });

  it('18. wrong speaker identity', async () => {
    const valid = await getValidSync();
    const dialogueResult = clone(valid.dialogueResult);
    dialogueResult.reconciledDialogue.clips[0].speakerId = 'wrong-speaker';
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: valid.remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'TURN_AUDIO_SYNC_MISMATCH')).toBe(true);
  });

  it('19. invalid transition/audio interaction - transition exceeds scene', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    remotionPlan.scenes[0].transition.durationInFrames = remotionPlan.scenes[0].durationInFrames + 100;
    remotionPlan.scenes[0].transition.endFrame = remotionPlan.scenes[0].transition.startFrame !== null ? remotionPlan.scenes[0].transition.startFrame + remotionPlan.scenes[0].transition.durationInFrames : null;
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'TRANSITION_SYNC_MISMATCH')).toBe(true);
  });

  it('20. duplicate scene identity', async () => {
    const valid = await getValidSync();
    const remotionPlan = clone(valid.remotionPlan);
    remotionPlan.scenes[1].sceneId = remotionPlan.scenes[0].sceneId;
    const res = validateAudiovisualSync({
      scenario: valid.scenario,
      dialogueResult: valid.dialogueResult,
      visualProductionPlan: valid.visualProductionPlan,
      sceneRenderPlan: valid.sceneRenderPlan,
      remotionCompositionPlan: remotionPlan,
    });
    expect(res.success).toBe(false);
    expect(res.findings.some(f => f.code === 'DUPLICATE_SCENE_ID')).toBe(true);
  });
});
