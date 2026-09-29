/**
 * BuildTrack Video Factory - Phase 4D Timing Reconciliation Contracts
 *
 * Strongly typed reconciled timing models and structured error taxonomy.
 * Replaces estimated speech timing with actual canonical audio duration
 * while preserving scenario, dialogue, playback, and caption identities.
 * No rendering, no audio modification, no timeline retiming beyond actual durations + preserved pauses.
 */

import { AudioFormatSpec } from './dialogue-audio-types.js';
import { DurationEstimatorConfig } from './duration.js';
import { TurnDelivery, TurnIntent, ScenarioTargetFormat } from './types.js';
import { CanonicalAudioMetadata } from './audio-validation-types.js';

/** Reconciled dialogue clip with actual timing */
export interface ReconciledDialogueClip {
  clipId: string;
  sceneId: string;
  sceneIndex: number;
  turnId: string;
  turnIndex: number;
  globalTurnIndex: number;
  speakerId: string;
  voiceSlot: string;
  voiceProfileId: string;
  spokenText: string;
  intent: TurnIntent;
  delivery?: TurnDelivery;
  evidenceId?: string;
  /** Original estimated suggested path (from Phase 3C) */
  estimatedPath: string;
  /** Canonical audio path (from Phase 4C) */
  canonicalPath: string;
  /** Source (non-canonical) path */
  sourcePath: string;
  audioFormat: AudioFormatSpec;
  /** Estimated duration (from Phase 3C, for comparison) */
  estimatedDurationSeconds: number;
  /** Actual canonical audio duration (authoritative) */
  actualDurationSeconds: number;
  /** Preserved pause after (from Phase 3C) */
  pauseAfterSeconds: number;
  /** Actual start time on global timeline (recomputed) */
  actualStartTimeSeconds: number;
  /** Actual end time of speech (start + actualDuration) */
  actualEndTimeSeconds: number;
  /** Actual total span including pause */
  actualTotalSpanSeconds: number;
  /** Canonical metadata */
  canonicalMetadata: CanonicalAudioMetadata;
}

export interface ReconciledDialogueScene {
  sceneId: string;
  sceneIndex: number;
  title?: string;
  /** Original estimated timing (for comparison) */
  estimatedStartTimeSeconds: number;
  estimatedEndTimeSeconds: number;
  estimatedDurationSeconds: number;
  /** Actual reconciled timing */
  actualStartTimeSeconds: number;
  actualEndTimeSeconds: number;
  actualDurationSeconds: number;
  /** Transition buffer preserved from Phase 3C */
  transitionSeconds: number;
  /** Visual-only buffer preserved */
  visualOnlySeconds: number;
  clips: ReconciledDialogueClip[];
}

export interface ReconciledDialogueAudioPlan {
  schemaVersion: string;
  scenarioId: string;
  projectId: string;
  targetFormat: ScenarioTargetFormat;
  language: string;
  audioFormat: AudioFormatSpec;
  durationConfig: DurationEstimatorConfig;
  allowSharedVoiceSlots: boolean;
  /** Original estimated total duration (from Phase 3C) */
  estimatedTotalDurationSeconds: number;
  /** Actual total duration (recomputed from actual audio + preserved pauses/gaps) */
  actualTotalDurationSeconds: number;
  totalSpeechDurationSeconds: number; // actual
  totalPauseDurationSeconds: number; // preserved
  estimatedSpeechDurationSeconds: number;
  clipCount: number;
  characters: {
    characterId: string;
    name: string;
    role: string;
    voiceSlot: string;
    turnCount: number;
  }[];
  scenes: ReconciledDialogueScene[];
  clips: ReconciledDialogueClip[];
}

/** Reconciled playback interval (ms) */
export interface ReconciledPlaybackInterval {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface ReconciledPlaybackDialogue {
  id: string;
  globalIndex: number;
  sceneId: string;
  sceneIndex: number;
  turnId: string;
  turnIndex: number;
  visualBeatId: string;
  audioClipId: string;
  speakerId: string;
  reactingCharacterId: string | null;
  voiceSlot: string;
  voiceProfileId: string;
  spokenText: string;
  intent: TurnIntent;
  delivery: TurnDelivery | null;
  evidenceIds: string[];
  suggestedAudioPath: string;
  canonicalAudioPath: string;
  speech: ReconciledPlaybackInterval;
  pause: ReconciledPlaybackInterval;
  turnSpan: ReconciledPlaybackInterval;
  actualDurationSeconds: number;
  estimatedDurationSeconds: number;
}

export interface ReconciledPlaybackScene {
  id: string;
  sourceSceneId: string;
  index: number;
  title: string | null;
  interval: ReconciledPlaybackInterval;
  dialogueSpan: ReconciledPlaybackInterval | null;
  transition: {
    type: string;
    source: string;
    interval: ReconciledPlaybackInterval | null;
  };
  beats: {
    id: string;
    index: number;
    kind: string;
    interval: ReconciledPlaybackInterval;
    dialogueId: string | null;
  }[];
  dialogueIds: string[];
  estimatedDurationMs: number;
  actualDurationMs: number;
}

export interface ReconciledPlaybackPlan {
  playbackVersion: string;
  scenarioId: string;
  projectId: string;
  language: string;
  targetFormat: ScenarioTargetFormat;
  audioFormat: AudioFormatSpec;
  durationConfig: DurationEstimatorConfig;
  allowSharedVoiceSlots: boolean;
  audioBasePath: string;
  canonicalBasePath: string;
  /** Original estimated total */
  estimatedTotalDurationMs: number;
  /** Actual total */
  actualTotalDurationMs: number;
  totalSpeechMs: number;
  totalPauseMs: number;
  totalTransitionMs: number;
  totalVisualOnlyMs: number;
  dialogueCount: number;
  scenes: ReconciledPlaybackScene[];
  dialogues: ReconciledPlaybackDialogue[];
}

/** Reconciled caption cue - timing within actual speech interval, exact text unchanged */
export interface ReconciledCaptionCue {
  id: string;
  sceneId: string;
  sceneIndex: number;
  turnId: string;
  turnIndex: number;
  globalTurnIndex: number;
  clipId: string;
  text: string;
  speakerId: string;
  voiceSlot: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  durationSeconds: number;
  estimatedStartTimeSeconds: number;
  estimatedEndTimeSeconds: number;
  estimatedDurationSeconds: number;
  wordCount: number;
  isSingleWord: boolean;
  globalCueIndex: number;
}

export interface ReconciledCaptionScene {
  sceneId: string;
  sceneIndex: number;
  title?: string;
  estimatedStartTimeSeconds: number;
  estimatedEndTimeSeconds: number;
  actualStartTimeSeconds: number;
  actualEndTimeSeconds: number;
  cues: ReconciledCaptionSceneCueWrapper[] | ReconciledCaptionCue[];
  cueCount: number;
  estimatedDurationSeconds: number;
  actualDurationSeconds: number;
}

// For compatibility, allow both shapes - but we use direct cues array
export type ReconciledCaptionSceneCueWrapper = ReconciledCaptionCue;

export interface ReconciledCaptionPlan {
  schemaVersion: string;
  scenarioId: string;
  projectId: string;
  targetFormat: ScenarioTargetFormat;
  language: string;
  estimatedTotalDurationSeconds: number;
  actualTotalDurationSeconds: number;
  cueCount: number;
  scenes: ReconciledCaptionScene[];
  cues: ReconciledCaptionCue[];
}

export interface TimingReconciliationResult {
  scenarioId: string;
  projectId: string;
  language: string;
  targetFormat: ScenarioTargetFormat;
  estimatedTotalDurationSeconds: number;
  actualTotalDurationSeconds: number;
  totalDeltaSeconds: number;
  clipCount: number;
  perClip: Array<{
    clipId: string;
    estimatedDuration: number;
    actualDuration: number;
    delta: number;
    actualStart: number;
    actualEnd: number;
  }>;
  perScene: Array<{
    sceneId: string;
    estimatedDuration: number;
    actualDuration: number;
    delta: number;
    estimatedStart: number;
    estimatedEnd: number;
    actualStart: number;
    actualEnd: number;
  }>;
  manifestId: string;
  canonicalClipCount: number;
}

/** Structured error codes for Phase 4D */
export type TimingReconciliationErrorCode =
  | 'MISSING_CANONICAL_CLIP'
  | 'INVALID_DURATION'
  | 'ZERO_DURATION'
  | 'IDENTITY_MISMATCH'
  | 'SCENE_MISMATCH'
  | 'TURN_MISMATCH'
  | 'CLIP_MISMATCH'
  | 'SPEAKER_MISMATCH'
  | 'VOICE_MISMATCH'
  | 'VOICE_PROFILE_MISMATCH'
  | 'SPOKEN_TEXT_MISMATCH'
  | 'DUPLICATE_CLIP_ID'
  | 'ORDERING_MISMATCH'
  | 'OVERLAP_DETECTED'
  | 'INVALID_PAUSE_CONFIG'
  | 'RECONCILIATION_INVARIANT_FAILURE'
  | 'MISSING_SCENARIO'
  | 'MISSING_DIALOGUE_PLAN'
  | 'MISSING_CANONICAL_MANIFEST';

export class TimingReconciliationError extends Error {
  public readonly code: TimingReconciliationErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: TimingReconciliationErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TimingReconciliationError';
    this.code = code;
    this.details = details;
  }
}
