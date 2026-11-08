#!/usr/bin/env node
/**
 * CLOSEOUT06 isolated host qualification. Existing local packages only.
 * Requires an exact expected SHA. No install, network, capture, model run or promotion.
 * Default is the current delta; --all-affected explicitly reruns historical groups.
 * Consent, rendered quality and listening remain separate open gates.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const allAffected = argv.includes('--all-affected');
const jsonIndex = argv.indexOf('--json');
const outputReport = jsonIndex >= 0 ? argv[jsonIndex + 1] : null;
const expectedSha = process.env.HOST_QUALIFY_EXPECT_SHA;
const expectedBranch = process.env.HOST_QUALIFY_EXPECT_BRANCH ?? 'arena/88809335-video-factory';
const git = (args) => {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
};
const report = {
  schemaVersion: 2, at: new Date().toISOString(),
  source: { tip: git(['rev-parse', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    expectedSha, expectedBranch, trackedStatus: git(['status', '--porcelain', '--untracked-files=no']) },
  steps: [], reused: [], notRun: [], ownerOnly: [
    'Real consented native capture/playback/upload/resource review: not run.',
    'Real authorized inpainting model/output/visual acceptance: not run.',
    'Rendered family outputs, semantic quality and listening: not accepted by this script.',
    'No release acceptance, owner data changes or approved/F promotion.',
  ],
};
if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || report.source.tip !== expectedSha
    || report.source.branch !== expectedBranch || report.source.trackedStatus !== '') {
  console.error('Refusing qualification: provide the exact HEAD in HOST_QUALIFY_EXPECT_SHA, matching branch, and clean tracked files. Untracked owner evidence is preserved.');
  process.exit(2);
}
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-host-qualify-'));
const isolatedEnv = {
  ...process.env, BUILDTRAKE_DATA: path.join(sandbox, 'data'),
  BUILDTRAKE_OUTPUT: path.join(sandbox, 'output'), VF_PREVIEW_DISABLE: '1',
  MASKED_CORRECTION_ENABLED: '0', LOCAL_IMAGE_ENABLED: '0',
};
report.isolation = { sandbox, data: isolatedEnv.BUILDTRAKE_DATA, output: isolatedEnv.BUILDTRAKE_OUTPUT };
for (const dir of [isolatedEnv.BUILDTRAKE_DATA, isolatedEnv.BUILDTRAKE_OUTPUT]) fs.mkdirSync(dir, {recursive:true});

function finish() {
  report.summary = {
    passed: report.steps.filter(s => s.exitCode === 0).length,
    failed: report.steps.filter(s => s.exitCode !== null && s.exitCode !== 0).length,
    notRun: report.notRun.length + report.steps.filter(s => s.exitCode === null).length,
    operationalAcceptance: 'OPEN: automated results do not prove real media or quality',
  };
  const target = outputReport ? path.resolve(outputReport) : path.join(sandbox, 'host-qualification.json');
  const relative = path.relative(ROOT, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    console.error('Refusing to write host report inside repository; use an isolated external report path.');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:target, summary:report.summary, ownerOnly:report.ownerOnly},null,2));
  process.exit(report.summary.failed ? 1 : report.steps.some(s => s.exitCode === null) ? 2 : 0);
}
function step(name, args, cwd = ROOT) {
  const started = Date.now();
  console.log(name);
  const result = spawnSync(process.execPath, args, {
    cwd, env:isolatedEnv, encoding:'utf8', windowsHide:true,
    maxBuffer:16*1024*1024, timeout:5*60*1000,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  report.steps.push({name, executable:'existing Node', args, cwd,
    exitCode:result.status, error:result.error?.message ?? null,
    ms:Date.now()-started, tail:output.slice(-6000)});
  console.log(output.slice(-1800));
  return result.status === 0;
}
const tsc = path.join(ROOT,'node_modules/typescript/bin/tsc');
const vitest = path.join(ROOT,'node_modules/vitest/vitest.mjs');
const vite = [path.join(ROOT,'node_modules/vite/bin/vite.js'),
  path.join(ROOT,'apps/web/node_modules/vite/bin/vite.js')].find(p => fs.existsSync(p));
if (![tsc,vitest].every(p=>fs.existsSync(p)) || !vite || !fs.existsSync(path.join(ROOT,'node_modules/tsx'))) {
  report.steps.push({name:'existing dependencies',exitCode:null});
  report.notRun.push('Local tsc/vitest/vite/tsx missing; nothing installed or downloaded.');
  finish();
}
if (!step('build core before API declarations',[tsc,'-p','packages/core/tsconfig.json'])) finish();
step('API types',[tsc,'-p','apps/api/tsconfig.json','--noEmit']);
step('web types',[tsc,'-p','apps/web/tsconfig.json','--noEmit']);
step('web production build',[vite,'build'],path.join(ROOT,'apps/web'));
// Use installed tsx and current built core on the host, not the custom source-elision loader.
step('technique media-need service regressions',['--import','tsx','--test','tests/factory-technique-media-need.test.mjs']);
step('new HTTP/corruption contracts',[vitest,'run','tests/factory-closeout06-host.test.ts']);
for (const name of ['production-journey','input-routes','visual-families','recovery']) {
  step('canonical service '+name,['--import','tsx','scripts/qualify-'+name+'.mjs']);
}
// CLOSEOUT07 delta only: the export path strategy and job settlement.
step('CLOSEOUT07 render paths and settlement',['--import','tsx','--test','scripts/qualify-render-paths.mjs']);
step('CLOSEOUT07 export contracts',['--import','tsx','--test','scripts/qualify-export-contracts.mjs']);
step('CLOSEOUT07 editor path/settlement regressions',[vitest,'run','tests/editor-render-paths.test.ts']);
// The finite real-FFmpeg check for the reproduced long path. It needs the installed
// binaries, so an absent binary is recorded as NOT RUN rather than passed.
const ffmpegProbe = [path.join(ROOT,'node_modules/ffmpeg-static/ffmpeg'),
  path.join(ROOT,'node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe')].find(f => fs.existsSync(f));
if (ffmpegProbe) {
  step('CLOSEOUT07 real ffmpeg long-path reproduction',['--import','tsx','scripts/qualify-ffmpeg-longpath.mjs']);
} else {
  report.steps.push({name:'CLOSEOUT07 real ffmpeg long-path reproduction',exitCode:null});
  report.notRun.push('Real ffmpeg for the 262-character reproduction was not found at the expected installed paths; NOT RUN, not passed. A stub or path-budget unit test is not Windows compatibility proof.');
}
if (allAffected) {
  step('explicit affected compatibility group',[vitest,'run',
    'tests/factory-masked-correction.test.ts','tests/web/capture-panel.test.tsx',
    'tests/web/masked-correction-panel.test.tsx','tests/local-image-freshness.test.ts',
    'tests/local-image.test.ts','tests/factory-visual-review-http.test.ts']);
} else {
  report.reused.push('CLOSEOUT05 134 affected Vitest/36 PURE and prior browser evidence retained for unchanged paths; no automatic historical rerun.');
}
report.notRun.push(...report.ownerOnly);
finish();
