/**
 * BuildTrack Video Factory - Phase 5B Scene Render Plan Contract
 *
 * Renderer-ready scene specification derived from Phase 5A VisualProductionPlan.
 * No rendering, no Remotion invocation — only deterministic mapping.
 *
 * Each production scene maps to one renderer spec with exact timing, assets, audio, captions, transitions.
 */

import { ScenarioTargetFormat, SceneNarrativePurpose, TransitionType, ShotType, FramingAlignment, SpeakerFocus, CameraMovement, TurnIntent, TurnDelivery } from './types.js';
import { ProductionDirection, OnScreenInformation } from './types.js';
import { VisualProductionAssetRef, VisualProductionAudioRef } from './visual-production-types.js';
import { ReconciledCaptionCue } from './timing-reconciliation-types.js';

export const SCENE_RENDER_PLAN_VERSION = '1.0.0' as const;

/** Renderer keys reused from existing packages/video scene components */
export type SceneRendererKey =
  | 'hook:question'
  | 'hook:surprising_number'
  | 'hook:before_after'
  | 'hook:common_mistake'
  | 'hook:risk_warning'
  | 'hook:scenario_story'
  | 'hook:document_zoom'
  | 'hook:product_result'
  | 'hook:generic'
  | 'explanation:animated_checklist'
  | 'explanation:number_comparison'
  | 'explanation:progressive_table'
  | 'explanation:timeline'
  | 'explanation:process_flow'
  | 'explanation:document_annotation'
  | 'explanation:site_footage_callouts'
  | 'explanation:split_screen'
  | 'explanation:dashboard_demo'
  | 'explanation:chart_animation'
  | 'explanation:myth_vs_reality'
  | 'explanation:key_statement'
  | 'explanation:problem_cause_solution'
  | 'explanation:generic'
  | 'cta:cta_card'
  | 'cta:generic'
  | 'background:generic'
  | 'generic:generic';

export type RendererCategory = 'hook' | 'explanation' | 'cta' | 'background' | 'generic';

/** Visual treatment / background reference */
export interface SceneVisualTreatment {
  background: string; // from ProductionDirection or visual plan, e.g., 'dark_grid', 'light_technical'
  accent?: string;
  screenInsert?: {
    title: string;
    assetRef?: string;
    description: string;
  };
  bRollIntent?: string;
  overlayIntent?: string;
  environmentalAction?: string;
}

/** Renderer-ready beat instruction — preserves Phase 5A beat timing */
export interface SceneRenderBeat {
  id: string;
  sceneId: string;
  index: number;
  kind: 'dialogue' | 'visual_only' | 'transition';
  actualStartSeconds: number;
  actualEndSeconds: number;
  actualDurationSeconds: number;
  relativeStart: number;
  relativeEnd: number;
  turnId: string | null;
  activeSpeakerId: string | null;
  reactingCharacterId: string | null;
  spokenText: string | null;
  intent: TurnIntent | null;
  delivery: TurnDelivery | null;
  shot: {
    shotType: ShotType;
    framing: FramingAlignment;
    speakerFocus: SpeakerFocus;
    cameraMovement: CameraMovement;
    focusCharacterId: string | null;
  };
  evidenceIds: string[];
  cues: {
    id: string;
    kind: string;
    text: string;
    actualStartSeconds: number;
    actualEndSeconds: number;
    actualDurationSeconds: number;
    assetRef?: string;
  }[];
  audioRef: VisualProductionAudioRef | null;
  captionCueIds: string[];
}

/** Per-scene renderer spec */
export interface SceneRenderSpec {
  scenarioId: string;
  projectId: string;
  sceneId: string;
  sourceSceneId: string;
  sceneIndex: number;
  renderOrder: number;
  title: string | null;
  narrativePurpose: SceneNarrativePurpose;
  /** Renderer key assigned deterministically */
  rendererKey: SceneRendererKey;
  rendererCategory: RendererCategory;
  /** Whether fallback was used */
  fallbackUsed: boolean;
  /** If fallback used, original requested type */
  fallbackFrom?: string;
  /** Actual timing — authoritative from Phase 5A */
  actualStartSeconds: number;
  actualEndSeconds: number;
  actualDurationSeconds: number;
  /** Estimated timing for reference */
  estimatedStartSeconds: number;
  estimatedEndSeconds: number;
  estimatedDurationSeconds: number;
  /** Visual treatment */
  visualTreatment: SceneVisualTreatment;
  /** Production direction preserved */
  production: ProductionDirection;
  onScreenInfo: OnScreenInformation | null;
  /** Location and participants */
  locationId: string;
  participantIds: string[];
  turnIds: string[];
  speakerIds: string[];
  visualOnly: boolean;
  /** Beats preserved from Phase 5A */
  beats: SceneRenderBeat[];
  /** Asset references bound to this scene */
  assetRefs: VisualProductionAssetRef[];
  /** Canonical audio references bound to this scene */
  audioRefs: VisualProductionAudioRef[];
  /** Caption cues bound to this scene */
  captionCues: ReconciledCaptionCue[];
  /** Transition reference mapped */
  transition: {
    type: TransitionType;
    durationSeconds: number;
    source: 'scene.transitionIntent' | 'production.transitionIntent' | 'default';
    actualStartSeconds: number | null;
    actualEndSeconds: number | null;
    actualDurationSeconds: number | null;
    rendererKey: string; // e.g., 'direct_cut', 'push', etc.
  };
  /** Target format / dimensions info */
  targetFormat: ScenarioTargetFormat;
  formatInfo?: {
    orientation: 'landscape' | 'portrait' | 'format_neutral';
    aspectRatio: '16:9' | '9:16' | 'any';
  };
}

/** Deterministic summary */
export interface SceneRenderSummary {
  scenarioId: string;
  projectId: string;
  language: string;
  targetFormat: ScenarioTargetFormat;
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
  totalEstimatedDurationSeconds: number;
  totalDeltaSeconds: number;
  warningCount: number;
  status: 'ok' | 'warning' | 'error';
}

export interface SceneRenderFinding {
  severity: 'error' | 'warning';
  code: SceneRenderErrorCode;
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
  };
}

/** Complete SceneRenderPlan */
export interface SceneRenderPlan {
  planVersion: typeof SCENE_RENDER_PLAN_VERSION;
  scenarioId: string;
  projectId: string;
  language: string;
  targetFormat: ScenarioTargetFormat;
  totalActualDurationSeconds: number;
  totalEstimatedDurationSeconds: number;
  totalDeltaSeconds: number;
  scenes: SceneRenderSpec[];
  summary: SceneRenderSummary;
  findings: SceneRenderFinding[];
  valid: boolean;
}

export type BuildSceneRenderResult =
  | { success: true; plan: SceneRenderPlan }
  | { success: false; error: string; findings: SceneRenderFinding[]; partialPlan?: SceneRenderPlan };

export type SceneRenderErrorCode =
  | 'UNSUPPORTED_SCENE_TYPE'
  | 'RENDERER_MAPPING_MISSING'
  | 'RENDERER_MAPPING_INVALID'
  | 'SCENE_RENDER_INVARIANT_FAILED'
  | 'ASSET_BINDING_MISMATCH'
  | 'AUDIO_BINDING_MISMATCH'
  | 'CAPTION_BINDING_MISMATCH'
  | 'TRANSITION_BINDING_INVALID'
  | 'DUPLICATE_RENDER_ORDER'
  | 'DUPLICATE_SCENE_ID'
  | 'MISSING_SCENE'
  | 'MISSING_PHASE_OUTPUT'
  | 'PIPELINE_IDENTITY_MISMATCH'
  | 'VISUAL_SCENE_MISMATCH'
  | 'VISUAL_BEAT_MISMATCH'
  | 'INVALID_DURATION'
  | 'OVERLAP_DETECTED';

export class SceneRenderError extends Error {
  public readonly code: SceneRenderErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly findings?: SceneRenderFinding[];

  constructor(code: SceneRenderErrorCode, message: string, details?: Record<string, unknown>, findings?: SceneRenderFinding[]) {
    super(message);
    this.name = 'SceneRenderError';
    this.code = code;
    this.details = details;
    this.findings = findings;
  }
}
