/**
 * @vitest-environment happy-dom
 *
 * VS6 — the export page shows the server readiness projection and does not
 * start a final export when that projection says the import is blocked.
 * No speech, no model, no render.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../apps/web/src/lib/api.js';
import { ExportPage } from '../apps/web/src/pages/Export.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function projectFixture() {
  return {
    project: {
      meta: { input: { videoId: 'Video_01' }, status: 'storyboarded', updatedAt: '2026-10-09T00:00:00.000Z' },
      storyboard: { long: { scenes: [] }, shorts: [], captions: [], similarity: null },
      artifacts: [],
    },
  };
}

function narration(exportAttemptReady: boolean) {
  return {
    projectId: 'Video_01',
    totalTargets: 1,
    importedCount: 1,
    readyCount: exportAttemptReady ? 1 : 0,
    blockedCount: exportAttemptReady ? 0 : 1,
    targets: [
      {
        targetId: 'long',
        label: 'Long video',
        import: { fileName: 'narration.wav' },
        ready: exportAttemptReady,
        blockReasons: [],
        readiness: {
          applies: true,
          inheritsLongNarration: false,
          exportAttemptReady,
          publicationApproved: false,
          lines: [
            { key: 'source', label: 'Audio source', state: 'Imported narration for this target', ok: true, detail: 'narration.wav · 10.00s measured. Export-page source line.' },
            { key: 'listening', label: 'Listening approval', state: exportAttemptReady ? 'Listening approved' : 'Listening not approved', ok: exportAttemptReady, detail: 'These exact bytes.' },
            { key: 'rights', label: 'Rights and consent', state: 'Statement recorded', ok: true, detail: 'Not a legal clearance.' },
            { key: 'timing', label: 'Timing', state: 'Estimated timing · Timing approved', ok: true, detail: 'Not acoustic verification.' },
            { key: 'coverage', label: 'Scene coverage', state: 'Spoken scenes cover the measured audio', ok: true, detail: 'Not a listening check.' },
            { key: 'export', label: 'Export attempt', state: exportAttemptReady ? 'Ready to attempt export' : 'Export attempt blocked', ok: exportAttemptReady, detail: 'Not a completed render.' },
            { key: 'publication', label: 'Publication', state: 'Not publication approved', ok: null, detail: 'Not a rights clearance.' },
          ],
          blockers: exportAttemptReady
            ? []
            : [{ code: 'IMPORT-APPROVAL-MISSING', message: 'The imported narration has not been approved.', remediation: 'Listen, then approve.', control: 'Approve this exact audio', where: 'captions' }],
        },
      },
    ],
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('VS6 export page readiness', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(api, 'project').mockResolvedValue(projectFixture() as any);
    vi.spyOn(api, 'production').mockRejectedValue(new Error('no production state'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('shows the server summary and does not start export while it is blocked', async () => {
    vi.spyOn(api, 'externalNarration').mockResolvedValue(narration(false) as any);
    const startExport = vi.spyOn(api, 'startExport').mockResolvedValue({ jobId: 'job-1' } as any);
    const onBack = vi.fn();
    await act(async () => {
      root.render(React.createElement(ExportPage, { projectId: 'Video_01', onBack, toast: vi.fn() }));
    });
    await flush();
    expect(host.textContent).toContain('Export-page source line.');
    expect(host.textContent).toContain('Not publication approved');
    expect(host.textContent).not.toMatch(/Publication approved/);

    const review = [...host.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Open narration review for Long video');
    expect(review).toBeTruthy();
    await act(async () => (review as HTMLButtonElement).click());
    expect(onBack).toHaveBeenCalledOnce();
    expect(startExport).not.toHaveBeenCalled();

    const finalExport = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Final export');
    await act(async () => (finalExport as HTMLButtonElement).click());
    await flush();
    expect(startExport).not.toHaveBeenCalled();
  });

  it('starts export only after the server projection says the attempt is allowed', async () => {
    vi.spyOn(api, 'externalNarration').mockResolvedValue(narration(true) as any);
    const startExport = vi.spyOn(api, 'startExport').mockResolvedValue({ jobId: 'job-2' } as any);
    await act(async () => {
      root.render(React.createElement(ExportPage, { projectId: 'Video_01', onBack: () => {}, toast: vi.fn() }));
    });
    await flush();
    const finalExport = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Final export');
    await act(async () => (finalExport as HTMLButtonElement).click());
    await flush();
    expect(startExport).toHaveBeenCalledWith('Video_01', expect.objectContaining({ kind: 'final', includeShorts: true }));
  });
});
