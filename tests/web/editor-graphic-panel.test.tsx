// @vitest-environment happy-dom
/**
 * Editor inspector: the visual-technique and graphic panel for the selected clip.
 * Real EditorClipInspector on a fixture document; every change is checked as the canonical
 * opUpdate('visualClips', …) that the Editor stages. DOM test only, not browser acceptance.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorClipInspector } from '../../apps/web/src/components/editor/EditorClipInspector';
import { fixtureDocument } from '../../apps/web/src/lib/editor-fixture';
import { opUpdate } from '../../apps/web/src/lib/editor-model';
import { techniqueChoices } from '../../apps/web/src/components/graphic/GraphicEditors';
import type { EditorDocument } from '../../apps/web/src/lib/editor-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mountInspector(doc: EditorDocument, stage: (ops: unknown[]) => Array<{ field: string; message: string }>, clipId = 'vc_01') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <EditorClipInspector
        document={doc}
        selectedClipId={clipId}
        playhead={0}
        stage={stage as never}
        onSelectClip={() => {}}
        onAssign={() => {}}
        onAddClip={() => {}}
        disabled={false}
      />,
    );
  });
  return host;
}

function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('editor graphic panel (DOM, fixture document)', () => {
  it('is shown for the selected clip with the visual language on the document', async () => {
    const doc = { ...fixtureDocument('proj-1', 'long'), visualLanguage: 'motion_explainer' };
    const el = await mountInspector(doc, () => []);
    expect(el.querySelector('[data-testid="editor-graphic-panel"]')).not.toBeNull();
    expect(el.textContent).toContain('Visual language: motion_explainer');
  });

  it('a technique change stages the canonical update and clears the picture source in the same op', async () => {
    const doc = { ...fixtureDocument('proj-1', 'long'), visualLanguage: 'motion_explainer' };
    const stage = vi.fn(() => []);
    const el = await mountInspector(doc, stage);
    const select = el.querySelector('select[aria-label="Clip technique"]') as HTMLSelectElement;
    await act(async () => choose(select, 'process_path'));
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage.mock.calls[0][0]).toEqual([
      opUpdate('visualClips', 'vc_01', {
        technique: 'process_path',
        graphic: null,
        sourceAssetId: null,
        sourceInSec: null,
        sourceOutSec: null,
      }),
    ]);
  });

  it('techniques outside the project language are shown as disabled, never silently selectable', async () => {
    const doc = { ...fixtureDocument('proj-1', 'long'), visualLanguage: 'motion_explainer' };
    const el = await mountInspector(doc, () => []);
    const choices = techniqueChoices('motion_explainer');
    const blocked = choices.filter((c) => !c.allowed);
    expect(blocked.length).toBeGreaterThan(0);
    for (const c of blocked) {
      const option = el.querySelector(`select[aria-label="Clip technique"] option[value="${c.id}"]`) as HTMLOptionElement | null;
      expect(option).not.toBeNull();
      expect(option!.disabled).toBe(true);
    }
  });

  it('a refusal from the canonical stage is shown as an alert, not as success', async () => {
    const doc = { ...fixtureDocument('proj-1', 'long'), visualLanguage: 'motion_explainer' };
    const el = await mountInspector(doc, () => [{ field: 'visualClips', message: 'technique is not in visual language motion_explainer' }]);
    const select = el.querySelector('select[aria-label="Clip technique"]') as HTMLSelectElement;
    await act(async () => choose(select, 'process_path'));
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('technique is not in visual language motion_explainer');
  });

  it('a locked clip disables the technique control', async () => {
    const doc = fixtureDocument('proj-1', 'long');
    const locked: EditorDocument = { ...doc, visualLanguage: 'motion_explainer', visualClips: doc.visualClips.map((c) => (c.id === 'vc_01' ? { ...c, locked: true } : c)) };
    const el = await mountInspector(locked, () => []);
    const select = el.querySelector('select[aria-label="Clip technique"]') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it('a legacy document without visual language still shows the panel and says checks happen on save', async () => {
    const doc = fixtureDocument('proj-1', 'long');
    const el = await mountInspector(doc, () => []);
    expect(el.textContent).toContain('No visual language on this project');
  });
});
