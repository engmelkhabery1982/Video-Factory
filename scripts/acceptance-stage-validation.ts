/**
 * ACCEPTANCE — STAGE EVIDENCE + TIMELINE VALIDATION (test infrastructure only).
 *
 * Two independent, unit-testable authorities used by
 * `scripts/final-product-acceptance.ts`:
 *
 * 1. STAGE EVIDENCE VALIDATION (audit item H)
 *    Every gated stage (`preflight`, `short-smoke`, `final-production`,
 *    `second-project`) writes a stage JSON into `.stills/final-acceptance/stage/`
 *    and evidence JSON into `EVIDENCE/final-product/`. The evidence stage must
 *    NOT treat "the file exists" as success:
 *      - the document must be a JSON object with the EXACT stage identity;
 *      - its status must be `passed` (a `failed` document is rejected);
 *      - the run id and commit must match THIS GitHub Actions run and commit
 *        (rejecting stale/foreign artifacts restored from another run);
 *      - it must carry a real generation timestamp;
 *      - the media/package files it references must exist and be non-empty,
 *        and every referenced SHA256 must match the bytes on disk.
 *
 * 2. PLANNED ASSET EXPOSURE WINDOWS (audit item I)
 *    A fixed 1.5 s frame sampling interval can step straight over a correctly
 *    rendered short asset insertion. The planned scene/beat display window
 *    (audio-authoritative turn durations per scene, in scene order) is used to
 *    select frames INSIDE the actual asset exposure, with frames outside every
 *    window as the documented control.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */
/*  Stage evidence                                                     */
/* ------------------------------------------------------------------ */

export interface StageRunIdentity {
  /** `GITHUB_RUN_ID` of the workflow run producing the stage (null outside Actions) */
  runId: string | null;
  /** `GITHUB_SHA` of the workflow run producing the stage (null outside Actions) */
  commit: string | null;
}

export interface StageValidationContext extends StageRunIdentity {
  /** repository root (absolute) */
  rootDir: string;
  /** output root (absolute) */
  outputDir: string;
  /** marker pixel threshold shared with the driver */
  markerMinPixels: number;
}

export interface StageValidationResult {
  ok: boolean;
  /** every failed assertion, in deterministic order */
  problems: string[];
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requireFile(result: StageValidationResult, label: string, file: string): boolean {
  const exists = fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  if (!exists) result.problems.push(`${label} is missing or empty: ${file}`);
  return exists;
}

/**
 * Validate the envelope every stage document must carry, independent of the
 * stage-specific payload. This is what makes "the file exists" insufficient.
 */
export function validateStageEnvelope(
  stage: string,
  raw: unknown,
  identity: StageRunIdentity,
): StageValidationResult {
  const problems: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, problems: [`${stage}: stage document is not a JSON object`] };
  }
  if (raw.stage !== stage) problems.push(`${stage}: stage document identifies itself as '${String(raw.stage)}'`);
  if (raw.status !== 'passed') problems.push(`${stage}: stage document status is '${String(raw.status)}', expected 'passed'`);
  if (typeof raw.generatedAt !== 'string' || Number.isNaN(Date.parse(raw.generatedAt))) {
    problems.push(`${stage}: stage document has no valid generatedAt timestamp`);
  }
  if (identity.runId !== null && raw.runId !== identity.runId) {
    problems.push(`${stage}: stage document runId is '${String(raw.runId)}', expected this run '${identity.runId}'`);
  }
  if (identity.commit !== null && raw.commit !== identity.commit) {
    problems.push(`${stage}: stage document commit is '${String(raw.commit)}', expected this commit '${identity.commit}'`);
  }
  return { ok: problems.length === 0, problems };
}

/** Resolve a repo-relative or absolute path against the repository root. */
function resolveUnder(rootDir: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(rootDir, candidate);
}

/**
 * Validate the stage-specific payload: the media/package evidence each stage
 * claims must really exist, be non-empty and (where a hash is recorded) match
 * the bytes on disk.
 */
export function validateStagePayload(
  stage: string,
  raw: unknown,
  ctx: StageValidationContext,
): StageValidationResult {
  const problems: string[] = [];
  const doc = raw as Record<string, any>;
  const assert = (condition: boolean, message: string) => {
    if (!condition) problems.push(`${stage}: ${message}`);
  };

  if (stage === 'preflight') {
    const url = doc.mediaUrlAuthority?.absoluteUrl;
    assert(typeof url === 'string' && /^https?:\/\//.test(url), `no absolute live media URL recorded (got ${String(url)})`);
    assert(typeof doc.asset?.id === 'string' && doc.asset.id.length > 0, 'no registered acceptance asset id recorded');
    assert(typeof doc.asset?.sha256 === 'string' && doc.asset.sha256.length === 64, 'no asset SHA256 recorded');
    assert(Number(doc.audio?.perTurnFiles) > 0, 'no per-turn production WAV count recorded');
    assert(Number(doc.audio?.expectedDialogueTurns) === Number(doc.audio?.perTurnFiles), 'per-turn WAV count does not equal the expected dialogue turn count');
    assert(Boolean(doc.assetBinding?.logicalRef) && Boolean(doc.shortAssetBinding?.logicalRef), 'explicit Long/Short asset bindings are not both recorded');
    assert(Boolean(doc.edit?.turnId) && Boolean(doc.reopen), 'dialogue edit / reopen persistence proof missing');
    const perTurnFile = doc.audio?.identityEvidenceFile;
    if (typeof perTurnFile === 'string') {
      const abs = resolveUnder(ctx.rootDir, perTurnFile);
      requireFile({ ok: true, problems }, 'preflight: per-turn audio identity evidence', abs);
    }
  }

  if (stage === 'short-smoke') {
    const media = doc.media ?? doc;
    const file = typeof media.file === 'string' ? resolveUnder(ctx.rootDir, media.file) : null;
    if (!file) problems.push(`${stage}: no Short media file recorded`);
    else if (requireFile({ ok: true, problems }, 'short-smoke: rendered Short', file)) {
      // A stage JSON that references its own evidence must agree with the bytes.
      if (typeof media.sha256 === 'string' && media.sha256.length === 64) {
        if (sha256File(file) !== media.sha256) problems.push(`${stage}: recorded sha256 does not match the bytes on disk for the rendered Short`);
      } else {
        problems.push(`${stage}: rendered Short has no SHA256 recorded`);
      }
    }
    assert(Number(media.width) === 1080 && Number(media.height) === 1920, `Short geometry is not 1080x1920 (got ${media.width}x${media.height})`);
    assert(Number(media.audioStreamCount) === 1, 'Short does not record exactly one real audio stream');
    assert(Number(media.durationSeconds) > 0, 'Short has no measurable duration');
    assert(Number(media.frameProof?.markerPixelsBestFrame) >= ctx.markerMinPixels, `asset frame proof below ${ctx.markerMinPixels} marker pixels (got ${media.frameProof?.markerPixelsBestFrame})`);
    assert(Number(media.frameProof?.framesSampled) > 0, 'asset frame proof sampled no frames');
  }

  if (stage === 'final-production') {
    const packageRootRel = doc.packageRoot;
    assert(typeof packageRootRel === 'string' && packageRootRel.length > 0, 'no Phase 6D packageRoot recorded');
    if (typeof packageRootRel === 'string' && packageRootRel.length > 0) {
      // The stage writer records packageRoot relative to the repository root,
      // unlike the product API's output-relative package path.
      const pkgRoot = resolveUnder(ctx.rootDir, packageRootRel);
      const relativeToOutput = path.relative(ctx.outputDir, pkgRoot);
      assert(
        relativeToOutput !== '' && relativeToOutput !== '..' && !relativeToOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToOutput),
        `Phase 6D packageRoot is outside the production output directory: ${packageRootRel}`,
      );
      const manifest = path.join(pkgRoot, 'manifest', 'delivery_manifest.json');
      const checksums = path.join(pkgRoot, 'checksums.sha256');
      const summary = path.join(pkgRoot, 'evidence', 'package_summary.json');
      const manifestOk = fs.existsSync(manifest);
      if (!manifestOk) problems.push(`${stage}: Phase 6D delivery manifest is missing at ${manifest}`);
      if (!fs.existsSync(checksums) || fs.statSync(checksums).size === 0) problems.push(`${stage}: Phase 6D checksums are missing at ${checksums}`);
      if (!fs.existsSync(summary) || fs.statSync(summary).size === 0) problems.push(`${stage}: Phase 6D package summary is missing at ${summary}`);
      if (manifestOk) {
        try {
          const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          assert(parsed.status === 'ready', `delivery manifest status is '${String(parsed.status)}', expected 'ready'`);
          assert(parsed.readyForProductionDelivery === true, 'delivery manifest is not readyForProductionDelivery');
          assert(Array.isArray(parsed.failedTargetIds) && parsed.failedTargetIds.length === 0, 'delivery manifest records failed targets');
        } catch (e) {
          problems.push(`${stage}: delivery manifest is unreadable: ${(e as Error).message}`);
        }
      }
    }
    for (const [name, entry] of Object.entries((doc.media ?? {}) as Record<string, any>)) {
      const file = typeof entry.file === 'string' ? resolveUnder(ctx.rootDir, entry.file) : null;
      if (!file) {
        problems.push(`${stage}: no ${name} media file recorded`);
        continue;
      }
      if (requireFile({ ok: true, problems }, `${stage}: ${name} media`, file) && typeof entry.sha256 === 'string') {
        if (sha256File(file) !== entry.sha256) problems.push(`${stage}: ${name} media sha256 does not match the bytes on disk`);
      }
    }
    const kit = doc.productKit;
    if (typeof kit === 'string' && kit.length > 0) {
      const kitManifest = path.join(ctx.outputDir, kit, 'manifest.json');
      if (!fs.existsSync(kitManifest) || fs.statSync(kitManifest).size === 0) problems.push(`${stage}: product-kit manifest is missing at ${kitManifest}`);
      else {
        try {
          const manifest = JSON.parse(fs.readFileSync(kitManifest, 'utf8'));
          assert(manifest.schema === 'production-product-kit.v1', `product kit schema is '${String(manifest.schema)}'`);
          assert(manifest.readiness?.status === 'ready' && manifest.readiness?.readyForProductionDelivery === true, 'product kit readiness is not ready for production delivery');
          const kitFiles = Array.isArray(manifest.files) ? manifest.files : [];
          const missing = kitFiles.filter((rel: string) => {
            const abs = path.join(ctx.outputDir, kit, rel);
            return !fs.existsSync(abs) || fs.statSync(abs).size === 0;
          });
          assert(missing.length === 0, `product-kit files listed in its manifest are missing: ${missing.slice(0, 5).join(', ')}`);
        } catch (e) {
          problems.push(`${stage}: product-kit manifest is unreadable: ${(e as Error).message}`);
        }
      }
    }
    assert(Array.isArray(doc.frameProofs) && doc.frameProofs.length >= 2, 'fewer than two rendered-deliverable frame proofs recorded');
    for (const proof of Array.isArray(doc.frameProofs) ? doc.frameProofs : []) {
      assert(Number(proof.markerPixelsBestFrame) >= ctx.markerMinPixels, `frame proof (${String(proof.stage)}) below ${ctx.markerMinPixels} marker pixels`);
    }
  }

  if (stage === 'second-project') {
    assert(typeof doc.secondVideoId === 'string' && doc.secondVideoId.length > 0, 'no second project id recorded');
    assert(Number(doc.renders) === 0, `second project recorded renders=${String(doc.renders)}, expected 0`);
    assert(doc.historyInput?.source === 'production', `second project history source is '${String(doc.historyInput?.source)}', expected 'production'`);
    assert(Number(doc.historyInput?.productionEntryCount) >= 1, 'second project consumed no persisted production history entries');
  }

  return { ok: problems.length === 0, problems };
}

/* ------------------------------------------------------------------ */
/*  Planned asset exposure windows                                     */
/* ------------------------------------------------------------------ */

export interface SceneTurnDurations {
  sceneId: string;
  /** measured (audio-authoritative) duration of every turn in this scene, in order */
  turnDurationsSeconds: number[];
}

export interface ExposureWindow {
  sceneId: string;
  startSeconds: number;
  endSeconds: number;
}

export interface ExposureWindowOptions {
  /** seconds of padding around the scene window (timing reconciliation tolerance) */
  padSeconds?: number;
  /** total video duration in seconds; windows are clamped to [0, duration] */
  videoDurationSeconds: number;
}

/**
 * Compute the display window (seconds) of the asset-bearing scenes on the
 * RENDERED timeline, from the audio-authoritative per-turn durations.
 *
 * The plan timeline follows the reconciled actual audio: sceneStart(n) is the
 * sum of all turn durations of the preceding scenes. Windows are padded by a
 * small, documented tolerance and clamped to the rendered duration.
 */
export function assetExposureWindows(
  scenes: readonly SceneTurnDurations[],
  assetSceneIds: readonly string[],
  options: ExposureWindowOptions,
): ExposureWindow[] {
  const pad = options.padSeconds ?? 0.6;
  const wanted = new Set(assetSceneIds);
  const windows: ExposureWindow[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    const sceneDuration = scene.turnDurationsSeconds.reduce((n, d) => n + (Number.isFinite(d) && d > 0 ? d : 0), 0);
    if (wanted.has(scene.sceneId) && sceneDuration > 0) {
      // A scene that starts at/after the rendered duration was not rendered: it
      // gets no window at all (never a fabricated one).
      if (cursor < options.videoDurationSeconds) {
        const start = Math.max(0, cursor - pad);
        const end = Math.min(options.videoDurationSeconds, cursor + sceneDuration + pad);
        windows.push({
          sceneId: scene.sceneId,
          startSeconds: Number(start.toFixed(3)),
          endSeconds: Number(Math.max(Math.min(start + 0.25, options.videoDurationSeconds), end).toFixed(3)),
        });
      }
    }
    cursor += sceneDuration;
  }
  return windows;
}

/** Deterministic sample timestamps inside a window (inclusive of both edges). */
export function windowSampleTimes(window: ExposureWindow, framesPerSecond = 4, maxFrames = 32): number[] {
  const duration = Math.max(0, window.endSeconds - window.startSeconds);
  const count = Math.max(2, Math.min(maxFrames, Math.ceil(duration * framesPerSecond) + 1));
  const step = count > 1 ? duration / (count - 1) : 0;
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    times.push(Number((window.startSeconds + i * step).toFixed(3)));
  }
  return times;
}

/** Deterministic sample timestamps OUTSIDE every window (the control). */
export function controlSampleTimes(
  windows: readonly ExposureWindow[],
  videoDurationSeconds: number,
  framesPerSecond = 1,
  maxFrames = 24,
): number[] {
  const inside = (t: number) => windows.some((w) => t >= w.startSeconds && t <= w.endSeconds);
  const times: number[] = [];
  const step = framesPerSecond > 0 ? 1 / framesPerSecond : 1;
  for (let t = 0; t <= videoDurationSeconds && times.length < maxFrames; t += step) {
    const rounded = Number(t.toFixed(3));
    if (!inside(rounded)) times.push(rounded);
  }
  return times;
}
