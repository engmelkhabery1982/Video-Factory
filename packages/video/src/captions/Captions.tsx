import React from 'react';
import type { CaptionCue, CaptionStyleId } from '@buildtrack/core';
import { interpolate, useCurrentFrame } from 'remotion';
import { FONTS, type Theme } from '../brand/theme';

/**
 * Caption layer - 5 shapes. The SHAPE is part of the brand, the VARIANT rotates
 * between videos (recorded in visual_history.json) so the caption treatment is
 * not identical across a channel's back catalogue.
 */

const isCueLive = (c: CaptionCue, f: number) => f >= c.start && f < c.end;

export const Captions: React.FC<{
  cues: CaptionCue[];
  style: CaptionStyleId;
  t: Theme;
  accent: string;
  format: 'long' | 'short';
  /** scene accent in force, so captions pick up the current scene colour */
  sceneAccent?: string;
}> = ({ cues, style, t, accent, format, sceneAccent }) => {
  const f = useCurrentFrame();
  const live = cues.find((c) => isCueLive(c, f));
  if (!live) return null;

  const short = format === 'short';
  const acc = sceneAccent ?? accent;
  // hard cap: a maximum of two lines, always
  const words = live.text.split(/\s+/);
  const maxChars = short ? 22 : 42;
  const mid = Math.ceil(words.length / 2);
  const lines =
    words.length <= 4
      ? [words.join(' ')]
      : short
        ? [words.slice(0, mid).join(' '), words.slice(mid).join(' ')]
        : words.join(' ').length > maxChars * 2
          ? [words.slice(0, mid).join(' '), words.slice(mid).join(' ')]
          : [words.join(' ')];

  const appear = interpolate(f - Math.round(live.start), [0, 4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const size = short ? 60 : 40;
  const base: React.CSSProperties = {
    fontFamily: FONTS.body,
    fontWeight: 800,
    fontSize: size,
    lineHeight: 1.22,
    color: '#FFFFFF',
    textAlign: 'center',
    textShadow: '0 2px 6px rgba(0,0,0,0.9)',
    letterSpacing: -0.4,
  };

  const wrap = (inner: React.ReactNode, pos: React.CSSProperties): React.ReactElement => (
    <div style={{ position: 'absolute', left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none', ...pos }}>
      <div style={{ opacity: appear, transform: `translateY(${(1 - appear) * 14}px)` }}>{inner}</div>
    </div>
  );

  const highlight = (text: string) =>
    text.split(/(\s+)/).map((w, i) =>
      live.terms.some((term) => w.toLowerCase().replace(/[.,!?]/g, '') === term.toLowerCase()) ? (
        <span key={i} style={{ color: acc }}>{w}</span>
      ) : (
        <React.Fragment key={i}>{w}</React.Fragment>
      ),
    );

  switch (style) {
    case 'boxed_center':
      return wrap(
        <div style={{ ...base, background: 'rgba(8,18,32,0.82)', border: `2px solid ${acc}66`, borderRadius: 12, padding: `${short ? 18 : 12}px ${short ? 30 : 26}px`, maxWidth: short ? 900 : 1400 }}>
          {lines.map((l, i) => (
            <div key={i}>{highlight(l)}</div>
          ))}
        </div>,
        short ? { bottom: 430 } : { bottom: 150 },
      );

    case 'word_pop': {
      // current word is emphasised - helps retention on shorts
      const first = words[0];
      return wrap(
        <div style={{ ...base, maxWidth: short ? 900 : 1500 }}>
          <span style={{ color: acc, fontSize: size * 1.06 }}>{highlight(first)}</span>{' '}
          {words.slice(1).join(' ')}
        </div>,
        short ? { bottom: 430 } : { bottom: 150 },
      );
    }

    case 'lower_band':
      return wrap(
        <div style={{ width: '100%', background: 'rgba(8,18,32,0.9)', borderTop: `4px solid ${acc}`, padding: `${short ? 22 : 14}px ${short ? 60 : 80}px`, textAlign: 'center' }}>
          {lines.map((l, i) => (
            <div key={i}>{highlight(l)}</div>
          ))}
        </div>,
        short ? { bottom: 380 } : { bottom: 110 },
      );

    case 'side_panel':
      return (
        <div style={{ position: 'absolute', right: short ? 0 : 90, top: '50%', transform: `translateY(-50%) translateX(${(1 - appear) * 60}px)`, opacity: appear, width: short ? 900 : 640, background: 'rgba(8,18,32,0.9)', borderRight: `6px solid ${acc}`, borderRadius: 14, padding: `${short ? 24 : 20}px ${short ? 40 : 32}px` }}>
          <div style={base}>{lines.map((l, i) => <div key={i}>{highlight(l)}</div>)}</div>
        </div>
      );

    case 'highlight_box':
      return wrap(
        <div style={{ maxWidth: short ? 900 : 1400, display: 'flex', justifyContent: 'center' }}>
          <span style={{ ...base, background: acc, color: '#0B1220', textShadow: 'none', borderRadius: 10, padding: `${short ? 16 : 10}px ${short ? 28 : 24}px`, fontWeight: 900 }}>
            {highlight(lines.join(' '))}
          </span>
        </div>,
        short ? { bottom: 430 } : { bottom: 150 },
      );

    default:
      return wrap(<div style={base}>{live.text}</div>, short ? { bottom: 430 } : { bottom: 150 });
  }
};

/** Burned-in caption variant used for the "captions embedded" deliverable. */
export const BurnedCaptions: React.FC<{ cues: CaptionCue[]; t: Theme; accent: string; format: 'long' | 'short' }> = ({ cues, t, accent, format }) => (
  <Captions cues={cues} style="boxed_center" t={t} accent={accent} format={format} />
);
