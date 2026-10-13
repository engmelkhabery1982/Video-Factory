import fs from 'node:fs';
import path from 'node:path';
import { ffmpegPath, ffprobePath, pickStream, probe, run } from './platform.js';
import type { ProbeInfo } from '@buildtrack/core';

export interface MediaAnalysis extends ProbeInfo {
  formatName: string;
  sizeBytes: number;
  /** seconds of near-black video detected */
  blackSeconds: number;
  blackIntervals: number;
  /** longest silent stretch in the audio track */
  longestSilence: number;
  silenceCount: number;
}

export async function analyseFile(file: string, opts: { silenceThresholdDb?: number; minSilenceSec?: number } = {}): Promise<MediaAnalysis> {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const json = await probe(file);
  const v = pickStream(json, 'video');
  const a = pickStream(json, 'audio');
  if (!v) throw new Error(`No video stream in ${path.basename(file)}`);

  const info: MediaAnalysis = {
    width: Number(v.width),
    height: Number(v.height),
    r_frame_rate: String(v.r_frame_rate ?? '0/1'),
    codec_name: String(v.codec_name),
    profile: v.profile,
    pix_fmt: v.pix_fmt,
    bit_rate: v.bit_rate ? String(v.bit_rate) : String(json.format?.bit_rate ?? '0'),
    duration: Number(json.format?.duration ?? v.duration ?? 0),
    hasAudio: !!a,
    audioCodec: a?.codec_name,
    audioBitrate: a?.bit_rate ? String(a.bit_rate) : undefined,
    audioSampleRate: a?.sample_rate ? String(a.sample_rate) : undefined,
    audioChannels: a?.channels,
    formatName: String(json.format?.format_name ?? ''),
    sizeBytes: Number(json.format?.size ?? fs.statSync(file).size),
    blackSeconds: 0,
    blackIntervals: 0,
    longestSilence: 0,
    silenceCount: 0,
  };

  // black / empty frame detection (visual QC)
  const black = await run(ffmpegPath(), [
    '-hide_banner', '-nostats', '-i', file,
    '-vf', 'blackdetect=d=0.35:pix_th=0.08',
    '-an', '-f', 'null', '-',
  ]);
  const blackMatches = [...(black.stderr ?? '').matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)];
  info.blackIntervals = blackMatches.length;
  info.blackSeconds = blackMatches.reduce((acc, m) => acc + Number(m[3] ?? 0), 0);

  // audio silence detection (technical QC)
  if (info.hasAudio) {
    const thr = opts.silenceThresholdDb ?? -45;
    const minSec = opts.minSilenceSec ?? 1.2;
    const sil = await run(ffmpegPath(), [
      '-hide_banner', '-nostats', '-i', file,
      '-af', `silencedetect=noise=${thr}dB:d=${minSec}`,
      '-vn', '-f', 'null', '-',
    ]);
    const starts = [...(sil.stderr ?? '').matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...(sil.stderr ?? '').matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
    info.silenceCount = starts.length;
    let longest = 0;
    for (let i = 0; i < starts.length; i++) {
      const e = ends[i] ?? info.duration;
      longest = Math.max(longest, e - starts[i]);
    }
    info.longestSilence = longest;
  }

  return info;
}

export async function durationOf(file: string): Promise<number> {
  const json = await probe(file);
  return Number(json.format?.duration ?? 0);
}

/**
 * Measured duration of an AUDIO file. The file must contain an audio stream:
 * ffprobe will read arbitrary bytes as some raw format and report a duration,
 * so a container duration alone is not evidence that the file is audio.
 */
export async function audioDurationOf(file: string): Promise<number> {
  const json = await probe(file);
  const a = pickStream(json, 'audio');
  if (!a) throw new Error('no audio stream');
  const d = Number(json.format?.duration ?? a.duration ?? 0);
  if (!(Number.isFinite(d) && d > 0)) throw new Error('no positive duration');
  return d;
}

/**
 * Build a contact sheet from a finished video so a reviewer can audit the whole
 * timeline without scrubbing the file (brief section 18).
 */
export async function contactSheet(opts: {
  videoFile: string;
  outFile: string;
  cols?: number;
  rows?: number;
  width?: number;
}): Promise<string> {
  const cols = opts.cols ?? 4;
  const rows = opts.rows ?? 3;
  const total = cols * rows;
  const w = opts.width ?? 480;
  const dur = await durationOf(opts.videoFile);
  // step through the file at even intervals so the sheet covers the whole runtime
  const step = dur > 0 ? dur / (total + 1) : 1;
  // Cell heights must be chroma-safe (EVEN). A 9:16 Short at the default width
  // asks for Math.round(480 * 16 / 9) = 853 (odd); FFmpeg then aligns the pad
  // filter's padded area down to 480x852 while scale supplies a 480x853 frame,
  // so the pad filter can never configure and the extraction dies with
  // "[Parsed_pad_2] Input area 0:0:480:853 not within the padded area
  // 0:0:480:852" -> READINESS_MEDIA_STILLS_FAILED (thumbnails_contact_sheets).
  // Normalizing the computed height to the next even integer keeps the padded
  // area >= the scaled input. The already-even landscape cell (480*9/16 = 270)
  // is unchanged.
  const rawH = /short/i.test(opts.videoFile) ? (w * 16) / 9 : (w * 9) / 16;
  const h = Math.ceil(rawH / 2) * 2;
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  await runOrThrowChecked(ffmpegPath(), [
    '-y', '-i', opts.videoFile,
    '-vf',
    `fps=1/${step.toFixed(3)},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,tile=${cols}x${rows}`,
    '-frames:v', '1',
    opts.outFile,
  ]);
  return opts.outFile;
}

async function runOrThrowChecked(cmd: string, args: string[]) {
  const r = await run(cmd, args, { maxBuffer: 32 * 1024 * 1024 });
  if (r.code !== 0) {
    // tile can fail on very short clips; surface it but never crash a render
    throw new Error(`contact sheet failed: ${r.stderr.slice(-1500)}`);
  }
  return r;
}

export async function extractPoster(videoFile: string, outFile: string, atSec = 2) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await run(ffmpegPath(), ['-y', '-ss', String(atSec), '-i', videoFile, '-frames:v', '1', '-q:v', '2', outFile]);
  return outFile;
}

export async function verifySpec(file: string) {
  const a = await analyseFile(file);
  return { file, analysis: a, probePath: ffprobePath() };
}

/**
 * Container signature of a file, read from its first bytes. ffprobe will guess a
 * format for almost any bytes (raw data was measured as AMR-NB audio with a
 * 3000 s duration), so the header must also be a real audio or video container
 * before a measurement is trusted.
 */
export function sniffMediaContainer(file: string): 'audio' | 'video' | null {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const b = head.subarray(0, n);
    const at = (i: number, s: string) => b.length >= i + s.length && b.subarray(i, i + s.length).toString('latin1') === s;
    if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio';
    if (at(0, 'RIFF') && at(8, 'AVI ')) return 'video';
    if (at(0, 'ID3') || at(0, 'OggS') || at(0, 'fLaC')) return 'audio';
    if (at(0, 'FORM') && (at(8, 'AIFF') || at(8, 'AIFC'))) return 'audio';
    if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio'; // MPEG / ADTS frame sync
    if (at(4, 'ftyp')) return 'video'; // MP4 / M4A / MOV family; ffprobe then tells audio-only from video
    if (at(4, 'moov') || at(4, 'mdat') || at(4, 'wide') || at(4, 'free')) return 'video';
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video'; // EBML: WebM / MKV
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Measure an uploaded audio or video file. The measured type comes from the
 * streams ffprobe finds, after the container signature has been checked. A
 * declared type that does not match the measured one is refused by the caller.
 */
export async function measureUpload(file: string): Promise<{ kind: 'audio' | 'video' | null; durationSec: number | null; width?: number; height?: number; reason?: string }> {
  const sniffed = sniffMediaContainer(file);
  if (!sniffed) return { kind: null, durationSec: null, reason: 'The file is not a recognised audio or video container.' };
  const json = await probe(file);
  const v = pickStream(json, 'video');
  const a = pickStream(json, 'audio');
  const kind: 'audio' | 'video' | null = v ? 'video' : a ? 'audio' : null;
  if (!kind) return { kind: null, durationSec: null, reason: 'The file has no audio or video stream.' };
  const d = Number(json.format?.duration ?? (v ?? a)?.duration ?? 0);
  if (!(Number.isFinite(d) && d > 0)) return { kind, durationSec: null, reason: 'The file has no positive duration.' };
  return {
    kind,
    durationSec: Math.round(d * 1000) / 1000,
    width: v ? Number(v.width) || undefined : undefined,
    height: v ? Number(v.height) || undefined : undefined,
  };
}
