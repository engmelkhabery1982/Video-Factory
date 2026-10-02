/**
 * REGRESSION — the Short contact sheet must build from a REAL vertical 9:16 MP4.
 *
 * Final Product Acceptance run 37058906392 reached `render=ok` / `package=ready`
 * and was then blocked by the product's own readiness QC:
 *
 *   READINESS_MEDIA_STILLS_FAILED  (dimension: thumbnails_contact_sheets)
 *   [Parsed_pad_2] Input area 0:0:480:853 not within the padded area 0:0:480:852
 *   [Parsed_pad_2] Failed to configure input pad on Parsed_pad_2
 *   Error reinitializing filters! / Failed to inject frame / Conversion failed!
 *
 * `contactSheet()` sizes every cell `width` wide (default 480) and derives the
 * cell height from the file name: 16:9 for a file whose name matches /short/i,
 * 9:16 otherwise. At the default width that produced an ODD 853px target height
 * for a Short. With a real chroma-subsampled 9:16 input, FFmpeg's pad filter
 * aligns the padded area down to an even 480x852 while scale supplies 480x853,
 * so the pad filter can never configure and the whole extraction fails.
 *
 * These tests use REAL encoded MP4 files produced by the product's own
 * `ffmpegPath()`, call the REAL `contactSheet()` (no mocked FFmpeg, no fixture
 * reuse) and read the REAL output image geometry back with `ffprobePath()`:
 *
 *   - the 9:16 Short case fails before the fix with the exact 480:853/480:852
 *     error class and must build a valid, chroma-safe (even) sheet after it;
 *   - the landscape Long case must keep its pre-existing geometry unchanged.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  return { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-contact-sheet-')) };
});

import { contactSheet } from '../apps/api/src/services/media.js';
import { ffmpegPath, ffprobePath } from '../apps/api/src/services/platform.js';

/** A real encoded MP4, produced by the product's own ffmpeg. */
function makeMp4(file: string, size: string, seconds: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(
    ffmpegPath(),
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', `testsrc=size=${size}:rate=30:duration=${seconds}`,
      '-pix_fmt', 'yuv420p',
      file,
    ],
    { stdio: 'pipe' },
  );
  expect(fs.statSync(file).size).toBeGreaterThan(0);
}

/** Real image geometry, read back with the product's own ffprobe. */
function probeImage(file: string): { width: number; height: number } {
  const out = execFileSync(
    ffprobePath(),
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  ).trim();
  const [width, height] = out.split(',').map(Number);
  return { width, height };
}

describe('contact sheet — real vertical 9:16 Short (acceptance regression 37058906392)', () => {
  // Production names its Short file `short_1.mp4`; the /short/i name is exactly
  // what selected the 16:9 cell height in the failing code path.
  const shortMp4 = path.join(tmp.dir, 'short_1.mp4');
  const longMp4 = path.join(tmp.dir, 'long_1.mp4');

  beforeAll(() => {
    makeMp4(shortMp4, '360x640', 6); // real 9:16 vertical clip
    makeMp4(longMp4, '640x360', 6); // real 16:9 landscape clip
  });

  afterAll(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('builds the Short sheet from a real 9:16 MP4 without an FFmpeg pad failure', async () => {
    const out = path.join(tmp.dir, 'sheet_short.jpg');

    // Pre-fix this REJECTS with:
    //   contact sheet failed: ... [Parsed_pad_2] Input area 0:0:480:853 not
    //   within the padded area 0:0:480:852 ... Conversion failed!
    await expect(contactSheet({ videoFile: shortMp4, outFile: out })).resolves.toBe(out);

    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);

    // tile=4x3 of 480-wide cells. The REAL geometry must be the chroma-safe one:
    // an even cell height (854 = next even integer after 480*16/9), never 853.
    const { width, height } = probeImage(out);
    expect(width).toBe(480 * 4);
    expect(height).toBe(854 * 3);
    expect(height % 2).toBe(0);
  });

  it('keeps the landscape Long sheet geometry unchanged', async () => {
    const out = path.join(tmp.dir, 'sheet_long.jpg');
    await expect(contactSheet({ videoFile: longMp4, outFile: out })).resolves.toBe(out);

    const { width, height } = probeImage(out);
    expect(width).toBe(480 * 4);
    expect(height).toBe(270 * 3); // 480*9/16 = 270, already even — unchanged
  });
});
