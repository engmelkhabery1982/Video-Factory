/**
 * Phase 4E — Full real end-to-end integration test
 * Scenario → DialogueAudioPlan → Voice Resolution → real SAM → WAV validation → FFmpeg normalization → actual timing → playback → captions → final Phase 4 result
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  getProgressMeetingScenario,
  planDialogueAudio,
  compileScenarioVisualPlan,
  compileScenarioCaptions,
} from '@buildtrack/core';
import { resolveDialogueAudioPlanVoices } from '../packages/core/src/scenario/voice-resolver.js';
import { LocalDialogueSynthesizer } from '../packages/core/src/scenario/local-dialogue-synthesizer.js';
import { synthesizeDialoguePlan } from '../packages/core/src/scenario/synthesize-dialogue.js';
import { createCanonicalDialogueAudioManifest } from '../packages/core/src/scenario/canonical-dialogue-audio.js';
import { WavHeaderProbe } from '../packages/core/src/scenario/audio-probe.js';
import {
  buildDialogueProductionPlan,
  buildDialogueProductionResultFromArtifacts,
} from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { validateDialogueProductionResult } from '../packages/core/src/scenario/dialogue-production-validation.js';
import { reconcileTiming } from '../packages/core/src/scenario/reconcile-timing.js';

describe('Phase 4E — Full real end-to-end integration', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = `tmp-test-phase4e-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('real SAM → canonical → reconciliation → final result proves full pipeline', async () => {
    const scenario = getProgressMeetingScenario();

    const synthesisBase = `${tmpRoot}/audio/dialogue`;
    const canonicalBase = `${tmpRoot}/audio/canonical`;

    // Full orchestration via buildDialogueProductionPlan
    const orchestrationResult = await buildDialogueProductionPlan(scenario, {
      synthesisBasePath: synthesisBase,
      canonicalBasePath: canonicalBase,
    });

    if (!orchestrationResult.success) {
      console.error('Orchestration failed:', orchestrationResult.error, orchestrationResult.findings);
    }
    expect(orchestrationResult.success).toBe(true);
    if (!orchestrationResult.success) return;

    const result = orchestrationResult.result;

    // Verify real audio files are created
    for (const res of result.canonicalManifest.results) {
      expect(fs.existsSync(res.canonicalPath)).toBe(true);
      expect(fs.existsSync(res.sourcePath)).toBe(true);
    }

    // raw SAM WAV is detected as 22.05 kHz
    const probe = new WavHeaderProbe();
    const firstSourceMeta = probe.probeSync(result.synthesisManifest.results[0].outputPath);
    expect(firstSourceMeta.sampleRate).toBe(22050);
    expect(firstSourceMeta.isCanonical).toBe(false);

    // canonical WAV is 48 kHz mono PCM16
    const firstCanonicalMeta = probe.probeSync(result.canonicalManifest.results[0].canonicalPath);
    expect(firstCanonicalMeta.sampleRate).toBe(48000);
    expect(firstCanonicalMeta.channels).toBe(1);
    expect(firstCanonicalMeta.codec).toBe('pcm_s16le');
    expect(firstCanonicalMeta.bitDepth).toBe(16);
    expect(firstCanonicalMeta.isCanonical).toBe(true);

    // actual duration differs from estimator for at least one clip
    let hasDifference = false;
    for (const clip of result.dialoguePlan.clips) {
      const recon = result.reconciledDialogue.clips.find(c => c.clipId === clip.clipId)!;
      if (Math.abs(recon.actualDurationSeconds - clip.durationSeconds) > 0.01) {
        hasDifference = true;
        break;
      }
    }
    expect(hasDifference).toBe(true);

    // final reconciled total duration reflects real audio
    const sumActual = result.reconciledDialogue.clips.reduce((s, c) => s + c.actualDurationSeconds, 0);
    const sumPause = result.reconciledDialogue.clips.reduce((s, c) => s + c.pauseAfterSeconds, 0);
    const sumTrans = result.reconciledDialogue.scenes.reduce((s, sc) => s + sc.transitionSeconds, 0);
    const sumVis = result.reconciledDialogue.scenes.reduce((s, sc) => s + sc.visualOnlySeconds, 0);
    expect(result.reconciledDialogue.actualTotalDurationSeconds).toBeCloseTo(sumActual + sumPause + sumTrans + sumVis, 1);
    expect(result.summary.totalActualDurationSeconds).toBeCloseTo(result.reconciledDialogue.actualTotalDurationSeconds, 1);

    // every clip identity remains intact
    for (const clip of result.dialoguePlan.clips) {
      const canon = result.canonicalManifest.byClipId[clip.clipId];
      expect(canon).toBeDefined();
      expect(canon.sceneId).toBe(clip.sceneId);
      expect(canon.turnId).toBe(clip.turnId);
      expect(canon.speakerId).toBe(clip.speakerId);
      expect(canon.voiceSlot).toBe(clip.voiceSlot);
      expect(canon.spokenText).toBe(clip.spokenText);
    }

    // playback and audio boundaries agree
    for (const dlg of result.reconciledPlayback.dialogues) {
      const recon = result.reconciledDialogue.clips.find(c => c.clipId === dlg.audioClipId)!;
      expect(dlg.speech.startMs).toBe(Math.round(recon.actualStartTimeSeconds * 1000));
      expect(dlg.speech.endMs).toBe(Math.round(recon.actualEndTimeSeconds * 1000));
    }

    // captions remain within actual audio intervals
    for (const cue of result.reconciledCaptions.cues) {
      const recon = result.reconciledDialogue.clips.find(c => c.clipId === cue.clipId)!;
      expect(cue.startTimeSeconds).toBeGreaterThanOrEqual(recon.actualStartTimeSeconds - 0.001);
      expect(cue.endTimeSeconds).toBeLessThanOrEqual(recon.actualEndTimeSeconds + 0.001);
      expect(cue.endTimeSeconds).toBeLessThanOrEqual(recon.actualEndTimeSeconds + 0.001);
    }

    // all final invariants pass
    expect(result.valid).toBe(true);
    expect(result.findings.filter(f => f.severity === 'error').length).toBe(0);

    // deterministic repeated result metadata
    const secondRun = await buildDialogueProductionPlan(scenario, {
      synthesisBasePath: `${tmpRoot}/audio/dialogue2`,
      canonicalBasePath: `${tmpRoot}/audio/canonical2`,
    });
    expect(secondRun.success).toBe(true);
    if (secondRun.success && orchestrationResult.success) {
      // Summary should be deterministic except for file paths (which are same scenario, so same counts)
      expect(secondRun.result.summary.scenarioId).toBe(result.summary.scenarioId);
      expect(secondRun.result.summary.sceneCount).toBe(result.summary.sceneCount);
      expect(secondRun.result.summary.clipCount).toBe(result.summary.clipCount);
      expect(secondRun.result.summary.canonicalAudioCount).toBe(result.summary.canonicalAudioCount);
      expect(secondRun.result.summary.voiceProfileCount).toBe(result.summary.voiceProfileCount);
      expect(secondRun.result.summary.captionCueCount).toBe(result.summary.captionCueCount);
      // Durations should be identical because SAM is deterministic for same text
      expect(secondRun.result.summary.totalActualDurationSeconds).toBe(result.summary.totalActualDurationSeconds);
    }

    // no rendering occurs — we only did audio pipeline, no video files
    // Check that no mp4 or rendering artifacts were created
    const allFiles = fs.readdirSync(tmpRoot, { recursive: true } as any) as string[];
    const hasVideo = allFiles.some(f => typeof f === 'string' && (f.endsWith('.mp4') || f.endsWith('.mov')));
    expect(hasVideo).toBe(false);

    // Print evidence
    console.log('\n=== Phase 4E Integration Evidence ===');
    console.log(`Fixture: ${scenario.metadata.id}`);
    console.log(`Raw SAM: ${firstSourceMeta.sampleRate}Hz, ${firstSourceMeta.channels}ch, ${firstSourceMeta.codec}`);
    console.log(`Canonical: ${firstCanonicalMeta.sampleRate}Hz, ${firstCanonicalMeta.channels}ch, ${firstCanonicalMeta.codec}, isCanonical=${firstCanonicalMeta.isCanonical}`);
    console.log(`Example estimated vs actual: clip ${result.dialoguePlan.clips[0].clipId} est=${result.dialoguePlan.clips[0].durationSeconds}s actual=${result.reconciledDialogue.clips[0].actualDurationSeconds}s`);
    console.log(`Total reconciled: ${result.summary.totalActualDurationSeconds}s (est ${result.summary.totalEstimatedDurationSeconds}s, delta ${result.summary.totalDeltaSeconds}s)`);
    console.log(`Scenes: ${result.summary.sceneCount}, Turns: ${result.summary.turnCount}, Clips: ${result.summary.clipCount}`);
    console.log(`Canonical audio count: ${result.summary.canonicalAudioCount}, normalized: ${result.summary.normalizedClipCount}`);
    console.log(`Caption cues: ${result.summary.captionCueCount}`);
    console.log(`All identities align: true`);
    console.log('=== End Evidence ===\n');
  }, 120000);

  it('buildDialogueProductionResultFromArtifacts works from existing canonical', async () => {
    const scenario = getProgressMeetingScenario();
    const dialoguePlan = planDialogueAudio(scenario);
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error('visual failed');
    const visualPlan = visualRes.plan;
    const captionRes = compileScenarioCaptions(scenario, dialoguePlan);
    if (!captionRes.success) throw new Error('caption failed');
    const captionPlan = captionRes.plan;

    const voiceResolution = resolveDialogueAudioPlanVoices(dialoguePlan);
    const synth = new LocalDialogueSynthesizer();
    const sourceBase = `${tmpRoot}/audio/dialogue`;
    const synthManifest = await synthesizeDialoguePlan(dialoguePlan, voiceResolution, synth, { basePath: sourceBase });
    const canonicalBase = `${tmpRoot}/audio/canonical`;
    const canonicalManifest = await createCanonicalDialogueAudioManifest(synthManifest, {
      sourceBasePath: sourceBase,
      canonicalBasePath: canonicalBase,
    });

    const { reconciledDialogue, reconciledPlayback, reconciledCaptions } = reconcileTiming({
      scenario,
      dialoguePlan,
      canonicalManifest,
      visualPlan,
      captionPlan,
    });

    const built = buildDialogueProductionResultFromArtifacts({
      scenario,
      dialoguePlan,
      voiceResolution,
      synthesisManifest: synthManifest,
      canonicalManifest,
      reconciledDialogue,
      reconciledPlayback,
      reconciledCaptions,
      visualPlan,
      captionPlan,
    });

    expect(built.success).toBe(true);
    if (built.success) {
      expect(built.result.valid).toBe(true);
      expect(built.result.summary.clipCount).toBe(dialoguePlan.clipCount);
    }
  }, 60000);
});
