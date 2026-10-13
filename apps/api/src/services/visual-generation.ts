/**
 * Still-image generation for a single shot (paid route; off by default).
 *
 * Route chosen from current primary documentation (see CLOSURE_REPORT §4):
 *   model     gemini-3.1-flash-image ("Nano Banana 2"), overridable by GEMINI_IMAGE_MODEL
 *   endpoint  POST {base}/models/{model}:generateContent (the same transport as the text client)
 *   free tier NONE. The pricing page lists the image output rows with the free tier "Not available".
 *             Every call is billed to the owner's paid Gemini API account.
 *   video     NOT implemented. Veo models are paid-only in the API as well, so no video route exists.
 *
 * Gates, in order, before any provider call:
 *   1. GEMINI_IMAGE_GENERATION_ENABLED=1         (the feature is switched on by the owner)
 *   2. GEMINI_IMAGE_PAID_CONFIRMED=1              (the owner accepts paid billing for this key)
 *   3. GEMINI_API_KEY is present                  (never logged, never sent anywhere but the header)
 *   4. GEMINI_BUDGET_IMAGE > 0, hard cap 4        (the per-session ledger reserves one unit first)
 *
 * Nothing retries. A charged attempt stays charged, even when it fails or is discarded.
 * The result is validated before it is saved: MIME type, magic bytes, size, non-empty.
 * Only the scene's prompt and the aspect ratio are sent. No project files, paths or audio.
 */
import { createHash } from 'node:crypto';
import { generateContentRaw, GeminiProviderError, type FetchLike } from './gemini-client.js';
import { IMAGE_STILL_HARD_CAP, type ProviderStore } from './gemini-store.js';
import type { GeminiConfig } from './gemini-service.js';

export const IMAGE_ROUTE = {
  model: 'gemini-3.1-flash-image',
  endpoint: 'v1beta/models/{model}:generateContent',
  freeTier: 'not_available',
  pricingSource: 'https://ai.google.dev/gemini-api/docs/pricing',
} as const;

const ALLOWED: Record<string, { ext: 'png' | 'jpg' | 'webp'; magic: (b: Buffer) => boolean }> = {
  'image/png': { ext: 'png', magic: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/jpeg': { ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', magic: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
};
export const MAX_STILL_BYTES = 8 * 1024 * 1024;

export type StillState = 'disabled' | 'paid_not_confirmed' | 'no_credentials' | 'budget_exhausted' | 'ready';

export interface VisualGenerationStatus {
  ready: boolean;
  state: StillState;
  reason: string;
  model: string;
  endpoint: string;
  freeTier: 'not_available';
  paidOnly: true;
  videoGeneration: 'not_implemented';
  budget: { limit: number; used: number; remaining: number };
}

export function visualGenerationStatus(cfg: GeminiConfig, store: ProviderStore): VisualGenerationStatus {
  const limit = Math.min(Math.max(0, cfg.budget.imageStills ?? 0), IMAGE_STILL_HARD_CAP);
  const used = store.usage(cfg.sessionId).image;
  const remaining = Math.max(0, limit - used);
  const model = cfg.imageModel ?? IMAGE_ROUTE.model;
  let state: StillState;
  let reason: string;
  if (!cfg.imageGenerationEnabled) {
    state = 'disabled';
    reason = 'Still-image generation is off. The owner must set GEMINI_IMAGE_GENERATION_ENABLED=1 on the server.';
  } else if (!cfg.imagePaidConfirmed) {
    state = 'paid_not_confirmed';
    reason = 'The Gemini image API has no free tier. Set GEMINI_IMAGE_PAID_CONFIRMED=1 only after the owner accepts paid billing for this key.';
  } else if (!cfg.apiKey) {
    state = 'no_credentials';
    reason = 'No GEMINI_API_KEY is configured on the server.';
  } else if (limit === 0) {
    state = 'budget_exhausted';
    reason = 'The still-image budget for this session is 0. Set GEMINI_BUDGET_IMAGE to allow paid calls.';
  } else if (remaining === 0) {
    state = 'budget_exhausted';
    reason = `The still-image budget for this session is used up (${used} of ${limit}). It is not reset automatically.`;
  } else {
    state = 'ready';
    reason = `Ready. ${remaining} paid still-image call(s) remain in this session. Each call is billed.`;
  }
  return {
    ready: state === 'ready',
    state,
    reason,
    model,
    endpoint: IMAGE_ROUTE.endpoint.replace('{model}', model),
    freeTier: 'not_available',
    paidOnly: true,
    videoGeneration: 'not_implemented',
    budget: { limit, used, remaining },
  };
}

export interface GeneratedStill {
  bytes: Buffer;
  mimeType: string;
  ext: 'png' | 'jpg' | 'webp';
  sha256: string;
}

/** The request body. Only the prompt and the aspect ratio leave the server. */
export function stillRequestBody(prompt: string, aspectRatio: '16:9' | '9:16'): unknown {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio, imageSize: '1K' },
    },
  };
}

/** One paid call. Throws GeminiProviderError with a stable code. Saves nothing. */
export async function generateStill(opts: {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio: '16:9' | '9:16';
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<GeneratedStill> {
  const resp = await generateContentRaw({
    apiKey: opts.apiKey,
    model: opts.model,
    body: stillRequestBody(opts.prompt, opts.aspectRatio),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
  });
  const cand = Array.isArray(resp?.candidates) ? resp.candidates[0] : undefined;
  if (resp?.promptFeedback?.blockReason) {
    throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', `The request was blocked (${String(resp.promptFeedback.blockReason)}). Nothing was saved.`, 422);
  }
  if (!cand) throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'The provider returned no image. Nothing was saved.', 422);
  const parts: any[] = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
  const img = parts.map((p) => p?.inlineData).find((d) => d && typeof d.data === 'string' && d.data.length > 0);
  if (!img) throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'The provider returned no image data. Nothing was saved.', 422);
  const mimeType = String(img.mimeType ?? '').toLowerCase();
  const fmt = ALLOWED[mimeType];
  if (!fmt) throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', `The image format (${mimeType || 'unknown'}) is not accepted. Nothing was saved.`, 422);
  const bytes = Buffer.from(String(img.data), 'base64');
  if (bytes.length === 0 || bytes.length > MAX_STILL_BYTES) {
    throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'The image is empty or too large. Nothing was saved.', 422);
  }
  if (!fmt.magic(bytes)) throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'The image bytes do not match the declared format. Nothing was saved.', 422);
  return { bytes, mimeType, ext: fmt.ext, sha256: createHash('sha256').update(bytes).digest('hex') };
}
