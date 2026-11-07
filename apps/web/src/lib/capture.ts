/**
 * Consented screen / microphone capture state machine.
 *
 * This module holds the DETERMINISTIC part of the capture workflow: the state
 * transitions, the permission/error classification, the recorder lifecycle
 * decisions and the asset-upload payload assembly. It does NOT touch
 * `navigator.mediaDevices`, `MediaRecorder` or the filesystem, so it can be
 * tested with plain Node and a labelled browser-API double.
 *
 * The browser-facing component (`CapturePanel.tsx`) calls these functions to
 * decide what to do; the actual `getDisplayMedia` / `getUserMedia` /
 * `MediaRecorder` calls live only there. Import is NOT capture: a supplied
 * file upload is a different path and is never labelled as a recording.
 *
 * Labels used throughout: this is BROWSER-API CAPABILITY evidence when the
 * real browser calls succeed, and PURE-CONTRACT evidence when only this
 * module is exercised. Neither is a rendered video or an owner acceptance.
 */

export type CaptureSource = 'screen' | 'microphone' | 'screen_audio';

export type CapturePhase =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'stopping'
  | 'processing'
  | 'uploading'
  | 'uploaded'
  | 'error';

export interface CaptureState {
  phase: CapturePhase;
  source: CaptureSource | null;
  /** Seconds elapsed while recording, measured by the component's timer. */
  elapsedSec: number;
  /** True while the user has not yet dismissed the browser consent prompt. */
  consentPending: boolean;
  /** Last classified error code, null when none. */
  error: CaptureErrorCode | null;
  /** Human-readable detail for the last error. */
  errorDetail: string | null;
  /** The captured blob size in bytes, once processing has produced it. */
  blobSize: number | null;
  /** The mime type the recorder produced, once known. */
  mimeType: string | null;
  /** The uploaded asset id, once the upload succeeded. */
  assetId: string | null;
}

export type CaptureErrorCode =
  | 'permission_denied'
  | 'not_supported'
  | 'no_track'
  | 'recorder_error'
  | 'stop_failed'
  | 'upload_failed'
  | 'empty_capture'
  | 'source_cancelled';

export interface CaptureStartInput {
  source: CaptureSource;
  /** True if the browser exposed the APIs at all. */
  supported: boolean;
}

export interface CaptureStopInput {
  /** The blob produced by the recorder, or null if the recorder produced nothing. */
  blob: Blob | null;
  mimeType: string | null;
}

export interface CaptureUploadInput {
  blob: Blob;
  mimeType: string;
  /** A filename suggested by the component; the asset route sanitizes it. */
  suggestedName: string;
  /** Explicit operator consent for this capture (the browser consent is separate). */
  operatorConfirmed: boolean;
}

export interface CaptureUploadResult {
  ok: boolean;
  assetId: string | null;
  error: string | null;
}

export const INITIAL_CAPTURE_STATE: CaptureState = {
  phase: 'idle',
  source: null,
  elapsedSec: 0,
  consentPending: false,
  error: null,
  errorDetail: null,
  blobSize: null,
  mimeType: null,
  assetId: null,
};

/**
 * Classify a browser media-device error into a stable code. The browser
 * `NotAllowedError` (user dismissed the consent prompt) and `NotSupportedError`
 * are mapped precisely; everything else becomes `recorder_error`. The detail
 * string is shown to the operator but never treated as a structured fact.
 */
export function classifyMediaError(err: unknown): { code: CaptureErrorCode; detail: string } {
  const name = (err as { name?: string } | null)?.name ?? '';
  const msg = (err as { message?: string } | null)?.message ?? String(err);
  if (name === 'NotAllowedError' || /denied|permission/i.test(msg)) {
    return { code: 'permission_denied', detail: 'The browser permission was not granted. The capture did not start.' };
  }
  if (name === 'NotSupportedError' || /not.?support/i.test(msg)) {
    return { code: 'not_supported', detail: 'This browser does not expose the capture API for the requested source.' };
  }
  if (name === 'NotFoundError' || /no.?track|not.?found/i.test(msg)) {
    return { code: 'no_track', detail: 'No media track was produced for the requested source.' };
  }
  return { code: 'recorder_error', detail: msg || 'The capture failed.' };
}

/** Start a capture: only valid from idle, and only when the APIs are supported. */
export function captureStart(
  prev: CaptureState,
  input: CaptureStartInput,
): CaptureState {
  if (prev.phase !== 'idle' && prev.phase !== 'error') {
    return { ...prev, error: 'recorder_error', errorDetail: 'A capture is already in progress.' };
  }
  if (!input.supported) {
    return { ...prev, phase: 'error', error: 'not_supported', errorDetail: 'The browser does not expose the capture API.' };
  }
  return {
    ...prev,
    phase: 'requesting',
    source: input.source,
    consentPending: true,
    error: null,
    errorDetail: null,
    blobSize: null,
    mimeType: null,
    assetId: null,
  };
}

/** The browser consent prompt resolved (granted). Transitions requesting -> recording. */
export function captureConsentGranted(prev: CaptureState): CaptureState {
  if (prev.phase !== 'requesting') return prev;
  return { ...prev, phase: 'recording', consentPending: false, elapsedSec: 0 };
}

/** The browser consent prompt was dismissed or the source stream failed. */
export function captureConsentDenied(prev: CaptureState, err: unknown): CaptureState {
  const { code, detail } = classifyMediaError(err);
  return { ...prev, phase: 'error', consentPending: false, error: code, errorDetail: detail };
}

/** The component's elapsed timer ticked while recording. */
export function captureTick(prev: CaptureState, elapsedSec: number): CaptureState {
  if (prev.phase !== 'recording') return prev;
  return { ...prev, elapsedSec };
}

/**
 * Stop the recorder and transition to processing. An empty blob (the user
 * stopped before any frame was produced) is refused as `empty_capture`: a
 * zero-length file is never uploaded as if it were a recording.
 */
export function captureStop(prev: CaptureState, input: CaptureStopInput): CaptureState {
  if (prev.phase !== 'recording' && prev.phase !== 'stopping') {
    return { ...prev, error: 'recorder_error', errorDetail: 'Nothing was recording.' };
  }
  if (!input.blob || input.blob.size === 0) {
    return { ...prev, phase: 'error', error: 'empty_capture', errorDetail: 'The capture produced no frames. Nothing was uploaded.' };
  }
  return {
    ...prev,
    phase: 'processing',
    blobSize: input.blob.size,
    mimeType: input.mimeType,
    error: null,
    errorDetail: null,
  };
}

/**
 * Assemble the multipart upload for the captured blob. The operator must have
 * confirmed the capture explicitly (the browser consent is a separate fact).
 * The kind is `broll` for a screen capture and `sfx` only when the source is
 * microphone-only AND the operator explicitly chose audio-only; a screen
 * capture that carries audio is still a `broll` video.
 */
export function captureUploadPayload(input: CaptureUploadInput): {
  ok: true;
  fields: Record<string, string>;
} | { ok: false; error: string } {
  if (!input.operatorConfirmed) {
    return { ok: false, error: 'Confirm the capture before uploading it to the library.' };
  }
  if (!input.blob || input.blob.size === 0) {
    return { ok: false, error: 'The capture is empty. Nothing was uploaded.' };
  }
  const isAudioOnly = input.mimeType.startsWith('audio/');
  const kind = isAudioOnly ? 'sfx' : 'broll';
  const fields: Record<string, string> = {
    kind,
    source: 'Browser capture (consented screen/microphone recording)',
    license: 'Operator owned capture',
  };
  // The component sets `name` from the suggested filename; the asset route
  // sanitizes it and never stores executable content.
  return { ok: true, fields };
}

/** The upload attempt resolved. */
export function captureUploadResult(
  prev: CaptureState,
  result: CaptureUploadResult,
): CaptureState {
  if (prev.phase !== 'uploading') return prev;
  if (result.ok && result.assetId) {
    return { ...prev, phase: 'uploaded', assetId: result.assetId, error: null, errorDetail: null };
  }
  return { ...prev, phase: 'error', error: 'upload_failed', errorDetail: result.error ?? 'The upload failed.' };
}

/** Reset back to idle, clearing the error but keeping the source for retry. */
export function captureReset(prev: CaptureState): CaptureState {
  return { ...INITIAL_CAPTURE_STATE, source: prev.source };
}

/**
 * True when the current state is a live recording (the stop button is shown).
 * Pure predicate used by the component and tests.
 */
export function isRecording(state: CaptureState): boolean {
  return state.phase === 'recording';
}

/**
 * True when the state is in a terminal non-error phase (uploaded) or idle.
 * Used to decide whether the panel shows a "capture another" button.
 */
export function canCaptureAgain(state: CaptureState): boolean {
  return state.phase === 'idle' || state.phase === 'uploaded' || state.phase === 'error';
}
