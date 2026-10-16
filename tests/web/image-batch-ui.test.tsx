// @vitest-environment happy-dom
/**
 * Ordered image batch in the DOM. LABELLED DOUBLE: the upload function stands in for POST /api/assets. The real route is
 * covered by tests/asset-image-batch-http.test.ts. Nothing here is browser evidence.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageBatchUpload } from '../../apps/web/src/components/factory/ImageBatchUpload';
import type { StoryboardPanelDraft } from '../../apps/web/src/lib/factory-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

function pick(files: File[]) {
  const input = host!.querySelector<HTMLInputElement>('input[aria-label="Pictures to add in order"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const btn = (testid: string) => host!.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!;

describe('ordered image batch (DOM, labelled double for the upload)', () => {
  it('uploads in order, shows a partial result, retries only the failed file, and carding adds each picture once', async () => {
    let call = 0;
    const upload = vi.fn(async (fd: FormData) => {
      call += 1;
      const name = (fd.get('file') as File).name;
      if (name === 'b.png' && call === 2) throw new Error('Upload refused: too large');
      return { asset: { id: `asset-${name.replace(/\.[^.]+$/, '')}`, sha256: 'd'.repeat(64) } };
    });
    const onCards = vi.fn();
    const onLibraryChanged = vi.fn(async () => {});
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const panels: StoryboardPanelDraft[] = [];
    const render = (ps: StoryboardPanelDraft[]) =>
      act(async () => {
        root!.render(<ImageBatchUpload source="Owner photo" license="Owner-owned" upload={upload} onLibraryChanged={onLibraryChanged} panels={ps} busy={false} onCards={onCards} />);
      });
    await render(panels);
    await flush();
    pick([new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.png', { type: 'image/png' }), new File(['c'], 'c.jpg', { type: 'image/jpeg' })]);
    await flush();
    // Order shown is the order uploaded.
    expect(host!.textContent).toContain('1. a.png');
    await act(async () => { btn('image-batch-upload').click(); });
    await flush();
    expect(upload.mock.calls.map((c) => (c[0].get('file') as File).name)).toEqual(['a.png', 'b.png', 'c.jpg']);
    // Partial: never "All … in the library".
    const summary = host!.querySelector('[data-testid="image-batch-summary"]')!.textContent!;
    expect(summary).toMatch(/2 of 3 in the library\. 1 failed/);
    expect(summary).not.toMatch(/^All/);
    expect(host!.textContent).toContain('Failed: Upload refused: too large');
    expect(onLibraryChanged).toHaveBeenCalled();

    // Retry: only b.png goes again. a.png and c.jpg are not uploaded a second time.
    upload.mockClear();
    await act(async () => { btn('image-batch-retry').click(); });
    await flush();
    expect(upload.mock.calls.map((c) => (c[0].get('file') as File).name)).toEqual(['b.png']);
    expect(host!.querySelector('[data-testid="image-batch-summary"]')!.textContent).toMatch(/All 3 pictures are in the library/);

    // Cards: one per final picture, in batch order. Upload again changes nothing; a second card click adds nothing.
    await act(async () => { btn('image-batch-cards').click(); });
    await flush();
    expect(onCards).toHaveBeenCalledTimes(1);
    const result = onCards.mock.calls[0][0];
    expect(result.carded).toEqual(['asset-a', 'asset-b', 'asset-c']);
    expect(result.panels.map((p: StoryboardPanelDraft) => p.assetId)).toEqual(['asset-a', 'asset-b', 'asset-c']);
    await render(result.panels);
    await flush();
    expect(host!.querySelector<HTMLButtonElement>('[data-testid="image-batch-cards"]')!.disabled).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('a reference is attached with its role and never becomes a card; a non-image is refused with a reason', async () => {
    const upload = vi.fn(async (fd: FormData) => ({ asset: { id: `asset-${(fd.get('file') as File).name.replace(/\.[^.]+$/, '')}` } }));
    const onCards = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ImageBatchUpload source="Owner" license="Owned" upload={upload} onLibraryChanged={async () => {}} panels={[]} busy={false} onCards={onCards} />);
    });
    pick([new File(['x'], 'brand-style.png', { type: 'image/png' }), new File(['y'], 'notes.pdf', { type: 'application/pdf' })]);
    await flush();
    expect(host!.querySelector('[data-testid="image-batch-refused"]')!.textContent).toMatch(/notes\.pdf: Not a PNG, JPEG, WebP or GIF/);
    const role = host!.querySelector<HTMLSelectElement>('select[aria-label="Role of brand-style.png"]')!;
    await act(async () => {
      role.value = 'style_reference';
      role.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { btn('image-batch-upload').click(); });
    await flush();
    // Only a reference is pending: the add button is still enabled, and it attaches the reference without making a card.
    expect(btn('image-batch-cards').disabled).toBe(false);
    expect(btn('image-batch-cards').textContent).toMatch(/attach 1 reference/);
    await act(async () => { btn('image-batch-cards').click(); });
    await flush();
    const result = onCards.mock.calls[0][0];
    expect(result.panels).toHaveLength(0);
    expect(result.references).toEqual([{ assetId: 'asset-brand-style', role: 'style_reference' }]);
    expect(result.attachIds).toEqual(['asset-brand-style']);
    expect(btn('image-batch-cards').disabled).toBe(true);
  });
});
