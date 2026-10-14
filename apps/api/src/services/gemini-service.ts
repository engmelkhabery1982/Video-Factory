/**
 * Gemini planning and speech-preview jobs (Milestone 3).
 *
 * Gates, in order: input validation, credentials present, generation enabled AND
 * free-tier confirmed (server flags), idempotency, budget reservation. Only then is
 * a provider call made. Nothing runs on page load, typing, saving, polling or reopening.
 *
 * Output is validated before it is saved. A blocked, empty or invalid answer fails
 * safely. One schema repair is allowed inside the same session budget. No paid fallback.
 */
import { localPlannerConfig, localPlannerStatus, localPlanCompletion, type LocalPlannerConfig } from './local-planner.js';
import fs from 'node:fs';
import { isKnownGoogleVoice } from './gemini-voices.js';
import path from 'node:path';
import { DATA_DIR } from './platform.js';
import {
  FactoryError,
  GEMINI_DEFAULT_TEXT_MODEL,
  GEMINI_DEFAULT_TTS_MODEL,
  GEMINI_HARD_CAPS,
  GEMINI_PREBUILT_VOICES,
  buildPlanPrompt,
  buildSpeechRequestBody,
  GEMINI_HARD_CAPS as CAPS,
  validateGeneratedPlan,
  type PlanProfile,
  type PlanValidationContext,
  type SpeechEvidenceState,
} from '@buildtrack/core';
import {
  GeminiProviderError,
  blockedOrEmpty,
  credentialFingerprint,
  GEMINI_API_BASE,
  generateContentRaw,
  parseSpeechResponse,
  parseStructuredText,
  sha256Hex,
  type FetchLike,
} from './gemini-client.js';
import { ProviderStore, productionCapOf, type Budget, type JobRecord, type VerificationRecord } from './gemini-store.js';

export interface GeminiConfig {
  /** Server-side only. Never serialized, never logged, never placed in a URL. */
  apiKey: string | null;
  textModel: string;
  ttsModel: string;
  generationEnabled: boolean;
  freeTierConfirmed: boolean;
  sessionId: string;
  budget: Budget;
  timeoutMs: number;
  verificationFile: string;
}

const intEnv = (v: string | undefined, dflt: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
};

/** Reads the environment. Budgets can be lowered by config, never raised past the hard caps. */
export function readGeminiConfig(env: NodeJS.ProcessEnv, storeDir: string): GeminiConfig {
  const key = env.GEMINI_API_KEY?.trim() || null;
  return {
    apiKey: key,
    textModel: env.GEMINI_TEXT_MODEL?.trim() || GEMINI_DEFAULT_TEXT_MODEL,
    ttsModel: env.GEMINI_TTS_MODEL?.trim() || GEMINI_DEFAULT_TTS_MODEL,
    generationEnabled: env.GEMINI_GENERATION_ENABLED === '1',
    freeTierConfirmed: env.GEMINI_FREE_TIER_CONFIRMED === '1',
    sessionId: (env.GEMINI_SESSION_ID?.trim() || 'default').slice(0, 64),
    budget: {
      textRequests: Math.min(Math.max(0, intEnv(env.GEMINI_BUDGET_TEXT, GEMINI_HARD_CAPS.textRequests)), GEMINI_HARD_CAPS.textRequests),
      voicePreviews: Math.min(Math.max(0, intEnv(env.GEMINI_BUDGET_VOICE, GEMINI_HARD_CAPS.voicePreviews)), GEMINI_HARD_CAPS.voicePreviews),
      // Production speech is off unless the owner sets a per-session turn cap.
      productionTurns: Math.min(Math.max(0, intEnv(env.GEMINI_PRODUCTION_TURNS, 0)), GEMINI_HARD_CAPS.productionTurns),
    },
    timeoutMs: Math.min(Math.max(intEnv(env.GEMINI_TIMEOUT_MS, 60000), 5000), 120000),
    verificationFile: env.GEMINI_VERIFICATION_FILE?.trim() || path.join(storeDir, 'verification.json'),
  };
}

export type CapabilityState = 'credentials_missing' | 'catalog_reachable' | 'ready' | 'quota_blocked' | 'live_test_unverified';

/**
 * Whether a recorded verification applies to the current configuration. Evidence is bound to the
 * credential fingerprint and both model names. A changed key or model never inherits evidence.
 */
export function evidenceBinding(cfg: GeminiConfig, v: VerificationRecord | null): 'none' | 'current' | 'mismatch' {
  if (!v) return 'none';
  if (!cfg.apiKey) return 'mismatch';
  const same =
    v.credentialFingerprint === credentialFingerprint(cfg.apiKey) && v.ttsModel === cfg.ttsModel;
  return same ? 'current' : 'mismatch';
}

export interface AiCapabilities {
  state: CapabilityState;
  credentialsPresent: boolean;
  generationEnabled: boolean;
  freeTierConfirmed: boolean;
  models: { text: string; tts: string };
  budget: { session: string; caps: Budget; used: { text: number; voice: number; production: number } };
  /** Per language. Arabic and English are separate evidence states. */
  speechEvidence: Record<'ar' | 'en', SpeechEvidenceState>;
  verification: {
    checkedAt: string | null;
    binding: 'none' | 'current' | 'mismatch';
    endpoint: string | null;
    credentialFingerprint: string | null;
    catalogReachable: boolean;
    textGenerationOk: boolean;
    speechGenerationOk: boolean;
    speechLanguagesLive: string[];
  } | null;
  /** Production speech readiness per language. Separate from the verification previews. */
  productionSpeech: Record<'ar' | 'en', { ready: boolean; reason: string }>;
  note: string;
}

/** Capability states without any network call. Only evidence bound to this key and model can raise a state. */
export function aiCapabilities(cfg: GeminiConfig, store: ProviderStore): AiCapabilities {
  const v: VerificationRecord | null = store.readVerification(cfg.verificationFile);
  const binding = evidenceBinding(cfg, v);
  const bound = binding === 'current';
  const jobs = store.listJobs();
  const quotaRecent = jobs.some((j) => j.error?.code === 'FACTORY_PROVIDER_QUOTA' && Date.now() - Date.parse(j.updatedAt) < 24 * 3600 * 1000);
  const liveLangs = new Set(bound ? (v?.speechLanguagesLive ?? []) : []);
  const evidence = (lang: 'ar' | 'en'): SpeechEvidenceState => (liveLangs.has(lang) ? 'live_verified_unreviewed' : 'fixture_only');
  let state: CapabilityState;
  let note: string;
  if (!cfg.apiKey) {
    state = 'credentials_missing';
    note = 'No GEMINI_API_KEY is configured on the server. Generation is unavailable. Nothing was called.';
  } else if (quotaRecent) {
    state = 'quota_blocked';
    note = 'A recent job hit the quota or rate limit (429). Wait, or check the free-tier limits before trying again.';
  } else if (bound && v?.speechGenerationOk && cfg.generationEnabled && cfg.freeTierConfirmed) {
    state = 'ready';
    note = 'Live generation was recorded for this key and model, and generation is enabled.';
  } else if (bound && v?.catalogReachable) {
    state = 'catalog_reachable';
    note = 'The model catalog answered for this key. This proves catalog access only, not quota, free tier, or generation.';
  } else {
    state = 'live_test_unverified';
    note =
      binding === 'mismatch'
        ? 'Recorded evidence is for a different key or model. It does not apply here. Run the verification script again.'
        : 'A key is configured, but no live test is recorded. Run the Windows verification script first.';
  }
  const prod = (lang: 'ar' | 'en') => {
    const r = speechProductionReady({ cfg, store }, lang);
    return { ready: r.ready, reason: r.reason };
  };
  return {
    state,
    credentialsPresent: Boolean(cfg.apiKey),
    generationEnabled: cfg.generationEnabled,
    freeTierConfirmed: cfg.freeTierConfirmed,
    models: { text: cfg.textModel, tts: cfg.ttsModel },
    budget: { session: cfg.sessionId, caps: cfg.budget, used: store.usage(cfg.sessionId) },
    speechEvidence: { ar: evidence('ar'), en: evidence('en') },
    verification: v
      ? {
          checkedAt: v.checkedAt,
          binding,
          endpoint: v.endpoint ?? null,
          credentialFingerprint: v.credentialFingerprint ?? null,
          catalogReachable: bound ? v.catalogReachable : false,
          textGenerationOk: bound ? v.textGenerationOk : false,
          speechGenerationOk: bound ? v.speechGenerationOk : false,
          speechLanguagesLive: bound ? [...(v.speechLanguagesLive ?? [])] : [],
        }
      : null,
    productionSpeech: { ar: prod('ar'), en: prod('en') },
    note,
  };
}

/** Process-wide dependencies for the factory. One store, one config, one ledger. */
let sharedDeps: AiDeps | null = null;
export function geminiDeps(): AiDeps {
  if (!sharedDeps) {
    const dir = path.join(DATA_DIR, 'factory', 'ai');
    const store = new ProviderStore(dir);
    sharedDeps = { cfg: readGeminiConfig(process.env, dir), store };
  }
  return sharedDeps;
}

/**
 * Production speech readiness for one language. Reports the first missing condition. It never
 * calls the provider. A language needs its own recorded live evidence for this key and model.
 */
export function speechProductionReady(deps: { cfg: GeminiConfig; store: ProviderStore }, lang: 'ar' | 'en'): { ready: boolean; reason: string } {
  const { cfg, store } = deps;
  const langName = lang === 'ar' ? 'Arabic' : 'English';
  if (!cfg.apiKey) return { ready: false, reason: 'No Gemini key is configured on the server. Nothing was called.' };
  if (!cfg.generationEnabled || !cfg.freeTierConfirmed) {
    return { ready: false, reason: 'Generation is disabled. The owner must confirm a free-tier key and enable the server flags.' };
  }
  if (cfg.budget.productionTurns === undefined || productionCapOf('production', cfg.budget) <= 0) {
    return { ready: false, reason: 'Production speech is off. Set GEMINI_PRODUCTION_TURNS to a per-session turn cap to enable it.' };
  }
  const v = store.readVerification(cfg.verificationFile);
  if (evidenceBinding(cfg, v) !== 'current' || !(v?.speechLanguagesLive ?? []).includes(lang)) {
    return {
      ready: false,
      reason: `No live ${langName} speech evidence is recorded for this key and model. Run the Windows verification script.`,
    };
  }
  if (store.productionRemaining(cfg.sessionId, cfg.budget) <= 0) {
    return { ready: false, reason: 'The production speech budget for this session is used up.' };
  }
  return { ready: true, reason: '' };
}

export interface ProductionClip {
  bytes: Uint8Array;
  sha256: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  mimeType: 'audio/wav';
  model: string;
  voice: string;
  language: 'ar' | 'en';
  style: string;
  textSha256: string;
}

/**
 * One production speech turn: one unary call, one speaker, one prebuilt voice, WAV only.
 * Budget is reserved before the call and the reservation is not returned on failure.
 * Callers must check speechProductionReady and the turn count first; this function enforces the same gates.
 */
/**
 * Labelled test doubles never write verification evidence. Only a call through the real
 * endpoint can, so a fixture run can never make real-provider readiness look proven.
 */
export function isLabelledDouble(deps: AiDeps): boolean {
  return deps.fetchImpl !== undefined || process.env.GEMINI_TEST_DOUBLE === '1';
}

/**
 * Records a successful real provider result, bound to the endpoint, both model names and the
 * credential fingerprint. A record for another key or model is replaced, never inherited.
 */
export function recordLiveEvidence(
  deps: AiDeps,
  patch: { catalogReachable?: boolean; textGenerationOk?: boolean; speechGenerationOk?: boolean; speechLanguage?: 'ar' | 'en' },
): void {
  if (isLabelledDouble(deps) || !deps.cfg.apiKey) return;
  const fp = credentialFingerprint(deps.cfg.apiKey);
  const prev = deps.store.readVerification(deps.cfg.verificationFile);
  const bound = !!prev && prev.credentialFingerprint === fp && prev.ttsModel === deps.cfg.ttsModel;
  const base = bound
    ? (prev as NonNullable<typeof prev>)
    : { checkedAt: '', sessionId: deps.cfg.sessionId, catalogReachable: false, endpoint: null, credentialFingerprint: null, textModel: null, ttsModel: null, textGenerationOk: false, speechGenerationOk: false, speechLanguagesLive: [] as string[] };
  const langs = new Set<string>(base.speechLanguagesLive ?? []);
  if (patch.speechLanguage) langs.add(patch.speechLanguage);
  const next = {
    ...base,
    checkedAt: new Date().toISOString(),
    endpoint: GEMINI_API_BASE,
    credentialFingerprint: fp,
    textModel: deps.cfg.textModel,
    ttsModel: deps.cfg.ttsModel,
    catalogReachable: patch.catalogReachable ?? base.catalogReachable,
    textGenerationOk: base.textGenerationOk === true || patch.textGenerationOk === true,
    speechGenerationOk: base.speechGenerationOk === true || patch.speechGenerationOk === true,
    speechLanguagesLive: [...langs],
  };
  fs.mkdirSync(path.dirname(deps.cfg.verificationFile), { recursive: true });
  const tmp = `${deps.cfg.verificationFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, deps.cfg.verificationFile);
}

export async function synthesizeProductionTurn(
  deps: AiDeps,
  input: { text: string; style: string; voice: string; language: 'ar' | 'en' },
): Promise<ProductionClip> {
  const ready = speechProductionReady(deps, input.language);
  if (!ready.ready) {
    throw new GeminiProviderError('FACTORY_PROVIDER_DISABLED', ready.reason, 403);
  }
  if (!isKnownGoogleVoice(input.voice)) {
    throw new GeminiProviderError('FACTORY_VALIDATION', 'Select a studio voice or load a verified voice from the Google library.', 400);
  }
  let body: unknown;
  try {
    body = buildSpeechRequestBody({ text: input.text, style: input.style, voiceName: input.voice, language: input.language });
  } catch (e) {
    throw new GeminiProviderError('FACTORY_VALIDATION', (e as Error).message.slice(0, 200), 400);
  }
  if (!deps.store.reserve(deps.cfg.sessionId, 'production', deps.cfg.budget)) {
    throw new GeminiProviderError('FACTORY_BUDGET_EXHAUSTED', 'The production speech budget is used up. Nothing was called.', 429);
  }
  const resp = await generateContentRaw({
    apiKey: deps.cfg.apiKey as string,
    model: deps.cfg.ttsModel,
    body,
    timeoutMs: deps.cfg.timeoutMs,
    fetchImpl: deps.fetchImpl,
  });
  const clip = parseSpeechResponse(resp);
  const dur = clip.wav.durationSec ?? 0;
  if (dur <= 0 || dur > CAPS.maxProductionTurnSec) {
    throw new GeminiProviderError('FACTORY_AUDIO_INVALID', `The clip is ${dur.toFixed(1)} seconds, outside the per-turn limit of ${CAPS.maxProductionTurnSec}. It was discarded.`, 422);
  }
  recordLiveEvidence(deps, { speechGenerationOk: true, speechLanguage: input.language });
  return {
    bytes: clip.bytes,
    sha256: clip.sha256,
    durationSec: dur,
    sampleRate: clip.wav.sampleRate ?? 0,
    channels: clip.wav.channels ?? 0,
    mimeType: 'audio/wav',
    model: deps.cfg.ttsModel,
    voice: input.voice,
    language: input.language,
    style: input.style,
    textSha256: sha256Hex(input.text),
  };
}

export interface AiDeps {
  cfg: GeminiConfig;
  store: ProviderStore;
  fetchImpl?: FetchLike;
  /** Local planner config. Defaults to the process env. Tests inject a labelled fixture config. */
  planner?: LocalPlannerConfig;
}

export interface StartResult {
  job: JobRecord;
  reused: boolean;
  done: Promise<JobRecord>;
}

const fail = (code: ConstructorParameters<typeof FactoryError>[0], msg: string, status: number) => new FactoryError(code, msg, status);

function gate(deps: AiDeps) {
  if (!deps.cfg.apiKey) throw fail('FACTORY_PROVIDER_CREDENTIALS_MISSING', 'No Gemini key is configured on the server. Nothing was called.', 412);
  if (!deps.cfg.generationEnabled || !deps.cfg.freeTierConfirmed) {
    throw fail(
      'FACTORY_PROVIDER_DISABLED',
      'Generation is disabled. The owner must confirm a free-tier key and enable the server flags. Nothing was called.',
      403,
    );
  }
}

function keyFor(kind: string, input: unknown, model: string, explicit: unknown): string {
  if (typeof explicit === 'string' && /^[A-Za-z0-9_\-:.]{8,120}$/.test(explicit)) return `${kind}:${explicit}`;
  return `${kind}:${sha256Hex(JSON.stringify({ input, model }))}`;
}

/** Shared start logic: returns an existing job for the same key, or reserves and runs one attempt. */
function startOrReuse(deps: AiDeps, kind: 'plan' | 'speech_preview', key: string, model: string, input: Record<string, unknown>) {
  const existing = deps.store.findByKey(key);
  if (existing && (existing.status === 'running' || existing.status === 'succeeded')) {
    return { job: existing, reused: true, retry: false };
  }
  // Only speech is a paid provider call. Planning runs on the owner's local server and spends nothing.
  if (kind === 'speech_preview' && !deps.store.reserve(deps.cfg.sessionId, 'voice', deps.cfg.budget)) {
    throw fail('FACTORY_BUDGET_EXHAUSTED', 'The verification budget for this session is used up. Nothing was called.', 429);
  }
  if (existing) {
    existing.status = 'running';
    existing.attempts += 1;
    existing.error = null;
    existing.result = null;
    existing.updatedAt = new Date().toISOString();
    deps.store.saveJob(existing);
    return { job: existing, reused: false, retry: true };
  }
  const job = deps.store.newJob({ kind, idempotencyKey: key, sessionId: deps.cfg.sessionId, model, input });
  return { job, reused: false, retry: false };
}

function finishFailed(deps: AiDeps, job: JobRecord, err: unknown): JobRecord {
  const current = deps.store.getJob(job.id) ?? job;
  if (current.status === 'cancelled') return current; // cancel already recorded; never overwrite
  const e = err instanceof GeminiProviderError ? err : null;
  current.status = e?.code === 'FACTORY_JOB_CANCELLED' ? 'cancelled' : 'failed';
  current.error = {
    code: e?.code ?? 'FACTORY_PROVIDER_UNAVAILABLE',
    message: (e?.message ?? 'The provider request failed. Nothing was saved.').slice(0, 400),
  };
  current.updatedAt = new Date().toISOString();
  deps.store.saveJob(current);
  return current;
}

function stillRunning(deps: AiDeps, job: JobRecord): boolean {
  return deps.store.getJob(job.id)?.status === 'running';
}

/** Structured plan. One initial call plus at most one repair, both inside the text budget. */
export function startPlanJob(
  deps: AiDeps,
  raw: {
    profile: unknown;
    format: unknown;
    brief: unknown;
    references?: unknown;
    productFacts?: unknown;
    productMentionRequested?: unknown;
    idempotencyKey?: unknown;
  },
): StartResult {
  const profile = raw.profile;
  if (profile !== 'educational' && profile !== 'religious' && profile !== 'promotional') {
    throw fail('FACTORY_VALIDATION', 'profile must be educational, religious or promotional.', 400);
  }
  if (raw.format !== 'landscape' && raw.format !== 'portrait') throw fail('FACTORY_VALIDATION', 'format must be landscape or portrait.', 400);
  const brief = typeof raw.brief === 'string' ? raw.brief.trim() : '';
  if (brief.length < 10 || brief.length > 4000) throw fail('FACTORY_VALIDATION', 'brief must be 10 to 4000 characters.', 400);
  const refs = Array.isArray(raw.references) ? raw.references : [];
  if (refs.length > 10) throw fail('FACTORY_VALIDATION', 'at most 10 references can be supplied.', 400);
  const references = refs.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!/^[A-Za-z0-9_\-]{1,40}$/.test(id)) throw fail('FACTORY_VALIDATION', `reference ${i} needs an id of letters, digits, _ or -.`, 400);
    if (!text || text.length > 4000) throw fail('FACTORY_VALIDATION', `reference ${id} must be 1 to 4000 characters.`, 400);
    return { id, text };
  });
  const productMentionRequested = raw.productMentionRequested === true;
  if (productMentionRequested && profile === 'religious') throw fail('FACTORY_VALIDATION', 'religious content cannot include a product mention.', 400);
  const facts = Array.isArray(raw.productFacts) ? raw.productFacts : [];
  const productFacts = facts.map((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!/^[A-Za-z0-9_\-]{1,40}$/.test(id) || !text || text.length > 400) throw fail('FACTORY_VALIDATION', 'each product fact needs an id and up to 400 characters.', 400);
    return { id, text };
  });
  if (productMentionRequested && productFacts.length === 0) throw fail('FACTORY_VALIDATION', 'a product mention needs at least one supplied product fact.', 400);

  const plannerCfg = deps.planner ?? localPlannerConfig();
  const planner = localPlannerStatus(plannerCfg);
  if (!planner.ready) throw fail('FACTORY_PROVIDER_DISABLED', planner.reason, 412);
  const model = plannerCfg.model as string;
  const inputSummary = {
    profile,
    format: raw.format,
    briefSha256: sha256Hex(brief),
    referenceIds: references.map((r) => r.id),
    productMentionRequested,
  };
  const key = keyFor('plan', { profile, format: raw.format, brief, references, productFacts, productMentionRequested }, model, raw.idempotencyKey);
  const started = startOrReuse(deps, 'plan', key, model, inputSummary);
  if (started.reused) return { job: started.job, reused: true, done: Promise.resolve(started.job) };

  const ctx: PlanValidationContext = {
    profile: profile as PlanProfile,
    suppliedReferenceIds: references.map((r) => r.id),
    productFactIds: productFacts.map((f) => f.id),
    productFactTexts: Object.fromEntries(productFacts.map((f) => [f.id, f.text])),
    productMentionRequested,
  };
  const job = started.job;
  const done = runPlan(deps, job, { ctx, brief, references, productFacts, productMentionRequested, format: raw.format as 'landscape' | 'portrait' });
  return { job, reused: false, done };
}

async function runPlan(
  deps: AiDeps,
  job: JobRecord,
  p: {
    ctx: PlanValidationContext;
    brief: string;
    references: Array<{ id: string; text: string }>;
    productFacts: Array<{ id: string; text: string }>;
    productMentionRequested: boolean;
    format: 'landscape' | 'portrait';
  },
): Promise<JobRecord> {
  const controller = deps.store.registerController(job.id);
  try {
    let repairErrors: string[] | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) {
        // The repair is a second local planner request. No paid budget applies.
        job.attempts = 2;
        deps.store.saveJob(job);
      }
      const prompt = buildPlanPrompt({
        profile: p.ctx.profile,
        format: p.format,
        brief: p.brief,
        references: p.references,
        productFacts: p.productFacts,
        productMentionRequested: p.productMentionRequested,
        repairErrors,
      });
      const resp = await localPlanCompletion({
        cfg: deps.planner ?? localPlannerConfig(),
        prompt,
        signal: controller.signal,
        fetchImpl: deps.fetchImpl,
      });
      if (!stillRunning(deps, job)) throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
      const blocked = blockedOrEmpty(resp);
      if (blocked) throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', blocked, 422); // blocked or empty: no repair
      let value: unknown;
      try {
        value = parseStructuredText(resp).value;
      } catch {
        repairErrors = ['The output was not valid JSON.'];
        if (attempt === 2) throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'The output was not valid JSON after one repair. Nothing was saved.', 422);
        continue;
      }
      const v = validateGeneratedPlan(value, p.ctx);
      if (v.ok && v.plan) {
        const current = deps.store.getJob(job.id);
        if (!current || current.status !== 'running') throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
        current.status = 'succeeded';
        current.error = null;
        current.result = {
          plan: v.plan,
          model: resp.model,
          usage: (resp.usageMetadata ?? null) as unknown,
          repaired: attempt === 2,
          // Local planner output. Not a Google result and not verified against a live model.
          evidence: 'local_llm_unverified_plan',
          route: 'local_llm',
        };
        current.updatedAt = new Date().toISOString();
        deps.store.saveJob(current);
        return current;
      }
      repairErrors = v.errors.slice(0, 12).map((e) => e.slice(0, 200));
      if (attempt === 2) {
        throw new GeminiProviderError(
          'FACTORY_AI_INVALID_OUTPUT',
          `The plan failed validation after one repair. Nothing was saved. Problems: ${repairErrors.join(' ')}`.slice(0, 400),
          422,
        );
      }
    }
    throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'The plan could not be produced. Nothing was saved.', 422);
  } catch (err) {
    return finishFailed(deps, job, err);
  } finally {
    deps.store.releaseController(job.id);
  }
}

export interface SpeechPreviewInput {
  text: unknown;
  style?: unknown;
  voice: unknown;
  language: unknown;
  idempotencyKey?: unknown;
}

/** One clip, one speaker, at most 20 seconds. Output is an unapproved preview with provenance. */
export function startSpeechPreviewJob(deps: AiDeps, raw: SpeechPreviewInput): StartResult {
  const language = raw.language;
  if (language !== 'ar' && language !== 'en') throw fail('FACTORY_VALIDATION', 'language must be ar or en.', 400);
  const voice = typeof raw.voice === 'string' ? raw.voice : '';
  if (!isKnownGoogleVoice(voice)) throw fail('FACTORY_VALIDATION', 'Select a studio voice or load a verified voice from the Google library.', 400);
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (text.trim().length === 0 || text.length > GEMINI_HARD_CAPS.maxPreviewChars) {
    throw fail('FACTORY_VALIDATION', `preview text must be 1 to ${GEMINI_HARD_CAPS.maxPreviewChars} characters.`, 400);
  }
  const style = typeof raw.style === 'string' ? raw.style : '';
  if (style.length > GEMINI_HARD_CAPS.maxStyleChars) throw fail('FACTORY_VALIDATION', `style must be at most ${GEMINI_HARD_CAPS.maxStyleChars} characters.`, 400);
  if (language === 'ar' && !/[\u0600-\u06FF]/.test(text)) throw fail('FACTORY_VALIDATION', 'the text is marked Arabic but has no Arabic letters.', 400);
  let body: unknown;
  try {
    body = buildSpeechRequestBody({ text, style, voiceName: voice, language });
  } catch (e) {
    throw fail('FACTORY_VALIDATION', (e as Error).message.slice(0, 200), 400);
  }

  gate(deps);
  const model = deps.cfg.ttsModel;
  const inputSummary = {
    language,
    voice,
    textSha256: sha256Hex(text),
    textChars: text.length,
    styleSha256: sha256Hex(style),
    approved: false,
  };
  const key = keyFor('speech', { language, voice, text, style }, model, raw.idempotencyKey);
  const started = startOrReuse(deps, 'speech_preview', key, model, inputSummary);
  if (started.reused) return { job: started.job, reused: true, done: Promise.resolve(started.job) };

  const job = started.job;
  const done = runSpeech(deps, job, body, { text, style, voice, language });
  return { job, reused: false, done };
}

async function runSpeech(
  deps: AiDeps,
  job: JobRecord,
  body: unknown,
  meta: { text: string; style: string; voice: string; language: 'ar' | 'en' },
): Promise<JobRecord> {
  const controller = deps.store.registerController(job.id);
  try {
    const resp = await generateContentRaw({
      apiKey: deps.cfg.apiKey as string,
      model: deps.cfg.ttsModel,
      body,
      timeoutMs: deps.cfg.timeoutMs,
      signal: controller.signal,
      fetchImpl: deps.fetchImpl,
    });
    if (!stillRunning(deps, job)) throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
    const clip = parseSpeechResponse(resp);
    if (clip.wav.durationSec === null || clip.wav.durationSec <= 0) throw new GeminiProviderError('FACTORY_AUDIO_INVALID', 'The audio has no duration.', 422);
    if (clip.wav.durationSec > GEMINI_HARD_CAPS.maxPreviewSec) {
      throw new GeminiProviderError(
        'FACTORY_AUDIO_INVALID',
        `The clip is ${clip.wav.durationSec.toFixed(1)} seconds, over the ${GEMINI_HARD_CAPS.maxPreviewSec}-second preview limit. It was discarded.`,
        422,
      );
    }
    const current = deps.store.getJob(job.id);
    if (!current || current.status !== 'running') throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
    const file = deps.store.writeArtifact(`${job.id}.wav`, clip.bytes);
    recordLiveEvidence(deps, { speechGenerationOk: true, speechLanguage: meta.language });
    current.status = 'succeeded';
    current.error = null;
    current.result = {
      audioUrl: `/api/factory/ai/jobs/${job.id}/audio`,
      artifactFile: path.basename(file),
      provenance: {
        model: deps.cfg.ttsModel,
        voice: meta.voice,
        language: meta.language,
        textSha256: sha256Hex(meta.text),
        styleSha256: sha256Hex(meta.style),
        style: meta.style,
        text: meta.text,
        mimeType: clip.mimeType,
        sha256: clip.sha256,
        bytes: clip.bytes.byteLength,
        sampleRate: clip.wav.sampleRate,
        channels: clip.wav.channels,
        durationSec: clip.wav.durationSec,
        timingSource: 'speech_duration_not_word_alignment',
      },
      approved: false,
      evidence: meta.language === 'ar' ? 'arabic_live_unverified' : 'english_live_unverified',
      usage: clip.usage,
    };
    current.updatedAt = new Date().toISOString();
    deps.store.saveJob(current);
    return current;
  } catch (err) {
    return finishFailed(deps, job, err);
  } finally {
    deps.store.releaseController(job.id);
  }
}

export function httpStatusForJobError(code: string | undefined): number {
  switch (code) {
    case 'FACTORY_PROVIDER_AUTH': return 401;
    case 'FACTORY_PROVIDER_QUOTA': return 429;
    case 'FACTORY_PROVIDER_TIMEOUT': return 504;
    case 'FACTORY_PROVIDER_UNAVAILABLE': return 503;
    case 'FACTORY_AI_INVALID_OUTPUT':
    case 'FACTORY_AUDIO_INVALID': return 422;
    case 'FACTORY_JOB_CANCELLED': return 409;
    case 'FACTORY_BUDGET_EXHAUSTED': return 429;
    default: return 500;
  }
}

export type { SpeechEvidenceState };
