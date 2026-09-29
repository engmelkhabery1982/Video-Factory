/**
 * BuildTrack Video Factory - Phase 5A Visual Production Contract
 *
 * Canonical contract between completed Phase 4 dialogue pipeline and future visual/rendering work.
 * No rendering, no Remotion, no image generation — only deterministic adapter data.
 *
 * Timing authority: Phase 4 actual reconciled timing.
 */

import { ScenarioTargetFormat, SceneNarrativePurpose, TransitionType, ShotType, FramingAlignment, SpeakerFocus, CameraMovement, TurnIntent, TurnDelivery } from './types.js';
import { ProductionDirection, OnScreenInformation } from './types.js';
import { ReconciledCaptionCue } from './timing-reconciliation-types.js';

export const VISUAL_PRODUCTION_PLAN_VERSION = '1.0.0' as const;

/** Asset reference reused from Phase 3B visual plan */
export interface VisualProductionAssetRef {
  /** Logical asset reference from Phase 3B cue (e.g., 'asset:screen-insert:xyz') */
  assetRef: string;
  /** Kind of visual cue that carries this asset */
  cueKind: string;
  /** Cue ID that references it */
  cueId: string;
  /** Beat ID containing the cue */
  beatId: string;
  /** Scene ID */
  sceneId: string;
  /** Source field that produced this asset reference */
  sourceField?: string;
  /** Whether this asset is required or optional */
  required: boolean;
  /** Warning if asset reference is structurally invalid but optional */
  warning?: string;
}

/** Canonical audio reference — must use canonical normalized audio */
export interface VisualProductionAudioRef {
  clipId: string;
  turnId: string;
  sceneId: string;
  sceneIndex: number;
  turnIndex: number;
  globalTurnIndex: number;
  speakerId: string;
  voiceSlot: string;
  voiceProfileId: string;
  spokenText: string;
  canonicalPath: string;
  sourcePath: string;
  actualDurationSeconds: number;
  actualStartSeconds: number;
  actualEndSeconds: number;
  actualTotalSpanSeconds: number;
  pauseAfterSeconds: number;
}

/** Visual beat adapted to actual timing */
export interface VisualProductionBeat {
  id: string;
  sceneId: string;
  sourceSceneId: string;
  index: number;
  kind: 'dialogue' | 'visual_only' | 'transition';
  /** Original estimated timing from Phase 3B visual plan */
  estimatedStartSeconds: number;
  estimatedEndSeconds: number;
  estimatedDurationSeconds: number;
  /** Actual timing adapted to Phase 4 reconciled scene interval — authoritative */
  actualStartSeconds: number;
  actualEndSeconds: number;
  actualDurationSeconds: number;
  /** Relative position within scene (0..1) preserved from estimated */
  relativeStart: number;
  relativeEnd: number;
  /** Dialogue associations */
  turnId: string | null;
  activeSpeakerId: string | null;
  reactingCharacterId: string | null;
  spokenText: string | null;
  intent: TurnIntent | null;
  delivery: TurnDelivery | null;
  /** Shot description preserved */
  shot: {
    shotType: ShotType;
    framing: FramingAlignment;
    speakerFocus: SpeakerFocus;
    cameraMovement: CameraMovement;
    focusCharacterId: string | null;
  };
  evidenceIds: string[];
  /** Visual cues within this beat, with timing adapted */
  cues: VisualProductionCue[];
  /** Audio reference if this beat is dialogue */
  audioRef: VisualProductionAudioRef | null;
  /** Caption cue IDs for this beat (turn) */
  captionCueIds: string[];
}

export interface VisualProductionCue {
  id: string;
  kind: string;
  text: string;
  /** Estimated timing from Phase 3B */
  estimatedStartSeconds: number;
  estimatedEndSeconds: number;
  /** Actual timing adapted */
  actualStartSeconds: number;
  actualEndSeconds: number;
  actualDurationSeconds: number;
  source: {
    sceneId: string;
    field: string;
    turnId?: string;
    evidenceId?: string;
    itemIndex?: number;
  };
  assetRef?: string;
}

/** Scene production data */
export interface VisualProductionScene {
  id: string;
  sourceSceneId: string;
  sceneId: string;
  index: number;
  title: string | null;
  narrativePurpose: SceneNarrativePurpose;
  locationId: string;
  participantIds: string[];
  turnIds: string[];
  speakerIds: string[];
  visualOnly: boolean;
  /** Estimated timing from Phase 3B (for reference) */
  estimatedStartSeconds: number;
  estimatedEndSeconds: number;
  estimatedDurationSeconds: number;
  /** Actual timing from Phase 4 — authoritative */
  actualStartSeconds: number;
  actualEndSeconds: number;
  actualDurationSeconds: number;
  /** Production direction preserved from Phase 3B */
  production: ProductionDirection;
  onScreenInfo: OnScreenInformation | null;
  /** Transition intent preserved */
  transition: {
    type: TransitionType;
    durationSeconds: number;
    source: 'scene.transitionIntent' | 'production.transitionIntent' | 'default';
    /** Actual interval for transition within scene */
    actualStartSeconds: number | null;
    actualEndSeconds: number | null;
    actualDurationSeconds: number | null;
  };
  /** Visual beats adapted to actual timing */
  beats: VisualProductionBeat[];
  /** Audio clip references for this scene */
  audioRefs: VisualProductionAudioRef[];
  /** Caption cues for this scene (reconciled) */
  captionCues: ReconciledCaptionCue[];
  /** Asset references */
  assetRefs: VisualProductionAssetRef[];
  /** Deterministic render order (same as index) */
  renderOrder: number;
}

/** Deterministic summary for renderer/debug */
export interface VisualProductionSummary {
  scenarioId: string;
  projectId: string;
  language: string;
  targetFormat: ScenarioTargetFormat;
  sceneCount: number;
  visualBeatCount: number;
  audioClipCount: number;
  captionCueCount: number;
  assetReferenceCount: number;
  totalActualDurationSeconds: number;
  totalEstimatedDurationSeconds: number;
  totalDeltaSeconds: number;
  warningCount: number;
  status: 'ok' | 'warning' | 'error';
}

/** Structured finding */
export interface VisualProductionFinding {
  severity: 'error' | 'warning';
  code: VisualProductionErrorCode;
  message: string;
  location?: {
    scenarioId?: string;
    sceneId?: string;
    beatId?: string;
    cueId?: string;
    turnId?: string;
    clipId?: string;
    assetRef?: string;
  };
}

/** Canonical visual production plan — stable contract for Phase 5B/5C */
export interface VisualProductionPlan {
  planVersion: typeof VISUAL_PRODUCTION_PLAN_VERSION;
  scenarioId: string;
  projectId: string;
  language: string;
  targetFormat: ScenarioTargetFormat;
  /** Total actual duration from Phase 4 — authoritative */
  totalActualDurationSeconds: number;
  totalEstimatedDurationSeconds: number;
  totalDeltaSeconds: number;
  /** Scenes in deterministic render order */
  scenes: VisualProductionScene[];
  /** Summary */
  summary: VisualProductionSummary;
  /** Findings */
  findings: VisualProductionFinding[];
  /** Whether invariants passed */
  valid: boolean;
}

export type BuildVisualProductionResult =
  | { success: true; plan: VisualProductionPlan }
  | { success: false; error: string; findings: VisualProductionFinding[]; partialPlan?: VisualProductionPlan };

/** Phase 5A-specific error codes */
export type VisualProductionErrorCode =
  | 'VISUAL_SCENE_MISMATCH'
  | 'VISUAL_BEAT_MISMATCH'
  | 'MISSING_ACTUAL_TIMING'
  | 'AUDIO_REFERENCE_MISMATCH'
  | 'CAPTION_REFERENCE_MISMATCH'
  | 'ASSET_REFERENCE_INVALID'
  | 'VISUAL_PRODUCTION_INVARIANT_FAILED'
  | 'PIPELINE_IDENTITY_MISMATCH'
  | 'MISSING_PHASE_OUTPUT'
  | 'INVALID_DURATION'
  | 'OVERLAP_DETECTED'
  | 'DUPLICATE_SCENE_ID'
  | 'MISSING_SCENE';

export class VisualProductionError extends Error {
  public readonly code: VisualProductionErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly findings?: VisualProductionFinding[];

  constructor(code: VisualProductionErrorCode, message: string, details?: Record<string, unknown>, findings?: VisualProductionFinding[]) {
    super(message);
    this.name = 'VisualProductionError';
    this.code = code;
    this.details = details;
    this.findings = findings;
  }
}
