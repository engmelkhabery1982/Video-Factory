import React from 'react';
import type { HookVariantId, Scene } from '@buildtrack/core';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONTS, typeScale, type Theme } from '../brand/theme';

export const ease = (f: number, start = 0, end = 18) =>
  interpolate(f, [start, end], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

export const riseIn = (f: number, delay = 0, dist = 46) => ({
  opacity: ease(f, delay, delay + 12),
  transform: `translateY(${interpolate(ease(f, delay, delay + 14), [0, 1], [dist, 0])}px)`,
});

export const scaleIn = (f: number, delay = 0, from = 0.86) => {
  const p = ease(f, delay, delay + 16);
  return { opacity: p, transform: `scale(${interpolate(p, [0, 1], [from, 1])})` };
};

export const slideIn = (f: number, delay = 0, from = -1) => {
  const p = ease(f, delay, delay + 14);
  return { opacity: p, transform: `translateX(${interpolate(p, [0, 1], [from * 90, 0])}%)` };
};

/** Shared on-screen brand chrome - identity is constant across all videos. */
export const Chrome: React.FC<{
  t: Theme;
  accent: string;
  section?: string;
  dark: boolean;
  format: 'long' | 'short';
  progress: number;
  logoSrc?: string | null;
  endScreenClear?: boolean;
}> = ({ t, accent, section, dark, format, progress, logoSrc, endScreenClear }) => {
  const f = useCurrentFrame();
  const pad = format === 'long' ? 96 : 72;
  const fg = dark ? t.c.textOnDark : t.c.textOnLight;
  const rail = format === 'long' ? 'left' : 'center';

  return (
    <>
      {/* top progress rail */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: 6, background: dark ? '#FFFFFF14' : '#0B122018' }}>
        <div style={{ width: `${progress * 100}%`, height: '100%', background: accent, opacity: 0.9 }} />
      </div>

      {/* section label */}
      {section ? (
        <div
          style={{
            position: 'absolute',
            top: pad,
            [rail]: pad,
            transform: rail === 'center' ? 'translateX(-50%)' : undefined,
            opacity: 0.85,
            ...riseIn(f, 2),
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 12,
              fontFamily: FONTS.body,
              fontSize: format === 'long' ? 22 : 30,
              fontWeight: 700,
              letterSpacing: format === 'long' ? 3.4 : 3.0,
              textTransform: 'uppercase',
              color: fg,
              opacity: 0.72,
            }}
          >
            <span style={{ width: 44, height: 4, background: accent, display: 'inline-block', borderRadius: 2 }} />
            {section}
          </div>
        </div>
      ) : null}

      {/* logo - always small, never a full-screen opener */}
      <div
        style={{
          position: 'absolute',
          bottom: format === 'long' ? 44 : 190,
          left: pad,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          opacity: 0.9,
          ...riseIn(f, 6),
        }}
      >
        {logoSrc ? (
          <img src={logoSrc} style={{ height: format === 'long' ? 34 : 44, width: 'auto', opacity: 0.95 }} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: fg }}>
            <div style={{ width: format === 'long' ? 30 : 40, height: format === 'long' ? 30 : 40, borderRadius: 9, background: `linear-gradient(135deg, ${t.c.secondary}, ${t.c.primary})` }} />
            <span style={{ fontFamily: FONTS.heading, fontWeight: 800, fontSize: format === 'long' ? 26 : 34, letterSpacing: -0.4 }}>
              Build<span style={{ color: t.c.secondary }}>Track</span>
            </span>
          </div>
        )}
      </div>

      {/* YouTube end-screen safe zone - deliberately left empty */}
      {endScreenClear ? (
        <div
          style={{
            position: 'absolute',
            right: 48,
            bottom: 48,
            width: 480,
            height: 360,
            border: `2px dashed ${dark ? '#FFFFFF20' : '#0B122020'}`,
            borderRadius: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: dark ? '#FFFFFF30' : '#0B122030',
            fontFamily: FONTS.body,
            fontSize: 20,
            letterSpacing: 2,
            textTransform: 'uppercase',
          }}
        >
          end screen space
        </div>
      ) : null}
    </>
  );
};

/* ------------------------------------------------------------------ */
/* HOOK VARIANTS - 8 distinct openings                                 */
/* ------------------------------------------------------------------ */

const Hook: React.FC<{ scene: Scene; t: Theme; accent: string; format: 'long' | 'short' }> = ({ scene, t, accent, format }) => {
  const f = useCurrentFrame();
  const ts = typeScale(format);
  const dark = scene.background !== 'light_technical';
  const fg = dark ? t.c.textOnDark : t.c.textOnLight;
  const sub = dark ? '#9FB6CF' : '#4A5B70';
  const c = scene.content;
  const wide = format === 'long';

  const bigText: React.CSSProperties = {
    fontFamily: FONTS.heading,
    fontWeight: 800,
    fontSize: wide ? ts.h1 : ts.h1 * 0.92,
    lineHeight: 1.04,
    letterSpacing: -2.4,
    color: fg,
    textWrap: 'balance',
  };

  switch (scene.variant as HookVariantId) {
    /* ---- Question Hook: centred question mark motif ---- */
    case 'question': {
      const ring = ease(f, 0, 20);
      return (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center', padding: wide ? '0 96px' : '0 72px' }}>
          <div style={{ position: 'absolute', left: wide ? 120 : '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 720, height: 720, borderRadius: '50%', border: `3px solid ${accent}55`, opacity: ring * 0.8, scale: String(0.8 + ring * 0.35) }} />
          <div style={{ position: 'absolute', left: wide ? 120 : '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 470, height: 470, borderRadius: '50%', border: `2px solid ${accent}33`, opacity: ring }} />
          <div style={{ position: 'relative', maxWidth: wide ? 1180 : 900, ...riseIn(f, 4) }}>
            <div style={{ fontFamily: FONTS.numeric, fontSize: wide ? 40 : 56, color: accent, fontWeight: 700, letterSpacing: 6, marginBottom: 22, opacity: 0.95 }}>ASK THE QUESTION</div>
            <div style={bigText}>{c.headline}</div>
            {c.subline ? <div style={{ ...slideIn(f, 14, -1), fontFamily: FONTS.body, fontSize: wide ? ts.body : ts.body, color: sub, marginTop: 28, fontWeight: 500 }}>{c.subline}</div> : null}
          </div>
        </div>
      );
    }

    /* ---- Surprising Number: huge numeral left, copy right ---- */
    case 'surprising_number': {
      const pop = spring({ frame: f, fps: 30, config: { damping: 12, stiffness: 140 } });
      return (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', flexDirection: wide ? 'row' : 'column', justifyContent: 'center', padding: wide ? '0 96px' : '120px 72px', gap: wide ? 72 : 36 }}>
          <div
            style={{
              fontFamily: FONTS.numeric,
              fontSize: wide ? ts.stat : 230,
              fontWeight: 800,
              color: accent,
              lineHeight: 0.86,
              letterSpacing: -8,
              transform: `scale(${0.86 + pop * 0.14})`,
              textShadow: `0 0 26px ${accent}55`,
            }}
          >
            {c.stat ?? c.headline}
          </div>
          <div style={{ maxWidth: wide ? 900 : 900 }}>
            <div style={{ ...riseIn(f, 8), fontFamily: FONTS.heading, fontWeight: 800, fontSize: wide ? ts.h2 : 78, color: fg, lineHeight: 1.08, letterSpacing: -1.6 }}>
              {c.stat ? c.subline : c.headline}
            </div>
            <div style={{ ...slideIn(f, 18, 1), marginTop: 26, display: 'inline-block', padding: '12px 24px', borderRadius: 10, background: `${accent}22`, border: `2px solid ${accent}66`, color: accent, fontFamily: FONTS.body, fontWeight: 800, fontSize: wide ? 30 : 40, letterSpacing: 2 }}>
              THIS IS THE REAL NUMBER
            </div>
          </div>
        </div>
      );
    }

    /* ---- Before vs After: two columns with a divider wipe ---- */
    case 'before_after': {
      const wipe = ease(f, 4, 30);
      const left = c.stat ?? 'BEFORE';
      const right = c.stat2 ?? 'AFTER';
      return (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', padding: wide ? '150px 96px' : '180px 72px', gap: wide ? 0 : 36 }}>
          <Panel t={t} accent={accent} label="BEFORE" value={left} f={f} delay={2} dark={dark} wide={wide} muted />
          <div style={{ position: 'relative', flex: wide ? '0 0 8px' : '0 0 8px', background: accent, opacity: 0.85, transform: `scaleY(${wipe})` }} />
          <Panel t={t} accent={accent} label="AFTER" value={right} f={f} delay={12} dark={dark} wide={wide} />
        </div>
      );
    }

    /* ---- Common Mistake: cross-out stamp ---- */
    case 'common_mistake': {
      const stamp = ease(f, 6, 20);
      return (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: wide ? 'flex-start' : 'center', justifyContent: 'center', padding: wide ? '0 96px' : '300px 72px 620px' }}>
          <div
            style={{
              ...scaleIn(f, 0, 0.7),
              display: 'inline-flex',
              alignItems: 'center',
              gap: 14,
              padding: '14px 28px',
              borderRadius: 14,
              background: '#E5484D22',
              border: `3px solid #E5484D`,
              color: '#FF7A7E',
              fontFamily: FONTS.body,
              fontWeight: 800,
              fontSize: wide ? 30 : 40,
              letterSpacing: 3,
              marginBottom: 34,
              transform: `rotate(-2.5deg) scale(${0.7 + stamp * 0.3})`,
            }}
          >
            <span style={{ fontSize: wide ? 40 : 52 }}>✕</span> COMMON MISTAKE
          </div>
          <div style={{ maxWidth: wide ? 1280 : 900, ...riseIn(f, 10), textAlign: wide ? 'left' : 'center' }}>
            <div style={bigText}>{c.headline}</div>
            {c.subline ? <div style={{ fontFamily: FONTS.body, fontSize: wide ? ts.body : ts.body, color: sub, marginTop: 26 }}>{c.subline}</div> : null}
          </div>
        </div>
      );
    }

    /* ---- Risk / Warning: hazard band ---- */
    case 'risk_warning': {
      const sweep = ease(f, 0, 22);
      return (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: wide ? '0 96px' : '300px 72px 620px' }}>
          <div
            style={{
              ...slideIn(f, 0, -1),
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              alignSelf: wide ? 'flex-start' : 'center',
              // solid accent chip, not a hazard stripe: dark text over the dark
              // half of the stripe was unreadable, and U+26A0 is not in the
              // brand font, so it rendered as a tofu box.
              background: accent,
              padding: '14px 32px',
              borderRadius: 8,
              color: '#0B1220',
              fontFamily: FONTS.body,
              fontWeight: 900,
              fontSize: wide ? 30 : 40,
              letterSpacing: 4,
              textTransform: 'uppercase',
              marginBottom: 36,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 0,
                height: 0,
                borderLeft: `${(wide ? 17 : 21)}px solid transparent`,
                borderRight: `${(wide ? 17 : 21)}px solid transparent`,
                borderBottom: `${(wide ? 30 : 38)}px solid #0B1220`,
                flexShrink: 0,
              }}
            />
            RISK
          </div>
          <div style={{ maxWidth: wide ? 1300 : 900, ...riseIn(f, 8) }}>
            <div style={bigText}>{c.headline}</div>
            {c.subline ? <div style={{ fontFamily: FONTS.body, fontSize: wide ? ts.body : ts.body, color: sub, marginTop: 28, maxWidth: wide ? 1000 : 880 }}>{c.subline}</div> : null}
          </div>
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 10, background: `linear-gradient(90deg, ${accent} 0%, transparent ${sweep * 100}%)` }} />
        </div>
      );
    }

    /* ---- Scenario / Story: cinematic left card ---- */
    case 'scenario_story': {
      return (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: wide ? 'flex-end' : 'center', padding: wide ? '0 96px 150px' : '300px 72px 620px' }}>
          <div style={{ maxWidth: wide ? 1500 : 920, ...riseIn(f, 4) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28, ...slideIn(f, 0, -1) }}>
              <div style={{ width: 8, height: wide ? 120 : 90, borderRadius: 4, background: accent }} />
              <div style={{ fontFamily: FONTS.body, fontSize: wide ? 28 : 38, letterSpacing: 4, color: accent, fontWeight: 700, textTransform: 'uppercase' }}>On a real project</div>
            </div>
            <div style={bigText}>{c.headline}</div>
            {c.subline ? <div style={{ fontFamily: FONTS.body, fontSize: wide ? ts.body : ts.body, color: sub, marginTop: 30, fontStyle: 'italic' }}>{c.subline}</div> : null}
          </div>
        </div>
      );
    }

    /* ---- Document Zoom: paper lifting out of the frame ---- */
    case 'document_zoom': {
      const z = interpolate(ease(f, 0, 26), [0, 1], [0.72, 1]);
      return (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: wide ? '0 96px' : '300px 72px 620px' }}>
          <div
            style={{
              position: 'absolute',
              inset: wide ? '120px 300px' : '160px 90px',
              background: '#FBFBF8F2',
              borderRadius: 10,
              boxShadow: '0 18px 40px rgba(0,0,0,0.55)',
              transform: `scale(${z})`,
              padding: wide ? 60 : 40,
            }}
          >
            <div style={{ height: 14, width: '40%', background: t.c.primary, borderRadius: 3, marginBottom: 26 }} />
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} style={{ height: 8, width: `${60 + ((i * 13) % 36)}%`, background: '#CBD5E0', borderRadius: 3, marginBottom: 14 }} />
            ))}
            <div style={{ position: 'absolute', right: 40, bottom: 40, width: 220, height: 90, border: `3px solid ${accent}`, borderRadius: 8 }} />
          </div>
          <div style={{ position: 'relative', ...riseIn(f, 16), maxWidth: wide ? 1200 : 880, textAlign: 'center' }}>
            <div style={{ fontFamily: FONTS.heading, fontWeight: 800, fontSize: wide ? ts.h1 : 86, color: '#0B1220', letterSpacing: -2, textShadow: '0 4px 14px rgba(0,0,0,0.7)' }}>{c.headline}</div>
          </div>
        </div>
      );
    }

    /* ---- Product Result Preview: device frame with result ---- */
    case 'product_result': {
      const lift = ease(f, 2, 20);
      return (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', flexDirection: wide ? 'row' : 'column', justifyContent: 'center', gap: wide ? 80 : 48, padding: wide ? '0 96px' : '160px 72px' }}>
          <div style={{ maxWidth: wide ? 860 : 900, order: wide ? 1 : 2, ...riseIn(f, 10) }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, padding: '10px 22px', borderRadius: 999, background: `${t.c.secondary}22`, border: `2px solid ${t.c.secondary}66`, color: t.c.secondary, fontFamily: FONTS.body, fontWeight: 800, fontSize: wide ? 24 : 32, letterSpacing: 2.4, marginBottom: 24 }}>
              THE RESULT
            </div>
            <div style={bigText}>{c.headline}</div>
            {c.subline ? <div style={{ fontFamily: FONTS.body, fontSize: wide ? ts.body : ts.body, color: sub, marginTop: 24 }}>{c.subline}</div> : null}
          </div>
          <div
            style={{
              order: wide ? 2 : 1,
              width: wide ? 640 : '100%',
              height: wide ? 380 : 560,
              borderRadius: 18,
              background: 'linear-gradient(180deg, #0E2138, #081420)',
              border: `2px solid ${t.c.secondary}55`,
              boxShadow: '0 16px 32px rgba(0,0,0,0.55)',
              transform: `translateY(${(1 - lift) * 60}px) scale(${0.92 + lift * 0.08})`,
              padding: wide ? 28 : 26,
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
            }}
          >
            <div style={{ height: 14, width: '55%', background: '#1E3A5F', borderRadius: 6 }} />
            <div style={{ flex: 1, display: 'flex', gap: 16 }}>
              <div style={{ flex: 1, borderRadius: 12, background: '#12253D', padding: 18 }}>
                <div style={{ height: 60, borderRadius: 10, background: `${accent}33` }} />
                <div style={{ height: 10, width: '70%', background: '#24446E', borderRadius: 5, marginTop: 16 }} />
              </div>
              <div style={{ flex: 1, borderRadius: 12, background: '#12253D', padding: 18 }}>
                <div style={{ height: 60, borderRadius: 10, background: `${t.c.secondary}33` }} />
                <div style={{ height: 10, width: '60%', background: '#24446E', borderRadius: 5, marginTop: 16 }} />
              </div>
            </div>
          </div>
        </div>
      );
    }

    default:
      return null;
  }
};

const Panel: React.FC<{ t: Theme; accent: string; label: string; value: string; f: number; delay: number; dark: boolean; wide: boolean; muted?: boolean }> = ({
  accent,
  label,
  value,
  f,
  delay,
  dark,
  wide,
  muted,
}) => (
  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 22, padding: wide ? 24 : 18, opacity: muted ? 0.55 : 1, ...scaleIn(f, delay, 0.9) }}>
    <div style={{ fontFamily: FONTS.body, fontWeight: 800, letterSpacing: 4, fontSize: wide ? 26 : 32, color: muted ? '#94A3B8' : accent, textTransform: 'uppercase' }}>{label}</div>
    <div style={{ fontFamily: FONTS.numeric, fontWeight: 800, fontSize: wide ? 150 : 96, lineHeight: 0.9, color: dark ? '#E6EDF6' : '#0B1220', letterSpacing: -5 }}>{value}</div>
  </div>
);

export { Hook };
export const _unused = { useVideoConfig };
