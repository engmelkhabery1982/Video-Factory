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
 *   1. refuse an unsafe package root (before ANY filesystem write);
 *   2. hash each source render output;
 *   3. COPY each successful render output into its package directory;
 *   4. hash + probe the COPIED file;
 *   5. let the pure core planner decide matching, captions, QC, manifest;
 *   6. write exactly the files the planner produced, drop failed-target dirs;
 *   7. re-hash the sources to prove they were not mutated.
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

  /* ── 1. package root safety, before anything is written ──────────── */
  const rootFindings = validateProductionPackageRoot(input.packageRoot, { repoRoot: input.repoRoot ?? ROOT });
  if (rootFindings.length) {
    throw new ProductionDeliveryPackageError(
      'PACKAGE_ROOT_UNSAFE',
      `refusing to build a delivery package: ${rootFindings.map((f) => f.message).join('; ')}`,
      rootFindings,
    );
  }
  const packageRoot = path.resolve(input.repoRoot ?? ROOT, input.packageRoot);
  const clean = input.clean ?? 'stale';

  // A recursive delete is only ever performed on a directory that already looks
  // exactly like a delivery package this service wrote. Anything else - a
  // caller directory, a source render directory, a partially populated tree -
  // is refused, and refused BEFORE a single byte is copied.
  if (clean === 'full' && isDirectory(packageRoot)) {
    const foreign = fs.readdirSync(packageRoot).filter((e) => !PRODUCTION_PACKAGE_ROOT_ENTRIES.includes(e));
    if (foreign.length > 0) {
      throw new ProductionDeliveryPackageError(
        'PACKAGE_ROOT_UNSAFE',
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
      const destination = path.join(packageRoot, ...packagedVideo.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      // COPY. The source is never moved, renamed, rewritten or deleted.
      fs.copyFileSync(source, destination);

      evidence.copied = true;
      evidence.videoSha256 = await sha256File(destination);
      evidence.sizeBytes = fs.statSync(destination).size;
    } catch (err) {
      evidence.error = `could not copy the render output into the package: ${(err as Error)?.message ?? String(err)}`;
    }

    if (evidence.copied) {
      const destination = path.join(packageRoot, ...packageTargetFile(targetId, 'video.mp4').split('/'));
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
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(packageRoot, { recursive: true });

  if (clean === 'stale') {
    // Only package-owned target directories are ever removed, and only the ones
    // this build does not produce. Nothing outside the package is touched.
    const produced = new Set(pkg.targets.filter((t) => t.status === 'packaged').map((t) => packageTargetDirectory(t.targetId)));
    for (const targetId of ['long', 'short_1', 'short_2', 'short_3'] as DeliveryTargetId[]) {
      if (produced.has(packageTargetDirectory(targetId))) continue;
      const stale = path.join(packageRoot, ...packageTargetDirectory(targetId).split('/'));
      if (isDirectory(stale)) fs.rmSync(stale, { recursive: true, force: true });
    }
  }
  for (const relative of pkg.removePaths) {
    const stale = path.join(packageRoot, ...relative.split('/'));
    if (isDirectory(stale)) fs.rmSync(stale, { recursive: true, force: true });
  }

  const writtenFiles: string[] = [];
  for (const file of pkg.files) {
    const destination = path.join(packageRoot, ...file.path.split('/'));
    if (file.contents !== null) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.contents, 'utf8');
    } else if (file.copyFrom !== null) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
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
