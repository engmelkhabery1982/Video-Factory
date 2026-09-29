import React from 'react';
import type { CaptionCue, CaptionStyleId } from '@buildtrack/core';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { activeCue, captionAppear } from './timing';
import { FONTS, type Theme } from '../brand/theme';

/**
 * Caption layer - 5 shapes. The SHAPE is part of the brand, the VARIANT rotates
 * between videos (recorded in visual_history.json) so the caption treatment is
 * not identical across a channel's back catalogue.
 */

// cue.start/end are seconds; the frame is converted via fps (see ./timing)

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
  const { fps } = useVideoConfig();
  const live = activeCue(cues, f, fps);
  if (!live) return null;

  const short = format === 'short';
  const acc = sceneAccent ?? accent;
  // hard cap: a maximum of two lines, always
  const words = live.text.split(/\s+/);
  const maxChars = short ? 26 : 46;
  const mid = Math.ceil(words.length / 2);
  const lines =
    words.length <= 4
      ? [words.join(' ')]
      : short
        ? [words.slice(0, mid).join(' '), words.slice(mid).join(' ')]
        : words.join(' ').length > maxChars * 2
          ? [words.slice(0, mid).join(' '), words.slice(mid).join(' ')]
          : [words.join(' ')];

  const appear = captionAppear(live, f, fps);
  const size = short ? 54 : 40;
  /** usable width, kept inside the frame so a long line can never run off it */
  const inner = short ? 900 : 1500;
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

  const wrap = (inner2: React.ReactNode, pos: React.CSSProperties): React.ReactElement => (
    <div style={{ position: 'absolute', left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none', ...pos }}>
      <div style={{ opacity: appear, transform: `translateY(${(1 - appear) * 14}px)`, width: inner, maxWidth: '100%' }}>{inner2}</div>
    </div>
  );

  const highlight = (text: string, color = acc) =>
    text.split(/(\s+)/).map((w, i) =>
      live.terms.some((term) => w.toLowerCase().replace(/[.,!?]/g, '') === term.toLowerCase()) ? (
        <span key={i} style={{ color }}>{w}</span>
      ) : (
        <React.Fragment key={i}>{w}</React.Fragment>
      ),
    );

  /** one block per line, each an explicit width so nothing overflows */
  const stack = (color = acc): React.ReactElement[] =>
    lines.map((l, i) => (
      <div key={i} style={{ width: '100%' }}>
        {highlight(l, color)}
      </div>
    ));

  switch (style) {
    case 'boxed_center':
      return wrap(
        <div style={{ ...base, background: 'rgba(8,18,32,0.86)', border: `2px solid ${acc}66`, borderRadius: 12, padding: `${short ? 16 : 12}px ${short ? 26 : 26}px` }}>
          {stack()}
        </div>,
        short ? { bottom: 430 } : { bottom: 150 },
      );

    case 'word_pop': {
      // current word is emphasised - helps retention on shorts
      const first = words[0];
      return wrap(
        <div style={{ ...base, textAlign: short ? 'center' : 'left' }}>
          <span style={{ color: acc, fontSize: size * 1.06 }}>{highlight(first)}</span>{' '}
          {words.slice(1).join(' ')}
        </div>,
        short ? { bottom: 430 } : { bottom: 150 },
      );
    }

    case 'lower_band':
      return wrap(
        <div style={{ width: '100%', background: 'rgba(8,18,32,0.92)', borderTop: `4px solid ${acc}`, padding: `${short ? 20 : 14}px ${short ? 60 : 80}px`, textAlign: 'center' }}>
          {stack()}
        </div>,
        short ? { bottom: 380 } : { bottom: 110 },
      );

    case 'side_panel':
      return (
        <div style={{ position: 'absolute', right: short ? 0 : 90, top: '50%', transform: `translateY(-50%) translateX(${(1 - appear) * 60}px)`, opacity: appear, width: short ? 880 : 640, background: 'rgba(8,18,32,0.92)', borderRight: `6px solid ${acc}`, borderRadius: 14, padding: `${short ? 22 : 20}px ${short ? 36 : 32}px` }}>
          <div style={base}>{stack()}</div>
        </div>
      );

    case 'highlight_box':
      // the chip is filled with the accent, so every glyph on it - including the
      // highlighted terms - must be dark. Using the accent for the term colour
      // here painted accent-on-accent and made the word disappear.
      return wrap(
        <div style={{ ...base, background: acc, color: '#0B1220', textShadow: 'none', borderRadius: 10, padding: `${short ? 14 : 10}px ${short ? 26 : 24}px`, fontWeight: 900 }}>
          {stack('#0B1220')}
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
