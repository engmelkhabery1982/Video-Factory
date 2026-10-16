/**
 * Browser-safe entry point for the visual-language registry and the procedural graphic schema.
 *
 * Exports ONLY pure modules: no Node built-ins, no filesystem, no child processes, no scenario or voice code.
 * The web app imports from '@buildtrack/core/visual' so the browser bundle never pulls the root index,
 * which re-exports Node-only scenario modules. Keep this file limited to pure, dependency-free modules.
 */
export * from './visual-language.js';
export * from './editor/graphics.js';
export * from './editor/graphic-builders.js';
