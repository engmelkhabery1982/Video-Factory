/**
 * FOCUSED TESTS — acceptance stage evidence validation + planned exposure
 * windows (audit items H and I).
 *
 * These tests are the guard against "the JSON file exists, so the gate passed":
 * a wrong stage identity, a failed status, a foreign run id/commit, a missing
 * referenced media/package file or a hash mismatch must all be rejected BEFORE
 * the evidence could reach GitHub Actions reporting success.
 *
 * No render, no TTS, no network.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PRODUCTION_PACKAGE_CHECKSUMS_PATH,
  PRODUCTION_PACKAGE_MANIFEST_PATH,
  PRODUCTION_PACKAGE_SUMMARY_PATH,
} from '@buildtrack/core';
import {
  assetExposureWindows,
  controlSampleTimes,
  validateStageEnvelope,
  validateStagePayload,
  windowSampleTimes,
  type StageValidationContext,
} from '../scripts/acceptance-stage-validation.js';

const RUN_ID = '1234567890';
const COMMIT = 'a'.repeat(40);
const MARKER_MIN = 300;

let tmp = '';
let ctx: StageValidationContext;

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function write(rel: string, content: Buffer | string): string {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/**
 * Resolve a package-relative POSIX path constant exported by the product under
 * a package root. The fixture uses the product's OWN path constants so it can
 * never drift away from the real Phase 6D layout (checksums live under
 * `manifest/`, not at the package root).
 */
function productPackageFile(packageRoot: string, productPath: string): string {
  return path.join(packageRoot, ...productPath.split('/'));
}

/**
 * A minimal but REAL package layout at the product's own path constants:
 * `manifest/delivery_manifest.json`, `manifest/checksums.sha256` and
 * `evidence/package_summary.json`.
 */
function buildPackageFixture(): { packageRoot: string; mediaFile: string; kitRel: string; kitFile: string } {
  const packageRoot = 'vf-test-video/production-package';
  write(productPackageFile(packageRoot, PRODUCTION_PACKAGE_MANIFEST_PATH), JSON.stringify({
    status: 'ready',
    mode: 'production',
    readyForProductionDelivery: true,
    requestedTargetIds: ['long', 'short_1'],
    packagedTargetIds: ['long', 'short_1'],
    failedTargetIds: [],
  }, null, 2));
  write(productPackageFile(packageRoot, PRODUCTION_PACKAGE_CHECKSUMS_PATH), 'deadbeef  long.mp4\n');
  write(productPackageFile(packageRoot, PRODUCTION_PACKAGE_SUMMARY_PATH), JSON.stringify({ packageStatus: 'ready' }));
  const mediaFile = write('vf-test-video/long.mp4', Buffer.from('rendered-long-bytes'));
  write('vf-test-video/short_1.mp4', Buffer.from('rendered-short-bytes'));
  const kitRel = 'vf-test-video/product-kit';
  write(path.join(kitRel, 'manifest.json'), JSON.stringify({
    schema: 'production-product-kit.v1',
    kind: 'final',
    readiness: { status: 'ready', readyForProductionDelivery: true },
    files: ['manifest.json'],
    phase6dPackage: packageRoot,
    phase6dPackageStatus: 'ready',
  }, null, 2));
  return { packageRoot, mediaFile, kitRel, kitFile: path.join(tmp, kitRel, 'manifest.json') };
}

let pkg: ReturnType<typeof buildPackageFixture>;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-stage-validation-'));
  ctx = {
    rootDir: tmp,
    outputDir: tmp,
    markerMinPixels: MARKER_MIN,
    runId: RUN_ID,
    commit: COMMIT,
  };
  pkg = buildPackageFixture();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  H — envelope                                                       */
/* ------------------------------------------------------------------ */

describe('stage evidence envelope (run + commit + status identity)', () => {
  const doc = { stage: 'preflight', status: 'passed', runId: RUN_ID, commit: COMMIT, generatedAt: new Date().toISOString() };

  it('accepts a document from this run and commit', () => {
    expect(validateStageEnvelope('preflight', doc, { runId: RUN_ID, commit: COMMIT })).toEqual({ ok: true, problems: [] });
  });

  it('rejects a failed stage status', () => {
    const result = validateStageEnvelope('preflight', { ...doc, status: 'failed' }, { runId: RUN_ID, commit: COMMIT });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/status is 'failed'/);
  });

  it('rejects a stage identity mismatch', () => {
    const result = validateStageEnvelope('short-smoke', doc, { runId: RUN_ID, commit: COMMIT });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/identifies itself as 'preflight'/);
  });

  it('rejects stale evidence from another run or commit', () => {
    const staleRun = validateStageEnvelope('preflight', { ...doc, runId: '999' }, { runId: RUN_ID, commit: COMMIT });
    expect(staleRun.ok).toBe(false);
    expect(staleRun.problems.join(' ')).toMatch(/expected this run/);
    const staleCommit = validateStageEnvelope('preflight', { ...doc, commit: 'b'.repeat(40) }, { runId: RUN_ID, commit: COMMIT });
    expect(staleCommit.ok).toBe(false);
    expect(staleCommit.problems.join(' ')).toMatch(/expected this commit/);
  });

  it('rejects a document without a real generation timestamp', () => {
    const result = validateStageEnvelope('preflight', { ...doc, generatedAt: 'not-a-date' }, { runId: RUN_ID, commit: COMMIT });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/generatedAt/);
  });

  it('does not enforce run/commit identity outside GitHub Actions', () => {
    expect(validateStageEnvelope('preflight', { ...doc, runId: null, commit: null }, { runId: null, commit: null }).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  H — stage payloads                                                 */
/* ------------------------------------------------------------------ */

describe('stage payload validation (referenced evidence must be real)', () => {
  it('accepts a well-formed preflight document', () => {
    const doc = {
      stage: 'preflight',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      mediaUrlAuthority: { absoluteUrl: 'http://127.0.0.1:4123/media/asset/asset-x' },
      asset: { id: 'asset-x', sha256: 'c'.repeat(64) },
      audio: { perTurnFiles: 12, expectedDialogueTurns: 12 },
      assetBinding: { logicalRef: 'asset-ref-long' },
      shortAssetBinding: { logicalRef: 'asset-ref-short' },
      edit: { turnId: 'turn-1' },
      reopen: { ok: true },
    };
    expect(validateStagePayload('preflight', doc, ctx).ok).toBe(true);
  });

  it('rejects preflight claims that are not real (0 per-turn WAVs / missing bindings)', () => {
    const doc = {
      stage: 'preflight',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      mediaUrlAuthority: {},
      asset: {},
      audio: { perTurnFiles: 0, expectedDialogueTurns: 0 },
      assetBinding: {},
      shortAssetBinding: {},
    };
    const result = validateStagePayload('preflight', doc, ctx);
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThanOrEqual(5);
  });

  it('accepts a short-smoke document whose file exists and whose hash matches', () => {
    const file = write('stage-check/short-preview.mp4', Buffer.from('short-preview-bytes'));
    const doc = {
      stage: 'short-smoke',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      media: {
        file: path.relative(tmp, file),
        sha256: sha(file),
        width: 1080,
        height: 1920,
        audioStreamCount: 1,
        durationSeconds: 42.5,
        frameProof: { markerPixelsBestFrame: 900, framesSampled: 16 },
      },
    };
    expect(validateStagePayload('short-smoke', doc, ctx).ok).toBe(true);
  });

  it('rejects a short-smoke document whose rendered file is missing', () => {
    const doc = {
      stage: 'short-smoke',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      media: {
        file: 'stage-check/does-not-exist.mp4',
        sha256: 'd'.repeat(64),
        width: 1080,
        height: 1920,
        audioStreamCount: 1,
        durationSeconds: 42.5,
        frameProof: { markerPixelsBestFrame: 900, framesSampled: 16 },
      },
    };
    const result = validateStagePayload('short-smoke', doc, ctx);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/missing or empty/);
  });

  it('rejects a short-smoke document whose recorded hash does not match the bytes', () => {
    const file = write('stage-check/short-preview-2.mp4', Buffer.from('other-short-bytes'));
    const doc = {
      stage: 'short-smoke',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      media: {
        file: path.relative(tmp, file),
        sha256: 'e'.repeat(64),
        width: 1080,
        height: 1920,
        audioStreamCount: 1,
        durationSeconds: 42.5,
        frameProof: { markerPixelsBestFrame: 900, framesSampled: 16 },
      },
    };
    const result = validateStagePayload('short-smoke', doc, ctx);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/does not match the bytes on disk/);
  });

  it('rejects a short-smoke frame proof below the marker threshold', () => {
    const file = write('stage-check/short-preview-3.mp4', Buffer.from('short-bytes-3'));
    const doc = {
      stage: 'short-smoke',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      media: {
        file: path.relative(tmp, file),
        sha256: sha(file),
        width: 1080,
        height: 1920,
        audioStreamCount: 1,
        durationSeconds: 1,
        frameProof: { markerPixelsBestFrame: 12, framesSampled: 4 },
      },
    };
    expect(validateStagePayload('short-smoke', doc, ctx).problems.join(' ')).toMatch(/below 300 marker pixels/);
  });

  it('accepts a final-production document whose package, media and kit are real', () => {
    const longFile = path.join(tmp, 'vf-test-video', 'long.mp4');
    const shortFile = path.join(tmp, 'vf-test-video', 'short_1.mp4');
    const doc = {
      stage: 'final-production',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      packageRoot: pkg.packageRoot,
      productKit: pkg.kitRel,
      media: {
        long: { file: path.relative(tmp, longFile), sha256: sha(longFile) },
        short: { file: path.relative(tmp, shortFile), sha256: sha(shortFile) },
      },
      frameProofs: [
        { stage: 'final-long', markerPixelsBestFrame: 800 },
        { stage: 'final-short', markerPixelsBestFrame: 700 },
      ],
    };
    expect(validateStagePayload('final-production', doc, ctx)).toEqual({ ok: true, problems: [] });
  });

  it('resolves the real stage packageRoot from the repository root, not twice from outputDir', () => {
    const nestedOutput = path.join(tmp, '.stills', 'final-acceptance', 'output');
    const nestedPackage = path.join(nestedOutput, pkg.packageRoot);
    fs.mkdirSync(path.dirname(nestedPackage), { recursive: true });
    fs.cpSync(path.join(tmp, pkg.packageRoot), nestedPackage, { recursive: true });
    fs.cpSync(path.join(tmp, pkg.kitRel), path.join(nestedOutput, pkg.kitRel), { recursive: true });
    const doc = {
      packageRoot: path.relative(tmp, nestedPackage),
      productKit: pkg.kitRel,
      media: {},
      frameProofs: [
        { stage: 'final-long', markerPixelsBestFrame: 800 },
        { stage: 'final-short', markerPixelsBestFrame: 700 },
      ],
    };
    const nestedContext = { ...ctx, outputDir: nestedOutput };
    expect(validateStagePayload('final-production', doc, nestedContext)).toEqual({ ok: true, problems: [] });
    expect(validateStagePayload('final-production', { ...doc, packageRoot: pkg.packageRoot }, nestedContext).problems.join(' '))
      .toMatch(/outside the production output directory/);
  });

  it('rejects a final-production document whose Phase 6D manifest/checksums are missing', () => {
    const doc = {
      stage: 'final-production',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      packageRoot: 'vf-test-video/production-package-missing',
      productKit: 'vf-test-video/product-kit',
      media: {},
      frameProofs: [{ stage: 'final-long', markerPixelsBestFrame: 800 }, { stage: 'final-short', markerPixelsBestFrame: 700 }],
    };
    const result = validateStagePayload('final-production', doc, ctx);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/delivery manifest is missing/);
  });

  it('validates package files at the PRODUCT path constants, never a second hand-written layout', () => {
    // The fixture is built from the product's own constants, so the accepted
    // document must be exactly the one the real export produces: checksums
    // under `manifest/`, not at the package root.
    expect(PRODUCTION_PACKAGE_CHECKSUMS_PATH).toBe('manifest/checksums.sha256');
    expect(fs.existsSync(path.join(tmp, productPackageFile(pkg.packageRoot, PRODUCTION_PACKAGE_CHECKSUMS_PATH)))).toBe(true);
    expect(fs.existsSync(path.join(tmp, pkg.packageRoot, 'checksums.sha256'))).toBe(false);

    const doc = {
      stage: 'final-production',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      packageRoot: pkg.packageRoot,
      productKit: pkg.kitRel,
      media: {},
      frameProofs: [
        { stage: 'final-long', markerPixelsBestFrame: 800 },
        { stage: 'final-short', markerPixelsBestFrame: 700 },
      ],
    };
    const result = validateStagePayload('final-production', doc, ctx);
    expect(result.problems.join(' ')).not.toMatch(/checksums are missing/);
  });

  it('rejects a package whose checksums exist ONLY at the legacy package root', () => {
    // Regression guard for retry 16: the product writes `manifest/checksums.sha256`.
    // A package that only carries the old root-level copy is NOT a real Phase 6D
    // package and must be rejected, so the validator can never drift back to the
    // hand-written path (run 37075880433, job 111071539578).
    const legacyRoot = 'vf-test-video/legacy-checksums-package';
    fs.cpSync(path.join(tmp, pkg.packageRoot), path.join(tmp, legacyRoot), { recursive: true });
    const productChecksums = path.join(tmp, productPackageFile(legacyRoot, PRODUCTION_PACKAGE_CHECKSUMS_PATH));
    expect(fs.existsSync(productChecksums)).toBe(true);
    fs.rmSync(productChecksums);
    expect(fs.existsSync(productChecksums)).toBe(false);
    write(path.join(legacyRoot, 'checksums.sha256'), 'deadbeef  long.mp4\n');

    const doc = {
      stage: 'final-production',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      packageRoot: legacyRoot,
      productKit: undefined,
      media: {},
      frameProofs: [
        { stage: 'final-long', markerPixelsBestFrame: 800 },
        { stage: 'final-short', markerPixelsBestFrame: 700 },
      ],
    };
    const result = validateStagePayload('final-production', doc, ctx);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/Phase 6D checksums are missing/);
    expect(result.problems.join(' ')).toContain(productChecksums);
  });

  it('rejects a final-production document whose product kit is incomplete', () => {
    const longFile = path.join(tmp, 'vf-test-video', 'long.mp4');
    const shortFile = path.join(tmp, 'vf-test-video', 'short_1.mp4');
    // A kit manifest that lists a file which does not exist.
    write('vf-test-video/broken-kit/manifest.json', JSON.stringify({
      schema: 'production-product-kit.v1',
      kind: 'final',
      readiness: { status: 'ready', readyForProductionDelivery: true },
      files: ['manifest.json', 'thumbnails/missing.jpg'],
    }));
    const doc = {
      stage: 'final-production',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      packageRoot: pkg.packageRoot,
      productKit: 'vf-test-video/broken-kit',
      media: {
        long: { file: path.relative(tmp, longFile), sha256: sha(longFile) },
        short: { file: path.relative(tmp, shortFile), sha256: sha(shortFile) },
      },
      frameProofs: [
        { stage: 'final-long', markerPixelsBestFrame: 800 },
        { stage: 'final-short', markerPixelsBestFrame: 700 },
      ],
    };
    const result = validateStagePayload('final-production', doc, ctx);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/product-kit files .* are missing/);
  });

  it('rejects a second-project document that claims renders or non-production history', () => {
    const bad = {
      stage: 'second-project',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      secondVideoId: 'second-video',
      renders: 1,
      historyInput: { source: 'legacy-visual', productionEntryCount: 0 },
    };
    const result = validateStagePayload('second-project', bad, ctx);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/renders=1/);
    expect(result.problems.join(' ')).toMatch(/legacy-visual/);
  });
});

/* ------------------------------------------------------------------ */
/*  I — planned asset exposure windows                                 */
/* ------------------------------------------------------------------ */

describe('planned asset exposure windows (frame sampling inside the real display window)', () => {
  const scenes = [
    { sceneId: 'sc-01-hook', turnDurationsSeconds: [3.0, 2.0] },
    { sceneId: 'sc-02-asset', turnDurationsSeconds: [1.2] },
    { sceneId: 'sc-03-close', turnDurationsSeconds: [2.5] },
  ];

  it('computes the asset scene window from the audio-authoritative durations', () => {
    const windows = assetExposureWindows(scenes, ['sc-02-asset'], { videoDurationSeconds: 9.0 });
    expect(windows).toHaveLength(1);
    expect(windows[0].sceneId).toBe('sc-02-asset');
    // scene starts after 5.0s of preceding audio, is 1.2s long, padded by 0.6s
    expect(windows[0].startSeconds).toBeCloseTo(4.4, 3);
    expect(windows[0].endSeconds).toBeCloseTo(6.8, 3);
  });

  it('clamps windows to the rendered duration and never fabricates a window for an unrendered scene', () => {
    // The rendered video is only 4 s long, so sc-03-close (which starts after
    // 5 s of audio) was not rendered and must not get a window.
    const beyond = assetExposureWindows(scenes, ['sc-01-hook', 'sc-03-close'], { videoDurationSeconds: 4.0 });
    expect(beyond.map((w) => w.sceneId)).toEqual(['sc-01-hook']);
    // A scene that is only PARTIALLY rendered is clamped to the duration.
    const partial = [{ sceneId: 'sc-partial', turnDurationsSeconds: [4.0, 3.0, 0.0, 0.0, 0.0, 0.0, 0.0] }];
    const clamped = assetExposureWindows([{ sceneId: 'pre', turnDurationsSeconds: [0] }, ...partial], ['sc-partial'], { videoDurationSeconds: 5.0 });
    expect(clamped).toHaveLength(1);
    expect(clamped[0].endSeconds).toBeLessThanOrEqual(5.0);
    expect(clamped[0].startSeconds).toBeGreaterThanOrEqual(0);
  });

  it('samples frames INSIDE the window and controls OUTSIDE it', () => {
    const windows = assetExposureWindows(scenes, ['sc-02-asset'], { videoDurationSeconds: 9.0 });
    const inside = windowSampleTimes(windows[0], 4);
    expect(inside.length).toBeGreaterThanOrEqual(5);
    expect(Math.min(...inside)).toBeGreaterThanOrEqual(windows[0].startSeconds);
    expect(Math.max(...inside)).toBeLessThanOrEqual(windows[0].endSeconds);
    const control = controlSampleTimes(windows, 9.0, 1);
    expect(control.length).toBeGreaterThan(3);
    expect(control.every((t) => t < windows[0].startSeconds || t > windows[0].endSeconds)).toBe(true);
    // The fixed 1.5 s grid can legitimately skip this short window entirely:
    const fixedIntervalTimes = [0, 1.5, 3, 4.5, 6, 7.5, 9];
    const insideFixed = fixedIntervalTimes.filter((t) => t >= windows[0].startSeconds && t <= windows[0].endSeconds);
    expect(insideFixed.length).toBeLessThan(inside.length);
  });

  it('produces a deterministic, bounded sample set for a long window', () => {
    const wide = [{ sceneId: 'sc-wide', turnDurationsSeconds: [600] }];
    const windows = assetExposureWindows(wide, ['sc-wide'], { videoDurationSeconds: 600 });
    const times = windowSampleTimes(windows[0], 4, 32);
    expect(times.length).toBeLessThanOrEqual(32);
    expect(times).toEqual(windowSampleTimes(windows[0], 4, 32));
  });
});
