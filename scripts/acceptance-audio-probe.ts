/**
 * ACCEPTANCE — AUDIO-SPECIFIC MEDIA PROBE (test infrastructure only).
 *
 * Why this exists
 * ---------------
 * The per-turn Kokoro WAVs and the canonical normalized WAV are AUDIO-ONLY
 * files. `analyseFile()` (apps/api/src/services/media.ts) is a VIDEO analyser:
 * it throws `No video stream in <file>` for a legitimate audio-only WAV. Using
 * it on the production audio therefore cannot prove anything about the audio
 * and, if it did not throw, would still validate video fields rather than
 * audio ones.
 *
 * This module is the acceptance-only probe for audio files. It:
 *   - requires a REAL audio stream (never a video stream, never a fabricated
 *     duration);
 *   - reads duration, codec, sample rate and channel count from that stream;
 *   - optionally asserts expected values (canonical audio must be 48 kHz mono
 *     pcm_s16le; per-turn Kokoro WAVs must be real non-empty PCM audio);
 *   - fails with a structured, file-specific error for a missing file, a
 *     malformed/unreadable file and a file with no audio stream, so the
 *     acceptance driver cannot silently pass on the wrong file type.
 *
 * It deliberately does NOT touch the product's own audio validation path
 * (`packages/core/src/scenario/audio-probe.ts`), which is the product authority
 * for canonical audio. This is an independent acceptance measurement.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pickStream, probe } from '../apps/api/src/services/platform.js';

export type AcceptanceAudioProbeErrorCode =
  | 'FILE_MISSING'
  | 'FILE_EMPTY'
  | 'PROBE_FAILED'
  | 'MALFORMED_AUDIO'
  | 'NO_AUDIO_STREAM'
  | 'INVALID_AUDIO_METADATA'
  | 'UNEXPECTED_AUDIO_METADATA';

export class AcceptanceAudioProbeError extends Error {
  public readonly code: AcceptanceAudioProbeErrorCode;
  public readonly details: Record<string, unknown>;
  constructor(code: AcceptanceAudioProbeErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AcceptanceAudioProbeError';
    this.code = code;
    this.details = details;
  }
}

export interface AcceptanceAudioProbe {
  /** absolute or repo-relative path that was probed */
  file: string;
  sizeBytes: number;
  /** container/format name reported by ffprobe (e.g. 'wav') */
  container: string;
  /** finite, > 0 duration in seconds (from the audio stream or the container) */
  durationSeconds: number;
  /** audio stream codec name (e.g. 'pcm_s16le') */
  codec: string;
  /** audio stream sample rate in Hz */
  sampleRate: number;
  /** audio stream channel count */
  channels: number;
  hasAudioStream: true;
  /** exactly one audio stream and no video stream: a genuine audio-only artifact */
  audioOnly: boolean;
}

export interface ExpectedAudio {
  codec?: string;
  sampleRate?: number;
  channels?: number;
  /** inclusive lower bound for the duration in seconds */
  minDurationSeconds?: number;
  /** when true, reject files that also carry a video stream */
  audioOnly?: boolean;
}

function fail(code: AcceptanceAudioProbeErrorCode, message: string, details: Record<string, unknown> = {}): never {
  throw new AcceptanceAudioProbeError(code, message, details);
}

/**
 * Probe one audio artifact and require a real audio stream.
 *
 * @param file path to probe
 * @param expected optional assertions; a mismatch throws UNEXPECTED_AUDIO_METADATA
 */
export async function probeAudioFile(file: string, expected: ExpectedAudio = {}): Promise<AcceptanceAudioProbe> {
  if (!fs.existsSync(file)) {
    fail('FILE_MISSING', `audio file does not exist: ${file}`, { file });
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0) {
    fail('FILE_EMPTY', `audio file is not a non-empty regular file: ${file}`, { file, sizeBytes: stat.size });
  }

  let json: any;
  try {
    json = await probe(file);
  } catch (e) {
    fail('PROBE_FAILED', `ffprobe could not read '${path.basename(file)}': ${(e as Error).message}`, {
      file,
      cause: (e as Error).message,
    });
  }

  const audio = pickStream(json, 'audio');
  if (!audio) {
    // Distinguish "container parsed but there is no audio stream" from
    // "nothing parsed at all" so an image/video can never stand in for audio.
    const video = pickStream(json, 'video');
    fail(
      'NO_AUDIO_STREAM',
      `no audio stream in '${path.basename(file)}'${video ? ` (it has a video stream: ${video.codec_name})` : ''}`,
      { file, container: json?.format?.format_name ?? null, hasVideoStream: Boolean(video) },
    );
  }

  const durationRaw = Number(audio.duration ?? json?.format?.duration ?? 0);
  const sampleRate = Number(audio.sample_rate);
  const channels = Number(audio.channels);
  const codec = String(audio.codec_name ?? '');

  if (!Number.isFinite(durationRaw) || durationRaw <= 0) {
    fail('INVALID_AUDIO_METADATA', `audio file '${path.basename(file)}' has no measurable duration`, {
      file,
      durationRaw: audio.duration ?? json?.format?.duration ?? null,
    });
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    fail('INVALID_AUDIO_METADATA', `audio file '${path.basename(file)}' has no valid sample rate`, {
      file,
      sampleRate: audio.sample_rate ?? null,
    });
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    fail('INVALID_AUDIO_METADATA', `audio file '${path.basename(file)}' has no valid channel count`, {
      file,
      channels: audio.channels ?? null,
    });
  }
  if (!codec) {
    fail('MALFORMED_AUDIO', `audio file '${path.basename(file)}' has an audio stream without a codec`, { file });
  }

  const result: AcceptanceAudioProbe = {
    file,
    sizeBytes: stat.size,
    container: String(json?.format?.format_name ?? ''),
    durationSeconds: durationRaw,
    codec,
    sampleRate,
    channels,
    hasAudioStream: true,
    audioOnly: !pickStream(json, 'video'),
  };

  if (expected.codec !== undefined && result.codec !== expected.codec) {
    fail('UNEXPECTED_AUDIO_METADATA', `audio file '${path.basename(file)}' codec is '${result.codec}', expected '${expected.codec}'`, {
      file, codec: result.codec, expected: expected.codec,
    });
  }
  if (expected.sampleRate !== undefined && result.sampleRate !== expected.sampleRate) {
    fail('UNEXPECTED_AUDIO_METADATA', `audio file '${path.basename(file)}' sample rate is ${result.sampleRate} Hz, expected ${expected.sampleRate} Hz`, {
      file, sampleRate: result.sampleRate, expected: expected.sampleRate,
    });
  }
  if (expected.channels !== undefined && result.channels !== expected.channels) {
    fail('UNEXPECTED_AUDIO_METADATA', `audio file '${path.basename(file)}' has ${result.channels} channel(s), expected ${expected.channels}`, {
      file, channels: result.channels, expected: expected.channels,
    });
  }
  if (expected.minDurationSeconds !== undefined && result.durationSeconds < expected.minDurationSeconds) {
    fail('UNEXPECTED_AUDIO_METADATA', `audio file '${path.basename(file)}' duration is ${result.durationSeconds}s, expected >= ${expected.minDurationSeconds}s`, {
      file, durationSeconds: result.durationSeconds, expected: expected.minDurationSeconds,
    });
  }
  if (expected.audioOnly === true && !result.audioOnly) {
    fail('UNEXPECTED_AUDIO_METADATA', `audio file '${path.basename(file)}' also carries a video stream; expected audio-only`, {
      file, audioOnly: result.audioOnly,
    });
  }

  return result;
}
