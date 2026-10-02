/**
 * REGRESSION — the 17D final-production frame proof must take its MEASURED
 * per-turn audio records from the typed builder result, not from a property
 * that does not exist.
 *
 * Final Product Acceptance run 37065742559 passed Preflight, Short smoke, the
 * Long + Short renders, the Phase 6D package, the product kit, readiness READY
 * and production-history update, and then failed ONLY gate 17D on the Long:
 *
 *   frame proof (final-long): ... markerPixelsBestFrame 0, framesSampled 0,
 *   exposureWindows []
 *
 * while the non-authoritative legacy fixed-interval scan of the SAME Long MP4
 * found 7977 marker pixels — so the asset really was composited and the render
 * and the asset were fine.
 *
 * Root cause, in this driver: buildPerTurnAudioIdentity() returns
 * { records, report, paths }, but the final-production frame proof read
 *
 *   const finalAudioRecords = ((identityAfter as any).perTurnRecords ?? []);
 *
 * which is always []. Every scene then got zero measured turn durations, so
 * assetExposureWindows() created no window for the asset-bearing scene, and the
 * planned-window sampler (the pass/fail authority) inspected 0 frames. The
 * Short-smoke path was unaffected because its audit helper really does expose
 * `perTurnRecords`.
 *
 * This is an acceptance-wiring defect, so the regression is a narrowly scoped
 * source-contract guard over the real driver — the same technique
 * tests/acceptance-import-order.test.ts already uses for the driver. It checks
 * the CALLER and the CALLEE together so a rename on either side is caught:
 *
 *   1. buildPerTurnAudioIdentity()'s declared return type exposes `records`
 *      and NOT `perTurnRecords`;
 *   2. the final-production frame-proof record source reads that typed
 *      property, with no `as any` escape hatch;
 *   3. no builder result (`identityBefore` / `identityAfter`) is ever read
 *      through `perTurnRecords` anywhere in the driver.
 *
 * Sensitivity is proven INSIDE the test: the detector is also run against the
 * exact pre-fix statement from run 37065742559 and must report the mismatch, so
 * the guard cannot silently become vacuous.
 *
 * No product render, no TTS, no network, no child process.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DRIVER_PATH = path.join(REPO_ROOT, 'scripts', 'final-product-acceptance.ts');
const DRIVER_SOURCE = readFileSync(DRIVER_PATH, 'utf8');

/**
 * Comments are documentation, not wiring, so the structural checks run on the
 * driver with its comments removed — otherwise prose that merely DESCRIBES the
 * old defect (including the explanatory comment added with this fix) would trip
 * the guard. String and template literals are preserved (the driver is full of
 * `http://…` URLs, and a naive `//` strip would mangle them).
 */
function stripComments(source: string): string {
  let out = '';
  let quote: '"' | "'" | '`' | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** The driver's executable wiring with comments removed. */
const DRIVER_CODE = stripComments(DRIVER_SOURCE);

/** The exact statement that produced 37065742559's zero-record frame proof. */
const PRE_FIX_STATEMENT =
  'const finalAudioRecords = ((identityAfter as any).perTurnRecords ?? []) as Array<{ target: string; sceneId: string; durationSeconds: number | null }>;';

const FINAL_RECORD_SOURCE_RE = /const\s+finalAudioRecords\s*=\s*([^;]+);/;
const BUILDER_RESULT_MISUSE_RE = /\bidentity(?:Before|After)\b[^\n;]*\bperTurnRecords\b/;

/**
 * The declared `Promise<{ … }>` return block of a named async function, scanned
 * with balanced braces so nested object types (e.g. `paths: { … }`) do not
 * truncate it.
 */
function declaredReturnBlock(source: string, functionName: string): string | null {
  const start = source.indexOf(`async function ${functionName}`);
  if (start === -1) return null;
  const open = source.indexOf('Promise<{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open + 'Promise<'.length; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * `null` when the final-production frame-proof record source is wired to the
 * builder's typed measured records, otherwise a description of the defect.
 */
function finalFrameProofRecordSourceIssue(source: string): string | null {
  const match = FINAL_RECORD_SOURCE_RE.exec(source);
  if (!match) {
    return 'the final-production frame-proof record source (const finalAudioRecords = …) is missing';
  }
  const rhs = match[1].trim();
  if (/\bperTurnRecords\b/.test(rhs)) {
    return `the final frame proof reads perTurnRecords, but buildPerTurnAudioIdentity() returns { records, report, paths }: ${rhs}`;
  }
  if (/\bas\s+any\b/.test(rhs)) {
    return `the final frame-proof record source bypasses the type system with 'as any': ${rhs}`;
  }
  if (rhs !== 'identityAfter.records') {
    return `the final frame proof must read identityAfter.records (the builder's own typed measured records), got: ${rhs}`;
  }
  return null;
}

describe('acceptance final-production frame proof — measured record source (run 37065742559)', () => {
  it('buildPerTurnAudioIdentity() declares records, never perTurnRecords', () => {
    const block = declaredReturnBlock(DRIVER_CODE, 'buildPerTurnAudioIdentity');
    // Sanity: the scanner must really have found the declared return block.
    expect(block).not.toBeNull();
    expect(block).toContain('records:');
    expect(block).toContain('PerTurnAudioRecord');
    // The property the old code read has never existed on this return value.
    expect(block).not.toContain('perTurnRecords');
  });

  it('the final frame proof reads the typed measured records', () => {
    const match = FINAL_RECORD_SOURCE_RE.exec(DRIVER_CODE);
    // Sanity: the declaration must exist, or the assertion below is vacuous.
    expect(match).not.toBeNull();
    expect(finalFrameProofRecordSourceIssue(DRIVER_CODE)).toBeNull();
    expect(match![1].trim()).toBe('identityAfter.records');
  });

  it('no builder result is ever read through perTurnRecords anywhere in the driver', () => {
    // Sanity: the placeholder this guard replaces must not be resurrected in any
    // other statement either (the Short-smoke path reads its own audit helper,
    // which is a different value and unchanged).
    expect(BUILDER_RESULT_MISUSE_RE.test(DRIVER_CODE)).toBe(false);
    // And the typed property really is the one in use (non-vacuous).
    const typedReads = DRIVER_CODE.match(/identity(?:Before|After)\.records/g) ?? [];
    expect(typedReads.length).toBeGreaterThanOrEqual(2);
  });

  it('the guard fails on the pre-fix statement (sensitivity, not just a passing grep)', () => {
    const issue = finalFrameProofRecordSourceIssue(PRE_FIX_STATEMENT);
    expect(issue).not.toBeNull();
    expect(issue).toContain('perTurnRecords');

    // A same-shape `as any` escape hatch is also rejected, so "fixing" the
    // property name while keeping the cast cannot pass this guard.
    expect(
      finalFrameProofRecordSourceIssue('const finalAudioRecords = (identityAfter as any).records;'),
    ).toContain("'as any'");

    // A renamed/absent declaration is rejected rather than passing vacuously.
    expect(finalFrameProofRecordSourceIssue('const other = identityAfter.records;')).toContain('missing');
  });

  it('keeps the working Short-smoke frame-proof source untouched', () => {
    // The Short stage reads the short-smoke audio audit result, which really
    // does expose perTurnRecords — that path passed in 37065742559.
    const shortSource = /const\s+shortAudioRecords\s*=\s*([^;]+);/.exec(DRIVER_CODE);
    expect(shortSource).not.toBeNull();
    expect(shortSource![1]).toContain('perTurnRecords');
  });
});
