/**
 * Minimal Gemini REST client (generateContent only). Server-side only.
 *
 * Rules:
 *  - The API key is sent in the `x-goog-api-key` header, never in the URL or a log.
 *  - Errors are mapped to stable codes. Raw provider bodies are never returned or logged.
 *  - Timeouts and cancellation are explicit. Nothing retries automatically: a 401,
 *    403 or 429 stops the job with an actionable message. No paid fallback.
 *  - The fetch implementation is injectable so tests use labelled doubles.
 */
import { createHash } from 'node:crypto';
import { parseWav, type WavInfo } from '@buildtrack/core';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{2,63}$/;

export type GeminiErrorCode =
  | 'FACTORY_PROVIDER_AUTH'
  | 'FACTORY_PROVIDER_QUOTA'
  | 'FACTORY_PROVIDER_TIMEOUT'
  | 'FACTORY_PROVIDER_UNAVAILABLE'
  | 'FACTORY_AI_INVALID_OUTPUT'
  | 'FACTORY_AUDIO_INVALID'
  | 'FACTORY_BUDGET_EXHAUSTED'
  | 'FACTORY_JOB_CANCELLED';

export class GeminiProviderError extends Error {
  readonly code: GeminiErrorCode;
  readonly status: number;
  constructor(code: GeminiErrorCode, message: string, status: number) {
    super(message);
    this.name = 'GeminiProviderError';
    this.code = code;
    this.status = status;
  }
}

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<FetchResponseLike>;

export function assertModelName(model: string): string {
  if (!MODEL_RE.test(model)) throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'The configured model name is not valid.', 500);
  return model;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A safe, short description of a provider status. Never includes the body. */
export function describeStatus(status: number): string {
  if (status === 401) return 'The key was rejected (401). Check that GEMINI_API_KEY is correct and enabled.';
  if (status === 403) return 'Access was refused (403). Check the key, its project, and that this model is available to it.';
  if (status === 429) return 'The quota or rate limit was reached (429). Wait, or check the free-tier limits. No paid fallback was used.';
  return `The provider is unavailable (HTTP ${status}). Try again later.`;
}

export interface GenerateCallOpts {
  apiKey: string;
  model: string;
  body: unknown;
  timeoutMs: number;
  /** Cancellation from the job layer. Aborts the request; the result is then discarded. */
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

/** POST {base}/models/{model}:generateContent. Returns the parsed JSON body. */
export async function generateContentRaw(opts: GenerateCallOpts): Promise<any> {
  const model = assertModelName(opts.model);
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const timer = new AbortController();
  const timeoutHandle = setTimeout(() => timer.abort(), opts.timeoutMs);
  const onCancel = () => timer.abort();
  opts.signal?.addEventListener('abort', onCancel);
  let timedOut = false;
  const timeoutFlag = () => { timedOut = true; };
  timer.signal.addEventListener('abort', timeoutFlag, { once: true });
  // Do not even start the request if cancellation has already happened.
  if (opts.signal?.aborted) {
    clearTimeout(timeoutHandle);
    throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
  }
  // Race the transport against the abort, so termination never depends on the transport honouring the signal.
  const abortGate = new Promise<never>((_resolve, reject) => {
    timer.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  abortGate.catch(() => undefined);
  try {
    const res = await Promise.race([
      fetchImpl(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify(opts.body),
        signal: timer.signal,
      }),
      abortGate,
    ]);
    if (opts.signal?.aborted) throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new GeminiProviderError('FACTORY_PROVIDER_AUTH', describeStatus(res.status), res.status);
      if (res.status === 429) throw new GeminiProviderError('FACTORY_PROVIDER_QUOTA', describeStatus(res.status), 429);
      throw new GeminiProviderError('FACTORY_PROVIDER_UNAVAILABLE', describeStatus(res.status), 503);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof GeminiProviderError) throw err;
    if (opts.signal?.aborted) throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
    if (timedOut) throw new GeminiProviderError('FACTORY_PROVIDER_TIMEOUT', `The provider did not answer within ${Math.round(opts.timeoutMs / 1000)} seconds.`, 504);
    throw new GeminiProviderError('FACTORY_PROVIDER_UNAVAILABLE', 'The provider could not be reached.', 503);
  } finally {
    clearTimeout(timeoutHandle);
    opts.signal?.removeEventListener('abort', onCancel);
    timer.signal.removeEventListener('abort', timeoutFlag);
  }
}

export function blockedOrEmpty(resp: any): string | null {
  if (resp?.promptFeedback?.blockReason) return `The request was blocked (${String(resp.promptFeedback.blockReason)}). No output was saved.`;
  const cand = Array.isArray(resp?.candidates) ? resp.candidates[0] : undefined;
  if (!cand) return 'The provider returned no candidates. No output was saved.';
  const fr = String(cand.finishReason ?? '');
  if (fr && fr !== 'STOP' && fr !== 'MAX_TOKENS') return `The output was stopped (${fr}). No output was saved.`;
  return null;
}

/** Extracts the JSON text from a structured-output response and parses it. Fails safely. */
export function parseStructuredText(resp: any): { value: unknown; usage: unknown } {
  const blocked = blockedOrEmpty(resp);
  if (blocked) throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', blocked, 422);
  const parts = resp.candidates[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
  if (!text.trim()) throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'The provider returned empty output. No output was saved.', 422);
  try {
    return { value: JSON.parse(text), usage: resp.usageMetadata ?? null };
  } catch {
    throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'The provider output is not valid JSON. No output was saved.', 422);
  }
}

export interface AudioClip {
  bytes: Uint8Array;
  mimeType: string;
  wav: WavInfo;
  sha256: string;
  usage: unknown;
}

/** Extracts one WAV clip from a speech response and validates it. */
export function parseSpeechResponse(resp: any): AudioClip {
  const blocked = blockedOrEmpty(resp);
  if (blocked) throw new GeminiProviderError('FACTORY_AUDIO_INVALID', blocked, 422);
  const parts = resp.candidates[0]?.content?.parts;
  const inline = Array.isArray(parts) ? parts.find((p: any) => p?.inlineData?.data) : undefined;
  const data: unknown = inline?.inlineData?.data;
  const mimeType = String(inline?.inlineData?.mimeType ?? '');
  if (typeof data !== 'string' || data.length === 0) throw new GeminiProviderError('FACTORY_AUDIO_INVALID', 'The provider returned no audio.', 422);
  if (!/^audio\/wav$/i.test(mimeType)) throw new GeminiProviderError('FACTORY_AUDIO_INVALID', `Unexpected audio type "${mimeType || 'none'}". Expected a WAV file.`, 422);
  const bytes = new Uint8Array(Buffer.from(data, 'base64'));
  const wav = parseWav(bytes);
  if (!wav.valid) throw new GeminiProviderError('FACTORY_AUDIO_INVALID', wav.reason ?? 'Invalid audio.', 422);
  return { bytes, mimeType, wav, sha256: sha256Hex(bytes), usage: resp.usageMetadata ?? null };
}
