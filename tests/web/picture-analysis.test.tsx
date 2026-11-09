// @vitest-environment happy-dom
/**
 * DOM evidence for the picture analysis panel. LABELLED DOUBLE: the vision client is a test double that returns fixed
 * answers. No model runs, no server is called, no provider is called. Browser acceptance is a separate gate.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PictureAnalysis } from '../../apps/web/src/components/factory/PictureAnalysis';
import { FactoryApiError } from '../../apps/web/src/lib/factory-api';
import type { VisionClient, VisionJobView, VisionStatusView } from '../../apps/web/src/lib/vision-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const OBS = {
  subject: 'a brass desk lamp', environment: 'a wooden table', lighting: 'soft window light', composition: 'centred object',
  shot: 'close-up', exclude: '', containsText: false, containsLogoOrBrand: false, containsPeople: false, uncertainties: ['base partly hidden'],
};
const READY: VisionStatusView = { ready: true, missing: [], serverReachable: true, model: { name: 'm', licence: 'Apache-2.0', sha256Matches: true }, projector: { name: 'p', licence: 'Apache-2.0', sha256Matches: true }, evidence: '' };
const job = (over: Partial<VisionJobView> = {}): VisionJobView => ({ id: 'lvj_1', assetId: 'pic-a', sha256: 'a'.repeat(64), state: 'succeeded', timeoutSec: 240, createdAt: '', updatedAt: '', error: null, observation: OBS, ...over });

function env(over: Record<string, unknown> = {}) {
  return {
    draftId: 'dft_1', revision: 7, profile: { contentProfile: 'educational' },
    intake: { visualRoles: { 'pic-a': 'style_reference', 'pic-b': 'character_reference', 'pic-c': 'final_shot' }, visualReview: {}, conditioning: null },
    ...over,
  } as any;
}

function doubleClient(overrides: Partial<VisionClient> = {}) {
  const client: VisionClient = {
    visionStatus: vi.fn(async () => READY),
    startVision: vi.fn(async () => job({ state: 'running', observation: null })),
    getVision: vi.fn(async () => job()),
    cancelVision: vi.fn(async () => job({ state: 'cancelled', observation: null })),
    saveReview: vi.fn(async () => env({ revision: 8 })),
    ...overrides,
  };
  return client;
}

async function mount(client: VisionClient, e = env(), onSaved = vi.fn(), picsOverride?: Array<{ id: string; name: string; source?: string | null; license?: string | null; sha256?: string | null }>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const pictures = picsOverride ?? [
    { id: 'pic-a', name: 'Lamp photo' },
    { id: 'pic-b', name: 'Mascot' },
    { id: 'pic-c', name: 'Chart' },
  ];
  await act(async () => { root!.render(<PictureAnalysis client={client} env={e} pictures={pictures} onSaved={onSaved} />); });
  await flush(20);
  return { onSaved };
}

async function flush(ms: number) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}
const q = <T extends Element = HTMLElement>(sel: string) => {
  const el = host!.querySelector<T>(sel);
  if (!el) throw new Error(`no element ${sel}`);
  return el;
};
const buttonNamed = (text: string) => Array.from(host!.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
async function click(el: HTMLElement) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}
async function typeInto(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('picture analysis panel (DOM, labelled vision double)', () => {
  it('when the local engine is not set up: the note says why, and no analysis can start', async () => {
    const client = doubleClient({ visionStatus: vi.fn(async () => ({ ...READY, ready: false, missing: ['The local vision engine (VISION_MODEL_PATH) is not set.'] })) });
    await mount(client);
    expect(q('[data-testid="vision-note"]').textContent).toMatch(/Automatic description of pictures is unavailable.*VISION_MODEL_PATH/);
    expect(buttonNamed('Analyse picture')!.disabled).toBe(true);
    expect(client.startVision).not.toHaveBeenCalled();
  });

  it('only style and character pictures are analysed; the final shot is not offered', async () => {
    await mount(doubleClient());
    const items = host!.querySelectorAll('[data-testid="picture-analysis-item"]');
    expect(items.length).toBe(2);
    expect(host!.textContent).not.toMatch(/Chart/);
  });

  it('analyse → running → finished fills the description; nothing is used until it is saved as reviewed', async () => {
    const client = doubleClient({ getVision: vi.fn(async () => job()) });
    await mount(client);
    await click(buttonNamed('Analyse picture')!);
    expect(client.startVision).toHaveBeenCalledWith('pic-a');
    await flush(900);
    const field = q<HTMLTextAreaElement>('textarea[aria-label="Reviewed description of Lamp photo"]');
    expect(field.value).toMatch(/Subject: a brass desk lamp; Environment: a wooden table/);
    expect(host!.textContent).toMatch(/Not reviewed\. Not used in stills\./);
    expect(client.saveReview).not.toHaveBeenCalled();
  });

  it('use the reviewed description: the server gets the typed text, the job id and the whole review map', async () => {
    const existing = { 'pic-b': { jobId: 'lvj_old', sha256: 'b'.repeat(64), state: 'reviewed', text: 'Subject: a mascot', useInPrompts: true, flags: { containsText: false, containsLogoOrBrand: false, containsPeople: false } } };
    const client = doubleClient({ getVision: vi.fn(async () => job()) });
    const { onSaved } = await mount(client, env({ intake: { visualRoles: { 'pic-a': 'style_reference', 'pic-b': 'character_reference' }, visualReview: existing, conditioning: null } }));
    await click(buttonNamed('Analyse picture')!);
    await flush(900);
    const field = q<HTMLTextAreaElement>('textarea[aria-label="Reviewed description of Lamp photo"]');
    await typeInto(field, 'Subject: a brass desk lamp, polished; Environment: a wooden table');
    await click(buttonNamed('Use this description in stills')!);
    expect(client.saveReview).toHaveBeenCalledWith('dft_1', {
      expectedRevision: 7,
      visualReview: {
        'pic-b': { jobId: 'lvj_old', state: 'reviewed', text: 'Subject: a mascot', useInPrompts: true },
        'pic-a': { jobId: 'lvj_1', state: 'reviewed', text: 'Subject: a brass desk lamp, polished; Environment: a wooden table', useInPrompts: true },
      },
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 8 }));
  });

  it('a refused description keeps the typed text and shows the reason; nothing is saved', async () => {
    const client = doubleClient({
      getVision: vi.fn(async () => job()),
      saveReview: vi.fn(async () => { throw new FactoryApiError({ message: 'A religious still cannot use it.', status: 422, code: 'FACTORY_IDENTITY_REFUSED', answered: true }); }),
    });
    const { onSaved } = await mount(client);
    await click(buttonNamed('Analyse picture')!);
    await flush(900);
    const field = q<HTMLTextAreaElement>('textarea[aria-label="Reviewed description of Lamp photo"]');
    await typeInto(field, 'Subject: a lamp with lettering');
    await click(buttonNamed('Use this description in stills')!);
    expect(q('[role="alert"]').textContent).toMatch(/A religious still cannot use it\. Your typed text is kept/);
    expect(field.value).toBe('Subject: a lamp with lettering');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a stale analysis (the picture changed) is refused with the instruction to analyse again; typed text is kept', async () => {
    const client = doubleClient({
      getVision: vi.fn(async () => job()),
      saveReview: vi.fn(async () => { throw new FactoryApiError({ message: 'The picture changed.', status: 409, code: 'FACTORY_CANDIDATE_STALE', answered: true }); }),
    });
    await mount(client);
    await click(buttonNamed('Analyse picture')!);
    await flush(900);
    await click(buttonNamed('Use this description in stills')!);
    expect(q('[role="alert"]').textContent).toMatch(/changed after it was analysed\. Analyse it again/);
    expect(q<HTMLTextAreaElement>('textarea[aria-label="Reviewed description of Lamp photo"]').value).toMatch(/brass desk lamp/);
  });

  it('a revision conflict says to reload and keeps the typed text', async () => {
    const client = doubleClient({
      getVision: vi.fn(async () => job()),
      saveReview: vi.fn(async () => { throw new FactoryApiError({ message: 'changed', status: 409, code: 'FACTORY_REVISION_CONFLICT', answered: true, currentRevision: 9 }); }),
    });
    await mount(client);
    await click(buttonNamed('Analyse picture')!);
    await flush(900);
    await click(buttonNamed('Use this description in stills')!);
    expect(q('[role="alert"]').textContent).toMatch(/changed since you loaded it\. Reload, then save again/);
  });

  it('reject saves the picture as rejected with no text and no use in stills', async () => {
    const client = doubleClient({ getVision: vi.fn(async () => job()) });
    await mount(client);
    await click(buttonNamed('Analyse picture')!);
    await flush(900);
    await click(buttonNamed('Reject this description')!);
    expect(client.saveReview).toHaveBeenCalledWith('dft_1', expect.objectContaining({
      visualReview: { 'pic-a': { jobId: 'lvj_1', state: 'rejected', text: '', useInPrompts: false } },
    }));
  });

  it('cancel while analysing calls the server and shows the cancelled state; a late answer is not shown', async () => {
    const client = doubleClient({ getVision: vi.fn(async () => job({ state: 'running', observation: null })) });
    await mount(client);
    await click(buttonNamed('Analyse picture')!);
    await flush(100);
    await click(buttonNamed('Cancel analysis')!);
    expect(client.cancelVision).toHaveBeenCalledWith('lvj_1');
    expect(host!.textContent).toMatch(/Cancelled\. A late answer is discarded\./);
  });

  it('a religious draft flags a picture with lettering or a logo and says a religious still cannot use it', async () => {
    const flagged = job({ observation: { ...OBS, containsText: true } });
    const client = doubleClient({ getVision: vi.fn(async () => flagged) });
    await mount(client, env({ profile: { contentProfile: 'religious' } }));
    await click(buttonNamed('Analyse picture')!);
    await flush(900);
    expect(q('[data-testid="picture-flag"]').textContent).toMatch(/lettering or a logo\. A religious still cannot use it as a reference\./);
  });

  it('conditioning: choose a reference picture and a strength, then save it as the server receives it', async () => {
    const client = doubleClient();
    const { onSaved } = await mount(client);
    const select = q<HTMLSelectElement>('select[aria-label="Conditioning picture"]');
    await act(async () => { select.value = 'pic-a'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    const range = q<HTMLInputElement>('input[aria-label="Conditioning strength"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '0.5');
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(buttonNamed('Use this picture to condition stills')!);
    expect(client.saveReview).toHaveBeenCalledWith('dft_1', { expectedRevision: 7, conditioning: { assetId: 'pic-a', strength: 0.5 } });
    expect(onSaved).toHaveBeenCalled();
  });

  it('a conditioning save refused by the server keeps the chosen picture and strength on screen', async () => {
    const client = doubleClient({ saveReview: vi.fn(async () => { throw new FactoryApiError({ message: 'Reference conditioning accepts PNG or JPEG pictures.', status: 422, code: 'FACTORY_VALIDATION', answered: true }); }) });
    await mount(client);
    const select = q<HTMLSelectElement>('select[aria-label="Conditioning picture"]');
    await act(async () => { select.value = 'pic-b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(buttonNamed('Use this picture to condition stills')!);
    expect(q('[data-testid="conditioning-controls"] [role="alert"]').textContent).toMatch(/PNG or JPEG/);
    expect(select.value).toBe('pic-b');
  });

  it('the saved conditioning is shown back from the draft, and the manual description field is not touched by this panel', async () => {
    const e = env({ intake: { visualRoles: { 'pic-a': 'style_reference' }, visualReview: {}, conditioning: { assetId: 'pic-a', strength: 0.7 } } });
    await mount(doubleClient(), e);
    expect(q('[data-testid="conditioning-line"]').textContent).toMatch(/strength 0\.70/);
    expect(host!.querySelector('textarea[aria-label="Manual description of Lamp photo"]')).toBeNull();
  });
});

// Manual approval: independent of the vision engine. LABELLED DOUBLE client; no provider, no vision server.
const LIB_SHA = 'b'.repeat(64);
const libPic = [{ id: 'pic-a', name: 'Lamp photo', source: 'Owner shoot 2026', license: 'Owner-owned, internal use', sha256: LIB_SHA }];
const DESC = 'Subject: a brass desk lamp; Environment: a wooden table; Lighting: soft window light; Composition: centred object; Shot: close-up';

describe('manual approval of a reference picture (DOM, labelled double)', () => {
  it('readiness is independent: with the vision engine NOT ready, the owner can still approve manually, and no analysis starts', async () => {
    const client = doubleClient({ visionStatus: vi.fn(async () => ({ ...READY, ready: false, missing: ['The local vision engine (VISION_MODEL_PATH) is not set.'] })) });
    await mount(client, env(), vi.fn(), libPic);
    expect(client.startVision).not.toHaveBeenCalled();
    const approve = buttonNamed('Approve this description manually')!;
    expect(approve.disabled).toBe(false);
    await typeInto(q<HTMLTextAreaElement>('textarea[aria-label="Approval description of Lamp photo"]'), `  ${DESC}  `);
    await click(approve);
    expect(client.saveReview).toHaveBeenCalledTimes(1);
    const body = (client.saveReview as any).mock.calls[0][1];
    expect(body.expectedRevision).toBe(7);
    expect(body.visualReview['pic-a']).toEqual({
      jobId: '', method: 'manual', state: 'reviewed', text: DESC, useInPrompts: true, sha256: LIB_SHA,
      flags: { containsText: false, containsLogoOrBrand: false, containsPeople: false },
      source: 'Owner shoot 2026', license: 'Owner-owned, internal use',
    });
    expect(client.startVision).not.toHaveBeenCalled();
  });

  it('the source and licence fields start from the library record, and the owner declares flags', async () => {
    const client = doubleClient();
    await mount(client, env(), vi.fn(), libPic);
    expect(q<HTMLInputElement>('input[aria-label="Source of Lamp photo"]').value).toBe('Owner shoot 2026');
    expect(q<HTMLInputElement>('input[aria-label="Licence of Lamp photo"]').value).toBe('Owner-owned, internal use');
    await act(async () => { q<HTMLInputElement>('input[aria-label="Lamp photo contains a logo or brand"]').click(); });
    await typeInto(q<HTMLTextAreaElement>('textarea[aria-label="Approval description of Lamp photo"]'), DESC);
    await click(buttonNamed('Approve this description manually')!);
    const rec = (client.saveReview as any).mock.calls[0][1].visualReview['pic-a'];
    expect(rec.flags).toEqual({ containsText: false, containsLogoOrBrand: true, containsPeople: false });
  });

  it('a refused manual approval keeps the typed text and shows the server reason; nothing is saved', async () => {
    const client = doubleClient({ saveReview: vi.fn(async () => { throw new FactoryApiError('FACTORY_VALIDATION', 'Confirm the source and licence exactly as the library records them.', 422); }) });
    const onSaved = vi.fn();
    await mount(client, env(), onSaved, libPic);
    await typeInto(q<HTMLTextAreaElement>('textarea[aria-label="Approval description of Lamp photo"]'), DESC);
    await click(buttonNamed('Approve this description manually')!);
    expect(q('[data-testid="manual-approval"]').textContent).toMatch(/Confirm the source and licence exactly/);
    expect(q<HTMLTextAreaElement>('textarea[aria-label="Approval description of Lamp photo"]').value).toBe(DESC);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a picture with no recorded hash cannot be approved, and the panel says so', async () => {
    await mount(doubleClient(), env(), vi.fn(), [{ id: 'pic-a', name: 'Lamp photo', source: 'x', license: 'y', sha256: null }]);
    expect(buttonNamed('Approve this description manually')!.disabled).toBe(true);
    expect(q('[data-testid="manual-approval"]').textContent).toMatch(/no recorded hash, so it cannot be approved yet/);
  });

  it('a manual approval is shown as manual in the review line', async () => {
    const e = env({ intake: { visualRoles: { 'pic-a': 'style_reference' }, visualReview: { 'pic-a': { jobId: '', method: 'manual', state: 'reviewed', text: DESC, useInPrompts: true, sha256: LIB_SHA, flags: { containsText: false, containsLogoOrBrand: false, containsPeople: false }, source: 'Owner shoot 2026', license: 'Owner-owned, internal use' } }, conditioning: null } });
    await mount(doubleClient(), e, vi.fn(), libPic);
    expect(q('[data-testid="review-line"]').textContent).toMatch(/Approved manually \(source and licence checked\)\. Used in stills\./);
  });
});
