#!/usr/bin/env node
/**
 * Temporary diagnostic: run the suite already selected by vitest.config.ts
 * and emit a complete failure census as GitHub annotations. The raw log blob
 * of run 37852142691 is not readable from the investigation environment.
 *
 * Exit 0 even when tests fail, so the census itself is not lost to a step abort.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outFile = path.join(process.cwd(), 'ci-failure-census.json');
const vitest = path.resolve('node_modules', 'vitest', 'vitest.mjs');

function annotate(level, title, message) {
  const flat = String(message).replace(/\r/g, '').replace(/\n/g, ' | ').slice(0, 3500);
  const safeTitle = String(title).replace(/[\r\n:]/g, ' ').slice(0, 80);
  process.stdout.write(`::${level} title=${safeTitle}::${flat}\n`);
}

try {
  execFileSync(process.execPath, [vitest, 'run', '--reporter=json', `--outputFile=${outFile}`], {
    stdio: 'inherit',
    env: process.env,
  });
} catch (error) {
  process.stdout.write(`vitest exited non-zero (${error.status ?? error.message}); reading the report anyway.\n`);
}

if (!fs.existsSync(outFile)) {
  annotate('error', 'census-missing', 'vitest did not write ci-failure-census.json');
  process.exit(0);
}

const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
const failures = [];
for (const file of report.testResults ?? []) {
  const fileName = String(file.name ?? '').replace(process.cwd() + path.sep, '');
  const suiteMessage = String(file.message ?? '').trim();
  if (file.status === 'failed' && suiteMessage && !(file.assertionResults ?? []).some((a) => a.status === 'failed')) {
    failures.push({
      file: fileName,
      name: `${fileName} (suite)`,
      message: suiteMessage.split('\n').slice(0, 6).join(' | '),
    });
  }
  for (const assertion of file.assertionResults ?? []) {
    if (assertion.status !== 'failed') continue;
    failures.push({
      file: fileName,
      name: assertion.fullName || assertion.title || fileName,
      message: String((assertion.failureMessages ?? [])[0] ?? '').split('\n').slice(0, 6).join(' | '),
    });
  }
}

const groups = new Map();
for (const failure of failures) {
  const key = failure.message.split(' | ')[0].slice(0, 180) || '(no message)';
  const group = groups.get(key) ?? [];
  group.push(failure.name);
  groups.set(key, group);
}

annotate(
  failures.length ? 'error' : 'notice',
  'non-render-failure-census',
  `failed=${failures.length} passed=${report.numPassedTests ?? 0} skipped=${report.numPendingTests ?? 0} files=${report.numTotalTestSuites ?? 0} groups=${groups.size}`,
);

let index = 0;
for (const [key, names] of groups) {
  index += 1;
  annotate('error', `group-${index}`, `${names.length} test(s): ${key} :: ${names.slice(0, 12).join(' || ')}`);
}

fs.writeFileSync(
  'ci-failure-census-summary.json',
  JSON.stringify({ failed: failures.length, groups: [...groups.entries()].map(([message, names]) => ({ message, names })) }, null, 2),
);
