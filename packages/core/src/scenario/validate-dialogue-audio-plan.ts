/**
 * BuildTrack Video Factory - Phase 3C Dialogue Audio Plan Validator
 *
 * Validates a DialogueAudioPlan against its source Scenario and structural invariants:
 * turn completeness, voice slot consistency, monotonic non-overlapping timeline positions,
 * safe relative paths, audio formatting, and duration consistency.
 */

import { Scenario } from './types.js';
import { estimateScenarioDuration } from './duration.js';
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
  }

  // 3. Clips validation
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
    }

    // Timeline validity
    if (typeof clip.durationSeconds !== 'number' || clip.durationSeconds <= 0) {
      addError('timing', 'DAP-010-DURATION-POSITIVE', `Clip '${clip.clipId}' durationSeconds must be positive.`, loc);
    }

    if (typeof clip.startTimeSeconds !== 'number' || clip.startTimeSeconds < 0) {
      addError('timing', 'DAP-010-START-TIME-POSITIVE', `Clip '${clip.clipId}' startTimeSeconds must be non-negative.`, loc);
    }

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

  // 4. Source scenario cross-validation if provided
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

    // Check every turn in source scenario is present
    const sourceTurns: { sceneId: string; turnId: string; speakerId: string; spokenText: string }[] = [];
    for (const scene of sourceScenario.scenes || []) {
      for (const turn of scene.turns || []) {
        sourceTurns.push({
          sceneId: scene.id,
          turnId: turn.id,
          speakerId: turn.speakerId,
          spokenText: turn.spokenText,
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
      }
    }

    // Duration estimate consistency check
    const scenarioEstimate = estimateScenarioDuration(sourceScenario);
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
