/**
 * Zero-audio export, proved with the real ffmpeg binary (no browser).
 *
 * The raw frames are a synthetic test pattern made here by ffmpeg, labelled FIXTURE. The Remotion browser render is
 * NOT exercised here (no Chromium on this host). What this proves is the encode and verify step that every preview
 * and final export passes through: a silent document produces an MP4 with ZERO audio streams, and a document with
 * one audio clip produces exactly one audio stream. ffprobe reads the outputs; nothing is inferred.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditorDocument } from '@buildtrack/core';
import { audioGraphFor, muxPreviewVideo } from '../apps/api/src/services/editor-render.js';
import { ffmpegPath, ffprobePath } from '../apps/api/src/services/platform.js';

let work = '';
/** Decided at collection time (skipIf is evaluated before beforeAll). A host without ffmpeg reports skips, not passes. */
const ffmpegOk = ((): boolean => {
  try {
    execFileSync(ffmpegPath(), ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function streamsOf(file: string): { audio: number; video: number } {
  const out = execFileSync(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', file], { encoding: 'utf8' });
  const streams = (JSON.parse(out).streams ?? []) as Array<{ codec_type: string }>;
  return { audio: streams.filter((x) => x.codec_type === 'audio').length, video: streams.filter((x) => x.codec_type === 'video').length };
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-silent-'));
  if (!ffmpegOk) return;
  execFileSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', path.join(work, 'raw.mp4')]);
  // FIXTURE tone, used only as the narration of the one-clip case.
  execFileSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', path.join(work, 'tone.wav')]);
});

afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

/** Minimal document: only the fields the audio graph reads. Visual and caption fields are not used by the mux. */
function docWith(audioClips: EditorDocument['audioClips']): EditorDocument {
  return { durationSec: 2, audioClips } as unknown as EditorDocument;
}

describe('zero-audio export: audio graph and encode (real ffmpeg, no browser)', () => {
  it('a silent document has no audio clips, so the graph reads no audio input', () => {
    const g = audioGraphFor(docWith([]), { startSec: 0, endSec: 2 });
    expect(g.clipCount).toBe(0);
    expect(g.inputAssetIds).toEqual([]);
  });

  it.skipIf(!ffmpegOk)('silent: the MP4 is verified with ZERO audio streams and one video stream', async () => {
    const out = path.join(work, 'silent.mp4');
    fs.copyFileSync(path.join(work, 'raw.mp4'), path.join(work, 'raw-silent.mp4'));
    const r = await muxPreviewVideo({
      rawVideo: path.join(work, 'raw-silent.mp4'),
      doc: docWith([]),
      range: { startSec: 0, endSec: 2 },
      audioFiles: {},
      outputFile: out,
      expectedDurationSec: 2,
    });
    expect(r.hasAudio).toBe(false);
    expect(streamsOf(out)).toEqual({ audio: 0, video: 1 });
  });

  it.skipIf(!ffmpegOk)('one narration clip: exactly one audio stream, verified', async () => {
    fs.copyFileSync(path.join(work, 'raw.mp4'), path.join(work, 'raw-clip.mp4'));
    const out = path.join(work, 'clip.mp4');
    const clip = {
      id: 'ac_1', sourceAssetId: 'narr-1', speakerId: null, startSec: 0, sourceInSec: 0, sourceOutSec: 2, gainDb: 0, locked: false, approved: false,
    } as unknown as EditorDocument['audioClips'][number];
    const r = await muxPreviewVideo({
      rawVideo: path.join(work, 'raw-clip.mp4'),
      doc: docWith([clip]),
      range: { startSec: 0, endSec: 2 },
      audioFiles: { 'narr-1': path.join(work, 'tone.wav') },
      outputFile: out,
      expectedDurationSec: 2,
    });
    expect(r.hasAudio).toBe(true);
    expect(streamsOf(out)).toEqual({ audio: 1, video: 1 });
  });

  it.skipIf(!ffmpegOk)('a silent document with no raw frames file refuses without writing a silent file', async () => {
    const out = path.join(work, 'never.mp4');
    await expect(muxPreviewVideo({
      rawVideo: path.join(work, 'missing-raw.mp4'),
      doc: docWith([]),
      range: { startSec: 0, endSec: 2 },
      audioFiles: {},
      outputFile: out,
      expectedDurationSec: 2,
    })).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
  });
});
