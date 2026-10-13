import fs from 'node:fs';
import path from 'node:path';
import { GEMINI_PREBUILT_VOICES } from '@buildtrack/core';
import { DATA_DIR } from './platform.js';
import { credentialFingerprint, GEMINI_API_BASE, GeminiProviderError } from './gemini-client.js';

export interface GoogleVoice {
  id: string; name: string; description: string; language: string; gender: string; pitch: string; persona: string;
}
const file = () => path.join(DATA_DIR, 'factory', 'ai', 'voice-catalog.json');
const binding = () => credentialFingerprint(process.env.GEMINI_API_KEY ?? '');
const validId = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(s);
export function savedGoogleVoices(): GoogleVoice[] {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (data.binding !== binding() || !Array.isArray(data.voices)) return [];
    return data.voices.filter((v: GoogleVoice) => validId(v.id) && typeof v.name === 'string');
  } catch { return []; }
}
export function isKnownGoogleVoice(id: string): boolean {
  return (GEMINI_PREBUILT_VOICES as readonly string[]).includes(id) || savedGoogleVoices().some(v => v.id === id);
}

/** Explicit catalog GET only. No generation, no budget reservation, no custom voice creation. */
export async function refreshGoogleVoices(input: Record<string, unknown>, fetchImpl: typeof fetch = fetch) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new GeminiProviderError('FACTORY_PROVIDER_DISABLED', 'Configure a Google API key to load the voice library.', 400);
  const params = new URLSearchParams({ page_size: '100', type: 'prebuilt' });
  for (const k of ['search', 'language_code', 'gender', 'page_token']) {
    const value = input[k];
    if (value !== undefined && (typeof value !== 'string' || value.length > (k === 'page_token' ? 1024 : 100))) throw new GeminiProviderError('FACTORY_VALIDATION', 'Invalid voice-library filter.', 400);
    if (typeof value === 'string' && value.trim()) params.set(k, value.trim());
  }
  if (params.has('gender') && !['male','female','neutral'].includes(params.get('gender')!)) throw new GeminiProviderError('FACTORY_VALIDATION', 'Invalid gender filter.', 400);
  const timeout = AbortSignal.timeout(15000);
  let res: Response;
  try { res = await fetchImpl(`${GEMINI_API_BASE}/voices?${params}`, { headers: { 'x-goog-api-key': key }, signal: timeout }); }
  catch { throw new GeminiProviderError('FACTORY_PROVIDER_UNAVAILABLE', 'Could not load the Google voice library. Saved choices are kept.', 503); }
  if (!res.ok) throw new GeminiProviderError(res.status === 429 ? 'FACTORY_PROVIDER_QUOTA' : [401,403].includes(res.status) ? 'FACTORY_PROVIDER_AUTH' : 'FACTORY_PROVIDER_UNAVAILABLE', `Google voice library returned HTTP ${res.status}. Saved choices are kept.`, res.status);
  let data: any;
  try { data = await res.json(); }
  catch { throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'Google returned unreadable catalog data. Saved choices are kept.', 422); }
  if (!Array.isArray(data.voices)) throw new GeminiProviderError('FACTORY_AI_INVALID_OUTPUT', 'Google returned an invalid voice catalog.', 422);
  const text = (v: unknown) => typeof v === 'string' ? v.slice(0, 600) : '';
  const page: GoogleVoice[] = data.voices.filter((v: any) => v.type === 'prebuilt' && validId(v.id)).map((v: any) => {
    const name = text(v.display_name) || v.id;
    // Preserve the established studio identifier (Kore), while extended voices use Google's exact id.
    const id = (GEMINI_PREBUILT_VOICES as readonly string[]).includes(name) ? name : v.id;
    return { id, name, description: text(v.description), language: text(v.language_code), gender: text(v.gender), pitch: text(v.pitch), persona: text(v.persona) };
  });
  const merged = new Map(savedGoogleVoices().map(v => [v.id, v]));
  for (const v of page) merged.set(v.id, v);
  if (merged.size > 20000) throw new GeminiProviderError('FACTORY_VALIDATION', 'Voice library cache limit reached.', 400);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ binding: binding(), voices: [...merged.values()] }));
  fs.renameSync(tmp, file());
  return { voices: page, nextPageToken: text(data.next_page_token), source: 'google_catalog' as const };
}
