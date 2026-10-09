/**
 * @vitest-environment happy-dom
 *
 * VS4 — external narration import UI tests. These render and operate the REAL
 * ExternalNarrationPanel; no hand-written stand-in markup is used.
 *
 * The panel is the second narration source in this product (the first is
 * generating inside the app), so the tests check that both are offered, that
 * the declaration is explicit, that approving requires listening, and that
 * blocking reasons and estimated timing are shown honestly — never a verified
 * claim, never a filesystem path.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalNarrationPanel, type ExternalNarrationSummary } from '../apps/web/src/components/ExternalNarrationPanel.js';
import { api } from '../apps/web/src/lib/api.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function target(overrides: Record<string, unknown> = {}) {
  return {
    targetId: 'long',
    label: 'Long video',
    import: null,
    approval: null,
    ready: false,
    summary: 'blocked: IMPORT-MISSING',
    blockReasons: [],
    findings: [],
    alignment: null,
    audioDurationSec: null,
    timelineDurationSec: null,
    endCardSeconds: 8,
    timingRevision: 'rev-1',
    ...overrides,
  };
}

const nothingImported: ExternalNarrationSummary = {
  projectId: 'Video_01',
  totalTargets: 4,
  importedCount: 0,
  readyCount: 0,
  blockedCount: 0,
  targets: [target(), target({ targetId: 'short_1', label: 'Short 1', endCardSeconds: 0.3 })],
};

const importedNotApproved: ExternalNarrationSummary = {
  projectId: 'Video_01',
  totalTargets: 4,
  importedCount: 1,
  readyCount: 0,
  blockedCount: 1,
  targets: [
    target({
      import: {
        importId: 'imp_abcdef01',
        fileName: 'kaggle_narration.wav',
        durationSec: 62.4,
        scriptText: 'Every site supervisor knows that safety inspections take time.',
        scriptSha256: 'a'.repeat(64),
        declaration: {
          sourceKind: 'authorized_external_synthesis',
          ownershipConfirmed: true,
          ownershipStatement: 'Licensed vendor, invoice 1234',
          speakerName: 'Operator voice',
          engineName: 'Chatterbox',
          modelName: 'turbo',
          voiceName: 'clone-a',
        },
        alignment: {
          mode: 'estimated_from_script',
          verified: false,
          sceneCount: null,
          detail: 'Scene and caption times are ESTIMATES derived from the script.',
        },
        createdAt: '2026-10-08T10:00:00.000Z',
      },
      blockReasons: ['The imported narration has not been approved.'],
      findings: [
        {
          code: 'IMPORT-APPROVAL-MISSING',
          severity: 'error',
          message: 'The imported narration has not been approved.',
          remediation: 'Listen to the imported file and approve exactly those bytes.',
        },
      ],
      alignment: {
        mode: 'estimated_from_script',
        verified: false,
        sceneCount: null,
        detail: 'Scene and caption times are ESTIMATES derived from the script.',
      },
      audioDurationSec: 62.4,
      timelineDurationSec: 62.7,
    }),
    target({ targetId: 'short_1', label: 'Short 1', endCardSeconds: 0.3 }),
  ],
};

const approved: ExternalNarrationSummary = {
  ...importedNotApproved,
  readyCount: 1,
  blockedCount: 0,
  targets: importedNotApproved.targets.map((t) =>
    t.targetId === 'long'
      ? {
          ...t,
          ready: true,
          summary: 'approved · timeline covers 62.40s of audio',
          blockReasons: [],
          approval: {
            decision: 'approved' as const,
            listened: true,
            decidedAt: '2026-10-08T10:05:00.000Z',
            decidedBy: 'project-owner',
            timingRevision: 'rev-1',
          },
        }
      : t,
  ),
};

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


/** Check a checkbox/radio the way a user does: a real click. */
async function check(el: HTMLInputElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

/** React tracks the value: set it through the native setter so onChange fires. */
async function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('VS4: real ExternalNarrationPanel behavior', () => {
  let host: HTMLDivElement;
  let root: Root;
  let toast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    toast = vi.fn();
    vi.spyOn(api, 'externalNarration').mockResolvedValue(nothingImported as any);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  async function renderPanel(summary: ExternalNarrationSummary = nothingImported): Promise<void> {
    vi.spyOn(api, 'externalNarration').mockResolvedValue(summary as any);
    await act(async () => {
      root.render(React.createElement(ExternalNarrationPanel, { projectId: 'Video_01', toast }));
    });
    await flush();
  }

  it('offers both narration sources explicitly', async () => {
    await renderPanel();
    const text = host.textContent ?? '';
    expect(text).toContain('Generate inside the app');
    expect(text).toContain('Import from outside');
    expect(text).toContain('no local voice engine is needed');
  });

  it('says a declaration is not a rights check', async () => {
    await renderPanel();
    expect(host.textContent).toContain('It is not a rights check');
  });

  it('renders Ready and Blocked states from the real component', async () => {
    await renderPanel(importedNotApproved);
    expect(host.querySelector('[data-testid="external-narration-long"]')?.textContent).toContain('Blocked');
    expect(host.querySelector('[data-testid="external-narration-long"]')?.textContent).toContain(
      'The imported narration has not been approved.',
    );
    expect(host.querySelector('[data-testid="external-narration-short_1"]')?.textContent).toContain(
      'No imported narration',
    );
  });

  it('shows the measured duration and the declared source, not a path', async () => {
    await renderPanel(importedNotApproved);
    const text = host.querySelector('[data-testid="external-narration-long"]')?.textContent ?? '';
    expect(text).toContain('kaggle_narration.wav');
    expect(text).toContain('62.40s');
    expect(text).toContain('authorized external synthesis');
    expect(text).toContain('documented engine: Chatterbox');
    expect(text).not.toContain('C:\\');
    expect(text).not.toContain('/data/');
    expect(text).not.toContain('voiceover/');
  });

  it('labels estimated timing as estimated and never as verified', async () => {
    await renderPanel(importedNotApproved);
    expect(host.querySelector('[data-testid="external-narration-long"]')?.textContent).toContain('Estimated timing');
    expect(host.textContent).not.toContain('Aligned timing');
  });

  it('labels measured per-scene timing as aligned', async () => {
    const aligned: ExternalNarrationSummary = {
      ...importedNotApproved,
      targets: importedNotApproved.targets.map((t) =>
        t.targetId === 'long'
          ? {
              ...t,
              import: t.import
                ? {
                    ...t.import,
                    alignment: { mode: 'exact_scene_timing', verified: true, sceneCount: 4, detail: 'measured' },
                  }
                : null,
              alignment: { mode: 'exact_scene_timing', verified: true, sceneCount: 4, detail: 'measured' },
            }
          : t,
      ),
    };
    await renderPanel(aligned);
    expect(host.querySelector('[data-testid="external-narration-long"]')?.textContent).toContain('Script-matched timing');
    expect(host.textContent).not.toContain('Aligned timing');
    expect(host.textContent).not.toContain('acoustically verified');
  });

  it('requires the listening confirmation before an approval is sent', async () => {
    const approveSpy = vi.spyOn(api, 'externalNarrationApproval').mockResolvedValue({ ok: true } as any);
    await renderPanel(importedNotApproved);

    /* The button is inert until the listening confirmation is ticked. */
    expect(buttonByLabel(host, 'Approve the imported narration for Long video').disabled).toBe(true);
    await act(async () => {
      buttonByLabel(host, 'Approve the imported narration for Long video').click();
    });
    await flush();
    expect(approveSpy).not.toHaveBeenCalled();

    const checkbox = host.querySelector(
      'input[aria-label="I listened to the whole imported narration for Long video"]',
    ) as HTMLInputElement;
    await check(checkbox);
    await act(async () => {
      buttonByLabel(host, 'Approve the imported narration for Long video').click();
    });
    await flush();
    expect(approveSpy).toHaveBeenCalledWith('Video_01', 'long', {
      decision: 'approved',
      listened: true,
      decidedBy: 'project-owner',
    });
  });

  it('validates the declaration before importing', async () => {
    const importSpy = vi.spyOn(api, 'importExternalNarration').mockResolvedValue({ ok: true } as any);
    await renderPanel();

    await act(async () => {
      buttonByLabel(host, 'Import external narration for Long video').click();
    });
    await flush();

    /* No file, no script, no speaker, no ownership statement. */
    await act(async () => {
      buttonByLabel(host, 'Import the selected narration file for Long video').click();
    });
    await flush();
    expect(importSpy).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Choose the narration file to import');

    const script = host.querySelector('textarea[aria-label="Exact spoken script for Long video"]') as HTMLTextAreaElement;
    await setValue(script, 'The exact spoken words.');
    await flush();
    await act(async () => {
      buttonByLabel(host, 'Import the selected narration file for Long video').click();
    });
    await flush();
    expect(importSpy).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Choose the narration file to import');

    const speaker = host.querySelector(
      'input[aria-label="Speaker heard in the imported narration for Long video"]',
    ) as HTMLInputElement;
    await setValue(speaker, 'Operator voice');
    await flush();
    await act(async () => {
      buttonByLabel(host, 'Import the selected narration file for Long video').click();
    });
    await flush();
    expect(importSpy).not.toHaveBeenCalled();
    expect(host.textContent).toContain('authorized to publish it');
  });

  it('sends the declaration fields with the imported file', async () => {
    const importSpy = vi
      .spyOn(api, 'importExternalNarration')
      .mockImplementation(async () => {
        vi.spyOn(api, 'externalNarration').mockResolvedValue(importedNotApproved as any);
        return { ok: true, view: importedNotApproved.targets[0] } as any;
      });
    await renderPanel();

    await act(async () => {
      buttonByLabel(host, 'Import external narration for Long video').click();
    });
    await flush();

    const fileInput = host.querySelector(
      'input[aria-label="Choose the narration file for Long video"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'kaggle.wav', { type: 'audio/wav' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));

    const script = host.querySelector('textarea[aria-label="Exact spoken script for Long video"]') as HTMLTextAreaElement;
    await setValue(script, 'The exact spoken words.');
    const speaker = host.querySelector(
      'input[aria-label="Speaker heard in the imported narration for Long video"]',
    ) as HTMLInputElement;
    await setValue(speaker, 'Operator voice');
    const ownership = host.querySelector(
      'input[aria-label="I confirm I may publish the narration for Long video"]',
    ) as HTMLInputElement;
    await check(ownership);
    const statement = host.querySelector(
      'input[aria-label="Ownership confirmation statement for Long video"]',
    ) as HTMLInputElement;
    await setValue(statement, 'Licensed vendor, invoice 1234');
    const external = host.querySelector(
      'input[aria-label="Authorized external synthesis for Long video"]',
    ) as HTMLInputElement;
    await check(external);
    await flush();

    await act(async () => {
      buttonByLabel(host, 'Import the selected narration file for Long video').click();
    });
    await flush();

    expect(importSpy).toHaveBeenCalledWith('Video_01', 'long', expect.any(FormData));
    const form = importSpy.mock.calls[0][2] as FormData;
    expect(form.get('scriptText')).toBe('The exact spoken words.');
    expect(form.get('sourceKind')).toBe('authorized_external_synthesis');
    expect(form.get('ownershipConfirmed')).toBe('true');
    expect(form.get('ownershipStatement')).toBe('Licensed vendor, invoice 1234');
    expect(form.get('speakerName')).toBe('Operator voice');
    expect(form.get('file')).toBeTruthy();
  });

  it('shows the timing review with per-scene estimated timings', async () => {
    vi.spyOn(api, 'externalNarrationTiming').mockResolvedValue({
      timing: {
        targetId: 'long',
        audioDurationSec: 62.4,
        timelineDurationSec: 62.7,
        endCardSeconds: 8,
        alignmentVerified: false,
        scenes: [
          { sceneId: 'lng_1', index: 0, startTime: 0, durationSec: 6, narration: 'Hook', timingSource: 'estimated' },
          { sceneId: 'lng_2', index: 1, startTime: 6, durationSec: 8, narration: 'Body', timingSource: 'estimated' },
        ],
        findings: [],
        blockReasons: [],
      },
    } as any);
    await renderPanel(importedNotApproved);

    await act(async () => {
      buttonByLabel(host, 'Review the scene timing for Long video').click();
    });
    await flush();
    const text = host.textContent ?? '';
    expect(text).toContain('ESTIMATED scene timing (not verified alignment)');
    expect(text).toContain('lng_1');
    expect(text).toContain('estimated');
  });

  it('renders an approved target as ready with no blocking reasons', async () => {
    await renderPanel(approved);
    const text = host.querySelector('[data-testid="external-narration-long"]')?.textContent ?? '';
    expect(text).toContain('Ready');
    expect(text).toContain('Approved');
    expect(text).not.toContain('Blocked');
  });

  it('shows the server readiness summary and does not invent publication approval', async () => {
    const withReadiness: ExternalNarrationSummary = {
      ...importedNotApproved,
      targets: importedNotApproved.targets.map((item) =>
        item.targetId === 'long'
          ? {
              ...item,
              readiness: {
                applies: true,
                inheritsLongNarration: false,
                exportAttemptReady: false,
                publicationApproved: false as const,
                lines: [
                  {
                    key: 'source',
                    label: 'Audio source',
                    state: 'Imported narration for this target',
                    ok: true,
                    detail: 'kaggle_narration.wav · 62.40s measured. Server-owned source line.',
                  },
                  {
                    key: 'listening',
                    label: 'Listening approval',
                    state: 'Listening not approved',
                    ok: false,
                    detail: 'Listen to this exact file.',
                  },
                  {
                    key: 'rights',
                    label: 'Rights and consent',
                    state: 'Statement recorded',
                    ok: true,
                    detail: 'A statement is on record. It is not a legal clearance.',
                  },
                  {
                    key: 'timing',
                    label: 'Timing',
                    state: 'Estimated timing · Timing not approved',
                    ok: false,
                    detail: 'Estimated timing is not acoustic alignment. Not acoustic verification.',
                  },
                  {
                    key: 'coverage',
                    label: 'Scene coverage',
                    state: 'Spoken scenes cover the measured audio',
                    ok: true,
                    detail: 'This is not a listening check.',
                  },
                  {
                    key: 'export',
                    label: 'Export attempt',
                    state: 'Export attempt blocked',
                    ok: false,
                    detail: 'Final export is blocked. This is not a completed render.',
                  },
                  {
                    key: 'publication',
                    label: 'Publication',
                    state: 'Not publication approved',
                    ok: null,
                    detail: 'A render is not commercial-rights clearance.',
                  },
                ],
                blockers: [
                  {
                    code: 'IMPORT-APPROVAL-MISSING',
                    message: 'The imported narration has not been approved.',
                    remediation: 'Listen to the imported file and approve exactly those bytes.',
                    control: 'Approve this exact audio',
                    where: 'captions' as const,
                  },
                ],
              },
            }
          : item,
      ),
    };
    await renderPanel(withReadiness);
    const text = host.querySelector('[data-testid="external-readiness-long"]')?.textContent ?? '';
    expect(text).toContain('Server-owned source line.');
    expect(text).toContain('Listening not approved');
    expect(text).toContain('Not publication approved');
    expect(text).toContain('Approve this exact audio');
    expect(text).not.toContain('acoustically verified');
    expect(text).not.toMatch(/Publication approved/);
    expect(text).not.toContain('voiceover/');
  });
});
