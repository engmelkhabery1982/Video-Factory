/**
 * Derived rewrite panel. happy-dom component checks with a LABELLED client double
 * (test-only). No provider and no real HTTP. Not browser acceptance.
 */
// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DerivedRewritePanel } from '../../apps/web/src/components/plan/GeneratedDraftPanels';
import { FactoryApiError, type FactoryAiClient, type FactoryDraftEnvelope } from '../../apps/web/src/lib/factory-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
});

function envOf(over: Partial<FactoryDraftEnvelope> = {}): FactoryDraftEnvelope {
  return {
    draftId: 'dft_src', revision: 3, status: 'review_required', generationMode: 'local_rules', speechOrderLocked: false,
    selectedTreatmentId: 't1',
    treatments: [{
      id: 't1', title: 'Plain', rationale: '', orderLocked: false, structure: [],
      scenes: [
        { id: 'sc1', sourceUnitId: 'u1', narration: 'First supplied line.' },
        { id: 'sc2', sourceUnitId: 'u2', narration: 'Second supplied line.' },
      ],
    }],
    speakers: [], missing: [], warnings: [], appliedProjects: [], profile: { contentProfile: 'educational', format: 'landscape', channelBrandId: null },
    inputs: { audioAssetId: null, audioDurationSec: null, visualAssetIds: [], scriptSupplied: true, storyboardSupplied: false },
    derivedFrom: null, reviewedRevision: null,
    ...over,
  } as unknown as FactoryDraftEnvelope;
}

function doubleAi(overrides: Partial<FactoryAiClient> = {}) {
  return {
    deriveDraft: vi.fn(async () => envOf({ draftId: 'dft_new', revision: 0 })),
    reviewDerived: vi.fn(async () => envOf()),
    ...overrides,
  } as unknown as FactoryAiClient & { deriveDraft: ReturnType<typeof vi.fn>; reviewDerived: ReturnType<typeof vi.fn> };
}

async function render(env: FactoryDraftEnvelope, ai: FactoryAiClient, onAdopt = vi.fn(), onError = vi.fn()) {
  host = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<DerivedRewritePanel ai={ai} env={env} disabled={false} onAdopt={onAdopt} onError={onError} />);
  });
  return { host: host!, onAdopt, onError };
}

function setValue(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const submit = (h: HTMLElement) => h.querySelector('[data-testid="derive-submit"]') as HTMLButtonElement;

describe('derived rewrite: supplied narration', () => {
  it('the submit is disabled until a line actually changes', async () => {
    const { host: h } = await render(envOf(), doubleAi());
    expect(submit(h).disabled).toBe(true);
    expect(submit(h).textContent).toContain('0 lines changed');
    await act(async () => setValue(h.querySelector('[data-testid="derive-text-u1"]') as HTMLTextAreaElement, 'First supplied line.'));
    expect(submit(h).disabled).toBe(true);
  });

  it('sends only the changed line, with the revision that was read, and adopts the new draft', async () => {
    const ai = doubleAi();
    const { host: h, onAdopt } = await render(envOf(), ai);
    await act(async () => setValue(h.querySelector('[data-testid="derive-text-u2"]') as HTMLTextAreaElement, 'Second line, rewritten.'));
    expect(submit(h).textContent).toContain('1 line changed');
    await act(async () => submit(h).click());
    expect(ai.deriveDraft).toHaveBeenCalledWith('dft_src', { expectedRevision: 3, edits: [{ unitId: 'u2', narration: 'Second line, rewritten.' }] });
    expect(onAdopt).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'dft_new' }));
  });

  it('a refused derivation keeps the typed text in the form and derives nothing', async () => {
    const ai = doubleAi({
      deriveDraft: vi.fn(async () => { throw new FactoryApiError({ message: 'The draft changed since you loaded it.', status: 409, code: 'FACTORY_REVISION_CONFLICT', answered: true, currentRevision: 4 }); }) as never,
    });
    const { host: h, onAdopt, onError } = await render(envOf(), ai);
    const area = h.querySelector('[data-testid="derive-text-u1"]') as HTMLTextAreaElement;
    await act(async () => setValue(area, 'Typed rewrite that must survive.'));
    await act(async () => submit(h).click());
    expect(onError).toHaveBeenCalled();
    expect(onAdopt).not.toHaveBeenCalled();
    expect(area.value).toBe('Typed rewrite that must survive.');
  });
});

describe('derived rewrite: the derivative', () => {
  const derived = envOf({
    draftId: 'dft_new', revision: 0,
    derivedFrom: { draftId: 'dft_src', revision: 3, rootDraftId: 'dft_src', changes: [{ unitId: 'u2', before: 'Second supplied line.', after: 'Second line, rewritten.' }] },
    reviewedRevision: null,
  } as never);

  it('shows the before and after of each changed line and that the original is unchanged', async () => {
    const { host: h } = await render(derived, doubleAi());
    const changes = h.querySelector('[data-testid="derived-changes"]')!;
    expect(changes.textContent).toContain('Second supplied line.');
    expect(changes.textContent).toContain('Second line, rewritten.');
    expect(h.textContent).toContain('The original is unchanged.');
    expect(h.querySelector('[data-testid="derive-rewrite"]')).toBeNull();
  });

  it('review uses the revision that was read; the reviewed state then replaces the button', async () => {
    const ai = doubleAi({ reviewDerived: vi.fn(async () => envOf({ draftId: 'dft_new', revision: 0, derivedFrom: derived.derivedFrom, reviewedRevision: 0 } as never)) as never });
    const { host: h, onAdopt } = await render(derived, ai);
    await act(async () => (h.querySelector('[data-testid="derived-review"]') as HTMLButtonElement).click());
    expect(ai.reviewDerived).toHaveBeenCalledWith('dft_new', 0);
    expect(onAdopt).toHaveBeenCalledWith(expect.objectContaining({ reviewedRevision: 0 }));
  });
});
