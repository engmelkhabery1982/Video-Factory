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
import { editorDocumentToRenderPlan, EditorError, REMOTION_LAYOUT, resolveDocumentIdentity, unboundVisualSystem, type EditorDocument } from '@buildtrack/core';
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
export function previewFrames(doc: EditorDocument, range: PreviewRange, opts: { full?: boolean } = {}): { startFrame: number; endFrame: number } {
  const { startSec, endSec } = range;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
    throw new EditorError('PREVIEW_RANGE_INVALID', 'The preview range must be finite, start at or after 0 and end after it starts.', 400);
  }
  // A final export is the whole frozen document; the 30 s cap is for previews only.
  if (!opts.full && endSec - startSec > PREVIEW_MAX_SEC + 1e-6) {
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
 * ffmpeg audio graph for [a, b) of composition time. Every audio clip that
 * overlaps the range becomes one input chain: it starts at clip.startSec, reads
 * from clip.sourceInSec (offset by how much of the clip lies before the range),
 * applies clip.gainDb, and is mixed with the others over silence. Clips that do
 * not overlap are ignored. `inputAssetIds` lists the audio files, in input order
 * (ffmpeg input index = position + 1), that the caller must pass with -i.
 */
export function audioGraphFor(doc: EditorDocument, range: PreviewRange): { filter: string; inputAssetIds: string[]; clipCount: number } {
  const dur = (range.endSec - range.startSec).toFixed(3);
  const chains: string[] = [];
  const inputAssetIds: string[] = [];
  for (const clip of doc.audioClips) {
    const clipLen = clip.sourceOutSec - clip.sourceInSec;
    const clipStart = clip.startSec;
    const clipEnd = clipStart + clipLen;
    const a = Math.max(clipStart, range.startSec);
    const b = Math.min(clipEnd, range.endSec);
    if (!(b > a + 1e-6)) continue;
    let idx = inputAssetIds.indexOf(clip.sourceAssetId);
    if (idx < 0) {
      inputAssetIds.push(clip.sourceAssetId);
      idx = inputAssetIds.length - 1;
    }
    const srcStart = clip.sourceInSec + (a - clipStart);
    const delayMs = Math.round((a - range.startSec) * 1000);
    const parts = [
      `[${idx + 1}:a]atrim=start=${srcStart.toFixed(3)}:duration=${(b - a).toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
      `volume=${clip.gainDb.toFixed(2)}dB`,
      'aresample=48000',
      'aformat=channel_layouts=stereo',
    ];
    // Per-channel delay values: older ffmpeg builds do not accept the `all` option.
    if (delayMs > 0) parts.push(`adelay=${delayMs}|${delayMs}`);
    // Every clip is padded and trimmed to the range, so all inputs have equal length.
    parts.push('apad', `atrim=duration=${dur}`);
    // The output label attaches directly to the last filter (no comma before it).
    chains.push(`${parts.join(',')}[c${chains.length}]`);
  }
  if (chains.length === 0) {
    return { filter: `anullsrc=r=48000:cl=stereo,atrim=duration=${dur}[a]`, inputAssetIds: [], clipCount: 0 };
  }
  const n = chains.length;
  if (n === 1) return { filter: `${chains[0]};[c0]anull[a]`, inputAssetIds, clipCount: 1 };
  // Sum with unit gain. amix would scale by the input count and normalize on newer builds,
  // so the configured clip gains would depend on the ffmpeg version. amerge + pan does not.
  const sumL = Array.from({ length: n }, (_, i) => `c${2 * i}`).join('+');
  const sumR = Array.from({ length: n }, (_, i) => `c${2 * i + 1}`).join('+');
  const merge = `${chains.map((_, i) => `[c${i}]`).join('')}amerge=inputs=${n},pan=stereo|c0=${sumL}|c1=${sumR}[a]`;
  return { filter: [...chains, merge].join(';'), inputAssetIds, clipCount: n };
}

export interface PreviewInput {
  videoId: string;
  doc: EditorDocument;
  project: Project;
  range: PreviewRange;
  /** True for a final export: the range may be the whole document. */
  full?: boolean;
  /** Absolute audio file per audio asset id, already checked against the frozen revision's sha256. */
  audioFiles: Record<string, string>;
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
  /** True when the narration clip is inside the range. */
  hasNarration: boolean;
  /** Audio clips inside the range. */
  audioClips: number;
  /** Distinct audio source files inside the range (narration and library audio count separately). */
  audioSources: number;
  /** Orientation the document asked for and the composition that rendered it. */
  format: 'landscape' | 'portrait';
  compositionId: 'LongVideo' | 'ShortVideo';
  compositionWidth: number;
  compositionHeight: number;
  channelBrandId: string | null;
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
  const { startFrame, endFrame } = previewFrames(doc, range, { full: input.full === true });
  const plan = editorDocumentToRenderPlan(doc);
  // Channel identity comes from the canonical document, the same resolver the
  // editor UI uses. A refused identity (e.g. BuildTrack on religious content) is
  // not rendered. A blank identity renders with no name, no CTA and no logo.
  const identity = resolveDocumentIdentity(doc);
  if (identity.status === 'refused') {
    throw new EditorError('EDITOR_IDENTITY_REFUSED', identity.refusal ?? 'The channel identity is refused.', 409);
  }

  // Every asset the document references, by its own id, is reached through the
  // same origin the rest of the app uses. Nothing is read from a live revision.
  const mediaMap: Record<string, string> = {};
  for (const a of doc.assets) {
    if (a.kind !== 'audio') mediaMap[a.id] = `${input.mediaOrigin}${a.mediaUrl}`;
  }
  // Orientation follows the document format: landscape is LongVideo, portrait is ShortVideo.
  const id: 'LongVideo' | 'ShortVideo' = doc.format === 'landscape' ? 'LongVideo' : 'ShortVideo';
  const expectedLayout = doc.format === 'landscape' ? REMOTION_LAYOUT.long : REMOTION_LAYOUT.short;
  const props = {
    scenes: plan.scenes,
    captions: plan.captions,
    brand: identity.brand ?? unboundVisualSystem(doc.contentProfile),
    format: doc.format === 'landscape' ? 'long' : 'short',
    ctaAnimation: ctaFor(undefined),
    captionStyle: captionStyleFor(undefined),
    // A bound identity names the channel and may carry its CTA. Without one the
    // composition gets no product name, no CTA text and no logo.
    ctaText: identity.status === 'bound' ? (input.project.meta.input.cta ?? '') : '',
    productName: identity.status === 'bound' ? identity.brand!.name : '',
    logoSrc: identity.logoAssetId ? (mediaMap[identity.logoAssetId] ?? null) : null,
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
  if (composition.width !== expectedLayout.width || composition.height !== expectedLayout.height) {
    throw new EditorError('PREVIEW_ORIENTATION_MISMATCH', `The ${id} composition is ${composition.width}x${composition.height}; ${doc.format} needs ${expectedLayout.width}x${expectedLayout.height}.`, 500);
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

  const audio = audioGraphFor(doc, range);
  const args = ['-y', '-i', rawVideo];
  for (const assetId of audio.inputAssetIds) {
    const file = input.audioFiles[assetId];
    if (!file) {
      throw new EditorError('EDITOR_NARRATION_CHANGED', `The audio file for ${assetId} is missing for this preview.`, 409);
    }
    args.push('-i', file);
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
    hasNarration: audio.inputAssetIds.includes('narration'),
    audioClips: audio.clipCount,
    audioSources: audio.inputAssetIds.length,
    format: doc.format,
    compositionId: id,
    compositionWidth: composition.width,
    compositionHeight: composition.height,
    channelBrandId: plan.channelBrandId,
  };
}
