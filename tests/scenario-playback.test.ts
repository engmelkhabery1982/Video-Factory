/**
 * Phase 3D - Deterministic Unified Scenario Playback Manifest.
 * Imports the new modules directly (public exports are added at integration).
 */
import { describe, expect, it } from 'vitest';
import { compileScenarioPlayback, joinScenarioPlayback } from '../packages/core/src/scenario/compile-scenario-playback';
import { validateScenarioPlaybackPlan } from '../packages/core/src/scenario/validate-scenario-playback';
import type { ScenarioPlaybackPlan } from '../packages/core/src/scenario/scenario-playback-types';
import type { Scenario } from '../packages/core/src/scenario/types';
import { DEFAULT_DURATION_CONFIG, estimateScenarioDuration, estimateTurnDuration } from '../packages/core/src/scenario/duration';
import { compileScenarioVisualPlan } from '../packages/core/src/scenario/compile-visual-plan';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio';
import {
  getClaimVariationScenario,
  getProgressMeetingScenario,
  getScheduleRiskScenario,
} from '../packages/core/src/scenario/fixtures/index';

const FIXTURES: [string, () => Scenario][] = [
  ['progress-meeting', getProgressMeetingScenario],
  ['claim-variation', getClaimVariationScenario],
  ['schedule-risk', getScheduleRiskScenario],
];
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const ms = (s: number) => Math.round(s * 1000);

function compileOk(s: Scenario, options = {}): ScenarioPlaybackPlan {
  const r = compileScenarioPlayback(s, options);
  if (!r.ok) throw new Error(`refused: ${r.errors.map((e) => `${e.ruleId}: ${e.message}`).join(' | ')}`);
  return r.plan;
}
const rules = (p: ScenarioPlaybackPlan, s: Scenario) => validateScenarioPlaybackPlan(p, s).findings.filter((f) => f.severity === 'error').map((f) => f.ruleId);
const srcTurns = (s: Scenario) => s.scenes.flatMap((sc) => sc.turns.map((t) => ({ sc, t })));

/** Schedule-risk with a visual-only scene carrying a timed dissolve. */
function withVisualOnlyScene(): Scenario {
  const s = getScheduleRiskScenario();
  s.scenes.splice(1, 0, {
    id: 'sc-sr-vis',
    index: 1,
    title: 'Cable Route Flyover',
    narrativePurpose: 'context',
    locationId: s.scenes[0].locationId,
    estimatedDuration: 3,
    participantIds: [],
    turns: [],
    production: { shotType: 'wide', framing: 'symmetric', speakerFocus: 'shared_display', cameraMovement: 'slow_push', bRollIntent: 'Drone pass along the cable trench' },
    transitionIntent: { type: 'dissolve', durationSeconds: 0.6 },
  });
  s.scenes.forEach((x, i) => (x.index = i));
  return s;
}

describe('Phase 3D - compiles the canonical scenarios', () => {
  it.each(FIXTURES)('1-2. %s compiles and validates against its source with zero errors', (_n, get) => {
    const s = get();
    const plan = compileOk(s);
    const report = validateScenarioPlaybackPlan(plan, s);
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.valid).toBe(true);
    expect(plan.scenarioId).toBe(s.metadata.id);
    expect(plan.projectId).toBe(s.metadata.projectId);
    expect(plan.language).toBe(s.metadata.language);
    expect(plan.targetFormat).toBe(s.metadata.targetFormat);
    expect(plan.schemaVersions.scenario).toBe(s.metadata.schemaVersion);
    expect(plan.durationConfig).toEqual(DEFAULT_DURATION_CONFIG);
  });

  it('3. repeated compilation is byte-identical', () => {
    for (const [, get] of FIXTURES) expect(JSON.stringify(compileScenarioPlayback(get()))).toBe(JSON.stringify(compileScenarioPlayback(get())));
  });

  it('4. never mutates the source, and shares no references with it', () => {
    const s = getProgressMeetingScenario();
    const before = JSON.stringify(s);
    const plan = compileOk(s);
    expect(JSON.stringify(s)).toBe(before);
    plan.scenes[2].evidence[0].numericFacts[0].value = -1;
    plan.scenes[1].production.shotType = 'wide';
    plan.dialogues[0].delivery = null;
    expect(JSON.stringify(s)).toBe(before);
  });

  it('5. every source scene occurs exactly once, in order, with its stable ID', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      expect(plan.scenes.map((x) => x.sourceSceneId)).toEqual(s.scenes.map((x) => x.id));
      expect(plan.scenes.map((x) => x.id)).toEqual(s.scenes.map((x) => `${s.metadata.id}/${x.id}`));
      expect(plan.scenes.map((x) => x.index)).toEqual(s.scenes.map((x) => x.index));
    }
  });

  it('6. every source dialogue turn occurs exactly once, in order', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      expect(plan.dialogues.map((d) => d.turnId)).toEqual(srcTurns(s).map(({ t }) => t.id));
      expect(plan.dialogues.map((d) => d.globalIndex)).toEqual(plan.dialogues.map((_d, i) => i));
      expect(plan.dialogueCount).toBe(srcTurns(s).length);
    }
  });
});

describe('Phase 3D - one-to-one join of visual beats and audio clips', () => {
  it('7. each dialogue joins exactly its Phase 3B beat and its Phase 3C clip, and nothing is left over', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      const visual = compileScenarioVisualPlan(s);
      if (!visual.ok) throw new Error('visual refused');
      const audio = planDialogueAudio(s);
      const visualDialogueBeats = visual.plan.scenes.flatMap((x) => x.beats.filter((b) => b.kind === 'dialogue'));
      expect(plan.dialogues.map((d) => d.visualBeatId)).toEqual(visualDialogueBeats.map((b) => b.id));
      expect(plan.dialogues.map((d) => d.audioClipId)).toEqual(audio.clips.map((c) => c.clipId));
      expect(new Set(plan.dialogues.map((d) => d.visualBeatId)).size).toBe(plan.dialogues.length);
      expect(new Set(plan.dialogues.map((d) => d.audioClipId)).size).toBe(plan.dialogues.length);
      for (const d of plan.dialogues) {
        const beat = visualDialogueBeats.find((b) => b.id === d.visualBeatId)!;
        const clip = audio.clips.find((c) => c.clipId === d.audioClipId)!;
        expect(beat.turnId).toBe(d.turnId);
        expect(clip.turnId).toBe(d.turnId);
        expect(clip.sceneId).toBe(d.sceneId);
        expect(d.speech.startMs).toBe(ms(clip.startTimeSeconds));
        expect(d.turnSpan).toEqual({ startMs: ms(beat.startSeconds), endMs: ms(beat.endSeconds), durationMs: ms(beat.endSeconds) - ms(beat.startSeconds) });
        // the playback beat points back at the dialogue entry
        const pbeat = plan.scenes.flatMap((x) => x.beats).find((b) => b.id === d.visualBeatId)!;
        expect(pbeat.dialogueId).toBe(d.id);
      }
    }
  });

  it('8-11. speaker, reacting character, exact text, intent and delivery are preserved', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      srcTurns(s).forEach(({ t }, i) => {
        const d = plan.dialogues[i];
        expect(d.speakerId).toBe(t.speakerId);
        expect(d.reactingCharacterId).toBe(t.reactionTargetId ?? null);
        expect(d.spokenText).toBe(t.spokenText);
        expect(d.intent).toBe(t.intent);
        expect(d.delivery).toEqual(t.delivery ?? null);
        const beat = plan.scenes.flatMap((x) => x.beats).find((b) => b.id === d.visualBeatId)!;
        expect(beat.activeSpeakerId).toBe(t.speakerId);
        expect(beat.reactingCharacterId).toBe(t.reactionTargetId ?? null);
        expect(beat.cues.find((c) => c.kind === 'dialogue')!.text).toBe(t.spokenText);
      });
    }
    // at least one fixture actually exercises reaction targets and delivery
    const all = FIXTURES.flatMap(([, g]) => compileOk(g()).dialogues);
    expect(all.some((d) => d.reactingCharacterId)).toBe(true);
    expect(all.some((d) => d.delivery)).toBe(true);
  });

  it('12. evidence and numeric facts are preserved on scenes, beats and dialogues', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      for (const sc of plan.scenes) for (const e of sc.evidence) expect(e.numericFacts).toEqual(s.evidence.find((x) => x.id === e.id)!.numericFacts);
      srcTurns(s).forEach(({ t }, i) => {
        expect(plan.dialogues[i].evidenceIds).toEqual(t.evidenceId ? [t.evidenceId] : []);
        if (t.evidenceId) {
          const beat = plan.scenes.flatMap((x) => x.beats).find((b) => b.id === plan.dialogues[i].visualBeatId)!;
          const cue = beat.cues.find((c) => c.kind === 'evidence')!;
          expect(cue.numericFacts).toEqual(s.evidence.find((e) => e.id === t.evidenceId)!.numericFacts);
        }
      });
    }
  });

  it('13. voice slots are preserved (turn override, else character slot) and distinct per character', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      srcTurns(s).forEach(({ t }, i) => {
        const expected = t.voiceSlot?.trim() || s.characters.find((c) => c.id === t.speakerId)!.voiceSlot;
        expect(plan.dialogues[i].voiceSlot).toBe(expected);
      });
      expect(new Set(plan.characters.map((c) => c.voiceSlot)).size).toBe(plan.characters.length);
    }
  });

  it('14. speech and pause intervals partition each turn span, matching the estimator', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      let prevEnd = 0;
      srcTurns(s).forEach(({ t }, i) => {
        const d = plan.dialogues[i];
        const est = estimateTurnDuration(t);
        expect(d.speech.startMs).toBe(d.turnSpan.startMs);
        expect(d.speech.durationMs).toBe(ms(est.speechDurationSeconds));
        expect(d.pause.startMs).toBe(d.speech.endMs);
        expect(d.pause.endMs).toBe(d.turnSpan.endMs);
        expect(d.pause.durationMs).toBe(ms(est.pauseSeconds));
        expect(d.turnSpan.startMs).toBeGreaterThanOrEqual(prevEnd);
        prevEnd = d.turnSpan.endMs;
      });
      expect(plan.totalSpeechMs + plan.totalPauseMs + plan.totalTransitionMs + plan.totalVisualOnlyMs).toBe(plan.totalDurationMs);
      expect(plan.totalDurationMs).toBe(ms(estimateScenarioDuration(s).totalSeconds));
      // scenes and beats tile the timeline with integer ms
      let cursor = 0;
      for (const sc of plan.scenes) {
        expect(sc.interval.startMs).toBe(cursor);
        let b0 = sc.interval.startMs;
        for (const b of sc.beats) {
          expect(Number.isInteger(b.interval.startMs) && Number.isInteger(b.interval.endMs)).toBe(true);
          expect(b.interval.startMs).toBe(b0);
          b0 = b.interval.endMs;
        }
        expect(b0).toBe(sc.interval.endMs);
        cursor = sc.interval.endMs;
      }
    }
  });
});

describe('Phase 3D - visual-only scenes, transitions and duration configuration', () => {
  it('15-16. a visual-only scene has no audio yet stays valid; its timed transition keeps the estimator duration', () => {
    const s = withVisualOnlyScene();
    const plan = compileOk(s);
    const vs = plan.scenes.find((x) => x.sourceSceneId === 'sc-sr-vis')!;
    expect(vs.visualOnly).toBe(true);
    expect(vs.dialogueIds).toEqual([]);
    expect(vs.dialogueSpan).toBeNull();
    expect(vs.beats.map((b) => b.kind)).toEqual(['visual_only', 'transition']);
    expect(vs.beats.every((b) => b.dialogueId === null && b.activeSpeakerId === null)).toBe(true);
    expect(vs.beats[0].interval.durationMs).toBe(2500);
    expect(vs.transition).toEqual({ type: 'dissolve', source: 'scene.transitionIntent', interval: vs.beats[1].interval });
    expect(vs.transition.interval!.durationMs).toBe(600);
    expect(plan.dialogues.some((d) => d.sceneId === 'sc-sr-vis')).toBe(false);
    expect(plan.totalTransitionMs).toBe(600);
    expect(plan.totalVisualOnlyMs).toBe(2500);
    expect(validateScenarioPlaybackPlan(plan, s).valid).toBe(true);
  });

  it('16b. production-level transitions add no time and must not gain an interval', () => {
    const s = getProgressMeetingScenario();
    const plan = compileOk(s);
    const prodScene = plan.scenes.find((x) => x.transition.source === 'production.transitionIntent')!;
    expect(prodScene).toBeDefined();
    expect(prodScene.transition.interval).toBeNull();
    expect(prodScene.beats.some((b) => b.kind === 'transition')).toBe(false);
    const tampered = clone(plan);
    tampered.scenes[prodScene.index].transition.interval = { startMs: 0, endMs: 500, durationMs: 500 };
    expect(rules(tampered, s)).toContain('transition.untimed_gained_duration');
  });

  it('17. a custom duration configuration is applied to both planners consistently', () => {
    const s = getProgressMeetingScenario();
    const custom = { wordsPerMinute: 130, defaultPauseSeconds: 0.45, minTurnSeconds: 1 };
    const plan = compileOk(s, { durationConfig: custom });
    const cfg = { ...DEFAULT_DURATION_CONFIG, ...custom };
    expect(plan.durationConfig).toEqual(cfg);
    expect(plan.totalDurationMs).toBe(ms(estimateScenarioDuration(s, cfg).totalSeconds));
    expect(plan.totalDurationMs).not.toBe(compileOk(s).totalDurationMs);
    const audio = planDialogueAudio(s, { durationConfig: cfg });
    plan.dialogues.forEach((d, i) => {
      expect(d.speech.startMs).toBe(ms(audio.clips[i].startTimeSeconds));
      expect(d.speech.durationMs).toBe(ms(audio.clips[i].durationSeconds));
    });
    expect(validateScenarioPlaybackPlan(plan, s).valid).toBe(true);
    // a manifest whose recorded config does not match its timeline is incompatible
    const tampered = clone(plan);
    tampered.durationConfig = { ...DEFAULT_DURATION_CONFIG };
    expect(rules(tampered, s)).toContain('timing.scene_changed');
    // an unusable config is refused, not thrown
    const bad = compileScenarioPlayback(s, { durationConfig: { wordsPerMinute: 0 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0].ruleId).toBe('playback.duration_config_invalid');
  });

  it('17b. plans compiled with different configurations cannot be joined', () => {
    const s = getScheduleRiskScenario();
    const visual = compileScenarioVisualPlan(s);
    if (!visual.ok) throw new Error('visual refused');
    const audio = planDialogueAudio(s, { durationConfig: { wordsPerMinute: 120 } });
    const joined = joinScenarioPlayback(visual.plan, audio, DEFAULT_DURATION_CONFIG, s.metadata.schemaVersion);
    expect(joined.plan).toBeNull();
    const ids = joined.errors.map((e) => e.ruleId);
    expect(ids).toContain('playback.duration_config_mismatch');
    expect(ids).toContain('playback.timing_disagreement');
  });
});

describe('Phase 3D - rejection', () => {
  it('18. a missing visual beat is rejected (clip without beat)', () => {
    const s = getClaimVariationScenario();
    const visual = compileScenarioVisualPlan(s);
    if (!visual.ok) throw new Error('visual refused');
    const v = clone(visual.plan);
    v.scenes[1].beats.splice(0, 1);
    const joined = joinScenarioPlayback(v, planDialogueAudio(s), DEFAULT_DURATION_CONFIG, s.metadata.schemaVersion);
    expect(joined.plan).toBeNull();
    expect(joined.errors.map((e) => e.ruleId)).toContain('playback.clip_without_beat');

    const p = compileOk(s);
    p.scenes[1].beats.splice(0, 1);
    expect(rules(p, s)).toContain('beat.coverage');
  });

  it('19. a missing audio clip is rejected (beat without clip)', () => {
    const s = getClaimVariationScenario();
    const visual = compileScenarioVisualPlan(s);
    if (!visual.ok) throw new Error('visual refused');
    const audio = clone(planDialogueAudio(s));
    audio.clips.splice(2, 1);
    const joined = joinScenarioPlayback(visual.plan, audio, DEFAULT_DURATION_CONFIG, s.metadata.schemaVersion);
    expect(joined.plan).toBeNull();
    expect(joined.errors.map((e) => e.ruleId)).toContain('playback.beat_without_clip');

    const p = compileOk(s);
    const removed = p.dialogues.splice(2, 1)[0];
    const r = rules(p, s);
    expect(r).toContain('turn.missing');
    expect(r).toContain('playback.beat_without_clip');
    expect(removed).toBeDefined();
  });

  it('20. a duplicate turn is rejected', () => {
    const s = getProgressMeetingScenario();
    const p = compileOk(s);
    p.dialogues.splice(3, 0, clone(p.dialogues[3]));
    const r = rules(p, s);
    expect(r).toContain('turn.duplicate');
    expect(r).toContain('id.duplicate');
  });

  it('21. a reordered turn is rejected', () => {
    const s = getProgressMeetingScenario();
    const p = compileOk(s);
    [p.dialogues[0], p.dialogues[1]] = [p.dialogues[1], p.dialogues[0]];
    expect(rules(p, s)).toContain('turn.order');
    const q = compileOk(s);
    const beats = q.scenes[0].beats;
    [beats[0], beats[1]] = [beats[1], beats[0]];
    expect(rules(q, s)).toContain('beat.coverage');
  });

  it('22. altered spoken text (dialogue or cue) is rejected', () => {
    const s = getScheduleRiskScenario();
    const p = compileOk(s);
    p.dialogues[0].spokenText += ' Everything is fine.';
    expect(rules(p, s)).toContain('turn.text_changed');
    const q = compileOk(s);
    q.scenes[0].beats[0].cues[0].text = 'We are fully on schedule.';
    expect(rules(q, s)).toContain('cue.text_changed');
  });

  it('23. altered speaker, reacting character, intent, delivery or voice slot is rejected', () => {
    const s = getProgressMeetingScenario();
    const other = (id: string) => s.characters.find((c) => c.id !== id)!.id;
    const a = compileOk(s);
    a.dialogues[0].speakerId = other(a.dialogues[0].speakerId);
    expect(rules(a, s)).toContain('turn.speaker_changed');
    const b = compileOk(s);
    b.dialogues[0].voiceSlot = 'voice-someone-else';
    expect(rules(b, s)).toContain('voice.slot_changed');
    const c = compileOk(s);
    c.dialogues[0].reactingCharacterId = 'char-nobody';
    expect(rules(c, s)).toContain('turn.reaction_changed');
    const d = compileOk(s);
    d.dialogues[1].intent = d.dialogues[1].intent === 'question' ? 'answer' : 'question';
    expect(rules(d, s)).toContain('turn.intent_changed');
    const e = compileOk(s);
    const withDelivery = e.dialogues.findIndex((x) => x.delivery);
    e.dialogues[withDelivery].delivery = null;
    expect(rules(e, s)).toContain('turn.delivery_changed');
  });

  it('24. altered evidence or numeric facts are rejected', () => {
    const s = getProgressMeetingScenario();
    const p = compileOk(s);
    const sc = p.scenes.find((x) => x.evidence.length)!;
    sc.evidence[0].numericFacts[0].value += 1;
    expect(rules(p, s)).toContain('evidence.changed');
    const q = compileOk(s);
    const cue = q.scenes.flatMap((x) => x.beats.flatMap((b) => b.cues)).find((c) => c.kind === 'evidence')!;
    cue.numericFacts![0].value += 1;
    expect(rules(q, s)).toContain('evidence.numeric_changed');
    const r = compileOk(s);
    const d = r.dialogues.find((x) => x.evidenceIds.length)!;
    d.evidenceIds = ['ev-invented'];
    const rr = rules(r, s);
    expect(rr).toContain('evidence.ids_changed');
    expect(rr).toContain('evidence.unknown');
  });

  it('25. overlapping timing is rejected (dialogue, speech, pause and scene)', () => {
    const s = getProgressMeetingScenario();
    const a = compileOk(s);
    a.dialogues[1].turnSpan = { ...a.dialogues[1].turnSpan, startMs: a.dialogues[1].turnSpan.startMs - 200, durationMs: a.dialogues[1].turnSpan.durationMs + 200 };
    expect(rules(a, s)).toContain('timing.dialogue_overlap');
    const b = compileOk(s);
    b.dialogues[0].speech = { startMs: b.dialogues[0].speech.startMs, endMs: b.dialogues[0].turnSpan.endMs + 300, durationMs: b.dialogues[0].turnSpan.durationMs + 300 };
    expect(rules(b, s)).toContain('timing.speech_outside_beat');
    const c = compileOk(s);
    c.dialogues[0].pause = { startMs: c.dialogues[0].pause.startMs, endMs: c.dialogues[0].pause.endMs + 500, durationMs: c.dialogues[0].pause.durationMs + 500 };
    expect(rules(c, s)).toContain('timing.pause_outside_turn');
    const d = compileOk(s);
    d.scenes[2].interval = { startMs: d.scenes[2].interval.startMs - 1000, endMs: d.scenes[2].interval.endMs, durationMs: d.scenes[2].interval.durationMs + 1000 };
    expect(rules(d, s)).toContain('timing.scene_overlap');
  });

  it('26. total-duration and scene-total tampering is rejected', () => {
    const s = getClaimVariationScenario();
    const p = compileOk(s);
    p.totalDurationMs += 1000;
    expect(rules(p, s)).toContain('timing.total_invalid');
    const q = compileOk(s);
    q.totalSpeechMs -= 100;
    expect(rules(q, s)).toContain('timing.total_speech');
    const r = compileOk(s);
    const last = r.scenes[r.scenes.length - 1];
    last.interval = { ...last.interval, endMs: last.interval.endMs + 1000, durationMs: last.interval.durationMs + 1000 };
    const rr = rules(r, s);
    expect(rr).toContain('timing.scene_changed');
    expect(rr).toContain('timing.beats_incomplete');
  });

  it('27. absolute paths are rejected wherever they appear', () => {
    const s = getProgressMeetingScenario();
    const a = compileOk(s);
    a.dialogues[0].suggestedAudioPath = '/home/user/audio/turn.wav';
    const ra = rules(a, s);
    expect(ra).toContain('security.absolute_path');
    expect(ra).toContain('path.changed');
    const b = compileOk(s);
    b.scenes[1].production.screenInsert!.assetRef = 'C:\\assets\\chart.png';
    expect(rules(b, s)).toContain('security.absolute_path');
    const c = compileOk(s);
    c.audioBasePath = 'file:///tmp/audio';
    expect(rules(c, s)).toContain('security.absolute_path');
    // and the compiler refuses an absolute base path instead of throwing
    const r = compileScenarioPlayback(s, { audioBasePath: '/abs/audio' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].ruleId).toBe('playback.audio_plan_refused');
    for (const [, g] of FIXTURES) expect(JSON.stringify(compileOk(g()))).not.toMatch(/\/home\/|file:\/\/|[A-Za-z]:\\/);
  });

  it('27b. invented visible cues and duplicate or unstable IDs are rejected', () => {
    const s = getScheduleRiskScenario();
    const a = compileOk(s);
    const iv = a.scenes[0].interval;
    a.scenes[0].sceneCues.push({ id: `${a.scenes[0].id}/cue/callout`, kind: 'callout', text: 'Guaranteed on time', source: { sceneId: s.scenes[0].id, field: 'onScreenInfo.callout' }, interval: iv });
    const ra = rules(a, s);
    expect(ra.some((r) => r === 'cue.invented' || r === 'cue.text_changed')).toBe(true);
    const b = compileOk(s);
    b.scenes[1].id = 'renamed-scene';
    expect(rules(b, s)).toContain('id.unstable');
    const c = compileOk(s);
    c.dialogues[1].audioClipId = c.dialogues[0].audioClipId;
    const rc = rules(c, s);
    expect(rc).toContain('id.duplicate');
    expect(rc).toContain('id.unstable');
  });

  it('27c. missing, duplicate, foreign and reordered scenes are rejected', () => {
    const s = getProgressMeetingScenario();
    const a = compileOk(s);
    a.scenes.splice(1, 1);
    expect(rules(a, s)).toContain('scene.missing');
    const b = compileOk(s);
    b.scenes.splice(2, 0, clone(b.scenes[2]));
    expect(rules(b, s)).toContain('scene.duplicate');
    const c = compileOk(s);
    c.scenes[0].sourceSceneId = 'sc-foreign';
    expect(rules(c, s)).toContain('scene.unknown');
    const d = compileOk(s);
    [d.scenes[0], d.scenes[1]] = [d.scenes[1], d.scenes[0]];
    expect(rules(d, s)).toContain('scene.order');
  });

  it('28. an invalid or broken source scenario is refused structurally, never thrown', () => {
    const s = getProgressMeetingScenario();
    s.scenes[1].turns[0].speakerId = 'char-nobody';
    const r1 = compileScenarioPlayback(s);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.plan).toBeNull();
      expect(r1.errors.length).toBeGreaterThan(0);
      expect(r1.errors.every((e) => e.severity === 'error' && typeof e.ruleId === 'string' && e.stage === 'source')).toBe(true);
    }
    expect(JSON.stringify(r1)).toBe(JSON.stringify(compileScenarioPlayback(clone(s))));
    for (const broken of [{}, null, undefined, 42, { metadata: {}, scenes: 'x' }]) {
      expect(() => compileScenarioPlayback(broken as unknown as Scenario)).not.toThrow();
      expect(compileScenarioPlayback(broken as unknown as Scenario).ok).toBe(false);
    }
    // malformed plans are reported, not thrown
    const src = getScheduleRiskScenario();
    for (const bad of [null, {}, { scenes: [], dialogues: 'x' }, { scenes: [null], dialogues: [null] }]) {
      expect(() => validateScenarioPlaybackPlan(bad as unknown as ScenarioPlaybackPlan, src)).not.toThrow();
      expect(validateScenarioPlaybackPlan(bad as unknown as ScenarioPlaybackPlan, src).valid).toBe(false);
    }
  });

  it('28b. a shared voice slot across characters is refused unless explicitly allowed', () => {
    const s = getScheduleRiskScenario();
    const [c0, c1] = s.characters;
    c1.voiceSlot = c0.voiceSlot;
    const refused = compileScenarioPlayback(s);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.map((e) => e.ruleId)).toContain('playback.audio_plan_refused');
    const allowed = compileOk(s, { allowSharedVoiceSlots: true });
    expect(allowed.allowSharedVoiceSlots).toBe(true);
    expect(validateScenarioPlaybackPlan(allowed, s).valid).toBe(true);
  });

  it('29. JSON round-trip preserves the bytes and the validation result', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const text = JSON.stringify(compileOk(s));
      const parsed = JSON.parse(text) as ScenarioPlaybackPlan;
      expect(JSON.stringify(parsed)).toBe(text);
      expect(validateScenarioPlaybackPlan(parsed, s).valid).toBe(true);
    }
    const vs = withVisualOnlyScene();
    expect(validateScenarioPlaybackPlan(JSON.parse(JSON.stringify(compileOk(vs))), vs).valid).toBe(true);
  });
});
