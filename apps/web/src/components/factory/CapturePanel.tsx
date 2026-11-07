/**
 * Consented screen / microphone capture (G10).
 *
 * Browser consent and per-capture library confirmation are separate. A refused
 * canonical phase transition returns BEFORE any media API, stream, chunk or
 * recorder mutation. Browser-API doubles in tests are not real-capture evidence.
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

export interface MediaDevicesLike {
  getDisplayMedia?: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

async function openStream(source: CaptureSource, media: MediaDevicesLike): Promise<MediaStream> {
  if (source === 'screen' || source === 'screen_audio') {
    if (typeof media.getDisplayMedia !== 'function') throw Object.assign(new Error('Screen capture is not supported.'), { name: 'NotSupportedError' });
    const constraints: DisplayMediaStreamOptions = { video: true };
    if (source === 'screen_audio') constraints.audio = true; // never substitute a hidden microphone request
    return media.getDisplayMedia(constraints);
  }
  if (typeof media.getUserMedia !== 'function') throw Object.assign(new Error('Microphone capture is not supported.'), { name: 'NotSupportedError' });
  return media.getUserMedia({ audio: true, video: false });
}

export interface CapturePanelProps {
  onUploaded?: () => void;
  /** Explicit test capability. Without it, the real MediaRecorder constructor is required. */
  recorderFactory?: (stream: MediaStream) => MediaRecorder;
  /** undefined = real navigator; null = explicitly unavailable; object = complete injected device contract. */
  mediaDevices?: MediaDevicesLike | null;
}

export const CapturePanel: React.FC<CapturePanelProps> = ({ onUploaded, recorderFactory, mediaDevices }) => {
  const [state, setState] = useState<CaptureState>(INITIAL_CAPTURE_STATE);
  const [confirmed, setConfirmed] = useState(false);
  const [audioAbsent, setAudioAbsent] = useState(false);

  const stateRef = useRef<CaptureState>(INITIAL_CAPTURE_STATE);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const captureTokenRef = useRef(0);
  const mountedRef = useRef(true);
  const startingRef = useRef(false);
  const uploadingRef = useRef(false);

  const devices: MediaDevicesLike | null = mediaDevices === undefined
    ? (typeof navigator !== 'undefined' ? (navigator.mediaDevices as MediaDevicesLike | undefined) ?? null : null)
    : mediaDevices;
  const recorderAvailable = recorderFactory !== undefined || typeof MediaRecorder !== 'undefined';
  const supported = devices !== null && recorderAvailable;
  const screenOk = supported && typeof devices.getDisplayMedia === 'function';
  const micOk = supported && typeof devices.getUserMedia === 'function';

  /** Calculate once outside React's updater so StrictMode cannot repeat side effects. */
  const transition = useCallback((update: (previous: CaptureState) => CaptureState): CaptureState => {
    const next = update(stateRef.current);
    stateRef.current = next;
    if (mountedRef.current) setState(next);
    return next;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback((stream: MediaStream | null) => {
    if (!stream) return;
    stream.getTracks().forEach((track) => {
      track.onended = null;
      try { track.stop(); } catch { /* already ended */ }
    });
  }, []);

  const stopOwnedStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    releaseStream(stream);
  }, [releaseStream]);

  const detachRecorder = useCallback((recorder: MediaRecorder | null) => {
    if (!recorder) return;
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
  }, []);

  /** Discard/cancel/unmount cleanup. Normal stop has a separate path that retains chunks. */
  const cleanup = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    detachRecorder(recorder);
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* already stopped */ }
    }
    stopOwnedStream();
    clearTimer();
  }, [clearTimer, detachRecorder, stopOwnedStream]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      captureTokenRef.current += 1;
      startingRef.current = false;
      uploadingRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  const start = useCallback(async (source: CaptureSource) => {
    if (startingRef.current || recorderRef.current || !mountedRef.current) return;
    const sourceSupported = source === 'microphone' ? micOk : screenOk;
    // This canonical decision is synchronous and precedes EVERY browser/native mutation.
    const requested = captureStart(stateRef.current, { source, supported: sourceSupported });
    if (requested.phase !== 'requesting') {
      transition(() => requested);
      return;
    }
    if (!devices) return;

    const token = ++captureTokenRef.current;
    startingRef.current = true;
    setConfirmed(false);
    setAudioAbsent(false);
    transition(() => requested);

    try {
      let stream: MediaStream;
      try {
        stream = await openStream(source, devices);
      } catch (err) {
        if (token === captureTokenRef.current && mountedRef.current) transition((prev) => captureConsentDenied(prev, err));
        stopOwnedStream();
        return;
      }

      // A cancelled/unmounted permission request may still resolve. Release that late stream.
      if (token !== captureTokenRef.current || !mountedRef.current) {
        releaseStream(stream);
        return;
      }
      streamRef.current = stream;
      if (source === 'screen_audio' && !hasAudioTrack(stream)) setAudioAbsent(true);

      let recorder: MediaRecorder;
      try {
        recorder = recorderFactory ? recorderFactory(stream) : new MediaRecorder(stream);
      } catch (err) {
        if (token === captureTokenRef.current && mountedRef.current) transition((prev) => captureConsentDenied(prev, err));
        stopOwnedStream();
        return;
      }

      chunksRef.current = [];
      startedAtRef.current = Date.now();
      recorder.ondataavailable = (event) => {
        if (token !== captureTokenRef.current) return;
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (token !== captureTokenRef.current || !mountedRef.current) return;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' });
        clearTimer();
        recorderRef.current = null;
        detachRecorder(recorder);
        stopOwnedStream();
        transition((prev) => captureStop(prev, { blob, mimeType: recorder.mimeType || 'video/webm' }));
      };
      recorder.onerror = () => {
        if (token !== captureTokenRef.current || !mountedRef.current) return;
        clearTimer();
        recorderRef.current = null;
        detachRecorder(recorder);
        stopOwnedStream();
        chunksRef.current = [];
        transition((prev) => captureConsentDenied(prev, new Error('MediaRecorder error')));
      };
      stream.getTracks().forEach((track) => {
        track.onended = () => {
          if (token !== captureTokenRef.current || !mountedRef.current || recorder.state === 'inactive') return;
          transition((prev) => prev.phase === 'recording' ? { ...prev, phase: 'stopping' } : prev);
          clearTimer();
          try { recorder.stop(); } catch { /* onerror/onstop owns the resulting state */ }
        };
      });

      try {
        recorderRef.current = recorder;
        recorder.start();
      } catch (err) {
        recorderRef.current = null;
        detachRecorder(recorder);
        stopOwnedStream();
        clearTimer();
        if (token === captureTokenRef.current && mountedRef.current) transition((prev) => captureConsentDenied(prev, err));
        return;
      }

      transition((prev) => captureConsentGranted(prev));
      clearTimer();
      timerRef.current = setInterval(() => {
        if (!mountedRef.current || token !== captureTokenRef.current) return;
        transition((prev) => captureTick(prev, Math.round((Date.now() - startedAtRef.current) / 1000)));
      }, 1000);
    } finally {
      // An older cancelled start must not unlock a newer generation.
      if (token === captureTokenRef.current) startingRef.current = false;
    }
  }, [clearTimer, detachRecorder, devices, micOk, recorderFactory, releaseStream, screenOk, stopOwnedStream, transition]);

  const stop = useCallback(() => {
    if (stateRef.current.phase !== 'recording') return;
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    transition((prev) => ({ ...prev, phase: 'stopping' }));
    clearTimer();
    try { recorder.stop(); } catch (err) {
      detachRecorder(recorder);
      stopOwnedStream();
      transition((prev) => captureConsentDenied(prev, err));
    } finally {
      recorderRef.current = null;
    }
  }, [clearTimer, detachRecorder, stopOwnedStream, transition]);

  const upload = useCallback(async () => {
    const current = stateRef.current;
    if (uploadingRef.current || !confirmed || !mountedRef.current) return;
    if (current.phase !== 'processing' && current.phase !== 'upload_failed') return;

    const uploadToken = captureTokenRef.current;
    uploadingRef.current = true;
    try {
      transition((prev) => prev.phase === 'upload_failed' ? captureUploadRetry(prev) : { ...prev, phase: 'uploading' });
      const blob = new Blob(chunksRef.current, { type: current.mimeType || 'video/webm' });
      const mimeType = current.mimeType || blob.type;
      const suggested = `capture-${current.source ?? 'screen'}-${Date.now()}.webm`;
      const payload = captureUploadPayload({ blob, mimeType, suggestedName: suggested, operatorConfirmed: confirmed });
      if (!payload.ok) {
        transition((prev) => captureUploadResult(prev, { ok: false, assetId: null, error: payload.error }));
        return;
      }
      const form = new FormData();
      form.append('file', blob, suggested);
      for (const [key, value] of Object.entries(payload.fields)) form.append(key, value);
      const response = await api.uploadAsset(form);
      if (!mountedRef.current || uploadToken !== captureTokenRef.current) return;
      const assetId = response?.asset?.id ?? null;
      transition((prev) => captureUploadResult(prev, { ok: !!assetId, assetId, error: assetId ? null : 'No asset id returned.' }));
      if (assetId) {
        setConfirmed(false);
        setAudioAbsent(false);
        onUploaded?.();
      }
    } catch (err) {
      if (!mountedRef.current || uploadToken !== captureTokenRef.current) return;
      transition((prev) => captureUploadResult(prev, {
        ok: false,
        assetId: null,
        error: (err as Error)?.message ?? 'The upload failed.',
      }));
    } finally {
      if (uploadToken === captureTokenRef.current) uploadingRef.current = false;
    }
  }, [confirmed, onUploaded, transition]);

  /** Explicit discard/cancel/coherent reset. This is the only way to replace retained work early. */
  const reset = useCallback(() => {
    captureTokenRef.current += 1;
    startingRef.current = false;
    uploadingRef.current = false;
    cleanup();
    chunksRef.current = [];
    setConfirmed(false);
    setAudioAbsent(false);
    transition((prev) => captureReset(prev));
  }, [cleanup, transition]);

  const recording = state.phase === 'recording';
  const directStart = state.phase === 'idle' || state.phase === 'error';
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
        {state.phase === 'requesting' ? <Tag kind="warn">waiting for browser permission</Tag> : null}
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
            <button className="btn" data-testid="capture-screen" disabled={!screenOk || !directStart} onClick={() => void start('screen')}>Record screen</button>
            <button className="btn" data-testid="capture-microphone" disabled={!micOk || !directStart} onClick={() => void start('microphone')}>Record microphone</button>
            <button className="btn" data-testid="capture-screen-audio" disabled={!screenOk || !directStart} onClick={() => void start('screen_audio')}>Record screen with audio</button>
          </>
        ) : null}
        {recording ? <button className="btn primary" data-testid="capture-stop" onClick={stop}>Stop</button> : null}
        {state.phase === 'requesting' || recording ? (
          <button className="btn" data-testid="capture-cancel" onClick={reset}>Cancel capture</button>
        ) : null}
        {uploadable ? (
          <button className="btn primary" data-testid="capture-upload" disabled={!confirmed || state.phase === 'uploading'} onClick={() => void upload()}>
            {state.phase === 'upload_failed' ? 'Retry upload' : 'Upload capture'}
          </button>
        ) : null}
        {state.phase === 'processing' || state.phase === 'upload_failed' ? (
          <button className="btn" data-testid="capture-discard" onClick={reset}>Discard</button>
        ) : null}
        {state.phase === 'uploaded' ? (
          <button className="btn" data-testid="capture-reset" onClick={reset}>Capture another</button>
        ) : null}
      </div>

      {uploadable ? (
        <label className="row" style={{ gap: 8, marginTop: 8 }}>
          <input
            type="checkbox"
            data-testid="capture-confirm"
            checked={confirmed}
            disabled={state.phase === 'uploading'}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          I confirm this capture is mine to use and may join the asset library.
        </label>
      ) : null}

      {state.phase === 'uploading' ? <p className="small mt">Uploading… the completed capture cannot be replaced while this request is in flight.</p> : null}
      {state.phase === 'upload_failed' ? (
        <p className="small mt" data-testid="capture-upload-failed-note">The upload failed. The capture is preserved. Retry the upload or explicitly discard it.</p>
      ) : null}
      {state.phase === 'uploaded' ? (
        <p className="small mt" data-testid="capture-uploaded-note">The capture is in the asset library. It is a browser recording, not a generated video or owner acceptance.</p>
      ) : null}
    </div>
  );
};
