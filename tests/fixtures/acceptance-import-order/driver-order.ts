/**
 * Child-process fixture for tests/acceptance-import-order.test.ts.
 *
 * Imports the REAL acceptance driver module exactly the way the CLI does
 * (`node --import tsx scripts/final-product-acceptance.ts <stage>`), then reads
 * the product module that the driver's scratch environment is supposed to
 * govern. Prints one JSON line:
 *
 *   { declaredDataDir, declaredOutputDir, dataDir, outputDir, exitCalls }
 *
 * `declared*` are the values the driver assigned to the environment; `dataDir`/
 * `outputDir` are what the product module actually resolved. This fixture must
 * be the ONLY kind of place that imports the driver outside the CLI: importing
 * it in-process would freeze the environment of the importing process.
 *
 * The driver runs its CLI entry on import. No stage is requested here (the
 * argument is deliberately unknown), so the entry stops at the stage lookup
 * with exit(2); `process.exit` is stubbed for the duration of the import so the
 * module scope under test can be observed without the CLI terminating the
 * probe. If the entry stops behaving that way, the fixture fails loudly
 * (exit 3) instead of silently drifting.
 */

import path from 'node:path';

const DRIVER_ENTRY_STOPPED = 'acceptance-import-order probe: driver entry stopped';

const realExit = process.exit;
const exitCalls: Array<number | string | null | undefined> = [];
process.exit = ((code?: number | string | null) => {
  exitCalls.push(code);
  throw new Error(DRIVER_ENTRY_STOPPED);
}) as typeof process.exit;
process.argv[2] = '__acceptance_import_order_probe__';

try {
  await import('../../../scripts/final-product-acceptance.js');
} catch (error) {
  if (!(error instanceof Error) || error.message !== DRIVER_ENTRY_STOPPED) throw error;
} finally {
  process.exit = realExit;
}

if (exitCalls.length !== 1 || exitCalls[0] !== 2) {
  console.error(
    `probe expected the driver entry to stop once with exit(2), saw ${JSON.stringify(exitCalls)}`,
  );
  process.exit(3);
}

const platform = await import('../../../apps/api/src/services/platform.js');
console.log(
  JSON.stringify({
    scratch: path.join(process.cwd(), '.stills', 'final-acceptance'),
    declaredDataDir: process.env.BUILDTRAKE_DATA ?? null,
    declaredOutputDir: process.env.BUILDTRAKE_OUTPUT ?? null,
    dataDir: platform.DATA_DIR,
    outputDir: platform.OUTPUT_DIR,
    exitCalls,
  }),
);
