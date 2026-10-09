/**
 * @vitest-environment happy-dom
 *
 * VS5 — the real timing controls inside ExternalNarrationPanel.
 * happy-dom is not a browser acceptance pass.
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
    import: {
      importId: 'imp_abcdef01',
      fileName: 'fixture.wav',
      durationSec: 10,
      scriptText: 'First sentence. Second sentence.',
      scriptSha256: 'a'.repeat(64),
      declaration: {
        sourceKind: 'own_recording',
        ownershipConfirmed: true,
        ownershipStatement: 'TEST/FIXTURE',
        speakerName: 'Fixture speaker',
      },
      alignment: { mode: 'estimated_from_script', verified: false, sceneCount: null, detail: 'estimates' },
      createdAt: '2026-10-08T10:00:00.000Z',
    },
    approval: { decision: 'approved', listened: true, decidedAt: '2026-10-08T10:05:00.000Z', decidedBy: 'project-owner', timingRevision: 'rev-1' },
    ready: false,
    summary: 'blocked: TIMING-APPROVAL-MISSING',
    blockReasons: ['The caption and scene timing has not been approved for this narration.'],
    findings: [],
    alignment: { mode: 'estimated_from_script', verified: false, sceneCount: null, detail: 'estimates' },
    audioDurationSec: 10,
    timelineDurationSec: 12,
    endCardSeconds: 8,
    timingRevision: 'rev-1',
    ...overrides,
  };
}

const summary: ExternalNarrationSummary = {
  projectId: 'Video_01',
  totalTargets: 1,
  importedCount: 1,
  readyCount: 0,
  blockedCount: 1,
  targets: [target()],
};

const timing = {
  targetId: 'long',
  audioDurationSec: 10,
  timelineDurationSec: 12,
  endCardSeconds: 8,
  alignmentVerified: false,
  acousticVerification: false,
  timingReview: {
    source: 'estimated',
    review: 'not_approved',
    sourceLabel: 'Estimated timing',
    reviewLabel: 'Timing not approved',
    detail: 'Scene and caption times are estimates from the script and the measured duration. They are not word-accurate alignment.',
    acousticVerification: false,
  },
  scenes: [
    { sceneId: 'lng_1', index: 0, startTime: 0, durationSec: 4, narration: 'First sentence.', timingSource: 'estimated' },
    { sceneId: 'lng_2', index: 1, startTime: 4, durationSec: 6, narration: 'Second sentence.', timingSource: 'estimated' },
  ],
  captions: [
    { cueId: 'cue_1', sceneId: 'lng_1', start: 0.1, end: 3.5, text: 'First sentence.' },
    { cueId: 'cue_2', sceneId: 'lng_2', start: 4.1, end: 9.5, text: 'Second sentence.' },
  ],
  findings: [],
  blockReasons: [],
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

async function setValue(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('VS5: timing review controls', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(api, 'externalNarration').mockResolvedValue(summary as any);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  async function openReview() {
    vi.spyOn(api, 'externalNarrationTiming').mockResolvedValue({ timing } as any);
    await act(async () => {
        root.render(React.createElement(ExternalNarrationPanel, { projectId: 'Video_01', toast: vi.fn() }));
    });
    await flush();
    await act(async () => {
      buttonByLabel(host, 'Review the scene timing for Long video').click();
    });
    await flush();
  }

  it('shows estimated timing, playback position, and does not claim acoustic verification', async () => {
    await openReview();
    const text = host.textContent ?? '';
    expect(text).toContain('ESTIMATED scene timing (not verified alignment)');
    expect(text).toContain('Estimated timing');
    expect(text).toContain('Timing not approved');
    expect(text).toContain('Not acoustically verified');
    expect(text).toContain('Playback position: 0.00s');
    expect(host.querySelector('[data-testid="playback-position-long"]')).toBeTruthy();
  });

  it('saves an edited caption time and restores the returned review', async () => {
    const save = vi.spyOn(api, 'saveExternalNarrationTiming').mockResolvedValue({
      timing: { ...timing, captions: [{ ...timing.captions[0], end: 3.1 }, timing.captions[1]] },
    } as any);
    await openReview();
    const input = host.querySelector('input[aria-label="Caption cue_1 end for Long video"]') as HTMLInputElement;
    await setValue(input, '3.10');
    await act(async () => {
      buttonByLabel(host, 'Save timing for Long video').click();
    });
    await flush();
    expect(save).toHaveBeenCalledWith('Video_01', 'long', {
      scenes: [
        { sceneId: 'lng_1', startTime: 0, durationSec: 4 },
        { sceneId: 'lng_2', startTime: 4, durationSec: 6 },
      ],
      captions: [
        { cueId: 'cue_1', start: 0.1, end: 3.1 },
        { cueId: 'cue_2', start: 4.1, end: 9.5 },
      ],
    });
    expect((host.querySelector('input[aria-label="Caption cue_1 end for Long video"]') as HTMLInputElement).value).toBe('3.10');
  });

  it('previews from a caption boundary by seeking the player', async () => {
    await openReview();
    const audio = host.querySelector('audio[aria-label="Listen to the imported narration for Long video"]') as HTMLAudioElement;
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 1 });
    Object.defineProperty(audio, 'duration', { configurable: true, value: 10 });
    audio.play = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      buttonByLabel(host, 'Play from caption cue_2 for Long video').click();
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(audio.currentTime).toBeCloseTo(4.1, 2);
    expect(host.querySelector('[data-testid="playback-position-long"]')?.textContent).toContain('4.10s');
    expect(audio.getAttribute('src')).toBe('/api/projects/Video_01/target-audio/long/external/audio');
  });

  it('does not send a timing approval until the review is confirmed', async () => {
    const approve = vi.spyOn(api, 'approveExternalNarrationTiming').mockResolvedValue({ timing } as any);
    await openReview();
    expect(buttonByLabel(host, 'Approve timing for Long video').disabled).toBe(true);
    await act(async () => {
      buttonByLabel(host, 'Approve timing for Long video').click();
    });
    expect(approve).not.toHaveBeenCalled();
    const checkbox = host.querySelector('input[aria-label="I reviewed the timing against the audio for Long video"]') as HTMLInputElement;
    await act(async () => checkbox.click());
    await flush();
    await act(async () => {
      buttonByLabel(host, 'Approve timing for Long video').click();
    });
    await flush();
    expect(approve).toHaveBeenCalledWith('Video_01', 'long', {
      decision: 'approved',
      reviewed: true,
      decidedBy: 'project-owner',
    });
  });

  it('shows a server validation error on the review', async () => {
    vi.spyOn(api, 'validateExternalNarrationTiming').mockRejectedValue(Object.assign(new Error('Caption cue_1 overlaps cue_2.'), {
      payload: { issues: [{ message: 'Caption cue_1 overlaps cue_2.', remediation: 'Move the captions so they do not overlap.' }] },
    }));
    await openReview();
    await act(async () => {
      buttonByLabel(host, 'Check timing for Long video').click();
    });
    await flush();
    expect(host.textContent).toContain('Caption cue_1 overlaps cue_2.');
    expect(host.textContent).toContain('Move the captions so they do not overlap.');
  });
});
