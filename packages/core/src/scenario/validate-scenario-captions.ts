/** Deterministic, source-backed validation for Phase 3E caption plans. */
import type { Scenario } from './types.js';
import type { DialogueAudioPlan } from './dialogue-audio-types.js';
import { validateScenario } from './validate.js';
import { validateDialogueAudioPlan } from './validate-dialogue-audio-plan.js';
import {
  SCENARIO_CAPTION_PLAN_SCHEMA_VERSION,
  scenarioCaptionCueId,
  type ScenarioCaptionCue,
  type ScenarioCaptionFinding,
  type ScenarioCaptionPlan,
  type ScenarioCaptionValidationReport,
} from './scenario-caption-types.js';

const EPS = 0.001;
const ABSOLUTE_PATH = /(^|[\s"'(])(\/(?:home|root|etc|var|tmp|usr|Users|mnt|opt)\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\|file:\/\/)/;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const normalized = (value: string): string => value.trim().replace(/\s+/g, ' ');
const words = (value: string): string[] => normalized(value).split(' ').filter(Boolean);

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, output));
}

export function validateScenarioCaptionPlan(
  plan: ScenarioCaptionPlan,
  sourceScenario: Scenario,
  audioPlan: DialogueAudioPlan,
): ScenarioCaptionValidationReport {
  const findings: ScenarioCaptionFinding[] = [];
  const add = (severity: ScenarioCaptionFinding['severity'], category: ScenarioCaptionFinding['category'], ruleId: string, message: string, location?: ScenarioCaptionFinding['location']) => findings.push({ severity, category, ruleId, message, location });
  const err = (category: ScenarioCaptionFinding['category'], ruleId: string, message: string, location?: ScenarioCaptionFinding['location']) => add('error', category, ruleId, message, location);
  const warn = (category: ScenarioCaptionFinding['category'], ruleId: string, message: string, location?: ScenarioCaptionFinding['location']) => add('warning', category, ruleId, message, location);
  const done = (): ScenarioCaptionValidationReport => {
    const errorCount = findings.filter((finding) => finding.severity === 'error').length;
    return { valid: errorCount === 0, errorCount, warningCount: findings.length - errorCount, findings };
  };

  if (!plan || typeof plan !== 'object') {
    err('schema', 'VAL-000-INVALID-PLAN', 'ScenarioCaptionPlan must be a non-null object.');
    return done();
  }
  if (!sourceScenario || typeof sourceScenario !== 'object' || !audioPlan || typeof audioPlan !== 'object') {
    err('schema', 'VAL-000-INVALID-SOURCE', 'Source Scenario and DialogueAudioPlan must be non-null objects.');
    return done();
  }

  try {
    if (!validateScenario(sourceScenario).valid) err('integrity', 'VAL-000-SOURCE-SCENARIO', 'Source Scenario is invalid.');
    if (!validateDialogueAudioPlan(audioPlan, sourceScenario).valid) err('integrity', 'VAL-000-SOURCE-AUDIO', 'DialogueAudioPlan is invalid or does not match the source Scenario.');
  } catch (error) {
    err('schema', 'VAL-000-SOURCE-UNREADABLE', `Source validation failed: ${error instanceof Error ? error.message : String(error)}`);
    return done();
  }

  const meta = sourceScenario.metadata;
  if (plan.schemaVersion !== SCENARIO_CAPTION_PLAN_SCHEMA_VERSION) err('schema', 'VAL-001-SCHEMA-VERSION', `Unsupported schemaVersion '${plan.schemaVersion}'.`, { scenarioId: plan.scenarioId });
  if (plan.scenarioId !== meta.id || plan.scenarioId !== audioPlan.scenarioId) err('integrity', 'VAL-002-SCENARIO-ID-MISMATCH', 'Plan scenarioId does not match both sources.', { scenarioId: plan.scenarioId });
  if (plan.projectId !== meta.projectId || plan.projectId !== audioPlan.projectId) err('integrity', 'VAL-002-PROJECT-ID-MISMATCH', 'Plan projectId does not match both sources.', { scenarioId: plan.scenarioId });
  if (plan.targetFormat !== meta.targetFormat || plan.targetFormat !== audioPlan.targetFormat) err('integrity', 'VAL-002-TARGET-FORMAT-MISMATCH', 'Plan targetFormat does not match both sources.', { scenarioId: plan.scenarioId });
  if (plan.language !== meta.language || plan.language !== audioPlan.language) err('metadata', 'VAL-002-LANGUAGE-MISMATCH', 'Plan language does not match both sources.', { scenarioId: plan.scenarioId });
  if (plan.direction !== 'ltr' && plan.direction !== 'rtl') err('metadata', 'VAL-002-DIRECTION', 'Plan direction must be ltr or rtl.', { scenarioId: plan.scenarioId });
  if (!plan.profile || plan.profile.targetFormat !== plan.targetFormat || !Number.isInteger(plan.profile.maxLines) || plan.profile.maxLines < 1 || !Number.isInteger(plan.profile.maxCharsPerLine) || plan.profile.maxCharsPerLine < 8 || !Number.isInteger(plan.profile.maxCharsPerCue) || plan.profile.maxCharsPerCue < 8) err('metadata', 'VAL-002-PROFILE', 'Caption profile is missing, malformed, or belongs to another format.', { scenarioId: plan.scenarioId });
  if (!finite(plan.totalDurationSeconds) || Math.abs(plan.totalDurationSeconds - audioPlan.totalDurationSeconds) > EPS) err('timing', 'VAL-002-TOTAL-DURATION', 'Plan totalDurationSeconds differs from the audio plan.', { scenarioId: plan.scenarioId });
  if (!finite(plan.totalSpeechDurationSeconds) || Math.abs(plan.totalSpeechDurationSeconds - audioPlan.totalSpeechDurationSeconds) > EPS) err('timing', 'VAL-002-SPEECH-DURATION', 'Plan totalSpeechDurationSeconds differs from the audio plan.', { scenarioId: plan.scenarioId });

  const expectedSpeakers = audioPlan.characters.map((audioCharacter) => {
    const character = sourceScenario.characters.find((candidate) => candidate.id === audioCharacter.characterId);
    return { speakerId: audioCharacter.characterId, name: character?.name ?? audioCharacter.name, role: character?.role ?? audioCharacter.role, voiceSlot: audioCharacter.voiceSlot };
  });
  if (!Array.isArray(plan.speakers) || !same(plan.speakers, expectedSpeakers)) err('metadata', 'VAL-003-SPEAKERS', 'Speaker manifest differs from the source Scenario or audio plan.', { scenarioId: plan.scenarioId });

  const cues = Array.isArray(plan.cues) ? plan.cues : [];
  if (!Array.isArray(plan.cues)) err('schema', 'VAL-003-CUES-ARRAY', 'plan.cues must be an array.', { scenarioId: plan.scenarioId });
  if (plan.cueCount !== cues.length) err('integrity', 'VAL-004-CUE-COUNT-MISMATCH', `plan.cueCount (${plan.cueCount}) does not match cues length (${cues.length}).`, { scenarioId: plan.scenarioId });
  if (!Array.isArray(plan.scenes)) err('schema', 'VAL-005-SCENES-ARRAY', 'plan.scenes must be an array.', { scenarioId: plan.scenarioId });

  const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
  if (scenes.length !== sourceScenario.scenes.length || scenes.length !== audioPlan.scenes.length) err('integrity', 'VAL-005-SCENE-COUNT', 'Caption scene count differs from the source plans.', { scenarioId: plan.scenarioId });
  const nestedCues: ScenarioCaptionCue[] = [];
  scenes.forEach((scene, index) => {
    const source = sourceScenario.scenes[index];
    const audio = audioPlan.scenes[index];
    const loc = { scenarioId: plan.scenarioId, sceneId: source?.id ?? scene?.sceneId };
    if (!source || !audio || scene?.sceneId !== source.id || scene.sceneId !== audio.sceneId || scene.sceneIndex !== index) err('integrity', 'VAL-005-SCENE-ORDER', `Caption scene ${index} does not match the source scene order.`, loc);
    if (source && (scene.title ?? null) !== (source.title ?? null)) err('metadata', 'VAL-005-SCENE-TITLE', `Caption scene '${source.id}' title differs from the source.`, loc);
    if (audio && (!finite(scene.startSeconds) || !finite(scene.endSeconds) || Math.abs(scene.startSeconds - audio.startTimeSeconds) > EPS || Math.abs(scene.endSeconds - audio.endTimeSeconds) > EPS)) err('timing', 'VAL-005-SCENE-TIMING', `Caption scene '${scene.sceneId}' timing differs from the audio scene.`, loc);
    if (!Array.isArray(scene?.cues)) err('schema', 'VAL-005-SCENE-CUES', `Caption scene '${scene?.sceneId}' cues must be an array.`, loc);
    else nestedCues.push(...scene.cues);
  });
  if (!same(nestedCues, cues)) err('integrity', 'VAL-005-NESTED-CUES-MISMATCH', 'Nested scene cues do not exactly match the flattened cue list.', { scenarioId: plan.scenarioId });

  const clipById = new Map(audioPlan.clips.map((clip) => [clip.clipId, clip] as const));
  const clipByTurn = new Map(audioPlan.clips.map((clip) => [clip.turnId, clip] as const));
  const sourceTurns = sourceScenario.scenes.flatMap((scene, sceneIndex) => scene.turns.map((turn, turnIndex) => ({ scene, sceneIndex, turn, turnIndex })));
  const sourceByTurn = new Map(sourceTurns.map((entry) => [entry.turn.id, entry] as const));
  const turnCues = new Map<string, ScenarioCaptionCue[]>();
  const seenIds = new Set<string>();
  let previousEnd = 0;

  cues.forEach((cue, globalIndex) => {
    const loc = { scenarioId: plan.scenarioId, sceneId: cue?.sceneId, turnId: cue?.turnId, clipId: cue?.clipId, cueId: cue?.id, speakerId: cue?.speakerId };
    if (!cue || typeof cue !== 'object') return err('schema', 'VAL-006-CUE-MALFORMED', `Cue ${globalIndex} is malformed.`, loc);
    if (!cue.id || seenIds.has(cue.id)) err('integrity', 'VAL-006-CUE-ID-DUPLICATE', `Cue '${cue.id}' has a missing or duplicate ID.`, loc);
    else seenIds.add(cue.id);
    if (cue.globalCueIndex !== globalIndex) err('integrity', 'VAL-007-GLOBAL-INDEX', `Cue '${cue.id}' has an invalid globalCueIndex.`, loc);
    if (!cue.text?.trim()) err('text', 'VAL-008-EMPTY-TEXT', `Cue '${cue.id}' has empty text.`, loc);

    const source = sourceByTurn.get(cue.turnId);
    const clip = clipById.get(cue.clipId);
    if (!source) err('integrity', 'VAL-009-FOREIGN-TURN', `Cue '${cue.id}' references foreign turn '${cue.turnId}'.`, loc);
    if (!clip) err('integrity', 'VAL-010-FOREIGN-CLIP', `Cue '${cue.id}' references foreign clip '${cue.clipId}'.`, loc);
    if (source && clip) {
      if (clip.turnId !== source.turn.id || clipByTurn.get(source.turn.id)?.clipId !== clip.clipId) err('integrity', 'VAL-010-WRONG-CLIP', `Cue '${cue.id}' does not reference the source turn's audio clip.`, loc);
      if (cue.scenarioId !== plan.scenarioId || cue.sceneId !== source.scene.id || cue.sceneIndex !== source.sceneIndex || cue.turnIndex !== source.turnIndex) err('integrity', 'VAL-011-SOURCE-LOCATION', `Cue '${cue.id}' source location metadata is wrong.`, loc);
      if (cue.speakerId !== source.turn.speakerId || cue.speakerId !== clip.speakerId) err('metadata', 'VAL-011-SPEAKER-MISMATCH', `Cue '${cue.id}' speaker differs from its sources.`, loc);
      if (cue.voiceSlot !== clip.voiceSlot) err('metadata', 'VAL-012-VOICE-SLOT-MISMATCH', `Cue '${cue.id}' voiceSlot differs from the audio clip.`, loc);
      if ((cue.reactingCharacterId ?? null) !== (source.turn.reactionTargetId ?? null)) err('metadata', 'VAL-021-REACTING-CHAR-MISMATCH', `Cue '${cue.id}' reacting character differs from the source.`, loc);
      if (cue.intent !== source.turn.intent || !same(cue.delivery, source.turn.delivery)) err('metadata', 'VAL-012-TURN-DIRECTION', `Cue '${cue.id}' intent or delivery differs from the source.`, loc);
      if (cue.targetFormat !== plan.targetFormat || cue.direction !== plan.direction) err('metadata', 'VAL-012-CUE-FORMAT', `Cue '${cue.id}' format or direction differs from the plan.`, loc);
      if (cue.id !== scenarioCaptionCueId(source.scene.id, source.turn.id, cue.cueIndex)) err('integrity', 'VAL-012-UNSTABLE-ID', `Cue '${cue.id}' is not derived from its source IDs.`, loc);

      const sourceWords = words(source.turn.spokenText);
      if (!Number.isInteger(cue.sourceWordStart) || !Number.isInteger(cue.sourceWordEnd) || cue.sourceWordStart < 0 || cue.sourceWordEnd <= cue.sourceWordStart || cue.sourceWordEnd > sourceWords.length) err('text', 'VAL-012-SOURCE-OFFSETS', `Cue '${cue.id}' has invalid source word offsets.`, loc);
      else {
        const expectedText = sourceWords.slice(cue.sourceWordStart, cue.sourceWordEnd).join(' ');
        if (cue.text !== expectedText || cue.wordCount !== cue.sourceWordEnd - cue.sourceWordStart) err('text', 'VAL-019-TEXT-MISMATCH', `Cue '${cue.id}' text or word count differs from its source offsets.`, loc);
        const genericLabel = /^(?:[A-Za-z0-9_\- ]+|\[[A-Za-z0-9_\- ]+\]):\s+/;
        if (genericLabel.test(cue.text) && !genericLabel.test(expectedText)) err('text', 'VAL-009-INVENTED-SPEAKER-LABEL', `Cue '${cue.id}' contains an invented speaker label.`, loc);
      }
      if (cue.wordCount === 1 && sourceWords.length > 1) err('text', 'VAL-020-ONE-WORD-ORPHAN', `Cue '${cue.id}' is a one-word orphan from a multi-word turn.`, loc);

      if (!finite(cue.startSeconds) || !finite(cue.endSeconds) || cue.endSeconds <= cue.startSeconds) err('timing', 'VAL-015-INVALID-DURATION', `Cue '${cue.id}' has invalid timing.`, loc);
      if (cue.startSeconds < clip.startTimeSeconds - EPS) err('timing', 'VAL-013-CUE-BEFORE-CLIP', `Cue '${cue.id}' starts before its audio clip.`, loc);
      if (cue.endSeconds > clip.endTimeSeconds + EPS) err('timing', 'VAL-014-CUE-EXTENDS-INTO-PAUSE', `Cue '${cue.id}' extends beyond spoken audio into the pause.`, loc);
      if (!finite(cue.durationSeconds) || Math.abs(cue.durationSeconds - (cue.endSeconds - cue.startSeconds)) > EPS) err('timing', 'VAL-015-DURATION-MISMATCH', `Cue '${cue.id}' duration does not equal end minus start.`, loc);
      if (!Array.isArray(cue.lines) || normalized(cue.lines.join(' ')) !== normalized(cue.text) || cue.lines.length > plan.profile.maxLines) err('text', 'VAL-015-LINES', `Cue '${cue.id}' display lines do not preserve its text or line budget.`, loc);
      else if (cue.lines.some((line) => line.length > plan.profile.maxCharsPerLine)) warn('text', 'VAL-015-LINE-LENGTH', `Cue '${cue.id}' contains a line longer than the profile budget.`, loc);
    }

    if (globalIndex > 0 && finite(cue.startSeconds) && cue.startSeconds < previousEnd - EPS) err('timing', 'VAL-016-CUE-OVERLAP', `Cue '${cue.id}' overlaps the previous cue.`, loc);
    if (finite(cue.endSeconds)) previousEnd = cue.endSeconds;
    const group = turnCues.get(cue.turnId) ?? [];
    group.push(cue);
    turnCues.set(cue.turnId, group);
  });

  for (const { turn, scene } of sourceTurns) {
    const group = turnCues.get(turn.id) ?? [];
    const clip = clipByTurn.get(turn.id);
    const loc = { scenarioId: plan.scenarioId, sceneId: scene.id, turnId: turn.id, clipId: clip?.clipId };
    if (!group.length) {
      err('integrity', 'VAL-017-MISSING-TURN', `Dialogue turn '${turn.id}' has no caption cues.`, loc);
      continue;
    }
    group.forEach((cue, index) => {
      if (cue.cueIndex !== index || cue.totalCuesInTurn !== group.length) err('integrity', 'VAL-018-CUE-INDEX', `Cue '${cue.id}' has invalid turn-local indices.`, loc);
      const expectedStart = index === 0 ? 0 : group[index - 1].sourceWordEnd;
      if (cue.sourceWordStart !== expectedStart) err('text', 'VAL-018-OFFSET-GAP', `Cue '${cue.id}' source offsets leave a gap or overlap.`, loc);
      if (index > 0 && cue.startSeconds < group[index - 1].endSeconds - EPS) err('timing', 'VAL-016-CUE-OVERLAP', `Cue '${cue.id}' overlaps the previous cue in its turn.`, loc);
    });
    const sourceWords = words(turn.spokenText);
    if (group[group.length - 1].sourceWordEnd !== sourceWords.length || normalized(group.map((cue) => cue.text).join(' ')) !== normalized(turn.spokenText)) err('text', 'VAL-019-TEXT-MISMATCH', `Turn '${turn.id}' captions do not reconstruct the source text exactly.`, loc);
    if (clip && (Math.abs(group[0].startSeconds - clip.startTimeSeconds) > EPS || Math.abs(group[group.length - 1].endSeconds - clip.endTimeSeconds) > EPS)) err('timing', 'VAL-019-CLIP-COVERAGE', `Turn '${turn.id}' captions do not cover exactly the spoken interval.`, loc);
  }

  for (const clip of audioPlan.clips) if (!turnCues.has(clip.turnId)) err('integrity', 'VAL-022-MISSING-CLIP-CAPTIONS', `Audio clip '${clip.clipId}' has no captions.`, { scenarioId: plan.scenarioId, sceneId: clip.sceneId, turnId: clip.turnId, clipId: clip.clipId });
  const totalWords = cues.reduce((sum, cue) => sum + (Number.isInteger(cue.wordCount) ? cue.wordCount : 0), 0);
  if (plan.totalWordCount !== totalWords) err('integrity', 'VAL-023-WORD-TOTAL', 'Plan totalWordCount does not match its cues.', { scenarioId: plan.scenarioId });

  const strings: string[] = [];
  collectStrings(plan, strings);
  for (const value of strings) if (ABSOLUTE_PATH.test(value)) err('path', 'VAL-024-ABSOLUTE-PATH', `Caption plan contains an absolute filesystem path: '${value.slice(0, 80)}'.`, { scenarioId: plan.scenarioId });

  return done();
}
