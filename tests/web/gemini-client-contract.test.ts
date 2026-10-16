/**
 * Contract checks for the typed web client and the pure Gemini planning helpers.
 * No browser, no server, no provider. `fetch` is replaced by a recording double, so these
 * tests prove the exact paths, methods and bodies the client sends, not that the server accepts them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GEMINI_PREBUILT_VOICES } from '../../packages/core/src/factory/gemini-contract.js';
import { GEMINI_VOICE_NAMES, factoryAi, fetchShotListMarkdown, type AiStatus, type ApplyPreview } from '../../apps/web/src/lib/factory-api';
import {
  applyCountView,
  failureAdvice,
  generateGate,
  narrationChanges,
  parseReferenceLines,
  previewInput,
  previewsLeft,
  textRequestsLeft,
} from '../../apps/web/src/lib/gemini-plan-model';

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

function recordFetch(reply: (r: Recorded) => { status?: number; body?: unknown; text?: string } = () => ({ body: {} })) {
  const calls: Recorded[] = [];
  const stub = vi.fn(async (url: string, init?: RequestInit) => {
    const rec: Recorded = {
      method: init?.method ?? 'GET',
      url,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(rec);
    const out = reply(rec);
    const status = out.status ?? 200;
    const text = out.text ?? (out.body === undefined ? '' : JSON.stringify(out.body));
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', stub);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const STATUS: AiStatus = {
  planner: { ready: true, reason: 'Local planner configured (fixture)', model: 'FIXTURE', route: 'local_llm', googleUsed: false },
  state: 'ready',
  credentialsPresent: true,
  generationEnabled: true,
  freeTierConfirmed: true,
  models: { text: 'gemini-2.5-flash', tts: 'gemini-3.8-flash-tts' },
  budget: { session: 's', caps: { textRequests: 2, voicePreviews: 2, productionTurns: 6 }, used: { text: 1, voice: 2, production: 0 } },
  productionSpeech: { ar: { ready: false, reason: 'x' }, en: { ready: true, reason: 'y' } },
  verification: null,
  note: '',
};

describe('voice list mirror', () => {
  it('the web voice names are exactly core GEMINI_PREBUILT_VOICES, in order', () => {
    expect([...GEMINI_VOICE_NAMES]).toEqual([...GEMINI_PREBUILT_VOICES]);
  });
});

describe('factoryAi request shapes (exact paths, methods and bodies)', () => {
  it('status is a read with no body', async () => {
    const calls = recordFetch(() => ({ body: STATUS }));
    await factoryAi.aiStatus();
    expect(calls).toEqual([{ method: 'GET', url: '/api/factory/ai/status', body: undefined }]);
  });

  it('plan start posts the brief, references and the product-mention flag', async () => {
    const calls = recordFetch(() => ({ body: { job: { id: 'job-1' }, reused: false } }));
    await factoryAi.startPlan({
      profile: 'educational',
      format: 'landscape',
      brief: 'Why the window is confirmed.',
      references: [{ id: 'r1', text: 'Reference text.' }],
      productFacts: [],
      productMentionRequested: false,
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/factory/ai/plans',
      body: {
        profile: 'educational',
        format: 'landscape',
        brief: 'Why the window is confirmed.',
        references: [{ id: 'r1', text: 'Reference text.' }],
        productFacts: [],
        productMentionRequested: false,
      },
    });
  });

  it('job status, cancel and draft conversion use the job id in the path', async () => {
    const job = { id: 'job/with space', status: 'running' };
    const calls = recordFetch((r) => (r.url.endsWith('/cancel') ? { body: { job: { ...job, status: 'cancelled' } } } : { body: { job } }));
    await factoryAi.getJob('job/with space');
    await factoryAi.cancelJob('job/with space');
    await factoryAi.planDraft('job/with space', { format: 'portrait' });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', '/api/factory/ai/jobs/job%2Fwith%20space'],
      ['POST', '/api/factory/ai/jobs/job%2Fwith%20space/cancel'],
      ['POST', '/api/factory/ai/plans/job%2Fwith%20space/draft'],
    ]);
    expect(calls[2].body).toEqual({ format: 'portrait' });
  });

  it('generated edits use PATCH on the generated route with unitId narration rows', async () => {
    const calls = recordFetch(() => ({ body: {} }));
    await factoryAi.patchGenerated('D1', { expectedRevision: 4, edits: [{ unitId: 'L01', narration: 'Edited.' }] });
    expect(calls[0]).toEqual({
      method: 'PATCH',
      url: '/api/factory/drafts/D1/generated',
      body: { expectedRevision: 4, edits: [{ unitId: 'L01', narration: 'Edited.' }] },
    });
  });

  it('speaker edits carry voice and style only, never narration', async () => {
    const calls = recordFetch(() => ({ body: {} }));
    await factoryAi.patchGenerated('D1', { expectedRevision: 5, speakers: [{ id: 'S1', voice: 'Kore', style: 'calm' }] });
    expect(calls[0].body).toEqual({ expectedRevision: 5, speakers: [{ id: 'S1', voice: 'Kore', style: 'calm' }] });
  });

  it('a speech preview posts text, voice, language and style, and the audio URL is same-origin', async () => {
    const calls = recordFetch(() => ({ body: { job: { id: 'p1' }, reused: false } }));
    await factoryAi.startSpeechPreview({ text: 'Short.', voice: 'Kore', language: 'en', style: 'calm' });
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/factory/ai/speech-previews',
      body: { text: 'Short.', voice: 'Kore', language: 'en', style: 'calm' },
    });
    expect(factoryAi.previewAudioUrl('p1')).toBe('/api/factory/ai/jobs/p1/audio');
  });

  it('apply preview is a GET and sends no body', async () => {
    const calls = recordFetch(() => ({ body: { canApply: true } }));
    await factoryAi.applyPreview('D1');
    expect(calls[0]).toEqual({ method: 'GET', url: '/api/factory/drafts/D1/apply-preview', body: undefined });
  });

  it('apply without a confirmed count sends the revision only (the safe refusal path)', async () => {
    const calls = recordFetch(() => ({ body: {} }));
    await factoryAi.applyGenerated('D1', 7);
    expect(calls[0]).toEqual({ method: 'POST', url: '/api/factory/drafts/D1/apply', body: { expectedRevision: 7 } });
  });

  it('apply with a confirmed count sends exactly that number', async () => {
    const calls = recordFetch(() => ({ body: {} }));
    await factoryAi.applyGenerated('D1', 7, 3);
    expect(calls[0].body).toEqual({ expectedRevision: 7, confirmSpeechCalls: 3 });
  });

  it('shot list JSON is a GET; markdown uses the format query and is read as text', async () => {
    const calls = recordFetch(() => ({ body: { scenes: [] } }));
    await factoryAi.shotList('D1');
    expect(calls[0]).toEqual({ method: 'GET', url: '/api/factory/drafts/D1/shot-list', body: undefined });
    expect(factoryAi.shotListMarkdownUrl('D1')).toBe('/api/factory/drafts/D1/shot-list?format=md');

    const md = recordFetch(() => ({ text: '# Shot list\n' }));
    const text = await fetchShotListMarkdown('D1');
    expect(md[0].url).toBe('/api/factory/drafts/D1/shot-list?format=md');
    expect(text).toBe('# Shot list\n');
  });

  it('a non-2xx reply becomes a FactoryApiError with the server code, status and details', async () => {
    recordFetch(() => ({ status: 422, body: { error: 'Count too low', code: 'FACTORY_INPUTS_REQUIRED', speechCalls: 3, remaining: 1 } }));
    await expect(factoryAi.applyGenerated('D1', 7, 2)).rejects.toMatchObject({
      status: 422,
      code: 'FACTORY_INPUTS_REQUIRED',
      answered: true,
      details: expect.objectContaining({ speechCalls: 3, remaining: 1 }),
    });
  });

  it('a transport failure says nothing was confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down');
    }));
    await expect(factoryAi.startPlan({ profile: 'educational', format: 'landscape', brief: 'x' })).rejects.toMatchObject({
      answered: false,
      code: 'TRANSPORT',
    });
  });
});

describe('plan gate (reads server status only)', () => {
  const base = { status: STATUS, statusError: null, confirmedFreeTier: true, briefText: 'Brief', jobRunning: false, hasUnsavedEdits: false };

  it('enables Generate only when every condition holds', () => {
    expect(generateGate(base)).toEqual({ enabled: true, reason: null });
  });

  it('local planning ignores Google credentials, flags and text budget', () => {
    const noGoogle = { ...STATUS, credentialsPresent: false, generationEnabled: false, freeTierConfirmed: false, budget: { ...STATUS.budget, used: { ...STATUS.budget.used, text: 2 } } };
    expect(generateGate({ ...base, status: noGoogle }).enabled).toBe(true);
    expect(generateGate({ ...base, status: { ...STATUS, planner: undefined } }).enabled).toBe(false);
    expect(generateGate({ ...base, status: { ...STATUS, planner: { ...STATUS.planner!, ready: false, reason: 'Local setup required' } } }).reason).toContain('Local setup');
  });

  it('refuses while a job runs, with unsaved edits, without a brief, or without the free-tier tick', () => {
    expect(generateGate({ ...base, jobRunning: true }).enabled).toBe(false);
    expect(generateGate({ ...base, hasUnsavedEdits: true }).enabled).toBe(false);
    expect(generateGate({ ...base, briefText: '   ' }).enabled).toBe(false);
    expect(generateGate({ ...base, confirmedFreeTier: false }).enabled).toBe(false);
  });

  it('does not assume generation when the status read failed', () => {
    expect(generateGate({ ...base, status: null, statusError: 'offline' }).reason).toContain('could not be read');
  });

  it('budget counts come from the server status', () => {
    expect(textRequestsLeft(STATUS)).toBe(1);
    expect(previewsLeft(STATUS)).toBe(0);
  });
});

describe('failure advice covers the codes the page can show', () => {
  it.each([
    ['FACTORY_PROVIDER_AUTH', /401|403/],
    ['FACTORY_PROVIDER_QUOTA', /429/],
    ['FACTORY_PROVIDER_TIMEOUT', /did not finish/],
    ['FACTORY_BUDGET_EXHAUSTED', /budget/],
    ['FACTORY_JOB_CANCELLED', /Cancelled/],
  ])('%s has a specific action', (code, pattern) => {
    expect(failureAdvice(code)).toMatch(pattern);
  });

  it('an unknown code is a safe default that says nothing was saved', () => {
    expect(failureAdvice('SOMETHING_NEW')).toContain('Nothing was saved');
  });
});

describe('narration edits (only changed rows are sent)', () => {
  const scenes = [
    { sourceUnitId: 'L01', narration: 'One.' },
    { sourceUnitId: 'L02', narration: 'Two.' },
  ];

  it('sends rows whose text differs from the stored text', () => {
    expect(narrationChanges(scenes, { L02: 'Two edited.' })).toEqual([{ unitId: 'L02', narration: 'Two edited.' }]);
  });

  it('an edit back to the stored text is not a change', () => {
    expect(narrationChanges(scenes, { L01: 'One.' })).toEqual([]);
  });

  it('keeps Arabic diacritics exactly as typed', () => {
    const ar = [{ sourceUnitId: 'A1', narration: 'بِسْمِ اللهِ' }];
    expect(narrationChanges(ar, { A1: 'بِسْمِ اللَّهِ' })[0].narration).toBe('بِسْمِ اللَّهِ');
  });
});

describe('apply count view (the number the owner confirms)', () => {
  const preview = (over: Partial<ApplyPreview>): ApplyPreview => ({
    draftId: 'D1',
    revision: 3,
    canApply: true,
    reused: false,
    blockers: [],
    speechCalls: 3,
    sceneIds: ['S1', 'S2', 'S3'],
    budget: { cap: 6, used: 0, remaining: 6 },
    ...over,
  });

  it('states the exact call count and the remaining budget before confirmation', () => {
    const v = applyCountView(preview({}));
    expect(v.headline).toContain('3 Gemini speech calls');
    expect(v.remainingText).toContain('6 of 6');
    expect(v.canConfirmCount).toBe(true);
  });

  it('says nothing is called when every changed line already has a verified clip', () => {
    expect(applyCountView(preview({ speechCalls: 0 })).canConfirmCount).toBe(false);
  });

  it('a reused revision adds nothing and offers no confirmation', () => {
    expect(applyCountView(preview({ reused: true })).canConfirmCount).toBe(false);
  });

  it('is blank while loading', () => {
    expect(applyCountView(null).canConfirmCount).toBe(false);
  });
});

describe('inputs', () => {
  it('reference lines are id|text pairs; blank lines are dropped, malformed lines are kept for server refusal', () => {
    // A line without an id is KEPT with an empty id, so the server refuses it visibly. It is never dropped silently.
    expect(parseReferenceLines('r1|First text\n\nbad line\nr2|Second')).toEqual([
      { id: 'r1', text: 'First text' },
      { id: '', text: 'bad line' },
      { id: 'r2', text: 'Second' },
    ]);
  });

  it('preview text is required and capped without a silent cut', () => {
    expect(previewInput('   ').ok).toBe(false);
    expect(previewInput('x'.repeat(400)).ok).toBe(false);
    expect(previewInput('A short reviewed line.').ok).toBe(true);
  });
});

