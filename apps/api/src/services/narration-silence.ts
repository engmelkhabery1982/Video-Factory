/**
 * Measure pauses in an imported narration with the ffmpeg already used for QC.
 * Does not write, trim, or replace the recording. Errors never include a path.
 */
import fs from 'node:fs';
import { parseSilenceDetectLog, NARRATION_SILENCE_MIN_SEC, NARRATION_SILENCE_NOISE_DB, type NarrationSilenceInterval } from '@buildtrack/core';
import { ffmpegPath, run } from './platform.js';

export async function detectNarrationPauses(file: string, durationSec: number): Promise<{
  ok: boolean;
  silences: NarrationSilenceInterval[];
  message: string;
}> {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, silences: [], message: 'The recording has no measured duration. Boundaries were not changed.' };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, silences: [], message: 'The imported narration file is not readable. Boundaries were not changed.' };
  }
  if (!stat.isFile() || stat.size <= 0) {
    return { ok: false, silences: [], message: 'The imported narration file is not readable. Boundaries were not changed.' };
  }
  let bin = '';
  try {
    bin = ffmpegPath();
  } catch {
    return { ok: false, silences: [], message: 'Pause detection is unavailable because ffmpeg is not installed. Current timings were not changed.' };
  }
  const result = await run(bin, [
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-af',
    `silencedetect=noise=${NARRATION_SILENCE_NOISE_DB}dB:d=${NARRATION_SILENCE_MIN_SEC}`,
    '-vn',
    '-f',
    'null',
    '-',
  ]);
  if (result.code !== 0 && !/silence_start:/.test(result.stderr)) {
    return { ok: false, silences: [], message: 'Pause detection could not read this recording. Current timings were not changed.' };
  }
  return {
    ok: true,
    silences: parseSilenceDetectLog(result.stderr, durationSec),
    message: '',
  };
}
