/**
 * BuildTrack Video Factory - Production Dialogue Synthesizer (Kokoro)
 *
 * Local-first production-quality TTS adapter implementing the Phase 4B
 * AudioSynthesizer abstraction using `kokoro-js` (Apache-2.0) with the
 * open ONNX export of Kokoro-82M:
 *
 *   Model:  onnx-community/Kokoro-82M-v1.0-ONNX  (Apache-2.0)
 *   Runtime: kokoro-js pinned exact, transformers.js 3.x, onnxruntime CPU
 *   Output: mono 24 kHz PCM16 WAV (one artifact per dialogue clip)
 *
 * Contract notes (mirrors LocalDialogueSynthesizer / Phase 4B):
 * - preserves exact spokenText (verbatim source authority), clipId, speakerId,
 *   voiceSlot, voiceProfileId
 * - writes a separate physical WAV artifact per clip at request.targetPath
 * - never silently falls back to SAM or another engine; fails with a
 *   structured AudioSynthesisError when the production model cache is missing
 * - deterministic: same request -> same Kokoro voice, same target path
 *
 * Cache strategy (offline after provisioning):
 * - `npm run provision:tts` (tools/provision-tts.mjs) downloads the model
 *   once into `<repo>/.tts-cache/models` via transformers.js FS cache
 * - normal synthesis runs with `env.allowRemoteModels = false`, so no network
 *   is ever touched at synthesis time; a missing cache fails clearly
 * - voice tensors (voices/*.bin) ship inside the kokoro-js npm package and
 *   are read from node_modules via fs at generate time
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  AudioSynthesisRequest,
  AudioSynthesisResult,
  AudioSynthesisError,
} from './audio-synthesis-types.js';
import { AudioSynthesizer } from './audio-synthesizer.js';
import { AudioFormatSpec } from './dialogue-audio-types.js';
import {
  KOKORO_CACHE_DIR,
  KOKORO_DTYPE,
  KOKORO_JS_VERSION,
  KOKORO_MODEL_ID,
  KOKORO_SAMPLE_RATE,
  resolveKokoroVoice,
} from './kokoro-voice-identity.js';

/*
 * VS1: the engine identity constants (runtime pin, model id, dtype, sample
 * rate, cache dir and the voiceSlot -> preset-voice map) now live in the
 * I/O-free `kokoro-voice-identity.ts` so the voice contract layer can document
 * an auditable engine identity without importing this adapter. They are
 * re-exported here unchanged, so every existing importer of this module keeps
 * resolving the same symbols to the same values.
 */
export {
  KOKORO_ENGINE_ID,
  KOKORO_JS_VERSION,
  KOKORO_MODEL_ID,
  KOKORO_DTYPE,
  KOKORO_SAMPLE_RATE,
  KOKORO_CACHE_DIR,
  KOKORO_VOICE_BY_SLOT,
  resolveKokoroVoice,
} from './kokoro-voice-identity.js';

const require = createRequire(import.meta.url);

/** Default synthesis audio format produced by this engine (24 kHz mono PCM16) */
export const KOKORO_SYNTHESIS_FORMAT: AudioFormatSpec = {
  container: 'wav',
  sampleRate: KOKORO_SAMPLE_RATE as unknown as 48000,
  channels: 1,
  codec: 'pcm_s16le',
  bitDepth: 16,
} as unknown as AudioFormatSpec;

/** Deterministic WAV header for 16-bit PCM mono (same layout as SAM adapter) */
function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  const byteRate = sampleRate * 2; // mono * 16-bit = 2 bytes per sample
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); // PCM chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Validate and bound spoken text (mirrors SAM adapter bounds) */
function validateSpokenText(text: unknown): string {
  if (typeof text !== 'string') {
    throw new AudioSynthesisError('INVALID_TEXT', 'spokenText must be a string.', { text });
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new AudioSynthesisError('INVALID_TEXT', 'spokenText must be non-empty.', { text });
  }
  if (trimmed.length > 5000) {
    throw new AudioSynthesisError('INVALID_TEXT', `spokenText exceeds maximum length of 5000 (got ${trimmed.length}).`, { length: trimmed.length });
  }
  return trimmed;
}

/** Validate safe relative target path (mirrors Phase 4B conventions) */
function validateSafeRelativePath(p: string): void {
  if (!p || typeof p !== 'string') {
    throw new AudioSynthesisError('UNSAFE_PATH', 'targetPath must be a non-empty string.', { targetPath: p });
  }
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) {
    throw new AudioSynthesisError('UNSAFE_PATH', `targetPath must be relative, got absolute: '${p}'`, { targetPath: p });
  }
  const segments = p.split(/[/\\]/);
  if (segments.some(s => s === '..' || s === '.')) {
    throw new AudioSynthesisError('UNSAFE_PATH', `targetPath contains forbidden traversal: '${p}'`, { targetPath: p });
  }
  if (/[<>:\"|?*]/.test(p)) {
    throw new AudioSynthesisError('UNSAFE_PATH', `targetPath contains forbidden chars: '${p}'`, { targetPath: p });
  }
}

/** Minimal structural shape of the lazily loaded kokoro-js module */
interface KokoroModule {
  KokoroTTS: {
    from_pretrained(
      modelId: string,
      options: { dtype?: string; device?: string | null; progress_callback?: (p: unknown) => void }
    ): Promise<KokoroTtsInstance>;
  };
}

/** Minimal structural shape of a loaded Kokoro TTS instance */
interface KokoroTtsInstance {
  generate(
    text: string,
    options: { voice: string; speed?: number }
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

export interface KokoroSynthesizerOptions {
  /** Repo-relative or absolute model cache directory (default .tts-cache/models) */
  cacheDir?: string;
  /** Hugging Face model id (default onnx-community/Kokoro-82M-v1.0-ONNX) */
  modelId?: string;
  /** Model dtype (default q8) */
  dtype?: string;
}

export class KokoroDialogueSynthesizer implements AudioSynthesizer {
  readonly engineId = 'kokoro-js';
  readonly engineVersion = KOKORO_JS_VERSION;
  /** Synthesis itself never touches the network (cache-only); provisioning does. */
  readonly requiresNetwork = false;
  readonly isLocal = true;

  private readonly cacheDir: string;
  private readonly modelId: string;
  private readonly dtype: string;
  private KokoroModule: KokoroModule | null = null;
  private tts: KokoroTtsInstance | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(options: KokoroSynthesizerOptions = {}) {
    this.cacheDir = options.cacheDir ?? KOKORO_CACHE_DIR;
    this.modelId = options.modelId ?? KOKORO_MODEL_ID;
    this.dtype = options.dtype ?? KOKORO_DTYPE;
  }

  /**
   * Eagerly load the model from the local cache. Called by isAvailable() and
   * by synthesize() before first use. Configure transformers.js for
   * cache-only operation and fail clearly when the cache is missing.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.tts) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        if (!this.KokoroModule) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            this.KokoroModule = require('kokoro-js') as KokoroModule;
          } catch (e) {
            throw new AudioSynthesisError(
              'SYNTHESIZER_UNAVAILABLE',
              `kokoro-js dependency is not installed or failed to load: ${(e as Error).message}. Run 'npm install'.`,
              { engineId: this.engineId, cause: (e as Error).message },
            );
          }
        }

        const transformers = require('@huggingface/transformers') as {
          env: {
            cacheDir: string;
            localModelPath: string;
            allowRemoteModels: boolean;
            allowLocalModels: boolean;
            useBrowserCache: boolean;
            useFSCache: boolean;
          };
        };

        // Cache-only contract: model must be provisioned into cacheDir first.
        transformers.env.cacheDir = this.cacheDir;
        transformers.env.localModelPath = this.cacheDir;
        transformers.env.allowRemoteModels = false;
        transformers.env.allowLocalModels = true;
        transformers.env.useBrowserCache = false;
        transformers.env.useFSCache = true;

        try {
          this.tts = await this.KokoroModule.KokoroTTS.from_pretrained(this.modelId, {
            dtype: this.dtype,
            device: null, // CPU/WASM
            progress_callback: () => {},
          });
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          const cacheMissing =
            msg.includes('local_files_only') ||
            msg.includes('allowRemoteModels=false') ||
            msg.includes('was not found locally') ||
            msg.includes('file was not found locally') ||
            /ENOENT/i.test(msg);

          if (cacheMissing) {
            throw new AudioSynthesisError(
              'SYNTHESIZER_UNAVAILABLE',
              `Production TTS model '${this.modelId}' is not present in local cache '${this.cacheDir}'. Run 'npm run provision:tts' once (requires network) and retry. Synthesis is cache-only and never downloads silently.`,
              { engineId: this.engineId, modelId: this.modelId, cacheDir: this.cacheDir, cause: msg },
            );
          }
          throw new AudioSynthesisError(
            'SYNTHESIS_FAILED',
            `Kokoro model load failed for clip synthesis: ${msg}`,
            { engineId: this.engineId, modelId: this.modelId, cacheDir: this.cacheDir, cause: msg },
          );
        }
      })();
    }
    try {
      await this.loadPromise;
    } catch (e) {
      // Allow retry after transient failure: reset so next call can re-attempt.
      this.loadPromise = null;
      this.tts = null;
      throw e;
    }
  }

  /** True when the kokoro-js package resolves AND the model cache is populated. */
  isAvailable(): Promise<boolean> {
    return (async () => {
      try {
        await this.ensureLoaded();
        return this.tts !== null;
      } catch {
        return false;
      }
    })();
  }

  private validateRequest(request: AudioSynthesisRequest): void {
    if (!request || typeof request !== 'object') {
      throw new AudioSynthesisError('MALFORMED_SYNTHESIS_REQUEST', 'Synthesis request must be a non-null object.', { request });
    }
    const required = ['scenarioId', 'sceneId', 'turnId', 'clipId', 'speakerId', 'voiceSlot', 'voiceProfileId', 'language', 'spokenText', 'targetPath'] as const;
    for (const field of required) {
      const val = (request as unknown as Record<string, unknown>)[field];
      if (!val || (typeof val === 'string' && !val.trim())) {
        throw new AudioSynthesisError('MALFORMED_SYNTHESIS_REQUEST', `Missing required field: ${field}`, { field });
      }
    }
    validateSpokenText(request.spokenText);
    validateSafeRelativePath(request.targetPath);
    if (!request.voiceProfile || typeof request.voiceProfile !== 'object') {
      throw new AudioSynthesisError('MALFORMED_SYNTHESIS_REQUEST', 'voiceProfile must be present in request.', { clipId: request.clipId });
    }
  }

  /**
   * Synthesize one dialogue clip to its own physical WAV artifact.
   * Async, cache-only, deterministic voice mapping, exact text preservation.
   */
  async synthesize(request: AudioSynthesisRequest): Promise<AudioSynthesisResult> {
    this.validateRequest(request);
    const spokenText = validateSpokenText(request.spokenText);

    await this.ensureLoaded();
    if (!this.tts || !this.KokoroModule) {
      throw new AudioSynthesisError('SYNTHESIZER_UNAVAILABLE', 'Kokoro synthesizer failed to initialize.', { engineId: this.engineId });
    }

    // Deterministic, registry-owned voice assignment (no identity inference).
    const voice = resolveKokoroVoice({ voiceSlot: request.voiceSlot, voiceProfile: request.voiceProfile });

    let audio: Float32Array;
    let samplingRate: number;
    try {
      const raw = await this.tts.generate(spokenText, { voice, speed: 1 });
      audio = raw.audio;
      samplingRate = raw.sampling_rate;
    } catch (e) {
      throw new AudioSynthesisError(
        'SYNTHESIS_FAILED',
        `Kokoro synthesis failed for clip '${request.clipId}' (voice '${voice}'): ${(e as Error).message}`,
        { clipId: request.clipId, voice, cause: (e as Error).message },
      );
    }

    if (!audio || audio.length === 0) {
      throw new AudioSynthesisError('SYNTHESIS_FAILED', `Kokoro returned empty audio for clip '${request.clipId}'.`, {
        clipId: request.clipId,
        voice,
      });
    }

    // Convert Float32 [-1, 1] samples to Int16 PCM and write mono WAV at 24 kHz.
    const pcm = new Int16Array(audio.length);
    for (let i = 0; i < audio.length; i++) {
      const v = Math.max(-1, Math.min(1, audio[i]));
      pcm[i] = Math.round(v * 32767);
    }
    const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const header = wavHeader(body.length, KOKORO_SAMPLE_RATE);
    const wavFile = Buffer.concat([header, body]);

    const dir = path.dirname(request.targetPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new AudioSynthesisError('OUTPUT_WRITE_FAILED', `Failed to create output directory '${dir}': ${(e as Error).message}`, {
        targetPath: request.targetPath,
        error: (e as Error).message,
      });
    }

    try {
      fs.writeFileSync(request.targetPath, wavFile);
    } catch (e) {
      throw new AudioSynthesisError('OUTPUT_WRITE_FAILED', `Failed to write audio file '${request.targetPath}': ${(e as Error).message}`, {
        targetPath: request.targetPath,
        error: (e as Error).message,
      });
    }

    const duration = audio.length / KOKORO_SAMPLE_RATE;

    const result: AudioSynthesisResult = {
      clipId: request.clipId,
      sceneId: request.sceneId,
      turnId: request.turnId,
      speakerId: request.speakerId,
      voiceSlot: request.voiceSlot,
      voiceProfileId: request.voiceProfileId,
      spokenText: request.spokenText, // exact preservation — source of truth
      outputPath: request.targetPath,
      audioFormat: {
        container: 'wav',
        sampleRate: KOKORO_SAMPLE_RATE as unknown as 48000,
        channels: 1,
        codec: 'pcm_s16le',
        bitDepth: 16,
      },
      success: true,
      durationSeconds: Math.round(duration * 1000) / 1000,
      fileSizeBytes: wavFile.length,
      metadata: {
        scenarioId: request.scenarioId,
        language: request.language,
        engine: this.engineId,
        engineVersion: this.engineVersion,
      },
    };

    return result;
  }
}
