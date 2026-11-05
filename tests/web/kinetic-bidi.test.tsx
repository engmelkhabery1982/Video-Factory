// @vitest-environment happy-dom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ProceduralGraphicSvg } from '../../packages/video/src/graphics/ProceduralGraphicSvg';
import { authoredKinetic } from '../helpers/kinetic-values-cases';

for (const format of ['landscape', 'portrait'] as const) for (const direction of ['ltr', 'rtl'] as const) {
  it(`${format}/${direction}: kinetic words keep their own punctuation direction and exact whitespace`, () => {
    const graphic = authoredKinetic(direction);
    const before = structuredClone(graphic);
    const html = renderToStaticMarkup(<ProceduralGraphicSvg graphic={graphic} timeSec={0.6}
      width={format === 'portrait' ? 1080 : 1920} height={format === 'portrait' ? 1920 : 1080} />);
    const doc = new DOMParser().parseFromString(html, 'image/svg+xml');
    for (const word of graphic.objects) {
      const text = [...doc.querySelectorAll('text')].find((node) => node.textContent === word.text)!;
      expect(text).toBeDefined();
      expect(text.getAttribute('direction')).toBe(word.id === 'word2' ? 'rtl' : 'ltr');
      expect(text.getAttribute('unicode-bidi')).toBe('isolate');
      expect(text.getAttribute('xml:space')).toBe('preserve');
    }
    const title = [...doc.querySelectorAll('text')].find((node) => node.textContent === graphic.title)!;
    expect(title.getAttribute('direction')).toBe('ltr');
    expect(title.getAttribute('xml:space')).toBe('preserve');
    expect(graphic).toEqual(before);
  });
}
