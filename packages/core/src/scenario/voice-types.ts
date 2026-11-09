/**
 * BuildTrack Video Factory - Phase 4A Voice Profile Contract (+ VS1 commercial profile)
 *
 * Canonical, provider-neutral voice profile definition and structured error taxonomy.
 * No synthesis, no I/O, no network — pure configuration describing a voice that
 * later phases (4B) can use for real TTS.
 *
 * VS1 adds the COMMERCIAL VOICE PROFILE & RIGHTS GATE contract on top of the
 * Phase 4A profile: an auditable engine identity, a reference-audio (or preset
 * model voice) identity, recorded owner consent, first-party commercial-rights
 * evidence, an audition state and a publication state. Every field below is
 * provider/engine-neutral — `kokoro`, `chatterbox` and `external` are engine
 * families, never vendor API shapes — and nothing here performs I/O.
 *
 * The sub-records are OPTIONAL at the type level on purpose: a voice must be
 * representable while its evidence is still being collected (`draft`), and a
 * legacy fixture must stay readable before it is migrated. Completeness is not
 * enforced by "required fields" but by `evaluateVoicePublicationGate()`, which
 * blocks production whenever any of them is missing or invalid.
 */

/** Gender / vocal presentation metadata */
export type VoiceGender = 'female' | 'male' | 'neutral' | 'unspecified';

/** Provider-neutral synthesis hints — never provider-specific API fields */
export interface VoiceSynthesisHints {
  /** Relative speaking rate hint: slow | medium | fast, or numeric multiplier */
  rate?: 'slow' | 'medium' | 'fast' | number;
  /** Relative pitch hint */
  pitch?: 'low' | 'medium' | 'high' | number;
  /** Style / emotion guidance for future synthesizer */
  style?: string;
  /** Optional stability / similarity hints (provider-neutral) */
  stabilityHint?: number;
  /** Additional free-form but provider-neutral hints */
  extra?: Record<string, string | number | boolean>;
}

/* ------------------------------------------------------------------ */
/*  VS1 — Commercial voice profile & publication rights contract       */
/* ------------------------------------------------------------------ */

/** Schema version of a `VoicePublicationProfile` record. */
export const VOICE_PUBLICATION_SCHEMA_VERSION = '1.0.0' as const;

/**
 * Engine families this factory can produce a voice with.
 *
 * Deliberately neutral: `kokoro` and `chatterbox` are local engines with a
 * pinned model, `external` is any other declared provider. No vendor field
 * names, no API keys, no network configuration.
 */
export type VoiceEngineKind = 'kokoro' | 'chatterbox' | 'external';

/**
 * Auditable identity of the engine/model that produces this voice.
 *
 * `modelId` is required whenever the engine is declared at all: a voice with no
 * model identity cannot be reproduced, so it cannot be approved. `modelRevision`
 * is the optional PIN (tag, version or content hash) that makes the identity
 * reproducible over time.
 */
export interface VoiceEngineIdentity {
  /** Engine family. */
  engine: VoiceEngineKind;
  /** Model identifier, e.g. `onnx-community/Kokoro-82M-v1.0-ONNX`. */
  modelId: string;
  /** Optional pinned revision/version of the model (tag, semver or content hash). */
  modelRevision?: string;
  /** Runtime that loads the model, e.g. `kokoro-js`. */
  runtimeId?: string;
  /** Exact runtime pin, e.g. `1.2.1`. */
  runtimeVersion?: string;
  /** Declared provider/publisher. REQUIRED by the gate for `external` engines. */
  provider?: string;
  /** Whether production with this engine needs network access. */
  requiresNetwork?: boolean;
  /** Whether the engine runs fully locally. */
  localOnly?: boolean;
  /** Additional provider-neutral identity facts, e.g. `{ dtype: 'q8' }`. */
  extra?: Record<string, string | number | boolean>;
}

/**
 * Reference-audio identity for a cloned/own voice.
 *
 * `path` MUST be a safe repo-relative path (never absolute, never traversing);
 * `sha256` is the content hash of exactly those bytes, so a replaced or edited
 * reference recording is detectable and invalidates synthesis reuse.
 */
export interface VoiceReferenceAudio {
  /** Safe relative path to the reference recording. */
  path: string;
  /** SHA-256 of the reference file, 64 lowercase hex characters. */
  sha256: string;
  /** Duration in seconds (> 0). */
  durationSeconds: number;
  /** Sample rate in Hz (> 0). */
  sampleRate: number;
  /** Channel count (>= 1). */
  channels: number;
  /** Container/codec, e.g. `wav`. */
  container?: string;
  /** ISO-8601 date the reference was captured. */
  capturedAt?: string;
  /** Human label for the speaker in the reference recording. */
  speakerLabel?: string;
}

/**
 * Acoustic source of a voice: either a cloned recording of a consenting
 * speaker, or a preset voice that ships inside a pinned model.
 *
 * The distinction is what makes the consent rule honest — a preset model voice
 * has no private individual to consent, so its consent record names the model
 * provider instead of inventing a human signature.
 */
export interface VoiceClonedReferenceSource {
  kind: 'cloned_reference_audio';
  referenceAudio: VoiceReferenceAudio;
}

export interface VoicePresetModelSource {
  kind: 'preset_model_voice';
  /** Preset voice id inside the model/runtime, e.g. `af_heart`. */
  presetVoiceId: string;
  /** What ships the preset, e.g. `kokoro-js@1.2.1 npm package`. */
  bundledBy: string;
}

export type VoiceAcousticSource = VoiceClonedReferenceSource | VoicePresetModelSource;

/**
 * What the consent covers. The gate requires the scope that matches the
 * intended use; a consent recorded for internal review never authorises
 * commercial publication.
 */
export type VoiceConsentScope =
  | 'internal_review'
  | 'commercial_video_publication'
  | 'synthetic_voice_cloning'
  | 'broadcast'
  | 'paid_advertising'
  | 'third_party_licensing';

/**
 * Who the consent was obtained from:
 * - `recorded_speaker`: a real person whose recording is cloned.
 * - `model_provider_preset`: no private individual is cloned; the right comes
 *   from the model provider's published licence.
 */
export type VoiceConsentSubject = 'recorded_speaker' | 'model_provider_preset';

/** Recorded owner/authorized-speaker consent, including revocation state. */
export interface VoiceConsentRecord {
  /** What kind of rights-holder this consent comes from. */
  subject: VoiceConsentSubject;
  /** The authorized speaker (a named person, or the provider/preset identity). */
  authorizedSpeaker: string;
  /** Explicit confirmation. MUST be the boolean `true`; never inferred. */
  ownerConfirmed: boolean;
  /** Who recorded the confirmation (auditable actor, not the speaker). */
  confirmedBy: string;
  /** ISO-8601 timestamp the consent was recorded. */
  recordedAt: string;
  /** Uses the consent covers. Must include the intended use. */
  scope: VoiceConsentScope[];
  /** Revocation state. `true` blocks production immediately and permanently. */
  revoked: boolean;
  /** ISO-8601 timestamp of revocation, when revoked. */
  revokedAt?: string;
  /** Why the consent was revoked. */
  revocationReason?: string;
  /**
   * Safe relative path to the consent artifact (signed statement, recording
   * log). REQUIRED by the gate for `recorded_speaker` subjects: a human voice
   * clone without an artifact is not auditable consent.
   */
  evidencePath?: string;
}

/**
 * Commercial-use status of the voice/model.
 *
 * `unknown` and `not_stated` are first-class values: a licence that is silent
 * about commerce is NOT permission, and the gate treats silence as blocking.
 */
export type VoiceCommercialUseStatus =
  | 'permitted'
  | 'conditional'
  | 'prohibited'
  | 'unknown'
  | 'not_stated';

/** First-party evidence that this voice may be used commercially. */
export interface VoiceRightsEvidence {
  /** Who published the voice/model, e.g. `hexgrad/kokoro`. */
  sourceProvider: string;
  /** Licence name, e.g. `Apache-2.0`. */
  licenseName: string;
  /** First-party URL where the licence/permission is published. */
  evidenceUrl: string;
  /** What kind of first-party evidence `evidenceUrl` is. */
  evidenceKind?:
    | 'license_text'
    | 'model_card'
    | 'terms_of_service'
    | 'written_permission'
    | 'contract';
  /** ISO-8601 date the evidence was actually accessed/verified. */
  accessedAt: string;
  /** Explicit commercial-use status. Only `permitted` passes the gate. */
  commercialUse: VoiceCommercialUseStatus;
  /** Verbatim quote backing `commercialUse`, where one exists. */
  commercialUseStatement?: string;
  /** Conditions attached to a `conditional` grant. */
  conditions?: string;
  /** Safe relative path to a locally held copy of the evidence. */
  localEvidencePath?: string;
}

/** Audition state of the voice. */
export type VoiceAuditionState = 'not_tested' | 'approved' | 'rejected';

/** Who listened to the voice and what they decided. */
export interface VoiceAuditionRecord {
  state: VoiceAuditionState;
  /** Named approver. REQUIRED by the gate for an `approved` state. */
  approver?: string;
  /** ISO-8601 timestamp of the decision. REQUIRED for `approved`. */
  reviewedAt?: string;
  /** Why the voice was approved or rejected. */
  reason?: string;
  /** Safe relative path to the audition sample that was judged. */
  samplePath?: string;
  /** SHA-256 of the audition sample. */
  sampleSha256?: string;
  /**
   * `true` when the approval is INHERITED from an already accepted baseline
   * rather than from a first-party audition recorded in this phase. The gate
   * reports this as a warning, and as an error under
   * `strictFirstPartyEvidence`.
   */
  inherited?: boolean;
  /** Safe relative path to the artifact the approval is based on. */
  evidencePath?: string;
}

/**
 * Publication state.
 * - `draft`: evidence incomplete, never usable in production.
 * - `review_only`: usable for internal review builds, NOT for publication.
 * - `approved`: usable in published production.
 */
export type VoicePublicationState = 'draft' | 'review_only' | 'approved';

/** How a publication record came to exist. */
export type VoicePublicationOrigin =
  | 'legacy_kokoro_fixture'
  | 'authored_first_party'
  | 'custom_unverified';

/** Deterministic provenance of a publication record (migration audit trail). */
export interface VoicePublicationProvenance {
  /** What the record was migrated from, e.g. `phase4a-default-registry`. */
  migratedFrom?: string;
  /** The migration/author that wrote the record. */
  migratedBy?: string;
  /** ISO-8601 timestamp the record was written. */
  migratedAt?: string;
  /** Truthful limitations of the record. */
  notes?: string;
}

/**
 * The VS1 commercial voice profile: everything needed to decide, with an audit
 * trail, whether this voice may be published.
 */
export interface VoicePublicationProfile {
  schemaVersion: string;
  /** Engine/model identity. Absent until declared. */
  engine?: VoiceEngineIdentity;
  /** Reference-audio or preset-voice identity. Absent until declared. */
  acousticSource?: VoiceAcousticSource;
  /** Owner/authorized-speaker consent. Absent until recorded. */
  consent?: VoiceConsentRecord;
  /** Commercial-rights evidence. Absent until verified. */
  rights?: VoiceRightsEvidence;
  /** Audition decision. Absent until somebody listened. */
  audition?: VoiceAuditionRecord;
  /** Publication state. Always present — `draft` until proven otherwise. */
  publicationState: VoicePublicationState;
  /** Where this record came from. */
  origin: VoicePublicationOrigin;
  /** Migration/authoring audit trail. */
  provenance?: VoicePublicationProvenance;
  /** ISO-8601 timestamp of the last change to this record. */
  updatedAt?: string;
}

/**
 * Deterministic ACOUSTIC identity derived from a publication record.
 *
 * This is exactly the part of the commercial profile that changes the produced
 * waveform, so it is what the synthesis reuse key must carry: engine family,
 * model id and pinned revision, runtime pin, and the reference hash (or preset
 * voice id). Rights/consent/publication state are NOT acoustic — they are
 * enforced by the publication gate instead.
 */
export interface VoiceAcousticIdentity {
  engine: VoiceEngineKind | 'undeclared';
  modelId: string | null;
  modelRevision: string | null;
  runtimeId: string | null;
  runtimeVersion: string | null;
  sourceKind: VoiceAcousticSource['kind'] | 'undeclared';
  presetVoiceId: string | null;
  referenceSha256: string | null;
  /** Stable single-string identity: `ref:<sha256>` / `preset:<voiceId>` / `undeclared`. */
  acousticSourceId: string;
}

/* ------------------------------------------------------------------ */
/*  VS1 — Publication gate contract                                    */
/* ------------------------------------------------------------------ */

/** Structured gate finding codes. Every one of them is deterministic. */
export type VoicePublicationGateCode =
  | 'MISSING_PUBLICATION_RECORD'
  | 'MISSING_ENGINE_IDENTITY'
  | 'INVALID_ENGINE_KIND'
  | 'MISSING_MODEL_ID'
  | 'MISSING_EXTERNAL_PROVIDER'
  | 'MISSING_ACOUSTIC_SOURCE'
  | 'INVALID_ACOUSTIC_SOURCE_KIND'
  | 'UNSAFE_REFERENCE_PATH'
  | 'MISSING_REFERENCE_HASH'
  | 'INVALID_REFERENCE_HASH'
  | 'INVALID_REFERENCE_METRICS'
  | 'MISSING_PRESET_VOICE_ID'
  | 'MISSING_CONSENT'
  | 'CONSENT_NOT_CONFIRMED'
  | 'CONSENT_REVOKED'
  | 'CONSENT_SCOPE_INSUFFICIENT'
  | 'CONSENT_SUBJECT_MISMATCH'
  | 'MISSING_CONSENT_SPEAKER'
  | 'MISSING_CONSENT_TIMESTAMP'
  | 'INVALID_CONSENT_TIMESTAMP'
  | 'MISSING_CONSENT_EVIDENCE'
  | 'UNSAFE_CONSENT_EVIDENCE_PATH'
  | 'REVOCATION_STATE_INCONSISTENT'
  | 'MISSING_RIGHTS_EVIDENCE'
  | 'MISSING_RIGHTS_PROVIDER'
  | 'MISSING_LICENSE_NAME'
  | 'MISSING_RIGHTS_EVIDENCE_URL'
  | 'INVALID_RIGHTS_EVIDENCE_URL'
  | 'MISSING_RIGHTS_ACCESS_DATE'
  | 'INVALID_RIGHTS_ACCESS_DATE'
  | 'UNSAFE_RIGHTS_EVIDENCE_PATH'
  | 'COMMERCIAL_USE_NOT_PERMITTED'
  | 'COMMERCIAL_USE_NOT_ESTABLISHED'
  | 'RIGHTS_EVIDENCE_NOT_FIRST_PARTY'
  | 'MISSING_AUDITION'
  | 'AUDITION_NOT_TESTED'
  | 'AUDITION_REJECTED'
  | 'MISSING_AUDITION_APPROVER'
  | 'MISSING_AUDITION_TIMESTAMP'
  | 'INVALID_AUDITION_TIMESTAMP'
  | 'UNSAFE_AUDITION_SAMPLE_PATH'
  | 'AUDITION_APPROVAL_INHERITED'
  | 'PUBLICATION_STATE_NOT_APPROVED'
  | 'PUBLICATION_APPROVED_WITHOUT_EVIDENCE'
  | 'ENGINE_DECLARATION_MISMATCH'
  | 'MALFORMED_PROFILE';

/** Severity of a gate finding. Only `error` findings block. */
export type VoicePublicationGateSeverity = 'error' | 'warning';

/** One structured gate finding. */
export interface VoicePublicationGateFinding {
  severity: VoicePublicationGateSeverity;
  code: VoicePublicationGateCode;
  /** Stable rule id, e.g. `VOICE-PUB-030-CONSENT-REVOKED`. */
  ruleId: string;
  message: string;
  /** Dotted field the finding refers to, e.g. `consent.scope`. */
  field?: string;
}

/** Options for `evaluateVoicePublicationGate`. All defaults are documented. */
export interface VoicePublicationGateOptions {
  /**
   * Consent scope the intended use requires.
   * Default `commercial_video_publication` — this factory publishes videos.
   */
  requiredConsentScope?: VoiceConsentScope;
  /**
   * Publication state required to pass. Default `approved`.
   * Pass `review_only` for internal review builds, which a `review_only` voice
   * may serve but a published production may not.
   */
  requiredPublicationState?: VoicePublicationState;
  /**
   * Apply the deterministic legacy migration to a profile that carries no
   * publication record before evaluating it. Default `true`, which is what
   * keeps the Phase 4A Kokoro fixtures valid. Set `false` to evaluate exactly
   * what was handed in.
   */
  migrateLegacy?: boolean;
  /**
   * Escalate inherited/repo-recorded evidence to blocking errors: an approval
   * inherited from an accepted baseline, or rights evidence that was not
   * re-fetched from the provider in this phase. Default `false`.
   */
  strictFirstPartyEvidence?: boolean;
  /**
   * When provided, the declared engine identity must agree with the engine that
   * will actually synthesize. Not checked when omitted.
   */
  declaredEngineMustMatch?: {
    engineId: string;
    modelId?: string | null;
  };
}

/** Result of evaluating one voice profile against the publication gate. */
export interface VoicePublicationGateReport {
  profileId: string;
  voiceSlot: string;
  /** Whether production publication is allowed. */
  allowed: boolean;
  /** Inverse of `allowed`, for readability at call sites. */
  blocked: boolean;
  /** Publication state that was evaluated (post-migration). */
  publicationState: VoicePublicationState;
  /** Origin of the evaluated publication record. */
  origin: VoicePublicationOrigin | 'undeclared';
  /** Echo of the evaluated engine identity (null when undeclared). */
  engine: {
    engine: VoiceEngineKind | 'undeclared';
    modelId: string | null;
    modelRevision: string | null;
  };
  /** Deterministic acoustic identity used for synthesis reuse. */
  acousticIdentity: VoiceAcousticIdentity;
  /** Whether the evaluated record came from the legacy migration. */
  migrated: boolean;
  findings: VoicePublicationGateFinding[];
  errorCount: number;
  warningCount: number;
}

/** Result of evaluating a whole resolved voice set. */
export interface VoicePublicationGateBatchReport {
  /** Scenario/plan id when evaluated from a resolution. */
  scenarioId?: string;
  /** True only when EVERY evaluated voice is allowed. */
  allowed: boolean;
  /** Slots that are blocked, sorted. */
  blockedSlots: string[];
  /** One report per evaluated voice, in deterministic (sorted slot) order. */
  reports: VoicePublicationGateReport[];
  errorCount: number;
  warningCount: number;
}

/* ------------------------------------------------------------------ */
/*  Canonical voice profile                                            */
/* ------------------------------------------------------------------ */

/**
 * Canonical voice profile.
 * Describes configuration, not execution.
 */
export interface VoiceProfile {
  /** Stable, unique profile identifier, e.g. vp_en_female_authority_v1 */
  id: string;
  /** Canonical voice slot identifier used in Scenario and DialogueAudioPlan, e.g. voice_en_female_authority */
  voiceSlot: string;
  /** Human-readable display name */
  displayName: string;
  /** Optional longer description */
  description?: string;
  /** Primary language / locale, e.g. en-GB, en-US, en */
  primaryLanguage: string;
  /** List of compatible languages / locales, must include primaryLanguage */
  languages: string[];
  /** Gender metadata for UI and fallback reasoning */
  gender?: VoiceGender;
  /** Role hint, e.g. authority, commercial, practical, legal, advocate, analytic */
  roleHint?: string;
  /** Provider-neutral synthesis hints */
  synthesisHints?: VoiceSynthesisHints;
  /** Whether this profile is enabled for resolution */
  enabled: boolean;
  /** Schema version of this profile entry */
  version: string;
  /** Optional creation timestamp for auditing */
  createdAt?: string;
  /**
   * VS1 commercial voice profile: engine identity, reference-audio identity,
   * consent, commercial-rights evidence, audition state and publication state.
   *
   * Absent on legacy Phase 4A fixtures, which stay readable and are completed
   * by the deterministic migration in `voice-publication-migration.ts`.
   */
  publication?: VoicePublicationProfile;
}

/** Immutable registry type */
export type VoiceRegistry = readonly VoiceProfile[];

/** Structured error codes for voice resolution */
export type VoiceResolutionErrorCode =
  | 'UNKNOWN_VOICE_SLOT'
  | 'MISSING_PROFILE'
  | 'DUPLICATE_VOICE_ID'
  | 'DUPLICATE_VOICE_SLOT'
  | 'INCOMPATIBLE_LANGUAGE'
  | 'MALFORMED_REGISTRY_ENTRY'
  | 'REGISTRY_VALIDATION_FAILED'
  | 'DISABLED_VOICE_PROFILE'
  | 'INVALID_VOICE_SLOT_FORMAT'
  /** VS1: the resolved voice is not approved for published production. */
  | 'VOICE_PUBLICATION_BLOCKED';

/** Structured error for voice resolution failures */
export class VoiceResolutionError extends Error {
  public readonly code: VoiceResolutionErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: VoiceResolutionErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'VoiceResolutionError';
    this.code = code;
    this.details = details;
  }
}

/** Validation severity for registry validation */
export type VoiceRegistryFindingSeverity = 'error' | 'warning';

/** Category for registry findings */
export type VoiceRegistryFindingCategory =
  | 'duplicate'
  | 'malformed'
  | 'language'
  | 'integrity'
  /** VS1: the commercial publication record attached to a profile. */
  | 'publication'
  /** VS1: consent/rights evidence inside a publication record. */
  | 'rights';

/** Single finding during registry validation */
export interface VoiceRegistryFinding {
  severity: VoiceRegistryFindingSeverity;
  category: VoiceRegistryFindingCategory;
  ruleId: string;
  message: string;
  location?: {
    profileId?: string;
    voiceSlot?: string;
    index?: number;
    field?: string;
  };
}

/** Report returned by validateVoiceRegistry */
export interface VoiceRegistryValidationReport {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  findings: VoiceRegistryFinding[];
}

/** Options for voice resolution */
export interface VoiceResolutionOptions {
  /** Custom registry to use instead of default (for testing / extension) */
  registry?: VoiceRegistry;
  /** Requested language to check compatibility, e.g. from Scenario.metadata.language */
  language?: string;
  /** If true, requires exact language/locale match; if false (default), base language match is allowed */
  strictLanguageMatch?: boolean;
  /** Explicit fallback map: unknownSlot -> knownSlot. Only used when explicitly provided. */
  fallbackMap?: Readonly<Record<string, string>>;
  /** If true, allows resolving disabled profiles (default false) */
  allowDisabled?: boolean;
  /**
   * VS1: apply the deterministic legacy publication migration to every resolved
   * profile, so a resolved voice always carries an explicit, auditable
   * publication record. Default `true`.
   *
   * Set `false` to resolve exactly the registry entries as written (a legacy
   * fixture then has no `publication` field at all).
   */
  migrateLegacyPublication?: boolean;
  /**
   * VS1: when true, resolution FAILS with `VOICE_PUBLICATION_BLOCKED` for any
   * voice the publication gate does not allow. Default `false`, so Phase 4A
   * resolution behaviour is unchanged; the production pipeline turns it on.
   */
  requirePublicationApproval?: boolean;
  /** Gate options used when `requirePublicationApproval` is set. */
  publicationGate?: VoicePublicationGateOptions;
}

/** Result of resolving a single voice slot */
export interface ResolvedVoice {
  /** The requested voiceSlot (trimmed) */
  requestedSlot: string;
  /** The actual slot that was resolved (may differ if fallbackMap used) */
  resolvedSlot: string;
  /** The resolved profile */
  profile: VoiceProfile;
  /** Whether fallbackMap was used */
  usedFallback: boolean;
  /** If fallback was used, the original requested slot */
  fallbackFrom?: string;
  /**
   * VS1 publication gate report. Present only when the gate was run for this
   * resolution (`requirePublicationApproval`), so existing result shapes are
   * untouched by default.
   */
  publication?: VoicePublicationGateReport;
}

/** Result of resolving a DialogueAudioPlan's voices */
export interface DialogueAudioPlanVoiceResolution {
  /** Scenario / plan identifier */
  scenarioId: string;
  /** Language used for compatibility check */
  language: string;
  /** All resolved assignments, one per unique voiceSlot in the plan */
  resolved: ResolvedVoice[];
  /** Map from voiceSlot -> VoiceProfile for quick lookup */
  bySlot: Readonly<Record<string, VoiceProfile>>;
  /** Whether any fallback was used */
  hadFallback: boolean;
  /**
   * VS1 batch publication gate report. Present only when the gate was run
   * (`requirePublicationApproval`).
   */
  publicationGate?: VoicePublicationGateBatchReport;
}
