/**
 * Shot list panel: each shot shows its status, media type, source and licence, and the reason a
 * shot is not bound. happy-dom component check with a LABELLED client double (test-only).
 * No provider and no real HTTP. This is NOT browser acceptance.
 */
// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ShotListPanel } from '../../apps/web/src/components/plan/GeneratedDraftPanels';
import type { FactoryAiClient, FactoryDraftEnvelope, ShotList, ShotListScene } from '../../apps/web/src/lib/factory-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
});

const base = (over: Partial<ShotListScene>): ShotListScene => ({
  index: 0, sceneId: 'T1-L01', sourceUnitId: 'L01', narration: 'A line.', shotType: 'wide', why: 'Sets the scene.',
  assetNeed: 'existing_library', visualRequirement: 'Gate at dawn', boundAssetId: null, status: 'missing', reason: null,
  mediaType: null, source: null, license: null, prompt: null, screenRecordingBrief: null, ...over,
});

const list: ShotList = {
  draftId: 'dft_shots', revision: 4, format: 'landscape', aspect: '16:9', treatmentId: 'T1',
  scenes: [
    base({ index: 0, sceneId: 'T1-L01', status: 'bound', boundAssetId: 'fx-a', mediaType: 'image', source: 'Fixture source', license: 'Test fixture', reason: null }),
    base({
      index: 1, sceneId: 'T1-L02', sourceUnitId: 'L02', assetNeed: 'screen_recording_needed', status: 'incompatible',
      boundAssetId: 'fx-still', mediaType: 'image', source: 'Fixture source', license: 'Test fixture',
      reason: 'fx-still is a still image. A still is not a screen recording.',
    }),
    base({ index: 2, sceneId: 'T1-L03', sourceUnitId: 'L03', assetNeed: 'image_needed', status: 'changed', boundAssetId: 'fx-b', mediaType: 'image', source: 'Fixture source', license: 'Test fixture', reason: 'fx-b changed after it was bound.' }),
    base({ index: 3, sceneId: 'T1-L04', sourceUnitId: 'L04', assetNeed: 'image_needed', status: 'blocked', boundAssetId: 'fx-c', mediaType: null, source: 'Fixture source', license: null, reason: 'fx-c has no recorded source and licence.' }),
    base({ index: 4, sceneId: 'T1-L05', sourceUnitId: 'L05', assetNeed: 'screen_recording_needed', status: 'missing', prompt: null, screenRecordingBrief: 'Capture a real screen recording.' }),
  ],
};

const env = { draftId: 'dft_shots', revision: 4, status: 'blocked', missing: [], warnings: [], treatments: [], speakers: [], appliedProjects: [] } as unknown as FactoryDraftEnvelope;

async function render(shotList: ShotList) {
  const ai = { shotList: vi.fn(async () => shotList), shotListMarkdownUrl: () => '/md' } as unknown as FactoryAiClient;
  host = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ShotListPanel ai={ai} env={env} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host!;
}

describe('shot list panel (happy-dom, labelled client double)', () => {
  it('shows media type, source and licence for bound shots, and the status word for each shot', async () => {
    const h = await render(list);
    expect(h.querySelector('[data-testid="shot-T1-L01"]')?.textContent).toMatch(/bound/);
    const media = h.querySelector('[data-testid="shot-media-T1-L01"]')?.textContent ?? '';
    expect(media).toMatch(/image/);
    expect(media).toMatch(/Source: Fixture source/);
    expect(media).toMatch(/Licence: Test fixture/);
  });

  it('shows changed, incompatible and blocked shots with their reason, never as bound', async () => {
    const h = await render(list);
    const incompatible = h.querySelector('[data-testid="shot-T1-L02"]')?.textContent ?? '';
    expect(incompatible).toMatch(/incompatible/);
    expect(h.querySelector('[data-testid="shot-reason-T1-L02"]')?.textContent).toMatch(/still is not a screen recording/);
    expect(h.querySelector('[data-testid="shot-reason-T1-L03"]')?.textContent).toMatch(/changed after it was bound/);
    expect(h.querySelector('[data-testid="shot-reason-T1-L04"]')?.textContent).toMatch(/no recorded source and licence/);
    // The status cell (last column) reads the server status, never "bound".
    const statusCell = h.querySelector('[data-testid="shot-T1-L03"]')?.querySelectorAll('td');
    expect(statusCell?.[statusCell.length - 1].textContent).toMatch(/^changed/);
  });

  it('a missing recording shows a brief and no prompt; a missing still shows its label, never a generic card', async () => {
    const h = await render(list);
    const recording = h.querySelector('[data-testid="shot-T1-L05"]')?.textContent ?? '';
    expect(recording).toMatch(/Missing: screen recording/);
    expect(recording).toMatch(/Capture a real screen recording/);
    expect(h.querySelector('[data-testid="shot-media-T1-L05"]')?.textContent).not.toMatch(/Source:/);
  });
});
