/**
 * BuildTrack Video Factory - Phase 4C Canonical Dialogue Audio Manifest
 *
 * Deterministic normalization/validation manifest:
 * DialogueSynthesisManifest → validate/probe each clip → normalize if needed → CanonicalDialogueAudioManifest
 *
 * Preserves clip order, identities, records whether each clip was already canonical or normalized,
 * source metadata, canonical output metadata, no silent skipping, explicit partial failure.
 */

import path from 'node:path';
import { DialogueSynthesisManifest } from './audio-synthesis-types.js';
import {
  CanonicalDialogueAudioManifest,
  AudioNormalizationResult,
  AudioValidationError,
  CANONICAL_AUDIO_FORMAT,
} from './audio-validation-types.js';
import { WavHeaderProbe, validateCanonicalAudio } from './audio-probe.js';
import { FfmpegAudioNormalizer, generateCanonicalPath } from './audio-normalizer.js';

const SCHEMA_VERSION = '1.0.0';

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

export interface CanonicalDialogueOptions {
  /** Source base path (where synthesis artifacts are) */
  sourceBasePath?: string;
  /** Canonical base path (where normalized artifacts go) */
  canonicalBasePath?: string;
  /** If true, overwrites existing canonical files */
  allowOverwrite?: boolean;
}

export async function createCanonicalDialogueAudioManifest(
  synthesisManifest: DialogueSynthesisManifest,
  options: CanonicalDialogueOptions = {}
): Promise<CanonicalDialogueAudioManifest> {
  if (!synthesisManifest || typeof synthesisManifest !== 'object') {
    throw new AudioValidationError('MISSING_CLIP', 'synthesisManifest must be non-null object.', { synthesisManifest });
  }
  if (!Array.isArray(synthesisManifest.results) || synthesisManifest.results.length === 0) {
    throw new AudioValidationError('MISSING_CLIP', 'synthesisManifest.results must be non-empty array.', {
      clipCount: (synthesisManifest as any).results?.length,
    });
  }

  const sourceBasePath = (options.sourceBasePath ?? synthesisManifest.basePath ?? 'audio/dialogue').trim();
  const canonicalBasePath = (options.canonicalBasePath ?? 'audio/canonical').trim();

  validateSafeRelativePath(sourceBasePath, 'sourceBasePath');
  validateSafeRelativePath(canonicalBasePath, 'canonicalBasePath');

  const probe = new WavHeaderProbe();
  const normalizer = new FfmpegAudioNormalizer();

  if (!normalizer.isAvailable()) {
    throw new AudioValidationError('NORMALIZER_UNAVAILABLE', 'Audio normalizer (FFmpeg) is not available.', {
      engineId: normalizer.engineId,
    });
  }

  const results: AudioNormalizationResult[] = [];
  const byClipId: Record<string, AudioNormalizationResult> = {};
  let successCount = 0;
  let failureCount = 0;
  let hadNormalization = false;

  // Preserve deterministic order from synthesisManifest (which is already ordered by globalTurnIndex)
  for (const synthResult of synthesisManifest.results) {
    const clipId = synthResult.clipId;

    // Check duplicate clipId in output
    if (byClipId[clipId]) {
      throw new AudioValidationError('DUPLICATE_CLIP_ID', `Duplicate clipId '${clipId}' in synthesis manifest.`, { clipId });
    }

    // If synthesis itself failed, we cannot normalize — record failure
    if (!synthResult.success) {
      const failed: AudioNormalizationResult = {
        clipId: synthResult.clipId,
        sceneId: synthResult.sceneId,
        turnId: synthResult.turnId,
        speakerId: synthResult.speakerId,
        voiceSlot: synthResult.voiceSlot,
        voiceProfileId: synthResult.voiceProfileId,
        spokenText: synthResult.spokenText,
        sourcePath: synthResult.outputPath,
        sourceMetadata: {
          relativePath: synthResult.outputPath,
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        canonicalPath: generateCanonicalPath(synthResult.outputPath, canonicalBasePath),
        canonicalMetadata: {
          relativePath: generateCanonicalPath(synthResult.outputPath, canonicalBasePath),
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        wasNormalized: false,
        isCanonical: false,
        success: false,
        error: {
          code: synthResult.error?.code ?? 'SYNTHESIS_FAILED',
          message: `Source synthesis failed for clip '${clipId}': ${synthResult.error?.message ?? 'unknown'}`,
          details: synthResult.error,
        },
      };
      results.push(failed);
      byClipId[clipId] = failed;
      failureCount++;
      continue;
    }

    const sourcePath = synthResult.outputPath;

    try {
      validateSafeRelativePath(sourcePath, 'sourcePath');
    } catch (e) {
      const err = e as AudioValidationError;
      const failed: AudioNormalizationResult = {
        clipId: synthResult.clipId,
        sceneId: synthResult.sceneId,
        turnId: synthResult.turnId,
        speakerId: synthResult.speakerId,
        voiceSlot: synthResult.voiceSlot,
        voiceProfileId: synthResult.voiceProfileId,
        spokenText: synthResult.spokenText,
        sourcePath,
        sourceMetadata: {
          relativePath: sourcePath,
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        canonicalPath: generateCanonicalPath(sourcePath, canonicalBasePath),
        canonicalMetadata: {
          relativePath: generateCanonicalPath(sourcePath, canonicalBasePath),
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        wasNormalized: false,
        isCanonical: false,
        success: false,
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      };
      results.push(failed);
      byClipId[clipId] = failed;
      failureCount++;
      continue;
    }

    let sourceMetadata;
    try {
      sourceMetadata = probe.probeSync(sourcePath);
    } catch (e) {
      const err = e as AudioValidationError;
      const failed: AudioNormalizationResult = {
        clipId: synthResult.clipId,
        sceneId: synthResult.sceneId,
        turnId: synthResult.turnId,
        speakerId: synthResult.speakerId,
        voiceSlot: synthResult.voiceSlot,
        voiceProfileId: synthResult.voiceProfileId,
        spokenText: synthResult.spokenText,
        sourcePath,
        sourceMetadata: {
          relativePath: sourcePath,
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        canonicalPath: generateCanonicalPath(sourcePath, canonicalBasePath),
        canonicalMetadata: {
          relativePath: generateCanonicalPath(sourcePath, canonicalBasePath),
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        wasNormalized: false,
        isCanonical: false,
        success: false,
        error: {
          code: err.code ?? 'PROBE_FAILED',
          message: err.message,
          details: err.details,
        },
      };
      results.push(failed);
      byClipId[clipId] = failed;
      failureCount++;
      continue;
    }

    const validation = validateCanonicalAudio(sourceMetadata);
    const canonicalPath = generateCanonicalPath(sourcePath, canonicalBasePath);

    if (validation.isCanonical) {
      // Already canonical — copy or use existing
      try {
        // If source and canonical are same path, no need to copy
        if (sourcePath !== canonicalPath) {
          // Use normalizer's copy logic (it will copy if canonical)
          const canonicalMeta = normalizer.normalizeSync(sourcePath, canonicalPath);
          const result: AudioNormalizationResult = {
            clipId: synthResult.clipId,
            sceneId: synthResult.sceneId,
            turnId: synthResult.turnId,
            speakerId: synthResult.speakerId,
            voiceSlot: synthResult.voiceSlot,
            voiceProfileId: synthResult.voiceProfileId,
            spokenText: synthResult.spokenText,
            sourcePath,
            sourceMetadata,
            canonicalPath,
            canonicalMetadata: canonicalMeta,
            wasNormalized: false,
            isCanonical: true,
            success: true,
          };
          results.push(result);
          byClipId[clipId] = result;
          successCount++;
        } else {
          const result: AudioNormalizationResult = {
            clipId: synthResult.clipId,
            sceneId: synthResult.sceneId,
            turnId: synthResult.turnId,
            speakerId: synthResult.speakerId,
            voiceSlot: synthResult.voiceSlot,
            voiceProfileId: synthResult.voiceProfileId,
            spokenText: synthResult.spokenText,
            sourcePath,
            sourceMetadata,
            canonicalPath: sourcePath,
            canonicalMetadata: sourceMetadata,
            wasNormalized: false,
            isCanonical: true,
            success: true,
          };
          results.push(result);
          byClipId[clipId] = result;
          successCount++;
        }
      } catch (e) {
        const err = e as AudioValidationError;
        const failed: AudioNormalizationResult = {
          clipId: synthResult.clipId,
          sceneId: synthResult.sceneId,
          turnId: synthResult.turnId,
          speakerId: synthResult.speakerId,
          voiceSlot: synthResult.voiceSlot,
          voiceProfileId: synthResult.voiceProfileId,
          spokenText: synthResult.spokenText,
          sourcePath,
          sourceMetadata,
          canonicalPath,
          canonicalMetadata: {
            relativePath: canonicalPath,
            container: 'unknown',
            codec: 'unknown',
            sampleRate: 0,
            channels: 0,
            fileSizeBytes: 0,
            isValid: false,
            isCanonical: false,
            probeEngine: 'none',
          },
          wasNormalized: false,
          isCanonical: false,
          success: false,
          error: {
            code: err.code ?? 'NORMALIZATION_FAILED',
            message: err.message,
            details: err.details,
          },
        };
        results.push(failed);
        byClipId[clipId] = failed;
        failureCount++;
      }
    } else {
      // Needs normalization
      hadNormalization = true;
      try {
        const canonicalMeta = normalizer.normalizeSync(sourcePath, canonicalPath);
        const result: AudioNormalizationResult = {
          clipId: synthResult.clipId,
          sceneId: synthResult.sceneId,
          turnId: synthResult.turnId,
          speakerId: synthResult.speakerId,
          voiceSlot: synthResult.voiceSlot,
          voiceProfileId: synthResult.voiceProfileId,
          spokenText: synthResult.spokenText,
          sourcePath,
          sourceMetadata,
          canonicalPath,
          canonicalMetadata: canonicalMeta,
          wasNormalized: true,
          isCanonical: true,
          success: true,
        };
        results.push(result);
        byClipId[clipId] = result;
        successCount++;
      } catch (e) {
        const err = e as AudioValidationError;
        const failed: AudioNormalizationResult = {
          clipId: synthResult.clipId,
          sceneId: synthResult.sceneId,
          turnId: synthResult.turnId,
          speakerId: synthResult.speakerId,
          voiceSlot: synthResult.voiceSlot,
          voiceProfileId: synthResult.voiceProfileId,
          spokenText: synthResult.spokenText,
          sourcePath,
          sourceMetadata,
          canonicalPath,
          canonicalMetadata: {
            relativePath: canonicalPath,
            container: 'unknown',
            codec: 'unknown',
            sampleRate: 0,
            channels: 0,
            fileSizeBytes: 0,
            isValid: false,
            isCanonical: false,
            probeEngine: 'none',
          },
          wasNormalized: false,
          isCanonical: false,
          success: false,
          error: {
            code: err.code ?? 'NORMALIZATION_FAILED',
            message: err.message,
            details: err.details,
          },
        };
        results.push(failed);
        byClipId[clipId] = failed;
        failureCount++;
      }
    }
  }

  const manifest: CanonicalDialogueAudioManifest = {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: synthesisManifest.scenarioId,
    language: synthesisManifest.language,
    clipCount: synthesisManifest.results.length,
    successCount,
    failureCount,
    hadFailures: failureCount > 0,
    results,
    byClipId: Object.freeze({ ...byClipId }),
    sourceBasePath,
    canonicalBasePath,
    hadNormalization,
    normalizedAt: new Date().toISOString(),
  };

  return manifest;
}

export function createCanonicalDialogueAudioManifestSync(
  synthesisManifest: DialogueSynthesisManifest,
  options: CanonicalDialogueOptions = {}
): CanonicalDialogueAudioManifest {
  // For Phase 4C, sync version just calls async version via deasync? We implement sync logic directly
  // To avoid duplication, we implement sync version similarly to async but using sync probe/normalizer
  // This is a simplified sync wrapper that uses sync methods (which we already have)

  if (!synthesisManifest || typeof synthesisManifest !== 'object') {
    throw new AudioValidationError('MISSING_CLIP', 'synthesisManifest must be non-null object.', { synthesisManifest });
  }
  if (!Array.isArray(synthesisManifest.results) || synthesisManifest.results.length === 0) {
    throw new AudioValidationError('MISSING_CLIP', 'synthesisManifest.results must be non-empty array.', {
      clipCount: (synthesisManifest as any).results?.length,
    });
  }

  const sourceBasePath = (options.sourceBasePath ?? synthesisManifest.basePath ?? 'audio/dialogue').trim();
  const canonicalBasePath = (options.canonicalBasePath ?? 'audio/canonical').trim();

  validateSafeRelativePath(sourceBasePath, 'sourceBasePath');
  validateSafeRelativePath(canonicalBasePath, 'canonicalBasePath');

  const probe = new WavHeaderProbe();
  const normalizer = new FfmpegAudioNormalizer();

  if (!normalizer.isAvailable()) {
    throw new AudioValidationError('NORMALIZER_UNAVAILABLE', 'Audio normalizer (FFmpeg) is not available.', {
      engineId: normalizer.engineId,
    });
  }

  const results: AudioNormalizationResult[] = [];
  const byClipId: Record<string, AudioNormalizationResult> = {};
  let successCount = 0;
  let failureCount = 0;
  let hadNormalization = false;

  for (const synthResult of synthesisManifest.results) {
    const clipId = synthResult.clipId;
    if (byClipId[clipId]) {
      throw new AudioValidationError('DUPLICATE_CLIP_ID', `Duplicate clipId '${clipId}' in synthesis manifest.`, { clipId });
    }

    if (!synthResult.success) {
      const failed: AudioNormalizationResult = {
        clipId: synthResult.clipId,
        sceneId: synthResult.sceneId,
        turnId: synthResult.turnId,
        speakerId: synthResult.speakerId,
        voiceSlot: synthResult.voiceSlot,
        voiceProfileId: synthResult.voiceProfileId,
        spokenText: synthResult.spokenText,
        sourcePath: synthResult.outputPath,
        sourceMetadata: {
          relativePath: synthResult.outputPath,
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        canonicalPath: generateCanonicalPath(synthResult.outputPath, canonicalBasePath),
        canonicalMetadata: {
          relativePath: generateCanonicalPath(synthResult.outputPath, canonicalBasePath),
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        wasNormalized: false,
        isCanonical: false,
        success: false,
        error: {
          code: synthResult.error?.code ?? 'SYNTHESIS_FAILED',
          message: `Source synthesis failed for clip '${clipId}': ${synthResult.error?.message ?? 'unknown'}`,
          details: synthResult.error,
        },
      };
      results.push(failed);
      byClipId[clipId] = failed;
      failureCount++;
      continue;
    }

    const sourcePath = synthResult.outputPath;

    try {
      validateSafeRelativePath(sourcePath, 'sourcePath');
    } catch (e) {
      const err = e as AudioValidationError;
      const failed: AudioNormalizationResult = {
        clipId: synthResult.clipId,
        sceneId: synthResult.sceneId,
        turnId: synthResult.turnId,
        speakerId: synthResult.speakerId,
        voiceSlot: synthResult.voiceSlot,
        voiceProfileId: synthResult.voiceProfileId,
        spokenText: synthResult.spokenText,
        sourcePath,
        sourceMetadata: {
          relativePath: sourcePath,
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        canonicalPath: generateCanonicalPath(sourcePath, canonicalBasePath),
        canonicalMetadata: {
          relativePath: generateCanonicalPath(sourcePath, canonicalBasePath),
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        wasNormalized: false,
        isCanonical: false,
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      };
      results.push(failed);
      byClipId[clipId] = failed;
      failureCount++;
      continue;
    }

    let sourceMetadata;
    try {
      sourceMetadata = probe.probeSync(sourcePath);
    } catch (e) {
      const err = e as AudioValidationError;
      const failed: AudioNormalizationResult = {
        clipId: synthResult.clipId,
        sceneId: synthResult.sceneId,
        turnId: synthResult.turnId,
        speakerId: synthResult.speakerId,
        voiceSlot: synthResult.voiceSlot,
        voiceProfileId: synthResult.voiceProfileId,
        spokenText: synthResult.spokenText,
        sourcePath,
        sourceMetadata: {
          relativePath: sourcePath,
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        canonicalPath: generateCanonicalPath(sourcePath, canonicalBasePath),
        canonicalMetadata: {
          relativePath: generateCanonicalPath(sourcePath, canonicalBasePath),
          container: 'unknown',
          codec: 'unknown',
          sampleRate: 0,
          channels: 0,
          fileSizeBytes: 0,
          isValid: false,
          isCanonical: false,
          probeEngine: 'none',
        },
        wasNormalized: false,
        isCanonical: false,
        success: false,
        error: { code: err.code ?? 'PROBE_FAILED', message: err.message, details: err.details },
      };
      results.push(failed);
      byClipId[clipId] = failed;
      failureCount++;
      continue;
    }

    const validation = validateCanonicalAudio(sourceMetadata);
    const canonicalPath = generateCanonicalPath(sourcePath, canonicalBasePath);

    if (validation.isCanonical) {
      try {
        const canonicalMeta = sourcePath !== canonicalPath ? normalizer.normalizeSync(sourcePath, canonicalPath) : sourceMetadata;
        const result: AudioNormalizationResult = {
          clipId: synthResult.clipId,
          sceneId: synthResult.sceneId,
          turnId: synthResult.turnId,
          speakerId: synthResult.speakerId,
          voiceSlot: synthResult.voiceSlot,
          voiceProfileId: synthResult.voiceProfileId,
          spokenText: synthResult.spokenText,
          sourcePath,
          sourceMetadata,
          canonicalPath: sourcePath !== canonicalPath ? canonicalPath : sourcePath,
          canonicalMetadata: canonicalMeta,
          wasNormalized: false,
          isCanonical: true,
          success: true,
        };
        results.push(result);
        byClipId[clipId] = result;
        successCount++;
      } catch (e) {
        const err = e as AudioValidationError;
        const failed: AudioNormalizationResult = {
          clipId: synthResult.clipId,
          sceneId: synthResult.sceneId,
          turnId: synthResult.turnId,
          speakerId: synthResult.speakerId,
          voiceSlot: synthResult.voiceSlot,
          voiceProfileId: synthResult.voiceProfileId,
          spokenText: synthResult.spokenText,
          sourcePath,
          sourceMetadata,
          canonicalPath,
          canonicalMetadata: {
            relativePath: canonicalPath,
            container: 'unknown',
            codec: 'unknown',
            sampleRate: 0,
            channels: 0,
            fileSizeBytes: 0,
            isValid: false,
            isCanonical: false,
            probeEngine: 'none',
          },
          wasNormalized: false,
          isCanonical: false,
          success: false,
          error: { code: err.code ?? 'NORMALIZATION_FAILED', message: err.message, details: err.details },
        };
        results.push(failed);
        byClipId[clipId] = failed;
        failureCount++;
      }
    } else {
      hadNormalization = true;
      try {
        const canonicalMeta = normalizer.normalizeSync(sourcePath, canonicalPath);
        const result: AudioNormalizationResult = {
          clipId: synthResult.clipId,
          sceneId: synthResult.sceneId,
          turnId: synthResult.turnId,
          speakerId: synthResult.speakerId,
          voiceSlot: synthResult.voiceSlot,
          voiceProfileId: synthResult.voiceProfileId,
          spokenText: synthResult.spokenText,
          sourcePath,
          sourceMetadata,
          canonicalPath,
          canonicalMetadata: canonicalMeta,
          wasNormalized: true,
          isCanonical: true,
          success: true,
        };
        results.push(result);
        byClipId[clipId] = result;
        successCount++;
      } catch (e) {
        const err = e as AudioValidationError;
        const failed: AudioNormalizationResult = {
          clipId: synthResult.clipId,
          sceneId: synthResult.sceneId,
          turnId: synthResult.turnId,
          speakerId: synthResult.speakerId,
          voiceSlot: synthResult.voiceSlot,
          voiceProfileId: synthResult.voiceProfileId,
          spokenText: synthResult.spokenText,
          sourcePath,
          sourceMetadata,
          canonicalPath,
          canonicalMetadata: {
            relativePath: canonicalPath,
            container: 'unknown',
            codec: 'unknown',
            sampleRate: 0,
            channels: 0,
            fileSizeBytes: 0,
            isValid: false,
            isCanonical: false,
            probeEngine: 'none',
          },
          wasNormalized: false,
          isCanonical: false,
          success: false,
          error: { code: err.code ?? 'NORMALIZATION_FAILED', message: err.message, details: err.details },
        };
        results.push(failed);
        byClipId[clipId] = failed;
        failureCount++;
      }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: synthesisManifest.scenarioId,
    language: synthesisManifest.language,
    clipCount: synthesisManifest.results.length,
    successCount,
    failureCount,
    hadFailures: failureCount > 0,
    results,
    byClipId: Object.freeze({ ...byClipId }),
    sourceBasePath,
    canonicalBasePath,
    hadNormalization,
    normalizedAt: new Date().toISOString(),
  };
}
