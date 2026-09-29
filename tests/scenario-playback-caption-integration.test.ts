/**
 * Phase 3D x Phase 3E end-to-end integration.
 *
 * One Scenario -> playback manifest (3D, which internally runs 3B visual + 3C
 * audio) + speaker-aware captions (3E, built from the 3C audio plan compiled
 * with the manifest's recorded duration config). Proves the three artefacts
 * describe the same scenario, format, scenes, turns, speakers and timeline,
 * and that mismatched plans are refused even when their scene IDs match.
 *
 * Imports go through the public @buildtrack/core surface to prove the
 * Phase 3D / 3E exports are wired.
 */
import { describe, expect, it } from 'vitest';
import {
  compileScenarioCaptions,
  compileScenarioPlayback,
  compileScenarioVisualPlan,
  DEFAULT_DURATION_CONFIG,
  getClaimVariationScenario,
  getProgressMeetingScenario,
  getScheduleRiskScenario,
  joinScenarioPlayback,
  planDialogueAudio,
  resolvePlaybackDurationConfig,
  validateScenarioCaptionPlan,
  validateScenarioPlaybackPlan,
  type DialogueAudioPlan,
  type Scenario,
  type ScenarioCaptionPlan,
  type ScenarioPlaybackPlan,
} from '@buildtrack/core';

const FIXTURES: [string, () => Scenario][] = [
  ['progress-meeting', getProgressMeetingScenario],
  ['claim-variation', getClaimVariationScenario],
  ['schedule-risk', getScheduleRiskScenario],
];
const ms = (s: number) => Math.round(s * 1000);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean);

function pipeline(s: Scenario, durationConfig?: Partial<typeof DEFAULT_DURATION_CONFIG>) {
  const pr = compileScenarioPlayback(s, durationConfig ? { durationConfig } : {});
  if (!pr.ok) throw new Error(`playback refused: ${pr.errors.map((e) => e.ruleId).join(',')}`);
  const audio = planDialogueAudio(s, { durationConfig: pr.plan.durationConfig });
  const cr = compileScenarioCaptions(s, audio);
  if (!cr.success) throw new Error(`captions refused: ${cr.error}`);
  return { playback: pr.plan as ScenarioPlaybackPlan, audio: audio as DialogueAudioPlan, captions: cr.plan as ScenarioCaptionPlan };
}

describe('Phase 3D/3E integration - one scenario, one timeline', () => {
  it.each(FIXTURES)('%s: playback, audio and captions each validate against the source', (_n, get) => {
    const s = get();
    const { playback, audio, captions } = pipeline(s);
    expect(validateScenarioPlaybackPlan(playback, s).valid).toBe(true);
    expect(validateScenarioCaptionPlan(captions, s, audio).valid).toBe(true);
  });

  it('same scenario identity and target format across all three plans', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const { playback, audio, captions } = pipeline(s);
      for (const p of [playback, audio, captions]) {
        expect(p.scenarioId).toBe(s.metadata.id);
        expect(p.projectId).toBe(s.metadata.projectId);
        expect(p.language).toBe(s.metadata.language);
        expect(p.targetFormat).toBe(s.metadata.targetFormat);
      }
      expect(playback.durationConfig).toEqual(audio.durationConfig);
    }
    // Long and Short both covered
    expect(new Set(FIXTURES.map(([, g]) => pipeline(g()).captions.targetFormat))).toEqual(new Set(['Long', 'Short']));
  });

  it('same scene identity, order and boundaries (to the millisecond)', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const { playback, audio, captions } = pipeline(s);
      const ids = s.scenes.map((x) => x.id);
      expect(playback.scenes.map((x) => x.sourceSceneId)).toEqual(ids);
      expect(audio.scenes.map((x) => x.sceneId)).toEqual(ids);
      expect(captions.scenes.map((x) => x.sceneId)).toEqual(ids);
      playback.scenes.forEach((ps, i) => {
        expect(captions.scenes[i].sceneIndex).toBe(ps.index);
        expect(ms(captions.scenes[i].startSeconds)).toBe(ps.interval.startMs);
        expect(ms(captions.scenes[i].endSeconds)).toBe(ps.interval.endMs);
        expect(ms(audio.scenes[i].startTimeSeconds)).toBe(ps.interval.startMs);
        expect(ms(audio.scenes[i].endTimeSeconds)).toBe(ps.interval.endMs);
      });
      expect(ms(captions.totalDurationSeconds)).toBe(playback.totalDurationMs);
      expect(ms(captions.totalSpeechDurationSeconds)).toBe(playback.totalSpeechMs);
    }
  });

  it('caption cues tile each speech interval exactly and never enter the pause or another turn', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const { playback, captions } = pipeline(s);
      for (const d of playback.dialogues) {
        const cues = captions.cues.filter((c) => c.turnId === d.turnId);
        expect(cues.length).toBeGreaterThan(0);
        expect(ms(cues[0].startSeconds)).toBe(d.speech.startMs);
        expect(ms(cues[cues.length - 1].endSeconds)).toBe(d.speech.endMs);
        cues.forEach((c, i) => {
          expect(ms(c.startSeconds)).toBeGreaterThanOrEqual(d.speech.startMs);
          expect(ms(c.endSeconds)).toBeLessThanOrEqual(d.pause.startMs);
          if (i) expect(ms(c.startSeconds)).toBe(ms(cues[i - 1].endSeconds));
        });
        // and the visual beat fully contains them
        const beat = playback.scenes.flatMap((x) => x.beats).find((b) => b.id === d.visualBeatId)!;
        expect(ms(cues[0].startSeconds)).toBeGreaterThanOrEqual(beat.interval.startMs);
        expect(ms(cues[cues.length - 1].endSeconds)).toBeLessThanOrEqual(beat.interval.endMs);
      }
      // captions are monotonic globally
      for (let i = 1; i < captions.cues.length; i++) expect(captions.cues[i].startSeconds).toBeGreaterThanOrEqual(captions.cues[i - 1].endSeconds - 1e-9);
    }
  });

  it('every caption cue maps to the correct turn, clip, speaker, voice and reacting character', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const { playback, captions } = pipeline(s);
      const byTurn = new Map(playback.dialogues.map((d) => [d.turnId, d] as const));
      expect(new Set(captions.cues.map((c) => c.turnId))).toEqual(new Set(playback.dialogues.map((d) => d.turnId)));
      for (const c of captions.cues) {
        const d = byTurn.get(c.turnId)!;
        expect(c.sceneId).toBe(d.sceneId);
        expect(c.clipId).toBe(d.audioClipId);
        expect(c.speakerId).toBe(d.speakerId);
        expect(c.voiceSlot).toBe(d.voiceSlot);
        expect(c.reactingCharacterId ?? null).toBe(d.reactingCharacterId);
        expect(c.intent).toBe(d.intent);
      }
      // captions reproduce each spoken line word-for-word, in order
      for (const d of playback.dialogues) {
        const text = captions.cues.filter((c) => c.turnId === d.turnId).map((c) => c.text).join(' ');
        expect(words(text)).toEqual(words(d.spokenText));
      }
    }
  });

  it('stays aligned under a custom duration configuration', () => {
    const s = getScheduleRiskScenario();
    const custom = { wordsPerMinute: 125, defaultPauseSeconds: 0.5 };
    const { playback, captions } = pipeline(s, custom);
    expect(playback.durationConfig).toEqual({ ...DEFAULT_DURATION_CONFIG, ...custom });
    expect(ms(captions.totalDurationSeconds)).toBe(playback.totalDurationMs);
    for (const d of playback.dialogues) {
      const cues = captions.cues.filter((c) => c.turnId === d.turnId);
      expect(ms(cues[cues.length - 1].endSeconds)).toBe(d.speech.endMs);
    }
  });
});

describe('Phase 3D/3E integration - mismatched plans are refused', () => {
  const visualOf = (s: Scenario) => {
    const v = compileScenarioVisualPlan(s);
    if (!v.ok) throw new Error('visual refused');
    return v.plan;
  };
  const joinRules = (s: Scenario, audio: DialogueAudioPlan) =>
    joinScenarioPlayback(visualOf(s), audio, DEFAULT_DURATION_CONFIG, s.metadata.schemaVersion).errors.map((e) => e.ruleId);

  it('refuses an audio plan from a different scenario even though every scene and turn ID matches', () => {
    const s = getScheduleRiskScenario();
    const audio = clone(planDialogueAudio(s));
    audio.scenarioId = 'scenario-some-other';
    audio.projectId = 'project-some-other';
    const j = joinScenarioPlayback(visualOf(s), audio, DEFAULT_DURATION_CONFIG, s.metadata.schemaVersion);
    expect(j.plan).toBeNull();
    expect(j.errors.filter((e) => e.ruleId === 'playback.metadata_mismatch').map((e) => e.message).join(' ')).toMatch(/scenarioId.*projectId|projectId/s);
    // and the caption compiler refuses the same foreign plan
    const cr = compileScenarioCaptions(s, audio);
    expect(cr.success).toBe(false);
    if (!cr.success) expect(cr.findings.map((f) => f.ruleId)).toContain('SCP-001-SCENARIO-ID-MISMATCH');
  });

  it('refuses a target-format or language mismatch', () => {
    const s = getScheduleRiskScenario();
    const a = clone(planDialogueAudio(s));
    a.targetFormat = 'Long';
    expect(joinRules(s, a)).toContain('playback.metadata_mismatch');
    const cr = compileScenarioCaptions(s, a);
    expect(cr.success).toBe(false);
    const b = clone(planDialogueAudio(s));
    b.language = b.language === 'en' ? 'ar' : 'en';
    expect(joinRules(s, b)).toContain('playback.metadata_mismatch');
  });

  it('refuses reordered scenes and mismatched turns between the visual and audio plans', () => {
    const s = getProgressMeetingScenario();
    const a = clone(planDialogueAudio(s));
    [a.scenes[0], a.scenes[1]] = [a.scenes[1], a.scenes[0]];
    expect(joinRules(s, a)).toContain('playback.scene_mismatch');
    const b = clone(planDialogueAudio(s));
    b.scenes[1].clips.reverse();
    expect(joinRules(s, b)).toContain('playback.turn_mismatch');
  });

  it('refuses audio whose scene timing disagrees with the visual plan', () => {
    const s = getClaimVariationScenario();
    const a = clone(planDialogueAudio(s));
    a.scenes[2].endTimeSeconds += 0.5;
    expect(joinRules(s, a)).toContain('playback.scene_timing_mismatch');
    const b = clone(planDialogueAudio(s));
    b.clipCount += 1;
    expect(joinRules(s, b)).toContain('playback.clip_count_mismatch');
  });

  it('captions built from a differently-timed audio plan no longer line up with the manifest, and validation says so', () => {
    const s = getProgressMeetingScenario();
    const { playback, audio } = pipeline(s);
    const foreignAudio = planDialogueAudio(s, { durationConfig: { wordsPerMinute: 110 } });
    const cr = compileScenarioCaptions(s, foreignAudio);
    if (!cr.success) throw new Error(cr.error);
    // compiled for a different timeline: totals disagree with the manifest...
    expect(ms(cr.plan.totalDurationSeconds)).not.toBe(playback.totalDurationMs);
    // ...and validating them against the manifest's audio plan fails
    expect(validateScenarioCaptionPlan(cr.plan, s, audio).valid).toBe(false);
  });

  it('a playback manifest validated against a different scenario is rejected', () => {
    const { playback } = pipeline(getScheduleRiskScenario());
    const report = validateScenarioPlaybackPlan(playback, getProgressMeetingScenario());
    expect(report.valid).toBe(false);
    expect(report.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(['plan.scenario_id', 'scene.missing']));
  });

  it('public exports: the config resolver rejects unknown keys', () => {
    expect('error' in resolvePlaybackDurationConfig({ wordsPerMinut: 150 })).toBe(true);
  });
});
