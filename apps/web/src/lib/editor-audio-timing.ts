/**
 * Pure timing for the browser audio assembly (closure round, Gate 2). No DOM,
 * no React: these are the numbers the players are driven by, so they can be
 * tested directly.
 */
import type { EditorAudioClip } from './editor-types';

/** Length of the trimmed source a clip plays, in seconds. */
export function audioClipLength(clip: Pick<EditorAudioClip, 'sourceInSec' | 'sourceOutSec'>): number {
  return clip.sourceOutSec - clip.sourceInSec;
}

/**
 * Where a clip's player should be for a common playhead. A clip is audible only
 * inside its composition window [startSec, startSec + length). Inside it the
 * position is sourceInSec + (playhead - startSec); outside it, the position is
 * clamped to the trimmed interval and the player stays paused.
 */
export function audioClipPosition(clip: EditorAudioClip, playhead: number): { active: boolean; expected: number } {
  const relative = playhead - clip.startSec;
  const length = audioClipLength(clip);
  const active = relative >= 0 && relative < length;
  const expected = clip.sourceInSec + Math.min(length, Math.max(0, relative));
  return { active, expected };
}

/** Linear factor for a dB gain. Matches ffmpeg's `volume=<n>dB` used by the server render. */
export function gainFactor(gainDb: number): number {
  return Math.pow(10, gainDb / 20);
}
