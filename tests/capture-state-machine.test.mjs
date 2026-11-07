/**
 * PURE-CONTRACT tests for the consented capture state machine.
 * Run: node --experimental-transform-types --test tests/capture-state-machine.test.mjs
 *
 * These exercise lib/capture.ts only. They are NOT browser-API evidence:
 * the real getDisplayMedia / getUserMedia / MediaRecorder calls are tested
 * separately by the component's happy-dom tests. A pass here proves the
 * deterministic transitions, error classification and upload payload rules.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(url))) {
        const candidate = new URL(url.href.endsWith('.js') ? url.href.slice(0, -3) + '.ts' : url.href + '.ts');
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  INITIAL_CAPTURE_STATE,
  captureStart,
  captureConsentGranted,
  captureConsentDenied,
  captureTick,
  captureStop,
  captureUploadPayload,
  captureUploadResult,
  captureReset,
  classifyMediaError,
  isRecording,
  canCaptureAgain,
} = await import('../apps/web/src/lib/capture.ts');

test('initial state is idle with no source', () => {
  assert.equal(INITIAL_CAPTURE_STATE.phase, 'idle');
  assert.equal(INITIAL_CAPTURE_STATE.source, null);
  assert.equal(INITIAL_CAPTURE_STATE.error, null);
});

test('captureStart from idle moves to requesting with consent pending', () => {
  const next = captureStart(INITIAL_CAPTURE_STATE, { source: 'screen', supported: true });
  assert.equal(next.phase, 'requesting');
  assert.equal(next.source, 'screen');
  assert.equal(next.consentPending, true);
});

test('captureStart refuses when the browser APIs are absent', () => {
  const next = captureStart(INITIAL_CAPTURE_STATE, { source: 'screen', supported: false });
  assert.equal(next.phase, 'error');
  assert.equal(next.error, 'not_supported');
});

test('captureStart refuses a second start while recording', () => {
  const recording = captureConsentGranted(captureStart(INITIAL_CAPTURE_STATE, { source: 'screen', supported: true }));
  const next = captureStart(recording, { source: 'screen', supported: true });
  assert.equal(next.error, 'recorder_error');
});

test('consent granted transitions requesting -> recording and clears consent pending', () => {
  const requesting = captureStart(INITIAL_CAPTURE_STATE, { source: 'microphone', supported: true });
  const next = captureConsentGranted(requesting);
  assert.equal(next.phase, 'recording');
  assert.equal(next.consentPending, false);
  assert.equal(next.elapsedSec, 0);
  assert.equal(isRecording(next), true);
});

test('consent denied classifies NotAllowedError as permission_denied', () => {
  const requesting = captureStart(INITIAL_CAPTURE_STATE, { source: 'screen', supported: true });
  const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const next = captureConsentDenied(requesting, err);
  assert.equal(next.phase, 'error');
  assert.equal(next.error, 'permission_denied');
});

test('consent denied classifies NotSupportedError as not_supported', () => {
  const requesting = captureStart(INITIAL_CAPTURE_STATE, { source: 'screen', supported: true });
  const err = Object.assign(new Error('not supported'), { name: 'NotSupportedError' });
  const next = captureConsentDenied(requesting, err);
  assert.equal(next.error, 'not_supported');
});

test('classifyMediaError falls back to recorder_error for unknown errors', () => {
  const code = classifyMediaError(new Error('something weird')).code;
  assert.equal(code, 'recorder_error');
});

test('captureTick updates elapsed seconds only while recording', () => {
  const recording = captureConsentGranted(captureStart(INITIAL_CAPTURE_STATE, { source: 'screen', supported: true }));
  const ticked = captureTick(recording, 5);
  assert.equal(ticked.elapsedSec, 5);
  const idle = captureTick(INITIAL_CAPTURE_STATE, 9);
  assert.equal(idle.elapsedSec, 0);
});

test('captureStop refuses an empty blob as empty_capture', () => {
  const recording = captureConsentGranted(captureStart(INITIAL_CAPTURE_STATE, { source: 'screen', supported: true }));
  const next = captureStop(recording, { blob: new Blob([]), mimeType: 'video/webm' });
  assert.equal(next.phase, 'error');
  assert.equal(next.error, 'empty_capture');
});

test('captureStop with a real blob moves to processing and records size + mime', () => {
  const recording = captureConsentGranted(captureStart(INITIAL_CAPTURE_STATE, { source: 'screen', supported: true }));
  const blob = new Blob([new Uint8Array(1024)], { type: 'video/webm' });
  const next = captureStop(recording, { blob, mimeType: 'video/webm' });
  assert.equal(next.phase, 'processing');
  assert.equal(next.blobSize, 1024);
  assert.equal(next.mimeType, 'video/webm');
});

test('captureUploadPayload refuses without operator confirmation', () => {
  const blob = new Blob([new Uint8Array(64)], { type: 'video/webm' });
  const result = captureUploadPayload({ blob, mimeType: 'video/webm', suggestedName: 'x.webm', operatorConfirmed: false });
  assert.equal(result.ok, false);
});

test('captureUploadPayload sets kind broll for a video capture', () => {
  const blob = new Blob([new Uint8Array(64)], { type: 'video/webm' });
  const result = captureUploadPayload({ blob, mimeType: 'video/webm', suggestedName: 'x.webm', operatorConfirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.fields.kind, 'broll');
  assert.match(result.fields.source, /Browser capture/);
});

test('captureUploadPayload sets kind sfx for an audio-only capture', () => {
  const blob = new Blob([new Uint8Array(64)], { type: 'audio/webm' });
  const result = captureUploadPayload({ blob, mimeType: 'audio/webm', suggestedName: 'x.webm', operatorConfirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.fields.kind, 'sfx');
});

test('captureUploadResult success moves to uploaded with the asset id', () => {
  const uploading = Object.assign({}, INITIAL_CAPTURE_STATE, { phase: 'uploading' });
  const next = captureUploadResult(uploading, { ok: true, assetId: 'asset-1', error: null });
  assert.equal(next.phase, 'uploaded');
  assert.equal(next.assetId, 'asset-1');
});

test('captureUploadResult failure moves to error', () => {
  const uploading = Object.assign({}, INITIAL_CAPTURE_STATE, { phase: 'uploading' });
  const next = captureUploadResult(uploading, { ok: false, assetId: null, error: 'boom' });
  assert.equal(next.phase, 'error');
  assert.equal(next.error, 'upload_failed');
  assert.equal(next.errorDetail, 'boom');
});

test('captureReset returns to idle but keeps the source for retry', () => {
  const err = captureConsentDenied(captureStart(INITIAL_CAPTURE_STATE, { source: 'screen', supported: true }), new Error('denied'));
  const next = captureReset(err);
  assert.equal(next.phase, 'idle');
  assert.equal(next.source, 'screen');
  assert.equal(next.error, null);
});

test('canCaptureAgain is true for idle, uploaded and error', () => {
  assert.equal(canCaptureAgain(INITIAL_CAPTURE_STATE), true);
  assert.equal(canCaptureAgain(Object.assign({}, INITIAL_CAPTURE_STATE, { phase: 'uploaded' })), true);
  assert.equal(canCaptureAgain(Object.assign({}, INITIAL_CAPTURE_STATE, { phase: 'error' })), true);
  assert.equal(canCaptureAgain(Object.assign({}, INITIAL_CAPTURE_STATE, { phase: 'recording' })), false);
});
