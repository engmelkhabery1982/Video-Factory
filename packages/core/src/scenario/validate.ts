/**
 * BuildTrack Video Factory - Phase 3A Scenario Deterministic Validator
 *
 * Enforces schema integrity, narrative completeness, evidence consistency,
 * duration limits, and diversity without external or AI dependencies.
 */

import { Scenario, SCENARIO_SCHEMA_VERSION } from './types.js';
import { estimateScenarioDuration, DEFAULT_DURATION_CONFIG } from './duration.js';
import { analyzeScenarioDiversity } from './diversity.js';

export type ValidationSeverity = 'error' | 'warning';

export type ValidationCategory =
  | 'schema'
  | 'integrity'
  | 'narrative'
  | 'timing'
  | 'diversity'
  | 'evidence'
  | 'security';

export interface ValidationFinding {
  severity: ValidationSeverity;
  category: ValidationCategory;
  ruleId: string;
  message: string;
  location: {
    scenarioId?: string;
    sceneId?: string;
    sceneIndex?: number;
    turnId?: string;
    characterId?: string;
    evidenceId?: string;
  };
}

export interface ValidationReport {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  findings: ValidationFinding[];
  summary: {
    totalScenes: number;
    totalTurns: number;
    totalCharacters: number;
    totalEvidence: number;
    targetFormat: string;
    estimatedDuration: number;
  };
}

const FORBIDDEN_SECURITY_PATTERNS = [
  /api[_-]?key/i,
  /bearer\s+[a-z0-9_\-\.]{10,}/i,
  /sk-[a-zA-Z0-9_\-]{16,}/,
  /(?:\/etc\/|\/root\/|\/var\/|\/tmp\/|[a-zA-Z]:\\)/,
  /file:\/\/\//i,
];

const CTA_DISGUISE_PATTERNS = [
  /subscribe/i,
  /sign\s+up/i,
  /click\s+the\s+link/i,
  /register\s+now/i,
  /visit\s+our\s+website/i,
  /book\s+a\s+demo/i,
  /download\s+today/i,
];

/**
 * Validates a Scenario document deterministically.
 */
export function validateScenario(scenario: Scenario): ValidationReport {
  const findings: ValidationFinding[] = [];

  const addError = (category: ValidationCategory, ruleId: string, message: string, loc: ValidationFinding['location'] = {}) => {
    findings.push({ severity: 'error', category, ruleId, message, location: loc });
  };

  const addWarning = (category: ValidationCategory, ruleId: string, message: string, loc: ValidationFinding['location'] = {}) => {
    findings.push({ severity: 'warning', category, ruleId, message, location: loc });
  };

  if (!scenario || typeof scenario !== 'object') {
    return {
      valid: false,
      errorCount: 1,
      warningCount: 0,
      findings: [{
        severity: 'error',
        category: 'schema',
        ruleId: 'RULE-000-INVALID-OBJECT',
        message: 'Scenario document must be a non-null object.',
        location: {},
      }],
      summary: { totalScenes: 0, totalTurns: 0, totalCharacters: 0, totalEvidence: 0, targetFormat: 'unknown', estimatedDuration: 0 },
    };
  }

  const scenarioId = scenario.metadata?.id || 'unknown';

  // 1. Schema version
  const schemaVer = scenario.metadata?.schemaVersion;
  if (!schemaVer) {
    addError('schema', 'RULE-001-SCHEMA-VERSION', 'Missing metadata.schemaVersion.', { scenarioId });
  } else if (!schemaVer.startsWith('1.')) {
    addError('schema', 'RULE-001-SCHEMA-VERSION', `Unsupported schema version '${schemaVer}'. Expected 1.x.x.`, { scenarioId });
  }

  // 2. Character validation
  const characters = scenario.characters || [];
  if (!Array.isArray(characters) || characters.length === 0) {
    addError('integrity', 'RULE-005-CHARACTERS-REQUIRED', 'Scenario must define at least one character.', { scenarioId });
  }

  const characterIdSet = new Set<string>();
  for (const char of characters) {
    if (!char.id) {
      addError('integrity', 'RULE-002-UNIQUE-IDS', 'Character has empty or missing id.', { scenarioId });
    } else if (characterIdSet.has(char.id)) {
      addError('integrity', 'RULE-002-UNIQUE-IDS', `Duplicate character id '${char.id}'.`, { scenarioId, characterId: char.id });
    } else {
      characterIdSet.add(char.id);
    }

    if (!char.name || !char.name.trim()) {
      addError('schema', 'RULE-002-CHARACTER-NAME', `Character '${char.id}' must have a non-empty name.`, { scenarioId, characterId: char.id });
    }
    if (!char.role || !char.role.trim()) {
      addError('schema', 'RULE-002-CHARACTER-ROLE', `Character '${char.id}' must have a professional role.`, { scenarioId, characterId: char.id });
    }
  }

  // 3. Evidence validation
  const evidenceList = scenario.evidence || [];
  const evidenceIdSet = new Set<string>();
  for (const ev of evidenceList) {
    if (!ev.id) {
      addError('integrity', 'RULE-002-UNIQUE-IDS', 'Evidence has empty or missing id.', { scenarioId });
    } else if (evidenceIdSet.has(ev.id)) {
      addError('integrity', 'RULE-002-UNIQUE-IDS', `Duplicate evidence id '${ev.id}'.`, { scenarioId, evidenceId: ev.id });
    } else {
      evidenceIdSet.add(ev.id);
    }

    if (!ev.claim || !ev.claim.trim()) {
      addError('evidence', 'RULE-004-EVIDENCE-CLAIM', `Evidence '${ev.id}' must have a non-empty claim.`, { scenarioId, evidenceId: ev.id });
    }

    // Rule 20: CTA disguised as evidence
    if (ev.evidenceType?.toLowerCase() === 'cta' || CTA_DISGUISE_PATTERNS.some(pat => pat.test(ev.claim))) {
      addError('evidence', 'RULE-020-CTA-AS-EVIDENCE', `Evidence '${ev.id}' appears to be a promotional CTA rather than factual workplace evidence.`, { scenarioId, evidenceId: ev.id });
    }
  }

  // 4. Locations validation
  const locations = scenario.locations || [];
  const locationIdSet = new Set<string>(locations.map(l => l.id));

  // 5. Scenes validation
  const scenes = scenario.scenes || [];
  if (!Array.isArray(scenes) || scenes.length === 0) {
    addError('narrative', 'RULE-006-SCENES-REQUIRED', 'Scenario must define at least one scene.', { scenarioId });
  }

  const sceneIdSet = new Set<string>();
  const turnIdSet = new Set<string>();
  let lastIndex = -1;
  let totalTurnsCount = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const sceneLoc = { scenarioId, sceneId: scene.id, sceneIndex: scene.index };

    // Unique scene id
    if (!scene.id) {
      addError('integrity', 'RULE-002-UNIQUE-IDS', `Scene at index ${i} has empty or missing id.`, sceneLoc);
    } else if (sceneIdSet.has(scene.id)) {
      addError('integrity', 'RULE-002-UNIQUE-IDS', `Duplicate scene id '${scene.id}'.`, sceneLoc);
    } else {
      sceneIdSet.add(scene.id);
    }

    // Rule 10: Scene index order
    if (typeof scene.index !== 'number' || (lastIndex !== -1 && scene.index !== lastIndex + 1 && scene.index <= lastIndex)) {
      addError('integrity', 'RULE-010-SCENE-ORDER', `Scene index ${scene.index} is out of sequence (previous was ${lastIndex}).`, sceneLoc);
    }
    lastIndex = scene.index;

    // Rule 11: Estimated duration positive
    if (typeof scene.estimatedDuration !== 'number' || scene.estimatedDuration <= 0) {
      addError('timing', 'RULE-011-POSITIVE-DURATION', `Scene '${scene.id}' estimatedDuration must be greater than zero.`, sceneLoc);
    }

    // Check location reference
    if (scene.locationId && !locationIdSet.has(scene.locationId) && locations.length > 0) {
      addWarning('integrity', 'RULE-003-LOCATION-REF', `Scene '${scene.id}' references undeclared location '${scene.locationId}'.`, sceneLoc);
    }

    // Check participant references
    const participantSet = new Set<string>();
    for (const pId of scene.participantIds || []) {
      if (!characterIdSet.has(pId)) {
        addError('integrity', 'RULE-003-PARTICIPANT-EXISTS', `Scene '${scene.id}' references non-existent character '${pId}'.`, { ...sceneLoc, characterId: pId });
      } else {
        participantSet.add(pId);
      }
    }

    // Rule 6: Scene contains meaningful content
    const turns = scene.turns || [];
    if (turns.length === 0 && !scene.production?.screenInsert && !scene.production?.bRollIntent) {
      addError('narrative', 'RULE-006-SCENE-MEANINGFUL', `Scene '${scene.id}' has neither dialogue turns nor visual production direction.`, sceneLoc);
    }

    // Track active speakers in this scene
    const activeSpeakersInScene = new Set<string>();

    // Turns validation
    for (const turn of turns) {
      totalTurnsCount++;
      const turnLoc = { ...sceneLoc, turnId: turn.id, characterId: turn.speakerId };

      if (!turn.id) {
        addError('integrity', 'RULE-002-UNIQUE-IDS', `Dialogue turn in scene '${scene.id}' has missing id.`, turnLoc);
      } else if (turnIdSet.has(turn.id)) {
        addError('integrity', 'RULE-002-UNIQUE-IDS', `Duplicate dialogue turn id '${turn.id}'.`, turnLoc);
      } else {
        turnIdSet.add(turn.id);
      }

      // Rule 3 & 19: Valid speaker and speaker in participantIds
      if (!turn.speakerId) {
        addError('integrity', 'RULE-003-SPEAKER-EXISTS', `Dialogue turn '${turn.id}' has no speakerId.`, turnLoc);
      } else if (!characterIdSet.has(turn.speakerId)) {
        addError('integrity', 'RULE-003-SPEAKER-EXISTS', `Dialogue turn '${turn.id}' references non-existent speaker '${turn.speakerId}'.`, turnLoc);
      } else {
        activeSpeakersInScene.add(turn.speakerId);
        if (!participantSet.has(turn.speakerId)) {
          addError('integrity', 'RULE-019-SPEAKER-IN-PARTICIPANTS', `Speaker '${turn.speakerId}' in turn '${turn.id}' is not listed in scene.participantIds.`, turnLoc);
        }
      }

      // Rule 7: Non-empty spoken text
      if (!turn.spokenText || !turn.spokenText.trim()) {
        addError('schema', 'RULE-007-NONEMPTY-DIALOGUE', `Dialogue turn '${turn.id}' has empty spoken text.`, turnLoc);
      }

      // Rule 4: Valid evidence reference
      if (turn.evidenceId) {
        if (!evidenceIdSet.has(turn.evidenceId)) {
          addError('evidence', 'RULE-004-EVIDENCE-REF', `Turn '${turn.id}' references non-existent evidence '${turn.evidenceId}'.`, { ...turnLoc, evidenceId: turn.evidenceId });
        } else {
          // Rule 13: Numeric fact preservation in dialogue
          const ev = evidenceList.find(e => e.id === turn.evidenceId);
          if (ev && ev.numericFacts && ev.numericFacts.length > 0) {
            for (const fact of ev.numericFacts) {
              const valStr = fact.value.toString();
              if (!turn.spokenText.includes(valStr)) {
                addWarning(
                  'evidence',
                  'RULE-013-NUMERIC-FACT-PRESERVED',
                  `Turn '${turn.id}' cites evidence '${ev.id}' but spoken text omits the exact numeric figure '${valStr}'.`,
                  { ...turnLoc, evidenceId: ev.id }
                );
              }
            }
          }
        }
      }

      // Security check (Rule 14)
      const textToCheck = `${turn.spokenText} ${turn.onScreenText || ''}`;
      for (const pat of FORBIDDEN_SECURITY_PATTERNS) {
        if (pat.test(textToCheck)) {
          addError('security', 'RULE-014-FORBIDDEN-PATH-SECRET', `Dialogue turn '${turn.id}' contains forbidden sensitive pattern or absolute filesystem path.`, turnLoc);
        }
      }
    }

    // Rule 18: Unused participants in scene
    for (const pId of scene.participantIds || []) {
      if (!activeSpeakersInScene.has(pId)) {
        const isReactionTarget = turns.some(t => t.reactionTargetId === pId);
        const isFocus = scene.production?.speakerFocus === 'group' || scene.production?.speakerFocus === 'reacting_character';
        if (!isReactionTarget && !isFocus && turns.length > 0) {
          addWarning(
            'narrative',
            'RULE-018-UNUSED-PARTICIPANT',
            `Character '${pId}' is listed as participant in scene '${scene.id}' but never speaks or receives visual focus.`,
            { ...sceneLoc, characterId: pId }
          );
        }
      }
    }
  }

  // Rule 8: First narrative section contains a hook
  if (scenes.length > 0) {
    const firstScene = scenes[0];
    if (firstScene.narrativePurpose !== 'hook') {
      addError('narrative', 'RULE-008-FIRST-SCENE-HOOK', `First scene '${firstScene.id}' must have narrativePurpose 'hook' (found '${firstScene.narrativePurpose}').`, { scenarioId, sceneId: firstScene.id, sceneIndex: firstScene.index });
    }
  }

  // Rule 9: Final narrative section contains CTA
  const targetFormat = scenario.metadata?.targetFormat || 'Long';
  if (scenes.length > 0 && (targetFormat === 'Long' || targetFormat === 'Short')) {
    const lastScene = scenes[scenes.length - 1];
    const hasCtaPurpose = lastScene.narrativePurpose === 'cta';
    const hasCtaTurn = (lastScene.turns || []).some(t => t.intent === 'call_to_action');
    if (!hasCtaPurpose && !hasCtaTurn) {
      addError('narrative', 'RULE-009-FINAL-SCENE-CTA', `Final scene '${lastScene.id}' in ${targetFormat} video must contain a clear CTA (narrativePurpose 'cta' or turn intent 'call_to_action').`, { scenarioId, sceneId: lastScene.id, sceneIndex: lastScene.index });
    }
  }

  // Duration & Target Bounds (Rules 12, 21, 22)
  const durationEstimate = estimateScenarioDuration(scenario, DEFAULT_DURATION_CONFIG);
  const totalDuration = durationEstimate.totalSeconds;

  if (targetFormat === 'Short') {
    if (totalDuration > 65) {
      addError('timing', 'RULE-021-SHORT-DURATION-CEILING', `Short scenario duration estimate (${totalDuration.toFixed(1)}s) exceeds hard limit of 65.0s.`, { scenarioId });
    } else if (totalDuration > 60) {
      addWarning('timing', 'RULE-021-SHORT-DURATION-CEILING', `Short scenario duration estimate (${totalDuration.toFixed(1)}s) exceeds target of 60.0s.`, { scenarioId });
    }
    if (scenes.length > 7) {
      addWarning('narrative', 'RULE-021-SHORT-CONCISE-SCENES', `Short scenario has ${scenes.length} scenes; consider 3-5 scenes for concise pacing.`, { scenarioId });
    }
  } else if (targetFormat === 'Long') {
    if (totalDuration < 30) {
      addWarning('timing', 'RULE-022-LONG-DURATION-FLOOR', `Long scenario duration estimate (${totalDuration.toFixed(1)}s) is brief for a long-form video.`, { scenarioId });
    }
  }

  // Target duration range match if specified
  const metaTarget = scenario.metadata?.estimatedDuration?.targetSeconds;
  if (metaTarget && metaTarget > 0) {
    const diff = Math.abs(totalDuration - metaTarget);
    if (diff > Math.max(15, metaTarget * 0.35)) {
      addWarning(
        'timing',
        'RULE-012-TARGET-DURATION-MATCH',
        `Estimated duration (${totalDuration.toFixed(1)}s) diverges significantly from targetSeconds (${metaTarget}s).`,
        { scenarioId }
      );
    }
  }

  // Diversity & Repetition (Rules 15, 16, 17)
  const diversityReport = analyzeScenarioDiversity(scenario);

  // Rule 15: Uninterrupted consecutive monologue turns
  for (const run of diversityReport.consecutiveSpeakerRuns) {
    if (run.count > 2 && !run.isJustified) {
      addError(
        'diversity',
        'RULE-015-EXCESSIVE-MONOLOGUE',
        `Character '${run.value}' speaks ${run.count} consecutive uninterrupted turns without an explicit monologueReason.`,
        { scenarioId, ...run.locations[0] }
      );
    }
  }

  // Rule 16: Repeated dialogue sentence
  for (const rep of diversityReport.repeatedSentences) {
    addError(
      'diversity',
      'RULE-016-REPEATED-SENTENCE',
      `Identical substantive sentence repeated across multiple dialogue turns: "${rep.sentence}".`,
      { scenarioId, sceneId: rep.occurrences[0].sceneId, turnId: rep.occurrences[0].turnId }
    );
  }

  // Rule 17: Repeated shot choices
  for (const shotRun of diversityReport.repeatedShotRuns) {
    if (shotRun.count > 3 && !shotRun.isJustified) {
      addWarning(
        'diversity',
        'RULE-017-REPEATED-SHOT',
        `Shot type '${shotRun.value}' is repeated across ${shotRun.count} consecutive scenes without justification.`,
        { scenarioId, sceneId: shotRun.locations[0].sceneId }
      );
    }
  }

  // Repeated setting choices across full scenario
  for (const setRun of diversityReport.repeatedSettingRuns) {
    if (setRun.count > 4 && !setRun.isJustified) {
      addWarning(
        'diversity',
        'RULE-017-REPEATED-SETTING',
        `Setting '${setRun.value}' is held continuously across ${setRun.count} consecutive scenes without justification.`,
        { scenarioId, sceneId: setRun.locations[0].sceneId }
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
    summary: {
      totalScenes: scenes.length,
      totalTurns: totalTurnsCount,
      totalCharacters: characters.length,
      totalEvidence: evidenceList.length,
      targetFormat,
      estimatedDuration: totalDuration,
    },
  };
}
