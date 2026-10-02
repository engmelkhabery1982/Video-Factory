/**
 * Child-process fixture for tests/acceptance-import-order.test.ts.
 *
 * Deliberately reproduces the PRE-FIX import order of the acceptance driver:
 * a STATIC import that (transitively) reaches
 * apps/api/src/services/platform.ts, evaluated before the isolated scratch is
 * assigned to BUILDTRAKE_DATA/BUILDTRAKE_OUTPUT.
 *
 * ESM hoists the static import above the assignments below, so platform.ts
 * freezes DATA_DIR/OUTPUT_DIR to the repository `data/` and `output/`
 * directories. The fixture prints the same JSON shape as driver-order.ts; the
 * mismatch between `declared*` and `dataDir`/`outputDir` is the regression
 * signature that the fixed driver must not produce.
 */

import path from 'node:path';

// The exact static import whose transitive product dependency caused the
// retry-7 preflight failure ("production state is missing").
import { probeAudioFile } from '../../../scripts/acceptance-audio-probe.js';

const scratch = path.join(process.cwd(), '.stills', 'final-acceptance');
process.env.BUILDTRAKE_DATA = path.join(scratch, 'data');
process.env.BUILDTRAKE_OUTPUT = path.join(scratch, 'output');
process.env.NODE_ENV = 'production';

const platform = await import('../../../apps/api/src/services/platform.js');
console.log(
  JSON.stringify({
    scratch,
    declaredDataDir: process.env.BUILDTRAKE_DATA ?? null,
    declaredOutputDir: process.env.BUILDTRAKE_OUTPUT ?? null,
    dataDir: platform.DATA_DIR,
    outputDir: platform.OUTPUT_DIR,
    probeLoaded: typeof probeAudioFile === 'function',
  }),
);
