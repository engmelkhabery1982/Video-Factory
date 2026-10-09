/**
 * Seek the existing narration player. Never changes src and never reports a
 * position the element did not keep.
 */

export const SEEK_HOLD_MS = 250;
export const SEEK_TOLERANCE_SEC = 0.75;

export interface AudioSeekResult {
  ok: boolean;
  position: number;
  message: string;
}

function waitFor(target: EventTarget, eventName: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      target.removeEventListener(eventName, onEvent);
      resolve(false);
    }, timeoutMs);
    const onEvent = () => {
      clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
      resolve(true);
    };
    target.addEventListener(eventName, onEvent);
  });
}

function refused(audio: HTMLAudioElement, message: string): AudioSeekResult {
  const position = audio.currentTime;
  return { ok: false, position: Number.isFinite(position) ? position : 0, message };
}

/**
 * Move one already-mounted audio element and start playback from that point.
 * The caller must invoke this from the click that requested the seek so play()
 * stays inside the user gesture when metadata is already loaded.
 */
export async function seekSamePlayer(audio: HTMLAudioElement, seconds: number): Promise<AudioSeekResult> {
  const src = audio.currentSrc || audio.src;
  if (!src) return refused(audio, 'The player has no recording. Playback was not moved.');
  if (!Number.isFinite(seconds) || seconds < 0) {
    return refused(audio, 'That position cannot be played. Playback was not moved.');
  }

  if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
    const playback = audio.play();
    const ready = await waitFor(audio, 'loadedmetadata', 8000);
    void playback.catch(() => undefined);
    if (!ready || audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      return refused(audio, 'The recording is not ready to seek. Playback was not moved.');
    }
  }

  if ((audio.currentSrc || audio.src) !== src) {
    return refused(audio, 'The player source changed. Playback was not moved.');
  }
  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    return refused(audio, 'The recording duration is unknown. Playback was not moved.');
  }
  if (seconds > duration + 0.05) {
    return refused(audio, 'That position is past the end of the recording. Playback was not moved.');
  }

  const target = Math.min(seconds, Math.max(0, duration - 0.001));
  let seeked = false;
  const onSeeked = () => {
    seeked = true;
  };
  audio.addEventListener('seeked', onSeeked);
  try {
    audio.currentTime = target;
  } catch {
    audio.removeEventListener('seeked', onSeeked);
    return refused(audio, 'The player refused that position. Playback was not moved.');
  }
  const playback = audio.play();
  const deadline = Date.now() + 2000;
  while (!seeked && Math.abs(audio.currentTime - target) > SEEK_TOLERANCE_SEC && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  audio.removeEventListener('seeked', onSeeked);
  await new Promise((resolve) => setTimeout(resolve, SEEK_HOLD_MS));
  void playback.catch(() => undefined);

  if ((audio.currentSrc || audio.src) !== src) {
    return refused(audio, 'The player source changed. Playback was not moved.');
  }
  const position = audio.currentTime;
  if (!Number.isFinite(position) || Math.abs(position - target) > Math.max(SEEK_TOLERANCE_SEC, 1.25)) {
    return refused(audio, 'Playback did not stay at the requested position. The position was not faked.');
  }
  return { ok: true, position, message: '' };
}
