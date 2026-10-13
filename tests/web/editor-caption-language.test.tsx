/**
 * Caption language and translation editing in the existing Editor caption panel.
 * happy-dom component checks. Not browser acceptance (the browser gate is blocked here).
 */
// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { selectCaptions, type EditorDocument as CoreDocument } from '@buildtrack/core';
import { EditorCaptionPanel } from '../../apps/web/src/components/editor/EditorTextPanels';
import { selectCaptionCues } from '../../apps/web/src/lib/editor-model';
import type { EditorDocument } from '../../apps/web/src/lib/editor-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
});

const spoken = (id: string, text: string, start: number, end: number) => ({
  id, startSec: start, endSec: end, text, language: 'ar', direction: 'rtl', fontSizePx: 44,
  position: { x: 0.5, y: 0.82 }, locked: false,
});

function docWith(extra: Partial<EditorDocument> = {}): EditorDocument {
  return {
    schemaVersion: 1, projectId: 'Caption_UI', revision: 4, contentProfile: 'religious', channelBrandId: null,
    targetId: 'long', format: 'landscape', durationSec: 10.5, assets: [], visualClips: [], audioClips: [],
    captions: [
      spoken('cap_c1', 'اتقوا الله في الجميع', 0, 4.5),
      spoken('cap_c2', 'وتنسى ما أعطيت', 4.5, 10.5),
      { id: 'tr_c1', cueOf: 'cap_c1', startSec: 0, endSec: 4.5, text: 'Fear God in all', language: 'en', direction: 'ltr', fontSizePx: 44, position: { x: 0.5, y: 0.82 }, locked: false },
    ],
    highlights: [], alignment: { status: 'not_requested' } as unknown as EditorDocument['alignment'],
    ...extra,
  } as unknown as EditorDocument;
}

async function render(doc: EditorDocument, selectedCaptionId: string | null, stage = vi.fn(() => [] as never[])) {
  host = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <EditorCaptionPanel document={doc} playhead={0} selectedCaptionId={selectedCaptionId} onSelectCaption={vi.fn()} stage={stage as never} disabled={false} />,
    );
  });
  return { host: host!, stage };
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

const button = (h: HTMLElement, text: string) => [...h.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

describe('caption language control', () => {
  it('defaults to spoken captions only and says translations are kept but not shown', async () => {
    const { host: h } = await render(docWith(), null);
    const select = h.querySelector('[data-testid="caption-language-control"] select') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(h.textContent).toContain('Spoken captions only. Translations are kept but not shown.');
  });

  it('choosing a language sends one setDocument operation with the code', async () => {
    const { host: h, stage } = await render(docWith(), null);
    const select = h.querySelector('[data-testid="caption-language-control"] select') as HTMLSelectElement;
    await act(async () => setValue(select, 'en'));
    expect(stage).toHaveBeenCalledWith([{ type: 'setDocument', changes: { captionLanguage: 'en' } }]);
  });

  it('lists a spoken cue with no translation in the selected language and does not fill it in', async () => {
    const { host: h } = await render(docWith({ captionLanguage: 'en' } as Partial<EditorDocument>), null);
    const alert = h.querySelector('[data-testid="caption-missing-translations"]');
    expect(alert?.textContent).toContain('cap_c2');
    expect(alert?.textContent).toContain('Nothing is filled in from the spoken text');
  });
});

describe('translation editing on a spoken cue', () => {
  it('adds a translation that copies the cue timing and sends the cue id as cueOf', async () => {
    const { host: h, stage } = await render(docWith(), 'cap_c2');
    const text = h.querySelector('[data-testid="translations"] input[placeholder="Translated text only"]') as HTMLInputElement;
    await act(async () => setValue(text, 'Forget not what you were given'));
    await act(async () => button(h, '+ Add translation').click());
    const [[ops]] = stage.mock.calls as unknown as Array<[Array<{ type: string; item: Record<string, unknown> }>]>;
    expect(ops[0].type).toBe('insert');
    expect(ops[0].item).toMatchObject({ cueOf: 'cap_c2', startSec: 4.5, endSec: 10.5, language: 'en', text: 'Forget not what you were given', locked: false });
  });

  it('editing translation text sends a text-only update and never a timing change', async () => {
    const { host: h, stage } = await render(docWith(), 'cap_c1');
    const area = h.querySelector('[data-testid="translation-text-tr_c1"]') as HTMLTextAreaElement;
    await act(async () => setValue(area, 'Be mindful of God'));
    expect(stage).toHaveBeenCalledWith([{ type: 'update', collection: 'captions', id: 'tr_c1', changes: { text: 'Be mindful of God' } }]);
    const ops = stage.mock.calls.at(-1)![0] as unknown as Array<{ changes: Record<string, unknown> }>;
    expect(Object.keys(ops[0].changes)).toEqual(['text']);
  });

  it('a translation shows its timing as read-only and offers no start or end inputs', async () => {
    const { host: h } = await render(docWith(), 'tr_c1');
    expect(h.querySelector('[data-testid="translation-timing"]')?.textContent).toContain('Timing follows spoken cue cap_c1');
    const labels = [...h.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels).not.toContain('Start');
    expect(labels).not.toContain('End');
  });
});

describe('web selection rule matches core', () => {
  it('the same cue selection for the same documents, including the missing list', () => {
    const doc = docWith();
    for (const language of [null, 'ar', 'en', 'fr']) {
      const web = selectCaptionCues(doc, language);
      const core = selectCaptions(doc as unknown as CoreDocument, language);
      expect(web.cues.map((c) => c.id)).toEqual(core.cues.map((c) => c.id));
      expect(web.missingTranslations).toEqual(core.missingTranslations);
    }
  });
});
