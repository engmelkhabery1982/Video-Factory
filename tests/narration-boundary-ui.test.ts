/**
 * @vitest-environment happy-dom
 *
 * Boundary edits stay on the same player. This is not a browser proof.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalTimingReview, type TimingReviewPayload } from '../apps/web/src/components/ExternalTimingReview.js';
import { api } from '../apps/web/src/lib/api.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function timing(): TimingReviewPayload {
  return {
    targetId: 'long',
    label: 'Long video',
    audioDurationSec: 19.1,
    timelineDurationSec: 19.1,
    endCardSeconds: 0,
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
      { sceneId: 'lng_01', index: 0, startTime: 0, durationSec: 4.89, narration: 'First.', timingSource: 'estimated' },
      { sceneId: 'lng_02', index: 1, startTime: 4.89, durationSec: 4.21, narration: 'Second.', timingSource: 'estimated' },
      { sceneId: 'lng_03', index: 2, startTime: 9.1, durationSec: 10, narration: 'Third.', timingSource: 'estimated' },
    ],
    captions: [
      { cueId: 'cap_01', sceneId: 'lng_01', start: 0, end: 4.89, text: 'First.' },
      { cueId: 'cap_02', sceneId: 'lng_02', start: 4.89, end: 9.1, text: 'Second.' },
      { cueId: 'cap_03', sceneId: 'lng_03', start: 9.1, end: 19.1, text: 'Third.' },
    ],
  };
}

class FakeAudio {
  currentSrc = 'http://127.0.0.1/api/projects/Fixture/target-audio/long/external/audio';
  readyState = 1;
  duration = 19.1;
  paused = true;
  srcAssignments = 0;
  private time = 0;
  private source = this.currentSrc;
  private listeners = new Map<string, Set<() => void>>();

  get src() { return this.source; }
  set src(value: string) {
    this.srcAssignments += 1;
    this.source = value;
    this.currentSrc = value;
  }
  get currentTime() { return this.time; }
  set currentTime(value: number) {
    this.time = value;
    queueMicrotask(() => this.emit('seeked'));
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  addEventListener(name: string, fn: () => void) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn);
    this.listeners.set(name, set);
  }
  removeEventListener(name: string, fn: () => void) {
    this.listeners.get(name)?.delete(fn);
  }
  private emit(name: string) {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const input = container.querySelector(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Input not found: ${label}`);
  return input as HTMLInputElement;
}

describe('timing boundary editor', () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.restoreAllMocks();
  });

  it('recalculates the scene duration and plays from the edited boundary on the same player', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const audio = new FakeAudio();
    await act(async () => {
      root.render(createElement(ExternalTimingReview, {
        projectId: 'Fixture',
        targetId: 'long',
        targetLabel: 'Long video',
        timing: timing(),
        audio: audio as unknown as HTMLAudioElement,
        busy: false,
        onBusy: () => undefined,
        onSaved: () => undefined,
        onError: () => undefined,
        toast: () => undefined,
      }));
    });
    const start = inputByLabel(host, 'Scene lng_02 start for Long video');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(start, '6.00');
      start.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(inputByLabel(host, 'Scene lng_02 duration for Long video').value).toBe('3.10');
    expect(inputByLabel(host, 'Caption cap_02 end for Long video').value).toBe('9.10');
    const duration = inputByLabel(host, 'Scene lng_02 duration for Long video');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(duration, '4');
      duration.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(inputByLabel(host, 'Scene lng_03 start for Long video').value).toBe('10.00');
    expect(inputByLabel(host, 'Caption cap_03 start for Long video').value).toBe('10.00');
    const button = host.querySelector('button[aria-label="Play from scene lng_02 for Long video"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(audio.currentTime).toBeGreaterThan(5.5);
    expect(audio.currentTime).toBeLessThan(7);
    expect(audio.srcAssignments).toBe(0);
    expect(host.textContent).toContain('Not acoustically verified');
  });

  it('shows a proposal without saving it, and plays the proposed start', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const audio = new FakeAudio();
    const saved = vi.fn();
    vi.spyOn(api, 'proposeNarrationBoundaries').mockResolvedValue({
      proposal: {
        available: true,
        method: 'speech_intervals',
        sourceLabel: 'Pause-aware estimate',
        detail: 'Sentence times follow measured pauses and script length. This is not word-accurate alignment and not acoustically verified.',
        verified: false,
        acousticVerification: false,
        rows: [
          { sceneId: 'lng_02', cueId: 'cap_02', text: 'Second.', proposedStart: 6, proposedDurationSec: 3.1, proposedCaptionStart: 6, proposedCaptionEnd: 8.4, warnings: [] },
        ],
        warnings: [],
      },
    });
    await act(async () => {
      root.render(createElement(ExternalTimingReview, {
        projectId: 'Fixture',
        targetId: 'long',
        targetLabel: 'Long video',
        timing: timing(),
        audio: audio as unknown as HTMLAudioElement,
        busy: false,
        onBusy: () => undefined,
        onSaved: saved,
        onError: () => undefined,
        toast: () => undefined,
      }));
    });
    await act(async () => {
      (host.querySelector('button[aria-label="Propose boundaries for Long video"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Pause-aware estimate');
    expect(host.textContent).toContain('not acoustically verified');
    expect(saved).not.toHaveBeenCalled();
    expect(inputByLabel(host, 'Scene lng_02 start for Long video').value).toBe('4.89');
    await act(async () => {
      (host.querySelector('button[aria-label="Play proposed start for lng_02"]') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(audio.currentTime).toBeGreaterThan(5.5);
    expect(audio.srcAssignments).toBe(0);
  });
});
