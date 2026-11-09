// @vitest-environment happy-dom
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { buildProcessGraphic, graphicStateAt, pathPointAt } from '@buildtrack/core/visual';
import { ProceduralGraphicSvg } from '../../packages/video/src/graphics/ProceduralGraphicSvg';
import { layoutProcessLabels } from '../../packages/video/src/graphics/processLabelLayout';
import { graphicSafeBox } from '../../packages/video/src/graphics/graphicSafeBox';
import { GraphicValuesForm } from '../../apps/web/src/components/graphic/GraphicEditors';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null; let host: HTMLDivElement | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; });
const fixture = (format: 'landscape' | 'portrait', direction: 'ltr' | 'rtl') => {
  const g = buildProcessGraphic({ title: 'خطوات العمل', items: ['Exact English label with punctuation.  ', 'عمل '.repeat(10), 'W'.repeat(40), '  مُهِمّ  Cafe\u0301   '] }, format, 3, { direction });
  g.objects.filter((o) => o.type === 'node').forEach((o, i) => { o.label = ['Exact English label with punctuation.  ', 'عمل '.repeat(10), 'W'.repeat(40), '  مُهِمّ  Cafe\u0301   '][i]; });
  g.actions.push({ id: 'fade-step1', targetId: 'step1', property: 'opacity', from: .2, to: 1, startSec: 0, endSec: 3, easing: 'linear' });
  g.actions.push({ id: 'scale-step1', targetId: 'step1', property: 'scale', from: .8, to: 1.2, startSec: 0, endSec: 3, easing: 'linear' });
  return g;
};

for (const format of ['landscape', 'portrait'] as const) for (const direction of ['ltr', 'rtl'] as const) {
  it(`${format}/${direction}: SVG preserves labels, animated circles, path and marker at distinct actual times`, () => {
    const g = fixture(format, direction); const before = structuredClone(g);
    const frame = graphicSafeBox(format === 'portrait' ? 'short' : 'long', format === 'portrait' ? 1080 : 1920, format === 'portrait' ? 1920 : 1080);
    const nodes = g.objects.filter((o) => o.type === 'node');
    const placements = layoutProcessLabels(g, frame.width, frame.height);
    for (const time of [0, 1.5, 3]) {
      const box = document.createElement('div'); box.innerHTML = renderToStaticMarkup(<ProceduralGraphicSvg graphic={g} timeSec={time} width={frame.width} height={frame.height} />);
      const states = graphicStateAt(g, time);
      for (const p of placements) {
        const group = box.querySelector(`[data-process-node="${p.id}"]`)!; const s = states.get(p.id)!;
        const circle = group.querySelector('circle')!;
        expect(Number(circle.getAttribute('cx'))).toBe(s.x * frame.width);
        expect(Number(circle.getAttribute('cy'))).toBe(s.y * frame.height);
        expect(Number(circle.getAttribute('r'))).toBe(Math.min(frame.width, frame.height) * .035 * s.scale);
        expect(Number(group.getAttribute('opacity'))).toBe(s.opacity);
        const text = group.querySelector('text')!;
        expect(text.textContent).toBe(p.text); expect(text.getAttribute('direction')).toBe(p.direction);
        expect(text.getAttribute('unicode-bidi')).toBe('isolate'); expect(text.getAttribute('xml:space')).toBe('preserve');
        [...text.querySelectorAll('tspan')].forEach((span, i) => {
          expect(span.textContent).toBe(p.layout.lines[i].text);
          expect(Number(span.getAttribute('textLength'))).toBe(p.layout.lines[i].width);
          expect(Number(span.getAttribute('x'))).toBe(p.region.left + p.region.width / 2);
        });
      }
      expect(box.querySelector('polyline')!.getAttribute('points')).toBe(nodes.map((o) => `${o.x! * frame.width},${o.y! * frame.height}`).join(' '));
      const progress = states.get('marker')!.progress;
      if (progress > 0) {
        const point = pathPointAt(nodes.map((o) => ({ x: o.x!, y: o.y! })), progress);
        const marker = box.querySelector('svg > circle:last-of-type')!;
        expect(Number(marker.getAttribute('cx'))).toBe(point.x * frame.width);
        expect(Number(marker.getAttribute('cy'))).toBe(point.y * frame.height);
      }
    }
    expect(g).toEqual(before);
  });
}

it('existing process Apply/save payload preserves custom IDs/text/geometry/explicit static actions while warning nonblockingly', async () => {
  const g = fixture('portrait', 'rtl'); g.actions = [];
  g.objects.forEach((o, i) => { o.id = `owner-${i}`; if (o.type === 'node') o.scale = 3; });
  const changed = vi.fn(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<GraphicValuesForm technique="process_path" graphic={g} format="portrait" durationSec={3} profile="educational" onChange={changed} label="process-qa" />));
  expect(host.querySelector('[role="note"]')).not.toBeNull();
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="apply-values-process-qa"]')!.click());
  expect(changed).toHaveBeenLastCalledWith(g);
  await act(async () => {
    const field = host!.querySelector<HTMLInputElement>('[aria-label="process-qa step 1"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '  نص عربي محفوظ  ');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="apply-values-process-qa"]')!.click());
  expect(changed).toHaveBeenLastCalledWith({ ...g, objects: g.objects.map((o, i) => i ? o : { ...o, label: '  نص عربي محفوظ  ' }) });
});

it('removing a referenced step is visibly refused without silently deleting the action', async () => {
  const g = fixture('landscape', 'ltr'); const changed = vi.fn();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<GraphicValuesForm technique="process_path" graphic={g} format="landscape" durationSec={3} profile="educational" onChange={changed} label="process-qa" />));
  await act(async () => host!.querySelector('[aria-label="process-qa step 1"]')!.closest('.row')!.querySelector<HTMLButtonElement>('button')!.click());
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="apply-values-process-qa"]')!.click());
  expect(changed).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')!.textContent).toContain('step1');
  expect(g.actions.some((a) => a.targetId === 'step1')).toBe(true);
});
