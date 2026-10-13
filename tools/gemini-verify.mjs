#!/usr/bin/env node
/**
 * Gemini live verification for Windows (or any host with Node 18+).
 *
 * Reads GEMINI_API_KEY from the environment ONLY. The key is never printed, never
 * written to a file, and never placed in a URL. Error output shows status codes and
 * short messages, never a raw provider body.
 *
 * Modes (exactly one):
 *   --preflight                 GET the model catalog. Not billable generation.
 *                               Proves catalog access only, not quota or free tier.
 *   --text --confirm-free-tier  ONE structured plan request for a fixed built-in
 *                               fixture brief. At most 2 text requests per session
 *                               (the second is the single repair).
 *   --speech --confirm-free-tier --reviewed --text-file <path> [--language en|ar]
 *                               [--voice Kore] [--profile educational]
 *                               ONE clip of at most 20 seconds. Reviewed text only.
 *                               At most 2 voice previews per session.
 *
 * Generation also requires the environment flags GEMINI_GENERATION_ENABLED=1 and
 * GEMINI_FREE_TIER_CONFIRMED=1, which the owner sets only after confirming a free-tier key.
 *
 * Outputs (never committed): output/gemini-verify/ (budget.json, evidence.json, preview WAV)
 * and the verification record read by the app (BUILDTRAKE_DATA or data/factory/ai/verification.json).
 *
 * Run from the repository root after `npm ci` and `npm run build:core`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'output', 'gemini-verify');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const CAP_TEXT = 2;
const CAP_VOICE = 2;
const MAX_PREVIEW_SEC = 20;
const MAX_PREVIEW_CHARS = 350;
const TIMEOUT_MS = 60000;
const FIXTURE_BRIEF = 'FIXTURE brief for a live check: explain in two short lines why a delivery window should be confirmed before a concrete pour.';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

function say(obj) {
  console.log(JSON.stringify(obj, null, 2));
}
function die(msg, code = 1) {
  console.error(`STOP: ${msg}`);
  process.exit(code);
}

// Load the built core package (validator, WAV parser, request builders).
let core;
try {
  core = await import('@buildtrack/core');
} catch {
  die('The core package is not built. Run "npm ci --ignore-scripts" and "npm run build:core" first.');
}

const key = (process.env.GEMINI_API_KEY ?? '').trim();
const textModel = process.env.GEMINI_TEXT_MODEL?.trim() || core.GEMINI_DEFAULT_TEXT_MODEL;
const ttsModel = process.env.GEMINI_TTS_MODEL?.trim() || core.GEMINI_DEFAULT_TTS_MODEL;
const sessionId = (process.env.GEMINI_SESSION_ID?.trim() || 'default').slice(0, 64);
const dataDir = process.env.BUILDTRAKE_DATA || path.join(ROOT, 'data');
const verificationFile = process.env.GEMINI_VERIFICATION_FILE?.trim() || path.join(dataDir, 'factory', 'ai', 'verification.json');
const ledgerFile = path.join(OUT, 'budget.json');

if (!key) die('GEMINI_API_KEY is not set in this environment. Set it in your user environment (see PROVIDER_SETUP_AR.md). Nothing was called.');
const mode = flag('--preflight') ? 'preflight' : flag('--text') ? 'text' : flag('--speech') ? 'speech' : null;
if (!mode) die('Choose exactly one mode: --preflight, --text, or --speech.');

fs.mkdirSync(OUT, { recursive: true });
const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {};
ledger[sessionId] ??= { text: 0, voice: 0 };

function readVerification() {
  try {
    return JSON.parse(fs.readFileSync(verificationFile, 'utf8'));
  } catch {
    return {};
  }
}
function writeVerification(patch) {
  const prev = readVerification();
  const next = { ...prev, ...patch, checkedAt: new Date().toISOString(), sessionId };
  fs.mkdirSync(path.dirname(verificationFile), { recursive: true });
  fs.writeFileSync(verificationFile, JSON.stringify(next, null, 2));
}

/** Redacted call: returns { ok, status, json } and never prints the body or the key. */
async function call(url, init = {}) {
  try {
    const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), 'x-goog-api-key': key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: e?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

function describeStatus(s) {
  if (s === 401) return 'Key rejected (401). Check GEMINI_API_KEY.';
  if (s === 403) return 'Access refused (403). Check the key, its project, and model access.';
  if (s === 429) return 'Quota or rate limit reached (429). Stopped; no paid fallback was used.';
  if (s === 0) return 'Network error or timeout. Nothing was saved.';
  return `Provider returned HTTP ${s}.`;
}

function sha(b) {
  return crypto.createHash('sha256').update(b).digest('hex');
}

if (mode === 'preflight') {
  const r = await call(`${BASE}/models?pageSize=1000`, { method: 'GET' });
  if (!r.ok) {
    writeVerification({ catalogReachable: false });
    say({ mode, catalogReachable: false, status: r.status, message: describeStatus(r.status), generation: 'not performed' });
    process.exit(2);
  }
  const names = new Set((r.json?.models ?? []).map((m) => String(m.name ?? '').replace(/^models\//, '')));
  const evidence = {
    mode,
    catalogReachable: true,
    textModelListed: names.has(textModel),
    ttsModelListed: names.has(ttsModel),
    textModel,
    ttsModel,
    note: 'Catalog access only. This is not proof of quota, free tier, or generation.',
    generation: 'not performed',
  };
  writeVerification({ catalogReachable: true, textModel, ttsModel });
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
  say(evidence);
  process.exit(0);
}

// ---- Generation modes: all gates first, before any call -------------------
if (!flag('--confirm-free-tier')) die('Generation needs --confirm-free-tier. Confirm you have a free-tier key with a budget limit. Nothing was called.');
if (process.env.GEMINI_GENERATION_ENABLED !== '1') die('Set GEMINI_GENERATION_ENABLED=1 for this run. Nothing was called.');
if (process.env.GEMINI_FREE_TIER_CONFIRMED !== '1') die('Set GEMINI_FREE_TIER_CONFIRMED=1 after you confirm the free-tier key. Nothing was called.');

if (mode === 'text') {
  if (ledger[sessionId].text >= CAP_TEXT) die(`The text budget for session "${sessionId}" is used (${CAP_TEXT}). Nothing was called.`);
  const prompt = core.buildPlanPrompt({
    profile: 'educational',
    format: 'landscape',
    brief: FIXTURE_BRIEF,
    references: [],
    productFacts: [],
    productMentionRequested: false,
  });
  const ctx = { profile: 'educational', suppliedReferenceIds: [], productFactIds: [], productMentionRequested: false };
  let repairErrors;
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (ledger[sessionId].text >= CAP_TEXT) break;
    ledger[sessionId].text += 1;
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
    const body = core.buildTextRequestBody(repairErrors ? `${prompt}\n\nYour previous answer failed validation. Correct these problems and return the full JSON again:\n${repairErrors.map((e) => `- ${e}`).join('\n')}` : prompt, core.GEMINI_HARD_CAPS.maxOutputTokens);
    const r = await call(`${BASE}/models/${textModel}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      writeVerification({ textGenerationOk: false });
      say({ mode, textGenerationOk: false, status: r.status, message: describeStatus(r.status), attempt });
      process.exit(2);
    }
    const blocked = r.json?.promptFeedback?.blockReason ?? null;
    const cand = r.json?.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p) => p?.text ?? '').join('');
    if (blocked || !cand || !text.trim()) {
      writeVerification({ textGenerationOk: false });
      say({ mode, textGenerationOk: false, message: 'Blocked or empty output. No repair was attempted.', blockReason: blocked });
      process.exit(2);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      repairErrors = ['The output was not valid JSON.'];
      continue;
    }
    const v = core.validateGeneratedPlan(parsed, ctx);
    if (v.ok) {
      result = { attempts: attempt, lines: v.plan.script.lines.length, treatments: v.plan.treatments.map((t) => t.method), usage: r.json?.usageMetadata ?? null };
      break;
    }
    repairErrors = v.errors.slice(0, 8);
  }
  if (!result) {
    writeVerification({ textGenerationOk: false });
    say({ mode, textGenerationOk: false, message: 'Output failed validation after the single allowed repair. Nothing was saved.' });
    process.exit(2);
  }
  writeVerification({ textGenerationOk: true, textModel });
  const evidence = { mode, textGenerationOk: true, model: textModel, ...result, budgetUsedText: ledger[sessionId].text, budgetCapText: CAP_TEXT, note: 'Fixture brief only. Structural validation only; not owner review.' };
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
  say(evidence);
  process.exit(0);
}

if (mode === 'speech') {
  if (!flag('--reviewed')) die('Speech needs --reviewed: confirm the text file was reviewed by the owner. Nothing was called.');
  const file = opt('--text-file');
  if (!file || !fs.existsSync(file)) die('Speech needs --text-file <path> to an existing reviewed text file. Nothing was called.');
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text || text.length > MAX_PREVIEW_CHARS) die(`The text must be 1 to ${MAX_PREVIEW_CHARS} characters. Nothing was called.`);
  const language = opt('--language') ?? 'en';
  if (language !== 'en' && language !== 'ar') die('--language must be en or ar.');
  if (language === 'ar' && !/[\u0600-\u06FF]/.test(text)) die('The text is marked ar but has no Arabic letters. Nothing was called.');
  const voice = opt('--voice') ?? 'Kore';
  if (!core.GEMINI_PREBUILT_VOICES.includes(voice)) die('--voice must be one of the prebuilt voices.');
  const profile = opt('--profile') ?? 'educational';
  if (!/^[a-z]{3,20}$/.test(profile)) die('--profile must be a short lowercase label. Nothing was called.');
  if (ledger[sessionId].voice >= CAP_VOICE) die(`The voice budget for session "${sessionId}" is used (${CAP_VOICE}). Nothing was called.`);
  // At most one derived preview per profile: an existing preview for this profile blocks another call.
  if (fs.readdirSync(OUT).some((f) => f.startsWith(`preview-${profile}-`) && f.endsWith('.wav'))) {
    die(`A preview for profile "${profile}" already exists. Only one preview per profile is allowed. Nothing was called.`);
  }
  const style = opt('--style') ?? '';
  let body;
  try {
    body = core.buildSpeechRequestBody({ text, style, voiceName: voice });
  } catch (e) {
    die(`${e.message}. Nothing was called.`);
  }
  ledger[sessionId].voice += 1;
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  const r = await call(`${BASE}/models/${ttsModel}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    writeVerification({ speechGenerationOk: false });
    say({ mode, speechGenerationOk: false, status: r.status, message: describeStatus(r.status) });
    process.exit(2);
  }
  const part = (r.json?.candidates?.[0]?.content?.parts ?? []).find((p) => p?.inlineData?.data);
  const mime = String(part?.inlineData?.mimeType ?? '');
  if (!part || !/^audio\/wav$/i.test(mime)) {
    writeVerification({ speechGenerationOk: false });
    say({ mode, speechGenerationOk: false, message: `No WAV audio was returned (type "${mime || 'none'}"). Nothing was saved.` });
    process.exit(2);
  }
  const bytes = new Uint8Array(Buffer.from(part.inlineData.data, 'base64'));
  const wav = core.parseWav(bytes);
  if (!wav.valid || wav.durationSec > MAX_PREVIEW_SEC) {
    writeVerification({ speechGenerationOk: false });
    say({ mode, speechGenerationOk: false, message: wav.valid ? `Clip is over ${MAX_PREVIEW_SEC} seconds. Discarded.` : wav.reason });
    process.exit(2);
  }
  const durationNote = wav.durationSec < 10 ? 'Clip is under 10 seconds: accepted, but it is shorter than the 10-20 second preview target.' : null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(OUT, `preview-${profile}-${language}-${stamp}.wav`);
  fs.writeFileSync(outFile, bytes);
  const prev = readVerification();
  const langs = new Set(prev.speechLanguagesLive ?? []);
  langs.add(language);
  writeVerification({ speechGenerationOk: true, ttsModel, speechLanguagesLive: [...langs] });
  const evidence = {
    mode,
    speechGenerationOk: true,
    model: ttsModel,
    voice,
    language,
    profile,
    textChars: text.length,
    textSha256: sha(text),
    styleSha256: sha(style),
    wavSha256: sha(bytes),
    bytes: bytes.byteLength,
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    durationSec: wav.durationSec,
    previewFile: path.relative(ROOT, outFile),
    budgetUsedVoice: ledger[sessionId].voice,
    budgetCapVoice: CAP_VOICE,
    listened: false,
    durationNote,
    note: 'Not listened to. Listening review is the owner\'s step. Duration is not word alignment.',
  };
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
  say(evidence);
  process.exit(0);
}
