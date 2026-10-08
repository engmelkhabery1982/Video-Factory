/**
 * BuildTrack Video Factory - Phase 4B Audio Synthesis Contracts
 *
 * Provider-neutral, strongly typed synthesis request/result/manifest
 * and structured error taxonomy. No synthesis, no I/O, no network —
 * pure contracts describing what is needed to synthesize one dialogue clip.
 */

import {
  VoiceAcousticIdentity,
  VoiceProfile,
  VoicePublicationGateBatchReport,
  VoicePublicationGateOptions,
} from './voice-types.js';
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
  /**
   * VS1: the ACOUSTIC identity declared by the voice profile — engine family,
   * model id, pinned model revision, runtime pin, and the reference-audio hash
   * (cloned voice) or preset voice id (model preset).
   *
   * It is part of the synthesis reuse key, so changing the engine, the model
   * revision or the reference recording invalidates reuse and forces the engine
   * to run again. Rights/consent/publication state are deliberately NOT here:
   * they change no samples and are enforced by the publication gate.
   */
  voiceAcousticIdentity?: VoiceAcousticIdentity;
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
  /**
   * True when this result was produced by VALIDATED REUSE of an unchanged
   * per-turn artifact (same acoustic request + same physical bytes), so the
   * engine was not called again for this clip.
   */
  reused?: boolean;
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
  /** Number of clips served by validated reuse (unchanged acoustic request + bytes) */
  reusedClipCount?: number;
  /** Number of clips actually sent to the synthesis engine */
  synthesizedClipCount?: number;
  /**
   * VS1: the commercial publication gate report for the voices used, present
   * only when the gate was enforced for this run (`enforcePublicationGate`).
   * `allowed: true` is a positive statement that every voice in this manifest
   * was approved for published production at synthesis time.
   */
  publicationGate?: VoicePublicationGateBatchReport;
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
  | 'INVALID_AUDIO_FORMAT'
  /** VS1: a voice failed the commercial publication gate, so nothing is synthesized. */
  | 'VOICE_PUBLICATION_BLOCKED'
  /**
   * VS2 (Chatterbox voice cloning) — every one of these is a BLOCKING failure:
   * the adapter never degrades to another engine, another voice or a silently
   * downloaded model. The list mirrors the worker failure taxonomy and the
   * adapter's own environment checks.
   */
  | 'CHATTERBOX_PYTHON_MISSING'
  | 'CHATTERBOX_WORKER_MISSING'
  | 'CHATTERBOX_MODEL_MISSING'
  | 'CHATTERBOX_MODEL_REVISION_MISMATCH'
  | 'CHATTERBOX_CUDA_REQUIRED'
  | 'CHATTERBOX_CUDA_INIT_FAILED'
  | 'CHATTERBOX_GPU_OUT_OF_MEMORY'
  | 'CHATTERBOX_WORKER_TIMEOUT'
  | 'CHATTERBOX_WORKER_EXIT_NONZERO'
  | 'CHATTERBOX_INVALID_JSON'
  | 'CHATTERBOX_MANIFEST_VERSION_MISMATCH'
  | 'CHATTERBOX_EMPTY_OUTPUT'
  | 'CHATTERBOX_SILENT_OUTPUT'
  | 'CHATTERBOX_INVALID_WAV'
  | 'CHATTERBOX_WATERMARK_MISSING'
  | 'CHATTERBOX_REFERENCE_MISSING'
  | 'CHATTERBOX_REFERENCE_HASH_MISMATCH'
  | 'CHATTERBOX_UNSUPPORTED_LANGUAGE'
  | 'CHATTERBOX_VOICE_FALLBACK_BLOCKED'
  | 'CHATTERBOX_WORKER_FAILED';

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
  /**
   * Validated reuse of an unchanged per-turn artifact (default true).
   *
   * Reuse happens ONLY when the stored synthesis key and the stored output
   * hash/size match the request and the bytes on disk exactly; a dialogue edit
   * changes spokenText, so the key no longer matches and the clip is
   * re-synthesized. Set false to force the engine (tests, diagnostics).
   */
  reuse?: boolean;
  /**
   * VS1: run the commercial publication gate over every resolved voice BEFORE
   * synthesizing anything, and fail with `VOICE_PUBLICATION_BLOCKED` when any
   * voice is not allowed. Default `false` here so low-level synthesis stays
   * usable for reference/diagnostic runs; the production orchestration
   * (`buildDialogueProductionPlan`) turns it on by default.
   */
  enforcePublicationGate?: boolean;
  /** Gate options used when `enforcePublicationGate` is set. */
  publicationGate?: VoicePublicationGateOptions;
  /**
   * VS1: additionally require that the voice's DECLARED engine/model matches the
   * synthesizer that will actually run, so an approved Kokoro voice can never be
   * silently produced by a different engine. Default `false` because the
   * reference (SAM) mode legitimately synthesizes profiles whose documented
   * production engine is Kokoro.
   */
  requireVoiceEngineAgreement?: boolean;
}
