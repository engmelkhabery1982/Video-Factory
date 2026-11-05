/** PURE regressions. The same assertions can run with Node when the dependency-based Vitest gate is unavailable. */
import { it, expect } from 'vitest';
import { exactValueLabel } from '@buildtrack/core/visual';
import { layoutNumericLabels } from '../packages/video/src/graphics/numericLabelLayout';
import { numericLabelCases, numericFixture } from './helpers/numeric-label-cases';
for (const { name, run } of numericLabelCases) it(name, run);

it.each(['landscape', 'portrait'] as const)('%s exact numeric token is never split into separate apparent numbers', (format) => {
  const graphic = numericFixture(format, 'rtl');
  for (const edges of [false, true]) {
    const candidate = edges ? numericFixture(format, 'rtl', true) : graphic;
    const placed = layoutNumericLabels(candidate, format === 'portrait' ? 936 : 1728, format === 'portrait' ? 1510 : 810, 2.65);
    for (const bar of candidate.objects) {
      const token = exactValueLabel({ ...bar, unit: undefined });
      expect(placed.find((item) => item.id === bar.id)!.value.layout.lines.some((line) => line.text.includes(token))).toBe(true);
    }
  }
});
