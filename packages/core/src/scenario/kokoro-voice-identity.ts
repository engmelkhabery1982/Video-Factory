/**
 * BuildTrack Video Factory - VS1 Kokoro Voice Identity (pure constants)
 *
 * Single source of truth for the LOCAL Kokoro engine identity:
 *   - the exact npm runtime pin (`kokoro-js`),
 *   - the pinned ONNX model id and quantisation,
 *   - the native output sample rate and cache directory,
 *   - the deterministic voiceSlot -> Kokoro preset-voice map.
 *
 * Why this module exists separately from `kokoro-dialogue-synthesizer.ts`
 * ---------------------------------------------------------------------
 * The voice CONTRACT layer (registry, resolver, publication gate and the VS1
 * migration) has to state a documented, auditable engine identity for every
 * production voice. The engine adapter cannot be imported for that purpose: it
 * pulls in `node:fs`, `node:path` and a lazily `require`d `kokoro-js` runtime,
 * and the contract layer is deliberately I/O-free (Phase 4A doctrine) and is
 * reachable from browser-bundled packages.
 *
 * These constants carry no I/O and no dependencies, so both sides can share
 * them. `kokoro-dialogue-synthesizer.ts` re-exports every symbol below, so
 * existing importers of the adapter keep working unchanged.
 */

import { VoiceGender } from './voice-types.js';

/** Engine id reported by the adapter and recorded in synthesis manifests. */
export const KOKORO_ENGINE_ID = 'kokoro-js';

/** kokoro-js exact pin (package.json devDependency) */
export const KOKORO_JS_VERSION = '1.2.1';

/** Kokoro 82M ONNX model identifier (onnx-community export, Apache-2.0) */
export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/** Quantized dtype used for deterministic local CPU/WASM execution */
export const KOKORO_DTYPE = 'q8' as const;

/** Kokoro native output sample rate (Hz) */
export const KOKORO_SAMPLE_RATE = 24000;

/** Default repo-local model cache directory (relative to repo root) */
export const KOKORO_CACHE_DIR = '.tts-cache/models';

/**
 * Deterministic production voice mapping.
 *
 * Key: canonical voiceSlot from the default Voice Registry.
 * Value: distinct Kokoro voice id (28 available: af_/am_ = en-US,
 * bf_/bm_ = en-GB). Gender prefixes match the registry slot genders and
 * the fixture scenarios use en-GB, so British voices are preferred where
 * a stable professional-grade voice exists. Every entry maps to a DISTINCT
 * Kokoro voice — no two default slots share one.
 */
export const KOKORO_VOICE_BY_SLOT: Readonly<Record<string, string>> = Object.freeze({
  voice_en_female_authority: 'af_heart', // Female, en-US, grade A (flagship)
  voice_en_female_legal: 'bf_emma', // Female, en-GB, grade B-
  voice_us_female_analytic: 'af_nova', // Female, en-US
  voice_en_male_practical: 'bm_george', // Male, en-GB, grade C (stable)
  voice_en_male_commercial: 'am_michael', // Male, en-US, grade C+
  voice_en_male_advocate: 'bm_fable', // Male, en-GB, grade C
  voice_us_male_executive: 'am_onyx', // Male, en-US
  voice_us_male_field: 'am_adam', // Male, en-US
});

/** Deterministic gender fallback when a slot is not in the explicit map */
const KOKORO_GENDER_FALLBACK: Readonly<Record<'female' | 'male', string>> = Object.freeze({
  female: 'af_heart',
  male: 'am_michael',
});

/** Neutral deterministic fallback for unknown/neutral/unspecified slots */
const KOKORO_DEFAULT_VOICE = 'af_heart';

/** Deterministically resolve a Kokoro voice for a synthesis request */
export function resolveKokoroVoice(request: {
  voiceSlot: string;
  voiceProfile: { voiceSlot?: string; gender?: VoiceGender } | null | undefined;
}): string {
  const slotKey = (request.voiceSlot || request.voiceProfile?.voiceSlot || '').trim();
  if (slotKey && Object.prototype.hasOwnProperty.call(KOKORO_VOICE_BY_SLOT, slotKey)) {
    return KOKORO_VOICE_BY_SLOT[slotKey];
  }
  const gender = request.voiceProfile?.gender;
  if (gender === 'female' || gender === 'male') {
    return KOKORO_GENDER_FALLBACK[gender];
  }
  return KOKORO_DEFAULT_VOICE;
}
