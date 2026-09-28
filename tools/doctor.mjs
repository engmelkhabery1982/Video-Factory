#!/usr/bin/env node
/**
 * Environment doctor.
 *
 * Checks every external thing the Video Factory needs before the first render:
 * Node version, the local Chromium, ffmpeg/ffprobe, the built web UI and the
 * data directories. It exits non-zero if a hard requirement is missing, so a
 * first-time user gets one clear message instead of a stack trace mid-render.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
let hardFailures = 0;

function line(name, ok, detail, soft = false) {
  const mark = ok ? `${G}ok  ${X}` : soft ? `${Y}warn${X}` : `${R}FAIL${X}`;
  if (!ok && !soft) hardFailures++;
  console.log(`  [${mark}] ${name.padEnd(22)} ${D}${detail}${X}`);
}

console.log('\nBuildTrack Video Factory - environment check\n');

const major = Number(process.versions.node.split('.')[0]);
line('Node.js', major >= 20, `v${process.versions.node} (needs >= 20)`);

// --- local Chromium (Remotion cannot download its own here) -----------------
const chrome = path.join(ROOT, '.browser', process.platform === 'win32' ? 'chrome.exe' : 'chrome');
line('Local Chromium', fs.existsSync(chrome), fs.existsSync(chrome) ? path.relative(ROOT, chrome) : 'run: npm run provision');

const libDir = path.join(ROOT, '.browser', 'lib');
if (process.platform !== 'win32') {
  const have = fs.existsSync(libDir) && fs.readdirSync(libDir).length > 0;
  line('Chromium libraries', have, have ? `${fs.readdirSync(libDir).length} files in .browser/lib` : 'run: npm run provision');
} else {
  line('Chromium libraries', true, 'not needed on Windows', true);
}

// --- ffmpeg / ffprobe --------------------------------------------------------
function binFrom(mod, resolvePath) {
  try {
    const p = resolvePath(require(mod));
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
const ffmpeg = binFrom('@ffmpeg-installer/ffmpeg', (m) => m.path);
const ffprobe = binFrom('ffprobe-static', (m) => m.path);
line('ffmpeg', !!ffmpeg, ffmpeg ?? 'run: npm install');

if (ffmpeg && ffprobe) {
  try {
    execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
    line('ffmpeg runs', true, 'ok');
  } catch (e) {
    line('ffmpeg runs', false, `failed to execute: ${e.message}`, true);
  }
  try {
    const out = execFileSync(ffprobe, ['-version'], { encoding: 'utf8' });
    line('ffprobe runs', true, out.split('\n')[0].replace('ffprobe version ', '').split(' ')[0]);
  } catch (e) {
    line('ffprobe runs', false, `failed to execute: ${e.message}`, true);
  }
} else {
  line('ffprobe', !!ffprobe, ffprobe ?? 'run: npm install');
}

// --- built libraries ---------------------------------------------------------
// The API imports @buildtrack/core from its dist, so a missing core build is a
// hard failure, not a warning - the server cannot start without it.
const coreDist = path.join(ROOT, 'packages', 'core', 'dist', 'index.js');
line('Core library (built)', fs.existsSync(coreDist), fs.existsSync(coreDist) ? 'packages/core/dist' : 'run: npm run build:core');

const dist = path.join(ROOT, 'apps', 'web', 'dist', 'index.html');
line('Web UI (built)', fs.existsSync(dist), fs.existsSync(dist) ? 'apps/web/dist' : 'run: npm run build:web');

// --- data / output roots -----------------------------------------------------
for (const d of ['data/projects', 'data/assets', 'data/voiceover', 'output']) {
  const p = path.join(ROOT, d);
  line(d, fs.existsSync(p), fs.existsSync(p) ? 'present' : 'will be created on first run', true);
}

// --- ffmpeg codec support ----------------------------------------------------
if (ffmpeg) {
  try {
    const enc = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    const has = (n) => enc.includes(n);
    line('libx264', has('libx264'), has('libx264') ? 'H.264 software encoder available' : 'H.264 encoding will fail', true);
    line('AAC encoder', has('aac'), has('aac') ? 'native AAC encoder available' : 'no AAC encoder', true);
  } catch {
    /* version probe already reported the failure */
  }
}

console.log(
  hardFailures
    ? `\n${R}${hardFailures} hard requirement(s) missing.${X} Fix the items marked FAIL, then run this again.\n`
    : `\n${G}Environment looks ready.${X} Start the app with:  npm start\n`,
);
process.exit(hardFailures ? 1 : 0);
