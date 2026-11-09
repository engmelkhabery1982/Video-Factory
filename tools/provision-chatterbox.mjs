#!/usr/bin/env node
/**
 * Chatterbox voice-clone provisioning (EXPLICIT, never automatic).
 *
 *   npm run provision:voice-clone                 # check only (default)
 *   npm run provision:voice-clone -- --apply      # perform provisioning
 *   npm run provision:voice-clone -- --check --json
 *
 * Contract
 * --------
 *   - `npm install` / `npm ci` / `npm test` / `npm run build` / `npm start` must
 *     NEVER download model weights or install Python packages. This script is
 *     the only place that may touch the network, and only with `--apply`.
 *   - Default (`--check`) reports: OS assumptions, Python 3.11, isolated-env
 *     status, disk space, NVIDIA GPU/CUDA availability, expected model/cache
 *     locations, and what `--apply` would do. It writes NOTHING.
 *   - `--apply` creates `.chatterbox/env` (isolated venv), installs the pinned
 *     `tools/chatterbox/requirements.txt`, resolves the REAL upstream model
 *     revision via huggingface_hub, downloads the model snapshot into
 *     `.chatterbox/models`, verifies the import graph and writes
 *     `.chatterbox/provisioned.json` LAST. A marker therefore always means
 *     "verified", never "attempted".
 *   - Every location it creates is Git-ignored (see .gitignore: `.chatterbox/`).
 *   - Failures are actionable: each check prints exactly what to install/fix,
 *     and nothing pretends to have succeeded.
 *
 * Model facts (verified 2026-10-08, see DEPENDENCIES.md): `chatterbox-tts`
 * 0.1.7 (MIT), turbo -> ResembleAI/chatterbox-turbo (English, 350M),
 * multilingual -> ResembleAI/chatterbox (23 languages, 500M) whose upstream
 * loader uses the FLOATING `main` revision — hence the resolved commit sha is
 * recorded, and never invented.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHATTERBOX_DIR = '.chatterbox';
const ENV_DIR = '.chatterbox/env';
const MODEL_DIR = '.chatterbox/models';
const MARKER_PATH = '.chatterbox/provisioned.json';
const MARKER_SCHEMA_VERSION = 1;
const PACKAGE_VERSION = '0.1.7';
const MIN_FREE_BYTES = 12 * 1024 * 1024 * 1024; // torch wheels + one model snapshot

const ENGINES = {
  'chatterbox-multilingual-v3': {
    modelId: 'ResembleAI/chatterbox',
    label: 'Chatterbox Multilingual v3 (500M, 23 languages)',
  },
  'chatterbox-turbo': {
    modelId: 'ResembleAI/chatterbox-turbo',
    label: 'Chatterbox Turbo (350M, English)',
  },
};

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const json = args.includes('--json');
const engineArg = args.find((a) => a.startsWith('--engine='));
const engineContractId = engineArg ? engineArg.split('=')[1] : 'chatterbox-multilingual-v3';
const markerArg = args.find((a) => a.startsWith('--marker='));
const markerRel = markerArg ? markerArg.split('=')[1] : MARKER_PATH;
const markerAbs = path.isAbsolute(markerRel) ? markerRel : path.join(ROOT, markerRel);

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
const report = {
  mode: apply ? 'apply' : 'check',
  engineContractId,
  modelId: null,
  checks: {},
  actions: [],
  problems: [],
  downloadsPerformed: 0,
  markerWritten: false,
};

function say(text) {
  if (!json) console.log(text);
}

function check(name, ok, detail) {
  report.checks[name] = { ok, detail };
  if (!ok) report.problems.push(`${name}: ${detail}`);
}

function run(command, argv, options = {}) {
  return execFileSync(command, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Checks (no side effects in either mode)                            */
/* ------------------------------------------------------------------ */

if (!ENGINES[engineContractId]) {
  check('engine-contract', false, `unknown --engine '${engineContractId}' (expected ${Object.keys(ENGINES).join(' | ')})`);
} else {
  report.modelId = ENGINES[engineContractId].modelId;
  check('engine-contract', true, `${engineContractId} -> ${report.modelId}`);
}

check('os', process.platform === 'linux' || process.platform === 'darwin',
  `${process.platform} (Linux/macOS expected; Windows is untested for the isolated env)`);

/* Python 3.11 */
let pythonPath = null;
{
  const candidates = [process.env.CHATTERBOX_PYTHON, 'python3.11'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const out = run(candidate, ['--version']).trim();
      const match = out.match(/Python (\d+)\.(\d+)\.(\d+)/);
      if (match && match[1] === '3' && match[2] === '11') {
        pythonPath = candidate;
        check('python-3.11', true, `${candidate} -> ${out}`);
        break;
      }
      check('python-3.11', false, `${candidate} is ${out || 'unknown'}; Python 3.11 is required`);
    } catch (e) {
      check('python-3.11', false, `${candidate} not runnable: ${e.message}`);
    }
  }
}

/* Isolated environment */
const envPythonAbs = path.join(ROOT, ENV_DIR, 'bin', 'python');
const envExists = exists(envPythonAbs);
check('isolated-env', envExists, envExists ? `${ENV_DIR} present` : `${ENV_DIR} missing (created by --apply)`);

/* Model cache */
const modelDirAbs = path.join(ROOT, MODEL_DIR);
const cachedModels = exists(modelDirAbs) ? fs.readdirSync(modelDirAbs).filter((n) => n.startsWith('models--')) : [];
check('model-cache', true,
  `${MODEL_DIR} ${exists(modelDirAbs) ? `present (${cachedModels.length} cached repo dir(s))` : 'not created yet'}`);

/* Provisioning marker */
{
  let markerOk = false;
  let detail = 'not provisioned (no verified marker)';
  if (exists(markerAbs)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerAbs, 'utf8'));
      markerOk = marker.schemaVersion === MARKER_SCHEMA_VERSION && marker.engineContractId === engineContractId;
      detail = markerOk
        ? `verified marker for ${marker.engineContractId} @ ${String(marker.modelRevision).slice(0, 12)}…`
        : `marker exists but does not match this engine (${marker.engineContractId ?? 'unknown'})`;
    } catch (e) {
      detail = `marker is unreadable: ${e.message}`;
    }
  }
  check('provision-marker', markerOk, detail);
}

/* Disk space */
try {
  const stats = fs.statfsSync(ROOT);
  const freeBytes = stats.bavail * stats.bsize;
  check('disk-space', freeBytes >= MIN_FREE_BYTES,
    `${(freeBytes / 1024 ** 3).toFixed(1)} GiB free (>= ${(MIN_FREE_BYTES / 1024 ** 3).toFixed(0)} GiB required)`);
} catch (e) {
  check('disk-space', false, `could not determine free space: ${e.message}`);
}

/* NVIDIA GPU + CUDA (truthful: absent means absent) */
let gpuReport = { available: false };
try {
  const out = run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  const first = out.split('\n').map((l) => l.trim()).find(Boolean);
  if (first) {
    const [name, memory, driver] = first.split(',').map((p) => p.trim());
    gpuReport = { available: true, name, memoryTotalMiB: Number.parseInt(memory, 10), driverVersion: driver };
  }
} catch {
  gpuReport = { available: false };
}
report.gpu = gpuReport;
check('nvidia-gpu', gpuReport.available,
  gpuReport.available
    ? `${gpuReport.name} (${gpuReport.memoryTotalMiB} MiB, driver ${gpuReport.driverVersion})`
    : 'no NVIDIA GPU detected — synthesis must use device: "cpu" with the explicit allowCpu opt-in, or a CUDA host');

report.locations = {
  isolatedEnv: ENV_DIR,
  modelCache: MODEL_DIR,
  marker: markerRel,
  requirements: 'tools/chatterbox/requirements.txt',
  worker: 'tools/chatterbox/worker.py',
};

/* ------------------------------------------------------------------ */
/*  Check mode output                                                  */
/* ------------------------------------------------------------------ */

if (!apply) {
  if (!report.checks['engine-contract'].ok) {
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.error(`${R}Unknown engine contract: ${report.checks['engine-contract'].detail}${X}`);
    }
    process.exit(2);
  }
  if (!json) {
    console.log('\nBuildTrack Video Factory — Chatterbox provisioning check\n');
    for (const [name, value] of Object.entries(report.checks)) {
      const mark = value.ok ? `${G}ok  ${X}` : `${Y}warn${X}`;
      console.log(`  [${mark}] ${name.padEnd(18)} ${D}${value.detail}${X}`);
    }
    console.log(`\n  ${D}Isolated env:  ${ENV_DIR}${X}`);
    console.log(`  ${D}Model cache:   ${MODEL_DIR}${X}`);
    console.log(`  ${D}Marker:        ${markerRel}${X}`);
    console.log(`  ${D}Worker:        tools/chatterbox/worker.py${X}`);
    console.log(`\n${D}Nothing was downloaded and nothing was written (check mode).${X}`);
    console.log(`${D}To provision explicitly:  npm run provision:voice-clone -- --apply${X}\n`);
  } else {
    console.log(JSON.stringify({ ...report, actions: [] }, null, 2));
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Apply mode — explicit provisioning only                            */
/* ------------------------------------------------------------------ */

if (process.platform !== 'linux' && process.platform !== 'darwin') {
  console.error(`${R}Cannot provision on ${process.platform}: only Linux/macOS are supported.${X}`);
  process.exit(2);
}
if (!pythonPath) {
  console.error(`${R}Python 3.11 is required but was not found. Install it (e.g. apt install python3.11) and retry.${X}`);
  process.exit(2);
}
if (!report.checks['disk-space'].ok) {
  console.error(`${R}Not enough disk space to provision Chatterbox (need >= 12 GiB free).${X}`);
  process.exit(2);
}

const pip = path.join(ROOT, ENV_DIR, 'bin', 'pip');
const venvPython = path.join(ROOT, ENV_DIR, 'bin', 'python');

function step(description, fn) {
  report.actions.push(description);
  say(`${D}· ${description}${X}`);
  return fn();
}

try {
  if (!envExists) {
    step('create isolated virtualenv (.chatterbox/env)', () => {
      execFileSync(pythonPath, ['-m', 'venv', path.join(ROOT, ENV_DIR)], { stdio: 'inherit' });
    });
  }
  step('upgrade pip inside the isolated env', () => {
    execFileSync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' });
  });
  step('install pinned worker requirements (network)', () => {
    execFileSync(venvPython, ['-m', 'pip', 'install', '-r', path.join(ROOT, 'tools/chatterbox/requirements.txt')],
      { stdio: 'inherit' });
  });

  const modelId = report.modelId;
  const resolvedRevision = step(`resolve real upstream revision of ${modelId}`, () =>
    execFileSync(venvPython, ['-c',
      `from huggingface_hub import HfApi; print(HfApi().model_info(repo_id=${JSON.stringify(modelId)}).sha)`
    ], { encoding: 'utf8' }).trim());
  if (!/^[0-9a-f]{7,64}$/.test(resolvedRevision)) {
    throw new Error(`resolved revision '${resolvedRevision}' does not look like a commit sha`);
  }

  step(`download model snapshot into ${MODEL_DIR} (network)`, () => {
    execFileSync(venvPython, ['-c', [
      'from huggingface_hub import snapshot_download',
      'import os, json',
      `snapshot_download(repo_id=${JSON.stringify(modelId)}, revision=${JSON.stringify(resolvedRevision)},`,
      `  cache_dir=${JSON.stringify(modelDirAbs)},`,
      '  allow_patterns=["*.safetensors", "*.json", "*.txt", "*.pt", "*.model"])',
      'print("snapshot ok")',
    ].join('\n')], { stdio: 'inherit' });
  });
  report.downloadsPerformed += 1;

  const envCheck = step('verify import graph + watermark availability', () =>
    execFileSync(venvPython, ['-c', [
      'import json, sys, importlib.metadata as md',
      'import torch',
      'have_cuda = bool(torch.cuda.is_available())',
      'import inspect, perth',
      'import chatterbox',
      'from chatterbox.mtl_tts import ChatterboxMultilingualTTS',
      'params = set(inspect.signature(ChatterboxMultilingualTTS.from_pretrained).parameters)',
      'print(json.dumps({"python": sys.version.split()[0], "torch": torch.__version__,',
      '  "chatterbox": md.version("chatterbox-tts"), "cuda": have_cuda,',
      '  "cudaRuntime": getattr(torch.version, "cuda", None), "watermark": "resemble-perth",',
      '  "multilingualAcceptsVariant": "t3_model" in params}))',
    ].join('\n')], { encoding: 'utf8' }).trim());
  const envInfo = JSON.parse(envCheck);
  if (envInfo.chatterbox !== PACKAGE_VERSION) {
    throw new Error(`installed chatterbox-tts ${envInfo.chatterbox} does not match the pin ${PACKAGE_VERSION}`);
  }
  if (engineContractId === 'chatterbox-multilingual-v3' && envInfo.multilingualAcceptsVariant !== true) {
    throw new Error(
      'Installed chatterbox-tts cannot select t3_model="v3". The pinned 0.1.7 loader defaults to v2. Refusing to write a marker that would call those weights v3.',
    );
  }
  if (!gpuReport.available && envInfo.cuda) {
    report.problems.push('nvidia-smi reported no GPU but torch reports CUDA; record which host this marker came from');
  }

  const marker = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    packageVersion: envInfo.chatterbox,
    engineContractId,
    modelId,
    modelRevision: resolvedRevision,
    modelVariant: engineContractId === 'chatterbox-multilingual-v3' ? 'v3' : null,
    pythonPath: path.relative(ROOT, venvPython).split(path.sep).join('/'),
    modelDir: MODEL_DIR,
    provisionedAt: new Date().toISOString(),
    watermark: 'resemble-perth',
    notes: [
      'Written by tools/provision-chatterbox.mjs after a verified install + snapshot.',
      `python=${envInfo.python} torch=${envInfo.torch} cuda=${envInfo.cuda}`,
      gpuReport.available ? `gpu=${gpuReport.name}` : 'gpu=none (CPU synthesis requires the explicit allowCpu opt-in)',
    ].join(' | '),
  };
  step(`write verified marker ${markerRel}`, () => {
    fs.mkdirSync(path.dirname(markerAbs), { recursive: true });
    fs.writeFileSync(markerAbs, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  });
  report.markerWritten = true;

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n${G}Chatterbox provisioning complete.${X}`);
    console.log(`  engine:    ${engineContractId} (${modelId})`);
    console.log(`  revision:  ${resolvedRevision}`);
    console.log(`  env:       ${ENV_DIR}`);
    console.log(`  model:     ${MODEL_DIR}`);
    console.log(`  marker:    ${markerRel}`);
    console.log(`\n${D}Synthesis is offline from now on: the adapter verifies this marker before spawning the worker.${X}\n`);
  }
  process.exit(0);
} catch (e) {
  report.problems.push(e.message);
  if (json) console.log(JSON.stringify(report, null, 2));
  console.error(`\n${R}Provisioning failed:${X} ${e.message}`);
  console.error(`${D}Nothing was marked as provisioned. Fix the failure and re-run --apply.${X}\n`);
  process.exit(2);
}
