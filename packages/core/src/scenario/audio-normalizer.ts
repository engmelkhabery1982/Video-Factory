/**
 * BuildTrack Video Factory - Phase 4C Audio Normalization
 *
 * Deterministic local normalization into canonical format (WAV, 48kHz, mono, PCM16).
 * Supports at least 22.05kHz mono PCM16 WAV → 48kHz mono PCM16 WAV.
 * Uses FFmpeg if available (already part of repo toolchain via platform.ts pattern),
 * with clear failure if unavailable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  CanonicalAudioMetadata,
  AudioValidationError,
} from './audio-validation-types.js';
import { WavHeaderProbe, validateCanonicalAudio } from './audio-probe.js';

const require = createRequire(import.meta.url);

function validateSafeRelativePath(p: string, fieldName = 'path'): void {
  if (!p || typeof p !== 'string' || !p.trim()) {
    throw new AudioValidationError('UNSAFE_PATH', `${fieldName} must be non-empty string.`, { [fieldName]: p });
  }
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) {
    throw new AudioValidationError('UNSAFE_PATH', `${fieldName} must be relative, got absolute: '${p}'`, { [fieldName]: p });
  }
  const segments = p.split(/[/\\]/);
  if (segments.some(s => s === '..' || s === '.')) {
    throw new AudioValidationError('UNSAFE_PATH', `${fieldName} contains forbidden traversal: '${p}'`, { [fieldName]: p });
  }
  if (/[<>:\"|?*]/.test(p)) {
    throw new AudioValidationError('UNSAFE_PATH', `${fieldName} contains forbidden chars: '${p}'`, { [fieldName]: p });
  }
}

function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Resolve ffmpeg path using same logic as platform.ts */
function resolveFfmpegPath(): string {
  const env = process.env.BUILDTRAKE_FFMPEG;
  if (env && fs.existsSync(env)) return env;

  // Check system PATH
  const pathEnv = (process.env.PATH ?? '').split(path.delimiter);
  for (const d of pathEnv) {
    const candidate = path.join(d, 'ffmpeg');
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {}
    const candidateExe = path.join(d, 'ffmpeg.exe');
    try {
      if (fs.existsSync(candidateExe) && fs.statSync(candidateExe).isFile()) return candidateExe;
    } catch {}
  }

  try {
    const mod = require('@ffmpeg-installer/ffmpeg') as { path: string };
    if (mod?.path && fs.existsSync(mod.path)) return mod.path;
  } catch {}

  throw new AudioValidationError('NORMALIZER_UNAVAILABLE', 'FFmpeg not found. Install ffmpeg or set BUILDTRAKE_FFMPEG. Tried system PATH and @ffmpeg-installer/ffmpeg.', {});
}

export interface AudioNormalizer {
  readonly engineId: string;
  readonly engineVersion?: string;
  isAvailable(): boolean;
  normalizeSync(sourcePath: string, targetPath: string): CanonicalAudioMetadata;
  normalize(sourcePath: string, targetPath: string): Promise<CanonicalAudioMetadata>;
}

export class FfmpegAudioNormalizer implements AudioNormalizer {
  readonly engineId = 'ffmpeg';
  readonly engineVersion?: string;
  private ffmpegPath: string | null = null;
  private probe: WavHeaderProbe;

  constructor() {
    this.probe = new WavHeaderProbe();
    try {
      this.ffmpegPath = resolveFfmpegPath();
      // Try to get version
      try {
        const out = execFileSync(this.ffmpegPath, ['-version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        const match = out.match(/ffmpeg version (\S+)/);
        if (match) this.engineVersion = match[1];
      } catch {
        // ignore version failure
      }
    } catch {
      this.ffmpegPath = null;
    }
  }

  isAvailable(): boolean {
    if (this.ffmpegPath) return true;
    try {
      this.ffmpegPath = resolveFfmpegPath();
      return true;
    } catch {
      return false;
    }
  }

  private assertAvailable(): void {
    if (!this.isAvailable() || !this.ffmpegPath) {
      throw new AudioValidationError('NORMALIZER_UNAVAILABLE', 'FFmpeg normalizer unavailable. Install ffmpeg or set BUILDTRAKE_FFMPEG.', {
        engineId: this.engineId,
      });
    }
  }

  normalizeSync(sourcePath: string, targetPath: string): CanonicalAudioMetadata {
    this.assertAvailable();
    validateSafeRelativePath(sourcePath, 'sourcePath');
    validateSafeRelativePath(targetPath, 'targetPath');

    if (!fs.existsSync(sourcePath)) {
      throw new AudioValidationError('MISSING_AUDIO_FILE', `Source file not found: '${sourcePath}'`, { sourcePath });
    }

    const dir = path.dirname(targetPath);
    try {
      ensureDirSync(dir);
    } catch (e) {
      throw new AudioValidationError('OUTPUT_WRITE_FAILED', `Failed to create dir '${dir}': ${(e as Error).message}`, {
        targetPath,
        error: (e as Error).message,
      });
    }

    // Probe source to confirm it's valid (and to get metadata for error reporting)
    let sourceMeta: CanonicalAudioMetadata;
    try {
      sourceMeta = this.probe.probeSync(sourcePath);
    } catch (e) {
      if (e instanceof AudioValidationError) throw e;
      throw new AudioValidationError('PROBE_FAILED', `Failed to probe source '${sourcePath}': ${(e as Error).message}`, {
        sourcePath,
        error: (e as Error).message,
      });
    }

    // If already canonical, we could copy, but for determinism we still run ffmpeg to ensure canonical output
    // However to preserve traceability and avoid unnecessary transcoding, we check if already canonical and if so, copy
    const validation = validateCanonicalAudio(sourceMeta);
    if (validation.isCanonical) {
      // Copy file to target if different path
      if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
        try {
          fs.copyFileSync(sourcePath, targetPath);
        } catch (e) {
          throw new AudioValidationError('OUTPUT_WRITE_FAILED', `Failed to copy canonical file to '${targetPath}': ${(e as Error).message}`, {
            sourcePath,
            targetPath,
            error: (e as Error).message,
          });
        }
      }
      // Probe target to return metadata
      try {
        return this.probe.probeSync(targetPath);
      } catch {
        // If target is same as source, return source meta with updated path
        return { ...sourceMeta, relativePath: targetPath, absolutePath: path.resolve(targetPath) };
      }
    }

    // Normalize via ffmpeg: convert to 48kHz mono PCM16 WAV
    // Command: ffmpeg -y -i source -ar 48000 -ac 1 -c:a pcm_s16le -f wav target
    try {
      execFileSync(
        this.ffmpegPath!,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          path.resolve(sourcePath),
          '-ar',
          '48000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          path.resolve(targetPath),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message: string };
      const stderr = err.stderr ? err.stderr.toString().slice(-2000) : err.message;
      throw new AudioValidationError('NORMALIZATION_FAILED', `FFmpeg normalization failed for '${sourcePath}' -> '${targetPath}': ${stderr}`, {
        sourcePath,
        targetPath,
        error: stderr,
      });
    }

    // Probe normalized output
    try {
      const canonicalMeta = this.probe.probeSync(targetPath);
      const canonicalValidation = validateCanonicalAudio(canonicalMeta);
      if (!canonicalValidation.isCanonical) {
        throw new AudioValidationError('NORMALIZATION_FAILED', `Normalized file is still not canonical: '${targetPath}' — ${canonicalValidation.findings.map(f => f.message).join('; ')}`, {
          targetPath,
          findings: canonicalValidation.findings,
        });
      }
      return canonicalMeta;
    } catch (e) {
      if (e instanceof AudioValidationError) throw e;
      throw new AudioValidationError('PROBE_FAILED', `Failed to probe normalized file '${targetPath}': ${(e as Error).message}`, {
        targetPath,
        error: (e as Error).message,
      });
    }
  }

  async normalize(sourcePath: string, targetPath: string): Promise<CanonicalAudioMetadata> {
    return this.normalizeSync(sourcePath, targetPath);
  }
}

/** Generate deterministic canonical output path from source path */
export function generateCanonicalPath(sourcePath: string, canonicalBasePath: string): string {
  validateSafeRelativePath(sourcePath, 'sourcePath');
  validateSafeRelativePath(canonicalBasePath, 'canonicalBasePath');

  // Example: source audio/dialogue/scenario-pm-01/sc-01-hook_turn-01-sarah.wav
  // -> canonical audio/canonical/scenario-pm-01/sc-01-hook_turn-01-sarah.wav
  // We preserve the relative structure after the first segment
  // For simplicity: if sourcePath starts with audio/dialogue/, replace prefix with canonicalBasePath
  // Otherwise, put file under canonicalBasePath with same basename but prefixed with sanitized source dir

  const sourceDir = path.dirname(sourcePath);
  const fileName = path.basename(sourcePath);

  // Try to extract scenario subpath: look for audio/dialogue/ prefix
  let subPath = '';
  const dialoguePrefix = 'audio/dialogue/';
  if (sourcePath.startsWith(dialoguePrefix)) {
    subPath = sourcePath.slice(dialoguePrefix.length);
    // subPath = scenario-pm-01/sc-01-hook_turn-01-sarah.wav
    // Remove filename to get scenario dir
    const subDir = path.dirname(subPath);
    return `${canonicalBasePath}/${subDir}/${fileName}`;
  }

  // Fallback: use sourcePath's dir sanitized + filename
  // To keep deterministic and safe, we hash the source dir if it contains unsafe chars
  const safeFileName = fileName.replace(/[^a-zA-Z0-9_\\-\\.]/g, '_');
  return `${canonicalBasePath}/${safeFileName}`;
}
