/**
 * BuildTrack Video Factory - VS1 Commercial Voice Publication Gate
 *
 * `evaluateVoicePublicationGate()` is the single deterministic decision point
 * for "may this voice be used in published production?".
 *
 * It BLOCKS when any of the following is missing or invalid:
 *   - engine/model identity (engine family, model id, external provider),
 *   - reference-audio identity (safe relative path, SHA-256, duration, sample
 *     rate, channels) or preset-voice identity,
 *   - owner/authorized-speaker consent (explicit confirmation, recorded
 *     timestamp, sufficient scope, not revoked, artifact for a human voice),
 *   - first-party commercial-rights evidence (provider, licence, evidence URL,
 *     access date, EXPLICIT commercial permission),
 *   - audition approval (approver + timestamp; rejected/not-tested blocks),
 *   - publication state (`draft` and `review_only` never publish).
 *
 * The rule that matters most, stated plainly: a licence that does not
 * EXPLICITLY prohibit commerce is NOT permission. `commercialUse` must read
 * `permitted` on first-party evidence; `unknown`, `not_stated`, `conditional`
 * and `prohibited` all block. Silence is never consent and never a grant.
 *
 * Pure: no I/O, no network, no clock, no randomness. Evaluating the same
 * profile twice returns deep-equal reports with findings in the same order.
 */

import {
  DialogueAudioPlanVoiceResolution,
  VoiceAcousticSource,
  VoiceConsentRecord,
  VoiceEngineIdentity,
  VoiceProfile,
  VoicePublicationGateBatchReport,
  VoicePublicationGateCode,
  VoicePublicationGateFinding,
  VoicePublicationGateOptions,
  VoicePublicationGateReport,
  VoicePublicationGateSeverity,
  VoicePublicationProfile,
  VoicePublicationState,
  VoiceReferenceAudio,
  VoiceResolutionError,
  VoiceRightsEvidence,
} from './voice-types.js';
import {
  migrateVoiceProfileForPublication,
  VS1_MIGRATION_ID,
} from './voice-publication-migration.js';
import { acousticIdentityFromPublication, UNDECLARED_VOICE_ACOUSTIC_IDENTITY } from './voice-acoustic-identity.js';

/* ------------------------------------------------------------------ */
/*  Stable rule ids                                                    */
/* ------------------------------------------------------------------ */

/**
 * One stable rule id per gate code. Typed as a complete record, so adding a
 * code without a rule id is a compile error.
 */
export const VOICE_PUBLICATION_GATE_RULE_IDS: Readonly<Record<VoicePublicationGateCode, string>> = Object.freeze({
  MALFORMED_PROFILE: 'VOICE-PUB-000-MALFORMED-PROFILE',
  MISSING_PUBLICATION_RECORD: 'VOICE-PUB-001-MISSING-PUBLICATION-RECORD',
  MISSING_ENGINE_IDENTITY: 'VOICE-PUB-010-MISSING-ENGINE-IDENTITY',
  INVALID_ENGINE_KIND: 'VOICE-PUB-011-INVALID-ENGINE-KIND',
  MISSING_MODEL_ID: 'VOICE-PUB-012-MISSING-MODEL-ID',
  MISSING_EXTERNAL_PROVIDER: 'VOICE-PUB-013-MISSING-EXTERNAL-PROVIDER',
  MISSING_ACOUSTIC_SOURCE: 'VOICE-PUB-020-MISSING-ACOUSTIC-SOURCE',
  INVALID_ACOUSTIC_SOURCE_KIND: 'VOICE-PUB-021-INVALID-ACOUSTIC-SOURCE-KIND',
  UNSAFE_REFERENCE_PATH: 'VOICE-PUB-022-UNSAFE-REFERENCE-PATH',
  MISSING_REFERENCE_HASH: 'VOICE-PUB-023-MISSING-REFERENCE-HASH',
  INVALID_REFERENCE_HASH: 'VOICE-PUB-024-INVALID-REFERENCE-HASH',
  INVALID_REFERENCE_METRICS: 'VOICE-PUB-025-INVALID-REFERENCE-METRICS',
  MISSING_PRESET_VOICE_ID: 'VOICE-PUB-026-MISSING-PRESET-VOICE-ID',
  MISSING_CONSENT: 'VOICE-PUB-030-MISSING-CONSENT',
  CONSENT_NOT_CONFIRMED: 'VOICE-PUB-031-CONSENT-NOT-CONFIRMED',
  CONSENT_REVOKED: 'VOICE-PUB-032-CONSENT-REVOKED',
  CONSENT_SCOPE_INSUFFICIENT: 'VOICE-PUB-033-CONSENT-SCOPE-INSUFFICIENT',
  CONSENT_SUBJECT_MISMATCH: 'VOICE-PUB-034-CONSENT-SUBJECT-MISMATCH',
  MISSING_CONSENT_SPEAKER: 'VOICE-PUB-035-MISSING-CONSENT-SPEAKER',
  MISSING_CONSENT_TIMESTAMP: 'VOICE-PUB-036-MISSING-CONSENT-TIMESTAMP',
  INVALID_CONSENT_TIMESTAMP: 'VOICE-PUB-037-INVALID-CONSENT-TIMESTAMP',
  MISSING_CONSENT_EVIDENCE: 'VOICE-PUB-038-MISSING-CONSENT-EVIDENCE',
  UNSAFE_CONSENT_EVIDENCE_PATH: 'VOICE-PUB-039-UNSAFE-CONSENT-EVIDENCE-PATH',
  REVOCATION_STATE_INCONSISTENT: 'VOICE-PUB-040-REVOCATION-STATE-INCONSISTENT',
  MISSING_RIGHTS_EVIDENCE: 'VOICE-PUB-050-MISSING-RIGHTS-EVIDENCE',
  MISSING_RIGHTS_PROVIDER: 'VOICE-PUB-051-MISSING-RIGHTS-PROVIDER',
  MISSING_LICENSE_NAME: 'VOICE-PUB-052-MISSING-LICENSE-NAME',
  MISSING_RIGHTS_EVIDENCE_URL: 'VOICE-PUB-053-MISSING-RIGHTS-EVIDENCE-URL',
  INVALID_RIGHTS_EVIDENCE_URL: 'VOICE-PUB-054-INVALID-RIGHTS-EVIDENCE-URL',
  MISSING_RIGHTS_ACCESS_DATE: 'VOICE-PUB-055-MISSING-RIGHTS-ACCESS-DATE',
  INVALID_RIGHTS_ACCESS_DATE: 'VOICE-PUB-056-INVALID-RIGHTS-ACCESS-DATE',
  UNSAFE_RIGHTS_EVIDENCE_PATH: 'VOICE-PUB-057-UNSAFE-RIGHTS-EVIDENCE-PATH',
  COMMERCIAL_USE_NOT_PERMITTED: 'VOICE-PUB-058-COMMERCIAL-USE-NOT-PERMITTED',
  COMMERCIAL_USE_NOT_ESTABLISHED: 'VOICE-PUB-059-COMMERCIAL-USE-NOT-ESTABLISHED',
  RIGHTS_EVIDENCE_NOT_FIRST_PARTY: 'VOICE-PUB-060-RIGHTS-EVIDENCE-NOT-FIRST-PARTY',
  MISSING_AUDITION: 'VOICE-PUB-070-MISSING-AUDITION',
  AUDITION_NOT_TESTED: 'VOICE-PUB-071-AUDITION-NOT-TESTED',
  AUDITION_REJECTED: 'VOICE-PUB-072-AUDITION-REJECTED',
  MISSING_AUDITION_APPROVER: 'VOICE-PUB-073-MISSING-AUDITION-APPROVER',
  MISSING_AUDITION_TIMESTAMP: 'VOICE-PUB-074-MISSING-AUDITION-TIMESTAMP',
  INVALID_AUDITION_TIMESTAMP: 'VOICE-PUB-075-INVALID-AUDITION-TIMESTAMP',
  UNSAFE_AUDITION_SAMPLE_PATH: 'VOICE-PUB-076-UNSAFE-AUDITION-SAMPLE-PATH',
  AUDITION_APPROVAL_INHERITED: 'VOICE-PUB-077-AUDITION-APPROVAL-INHERITED',
  PUBLICATION_STATE_NOT_APPROVED: 'VOICE-PUB-080-PUBLICATION-STATE-NOT-APPROVED',
  PUBLICATION_APPROVED_WITHOUT_EVIDENCE: 'VOICE-PUB-081-PUBLICATION-APPROVED-WITHOUT-EVIDENCE',
  ENGINE_DECLARATION_MISMATCH: 'VOICE-PUB-090-ENGINE-DECLARATION-MISMATCH',
});

/* ------------------------------------------------------------------ */
/*  Pure validators (exported: the same rules are reused by tests and   */
/*  by registry validation)                                            */
/* ------------------------------------------------------------------ */

const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;
const HTTP_URL_RE = /^https?:\/\/[^\s/$.?#][^\s]*$/i;
/** Absolute POSIX path, Windows drive, UNC share or home-relative path. */
const ABSOLUTE_PATH_RE = /^(?:\/|\\|[a-zA-Z]:[\\/]|~)/;

/** A SHA-256 content hash: exactly 64 lowercase hex characters. */
export function isSha256Hex(value: unknown): boolean {
  return typeof value === 'string' && SHA256_RE.test(value);
}

/**
 * An ISO-8601 date or date-time. `2026-09-29T00:00:00Z` and `2026-10-08` are
 * both accepted; free text, epoch numbers and empty strings are not.
 */
export function isIso8601Timestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || !ISO_TIMESTAMP_RE.test(trimmed)) return false;
  return !Number.isNaN(Date.parse(trimmed));
}

/** An http(s) URL, i.e. something a reviewer can actually open. */
export function isHttpUrl(value: unknown): boolean {
  return typeof value === 'string' && HTTP_URL_RE.test(value.trim());
}

/**
 * A safe repo-relative path: non-empty, not absolute, not home-relative, no
 * drive letter, no UNC share, no `.`/`..` segment, no empty segment and none of
 * the characters Windows refuses in a file name.
 */
export function isSafeRelativeVoicePath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (ABSOLUTE_PATH_RE.test(trimmed)) return false;
  if (/[\0<>:"|?*]/.test(trimmed)) return false;
  const segments = trimmed.split(/[/\\]/);
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** True when a string looks like an absolute or home-relative path. */
export function looksLikeAbsolutePath(value: unknown): boolean {
  return typeof value === 'string' && ABSOLUTE_PATH_RE.test(value.trim());
}

/**
 * Walks any JSON-serialisable value and returns every string that looks like an
 * absolute path. Used to prove a serialised voice contract is portable: a
 * production voice record must never pin a machine-specific location.
 */
export function findAbsolutePaths(value: unknown, visited: Set<unknown> = new Set()): string[] {
  const found: string[] = [];
  if (typeof value === 'string') {
    if (looksLikeAbsolutePath(value)) found.push(value);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (visited.has(value)) return found;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) found.push(...findAbsolutePaths(item, visited));
    return found;
  }
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    found.push(...findAbsolutePaths((value as Record<string, unknown>)[key], visited));
  }
  return found;
}

/** Publication states ordered from least to most published. */
const PUBLICATION_STATE_RANK: Readonly<Record<VoicePublicationState, number>> = Object.freeze({
  draft: 0,
  review_only: 1,
  approved: 2,
});

/** Rank of a declared publication state, or -1 when it is not a known state. */
function publicationStateRank(state: unknown): number {
  if (state === 'draft' || state === 'review_only' || state === 'approved') {
    return PUBLICATION_STATE_RANK[state];
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/*  Gate                                                               */
/* ------------------------------------------------------------------ */

interface GateContext {
  findings: VoicePublicationGateFinding[];
  strictFirstPartyEvidence: boolean;
  requiredConsentScope: NonNullable<VoicePublicationGateOptions['requiredConsentScope']>;
  requiredPublicationState: NonNullable<VoicePublicationGateOptions['requiredPublicationState']>;
}

function push(
  ctx: GateContext,
  severity: VoicePublicationGateSeverity,
  code: VoicePublicationGateCode,
  message: string,
  field?: string
): void {
  ctx.findings.push({
    severity,
    code,
    ruleId: VOICE_PUBLICATION_GATE_RULE_IDS[code],
    message,
    ...(field ? { field } : {}),
  });
}

function requireNonEmptyString(ctx: GateContext, value: unknown, code: VoicePublicationGateCode, field: string, label: string): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    push(ctx, 'error', code, `${label} must be a non-empty string.`, field);
    return null;
  }
  return value.trim();
}

function checkEngine(ctx: GateContext, engine: VoiceEngineIdentity | undefined, options: VoicePublicationGateOptions): void {
  if (!engine || typeof engine !== 'object') {
    push(
      ctx,
      'error',
      'MISSING_ENGINE_IDENTITY',
      'No engine identity is declared. A production voice must state which engine and model produce it, or it cannot be reproduced or audited.'
    );
    return;
  }

  if (engine.engine !== 'kokoro' && engine.engine !== 'chatterbox' && engine.engine !== 'external') {
    push(
      ctx,
      'error',
      'INVALID_ENGINE_KIND',
      `engine.engine must be one of kokoro | chatterbox | external, got '${String(engine.engine)}'.`,
      'engine.engine'
    );
  }

  if (!requireNonEmptyString(ctx, engine.modelId, 'MISSING_MODEL_ID', 'engine.modelId', 'engine.modelId')) return;

  if (engine.modelRevision !== undefined) {
    requireNonEmptyString(ctx, engine.modelRevision, 'MISSING_MODEL_ID', 'engine.modelRevision', 'engine.modelRevision (pinned revision)');
  }

  if (engine.engine === 'external') {
    requireNonEmptyString(
      ctx,
      engine.provider,
      'MISSING_EXTERNAL_PROVIDER',
      'engine.provider',
      'engine.provider (an external engine must name its provider)'
    );
  }

  const expected = options.declaredEngineMustMatch;
  if (expected && typeof expected === 'object') {
    const declaredRuntime = typeof engine.runtimeId === 'string' ? engine.runtimeId.trim() : '';
    const actualRuntime = typeof expected.engineId === 'string' ? expected.engineId.trim() : '';
    if (actualRuntime && declaredRuntime !== actualRuntime) {
      push(
        ctx,
        'error',
        'ENGINE_DECLARATION_MISMATCH',
        `Voice declares runtime '${declaredRuntime || '(none)'}' but synthesis would run on '${actualRuntime}'. The approved voice and the produced voice must be the same voice.`,
        'engine.runtimeId'
      );
    }
    if (typeof expected.modelId === 'string' && expected.modelId.trim()) {
      const declaredModel = typeof engine.modelId === 'string' ? engine.modelId.trim() : '';
      if (declaredModel !== expected.modelId.trim()) {
        push(
          ctx,
          'error',
          'ENGINE_DECLARATION_MISMATCH',
          `Voice declares model '${declaredModel || '(none)'}' but synthesis would run model '${expected.modelId.trim()}'.`,
          'engine.modelId'
        );
      }
    }
  }
}

function checkReferenceAudio(ctx: GateContext, referenceAudio: VoiceReferenceAudio | undefined): void {
  if (!referenceAudio || typeof referenceAudio !== 'object') {
    push(
      ctx,
      'error',
      'MISSING_ACOUSTIC_SOURCE',
      'acousticSource.referenceAudio is required for a cloned reference voice.',
      'acousticSource.referenceAudio'
    );
    return;
  }

  const path = requireNonEmptyString(ctx, referenceAudio.path, 'UNSAFE_REFERENCE_PATH', 'acousticSource.referenceAudio.path', 'Reference audio path');
  if (path && !isSafeRelativeVoicePath(path)) {
    push(
      ctx,
      'error',
      'UNSAFE_REFERENCE_PATH',
      `Reference audio path '${path}' must be a safe repo-relative path (no absolute path, no drive letter, no '..' traversal).`,
      'acousticSource.referenceAudio.path'
    );
  }

  if (referenceAudio.sha256 === undefined || referenceAudio.sha256 === null || referenceAudio.sha256 === '') {
    push(
      ctx,
      'error',
      'MISSING_REFERENCE_HASH',
      'Reference audio has no SHA-256. Without a content hash the recording that was consented to cannot be tied to the voice that is published.',
      'acousticSource.referenceAudio.sha256'
    );
  } else if (!isSha256Hex(referenceAudio.sha256)) {
    push(
      ctx,
      'error',
      'INVALID_REFERENCE_HASH',
      `Reference audio sha256 '${String(referenceAudio.sha256)}' is not 64 lowercase hex characters.`,
      'acousticSource.referenceAudio.sha256'
    );
  }

  const metrics: string[] = [];
  if (typeof referenceAudio.durationSeconds !== 'number' || !Number.isFinite(referenceAudio.durationSeconds) || referenceAudio.durationSeconds <= 0) {
    metrics.push('durationSeconds must be a finite number > 0');
  }
  if (typeof referenceAudio.sampleRate !== 'number' || !Number.isFinite(referenceAudio.sampleRate) || referenceAudio.sampleRate <= 0) {
    metrics.push('sampleRate must be a finite number > 0');
  }
  if (typeof referenceAudio.channels !== 'number' || !Number.isInteger(referenceAudio.channels) || referenceAudio.channels < 1) {
    metrics.push('channels must be an integer >= 1');
  }
  if (metrics.length > 0) {
    push(
      ctx,
      'error',
      'INVALID_REFERENCE_METRICS',
      `Reference audio metrics are invalid: ${metrics.join('; ')}.`,
      'acousticSource.referenceAudio'
    );
  }

  if (referenceAudio.capturedAt !== undefined && !isIso8601Timestamp(referenceAudio.capturedAt)) {
    push(
      ctx,
      'error',
      'INVALID_CONSENT_TIMESTAMP',
      `Reference audio capturedAt '${String(referenceAudio.capturedAt)}' is not an ISO-8601 timestamp.`,
      'acousticSource.referenceAudio.capturedAt'
    );
  }
}

function checkAcousticSource(ctx: GateContext, source: VoiceAcousticSource | undefined): void {
  if (!source || typeof source !== 'object') {
    push(
      ctx,
      'error',
      'MISSING_ACOUSTIC_SOURCE',
      'No acoustic source is declared. A production voice must identify either the reference recording it clones (path + SHA-256 + duration + sample rate + channels) or the preset voice it uses.'
    );
    return;
  }

  if (source.kind === 'cloned_reference_audio') {
    checkReferenceAudio(ctx, source.referenceAudio);
    return;
  }

  if (source.kind === 'preset_model_voice') {
    requireNonEmptyString(ctx, source.presetVoiceId, 'MISSING_PRESET_VOICE_ID', 'acousticSource.presetVoiceId', 'acousticSource.presetVoiceId');
    requireNonEmptyString(
      ctx,
      source.bundledBy,
      'MISSING_ACOUSTIC_SOURCE',
      'acousticSource.bundledBy',
      'acousticSource.bundledBy (what ships the preset voice)'
    );
    return;
  }

  push(
    ctx,
    'error',
    'INVALID_ACOUSTIC_SOURCE_KIND',
    `acousticSource.kind must be 'cloned_reference_audio' or 'preset_model_voice', got '${String((source as { kind?: unknown }).kind)}'.`,
    'acousticSource.kind'
  );
}

function checkConsent(
  ctx: GateContext,
  consent: VoiceConsentRecord | undefined,
  acousticSource: VoiceAcousticSource | undefined
): void {
  if (!consent || typeof consent !== 'object') {
    push(
      ctx,
      'error',
      'MISSING_CONSENT',
      'No consent record exists. Nobody has confirmed that this voice may be used, so it cannot be published.'
    );
    return;
  }

  const subjectOk = consent.subject === 'recorded_speaker' || consent.subject === 'model_provider_preset';
  if (!subjectOk) {
    push(
      ctx,
      'error',
      'CONSENT_SUBJECT_MISMATCH',
      `consent.subject must be 'recorded_speaker' or 'model_provider_preset', got '${String(consent.subject)}'.`,
      'consent.subject'
    );
  }

  // A cloned human voice cannot lean on a model provider's licence, and a model
  // preset must not claim a human signature it does not have.
  if (subjectOk && acousticSource && typeof acousticSource === 'object') {
    if (acousticSource.kind === 'cloned_reference_audio' && consent.subject !== 'recorded_speaker') {
      push(
        ctx,
        'error',
        'CONSENT_SUBJECT_MISMATCH',
        `The acoustic source is a cloned reference recording, so consent.subject must be 'recorded_speaker' (a real person who owns that voice), got '${consent.subject}'. A model provider's licence never covers cloning a private individual.`,
        'consent.subject'
      );
    }
    if (acousticSource.kind === 'preset_model_voice' && consent.subject !== 'model_provider_preset') {
      push(
        ctx,
        'error',
        'CONSENT_SUBJECT_MISMATCH',
        `The acoustic source is a preset model voice, so consent.subject must be 'model_provider_preset', got '${consent.subject}'. Do not record a human consent that was never given.`,
        'consent.subject'
      );
    }
  }

  if (consent.ownerConfirmed !== true) {
    push(
      ctx,
      'error',
      'CONSENT_NOT_CONFIRMED',
      `consent.ownerConfirmed must be the boolean true. Permission is never inferred from an absent, false or non-boolean value (got ${JSON.stringify(consent.ownerConfirmed) ?? 'undefined'}).`,
      'consent.ownerConfirmed'
    );
  }

  requireNonEmptyString(ctx, consent.authorizedSpeaker, 'MISSING_CONSENT_SPEAKER', 'consent.authorizedSpeaker', 'consent.authorizedSpeaker');
  requireNonEmptyString(ctx, consent.confirmedBy, 'MISSING_CONSENT_SPEAKER', 'consent.confirmedBy', 'consent.confirmedBy (who recorded the confirmation)');

  if (consent.recordedAt === undefined || consent.recordedAt === null || consent.recordedAt === '') {
    push(ctx, 'error', 'MISSING_CONSENT_TIMESTAMP', 'consent.recordedAt is required: consent without a recorded timestamp is not auditable.', 'consent.recordedAt');
  } else if (!isIso8601Timestamp(consent.recordedAt)) {
    push(ctx, 'error', 'INVALID_CONSENT_TIMESTAMP', `consent.recordedAt '${String(consent.recordedAt)}' is not an ISO-8601 timestamp.`, 'consent.recordedAt');
  }

  const scope = Array.isArray(consent.scope) ? consent.scope.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (scope.length === 0) {
    push(ctx, 'error', 'CONSENT_SCOPE_INSUFFICIENT', 'consent.scope must list at least one granted use.', 'consent.scope');
  } else if (!scope.some((s) => (s as string).trim() === ctx.requiredConsentScope)) {
    push(
      ctx,
      'error',
      'CONSENT_SCOPE_INSUFFICIENT',
      `consent.scope [${scope.join(', ')}] does not cover the required use '${ctx.requiredConsentScope}'. Consent recorded for a narrower use never authorises a wider one.`,
      'consent.scope'
    );
  }

  if (consent.revoked === true) {
    push(
      ctx,
      'error',
      'CONSENT_REVOKED',
      `Consent was revoked${consent.revokedAt ? ` at ${consent.revokedAt}` : ''}${consent.revocationReason ? ` (${consent.revocationReason})` : ''}. A revoked voice is blocked permanently; revoking consent is how a speaker withdraws permission and it is never overridden.`,
      'consent.revoked'
    );
  } else if (consent.revoked !== false) {
    push(
      ctx,
      'error',
      'CONSENT_NOT_CONFIRMED',
      `consent.revoked must be an explicit boolean, got ${JSON.stringify(consent.revoked) ?? 'undefined'}. Revocation state is never left ambiguous.`,
      'consent.revoked'
    );
  }

  if (consent.revoked === false && consent.revokedAt) {
    push(
      ctx,
      'warning',
      'REVOCATION_STATE_INCONSISTENT',
      `consent.revokedAt '${String(consent.revokedAt)}' is set while consent.revoked is false. Fix the record: either the revocation stands or the timestamp must be removed.`,
      'consent.revokedAt'
    );
  }
  if (consent.revoked === true && !consent.revokedAt) {
    push(ctx, 'warning', 'REVOCATION_STATE_INCONSISTENT', 'consent.revoked is true but consent.revokedAt is missing.', 'consent.revokedAt');
  }

  if (consent.evidencePath !== undefined) {
    if (!isSafeRelativeVoicePath(consent.evidencePath)) {
      push(ctx, 'error', 'UNSAFE_CONSENT_EVIDENCE_PATH', `consent.evidencePath '${String(consent.evidencePath)}' must be a safe repo-relative path.`, 'consent.evidencePath');
    }
  } else if (consent.subject === 'recorded_speaker') {
    push(
      ctx,
      'error',
      'MISSING_CONSENT_EVIDENCE',
      "consent.evidencePath is required when a real speaker's recording is cloned: a human voice needs an auditable consent artifact, not just a boolean.",
      'consent.evidencePath'
    );
  }
}

function checkRights(ctx: GateContext, rights: VoiceRightsEvidence | undefined, recordIsMigrated: boolean): void {
  if (!rights || typeof rights !== 'object') {
    push(
      ctx,
      'error',
      'MISSING_RIGHTS_EVIDENCE',
      'No commercial-rights evidence exists. Without a named provider, a licence, a first-party evidence URL and an access date, commercial use is unknown and therefore blocked.'
    );
    return;
  }

  requireNonEmptyString(ctx, rights.sourceProvider, 'MISSING_RIGHTS_PROVIDER', 'rights.sourceProvider', 'rights.sourceProvider');
  requireNonEmptyString(ctx, rights.licenseName, 'MISSING_LICENSE_NAME', 'rights.licenseName', 'rights.licenseName');

  const url = requireNonEmptyString(ctx, rights.evidenceUrl, 'MISSING_RIGHTS_EVIDENCE_URL', 'rights.evidenceUrl', 'rights.evidenceUrl (first-party evidence)');
  if (url && !isHttpUrl(url)) {
    push(ctx, 'error', 'INVALID_RIGHTS_EVIDENCE_URL', `rights.evidenceUrl '${url}' is not an http(s) URL a reviewer can open.`, 'rights.evidenceUrl');
  }

  if (rights.accessedAt === undefined || rights.accessedAt === null || rights.accessedAt === '') {
    push(ctx, 'error', 'MISSING_RIGHTS_ACCESS_DATE', 'rights.accessedAt is required: evidence nobody can date is not evidence.', 'rights.accessedAt');
  } else if (!isIso8601Timestamp(rights.accessedAt)) {
    push(ctx, 'error', 'INVALID_RIGHTS_ACCESS_DATE', `rights.accessedAt '${String(rights.accessedAt)}' is not an ISO-8601 date.`, 'rights.accessedAt');
  }

  if (rights.localEvidencePath !== undefined && !isSafeRelativeVoicePath(rights.localEvidencePath)) {
    push(ctx, 'error', 'UNSAFE_RIGHTS_EVIDENCE_PATH', `rights.localEvidencePath '${String(rights.localEvidencePath)}' must be a safe repo-relative path.`, 'rights.localEvidencePath');
  }

  /*
   * Cast to a wider type on purpose: the declared contract says `commercialUse`
   * is required, but a hand-written or partially authored record can omit it at
   * runtime, and "not declared" must be judged exactly like "unknown".
   */
  const commercialUse = rights.commercialUse as VoiceRightsEvidence['commercialUse'] | undefined;

  switch (commercialUse) {
    case 'permitted':
      break;
    case 'prohibited':
      push(
        ctx,
        'error',
        'COMMERCIAL_USE_NOT_PERMITTED',
        `Commercial use is explicitly prohibited by '${rights.licenseName || 'the declared licence'}'. This voice can never be published commercially.`,
        'rights.commercialUse'
      );
      break;
    case 'conditional':
      push(
        ctx,
        'error',
        'COMMERCIAL_USE_NOT_PERMITTED',
        `Commercial use is only conditional (${rights.conditions || 'conditions not recorded'}). A conditional grant is not a permission: resolve the conditions with first-party evidence and record commercialUse 'permitted', or do not publish.`,
        'rights.commercialUse'
      );
      break;
    case 'unknown':
    case 'not_stated':
    case undefined:
      push(
        ctx,
        'error',
        'COMMERCIAL_USE_NOT_ESTABLISHED',
        `Commercial use is '${String(rights.commercialUse ?? 'not declared')}'. A licence that does not explicitly prohibit commerce is NOT permission: commercial use must be stated explicitly by first-party evidence. Silence is never a grant.`,
        'rights.commercialUse'
      );
      break;
    default:
      push(
        ctx,
        'error',
        'COMMERCIAL_USE_NOT_ESTABLISHED',
        `rights.commercialUse '${String(rights.commercialUse)}' is not a known status.`,
        'rights.commercialUse'
      );
      break;
  }

  if (recordIsMigrated) {
    push(
      ctx,
      ctx.strictFirstPartyEvidence ? 'error' : 'warning',
      'RIGHTS_EVIDENCE_NOT_FIRST_PARTY',
      `Rights evidence was recorded by the ${VS1_MIGRATION_ID} migration from the pinned local dependency and repository documentation; the upstream provider page was not re-fetched in this phase (this repository performs no network calls). Re-verify it against the provider before relying on it for a new commercial commitment.`,
      'rights.evidenceUrl'
    );
  }
}

function checkAudition(ctx: GateContext, audition: VoicePublicationProfile['audition']): void {
  if (!audition || typeof audition !== 'object') {
    push(ctx, 'error', 'MISSING_AUDITION', 'No audition record exists. A voice nobody has listened to is not approved.', 'audition');
    return;
  }

  if (audition.samplePath !== undefined && !isSafeRelativeVoicePath(audition.samplePath)) {
    push(ctx, 'error', 'UNSAFE_AUDITION_SAMPLE_PATH', `audition.samplePath '${String(audition.samplePath)}' must be a safe repo-relative path.`, 'audition.samplePath');
  }
  if (audition.evidencePath !== undefined && !isSafeRelativeVoicePath(audition.evidencePath)) {
    push(ctx, 'error', 'UNSAFE_AUDITION_SAMPLE_PATH', `audition.evidencePath '${String(audition.evidencePath)}' must be a safe repo-relative path.`, 'audition.evidencePath');
  }

  switch (audition.state) {
    case 'approved':
      requireNonEmptyString(ctx, audition.approver, 'MISSING_AUDITION_APPROVER', 'audition.approver', 'audition.approver (a named human or recorded process)');
      if (audition.reviewedAt === undefined || audition.reviewedAt === null || audition.reviewedAt === '') {
        push(ctx, 'error', 'MISSING_AUDITION_TIMESTAMP', 'audition.reviewedAt is required for an approved audition.', 'audition.reviewedAt');
      } else if (!isIso8601Timestamp(audition.reviewedAt)) {
        push(ctx, 'error', 'INVALID_AUDITION_TIMESTAMP', `audition.reviewedAt '${String(audition.reviewedAt)}' is not an ISO-8601 timestamp.`, 'audition.reviewedAt');
      }
      if (audition.inherited === true) {
        push(
          ctx,
          ctx.strictFirstPartyEvidence ? 'error' : 'warning',
          'AUDITION_APPROVAL_INHERITED',
          `Audition approval is inherited from an accepted baseline, not from a first-party audition recorded in this phase${audition.reason ? `: ${audition.reason}` : '.'}`,
          'audition.inherited'
        );
      }
      break;
    case 'rejected':
      push(
        ctx,
        'error',
        'AUDITION_REJECTED',
        `The voice was rejected at audition${audition.approver ? ` by ${audition.approver}` : ''}${audition.reason ? ` (${audition.reason})` : ''}. A rejected voice is blocked until it is re-auditioned and approved.`,
        'audition.state'
      );
      break;
    case 'not_tested':
      push(ctx, 'error', 'AUDITION_NOT_TESTED', 'The voice has not been auditioned (audition.state is not_tested).', 'audition.state');
      break;
    default:
      push(ctx, 'error', 'MISSING_AUDITION', `audition.state must be not_tested | approved | rejected, got '${String(audition.state)}'.`, 'audition.state');
      break;
  }
}

function buildReport(
  profile: VoiceProfile,
  publication: VoicePublicationProfile | undefined,
  ctx: GateContext,
  migrated: boolean
): VoicePublicationGateReport {
  const errorCount = ctx.findings.filter((f) => f.severity === 'error').length;
  const warningCount = ctx.findings.filter((f) => f.severity === 'warning').length;
  const acousticIdentity = publication
    ? acousticIdentityFromPublication(publication)
    : { ...UNDECLARED_VOICE_ACOUSTIC_IDENTITY };
  const engine = publication?.engine;

  return {
    profileId: typeof profile?.id === 'string' ? profile.id : '',
    voiceSlot: typeof profile?.voiceSlot === 'string' ? profile.voiceSlot : '',
    allowed: errorCount === 0,
    blocked: errorCount > 0,
    publicationState: publication?.publicationState ?? 'draft',
    origin: publication?.origin ?? 'undeclared',
    engine: {
      engine: engine?.engine ?? 'undeclared',
      modelId: typeof engine?.modelId === 'string' && engine.modelId.trim() ? engine.modelId.trim() : null,
      modelRevision: typeof engine?.modelRevision === 'string' && engine.modelRevision.trim() ? engine.modelRevision.trim() : null,
    },
    acousticIdentity,
    migrated,
    findings: ctx.findings,
    errorCount,
    warningCount,
  };
}

/**
 * Deterministically decides whether one voice profile may be used in published
 * production, and returns structured findings explaining every reason it may
 * not.
 */
export function evaluateVoicePublicationGate(
  profile: VoiceProfile | null | undefined,
  options: VoicePublicationGateOptions = {}
): VoicePublicationGateReport {
  const ctx: GateContext = {
    findings: [],
    strictFirstPartyEvidence: options.strictFirstPartyEvidence === true,
    requiredConsentScope: options.requiredConsentScope ?? 'commercial_video_publication',
    requiredPublicationState: options.requiredPublicationState ?? 'approved',
  };

  if (!profile || typeof profile !== 'object') {
    push(ctx, 'error', 'MALFORMED_PROFILE', 'A voice profile object is required.');
    return {
      profileId: '',
      voiceSlot: '',
      allowed: false,
      blocked: true,
      publicationState: 'draft',
      origin: 'undeclared',
      engine: { engine: 'undeclared', modelId: null, modelRevision: null },
      acousticIdentity: { ...UNDECLARED_VOICE_ACOUSTIC_IDENTITY },
      migrated: false,
      findings: ctx.findings,
      errorCount: ctx.findings.length,
      warningCount: 0,
    };
  }

  if (typeof profile.id !== 'string' || !profile.id.trim() || typeof profile.voiceSlot !== 'string' || !profile.voiceSlot.trim()) {
    push(ctx, 'error', 'MALFORMED_PROFILE', 'Voice profile must declare a non-empty id and voiceSlot.', 'id');
  }

  // Migration is part of the gate's contract: a legacy fixture with no declared
  // record is completed deterministically instead of being judged as "nothing".
  const migration =
    options.migrateLegacy === false ? null : migrateVoiceProfileForPublication(profile);
  const publication = migration ? migration.publication : profile.publication;
  const migrated = migration ? migration.migrated : false;

  if (!publication || typeof publication !== 'object') {
    push(
      ctx,
      'error',
      'MISSING_PUBLICATION_RECORD',
      'The voice declares no publication record and legacy migration was disabled, so nothing about its engine, reference audio, consent, rights, audition or publication state is known.'
    );
    return buildReport(profile, undefined, ctx, false);
  }

  checkEngine(ctx, publication.engine, options);
  checkAcousticSource(ctx, publication.acousticSource);
  checkConsent(ctx, publication.consent, publication.acousticSource);
  /*
   * The "evidence was not re-fetched from the provider" warning applies to the
   * records the migration wrote from the pinned local dependency. An authored
   * record is judged on its own evidence, whatever its origin claims.
   */
  checkRights(ctx, publication.rights, publication.origin === 'legacy_kokoro_fixture');
  checkAudition(ctx, publication.audition);

  // Publication state.
  const state = publication.publicationState;
  const stateRank = publicationStateRank(state);
  /*
   * An unrecognised `requiredPublicationState` must never widen the gate, so it
   * falls back to the strictest production requirement ('approved').
   */
  const requiredState: VoicePublicationState =
    publicationStateRank(ctx.requiredPublicationState) >= 0
      ? (ctx.requiredPublicationState as VoicePublicationState)
      : 'approved';
  const requiredRank = PUBLICATION_STATE_RANK[requiredState];
  if (stateRank < 0) {
    push(
      ctx,
      'error',
      'PUBLICATION_STATE_NOT_APPROVED',
      `publicationState must be draft | review_only | approved, got '${String(state)}'.`,
      'publicationState'
    );
  } else if (stateRank < requiredRank) {
    push(
      ctx,
      'error',
      'PUBLICATION_STATE_NOT_APPROVED',
      `publicationState is '${state}' but '${requiredState}' is required${
        state === 'review_only' && requiredState === 'approved'
          ? ': a review_only voice may be used for internal review builds only and is never published production'
          : ''
      }.`,
      'publicationState'
    );
  }

  // An "approved" stamp on an incomplete record is not approval.
  const blockingSoFar = ctx.findings.filter((f) => f.severity === 'error').length;
  if (state === 'approved' && blockingSoFar > 0) {
    push(
      ctx,
      'error',
      'PUBLICATION_APPROVED_WITHOUT_EVIDENCE',
      `publicationState is 'approved' but ${blockingSoFar} blocking element(s) are missing or invalid. An approval stamp without evidence is not permission; publish only what the record actually proves.`,
      'publicationState'
    );
  }

  return buildReport(profile, publication, ctx, migrated);
}

/** Normalises gate input: a resolution, or a plain list of profiles. */
function toProfileList(voices: DialogueAudioPlanVoiceResolution | readonly VoiceProfile[]): {
  profiles: VoiceProfile[];
  scenarioId?: string;
} {
  if (Array.isArray(voices)) {
    return { profiles: [...voices] };
  }
  if (voices && typeof voices === 'object' && Array.isArray((voices as DialogueAudioPlanVoiceResolution).resolved)) {
    const resolution = voices as DialogueAudioPlanVoiceResolution;
    return {
      profiles: resolution.resolved.map((r) => r.profile),
      ...(resolution.scenarioId ? { scenarioId: resolution.scenarioId } : {}),
    };
  }
  return { profiles: [] };
}

/**
 * Evaluates every voice of a resolution (or a plain profile list) and reports
 * the set as a whole. Reports are sorted by voiceSlot then profile id, so the
 * batch result is deterministic regardless of input order.
 */
export function evaluateVoicePublicationGateForVoices(
  voices: DialogueAudioPlanVoiceResolution | readonly VoiceProfile[],
  options: VoicePublicationGateOptions = {}
): VoicePublicationGateBatchReport {
  const { profiles, scenarioId } = toProfileList(voices);

  const reports = profiles
    .map((profile) => evaluateVoicePublicationGate(profile, options))
    .sort((a, b) => {
      if (a.voiceSlot !== b.voiceSlot) return a.voiceSlot < b.voiceSlot ? -1 : 1;
      if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
      return 0;
    });

  const blockedSlots = reports.filter((r) => !r.allowed).map((r) => r.voiceSlot).sort();

  return {
    ...(scenarioId ? { scenarioId } : {}),
    allowed: reports.length > 0 && blockedSlots.length === 0,
    blockedSlots,
    reports,
    errorCount: reports.reduce((sum, r) => sum + r.errorCount, 0),
    warningCount: reports.reduce((sum, r) => sum + r.warningCount, 0),
  };
}

/** Alias with the resolution-first name used by the production pipeline. */
export function evaluateVoicePublicationGateForResolution(
  resolution: DialogueAudioPlanVoiceResolution,
  options: VoicePublicationGateOptions = {}
): VoicePublicationGateBatchReport {
  return evaluateVoicePublicationGateForVoices(resolution, options);
}

/**
 * Hard production gate: throws a structured `VOICE_PUBLICATION_BLOCKED` error
 * unless EVERY voice is allowed. Returns the batch report so callers can attach
 * it to their audit trail.
 */
export function assertVoicesApprovedForProduction(
  voices: DialogueAudioPlanVoiceResolution | readonly VoiceProfile[],
  options: VoicePublicationGateOptions = {}
): VoicePublicationGateBatchReport {
  const report = evaluateVoicePublicationGateForVoices(voices, options);

  if (report.reports.length === 0) {
    throw new VoiceResolutionError(
      'VOICE_PUBLICATION_BLOCKED',
      'Production is blocked: no voice profiles were supplied to the publication gate.',
      { blockedSlots: [] }
    );
  }

  if (!report.allowed) {
    const summary = report.reports
      .filter((r) => !r.allowed)
      .map((r) => {
        const codes = r.findings
          .filter((f) => f.severity === 'error')
          .map((f) => f.code)
          .slice(0, 6);
        return `${r.voiceSlot || '(unknown slot)'} [${r.publicationState}] ${codes.join(', ')}`;
      })
      .join('; ');
    throw new VoiceResolutionError(
      'VOICE_PUBLICATION_BLOCKED',
      `Production is blocked for ${report.blockedSlots.length} unapproved voice(s): ${summary}`,
      {
        blockedSlots: report.blockedSlots,
        errorCount: report.errorCount,
        findings: report.reports.flatMap((r) => r.findings.map((f) => ({ voiceSlot: r.voiceSlot, ...f }))),
      }
    );
  }

  return report;
}
