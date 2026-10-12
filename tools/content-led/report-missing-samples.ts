/**
 * Writes the blocker report for the two derived samples.
 * Does not render, does not download media, and does not invent a file hash.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  inputSupportMatrix,
  localSamplePaths,
  requiredSampleAssets,
  treatmentSupport,
} from '../../packages/core/src/content-led.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const present = localSamplePaths().map((item) => ({
  ...item,
  exists: fs.existsSync(path.join(root, item.path)),
}));

let sha = 'unknown';
try {
  sha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
} catch {
  sha = 'unknown';
}

const report = {
  generatedAt: new Date().toISOString(),
  sha,
  rendered: false,
  contactSheets: [],
  sampleVideos: [],
  note: 'No sample was rendered. The approved narration, timings, religious visuals, channel identity, and Excel recording are not in this workspace. A still or the BuildTrack template was not substituted.',
  missing: requiredSampleAssets().map((item) => ({
    ...item,
    present: item.path ? fs.existsSync(path.join(root, item.path)) || fs.existsSync(item.path) : false,
  })),
  localPaths: present,
  support: inputSupportMatrix(),
  treatments: treatmentSupport(),
};

const outDir = path.join(root, 'samples', 'content-led');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'blockers.json');
fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${outFile}\n`);
