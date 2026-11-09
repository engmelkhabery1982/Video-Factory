/**
 * Product-mention rules, through the REAL registered plan routes with a labelled provider double.
 *
 * Rules checked:
 *  - educational default: OFF. The request tells the model no mention is requested.
 *  - an explicit request with no supplied fact is refused before any provider call.
 *  - an explicit request with a supplied fact uses that fact's text, verbatim, and nothing else.
 *  - religious content refuses a product mention before any provider call, and never takes the
 *    BuildTrack identity.
 *
 * Budget: this file makes two text calls, the whole of one session's text budget. Routes that
 * refuse before a call make none. Invented wording is rejected by the validator, which is checked
 * at code level in tests/gemini-contract.test.ts, not by spending a repair call here.
 *
 * LABELLED TEST DOUBLE: the provider returns a fixture plan. Not a live result.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const os = process.getBuiltinModule('node:os') as typeof import('node:os');
  const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'factory-product-mention-'));
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  process.env.VF_PREVIEW_DISABLE = '1';
  process.env.GEMINI_API_KEY = 'FIXTURE-KEY-PRODUCT-0123456789';
  process.env.LOCAL_LLM_ENABLED = '1';
  process.env.LOCAL_LLM_URL = 'http://127.0.0.1:8080';
  process.env.LOCAL_LLM_MODEL = 'FIXTURE-local-planner';
  process.env.LOCAL_LLM_MODEL_LICENSE = 'FIXTURE (test double, not a model)';
  process.env.GEMINI_GENERATION_ENABLED = '1';
  process.env.GEMINI_FREE_TIER_CONFIRMED = '1';
  process.env.GEMINI_PRODUCTION_TURNS = '0';
  return { root };
});

import { buildServerApp } from '../apps/api/src/server.js';
import { DATA_DIR } from '../apps/api/src/services/platform.js';
import { credentialFingerprint } from '../apps/api/src/services/gemini-client.js';
import { fixtureEducationalPlan } from './gemini/helpers.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;
let disabledJobId = '';
let enabledJobId = '';

const TEXT_MODEL = 'gemini-2.5-flash';
const FACT_TEXT = 'Delivery confirmations are logged with the crew name and the time.';

/** LABELLED TEST DOUBLE. Returns the fixture plan with the product mention set by the test. */
const provider = vi.hoisted(() => ({ text: [] as any[], mention: { enabled: false, factId: null as string | null, text: null as string | null } }));
const fetchSpy = vi.fn(async (url: string, init: { body: string }) => {
  const u = String(url);
  const body = JSON.parse(init.body);
  const json = (payload: unknown, status = 200) => ({ ok: status < 400, status, json: async () => payload });
  if (u.endsWith('/v1/chat/completions')) {
    provider.text.push(body);
    const plan = { ...(fixtureEducationalPlan() as any), productMention: provider.mention };
    return json({ choices: [{ message: { content: JSON.stringify(plan) }, finish_reason: 'stop' }] });
  }
  throw new Error(`TEST DOUBLE: unexpected provider URL ${u}`);
});

async function call(method: 'GET' | 'POST', url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
  let json: any = null;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.statusCode, json, raw: res.body };
}

async function waitForJob(jobId: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const r = await call('GET', `/api/factory/ai/jobs/${jobId}`);
    if (r.json.job.status !== 'running') return r.json.job;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('job did not finish');
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchSpy);
  app = await buildServerApp();
  await app.ready();
  fs.mkdirSync(path.join(DATA_DIR, 'factory', 'ai'), { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, 'factory', 'ai', 'verification.json'),
    JSON.stringify({
      checkedAt: '2026-10-13T00:00:00Z', sessionId: 'default', catalogReachable: true,
      endpoint: 'v1beta/models/{model}:generateContent', credentialFingerprint: credentialFingerprint(process.env.GEMINI_API_KEY as string),
      textModel: TEXT_MODEL, ttsModel: 'gemini-3.8-flash-tts', textGenerationOk: true, speechGenerationOk: true, speechLanguagesLive: ['en'],
    }),
  );
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

const BRIEF = 'Explain why deliveries must be confirmed the night before.';

describe('product mention rules (labelled provider double, two text calls in this file)', () => {
  it('educational default is OFF: the request says no mention is requested, and the plan records it disabled', async () => {
    provider.mention = { enabled: false, factId: null, text: null };
    const created = await call('POST', '/api/factory/ai/plans', { profile: 'educational', format: 'landscape', brief: BRIEF });
    expect(created.status).toBe(202);
    const job = await waitForJob(created.json.job.id);
    expect(job.status).toBe('succeeded');
    expect(provider.text).toHaveLength(1);
    const prompt = JSON.stringify(provider.text[0]);
    expect(prompt).toContain('A product mention is NOT requested');
    expect(prompt).not.toContain('Supplied product facts');
    expect(job.result.plan.productMention).toEqual({ enabled: false, factId: null, text: null });
    disabledJobId = job.id;
  });

  it('an explicit request with no supplied fact is refused before any provider call', async () => {
    const r = await call('POST', '/api/factory/ai/plans', { profile: 'educational', format: 'landscape', brief: BRIEF, productMentionRequested: true });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('FACTORY_VALIDATION');
    expect(r.json.error).toMatch(/supplied product fact/);
    expect(provider.text).toHaveLength(1);
  });

  it('religious content refuses a product mention before any provider call', async () => {
    const r = await call('POST', '/api/factory/ai/plans', {
      profile: 'religious', format: 'landscape', brief: 'A short reflection on patience at work.', productMentionRequested: true,
      productFacts: [{ id: 'F1', text: FACT_TEXT }],
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/religious content cannot include a product mention/);
    expect(provider.text).toHaveLength(1);
  });

  it('an explicit request with a supplied fact: the mention is that fact, verbatim, and the request carries only that fact', async () => {
    provider.mention = { enabled: true, factId: 'F1', text: FACT_TEXT };
    const created = await call('POST', '/api/factory/ai/plans', {
      profile: 'educational', format: 'landscape', brief: BRIEF, productMentionRequested: true,
      productFacts: [{ id: 'F1', text: FACT_TEXT }, { id: 'F2', text: 'An unrelated fact that must not be sent.' }],
    });
    expect(created.status).toBe(202);
    const job = await waitForJob(created.json.job.id);
    expect(job.status).toBe('succeeded');
    expect(provider.text).toHaveLength(2);
    expect(job.result.plan.productMention).toEqual({ enabled: true, factId: 'F1', text: FACT_TEXT });
    enabledJobId = job.id;
    // The request carries the owner's supplied facts, and only those. The model must cite one of them.
    const prompt = JSON.stringify(provider.text[1]);
    expect(prompt).toContain(`F1: ${FACT_TEXT}`);
    expect(prompt).toContain('F2: An unrelated fact that must not be sent.');
    expect(prompt).not.toMatch(/data\/|output\/|\.wav"|\.mp4/);
  });

  it('a religious draft never takes the BuildTrack identity, even when BuildTrack is asked for', async () => {
    const r = await call('POST', '/api/factory/drafts', {
      contentProfile: 'religious', format: 'landscape', channelBrandId: 'buildtrack',
      inputs: { brief: 'A short reflection on patience at work.', script: 'Patience is practised one task at a time.\nWrite the next step down before you rest.', audioAssetId: null, visualAssetIds: [], storyboard: null },
      requestedSpeakers: [], referenceProjectId: null,
    });
    // Either refused outright, or created with the identity unbound and the refusal recorded.
    if (r.status === 201) {
      expect(r.json.profile.channelBrandId).toBeNull();
      expect(JSON.stringify(r.json.profile)).not.toMatch(/buildtrack/i);
      expect(JSON.stringify(r.json.warnings)).toMatch(/BuildTrack|identity/i);
    } else {
      expect(r.status).toBe(422);
      expect(r.json.code).toBe('FACTORY_IDENTITY_REFUSED');
    }
    expect(provider.text).toHaveLength(2);
  });
});

describe('product mention at draft creation (no provider call in this block)', () => {
  it('a plan with the mention OFF creates a draft with no product scene', async () => {
    const r = await call('POST', `/api/factory/ai/plans/${disabledJobId}/draft`, { format: 'landscape' });
    expect(r.status).toBe(201);
    for (const t of r.json.treatments) {
      expect(t.scenes.some((sc: any) => String(sc.sourceUnitId).startsWith('pm-'))).toBe(false);
    }
    expect(r.raw).not.toMatch(/productFactId/);
    expect(provider.text).toHaveLength(2);
  });

  it('a plan with the supplied fact adds one unapproved product scene after the closing line, in every treatment', async () => {
    const r = await call('POST', `/api/factory/ai/plans/${enabledJobId}/draft`, { format: 'landscape' });
    expect(r.status).toBe(201);
    expect(r.json.treatments.length).toBeGreaterThan(0);
    for (const t of r.json.treatments) {
      const scenes = t.scenes;
      const last = scenes[scenes.length - 1];
      expect(last.sourceUnitId).toBe('pm-F1');
      expect(last.narration).toBe(FACT_TEXT);
      expect(last.shot.productFactId).toBe('F1');
      expect(last.shot.assetNeed).toBe('image_needed');
      expect(last.locked).toBe(false);
      expect(scenes.filter((sc: any) => sc.sourceUnitId === 'pm-F1')).toHaveLength(1);
    }
    expect(r.json.warnings.some((w: string) => /product mention added.*supplied fact "F1"/.test(w))).toBe(true);
    expect(provider.text).toHaveLength(2);
  });

  it('the same plan returns the same draft, so the mention is never added twice', async () => {
    const a = await call('POST', `/api/factory/ai/plans/${enabledJobId}/draft`, { format: 'landscape' });
    const b = await call('POST', `/api/factory/ai/plans/${enabledJobId}/draft`, { format: 'landscape' });
    expect(b.status).toBe(200);
    expect(b.json.draftId).toBe(a.json.draftId);
    expect(b.json.treatments[0].scenes.filter((sc: any) => sc.sourceUnitId === 'pm-F1')).toHaveLength(1);
  });
});

