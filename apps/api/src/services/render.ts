import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import {
  LONG_EXPORT_SPEC,
  PLAN_RENDER_COMPOSITION_ID,
  PlanRenderError,
  SHORT_EXPORT_SPEC,
  firstPlanRenderError,
  type CtaAnimationId,
  type CaptionStyleId,
  type ExportSpec,
  type HistoryEntry,
  type PlanRenderInput,
  type PlanRenderResult,
  type RemotionCompositionPlan,
  type Scene,
  type VideoPlanInputProps,
} from '@buildtrack/core';
import { ROOT, chromePath, ffmpegPath, prepareBrowserEnv, runOrThrow } from './platform.js';
import { analyseFile, durationOf } from './media.js';

let serveUrlPromise: Promise<string> | null = null;

/**
 * The Remotion bundle is a BROWSER bundle, but `@buildtrack/core` is also the
 * Node library that owns the Phase 4 audio tooling - it imports `node:fs`,
 * `node:path`, `node:child_process` and friends from `synthesize-dialogue`,
 * `audio-normalizer`, `audio-probe` and the scenario fixtures.
 *
 * Webpack refuses the `node:` URL scheme outright (`UnhandledSchemeError`), so
 * without this the whole bundle fails and NOTHING can render. Those modules are
 * never executed in the browser (the plan carries resolved paths/URLs, not
 * processes), so they are aliased to empty modules. This mirrors the standard
 * Remotion browser-bundle setup and changes no rendering behaviour.
 */
/**
 * Inert stand-ins for the Node builtins the Core library imports. Several Core
 * modules touch `path.dirname` / `fileURLToPath` / `createRequire` while their
 * module body evaluates, so `false` (an empty module) is not enough - those
 * calls would throw during bundle startup. The shim is never reached by any
 * render logic; see apps/api/src/services/node-builtin-shim.cjs.
 */
function nodeBuiltinFallbacks(): Record<string, string> {
  const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node-builtin-shim.cjs');
  return {
    fs: shim,
    'fs/promises': shim,
    path: shim,
    url: shim,
    module: shim,
    child_process: shim,
    crypto: shim,
    os: shim,
    stream: shim,
    util: shim,
  };
}

/**
 * `resolve.fallback` only matches BARE specifiers, so the `node:` URL scheme
 * has to be rewritten first. `webpack` is a hard dependency of the declared
 * `@remotion/bundler` package, so it is resolved THROUGH the bundler rather
 * than assumed to be hoisted - no new dependency is introduced.
 */
function loadWebpack(): { NormalModuleReplacementPlugin: new (resourceRegExp: RegExp, newResource: (resource: { request: string }) => void) => unknown } {
  const bundlerRequire = createRequire(createRequire(import.meta.url).resolve('@remotion/bundler'));
  return bundlerRequire('webpack');
}

export function remotionWebpackOverride(config: Record<string, unknown>): Record<string, unknown> {
  const resolve = (config.resolve ?? {}) as Record<string, unknown>;
  let webpack: ReturnType<typeof loadWebpack>;
  try {
    webpack = loadWebpack();
  } catch {
    // Fall back to the bare-specifier aliases only; the bundle will report a
    // clear UnhandledSchemeError if a node: import is actually reached.
    return { ...config, resolve: { ...resolve, fallback: { ...((resolve.fallback ?? {}) as Record<string, unknown>), ...nodeBuiltinFallbacks() } } };
  }
  const plugins = [
    ...(((config.plugins as unknown[]) ?? []) as unknown[]),
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, '');
    }),
  ];
  return {
    ...config,
    plugins,
    resolve: {
      ...resolve,
      fallback: { ...((resolve.fallback ?? {}) as Record<string, unknown>), ...nodeBuiltinFallbacks() },
    },
  };
}

/**
 * Remotion is bundled ONCE per process (~3s) and reused for every render.
 * The bundle is the compiled video app; each video is just different props.
 */
export async function getServeUrl() {
  prepareBrowserEnv();
  if (!serveUrlPromise) {
    serveUrlPromise = bundle({
      entryPoint: path.join(ROOT, 'packages/video/src/index.ts'),
      outDir: path.join(ROOT, '.remotion'),
      onProgress: () => {},
      webpackOverride: remotionWebpackOverride as never,
    });
  }
  return serveUrlPromise;
}

export function resetBundle() {
  serveUrlPromise = null;
}

/* =================================================================== */
/*  PRODUCTION AUDIO RENDER TRANSPORT (renderer boundary only)          */
/*                                                                      */
/*  The plan's audioRefs carry the SINGLE product audio authority:      */
/*  repo-relative `.production/<videoId>/audio/<dialogue|canonical>`   */
/*  paths (services/platform.ts `productionAudioBasePaths`). That stays */
/*  exactly as-is in the plan, on disk and in every target set.         */
/*                                                                      */
/*  The Remotion browser receives the bundle served from `.remotion`,   */
/*  so a bare relative `.production/...` src resolves against the       */
/*  bundle root (`.remotion/.production/...`) and 404s in a real        */
/*  render. The live product server answers those same srcs over        */
/*  `GET /media/production-audio/*` — the identical transport the       */
/*  Phase 6A mediaMap already uses for images via the live server.      */
/*                                                                      */
/*  Nothing is copied, moved, duplicated or re-synthesized here: the    */
/*  mapping happens ONLY while building the browser-side props, ONLY    */
/*  for repo-relative production paths, and ONLY when a real product    */
/*  server is actually listening. With no server origin set (unit       */
/*  tests, evidence runners that bring their own transport mapping)     */
/*  the props pass through byte-for-byte unchanged.                      */
/* =================================================================== */

let productionMediaOrigin: string | null = null;

/**
 * Record the origin the REAL product server is listening on (called from
 * `server.ts` after `listen`). Must be a plain `http(s)://host:port` origin;
 * anything else clears it, returning the renderer to pure passthrough.
 */
export function setProductionMediaOrigin(origin: string | null): void {
  const trimmed = typeof origin === 'string' ? origin.trim().replace(/\/+$/, '') : '';
  productionMediaOrigin = /^https?:\/\/[^/?#]+$/.test(trimmed) ? trimmed : null;
}

/** The origin currently mapped against, or null when no live server is set. */
export function getProductionMediaOrigin(): string | null {
  return productionMediaOrigin;
}

/** `.production/<videoId>/audio/<dialogue|canonical>/<file>.wav` (repo-relative). */
const PRODUCTION_AUDIO_RELATIVE = /^\.production\/([^/]+)\/audio\/(dialogue|canonical)\/(.+)$/;

/**
 * Pure one-src transport mapping used at the renderer boundary:
 *   - a repo-relative production path becomes the URL the live product server
 *     serves from the SAME `.production` authority root;
 *   - an already-absolute URL (http:, https:, file:, data:), an absolute
 *     filesystem path, a non-production relative path, or any origin-less
 *     run returns null (leave the src untouched).
 */
export function productionAudioRenderableSrc(canonicalPath: unknown): string | null {
  if (typeof canonicalPath !== 'string') return null;
  const p = canonicalPath.trim().replace(/\\/g, '/');
  if (!p) return null;
  // Absolute URLs and absolute filesystem paths are already resolvable
  // (that is how the real-render tests' own transport mapping arrives).
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/')) return null;
  const m = PRODUCTION_AUDIO_RELATIVE.exec(p);
  if (!m) return null;
  const origin = productionMediaOrigin;
  if (!origin) return null;
  const [, videoId, kind, rest] = m;
  if (!videoId || videoId === '.' || videoId === '..') return null;
  if (!rest || rest.includes('..')) return null;
  const rel = rest
    .split('/')
    .filter((seg) => seg.length > 0 && seg !== '.')
    .map(encodeURIComponent)
    .join('/');
  if (!rel || !/\.wav$/i.test(rel)) return null;
  return `${origin}/media/production-audio/${encodeURIComponent(videoId)}/audio/${kind}/${rel}`;
}

/**
 * Copy the plan with ONLY each `audioRefs[].canonicalPath` remapped to the
 * live server URL when the path is a repo-relative production path and a
 * product server origin is set. Timing, ids, order and every other field are
 * untouched; with no change to make the SAME plan reference is returned.
 */
export function withRenderableProductionAudio(plan: RemotionCompositionPlan): RemotionCompositionPlan {
  if (!productionMediaOrigin) return plan;
  let changed = false;
  const scenes = plan.scenes.map((scene) => {
    const refs = scene.audioRefs ?? [];
    if (refs.length === 0) return scene;
    let sceneChanged = false;
    const audioRefs = refs.map((audio) => {
      const src = productionAudioRenderableSrc(audio.canonicalPath);
      if (src === null) return audio;
      sceneChanged = true;
      changed = true;
      return { ...audio, canonicalPath: src };
    });
    return sceneChanged ? { ...scene, audioRefs } : scene;
  });
  return changed ? { ...plan, scenes } : plan;
}

/* =================================================================== */
/*  PHASE 6B — REAL PLAN RENDER API                                     */
/*                                                                      */
/*  RemotionCompositionPlan + Phase 6A mediaMap                         */
/*    -> VideoPlan composition -> @remotion/renderer -> real media      */
/*                                                                      */
/*  The plan is the timing authority: durationInFrames is used as-is.   */
/*  Canonical Phase 4 audio is rendered by the composition's <Audio>    */
/*  elements and must survive into the encoded file.                    */
/* =================================================================== */

/** The exact props handed to the `VideoPlan` composition. One builder, so the
 *  selected composition and the render always receive identical input. */
export function videoPlanInputProps(
  plan: RemotionCompositionPlan,
  o: { mediaMap?: Record<string, string> | null; brand?: unknown; format?: 'long' | 'short'; captionStyle?: string; burnedCaptions?: boolean } = {},
): VideoPlanInputProps {
  return {
    plan,
    // Phase 6A mediaMap goes straight through: no re-resolution, no assetId keys.
    mediaMap: o.mediaMap ?? {},
    ...(o.brand !== undefined ? { brand: o.brand } : {}),
    format: o.format ?? (plan.targetFormat === 'Short' ? 'short' : 'long'),
    captionStyle: o.captionStyle ?? 'boxed_center',
    burnedCaptions: o.burnedCaptions ?? true,
  };
}

/** Throw the first fatal structural finding as a structured PlanRenderError. */
export function assertPlanRenderable(plan: unknown, mediaMap?: Record<string, string> | null): RemotionCompositionPlan {
  if (plan && typeof plan === 'object' && (plan as { valid?: boolean }).valid === false) {
    throw new PlanRenderError('PLAN_RENDER_INVALID_PLAN', 'plan is marked invalid by the Phase 5C pipeline', {
      scenarioId: (plan as { scenarioId?: string }).scenarioId,
    });
  }
  const first = firstPlanRenderError(plan, mediaMap);
  if (first) {
    throw new PlanRenderError(first.code, first.message, { sceneId: first.sceneId ?? null });
  }
  return plan as RemotionCompositionPlan;
}

/** `[firstFrame, lastFrame]` inclusive, matching Remotion's `frameRange`. */
export function normaliseFrameRange(
  range: [number, number] | null | undefined,
  plan: Pick<RemotionCompositionPlan, 'durationInFrames'>,
): [number, number] | null {
  if (!range) return null;
  const [from, to] = range;
  const last = plan.durationInFrames - 1;
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new PlanRenderError('PLAN_RENDER_INVALID_INPUT', `frameRange must be integer frames, got [${from}, ${to}]`);
  }
  if (from < 0 || to > last || to < from) {
    throw new PlanRenderError(
      'PLAN_RENDER_INVALID_INPUT',
      `frameRange [${from}, ${to}] is outside the plan's valid range [0, ${last}]`,
      { durationInFrames: plan.durationInFrames, lastValidFrame: last },
    );
  }
  return [from, to];
}

/** The render output is the evidence, not the render call's return value. */
export function assertRenderedOutput(file: string): { file: string; sizeBytes: number } {
  if (!file || !fs.existsSync(file)) {
    throw new PlanRenderError('PLAN_RENDER_OUTPUT_MISSING', `no render output at ${file}`);
  }
  const sizeBytes = fs.statSync(file).size;
  if (sizeBytes <= 0) {
    throw new PlanRenderError('PLAN_RENDER_OUTPUT_MISSING', `render output ${file} is empty`);
  }
  return { file, sizeBytes };
}

/**
 * Phase 6B plan renderer.
 *
 * Selects the `VideoPlan` composition (never `LongVideo` / `ShortVideo`) and
 * renders with the plan's own fps/width/height/durationInFrames.
 */
export async function renderCompositionPlan(input: PlanRenderInput): Promise<PlanRenderResult> {
  const startedAt = Date.now();
  const { plan: rawPlan, outputFile } = input ?? ({} as PlanRenderInput);

  if (typeof outputFile !== 'string' || !outputFile.length) {
    throw new PlanRenderError('PLAN_RENDER_INVALID_INPUT', 'renderCompositionPlan requires an outputFile');
  }
  if (!/\.mp4$/i.test(outputFile)) {
    throw new PlanRenderError('PLAN_RENDER_INVALID_INPUT', `outputFile must end in .mp4, got ${outputFile}`);
  }

  const mediaMap = input.mediaMap ?? {};
  const plan = assertPlanRenderable(rawPlan, mediaMap);
  const frameRange = normaliseFrameRange(input.frameRange, plan);
  const quality = input.quality ?? 'preview';
  // Browser-boundary transport only: repo-relative production audio srcs are
  // mapped to the live product server URL (no-op without a live origin).
  // `plan` itself - the authority object used for timing checks below - is
  // never rewritten.
  const props = videoPlanInputProps(withRenderableProductionAudio(plan), {
    mediaMap,
    brand: input.brand,
    format: input.format,
    captionStyle: input.captionStyle,
    burnedCaptions: input.burnedCaptions,
  });

  const canonicalAudioExpected = plan.scenes.some((s) => (s.audioRefs ?? []).length > 0);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const serveUrl = await getServeUrl();

  let composition: Awaited<ReturnType<typeof selectComposition>>;
  try {
    composition = await selectComposition({
      serveUrl,
      id: PLAN_RENDER_COMPOSITION_ID,
      inputProps: props as unknown as Record<string, unknown>,
      browserExecutable: chromePath(),
    });
  } catch (err) {
    throw new PlanRenderError(
      'PLAN_RENDER_COMPOSITION_NOT_FOUND',
      `could not select the "${PLAN_RENDER_COMPOSITION_ID}" composition: ${(err as Error).message}`,
      { compositionId: PLAN_RENDER_COMPOSITION_ID },
    );
  }

  // The selected metadata must come from the plan, not from a re-derivation.
  if (
    composition.fps !== plan.fps ||
    composition.width !== plan.width ||
    composition.height !== plan.height ||
    composition.durationInFrames !== plan.durationInFrames
  ) {
    throw new PlanRenderError('PLAN_RENDER_TIMING_MISMATCH', 'selected composition metadata does not match the plan', {
      selected: {
        fps: composition.fps,
        width: composition.width,
        height: composition.height,
        durationInFrames: composition.durationInFrames,
      },
      expected: { fps: plan.fps, width: plan.width, height: plan.height, durationInFrames: plan.durationInFrames },
    });
  }

  input.onProgress?.(0.02, `Rendering ${PLAN_RENDER_COMPOSITION_ID}`);

  try {
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      videoBitrate: quality === 'preview' ? '4M' : '16M',
      outputLocation: outputFile,
      inputProps: props as unknown as Record<string, unknown>,
      browserExecutable: chromePath(),
      chromiumOptions: { gl: 'swangle', headless: true },
      concurrency: Math.max(1, Math.min(4, (globalThis as any).navigator?.hardwareConcurrency ?? 2)),
      imageFormat: 'jpeg',
      jpegQuality: 95,
      // Canonical dialogue is the deliverable's audio: never strip it. Only a
      // plan that declares no audio at all renders without a track.
      enforceAudioTrack: canonicalAudioExpected,
      ...(frameRange ? { frameRange } : {}),
      onProgress: ({ progress }) => input.onProgress?.(0.02 + progress * 0.93, 'Rendering frames'),
    });
  } catch (err) {
    throw new PlanRenderError('PLAN_RENDER_FAILED', `Remotion render failed: ${(err as Error).message}`, { outputFile });
  }

  assertRenderedOutput(outputFile);

  // Trust the file, not the settings.
  const analysis = await analyseFile(outputFile);
  if (canonicalAudioExpected && !analysis.hasAudio) {
    throw new PlanRenderError(
      'PLAN_RENDER_AUDIO_MISSING',
      `plan declares canonical audio but the rendered file has no audio stream`,
      { outputFile },
    );
  }

  input.onProgress?.(1, 'Render complete');

  return {
    outputFile,
    compositionId: PLAN_RENDER_COMPOSITION_ID,
    scenarioId: plan.scenarioId,
    projectId: plan.projectId,
    fps: composition.fps,
    width: composition.width,
    height: composition.height,
    durationInFrames: plan.durationInFrames,
    // `frameRange` is inclusive at both ends, matching Remotion.
    renderedFrameCount: frameRange ? frameRange[1] - frameRange[0] + 1 : plan.durationInFrames,
    authoritativeDurationSeconds: plan.totalActualDurationSeconds,
    renderedWithAudio: analysis.hasAudio,
    mediaMapEntryCount: Object.keys(mediaMap).length,
    renderTimeMs: Date.now() - startedAt,
  };
}

/**
 * Render one frame of the plan through the same `VideoPlan` composition.
 * Used for evidence stills and for the canonical asset-visibility test, which
 * needs a real frame rather than an asserted prop.
 */
export async function renderPlanStill(input: {
  plan: RemotionCompositionPlan;
  output: string;
  frame: number;
  mediaMap?: Record<string, string> | null;
  brand?: unknown;
  format?: 'long' | 'short';
  captionStyle?: string;
  burnedCaptions?: boolean;
}): Promise<{ file: string; frame: number }> {
  const plan = assertPlanRenderable(input.plan, input.mediaMap ?? {});
  if (!Number.isInteger(input.frame) || input.frame < 0 || input.frame >= plan.durationInFrames) {
    throw new PlanRenderError(
      'PLAN_RENDER_INVALID_INPUT',
      `frame ${input.frame} is outside the plan's valid range [0, ${plan.durationInFrames - 1}]`,
    );
  }
  const props = videoPlanInputProps(withRenderableProductionAudio(plan), {
    mediaMap: input.mediaMap,
    brand: input.brand,
    format: input.format,
    captionStyle: input.captionStyle,
    burnedCaptions: input.burnedCaptions,
  });
  const serveUrl = await getServeUrl();
  const composition = await selectComposition({
    serveUrl,
    id: PLAN_RENDER_COMPOSITION_ID,
    inputProps: props as unknown as Record<string, unknown>,
    browserExecutable: chromePath(),
  });
  fs.mkdirSync(path.dirname(input.output), { recursive: true });
  await renderStill({
    composition,
    serveUrl,
    output: input.output,
    inputProps: props as unknown as Record<string, unknown>,
    frame: input.frame,
    browserExecutable: chromePath(),
    chromiumOptions: { gl: 'swangle', headless: true },
    imageFormat: 'png',
  });
  return { file: input.output, frame: input.frame };
}

/* =================================================================== */
/*  LEGACY RENDER PATH (LongVideo / ShortVideo) — unchanged            */
/* =================================================================== */

export interface RenderTarget {
  format: 'long' | 'short';
  scenes: Scene[];
  videoId: string;
  ctaAnimation: CtaAnimationId;
  captionStyle: CaptionStyleId;
  ctaText: string;
  productName: string;
  brand: unknown;
  audioUrl?: string | null;
  logoUrl?: string | null;
  mediaMap?: Record<string, string>;
  captions: { id: string; start: number; end: number; text: string; terms: string[]; sceneId: string | null; userEdited: boolean }[];
  burnedCaptions?: boolean;
  /** preview renders are low bitrate and watermarked-free but quick */
  quality?: 'preview' | 'final';
  audioFile?: string | null;
  outputFile: string;
  onProgress?: (p: number, note?: string) => void;
}

export function exportSpecFor(format: 'long' | 'short'): ExportSpec {
  return format === 'long' ? LONG_EXPORT_SPEC : SHORT_EXPORT_SPEC;
}

export async function renderTarget(input: RenderTarget): Promise<{ rawVideo: string; spec: ExportSpec }> {
  const spec = exportSpecFor(input.format);
  const serveUrl = await getServeUrl();
  const id = input.format === 'long' ? 'LongVideo' : 'ShortVideo';

  const props = {
    scenes: input.scenes,
    captions: input.captions,
    brand: input.brand,
    format: input.format,
    ctaAnimation: input.ctaAnimation,
    captionStyle: input.captionStyle,
    ctaText: input.ctaText,
    productName: input.productName,
    logoSrc: input.logoUrl ?? null,
    audioSrc: null, // audio is muxed by ffmpeg so the bitrate targets are exact
    burnedCaptions: input.burnedCaptions ?? true,
    mediaMap: input.mediaMap ?? {},
  };

  const composition = await selectComposition({ serveUrl, id, inputProps: props, browserExecutable: chromePath() });

  fs.mkdirSync(path.dirname(input.outputFile), { recursive: true });
  const rawVideo = input.outputFile.replace(/\.mp4$/i, '.raw.mp4');

  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    // Render a generous intermediate; ffmpeg produces the delivery bitrate.
    videoBitrate: input.quality === 'preview' ? '4M' : '16M',
    outputLocation: rawVideo,
    inputProps: props,
    browserExecutable: chromePath(),
    chromiumOptions: { gl: 'swangle', headless: true },
    concurrency: Math.max(1, Math.min(4, (globalThis as any).navigator?.hardwareConcurrency ?? 2)),
    imageFormat: 'jpeg',
    jpegQuality: 95,
    enforceAudioTrack: false,
    onProgress: ({ progress }) => input.onProgress?.(progress * 0.7, 'Rendering frames'),
  });

  return { rawVideo, spec };
}

export interface MuxOpts {
  rawVideo: string;
  audioFile?: string | null;
  outFile: string;
  spec: ExportSpec;
  videoBitrate: string;
  maxrate: string;
  /**
   * Hard cap on the delivered duration, in seconds. The rendered video is the
   * authority for how long the piece is; the voiceover is a single long file
   * that covers every scene, so without this a Short would be padded out to
   * the full narration length.
   */
  durationSec?: number;
  /**
   * Final export must measure the narration. A null durationSec or a failed
   * measurement is a refusal, not a skipped length check. Preview leaves this
   * unset and keeps the previous check.
   */
  finalExport?: boolean;
  onProgress?: (p: number, note?: string) => void;
}

export function finalNarrationLengthRefusal(input: {
  finalExport: boolean;
  hasAudio: boolean;
  durationSec: number | null | undefined;
  measuredSeconds: number | null;
}): string | null {
  if (!input.finalExport || !input.hasAudio) return null;
  if (input.measuredSeconds === null || !(input.measuredSeconds > 0)) {
    return 'The narration duration could not be measured. Final export was not started, and the length check was not skipped.';
  }
  if (typeof input.durationSec !== 'number' || !Number.isFinite(input.durationSec) || !(input.durationSec > 0)) {
    return 'The planned video duration is unknown. Final export was not started, and the length check was not skipped because durationSec was missing.';
  }
  if (input.durationSec + 0.05 < input.measuredSeconds) {
    return (
      `Refusing to encode: the planned timeline is ` +
      `${(input.measuredSeconds - input.durationSec).toFixed(2)}s shorter than the narration ` +
      `(${input.measuredSeconds.toFixed(2)}s), so the final words would be cut. ` +
      'Regenerate the storyboard from the imported audio, or extend the last scene.'
    );
  }
  return null;
}

/**
 * Final encode. Every delivery requirement from the brief is enforced HERE and
 * then verified with ffprobe afterwards - export settings alone are not trusted.
 */
export async function muxAndEncode(o: MuxOpts) {
  const args: string[] = [
    '-y',
    '-i', o.rawVideo,
  ];
  if (o.audioFile && fs.existsSync(o.audioFile)) args.push('-i', o.audioFile);

  args.push(
    '-map', '0:v:0',
  );
  if (o.audioFile && fs.existsSync(o.audioFile)) args.push('-map', '1:a:0');

  args.push(
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', 'medium',
    '-pix_fmt', o.spec.pixFmt,
    '-r', String(o.spec.fps),
    '-b:v', o.videoBitrate,
    '-maxrate', o.maxrate,
    '-bufsize', `${parseInt(o.maxrate, 10) * 2}M`,
    '-g', String(o.spec.fps * 2),
    '-movflags', '+faststart',
    '-vsync', 'cfr',
  );

  const hasAudio = !!(o.audioFile && fs.existsSync(o.audioFile));
  if (hasAudio) {
    /* VS4 — the narration may NEVER be cut to fit the picture.
     *
     * `-shortest` used to be here. With two inputs it stops the encode at
     * whichever stream ends first, so a narration that ended early truncated
     * the video (the silent end card was cut) and a narration longer than the
     * picture was silently truncated at the picture length. Both are exactly
     * the "losing speech" failure VS4 forbids.
     *
     * The video stream now defines the length on its own and `-t durationSec`
     * remains the single explicit cap. The planned timeline is checked against
     * the measured audio BEFORE the encode (VS4 export gate), so a timeline
     * shorter than the narration can no longer reach this point. */
    let audioSeconds: number | null = null;
    try {
      audioSeconds = await durationOf(o.audioFile as string);
    } catch {
      audioSeconds = null;
    }
    const finalRefusal = finalNarrationLengthRefusal({
      finalExport: o.finalExport === true,
      hasAudio: true,
      durationSec: o.durationSec,
      measuredSeconds: audioSeconds,
    });
    if (finalRefusal) throw new Error(finalRefusal);
    if (
      audioSeconds !== null &&
      audioSeconds > 0 &&
      typeof o.durationSec === 'number' &&
      o.durationSec > 0 &&
      o.durationSec + 0.05 < audioSeconds
    ) {
      throw new Error(
        `Refusing to encode ${path.basename(o.outFile)}: the planned timeline is ` +
          `${(audioSeconds - o.durationSec).toFixed(2)}s shorter than the narration ` +
          `(${audioSeconds.toFixed(2)}s), so the final words would be cut. ` +
          'Regenerate the storyboard from the imported audio, or extend the last scene.',
      );
    }
    args.push(
      '-c:a', o.spec.audioCodec,
      '-ar', String(o.spec.audioSampleRate),
      '-ac', '2',
      '-b:a', '224k',
      '-profile:a', 'aac_low',
    );
  } else {
    args.push('-an');
  }

  // belt and braces: trim to the intended duration regardless of the inputs
  if (o.durationSec && o.durationSec > 0) args.push('-t', o.durationSec.toFixed(3));

  args.push(o.outFile);

  o.onProgress?.(0.75, 'Encoding delivery file');
  await runOrThrow(ffmpegPath(), args, { maxBuffer: 64 * 1024 * 1024 });
  o.onProgress?.(0.95, 'Encoding done');

  // intermediate is large and reproducible - never shipped
  try {
    fs.rmSync(o.rawVideo, { force: true });
  } catch {
    /* ignore */
  }
  return o.outFile;
}

export async function renderThumbnails(opts: {
  scenes: Scene[];
  videoId: string;
  count: number;
  outDir: string;
  videoProps: Record<string, unknown>;
  onProgress?: (p: number) => void;
}): Promise<string[]> {
  const serveUrl = await getServeUrl();
  const composition = await selectComposition({ serveUrl, id: 'LongVideo', inputProps: opts.videoProps, browserExecutable: chromePath() });
  fs.mkdirSync(opts.outDir, { recursive: true });
  const out: string[] = [];
  // pick frames that sit inside visually distinct scenes, not in transitions
  const picks: number[] = [];
  const acc: number[] = [];
  let at = 0;
  for (const s of opts.scenes) {
    acc.push(at + Math.min(1.2, s.duration * 0.5));
    at += s.duration;
  }
  for (let i = 0; i < opts.count; i++) {
    const idx = Math.floor((i / opts.count) * acc.length);
    picks.push(Math.min(composition.durationInFrames - 1, Math.round((acc[idx] ?? 0) * 30)));
  }
  for (let i = 0; i < picks.length; i++) {
    const file = path.join(opts.outDir, `thumb_${String(i + 1).padStart(2, '0')}.png`);
    await renderStill({
      composition,
      serveUrl,
      output: file,
      inputProps: opts.videoProps,
      frame: picks[i],
      browserExecutable: chromePath(),
      chromiumOptions: { gl: 'swangle', headless: true },
      imageFormat: 'png',
    });
    out.push(file);
    opts.onProgress?.((i + 1) / picks.length);
  }
  return out;
}

export function ctaFor(entry: HistoryEntry | undefined): CtaAnimationId {
  return (entry?.ctaAnimation ?? 'slide_in') as CtaAnimationId;
}

export function captionStyleFor(entry: HistoryEntry | undefined): CaptionStyleId {
  return (entry?.captionStyle ?? 'boxed_center') as CaptionStyleId;
}
