/**
 * FOCUSED TESTS — acceptance audio-specific probe (audit item A).
 *
 * Proves the probe used on the production per-turn/canonical WAVs:
 *   - accepts a real, valid audio-only WAV and reports duration/codec/rate/channels;
 *   - rejects an invalid WAV;
 *   - rejects a file with no audio stream (a real PNG fixture), so a video
 *     analyser (analyseFile) can never stand in for audio verification;
 *   - rejects missing/empty files and unexpected audio metadata.
 *
 * No product render, no TTS, no network.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AcceptanceAudioProbeError,
  probeAudioFile,
} from '../scripts/acceptance-audio-probe.js';

const ROOT = process.cwd();
const FIXTURE_PNG = path.join(ROOT, 'tests', 'fixtures', 'render', 'progress-chart.png');

let tmp = '';

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-audio-probe-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A minimal, real PCM16 WAV (header + silence samples). */
function wavBuffer(opts: { sampleRate?: number; channels?: number; seconds?: number } = {}): Buffer {
  const sampleRate = opts.sampleRate ?? 48000;
  const channels = opts.channels ?? 1;
  const seconds = opts.seconds ?? 0.25;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.max(1, Math.floor(sampleRate * seconds));
  const dataBytes = frameCount * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

function write(name: string, bytes: Buffer): string {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return '(no error)';
  } catch (e) {
    if (e instanceof AcceptanceAudioProbeError) return e.code;
    return `(unexpected: ${(e as Error).name})`;
  }
}

describe('acceptance audio probe: real audio files', () => {
  it('accepts a valid audio-only WAV and reports duration, codec, sample rate and channels', async () => {
    const file = write('valid-48k-mono.wav', wavBuffer({ sampleRate: 48000, channels: 1, seconds: 0.5 }));
    const probe = await probeAudioFile(file, { codec: 'pcm_s16le', sampleRate: 48000, channels: 1, audioOnly: true, minDurationSeconds: 0.4 });
    expect(probe.codec).toBe('pcm_s16le');
    expect(probe.sampleRate).toBe(48000);
    expect(probe.channels).toBe(1);
    expect(probe.audioOnly).toBe(true);
    expect(probe.sizeBytes).toBeGreaterThan(44);
    expect(probe.durationSeconds).toBeGreaterThanOrEqual(0.4);
    expect(probe.container).toMatch(/wav/);
  });

  it('measures a stereo 44.1 kHz WAV without inventing values', async () => {
    const file = write('valid-441k-stereo.wav', wavBuffer({ sampleRate: 44100, channels: 2, seconds: 0.2 }));
    const probe = await probeAudioFile(file);
    expect(probe.sampleRate).toBe(44100);
    expect(probe.channels).toBe(2);
    expect(probe.durationSeconds).toBeGreaterThan(0);
  });

  it('rejects unexpected audio metadata instead of passing a wrong file type', async () => {
    const file = write('valid-48k-mono-2.wav', wavBuffer({ sampleRate: 48000, channels: 1 }));
    expect(await codeOf(() => probeAudioFile(file, { sampleRate: 44100 }))).toBe('UNEXPECTED_AUDIO_METADATA');
    expect(await codeOf(() => probeAudioFile(file, { channels: 2 }))).toBe('UNEXPECTED_AUDIO_METADATA');
    expect(await codeOf(() => probeAudioFile(file, { codec: 'pcm_f32le' }))).toBe('UNEXPECTED_AUDIO_METADATA');
    expect(await codeOf(() => probeAudioFile(file, { minDurationSeconds: 60 }))).toBe('UNEXPECTED_AUDIO_METADATA');
  });
});

describe('acceptance audio probe: failure modes', () => {
  it('rejects an invalid WAV (garbage bytes with a .wav extension)', async () => {
    const file = write('invalid.wav', Buffer.from('this is not a wav file at all, just text bytes', 'utf8'));
    const code = await codeOf(() => probeAudioFile(file));
    expect(['PROBE_FAILED', 'NO_AUDIO_STREAM', 'MALFORMED_AUDIO', 'INVALID_AUDIO_METADATA']).toContain(code);
  });

  it('rejects a WAV that declares an impossible sample rate', async () => {
    // A structurally valid RIFF/WAVE whose fmt chunk declares 0 Hz: no real
    // audio artifact can have this, so the probe must not report a clean pass.
    const file = write('impossible-rate.wav', wavBuffer({ sampleRate: 0, seconds: 0.1 }));
    const code = await codeOf(() => probeAudioFile(file));
    expect(['PROBE_FAILED', 'NO_AUDIO_STREAM', 'MALFORMED_AUDIO', 'INVALID_AUDIO_METADATA']).toContain(code);
  });

  it('rejects a real file with no audio stream (PNG) and never treats it as audio', async () => {
    expect(fs.existsSync(FIXTURE_PNG)).toBe(true);
    const code = await codeOf(() => probeAudioFile(FIXTURE_PNG));
    expect(code).toBe('NO_AUDIO_STREAM');
    try {
      await probeAudioFile(FIXTURE_PNG);
    } catch (e) {
      const err = e as AcceptanceAudioProbeError;
      expect(err.details.hasVideoStream).toBe(true);
    }
  });

  it('rejects a missing file and an empty file with distinct structured codes', async () => {
    expect(await codeOf(() => probeAudioFile(path.join(tmp, 'does-not-exist.wav')))).toBe('FILE_MISSING');
    const empty = write('empty.wav', Buffer.alloc(0));
    expect(await codeOf(() => probeAudioFile(empty))).toBe('FILE_EMPTY');
  });
});
