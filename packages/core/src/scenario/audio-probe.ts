/**
 * BuildTrack Video Factory - Phase 4C Audio Probe
 *
 * Deterministic local probe mechanism for WAV artifacts.
 * Uses WAV header parsing (sufficient for Phase 4C scope) with optional ffprobe fallback.
 * No heavy dependency — pure Node.js Buffer parsing.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CanonicalAudioMetadata,
  AudioValidationResult,
  AudioValidationFinding,
  CANONICAL_AUDIO_FORMAT,
  CANONICAL_AUDIO_CONTAINER,
  CANONICAL_AUDIO_CODEC,
  CANONICAL_SAMPLE_RATE,
  CANONICAL_CHANNELS,
  CANONICAL_BIT_DEPTH,
  AudioValidationError,
} from './audio-validation-types.js';

export interface AudioProbe {
  readonly engineId: string;
  probe(relativePath: string): Promise<CanonicalAudioMetadata>;
  probeSync(relativePath: string): CanonicalAudioMetadata;
}

function addFinding(
  findings: AudioValidationFinding[],
  severity: AudioValidationFinding['severity'],
  category: AudioValidationFinding['category'],
  ruleId: string,
  message: string,
  location?: AudioValidationFinding['location']
): void {
  findings.push({ severity, category, ruleId, message, location });
}

function validateSafeRelativePath(p: string): void {
  if (!p || typeof p !== 'string' || !p.trim()) {
    throw new AudioValidationError('UNSAFE_PATH', 'Path must be non-empty string.', { path: p });
  }
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) {
    throw new AudioValidationError('UNSAFE_PATH', `Path must be relative, got absolute: '${p}'`, { path: p });
  }
  const segments = p.split(/[/\\]/);
  if (segments.some(s => s === '..' || s === '.')) {
    throw new AudioValidationError('UNSAFE_PATH', `Path contains forbidden traversal: '${p}'`, { path: p });
  }
  if (/[<>:\"|?*]/.test(p)) {
    throw new AudioValidationError('UNSAFE_PATH', `Path contains forbidden chars: '${p}'`, { path: p });
  }
}

/** Parse WAV header deterministically, handling extra chunks like LIST */
function parseWavHeader(buffer: Buffer, relativePath: string): CanonicalAudioMetadata {
  if (buffer.length < 44) {
    throw new AudioValidationError('MALFORMED_WAV', `WAV file too small (${buffer.length} bytes) for header: '${relativePath}'`, {
      relativePath,
      fileSize: buffer.length,
    });
  }

  const riff = buffer.toString('ascii', 0, 4);
  const wave = buffer.toString('ascii', 8, 12);

  if (riff !== 'RIFF') {
    throw new AudioValidationError('MALFORMED_WAV', `Invalid RIFF header: expected 'RIFF', got '${riff}' in '${relativePath}'`, {
      relativePath,
      riff,
    });
  }
  if (wave !== 'WAVE') {
    throw new AudioValidationError('MALFORMED_WAV', `Invalid WAVE header: expected 'WAVE', got '${wave}' in '${relativePath}'`, {
      relativePath,
      wave,
    });
  }

  // Iterate chunks after 12-byte RIFF header to find fmt and data
  let offset = 12;
  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let byteRate: number | null = null;
  let bitDepth: number | null = null;
  let dataSize: number | null = null;
  let foundFmt = false;
  let foundData = false;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      foundFmt = true;
      if (offset + 8 + 16 > buffer.length) {
        throw new AudioValidationError('MALFORMED_WAV', `fmt chunk truncated in '${relativePath}'`, { relativePath });
      }
      audioFormat = buffer.readUInt16LE(offset + 8);
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      byteRate = buffer.readUInt32LE(offset + 16);
      // blockAlign at offset+20, bitDepth at offset+22
      bitDepth = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      foundData = true;
      dataSize = chunkSize;
      break; // data is usually last, we can stop after finding it
    }

    // Move to next chunk: 8 bytes header + chunkSize + padding if odd
    offset += 8 + chunkSize;
    if (chunkSize % 2 === 1) offset += 1;

    // Safety: don't scan beyond first 2KB for fmt, but allow data to be beyond
    if (!foundFmt && offset > 1024) {
      throw new AudioValidationError('MALFORMED_WAV', `Missing 'fmt ' chunk in WAV: '${relativePath}'`, { relativePath });
    }
    if (offset > 2048 && !foundData) {
      // Continue searching for data up to reasonable limit (e.g., 4KB header)
      if (offset > 4096) break;
    }
  }

  if (!foundFmt || audioFormat === null || channels === null || sampleRate === null || byteRate === null || bitDepth === null) {
    throw new AudioValidationError('MALFORMED_WAV', `Missing or incomplete 'fmt ' chunk in WAV: '${relativePath}'`, { relativePath });
  }

  if (!foundData || dataSize === null) {
    throw new AudioValidationError('MALFORMED_WAV', `Missing 'data' chunk in WAV: '${relativePath}'`, { relativePath });
  }

  // Validate PCM
  let codec = 'unknown';
  if (audioFormat === 1) {
    codec = 'pcm_s16le';
    if (bitDepth === 8) codec = 'pcm_u8';
    else if (bitDepth === 16) codec = 'pcm_s16le';
    else if (bitDepth === 24) codec = 'pcm_s24le';
    else if (bitDepth === 32) codec = 'pcm_s32le';
  } else if (audioFormat === 3) {
    codec = 'pcm_f32le';
  } else {
    codec = `unknown_${audioFormat}`;
  }

  const fileSize = buffer.length;
  const dataBytes = dataSize;
  const durationSeconds = byteRate > 0 ? dataBytes / byteRate : undefined;

  if (dataBytes === 0) {
    throw new AudioValidationError('EMPTY_AUDIO', `WAV has empty data chunk: '${relativePath}'`, { relativePath });
  }

  const isCanonical =
    codec === CANONICAL_AUDIO_CODEC &&
    sampleRate === CANONICAL_SAMPLE_RATE &&
    channels === CANONICAL_CHANNELS &&
    bitDepth === CANONICAL_BIT_DEPTH;

  const metadata: CanonicalAudioMetadata = {
    relativePath,
    container: 'wav',
    codec,
    sampleRate,
    channels,
    bitDepth,
    durationSeconds: durationSeconds !== undefined ? Math.round(durationSeconds * 1000) / 1000 : undefined,
    fileSizeBytes: fileSize,
    isValid: true,
    isCanonical,
    probeEngine: 'wav-header-parser',
  };

  return metadata;
}

export class WavHeaderProbe implements AudioProbe {
  readonly engineId = 'wav-header-parser';

  probeSync(relativePath: string): CanonicalAudioMetadata {
    validateSafeRelativePath(relativePath);

    if (!fs.existsSync(relativePath)) {
      throw new AudioValidationError('MISSING_AUDIO_FILE', `Audio file not found: '${relativePath}'`, { relativePath });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(relativePath);
    } catch (e) {
      throw new AudioValidationError('UNREADABLE_FILE', `Cannot stat file '${relativePath}': ${(e as Error).message}`, {
        relativePath,
        error: (e as Error).message,
      });
    }

    if (stat.size === 0) {
      throw new AudioValidationError('EMPTY_AUDIO', `File is empty: '${relativePath}'`, { relativePath });
    }

    let buffer: Buffer;
    try {
      // Read first 1KB for header + enough for data chunk search
      const fd = fs.openSync(relativePath, 'r');
      const readSize = Math.min(stat.size, 2048);
      buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, 0);
      fs.closeSync(fd);
      // For full file size, we need full buffer for fileSizeBytes, but header parsing only needs first 1KB
      // We'll keep fileSize from stat, but for simplicity read full file if small
      if (stat.size <= 1024 * 1024) {
        buffer = fs.readFileSync(relativePath);
      }
    } catch (e) {
      throw new AudioValidationError('UNREADABLE_FILE', `Cannot read file '${relativePath}': ${(e as Error).message}`, {
        relativePath,
        error: (e as Error).message,
      });
    }

    try {
      const meta = parseWavHeader(buffer, relativePath);
      meta.fileSizeBytes = stat.size;
      meta.absolutePath = path.resolve(relativePath);
      return meta;
    } catch (e) {
      if (e instanceof AudioValidationError) throw e;
      throw new AudioValidationError('PROBE_FAILED', `Probe failed for '${relativePath}': ${(e as Error).message}`, {
        relativePath,
        error: (e as Error).message,
      });
    }
  }

  async probe(relativePath: string): Promise<CanonicalAudioMetadata> {
    return this.probeSync(relativePath);
  }
}

/** Validate metadata against canonical target */
export function validateCanonicalAudio(metadata: CanonicalAudioMetadata): AudioValidationResult {
  const findings: AudioValidationFinding[] = [];

  if (metadata.container !== CANONICAL_AUDIO_CONTAINER) {
    addFinding(findings, 'error', 'container', 'AUDIO-VAL-001-WRONG-CONTAINER', `Wrong container: expected '${CANONICAL_AUDIO_CONTAINER}', got '${metadata.container}'`, {
      relativePath: metadata.relativePath,
      expected: CANONICAL_AUDIO_CONTAINER,
      actual: metadata.container,
    });
  }

  if (metadata.codec !== CANONICAL_AUDIO_CODEC) {
    addFinding(findings, 'error', 'codec', 'AUDIO-VAL-002-WRONG-CODEC', `Wrong codec: expected '${CANONICAL_AUDIO_CODEC}', got '${metadata.codec}'`, {
      relativePath: metadata.relativePath,
      expected: CANONICAL_AUDIO_CODEC,
      actual: metadata.codec,
    });
  }

  if (metadata.sampleRate !== CANONICAL_SAMPLE_RATE) {
    addFinding(findings, 'error', 'sampleRate', 'AUDIO-VAL-003-WRONG-SAMPLE-RATE', `Wrong sample rate: expected ${CANONICAL_SAMPLE_RATE}, got ${metadata.sampleRate}`, {
      relativePath: metadata.relativePath,
      expected: CANONICAL_SAMPLE_RATE,
      actual: metadata.sampleRate,
    });
  }

  if (metadata.channels !== CANONICAL_CHANNELS) {
    addFinding(findings, 'error', 'channels', 'AUDIO-VAL-004-WRONG-CHANNELS', `Wrong channel count: expected ${CANONICAL_CHANNELS}, got ${metadata.channels}`, {
      relativePath: metadata.relativePath,
      expected: CANONICAL_CHANNELS,
      actual: metadata.channels,
    });
  }

  if (metadata.bitDepth !== undefined && metadata.bitDepth !== CANONICAL_BIT_DEPTH) {
    addFinding(findings, 'error', 'bitDepth', 'AUDIO-VAL-005-WRONG-BIT-DEPTH', `Wrong bit depth: expected ${CANONICAL_BIT_DEPTH}, got ${metadata.bitDepth}`, {
      relativePath: metadata.relativePath,
      expected: CANONICAL_BIT_DEPTH,
      actual: metadata.bitDepth,
    });
  }

  if (metadata.fileSizeBytes <= 44) {
    addFinding(findings, 'error', 'integrity', 'AUDIO-VAL-006-EMPTY-AUDIO', `File too small to contain audio: ${metadata.fileSizeBytes} bytes`, {
      relativePath: metadata.relativePath,
    });
  }

  const errorCount = findings.filter(f => f.severity === 'error').length;
  const warningCount = findings.filter(f => f.severity === 'warning').length;

  return {
    relativePath: metadata.relativePath,
    valid: errorCount === 0,
    isCanonical: errorCount === 0,
    errorCount,
    warningCount,
    findings,
    metadata,
  };
}
