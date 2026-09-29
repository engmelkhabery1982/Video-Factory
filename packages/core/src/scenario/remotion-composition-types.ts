/**
 * BuildTrack Video Factory - Phase 5C Remotion Composition Contract
 *
 * Stable renderer-facing contract that maps approved SceneRenderPlan to
 * Remotion composition props / render tree.
 *
 * Timing authority: Phase 4 actual reconciled timing via Phase 5A/5B.
 * No re-estimation, no retiming.
 */

import {
  SceneRendererKey,
  RendererCategory,
  SceneRenderBeat,
  SceneVisualTreatment,
  SceneRenderFinding as SceneRenderFindingBase,
} from './scene-render-types.js';
import {
  VisualProductionAssetRef,
  VisualProductionAudioRef,
} from './visual-production-types.js';
import { ReconciledCaptionCue } from './timing-reconciliation-types.js';
import {
  ScenarioTargetFormat,
  SceneNarrativePurpose,
  ProductionDirection,
  OnScreenInformation,
  TransitionType,
} from './types.js';

export const REMOTION_COMPOSITION_VERSION = '1.0.0' as const;

/** FPS - matches packages/video/src/brand/theme.ts FPS = 30 */
export const REMOTION_FPS = 30 as const;

/** Layout dimensions - matches packages/video/src/brand/theme.ts LAYOUT */
export const REMOTION_LAYOUT = {
  long: { width: 1920, height: 1080 },
  short: { width: 1080, height: 1920 },
  reusable: { width: 1920, height: 1080 },
} as const;

export type RemotionLayout = typeof REMOTION_LAYOUT;
export type RemotionFormat = keyof RemotionLayout;

/** Known renderer keys - same as Phase 5B */
export const KNOWN_RENDERER_KEYS: Set<string> = new Set([
  'hook:question',
  'hook:surprising_number',
  'hook:before_after',
  'hook:common_mistake',
  'hook:risk_warning',
  'hook:scenario_story',
  'hook:document_zoom',
  'hook:product_result',
  'hook:generic',
  'explanation:animated_checklist',
  'explanation:number_comparison',
  'explanation:progressive_table',
  'explanation:timeline',
  'explanation:process_flow',
  'explanation:document_annotation',
  'explanation:site_footage_callouts',
  'explanation:split_screen',
  'explanation:dashboard_demo',
  'explanation:chart_animation',
  'explanation:myth_vs_reality',
  'explanation:key_statement',
  'explanation:problem_cause_solution',
  'explanation:generic',
  'cta:cta_card',
  'cta:generic',
  'background:generic',
  'generic:generic',
]);

/** Known transition keys - supports both Phase 3B TransitionType and video package TransitionVariantId */
export const KNOWN_TRANSITION_KEYS: Set<string> = new Set([
  // Phase 3B / Scenario
  'cut',
  'dissolve',
  'fade_black',
  'wipe',
  'none',
  // Video package variants
  'direct_cut',
  'push',
  'zoom',
  'mask_reveal',
  'data_wipe',
  'document_page',
  'match_cut',
]);

export interface RemotionBeatCompositionSpec {
  /** Original beat from Phase 5B */
  id: string;
  sceneId: string;
  index: number;
  kind: 'dialogue' | 'visual_only' | 'transition';
  /** Global timing - authoritative from Phase 5A/5B */
  actualStartSeconds: number;
  actualEndSeconds: number;
  actualDurationSeconds: number;
  /** Relative position within scene (0..1) */
  relativeStart: number;
  relativeEnd: number;
  /** Frame ranges - derived from absolute actual timing */
  startFrame: number;
  endFrame: number;
  durationInFrames: number;
  /** Local timing within scene */
  localStartSeconds: number;
  localEndSeconds: number;
  localDurationSeconds: number;
  localStartFrame: number;
  localEndFrame: number;
  localDurationInFrames: number;
  /** Dialogue associations */
  turnId: string | null;
  activeSpeakerId: string | null;
  reactingCharacterId: string | null;
  spokenText: string | null;
  intent: string | null;
  delivery: string | null;
  shot: SceneRenderBeat['shot'];
  evidenceIds: string[];
  cues: SceneRenderBeat['cues'];
  audioRef: VisualProductionAudioRef | null;
  captionCueIds: string[];
}

export interface RemotionAudioCompositionSpec extends VisualProductionAudioRef {
  startFrame: number;
  endFrame: number;
  durationInFrames: number;
  localStartFrame: number;
  localEndFrame: number;
  localStartSeconds: number;
  localEndSeconds: number;
}

export interface RemotionCaptionCompositionSpec extends ReconciledCaptionCue {
  startFrame: number;
  endFrame: number;
  durationInFrames: number;
  localStartFrame: number;
  localEndFrame: number;
  localStartSeconds: number;
  localEndSeconds: number;
}

export interface RemotionAssetCompositionSpec extends VisualProductionAssetRef {
  /** Order preserved from SceneRenderSpec */
  order: number;
}

export interface RemotionTransitionCompositionSpec {
  type: TransitionType | string;
  rendererKey: string;
  durationSeconds: number;
  source: 'scene.transitionIntent' | 'production.transitionIntent' | 'default';
  actualStartSeconds: number | null;
  actualEndSeconds: number | null;
  actualDurationSeconds: number | null;
  /** Frame ranges if actual interval present */
  startFrame: number | null;
  endFrame: number | null;
  durationInFrames: number | null;
  localStartFrame: number | null;
  localEndFrame: number | null;
  /** Outgoing/incoming relationship */
  outgoingSceneId: string | null;
  incomingSceneId: string;
}

export interface RemotionSceneCompositionSpec {
  scenarioId: string;
  projectId: string;
  sceneId: string;
  sourceSceneId: string;
  sceneIndex: number;
  renderOrder: number;
  title: string | null;
  narrativePurpose: SceneNarrativePurpose;
  rendererKey: SceneRendererKey;
  rendererCategory: RendererCategory;
  fallbackUsed: boolean;
  fallbackFrom?: string;
  /** Actual timing authoritative */
  actualStartSeconds: number;
  actualEndSeconds: number;
  actualDurationSeconds: number;
  estimatedStartSeconds: number;
  estimatedEndSeconds: number;
  estimatedDurationSeconds: number;
  /** Frame ranges - derived from absolute actual timing to avoid drift */
  startFrame: number;
  endFrame: number;
  durationInFrames: number;
  visualTreatment: SceneVisualTreatment;
  production: ProductionDirection;
  onScreenInfo: OnScreenInformation | null;
  locationId: string;
  participantIds: string[];
  turnIds: string[];
  speakerIds: string[];
  visualOnly: boolean;
  beats: RemotionBeatCompositionSpec[];
  assetRefs: RemotionAssetCompositionSpec[];
  audioRefs: RemotionAudioCompositionSpec[];
  captionCues: RemotionCaptionCompositionSpec[];
  transition: RemotionTransitionCompositionSpec;
  targetFormat: ScenarioTargetFormat;
  formatInfo?: {
    orientation: 'landscape' | 'portrait' | 'format_neutral';
    aspectRatio: '16:9' | '9:16' | 'any';
  };
  width: number;
  height: number;
}

export interface RemotionCompositionSummary {
  scenarioId: string;
  projectId: string;
  language: string;
  targetFormat: ScenarioTargetFormat;
  fps: number;
  width: number;
  height: number;
  sceneCount: number;
  rendererKeysUsed: SceneRendererKey[];
  rendererCategoriesUsed: RendererCategory[];
  beatCount: number;
  audioRefCount: number;
  captionCueCount: number;
  assetRefCount: number;
  transitionCount: number;
  fallbackCount: number;
  totalActualDurationSeconds: number;
  totalDurationInFrames: number;
  warningCount: number;
  status: 'ok' | 'warning' | 'error';
}

export interface RemotionCompositionFinding {
  severity: 'error' | 'warning';
  code: RemotionCompositionErrorCode;
  message: string;
  location?: {
    scenarioId?: string;
    sceneId?: string;
    beatId?: string;
    cueId?: string;
    turnId?: string;
    clipId?: string;
    assetRef?: string;
    rendererKey?: string;
    transitionKey?: string;
  };
}

export interface RemotionCompositionPlan {
  planVersion: typeof REMOTION_COMPOSITION_VERSION;
  scenarioId: string;
  projectId: string;
  language: string;
  targetFormat: ScenarioTargetFormat;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  totalActualDurationSeconds: number;
  totalEstimatedDurationSeconds: number;
  totalDeltaSeconds: number;
  scenes: RemotionSceneCompositionSpec[];
  summary: RemotionCompositionSummary;
  findings: RemotionCompositionFinding[];
  valid: boolean;
}

export type BuildRemotionCompositionResult =
  | { success: true; plan: RemotionCompositionPlan }
  | { success: false; error: string; findings: RemotionCompositionFinding[]; partialPlan?: RemotionCompositionPlan };

export type RemotionCompositionErrorCode =
  | 'UNKNOWN_RENDERER_KEY'
  | 'INVALID_FRAME_RANGE'
  | 'COMPOSITION_DURATION_MISMATCH'
  | 'REMOTION_SCENE_BINDING_FAILED'
  | 'AUDIO_TIMELINE_BINDING_FAILED'
  | 'CAPTION_TIMELINE_BINDING_FAILED'
  | 'TRANSITION_TIMELINE_BINDING_FAILED'
  | 'MISSING_PHASE_OUTPUT'
  | 'PIPELINE_IDENTITY_MISMATCH'
  | 'DUPLICATE_SCENE_ID'
  | 'DUPLICATE_RENDER_ORDER'
  | 'INVALID_DURATION'
  | 'OVERLAP_DETECTED'
  | 'RENDERER_MAPPING_MISSING'
  | 'RENDERER_MAPPING_INVALID'
  | 'UNSUPPORTED_SCENE_TYPE'
  | 'ASSET_BINDING_MISMATCH'
  | 'AUDIO_BINDING_MISMATCH'
  | 'CAPTION_BINDING_MISMATCH'
  | 'TRANSITION_BINDING_INVALID'
  | 'SCENE_RENDER_INVARIANT_FAILED'
  | 'FINAL_CONTENT_TRUNCATION';

export class RemotionCompositionError extends Error {
  public readonly code: RemotionCompositionErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly findings?: RemotionCompositionFinding[];

  constructor(code: RemotionCompositionErrorCode, message: string, details?: Record<string, unknown>, findings?: RemotionCompositionFinding[]) {
    super(message);
    this.name = 'RemotionCompositionError';
    this.code = code;
    this.details = details;
    this.findings = findings;
  }
}

/**
 * VideoCompositionProps - stable renderer-facing contract for Phase 5D
 * Alias for RemotionCompositionPlan with additional optional theme/style config
 */
export type VideoCompositionProps = RemotionCompositionPlan & {
  /** Optional brand/theme config required by renderer */
  brand?: unknown;
  captionStyle?: string;
  ctaAnimation?: string;
  ctaText?: string;
  productName?: string;
  logoSrc?: string | null;
  mediaMap?: Record<string, string>;
};
