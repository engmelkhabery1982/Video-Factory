#!/usr/bin/env node
/**
 * Guards against a whole `describe` block silently disappearing from the suite.
 *
 * The previous version of this check scraped vitest's human-readable summary
 * with `grep -oE 'Tests +[0-9]+ passed'`. That works locally and fails in CI:
 * under `CI=true` vitest colourises its output, so the characters between
 * "Tests " and the number are ANSI escape sequences, the pattern matches
 * nothing, the step reports "could not read the test count" and CI goes red
 * even though every test passed.
 *
 * The JSON reporter is machine-readable and unaffected by colour, so read the
 * number from there. The 'basic' reporter used before is deprecated in Vitest 3
 * and prints a warning banner that would pollute any output parsing too.
 *
 * Usage:  node scripts/assert-test-count.mjs [minimum]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A STABLE floor, deliberately below the current total (89 at Phase 0A):
// it trips when a whole file or describe block disappears (~15% of the
// suite), but adding tests never requires editing this number. Raise it only
// when the suite grows substantially.
const MINIMUM = Number(process.argv[2] ?? 75);
const outFile = path.join(os.tmpdir(), `vitest-count-${process.pid}.json`);

console.log(`Running the suite with the JSON reporter to read the count...`);

try {
  execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${outFile}`], {
    encoding: 'utf8',
    stdio: 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  // vitest exits non-zero when tests fail; the JSON file is still written, and
  // the earlier "Test suite" step has already reported that failure. Fall
  // through so the number can still be reported.
  console.log(`vitest exited non-zero (${e.status ?? 'signal ' + e.signal}); reading the report anyway.`);
}

if (!fs.existsSync(outFile)) {
  console.error(`::error::could not read the test count: ${outFile} was not written`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
} catch (e) {
  console.error(`::error::could not parse the vitest JSON report: ${e.message}`);
  process.exit(1);
} finally {
  fs.rmSync(outFile, { force: true });
}

const passed = Number(report.numPassedTests ?? 0);
const failed = Number(report.numFailedTests ?? 0);
const files = Number(report.numTotalTestSuites ?? 0);

console.log(`\nTest files: ${files}`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);

if (passed < MINIMUM) {
  console.error(`::error::expected at least ${MINIMUM} passing tests, got ${passed}`);
  process.exit(1);
}

console.log(`\nok - ${passed} tests passed, at or above the floor of ${MINIMUM}`);
