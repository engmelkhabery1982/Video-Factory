import React from 'react';
import type { TransitionVariantId } from '@buildtrack/core';
import { interpolate, useCurrentFrame } from 'remotion';
import { transitionFrames } from '@buildtrack/core';

/**
 * Transition variants (brief section 6).
 * Each is a pure function of the progress through the transition window, so it
 * is deterministic and frame-accurate.
 */
export const Transition: React.FC<{
  variant: TransitionVariantId;
  /** 0..1 across the transition window */
  p: number;
  accent: string;
  /** which side the outgoing content sits on */
  fromSide?: 'left' | 'right';
}> = ({ variant, p, accent, fromSide = 'left' }) => {
  const e = interpolate(p, [0, 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  switch (variant) {
    case 'push':
      return <div style={{ position: 'absolute', inset: 0, background: '#050C16', transform: `translateX(${fromSide === 'left' ? (1 - e) * 100 : -e * 100}%)` }} />;

    case 'zoom':
      return (
        <div style={{ position: 'absolute', inset: 0, background: '#050C16', transform: `scale(${interpolate(e, [0, 1], [1.18, 0.86])})`, opacity: interpolate(e, [0, 0.7, 1], [0, 1, 1]) }} />
      );

    case 'mask_reveal':
      return (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: '#050C16',
            clipPath: `polygon(0 0, ${e * 100}% 0, ${e * 100 - 12}% 100%, 0 100%)`,
          }}
        />
      );

    case 'data_wipe':
      return (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: interpolate(e, [0, 0.85, 1], [0, 1, 0]),
            background: `repeating-linear-gradient(90deg, #050C16 0 46px, ${accent} 46px 60px)`,
            transform: `translateX(${fromSide === 'left' ? (1 - e) * 100 : -e * 100}%)`,
          }}
        />
      );

    case 'document_page':
      return (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: '#FBFBF8',
            transform: `translateX(${fromSide === 'left' ? (1 - e) * 100 : -e * 100}%) rotate(${interpolate(e, [0, 1], [0, fromSide === 'left' ? 6 : -6])}deg) scale(${interpolate(e, [0, 1], [1.08, 1])}`,
            transformOrigin: fromSide === 'left' ? 'left center' : 'right center',
            boxShadow: '0 0 40px rgba(0,0,0,0.6)',
          }}
        />
      );

    case 'match_cut': {
      // a shape that starts exactly on the outgoing figure and lands on the
      // incoming one - the "match on number or shape" cut
      const r = interpolate(e, [0, 1], [6, 62]);
      return (
        <>
          <div style={{ position: 'absolute', inset: 0, background: '#050C16', opacity: interpolate(e, [0, 0.25, 0.8, 1], [0, 1, 1, 0]) }} />
          <div
            style={{
              position: 'absolute',
              width: `${r * 3}%`,
              aspectRatio: '1',
              borderRadius: '50%',
              border: `6px solid ${accent}`,
              left: fromSide === 'left' ? '8%' : '92%',
              top: '38%',
              transform: 'translate(-50%,-50%)',
              opacity: interpolate(e, [0.2, 0.5, 1], [0, 1, 0]),
            }}
          />
        </>
      );
    }

    case 'direct_cut':
    default:
      return null;
  }
};

export const transitionLength = (id: TransitionVariantId) => transitionFrames(id) / 30;
