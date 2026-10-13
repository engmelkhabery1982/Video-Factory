/**
 * Milestone 2 content-led factory contract (FACTORY_CONTRACT_V1).
 *
 * Pure types and constants only. Persistence and HTTP live in apps/api. The
 * drafts here are PLANS: they reorder, group and assign reviewed narration to
 * scenes. They never rewrite supplied words, invent scripture or facts, or
 * claim acoustic timing that no engine produced.
 */
import type { EditorContentProfile, EditorFormat } from '../editor/document.js';

export const FACTORY_CONTRACT_VERSION = 1 as const;
export const FACTORY_STORYBOARD_VERSION = 1 as const;

export const FACTORY_CONTENT_PROFILES: readonly EditorContentProfile[] = ['religious', 'educational', 'promotional'];
export const FACTORY_FORMATS: readonly EditorFormat[] = ['landscape', 'portrait'];

export type FactoryContentProfile = EditorContentProfile;
export type FactoryFormat = EditorFormat;

/** `local_rules` is deterministic, rule-based planning. It is NOT semantic AI. */
export type FactoryTextMode = 'configured_provider' | 'local_rules' | 'unavailable';
export type FactoryDraftStatus = 'review_required' | 'blocked';
export type FactoryGenerationMode = 'local_rules';
export type FactoryLanguage = 'ar' | 'en' | 'und';

/**
 * Missing-item kinds. `script` = no reviewed text; `transcription` = audio text
 * unknown and no engine; `speech` = no runnable voice for a language;
 * `image` = no supplied or library visual; `speaker` = speaker has no voice;
 * `timing` = supplied timing is not a contiguous timeline; `asset` = invalid.
 */
export type FactoryMissingKind = 'script' | 'transcription' | 'speech' | 'image' | 'speaker' | 'timing' | 'asset';

export interface FactoryMissingItem {
  kind: FactoryMissingKind;
  sceneId: string | null;
  reason: string;
}

export interface FactoryStoryboardSceneInput {
  id: string;
  narration: string;
  speakerId: string | null;
  assetId: string | null;
  startSec: number | null;
  endSec: number | null;
  locked: boolean;
}

export interface FactoryStoryboardV1 {
  version: 1;
  scenes: FactoryStoryboardSceneInput[];
}

export type FactoryAssetOrigin = 'supplied' | 'library' | 'reviewer' | null;
export type FactoryTimingSource = 'unknown' | 'supplied' | 'measured_synthesis' | 'estimated_text_length';

export interface FactoryDraftScene {
  id: string;
  narration: string;
  speakerId: string | null;
  visualIntent: string;
  assetId: string | null;
  startSec: number | null;
  endSec: number | null;
  locked: boolean;
  /** Server-owned from here on. Clients may echo these but cannot change them. */
  sourceUnitId: string;
  beat: string;
  language: FactoryLanguage;
  assetOrigin: FactoryAssetOrigin;
  timingSource: FactoryTimingSource;
}

export interface FactoryTreatment {
  id: string;
  title: string;
  rationale: string;
  /** Ordered beat names, one per scene in `scenes`. */
  structure: string[];
  scenes: FactoryDraftScene[];
}

export interface FactorySpeaker {
  id: string;
  voiceId: string | null;
  available: boolean;
}

export interface FactoryDraftEnvelope {
  draftId: string;
  revision: number;
  status: FactoryDraftStatus;
  generationMode: FactoryGenerationMode;
  selectedTreatmentId: string | null;
  treatments: FactoryTreatment[];
  speakers: FactorySpeaker[];
  missing: FactoryMissingItem[];
  warnings: string[];
}

/** Stable error codes. Messages never contain stacks or filesystem paths. */
export const FACTORY_ERROR_CODES = [
  'FACTORY_VALIDATION',
  'FACTORY_STORYBOARD_VERSION_UNSUPPORTED',
  'FACTORY_ASSET_INVALID',
  'FACTORY_IDENTITY_REFUSED',
  'FACTORY_DRAFT_NOT_FOUND',
  'FACTORY_REVISION_CONFLICT',
  'FACTORY_DRAFT_BUSY',
  'FACTORY_SCENE_LOCKED',
  'FACTORY_INPUTS_REQUIRED',
  'FACTORY_REFERENCE_NOT_FOUND',
  'FACTORY_FORMAT_UNSUPPORTED',
  'FACTORY_SPEECH_FAILED',
] as const;
export type FactoryErrorCode = (typeof FACTORY_ERROR_CODES)[number];

/** Error type the API maps to `{code, error}` with an HTTP status. */
export class FactoryError extends Error {
  readonly code: FactoryErrorCode;
  readonly status: number;
  readonly missing?: FactoryMissingItem[];
  readonly currentRevision?: number;
  constructor(
    code: FactoryErrorCode,
    message: string,
    status: number,
    extra: { missing?: FactoryMissingItem[]; currentRevision?: number } = {},
  ) {
    super(message);
    this.name = 'FactoryError';
    this.code = code;
    this.status = status;
    this.missing = extra.missing;
    this.currentRevision = extra.currentRevision;
  }
}
