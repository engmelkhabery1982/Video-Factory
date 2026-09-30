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
export * from './audio-synthesis-types.js';
export * from './audio-synthesizer.js';
export * from './local-dialogue-synthesizer.js';
export * from './synthesize-dialogue.js';
export * from './audio-validation-types.js';
export * from './audio-probe.js';
export * from './audio-normalizer.js';
export * from './canonical-dialogue-audio.js';
export * from './timing-reconciliation-types.js';
export * from './reconcile-dialogue-timing.js';
export * from './reconcile-playback.js';
export * from './reconcile-captions.js';
export * from './reconcile-timing.js';
export * from './dialogue-production-types.js';
export * from './dialogue-production-validation.js';
export * from './dialogue-production-pipeline.js';
export * from './visual-production-types.js';
export * from './visual-production-pipeline.js';
export * from './scene-render-types.js';
export * from './scene-render-pipeline.js';
export * from './remotion-composition-types.js';
export * from './remotion-composition-pipeline.js';
export * from './audiovisual-sync-types.js';
export * from './audiovisual-sync-pipeline.js';
export * from './phase5-closure-types.js';
export * from './phase5-closure-pipeline.js';
export * from './production-asset-types.js';
export * from './production-asset-resolution.js';
