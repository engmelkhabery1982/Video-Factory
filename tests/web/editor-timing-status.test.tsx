// @vitest-environment happy-dom
/**
 * DOM test for the Editor's timing status card. `factoryApi.projectTiming` is
 * replaced by a spy (TEST DOUBLE). It checks fetch-on-mount, refetch on a
 * revision change, and that a failure shows an error rather than a stale label.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorTimingStatus } from '../../apps/web/src/components/editor/EditorTimingStatus';
import { factoryApi } from '../../apps/web/src/lib/factory-api';
import { timingStatusOf } from './fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount(el: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
  await flush();
}

async function rerender(el: React.ReactElement) {
  await act(async () => { root!.render(el); });
  await flush();
}

const text = () => host!.querySelector('[data-testid="editor-timing"]')?.textContent ?? '';

describe('Editor timing status card (round 3)', () => {
  it('fetches on mount and again when the document revision changes', async () => {
    const spy = vi.spyOn(factoryApi, 'projectTiming')
      .mockResolvedValueOnce(timingStatusOf({ editorRevision: 0 }))
      .mockResolvedValueOnce(timingStatusOf({ editorRevision: 1, status: 'edited', boundariesEdited: true, label: 'Timing edited after apply — the boundaries on screen no longer match the applied timing. Not verified by an alignment engine.', appliedLabel: 'Measured audio duration — not word alignment.' }));
    await mount(<EditorTimingStatus projectId="Factory_aaaaaaaaaaaa" revision={0} />);
    expect(text()).toContain('Measured audio duration — not word alignment.');
    expect(spy).toHaveBeenCalledTimes(1);
    await rerender(<EditorTimingStatus projectId="Factory_aaaaaaaaaaaa" revision={1} />);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith('Factory_aaaaaaaaaaaa');
    expect(text()).toMatch(/^Timing: Timing edited after apply/);
    expect(text()).toContain('Applied from apply: Measured audio duration — not word alignment.');
    expect(host!.querySelector('[data-testid="editor-timing"]')!.getAttribute('data-status')).toBe('edited');
  });

  it('shows an error, not a label, when the status cannot be loaded', async () => {
    vi.spyOn(factoryApi, 'projectTiming').mockRejectedValueOnce(new Error('network down'));
    await mount(<EditorTimingStatus projectId="Factory_aaaaaaaaaaaa" revision={0} />);
    expect(text()).toBe('Timing status could not be loaded.');
  });

  it('says a proposed alignment is not applied and never calls it accepted', async () => {
    vi.spyOn(factoryApi, 'projectTiming').mockResolvedValueOnce(timingStatusOf({ alignmentStatus: 'proposed' }));
    await mount(<EditorTimingStatus projectId="Factory_aaaaaaaaaaaa" revision={0} />);
    expect(text()).toContain('An alignment proposal is waiting for review. It is not applied to the timing.');
    expect(text()).not.toMatch(/accepted in review/);
  });
});
