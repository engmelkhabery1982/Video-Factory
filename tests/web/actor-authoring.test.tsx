// @vitest-environment happy-dom
/** VF-20261104-ACTOR01: actual inspector/form controls and local staging. DOM, not a real browser or HTTP save. */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateGraphic, type EditorGraphic } from '@buildtrack/core/visual';
import { EditorClipInspector } from '../../apps/web/src/components/editor/EditorClipInspector';
import { GraphicValuesForm } from '../../apps/web/src/components/graphic/GraphicEditors';
import { fixtureDocument } from '../../apps/web/src/lib/editor-fixture';
import { localApply, operationFindings } from '../../apps/web/src/lib/editor-model';
import type { EditorDocument, EditorOperation } from '../../apps/web/src/lib/editor-types';
import { emptyActorGraphic, newActorObject } from '../../apps/web/src/lib/actor-form';
import { proofActor } from '../fixtures/graphic-proof-specs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; });
async function mount(element: React.ReactNode) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(element));
}
function q<T extends HTMLElement>(selector: string): T {
  const found = host.querySelector<T>(selector); expect(found, selector).not.toBeNull(); return found!;
}
async function input(label: string, value: string) {
  await act(async () => {
    const field = q<HTMLInputElement>(`input[aria-label="${label}"]`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function select(label: string, value: string) {
  await act(async () => { const field = q<HTMLSelectElement>(`select[aria-label="${label}"]`); field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text); expect(button, text).toBeTruthy();
  await act(async () => button!.click());
}
async function clickSelector(selector: string) { await act(async () => q<HTMLButtonElement>(selector).click()); }
function blankDocument() {
  return { ...fixtureDocument('actor-qa', 'long'), visualLanguage: null };
}
function suppliedActor(graphic: EditorGraphic): EditorDocument {
  const doc = blankDocument();
  return { ...doc, visualClips: doc.visualClips.map((clip) => clip.id === 'vc_01' ? { ...clip, technique: 'actor_action', graphic, sourceAssetId: null, sourceInSec: null, sourceOutSec: null } : clip) };
}
function twoObjects() {
  const graphic = emptyActorGraphic();
  graphic.objects.push(newActorObject(graphic, 'figure'), newActorObject(graphic, 'box'));
  return graphic;
}
async function inspector(initial: EditorDocument, disabled = false) {
  let current = initial;
  const staged: EditorOperation[][] = [];
  const Harness = () => {
    const [doc, setDoc] = React.useState(initial);
    return <EditorClipInspector document={doc} selectedClipId="vc_01" playhead={0} disabled={disabled}
      onSelectClip={() => {}} onAssign={() => {}} onAddClip={() => {}} stage={(ops) => {
        const findings = ops.flatMap((op) => operationFindings(doc, op));
        if (!findings.length) { staged.push(ops); current = localApply(doc, ops); setDoc(current); }
        return findings;
      }} />;
  };
  await mount(<Harness />);
  return { document: () => current, graphic: () => current.visualClips[0].graphic!, staged };
}

const label = 'clip-vc_01';
const apply = () => clickSelector(`[data-testid="apply-actor-${label}"]`);
const field = (id: string, key: string) => `${label} actor ${id} ${key}`;
const action = (key: string, id = 'action-1') => `${label} action ${id} ${key}`;

describe('bounded actor authoring (DOM)', () => {
  it('gives added figures and boxes distinct safe starting positions without moving earlier objects', () => {
    const graphic = emptyActorGraphic();
    for (const type of ['figure', 'box', 'figure', 'figure', 'box', 'box', 'box', 'box', 'box'] as const) {
      const previous = structuredClone(graphic.objects);
      graphic.objects.push(newActorObject(graphic, type));
      expect(graphic.objects.slice(0, -1)).toEqual(previous);
    }
    expect(new Set(graphic.objects.map((o) => `${o.x},${o.y}`)).size).toBe(9);
    expect(graphic.objects[0]).toMatchObject({ x: 0.3, y: 0.6 });
    expect(graphic.objects[1]).toMatchObject({ x: 0.65, y: 0.6 });
    expect(graphic.actions).toEqual([]);
    for (const format of ['landscape', 'portrait'] as const) {
      expect(validateGraphic(graphic, { durationSec: 3, format, contentProfile: 'educational' })).toEqual([]);
    }
  });
  it('selects actor with no graphic, creates figure + box, edits values and explicitly adds an action without changing clip/audio/caption timing', async () => {
    const before = blankDocument();
    const h = await inspector(before);
    await select('Clip technique', 'actor_action');
    expect(h.staged).toHaveLength(0);
    expect(host.textContent).toContain('Incomplete actor graphic');
    await apply();
    expect(h.staged).toHaveLength(0);
    await click('Add box'); await apply();
    expect(h.staged).toHaveLength(0); // Boxes alone do not satisfy the canonical minimum.
    expect(host.textContent).toContain('needs 1 to 3 figure');
    await click('Add figure');
    await input(`${label} title`, 'Move the kit');
    await input(field('box-1', 'label'), 'Crew kit');
    await input(field('box-1', 'color'), '#00aa66');
    await input(field('box-1', 'w'), '0.18');
    await input(field('box-1', 'h'), '0.14');
    await input(field('box-1', 'rotation'), '12');
    await input(field('figure-1', 'x'), '0.27');
    await input(field('figure-1', 'y'), '0.62');
    await input(field('figure-1', 'scale'), '1.1');
    await input(field('figure-1', 'armAngle'), '15');
    await apply();
    expect(h.staged).toHaveLength(1);
    expect(h.staged[0][0]).toMatchObject({ type: 'update', collection: 'visualClips', id: 'vc_01', changes: { sourceAssetId: null, sourceInSec: null, sourceOutSec: null, technique: 'actor_action' } });
    expect(h.graphic().objects).toEqual([
      expect.objectContaining({ id: 'box-1', label: 'Crew kit', color: '#00aa66', w: 0.18, h: 0.14, rotation: 12 }),
      expect.objectContaining({ id: 'figure-1', x: 0.27, y: 0.62, scale: 1.1, armAngle: 15 }),
    ]);
    expect(h.graphic().actions).toEqual([]); // No auto-generated actor movement.
    await click('Add timed action');
    expect(validateGraphic(h.graphic(), { durationSec: 12, format: 'landscape', contentProfile: 'educational' })).toEqual([]);
    await select(action('target'), 'figure-1');
    await select(action('property'), 'armAngle');
    await input(action('from'), '15'); await input(action('to'), '70');
    await input(action('end'), '2'); await input(action('start'), '0.25');
    await select(action('easing'), 'ease_in_out');
    const savedAction = { id: 'action-1', targetId: 'figure-1', property: 'armAngle', from: 15, to: 70, startSec: 0.25, endSec: 2, easing: 'ease_in_out' };
    expect(h.graphic().actions).toEqual([savedAction]);
    await input(field('figure-1', 'x'), '0.31'); await apply();
    expect(h.graphic().actions).toEqual([savedAction]);
    const after = h.document();
    expect(after.audioClips).toEqual(before.audioClips); expect(after.captions).toEqual(before.captions);
    expect(after.visualClips.slice(1)).toEqual(before.visualClips.slice(1));
    expect(after.durationSec).toBe(before.durationSec);
    expect(after.visualClips.map((c) => [c.id, c.startSec, c.durationSec])).toEqual(before.visualClips.map((c) => [c.id, c.startSec, c.durationSec]));
    // JSON round trip + remount only. Actual save/reopen is tested separately through HTTP and the browser proof.
    const serialized = JSON.parse(JSON.stringify(after)) as EditorDocument;
    await act(async () => root!.unmount()); host.remove(); root = null;
    const reopened = await inspector(serialized);
    expect(reopened.graphic()).toEqual(h.graphic());
    expect(q<HTMLInputElement>(`[aria-label="${field('figure-1', 'x')}"]`).value).toBe('0.31');
    expect(q<HTMLInputElement>(`[aria-label="${action('end')}"]`).value).toBe('2');
  });

  it.each([
    ['figure-1', 'x', '1', 'safe area'], ['figure-1', 'y', '0', 'safe area'],
    ['figure-1', 'scale', '0.1', 'finite number'], ['figure-1', 'armAngle', '181', 'finite number'],
    ['figure-1', 'armAngle', '', 'finite number'], ['figure-1', 'opacity', '1.1', 'finite number'],
    ['figure-1', 'x', '1e309', 'finite number'], ['box-1', 'w', '0.01', 'finite number'],
    ['box-1', 'h', '0.61', 'finite number'], ['box-1', 'rotation', '361', 'finite number'],
    ['box-1', 'color', 'red', 'color must be #rrggbb'],
  ])('refuses invalid %s %s = %s before any callback', async (id, key, value, message) => {
    const graphic = twoObjects(); const before = structuredClone(graphic); const change = vi.fn();
    await mount(<GraphicValuesForm technique="actor_action" graphic={graphic} durationSec={3} format="landscape" profile="educational" label={label} onChange={change} />);
    await input(field(id, key), value); await apply();
    expect(change).not.toHaveBeenCalled(); expect(host.textContent).toContain(message); expect(graphic).toEqual(before);
  });

  it('retains supplied palette, RTL, optional fields, other objects and action IDs/times while editing pose', async () => {
    const graphic = { ...proofActor('landscape'), direction: 'rtl' as const };
    delete graphic.objects[0].opacity;
    const before = structuredClone(graphic); const change = vi.fn();
    await mount(<GraphicValuesForm technique="actor_action" graphic={graphic} durationSec={7} format="landscape" profile="educational" label={label} onChange={change} />);
    await input(field('worker', 'x'), '0.25'); await input(field('worker', 'armAngle'), '-25'); await apply();
    const expected = { ...before, objects: before.objects.map((o) => o.id === 'worker' ? { ...o, x: 0.25, armAngle: -25 } : o) };
    expect(change).toHaveBeenCalledWith(expected); expect(graphic).toEqual(before);
  });

  it('refuses referenced removal; explicit removal of the referencing action permits it without deleting unrelated work', async () => {
    const graphic = twoObjects();
    graphic.actions = [
      { id: 'box-move', targetId: 'box-1', property: 'x', from: 0.65, to: 0.75, startSec: 0.25, endSec: 2, easing: 'linear' },
      { id: 'arm', targetId: 'figure-1', property: 'armAngle', from: 0, to: 40, startSec: 0.5, endSec: 1.5, easing: 'ease_in_out' },
    ];
    const h = await inspector(suppliedActor(graphic));
    const remove = () => clickSelector(`[aria-label="${label} remove actor box-1"]`);
    await remove();
    expect(host.textContent).toContain('Cannot remove box-1: referenced by actions box-move');
    expect(h.staged).toHaveLength(0); expect(h.graphic()).toEqual(graphic);
    await clickSelector(`[data-testid="action-${label}-box-move"] button`);
    await remove(); await apply();
    expect(h.graphic().objects).toEqual([graphic.objects[0]]);
    expect(h.graphic().actions).toEqual([graphic.actions[1]]);
    await click('Add box'); await apply();
    expect(h.graphic().objects.map((o) => o.id)).toEqual(['figure-1', 'box-2']);
    expect(h.graphic().actions).toEqual([graphic.actions[1]]);
  });

  it('keeps surviving object IDs stable after middle/last removals and enforces the figure/box count limits', async () => {
    const h = await inspector(blankDocument()); await select('Clip technique', 'actor_action');
    for (let i = 0; i < 3; i++) await click('Add figure');
    expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Add figure')!.disabled).toBe(true);
    await clickSelector(`[aria-label="${label} remove actor figure-2"]`); await click('Add figure');
    for (let i = 0; i < 6; i++) await click('Add box');
    expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Add box')!.disabled).toBe(true);
    await clickSelector(`[aria-label="${label} remove actor box-6"]`); await click('Add box'); await apply();
    const ids = h.graphic().objects.map((o) => o.id);
    expect(ids).toEqual(['figure-1', 'figure-3', 'figure-4', 'box-1', 'box-2', 'box-3', 'box-4', 'box-5', 'box-7']);
    expect(new Set(ids).size).toBe(ids.length); expect(h.graphic().actions).toEqual([]);
    await apply(); expect(h.graphic().objects.map((o) => o.id)).toEqual(ids);
  });

  it('keeps invalid action numbers/times local until corrected, including a temporarily invalid property change', async () => {
    const h = await inspector(suppliedActor(twoObjects())); await click('Add timed action');
    await input(action('from'), '0.3'); await input(action('to'), '0.7');
    const before = structuredClone(h.graphic()); const calls = h.staged.length;
    await input(action('end'), '99');
    expect(h.graphic()).toEqual(before); expect(h.staged).toHaveLength(calls);
    expect(host.textContent).toContain('Action edits are not applied yet');
    await input(action('end'), '2');
    expect(h.graphic().actions[0].endSec).toBe(2);
    await input(action('start'), ''); expect(h.graphic().actions[0].startSec).toBe(0);
    expect(host.textContent).toContain('finite startSec and endSec');
    await input(action('start'), '0.25');
    await select(action('property'), 'armAngle'); await input(action('to'), '60');
    const arm = structuredClone(h.graphic());
    await select(action('property'), 'scale'); // 60 is not a valid scale. Keep the edit available to correct.
    expect(h.graphic()).toEqual(arm);
    await input(action('to'), '1.2');
    expect(h.graphic().actions[0]).toMatchObject({ id: 'action-1', property: 'scale', to: 1.2, startSec: 0.25, endSec: 2 });
  });

  it('preserves surviving actor actions when adding after removal, including an incomplete overlapping new action', async () => {
    const graphic = twoObjects();
    graphic.actions = [
      { id: 'action-1', targetId: 'figure-1', property: 'armAngle', from: 0, to: 40, startSec: 0.5, endSec: 1.5, easing: 'linear' },
      { id: 'action-2', targetId: 'box-1', property: 'opacity', from: 0, to: 1, startSec: 0, endSec: 1, easing: 'ease_out' },
      { id: 'action-3', targetId: 'box-1', property: 'x', from: 0.65, to: 0.75, startSec: 1, endSec: 2, easing: 'ease_in_out' },
    ];
    const h = await inspector(suppliedActor(graphic));
    await clickSelector(`[data-testid="action-${label}-action-2"] button`);
    const survivors = structuredClone(h.graphic().actions);
    await click('Add timed action');
    expect(h.graphic().actions.slice(0, 2)).toEqual(survivors);
    expect(h.graphic().actions[2]).toMatchObject({ id: 'action-2', targetId: 'figure-1', property: 'x', from: 0.3, to: 0.3 });
    const before = structuredClone(h.graphic());
    await click('Add timed action'); // Same target/property overlaps; not staged until resolved.
    expect(h.graphic()).toEqual(before);
    expect(host.textContent).toContain('Action edits are not applied yet');
    await select(action('property', 'action-4'), 'y');
    expect(h.graphic().actions.slice(0, 2)).toEqual(survivors);
    expect(new Set(h.graphic().actions.map((a) => a.id)).size).toBe(4);
  });

  it.each(['locked', 'disabled'])('%s actor controls cannot stage changes', async (mode) => {
    const doc = suppliedActor(twoObjects()); if (mode === 'locked') doc.visualClips[0].locked = true;
    const h = await inspector(doc, mode === 'disabled');
    const controls = q<HTMLElement>('[data-testid="editor-graphic-panel"]').querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select');
    expect([...controls].every((c) => c.disabled)).toBe(true);
    await click('Add figure'); await apply(); await click('Add timed action'); expect(h.staged).toHaveLength(0);
  });
});
