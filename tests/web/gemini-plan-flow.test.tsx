// @vitest-environment happy-dom
/**
 * Gemini planning path through the ContentPlan page, against the REAL API routes.
 *
 * Wiring: the page's `fetch('/api/...')` calls are answered by `app.inject` on the real
 * registered server (buildServerApp). Only the Google endpoint is a LABELLED PROVIDER DOUBLE
 * (a scripted fetch that returns the fixture plan and silent WAV clips). Evidence written by
 * this file is fixture evidence. It is not a live provider result and proves nothing about
 * Google availability, quality or quota.
 *
 * The error-display block at the end uses a LABELLED FAKE CLIENT (test double, no server).
 * It only checks how the page shows 401/403/429/timeout and budget refusals.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'gemini-plan-flow-'));
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  process.env.VF_PREVIEW_DISABLE = '1';
  process.env.GEMINI_API_KEY = 'FIXTURE-KEY-DOM-0123456789';
  process.env.LOCAL_LLM_ENABLED = '1';
  process.env.LOCAL_LLM_URL = 'http://127.0.0.1:8080';
  process.env.LOCAL_LLM_MODEL = 'FIXTURE-local-planner';
  process.env.LOCAL_LLM_MODEL_LICENSE = 'FIXTURE (test double, not a model)';
  process.env.GEMINI_GENERATION_ENABLED = '1';
  process.env.GEMINI_TEXT_MODEL = 'gemini-2.5-flash'; // Labelled legacy text fixture.
  process.env.GEMINI_FREE_TIER_CONFIRMED = '1';
  process.env.GEMINI_PRODUCTION_TURNS = '6';
  return { root };
});

import { buildServerApp } from '../../apps/api/src/server.js';
import { ASSETS_DIR } from '../../apps/api/src/services/platform.js';
import { loadAssetIndex, saveAssetIndex } from '../../apps/api/src/routes/assets.js';
import { fixtureEducationalPlan, makeWav, b64 } from '../gemini/helpers.js';
import { ContentPlanPage, defaultPlanDeps, type PlanDeps } from '../../apps/web/src/pages/ContentPlan';
import { factoryAi, FactoryApiError, type AiStatus, type FactoryAiClient } from '../../apps/web/src/lib/factory-api';
import { failureAdvice } from '../../apps/web/src/lib/gemini-plan-model';
import { fakeClient } from './fixtures';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT_MODEL = 'gemini-2.5-flash';
const TTS_MODEL = 'gemini-3.8-flash-tts';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** LABELLED PROVIDER DOUBLE for the Google endpoint. Counts every call. `holdText` delays the text answer. */
const provider = vi.hoisted(() => ({
  text: 0,
  tts: 0,
  holdText: null as Promise<void> | null,
  ttsCounter: 0,
  catalog: 0,
}));

async function googleDouble(url: string, init?: { body?: string }) {
  const body = JSON.parse(String(init?.body ?? 'null'));
  const json = (payload: unknown, status = 200) => ({ ok: status < 400, status, json: async () => payload });
  if (url.includes('/voices?')) {
    provider.catalog++;
    return json({ voices: [{ id: 'cruz', display_name: 'Cruz', type: 'prebuilt', language_code: 'en-US', gender: 'male', pitch: 'low', description: 'LABELLED FIXTURE: professional voice' }], next_page_token: '' });
  }
  if (url.endsWith('/v1/chat/completions')) {
    provider.text += 1;
    if (provider.holdText) await provider.holdText;
    return json({ choices: [{ message: { content: JSON.stringify(fixtureEducationalPlan()) }, finish_reason: 'stop' }] });
  }
  if (url.endsWith('/interactions') && body.model === TTS_MODEL) {
    provider.tts += 1;
    provider.ttsCounter += 1;
    const wav = makeWav({ seconds: 0.5 + provider.ttsCounter * 0.05 });
    return json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: b64(wav) }] }] });
  }
  throw new Error(`TEST DOUBLE: unexpected provider URL ${url} ${JSON.stringify(body).slice(0, 0)}`);
}

/** The page's fetch: same-origin API paths go to the real app in-process; anything else is the provider double. */
const routedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('/api/')) {
    const res = await app.inject({
      method: ((init?.method ?? 'GET') as string) as 'GET',
      url,
      payload: typeof init?.body === 'string' ? init.body : undefined,
      headers: typeof init?.body === 'string' ? { 'content-type': 'application/json' } : {},
    });
    return new Response(res.rawPayload, {
      status: res.statusCode,
      headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
    });
  }
  return googleDouble(url, init as { body?: string });
});

/** LABELLED FIXTURE VIDEO for the screen-recording line (L02). Binding checks type, licence, duration and hash only. */
function seedVideo(id: string): void {
  const fileName = `${id}.mp4`;
  const bytes = Buffer.from('FIXTURE-VIDEO-NOT-DECODED');
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSETS_DIR, fileName), bytes);
  saveAssetIndex([
    ...loadAssetIndex(),
    {
      id, name: `Fixture ${id}`, kind: 'broll', fileName, path: fileName, mimeType: 'video/mp4', sizeBytes: bytes.length, durationSec: 30,
      tags: [], status: 'active', preferred: false, source: 'Fixture (synthetic, generated by the test)', license: 'Test fixture',
      addedAt: new Date().toISOString(), usedIn: [], blocked: false,
    } as never,
  ]);
}

function seedImage(id: string): void {
  const fileName = `${id}.png`;
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSETS_DIR, fileName), PNG);
  saveAssetIndex([
    ...loadAssetIndex(),
    {
      id, name: `Fixture ${id}`, kind: 'broll', fileName, path: fileName, mimeType: 'image/png', sizeBytes: PNG.length,
      tags: [], status: 'active', preferred: false, source: 'Fixture (synthetic, generated by the test)', license: 'Test fixture',
      addedAt: new Date().toISOString(), usedIn: [], blocked: false,
    } as never,
  ]);
}

/* ------------------------------------------------------------------ DOM helpers */

let root: Root | null = null;
let host: HTMLElement | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
  await act(async () => {
    await sleep(20);
  });
}

async function unmount() {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}

/** Poll the DOM until `check` returns a truthy value. The timeout is generous: the job runs in-process. */
async function waitFor<T>(check: () => T | null | undefined | false, label: string, timeoutMs = 20000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await act(async () => {
      await sleep(40);
    });
    const v = check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for: ${label}`);
  }
}

const q = <T extends Element = HTMLElement>(sel: string): T => {
  const el = host!.querySelector(sel) as T | null;
  if (!el) throw new Error(`not found: ${sel}`);
  return el;
};
const qOrNull = (sel: string) => host!.querySelector(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => Array.from(host!.querySelectorAll(sel)) as T[];

function setValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
const typeInto = (sel: string, value: string) => act(async () => setValue(q(sel), value));
const choose = (sel: string, value: string) => act(async () => setValue(q(sel), value));
const click = (sel: string) => act(async () => q(sel).click());
const isDisabled = (sel: string) => (q<HTMLButtonElement>(sel)).disabled;

/** Shared across the ordered tests below: one draft carried from plan to apply. */
const state = { draftId: '', projectId: '', planJobCancelled: '' };

const pageDeps: PlanDeps = defaultPlanDeps;

async function startGeminiPlan(brief: string) {
  await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={vi.fn()} deps={pageDeps} />);
  await click('[data-testid="method-gemini"]');
  await waitFor(() => qOrNull('[data-testid="gemini-generate"]'), 'gemini panel');
  await waitFor(() => qOrNull('[data-testid="gemini-status"]') && !qOrNull('[data-testid="gemini-check-error"]'), 'status read');
  await typeInto('[data-testid="gemini-brief"]', brief);
  await act(async () => q<HTMLInputElement>('[data-testid="gemini-confirm-free"]').click());
  await waitFor(() => !isDisabled('[data-testid="gemini-generate"]'), 'generate enabled');
}

/* ------------------------------------------------------------------ fixtures */

beforeAll(async () => {
  vi.stubGlobal('fetch', routedFetch);
  app = await buildServerApp();
  seedImage('fx-dom-a');
  seedImage('fx-dom-b');
  seedVideo('fx-dom-video');
});

afterAll(async () => {
  await unmount();
  await app.close();
  vi.unstubAllGlobals();
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('Gemini plan in ContentPlan (real API routes, labelled provider double)', () => {
  it('a cancelled plan whose provider answer arrives late never becomes a draft and never looks successful', async () => {
    let release: () => void = () => {};
    provider.holdText = new Promise<void>((r) => {
      release = r;
    });
    const textBefore = provider.text;
    await startGeminiPlan('Explain why the delivery window is confirmed the night before the visit.');
    await click('[data-testid="gemini-generate"]');
    await waitFor(() => q('[data-testid="gemini-job-status"]').textContent === 'running', 'job running');
    expect(provider.text - textBefore).toBe(1);

    await click('[data-testid="gemini-cancel"]');
    await waitFor(() => q('[data-testid="gemini-job-status"]').textContent === 'cancelled', 'job cancelled');
    state.planJobCancelled = q('[data-testid="gemini-job-id"]').textContent ?? '';

    release();
    provider.holdText = null;
    await act(async () => {
      await sleep(300);
    });
    expect(qOrNull('[data-testid="draft-status"]')).toBeNull();
    expect(q('[data-testid="gemini-job-status"]').textContent).toBe('cancelled');
    const job = await factoryAi.getJob(state.planJobCancelled);
    expect(job.status).toBe('cancelled');
    expect(job.result).toBeNull();
    expect(window.localStorage.getItem('vf.gemini.activePlanJob')).toBeNull();
    await unmount();
  }, 60_000);

  it('a fresh plan adopts the three treatments as an UNAPPROVED Gemini draft, then the picture, narration and voice steps save', async () => {
    const textBefore = provider.text;
    await startGeminiPlan('Explain why the delivery window is confirmed the night before the visit.');
    await click('[data-testid="gemini-generate"]');

    await waitFor(() => qOrNull('[data-testid="draft-status"]'), 'draft adopted', 30000);
    expect(provider.text - textBefore).toBe(1);
    expect(q('[data-testid="draft-status"]').textContent).toContain('Gemini-generated');
    expect(q('[data-testid="draft-status"]').textContent).toContain('unapproved');
    state.draftId = q('[data-testid="draft-status"]').querySelector('h3 .mono')!.textContent ?? '';
    expect(state.draftId).toMatch(/\S/);
    expect(qa('[data-testid="treatments"] input[type="radio"], [data-testid="treatments"] button').length).toBeGreaterThan(0);

    // Missing pictures stop Apply before any provider spend.
    expect(isDisabled('[data-testid="apply-draft"]')).toBe(true);
    expect(qOrNull('[data-testid="apply-blockers"]')).not.toBeNull();

    // Narration is shown as generated text and is editable in the scene table.
    const narrations = qa<HTMLTextAreaElement>('textarea[aria-label^="Narration for "]');
    expect(narrations.length).toBeGreaterThan(0);

    // Bind a library picture to each scene (existing PATCH path), then save the selection.
    // The screen-recording line (L02) needs a video; a still would be refused by the binding rule.
    const pictures = qa<HTMLSelectElement>('select[aria-label^="Picture for "]');
    for (const [i, sel] of pictures.entries()) {
      const isRecording = (sel.getAttribute('aria-label') ?? '').endsWith('-L02');
      await act(async () => setValue(sel, isRecording ? 'fx-dom-video' : i % 2 === 0 ? 'fx-dom-a' : 'fx-dom-b'));
    }
    await click('[data-testid="save-selection"]');
    await waitFor(() => isDisabled('[data-testid="save-selection"]'), 'selection saved');

    // Edit one generated narration line and save it through the generated route. Nothing is called.
    const ttsBefore = provider.tts;
    const textNow = provider.text;
    const first = qa<HTMLTextAreaElement>('textarea[aria-label^="Narration for "]')[0];
    const firstLabel = first.getAttribute('aria-label')!;
    await act(async () => setValue(first, 'Edited generated line, still unapproved.'));
    await click('[data-testid="save-narration"]');
    await waitFor(() => qa<HTMLTextAreaElement>('textarea[aria-label^="Narration for "]').some((t) => t.value.startsWith('Edited generated')), 'narration saved');
    expect(qa<HTMLTextAreaElement>('textarea[aria-label^="Narration for "]').find((t) => t.getAttribute('aria-label') === firstLabel)!.value).toBe('Edited generated line, still unapproved.');
    expect(provider.text).toBe(textNow);
    expect(provider.tts).toBe(ttsBefore);

    // Voice preview: one short unary turn. It costs one voice preview from the session budget.
    const speakerId = qa('[data-testid^="gemini-speaker-"]')[0].getAttribute('data-testid')!.replace('gemini-speaker-', '');
    await click(`[data-testid="preview-${speakerId}"]`);
    await waitFor(() => qOrNull(`[data-testid="audio-${speakerId}"]`), 'preview audio', 30000);
    expect(provider.tts - ttsBefore).toBe(1);

    // Browse metadata, choose an extended voice and a delivery preset, then save.
    // The real API validates the id against its catalog, and no audio is generated.
    await click('[data-testid="load-google-voices"]');
    await waitFor(() => qa<HTMLOptionElement>('option').some(o => o.value === 'cruz'), 'extended voice loaded');
    await choose(`select[aria-label="Voice for ${speakerId}"]`, 'cruz');
    await choose(`select[aria-label="Delivery preset for ${speakerId}"]`, 'podcast');
    expect(q<HTMLInputElement>(`input[aria-label="Style for ${speakerId}"]`).value).toContain('Calm conversational');
    await click('[data-testid="save-voices"]');
    await waitFor(() => isDisabled('[data-testid="save-voices"]'), 'extended voice saved');
    const extended = await pageDeps.client.getDraft(state.draftId);
    expect(extended.speakers.find(s => s.id === speakerId)?.voiceId).toBe('cruz');
    expect(extended.speakers.find(s => s.id === speakerId)?.style).toContain('Calm conversational');
    const catalogBefore = provider.catalog;
    await unmount();
    await mount(<ContentPlanPage initialDraftId={state.draftId} onOpenEditor={vi.fn()} deps={pageDeps} />);
    await waitFor(() => qOrNull(`select[aria-label="Voice for ${speakerId}"]`), 'voice reopened');
    await waitFor(() => q<HTMLSelectElement>(`select[aria-label="Voice for ${speakerId}"]`).value === 'cruz', 'saved extended voice restored');
    expect(q<HTMLSelectElement>(`select[aria-label="Delivery preset for ${speakerId}"]`).value).toBe('podcast');
    expect(provider.catalog).toBe(catalogBefore); // Reopen reads the local cache only.
    expect(provider.tts - ttsBefore).toBe(1);
    expect(provider.text).toBe(textNow);
    // Return to the studio voice used by the following conflict test.
    await choose(`select[aria-label="Voice for ${speakerId}"]`, 'Kore');
    await click('[data-testid="save-voices"]');
    await waitFor(() => isDisabled('[data-testid="save-voices"]'), 'voices saved');
    expect(provider.tts - ttsBefore).toBe(1);

    // Shot list: one row per scene, with the markdown and JSON exports.
    expect(qOrNull('[data-testid="shot-rows"]')).not.toBeNull();
    expect(qa('[data-testid^="shot-"]').length).toBeGreaterThan(0);
    expect(qOrNull('[data-testid="export-shot-json"]')).not.toBeNull();
    expect(qOrNull('[data-testid="export-shot-md"]')).not.toBeNull();
    await unmount();
  }, 120_000);

  it('a stale draft edit is refused with a conflict and keeps the typed text; reopen restores the saved narration, voice and pictures with no provider call', async () => {
    const textBefore = provider.text;
    const ttsBefore = provider.tts;
    await mount(<ContentPlanPage initialDraftId={state.draftId} onOpenEditor={vi.fn()} deps={pageDeps} />);
    await waitFor(() => qOrNull('[data-testid="draft-status"]'), 'draft reopened');

    // Another writer changes the draft while this page is open (a voice style). This page is now stale.
    const current = await (await routedFetch(`/api/factory/drafts/${state.draftId}`)).json();
    await factoryAi.patchGenerated(state.draftId, { expectedRevision: current.revision, speakers: [{ id: current.speakers[0].id, style: 'calm' }] });

    const area = qa<HTMLTextAreaElement>('textarea[aria-label^="Narration for "]')[1];
    const typed = 'Typed in a stale tab.';
    await act(async () => setValue(area, typed));
    await click('[data-testid="save-narration"]');
    const alert = await waitFor(() => qOrNull('[data-testid="plan-error"]'), 'conflict shown', 15000);
    expect(alert.textContent).toBeTruthy();
    expect(qa<HTMLTextAreaElement>('textarea[aria-label^="Narration for "]')[1].value).toBe(typed);
    expect(provider.text).toBe(textBefore);
    expect(provider.tts).toBe(ttsBefore);
    await unmount();

    // Fresh reopen with the server state: the earlier accepted edit, the voice choice and the pictures survived.
    // The refused typed text is not on the server.
    await mount(<ContentPlanPage initialDraftId={state.draftId} onOpenEditor={vi.fn()} deps={pageDeps} />);
    await waitFor(() => qOrNull('[data-testid="draft-status"]'), 'draft reopened again');
    const saved = qa<HTMLTextAreaElement>('textarea[aria-label^="Narration for "]').map((t) => t.value);
    expect(saved.includes('Edited generated line, still unapproved.')).toBe(true);
    expect(saved.includes(typed)).toBe(false);
    const voice = qa<HTMLSelectElement>('select[aria-label^="Voice for "]')[0];
    expect(voice.value).toBe('Kore');
    expect(provider.text).toBe(textBefore);
    expect(provider.tts).toBe(ttsBefore);
    await unmount();
  }, 120_000);

  it('the apply count is shown before confirmation, the confirmed count is the count called, and the editor opens', async () => {
    const preview = await factoryAi.applyPreview(state.draftId);
    expect(preview.canApply).toBe(true);
    const ttsBefore = provider.tts;
    const onOpenEditor = vi.fn();

    await mount(<ContentPlanPage initialDraftId={state.draftId} onOpenEditor={onOpenEditor} deps={pageDeps} />);
    await waitFor(() => qOrNull('[data-testid="generated-apply"]'), 'apply panel');
    const countText = await waitFor(() => qOrNull('[data-testid="apply-count"]')?.textContent, 'count shown');
    expect(countText).toContain(String(preview.speechCalls));
    expect(provider.tts).toBe(ttsBefore);

    expect(isDisabled('[data-testid="apply-draft"]')).toBe(true);
    await act(async () => q<HTMLInputElement>('[data-testid="review-confirm"]').click());
    await waitFor(() => !isDisabled('[data-testid="apply-draft"]'), 'apply enabled');
    await click('[data-testid="apply-draft"]');
    await waitFor(() => qOrNull('[data-testid="apply-confirm"]'), 'confirmation shown');
    expect(provider.tts).toBe(ttsBefore);

    await click('[data-testid="apply-confirm-go"]');
    await waitFor(() => onOpenEditor.mock.calls.length > 0, 'editor opened', 60000);
    state.projectId = String(onOpenEditor.mock.calls[0][0]);
    expect(state.projectId).toMatch(/\S/);
    expect(provider.tts - ttsBefore).toBe(preview.speechCalls);
    await unmount();
  }, 120_000);

  it('re-applying the unchanged revision calls nothing and opens the same project', async () => {
    const ttsBefore = provider.tts;
    const textBefore = provider.text;
    const env = await (await routedFetch(`/api/factory/drafts/${state.draftId}`)).json();
    const again = await factoryAi.applyGenerated(state.draftId, env.revision, 0);
    expect(again.projectId).toBe(state.projectId);
    expect(again.reused).toBe(true);
    expect(provider.tts).toBe(ttsBefore);
    expect(provider.text).toBe(textBefore);
  });
});

/* ------------------------------------------------------------------ labelled fake client: error display */

const READY: AiStatus = {
  planner: { ready: true, reason: 'Local planner configured (fixture)', model: 'FIXTURE', route: 'local_llm', googleUsed: false },
  state: 'ready',
  credentialsPresent: true,
  generationEnabled: true,
  freeTierConfirmed: true,
  models: { text: TEXT_MODEL, tts: TTS_MODEL },
  budget: { session: 'fixture', caps: { textRequests: 2, voicePreviews: 2, productionTurns: 6 }, used: { text: 0, voice: 0, production: 0 } },
  productionSpeech: { ar: { ready: false, reason: 'fixture' }, en: { ready: false, reason: 'fixture' } },
  verification: null,
  note: 'LABELLED FAKE CLIENT (test only)',
};

function fakeAi(over: Partial<FactoryAiClient>): FactoryAiClient {
  return {
    aiStatus: async () => READY,
    startPlan: async () => {
      throw new Error('not used');
    },
    getJob: async () => {
      throw new Error('not used');
    },
    cancelJob: async () => {
      throw new Error('not used');
    },
    planDraft: async () => {
      throw new Error('not used');
    },
    patchGenerated: async () => {
      throw new Error('not used');
    },
    startSpeechPreview: async () => {
      throw new Error('not used');
    },
    previewAudioUrl: () => '',
    applyPreview: async () => {
      throw new Error('not used');
    },
    applyGenerated: async () => {
      throw new Error('not used');
    },
    shotList: async () => {
      throw new Error('not used');
    },
    shotListMarkdownUrl: () => '',
    ...over,
  };
}

describe('Gemini plan error display (labelled fake client, no provider)', () => {
  const failures: Array<[string, number, string]> = [
    ['401 key rejected', 401, 'FACTORY_PROVIDER_AUTH'],
    ['403 access refused', 403, 'FACTORY_PROVIDER_AUTH'],
    ['429 quota reached', 429, 'FACTORY_PROVIDER_QUOTA'],
    ['timeout', 504, 'FACTORY_PROVIDER_TIMEOUT'],
  ];
  for (const [label, status, code] of failures) {
    it(`${label}: the brief stays, the code and the action are shown, nothing is saved`, async () => {
      const ai = fakeAi({
        startPlan: async () => {
          throw new FactoryApiError({ message: `${label} (fixture)`, status, code, answered: true });
        },
      });
      await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={vi.fn()} deps={{ ...pageDeps, client: fakeClient(), ai }} />);
      await click('[data-testid="method-gemini"]');
      await waitFor(() => qOrNull('[data-testid="gemini-status"]'), 'status');
      await typeInto('[data-testid="gemini-brief"]', 'Keep this brief.');
      await act(async () => q<HTMLInputElement>('[data-testid="gemini-confirm-free"]').click());
      await waitFor(() => !isDisabled('[data-testid="gemini-generate"]'), 'generate enabled');
      await click('[data-testid="gemini-generate"]');
      const banner = await waitFor(() => qOrNull('[data-testid="gemini-job-error"]'), 'error shown');
      expect(banner.textContent).toContain(code);
      expect(banner.textContent).toContain(failureAdvice(code));
      expect(q<HTMLInputElement>('[data-testid="gemini-brief"]').value).toBe('Keep this brief.');
      expect(qOrNull('[data-testid="draft-status"]')).toBeNull();
      await unmount();
    });
  }

  it('missing local planner disables Generate without consulting Google budget', async () => {
    const spent = fakeAi({
      aiStatus: async () => ({ ...READY, planner: { ...READY.planner!, ready: false, reason: 'Local planner setup required' } }),
      startPlan: async () => {
        throw new Error('must not be called');
      },
    });
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={vi.fn()} deps={{ ...pageDeps, client: fakeClient(), ai: spent }} />);
    await click('[data-testid="method-gemini"]');
    await waitFor(() => qOrNull('[data-testid="gemini-disabled-reason"]')?.textContent?.includes('setup required'), 'local setup reason');
    await typeInto('[data-testid="gemini-brief"]', 'Brief.');
    await act(async () => q<HTMLInputElement>('[data-testid="gemini-confirm-free"]').click());
    expect(isDisabled('[data-testid="gemini-generate"]')).toBe(true);
    await unmount();
  });

  it('a religious brief starts with product mention off and the box disabled', async () => {
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={vi.fn()} deps={{ ...pageDeps, client: fakeClient(), ai: fakeAi({}) }} />);
    await click('[data-testid="method-gemini"]');
    await waitFor(() => qOrNull('[data-testid="gemini-profile"]'), 'profile');
    expect(q<HTMLInputElement>('[data-testid="gemini-product-mention"]').checked).toBe(false);
    await choose('[data-testid="gemini-profile"]', 'religious');
    expect(q<HTMLInputElement>('[data-testid="gemini-product-mention"]').disabled).toBe(true);
    await unmount();
  });
});

