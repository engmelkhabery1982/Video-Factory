/**
 * @vitest-environment happy-dom
 *
 * VS7 — fixture coverage for the review panel. happy-dom is not a browser
 * acceptance pass and does not render a video.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalNarrationPanel, type ExternalNarrationSummary } from '../apps/web/src/components/ExternalNarrationPanel.js';
import { api } from '../apps/web/src/lib/api.js';
import { CaptionsPage } from '../apps/web/src/pages/Captions.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function target(overrides: Record<string, unknown> = {}) {
  return {
    targetId: 'long',
    label: 'Long video',
    import: {
      importId: 'imp_abcdef01',
      fileName: 'slima.wav',
      durationSec: 24,
      scriptText: 'The exact spoken words.',
      scriptSha256: 'a'.repeat(64),
      sha256: 'b'.repeat(64),
      declaration: {
        sourceKind: 'own_recording',
        ownershipConfirmed: true,
        ownershipStatement: 'TEST/FIXTURE',
        speakerName: 'Fixture speaker',
      },
      alignment: { mode: 'estimated_from_script', verified: false, sceneCount: null, detail: 'estimates' },
      createdAt: '2026-10-09T00:00:00.000Z',
    },
    approval: {
      decision: 'approved',
      listened: true,
      decidedAt: '2026-10-09T00:05:00.000Z',
      decidedBy: 'project-owner',
      timingRevision: 'rev-1',
    },
    ready: true,
    summary: 'approved',
    blockReasons: [],
    findings: [],
    alignment: { mode: 'estimated_from_script', verified: false, sceneCount: null, detail: 'estimates' },
    audioDurationSec: 24,
    timelineDurationSec: 24.4,
    endCardSeconds: 0.4,
    timingRevision: 'rev-1',
    ...overrides,
  };
}

function summary(targets = [target()]): ExternalNarrationSummary {
  return {
    projectId: 'Video_01',
    totalTargets: targets.length,
    importedCount: targets.filter((item) => item.import).length,
    readyCount: targets.filter((item) => item.ready).length,
    blockedCount: targets.filter((item) => item.import && !item.ready).length,
    targets: targets as ExternalNarrationSummary['targets'],
  };
}

function readiness(listening = 'Listening approved', listeningOk = true) {
  return {
    applies: true,
    inheritsLongNarration: false,
    exportAttemptReady: listeningOk,
    publicationApproved: false as const,
    lines: [
      { key: 'source', label: 'Audio source', state: 'Imported narration for this target', ok: true, detail: 'slima.wav · 24.00s measured.' },
      { key: 'listening', label: 'Listening approval', state: listening, ok: listeningOk, detail: 'These exact bytes.' },
      { key: 'rights', label: 'Rights and consent', state: 'Statement recorded', ok: true, detail: 'Not a legal clearance.' },
      { key: 'timing', label: 'Timing', state: 'Estimated timing · Timing approved', ok: true, detail: 'Not acoustic verification.' },
      { key: 'coverage', label: 'Scene coverage', state: 'Spoken scenes cover the measured audio', ok: true, detail: 'Not a listening check.' },
      { key: 'export', label: 'Export attempt', state: listeningOk ? 'Ready to attempt export' : 'Export attempt blocked', ok: listeningOk, detail: 'Not a completed render.' },
      { key: 'publication', label: 'Publication', state: 'Not publication approved', ok: null, detail: 'Not a rights clearance.' },
    ],
    blockers: listeningOk
      ? []
      : [{ code: 'IMPORT-APPROVAL-STALE-ARTIFACT', message: 'The approved audio is no longer the audio on disk.', remediation: 'Listen again.', control: 'Approve this exact audio', where: 'captions' as const }],
  };
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button as HTMLButtonElement;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function check(el: HTMLInputElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('VS7 narration review fixtures', () => {
  let host: HTMLDivElement;
  let root: Root;
  let toast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    toast = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  async function renderPanel(data: ExternalNarrationSummary, refreshToken = 0): Promise<void> {
    vi.spyOn(api, 'externalNarration').mockResolvedValue(data as any);
    await act(async () => {
      root.render(React.createElement(ExternalNarrationPanel, { projectId: 'Video_01', toast, refreshToken }));
    });
    await flush();
  }

  it('states the existing order and keeps the readiness card ahead of the actions', async () => {
    await renderPanel(summary([target({ readiness: readiness() })]));
    expect(host.textContent).toContain('choose the target below, import its own file and record rights');
    expect(host.textContent).toContain('A script match is not heard-word sync.');
    const row = host.querySelector('[data-testid="external-narration-long"]') as HTMLElement;
    const card = row.querySelector('[data-testid="external-readiness-long"]');
    const action = buttonByLabel(row, 'Approve the imported narration for Long video');
    expect(card).toBeTruthy();
    expect(Boolean(card!.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    const tags = [...row.querySelectorAll('.tag')].map((item) => item.textContent);
    expect(tags).toContain('Listening approved');
    expect(tags).not.toContain('Approved');
    expect(tags).toContain('Not publication approved');
  });

  it('keeps the Approved tag only when the server readiness is absent', async () => {
    await renderPanel(summary([target()]));
    const tags = [...host.querySelectorAll('[data-testid="external-narration-long"] .tag')].map((item) => item.textContent);
    expect(tags).toContain('Approved');
    expect(tags).not.toContain('Listening approved');
  });

  it('reloads when the caption page bumps refreshToken and clears a stale listen mark', async () => {
    const load = vi.spyOn(api, 'externalNarration').mockResolvedValue(summary() as any);
    await act(async () => {
      root.render(React.createElement(ExternalNarrationPanel, { projectId: 'Video_01', toast, refreshToken: 0 }));
    });
    await flush();
    const box = host.querySelector('input[aria-label="I listened to the whole imported narration for Long video"]') as HTMLInputElement;
    await check(box);
    expect(box.checked).toBe(true);

    load.mockResolvedValue(summary([target({
      import: { ...(target().import as object), importId: 'imp_replaced' },
    })]) as any);
    await act(async () => {
      root.render(React.createElement(ExternalNarrationPanel, { projectId: 'Video_01', toast, refreshToken: 1 }));
    });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    const next = host.querySelector('input[aria-label="I listened to the whole imported narration for Long video"]') as HTMLInputElement;
    expect(next.checked).toBe(false);
  });

  it('clears the listen mark when the current file no longer matches the approval', async () => {
    vi.spyOn(api, 'externalNarration')
      .mockResolvedValueOnce(summary() as any)
      .mockResolvedValueOnce(summary([target({ readiness: readiness('Listening not approved', false) })]) as any);
    await act(async () => {
      root.render(React.createElement(ExternalNarrationPanel, { projectId: 'Video_01', toast, refreshToken: 0 }));
    });
    await flush();
    await check(host.querySelector('input[aria-label="I listened to the whole imported narration for Long video"]') as HTMLInputElement);
    await act(async () => {
      root.render(React.createElement(ExternalNarrationPanel, { projectId: 'Video_01', toast, refreshToken: 1 }));
    });
    await flush();
    expect((host.querySelector('input[aria-label="I listened to the whole imported narration for Long video"]') as HTMLInputElement).checked).toBe(false);
    expect(host.textContent).toContain('The approved audio is no longer the audio on disk.');
  });

  it('reloads after a failed import and still shows that import error', async () => {
    const load = vi.spyOn(api, 'externalNarration').mockResolvedValue(summary([target({ import: null, approval: null, ready: false })]) as any);
    vi.spyOn(api, 'importExternalNarration').mockRejectedValue(new Error('The narration file could not be measured.'));
    await act(async () => {
      root.render(React.createElement(ExternalNarrationPanel, { projectId: 'Video_01', toast, refreshToken: 0 }));
    });
    await flush();
    await act(async () => {
      buttonByLabel(host, 'Import external narration for Long video').click();
    });
    await flush();
    const fileInput = host.querySelector('input[aria-label="Choose the narration file for Long video"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'slima.wav', { type: 'audio/wav' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    await setValue(host.querySelector('textarea[aria-label="Exact spoken script for Long video"]') as HTMLTextAreaElement, 'The exact spoken words.');
    await setValue(host.querySelector('input[aria-label="Speaker heard in the imported narration for Long video"]') as HTMLInputElement, 'Fixture speaker');
    await check(host.querySelector('input[aria-label="I confirm I may publish the narration for Long video"]') as HTMLInputElement);
    await setValue(host.querySelector('input[aria-label="Ownership confirmation statement for Long video"]') as HTMLInputElement, 'TEST/FIXTURE');
    const callsBefore = load.mock.calls.length;
    await act(async () => {
      buttonByLabel(host, 'Import the selected narration file for Long video').click();
    });
    await flush();
    expect(load.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(host.textContent).toContain('The narration file could not be measured.');
    expect(toast).toHaveBeenCalledWith('The narration file could not be measured.', 'bad');
  });

  it('says a listening approval is not timing or publication approval', async () => {
    vi.spyOn(api, 'externalNarration').mockResolvedValue(summary([target({ approval: null, ready: false, blockReasons: ['Listen first.'] })]) as any);
    vi.spyOn(api, 'externalNarrationApproval').mockResolvedValue({ ok: true } as any);
    await act(async () => {
      root.render(React.createElement(ExternalNarrationPanel, { projectId: 'Video_01', toast }));
    });
    await flush();
    await check(host.querySelector('input[aria-label="I listened to the whole imported narration for Long video"]') as HTMLInputElement);
    await act(async () => {
      buttonByLabel(host, 'Approve the imported narration for Long video').click();
    });
    await flush();
    expect(toast).toHaveBeenCalledWith(
      'Listening approval recorded for this target. It is not timing approval and not publication approval.',
      'ok',
    );
  });

  it('names the target in the timing review', async () => {
    vi.spyOn(api, 'externalNarration').mockResolvedValue(summary() as any);
    vi.spyOn(api, 'externalNarrationTiming').mockResolvedValue({
      timing: {
        targetId: 'long',
        audioDurationSec: 24,
        timelineDurationSec: 24.4,
        endCardSeconds: 0.4,
        acousticVerification: false,
        timingReview: {
          source: 'estimated',
          review: 'not_approved',
          sourceLabel: 'Estimated timing',
          reviewLabel: 'Timing not approved',
          detail: 'Estimates are not word-accurate alignment.',
          acousticVerification: false,
        },
        scenes: [{ sceneId: 'lng_1', index: 0, startTime: 0, durationSec: 24, narration: 'Words.', timingSource: 'estimated' }],
        captions: [],
        findings: [{ code: 'TIMING-ALIGNMENT-ESTIMATED', severity: 'warning', message: 'Scene timing is estimated.', remediation: 'Review it.' }],
      },
    } as any);
    await act(async () => {
      root.render(React.createElement(ExternalNarrationPanel, { projectId: 'Video_01', toast }));
    });
    await flush();
    await act(async () => {
      buttonByLabel(host, 'Review the scene timing for Long video').click();
    });
    await flush();
    const review = host.querySelector('[data-testid="timing-review-long"]')?.textContent ?? '';
    expect(review).toContain('Timing for Long video');
    expect(review).toContain('Active audio for Long video: 24.00s measured');
    expect(review).not.toContain('voiceover/');
  });
});

describe('VS7 captions page reloads narration after an edit', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('bumps the narration refresh after a caption wording save', async () => {
    const project = {
      project: {
        meta: { input: { videoId: 'Video_01' }, status: 'storyboarded' },
        storyboard: { captions: [{ id: 'cue_1', start: 0.2, end: 2.2, text: 'Old words.', terms: [], sceneId: 'lng_1', userEdited: false }] },
        artifacts: [],
      },
      assets: [],
    };
    vi.spyOn(api, 'variants').mockResolvedValue({} as any);
    vi.spyOn(api, 'project').mockResolvedValue(project as any);
    vi.spyOn(api, 'production').mockRejectedValue(new Error('no production state'));
    vi.spyOn(api, 'targetAudio').mockResolvedValue({ targets: [], readyCount: 0, totalTargets: 0, missingCount: 0, blockedTargets: [] } as any);
    vi.spyOn(api, 'voiceAudio').mockRejectedValue(new Error('voice audio unavailable in this fixture'));
    const narration = vi.spyOn(api, 'externalNarration').mockResolvedValue(summary([target({ import: null, approval: null, ready: false })]) as any);
    vi.spyOn(api, 'patchCue').mockResolvedValue(project as any);
    const toast = vi.fn();
    await act(async () => {
      root.render(React.createElement(CaptionsPage, { projectId: 'Video_01', onNext: () => {}, onBack: () => {}, toast }));
    });
    await flush();
    const before = narration.mock.calls.length;
    expect(host.textContent).toContain('does not revoke a listening approval');
    const edit = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Edit');
    await act(async () => (edit as HTMLButtonElement).click());
    await flush();
    const input = host.querySelector('input') as HTMLInputElement;
    await setValue(input, 'New words.');
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save');
    await act(async () => (save as HTMLButtonElement).click());
    await flush();
    expect(narration.mock.calls.length).toBeGreaterThan(before);
    expect(toast).toHaveBeenCalledWith(
      'Caption updated. If this target uses imported narration, approve the timing again before export.',
      'ok',
    );
  });
});
