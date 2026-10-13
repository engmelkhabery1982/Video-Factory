/**
 * @vitest-environment happy-dom
 *
 * Milestone 1 editor — the REAL page, operated.
 *
 * The page is mounted from `apps/web/src/pages/Editor.tsx` and driven through
 * its own controls (buttons, numeric fields, selects, text inputs). Only the
 * two transport modules are substituted:
 *
 *   - `lib/editor-api` is backed by the opt-in development fixture, because the
 *     contract endpoints do not exist in this workspace yet (Arena owns them).
 *     The fixture counts revisions and refuses a stale save exactly like the
 *     contract says the server must.
 *   - `lib/api` returns a small asset library so the binding path is real.
 *
 * These are interaction tests against the implemented UI. They are NOT
 * end-to-end acceptance against `apps/api` — see LOCAL_VERIFY_STEPS.txt.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LIBRARY = [
  {
    id: 'lib-video-01',
    name: 'screen_capture.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    source: 'owner screen recording',
    license: 'owner',
    durationSec: 30,
    status: 'active',
  },
  {
    id: 'lib-still-01',
    name: 'sheet.png',
    kind: 'image',
    mimeType: 'image/png',
    source: '',
    license: '',
    status: 'active',
  },
];

vi.mock('../apps/web/src/lib/api.js', () => ({
  api: {
    assets: vi.fn(async () => ({ assets: LIBRARY })),
    uploadAsset: vi.fn(async () => ({ ok: true })),
  },
}));

vi.mock('../apps/web/src/lib/editor-api.js', async () => {
  const fixture = await import('../apps/web/src/lib/editor-fixture.js');
  return {
    // The server envelope carries the saved revision's identity from the core resolver (see routes/editor.ts envelope()).
    getEditor: (projectId: string, targetId: any) => Promise.resolve(withIdentity(fixture.fixtureGet(projectId, targetId))),
    commitOperations: (projectId: string, targetId: any, baseRevision: number, operations: any[]) =>
      Promise.resolve(withIdentity(fixture.fixturePatch(projectId, { targetId, baseRevision, operations }))),
    undoEditor: (projectId: string, targetId: any, baseRevision: number) => Promise.resolve(withIdentity(fixture.fixtureUndo(projectId, targetId, baseRevision))),
    redoEditor: (projectId: string, targetId: any, baseRevision: number) => Promise.resolve(withIdentity(fixture.fixtureRedo(projectId, targetId, baseRevision))),
    requestAlignment: () => Promise.resolve(fixture.fixtureAlignmentStart()),
    getAlignmentJob: (projectId: string) => Promise.resolve(fixture.fixtureAlignmentJob()),
    acceptAlignment: (projectId: string, targetId: any) => Promise.resolve(fixture.fixtureAcceptAlignment(projectId, targetId)),
    requestPreview: (_projectId: string, _targetId: any, _baseRevision: number, range: any) =>
      Promise.resolve(fixture.fixturePreviewStart(range ?? null)),
    getPreviewJob: (projectId: string, _jobId: string, range: any) => Promise.resolve(fixture.fixturePreviewJob(projectId, 'long', range ?? null)),
  };
});

import { EditorPage } from '../apps/web/src/pages/Editor.js';
import { resetFixture, setFixtureControl, setFixtureLibrary } from '../apps/web/src/lib/editor-fixture.js';
import { toAssetRef } from '../apps/web/src/components/editor/EditorMediaPanels.js';
import { resolveDocumentIdentity } from '../packages/core/src/editor/identity.js';

function withIdentity<T extends { document: any }>(envelope: T): T & { identity: unknown } {
  return { ...envelope, identity: resolveDocumentIdentity(envelope.document) };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonIn(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) => (item.textContent ?? '').trim().startsWith(text));
  if (!button) throw new Error(`button not found: ${text}`);
  return button as HTMLButtonElement;
}

function cardByTitle(container: HTMLElement, title: string): HTMLElement {
  const card = [...container.querySelectorAll('.card')].find((item) => (item.querySelector('h2, h3')?.textContent ?? '').startsWith(title));
  if (!card) throw new Error(`card not found: ${title}`);
  return card as HTMLElement;
}

function control(container: HTMLElement, labelPrefix: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const field = [...container.querySelectorAll('.field')].find((item) => (item.querySelector('label')?.textContent ?? '').startsWith(labelPrefix));
  const element = field?.querySelector('input, select, textarea');
  if (!element) throw new Error(`control not found: ${labelPrefix}`);
  return element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await flush();
}

/** React tracks the value: set it through the native setter so onChange fires. */
async function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

describe('milestone 1 editor (apps/web)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    resetFixture();
    setFixtureLibrary(LIBRARY.map(toAssetRef));
    window.history.pushState({}, '', '/?p=Editor_UI');
    (globalThis as { fetch?: unknown }).fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        brand: { id: 'unbound-educational', name: 'Unbound educational visual system', logoAssetId: null },
        identityBound: false,
        refusal: 'No educational channel identity is bound. BuildTrack was not assumed.',
      }),
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EditorPage, { projectId: 'Editor_UI' }));
    });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const save = () => buttonIn(host, 'Save');
  const text = () => host.textContent ?? '';

  /** Close the editor and open the project again — the way an operator reopens it. */
  async function reopen(): Promise<void> {
    act(() => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EditorPage, { projectId: 'Editor_UI' }));
    });
    await flush();
  }

  it('renders the real document and is NOT in fixture mode without the flag', () => {
    expect(text()).toContain('Editor — Editor_UI');
    expect(text()).toContain('revision');
    expect(host.querySelector('[data-testid="editor-clip-vc_01"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="editor-clip-vc_02"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="editor-caption-cap_01"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="editor-highlight-marker-hl_01"]')).not.toBeNull();
    expect(text()).not.toContain('DEVELOPMENT FIXTURE MODE is on');
    // the render badge is honest about what is being shown
    expect(text()).toContain('browser assembly preview — approximate, not the server render');
  });

  it('shows the development fixture only when it is explicitly switched on', async () => {
    window.history.pushState({}, '', '/?p=Editor_UI&editorFixture=1');
    await act(async () => {
      root.render(React.createElement(EditorPage, { projectId: 'Editor_UI' }));
    });
    await flush();
    expect(text()).toContain('DEVELOPMENT FIXTURE MODE is on');
    expect(text()).toContain('DEVELOPMENT FIXTURE');
  });

  it('selects a clip, trims its duration and saves through the contract', async () => {
    await click(host.querySelector('[data-testid="editor-clip-vc_01"]') as HTMLElement);
    const inspector = cardByTitle(host, 'Clip inspector');
    expect(inspector.textContent).toContain('vc_01');
    expect(inspector.textContent).toContain('owner screen recording (development fixture)');
    expect(text()).toContain('no unsaved changes');

    await setValue(control(inspector, 'Duration'), '12');
    expect(text()).toContain('1 operation(s) not saved');
    await click(save());
    expect(text()).toContain('Saved — revision 4');
    expect(text()).toContain('no unsaved changes');
    expect(host.querySelector('[data-testid="editor-clip-vc_02"]')!.textContent).toContain('12.00–24.00s');
  });

  it('splits a clip at the playhead and keeps the total duration', async () => {
    await click(host.querySelector('[data-testid="editor-clip-vc_01"]') as HTMLElement);
    await setValue(host.querySelector('input[aria-label="Playhead"]') as HTMLInputElement, '6');
    await click(buttonIn(cardByTitle(host, 'Clip inspector'), 'Split at playhead'));
    expect(text()).toContain('1 operation(s) not saved');
    await click(save());
    const clips = host.querySelectorAll('[data-testid^="editor-clip-"]');
    expect(clips.length).toBe(4);
    expect(text()).toContain('38.00s');
  });

  it('reorders clips with the keyboard-accessible controls and rewrites composition starts', async () => {
    await click(host.querySelector('[data-testid="editor-clip-vc_03"]') as HTMLElement);
    await click(buttonIn(cardByTitle(host, 'Clip inspector'), '← Move earlier'));
    await click(buttonIn(cardByTitle(host, 'Clip inspector'), '← Move earlier'));
    await click(save());
    const firstClip = host.querySelector('[data-testid^="editor-clip-"]');
    expect(firstClip?.getAttribute('data-testid')).toBe('editor-clip-vc_03');
    expect(host.querySelector('[data-testid="editor-clip-vc_03"]')!.textContent).toContain('0.00–10.00s');
    expect(host.querySelector('[data-testid="editor-clip-vc_01"]')!.textContent).toContain('10.00–26.00s');
  });

  it('edits an Arabic caption (RTL, diacritics kept) and shows it in the preview at its own interval', async () => {
    await click(host.querySelector('[data-testid="caption-chip-cap_01"]') as HTMLElement);
    const captionCard = cardByTitle(host, 'Captions');
    await setValue(captionCard.querySelector('[data-testid="caption-text"]') as HTMLTextAreaElement, 'افتح ورقة الملخص ثم حدد الإجمالي — الرَّحْمَٰن');
    await click(host.querySelector('[data-testid="caption-chip-cap_02"]') as HTMLElement);
    await click(host.querySelector('[data-testid="caption-chip-cap_01"]') as HTMLElement);
    await click(save());
    await setValue(host.querySelector('input[aria-label="Playhead"]') as HTMLInputElement, '5');
    const overlay = host.querySelector('[data-testid="editor-stage-caption-cap_01"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute('dir')).toBe('rtl');
    expect(overlay!.textContent).toContain('الرَّحْمَٰن');
    // cap_02 starts at 12s, so it is not drawn at 5s
    expect(host.querySelector('[data-testid="editor-stage-caption-cap_02"]')).toBeNull();
    expect(captionCard.textContent).toContain('diacritics preserved');
  });

  it('refuses an invalid caption edit instead of staging it', async () => {
    await click(host.querySelector('[data-testid="caption-chip-cap_01"]') as HTMLElement);
    await setValue(control(cardByTitle(host, 'Captions'), 'End'), '1');
    expect(text()).toContain('These edits were refused and nothing was staged');
    expect(text()).toContain('end time after its start time');
    expect(buttonIn(host, 'Save').disabled).toBe(true);
  });

  it('edits a timed highlight numerically and shows the measured display box', async () => {
    await click(host.querySelector('[data-testid="highlight-chip-hl_01"]') as HTMLElement);
    const highlights = cardByTitle(host, 'Timed highlights');
    await setValue(control(highlights, 'box x'), '0.5');
    await setValue(control(highlights, 'End'), '12');
    await click(save());
    expect(highlights.textContent).toContain('display box: 50.000%');
    expect(host.querySelector('[data-testid="editor-highlight-marker-hl_01"]')!.textContent).toContain('6.00–12.00s');
  });

  it('adds a highlight at the playhead with its own interval', async () => {
    await setValue(host.querySelector('input[aria-label="Playhead"]') as HTMLInputElement, '6');
    await click(buttonIn(cardByTitle(host, 'Timed highlights'), '+ Highlight at playhead'));
    await click(save());
    expect(host.querySelectorAll('[data-testid^="editor-highlight-marker-"]').length).toBe(2);
  });

  it('supports undo and redo through the contract after a save', async () => {
    await click(host.querySelector('[data-testid="editor-clip-vc_01"]') as HTMLElement);
    await setValue(control(cardByTitle(host, 'Clip inspector'), 'Duration'), '12');
    await click(save());
    expect(text()).toContain('Saved — revision 4');
    await click(buttonIn(host, '↶ Undo'));
    expect(text()).toContain('Undone — revision 5');
    expect(host.querySelector('[data-testid="editor-clip-vc_02"]')!.textContent).toContain('16.00–28.00s');
    await click(buttonIn(host, '↷ Redo'));
    expect(text()).toContain('Redone — revision 6');
    expect(host.querySelector('[data-testid="editor-clip-vc_02"]')!.textContent).toContain('12.00–24.00s');
  });

  it('keeps pending edits and reports a failed save as a failure', async () => {
    await click(host.querySelector('[data-testid="editor-clip-vc_01"]') as HTMLElement);
    await setValue(control(cardByTitle(host, 'Clip inspector'), 'Duration'), '12');
    setFixtureControl('failNextSave', true);
    await click(save());
    expect(text()).toContain('The save failed and nothing was persisted');
    expect(text()).toContain('Fixture: the save failed. Nothing was persisted.');
    expect(text()).toContain('1 pending edit(s) are kept');
    expect(text()).not.toContain('Saved — revision');
    expect(text()).toContain('1 operation(s) not saved');
    // the operator’s edit is still staged and can be saved again
    await click(save());
    expect(text()).toContain('Saved — revision 4');
  });

  it('surfaces a revision conflict and offers both explicit resolutions', async () => {
    await click(host.querySelector('[data-testid="editor-clip-vc_01"]') as HTMLElement);
    await setValue(control(cardByTitle(host, 'Clip inspector'), 'Duration'), '12');
    setFixtureControl('serverRevisionAhead', 4);
    await click(save());
    expect(text()).toContain('Revision conflict.');
    expect(text()).toContain('The server is at revision 4.');
    expect(text()).toContain('Nothing was overwritten');
    expect(text()).toContain('1 operation(s) not saved');
    await click(buttonIn(host, 'Keep my'));
    expect(text()).toContain('Saved — revision 5');
    expect(text()).toContain('no unsaved changes');
  });

  it('reports a missing alignment runtime as a blocker, then walks the reviewed proposal', async () => {
    await click(buttonIn(cardByTitle(host, 'Narration alignment'), 'Request alignment'));
    expect(text()).toContain('Alignment did not start.');
    expect(text()).toContain('The dedicated vf-align runtime is not available on this host.');
    expect(text()).toContain('No timing was estimated');
    expect(text()).not.toContain('Review proposal');

    setFixtureControl('alignmentRuntime', true);
    await click(buttonIn(cardByTitle(host, 'Narration alignment'), 'Request alignment'));
    expect(text()).toContain('Review proposal fixture-proposal-1');
    expect(text()).toContain('unresolved span');
    const accept = buttonIn(host, 'Accept reviewed timing');
    expect(accept.disabled).toBe(true);
    await click(cardByTitle(host, 'Narration alignment').querySelector('input[type="checkbox"]') as HTMLElement);
    await click(buttonIn(host, 'Accept reviewed timing'));
    expect(text()).toContain('Reviewed timing accepted — revision 3');
    expect(host.querySelector('[data-testid="caption-chip-cap_01"]')!.textContent).toContain('4.21');
    expect(host.querySelector('[data-testid="editor-caption-cap_01"]')!.textContent).toContain('افتح ورقة الملخص');
  });

  it('reports an unrenderable preview and labels a stale render when the edit moves on', async () => {
    await click(buttonIn(host, 'Render full preview'));
    expect(text()).toContain('No render was started.');
    expect(text()).toContain('Fixture mode cannot render.');

    setFixtureControl('previewSubstituteUrl', '/media/asset/asset-sheet-still');
    await click(buttonIn(host, 'Render full preview'));
    expect(text()).toContain('Current. Rendered from revision 3');
    expect(text()).toContain('returned media URL: /media/asset/asset-sheet-still');

    await click(host.querySelector('[data-testid="editor-clip-vc_01"]') as HTMLElement);
    await setValue(control(cardByTitle(host, 'Clip inspector'), 'Duration'), '12');
    await click(save());
    expect(text()).toContain('STALE');
    expect(text()).toContain('This file was rendered from revision 3');
  });

  it('binds an existing library file to the selected clip and refuses to bind the wrong media kind', async () => {
    await click(host.querySelector('[data-testid="editor-clip-vc_02"]') as HTMLElement);
    const assets = cardByTitle(host, 'Assets');
    expect(assets.textContent).toContain('in the library only — not bound to a scene');
    expect(assets.textContent).toContain('provenance not recorded');
    const rows = [...assets.querySelectorAll('.asset-row')];
    const stillRow = rows.find((row) => row.textContent?.includes('sheet.png'))!;
    await click(buttonIn(stillRow, 'Assign to selected clip'));
    // sheet.png keeps the still-only shape (no source out-point is invented)
    await click(save());
    expect(text()).toContain('Saved — revision 4');
    expect(host.querySelector('[data-testid="editor-clip-vc_02"]')!.textContent).toContain('sheet.png');

    // audio never fills a picture slot: the audio row offers an audio-track action, not a picture-slot one
    await click(host.querySelector('[data-testid="editor-clip-vc_03"]') as HTMLElement);
    const narrationRow = [...cardByTitle(host, 'Assets').querySelectorAll('.asset-row')].find((row) => row.textContent?.includes('approved.wav'))!;
    expect(narrationRow.textContent).toContain('Add to audio track');
    expect(narrationRow.textContent).not.toContain('Assign to selected clip');
  });

  it('replaces a clip with a library video and derives its own source range', async () => {
    const assets = cardByTitle(host, 'Assets');
    const videoRow = [...assets.querySelectorAll('.asset-row')].find((row) => row.textContent?.includes('screen_capture.mp4'))!;
    expect(videoRow.textContent).toContain('video (plays)');
    await click(host.querySelector('[data-testid="editor-clip-vc_01"]') as HTMLElement);
    await click(buttonIn(videoRow, 'Assign to selected clip'));
    await click(save());
    expect(host.querySelector('[data-testid="editor-clip-vc_01"]')!.textContent).toContain('video: screen_capture.mp4');
    expect(host.querySelector('[data-testid="editor-clip-vc_01"]')!.textContent).toContain('src 0.00–16.00s');
  });

  it('sets the explicit content profile and channel identity', async () => {
    const panel = cardByTitle(host, 'Project content & channel identity');
    await setValue(control(panel, 'Content profile'), 'religious');
    await setValue(control(panel, 'Channel identity'), 'owner-religious-channel');
    await click(save());
    expect((control(cardByTitle(host, 'Project content & channel identity'), 'Content profile') as HTMLSelectElement).value).toBe('religious');
    // the identity is resolved from the document (not a legacy brand fetch): an unregistered preset is refused, never BuildTrack
    expect(text()).toContain('is not registered. BuildTrack was not used as a fallback.');
    expect(text()).toContain('Nothing is rendered as a channel identity until it is changed.');
    expect(text()).not.toContain('identity bound');
  });

  it('reopens the project at the saved revision and does not resurrect an unsaved edit', async () => {
    await click(host.querySelector('[data-testid="editor-clip-vc_01"]') as HTMLElement);
    await setValue(control(cardByTitle(host, 'Clip inspector'), 'Duration'), '12');
    expect(text()).toContain('1 operation(s) not saved');

    // Reopen WITHOUT saving: the pending edit existed only in this browser.
    await reopen();
    expect(text()).toContain('Editor — Editor_UI');
    expect(text()).toContain('no unsaved changes');
    expect(host.querySelector('[data-testid="editor-clip-vc_01"]')!.textContent).toContain('0.00–16.00s');

    // Make the same edit and save it, then reopen: the document comes back edited.
    await click(host.querySelector('[data-testid="editor-clip-vc_01"]') as HTMLElement);
    await setValue(control(cardByTitle(host, 'Clip inspector'), 'Duration'), '12');
    await click(save());
    expect(text()).toContain('Saved — revision 4');
    await reopen();
    expect(host.querySelector('[data-testid="editor-clip-vc_01"]')!.textContent).toContain('0.00–12.00s');
    expect(host.querySelector('[data-testid="caption-chip-cap_01"]')).not.toBeNull();
  });

  it('keeps an approved narration clip locked for editing until it is unlocked', async () => {
    const narration = cardByTitle(host, 'Narration (approved audio)');
    expect(narration.textContent).toContain('approved');
    expect((control(narration, 'Gain') as HTMLInputElement).disabled).toBe(true);
    await click(buttonIn(narration, 'Unlock narration'));
    await click(save());
    expect((control(cardByTitle(host, 'Narration (approved audio)'), 'Gain') as HTMLInputElement).disabled).toBe(false);
    // changing an approved recording withdraws its approval in the same edit
    await setValue(control(cardByTitle(host, 'Narration (approved audio)'), 'Gain'), '-3');
    await click(save());
    expect(cardByTitle(host, 'Narration (approved audio)').textContent).toContain('approval invalidated');
  });
});
