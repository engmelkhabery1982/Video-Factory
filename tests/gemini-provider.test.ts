/**
 * Milestone 3 provider adapter tests. Every provider call here goes to a LABELLED TEST
 * DOUBLE (scriptedFetch). No test contacts Google. Fixture WAVs are synthesized silence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentialFingerprint, generateContentRaw, parseSpeechResponse, sha256Hex } from '../apps/api/src/services/gemini-client.js';
import { ProviderStore } from '../apps/api/src/services/gemini-store.js';
import {
  aiCapabilities,
  readGeminiConfig,
  startPlanJob,
  startSpeechPreviewJob,
  type AiDeps,
  type GeminiConfig,
} from '../apps/api/src/services/gemini-service.js';
import { FactoryError, GEMINI_HARD_CAPS } from '@buildtrack/core';
import { CAPS, fixtureEducationalPlan, makeWav, scriptedFetch, speechResponse, textResponse } from './gemini/helpers.js';

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-provider-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;
function fresh(envOverrides: Record<string, string> = {}, fetchFn?: any): { deps: AiDeps; calls: any[]; store: ProviderStore; dir: string } {
  const dir = path.join(root, `case-${seq++}`);
  const store = new ProviderStore(dir);
  const env = {
    GEMINI_API_KEY: 'TEST-KEY-NOT-REAL-0123456789',
    GEMINI_GENERATION_ENABLED: '1',
    GEMINI_FREE_TIER_CONFIRMED: '1',
    GEMINI_TIMEOUT_MS: '5000',
    ...envOverrides,
  } as NodeJS.ProcessEnv;
  const cfg: GeminiConfig = readGeminiConfig(env, dir);
  const double = fetchFn ? { fn: fetchFn, calls: [] as any[] } : scriptedFetch([{ kind: 'throw', message: 'no provider double configured' }]);
  return { deps: { cfg, store, fetchImpl: double.fn as any }, calls: double.calls, store, dir };
}

const planInput = (over: Record<string, unknown> = {}) => ({
  profile: 'educational',
  format: 'landscape',
  brief: 'Explain why deliveries need confirmation before a pour.',
  references: [{ id: 'R1', text: 'Supplied note on delivery windows.' }],
  productMentionRequested: false,
  ...over,
});

async function runPlan(deps: AiDeps, over: Record<string, unknown> = {}) {
  const out = startPlanJob(deps, planInput(over) as never);
  return { job: await out.done, reused: out.reused };
}

describe('config and capability states (no network)', () => {
  it('caps budgets at the hard limits even when configured higher', () => {
    const cfg = readGeminiConfig({ GEMINI_BUDGET_TEXT: '50', GEMINI_BUDGET_VOICE: '9' } as any, root);
    expect(cfg.budget).toEqual({ textRequests: CAPS.textRequests, voicePreviews: CAPS.voicePreviews, productionTurns: 0 });
    const low = readGeminiConfig({ GEMINI_BUDGET_TEXT: '1' } as any, root);
    expect(low.budget.textRequests).toBe(1);
  });

  it('reports credentials_missing without a key, and never returns the key', () => {
    const dir = path.join(root, 'cap-none');
    const store = new ProviderStore(dir);
    const cfg = readGeminiConfig({} as any, dir);
    const cap = aiCapabilities(cfg, store);
    expect(cap.state).toBe('credentials_missing');
    expect(JSON.stringify(cap)).not.toMatch(/AIza|TEST-KEY/);
  });

  it('moves through live_test_unverified, catalog_reachable and ready only from a recorded verification', () => {
    const { deps, dir } = fresh();
    const verFile = path.join(dir, 'verification.json');
    deps.cfg.verificationFile = verFile;
    expect(aiCapabilities(deps.cfg, deps.store).state).toBe('live_test_unverified');
    const fp = credentialFingerprint(deps.cfg.apiKey as string);
    const bound = { checkedAt: 'x', sessionId: 'default', catalogReachable: true, endpoint: 'v1beta', credentialFingerprint: fp, textModel: deps.cfg.textModel, ttsModel: deps.cfg.ttsModel, textGenerationOk: false, speechGenerationOk: false, speechLanguagesLive: [] };
    fs.writeFileSync(verFile, JSON.stringify(bound));
    expect(aiCapabilities(deps.cfg, deps.store).state).toBe('catalog_reachable');
    fs.writeFileSync(verFile, JSON.stringify({ ...bound, textGenerationOk: true, speechGenerationOk: true, speechLanguagesLive: ['en'] }));
    const cap = aiCapabilities(deps.cfg, deps.store);
    expect(cap.state).toBe('ready');
    expect(cap.speechEvidence).toEqual({ ar: 'fixture_only', en: 'live_verified_unreviewed' });
    deps.cfg.generationEnabled = false;
    expect(aiCapabilities(deps.cfg, deps.store).state).toBe('catalog_reachable');
  });
});

describe('gates: nothing is called unless enabled and confirmed', () => {
  it('returns 412 with no provider call when the key is missing', () => {
    const { deps, calls } = fresh({ GEMINI_API_KEY: '' });
    expect(() => startPlanJob(deps, planInput() as never)).toThrow(FactoryError);
    try { startPlanJob(deps, planInput() as never); } catch (e) { expect((e as FactoryError).code).toBe('FACTORY_PROVIDER_CREDENTIALS_MISSING'); }
    expect(calls).toHaveLength(0);
  });

  it('returns 403 with no provider call when generation is not enabled or the free tier is not confirmed', () => {
    const a = fresh({ GEMINI_GENERATION_ENABLED: '0' });
    expect(() => startPlanJob(a.deps, planInput() as never)).toThrow(/Generation is disabled/);
    const b = fresh({ GEMINI_FREE_TIER_CONFIRMED: '0' });
    expect(() => startSpeechPreviewJob(b.deps, { text: 'Hello', voice: 'Kore', language: 'en' })).toThrow(/Generation is disabled/);
    expect(a.store.usage('default').text).toBe(0);
  });
});

describe('plan jobs: success, validation, repair, blocked output', () => {
  it('runs one call on success, validates, persists, and sends the key only in the header', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: textResponse(fixtureEducationalPlan()) }]);
    const { deps } = fresh({}, fx.fn);
    const { job } = await runPlan(deps);
    expect(job.status).toBe('succeeded');
    expect((job.result as any).plan.treatments).toHaveLength(3);
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(fx.calls[0].url).not.toContain('key=');
    expect(fx.calls[0].headers['x-goog-api-key']).toBe('TEST-KEY-NOT-REAL-0123456789');
    expect(fx.calls[0].body.generationConfig.responseFormat.text.schema).toBeTruthy();
    expect(JSON.stringify(deps.store.getJob(job.id))).not.toContain('TEST-KEY');
    expect(deps.store.usage('default').text).toBe(1);
  });

  it('repairs once after a schema failure, and counts the repair in the same budget', async () => {
    const bad = { ...fixtureEducationalPlan(), treatments: [] };
    const fx = scriptedFetch([
      { kind: 'json', status: 200, body: textResponse(bad) },
      { kind: 'json', status: 200, body: textResponse(fixtureEducationalPlan()) },
    ]);
    const { deps } = fresh({}, fx.fn);
    const { job } = await runPlan(deps);
    expect(job.status).toBe('succeeded');
    expect((job.result as any).repaired).toBe(true);
    expect(fx.calls).toHaveLength(2);
    expect(fx.calls[1].body.contents[0].parts[0].text).toMatch(/failed validation/);
    expect(deps.store.usage('default').text).toBe(2);
  });

  it('fails safely after one failed repair, with no third attempt', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: textResponse({ nope: true }) }]);
    const { deps } = fresh({}, fx.fn);
    const { job } = await runPlan(deps);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('FACTORY_AI_INVALID_OUTPUT');
    expect(job.result).toBeNull();
    expect(fx.calls).toHaveLength(2);
    expect(deps.store.usage('default').text).toBe(2);
  });

  it('treats non-JSON output as invalid and allows one repair', async () => {
    const fx = scriptedFetch([
      { kind: 'json', status: 200, body: { candidates: [{ content: { parts: [{ text: 'not json at all' }] }, finishReason: 'STOP' }] } },
      { kind: 'json', status: 200, body: textResponse(fixtureEducationalPlan()) },
    ]);
    const { deps } = fresh({}, fx.fn);
    const { job } = await runPlan(deps);
    expect(job.status).toBe('succeeded');
    expect(fx.calls).toHaveLength(2);
  });

  it('does not repair blocked or empty output', async () => {
    const blocked = scriptedFetch([{ kind: 'json', status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }]);
    const a = fresh({}, blocked.fn);
    const { job: j1 } = await runPlan(a.deps, { brief: 'A different brief to avoid reuse.' });
    expect(j1.status).toBe('failed');
    expect(j1.error?.message).toMatch(/blocked/);
    expect(blocked.calls).toHaveLength(1);

    const empty = scriptedFetch([{ kind: 'json', status: 200, body: { candidates: [] } }]);
    const b = fresh({}, empty.fn);
    const { job: j2 } = await runPlan(b.deps);
    expect(j2.status).toBe('failed');
    expect(j2.error?.message).toMatch(/no candidates/);
    expect(empty.calls).toHaveLength(1);
  });

  it('refuses a religious product mention at the input gate', () => {
    const { deps } = fresh();
    expect(() => startPlanJob(deps, planInput({ profile: 'religious', productMentionRequested: true }) as never)).toThrow(/religious content cannot/);
  });
});

describe('provider error mapping: 401, 403, 429, timeout, unavailable', () => {
  const cases: Array<[number, string]> = [
    [401, 'FACTORY_PROVIDER_AUTH'],
    [403, 'FACTORY_PROVIDER_AUTH'],
    [429, 'FACTORY_PROVIDER_QUOTA'],
    [500, 'FACTORY_PROVIDER_UNAVAILABLE'],
  ];
  for (const [status, code] of cases) {
    it(`maps HTTP ${status} to ${code}, stops without repair or fallback, and gives an actionable message`, async () => {
      const fx = scriptedFetch([{ kind: 'json', status, body: { error: { message: 'SECRET-BODY-TEXT-MUST-NOT-LEAK' } } }]);
      const { deps } = fresh({}, fx.fn);
      const { job } = await runPlan(deps, { brief: `Brief for status ${status} case.` });
      expect(job.status).toBe('failed');
      expect(job.error?.code).toBe(code);
      expect(job.error?.message.length).toBeGreaterThan(10);
      expect(JSON.stringify(job)).not.toContain('SECRET-BODY-TEXT');
      expect(fx.calls).toHaveLength(1);
    });
  }

  it('turns a 429 into a quota_blocked capability state', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 429, body: {} }]);
    const { deps } = fresh({}, fx.fn);
    await runPlan(deps, { brief: 'Brief that will hit quota.' });
    expect(aiCapabilities(deps.cfg, deps.store).state).toBe('quota_blocked');
  });

  it('times out with FACTORY_PROVIDER_TIMEOUT when the provider never answers', async () => {
    const fx = scriptedFetch([{ kind: 'hang' }]);
    const { deps } = fresh({}, fx.fn);
    deps.cfg.timeoutMs = 60; // test-only override below the config clamp
    const { job } = await runPlan(deps, { brief: 'Brief that will time out.' });
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('FACTORY_PROVIDER_TIMEOUT');
    expect(fx.calls).toHaveLength(1);
  });

  it('maps a network failure to unavailable without leaking the error text', async () => {
    const fx = scriptedFetch([{ kind: 'throw', message: 'ECONNRESET to generativelanguage with key TEST-KEY' }]);
    const { deps } = fresh({}, fx.fn);
    const { job } = await runPlan(deps, { brief: 'Brief for a network failure.' });
    expect(job.error?.code).toBe('FACTORY_PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(job)).not.toContain('TEST-KEY');
  });
});

describe('cancellation: a late result is never adopted', () => {
  it('cancels an in-flight call and discards a late success that arrives afterwards', async () => {
    let resolveLate: ((v: unknown) => void) | null = null;
    const fn = async (_url: string, init: { signal: AbortSignal }) =>
      await new Promise((resolve) => {
        resolveLate = resolve;
        init.signal.addEventListener('abort', () => undefined); // ignore abort: simulate a late reply
      });
    const { deps } = fresh({}, fn as any);
    const out = startPlanJob(deps, planInput({ brief: 'Brief to cancel mid flight.' }) as never);
    deps.store.cancelJob(out.job.id);
    const finished = await out.done;
    expect(finished.status).toBe('cancelled');
    // Late provider success arrives now.
    resolveLate?.({ ok: true, status: 200, json: async () => textResponse(fixtureEducationalPlan()) });
    await new Promise((r) => setTimeout(r, 20));
    const after = deps.store.getJob(out.job.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.result).toBeNull();
  });
});

describe('cancel after success never overwrites the result', () => {
  it('a cancel that arrives after the job succeeded leaves it succeeded with its result', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: textResponse(fixtureEducationalPlan()) }]);
    const { deps } = fresh({}, fx.fn);
    const done = await runPlan(deps, { brief: 'Brief that finishes before the cancel.' });
    expect(done.job.status).toBe('succeeded');
    const before = JSON.stringify(deps.store.getJob(done.job.id));
    const after = deps.store.cancelJob(done.job.id);
    expect(after?.status).toBe('succeeded');
    expect(JSON.stringify(deps.store.getJob(done.job.id))).toBe(before);
    expect(after?.result).not.toBeNull();
  });
});

describe('idempotency and budgets', () => {
  it('reuses a finished job for the same input, with no new provider call and no new reservation', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: textResponse(fixtureEducationalPlan()) }]);
    const { deps } = fresh({}, fx.fn);
    const first = await runPlan(deps, { brief: 'Same brief for idempotency.' });
    const second = await runPlan(deps, { brief: 'Same brief for idempotency.' });
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(fx.calls).toHaveLength(1);
    expect(deps.store.usage('default').text).toBe(1);
  });

  it('shares one reservation for a repeated request while the first is still running', async () => {
    let release: ((v: unknown) => void) | null = null;
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: textResponse(fixtureEducationalPlan()) }]);
    const fn = async (u: string, init: any) => {
      await new Promise((r) => { release = r; });
      return fx.fn(u, init);
    };
    const { deps } = fresh({}, fn as any);
    const a = startPlanJob(deps, planInput({ brief: 'Shared in flight brief.' }) as never);
    const b = startPlanJob(deps, planInput({ brief: 'Shared in flight brief.' }) as never);
    expect(b.reused).toBe(true);
    expect(b.job.id).toBe(a.job.id);
    expect(deps.store.usage('default').text).toBe(1);
    release?.(null);
    await a.done;
  });

  it('refuses further requests once the text budget is used, with no provider call', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: textResponse(fixtureEducationalPlan()) }]);
    const { deps } = fresh({ GEMINI_BUDGET_TEXT: '1' }, fx.fn);
    await runPlan(deps, { brief: 'First budgeted brief.' });
    expect(() => startPlanJob(deps, planInput({ brief: 'Second budgeted brief.' }) as never)).toThrow(/budget/);
    expect(fx.calls).toHaveLength(1);
  });

  it('counts failed attempts against the budget (conservative, never refunded)', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 401, body: {} }]);
    const { deps } = fresh({ GEMINI_BUDGET_TEXT: '1' }, fx.fn);
    await runPlan(deps, { brief: 'Failing budgeted brief.' });
    expect(deps.store.usage('default').text).toBe(1);
    expect(() => startPlanJob(deps, planInput({ brief: 'Failing budgeted brief two.' }) as never)).toThrow(/budget/);
  });

  it('a failed job can be retried under the same key, and that retry is budgeted', async () => {
    const fx = scriptedFetch([
      { kind: 'json', status: 500, body: {} },
      { kind: 'json', status: 200, body: textResponse(fixtureEducationalPlan()) },
    ]);
    const { deps } = fresh({ GEMINI_BUDGET_TEXT: '2' }, fx.fn);
    const first = await runPlan(deps, { brief: 'Retry brief under one key.', idempotencyKey: 'retry-key-0001' });
    expect(first.job.status).toBe('failed');
    const second = await runPlan(deps, { brief: 'Retry brief under one key.', idempotencyKey: 'retry-key-0001' });
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.status).toBe('succeeded');
    expect(second.job.attempts).toBe(2);
    expect(deps.store.usage('default').text).toBe(2);
  });

  it('a change to a supplied reference is a new source identity and a new job', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: textResponse(fixtureEducationalPlan()) }]);
    const { deps } = fresh({ GEMINI_BUDGET_TEXT: '2' }, fx.fn);
    const a = await runPlan(deps, { brief: 'Source identity brief.' });
    const b = await runPlan(deps, { brief: 'Source identity brief.', references: [{ id: 'R1', text: 'Edited reference text.' }] });
    expect(b.job.id).not.toBe(a.job.id);
  });
});

describe('restart handling', () => {
  it('marks a running job as interrupted on restart, and never as succeeded', () => {
    const dir = path.join(root, 'restart-case');
    const s1 = new ProviderStore(dir);
    const job = s1.newJob({ kind: 'plan', idempotencyKey: 'plan:restart-test-key', sessionId: 'default', model: 'm', input: {} });
    expect(job.status).toBe('running');
    const s2 = new ProviderStore(dir); // simulated restart
    const after = s2.getJob(job.id);
    expect(after?.status).toBe('interrupted');
    expect(after?.result).toBeNull();
    expect(after?.error?.message).toMatch(/restarted/);
  });
});

describe('speech previews: per-turn clip, validation, provenance, edited text', () => {
  const okWav = makeWav({ seconds: 2 });

  it('stores one unapproved WAV with provenance and a single verbatim text request', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: speechResponse(okWav) }]);
    const { deps } = fresh({}, fx.fn);
    const out = startSpeechPreviewJob(deps, { text: 'Confirm the delivery window tonight.', style: 'calm and clear', voice: 'Kore', language: 'en' });
    const job = await out.done;
    expect(job.status).toBe('succeeded');
    const r = job.result as any;
    expect(r.approved).toBe(false);
    expect(r.evidence).toBe('english_live_unverified');
    expect(r.provenance.sha256).toBe(sha256Hex(okWav));
    expect(r.provenance.durationSec).toBe(2);
    expect(r.provenance.timingSource).toBe('speech_duration_not_word_alignment');
    expect(r.provenance.voice).toBe('Kore');
    expect(fx.calls[0].body.contents[0].parts[0].text).toBe('Confirm the delivery window tonight.');
    expect(fx.calls[0].body.contents[0].parts[0].speechMetadata).toEqual({ style: 'calm and clear' });
    expect(deps.store.readArtifact(`${job.id}.wav`)?.length).toBe(okWav.byteLength);
    expect(deps.store.usage('default').voice).toBe(1);
  });

  it('refuses a clip over 20 seconds and discards it', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: speechResponse(makeWav({ seconds: 25 })) }]);
    const { deps } = fresh({}, fx.fn);
    const job = await startSpeechPreviewJob(deps, { text: 'Long preview text here.', voice: 'Puck', language: 'en' }).done;
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('FACTORY_AUDIO_INVALID');
    expect(deps.store.readArtifact(`${job.id}.wav`)).toBeNull();
  });

  it('refuses a non-WAV MIME type and a malformed payload', async () => {
    const mime = scriptedFetch([{ kind: 'json', status: 200, body: speechResponse(okWav, 'audio/L16;codec=pcm;rate=24000') }]);
    const a = fresh({}, mime.fn);
    const j1 = await startSpeechPreviewJob(a.deps, { text: 'Mime check text.', voice: 'Kore', language: 'en' }).done;
    expect(j1.error?.message).toMatch(/Expected WAV/);
    const bad = scriptedFetch([{ kind: 'json', status: 200, body: speechResponse(new Uint8Array(64)) }]);
    const b = fresh({}, bad.fn);
    const j2 = await startSpeechPreviewJob(b.deps, { text: 'Malformed payload text.', voice: 'Kore', language: 'en' }).done;
    expect(j2.error?.code).toBe('FACTORY_AUDIO_INVALID');
  });

  it('keeps Arabic text marked as Arabic only when it has Arabic letters', () => {
    const { deps } = fresh({}, scriptedFetch([{ kind: 'json', status: 200, body: speechResponse(okWav) }]).fn);
    expect(() => startSpeechPreviewJob(deps, { text: 'English words only here', voice: 'Kore', language: 'ar' })).toThrow(/Arabic letters/);
  });

  it('rejects an unknown voice and inline tags, with no provider call', () => {
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: speechResponse(okWav) }]);
    const { deps, calls } = fresh({}, fx.fn);
    expect(() => startSpeechPreviewJob(deps, { text: 'Hello there.', voice: 'NotAVoice', language: 'en' })).toThrow(/prebuilt voices/);
    expect(() => startSpeechPreviewJob(deps, { text: 'Hello <pause> there.', voice: 'Kore', language: 'en' })).toThrow(/angle-bracket/);
    expect(calls).toHaveLength(0);
    expect(fx.calls).toHaveLength(0);
  });

  it('edited narration changes only the dependent clip: unchanged text reuses its job, edited text gets a new one', async () => {
    const fx = scriptedFetch([
      { kind: 'json', status: 200, body: speechResponse(okWav) },
      { kind: 'json', status: 200, body: speechResponse(makeWav({ seconds: 1 })) },
      { kind: 'json', status: 200, body: speechResponse(makeWav({ seconds: 1 })) },
    ]);
    const { deps } = fresh({ GEMINI_BUDGET_VOICE: '2' }, fx.fn);
    const lineA = await startSpeechPreviewJob(deps, { text: 'Line A stays the same.', voice: 'Kore', language: 'en' }).done;
    const lineB1 = await startSpeechPreviewJob(deps, { text: 'Line B original.', voice: 'Kore', language: 'en' }).done;
    const lineAagain = startSpeechPreviewJob(deps, { text: 'Line A stays the same.', voice: 'Kore', language: 'en' });
    expect(lineAagain.reused).toBe(true);
    expect(lineAagain.job.id).toBe(lineA.id);
    expect(fx.calls).toHaveLength(2);
    // The session cap (two previews) still applies: the edited line is a NEW identity, so it is a new job.
    // It is shown here in a second session, so the cap does not hide the identity check.
    const deps2 = { ...deps, cfg: { ...deps.cfg, sessionId: 'session-two' } };
    const lineBEdited = startSpeechPreviewJob(deps2, { text: 'Line B edited.', voice: 'Kore', language: 'en' });
    expect(lineBEdited.reused).toBe(false);
    expect(lineBEdited.job.id).not.toBe(lineB1.id);
    await lineBEdited.done;
    // The same edited text is now a cache hit in any session: reused, no new reservation, no new call.
    const again = startSpeechPreviewJob(deps, { text: 'Line B edited.', voice: 'Kore', language: 'en' });
    expect(again.reused).toBe(true);
    expect(again.job.id).toBe(lineBEdited.job.id);
    expect(fx.calls).toHaveLength(3);
    expect(deps.store.usage('default').voice).toBe(2);
  });

  it('selective regeneration keeps an earlier clip byte-for-byte', async () => {
    const wavA = makeWav({ seconds: 1 });
    const wavB = makeWav({ seconds: 2 });
    const fx = scriptedFetch([
      { kind: 'json', status: 200, body: speechResponse(wavA) },
      { kind: 'json', status: 200, body: speechResponse(wavB) },
    ]);
    const { deps } = fresh({ GEMINI_BUDGET_VOICE: '2' }, fx.fn);
    const a = await startSpeechPreviewJob(deps, { text: 'Clip A text.', voice: 'Kore', language: 'en' }).done;
    const before = Buffer.from(deps.store.readArtifact(`${a.id}.wav`) as Buffer);
    await startSpeechPreviewJob(deps, { text: 'Clip B text, regenerated.', voice: 'Kore', language: 'en' }).done;
    const after = deps.store.readArtifact(`${a.id}.wav`) as Buffer;
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it('refuses a speech preview once the voice budget is used', async () => {
    const fx = scriptedFetch([{ kind: 'json', status: 200, body: speechResponse(okWav) }]);
    const { deps } = fresh({ GEMINI_BUDGET_VOICE: '1' }, fx.fn);
    await startSpeechPreviewJob(deps, { text: 'Budget one clip.', voice: 'Kore', language: 'en' }).done;
    expect(() => startSpeechPreviewJob(deps, { text: 'Budget two clip.', voice: 'Kore', language: 'en' })).toThrow(/budget/);
    expect(fx.calls).toHaveLength(1);
    expect(GEMINI_HARD_CAPS.maxPreviewSec).toBe(20);
  });
});
