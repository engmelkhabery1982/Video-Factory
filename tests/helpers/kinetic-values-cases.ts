/** KINETIC-VALUES01: synthetic, PURE edit-preservation cases; no rendering or owner-data access. */
import assert from 'node:assert/strict';
import { buildKineticGraphic, graphicProblems, listFormFrom, type ListForm } from '../../apps/web/src/lib/graphic-form';
import type { EditorGraphic } from '@buildtrack/core/visual';

type Format = 'landscape' | 'portrait';
export type KineticApply = (form: ListForm, format: Format, durationSec: number, previous: EditorGraphic | null) => EditorGraphic;
export function authoredKinetic(direction: 'ltr' | 'rtl', animated = true, durationSec = 3): EditorGraphic {
  return {
    schemaVersion: 1, kind: 'kinetic_text', title: '  Owner title / عنوان  ',
    background: '#182838', textColor: '#f1e6d2', accent: '#b35c7a', direction, scaleMax: null,
    objects: [
      { id: 'owner-first', type: 'word', text: '  First, English!  ', x: 0.18, y: 0.27, emphasis: 'normal', size: 0.065, color: '#aabbcc', opacity: 0.77, scale: 0.9 },
      { id: 'word2', type: 'word', text: '  مُهِمٌّ  الآن  ', x: 0.42, y: 0.53, emphasis: 'strong', size: 0.12, opacity: 0.88 },
      { id: 'word3', type: 'word', text: '  Cafe\u0301\u00a0done?  ', x: 0.78, y: 0.58, size: 0.055, color: '#ccbbaa', scale: 1.1 },
    ],
    actions: animated ? [
      { id: 'word1', targetId: 'owner-first', property: 'opacity', from: 0.35, to: 0.9, startSec: durationSec * 0.1, endSec: durationSec * 0.7, easing: 'ease_in' },
      { id: 'owner-scale', targetId: 'word3', property: 'scale', from: 0.65, to: 1.05, startSec: durationSec * 0.15, endSec: durationSec * 0.9, easing: 'ease_in_out' },
    ] : [],
  };
}
const json = (g: EditorGraphic) => JSON.stringify(g);
const valid = (g: EditorGraphic, format: Format) => assert.deepEqual(graphicProblems(g, 3, format, 'educational'), []);

export function kineticValuesCases(apply: KineticApply): Array<{ name: string; run: () => void; beforeFix?: boolean }> {
  const cases: Array<{ name: string; run: () => void; beforeFix?: boolean }> = [];
  for (const format of ['landscape', 'portrait'] as const) for (const direction of ['ltr', 'rtl'] as const) {
    for (const animated of [false, true]) cases.push({
      name: `${format}/${direction}/${animated ? 'supplied actions' : 'static'}: unchanged Apply is byte-identical JSON`,
      beforeFix: format === 'landscape' && direction === 'ltr' && !animated,
      run: () => {
        const g = authoredKinetic(direction, animated); valid(g, format); const original = json(g);
        g.objects.forEach(Object.freeze); g.actions.forEach(Object.freeze); Object.freeze(g.objects); Object.freeze(g.actions); Object.freeze(g);
        const result = apply(listFormFrom(g), format, 3, g);
        assert.equal(json(result), original); assert.equal(json(g), original); valid(result, format);
      },
    });
    cases.push({ name: `${format}/${direction}: one phrase edit changes only its exact text field`,
      beforeFix: format === 'landscape' && direction === 'ltr', run: () => {
        const g = authoredKinetic(direction); valid(g, format); const original = json(g); const form = listFormFrom(g);
        form.items[1] = '  تَغْيير!  Exact\u00a0text.  ';
        const expected = structuredClone(g); expected.objects[1].text = form.items[1];
        const result = apply(form, format, 3, g);
        assert.equal(json(result), json(expected)); assert.equal(json(g), original); valid(result, format);
      } });
  }
  cases.push(
    { name: 'list seeding retains exact strings and word identities without mutating source', run: () => {
      const g = authoredKinetic('rtl'); const original = json(g); const form = listFormFrom(g);
      assert.deepEqual(form.objectIds, g.objects.map((o) => o.id)); assert.deepEqual(form.items, g.objects.map((o) => o.text));
      assert.equal(form.title, g.title); assert.equal(json(g), original);
    } },
    { name: 'null/empty/exact titles survive no-op; explicit title edits change only title', run: () => {
      for (const title of [null, '', '  Exact title!  ']) for (const format of ['landscape', 'portrait'] as const) {
        const g = authoredKinetic('rtl', false); g.title = title; valid(g, format);
        const form = listFormFrom(g); assert.equal(json(apply(form, format, 3, g)), json(g));
        form.title = '  عُنوان جديد!  ';
        assert.equal(json(apply(form, format, 3, g)), json({ ...g, title: form.title }));
        if (title) { form.title = ''; assert.equal(json(apply(form, format, 3, g)), json({ ...g, title: null })); }
      }
    } },
  );
  for (const format of ['landscape', 'portrait'] as const) cases.push({
    name: `${format}: middle removal/insertion/append retains survivors and avoids object/action ID reuse`, run: () => {
      for (const insertMiddle of [false, true]) {
        const g = authoredKinetic('rtl'); valid(g, format); const original = json(g); const form = listFormFrom(g);
        form.items.splice(1, 1); form.objectIds!.splice(1, 1);
        const insertion = insertMiddle ? 1 : form.items.length;
        form.items.splice(insertion, 0, '  Added phrase!  '); form.objectIds!.splice(insertion, 0, undefined);
        const result = apply(form, format, 3, g); valid(result, format);
        assert.deepEqual(result.objects.filter((o) => ['owner-first', 'word3'].includes(o.id)), [g.objects[0], g.objects[2]]);
        assert.equal(result.objects[insertion].id, 'word4'); // word1 is an action ID; word2 was removed; word3 survives.
        assert.equal(result.objects[insertion].text, form.items[insertion]);
        assert.deepEqual(result.actions, g.actions); assert.equal(json(g), original);
        assert.equal(json(apply(listFormFrom(result), format, 3, result)), json(result));
      }
    },
  });
  cases.push(
    { name: 'linked removal plus replacement is refused by canonical validation, never retargeted or action-filtered', run: () => {
      const g = authoredKinetic('ltr');
      g.actions.unshift({ id: 'middle-hold', targetId: 'word2', property: 'opacity', from: 0.88, to: 0.88, startSec: 0, endSec: 3, easing: 'hold' });
      valid(g, 'landscape'); const original = json(g); const form = listFormFrom(g);
      form.items.splice(1, 1); form.objectIds!.splice(1, 1); form.items.push('  Replacement  ');
      const result = apply(form, 'landscape', 3, g);
      assert.deepEqual(result.actions, g.actions); assert(!result.objects.some((o) => o.id === 'word2'));
      assert(graphicProblems(result, 3, 'landscape', 'educational').some((p) => p.includes('word2') && p.includes('does not exist')));
      assert.equal(json(g), original);
    } },
    { name: 'explicit blank/overlong edits are refused without dropping a phrase or altering unrelated fields', run: () => {
      const g = authoredKinetic('ltr'); const form = listFormFrom(g);
      for (const text of ['   ', 'W'.repeat(41)]) {
        form.items[1] = text; const result = apply(form, 'landscape', 3, g);
        assert.equal(json(result), json({ ...g, objects: g.objects.map((o, i) => i === 1 ? { ...o, text } : o) }));
        assert(graphicProblems(result, 3, 'landscape', 'educational').length > 0);
      }
    } },
    { name: 'new graphics delegate unchanged to the existing builder, including its defaults and timing', run: () => {
      for (const format of ['landscape', 'portrait'] as const) {
        const form = { title: '  New title  ', items: ['  New phrase  ', '  مُهِمٌّ  '] };
        assert.equal(json(apply(form, format, 3, null)), json(buildKineticGraphic(form, format, 3)));
      }
    } },
    { name: 'addition does not silently relocate existing words to resolve a default-position collision', run: () => {
      const g = buildKineticGraphic({ title: '', items: ['First', 'Middle', 'Last'] }, 'landscape', 3); g.actions = [];
      const form = listFormFrom(g); form.items.splice(1, 1); form.objectIds!.splice(1, 1); form.items.push('New');
      const result = apply(form, 'landscape', 3, g);
      assert.deepEqual(result.objects.slice(0, 2), [g.objects[0], g.objects[2]]);
      assert(graphicProblems(result, 3, 'landscape', 'educational').some((p) => p.includes('too close')));
    } },
  );
  return cases;
}
