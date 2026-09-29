/**
 * BuildTrack Video Factory - Phase 4B Audio Synthesis Contracts
 *
 * Provider-neutral, strongly typed synthesis request/result/manifest
 * and structured error taxonomy. No synthesis, no I/O, no network —
 * pure contracts describing what is needed to synthesize one dialogue clip.
 */

import { VoiceProfile } from './voice-types.js';
import { AudioFormatSpec } from './dialogue-audio-types.js';
import { TurnDelivery } from './types.js';

/** Canonical synthesis request for one dialogue clip */
export interface AudioSynthesisRequest {
  /** Scenario identifier (from DialogueAudioPlan.scenarioId) */
  scenarioId: string;
  /** Scene identifier */
  sceneId: string;
  /** Turn identifier */
  turnId: string;
  /** Clip identifier (deterministic clip_${sceneId}_${turnId}) */
  clipId: string;
  /** Character / speaker identifier */
  speakerId: string;
  /** Character display name (for logging / metadata, not for synthesis) */
  speakerName?: string;
  /** Canonical voice slot */
  voiceSlot: string;
  /** Resolved VoiceProfile identifier */
  voiceProfileId: string;
  /** Resolved VoiceProfile (full, for hints) */
  voiceProfile: VoiceProfile;
  /** Language / locale for synthesis */
  language: string;
  /** Exact spoken text — must be preserved verbatim */
  spokenText: string;
  /** Optional delivery / tone guidance from Scenario turn */
  delivery?: TurnDelivery;
  /** Provider-neutral synthesis hints from VoiceProfile */
  synthesisHints?: VoiceProfile['synthesisHints'];
  /** Deterministic, safe, relative target path for output artifact */
  targetPath: string;
  /** Desired audio format */
  audioFormat: AudioFormatSpec;
  /** Zero-based scene index (for ordering) */
  sceneIndex: number;
  /** Zero-based turn index within scene */
  turnIndex: number;
  /** Global turn index across scenario */
  globalTurnIndex: number;
}

/** Result of synthesizing one clip */
export interface AudioSynthesisResult {
  /** Source clip identity */
  clipId: string;
  sceneId: string;
  turnId: string;
  speakerId: string;
  voiceSlot: string;
  voiceProfileId: string;
  /** Exact spoken text that was synthesized (must match request) */
  spokenText: string;
  /** Relative output path where artifact was written */
  outputPath: string;
  /** Audio format of produced artifact */
  audioFormat: AudioFormatSpec;
  /** Whether synthesis succeeded */
  success: boolean;
  /** Duration in seconds if synthesizer returns it (optional, for future Phase 4D) */
  durationSeconds?: number;
  /** File size in bytes (if available) */
  fileSizeBytes?: number;
  /** Deterministic metadata */
  metadata?: {
    scenarioId: string;
    language: string;
    engine: string;
    engineVersion?: string;
  };
  /** If failed, structured error */
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Manifest of synthesizing an entire DialogueAudioPlan */
export interface DialogueSynthesisManifest {
  schemaVersion: string;
  scenarioId: string;
  language: string;
  /** Total clips attempted */
  clipCount: number;
  /** Number of successful syntheses */
  successCount: number;
  /** Number of failed syntheses */
  failureCount: number;
  /** Whether any failure occurred */
  hadFailures: boolean;
  /** All results in deterministic order (sceneIndex, turnIndex) */
  results: AudioSynthesisResult[];
  /** Map from clipId -> result for quick lookup */
  byClipId: Readonly<Record<string, AudioSynthesisResult>>;
  /** Base output directory (relative) used for generation */
  basePath: string;
  /** Timestamp of synthesis (for auditing, not for determinism) */
  synthesizedAt?: string;
}

/** Structured error codes for synthesis */
export type AudioSynthesisErrorCode =
  | 'MISSING_VOICE_RESOLUTION'
  | 'UNSUPPORTED_VOICE_PROFILE'
  | 'SYNTHESIZER_UNAVAILABLE'
  | 'SYNTHESIS_FAILED'
  | 'INVALID_TEXT'
  | 'UNSAFE_PATH'
  | 'OUTPUT_WRITE_FAILED'
  | 'MALFORMED_SYNTHESIS_REQUEST'
  | 'CLIP_IDENTITY_MISMATCH'
  | 'DUPLICATE_CLIP_ID'
  | 'DUPLICATE_TURN_ID'
  | 'MISSING_CLIP'
  | 'INVALID_AUDIO_FORMAT';

/** Structured error for synthesis failures */
export class AudioSynthesisError extends Error {
  public readonly code: AudioSynthesisErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: AudioSynthesisErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AudioSynthesisError';
    this.code = code;
    this.details = details;
  }
}

/** Options for dialogue plan synthesis orchestration */
export interface DialogueSynthesisOptions {
  /** Base directory for output artifacts (relative, safe) */
  basePath?: string;
  /** If true, allows overwriting existing files (default false for safety) */
  allowOverwrite?: boolean;
  /** If true, includes fileSize and duration probing where available */
  includeFileStats?: boolean;
}
