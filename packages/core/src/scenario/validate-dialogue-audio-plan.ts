/**
 * BuildTrack Video Factory - Phase 3C Dialogue Audio Plan Validator
 *
 * Validates a DialogueAudioPlan against its source Scenario and structural invariants:
 * turn completeness, voice slot consistency, monotonic non-overlapping timeline positions,
 * safe relative paths, audio formatting, and duration consistency.
 */

import { Scenario } from './types.js';
import { DEFAULT_DURATION_CONFIG, estimateScenarioDuration, estimateTurnDuration, type DurationEstimatorConfig } from './duration.js';
import {
  DIALOGUE_AUDIO_PLAN_SCHEMA_VERSION,
  DialogueAudioPlan,
  DialogueAudioPlanFinding,
  DialogueAudioPlanValidationReport,
} from './dialogue-audio-types.js';

export function validateDialogueAudioPlan(
  plan: DialogueAudioPlan,
  sourceScenario?: Scenario
): DialogueAudioPlanValidationReport {
  const findings: DialogueAudioPlanFinding[] = [];

  const addError = (
    category: DialogueAudioPlanFinding['category'],
    ruleId: string,
    message: string,
    location?: DialogueAudioPlanFinding['location']
  ) => {
    findings.push({ severity: 'error', category, ruleId, message, location });
  };

  const addWarning = (
    category: DialogueAudioPlanFinding['category'],
    ruleId: string,
    message: string,
    location?: DialogueAudioPlanFinding['location']
  ) => {
    findings.push({ severity: 'warning', category, ruleId, message, location });
  };

  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

  // 1. Basic object & schema check
  if (!plan || typeof plan !== 'object') {
    return {
      valid: false,
      errorCount: 1,
      warningCount: 0,
      findings: [{
        severity: 'error',
        category: 'schema',
        ruleId: 'DAP-000-INVALID-OBJECT',
        message: 'DialogueAudioPlan must be a non-null object.',
      }],
    };
  }

  if (plan.schemaVersion !== DIALOGUE_AUDIO_PLAN_SCHEMA_VERSION) {
    addError(
      'schema',
      'DAP-001-SCHEMA-VERSION',
      `Unsupported schemaVersion '${plan.schemaVersion}'. Expected '${DIALOGUE_AUDIO_PLAN_SCHEMA_VERSION}'.`,
      { scenarioId: plan.scenarioId }
    );
  }

  const durationConfig = plan.durationConfig as DurationEstimatorConfig | undefined;
  if (!durationConfig || typeof durationConfig !== 'object') {
    addError('schema', 'DAP-001-DURATION-CONFIG', 'durationConfig must record the estimator assumptions used by the planner.', { scenarioId: plan.scenarioId });
  } else {
    const durationKeys: (keyof DurationEstimatorConfig)[] = ['wordsPerMinute', 'minTurnSeconds', 'defaultPauseSeconds', 'transitionAllowanceSeconds', 'nonDialogueBeatSeconds'];
    for (const name of durationKeys) {
      const value = durationConfig[name];
      const permitsZero = name !== 'wordsPerMinute';
      if (!finite(value) || (permitsZero ? value < 0 : value <= 0)) {
        addError('timing', 'DAP-001-DURATION-CONFIG', `durationConfig.${name} must be a finite ${permitsZero ? 'non-negative' : 'positive'} number.`, { scenarioId: plan.scenarioId });
      }
    }
  }
  if (typeof plan.allowSharedVoiceSlots !== 'boolean') addError('schema', 'DAP-001-SHARED-SLOTS-FLAG', 'allowSharedVoiceSlots must be a boolean.', { scenarioId: plan.scenarioId });

  // 2. Audio format specification check
  const fmt = plan.audioFormat;
  if (!fmt || typeof fmt !== 'object') {
    addError('format', 'DAP-002-AUDIO-FORMAT-MISSING', 'audioFormat must be defined in plan.', { scenarioId: plan.scenarioId });
  } else {
    if (fmt.container !== 'wav') {
      addError('format', 'DAP-002-AUDIO-CONTAINER', `audioFormat.container must be 'wav', received '${fmt.container}'.`, { scenarioId: plan.scenarioId });
    }
    if (fmt.sampleRate !== 48000) {
      addError('format', 'DAP-002-AUDIO-SAMPLERATE', `audioFormat.sampleRate must be 48000, received ${fmt.sampleRate}.`, { scenarioId: plan.scenarioId });
    }
    if (fmt.channels !== 1) {
      addError('format', 'DAP-002-AUDIO-CHANNELS', `audioFormat.channels must be 1 (mono), received ${fmt.channels}.`, { scenarioId: plan.scenarioId });
    }
    if (fmt.codec !== 'pcm_s16le') {
      addError('format', 'DAP-002-AUDIO-CODEC', `audioFormat.codec must be 'pcm_s16le', received '${fmt.codec}'.`, { scenarioId: plan.scenarioId });
    }
    if (fmt.bitDepth !== 16) {
      addError('format', 'DAP-002-AUDIO-BIT-DEPTH', `audioFormat.bitDepth must be 16, received ${fmt.bitDepth}.`, { scenarioId: plan.scenarioId });
    }
  }

  // 3. Character manifest validation
  const characters = plan.characters || [];
  if (!Array.isArray(characters)) {
    addError('schema', 'DAP-003-CHARACTERS-ARRAY', 'plan.characters must be an array.', { scenarioId: plan.scenarioId });
  }
  const characterById = new Map<string, (typeof plan.characters)[number]>();
  if (Array.isArray(characters)) {
    for (const character of characters) {
      if (!character?.characterId || characterById.has(character.characterId)) {
        addError('integrity', 'DAP-003-CHARACTER-ID', `Character entry has a missing or duplicate characterId '${character?.characterId ?? ''}'.`, { scenarioId: plan.scenarioId, characterId: character?.characterId });
        continue;
      }
      characterById.set(character.characterId, character);
      if (!character.voiceSlot?.trim()) addError('voice_slot', 'DAP-003-CHARACTER-VOICE-SLOT', `Character '${character.characterId}' has no default voiceSlot.`, { scenarioId: plan.scenarioId, characterId: character.characterId });
      if (!Number.isInteger(character.turnCount) || character.turnCount < 0) addError('integrity', 'DAP-003-CHARACTER-TURN-COUNT', `Character '${character.characterId}' has an invalid turnCount.`, { scenarioId: plan.scenarioId, characterId: character.characterId });
    }
  }

  // 4. Clips validation
  const clips = plan.clips || [];
  if (!Array.isArray(clips)) {
    addError('schema', 'DAP-003-CLIPS-ARRAY', 'plan.clips must be an array.', { scenarioId: plan.scenarioId });
    return {
      valid: false,
      errorCount: findings.filter(f => f.severity === 'error').length,
      warningCount: findings.filter(f => f.severity === 'warning').length,
      findings,
    };
  }

  if (typeof plan.clipCount !== 'number' || plan.clipCount !== clips.length) {
    addError(
      'integrity',
      'DAP-004-CLIP-COUNT-MISMATCH',
      `plan.clipCount (${plan.clipCount}) does not match clips array length (${clips.length}).`,
      { scenarioId: plan.scenarioId }
    );
  }

  const seenClipIds = new Set<string>();
  const seenTurnIds = new Set<string>();
  const seenPaths = new Set<string>();
  const slotOwners = new Map<string, string>();
  let lastClipEndTimeWithPause = 0;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const loc = {
      scenarioId: plan.scenarioId,
      sceneId: clip.sceneId,
      turnId: clip.turnId,
      clipId: clip.clipId,
      characterId: clip.speakerId,
      voiceSlot: clip.voiceSlot,
    };

    // Unique clipId
    if (!clip.clipId) {
      addError('integrity', 'DAP-005-CLIP-ID-MISSING', `Clip at index ${i} has empty or missing clipId.`, loc);
    } else if (seenClipIds.has(clip.clipId)) {
      addError('integrity', 'DAP-005-CLIP-ID-DUPLICATE', `Duplicate clipId '${clip.clipId}'.`, loc);
    } else {
      seenClipIds.add(clip.clipId);
    }

    // Turn uniqueness
    if (!clip.turnId) {
      addError('integrity', 'DAP-006-TURN-ID-MISSING', `Clip at index ${i} has empty or missing turnId.`, loc);
    } else if (seenTurnIds.has(clip.turnId)) {
      addError('integrity', 'DAP-006-TURN-ID-DUPLICATE', `Turn '${clip.turnId}' appears multiple times in audio plan.`, loc);
    } else {
      seenTurnIds.add(clip.turnId);
    }

    // Voice slot presence
    if (!clip.voiceSlot || !clip.voiceSlot.trim()) {
      addError('voice_slot', 'DAP-007-VOICE-SLOT-MISSING', `Clip '${clip.clipId}' has missing or empty voiceSlot.`, loc);
    }
    if (!plan.allowSharedVoiceSlots && clip.voiceSlot?.trim()) {
      const owner = slotOwners.get(clip.voiceSlot);
      if (owner && owner !== clip.speakerId) {
        addError('voice_slot', 'DAP-007-VOICE-SLOT-SHARED', `Voice slot '${clip.voiceSlot}' is shared by characters '${owner}' and '${clip.speakerId}' without explicit permission.`, loc);
      } else slotOwners.set(clip.voiceSlot, clip.speakerId);
    }

    // Spoken text
    if (!clip.spokenText || !clip.spokenText.trim()) {
      addError('schema', 'DAP-008-SPOKEN-TEXT-EMPTY', `Clip '${clip.clipId}' has empty spokenText.`, loc);
    }

    // Path safety
    const pathStr = clip.suggestedPath;
    if (!pathStr || typeof pathStr !== 'string') {
      addError('path', 'DAP-009-PATH-INVALID', `Clip '${clip.clipId}' has invalid suggestedPath.`, loc);
    } else {
      if (pathStr.startsWith('/') || pathStr.startsWith('\\') || /^[a-zA-Z]:/.test(pathStr)) {
        addError('path', 'DAP-009-PATH-ABSOLUTE', `Clip '${clip.clipId}' suggestedPath must be relative, got: '${pathStr}'.`, loc);
      }
      const segments = pathStr.split(/[/\\]/);
      if (segments.some(s => s === '..' || s === '.')) {
        addError('path', 'DAP-009-PATH-TRAVERSAL', `Clip '${clip.clipId}' suggestedPath contains path traversal: '${pathStr}'.`, loc);
      }
      if (/[<>:"|?*]/.test(pathStr)) {
        addError('path', 'DAP-009-PATH-UNSAFE-CHARS', `Clip '${clip.clipId}' suggestedPath contains invalid filename characters: '${pathStr}'.`, loc);
      }
      if (!pathStr.endsWith('.wav')) {
        addError('path', 'DAP-009-PATH-EXTENSION', `Clip '${clip.clipId}' suggestedPath must end with '.wav', got: '${pathStr}'.`, loc);
      }
      if (seenPaths.has(pathStr)) addError('path', 'DAP-009-PATH-DUPLICATE', `Multiple clips use suggestedPath '${pathStr}'.`, loc);
      else seenPaths.add(pathStr);
    }

    // Timeline validity
    if (!finite(clip.durationSeconds) || clip.durationSeconds <= 0) {
      addError('timing', 'DAP-010-DURATION-POSITIVE', `Clip '${clip.clipId}' durationSeconds must be positive.`, loc);
    }

    if (!finite(clip.startTimeSeconds) || clip.startTimeSeconds < 0) {
      addError('timing', 'DAP-010-START-TIME-POSITIVE', `Clip '${clip.clipId}' startTimeSeconds must be non-negative.`, loc);
    }
    if (!finite(clip.pauseAfterSeconds) || clip.pauseAfterSeconds < 0) addError('timing', 'DAP-010-PAUSE-NONNEGATIVE', `Clip '${clip.clipId}' pauseAfterSeconds must be non-negative.`, loc);
    if (!finite(clip.totalSpanSeconds) || Math.abs(clip.totalSpanSeconds - (clip.durationSeconds + clip.pauseAfterSeconds)) > 0.05) addError('timing', 'DAP-010-SPAN-CALCULATION', `Clip '${clip.clipId}' totalSpanSeconds does not equal duration plus pause.`, loc);
    if (clip.globalTurnIndex !== i) addError('integrity', 'DAP-010-GLOBAL-ORDER', `Clip '${clip.clipId}' globalTurnIndex ${clip.globalTurnIndex} should be ${i}.`, loc);
    if (!same(clip.audioFormat, plan.audioFormat)) addError('format', 'DAP-010-CLIP-FORMAT', `Clip '${clip.clipId}' audioFormat differs from the plan format.`, loc);

    // Non-overlapping and monotonicity
    if (i > 0) {
      if (clip.startTimeSeconds < clips[i - 1].endTimeSeconds) {
        addError(
          'timing',
          'DAP-011-CLIP-OVERLAP',
          `Clip '${clip.clipId}' start (${clip.startTimeSeconds}s) overlaps with previous clip '${clips[i - 1].clipId}' end (${clips[i - 1].endTimeSeconds}s).`,
          loc
        );
      }
      if (clip.startTimeSeconds < lastClipEndTimeWithPause - 0.05) {
        addWarning(
          'timing',
          'DAP-011-PAUSE-EROSION',
          `Clip '${clip.clipId}' starts before previous clip's pause window completed.`,
          loc
        );
      }
    }

    // Expected end time
    const expectedEnd = Math.round((clip.startTimeSeconds + clip.durationSeconds) * 100) / 100;
    if (Math.abs(clip.endTimeSeconds - expectedEnd) > 0.05) {
      addError(
        'timing',
        'DAP-012-END-TIME-CALCULATION',
        `Clip '${clip.clipId}' endTimeSeconds (${clip.endTimeSeconds}) != startTime + duration (${expectedEnd}).`,
        loc
      );
    }

    lastClipEndTimeWithPause = Math.round((clip.endTimeSeconds + (clip.pauseAfterSeconds || 0)) * 100) / 100;
  }

  const speechTotal = Math.round(clips.reduce((sum, clip) => sum + (finite(clip.durationSeconds) ? clip.durationSeconds : 0), 0) * 100) / 100;
  const pauseTotal = Math.round(clips.reduce((sum, clip) => sum + (finite(clip.pauseAfterSeconds) ? clip.pauseAfterSeconds : 0), 0) * 100) / 100;
  if (Math.abs(plan.totalSpeechDurationSeconds - speechTotal) > 0.05) addError('timing', 'DAP-012-SPEECH-TOTAL', `totalSpeechDurationSeconds (${plan.totalSpeechDurationSeconds}) does not match clip total (${speechTotal}).`, { scenarioId: plan.scenarioId });
  if (Math.abs(plan.totalPauseDurationSeconds - pauseTotal) > 0.05) addError('timing', 'DAP-012-PAUSE-TOTAL', `totalPauseDurationSeconds (${plan.totalPauseDurationSeconds}) does not match clip total (${pauseTotal}).`, { scenarioId: plan.scenarioId });

  // 5. Scene manifest must describe the same clips in the same order.
  const scenes = plan.scenes || [];
  if (!Array.isArray(scenes)) addError('schema', 'DAP-012-SCENES-ARRAY', 'plan.scenes must be an array.', { scenarioId: plan.scenarioId });
  else {
    const sceneIds = new Set<string>();
    let previousEnd = 0;
    const nestedClips: typeof clips = [];
    scenes.forEach((scene, index) => {
      const loc = { scenarioId: plan.scenarioId, sceneId: scene?.sceneId };
      if (!scene?.sceneId || sceneIds.has(scene.sceneId)) addError('integrity', 'DAP-012-SCENE-ID', `Scene entry has a missing or duplicate sceneId '${scene?.sceneId ?? ''}'.`, loc);
      else sceneIds.add(scene.sceneId);
      if (scene?.sceneIndex !== index) addError('integrity', 'DAP-012-SCENE-ORDER', `Scene '${scene?.sceneId}' index ${scene?.sceneIndex} should be ${index}.`, loc);
      if (!finite(scene?.startTimeSeconds) || !finite(scene?.endTimeSeconds) || scene.endTimeSeconds < scene.startTimeSeconds) addError('timing', 'DAP-012-SCENE-TIMING', `Scene '${scene?.sceneId}' has invalid timing.`, loc);
      else {
        if (scene.startTimeSeconds < previousEnd - 0.05) addError('timing', 'DAP-012-SCENE-OVERLAP', `Scene '${scene.sceneId}' overlaps the previous scene.`, loc);
        if (Math.abs(scene.durationSeconds - (scene.endTimeSeconds - scene.startTimeSeconds)) > 0.05) addError('timing', 'DAP-012-SCENE-DURATION', `Scene '${scene.sceneId}' duration does not equal end minus start.`, loc);
        previousEnd = scene.endTimeSeconds;
      }
      if (!Array.isArray(scene?.clips)) addError('schema', 'DAP-012-SCENE-CLIPS', `Scene '${scene?.sceneId}' clips must be an array.`, loc);
      else nestedClips.push(...scene.clips);
    });
    if (!same(nestedClips, clips)) addError('integrity', 'DAP-012-SCENE-CLIP-COVERAGE', 'Scene clip lists do not exactly match the flattened plan.clips order and content.', { scenarioId: plan.scenarioId });
    if (scenes.length && Math.abs(plan.totalDurationSeconds - scenes[scenes.length - 1].endTimeSeconds) > 0.05) addError('timing', 'DAP-012-PLAN-TOTAL', 'totalDurationSeconds does not equal the final scene end.', { scenarioId: plan.scenarioId });
  }

  // 6. Source scenario cross-validation if provided
  if (sourceScenario) {
    if (plan.scenarioId !== sourceScenario.metadata.id) {
      addError(
        'integrity',
        'DAP-013-SCENARIO-ID-MISMATCH',
        `Plan scenarioId '${plan.scenarioId}' does not match source scenario '${sourceScenario.metadata.id}'.`,
        { scenarioId: plan.scenarioId }
      );
    }

    if (plan.targetFormat !== sourceScenario.metadata.targetFormat) {
      addError(
        'integrity',
        'DAP-013-TARGET-FORMAT-MISMATCH',
        `Plan targetFormat '${plan.targetFormat}' does not match source '${sourceScenario.metadata.targetFormat}'.`,
        { scenarioId: plan.scenarioId }
      );
    }
    if (plan.projectId !== sourceScenario.metadata.projectId) addError('integrity', 'DAP-013-PROJECT-ID-MISMATCH', `Plan projectId '${plan.projectId}' does not match source '${sourceScenario.metadata.projectId}'.`, { scenarioId: plan.scenarioId });
    if (plan.language !== sourceScenario.metadata.language) addError('integrity', 'DAP-013-LANGUAGE-MISMATCH', `Plan language '${plan.language}' does not match source '${sourceScenario.metadata.language}'.`, { scenarioId: plan.scenarioId });

    // Check every turn in source scenario is present
    const effectiveDurationConfig = durationConfig && typeof durationConfig === 'object' ? durationConfig : DEFAULT_DURATION_CONFIG;
    const sourceTurns: { sceneId: string; sceneIndex: number; turnId: string; turnIndex: number; globalTurnIndex: number; speakerId: string; spokenText: string; intent: unknown; delivery: unknown; evidenceId: unknown; voiceSlot: string; durationSeconds: number; pauseAfterSeconds: number }[] = [];
    let sourceGlobalIndex = 0;
    for (let sceneIndex = 0; sceneIndex < (sourceScenario.scenes || []).length; sceneIndex++) {
      const scene = sourceScenario.scenes[sceneIndex];
      for (let turnIndex = 0; turnIndex < (scene.turns || []).length; turnIndex++) {
        const turn = scene.turns[turnIndex];
        const character = sourceScenario.characters.find(c => c.id === turn.speakerId);
        const estimate = estimateTurnDuration(turn, effectiveDurationConfig);
        sourceTurns.push({
          sceneId: scene.id,
          sceneIndex,
          turnId: turn.id,
          turnIndex,
          globalTurnIndex: sourceGlobalIndex++,
          speakerId: turn.speakerId,
          spokenText: turn.spokenText,
          intent: turn.intent,
          delivery: turn.delivery,
          evidenceId: turn.evidenceId,
          voiceSlot: (turn.voiceSlot?.trim() || character?.voiceSlot?.trim() || ''),
          durationSeconds: estimate.speechDurationSeconds,
          pauseAfterSeconds: estimate.pauseSeconds,
        });
      }
    }

    if (clips.length !== sourceTurns.length) {
      addError(
        'integrity',
        'DAP-014-TOTAL-TURNS-COUNT',
        `Plan has ${clips.length} clips, but source scenario has ${sourceTurns.length} dialogue turns.`,
        { scenarioId: plan.scenarioId }
      );
    }

    for (let idx = 0; idx < sourceTurns.length; idx++) {
      const src = sourceTurns[idx];
      const matchingClip = clips.find(c => c.turnId === src.turnId);
      if (!matchingClip) {
        addError(
          'integrity',
          'DAP-014-TURN-MISSING',
          `Turn '${src.turnId}' from source scene '${src.sceneId}' is missing from dialogue audio plan.`,
          { scenarioId: plan.scenarioId, sceneId: src.sceneId, turnId: src.turnId }
        );
      } else {
        if (matchingClip.speakerId !== src.speakerId) {
          addError(
            'integrity',
            'DAP-015-SPEAKER-MISMATCH',
            `Clip '${matchingClip.clipId}' speaker '${matchingClip.speakerId}' does not match source turn speaker '${src.speakerId}'.`,
            { scenarioId: plan.scenarioId, turnId: src.turnId }
          );
        }
        if (matchingClip.spokenText !== src.spokenText) {
          addError(
            'integrity',
            'DAP-016-TEXT-ALTERED',
            `Clip '${matchingClip.clipId}' spokenText does not match source turn text exactly.`,
            { scenarioId: plan.scenarioId, turnId: src.turnId }
          );
        }
        if (matchingClip.sceneId !== src.sceneId || matchingClip.sceneIndex !== src.sceneIndex || matchingClip.turnIndex !== src.turnIndex || matchingClip.globalTurnIndex !== src.globalTurnIndex) addError('integrity', 'DAP-016-ORDER-ALTERED', `Clip '${matchingClip.clipId}' scene/turn ordering differs from the source.`, { scenarioId: plan.scenarioId, turnId: src.turnId });
        if (matchingClip.intent !== src.intent || !same(matchingClip.delivery, src.delivery)) addError('integrity', 'DAP-016-DIRECTION-ALTERED', `Clip '${matchingClip.clipId}' intent or delivery differs from the source turn.`, { scenarioId: plan.scenarioId, turnId: src.turnId });
        if (!same(matchingClip.evidenceId, src.evidenceId)) addError('integrity', 'DAP-016-EVIDENCE-ALTERED', `Clip '${matchingClip.clipId}' evidenceId differs from the source turn.`, { scenarioId: plan.scenarioId, turnId: src.turnId });
        if (matchingClip.voiceSlot !== src.voiceSlot) addError('voice_slot', 'DAP-016-VOICE-SLOT-ALTERED', `Clip '${matchingClip.clipId}' voiceSlot differs from the resolved source slot.`, { scenarioId: plan.scenarioId, turnId: src.turnId, voiceSlot: matchingClip.voiceSlot });
        if (Math.abs(matchingClip.durationSeconds - src.durationSeconds) > 0.05 || Math.abs(matchingClip.pauseAfterSeconds - src.pauseAfterSeconds) > 0.05) addError('timing', 'DAP-016-DURATION-ALTERED', `Clip '${matchingClip.clipId}' duration or pause differs from the estimator.`, { scenarioId: plan.scenarioId, turnId: src.turnId });
      }
    }

    const usedCharacterIds = [...new Set(sourceTurns.map(turn => turn.speakerId))];
    if (characters.length !== usedCharacterIds.length) addError('integrity', 'DAP-016-CHARACTER-COUNT', `Plan has ${characters.length} characters, but source has ${usedCharacterIds.length} speaking characters.`, { scenarioId: plan.scenarioId });
    for (const characterId of usedCharacterIds) {
      const sourceCharacter = sourceScenario.characters.find(c => c.id === characterId);
      const plannedCharacter = characterById.get(characterId);
      if (!plannedCharacter || !sourceCharacter) addError('integrity', 'DAP-016-CHARACTER-MISSING', `Speaking character '${characterId}' is missing from the character manifest.`, { scenarioId: plan.scenarioId, characterId });
      else {
        const expectedTurns = sourceTurns.filter(turn => turn.speakerId === characterId).length;
        if (plannedCharacter.name !== sourceCharacter.name || plannedCharacter.role !== sourceCharacter.role || plannedCharacter.voiceSlot !== sourceCharacter.voiceSlot?.trim() || plannedCharacter.turnCount !== expectedTurns) addError('integrity', 'DAP-016-CHARACTER-ALTERED', `Character manifest entry '${characterId}' differs from the source.`, { scenarioId: plan.scenarioId, characterId });
      }
    }

    if (Array.isArray(scenes)) {
      if (scenes.length !== sourceScenario.scenes.length) addError('integrity', 'DAP-016-SCENE-COUNT', `Plan has ${scenes.length} scenes, but source has ${sourceScenario.scenes.length}.`, { scenarioId: plan.scenarioId });
      sourceScenario.scenes.forEach((sourceScene, index) => {
        const plannedScene = scenes[index];
        if (!plannedScene || plannedScene.sceneId !== sourceScene.id || plannedScene.sceneIndex !== index || !same(plannedScene.title, sourceScene.title)) addError('integrity', 'DAP-016-SCENE-ALTERED', `Scene ${index} does not match source scene '${sourceScene.id}'.`, { scenarioId: plan.scenarioId, sceneId: sourceScene.id });
      });
    }

    // Duration estimate consistency check
    const scenarioEstimate = estimateScenarioDuration(sourceScenario, effectiveDurationConfig);
    const diff = Math.abs(plan.totalDurationSeconds - scenarioEstimate.totalSeconds);
    if (diff > 0.5) {
      addWarning(
        'timing',
        'DAP-017-DURATION-CONSISTENCY',
        `Plan totalDurationSeconds (${plan.totalDurationSeconds}s) differs from scenario estimate (${scenarioEstimate.totalSeconds}s) by ${diff.toFixed(2)}s.`,
        { scenarioId: plan.scenarioId }
      );
    }
  }

  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warning');

  return {
    valid: errors.length === 0,
    errorCount: errors.length,
    warningCount: warnings.length,
    findings,
  };
}
