/**
 * Phase 3B - Deterministic Scenario Visual-Plan Compiler.
 * Imports the new modules directly (exports are added later by integration).
 */
import { describe, expect, it } from 'vitest';
import { compileScenarioVisualPlan, SCENARIO_VISUAL_FORMAT_PROFILES } from '../packages/core/src/scenario/compile-visual-plan';
import { validateScenarioVisualPlan, resolveVisualCueSourceText } from '../packages/core/src/scenario/validate-visual-plan';
import type { ScenarioVisualPlan } from '../packages/core/src/scenario/visual-plan-types';
import type { Scenario } from '../packages/core/src/scenario/types';
import { estimateScenarioDuration } from '../packages/core/src/scenario/duration';
import { analyzeScenarioDiversity } from '../packages/core/src/scenario/diversity';
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

function compileOk(s: Scenario): ScenarioVisualPlan {
  const r = compileScenarioVisualPlan(s);
  if (!r.ok) throw new Error(`refused: ${r.errors.map((e) => e.ruleId).join(',')}`);
  return r.plan;
}

/** Schedule-risk fixture with a visual-only (no dialogue) scene inserted. */
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

const allCues = (p: ScenarioVisualPlan) => p.scenes.flatMap((s) => [...s.sceneCues, ...s.beats.flatMap((b) => b.cues)]);

describe('Phase 3B - compiles every canonical scenario', () => {
  it.each(FIXTURES)('1. %s compiles and validates against its source with zero errors', (_n, get) => {
    const s = get();
    const plan = compileOk(s);
    const v = validateScenarioVisualPlan(plan, s);
    expect(v.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(v.valid).toBe(true);
    expect(plan.scenarioId).toBe(s.metadata.id);
    expect(plan.projectId).toBe(s.metadata.projectId);
  });

  it('2. exactly one visual scene per source scene, same IDs, indices, purposes, locations and participants', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      expect(plan.scenes.map((x) => x.sourceSceneId)).toEqual(s.scenes.map((x) => x.id));
      plan.scenes.forEach((vs, i) => {
        const src = s.scenes[i];
        expect(vs.index).toBe(src.index);
        expect(vs.narrativePurpose).toBe(src.narrativePurpose);
        expect(vs.locationId).toBe(src.locationId);
        expect(vs.participantIds).toEqual(src.participantIds);
        expect(vs.turnIds).toEqual(src.turns.map((t) => t.id));
        expect(vs.speakerIds).toEqual([...new Set(src.turns.map((t) => t.speakerId))]);
      });
    }
  });

  it('3. every dialogue turn appears exactly once, with its speaker, text, intent and reaction target', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      const beats = plan.scenes.flatMap((x) => x.beats.filter((b) => b.kind === 'dialogue'));
      const srcTurns = s.scenes.flatMap((x) => x.turns);
      expect(beats.map((b) => b.turnId)).toEqual(srcTurns.map((t) => t.id));
      beats.forEach((b, i) => {
        expect(b.activeSpeakerId).toBe(srcTurns[i].speakerId);
        expect(b.spokenText).toBe(srcTurns[i].spokenText);
        expect(b.intent).toBe(srcTurns[i].intent);
        expect(b.reactingCharacterId).toBe(srcTurns[i].reactionTargetId ?? null);
        expect(b.cues.filter((c) => c.kind === 'dialogue').map((c) => c.text)).toEqual([srcTurns[i].spokenText]);
      });
    }
  });
});

describe('Phase 3B - determinism, stability, purity', () => {
  it('4. IDs are derived only from scenario / scene / turn IDs', () => {
    const s = getProgressMeetingScenario();
    const plan = compileOk(s);
    for (const vs of plan.scenes) {
      expect(vs.id).toBe(`${s.metadata.id}/${vs.sourceSceneId}`);
      for (const b of vs.beats) {
        if (b.kind === 'dialogue') expect(b.id).toBe(`${vs.id}/turn/${b.turnId}`);
        for (const c of b.cues) expect(c.id.startsWith(`${b.id}/cue/`)).toBe(true);
      }
    }
    const ids = [...plan.scenes.map((x) => x.id), ...plan.scenes.flatMap((x) => x.beats.map((b) => b.id)), ...allCues(plan).map((c) => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(plan)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // no timestamps
  });

  it('5. repeated compilation is byte-identical', () => {
    for (const [, get] of FIXTURES) {
      const a = JSON.stringify(compileScenarioVisualPlan(get()));
      const b = JSON.stringify(compileScenarioVisualPlan(get()));
      expect(a).toBe(b);
    }
  });

  it('6. JSON round-trip is stable and the parsed plan still validates', () => {
    const s = getClaimVariationScenario();
    const plan = compileOk(s);
    const text = JSON.stringify(plan);
    const parsed = JSON.parse(text) as ScenarioVisualPlan;
    expect(JSON.stringify(parsed)).toBe(text);
    expect(validateScenarioVisualPlan(parsed, s).valid).toBe(true);
  });

  it('7. never mutates the input scenario, and the plan shares no object references with it', () => {
    const s = getProgressMeetingScenario();
    const before = JSON.stringify(s);
    const plan = compileOk(s);
    expect(JSON.stringify(s)).toBe(before);
    // mutating the plan must not reach the source
    plan.scenes[1].production.shotType = 'wide';
    plan.scenes[2].evidence[0].numericFacts[0].value = -1;
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('Phase 3B - timing', () => {
  it('8. scene timing follows the Phase 3A estimator, is monotonic and starts at zero', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      const est = estimateScenarioDuration(s);
      expect(plan.scenes[0].startSeconds).toBe(0);
      plan.scenes.forEach((vs, i) => {
        expect(vs.durationSeconds).toBeCloseTo(est.scenes[i].totalSeconds, 6);
        if (i) expect(vs.startSeconds).toBeCloseTo(plan.scenes[i - 1].endSeconds, 6);
      });
      expect(plan.totalDurationSeconds).toBeCloseTo(est.totalSeconds, 6);
    }
  });

  it('9. scenes, beats and cues never overlap and stay inside their parents', () => {
    for (const [, get] of FIXTURES) {
      const plan = compileOk(get());
      let prev = 0;
      for (const vs of plan.scenes) {
        expect(vs.startSeconds).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = vs.endSeconds;
        let t = vs.startSeconds;
        for (const b of vs.beats) {
          expect(b.startSeconds).toBeGreaterThanOrEqual(t - 1e-9);
          expect(b.endSeconds).toBeLessThanOrEqual(vs.endSeconds + 1e-9);
          for (const c of b.cues) {
            expect(c.startSeconds).toBeGreaterThanOrEqual(b.startSeconds - 1e-9);
            expect(c.endSeconds).toBeLessThanOrEqual(b.endSeconds + 1e-9);
          }
          t = b.endSeconds;
        }
        expect(t).toBeCloseTo(vs.endSeconds, 6);
      }
    }
  });

  it('10. a visual-only scene is preserved with a timed visual beat and no invented dialogue', () => {
    const s = withVisualOnlyScene();
    const plan = compileOk(s);
    const vs = plan.scenes.find((x) => x.sourceSceneId === 'sc-sr-vis')!;
    expect(vs.visualOnly).toBe(true);
    expect(vs.turnIds).toEqual([]);
    expect(vs.beats.map((b) => b.kind)).toEqual(['visual_only', 'transition']);
    expect(vs.beats.every((b) => b.spokenText === null && b.activeSpeakerId === null)).toBe(true);
    expect(vs.durationSeconds).toBeCloseTo(2.5 + 0.6, 6);
    expect(vs.sceneCues.map((c) => [c.kind, c.text])).toEqual([
      ['scene_title', 'Cable Route Flyover'],
      ['b_roll', 'Drone pass along the cable trench'],
    ]);
    expect(validateScenarioVisualPlan(plan, s).valid).toBe(true);
  });
});

describe('Phase 3B - formats', () => {
  it('11. Long compiles landscape and Short compiles portrait, with format-specific limits', () => {
    const long = compileOk(getProgressMeetingScenario());
    const short = compileOk(getScheduleRiskScenario());
    expect(long.format).toEqual(SCENARIO_VISUAL_FORMAT_PROFILES.Long);
    expect(short.format).toEqual(SCENARIO_VISUAL_FORMAT_PROFILES.Short);
    expect(long.format.aspectRatio).toBe('16:9');
    expect(short.format.aspectRatio).toBe('9:16');
    expect(short.format.maxBulletsPerFrame).toBeLessThan(long.format.maxBulletsPerFrame);
  });

  it('12. reusable compiles format-neutral with the stricter limits; over-full frames are warned, not truncated', () => {
    const s = getProgressMeetingScenario();
    s.metadata.targetFormat = 'reusable';
    const cta = s.scenes[s.scenes.length - 1];
    cta.onScreenInfo = { ...(cta.onScreenInfo ?? {}), bulletPoints: ['Interim certificate issued at 42%', 'Retest cores within seven days', 'Reassess on retest', 'Weekly verification call'] };
    const plan = compileOk(s);
    expect(plan.format.orientation).toBe('format_neutral');
    expect(plan.findings.some((f) => f.ruleId === 'format.bullets_exceed_frame' && f.location.sceneId === cta.id)).toBe(true);
    const bullets = plan.scenes[plan.scenes.length - 1].sceneCues.filter((c) => c.kind === 'bullet_point').map((c) => c.text);
    expect(bullets).toEqual(cta.onScreenInfo.bulletPoints); // all four kept verbatim
  });

  it('13. the three fixtures keep their own visual patterns (no forced template)', () => {
    const plans = FIXTURES.map(([, g]) => compileOk(g()));
    const signature = (p: ScenarioVisualPlan) => p.scenes.map((x) => `${x.production.shotType}:${x.production.speakerFocus}:${x.narrativePurpose}`).join('>');
    expect(new Set(plans.map(signature)).size).toBe(3);
    expect(new Set(plans.map((p) => p.scenes.length)).size).toBeGreaterThan(1);
    // shots come from each scene's own direction
    for (const [, g] of FIXTURES) {
      const s = g();
      compileOk(s).scenes.forEach((vs, i) => vs.beats.forEach((b) => expect(b.shot.shotType).toBe(s.scenes[i].production.shotType)));
    }
  });
});

describe('Phase 3B - content fidelity', () => {
  it('14. evidence records and numeric facts are preserved exactly, on the scene and on the citing beat', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      for (const vs of plan.scenes) {
        for (const e of vs.evidence) {
          const src = s.evidence.find((x) => x.id === e.id)!;
          expect(e.numericFacts).toEqual(src.numericFacts);
          expect(e.claim).toBe(src.claim);
          expect(e.sourceRef).toBe(src.sourceRef);
        }
      }
      for (const turn of s.scenes.flatMap((x) => x.turns).filter((t) => t.evidenceId)) {
        const beat = plan.scenes.flatMap((x) => x.beats).find((b) => b.turnId === turn.id)!;
        const ev = beat.cues.find((c) => c.kind === 'evidence')!;
        expect(ev.source.evidenceId).toBe(turn.evidenceId);
        expect(ev.numericFacts).toEqual(s.evidence.find((e) => e.id === turn.evidenceId)!.numericFacts);
      }
    }
  });

  it('15. production directions and on-screen information are carried verbatim', () => {
    const s = getProgressMeetingScenario();
    const plan = compileOk(s);
    plan.scenes.forEach((vs, i) => {
      expect(vs.production).toEqual(s.scenes[i].production);
      expect(vs.onScreenInfo).toEqual(s.scenes[i].onScreenInfo ?? null);
    });
    const insert = plan.scenes[1].sceneCues.find((c) => c.kind === 'screen_insert_title')!;
    expect(insert.text).toBe(s.scenes[1].production.screenInsert!.title);
    expect(insert.assetRef).toBe('asset-iva-progress-chart');
  });

  it('16. no invented content: every cue resolves to the exact source text it claims', () => {
    for (const [, get] of FIXTURES) {
      const s = get();
      const plan = compileOk(s);
      const cues = allCues(plan);
      expect(cues.length).toBeGreaterThan(0);
      for (const c of cues) expect(resolveVisualCueSourceText(s, c.source)).toBe(c.text);
      for (const c of cues) if (c.kind !== 'evidence') expect(c.numericFacts).toBeUndefined();
    }
  });

  it('17. the validator catches an invented line, altered numbers and an absolute path', () => {
    const s = getProgressMeetingScenario();
    const a = compileOk(s);
    a.scenes[0].beats[0].cues[0].text = 'We are fully on schedule.';
    expect(validateScenarioVisualPlan(a, s).findings.map((f) => f.ruleId)).toContain('cue.text_changed');
    const b = compileOk(s);
    b.scenes[2].evidence[0].numericFacts[0].value += 1;
    expect(validateScenarioVisualPlan(b, s).findings.map((f) => f.ruleId)).toContain('evidence.changed');
    const c = compileOk(s);
    c.scenes[1].production.screenInsert!.assetRef = '/home/user/assets/chart.png';
    const rc = validateScenarioVisualPlan(c, s).findings.map((f) => f.ruleId);
    expect(rc).toContain('security.absolute_path');
    expect(rc).toContain('scene.production_changed');
  });
});

describe('Phase 3B - diversity', () => {
  it('18. Phase 3A repetition signals surface as warnings without rewriting dialogue', () => {
    const s = getProgressMeetingScenario();
    const plan = compileOk(s);
    const div = analyzeScenarioDiversity(s);
    expect(plan.diversity.overallDiversityScore).toBe(div.overallDiversityScore);
    const unjustified = [...div.consecutiveSpeakerRuns, ...div.repeatedSettingRuns, ...div.repeatedShotRuns, ...div.repeatedPurposeRuns].filter((r) => !r.isJustified).length;
    expect(plan.diversity.warnings.filter((w) => /^diversity\.(consecutive_speaker|repeated_setting|repeated_shot|repeated_purpose)$/.test(w.ruleId))).toHaveLength(unjustified);
    expect(plan.diversity.warnings.every((w) => w.severity === 'warning')).toBe(true);
  });

  it('19. an identical consecutive visual pattern is warned; approved dialogue and directions stay as written', () => {
    const s = getScheduleRiskScenario();
    s.scenes[1].production = clone(s.scenes[0].production);
    const before = s.scenes.flatMap((x) => x.turns.map((t) => t.spokenText));
    const plan = compileOk(s);
    expect(plan.diversity.warnings.map((w) => w.ruleId)).toContain('diversity.repeated_visual_pattern');
    expect(plan.scenes[1].production).toEqual(s.scenes[1].production); // not "fixed"
    expect(plan.scenes.flatMap((x) => x.beats.filter((b) => b.kind === 'dialogue').map((b) => b.spokenText))).toEqual(before);
    // a justification silences the warning
    s.scenes[1].justifications = { repeatedShot: 'Continuous war-room briefing' };
    expect(compileOk(s).diversity.warnings.map((w) => w.ruleId)).not.toContain('diversity.repeated_visual_pattern');
  });

  it('20. a repeated sentence (a Phase 3A error) is refused, never deduplicated by the compiler', () => {
    const s = getScheduleRiskScenario();
    s.scenes[2].turns[0].spokenText = s.scenes[0].turns[0].spokenText;
    const r = compileScenarioVisualPlan(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.ruleId)).toContain('RULE-016-REPEATED-SENTENCE');
  });
});

describe('Phase 3B - rejection', () => {
  it('21. an invalid source scenario is refused with a structured, deterministic result', () => {
    const s = getProgressMeetingScenario();
    s.scenes[1].turns[0].speakerId = 'char-nobody';
    const r1 = compileScenarioVisualPlan(s);
    const r2 = compileScenarioVisualPlan(clone(s));
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.plan).toBeNull();
    expect(r1.errors.length).toBeGreaterThan(0);
    expect(r1.errors.every((e) => e.severity === 'error' && typeof e.ruleId === 'string')).toBe(true);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('22. a structurally broken object is refused, not thrown', () => {
    expect(() => compileScenarioVisualPlan({} as Scenario)).not.toThrow();
    const r = compileScenarioVisualPlan({} as Scenario);
    expect(r.ok).toBe(false);
  });

  it('23. malformed plans are rejected without throwing', () => {
    const s = getScheduleRiskScenario();
    expect(validateScenarioVisualPlan(null as unknown as ScenarioVisualPlan, s).valid).toBe(false);
    expect(validateScenarioVisualPlan({ scenes: 'x' } as unknown as ScenarioVisualPlan, s).findings[0].ruleId).toBe('plan.malformed');
    const p = compileOk(s);
    (p as { planVersion: string }).planVersion = '9.9.9';
    p.scenes[0].endSeconds = p.scenes[0].startSeconds; // zero-length scene
    const rules = validateScenarioVisualPlan(p, s).findings.map((f) => f.ruleId);
    expect(rules).toContain('plan.version');
    expect(rules).toContain('timing.scene_invalid');
  });

  it('24. missing and duplicate scene references are reported', () => {
    const s = getProgressMeetingScenario();
    const missing = compileOk(s);
    missing.scenes.splice(2, 1);
    expect(validateScenarioVisualPlan(missing, s).findings.map((f) => f.ruleId)).toContain('scene.missing');
    const dup = compileOk(s);
    dup.scenes.splice(3, 0, clone(dup.scenes[2]));
    const rules = validateScenarioVisualPlan(dup, s).findings.map((f) => f.ruleId);
    expect(rules).toContain('scene.duplicate');
    expect(rules).toContain('turn.duplicate');
    expect(rules).toContain('id.duplicate');
  });

  it('25. missing, duplicate and foreign turn references are reported', () => {
    const s = getClaimVariationScenario();
    const missing = compileOk(s);
    missing.scenes[1].beats.splice(0, 1);
    expect(validateScenarioVisualPlan(missing, s).findings.map((f) => f.ruleId)).toContain('turn.missing');
    const dup = compileOk(s);
    dup.scenes[1].beats[1] = { ...clone(dup.scenes[1].beats[0]), index: 1 };
    expect(validateScenarioVisualPlan(dup, s).findings.map((f) => f.ruleId)).toContain('turn.duplicate');
    const foreign = compileOk(s);
    foreign.scenes[0].beats[0].turnId = s.scenes[2].turns[0].id; // a real turn, wrong scene
    expect(validateScenarioVisualPlan(foreign, s).findings.map((f) => f.ruleId)).toContain('turn.unknown');
  });

  it('26. overlapping scenes are reported', () => {
    const s = getProgressMeetingScenario();
    const p = compileOk(s);
    p.scenes[2].startSeconds -= 1;
    p.scenes[2].durationSeconds += 1;
    expect(validateScenarioVisualPlan(p, s).findings.map((f) => f.ruleId)).toContain('timing.overlap');
  });
});
