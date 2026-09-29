/**
 * Collects the review evidence into EVIDENCE/ .
 *
 * Deliberately lightweight: text reports and a handful of small PNGs. The MP4
 * deliverables are never copied in here - they are hundreds of megabytes and
 * belong in a Release, not in Git history.
 *
 * Usage:  npm run evidence
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { verifyAll } from './verify-outputs.js';

const ROOT = path.resolve(process.cwd());
const EVIDENCE = path.join(ROOT, 'EVIDENCE');
const FFMPEG = path.resolve('node_modules/@ffmpeg-installer/linux-x64/ffmpeg');

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const run = (cmd: string, args: string[]) => {
  try {
    return { out: execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
  } catch (e: any) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
};
const write = (name: string, text: string) => {
  fs.writeFileSync(path.join(EVIDENCE, name), text, 'utf8');
  console.log(`  wrote ${name}`);
};

fs.mkdirSync(EVIDENCE, { recursive: true });
const stamp = new Date().toISOString();
const header = `BuildTrack Video Factory - evidence\nGenerated: ${stamp}\n`;

/* ---------------- 1. doctor, tests, typecheck, build --------------------- */
console.log('Running doctor, tests, typecheck and build...');
const checks: { name: string; cmd: string; args: string[] }[] = [
  { name: 'environment doctor', cmd: 'node', args: ['tools/doctor.mjs'] },
  { name: 'test suite', cmd: 'npm', args: ['test'] },
  { name: 'typecheck (core, strict)', cmd: 'npm', args: ['run', 'build:core', '--', '--noEmit'] },
  { name: 'typecheck (web, strict)', cmd: 'npx', args: ['tsc', '--noEmit', '-p', 'apps/web/tsconfig.json'] },
  { name: 'production build', cmd: 'npm', args: ['run', 'build'] },
];

const summary: string[] = [];
let allOk = true;
for (const c of checks) {
  const r = run(c.cmd, c.args);
  if (r.code !== 0) allOk = false;
  write(`${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.txt`, strip(r.out));
  const m = strip(r.out).match(/Tests\s+\d+\s+passed\s+\((\d+)\)/);
  const detail = m ? `${m[1]} tests passed` : `exit ${r.code}`;
  summary.push(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${c.name.padEnd(26)} ${detail}`);
  console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${c.name}`);
}
write('validation-summary.txt', `${header}\n${summary.join('\n')}\n\nAll checks passed: ${allOk}\n`);

/* ---------------- 2. ffprobe + file inventory ---------------------------- */
console.log('Verifying exported files with ffprobe...');
const results = verifyAll();
const probeLines: string[] = [];
const manifest: string[] = [];
for (const r of results) {
  const a = r.actual as any;
  probeLines.push(
    [
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.file}  [${r.kind}]`,
      `      resolution  ${a.width}x${a.height}`,
      `      frame rate  ${a.fps} fps`,
      `      video       ${a.videoCodec} / ${a.pixFmt} (profile ${a.profile})`,
      `      duration    ${a.durationSec}s`,
      `      video rate  ${a.containerBitrateKbps} kbps`,
      `      audio       ${a.audioCodec} ${a.audioSampleRate} Hz ${a.audioChannels}ch ${a.audioBitrateKbps} kbps`,
      `      frames      ${a.nbFrames}`,
      ...(r.failures.length ? [`      FAILURES: ${r.failures.join('; ')}`] : []),
    ].join('\n'),
  );
  const abs = path.join(ROOT, r.file);
  manifest.push(`${r.file}\t${fs.existsSync(abs) ? fs.statSync(abs).size : 0} bytes`);
}
const passed = results.filter((r) => r.ok).length;
write('ffprobe.txt', `${header}\nChecked with ffprobe directly against the files on disk.\n\n${probeLines.join('\n\n')}\n\n${passed}/${results.length} files meet the delivery specification.\n`);
write('deliverables.tsv', `file\tbytes\n${manifest.join('\n')}\n`);
console.log(`  ${passed}/${results.length} pass`);

/* ---------------- 3. similarity + QC ------------------------------------- */
const summaryFile = path.join(ROOT, 'output', 'demo_summary.json');
if (fs.existsSync(summaryFile)) {
  const s = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  const lines = ['video\ttopic\thook\tctaAnimation\tcaptionStyle\tsimilarity%' +
    '\tlongScenes\tlongDurationS\tshorts\tverdicts'];
  for (const v of s.summary ?? []) {
    lines.push([
      v.videoId, `"${v.topic}"`, v.hookVariant, v.ctaAnimation, v.captionStyle,
      v.similarity ?? '-', v.longScenes, (v.longDuration ?? 0).toFixed(1), v.shorts?.length ?? 0,
      (v.results ?? []).map((x: any) => `${x.target}=${x.verdict}`).join(','),
    ].join('\t'));
  }
  write('similarity.txt', `${header}\nThreshold: 65%. No project may exceed it.\n\n${lines.join('\n')}\n`);
}

// copy the per-target QC reports next to the other evidence
const qcOut = path.join(EVIDENCE, 'qc');
fs.mkdirSync(qcOut, { recursive: true });
for (const vid of ['Video_01', 'Video_02', 'Video_03']) {
  const dir = path.join(ROOT, 'output', vid, 'qc');
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(dir, f), path.join(qcOut, `${vid}_${f}`));
  }
}
console.log('  copied QC reports');

/* ---------------- 4. representative frames ------------------------------- */
console.log('Extracting representative frames...');
const framesDir = path.join(EVIDENCE, 'frames');
fs.mkdirSync(framesDir, { recursive: true });
for (const r of results) {
  const abs = path.join(ROOT, r.file);
  if (!fs.existsSync(abs)) continue;
  const dur = Number((r.actual as any).durationSec) || 1;
  const stem = path.basename(r.file, '.mp4');
  for (const [label, at] of [['start', 0.04], ['middle', 0.5], ['end', 0.94]] as const) {
    const dest = path.join(framesDir, `${stem}_${label}.png`);
    const rr = run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', (dur * at).toFixed(2), '-i', abs, '-frames:v', '1', '-vf', 'scale=640:-2', dest]);
    if (rr.code === 0) console.log(`  ${path.relative(ROOT, dest)}`);
    else console.log(`  ! frame extraction failed for ${stem} ${label}`);
  }
  // one 12-frame contact sheet per video
  const sheet = path.join(EVIDENCE, `${stem}_contact.png`);
  const rr = run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', abs, '-vf', `fps=12/${dur.toFixed(3)},scale=480:-1,tile=4x3`, '-frames:v', '1', sheet]);
  if (rr.code === 0) console.log(`  ${path.relative(ROOT, sheet)}`);
}

console.log(`\nEvidence written to ${path.relative(ROOT, EVIDENCE)}/`);
if (!allOk) process.exitCode = 1;
