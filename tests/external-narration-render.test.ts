/**
 * VS4 — the delivery encode never cuts accepted narration.
 *
 * `muxAndEncode` used to pass `-shortest` to ffmpeg. With a video input and an
 * audio input that stops the encode at whichever stream ends first, so a
 * narration that ended early truncated the video (the silent end card was cut)
 * and a narration longer than the picture was silently cut at the picture
 * length. Both are the "losing speech" failure VS4 forbids.
 *
 * These tests use REAL ffmpeg on REAL generated inputs (a tiny video and a real
 * WAV fixture) — TEST/FIXTURE, deterministic, no browser, no engine — and prove
 * the encode contract directly:
 *   1. the delivered file is never shorter than the narration;
 *   2. an explicit refusal is raised when the planned timeline is shorter than
 *      the narration, instead of quietly trimming it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'ext-audio-render-suite');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(root, { recursive: true });
  return { root };
});

import { ffmpegPath } from '../apps/api/src/services/platform.js';
import { durationOf } from '../apps/api/src/services/media.js';
import { exportSpecFor, muxAndEncode } from '../apps/api/src/services/render.js';
import { referenceWavBuffer } from './helpers/chatterbox-worker-fixtures.js';

let narration: string;
const NARRATION_SECONDS = 4;

/** `muxAndEncode` consumes its raw input, so each test gets a fresh one. */
function makeRawVideo(name: string): string {
  const file = path.join(tmp.root, `${name}.raw.mp4`);
  execFileSync(
    ffmpegPath(),
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=12:d=12',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', file,
    ],
    { stdio: 'pipe' },
  );
  return file;
}

beforeAll(() => {
  /* A real 4 s WAV narration (TEST/FIXTURE). */
  narration = path.join(tmp.root, 'narration.wav');
  fs.writeFileSync(narration, referenceWavBuffer('narration', NARRATION_SECONDS));
});

afterAll(() => {
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('VS4: the delivered file keeps the whole narration', () => {
  it('encodes a video whose length is the planned timeline, without -shortest truncation', async () => {
    const out = path.join(tmp.root, 'covered.mp4');
    await muxAndEncode({
      rawVideo: makeRawVideo('covered'),
      audioFile: narration,
      outFile: out,
      spec: exportSpecFor('long'),
      videoBitrate: '2M',
      maxrate: '3M',
      durationSec: 6,
    });
    expect(fs.existsSync(out)).toBe(true);
    const encoded = await durationOf(out);
    /* The timeline is the authority and it covers the narration. */
    expect(encoded).toBeGreaterThanOrEqual(NARRATION_SECONDS - 0.05);
    expect(encoded).toBeLessThanOrEqual(6 + 0.2);
  }, 120_000);

  it('keeps the silent end card when the narration ends early', async () => {
    const out = path.join(tmp.root, 'endcard.mp4');
    await muxAndEncode({
      rawVideo: makeRawVideo('endcard'),
      audioFile: narration,
      outFile: out,
      spec: exportSpecFor('long'),
      videoBitrate: '2M',
      maxrate: '3M',
      durationSec: 6,
    });
    /* Without `-shortest` the video keeps its own full length even though the
     * audio stream ends first — the end card is no longer cut off. */
    const encoded = await durationOf(out);
    expect(encoded).toBeGreaterThan(NARRATION_SECONDS + 0.5);
  }, 120_000);

  it('refuses to encode when the planned timeline is shorter than the narration', async () => {
    const out = path.join(tmp.root, 'refused.mp4');
    await expect(
      muxAndEncode({
        rawVideo: makeRawVideo('refused'),
        audioFile: narration,
        outFile: out,
        spec: exportSpecFor('long'),
        videoBitrate: '2M',
        maxrate: '3M',
        durationSec: 2,
      }),
    ).rejects.toThrow(/shorter than the narration/i);
    expect(fs.existsSync(out)).toBe(false);
  }, 120_000);

  it('still encodes a silent video when there is no narration', async () => {
    const out = path.join(tmp.root, 'silent.mp4');
    await muxAndEncode({
      rawVideo: makeRawVideo('silent'),
      audioFile: null,
      outFile: out,
      spec: exportSpecFor('long'),
      videoBitrate: '2M',
      maxrate: '3M',
      durationSec: 3,
    });
    expect(fs.existsSync(out)).toBe(true);
    expect(await durationOf(out)).toBeLessThanOrEqual(3.2);
  }, 120_000);
});
