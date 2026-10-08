/**
 * VS1 TEST FIXTURES — commercial voice profiles for the publication gate.
 *
 * Test infrastructure only. Two complete, deliberately contrasting voices:
 *
 *  - `approvedOwnVoiceProfile()`: a FIRST-PARTY OWN VOICE. A local Chatterbox
 *    engine clones a reference recording of the operator's own voice, with
 *    recorded consent, a signed consent artifact, first-party rights evidence,
 *    an approved audition and `publicationState: 'approved'`. This is what a
 *    publishable production voice looks like.
 *
 *  - the migrated Phase 4A Kokoro fixtures, produced by the real migration in
 *    `voice-publication-migration.ts` (never hand-written here, so the tests
 *    exercise the shipped migration path rather than a copy of it).
 *
 * Every hash below is the real SHA-256 of the fixture descriptor string named in
 * the comment, so a test that mutates a hash is mutating it to another
 * well-formed, genuinely different digest.
 *
 * The rights `evidenceUrl` uses the RFC 6761 reserved `.invalid` TLD on purpose:
 * these fixtures are synthetic and must never look like a real permission grant.
 */

import type {
  VoiceProfile,
  VoicePublicationProfile,
  VoiceReferenceAudio,
} from '../../packages/core/src/scenario/voice-types.js';

/** sha256('vs1-own-voice-reference-take-01') */
export const OWN_VOICE_REFERENCE_SHA256 = '6d56830ac9693156d339040aa45e4fac875f2254c42cf3a39bdbbcf2f79bc685';

/** sha256('vs1-own-voice-reference-take-02') — a DIFFERENT recording. */
export const OWN_VOICE_REFERENCE_SHA256_ALT = 'd530ec51dc840bdbc61101f6ca269ce3e9d4f2315f0bb8c89aa36dd014625361';

/** sha256('vs1-own-voice-audition-sample') */
export const OWN_VOICE_AUDITION_SAMPLE_SHA256 = '19883cd44e70de5d300f5921a6d4961954eb3924e4c477aee8383938060eb086';

/** Reference-audio identity of the own-voice fixture. */
export const OWN_VOICE_REFERENCE: VoiceReferenceAudio = {
  path: 'assets/voices/own-voice/reference-take-01.wav',
  sha256: OWN_VOICE_REFERENCE_SHA256,
  durationSeconds: 12.48,
  sampleRate: 48000,
  channels: 1,
  container: 'wav',
  capturedAt: '2026-10-06T10:15:00Z',
  speakerLabel: 'Operator own voice, take 01',
};

/** The complete publication record of an approved first-party own voice. */
export function approvedOwnVoicePublication(): VoicePublicationProfile {
  return {
    schemaVersion: '1.0.0',
    engine: {
      engine: 'chatterbox',
      modelId: 'local/chatterbox-voice-clone',
      modelRevision: 'v0.5.0',
      runtimeId: 'chatterbox-local',
      runtimeVersion: '0.5.0',
      provider: 'first-party local runtime',
      requiresNetwork: false,
      localOnly: true,
    },
    acousticSource: {
      kind: 'cloned_reference_audio',
      referenceAudio: { ...OWN_VOICE_REFERENCE },
    },
    consent: {
      subject: 'recorded_speaker',
      authorizedSpeaker: 'Operator (own voice, first-party recording)',
      ownerConfirmed: true,
      confirmedBy: 'vs1-fixture-author',
      recordedAt: '2026-10-06T10:20:00Z',
      scope: ['internal_review', 'commercial_video_publication', 'synthetic_voice_cloning'],
      revoked: false,
      evidencePath: 'assets/voices/own-voice/consent-signed.md',
    },
    rights: {
      sourceProvider: 'first-party recording (operator-owned)',
      licenseName: 'First-party own-voice written release',
      evidenceUrl: 'https://rights.example.invalid/own-voice-release-01',
      evidenceKind: 'written_permission',
      accessedAt: '2026-10-06',
      commercialUse: 'permitted',
      commercialUseStatement:
        'I own this recording and grant BuildTrack Video Factory a perpetual, irrevocable right to synthesize and publish it commercially until I revoke this consent in writing.',
      localEvidencePath: 'assets/voices/own-voice/rights-release-01.md',
    },
    audition: {
      state: 'approved',
      approver: 'vs1-fixture-author',
      reviewedAt: '2026-10-06T11:00:00Z',
      reason: 'Reference take 01 is clean, intelligible and matches the intended on-brand tone.',
      samplePath: 'assets/voices/own-voice/audition-take-01.wav',
      sampleSha256: OWN_VOICE_AUDITION_SAMPLE_SHA256,
    },
    publicationState: 'approved',
    origin: 'authored_first_party',
    updatedAt: '2026-10-06T11:00:00Z',
  };
}

/** A complete, publishable first-party own-voice profile. */
export function approvedOwnVoiceProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    id: 'vp_own_voice_operator_v1',
    voiceSlot: 'voice_own_operator',
    displayName: 'Operator Own Voice',
    description: 'First-party own-voice clone used to prove the approved publication path.',
    primaryLanguage: 'en-GB',
    languages: ['en-GB', 'en'],
    gender: 'neutral',
    roleHint: 'authority',
    synthesisHints: { rate: 'medium', pitch: 'medium', style: 'confident' },
    enabled: true,
    version: '1.0.0',
    createdAt: '2026-10-06T10:00:00Z',
    publication: approvedOwnVoicePublication(),
    ...overrides,
  };
}

/**
 * Returns a deep clone of a profile with `publication` patched field-by-field.
 * `undefined` values DELETE a field, which is how the tests remove evidence.
 */
export function withPublication(
  profile: VoiceProfile,
  patch: Record<string, unknown> | undefined
): VoiceProfile {
  const clone = JSON.parse(JSON.stringify(profile)) as VoiceProfile & {
    publication: Record<string, unknown>;
  };
  if (patch === undefined) {
    delete clone.publication;
    return clone;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete clone.publication[key];
    } else {
      clone.publication[key] = value;
    }
  }
  return clone;
}

/** Deep clone of any publication sub-record with fields patched or deleted. */
export function patchPublicationField<T extends Record<string, unknown>>(
  profile: VoiceProfile,
  field: 'engine' | 'acousticSource' | 'consent' | 'rights' | 'audition',
  patch: Record<string, unknown> | undefined
): VoiceProfile {
  const clone = JSON.parse(JSON.stringify(profile)) as VoiceProfile & {
    publication: Record<string, Record<string, unknown> | undefined>;
  };
  if (patch === undefined) {
    delete clone.publication[field];
    return clone as VoiceProfile;
  }
  const existing = (clone.publication[field] ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete existing[key];
    } else {
      existing[key] = value;
    }
  }
  clone.publication[field] = existing;
  return clone as VoiceProfile;
}

/** Codes of the blocking findings of a report, for readable assertions. */
export function errorCodes(report: { findings: { severity: string; code: string }[] }): string[] {
  return report.findings.filter((f) => f.severity === 'error').map((f) => f.code);
}

/** Codes of the warning findings of a report. */
export function warningCodes(report: { findings: { severity: string; code: string }[] }): string[] {
  return report.findings.filter((f) => f.severity === 'warning').map((f) => f.code);
}
