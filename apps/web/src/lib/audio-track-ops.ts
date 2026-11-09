/**
 * ADD AUDIO and REPLACE SELECTED AUDIO as two distinct, pure operation builders
 * over the EXISTING editor operation contract (`insert` and `update` on
 * `audioClips`). Nothing here creates an endpoint or deletes a file.
 *
 * - ADD inserts a new narration track that points at a library audio file. It
 *   starts unapproved.
 * - REPLACE changes the source of one existing track. It refuses a locked track
 *   and it refuses until the reviewer has confirmed the specific new track. The
 *   previous file stays in the library, and the approval is withdrawn in the same
 *   operation, so an approval never survives the change that invalidates it.
 */
import type { EditorOperation } from './editor-types';

export interface LibraryAudio {
  id: string;
  name: string;
  kind: string;
  mimeType?: string;
  durationSec?: number;
  status?: string;
  blocked?: boolean;
  source?: string;
  license?: string;
}

export interface AudioTrackRef {
  id: string;
  sourceAssetId: string;
  speakerId: string | null;
  startSec: number;
  sourceInSec: number;
  sourceOutSec: number;
  gainDb: number;
  locked: boolean;
  approved: boolean;
}

export type AudioOpResult =
  | { ok: true; operations: EditorOperation[]; summary: string }
  | { ok: false; reason: string };

/** A library file that can be used as a narration track: active, not blocked, measured audio. */
export function usableAudioAsset(asset: LibraryAudio): { ok: true; durationSec: number } | { ok: false; reason: string } {
  if (asset.kind === 'image' || !(asset.mimeType ?? '').toLowerCase().startsWith('audio/')) {
    return { ok: false, reason: `“${asset.name}” is not an audio file. Pictures never fill an audio track.` };
  }
  if (asset.status !== undefined && asset.status !== 'active') return { ok: false, reason: `“${asset.name}” is not active in the library.` };
  if (asset.blocked === true) return { ok: false, reason: `“${asset.name}” is blocked in the library and cannot be used.` };
  if (typeof asset.durationSec !== 'number' || !(asset.durationSec > 0)) {
    return { ok: false, reason: `“${asset.name}” has no measured duration. Re-upload it so its length can be measured.` };
  }
  return { ok: true, durationSec: asset.durationSec };
}

function nextTrackId(existing: AudioTrackRef[]): string {
  const taken = new Set(existing.map((c) => c.id));
  let n = existing.length + 1;
  while (taken.has(`aud_${n}`)) n += 1;
  return `aud_${n}`;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** ADD AUDIO: insert a new unapproved track that plays the whole library file once. */
export function addAudioTrackOps(existing: AudioTrackRef[], asset: LibraryAudio): AudioOpResult {
  const usable = usableAudioAsset(asset);
  if (!usable.ok) return usable;
  const id = nextTrackId(existing);
  const clip: AudioTrackRef = {
    id,
    sourceAssetId: asset.id,
    speakerId: null,
    startSec: 0,
    sourceInSec: 0,
    sourceOutSec: round3(usable.durationSec),
    gainDb: 0,
    locked: false,
    approved: false,
  };
  return {
    ok: true,
    operations: [{ type: 'insert', collection: 'audioClips', item: clip }],
    summary: `Added track ${id} from “${asset.name}”. It is unapproved until you review it.`,
  };
}

/**
 * REPLACE SELECTED AUDIO. `reviewedTrackId` must equal the selected track id: the
 * reviewer confirms this specific track, not a general “replace”.
 */
export function replaceAudioTrackOps(
  track: AudioTrackRef,
  asset: LibraryAudio,
  review: { reviewedTrackId: string; listened: boolean },
): AudioOpResult {
  if (track.locked) return { ok: false, reason: `Track ${track.id} is locked. Unlock it before replacing it.` };
  if (!review.listened || review.reviewedTrackId !== track.id) {
    return { ok: false, reason: `Review the new file for track ${track.id} before replacing it.` };
  }
  if (asset.id === track.sourceAssetId) return { ok: false, reason: 'The selected track already uses this file.' };
  const usable = usableAudioAsset(asset);
  if (!usable.ok) return usable;
  return {
    ok: true,
    operations: [{
      type: 'update',
      collection: 'audioClips',
      id: track.id,
      // The old file is not touched: only the track's pointer changes, and its approval is withdrawn.
      changes: { sourceAssetId: asset.id, sourceInSec: 0, sourceOutSec: round3(usable.durationSec), approved: false },
    }],
    summary: `Replaced the file on track ${track.id} with “${asset.name}”. The previous file stays in the library. Approval is withdrawn until you review it again.`,
  };
}
