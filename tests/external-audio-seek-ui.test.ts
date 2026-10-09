/**
 * Simulated player only. This is not the browser proof.
 *
 * @vitest-environment happy-dom
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalTimingReview, type TimingReviewPayload } from '../apps/web/src/components/ExternalTimingReview.js';
import { SEEK_HOLD_MS, seekSamePlayer } from '../apps/web/src/lib/audio-seek.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function timing(): TimingReviewPayload {
  return {
    targetId: 'long',
    audioDurationSec: 60,
    timelineDurationSec: 60,
    endCardSeconds: 0,
    scenes: [
      { sceneId: 'lng_1', index: 0, startTime: 10, durationSec: 30, narration: 'First fixture line.', timingSource: 'estimated' },
    ],
    captions: [
      { cueId: 'cue_1', sceneId: 'lng_1', start: 4, end: 8, text: 'First fixture line.' },
    ],
  };
}

class FakeAudio {
  currentSrc = 'http://127.0.0.1/api/projects/Fixture/target-audio/long/external/audio';
  readyState = 1;
  duration = 60;
  networkState = 1;
  paused = true;
  snapToZero = false;
  srcAssignments = 0;
  private time = 0;
  private source = this.currentSrc;
  private listeners = new Map<string, Set<() => void>>();

  get src() {
    return this.source;
  }

  set src(value: string) {
    this.srcAssignments += 1;
    this.source = value;
    this.currentSrc = value;
  }

  get currentTime() {
    return this.time;
  }

  set currentTime(value: number) {
    this.time = this.snapToZero ? 0 : value;
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

describe('seekSamePlayer', () => {
  it('keeps a successful seek and does not change the source', async () => {
    const audio = new FakeAudio();
    const result = await seekSamePlayer(audio as unknown as HTMLAudioElement, 30);
    expect(result.ok).toBe(true);
    expect(result.position).toBeCloseTo(30, 1);
    expect(audio.srcAssignments).toBe(0);
    expect(audio.currentSrc).toContain('/external/audio');
  });

  it('does not report the requested position when playback snaps back to the start', async () => {
    const audio = new FakeAudio();
    audio.snapToZero = true;
    const result = await seekSamePlayer(audio as unknown as HTMLAudioElement, 30);
    expect(result.ok).toBe(false);
    expect(result.position).toBe(0);
    expect(result.message).toMatch(/not faked|not stay/i);
  });
});

describe('Play from here display', () => {
  let root: Root;
  let host: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  it('does not show a fake position when the seek does not stick', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const audio = new FakeAudio();
    audio.snapToZero = true;
    const errors: string[] = [];
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
        onError: (message: string) => errors.push(message),
        toast: () => undefined,
      }));
    });
    const button = host.querySelector('button[aria-label="Play from scene lng_1 for Long video"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, SEEK_HOLD_MS + 80));
    });
    expect(host.querySelector('[data-testid="playback-position-long"]')?.textContent).toContain('0.00s');
    expect(host.querySelector('[data-testid="playback-position-long"]')?.textContent).not.toContain('10.00s');
    expect(host.querySelector('[data-testid="seek-error-long"]')?.textContent).toMatch(/not faked|not stay|not moved/i);
    expect(errors.length).toBeGreaterThan(0);
    expect(audio.srcAssignments).toBe(0);
  });
});
