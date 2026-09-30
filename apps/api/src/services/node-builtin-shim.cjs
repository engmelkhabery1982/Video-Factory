/**
 * Phase 6B — inert Node builtin shim for the Remotion BROWSER bundle.
 *
 * Why this exists
 * ---------------
 * `@buildtrack/core` is both the browser-facing plan contract AND the Node
 * library that owns the Phase 4 audio tooling and the scenario fixtures. Its
 * modules therefore contain `node:fs` / `node:path` / `node:url` /
 * `node:module` / `node:child_process` imports, and three of them touch those
 * APIs at MODULE EVALUATION time:
 *
 *   - scenario/fixtures/index.ts       fileURLToPath(import.meta.url)
 *                                       path.dirname(...)
 *   - scenario/audio-normalizer.ts     createRequire(import.meta.url)
 *   - scenario/local-dialogue-synthesizer.ts
 *                                      createRequire(import.meta.url)
 *
 * The Remotion bundle is compiled for Chromium, which has none of these. The
 * renderer itself never calls into any of that code (the plan carries resolved
 * paths/URLs, not filesystem work), but the module bodies still have to
 * evaluate. This shim provides inert equivalents so evaluation succeeds and
 * the browser bundle builds.
 *
 * It is ONLY wired in through `resolve.fallback` for the Remotion bundle. Node
 * execution - the API, the tests, the pipeline - keeps the real builtins and is
 * completely unaffected.
 */

const noop = () => undefined;
const emptyRecord = {};
const identityString = (value) => (value === undefined || value === null ? '' : String(value));

module.exports = {
  // ── node:url ───────────────────────────────────────────────────────
  fileURLToPath: () => '',
  pathToFileURL: (p) => ({ href: identityString(p), pathname: identityString(p) }),
  URL: URL,
  URLSearchParams: URLSearchParams,

  // ── node:path ──────────────────────────────────────────────────────
  dirname: () => '.',
  basename: (p) => String(p ?? '').split('/').pop() ?? '',
  extname: () => '',
  join: (...parts) => parts.filter(Boolean).join('/'),
  resolve: (...parts) => parts.filter(Boolean).join('/'),
  relative: () => '',
  isAbsolute: () => false,
  normalize: identityString,
  sep: '/',
  posix: emptyRecord,
  win32: emptyRecord,

  // ── node:module ────────────────────────────────────────────────────
  // `createRequire(...)` is only ever invoked to build a `require` that is
  // called from inside Node-only functions, so an empty resolver is enough.
  createRequire: () => () => emptyRecord,

  // ── node:fs / node:fs/promises ─────────────────────────────────────
  existsSync: () => false,
  readFileSync: () => '',
  writeFileSync: noop,
  mkdirSync: noop,
  statSync: () => ({ size: 0, isFile: () => false, isDirectory: () => false }),
  readdirSync: () => [],
  rmSync: noop,
  copyFileSync: noop,
  createReadStream: () => emptyRecord,
  createWriteStream: () => emptyRecord,
  promises: {
    readFile: async () => '',
    writeFile: async () => undefined,
    mkdir: async () => undefined,
    stat: async () => ({ size: 0 }),
  },

  // ── node:child_process ─────────────────────────────────────────────
  execFileSync: () => '',
  spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
  execSync: () => '',

  // ── misc ───────────────────────────────────────────────────────────
  homedir: () => '',
  tmpdir: () => '',
  platform: () => 'browser',
  cwd: () => '/',
  default: undefined,
};
