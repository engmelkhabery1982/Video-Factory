/**
 * ISOLATION REGRESSION — the Phase 6D suites must not share a scratch parent.
 *
 * The bug this pins down
 * ----------------------
 * `tests/phase6d-delivery-package.test.ts` deleted the SHARED parent
 * `.test-phase6d` recursively in `beforeAll`, while
 * `tests/phase6d-real-package.test.ts` synthesized its dialogue audio under
 * `.test-phase6d/real-audio`. Vitest runs test FILES in parallel workers, so the
 * delete could land inside the other suite's synthesis.
 *
 * Two kinds of proof:
 *
 *   R1/R2  BEHAVIOURAL — with two suite roots created exactly the way the suites
 *          create them, deleting one root leaves the other suite's files
 *          byte-identical (both directions), including a nested
 *          `real-audio/<tag>/audio/canonical/...` layout.
 *   R3     REFUSAL — the cleanup helper never removes a shared/parent path it
 *          did not create (e.g. a `.test-phase6d` style shared directory).
 *   R4     STATIC — no test source deletes a shared `.test-phase6d` parent any
 *          more, and both Phase 6D suites actually use the isolated helper.
 *
 * No render, no network, no product code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupPhase6dScratch,
  createPhase6dScratch,
  scratchRootsAreIndependent,
} from './helpers/phase6d-scratch.js';

const REPO_ROOT = process.cwd();
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
/** This file necessarily NAMES the legacy shared path to assert its absence. */
const SELF = 'phase6d-scratch-isolation.test.ts';
const LEGACY_SHARED_PARENT = `${'.test-' + 'phase6d'}`;

const rootsToClean: string[] = [];
function freshRoot(kind: 'delivery' | 'real'): string {
  const root = createPhase6dScratch(kind);
  rootsToClean.push(root);
  return root;
}

function writeSentinel(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/**
 * Remove `//` line comments and block comments so the static checks look at LIVE
 * code only — a comment describing the old shared path is documentation.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Test sources that participate in the scratch contract (this file excluded). */
function otherTestSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of fs.readdirSync(TESTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.test.ts') || entry.name === SELF) continue;
    out.push({ file: entry.name, text: fs.readFileSync(path.join(TESTS_DIR, entry.name), 'utf8') });
  }
  return out;
}

afterAll(() => {
  for (const root of rootsToClean) cleanupPhase6dScratch(root);
});

describe('Phase 6D scratch isolation', () => {
  it('R1 — the two suites receive independent, non-nested roots', () => {
    const delivery = freshRoot('delivery');
    const real = freshRoot('real');

    expect(scratchRootsAreIndependent(delivery, real)).toBe(true);
    expect(scratchRootsAreIndependent(delivery, delivery)).toBe(false);
    expect(scratchRootsAreIndependent(real, `${real}/nested`)).toBe(false);
    expect(scratchRootsAreIndependent(`${delivery}/x`, delivery)).toBe(false);

    // Both roots live under the one isolated tree, so cleanup can never reach a
    // product or evidence path.
    for (const root of [delivery, real]) {
      expect(root.startsWith('.stills/test-isolation/')).toBe(true);
      expect(path.isAbsolute(root)).toBe(false);
    }
    expect(delivery).not.toBe(real);
  });

  it('R2 — removing one suite’s root leaves the other suite’s audio files byte-identical (both directions)', () => {
    const delivery = freshRoot('delivery');
    const real = freshRoot('real');

    // Delivery-suite layout: audio synthesis + ffmpeg fixtures + packages.
    writeSentinel(`${delivery}/audio/p6d-1/audio/canonical/turn-1.wav`, 'DELIVERY-CANONICAL-1');
    writeSentinel(`${delivery}/fixtures/long-ok.mp4`, 'DELIVERY-FIXTURE');
    writeSentinel(`${delivery}/packages/long/manifest/checksums.sha256`, 'DELIVERY-CHECKSUMS');

    // Real-suite layout: dialogue audio mirrored from the old collision.
    writeSentinel(`${real}/real-audio/real-1/audio/dialogue/turn-1.wav`, 'REAL-DIALOGUE-1');
    writeSentinel(`${real}/real-audio/real-2/audio/canonical/turn-9.wav`, 'REAL-CANONICAL-9');
    const realBefore = listFiles(real);
    const realBytesBefore = realBefore.map((f) => fs.readFileSync(`${real}/${f}`, 'utf8'));

    // The exact old failure mode: the DELIVERY suite starts (its beforeAll
    // used to delete the shared parent) while the REAL suite's audio exists.
    cleanupPhase6dScratch(delivery);

    expect(fs.existsSync(delivery)).toBe(false);
    expect(fs.existsSync(real)).toBe(true);
    expect(listFiles(real)).toEqual(realBefore);
    expect(realBefore.map((f) => fs.readFileSync(`${real}/${f}`, 'utf8'))).toEqual(realBytesBefore);

    // Now the reverse: the REAL suite finishing must not touch the delivery
    // suite's files (a fresh delivery root, mirroring a parallel run).
    const delivery2 = freshRoot('delivery');
    writeSentinel(`${delivery2}/packages/long/qc.json`, 'DELIVERY-2-QC');
    const delivery2Before = listFiles(delivery2).map((f) => fs.readFileSync(`${delivery2}/${f}`, 'utf8'));

    cleanupPhase6dScratch(real);

    expect(fs.existsSync(real)).toBe(false);
    expect(fs.existsSync(delivery2)).toBe(true);
    expect(listFiles(delivery2)).toEqual(['packages/long/qc.json']);
    expect(listFiles(delivery2).map((f) => fs.readFileSync(`${delivery2}/${f}`, 'utf8'))).toEqual(delivery2Before);
  });

  it('R3 — cleanup refuses any path outside the isolated tree (a shared parent is never deleted)', () => {
    // A `.test-phase6d`-style SHARED directory, exactly where the old code
    // pointed its recursive delete.
    const shared = path.join(REPO_ROOT, LEGACY_SHARED_PARENT);
    fs.mkdirSync(path.join(shared, 'real-audio', 'tag'), { recursive: true });
    writeSentinel(path.join(shared, 'real-audio', 'tag', 'turn.wav'), 'SHARED-MUST-SURVIVE');
    try {
      cleanupPhase6dScratch(LEGACY_SHARED_PARENT);
      cleanupPhase6dScratch(path.join(LEGACY_SHARED_PARENT, 'real-audio'));
      cleanupPhase6dScratch(path.join(REPO_ROOT, 'tests'));

      expect(fs.existsSync(shared)).toBe(true);
      expect(fs.readFileSync(path.join(shared, 'real-audio', 'tag', 'turn.wav'), 'utf8')).toBe('SHARED-MUST-SURVIVE');
      expect(fs.existsSync(path.join(REPO_ROOT, 'tests'))).toBe(true);
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });

  it('R4 — no test source deletes a shared `.test-phase6d` parent, and both Phase 6D suites use the isolated helper', () => {
    /*
     * (a) The shared parent is gone from every other test source's LIVE code.
     *     Comments may still describe the historical collision (that is
     *     documentation, not behaviour), so comments are stripped first.
     */
    const offenders = otherTestSources()
      .filter((s) => stripComments(s.text).includes(LEGACY_SHARED_PARENT))
      .map((s) => s.file);
    expect(offenders).toEqual([]);

    // (b) Both Phase 6D suites actually use the per-suite root helper and clean
    //     up exactly their own root.
    const delivery = otherTestSources().find((s) => s.file === 'phase6d-delivery-package.test.ts');
    const real = otherTestSources().find((s) => s.file === 'phase6d-real-package.test.ts');
    expect(delivery, 'the Phase 6D delivery suite must exist').toBeTruthy();
    expect(real, 'the Phase 6D real-package suite must exist').toBeTruthy();

    expect(delivery!.text).toContain("createPhase6dScratch('delivery')");
    expect(delivery!.text).toContain('cleanupPhase6dScratch(SCRATCH_ROOT)');
    expect(real!.text).toContain("createPhase6dScratch('real')");
    expect(real!.text).toContain('cleanupPhase6dScratch(AUDIO_SCRATCH_ROOT)');

    /*
     * (c) Neither suite may recursively delete a scratch parent it does not own.
     *     Every recursive delete is inspected: a literal path must be built from
     *     the suite's own root variable (never the shared parent), and an
     *     identifier must be one of the suite's own bindings — the per-suite
     *     scratch root, the suite's own `.stills/phase6d` render output, or a
     *     fresh `os.tmpdir()` path. The allowlist is asserted NON-EMPTY so this
     *     check can never pass vacuously.
     */
    const allowedDeleteTargets: Record<string, string[]> = {
      'phase6d-delivery-package.test.ts': ['SCRATCH_ROOT', 'outside'],
      'phase6d-real-package.test.ts': ['AUDIO_SCRATCH_ROOT', 'SCRATCH'],
    };
    for (const suite of [delivery!, real!]) {
      const code = stripComments(suite.text);
      const targets = [...code.matchAll(/fs\.rmSync\(\s*([^,]+?)\s*,\s*\{\s*recursive:\s*true/g)].map((m) => m[1].trim());
      expect(targets.length, `${suite.file} should still clean up its own scratch`).toBeGreaterThan(0);
      for (const target of targets) {
        const isLiteral = /^[`'"]/.test(target);
        if (isLiteral) {
          expect(target, `${suite.file} deletes a literal shared path: ${target}`).not.toContain(LEGACY_SHARED_PARENT);
          expect(target, `${suite.file} deletes a literal path it may not own: ${target}`).toMatch(/SCRATCH_ROOT/);
        } else {
          expect(
            allowedDeleteTargets[suite.file],
            `${suite.file} recursively deletes an unexpected binding: ${target}`,
          ).toContain(target);
        }
      }
      // The suite's own root bindings must themselves be per-suite roots.
      expect(code).toMatch(/const SCRATCH_ROOT = createPhase6dScratch\('delivery'\)|const AUDIO_SCRATCH_ROOT = createPhase6dScratch\('real'\)/);
      // ...and a non-per-suite repo path may only be this suite's own output dir.
      if (suite.file === 'phase6d-real-package.test.ts') {
        expect(code).toMatch(/const SCRATCH = path\.join\(process\.cwd\(\), '\.stills', 'phase6d'\)/);
      }
    }
  });
});
