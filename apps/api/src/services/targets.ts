import fs from 'node:fs';
import path from 'node:path';
import { SHORT_IDS, type Project, type TargetAudio, type TargetAudioMap } from '@buildtrack/core';
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
  return { file, durationSec };
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
