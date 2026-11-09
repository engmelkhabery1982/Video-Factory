// @vitest-environment happy-dom
/**
 * Post-create storyboard edits through the REAL client and REAL routes.
 *
 * - The page is mounted with the production `factoryApi` client. Its global `fetch` is routed in-process to
 *   `app.inject`, so the revisioned intake routes, the validation and the stored draft file are the real ones.
 * - A stale 409 is a REAL conflict: another writer PATCHes the same draft through the route and the page still
 *   holds the old revision.
 * - LABELLED TEST DOUBLE: the Gemini client throws on any call, and any non-/api fetch is refused. These tests
 *   must make zero provider calls.
 * This is HTTP and DOM evidence. It is NOT browser evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const os = process.getBuiltinModule('node:os') as typeof import('node:os');
  const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'storyboard-conflict-http-'));
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  process.env.VF_PREVIEW_DISABLE = '1';
  delete process.env.VF_TRANSCRIBE_COMMAND;
  return { root };
});

import { buildServerApp } from '../../apps/api/src/server.js';
import { ASSETS_DIR, DATA_DIR } from '../../apps/api/src/services/platform.js';
import { loadAssetIndex, saveAssetIndex } from '../../apps/api/src/routes/assets.js';
import { ContentPlanPage } from '../../apps/web/src/pages/ContentPlan';
import { factoryApi, factoryAi } from '../../apps/web/src/lib/factory-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;
let root: Root | null = null;
let host: HTMLElement | null = null;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PIC = 'pic-conflict';
const seen = { patches: 0 };
const providerCalls = vi.hoisted(() => ({ n: 0 }));

/** Routes the page's relative `/api/...` fetches into the real app. Anything else is refused. */
async function routedFetch(input: unknown, init?: RequestInit) {
  const url = String(input);
  // Any request that is not the app's own API is a provider attempt. It is counted and refused.
  if (!url.startsWith('/api/')) {
    providerCalls.n += 1;
    throw new Error(`TEST DOUBLE: non-API request refused: ${url}`);
  }
  const method = ((init?.method ?? 'GET') as string).toUpperCase() as 'GET' | 'POST' | 'PATCH';
  if (method === 'PATCH') seen.patches += 1;
  const payload = init?.body === undefined ? undefined : String(init.body);
  const res = await app.inject({ method, url, payload, headers: payload === undefined ? {} : { 'content-type': 'application/json' } });
  return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => res.body } as unknown as Response;
}

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const res = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'content-type': 'application/json' } });
  let json: any = null;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.statusCode, json };
}

const draftFile = (id: string) => path.join(DATA_DIR, 'factory', 'drafts', `${id}.json`);
const draftBytes = (id: string) => fs.readFileSync(draftFile(id), 'utf8');

const panel = (id: string, narration: string, extra: Record<string, unknown> = {}) => ({
  id, narration, speakerId: null, assetId: PIC, startSec: null, endSec: null, locked: false, ...extra,
});
const timed = (id: string, narration: string, startSec: number, endSec: number, extra: Record<string, unknown> = {}) =>
  panel(id, narration, { startSec, endSec, ...extra });

async function createDraft(scenes: unknown[]) {
  const r = await call('POST', '/api/factory/drafts', {
    contentProfile: 'educational', format: 'landscape', channelBrandId: null, requestedSpeakers: [], referenceProjectId: null, visualLanguage: null,
    inputs: { brief: '', script: null, audioAssetId: null, visualAssetIds: [PIC], storyboard: { version: 1, scenes }, narrationMode: 'none', captions: false },
  });
  expect(r.status).toBe(201);
  return r.json as { draftId: string; revision: number };
}

/** Another writer, through the real route. This is what makes the page's revision stale. */
const otherWriter = (draftId: string, expectedRevision: number, scenes: unknown[]) =>
  call('PATCH', `/api/factory/drafts/${draftId}/intake`, { expectedRevision, storyboard: { version: 1, scenes } });

const q = <T extends Element = HTMLElement>(sel: string): T => {
  const el = host!.querySelector(sel);
  if (!el) throw new Error(`no element for ${sel}`);
  return el as T;
};
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** Sets a controlled input or textarea the way a user does, so React's change handler runs. */
async function type(sel: string, value: string) {
  const el = q<HTMLInputElement | HTMLTextAreaElement>(sel);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function clickBy(sel: string) {
  await act(async () => { q<HTMLButtonElement>(sel).click(); });
}
async function tick(sel: string, checked: boolean) {
  const el = q<HTMLInputElement>(sel);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!.call(el, checked);
    el.dispatchEvent(new Event('click', { bubbles: true }));
  });
}

async function mountPage(draftId: string | null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const deps = {
    client: factoryApi,
    loadLibrary: async () => ((await call('GET', '/api/assets')).json.assets ?? []),
    uploadLibraryFile: async () => { throw new Error('TEST DOUBLE: no upload on this path'); },
    ai: factoryAi,
  };
  await act(async () => {
    root!.render(<ContentPlanPage initialDraftId={draftId} onOpenEditor={() => {}} deps={deps as never} />);
  });
  await flush();
  await flush();
}
async function unmountPage() {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}

beforeAll(async () => {
  app = await buildServerApp();
  await app.ready();
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSETS_DIR, 'conflict-picture.png'), PNG);
  saveAssetIndex([
    ...loadAssetIndex(),
    {
      id: PIC, name: 'Conflict fixture picture', kind: 'screenshot', fileName: 'conflict-picture.png', path: 'conflict-picture.png',
      mimeType: 'image/png', sizeBytes: PNG.length, tags: [], status: 'active', preferred: false,
      source: 'Fixture (synthetic, generated by the test)', license: 'Test fixture', addedAt: new Date().toISOString(), usedIn: [], blocked: false,
    } as never,
  ]);
  vi.stubGlobal('fetch', routedFetch);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
});
beforeEach(async () => {
  await unmountPage();
  seen.patches = 0;
  providerCalls.n = 0;
});

describe('post-create storyboard through the real client and routes (HTTP and DOM, no browser)', () => {
  it('a real stale 409 keeps typed words, timing and picture visible; reload merges; save writes once; bytes checked; reopen shows the saved edit', async () => {
    const created = await createDraft([timed('s1', 'Original words one.', 0, 4), timed('s2', 'Original words two.', 4, 8)]);
    const D = created.draftId;
    await mountPage(D);
    expect(q('[data-testid="post-create-storyboard"]').textContent).toMatch(/Storyboard \(saved to this draft\)/);

    // Another writer changes panel 2 through the real route. The page still holds the old revision.
    const other = await otherWriter(D, created.revision, [timed('s1', 'Original words one.', 0, 4), timed('s2', 'Other writer changed this.', 4, 8)]);
    expect(other.status).toBe(200);
    const storedAfterOther = draftBytes(D);

    // The user types in panel 1, moves its start to 1 s, confirms the timing change, and saves.
    await type('[aria-label="Post-save words for panel 1"]', 'My typed words.');
    await type('[aria-label="Post-save start for panel 1"]', '1');
    await tick('[aria-label="Confirm timing changes"]', true);
    await clickBy('[data-testid="post-create-save"]');
    await flush();

    // The refusal is a REAL 409 from the route. Typed words, timing, confirmation and picture stay on screen.
    expect(seen.patches).toBe(1);
    expect(q('[data-testid="post-create-error"]').textContent).toMatch(/now revision \d+\)/);
    expect(q<HTMLTextAreaElement>('[aria-label="Post-save words for panel 1"]').value).toBe('My typed words.');
    expect(q<HTMLInputElement>('[aria-label="Post-save start for panel 1"]').value).toBe('1');
    expect(q<HTMLInputElement>('[aria-label="Confirm timing changes"]').checked).toBe(true);
    expect(q<HTMLSelectElement>('[aria-label="Post-save picture for panel 1"]').value).toBe(PIC);
    expect(draftBytes(D)).toBe(storedAfterOther);

    // Explicit reload from the server. The newer panel 2 arrives; the typed panel 1 is merged, not dropped.
    await clickBy('[data-testid="post-create-reload"]');
    await flush();
    await flush();
    expect(q('[data-testid="post-create-note"]').textContent).toMatch(/changed to revision \d+\. Your typed edits are kept/);
    expect(q<HTMLTextAreaElement>('[aria-label="Post-save words for panel 1"]').value).toBe('My typed words.');
    expect(q<HTMLTextAreaElement>('[aria-label="Post-save words for panel 2"]').value).toBe('Other writer changed this.');
    expect(draftBytes(D)).toBe(storedAfterOther);

    // Save again on the refreshed revision. Exactly one more write, checked against the new revision.
    const beforeSave = seen.patches;
    await clickBy('[data-testid="post-create-save"]');
    await flush();
    await flush();
    expect(seen.patches).toBe(beforeSave + 1);
    const stored = JSON.parse(draftBytes(D));
    expect(stored.revision).toBe(created.revision + 2);
    const scenes = stored.intake.storyboard.scenes as Array<Record<string, unknown>>;
    expect(scenes.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(scenes[0]).toMatchObject({ narration: 'My typed words.', startSec: 1, endSec: 4, assetId: PIC });
    expect(scenes[1]).toMatchObject({ narration: 'Other writer changed this.', startSec: 4, endSec: 8, assetId: PIC });

    // Reopen: the saved words and timing come back from the stored draft.
    await unmountPage();
    await mountPage(D);
    expect(q<HTMLTextAreaElement>('[aria-label="Post-save words for panel 1"]').value).toBe('My typed words.');
    expect(q<HTMLInputElement>('[aria-label="Post-save start for panel 1"]').value).toBe('1');
    expect(providerCalls.n).toBe(0);
  });

  it('a row locked by another writer after the user typed is refused by the route as a whole, naming its scene ID; typed words stay; nothing is written', async () => {
    const created = await createDraft([timed('k1', 'Free words.', 0, 4), timed('k2', 'Also free.', 4, 8)]);
    const D = created.draftId;
    await mountPage(D);
    await type('[aria-label="Post-save words for panel 1"]', 'Typed before the lock.');
    // Another writer locks panel 1 through the real route. The page still holds the old revision.
    const locked = await otherWriter(D, created.revision, [timed('k1', 'Free words.', 0, 4, { locked: true }), timed('k2', 'Also free.', 4, 8)]);
    expect(locked.status).toBe(200);
    const before = draftBytes(D);

    // The revision is checked before the lock, so the first save is a conflict, and the typed words stay.
    await clickBy('[data-testid="post-create-save"]');
    await flush();
    expect(q('[data-testid="post-create-error"]').textContent).toMatch(/now revision \d+\)/);
    expect(q<HTMLTextAreaElement>('[aria-label="Post-save words for panel 1"]').value).toBe('Typed before the lock.');

    // Reload merges the server's locked row. The typed words stay in the locked row, shown but not editable.
    await clickBy('[data-testid="post-create-reload"]');
    await flush();
    await flush();
    expect(q<HTMLTextAreaElement>('[aria-label="Post-save words for panel 1"]').value).toBe('Typed before the lock.');
    expect(q<HTMLTextAreaElement>('[aria-label="Post-save words for panel 1"]').disabled).toBe(true);
    expect(draftBytes(D)).toBe(before);

    // Save: the route refuses the whole edit because panel 1 is locked, and names it.
    await clickBy('[data-testid="post-create-save"]');
    await flush();
    await flush();
    const refusal = q('[data-testid="post-create-error"]').textContent ?? '';
    expect(refusal).toMatch(/Locked panels cannot change: k1/);
    expect(refusal).toMatch(/Your typed edits are kept/);
    expect(q<HTMLTextAreaElement>('[aria-label="Post-save words for panel 1"]').value).toBe('Typed before the lock.');
    expect(draftBytes(D)).toBe(before);
    expect(providerCalls.n).toBe(0);
  });

  it('a start after the end is refused in the page before any request, and refused by the route with no write', async () => {
    const created = await createDraft([timed('t1', 'Timed words.', 0, 4)]);
    const D = created.draftId;
    await mountPage(D);
    const before = draftBytes(D);

    await type('[aria-label="Post-save start for panel 1"]', '6');
    await clickBy('[data-testid="post-create-save"]');
    await flush();
    const patchesAfterClientRefusal = seen.patches;
    expect(patchesAfterClientRefusal).toBe(0);
    expect(q('[data-testid="post-create-error"]').textContent).toMatch(/Panel 1: End must be after Start\./);
    expect(draftBytes(D)).toBe(before);

    // The same invalid timing sent straight to the route is refused with a reason and nothing is written.
    const bad = await call('PATCH', `/api/factory/drafts/${D}/intake`, {
      expectedRevision: created.revision,
      confirmTiming: true,
      storyboard: { version: 1, scenes: [timed('t1', 'Timed words.', 6, 4)] },
    });
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('FACTORY_VALIDATION');
    expect(bad.json.error).toBe('storyboard.scenes[0]: endSec must be greater than startSec.');
    expect(draftBytes(D)).toBe(before);
    expect(providerCalls.n).toBe(0);
  });
});
