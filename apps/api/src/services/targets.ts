import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SHORT_IDS, type Project, type SceneTiming, type ShortId, type TargetAudio, type TargetAudioMap } from '@buildtrack/core';
import { DATA_DIR } from './platform.js';
import { durationOf } from './media.js';

/** Stored narration paths are relative to the data directory (e.g. `voiceover/Video_01.mp3`). */
export function resolveDataPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(DATA_DIR, p);
}

/** Same tolerance as the external-narration route (`SIDECAR_DURATION_TOLERANCE_SEC`). A test keeps them equal. */
export const SIDECAR_DURATION_TOLERANCE_SEC = 0.05;

async function audioAt(ref: string | null | undefined, measure: boolean): Promise<TargetAudio | null> {
  if (!ref) return null;
  const file = resolveDataPath(ref);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return null;
  let durationSec: number | null = null;
  if (measure) {
    try {
      durationSec = await durationOf(file);
    } catch {
      durationSec = null;
    }
  }
  const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { file, durationSec, sceneTiming: readTiming(file, { sha256, durationSec }) };
}

/**
 * `<name>.timing.json` next to an audio file: exact per-scene speech timing. It is used
 * ONLY when it declares the same audio bytes (sha256) as the file on disk, and a duration
 * that matches the measured file when one was measured. A sidecar made for other audio,
 * or one that declares nothing, is ignored, so no other window's timing reaches a Short.
 */
export function readTiming(file: string, measured: { sha256: string; durationSec: number | null }): SceneTiming[] | null {
  const f = file.replace(/\.[^.]+$/, '.timing.json');
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as { scenes?: SceneTiming[]; audioSha256?: unknown; audioDurationSec?: unknown };
    if (typeof raw.audioSha256 !== 'string' || raw.audioSha256 !== measured.sha256) return null;
    if (typeof raw.audioDurationSec === 'number' && measured.durationSec !== null) {
      if (Math.abs(raw.audioDurationSec - measured.durationSec) > SIDECAR_DURATION_TOLERANCE_SEC) return null;
    } else if (typeof raw.audioDurationSec !== 'number') {
      return null;
    }
    return Array.isArray(raw.scenes) ? raw.scenes : null;
  } catch {
    return null;
  }
}

/** storyboard options derived from each Short's own audio */
export function shortTimingOptions(audio: TargetAudioMap) {
  const shortAudioDurations: Partial<Record<ShortId, number | null>> = {};
  const shortSceneTimings: Partial<Record<ShortId, SceneTiming[] | null>> = {};
  for (const id of SHORT_IDS) {
    shortAudioDurations[id] = audio[id]?.durationSec ?? null;
    shortSceneTimings[id] = audio[id]?.sceneTiming ?? null;
  }
  return { shortAudioDurations, shortSceneTimings };
}

/**
 * Find each target's own narration on disk. Long <- `voiceoverFile` (legacy
 * field, Long only). Short N <- `targetAudio.short_N`. There is deliberately no
 * fallback from a Short to the Long file.
 */
export async function resolveTargetAudio(project: Project, opts: { measure?: boolean } = {}): Promise<TargetAudioMap> {
  const input = project.meta.input;
  const measure = opts.measure !== false;
  const out: TargetAudioMap = { long: await audioAt(input.voiceoverFile, measure) };
  for (const id of SHORT_IDS) out[id] = await audioAt(input.targetAudio?.[id], measure);
  return out;
}
