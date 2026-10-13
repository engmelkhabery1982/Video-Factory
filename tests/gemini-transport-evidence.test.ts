/**
 * Milestone 3 continuation: transport deadline over the full body, strict speech decoding,
 * and evidence bound to model, endpoint and a keyed credential fingerprint.
 * LABELLED TEST DOUBLES only. No test contacts Google.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSpeechRequestBody, FactoryError, GEMINI_HARD_CAPS } from '@buildtrack/core';
import { credentialFingerprint, generateContentRaw, GeminiProviderError, parseSpeechResponse } from '../apps/api/src/services/gemini-client.js';
import { ProviderStore } from '../apps/api/src/services/gemini-store.js';
import { aiCapabilities, evidenceBinding, readGeminiConfig, speechProductionReady, type AiDeps } from '../apps/api/src/services/gemini-service.js';
import { b64, makeWav, speechResponse } from './gemini/helpers.js';

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-transport-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const KEY = 'FIXTURE-KEY-AAAA-0000-1111-2222';
const BODY = { contents: [] };
const base = { apiKey: KEY, model: 'gemini-2.5-flash', body: BODY };

describe('transport deadline covers the whole response, including the body', () => {
  it('times out when the body never finishes (stalled body), and never returns a value', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise<never>(() => undefined) }));
    const started = Date.now();
    await expect(generateContentRaw({ ...base, timeoutMs: 80, fetchImpl: fetchImpl as never })).rejects.toMatchObject({
      code: 'FACTORY_PROVIDER_TIMEOUT',
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('discards a late body that arrives after the deadline: no value is returned', async () => {
    let delivered = false;
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            delivered = true;
            resolve({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
          }, 150),
        ),
    });
    const p = generateContentRaw({ ...base, timeoutMs: 40, fetchImpl: fetchImpl as never });
    await expect(p).rejects.toBeInstanceOf(GeminiProviderError);
    await expect(p).rejects.toMatchObject({ code: 'FACTORY_PROVIDER_TIMEOUT' });
    // The late body really did arrive; the caller still got no result.
    await new Promise((r) => setTimeout(r, 200));
    expect(delivered).toBe(true);
  });

  it('a cancel during the body read is reported as cancelled, not as a timeout', async () => {
    const controller = new AbortController();
    const fetchImpl = async () => ({ ok: true, status: 200, json: () => new Promise<never>(() => undefined) });
    const p = generateContentRaw({ ...base, timeoutMs: 5000, signal: controller.signal, fetchImpl: fetchImpl as never });
    setTimeout(() => controller.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: 'FACTORY_JOB_CANCELLED' });
  });

  it('does not start the request at all when the job is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await expect(generateContentRaw({ ...base, timeoutMs: 1000, signal: controller.signal, fetchImpl: fetchImpl as never })).rejects.toMatchObject({
      code: 'FACTORY_JOB_CANCELLED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the body on a timely answer', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
    await expect(generateContentRaw({ ...base, timeoutMs: 1000, fetchImpl: fetchImpl as never })).resolves.toEqual({ candidates: [] });
  });
});

describe('speech decoding is strict: WAV only, no truncated or compressed audio', () => {
  it('refuses a clip whose base64 is truncated', () => {
    const good = b64(makeWav({ seconds: 0.5 }));
    const resp = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: good.slice(0, good.length - 3) } }] } }] };
    expect(() => parseSpeechResponse(resp)).toThrowError(/base64/);
  });

  it('refuses a WAV whose declared data size exceeds the bytes present (truncated clip)', () => {
    // A complete 1-second WAV with its tail removed: the header still declares the full data size.
    const full = makeWav({ seconds: 1 });
    const cut = full.slice(0, full.length - 2000);
    expect(() => parseSpeechResponse(speechResponse(cut))).toThrowError(/truncated/);
  });

  it('refuses compressed audio with a clear message and saves nothing', () => {
    const resp = speechResponse(makeWav({ seconds: 0.5 }), 'audio/mpeg');
    try {
      parseSpeechResponse(resp);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as GeminiProviderError).code).toBe('FACTORY_AUDIO_INVALID');
      expect((e as Error).message).toMatch(/Compressed audio/);
    }
  });

  it('refuses raw PCM (audio/L16) because the requested format is WAV', () => {
    expect(() => parseSpeechResponse(speechResponse(makeWav({ seconds: 0.5 }), 'audio/L16;codec=pcm;rate=24000'))).toThrowError(/Expected WAV/);
  });

  it('accepts a complete WAV and returns its sha256', () => {
    const bytes = makeWav({ seconds: 0.5 });
    const clip = parseSpeechResponse(speechResponse(bytes));
    expect(clip.mimeType).toBe('audio/wav');
    expect(clip.wav.valid).toBe(true);
    expect(clip.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requests WAV explicitly and maps Arabic to its documented language code', () => {
    const body = buildSpeechRequestBody({ text: 'مرحبا', style: '', voiceName: 'Kore', language: 'ar' }) as any;
    expect(body.generationConfig.responseFormat.audio.mimeType).toBe('AUDIO_WAV');
    expect(body.generationConfig.speechConfig.languageCode).toBe('ar-XA');
    expect(() => buildSpeechRequestBody({ text: 'bonjour', style: '', voiceName: 'Kore', language: 'fr' })).toThrow(/no verified language code/);
  });
});

describe('credential fingerprint and evidence binding', () => {
  it('is deterministic, does not contain the key, and differs for another key', () => {
    const fp = credentialFingerprint(KEY);
    expect(fp).toBe(credentialFingerprint(KEY));
    expect(fp).not.toContain('FIXTURE');
    expect(fp).not.toContain('0000');
    expect(fp).toMatch(/^hmac-sha256:[0-9a-f]{16}$/);
    expect(credentialFingerprint('OTHER-KEY-XYZ-9999')).not.toBe(fp);
  });

  function deps(dir: string, apiKey: string | null = KEY): AiDeps {
    const cfg = readGeminiConfig({ GEMINI_API_KEY: apiKey ?? '', GEMINI_GENERATION_ENABLED: '1', GEMINI_FREE_TIER_CONFIRMED: '1', GEMINI_PRODUCTION_TURNS: '3' } as any, dir);
    cfg.apiKey = apiKey;
    cfg.verificationFile = path.join(dir, 'verification.json');
    return { cfg, store: new ProviderStore(dir) };
  }

  function record(d: AiDeps, over: Record<string, unknown> = {}) {
    fs.writeFileSync(
      d.cfg.verificationFile,
      JSON.stringify({
        checkedAt: '2026-10-13T00:00:00Z',
        sessionId: 'default',
        catalogReachable: true,
        endpoint: 'v1beta/models/{model}:generateContent',
        credentialFingerprint: credentialFingerprint(KEY),
        textModel: d.cfg.textModel,
        ttsModel: d.cfg.ttsModel,
        textGenerationOk: true,
        speechGenerationOk: true,
        speechLanguagesLive: ['en'],
        ...over,
      }),
    );
  }

  it('a recorded verification applies only to the same key and models', () => {
    const dir = path.join(root, 'bind-1');
    const d = deps(dir);
    record(d);
    expect(evidenceBinding(d.cfg, d.store.readVerification(d.cfg.verificationFile))).toBe('current');
    expect(aiCapabilities(d.cfg, d.store).state).toBe('ready');
  });

  it('a changed key does not inherit ready', () => {
    const dir = path.join(root, 'bind-2');
    const recorded = deps(dir);
    record(recorded);
    const rotated = deps(dir, 'ROTATED-KEY-QQQQ-7777');
    const cap = aiCapabilities(rotated.cfg, rotated.store);
    expect(cap.state).toBe('live_test_unverified');
    expect(cap.verification?.binding).toBe('mismatch');
    expect(cap.verification?.textGenerationOk).toBe(false);
    expect(cap.note).toMatch(/different key or model/);
    expect(JSON.stringify(cap)).not.toContain('ROTATED');
  });

  it('a changed model does not inherit ready', () => {
    const dir = path.join(root, 'bind-3');
    const d = deps(dir);
    record(d, { textModel: 'gemini-old-model' });
    expect(aiCapabilities(d.cfg, d.store).state).toBe('live_test_unverified');
  });

  it('production speech for a language needs its own live evidence for this key and model', () => {
    const dir = path.join(root, 'bind-4');
    const d = deps(dir);
    record(d, { speechLanguagesLive: ['en'] });
    expect(speechProductionReady(d, 'en').ready).toBe(true);
    const ar = speechProductionReady(d, 'ar');
    expect(ar.ready).toBe(false);
    expect(ar.reason).toMatch(/Arabic speech evidence/);
  });

  it('production speech is off unless a per-session turn cap is configured', () => {
    const dir = path.join(root, 'bind-5');
    const d = deps(dir);
    record(d);
    d.cfg.budget.productionTurns = 0;
    const r = speechProductionReady(d, 'en');
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/Production speech is off/);
  });

  it('the production cap is clamped to the hard cap', () => {
    const dir = path.join(root, 'bind-6');
    const cfg = readGeminiConfig({ GEMINI_PRODUCTION_TURNS: '99999' } as any, dir);
    expect(cfg.budget.productionTurns).toBe(GEMINI_HARD_CAPS.productionTurns);
  });

  it('a missing key is reported as credentials_missing with no evidence claimed', () => {
    const dir = path.join(root, 'bind-7');
    const d = deps(dir, null);
    record(d);
    const cap = aiCapabilities(d.cfg, d.store);
    expect(cap.state).toBe('credentials_missing');
    expect(cap.productionSpeech.en.ready).toBe(false);
    expect(() => new FactoryError('FACTORY_PROVIDER_CREDENTIALS_MISSING', 'x', 412)).not.toThrow();
  });
});
