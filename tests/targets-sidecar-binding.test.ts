/**
 * Sidecar timing binding for Shorts (targets.ts readTiming). A `<audio>.timing.json` is used
 * only when it declares the same audio bytes and a matching duration. Isolated data under
 * .stills/test-isolation. Fixture audio bytes only. The owner's recordings are never read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'targets-sidecar-binding');
  const data = nodePath.join(root, 'data');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  return { root, data };
});

import { readTiming, resolveTargetAudio, SIDECAR_DURATION_TOLERANCE_SEC } from '../apps/api/src/services/targets.js';
import { SIDECAR_DURATION_TOLERANCE_SEC as ROUTE_TOLERANCE } from '../apps/api/src/routes/external-narration.js';
import type { Project } from '@buildtrack/core';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const SCENES = [{ text: 'first fixture line', duration: 2.5 }, { text: 'second fixture line', duration: 3.1 }];
const BYTES_A = Buffer.from('fixture audio A bytes');
const BYTES_B = Buffer.from('fixture audio B bytes, a different window');

function projectWithShort(rel: string): Project {
  return { meta: { input: { voiceoverFile: null, targetAudio: { short_1: rel } } } } as unknown as Project;
}

function writeAudio(rel: string, bytes: Buffer, sidecar: unknown | null) {
  const abs = path.join(tmp.data, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  const sidecarPath = abs.replace(/\.[^.]+$/, '.timing.json');
  if (sidecar === null) {
    if (fs.existsSync(sidecarPath)) fs.rmSync(sidecarPath);
  } else {
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar));
  }
  return abs;
}

beforeAll(() => {
  fs.mkdirSync(tmp.data, { recursive: true });
});
afterAll(() => {
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('Short timing comes only from a sidecar bound to the same audio', () => {
  it('a sidecar that declares the same bytes and duration is used', async () => {
    writeAudio('voiceover/short_bound.wav', BYTES_A, { scenes: SCENES, audioSha256: sha(BYTES_A), audioDurationSec: 5.6 });
    const audio = await resolveTargetAudio(projectWithShort('voiceover/short_bound.wav'), { measure: false });
    expect(audio.short_1?.sceneTiming).toEqual(SCENES);
  });

  it('negative: a sidecar made for other audio bytes is ignored', async () => {
    writeAudio('voiceover/short_other.wav', BYTES_A, { scenes: SCENES, audioSha256: sha(BYTES_B), audioDurationSec: 5.6 });
    const audio = await resolveTargetAudio(projectWithShort('voiceover/short_other.wav'), { measure: false });
    expect(audio.short_1?.sceneTiming).toBeNull();
  });

  it('negative: a sidecar that declares no audio hash is ignored, even when the scenes look right', async () => {
    writeAudio('voiceover/short_nohash.wav', BYTES_A, { scenes: SCENES, audioDurationSec: 5.6 });
    const audio = await resolveTargetAudio(projectWithShort('voiceover/short_nohash.wav'), { measure: false });
    expect(audio.short_1?.sceneTiming).toBeNull();
  });

  it('negative: a sidecar with the right bytes but no declared duration is ignored', async () => {
    writeAudio('voiceover/short_noduration.wav', BYTES_A, { scenes: SCENES, audioSha256: sha(BYTES_A) });
    const audio = await resolveTargetAudio(projectWithShort('voiceover/short_noduration.wav'), { measure: false });
    expect(audio.short_1?.sceneTiming).toBeNull();
  });

  it('negative: a declared duration that does not match the measured file is ignored', () => {
    const file = writeAudio('voiceover/short_dur.wav', BYTES_A, { scenes: SCENES, audioSha256: sha(BYTES_A), audioDurationSec: 6.0 });
    expect(readTiming(file, { sha256: sha(BYTES_A), durationSec: 9.0 })).toBeNull();
    expect(readTiming(file, { sha256: sha(BYTES_A), durationSec: 6.0 })).toEqual(SCENES);
  });

  it('no sidecar at all gives no timing', async () => {
    writeAudio('voiceover/short_none.wav', BYTES_A, null);
    const audio = await resolveTargetAudio(projectWithShort('voiceover/short_none.wav'), { measure: false });
    expect(audio.short_1?.sceneTiming).toBeNull();
  });

  it('the duration tolerance here equals the external-narration route tolerance', () => {
    expect(SIDECAR_DURATION_TOLERANCE_SEC).toBe(ROUTE_TOLERANCE);
  });
});
