/**
 * BuildTrack Video Factory - Workstream A
 * Bounded deterministic repair for generated scenarios.
 *
 * Every repair here is STRUCTURAL. It may never:
 *  - alter, round, or drop a numeric fact,
 *  - invent evidence, contract clauses, percentages, dates or project facts,
 *  - replace a scenario with a canned fixture.
 *
 * Repairs are pure functions of the scenario they are given, so a repair pass is
 * reproducible and byte-stable across runs.
 */

import type {
  Scenario,
  ScenarioScene,
  SceneNarrativePurpose,
  ProductionDirection,
  ShotType,
  TransitionType,
} from './types.js';
import { estimateSceneDuration, DEFAULT_DURATION_CONFIG } from './duration.js';
import { validateScenario } from './validate.js';

export interface ScenarioRepairContext {
  targetFormat: 'Long' | 'Short';
  /** Hard duration ceiling in seconds (Short contract: 65s). */
  hardDurationCeiling?: number;
  /** Warning-free duration ceiling in seconds (Short contract: 60s). */
  warningDurationCeiling?: number;
  /** Scene ids that must never be dropped because they carry numeric facts. */
  protectedSceneIds?: ReadonlySet<string>;
}

export interface ScenarioRepairOutcome {
  /** True when at least one mutation was applied. */
  repaired: boolean;
  /** Human-readable, deterministic log of what was changed. */
  actions: string[];
}

/** Shot cycle used to break mechanical shot repetition. */
const SHOT_CYCLE: ShotType[] = ['two_shot', 'medium', 'close_up', 'wide', 'over_the_shoulder'];

/** Scene purposes ordered from most to least structurally expendable. */
const DROP_PRIORITY: SceneNarrativePurpose[] = [
  'clarification',
  'context',
  'demonstration',
  'disagreement',
  'result',
  'solution',
  'decision',
  'problem',
  'evidence',
  'hook',
  'cta',
];

const CTA_TURN_TEXT =
  'Act on the verified position in your next review cycle.';

const MONOLOGUE_REASON =
  'Speaker holds the floor deliberately to deliver one continuous technical or commercial point before handing over.';

/**
 * Re-runs the validator and reports whether the scenario is contract-clean.
 */
export function isScenarioValid(scenario: Scenario): boolean {
  return validateScenario(scenario).valid;
}

/** Rounds to 2 decimals, matching the duration estimator's own precision. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Synchronises `scene.participantIds` with the characters that actually speak
 * (or are explicitly reacted to) inside the scene. Fixes RULE-019 and RULE-018.
 */
function repairParticipantLinkage(scenario: Scenario, actions: string[]): void {
  for (const scene of scenario.scenes) {
    const speakers = new Set<string>();
    for (const turn of scene.turns) {
      if (turn.speakerId) speakers.add(turn.speakerId);
      if (turn.reactionTargetId) speakers.add(turn.reactionTargetId);
    }
    const merged = Array.from(new Set([...speakers]));
    const before = (scene.participantIds || []).join(',');
    const after = merged.join(',');
    if (before !== after) {
      scene.participantIds = merged;
      actions.push(`participants:${scene.id}`);
    }
  }
}

/** Forces strictly sequential, ascending scene indices. Fixes RULE-010. */
function repairSceneIndices(scenario: Scenario, actions: string[]): void {
  scenario.scenes.forEach((scene, index) => {
    if (scene.index !== index) {
      scene.index = index;
      actions.push(`scene-index:${scene.id}`);
    }
  });
}

/**
 * Recomputes each scene's `estimatedDuration` from its own dialogue. Never
 * changes spoken text, so numeric facts are untouched.
 */
function repairSceneDurations(scenario: Scenario, actions: string[]): void {
  for (const scene of scenario.scenes) {
    const estimate = estimateSceneDuration(scene, DEFAULT_DURATION_CONFIG);
    const next = Math.max(0.5, round2(estimate.totalSeconds));
    if (scene.estimatedDuration !== next) {
      scene.estimatedDuration = next;
      actions.push(`scene-duration:${scene.id}`);
    }
  }
}

/**
 * Guarantees the final scene of a Long/Short carries a CTA. The injected turn
 * is a neutral, non-factual template and never asserts a project fact.
 */
function repairFinalCta(scenario: Scenario, ctx: ScenarioRepairContext, actions: string[]): void {
  if (ctx.targetFormat !== 'Long' && ctx.targetFormat !== 'Short') return;
  if (scenario.scenes.length === 0) return;

  const last = scenario.scenes[scenario.scenes.length - 1];
  const hasCtaPurpose = last.narrativePurpose === 'cta';
  const hasCtaTurn = last.turns.some((t) => t.intent === 'call_to_action');
  if (hasCtaPurpose && hasCtaTurn) return;

  if (!hasCtaPurpose) {
    last.narrativePurpose = 'cta';
    actions.push(`cta-purpose:${last.id}`);
  }
  if (!hasCtaTurn) {
    const speakerId =
      last.turns.length > 0 ? last.turns[last.turns.length - 1].speakerId : scenario.characters[0]?.id;
    if (!speakerId) return;
    if (!last.participantIds.includes(speakerId)) last.participantIds.push(speakerId);
    last.turns.push({
      id: `${last.id}-turn-cta-repair`,
      speakerId,
      spokenText: CTA_TURN_TEXT,
      intent: 'call_to_action',
      delivery: 'authoritative',
      pauseAfterSeconds: 0.6,
    });
    actions.push(`cta-turn:${last.id}`);
  }
}

/**
 * Justifies or breaks speaker runs longer than two consecutive turns.
 * Adds `monologueReason` only - spoken text is never rewritten.
 */
function repairSpeakerRuns(scenario: Scenario, actions: string[]): void {
  let runStart = -1;
  let lastSpeaker: string | null = null;

  const flush = (endIndexExclusive: number) => {
    if (runStart < 0 || !lastSpeaker) return;
    const runLength = endIndexExclusive - runStart;
    if (runLength <= 2) return;
    for (let i = runStart; i < endIndexExclusive; i++) {
      const scene = scenario.scenes[i];
      if (scene && !scene.turns.some((t) => t.speakerId === lastSpeaker && t.monologueReason)) {
        const target = scene.turns.find((t) => t.speakerId === lastSpeaker);
        if (target) {
          target.monologueReason = MONOLOGUE_REASON;
          actions.push(`monologue:${target.id}`);
        }
      }
    }
  };

  // Walk the flattened turn stream so runs spanning scene boundaries are caught.
  const flat: { sceneIndex: number; turnId: string; speakerId: string }[] = [];
  scenario.scenes.forEach((scene, sceneIndex) => {
    for (const turn of scene.turns) flat.push({ sceneIndex, turnId: turn.id, speakerId: turn.speakerId });
  });

  let idx = 0;
  while (idx < flat.length) {
    const current = flat[idx];
    if (current.speakerId === lastSpeaker) {
      idx++;
      continue;
    }
    flush(idx);
    lastSpeaker = current.speakerId;
    runStart = idx;
    idx++;
  }
  flush(flat.length);
}

/** Breaks shot-type repetition by rotating through the shot cycle. */
function repairRepeatedShots(scenario: Scenario, actions: string[]): void {
  let runShot: ShotType | '' = '';
  let runLength = 0;
  scenario.scenes.forEach((scene, index) => {
    const current = scene.production?.shotType || 'medium';
    if (current === runShot) {
      runLength++;
    } else {
      runShot = current;
      runLength = 1;
    }
    if (runLength >= 3) {
      const replacement = SHOT_CYCLE[index % SHOT_CYCLE.length];
      const next: ProductionDirection = {
        ...(scene.production as ProductionDirection),
        shotType: replacement === runShot ? SHOT_CYCLE[(index + 1) % SHOT_CYCLE.length] : replacement,
      };
      scene.production = next;
      scene.justifications = {
        ...(scene.justifications || {}),
        repeatedShot: 'Shot rotated to avoid mechanical repetition of an identical framing.',
      };
      actions.push(`shot:${scene.id}`);
      runShot = next.shotType;
      runLength = 1;
    }
  });
}

/** Justifies a setting held for more than four consecutive scenes. */
function repairRepeatedSettings(scenario: Scenario, actions: string[]): void {
  let runSetting = '';
  let runLength = 0;
  for (const scene of scenario.scenes) {
    if (scene.locationId === runSetting) {
      runLength++;
    } else {
      runSetting = scene.locationId;
      runLength = 1;
    }
    if (runLength > 4 && !scene.justifications?.repeatedSetting) {
      scene.justifications = {
        ...(scene.justifications || {}),
        repeatedSetting: 'Single continuous location held across consecutive narrative beats of one meeting.',
      };
      actions.push(`setting:${scene.id}`);
    }
  }
}

/** Re-asserts a non-cut transition on the final scene for a clean out. */
function repairFinalTransition(scenario: Scenario, actions: string[]): void {
  const last = scenario.scenes[scenario.scenes.length - 1];
  if (!last) return;
  const type: TransitionType = 'fade_black';
  if (last.transitionIntent?.type !== type) {
    last.transitionIntent = { type, durationSeconds: 0.6 };
    if (last.production) last.production.transitionIntent = { type, durationSeconds: 0.6 };
    actions.push(`transition:${last.id}`);
  }
}

/**
 * Drops the most expendable scenes until the estimate fits the ceiling.
 * Scenes carrying numeric facts are protected and never dropped, so this can
 * only ever remove structural scaffolding.
 */
function repairDurationCeiling(scenario: Scenario, ctx: ScenarioRepairContext, actions: string[]): void {
  const ceiling = ctx.hardDurationCeiling;
  if (!ceiling) return;

  const estimateSeconds = (): number => {
    let total = 0;
    for (const scene of scenario.scenes) total += estimateSceneDuration(scene, DEFAULT_DURATION_CONFIG).totalSeconds;
    return round2(total);
  };

  let guard = 0;
  while (estimateSeconds() > ceiling && guard < 50) {
    guard++;
    const protectedIds = ctx.protectedSceneIds || new Set<string>();
    const candidates = scenario.scenes
      .map((scene, index) => ({ scene, index }))
      .filter(({ scene }) => !protectedIds.has(scene.id))
      .filter(({ scene }) => scene.narrativePurpose !== 'cta' && scene.narrativePurpose !== 'hook');

    if (candidates.length === 0) break;

    let best = candidates[0];
    for (const candidate of candidates) {
      const bestRank = DROP_PRIORITY.indexOf(best.scene.narrativePurpose);
      const candidateRank = DROP_PRIORITY.indexOf(candidate.scene.narrativePurpose);
      if (candidateRank < bestRank) best = candidate;
    }

    scenario.scenes.splice(best.index, 1);
    actions.push(`drop-scene:${best.scene.id}`);
    repairSceneIndices(scenario, actions);
  }
}

/**
 * Applies the bounded, deterministic repair loop.
 * Mutates `scenario` in place and stops as soon as the scenario validates.
 */
export function repairScenarioInPlace(
  scenario: Scenario,
  ctx: ScenarioRepairContext,
  maxPasses = 4,
): ScenarioRepairOutcome {
  const actions: string[] = [];
  const passes = Math.max(1, Math.min(maxPasses, 8));

  for (let pass = 0; pass < passes; pass++) {
    const before = JSON.stringify(scenario);
    repairParticipantLinkage(scenario, actions);
    repairSceneIndices(scenario, actions);
    repairFinalCta(scenario, ctx, actions);
    repairSpeakerRuns(scenario, actions);
    repairRepeatedShots(scenario, actions);
    repairRepeatedSettings(scenario, actions);
    repairSceneDurations(scenario, actions);
    repairDurationCeiling(scenario, ctx, actions);
    repairFinalTransition(scenario, actions);
    repairSceneDurations(scenario, actions);

    const after = JSON.stringify(scenario);
    if (before === after) break;
    if (isScenarioValid(scenario)) break;
  }

  return { repaired: actions.length > 0, actions };
}
