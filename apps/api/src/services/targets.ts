import fs from 'node:fs';
import path from 'node:path';
import { SHORT_IDS, type Project, type SceneTiming, type ShortId, type TargetAudio, type TargetAudioMap } from '@buildtrack/core';
import { DATA_DIR } from './platform.js';
import { durationOf } from './media.js';

/** Stored narration paths are relative to the data directory (e.g. `voiceover/Video_01.mp3`). */
export function resolveDataPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(DATA_DIR, p);
}

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
  return { file, durationSec, sceneTiming: readTiming(file) };
}

/** `<name>.timing.json` next to an audio file: exact per-scene speech timing */
function readTiming(file: string): SceneTiming[] | null {
  const f = file.replace(/\.[^.]+$/, '.timing.json');
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as { scenes?: SceneTiming[] };
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
