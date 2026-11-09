/**
 * Browser assembly of the document's audio clips (closure round, Gate 2).
 *
 * Every audio clip gets its own media element. All of them follow the common
 * playhead: a clip is audible only inside its composition window
 * [startSec, startSec + (sourceOutSec - sourceInSec)), and it plays from
 * sourceInSec + (playhead - startSec). Two clips of the same source are two
 * independent elements. Gain uses a Web Audio GainNode with the same linear
 * factor the server's `volume=<gain>dB` filter applies. Where Web Audio is not
 * available a positive gain cannot be applied, and that is REPORTED, not
 * silently clipped to 0 dB.
 *
 * Source bytes are never modified: this only plays the stored file.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { EditorDocument } from '../../lib/editor-types';
import { audioClipPosition, gainFactor } from '../../lib/editor-audio-timing';

interface GraphNodes {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

export interface AudioTrackReport {
  /** Clips whose file the browser could not load or play. */
  failedClipIds: string[];
  /** Clips whose positive gain could not be applied by this browser. */
  unappliedGainClipIds: string[];
}

interface Props {
  document: EditorDocument;
  playhead: number;
  playing: boolean;
  /** Called when a clip cannot play, so the transport can stop. */
  setPlaying: (value: boolean) => void;
  onReport?: (report: AudioTrackReport) => void;
}

const DRIFT_TOLERANCE_SEC = 0.25;

export const EditorAudioTracks: React.FC<Props> = ({ document, playhead, playing, setPlaying, onReport }) => {
  const elements = useRef(new Map<string, HTMLAudioElement>());
  const graphs = useRef(new WeakMap<HTMLAudioElement, GraphNodes>());
  const contextRef = useRef<AudioContext | null>(null);
  const [readyTick, setReadyTick] = useState(0);
  const [failed, setFailed] = useState<Record<string, true>>({});
  // Decided at mount: a browser without Web Audio cannot boost, and says so before Play.
  const [webAudioMissing, setWebAudioMissing] = useState(() => typeof (globalThis as { AudioContext?: unknown }).AudioContext === 'undefined');

  const tracks = useMemo(
    () =>
      document.audioClips.map((clip) => {
        const asset = document.assets.find((item) => item.id === clip.sourceAssetId);
        const url = asset && asset.kind === 'audio' && asset.mediaUrl ? asset.mediaUrl : null;
        return { clip, url };
      }),
    [document.audioClips, document.assets],
  );

  // Clip ids that no longer exist are dropped from the failure list.
  useEffect(() => {
    setFailed((prev) => {
      const live = new Set(document.audioClips.map((clip) => clip.id));
      const next: Record<string, true> = {};
      for (const id of Object.keys(prev)) if (live.has(id)) next[id] = true;
      return next;
    });
  }, [document.audioClips]);

  /** Stable gain per element: created once, re-targeted on every sync. */
  const ensureGraph = (clipId: string, el: HTMLAudioElement): GraphNodes | null => {
    const existing = graphs.current.get(el);
    if (existing) return existing;
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) {
      setWebAudioMissing(true);
      return null;
    }
    if (!contextRef.current || contextRef.current.state === 'closed') contextRef.current = new Ctor();
    const ctx = contextRef.current;
    try {
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(ctx.destination);
      const nodes = { source, gain };
      graphs.current.set(el, nodes);
      return nodes;
    } catch {
      // The element already has a source in another context: report, do not guess.
      setWebAudioMissing(true);
      void clipId;
      return null;
    }
  };

  const failedIds = Object.keys(failed);

  // Common-playhead sync. Runs on every playhead tick, for every clip.
  useEffect(() => {
    for (const { clip } of tracks) {
      const el = elements.current.get(clip.id);
      if (!el || el.readyState === 0) continue;
      const { active, expected } = audioClipPosition(clip, playhead);
      const factor = gainFactor(clip.gainDb);
      if (playing && active) {
        const nodes = ensureGraph(clip.id, el);
        if (nodes) {
          nodes.gain.gain.value = factor;
          el.volume = 1;
        } else {
          // No graph: the element's own volume can attenuate but not boost.
          // A positive gain stays unapplied and is reported (see unappliedGainClipIds).
          el.volume = Math.min(1, factor);
        }
      } else {
        const nodes = graphs.current.get(el);
        if (nodes) nodes.gain.gain.value = factor;
        else el.volume = Math.min(1, factor);
      }
      if (!playing || !active) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - expected) > DRIFT_TOLERANCE_SEC) el.currentTime = expected;
      } else {
        if (Math.abs(el.currentTime - expected) > DRIFT_TOLERANCE_SEC) el.currentTime = expected;
        if (el.paused) {
          if (contextRef.current?.state === 'suspended') void contextRef.current.resume();
          void el.play().catch(() => {
            setFailed((prev) => ({ ...prev, [clip.id]: true }));
            setPlaying(false);
          });
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, playhead, playing, readyTick]);

  // Report upward (failures and unapplied gain) without re-running the sync loop.
  useEffect(() => {
    onReport?.({ failedClipIds: failedIds, unappliedGainClipIds: webAudioMissing ? document.audioClips.filter((c) => c.gainDb > 0).map((c) => c.id) : [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedIds.join('|'), webAudioMissing, document.audioClips]);

  // Pausing or stopping the transport stops every element at once.
  useEffect(() => {
    if (playing) return;
    for (const el of elements.current.values()) if (!el.paused) el.pause();
  }, [playing]);

  // Cleanup on unmount: every player stops and releases its file.
  useEffect(() => {
    const map = elements.current;
    return () => {
      for (const el of map.values()) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      map.clear();
      const ctx = contextRef.current;
      contextRef.current = null;
      if (ctx && ctx.state !== 'closed') void ctx.close();
    };
  }, []);

  return (
    <>
      {tracks.map(({ clip, url }) =>
        url ? (
          <audio
            key={`${clip.id}|${url}`}
            data-testid="editor-audio-clip"
            data-clip-id={clip.id}
            data-source-asset={clip.sourceAssetId}
            data-gain-db={clip.gainDb}
            data-source-in={clip.sourceInSec}
            data-source-out={clip.sourceOutSec}
            preload="auto"
            src={url}
            ref={(el) => {
              if (el) elements.current.set(clip.id, el);
              else elements.current.delete(clip.id);
            }}
            onLoadedMetadata={() => setReadyTick((value) => value + 1)}
            onCanPlay={() => setReadyTick((value) => value + 1)}
            onError={() => setFailed((prev) => ({ ...prev, [clip.id]: true }))}
          />
        ) : null,
      )}
    </>
  );
};
