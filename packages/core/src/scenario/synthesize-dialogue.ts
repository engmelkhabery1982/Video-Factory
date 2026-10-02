/**
 * BuildTrack Video Factory - Phase 4B Dialogue Plan Synthesis Orchestration
 *
 * Deterministic function that accepts approved DialogueAudioPlan + Voice Resolution
 * and synthesizes all required clips via AudioSynthesizer abstraction.
 *
 * Preserves scene/turn ordering, exact spoken text, speaker identity, voice mapping,
 * deterministic output path generation, rejects missing voice resolution, duplicate
 * identities, unsafe paths, no silent skipping.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DialogueAudioPlan, DialogueAudioClip } from './dialogue-audio-types.js';
import { DialogueAudioPlanVoiceResolution } from './voice-types.js';
import {
  AudioSynthesisRequest,
  AudioSynthesisResult,
  DialogueSynthesisManifest,
  DialogueSynthesisOptions,
  AudioSynthesisError,
} from './audio-synthesis-types.js';
import { AudioSynthesizer } from './audio-synthesizer.js';

const SCHEMA_VERSION = '1.0.0';

/** Sanitize identifier for safe filesystem use */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function sanitizePathComponent(id: string): string {
  if (!id || typeof id !== 'string') return 'unknown';
  const sanitized = id.replace(/[^a-zA-Z0-9_\\-]/g, '_');
  return sanitized === id ? sanitized : `${sanitized}_${stableHash(id)}`;
}

function validateSafeRelativePath(p: string, fieldName = 'path'): void {
  if (!p || typeof p !== 'string' || !p.trim()) {
    throw new AudioSynthesisError('UNSAFE_PATH', `${fieldName} must be non-empty string.`, { [fieldName]: p });
  }
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) {
    throw new AudioSynthesisError('UNSAFE_PATH', `${fieldName} must be relative, got absolute: '${p}'`, { [fieldName]: p });
  }
  const segments = p.split(/[/\\]/);
  if (segments.some(s => s === '..' || s === '.')) {
    throw new AudioSynthesisError('UNSAFE_PATH', `${fieldName} contains forbidden traversal: '${p}'`, { [fieldName]: p });
  }
  if (/[<>:\"|?*]/.test(p)) {
    throw new AudioSynthesisError('UNSAFE_PATH', `${fieldName} contains forbidden chars: '${p}'`, { [fieldName]: p });
  }
}

function validateDialogueAudioPlan(plan: unknown): DialogueAudioPlan {
  if (!plan || typeof plan !== 'object') {
    throw new AudioSynthesisError('MALFORMED_SYNTHESIS_REQUEST', 'DialogueAudioPlan must be non-null object.', { plan });
  }
  const p = plan as DialogueAudioPlan;
  if (!p.scenarioId || typeof p.scenarioId !== 'string' || !p.scenarioId.trim()) {
    throw new AudioSynthesisError('MALFORMED_SYNTHESIS_REQUEST', 'DialogueAudioPlan.scenarioId must be non-empty.', { scenarioId: (p as any).scenarioId });
  }
  if (!Array.isArray(p.clips) || p.clips.length === 0) {
    throw new AudioSynthesisError('MISSING_CLIP', 'DialogueAudioPlan.clips must be non-empty array.', { clipCount: (p as any).clips?.length });
  }
  // Check duplicate clipIds
  const seenClipIds = new Set<string>();
  for (const clip of p.clips) {
    if (!clip.clipId || typeof clip.clipId !== 'string') {
      throw new AudioSynthesisError('MALFORMED_SYNTHESIS_REQUEST', 'Each clip must have clipId.', { clip });
    }
    if (seenClipIds.has(clip.clipId)) {
      throw new AudioSynthesisError('DUPLICATE_CLIP_ID', `Duplicate clipId '${clip.clipId}' in DialogueAudioPlan.`, { clipId: clip.clipId });
    }
    seenClipIds.add(clip.clipId);
    if (!clip.spokenText || typeof clip.spokenText !== 'string' || !clip.spokenText.trim()) {
      throw new AudioSynthesisError('INVALID_TEXT', `Clip '${clip.clipId}' has empty spokenText.`, { clipId: clip.clipId });
    }
    if (!clip.voiceSlot || typeof clip.voiceSlot !== 'string' || !clip.voiceSlot.trim()) {
      throw new AudioSynthesisError('MALFORMED_SYNTHESIS_REQUEST', `Clip '${clip.clipId}' missing voiceSlot.`, { clipId: clip.clipId });
    }
  }
  return p;
}

function validateVoiceResolution(resolution: unknown, plan: DialogueAudioPlan): DialogueAudioPlanVoiceResolution {
  if (!resolution || typeof resolution !== 'object') {
    throw new AudioSynthesisError('MISSING_VOICE_RESOLUTION', 'Voice resolution must be non-null object.', { resolution });
  }
  const r = resolution as DialogueAudioPlanVoiceResolution;
  if (!r.bySlot || typeof r.bySlot !== 'object') {
    throw new AudioSynthesisError('MISSING_VOICE_RESOLUTION', 'Voice resolution bySlot map missing.', { scenarioId: plan.scenarioId });
  }
  // Ensure every voiceSlot in plan has resolution
  const missingSlots = new Set<string>();
  for (const clip of plan.clips) {
    const slot = clip.voiceSlot.trim();
    if (!r.bySlot[slot]) {
      missingSlots.add(slot);
    }
  }
  if (missingSlots.size > 0) {
    throw new AudioSynthesisError('MISSING_VOICE_RESOLUTION', `Missing voice resolution for slots: ${Array.from(missingSlots).join(', ')}`, {
      missingSlots: Array.from(missingSlots),
      scenarioId: plan.scenarioId,
    });
  }
  return r;
}

/** Generate deterministic safe relative output path for a clip */
export function generateDeterministicOutputPath(
  clip: DialogueAudioClip,
  scenarioId: string,
  basePath: string
): string {
  validateSafeRelativePath(basePath, 'basePath');
  const safeScenario = sanitizePathComponent(scenarioId);
  const safeScene = sanitizePathComponent(clip.sceneId);
  const safeTurn = sanitizePathComponent(clip.turnId);
  // Use clipId for uniqueness, but also include scene_turn for readability
  // Deterministic: basePath/scenarioId/sceneId_turnId.wav
  const fileName = `${safeScene}_${safeTurn}.wav`;
  const fullPath = `${basePath}/${safeScenario}/${fileName}`;
  validateSafeRelativePath(fullPath, 'outputPath');
  return fullPath;
}

/* ------------------------------------------------------------------ */
/*  Validated per-turn synthesis reuse                                 */
/* ------------------------------------------------------------------ */

/**
 * Bump when the reuse key or sidecar contract changes, so old sidecars are
 * never trusted across a scheme change.
 */
export const SYNTHESIS_REUSE_SCHEMA_VERSION = 1;

/** Identity of the engine that would produce the bytes (settings included). */
export interface SynthesisEngineIdentity {
  engineId: string;
  engineVersion?: string;
  modelId?: string | null;
}

export interface SynthesisReuseSidecar {
  schemaVersion: number;
  reuseKey: string;
  targetPath: string;
  clipId: string;
  scenarioId: string;
  sceneId: string;
  turnId: string;
  engineId: string;
  engineVersion?: string;
  modelId?: string | null;
  voiceSlot: string;
  voiceProfileId: string;
  spokenTextSha256: string;
  outputSha256: string;
  outputSizeBytes: number;
  durationSeconds?: number;
  createdAt: string;
}

function engineIdentityOf(synthesizer: AudioSynthesizer): SynthesisEngineIdentity {
  return {
    engineId: String(synthesizer.engineId ?? 'unknown'),
    engineVersion: synthesizer.engineVersion,
    modelId: (synthesizer as unknown as { modelId?: string }).modelId ?? null,
  };
}

/**
 * The acoustic identity of one clip: every input that determines the waveform
 * bytes for a deterministic engine. Changing any of them invalidates reuse.
 */
export function synthesisReuseKey(request: AudioSynthesisRequest, engine: SynthesisEngineIdentity): string {
  const material = {
    schema: SYNTHESIS_REUSE_SCHEMA_VERSION,
    engineId: engine.engineId,
    engineVersion: engine.engineVersion ?? null,
    modelId: engine.modelId ?? null,
    scenarioId: request.scenarioId,
    sceneId: request.sceneId,
    turnId: request.turnId,
    clipId: request.clipId,
    speakerId: request.speakerId,
    voiceSlot: request.voiceSlot,
    voiceProfileId: request.voiceProfileId,
    language: request.language,
    spokenText: request.spokenText,
    delivery: request.delivery ?? null,
    synthesisHints: request.synthesisHints ?? null,
    audioFormat: request.audioFormat ?? null,
    targetPath: request.targetPath,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function sidecarPathFor(targetPath: string): string {
  return `${targetPath}.synthesis.json`;
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Read a sidecar; null when absent/corrupt or written by another scheme. */
function readSidecar(targetPath: string): SynthesisReuseSidecar | null {
  try {
    const file = sidecarPathFor(targetPath);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SynthesisReuseSidecar;
    if (parsed?.schemaVersion !== SYNTHESIS_REUSE_SCHEMA_VERSION) return null;
    if (typeof parsed.reuseKey !== 'string' || typeof parsed.outputSha256 !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * A VALIDATED touch of the existing artifact. Reuse requires all of:
 *   - the sidecar exists and belongs to the current reuse scheme;
 *   - the stored reuse key equals the request's key;
 *   - the WAV exists, has exactly the stored size and exactly the stored hash.
 * Anything else returns null and the clip is synthesized again.
 */
function tryReuseExisting(request: AudioSynthesisRequest, engine: SynthesisEngineIdentity): AudioSynthesisResult | null {
  const sidecar = readSidecar(request.targetPath);
  if (!sidecar) return null;
  if (sidecar.reuseKey !== synthesisReuseKey(request, engine)) return null;
  if (sidecar.targetPath !== request.targetPath) return null;
  if (!fs.existsSync(request.targetPath)) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(request.targetPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size !== sidecar.outputSizeBytes) return null;
  let actualSha: string;
  try {
    actualSha = sha256File(request.targetPath);
  } catch {
    return null;
  }
  if (actualSha !== sidecar.outputSha256) return null;
  return {
    clipId: request.clipId,
    sceneId: request.sceneId,
    turnId: request.turnId,
    speakerId: request.speakerId,
    voiceSlot: request.voiceSlot,
    voiceProfileId: request.voiceProfileId,
    spokenText: request.spokenText,
    outputPath: request.targetPath,
    audioFormat: request.audioFormat,
    success: true,
    durationSeconds: sidecar.durationSeconds,
    fileSizeBytes: sidecar.outputSizeBytes,
    metadata: {
      scenarioId: request.scenarioId,
      language: request.language,
      engine: engine.engineId,
      ...(engine.engineVersion ? { engineVersion: engine.engineVersion } : {}),
    },
    reused: true,
  };
}

/** Persist the validated reuse record for a freshly synthesized clip. */
function writeSidecar(request: AudioSynthesisRequest, engine: SynthesisEngineIdentity, result: AudioSynthesisResult): void {
  if (!result.success || !fs.existsSync(request.targetPath)) return;
  try {
    const stat = fs.statSync(request.targetPath);
    const sidecar: SynthesisReuseSidecar = {
      schemaVersion: SYNTHESIS_REUSE_SCHEMA_VERSION,
      reuseKey: synthesisReuseKey(request, engine),
      targetPath: request.targetPath,
      clipId: request.clipId,
      scenarioId: request.scenarioId,
      sceneId: request.sceneId,
      turnId: request.turnId,
      engineId: engine.engineId,
      ...(engine.engineVersion ? { engineVersion: engine.engineVersion } : {}),
      modelId: engine.modelId ?? null,
      voiceSlot: request.voiceSlot,
      voiceProfileId: request.voiceProfileId,
      spokenTextSha256: createHash('sha256').update(request.spokenText).digest('hex'),
      outputSha256: sha256File(request.targetPath),
      outputSizeBytes: stat.size,
      ...(typeof result.durationSeconds === 'number' ? { durationSeconds: result.durationSeconds } : {}),
      createdAt: new Date().toISOString(),
    };
    const tmp = `${sidecarPathFor(request.targetPath)}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2), 'utf8');
    fs.renameSync(tmp, sidecarPathFor(request.targetPath));
  } catch {
    /* The sidecar is a cache accelerator only; failing to write it must never
       fail the synthesis or the artifact. */
  }
}

/** Build synthesis request for one clip */
export function buildSynthesisRequest(
  clip: DialogueAudioClip,
  plan: DialogueAudioPlan,
  voiceResolution: DialogueAudioPlanVoiceResolution,
  basePath: string
): AudioSynthesisRequest {
  const voiceProfile = voiceResolution.bySlot[clip.voiceSlot.trim()];
  if (!voiceProfile) {
    throw new AudioSynthesisError('MISSING_VOICE_RESOLUTION', `No voice profile for slot '${clip.voiceSlot}' clip '${clip.clipId}'.`, {
      clipId: clip.clipId,
      voiceSlot: clip.voiceSlot,
    });
  }

  // Check character mapping preserved
  const character = plan.characters.find(c => c.characterId === clip.speakerId);
  if (!character) {
    throw new AudioSynthesisError('CLIP_IDENTITY_MISMATCH', `Clip '${clip.clipId}' speakerId '${clip.speakerId}' not found in plan characters.`, {
      clipId: clip.clipId,
      speakerId: clip.speakerId,
    });
  }

  if (!clip.spokenText || typeof clip.spokenText !== 'string' || !clip.spokenText.trim()) {
    throw new AudioSynthesisError('INVALID_TEXT', `Clip '${clip.clipId}' has empty spokenText.`, {
      clipId: clip.clipId,
    });
  }

  const targetPath = generateDeterministicOutputPath(clip, plan.scenarioId, basePath);

  const request: AudioSynthesisRequest = {
    scenarioId: plan.scenarioId,
    sceneId: clip.sceneId,
    turnId: clip.turnId,
    clipId: clip.clipId,
    speakerId: clip.speakerId,
    speakerName: character.name,
    voiceSlot: clip.voiceSlot,
    voiceProfileId: voiceProfile.id,
    voiceProfile,
    language: plan.language,
    spokenText: clip.spokenText, // exact preservation
    delivery: clip.delivery,
    synthesisHints: voiceProfile.synthesisHints,
    targetPath,
    audioFormat: clip.audioFormat,
    sceneIndex: clip.sceneIndex,
    turnIndex: clip.turnIndex,
    globalTurnIndex: clip.globalTurnIndex,
  };

  return request;
}

/**
 * Deterministic orchestration: DialogueAudioPlan + VoiceResolution + Synthesizer → Manifest
 *
 * - Preserves scene/turn ordering (uses plan.clips order which is chronological)
 * - Preserves exact spoken text
 * - Preserves speaker/character identity
 * - Preserves resolved voice mapping
 * - Deterministic output path generation
 * - Rejects missing voice resolution, duplicate clipIds, unsafe paths
 * - No silent skipping
 */
export async function synthesizeDialoguePlan(
  plan: DialogueAudioPlan,
  voiceResolution: DialogueAudioPlanVoiceResolution,
  synthesizer: AudioSynthesizer,
  options: DialogueSynthesisOptions = {}
): Promise<DialogueSynthesisManifest> {
  const validatedPlan = validateDialogueAudioPlan(plan);
  const validatedResolution = validateVoiceResolution(voiceResolution, validatedPlan);

  if (!synthesizer || typeof synthesizer.synthesize !== 'function') {
    throw new AudioSynthesisError('SYNTHESIZER_UNAVAILABLE', 'AudioSynthesizer must have synthesize method.', { engineId: (synthesizer as any)?.engineId });
  }

  const basePath = (options.basePath ?? 'audio/dialogue').trim();
  validateSafeRelativePath(basePath, 'basePath');

  // Check synthesizer availability
  if (synthesizer.isAvailable) {
    const available = await Promise.resolve(synthesizer.isAvailable());
    if (!available) {
      throw new AudioSynthesisError('SYNTHESIZER_UNAVAILABLE', `Synthesizer '${synthesizer.engineId}' is not available.`, {
        engineId: synthesizer.engineId,
      });
    }
  }

  const results: AudioSynthesisResult[] = [];
  const byClipId: Record<string, AudioSynthesisResult> = {};
  let successCount = 0;
  let failureCount = 0;
  let reusedCount = 0;
  let synthesizedCount = 0;

  // Ensure deterministic ordering: sort by globalTurnIndex (plan.clips already in order, but sort to be safe)
  const orderedClips = [...validatedPlan.clips].sort((a, b) => {
    if (a.globalTurnIndex !== b.globalTurnIndex) return a.globalTurnIndex - b.globalTurnIndex;
    if (a.sceneIndex !== b.sceneIndex) return a.sceneIndex - b.sceneIndex;
    return a.turnIndex - b.turnIndex;
  });

  // Check for duplicate globalTurnIndex (should not happen if plan valid, but guard)
  const seenGlobal = new Set<number>();
  for (const clip of orderedClips) {
    if (seenGlobal.has(clip.globalTurnIndex)) {
      throw new AudioSynthesisError('DUPLICATE_CLIP_ID', `Duplicate globalTurnIndex ${clip.globalTurnIndex} for clip '${clip.clipId}'.`, {
        clipId: clip.clipId,
        globalTurnIndex: clip.globalTurnIndex,
      });
    }
    seenGlobal.add(clip.globalTurnIndex);
  }

  for (const clip of orderedClips) {
    let request: AudioSynthesisRequest;
    try {
      request = buildSynthesisRequest(clip, validatedPlan, validatedResolution, basePath);
    } catch (e) {
      if (e instanceof AudioSynthesisError) {
        // Build failed result for manifest
        const failedResult: AudioSynthesisResult = {
          clipId: clip.clipId,
          sceneId: clip.sceneId,
          turnId: clip.turnId,
          speakerId: clip.speakerId,
          voiceSlot: clip.voiceSlot,
          voiceProfileId: validatedResolution.bySlot[clip.voiceSlot]?.id ?? 'unknown',
          spokenText: clip.spokenText,
          outputPath: `${basePath}/${sanitizePathComponent(validatedPlan.scenarioId)}/${sanitizePathComponent(clip.sceneId)}_${sanitizePathComponent(clip.turnId)}.wav`,
          audioFormat: clip.audioFormat,
          success: false,
          error: {
            code: (e as AudioSynthesisError).code,
            message: (e as Error).message,
            details: (e as AudioSynthesisError).details,
          },
        };
        results.push(failedResult);
        byClipId[clip.clipId] = failedResult;
        failureCount++;
        continue;
      }
      throw e;
    }

    // Check for duplicate clipId in results (should be prevented earlier, but guard)
    if (byClipId[request.clipId]) {
      throw new AudioSynthesisError('DUPLICATE_CLIP_ID', `Duplicate clipId '${request.clipId}' encountered during synthesis.`, {
        clipId: request.clipId,
      });
    }

    const engine = engineIdentityOf(synthesizer);
    const reused =
      options.reuse === false ? null : tryReuseExisting(request, engine);
    if (reused) {
      results.push(reused);
      byClipId[reused.clipId] = reused;
      successCount++;
      reusedCount++;
      continue;
    }

    try {
      const result = await synthesizer.synthesize(request);
      if (result.success) writeSidecar(request, engine, result);
      // Validate result identity continuity
      if (result.clipId !== request.clipId) {
        throw new AudioSynthesisError('CLIP_IDENTITY_MISMATCH', `Synthesizer returned mismatched clipId: expected '${request.clipId}', got '${result.clipId}'.`, {
          expected: request.clipId,
          got: result.clipId,
        });
      }
      if (result.spokenText !== request.spokenText) {
        throw new AudioSynthesisError('CLIP_IDENTITY_MISMATCH', `Synthesizer altered spokenText for clip '${request.clipId}'.`, {
          clipId: request.clipId,
        });
      }
      if (result.voiceSlot !== request.voiceSlot || result.voiceProfileId !== request.voiceProfileId) {
        throw new AudioSynthesisError('CLIP_IDENTITY_MISMATCH', `Synthesizer altered voice mapping for clip '${request.clipId}'.`, {
          clipId: request.clipId,
          expectedSlot: request.voiceSlot,
          gotSlot: result.voiceSlot,
          expectedProfile: request.voiceProfileId,
          gotProfile: result.voiceProfileId,
        });
      }

      results.push(result);
      byClipId[result.clipId] = result;
      if (result.success) {
        successCount++;
        synthesizedCount++;
      } else {
        failureCount++;
      }
    } catch (e) {
      if (e instanceof AudioSynthesisError) {
        const failedResult: AudioSynthesisResult = {
          clipId: request.clipId,
          sceneId: request.sceneId,
          turnId: request.turnId,
          speakerId: request.speakerId,
          voiceSlot: request.voiceSlot,
          voiceProfileId: request.voiceProfileId,
          spokenText: request.spokenText,
          outputPath: request.targetPath,
          audioFormat: request.audioFormat,
          success: false,
          error: {
            code: e.code,
            message: e.message,
            details: e.details,
          },
        };
        results.push(failedResult);
        byClipId[request.clipId] = failedResult;
        failureCount++;
        continue;
      }
      // Unknown error -> wrap as SYNTHESIS_FAILED
      const failedResult: AudioSynthesisResult = {
        clipId: request.clipId,
        sceneId: request.sceneId,
        turnId: request.turnId,
        speakerId: request.speakerId,
        voiceSlot: request.voiceSlot,
        voiceProfileId: request.voiceProfileId,
        spokenText: request.spokenText,
        outputPath: request.targetPath,
        audioFormat: request.audioFormat,
        success: false,
        error: {
          code: 'SYNTHESIS_FAILED',
          message: (e as Error).message,
          details: { originalError: (e as Error).stack },
        },
      };
      results.push(failedResult);
      byClipId[request.clipId] = failedResult;
      failureCount++;
    }
  }

  const manifest: DialogueSynthesisManifest = {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: validatedPlan.scenarioId,
    language: validatedPlan.language,
    clipCount: orderedClips.length,
    successCount,
    failureCount,
    hadFailures: failureCount > 0,
    results,
    byClipId: Object.freeze({ ...byClipId }),
    basePath,
    reusedClipCount: reusedCount,
    synthesizedClipCount: synthesizedCount,
    synthesizedAt: new Date().toISOString(),
  };

  return manifest;
}

/** Synchronous variant for local engines */
export function synthesizeDialoguePlanSync(
  plan: DialogueAudioPlan,
  voiceResolution: DialogueAudioPlanVoiceResolution,
  synthesizer: AudioSynthesizer & { synthesizeSync: (req: AudioSynthesisRequest) => AudioSynthesisResult },
  options: DialogueSynthesisOptions = {}
): DialogueSynthesisManifest {
  const validatedPlan = validateDialogueAudioPlan(plan);
  const validatedResolution = validateVoiceResolution(voiceResolution, validatedPlan);

  if (!synthesizer || typeof synthesizer.synthesizeSync !== 'function') {
    throw new AudioSynthesisError('SYNTHESIZER_UNAVAILABLE', 'AudioSynthesizer must have synthesizeSync method for sync orchestration.', {
      engineId: (synthesizer as any)?.engineId,
    });
  }

  const basePath = (options.basePath ?? 'audio/dialogue').trim();
  validateSafeRelativePath(basePath, 'basePath');

  if (synthesizer.isAvailable) {
    const available = synthesizer.isAvailable();
    const isAvail = available instanceof Promise ? false : available; // sync check only; async handled in async version
    if (available instanceof Promise) {
      // For sync, we cannot await, so we assume available if promise, but we check boolean result if available sync
      // Actually we should throw if async isAvailable returns promise that might be false — but we cannot know synchronously
      // So we skip check for sync when isAvailable returns promise, and rely on synthesizeSync to fail clearly
    } else if (!isAvail) {
      throw new AudioSynthesisError('SYNTHESIZER_UNAVAILABLE', `Synthesizer '${synthesizer.engineId}' is not available.`, {
        engineId: synthesizer.engineId,
      });
    }
  }

  const results: AudioSynthesisResult[] = [];
  const byClipId: Record<string, AudioSynthesisResult> = {};
  let successCount = 0;
  let failureCount = 0;
  let reusedCount = 0;
  let synthesizedCount = 0;

  const orderedClips = [...validatedPlan.clips].sort((a, b) => {
    if (a.globalTurnIndex !== b.globalTurnIndex) return a.globalTurnIndex - b.globalTurnIndex;
    if (a.sceneIndex !== b.sceneIndex) return a.sceneIndex - b.sceneIndex;
    return a.turnIndex - b.turnIndex;
  });

  const seenGlobal = new Set<number>();
  for (const clip of orderedClips) {
    if (seenGlobal.has(clip.globalTurnIndex)) {
      throw new AudioSynthesisError('DUPLICATE_CLIP_ID', `Duplicate globalTurnIndex ${clip.globalTurnIndex} for clip '${clip.clipId}'.`, {
        clipId: clip.clipId,
        globalTurnIndex: clip.globalTurnIndex,
      });
    }
    seenGlobal.add(clip.globalTurnIndex);
  }

  for (const clip of orderedClips) {
    let request: AudioSynthesisRequest;
    try {
      request = buildSynthesisRequest(clip, validatedPlan, validatedResolution, basePath);
    } catch (e) {
      if (e instanceof AudioSynthesisError) {
        const failedResult: AudioSynthesisResult = {
          clipId: clip.clipId,
          sceneId: clip.sceneId,
          turnId: clip.turnId,
          speakerId: clip.speakerId,
          voiceSlot: clip.voiceSlot,
          voiceProfileId: validatedResolution.bySlot[clip.voiceSlot]?.id ?? 'unknown',
          spokenText: clip.spokenText,
          outputPath: `${basePath}/${sanitizePathComponent(validatedPlan.scenarioId)}/${sanitizePathComponent(clip.sceneId)}_${sanitizePathComponent(clip.turnId)}.wav`,
          audioFormat: clip.audioFormat,
          success: false,
          error: {
            code: (e as AudioSynthesisError).code,
            message: (e as Error).message,
            details: (e as AudioSynthesisError).details,
          },
        };
        results.push(failedResult);
        byClipId[clip.clipId] = failedResult;
        failureCount++;
        continue;
      }
      throw e;
    }

    if (byClipId[request.clipId]) {
      throw new AudioSynthesisError('DUPLICATE_CLIP_ID', `Duplicate clipId '${request.clipId}' encountered during synthesis.`, {
        clipId: request.clipId,
      });
    }

    const engine = engineIdentityOf(synthesizer);
    const reused =
      options.reuse === false ? null : tryReuseExisting(request, engine);
    if (reused) {
      results.push(reused);
      byClipId[reused.clipId] = reused;
      successCount++;
      reusedCount++;
      continue;
    }

    try {
      const result = synthesizer.synthesizeSync(request);
      if (result.success) writeSidecar(request, engine, result);
      if (result.clipId !== request.clipId) {
        throw new AudioSynthesisError('CLIP_IDENTITY_MISMATCH', `Synthesizer returned mismatched clipId: expected '${request.clipId}', got '${result.clipId}'.`, {
          expected: request.clipId,
          got: result.clipId,
        });
      }
      if (result.spokenText !== request.spokenText) {
        throw new AudioSynthesisError('CLIP_IDENTITY_MISMATCH', `Synthesizer altered spokenText for clip '${request.clipId}'.`, {
          clipId: request.clipId,
        });
      }
      if (result.voiceSlot !== request.voiceSlot || result.voiceProfileId !== request.voiceProfileId) {
        throw new AudioSynthesisError('CLIP_IDENTITY_MISMATCH', `Synthesizer altered voice mapping for clip '${request.clipId}'.`, {
          clipId: request.clipId,
        });
      }
      results.push(result);
      byClipId[result.clipId] = result;
      if (result.success) {
        successCount++;
        synthesizedCount++;
      } else {
        failureCount++;
      }
    } catch (e) {
      if (e instanceof AudioSynthesisError) {
        const failedResult: AudioSynthesisResult = {
          clipId: request.clipId,
          sceneId: request.sceneId,
          turnId: request.turnId,
          speakerId: request.speakerId,
          voiceSlot: request.voiceSlot,
          voiceProfileId: request.voiceProfileId,
          spokenText: request.spokenText,
          outputPath: request.targetPath,
          audioFormat: request.audioFormat,
          success: false,
          error: {
            code: e.code,
            message: e.message,
            details: e.details,
          },
        };
        results.push(failedResult);
        byClipId[request.clipId] = failedResult;
        failureCount++;
        continue;
      }
      const failedResult: AudioSynthesisResult = {
        clipId: request.clipId,
        sceneId: request.sceneId,
        turnId: request.turnId,
        speakerId: request.speakerId,
        voiceSlot: request.voiceSlot,
        voiceProfileId: request.voiceProfileId,
        spokenText: request.spokenText,
        outputPath: request.targetPath,
        audioFormat: request.audioFormat,
        success: false,
        error: {
          code: 'SYNTHESIS_FAILED',
          message: (e as Error).message,
          details: { originalError: (e as Error).stack },
        },
      };
      results.push(failedResult);
      byClipId[request.clipId] = failedResult;
      failureCount++;
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: validatedPlan.scenarioId,
    language: validatedPlan.language,
    clipCount: orderedClips.length,
    successCount,
    failureCount,
    hadFailures: failureCount > 0,
    results,
    byClipId: Object.freeze({ ...byClipId }),
    basePath,
    reusedClipCount: reusedCount,
    synthesizedClipCount: synthesizedCount,
    synthesizedAt: new Date().toISOString(),
  };
}
