import { describe, expect, it } from 'vitest';
import {
  compileScenarioVisualPlan,
  getProgressMeetingScenario,
  getScheduleRiskScenario,
  planDialogueAudio,
  resolveVisualCueSourceText,
  validateDialogueAudioPlan,
  validateScenarioVisualPlan,
  type DialogueAudioPlan,
  type ScenarioVisualPlan,
} from '@buildtrack/core';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function visualPlan(): { source: ReturnType<typeof getProgressMeetingScenario>; plan: ScenarioVisualPlan } {
  const source = getProgressMeetingScenario();
  const result = compileScenarioVisualPlan(source);
  if (!result.ok) throw new Error(result.errors.map((finding) => finding.ruleId).join(','));
  return { source, plan: result.plan };
}

function audioPlan(): { source: ReturnType<typeof getProgressMeetingScenario>; plan: DialogueAudioPlan } {
  const source = getProgressMeetingScenario();
  return { source, plan: planDialogueAudio(source) };
}

const ruleIds = (report: { findings: { ruleId: string }[] }) => report.findings.map((finding) => finding.ruleId);

describe('Phase 3B/3C public integration and tamper resistance', () => {
  it('exports both planning APIs through the public core package', () => {
    expect(compileScenarioVisualPlan).toBeTypeOf('function');
    expect(validateScenarioVisualPlan).toBeTypeOf('function');
    expect(resolveVisualCueSourceText).toBeTypeOf('function');
    expect(planDialogueAudio).toBeTypeOf('function');
    expect(validateDialogueAudioPlan).toBeTypeOf('function');
  });

  it('rejects a visual plan that silently drops declared evidence', () => {
    const { source, plan } = visualPlan();
    const scene = plan.scenes.find((candidate) => candidate.evidenceIds.length > 0);
    expect(scene).toBeDefined();
    scene!.evidenceIds = [];
    scene!.evidence = [];

    const report = validateScenarioVisualPlan(plan, source);
    expect(report.valid).toBe(false);
    expect(ruleIds(report)).toEqual(expect.arrayContaining(['evidence.coverage', 'evidence.records_coverage']));
  });

  it('rejects altered visual metadata, speaker coverage, and title', () => {
    const { source, plan } = visualPlan();
    plan.projectId = 'wrong-project';
    plan.language = 'ar';
    plan.scenes[0].speakerIds = [];
    plan.scenes[0].title = 'Invented title';

    const report = validateScenarioVisualPlan(plan, source);
    expect(ruleIds(report)).toEqual(expect.arrayContaining(['plan.project_id', 'plan.language', 'scene.speakers_changed', 'scene.title_changed']));
  });

  it('rejects altered beat intent, shot, evidence list, and missing dialogue cue', () => {
    const { source, plan } = visualPlan();
    const beat = plan.scenes.flatMap((scene) => scene.beats).find((candidate) => candidate.kind === 'dialogue')!;
    beat.intent = beat.intent === 'inform' ? 'challenge' : 'inform';
    beat.shot = { ...beat.shot, focusCharacterId: 'invented-character' };
    beat.evidenceIds = ['invented-evidence'];
    beat.cues = beat.cues.filter((cue) => cue.kind !== 'dialogue');

    const report = validateScenarioVisualPlan(plan, source);
    expect(ruleIds(report)).toEqual(expect.arrayContaining(['turn.intent_changed', 'turn.shot_changed', 'turn.evidence_changed', 'turn.cue_coverage', 'turn.cue_sources']));
  });

  it('rejects a missing scene-wide cue or a cue retargeted to another turn', () => {
    const { source, plan } = visualPlan();
    const sceneWithCue = plan.scenes.find((scene) => scene.sceneCues.length > 0)!;
    sceneWithCue.sceneCues.pop();
    const sceneWithTwoTurns = plan.scenes.find((scene) => scene.beats.filter((beat) => beat.kind === 'dialogue').length > 1)!;
    const dialogueBeats = sceneWithTwoTurns.beats.filter((beat) => beat.kind === 'dialogue');
    dialogueBeats[0].cues[0].source.turnId = dialogueBeats[1].turnId!;
    dialogueBeats[0].cues[0].text = dialogueBeats[1].spokenText!;

    const report = validateScenarioVisualPlan(plan, source);
    expect(ruleIds(report)).toEqual(expect.arrayContaining(['scene.cue_coverage', 'turn.cue_sources']));
  });

  it('rejects altered transition semantics while allowing the compiler output', () => {
    const source = getScheduleRiskScenario();
    const result = compileScenarioVisualPlan(source);
    if (!result.ok) throw new Error('fixture refused');
    expect(validateScenarioVisualPlan(result.plan, source).valid).toBe(true);
    result.plan.scenes[0].transitionOut = { type: 'wipe', durationSeconds: 99, source: 'default' };
    expect(ruleIds(validateScenarioVisualPlan(result.plan, source))).toEqual(expect.arrayContaining(['scene.transition_changed', 'scene.transition_duration']));
  });

  it('blocks cross-character voice sharing introduced only through turn overrides', () => {
    const source = getProgressMeetingScenario();
    const first = source.scenes.flatMap((scene) => scene.turns)[0];
    const second = source.scenes.flatMap((scene) => scene.turns).find((turn) => turn.speakerId !== first.speakerId)!;
    const firstCharacter = source.characters.find((character) => character.id === first.speakerId)!;
    second.voiceSlot = firstCharacter.voiceSlot;

    expect(() => planDialogueAudio(source)).toThrow(/assigned to multiple characters/i);
    expect(() => planDialogueAudio(source, { allowSharedVoiceSlots: true })).not.toThrow();
  });

  it('requires a stable default slot for every speaking character even when turns override it', () => {
    const source = getProgressMeetingScenario();
    const character = source.characters[0];
    for (const scene of source.scenes) {
      for (const turn of scene.turns) if (turn.speakerId === character.id) turn.voiceSlot = 'per-turn-override';
    }
    delete character.voiceSlot;
    expect(() => planDialogueAudio(source)).toThrow(/has no voiceSlot defined/i);
  });

  it('rejects invalid duration configuration instead of creating corrupt timing', () => {
    const source = getProgressMeetingScenario();
    expect(() => planDialogueAudio(source, { durationConfig: { wordsPerMinute: 0 } })).toThrow(/wordsPerMinute/i);
    expect(() => planDialogueAudio(source, { durationConfig: { defaultPauseSeconds: Number.NaN } })).toThrow(/defaultPauseSeconds/i);
  });

  it('validates plans made with custom duration assumptions using those recorded assumptions', () => {
    const source = getProgressMeetingScenario();
    const plan = planDialogueAudio(source, { durationConfig: { wordsPerMinute: 112, defaultPauseSeconds: 0.75 } });
    expect(plan.durationConfig.wordsPerMinute).toBe(112);
    expect(plan.durationConfig.defaultPauseSeconds).toBe(0.75);
    expect(validateDialogueAudioPlan(plan, source).valid).toBe(true);
  });

  it('rejects altered audio direction, evidence, voice, duration, and audio format', () => {
    const { source, plan } = audioPlan();
    const clip = plan.clips[0];
    clip.intent = clip.intent === 'inform' ? 'challenge' : 'inform';
    clip.delivery = { emotion: 'urgent', pace: 'fast' };
    clip.evidenceId = 'invented-evidence';
    clip.voiceSlot = 'invented-voice';
    clip.durationSeconds += 1;
    clip.audioFormat = { ...clip.audioFormat, sampleRate: 44100 as 48000 };

    const report = validateDialogueAudioPlan(plan, source);
    expect(report.valid).toBe(false);
    expect(ruleIds(report)).toEqual(expect.arrayContaining([
      'DAP-016-DIRECTION-ALTERED',
      'DAP-016-EVIDENCE-ALTERED',
      'DAP-016-VOICE-SLOT-ALTERED',
      'DAP-016-DURATION-ALTERED',
      'DAP-010-CLIP-FORMAT',
    ]));
  });

  it('rejects incomplete audio scene and character manifests', () => {
    const { source, plan } = audioPlan();
    plan.characters.pop();
    plan.scenes[0].clips.shift();

    const report = validateDialogueAudioPlan(plan, source);
    expect(ruleIds(report)).toEqual(expect.arrayContaining(['DAP-012-SCENE-CLIP-COVERAGE', 'DAP-016-CHARACTER-COUNT', 'DAP-016-CHARACTER-MISSING']));
  });

  it('rejects altered audio plan identity, source scene title, and nested clip content', () => {
    const { source, plan } = audioPlan();
    plan.projectId = 'wrong-project';
    plan.language = 'ar';
    plan.scenes[0].title = 'Invented title';
    plan.scenes[0].clips[0] = { ...plan.scenes[0].clips[0], spokenText: 'Invented nested text' };

    const report = validateDialogueAudioPlan(plan, source);
    expect(ruleIds(report)).toEqual(expect.arrayContaining(['DAP-013-PROJECT-ID-MISMATCH', 'DAP-013-LANGUAGE-MISMATCH', 'DAP-016-SCENE-ALTERED', 'DAP-012-SCENE-CLIP-COVERAGE']));
  });

  it('detects a plan whose aggregate totals were changed after planning', () => {
    const { source, plan } = audioPlan();
    plan.totalSpeechDurationSeconds += 2;
    plan.totalPauseDurationSeconds += 1;
    plan.totalDurationSeconds += 3;

    const report = validateDialogueAudioPlan(plan, source);
    expect(ruleIds(report)).toEqual(expect.arrayContaining(['DAP-012-SPEECH-TOTAL', 'DAP-012-PAUSE-TOTAL', 'DAP-012-PLAN-TOTAL']));
  });

  it('does not mutate either source scenario while planning', () => {
    const source = getProgressMeetingScenario();
    const before = clone(source);
    planDialogueAudio(source);
    expect(source).toEqual(before);
  });
});
