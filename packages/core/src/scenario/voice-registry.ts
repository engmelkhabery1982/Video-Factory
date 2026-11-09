/**
 * BuildTrack Video Factory - Phase 4A Voice Registry (+ VS1 publication records)
 *
 * Canonical, deterministic, local-first registry of known voice profiles.
 * No network, no I/O, no synthesis. Validates duplicate IDs/slots and malformed entries.
 *
 * VS1 additions:
 * - `validateVoiceRegistry` also validates an attached commercial publication
 *   record structurally (states, enums, safe relative paths). The SEMANTIC
 *   decision — may this voice be published? — belongs to
 *   `evaluateVoicePublicationGate`, not to registry validation.
 * - `MIGRATED_DEFAULT_VOICE_REGISTRY` is the deterministic migration of the
 *   Phase 4A fixtures, and this module asserts at load time that every migrated
 *   fixture still passes the publication gate. If a future edit breaks the
 *   legacy Kokoro path, the module fails to load instead of silently shipping an
 *   unproducible voice.
 */

import {
  VoiceProfile,
  VoicePublicationProfile,
  VoiceRegistry,
  VoiceRegistryFinding,
  VoiceRegistryValidationReport,
  VoiceResolutionError,
} from './voice-types.js';
import { evaluateVoicePublicationGate, isSafeRelativeVoicePath } from './voice-publication-gate.js';
import { migrateVoiceRegistryForPublication } from './voice-publication-migration.js';

/** Language code validation: allows e.g. en, en-GB, en-US, fr-FR, de, es-MX */
const LANGUAGE_CODE_RE = /^[a-z]{2,3}(?:-[A-Z]{2,3})?(?:-[a-z0-9]+)*$/i;
const GENERIC_LANGUAGE_RE = /^[a-z]{2,3}$/i;

function isValidLanguageCode(code: string): boolean {
  if (!code || typeof code !== 'string') return false;
  const trimmed = code.trim();
  if (!trimmed) return false;
  // Accept both strict BCP-47-ish and generic forms, but require at least 2 letters
  return LANGUAGE_CODE_RE.test(trimmed);
}

function addFinding(
  findings: VoiceRegistryFinding[],
  severity: VoiceRegistryFinding['severity'],
  category: VoiceRegistryFinding['category'],
  ruleId: string,
  message: string,
  location?: VoiceRegistryFinding['location']
): void {
  findings.push({ severity, category, ruleId, message, location });
}

/* ------------------------------------------------------------------ */
/*  VS1 — structural validation of a commercial publication record     */
/* ------------------------------------------------------------------ */

const PUBLICATION_STATES = ['draft', 'review_only', 'approved'] as const;
const PUBLICATION_ORIGINS = ['legacy_kokoro_fixture', 'authored_first_party', 'custom_unverified'] as const;
const ENGINE_KINDS = ['kokoro', 'chatterbox', 'external'] as const;
const ACOUSTIC_SOURCE_KINDS = ['cloned_reference_audio', 'preset_model_voice'] as const;
const CONSENT_SUBJECTS = ['recorded_speaker', 'model_provider_preset'] as const;
const CONSENT_SCOPES = [
  'internal_review',
  'commercial_video_publication',
  'synthetic_voice_cloning',
  'broadcast',
  'paid_advertising',
  'third_party_licensing',
] as const;
const COMMERCIAL_USE_STATUSES = ['permitted', 'conditional', 'prohibited', 'unknown', 'not_stated'] as const;
const AUDITION_STATES = ['not_tested', 'approved', 'rejected'] as const;

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * Validates the STRUCTURE of an attached publication record: known enums, known
 * acoustic-source shape and safe relative paths only.
 *
 * It deliberately does not decide whether the voice may be published — that is
 * `evaluateVoicePublicationGate`. Keeping the two apart means a registry can be
 * structurally sound while still holding voices that are (correctly) blocked.
 */
function validatePublicationRecord(
  findings: VoiceRegistryFinding[],
  publication: unknown,
  location: { profileId?: string; voiceSlot?: string; index?: number }
): void {
  const field = 'publication';

  if (!publication || typeof publication !== 'object' || Array.isArray(publication)) {
    addFinding(findings, 'error', 'publication', 'VOICE-REG-040-INVALID-PUBLICATION-OBJECT', `Entry '${location.profileId ?? location.index}' has a publication field that is not an object.`, { ...location, field });
    return;
  }

  const record = publication as Partial<VoicePublicationProfile> & Record<string, unknown>;

  if (typeof record.schemaVersion !== 'string' || !record.schemaVersion.trim()) {
    addFinding(findings, 'error', 'publication', 'VOICE-REG-043-MISSING-PUBLICATION-SCHEMA', `Entry '${location.profileId ?? location.index}' publication.schemaVersion must be a non-empty string.`, { ...location, field: `${field}.schemaVersion` });
  }

  if (!isOneOf(record.publicationState, PUBLICATION_STATES)) {
    addFinding(findings, 'error', 'publication', 'VOICE-REG-041-INVALID-PUBLICATION-STATE', `Entry '${location.profileId ?? location.index}' publication.publicationState must be draft | review_only | approved, got '${String(record.publicationState)}'.`, { ...location, field: `${field}.publicationState` });
  }

  if (!isOneOf(record.origin, PUBLICATION_ORIGINS)) {
    addFinding(findings, 'error', 'publication', 'VOICE-REG-042-INVALID-PUBLICATION-ORIGIN', `Entry '${location.profileId ?? location.index}' publication.origin must be legacy_kokoro_fixture | authored_first_party | custom_unverified, got '${String(record.origin)}'.`, { ...location, field: `${field}.origin` });
  }

  // Engine identity.
  if (record.engine !== undefined) {
    const engine = record.engine as unknown as Record<string, unknown> | null;
    if (!engine || typeof engine !== 'object') {
      addFinding(findings, 'error', 'publication', 'VOICE-REG-044-INVALID-ENGINE-IDENTITY', `Entry '${location.profileId ?? location.index}' publication.engine must be an object when declared.`, { ...location, field: `${field}.engine` });
    } else {
      if (!isOneOf(engine.engine, ENGINE_KINDS)) {
        addFinding(findings, 'error', 'publication', 'VOICE-REG-044-INVALID-ENGINE-IDENTITY', `Entry '${location.profileId ?? location.index}' publication.engine.engine must be kokoro | chatterbox | external, got '${String(engine.engine)}'.`, { ...location, field: `${field}.engine.engine` });
      }
      if (typeof engine.modelId !== 'string' || !engine.modelId.trim()) {
        addFinding(findings, 'error', 'publication', 'VOICE-REG-044-INVALID-ENGINE-IDENTITY', `Entry '${location.profileId ?? location.index}' publication.engine.modelId must be a non-empty string.`, { ...location, field: `${field}.engine.modelId` });
      }
    }
  }

  // Acoustic source.
  if (record.acousticSource !== undefined) {
    const source = record.acousticSource as unknown as Record<string, unknown> | null;
    if (!source || typeof source !== 'object') {
      addFinding(findings, 'error', 'publication', 'VOICE-REG-045-INVALID-ACOUSTIC-SOURCE', `Entry '${location.profileId ?? location.index}' publication.acousticSource must be an object when declared.`, { ...location, field: `${field}.acousticSource` });
    } else if (!isOneOf(source.kind, ACOUSTIC_SOURCE_KINDS)) {
      addFinding(findings, 'error', 'publication', 'VOICE-REG-045-INVALID-ACOUSTIC-SOURCE', `Entry '${location.profileId ?? location.index}' publication.acousticSource.kind must be cloned_reference_audio | preset_model_voice, got '${String(source.kind)}'.`, { ...location, field: `${field}.acousticSource.kind` });
    } else if (source.kind === 'cloned_reference_audio') {
      const referenceAudio = source.referenceAudio as unknown as Record<string, unknown> | undefined;
      if (!referenceAudio || typeof referenceAudio !== 'object') {
        addFinding(findings, 'error', 'publication', 'VOICE-REG-045-INVALID-ACOUSTIC-SOURCE', `Entry '${location.profileId ?? location.index}' declares a cloned reference voice without publication.acousticSource.referenceAudio.`, { ...location, field: `${field}.acousticSource.referenceAudio` });
      } else if (typeof referenceAudio.path === 'string' && !isSafeRelativeVoicePath(referenceAudio.path)) {
        addFinding(findings, 'error', 'integrity', 'VOICE-REG-046-UNSAFE-PUBLICATION-PATH', `Entry '${location.profileId ?? location.index}' reference audio path '${referenceAudio.path}' is not a safe relative path.`, { ...location, field: `${field}.acousticSource.referenceAudio.path` });
      }
    }
  }

  // Consent.
  if (record.consent !== undefined) {
    const consent = record.consent as unknown as Record<string, unknown> | null;
    if (!consent || typeof consent !== 'object') {
      addFinding(findings, 'error', 'rights', 'VOICE-REG-047-INVALID-CONSENT-RECORD', `Entry '${location.profileId ?? location.index}' publication.consent must be an object when declared.`, { ...location, field: `${field}.consent` });
    } else {
      if (!isOneOf(consent.subject, CONSENT_SUBJECTS)) {
        addFinding(findings, 'error', 'rights', 'VOICE-REG-047-INVALID-CONSENT-RECORD', `Entry '${location.profileId ?? location.index}' publication.consent.subject must be recorded_speaker | model_provider_preset, got '${String(consent.subject)}'.`, { ...location, field: `${field}.consent.subject` });
      }
      if (!Array.isArray(consent.scope) || consent.scope.some((s) => !isOneOf(s, CONSENT_SCOPES))) {
        addFinding(findings, 'error', 'rights', 'VOICE-REG-048-INVALID-CONSENT-SCOPE', `Entry '${location.profileId ?? location.index}' publication.consent.scope must be an array of known consent scopes.`, { ...location, field: `${field}.consent.scope` });
      }
      if (typeof consent.evidencePath === 'string' && !isSafeRelativeVoicePath(consent.evidencePath)) {
        addFinding(findings, 'error', 'integrity', 'VOICE-REG-046-UNSAFE-PUBLICATION-PATH', `Entry '${location.profileId ?? location.index}' consent evidence path '${consent.evidencePath}' is not a safe relative path.`, { ...location, field: `${field}.consent.evidencePath` });
      }
    }
  }

  // Rights evidence.
  if (record.rights !== undefined) {
    const rights = record.rights as unknown as Record<string, unknown> | null;
    if (!rights || typeof rights !== 'object') {
      addFinding(findings, 'error', 'rights', 'VOICE-REG-049-INVALID-RIGHTS-EVIDENCE', `Entry '${location.profileId ?? location.index}' publication.rights must be an object when declared.`, { ...location, field: `${field}.rights` });
    } else {
      if (rights.commercialUse !== undefined && !isOneOf(rights.commercialUse, COMMERCIAL_USE_STATUSES)) {
        addFinding(findings, 'error', 'rights', 'VOICE-REG-049-INVALID-RIGHTS-EVIDENCE', `Entry '${location.profileId ?? location.index}' publication.rights.commercialUse must be permitted | conditional | prohibited | unknown | not_stated, got '${String(rights.commercialUse)}'.`, { ...location, field: `${field}.rights.commercialUse` });
      }
      if (typeof rights.localEvidencePath === 'string' && !isSafeRelativeVoicePath(rights.localEvidencePath)) {
        addFinding(findings, 'error', 'integrity', 'VOICE-REG-046-UNSAFE-PUBLICATION-PATH', `Entry '${location.profileId ?? location.index}' rights evidence path '${rights.localEvidencePath}' is not a safe relative path.`, { ...location, field: `${field}.rights.localEvidencePath` });
      }
    }
  }

  // Audition.
  if (record.audition !== undefined) {
    const audition = record.audition as unknown as Record<string, unknown> | null;
    if (!audition || typeof audition !== 'object') {
      addFinding(findings, 'error', 'publication', 'VOICE-REG-050-INVALID-AUDITION-RECORD', `Entry '${location.profileId ?? location.index}' publication.audition must be an object when declared.`, { ...location, field: `${field}.audition` });
    } else {
      if (!isOneOf(audition.state, AUDITION_STATES)) {
        addFinding(findings, 'error', 'publication', 'VOICE-REG-050-INVALID-AUDITION-RECORD', `Entry '${location.profileId ?? location.index}' publication.audition.state must be not_tested | approved | rejected, got '${String(audition.state)}'.`, { ...location, field: `${field}.audition.state` });
      }
      for (const pathField of ['samplePath', 'evidencePath'] as const) {
        const value = audition[pathField];
        if (typeof value === 'string' && !isSafeRelativeVoicePath(value)) {
          addFinding(findings, 'error', 'integrity', 'VOICE-REG-046-UNSAFE-PUBLICATION-PATH', `Entry '${location.profileId ?? location.index}' audition ${pathField} '${value}' is not a safe relative path.`, { ...location, field: `${field}.audition.${pathField}` });
        }
      }
    }
  }
}

/**
 * Deep-copies a publication record so a frozen registry cannot share mutable
 * objects with the caller. Deterministic key order is preserved by copying
 * field-by-field in declaration order.
 */
function cloneVoicePublication(publication: VoicePublicationProfile | undefined): VoicePublicationProfile | undefined {
  if (!publication) return undefined;
  return JSON.parse(JSON.stringify(publication)) as VoicePublicationProfile;
}

/**
 * Validates a voice registry for:
 * - duplicate voice IDs
 * - duplicate voiceSlots
 * - malformed entries (missing required fields, invalid language, empty strings)
 */
export function validateVoiceRegistry(registry: VoiceRegistry | readonly VoiceProfile[] | null | undefined): VoiceRegistryValidationReport {
  const findings: VoiceRegistryFinding[] = [];

  if (!registry || !Array.isArray(registry)) {
    addFinding(findings, 'error', 'malformed', 'VOICE-REG-001-INVALID-REGISTRY', 'Registry must be a non-null array of VoiceProfile entries.');
    return {
      valid: false,
      errorCount: findings.filter(f => f.severity === 'error').length,
      warningCount: findings.filter(f => f.severity === 'warning').length,
      findings,
    };
  }

  if (registry.length === 0) {
    addFinding(findings, 'error', 'integrity', 'VOICE-REG-002-EMPTY-REGISTRY', 'Registry must contain at least one voice profile.');
  }

  const idToIndices = new Map<string, number[]>();
  const slotToIndices = new Map<string, number[]>();

  for (let i = 0; i < registry.length; i++) {
    const entry = registry[i] as Partial<VoiceProfile> | null | undefined;
    const locBase = { index: i };

    if (!entry || typeof entry !== 'object') {
      addFinding(findings, 'error', 'malformed', 'VOICE-REG-010-NOT-OBJECT', `Entry at index ${i} is not an object.`, locBase);
      continue;
    }

    // id validation
    if (!entry.id || typeof entry.id !== 'string' || !entry.id.trim()) {
      addFinding(findings, 'error', 'malformed', 'VOICE-REG-011-MISSING-ID', `Entry at index ${i} has missing or empty id.`, { ...locBase, field: 'id' });
    } else {
      const id = entry.id.trim();
      if (!/^[a-zA-Z0-9_.-]+$/.test(id)) {
        addFinding(findings, 'error', 'malformed', 'VOICE-REG-012-INVALID-ID-FORMAT', `Entry id '${id}' at index ${i} contains invalid characters.`, { ...locBase, profileId: id, field: 'id' });
      }
      const existing = idToIndices.get(id) || [];
      existing.push(i);
      idToIndices.set(id, existing);
    }

    // voiceSlot validation
    if (!entry.voiceSlot || typeof entry.voiceSlot !== 'string' || !entry.voiceSlot.trim()) {
      addFinding(findings, 'error', 'malformed', 'VOICE-REG-013-MISSING-SLOT', `Entry at index ${i} has missing or empty voiceSlot.`, { ...locBase, field: 'voiceSlot', profileId: entry.id });
    } else {
      const slot = entry.voiceSlot.trim();
      if (!/^[a-zA-Z0-9_.-]+$/.test(slot)) {
        addFinding(findings, 'error', 'malformed', 'VOICE-REG-014-INVALID-SLOT-FORMAT', `voiceSlot '${slot}' at index ${i} contains invalid characters.`, { ...locBase, voiceSlot: slot, field: 'voiceSlot', profileId: entry.id });
      }
      // Must start with voice_ per convention, but allow but warn if not
      if (!slot.startsWith('voice_')) {
        addFinding(findings, 'warning', 'integrity', 'VOICE-REG-015-SLOT-NAMING', `voiceSlot '${slot}' at index ${i} does not follow 'voice_' naming convention.`, { ...locBase, voiceSlot: slot, profileId: entry.id });
      }
      const existing = slotToIndices.get(slot) || [];
      existing.push(i);
      slotToIndices.set(slot, existing);
    }

    // displayName
    if (!entry.displayName || typeof entry.displayName !== 'string' || !entry.displayName.trim()) {
      addFinding(findings, 'error', 'malformed', 'VOICE-REG-016-MISSING-DISPLAY-NAME', `Entry '${entry.id ?? i}' has missing or empty displayName.`, { ...locBase, profileId: entry.id, voiceSlot: entry.voiceSlot, field: 'displayName' });
    }

    // primaryLanguage
    if (!entry.primaryLanguage || typeof entry.primaryLanguage !== 'string' || !entry.primaryLanguage.trim()) {
      addFinding(findings, 'error', 'malformed', 'VOICE-REG-017-MISSING-PRIMARY-LANGUAGE', `Entry '${entry.id ?? i}' has missing primaryLanguage.`, { ...locBase, profileId: entry.id, voiceSlot: entry.voiceSlot, field: 'primaryLanguage' });
    } else if (!isValidLanguageCode(entry.primaryLanguage.trim())) {
      addFinding(findings, 'error', 'language', 'VOICE-REG-018-INVALID-PRIMARY-LANGUAGE', `Entry '${entry.id ?? i}' has invalid primaryLanguage '${entry.primaryLanguage}'.`, { ...locBase, profileId: entry.id, voiceSlot: entry.voiceSlot, field: 'primaryLanguage' });
    }

    // languages array
    if (!Array.isArray(entry.languages) || entry.languages.length === 0) {
      addFinding(findings, 'error', 'malformed', 'VOICE-REG-019-MISSING-LANGUAGES', `Entry '${entry.id ?? i}' must have a non-empty languages array.`, { ...locBase, profileId: entry.id, voiceSlot: entry.voiceSlot, field: 'languages' });
    } else {
      const seenLangs = new Set<string>();
      for (let li = 0; li < entry.languages.length; li++) {
        const lang = entry.languages[li];
        if (!lang || typeof lang !== 'string' || !lang.trim()) {
          addFinding(findings, 'error', 'malformed', 'VOICE-REG-020-EMPTY-LANGUAGE', `Entry '${entry.id ?? i}' has empty language at languages[${li}].`, { ...locBase, profileId: entry.id, voiceSlot: entry.voiceSlot, field: `languages[${li}]` });
          continue;
        }
        const trimmedLang = lang.trim();
        if (!isValidLanguageCode(trimmedLang)) {
          addFinding(findings, 'error', 'language', 'VOICE-REG-021-INVALID-LANGUAGE-CODE', `Entry '${entry.id ?? i}' has invalid language code '${trimmedLang}' at languages[${li}].`, { ...locBase, profileId: entry.id, voiceSlot: entry.voiceSlot, field: `languages[${li}]` });
        }
        const lower = trimmedLang.toLowerCase();
        if (seenLangs.has(lower)) {
          addFinding(findings, 'error', 'duplicate', 'VOICE-REG-022-DUPLICATE-LANGUAGE', `Entry '${entry.id ?? i}' has duplicate language '${trimmedLang}' in languages array.`, { ...locBase, profileId: entry.id, voiceSlot: entry.voiceSlot, field: `languages[${li}]` });
        }
        seenLangs.add(lower);
      }
      // primaryLanguage must be included in languages
      if (entry.primaryLanguage && typeof entry.primaryLanguage === 'string') {
        const primaryLower = entry.primaryLanguage.trim().toLowerCase();
        if (primaryLower && !seenLangs.has(primaryLower)) {
          addFinding(findings, 'error', 'language', 'VOICE-REG-023-PRIMARY-NOT-IN-LANGUAGES', `Entry '${entry.id ?? i}' primaryLanguage '${entry.primaryLanguage}' must be included in languages array.`, { ...locBase, profileId: entry.id, voiceSlot: entry.voiceSlot, field: 'primaryLanguage' });
        }
      }
    }

    // version
    if (!entry.version || typeof entry.version !== 'string' || !entry.version.trim()) {
      addFinding(findings, 'error', 'malformed', 'VOICE-REG-024-MISSING-VERSION', `Entry '${entry.id ?? i}' has missing or empty version.`, { ...locBase, profileId: entry.id, voiceSlot: entry.voiceSlot, field: 'version' });
    }

    // enabled must be boolean
    if (typeof entry.enabled !== 'boolean') {
      addFinding(findings, 'error', 'malformed', 'VOICE-REG-025-INVALID-ENABLED', `Entry '${entry.id ?? i}' enabled must be a boolean.`, { ...locBase, profileId: entry.id, voiceSlot: entry.voiceSlot, field: 'enabled' });
    }

    // gender if present
    if (entry.gender !== undefined) {
      const validGenders = ['female', 'male', 'neutral', 'unspecified'];
      if (!validGenders.includes(entry.gender as string)) {
        addFinding(findings, 'error', 'malformed', 'VOICE-REG-026-INVALID-GENDER', `Entry '${entry.id ?? i}' has invalid gender '${entry.gender}'.`, { ...locBase, profileId: entry.id, voiceSlot: entry.voiceSlot, field: 'gender' });
      }
    }

    // VS1: commercial publication record, when one is attached.
    if ((entry as VoiceProfile).publication !== undefined) {
      validatePublicationRecord(findings, (entry as VoiceProfile).publication, {
        ...locBase,
        profileId: entry.id,
        voiceSlot: entry.voiceSlot,
      });
    }
  }

  // Check duplicates
  for (const [id, indices] of idToIndices.entries()) {
    if (indices.length > 1) {
      addFinding(
        findings,
        'error',
        'duplicate',
        'VOICE-REG-030-DUPLICATE-ID',
        `Duplicate voice profile id '${id}' found at indices ${indices.join(', ')}.`,
        { profileId: id }
      );
    }
  }

  for (const [slot, indices] of slotToIndices.entries()) {
    if (indices.length > 1) {
      addFinding(
        findings,
        'error',
        'duplicate',
        'VOICE-REG-031-DUPLICATE-SLOT',
        `Duplicate voiceSlot '${slot}' found at indices ${indices.join(', ')}.`,
        { voiceSlot: slot }
      );
    }
  }

  const errorCount = findings.filter(f => f.severity === 'error').length;
  const warningCount = findings.filter(f => f.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    errorCount,
    warningCount,
    findings,
  };
}

/**
 * Factory that validates and returns an immutable copy of the registry.
 * Throws VoiceResolutionError if invalid.
 */
export function createVoiceRegistry(profiles: VoiceProfile[]): VoiceRegistry {
  const report = validateVoiceRegistry(profiles);
  if (!report.valid) {
    const details = report.findings
      .filter(f => f.severity === 'error')
      .map(f => `[${f.ruleId}] ${f.message}`)
      .join('; ');
    throw new VoiceResolutionError('REGISTRY_VALIDATION_FAILED', `Voice registry validation failed: ${details}`, {
      findings: report.findings,
    });
  }
  // Return frozen copy. The VS1 publication record is copied too, so a registry
  // handed to a caller never shares mutable rights/consent objects with it.
  return Object.freeze([...profiles.map(p => ({
    ...p,
    languages: [...p.languages],
    synthesisHints: p.synthesisHints ? { ...p.synthesisHints, extra: p.synthesisHints.extra ? { ...p.synthesisHints.extra } : undefined } : undefined,
    ...(p.publication ? { publication: cloneVoicePublication(p.publication) } : {}),
  }))]) as VoiceRegistry;
}

/**
 * Canonical default registry covering all fixture voiceSlots.
 * Deterministic, provider-neutral, local-first.
 */
export const DEFAULT_VOICE_REGISTRY: VoiceRegistry = Object.freeze([
  {
    id: 'vp_en_female_authority_v1',
    voiceSlot: 'voice_en_female_authority',
    displayName: 'English Female Authority',
    description: 'Confident female voice for project manager / authority roles, en-GB primary',
    primaryLanguage: 'en-GB',
    languages: ['en-GB', 'en-US', 'en'],
    gender: 'female',
    roleHint: 'authority',
    synthesisHints: { rate: 'medium', pitch: 'medium', style: 'confident' },
    enabled: true,
    version: '1.0.0',
    createdAt: '2026-09-29T00:00:00Z',
  },
  {
    id: 'vp_en_male_practical_v1',
    voiceSlot: 'voice_en_male_practical',
    displayName: 'English Male Practical',
    description: 'Grounded male voice for site engineer / practical roles, en-GB primary',
    primaryLanguage: 'en-GB',
    languages: ['en-GB', 'en-US', 'en'],
    gender: 'male',
    roleHint: 'practical',
    synthesisHints: { rate: 'medium', pitch: 'low', style: 'practical' },
    enabled: true,
    version: '1.0.0',
    createdAt: '2026-09-29T00:00:00Z',
  },
  {
    id: 'vp_en_male_commercial_v1',
    voiceSlot: 'voice_en_male_commercial',
    displayName: 'English Male Commercial',
    description: 'Assertive male voice for commercial manager / challenger roles, en-GB primary',
    primaryLanguage: 'en-GB',
    languages: ['en-GB', 'en-US', 'en'],
    gender: 'male',
    roleHint: 'commercial',
    synthesisHints: { rate: 'medium', pitch: 'medium', style: 'assertive' },
    enabled: true,
    version: '1.0.0',
    createdAt: '2026-09-29T00:00:00Z',
  },
  {
    id: 'vp_en_female_legal_v1',
    voiceSlot: 'voice_en_female_legal',
    displayName: 'English Female Legal',
    description: 'Precise female voice for legal / compliance roles, en-GB primary',
    primaryLanguage: 'en-GB',
    languages: ['en-GB', 'en-US', 'en'],
    gender: 'female',
    roleHint: 'legal',
    synthesisHints: { rate: 'slow', pitch: 'medium', style: 'precise' },
    enabled: true,
    version: '1.0.0',
    createdAt: '2026-09-29T00:00:00Z',
  },
  {
    id: 'vp_en_male_advocate_v1',
    voiceSlot: 'voice_en_male_advocate',
    displayName: 'English Male Advocate',
    description: 'Persuasive male voice for contractor advocate roles, en-GB primary',
    primaryLanguage: 'en-GB',
    languages: ['en-GB', 'en-US', 'en'],
    gender: 'male',
    roleHint: 'advocate',
    synthesisHints: { rate: 'medium', pitch: 'medium', style: 'persuasive' },
    enabled: true,
    version: '1.0.0',
    createdAt: '2026-09-29T00:00:00Z',
  },
  {
    id: 'vp_us_female_analytic_v1',
    voiceSlot: 'voice_us_female_analytic',
    displayName: 'US Female Analytic',
    description: 'Analytic female voice for planning engineer / data-driven roles, en-US primary',
    primaryLanguage: 'en-US',
    languages: ['en-US', 'en-GB', 'en'],
    gender: 'female',
    roleHint: 'analytic',
    synthesisHints: { rate: 'fast', pitch: 'medium', style: 'analytic' },
    enabled: true,
    version: '1.0.0',
    createdAt: '2026-09-29T00:00:00Z',
  },
  {
    id: 'vp_us_male_executive_v1',
    voiceSlot: 'voice_us_male_executive',
    displayName: 'US Male Executive',
    description: 'Executive male voice for project director / decision maker roles, en-US primary',
    primaryLanguage: 'en-US',
    languages: ['en-US', 'en-GB', 'en'],
    gender: 'male',
    roleHint: 'executive',
    synthesisHints: { rate: 'medium', pitch: 'low', style: 'authoritative' },
    enabled: true,
    version: '1.0.0',
    createdAt: '2026-09-29T00:00:00Z',
  },
  {
    id: 'vp_us_male_field_v1',
    voiceSlot: 'voice_us_male_field',
    displayName: 'US Male Field',
    description: 'Field-experienced male voice for MEP lead / execution roles, en-US primary',
    primaryLanguage: 'en-US',
    languages: ['en-US', 'en-GB', 'en'],
    gender: 'male',
    roleHint: 'field',
    synthesisHints: { rate: 'medium', pitch: 'low', style: 'practical' },
    enabled: true,
    version: '1.0.0',
    createdAt: '2026-09-29T00:00:00Z',
  },
] as VoiceRegistry);

/**
 * Re-validates DEFAULT_VOICE_REGISTRY at module load time to ensure
 * canonical registry is always valid. This is a safety net; it will
 * throw if the default registry is malformed, failing fast.
 */
const _defaultValidation = validateVoiceRegistry(DEFAULT_VOICE_REGISTRY);
if (!_defaultValidation.valid) {
  const errs = _defaultValidation.findings.filter(f => f.severity === 'error').map(f => f.message).join('; ');
  throw new Error(`DEFAULT_VOICE_REGISTRY is invalid at module load: ${errs}`);
}

/* ------------------------------------------------------------------ */
/*  VS1 — the migrated default registry                                */
/* ------------------------------------------------------------------ */

/**
 * The Phase 4A fixtures with their commercial publication records completed by
 * the deterministic VS1 migration: every entry is an explicit LOCAL KOKORO
 * profile (engine `kokoro`, pinned ONNX model, pinned `kokoro-js` runtime,
 * documented preset voice, provider-preset consent, Apache-2.0 rights evidence,
 * inherited audition approval, `publicationState: 'approved'`).
 *
 * `DEFAULT_VOICE_REGISTRY` itself is intentionally left exactly as authored, so
 * legacy fixtures stay readable and the migration path stays observable.
 */
export const MIGRATED_DEFAULT_VOICE_REGISTRY: VoiceRegistry = Object.freeze(
  migrateVoiceRegistryForPublication(DEFAULT_VOICE_REGISTRY)
);

/**
 * Fails fast when the migration ever stops producing publishable voices.
 *
 * This is the guard behind "legacy Kokoro fixtures remain valid": if a future
 * edit to the migration, the gate or the fixture list makes one of the eight
 * canonical voices unproducible, this module throws at load time instead of
 * letting production discover it mid-render.
 */
const _migratedValidation = validateVoiceRegistry(MIGRATED_DEFAULT_VOICE_REGISTRY);
if (!_migratedValidation.valid) {
  const errs = _migratedValidation.findings.filter(f => f.severity === 'error').map(f => `[${f.ruleId}] ${f.message}`).join('; ');
  throw new Error(`MIGRATED_DEFAULT_VOICE_REGISTRY is invalid at module load: ${errs}`);
}

const _migratedGateFailures = MIGRATED_DEFAULT_VOICE_REGISTRY.map(profile => evaluateVoicePublicationGate(profile)).filter(report => !report.allowed);
if (_migratedGateFailures.length > 0) {
  const errs = _migratedGateFailures
    .map(report => `${report.voiceSlot}: ${report.findings.filter(f => f.severity === 'error').map(f => `[${f.ruleId}] ${f.message}`).join('; ')}`)
    .join(' | ');
  throw new Error(`Legacy Kokoro fixtures no longer pass the VS1 publication gate at module load: ${errs}`);
}
