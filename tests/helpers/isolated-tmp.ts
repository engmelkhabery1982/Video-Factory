/**
 * ISOLATED PER-SUITE SCRATCH DIRECTORIES (test infrastructure only).
 *
 * Why this exists
 * ---------------
 * Several suites used to share the fixed scratch directory `.test-phase6b`
 * (and delete it in `beforeAll`). Under the normal vitest parallelism that is a
 * race: one suite removes the directory another suite is writing into, so the
 * full CI suite failed even though each affected suite passed in isolation.
 *
 * Each suite now creates its OWN unique directory and removes only that
 * directory. The directory is created under the gitignored `.stills/` tree and
 * is addressed by a REPO-RELATIVE path, because the production dialogue
 * pipeline (correctly) rejects absolute base paths.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/**
 * Create a unique, empty, repo-relative scratch directory for one suite.
 *
 * @param prefix short, stable, human-readable suite name (no path separators)
 * @returns the repo-relative POSIX path (e.g. `.stills/test-isolation/phase6b-render-ab12cd`)
 */
export function createIsolatedTmp(prefix: string): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '-');
  const parent = path.join(ROOT, '.stills', 'test-isolation');
  fs.mkdirSync(parent, { recursive: true });
  const abs = fs.mkdtempSync(path.join(parent, `${safePrefix}-`));
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  return rel;
}

/** Remove exactly the directory a suite created (never a shared path). */
export function cleanupIsolatedTmp(relativeDir: string): void {
  if (!relativeDir || path.isAbsolute(relativeDir)) return;
  if (!relativeDir.startsWith('.stills/test-isolation/')) return;
  fs.rmSync(path.join(ROOT, relativeDir), { recursive: true, force: true });
}
