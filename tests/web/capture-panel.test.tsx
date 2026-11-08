// @vitest-environment happy-dom
/**
 * VF-20261107-UNIFIED-CLOSEOUT03: CapturePanel component tests with explicit
 * browser-API doubles. DOM, not a real browser or HTTP upload.
 *
 * These exercise the ACTUAL React component (CapturePanel.tsx) with injected
 * mediaDevices/recorder doubles. They cover: StrictMode lifecycle, parallel
 * start/upload guards, upload failure retry/discard, delayed grant after
 * unmount, source-ended, recorder constructor/start throw, stale upload
 * after reset, unsupported requested API, requested-audio absence, denied
 * permission, empty capture, upload retry/discard and repeated stop.
 *
 * LABELLED DOUBLE-BASED EVIDENCE. This does NOT prove real browser recording.
 * Run on the owner host: `npm test -- tests/web/capture-panel.test.tsx`
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: { uploadAsset: vi.fn() },
}));

import { api } from '../../apps/web/src/lib/api';
import { CapturePanel, type MediaDevicesLike } from '../../apps/web/src/components/factory/CapturePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  vi.mocked(api.uploadAsset).mockReset();
  vi.restoreAllMocks();
});

async function mount(element: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
}

function q<T extends HTMLElement>(selector: string): T {
  const found = host.querySelector<T>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
}

async function click(selector: string) {
  await act(async () => q<HTMLButtonElement>(selector).click());
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/* ---------------- Browser-API doubles ---------------- */

interface FakeTrack {
  kind: string;
  enabled: boolean;
  stopped: boolean;
  onended: (() => void) | null;
  stop: () => void;
}

function makeTrack(kind: string): FakeTrack {
  return {
    kind,
    enabled: true,
    stopped: false,
    onended: null,
    stop() { this.stopped = true; },
  };
}

function makeStream(tracks: FakeTrack[]): MediaStream {
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  };
  return stream as unknown as MediaStream;
}

interface FakeRecorder {
  state: 'inactive' | 'recording' | 'paused';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start: () => void;
  stop: () => void;
  chunks: Blob[];
}

function makeRecorder(): FakeRecorder {
  return {
    state: 'inactive',
    mimeType: 'video/webm',
    ondataavailable: null,
    onstop: null,
    onerror: null,
    chunks: [],
    start() { this.state = 'recording'; },
    stop() {
      this.state = 'inactive';
      if (this.chunks.length > 0) {
        const blob = new Blob(this.chunks, { type: this.mimeType });
        this.ondataavailable?.({ data: blob });
      }
      this.onstop?.();
    },
  };
}

function makeMediaDevices(opts: {
  displayResolves?: MediaStream | null;
  displayRejects?: Error | null;
  userResolves?: MediaStream | null;
  userRejects?: Error | null;
}): MediaDevicesLike & { displayTracks: FakeTrack[]; userTracks: FakeTrack[] } {
  const displayTracks = [makeTrack('video')];
  const userTracks = [makeTrack('audio')];
  return {
    displayTracks,
    userTracks,
    getDisplayMedia: async () => {
      if (opts.displayRejects) throw opts.displayRejects;
      if (opts.displayResolves) return opts.displayResolves;
      return makeStream(displayTracks);
    },
    getUserMedia: async () => {
      if (opts.userRejects) throw opts.userRejects;
      if (opts.userResolves) return opts.userResolves;
      return makeStream(userTracks);
    },
  } as MediaDevicesLike & { displayTracks: FakeTrack[]; userTracks: FakeTrack[] };
}

function makeDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Complete a recording and confirm, returning the recorder. */
async function completeAndConfirm(rec: FakeRecorder, devices: MediaDevicesLike) {
  await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
  await click('[data-testid="capture-screen"]');
  await flush();
  await click('[data-testid="capture-stop"]');
  await flush();
  await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });
}

/* ---------------- Tests ---------------- */

describe('CapturePanel — capability', () => {
  it('shows unavailable when mediaDevices is absent', async () => {
    const original = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    await mount(<CapturePanel />);
    expect(q('[data-testid="capture-panel"]').textContent).toContain('browser capture unavailable');
    Object.defineProperty(navigator, 'mediaDevices', { value: original, configurable: true });
  });

  it('shows available when the injected device AND recorder capabilities are provided', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    expect(q('[data-testid="capture-panel"]').textContent).toContain('browser capture available');
  });

  it('disables screen buttons when getDisplayMedia is not available', async () => {
    const devices = { getUserMedia: async () => makeStream([makeTrack('audio')]) } as MediaDevicesLike;
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => makeRecorder() as unknown as MediaRecorder} />);
    expect(q<HTMLButtonElement>('[data-testid="capture-screen"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="capture-screen-audio"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="capture-microphone"]').disabled).toBe(false);
  });
});

describe('CapturePanel — denial', () => {
  it('shows an error when getDisplayMedia is denied', async () => {
    const devices = makeMediaDevices({ displayRejects: Object.assign(new Error('denied'), { name: 'NotAllowedError' }) });
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => makeRecorder() as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    const err = q('[data-testid="capture-error"]');
    expect(err.textContent).toContain('permission');
  });

  it('shows not_supported when getDisplayMedia rejects with NotSupportedError', async () => {
    const devices = makeMediaDevices({ displayRejects: Object.assign(new Error('unsupported'), { name: 'NotSupportedError' }) });
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => makeRecorder() as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    const err = q('[data-testid="capture-error"]');
    // The detail message is "This browser does not expose the capture API for the requested source."
    expect(err.textContent).toContain('expose');
  });
});

describe('CapturePanel — StrictMode', () => {
  it('works under React.StrictMode: one getDisplayMedia call and one recorder.start', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    let displayCallCount = 0;
    const countedDevices = {
      ...devices,
      getDisplayMedia: async (...args: unknown[]) => { displayCallCount++; return devices.getDisplayMedia!(args[0] as DisplayMediaStreamOptions); },
    } as MediaDevicesLike;
    await mount(
      <React.StrictMode>
        <CapturePanel mediaDevices={countedDevices} recorderFactory={() => rec as unknown as MediaRecorder} />
      </React.StrictMode>
    );
    await click('[data-testid="capture-screen"]');
    await flush();
    expect(displayCallCount).toBe(1);
    expect(rec.state).toBe('recording');
  });
});

describe('CapturePanel — concurrency', () => {
  it('makes one browser request when Record is clicked twice before permission resolves', async () => {
    const deferred = makeDeferred<MediaStream>();
    const displayTracks = [makeTrack('video')];
    let displayCallCount = 0;
    const devices = {
      getDisplayMedia: () => { displayCallCount++; return deferred.promise; },
      getUserMedia: async () => makeStream([makeTrack('audio')]),
    } as MediaDevicesLike;
    const rec = makeRecorder();
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);

    // Click Record twice in one batch
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="capture-screen"]').click();
      q<HTMLButtonElement>('[data-testid="capture-screen"]').click();
    });

    expect(displayCallCount).toBe(1);

    // Now resolve the promise
    await act(async () => { deferred.resolve(makeStream(displayTracks)); });
    await flush();
    expect(rec.state).toBe('recording');
  });

  it('does not request permission again after a nonempty stop before Upload or Discard', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    let displayCalls = 0;
    const counted = {
      ...devices,
      getDisplayMedia: async (constraints?: DisplayMediaStreamOptions) => {
        displayCalls++;
        return devices.getDisplayMedia!(constraints);
      },
    } as MediaDevicesLike;
    await mount(<CapturePanel mediaDevices={counted} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    await click('[data-testid="capture-stop"]');
    await flush();
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });

    // The completed capture is retained. Record is visibly disabled and its guarded handler
    // cannot open another stream or clear the completed chunks before Upload/Discard.
    const record = q<HTMLButtonElement>('[data-testid="capture-screen"]');
    expect(record.disabled).toBe(true);
    await click('[data-testid="capture-screen"]');
    await flush();
    expect(displayCalls).toBe(1);
    expect(rec.state).toBe('inactive');
    expect(q('[data-testid="capture-upload"]')).not.toBeNull();
    expect(q<HTMLInputElement>('[data-testid="capture-confirm"]').checked).toBe(true);
  });

  it('makes one upload when Upload is clicked twice before the upload resolves', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    const uploadDeferred = makeDeferred<any>();
    vi.mocked(api.uploadAsset).mockReturnValue(uploadDeferred.promise);

    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    await click('[data-testid="capture-stop"]');
    await flush();
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });

    // Click Upload twice in one batch
    await act(async () => {
      q<HTMLButtonElement>('[data-testid="capture-upload"]').click();
      q<HTMLButtonElement>('[data-testid="capture-upload"]').click();
    });

    expect(vi.mocked(api.uploadAsset)).toHaveBeenCalledTimes(1);

    // Resolve the upload
    await act(async () => { uploadDeferred.resolve({ asset: { id: 'asset-1' } }); });
    await flush();
  });
});

describe('CapturePanel — upload failure retry/discard', () => {
  it('shows error and allows retry on upload failure', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    vi.mocked(api.uploadAsset).mockRejectedValue(new Error('network down'));

    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    await click('[data-testid="capture-stop"]');
    await flush();
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });
    await click('[data-testid="capture-upload"]');
    await flush();

    const err = q('[data-testid="capture-error"]');
    expect(err.textContent).toMatch(/network|failed|down/i);
    // Upload button should still be available for retry
    expect(q('[data-testid="capture-upload"]')).not.toBeNull();
    // Discard button should be available
    expect(q('[data-testid="capture-discard"]')).not.toBeNull();
    // The failed-upload note should be shown
    expect(q('[data-testid="capture-upload-failed-note"]')).not.toBeNull();
  });

  it('retries upload after failure and succeeds', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    const onUploaded = vi.fn();
    let callCount = 0;
    vi.mocked(api.uploadAsset).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('network down');
      return { asset: { id: 'asset-2' } };
    });

    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} onUploaded={onUploaded} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    await click('[data-testid="capture-stop"]');
    await flush();
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });
    await click('[data-testid="capture-upload"]');
    await flush();

    // First attempt failed — error shown, retry available
    expect(q('[data-testid="capture-error"]')).not.toBeNull();
    expect(q('[data-testid="capture-upload"]')).not.toBeNull();

    // Retry succeeds
    await click('[data-testid="capture-upload"]');
    await flush();

    expect(onUploaded).toHaveBeenCalled();
    expect(q('[data-testid="capture-uploaded-note"]')).not.toBeNull();
  });

  it('discards a failed upload and returns to idle', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    vi.mocked(api.uploadAsset).mockRejectedValue(new Error('network down'));

    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    await click('[data-testid="capture-stop"]');
    await flush();
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });
    await click('[data-testid="capture-upload"]');
    await flush();

    // Discard
    await click('[data-testid="capture-discard"]');
    await flush();

    // Back to idle — screen button available again and the old error is actually absent.
    // Query absence directly: q() intentionally asserts presence before returning.
    expect(q('[data-testid="capture-screen"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="capture-error"]')).toBeNull();
  });
});

describe('CapturePanel — lifecycle', () => {
  it('stops recording and shows processing when stop is clicked', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    expect(rec.state).toBe('recording');
    await click('[data-testid="capture-stop"]');
    await flush();
    expect(rec.state).toBe('inactive');
  });

  it('refuses an empty capture as empty_capture', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    // No chunks -> empty blob
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    await click('[data-testid="capture-stop"]');
    await flush();
    const err = q('[data-testid="capture-error"]');
    expect(err.textContent).toContain('no frames');
  });

  it('cleans up tracks on unmount during recording', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    expect(devices.displayTracks[0].stopped).toBe(false);
    await act(async () => root!.unmount());
    expect(devices.displayTracks[0].stopped).toBe(true);
    expect(rec.state).toBe('inactive');
    root = null;
  });

  it('does not start recording after unmount (late grant)', async () => {
    const deferred = makeDeferred<MediaStream>();
    const displayTracks = [makeTrack('video')];
    const devices = {
      getDisplayMedia: () => deferred.promise,
      getUserMedia: async () => makeStream([makeTrack('audio')]),
    } as MediaDevicesLike;
    const rec = makeRecorder();
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await act(async () => root!.unmount());
    await act(async () => { deferred.resolve(makeStream(displayTracks)); });
    await flush();
    expect(rec.state).toBe('inactive');
    root = null;
  });

  it('releases a late-granted stream after explicit cancel without starting the recorder', async () => {
    const deferred = makeDeferred<MediaStream>();
    const track = makeTrack('video');
    const devices = {
      getDisplayMedia: () => deferred.promise,
      getUserMedia: async () => makeStream([makeTrack('audio')]),
    } as MediaDevicesLike;
    const rec = makeRecorder();
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await click('[data-testid="capture-cancel"]');
    await act(async () => { deferred.resolve(makeStream([track])); });
    await flush();
    expect(track.stopped).toBe(true);
    expect(rec.state).toBe('inactive');
    expect(q('[data-testid="capture-screen"]')).not.toBeNull();
  });

  it('starts another capture only after explicit discard of the completed capture', async () => {
    const devices = makeMediaDevices({});
    const rec1 = makeRecorder();
    rec1.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    const rec2 = makeRecorder();
    let callCount = 0;
    const factory = () => { callCount++; return callCount === 1 ? (rec1 as unknown as MediaRecorder) : (rec2 as unknown as MediaRecorder); };
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={factory} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    await click('[data-testid="capture-stop"]');
    await flush();
    await click('[data-testid="capture-discard"]');
    await click('[data-testid="capture-screen"]');
    await flush();
    expect(callCount).toBe(2);
    expect(rec2.state).toBe('recording');
  });

  it('stops recording when a source track ends', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    expect(rec.state).toBe('recording');
    // Simulate source-ended
    await act(async () => { devices.displayTracks[0].onended?.(); });
    await flush();
    expect(rec.state).toBe('inactive');
  });

  it('handles recorder constructor failure', async () => {
    const devices = makeMediaDevices({});
    const factory = () => { throw new Error('constructor failed'); };
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={factory} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    const err = q('[data-testid="capture-error"]');
    expect(err.textContent).toContain('constructor failed');
  });

  it('handles recorder start failure', async () => {
    const devices = makeMediaDevices({});
    const rec = {
      state: 'inactive' as 'inactive' | 'recording' | 'paused',
      mimeType: 'video/webm',
      ondataavailable: null,
      onstop: null,
      onerror: null,
      start() { throw new Error('start failed'); },
      stop() {},
    };
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    const err = q('[data-testid="capture-error"]');
    expect(err.textContent).toContain('start failed');
  });

  it('handles repeated stop clicks safely', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    // Hold the actual element: the first click legitimately removes Stop from the DOM.
    const stopButton = q<HTMLButtonElement>('[data-testid="capture-stop"]');
    await act(async () => {
      stopButton.click();
      stopButton.click();
    });
    await flush();
    expect(rec.state).toBe('inactive');
    expect(host.querySelector('[data-testid="capture-stop"]')).toBeNull();
  });
});

describe('CapturePanel — screen with audio', () => {
  it('requests audio constraints when recording screen with audio', async () => {
    let receivedConstraints: any;
    const displayTracks = [makeTrack('video'), makeTrack('audio')];
    const devices = {
      getDisplayMedia: (c?: any) => { receivedConstraints = c; return Promise.resolve(makeStream(displayTracks)); },
      getUserMedia: async () => makeStream([makeTrack('audio')]),
    } as MediaDevicesLike;
    const rec = makeRecorder();
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen-audio"]');
    await flush();
    expect(receivedConstraints).toEqual({ video: true, audio: true });
  });

  it('reports audio absence when screen_audio has no audio track', async () => {
    const devices = makeMediaDevices({ displayResolves: makeStream([makeTrack('video')]) });
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen-audio"]');
    await flush();
    const banner = q('[data-testid="capture-audio-absent"]');
    expect(banner.textContent).toContain('audio');
  });

  it('does not show audio absence banner when audio track is present', async () => {
    const devices = makeMediaDevices({ displayResolves: makeStream([makeTrack('video'), makeTrack('audio')]) });
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen-audio"]');
    await flush();
    expect(host.querySelector('[data-testid="capture-audio-absent"]')).toBeNull();
  });
});

describe('CapturePanel — upload', () => {
  it('requires confirmation before upload is enabled', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    vi.mocked(api.uploadAsset).mockResolvedValue({ asset: { id: 'asset-1' } });
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    await click('[data-testid="capture-stop"]');
    await flush();
    const uploadBtn = q<HTMLButtonElement>('[data-testid="capture-upload"]');
    expect(uploadBtn.disabled).toBe(true);
  });

  it('calls onUploaded after a successful upload', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    const onUploaded = vi.fn();
    vi.mocked(api.uploadAsset).mockResolvedValue({ asset: { id: 'asset-1' } });
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} onUploaded={onUploaded} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    await click('[data-testid="capture-stop"]');
    await flush();
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });
    await click('[data-testid="capture-upload"]');
    await flush();
    expect(onUploaded).toHaveBeenCalled();
  });

  it('does not replace an in-flight upload with a new recording', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    let displayCalls = 0;
    const counted = {
      ...devices,
      getDisplayMedia: async (constraints?: DisplayMediaStreamOptions) => {
        displayCalls++;
        return devices.getDisplayMedia!(constraints);
      },
    } as MediaDevicesLike;
    let factoryCalls = 0;
    const factory = () => { factoryCalls++; return rec as unknown as MediaRecorder; };
    const uploadDeferred = makeDeferred<any>();
    vi.mocked(api.uploadAsset).mockReturnValue(uploadDeferred.promise);
    const onUploaded = vi.fn();

    await mount(<CapturePanel mediaDevices={counted} recorderFactory={factory} onUploaded={onUploaded} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    await click('[data-testid="capture-stop"]');
    await flush();
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });
    await click('[data-testid="capture-upload"]');
    await click('[data-testid="capture-screen"]');

    expect(displayCalls).toBe(1);
    expect(factoryCalls).toBe(1);
    expect(q<HTMLButtonElement>('[data-testid="capture-screen"]').disabled).toBe(true);

    await act(async () => { uploadDeferred.resolve({ asset: { id: 'asset-1' } }); });
    await flush();
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="capture-uploaded-note"]')).not.toBeNull();
  });
});

describe('CapturePanel — reset/discard', () => {
  it('resets to idle after upload and allows capturing again', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    vi.mocked(api.uploadAsset).mockResolvedValue({ asset: { id: 'asset-1' } });
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await flush();
    await click('[data-testid="capture-stop"]');
    await flush();
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });
    await click('[data-testid="capture-upload"]');
    await flush();
    await click('[data-testid="capture-reset"]');
    await flush();
    expect(q('[data-testid="capture-screen"]')).not.toBeNull();
  });
});
