/**
 * BuildTrack Video Factory - Workstream A
 * Production Scenario Generation Contract (public types only).
 *
 * This module closes the content-generation gap identified in SCENARIO_CONTRACT.md
 * section 5 ("How Phase 3B Will Generate This Contract"): the generator layer that
 * turns real user content (ProjectInput / user script) into canonical, validated
 * `Scenario` documents.
 *
 * Design rules enforced by the whole generation surface:
 *  - The output authority is the EXISTING Scenario contract (`./types.js`).
 *    No second, competing scenario model is introduced here.
 *  - Generation is fully deterministic and offline. No clock, no randomness,
 *    no environment-derived identifiers, no network or LLM dependency.
 *  - The user's script and explicit facts are the factual authority. Numeric
 *    facts are carried through verbatim and are never rounded or invented.
 *  - Every emitted Scenario is passed through `validateScenario()` and, when
 *    structurally defective, through a bounded deterministic repair step.
 *    A generator never falls back to a canned fixture.
 */

import type { Scenario } from './types.js';

/** Canonical keys for the (up to three) Short scenarios derived from one project. */
export type ShortScenarioKey = 'short_1' | 'short_2' | 'short_3';

/** Ordered list of every Short key the generator may emit. */
export const SHORT_SCENARIO_KEYS: readonly ShortScenarioKey[] = ['short_1', 'short_2', 'short_3'];

/** Maximum number of Short scenarios one project may request. */
export const MAX_SHORT_SCENARIOS = 3;

/** Structured failure codes. Never thrown as bare exceptions for bad user content. */
export type ScenarioGenerationFailureCode =
  /** The supplied source script is empty or contains no substantive content. */
  | 'EMPTY_SOURCE'
  /** A mandatory ProjectInput field is missing or blank. */
  | 'MISSING_REQUIRED_FIELD'
  /** The source cannot support the requested number of Shorts without inventing facts. */
  | 'INSUFFICIENT_SOURCE_CONTENT'
  /** The Long scenario could not be made valid after bounded repair. */
  | 'LONG_SCENARIO_INVALID'
  /** A Short scenario could not be made valid after bounded repair. */
  | 'SHORT_SCENARIO_INVALID'
  /** shortCount is outside the supported 0-3 range. */
  | 'SHORT_COUNT_OUT_OF_RANGE'
  /** Unexpected internal failure. */
  | 'GENERATION_ERROR';

/** Which artefact a finding or failure refers to. */
export type ScenarioGenerationTarget = 'input' | 'long' | ShortScenarioKey;

export interface ScenarioGenerationOptions {
  /**
   * Number of Short scenarios to produce (0-3).
   * Defaults to `ProjectInput.shortCount`, then to 0 when that is absent.
   */
  shortCount?: number;
  /** Override the derived projectId. Must be non-empty when supplied. */
  projectId?: string;
  /**
   * Target seconds for the Long scenario. When omitted the target is derived
   * from the actual source script length, never padded with invented narration.
   */
  longTargetSeconds?: number;
  /**
   * Target seconds for each Short. Clamped into the existing Short contract
   * window (<= 60s to stay clear of the 65s hard ceiling).
   */
  shortTargetSeconds?: number;
  /** Maximum bounded deterministic repair passes per scenario. Default 4. */
  maxRepairPasses?: number;
  /**
   * Explicit deterministic history/avoidance input for cross-video diversity
   * (Workstream D). When supplied, the generator deterministically prefers a
   * persona combination (challenger/technical_authority/decision_maker) that
   * was NOT used by the most recent entries. No randomness is involved: the
   * same project input + the same history always produce the same result, and
   * different recent history may deterministically choose another valid
   * persona combination.
   */
  personaHistory?: readonly ScenarioPersonaHistoryEntry[];
}

/** One deterministic persona-combination observation from production history. */
export interface ScenarioPersonaHistoryEntry {
  /** Persona keys used, keyed by narrative role. */
  personas: Partial<Record<'challenger' | 'technical_authority' | 'decision_maker', string>>;
  /** Deterministic style fingerprint of the prior video (optional). */
  styleFingerprint?: string;
}

export interface ScenarioGenerationFinding {
  severity: 'error' | 'warning' | 'info';
  /** Stable machine-readable code, e.g. `source.field_missing`. */
  code: string;
  target: ScenarioGenerationTarget;
  message: string;
  /** Rule id from `validateScenario()` when the finding mirrors a contract rule. */
  ruleId?: string;
}

export interface ScenarioGenerationFailure {
  code: ScenarioGenerationFailureCode;
  message: string;
  target: ScenarioGenerationTarget;
  /** Contract rule ids that remained violated after bounded repair. */
  ruleIds: string[];
}

/**
 * Stable result shape for the production content engine.
 *
 * `longScenario` is present whenever a valid Long scenario could be produced,
 * even when a later Short failed - this keeps partial results auditable.
 * `shortScenarios` contains only the Shorts that were actually produced.
 */
export interface ProductionScenarioGenerationResult {
  success: boolean;
  projectId: string;
  sourceVideoId: string;
  longScenario?: Scenario;
  shortScenarios: Partial<Record<ShortScenarioKey, Scenario>>;
  findings: ScenarioGenerationFinding[];
  failure?: ScenarioGenerationFailure;
}
