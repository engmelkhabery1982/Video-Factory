/** LABEL01 pure layout regressions. Geometry/character assertions, not font-pixel or real-render evidence. */
import { describe, expect, it } from 'vitest';
import { validateGraphic } from '@buildtrack/core/visual';
import { actorBoxLabelTooSmall, layoutActorBoxLabel } from '../packages/video/src/graphics/actorBoxLabelLayout';
import { graphicSafeBox } from '../packages/video/src/graphics/graphicSafeBox';
import { proofActor } from './fixtures/graphic-proof-specs';

const labels = [
  ['max English', 'Four labels kept with all spaces intact.'],
  ['max Arabic', 'عمل '.repeat(10)],
  ['max identifier', 'OwnerLabel1234567890'.repeat(2)],
  ['Arabic marks/spaces', '  هٰذَا  صُنْدُوقٌ  مُهِمٌ  '],
  ['decomposed Latin / NBSP', '  Cafe\u0301  ID\u00a0A  '],
  ['graphemes', '👩🏽‍💻  👨‍👩‍👧‍👦  e\u0301  عَ'],
  ['only spaces', ' '.repeat(40)],
  ['wide characters', 'W'.repeat(40)],
] as const;
const geometry = [[0.02, 0.02], [0.02, 0.6], [0.6, 0.02], [0.16, 0.12], [0.6, 0.6]];
const scales = [0.2, 0.75, 1, 3];

for (const format of ['landscape', 'portrait'] as const) {
  describe(`actor label layout: ${format} (PURE)`, () => {
    it.each(labels)('preserves %s exactly and fits finite line boxes at all tested valid geometry/scale extremes', (_name, text) => {
      const portrait = format === 'portrait';
      const frame = graphicSafeBox(portrait ? 'short' : 'long', portrait ? 1080 : 1920, portrait ? 1920 : 1080);
      const graphic = proofActor(format);
      const object = graphic.objects.find((o) => o.id === 'box')!;
      const boundaries = new Set([0, ...Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text), (s) => s.index + s.segment.length)]);
      for (const [w, h] of geometry) for (const scale of scales) {
        Object.assign(object, { label: text, w, h, scale });
        expect(validateGraphic(graphic, { durationSec: 7, format, contentProfile: 'educational' })).toEqual([]);
        const boxWidth = w * frame.width * scale; const boxHeight = h * frame.height * scale;
        const layout = layoutActorBoxLabel(text, boxWidth, boxHeight, frame.height)!;
        expect(layout).toEqual(layoutActorBoxLabel(text, boxWidth, boxHeight, frame.height));
        expect(layout.lines.map((l) => l.text).join('')).toBe(text);
        expect(Number.isFinite(layout.fontSize) && layout.fontSize > 0).toBe(true);
        expect(layout.fontSize).toBeLessThanOrEqual(frame.height * 0.034);
        expect(Number.isFinite(layout.lineHeight) && layout.lineHeight > 0).toBe(true);
        expect(layout.paddingX).toBeGreaterThan(0); expect(layout.paddingY).toBeGreaterThan(0);
        let offset = 0;
        for (const line of layout.lines) {
          offset += line.text.length;
          expect(boundaries.has(offset)).toBe(true); // Never detach a diacritic, surrogate pair or ZWJ cluster.
          expect(Number.isFinite(line.width) && line.width > 0).toBe(true);
          expect(line.width).toBeLessThanOrEqual(layout.innerWidth + 1e-8);
          expect(line.top).toBeGreaterThanOrEqual(-boxHeight / 2 + layout.paddingY - 1e-8);
          expect(line.top + layout.lineHeight).toBeLessThanOrEqual(boxHeight / 2 - layout.paddingY + 1e-8);
          expect(line.baseline).toBeGreaterThan(line.top);
          expect(line.baseline).toBeLessThan(line.top + layout.lineHeight);
        }
        expect(actorBoxLabelTooSmall(object, graphic.actions, format)).toBe(layout.tooSmall);
      }
    });
  });
}

it('exercises the unchanged 40-character maximum, including spaces, without truncation', () => {
  expect(Array.from(labels[0][1])).toHaveLength(40);
  expect(Array.from(labels[1][1])).toHaveLength(40);
  expect(Array.from(labels[2][1])).toHaveLength(40);
});

it('prefers word boundaries, while a single long identifier still wraps without loss', () => {
  const words = layoutActorBoxLabel('alpha beta gamma delta', 180, 324, 1080)!;
  expect(words.lines.map((l) => l.text)).toEqual(['alpha ', 'beta ', 'gamma ', 'delta']);
  const identifier = layoutActorBoxLabel(labels[2][1], 80, 200, 1080)!;
  expect(identifier.lines.length).toBeGreaterThan(1);
  expect(identifier.lines.map((l) => l.text).join('')).toBe(labels[2][1]);
});

it('uses no 8px floor; warns about truly tiny text and keeps empty labels empty', () => {
  const tiny = layoutActorBoxLabel(labels[0][1], 1920 * 0.02 * 0.2, 1080 * 0.02 * 0.2, 1080)!;
  expect(tiny.fontSize).toBeLessThan(8); expect(tiny.tooSmall).toBe(true);
  const normal = layoutActorBoxLabel('Kit', 300, 150, 1080)!;
  expect(normal.fontSize).toBe(1080 * 0.034); expect(normal.tooSmall).toBe(false);
  const empty = layoutActorBoxLabel('', 5, 5, 1080)!;
  expect(empty.lines).toEqual([]); expect(empty.tooSmall).toBe(false);
});

it('allows extra vertical room for stacked combining marks, without normalizing or dropping them', () => {
  const text = `a${'\u0301'.repeat(39)}`;
  const layout = layoutActorBoxLabel(text, 10, 5, 1080)!;
  expect(layout.lines.map((l) => l.text).join('')).toBe(text);
  expect(layout.lines).toHaveLength(1);
  expect(layout.lineHeight).toBeLessThanOrEqual(layout.innerHeight + 1e-8);
  expect(layout.tooSmall).toBe(true);
});

it('accounts for animated scale without changing base geometry, actions, IDs or timing', () => {
  const graphic = proofActor('landscape');
  const box = { ...graphic.objects.find((o) => o.id === 'box')!, label: labels[0][1], w: 0.6, h: 0.4, scale: 1 };
  const actions = [{ id: 'small-box', targetId: box.id, property: 'scale' as const, from: 0.2, to: 3, startSec: 0.5, endSec: 2, easing: 'linear' as const }];
  const before = structuredClone({ box, actions });
  expect(actorBoxLabelTooSmall(box, [], 'landscape')).toBe(false);
  expect(actorBoxLabelTooSmall(box, actions, 'landscape')).toBe(true);
  expect({ box, actions }).toEqual(before);
});

it('leaves invalid draft geometry to the validator rather than emitting non-finite layout', () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    expect(layoutActorBoxLabel('Label', bad, 10, 1080)).toBeNull();
    expect(layoutActorBoxLabel('Label', 10, bad, 1080)).toBeNull();
  }
});
