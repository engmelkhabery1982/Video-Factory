#!/usr/bin/env node
/**
 * Resumable preflight for LOCAL picture analysis and REFERENCE-CONDITIONED stills.
 *
 * What it does: reads scripts/local-visual/manifest.json and the env vars it names; checks each file's size and SHA-256
 * (streamed, cached by path+size+mtime so a re-run resumes); runs `--help` on the runner binaries (no model is loaded);
 * and asks a LOOPBACK vision server for /health (no inference, no chat request).
 * What it never does: download anything, install anything, call a provider, run a generation, or send a picture anywhere.
 *
 * Usage:  node scripts/verify-local-visual.mjs [--root data/local-visual-verify] [--fresh] [--manifest path]
 * Exit:   0 all required items PASS · 1 a check FAILED · 2 BLOCKED (an input is missing; re-run after placing it)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const manifestPath = path.resolve(opt('--manifest', 'scripts/local-visual/manifest.json'));
const rootDir = path.resolve(opt('--root', 'data/local-visual-verify'));
const fresh = flag('--fresh');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
fs.mkdirSync(rootDir, { recursive: true });
const statePath = path.join(rootDir, 'state.json');
const prior = !fresh && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { hashes: {} };
const state = { hashes: prior.hashes ?? {} };

const results = [];
const record = (id, status, detail) => {
  results.push({ id, status, detail });
  const mark = status === 'PASS' ? 'PASS   ' : status === 'FAIL' ? 'FAIL   ' : 'BLOCKED';
  console.log(`${mark} ${id}: ${detail}`);
};

async function sha256Of(file) {
  const st = fs.statSync(file);
  const key = path.resolve(file);
  const cached = state.hashes[key];
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.sha256;
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  const sha256 = hash.digest('hex');
  state.hashes[key] = { size: st.size, mtimeMs: st.mtimeMs, sha256 };
  return sha256;
}

function helpOf(exe) {
  const r = spawnSync(exe, ['--help'], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) return { ok: false, text: '', error: r.error.code ?? 'spawn failed' };
  return { ok: true, text: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

async function checkItem(item) {
  const envName = item.env;
  const given = (process.env[envName] ?? '').trim();
  if (!given) {
    record(item.id, 'BLOCKED', `set ${envName} to the file on this computer${item.owner_path_given ? ` (given: ${item.owner_path_given})` : item.owner_path_suggested ? ` (suggested: ${item.owner_path_suggested})` : ''}.`);
    return;
  }
  if (!fs.existsSync(given) || !fs.statSync(given).isFile()) {
    record(item.id, 'BLOCKED', `${envName} points to a file that does not exist. Place the file, then re-run.`);
    return;
  }
  const size = fs.statSync(given).size;
  if (typeof item.bytes === 'number' && size !== item.bytes) {
    record(item.id, 'FAIL', `size is ${size} bytes; the manifest says ${item.bytes}. Wrong file or a partial download.`);
    return;
  }
  const actual = await sha256Of(given);
  const expected = (process.env[item.env_sha256 ?? ''] ?? '').trim().toLowerCase();
  if (item.env_sha256 && !expected) {
    record(item.id, 'BLOCKED', `set ${item.env_sha256} to the SHA-256 of this file (computed above: ${actual}). The app refuses to run without it.`);
    return;
  }
  if (item.upstream_sha256 && actual !== item.upstream_sha256) {
    record(item.id, 'FAIL', `SHA-256 is ${actual}; the manifest pins ${item.upstream_sha256}. Wrong file.`);
    return;
  }
  if (item.env_sha256 && expected !== actual) {
    record(item.id, 'FAIL', `${item.env_sha256} does not match the file (${actual}).`);
    return;
  }
  const pin = item.upstream_sha256 ? 'matches the manifest pin' : 'has no pin in the manifest; SHA-256 recorded';
  record(item.id, 'PASS', `${size} bytes, SHA-256 ${actual} ${pin}${item.env_sha256 ? ' and the recorded value' : ''}.`);
}

/** The downloaded release archive (zip) that the executable came from. Checked by size and SHA-256 only. */
async function checkArchive(item) {
  const a = item.archive;
  const given = (process.env[a.env] ?? '').trim();
  if (!given) {
    record(`${item.id}-archive`, 'BLOCKED', `set ${a.env} to the downloaded ${a.name}. Its SHA-256 is pinned in the manifest.`);
    return;
  }
  if (!fs.existsSync(given) || !fs.statSync(given).isFile()) {
    record(`${item.id}-archive`, 'BLOCKED', `${a.env} points to a file that does not exist. Download ${a.name} from the pinned release, then re-run.`);
    return;
  }
  const size = fs.statSync(given).size;
  if (size !== a.bytes) { record(`${item.id}-archive`, 'FAIL', `${a.name} is ${size} bytes; the pin is ${a.bytes}. Re-download it.`); return; }
  const actual = await sha256Of(given);
  if (actual !== a.sha256) { record(`${item.id}-archive`, 'FAIL', `${a.name} SHA-256 is ${actual}; the pin is ${a.sha256}.`); return; }
  record(`${item.id}-archive`, 'PASS', `${a.name}: ${size} bytes, SHA-256 matches the pin.`);
}

function checkExe(item) {
  const given = (process.env[item.env] ?? '').trim();
  if (!given || !fs.existsSync(given)) return; // Reported by checkItem.
  const h = helpOf(given);
  if (!h.ok) {
    record(`${item.id}-help`, 'FAIL', `could not run --help (${h.error}). Check the binary and its folder.`);
    return;
  }
  const missing = (item.required_flags ?? []).filter((f) => !new RegExp(`(^|\\s)${f.replace(/[-]/g, '\\-')}(\\s|,|$|=)`, 'm').test(h.text));
  if (missing.length > 0) {
    record(`${item.id}-help`, 'FAIL', `--help does not list: ${missing.join(' ')}. This binary is not the pinned release.`);
    return;
  }
  record(`${item.id}-help`, 'PASS', `--help lists ${(item.required_flags ?? []).join(' ')}. No model was loaded.`);
}

async function checkHealth() {
  const url = (process.env.VISION_URL ?? '').trim();
  if (!url) {
    record('vision-health', 'BLOCKED', 'set VISION_URL to the loopback address of the vision server (for example http://127.0.0.1:8081). Start the server first; picture analysis needs it.');
    return;
  }
  let u;
  try { u = new URL(url); } catch { record('vision-health', 'FAIL', 'VISION_URL is not a valid URL.'); return; }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) {
    record('vision-health', 'FAIL', `VISION_URL host is ${u.hostname}. It must be loopback. Nothing is sent off this computer.`);
    return;
  }
  try {
    const res = await fetch(new URL('/health', u), { signal: AbortSignal.timeout(5000) });
    if (res.ok) record('vision-health', 'PASS', `GET /health answered ${res.status} on loopback. No inference was run.`);
    else record('vision-health', 'FAIL', `GET /health answered ${res.status}. Is the server the vision server with the projector loaded?`);
  } catch {
    record('vision-health', 'BLOCKED', 'the vision server is not answering on loopback. Start llama-server with the vision model and projector, then re-run.');
  }
}

console.log(`Local visual verification (no downloads, no provider calls, no generation). Root: ${rootDir}`);
for (const item of manifest.items) {
  await checkItem(item);
  if (item.archive) await checkArchive(item);
  if (item.check === 'exe_help') checkExe(item);
}
await checkHealth();

fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const report = {
  checkedAt: new Date().toISOString(),
  manifest: path.relative(process.cwd(), manifestPath),
  summary: { pass: results.filter((r) => r.status === 'PASS').length, fail: results.filter((r) => r.status === 'FAIL').length, blocked: results.filter((r) => r.status === 'BLOCKED').length },
  results,
  note: 'Preflight evidence only. It does not show that a model reads pictures correctly or that a still looks right.',
};
fs.writeFileSync(path.join(rootDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\nSummary: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.blocked} blocked. Report: ${path.join(rootDir, 'report.json')}`);
process.exit(report.summary.fail > 0 ? 1 : report.summary.blocked > 0 ? 2 : 0);
