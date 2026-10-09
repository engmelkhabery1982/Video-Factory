/**
 * BuildTrack Video Factory - VS2 Chatterbox Voice Identity (pure constants)
 *
 * Single source of truth for the LOCAL Chatterbox voice-cloning engine family:
 *   - the two engine contracts this factory supports
 *     (`chatterbox-turbo`, `chatterbox-multilingual-v3`),
 *   - the exact Python package pin (`chatterbox-tts`) and the model repository
 *     each contract loads,
 *   - the native output sample rate (24 kHz mono — S3GEN_SR),
 *   - the git-ignored directories the isolated Python environment, the model
 *     cache, the scratch area and the provisioning marker live in,
 *   - the 23 language ids of the multilingual model and the deterministic
 *     language-tag mapping used before synthesis,
 *   - the Perth watermark disclosure carried by every generated file,
 *   - the provisioning-marker contract that proves what was actually fetched.
 *
 * Why this module is separate from `chatterbox-dialogue-synthesizer.ts`
 * ---------------------------------------------------------------------
 * Same reason as `kokoro-voice-identity.ts`: the contract layer has to be able
 * to state a documented, auditable engine identity, and that layer is
 * deliberately I/O-free (Phase 4A doctrine) while the adapter pulls in
 * `node:fs`, `node:child_process` and a real Python worker. These constants
 * carry no I/O and no dependencies beyond the voice TYPES, so both sides can
 * share them.
 *
 * VERIFIED FACTS (fetched 2026-10-08, pypi.org + the upstream GitHub repository;
 * never inferred, never invented — see DEPENDENCIES.md § Chatterbox):
 *   - package `chatterbox-tts`, latest `0.1.7`, MIT licensed, `requires_python
 *     >= 3.10`, pinned `torch==2.6.0` / `torchaudio==2.6.0` / `transformers==5.2.0`;
 *   - `chatterbox.tts_turbo.ChatterboxTurboTTS` loads
 *     `ResembleAI/chatterbox-turbo` (350M, English only) and logs that CFG,
 *     `min_p` and `exaggeration` are NOT supported and are IGNORED;
 *   - `chatterbox.mtl_tts.ChatterboxMultilingualTTS` loads
 *     `ResembleAI/chatterbox` (500M, 23 language ids) with upstream
 *     `revision="main"` — a FLOATING branch, so the resolved commit must be
 *     recorded at provisioning time and can never be fabricated here;
 *   - native output is 24 kHz mono (`S3GEN_SR = 24000`);
 *   - every generated file carries Resemble AI's Perth (Perceptual Threshold)
 *     neural watermark.
 */

import type { VoiceAcousticIdentity } from './voice-types.js';

/* ------------------------------------------------------------------ */
/*  Engine family identity                                             */
/* ------------------------------------------------------------------ */

/** Engine id reported by the adapter and recorded in synthesis manifests. */
export const CHATTERBOX_ENGINE_ID = 'chatterbox-tts';

/**
 * `chatterbox-tts` exact pin. The Python package is NOT an npm dependency and
 * is installed only by `tools/provision-chatterbox.mjs` into an isolated env.
 */
export const CHATTERBOX_PACKAGE_VERSION = '0.1.7';

/** Native model output sample rate (Hz) — `S3GEN_SR` in the upstream source. */
export const CHATTERBOX_SAMPLE_RATE = 24000;

/** Neural watermark every Chatterbox output carries (upstream `resemble-perth`). */
export const CHATTERBOX_WATERMARK_PROVIDER = 'resemble-perth';

/** Repo-relative, Git-ignored locations owned by Chatterbox provisioning. */
export const CHATTERBOX_DIR = '.chatterbox';
export const CHATTERBOX_MODEL_DIR = '.chatterbox/models';
export const CHATTERBOX_ENV_DIR = '.chatterbox/env';
export const CHATTERBOX_SCRATCH_DIR = '.chatterbox/scratch';
export const CHATTERBOX_PROVISION_MARKER_PATH = '.chatterbox/provisioned.json';

/** Repo-relative, Git-ignored location for approved reference recordings. */
export const CHATTERBOX_REFERENCE_ROOT = '.voice-references';

/** Schema version of the provisioning marker written by the provisioning tool. */
export const CHATTERBOX_MARKER_SCHEMA_VERSION = 1;

/**
 * Canonical-format contract the adapter must satisfy (48 kHz mono PCM16 WAV per
 * `audio-validation-types.ts`, schema `1.0.0`). It is part of the synthesis
 * reuse identity, so a future canonical-contract change invalidates reuse.
 */
export const CHATTERBOX_CANONICAL_CONTRACT = 'audio/canonical@1.0.0';

/* ------------------------------------------------------------------ */
/*  Engine contracts                                                   */
/* ------------------------------------------------------------------ */

export type ChatterboxEngineContractId = 'chatterbox-turbo' | 'chatterbox-multilingual-v3';

/** The 23 language ids supported by Chatterbox Multilingual (verified list). */
export const CHATTERBOX_MULTILINGUAL_LANGUAGE_IDS: readonly string[] = Object.freeze([
  'ar',
  'da',
  'de',
  'el',
  'en',
  'es',
  'fi',
  'fr',
  'he',
  'hi',
  'it',
  'ja',
  'ko',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'ru',
  'sv',
  'sw',
  'tr',
  'zh',
]);

/**
 * Effective voice settings of one synthesis. Only knobs verified to exist in the
 * upstream `generate(...)` signature are exposed; anything else is deliberately
 * absent so nothing can be "set" that the engine would silently ignore.
 */
export interface ChatterboxVoiceSettings {
  /** Emotional intensity. Verified default `0.5`; NOT supported by turbo. */
  exaggeration: number;
  /** Classifier-free-guidance weight. Verified default `0.5`; NOT supported by turbo. */
  cfgWeight: number;
  /** Optional `min_p` sampling floor. NOT supported by turbo. Unset = engine default. */
  minP?: number;
}

/** Auditable contract of one Chatterbox engine. */
export interface ChatterboxEngineContract {
  readonly id: ChatterboxEngineContractId;
  readonly label: string;
  /** Model repository id. A voice profile must declare EXACTLY this id. */
  readonly modelId: string;
  /** Upstream Python class that loads the model. */
  readonly pythonClass: string;
  /** Published parameter count (marketing/asset note, not a runtime value). */
  readonly parameterCount: string;
  /** Chatterbox language ids this contract can speak. */
  readonly languages: readonly string[];
  /** Whether `exaggeration` / `cfgWeight` / `minP` are honoured at all. */
  readonly supportsVoiceSettings: boolean;
  /** Settings used when a caller declares none (verified upstream defaults). */
  readonly defaultVoiceSettings: ChatterboxVoiceSettings;
  /** Recommended reference-clip length in seconds (upstream README: ~10 s). */
  readonly referenceAudioTargetSeconds: number;
  /** Native sample rate (Hz). */
  readonly sampleRate: number;
  /** Watermark provider every output carries. */
  readonly watermark: string;
  /**
   * How the immutable model revision is obtained. Upstream multilingual loads
   * `revision="main"`, a floating branch, so the ONLY honest source of a
   * revision is the resolved commit recorded by provisioning.
   */
  readonly revisionPolicy: 'resolved_at_provisioning';
  /**
   * Checkpoint variant this contract promises. Multilingual v3 must be loaded
   * explicitly; upstream's default is v2. Turbo has no T3 variant selector.
   */
  readonly modelVariant: 'v3' | null;
}

/** English-only, 350M, lowest compute; CFG/exaggeration are ignored upstream. */
export const CHATTERBOX_TURBO_CONTRACT: ChatterboxEngineContract = Object.freeze({
  id: 'chatterbox-turbo',
  label: 'Chatterbox Turbo (English)',
  modelId: 'ResembleAI/chatterbox-turbo',
  pythonClass: 'chatterbox.tts_turbo.ChatterboxTurboTTS',
  parameterCount: '350M',
  languages: Object.freeze(['en']),
  supportsVoiceSettings: false,
  defaultVoiceSettings: Object.freeze({ exaggeration: 0, cfgWeight: 0 }),
  referenceAudioTargetSeconds: 10,
  sampleRate: CHATTERBOX_SAMPLE_RATE,
  watermark: CHATTERBOX_WATERMARK_PROVIDER,
  revisionPolicy: 'resolved_at_provisioning',
  modelVariant: null,
});

/** 23 languages, 500M, zero-shot cloning with the upstream floating revision. */
export const CHATTERBOX_MULTILINGUAL_CONTRACT: ChatterboxEngineContract = Object.freeze({
  id: 'chatterbox-multilingual-v3',
  label: 'Chatterbox Multilingual v3',
  modelId: 'ResembleAI/chatterbox',
  pythonClass: 'chatterbox.mtl_tts.ChatterboxMultilingualTTS',
  parameterCount: '500M',
  languages: CHATTERBOX_MULTILINGUAL_LANGUAGE_IDS,
  supportsVoiceSettings: true,
  defaultVoiceSettings: Object.freeze({ exaggeration: 0.5, cfgWeight: 0.5 }),
  referenceAudioTargetSeconds: 10,
  sampleRate: CHATTERBOX_SAMPLE_RATE,
  watermark: CHATTERBOX_WATERMARK_PROVIDER,
  revisionPolicy: 'resolved_at_provisioning',
  modelVariant: 'v3',
});

/** The supported engine contracts, keyed by contract id (frozen). */
export const CHATTERBOX_ENGINE_CONTRACTS: Readonly<
  Record<ChatterboxEngineContractId, ChatterboxEngineContract>
> = Object.freeze({
  'chatterbox-turbo': CHATTERBOX_TURBO_CONTRACT,
  'chatterbox-multilingual-v3': CHATTERBOX_MULTILINGUAL_CONTRACT,
});

/** Type guard for a supported engine contract id. */
export function isChatterboxEngineContractId(value: unknown): value is ChatterboxEngineContractId {
  return value === 'chatterbox-turbo' || value === 'chatterbox-multilingual-v3';
}

/** Deterministic contract lookup; `null` when the id is not supported. */
export function getChatterboxEngineContract(id: unknown): ChatterboxEngineContract | null {
  return isChatterboxEngineContractId(id) ? CHATTERBOX_ENGINE_CONTRACTS[id] : null;
}

/* ------------------------------------------------------------------ */
/*  Language mapping                                                   */
/* ------------------------------------------------------------------ */

/** Explicit aliases where the primary BCP-47 subtag is not the model's id. */
const CHATTERBOX_LANGUAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  nb: 'no', // Norwegian Bokmal -> no
  nn: 'no', // Norwegian Nynorsk -> no
  cmn: 'zh', // Mandarin -> zh
  yue: 'zh', // Cantonese -> zh
  iw: 'he', // legacy Hebrew code -> he
  in: 'id',
});

/**
 * Map an arbitrary BCP-47-ish language tag (`en-GB`, `pt_BR`, `zh-Hans`) to a
 * Chatterbox language id, or `null` when the model cannot speak it.
 * Deterministic, case-insensitive, no locale database involved.
 */
export function mapLanguageTagToChatterboxLanguage(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const normalized = tag.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return null;
  const primary = normalized.split('-')[0];
  const alias = CHATTERBOX_LANGUAGE_ALIASES[primary] ?? primary;
  return CHATTERBOX_MULTILINGUAL_LANGUAGE_IDS.includes(alias) ? alias : null;
}

/**
 * Map a tag to the id supported by a SPECIFIC contract (turbo: English only),
 * or `null` when that contract cannot speak it.
 */
export function mapLanguageTagForContract(
  contractId: ChatterboxEngineContractId,
  tag: unknown
): string | null {
  const contract = CHATTERBOX_ENGINE_CONTRACTS[contractId];
  const languageId = mapLanguageTagToChatterboxLanguage(tag);
  if (!languageId) return null;
  return contract.languages.includes(languageId) ? languageId : null;
}

/* ------------------------------------------------------------------ */
/*  Voice settings                                                     */
/* ------------------------------------------------------------------ */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Deterministically resolve the DECLARED voice settings for a contract:
 * verified upstream defaults plus explicitly provided overrides. Values are
 * NOT clamped or corrected here — invalid values are rejected by the adapter's
 * validation so a bad setting fails closed instead of silently becoming a
 * different voice.
 */
export function chatterboxVoiceSettingsOrDefaults(
  contractId: ChatterboxEngineContractId,
  overrides: Partial<ChatterboxVoiceSettings> = {}
): ChatterboxVoiceSettings {
  const contract = CHATTERBOX_ENGINE_CONTRACTS[contractId];
  const exaggeration = isFiniteNumber(overrides.exaggeration)
    ? overrides.exaggeration
    : contract.defaultVoiceSettings.exaggeration;
  const cfgWeight = isFiniteNumber(overrides.cfgWeight)
    ? overrides.cfgWeight
    : contract.defaultVoiceSettings.cfgWeight;
  const settings: ChatterboxVoiceSettings = { exaggeration, cfgWeight };
  if (isFiniteNumber(overrides.minP)) settings.minP = overrides.minP;
  return settings;
}

/**
 * Validate declared settings against what the contract can actually honour.
 * Returns a list of human-readable problems (empty when the settings are
 * acceptable). Turbo reports unsupported parameters as a REFUSAL rather than
 * pretending to apply them.
 */
export function validateChatterboxVoiceSettings(
  contractId: ChatterboxEngineContractId,
  settings: Partial<ChatterboxVoiceSettings>
): string[] {
  const problems: string[] = [];
  const contract = CHATTERBOX_ENGINE_CONTRACTS[contractId];

  const checkRange = (name: string, value: unknown, min: number, max: number): void => {
    if (value === undefined) return;
    if (!isFiniteNumber(value)) {
      problems.push(`${name} must be a finite number.`);
      return;
    }
    if (value < min || value > max) {
      problems.push(`${name} must be within [${min}, ${max}] (got ${value}).`);
    }
  };

  checkRange('exaggeration', settings.exaggeration, 0, 1);
  checkRange('cfgWeight', settings.cfgWeight, 0, 2);
  checkRange('minP', settings.minP, 0, 1);

  if (!contract.supportsVoiceSettings) {
    const declared = Object.entries(settings).filter(([, value]) => value !== undefined);
    if (declared.length > 0) {
      problems.push(
        `${contract.label} does not support voice settings (${declared
          .map(([key]) => key)
          .join(', ')}); upstream ignores them. Use the multilingual contract for parameter control.`
      );
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/*  Provisioning marker contract                                       */
/* ------------------------------------------------------------------ */

/**
 * What `tools/provision-chatterbox.mjs` writes — and ONLY after the isolated env
 * and the real model revision have been verified. The adapter refuses to spawn
 * the worker without it, so no synthesis can ever happen against an unproven or
 * silently downloaded model.
 */
export interface ChatterboxProvisionMarker {
  schemaVersion: number;
  /** `chatterbox-tts` version installed into the isolated env. */
  packageVersion: string;
  engineContractId: ChatterboxEngineContractId;
  modelId: string;
  /** RESOLVED model revision (commit sha / tag) — never fabricated. */
  modelRevision: string;
  /**
   * Checkpoint variant this marker verified. `v3` for multilingual. Absent on
   * markers written before the post-VS7 correction; those are not proof of v3.
   */
  modelVariant?: string | null;
  /** Interpreter used at provisioning time (repo-relative when inside the repo). */
  pythonPath: string;
  /** Repo-relative model/cache directory. */
  modelDir: string;
  provisionedAt: string;
  /** Watermark provider verified present in the provisioned env. */
  watermark: string;
  notes?: string;
}

/** Parse + validate a provisioning marker without trusting its contents. */
export function parseChatterboxProvisionMarker(value: unknown): {
  marker: ChatterboxProvisionMarker | null;
  problems: string[];
} {
  const problems: string[] = [];
  if (!value || typeof value !== 'object') {
    return { marker: null, problems: ['marker must be a JSON object'] };
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== CHATTERBOX_MARKER_SCHEMA_VERSION) {
    problems.push(`unsupported marker schemaVersion: ${String(raw.schemaVersion)}`);
  }
  const requireString = (key: keyof ChatterboxProvisionMarker): string | null => {
    const field = raw[key as string];
    if (typeof field !== 'string' || !field.trim()) {
      problems.push(`missing/empty marker field: ${String(key)}`);
      return null;
    }
    return field.trim();
  };
  const packageVersion = requireString('packageVersion');
  const contractId = raw.engineContractId;
  if (!isChatterboxEngineContractId(contractId)) {
    problems.push(`unsupported marker engineContractId: ${String(contractId)}`);
  }
  const modelId = requireString('modelId');
  const modelRevision = requireString('modelRevision');
  const pythonPath = requireString('pythonPath');
  const modelDir = requireString('modelDir');
  const provisionedAt = requireString('provisionedAt');
  const watermark = requireString('watermark');

  if (problems.length > 0) return { marker: null, problems };

  return {
    marker: {
      schemaVersion: CHATTERBOX_MARKER_SCHEMA_VERSION,
      packageVersion: packageVersion as string,
      engineContractId: contractId as ChatterboxEngineContractId,
      modelId: modelId as string,
      modelRevision: modelRevision as string,
      ...(typeof raw.modelVariant === 'string' && raw.modelVariant.trim()
        ? { modelVariant: raw.modelVariant.trim() }
        : {}),
      pythonPath: pythonPath as string,
      modelDir: modelDir as string,
      provisionedAt: provisionedAt as string,
      watermark: watermark as string,
      ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
    },
    problems: [],
  };
}

/** Shape of a declared Chatterbox acoustic identity, for readability. */
export type ChatterboxAcousticIdentity = Pick<
  VoiceAcousticIdentity,
  'engine' | 'modelId' | 'modelRevision' | 'referenceSha256' | 'sourceKind' | 'acousticSourceId'
>;
