import { describe, expect, it } from 'vitest';
import { getProgressMeetingScenario, getScheduleRiskScenario } from '../packages/core/src/scenario/fixtures/index.js';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { compileScenarioCaptions } from '../packages/core/src/scenario/compile-scenario-captions.js';
import { validateScenarioCaptionPlan } from '../packages/core/src/scenario/validate-scenario-captions.js';
import { scenarioCaptionCueId, type ScenarioCaptionPlan } from '../packages/core/src/scenario/scenario-caption-types.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const rules = (report: { findings: { ruleId: string }[] }) => report.findings.map((finding) => finding.ruleId);

function valid() {
  const scenario = getProgressMeetingScenario();
  const audio = planDialogueAudio(scenario);
  const result = compileScenarioCaptions(scenario, audio);
  if (!result.success) throw new Error(result.error);
  return { scenario, audio, plan: result.plan };
}

describe('Phase 3E integration hardening', () => {
  it('refuses an invalid source Scenario before caption compilation', () => {
    const scenario = getProgressMeetingScenario();
    scenario.scenes[1].id = scenario.scenes[0].id;
    const audio = planDialogueAudio(getProgressMeetingScenario());
    const result = compileScenarioCaptions(scenario, audio);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.findings.some((finding) => finding.ruleId.startsWith('SCP-SOURCE-'))).toBe(true);
  });

  it('refuses a tampered audio plan before using its clip lookup', () => {
    const scenario = getProgressMeetingScenario();
    const audio = planDialogueAudio(scenario);
    audio.clips.pop();
    const result = compileScenarioCaptions(scenario, audio);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.findings.some((finding) => finding.ruleId.startsWith('SCP-AUDIO-'))).toBe(true);
  });

  it('refuses invalid caption profile overrides', () => {
    const scenario = getProgressMeetingScenario();
    const audio = planDialogueAudio(scenario);
    expect(compileScenarioCaptions(scenario, audio, { maxLines: 0 }).success).toBe(false);
    expect(compileScenarioCaptions(scenario, audio, { maxCharsPerLine: 4 }).success).toBe(false);
  });

  it('uses collision-resistant cue IDs for source IDs that sanitize alike', () => {
    expect(scenarioCaptionCueId('scene/a', 'turn/a', 0)).not.toBe(scenarioCaptionCueId('scene?a', 'turn?a', 0));
    expect(scenarioCaptionCueId('scene/a', 'turn/a', 0)).toBe(scenarioCaptionCueId('scene/a', 'turn/a', 0));
  });

  it('preserves the full audio interval of a visual-only scene', () => {
    const scenario = getScheduleRiskScenario();
    scenario.scenes.splice(1, 0, {
      id: 'caption-visual-only',
      index: 1,
      title: 'Site overview',
      narrativePurpose: 'context',
      locationId: scenario.scenes[0].locationId,
      estimatedDuration: 2.5,
      participantIds: [],
      turns: [],
      production: { shotType: 'wide', framing: 'symmetric', speakerFocus: 'shared_display', cameraMovement: 'static', bRollIntent: 'Aerial site overview' },
    });
    scenario.scenes.forEach((scene, index) => { scene.index = index; });
    const audio = planDialogueAudio(scenario);
    const result = compileScenarioCaptions(scenario, audio);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const captionScene = result.plan.scenes[1];
    expect(captionScene.cues).toEqual([]);
    expect(captionScene.startSeconds).toBe(audio.scenes[1].startTimeSeconds);
    expect(captionScene.endSeconds).toBe(audio.scenes[1].endTimeSeconds);
    expect(validateScenarioCaptionPlan(result.plan, scenario, audio).valid).toBe(true);
  });

  it('detects top-level identity, duration, profile, and speaker tampering', () => {
    const { scenario, audio, plan } = valid();
    plan.language = 'ar';
    plan.totalDurationSeconds += 1;
    plan.totalSpeechDurationSeconds += 1;
    plan.profile.maxLines = 0;
    plan.speakers[0].voiceSlot = 'wrong';
    expect(rules(validateScenarioCaptionPlan(plan, scenario, audio))).toEqual(expect.arrayContaining([
      'VAL-002-LANGUAGE-MISMATCH', 'VAL-002-TOTAL-DURATION', 'VAL-002-SPEECH-DURATION', 'VAL-002-PROFILE', 'VAL-003-SPEAKERS',
    ]));
  });

  it('detects missing, reordered, renamed, or retimed scenes', () => {
    const { scenario, audio, plan } = valid();
    const first = plan.scenes[0];
    first.sceneId = plan.scenes[1].sceneId;
    first.title = 'Invented';
    first.startSeconds += 1;
    expect(rules(validateScenarioCaptionPlan(plan, scenario, audio))).toEqual(expect.arrayContaining(['VAL-005-SCENE-ORDER', 'VAL-005-SCENE-TITLE', 'VAL-005-SCENE-TIMING']));
  });

  it('requires nested cues and the flattened list to match in full', () => {
    const { scenario, audio, plan } = valid();
    plan.scenes[0].cues[0] = { ...plan.scenes[0].cues[0], text: 'Nested-only tamper' };
    expect(rules(validateScenarioCaptionPlan(plan, scenario, audio))).toContain('VAL-005-NESTED-CUES-MISMATCH');
  });

  it('detects source offsets, source location, format, direction, intent, and reacting-character tampering', () => {
    const { scenario, audio, plan } = valid();
    const cue = plan.cues.find((candidate) => candidate.reactingCharacterId)!;
    cue.sourceWordStart = -1;
    cue.sceneIndex += 1;
    cue.targetFormat = 'Short';
    cue.direction = cue.direction === 'ltr' ? 'rtl' : 'ltr';
    cue.intent = cue.intent === 'inform' ? 'challenge' : 'inform';
    cue.reactingCharacterId = 'foreign-character';
    expect(rules(validateScenarioCaptionPlan(plan, scenario, audio))).toEqual(expect.arrayContaining([
      'VAL-012-SOURCE-OFFSETS', 'VAL-011-SOURCE-LOCATION', 'VAL-012-CUE-FORMAT', 'VAL-012-TURN-DIRECTION', 'VAL-021-REACTING-CHAR-MISMATCH',
    ]));
  });

  it('detects unstable IDs, duration-field tampering, and incomplete speech coverage', () => {
    const { scenario, audio, plan } = valid();
    plan.cues[0].id = 'random-id';
    plan.cues[0].durationSeconds += 1;
    const finalForTurn = plan.cues.filter((cue) => cue.turnId === plan.cues[0].turnId).at(-1)!;
    finalForTurn.endSeconds -= 0.1;
    expect(rules(validateScenarioCaptionPlan(plan, scenario, audio))).toEqual(expect.arrayContaining(['VAL-012-UNSTABLE-ID', 'VAL-015-DURATION-MISMATCH', 'VAL-019-CLIP-COVERAGE']));
  });

  it('detects foreign turn IDs even when a valid clip ID is reused', () => {
    const { scenario, audio, plan } = valid();
    plan.cues[0].turnId = 'foreign-turn';
    expect(rules(validateScenarioCaptionPlan(plan, scenario, audio))).toContain('VAL-009-FOREIGN-TURN');
  });

  it('detects cue/word totals and absolute-path injection', () => {
    const { scenario, audio, plan } = valid();
    plan.totalWordCount += 2;
    plan.speakers[0].name = 'C:\\private\\speaker.wav';
    expect(rules(validateScenarioCaptionPlan(plan, scenario, audio))).toEqual(expect.arrayContaining(['VAL-003-SPEAKERS', 'VAL-023-WORD-TOTAL', 'VAL-024-ABSOLUTE-PATH']));
  });

  it('does not mutate source objects during validation', () => {
    const { scenario, audio, plan } = valid();
    const sourceBefore = clone(scenario);
    const audioBefore = clone(audio);
    validateScenarioCaptionPlan(plan as ScenarioCaptionPlan, scenario, audio);
    expect(scenario).toEqual(sourceBefore);
    expect(audio).toEqual(audioBefore);
  });
});
