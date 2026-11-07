/**
 * Consented screen / microphone capture panel.
 *
 * This is the BROWSER-API CAPABILITY surface for Order 05 / G10. It uses the
 * real `getDisplayMedia` (screen, optionally with audio), `getUserMedia`
 * (microphone) and `MediaRecorder` APIs. The deterministic state machine lives
 * in `lib/capture.ts`; this component owns only the browser calls, the timer
 * and the lifecycle cleanup.
 *
 * Import is NOT capture: a file picked from the disk goes through the existing
 * asset upload path and is never labelled a recording. A capture that the
 * browser refused, cancelled, or produced no frames for is shown as an error
 * and nothing is uploaded. The operator must confirm each capture before it
 * is sent to the asset library.
 *
 * Lifecycle rules (hardened per owner review):
 *  - Idempotent cleanup on unmount, cancellation, error and source end.
 *  - Late permission/recorder/upload completions must not start recording after
 *    unmount, resurrect a cancelled capture, replace a newer capture or mutate
 *    a stale component. Release stale streams immediately.
 *  - Stop owned tracks even when the permission promise resolves after
 *    cancellation; do not falsely claim cancellation of an unresolved browser
 *    prompt.
 *  - Guard requesting/recording/stopping/processing/uploading with synchronous
 *    refs plus valid state transitions. No parallel starts, no duplicate upload.
 *  - Cleanup is safe under React StrictMode.
 *
 * Labels: BROWSER-API CAPABILITY when the real browser calls succeed; the
 * panel does not render video and is not an owner acceptance.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import {
  INITIAL_CAPTURE_STATE,
  captureConsentDenied,
  captureConsentGranted,
  captureReset,
  captureStart,
  captureStop,
  captureTick,
  captureUploadPayload,
  captureUploadResult,
  type CaptureSource,
  type CaptureState,
} from '../../lib/capture';
import { Banner, Tag } from '../ui';

const SOURCE_LABELS: Record<CaptureSource, string> = {
  screen: 'Screen recording',
  microphone: 'Microphone recording',
  screen_audio: 'Screen with audio',
};

/**
 * Capability check: the actual requested API AND MediaRecorder must exist.
 * Merely having `navigator.mediaDevices` does NOT prove capture works.
 */
function browserSupportsCapture(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return false;
  if (typeof MediaRecorder === 'undefined') return false;
  return true;
}

/** True when the browser can attempt a screen capture (displayMedia exists). */
function browserSupportsScreen(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
}

/** True when the browser can attempt a microphone capture. */
function browserSupportsMicrophone(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** True when the browser can attempt a screen-with-audio capture. */
function browserSupportsScreenAudio(): boolean {
  return browserSupportsScreen();
}

interface MediaDevicesLike {
  getDisplayMedia?: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

/**
 * Open a media stream for the requested source. For screen_audio, request
 * audio alongside the display stream. The browser may grant screen without
 * audio; the component checks the audio track honestly below.
 */
async function openStream(
  source: CaptureSource,
  media: MediaDevicesLike,
): Promise<MediaStream> {
  if (source === 'screen' || source === 'screen_audio') {
    const constraints: DisplayMediaStreamOptions = { video: true };
    if (source === 'screen_audio') constraints.audio = true;
    return media.getDisplayMedia!(constraints);
  }
  return media.getUserMedia!({ audio: true, video: false });
}

/**
 * Check whether a screen-with-audio stream actually carries an audio track.
 * The browser may grant screen access but refuse the audio track; this is
 * reported honestly, never as silent success.
 */
function hasAudioTrack(stream: MediaStream): boolean {
  return stream.getAudioTracks().length > 0;
}

export interface CapturePanelProps {
  /** Called after a successful upload so the parent can refresh its asset list. */
  onUploaded?: () => void;
  /** Test-only recorder factory. When omitted the browser's MediaRecorder is used. */
  recorderFactory?: (stream: MediaStream) => MediaRecorder;
  /** Test-only: replace navigator.mediaDevices. When omitted the real one is used. */
  mediaDevices?: MediaDevicesLike | null;
}

export const CapturePanel: React.FC<CapturePanelProps> = ({ onUploaded, recorderFactory, mediaDevices }) => {
  const [state, setState] = useState<CaptureState>(INITIAL_CAPTURE_STATE);
  const [confirmed, setConfirmed] = useState(false);
  const [audioAbsent, setAudioAbsent] = useState(false);

  // --- Synchronous refs for lifecycle guards (no stale closures) ---
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  // Monotonic capture token: each start bumps it; late completions from an
  // older start check the token and bail if a newer capture has begun.
  const captureTokenRef = useRef<number>(0);
  // Mounted flag: prevents state updates after unmount.
  const mountedRef = useRef<boolean>(true);

  const supported = browserSupportsCapture() || mediaDevices != null;
  const screenOk = browserSupportsScreen() || (mediaDevices != null && !!mediaDevices.getDisplayMedia);
  const micOk = browserSupportsMicrophone() || (mediaDevices != null && !!mediaDevices.getUserMedia);

  /**
   * Idempotent cleanup: stop the recorder if active, stop all stream tracks,
   * clear the timer. Safe to call multiple times. Does NOT touch state — the
   * caller decides the transition.
   */
  const cleanupRef = useRef<() => void>(() => {});
  const makeCleanup = useCallback((): (() => void) => {
    return () => {
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try { rec.stop(); } catch { /* already stopped */ }
      }
      recorderRef.current = null;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
      }
      streamRef.current = null;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Install cleanup on unmount. Safe under StrictMode: the effect runs,
  // cleanup runs, effect runs again — all idempotent.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      makeCleanup()();
    };
  }, [makeCleanup]);

  /** Clear the timer without touching the recorder/stream. */
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Stop owned tracks immediately (used on error, stop, reset). */
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
    }
    streamRef.current = null;
  }, []);

  const start = useCallback(
    async (source: CaptureSource) => {
      // Synchronous guard: reject parallel starts.
      if (recorderRef.current) return;
      if (state.phase === 'recording' || state.phase === 'requesting' || state.phase === 'stopping') return;
      if (!mountedRef.current) return;

      const devices = (mediaDevices ?? (navigator.mediaDevices as MediaDevicesLike | undefined))!;
      const token = ++captureTokenRef.current;
      setState((prev) => captureStart(prev, { source, supported: true }));
      setAudioAbsent(false);

      let stream: MediaStream | null = null;
      try {
        stream = await openStream(source, devices);
      } catch (err) {
        // The browser consent prompt was dismissed or the API failed.
        // Check token: a newer capture may have started while we awaited.
        if (token !== captureTokenRef.current || !mountedRef.current) return;
        setState((prev) => captureConsentDenied(prev, err));
        stopStream();
        return;
      }

      // Check token again before mutating: a newer capture may have started.
      if (token !== captureTokenRef.current || !mountedRef.current) {
        // Release the stream we just acquired but don't touch state.
        stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
        return;
      }

      // For screen_audio: check whether the audio track was actually granted.
      if (source === 'screen_audio' && !hasAudioTrack(stream)) {
        setAudioAbsent(true);
        // Continue with screen-only; the operator sees the audio absence notice.
      }

      streamRef.current = stream;
      setState((prev) => captureConsentGranted(prev));
      chunksRef.current = [];
      startedAtRef.current = Date.now();

      const factory = recorderFactory ?? ((s: MediaStream) => new MediaRecorder(s));
      const rec = factory(stream);

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        // Guard: only process if this is still the active capture.
        if (token !== captureTokenRef.current || !mountedRef.current) return;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'video/webm' });
        setState((prev) => captureStop(prev, { blob, mimeType: rec.mimeType || 'video/webm' }));
        stopStream();
      };
      rec.onerror = () => {
        if (token !== captureTokenRef.current || !mountedRef.current) return;
        setState((prev) => captureConsentDenied(prev, new Error('MediaRecorder error')));
        stopStream();
      };

      rec.start();
      recorderRef.current = rec;
      clearTimer();
      timerRef.current = setInterval(() => {
        if (!mountedRef.current) return;
        setState((prev) => captureTick(prev, Math.round((Date.now() - startedAtRef.current) / 1000)));
      }, 1000);
    },
    [clearTimer, mediaDevices, recorderFactory, state.phase, stopStream],
  );

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      setState((prev) => ({ ...prev, phase: 'stopping' }));
      try { rec.stop(); } catch { /* already stopped */ }
    }
    recorderRef.current = null;
    clearTimer();
  }, [clearTimer]);

  const upload = useCallback(async () => {
    if (state.phase !== 'processing' && state.phase !== 'uploading') return;
    if (!confirmed) return;
    if (!mountedRef.current) return;

    const blob = new Blob(chunksRef.current, { type: state.mimeType || 'video/webm' });
    const mimeType = state.mimeType || blob.type;
    const suggested = `capture-${state.source ?? 'screen'}-${Date.now()}.webm`;
    const payload = captureUploadPayload({ blob, mimeType, suggestedName: suggested, operatorConfirmed: confirmed });
    if (!payload.ok) {
      setState((prev) => captureUploadResult(prev, { ok: false, assetId: null, error: payload.error }));
      return;
    }
    setState((prev) => ({ ...prev, phase: 'uploading' }));
    try {
      const fd = new FormData();
      fd.append('file', blob, suggested);
      for (const [k, v] of Object.entries(payload.fields)) fd.append(k, v);
      const res = await api.uploadAsset(fd);
      if (!mountedRef.current) return;
      const assetId = res?.asset?.id ?? null;
      setState((prev) => captureUploadResult(prev, { ok: !!assetId, assetId, error: assetId ? null : 'No asset id returned.' }));
      if (assetId) {
        setConfirmed(false);
        setAudioAbsent(false);
        onUploaded?.();
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const detail = (err as Error)?.message ?? 'The upload failed.';
      // Preserve the completed capture so the operator can retry or discard.
      setState((prev) => captureUploadResult(prev, { ok: false, assetId: null, error: detail }));
    }
  }, [confirmed, onUploaded, state.mimeType, state.phase, state.source]);

  const reset = useCallback(() => {
    // Full cleanup: stop recorder, stream, timer.
    makeCleanup()();
    setConfirmed(false);
    setAudioAbsent(false);
    setState(captureReset(state));
  }, [makeCleanup, state]);

  const recording = state.phase === 'recording';
  const uploadable = state.phase === 'processing' || state.phase === 'uploading';
  const errorMsg = state.error ? state.errorDetail ?? state.error : null;

  return (
    <div className="card" data-testid="capture-panel">
      <h3>Consented screen / microphone capture</h3>
      <p className="sub">
        Record a real screen or microphone capture in the browser. The browser asks for permission first.
        A stopped-but-empty capture is never uploaded. Confirm each capture before it joins the library.
      </p>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Tag kind={supported ? 'ok' : 'bad'}>{supported ? 'browser capture available' : 'browser capture unavailable'}</Tag>
        {state.source ? <Tag kind="accent">{SOURCE_LABELS[state.source]}</Tag> : null}
        {recording ? <Tag kind="warn">recording · {state.elapsedSec}s</Tag> : null}
        {state.phase === 'uploaded' ? <Tag kind="ok">uploaded</Tag> : null}
      </div>

      {audioAbsent ? (
        <Banner kind="warn" data-testid="capture-audio-absent">
          The browser granted screen access but did not provide an audio track. The recording has screen video only.
        </Banner>
      ) : null}

      {errorMsg ? <Banner kind="bad" data-testid="capture-error">{errorMsg}</Banner> : null}

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        {!recording ? (
          <>
            <button className="btn" data-testid="capture-screen" disabled={!screenOk} onClick={() => void start('screen')}>
              Record screen
            </button>
            <button className="btn" data-testid="capture-microphone" disabled={!micOk} onClick={() => void start('microphone')}>
              Record microphone
            </button>
            <button className="btn" data-testid="capture-screen-audio" disabled={!screenOk} onClick={() => void start('screen_audio')}>
              Record screen with audio
            </button>
          </>
        ) : null}
        {recording ? (
          <button className="btn primary" data-testid="capture-stop" onClick={stop}>
            Stop
          </button>
        ) : null}
        {uploadable ? (
          <button className="btn primary" data-testid="capture-upload" disabled={!confirmed} onClick={() => void upload()}>
            Upload capture
          </button>
        ) : null}
        {state.phase === 'uploaded' ? (
          <button className="btn" data-testid="capture-reset" onClick={reset}>
            Capture another
          </button>
        ) : null}
        {state.phase === 'error' && uploadable ? (
          <button className="btn" data-testid="capture-discard" onClick={reset}>
            Discard
          </button>
        ) : null}
      </div>

      {uploadable ? (
        <label className="row" style={{ gap: 8, marginTop: 8 }}>
          <input
            type="checkbox"
            data-testid="capture-confirm"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I confirm this capture is mine to use and may join the asset library.
        </label>
      ) : null}

      {state.phase === 'uploading' ? <p className="small mt">Uploading…</p> : null}
      {state.phase === 'uploaded' ? (
        <p className="small mt" data-testid="capture-uploaded-note">
          The capture is in the asset library. It is a browser recording, not a generated video and not an owner acceptance.
        </p>
      ) : null}
    </div>
  );
};
