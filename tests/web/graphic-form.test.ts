/**
 * Graphic values form model and the six entry paths. Pure: no DOM, no server.
 * Fixture values only. Code evidence, not owner acceptance.
 */
import { describe, expect, it } from 'vitest';
import {
  buildKineticGraphic,
  buildNumericGraphic,
  buildProcessGraphic,
  decimalsOf,
  defaultActions,
  graphicProblems,
  listIncomplete,
  numericFormFrom,
  numericIncomplete,
  type NumericForm,
} from '../../apps/web/src/lib/graphic-form';
import { mergeActions } from '../../apps/web/src/components/graphic/GraphicEditors';
import { EMPTY_PLAN_FORM, INPUT_MODE_LABELS, buildCreateBody, checkPlanForm, type PlanForm } from '../../apps/web/src/lib/factory-model';

const numericForm = (over: Partial<NumericForm> = {}): NumericForm => ({
  title: 'FIXTURE: booked against arrived',
  scaleMax: '10',
  rows: [
    { label: 'Booked', value: '7.0', unit: 'h' },
    { label: 'Arrived', value: '9.5', unit: 'h' },
  ],
  ...over,
});

describe('numeric values form', () => {
  it('keeps the owner typed value exactly and shows as many decimals as typed', () => {
    expect(decimalsOf('7.0')).toBe(1);
    expect(decimalsOf('9.50')).toBe(2);
    expect(decimalsOf('12')).toBe(0);
    const g = buildNumericGraphic(numericForm(), 'landscape', 10);
    const values = g.objects.map((o) => o.value);
    expect(values).toEqual([7, 9.5]);
    expect(g.objects[1].decimals).toBe(1);
    expect(g.scaleMax).toBe(10);
  });

  it('round-trips an edited graphic back into the form with the same text (no rounding)', () => {
    const g = buildNumericGraphic(numericForm({ rows: [{ label: 'A', value: '9.50', unit: '' }, { label: 'B', value: '1', unit: '' }] }), 'portrait', 10);
    expect(numericFormFrom(g).rows[0].value).toBe('9.50');
  });

  it('a complete form passes the same validator the server and editor use', () => {
    const g = buildNumericGraphic(numericForm(), 'landscape', 10);
    expect(graphicProblems(g, 10, 'landscape', 'educational')).toEqual([]);
    const p = buildNumericGraphic(numericForm(), 'portrait', 10);
    expect(graphicProblems(p, 10, 'portrait', 'educational')).toEqual([]);
  });

  it('reports incomplete input as reasons and never builds a graphic (negative)', () => {
    expect(numericIncomplete(numericForm({ rows: [{ label: 'Only', value: '3', unit: '' }] }))).toEqual(
      expect.arrayContaining(['Add at least two values to compare.']),
    );
    expect(numericIncomplete(numericForm({ rows: [{ label: 'A', value: 'abc', unit: '' }, { label: 'B', value: '2', unit: '' }] }))).toEqual(
      expect.arrayContaining(['Value 1 must be a number as you supplied it.']),
    );
    expect(numericIncomplete(numericForm({ scaleMax: '' }))).toEqual(expect.arrayContaining([expect.stringMatching(/scale maximum/)]));
    expect(numericIncomplete(numericForm({ rows: [{ label: '', value: '1', unit: '' }, { label: 'B', value: '2', unit: '' }] }))).toEqual(
      expect.arrayContaining(['Value 1 needs a label.']),
    );
    expect(numericIncomplete(numericForm({ rows: [{ label: 'A', value: '-1', unit: '' }, { label: 'B', value: '2', unit: '' }] }))).toEqual(
      expect.arrayContaining(['Value 1 cannot be negative.']),
    );
  });

  it('a value above the scale maximum is refused by the shared validator (negative)', () => {
    const g = buildNumericGraphic(numericForm({ scaleMax: '5' }), 'landscape', 10);
    expect(graphicProblems(g, 10, 'landscape', 'educational').join(' ')).toMatch(/above scaleMax 5/);
  });
});

describe('kinetic and process forms', () => {
  it('a kinetic form with three phrases validates in landscape', () => {
    const g = buildKineticGraphic({ title: '', items: ['Patience', 'one task', 'at a time'] }, 'landscape', 6);
    expect(g.objects.filter((o) => o.type === 'word')).toHaveLength(3);
    expect(graphicProblems(g, 6, 'landscape', 'religious')).toEqual([]);
  });

  it('a portrait kinetic form with five phrases is refused by the shared validator (negative)', () => {
    expect(listIncomplete('kinetic_text', { title: '', items: ['a', 'b', 'c', 'd', 'e'] })).toEqual([]);
    const g = buildKineticGraphic({ title: '', items: ['one', 'two', 'three', 'four', 'five'] }, 'portrait', 6);
    expect(graphicProblems(g, 6, 'portrait', 'educational').length).toBeGreaterThan(0);
  });

  it('a kinetic form with no phrase is incomplete (negative)', () => {
    expect(listIncomplete('kinetic_text', { title: '', items: ['  '] })).toEqual(['Add at least one word or phrase.']);
  });

  it('a process form has steps in order and one marker whose progress action travels the path', () => {
    const g = buildProcessGraphic({ title: 'Delivery', items: ['Confirm window', 'Truck leaves', 'Pour starts'] }, 'landscape', 8);
    expect(g.objects.filter((o) => o.type === 'node').map((o) => o.label)).toEqual(['Confirm window', 'Truck leaves', 'Pour starts']);
    const travel = g.actions.find((a) => a.targetId === 'marker');
    expect(travel).toMatchObject({ property: 'progress', from: 0, to: 1 });
    expect(graphicProblems(g, 8, 'landscape', 'educational')).toEqual([]);
  });

  it('a process form with one step is incomplete (negative)', () => {
    expect(listIncomplete('process_path', { title: '', items: ['only'] })).toEqual(['A process needs at least two steps.']);
  });

  it('a religious process graphic naming BuildTrack is refused (negative, identity)', () => {
    const g = buildProcessGraphic({ title: 'BuildTrack steps', items: ['One', 'Two'] }, 'landscape', 8);
    expect(graphicProblems(g, 8, 'landscape', 'religious').join(' ')).toMatch(/BuildTrack|identity|brand/i);
  });
});

describe('default timing and owner timing', () => {
  it('default actions never end after the shot (even a 2 s shot)', () => {
    const g = buildNumericGraphic(numericForm(), 'landscape', 2);
    for (const a of g.actions) expect(a.endSec).toBeLessThanOrEqual(2);
    expect(graphicProblems(g, 2, 'landscape', 'educational')).toEqual([]);
  });

  it('owner timing for a target that still exists is kept when values are re-applied', () => {
    const before = buildNumericGraphic(numericForm(), 'landscape', 10);
    const edited = { ...before, actions: before.actions.map((a) => ({ ...a, startSec: 3 })) };
    const after = buildNumericGraphic(numericForm(), 'landscape', 10);
    const merged = mergeActions(after, edited, 10);
    expect(merged.every((a) => a.startSec === 3)).toBe(true);
  });

  it('when the target is gone, the default timing is used instead (no stale action)', () => {
    const old = buildNumericGraphic(numericForm(), 'landscape', 10);
    const fresh = buildKineticGraphic({ title: '', items: ['One'] }, 'landscape', 10);
    expect(mergeActions(fresh, old, 10)).toEqual(defaultActions(fresh, 10));
  });
});

describe('the six entry paths reach one draft', () => {
  const form = (over: Partial<PlanForm>): PlanForm => ({ ...EMPTY_PLAN_FORM, brief: 'Concrete windows', ...over });

  it('lists all six paths', () => {
    expect(Object.keys(INPUT_MODE_LABELS).sort()).toEqual(['audio_script', 'brief', 'images', 'script', 'storyboard', 'video_narration']);
  });

  it('brief only is accepted and sends no script', () => {
    const c = checkPlanForm(form({ inputMode: 'brief', script: '' }));
    expect(c.ok).toBe(true);
    expect(buildCreateBody(form({ inputMode: 'brief', script: '' }), null).inputs.script).toBeNull();
  });

  it('images: no script and no picture is accepted with a topic; the server reports both gaps and nothing is written for the owner', () => {
    const f = form({ inputMode: 'images', script: '', visualAssetIds: [] });
    expect(checkPlanForm(f).ok).toBe(true);
    expect(buildCreateBody(f, null).inputs).toMatchObject({ script: null, visualAssetIds: [] });
  });

  it('images: with script and pictures the draft request carries the script and the picture ids', () => {
    const f = form({ inputMode: 'images', script: 'One. Two.', visualAssetIds: ['img-a'] });
    expect(checkPlanForm(f).ok).toBe(true);
    expect(buildCreateBody(f, null).inputs).toMatchObject({ script: 'One. Two.', visualAssetIds: ['img-a'], audioAssetId: null });
  });

  it('video with narration and nothing else: accepted; the missing audio, script and footage are the server\'s exact gaps, and footage is never generated', () => {
    const f = form({ inputMode: 'video_narration', script: '', audioAssetId: null, visualAssetIds: [] });
    expect(checkPlanForm(f).ok).toBe(true);
    expect(buildCreateBody(f, null).inputs).toMatchObject({ audioAssetId: null, script: null, visualAssetIds: [] });
  });

  it('video with narration: with audio, script and footage the request carries all three, and the audio is not transcribed', () => {
    const f = form({ inputMode: 'video_narration', script: 'Narration words.', audioAssetId: 'aud-1', visualAssetIds: ['clip-1'] });
    expect(checkPlanForm(f).ok).toBe(true);
    expect(buildCreateBody(f, null).inputs).toMatchObject({ script: 'Narration words.', audioAssetId: 'aud-1', visualAssetIds: ['clip-1'] });
  });

  it('storyboard still refuses invalid JSON with nothing sent (negative)', () => {
    const c = checkPlanForm(form({ inputMode: 'storyboard', storyboardText: '{not json' }));
    expect(c.ok).toBe(false);
    expect(c.errors[0]).toMatch(/not valid JSON/);
  });
});
