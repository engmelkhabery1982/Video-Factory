/**
 * BuildTrack Video Factory - Phase 4C Audio Validation & Normalization Contracts
 *
 * Strongly typed metadata for probed/validated audio, validation results,
 * normalization results, and structured error taxonomy.
 * No timeline reconciliation — only validated canonical artifacts plus metadata.
 */

import { AudioFormatSpec } from './dialogue-audio-types.js';

/** Canonical audio target (from Phase 3C) */
export const CANONICAL_AUDIO_CONTAINER = 'wav' as const;
export const CANONICAL_AUDIO_CODEC = 'pcm_s16le' as const;
export const CANONICAL_SAMPLE_RATE = 48000 as const;
export const CANONICAL_CHANNELS = 1 as const;
export const CANONICAL_BIT_DEPTH = 16 as const;

export const CANONICAL_AUDIO_FORMAT: AudioFormatSpec = {
  container: CANONICAL_AUDIO_CONTAINER,
  sampleRate: CANONICAL_SAMPLE_RATE,
  channels: CANONICAL_CHANNELS,
  codec: CANONICAL_AUDIO_CODEC,
  bitDepth: CANONICAL_BIT_DEPTH,
};

/** Canonical audio metadata from probe */
export interface CanonicalAudioMetadata {
  /** Relative file path probed */
  relativePath: string;
  /** Absolute path if available (for internal use) */
  absolutePath?: string;
  /** Container, e.g. wav */
  container: string;
  /** Codec / sample format, e.g. pcm_s16le */
  codec: string;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Channel count */
  channels: number;
  /** Bit depth where reliably available */
  bitDepth?: number;
  /** Duration in seconds if available from probe/header */
  durationSeconds?: number;
  /** File size in bytes */
  fileSizeBytes: number;
  /** Whether file is valid WAV */
  isValid: boolean;
  /** Whether file matches canonical target */
  isCanonical: boolean;
  /** Engine used for probing */
  probeEngine: string;
}

/** Validation finding */
export interface AudioValidationFinding {
  severity: 'error' | 'warning';
  category: 'container' | 'codec' | 'sampleRate' | 'channels' | 'bitDepth' | 'format' | 'integrity' | 'path' | 'io';
  ruleId: string;
  message: string;
  location?: {
    relativePath?: string;
    expected?: string | number;
    actual?: string | number;
  };
}

/** Validation result for one file */
export interface AudioValidationResult {
  relativePath: string;
  valid: boolean;
  isCanonical: boolean;
  errorCount: number;
  warningCount: number;
  findings: AudioValidationFinding[];
  metadata?: CanonicalAudioMetadata;
}

/** Normalization result for one file */
export interface AudioNormalizationResult {
  /** Source clip identity */
  clipId: string;
  sceneId: string;
  turnId: string;
  speakerId: string;
  voiceSlot: string;
  voiceProfileId: string;
  spokenText: string;
  /** Source (non-canonical) path */
  sourcePath: string;
  /** Source metadata */
  sourceMetadata: CanonicalAudioMetadata;
  /** Canonical output path */
  canonicalPath: string;
  /** Canonical output metadata */
  canonicalMetadata: CanonicalAudioMetadata;
  /** Whether normalization was needed */
  wasNormalized: boolean;
  /** Whether result is canonical */
  isCanonical: boolean;
  /** Success */
  success: boolean;
  /** If failed, error */
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Manifest of canonical dialogue audio */
export interface CanonicalDialogueAudioManifest {
  schemaVersion: string;
  scenarioId: string;
  language: string;
  clipCount: number;
  successCount: number;
  failureCount: number;
  hadFailures: boolean;
  /** All normalization results in deterministic order */
  results: AudioNormalizationResult[];
  /** Map clipId -> result */
  byClipId: Readonly<Record<string, AudioNormalizationResult>>;
  /** Base paths */
  sourceBasePath: string;
  canonicalBasePath: string;
  /** Whether any clip needed normalization */
  hadNormalization: boolean;
  /** Timestamp */
  normalizedAt?: string;
}

/** Structured error codes for Phase 4C */
export type AudioValidationErrorCode =
  | 'MISSING_AUDIO_FILE'
  | 'UNSAFE_PATH'
  | 'UNREADABLE_FILE'
  | 'MALFORMED_WAV'
  | 'UNSUPPORTED_CONTAINER'
  | 'UNSUPPORTED_CODEC'
  | 'WRONG_SAMPLE_RATE'
  | 'WRONG_CHANNEL_COUNT'
  | 'WRONG_BIT_DEPTH'
  | 'EMPTY_AUDIO'
  | 'PROBE_FAILED'
  | 'NORMALIZER_UNAVAILABLE'
  | 'NORMALIZATION_FAILED'
  | 'OUTPUT_WRITE_FAILED'
  | 'IDENTITY_MISMATCH'
  | 'DUPLICATE_CLIP_ID'
  | 'MISSING_CLIP';

export class AudioValidationError extends Error {
  public readonly code: AudioValidationErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: AudioValidationErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AudioValidationError';
    this.code = code;
    this.details = details;
  }
}
