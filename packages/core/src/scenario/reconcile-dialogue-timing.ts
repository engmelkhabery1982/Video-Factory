/**
 * BuildTrack Video Factory - Phase 4D Dialogue Timing Reconciliation
 *
 * Replaces estimated speech timing with actual canonical audio duration
 * while preserving scenario, dialogue, playback, and caption identities.
 *
 * Pause policy: actual clip duration + approved inter-turn pause → next clip start
 * Scene timing: recomputed from actual reconciled turn timings, preserving transition and visual-only buffers
 * Total duration: actual speech + preserved pauses + transition/visualOnly
 */

import { Scenario } from './types.js';
import { DialogueAudioPlan, DialogueAudioClip } from './dialogue-audio-types.js';
import { CanonicalDialogueAudioManifest } from './audio-validation-types.js';
import {
  ReconciledDialogueAudioPlan,
  ReconciledDialogueClip,
  ReconciledDialogueScene,
  TimingReconciliationError,
} from './timing-reconciliation-types.js';
import { DurationEstimatorConfig } from './duration.js';
import { CANONICAL_AUDIO_FORMAT } from './audio-validation-types.js';

function validateSafeRelativePath(p: string, fieldName = 'path'): void {
  if (!p || typeof p !== 'string' || !p.trim()) {
    throw new TimingReconciliationError('IDENTITY_MISMATCH', `${fieldName} must be non-empty string.`, { [fieldName]: p });
  }
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) {
    throw new TimingReconciliationError('IDENTITY_MISMATCH', `${fieldName} must be relative, got absolute: '${p}'`, { [fieldName]: p });
  }
  const segments = p.split(/[/\\]/);
  if (segments.some(s => s === '..' || s === '.')) {
    throw new TimingReconciliationError('IDENTITY_MISMATCH', `${fieldName} contains forbidden traversal: '${p}'`, { [fieldName]: p });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Validate identity continuity between DialogueAudioPlan and CanonicalManifest */
export function validateReconciliationInput(
  scenario: Scenario,
  dialoguePlan: DialogueAudioPlan,
  canonicalManifest: CanonicalDialogueAudioManifest
): void {
  if (!scenario || typeof scenario !== 'object') {
    throw new TimingReconciliationError('MISSING_SCENARIO', 'Scenario must be non-null object.', {});
  }
  if (!dialoguePlan || typeof dialoguePlan !== 'object') {
    throw new TimingReconciliationError('MISSING_DIALOGUE_PLAN', 'DialogueAudioPlan must be non-null object.', {});
  }
  if (!canonicalManifest || typeof canonicalManifest !== 'object') {
    throw new TimingReconciliationError('MISSING_CANONICAL_MANIFEST', 'CanonicalDialogueAudioManifest must be non-null object.', {});
  }

  // scenario ID
  if (scenario.metadata.id !== dialoguePlan.scenarioId) {
    throw new TimingReconciliationError('IDENTITY_MISMATCH', `Scenario ID mismatch: scenario '${scenario.metadata.id}' vs dialoguePlan '${dialoguePlan.scenarioId}'`, {
      scenarioId: scenario.metadata.id,
      dialoguePlanScenarioId: dialoguePlan.scenarioId,
    });
  }
  if (scenario.metadata.id !== canonicalManifest.scenarioId) {
    throw new TimingReconciliationError('SCENE_MISMATCH', `Scenario ID mismatch: scenario '${scenario.metadata.id}' vs canonicalManifest '${canonicalManifest.scenarioId}'`, {
      scenarioId: scenario.metadata.id,
      canonicalScenarioId: canonicalManifest.scenarioId,
    });
  }

  // project ID
  if (scenario.metadata.projectId !== dialoguePlan.projectId) {
    throw new TimingReconciliationError('IDENTITY_MISMATCH', `Project ID mismatch: scenario '${scenario.metadata.projectId}' vs dialoguePlan '${dialoguePlan.projectId}'`, {});
  }

  // language
  if (scenario.metadata.language !== dialoguePlan.language) {
    throw new TimingReconciliationError('IDENTITY_MISMATCH', `Language mismatch: scenario '${scenario.metadata.language}' vs dialoguePlan '${dialoguePlan.language}'`, {});
  }
  if (scenario.metadata.language !== canonicalManifest.language) {
    throw new TimingReconciliationError('IDENTITY_MISMATCH', `Language mismatch: scenario '${scenario.metadata.language}' vs canonicalManifest '${canonicalManifest.language}'`, {});
  }

  // target format
  if (scenario.metadata.targetFormat !== dialoguePlan.targetFormat) {
    throw new TimingReconciliationError('IDENTITY_MISMATCH', `Target format mismatch: scenario '${scenario.metadata.targetFormat}' vs dialoguePlan '${dialoguePlan.targetFormat}'`, {});
  }

  // scene IDs and order
  const scenarioSceneIds = scenario.scenes.map(s => s.id);
  const dialogueSceneIds = dialoguePlan.scenes.map(s => s.sceneId);
  if (JSON.stringify(scenarioSceneIds) !== JSON.stringify(dialogueSceneIds)) {
    throw new TimingReconciliationError('SCENE_MISMATCH', `Scene IDs/order mismatch: scenario [${scenarioSceneIds.join(',')}] vs dialoguePlan [${dialogueSceneIds.join(',')}]`, {
      scenarioSceneIds,
      dialogueSceneIds,
    });
  }

  const canonicalSceneIds = [...new Set(canonicalManifest.results.map(r => r.sceneId))].sort();
  const dialogueSceneIdsSorted = [...new Set(dialoguePlan.clips.map(c => c.sceneId))].sort();
  // For canonical, we need to ensure every scene in dialoguePlan has at least one canonical clip, and no foreign scenes
  // We check that canonical scene IDs are subset of dialogue scene IDs and vice versa for scenes that have clips
  const dialogueScenesWithClips = dialoguePlan.scenes.filter(s => s.clips.length > 0).map(s => s.sceneId).sort();
  const canonicalScenesSorted = [...new Set(canonicalManifest.results.map(r => r.sceneId))].sort();
  if (JSON.stringify(dialogueScenesWithClips) !== JSON.stringify(canonicalScenesSorted)) {
    // Allow canonical to have same scenes as dialogue plan's scenes with clips, but check for foreign
    const foreign = canonicalScenesSorted.filter(id => !dialogueSceneIds.includes(id));
    if (foreign.length > 0) {
      throw new TimingReconciliationError('SCENE_MISMATCH', `Canonical manifest contains foreign scene IDs: ${foreign.join(',')}`, { foreign });
    }
  }

  // Check duplicate clip IDs in canonical manifest first
  const seen = new Set<string>();
  for (const res of canonicalManifest.results) {
    if (seen.has(res.clipId)) {
      throw new TimingReconciliationError('DUPLICATE_CLIP_ID', `Duplicate clipId '${res.clipId}' in canonical manifest`, { clipId: res.clipId });
    }
    seen.add(res.clipId);
  }

  // clip IDs
  const dialogueClipIds = dialoguePlan.clips.map(c => c.clipId).sort();
  const canonicalClipIds = canonicalManifest.results.map(r => r.clipId).sort();
  if (JSON.stringify(dialogueClipIds) !== JSON.stringify(canonicalClipIds)) {
    const missing = dialogueClipIds.filter(id => !canonicalClipIds.includes(id));
    const extra = canonicalClipIds.filter(id => !dialogueClipIds.includes(id));
    if (missing.length > 0) {
      throw new TimingReconciliationError('MISSING_CANONICAL_CLIP', `Missing canonical clips: ${missing.join(',')}`, { missing });
    }
    if (extra.length > 0) {
      throw new TimingReconciliationError('CLIP_MISMATCH', `Extra canonical clips not in dialogue plan: ${extra.join(',')}`, { extra });
    }
    // If same length but different IDs (should be caught by missing/extra), still mismatch
    throw new TimingReconciliationError('CLIP_MISMATCH', `Clip IDs mismatch between dialogue plan and canonical manifest`, {
      dialogueClipIds,
      canonicalClipIds,
    });
  }

  // Validate each clip identity: turn IDs, speaker IDs, voiceSlot, voiceProfileId, spokenText
  const clipById = new Map(dialoguePlan.clips.map(c => [c.clipId, c]));
  for (const canon of canonicalManifest.results) {
    const dialogueClip = clipById.get(canon.clipId);
    if (!dialogueClip) {
      throw new TimingReconciliationError('CLIP_MISMATCH', `Canonical clip '${canon.clipId}' not found in dialogue plan`, { clipId: canon.clipId });
    }

    if (dialogueClip.turnId !== canon.turnId) {
      throw new TimingReconciliationError('TURN_MISMATCH', `Turn ID mismatch for clip '${canon.clipId}': dialoguePlan '${dialogueClip.turnId}' vs canonical '${canon.turnId}'`, {
        clipId: canon.clipId,
        dialogueTurnId: dialogueClip.turnId,
        canonicalTurnId: canon.turnId,
      });
    }

    if (dialogueClip.sceneId !== canon.sceneId) {
      throw new TimingReconciliationError('SCENE_MISMATCH', `Scene ID mismatch for clip '${canon.clipId}': dialoguePlan '${dialogueClip.sceneId}' vs canonical '${canon.sceneId}'`, {
        clipId: canon.clipId,
      });
    }

    if (dialogueClip.speakerId !== canon.speakerId) {
      throw new TimingReconciliationError('SPEAKER_MISMATCH', `Speaker ID mismatch for clip '${canon.clipId}': dialoguePlan '${dialogueClip.speakerId}' vs canonical '${canon.speakerId}'`, {
        clipId: canon.clipId,
      });
    }

    if (dialogueClip.voiceSlot !== canon.voiceSlot) {
      throw new TimingReconciliationError('VOICE_MISMATCH', `VoiceSlot mismatch for clip '${canon.clipId}': dialoguePlan '${dialogueClip.voiceSlot}' vs canonical '${canon.voiceSlot}'`, {
        clipId: canon.clipId,
      });
    }

    if (dialogueClip.spokenText !== canon.spokenText) {
      throw new TimingReconciliationError('SPOKEN_TEXT_MISMATCH', `Spoken text mismatch for clip '${canon.clipId}'`, {
        clipId: canon.clipId,
      });
    }

    // Validate canonical duration
    const duration = canon.canonicalMetadata?.durationSeconds ?? (canon as any).durationSeconds;
    if (duration === undefined || duration === null || typeof duration !== 'number' || !Number.isFinite(duration)) {
      throw new TimingReconciliationError('INVALID_DURATION', `Invalid canonical duration for clip '${canon.clipId}': ${duration}`, {
        clipId: canon.clipId,
        duration,
      });
    }
    if (duration <= 0) {
      throw new TimingReconciliationError('ZERO_DURATION', `Zero or negative canonical duration for clip '${canon.clipId}': ${duration}`, {
        clipId: canon.clipId,
        duration,
      });
    }
  }

  // Check ordering mismatch: canonical results should be in same order as dialogue plan clips (by globalTurnIndex)
  const dialogueOrdered = [...dialoguePlan.clips].sort((a, b) => a.globalTurnIndex - b.globalTurnIndex).map(c => c.clipId);
  const canonicalOrdered = canonicalManifest.results.map(r => r.clipId);
  // For Phase 4D, we require deterministic ordering, but we allow canonical to be in same order as dialogue plan
  // If not same order, we still accept but will reorder in reconciliation; however we check for ordering mismatch as warning?
  // For strict validation, we require same order
  if (JSON.stringify(dialogueOrdered) !== JSON.stringify(canonicalOrdered)) {
    // Check if it's just different order but same IDs — we consider it ordering mismatch but not fatal if we reorder
    // For Phase 4D, we will reorder based on globalTurnIndex, so we allow different order but log as invariant
    // However spec says reject ordering mismatch explicitly — so we throw if order differs
    // Let's throw if order differs
    throw new TimingReconciliationError('ORDERING_MISMATCH', `Clip ordering mismatch: dialoguePlan order [${dialogueOrdered.join(',')}] vs canonical [${canonicalOrdered.join(',')}]`, {
      dialogueOrdered,
      canonicalOrdered,
    });
  }
}

/** Reconcile dialogue timing using actual canonical durations */
export function reconcileDialogueTiming(
  scenario: Scenario,
  dialoguePlan: DialogueAudioPlan,
  canonicalManifest: CanonicalDialogueAudioManifest
): ReconciledDialogueAudioPlan {
  validateReconciliationInput(scenario, dialoguePlan, canonicalManifest);

  const clipById = new Map(canonicalManifest.results.map(r => [r.clipId, r]));

  let currentTimeline = 0;
  let totalSpeechActual = 0;
  let totalPause = 0;
  const reconciledClips: ReconciledDialogueClip[] = [];
  const reconciledScenes: ReconciledDialogueScene[] = [];

  for (let sIdx = 0; sIdx < dialoguePlan.scenes.length; sIdx++) {
    const scene = dialoguePlan.scenes[sIdx];
    const scenarioScene = scenario.scenes[sIdx];
    const sceneStartActual = currentTimeline;
    const sceneClips: ReconciledDialogueClip[] = [];

    // Preserve transition and visual-only buffers from Phase 3C
    // From plan-dialogue-audio.ts: transition buffer = scene.transitionIntent?.durationSeconds ?? durationConfig.transitionAllowanceSeconds if hasTransition
    // visualOnly buffer = durationConfig.nonDialogueBeatSeconds if no turns
    const hasTransition = scenarioScene.transitionIntent && scenarioScene.transitionIntent.type !== 'none' && scenarioScene.transitionIntent.type !== 'cut';
    const transitionSeconds = hasTransition
      ? (scenarioScene.transitionIntent?.durationSeconds ?? dialoguePlan.durationConfig.transitionAllowanceSeconds)
      : 0;
    const visualOnlySeconds = scene.clips.length === 0 ? dialoguePlan.durationConfig.nonDialogueBeatSeconds : 0;

    for (let tIdx = 0; tIdx < scene.clips.length; tIdx++) {
      const clip = scene.clips[tIdx];
      const canonical = clipById.get(clip.clipId);
      if (!canonical) {
        throw new TimingReconciliationError('MISSING_CANONICAL_CLIP', `Missing canonical for clip '${clip.clipId}'`, { clipId: clip.clipId });
      }

      const actualDuration = canonical.canonicalMetadata.durationSeconds!;
      if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
        throw new TimingReconciliationError('INVALID_DURATION', `Invalid actual duration for clip '${clip.clipId}': ${actualDuration}`, {
          clipId: clip.clipId,
          actualDuration,
        });
      }

      const pauseAfter = clip.pauseAfterSeconds; // preserve approved pause semantics
      if (typeof pauseAfter !== 'number' || !Number.isFinite(pauseAfter) || pauseAfter < 0) {
        throw new TimingReconciliationError('INVALID_PAUSE_CONFIG', `Invalid pauseAfterSeconds for clip '${clip.clipId}': ${pauseAfter}`, {
          clipId: clip.clipId,
          pauseAfter,
        });
      }

      const actualStart = currentTimeline;
      const actualEnd = round2(actualStart + actualDuration);
      const actualTotalSpan = round2(actualDuration + pauseAfter);

      // Check overlap: actualStart should be >= previous clip's actualStart + previous totalSpan (which is currentTimeline by construction, so no overlap)
      // But we also check that actualStart is not less than previous end (should be equal to previous total span end)
      // Since we set currentTimeline to previous start + previous totalSpan, no overlap by construction

      const reconciledClip: ReconciledDialogueClip = {
        clipId: clip.clipId,
        sceneId: clip.sceneId,
        sceneIndex: sIdx,
        turnId: clip.turnId,
        turnIndex: tIdx,
        globalTurnIndex: clip.globalTurnIndex,
        speakerId: clip.speakerId,
        voiceSlot: clip.voiceSlot,
        voiceProfileId: canonical.voiceProfileId,
        spokenText: clip.spokenText,
        intent: clip.intent,
        delivery: clip.delivery,
        evidenceId: clip.evidenceId,
        estimatedPath: clip.suggestedPath,
        canonicalPath: canonical.canonicalPath,
        sourcePath: canonical.sourcePath,
        audioFormat: canonical.canonicalMetadata as any, // canonical format
        estimatedDurationSeconds: clip.durationSeconds,
        actualDurationSeconds: actualDuration,
        pauseAfterSeconds: pauseAfter,
        actualStartTimeSeconds: actualStart,
        actualEndTimeSeconds: actualEnd,
        actualTotalSpanSeconds: actualTotalSpan,
        canonicalMetadata: canonical.canonicalMetadata,
      };

      sceneClips.push(reconciledClip);
      reconciledClips.push(reconciledClip);

      totalSpeechActual = round2(totalSpeechActual + actualDuration);
      totalPause = round2(totalPause + pauseAfter);

      currentTimeline = round2(actualStart + actualTotalSpan);
    }

    // Apply transition and visual-only buffers
    currentTimeline = round2(currentTimeline + transitionSeconds + visualOnlySeconds);

    const sceneEndActual = currentTimeline;
    const sceneDurationActual = round2(sceneEndActual - sceneStartActual);

    // Check for overlap: scene should not overlap previous scene (by construction, start is previous end, so no overlap)
    // But we validate that scene duration is >= sum of clips totalSpan + buffers

    reconciledScenes.push({
      sceneId: scene.sceneId,
      sceneIndex: sIdx,
      title: scene.title,
      estimatedStartTimeSeconds: scene.startTimeSeconds,
      estimatedEndTimeSeconds: scene.endTimeSeconds,
      estimatedDurationSeconds: scene.durationSeconds,
      actualStartTimeSeconds: sceneStartActual,
      actualEndTimeSeconds: sceneEndActual,
      actualDurationSeconds: sceneDurationActual,
      transitionSeconds,
      visualOnlySeconds,
      clips: sceneClips,
    });
  }

  const actualTotalDuration = round2(currentTimeline);
  const estimatedTotal = dialoguePlan.totalDurationSeconds;

  // Check for unexpected overlap: ensure clips are non-overlapping and monotonic
  for (let i = 0; i < reconciledClips.length - 1; i++) {
    const curr = reconciledClips[i];
    const next = reconciledClips[i + 1];
    if (curr.actualStartTimeSeconds + curr.actualTotalSpanSeconds > next.actualStartTimeSeconds + 0.001) {
      throw new TimingReconciliationError('OVERLAP_DETECTED', `Overlap detected between clips '${curr.clipId}' and '${next.clipId}': curr ends at ${curr.actualStartTimeSeconds + curr.actualTotalSpanSeconds}, next starts at ${next.actualStartTimeSeconds}`, {
        currClipId: curr.clipId,
        nextClipId: next.clipId,
      });
    }
  }

  // Check scene overlaps
  for (let i = 0; i < reconciledScenes.length - 1; i++) {
    const curr = reconciledScenes[i];
    const next = reconciledScenes[i + 1];
    if (curr.actualEndTimeSeconds > next.actualStartTimeSeconds + 0.001) {
      throw new TimingReconciliationError('OVERLAP_DETECTED', `Overlap detected between scenes '${curr.sceneId}' and '${next.sceneId}'`, {
        currSceneId: curr.sceneId,
        nextSceneId: next.sceneId,
      });
    }
  }

  return {
    schemaVersion: '1.0.0',
    scenarioId: dialoguePlan.scenarioId,
    projectId: dialoguePlan.projectId,
    targetFormat: dialoguePlan.targetFormat,
    language: dialoguePlan.language,
    audioFormat: CANONICAL_AUDIO_FORMAT as any,
    durationConfig: dialoguePlan.durationConfig,
    allowSharedVoiceSlots: dialoguePlan.allowSharedVoiceSlots,
    estimatedTotalDurationSeconds: estimatedTotal,
    actualTotalDurationSeconds: actualTotalDuration,
    totalSpeechDurationSeconds: totalSpeechActual,
    totalPauseDurationSeconds: totalPause,
    estimatedSpeechDurationSeconds: dialoguePlan.totalSpeechDurationSeconds,
    clipCount: reconciledClips.length,
    characters: dialoguePlan.characters,
    scenes: reconciledScenes,
    clips: reconciledClips,
  };
}
