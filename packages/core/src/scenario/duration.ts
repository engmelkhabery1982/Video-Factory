/**
 * BuildTrack Video Factory - Phase 3A Scenario Duration Estimation
 *
 * Provides deterministic, offline duration calculations based on spoken word count,
 * conversational cadence, inter-turn pauses, and visual/transition allowances.
 */

import { DialogueTurn, Scenario, ScenarioScene } from './types.js';

export interface DurationEstimatorConfig {
  /** Target conversational rate in words per minute (typical conversational speech is 140-160 WPM) */
  wordsPerMinute: number;
  /** Minimum duration in seconds allocated to any spoken turn regardless of brevity */
  minTurnSeconds: number;
  /** Default pause added when a turn specifies no pause */
  defaultPauseSeconds: number;
  /** Buffer allocated for scene transition animation (e.g. dissolve, wipe) */
  transitionAllowanceSeconds: number;
  /** Floor duration for a scene containing zero dialogue (visual beat or insert) */
  nonDialogueBeatSeconds: number;
}

export const DEFAULT_DURATION_CONFIG: DurationEstimatorConfig = {
  wordsPerMinute: 150,
  minTurnSeconds: 0.8,
  defaultPauseSeconds: 0.3,
  transitionAllowanceSeconds: 0.5,
  nonDialogueBeatSeconds: 2.5,
};

export interface TurnDurationEstimate {
  turnId: string;
  speakerId: string;
  wordCount: number;
  speechDurationSeconds: number;
  pauseSeconds: number;
  totalSeconds: number;
}

export interface SceneDurationEstimate {
  sceneId: string;
  sceneIndex: number;
  totalWords: number;
  turns: TurnDurationEstimate[];
  dialogueDurationSeconds: number;
  transitionSeconds: number;
  visualBeatSeconds: number;
  totalSeconds: number;
}

export interface ScenarioDurationEstimate {
  totalSeconds: number;
  totalWords: number;
  wordsPerMinute: number;
  scenes: SceneDurationEstimate[];
  assumptions: {
    wordsPerMinute: number;
    minTurnSeconds: number;
    defaultPauseSeconds: number;
    transitionAllowanceSeconds: number;
    nonDialogueBeatSeconds: number;
  };
}

/**
 * Counts words cleanly in a spoken text string.
 */
export function countWords(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (!cleaned) return 0;
  return cleaned.split(' ').filter(w => w.length > 0).length;
}

/**
 * Calculates deterministic duration for an individual dialogue turn.
 */
export function estimateTurnDuration(
  turn: DialogueTurn,
  config: DurationEstimatorConfig = DEFAULT_DURATION_CONFIG
): TurnDurationEstimate {
  const wordCount = countWords(turn.spokenText);
  const speechSecs = Math.max(
    config.minTurnSeconds,
    Math.round(((wordCount / config.wordsPerMinute) * 60) * 100) / 100
  );

  const pauseSecs = typeof turn.pauseAfterSeconds === 'number' && turn.pauseAfterSeconds >= 0
    ? turn.pauseAfterSeconds
    : config.defaultPauseSeconds;

  const total = Math.round((speechSecs + pauseSecs) * 100) / 100;

  return {
    turnId: turn.id,
    speakerId: turn.speakerId,
    wordCount,
    speechDurationSeconds: speechSecs,
    pauseSeconds: pauseSecs,
    totalSeconds: total,
  };
}

/**
 * Calculates deterministic duration for a scenario scene.
 */
export function estimateSceneDuration(
  scene: ScenarioScene,
  config: DurationEstimatorConfig = DEFAULT_DURATION_CONFIG
): SceneDurationEstimate {
  const turnEstimates = (scene.turns || []).map(t => estimateTurnDuration(t, config));
  const dialogueSecs = Math.round(turnEstimates.reduce((acc, t) => acc + t.totalSeconds, 0) * 100) / 100;
  const totalWords = turnEstimates.reduce((acc, t) => acc + t.wordCount, 0);

  // Transition buffer
  const hasTransition = scene.transitionIntent && scene.transitionIntent.type !== 'none' && scene.transitionIntent.type !== 'cut';
  const transitionSecs = hasTransition
    ? (scene.transitionIntent?.durationSeconds ?? config.transitionAllowanceSeconds)
    : 0;

  // Non-dialogue beat allowance if scene has no turns
  const visualBeatSecs = turnEstimates.length === 0 ? config.nonDialogueBeatSeconds : 0;

  const totalSecs = Math.round((dialogueSecs + transitionSecs + visualBeatSecs) * 100) / 100;

  return {
    sceneId: scene.id,
    sceneIndex: scene.index,
    totalWords,
    turns: turnEstimates,
    dialogueDurationSeconds: dialogueSecs,
    transitionSeconds: transitionSecs,
    visualBeatSeconds: visualBeatSecs,
    totalSeconds: totalSecs,
  };
}

/**
 * Calculates complete scenario duration breakdown and returns full deterministic report.
 */
export function estimateScenarioDuration(
  scenario: Scenario,
  config: DurationEstimatorConfig = DEFAULT_DURATION_CONFIG
): ScenarioDurationEstimate {
  const sceneEstimates = (scenario.scenes || []).map(s => estimateSceneDuration(s, config));
  const totalSeconds = Math.round(sceneEstimates.reduce((acc, s) => acc + s.totalSeconds, 0) * 100) / 100;
  const totalWords = sceneEstimates.reduce((acc, s) => acc + s.totalWords, 0);

  return {
    totalSeconds,
    totalWords,
    wordsPerMinute: config.wordsPerMinute,
    scenes: sceneEstimates,
    assumptions: { ...config },
  };
}
