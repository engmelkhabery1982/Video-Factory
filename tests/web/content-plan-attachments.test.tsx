// @vitest-environment happy-dom
/**
 * DOM tests for the content-planning page. The API is replaced by TEST DOUBLES
 * (see fixtures.ts). These check page behaviour only. They are not evidence
 * that the live API, a render, or any generation works.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContentPlanPage, type PlanDeps } from '../../apps/web/src/pages/ContentPlan';
import { envelopeOf, apiError, fakeClient, CAPS, MEASURED_LABEL, timingStatusOf } from './fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
  await flush();
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  window.history.replaceState(null, '', '/');
});

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const q = <T extends Element = HTMLElement>(sel: string) => {
  const el = host!.querySelector(sel) as T | null;
  if (!el) throw new Error(`not found: ${sel}`);
  return el;
};
const qa = (sel: string) => Array.from(host!.querySelectorAll(sel)) as HTMLElement[];

function setValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
const change = (sel: string, value: string) => act(async () => setValue(q<HTMLSelectElement>(sel), value));
const type = (sel: string, value: string) => act(async () => setValue(q<HTMLInputElement>(sel), value));
const click = async (sel: string) => {
  await act(async () => q(sel).click());
  await flush();
};
const buttonByText = (text: string) => {
  const b = qa('button').find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button: ${text}`);
  return b;
};

function deps(client: ReturnType<typeof fakeClient>, extra: Partial<PlanDeps> = {}): PlanDeps {
  return {
    client,
    loadLibrary: async () => [
      { id: 'img-a', name: 'Owner image A', kind: 'screenshot', mimeType: 'image/png', status: 'active' },
      { id: 'vid-1', name: 'Owner clip one', kind: 'broll', mimeType: 'video/mp4', status: 'active' },
      { id: 'aud-1', name: 'Read narration', kind: 'sfx', mimeType: 'audio/wav', durationSec: 12.5, status: 'active' },
    ],
    uploadLibraryFile: async () => ({}),
    // Labelled fake: this suite covers the offline page. The Gemini status is never read here.
    ai: {
      shotList: async () => ({ draftId: 'fixture-offline', revision: 0, scenes: [] }),
      aiStatus: async () => {
        throw new Error('LABELLED FAKE: no Gemini status in the offline page suite');
      },
    } as unknown as PlanDeps['ai'],
    images: {
      status: async () => ({ ready: false, missing: ['LABELLED FIXTURE: no local model in this DOM test'] }),
    } as unknown as PlanDeps['images'],
    ...extra,
  };
}

const fillBriefAndScript = async () => {
  await type('input[placeholder="What this video is about"]', 'Concrete windows');
  await act(async () => setValue(q<HTMLTextAreaElement>('textarea'), 'Why does the pour fail? For example, a pour was booked for seven.'));
};


const createdBody = (client: ReturnType<typeof fakeClient>) => {
  const call = client.calls.find((c) => c.name === 'createDraft');
  return call ? (call.args[0] as Record<string, any>) : null;
};

const modeRadio = (index: number) => act(async () => qa('input[name="inputMode"]')[index].click());
const pictureBox = (name: string) => qa('[data-testid="attachments"] input[type="checkbox"]').find((el) => el.parentElement?.textContent?.includes(name)) as HTMLInputElement | undefined;

describe('attachments follow the input mode (no hidden selections)', () => {
  it('a picture attached for images is removed with a visible notice when the mode is video with narration', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await modeRadio(4); // Reviewed script with supplied pictures
    await act(async () => pictureBox('Owner image A')!.click());
    expect(q('[data-testid="attached-list"]').textContent).toContain('Owner image A');
    await modeRadio(5); // Video with narration accepts footage only
    expect(q('[data-testid="attachments"]').textContent).toContain('Removed Owner image A (image)');
    expect(q('[data-testid="attachments"]').textContent).toContain('Nothing attached.');
    expect(pictureBox('Owner image A')).toBeUndefined();
  });

  it('a clip kept for a mode that accepts it is sent exactly as shown, and nothing else is sent', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await modeRadio(5);
    await act(async () => pictureBox('Owner clip one')!.click());
    await modeRadio(1); // Reviewed script accepts pictures and clips
    expect(q('[data-testid="attached-list"]').textContent).toContain('Owner clip one');
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    expect(createdBody(client)!.inputs.visualAssetIds).toEqual(['vid-1']);
  });

  it('brief plus references sends the references explicitly and never a hidden selection', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await modeRadio(0); // Brief only
    await type('input[placeholder="What this video is about"]', 'Concrete windows');
    await act(async () => pictureBox('Owner image A')!.click());
    await click('[data-testid="create-draft"]');
    const body = createdBody(client)!;
    expect(body.inputs.visualAssetIds).toEqual(['img-a']);
    expect(body.inputs.script).toBeNull();
  });

  it('the create body carries the profile default visual language, and a change of profile re-selects that default', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await fillBriefAndScript();
    await act(async () => setValue(qa('select').find((s) => s.querySelector('option[value="promotional"]'))! as HTMLSelectElement, 'promotional'));
    expect(q<HTMLSelectElement>('[data-testid="create-visual-language"] select').value).toBe('mixed');
    await click('[data-testid="create-draft"]');
    expect(createdBody(client)!.visualLanguage).toBe('mixed');
  });

  it('a legacy choice of no language sends null and never a silent default', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await fillBriefAndScript();
    await act(async () => setValue(q<HTMLSelectElement>('[data-testid="create-visual-language"] select'), ''));
    await click('[data-testid="create-draft"]');
    expect(createdBody(client)!.visualLanguage).toBeNull();
  });
});
