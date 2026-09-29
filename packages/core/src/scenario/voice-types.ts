/**
 * BuildTrack Video Factory - Phase 4A Voice Profile Contract
 *
 * Canonical, provider-neutral voice profile definition and structured error taxonomy.
 * No synthesis, no I/O, no network — pure configuration describing a voice that
 * later phases (4B) can use for real TTS.
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
  | 'INVALID_VOICE_SLOT_FORMAT';

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
  | 'integrity';

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
}
