// @vitest-environment happy-dom
/**
 * Storyboard cards and the post-create editor. DOM tests with a LABELLED DOUBLE for the save call (the real route
 * contract is tested through HTTP in tests/factory-storyboard-edit-http.test.ts). Not browser evidence.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PostCreateStoryboard, StoryboardCards } from '../../apps/web/src/components/factory/IntakePanels';
import { FactoryApiError } from '../../apps/web/src/lib/factory-api';
import {
  panelsFromStoryboard,
  panelsToStoryboard,
  parseSeconds,
  storyboardTimingProblems,
  timingChangedIds,
} from '../../apps/web/src/lib/factory-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
async function render(element: React.ReactElement, host: HTMLElement) {
  root = createRoot(host);
  await act(async () => root!.render(element));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
});

/** A storyboard document with every field the card model carries. */
const STORED = {
  version: 1 as const,
  scenes: [
    { id: 'p01', narration: 'First words.', speakerId: 'host', assetId: 'img-a', startSec: 0, endSec: 2.5, locked: true },
    { id: 'p02', narration: '', speakerId: null, assetId: 'img-b', startSec: 2.5, endSec: 6, locked: false },
    { id: 'p03', narration: 'Third.', speakerId: null, assetId: null, startSec: null, endSec: null, locked: false },
  ],
};

/** Set a React-controlled input the way a user does, then fire the change. */
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const q = <T extends Element>(host: ParentNode, selector: string): T => {
  const el = host.querySelector<T>(selector);
  if (!el) throw new Error(`no match for ${selector}`);
  return el;
};

describe('round-trip regression: every card field survives import and export', () => {
  it('a storyboard document exports to exactly the document it was imported from', () => {
    const cards = panelsFromStoryboard(STORED);
    expect(panelsToStoryboard(cards)).toEqual(STORED);
  });

  it('the export is stable across a second import and export', () => {
    const once = panelsToStoryboard(panelsFromStoryboard(STORED));
    const twice = panelsToStoryboard(panelsFromStoryboard(once));
    expect(twice).toEqual(once);
  });

  it('a card with no timing, speaker or lock exports the same defaults the server stores', () => {
    const cards = panelsFromStoryboard({ version: 1, scenes: [{ id: 'x1', narration: 'Words.' }] });
    expect(panelsToStoryboard(cards).scenes[0]).toEqual({ id: 'x1', narration: 'Words.', speakerId: null, assetId: null, startSec: null, endSec: null, locked: false });
  });

  it('Start and End seconds parse strictly: empty is no time, negatives and text are invalid', () => {
    expect(parseSeconds('')).toBeNull();
    expect(parseSeconds('2.5')).toBe(2.5);
    expect(parseSeconds('-1')).toBe('invalid');
    expect(parseSeconds('abc')).toBe('invalid');
  });

  it('client timing hints: both-or-neither, end after start, no overlap', () => {
    const cards = panelsFromStoryboard({ version: 1, scenes: [
      { id: 'a', startSec: 0, endSec: null },
      { id: 'b', startSec: 1, endSec: 1 },
      { id: 'c', startSec: 0.5, endSec: 3 },
    ] });
    const problems = storyboardTimingProblems(cards);
    expect(problems).toEqual(expect.arrayContaining([
      'Panel 1: set both Start and End, or neither.',
      'Panel 2: End must be after Start.',
      'Panel 3 starts before panel 2 ends.',
    ]));
    expect(storyboardTimingProblems(panelsFromStoryboard(STORED))).toEqual([]);
  });

  it('timing changes are listed per panel against the stored storyboard', () => {
    const cards = panelsFromStoryboard(STORED).map((p, i) => (i === 1 ? { ...p, endSec: 7 } : p));
    expect(timingChangedIds(cards, STORED.scenes)).toEqual(['p02']);
  });
});

describe('StoryboardCards: Start and End controls', () => {
  it('shows the stored seconds and writes a typed Start back through onChange', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = vi.fn();
    await render(<StoryboardCards panels={panelsFromStoryboard(STORED)} onChange={onChange} pictures={[{ id: 'img-a', name: 'A' }, { id: 'img-b', name: 'B' }]} />, host);
    const start = q<HTMLInputElement>(host, 'input[aria-label="Start seconds for panel 2"]');
    const end = q<HTMLInputElement>(host, 'input[aria-label="End seconds for panel 2"]');
    expect(start.value).toBe('2.5');
    expect(end.value).toBe('6');
    await typeInto(start, '3');
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0];
    expect(next[1].startSec).toBe(3);
    expect(next[0].locked).toBe(true);
    expect(next[0].speakerId).toBe('host');
  });

  it('a locked card says so', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await render(<StoryboardCards panels={panelsFromStoryboard(STORED)} onChange={() => {}} pictures={[]} />, host);
    expect(host.textContent).toMatch(/Locked: its words, picture and timing cannot change/);
  });
});

describe('PostCreateStoryboard: refusals keep every typed edit', () => {
  it('a stale revision (409) keeps the typed words and names the current revision', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onSave = vi.fn(async () => {
      throw new FactoryApiError({ message: 'The draft changed since you loaded it.', status: 409, code: 'FACTORY_REVISION_CONFLICT', answered: true, currentRevision: 9 });
    });
    await render(<PostCreateStoryboard storyboard={STORED} revision={4} busy={false} pictures={[]} onSave={onSave} />, host);
    await typeInto(q<HTMLTextAreaElement>(host, 'textarea[aria-label="Post-save words for panel 3"]'), 'Typed, not yet saved.');
    await act(async () => { q<HTMLButtonElement>(host, '[data-testid="post-create-save"]').click(); });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 4 }));
    expect(q(host, '[data-testid="post-create-error"]').textContent).toMatch(/\(now revision 9\)\. Your typed edits are kept/);
    expect(q<HTMLTextAreaElement>(host, 'textarea[aria-label="Post-save words for panel 3"]').value).toBe('Typed, not yet saved.');
  });

  it('a locked panel is read-only in the editor, so its words cannot be typed over', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await render(<PostCreateStoryboard storyboard={STORED} revision={4} busy={false} pictures={[]} onSave={vi.fn()} />, host);
    expect(q<HTMLTextAreaElement>(host, 'textarea[aria-label="Post-save words for panel 1"]').disabled).toBe(true);
    expect(q<HTMLInputElement>(host, 'input[aria-label="Post-save start for panel 1"]').disabled).toBe(true);
    expect(q<HTMLTextAreaElement>(host, 'textarea[aria-label="Post-save words for panel 2"]').disabled).toBe(false);
  });

  it('a timing change needs the confirmation before anything is sent', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onSave = vi.fn(async () => {});
    await render(<PostCreateStoryboard storyboard={STORED} revision={4} busy={false} pictures={[]} onSave={onSave} />, host);
    await typeInto(q<HTMLInputElement>(host, 'input[aria-label="Post-save end for panel 2"]'), '7');
    await act(async () => { q<HTMLButtonElement>(host, '[data-testid="post-create-save"]').click(); });
    expect(onSave).not.toHaveBeenCalled();
    expect(q(host, '[data-testid="post-create-error"]').textContent).toMatch(/These timings change: p02/);
    await act(async () => { q<HTMLInputElement>(host, 'input[aria-label="Confirm timing changes"]').click(); });
    await act(async () => { q<HTMLButtonElement>(host, '[data-testid="post-create-save"]').click(); });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 4, confirmTiming: true }));
  });

  it('a text conflict asks for an explicit authority, then sends it with the same edit', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onSave = vi.fn(async (body: { textAuthority?: string }) => {
      if (!body.textAuthority) throw new FactoryApiError({ message: 'conflict', status: 422, code: 'FACTORY_TEXT_CONFLICT', answered: true, details: { conflicts: [] } });
    });
    await render(<PostCreateStoryboard storyboard={STORED} revision={4} busy={false} pictures={[]} onSave={onSave} />, host);
    await typeInto(q<HTMLTextAreaElement>(host, 'textarea[aria-label="Post-save words for panel 3"]'), 'Differs from the script.');
    await act(async () => { q<HTMLButtonElement>(host, '[data-testid="post-create-save"]').click(); });
    expect(q(host, '[data-testid="post-create-error"]').textContent).toMatch(/Choose which text is authoritative/);
    await typeInto(q<HTMLSelectElement>(host, 'select[aria-label="Text authority"]'), 'transcript');
    await act(async () => { q<HTMLButtonElement>(host, 'button');
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Save with this authority')!.click(); });
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ textAuthority: 'transcript' }));
  });
});
