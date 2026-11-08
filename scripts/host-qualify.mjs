#!/usr/bin/env node
/**
 * Owner-host qualification entry point (CLOSEOUT06).
 *
 * One command that does the checks this environment could not: rebuild core before
 * API typechecking, typecheck API and web separately, build the web application,
 * run the affected automated groups, and record every exit code.
 *
 * Guarantees:
 *   - Node built-ins only; it installs and downloads nothing.
 *   - Isolated disposable data/output roots under the system temp dir. The repo
 *     `data/`, `output/`, `.production/` and any owner configuration are never read
 *     for writes and never modified.
 *   - Every step's exit code and duration is recorded in a JSON report.
 *   - Automated verification is kept separate from consent, listening and visual
 *     review: those are printed as OWNER-ONLY steps that this script never performs.
 *   - It promotes nothing: no branch is advanced, no release is approved.
 *
 * Usage:
 *   node scripts/host-qualify.mjs                # run everything that is installed
 *   node scripts/host-qualify.mjs --skip-browser # skip the real-browser group
 *   node scripts/host-qualify.mjs --json <path>  # write the report somewhere else
 *
 * Exit codes: 0 all executed steps passed; 1 a step failed; 2 the environment lacks
 * a required tool (the report then lists exactly which step could not run).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const skipBrowser = argv.includes('--skip-browser');
const jsonFlag = argv.indexOf('--json');
const reportPath = jsonFlag >= 0 && argv[jsonFlag + 1] ? path.resolve(argv[jsonFlag + 1]) : null;

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  source: {},
  steps: [],
  ownerOnly: [],
  promotion: 'none: this script never advances a branch or approves a release',
};

/* ---------------------------------------------------------------- */
/* Source revision                                                   */
/* ---------------------------------------------------------------- */
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

report.source.branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
report.source.tip = git(['rev-parse', 'HEAD']);
report.source.parent = git(['rev-parse', 'HEAD^']);
report.source.dirty = (git(['status', '--porcelain']) ?? '') !== '';
report.source.remote = git(['config', '--get', 'remote.origin.url']);

const EXPECTED_BRANCH = process.env.HOST_QUALIFY_EXPECT_BRANCH ?? 'arena/88809335-video-factory';
report.source.expectedBranch = EXPECTED_BRANCH;
report.source.branchMatches = report.source.branch === EXPECTED_BRANCH;

function step(name, command, args, opts = {}) {
  const started = Date.now();
  process.stdout.write(`\n=== ${name}\n    ${command} ${args.join(' ')}\n`);
  const r = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.capture === false ? 'inherit' : 'pipe',
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 30 * 60 * 1000,
  });
  const out = opts.capture === false ? '' : `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const record = {
    name,
    command: `${command} ${args.join(' ')}`,
    exitCode: r.status,
    ok: r.status === 0,
    ms: Date.now() - started,
    tail: out.slice(-4000),
  };
  report.steps.push(record);
  if (out) process.stdout.write(out.slice(-2000));
  process.stdout.write(`--- ${record.ok ? 'PASS' : `FAIL (exit ${r.status})`} in ${record.ms}ms\n`);
  return record;
}

/* ---------------------------------------------------------------- */
/* Isolated, disposable storage                                      */
/* ---------------------------------------------------------------- */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-host-qualify-'));
const dataDir = path.join(sandbox, 'data');
const outputDir = path.join(sandbox, 'output');
for (const d of [dataDir, outputDir]) fs.mkdirSync(d, { recursive: true });
const repoData = path.join(ROOT, 'data');
const repoOutput = path.join(ROOT, 'output');
for (const d of [dataDir, outputDir]) {
  const resolved = path.resolve(d);
  if (resolved === path.resolve(repoData) || resolved === path.resolve(repoOutput)) {
    console.error(`Refusing to run: isolated root resolved onto the repository tree (${resolved}).`);
    process.exit(2);
  }
}
report.isolation = { sandbox, dataDir, outputDir, note: 'disposable; safe to delete after the run' };
const isolatedEnv = { BUILDTRAKE_DATA: dataDir, BUILDTRAKE_OUTPUT: outputDir };

process.stdout.write(`\nHost qualification for ${report.source.branch} @ ${String(report.source.tip).slice(0, 12)}\n`);
process.stdout.write(`Isolated data:   ${dataDir}\nIsolated output: ${outputDir}\n`);
if (!report.source.branchMatches) {
  process.stdout.write(`\nWARNING: this is not ${EXPECTED_BRANCH}. The run continues but the result is not the session branch.\n`);
}
if (report.source.dirty) {
  process.stdout.write('\nWARNING: the working tree has uncommitted changes; the recorded tip is not the exact inspected source.\n');
}

/* ---------------------------------------------------------------- */
/* Tool availability — never install                                 */
/* ---------------------------------------------------------------- */
const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const hasNodeModules = fs.existsSync(path.join(ROOT, 'node_modules'));
const tools = {
  npm: spawnSync(npmCmd, ['--version'], { encoding: 'utf8' }).status === 0,
  nodeModules: hasNodeModules,
  ffmpeg: has('ffmpeg'),
  ffprobe: has('ffprobe'),
};
report.tools = tools;
process.stdout.write(`\nTools: npm=${tools.npm} node_modules=${tools.nodeModules} ffmpeg=${tools.ffmpeg} ffprobe=${tools.ffprobe}\n`);

if (!tools.npm) {
  console.error('\nBLOCKED: npm is not on PATH. Install Node 20+ and re-run. Nothing was changed.');
  finish(2);
}

if (!tools.nodeModules) {
  process.stdout.write('\nBLOCKED: node_modules is absent, so builds/typechecks/tests cannot run here.\n');
  process.stdout.write('Install the existing dependencies with your normal command (this script never installs):\n');
  process.stdout.write('    npm ci\nThen re-run: npm run qualify:host\n');
  report.steps.push({ name: 'dependency check', command: 'npm ci (not run)', exitCode: null, ok: false, ms: 0, tail: 'node_modules absent' });
  finish(2);
}

/* ---------------------------------------------------------------- */
/* 1. Core rebuild must succeed BEFORE the API typecheck             */
/* ---------------------------------------------------------------- */
const coreBuild = step('1/7 build core (required before API typecheck)', npmCmd, ['run', 'build:core']);
if (!coreBuild.ok) {
  process.stdout.write('\nCore did not build. The API typecheck and every dependent step are skipped, because they would report misleading errors.\n');
  finish(1);
}

/* ---------------------------------------------------------------- */
/* 2. Typechecks, separately                                         */
/* ---------------------------------------------------------------- */
step('2/7 typecheck packages/core', 'npx', ['tsc', '-p', 'packages/core/tsconfig.json', '--noEmit']);
step('3/7 typecheck apps/api', 'npx', ['tsc', '-p', 'apps/api/tsconfig.json', '--noEmit']);
step('4/7 typecheck apps/web', 'npx', ['tsc', '--noEmit', '-p', 'apps/web/tsconfig.json']);

/* ---------------------------------------------------------------- */
/* 5. Web build                                                      */
/* ---------------------------------------------------------------- */
step('5/7 build web application', npmCmd, ['run', 'build:web']);

/* ---------------------------------------------------------------- */
/* 6. Affected automated groups                                      */
/* ---------------------------------------------------------------- */
const pureFiles = [
  'tests/capture-state-machine.test.mjs',
  'tests/factory-data-recovery.test.mjs',
  'tests/factory-masked-correction-pure.test.mjs',
  'tests/factory-technique-media-need.test.mjs',
  'tests/masked-correction-sd-cli-contract.test.mjs',
  'tests/masked-correction-ui-pure.test.mjs',
];
step('6a/7 PURE contracts (dependency-free)', process.execPath, [
  '--experimental-transform-types',
  '--import', './tools/lib/ts-source-loader.mjs',
  '--test', ...pureFiles,
], { env: isolatedEnv });

const vitestGroups = [
  ['G7 masked correction (HTTP/store + fake CLI)', ['tests/factory-masked-correction.test.ts']],
  ['G10 capture component', ['tests/web/capture-panel.test.tsx']],
  ['G7 masked panel component', ['tests/web/masked-correction-panel.test.tsx']],
  ['local image / freshness / visual review', ['tests/local-image.test.ts', 'tests/factory-visual-language.test.ts', 'tests/web/picture-analysis.test.tsx']],
  ['canonical journey + input routes + families', ['tests/factory-binding.test.ts', 'tests/factory-treatments.test.ts', 'tests/factory-api.test.ts']],
];
for (const [label, files] of vitestGroups) {
  const existing = files.filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (!existing.length) {
    report.steps.push({ name: label, command: 'npx vitest run (skipped)', exitCode: null, ok: false, ms: 0, tail: 'no test files present' });
    continue;
  }
  step(`6/7 ${label}`, 'npx', ['vitest', 'run', ...existing], { env: isolatedEnv });
}

/* ---------------------------------------------------------------- */
/* 7. Real browser (opt-in; needs a provisioned Chromium)            */
/* ---------------------------------------------------------------- */
if (skipBrowser) {
  report.steps.push({ name: 'real browser group', command: 'skipped by --skip-browser', exitCode: null, ok: false, ms: 0, tail: 'explicitly skipped: not a pass' });
} else {
  const browserTest = 'tests/external-audio-seek-browser.test.ts';
  if (fs.existsSync(path.join(ROOT, browserTest))) {
    step('7/7 real browser group', 'npx', ['vitest', 'run', browserTest], { env: isolatedEnv });
  } else {
    report.steps.push({ name: 'real browser group', command: 'npx vitest run (not present)', exitCode: null, ok: false, ms: 0, tail: `${browserTest} is not in this tree` });
  }
}

/* ---------------------------------------------------------------- */
/* Owner-only steps: never automated here                            */
/* ---------------------------------------------------------------- */
report.ownerOnly = [
  'Listening review of any generated or supplied narration (the machine cannot accept audio quality).',
  'Visual review of rendered frames and of every visual family output.',
  'Explicit consent before any screen or microphone capture; this script never captures.',
  'Authorizing and configuring a real inpainting runtime/model before G7 can be qualified.',
  'Deciding whether generated video / 3D / talking-character engines are in scope, then provisioning them.',
  'Approving or promoting a release. This script promotes nothing.',
];

process.stdout.write('\nOWNER-ONLY (never performed by this script):\n');
for (const item of report.ownerOnly) process.stdout.write(`  - ${item}\n`);

/* ---------------------------------------------------------------- */
/* Report                                                            */
/* ---------------------------------------------------------------- */
function finish(code) {
  const executed = report.steps.filter((s) => s.exitCode !== null);
  const failed = report.steps.filter((s) => s.exitCode !== null && s.exitCode !== 0);
  const skipped = report.steps.filter((s) => s.exitCode === null);
  report.summary = {
    executed: executed.length,
    passed: executed.filter((s) => s.ok).length,
    failed: failed.length,
    notRun: skipped.length,
    exitCode: code,
  };
  const target = reportPath ?? path.join(sandbox, 'host-qualification.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2));
  process.stdout.write(`\nExecuted ${report.summary.executed}: ${report.summary.passed} passed, ${failed.length} failed, ${skipped.length} not run.\n`);
  if (failed.length) {
    process.stdout.write('Failed steps:\n');
    for (const f of failed) process.stdout.write(`  - ${f.name} (exit ${f.exitCode})\n`);
  }
  if (skipped.length) {
    process.stdout.write('Not run (NOT passes):\n');
    for (const s of skipped) process.stdout.write(`  - ${s.name}: ${s.tail}\n`);
  }
  process.stdout.write(`\nReport: ${target}\n`);
  process.stdout.write(`Isolated storage left at ${sandbox} (delete it when finished; it is disposable).\n`);
  process.stdout.write('\nThis report is automated verification only. Visual/audio quality, consent and release approval remain owner decisions.\n');
  process.exit(code);
}
