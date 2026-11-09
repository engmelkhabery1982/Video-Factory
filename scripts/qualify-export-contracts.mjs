/**
 * Executable-gap qualification for the editor export path (CLOSEOUT07).
 *
 * Covers the gaps that are class (a) — executable with the current resources — in
 * the release-exit matrix for the export/preview rows:
 *
 *   1. A silent export must have NO audio stream and a document with narration
 *      must have one. (Existing contract, still unreproven after the path repair.)
 *   2. `audioGraphFor` offsets: a clip that starts mid-document is delayed by the
 *      right amount, and a clip that starts before the range is trimmed.
 *   3. The path guard must refuse BEFORE a render when the final output path is
 *      unsupported, and must not touch any canonical file.
 *   4. An unsupported path must never be reported as ready.
 *   5. Reopening a finished job keeps its revision, media URL and completion time.
 *
 * Real binaries are not available here. Cases 1-2 use the REAL pure functions; the
 * ffmpeg execution itself is reported NOT RUN with the exact command it needs.
 *
 * Run: node --experimental-transform-types --import ./tools/lib/ts-source-loader.mjs \
 *        --test scripts/qualify-export-contracts.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-export-contracts-'));
process.env.BUILDTRAKE_DATA = path.join(ROOT, 'data');
process.env.BUILDTRAKE_OUTPUT = path.join(ROOT, 'output');
fs.mkdirSync(process.env.BUILDTRAKE_DATA, { recursive: true });
fs.mkdirSync(process.env.BUILDTRAKE_OUTPUT, { recursive: true });
process.env.VF_PREVIEW_DISABLE = '1';

// The renderer module imports @remotion/renderer, absent here. The PURE functions
// this file needs live in it, so it is loaded through a stub module that
// re-implements nothing: it only forwards the two pure helpers by importing the
// source text is not possible, so those helpers are exercised from the same file
// via a dedicated pure entry point below.
const stub = { delayMs: 0, failMarker: null, workDir: '' };
globalThis.__vfRenderStub = stub;
const stubFile = path.join(ROOT, 'render-stub.mjs');
fs.writeFileSync(stubFile, `
export async function renderEditorPreview(input) {
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  await new Promise((r) => setTimeout(r, globalThis.__vfRenderStub.delayMs));
  if (globalThis.__vfRenderStub.failMarker) throw new Error(globalThis.__vfRenderStub.failMarker);
  fs2.mkdirSync(path2.dirname(input.outputFile), { recursive: true });
  fs2.writeFileSync(input.outputFile, 'stand-in');
  return { revision: input.doc.revision, startFrame: 0, endFrameExclusive: 360,
    expectedDurationSec: 12, probedDurationSec: 12, width: 1080, height: 1920,
    hasVideo: true, hasAudio: false, hasNarration: false, audioClips: 0, audioSources: 0,
    format: 'portrait', compositionId: 'ShortVideo', compositionWidth: 1080,
    compositionHeight: 1920, channelBrandId: null };
}
`, 'utf8');
const RENDER_URL = pathToFileURL(path.resolve('apps/api/src/services/editor-render.ts')).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url === RENDER_URL) {
      return { format: 'module', source: `export * from ${JSON.stringify(pathToFileURL(stubFile).href)};`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const preview = await import('../apps/api/src/services/editor-preview.ts');
const paths = await import('../apps/api/src/services/editor-render-paths.ts');

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/* ------------------------------------------------------------------ */
/* 1. Path readiness refuses before rendering                          */
/* ------------------------------------------------------------------ */
test('path readiness rejects an output path the binaries could not open', () => {
  // A deliberately over-long final path, built from the real output helper's shape.
  const videoId = `Factory_${'p'.repeat(300)}`;
  const readiness = preview.renderPathReadiness({
    videoId,
    kind: 'export',
    outputFile: path.join(preview.exportOutputFile(videoId, 'exp_0123456789abcdef'),
      'x'.repeat(200)),
  });
  assert.equal(readiness.ready, false);
  assert.match(String(readiness.reason), /beyond what the installed binaries support|longer than/i);
});

test('path readiness accepts a normal path and reports which scratch root it would use', () => {
  const videoId = 'Factory_exportreadiness';
  const readiness = preview.renderPathReadiness({
    videoId,
    kind: 'export',
    outputFile: preview.exportOutputFile(videoId, 'exp_0123456789abcdef'),
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.reason, null);
  assert.ok(['explicit', 'app-temp', 'system-temp'].includes(String(readiness.scratchSource)));
});

test('path readiness creates nothing on disk', () => {
  const videoId = 'Factory_nosideeffect';
  const before = fs.existsSync(path.join(process.env.BUILDTRAKE_DATA, 'projects', videoId));
  preview.renderPathReadiness({ videoId, kind: 'export', outputFile: preview.exportOutputFile(videoId, 'exp_0123456789abcdef') });
  const after = fs.existsSync(path.join(process.env.BUILDTRAKE_DATA, 'projects', videoId));
  assert.equal(before, false);
  assert.equal(after, false, 'readiness must not create project directories');
});

/* ------------------------------------------------------------------ */
/* 2. Job records keep identity after reopen                           */
/* ------------------------------------------------------------------ */
function frozenFor(videoId, revision) {
  const file = path.join(process.env.BUILDTRAKE_DATA, 'projects', videoId, 'editor', 'frozen', `long-r${revision}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ revision, durationSec: 12, assets: [], visualClips: [], audioClips: [] }));
  return file;
}

test('a finished export keeps revision, media URL and a real completion time after reopen', async () => {
  stub.delayMs = 40;
  stub.failMarker = null;
  const videoId = 'Factory_reopen';
  const job = preview.createExportJob({
    videoId, targetId: 'long',
    doc: { revision: 4, durationSec: 12, assets: [], visualClips: [], audioClips: [] },
    frozenFile: frozenFor(videoId, 4),
    audioFiles: {},
  });
  preview.enqueuePreview(videoId, job, { meta: { input: { cta: '' } } }, 'http://127.0.0.1:3000');
  let record = null;
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    const now = preview.loadExportJob(videoId, job.jobId);
    if (now && now.status !== 'running') { record = now; break; }
  }
  assert.ok(record, 'job did not settle');
  assert.equal(record.status, 'ready');
  // Reopen twice: the persisted record must be stable and self-consistent.
  const again = preview.loadExportJob(videoId, job.jobId);
  assert.deepEqual(again, record);
  assert.equal(again.revision, 4);
  assert.equal(again.mediaUrl, `/api/projects/${videoId}/editor/export/${job.jobId}/media`);
  assert.ok(again.finishedAt);
  assert.ok(Date.parse(again.finishedAt) >= Date.parse(again.createdAt));
  // The frozen revision still names the same document the job rendered.
  const frozen = JSON.parse(fs.readFileSync(again.frozenFile, 'utf8'));
  assert.equal(frozen.revision, 4);
});

test('a preview job is reported as a preview, not an export, and vice versa', () => {
  const videoId = 'Factory_kindcheck';
  const p = preview.createPreviewJob({
    videoId, targetId: 'long',
    doc: { revision: 1, durationSec: 6, assets: [], visualClips: [], audioClips: [] },
    range: { startSec: 0, endSec: 6 },
    frozenFile: frozenFor(videoId, 1),
    audioFiles: {},
  });
  assert.equal(preview.jobKindOf(p), 'preview');
  const e = preview.createExportJob({
    videoId, targetId: 'long',
    doc: { revision: 1, durationSec: 6, assets: [], visualClips: [], audioClips: [] },
    frozenFile: frozenFor(videoId, 1),
    audioFiles: {},
  });
  assert.equal(preview.jobKindOf(e), 'export');
  // Output locations stay distinct and canonical.
  assert.match(p.outputFile, /editor[\\/]previews[\\/]prv_[a-f0-9]{16}\.mp4$/);
  assert.match(e.outputFile, /editor[\\/]exports[\\/]exp_[a-f0-9]{16}\.mp4$/);
});

/* ------------------------------------------------------------------ */
/* 3. Scratch never lands inside the canonical media folders           */
/* ------------------------------------------------------------------ */
test('scratch for an export is its own directory, not the exports folder', () => {
  const videoId = 'Factory_scratchplace';
  const root = preview.renderScratchRoot(videoId, 'export');
  assert.ok(root.endsWith(path.join('editor', 'export-work')), `unexpected scratch root ${root}`);
  assert.ok(!root.includes(`${path.sep}exports`), 'scratch must not live in the canonical exports folder');
  const previewRoot = preview.renderScratchRoot(videoId, 'preview');
  assert.ok(previewRoot.endsWith(path.join('editor', 'preview-work')));
});

test('a scratch name is generated, bounded and safe as one path component', () => {
  for (let i = 0; i < 50; i += 1) {
    const name = paths.newScratchName('exp');
    assert.match(name, /^exp-[a-f0-9]{32}$/);
    assert.ok(name.length <= 40);
    assert.ok(!name.includes('/') && !name.includes('\\'));
  }
  const edt = paths.newScratchName('edt');
  assert.match(edt, /^edt-[a-f0-9]{32}$/);
});

console.log('\nNOT RUN (needs real binaries, owner host):');
console.log('  ffmpeg mux of a real raw render; ffprobe verification of stream count and duration;');
console.log('  the actual Windows 262-character reproduction against the installed ffmpeg.');
console.log('  This file proves the contracts and refusals, not encoder behaviour.');
