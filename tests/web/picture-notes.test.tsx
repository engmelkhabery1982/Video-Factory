// @vitest-environment happy-dom
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PictureRoles } from '../../apps/web/src/components/factory/IntakePanels';
import { buildCreateBody, EMPTY_PLAN_FORM } from '../../apps/web/src/lib/factory-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('manual picture descriptions (typed by the owner, never generated)', () => {
  it('the description field is labelled manual and sends the typed text to the page', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onNotesChange = vi.fn();
    await act(async () => {
      root!.render(<PictureRoles pictures={[{ id: 'pic-a', name: 'Pump photo' }]} roles={{}} onChange={() => {}} notes={{}} onNotesChange={onNotesChange} />);
    });
    expect(host!.textContent).toMatch(/Your description of this picture \(manual, optional\)\. It is written by you, never generated/);
    expect(host!.querySelector('[data-testid="vision-note"]')!.textContent).toMatch(/Automatic description of pictures is unavailable/);
    expect(host!.querySelector('[data-testid="conditioning-note"]')!.textContent).toMatch(/Reference-conditioned generation is unavailable.*does not condition any generated image/);
    const field = host!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Manual description of Pump photo"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'A grey pump on a white base.');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onNotesChange).toHaveBeenCalledWith({ 'pic-a': 'A grey pump on a white base.' });
  });

  it('Create sends a description only for an attached picture; an empty or unattached one is not sent', () => {
    const form = {
      ...EMPTY_PLAN_FORM,
      brief: 'A brief.',
      visualAssetIds: ['pic-a'],
      visualNotes: { 'pic-a': '  A grey pump.  ', 'pic-gone': 'Not attached.', 'pic-b': '' },
    };
    const body = buildCreateBody(form, null);
    expect(body.inputs.visualNotes).toEqual({ 'pic-a': '  A grey pump.  ' });
  });
});
