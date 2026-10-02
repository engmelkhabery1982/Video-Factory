/**
 * REGRESSION — the acceptance driver must resolve its isolated scratch, never
 * the repository `data/` and `output/` directories.
 *
 * apps/api/src/services/platform.ts freezes DATA_DIR/OUTPUT_DIR from
 * BUILDTRAKE_DATA/BUILDTRAKE_OUTPUT at module load, and ESM hoists static
 * imports above the driver's environment assignment. A static import in the
 * driver that (transitively) reaches platform.ts therefore pins the product to
 * the repository directories — exactly what made the retry-7 preflight write
 * state under `.stills/final-acceptance/data` and then read `data/projects/…`,
 * failing gate D with "production state is missing".
 *
 * The driver is a CLI program (its module scope assigns the environment and its
 * entry runs on import), so it is inspected in a CHILD PROCESS. This file must
 * never import the driver in-process: that would freeze this process's
 * environment and leak into every other suite.
 *
 * The driver's module scope creates `<repo>/.stills/final-acceptance/{data,
 * output,stage}` and `EVIDENCE/final-product` (gitignored / already tracked).
 * They are intentionally NOT deleted here — deleting a shared scratch root from
 * one suite is the cross-suite race the Phase 6D suites just stopped doing.
 *
 * No product render, no TTS, no network.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DRIVER_PATH = path.join(REPO_ROOT, 'scripts', 'final-product-acceptance.ts');
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'acceptance-import-order');
const SCRATCH = path.join(REPO_ROOT, '.stills', 'final-acceptance');
const REPO_DATA = path.join(REPO_ROOT, 'data');
const REPO_OUTPUT = path.join(REPO_ROOT, 'output');

interface ProbeReport {
  scratch: string;
  declaredDataDir: string | null;
  declaredOutputDir: string | null;
  dataDir: string;
  outputDir: string;
  probeLoaded?: boolean;
}

/** Run one fixture in a child process and parse its single JSON report line. */
function runFixture(fixture: string): ProbeReport {
  const env = { ...process.env };
  delete env.BUILDTRAKE_DATA;
  delete env.BUILDTRAKE_OUTPUT;
  const child = spawnSync(process.execPath, ['--import', 'tsx', path.join(FIXTURE_DIR, fixture)], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(child.error, `${fixture}: spawn failed (${child.error?.message ?? 'unknown'})`).toBeUndefined();
  expect(
    child.status,
    `${fixture}: exit ${child.status}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  ).toBe(0);
  const line = child.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
  return JSON.parse(line) as ProbeReport;
}

/* ------------------------------------------------------------------ */
/*  Static import graph — no product module may be statically imported  */
/* ------------------------------------------------------------------ */

const STATIC_IMPORT_RE = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every local file reachable from `entry` through STATIC imports only. */
function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT_RE)) {
      const local = resolveLocal(file, match[1]);
      if (local !== null && !seen.has(local)) queue.push(local);
    }
  }
  return seen;
}

describe('acceptance driver import order', () => {
  it('never reaches product code through a static import', () => {
    const graph = staticGraph(DRIVER_PATH);
    // Sanity: the walker must actually follow imports, or this check is vacuous.
    expect(graph.size).toBeGreaterThanOrEqual(4);
    const productFiles = [...graph]
      .map((file) => path.relative(REPO_ROOT, file))
      .filter((file) => file.startsWith(`apps${path.sep}`));
    expect(
      productFiles,
      `static imports (hoisted above the scratch environment) must not reach product modules: ${productFiles.join(', ')}`,
    ).toEqual([]);
  });

  it('resolves DATA_DIR/OUTPUT_DIR to the isolated scratch for the driver module graph', () => {
    const report = runFixture('driver-order.ts');
    // The driver declares its scratch…
    expect(report.declaredDataDir).toBe(path.join(SCRATCH, 'data'));
    expect(report.declaredOutputDir).toBe(path.join(SCRATCH, 'output'));
    // …and the product module must resolve exactly that, not the repository dirs.
    expect(report.dataDir).toBe(report.declaredDataDir);
    expect(report.outputDir).toBe(report.declaredOutputDir);
    expect(report.dataDir).not.toBe(REPO_DATA);
    expect(report.outputDir).not.toBe(REPO_OUTPUT);
  });

  it('fails that expectation under the prior import order, so the guard has teeth', () => {
    const report = runFixture('legacy-order.ts');
    // The fixture genuinely loaded the probe that reaches platform.ts…
    expect(report.probeLoaded).toBe(true);
    // …declared the same scratch as the driver, and the product ignored it.
    expect(report.declaredDataDir).toBe(path.join(SCRATCH, 'data'));
    expect(report.dataDir).not.toBe(report.declaredDataDir);
    expect(report.outputDir).not.toBe(report.declaredOutputDir);
    expect(report.dataDir).toBe(REPO_DATA);
    expect(report.outputDir).toBe(REPO_OUTPUT);
  });
});
