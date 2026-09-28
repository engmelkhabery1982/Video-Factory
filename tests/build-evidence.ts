/**
 * Collects the review evidence into EVIDENCE/ :
 *   - the recorded test run
 *   - the ffprobe verification of every exported file
 *   - the demo summary
 *   - contact sheets sampled from the finished videos
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

fs.mkdirSync(EVIDENCE, { recursive: true });

function write(name: string, text: string) {
  const f = path.join(EVIDENCE, name);
  fs.writeFileSync(f, text, 'utf8');
  console.log(`  ${path.relative(ROOT, f)}`);
}

// --- test run ---------------------------------------------------------------
console.log('Running the test suite...');
try {
  const out = execFileSync('npx', ['vitest', 'run'], { encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  write('tests.txt', out);
} catch (e: any) {
  write('tests.txt', `${e.stdout ?? ''}\n${e.stderr ?? ''}`);
}

// --- ffprobe verification ---------------------------------------------------
console.log('Verifying exported files with ffprobe...');
const results = verifyAll();
if (results.length) {
  const lines = results.map((r) => {
    const a = r.actual;
    return [
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.file}`,
      `      ${a.width}x${a.height}  ${a.fps}fps  ${a.videoCodec}/${a.pixFmt} (${a.profile})`,
      `      duration ${a.durationSec}s  container ${a.containerBitrateKbps}kbps`,
      `      audio ${a.audioCodec ?? 'MISSING'} ${a.audioSampleRate ?? '-'}Hz ${a.audioChannels ?? '-'}ch ${a.audioBitrateKbps ?? '-'}kbps`,
      `      frames ${a.nbFrames ?? '-'}`,
      ...(r.failures.length ? [`      !! ${r.failures.join('; ')}`] : []),
    ].join('\n');
  });
  const passed = results.filter((r) => r.ok).length;
  write(
    'ffprobe.txt',
    [
      'BuildTrack Video Factory - delivery specification verification',
      'Checked with ffprobe directly against the files on disk.',
      '',
      ...lines,
      '',
      `${passed}/${results.length} files meet the specification.`,
      '',
    ].join('\n'),
  );
  console.log(`  ${passed}/${results.length} pass`);
} else {
  write('ffprobe.txt', 'No exported mp4 files were found under output/.\n');
}

// --- demo summary -----------------------------------------------------------
const summaryFile = path.join(ROOT, 'output', 'demo_summary.json');
if (fs.existsSync(summaryFile)) {
  const s = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  const rows = (s.summary ?? []).map((v: any) => ({
    video: v.videoId,
    topic: v.topic,
    hook: v.hookVariant,
    longScenes: v.longScenes,
    longSec: v.longDuration,
    shorts: v.shorts?.length ?? 0,
    similarity: v.similarity != null ? `${v.similarity}%` : '-',
    cta: v.ctaAnimation,
    captions: v.captionStyle,
    verdict: (v.results ?? []).map((r: any) => `${r.target}:${r.verdict}`).join(' '),
  }));
  write('demo-summary.txt', ['BuildTrack Video Factory - demo summary', '', JSON.stringify(rows, null, 2), ''].join('\n'));
}

// --- contact sheets ---------------------------------------------------------
const videos: string[] = [];
const walk = (dir: string) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.mp4')) videos.push(p);
  }
};
walk(path.join(ROOT, 'output'));

console.log(`Building contact sheets for ${videos.length} video(s)...`);
for (const v of videos) {
  const name = path.basename(v, '.mp4') + '.png';
  const dest = path.join(EVIDENCE, name);
  try {
    // 12 evenly spaced frames, tiled 4x3, scaled so the sheet stays readable
    execFileSync(
      FFMPEG,
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', v,
        '-vf', 'fps=12/' + probeDuration(v) + ',scale=480:-1,tile=4x3', '-frames:v', '1', dest],
      { stdio: 'ignore' },
    );
    console.log(`  ${path.relative(ROOT, dest)}`);
  } catch (e: any) {
    console.log(`  ! contact sheet failed for ${path.basename(v)}: ${e.message.split('\n')[0]}`);
  }
}

function probeDuration(file: string): number {
  const FFPROBE = path.resolve('node_modules/ffprobe-static/bin/linux/x64/ffprobe');
  const raw = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(raw.trim());
}

console.log('\nEvidence written to EVIDENCE/');
