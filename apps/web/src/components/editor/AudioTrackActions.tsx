/**
 * ADD AUDIO and REPLACE SELECTED AUDIO, as two separate actions in the editor.
 *
 * Both use the existing editor operation contract through the page's `stage`
 * function, so server validation and the revision check still apply:
 *   - ADD inserts a new unapproved audio track from a library file.
 *   - REPLACE changes the file of the SELECTED track. It needs a review of the
 *     specific new file for that track, leaves the old file in the library, and
 *     withdraws the track's approval in the same operation.
 * Neither action generates speech. Generation is a separate, labelled step.
 */
import React, { useMemo, useState } from 'react';
import { Banner, Tag } from '../ui';
import { addAudioTrackOps, replaceAudioTrackOps, usableAudioAsset, type AudioTrackRef, type LibraryAudio } from '../../lib/audio-track-ops';
import type { EditorOperation } from '../../lib/editor-types';

export interface AudioTrackActionsProps {
  audioClips: AudioTrackRef[];
  selectedAudioId: string | null;
  library: LibraryAudio[];
  stage: (operations: EditorOperation[]) => unknown[];
  disabled: boolean;
}

export const AudioTrackActions: React.FC<AudioTrackActionsProps> = ({ audioClips, selectedAudioId, library, stage, disabled }) => {
  const [addAssetId, setAddAssetId] = useState('');
  const [replaceAssetId, setReplaceAssetId] = useState('');
  const [reviewedTrackId, setReviewedTrackId] = useState('');
  const [listened, setListened] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  const selected = audioClips.find((c) => c.id === selectedAudioId) ?? null;
  const audioAssets = useMemo(() => library.filter((a) => (a.mimeType ?? '').toLowerCase().startsWith('audio/')), [library]);
  const replaceAsset = audioAssets.find((a) => a.id === replaceAssetId) ?? null;
  const addAsset = audioAssets.find((a) => a.id === addAssetId) ?? null;

  const runAdd = () => {
    if (!addAsset) return;
    const built = addAudioTrackOps(audioClips, addAsset);
    if (!built.ok) {
      setMessage({ kind: 'bad', text: built.reason });
      return;
    }
    const findings = stage(built.operations);
    setMessage(findings.length ? { kind: 'bad', text: 'The editor refused the new track. Nothing was added.' } : { kind: 'ok', text: built.summary });
    if (!findings.length) setAddAssetId('');
  };

  const runReplace = () => {
    if (!selected || !replaceAsset) return;
    const built = replaceAudioTrackOps(selected, replaceAsset, { reviewedTrackId, listened });
    if (!built.ok) {
      setMessage({ kind: 'bad', text: built.reason });
      return;
    }
    const findings = stage(built.operations);
    setMessage(findings.length ? { kind: 'bad', text: 'The editor refused the replacement. The track is unchanged.' } : { kind: 'ok', text: built.summary });
    if (!findings.length) {
      setReplaceAssetId('');
      setListened(false);
      setReviewedTrackId('');
    }
  };

  return (
    <div className="card" data-testid="audio-track-actions">
      <h3>Audio tracks</h3>
      {message ? <Banner kind={message.kind === 'ok' ? 'ok' : 'bad'}>{message.text}</Banner> : null}

      <section data-testid="add-audio">
        <h4>ADD AUDIO</h4>
        <p className="small">Adds a new narration track from a library audio file. The new track starts unapproved.</p>
        <div className="row">
          <select aria-label="Audio file to add" value={addAssetId} onChange={(e) => setAddAssetId(e.target.value)} disabled={disabled}>
            <option value="">Choose a library audio file</option>
            {audioAssets.map((a) => (
              <option key={a.id} value={a.id}>{a.name}{typeof a.durationSec === 'number' ? ` (${a.durationSec.toFixed(1)} s)` : ' (no duration)'}</option>
            ))}
          </select>
          <button className="btn sm" disabled={disabled || !addAsset} onClick={runAdd} data-testid="add-audio-submit">Add audio track</button>
        </div>
        {addAsset && !usableAudioAsset(addAsset).ok ? <div className="small warn-text">{(usableAudioAsset(addAsset) as { reason: string }).reason}</div> : null}
      </section>

      <section className="mt" data-testid="replace-audio">
        <h4>REPLACE SELECTED AUDIO</h4>
        {!selected ? (
          <p className="small">Select an audio track first. Replacing needs a selected track.</p>
        ) : (
          <>
            <p className="small">
              Selected: <b className="mono">{selected.id}</b> {selected.approved ? <Tag kind="ok">approved</Tag> : <Tag kind="warn">not approved</Tag>}
              {selected.locked ? <Tag kind="warn">locked</Tag> : null}. Its current file is kept in the library. The replacement withdraws this track's approval.
            </p>
            <div className="row">
              <select aria-label="Replacement audio file" value={replaceAssetId} onChange={(e) => setReplaceAssetId(e.target.value)} disabled={disabled || selected.locked}>
                <option value="">Choose the replacement file</option>
                {audioAssets.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}{typeof a.durationSec === 'number' ? ` (${a.durationSec.toFixed(1)} s)` : ' (no duration)'}</option>
                ))}
              </select>
            </div>
            {replaceAsset ? (
              <div className="mt">
                <label className="row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={listened} onChange={(e) => setListened(e.target.checked)} disabled={disabled} data-testid="replace-review" />
                  I listened to “{replaceAsset.name}” and it is the track for {selected.id}.
                </label>
                <label className="row mt" style={{ gap: 8 }}>
                  Type the track id to confirm:
                  <input aria-label="Confirm track id" value={reviewedTrackId} onChange={(e) => setReviewedTrackId(e.target.value)} placeholder={selected.id} disabled={disabled} />
                </label>
              </div>
            ) : null}
            <div className="row mt">
              <button
                className="btn sm"
                disabled={disabled || !replaceAsset || !listened || reviewedTrackId !== selected.id}
                onClick={runReplace}
                data-testid="replace-audio-submit"
              >
                Replace file on {selected.id}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
};
