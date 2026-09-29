/**
 * BuildTrack Video Factory - Phase 3D Unified Scenario Playback Manifest types
 *
 * One renderer-neutral, JSON-serializable timeline that joins the canonical
 * Phase 3A Scenario, the Phase 3B ScenarioVisualPlan and the Phase 3C
 * DialogueAudioPlan. A renderer consumes this manifest and never has to guess
 * scene order, beat order, clip placement, speakers, shots, cues, evidence,
 * voice slots or any duration.
 *
 * All timing is expressed as integer milliseconds on one global timeline that
 * starts at 0. Every interval is half-open: [startMs, endMs).
 */

import type { DurationEstimatorConfig } from './duration.js';
import type {
  OnScreenInformation,
  ProductionDirection,
  SceneNarrativePurpose,
  ScenarioTargetFormat,
  TransitionType,
  TurnDelivery,
  TurnIntent,
} from './types.js';
import type {
  ScenarioVisualBeatKind,
  ScenarioVisualCue,
  ScenarioVisualEvidence,
  ScenarioVisualFormatProfile,
  ScenarioVisualShot,
  ScenarioVisualTransition,
} from './visual-plan-types.js';
import type { AudioFormatSpec } from './dialogue-audio-types.js';

export const SCENARIO_PLAYBACK_PLAN_VERSION = '1.0.0';

/** Half-open interval on the global timeline, integer milliseconds. */
export interface ScenarioPlaybackInterval {
  startMs: number;
  endMs: number;
  /** Always endMs - startMs. */
  durationMs: number;
}

/**
 * One source dialogue turn joined to its visual beat and its audio clip.
 *
 * Interval relationship (enforced by the validator):
 *   turnSpan == the visual beat interval
 *   speech.startMs == turnSpan.startMs
 *   pause.startMs  == speech.endMs
 *   pause.endMs    == turnSpan.endMs
 */
export interface ScenarioPlaybackDialogue {
  /** Same stable ID as the Phase 3B dialogue beat. */
  id: string;
  /** 0-based position across the whole scenario. */
  globalIndex: number;
  /** Source scene ID (not the visual scene ID). */
  sceneId: string;
  sceneIndex: number;
  turnId: string;
  /** 0-based position within the source scene. */
  turnIndex: number;
  /** Join keys. */
  visualBeatId: string;
  audioClipId: string;
  speakerId: string;
  reactingCharacterId: string | null;
  voiceSlot: string;
  spokenText: string;
  intent: TurnIntent;
  delivery: TurnDelivery | null;
  evidenceIds: string[];
  /** Relative, suggested location for the synthesized clip (from Phase 3C). */
  suggestedAudioPath: string;
  speech: ScenarioPlaybackInterval;
  pause: ScenarioPlaybackInterval;
  turnSpan: ScenarioPlaybackInterval;
}

/** One visual beat, in order, tiling its scene exactly. */
export interface ScenarioPlaybackBeat {
  /** Same stable ID as the Phase 3B beat. */
  id: string;
  index: number;
  kind: ScenarioVisualBeatKind;
  interval: ScenarioPlaybackInterval;
  /** Dialogue entry ID for dialogue beats, otherwise null. */
  dialogueId: string | null;
  activeSpeakerId: string | null;
  reactingCharacterId: string | null;
  shot: ScenarioVisualShot;
  evidenceIds: string[];
  /** Visible cues copied verbatim from Phase 3B, re-timed in ms. */
  cues: ScenarioPlaybackCue[];
}

/** A Phase 3B cue with its timing expressed as an integer-ms interval. */
export type ScenarioPlaybackCue = Omit<ScenarioVisualCue, 'startSeconds' | 'endSeconds'> & {
  interval: ScenarioPlaybackInterval;
};

export interface ScenarioPlaybackTransition {
  type: TransitionType;
  source: ScenarioVisualTransition['source'];
  /**
   * Timed interval of the transition beat, or null when the transition adds
   * no Phase 3A time (cut / none / production-level / default).
   */
  interval: ScenarioPlaybackInterval | null;
}

export interface ScenarioPlaybackScene {
  /** Same stable ID as the Phase 3B visual scene: `${scenarioId}/${sceneId}`. */
  id: string;
  sourceSceneId: string;
  index: number;
  title: string | null;
  narrativePurpose: SceneNarrativePurpose;
  locationId: string;
  participantIds: string[];
  visualOnly: boolean;
  interval: ScenarioPlaybackInterval;
  /** Span covered by dialogue turns (speech + pauses), null for visual-only scenes. */
  dialogueSpan: ScenarioPlaybackInterval | null;
  transition: ScenarioPlaybackTransition;
  production: ProductionDirection;
  onScreenInfo: OnScreenInformation | null;
  evidence: ScenarioVisualEvidence[];
  sceneCues: ScenarioPlaybackCue[];
  beats: ScenarioPlaybackBeat[];
  /** Dialogue entry IDs in this scene, in source order. */
  dialogueIds: string[];
}

export interface ScenarioPlaybackCharacterVoice {
  characterId: string;
  voiceSlot: string;
  turnCount: number;
}

export interface ScenarioPlaybackFinding {
  severity: 'error' | 'warning';
  ruleId: string;
  message: string;
  /** Which stage raised it. */
  stage: 'source' | 'visual' | 'audio' | 'playback';
  location: {
    sceneId?: string;
    beatId?: string;
    turnId?: string;
    clipId?: string;
    cueId?: string;
    evidenceId?: string;
  };
}

export interface ScenarioPlaybackPlan {
  playbackVersion: typeof SCENARIO_PLAYBACK_PLAN_VERSION;
  scenarioId: string;
  projectId: string;
  language: string;
  targetFormat: ScenarioTargetFormat;
  schemaVersions: {
    scenario: string;
    visualPlan: string;
    audioPlan: string;
  };
  /** The exact, complete estimator configuration used by both planners. */
  durationConfig: DurationEstimatorConfig;
  allowSharedVoiceSlots: boolean;
  /** Relative base directory used for suggested audio paths. */
  audioBasePath: string;
  format: ScenarioVisualFormatProfile;
  audioFormat: AudioFormatSpec;
  totalDurationMs: number;
  totalSpeechMs: number;
  totalPauseMs: number;
  totalTransitionMs: number;
  totalVisualOnlyMs: number;
  dialogueCount: number;
  characters: ScenarioPlaybackCharacterVoice[];
  scenes: ScenarioPlaybackScene[];
  /** All dialogue entries in chronological (= source) order. */
  dialogues: ScenarioPlaybackDialogue[];
  /** Non-blocking warnings carried from the visual plan (format, diversity). */
  warnings: ScenarioPlaybackFinding[];
}

export interface ScenarioPlaybackOptions {
  /** Partial overrides of DEFAULT_DURATION_CONFIG, applied to both planners. */
  durationConfig?: Partial<DurationEstimatorConfig>;
  /** Forwarded to the Phase 3C planner. */
  allowSharedVoiceSlots?: boolean;
  /** Relative base directory for suggested audio paths (Phase 3C default: 'audio/dialogue'). */
  audioBasePath?: string;
}

export type CompileScenarioPlaybackResult =
  | { ok: true; plan: ScenarioPlaybackPlan; sourceWarnings: ScenarioPlaybackFinding[] }
  | { ok: false; plan: null; errors: ScenarioPlaybackFinding[]; sourceWarnings: ScenarioPlaybackFinding[] };

export interface ScenarioPlaybackValidationReport {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  findings: ScenarioPlaybackFinding[];
}
