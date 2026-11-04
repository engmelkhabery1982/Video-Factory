// @vitest-environment happy-dom
/** LABEL01: SVG markup and inspector DOM only. No browser, font-pixel measurement, MP4 or rendering acceptance. */
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { graphicStateAt, type EditorGraphic } from '@buildtrack/core/visual';
import { ProceduralGraphicSvg } from '../../packages/video/src/graphics/ProceduralGraphicSvg';
import { graphicSafeBox } from '../../packages/video/src/graphics/graphicSafeBox';
import { layoutActorBoxLabel } from '../../packages/video/src/graphics/actorBoxLabelLayout';
import { EditorGraphicPanel } from '../../apps/web/src/components/editor/EditorGraphicPanel';
import { fixtureDocument } from '../../apps/web/src/lib/editor-fixture';
import type { EditorOperation } from '../../apps/web/src/lib/editor-types';
import { proofActor } from '../fixtures/graphic-proof-specs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; });
const maxEnglish = 'Four labels kept with all spaces intact.';
const markedArabic = '  هٰذَا  صُنْدُوقٌ  مُهِمٌ  ';

for (const format of ['landscape', 'portrait'] as const) {
  describe(`actor label ${format} (SVG markup / DOM)`, () => {
    it.each([['ltr', maxEnglish], ['rtl', 'عمل '.repeat(10)], ['rtl', markedArabic], ['ltr', '  Cafe\u0301  ID\u00a0A  '], ['rtl', 'ID123عَمَل'.repeat(3)]])('keeps exact %s text, whitespace and diacritics in positioned tspans without altering geometry/actions', (direction, text) => {
      const graphic = proofActor(format); graphic.direction = direction as 'ltr' | 'rtl';
      const box = graphic.objects.find((o) => o.id === 'box')!;
      Object.assign(box, { label: text, w: 0.04, h: 0.03, rotation: 25 });
      graphic.actions.push({ id: 'box-scale', targetId: box.id, property: 'scale', from: 0.2, to: 3, startSec: 0, endSec: 3, easing: 'linear' });
      const original = structuredClone(graphic);
      const portrait = format === 'portrait';
      const frame = graphicSafeBox(portrait ? 'short' : 'long', portrait ? 1080 : 1920, portrait ? 1920 : 1080);
      for (const timeSec of [0, 1.5, 3]) {
        const svg = renderToStaticMarkup(<ProceduralGraphicSvg graphic={graphic} timeSec={timeSec} width={frame.width} height={frame.height} />);
        const container = document.createElement('div'); container.innerHTML = svg;
        const label = container.querySelector('[data-actor-box-label="box"]')!;
        const state = graphicStateAt(graphic, timeSec).get('box')!;
        const w = box.w! * frame.width * state.scale; const h = box.h! * frame.height * state.scale;
        const layout = layoutActorBoxLabel(text, w, h, frame.height)!;
        const spans = [...label.querySelectorAll('tspan')];
        expect(label.textContent).toBe(text); expect(spans.map((s) => s.textContent).join('')).toBe(text);
        expect(label.getAttribute('direction')).toBe(direction); expect(label.getAttribute('unicode-bidi')).toBe('isolate');
        expect(label.getAttribute('xml:space')).toBe('preserve'); expect(label.getAttribute('style')).toContain('white-space:pre');
        expect(Number(label.getAttribute('font-size'))).toBe(layout.fontSize);
        expect(spans).toHaveLength(layout.lines.length);
        spans.forEach((span, i) => {
          expect(span.getAttribute('direction')).toBe(direction);
          expect(span.getAttribute('lengthAdjust')).toBe('spacingAndGlyphs');
          expect(Number(span.getAttribute('textLength'))).toBe(layout.lines[i].width);
          expect(Number(span.getAttribute('x'))).toBe(state.x * frame.width);
          expect(Number(span.getAttribute('y'))).toBe(state.y * frame.height + layout.lines[i].baseline);
        });
        const rect = label.parentElement!.querySelector('rect')!;
        expect(Number(rect.getAttribute('width'))).toBe(w); expect(Number(rect.getAttribute('height'))).toBe(h);
        expect(label.parentElement!.getAttribute('transform')).toBe(`rotate(25 ${state.x * frame.width} ${state.y * frame.height})`);
        expect(graphic).toEqual(original);
      }
    });
  });
}

async function inspector(graphic: EditorGraphic, format: 'landscape' | 'portrait' = 'landscape') {
  const doc = fixtureDocument('label-qa', 'long'); doc.format = format;
  const clip = { ...doc.visualClips[0], technique: 'actor_action' as const, graphic, sourceAssetId: null, sourceInSec: null, sourceOutSec: null };
  doc.visualClips[0] = clip;
  const stage = vi.fn((_operations: EditorOperation[]) => []);
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<EditorGraphicPanel document={doc} clip={clip} disabled={false} stage={stage} />));
  return stage;
}
async function input(name: string, value: string) {
  await act(async () => {
    const field = host!.querySelector<HTMLInputElement>(`input[aria-label="clip-vc_01 actor box ${name}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const warning = () => host!.querySelector('[data-testid="actor-label-warning-clip-vc_01-box"]');
const apply = async () => act(async () => (host!.querySelector('[data-testid="apply-actor-clip-vc_01"]') as HTMLButtonElement).click());

it.each(['landscape', 'portrait'] as const)('shows an advisory for tiny %s boxes, keeps Apply allowed, and never mutates text/geometry/timing automatically', async (format) => {
  const graphic = proofActor(format);
  Object.assign(graphic.objects.find((o) => o.id === 'box')!, { label: markedArabic, w: 0.02, h: 0.02, scale: 0.2 });
  graphic.direction = 'rtl';
  const before = structuredClone(graphic); const stage = await inspector(graphic, format);
  expect(warning()?.textContent).toContain('Enlarge the box or shorten the label');
  expect(warning()?.getAttribute('role')).toBe('note');
  expect(stage).not.toHaveBeenCalled();
  await apply();
  expect(stage).toHaveBeenCalledTimes(1);
  const operations = stage.mock.calls[0][0] as unknown as Array<{ changes: Record<string, unknown> }>;
  expect(operations).toHaveLength(1); expect(operations[0].changes.graphic).toEqual(before);
  expect(operations[0].changes).not.toHaveProperty('durationSec'); expect(operations[0].changes).not.toHaveProperty('startSec');
  expect(graphic).toEqual(before);
  // Warning updates on raw draft geometry, before Apply; only the owner edits these fields.
  await input('w', '0.6'); await input('h', '0.6'); await input('scale', '1');
  expect(warning()).toBeNull(); expect(stage).toHaveBeenCalledTimes(1); expect(graphic).toEqual(before);
  await input('w', '0.02'); await input('h', '0.02'); await input('scale', '0.2');
  expect(warning()).not.toBeNull();
  await input('label', ''); expect(warning()).toBeNull();
});

it('warns for a small animated scale and keeps 40 characters/validation separate from readability', async () => {
  const graphic = proofActor('landscape');
  Object.assign(graphic.objects.find((o) => o.id === 'box')!, { label: maxEnglish, w: 0.6, h: 0.4, scale: 1 });
  graphic.actions.push({ id: 'scale-small', targetId: 'box', property: 'scale', from: 0.2, to: 3, startSec: 0.5, endSec: 2, easing: 'linear' });
  const stage = await inspector(graphic);
  expect(warning()).not.toBeNull();
  await apply(); expect(stage).toHaveBeenCalledTimes(1);
  await input('label', `${maxEnglish}!`); await apply();
  expect(stage).toHaveBeenCalledTimes(1);
  expect(host!.textContent).toContain('longer than 40 characters');
  expect(warning()?.getAttribute('role')).toBe('note');
});
