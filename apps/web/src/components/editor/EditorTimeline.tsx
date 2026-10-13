import React from 'react';
import { Tag } from '../ui';
import type { EditorDocument } from '../../lib/editor-types';
import { documentDuration, motionLabel, round3, visualTimeline } from '../../lib/editor-model';

/**
 * Timeline: visual clips in composition order, the approved narration track,
 * caption intervals and timed highlights. Every block is a real button, so
 * selection and inspection work from the keyboard — drag-and-drop is not the
 * only way to operate this editor.
 */
export const EditorTimeline: React.FC<{
  document: EditorDocument;
  playhead: number;
  setPlayhead: (sec: number) => void;
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
  selectedAudioId: string | null;
  onSelectAudio: (id: string | null) => void;
  selectedCaptionId: string | null;
  onSelectCaption: (id: string | null) => void;
  selectedHighlightId: string | null;
  onSelectHighlight: (id: string | null) => void;
}> = ({
  document,
  playhead,
  setPlayhead,
  selectedClipId,
  onSelectClip,
  selectedAudioId,
  onSelectAudio,
  selectedCaptionId,
  onSelectCaption,
  selectedHighlightId,
  onSelectHighlight,
}) => {
  const total = Math.max(0.001, documentDuration(document));
  const placedClips = visualTimeline(document);
  const pct = (sec: number) => `${Math.max(0, Math.min(100, (sec / total) * 100)).toFixed(3)}%`;
  const span = (start: number, end: number) => ({ left: pct(start), width: `${Math.max(0.4, ((end - start) / total) * 100).toFixed(3)}%` });

  const moveSelection = (event: React.KeyboardEvent, currentId: string | null, ids: string[]) => {
    if (!ids.length) return;
    const index = currentId ? ids.indexOf(currentId) : -1;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      onSelectClip?.(ids[Math.min(ids.length - 1, index + 1)] ?? ids[0]);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onSelectClip?.(ids[Math.max(0, index - 1)] ?? ids[0]);
    }
  };

  const ticks = Array.from({ length: Math.floor(total) + 1 }, (_, index) => index).filter((sec) => sec % Math.max(1, Math.round(total / 10)) === 0);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>
          Timeline <span className="small">({total.toFixed(2)}s · {placedClips.length} visual clips · visual order is contiguous)</span>
        </h3>
        <div className="row">
          <button
            className="btn sm"
            onClick={() => onSelectClip(document.visualClips[0]?.id ?? null)}
            disabled={!document.visualClips.length}
          >
            Focus first clip
          </button>
          <span className="small mono">playhead {playhead.toFixed(2)}s</span>
        </div>
      </div>

      <div className="tl">
        <div className="tl-ruler" onClick={(e) => setPlayhead(round3(((e.nativeEvent as MouseEvent).offsetX / (e.currentTarget as HTMLElement).clientWidth) * total))}>
          {ticks.map((sec) => (
            <span key={sec} className="tl-tick mono" style={{ left: pct(sec) }}>
              {sec}s
            </span>
          ))}
          <div className="tl-playhead" style={{ left: pct(playhead) }} />
        </div>

        <div className="tl-track" role="group" aria-label="Visual clips" onKeyDown={(event) => moveSelection(event, selectedClipId, document.visualClips.map((clip) => clip.id))}>
          {placedClips.map((placed, index) => {
            const clip = placed.clip;
            const asset = document.assets.find((item) => item.id === clip.sourceAssetId) ?? null;
            return (
              <button
                type="button"
                key={clip.id}
                data-testid={`editor-clip-${clip.id}`}
                aria-pressed={selectedClipId === clip.id}
                className={`tl-clip ${selectedClipId === clip.id ? 'sel' : ''} ${clip.locked ? 'locked' : ''}`}
                style={span(placed.startSec, placed.endSec)}
                onClick={() => onSelectClip(clip.id)}
              >
                <div className="tl-clip-top">
                  <span className="mono">{String(index + 1).padStart(2, '0')} · {clip.id}</span>
                  {clip.locked ? <Tag kind="warn">locked</Tag> : null}
                </div>
                <div className="tl-clip-body">
                  <div>
                    {asset
                      ? `${asset.kind === 'image' ? 'still' : 'video'}: ${asset.name}`
                      : clip.sourceAssetId
                        ? `asset ${clip.sourceAssetId} — not described in this document`
                        : 'not bound'}
                  </div>
                  <div className="small">{placed.startSec.toFixed(2)}–{placed.endSec.toFixed(2)}s · src {clip.sourceInSec === null ? '—' : clip.sourceInSec.toFixed(2)}{clip.sourceOutSec === null ? '' : `–${clip.sourceOutSec.toFixed(2)}`}s</div>
                  <div className="small">{motionLabel(clip.motion)} · {clip.transition}</div>
                </div>
              </button>
            );
          })}
          {!placedClips.length ? <span className="small">No visual clips in this document yet.</span> : null}
        </div>

        <div className="tl-label small">approved narration</div>
        <div className="tl-track" role="group" aria-label="Audio clips">
          {document.audioClips.map((audio) => {
            const asset = document.assets.find((item) => item.id === audio.sourceAssetId) ?? null;
            return (
              <button
                type="button"
                key={audio.id}
                data-testid={`editor-audio-${audio.id}`}
                aria-pressed={selectedAudioId === audio.id}
                className={`tl-audio ${selectedAudioId === audio.id ? 'sel' : ''} ${audio.locked ? 'locked' : ''}`}
                style={span(audio.startSec, audio.startSec + Math.max(0.1, audio.sourceOutSec - audio.sourceInSec))}
                onClick={() => onSelectAudio(audio.id)}
              >
                <span className="mono">{audio.id}</span> {asset?.name ?? 'unknown file'}
                {audio.approved ? <Tag kind="ok">approved</Tag> : <Tag kind="warn">not approved</Tag>}
                {audio.locked ? <Tag kind="warn">locked</Tag> : null}
              </button>
            );
          })}
          {!document.audioClips.length ? <span className="small">No narration track in this document.</span> : null}
        </div>

        <div className="tl-label small">captions (an interval need not equal a scene)</div>
        <div className="tl-track" role="group" aria-label="Captions">
          {document.captions.map((cue) => (
            <button
              type="button"
              key={cue.id}
              data-testid={`editor-caption-${cue.id}`}
              aria-pressed={selectedCaptionId === cue.id}
              className={`tl-caption ${selectedCaptionId === cue.id ? 'sel' : ''} ${cue.locked ? 'locked' : ''}`}
              style={span(cue.startSec, cue.endSec)}
              dir={cue.direction}
              onClick={() => onSelectCaption(cue.id)}
            >
              {cue.text}
            </button>
          ))}
          {!document.captions.length ? <span className="small">No captions yet.</span> : null}
        </div>

        <div className="tl-label small">timed highlights</div>
        <div className="tl-track" role="group" aria-label="Highlights">
          {document.highlights.map((highlight) => (
            <button
              type="button"
              key={highlight.id}
              data-testid={`editor-highlight-marker-${highlight.id}`}
              aria-pressed={selectedHighlightId === highlight.id}
              className={`tl-highlight ${selectedHighlightId === highlight.id ? 'sel' : ''}`}
              style={span(highlight.startSec, highlight.endSec)}
              onClick={() => onSelectHighlight(highlight.id)}
            >
              <span className="mono">{highlight.label ?? highlight.id}</span> {highlight.startSec.toFixed(2)}–{highlight.endSec.toFixed(2)}s
              {highlight.locked ? <Tag kind="warn">locked</Tag> : null}
            </button>
          ))}
          {!document.highlights.length ? <span className="small">No highlights yet.</span> : null}
        </div>
      </div>
    </div>
  );
};
