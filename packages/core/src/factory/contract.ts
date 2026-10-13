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
/** local_rules: the offline M2 rules. gemini_plan: a reviewed Gemini plan (labelled, never a hidden fallback). */
export type FactoryGenerationMode = 'local_rules' | 'gemini_plan';
export type FactoryLanguage = 'ar' | 'en' | 'und';

/**
 * Missing-item kinds. `script` = no reviewed text; `transcription` = audio text
 * unknown and no engine; `speech` = no runnable voice for a language;
 * `image` = no supplied or library visual; `speaker` = speaker has no voice;
 * `timing` = supplied timing is not a contiguous timeline; `asset` = invalid.
 */
export type FactoryMissingKind = 'script' | 'transcription' | 'speech' | 'image' | 'speaker' | 'timing' | 'asset' | 'review';

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

/**
 * What the treatment asks the picture to do. Only features the renderer executes
 * are applied to the editor document (crop framing, still motion). Anything else
 * is listed in `unexecuted` and reported as missing capability, never as applied.
 */
export type FactoryFraming = 'full' | 'tight';
export interface FactoryVisualDecision {
  framing: FactoryFraming;
  motion: 'none' | 'slow_push' | 'pan_left' | 'pan_right';
  /** Requested features with no renderer support for this asset, or not applicable to it. */
  unexecuted: string[];
}

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
  /** Server-owned visual decisions. Applied to the editor crop and motion on apply. */
  visualDecision: FactoryVisualDecision;
  /** Generated-plan shot record: what shot this is and why it serves the line. Absent for local-rule scenes. */
  shot?: { type: string; why: string; assetNeed: string; visualRequirement: string };
}

export interface FactoryTreatment {
  id: string;
  title: string;
  rationale: string;
  /** True when the supplied narration order is fixed (supplied audio or supplied times). */
  orderLocked: boolean;
  /** Ordered beat names, one per scene in `scenes`. */
  structure: string[];
  scenes: FactoryDraftScene[];
}

export interface FactorySpeaker {
  id: string;
  voiceId: string | null;
  available: boolean;
  /** Speech provider for this speaker. Absent means the local sam-js path (M2 behaviour). */
  provider?: 'sam' | 'gemini';
  /** Delivery style for this speaker. Kept separate from narration text. */
  style?: string;
}

/** Provenance of a derived rewrite. The source draft is never changed by it. */
export interface FactoryDerivation {
  /** The draft the rewrite was made from, and the revision it was made from. */
  draftId: string;
  revision: number;
  /** The original draft at the root of the chain. */
  rootDraftId: string;
  /** Per changed narration unit: the text before and after the rewrite. */
  changes: Array<{ unitId: string; before: string; after: string }>;
}

export interface FactoryDraftEnvelope {
  draftId: string;
  revision: number;
  status: FactoryDraftStatus;
  generationMode: FactoryGenerationMode;
  /** Set on a derived rewrite. Null on drafts that are not derivatives. */
  derivedFrom?: FactoryDerivation | null;
  /** The derivative is reviewed at this revision. Null until a reviewer confirms it. */
  reviewedRevision?: number | null;
  /** True when scene order cannot change: supplied full audio or supplied scene times. */
  speechOrderLocked: boolean;
  selectedTreatmentId: string | null;
  treatments: FactoryTreatment[];
  speakers: FactorySpeaker[];
  missing: FactoryMissingItem[];
  warnings: string[];
  /** Projects this draft has produced. Lets a client confirm an apply whose reply was lost. */
  appliedProjects: FactoryAppliedProject[];
  /** Predicted timing source and label for the next apply, before any measurement. Additive. */
  timingPlan?: { timingSource: FactoryTimingSource; label: string };
  /** What the draft was built from. Facts only; no engine output is implied by these. */
  profile: { contentProfile: FactoryContentProfile; format: FactoryFormat; channelBrandId: string | null };
  inputs: {
    audioAssetId: string | null;
    audioDurationSec: number | null;
    visualAssetIds: string[];
    scriptSupplied: boolean;
    storyboardSupplied: boolean;
  };
}

export interface FactoryAppliedProject {
  projectId: string;
  editorRevision: number;
  timingSource: string;
  appliedAt: string;
  /** Draft revision the project was applied from. Absent on records made before reuse tracking. */
  draftRevision?: number;
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
  'FACTORY_SOURCE_CHANGED',
  'FACTORY_PROJECT_NOT_FOUND',
  'FACTORY_PROVIDER_DISABLED',
  'FACTORY_PROVIDER_CREDENTIALS_MISSING',
  'FACTORY_PROVIDER_AUTH',
  'FACTORY_PROVIDER_QUOTA',
  'FACTORY_PROVIDER_TIMEOUT',
  'FACTORY_PROVIDER_UNAVAILABLE',
  'FACTORY_AI_INVALID_OUTPUT',
  'FACTORY_BUDGET_EXHAUSTED',
  'FACTORY_JOB_NOT_FOUND',
  'FACTORY_JOB_CANCELLED',
  'FACTORY_AUDIO_INVALID',
  'FACTORY_JOB_NOT_READY',
  'FACTORY_NOT_GENERATED',
  'FACTORY_SCRIPT_APPROVED',
  'FACTORY_NOT_DERIVED',
] as const;
export type FactoryErrorCode = (typeof FACTORY_ERROR_CODES)[number];

/** Error type the API maps to `{code, error}` with an HTTP status. */
export class FactoryError extends Error {
  readonly code: FactoryErrorCode;
  readonly status: number;
  readonly missing?: FactoryMissingItem[];
  readonly currentRevision?: number;
  /** Non-secret extra detail, for example the number of speech calls an apply would need. */
  readonly details?: Record<string, unknown>;
  constructor(
    code: FactoryErrorCode,
    message: string,
    status: number,
    extra: { missing?: FactoryMissingItem[]; currentRevision?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'FactoryError';
    this.code = code;
    this.status = status;
    this.missing = extra.missing;
    this.currentRevision = extra.currentRevision;
    this.details = extra.details;
  }
}
