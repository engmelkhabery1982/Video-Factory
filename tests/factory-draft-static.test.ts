/** Focused PURE regression cases; no historical suite or rendering. */
import { it } from 'vitest';
import { draftStaticCases } from './helpers/draft-static-cases';
for (const { name, run } of draftStaticCases) it(name, run);
