/**
 * BuildTrack Video Factory - Phase 4E Dialogue Production Types
 *
 * Final Phase 4 output contract and closure error taxonomy.
 * One stable source for Phase 5: canonical audio, actual timing, playback, captions, voice identity.
 */

import { ScenarioTargetFormat } from './types.js';
import { DialogueAudioPlan } from './dialogue-audio-types.js';
import { DialogueAudioPlanVoiceResolution } from './voice-types.js';
import { DialogueSynthesisManifest } from './audio-synthesis-types.js';
import { CanonicalDialogueAudioManifest } from './audio-validation-types.js';
import { ReconciledDialogueAudioPlan, ReconciledPlaybackPlan, ReconciledCaptionPlan } from './timing-reconciliation-types.js';
import { ScenarioVisualPlan } from './visual-plan-types.js';
import { ScenarioCaptionPlan } from './scenario-caption-types.js';

export const DIALOGUE_PRODUCTION_RESULT_SCHEMA_VERSION = '1.0.0' as const;

/** Deterministic summary for pipeline debugging and Phase 5 */
export interface DialogueProductionSummary {
  scenarioId: string;
  projectId: string;
  language: string;
  targetFormat: ScenarioTargetFormat;
  sceneCount: number;
  turnCount: number;
  clipCount: number;
  canonicalAudioCount: number;
  normalizedClipCount: number;
  totalActualDurationSeconds: number;
  totalEstimatedDurationSeconds: number;
  totalDeltaSeconds: number;
  voiceProfileCount: number;
  captionCueCount: number;
  warningsCount: number;
  status: 'ok' | 'warning' | 'error';
}

/** Structured finding for final validation */
export interface DialogueProductionFinding {
  severity: 'error' | 'warning';
  code: DialogueProductionErrorCode;
  message: string;
  location?: {
    scenarioId?: string;
    sceneId?: string;
    turnId?: string;
    clipId?: string;
    speakerId?: string;
    voiceSlot?: string;
    voiceProfileId?: string;
  };
}

/** Final Phase 4 result — stable contract for Phase 5 */
export interface DialogueProductionResult {
  schemaVersion: typeof DIALOGUE_PRODUCTION_RESULT_SCHEMA_VERSION;
  /** Scenario identity */
  scenarioId: string;
  projectId: string;
  language: string;
  targetFormat: ScenarioTargetFormat;

  /** Core artifacts — references, not duplicated giant copies */
  dialoguePlan: DialogueAudioPlan;
  voiceResolution: DialogueAudioPlanVoiceResolution;
  synthesisManifest: DialogueSynthesisManifest;
  canonicalManifest: CanonicalDialogueAudioManifest;
  reconciledDialogue: ReconciledDialogueAudioPlan;
  reconciledPlayback: ReconciledPlaybackPlan;
  reconciledCaptions: ReconciledCaptionPlan;

  /** Optional original visual/caption plans for traceability */
  visualPlan: ScenarioVisualPlan;
  captionPlan: ScenarioCaptionPlan;

  /** Deterministic summary */
  summary: DialogueProductionSummary;

  /** Findings (warnings/errors) from final validation */
  findings: DialogueProductionFinding[];

  /** Whether final invariants passed */
  valid: boolean;
}

/** Result of orchestration — either success with result or failure with findings */
export type BuildDialogueProductionResult =
  | { success: true; result: DialogueProductionResult }
  | { success: false; error: string; findings: DialogueProductionFinding[]; partialResult?: DialogueProductionResult };

/** Phase 4E-specific error codes for cross-phase integration failures */
export type DialogueProductionErrorCode =
  | 'PIPELINE_IDENTITY_MISMATCH'
  | 'MISSING_PHASE_OUTPUT'
  | 'FINAL_INVARIANT_FAILED'
  | 'PLAYBACK_AUDIO_MISMATCH'
  | 'CAPTION_AUDIO_MISMATCH'
  | 'CANONICAL_ARTIFACT_MISMATCH'
  | 'DUPLICATE_CLIP_ID'
  | 'MISSING_TURN'
  | 'MISSING_CLIP'
  | 'INVALID_DURATION'
  | 'OVERLAP_DETECTED'
  | 'VOICE_RESOLUTION_MISMATCH'
  | 'SYNTHESIS_MANIFEST_MISMATCH'
  | 'CANONICAL_MANIFEST_MISMATCH'
  | 'RECONCILED_TIMING_MISMATCH'
  | 'PLAYBACK_TIMING_MISMATCH'
  | 'CAPTION_TIMING_MISMATCH';

export class DialogueProductionError extends Error {
  public readonly code: DialogueProductionErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly findings?: DialogueProductionFinding[];

  constructor(code: DialogueProductionErrorCode, message: string, details?: Record<string, unknown>, findings?: DialogueProductionFinding[]) {
    super(message);
    this.name = 'DialogueProductionError';
    this.code = code;
    this.details = details;
    this.findings = findings;
  }
}

/** Options for building final production plan */
export interface DialogueProductionOptions {
  /** Base path for synthesized audio (relative) */
  synthesisBasePath?: string;
  /** Base path for canonical audio (relative) */
  canonicalBasePath?: string;
  /** Custom synthesizer (defaults to LocalDialogueSynthesizer) */
  synthesizer?: any;
  /** Voice resolution options passthrough */
  voiceResolutionOptions?: any;
  /** Whether to allow fallback voices (default false for strict) */
  allowFallbackVoices?: boolean;
  /** Whether to overwrite existing canonical files */
  allowOverwrite?: boolean;
}
