/**
 * Phase 6D — package-root SYMLINK ESCAPE safety.
 *
 * Review finding: the first package-root guard resolved paths LEXICALLY and
 * claimed that this defeated symlinks. It does not. `<repo>/delivery-package`
 * can be lexically inside the repository while being a symlink to
 * `/tmp/outside`, and a nested package-owned directory (`long`, `shorts`,
 * `shorts/short_1`, `manifest`, `evidence`) can be a symlink too. The service
 * then wrote, copied or recursively deleted through those paths.
 *
 * The rule is now two-layered:
 *   A) the package path is a lexical strict descendant of the repository root,
 *      AND
 *   B) no existing filesystem component from the repository root down to the
 *      package path (and down to every nested package path) is a symbolic link,
 *      and the real target still lives inside the real repository / package root.
 *
 * DESTRUCTIVE-TEST POLICY (Phase 6D safety correction §11/§13):
 *   every fixture here lives in a per-run `mkdtemp` directory created
 *   exclusively by this file. No test may target `/home/user`, `~`, the
 *   repository parent, a shell/profile/cache directory, or anything else
 *   outside its own temporary tree. A sentinel file is written into the
 *   "outside" directory of every scenario and its SHA256 is asserted to be
 *   byte-identical after each rejected operation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildProductionDeliveryTargets, type RemotionCompositionPlan } from '@buildtrack/core';
import { buildProductionDeliveryPackage, ProductionDeliveryPackageError } from '../apps/api/src/services/plan-package.js';
import { ffmpegPath } from '../apps/api/src/services/platform.js';

/* ------------------------------------------------------------------ */
/*  Isolated temporary fixture tree                                    */
/* ------------------------------------------------------------------ */

/** The ONLY writable location used by this file. */
let SANDBOX = '';
/** A fake repository root inside the sandbox. */
let REPO = '';
/** An "external" directory the symlinks point at. Never inside REPO. */
let OUTSIDE = '';
/** Real H.264/AAC MP4s used as the Phase 6C render outputs. */
let MEDIA = '';
let SHORT_MEDIA = '';

const SENTINEL = 'external-sentinel.txt';
const sentinelSha = () => createHash('sha256').update(fs.readFileSync(path.join(OUTSIDE, SENTINEL))).digest('hex');

/**
 * Recreates ONLY the fake repository and the external directory, so every test
 * starts from a pristine tree. The shared, immutable render payloads are never
 * touched, and nothing outside the per-run sandbox is ever created or removed.
 */
function resetSandbox(): void {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.writeFileSync(path.join(OUTSIDE, SENTINEL), 'this file must never be read, written or deleted by the package service\n');
  fs.writeFileSync(path.join(OUTSIDE, 'sibling.txt'), 'nor this one\n');
}

/** Recursive listing of a tree, for proving nothing was created or removed. */
function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) out.push(`link ${rel} -> ${fs.readlinkSync(path.join(current, entry.name))}`);
      else if (entry.isDirectory()) {
        out.push(`dir  ${rel}`);
        walk(path.join(current, entry.name), `${rel}/`);
      } else out.push(`file ${rel}`);
    }
  };
  walk(dir, '');
  return out.sort();
}

/* ------------------------------------------------------------------ */
/*  A minimal, self-contained Phase 6C contract                        */
/* ------------------------------------------------------------------ */

/**
 * These scenarios are about PATH HANDLING, not about plan semantics (the plan
 * contract is exhaustively covered by `phase6d-delivery-package.test.ts`), so
 * this suite stays fully self-contained: a minimal structurally-valid
 * `RemotionCompositionPlan` per format and no shared scratch directory that
 * could race with another test file's cleanup.
 */
function makeMinimalPlan(
  format: 'Long' | 'Short',
  scenarioId: string,
  projectId: string,
): RemotionCompositionPlan {
  const width = format === 'Long' ? 1920 : 1080;
  const height = format === 'Long' ? 1080 : 1920;
  const durationInFrames = 90;
  const seconds = durationInFrames / 30;
  const sceneId = `${scenarioId}-sc-01`;
  const scene = {
    scenarioId,
    projectId,
    sceneId,
    sourceSceneId: sceneId,
    sceneIndex: 0,
    renderOrder: 0,
    title: null,
    narrativePurpose: 'explanation',
    rendererKey: 'explanation:key_statement',
    rendererCategory: 'explanation',
    fallbackUsed: false,
    actualStartSeconds: 0,
    actualEndSeconds: seconds,
    actualDurationSeconds: seconds,
    estimatedStartSeconds: 0,
    estimatedEndSeconds: seconds,
    estimatedDurationSeconds: seconds,
    startFrame: 0,
    endFrame: durationInFrames,
    durationInFrames,
    visualTreatment: 'none',
    production: {},
    onScreenInfo: null,
    locationId: 'l1',
    participantIds: [],
    turnIds: [],
    speakerIds: [],
    visualOnly: false,
    beats: [],
    assetRefs: [],
    audioRefs: [
      {
        clipId: `${scenarioId}-clip-01`,
        canonicalPath: `audio/canonical/${scenarioId}/clip-01.wav`,
        startFrame: 0,
        endFrame: durationInFrames,
        durationInFrames,
        localStartFrame: 0,
        localEndFrame: durationInFrames,
        localDurationInFrames: durationInFrames,
        localStartSeconds: 0,
        localEndSeconds: seconds,
        actualStartSeconds: 0,
        actualEndSeconds: seconds,
        actualDurationSeconds: seconds,
      },
    ],
    captionCues: [
      {
        id: `${scenarioId}-cue-01`,
        sceneId,
        sceneIndex: 0,
        turnId: 't1',
        turnIndex: 0,
        globalTurnIndex: 0,
        clipId: `${scenarioId}-clip-01`,
        text: `Package safety caption for ${scenarioId}`,
        speakerId: 's1',
        voiceSlot: 'v1',
        startTimeSeconds: 0,
        endTimeSeconds: 2,
        durationSeconds: 2,
        estimatedStartTimeSeconds: 0,
        estimatedEndTimeSeconds: 2,
        estimatedDurationSeconds: 2,
        wordCount: 4,
        isSingleWord: false,
        globalCueIndex: 0,
        startFrame: 0,
        endFrame: 60,
        durationInFrames: 60,
        localStartFrame: 0,
        localEndFrame: 60,
        localDurationInFrames: 60,
        localStartSeconds: 0,
        localEndSeconds: 2,
      },
    ],
    transition: {
      type: 'cut',
      rendererKey: 'cut',
      durationSeconds: 0,
      source: 'scene.transitionIntent',
      actualStartSeconds: null,
      actualEndSeconds: null,
      actualDurationSeconds: null,
      startFrame: null,
      endFrame: null,
      durationInFrames: null,
      localStartFrame: null,
      localEndFrame: null,
      localDurationInFrames: null,
      outgoingSceneId: null,
      incomingSceneId: sceneId,
    },
    targetFormat: format,
    width,
    height,
  };
  return {
    planVersion: '1.0.0',
    scenarioId,
    projectId,
    language: 'en',
    targetFormat: format,
    fps: 30,
    width,
    height,
    durationInFrames,
    totalActualDurationSeconds: seconds,
    totalEstimatedDurationSeconds: seconds,
    totalDeltaSeconds: 0,
    scenes: [scene as any],
    summary: {} as any,
    findings: [],
    valid: true,
  } as RemotionCompositionPlan;
}

const PROJECT_ID = 'proj-hospital-expansion';
const LONG_PLAN = makeMinimalPlan('Long', 'scenario-pm-01', PROJECT_ID);
const SHORT_PLAN = makeMinimalPlan('Short', 'scenario-sched-risk-03', PROJECT_ID);
const SHORT_PLAN_2 = makeMinimalPlan('Short', 'scenario-sched-risk-03-s2', PROJECT_ID);

/** Real MP4s sized to each minimal plan's frame capacity (3.0s + padding). */
function encode(file: string, width: number, height: number): void {
  execFileSync(
    ffmpegPath(),
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=0x3a6ea5:s=${width}x${height}:r=30:d=3.1`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3.1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-shortest',
      file,
    ],
    { stdio: 'pipe' },
  );
}

function successEntry(target: any, outputFile: string, overrides: Record<string, unknown> = {}): any {
  return {
    targetId: target.targetId,
    success: true,
    format: target.format,
    scenarioId: target.scenarioId,
    projectId: target.projectId,
    outputFile,
    renderResult: {
      outputFile,
      compositionId: 'VideoPlan',
      scenarioId: target.scenarioId,
      projectId: target.projectId,
      fps: target.fps,
      width: target.width,
      height: target.height,
      durationInFrames: target.durationInFrames,
      renderedFrameCount: target.durationInFrames,
      authoritativeDurationSeconds: target.authoritativeDurationSeconds,
      renderedWithAudio: true,
      mediaMapEntryCount: 0,
      renderTimeMs: 1,
    },
    ...overrides,
  };
}

function failureEntry(target: any, outputFile: string | null, code: string): any {
  return {
    targetId: target.targetId,
    success: false,
    format: target.format,
    scenarioId: target.scenarioId,
    projectId: target.projectId,
    outputFile,
    error: { code, message: `synthetic failure for ${target.targetId}`, targetId: target.targetId },
  };
}

let set: any;

function buildSet(shorts: string[] = []) {
  const shortPlans: Record<string, RemotionCompositionPlan> = {};
  for (const id of shorts) shortPlans[id] = id === 'short_2' ? SHORT_PLAN_2 : SHORT_PLAN;
  return buildProductionDeliveryTargets({
    longPlan: LONG_PLAN,
    shortPlans: Object.keys(shortPlans).length ? (shortPlans as any) : undefined,
  });
}

function renderOnlyLong() {
  const target = set.targets.find((t: any) => t.targetId === 'long');
  return {
    version: '1.0.0',
    status: 'ok',
    targetCount: 1,
    succeededTargetIds: ['long'],
    failedTargetIds: [],
    results: [successEntry(target, MEDIA)],
    findings: [],
  };
}

beforeAll(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6d-safety-'));
  REPO = path.join(SANDBOX, 'fake-repo');
  OUTSIDE = path.join(SANDBOX, 'outside');
  resetSandbox();

  // The payload being copied. Real bytes; the scenarios are about paths.
  // `resetSandbox` never removes these, so every test copies live media.
  MEDIA = path.join(SANDBOX, 'long-render.mp4');
  SHORT_MEDIA = path.join(SANDBOX, 'short-render.mp4');
  encode(MEDIA, 1920, 1080);
  encode(SHORT_MEDIA, 1080, 1920);

  set = buildSet();
}, 600_000);

afterAll(() => {
  // Only ever removes this file's own temporary tree.
  if (SANDBOX) fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** Every scenario gets a fresh sandbox so one test can never influence another. */
function freshSandbox(): void {
  resetSandbox();
}

async function expectRefused(packageRoot: string, opts: { clean?: 'none' | 'stale' | 'full' } = {}): Promise<ProductionDeliveryPackageError> {
  let thrown: unknown;
  try {
    await buildProductionDeliveryPackage({
      targetSet: set,
      renderResult: renderOnlyLong(),
      packageRoot,
      repoRoot: REPO,
      clean: opts.clean ?? 'stale',
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `expected ${packageRoot} to be refused`).toBeInstanceOf(ProductionDeliveryPackageError);
  const error = thrown as ProductionDeliveryPackageError;
  expect(error.code).toBe('PACKAGE_ROOT_UNSAFE');
  expect(error.findings.map((f) => f.code)).toContain('PACKAGE_ROOT_UNSAFE');
  // §11/§13: the external tree is never read, written, followed or removed.
  expect(fs.existsSync(path.join(OUTSIDE, SENTINEL))).toBe(true);
  expect(fs.existsSync(path.join(OUTSIDE, 'sibling.txt'))).toBe(true);
  return error;
}

/* ================================================================== */
/*  §5 — the package root itself must not be a symlink                  */
/* ================================================================== */

describe('Phase 6D safety — the package root itself is never a symlink', () => {
  it('1. rejects a packageRoot that is a symlink to an external temp directory', async () => {
    freshSandbox();
    const before = snapshotTree(OUTSIDE);
    const beforeSha = sentinelSha();

    fs.symlinkSync(OUTSIDE, path.join(REPO, 'delivery-package'));
    const error = await expectRefused('delivery-package', { clean: 'full' });
    expect(error.message).toMatch(/symbolic link/);

    // The symlink is not followed, mutated or removed, and the external
    // directory is byte-for-byte untouched.
    expect(fs.lstatSync(path.join(REPO, 'delivery-package')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(REPO, 'delivery-package'))).toBe(fs.realpathSync(OUTSIDE));
    expect(snapshotTree(OUTSIDE)).toEqual(before);
    expect(sentinelSha()).toBe(beforeSha);
  });

  it('1b. rejects a packageRoot symlink for every clean mode', async () => {
    for (const clean of ['none', 'stale', 'full'] as const) {
      freshSandbox();
      fs.symlinkSync(OUTSIDE, path.join(REPO, 'delivery-package'));
      await expectRefused('delivery-package', { clean });
    }
  });

  it('7. clean:full cannot follow a symlinked package root', async () => {
    freshSandbox();
    const before = snapshotTree(OUTSIDE);
    const beforeSha = sentinelSha();

    fs.symlinkSync(OUTSIDE, path.join(REPO, 'pkg'));
    await expectRefused('pkg', { clean: 'full' });

    // clean:'full' must not have emptied the external target directory.
    expect(snapshotTree(OUTSIDE)).toEqual(before);
    expect(sentinelSha()).toBe(beforeSha);
  });
});

/* ================================================================== */
/*  §6 — symlinked ancestors are rejected                               */
/* ================================================================== */

describe('Phase 6D safety — a symlinked ancestor is rejected', () => {
  it('2. rejects a packageRoot whose parent component is a symlink to an external temp directory', async () => {
    freshSandbox();
    const before = snapshotTree(OUTSIDE);
    const beforeSha = sentinelSha();

    fs.symlinkSync(OUTSIDE, path.join(REPO, 'safe-output'));
    const error = await expectRefused(path.join('safe-output', 'delivery-package'), { clean: 'full' });
    expect(error.message).toMatch(/safe-output/);

    expect(fs.lstatSync(path.join(REPO, 'safe-output')).isSymbolicLink()).toBe(true);
    expect(snapshotTree(OUTSIDE)).toEqual(before);
    expect(sentinelSha()).toBe(beforeSha);
  });

  it('2b. rejects a symlink several levels above the package root', async () => {
    freshSandbox();
    fs.mkdirSync(path.join(REPO, 'a', 'b'), { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(REPO, 'a', 'b', 'escape'));
    await expectRefused(path.join('a', 'b', 'escape', 'pkg'), { clean: 'full' });
    expect(fs.existsSync(path.join(OUTSIDE, 'pkg'))).toBe(false);
  });

  it('15. still rejects a lexical "../" escape that no symlink is involved in', async () => {
    freshSandbox();
    const beforeSha = sentinelSha();
    await expectRefused('../escape', { clean: 'full' });
    await expectRefused('../../escape', { clean: 'full' });
    await expectRefused('a/../../escape', { clean: 'full' });
    expect(sentinelSha()).toBe(beforeSha);
  });
});

/* ================================================================== */
/*  §7/§10 — nested package-owned paths are never followed             */
/* ================================================================== */

describe('Phase 6D safety — nested package-owned directories are never followed', () => {
  it('3. rejects a media copy through a symlinked long/ directory', async () => {
    freshSandbox();
    const before = snapshotTree(OUTSIDE);
    const beforeSha = sentinelSha();

    const pkgRoot = path.join(REPO, 'pkg');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(pkgRoot, 'long'));

    const error = await expectRefused('pkg');
    expect(error.message).toMatch(/long/);

    // §9: the copy was refused outright, NOT downgraded to a target failure.
    expect(fs.lstatSync(path.join(pkgRoot, 'long')).isSymbolicLink()).toBe(true);
    expect(snapshotTree(OUTSIDE)).toEqual(before);
    expect(sentinelSha()).toBe(beforeSha);
  });

  it('4. rejects a metadata write through a symlinked manifest/ directory', async () => {
    freshSandbox();
    const before = snapshotTree(OUTSIDE);
    const beforeSha = sentinelSha();

    const pkgRoot = path.join(REPO, 'pkg');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(pkgRoot, 'manifest'));

    const error = await expectRefused('pkg');
    expect(error.message).toMatch(/manifest/);
    expect(snapshotTree(OUTSIDE)).toEqual(before);
    expect(sentinelSha()).toBe(beforeSha);
    expect(fs.existsSync(path.join(OUTSIDE, 'delivery_manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(OUTSIDE, 'checksums.sha256'))).toBe(false);
  });

  it('4b. rejects a write through a symlinked evidence/ directory', async () => {
    freshSandbox();
    const before = snapshotTree(OUTSIDE);
    const pkgRoot = path.join(REPO, 'pkg');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(pkgRoot, 'evidence'));

    await expectRefused('pkg');
    expect(snapshotTree(OUTSIDE)).toEqual(before);
    expect(fs.existsSync(path.join(OUTSIDE, 'package_summary.json'))).toBe(false);
  });

  it('5. rejects a copy through a symlinked shorts/ directory', async () => {
    freshSandbox();
    const before = snapshotTree(OUTSIDE);
    const beforeSha = sentinelSha();

    const pkgRoot = path.join(REPO, 'pkg');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(pkgRoot, 'shorts'));

    const shortSet = buildSet(['short_1']);
    const target = shortSet.targets.find((t: any) => t.targetId === 'short_1');
    let thrown: unknown;
    try {
      await buildProductionDeliveryPackage({
        targetSet: shortSet,
        renderResult: { ...renderOnlyLong(), results: [successEntry(target, SHORT_MEDIA)] },
        packageRoot: 'pkg',
        repoRoot: REPO,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ProductionDeliveryPackageError)?.code).toBe('PACKAGE_ROOT_UNSAFE');
    expect(snapshotTree(OUTSIDE)).toEqual(before);
    expect(sentinelSha()).toBe(beforeSha);
  });

  it('6. rejects a copy through a symlinked shorts/short_1 directory', async () => {
    freshSandbox();
    const before = snapshotTree(OUTSIDE);
    const beforeSha = sentinelSha();

    const pkgRoot = path.join(REPO, 'pkg');
    fs.mkdirSync(path.join(pkgRoot, 'shorts'), { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(pkgRoot, 'shorts', 'short_1'));

    const shortSet = buildSet(['short_1']);
    const target = shortSet.targets.find((t: any) => t.targetId === 'short_1');
    let thrown: unknown;
    try {
      await buildProductionDeliveryPackage({
        targetSet: shortSet,
        renderResult: { ...renderOnlyLong(), results: [successEntry(target, SHORT_MEDIA)] },
        packageRoot: 'pkg',
        repoRoot: REPO,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ProductionDeliveryPackageError)?.code).toBe('PACKAGE_ROOT_UNSAFE');
    expect((thrown as Error).message).toMatch(/short_1/);
    expect(snapshotTree(OUTSIDE)).toEqual(before);
    expect(sentinelSha()).toBe(beforeSha);
  });

  it('9. the media copy is refused before any byte is written through the symlink', async () => {
    freshSandbox();
    const pkgRoot = path.join(REPO, 'pkg');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(pkgRoot, 'long'));
    await expectRefused('pkg');
    // Nothing was written into the external directory at all.
    expect(fs.readdirSync(OUTSIDE).sort()).toEqual([SENTINEL, 'sibling.txt']);
  });

  it('10. the metadata write is refused before any file is written through the symlink', async () => {
    freshSandbox();
    const pkgRoot = path.join(REPO, 'pkg');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(pkgRoot, 'manifest'));
    await expectRefused('pkg');
    expect(fs.readdirSync(OUTSIDE).sort()).toEqual([SENTINEL, 'sibling.txt']);
  });
});

/* ================================================================== */
/*  §8/§9 — cleanup never follows a symlink                             */
/* ================================================================== */

describe('Phase 6D safety — cleanup never follows a symlink', () => {
  it("8. clean:'stale' refuses to remove through a symlinked shorts/ directory", async () => {
    freshSandbox();
    const before = snapshotTree(OUTSIDE);
    const beforeSha = sentinelSha();

    const pkgRoot = path.join(REPO, 'pkg');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(pkgRoot, 'shorts'));

    // short_2 is requested but fails, so clean:'stale' would otherwise try to
    // remove `shorts/short_2`. It must refuse instead of following the link.
    const shortSet = buildSet(['short_1', 'short_2']);
    const t1 = shortSet.targets.find((t: any) => t.targetId === 'short_1');
    const t2 = shortSet.targets.find((t: any) => t.targetId === 'short_2') ?? { targetId: 'short_2', format: 'Short', scenarioId: 'x', projectId: 'y' };
    let thrown: unknown;
    try {
      await buildProductionDeliveryPackage({
        targetSet: shortSet,
        renderResult: {
          version: '1.0.0',
          status: 'partial',
          targetCount: 2,
          succeededTargetIds: ['short_1'],
          failedTargetIds: ['short_2'],
          results: [successEntry(t1, SHORT_MEDIA), failureEntry(t2, null, 'PLAN_RENDER_FAILED')],
          findings: [],
        },
        packageRoot: 'pkg',
        repoRoot: REPO,
        clean: 'stale',
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ProductionDeliveryPackageError)?.code).toBe('PACKAGE_ROOT_UNSAFE');
    expect(snapshotTree(OUTSIDE)).toEqual(before);
    expect(sentinelSha()).toBe(beforeSha);
  });

  it("8b. clean:'stale' refuses to remove a symlinked long/ directory left by an earlier build", async () => {
    freshSandbox();
    const before = snapshotTree(OUTSIDE);
    const pkgRoot = path.join(REPO, 'pkg');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(pkgRoot, 'long'));
    await expectRefused('pkg', { clean: 'stale' });
    expect(snapshotTree(OUTSIDE)).toEqual(before);
  });

  it("8c. clean:'full' refuses to clear a package whose owned entry is a symlink", async () => {
    freshSandbox();
    const before = snapshotTree(OUTSIDE);
    const beforeSha = sentinelSha();

    const pkgRoot = path.join(REPO, 'pkg');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.symlinkSync(OUTSIDE, path.join(pkgRoot, 'evidence'));

    const error = await expectRefused('pkg', { clean: 'full' });
    expect(error.message).toMatch(/evidence/);
    expect(snapshotTree(OUTSIDE)).toEqual(before);
    expect(sentinelSha()).toBe(beforeSha);
    expect(fs.existsSync(path.join(OUTSIDE, SENTINEL))).toBe(true);
  });
});

/* ================================================================== */
/*  §12/§13/§14 — legitimate packages still build                      */
/* ================================================================== */

describe('Phase 6D safety — legitimate packages still build normally', () => {
  it('12. builds into a valid, pre-created real directory inside the repository', async () => {
    freshSandbox();
    fs.mkdirSync(path.join(REPO, 'pkg'), { recursive: true });
    const res = await buildProductionDeliveryPackage({
      targetSet: set,
      renderResult: renderOnlyLong(),
      packageRoot: 'pkg',
      repoRoot: REPO,
      clean: 'full',
    });
    expect(res.package.status).toBe('ready');
    expect(fs.existsSync(path.join(REPO, 'pkg', 'long', 'video.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(REPO, 'pkg', 'manifest', 'delivery_manifest.json'))).toBe(true);
  }, 300_000);

  it('13. builds into a brand new, non-existent safe package directory', async () => {
    freshSandbox();
    const res = await buildProductionDeliveryPackage({
      targetSet: set,
      renderResult: renderOnlyLong(),
      packageRoot: 'brand/new/package',
      repoRoot: REPO,
      clean: 'full',
    });
    expect(res.package.status).toBe('ready');
    expect(fs.existsSync(path.join(REPO, 'brand', 'new', 'package', 'evidence', 'package_summary.json'))).toBe(true);
  }, 300_000);

  it('14. rebuilds over an existing legitimate package directory', async () => {
    freshSandbox();
    const first = await buildProductionDeliveryPackage({
      targetSet: set,
      renderResult: renderOnlyLong(),
      packageRoot: 'pkg',
      repoRoot: REPO,
      clean: 'full',
    });
    const firstManifest = fs.readFileSync(path.join(first.packageRoot, 'manifest', 'delivery_manifest.json'), 'utf8');

    const second = await buildProductionDeliveryPackage({
      targetSet: set,
      renderResult: renderOnlyLong(),
      packageRoot: 'pkg',
      repoRoot: REPO,
      clean: 'stale',
    });
    expect(second.package.status).toBe('ready');
    expect(fs.readFileSync(path.join(second.packageRoot, 'manifest', 'delivery_manifest.json'), 'utf8')).toBe(firstManifest);
  }, 300_000);
});

/* ================================================================== */
/*  §13 — the incident regression test                                  */
/* ================================================================== */

describe('Phase 6D safety — incident regression: a textually-inside path redirected outside the repository', () => {
  it('rejects the exact shape of the earlier package-root escape, with sentinels intact', async () => {
    freshSandbox();

    // 1. a fake repository temp root
    expect(REPO.startsWith(SANDBOX)).toBe(true);
    expect(OUTSIDE.startsWith(SANDBOX)).toBe(true);
    expect(OUTSIDE.startsWith(REPO)).toBe(false);

    // 2. a package path that LOOKS textually inside the repository
    const textualPath = path.join('delivery', 'package');
    fs.mkdirSync(path.join(REPO, 'delivery'), { recursive: true });
    expect(path.relative(REPO, path.join(REPO, textualPath)).startsWith('..')).toBe(false);

    // 3. a symlink that redirects it outside the fake repository
    fs.symlinkSync(OUTSIDE, path.join(REPO, 'delivery', 'package'));

    // 4. sentinel files in the outside directory
    const beforeTree = snapshotTree(OUTSIDE);
    const beforeSentinelSha = sentinelSha();
    const beforeSiblingSha = createHash('sha256').update(fs.readFileSync(path.join(OUTSIDE, 'sibling.txt'))).digest('hex');

    // 5. request clean:'full'
    let thrown: unknown;
    try {
      await buildProductionDeliveryPackage({
        targetSet: set,
        renderResult: renderOnlyLong(),
        packageRoot: textualPath,
        repoRoot: REPO,
        clean: 'full',
      });
    } catch (err) {
      thrown = err;
    }

    // Expected: PACKAGE_ROOT_UNSAFE, no files removed, no files overwritten.
    expect(thrown).toBeInstanceOf(ProductionDeliveryPackageError);
    expect((thrown as ProductionDeliveryPackageError).code).toBe('PACKAGE_ROOT_UNSAFE');
    expect(snapshotTree(OUTSIDE)).toEqual(beforeTree);
    expect(sentinelSha()).toBe(beforeSentinelSha);
    expect(createHash('sha256').update(fs.readFileSync(path.join(OUTSIDE, 'sibling.txt'))).digest('hex')).toBe(beforeSiblingSha);
    expect(fs.lstatSync(path.join(REPO, 'delivery', 'package')).isSymbolicLink()).toBe(true);

    // The fake repository outside the sandbox is never touched either.
    expect(fs.existsSync(path.join(SANDBOX, 'outside', 'manifest'))).toBe(false);
    expect(fs.existsSync(path.join(SANDBOX, 'outside', 'long'))).toBe(false);
  }, 300_000);

  it('never references a real home directory in any safety fixture', () => {
    const home = os.homedir();
    expect(REPO.startsWith(os.tmpdir())).toBe(true);
    expect(OUTSIDE.startsWith(os.tmpdir())).toBe(true);
    expect(REPO.startsWith(home + path.sep)).toBe(false);
    expect(OUTSIDE.startsWith(home + path.sep)).toBe(false);
  });
});

/* ================================================================== */
/*  Layer separation                                                    */
/* ================================================================== */

describe('Phase 6D safety — the lexical layer is preserved, the real-filesystem layer is added', () => {
  it('rejects an empty root and the repository root itself, unchanged by this correction', async () => {
    freshSandbox();
    for (const root of ['', '   ', '.', './']) {
      let thrown: unknown;
      try {
        await buildProductionDeliveryPackage({ targetSet: set, renderResult: renderOnlyLong(), packageRoot: root, repoRoot: REPO });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as ProductionDeliveryPackageError)?.code, `root ${JSON.stringify(root)}`).toBe('PACKAGE_ROOT_UNSAFE');
    }
    expect(fs.existsSync(REPO)).toBe(true);
    expect(snapshotTree(OUTSIDE)).toEqual([`file ${SENTINEL}`, `file sibling.txt`]);
  });
});
