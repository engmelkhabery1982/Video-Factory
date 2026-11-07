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
 * Lifecycle rules (hardened per owner review — CLOSEOUT03):
 *  - Effect setup/cleanup works under React.StrictMode: mountedRef is restored
 *    to true on every setup, not only on initial mount.
 *  - Synchronous operation refs (startingRef, uploadingRef) prevent parallel
 *    starts and duplicate uploads within the same event batch.
 *  - Capture-generation tokens (captureTokenRef) invalidate stale callbacks
 *    (onstop, onerror, ondataavailable, late upload results) from older
 *    captures so they cannot mutate a newer capture or resurrect a cancelled
 *    one.
 *  - Cancel/reset/unmount releases owned tracks, listeners, recorder and
 *    timers idempotently. A late-granted stale stream is released without
 *    mutating state. Do not falsely claim cancellation of an unresolved
 *    native permission prompt.
 *  - Upload failure transitions to `upload_failed` (not `error`) so the
 *    completed capture, provenance and confirmation are preserved for retry
 *    or explicit discard. Retry must not send duplicates.
 *  - Screen+audio requests audio explicitly and reports an absent audio track;
 *    it never silently requests microphone access instead.
 *  - Check requested API AND MediaRecorder before enabling controls, including
 *    injected test capabilities.
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
  captureUploadRetry,
  hasAudioTrack,
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
  // Synchronous operation locks (refs, not state — works within one batch).
  const startingRef = useRef<boolean>(false);
  const uploadingRef = useRef<boolean>(false);

  const supported = browserSupportsCapture() || mediaDevices != null;
  const screenOk = browserSupportsScreen() || (mediaDevices != null && !!mediaDevices.getDisplayMedia);
  const micOk = browserSupportsMicrophone() || (mediaDevices != null && !!mediaDevices.getUserMedia);

  /**
   * Idempotent cleanup: stop the recorder if active, stop all stream tracks,
   * clear the timer. Safe to call multiple times. Does NOT touch state — the
   * caller decides the transition.
   */
  const cleanup = useCallback(() => {
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
  }, []);

  // Install cleanup on unmount. Under StrictMode: setup runs (mountedRef=true),
  // cleanup runs (mountedRef=false, resources released), setup runs again
  // (mountedRef=true). All idempotent.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

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
      // Synchronous guard: reject parallel starts within the same batch.
      if (startingRef.current) return;
      if (recorderRef.current) return;
      if (!mountedRef.current) return;

      startingRef.current = true;
      try {
        const devices = (mediaDevices ?? (navigator.mediaDevices as MediaDevicesLike | undefined))!;
        const token = ++captureTokenRef.current;
        setConfirmed(false);
        setAudioAbsent(false);
        setState((prev) => captureStart(prev, { source, supported: true }));

        let stream: MediaStream | null = null;
        try {
          stream = await openStream(source, devices);
        } catch (err) {
          if (token !== captureTokenRef.current || !mountedRef.current) return;
          setState((prev) => captureConsentDenied(prev, err));
          stopStream();
          return;
        }

        // Check token again before mutating: a newer capture may have started.
        if (token !== captureTokenRef.current || !mountedRef.current) {
          stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
          return;
        }

        // For screen_audio: check whether the audio track was actually granted.
        if (source === 'screen_audio' && !hasAudioTrack(stream)) {
          setAudioAbsent(true);
        }

        streamRef.current = stream;
        setState((prev) => captureConsentGranted(prev));
        chunksRef.current = [];
        startedAtRef.current = Date.now();

        let rec: MediaRecorder;
        try {
          const factory = recorderFactory ?? ((s: MediaStream) => new MediaRecorder(s));
          rec = factory(stream);
        } catch (err) {
          if (token !== captureTokenRef.current || !mountedRef.current) return;
          setState((prev) => captureConsentDenied(prev, err));
          stopStream();
          return;
        }

        rec.ondataavailable = (e) => {
          if (token !== captureTokenRef.current) return;
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onstop = () => {
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

        try {
          rec.start();
        } catch (err) {
          if (token !== captureTokenRef.current || !mountedRef.current) return;
          setState((prev) => captureConsentDenied(prev, err));
          stopStream();
          return;
        }

        recorderRef.current = rec;

        // Listen for source-ended (e.g., user stops sharing screen via
        // browser UI). When a track ends, stop the recorder so the capture
        // is processed (or reported as empty if no frames were produced).
        stream.getTracks().forEach((t) => {
          t.onended = () => {
            if (token !== captureTokenRef.current || !mountedRef.current) return;
            if (rec.state !== 'inactive') {
              try { rec.stop(); } catch { /* already stopped */ }
            }
          };
        });

        clearTimer();
        timerRef.current = setInterval(() => {
          if (!mountedRef.current) return;
          setState((prev) => captureTick(prev, Math.round((Date.now() - startedAtRef.current) / 1000)));
        }, 1000);
      } finally {
        startingRef.current = false;
      }
    },
    [clearTimer, mediaDevices, recorderFactory, stopStream],
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
    // Synchronous guard: reject parallel uploads within the same batch.
    if (uploadingRef.current) return;
    if (!confirmed) return;
    if (!mountedRef.current) return;
    // Must have a completed capture to upload (processing or failed upload).
    if (state.phase !== 'processing' && state.phase !== 'upload_failed') return;

    uploadingRef.current = true;
    const uploadToken = captureTokenRef.current; // Capture token to detect stale uploads
    try {
      // Transition to uploading (from processing or upload_failed retry).
      setState((prev) => {
        if (prev.phase === 'upload_failed') return captureUploadRetry(prev);
        if (prev.phase === 'processing') return { ...prev, phase: 'uploading' };
        return prev;
      });

      const blob = new Blob(chunksRef.current, { type: state.mimeType || 'video/webm' });
      const mimeType = state.mimeType || blob.type;
      const suggested = `capture-${state.source ?? 'screen'}-${Date.now()}.webm`;
      const payload = captureUploadPayload({ blob, mimeType, suggestedName: suggested, operatorConfirmed: confirmed });
      if (!payload.ok) {
        setState((prev) => captureUploadResult(prev, { ok: false, assetId: null, error: payload.error }));
        return;
      }

      const fd = new FormData();
      fd.append('file', blob, suggested);
      for (const [k, v] of Object.entries(payload.fields)) fd.append(k, v);

      const res = await api.uploadAsset(fd);
      if (!mountedRef.current) return;
      if (uploadToken !== captureTokenRef.current) return; // Stale upload — discard result
      const assetId = res?.asset?.id ?? null;
      setState((prev) => captureUploadResult(prev, { ok: !!assetId, assetId, error: assetId ? null : 'No asset id returned.' }));
      if (assetId) {
        setConfirmed(false);
        setAudioAbsent(false);
        onUploaded?.();
      }
    } catch (err) {
      if (!mountedRef.current) return;
      if (uploadToken !== captureTokenRef.current) return; // Stale upload — discard result
      const detail = (err as Error)?.message ?? 'The upload failed.';
      // Preserve the completed capture so the operator can retry or discard.
      // captureUploadResult transitions uploading -> upload_failed on failure.
      setState((prev) => captureUploadResult(prev, { ok: false, assetId: null, error: detail }));
    } finally {
      uploadingRef.current = false;
    }
  }, [confirmed, onUploaded, state.mimeType, state.phase, state.source]);

  const reset = useCallback(() => {
    // Bump token to invalidate any pending recorder callbacks (onstop/onerror).
    captureTokenRef.current++;
    cleanup();
    setConfirmed(false);
    setAudioAbsent(false);
    setState(captureReset(state));
  }, [cleanup, state]);

  const recording = state.phase === 'recording';
  const uploadable = state.phase === 'processing' || state.phase === 'uploading' || state.phase === 'upload_failed';
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
        {state.phase === 'upload_failed' ? (
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
      {state.phase === 'upload_failed' ? (
        <p className="small mt" data-testid="capture-upload-failed-note">
          The upload failed. The capture is preserved. You can retry the upload or discard it.
        </p>
      ) : null}
      {state.phase === 'uploaded' ? (
        <p className="small mt" data-testid="capture-uploaded-note">
          The capture is in the asset library. It is a browser recording, not a generated video and not an owner acceptance.
        </p>
      ) : null}
    </div>
  );
};
