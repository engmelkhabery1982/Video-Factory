// @vitest-environment happy-dom
/**
 * ContentPlan controls for visual language, per-shot technique and graphic values.
 * DOM tests through the real page and the real save call (fake client records the request).
 * Fixture data only. These are DOM tests, not browser acceptance.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContentPlanPage, type PlanDeps } from '../../apps/web/src/pages/ContentPlan';
import { envelopeOf, fakeClient } from './fixtures';
import type { FactoryDraftEnvelope } from '../../apps/web/src/lib/factory-api';

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

function deps(client: ReturnType<typeof fakeClient>): PlanDeps {
  return {
    client,
    loadLibrary: async () => [],
    uploadLibraryFile: async () => ({}),
    ai: {
      aiStatus: async () => { throw new Error('LABELLED FAKE: no Gemini status in this suite'); },
      // LABELLED FAKE: an empty shot list. LocalImagePanel reads it on mount; no generation is called.
      shotList: async () => ({ draftId: 'labelled-fake', revision: 1, scenes: [] }),
    } as unknown as PlanDeps['ai'],
  };
}

/** A saved draft whose selected treatment has one timed shot (0–10 s) and a language set. */
function savedDraft(over: Partial<FactoryDraftEnvelope> = {}): { env: FactoryDraftEnvelope; first: string } {
  const env = envelopeOf({ revision: 7, visualLanguage: 'motion_explainer', ...over });
  const selectedId = env.selectedTreatmentId as string;
  env.treatments = env.treatments.map((t) => (t.id === selectedId
    ? { ...t, scenes: t.scenes.map((s, i) => (i === 0 ? { ...s, startSec: 0, endSec: 10, assetId: null } : s)) }
    : t));
  const first = env.treatments.find((t) => t.id === selectedId)!.scenes[0].id;
  return { env, first };
}

describe('visual language and technique controls', () => {
  it('offers only the techniques the saved language allows, and disables the others with a reason', async () => {
    const { env, first } = savedDraft();
    const client = fakeClient({ getDraft: (async () => env) as never });
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={() => {}} deps={deps(client)} />);
    expect(q<HTMLSelectElement>('select[aria-label="Visual language"]').value).toBe('motion_explainer');
    const options = Array.from(q<HTMLSelectElement>(`select[aria-label="Technique for ${first}"]`).options);
    const screen = options.find((o) => o.value === 'screen_recording')!;
    expect(screen.disabled).toBe(true);
    expect(screen.textContent).toMatch(/not in this language/);
    const numeric = options.find((o) => o.value === 'numeric_comparison')!;
    expect(numeric.disabled).toBe(false);
  });

  it('shows the server readiness for the saved shot, and says so when edits are not yet judged', async () => {
    const { env, first } = savedDraft();
    env.visualReadiness = [{ sceneId: first, technique: 'numeric_comparison', state: 'needs_values', reason: 'Numeric comparison needs supplied values (labels, numbers or steps) before Apply.' }];
    env.treatments = env.treatments.map((t) => ({ ...t, scenes: t.scenes.map((s) => (s.id === first ? { ...s, technique: 'numeric_comparison' as const, graphic: null } : s)) }));
    const client = fakeClient({ getDraft: (async () => env) as never });
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={() => {}} deps={deps(client)} />);
    expect(q(`[data-testid="readiness-${first}"]`).textContent).toMatch(/Needs values/);
  });

  it('a language change is saved only by its own explicit button, and sends that language on the request', async () => {
    const { env } = savedDraft();
    const patchDraft = vi.fn(async () => ({ ...env, revision: 8 }));
    const client = fakeClient({ getDraft: (async () => env) as never, patchDraft: patchDraft as never });
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={() => {}} deps={deps(client)} />);
    expect(patchDraft).not.toHaveBeenCalled();
    await change('select[aria-label="Visual language"]', 'kinetic_typography');
    expect(patchDraft).not.toHaveBeenCalled();
    await click('[data-testid="save-language"]');
    expect(patchDraft).toHaveBeenCalledTimes(1);
    expect((patchDraft.mock.calls[0] as unknown[])[1]).toMatchObject({ visualLanguage: 'kinetic_typography', expectedRevision: 7 });
  });
});

describe('graphic values and timed actions on a shot', () => {
  it('typed numeric values, with the exact text the owner typed, are saved in the selection request', async () => {
    const { env, first } = savedDraft();
    const patchDraft = vi.fn(async () => ({ ...env, revision: 8 }));
    const client = fakeClient({ getDraft: (async () => env) as never, patchDraft: patchDraft as never });
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={() => {}} deps={deps(client)} />);
    await change(`select[aria-label="Technique for ${first}"]`, 'numeric_comparison');
    await type(`input[aria-label="${first} scale maximum"]`, '10');
    await type(`input[aria-label="${first} value 1 label"]`, 'Booked');
    await type(`input[aria-label="${first} value 1 number"]`, '7.0');
    await type(`input[aria-label="${first} value 2 label"]`, 'Arrived');
    await type(`input[aria-label="${first} value 2 number"]`, '9.50');
    await click(`[data-testid="apply-values-${first}"]`);
    expect(q(`[data-testid="graphic-shot-${first}"]`).textContent).toMatch(/Timed actions/);
    await click('[data-testid="save-selection"]');
    expect(patchDraft).toHaveBeenCalledTimes(1);
    const body = (patchDraft.mock.calls[0] as unknown[])[1] as { scenes: Array<{ id: string; technique?: string; graphic?: { kind: string; scaleMax: number; objects: Array<{ value?: number; decimals?: number; label?: string }> } }> };
    const scene = body.scenes.find((s) => s.id === first)!;
    expect(scene.technique).toBe('numeric_comparison');
    expect(scene.graphic!.kind).toBe('numeric_comparison');
    expect(scene.graphic!.scaleMax).toBe(10);
    expect(scene.graphic!.objects.filter((o) => o.label !== undefined).map((o) => [o.label, o.value, o.decimals])).toEqual([
      ['Booked', 7, 1],
      ['Arrived', 9.5, 2],
    ]);
  });

  it('incomplete values are shown as reasons and nothing graphic is sent (negative)', async () => {
    const { env, first } = savedDraft();
    const patchDraft = vi.fn(async () => ({ ...env, revision: 8 }));
    const client = fakeClient({ getDraft: (async () => env) as never, patchDraft: patchDraft as never });
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={() => {}} deps={deps(client)} />);
    await change(`select[aria-label="Technique for ${first}"]`, 'numeric_comparison');
    await click(`[data-testid="apply-values-${first}"]`);
    expect(q(`[data-testid="graphic-shot-${first}"]`).textContent).toMatch(/Value 1 needs a label/);
    await click('[data-testid="save-selection"]');
    const body = (patchDraft.mock.calls[0] as unknown[])[1] as { scenes: Array<{ id: string; graphic?: unknown }> };
    expect(body.scenes.find((s) => s.id === first)!.graphic).toBeUndefined();
  });

  it('a timed action can be edited on the shot and its new time is saved', async () => {
    const { env, first } = savedDraft();
    const patchDraft = vi.fn(async () => ({ ...env, revision: 8 }));
    const client = fakeClient({ getDraft: (async () => env) as never, patchDraft: patchDraft as never });
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={() => {}} deps={deps(client)} />);
    await change(`select[aria-label="Technique for ${first}"]`, 'kinetic_text');
    await type(`input[aria-label="${first} word 1"]`, 'Patience');
    await click(`[data-testid="apply-values-${first}"]`);
    const actionId = qa(`[data-testid^="action-${first}-"]`)[0].getAttribute('data-testid')!.replace(`action-${first}-`, '');
    await type(`input[aria-label="${first} action ${actionId} start"]`, '2.5');
    await click('[data-testid="save-selection"]');
    const body = (patchDraft.mock.calls[0] as unknown[])[1] as { scenes: Array<{ id: string; graphic?: { actions: Array<{ id: string; startSec: number }> } }> };
    const scene = body.scenes.find((s) => s.id === first)!;
    expect(scene.graphic!.actions.find((a) => a.id === actionId)!.startSec).toBe(2.5);
  });

  it('a graphic technique on a shot with no timing offers no values (negative)', async () => {
    const { env, first } = savedDraft();
    env.treatments = env.treatments.map((t) => ({ ...t, scenes: t.scenes.map((s) => (s.id === first ? { ...s, startSec: null, endSec: null } : s)) }));
    const client = fakeClient({ getDraft: (async () => env) as never });
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={() => {}} deps={deps(client)} />);
    await change(`select[aria-label="Technique for ${first}"]`, 'numeric_comparison');
    expect(q(`[data-testid="graphic-shot-${first}"]`).textContent).toMatch(/no timing yet/);
    expect(qa(`[data-testid="values-${first}"]`)).toHaveLength(0);
  });

  it('changing the technique clears graphic values of another kind, and says so', async () => {
    const { env, first } = savedDraft();
    const seeded = { schemaVersion: 1, kind: 'kinetic_text', title: null, background: '#14202b', textColor: '#f2f5f7', accent: '#f2b84b', direction: 'ltr', scaleMax: null, objects: [{ id: 'word1', type: 'word', x: 0.5, y: 0.3, text: 'Patience', emphasis: 'strong', size: 0.1 }], actions: [] };
    const kineticEnv = { ...env, treatments: env.treatments.map((t) => ({ ...t, scenes: t.scenes.map((s) => (s.id === first ? { ...s, technique: 'kinetic_text' as const, graphic: seeded as never } : s)) })) };
    const client = fakeClient({ getDraft: (async () => kineticEnv) as never });
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={() => {}} deps={deps(client)} />);
    await change(`select[aria-label="Technique for ${first}"]`, 'process_path');
    expect(q('[data-testid="content-plan"]').textContent).toMatch(/graphic values on this shot were cleared/);
  });
});
