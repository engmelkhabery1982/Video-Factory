/** PURE regressions. The same assertions can run with Node when the dependency-based Vitest gate is unavailable. */
import { it } from 'vitest';
import { numericLabelCases } from './helpers/numeric-label-cases';
for (const { name, run } of numericLabelCases) it(name, run);
