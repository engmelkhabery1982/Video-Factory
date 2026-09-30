/**
 * BuildTrack Video Factory - Phase 6D Production Delivery Package Pipeline
 *
 * The deterministic, filesystem-free planner that turns APPROVED Phase 6C
 * delivery output into a production DELIVERY PACKAGE.
 *
 *   ProductionDeliveryTargetSet        (identity authority)
 *   + ProductionDeliveryRenderResult   (media outcome authority)
 *   + measured media evidence
 *        -> ProductionDeliveryPackage
 *
 * What this module does:
 *   - matches every render result back to the target set by IDENTITY
 *     (targetId / scenarioId / projectId / format / outputFile), never by
 *     filename;
 *   - derives delivery captions ONLY from `target.plan.scenes[].captionCues`
 *     and validates them against the plan's authoritative timing;
 *   - runs technical QC of the measured packaged media against the plan
 *     contract (codec, dimensions, fps, audio, duration coverage);
 *   - delegates structural plan validation to the Phase 6B
 *     `validatePlanForRender(...)` instead of duplicating it;
 *   - builds a byte-stable manifest, checksum file, target descriptors and QC
 *     reports.
 *
 * What this module does NOT do:
 *   - it never writes to disk (the API materialiser does that);
 *   - it never renders, plans, retimes, remuxes or re-encodes anything;
 *   - it never resolves assets (Phase 6A owns resolution);
 *   - it never reads legacy `Project.storyboard` / `Scene[]` / `TargetMedia`.
 *
 * Determinism: no timestamps, no randomness, no absolute paths, no host names
 * and no filesystem ordering in anything this module emits. Every ordered list
 * is sorted by `DELIVERY_TARGET_ORDER` (targets) or lexicographically by
 * package-relative path (artifacts, checksums).
 */

import { createHash } from 'node:crypto';

import { toSrt, toVtt } from '../captions.js';
import type { CaptionCue } from '../types.js';
import { validatePlanForRender } from './plan-render-validation.js';
import { sortDeliveryTargetIds } from './delivery-target-pipeline.js';
import {
  DELIVERY_TARGET_ORDER,
  LONG_DELIVERY_TARGET_ID,
  expectedFormatForTargetId,
  type DeliveryTargetFormat,
  type DeliveryTargetId,
  type ProductionDeliveryRenderResult,
  type ProductionDeliveryTarget,
  type ProductionDeliveryTargetRenderResult,
  type ProductionDeliveryTargetSet,
} from './delivery-target-types.js';
import {
  PRODUCTION_DELIVERY_PACKAGE_VERSION,
  PRODUCTION_PACKAGE_AUDIO_CODEC_FAMILY,
  PRODUCTION_PACKAGE_DURATION_POLICY,
  PRODUCTION_PACKAGE_FILE_NAMES,
  PRODUCTION_PACKAGE_VIDEO_CODEC_FAMILY,
  emptyProductionPackageMediaEvidence,
  emptyProductionTargetTechnicalMetrics,
  type BuildDeliveryPackageInput,
  type ProductionDeliveryPackage,
  type ProductionDeliveryPackageFile,
  type ProductionDeliveryPackageManifest,
  type ProductionPackageManifestTargetEntry,
  type ProductionDeliveryPackageSummary,
  type ProductionDeliveryPackageTarget,
  type ProductionPackageCaptionCue,
  type ProductionPackageCaptionDocument,
  type ProductionPackageChecksumEntry,
  type ProductionPackageFileKind,
  type ProductionPackageFinding,
  type ProductionPackageMediaEvidence,
  type ProductionPackageMode,
  type ProductionPackageTargetDescriptor,
  type ProductionPackageTargetStatus,
  type ProductionTargetQcMetrics,
  type ProductionTargetQcResult,
  type ProductionTargetQcStatus,
} from './delivery-package-types.js';

/* ------------------------------------------------------------------ */
/*  Small deterministic helpers                                         */
/* ------------------------------------------------------------------ */

/** SHA256 of a UTF-8 string. The only I/O this module performs. */
export function sha256Hex(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/** Stable, pretty, newline-terminated JSON. */
export function serialisePackageJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function byteLength(contents: string): number {
  return Buffer.byteLength(contents, 'utf8');
}

/** Package-relative path joining. Always POSIX separators. */
export function packagePath(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join('/');
}

/** Audit-safe reference to a source render file: its basename only. */
export function auditSafeSourceName(sourceRenderFile: string | null | undefined): string | null {
  if (typeof sourceRenderFile !== 'string') return null;
  const trimmed = sourceRenderFile.trim();
  if (!trimmed.length) return null;
  const parts = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : null;
}

function normalisePathValue(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

function round(value: number | null | undefined, digits = 3): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function fmtSeconds(value: number | null | undefined): string {
  const r = round(value, 3);
  return r === null ? 'n/a' : `${r.toFixed(3)} s`;
}

function fmtInt(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? 'n/a' : String(value);
}

function fmtOrNa(value: string | number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : String(value);
}

/** Parse `30/1` into 30. Returns null for a malformed ratio. */
export function parseFpsRatio(ratio: string | null | undefined): number | null {
  if (typeof ratio !== 'string') return null;
  const match = ratio.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    const num = Number(match[1]);
    const den = Number(match[2]);
    if (!den) return null;
    return round(num / den, 6);
  }
  const n = Number(ratio);
  return Number.isFinite(n) && n > 0 ? round(n, 6) : null;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/* ------------------------------------------------------------------ */
/*  Package root safety                                                 */
/* ------------------------------------------------------------------ */

/**
 * Package-root safety (Phase 6D §24).
 *
 * The delivery package is a repository-owned output, so the rule is simple and
 * total: the package root must resolve to a STRICT DESCENDANT of the
 * repository root. That single rule already refuses
 *
 *   - an empty / whitespace-only root,
 *   - the filesystem root,
 *   - the repository root itself (`repo`, `.`, `./`, `apps/../..`),
 *   - any ANCESTOR of the repository root (`..`, `../..`, `/home/user`),
 *   - any SIBLING or unrelated path outside the repository,
 *   - a path containing a null byte.
 *
 * Resolution is lexical (`..` is collapsed without touching the filesystem) so
 * a symlink cannot smuggle an escape past it, and this function never reads,
 * writes or deletes anything.
 */
export function validateProductionPackageRoot(
  packageRoot: unknown,
  options: { repoRoot?: string | null } = {},
): ProductionPackageFinding[] {
  const out: ProductionPackageFinding[] = [];
  const fail = (message: string) => out.push({ severity: 'error', code: 'PACKAGE_ROOT_UNSAFE', message });

  if (typeof packageRoot !== 'string' || packageRoot.trim().length === 0) {
    fail('packageRoot must be a non-empty path');
    return out;
  }
  if (packageRoot.includes('\0')) {
    fail('packageRoot must not contain a null byte');
    return out;
  }

  const repoRoot = typeof options.repoRoot === 'string' && options.repoRoot.trim().length > 0 ? options.repoRoot.trim() : toPosix(process.cwd());

  // Lexical resolution: no symlink following, no filesystem access.
  const resolveLexically = (value: string, base: string): string => {
    const stack: string[] = value.startsWith('/') ? [] : toPosix(base).split('/').filter(Boolean);
    for (const part of toPosix(value).split('/')) {
      if (!part.length || part === '.') continue;
      if (part === '..') {
        if (stack.length) stack.pop();
        continue;
      }
      stack.push(part);
    }
    return `/${stack.join('/')}`;
  };

  const resolved = resolveLexically(packageRoot.trim(), repoRoot);
  const resolvedRepo = resolveLexically(repoRoot, repoRoot);

  if (resolved === '/') {
    fail('packageRoot must never be the filesystem root');
    return out;
  }
  if (resolved === resolvedRepo) {
    fail(`packageRoot must never be the repository root (${resolvedRepo})`);
    return out;
  }
  if (!resolved.startsWith(`${resolvedRepo}/`)) {
    fail(
      `packageRoot must be a directory inside the repository (${resolvedRepo}); ${resolved} is an ancestor of, a sibling of, or outside the repository`,
    );
  }

  return out;
}

/** The only directory names a delivery package may own at its root. */
export const PRODUCTION_PACKAGE_ROOT_ENTRIES: readonly string[] = [
  PRODUCTION_PACKAGE_FILE_NAMES.manifestDir,
  PRODUCTION_PACKAGE_FILE_NAMES.evidenceDir,
  PRODUCTION_PACKAGE_FILE_NAMES.longDir,
  PRODUCTION_PACKAGE_FILE_NAMES.shortsDir,
] as const;

/* ------------------------------------------------------------------ */
/*  Package layout                                                      */
/* ------------------------------------------------------------------ */

/** `long` -> `long`, `short_2` -> `shorts/short_2`. */
export function packageTargetDirectory(targetId: DeliveryTargetId): string {
  return targetId === LONG_DELIVERY_TARGET_ID
    ? PRODUCTION_PACKAGE_FILE_NAMES.longDir
    : packagePath(PRODUCTION_PACKAGE_FILE_NAMES.shortsDir, targetId);
}

/** `long` -> `long/video.mp4`. */
export function packageTargetFile(targetId: DeliveryTargetId, fileName: string): string {
  return packagePath(packageTargetDirectory(targetId), fileName);
}

/** Per-target file order: media, captions, descriptor, QC. */
export const PRODUCTION_PACKAGE_TARGET_FILE_ORDER: readonly string[] = [
  PRODUCTION_PACKAGE_FILE_NAMES.video,
  PRODUCTION_PACKAGE_FILE_NAMES.captionsSrt,
  PRODUCTION_PACKAGE_FILE_NAMES.captionsVtt,
  PRODUCTION_PACKAGE_FILE_NAMES.captionsJson,
  PRODUCTION_PACKAGE_FILE_NAMES.descriptor,
  PRODUCTION_PACKAGE_FILE_NAMES.qcJson,
  PRODUCTION_PACKAGE_FILE_NAMES.qcMarkdown,
] as const;

export const PRODUCTION_PACKAGE_MANIFEST_PATH = packagePath(
  PRODUCTION_PACKAGE_FILE_NAMES.manifestDir,
  PRODUCTION_PACKAGE_FILE_NAMES.manifest,
);
export const PRODUCTION_PACKAGE_CHECKSUMS_PATH = packagePath(
  PRODUCTION_PACKAGE_FILE_NAMES.manifestDir,
  PRODUCTION_PACKAGE_FILE_NAMES.checksums,
);
export const PRODUCTION_PACKAGE_SUMMARY_PATH = packagePath(
  PRODUCTION_PACKAGE_FILE_NAMES.evidenceDir,
  PRODUCTION_PACKAGE_FILE_NAMES.packageSummary,
);

/**
 * The ONLY two findings whose severity a `test-evidence` build may downgrade.
 *
 * They are downgraded because both are the direct, expected consequence of a
 * cost-controlled frame sub-range: the render encodes fewer frames, so the
 * media is legitimately shorter than the plan's full frame capacity.
 *
 * Nothing else is relaxed. In `production` mode both remain hard errors, and a
 * test-evidence package can never report `readyForProductionDelivery`.
 */
export const PRODUCTION_PACKAGE_TEST_EVIDENCE_DOWNGRADED_CODES: readonly ProductionPackageFinding['code'][] = [
  'PACKAGE_PARTIAL_FRAME_COVERAGE',
  'PACKAGE_DURATION_TRUNCATED',
] as const;

/* ------------------------------------------------------------------ */
/*  Captions (plan authority)                                           */
/* ------------------------------------------------------------------ */

/**
 * Flatten `target.plan.scenes[].captionCues` into a deterministic timeline.
 *
 * This is the ONLY caption source in Phase 6D. `storyboard.captions` and
 * `shortCaptions` are never read, and no Long cue can reach a Short except
 * through this target's OWN plan - which the foreign-scene check below then
 * rejects.
 *
 * Captions are never retimed here: the plan's Phase 4/5 timing is used as-is.
 */
export function collectPlanCaptionCues(
  target: ProductionDeliveryTarget,
  allTargets: readonly ProductionDeliveryTarget[] = [],
): { cues: ProductionPackageCaptionCue[]; findings: ProductionPackageFinding[] } {
  const findings: ProductionPackageFinding[] = [];
  const fail = (message: string, sceneId?: string, artifact?: string) => {
    const f: ProductionPackageFinding = { severity: 'error', code: 'PACKAGE_CAPTION_INVALID', message, targetId: target.targetId };
    if (sceneId !== undefined) f.sceneId = sceneId;
    if (artifact !== undefined) f.artifact = artifact;
    findings.push(f);
  };

  const plan = target.plan;
  const ownSceneIds = new Set((plan.scenes ?? []).map((s) => s.sceneId));
  // Scene ids that belong to ANOTHER target in the same set. A Short that
  // carries a Long cue through "fallback" lands here.
  const foreignSceneIds = new Set<string>();
  for (const other of allTargets) {
    if (other.targetId === target.targetId) continue;
    for (const scene of other.plan.scenes ?? []) foreignSceneIds.add(scene.sceneId);
  }
  for (const id of ownSceneIds) foreignSceneIds.delete(id);

  const fps = Number(target.fps) || 30;
  // A cue may end inside the final structural frame. Allow one frame of
  // container tolerance; never retime, only validate.
  const maxAllowedEnd = target.durationInFrames / fps + 1 / fps;

  const flat: {
    cue: ProductionPackageCaptionCue;
    sceneIndex: number;
    order: number;
  }[] = [];

  const scenes = plan.scenes ?? [];
  for (let s = 0; s < scenes.length; s++) {
    const scene = scenes[s]!;
    const cues = scene.captionCues ?? [];
    for (let c = 0; c < cues.length; c++) {
      const cue = cues[c]!;
      const start = Number(cue.startTimeSeconds);
      const end = Number(cue.endTimeSeconds);

      if (!ownSceneIds.has(scene.sceneId)) {
        fail(`caption cue ${cue.id} is declared on a scene that is not part of the target plan`, scene.sceneId);
        continue;
      }
      if (typeof cue.sceneId === 'string' && cue.sceneId.length && !ownSceneIds.has(cue.sceneId)) {
        fail(
          foreignSceneIds.has(cue.sceneId)
            ? `caption cue ${cue.id} claims scene ${cue.sceneId}, which is owned by another target in this delivery set; cross-target caption identity is never allowed`
            : `caption cue ${cue.id} claims scene ${cue.sceneId}, which is not a scene of target ${target.targetId}`,
          scene.sceneId,
        );
        continue;
      }
      if (foreignSceneIds.has(scene.sceneId)) {
        fail(
          `caption cue ${cue.id} belongs to scene ${scene.sceneId}, which is owned by another target in this delivery set; cross-target caption identity is never allowed`,
          scene.sceneId,
        );
        continue;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        fail(`caption cue ${cue.id} has non-numeric timing`, scene.sceneId);
        continue;
      }
      if (start < 0) {
        fail(`caption cue ${cue.id} starts before the target timeline (${start})`, scene.sceneId);
        continue;
      }
      if (!(end > start)) {
        fail(`caption cue ${cue.id} ends (${end}) at or before it starts (${start})`, scene.sceneId);
        continue;
      }
      if (end > maxAllowedEnd) {
        fail(
          `caption cue ${cue.id} ends at ${end}s, beyond the target's structural frame capacity of ${round(maxAllowedEnd)}s (${target.durationInFrames} frames @ ${fps}fps)`,
          scene.sceneId,
        );
        continue;
      }
      if (typeof cue.text !== 'string' || !cue.text.trim().length) {
        fail(`caption cue ${cue.id} has no text`, scene.sceneId);
        continue;
      }

      flat.push({
        sceneIndex: s,
        order: c,
        cue: {
          index: 0,
          id: cue.id,
          sceneId: scene.sceneId,
          sceneIndex: Number.isFinite(Number(scene.sceneIndex)) ? Number(scene.sceneIndex) : s,
          start: round(start, 3) ?? start,
          end: round(end, 3) ?? end,
          duration: round(end - start, 3) ?? end - start,
          startFrame: Number(cue.startFrame),
          endFrame: Number(cue.endFrame),
          text: cue.text,
        },
      });
    }
  }

  // Deterministic timeline order: start, then end, then scene, then source order.
  flat.sort(
    (a, b) =>
      a.cue.start - b.cue.start ||
      a.cue.end - b.cue.end ||
      a.sceneIndex - b.sceneIndex ||
      a.order - b.order,
  );

  // Monotonic ordering is then guaranteed by construction; re-assert it so a
  // future change to the sort cannot silently break the contract.
  const seenIds = new Set<string>();
  const cues: ProductionPackageCaptionCue[] = [];
  let previousStart = -1;
  for (let i = 0; i < flat.length; i++) {
    const current = flat[i]!.cue;
    if (current.start < previousStart - 1e-9) {
      fail(`caption timeline is not monotonic at cue ${current.id} (${current.start}s after ${previousStart}s)`, current.sceneId);
      continue;
    }
    if (seenIds.has(current.id)) {
      fail(`caption cue id ${current.id} is not unique within target ${target.targetId}`, current.sceneId);
      continue;
    }
    seenIds.add(current.id);
    previousStart = Math.max(previousStart, current.start);
    cues.push({ ...current, index: cues.length + 1 });
  }

  return { cues, findings };
}

/** Build the `captions.json` document from plan-derived cues. */
export function buildCaptionDocument(
  target: ProductionDeliveryTarget,
  cues: readonly ProductionPackageCaptionCue[],
): ProductionPackageCaptionDocument {
  return {
    version: PRODUCTION_DELIVERY_PACKAGE_VERSION,
    packageContractVersion: PRODUCTION_DELIVERY_PACKAGE_VERSION,
    targetId: target.targetId,
    format: target.format,
    scenarioId: target.scenarioId,
    projectId: target.projectId,
    fps: target.fps,
    durationInFrames: target.durationInFrames,
    authoritativeDurationSeconds: target.authoritativeDurationSeconds,
    count: cues.length,
    cues: cues.map((c) => ({ ...c })),
  };
}

/** Map plan cues onto the existing, proven `CaptionCue` serialisation shape. */
function toCoreCaptionCues(cues: readonly ProductionPackageCaptionCue[]): CaptionCue[] {
  return cues.map((c) => ({
    id: c.id,
    start: c.start,
    end: c.end,
    text: c.text,
    sceneId: c.sceneId,
    // Term highlighting and user-edit flags are legacy storyboard concerns;
    // a plan cue is authoritative and already final.
    terms: [],
    userEdited: false,
  }));
}

/* ------------------------------------------------------------------ */
/*  QC                                                                  */
/* ------------------------------------------------------------------ */

function qcStatusFromFindings(findings: readonly ProductionPackageFinding[]): ProductionTargetQcStatus {
  if (findings.some((f) => f.severity === 'error')) return 'fail';
  if (findings.some((f) => f.severity === 'warning')) return 'warn';
  return 'pass';
}

function codecInFamily(codec: string | null, family: readonly string[]): boolean {
  if (typeof codec !== 'string') return false;
  const normalised = codec.trim().toLowerCase();
  return family.some((entry) => normalised === entry || normalised.startsWith(`${entry}_`));
}

/**
 * Technical QC of the measured packaged media against the target plan.
 *
 * Duration policy (Phase 6D §15): the plan is the authority. A packaged video
 * FAILS only when its real media ends before the plan's structural frame
 * capacity minus a small tolerance. Positive AAC/container padding is expected
 * and is never treated as timing drift. Excessive padding beyond the documented
 * ceiling is a separate, explicit error.
 */
function runTechnicalQc(
  target: ProductionDeliveryTarget,
  evidence: ProductionPackageMediaEvidence,
  renderedFrameCount: number | null,
): { findings: ProductionPackageFinding[]; metrics: ProductionTargetQcMetrics } {
  const findings: ProductionPackageFinding[] = [];
  const videoPath = packageTargetFile(target.targetId, PRODUCTION_PACKAGE_FILE_NAMES.video);
  const add = (
    severity: ProductionPackageFinding['severity'],
    code: ProductionPackageFinding['code'],
    message: string,
    artifact?: string,
  ) => {
    const f: ProductionPackageFinding = { severity, code, message, targetId: target.targetId };
    if (artifact !== undefined) f.artifact = artifact;
    findings.push(f);
  };

  const m = evidence.metrics ?? emptyProductionTargetTechnicalMetrics();
  const fps = Number(target.fps) || 30;
  const frameCapacitySeconds = target.durationInFrames / fps;
  const planWantsAudio = target.canonicalAudioRefCount > 0;
  const measured = m.durationSeconds;
  const padding = measured === null ? null : round(measured - frameCapacitySeconds, 3);
  const fullFrameCoverage = renderedFrameCount !== null && renderedFrameCount >= target.durationInFrames;

  /* ── packaged media integrity ──────────────────────────────────── */
  if (!evidence.sourceExists) {
    add(
      'error',
      'PACKAGE_FILE_MISSING',
      `the phase 6C render output for target ${target.targetId} does not exist; a successful render must produce a real file`,
      videoPath,
    );
  } else if (evidence.sourceSizeBytes <= 0) {
    add('error', 'PACKAGE_FILE_EMPTY', `the phase 6C render output for target ${target.targetId} is zero bytes`, videoPath);
  }

  if (evidence.error) {
    add('error', 'PACKAGE_FILE_MISSING', `packaging target ${target.targetId} failed: ${evidence.error}`, videoPath);
  }
  if (evidence.sourceExists && !evidence.copied) {
    add('error', 'PACKAGE_FILE_MISSING', `the render output for target ${target.targetId} was not copied into the package`, videoPath);
  }
  if (evidence.copied && !evidence.videoSha256) {
    add('error', 'PACKAGE_FILE_MISSING', `the packaged media for target ${target.targetId} has no SHA256`, videoPath);
  }
  if (evidence.sourceSha256 && evidence.videoSha256 && evidence.sourceSha256 !== evidence.videoSha256) {
    add(
      'error',
      'PACKAGE_CHECKSUM_MISMATCH',
      `the packaged copy of ${target.targetId} does not match its source render output byte for byte; packaging must never alter source media`,
      videoPath,
    );
  }
  if (!evidence.metrics) {
    add('error', 'PACKAGE_MEDIA_PROBE_FAILED', `the packaged media for target ${target.targetId} could not be probed`, videoPath);
  }

  /* ── codec / geometry / frame rate ─────────────────────────────── */
  if (evidence.metrics) {
    if (!codecInFamily(m.videoCodec, PRODUCTION_PACKAGE_VIDEO_CODEC_FAMILY)) {
      add(
        'error',
        'PACKAGE_VIDEO_CODEC_MISMATCH',
        `expected an H.264-family video stream but the packaged media reports ${m.videoCodec ?? 'none'}`,
        videoPath,
      );
    }
    if (m.width !== target.width || m.height !== target.height) {
      add(
        'error',
        'PACKAGE_DIMENSIONS_MISMATCH',
        `expected ${target.width}x${target.height} but the packaged media is ${m.width ?? '?'}x${m.height ?? '?'}`,
        videoPath,
      );
    }
    if (m.fps === null || Math.abs(m.fps - fps) > PRODUCTION_PACKAGE_DURATION_POLICY.fpsTolerance) {
      add(
        'error',
        'PACKAGE_FPS_MISMATCH',
        `expected approximately ${fps}fps but the packaged media reports ${m.fpsRatio ?? 'n/a'}`,
        videoPath,
      );
    }

    /* ── audio ───────────────────────────────────────────────────── */
    if (planWantsAudio && !m.hasAudio) {
      add(
        'error',
        'PACKAGE_AUDIO_MISSING',
        `target ${target.targetId} declares ${target.canonicalAudioRefCount} canonical audio refs but the packaged media carries no audio stream`,
        videoPath,
      );
    } else if (m.hasAudio && !codecInFamily(m.audioCodec, PRODUCTION_PACKAGE_AUDIO_CODEC_FAMILY)) {
      add(
        'error',
        'PACKAGE_AUDIO_CODEC_MISMATCH',
        `expected an AAC-family audio stream for the current production render but the packaged media reports ${m.audioCodec ?? 'none'}`,
        videoPath,
      );
    }
    if (m.hasAudio && m.audioSampleRate !== null && m.audioSampleRate > 0) {
      // A fully silent encode is a blocking defect; an ordinary dialogue pause
      // is not. `analyseFile` reports `longestSilence = 0` when it detected NO
      // silence at all, so a 0 can never be treated as "silent", and a file
      // shorter than the threshold carries too little evidence to judge.
      const threshold = PRODUCTION_PACKAGE_DURATION_POLICY.fullySilentSecondsThreshold;
      if (
        measured !== null &&
        measured > threshold &&
        m.longestSilenceSeconds !== null &&
        m.longestSilenceSeconds > 0 &&
        m.longestSilenceSeconds >= measured - threshold
      ) {
        add(
          'error',
          'PACKAGE_AUDIO_SILENT',
          `the packaged audio stream is silent across the whole file (longest silence ${fmtSeconds(m.longestSilenceSeconds)} of ${fmtSeconds(measured)})`,
          videoPath,
        );
      }
    }

    /* ── duration coverage ───────────────────────────────────────── */
    if (measured === null) {
      add('error', 'PACKAGE_MEDIA_PROBE_FAILED', `the packaged media for target ${target.targetId} reported no duration`, videoPath);
    } else {
      const floor = frameCapacitySeconds - PRODUCTION_PACKAGE_DURATION_POLICY.truncationToleranceSeconds;
      const ceiling = frameCapacitySeconds + PRODUCTION_PACKAGE_DURATION_POLICY.maxContainerPaddingSeconds;
      if (measured < floor) {
        add(
          'error',
          'PACKAGE_DURATION_TRUNCATED',
          `the packaged media ends at ${fmtSeconds(measured)} but target ${target.targetId} authoritatively runs ${fmtSeconds(
            target.authoritativeDurationSeconds,
          )} (${target.durationInFrames} frames = ${fmtSeconds(frameCapacitySeconds)} of frame capacity); media is truncated`,
          videoPath,
        );
      } else if (measured > ceiling) {
        add(
          'error',
          'PACKAGE_DURATION_EXCESSIVE',
          `the packaged media runs ${fmtSeconds(measured)}, more than ${PRODUCTION_PACKAGE_DURATION_POLICY.maxContainerPaddingSeconds}s beyond the plan's ${fmtSeconds(
            frameCapacitySeconds,
          )} frame capacity; this is not renderer/container padding`,
          videoPath,
        );
      }
      // measured in [floor, ceiling] is accepted: small truncation tolerance on
      // the low side, AAC/container padding on the high side.
    }
  }

  /* ── production frame coverage (Phase 6D §30) ──────────────────── */
  if (renderedFrameCount === null) {
    add('error', 'PACKAGE_RENDER_RESULT_MISMATCH', `no render frame count was reported for target ${target.targetId}`);
  } else if (!fullFrameCoverage) {
    add(
      'error',
      'PACKAGE_PARTIAL_FRAME_COVERAGE',
      `the render encoded ${renderedFrameCount} of ${target.durationInFrames} plan frames; a sub-range render is mechanics evidence, not a full delivery artifact`,
    );
  }

  const metrics: ProductionTargetQcMetrics = {
    expectedWidth: target.width,
    expectedHeight: target.height,
    expectedFps: fps,
    expectedDurationInFrames: target.durationInFrames,
    authoritativeDurationSeconds: target.authoritativeDurationSeconds,
    frameCapacitySeconds: round(frameCapacitySeconds, 6) ?? frameCapacitySeconds,
    renderedFrameCount,
    fullFrameCoverage,
    sceneCount: target.sceneCount,
    canonicalAudioRefCount: target.canonicalAudioRefCount,
    captionCueCount: target.captionCueCount,
    assetRefCount: target.assetRefCount,
    mediaMapEntryCount: Object.keys(target.mediaMap ?? {}).length,
    exists: evidence.metrics?.exists ?? false,
    sizeBytes: evidence.sizeBytes,
    videoCodec: evidence.metrics?.videoCodec ?? null,
    width: evidence.metrics?.width ?? null,
    height: evidence.metrics?.height ?? null,
    fps: evidence.metrics?.fps ?? null,
    fpsRatio: evidence.metrics?.fpsRatio ?? null,
    durationSeconds: evidence.metrics?.durationSeconds ?? null,
    hasAudio: evidence.metrics?.hasAudio ?? false,
    audioCodec: evidence.metrics?.audioCodec ?? null,
    audioSampleRate: evidence.metrics?.audioSampleRate ?? null,
    audioChannels: evidence.metrics?.audioChannels ?? null,
    containerFormat: evidence.metrics?.containerFormat ?? null,
    blackSeconds: evidence.metrics?.blackSeconds ?? null,
    blackIntervals: evidence.metrics?.blackIntervals ?? null,
    longestSilenceSeconds: evidence.metrics?.longestSilenceSeconds ?? null,
    silenceCount: evidence.metrics?.silenceCount ?? null,
    containerPaddingSeconds: padding,
    videoSha256: evidence.videoSha256,
    sourceSha256: evidence.sourceSha256,
    sourceUnchanged: !!evidence.sourceSha256 && evidence.sourceSha256 === evidence.videoSha256,
  };

  return { findings, metrics };
}

/* ------------------------------------------------------------------ */
/*  Human-readable QC evidence (`qc.md`)                                */
/* ------------------------------------------------------------------ */

function mdTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return [head, rule, ...(rows.length ? [body] : [])].join('\n');
}

/**
 * Human-readable QC evidence. Deliberately free of absolute paths, host names
 * and timestamps so it is portable and byte-stable.
 */
export function renderPackageQcMarkdown(
  target: ProductionDeliveryTarget,
  qc: ProductionTargetQcResult,
  mode: ProductionPackageMode,
): string {
  const m = qc.metrics;
  const verdict = qc.status.toUpperCase();
  const lines: string[] = [];

  lines.push(`# Phase 6D package QC - ${target.targetId}`);
  lines.push('');
  lines.push(
    mdTable(
      ['Field', 'Value'],
      [
        ['Package contract', PRODUCTION_DELIVERY_PACKAGE_VERSION],
        ['Target id', target.targetId],
        ['Format', target.format],
        ['Scenario', target.scenarioId],
        ['Project', target.projectId],
        ['Build mode', mode],
        ['Verdict', verdict],
        ['Production ready', qc.productionReady ? 'yes' : 'no'],
      ],
    ),
  );
  lines.push('');

  lines.push('## Plan authority');
  lines.push('');
  lines.push(
    mdTable(
      ['Field', 'Value'],
      [
        ['Expected dimensions', `${m.expectedWidth}x${m.expectedHeight}`],
        ['Expected frame rate', `${m.expectedFps} fps`],
        ['Authoritative duration (Phase 4 actual)', fmtSeconds(m.authoritativeDurationSeconds)],
        ['Frame capacity (durationInFrames / fps)', `${fmtSeconds(m.frameCapacitySeconds)} (${fmtInt(m.expectedDurationInFrames)} frames)`],
        ['Rendered frame count', fmtInt(m.renderedFrameCount)],
        ['Full frame coverage', m.fullFrameCoverage ? 'yes' : 'no'],
        ['Scene count', fmtInt(m.sceneCount)],
        ['Canonical audio refs', fmtInt(m.canonicalAudioRefCount)],
        ['Caption cues', fmtInt(m.captionCueCount)],
        ['Asset refs', fmtInt(m.assetRefCount)],
        ['mediaMap entries', fmtInt(m.mediaMapEntryCount)],
      ],
    ),
  );
  lines.push('');

  lines.push('## Expected vs measured packaged media');
  lines.push('');
  lines.push(
    mdTable(
      ['Field', 'Expected', 'Measured'],
      [
        ['Video codec', PRODUCTION_PACKAGE_VIDEO_CODEC_FAMILY[0]!, fmtOrNa(m.videoCodec)],
        ['Width', fmtInt(m.expectedWidth), fmtInt(m.width)],
        ['Height', fmtInt(m.expectedHeight), fmtInt(m.height)],
        ['Frame rate', `${m.expectedFps}`, fmtOrNa(m.fpsRatio)],
        ['Duration', `>= ${fmtSeconds(m.frameCapacitySeconds - PRODUCTION_PACKAGE_DURATION_POLICY.truncationToleranceSeconds)}`, fmtSeconds(m.durationSeconds)],
        ['Container padding', `0 .. ${PRODUCTION_PACKAGE_DURATION_POLICY.maxContainerPaddingSeconds} s`, fmtSeconds(m.containerPaddingSeconds)],
        ['Audio present', m.canonicalAudioRefCount > 0 ? 'yes' : 'no', m.hasAudio ? 'yes' : 'no'],
        ['Audio codec', PRODUCTION_PACKAGE_AUDIO_CODEC_FAMILY[0]!, fmtOrNa(m.audioCodec)],
        ['Audio sample rate', 'n/a', fmtOrNa(m.audioSampleRate)],
        ['Audio channels', 'n/a', fmtOrNa(m.audioChannels)],
        ['Container', 'mp4', fmtOrNa(m.containerFormat)],
        ['File size', '> 0 bytes', `${fmtInt(m.sizeBytes)} bytes`],
      ],
    ),
  );
  lines.push('');

  lines.push('## Optional media evidence');
  lines.push('');
  lines.push(
    mdTable(
      ['Field', 'Value'],
      [
        ['Black seconds', fmtSeconds(m.blackSeconds)],
        ['Black intervals', fmtInt(m.blackIntervals)],
        ['Longest silence', fmtSeconds(m.longestSilenceSeconds)],
        ['Silence events', fmtInt(m.silenceCount)],
      ],
    ),
  );
  lines.push('');

  lines.push('## Integrity');
  lines.push('');
  lines.push(
    mdTable(
      ['Field', 'Value'],
      [
        ['Packaged media', packageTargetFile(target.targetId, PRODUCTION_PACKAGE_FILE_NAMES.video)],
        ['Packaged SHA256', fmtOrNa(m.videoSha256)],
        ['Source render SHA256', fmtOrNa(m.sourceSha256)],
        ['Source unmutated by packaging', m.sourceUnchanged ? 'yes' : 'no'],
      ],
    ),
  );
  lines.push('');

  lines.push('## Findings');
  lines.push('');
  if (qc.findings.length === 0) {
    lines.push('No findings.');
  } else {
    lines.push(
      mdTable(
        ['Severity', 'Code', 'Artifact', 'Message'],
        qc.findings.map((f) => [f.severity, f.code, f.artifact ? `\`${f.artifact}\`` : '-', f.message]),
      ),
    );
  }
  lines.push('');

  return `${lines.join('\n')}`;
}

/* ------------------------------------------------------------------ */
/*  Target matching                                                     */
/* ------------------------------------------------------------------ */

function findRenderEntry(
  renderResult: ProductionDeliveryRenderResult,
  targetId: DeliveryTargetId,
): ProductionDeliveryTargetRenderResult | null {
  return renderResult.results.find((r) => r.targetId === targetId) ?? null;
}

/**
 * Identity checks between one Phase 6C render result and the target set.
 * No filename inference, no silent substitution: any disagreement is a
 * structured failure for that target alone.
 */
function matchTargetToRender(
  target: ProductionDeliveryTarget,
  entry: ProductionDeliveryTargetRenderResult,
): ProductionPackageFinding[] {
  const out: ProductionPackageFinding[] = [];
  const add = (code: ProductionPackageFinding['code'], message: string) =>
    out.push({ severity: 'error', code, message, targetId: target.targetId });

  if (entry.scenarioId !== null && entry.scenarioId !== target.scenarioId) {
    add('PACKAGE_TARGET_MISMATCH', `render result reports scenario ${entry.scenarioId} but target ${target.targetId} is scenario ${target.scenarioId}`);
  }
  if (entry.projectId !== null && entry.projectId !== target.projectId) {
    add('PACKAGE_TARGET_MISMATCH', `render result reports project ${entry.projectId} but target ${target.targetId} is project ${target.projectId}`);
  }
  if (entry.format !== null && entry.format !== target.format) {
    add('PACKAGE_TARGET_MISMATCH', `render result reports format ${entry.format} but target ${target.targetId} is ${target.format}`);
  }

  const render = entry.renderResult;
  if (!render) {
    add('PACKAGE_RENDER_RESULT_MISMATCH', `a successful render for target ${target.targetId} carries no plan render result`);
    return out;
  }

  if (typeof entry.outputFile !== 'string' || !entry.outputFile.trim().length) {
    add('PACKAGE_RENDER_RESULT_MISMATCH', `target ${target.targetId} has no output file in the render result`);
  } else if (normalisePathValue(render.outputFile) !== normalisePathValue(entry.outputFile)) {
    add(
      'PACKAGE_RENDER_RESULT_MISMATCH',
      `render result output ${auditSafeSourceName(render.outputFile)} does not match the reported delivery output for target ${target.targetId}`,
    );
  }

  if (render.scenarioId !== target.scenarioId) {
    add('PACKAGE_TARGET_MISMATCH', `the encoded media for target ${target.targetId} belongs to scenario ${render.scenarioId}`);
  }
  if (render.projectId !== target.projectId) {
    add('PACKAGE_TARGET_MISMATCH', `the encoded media for target ${target.targetId} belongs to project ${render.projectId}`);
  }
  if (render.width !== target.width || render.height !== target.height) {
    add('PACKAGE_TARGET_MISMATCH', `the encoded media for target ${target.targetId} is ${render.width}x${render.height}, not ${target.width}x${target.height}`);
  }
  if (render.fps !== target.fps) {
    add('PACKAGE_TARGET_MISMATCH', `the encoded media for target ${target.targetId} was rendered at ${render.fps}fps, not ${target.fps}fps`);
  }
  if (render.durationInFrames !== target.durationInFrames) {
    add(
      'PACKAGE_TARGET_MISMATCH',
      `the encoded media for target ${target.targetId} reports ${render.durationInFrames} frames but the target plan is ${target.durationInFrames} frames`,
    );
  }
  if (Number(render.authoritativeDurationSeconds) !== Number(target.authoritativeDurationSeconds)) {
    add(
      'PACKAGE_TARGET_MISMATCH',
      `the encoded media for target ${target.targetId} reports ${render.authoritativeDurationSeconds}s of authoritative content but the target plan is ${target.authoritativeDurationSeconds}s`,
    );
  }

  return out;
}

/** Phase 6B stays the structural authority for a target plan at package time. */
function validateTargetPlanContract(target: ProductionDeliveryTarget): ProductionPackageFinding[] {
  const out: ProductionPackageFinding[] = [];
  for (const f of validatePlanForRender(target.plan, target.mediaMap)) {
    out.push({
      severity: f.severity,
      code: 'PACKAGE_PLAN_INVALID',
      message: `phase 6B ${f.severity} (${f.code}): ${f.message}`,
      targetId: target.targetId,
      ...(f.sceneId !== undefined ? { sceneId: f.sceneId } : {}),
    });
  }
  const plan = target.plan;
  if (plan.targetFormat !== target.format) {
    out.push({
      severity: 'error',
      code: 'PACKAGE_PLAN_INVALID',
      message: `target ${target.targetId} plan declares format ${String(plan.targetFormat)} but the target is ${target.format}`,
      targetId: target.targetId,
    });
  }
  if (plan.width !== target.width || plan.height !== target.height || plan.fps !== target.fps) {
    out.push({
      severity: 'error',
      code: 'PACKAGE_PLAN_INVALID',
      message: `target ${target.targetId} geometry ${plan.width}x${plan.height}@${plan.fps} disagrees with the delivery target ${target.width}x${target.height}@${target.fps}`,
      targetId: target.targetId,
    });
  }
  if (plan.durationInFrames !== target.durationInFrames) {
    out.push({
      severity: 'error',
      code: 'PACKAGE_PLAN_INVALID',
      message: `target ${target.targetId} plan carries ${plan.durationInFrames} frames but the delivery target is ${target.durationInFrames} frames`,
      targetId: target.targetId,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  The package planner                                                 */
/* ------------------------------------------------------------------ */

class UnsafePackageRootError extends Error {
  public readonly findings: ProductionPackageFinding[];
  constructor(findings: ProductionPackageFinding[]) {
    super(findings.map((f) => f.message).join('; '));
    this.name = 'UnsafePackageRootError';
    this.findings = findings;
  }
}

/**
 * Build the deterministic, filesystem-free production delivery package.
 *
 * The returned `files` array is the COMPLETE package content: text payloads
 * plus the single copied media file per packaged target. The API materialiser
 * writes text and COPIES media; it never re-encodes, remuxes, retimes or moves
 * a source.
 */
export function buildProductionDeliveryPackage(input: BuildDeliveryPackageInput): ProductionDeliveryPackage {
  const mode: ProductionPackageMode = input.mode === 'test-evidence' ? 'test-evidence' : 'production';
  const packageRoot = input?.packageRoot;
  const targetSet = input?.targetSet;
  const renderResult = input?.renderResult;

  /* ── package root safety: fail fast, write nothing ─────────────── */
  const rootFindings = validateProductionPackageRoot(packageRoot, { repoRoot: input?.repoRoot ?? null });
  if (rootFindings.length) throw new UnsafePackageRootError(rootFindings);

  const findings: ProductionPackageFinding[] = [];
  const allTargets: ProductionDeliveryTarget[] = targetSet.targets ?? [];
  const mediaByTarget = input.mediaByTarget ?? null;

  /* ── every requested target, in canonical order ────────────────── */
  const requested = new Set<DeliveryTargetId>();
  for (const id of targetSet.summary?.requestedTargetIds ?? []) requested.add(id);
  for (const t of allTargets) requested.add(t.targetId);
  for (const f of targetSet.findings ?? []) if (f.targetId) requested.add(f.targetId);
  for (const r of renderResult?.results ?? []) requested.add(r.targetId);
  const requestedTargetIds = sortDeliveryTargetIds(requested);

  const byId = new Map<DeliveryTargetId, ProductionDeliveryTarget>(allTargets.map((t) => [t.targetId, t]));

  const targets: ProductionDeliveryPackageTarget[] = [];
  const files: ProductionDeliveryPackageFile[] = [];
  const removePaths: string[] = [];
  const qcResults: ProductionTargetQcResult[] = [];

  for (const targetId of requestedTargetIds) {
    const target = byId.get(targetId) ?? null;
    const entry = findRenderEntry(renderResult, targetId);
    const expectedFormat: DeliveryTargetFormat = expectedFormatForTargetId(targetId);

    const failTarget = (code: string, message: string): ProductionDeliveryPackageTarget => {
      findings.push({ severity: 'error', code: 'PACKAGE_RENDER_RESULT_MISMATCH', message, targetId });
      const result: ProductionDeliveryPackageTarget = {
        targetId,
        format: target?.format ?? null,
        scenarioId: target?.scenarioId ?? null,
        projectId: target?.projectId ?? null,
        status: 'failed',
        productionReady: false,
        directory: null,
        descriptor: null,
        qc: null,
        captions: null,
        error: { code, message },
      };
      targets.push(result);
      // A failed target NEVER leaves a media package behind.
      removePaths.push(packageTargetDirectory(targetId));
      return result;
    };

    /* ── 1. the render result must cover this target ──────────────── */
    if (!renderResult || !entry) {
      failTarget(
        'PACKAGE_RENDER_RESULT_MISMATCH',
        `no phase 6C render result covers requested target ${targetId}; target identity is never inferred from a filename`,
      );
      continue;
    }

    /* ── 2. a failed render is never packaged as a success ────────── */
    if (!entry.success) {
      const code = entry.error?.code ?? 'PACKAGE_RENDER_FAILED';
      const message = entry.error?.message ?? `phase 6C reported a failed render for target ${targetId}`;
      findings.push({ severity: 'error', code: 'PACKAGE_RENDER_FAILED', message, targetId });
      const result: ProductionDeliveryPackageTarget = {
        targetId,
        format: entry.format ?? target?.format ?? null,
        scenarioId: entry.scenarioId ?? target?.scenarioId ?? null,
        projectId: entry.projectId ?? target?.projectId ?? null,
        status: 'failed',
        productionReady: false,
        directory: null,
        descriptor: null,
        qc: null,
        captions: null,
        error: { code, message },
      };
      targets.push(result);
      removePaths.push(packageTargetDirectory(targetId));
      continue;
    }

    /* ── 3. the target set is the identity authority ──────────────── */
    if (!target) {
      failTarget(
        'PACKAGE_RENDER_RESULT_MISMATCH',
        `the phase 6C render result reports target ${targetId} but the delivery target set did not deliver it`,
      );
      continue;
    }

    /* ── 4. media evidence for the copied output ──────────────────── */
    const evidence: ProductionPackageMediaEvidence = mediaByTarget?.[targetId] ?? emptyProductionPackageMediaEvidence(targetId);

    const matchFindings = matchTargetToRender(target, entry);
    const planFindings = validateTargetPlanContract(target);
    const { cues, findings: captionFindings } = collectPlanCaptionCues(target, allTargets);
    const { findings: techFindings, metrics: qcMetrics } = runTechnicalQc(
      target,
      evidence,
      entry.renderResult?.renderedFrameCount ?? null,
    );

    const targetFindings = [...matchFindings, ...planFindings, ...captionFindings, ...techFindings];

    /* ── 5. test-evidence downgrades, it never relaxes, the QC ────── */
    const downgraded: ProductionPackageFinding[] = targetFindings.map((f) =>
      f.severity === 'error' && mode === 'test-evidence' && PRODUCTION_PACKAGE_TEST_EVIDENCE_DOWNGRADED_CODES.includes(f.code)
        ? {
            ...f,
            severity: 'warning' as const,
            message: `${f.message} (build mode: test-evidence - a cost-controlled frame sub-range is mechanics evidence, never a full delivery artifact; this package is not production-ready)`,
          }
        : f,
    );
    findings.push(...downgraded);

    const qcStatus = qcStatusFromFindings(downgraded);
    // Warnings are advisory: they are reported but never block a full-coverage
    // production target. Only a hard failure, a sub-range render or a
    // test-evidence build keeps a target from being production ready.
    const productionReady = qcStatus !== 'fail' && mode === 'production' && qcMetrics.fullFrameCoverage;

    if (qcStatus === 'fail') {
      const first = downgraded.find((f) => f.severity === 'error')!;
      const result: ProductionDeliveryPackageTarget = {
        targetId,
        format: target.format,
        scenarioId: target.scenarioId,
        projectId: target.projectId,
        status: 'failed',
        productionReady: false,
        directory: null,
        descriptor: null,
        qc: { targetId, status: qcStatus, findings: downgraded, metrics: qcMetrics, productionReady: false },
        captions: null,
        error: { code: first.code, message: first.message },
      };
      targets.push(result);
      // QC-failed media is never shipped: drop the whole target directory so a
      // package can never carry unverified media next to a failing verdict.
      removePaths.push(packageTargetDirectory(targetId));
      continue;
    }

    /* ── 6. package the target ────────────────────────────────────── */
    const videoSha256 = evidence.videoSha256 ?? '';
    const descriptor: ProductionPackageTargetDescriptor = {
      packageContractVersion: PRODUCTION_DELIVERY_PACKAGE_VERSION,
      targetId,
      format: target.format,
      scenarioId: target.scenarioId,
      projectId: target.projectId,
      width: target.width,
      height: target.height,
      fps: target.fps,
      authoritativeDurationSeconds: target.authoritativeDurationSeconds,
      durationInFrames: target.durationInFrames,
      sceneCount: target.sceneCount,
      canonicalAudioRefCount: target.canonicalAudioRefCount,
      captionCueCount: cues.length,
      assetRefCount: target.assetRefCount,
      mediaMapEntryCount: Object.keys(target.mediaMap ?? {}).length,
      compositionId: entry.renderResult?.compositionId ?? 'VideoPlan',
      renderedWithAudio: entry.renderResult?.renderedWithAudio ?? false,
      renderedFrameCount: entry.renderResult?.renderedFrameCount ?? null,
      fullFrameCoverage: qcMetrics.fullFrameCoverage,
      // Audit-safe: a basename, never a source filesystem path.
      sourceRenderFile: auditSafeSourceName(evidence.sourceRenderFile),
      packagedVideoFile: packageTargetFile(targetId, PRODUCTION_PACKAGE_FILE_NAMES.video),
      videoSha256,
      qcStatus,
    };

    const captionDocument = buildCaptionDocument(target, cues);
    const srt = toSrt(toCoreCaptionCues(cues));
    const vtt = toVtt(toCoreCaptionCues(cues));
    const captionsJson = serialisePackageJson(captionDocument);
    const descriptorJson = serialisePackageJson(descriptor);
    const qc: ProductionTargetQcResult = {
      targetId,
      status: qcStatus,
      findings: downgraded,
      metrics: qcMetrics,
      productionReady,
    };
    const qcJson = serialisePackageJson(qc);
    const qcMarkdown = renderPackageQcMarkdown(target, qc, mode);

    const payloads: { name: string; kind: ProductionPackageFileKind; contents: string }[] = [
      { name: PRODUCTION_PACKAGE_FILE_NAMES.captionsSrt, kind: 'captions', contents: srt },
      { name: PRODUCTION_PACKAGE_FILE_NAMES.captionsVtt, kind: 'captions', contents: vtt },
      { name: PRODUCTION_PACKAGE_FILE_NAMES.captionsJson, kind: 'captions', contents: captionsJson },
      { name: PRODUCTION_PACKAGE_FILE_NAMES.descriptor, kind: 'descriptor', contents: descriptorJson },
      { name: PRODUCTION_PACKAGE_FILE_NAMES.qcJson, kind: 'qc', contents: qcJson },
      { name: PRODUCTION_PACKAGE_FILE_NAMES.qcMarkdown, kind: 'qc', contents: qcMarkdown },
    ];

    // The media is COPIED, never moved, never re-encoded, never remuxed.
    files.push({
      path: packageTargetFile(targetId, PRODUCTION_PACKAGE_FILE_NAMES.video),
      kind: 'media',
      targetId,
      sha256: videoSha256,
      sizeBytes: evidence.sizeBytes,
      contents: null,
      copyFrom: evidence.sourceRenderFile,
    });
    for (const payload of payloads) {
      files.push({
        path: packageTargetFile(targetId, payload.name),
        kind: payload.kind,
        targetId,
        sha256: sha256Hex(payload.contents),
        sizeBytes: byteLength(payload.contents),
        contents: payload.contents,
        copyFrom: null,
      });
    }

    qcResults.push(qc);
    targets.push({
      targetId,
      format: target.format,
      scenarioId: target.scenarioId,
      projectId: target.projectId,
      status: 'packaged',
      productionReady,
      directory: packageTargetDirectory(targetId),
      descriptor,
      qc,
      captions: captionDocument,
      error: null,
    });
  }

  /* ── order files deterministically: canonical target order, then
        the fixed per-target file order, then the package index files ─ */
  const targetRank = new Map<DeliveryTargetId, number>(DELIVERY_TARGET_ORDER.map((id, i) => [id, i]));
  const fileRank = new Map<string, number>(PRODUCTION_PACKAGE_TARGET_FILE_ORDER.map((n, i) => [n, i]));
  files.sort((a, b) => {
    const ra = a.targetId === null ? 99 : targetRank.get(a.targetId) ?? 99;
    const rb = b.targetId === null ? 99 : targetRank.get(b.targetId) ?? 99;
    if (ra !== rb) return ra - rb;
    const na = a.path.slice(a.path.lastIndexOf('/') + 1);
    const nb = b.path.slice(b.path.lastIndexOf('/') + 1);
    if (a.targetId !== null && ra === rb) {
      const fa = fileRank.get(na) ?? 99;
      const fb = fileRank.get(nb) ?? 99;
      if (fa !== fb) return fa - fb;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  /* ── checksums: package-relative, lexicographically sorted ──────── */
  const checksums: ProductionPackageChecksumEntry[] = files
    .map((f) => ({ path: f.path, sha256: f.sha256, sizeBytes: f.sizeBytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const checksumsText = checksums.length ? `${checksums.map((c) => `${c.sha256}  ${c.path}`).join('\n')}\n` : '';

  /* ── package status ─────────────────────────────────────────────── */
  const packaged = targets.filter((t) => t.status === 'packaged');
  const failed = targets.filter((t) => t.status === 'failed');
  const packagedTargetIds = packaged.map((t) => t.targetId);
  const failedTargetIds = failed.map((t) => t.targetId);
  const notProductionReady = packaged.some((t) => !t.productionReady);

  let status: ProductionDeliveryPackageManifest['status'];
  if (packaged.length === 0) status = 'blocked';
  else if (failed.length > 0 || notProductionReady) status = 'partial';
  else status = 'ready';
  const readyForProductionDelivery = status === 'ready' && mode === 'production';

  /* ── summary ────────────────────────────────────────────────────── */
  const projectId = targetSet.summary?.projectId ?? allTargets[0]?.projectId ?? null;
  const summary: ProductionDeliveryPackageSummary = {
    packageStatus: status,
    mode,
    readyForProductionDelivery,
    projectId,
    requestedTargetIds,
    renderSucceededTargetIds: sortDeliveryTargetIds(renderResult?.succeededTargetIds ?? []),
    packagedTargetIds,
    failedTargetIds,
    targetOrder: packagedTargetIds,
    longCount: packaged.filter((t) => t.targetId === LONG_DELIVERY_TARGET_ID).length,
    shortCount: packaged.filter((t) => t.targetId !== LONG_DELIVERY_TARGET_ID).length,
    qcPassCount: qcResults.filter((q) => q.status === 'pass').length,
    qcWarnCount: qcResults.filter((q) => q.status === 'warn').length,
    qcFailCount: qcResults.filter((q) => q.status === 'fail').length,
    artifactCount: checksums.length,
    checksumCount: checksums.length,
    totalPackagedBytes: checksums.reduce((n, c) => n + c.sizeBytes, 0),
    errorCount: findings.filter((f) => f.severity === 'error').length,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
  };

  /* ── manifest: the top-level package authority ──────────────────── */
  const manifestTargets: ProductionPackageManifestTargetEntry[] = targets.map((t) => {
    const packagedVideo = packageTargetFile(t.targetId, PRODUCTION_PACKAGE_FILE_NAMES.video);
    const isPackaged = t.status === 'packaged';
    return {
      targetId: t.targetId,
      format: t.format,
      scenarioId: t.scenarioId,
      projectId: t.projectId,
      status: t.status,
      productionReady: t.productionReady,
      video: isPackaged
        ? {
            path: packagedVideo,
            sha256: t.descriptor?.videoSha256 ?? '',
            sizeBytes: t.qc?.metrics.sizeBytes ?? 0,
            sourceRenderFile: t.descriptor?.sourceRenderFile ?? null,
            sourceSha256: t.qc?.metrics.sourceSha256 ?? null,
            sourceUnchanged: t.qc?.metrics.sourceUnchanged ?? false,
          }
        : null,
      captions: isPackaged
        ? {
            srt: packageTargetFile(t.targetId, PRODUCTION_PACKAGE_FILE_NAMES.captionsSrt),
            vtt: packageTargetFile(t.targetId, PRODUCTION_PACKAGE_FILE_NAMES.captionsVtt),
            json: packageTargetFile(t.targetId, PRODUCTION_PACKAGE_FILE_NAMES.captionsJson),
          }
        : null,
      qc: isPackaged
        ? {
            json: packageTargetFile(t.targetId, PRODUCTION_PACKAGE_FILE_NAMES.qcJson),
            markdown: packageTargetFile(t.targetId, PRODUCTION_PACKAGE_FILE_NAMES.qcMarkdown),
            status: t.qc?.status ?? 'fail',
          }
        : null,
      descriptor: isPackaged ? packageTargetFile(t.targetId, PRODUCTION_PACKAGE_FILE_NAMES.descriptor) : null,
      videoSha256: isPackaged ? t.descriptor?.videoSha256 ?? '' : null,
      error: t.error,
    };
  });

  const manifest: ProductionDeliveryPackageManifest = {
    version: PRODUCTION_DELIVERY_PACKAGE_VERSION,
    packageContractVersion: PRODUCTION_DELIVERY_PACKAGE_VERSION,
    projectId,
    status,
    mode,
    readyForProductionDelivery,
    requestedTargetIds,
    packagedTargetIds,
    failedTargetIds,
    targets: manifestTargets,
    summary,
    artifacts: checksums.map((c) => ({
      path: c.path,
      kind: files.find((f) => f.path === c.path)!.kind,
      sizeBytes: c.sizeBytes,
      sha256: c.sha256,
    })),
    checksumsFile: PRODUCTION_PACKAGE_CHECKSUMS_PATH,
  };

  /* ── index files ────────────────────────────────────────────────── */
  files.push({
    path: PRODUCTION_PACKAGE_MANIFEST_PATH,
    kind: 'manifest',
    targetId: null,
    sha256: '',
    sizeBytes: 0,
    contents: null,
    copyFrom: null,
  });
  files.push({
    path: PRODUCTION_PACKAGE_CHECKSUMS_PATH,
    kind: 'checksums',
    targetId: null,
    sha256: '',
    sizeBytes: 0,
    contents: checksumsText,
    copyFrom: null,
  });
  files.push({
    path: PRODUCTION_PACKAGE_SUMMARY_PATH,
    kind: 'evidence',
    targetId: null,
    sha256: '',
    sizeBytes: 0,
    contents: null,
    copyFrom: null,
  });

  const resolveOwn = (entry: ProductionDeliveryPackageFile, contents: string): ProductionDeliveryPackageFile => ({
    ...entry,
    sha256: sha256Hex(contents),
    sizeBytes: byteLength(contents),
    contents,
  });

  const resolved = files.map((f) => {
    if (f.path === PRODUCTION_PACKAGE_MANIFEST_PATH) return resolveOwn(f, serialisePackageJson(manifest));
    if (f.path === PRODUCTION_PACKAGE_SUMMARY_PATH) return resolveOwn(f, serialisePackageJson(summary));
    return f;
  });

  return {
    version: PRODUCTION_DELIVERY_PACKAGE_VERSION,
    mode,
    status,
    readyForProductionDelivery,
    projectId,
    packageRoot: String(packageRoot),
    targetSet,
    renderResult,
    targets,
    findings,
    manifest,
    summary,
    files: resolved,
    checksums,
    removePaths: [...new Set(removePaths)].sort(),
    valid: status !== 'blocked',
  };
}

export { UnsafePackageRootError, toPosix };
