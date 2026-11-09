/**
 * FINITE REAL-FFMPEG HOST CHECK for the reproduced Windows long-path export
 * failure (CLOSEOUT07 defect 1).
 *
 * This is the only check in this delta that proves anything about the installed
 * binaries. It runs the real `ffmpeg` and `ffprobe` the app would use, on real
 * files, and reports SKIPPED — never passed — when either binary is missing.
 *
 * What the owner host needs to reproduce and then confirm:
 *   The editor export rendered `raw-frames.mp4` under a deep project data root.
 *   The packaged ffmpeg rejected that 262-character path although the file
 *   existed. Copying disposable QA data to a shorter root made the SAME revision
 *   export successfully. That is the failure this check pins down.
 *
 * Modes:
 *   default       Build a genuine 12-frame VP9/MP4 in an isolated temp root, then
 *                 ask the real binaries to open it through (1) a short path and
 *                 (2) a deliberately padded long path, and report both outcomes.
 *   --owner-path  Add the owner's exact 262-character shape from the failing
 *                 export, so the refusal is reproduced literally.
 *
 * Storage: only `os.tmpdir()`, always its own `mkdtemp` directory, removed at the
 * end. No owner project data, media, WAV, draft or frozen revision is read or
 * written.
 *
 * Run: node scripts/qualify-ffmpeg-longpath.mjs [--owner-path]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ROOT = process.cwd();
const ownerPathMode = process.argv.includes('--owner-path');

function resolveBinary(name, envKey) {
  const fromEnv = process.env[envKey];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const installed = name === 'ffmpeg' ? require('@ffmpeg-installer/ffmpeg').path : require('ffprobe-static').path;
    if (typeof installed === 'string' && fs.existsSync(installed)) return installed;
  } catch { /* Only already-installed packages are considered. */ }
  // The app's own resolution order, then the usual installed locations.
  const candidates = [
    path.join(ROOT, 'node_modules', 'ffmpeg-static', name),
    path.join(ROOT, 'node_modules', 'ffmpeg-static', `${name}.exe`),
    path.join(ROOT, 'node_modules', '@ffmpeg-installer', `${process.platform}-${process.arch}`, `${name}${process.platform === 'win32' ? '.exe' : ''}`),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

const ffmpeg = resolveBinary('ffmpeg', 'VF_FFMPEG_PATH');
const ffprobe = resolveBinary('ffprobe', 'VF_FFPROBE_PATH');
const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(8)} ${name}${detail ? ` — ${detail}` : ''}`);
};

if (!ffmpeg || !ffprobe) {
  console.log(`SKIPPED  real ffmpeg/ffprobe not found (ffmpeg=${ffmpeg ?? 'absent'}, ffprobe=${ffprobe ?? 'absent'})`);
  console.log('         NOT RUN. This is not a pass. Do not claim Windows path compatibility from a unit test.');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-longpath-'));
if (path.dirname(path.resolve(tmp)) !== path.resolve(os.tmpdir()) || !path.basename(tmp).startsWith('vf-longpath-')) throw new Error('Scratch escaped its owned temp parent.');
let failures = 0;
const check = (ok, name, detail) => {
  if (!ok) failures += 1;
  record(name, ok ? 'PASSED' : 'FAILED', detail);
};

try {
  const shortPath = path.join(tmp, 'raw-frames.mp4');
  // Real encode: 12 frames, deterministic colour, no audio. This is a fixture, not
  // creative output and not a quality claim.
  const encode = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x2050a0:s=1080x1920:r=30',
    '-frames:v', '12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', shortPath,
  ], { encoding: 'utf8' });
  check(encode.status === 0 && fs.existsSync(shortPath), 'real ffmpeg writes a 12-frame fixture', encode.stderr?.slice(0, 300) || shortPath);

  const probeShort = spawnSync(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames', '-of', 'json', shortPath,
  ], { encoding: 'utf8' });
  const shortInfo = probeShort.status === 0 ? JSON.parse(probeShort.stdout) : null;
  check(
    shortInfo?.streams?.[0]?.width === 1080 && shortInfo?.streams?.[0]?.height === 1920,
    'real ffprobe opens the short path and reports 1080x1920',
    probeShort.stderr?.slice(0, 300) || `${shortInfo?.streams?.[0]?.width}x${shortInfo?.streams?.[0]?.height}`,
  );

  // Now the same file behind a long path. Windows is where this matters; on POSIX
  // the padded path must still work, which is itself the documented difference.
  const padDir = path.join(tmp, 'p'.repeat(120), 'q'.repeat(120));
  fs.mkdirSync(padDir, { recursive: true });
  const longPath = path.join(padDir, 'raw-frames.mp4');
  let longExists = false;
  try {
    fs.copyFileSync(shortPath, longPath);
    longExists = true;
  } catch (err) {
    record('copy fixture to a long path', 'FAILED', `${err.code}: ${err.message}`);
    failures += 1;
  }
  if (longExists) {
    const probeLong = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', longPath], { encoding: 'utf8' });
    const opened = probeLong.status === 0;
    // Either outcome is information; the point is that it is MEASURED, not assumed.
    record(
      `real ffprobe on a ${longPath.length}-character path`,
      opened ? 'OBSERVED_OPEN' : 'OBSERVED_UNSUPPORTED',
      opened ? 'opened' : (probeLong.stderr || '').trim().slice(0, 300) || 'refused',
    );
  }

  if (ownerPathMode && process.platform === 'win32') {
    // The literal shape from the owner's failing export, at 262 characters.
    const ownerRoot = path.win32.join(tmp, 'owner-shape', 'projects', 'Factory_synthetic', 'editor');
    const job = 'exp_6ac267eb71ccf166';
    let dir = path.win32.join(ownerRoot, 'export-work');
    let exact = path.win32.join(dir, job, 'raw-frames.mp4');
    for (let pad = 0; pad < 400 && exact.length < 262; pad += 1) {
      dir = path.win32.join(ownerRoot, `export-work${'x'.repeat(pad)}`);
      exact = path.win32.join(dir, job, 'raw-frames.mp4');
    }
    fs.mkdirSync(path.win32.join(dir, job), { recursive: true });
    fs.copyFileSync(shortPath, exact);
    const ownerProbe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', exact], { encoding: 'utf8' });
    record(
      `owner-shape ${exact.length}-character path`,
      ownerProbe.status === 0 ? 'OBSERVED_OPEN' : 'OBSERVED_UNSUPPORTED',
      ownerProbe.status === 0 ? 'opened (this host tolerates it)' : (ownerProbe.stderr || '').trim().slice(0, 300),
    );
    // And the repaired strategy: the same job rendered in a short scratch root.
    const scratch = fs.mkdtempSync(path.win32.join(tmp, 'short-'));
    const relocated = path.win32.join(scratch, 'raw-frames.mp4');
    fs.copyFileSync(shortPath, relocated);
    const relocatedProbe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', relocated], { encoding: 'utf8' });
    check(
      relocatedProbe.status === 0,
      'the repaired short scratch path is readable by the real binary',
      `${relocated.length} chars`,
    );
  } else if (ownerPathMode) {
    record('owner-shape 262-character reproduction', 'SKIPPED', 'only meaningful on Windows; this host is ' + process.platform);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${results.filter((r) => r.status === 'PASSED').length} passed, ${failures} failed, ${results.filter((r) => r.status === 'SKIPPED' || r.status === 'NOT RUN').length} skipped`);
console.log('Scope: this validates the real binaries against these paths on THIS host and');
console.log('nothing else. It is not creative, cinematic or whole-product acceptance.');
process.exit(failures > 0 ? 1 : 0);
