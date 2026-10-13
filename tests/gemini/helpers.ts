/**
 * Test-only helpers for Gemini adapter tests. Everything here is a LABELLED TEST DOUBLE
 * or FIXTURE. No provider is contacted by any test that imports this file.
 */
import { GEMINI_HARD_CAPS, type PlanValidationContext } from '@buildtrack/core';

/** FIXTURE: a valid educational plan. Labelled fixture, not provider output. */
export function fixtureEducationalPlan(): Record<string, unknown> {
  const lines = [
    { id: 'L01', speaker: 'narrator', language: 'en', text: 'A concrete pour was booked for seven, but the truck arrived at nine.', quotedSourceRef: null },
    { id: 'L02', speaker: 'narrator', language: 'en', text: 'Confirm the delivery window the night before with the supplier.', quotedSourceRef: null },
    { id: 'L03', speaker: 'narrator', language: 'en', text: 'Write the confirmed time on the site board.', quotedSourceRef: null },
  ];
  return {
    script: { lines },
    treatments: [
      {
        id: 'T1', title: 'Problem, example, action', method: 'problem_worked_example_action', rationale: 'Opens on the failure, then shows the fix.',
        scenes: [
          { id: 'S1', lineIds: ['L01'], shotType: 'wide', visualRequirement: 'Site gate at dawn from existing footage', why: 'Establishes the problem', assetNeed: 'existing_library' },
          { id: 'S2', lineIds: ['L02'], shotType: 'screen_recording', visualRequirement: 'Real supplier portal screen recording', why: 'Shows the real confirmation step', assetNeed: 'screen_recording_needed' },
          { id: 'S3', lineIds: ['L03'], shotType: 'overlay_on_still', visualRequirement: 'Site board photo with a caption', why: 'Gives the action a visible anchor', assetNeed: 'image_needed' },
        ],
      },
      {
        id: 'T2', title: 'Walkthrough', method: 'conversational_walkthrough', rationale: 'Talks the viewer through it.',
        scenes: [
          { id: 'S1', lineIds: ['L01', 'L02'], shotType: 'medium', visualRequirement: 'Presenter at the site office', why: 'Keeps a personal tone', assetNeed: 'existing_library' },
          { id: 'S2', lineIds: ['L03'], shotType: 'close_up', visualRequirement: 'Hand writing the time on the board', why: 'Focuses the final step', assetNeed: 'existing_library' },
        ],
      },
      {
        id: 'T3', title: 'Result first', method: 'result_then_explanation', rationale: 'Starts from the outcome.',
        scenes: [
          { id: 'S1', lineIds: ['L03'], shotType: 'title_card', visualRequirement: 'Title card with the confirmed time', why: 'States the result first', assetNeed: 'none' },
          { id: 'S2', lineIds: ['L01', 'L02'], shotType: 'split_comparison', visualRequirement: 'Planned time beside actual arrival', why: 'Explains the gap', assetNeed: 'image_needed' },
        ],
      },
    ],
    sourceNotes: [{ claim: 'Deliveries are often booked without confirmation', status: 'needs_verification', sourceRef: null }],
    productMention: { enabled: false, factId: null, text: null },
  };
}

export function educationalCtx(overrides: Partial<PlanValidationContext> = {}): PlanValidationContext {
  return { profile: 'educational', suppliedReferenceIds: [], productFactIds: [], productMentionRequested: false, ...overrides };
}

/** TEST DOUBLE: a valid unary WAV (RIFF, PCM, 16-bit). Silence. Used for parser and artifact tests only. */
export function makeWav(opts: { seconds: number; sampleRate?: number; channels?: number; bits?: number; format?: number; dataBytesOverride?: number } = { seconds: 1 }): Uint8Array {
  const sampleRate = opts.sampleRate ?? 24000;
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const format = opts.format ?? 1;
  const blockAlign = channels * (bits / 8);
  const dataBytes = opts.dataBytesOverride ?? Math.round(opts.seconds * sampleRate) * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, format, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * blockAlign, true); dv.setUint16(32, blockAlign, true); dv.setUint16(34, bits, true);
  w(36, 'data'); dv.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export interface FakeCall { url: string; headers: Record<string, string>; body: any; signal: AbortSignal }

/** TEST DOUBLE: a scripted provider. Records every call so tests can assert call counts and payloads. */
export function scriptedFetch(responses: Array<
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'hang' }
  | { kind: 'throw'; message: string }
>) {
  const calls: FakeCall[] = [];
  const fn = async (url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next.kind === 'throw') throw new Error(next.message);
    if (next.kind === 'hang') {
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return { status: next.status, ok: next.status >= 200 && next.status < 300, json: async () => next.body };
  };
  return { fn, calls };
}

export function textResponse(obj: unknown) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } };
}

export function speechResponse(bytes: Uint8Array, mimeType = 'audio/wav') {
  return { candidates: [{ content: { parts: [{ inlineData: { mimeType, data: b64(bytes) } }] }, finishReason: 'STOP' }] };
}

export const CAPS = GEMINI_HARD_CAPS;
