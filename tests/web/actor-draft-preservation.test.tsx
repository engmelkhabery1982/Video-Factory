// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GraphicValuesForm } from '../../apps/web/src/components/graphic/GraphicEditors';
import { proofActor } from '../fixtures/graphic-proof-specs';
import type { EditorGraphic } from '@buildtrack/core/visual';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; });
it('keeps unsaved actor pose/title when actions change, uses current actions on Apply, and blocks a concurrent object replacement', async () => {
  const initial = proofActor('landscape'); initial.actions = initial.actions.filter(a => a.endSec <= 3);
  const changed = vi.fn(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const draw = (g: EditorGraphic) => <GraphicValuesForm label="actor-draft" technique="actor_action" graphic={g} durationSec={3} format="landscape" profile="educational" onChange={changed}/>;
  await act(async () => root!.render(draw(initial)));
  const set = async (label: string, value: string) => act(async () => {
    const field = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const id = initial.objects.find(o => o.type === 'figure')!.id;
  await set('actor-draft title', 'Local unsaved actor title');
  await set(`actor-draft actor ${id} armAngle`, '');
  const actionOnly = structuredClone(initial); actionOnly.actions[0].id += '-edited';
  await act(async () => root!.render(draw(actionOnly)));
  expect(host.querySelector<HTMLInputElement>('[aria-label="actor-draft title"]')!.value).toBe('Local unsaved actor title');
  expect(host.querySelector<HTMLInputElement>(`[aria-label="actor-draft actor ${id} armAngle"]`)!.value).toBe('');
  await set(`actor-draft actor ${id} armAngle`, '12');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="apply-actor-actor-draft"]')!.click());
  expect(changed).toHaveBeenCalledOnce();
  const applied = changed.mock.calls[0][0] as EditorGraphic;
  expect(applied.actions).toEqual(actionOnly.actions);
  expect(applied.objects.find(o => o.id === id)!.armAngle).toBe(12);
  await act(async () => root!.render(draw(applied)));
  await set('actor-draft title', 'Second local draft'); changed.mockClear();
  const external = structuredClone(applied); external.objects.find(o => o.id === id)!.x = 0.4;
  await act(async () => root!.render(draw(external)));
  expect(host.querySelector<HTMLInputElement>('[aria-label="actor-draft title"]')!.value).toBe('Second local draft');
  expect(host.querySelector<HTMLButtonElement>('[data-testid="apply-actor-actor-draft"]')!.disabled).toBe(true);
  expect(host.textContent).toContain('local input is kept');
  await act(async () => root!.render(draw(applied)));
  expect(host.querySelector<HTMLButtonElement>('[data-testid="apply-actor-actor-draft"]')!.disabled).toBe(false);
  expect(host.querySelector<HTMLInputElement>('[aria-label="actor-draft title"]')!.value).toBe('Second local draft');
  await act(async () => root!.render(draw(external)));
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Use current shot values')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="apply-actor-actor-draft"]')!.click());
  expect(changed).toHaveBeenCalledOnce(); expect(changed.mock.calls[0][0]).toEqual(external);
});

