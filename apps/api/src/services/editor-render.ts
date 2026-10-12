/**
 * Short preview renderer for the editor (milestone 1).
 *
 * Input is ONE frozen editor revision and a [startSec, endSec) range in
 * composition time. Frames come from the existing LongVideo / ShortVideo
 * composition through Remotion's frameRange; narration is cut from the
 * project's own WAV with the same offset rules as the document's audio clip.
 * Output is verified with ffprobe before it is reported as ready.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { editorDocumentToRenderPlan, EditorError, type EditorDocument } from '@buildtrack/core';
import type { Project } from '@buildtrack/core';
import { captionStyleFor, ctaFor, getServeUrl } from './render.js';
import { chromePath, ffmpegPath, ffprobePath, runOrThrow } from './platform.js';

const execFileAsync = promisify(execFile);

export const PREVIEW_FPS = 30;
export const PREVIEW_MAX_SEC = 30;
/** Allowed gap between the frame-exact range and the probed file duration. */
export const PREVIEW_DURATION_TOLERANCE_SEC = 0.12;

export function previewAvailability(): { available: boolean; reason: string | null } {
  // Owner switch: previews can be turned off without touching the renderer.
  if (process.env.VF_PREVIEW_DISABLE === '1') return { available: false, reason: 'Preview is turned off by VF_PREVIEW_DISABLE=1.' };
  try {
    const chrome = chromePath();
    if (!fs.existsSync(chrome)) return { available: false, reason: `The browser for Remotion was not found at ${chrome}.` };
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
  try {
    fs.accessSync(ffmpegPath(), fs.constants.X_OK);
    fs.accessSync(ffprobePath(), fs.constants.X_OK);
  } catch {
    return { available: false, reason: 'ffmpeg or ffprobe is not runnable on this host.' };
  }
  return { available: true, reason: null };
}

export interface PreviewRange {
  startSec: number;
  endSec: number;
}

/** Frame-exact bounds of the preview. Ends are exclusive. Throws on anything outside the document. */
export function previewFrames(doc: EditorDocument, range: PreviewRange): { startFrame: number; endFrame: number } {
  const { startSec, endSec } = range;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
    throw new EditorError('PREVIEW_RANGE_INVALID', 'The preview range must be finite, start at or after 0 and end after it starts.', 400);
  }
  if (endSec - startSec > PREVIEW_MAX_SEC + 1e-6) {
    throw new EditorError('PREVIEW_RANGE_TOO_LONG', `A preview is at most ${PREVIEW_MAX_SEC} seconds.`, 400);
  }
  if (endSec > doc.durationSec + 1e-6) {
    throw new EditorError('PREVIEW_RANGE_INVALID', `The range ends after the document (${doc.durationSec}s).`, 400);
  }
  const startFrame = Math.round(startSec * PREVIEW_FPS);
  const endFrame = Math.round(endSec * PREVIEW_FPS);
  if (endFrame <= startFrame) throw new EditorError('PREVIEW_RANGE_INVALID', 'The range is shorter than one frame.', 400);
  return { startFrame, endFrame };
}

/**
 * ffmpeg audio graph for [a, b) of composition time. The narration clip starts at
 * clip.startSec in composition time and reads from clip.sourceInSec. A clip that
 * starts after `a` is delayed; a clip that started before `a` is read from the
 * matching source offset. Outside the clip the output is silence.
 */
export function narrationFilter(doc: EditorDocument, range: PreviewRange): { filter: string; hasNarration: boolean } {
  const dur = range.endSec - range.startSec;
  const clip = doc.audioClips.find((c) => c.sourceAssetId === 'narration');
  if (!clip) return { filter: `anullsrc=r=48000:cl=stereo,atrim=duration=${dur.toFixed(3)}[a]`, hasNarration: false };
  const clipLen = clip.sourceOutSec - clip.sourceInSec;
  const clipEnd = clip.startSec + clipLen;
  if (clip.startSec >= range.endSec || clipEnd <= range.startSec) {
    return { filter: `anullsrc=r=48000:cl=stereo,atrim=duration=${dur.toFixed(3)}[a]`, hasNarration: false };
  }
  let srcStart: number;
  let delayMs = 0;
  let srcDur: number;
  if (clip.startSec >= range.startSec) {
    srcStart = clip.sourceInSec;
    delayMs = Math.round((clip.startSec - range.startSec) * 1000);
    srcDur = Math.min(clipLen, range.endSec - clip.startSec);
  } else {
    srcStart = clip.sourceInSec + (range.startSec - clip.startSec);
    srcDur = Math.min(clip.sourceOutSec - srcStart, dur);
  }
  const parts = [
    `[1:a]atrim=start=${srcStart.toFixed(3)}:duration=${srcDur.toFixed(3)}`,
    'asetpts=PTS-STARTPTS',
    `volume=${clip.gainDb.toFixed(2)}dB`,
  ];
  if (delayMs > 0) parts.push(`adelay=${delayMs}:all=1`);
  parts.push('aresample=48000', 'aformat=channel_layouts=stereo', `apad`, `atrim=duration=${dur.toFixed(3)}[a]`);
  return { filter: parts.join(','), hasNarration: true };
}

export interface PreviewInput {
  videoId: string;
  doc: EditorDocument;
  project: Project;
  range: PreviewRange;
  /** Absolute narration WAV, already checked against the frozen revision's sha256. */
  narrationFile: string | null;
  /** Origin the Remotion browser uses to fetch project media (server-side, 127.0.0.1). */
  mediaOrigin: string;
  workDir: string;
  outputFile: string;
}

export interface PreviewEvidence {
  revision: number;
  startFrame: number;
  endFrameExclusive: number;
  expectedDurationSec: number;
  probedDurationSec: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  hasNarration: boolean;
}

async function probe(file: string): Promise<{ duration: number; width: number; height: number; hasVideo: boolean; hasAudio: boolean }> {
  const { stdout } = await execFileAsync(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { maxBuffer: 8 * 1024 * 1024 });
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
  const v = info.streams?.find((s) => s.codec_type === 'video');
  return {
    duration: Number(info.format?.duration ?? NaN),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    hasVideo: !!v,
    hasAudio: !!info.streams?.some((s) => s.codec_type === 'audio'),
  };
}

export async function renderEditorPreview(input: PreviewInput): Promise<PreviewEvidence> {
  const { doc, range } = input;
  const { startFrame, endFrame } = previewFrames(doc, range);
  const plan = editorDocumentToRenderPlan(doc);

  // Every asset the document references, by its own id, is reached through the
  // same origin the rest of the app uses. Nothing is read from a live revision.
  const mediaMap: Record<string, string> = {};
  for (const a of doc.assets) {
    if (a.kind !== 'audio') mediaMap[a.id] = `${input.mediaOrigin}${a.mediaUrl}`;
  }
  const id = doc.targetId === 'long' ? 'LongVideo' : 'ShortVideo';
  const props = {
    scenes: plan.scenes,
    captions: plan.captions,
    brand: input.project.meta.brand,
    format: doc.targetId === 'long' ? 'long' : 'short',
    ctaAnimation: ctaFor(undefined),
    captionStyle: captionStyleFor(undefined),
    ctaText: input.project.meta.input.cta ?? '',
    productName: input.project.meta.input.productName ?? '',
    logoSrc: null,
    contentProfile: doc.contentProfile,
    audioSrc: null,
    burnedCaptions: true,
    mediaMap,
    highlights: plan.highlights,
  };

  const serveUrl = await getServeUrl();
  const composition = await selectComposition({ serveUrl, id, inputProps: props as unknown as Record<string, unknown>, browserExecutable: chromePath() });
  const expectedFrames = Math.round(doc.durationSec * PREVIEW_FPS);
  if (composition.fps !== PREVIEW_FPS || composition.durationInFrames !== expectedFrames) {
    throw new EditorError('PREVIEW_TIMING_MISMATCH', `The composition reports ${composition.durationInFrames} frames at ${composition.fps} fps; the document expects ${expectedFrames} at ${PREVIEW_FPS}.`, 500);
  }

  fs.mkdirSync(input.workDir, { recursive: true });
  fs.mkdirSync(path.dirname(input.outputFile), { recursive: true });
  const rawVideo = path.join(input.workDir, 'raw-frames.mp4');
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    videoBitrate: '4M',
    outputLocation: rawVideo,
    inputProps: props as unknown as Record<string, unknown>,
    browserExecutable: chromePath(),
    chromiumOptions: { gl: 'swangle', headless: true },
    concurrency: 2,
    imageFormat: 'jpeg',
    jpegQuality: 90,
    enforceAudioTrack: false,
    frameRange: [startFrame, endFrame - 1],
  });

  const audio = narrationFilter(doc, range);
  const args = ['-y', '-i', rawVideo];
  if (audio.hasNarration) {
    if (!input.narrationFile) {
      throw new EditorError('EDITOR_NARRATION_CHANGED', 'The narration file for this preview is missing.', 409);
    }
    args.push('-i', input.narrationFile);
  }
  args.push(
    '-filter_complex', audio.filter,
    '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(PREVIEW_FPS),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-t', ((endFrame - startFrame) / PREVIEW_FPS).toFixed(3),
    '-movflags', '+faststart',
    input.outputFile,
  );
  await runOrThrow(ffmpegPath(), args, { maxBuffer: 16 * 1024 * 1024 });
  fs.rmSync(rawVideo, { force: true });

  const expectedDurationSec = (endFrame - startFrame) / PREVIEW_FPS;
  const info = await probe(input.outputFile);
  if (!info.hasVideo || !info.hasAudio || !Number.isFinite(info.duration) || Math.abs(info.duration - expectedDurationSec) > PREVIEW_DURATION_TOLERANCE_SEC) {
    throw new EditorError(
      'PREVIEW_VERIFY_FAILED',
      `The preview file did not verify: duration ${info.duration}s, expected ${expectedDurationSec.toFixed(3)}s, video=${info.hasVideo}, audio=${info.hasAudio}.`,
      500,
    );
  }
  return {
    revision: doc.revision,
    startFrame,
    endFrameExclusive: endFrame,
    expectedDurationSec,
    probedDurationSec: info.duration,
    width: info.width,
    height: info.height,
    hasVideo: info.hasVideo,
    hasAudio: info.hasAudio,
    hasNarration: audio.hasNarration,
  };
}
