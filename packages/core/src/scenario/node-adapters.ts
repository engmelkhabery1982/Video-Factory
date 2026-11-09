/**
 * Node-only adapter entry point (`@buildtrack/core/node`).
 *
 * The main barrel (`@buildtrack/core`) is imported BY VALUE from code that is
 * bundled for the browser (Remotion compositions). The concrete synthesizer
 * adapters are Node-only: they import `node:fs`, `node:child_process` and, in
 * the Kokoro adapter's case, call `createRequire(import.meta.url)` at module
 * scope. Exposing them on a separate subpath keeps the main barrel safe for
 * browser bundling while still giving the Node API a single documented,
 * test-covered way to construct a real engine.
 *
 * This subpath adds no behaviour: it re-exports exactly the shipped adapters.
 */

export * from './kokoro-dialogue-synthesizer.js';
export * from './chatterbox-dialogue-synthesizer.js';
export * from './chatterbox-path-safety.js';
export * from './local-dialogue-synthesizer.js';
export * from './audio-normalizer.js';
export * from './audio-probe.js';
