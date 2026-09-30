/**
 * BuildTrack Video Factory - Workstream A
 * ScenarioGenerator adapter contract.
 *
 * SCENARIO_CONTRACT.md section 5 promised a generator layer:
 *
 *   Project / Topic / Script
 *        |
 *        v
 *   Scenario Generator            <-- this interface
 *        |
 *        v
 *   Scenario validation / deterministic repair
 *        |
 *        v
 *   Long Scenario + requested Short Scenarios
 *
 * This module defines the adapter boundary only. The single usable
 * implementation shipped today is the local, offline, deterministic
 * `ScriptScenarioGenerator` in `./script-scenario-generator.ts`.
 *
 * The interface deliberately does NOT describe where content comes from, so a
 * future LLM-backed or template-backed generator can be dropped in without
 * changing any caller. Every implementation must honour the same guarantees:
 *  - deterministic for identical input,
 *  - no fixture fallback,
 *  - output is always the existing `Scenario` contract,
 *  - every emitted scenario passes `validateScenario()` or the call fails
 *    with a structured result rather than emitting an invalid scenario.
 */

import type { ProjectInput } from '../types.js';
import type {
  ProductionScenarioGenerationResult,
  ScenarioGenerationOptions,
} from './scenario-generation-types.js';

/** A single generation request. */
export interface ScenarioGenerationRequest {
  /** The user's project input. Never mutated by the generator. */
  input: ProjectInput;
  options?: ScenarioGenerationOptions;
}

/** Adapter boundary for any future scenario generator. */
export interface ScenarioGenerator {
  /** Stable identifier of the implementation. */
  readonly id: string;
  /** True when identical input always yields byte-equivalent logical output. */
  readonly deterministic: boolean;
  generate(request: ScenarioGenerationRequest): ProductionScenarioGenerationResult;
}

/** Identifier of the shipped local deterministic implementation. */
export const LOCAL_SCRIPT_SCENARIO_GENERATOR_ID = 'local-deterministic-script-v1';

/**
 * Minimal generator registry.
 *
 * Lets a host application register additional generators (for example an
 * LLM-backed one) and select a default, without touching call sites.
 */
export class ScenarioGeneratorRegistry {
  private readonly generators = new Map<string, ScenarioGenerator>();
  private defaultId: string | null = null;

  register(generator: ScenarioGenerator): void {
    if (!generator || typeof generator.generate !== 'function') {
      throw new Error('ScenarioGenerator must implement generate().');
    }
    this.generators.set(generator.id, generator);
    if (this.defaultId === null) this.defaultId = generator.id;
  }

  get(id: string): ScenarioGenerator | undefined {
    return this.generators.get(id);
  }

  setDefault(id: string): void {
    if (!this.generators.has(id)) {
      throw new Error(`No ScenarioGenerator registered with id '${id}'.`);
    }
    this.defaultId = id;
  }

  /** The registered default, or undefined when nothing is registered. */
  get default(): ScenarioGenerator | undefined {
    if (this.defaultId === null) return undefined;
    return this.generators.get(this.defaultId) || undefined;
  }

  list(): ScenarioGenerator[] {
    return Array.from(this.generators.values());
  }
}
