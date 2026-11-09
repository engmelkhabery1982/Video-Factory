/**
 * CLOSEOUT07 path-strategy and job-settlement qualification (dependency-free).
 *
 * This is the same evidence the vitest file
 * (`tests/editor-render-paths.test.ts`) produces, expressed with `node:test` so it
 * can run on a host or sandbox without node_modules.
 *
 * HONESTY NOTES — read before quoting results:
 *   - The path strategy, ownership and cleanup cases use the REAL module and real
 *     directories.
 *   - The settlement cases drive the REAL job lifecycle (`createExportJob`,
 *     `enqueuePreview`, `loadExportJob`, the persisted record) and substitute only
 *     `renderEditorPreview` with a controlled delayed stand-in, because Remotion +
 *     Chromium are not available. That proves WHEN `finishedAt` is assigned; it
 *     proves nothing about real render duration or output quality.
 *   - No case here proves the installed Windows FFmpeg accepts these paths. That
 *     needs the real binary: see the NOT RUN line printed at the end.
 *
 * Run: node --experimental-transform-types --import ./tools/lib/ts-source-loader.mjs \
 *        --test scripts/qualify-render-paths.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ */
/* Isolated storage + a delayed render stand-in for the job lifecycle */
/* ------------------------------------------------------------------ */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-render-paths-'));
process.env.BUILDTRAKE_DATA = path.join(ROOT, 'data');
process.env.BUILDTRAKE_OUTPUT = path.join(ROOT, 'output');
fs.mkdirSync(process.env.BUILDTRAKE_DATA, { recursive: true });
fs.mkdirSync(process.env.BUILDTRAKE_OUTPUT, { recursive: true });
process.env.VF_PREVIEW_DISABLE = '1';

const stub = { delayMs: 0, failMarker: null, workDir: '' };
globalThis.__vfRenderStub = stub;

const EDITOR_RENDER_FILE = path.resolve('apps/api/src/services/editor-render.ts');

// A shadow module for the ONE export editor-preview uses as a value. It cannot
// re-export the real module: that module imports @remotion/renderer, which is not
// installed in this environment. Types are elided, so nothing else is needed.
const stubFile = path.join(ROOT, 'editor-render-stub.mjs');
fs.writeFileSync(stubFile, `
export async function renderEditorPreview(input) {
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  const s = globalThis.__vfRenderStub;
  s.workDir = input.workDir;
  await new Promise((resolve) => setTimeout(resolve, s.delayMs));
  if (s.failMarker) throw new Error(s.failMarker);
  fs2.mkdirSync(path2.dirname(input.outputFile), { recursive: true });
  fs2.writeFileSync(input.outputFile, 'delayed-render-stand-in');
  return {
    revision: input.doc.revision, startFrame: 0, endFrameExclusive: 360,
    expectedDurationSec: 12, probedDurationSec: 12, width: 1080, height: 1920,
    hasVideo: true, hasAudio: false, hasNarration: false, audioClips: 0, audioSources: 0,
    format: 'portrait', compositionId: 'ShortVideo', compositionWidth: 1080,
    compositionHeight: 1920, channelBrandId: null,
  };
}
`, 'utf8');
const STUB_URL = pathToFileURL(stubFile).href;
const RENDER_URL = pathToFileURL(EDITOR_RENDER_FILE).href;

// Redirect the renderer module (and only it) to the controlled stand-in.
registerHooks({
  load(url, context, nextLoad) {
    if (url === RENDER_URL) {
      return { format: 'module', source: `export * from ${JSON.stringify(STUB_URL)};`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const paths = await import('../apps/api/src/services/editor-render-paths.ts');
const preview = await import('../apps/api/src/services/editor-preview.ts');

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const W = path.win32;
const FINAL_JOB = 'exp_6ac267eb71ccf166';
const OWNER_QA_ROOT =
  'C:\\Users\\Owner\\AppData\\Roaming\\VideoFactory\\data-synthetic-qa-2026-11-08\\projects\\Factory_2451683d6e07\\editor';
const ownerRawPath = (pad) =>
  W.join(OWNER_QA_ROOT, `export-work${'x'.repeat(Math.max(0, pad))}`, FINAL_JOB, 'raw-frames.mp4');

/* ------------------------------------------------------------------ */
/* 1. The reproduced Windows long path                                */
/* ------------------------------------------------------------------ */
test('reproduces the 262-character raw-frames path the packaged ffmpeg refused', () => {
  let padded = ownerRawPath(0);
  for (let pad = 0; pad < 400 && padded.length < 262; pad += 1) padded = ownerRawPath(pad);
  assert.ok(padded.endsWith('raw-frames.mp4'));
  assert.ok(padded.length >= 262, `expected >= 262, got ${padded.length}`);
  assert.equal(paths.fitsBudget(padded, 'win32'), false, 'a 262-character path must be rejected');
});

test('accepts exactly the budget and rejects one character more', () => {
  const reproduced = ownerRawPath(0);
  assert.ok(reproduced.length < paths.WINDOWS_MAX_PATH, 'the base owner root shape is under the budget');
  assert.equal(paths.fitsBudget(reproduced, 'win32'), true);
  // Slide the padding to land exactly on the limit, then one past it.
  let atLimit = ownerRawPath(0);
  for (let pad = 0; pad < 400 && atLimit.length < paths.WINDOWS_MAX_PATH; pad += 1) atLimit = ownerRawPath(pad);
  assert.equal(atLimit.length, paths.WINDOWS_MAX_PATH, 'the boundary case is exactly the documented limit');
  assert.equal(paths.fitsBudget(atLimit, 'win32'), true, 'exactly at the limit is accepted');
  // Use the win32 flavour: the host's path.dirname would treat the string as POSIX.
  const over = W.join(W.dirname(atLimit), `x${W.basename(atLimit)}`);
  assert.equal(over.length, paths.WINDOWS_MAX_PATH + 1);
  assert.equal(paths.fitsBudget(over, 'win32'), false, 'one character over is refused');
});

test('relocates only the intermediate raw render, never the canonical final file', () => {
  const finalOutput = W.join(OWNER_QA_ROOT, 'exports', `${FINAL_JOB}.mp4`);
  const choice = paths.chooseScratchRoot({
    candidate: 'C:\\Users\\Owner\\AppData\\Roaming\\VideoFactory\\data\\editor-render-scratch',
    name: paths.newScratchName('exp'),
    outputFile: finalOutput,
    platform: 'win32',
    tmpdir: 'C:\\Users\\Owner\\AppData\\Local\\Temp',
  });
  assert.ok(choice.root, 'a usable scratch root must be found');
  const raw = W.join(choice.root, 'raw-frames.mp4');
  assert.equal(paths.fitsBudget(raw, 'win32'), true);
  assert.ok(raw.length < paths.WINDOWS_MAX_PATH);
  // Canonical identity unchanged: same job id, same exports folder, same name.
  assert.equal(finalOutput, W.join(OWNER_QA_ROOT, 'exports', `${FINAL_JOB}.mp4`));
});

test('prefers the app data tree when it is already short enough', () => {
  const choice = paths.chooseScratchRoot({
    candidate: 'C:\\vf\\scratch',
    name: 'exp-0123456789abcdef0123456789abcdef',
    outputFile: 'C:\\vf\\projects\\p\\editor\\exports\\exp_0123456789abcdef.mp4',
    platform: 'win32',
    tmpdir: 'C:\\Temp',
  });
  assert.equal(choice.source, 'explicit');
  assert.equal(choice.sameVolumeAsOutput, true);
  assert.equal(choice.root, 'C:\\vf\\scratch\\exp-0123456789abcdef0123456789abcdef');
});

test('reports no root when every option is too long, instead of rendering', () => {
  const deep = W.join('C:\\', 'deep'.repeat(80));
  const choice = paths.chooseScratchRoot({
    candidate: W.join(deep, 'editor-render-scratch'),
    name: 'exp-0123456789abcdef0123456789abcdef',
    outputFile: W.join(deep, 'out.mp4'),
    platform: 'win32',
    tmpdir: W.join(deep, 'temp'),
  });
  assert.equal(choice.root, null);
  assert.match(choice.reason, /longer than/i);
});

/* ------------------------------------------------------------------ */
/* 2. POSIX is not broken                                             */
/* ------------------------------------------------------------------ */
test('posix limits still behave', () => {
  assert.equal(paths.fitsBudget('/tmp/vf-job/raw-frames.mp4', 'linux'), true);
  assert.ok(paths.POSIX_MAX_PATH > 1000);
  assert.equal(paths.fitsBudget(`/${'a'.repeat(paths.POSIX_MAX_PATH + 10)}`, 'linux'), false);
  assert.equal(paths.fitsBudget(`/tmp/${'b'.repeat(300)}/raw-frames.mp4`, 'linux'), false);
});

/* ------------------------------------------------------------------ */
/* 3. Ownership and cleanup                                           */
/* ------------------------------------------------------------------ */
const scratchRoot = path.join(ROOT, 'scratch-root');

test('creates a unique marked directory and removes only that directory', () => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  fs.mkdirSync(scratchRoot, { recursive: true });
  const name = paths.newScratchName('exp');
  const scratch = paths.openEditorRenderScratch({ name, outputFile: path.join(ROOT, 'out.mp4'), candidate: scratchRoot });
  assert.ok(scratch, 'scratch must be created');
  const marker = JSON.parse(fs.readFileSync(path.join(scratch.dir, paths.SCRATCH_MARKER), 'utf8'));
  assert.equal(marker.kind, paths.SCRATCH_KIND);
  assert.equal(marker.name, name);
  const sentinel = path.join(scratchRoot, 'owner-sentinel.txt');
  fs.writeFileSync(sentinel, 'keep me');
  paths.cleanupEditorRenderScratch(scratchRoot, name);
  assert.equal(fs.existsSync(scratch.dir), false, 'the owned run must be removed');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep me', 'an unowned sibling must survive');
  assert.equal(fs.existsSync(scratchRoot), true, 'the root itself must survive');
});

test('refuses to delete a directory with no marker', () => {
  const name = paths.newScratchName('exp');
  const dir = path.join(scratchRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'unowned.txt'), 'not ours');
  paths.cleanupEditorRenderScratch(scratchRoot, name);
  assert.equal(fs.existsSync(path.join(dir, 'unowned.txt')), true);
});

test('refuses a malformed or mismatched marker', () => {
  const name = paths.newScratchName('edt');
  const dir = path.join(scratchRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, paths.SCRATCH_MARKER), '{"kind":"other","name":"x"}');
  fs.writeFileSync(path.join(dir, 'payload.txt'), 'survives');
  paths.cleanupEditorRenderScratch(scratchRoot, name);
  assert.equal(fs.existsSync(path.join(dir, 'payload.txt')), true);
});

test('rejects an unrecognised directory name', () => {
  assert.throws(() => paths.openEditorRenderScratch({ name: '../escape', outputFile: path.join(ROOT, 'o.mp4'), candidate: scratchRoot }), /unrecognised/i);
  assert.throws(() => paths.openEditorRenderScratch({ name: 'exp_short', outputFile: path.join(ROOT, 'o.mp4'), candidate: scratchRoot }), /unrecognised/i);
});

test('refuses a linked scratch root instead of deleting through it', (t) => {
  const real = path.join(ROOT, 'real-target');
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(ROOT, 'linked-root');
  try {
    fs.symlinkSync(real, link, 'dir');
  } catch (err) {
    // A filesystem that forbids symlinks is a SKIP, never a pass.
    t.skip(`symlink not permitted here (${err.code}); Windows junction check is owner-host work`);
    return;
  }
  assert.equal(paths.isUnlinkedPath(link), false);
  const result = paths.openEditorRenderScratch({ name: paths.newScratchName('exp'), outputFile: path.join(ROOT, 'o.mp4'), candidate: link });
  assert.equal(result, null);
  assert.equal(fs.readdirSync(real).length, 0);
});

test('binary guard rejects an unreachable path with a precise reason', () => {
  assert.throws(() => paths.assertBinaryReachablePath(path.join(ROOT, 'absent.mp4'), 'The raw render', 'linux'), /does not exist/);
  let long = ownerRawPath(0);
  for (let pad = 0; pad < 400 && long.length < 262; pad += 1) long = ownerRawPath(pad);
  assert.throws(() => paths.assertBinaryReachablePath(long, 'The raw render', 'win32'), /beyond the/i);
});

/* ------------------------------------------------------------------ */
/* 4. Settlement timestamp through the real job lifecycle             */
/* ------------------------------------------------------------------ */
function writeFrozen(videoId, revision) {
  const file = path.join(process.env.BUILDTRAKE_DATA, 'projects', videoId, 'editor', 'frozen', `long-r${revision}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ revision, durationSec: 12, assets: [], visualClips: [], audioClips: [] }));
  return file;
}
const fakeProject = { meta: { input: { cta: '' } } };
const fakeDoc = (revision) => ({ revision, durationSec: 12, assets: [], visualClips: [], audioClips: [] });

async function waitForSettled(loader, videoId, jobId) {
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    const now = loader(videoId, jobId);
    if (now && now.status !== 'running') return now;
  }
  return null;
}

test('finishedAt is stamped at settlement, not at enqueue', async () => {
  stub.delayMs = 120;
  stub.failMarker = null;
  const videoId = 'Factory_pathfix_A';
  const job = preview.createExportJob({
    videoId, targetId: 'long', doc: fakeDoc(3), frozenFile: writeFrozen(videoId, 3), audioFiles: {},
  });
  const enqueuedAt = Date.now();
  preview.enqueuePreview(videoId, job, fakeProject, 'http://127.0.0.1:3000');

  const running = preview.loadExportJob(videoId, job.jobId);
  assert.equal(running.status, 'running');
  assert.equal(running.finishedAt, null, 'a running job must not carry a completion time');

  const record = await waitForSettled(preview.loadExportJob, videoId, job.jobId);
  assert.ok(record, 'the job never settled');
  assert.equal(record.status, 'ready');
  assert.equal(record.createdAt, job.createdAt, 'createdAt must be preserved');
  const offset = Date.parse(record.finishedAt) - Date.parse(record.createdAt);
  assert.ok(offset >= 100, `completion must follow the delayed render (got ${offset}ms)`);
  assert.ok(Date.parse(record.finishedAt) >= enqueuedAt);
  assert.equal(record.revision, 3, 'revision must be preserved');
  assert.equal(record.mediaUrl, `/api/projects/${videoId}/editor/export/${job.jobId}/media`, 'media URL must be preserved');
});

test('finishedAt is stamped on failure too', async () => {
  stub.delayMs = 60;
  stub.failMarker = 'controlled render failure';
  const videoId = 'Factory_pathfix_B';
  const job = preview.createExportJob({
    videoId, targetId: 'long', doc: fakeDoc(2), frozenFile: writeFrozen(videoId, 2), audioFiles: {},
  });
  preview.enqueuePreview(videoId, job, fakeProject, 'http://127.0.0.1:3000');
  const record = await waitForSettled(preview.loadExportJob, videoId, job.jobId);
  assert.ok(record);
  assert.equal(record.status, 'failed');
  assert.match(record.error, /controlled render failure/);
  assert.ok(record.finishedAt);
  assert.ok(Date.parse(record.finishedAt) - Date.parse(record.createdAt) >= 50);
  stub.failMarker = null;
});

test('renders into owned scratch and cleans it up; the final file stays canonical', async () => {
  stub.delayMs = 20;
  stub.failMarker = null;
  const videoId = 'Factory_pathfix_C';
  const job = preview.createExportJob({
    videoId, targetId: 'long', doc: fakeDoc(1), frozenFile: writeFrozen(videoId, 1), audioFiles: {},
  });
  preview.enqueuePreview(videoId, job, fakeProject, 'http://127.0.0.1:3000');
  const record = await waitForSettled(preview.loadExportJob, videoId, job.jobId);
  assert.equal(record.status, 'ready');
  assert.match(stub.workDir, /exp-[a-f0-9]{32}$/, 'the renderer must receive an owned scratch path');
  assert.equal(fs.existsSync(stub.workDir), false, 'scratch must be removed after settlement');
  assert.ok(record.outputFile.endsWith(`${job.jobId}.mp4`), 'the canonical final file name is unchanged');
});

test('an interrupted export stays interrupted and is not reported ready', () => {
  // A record persisted as running with no live worker (a restart) must read as failed.
  const videoId = 'Factory_pathfix_D';
  const job = preview.createExportJob({
    videoId, targetId: 'long', doc: fakeDoc(1), frozenFile: writeFrozen(videoId, 1), audioFiles: {},
  });
  // Never enqueued: simulates the process dying between create and run.
  const read = preview.loadExportJob(videoId, job.jobId);
  assert.equal(read.status, 'failed');
  assert.match(read.error, /interrupted/i);
  assert.ok(read.finishedAt, 'an interruption still records when it was noticed');
});

console.log('\nNOT RUN (needs the real binary, owner host): ffmpeg/ffprobe opening a real');
console.log('long-path raw render and the final export on Windows. This file proves the');
console.log('strategy and the timestamps, not that the installed FFmpeg accepts the paths.');
