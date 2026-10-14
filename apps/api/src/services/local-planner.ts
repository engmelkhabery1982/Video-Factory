/**
 * Semantic planning on a LOCAL OpenAI-compatible server (for example llama.cpp `llama-server`).
 * Google is not used for planning (owner rule: Google is for optional speech only).
 *
 * The route is ready only when the owner sets LOCAL_LLM_ENABLED=1, a loopback URL, a model label and the
 * model's licence. The licence is recorded by the owner, not verified by the code. Nothing here downloads
 * a model or calls a cloud host. The response is returned in the same shape the plan validator already
 * reads, so validation, repair and the Editor path stay unchanged.
 */
import { GeminiProviderError, type FetchLike } from './gemini-client.js';

/**
 * The ONE planner model this project pins. Read from the Hugging Face repo at the commit below (file size and the
 * LFS object id from the tree API, licence from the LICENSE file at that commit). The file itself was NOT downloaded
 * or run in the build sandbox, so no output from it is verified. The owner's download is checked by the setup script
 * against `upstreamSha256` and the computed digest is recorded in the environment.
 */
export const LOCAL_PLANNER_PINNED = {
  runtime: { project: 'ggml-org/llama.cpp', release: 'b11429', licence: 'MIT', server: 'llama-server' },
  model: {
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    revision: '91cad51170dc346986eccefdc2dd33a9da36ead9',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sizeBytes: 1117320736,
    upstreamSha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    licence: 'Apache-2.0',
    licenceVerifiedFrom: 'LICENSE file at revision 91cad51 (Apache License, Version 2.0); card metadata license: apache-2.0',
  },
} as const;

export interface LocalPlannerConfig {
  enabled: boolean;
  url: string | null;
  model: string | null;
  license: string | null;
  timeoutMs: number;
  maxTokens: number;
}

export function readLocalPlannerConfig(env: NodeJS.ProcessEnv): LocalPlannerConfig {
  const n = (v: string | undefined, d: number, lo: number, hi: number) => {
    const x = Number.parseInt(v ?? '', 10);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return {
    enabled: env.LOCAL_LLM_ENABLED === '1',
    url: env.LOCAL_LLM_URL?.trim() || null,
    model: env.LOCAL_LLM_MODEL?.trim() || null,
    license: env.LOCAL_LLM_MODEL_LICENSE?.trim() || null,
    timeoutMs: n(env.LOCAL_LLM_TIMEOUT_SEC, 180, 10, 900) * 1000,
    maxTokens: n(env.LOCAL_LLM_MAX_TOKENS, 4096, 256, 8192),
  };
}

let shared: LocalPlannerConfig | null = null;
export function localPlannerConfig(): LocalPlannerConfig {
  if (!shared) shared = readLocalPlannerConfig(process.env);
  return shared;
}

/** Only loopback endpoints are accepted. A cloud or LAN host is refused here. */
export function loopbackChatUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export interface LocalPlannerStatus {
  ready: boolean;
  route: 'local_llm';
  reason: string;
  missing: string[];
  model: string | null;
  license: string | null;
  endpoint: 'loopback only';
  googleUsed: false;
  pinnedModel: string;
  /** The recorded licence names the pinned licence. Advisory only: the owner still records the licence. */
  licenceMatchesPin: boolean | null;
}

export function localPlannerStatus(cfg: LocalPlannerConfig = localPlannerConfig()): LocalPlannerStatus {
  const missing: string[] = [];
  if (!cfg.enabled) missing.push('LOCAL_LLM_ENABLED=1 is not set.');
  if (!cfg.url) missing.push('LOCAL_LLM_URL is not set.');
  else if (!loopbackChatUrl(cfg.url)) missing.push('LOCAL_LLM_URL must be a loopback http URL (127.0.0.1, localhost or ::1) with no credentials.');
  if (!cfg.model) missing.push('LOCAL_LLM_MODEL (the model label) is not set.');
  if (!cfg.license) missing.push('LOCAL_LLM_MODEL_LICENSE is not set. Record the licence of the model before use.');
  const ready = missing.length === 0;
  return {
    ready,
    route: 'local_llm',
    reason: ready
      ? 'Local planner configured. Its availability is checked when a plan runs.'
      : 'Semantic planning is unavailable: ' + missing[0] + ' Google is not used for planning.',
    missing,
    model: cfg.model,
    license: cfg.license,
    endpoint: 'loopback only',
    googleUsed: false,
    pinnedModel: LOCAL_PLANNER_PINNED.model.file,
    licenceMatchesPin: cfg.license ? cfg.license.includes(LOCAL_PLANNER_PINNED.model.licence) : null,
  };
}

/**
 * One chat completion on the local server. Returns a Gemini-shaped object so the existing
 * plan parser and blocked/empty checks apply unchanged. Errors use the factory provider codes.
 */
export async function localPlanCompletion(opts: {
  cfg: LocalPlannerConfig;
  prompt: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<{ candidates: Array<{ content: { parts: Array<{ text: string }> }; finishReason: string }>; usageMetadata: unknown; model: string }> {
  const status = localPlannerStatus(opts.cfg);
  if (!status.ready) throw new GeminiProviderError('FACTORY_PROVIDER_DISABLED', status.reason, 412);
  const base = loopbackChatUrl(opts.cfg.url as string) as string;
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const timer = new AbortController();
  let timedOut = false;
  const onCancel = () => timer.abort();
  opts.signal?.addEventListener('abort', onCancel);
  if (opts.signal?.aborted) {
    opts.signal.removeEventListener('abort', onCancel);
    throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
  }
  const handle = setTimeout(() => {
    timedOut = true;
    timer.abort();
  }, opts.cfg.timeoutMs);
  // Every await is raced against the abort, so a cancel or timeout returns at once, even if the server never answers.
  const gate = new Promise<never>((_resolve, reject) => {
    timer.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  gate.catch(() => undefined);
  const guarded = <T,>(p: Promise<T>): Promise<T> => Promise.race([p, gate]);
  try {
    const res = await guarded(fetchImpl(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.cfg.model,
        stream: false,
        temperature: 0.2,
        max_tokens: opts.cfg.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You output one JSON object only. No markdown, no commentary.' },
          { role: 'user', content: opts.prompt },
        ],
      }),
      signal: timer.signal,
    }));
    if (!res.ok) throw new GeminiProviderError('FACTORY_PROVIDER_UNAVAILABLE', `The local planner answered ${res.status}. Check that llama-server is running.`, 503);
    const body = (await guarded(Promise.resolve().then(() => res.json()))) as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
      usage?: unknown;
      model?: unknown;
    };
    if (opts.signal?.aborted) throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
    const choice = body.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const fr = choice?.finish_reason === 'length' ? 'MAX_TOKENS' : choice?.finish_reason === 'stop' ? 'STOP' : String(choice?.finish_reason ?? 'UNKNOWN');
    return {
      candidates: choice ? [{ content: { parts: [{ text }] }, finishReason: fr }] : [],
      usageMetadata: body.usage ?? null,
      model: opts.cfg.model as string,
    };
  } catch (err) {
    if (err instanceof GeminiProviderError) throw err;
    if (opts.signal?.aborted) throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
    if (timedOut) throw new GeminiProviderError('FACTORY_PROVIDER_TIMEOUT', `The local planner did not answer within ${Math.round(opts.cfg.timeoutMs / 1000)} seconds.`, 504);
    throw new GeminiProviderError('FACTORY_PROVIDER_UNAVAILABLE', 'The local planner could not be reached. Start llama-server on the loopback address.', 503);
  } finally {
    clearTimeout(handle);
    opts.signal?.removeEventListener('abort', onCancel);
  }
}
