/**
 * Milestone 2 content-led factory contract (FACTORY_CONTRACT_V1).
 *
 * Pure types and constants only. Persistence and HTTP live in apps/api. The
 * drafts here are PLANS: they reorder, group and assign reviewed narration to
 * scenes. They never rewrite supplied words, invent scripture or facts, or
 * claim acoustic timing that no engine produced.
 */
import type { ConditioningSetting, VisualReviewRecord } from './visual-review.js';
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
export type FactoryMissingKind =
  | 'script' | 'transcription' | 'speech' | 'image' | 'recording' | 'speaker' | 'timing' | 'asset' | 'review'
  /** Two text sources disagree and no authority is chosen yet. Nothing is applied until the owner chooses. */
  | 'conflict'
  /** No material at all (no text, no pictures, no video). Nothing is guessed. */
  | 'material'
  /** Supplied-narration mode without supplied audio. */
  | 'audio';

/**
 * Narration mode. `supplied`: the approved audio is the narration. `generate`: speech is created per scene on
 * confirmation (existing behaviour). `none`: a silent video with no narration track, no speaker and no TTS.
 */
export const FACTORY_NARRATION_MODES = ['supplied', 'generate', 'none'] as const;
export type FactoryNarrationMode = (typeof FACTORY_NARRATION_MODES)[number];

/** Role of a supplied picture or clip. Only `final_shot` and `storyboard_panel` appear as shots; references never do. */
export const FACTORY_VISUAL_ROLES = ['final_shot', 'storyboard_panel', 'style_reference', 'character_reference'] as const;
export type FactoryVisualRole = (typeof FACTORY_VISUAL_ROLES)[number];

/** Which text is the authority when sources differ. The owner chooses; nothing is picked silently. */
export const FACTORY_TEXT_AUTHORITIES = ['script', 'storyboard', 'transcript'] as const;
export type FactoryTextAuthority = (typeof FACTORY_TEXT_AUTHORITIES)[number];

/**
 * Explicit handling of the audio stream embedded in supplied video clips.
 *  - original: the clip's own audio is the sound; no TTS and no separate narration asset.
 *  - replace: every clip is muted and the chosen narration (generated or supplied audio) is the sound.
 *  - add: clip audio is kept and the chosen narration is mixed over it.
 *  - silent: every clip is muted and there is no narration track at all.
 * Absent/null keeps the legacy behaviour (clips muted, today's narration rules unchanged).
 */
export const FACTORY_VIDEO_AUDIO_POLICIES = ['original', 'replace', 'add', 'silent'] as const;
export type FactoryVideoAudioPolicy = (typeof FACTORY_VIDEO_AUDIO_POLICIES)[number];

export interface FactoryMissingItem {
  kind: FactoryMissingKind;
  sceneId: string | null;
  reason: string;
}

export interface FactoryStoryboardSceneInput {
  id: string;
  /** Empty for a picture panel with no narration. */
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
export type FactoryTimingSource = 'unknown' | 'supplied' | 'measured_synthesis' | 'estimated_text_length' | 'visual_duration_proposal';

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
  /** Timing of a procedural graphic's default actions. Absent for media shots. Never retimes narration. */
  pacing?: GraphicPacing;
}

import type { EditorGraphic } from '../editor/graphics.js';
import type { GraphicPacing } from '../editor/graphic-builders.js';
import type { VisualLanguageId, VisualTechniqueId } from '../visual-language.js';

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
  shot?: { type: string; why: string; assetNeed: string; visualRequirement: string; /** Set on the educational product-mention scene: the owner-supplied fact it uses. */ productFactId?: string };
  /** Per-shot technique from the visual-language registry. Absent or null: the scene renders as before. */
  technique?: VisualTechniqueId | null;
  /** Procedural graphic with supplied values. Present only for a graphic technique. Validated in editor/graphics.ts. */
  graphic?: EditorGraphic | null;
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

/** Kinds of review-queue item. Missing kinds are required; the rest are optional suggestions. */
export type FactoryCompletionKind =
  | FactoryMissingKind
  | 'library_picture'
  | 'captions'
  | 'background_music'
  | 'optional_narration';

export interface FactoryCompletionItem {
  /** Stable id, so the UI and tests can refer to one item. */
  id: string;
  kind: FactoryCompletionKind;
  /** Required items block Apply. Optional items are suggestions the owner may ignore. */
  required: boolean;
  sceneId: string | null;
  label: string;
  action: string;
}

/**
 * The exact local semantic-planner gate, copied from the local planner status so a blocked
 * brief-only draft names the precise owner action (environment variables and licence) without
 * a second request and without any cloud fallback. Google is never used for planning.
 */
export interface FactoryPlannerGate {
  ready: boolean;
  route: 'local_llm';
  reason: string;
  /** Every missing owner setting, verbatim. Empty when ready. */
  missing: string[];
  model: string | null;
  license: string | null;
  endpoint: 'loopback only';
  googleUsed: false;
  pinnedModel: string;
  licenceMatchesPin: boolean | null;
}

/** The resolved intake: what each optional input is and which authority wins. Facts only. */
export interface FactoryIntakeSummary {
  /** Explicit choice for audio embedded in video clips. Null when the draft has no policy (legacy). */
  videoAudioPolicy: FactoryVideoAudioPolicy | null;
  /** Resolved narration mode (legacy requests resolve to supplied or generate). */
  narrationMode: FactoryNarrationMode;
  /** What the owner asked for. Null when the request did not say (legacy). */
  requestedNarrationMode: FactoryNarrationMode | null;
  /** The stored storyboard (canonical). Null for drafts without one. Edits go through PATCH …/intake. */
  storyboard: FactoryStoryboardV1 | null;
  textAuthority: FactoryTextAuthority | null;
  captions: boolean;
  visualRoles: Record<string, FactoryVisualRole>;
  visualNotes: Record<string, string>;
  /** Reviewed descriptions of pictures from local picture analysis. Manual notes stay in visualNotes. */
  visualReview?: Record<string, VisualReviewRecord>;
  /** The picture that conditions local still generation (IP-Adapter), and its strength. */
  conditioning?: ConditioningSetting | null;
  /** The transcript attached as audio text. Reviewed text is used; a stale transcript never is. */
  transcript: { jobId: string; status: string; reviewed: boolean; stale: boolean } | null;
}

export interface FactoryTextConflictSummary {
  sources: Array<{ source: FactoryTextAuthority; label: string; units: string[] }>;
  authority: FactoryTextAuthority | null;
}

export interface FactoryDraftEnvelope {
  draftId: string;
  revision: number;
  status: FactoryDraftStatus;
  /** Optional-input contract. Additive: absent on responses that predate it. */
  intake?: FactoryIntakeSummary;
  /**
   * Precise local semantic-planner gate for a topic/brief that has no script yet. Additive:
   * present on new envelopes, null where semantic planning is not the next step. Never a cloud route.
   */
  plannerGate?: FactoryPlannerGate | null;
  textConflict?: FactoryTextConflictSummary | null;
  /** Required gaps first, then optional suggestions. Additive. */
  completion?: FactoryCompletionItem[];
  generationMode: FactoryGenerationMode;
  /** Set on a derived rewrite. Null on drafts that are not derivatives. */
  derivedFrom?: FactoryDerivation | null;
  /** The derivative is reviewed at this revision. Null until a reviewer confirms it. */
  reviewedRevision?: number | null;
  /** True when scene order cannot change: supplied full audio or supplied scene times. */
  speechOrderLocked: boolean;
  selectedTreatmentId: string | null;
  /** Draft-level visual language. Null for drafts that have not chosen one (legacy behaviour). */
  visualLanguage?: VisualLanguageId | null;
  /** Per-shot readiness for the selected technique, computed from real bindings and runtime facts. */
  visualReadiness?: Array<{ sceneId: string; technique: VisualTechniqueId | null; state: string; reason: string }>;
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
  'FACTORY_SUPPLIED_ORDER_CHANGED',
  'FACTORY_TIMED_STRUCTURE',
  'FACTORY_STORYBOARD_EMPTY',
  'FACTORY_TIMING_CONFIRMATION_REQUIRED',
  'FACTORY_TEXT_CONFLICT',
  'FACTORY_APPROVED_TEXT_IMMUTABLE',
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
  'FACTORY_CANDIDATE_STALE',
  'FACTORY_TRANSCRIPTION_NOT_FOUND',
  'FACTORY_TRANSCRIPTION_NOT_RUNNING',
  'FACTORY_TRANSCRIPTION_NOT_READY',
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
