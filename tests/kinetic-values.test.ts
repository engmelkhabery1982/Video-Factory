/** PURE value-edit regressions only; no historical layout/render suite. */
import { it } from 'vitest';
import { buildKineticValues } from '../apps/web/src/lib/graphic-form';
import { kineticValuesCases } from './helpers/kinetic-values-cases';
for (const { name, run } of kineticValuesCases(buildKineticValues)) it(name, run);
