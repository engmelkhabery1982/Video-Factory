// @vitest-environment happy-dom
/** KINETIC-VALUES01: inspector DOM only. Not a browser, renderer or owner acceptance. */
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { EditorGraphic } from '@buildtrack/core/visual';
import { buildKineticGraphic } from '../../apps/web/src/lib/graphic-form';
import { GraphicValuesForm } from '../../apps/web/src/components/graphic/GraphicEditors';
import { authoredKinetic } from '../helpers/kinetic-values-cases';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null; let host: HTMLDivElement | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; });
async function inspector(initial: EditorGraphic | null, format: 'landscape' | 'portrait') {
  const changed = vi.fn((_value: EditorGraphic | null) => {});
  function ControlledInspector() {
    const [graphic, setGraphic] = useState(initial);
    return <GraphicValuesForm technique="kinetic_text" graphic={graphic} format={format} durationSec={3} profile="educational"
      label="kinetic-qa" onChange={(value) => { changed(value); setGraphic(value); }} />;
  }
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<ControlledInspector />));
  return changed;
}
async function input(name: string, value: string) {
  await act(async () => {
    const field = host!.querySelector<HTMLInputElement>(`[aria-label="kinetic-qa ${name}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const apply = async () => { await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="apply-values-kinetic-qa"]')!.click()); };
async function removeWord(index: number) {
  await act(async () => host!.querySelector(`[aria-label="kinetic-qa word ${index}"]`)!.closest('.row')!.querySelector<HTMLButtonElement>('button')!.click());
}
async function addWord() {
  await act(async () => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Add word or phrase')!.click());
}

for (const format of ['landscape', 'portrait'] as const) for (const direction of ['ltr', 'rtl'] as const) for (const animated of [false, true]) {
  it(`${format}/${direction}/${animated ? 'supplied' : 'empty'} actions: unchanged/repeated Apply and one phrase edit preserve exact authored data`, async () => {
    const graphic = authoredKinetic(direction, animated); const original = JSON.stringify(graphic);
    const changed = await inspector(graphic, format);
    expect(host!.querySelector<HTMLInputElement>('[aria-label="kinetic-qa word 2"]')!.value).toBe(graphic.objects[1].text);
    await apply(); await apply();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(changed.mock.calls.at(-1)![0])).toBe(original);
    const text = '  تَغْيير!  Exact\u00a0text.  '; await input('word 2', text); await apply();
    expect(JSON.stringify(changed.mock.calls.at(-1)![0])).toBe(JSON.stringify({ ...graphic, objects: graphic.objects.map((o, i) => i === 1 ? { ...o, text } : o) }));
    expect(host!.querySelector('[role="alert"]')).toBeNull(); expect(JSON.stringify(graphic)).toBe(original);
  });
}

it.each([null, '', '  Original title!  '])('retains title %s on unchanged Apply; explicit title edit changes no other field', async (title) => {
  const graphic = authoredKinetic('rtl', false); graphic.title = title;
  const changed = await inspector(graphic, 'portrait'); await apply();
  expect(JSON.stringify(changed.mock.calls.at(-1)![0])).toBe(JSON.stringify(graphic));
  await input('title', '  عُنوان جديد!  '); await apply();
  expect(JSON.stringify(changed.mock.calls.at(-1)![0])).toBe(JSON.stringify({ ...graphic, title: '  عُنوان جديد!  ' }));
});

it.each(['landscape', 'portrait'] as const)('%s: middle removal/new addition preserves survivors and newly assigned IDs across Apply without remount', async (format) => {
  const graphic = authoredKinetic('rtl'); const changed = await inspector(graphic, format);
  await removeWord(2); await addWord(); await input('word 3', '  Added phrase!  '); await apply();
  expect(changed).toHaveBeenCalledTimes(1);
  const saved = changed.mock.calls[0][0]!;
  expect(saved.objects.slice(0, 2)).toEqual([graphic.objects[0], graphic.objects[2]]);
  expect(saved.objects[2]).toMatchObject({ id: 'word4', text: '  Added phrase!  ' });
  expect(saved.actions).toEqual(graphic.actions);
  await apply(); expect(changed).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(changed.mock.calls[1][0])).toBe(JSON.stringify(saved));
});

it('removing a linked phrase and adding another is visibly refused without dropping/retargeting actions', async () => {
  const graphic = authoredKinetic('rtl');
  graphic.actions.unshift({ id: 'middle-hold', targetId: 'word2', property: 'opacity', from: 0.88, to: 0.88, startSec: 0, endSec: 3, easing: 'hold' });
  const original = JSON.stringify(graphic); const changed = await inspector(graphic, 'portrait');
  await removeWord(2); await addWord(); await input('word 3', 'Replacement'); await apply();
  expect(changed).not.toHaveBeenCalled();
  expect([...host!.querySelectorAll('[role="alert"]')].map((e) => e.textContent).join(' ')).toMatch(/does not exist.*word2/);
  expect(JSON.stringify(graphic)).toBe(original);
});

it('new graphics keep builder defaults and become stable on the next Apply in the same mounted form', async () => {
  const changed = await inspector(null, 'portrait');
  await input('title', '  New title  '); await input('word 1', '  New phrase  '); await apply();
  const expected = buildKineticGraphic({ title: '  New title  ', items: ['  New phrase  '] }, 'portrait', 3);
  expect(JSON.stringify(changed.mock.calls.at(-1)![0])).toBe(JSON.stringify(expected));
  await apply(); expect(JSON.stringify(changed.mock.calls.at(-1)![0])).toBe(JSON.stringify(expected));
});
