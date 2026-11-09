/**
 * BuildTrack Video Factory - VS1 Voice Acoustic Identity
 *
 * Derives the part of a commercial voice profile that actually changes the
 * produced waveform, so the synthesis reuse key can carry it:
 *
 *   engine family + model id + pinned model revision + runtime pin
 *   + reference-audio hash (cloned voice) OR preset voice id (model preset)
 *
 * Rights, consent, audition and publication state are deliberately NOT part of
 * this identity: they do not change a single sample. They are enforced by
 * `evaluateVoicePublicationGate()` instead, which blocks production rather than
 * quietly invalidating a cache entry.
 *
 * Pure and deterministic — no I/O, no clock, no network.
 */

import {
  VoiceAcousticIdentity,
  VoiceProfile,
  VoicePublicationProfile,
} from './voice-types.js';
import { migrateVoiceProfileForPublication } from './voice-publication-migration.js';

/** Identity used when a profile declares nothing at all. */
export const UNDECLARED_VOICE_ACOUSTIC_IDENTITY: VoiceAcousticIdentity = Object.freeze({
  engine: 'undeclared',
  modelId: null,
  modelRevision: null,
  runtimeId: null,
  runtimeVersion: null,
  sourceKind: 'undeclared',
  presetVoiceId: null,
  referenceSha256: null,
  acousticSourceId: 'undeclared',
});

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Deterministic acoustic identity of a publication record.
 * Field order is fixed, so `JSON.stringify` of the result is stable and can be
 * hashed directly.
 */
export function acousticIdentityFromPublication(
  publication: VoicePublicationProfile | null | undefined
): VoiceAcousticIdentity {
  if (!publication || typeof publication !== 'object') {
    return { ...UNDECLARED_VOICE_ACOUSTIC_IDENTITY };
  }

  const engine = publication.engine && typeof publication.engine === 'object' ? publication.engine : undefined;
  const source =
    publication.acousticSource && typeof publication.acousticSource === 'object'
      ? publication.acousticSource
      : undefined;

  const engineKind =
    engine && (engine.engine === 'kokoro' || engine.engine === 'chatterbox' || engine.engine === 'external')
      ? engine.engine
      : 'undeclared';

  let sourceKind: VoiceAcousticIdentity['sourceKind'] = 'undeclared';
  let presetVoiceId: string | null = null;
  let referenceSha256: string | null = null;

  if (source && source.kind === 'preset_model_voice') {
    sourceKind = 'preset_model_voice';
    presetVoiceId = nonEmptyString(source.presetVoiceId);
  } else if (source && source.kind === 'cloned_reference_audio') {
    sourceKind = 'cloned_reference_audio';
    referenceSha256 = nonEmptyString(source.referenceAudio?.sha256);
  }

  let acousticSourceId = 'undeclared';
  if (sourceKind === 'cloned_reference_audio') {
    acousticSourceId = referenceSha256 ? `ref:${referenceSha256}` : 'ref:unhashed';
  } else if (sourceKind === 'preset_model_voice') {
    acousticSourceId = presetVoiceId ? `preset:${presetVoiceId}` : 'preset:unidentified';
  }

  return {
    engine: engineKind,
    modelId: nonEmptyString(engine?.modelId),
    modelRevision: nonEmptyString(engine?.modelRevision),
    runtimeId: nonEmptyString(engine?.runtimeId),
    runtimeVersion: nonEmptyString(engine?.runtimeVersion),
    sourceKind,
    presetVoiceId,
    referenceSha256,
    acousticSourceId,
  };
}

/** Options for deriving a profile's acoustic identity. */
export interface VoiceAcousticIdentityOptions {
  /**
   * Apply the deterministic legacy migration first when the profile declares no
   * publication record. Default `true`, so a legacy Kokoro fixture yields the
   * SAME identity whether or not the caller resolved it through the resolver —
   * otherwise the same physical voice would produce two different reuse keys.
   */
  migrateLegacy?: boolean;
}

/** Deterministic acoustic identity of a voice profile. */
export function voiceAcousticIdentityOf(
  profile: VoiceProfile | null | undefined,
  options: VoiceAcousticIdentityOptions = {}
): VoiceAcousticIdentity {
  if (!profile || typeof profile !== 'object') {
    return { ...UNDECLARED_VOICE_ACOUSTIC_IDENTITY };
  }
  if (profile.publication && typeof profile.publication === 'object') {
    return acousticIdentityFromPublication(profile.publication);
  }
  if (options.migrateLegacy === false) {
    return { ...UNDECLARED_VOICE_ACOUSTIC_IDENTITY };
  }
  return acousticIdentityFromPublication(migrateVoiceProfileForPublication(profile).publication);
}
