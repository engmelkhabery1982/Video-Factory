/**
 * @vitest-environment happy-dom
 *
 * Phase 0B.1 target-audio UI tests. These render and operate the real
 * TargetAudioPanel; no hand-written stand-in markup is used.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TargetAudioPanel, type TargetAudioSummary } from '../apps/web/src/components/TargetAudioPanel.js';
import { api } from '../apps/web/src/lib/api.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sampleSummary: TargetAudioSummary = {
  projectId: 'Video_01',
  totalTargets: 4,
  readyCount: 2,
  missingCount: 2,
  blockedTargets: ['Short 2', 'Short 3'],
  targets: [
    {
      targetId: 'long', label: 'Long video', exists: true, ready: true,
      storedRef: 'voiceover/Video_01_long.mp3', fileName: 'Video_01_long.mp3', durationSec: 94.2,
      status: 'ready', message: 'Narration audio ready.',
      explanation: 'Full narrative arc (16:9). Used solely for the Long video; never reused for Shorts.',
    },
    {
      targetId: 'short_1', label: 'Short 1', exists: true, ready: true,
      storedRef: 'voiceover/Video_01_short_1.wav', fileName: 'Video_01_short_1.wav', durationSec: 31.5,
      status: 'ready', message: 'Narration audio ready.',
      explanation: 'Independent vertical narrative (9:16) for Short 1. Requires its own dedicated audio.',
    },
    {
      targetId: 'short_2', label: 'Short 2', exists: true, ready: false,
      storedRef: null, fileName: null, durationSec: null,
      status: 'missing', message: 'Narration audio missing. This target is blocked at export.',
      explanation: 'Independent vertical narrative (9:16) for Short 2. Requires its own dedicated audio.',
    },
    {
      targetId: 'short_3', label: 'Short 3', exists: true, ready: false,
      storedRef: null, fileName: null, durationSec: null,
      status: 'missing', message: 'Narration audio missing. This target is blocked at export.',
      explanation: 'Independent vertical narrative (9:16) for Short 3. Requires its own dedicated audio.',
    },
  ],
};

const short2Ready: TargetAudioSummary = {
  ...sampleSummary,
  readyCount: 3,
  missingCount: 1,
  blockedTargets: ['Short 3'],
  targets: sampleSummary.targets.map((target) => target.targetId === 'short_2'
    ? {
        ...target,
        ready: true,
        status: 'ready' as const,
        storedRef: 'voiceover/Video_01_short_2_abcdef123456.wav',
        fileName: 'Video_01_short_2_abcdef123456.wav',
        durationSec: 22,
        message: 'Narration audio ready.',
      }
    : target),
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

describe('Phase 0B.1: real TargetAudioPanel behavior', () => {
  let host: HTMLDivElement;
  let root: Root;
  let toast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    toast = vi.fn();
    vi.spyOn(api, 'targetAudio').mockResolvedValue(sampleSummary as any);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  async function renderPanel(summary = sampleSummary): Promise<void> {
    await act(async () => {
      root.render(React.createElement(TargetAudioPanel, { projectId: 'Video_01', toast, initialSummary: summary }));
    });
    await flush();
  }

  it('renders Ready and Missing states from the real component', async () => {
    await renderPanel();
    expect(host.textContent).toContain('2 of 4 narration tracks ready');
    expect(host.textContent).toContain('Short 2, Short 3');
    expect(host.querySelector('[data-testid="target-audio-long"]')?.textContent).toContain('Ready');
    expect(host.querySelector('[data-testid="target-audio-short_2"]')?.textContent).toContain('Missing audio');
  });

  it('exposes real upload, replace and remove actions without path or JSON fields', async () => {
    await renderPanel();
    expect(buttonByLabel(host, 'Upload narration audio for Short 2')).toBeTruthy();
    expect(buttonByLabel(host, 'Replace narration audio for Long video')).toBeTruthy();
    expect(buttonByLabel(host, 'Remove narration audio for Long video')).toBeTruthy();
    expect(host.querySelector('input[type="text"]')).toBeNull();
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.textContent).not.toContain('C:\\');
    expect(host.textContent).not.toContain('/data/');
  });

  it('a successful upload updates the selected target in the real UI', async () => {
    vi.spyOn(api, 'uploadTargetAudio').mockResolvedValue({
      ok: true,
      message: 'Regenerate the storyboard to apply the new audio timing.',
      summary: short2Ready,
    } as any);
    await renderPanel();

    const input = host.querySelector('input[aria-label="Upload narration audio for Short 2"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'short2.wav', { type: 'audio/wav' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();

    expect(api.uploadTargetAudio).toHaveBeenCalledWith('Video_01', 'short_2', expect.any(FormData));
    expect(host.querySelector('[data-testid="target-audio-short_2"]')?.textContent).toContain('Ready');
    expect(host.textContent).toContain('3 of 4 narration tracks ready');
  });

  it('a real upload failure displays the component error state', async () => {
    vi.spyOn(api, 'uploadTargetAudio').mockRejectedValue(new Error('Upload failed: invalid audio stream.'));
    await renderPanel();
    const input = host.querySelector('input[aria-label="Upload narration audio for Short 2"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File([new Uint8Array([9])], 'bad.wav', { type: 'audio/wav' })],
    });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();
    expect(host.textContent).toContain('Upload failed: invalid audio stream.');
    expect(toast).toHaveBeenCalledWith('Upload failed: invalid audio stream.', 'bad');
  });

  it('Remove opens a named confirmation and Cancel makes no DELETE call', async () => {
    vi.spyOn(api, 'deleteTargetAudio').mockResolvedValue({ summary: sampleSummary } as any);
    await renderPanel();
    await act(async () => buttonByLabel(host, 'Remove narration audio for Long video').click());
    const dialog = host.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Remove Long video narration?');
    expect(dialog?.textContent).toContain('Other narration tracks stay unchanged.');
    const cancel = [...dialog!.querySelectorAll('button')].find((button) => button.textContent === 'Cancel') as HTMLButtonElement;
    await act(async () => cancel.click());
    expect(api.deleteTargetAudio).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('confirming removal calls DELETE only for the selected target', async () => {
    vi.spyOn(api, 'deleteTargetAudio').mockResolvedValue({
      ok: true,
      summary: {
        ...sampleSummary,
        readyCount: 1,
        missingCount: 3,
        blockedTargets: ['Long video', 'Short 2', 'Short 3'],
        targets: sampleSummary.targets.map((target) => target.targetId === 'long'
          ? { ...target, ready: false, status: 'missing' as const, storedRef: null, fileName: null, durationSec: null }
          : target),
      },
    } as any);
    await renderPanel();
    await act(async () => buttonByLabel(host, 'Remove narration audio for Long video').click());
    await act(async () => buttonByLabel(host, 'Confirm removal of narration audio for Long video').click());
    await flush();
    expect(api.deleteTargetAudio).toHaveBeenCalledTimes(1);
    expect(api.deleteTargetAudio).toHaveBeenCalledWith('Video_01', 'long');
    expect(host.querySelector('[data-testid="target-audio-short_1"]')?.textContent).toContain('Ready');
  });

  it('busy upload state disables conflicting target actions', async () => {
    let completeUpload!: (value: unknown) => void;
    vi.spyOn(api, 'uploadTargetAudio').mockImplementation(() => new Promise((resolve) => { completeUpload = resolve; }) as any);
    await renderPanel();
    const input = host.querySelector('input[aria-label="Upload narration audio for Short 2"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File([new Uint8Array([1])], 'pending.wav', { type: 'audio/wav' })],
    });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(buttonByLabel(host, 'Replace narration audio for Long video').disabled).toBe(true);
    expect(buttonByLabel(host, 'Remove narration audio for Long video').disabled).toBe(true);
    expect(host.textContent).toContain('Uploading…');

    completeUpload({ ok: true, summary: short2Ready });
    await flush();
  });

  it('cleanup warnings are shown after an otherwise successful removal', async () => {
    vi.spyOn(api, 'deleteTargetAudio').mockResolvedValue({
      ok: true,
      cleanupWarning: 'Audio reference cleared, but the physical file could not be deleted.',
      summary: sampleSummary,
    } as any);
    await renderPanel();
    await act(async () => buttonByLabel(host, 'Remove narration audio for Long video').click());
    await act(async () => buttonByLabel(host, 'Confirm removal of narration audio for Long video').click());
    await flush();
    expect(host.textContent).toContain('physical file could not be deleted');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('physical file could not be deleted'), 'info');
  });
});
