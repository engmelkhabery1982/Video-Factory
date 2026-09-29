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
  const h = /short/i.test(opts.videoFile) ? Math.round((w * 16) / 9) : Math.round((w * 9) / 16);
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
