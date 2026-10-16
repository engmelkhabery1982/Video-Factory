/**
 * Local semantic planner (llama.cpp llama-server on loopback). Code-level tests with a labelled fixture
 * fetch double. No network, no model, no Google. Evidence label: CODE + FIXTURE.
 */
import { describe, expect, it } from 'vitest';
import {
  loopbackChatUrl,
  localPlanCompletion,
  localPlanRepairSchema,
  localPlannerStatus,
  readLocalPlannerConfig,
  type LocalPlannerConfig,
} from '../apps/api/src/services/local-planner.js';
import { GeminiProviderError } from '../apps/api/src/services/gemini-client.js';

const READY: LocalPlannerConfig = {
  enabled: true,
  url: 'http://127.0.0.1:8080',
  model: 'fixture-label',
  license: 'Apache-2.0 (owner-recorded fixture)',
  timeoutMs: 10_000,
  maxTokens: 4096,
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('coverage repair preserves spoken text', () => {
  it('uses the original script unchanged and binds each proposed scene to one existing line', () => {
    const script = { lines: [{ id: 'L1', text: 'Original words', speaker: 'narrator', language: 'en', quotedSourceRef: null }] };
    const repaired = localPlanRepairSchema({ script }, 'Profile: educational. Format: landscape.')!;
    expect(repaired.properties.script.const).toEqual(script);
    const firstTypes = repaired.properties.treatments.prefixItems.map((t: any) => {
      expect(t.properties.scenes.prefixItems[0].properties.lineIds.const).toEqual(['L1']);
      return t.properties.scenes.prefixItems[0].properties.shotType.enum;
    });
    expect(firstTypes[0].some((s: string) => firstTypes[1].includes(s))).toBe(false);
  });
  it('refuses to bind ambiguous duplicate spoken ids', () => {
    expect(localPlanRepairSchema({ script: { lines: [{ id: 'L1', text: 'a' }, { id: 'L1', text: 'b' }] } }, 'Profile: educational.')).toBeUndefined();
  });
});

describe('loopback-only endpoint', () => {
  it('accepts loopback http hosts and strips a trailing slash', () => {
    expect(loopbackChatUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
    expect(loopbackChatUrl('http://localhost:9000')).toBe('http://localhost:9000');
    expect(loopbackChatUrl('http://[::1]:8080')).toBe('http://[::1]:8080');
  });

  it('refuses cloud, LAN, https, credentials, and query strings', () => {
    expect(loopbackChatUrl('https://generativelanguage.googleapis.com')).toBeNull();
    expect(loopbackChatUrl('http://192.168.1.20:8080')).toBeNull();
    expect(loopbackChatUrl('http://example.com')).toBeNull();
    expect(loopbackChatUrl('http://user:pass@127.0.0.1:8080')).toBeNull();
    expect(loopbackChatUrl('http://127.0.0.1:8080/?key=abc')).toBeNull();
    expect(loopbackChatUrl('not a url')).toBeNull();
  });

  it('reports not-ready with the loopback reason when the URL is remote', () => {
    const st = localPlannerStatus({ ...READY, url: 'http://10.0.0.5:8080' });
    expect(st.ready).toBe(false);
    expect(st.googleUsed).toBe(false);
    expect(st.missing.join(' ')).toMatch(/loopback/);
  });
});

describe('readiness and config', () => {
  it('is not ready until the owner records the licence', () => {
    const st = localPlannerStatus({ ...READY, license: null });
    expect(st.ready).toBe(false);
    expect(st.missing.join(' ')).toMatch(/LOCAL_LLM_MODEL_LICENSE/);
  });

  it('is ready with all four owner settings and says Google is not used', () => {
    const st = localPlannerStatus(READY);
    expect(st.ready).toBe(true);
    expect(st.googleUsed).toBe(false);
    expect(st.endpoint).toBe('loopback only');
  });

  it('clamps timeout and max tokens from the environment', () => {
    const cfg = readLocalPlannerConfig({
      LOCAL_LLM_ENABLED: '1',
      LOCAL_LLM_URL: 'http://127.0.0.1:8080',
      LOCAL_LLM_MODEL: 'm',
      LOCAL_LLM_MODEL_LICENSE: 'l',
      LOCAL_LLM_TIMEOUT_SEC: '1',
      LOCAL_LLM_MAX_TOKENS: '999999',
    });
    expect(cfg.timeoutMs).toBe(10_000);
    expect(cfg.maxTokens).toBe(8192);
    const dflt = readLocalPlannerConfig({});
    expect(dflt.enabled).toBe(false);
    expect(dflt.timeoutMs).toBe(180_000);
    expect(dflt.maxTokens).toBe(4096);
  });
});

describe('completion: not-ready is 412 with no call', () => {
  it('throws FACTORY_PROVIDER_DISABLED (412) and never calls fetch', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(200, {});
    };
    await expect(
      localPlanCompletion({ cfg: { ...READY, enabled: false }, prompt: 'p', fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ code: 'FACTORY_PROVIDER_DISABLED', status: 412 });
    expect(calls).toBe(0);
  });
});

describe('completion: Gemini-shaped mapping', () => {
  it('maps finish_reason stop to STOP and returns text in the Gemini candidate shape', async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const fetchImpl = async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return jsonResponse(200, {
        model: 'fixture-label',
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { total_tokens: 7 },
      });
    };
    const out = await localPlanCompletion({ cfg: READY, prompt: 'plan it', fetchImpl: fetchImpl as never });
    expect(sent!.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(sent!.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'factory_plan', strict: true, schema: { type: 'object', additionalProperties: false } } });
    expect(sent!.body.max_tokens).toBe(4096);
    expect(out.candidates[0].content.parts[0].text).toBe('{"ok":true}');
    expect(out.candidates[0].finishReason).toBe('STOP');
    expect(out.usageMetadata).toEqual({ total_tokens: 7 });
  });

  it('maps finish_reason length to MAX_TOKENS so the plan validator reports truncation', async () => {
    const fetchImpl = async () =>
      jsonResponse(200, { choices: [{ message: { content: '{"trunc' }, finish_reason: 'length' }] });
    const out = await localPlanCompletion({ cfg: READY, prompt: 'p', fetchImpl: fetchImpl as never });
    expect(out.candidates[0].finishReason).toBe('MAX_TOKENS');
  });

  it('returns no candidates when the server sends no choices', async () => {
    const fetchImpl = async () => jsonResponse(200, { choices: [] });
    const out = await localPlanCompletion({ cfg: READY, prompt: 'p', fetchImpl: fetchImpl as never });
    expect(out.candidates).toEqual([]);
  });
});

describe('completion: failures are typed and bounded', () => {
  it('a non-2xx answer is FACTORY_PROVIDER_UNAVAILABLE (503) with no secret in the message', async () => {
    const fetchImpl = async () => jsonResponse(500, { error: 'boom' });
    const err = await localPlanCompletion({ cfg: READY, prompt: 'p', fetchImpl: fetchImpl as never }).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiProviderError);
    expect(err.code).toBe('FACTORY_PROVIDER_UNAVAILABLE');
    expect(err.status).toBe(503);
    expect(String(err.message)).not.toMatch(/boom|key/i);
  });

  it('a refused connection is FACTORY_PROVIDER_UNAVAILABLE (503)', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(localPlanCompletion({ cfg: READY, prompt: 'p', fetchImpl: fetchImpl as never })).rejects.toMatchObject({
      code: 'FACTORY_PROVIDER_UNAVAILABLE',
      status: 503,
    });
  });

  it('a server that never answers times out promptly with FACTORY_PROVIDER_TIMEOUT (504)', async () => {
    const fetchImpl = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        // Ignores the abort signal, so only the race guard can return.
        void init;
        setTimeout(() => reject(new Error('late')), 60_000).unref?.();
      });
    const started = Date.now();
    await expect(
      localPlanCompletion({ cfg: { ...READY, timeoutMs: 50 }, prompt: 'p', fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ code: 'FACTORY_PROVIDER_TIMEOUT', status: 504 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a cancel while the server is silent returns FACTORY_JOB_CANCELLED (409) promptly', async () => {
    const controller = new AbortController();
    const fetchImpl = () =>
      new Promise<Response>(() => {
        // Never resolves.
      });
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    await expect(
      localPlanCompletion({ cfg: READY, prompt: 'p', signal: controller.signal, fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ code: 'FACTORY_JOB_CANCELLED', status: 409 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a signal already aborted before the call throws cancelled without fetching', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(200, { choices: [] });
    };
    await expect(
      localPlanCompletion({ cfg: READY, prompt: 'p', signal: controller.signal, fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ code: 'FACTORY_JOB_CANCELLED' });
    expect(calls).toBe(0);
  });
});
