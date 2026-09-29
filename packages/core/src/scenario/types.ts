/**
 * BuildTrack Video Factory - Phase 3A Scenario Contract Types
 *
 * Defines the canonical, versioned, JSON-serializable scenario data contract.
 * Used for multi-character realistic workplace discussions, site walks, commercial reviews,
 * evidence citation, camera/production directions, and duration estimation.
 */

export const SCENARIO_SCHEMA_VERSION = '1.0.0';

/** Target format for video production */
export type ScenarioTargetFormat = 'Long' | 'Short' | 'reusable';

/** Structured location/setting categories */
export type ScenarioSettingType =
  | 'progress_meeting'
  | 'site_walk'
  | 'commercial_meeting'
  | 'planning_review'
  | 'office_discussion'
  | 'control_room'
  | 'remote_call'
  | 'interview'
  | 'mixed_scenario'
  | string;

/** Narrative purpose of a scene within the overarching scenario */
export type SceneNarrativePurpose =
  | 'hook'
  | 'context'
  | 'problem'
  | 'evidence'
  | 'disagreement'
  | 'clarification'
  | 'decision'
  | 'solution'
  | 'demonstration'
  | 'result'
  | 'cta';

/** Dialogue communicative intent */
export type TurnIntent =
  | 'question'
  | 'assertion'
  | 'objection'
  | 'concession'
  | 'clarification'
  | 'instruction'
  | 'agreement'
  | 'call_to_action'
  | string;

/** Delivery / emotion tone */
export type TurnDelivery =
  | 'calm'
  | 'firm'
  | 'urgent'
  | 'skeptical'
  | 'collaborative'
  | 'frustrated'
  | 'authoritative'
  | 'reflective'
  | string;

/** Renderer-neutral camera shot framing */
export type ShotType =
  | 'wide'
  | 'medium'
  | 'two_shot'
  | 'close_up'
  | 'over_the_shoulder'
  | 'point_of_view'
  | 'screen_insert'
  | 'detail_macro';

/** Camera framing alignment */
export type FramingAlignment =
  | 'center'
  | 'rule_of_thirds_left'
  | 'rule_of_thirds_right'
  | 'symmetric';

/** Focal target for the shot */
export type SpeakerFocus =
  | 'speaking_character'
  | 'reacting_character'
  | 'group'
  | 'shared_display'
  | 'document';

/** Camera movement intent */
export type CameraMovement =
  | 'static'
  | 'slow_push'
  | 'slow_pull'
  | 'pan_left'
  | 'pan_right'
  | 'subtle_drift';

/** Scene transition intent */
export type TransitionType =
  | 'cut'
  | 'dissolve'
  | 'fade_black'
  | 'wipe'
  | 'none';

/** Verification / confidence status of evidence */
export type EvidenceConfidence =
  | 'verified'
  | 'provisional'
  | 'disputed'
  | 'unconfirmed';

/** Character definition */
export interface ScenarioCharacter {
  /** Unique character identifier */
  id: string;
  /** Display name shown in UI and script */
  name: string;
  /** Professional role (e.g. 'Project Manager', 'Site Engineer') */
  role: string;
  /** Narrative role (e.g. 'challenger', 'mediator', 'technical_authority') */
  narrativeFunction: string;
  /** Optional slot identifier for future multi-voice synthesis assignment */
  voiceSlot?: string;
  /** Optional visual appearance guidance */
  visualDescription?: string;
  /** Communication style (e.g. 'direct and data-driven', 'conciliatory') */
  communicationStyle: string;
  /** Optional behavioral or operational constraints */
  constraints?: string[];
}

/** Structured setting / location */
export interface ScenarioLocation {
  id: string;
  name: string;
  settingType: ScenarioSettingType;
  description?: string;
  environment?: 'indoor' | 'outdoor' | 'hybrid';
}

/** Numeric fact associated with evidence */
export interface NumericFact {
  metric: string;
  value: number;
  unit: string;
  baselineValue?: number;
}

/** Evidence and numeric claim */
export interface ScenarioEvidence {
  id: string;
  claim: string;
  evidenceType: string;
  /** Declared source reference (e.g. report number, drawing code, meeting log) */
  sourceRef: string;
  /** Exact numeric facts tied to the claim */
  numericFacts: NumericFact[];
  confidence: EvidenceConfidence;
  /** Scene IDs where this evidence is introduced or debated */
  usedInSceneIds: string[];
  /** Dialogue turn IDs directly referencing this evidence */
  usedInTurnIds: string[];
}

/** Renderer-neutral production direction */
export interface ProductionDirection {
  shotType: ShotType;
  framing: FramingAlignment;
  speakerFocus: SpeakerFocus;
  cameraMovement: CameraMovement;
  screenInsert?: {
    title: string;
    assetRef?: string;
    description: string;
  };
  bRollIntent?: string;
  overlayIntent?: string;
  environmentalAction?: string;
  transitionIntent?: {
    type: TransitionType;
    durationSeconds?: number;
  };
}

/** On-screen lower third / graphic information */
export interface OnScreenInformation {
  title?: string;
  subtitle?: string;
  callout?: string;
  bulletPoints?: string[];
}

/** Individual dialogue turn */
export interface DialogueTurn {
  id: string;
  speakerId: string;
  spokenText: string;
  intent: TurnIntent;
  delivery?: TurnDelivery;
  /** Silence or breath pause after the turn in seconds */
  pauseAfterSeconds?: number;
  /** Character ID reacting to this dialogue */
  reactionTargetId?: string;
  /** Synchronous on-screen caption or graphic text */
  onScreenText?: string;
  /** Associated evidence ID if citing a record or claim */
  evidenceId?: string;
  /** Future-compatible voice slot mapping */
  voiceSlot?: string;
  /** Required justification if speaker delivers multiple uninterrupted turns */
  monologueReason?: string;
}

/** Justification notes for structural repetition */
export interface SceneJustifications {
  repeatedShot?: string;
  repeatedSetting?: string;
  consecutiveSpeaker?: string;
}

/** Individual scene within the scenario */
export interface ScenarioScene {
  id: string;
  index: number;
  title?: string;
  narrativePurpose: SceneNarrativePurpose;
  locationId: string;
  estimatedDuration: number;
  participantIds: string[];
  turns: DialogueTurn[];
  production: ProductionDirection;
  evidenceIds?: string[];
  onScreenInfo?: OnScreenInformation;
  transitionIntent?: {
    type: TransitionType;
    durationSeconds?: number;
  };
  justifications?: SceneJustifications;
}

/** Top-level scenario metadata */
export interface ScenarioMetadata {
  schemaVersion: string;
  id: string;
  projectId: string;
  title: string;
  language: string;
  targetFormat: ScenarioTargetFormat;
  sourceBrief: string;
  targetAudience: string;
  intendedOutcome: string;
  estimatedDuration: {
    targetSeconds: number;
    minSeconds?: number;
    maxSeconds?: number;
    estimatedSeconds?: number;
  };
  createdAt?: string;
  updatedAt?: string;
}

/** Complete canonical Scenario document */
export interface Scenario {
  metadata: ScenarioMetadata;
  characters: ScenarioCharacter[];
  locations: ScenarioLocation[];
  evidence: ScenarioEvidence[];
  scenes: ScenarioScene[];
}
