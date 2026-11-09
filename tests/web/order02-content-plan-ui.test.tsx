// @vitest-environment happy-dom
/**
 * Page-level DOM evidence (happy-dom, not a real browser) that the Order 02 controls are reachable inside the
 * real ContentPlanPage: rule-based topic starter, video-audio policy on footage, PDF import into storyboard
 * cards, and the exact local planner gate. All API calls are LABELLED TEST DOUBLES (fixtures.ts). The real
 * contract is proved by the HTTP and parser suites; this proves the page wires the controls end to end.
 */
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContentPlanPage, type PlanDeps } from '../../apps/web/src/pages/ContentPlan';
import { envelopeOf, fakeClient } from './fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  window.history.replaceState(null, '', '/');
});

const q = <T extends Element = HTMLElement>(sel: string): T => {
  const el = (host ?? document.body).querySelector(sel) as T | null;
  if (!el) throw new Error(`not found: ${sel}`);
  return el;
};
const qa = (sel: string) => Array.from((host ?? document.body).querySelectorAll(sel)) as HTMLElement[];
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = async (sel: string) => { await act(async () => q(sel).click()); await flush(); };
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function pickFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function deps(client: ReturnType<typeof fakeClient>, extra: Partial<PlanDeps> = {}): PlanDeps {
  return {
    client,
    loadLibrary: async () => [
      { id: 'img-a', name: 'Owner image A', kind: 'screenshot', mimeType: 'image/png', status: 'active' },
      { id: 'vid-a', name: 'Site clip A', kind: 'broll', mimeType: 'video/mp4', status: 'active', hasAudio: true },
      { id: 'aud-1', name: 'Read narration', kind: 'sfx', mimeType: 'audio/wav', durationSec: 12.5, status: 'active' },
    ],
    uploadLibraryFile: async () => ({}),
    ai: {
      shotList: async () => ({ draftId: 'fixture-offline', revision: 0, scenes: [] }),
      aiStatus: async () => { throw new Error('LABELLED FAKE: no Gemini status in this DOM test'); },
    } as unknown as PlanDeps['ai'],
    images: {
      status: async () => ({ ready: false, missing: ['LABELLED FIXTURE: no local model in this DOM test'] }),
    } as unknown as PlanDeps['images'],
    ...extra,
  };
}

describe('ContentPlan page: Order 02 entry paths', () => {
  it('topic starter is reachable with no material and fills the brief, switching to the brief starting point', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);

    await click('[data-testid="topic-suggest"]');
    expect(qa('[data-testid="topic-item"]')).toHaveLength(3);
    await click('[data-testid="topic-use-topic-1"]');

    expect(q<HTMLInputElement>('input[placeholder="What this video is about"]').value).toBe('The one mistake beginners make with pumps');
    const briefRadio = qa('input[name="inputMode"]').find((r) => (r as HTMLInputElement).parentElement?.textContent?.includes('Brief')) as HTMLInputElement;
    expect(briefRadio.checked).toBe(true);
  });

  it('attaching footage reveals the video-audio policy and the chosen policy is sent on Create', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);

    // Before any footage is attached the policy control must not exist.
    expect(qa('[data-testid="video-audio-policy"]')).toHaveLength(0);

    const modes = qa('input[name="inputMode"]') as HTMLInputElement[];
    const videoMode = modes.find((r) => r.parentElement?.textContent?.toLowerCase().includes('video'))!;
    await act(async () => videoMode.click());
    await flush();
    const attach = qa('#attachments input[type="checkbox"], [data-testid="attachments"] input[type="checkbox"]')[0] as HTMLInputElement;
    await act(async () => attach.click());
    await flush();

    expect(qa('[data-testid="video-audio-policy"]')).toHaveLength(1);
    await click('[data-testid="video-audio-original"]');
    await act(async () => setValue(q<HTMLInputElement>('input[placeholder="What this video is about"]'), 'Site safety clip'));
    await click('[data-testid="create-draft"]');

    const create = client.calls.find((c) => c.name === 'createDraft');
    expect(create).toBeTruthy();
    const body = create!.args[0] as { inputs: { videoAudioPolicy: string; visualAssetIds: string[] } };
    expect(body.inputs.videoAudioPolicy).toBe('original');
    expect(body.inputs.visualAssetIds).toContain('vid-a');
  });

  it('PDF import fills the storyboard cards in page order, attaches the extracted picture and is sent on Create', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);

    pickFile(
      q<HTMLInputElement>('input[aria-label="PDF storyboard file"]'),
      new File(['%PDF-1.4 synthetic'], 'storyboard.pdf', { type: 'application/pdf' }),
    );
    await act(async () => setValue(q<HTMLInputElement>('input[aria-label="PDF source"]'), 'Synthetic fixture'));
    await act(async () => setValue(q<HTMLInputElement>('input[aria-label="PDF licence"]'), 'Test only'));
    await click('[data-testid="pdf-import-submit"]');

    expect(q('[data-testid="pdf-import-note"]').textContent).toContain('2 page(s)');
    const cardIds = qa('[data-testid="storyboard-card"] .mono').map((el) => el.textContent);
    expect(cardIds.some((t) => t?.includes('page-01'))).toBe(true);
    expect(cardIds.some((t) => t?.includes('page-02'))).toBe(true);

    await act(async () => setValue(q<HTMLInputElement>('input[placeholder="What this video is about"]'), 'PDF storyboard video'));
    await click('[data-testid="create-draft"]');

    const create = client.calls.find((c) => c.name === 'createDraft');
    const body = create!.args[0] as { inputs: { visualAssetIds: string[]; storyboard: { scenes: Array<{ id: string }> } | null } };
    expect(body.inputs.visualAssetIds).toContain('pic-1');
    expect(body.inputs.storyboard?.scenes.map((s) => s.id)).toEqual(['page-01', 'page-02']);
  });

  it('a reopened brief-only draft shows the exact local planner gate instead of a bare unavailable message', async () => {
    const client = fakeClient({
      getDraft: async () =>
        envelopeOf({
          status: 'blocked',
          selectedTreatmentId: null,
          treatments: [],
          missing: [{ kind: 'script', sceneId: null, reason: 'Supply a reviewed script or a storyboard.' }],
          plannerGate: {
            ready: false,
            route: 'local_llm',
            reason: 'Semantic planning is unavailable: LOCAL_LLM_ENABLED=1 is not set. Google is not used for planning.',
            missing: ['LOCAL_LLM_ENABLED=1 is not set'],
            model: null,
            license: null,
            endpoint: 'loopback only',
            googleUsed: false,
            pinnedModel: 'pinned-model',
            licenceMatchesPin: null,
          },
        }),
    });
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={() => {}} deps={deps(client)} />);
    const gate = q('[data-testid="planner-gate"]').textContent ?? '';
    expect(gate).toContain('LOCAL_LLM_ENABLED');
    expect(gate).toContain('Google used: false');
  });
});
