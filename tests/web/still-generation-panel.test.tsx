/**
 * Shot still panel. happy-dom component checks with a LABELLED client double (test-only).
 * No provider and no real HTTP. Not browser acceptance.
 *
 * Shows: no call on mount (status read only); the button needs the server's ready state AND
 * this shot's own confirmation; one click sends one call at the revision read; a refused or
 * failed call reports the error and keeps the confirmation the owner typed.
 */
// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StillGenerationPanel } from '../../apps/web/src/components/plan/GeneratedDraftPanels';
import {
  FactoryApiError,
  type FactoryAiClient,
  type FactoryDraftEnvelope,
  type VisualGenerationStatus,
} from '../../apps/web/src/lib/factory-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
});

function envOf(): FactoryDraftEnvelope {
  return {
    draftId: 'dft_still', revision: 7, status: 'review_required', selectedTreatmentId: 'T1',
    treatments: [{
      id: 'T1', title: 'Plain', rationale: '', orderLocked: false, structure: [],
      scenes: [
        { id: 'T1-L01', sourceUnitId: 'u1', narration: 'Line one.', shot: { assetNeed: 'existing_library', visualRequirement: 'library' } },
        { id: 'T1-L03', sourceUnitId: 'u3', narration: 'Line three.', shot: { assetNeed: 'image_needed', visualRequirement: 'a clean dashboard' } },
      ],
    }],
  } as unknown as FactoryDraftEnvelope;
}

function statusOf(over: Partial<VisualGenerationStatus> = {}): VisualGenerationStatus {
  return {
    ready: true, state: 'ready', reason: 'Ready. 4 paid still-image call(s) remain.', model: 'gemini-3.1-flash-image',
    endpoint: 'v1beta/models/gemini-3.1-flash-image:generateContent', freeTier: 'not_available', paidOnly: true,
    videoGeneration: 'not_implemented', budget: { limit: 4, used: 0, remaining: 4 }, ...over,
  };
}

function clientDouble(status: VisualGenerationStatus, generate?: () => Promise<unknown>) {
  const generateStill = vi.fn(generate ?? (async () => ({ ...envOf(), revision: 8, generated: { assetId: 'gen_x', model: 'm', budget: { limit: 4, used: 1, remaining: 3 } } })));
  const client = {
    visualGenerationStatus: vi.fn(async () => status),
    generateStill,
  } as unknown as FactoryAiClient;
  return { client, generateStill };
}

async function mount(ai: FactoryAiClient, onAdopt = vi.fn(), onError = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<StillGenerationPanel ai={ai} env={envOf()} disabled={false} onAdopt={onAdopt} onError={onError} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { onAdopt, onError };
}

const q = <T extends Element = HTMLElement>(sel: string) => host!.querySelector(sel) as T | null;
const btn = () => q<HTMLButtonElement>('[data-testid="generate-still-T1-L03"]')!;
const box = () => q<HTMLInputElement>('input[aria-label="Confirm one paid call for T1-L03"]')!;

async function tick(fn: () => void | Promise<void>) {
  await act(async () => { await fn(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('shot still panel (labelled client double, happy-dom)', () => {
  it('reads status on mount, sends nothing, and lists only the image shot', async () => {
    const { client, generateStill } = clientDouble(statusOf());
    await mount(client);
    expect(client.visualGenerationStatus).toHaveBeenCalled();
    expect(generateStill).not.toHaveBeenCalled();
    expect(q('[data-testid="still-shot-T1-L03"]')).toBeTruthy();
    expect(q('[data-testid="still-shot-T1-L01"]')).toBeNull();
    expect(q('[data-testid="still-status"]')!.textContent).toMatch(/Budget: 4 of 4 remaining/);
    expect(q('[data-testid="still-generation"]')!.textContent).toMatch(/not a screen recording/i);
  });

  it('the button needs both the server ready state and this shot\'s own confirmation', async () => {
    const { client } = clientDouble(statusOf());
    await mount(client);
    expect(btn().disabled).toBe(true);
    await tick(() => box().click());
    expect(btn().disabled).toBe(false);
  });

  it('a disabled server state keeps the button disabled even when confirmed', async () => {
    const { client } = clientDouble(statusOf({ ready: false, state: 'disabled', reason: 'Still-image generation is off.' }));
    await mount(client);
    await tick(() => box().click());
    expect(btn().disabled).toBe(true);
  });

  it('one click sends one call at the revision read, and adopts the envelope without the generated field', async () => {
    const { client, generateStill } = clientDouble(statusOf());
    const { onAdopt, onError } = await mount(client);
    await tick(() => box().click());
    await tick(() => btn().click());
    expect(generateStill).toHaveBeenCalledTimes(1);
    expect(generateStill).toHaveBeenCalledWith('dft_still', 'T1-L03', 7);
    expect(onAdopt).toHaveBeenCalledTimes(1);
    const adopted = onAdopt.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(adopted.generated).toBeUndefined();
    expect(adopted.revision).toBe(8);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a refused call (429 budget) reports the error, keeps the confirmation, and adopts nothing', async () => {
    const err = new FactoryApiError({ message: 'The still-image budget is used up for this session.', status: 429, code: 'FACTORY_BUDGET_EXHAUSTED' } as never);
    const { client, generateStill } = clientDouble(statusOf(), async () => { throw err; });
    const { onAdopt, onError } = await mount(client);
    await tick(() => box().click());
    await tick(() => btn().click());
    expect(generateStill).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
    expect(onAdopt).not.toHaveBeenCalled();
    expect(box().checked).toBe(true);
  });
});
