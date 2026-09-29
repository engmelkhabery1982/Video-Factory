/**
 * BuildTrack Video Factory - Phase 4D Caption Reconciliation
 *
 * Recompute cue timing from actual speech intervals.
 * - Exact text unchanged
 * - Cue ordering preserved
 * - Cues within source turn's actual interval
 * - Tile/cover per Phase 3E policy
 * - Final caption end not exceed actual turn end
 * - No cross-turn caption
 * - Reuse Phase 3E segmentation where possible
 */

import { Scenario } from './types.js';
import { ReconciledDialogueAudioPlan, ReconciledDialogueClip } from './timing-reconciliation-types.js';
import {
  ReconciledCaptionPlan,
  ReconciledCaptionCue,
  ReconciledCaptionScene,
  TimingReconciliationError,
} from './timing-reconciliation-types.js';
import { ScenarioCaptionPlan } from './scenario-caption-types.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Recompute caption timing for a single clip using word-weighted segmentation
 * Reuses Phase 3E segmentation logic: distribute actual duration proportionally to estimated segment durations
 */
function recomputeCuesForClip(
  clip: ReconciledDialogueClip,
  originalCues: Array<{ id: string; text: string; estimatedStart: number; estimatedEnd: number; estimatedDuration: number; wordCount: number; isSingleWord: boolean }>,
  sceneIndex: number,
  globalOffset: number
): ReconciledCaptionCue[] {
  if (originalCues.length === 0) return [];

  const actualSpeechStart = clip.actualStartTimeSeconds;
  const actualSpeechEnd = clip.actualEndTimeSeconds;
  const actualDuration = clip.actualDurationSeconds;

  const totalEstimated = originalCues.reduce((sum, c) => sum + c.estimatedDuration, 0);

  // If total estimated is 0 (edge), distribute equally
  const useEqual = totalEstimated <= 0;

  let cursor = actualSpeechStart;
  const reconciled: ReconciledCaptionCue[] = [];

  for (let i = 0; i < originalCues.length; i++) {
    const orig = originalCues[i];
    const isLast = i === originalCues.length - 1;

    let actualCueDuration: number;
    if (useEqual) {
      actualCueDuration = round2(actualDuration / originalCues.length);
    } else {
      // Proportional to estimated duration
      actualCueDuration = round2((orig.estimatedDuration / totalEstimated) * actualDuration);
    }

    // For last cue, ensure it ends exactly at actualSpeechEnd (absorb rounding)
    let start = round2(cursor);
    let end: number;
    if (isLast) {
      end = round2(actualSpeechEnd);
      actualCueDuration = round2(end - start);
    } else {
      end = round2(start + actualCueDuration);
    }

    // Invariant: cue within turn's actual interval
    if (start < actualSpeechStart - 0.001 || end > actualSpeechEnd + 0.001) {
      throw new TimingReconciliationError('RECONCILIATION_INVARIANT_FAILURE', `Caption cue '${orig.id}' out of actual turn bounds: [${start}, ${end}] not within [${actualSpeechStart}, ${actualSpeechEnd}] for clip '${clip.clipId}'`, {
        cueId: orig.id,
        clipId: clip.clipId,
        start,
        end,
        actualSpeechStart,
        actualSpeechEnd,
      });
    }

    reconciled.push({
      id: orig.id,
      sceneId: clip.sceneId,
      sceneIndex,
      turnId: clip.turnId,
      turnIndex: clip.turnIndex,
      globalTurnIndex: clip.globalTurnIndex,
      clipId: clip.clipId,
      text: orig.text, // exact text unchanged
      speakerId: clip.speakerId,
      voiceSlot: clip.voiceSlot,
      startTimeSeconds: start,
      endTimeSeconds: end,
      durationSeconds: actualCueDuration,
      estimatedStartTimeSeconds: orig.estimatedStart,
      estimatedEndTimeSeconds: orig.estimatedEnd,
      estimatedDurationSeconds: orig.estimatedDuration,
      wordCount: orig.wordCount,
      isSingleWord: orig.isSingleWord,
      globalCueIndex: globalOffset + i,
    });

    cursor = end;
  }

  // Verify final cue end not exceed actual turn end
  const last = reconciled[reconciled.length - 1];
  if (last && last.endTimeSeconds > clip.actualEndTimeSeconds + 0.001) {
    throw new TimingReconciliationError('RECONCILIATION_INVARIANT_FAILURE', `Final caption end ${last.endTimeSeconds} exceeds actual turn end ${clip.actualEndTimeSeconds} for clip '${clip.clipId}'`, {
      clipId: clip.clipId,
      lastEnd: last.endTimeSeconds,
      actualEnd: clip.actualEndTimeSeconds,
    });
  }

  // Verify ordering preserved
  for (let i = 0; i < reconciled.length - 1; i++) {
    if (reconciled[i].endTimeSeconds > reconciled[i + 1].startTimeSeconds + 0.001) {
      throw new TimingReconciliationError('OVERLAP_DETECTED', `Caption overlap between cues '${reconciled[i].id}' and '${reconciled[i + 1].id}' in clip '${clip.clipId}'`, {
        clipId: clip.clipId,
      });
    }
  }

  return reconciled;
}

export function reconcileCaptionTiming(
  scenario: Scenario,
  reconciledDialogue: ReconciledDialogueAudioPlan,
  originalCaptionPlan: ScenarioCaptionPlan
): ReconciledCaptionPlan {
  if (!scenario || typeof scenario !== 'object') {
    throw new TimingReconciliationError('MISSING_SCENARIO', 'Scenario must be non-null object.', {});
  }
  if (!reconciledDialogue || typeof reconciledDialogue !== 'object') {
    throw new TimingReconciliationError('MISSING_DIALOGUE_PLAN', 'Reconciled dialogue plan must be non-null object.', {});
  }
  if (!originalCaptionPlan || typeof originalCaptionPlan !== 'object') {
    throw new TimingReconciliationError('MISSING_DIALOGUE_PLAN', 'Original caption plan must be non-null object.', {});
  }

  // Validate scenario ID continuity
  if (scenario.metadata.id !== reconciledDialogue.scenarioId) {
    throw new TimingReconciliationError('IDENTITY_MISMATCH', `Scenario ID mismatch: scenario '${scenario.metadata.id}' vs reconciledDialogue '${reconciledDialogue.scenarioId}'`, {});
  }
  if (scenario.metadata.id !== originalCaptionPlan.scenarioId) {
    throw new TimingReconciliationError('IDENTITY_MISMATCH', `Scenario ID mismatch: scenario '${scenario.metadata.id}' vs originalCaptionPlan '${originalCaptionPlan.scenarioId}'`, {});
  }

  // Build map of original cues grouped by clipId/turnId
  // originalCaptionPlan structure: scenes -> cues with turnId
  const originalCuesByTurnId = new Map<string, Array<{ id: string; text: string; estimatedStart: number; estimatedEnd: number; estimatedDuration: number; wordCount: number; isSingleWord: boolean }>>();
  for (const scene of originalCaptionPlan.scenes) {
    for (const cue of scene.cues) {
      const arr = originalCuesByTurnId.get(cue.turnId) ?? [];
      arr.push({
        id: cue.id,
        text: cue.text,
        estimatedStart: (cue as any).startTimeSeconds ?? cue.startSeconds,
        estimatedEnd: (cue as any).endTimeSeconds ?? cue.endSeconds,
        estimatedDuration: cue.durationSeconds,
        wordCount: cue.text.trim().split(/\s+/).filter(Boolean).length,
        isSingleWord: cue.text.trim().split(/\s+/).filter(Boolean).length === 1,
      });
      originalCuesByTurnId.set(cue.turnId, arr);
    }
  }

  const reconciledScenes: ReconciledCaptionScene[] = [];
  const allCues: ReconciledCaptionCue[] = [];
  let globalCueIndex = 0;

  for (let sIdx = 0; sIdx < reconciledDialogue.scenes.length; sIdx++) {
    const rScene = reconciledDialogue.scenes[sIdx];
    const sceneCues: ReconciledCaptionCue[] = [];

    let sceneEstimatedDuration = 0;
    let sceneActualDuration = 0;

    for (const clip of rScene.clips) {
      const origCues = originalCuesByTurnId.get(clip.turnId);
      if (!origCues || origCues.length === 0) {
        // No original cues for this turn — skip but preserve identity
        // This could happen if caption plan had no cues for silent turn, but we have a clip
        // We treat as no captions for this turn (no cross-turn caption)
        continue;
      }

      // Sort original cues by estimated start to preserve ordering
      const sortedOrig = [...origCues].sort((a, b) => a.estimatedStart - b.estimatedStart);

      const reconciledCues = recomputeCuesForClip(clip, sortedOrig, sIdx, globalCueIndex);

      for (const rc of reconciledCues) {
        sceneCues.push(rc);
        allCues.push(rc);
      }

      globalCueIndex += reconciledCues.length;
      sceneEstimatedDuration = round2(sceneEstimatedDuration + sortedOrig.reduce((sum, c) => sum + c.estimatedDuration, 0));
      sceneActualDuration = round2(sceneActualDuration + clip.actualDurationSeconds);
    }

    // Sort scene cues by start time (should already be in order)
    sceneCues.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    reconciledScenes.push({
      sceneId: rScene.sceneId,
      sceneIndex: sIdx,
      title: rScene.title,
      estimatedStartTimeSeconds: rScene.estimatedStartTimeSeconds,
      estimatedEndTimeSeconds: rScene.estimatedEndTimeSeconds,
      actualStartTimeSeconds: rScene.actualStartTimeSeconds,
      actualEndTimeSeconds: rScene.actualEndTimeSeconds,
      cues: sceneCues,
      cueCount: sceneCues.length,
      estimatedDurationSeconds: sceneEstimatedDuration,
      actualDurationSeconds: sceneActualDuration,
    });
  }

  // Final validation: no cross-turn caption
  for (const cue of allCues) {
    const clip = reconciledDialogue.clips.find(c => c.clipId === cue.clipId);
    if (!clip) {
      throw new TimingReconciliationError('CLIP_MISMATCH', `Caption cue '${cue.id}' references unknown clip '${cue.clipId}'`, { cueId: cue.id, clipId: cue.clipId });
    }
    if (cue.startTimeSeconds < clip.actualStartTimeSeconds - 0.001 || cue.endTimeSeconds > clip.actualEndTimeSeconds + 0.001) {
      throw new TimingReconciliationError('RECONCILIATION_INVARIANT_FAILURE', `Caption cue '${cue.id}' not within source turn's actual interval`, {
        cueId: cue.id,
        clipId: cue.clipId,
      });
    }
  }

  // Ensure cue ordering preserved globally
  for (let i = 0; i < allCues.length - 1; i++) {
    if (allCues[i].startTimeSeconds > allCues[i + 1].startTimeSeconds + 0.001) {
      // Allow equal start if same turn? No, should be strictly ordered
      // Check if same turn and overlapping — already checked
      // For different turns, start should be increasing
      if (allCues[i].turnId !== allCues[i + 1].turnId) {
        if (allCues[i].endTimeSeconds > allCues[i + 1].startTimeSeconds + 0.001) {
          throw new TimingReconciliationError('OVERLAP_DETECTED', `Cross-turn caption overlap between '${allCues[i].id}' and '${allCues[i + 1].id}'`, {
            currId: allCues[i].id,
            nextId: allCues[i + 1].id,
          });
        }
      }
    }
  }

  return {
    schemaVersion: '1.0.0-reconciled',
    scenarioId: reconciledDialogue.scenarioId,
    projectId: reconciledDialogue.projectId,
    targetFormat: reconciledDialogue.targetFormat,
    language: reconciledDialogue.language,
    estimatedTotalDurationSeconds: originalCaptionPlan.totalDurationSeconds,
    actualTotalDurationSeconds: reconciledDialogue.actualTotalDurationSeconds,
    cueCount: allCues.length,
    scenes: reconciledScenes,
    cues: allCues,
  };
}
