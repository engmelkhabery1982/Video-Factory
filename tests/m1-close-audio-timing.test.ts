/** Gate 2: per-clip timing and gain that the browser players are driven by. Code-level, no browser. */
import { describe, expect, it } from 'vitest';
import { audioClipPosition, audioClipLength, gainFactor } from '../apps/web/src/lib/editor-audio-timing.js';
import type { EditorAudioClip } from '../apps/web/src/lib/editor-types.js';

const clip = (over: Partial<EditorAudioClip>): EditorAudioClip => ({
  id: 'aud_1',
  sourceAssetId: 'aud-src',
  speakerId: null,
  startSec: 0,
  sourceInSec: 0,
  sourceOutSec: 3,
  gainDb: 0,
  locked: false,
  approved: false,
  ...over,
} as EditorAudioClip);

describe('audio clip assembly timing (Gate 2)', () => {
  it('a trimmed clip plays from sourceInSec at its composition start, and is silent outside its window', () => {
    const c = clip({ startSec: 2, sourceInSec: 1, sourceOutSec: 4 }); // 3 s of source, placed at 2 s
    expect(audioClipLength(c)).toBe(3);
    expect(audioClipPosition(c, 1.9)).toEqual({ active: false, expected: 1 });
    expect(audioClipPosition(c, 2)).toEqual({ active: true, expected: 1 });
    expect(audioClipPosition(c, 3.5).expected).toBeCloseTo(2.5, 6);
    expect(audioClipPosition(c, 5)).toEqual({ active: false, expected: 4 }); // window ends at 5 s, exclusive
  });

  it('two clips of the same source are independent windows on the common playhead', () => {
    const a = clip({ id: 'aud_1', startSec: 0, sourceInSec: 0, sourceOutSec: 3 });
    const b = clip({ id: 'aud_2', startSec: 1, sourceInSec: 0.5, sourceOutSec: 2.5 });
    expect(audioClipPosition(a, 1.5)).toEqual({ active: true, expected: 1.5 });
    expect(audioClipPosition(b, 1.5)).toEqual({ active: true, expected: 1 }); // 0.5 + (1.5 - 1)
    expect(audioClipPosition(b, 0.5).active).toBe(false);
  });

  it('gain is the same linear factor as the server volume filter (dB -> amplitude)', () => {
    expect(gainFactor(0)).toBe(1);
    expect(gainFactor(-6)).toBeCloseTo(0.5012, 3);
    expect(gainFactor(6)).toBeCloseTo(1.9953, 3);
  });
});
