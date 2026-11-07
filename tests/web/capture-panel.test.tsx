// @vitest-environment happy-dom
/**
 * VF-20261107-UNIFIED-CLOSEOUT02: CapturePanel component tests with explicit
 * browser-API doubles. DOM, not a real browser or HTTP upload.
 *
 * These exercise the ACTUAL React component (CapturePanel.tsx) with injected
 * mediaDevices/recorder doubles. They cover: denial, late grant after
 * unmount/cancel, repeated start/stop/upload, track cleanup, empty capture,
 * upload failure/retry, unsupported capabilities and requested-audio absence.
 *
 * LABELLED DOUBLE-BASED EVIDENCE. This does NOT prove real browser recording.
 * Run on the owner host: `npm test -- tests/web/capture-panel.test.tsx`
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapturePanel } from '../../apps/web/src/components/factory/CapturePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
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

/* ---------------- Browser-API doubles ---------------- */

interface FakeTrack {
  kind: string;
  enabled: boolean;
  stopped: boolean;
  stop: () => void;
}

function makeTrack(kind: string): FakeTrack {
  const track = { kind, enabled: true, stopped: false };
  return {
    ...track,
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
}): { getDisplayMedia: () => Promise<MediaStream>; getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>; displayTracks: FakeTrack[]; userTracks: FakeTrack[] } {
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
  };
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

  it('shows available when mediaDevices and MediaRecorder exist', async () => {
    const devices = makeMediaDevices({});
    await mount(<CapturePanel mediaDevices={devices} />);
    expect(q('[data-testid="capture-panel"]').textContent).toContain('browser capture available');
  });
});

describe('CapturePanel — denial', () => {
  it('shows an error when getDisplayMedia is denied', async () => {
    const devices = makeMediaDevices({ displayRejects: Object.assign(new Error('denied'), { name: 'NotAllowedError' }) });
    await mount(<CapturePanel mediaDevices={devices} />);
    await click('[data-testid="capture-screen"]');
    const err = q('[data-testid="capture-error"]');
    expect(err.textContent).toContain('permission');
  });

  it('shows not_supported when getDisplayMedia rejects with NotSupportedError', async () => {
    const devices = makeMediaDevices({ displayRejects: Object.assign(new Error('unsupported'), { name: 'NotSupportedError' }) });
    await mount(<CapturePanel mediaDevices={devices} />);
    await click('[data-testid="capture-screen"]');
    const err = q('[data-testid="capture-error"]');
    expect(err.textContent).toContain('support');
  });
});

describe('CapturePanel — lifecycle', () => {
  it('stops recording and shows processing when stop is clicked', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await act(async () => { await Promise.resolve(); });
    expect(rec.state).toBe('recording');
    await click('[data-testid="capture-stop"]');
    await act(async () => { await Promise.resolve(); });
    expect(rec.state).toBe('inactive');
  });

  it('refuses an empty capture as empty_capture', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    // No data available -> empty blob
    rec.ondataavailable = null;
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await act(async () => { await Promise.resolve(); });
    await click('[data-testid="capture-stop"]');
    await act(async () => { await Promise.resolve(); });
    const err = q('[data-testid="capture-error"]');
    expect(err.textContent).toContain('no frames');
  });

  it('cleans up tracks on unmount during recording', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await act(async () => { await Promise.resolve(); });
    expect(devices.displayTracks[0].stopped).toBe(false);
    // Unmount
    await act(async () => root!.unmount());
    expect(devices.displayTracks[0].stopped).toBe(true);
    expect(rec.state).toBe('inactive');
    root = null;
  });

  it('does not start recording after unmount (late grant)', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    // Unmount before the async getDisplayMedia resolves
    await act(async () => root!.unmount());
    await act(async () => { await Promise.resolve(); });
    expect(rec.state).toBe('inactive');
    root = null;
  });

  it('does not resurrect a cancelled capture with a newer start', async () => {
    const devices = makeMediaDevices({});
    const rec1 = makeRecorder();
    const rec2 = makeRecorder();
    let callCount = 0;
    const factory = () => { callCount++; return callCount === 1 ? (rec1 as unknown as MediaRecorder) : (rec2 as unknown as MediaRecorder); };
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={factory} />);
    // First start
    await click('[data-testid="capture-screen"]');
    await act(async () => { await Promise.resolve(); });
    // Stop and start again quickly
    await click('[data-testid="capture-stop"]');
    await act(async () => { await Promise.resolve(); });
    // Second start
    await click('[data-testid="capture-screen"]');
    await act(async () => { await Promise.resolve(); });
    expect(callCount).toBe(2);
    // The second recorder is active, not the first
    expect(rec2.state).toBe('recording');
  });
});

describe('CapturePanel — screen with audio', () => {
  it('reports audio absence when screen_audio has no audio track', async () => {
    const devices = makeMediaDevices({ displayResolves: makeStream([makeTrack('video')]) });
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen-audio"]');
    await act(async () => { await Promise.resolve(); });
    const banner = q('[data-testid="capture-audio-absent"]');
    expect(banner.textContent).toContain('audio');
  });

  it('does not show audio absence banner when audio track is present', async () => {
    const devices = makeMediaDevices({ displayResolves: makeStream([makeTrack('video'), makeTrack('audio')]) });
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen-audio"]');
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[data-testid="capture-audio-absent"]')).toBeNull();
  });
});

describe('CapturePanel — upload', () => {
  it('requires confirmation before upload is enabled', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    const onUploaded = vi.fn();
    // Mock the api.uploadAsset
    vi.mock('../../apps/web/src/lib/api', () => ({ api: { uploadAsset: vi.fn(async () => ({ asset: { id: 'asset-1' } })) } }));
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} onUploaded={onUploaded} />);
    await click('[data-testid="capture-screen"]');
    await act(async () => { await Promise.resolve(); });
    await click('[data-testid="capture-stop"]');
    await act(async () => { await Promise.resolve(); });
    // Upload button is disabled until confirmed
    const uploadBtn = q<HTMLButtonElement>('[data-testid="capture-upload"]');
    expect(uploadBtn.disabled).toBe(true);
  });

  it('calls onUploaded after a successful upload', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    const onUploaded = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ asset: { id: 'asset-1' } }) })));
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} onUploaded={onUploaded} />);
    await click('[data-testid="capture-screen"]');
    await act(async () => { await Promise.resolve(); });
    await click('[data-testid="capture-stop"]');
    await act(async () => { await Promise.resolve(); });
    // Confirm and upload
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });
    await click('[data-testid="capture-upload"]');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(onUploaded).toHaveBeenCalled();
  });

  it('shows an error and allows retry on upload failure', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    const onUploaded = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} onUploaded={onUploaded} />);
    await click('[data-testid="capture-screen"]');
    await act(async () => { await Promise.resolve(); });
    await click('[data-testid="capture-stop"]');
    await act(async () => { await Promise.resolve(); });
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });
    await click('[data-testid="capture-upload"]');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const err = q('[data-testid="capture-error"]');
    expect(err.textContent).toMatch(/upload|failed|network/i);
    // The upload button should still be available for retry
    expect(q('[data-testid="capture-upload"]')).not.toBeNull();
  });
});

describe('CapturePanel — reset/discard', () => {
  it('resets to idle after upload and allows capturing again', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ asset: { id: 'asset-1' } }) })));
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await act(async () => { await Promise.resolve(); });
    await click('[data-testid="capture-stop"]');
    await act(async () => { await Promise.resolve(); });
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });
    await click('[data-testid="capture-upload"]');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // Now reset
    await click('[data-testid="capture-reset"]');
    await act(async () => { await Promise.resolve(); });
    // Screen button should be available again
    expect(q('[data-testid="capture-screen"]')).not.toBeNull();
  });

  it('discards a failed upload and returns to idle', async () => {
    const devices = makeMediaDevices({});
    const rec = makeRecorder();
    rec.chunks.push(new Blob([new Uint8Array(64)], { type: 'video/webm' }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await mount(<CapturePanel mediaDevices={devices} recorderFactory={() => rec as unknown as MediaRecorder} />);
    await click('[data-testid="capture-screen"]');
    await act(async () => { await Promise.resolve(); });
    await click('[data-testid="capture-stop"]');
    await act(async () => { await Promise.resolve(); });
    await act(async () => { q<HTMLInputElement>('[data-testid="capture-confirm"]').click(); });
    await click('[data-testid="capture-upload"]');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // Discard
    await click('[data-testid="capture-discard"]');
    await act(async () => { await Promise.resolve(); });
    expect(q('[data-testid="capture-screen"]')).not.toBeNull();
  });
});
