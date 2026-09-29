/**
 * BuildTrack Video Factory - Phase 3C Dialogue Audio Planning Types
 *
 * Defines the deterministic multi-character dialogue audio planning contract.
 * Manifest-only specification for multi-character speech clips, voice slots,
 * timeline positions, and audio formatting.
 */

import {
  ScenarioTargetFormat,
  TurnDelivery,
  TurnIntent,
} from './types.js';
import { DurationEstimatorConfig } from './duration.js';

export const DIALOGUE_AUDIO_PLAN_SCHEMA_VERSION = '1.0.0';

/** Standard audio format specification for planned dialogue clips */
export interface AudioFormatSpec {
  /** Working audio container */
  container: 'wav';
  /** Sampling frequency in Hz */
  sampleRate: 48000;
  /** Audio channel count (1 = mono for speech dialogue) */
  channels: 1;
  /** PCM sample encoding */
  codec: 'pcm_s16le';
  /** Bit depth per sample */
  bitDepth: 16;
}

export const DEFAULT_AUDIO_FORMAT: AudioFormatSpec = {
  container: 'wav',
  sampleRate: 48000,
  channels: 1,
  codec: 'pcm_s16le',
  bitDepth: 16,
};

/** Character entry in the dialogue audio plan with resolved voice slot */
export interface DialogueAudioCharacter {
  characterId: string;
  name: string;
  role: string;
  /** Resolved default voice slot for this character */
  voiceSlot: string;
  /** Total number of dialogue turns spoken by this character */
  turnCount: number;
}

/** Individual dialogue audio clip manifest entry */
export interface DialogueAudioClip {
  /** Deterministic clip identifier (e.g. `clip_${sceneId}_${turnId}`) */
  clipId: string;
  /** Parent scene identifier */
  sceneId: string;
  /** Zero-based scene index */
  sceneIndex: number;
  /** Dialogue turn identifier */
  turnId: string;
  /** Zero-based turn index within its scene */
  turnIndex: number;
  /** Global sequence index across the entire scenario (0, 1, 2...) */
  globalTurnIndex: number;
  /** Character ID speaking this clip */
  speakerId: string;
  /** Resolved voice slot identifier (`turn.voiceSlot ?? character.voiceSlot`) */
  voiceSlot: string;
  /** Exact spoken dialogue text */
  spokenText: string;
  /** Communicative intent of the dialogue */
  intent: TurnIntent;
  /** Optional emotion / delivery guidance */
  delivery?: TurnDelivery;
  /** Optional referenced evidence identifier */
  evidenceId?: string;
  /** Deterministic, safe, relative file path suggestion */
  suggestedPath: string;
  /** Expected audio format metadata */
  audioFormat: AudioFormatSpec;
  /** Start time of spoken speech on global timeline in seconds */
  startTimeSeconds: number;
  /** Estimated speech duration in seconds */
  durationSeconds: number;
  /** End time of spoken speech (startTimeSeconds + durationSeconds) */
  endTimeSeconds: number;
  /** Deliberate silence / breath pause after the turn in seconds */
  pauseAfterSeconds: number;
  /** Total time span of the turn including trailing pause in seconds */
  totalSpanSeconds: number;
}

/** Scene entry in the dialogue audio plan */
export interface DialogueAudioScene {
  sceneId: string;
  sceneIndex: number;
  title?: string;
  /** Start time of this scene on the global timeline in seconds */
  startTimeSeconds: number;
  /** End time of this scene on the global timeline in seconds */
  endTimeSeconds: number;
  /** Total duration of this scene in seconds */
  durationSeconds: number;
  /** Dialogue audio clips contained within this scene */
  clips: DialogueAudioClip[];
}

/** Configuration options for the dialogue audio planner */
export interface DialogueAudioPlanOptions {
  /** If true, permits multiple speaking characters to share the same voiceSlot (defaults to false) */
  allowSharedVoiceSlots?: boolean;
  /** Base directory prefix for relative suggested paths (defaults to 'audio/dialogue') */
  basePath?: string;
  /** Optional custom duration estimator configuration overriding DEFAULT_DURATION_CONFIG */
  durationConfig?: Partial<DurationEstimatorConfig>;
}

/** Complete canonical Dialogue Audio Plan manifest */
export interface DialogueAudioPlan {
  schemaVersion: typeof DIALOGUE_AUDIO_PLAN_SCHEMA_VERSION;
  scenarioId: string;
  projectId: string;
  targetFormat: ScenarioTargetFormat;
  language: string;
  audioFormat: AudioFormatSpec;
  /** Exact estimator assumptions used to produce the timeline. */
  durationConfig: DurationEstimatorConfig;
  /** Records whether cross-character voice-slot sharing was explicitly allowed. */
  allowSharedVoiceSlots: boolean;
  /** Total planned duration in seconds */
  totalDurationSeconds: number;
  /** Total speech duration in seconds (sum of all clip durationSeconds) */
  totalSpeechDurationSeconds: number;
  /** Total pause duration in seconds (sum of all clip pauseAfterSeconds) */
  totalPauseDurationSeconds: number;
  /** Total number of dialogue clips */
  clipCount: number;
  /** Speaking characters in this plan with resolved voice slots */
  characters: DialogueAudioCharacter[];
  /** Scenes breakdown with their clips */
  scenes: DialogueAudioScene[];
  /** Flattened list of all dialogue clips in chronological order */
  clips: DialogueAudioClip[];
}

/** Structured finding reported during dialogue audio plan validation */
export interface DialogueAudioPlanFinding {
  severity: 'error' | 'warning';
  category: 'schema' | 'integrity' | 'timing' | 'voice_slot' | 'path' | 'format';
  ruleId: string;
  message: string;
  location?: {
    scenarioId?: string;
    sceneId?: string;
    turnId?: string;
    clipId?: string;
    characterId?: string;
    voiceSlot?: string;
  };
}

/** Report returned by validateDialogueAudioPlan */
export interface DialogueAudioPlanValidationReport {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  findings: DialogueAudioPlanFinding[];
}
