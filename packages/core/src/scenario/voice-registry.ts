/**
 * BuildTrack Video Factory - Phase 4A Voice Registry
 *
 * Canonical, deterministic, local-first registry of known voice profiles.
 * No network, no I/O, no synthesis. Validates duplicate IDs/slots and malformed entries.
 */

import {
  VoiceProfile,
  VoiceRegistry,
  VoiceRegistryFinding,
  VoiceRegistryValidationReport,
  VoiceResolutionError,
} from './voice-types.js';

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
  // Return frozen shallow copy
  return Object.freeze([...profiles.map(p => ({ ...p, languages: [...p.languages], synthesisHints: p.synthesisHints ? { ...p.synthesisHints, extra: p.synthesisHints.extra ? { ...p.synthesisHints.extra } : undefined } : undefined }))]) as VoiceRegistry;
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
