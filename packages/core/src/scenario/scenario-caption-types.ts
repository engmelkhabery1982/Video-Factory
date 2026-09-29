/**
 * BuildTrack Video Factory - Phase 3E Scenario Caption Planning Types
 *
 * Defines the deterministic, speaker-aware scenario caption planning contract.
 * Purely renderer-neutral timed caption cues aligned with Phase 3C DialogueAudioPlan
 * without altering spoken text or inserting invented speaker labels.
 */

import { ScenarioTargetFormat, TurnDelivery, TurnIntent } from './types.js';

export const SCENARIO_CAPTION_PLAN_SCHEMA_VERSION = '1.0.0';

function stableCaptionHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Collision-resistant, deterministic cue ID derived only from source IDs. */
export function scenarioCaptionCueId(sceneId: string, turnId: string, cueIndex: number): string {
  const part = (value: string) => {
    const safe = value.replace(/[^a-zA-Z0-9_-]/g, '_');
    return safe === value ? safe : `${safe}_${stableCaptionHash(value)}`;
  };
  return `cue_${part(sceneId)}_${part(turnId)}_${cueIndex}`;
}

/** Display / layout profile for renderer-neutral caption formatting */
export interface CaptionFormatProfile {
  targetFormat: ScenarioTargetFormat;
  maxLines: number;
  maxCharsPerLine: number;
  maxCharsPerCue: number;
  safeZone: {
    topPercent: number;
    bottomPercent: number;
    leftPercent: number;
    rightPercent: number;
  };
}

export const CAPTION_PROFILES: Record<ScenarioTargetFormat, CaptionFormatProfile> = {
  Long: {
    targetFormat: 'Long',
    maxLines: 2,
    maxCharsPerLine: 42,
    maxCharsPerCue: 80,
    safeZone: {
      topPercent: 10,
      bottomPercent: 12,
      leftPercent: 8,
      rightPercent: 8,
    },
  },
  Short: {
    targetFormat: 'Short',
    maxLines: 2,
    maxCharsPerLine: 28,
    maxCharsPerCue: 54,
    safeZone: {
      topPercent: 18,
      bottomPercent: 22,
      leftPercent: 10,
      rightPercent: 10,
    },
  },
  reusable: {
    targetFormat: 'reusable',
    maxLines: 2,
    maxCharsPerLine: 28,
    maxCharsPerCue: 54,
    safeZone: {
      topPercent: 18,
      bottomPercent: 22,
      leftPercent: 10,
      rightPercent: 10,
    },
  },
};

/** Speaker metadata associated with caption cues */
export interface ScenarioCaptionSpeaker {
  speakerId: string;
  name: string;
  role: string;
  voiceSlot: string;
}

/** Individual timed caption cue */
export interface ScenarioCaptionCue {
  /** Deterministic identifier, e.g. `cue_${sceneId}_${turnId}_${cueIndex}` */
  id: string;
  /** Scenario ID */
  scenarioId: string;
  /** Scene ID */
  sceneId: string;
  /** Zero-based scene index */
  sceneIndex: number;
  /** Dialogue turn ID */
  turnId: string;
  /** Zero-based turn index within the scene */
  turnIndex: number;
  /** Corresponding Phase 3C audio clip ID */
  clipId: string;
  /** Speaking character ID */
  speakerId: string;
  /** Optional reacting character ID from scenario */
  reactingCharacterId?: string;
  /** Resolved voice slot */
  voiceSlot: string;
  /** Start time on global timeline in seconds (milliseconds precision) */
  startSeconds: number;
  /** End time on global timeline in seconds (milliseconds precision) */
  endSeconds: number;
  /** Duration of this cue in seconds */
  durationSeconds: number;
  /** Exact caption text fragment */
  text: string;
  /** Formatted lines wrapped according to profile (max 2 lines) */
  lines: string[];
  /** Zero-based cue index within the dialogue turn */
  cueIndex: number;
  /** Total number of cues produced for this turn */
  totalCuesInTurn: number;
  /** Global sequence index of this cue across the scenario (0, 1, 2...) */
  globalCueIndex: number;
  /** Zero-based starting word offset within turn.spokenText */
  sourceWordStart: number;
  /** Zero-based ending word offset (exclusive) within turn.spokenText */
  sourceWordEnd: number;
  /** Total word count of this cue */
  wordCount: number;
  /** Target format profile */
  targetFormat: ScenarioTargetFormat;
  /** Text reading direction */
  direction: 'ltr' | 'rtl';
  /** Communicative intent of the turn */
  intent: TurnIntent;
  /** Delivery guidance */
  delivery?: TurnDelivery;
}

/** Scene entry containing organized caption cues */
export interface ScenarioCaptionScene {
  sceneId: string;
  sceneIndex: number;
  title?: string;
  startSeconds: number;
  endSeconds: number;
  cues: ScenarioCaptionCue[];
}

/** Options for compiling scenario captions */
export interface ScenarioCaptionOptions {
  /** Custom max characters per line override */
  maxCharsPerLine?: number;
  /** Custom max lines per cue override (default 2) */
  maxLines?: number;
  /** Language reading direction override */
  direction?: 'ltr' | 'rtl';
}

/** Complete Canonical Scenario Caption Plan */
export interface ScenarioCaptionPlan {
  schemaVersion: typeof SCENARIO_CAPTION_PLAN_SCHEMA_VERSION;
  scenarioId: string;
  projectId: string;
  targetFormat: ScenarioTargetFormat;
  language: string;
  direction: 'ltr' | 'rtl';
  profile: CaptionFormatProfile;
  totalDurationSeconds: number;
  totalSpeechDurationSeconds: number;
  cueCount: number;
  totalWordCount: number;
  speakers: ScenarioCaptionSpeaker[];
  scenes: ScenarioCaptionScene[];
  cues: ScenarioCaptionCue[];
}

/** Structured validation finding */
export interface ScenarioCaptionFinding {
  severity: 'error' | 'warning';
  category: 'schema' | 'integrity' | 'timing' | 'text' | 'metadata' | 'path';
  ruleId: string;
  message: string;
  location?: {
    scenarioId?: string;
    sceneId?: string;
    turnId?: string;
    clipId?: string;
    cueId?: string;
    speakerId?: string;
  };
}

/** Report returned by validateScenarioCaptionPlan */
export interface ScenarioCaptionValidationReport {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  findings: ScenarioCaptionFinding[];
}

/** Result returned by compileScenarioCaptions */
export type CompileScenarioCaptionsResult =
  | {
      success: true;
      plan: ScenarioCaptionPlan;
      warnings: ScenarioCaptionFinding[];
    }
  | {
      success: false;
      error: string;
      findings: ScenarioCaptionFinding[];
    };
