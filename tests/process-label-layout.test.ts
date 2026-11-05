import { expect, it } from 'vitest';
import { buildProcessGraphic, graphicProblems, type EditorGraphic } from '@buildtrack/core/visual';
import { buildProcessValues, listFormFrom } from '../apps/web/src/lib/graphic-form';
import { layoutProcessLabels } from '../packages/video/src/graphics/processLabelLayout';

export function processFixture(format: 'landscape' | 'portrait', direction: 'ltr' | 'rtl', edges = false): EditorGraphic {
  const labels = ['Exact English label with punctuation.  ', 'عمل '.repeat(10), 'W'.repeat(40), '  مُهِمّ  Cafe\u0301   ', 'Review the quantities carefully.', 'احفظ ثم راجع جميع الخطوات.'];
  const g = buildProcessGraphic({ title: 'اختبار خطوات المسار', items: labels.slice(0, format === 'portrait' ? 4 : 6) }, format, 3, { direction });
  const nodes = g.objects.filter((o) => o.type === 'node');
  nodes.forEach((o, i) => { o.label = labels[i]; if (edges) { o.x = .05 + i * .9 / (nodes.length - 1); o.y = i % 2 ? .95 : .05; } });
  return g;
}

it('demonstrates the old fixed-font overflow on valid forty-character process labels', () => {
  const g = processFixture('landscape', 'ltr');
  expect(graphicProblems(g, 3, 'landscape', 'educational')).toEqual([]);
  const nodes = g.objects.filter((o) => o.type === 'node');
  expect(nodes[2].label!.length * 810 * .034 * .6).toBeGreaterThan(Math.abs(nodes[1].x! - nodes[2].x!) * 1728);
});

it('vertical process labels sit beside the path instead of drawing the travelling line through their letters', () => {
  const g = processFixture('portrait', 'rtl');
  const width = 936; const height = 1510;
  for (const p of layoutProcessLabels(g, width, height)) {
    const pathX = g.objects.find((o) => o.id === p.id)!.x! * width;
    expect(p.region.left > pathX || p.region.left + p.region.width < pathX).toBe(true);
  }
});

for (const format of ['landscape', 'portrait'] as const) for (const direction of ['ltr', 'rtl'] as const) for (const edges of [false, true]) {
  it(`${format}/${direction}/${edges}: exact graphemes stay inside disjoint frame/title regions without data changes`, () => {
    const g = processFixture(format, direction, edges); const before = structuredClone(g);
    expect(graphicProblems(g, 3, format, 'educational')).toEqual([]);
    const width = format === 'portrait' ? 936 : 1728; const height = format === 'portrait' ? 1510 : 810;
    const p = layoutProcessLabels(g, width, height);
    expect(p).toHaveLength(g.objects.filter((o) => o.type === 'node').length);
    for (const item of p) {
      const { region: r, layout: l } = item;
      expect(l.lines.map((line) => line.text).join('')).toBe(g.objects.find((o) => o.id === item.id)!.label);
      expect(r.left).toBeGreaterThanOrEqual(0); expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.left + r.width).toBeLessThanOrEqual(width); expect(r.top + r.height).toBeLessThanOrEqual(height);
      expect(r.top + r.height <= height * .075 + 1e-7 || r.top >= height * .17 - 1e-7).toBe(true);
      expect(l.fontSize).toBeGreaterThan(0); expect(Number.isFinite(l.fontSize)).toBe(true);
      const boundaries = new Set([0, ...Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(item.text), (s) => s.index + s.segment.length)]);
      let offset = 0;
      for (const line of l.lines) {
        offset += line.text.length; expect(boundaries.has(offset)).toBe(true);
        expect(line.width).toBeLessThanOrEqual(l.innerWidth + 1e-7);
        expect(line.top).toBeGreaterThanOrEqual(-r.height / 2 + l.paddingY - 1e-7);
        expect(line.top + l.lineHeight).toBeLessThanOrEqual(r.height / 2 - l.paddingY + 1e-7);
      }
      for (const other of p.filter((o) => o.id !== item.id)) {
        const b = other.region;
        expect(r.left + r.width <= b.left + 1e-7 || b.left + b.width <= r.left + 1e-7 || r.top + r.height <= b.top + 1e-7 || b.top + b.height <= r.top + 1e-7).toBe(true);
      }
    }
    expect(g).toEqual(before);
  });
}

it('Apply preserves custom IDs, marker, whitespace, positions, colours, scales and actions; deletion keeps references to be visibly refused', () => {
  const g = processFixture('landscape', 'rtl');
  g.actions.push({ id: 'owner-step-fade', targetId: g.objects[0].id, property: 'opacity', from: .2, to: 1, startSec: 0, endSec: 2, easing: 'linear' });
  g.objects.forEach((o, i) => { const old = o.id; o.id = `owner-${i}`; g.actions.forEach((a) => { if (a.targetId === old) a.targetId = o.id; }); });
  g.objects[0].color = '#123456'; g.objects[0].scale = .8;
  const form = listFormFrom(g); const before = structuredClone(g);
  expect(buildProcessValues(form, 'landscape', 3, g)).toEqual(before);
  const edited = buildProcessValues({ ...form, items: form.items.map((t, i) => i ? t : '  نص جديد كامل  ') }, 'landscape', 3, g);
  expect(edited).toEqual({ ...before, objects: before.objects.map((o, i) => i ? o : { ...o, label: '  نص جديد كامل  ' }) });
  const removed = buildProcessValues({ ...form, items: form.items.slice(1), objectIds: form.objectIds!.slice(1) }, 'landscape', 3, g);
  expect(removed.actions).toEqual(before.actions);
  expect(graphicProblems(removed, 3, 'landscape', 'educational').some((r) => r.includes('owner-0'))).toBe(true);
  expect(g).toEqual(before);
});

it('new steps get unique IDs without renumbering survivors; explicit static actions remain empty', () => {
  const g = buildProcessGraphic({ title: '', items: ['One', 'Two'] }, 'landscape', 3); g.actions = [];
  g.objects[0].id = 'step3';
  const f = listFormFrom(g);
  const next = buildProcessValues({ ...f, items: [...f.items, '  Three  '] }, 'landscape', 3, g);
  expect(next.objects.filter((o) => o.type === 'node').map((o) => o.id)).toEqual(['step3', 'step2', 'step1']);
  expect(next.actions).toEqual([]);
  expect(next.objects.find((o) => o.id === 'step1')!.label).toBe('  Three  ');
});

it.each(['landscape', 'portrait'] as const)('%s near-minimum spacing and animated scale keep text allocated without moving nodes', (format) => {
  const g = buildProcessGraphic({ title: 'Title', items: ['W'.repeat(40), 'عمل '.repeat(10)] }, format, 3);
  g.objects[0].x = .3; g.objects[1].x = .3 + (format === 'portrait' ? .220001 : .140001);
  g.objects[0].y = g.objects[1].y = .5;
  g.actions.push({ id: 'large-node', targetId: 'step1', property: 'scale', from: .2, to: 3, startSec: 0, endSec: 3, easing: 'linear' });
  expect(graphicProblems(g, 3, format, 'educational')).toEqual([]);
  const p = layoutProcessLabels(g, 936, 1510);
  expect(p).toHaveLength(2); expect(p[0].region.left + p[0].region.width).toBeLessThanOrEqual(p[1].region.left);
  expect(p.map((l) => l.layout.lines.map((line) => line.text).join(''))).toEqual(g.objects.filter((o) => o.type === 'node').map((o) => o.label));
});
