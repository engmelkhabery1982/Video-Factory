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
import { resolveChrome } from './chrome-resolution.mjs';

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

// --- browser (same resolver as provision and the renderer) -------------------
const browser = resolveChrome({ root: ROOT, env: process.env, platform: process.platform });
const browserDetail = browser.ok
  ? `${browser.source}: ${browser.path}`
  : browser.failures.map((failure) => `${failure.source}: ${failure.reason}`).join('; ') || browser.message;
line('Local Chromium', browser.ok, browser.ok ? browserDetail : `${browser.message} ${browserDetail}`);

const libDir = path.join(ROOT, '.browser', 'lib');
if (browser.ok && browser.source === 'bundled' && process.platform !== 'win32') {
  const have = fs.existsSync(libDir) && fs.readdirSync(libDir).length > 0;
  line('Chromium libraries', have, have ? `${fs.readdirSync(libDir).length} files in .browser/lib` : 'run: npm run provision');
} else if (process.platform === 'win32') {
  line('Chromium libraries', true, 'not needed on Windows', true);
} else {
  line('Chromium libraries', true, browser.ok ? 'system browser does not need the bundled libraries' : 'not checked until a bundled browser runs', true);
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

// --- Chatterbox voice cloning (optional unless selected) ---------------------
// The optional local voice-clone engine. It is deliberately NOT part of the
// default requirements: Kokoro/SAM work without it, and this check never
// downloads a model, installs a package or runs the worker. Once a project (or
// the operator) selects Chatterbox, every missing capability below becomes
// blocking for that job, so doctor reports it as a hard failure.
const requireChatterbox = process.argv.includes('--require-chatterbox');
const chatterboxMarker = path.join(ROOT, '.chatterbox', 'provisioned.json');
const chatterboxEnv = path.join(ROOT, '.chatterbox', 'env', 'bin', 'python');
const chatterboxWorker = path.join(ROOT, 'tools', 'chatterbox', 'worker.py');
const chatterboxSelected = requireChatterbox || fs.existsSync(chatterboxMarker);
const chatterboxSoft = !chatterboxSelected;

console.log(`\n${D}Chatterbox voice cloning${X}`);

let chatterboxMarkerValue = null;
if (fs.existsSync(chatterboxMarker)) {
  try {
    chatterboxMarkerValue = JSON.parse(fs.readFileSync(chatterboxMarker, 'utf8'));
  } catch {
    chatterboxMarkerValue = null;
  }
}

function chatterboxLine(name, ok, detail) {
  line(`Chatterbox ${name}`, ok, detail, chatterboxSoft);
}

if (!chatterboxSelected) {
  chatterboxLine(
    'status',
    true,
    'optional: not selected (Kokoro stays the default engine; nothing was downloaded)',
  );
} else {
  chatterboxLine('selected', true, requireChatterbox ? 'requested with --require-chatterbox' : 'provisioning marker present');
  chatterboxLine(
    'python 3.11',
    (() => {
      try {
        const out = execFileSync('python3.11', ['--version'], { encoding: 'utf8' });
        return /Python 3\.11\./.test(out);
      } catch {
        return false;
      }
    })(),
    'needed by the isolated worker (run: npm run provision:voice-clone -- --apply)',
  );
  chatterboxLine('isolated env', fs.existsSync(chatterboxEnv), fs.existsSync(chatterboxEnv) ? '.chatterbox/env' : 'missing — run provisioning --apply');
  chatterboxLine('worker script', fs.existsSync(chatterboxWorker), fs.existsSync(chatterboxWorker) ? 'tools/chatterbox/worker.py' : 'missing from the repository');
  chatterboxLine(
    'provisioning marker',
    chatterboxMarkerValue !== null,
    chatterboxMarkerValue
      ? `verified: ${chatterboxMarkerValue.engineContractId} @ ${String(chatterboxMarkerValue.modelRevision).slice(0, 12)}…`
      : 'missing/unreadable — run: npm run provision:voice-clone -- --apply',
  );
  const chatterboxAllowCpu = process.env.CHATTERBOX_ALLOW_CPU === '1';
  let chatterboxGpu = false;
  try {
    execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { stdio: 'ignore' });
    chatterboxGpu = true;
  } catch {
    chatterboxGpu = false;
  }
  if (chatterboxAllowCpu) {
    chatterboxLine('GPU', chatterboxGpu, chatterboxGpu ? 'NVIDIA GPU present' : 'no GPU; CHATTERBOX_ALLOW_CPU=1 approves the unverified CPU path');
  } else {
    chatterboxLine('GPU', chatterboxGpu, chatterboxGpu ? 'NVIDIA GPU present' : 'no NVIDIA GPU — required unless you explicitly allow CPU (CHATTERBOX_ALLOW_CPU=1 + device "cpu")');
  }
  chatterboxLine(
    'reference voices',
    fs.existsSync(path.join(ROOT, '.voice-references')),
    fs.existsSync(path.join(ROOT, '.voice-references'))
      ? '.voice-references present (personal recordings, never committed)'
      : 'no .voice-references directory yet — approved reference recordings are required before cloning',
  );
  console.log(`  ${D}rights/consent are enforced per voice by the publication gate at synthesis time.${X}`);
}

console.log(
  hardFailures
    ? `\n${R}${hardFailures} hard requirement(s) missing.${X} Fix the items marked FAIL, then run this again.\n`
    : `\n${G}Environment looks ready.${X} Start the app with:  npm start\n`,
);
process.exit(hardFailures ? 1 : 0);
