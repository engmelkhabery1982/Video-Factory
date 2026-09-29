/**
 * BuildTrack Video Factory - Phase 4D Actual Timing Reconciliation Tests
 *
 * Comprehensive unit tests covering:
 * - estimated vs actual differences
 * - longer/shorter audio
 * - turn order preserved
 * - pause policy preserved
 * - scene boundary recomputation
 * - total duration recomputation
 * - no overlaps
 * - determinism
 * - missing clip, identity mismatches, wrong voice/text, duplicate clips, invalid duration
 * - caption timing within actual speech
 * - playback/caption alignment
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  getProgressMeetingScenario,
  planDialogueAudio,
  compileScenarioVisualPlan,
  compileScenarioCaptions,
  compileScenarioPlayback,
  DEFAULT_DURATION_CONFIG,
  type Scenario,
  type DialogueAudioPlan,
} from '@buildtrack/core';
import {
  reconcileDialogueTiming,
  validateReconciliationInput,
} from '../packages/core/src/scenario/reconcile-dialogue-timing.js';
import { reconcilePlaybackTiming } from '../packages/core/src/scenario/reconcile-playback.js';
import { reconcileCaptionTiming } from '../packages/core/src/scenario/reconcile-captions.js';
import { reconcileTiming } from '../packages/core/src/scenario/reconcile-timing.js';
import { TimingReconciliationError } from '../packages/core/src/scenario/timing-reconciliation-types.js';
import { CANONICAL_AUDIO_FORMAT, type CanonicalDialogueAudioManifest, type AudioNormalizationResult } from '../packages/core/src/scenario/audio-validation-types.js';

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function makeFakeCanonicalManifest(
  dialoguePlan: DialogueAudioPlan,
  overrides?: {
    durationMap?: Record<string, number>;
    voiceSlotMap?: Record<string, string>;
    spokenTextMap?: Record<string, string>;
    sceneIdMap?: Record<string, string>;
    turnIdMap?: Record<string, string>;
    speakerIdMap?: Record<string, string>;
    duplicateClipId?: string;
    reorder?: boolean;
  }
): CanonicalDialogueAudioManifest {
  const results: AudioNormalizationResult[] = dialoguePlan.clips.map((clip, idx) => {
    const customDuration = overrides?.durationMap?.[clip.clipId];
    const duration = customDuration !== undefined ? customDuration : clip.durationSeconds + (idx % 2 === 0 ? 0.5 : -0.2);
    return {
      clipId: overrides?.duplicateClipId && idx === 1 ? overrides.duplicateClipId : clip.clipId,
      sceneId: overrides?.sceneIdMap?.[clip.clipId] ?? clip.sceneId,
      turnId: overrides?.turnIdMap?.[clip.clipId] ?? clip.turnId,
      speakerId: overrides?.speakerIdMap?.[clip.clipId] ?? clip.speakerId,
      voiceSlot: overrides?.voiceSlotMap?.[clip.clipId] ?? clip.voiceSlot,
      voiceProfileId: `voice-${clip.voiceSlot}`,
      spokenText: overrides?.spokenTextMap?.[clip.clipId] ?? clip.spokenText,
      sourcePath: `audio/dialogue/${clip.sceneId}/${clip.clipId}.wav`,
      sourceMetadata: {
        relativePath: `audio/dialogue/${clip.sceneId}/${clip.clipId}.wav`,
        container: 'wav',
        codec: 'pcm_s16le',
        sampleRate: 22050,
        channels: 1,
        bitDepth: 16,
        durationSeconds: duration,
        fileSizeBytes: 1000,
        isValid: true,
        isCanonical: false,
        probeEngine: 'wav-header',
      },
      canonicalPath: `audio/canonical/${clip.sceneId}/${clip.clipId}.wav`,
      canonicalMetadata: {
        relativePath: `audio/canonical/${clip.sceneId}/${clip.clipId}.wav`,
        container: 'wav',
        codec: 'pcm_s16le',
        sampleRate: 48000,
        channels: 1,
        bitDepth: 16,
        durationSeconds: duration,
        fileSizeBytes: 2000,
        isValid: true,
        isCanonical: true,
        probeEngine: 'wav-header',
      },
      wasNormalized: true,
      isCanonical: true,
      success: true,
    };
  });

  let finalResults = results;
  if (overrides?.reorder) {
    finalResults = [...results].reverse();
  }

  const byClipId: Record<string, AudioNormalizationResult> = {};
  for (const r of finalResults) {
    byClipId[r.clipId] = r;
  }

  return {
    schemaVersion: '1.0.0',
    scenarioId: dialoguePlan.scenarioId,
    language: dialoguePlan.language,
    clipCount: finalResults.length,
    successCount: finalResults.length,
    failureCount: 0,
    hadFailures: false,
    results: finalResults,
    byClipId,
    sourceBasePath: 'audio/dialogue',
    canonicalBasePath: 'audio/canonical',
    hadNormalization: true,
    normalizedAt: new Date().toISOString(),
  };
}

describe('Phase 4D — Actual Timing Reconciliation', () => {
  const scenario = getProgressMeetingScenario();
  const dialoguePlan = planDialogueAudio(scenario);
  const visualRes = compileScenarioVisualPlan(scenario);
  if (!visualRes.ok) throw new Error('visual plan failed');
  const visualPlan = visualRes.plan;
  const captionRes = compileScenarioCaptions(scenario, dialoguePlan);
  if (!captionRes.success) throw new Error('caption plan failed');
  const captionPlan = captionRes.plan;

  describe('Dialogue Timing Reconciliation', () => {
    it('1. estimated vs actual differences — actual duration replaces estimated', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan, {
        durationMap: { [dialoguePlan.clips[0].clipId]: 3.5 },
      });
      const reconciled = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const clip = reconciled.clips.find(c => c.clipId === dialoguePlan.clips[0].clipId)!;
      expect(clip.estimatedDurationSeconds).toBe(dialoguePlan.clips[0].durationSeconds);
      expect(clip.actualDurationSeconds).toBe(3.5);
      expect(clip.actualDurationSeconds).not.toBe(clip.estimatedDurationSeconds);
    });

    it('2. longer audio expands scene and total duration', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan, {
        durationMap: Object.fromEntries(dialoguePlan.clips.map(c => [c.clipId, c.durationSeconds + 1.0])),
      });
      const reconciled = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      expect(reconciled.actualTotalDurationSeconds).toBeGreaterThan(reconciled.estimatedTotalDurationSeconds);
      // Each scene should be longer
      for (const scene of reconciled.scenes) {
        expect(scene.actualDurationSeconds).toBeGreaterThanOrEqual(scene.estimatedDurationSeconds);
      }
    });

    it('3. shorter audio contracts scene and total duration', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan, {
        durationMap: Object.fromEntries(dialoguePlan.clips.map(c => [c.clipId, Math.max(0.1, c.durationSeconds - 0.5)])),
      });
      const reconciled = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      expect(reconciled.actualTotalDurationSeconds).toBeLessThan(reconciled.estimatedTotalDurationSeconds);
    });

    it('4. turn order preserved', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciled = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const originalOrder = dialoguePlan.clips.map(c => c.clipId);
      const reconciledOrder = reconciled.clips.map(c => c.clipId);
      expect(reconciledOrder).toEqual(originalOrder);
      // globalTurnIndex preserved
      for (let i = 0; i < reconciled.clips.length; i++) {
        expect(reconciled.clips[i].globalTurnIndex).toBe(dialoguePlan.clips[i].globalTurnIndex);
      }
    });

    it('5. pause policy preserved — actual clip + approved pause = next clip start', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciled = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      for (let i = 0; i < reconciled.clips.length - 1; i++) {
        const curr = reconciled.clips[i];
        const next = reconciled.clips[i + 1];
        // If same scene, next start = curr start + curr actualDuration + pauseAfter
        // If different scene, need to account for transition/visualOnly
        const currScene = reconciled.scenes.find(s => s.sceneId === curr.sceneId)!;
        const nextScene = reconciled.scenes.find(s => s.sceneId === next.sceneId)!;
        if (curr.sceneId === next.sceneId) {
          const expectedNextStart = curr.actualStartTimeSeconds + curr.actualDurationSeconds + curr.pauseAfterSeconds;
          expect(next.actualStartTimeSeconds).toBeCloseTo(expectedNextStart, 2);
        } else {
          // Next scene start should be >= curr end + pause + transition
          const expectedMin = curr.actualStartTimeSeconds + curr.actualTotalSpanSeconds;
          expect(nextScene.actualStartTimeSeconds).toBeGreaterThanOrEqual(expectedMin - 0.01);
        }
      }
    });

    it('6. scene boundary recomputation from actual turn timings', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciled = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      for (const scene of reconciled.scenes) {
        if (scene.clips.length === 0) continue;
        const firstClip = scene.clips[0];
        const lastClip = scene.clips[scene.clips.length - 1];
        expect(scene.actualStartTimeSeconds).toBe(firstClip.actualStartTimeSeconds);
        // Scene end should be last clip start + totalSpan + transition + visualOnly
        const expectedEnd = lastClip.actualStartTimeSeconds + lastClip.actualTotalSpanSeconds + scene.transitionSeconds + scene.visualOnlySeconds;
        expect(scene.actualEndTimeSeconds).toBeCloseTo(expectedEnd, 2);
      }
    });

    it('7. total duration recomputed from actual speech + preserved pauses + gaps', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciled = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const sumSpeech = reconciled.clips.reduce((s, c) => s + c.actualDurationSeconds, 0);
      const sumPause = reconciled.clips.reduce((s, c) => s + c.pauseAfterSeconds, 0);
      const sumTransition = reconciled.scenes.reduce((s, sc) => s + sc.transitionSeconds, 0);
      const sumVisualOnly = reconciled.scenes.reduce((s, sc) => s + sc.visualOnlySeconds, 0);
      const expectedTotal = sumSpeech + sumPause + sumTransition + sumVisualOnly;
      expect(reconciled.actualTotalDurationSeconds).toBeCloseTo(expectedTotal, 2);
      expect(reconciled.totalSpeechDurationSeconds).toBeCloseTo(sumSpeech, 2);
      expect(reconciled.totalPauseDurationSeconds).toBeCloseTo(sumPause, 2);
    });

    it('8. no overlaps in reconciled clips', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciled = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      for (let i = 0; i < reconciled.clips.length - 1; i++) {
        const curr = reconciled.clips[i];
        const next = reconciled.clips[i + 1];
        expect(curr.actualStartTimeSeconds + curr.actualTotalSpanSeconds).toBeLessThanOrEqual(next.actualStartTimeSeconds + 0.001);
      }
    });

    it('9. no overlaps in reconciled scenes', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciled = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      for (let i = 0; i < reconciled.scenes.length - 1; i++) {
        const curr = reconciled.scenes[i];
        const next = reconciled.scenes[i + 1];
        expect(curr.actualEndTimeSeconds).toBeLessThanOrEqual(next.actualStartTimeSeconds + 0.001);
      }
    });

    it('10. determinism — same inputs produce identical outputs', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const r1 = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const r2 = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      expect(r1).toEqual(r2);
      // Also check that JSON stringify is identical (deterministic)
      expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    });

    it('11. preserves identities — scenario/project/language/targetFormat/scene/turn/clip/voiceSlot/spokenText', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciled = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      expect(reconciled.scenarioId).toBe(dialoguePlan.scenarioId);
      expect(reconciled.projectId).toBe(dialoguePlan.projectId);
      expect(reconciled.language).toBe(dialoguePlan.language);
      expect(reconciled.targetFormat).toBe(dialoguePlan.targetFormat);
      for (let i = 0; i < reconciled.clips.length; i++) {
        const orig = dialoguePlan.clips[i];
        const rec = reconciled.clips[i];
        expect(rec.clipId).toBe(orig.clipId);
        expect(rec.sceneId).toBe(orig.sceneId);
        expect(rec.turnId).toBe(orig.turnId);
        expect(rec.speakerId).toBe(orig.speakerId);
        expect(rec.voiceSlot).toBe(orig.voiceSlot);
        expect(rec.spokenText).toBe(orig.spokenText);
      }
    });
  });

  describe('Error handling', () => {
    it('12. missing canonical clip', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      // Remove one clip
      const missingClipId = manifest.results[0].clipId;
      const filtered = manifest.results.filter(r => r.clipId !== missingClipId);
      const badManifest: CanonicalDialogueAudioManifest = {
        ...manifest,
        results: filtered,
        byClipId: Object.fromEntries(filtered.map(r => [r.clipId, r])),
        clipCount: filtered.length,
      };
      expect(() => reconcileDialogueTiming(scenario, dialoguePlan, badManifest)).toThrow();
      try {
        reconcileDialogueTiming(scenario, dialoguePlan, badManifest);
      } catch (e) {
        expect((e as TimingReconciliationError).code).toBe('MISSING_CANONICAL_CLIP');
      }
    });

    it('13. identity mismatch — scenario ID', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const badScenario = clone(scenario);
      (badScenario as any).metadata.id = 'different-scenario-id';
      expect(() => reconcileDialogueTiming(badScenario as any, dialoguePlan, manifest)).toThrow();
      try {
        reconcileDialogueTiming(badScenario as any, dialoguePlan, manifest);
      } catch (e) {
        expect((e as TimingReconciliationError).code).toBe('IDENTITY_MISMATCH');
      }
    });

    it('14. identity mismatch — scene IDs', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const badDialoguePlan = clone(dialoguePlan);
      badDialoguePlan.scenes[0].sceneId = 'foreign-scene';
      expect(() => reconcileDialogueTiming(scenario, badDialoguePlan as any, manifest)).toThrow();
    });

    it('15. voiceSlot mismatch', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan, {
        voiceSlotMap: { [dialoguePlan.clips[0].clipId]: 'foreign-voice-slot' },
      });
      expect(() => reconcileDialogueTiming(scenario, dialoguePlan, manifest)).toThrow();
      try {
        reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      } catch (e) {
        expect((e as TimingReconciliationError).code).toBe('VOICE_MISMATCH');
      }
    });

    it('16. spoken text mismatch', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan, {
        spokenTextMap: { [dialoguePlan.clips[0].clipId]: 'different spoken text entirely' },
      });
      expect(() => reconcileDialogueTiming(scenario, dialoguePlan, manifest)).toThrow();
      try {
        reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      } catch (e) {
        expect((e as TimingReconciliationError).code).toBe('SPOKEN_TEXT_MISMATCH');
      }
    });

    it('17. duplicate clip identity', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan, {
        duplicateClipId: dialoguePlan.clips[0].clipId,
      });
      expect(() => reconcileDialogueTiming(scenario, dialoguePlan, manifest)).toThrow();
      try {
        reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      } catch (e) {
        expect((e as TimingReconciliationError).code).toBe('DUPLICATE_CLIP_ID');
      }
    });

    it('18. invalid duration — zero', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan, {
        durationMap: { [dialoguePlan.clips[0].clipId]: 0 },
      });
      expect(() => reconcileDialogueTiming(scenario, dialoguePlan, manifest)).toThrow();
      try {
        reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      } catch (e) {
        expect((e as TimingReconciliationError).code).toBe('ZERO_DURATION');
      }
    });

    it('19. invalid duration — negative', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan, {
        durationMap: { [dialoguePlan.clips[0].clipId]: -1.5 },
      });
      expect(() => reconcileDialogueTiming(scenario, dialoguePlan, manifest)).toThrow();
      try {
        reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      } catch (e) {
        expect((e as TimingReconciliationError).code).toMatch(/ZERO_DURATION|INVALID_DURATION/);
      }
    });

    it('20. ordering mismatch', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan, { reorder: true });
      expect(() => reconcileDialogueTiming(scenario, dialoguePlan, manifest)).toThrow();
      try {
        reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      } catch (e) {
        expect((e as TimingReconciliationError).code).toBe('ORDERING_MISMATCH');
      }
    });

    it('21. speaker mismatch', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan, {
        speakerIdMap: { [dialoguePlan.clips[0].clipId]: 'foreign-speaker' },
      });
      expect(() => reconcileDialogueTiming(scenario, dialoguePlan, manifest)).toThrow();
      try {
        reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      } catch (e) {
        expect((e as TimingReconciliationError).code).toBe('SPEAKER_MISMATCH');
      }
    });

    it('22. turn mismatch', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan, {
        turnIdMap: { [dialoguePlan.clips[0].clipId]: 'foreign-turn' },
      });
      expect(() => reconcileDialogueTiming(scenario, dialoguePlan, manifest)).toThrow();
      try {
        reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      } catch (e) {
        expect((e as TimingReconciliationError).code).toBe('TURN_MISMATCH');
      }
    });
  });

  describe('Playback reconciliation', () => {
    it('23. playback reconciled timing matches actual audio boundaries', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciledDialogue = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const reconciledPlayback = reconcilePlaybackTiming(scenario, visualPlan, reconciledDialogue);

      // Every dialogue speech interval should match reconciled clip actual timing
      for (const dlg of reconciledPlayback.dialogues) {
        const clip = reconciledDialogue.clips.find(c => c.clipId === dlg.audioClipId)!;
        expect(dlg.speech.startMs).toBe(Math.round(clip.actualStartTimeSeconds * 1000));
        expect(dlg.speech.endMs).toBe(Math.round(clip.actualEndTimeSeconds * 1000));
        expect(dlg.actualDurationSeconds).toBe(clip.actualDurationSeconds);
      }

      // Scene intervals match reconciled dialogue scenes
      for (let i = 0; i < reconciledPlayback.scenes.length; i++) {
        const pbScene = reconciledPlayback.scenes[i];
        const dlgScene = reconciledDialogue.scenes[i];
        expect(pbScene.interval.startMs).toBe(Math.round(dlgScene.actualStartTimeSeconds * 1000));
        expect(pbScene.interval.endMs).toBe(Math.round(dlgScene.actualEndTimeSeconds * 1000));
      }
    });

    it('24. playback preserves identities and no overlaps', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciledDialogue = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const reconciledPlayback = reconcilePlaybackTiming(scenario, visualPlan, reconciledDialogue);

      expect(reconciledPlayback.scenarioId).toBe(scenario.metadata.id);
      expect(reconciledPlayback.dialogues.length).toBe(dialoguePlan.clipCount);

      // No overlaps
      for (let i = 0; i < reconciledPlayback.dialogues.length - 1; i++) {
        const curr = reconciledPlayback.dialogues[i];
        const next = reconciledPlayback.dialogues[i + 1];
        expect(curr.turnSpan.endMs).toBeLessThanOrEqual(next.turnSpan.startMs);
      }
    });

    it('25. playback determinism', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciledDialogue = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const pb1 = reconcilePlaybackTiming(scenario, visualPlan, reconciledDialogue);
      const pb2 = reconcilePlaybackTiming(scenario, visualPlan, reconciledDialogue);
      expect(pb1).toEqual(pb2);
    });
  });

  describe('Caption reconciliation', () => {
    it('26. caption timing within actual speech interval', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciledDialogue = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const reconciledCaptions = reconcileCaptionTiming(scenario, reconciledDialogue, captionPlan);

      for (const cue of reconciledCaptions.cues) {
        const clip = reconciledDialogue.clips.find(c => c.clipId === cue.clipId)!;
        expect(cue.startTimeSeconds).toBeGreaterThanOrEqual(clip.actualStartTimeSeconds - 0.001);
        expect(cue.endTimeSeconds).toBeLessThanOrEqual(clip.actualEndTimeSeconds + 0.001);
      }
    });

    it('27. caption exact text unchanged', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciledDialogue = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const reconciledCaptions = reconcileCaptionTiming(scenario, reconciledDialogue, captionPlan);

      // Group by turnId and compare concatenated text
      for (const clip of reconciledDialogue.clips) {
        const origCues = captionPlan.cues.filter(c => c.turnId === clip.turnId);
        const recCues = reconciledCaptions.cues.filter(c => c.turnId === clip.turnId);
        if (origCues.length === 0) continue;
        const origText = origCues.map(c => c.text).join(' ');
        const recText = recCues.map(c => c.text).join(' ');
        expect(recText).toBe(origText);
      }
    });

    it('28. caption cue ordering preserved', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciledDialogue = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const reconciledCaptions = reconcileCaptionTiming(scenario, reconciledDialogue, captionPlan);

      // Within each turn, cues should be ordered by start time and preserve original ID order
      for (const clip of reconciledDialogue.clips) {
        const origCues = captionPlan.cues.filter(c => c.turnId === clip.turnId).sort((a, b) => a.startSeconds - b.startSeconds);
        const recCues = reconciledCaptions.cues.filter(c => c.turnId === clip.turnId).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
        if (origCues.length === 0) continue;
        expect(recCues.map(c => c.id)).toEqual(origCues.map(c => c.id));
      }
    });

    it('29. final caption end not exceed actual turn end', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciledDialogue = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const reconciledCaptions = reconcileCaptionTiming(scenario, reconciledDialogue, captionPlan);

      for (const clip of reconciledDialogue.clips) {
        const recCues = reconciledCaptions.cues.filter(c => c.turnId === clip.turnId).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
        if (recCues.length === 0) continue;
        const last = recCues[recCues.length - 1];
        expect(last.endTimeSeconds).toBeLessThanOrEqual(clip.actualEndTimeSeconds + 0.001);
        // And last cue ends exactly at actual end (within rounding)
        expect(last.endTimeSeconds).toBeCloseTo(clip.actualEndTimeSeconds, 1);
      }
    });

    it('30. no cross-turn caption', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciledDialogue = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const reconciledCaptions = reconcileCaptionTiming(scenario, reconciledDialogue, captionPlan);

      for (const cue of reconciledCaptions.cues) {
        const clip = reconciledDialogue.clips.find(c => c.clipId === cue.clipId)!;
        // Cue should not cross into next clip's interval
        const clipEndWithPause = clip.actualStartTimeSeconds + clip.actualTotalSpanSeconds;
        expect(cue.endTimeSeconds).toBeLessThanOrEqual(clip.actualEndTimeSeconds + 0.001);
        expect(cue.startTimeSeconds).toBeGreaterThanOrEqual(clip.actualStartTimeSeconds - 0.001);
      }
    });

    it('31. caption determinism', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const reconciledDialogue = reconcileDialogueTiming(scenario, dialoguePlan, manifest);
      const cap1 = reconcileCaptionTiming(scenario, reconciledDialogue, captionPlan);
      const cap2 = reconcileCaptionTiming(scenario, reconciledDialogue, captionPlan);
      expect(cap1).toEqual(cap2);
    });

    it('32. full pipeline determinism', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const out1 = reconcileTiming({
        scenario,
        dialoguePlan,
        canonicalManifest: manifest,
        visualPlan,
        captionPlan,
      });
      const out2 = reconcileTiming({
        scenario,
        dialoguePlan,
        canonicalManifest: manifest,
        visualPlan,
        captionPlan,
      });
      expect(out1).toEqual(out2);
    });

    it('33. playback and captions same identity — scenario/clip/turn', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const { reconciledDialogue, reconciledPlayback, reconciledCaptions } = reconcileTiming({
        scenario,
        dialoguePlan,
        canonicalManifest: manifest,
        visualPlan,
        captionPlan,
      });

      expect(reconciledPlayback.scenarioId).toBe(reconciledDialogue.scenarioId);
      expect(reconciledCaptions.scenarioId).toBe(reconciledDialogue.scenarioId);

      // All playback dialogues have matching clips in reconciled dialogue
      for (const dlg of reconciledPlayback.dialogues) {
        expect(reconciledDialogue.clips.some(c => c.clipId === dlg.audioClipId)).toBe(true);
      }

      // All caption cues have matching clips
      for (const cue of reconciledCaptions.cues) {
        expect(reconciledDialogue.clips.some(c => c.clipId === cue.clipId)).toBe(true);
      }
    });

    it('34. playback and captions aligned — caption within playback speech', () => {
      const manifest = makeFakeCanonicalManifest(dialoguePlan);
      const { reconciledDialogue, reconciledPlayback, reconciledCaptions } = reconcileTiming({
        scenario,
        dialoguePlan,
        canonicalManifest: manifest,
        visualPlan,
        captionPlan,
      });

      const playbackByTurn = new Map(reconciledPlayback.dialogues.map(d => [d.turnId, d]));
      for (const cue of reconciledCaptions.cues) {
        const pb = playbackByTurn.get(cue.turnId);
        if (!pb) continue;
        expect(cue.startTimeSeconds * 1000).toBeGreaterThanOrEqual(pb.speech.startMs - 1);
        expect(cue.endTimeSeconds * 1000).toBeLessThanOrEqual(pb.speech.endMs + 1);
      }
    });
  });
});
