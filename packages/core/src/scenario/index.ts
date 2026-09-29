/**
 * BuildTrack Video Factory - Phase 3A Scenario Engine
 *
 * Canonical scenario data contract, deterministic validator, duration estimator,
 * anti-repetition diversity analyzer, and realistic fixtures.
 */

export * from './types.js';
export * from './duration.js';
export * from './diversity.js';
export * from './validate.js';
export * from './fixtures/index.js';
export * from './visual-plan-types.js';
export * from './compile-visual-plan.js';
export * from './validate-visual-plan.js';
export * from './dialogue-audio-types.js';
export * from './plan-dialogue-audio.js';
export * from './validate-dialogue-audio-plan.js';
export * from './scenario-playback-types.js';
export * from './compile-scenario-playback.js';
export { validateScenarioPlaybackPlan, resolvePlaybackDurationConfig } from './validate-scenario-playback.js';
export * from './scenario-caption-types.js';
export * from './compile-scenario-captions.js';
export * from './validate-scenario-captions.js';
export * from './voice-types.js';
export * from './voice-registry.js';
export * from './voice-resolver.js';
