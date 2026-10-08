/**
 * BuildTrack Video Factory - VS1 Deterministic Voice Publication Migration
 *
 * Gives EVERY voice profile an explicit, auditable publication record without
 * inventing evidence.
 *
 * Three deterministic outcomes, and nothing else:
 *
 *  1. The profile already declares `publication` — it is kept EXACTLY as
 *     authored. Migration never edits, upgrades or "repairs" a declared record.
 *
 *  2. The profile is one of the eight canonical Phase 4A Kokoro fixtures
 *     (matching id AND voiceSlot AND a documented preset in
 *     `KOKORO_VOICE_BY_SLOT`) — it becomes an explicit LOCAL KOKORO profile:
 *     engine `kokoro`, the pinned ONNX model, the pinned `kokoro-js` runtime,
 *     the preset voice as its acoustic source, provider-preset consent,
 *     Apache-2.0 commercial-rights evidence and an audition approval that is
 *     flagged `inherited: true` because it comes from the accepted baseline,
 *     not from a new listening test. Publication state: `approved`, so existing
 *     production behaviour does not regress.
 *
 *  3. Anything else — a new or custom voice with no declared record — becomes a
 *     DRAFT skeleton: `publicationState: 'draft'`, `origin: 'custom_unverified'`
 *     and NO engine, NO acoustic source, NO consent and NO rights evidence.
 *     Migration refuses to fabricate any of them, so the publication gate
 *     blocks production until a human authors the evidence.
 *
 * No I/O, no network, no clock: the recorded timestamps are fixed constants, so
 * migrating the same registry twice yields byte-identical records.
 */

import {
  VOICE_PUBLICATION_SCHEMA_VERSION,
  VoiceConsentRecord,
  VoiceProfile,
  VoicePublicationProfile,
  VoiceRegistry,
  VoiceRightsEvidence,
} from './voice-types.js';
import {
  KOKORO_CACHE_DIR,
  KOKORO_DTYPE,
  KOKORO_ENGINE_ID,
  KOKORO_JS_VERSION,
  KOKORO_MODEL_ID,
  KOKORO_VOICE_BY_SLOT,
} from './kokoro-voice-identity.js';

/** Identifier of this migration, recorded in every record it writes. */
export const VS1_MIGRATION_ID = 'vs1-legacy-kokoro-migration';

/**
 * Fixed timestamp recorded by the migration.
 *
 * A migration must be deterministic, so it never reads the clock: this is the
 * date the VS1 migration was written and the date its evidence statements were
 * checked against the pinned dependencies in this repository.
 */
export const VS1_MIGRATION_RECORDED_AT = '2026-10-08T00:00:00.000Z';

/** Date-only form of the above, used for `accessedAt` evidence fields. */
export const VS1_EVIDENCE_ACCESSED_AT = '2026-10-08';

/**
 * The canonical Phase 4A fixtures that are allowed to inherit an approved
 * local-Kokoro publication record.
 *
 * This is an explicit allowlist, NOT "whatever is in the default registry": a
 * profile has to match BOTH the id and the voiceSlot of one of these pairs (and
 * the slot has to have a documented Kokoro preset) before it can inherit
 * approval. Re-using a legacy slot with a different id — or a legacy id with a
 * different slot — migrates as an unverified custom draft instead.
 */
export const LEGACY_KOKORO_FIXTURES: ReadonlyArray<{ readonly id: string; readonly voiceSlot: string }> =
  Object.freeze([
    { id: 'vp_en_female_authority_v1', voiceSlot: 'voice_en_female_authority' },
    { id: 'vp_en_male_practical_v1', voiceSlot: 'voice_en_male_practical' },
    { id: 'vp_en_male_commercial_v1', voiceSlot: 'voice_en_male_commercial' },
    { id: 'vp_en_female_legal_v1', voiceSlot: 'voice_en_female_legal' },
    { id: 'vp_en_male_advocate_v1', voiceSlot: 'voice_en_male_advocate' },
    { id: 'vp_us_female_analytic_v1', voiceSlot: 'voice_us_female_analytic' },
    { id: 'vp_us_male_executive_v1', voiceSlot: 'voice_us_male_executive' },
    { id: 'vp_us_male_field_v1', voiceSlot: 'voice_us_male_field' },
  ].map((entry) => Object.freeze(entry)));

const LEGACY_FIXTURE_PAIRS: ReadonlySet<string> = new Set(
  LEGACY_KOKORO_FIXTURES.map((entry) => `${entry.id}::${entry.voiceSlot}`)
);

/**
 * Documented engine identity of the local Kokoro production path.
 *
 * Every value here is read from the pinned dependency, not guessed:
 * `kokoro-js` is pinned exactly in package.json (`KOKORO_JS_VERSION`), the ONNX
 * model id is the one the adapter loads (`KOKORO_MODEL_ID`), and `modelRevision`
 * restates the model version already pinned inside that id. No upstream
 * revision hash was fetched in VS1 — this repository performs no network calls.
 */
export const LOCAL_KOKORO_ENGINE_IDENTITY = Object.freeze({
  engine: 'kokoro',
  modelId: KOKORO_MODEL_ID,
  modelRevision: 'v1.0',
  runtimeId: KOKORO_ENGINE_ID,
  runtimeVersion: KOKORO_JS_VERSION,
  provider: 'hexgrad/kokoro (runtime) — onnx-community ONNX model export',
  requiresNetwork: false,
  localOnly: true,
  extra: Object.freeze({ dtype: KOKORO_DTYPE, cacheDir: KOKORO_CACHE_DIR }),
}) satisfies VoicePublicationProfile['engine'];

/**
 * Commercial-rights evidence for the local Kokoro path.
 *
 * Verified against the installed, exactly pinned dependency: `kokoro-js@1.2.1`
 * declares `"license": "Apache-2.0"` in its package.json and ships the full
 * Apache-2.0 text at `node_modules/kokoro-js/LICENSE`; `commercialUseStatement`
 * is quoted verbatim from section 2 of that file. `evidenceUrl` is the
 * first-party homepage the pinned package declares for itself.
 *
 * Limitation, stated rather than hidden: the upstream model card for
 * `onnx-community/Kokoro-82M-v1.0-ONNX` was NOT re-fetched in VS1 (this
 * repository performs no network calls). The in-repo record of that model's
 * licence is `tools/provision-tts.mjs`, which pins the same model id and
 * documents it as Apache-2.0. The publication gate reports the missing
 * re-fetch as a warning, and as a blocking error under
 * `strictFirstPartyEvidence`.
 */
export const LOCAL_KOKORO_RIGHTS_EVIDENCE: VoiceRightsEvidence = Object.freeze({
  sourceProvider: 'hexgrad/kokoro — kokoro-js npm package (onnx-community ONNX model export)',
  licenseName: 'Apache-2.0',
  evidenceUrl: 'https://github.com/hexgrad/kokoro',
  evidenceKind: 'license_text',
  accessedAt: VS1_EVIDENCE_ACCESSED_AT,
  commercialUse: 'permitted',
  commercialUseStatement:
    'Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.',
  localEvidencePath: 'node_modules/kokoro-js/LICENSE',
});

/**
 * Honest statement of what a migrated Kokoro audition approval rests on.
 *
 * The accepted final-product run exercised the cache-only local Kokoro path end
 * to end and recorded per-turn WAV identity for the slots it used
 * (`EVIDENCE/final-product/audio-verification.json`: engine `kokoro-js`, model
 * `onnx-community/Kokoro-82M-v1.0-ONNX`, resolved preset voices `am_onyx`,
 * `af_heart`, `af_nova`). The remaining canonical slots are declared from the
 * same pinned model and the same `KOKORO_VOICE_BY_SLOT` map, but this
 * repository holds no per-voice listening evidence for them. That is exactly why
 * the migrated audition is flagged `inherited: true` and reported as a warning.
 */
export const LOCAL_KOKORO_AUDITION_BASIS =
  'Legacy Phase 4A Kokoro fixture. Approval is INHERITED from the accepted baseline: the cache-only local Kokoro path was exercised end to end by the final-product acceptance run, which recorded per-turn WAV identity for the slots it used (EVIDENCE/final-product/audio-verification.json — engine kokoro-js, model onnx-community/Kokoro-82M-v1.0-ONNX, preset voices am_onyx/af_heart/af_nova). The remaining canonical slots are declared from the same pinned model and the same KOKORO_VOICE_BY_SLOT map, but no per-voice listening evidence is recorded in this repository. No new first-party audition was performed in VS1.';

/** Evidence artifact the inherited audition approval points at. */
export const LOCAL_KOKORO_AUDITION_EVIDENCE_PATH = 'EVIDENCE/final-product/audio-verification.json';

/**
 * True when a profile is one of the canonical Phase 4A Kokoro fixtures and may
 * therefore inherit an approved local-Kokoro publication record.
 *
 * Deterministic and deliberately strict: id AND voiceSlot must match an
 * allowlisted pair, and the slot must have a documented Kokoro preset voice.
 */
export function isLegacyKokoroFixture(profile: unknown): boolean {
  if (!profile || typeof profile !== 'object') return false;
  const candidate = profile as Partial<VoiceProfile>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const voiceSlot = typeof candidate.voiceSlot === 'string' ? candidate.voiceSlot.trim() : '';
  if (!id || !voiceSlot) return false;
  if (!LEGACY_FIXTURE_PAIRS.has(`${id}::${voiceSlot}`)) return false;
  return Object.prototype.hasOwnProperty.call(KOKORO_VOICE_BY_SLOT, voiceSlot);
}

/** The documented Kokoro preset voice for a legacy fixture slot. */
export function legacyKokoroPresetVoiceFor(voiceSlot: string): string | null {
  const slot = typeof voiceSlot === 'string' ? voiceSlot.trim() : '';
  if (!slot || !Object.prototype.hasOwnProperty.call(KOKORO_VOICE_BY_SLOT, slot)) return null;
  return KOKORO_VOICE_BY_SLOT[slot];
}

/**
 * Builds the approved local-Kokoro publication record for a legacy fixture.
 * Deterministic: same input profile -> byte-identical record.
 */
export function legacyKokoroPublicationFor(
  profile: VoiceProfile,
  recordedAt: string = VS1_MIGRATION_RECORDED_AT
): VoicePublicationProfile {
  const presetVoiceId = legacyKokoroPresetVoiceFor(profile.voiceSlot) ?? 'af_heart';

  const consent: VoiceConsentRecord = {
    /*
     * A Kokoro preset voice is synthetic: no private individual's recording is
     * cloned, so there is no human speaker to obtain consent from and none is
     * invented. The right to use it commercially comes from the model
     * provider's published licence, which is what `subject` says and what the
     * rights evidence below proves.
     */
    subject: 'model_provider_preset',
    authorizedSpeaker: `${presetVoiceId} — Kokoro-82M synthetic preset voice (no private individual's recording is cloned)`,
    ownerConfirmed: true,
    confirmedBy: VS1_MIGRATION_ID,
    recordedAt,
    scope: ['internal_review', 'commercial_video_publication'],
    revoked: false,
  };

  return {
    schemaVersion: VOICE_PUBLICATION_SCHEMA_VERSION,
    engine: { ...LOCAL_KOKORO_ENGINE_IDENTITY, extra: { ...LOCAL_KOKORO_ENGINE_IDENTITY.extra } },
    acousticSource: {
      kind: 'preset_model_voice',
      presetVoiceId,
      bundledBy: `${KOKORO_ENGINE_ID}@${KOKORO_JS_VERSION} npm package (voices/${presetVoiceId}.bin)`,
    },
    consent,
    rights: { ...LOCAL_KOKORO_RIGHTS_EVIDENCE },
    audition: {
      state: 'approved',
      approver: VS1_MIGRATION_ID,
      reviewedAt: recordedAt,
      inherited: true,
      reason: LOCAL_KOKORO_AUDITION_BASIS,
      evidencePath: LOCAL_KOKORO_AUDITION_EVIDENCE_PATH,
    },
    publicationState: 'approved',
    origin: 'legacy_kokoro_fixture',
    provenance: {
      migratedFrom: 'phase4a-default-registry',
      migratedBy: VS1_MIGRATION_ID,
      migratedAt: recordedAt,
      notes:
        'Migrated from a Phase 4A registry fixture that declared no publication record. Engine identity, preset voice, provider-preset consent and Apache-2.0 rights evidence are taken from the exactly pinned local Kokoro dependency (node_modules/kokoro-js/LICENSE, package.json license=Apache-2.0); the model licence is the one tools/provision-tts.mjs already records for the pinned model id. The audition approval is inherited from the accepted baseline, not from a new first-party listening test, and the upstream model card was not re-fetched (no network); the publication gate reports both as warnings and blocks them under strictFirstPartyEvidence.',
    },
    updatedAt: recordedAt,
  };
}

/**
 * Builds the DRAFT skeleton for a voice that declared nothing.
 *
 * Deliberately incomplete: no engine identity, no acoustic source, no consent,
 * no rights evidence. An unverified voice is never marked publication-approved.
 */
export function unverifiedVoicePublicationFor(recordedAt: string = VS1_MIGRATION_RECORDED_AT): VoicePublicationProfile {
  return {
    schemaVersion: VOICE_PUBLICATION_SCHEMA_VERSION,
    audition: { state: 'not_tested' },
    publicationState: 'draft',
    origin: 'custom_unverified',
    provenance: {
      migratedFrom: 'no-publication-record',
      migratedBy: VS1_MIGRATION_ID,
      migratedAt: recordedAt,
      notes:
        'This profile declared no publication record. VS1 migration writes a DRAFT skeleton only: it never invents an engine identity, a reference-audio hash, owner consent or commercial-rights evidence, and it never marks an unverified voice approved. Production stays blocked until every element is authored and evaluateVoicePublicationGate() allows it.',
    },
    updatedAt: recordedAt,
  };
}

/** Options for the migration. Both defaults keep it deterministic. */
export interface VoicePublicationMigrationOptions {
  /** Timestamp recorded in migrated records. Default `VS1_MIGRATION_RECORDED_AT`. */
  recordedAt?: string;
}

/** Result of migrating one profile. */
export interface VoicePublicationMigrationResult {
  /**
   * The profile to use downstream. The SAME object when nothing was migrated;
   * a NEW object (input never mutated) when a record was created.
   */
  profile: VoiceProfile;
  /** Whether this call created a publication record. */
  migrated: boolean;
  /** Whether the profile was recognised as a canonical legacy Kokoro fixture. */
  legacyKokoroFixture: boolean;
  /** The publication record now attached to `profile` (undefined when none). */
  publication?: VoicePublicationProfile;
}

/**
 * Deterministically completes the publication record of one profile.
 * Never mutates the input, never reads the clock, never invents evidence.
 */
export function migrateVoiceProfileForPublication(
  profile: VoiceProfile,
  options: VoicePublicationMigrationOptions = {}
): VoicePublicationMigrationResult {
  const recordedAt =
    typeof options.recordedAt === 'string' && options.recordedAt.trim()
      ? options.recordedAt.trim()
      : VS1_MIGRATION_RECORDED_AT;

  if (!profile || typeof profile !== 'object') {
    return { profile, migrated: false, legacyKokoroFixture: false, publication: undefined };
  }

  // 1. An authored record wins. Migration never edits declared evidence.
  if (profile.publication && typeof profile.publication === 'object') {
    return {
      profile,
      migrated: false,
      legacyKokoroFixture: isLegacyKokoroFixture(profile),
      publication: profile.publication,
    };
  }

  /*
   * 1b. A publication field that is present but MALFORMED (a string, a number,
   * an array) is never silently replaced by a migrated record — not even for a
   * legacy fixture, which would otherwise inherit an approval over the top of a
   * corrupt declaration. The profile is returned without a usable record, so the
   * gate reports MISSING_PUBLICATION_RECORD and blocks.
   */
  if (profile.publication !== undefined && profile.publication !== null) {
    return {
      profile,
      migrated: false,
      legacyKokoroFixture: isLegacyKokoroFixture(profile),
      publication: undefined,
    };
  }

  // 2. Canonical legacy Kokoro fixture -> explicit approved local Kokoro profile.
  if (isLegacyKokoroFixture(profile)) {
    const publication = legacyKokoroPublicationFor(profile, recordedAt);
    return { profile: { ...profile, publication }, migrated: true, legacyKokoroFixture: true, publication };
  }

  // 3. Anything else -> unverified draft. Never approved.
  const publication = unverifiedVoicePublicationFor(recordedAt);
  return { profile: { ...profile, publication }, migrated: true, legacyKokoroFixture: false, publication };
}

/**
 * Deterministically completes every profile of a registry, preserving order.
 * Returns new objects only for the profiles that were migrated; the input
 * registry is never mutated.
 */
export function migrateVoiceRegistryForPublication(
  registry: VoiceRegistry | readonly VoiceProfile[],
  options: VoicePublicationMigrationOptions = {}
): VoiceProfile[] {
  if (!Array.isArray(registry)) return [];
  return registry.map((profile) => migrateVoiceProfileForPublication(profile, options).profile);
}
