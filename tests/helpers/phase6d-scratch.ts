/**
 * INDEPENDENT SCRATCH ROOTS FOR THE TWO PHASE 6D SUITES.
 *
 * The regression this prevents
 * ---------------------------
 * `tests/phase6d-delivery-package.test.ts` used to begin with a recursive delete
 * of the SHARED parent `.test-phase6d`:
 *
 *     fs.rmSync('.test-phase6d', { recursive: true, force: true });
 *
 * while `tests/phase6d-real-package.test.ts` synthesized its dialogue audio under
 * `.test-phase6d/real-audio`. Vitest runs test FILES in parallel worker
 * processes, so the delivery suite's `beforeAll` could delete the real suite's
 * audio tree while it was being written — a cross-suite scratch collision.
 *
 * Each suite now creates its OWN unique, empty root under the gitignored
 * `.stills/test-isolation/` tree and removes exactly that root when it finishes:
 *
 *     const SCRATCH_ROOT = createPhase6dScratch('delivery');   // .../phase6d-delivery-XXXX
 *     const AUDIO_SCRATCH = `${SCRATCH_ROOT}/audio`;
 *     ...
 *     afterAll(() => cleanupPhase6dScratch(SCRATCH_ROOT));
 *
 * The roots are repo-relative POSIX paths because the production dialogue
 * pipeline (correctly) rejects absolute base paths, and because the Phase 6D
 * package builder refuses package roots outside the repository.
 *
 * No suite may delete a path it did not create; `cleanupPhase6dScratch` delegates
 * to `cleanupIsolatedTmp`, which refuses anything outside the isolated tree.
 */

import { cleanupIsolatedTmp, createIsolatedTmp } from './isolated-tmp.js';

export type Phase6dScratchKind = 'delivery' | 'real';

/**
 * Create this suite's own unique, empty scratch root.
 *
 * @param kind which Phase 6D suite is asking (only its own files live there)
 * @returns repo-relative POSIX path, e.g. `.stills/test-isolation/phase6d-delivery-ab12cd`
 */
export function createPhase6dScratch(kind: Phase6dScratchKind): string {
  return createIsolatedTmp(`phase6d-${kind}`);
}

/**
 * Remove exactly the root this suite created — never a shared parent and never a
 * path outside `.stills/test-isolation/` (the delegate refuses those).
 */
export function cleanupPhase6dScratch(root: string): void {
  cleanupIsolatedTmp(root);
}

/**
 * True when neither root is the other and neither contains the other.
 *
 * The two Phase 6D suites must never nest inside a common parent that one of
 * them deletes; this is the invariant the isolation regression test asserts.
 */
export function scratchRootsAreIndependent(a: string, b: string): boolean {
  const norm = (p: string): string => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y || x === y) return false;
  return !x.startsWith(`${y}/`) && !y.startsWith(`${x}/`);
}
