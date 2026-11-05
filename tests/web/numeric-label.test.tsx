// @vitest-environment happy-dom
/** NUMERIC-LABEL01: SVG markup and inspector DOM assertions, NOT font-pixel/render acceptance. */
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { graphicStateAt } from '@buildtrack/core/visual';
import { ProceduralGraphicSvg } from '../../packages/video/src/graphics/ProceduralGraphicSvg';
import { layoutNumericLabels } from '../../packages/video/src/graphics/numericLabelLayout';
import { graphicSafeBox } from '../../packages/video/src/graphics/graphicSafeBox';
import { GraphicValuesForm } from '../../apps/web/src/components/graphic/GraphicEditors';
import { numericFixture } from '../helpers/numeric-label-cases';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; });

for (const format of ['landscape', 'portrait'] as const) for (const direction of ['ltr', 'rtl'] as const) {
  it(`${format}/${direction} SVG retains exact strings, bounded tspans and unchanged animated bar geometry`, () => {
    const graphic = numericFixture(format, direction); const before = structuredClone(graphic);
    const frame = graphicSafeBox(format === 'portrait' ? 'short' : 'long', format === 'portrait' ? 1080 : 1920, format === 'portrait' ? 1920 : 1080);
    for (const timeSec of [0, 1.5, 3]) {
      const svg = document.createElement('div');
      svg.innerHTML = renderToStaticMarkup(<ProceduralGraphicSvg graphic={graphic} timeSec={timeSec} width={frame.width} height={frame.height} />);
      const state = graphicStateAt(graphic, timeSec);
      const placed = layoutNumericLabels(graphic, frame.width, frame.height, timeSec);
      placed.forEach((bar, i) => {
        const group = svg.querySelector(`[data-numeric-bar="${bar.id}"]`)!;
        const s = state.get(bar.id)!; const o = graphic.objects[i];
        const barHeight = frame.height * 0.52 * (o.value! / graphic.scaleMax!) * s.progress;
        const barWidth = Math.min(frame.width, frame.height) * 0.11;
        const rect = group.querySelector('rect')!;
        expect(Number(rect.getAttribute('x'))).toBe(s.x * frame.width - barWidth / 2);
        expect(Number(rect.getAttribute('y'))).toBe(s.y * frame.height - barHeight);
        expect(Number(rect.getAttribute('width'))).toBe(barWidth);
        expect(Number(rect.getAttribute('height'))).toBe(Math.max(0, barHeight));
        expect(Number(group.getAttribute('opacity'))).toBe(s.opacity);
        for (const role of ['value', 'category'] as const) {
          const label = group.querySelector(`[data-numeric-text="${role}"]`)!; const p = bar[role];
          expect(label.textContent).toBe(p.text);
          expect(label.getAttribute('direction')).toBe(p.direction);
          expect(label.getAttribute('unicode-bidi')).toBe('isolate');
          expect(label.getAttribute('xml:space')).toBe('preserve');
          expect(label.getAttribute('style')).toContain('white-space:pre');
          expect(Number(label.getAttribute('font-size'))).toBe(p.layout.fontSize);
          const spans = [...label.querySelectorAll('tspan')]; expect(spans).toHaveLength(p.layout.lines.length);
          spans.forEach((span, j) => {
            expect(span.textContent).toBe(p.layout.lines[j].text);
            expect(span.getAttribute('lengthAdjust')).toBe('spacingAndGlyphs');
            expect(Number(span.getAttribute('textLength'))).toBe(p.layout.lines[j].width);
            expect(Number(span.getAttribute('x'))).toBe(p.region.left + p.region.width / 2);
            expect(Number(span.getAttribute('y'))).toBe(p.region.top + p.region.height / 2 + p.layout.lines[j].baseline);
          });
        }
      });
    }
    expect(graphic).toEqual(before);
  });
}

it.each(['landscape', 'portrait'] as const)('%s inspector warns nonblockingly and applies the exact saved chart without rebuilding it', async (format) => {
  const graphic = numericFixture(format, 'rtl', true); graphic.actions = [];
  const original = structuredClone(graphic); const changed = vi.fn();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<GraphicValuesForm kind="numeric_comparison" graphic={graphic} format={format} durationSec={3}
    profile="educational" disabled={false} onChange={changed} label="numeric-qa" />));
  expect(host.querySelectorAll('[role="note"]').length).toBeGreaterThan(0);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('[aria-label="numeric-qa value 2 number"]')!.value).toBe('12.3456');
  expect(host.querySelector<HTMLInputElement>('[aria-label="numeric-qa value 3 number"]')!.value).toBe('0.0001');
  const apply = host.querySelector<HTMLButtonElement>('[data-testid="apply-values-numeric-qa"]')!;
  expect(apply.disabled).toBe(false); expect(changed).not.toHaveBeenCalled();
  await act(async () => apply.click());
  expect(changed).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledWith(original); expect(graphic).toEqual(original);
  await act(async () => {
    const field = host!.querySelector<HTMLInputElement>('[aria-label="numeric-qa value 1 label"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '  Edited category.  ');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => apply.click());
  expect(changed).toHaveBeenLastCalledWith({ ...original, objects: original.objects.map((o, i) => i ? o : { ...o, label: '  Edited category.  ' }) });
});
