/**
 * Consented screen / microphone capture panel.
 *
 * This is the BROWSER-API CAPABILITY surface for Order 05 / G10. It uses the
 * real `getDisplayMedia` (screen), `getUserMedia` (microphone) and
 * `MediaRecorder` APIs. The deterministic state machine lives in
 * `lib/capture.ts`; this component owns only the browser calls and the timer.
 *
 * Import is NOT capture: a file picked from the disk goes through the existing
 * asset upload path and is never labelled a recording. A capture that the
 * browser refused, cancelled, or produced no frames for is shown as an error
 * and nothing is uploaded. The operator must confirm each capture before it
 * is sent to the asset library.
 *
 * Labels: BROWSER-API CAPABILITY when the real browser calls succeed; the
 * panel does not render video and is not an owner acceptance.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
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
  classifyMediaError,
  type CaptureSource,
  type CaptureState,
} from '../lib/capture';
import { Banner, Tag } from '../components/ui';

const SOURCE_LABELS: Record<CaptureSource, string> = {
  screen: 'Screen recording',
  microphone: 'Microphone recording',
  screen_audio: 'Screen with audio',
};

/** A recorder double is injected by tests; the real one is created here. */
type RecorderFactory = (stream: MediaStream) => MediaRecorder;

export interface CapturePanelProps {
  /** Called after a successful upload so the parent can refresh its asset list. */
  onUploaded?: () => void;
  /** Test-only recorder factory. When omitted the browser's MediaRecorder is used. */
  recorderFactory?: RecorderFactory;
  /** Test-only: replace navigator.mediaDevices. When omitted the real one is used. */
  mediaDevices?: {
    getDisplayMedia?: () => Promise<MediaStream>;
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  } | null;
}

function browserSupportsCapture(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices;
}

async function openStream(
  source: CaptureSource,
  media: NonNullable<CapturePanelProps['mediaDevices']>,
): Promise<MediaStream> {
  if (source === 'screen' || source === 'screen_audio') {
    return media.getDisplayMedia!();
  }
  return media.getUserMedia!({ audio: true, video: false });
}

export const CapturePanel: React.FC<CapturePanelProps> = ({ onUploaded, recorderFactory, mediaDevices }) => {
  const [state, setState] = useState<CaptureState>(INITIAL_CAPTURE_STATE);
  const [confirmed, setConfirmed] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  const supported = browserSupportsCapture() || mediaDevices != null;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(
    async (source: CaptureSource) => {
      const devices = mediaDevices ?? navigator.mediaDevices;
      setState((prev) => captureStart(prev, { source, supported: true }));
      try {
        const stream = await openStream(source, devices);
        streamRef.current = stream;
        // The browser consent prompt was granted (we have a stream).
        setState((prev) => captureConsentGranted(prev));
        chunksRef.current = [];
        startedAtRef.current = Date.now();
        const factory: RecorderFactory = recorderFactory ?? ((s) => new MediaRecorder(s));
        const rec = factory(stream);
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'video/webm' });
          setState((prev) => captureStop(prev, { blob, mimeType: rec.mimeType || 'video/webm' }));
          stopStream();
        };
        rec.onerror = () => {
          setState((prev) => captureConsentDenied(prev, new Error('MediaRecorder error')));
          stopStream();
        };
        rec.start();
        recorderRef.current = rec;
        clearTimer();
        timerRef.current = setInterval(() => {
          setState((prev) => captureTick(prev, Math.round((Date.now() - startedAtRef.current) / 1000)));
        }, 1000);
      } catch (err) {
        setState((prev) => captureConsentDenied(prev, err));
        stopStream();
      }
    },
    [clearTimer, mediaDevices, recorderFactory, stopStream],
  );

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      setState((prev) => ({ ...prev, phase: 'stopping' }));
      rec.stop();
    }
    recorderRef.current = null;
    clearTimer();
  }, [clearTimer]);

  const upload = useCallback(async () => {
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
      const assetId = res?.asset?.id ?? null;
      setState((prev) => captureUploadResult(prev, { ok: !!assetId, assetId, error: assetId ? null : 'No asset id returned.' }));
      if (assetId) {
        setConfirmed(false);
        onUploaded?.();
      }
    } catch (err) {
      const detail = (err as Error)?.message ?? 'The upload failed.';
      setState((prev) => captureUploadResult(prev, { ok: false, assetId: null, error: detail }));
    }
  }, [confirmed, onUploaded, state.mimeType, state.source]);

  const reset = useCallback(() => {
    stopStream();
    clearTimer();
    recorderRef.current = null;
    chunksRef.current = [];
    setConfirmed(false);
    setState(captureReset(state));
  }, [clearTimer, stopStream, state]);

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

      {errorMsg ? <Banner kind="bad" data-testid="capture-error">{errorMsg}</Banner> : null}

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        {!recording ? (
          <>
            <button className="btn" data-testid="capture-screen" disabled={!supported} onClick={() => void start('screen')}>
              Record screen
            </button>
            <button className="btn" data-testid="capture-microphone" disabled={!supported} onClick={() => void start('microphone')}>
              Record microphone
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
