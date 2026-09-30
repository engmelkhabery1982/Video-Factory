/**
 * BuildTrack Video Factory - Phase 6D Production Delivery Package Contract
 *
 * Phase 6D turns APPROVED Phase 6C delivery output into a deterministic,
 * auditable production DELIVERY PACKAGE. It creates no video content, no
 * Long/Short plan, and no legacy storyboard:
 *
 *   ProductionDeliveryTargetSet        (identity authority)
 *   + ProductionDeliveryRenderResult   (media outcome authority)
 *   + actually rendered MP4 files
 *        -> ProductionDeliveryPackage
 *
 * Authority rule: the ONLY inputs are the plan-based Phase 6C contract. Legacy
 * `Project.storyboard`, `TargetMedia`, `Scene[]`, `voiceoverFile`, `targetAudio`
 * and `storyboard.captions` are NOT package authority and are never accepted
 * here. Target identity is NEVER inferred from a filename or a path segment.
 *
 * Determinism: the manifest, the checksum file, every per-target descriptor and
 * every QC report are byte-stable for the same logical input and the same
 * artifact bytes. There are no timestamps, no random ids, no absolute paths, no
 * host names and no filesystem ordering anywhere in the emitted package.
 */

import type {
  DeliveryTargetFormat,
  DeliveryTargetId,
  ProductionDeliveryRenderResult,
  ProductionDeliveryTarget,
  ProductionDeliveryTargetSet,
} from './delivery-target-types.js';

export const PRODUCTION_DELIVERY_PACKAGE_VERSION = '1.0.0' as const;

/* ------------------------------------------------------------------ */
/*  Package status                                                      */
/* ------------------------------------------------------------------ */

/**
 * READY   - every requested target rendered AND passed required QC AND carries
 *           full plan frame coverage. This is the only status that may ship.
 * PARTIAL - at least one requested target is valid and packageable while
 *           another requested target failed, or a packaged target is not yet
 *           production-ready (test evidence, partial frame coverage).
 * BLOCKED - nothing is safely packageable, or a package-wide integrity rule
 *           failed. A blocked package never claims readiness.
 *
 * A failed target is NEVER downgraded to a warning to make a package ready.
 */
export type ProductionDeliveryPackageStatus = 'ready' | 'partial' | 'blocked';

/** Per-target package outcome. A failed target gets no media directory. */
export type ProductionPackageTargetStatus = 'packaged' | 'failed';

/** Per-target QC verdict. */
export type ProductionTargetQcStatus = 'pass' | 'warn' | 'fail';

/**
 * `production`      - the only mode that may reach READY.
 * `test-evidence`   - a cost-controlled render (for example a frame sub-range)
 *                     whose mechanics are proven but which is explicitly NOT a
 *                     full delivery artifact. Downgrades readiness; it never
 *                     relaxes production duration QC.
 */
export type ProductionPackageMode = 'production' | 'test-evidence';

export type ProductionPackageFileKind = 'media' | 'captions' | 'descriptor' | 'qc' | 'manifest' | 'checksums' | 'evidence';

/* ------------------------------------------------------------------ */
/*  Stable package file names (no environment-dependent names)          */
/* ------------------------------------------------------------------ */

export const PRODUCTION_PACKAGE_FILE_NAMES = {
  manifestDir: 'manifest',
  manifest: 'delivery_manifest.json',
  checksums: 'checksums.sha256',
  longDir: 'long',
  shortsDir: 'shorts',
  evidenceDir: 'evidence',
  packageSummary: 'package_summary.json',
  video: 'video.mp4',
  captionsSrt: 'captions.srt',
  captionsVtt: 'captions.vtt',
  captionsJson: 'captions.json',
  descriptor: 'target.json',
  qcJson: 'qc.json',
  qcMarkdown: 'qc.md',
} as const;

/* ------------------------------------------------------------------ */
/*  Findings                                                            */
/* ------------------------------------------------------------------ */

export type ProductionPackageFindingSeverity = 'error' | 'warning';

/**
 * Small, closed package/QC vocabulary. Deliberately NOT a second QC
 * framework: it sits beside the Phase 6B `PlanRenderErrorCode` it delegates
 * structural checks to.
 */
export type ProductionPackageFindingCode =
  /* package-root safety */
  | 'PACKAGE_ROOT_UNSAFE'
  /* target / render-result identity */
  | 'PACKAGE_RENDER_RESULT_MISMATCH'
  | 'PACKAGE_RENDER_FAILED'
  | 'PACKAGE_TARGET_MISMATCH'
  | 'PACKAGE_PLAN_INVALID'
  /* packaged media integrity */
  | 'PACKAGE_FILE_MISSING'
  | 'PACKAGE_FILE_EMPTY'
  | 'PACKAGE_MEDIA_PROBE_FAILED'
  | 'PACKAGE_CHECKSUM_MISMATCH'
  /* technical media QC */
  | 'PACKAGE_VIDEO_CODEC_MISMATCH'
  | 'PACKAGE_DIMENSIONS_MISMATCH'
  | 'PACKAGE_FPS_MISMATCH'
  | 'PACKAGE_AUDIO_MISSING'
  | 'PACKAGE_AUDIO_CODEC_MISMATCH'
  | 'PACKAGE_DURATION_TRUNCATED'
  | 'PACKAGE_DURATION_EXCESSIVE'
  | 'PACKAGE_AUDIO_SILENT'
  | 'PACKAGE_PARTIAL_FRAME_COVERAGE'
  /* captions */
  | 'PACKAGE_CAPTION_INVALID';

export const PRODUCTION_PACKAGE_FINDING_CODES: readonly ProductionPackageFindingCode[] = [
  'PACKAGE_ROOT_UNSAFE',
  'PACKAGE_RENDER_RESULT_MISMATCH',
  'PACKAGE_RENDER_FAILED',
  'PACKAGE_TARGET_MISMATCH',
  'PACKAGE_PLAN_INVALID',
  'PACKAGE_FILE_MISSING',
  'PACKAGE_FILE_EMPTY',
  'PACKAGE_MEDIA_PROBE_FAILED',
  'PACKAGE_CHECKSUM_MISMATCH',
  'PACKAGE_VIDEO_CODEC_MISMATCH',
  'PACKAGE_DIMENSIONS_MISMATCH',
  'PACKAGE_FPS_MISMATCH',
  'PACKAGE_AUDIO_MISSING',
  'PACKAGE_AUDIO_CODEC_MISMATCH',
  'PACKAGE_DURATION_TRUNCATED',
  'PACKAGE_DURATION_EXCESSIVE',
  'PACKAGE_AUDIO_SILENT',
  'PACKAGE_PARTIAL_FRAME_COVERAGE',
  'PACKAGE_CAPTION_INVALID',
] as const;

/** Structured, machine-readable package finding. `targetId` keeps failures isolated. */
export interface ProductionPackageFinding {
  severity: ProductionPackageFindingSeverity;
  code: ProductionPackageFindingCode;
  message: string;
  targetId?: DeliveryTargetId;
  sceneId?: string;
  /** Package-relative artifact path. Never absolute. */
  artifact?: string;
}

/* ------------------------------------------------------------------ */
/*  Media evidence (measured from the COPIED packaged MP4)              */
/* ------------------------------------------------------------------ */

/**
 * Real media facts taken from the COPIED packaged MP4 via the existing
 * `analyseFile(...)` probe. ffprobe infrastructure is never duplicated.
 */
export interface ProductionTargetTechnicalMetrics {
  exists: boolean;
  sizeBytes: number;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  /** Parsed numeric frame rate (e.g. 30). */
  fps: number | null;
  /** Raw probe frame-rate ratio (e.g. `30/1`), kept for audit. */
  fpsRatio: string | null;
  /** Container/stream duration in seconds as reported by ffprobe. */
  durationSeconds: number | null;
  hasAudio: boolean;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  containerFormat: string | null;
  /** Black-frame evidence, when the existing analyser reports it. */
  blackSeconds: number | null;
  blackIntervals: number | null;
  /** Silence evidence, when the existing analyser reports it. */
  longestSilenceSeconds: number | null;
  silenceCount: number | null;
}

/** An empty metric record for a target whose media could not be inspected. */
export function emptyProductionTargetTechnicalMetrics(): ProductionTargetTechnicalMetrics {
  return {
    exists: false,
    sizeBytes: 0,
    videoCodec: null,
    width: null,
    height: null,
    fps: null,
    fpsRatio: null,
    durationSeconds: null,
    hasAudio: false,
    audioCodec: null,
    audioSampleRate: null,
    audioChannels: null,
    containerFormat: null,
    blackSeconds: null,
    blackIntervals: null,
    longestSilenceSeconds: null,
    silenceCount: null,
  };
}

/**
 * What the package layer measured for one target's source render output.
 *
 * `sourceRenderFile` is an ABSOLUTE path and is plumbing only: it is never
 * written into any packaged metadata file. `sourceRenderFileName` is the
 * audit-safe basename that IS recorded in `target.json`.
 */
export interface ProductionPackageMediaEvidence {
  targetId: DeliveryTargetId;
  /** Absolute path of the Phase 6C render output. Never serialised. */
  sourceRenderFile: string | null;
  /** Audit-safe basename of the source render output. */
  sourceRenderFileName: string | null;
  /** True when the source render output exists as a regular file. */
  sourceExists: boolean;
  /** Byte length of the source render output. */
  sourceSizeBytes: number;
  /** SHA256 of the source render output, measured BEFORE the copy. */
  sourceSha256: string | null;
  /** True once the source has been COPIED into the package (never moved). */
  copied: boolean;
  /** SHA256 of the COPIED packaged media. */
  videoSha256: string | null;
  /** Byte length of the COPIED packaged media. */
  sizeBytes: number;
  /** Probe of the COPIED packaged media. */
  metrics: ProductionTargetTechnicalMetrics | null;
  /** Structured copy/probe failure, if any. */
  error: string | null;
}

export function emptyProductionPackageMediaEvidence(targetId: DeliveryTargetId): ProductionPackageMediaEvidence {
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
/*  QC                                                                  */
/* ------------------------------------------------------------------ */

/**
 * The plan-vs-actual table behind a target's QC verdict. Every number here is
 * either a plan authority value or a measured value from the packaged copy -
 * never an estimate, and never a legacy storyboard value.
 */
export interface ProductionTargetQcMetrics {
  /* plan authority */
  expectedWidth: number;
  expectedHeight: number;
  expectedFps: number;
  expectedDurationInFrames: number;
  /** Phase 4 actual timing - the timing authority. */
  authoritativeDurationSeconds: number;
  /** `durationInFrames / fps` - the structural frame capacity. */
  frameCapacitySeconds: number;
  /* render coverage */
  renderedFrameCount: number | null;
  fullFrameCoverage: boolean;
  /* plan content counts */
  sceneCount: number;
  canonicalAudioRefCount: number;
  captionCueCount: number;
  assetRefCount: number;
  mediaMapEntryCount: number;
  /* measured media */
  exists: boolean;
  sizeBytes: number;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  fpsRatio: string | null;
  durationSeconds: number | null;
  hasAudio: boolean;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  containerFormat: string | null;
  blackSeconds: number | null;
  blackIntervals: number | null;
  longestSilenceSeconds: number | null;
  silenceCount: number | null;
  /** `measured - frameCapacity`; positive padding is expected and allowed. */
  containerPaddingSeconds: number | null;
  /* integrity */
  videoSha256: string | null;
  sourceSha256: string | null;
  /** True when the source render output is byte-identical after packaging. */
  sourceUnchanged: boolean;
}

/**
 * Plan-based QC for one packaged target. Independent of legacy
 * `Project`/`Storyboard` QC.
 */
export interface ProductionTargetQcResult {
  targetId: DeliveryTargetId;
  status: ProductionTargetQcStatus;
  findings: ProductionPackageFinding[];
  metrics: ProductionTargetQcMetrics;
  /** True only in `production` mode with full plan frame coverage. */
  productionReady: boolean;
}

/* ------------------------------------------------------------------ */
/*  Captions                                                            */
/* ------------------------------------------------------------------ */

/**
 * One plan-derived caption cue. Sourced ONLY from
 * `target.plan.scenes[].captionCues`; never from `storyboard.captions` or
 * `shortCaptions`.
 */
export interface ProductionPackageCaptionCue {
  index: number;
  id: string;
  sceneId: string;
  sceneIndex: number;
  start: number;
  end: number;
  duration: number;
  startFrame: number;
  endFrame: number;
  text: string;
}

/** The `captions.json` document. */
export interface ProductionPackageCaptionDocument {
  version: typeof PRODUCTION_DELIVERY_PACKAGE_VERSION;
  packageContractVersion: typeof PRODUCTION_DELIVERY_PACKAGE_VERSION;
  targetId: DeliveryTargetId;
  format: DeliveryTargetFormat;
  scenarioId: string;
  projectId: string;
  fps: number;
  durationInFrames: number;
  authoritativeDurationSeconds: number;
  count: number;
  cues: ProductionPackageCaptionCue[];
}

/* ------------------------------------------------------------------ */
/*  Target descriptor (`target.json`)                                   */
/* ------------------------------------------------------------------ */

export interface ProductionPackageTargetDescriptor {
  packageContractVersion: typeof PRODUCTION_DELIVERY_PACKAGE_VERSION;
  targetId: DeliveryTargetId;
  format: DeliveryTargetFormat;
  scenarioId: string;
  projectId: string;
  width: number;
  height: number;
  fps: number;
  authoritativeDurationSeconds: number;
  durationInFrames: number;
  sceneCount: number;
  canonicalAudioRefCount: number;
  captionCueCount: number;
  assetRefCount: number;
  mediaMapEntryCount: number;
  compositionId: string;
  renderedWithAudio: boolean;
  renderedFrameCount: number | null;
  fullFrameCoverage: boolean;
  /** Audit-safe basename of the Phase 6C render output. Never a full path. */
  sourceRenderFile: string | null;
  /** Package-relative packaged media path. */
  packagedVideoFile: string;
  videoSha256: string;
  qcStatus: ProductionTargetQcStatus;
}

/* ------------------------------------------------------------------ */
/*  Files                                                               */
/* ------------------------------------------------------------------ */

/**
 * One file the package owns. Exactly one of `contents` (UTF-8 text) or
 * `copyFrom` (absolute source to COPY, never move) is set.
 */
export interface ProductionDeliveryPackageFile {
  /** Package-relative POSIX path, e.g. `long/video.mp4`. */
  path: string;
  kind: ProductionPackageFileKind;
  targetId: DeliveryTargetId | null;
  sha256: string;
  sizeBytes: number;
  contents: string | null;
  copyFrom: string | null;
}

/** One `manifest/checksums.sha256` entry: package-relative path + SHA256. */
export interface ProductionPackageChecksumEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
}

/* ------------------------------------------------------------------ */
/*  Manifest                                                            */
/* ------------------------------------------------------------------ */

export interface ProductionPackageManifestTargetEntry {
  targetId: DeliveryTargetId;
  format: DeliveryTargetFormat | null;
  scenarioId: string | null;
  projectId: string | null;
  status: ProductionPackageTargetStatus;
  /** True only when the target may ship as a full production delivery. */
  productionReady: boolean;
  video: {
    path: string;
    sha256: string;
    sizeBytes: number;
    /** Audit-safe basename of the Phase 6C render output. */
    sourceRenderFile: string | null;
    sourceSha256: string | null;
    sourceUnchanged: boolean;
  } | null;
  captions: { srt: string; vtt: string; json: string } | null;
  qc: { json: string; markdown: string; status: ProductionTargetQcStatus } | null;
  descriptor: string | null;
  videoSha256: string | null;
  error: { code: string; message: string } | null;
}

export interface ProductionDeliveryPackageManifest {
  version: typeof PRODUCTION_DELIVERY_PACKAGE_VERSION;
  packageContractVersion: typeof PRODUCTION_DELIVERY_PACKAGE_VERSION;
  projectId: string | null;
  status: ProductionDeliveryPackageStatus;
  mode: ProductionPackageMode;
  /** The single field a caller may gate delivery on. */
  readyForProductionDelivery: boolean;
  requestedTargetIds: DeliveryTargetId[];
  packagedTargetIds: DeliveryTargetId[];
  failedTargetIds: DeliveryTargetId[];
  /** Always long -> short_1 -> short_2 -> short_3. Never filesystem order. */
  targets: ProductionPackageManifestTargetEntry[];
  summary: ProductionDeliveryPackageSummary;
  /** Package-relative artifacts, lexicographically sorted. */
  artifacts: { path: string; kind: ProductionPackageFileKind; sizeBytes: number; sha256: string }[];
  checksumsFile: string;
}

/* ------------------------------------------------------------------ */
/*  Summary (`evidence/package_summary.json`)                          */
/* ------------------------------------------------------------------ */

export interface ProductionDeliveryPackageSummary {
  packageStatus: ProductionDeliveryPackageStatus;
  mode: ProductionPackageMode;
  readyForProductionDelivery: boolean;
  projectId: string | null;
  requestedTargetIds: DeliveryTargetId[];
  renderSucceededTargetIds: DeliveryTargetId[];
  packagedTargetIds: DeliveryTargetId[];
  failedTargetIds: DeliveryTargetId[];
  targetOrder: DeliveryTargetId[];
  longCount: number;
  shortCount: number;
  qcPassCount: number;
  qcWarnCount: number;
  qcFailCount: number;
  artifactCount: number;
  checksumCount: number;
  totalPackagedBytes: number;
  errorCount: number;
  warningCount: number;
}

/* ------------------------------------------------------------------ */
/*  The package                                                         */
/* ------------------------------------------------------------------ */

export interface ProductionDeliveryPackageTarget {
  targetId: DeliveryTargetId;
  format: DeliveryTargetFormat | null;
  scenarioId: string | null;
  projectId: string | null;
  status: ProductionPackageTargetStatus;
  productionReady: boolean;
  /** Package-relative directory, or null for a failed target. */
  directory: string | null;
  descriptor: ProductionPackageTargetDescriptor | null;
  qc: ProductionTargetQcResult | null;
  captions: ProductionPackageCaptionDocument | null;
  error: { code: string; message: string } | null;
}

export interface ProductionDeliveryPackage {
  version: typeof PRODUCTION_DELIVERY_PACKAGE_VERSION;
  mode: ProductionPackageMode;
  status: ProductionDeliveryPackageStatus;
  readyForProductionDelivery: boolean;
  projectId: string | null;
  /** The caller-supplied package root. Runtime only; never written to a file. */
  packageRoot: string;
  targetSet: ProductionDeliveryTargetSet;
  renderResult: ProductionDeliveryRenderResult;
  /** Every requested target, in canonical order, packaged or failed. */
  targets: ProductionDeliveryPackageTarget[];
  findings: ProductionPackageFinding[];
  manifest: ProductionDeliveryPackageManifest;
  summary: ProductionDeliveryPackageSummary;
  /** Files the package owns, ordered manifest-first then lexicographically. */
  files: ProductionDeliveryPackageFile[];
  /** Checksum entries, lexicographically sorted by package-relative path. */
  checksums: ProductionPackageChecksumEntry[];
  /** Package-relative directories the materialiser must remove (failed targets). */
  removePaths: string[];
  valid: boolean;
}

/* ------------------------------------------------------------------ */
/*  Build input                                                         */
/* ------------------------------------------------------------------ */

/**
 * Input of the pure, filesystem-free package planner.
 *
 * Only plan-based Phase 6C authority is accepted. There is no `Project`, no
 * `Storyboard`, no `Scene[]` and no legacy caption map anywhere in this input.
 */
export interface BuildDeliveryPackageInput {
  /** Identity authority: the Phase 6C target set. */
  targetSet: ProductionDeliveryTargetSet;
  /** Media outcome authority: the Phase 6C render result. */
  renderResult: ProductionDeliveryRenderResult;
  /** Where the package will be written. Only used for safety checks + messages. */
  packageRoot: string;
  /**
   * Repository root, so the planner can refuse `packageRoot === repoRoot`.
   * The API service passes the real repo root; tests may pass the cwd.
   */
  repoRoot?: string | null;
  /** What the materialiser measured for each target's render output. */
  mediaByTarget?: Partial<Record<DeliveryTargetId, ProductionPackageMediaEvidence>> | null;
  /**
   * `production` by default. `test-evidence` marks a cost-controlled render as
   * mechanics-only evidence and can never reach READY.
   */
  mode?: ProductionPackageMode;
}

/* ------------------------------------------------------------------ */
/*  QC policy constants (documented, deterministic, no re-derivation)   */
/* ------------------------------------------------------------------ */

/**
 * Duration QC policy (Phase 6D §15).
 *
 * The plan is the timing authority. The packaged video FAILS only when its
 * real media ends BEFORE the plan's structural frame capacity, allowing a small
 * renderer/container tolerance. Positive AAC/container padding is expected and
 * is never reported as timing drift.
 *
 * Rationale: the canonical Long is 118.74 authoritative seconds =
 * 3563 / 30 = 118.7667s of frame capacity. An AAC encoder prime plus the MP4
 * edit list legitimately extends the measured container duration past that, so
 * `ffprobe duration === 118.74` is explicitly NOT required.
 */
export const PRODUCTION_PACKAGE_DURATION_POLICY = {
  /** Seconds of measured media tolerated below the frame capacity. */
  truncationToleranceSeconds: 0.5,
  /** Seconds of positive container/audio padding tolerated above it. */
  maxContainerPaddingSeconds: 2.0,
  /** Frame-rate tolerance (a probed rate must be within this of the plan's). */
  fpsTolerance: 0.5,
  /**
   * A fully silent audio stream is a blocking defect. Silence shorter than this
   * is normal dialogue pause and is never a failure.
   */
  fullySilentSecondsThreshold: 1.0,
} as const;

/** Video codec families accepted for the current production render. */
export const PRODUCTION_PACKAGE_VIDEO_CODEC_FAMILY = ['h264', 'avc1', 'h264_qsv', 'h264_nvenc', 'libx264'] as const;

/** Audio codec families accepted for the current production render. */
export const PRODUCTION_PACKAGE_AUDIO_CODEC_FAMILY = ['aac', 'mp4a'] as const;
