import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Tag } from '../ui';
import type { EditorDocument, EditorFormat } from '../../lib/editor-types';
import {
  assetForClip,
  boxToPercent,
  captionsAt,
  clampBox,
  clipAtTime,
  documentDuration,
  highlightsAt,
  round3,
} from '../../lib/editor-model';
import { opUpdate } from '../../lib/editor-model';
import type { Stage } from './shared';
import { FindingsList } from './shared';
import { EditorAudioTracks, type AudioTrackReport } from './EditorAudioTracks';

export interface ServerPreviewView {
  mediaUrl: string;
  revision: number;
  range: { startSec: number; endSec: number } | null;
  stale: boolean;
}

/**
 * The picture the operator is editing.
 *
 * Two things are shown and never confused:
 *   - the BROWSER ASSEMBLY PREVIEW: pictures, approved narration, captions and
 *     timed highlights assembled in the browser from the document. It is
 *     approximate (no renderer, no burned-in captions) and says so.
 *   - the SERVER SNAPSHOT RENDER, when one exists for the CURRENT revision.
 *     A render from an older revision is labelled STALE and is not presented as
 *     the current edit.
 */
export const EditorStage: React.FC<{
  document: EditorDocument;
  playhead: number;
  setPlayhead: (sec: number) => void;
  playing: boolean;
  setPlaying: (value: boolean) => void;
  stage: Stage;
  selectedHighlightId: string | null;
  onSelectHighlight: (id: string | null) => void;
  serverPreview: ServerPreviewView | null;
  onSeek?: (sec: number) => void;
}> = ({
  document,
  playhead,
  setPlayhead,
  playing,
  setPlaying,
  stage,
  selectedHighlightId,
  onSelectHighlight,
  serverPreview,
  onSeek,
}) => {
  const duration = documentDuration(document);
  const placed = clipAtTime(document, playhead);
  const clip = placed?.clip ?? null;
  const asset = assetForClip(document, clip);
  const activeCaptions = captionsAt(document, playhead);
  const activeHighlights = highlightsAt(document, playhead).filter((highlight) => !clip || highlight.visualClipId === clip.id);
  const [draft, setDraft] = useState<{ id: string; box: { x: number; y: number; width: number; height: number } } | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  /**
   * A media element that failed to load is reported, not drawn as an empty
   * frame. `null` means "nothing has failed"; the URL identifies WHICH file
   * failed so switching clips clears the message.
   */
  const [failedMediaUrl, setFailedMediaUrl] = useState<string | null>(null);
  const [audioReport, setAudioReport] = useState<AudioTrackReport>({ failedClipIds: [], unappliedGainClipIds: [] });
  const dragRef = useRef<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; box: { x: number; y: number; width: number; height: number } } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoReady, setVideoReady] = useState(0);

  const frameWidthPx = document.format === 'landscape' ? 640 : 360;
  const scale = frameWidthPx / (document.format === 'landscape' ? 1920 : 1080);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setPlayhead(Math.min(duration, round3(playhead + 0.1)));
    }, 100);
    return () => clearInterval(timer);
  }, [playing, playhead, duration, setPlayhead]);

  useEffect(() => {
    if (playing && playhead >= duration) setPlaying(false);
  }, [playing, playhead, duration, setPlaying]);

  const kind = asset?.kind ?? 'none';
  const videoSrc = asset && kind === 'video' ? `${asset.mediaUrl}#t=${clip ? clip.sourceInSec : 0}` : null;
  const mediaUrl = asset?.mediaUrl ?? null;
  const mediaUnavailable = !!mediaUrl && failedMediaUrl === mediaUrl;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip || video.readyState === 0) return;
    const expected = (clip.sourceInSec ?? 0) + Math.max(0, playhead - clip.startSec);
    if (!playing) video.pause();
    if (Math.abs(video.currentTime - expected) > 0.2) video.currentTime = expected;
    if (playing && video.paused) void video.play().catch(() => { setPlaying(false); setFailedMediaUrl(mediaUrl); });
  }, [clip, mediaUrl, playhead, playing, videoReady, setPlaying]);

  useEffect(() => {
    setFailedMediaUrl(null);
  }, [mediaUrl, clip?.id]);

  const pointerToFrame = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };

  const beginDrag = (event: React.PointerEvent, highlightId: string, mode: 'move' | 'resize') => {
    const highlight = document.highlights.find((item) => item.id === highlightId);
    if (!highlight) return;
    if (highlight.locked) {
      setDragError('This highlight is locked. Unlock it before moving it.');
      return;
    }
    const point = pointerToFrame(event);
    dragRef.current = { id: highlightId, mode, startX: point.x, startY: point.y, box: { ...highlight.box } };
    setDraft({ id: highlightId, box: { ...highlight.box } });
    onSelectHighlight(highlightId);
    (event.target as Element).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = pointerToFrame(event);
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    const next = drag.mode === 'move'
      ? clampBox({ ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy })
      : clampBox({ ...drag.box, width: drag.box.width + dx, height: drag.box.height + dy });
    setDraft({ id: drag.id, box: next });
  };

  const endDrag = () => {
    const drag = dragRef.current;
    const next = draft;
    dragRef.current = null;
    if (!drag || !next) return;
    const highlight = document.highlights.find((item) => item.id === drag.id);
    if (highlight && (highlight.box.x !== next.box.x || highlight.box.y !== next.box.y || highlight.box.width !== next.box.width || highlight.box.height !== next.box.height)) {
      const findings = stage([opUpdate('highlights', drag.id, { box: next.box })]);
      if (findings.length) setDragError(findings[0].message);
      else setDragError(null);
    }
    setDraft(null);
  };

  const nudge = (highlightId: string, dx: number, dy: number) => {
    const highlight = document.highlights.find((item) => item.id === highlightId);
    if (!highlight) return;
    stage([opUpdate('highlights', highlightId, { box: clampBox({ ...highlight.box, x: highlight.box.x + dx, y: highlight.box.y + dy }) })]);
  };

  const frameStyle: React.CSSProperties = useMemo(
    () => ({
      position: 'relative',
      width: '100%',
      maxWidth: frameWidthPx * 1.6,
      aspectRatio: document.format === 'landscape' ? '16 / 9' : '9 / 16',
      margin: '0 auto',
      background: '#050b14',
      border: '1px solid var(--line)',
      borderRadius: 10,
      overflow: 'hidden',
    }),
    [document.format, frameWidthPx],
  );

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Preview</h3>
        <div className="row">
          <Tag kind="accent">browser assembly preview — approximate, not the server render</Tag>
          {serverPreview ? (
            <Tag kind={serverPreview.stale ? 'warn' : 'ok'}>
              {serverPreview.stale
                ? `STALE server render (revision ${serverPreview.revision}) — not your current edit`
                : `server snapshot render — revision ${serverPreview.revision}`}
            </Tag>
          ) : null}
        </div>
      </div>

      <div style={frameStyle} ref={frameRef} data-testid="editor-stage-frame">
        {videoSrc && !mediaUnavailable ? (
          <video
            ref={videoRef}
            key={`${clip?.id ?? 'none'}-${videoSrc}`}
            src={videoSrc}
            muted
            autoPlay={playing}
            playsInline
            onLoadedMetadata={() => setVideoReady((value) => value + 1)}
            onError={() => setFailedMediaUrl(mediaUrl)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', transform: clip ? `translate(${(clip.crop.x - 0.5) * 100 * -1}%, ${(clip.crop.y - 0.5) * 100 * -1}%) scale(${1 / Math.max(0.2, clip.crop.width)})` : undefined }}
          />
        ) : null}
        {asset && kind === 'image' && !mediaUnavailable ? (
          <img
            src={asset.mediaUrl}
            alt={asset.name}
            onError={() => setFailedMediaUrl(mediaUrl)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', transform: clip ? `translate(${(clip.crop.x - 0.5) * 100 * -1}%, ${(clip.crop.y - 0.5) * 100 * -1}%) scale(${1 / Math.max(0.2, clip.crop.width)})` : undefined }}
          />
        ) : null}
        {asset && kind === 'audio' ? (
          <div className="center small" style={{ paddingTop: '18%' }}>
            This clip is bound to audio. An audio file cannot fill a picture slot.
          </div>
        ) : null}
        {!asset ? (
          <div className="center small" style={{ paddingTop: '18%' }}>
            {clip ? 'This clip has no asset bound. Choose one in the asset panel — a file in the library is not bound to a scene until you assign it.' : 'No visual clips yet.'}
          </div>
        ) : null}
        {mediaUnavailable ? (
          <div className="center small" style={{ padding: '16% 18px 0' }} data-testid="editor-media-unavailable">
            <Tag kind="warn">media unavailable</Tag> the browser could not load this asset, so no picture is drawn here. The clip stays
            bound to the file: this is neither a successful load nor an empty slot.
            <div className="mono" style={{ marginTop: 6, wordBreak: 'break-all' }}>
              {mediaUrl}
            </div>
          </div>
        ) : null}

        {activeHighlights.map((highlight) => {
          const box = draft && draft.id === highlight.id ? draft.box : highlight.box;
          const percent = boxToPercent(box);
          const selected = selectedHighlightId === highlight.id;
          return (
            <div
              key={highlight.id}
              data-testid={`editor-highlight-${highlight.id}`}
              tabIndex={0}
              role="button"
              aria-label={`highlight ${highlight.label ?? highlight.id}`}
              title="Drag to move, or use the arrow keys. Times and coordinates are editable numerically too."
              onPointerDown={(event) => beginDrag(event, highlight.id, 'move')}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 0.01 : 0.002;
                if (event.key === 'ArrowLeft') nudge(highlight.id, -step, 0);
                else if (event.key === 'ArrowRight') nudge(highlight.id, step, 0);
                else if (event.key === 'ArrowUp') nudge(highlight.id, 0, -step);
                else if (event.key === 'ArrowDown') nudge(highlight.id, 0, step);
                else return;
                event.preventDefault();
              }}
              style={{
                position: 'absolute',
                ...percent,
                border: `${selected ? 3 : 2}px solid ${selected ? 'var(--accent)' : '#E4C98A'}`,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.28)',
                cursor: highlight.locked ? 'not-allowed' : 'move',
              }}
            >
              <span
                aria-hidden
                className="mono"
                style={{ position: 'absolute', left: 0, top: -18, fontSize: 10, color: '#E4C98A' }}
              >
                {highlight.label ?? highlight.id} {highlight.startSec.toFixed(2)}–{highlight.endSec.toFixed(2)}s
              </span>
              <span
                data-testid={`editor-highlight-handle-${highlight.id}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  beginDrag(event, highlight.id, 'resize');
                }}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                style={{ position: 'absolute', right: -5, bottom: -5, width: 10, height: 10, background: '#E4C98A', cursor: 'nwse-resize' }}
              />
            </div>
          );
        })}

        {activeCaptions.map((cue) => (
          <div
            key={cue.id}
            data-testid={`editor-stage-caption-${cue.id}`}
            dir={cue.direction}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${cue.position.y * 100}%`,
              display: 'flex',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <span
              style={{
                maxWidth: '92%',
                direction: cue.direction,
                textAlign: 'center',
                fontFamily: cue.direction === 'rtl' ? '"Noto Naskh Arabic", "Noto Sans Arabic", Amiri, Tahoma, sans-serif' : 'Inter, sans-serif',
                fontSize: Math.max(10, cue.fontSizePx * scale),
                lineHeight: 1.35,
                color: '#F7F1E4',
                background: 'rgba(12,18,16,0.9)',
                padding: '3px 10px',
                borderRadius: 4,
                whiteSpace: 'pre-wrap',
              }}
            >
              {cue.text}
            </span>
          </div>
        ))}

        <EditorAudioTracks document={document} playhead={playhead} playing={playing} setPlaying={setPlaying} onReport={setAudioReport} />
      </div>

      <div className="row mt" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <button className="btn" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? '❙❙ Pause' : '▶ Play'}
          </button>
          <button className="btn ghost" onClick={() => { setPlaying(false); setPlayhead(0); }}>
            ⤒ To start
          </button>
          <span className="mono small">
            {playhead.toFixed(2)}s / {duration.toFixed(2)}s
          </span>
        </div>
        <div className="row">
          <span className="small">{placed ? `clip ${clip?.id} · ${placed.startSec.toFixed(2)}–${placed.endSec.toFixed(2)}s` : 'no clip'}</span>
        </div>
      </div>

      <input
        className="mt"
        type="range"
        aria-label="Playhead"
        min={0}
        max={Math.max(0.1, duration)}
        step={0.05}
        value={playhead}
        style={{ width: '100%' }}
        onChange={(e) => {
          const next = Number(e.target.value);
          setPlaying(false);
          setPlayhead(next);
          onSeek?.(next);
        }}
      />

      {dragError ? <div className="banner warn">{dragError}</div> : null}
      {audioReport.failedClipIds.length ? (
        <div className="banner warn" data-testid="editor-audio-unavailable">
          The browser could not load or play audio clip <span className="mono">{audioReport.failedClipIds.join(', ')}</span>, so the browser
          preview is silent for it. The clip and its approval are untouched, and no voice was generated in its place.
        </div>
      ) : null}
      {audioReport.unappliedGainClipIds.length ? (
        <div className="banner warn" data-testid="editor-audio-gain-unapplied">
          Gain above 0 dB on audio clip <span className="mono">{audioReport.unappliedGainClipIds.join(', ')}</span> is not applied by this browser
          (Web Audio is unavailable here), so the browser preview plays it at 0 dB. The stored gain is unchanged.
        </div>
      ) : null}
      {activeHighlights.length ? (
        <p className="small" style={{ margin: '8px 0 0' }}>
          Timed highlights are owner/editor annotations with measured display coordinates and start/end times — they are not fabricated
          recorded cursor movements. Drag them here (or focus one and use the arrow keys); times and coordinates are also editable
          numerically in the Highlights panel.
        </p>
      ) : null}
    </div>
  );
};

export { FindingsList };
export type { EditorFormat };
