/**
 * BuildTrack Video Factory - Phase 6D Plan-Based Delivery Package Service
 *
 * Materialises a deterministic production DELIVERY PACKAGE from APPROVED
 * Phase 6C output.
 *
 *   ProductionDeliveryTargetSet        (identity authority)
 *   + ProductionDeliveryRenderResult   (media outcome authority)
 *   + actually rendered MP4 files
 *        -> <packageRoot>/manifest|long|shorts|evidence
 *
 * What this service does:
 *   - refuses an unsafe package root BEFORE touching the filesystem;
 *   - COPIES each successful render output into the package (never moves it,
 *     never re-encodes, never remuxes, never retimes, never rewrites it);
 *   - measures SHA256 of the source before and after packaging, so "the source
 *     was not mutated" is proven, not assumed;
 *   - probes the COPIED media with the EXISTING `analyseFile(...)` helper, so
 *     ffprobe infrastructure is never duplicated;
 *   - hands everything to the pure core planner, then writes exactly the files
 *     the planner produced.
 *
 * What this service does NOT do:
 *   - it never renders, plans, retimes or re-encodes;
 *   - it never resolves assets (Phase 6A owns resolution);
 *   - it never creates, archives, uploads, publishes or schedules anything;
 *   - it never reads legacy `Project.storyboard` / `Scene[]` / `TargetMedia`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  PRODUCTION_DELIVERY_PACKAGE_VERSION,
  PRODUCTION_PACKAGE_ROOT_ENTRIES,
  buildProductionDeliveryPackage as buildProductionDeliveryPackagePlan,
  packageTargetDirectory,
  packageTargetFile,
  serialisePackageJson,
  validateProductionPackageRoot,
  type BuildDeliveryPackageInput,
  type DeliveryTargetId,
  type ProductionDeliveryPackage,
  type ProductionDeliveryPackageFile,
  type ProductionPackageFinding,
  type ProductionPackageFindingCode,
  type ProductionPackageMediaEvidence,
  type ProductionPackageMode,
  type ProductionTargetTechnicalMetrics,
} from '@buildtrack/core';
import { analyseFile } from './media.js';
import { ROOT } from './platform.js';

/* ------------------------------------------------------------------ */
/*  Errors                                                              */
/* ------------------------------------------------------------------ */

export type ProductionDeliveryPackageErrorCode =
  | 'PACKAGE_ROOT_UNSAFE'
  | 'PACKAGE_MISSING_INPUT'
  | 'PACKAGE_COPY_FAILED';

/** Structured error for the package service. */
export class ProductionDeliveryPackageError extends Error {
  public readonly code: ProductionDeliveryPackageErrorCode;
  public readonly findings: ProductionPackageFinding[];

  constructor(code: ProductionDeliveryPackageErrorCode, message: string, findings: ProductionPackageFinding[] = []) {
    super(message);
    this.name = 'ProductionDeliveryPackageError';
    this.code = code;
    this.findings = findings;
  }
}

/* ------------------------------------------------------------------ */
/*  Service input                                                       */
/* ------------------------------------------------------------------ */

/**
 * Input of `buildProductionDeliveryPackage(...)`.
 *
 * The target set is the package identity authority and the render result is
 * the media outcome authority. No legacy project/storyboard is accepted.
 */
export interface BuildProductionDeliveryPackageServiceInput {
  targetSet: BuildDeliveryPackageInput['targetSet'];
  renderResult: BuildDeliveryPackageInput['renderResult'];
  packageRoot: string;
  /**
   * `production` (default) is the only mode that may reach READY.
   * `test-evidence` marks a cost-controlled sub-range render as mechanics-only
   * evidence; it downgrades readiness and never relaxes production QC.
   */
  mode?: ProductionPackageMode;
  /**
   * How much of an existing package directory to remove before writing.
   *  - `stale` (default): only package-owned target directories this build does
   *    not produce are removed, so a failed target can never leave stale media;
   *  - `none`: nothing is removed;
   *  - `full`: the whole package root is removed first. Only ever runs AFTER the
   *    package-root safety check has passed, and never touches a caller path
   *    outside the package root.
   */
  clean?: 'none' | 'stale' | 'full';
  /** Repository root used for the package-root safety check. Defaults to the repo. */
  repoRoot?: string | null;
}

/** Proof that packaging did not mutate a single source render output. */
export interface ProductionPackageSourceIntegrity {
  targetId: DeliveryTargetId;
  /** Absolute source path. Runtime evidence only, never written to the package. */
  sourceRenderFile: string;
  sha256Before: string | null;
  sha256After: string | null;
  packagedSha256: string | null;
  sizeBytes: number;
  /** The source render output is byte-identical before and after packaging. */
  unchanged: boolean;
  /** The packaged copy is byte-identical to the source render output. */
  packagedMatchesSource: boolean;
}

export interface ProductionDeliveryPackageBuildResult {
  version: typeof PRODUCTION_DELIVERY_PACKAGE_VERSION;
  packageRoot: string;
  package: ProductionDeliveryPackage;
  /** Package-relative paths written, in write order. */
  writtenFiles: string[];
  /** Package-relative directories removed. */
  removedPaths: string[];
  sourceIntegrity: ProductionPackageSourceIntegrity[];
}

/* ------------------------------------------------------------------ */
/*  Filesystem helpers                                                  */
/* ------------------------------------------------------------------ */

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Filesystem-aware path safety (symlink escape)                      */
/* ------------------------------------------------------------------ */

/**
 * The guard that makes a package path safe to WRITE through.
 *
 * A path is safe only when BOTH hold:
 *
 *   A) it is a lexical strict descendant of the repository root, AND
 *   B) every existing component from the repository root down to the path is
 *      a real directory/file and NOT a symbolic link, and the path's real
 *      filesystem target still lives inside the repository.
 *
 * Lexical resolution ALONE is not sufficient: `<repo>/delivery-package` can be
 * lexically inside the repository while being a symlink to `/tmp/outside`. The
 * same is true of any nested package-owned directory (`long`, `shorts`,
 * `shorts/short_1`, `manifest`, `evidence`). A package-root safety defect of
 * exactly that shape was found during Phase 6D and corrected before closure,
 * so every copy, write and recursive delete below is preceded by this check.
 *
 * These helpers are private to this service on purpose: the filesystem rules
 * belong to the materialiser, not to the filesystem-free core planner.
 */

/** `lstat`, which does NOT follow symbolic links. */
function lstatOrNull(candidate: string): fs.Stats | null {
  try {
    return fs.lstatSync(candidate);
  } catch {
    return null;
  }
}

/** `realpath`, falling back to the path itself when it does not exist yet. */
function realpathOrSelf(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/** True only for a real child path, never for a path that escapes `parent`. */
function isStrictDescendant(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (!rel.length || path.isAbsolute(rel)) return false;
  if (rel === '..') return false;
  return !rel.startsWith(`..${path.sep}`);
}

/** `a/b/c` given `a` -> `[a/b, a/b/c]`. Empty when `target` escapes `base`. */
function componentsBelow(base: string, target: string): string[] {
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [];
  const out: string[] = [];
  let cursor = base;
  for (const part of rel.split(path.sep)) {
    if (!part.length) continue;
    cursor = path.join(cursor, part);
    out.push(cursor);
  }
  return out;
}

/** Raised for every rejected unsafe package path, with a matching finding. */
function unsafePackagePath(message: string): ProductionDeliveryPackageError {
  return new ProductionDeliveryPackageError('PACKAGE_ROOT_UNSAFE', message, [
    { severity: 'error', code: 'PACKAGE_ROOT_UNSAFE', message },
  ]);
}

/**
 * Validate the package root once, before anything is created, copied, written
 * or removed. This is the ONLY place a caller-supplied root is accepted.
 */
function assertSafePackageRoot(repoRoot: string, packageRoot: string): string {
  const rootAbs = path.resolve(repoRoot);
  const rootReal = realpathOrSelf(rootAbs);
  const targetAbs = path.resolve(rootAbs, packageRoot);

  // (A) lexical containment inside the repository root.
  if (!isStrictDescendant(rootAbs, targetAbs)) {
    throw unsafePackagePath(
      `refusing packageRoot ${targetAbs}: it is not inside the repository root ${rootAbs}`,
    );
  }

  // (B) no existing component between the repository root and the package root
  // may be a symbolic link - a symlinked parent silently redirects every write.
  for (const component of componentsBelow(rootAbs, targetAbs)) {
    const stats = lstatOrNull(component);
    if (stats?.isSymbolicLink()) {
      throw unsafePackagePath(
        `refusing packageRoot ${targetAbs}: the component ${component} is a symbolic link to ${realpathOrSelf(component)}`,
      );
    }
  }

  // (B) the package root itself must not be a symbolic link, even when it is
  // the final component of the path.
  const rootStats = lstatOrNull(targetAbs);
  if (rootStats?.isSymbolicLink()) {
    throw unsafePackagePath(
      `refusing packageRoot ${targetAbs}: it is a symbolic link to ${realpathOrSelf(targetAbs)}`,
    );
  }

  // (B) whatever it resolves to must still live inside the real repository.
  if (rootStats) {
    const targetReal = realpathOrSelf(targetAbs);
    if (!isStrictDescendant(rootReal, targetReal)) {
      throw unsafePackagePath(
        `refusing packageRoot ${targetAbs}: it resolves to ${targetReal}, outside the repository root ${rootReal}`,
      );
    }
  }

  return targetAbs;
}

/**
 * Validate one destination path INSIDE an already-validated package root.
 *
 * This is deliberately re-run for every single copy, write and recursive
 * delete rather than once per build: a nested package-owned directory
 * (`long`, `shorts`, `shorts/short_1`, `manifest`, `evidence`) may itself be a
 * symlink planted after the root was accepted, and a validated root alone does
 * not make its children safe.
 */
function assertSafePackagePath(packageRoot: string, target: string): string {
  const rootAbs = path.resolve(packageRoot);
  const targetAbs = path.resolve(rootAbs, target);
  assertNotPrivateVoiceAsset(packageRoot, target);

  if (!isStrictDescendant(rootAbs, targetAbs)) {
    throw unsafePackagePath(
      `refusing package path ${targetAbs}: it escapes the package root ${rootAbs}`,
    );
  }

  for (const component of componentsBelow(rootAbs, targetAbs)) {
    const stats = lstatOrNull(component);
    if (stats?.isSymbolicLink()) {
      throw unsafePackagePath(
        `refusing package path ${targetAbs}: the component ${component} is a symbolic link to ${realpathOrSelf(component)}`,
      );
    }
  }

  const stats = lstatOrNull(targetAbs);
  if (stats) {
    const targetReal = realpathOrSelf(targetAbs);
    if (!isStrictDescendant(realpathOrSelf(rootAbs), targetReal)) {
      throw unsafePackagePath(
        `refusing package path ${targetAbs}: it resolves to ${targetReal}, outside the package root ${rootAbs}`,
      );
    }
  }

  return targetAbs;
}

/**
 * VS3 — private voice-audio assets must NEVER enter a delivery package.
 *
 * Reference recordings of real people, their recorded authorization artifacts
 * and the generated preview audio of the Voice & Audio panel are PROJECT-PRIVATE
 * inputs, not deliverables. They live under the project's own
 * `voice-audio/` directory (outside every package root), and this guard makes
 * that a hard, test-enforced boundary: any packaged path that names one of them
 * is refused instead of silently shipped.
 */
const PRIVATE_VOICE_AUDIO_MARKERS = [
  'voice-audio',
  'voice_references',
  '.consent.json',
  'reference-take',
] as const;

function assertNotPrivateVoiceAsset(packageRoot: string, relative: string): void {
  const normalized = relative.replace(/\\/g, '/').toLowerCase();
  const marker = PRIVATE_VOICE_AUDIO_MARKERS.find((m) => normalized.includes(m));
  if (marker) {
    throw unsafePackagePath(
      `refusing to package ${path.join(packageRoot, relative)}: it names a private voice-audio asset ("${marker}"). ` +
        'Reference recordings, authorization artifacts and audio previews are never part of a delivery package.',
    );
  }
}

/** Create a package-owned directory, refusing to follow any symlinked parent. */
function ensureSafePackageDir(packageRoot: string, relative: string): string {
  assertNotPrivateVoiceAsset(packageRoot, relative);
  const dir = assertSafePackagePath(packageRoot, relative);
  fs.mkdirSync(dir, { recursive: true });
  // Re-validate: `mkdir -p` can race with a symlink swap.
  assertSafePackagePath(packageRoot, relative);
  return dir;
}

/** Create the package root itself, refusing to follow a symlinked root. */
function ensureSafePackageRootDir(repoRoot: string, packageRootInput: string): string {
  const dir = assertSafePackageRoot(repoRoot, packageRootInput);
  fs.mkdirSync(dir, { recursive: true });
  return assertSafePackageRoot(repoRoot, packageRootInput);
}

/**
 * Remove a package-owned directory tree.
 *
 * The candidate is proven to be a real, non-symlinked directory inside the
 * package root immediately before the recursive delete. An external symlink
 * target is never followed and never removed.
 */
function removeSafePackageDir(packageRoot: string, relative: string): void {
  assertNotPrivateVoiceAsset(packageRoot, relative);
  const target = assertSafePackagePath(packageRoot, relative);
  const stats = lstatOrNull(target);
  if (!stats) return;
  if (stats.isSymbolicLink()) {
    throw unsafePackagePath(
      `refusing to remove ${target}: it is a symbolic link to ${realpathOrSelf(target)}`,
    );
  }
  if (!stats.isDirectory()) return;
  // Prove containment again immediately before the destructive call.
  assertSafePackagePath(packageRoot, relative);
  fs.rmSync(target, { recursive: true, force: true });
}

/** Probe the COPIED packaged media. ffprobe infrastructure is reused as-is. */
async function probePackagedMedia(
  file: string,
): Promise<{ metrics: ProductionTargetTechnicalMetrics | null; error: string | null }> {
  try {
    const a = await analyseFile(file);
    const ratio = String(a.r_frame_rate ?? '');
    const [num, den] = ratio.split('/').map((v) => Number(v));
    const fps = den && Number.isFinite(den) && Number.isFinite(num) ? num / den : Number.isFinite(Number(ratio)) ? Number(ratio) : null;
    return {
      metrics: {
        exists: true,
        sizeBytes: Number(a.sizeBytes ?? 0),
        videoCodec: a.codec_name ? String(a.codec_name) : null,
        width: Number.isFinite(Number(a.width)) ? Number(a.width) : null,
        height: Number.isFinite(Number(a.height)) ? Number(a.height) : null,
        fps: fps !== null && Number.isFinite(fps) ? fps : null,
        fpsRatio: ratio || null,
        durationSeconds: Number.isFinite(Number(a.duration)) ? Number(a.duration) : null,
        hasAudio: !!a.hasAudio,
        audioCodec: a.audioCodec ? String(a.audioCodec) : null,
        audioSampleRate: a.audioSampleRate ? Number(a.audioSampleRate) : null,
        audioChannels: a.audioChannels ? Number(a.audioChannels) : null,
        containerFormat: a.formatName ? String(a.formatName) : null,
        blackSeconds: Number.isFinite(Number(a.blackSeconds)) ? Number(a.blackSeconds) : null,
        blackIntervals: Number.isFinite(Number(a.blackIntervals)) ? Number(a.blackIntervals) : null,
        longestSilenceSeconds: Number.isFinite(Number(a.longestSilence)) ? Number(a.longestSilence) : null,
        silenceCount: Number.isFinite(Number(a.silenceCount)) ? Number(a.silenceCount) : null,
      },
      error: null,
    };
  } catch (err) {
    return { metrics: null, error: (err as Error)?.message ?? String(err) };
  }
}

function emptyMediaEvidence(targetId: DeliveryTargetId): ProductionPackageMediaEvidence {
  return {
    targetId,
    sourceRenderFile: null,
    sourceRenderFileName: null,
    sourceExists: false,
    sourceSizeBytes: 0,
    sourceSha256: null,
    copied: false,
    videoSha256: null,
    sizeBytes: 0,
    metrics: null,
    error: null,
  };
}

/* ------------------------------------------------------------------ */
/*  The service                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build the production delivery package.
 *
 * Sequence:
 *   1. refuse an unsafe package root, lexically AND on the real filesystem
 *      (before ANY filesystem write, copy or delete);
 *   2. hash each source render output;
 *   3. COPY each successful render output into its package directory;
 *   4. hash + probe the COPIED file;
 *   5. let the pure core planner decide matching, captions, QC, manifest;
 *   6. write exactly the files the planner produced, drop failed-target dirs;
 *   7. re-hash the sources to prove they were not mutated.
 *
 * Every copy, write and recursive delete additionally re-proves its own
 * destination with `assertSafePackagePath(...)`, so a symlink planted inside
 * the package root after it was accepted can never be followed.
 */
export async function buildProductionDeliveryPackage(
  input: BuildProductionDeliveryPackageServiceInput,
): Promise<ProductionDeliveryPackageBuildResult> {
  const { targetSet, renderResult } = input ?? ({} as BuildProductionDeliveryPackageServiceInput);

  if (!targetSet || !renderResult) {
    throw new ProductionDeliveryPackageError(
      'PACKAGE_MISSING_INPUT',
      'buildProductionDeliveryPackage requires a built ProductionDeliveryTargetSet and a ProductionDeliveryRenderResult',
    );
  }

  const repoRoot = path.resolve(input.repoRoot ?? ROOT);

  /* ── 1. package root safety, before anything is written ──────────── */
  // (1a) the lexical contract, shared with the core planner.
  const rootFindings = validateProductionPackageRoot(input.packageRoot, { repoRoot });
  if (rootFindings.length) {
    throw new ProductionDeliveryPackageError(
      'PACKAGE_ROOT_UNSAFE',
      `refusing to build a delivery package: ${rootFindings.map((f) => f.message).join('; ')}`,
      rootFindings,
    );
  }
  // (1b) the real filesystem: no symlinked component, no symlinked root, and
  // the resolved target must still live inside the real repository.
  const packageRoot = assertSafePackageRoot(repoRoot, input.packageRoot);
  const clean = input.clean ?? 'stale';

  // A recursive delete is only ever performed on a directory that already looks
  // exactly like a delivery package this service wrote. Anything else - a
  // caller directory, a source render directory, a partially populated tree -
  // is refused, and refused BEFORE a single byte is copied.
  if (clean === 'full' && isDirectory(packageRoot)) {
    const foreign = fs.readdirSync(packageRoot).filter((e) => !PRODUCTION_PACKAGE_ROOT_ENTRIES.includes(e));
    if (foreign.length > 0) {
      throw unsafePackagePath(
        `refusing to clear ${packageRoot}: it contains entries this package does not own (${foreign.slice(0, 5).join(', ')})`,
      );
    }
  }

  /* ── 2/3/4. copy, hash and probe every successful render output ──── */
  const mediaByTarget: Partial<Record<DeliveryTargetId, ProductionPackageMediaEvidence>> = {};
  const integrityBefore = new Map<DeliveryTargetId, { source: string; sha: string; size: number }>();

  for (const entry of renderResult.results) {
    if (!entry.success) continue;
    const targetId = entry.targetId;
    const evidence = emptyMediaEvidence(targetId);
    const source = typeof entry.outputFile === 'string' ? entry.outputFile.trim() : '';
    if (!source.length) {
      evidence.error = 'the render result reported no output file';
      mediaByTarget[targetId] = evidence;
      continue;
    }
    evidence.sourceRenderFile = source;
    evidence.sourceRenderFileName = path.basename(source);

    if (!isFile(source)) {
      evidence.error = `the render output ${path.basename(source)} does not exist`;
      mediaByTarget[targetId] = evidence;
      continue;
    }
    evidence.sourceExists = true;
    evidence.sourceSizeBytes = fs.statSync(source).size;

    try {
      const before = await sha256File(source);
      evidence.sourceSha256 = before;
      integrityBefore.set(targetId, { source, sha: before, size: evidence.sourceSizeBytes });

      const packagedVideo = packageTargetFile(targetId, 'video.mp4');
      const directory = path.posix.dirname(packagedVideo);
      // Refuse to follow a symlinked `long` / `shorts` / `shorts/short_N`.
      ensureSafePackageDir(packageRoot, directory);
      const destination = assertSafePackagePath(packageRoot, packagedVideo);
      // COPY. The source is never moved, renamed, rewritten or deleted.
      fs.copyFileSync(source, destination);

      evidence.copied = true;
      evidence.videoSha256 = await sha256File(destination);
      evidence.sizeBytes = fs.statSync(destination).size;
    } catch (err) {
      // An unsafe package path aborts the whole build: it must never be
      // downgraded into a per-target failure and quietly "package around".
      if (err instanceof ProductionDeliveryPackageError) throw err;
      evidence.error = `could not copy the render output into the package: ${(err as Error)?.message ?? String(err)}`;
    }

    if (evidence.copied) {
      const destination = assertSafePackagePath(packageRoot, packageTargetFile(targetId, 'video.mp4'));
      const probed = await probePackagedMedia(destination);
      evidence.metrics = probed.metrics;
      if (probed.error && !evidence.error) evidence.error = probed.error;
    }

    mediaByTarget[targetId] = evidence;
  }

  /* ── 5. the pure planner decides everything ─────────────────────── */
  const planInput: BuildDeliveryPackageInput = {
    targetSet,
    renderResult,
    packageRoot,
    repoRoot: input.repoRoot ?? ROOT,
    mediaByTarget,
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
  };
  const pkg = buildProductionDeliveryPackagePlan(planInput);

  /* ── 6. materialise exactly what the planner produced ───────────── */
  if (clean === 'full' && isDirectory(packageRoot)) {
    // Prove ownership again IMMEDIATELY before the recursive delete: the root
    // must still be the expected, real, non-symlinked directory, must still
    // resolve inside the real repository, and must still contain nothing but
    // package-owned entries. A symlink swap between the pre-check and here
    // must not turn into a recursive delete through an external target.
    assertSafePackageRoot(repoRoot, input.packageRoot);
    const rootStats = lstatOrNull(packageRoot);
    if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw unsafePackagePath(`refusing to clear ${packageRoot}: it is not a real directory`);
    }
    const foreign = fs.readdirSync(packageRoot).filter((e) => !PRODUCTION_PACKAGE_ROOT_ENTRIES.includes(e));
    if (foreign.length > 0) {
      throw unsafePackagePath(
        `refusing to clear ${packageRoot}: it contains entries this package does not own (${foreign.slice(0, 5).join(', ')})`,
      );
    }
    // A package-owned root entry that is a symlink is never followed by the
    // recursive delete. The guarantee is made explicitly here rather than
    // relying on rmSync's symlink handling.
    for (const entry of PRODUCTION_PACKAGE_ROOT_ENTRIES) {
      const child = path.join(packageRoot, entry);
      if (lstatOrNull(child)?.isSymbolicLink()) {
        throw unsafePackagePath(
          `refusing to clear ${packageRoot}: the package-owned entry ${child} is a symbolic link to ${realpathOrSelf(child)}`,
        );
      }
    }
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
  ensureSafePackageRootDir(repoRoot, input.packageRoot);

  if (clean === 'stale') {
    // Only package-owned target directories are ever removed, and only the ones
    // this build does not produce. Nothing outside the package is touched, and
    // a symlinked `long` / `shorts` / `shorts/short_N` is refused rather than
    // followed.
    const produced = new Set(pkg.targets.filter((t) => t.status === 'packaged').map((t) => packageTargetDirectory(t.targetId)));
    for (const targetId of ['long', 'short_1', 'short_2', 'short_3'] as DeliveryTargetId[]) {
      if (produced.has(packageTargetDirectory(targetId))) continue;
      removeSafePackageDir(packageRoot, packageTargetDirectory(targetId));
    }
  }
  for (const relative of pkg.removePaths) {
    removeSafePackageDir(packageRoot, relative);
  }

  const writtenFiles: string[] = [];
  for (const file of pkg.files) {
    const directory = path.posix.dirname(file.path);
    // Never write through a symlinked `manifest/`, `evidence/`, `long/` or
    // `shorts/short_N/`: the destination is proven safe for THIS file, and
    // proved again immediately before the write.
    ensureSafePackageDir(packageRoot, directory);
    const destination = assertSafePackagePath(packageRoot, file.path);
    if (file.contents !== null) {
      fs.writeFileSync(destination, file.contents, 'utf8');
    } else if (file.copyFrom !== null) {
      if (!isFile(file.copyFrom)) {
        throw new ProductionDeliveryPackageError(
          'PACKAGE_COPY_FAILED',
          `the packaged media source for ${file.path} disappeared before it could be copied`,
        );
      }
      // COPY again from the plan's own record of the source: idempotent and
      // still never a move.
      fs.copyFileSync(file.copyFrom, destination);
    } else {
      throw new ProductionDeliveryPackageError('PACKAGE_COPY_FAILED', `package file ${file.path} has neither contents nor a source to copy`);
    }
    writtenFiles.push(file.path);
  }

  /* ── 7. prove the sources were not mutated ──────────────────────── */
  const sourceIntegrity: ProductionPackageSourceIntegrity[] = [];
  for (const [targetId, before] of integrityBefore) {
    const evidence = mediaByTarget[targetId]!;
    const after = isFile(before.source) ? await sha256File(before.source) : null;
    sourceIntegrity.push({
      targetId,
      sourceRenderFile: before.source,
      sha256Before: before.sha,
      sha256After: after,
      packagedSha256: evidence.videoSha256,
      sizeBytes: before.size,
      unchanged: after === before.sha,
      packagedMatchesSource: !!evidence.videoSha256 && evidence.videoSha256 === before.sha,
    });
  }

  return {
    version: PRODUCTION_DELIVERY_PACKAGE_VERSION,
    packageRoot,
    package: pkg,
    writtenFiles,
    removedPaths: pkg.removePaths,
    sourceIntegrity,
  };
}

/* ------------------------------------------------------------------ */
/*  Consumers                                                           */
/* ------------------------------------------------------------------ */

/** Error-severity package findings, in emission order. */
export function productionPackageErrors(findings: readonly ProductionPackageFinding[]): ProductionPackageFinding[] {
  return findings.filter((f) => f.severity === 'error');
}

/** The codes a caller most often gates on, without re-deriving them. */
export function productionPackageErrorCodes(
  findings: readonly ProductionPackageFinding[],
): ProductionPackageFindingCode[] {
  return [...new Set(productionPackageErrors(findings).map((f) => f.code))];
}

/** Re-serialise a manifest exactly as it is written to disk (audit helper). */
export function productionPackageManifestJson(pkg: ProductionDeliveryPackage): string {
  return serialisePackageJson(pkg.manifest);
}

export type { ProductionDeliveryPackageFile };
