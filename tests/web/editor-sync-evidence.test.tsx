// @vitest-environment happy-dom
/**
 * DOM tests for the synchronization evidence shown in the existing Editor
 * alignment panel. The panel is the real component; the props are fixtures
 * shaped like the API's proposal DTO. These are not browser acceptance.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorAlignmentPanel } from '../../apps/web/src/components/editor/EditorServerPanels';
import type { AlignmentJobResult, EditorCapabilities, EditorDocument } from '../../apps/web/src/lib/editor-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
});

const CAPS = { alignment: { available: true, reason: null } } as unknown as EditorCapabilities;

function docWith(alignment: Record<string, unknown>): EditorDocument {
  return {
    audioClips: [{ id: 'ac_narration', sourceAssetId: 'narration' }],
    alignment: { state: 'proposed', audioHash: 'a'.repeat(64), sourceRevision: 3, proposalId: 'prp_1', ...alignment },
  } as unknown as EditorDocument;
}

function resultWith(syncVerdict: string, acceptable: boolean, reasons: string[], transcriptAvailable: boolean): AlignmentJobResult {
  return {
    status: 'proposed',
    proposalId: 'prp_1',
    rows: [{ sceneId: 'cap_c1', cueId: 'cap_c1', proposedStartSec: 0, proposedEndSec: 2, unresolvedSpan: false } as never],
    proposal: {
      proposalId: 'prp_1', status: 'proposed', stale: false, staleReasons: [],
      syncVerdict, syncReasons: reasons, transcriptAvailable, acceptable,
    } as never,
  };
}

async function render(editorDoc: EditorDocument, result: AlignmentJobResult, reviewed = true) {
  host = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <EditorAlignmentPanel
        document={editorDoc} capabilities={CAPS} jobId="aln_1" result={result} blocker={null} error={null}
        busy={false} reviewed={reviewed} onReviewedChange={vi.fn()} onRequest={vi.fn()} onAccept={vi.fn()} disabled={false}
      />,
    );
  });
  return host;
}

const acceptButton = (h: HTMLElement) => [...h.querySelectorAll('button')].find((b) => b.textContent?.includes('Accept reviewed timing')) as HTMLButtonElement;

describe('sync evidence in the Editor alignment panel', () => {
  it('forced alignment with no transcript is labelled unverified, and can still be reviewed and accepted', async () => {
    const h = await render(docWith({}), resultWith('unverified', true, ['Forced alignment placed the supplied text, but no independent transcript was available. That shows timing fit, not that the words were spoken.'], false));
    const evidence = h.querySelector('[data-testid="sync-evidence"]') as HTMLElement;
    expect(evidence.getAttribute('data-verdict')).toBe('unverified');
    expect(evidence.textContent).toContain('unverified');
    expect(evidence.textContent).toContain('no independent transcript was available');
    expect(evidence.textContent).not.toContain('verified against transcript');
    expect(acceptButton(h).disabled).toBe(false);
  });

  it('a transcript discrepancy shows the reason and disables Accept, even when reviewed', async () => {
    const h = await render(docWith({}), resultWith('discrepancy', false, ['The transcript does not match the supplied text: 3 supplied word(s) not heard in the transcript. No timing was applied.'], true));
    const evidence = h.querySelector('[data-testid="sync-evidence"]') as HTMLElement;
    expect(evidence.getAttribute('data-verdict')).toBe('discrepancy');
    expect(evidence.textContent).toContain('transcript discrepancy');
    expect(evidence.textContent).toContain('No timing was applied');
    expect(acceptButton(h).disabled).toBe(true);
  });

  it('a verified transcript comparison says so, and only that', async () => {
    const h = await render(docWith({}), resultWith('verified', true, ['The independent transcript matches the supplied text. Listening review is still separate.'], true));
    const evidence = h.querySelector('[data-testid="sync-evidence"]') as HTMLElement;
    expect(evidence.textContent).toContain('verified against transcript');
    expect(evidence.textContent).toContain('Listening review is still separate');
  });

  it('the saved document verdict is shown after reload, separate from listening review', async () => {
    const h = await render(docWith({ state: 'approved', syncVerdict: 'unverified', excerptSha256: 'e'.repeat(64) }), { status: 'proposed', proposalId: null, rows: [] });
    const saved = h.querySelector('[data-testid="sync-verdict-saved"]') as HTMLElement;
    expect(saved.textContent).toContain('unverified');
    expect(saved.textContent).toContain('listening review is separate');
  });
});
