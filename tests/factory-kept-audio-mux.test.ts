/**
 * Kept clip audio in the export mux, proved with the real bundled ffmpeg/ffprobe.
 *
 * Evidence labels:
 *  - Real local engine evidence (ffmpeg/ffprobe), no browser. The "raw render" fixtures stand in for
 *    what Remotion emits: an unmuted OffthreadVideo render carries an audio stream; a muted one does not.
 *  - The actual Remotion emission of that stream is a separate, browser-gated step (see delivery notes);
 *    what is proved here is that muxPreviewVideo keeps, mixes or strips audio exactly per the document.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditorDocument } from '@buildtrack/core';
import { keptClipAudioInRange, muxPreviewVideo } from '../apps/api/src/services/editor-render.js';
import { ffmpegPath, ffprobePath } from '../apps/api/src/services/platform.js';

let work = '';
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
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-kept-audio-'));
  if (!ffmpegOk) return;
  // A "raw render" with embedded clip audio (unmuted OffthreadVideo stand-in).
  execFileSync(ffmpegPath(), [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-t', '2',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', path.join(work, 'raw-voiced.mp4'),
  ]);
  // A muted raw render: video only, no audio stream.
  execFileSync(ffmpegPath(), [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-t', '2',
    '-an', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', path.join(work, 'raw-silent.mp4'),
  ]);
  execFileSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', path.join(work, 'narration.wav')]);
});

afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

function docWith(visualClips: EditorDocument['visualClips'], audioClips: EditorDocument['audioClips'] = []): EditorDocument {
  return { durationSec: 2, visualClips, audioClips } as unknown as EditorDocument;
}
const keptClip = { id: 'vc_1', startSec: 0, durationSec: 2, keepAudio: true } as unknown as EditorDocument['visualClips'][number];
const mutedClip = { id: 'vc_1', startSec: 0, durationSec: 2, keepAudio: false } as unknown as EditorDocument['visualClips'][number];

describe('keptClipAudioInRange (pure)', () => {
  it('is true only for keepAudio clips overlapping the requested range', () => {
    const doc = docWith([keptClip]);
    expect(keptClipAudioInRange(doc, { startSec: 0, endSec: 2 })).toBe(true);
    expect(keptClipAudioInRange(doc, { startSec: 2, endSec: 4 })).toBe(false);
    expect(keptClipAudioInRange(docWith([mutedClip]), { startSec: 0, endSec: 2 })).toBe(false);
    expect(keptClipAudioInRange(docWith([]), { startSec: 0, endSec: 2 })).toBe(false);
  });
});

describe('muxPreviewVideo with kept clip audio (real ffmpeg)', () => {
  it('kept audio only: the output carries one audio and one video stream', async () => {
    const out = path.join(work, 'kept-only.mp4');
    const raw = path.join(work, 'raw-voiced-1.mp4');
    fs.copyFileSync(path.join(work, 'raw-voiced.mp4'), raw);
    const r = await muxPreviewVideo({
      rawVideo: raw,
      doc: docWith([keptClip]),
      range: { startSec: 0, endSec: 2 },
      audioFiles: {},
      outputFile: out,
      expectedDurationSec: 2,
    });
    expect(r.hasAudio).toBe(true);
    expect(streamsOf(out)).toEqual({ audio: 1, video: 1 });
  });

  it('kept clip audio plus a narration clip: exactly one mixed audio stream', async () => {
    const out = path.join(work, 'kept-plus-narr.mp4');
    const raw2 = path.join(work, 'raw-voiced-2.mp4');
    fs.copyFileSync(path.join(work, 'raw-voiced.mp4'), raw2);
    const narration = {
      id: 'ac_1', sourceAssetId: 'narr-1', speakerId: null, startSec: 0, sourceInSec: 0, sourceOutSec: 2, gainDb: 0, locked: false, approved: false,
    } as unknown as EditorDocument['audioClips'][number];
    const r = await muxPreviewVideo({
      rawVideo: raw2,
      doc: docWith([keptClip], [narration]),
      range: { startSec: 0, endSec: 2 },
      audioFiles: { 'narr-1': path.join(work, 'narration.wav') },
      outputFile: out,
      expectedDurationSec: 2,
    });
    expect(r.hasAudio).toBe(true);
    expect(streamsOf(out)).toEqual({ audio: 1, video: 1 });
  });

  it('legacy muted document: a raw file that happens to contain audio is still exported with ZERO audio streams', async () => {
    const out = path.join(work, 'legacy-muted.mp4');
    const raw3 = path.join(work, 'raw-voiced-3.mp4');
    fs.copyFileSync(path.join(work, 'raw-voiced.mp4'), raw3);
    const r = await muxPreviewVideo({
      rawVideo: raw3,
      doc: docWith([mutedClip]),
      range: { startSec: 0, endSec: 2 },
      audioFiles: {},
      outputFile: out,
      expectedDurationSec: 2,
    });
    expect(r.hasAudio).toBe(false);
    expect(streamsOf(out)).toEqual({ audio: 0, video: 1 });
  });

  it('a keepAudio document whose raw render has no audio stream fails loudly instead of succeeding silently', async () => {
    fs.copyFileSync(path.join(work, 'raw-silent.mp4'), path.join(work, 'raw-silent-copy.mp4'));
    const out = path.join(work, 'must-not-exist.mp4');
    await expect(muxPreviewVideo({
      rawVideo: path.join(work, 'raw-silent-copy.mp4'),
      doc: docWith([keptClip]),
      range: { startSec: 0, endSec: 2 },
      audioFiles: {},
      outputFile: out,
      expectedDurationSec: 2,
    })).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
  });
});
