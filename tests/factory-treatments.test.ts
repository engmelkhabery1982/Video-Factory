/**
 * Core contract for visual-language treatments: technique and pacing differ per treatment, derived graphics use
 * only supplied words, religious content stays free of identity, and default timing is frame-free and bounded.
 * Code evidence only (no browser, no render). Fixtures are synthetic and labelled as such.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTreatments,
  classifyUnit,
  deriveGraphic,
  pacingFor,
  splitNarrationUnits,
  treatmentIdsFor,
  visualDecisionFor,
  type FactoryPlanUnit,
} from '../packages/core/src/factory/planning';
import {
  buildKineticGraphic,
  buildNumericGraphic,
  defaultGraphicActions,
  GRAPHIC_PACING_LABELS,
  phrasesFromNarration,
  stepsFromNarration,
  timedGraphic,
} from '../packages/core/src/index';
import { parseDraftCreate } from '../packages/core/src/factory/validation';
import { FactoryError } from '../packages/core/src/factory/contract';
import { DEFAULT_VISUAL_LANGUAGE_FOR_PROFILE, languageAllowsTechnique } from '../packages/core/src/visual-language';

const RELIGIOUS_SCRIPT = [
  'قال تعالى: "وَاعْتَصِمُوا بِحَبْلِ اللَّهِ جَمِيعًا"',
  'الاعتصام هنا جمع للقلوب على الخير.',
  'الصبر مفتاح الفرج في كل حال.',
  'تذكر أن الطمأنينة في الذكر.',
].join('\n');

const EDU_SCRIPT = [
  'Why does the pour keep failing?',
  'For example, the truck arrived late.',
  'Check the delivery window the night before.',
  'Confirm the crew at seven.',
].join('\n');

const PROMO_SCRIPT = [
  'Tired of late deliveries?',
  'Our customers cut waiting time by 40 percent.',
  'Book a slot in one minute.',
].join('\n');

function unitsOf(script: string, assetId: string | null = null): FactoryPlanUnit[] {
  return splitNarrationUnits(script).map((narration, i) => ({
    id: `u${String(i + 1).padStart(2, '0')}`,
    narration,
    language: /[\u0600-\u06FF]/.test(narration) ? 'ar' : 'en',
    speakerHint: null,
    assetId,
    startSec: null,
    endSec: null,
    locked: false,
  }));
}

const techniquesOf = (treatment: { scenes: Array<{ technique?: string | null }> }) => treatment.scenes.map((s) => s.technique ?? null).join(',');

describe('treatments differ in technique and pacing, not only in labels', () => {
  for (const [profile, script, language] of [
    ['educational', EDU_SCRIPT, 'motion_explainer'],
    ['religious', RELIGIOUS_SCRIPT, 'mixed'],
    ['promotional', PROMO_SCRIPT, 'mixed'],
  ] as const) {
    it(`${profile}: three treatments with distinct technique sequences and distinct pacing (fixture)`, () => {
      const units = unitsOf(script);
      const kinds = new Map<string, 'image' | 'video'>();
      const treatments = buildTreatments(profile, units, { orderLocked: true, assetKinds: kinds, visualLanguage: language, format: 'landscape' });
      expect(treatments).toHaveLength(3);
      expect(new Set(treatments.map(techniquesOf)).size).toBe(3);
      const pacings = treatmentIdsFor(profile).map((id) => pacingFor(profile, id));
      expect(new Set(pacings).size).toBe(3);
      // Narration, order and speakers are the same words in the same order in every treatment.
      for (const t of treatments) {
        expect(t.scenes.map((s) => s.narration)).toEqual(units.map((u) => u.narration));
        expect(t.scenes.map((s) => s.sourceUnitId)).toEqual(units.map((u) => u.id));
      }
    });

    it(`${profile}: the profile default language is a registered language that allows every technique it uses`, () => {
      const treatments = buildTreatments(profile, unitsOf(script), { visualLanguage: DEFAULT_VISUAL_LANGUAGE_FOR_PROFILE[profile], format: 'landscape' });
      for (const t of treatments) {
        for (const s of t.scenes) {
          if (s.technique) expect(languageAllowsTechnique(DEFAULT_VISUAL_LANGUAGE_FOR_PROFILE[profile], s.technique)).toBe(true);
        }
      }
    });
  }

  it('the legacy call (no visual language) carries no technique and no pacing, as before', () => {
    const treatments = buildTreatments('educational', unitsOf(EDU_SCRIPT));
    for (const t of treatments) {
      for (const s of t.scenes) {
        expect(s).not.toHaveProperty('technique');
        expect(s.visualDecision).not.toHaveProperty('pacing');
      }
    }
  });

  it('a language that does not allow a role technique gives null and says why, never a silent still', () => {
    const [t1] = buildTreatments('religious', unitsOf(RELIGIOUS_SCRIPT), { visualLanguage: 'kinetic_typography', format: 'landscape' });
    const passage = t1.scenes.find((s) => s.beat === 'passage_reading');
    expect(passage?.technique).toBeNull();
    expect(passage?.visualDecision.unexecuted.join(' ')).toMatch(/not part of this visual language/);
  });
});

describe('derived graphics use only the supplied words', () => {
  it('kinetic phrases are exact substrings of the supplied line, in order, with no added words', () => {
    const line = 'Why does the pour keep failing? Check the delivery window the night before.';
    const phrases = phrasesFromNarration(line)!;
    expect(phrases.join(' ')).toBe(line.replace(/\s+/g, ' ').trim());
  });

  it('a process path is built from the supplied clauses only', () => {
    expect(stepsFromNarration('Plan the pour, book the truck, confirm the crew')).toEqual(['Plan the pour', 'book the truck', 'confirm the crew']);
    const { graphic, reason } = deriveGraphic('process_path', 'Plan the pour, book the truck, confirm the crew', 'educational', 'landscape');
    expect(reason).toBeNull();
    expect(graphic!.objects.filter((o) => o.type === 'node').map((o) => o.label)).toEqual(['Plan the pour', 'book the truck', 'confirm the crew']);
    expect(graphic!.actions).toEqual([]);
  });

  it('a line with one clause gives no process and a reason, not an invented step', () => {
    const { graphic, reason } = deriveGraphic('process_path', 'Check the delivery window the night before.', 'educational', 'landscape');
    expect(graphic).toBeNull();
    expect(reason).toMatch(/two to six steps/);
  });

  it('numeric comparison is never derived from narration: values come from the owner', () => {
    const { graphic, reason } = deriveGraphic('numeric_comparison', 'Seven hours before, nine and a half after.', 'educational', 'landscape');
    expect(graphic).toBeNull();
    expect(reason).toMatch(/No values are invented/);
  });

  it('Arabic lines take right-to-left direction; English lines stay left-to-right', () => {
    const ar = deriveGraphic('kinetic_text', 'الصبر مفتاح الفرج في كل حال.', 'religious', 'landscape');
    expect(ar.graphic?.direction).toBe('rtl');
    const en = deriveGraphic('kinetic_text', 'Confirm the crew at seven.', 'educational', 'landscape');
    expect(en.graphic?.direction).toBe('ltr');
  });

  it('a religious passage with quotation marks is refused for kinetic text, with the reason shown', () => {
    const { graphic, reason } = deriveGraphic('kinetic_text', 'قال تعالى: "وَاعْتَصِمُوا"', 'religious', 'landscape');
    expect(graphic).toBeNull();
    expect(reason).toBeTruthy();
  });

  it('religious graphics never carry a BuildTrack identity, even in text the owner supplied', () => {
    const treatments = buildTreatments('religious', unitsOf(RELIGIOUS_SCRIPT), { visualLanguage: 'mixed', format: 'landscape' });
    for (const t of treatments) {
      expect(JSON.stringify(t)).not.toMatch(/buildtrack/i);
    }
  });
});

describe('default timing: measured reproduces the original defaults, pacing only changes timing', () => {
  it('measured numeric: two bars in an 8 s shot start at 0.4 s and 1.4 s, each 2 s long', () => {
    const g = buildNumericGraphic(
      { title: '', scaleMax: '10', rows: [{ label: 'A', value: '7', unit: 'h' }, { label: 'B', value: '9.5', unit: 'h' }] },
      'landscape',
      8,
    );
    expect(g.actions.map((a) => [a.targetId, a.startSec, a.endSec])).toEqual([
      ['bar1', 0.4, 2.4],
      ['bar2', 1.4, 3.4],
    ]);
  });

  it('every pacing keeps actions inside the shot and in order', () => {
    const g = buildKineticGraphic({ title: '', items: ['One', 'Two', 'Three', 'Four'] }, 'portrait', 9);
    for (const pacing of ['measured', 'brisk', 'held'] as const) {
      const actions = defaultGraphicActions(g, 9, pacing);
      expect(actions.length).toBe(4);
      for (const a of actions) {
        expect(a.startSec).toBeGreaterThanOrEqual(0);
        expect(a.endSec).toBeLessThanOrEqual(9);
        expect(a.endSec).toBeGreaterThan(a.startSec);
      }
    }
  });

  it('brisk finishes earlier than measured, and held finishes earlier than measured for a long shot', () => {
    const g = buildKineticGraphic({ title: '', items: ['One', 'Two', 'Three'] }, 'landscape', 12);
    const end = (p: 'measured' | 'brisk' | 'held') => Math.max(...defaultGraphicActions(g, 12, p).map((a) => a.endSec));
    expect(end('brisk')).toBeLessThan(end('measured'));
    expect(end('held')).toBeLessThan(end('measured'));
  });

  it('timedGraphic fills actions for a planned graphic and keeps actions the owner already set', () => {
    const planned = buildKineticGraphic({ title: '', items: ['One', 'Two'] }, 'landscape', null);
    expect(planned.actions).toEqual([]);
    const timed = timedGraphic(planned, 8, 'brisk');
    expect(timed.actions.length).toBe(2);
    const owned = { ...timed, actions: [{ ...timed.actions[0], startSec: 0.5 }] };
    expect(timedGraphic(owned, 8, 'held').actions[0].startSec).toBe(0.5);
  });

  it('pacing labels are plain words for the owner', () => {
    expect(GRAPHIC_PACING_LABELS.brisk).toMatch(/first half/);
  });
});

describe('visual decision carries pacing only for graphics, and the classifier is unchanged', () => {
  it('visualDecisionFor without pacing adds no pacing key (legacy shape)', () => {
    expect(visualDecisionFor({ intent: 'x', framing: 'full', motion: 'none' }, 'image')).toEqual({ framing: 'full', motion: 'none', unexecuted: [] });
  });

  it('classifyUnit still separates problem, example and action for educational lines', () => {
    expect(classifyUnit('educational', 'Why does the pour keep failing?')).toBe('problem');
    expect(classifyUnit('educational', 'For example, the truck arrived late.')).toBe('example');
  });
});

describe('create contract: visualLanguage is optional, validated, default null (negative cases included)', () => {
  const base = {
    contentProfile: 'educational',
    format: 'landscape',
    inputs: { brief: 'b', script: 'A line.', audioAssetId: null, visualAssetIds: [], storyboard: null },
  };

  it('absent or null gives null (legacy)', () => {
    expect(parseDraftCreate(base).visualLanguage ?? null).toBeNull();
    expect(parseDraftCreate({ ...base, visualLanguage: null }).visualLanguage ?? null).toBeNull();
  });

  it('a registered language is accepted', () => {
    expect(parseDraftCreate({ ...base, visualLanguage: 'kinetic_typography' }).visualLanguage).toBe('kinetic_typography');
  });

  it('an unknown language is refused with FACTORY_VALIDATION before any planning', () => {
    expect(() => parseDraftCreate({ ...base, visualLanguage: 'hologram' })).toThrow(FactoryError);
    expect(() => parseDraftCreate({ ...base, visualLanguage: 7 })).toThrow(FactoryError);
  });
});

describe('an example line is not a process sequence', () => {
  it('"For example, the truck arrived late." gives no process and an honest reason, never a marker as a step', () => {
    expect(stepsFromNarration('For example, the truck arrived late.')).toBeNull();
    const { graphic, reason } = deriveGraphic('process_path', 'For example, the truck arrived late.', 'educational', 'landscape');
    expect(graphic).toBeNull();
    expect(reason).toMatch(/introduces an example/);
  });

  it('a genuine sequence after a non-example lead is still a process', () => {
    expect(stepsFromNarration('Book the truck, confirm the crew, check the window')).toHaveLength(3);
  });
});

describe('a supplied picture or clip is kept; a planned graphic never replaces it silently', () => {
  it('a storyboard picture on a numeric or kinetic shot stays bound, as still image, with the replaced technique reported', () => {
    const units = unitsOf('Check the delivery window the night before.', 'fx-image');
    units[0].startSec = 0; units[0].endSec = 3;
    const [t] = buildTreatments('educational', units, { orderLocked: true, assetKinds: new Map([['fx-image', 'image']]), visualLanguage: 'motion_explainer', format: 'landscape' });
    const scene = t.scenes[0];
    expect(scene.assetId).toBe('fx-image');
    expect(scene.technique).toBe('still_image');
    expect(scene.graphic).toBeNull();
    expect(scene.assetOrigin).toBe('supplied');
    expect(scene.visualDecision.unexecuted.join(' ')).toMatch(/picture supplied for this shot is kept/);
  });

  it('a supplied clip is never labelled still image: it becomes footage with the clip kept', () => {
    const units = unitsOf('Confirm the crew at seven.', 'fx-clip');
    const [t] = buildTreatments('educational', units, { orderLocked: true, assetKinds: new Map([['fx-clip', 'video']]), visualLanguage: 'documentary_footage', format: 'landscape' });
    expect(t.scenes[0].assetId).toBe('fx-clip');
    expect(t.scenes[0].technique).toBe('footage_clip');
  });

  it('when the language does not allow the media technique, the picture is still kept and the shot says it has no technique', () => {
    const units = unitsOf('Confirm the crew at seven.', 'fx-image');
    const [t] = buildTreatments('educational', units, { orderLocked: true, assetKinds: new Map([['fx-image', 'image']]), visualLanguage: 'kinetic_typography', format: 'landscape' });
    expect(t.scenes[0].assetId).toBe('fx-image');
    expect(t.scenes[0].technique).toBeNull();
    expect(t.scenes[0].visualDecision.unexecuted.join(' ')).toMatch(/Still image .*is not part of this visual language/);
  });

  it('a row with no supplied picture still gets a planned graphic, never a bound picture', () => {
    const units = unitsOf('Confirm the crew at seven.');
    const [t] = buildTreatments('educational', units, { orderLocked: true, assetKinds: new Map(), visualLanguage: 'motion_explainer', format: 'landscape' });
    expect(t.scenes[0].assetId).toBeNull();
    expect(t.scenes[0].graphic).not.toBeNull();
  });
});

describe('legacy treatments (no visual language) keep their frozen visual output', () => {
  it('educational legacy treatments keep the pan, the slow push and the gap notes they had before languages', () => {
    const treatments = buildTreatments('educational', unitsOf(EDU_SCRIPT));
    const motions = treatments.flatMap((t) => t.scenes.map((s) => s.visualDecision.motion));
    expect(motions).toContain('pan_right');
    const withGaps = treatments.flatMap((t) => t.scenes.map((s) => s.visualDecision.unexecuted.join(' ')));
    expect(withGaps.join(' ')).toMatch(/per-step highlight|split view|card overlay/);
    const signatures = treatments.map((t) => JSON.stringify(t.scenes.map((s) => s.visualDecision.motion)));
    expect(new Set(signatures).size).toBeGreaterThan(1);
  });

  it('religious legacy reflections keep the slow push', () => {
    const [t1] = buildTreatments('religious', unitsOf(RELIGIOUS_SCRIPT));
    expect(t1.scenes.some((s) => s.visualDecision.motion === 'slow_push')).toBe(true);
  });
});
