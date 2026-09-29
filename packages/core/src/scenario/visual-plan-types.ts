/**
 * BuildTrack Video Factory - Phase 3B Scenario Visual Plan Types
 *
 * A renderer-neutral, JSON-serializable plan compiled deterministically from a
 * canonical Phase 3A `Scenario`. It says WHAT is on screen and WHEN; it never
 * says HOW a renderer draws it. Every piece of visible content carries a
 * `source` pointer back to the scenario field it was copied from, so the plan
 * can be audited for invented dialogue, evidence, numbers or claims.
 */

import type {
  CameraMovement,
  EvidenceConfidence,
  FramingAlignment,
  NumericFact,
  OnScreenInformation,
  ProductionDirection,
  SceneNarrativePurpose,
  ScenarioTargetFormat,
  ShotType,
  SpeakerFocus,
  TransitionType,
  TurnDelivery,
  TurnIntent,
} from './types.js';
import type { ValidationFinding } from './validate.js';

export const SCENARIO_VISUAL_PLAN_VERSION = '1.0.0';

/** Exact scenario field a visible cue was copied from. */
export type ScenarioVisualSourceField =
  | 'turn.spokenText'
  | 'turn.onScreenText'
  | 'evidence.claim'
  | 'scene.title'
  | 'onScreenInfo.title'
  | 'onScreenInfo.subtitle'
  | 'onScreenInfo.callout'
  | 'onScreenInfo.bulletPoints'
  | 'production.screenInsert.title'
  | 'production.screenInsert.description'
  | 'production.overlayIntent'
  | 'production.bRollIntent'
  | 'production.environmentalAction';

export interface ScenarioVisualSource {
  sceneId: string;
  field: ScenarioVisualSourceField;
  turnId?: string;
  evidenceId?: string;
  /** Index into an array field (bullet points). */
  itemIndex?: number;
}

export type ScenarioVisualCueKind =
  | 'dialogue'
  | 'on_screen_text'
  | 'evidence'
  | 'scene_title'
  | 'lower_third_title'
  | 'lower_third_subtitle'
  | 'callout'
  | 'bullet_point'
  | 'screen_insert_title'
  | 'screen_insert_description'
  | 'overlay'
  | 'b_roll'
  | 'environment';

/** One piece of visible or intended content, timed inside its scene. */
export interface ScenarioVisualCue {
  id: string;
  kind: ScenarioVisualCueKind;
  /** Verbatim copy of the source field. Never paraphrased. */
  text: string;
  startSeconds: number;
  endSeconds: number;
  source: ScenarioVisualSource;
  /** Present only on `evidence` cues: exact copy of the evidence record's facts. */
  numericFacts?: NumericFact[];
  evidenceSourceRef?: string;
  evidenceConfidence?: EvidenceConfidence;
  /** Present only on screen-insert cues; a logical asset reference, never a path. */
  assetRef?: string;
}

export interface ScenarioVisualShot {
  shotType: ShotType;
  framing: FramingAlignment;
  speakerFocus: SpeakerFocus;
  cameraMovement: CameraMovement;
  /** Character the camera favours, when the direction names one. */
  focusCharacterId: string | null;
}

export type ScenarioVisualBeatKind = 'dialogue' | 'visual_only' | 'transition';

/** An ordered, timed moment inside a visual scene. */
export interface ScenarioVisualBeat {
  id: string;
  sceneId: string;
  index: number;
  kind: ScenarioVisualBeatKind;
  startSeconds: number;
  endSeconds: number;
  /** Dialogue beats only. */
  turnId: string | null;
  activeSpeakerId: string | null;
  reactingCharacterId: string | null;
  spokenText: string | null;
  intent: TurnIntent | null;
  delivery: TurnDelivery | null;
  speechSeconds: number;
  pauseSeconds: number;
  shot: ScenarioVisualShot;
  evidenceIds: string[];
  cues: ScenarioVisualCue[];
}

export interface ScenarioVisualEvidence {
  id: string;
  claim: string;
  evidenceType: string;
  sourceRef: string;
  numericFacts: NumericFact[];
  confidence: EvidenceConfidence;
}

export interface ScenarioVisualTransition {
  type: TransitionType;
  durationSeconds: number;
  /** Where the intent came from: the scene, its production direction, or none. */
  source: 'scene.transitionIntent' | 'production.transitionIntent' | 'default';
}

/** One visual scene per source scenario scene, in the same order. */
export interface ScenarioVisualScene {
  id: string;
  sourceSceneId: string;
  index: number;
  title: string | null;
  narrativePurpose: SceneNarrativePurpose;
  locationId: string;
  participantIds: string[];
  turnIds: string[];
  speakerIds: string[];
  visualOnly: boolean;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  /** Deep copy of the source direction (renderer-neutral). */
  production: ProductionDirection;
  onScreenInfo: OnScreenInformation | null;
  evidenceIds: string[];
  evidence: ScenarioVisualEvidence[];
  transitionOut: ScenarioVisualTransition;
  beats: ScenarioVisualBeat[];
  /** Scene-wide cues (lower thirds, screen insert, overlay, B-roll intent). */
  sceneCues: ScenarioVisualCue[];
}

export interface ScenarioVisualFormatProfile {
  targetFormat: ScenarioTargetFormat;
  orientation: 'landscape' | 'portrait' | 'format_neutral';
  aspectRatio: '16:9' | '9:16' | 'any';
  /** Most bullet points a single frame should carry for this format. */
  maxBulletsPerFrame: number;
  /** Most simultaneous scene-wide text cues this format should carry. */
  maxSceneTextCues: number;
}

export type ScenarioVisualPlanFindingSeverity = 'error' | 'warning';

export interface ScenarioVisualPlanFinding {
  severity: ScenarioVisualPlanFindingSeverity;
  ruleId: string;
  message: string;
  location: {
    sceneId?: string;
    beatId?: string;
    cueId?: string;
    turnId?: string;
    evidenceId?: string;
  };
}

export interface ScenarioVisualPlan {
  planVersion: string;
  scenarioId: string;
  projectId: string;
  scenarioSchemaVersion: string;
  language: string;
  format: ScenarioVisualFormatProfile;
  totalDurationSeconds: number;
  targetDuration: { targetSeconds: number; minSeconds: number | null; maxSeconds: number | null };
  scenes: ScenarioVisualScene[];
  diversity: {
    overallDiversityScore: number;
    warnings: ScenarioVisualPlanFinding[];
  };
  /** Compiler warnings (never errors: an erroring source is refused). */
  findings: ScenarioVisualPlanFinding[];
}

export type CompileScenarioVisualPlanResult =
  | { ok: true; plan: ScenarioVisualPlan; sourceWarnings: ValidationFinding[] }
  | { ok: false; plan: null; errors: ValidationFinding[]; sourceWarnings: ValidationFinding[] };

export interface ScenarioVisualPlanValidationReport {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  findings: ScenarioVisualPlanFinding[];
}
