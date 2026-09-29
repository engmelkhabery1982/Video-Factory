/**
 * BuildTrack Video Factory - Phase 3C Dialogue Audio Planner
 *
 * Converts a validated canonical Scenario into a deterministic, manifest-only
 * DialogueAudioPlan specifying per-turn speech clips, voice slot assignments,
 * timeline coordinates, and audio format requirements.
 */

import { Scenario } from './types.js';
import {
  DEFAULT_DURATION_CONFIG,
  DurationEstimatorConfig,
  estimateTurnDuration,
} from './duration.js';
import { validateScenario } from './validate.js';
import {
  AudioFormatSpec,
  DEFAULT_AUDIO_FORMAT,
  DIALOGUE_AUDIO_PLAN_SCHEMA_VERSION,
  DialogueAudioCharacter,
  DialogueAudioClip,
  DialogueAudioPlan,
  DialogueAudioPlanOptions,
  DialogueAudioScene,
} from './dialogue-audio-types.js';

/**
 * Sanitizes an identifier for safe, deterministic use in relative filesystem paths.
 */
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
  const sanitized = id.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return sanitized === id ? sanitized : `${sanitized}_${stableHash(id)}`;
}

/**
 * Validates that a path is relative, safe, and contains no path traversal components.
 */
function validateSafeRelativePath(pathStr: string, fieldName: string): void {
  if (!pathStr || typeof pathStr !== 'string') {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  // Check for absolute paths
  if (pathStr.startsWith('/') || pathStr.startsWith('\\') || /^[a-zA-Z]:/.test(pathStr)) {
    throw new Error(`${fieldName} must be a relative path, but received absolute path: '${pathStr}'`);
  }
  // Check for directory traversal
  const segments = pathStr.split(/[/\\]/);
  if (segments.some(s => s === '..' || s === '.')) {
    throw new Error(`${fieldName} contains forbidden path traversal components: '${pathStr}'`);
  }
  // Check for unsafe characters
  if (/[<>:"|?*]/.test(pathStr)) {
    throw new Error(`${fieldName} contains forbidden filesystem characters: '${pathStr}'`);
  }
}

/**
 * Generates a deterministic DialogueAudioPlan from a validated Scenario.
 *
 * Pure function: does not perform I/O, does not invoke external services,
 * does not mutate the input Scenario, and produces byte-for-byte identical output
 * for identical inputs.
 */
export function planDialogueAudio(
  scenario: Scenario,
  options: DialogueAudioPlanOptions = {}
): DialogueAudioPlan {
  // 1. Validate the input Scenario before planning
  if (!scenario || typeof scenario !== 'object') {
    throw new Error('planDialogueAudio: scenario must be a non-null object.');
  }

  const scenarioReport = validateScenario(scenario);
  if (!scenarioReport.valid) {
    const errorDetails = scenarioReport.findings
      .filter(f => f.severity === 'error')
      .map(f => `[${f.ruleId}] ${f.message}`)
      .join('; ');
    throw new Error(`planDialogueAudio: Input Scenario failed validation: ${errorDetails}`);
  }

  // Validate basePath if supplied
  const basePath = options.basePath ?? 'audio/dialogue';
  validateSafeRelativePath(basePath, 'options.basePath');

  const durationConfig: DurationEstimatorConfig = {
    ...DEFAULT_DURATION_CONFIG,
    ...options.durationConfig,
  };
  for (const [name, value] of Object.entries(durationConfig)) {
    const permitsZero = name !== 'wordsPerMinute';
    if (!Number.isFinite(value) || (permitsZero ? value < 0 : value <= 0)) {
      throw new Error(`planDialogueAudio: durationConfig.${name} must be a finite ${permitsZero ? 'non-negative' : 'positive'} number.`);
    }
  }

  const audioFormat: AudioFormatSpec = { ...DEFAULT_AUDIO_FORMAT };

  // 2. Identify speaking characters and resolve voice slots
  const characterMap = new Map(scenario.characters.map(c => [c.id, c]));
  const speakingCharacterIds = new Set<string>();
  const characterTurnCounts = new Map<string, number>();

  for (const scene of scenario.scenes) {
    for (const turn of scene.turns) {
      speakingCharacterIds.add(turn.speakerId);
      characterTurnCounts.set(turn.speakerId, (characterTurnCounts.get(turn.speakerId) || 0) + 1);
    }
  }

  // 3. Resolve voice slot per character and per turn
  const resolvedCharacterVoiceSlots = new Map<string, string>();
  for (const charId of speakingCharacterIds) {
    const character = characterMap.get(charId);
    if (!character) {
      throw new Error(`planDialogueAudio: Speaking character '${charId}' is not declared in scenario characters.`);
    }

    // Default voice slot from character
    const charVoiceSlot = character.voiceSlot?.trim();
    if (!charVoiceSlot) {
      throw new Error(`planDialogueAudio: Speaking character '${character.name}' (${charId}) has no voiceSlot defined.`);
    }
    resolvedCharacterVoiceSlots.set(charId, charVoiceSlot);
  }

  // Verify every turn resolves to a non-empty slot and that overrides cannot
  // accidentally make two different characters sound identical.
  const voiceSlotToCharacterId = new Map<string, string>();
  for (const scene of scenario.scenes) {
    for (const turn of scene.turns) {
      const resolvedSlot = (turn.voiceSlot?.trim() || resolvedCharacterVoiceSlots.get(turn.speakerId))?.trim();
      if (!resolvedSlot) {
        const char = characterMap.get(turn.speakerId);
        const charName = char ? `'${char.name}' (${turn.speakerId})` : `'${turn.speakerId}'`;
        throw new Error(
          `planDialogueAudio: Speaking character ${charName} has no voiceSlot defined (turn '${turn.id}' in scene '${scene.id}'). ` +
          `Every speaking character must have a valid voiceSlot assigned.`
        );
      }
      if (!options.allowSharedVoiceSlots) {
        const existingChar = voiceSlotToCharacterId.get(resolvedSlot);
        if (existingChar && existingChar !== turn.speakerId) {
          throw new Error(
            `planDialogueAudio: Voice slot '${resolvedSlot}' is assigned to multiple characters ('${existingChar}' and '${turn.speakerId}'). ` +
            `Multi-character dialogue requires distinct voice slots by default. Set options.allowSharedVoiceSlots: true to override.`
          );
        }
        voiceSlotToCharacterId.set(resolvedSlot, turn.speakerId);
      }
    }
  }

  // Build characters list for the plan
  const planCharacters: DialogueAudioCharacter[] = Array.from(speakingCharacterIds).map(charId => {
    const char = characterMap.get(charId)!;
    return {
      characterId: char.id,
      name: char.name,
      role: char.role,
      voiceSlot: resolvedCharacterVoiceSlots.get(charId) || '',
      turnCount: characterTurnCounts.get(charId) || 0,
    };
  });

  // 4. Construct scenes and clips with monotonic timeline positions
  const safeScenarioId = sanitizePathComponent(scenario.metadata.id);
  const planScenes: DialogueAudioScene[] = [];
  const allClips: DialogueAudioClip[] = [];

  let currentTimelineSeconds = 0;
  let totalSpeechSeconds = 0;
  let totalPauseSeconds = 0;
  let globalTurnIndex = 0;

  for (let sIdx = 0; sIdx < scenario.scenes.length; sIdx++) {
    const scene = scenario.scenes[sIdx];
    const safeSceneId = sanitizePathComponent(scene.id);
    const sceneStartTime = currentTimelineSeconds;
    const sceneClips: DialogueAudioClip[] = [];

    for (let tIdx = 0; tIdx < scene.turns.length; tIdx++) {
      const turn = scene.turns[tIdx];
      const safeTurnId = sanitizePathComponent(turn.id);
      const turnEstimate = estimateTurnDuration(turn, durationConfig);

      const resolvedVoiceSlot = (turn.voiceSlot?.trim() || resolvedCharacterVoiceSlots.get(turn.speakerId))!;

      // Deterministic clip ID
      const clipId = `clip_${safeSceneId}_${safeTurnId}`;

      // Deterministic, safe, relative suggested path
      const suggestedPath = `${basePath}/${safeScenarioId}/${safeSceneId}_${safeTurnId}.wav`;
      validateSafeRelativePath(suggestedPath, 'clip.suggestedPath');

      const clipStartTime = currentTimelineSeconds;
      const speechDuration = turnEstimate.speechDurationSeconds;
      const clipEndTime = Math.round((clipStartTime + speechDuration) * 100) / 100;
      const pauseDuration = turnEstimate.pauseSeconds;
      const totalSpan = Math.round((speechDuration + pauseDuration) * 100) / 100;

      const clip: DialogueAudioClip = {
        clipId,
        sceneId: scene.id,
        sceneIndex: sIdx,
        turnId: turn.id,
        turnIndex: tIdx,
        globalTurnIndex,
        speakerId: turn.speakerId,
        voiceSlot: resolvedVoiceSlot,
        spokenText: turn.spokenText,
        intent: turn.intent,
        delivery: turn.delivery,
        evidenceId: turn.evidenceId,
        suggestedPath,
        audioFormat: { ...audioFormat },
        startTimeSeconds: clipStartTime,
        durationSeconds: speechDuration,
        endTimeSeconds: clipEndTime,
        pauseAfterSeconds: pauseDuration,
        totalSpanSeconds: totalSpan,
      };

      sceneClips.push(clip);
      allClips.push(clip);

      totalSpeechSeconds = Math.round((totalSpeechSeconds + speechDuration) * 100) / 100;
      totalPauseSeconds = Math.round((totalPauseSeconds + pauseDuration) * 100) / 100;

      // Monotonic step: next turn starts after speech + pause gap
      currentTimelineSeconds = Math.round((clipStartTime + totalSpan) * 100) / 100;
      globalTurnIndex++;
    }

    // Account for scene-level transition buffer or non-dialogue beats if present
    const hasTransition = scene.transitionIntent && scene.transitionIntent.type !== 'none' && scene.transitionIntent.type !== 'cut';
    const transitionBuffer = hasTransition
      ? (scene.transitionIntent?.durationSeconds ?? durationConfig.transitionAllowanceSeconds)
      : 0;

    const visualBeatBuffer = scene.turns.length === 0 ? durationConfig.nonDialogueBeatSeconds : 0;
    const additionalBuffer = Math.round((transitionBuffer + visualBeatBuffer) * 100) / 100;

    currentTimelineSeconds = Math.round((currentTimelineSeconds + additionalBuffer) * 100) / 100;

    const sceneDuration = Math.round((currentTimelineSeconds - sceneStartTime) * 100) / 100;

    planScenes.push({
      sceneId: scene.id,
      sceneIndex: sIdx,
      title: scene.title,
      startTimeSeconds: sceneStartTime,
      endTimeSeconds: currentTimelineSeconds,
      durationSeconds: sceneDuration,
      clips: sceneClips,
    });
  }

  const totalDurationSeconds = Math.round(currentTimelineSeconds * 100) / 100;

  return {
    schemaVersion: DIALOGUE_AUDIO_PLAN_SCHEMA_VERSION,
    scenarioId: scenario.metadata.id,
    projectId: scenario.metadata.projectId,
    targetFormat: scenario.metadata.targetFormat,
    language: scenario.metadata.language,
    audioFormat,
    durationConfig: { ...durationConfig },
    allowSharedVoiceSlots: options.allowSharedVoiceSlots === true,
    totalDurationSeconds,
    totalSpeechDurationSeconds: totalSpeechSeconds,
    totalPauseDurationSeconds: totalPauseSeconds,
    clipCount: allClips.length,
    characters: planCharacters,
    scenes: planScenes,
    clips: allClips,
  };
}
