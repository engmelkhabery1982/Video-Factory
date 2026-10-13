import { describe, expect, it } from 'vitest';
import { addAudioTrackOps, replaceAudioTrackOps, type AudioTrackRef, type LibraryAudio } from '../../apps/web/src/lib/audio-track-ops';

const track = (over: Partial<AudioTrackRef> = {}): AudioTrackRef => ({
  id: 'ac_full_narration', sourceAssetId: 'old-audio', speakerId: null, startSec: 0, sourceInSec: 0, sourceOutSec: 10, gainDb: 0, locked: false, approved: true, ...over,
});
const wav: LibraryAudio = { id: 'new-audio', name: 'Read narration v2', kind: 'sfx', mimeType: 'audio/wav', durationSec: 7.25, status: 'active' };

describe('ADD AUDIO', () => {
  it('inserts a new unapproved track that plays the whole library file, and never touches other tracks', () => {
    const r = addAudioTrackOps([track()], wav);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.operations).toEqual([{ type: 'insert', collection: 'audioClips', item: expect.objectContaining({ id: 'aud_2', sourceAssetId: 'new-audio', sourceOutSec: 7.25, approved: false }) }]);
    expect(r.operations.every((o) => o.type === 'insert')).toBe(true);
  });

  it('refuses a picture, a blocked file, and an unmeasured file', () => {
    expect(addAudioTrackOps([], { ...wav, mimeType: 'image/png', kind: 'broll' }).ok).toBe(false);
    expect(addAudioTrackOps([], { ...wav, blocked: true }).ok).toBe(false);
    expect(addAudioTrackOps([], { ...wav, durationSec: undefined }).ok).toBe(false);
  });
});

describe('REPLACE SELECTED AUDIO', () => {
  it('refuses until the reviewer confirms this specific track', () => {
    expect(replaceAudioTrackOps(track(), wav, { reviewedTrackId: '', listened: true }).ok).toBe(false);
    expect(replaceAudioTrackOps(track(), wav, { reviewedTrackId: 'ac_full_narration', listened: false }).ok).toBe(false);
  });

  it('updates only the selected track: the file pointer and duration change, the approval is withdrawn, the old file is kept', () => {
    const r = replaceAudioTrackOps(track(), wav, { reviewedTrackId: 'ac_full_narration', listened: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.operations).toEqual([{
      type: 'update',
      collection: 'audioClips',
      id: 'ac_full_narration',
      changes: { sourceAssetId: 'new-audio', sourceInSec: 0, sourceOutSec: 7.25, approved: false },
    }]);
    // No removal of any asset or track is produced.
    expect(r.operations.some((o) => o.type === 'remove')).toBe(false);
    expect(r.summary).toMatch(/previous file stays in the library/);
  });

  it('refuses a locked track and the same file', () => {
    expect(replaceAudioTrackOps(track({ locked: true }), wav, { reviewedTrackId: 'ac_full_narration', listened: true }).ok).toBe(false);
    expect(replaceAudioTrackOps(track(), { ...wav, id: 'old-audio' }, { reviewedTrackId: 'ac_full_narration', listened: true }).ok).toBe(false);
  });
});
