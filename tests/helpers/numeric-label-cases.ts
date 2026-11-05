/** Shared PURE assertions, run by Vitest or by Node's built-in runner. No DOM/render substitutes. */
import assert from 'node:assert/strict';
import { buildNumericGraphic, buildKineticGraphic, buildProcessGraphic, exactValueLabel, graphicStateAt, validateGraphic, type EditorGraphic } from '@buildtrack/core/visual';
import { buildNumericValues, numericFormFrom } from '../../apps/web/src/lib/graphic-form';
import { actorBoxLabelDirection, layoutActorBoxLabel } from '../../packages/video/src/graphics/actorBoxLabelLayout';
import { layoutNumericLabels, numericLabelWarnings, type NumericTextPlacement, type NumericTextRegion } from '../../packages/video/src/graphics/numericLabelLayout';
import { graphicSafeBox } from '../../packages/video/src/graphics/graphicSafeBox';

export const LONG_CATEGORY = 'Four labels kept with all spaces intact.';
export function numericFixture(format: 'landscape' | 'portrait', direction: 'ltr' | 'rtl', extremes = false): EditorGraphic {
  const count = format === 'portrait' ? 4 : 6;
  const rows = Array.from({ length: count }, (_, i) => ({
    label: [LONG_CATEGORY, 'عمل '.repeat(10), 'W'.repeat(40), '  مُهِمّ  Cafe\u0301  ', 'Identifier1234567890'.repeat(2), 'Last category.'][i],
    value: ['1000000000', '12.3456', '0.0001', '0.30000000000000004', '0.0000001', '7.00'][i], unit: i % 2 ? 'سَاعَات' : 'WWWWWWWW',
  }));
  const g = buildNumericGraphic({ title: 'Synthetic comparison', scaleMax: '1000000000', rows }, format, 3, { direction });
  g.objects.forEach((o, i) => { o.label = rows[i].label; }); // Saved text may contain leading/trailing spaces.
  if (extremes) g.objects.forEach((o, i) => { o.x = 0.05 + i * (0.9 / (count - 1)); o.y = i % 2 ? 0.95 : 0.05; });
  return g;
}
const disjoint = (a: NumericTextRegion, b: NumericTextRegion) => a.left + a.width <= b.left + 1e-7 || b.left + b.width <= a.left + 1e-7 || a.top + a.height <= b.top + 1e-7 || b.top + b.height <= a.top + 1e-7;
function checkText(p: NumericTextPlacement, width: number, height: number) {
  const { region: r, layout: l } = p;
  assert.equal(l.lines.map((line) => line.text).join(''), p.text);
  assert(Number.isFinite(l.fontSize) && l.fontSize > 0);
  assert(r.left >= 0 && r.top >= 0 && r.left + r.width <= width + 1e-7 && r.top + r.height <= height + 1e-7);
  const boundaries = new Set([0, ...Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(p.text), (s) => s.index + s.segment.length)]);
  let offset = 0;
  for (const line of l.lines) {
    offset += line.text.length; assert(boundaries.has(offset));
    assert(line.width <= l.innerWidth + 1e-7);
    assert(line.top >= -r.height / 2 + l.paddingY - 1e-7);
    assert(line.top + l.lineHeight <= r.height / 2 - l.paddingY + 1e-7);
    assert(Number.isFinite(line.baseline) && line.baseline > line.top && line.baseline < line.top + l.lineHeight);
  }
}

export const numericLabelCases: Array<{ name: string; run: () => void }> = [
  { name: 'demonstrates the old fixed-font overflow/collision risk using accepted data', run: () => {
    const g = numericFixture('landscape', 'ltr');
    assert.deepEqual(validateGraphic(g, { durationSec: 3, format: 'landscape', contentProfile: 'educational' }), []);
    const width = 1728; const height = 810;
    const gap = (g.objects[1].x! - g.objects[0].x!) * width;
    assert(Array.from(g.objects[0].label!).length * height * 0.034 * 0.6 > gap);
    assert(Array.from(exactValueLabel(g.objects[0])).length * height * 0.05 * 0.6 > gap);
    assert(g.objects[0].x! * width - Array.from(g.objects[0].label!).length * height * 0.034 * 0.6 / 2 < 0);
  } },
];
for (const format of ['landscape', 'portrait'] as const) for (const direction of ['ltr', 'rtl'] as const) for (const extremes of [false, true]) {
  numericLabelCases.push({ name: `${format}/${direction}/${extremes ? 'frame edges' : 'columns'}: exact, finite, non-overlapping regions throughout animation`, run: () => {
    const g = numericFixture(format, direction, extremes); const before = structuredClone(g);
    assert.deepEqual(validateGraphic(g, { durationSec: 3, format, contentProfile: 'educational' }), []);
    const frame = graphicSafeBox(format === 'portrait' ? 'short' : 'long', format === 'portrait' ? 1080 : 1920, format === 'portrait' ? 1920 : 1080);
    const first = layoutNumericLabels(g, frame.width, frame.height, 0);
    for (const time of [0, 0.25, 1.5, 3]) {
      const placed = layoutNumericLabels(g, frame.width, frame.height, time);
      assert.equal(placed.length, g.objects.length);
      assert.deepEqual(placed, layoutNumericLabels(g, frame.width, frame.height, time));
      placed.forEach((bar, i) => {
        assert.equal(bar.id, g.objects[i].id); assert.equal(bar.category.text, g.objects[i].label);
        assert.equal(bar.value.text, exactValueLabel(g.objects[i]));
        assert(Math.abs(bar.category.region.left + bar.category.region.width / 2 - g.objects[i].x! * frame.width) < 1e-7);
        assert(Math.abs(bar.value.region.left + bar.value.region.width / 2 - g.objects[i].x! * frame.width) < 1e-7);
        checkText(bar.category, frame.width, frame.height); checkText(bar.value, frame.width, frame.height);
        assert(disjoint(bar.category.region, bar.value.region));
        const titleBand = { left: 0, top: frame.height * 0.075, width: frame.width, height: frame.height * 0.095 };
        assert(disjoint(bar.category.region, titleBand)); assert(disjoint(bar.value.region, titleBand));
        assert.equal(bar.category.layout.fontSize, first[i].category.layout.fontSize);
        assert.equal(bar.value.layout.fontSize, first[i].value.layout.fontSize);
        placed.slice(i + 1).forEach((peer) => assert(disjoint(bar.cell, peer.cell)));
      });
    }
    assert.deepEqual(g, before);
    assert.deepEqual(numericLabelWarnings(g, format).map((p) => p.id), layoutNumericLabels(g, frame.width, frame.height, 3)
      .filter((p) => p.category.layout.tooSmall || p.value.layout.tooSmall).map((p) => p.id));
    if (extremes) assert(numericLabelWarnings(g, format).length > 0);
  } });
}
numericLabelCases.push(
  { name: 'minimum valid separation on either axis, including shared X, remains finite and disjoint', run: () => {
    for (const format of ['landscape', 'portrait'] as const) for (const vertical of [false, true]) {
      const g = numericFixture(format, 'rtl'); g.objects = g.objects.slice(0, 2); g.actions = [];
      const spacing = format === 'portrait' ? 0.22 : 0.14;
      Object.assign(g.objects[0], { x: 0.4, y: 0.4 });
      Object.assign(g.objects[1], { x: vertical ? 0.4 : 0.4 + spacing + 1e-9, y: vertical ? 0.4 + spacing + 1e-9 : 0.4 });
      assert.deepEqual(validateGraphic(g, { durationSec: 3, format, contentProfile: 'educational' }), []);
      const placed = layoutNumericLabels(g, 1080, 1920);
      assert.equal(placed.length, 2); assert(disjoint(placed[0].cell, placed[1].cell));
      placed.forEach((p) => { checkText(p.category, 1080, 1920); checkText(p.value, 1080, 1920); });
    }
  } },
  { name: 'a baseline inside the title band still gets two finite, separate text regions', run: () => {
    const g = numericFixture('landscape', 'ltr'); g.objects = g.objects.slice(0, 2); g.actions = [];
    Object.assign(g.objects[0], { x: 0.4, y: 0.08 }); Object.assign(g.objects[1], { x: 0.4, y: 0.22 + 1e-9 });
    assert.deepEqual(validateGraphic(g, { durationSec: 3, format: 'landscape', contentProfile: 'educational' }), []);
    const labels = layoutNumericLabels(g, 1728, 810); assert.equal(labels.length, 2);
    const titleBand = { left: 0, top: 810 * 0.075, width: 1728, height: 810 * 0.095 };
    labels.forEach((p) => { checkText(p.category, 1728, 810); checkText(p.value, 1728, 810);
      assert(disjoint(p.category.region, p.value.region)); assert(disjoint(p.category.region, titleBand)); assert(disjoint(p.value.region, titleBand)); });
  } },
  { name: 'supplied progress/opacity actions and all their times survive layout/advisory unchanged', run: () => {
    const g = numericFixture('landscape', 'rtl');
    g.actions = [
      { id: 'owner-progress', targetId: 'bar1', property: 'progress', from: 0.3, to: 0.9, startSec: 0, endSec: 3, easing: 'ease_in' },
      { id: 'owner-opacity', targetId: 'bar1', property: 'opacity', from: 0, to: 1, startSec: 0, endSec: 3, easing: 'linear' },
    ];
    const original = structuredClone(g);
    for (const time of [0, 1.5, 3]) {
      assert.equal(layoutNumericLabels(g, 1728, 810, time).length, 6);
      numericLabelWarnings(g, 'landscape'); assert.deepEqual(g, original);
    }
    assert.deepEqual(buildNumericValues(numericFormFrom(g), 'landscape', 3, g), original);
  } },
  { name: 'preserves exactValueLabel precision, decimals, units and language-level bidi', run: () => {
    const g = numericFixture('landscape', 'rtl');
    const p = layoutNumericLabels(g, 1920, 1080);
    assert.equal(p[0].category.direction, 'ltr'); assert.equal(p[1].category.direction, 'rtl');
    assert.equal(p[0].value.direction, 'ltr'); assert.equal(p[1].value.direction, 'rtl');
    assert.equal(p[1].value.text, '12.3456 سَاعَات'); assert.equal(p[2].value.text, '0.0001 WWWWWWWW');
    assert.equal(p[3].value.text, '0.30000000000000004 سَاعَات'); assert.equal(p[4].value.text, '1e-7 WWWWWWWW');
    assert.equal(p[5].value.text, '7.00 سَاعَات');
  } },
  { name: 'numeric form no-op/label edits retain exact values, source IDs, positions, optional fields, palette and actions', run: () => {
    const g = numericFixture('landscape', 'rtl', true); g.background = '#123456'; g.title = '  Owner title  ';
    delete g.objects[2].decimals; delete g.objects[2].color; g.objects[5].unit = ' % ';
    g.objects[0].label = `  ${'W'.repeat(36)}  `; g.objects[0].id = 'owner-bar'; g.actions[0].targetId = 'owner-bar';
    const form = numericFormFrom(g);
    assert.equal(form.rows[1].value, '12.3456'); assert.equal(form.rows[2].value, '0.0001');
    assert.deepEqual(buildNumericValues(form, 'landscape', 3, g), g);
    form.rows[0].label = '  Updated category.  ';
    const edited = buildNumericValues(form, 'landscape', 3, g);
    assert.deepEqual(edited, { ...g, objects: g.objects.map((o, i) => i ? o : { ...o, label: form.rows[0].label }) });
    assert.deepEqual(graphicStateAt(g, 1.5).get('bar2'), graphicStateAt(edited, 1.5).get('bar2'));
    g.actions = []; assert.deepEqual(buildNumericValues(numericFormFrom(g), 'landscape', 3, g).actions, []);
  } },
  { name: 'removing a referenced row does not silently drop actions; unchanged validation refuses it', run: () => {
    const g = numericFixture('landscape', 'ltr'); const form = numericFormFrom(g);
    form.rows.splice(1, 1); const candidate = buildNumericValues(form, 'landscape', 3, g);
    assert.deepEqual(candidate.actions, g.actions);
    assert(validateGraphic(candidate, { durationSec: 3, format: 'landscape', contentProfile: 'educational' }).some((p) => p.includes('does not exist')));
    assert.deepEqual(candidate.objects.map((o) => o.id), g.objects.filter((_, i) => i !== 1).map((o) => o.id));
  } },
  { name: 'warnings are advisory, resolve for ordinary short text, and limits are not reduced', run: () => {
    const g = numericFixture('landscape', 'ltr', true); const before = structuredClone(g);
    assert(numericLabelWarnings(g, 'landscape').length > 0); assert.deepEqual(g, before);
    const ordinary = buildNumericGraphic({ title: '', scaleMax: '10', rows: [{ label: 'A', value: '7', unit: 'h' }, { label: 'B', value: '9.5', unit: 'h' }] }, 'landscape', 3);
    assert.deepEqual(numericLabelWarnings(ordinary, 'landscape'), []);
    ordinary.objects[0].label = 'W'.repeat(41);
    assert(validateGraphic(ordinary, { durationSec: 3, format: 'landscape', contentProfile: 'educational' }).some((p) => p.includes('40')));
  } },
  { name: 'retains the accepted actor bidi/layout and non-numeric families', run: () => {
    assert.equal(actorBoxLabelDirection('English punctuation!!', 'rtl'), 'ltr');
    assert.equal(actorBoxLabelDirection('هٰذَا صُنْدُوقٌ', 'ltr'), 'rtl');
    assert.deepEqual(layoutActorBoxLabel('  Exact actor label.  ', 150, 80, 1080), layoutActorBoxLabel('  Exact actor label.  ', 150, 80, 1080, 1080 * 0.034));
    const text = buildKineticGraphic({ title: '', items: ['one', 'two', 'three', 'four'] }, 'portrait', 3);
    const process = buildProcessGraphic({ title: '', items: ['راجع', 'احفظ'] }, 'landscape', 3, { direction: 'rtl' });
    for (const g of [text, process]) { const before = structuredClone(g); assert.deepEqual(layoutNumericLabels(g, 1920, 1080), []); assert.deepEqual(g, before); }
    assert(process.objects[0].x! > process.objects[1].x!);
  } },
);
