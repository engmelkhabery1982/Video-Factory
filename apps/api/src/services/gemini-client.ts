/**
 * Gemini REST client. Gemini 3.8 speech uses the documented Interactions contract.
 *
 * Rules:
 *  - The API key is sent in the `x-goog-api-key` header, never in the URL or a log.
 *  - Errors are mapped to stable codes. Raw provider bodies are never returned or logged.
 *  - Timeouts and cancellation are explicit. Nothing retries automatically: a 401,
 *    403 or 429 stops the job with an actionable message. No paid fallback.
 *  - The fetch implementation is injectable so tests use labelled doubles.
 */
import { createHash, createHmac } from 'node:crypto';
import { parseWav, type WavInfo } from '@buildtrack/core';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{2,63}$/;

export type GeminiErrorCode =
  | 'FACTORY_PROVIDER_AUTH'
  | 'FACTORY_PROVIDER_QUOTA'
  | 'FACTORY_PROVIDER_TIMEOUT'
  | 'FACTORY_PROVIDER_UNAVAILABLE'
  | 'FACTORY_JOB_CANCELLED'
  | 'FACTORY_AI_INVALID_OUTPUT'
  | 'FACTORY_AUDIO_INVALID'
  | 'FACTORY_VALIDATION'
  | 'FACTORY_PROVIDER_DISABLED'
  | 'FACTORY_BUDGET_EXHAUSTED';

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
  if (status === 400) return 'Google rejected the request configuration (400). Check the model and its API contract; retrying unchanged will not fix it.';
  if (status === 404) return 'The configured model or API route was not found (404). Check model availability and API compatibility before retrying.';
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

/**
 * Keyed fingerprint of a credential for evidence records. HMAC with a fixed label, so the
 * record can prove "same key" without storing or revealing any part of the key.
 */
export function credentialFingerprint(apiKey: string): string {
  if (!apiKey) return 'none';
  return `hmac-sha256:${createHmac('sha256', 'gemini-credential-fingerprint-v1').update(apiKey).digest('hex').slice(0, 16)}`;
}

/**
 * POST using the model's explicit REST contract. Returns the parsed JSON body.
 *
 * The deadline covers the whole exchange: headers, status handling and the body read
 * (res.json). A body that stalls, or arrives after the deadline or a cancel, is discarded
 * and never returned. Termination does not depend on the transport honouring the signal.
 */
export async function generateContentRaw(opts: GenerateCallOpts): Promise<any> {
  const model = assertModelName(opts.model);
  const is38Speech = /^gemini-3\.8-flash(?:-lite)?-tts$/.test(model);
  let url = `${GEMINI_API_BASE}/models/${model}:generateContent`;
  let body = opts.body;
  if (is38Speech) {
    const request = opts.body as any;
    const part = request?.contents?.[0]?.parts?.[0];
    const voice = request?.generationConfig?.speechConfig?.voiceConfig;
    const voiceName = voice?.voice ?? voice?.prebuiltVoiceConfig?.voiceName;
    if (typeof part?.text !== 'string' || !voiceName) {
      throw new GeminiProviderError('FACTORY_VALIDATION', 'A speech turn and voice are required.', 400);
    }
    url = `${GEMINI_API_BASE}/interactions`;
    body = {
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text: part.text,
        ...(part.speechMetadata?.style ? { annotations: [{ type: 'speech_metadata', style: part.speechMetadata.style }] } : {}),
      }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: voiceName }] },
      store: false,
    };
  }
  if (model === 'gemini-3.8-flash') {
    const request = opts.body as any;
    const prompt = request?.contents?.[0]?.parts?.[0]?.text;
    const schema = request?.generationConfig?.responseFormat?.text?.schema;
    if (typeof prompt !== 'string' || !schema) throw new GeminiProviderError('FACTORY_VALIDATION', 'A planning prompt and schema are required.', 400);
    url = `${GEMINI_API_BASE}/interactions`;
    body = { model, input: prompt, store: false,
      response_format: { type: 'text', mime_type: 'application/json', schema },
      generation_config: { max_output_tokens: request.generationConfig.maxOutputTokens },
    };
  }
  // Older text models use their established GenerateContent JSON schema fields.
  // This is selected before the request, never an automatic retry or fallback.
  if (!is38Speech && /^gemini-2\.5-/.test(model)) {
    const request = opts.body as any;
    const text = request?.generationConfig?.responseFormat?.text;
    if (text) {
      const { responseFormat, ...config } = request.generationConfig;
      body = { ...request, generationConfig: { ...config, responseMimeType: 'application/json', responseJsonSchema: text.schema } };
    }
  }
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const timer = new AbortController();
  let timedOut = false;
  const onCancel = () => timer.abort();
  opts.signal?.addEventListener('abort', onCancel);
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    timer.abort();
  }, opts.timeoutMs);
  // Do not even start the request if cancellation has already happened.
  if (opts.signal?.aborted) {
    clearTimeout(timeoutHandle);
    opts.signal.removeEventListener('abort', onCancel);
    throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
  }
  const gate = new Promise<never>((_resolve, reject) => {
    timer.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  gate.catch(() => undefined);
  // Every await below is raced against the gate: headers, status and body alike.
  const guarded = <T>(p: Promise<T>): Promise<T> => Promise.race([p, gate]);
  try {
    const res = await guarded(
      fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify(body),
        signal: timer.signal,
      }),
    );
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new GeminiProviderError('FACTORY_PROVIDER_AUTH', describeStatus(res.status), res.status);
      if (res.status === 429) throw new GeminiProviderError('FACTORY_PROVIDER_QUOTA', describeStatus(res.status), 429);
      throw new GeminiProviderError('FACTORY_PROVIDER_UNAVAILABLE', describeStatus(res.status), 503);
    }
    const responseBody = await guarded(Promise.resolve().then(() => res.json()));
    if (opts.signal?.aborted) throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
    if (timedOut) throw new GeminiProviderError('FACTORY_PROVIDER_TIMEOUT', `The provider did not answer within ${Math.round(opts.timeoutMs / 1000)} seconds.`, 504);
    return responseBody;
  } catch (err) {
    if (err instanceof GeminiProviderError) throw err;
    if (opts.signal?.aborted) throw new GeminiProviderError('FACTORY_JOB_CANCELLED', 'The job was cancelled. Any late result was discarded.', 409);
    if (timedOut) throw new GeminiProviderError('FACTORY_PROVIDER_TIMEOUT', `The provider did not answer within ${Math.round(opts.timeoutMs / 1000)} seconds.`, 504);
    throw new GeminiProviderError('FACTORY_PROVIDER_UNAVAILABLE', 'The provider could not be reached.', 503);
  } finally {
    clearTimeout(timeoutHandle);
    opts.signal?.removeEventListener('abort', onCancel);
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
  if (Array.isArray(resp?.steps)) {
    if (resp.status && resp.status !== 'completed') throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'The planning interaction did not complete. No draft was saved.', 422);
    const texts = resp.steps.filter((s: any) => s.type === 'model_output')
      .flatMap((s: any) => Array.isArray(s.content) ? s.content : [])
      .filter((p: any) => p.type === 'text' && typeof p.text === 'string').map((p: any) => p.text);
    resp = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: texts.join('') }] } }], usageMetadata: resp.usage };
  }
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

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Extracts one WAV clip from a speech response and validates it. Anything else is an error. */
export function parseSpeechResponse(resp: any): AudioClip {
  // Interactions REST audio lives in model_output steps, not candidates.
  if (Array.isArray(resp?.steps)) {
    if (resp.status && resp.status !== 'completed') {
      throw new GeminiProviderError('FACTORY_AUDIO_INVALID', 'The speech interaction did not complete. No clip was saved.', 422);
    }
    const audio = resp.steps.filter((s: any) => s.type === 'model_output')
      .flatMap((s: any) => Array.isArray(s.content) ? s.content : []).filter((p: any) => p.type === 'audio');
    if (audio.length !== 1) throw new GeminiProviderError('FACTORY_AUDIO_INVALID', 'Expected exactly one complete speech clip. No clip was saved.', 422);
    resp = { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: audio[0].mime_type, data: audio[0].data } }] } }], usageMetadata: resp.usage };
  }
  const blocked = blockedOrEmpty(resp);
  if (blocked) throw new GeminiProviderError('FACTORY_AUDIO_INVALID', blocked, 422);
  const parts = resp?.candidates?.[0]?.content?.parts;
  const inline = Array.isArray(parts) ? parts.find((p: any) => p?.inlineData) : undefined;
  const data: unknown = inline?.inlineData?.data;
  const mimeType = String(inline?.inlineData?.mimeType ?? '');
  if (typeof data !== 'string' || data.length === 0) throw new GeminiProviderError('FACTORY_AUDIO_INVALID', 'The provider returned no audio.', 422);
  if (/^audio\/(mpeg|mp3|ogg|opus|aac|flac|mp4|x-m4a)/i.test(mimeType)) {
    throw new GeminiProviderError('FACTORY_AUDIO_INVALID', `Compressed audio (${mimeType}) was returned. Only WAV is accepted; no clip was saved.`, 422);
  }
  if (!/^audio\/(wav|x-wav|wave)$/i.test(mimeType)) {
    throw new GeminiProviderError('FACTORY_AUDIO_INVALID', `Unexpected audio type \"${mimeType || 'none'}\". Expected WAV.`, 422);
  }
  // Strict base64: a truncated or padded-wrong string must not be decoded leniently.
  if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw new GeminiProviderError('FACTORY_AUDIO_INVALID', 'The audio data is not valid base64 (possibly truncated). No clip was saved.', 422);
  }
  const bytes = new Uint8Array(Buffer.from(data, 'base64'));
  const wav = parseWav(bytes);
  if (!wav.valid) throw new GeminiProviderError('FACTORY_AUDIO_INVALID', wav.reason ?? 'Invalid audio.', 422);
  return { bytes, mimeType: 'audio/wav', wav, sha256: sha256Hex(bytes), usage: resp.usageMetadata ?? null };
}
