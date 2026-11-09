/**
 * BuildTrack Video Factory - Phase 4A Voice Resolver
 *
 * Deterministic lookup/resolution from voiceSlot → VoiceProfile.
 * Handles language compatibility, explicit fallback, disabled profiles,
 * and structured errors. No network, no synthesis, no I/O.
 */

import { DialogueAudioPlan } from './dialogue-audio-types.js';
import { DEFAULT_VOICE_REGISTRY, validateVoiceRegistry } from './voice-registry.js';
import { migrateVoiceProfileForPublication } from './voice-publication-migration.js';
import { evaluateVoicePublicationGate } from './voice-publication-gate.js';
import {
  DialogueAudioPlanVoiceResolution,
  ResolvedVoice,
  VoiceProfile,
  VoicePublicationGateBatchReport,
  VoicePublicationGateReport,
  VoiceRegistry,
  VoiceResolutionError,
  VoiceResolutionOptions,
} from './voice-types.js';

/** Normalize language code for comparison */
function normalizeLang(code: string): string {
  return code.trim().toLowerCase();
}

/** Extract base language, e.g. en-GB -> en, en -> en */
function baseLanguage(code: string): string {
  const normalized = normalizeLang(code);
  const dashIdx = normalized.indexOf('-');
  return dashIdx >= 0 ? normalized.slice(0, dashIdx) : normalized;
}

/**
 * Checks if a requested language is compatible with a profile's supported languages.
 *
 * Compatibility rules:
 * - If no requested language is provided, always compatible (no check)
 * - Exact case-insensitive match => compatible
 * - If strictLanguageMatch is false (default):
 *   base language match is allowed: en-GB compatible with en, en-US compatible with en, etc.
 *   Also en compatible with en-GB (generic matches specific)
 * - If strictLanguageMatch is true: only exact match allowed
 */
export function isLanguageCompatible(
  requestedLanguage: string | undefined,
  supportedLanguages: string[],
  strictLanguageMatch = false
): boolean {
  if (!requestedLanguage || !requestedLanguage.trim()) {
    return true;
  }
  if (!Array.isArray(supportedLanguages) || supportedLanguages.length === 0) {
    return false;
  }

  const requestedNorm = normalizeLang(requestedLanguage);
  const requestedBase = baseLanguage(requestedLanguage);

  for (const sup of supportedLanguages) {
    if (!sup || typeof sup !== 'string') continue;
    const supNorm = normalizeLang(sup);
    const supBase = baseLanguage(sup);

    if (supNorm === requestedNorm) {
      return true;
    }

    if (!strictLanguageMatch) {
      // Base language match: en-GB <-> en-US both base en => compatible
      // Also generic en matches specific en-GB
      if (supBase === requestedBase) {
        return true;
      }
    }
  }

  return false;
}

/** Internal helper to get registry to use */
function getEffectiveRegistry(options?: VoiceResolutionOptions): VoiceRegistry {
  const registry = options?.registry ?? DEFAULT_VOICE_REGISTRY;
  if (!Array.isArray(registry)) {
    throw new VoiceResolutionError('MALFORMED_REGISTRY_ENTRY', 'Registry must be an array.', { registry });
  }
  // Validate registry structure quickly for duplicates/malformed — deterministic safety
  const report = validateVoiceRegistry(registry);
  if (!report.valid) {
    const firstError = report.findings.find(f => f.severity === 'error');
    if (firstError) {
      // Map to specific codes where possible
      if (firstError.ruleId.includes('DUPLICATE-ID')) {
        throw new VoiceResolutionError('DUPLICATE_VOICE_ID', firstError.message, { findings: report.findings });
      }
      if (firstError.ruleId.includes('DUPLICATE-SLOT')) {
        throw new VoiceResolutionError('DUPLICATE_VOICE_SLOT', firstError.message, { findings: report.findings });
      }
      throw new VoiceResolutionError('REGISTRY_VALIDATION_FAILED', `Registry validation failed: ${firstError.message}`, {
        findings: report.findings,
      });
    }
  }
  return registry as VoiceRegistry;
}

/** Validates voiceSlot format */
function validateVoiceSlotFormat(slot: string): void {
  if (!slot || typeof slot !== 'string' || !slot.trim()) {
    throw new VoiceResolutionError('INVALID_VOICE_SLOT_FORMAT', 'voiceSlot must be a non-empty string.', { voiceSlot: slot });
  }
  const trimmed = slot.trim();
  if (trimmed.length > 128) {
    throw new VoiceResolutionError('INVALID_VOICE_SLOT_FORMAT', `voiceSlot '${trimmed}' exceeds maximum length of 128.`, { voiceSlot: trimmed });
  }
  // Allow only safe characters
  if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    throw new VoiceResolutionError('INVALID_VOICE_SLOT_FORMAT', `voiceSlot '${trimmed}' contains invalid characters.`, { voiceSlot: trimmed });
  }
}

/**
 * Resolves a single voiceSlot to a VoiceProfile deterministically.
 *
 * Steps:
 * 1. Validate slot format
 * 2. Check explicit fallbackMap if provided: if slot not found but mapped, resolve to mapped target
 * 3. Lookup in registry by exact trimmed match
 * 4. If not found and fallbackMap has entry for this slot, use fallback (explicit)
 * 5. If still not found → UNKNOWN_VOICE_SLOT
 * 6. Check enabled status
 * 7. Check language compatibility if requested
 */
export function resolveVoiceSlot(voiceSlot: string, options: VoiceResolutionOptions = {}): ResolvedVoice {
  validateVoiceSlotFormat(voiceSlot);
  const requestedTrimmed = voiceSlot.trim();

  const registry = getEffectiveRegistry(options);
  const language = options.language?.trim();
  const strictMatch = options.strictLanguageMatch === true;
  const allowDisabled = options.allowDisabled === true;
  const fallbackMap = options.fallbackMap;

  // Build lookup maps deterministically
  const slotToProfile = new Map<string, VoiceProfile>();
  for (const profile of registry) {
    // In case validation missed duplicate due to caller bypass, detect here
    if (slotToProfile.has(profile.voiceSlot)) {
      throw new VoiceResolutionError('DUPLICATE_VOICE_SLOT', `Duplicate voiceSlot '${profile.voiceSlot}' detected in registry during resolution.`, {
        voiceSlot: profile.voiceSlot,
      });
    }
    slotToProfile.set(profile.voiceSlot, profile);
  }

  let effectiveSlot = requestedTrimmed;
  let usedFallback = false;
  let fallbackFrom: string | undefined;

  // First try direct lookup
  let profile = slotToProfile.get(requestedTrimmed);

  // If not found, check explicit fallbackMap
  if (!profile && fallbackMap && typeof fallbackMap === 'object') {
    const mapped = fallbackMap[requestedTrimmed];
    if (mapped && typeof mapped === 'string' && mapped.trim()) {
      const mappedTrimmed = mapped.trim();
      // Validate mapped target exists
      const fallbackProfile = slotToProfile.get(mappedTrimmed);
      if (!fallbackProfile) {
        throw new VoiceResolutionError('UNKNOWN_VOICE_SLOT', `Fallback target voiceSlot '${mappedTrimmed}' for requested slot '${requestedTrimmed}' does not exist in registry.`, {
          requestedSlot: requestedTrimmed,
          fallbackTarget: mappedTrimmed,
        });
      }
      // Use fallback
      effectiveSlot = mappedTrimmed;
      profile = fallbackProfile;
      usedFallback = true;
      fallbackFrom = requestedTrimmed;
    }
  }

  if (!profile) {
    throw new VoiceResolutionError('UNKNOWN_VOICE_SLOT', `Unknown voiceSlot '${requestedTrimmed}' — no matching profile in registry.`, {
      requestedSlot: requestedTrimmed,
      availableSlots: Array.from(slotToProfile.keys()).sort(),
    });
  }

  // Check disabled
  if (!profile.enabled && !allowDisabled) {
    throw new VoiceResolutionError('DISABLED_VOICE_PROFILE', `Voice profile for slot '${profile.voiceSlot}' (id '${profile.id}') is disabled.`, {
      requestedSlot: requestedTrimmed,
      resolvedSlot: effectiveSlot,
      profileId: profile.id,
    });
  }

  // Check language compatibility
  if (language && !isLanguageCompatible(language, profile.languages, strictMatch)) {
    throw new VoiceResolutionError('INCOMPATIBLE_LANGUAGE', `Voice profile '${profile.voiceSlot}' does not support requested language '${language}'. Supported: ${profile.languages.join(', ')}.`, {
      requestedSlot: requestedTrimmed,
      resolvedSlot: effectiveSlot,
      requestedLanguage: language,
      supportedLanguages: profile.languages,
      profileId: profile.id,
      strictMatch,
    });
  }

  /*
   * VS1: every resolved voice carries an explicit publication record.
   *
   * Migration is deterministic and never mutates the registry: a legacy Phase 4A
   * Kokoro fixture becomes an explicit approved local-Kokoro profile, and
   * anything else becomes an unverified draft. Pass
   * `migrateLegacyPublication: false` to resolve the registry entries exactly as
   * written.
   */
  const migratedProfile =
    options.migrateLegacyPublication === false ? profile : migrateVoiceProfileForPublication(profile).profile;

  let publicationReport: VoicePublicationGateReport | undefined;
  if (options.requirePublicationApproval === true) {
    publicationReport = evaluateVoicePublicationGate(migratedProfile, options.publicationGate ?? {});
    if (!publicationReport.allowed) {
      const blocking = publicationReport.findings.filter(f => f.severity === 'error');
      throw new VoiceResolutionError(
        'VOICE_PUBLICATION_BLOCKED',
        `Voice '${effectiveSlot}' (id '${migratedProfile.id}') is not approved for published production [publicationState '${publicationReport.publicationState}']: ${blocking.map(f => `[${f.ruleId}] ${f.message}`).join('; ')}`,
        {
          requestedSlot: requestedTrimmed,
          resolvedSlot: effectiveSlot,
          profileId: migratedProfile.id,
          publicationState: publicationReport.publicationState,
          origin: publicationReport.origin,
          blockedCodes: blocking.map(f => f.code),
          findings: publicationReport.findings,
        }
      );
    }
  }

  return {
    requestedSlot: requestedTrimmed,
    resolvedSlot: effectiveSlot,
    profile: migratedProfile,
    usedFallback,
    fallbackFrom,
    ...(publicationReport ? { publication: publicationReport } : {}),
  };
}

/**
 * Resolves multiple voiceSlots deterministically.
 * Returns array in same order as input, deduplicated for lookup but preserving order for results.
 */
export function resolveVoiceSlots(voiceSlots: string[], options: VoiceResolutionOptions = {}): ResolvedVoice[] {
  if (!Array.isArray(voiceSlots)) {
    throw new VoiceResolutionError('INVALID_VOICE_SLOT_FORMAT', 'voiceSlots must be an array of strings.', { voiceSlots });
  }

  const results: ResolvedVoice[] = [];
  const seen = new Set<string>();

  for (const slot of voiceSlots) {
    validateVoiceSlotFormat(slot);
    const trimmed = slot.trim();
    if (seen.has(trimmed)) {
      // Skip duplicate requested slots but still resolve once — deterministic
      continue;
    }
    seen.add(trimmed);
    const resolved = resolveVoiceSlot(trimmed, options);
    results.push(resolved);
  }

  // Sort by requestedSlot for deterministic output? No, preserve input order but we already deduped.
  // For full determinism across runs, we return in order of first appearance, which is deterministic.
  return results;
}

/**
 * Resolves all voiceSlots referenced in a DialogueAudioPlan to VoiceProfiles.
 *
 * Uses plan.language for compatibility check by default, unless overridden in options.language.
 * Deterministic: same plan + same registry + same options → same result.
 */
export function resolveDialogueAudioPlanVoices(
  plan: DialogueAudioPlan,
  options: VoiceResolutionOptions = {}
): DialogueAudioPlanVoiceResolution {
  if (!plan || typeof plan !== 'object') {
    throw new VoiceResolutionError('MALFORMED_REGISTRY_ENTRY', 'DialogueAudioPlan must be a non-null object.', { plan });
  }

  const scenarioId = (plan as DialogueAudioPlan).scenarioId || 'unknown';
  const planLanguage = (plan as DialogueAudioPlan).language || options.language || 'en';

  // Effective language for compatibility: options.language overrides plan.language if provided
  const effectiveLanguage = options.language ?? planLanguage;

  // Collect unique voiceSlots from plan.characters and plan.clips
  const uniqueSlots = new Set<string>();

  if (Array.isArray((plan as DialogueAudioPlan).characters)) {
    for (const ch of (plan as DialogueAudioPlan).characters) {
      if (ch.voiceSlot && typeof ch.voiceSlot === 'string' && ch.voiceSlot.trim()) {
        uniqueSlots.add(ch.voiceSlot.trim());
      }
    }
  }

  if (Array.isArray((plan as DialogueAudioPlan).clips)) {
    for (const clip of (plan as DialogueAudioPlan).clips) {
      if (clip.voiceSlot && typeof clip.voiceSlot === 'string' && clip.voiceSlot.trim()) {
        uniqueSlots.add(clip.voiceSlot.trim());
      }
    }
  }

  if (uniqueSlots.size === 0) {
    throw new VoiceResolutionError('MISSING_PROFILE', `DialogueAudioPlan '${scenarioId}' contains no voiceSlots to resolve.`, {
      scenarioId,
    });
  }

  const slotsArray = Array.from(uniqueSlots).sort(); // sorted for deterministic resolution order

  const resolved = resolveVoiceSlots(slotsArray, {
    ...options,
    language: effectiveLanguage,
  });

  const bySlot: Record<string, VoiceProfile> = {};
  let hadFallback = false;
  for (const r of resolved) {
    bySlot[r.requestedSlot] = r.profile;
    // Also map resolvedSlot if fallback used, for convenience
    if (r.usedFallback) {
      bySlot[r.resolvedSlot] = r.profile;
      hadFallback = true;
    }
    if (r.usedFallback) hadFallback = true;
  }

  /*
   * VS1: when the publication gate was requested, roll the per-voice reports up
   * into one deterministic batch report for the audit trail. Blocked voices
   * never reach this point — `resolveVoiceSlot` already threw — so a present
   * `publicationGate.allowed === true` is a positive statement that every voice
   * in this plan is approved for published production.
   */
  let publicationGate: VoicePublicationGateBatchReport | undefined;
  if (options.requirePublicationApproval === true) {
    const reports = resolved
      .map(r => r.publication)
      .filter((r): r is VoicePublicationGateReport => !!r)
      .sort((a, b) => {
        if (a.voiceSlot !== b.voiceSlot) return a.voiceSlot < b.voiceSlot ? -1 : 1;
        if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
        return 0;
      });
    const blockedSlots = reports.filter(r => !r.allowed).map(r => r.voiceSlot).sort();
    publicationGate = {
      scenarioId,
      allowed: reports.length > 0 && blockedSlots.length === 0,
      blockedSlots,
      reports,
      errorCount: reports.reduce((sum, r) => sum + r.errorCount, 0),
      warningCount: reports.reduce((sum, r) => sum + r.warningCount, 0),
    };
  }

  return {
    scenarioId,
    language: effectiveLanguage,
    resolved,
    bySlot: Object.freeze({ ...bySlot }),
    hadFallback,
    ...(publicationGate ? { publicationGate } : {}),
  };
}

/**
 * Helper to list all known voiceSlots in the default registry, sorted.
 */
export function listKnownVoiceSlots(registry: VoiceRegistry = DEFAULT_VOICE_REGISTRY): string[] {
  return [...registry].map(p => p.voiceSlot).sort();
}

/**
 * Helper to get profile by ID (not slot) — useful for future phases.
 */
export function getVoiceProfileById(id: string, registry: VoiceRegistry = DEFAULT_VOICE_REGISTRY): VoiceProfile | undefined {
  if (!id || typeof id !== 'string') return undefined;
  const trimmed = id.trim();
  return registry.find(p => p.id === trimmed);
}
