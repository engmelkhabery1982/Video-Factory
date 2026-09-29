/**
 * BuildTrack Video Factory - Phase 4B Audio Synthesizer Abstraction
 *
 * Clean interface/adapter contract for deterministic single-clip synthesis.
 * Core depends on abstraction, not on one concrete TTS implementation.
 */

import { AudioSynthesisRequest, AudioSynthesisResult } from './audio-synthesis-types.js';

/**
 * Provider-neutral synthesizer interface.
 * Implementations must be deterministic for same request as far as engine permits,
 * fail clearly if runtime unavailable, and never silently fallback to another voice.
 */
export interface AudioSynthesizer {
  /** Engine identifier, e.g. 'sam-js', 'mock', 'elevenlabs' */
  readonly engineId: string;
  /** Engine version for auditing */
  readonly engineVersion?: string;
  /** Whether this synthesizer requires network */
  readonly requiresNetwork: boolean;
  /** Whether this synthesizer is local-first */
  readonly isLocal: boolean;

  /**
   * Synthesize one clip deterministically.
   * Must preserve exact spokenText, speaker identity, voice mapping.
   * Must write artifact to request.targetPath (or return failure).
   * Must not silently fallback to another voice.
   * Must throw structured AudioSynthesisError for known failures.
   */
  synthesize(request: AudioSynthesisRequest): Promise<AudioSynthesisResult>;

  /**
   * Optional synchronous variant for local engines that are naturally sync.
   * If implemented, orchestration may use it for determinism.
   */
  synthesizeSync?(request: AudioSynthesisRequest): AudioSynthesisResult;

  /** Optional check if synthesizer runtime is available */
  isAvailable?(): Promise<boolean> | boolean;
}
