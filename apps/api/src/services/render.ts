import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import {
  LONG_EXPORT_SPEC,
  SHORT_EXPORT_SPEC,
  type CtaAnimationId,
  type CaptionStyleId,
  type ExportSpec,
  type HistoryEntry,
  type Scene,
} from '@buildtrack/core';
import { ROOT, chromePath, ffmpegPath, prepareBrowserEnv, runOrThrow } from './platform.js';

let serveUrlPromise: Promise<string> | null = null;

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
    });
  }
  return serveUrlPromise;
}

export function resetBundle() {
  serveUrlPromise = null;
}

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
  onProgress?: (p: number, note?: string) => void;
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
    args.push(
      '-c:a', o.spec.audioCodec,
      '-ar', String(o.spec.audioSampleRate),
      '-ac', '2',
      '-b:a', '224k',
      '-profile:a', 'aac_low',
      // the video stream defines the length; never let a longer narration
      // stretch a 24s Short out to the length of the full 95s voiceover
      '-shortest',
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
