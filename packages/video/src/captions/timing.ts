/**
 * Caption timing. Cues are stored in SECONDS; Remotion's `useCurrentFrame()`
 * is a FRAME number. Every comparison converts through the composition fps,
 * so the same cue is live over the same wall-clock interval at any frame rate.
 * Pure functions (no Remotion import) so they are unit-tested directly.
 */
export interface TimedCue {
  start: number;
  end: number;
}

export const CAPTION_APPEAR_FRAMES = 4;

export function frameToSeconds(frame: number, fps: number): number {
  return frame / fps;
}

/** first frame on which the cue is visible */
export function cueStartFrame(cue: TimedCue, fps: number): number {
  return Math.round(cue.start * fps);
}

/** first frame on which the cue is no longer visible */
export function cueEndFrame(cue: TimedCue, fps: number): number {
  return Math.round(cue.end * fps);
}

/** frame-based, so boundaries are exact integers at every fps */
export function isCueLive(cue: TimedCue, frame: number, fps: number): boolean {
  return frame >= cueStartFrame(cue, fps) && frame < cueEndFrame(cue, fps);
}

export function activeCue<T extends TimedCue>(cues: T[], frame: number, fps: number): T | undefined {
  return cues.find((c) => isCueLive(c, frame, fps));
}

/** 0..1 entrance progress, starting at the cue's real start frame */
export function captionAppear(cue: TimedCue, frame: number, fps: number): number {
  const p = (frame - cueStartFrame(cue, fps)) / CAPTION_APPEAR_FRAMES;
  return Math.max(0, Math.min(1, p));
}
