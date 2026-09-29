/**
 * BuildTrack Video Factory - Phase 4D Timing Reconciliation Orchestrator
 *
 * Pipeline: CanonicalDialogueAudioManifest + DialogueAudioPlan → Reconciled Dialogue → Playback → Captions
 *
 * Deterministic, no randomness, no clock, no audio stretching.
 */

import { Scenario } from './types.js';
import { DialogueAudioPlan } from './dialogue-audio-types.js';
import { CanonicalDialogueAudioManifest } from './audio-validation-types.js';
import { ScenarioVisualPlan } from './visual-plan-types.js';
import { ScenarioCaptionPlan } from './scenario-caption-types.js';
import { ReconciledDialogueAudioPlan, ReconciledPlaybackPlan, ReconciledCaptionPlan, TimingReconciliationResult } from './timing-reconciliation-types.js';
import { reconcileDialogueTiming } from './reconcile-dialogue-timing.js';
import { reconcilePlaybackTiming } from './reconcile-playback.js';
import { reconcileCaptionTiming } from './reconcile-captions.js';

export interface ReconciliationInputs {
  scenario: Scenario;
  dialoguePlan: DialogueAudioPlan;
  canonicalManifest: CanonicalDialogueAudioManifest;
  visualPlan: ScenarioVisualPlan;
  captionPlan: ScenarioCaptionPlan;
}

export interface ReconciliationOutputs {
  reconciledDialogue: ReconciledDialogueAudioPlan;
  reconciledPlayback: ReconciledPlaybackPlan;
  reconciledCaptions: ReconciledCaptionPlan;
}

/** Full reconciliation: dialogue + playback + captions */
export function reconcileTiming(inputs: ReconciliationInputs): ReconciliationOutputs {
  const reconciledDialogue = reconcileDialogueTiming(inputs.scenario, inputs.dialoguePlan, inputs.canonicalManifest);
  const reconciledPlayback = reconcilePlaybackTiming(inputs.scenario, inputs.visualPlan, reconciledDialogue);
  const reconciledCaptions = reconcileCaptionTiming(inputs.scenario, reconciledDialogue, inputs.captionPlan);

  return {
    reconciledDialogue,
    reconciledPlayback,
    reconciledCaptions,
  };
}

/** Dialogue-only reconciliation (for callers that don't need playback/captions yet) */
export function reconcileDialogueOnly(
  scenario: Scenario,
  dialoguePlan: DialogueAudioPlan,
  canonicalManifest: CanonicalDialogueAudioManifest
): ReconciledDialogueAudioPlan {
  return reconcileDialogueTiming(scenario, dialoguePlan, canonicalManifest);
}

/** Build a TimingReconciliationResult summary */
export function buildReconciliationResult(
  scenario: Scenario,
  dialoguePlan: DialogueAudioPlan,
  canonicalManifest: CanonicalDialogueAudioManifest,
  outputs: ReconciliationOutputs
): TimingReconciliationResult {
  const perClip = outputs.reconciledDialogue.clips.map(c => ({
    clipId: c.clipId,
    estimatedDuration: c.estimatedDurationSeconds,
    actualDuration: c.actualDurationSeconds,
    delta: Math.round((c.actualDurationSeconds - c.estimatedDurationSeconds) * 100) / 100,
    actualStart: c.actualStartTimeSeconds,
    actualEnd: c.actualEndTimeSeconds,
  }));

  const perScene = outputs.reconciledDialogue.scenes.map(s => ({
    sceneId: s.sceneId,
    estimatedDuration: s.estimatedDurationSeconds,
    actualDuration: s.actualDurationSeconds,
    delta: Math.round((s.actualDurationSeconds - s.estimatedDurationSeconds) * 100) / 100,
    estimatedStart: s.estimatedStartTimeSeconds,
    estimatedEnd: s.estimatedEndTimeSeconds,
    actualStart: s.actualStartTimeSeconds,
    actualEnd: s.actualEndTimeSeconds,
  }));

  return {
    scenarioId: scenario.metadata.id,
    projectId: scenario.metadata.projectId,
    language: scenario.metadata.language,
    targetFormat: scenario.metadata.targetFormat,
    estimatedTotalDurationSeconds: dialoguePlan.totalDurationSeconds,
    actualTotalDurationSeconds: outputs.reconciledDialogue.actualTotalDurationSeconds,
    totalDeltaSeconds: Math.round((outputs.reconciledDialogue.actualTotalDurationSeconds - dialoguePlan.totalDurationSeconds) * 100) / 100,
    clipCount: outputs.reconciledDialogue.clipCount,
    perClip,
    perScene,
    manifestId: `${canonicalManifest.scenarioId}:${canonicalManifest.clipCount}`,
    canonicalClipCount: canonicalManifest.results.length,
  };
}
