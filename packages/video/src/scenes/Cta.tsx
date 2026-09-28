import React from 'react';
import type { CtaAnimationId, Scene } from '@buildtrack/core';
import { interpolate, useCurrentFrame } from 'remotion';
import { FONTS, typeScale, type Theme } from '../brand/theme';
import { ease, riseIn } from './Hooks';

/**
 * CTA card - 5 distinct animations so consecutive videos never close the same
 * way. The CTA is a single 6-8s beat in the long video and a single 2.5s beat in
 * a short, and it always sits clear of the platform UI zones.
 */
export const CtaCard: React.FC<{ scene: Scene; t: Theme; accent: string; format: 'long' | 'short'; animation: CtaAnimationId; productName: string; ctaText: string; logoSrc?: string | null }> = ({
  scene,
  t,
  accent,
  format,
  animation,
  productName,
  ctaText,
  logoSrc,
}) => {
  const f = useCurrentFrame();
  const ts = typeScale(format);
  const wide = format === 'long';
  const text = ctaText || scene.content.headline;

  const counter = text.match(/(\d+)/);
  const counterValue = counter ? counter[1] : null;

  let anim: React.CSSProperties = { opacity: 1, transform: 'none' };
  let headline = text;

  switch (animation) {
    case 'slide_in': {
      const p = ease(f, 4, 24);
      anim = { opacity: p, transform: `translateX(${(1 - p) * -70}px)` };
      break;
    }
    case 'typewriter': {
      const total = Math.max(1, Math.round(text.length / 3));
      const n = Math.min(text.length, Math.floor(ease(f, 2, total + 14) * text.length));
      headline = text.slice(0, n);
      break;
    }
    case 'counter_up': {
      if (counterValue) {
        const target = Number(counterValue);
        const shown = Math.round(interpolate(ease(f, 0, 26), [0, 1], [0, target]));
        headline = text.replace(counterValue, String(shown));
      } else {
        const p = ease(f, 0, 20);
        anim = { opacity: p, transform: `translateY(${(1 - p) * 40}px)` };
      }
      break;
    }
    case 'scale_pop': {
      const k = Math.abs(Math.sin((f / 30) * Math.PI * 1.1));
      anim = { opacity: ease(f, 2, 12), transform: `scale(${0.94 + ease(f, 2, 18) * 0.06 + k * 0.012})` };
      break;
    }
    case 'wipe_reveal': {
      const p = ease(f, 3, 26);
      anim = { opacity: Math.min(1, p * 2), clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` };
      break;
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: wide ? 'flex-start' : 'center',
        padding: wide ? '0 96px' : '0 72px 300px',
        textAlign: wide ? 'left' : 'center',
      }}
    >
      <div style={{ ...riseIn(f, 0), display: 'inline-flex', alignItems: 'center', gap: 14, marginBottom: wide ? 26 : 24 }}>
        <div style={{ width: wide ? 64 : 78, height: 6, borderRadius: 3, background: accent }} />
        <span style={{ fontFamily: FONTS.body, fontSize: wide ? 26 : 34, letterSpacing: 5, color: accent, fontWeight: 800, textTransform: 'uppercase' }}>Next step</span>
      </div>

      <div
        style={{
          ...anim,
          fontFamily: FONTS.heading,
          fontWeight: 800,
          fontSize: wide ? ts.h1 : 86,
          lineHeight: 1.05,
          letterSpacing: -2.4,
          color: t.c.textOnDark,
          maxWidth: wide ? 1280 : 900,
        }}
      >
        {headline}
        {animation === 'typewriter' && f < 40 ? <span style={{ color: accent }}>▌</span> : null}
      </div>

      <div style={{ ...riseIn(f, 20), marginTop: wide ? 34 : 30, display: 'flex', alignItems: 'center', gap: wide ? 20 : 18, flexWrap: 'wrap', justifyContent: wide ? 'flex-start' : 'center' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 16,
            padding: wide ? '20px 36px' : '22px 34px',
            borderRadius: 999,
            background: accent,
            color: '#0B1220',
            fontFamily: FONTS.body,
            fontWeight: 800,
            fontSize: wide ? 30 : 38,
            letterSpacing: 1.2,
            boxShadow: `0 10px 26px ${accent}44`,
          }}
        >
          {productName}
          <span style={{ fontSize: wide ? 34 : 42 }}>→</span>
        </div>
        {logoSrc ? <img src={logoSrc} style={{ height: wide ? 44 : 54, width: 'auto', opacity: 0.95 }} /> : null}
      </div>
    </div>
  );
};
