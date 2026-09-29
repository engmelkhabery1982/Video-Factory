/**
 * BuildTrack Video Factory - Phase 3E Scenario Caption Plan Validator
 *
 * Validates a ScenarioCaptionPlan against its source Scenario and DialogueAudioPlan:
 * verifies word-for-word text reconstruction, zero word omissions/duplications,
 * no invented speaker names, no overlap, zero encroachment into pause intervals,
 * monotonic ordering, correct metadata, and structural integrity.
 */

import { Scenario } from './types.js';
import { DialogueAudioPlan } from './dialogue-audio-types.js';
import {
  SCENARIO_CAPTION_PLAN_SCHEMA_VERSION,
  ScenarioCaptionCue,
  ScenarioCaptionFinding,
  ScenarioCaptionPlan,
  ScenarioCaptionValidationReport,
} from './scenario-caption-types.js';

export function validateScenarioCaptionPlan(
  plan: ScenarioCaptionPlan,
  sourceScenario: Scenario,
  audioPlan: DialogueAudioPlan
): ScenarioCaptionValidationReport {
  const findings: ScenarioCaptionFinding[] = [];

  const addError = (
    category: ScenarioCaptionFinding['category'],
    ruleId: string,
    message: string,
    location?: ScenarioCaptionFinding['location']
  ) => {
    findings.push({ severity: 'error', category, ruleId, message, location });
  };

  const addWarning = (
    category: ScenarioCaptionFinding['category'],
    ruleId: string,
    message: string,
    location?: ScenarioCaptionFinding['location']
  ) => {
    findings.push({ severity: 'warning', category, ruleId, message, location });
  };

  // 1. Basic object checks
  if (!plan || typeof plan !== 'object') {
    return {
      valid: false,
      errorCount: 1,
      warningCount: 0,
      findings: [{
        severity: 'error',
        category: 'schema',
        ruleId: 'VAL-000-INVALID-PLAN',
        message: 'ScenarioCaptionPlan must be a non-null object.',
      }],
    };
  }

  if (plan.schemaVersion !== SCENARIO_CAPTION_PLAN_SCHEMA_VERSION) {
    addError(
      'schema',
      'VAL-001-SCHEMA-VERSION',
      `Unsupported schemaVersion '${plan.schemaVersion}'. Expected '${SCENARIO_CAPTION_PLAN_SCHEMA_VERSION}'.`,
      { scenarioId: plan.scenarioId }
    );
  }

  // Check top-level metadata alignment
  if (plan.scenarioId !== sourceScenario?.metadata?.id) {
    addError(
      'integrity',
      'VAL-002-SCENARIO-ID-MISMATCH',
      `Plan scenarioId '${plan.scenarioId}' does not match source scenario '${sourceScenario?.metadata?.id}'.`,
      { scenarioId: plan.scenarioId }
    );
  }

  if (plan.targetFormat !== sourceScenario?.metadata?.targetFormat) {
    addError(
      'integrity',
      'VAL-002-TARGET-FORMAT-MISMATCH',
      `Plan targetFormat '${plan.targetFormat}' does not match source scenario '${sourceScenario?.metadata?.targetFormat}'.`,
      { scenarioId: plan.scenarioId }
    );
  }

  if (plan.projectId !== sourceScenario?.metadata?.projectId) {
    addError(
      'integrity',
      'VAL-002-PROJECT-ID-MISMATCH',
      `Plan projectId '${plan.projectId}' does not match source '${sourceScenario?.metadata?.projectId}'.`,
      { scenarioId: plan.scenarioId }
    );
  }

  // 2. Flattened vs nested cues consistency
  const cues = plan.cues || [];
  if (!Array.isArray(cues)) {
    addError('schema', 'VAL-003-CUES-ARRAY', 'plan.cues must be an array.', { scenarioId: plan.scenarioId });
    return {
      valid: false,
      errorCount: findings.filter(f => f.severity === 'error').length,
      warningCount: findings.filter(f => f.severity === 'warning').length,
      findings,
    };
  }

  if (plan.cueCount !== cues.length) {
    addError(
      'integrity',
      'VAL-004-CUE-COUNT-MISMATCH',
      `plan.cueCount (${plan.cueCount}) does not match cues array length (${cues.length}).`,
      { scenarioId: plan.scenarioId }
    );
  }

  // Check nested scenes match flattened cues
  const nestedCues = (plan.scenes || []).flatMap(s => s.cues || []);
  if (nestedCues.length !== cues.length) {
    addError(
      'integrity',
      'VAL-005-NESTED-CUES-MISMATCH',
      `Total cues in plan.scenes (${nestedCues.length}) does not match plan.cues length (${cues.length}).`,
      { scenarioId: plan.scenarioId }
    );
  }

  // Build audio clip lookup
  const clipMap = new Map<string, typeof audioPlan.clips[0]>();
  for (const clip of audioPlan?.clips || []) {
    clipMap.set(clip.clipId, clip);
  }

  // Build source turns lookup
  const sourceTurnMap = new Map<string, { sceneId: string; speakerId: string; spokenText: string; reactionTargetId?: string }>();
  for (const scene of sourceScenario?.scenes || []) {
    for (const turn of scene.turns || []) {
      sourceTurnMap.set(turn.id, {
        sceneId: scene.id,
        speakerId: turn.speakerId,
        spokenText: turn.spokenText,
        reactionTargetId: turn.reactionTargetId,
      });
    }
  }

  const seenCueIds = new Set<string>();
  const turnsInCues = new Map<string, ScenarioCaptionCue[]>();

  let previousCueEndTime = 0;

  // 3. Inspect individual cues
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const loc = {
      scenarioId: plan.scenarioId,
      sceneId: cue.sceneId,
      turnId: cue.turnId,
      clipId: cue.clipId,
      cueId: cue.id,
      speakerId: cue.speakerId,
    };

    // ID uniqueness
    if (!cue.id) {
      addError('integrity', 'VAL-006-CUE-ID-MISSING', `Cue at index ${i} has empty or missing id.`, loc);
    } else if (seenCueIds.has(cue.id)) {
      addError('integrity', 'VAL-006-CUE-ID-DUPLICATE', `Duplicate cue id '${cue.id}'.`, loc);
    } else {
      seenCueIds.add(cue.id);
    }

    // Sequence index
    if (cue.globalCueIndex !== i) {
      addError('integrity', 'VAL-007-GLOBAL-INDEX', `Cue '${cue.id}' globalCueIndex (${cue.globalCueIndex}) != index (${i}).`, loc);
    }

    // Spoken text presence
    if (!cue.text || !cue.text.trim()) {
      addError('text', 'VAL-008-EMPTY-TEXT', `Cue '${cue.id}' has empty text.`, loc);
    }

    // No invented speaker name labels in text (e.g. "Sarah: hello", "[Marcus] yes")
    if (/^[A-Za-z0-9_\-\s]+:\s+/i.test(cue.text) || /^\[[A-Za-z0-9_\-\s]+\]\s+/i.test(cue.text)) {
      addError('text', 'VAL-009-INVENTED-SPEAKER-LABEL', `Cue '${cue.id}' text appears to have invented speaker label prefix: '${cue.text}'.`, loc);
    }

    // Clip verification
    const clip = clipMap.get(cue.clipId);
    if (!clip) {
      addError('integrity', 'VAL-010-FOREIGN-CLIP', `Cue '${cue.id}' references clip '${cue.clipId}' not present in audioPlan.`, loc);
    } else {
      // Speaker metadata matches clip and turn
      if (cue.speakerId !== clip.speakerId) {
        addError('metadata', 'VAL-011-SPEAKER-MISMATCH', `Cue speaker '${cue.speakerId}' != clip speaker '${clip.speakerId}'.`, loc);
      }
      if (cue.voiceSlot !== clip.voiceSlot) {
        addError('metadata', 'VAL-012-VOICE-SLOT-MISMATCH', `Cue voiceSlot '${cue.voiceSlot}' != clip voiceSlot '${clip.voiceSlot}'.`, loc);
      }

      // Timing bounds: cue must stay inside [clip.startTimeSeconds, clip.endTimeSeconds]
      if (cue.startSeconds < clip.startTimeSeconds - 0.001) {
        addError(
          'timing',
          'VAL-013-CUE-BEFORE-CLIP',
          `Cue start (${cue.startSeconds}s) is before clip start (${clip.startTimeSeconds}s).`,
          loc
        );
      }

      // Must never exceed clip.endTimeSeconds (which would invade pauseAfterSeconds)
      if (cue.endSeconds > clip.endTimeSeconds + 0.001) {
        addError(
          'timing',
          'VAL-014-CUE-EXTENDS-INTO-PAUSE',
          `Cue end (${cue.endSeconds}s) exceeds clip spoken speech end (${clip.endTimeSeconds}s) into pause interval.`,
          loc
        );
      }
    }

    // Timing validity & monotonicity
    if (cue.startSeconds < 0 || cue.endSeconds <= cue.startSeconds) {
      addError('timing', 'VAL-015-INVALID-DURATION', `Cue duration is invalid (${cue.startSeconds}s -> ${cue.endSeconds}s).`, loc);
    }

    if (i > 0 && cue.startSeconds < previousCueEndTime - 0.001) {
      addError(
        'timing',
        'VAL-016-CUE-OVERLAP',
        `Cue start (${cue.startSeconds}s) overlaps with previous cue end (${previousCueEndTime}s).`,
        loc
      );
    }

    previousCueEndTime = cue.endSeconds;

    // Group by turn
    const turnGroup = turnsInCues.get(cue.turnId) || [];
    turnGroup.push(cue);
    turnsInCues.set(cue.turnId, turnGroup);
  }

  // 4. Cross-validate whole turns for exact text reconstruction
  for (const [turnId, srcTurn] of sourceTurnMap.entries()) {
    const turnCues = turnsInCues.get(turnId);
    if (!turnCues || turnCues.length === 0) {
      addError(
        'integrity',
        'VAL-017-MISSING-TURN',
        `Dialogue turn '${turnId}' has no caption cues in plan.`,
        { scenarioId: plan.scenarioId, turnId }
      );
      continue;
    }

    // Verify turn order
    for (let c = 0; c < turnCues.length; c++) {
      if (turnCues[c].cueIndex !== c) {
        addError('integrity', 'VAL-018-CUE-INDEX', `Cue '${turnCues[c].id}' has cueIndex ${turnCues[c].cueIndex} != ${c}.`, { turnId });
      }
      if (turnCues[c].totalCuesInTurn !== turnCues.length) {
        addError('integrity', 'VAL-018-TOTAL-CUES', `Cue '${turnCues[c].id}' totalCuesInTurn != ${turnCues.length}.`, { turnId });
      }
    }

    // Exact text reconstruction check
    const reconstructed = turnCues.map(c => c.text).join(' ').trim().replace(/\s+/g, ' ');
    const expected = srcTurn.spokenText.trim().replace(/\s+/g, ' ');

    if (reconstructed !== expected) {
      addError(
        'text',
        'VAL-019-TEXT-MISMATCH',
        `Reconstructed turn text does not match source spoken text. Expected: '${expected}', got: '${reconstructed}'.`,
        { scenarioId: plan.scenarioId, turnId }
      );
    }

    // One-word orphan fragment check
    const srcWords = expected.split(' ').filter(Boolean);
    if (srcWords.length > 1) {
      for (const cue of turnCues) {
        if (cue.wordCount === 1) {
          addError(
            'text',
            'VAL-020-ONE-WORD-ORPHAN',
            `Cue '${cue.id}' is an orphan single-word fragment ('${cue.text}') from a multi-word turn.`,
            { scenarioId: plan.scenarioId, turnId, cueId: cue.id }
          );
        }
      }
    }

    // Reacting character metadata check
    if (srcTurn.reactionTargetId) {
      for (const cue of turnCues) {
        if (cue.reactingCharacterId !== srcTurn.reactionTargetId) {
          addError(
            'metadata',
            'VAL-021-REACTING-CHAR-MISMATCH',
            `Cue reactingCharacterId '${cue.reactingCharacterId}' != expected '${srcTurn.reactionTargetId}'.`,
            { turnId, cueId: cue.id }
          );
        }
      }
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
