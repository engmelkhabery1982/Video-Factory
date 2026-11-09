#!/usr/bin/env node
/**
 * Gemini live verification for Windows (or any host with Node 18+).
 *
 * This script drives the SAME services the app uses: the real API is loaded in-process
 * (apps/api/src/server.ts) and the requests go through its routes, so the plan job,
 * speech preview job, draft conversion, budget ledger and evidence binding are the app's
 * code paths. The only direct provider call is the read-only catalog check in --preflight.
 *
 * Reads GEMINI_API_KEY from the environment ONLY. The key is never printed, never written
 * to a file, and never placed in a URL. All printed and saved output is redacted.
 *
 * Required for every mode:
 *   --qa-root <dir>             Explicit isolated folder for this session. Its data/, output/
 *                               and evidence/ subfolders are created here. The default owner
 *                               data/ and output/ folders are refused. Keep the SAME folder for
 *                               the whole session: the budget ledger lives inside it, and
 *                               deleting it resets the ledger.
 *
 * Modes (exactly one):
 *   --preflight                 GET the model catalog. Read-only. Not billable generation.
 *                               Proves catalog access only, not quota, free tier or generation.
 *   --text --confirm-free-tier  ONE plan job for a fixed fixture brief, then one draft
 *                               conversion. Budget: 2 text previews per session.
 *   --speech --confirm-free-tier --reviewed --text-file <path> [--language en|ar]
 *            [--voice Kore] [--profile educational] [--style "..."]
 *                               ONE clip of at most 20 seconds from reviewed text.
 *                               Budget: 2 voice previews per session.
 *
 * Generation also requires GEMINI_GENERATION_ENABLED=1 and GEMINI_FREE_TIER_CONFIRMED=1,
 * which the owner sets only after confirming a free-tier key with a budget limit.
 *
 * Run from the repository root after `npm ci --ignore-scripts` and `npm run build:core`:
 *   node --import tsx tools/gemini-verify.mjs --qa-root C:\\buildtrack-qa --preflight
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const KEY = (process.env.GEMINI_API_KEY ?? '').trim();

function redact(text) {
  let out = String(text);
  if (KEY) out = out.split(KEY).join('[REDACTED_KEY]');
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]');
}
function say(obj) {
  console.log(redact(JSON.stringify(obj, null, 2)));
}
function die(msg, code = 1) {
  console.error(redact(`STOP: ${msg}`));
  process.exit(code);
}

const FIXTURE_BRIEF =
  'FIXTURE brief for a live check: explain in two short lines why a delivery window should be confirmed the night before.';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

// ---- 1. Mode and isolation gates: all refusals happen before any call -----------------
const mode = flag('--preflight') ? 'preflight' : flag('--text') ? 'text' : flag('--speech') ? 'speech' : null;
if (!mode) die('Choose exactly one mode: --preflight, --text, or --speech.');
const qaRootArg = opt('--qa-root');
if (!qaRootArg) die('--qa-root <dir> is required: an explicit isolated folder for this session. Nothing was called.');
const qaRoot = path.resolve(qaRootArg);
if (qaRoot === ROOT || qaRoot.startsWith(ROOT + path.sep)) {
  die('--qa-root must be outside the repository (no data/, output/ or Git-tracked folder). Nothing was called.');
}
const dataDir = path.join(qaRoot, 'data');
const outDir = path.join(qaRoot, 'output');
const evidenceDir = path.join(qaRoot, 'evidence');
fs.mkdirSync(evidenceDir, { recursive: true });

if (mode !== 'preflight') {
  if (!flag('--confirm-free-tier')) die('Generation needs --confirm-free-tier: confirm you have a free-tier key with a budget limit. Nothing was called.');
  if (process.env.GEMINI_GENERATION_ENABLED !== '1') die('Set GEMINI_GENERATION_ENABLED=1 for this run. Nothing was called.');
  if (process.env.GEMINI_FREE_TIER_CONFIRMED !== '1') die('Set GEMINI_FREE_TIER_CONFIRMED=1 after you confirm the free-tier key. Nothing was called.');
}
if (!KEY) die('GEMINI_API_KEY is not set in this environment. Nothing was called. Set it in your own shell; it is never printed.');

let speechText = '';
let speechLanguage = 'en';
let speechVoice = 'Kore';
let speechStyle = '';
let speechProfile = 'educational';
if (mode === 'speech') {
  if (!flag('--reviewed')) die('Speech needs --reviewed: confirm the text file was reviewed by the owner. Nothing was called.');
  const file = opt('--text-file');
  if (!file || !fs.existsSync(file)) die('Speech needs --text-file <path> to an existing reviewed text file. Nothing was called.');
  speechText = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  speechLanguage = opt('--language') ?? 'en';
  if (speechLanguage !== 'en' && speechLanguage !== 'ar') die('--language must be en or ar. Nothing was called.');
  speechVoice = opt('--voice') ?? 'Kore';
  speechStyle = opt('--style') ?? '';
  speechProfile = opt('--profile') ?? 'educational';
}

// ---- 2. Point the app at the isolated QA root BEFORE it is imported -------------------
process.env.BUILDTRAKE_DATA = dataDir;
process.env.BUILDTRAKE_OUTPUT = outDir;
process.env.GEMINI_VERIFICATION_FILE = process.env.GEMINI_VERIFICATION_FILE?.trim()
  ? path.resolve(process.env.GEMINI_VERIFICATION_FILE)
  : path.join(dataDir, 'factory', 'ai', 'verification.json');
if (!path.resolve(process.env.GEMINI_VERIFICATION_FILE).startsWith(qaRoot + path.sep)) {
  die('GEMINI_VERIFICATION_FILE must live inside --qa-root. Nothing was called.');
}

let server;
let gemini;
try {
  server = await import(pathToFileURL(path.join(ROOT, 'apps/api/src/server.ts')).href);
  gemini = await import(pathToFileURL(path.join(ROOT, 'apps/api/src/services/gemini-client.ts')).href);
} catch (err) {
  die(`Could not load the API services. Run "npm ci --ignore-scripts" and "npm run build:core" first. (${err?.code ?? err?.name ?? 'error'})`);
}
const geminiService = await import(pathToFileURL(path.join(ROOT, 'apps/api/src/services/gemini-service.ts')).href);
const geminiStore = await import(pathToFileURL(path.join(ROOT, 'apps/api/src/services/gemini-store.ts')).href);
// Same directory the app uses (DATA_DIR/factory/ai), so the ledger and evidence are the app's.
const aiDir = path.join(dataDir, 'factory', 'ai');

// Models and the verification binding come from the app's own config, never from defaults in this file.
const cfgOf = () => geminiService.readGeminiConfig(process.env, aiDir);
const { textModel, ttsModel } = cfgOf();
const fingerprint = gemini.credentialFingerprint(KEY);

function readVerification() {
  return new geminiStore.ProviderStore(aiDir).readVerification(process.env.GEMINI_VERIFICATION_FILE);
}
function writeVerification(patch) {
  const prev = readVerification();
  const sameBinding = prev && prev.credentialFingerprint === fingerprint && prev.textModel === textModel && prev.ttsModel === ttsModel;
  const base = sameBinding
    ? prev
    : {
        checkedAt: null, sessionId: cfgOf().sessionId, catalogReachable: false, endpoint: null,
        credentialFingerprint: null, textModel: null, ttsModel: null, textGenerationOk: false,
        speechGenerationOk: false, speechLanguagesLive: [],
      };
  const next = {
    ...base,
    ...patch,
    checkedAt: new Date().toISOString(),
    endpoint: gemini.GEMINI_API_BASE,
    credentialFingerprint: fingerprint,
    textModel,
    ttsModel,
    speechLanguagesLive: [...new Set([...(base.speechLanguagesLive ?? []), ...(patch.speechLanguagesLive ?? [])])],
  };
  fs.mkdirSync(path.dirname(process.env.GEMINI_VERIFICATION_FILE), { recursive: true });
  fs.writeFileSync(process.env.GEMINI_VERIFICATION_FILE, JSON.stringify(next, null, 2));
  return next;
}
function saveEvidence(name, body) {
  const file = path.join(evidenceDir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, redact(JSON.stringify(body, null, 2)));
  return file;
}

// ---- 3. Modes -----------------------------------------------------------------------
async function preflight() {
  // Read-only catalog check. Same endpoint family and credential header as the app client.
  let status = null;
  let catalogReachable = false;
  try {
    const res = await fetch(`${gemini.GEMINI_API_BASE}/models?pageSize=1`, {
      headers: { 'x-goog-api-key': KEY },
      signal: AbortSignal.timeout(15000),
    });
    status = res.status;
    catalogReachable = res.ok;
    await res.arrayBuffer().catch(() => undefined);
  } catch (err) {
    status = `network:${err?.name ?? 'error'}`;
  }
  const record = writeVerification({ catalogReachable });
  const app = await server.buildServerApp();
  const res = await app.inject({ method: 'GET', url: '/api/factory/ai/status' });
  const capabilities = JSON.parse(res.body);
  await app.close();
  const evidence = {
    mode: 'preflight', catalogHttpStatus: status, catalogReachable, models: { text: textModel, tts: ttsModel },
    credentialFingerprint: fingerprint, endpoint: gemini.GEMINI_API_BASE, qaRoot,
    capability: capabilities.state, binding: capabilities.verification?.binding ?? 'none',
    note: 'Catalog access only. Not quota, free tier or generation. Nothing billable was called.',
    verificationRecordedAt: record.checkedAt,
  };
  say(evidence);
  saveEvidence('preflight', evidence);
  if (!catalogReachable) process.exitCode = 1;
}

async function pollJob(app, jobId, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await app.inject({ method: 'GET', url: `/api/factory/ai/jobs/${jobId}` });
    const job = JSON.parse(r.body).job;
    if (TERMINAL.has(job.status)) return job;
    if (Date.now() > until) return { ...job, status: 'client_timeout' };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function textMode() {
  const app = await server.buildServerApp();
  const created = await app.inject({
    method: 'POST', url: '/api/factory/ai/plans',
    payload: { profile: 'educational', format: 'landscape', brief: FIXTURE_BRIEF },
  });
  if (created.statusCode >= 400) {
    const err = JSON.parse(created.body);
    await app.close();
    die(`Plan job refused: ${err.code}. ${err.error ?? ''}`);
  }
  const jobId = JSON.parse(created.body).job.id;
  const job = await pollJob(app, jobId, 180000);
  const evidence = { mode: 'text', jobId, status: job.status, model: textModel, endpoint: gemini.GEMINI_API_BASE, qaRoot, credentialFingerprint: fingerprint };
  if (job.status !== 'succeeded') {
    evidence.failure = { code: job.error?.code ?? null, message: job.error?.message ?? null };
    say(evidence);
    saveEvidence('text', evidence);
    await app.close();
    process.exitCode = 1;
    return;
  }
  const draft = await app.inject({ method: 'POST', url: `/api/factory/ai/plans/${jobId}/draft`, payload: {} });
  const body = JSON.parse(draft.body);
  evidence.draftHttpStatus = draft.statusCode;
  evidence.draftId = body.draft?.id ?? null;
  evidence.treatments = (body.draft?.treatments ?? []).map((t) => ({ id: t.id, title: t.title, scenes: t.scenes.length }));
  evidence.note = 'A successful provider call. Not listening review and not owner approval. Script text is unapproved.';
  writeVerification({ textGenerationOk: true });
  say(evidence);
  saveEvidence('text', evidence);
  await app.close();
}

async function speechMode() {
  const app = await server.buildServerApp();
  const idem = `verify-${crypto.createHash('sha256').update(speechText + speechVoice + speechLanguage + speechStyle).digest('hex').slice(0, 16)}`;
  const created = await app.inject({
    method: 'POST', url: '/api/factory/ai/speech-previews',
    payload: { text: speechText, voice: speechVoice, language: speechLanguage, style: speechStyle, idempotencyKey: idem },
  });
  if (created.statusCode >= 400) {
    const err = JSON.parse(created.body);
    await app.close();
    die(`Speech preview refused: ${err.code}. ${err.error ?? ''}`);
  }
  const jobId = JSON.parse(created.body).job.id;
  const job = await pollJob(app, jobId, 180000);
  const evidence = {
    mode: 'speech', jobId, status: job.status, language: speechLanguage, voice: speechVoice,
    model: ttsModel, endpoint: gemini.GEMINI_API_BASE, qaRoot, credentialFingerprint: fingerprint,
    textCharacters: speechText.length, reviewedInput: true,
  };
  if (job.status !== 'succeeded') {
    evidence.failure = { code: job.error?.code ?? null, message: job.error?.message ?? null };
    say(evidence);
    saveEvidence('speech', evidence);
    await app.close();
    process.exitCode = 1;
    return;
  }
  const audio = await app.inject({ method: 'GET', url: `/api/factory/ai/jobs/${jobId}/audio` });
  if (audio.statusCode !== 200) {
    evidence.failure = { code: 'AUDIO_UNAVAILABLE', message: `audio route returned ${audio.statusCode}` };
    say(evidence);
    saveEvidence('speech', evidence);
    await app.close();
    process.exitCode = 1;
    return;
  }
  const wavPath = path.join(outDir, 'gemini-verify', `preview-${speechLanguage}-${jobId}.wav`);
  fs.mkdirSync(path.dirname(wavPath), { recursive: true });
  fs.writeFileSync(wavPath, audio.rawPayload);
  evidence.clip = { path: path.relative(qaRoot, wavPath), bytes: audio.rawPayload.length, sha256: crypto.createHash('sha256').update(audio.rawPayload).digest('hex') };
  evidence.note = 'A successful provider call. Listening review and owner approval are separate and still pending.';
  writeVerification({ speechGenerationOk: true, speechLanguagesLive: [speechLanguage] });
  say(evidence);
  saveEvidence('speech', evidence);
  await app.close();
}

try {
  if (mode === 'preflight') await preflight();
  else if (mode === 'text') await textMode();
  else await speechMode();
} catch (err) {
  // Never print the raw error body or stack: they may echo request metadata.
  die(`Verification stopped: ${err?.code ?? err?.name ?? 'error'}. Nothing was saved beyond this message.`);
}
