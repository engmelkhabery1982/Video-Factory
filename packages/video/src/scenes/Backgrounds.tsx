import React from 'react';
import type { BackgroundVariantId } from '@buildtrack/core';
import type { Theme } from '../brand/theme';

/**
 * Background variants (brief section 6).
 *
 * Each background is a self-contained surface. The one hard rule enforced by
 * the engine is the 15 second continuous cap, so every background here is
 * designed to be visually rich enough to hold for a full beat without the
 * viewer feeling the picture is frozen.
 */

export const Background: React.FC<{
  variant: BackgroundVariantId;
  t: Theme;
  accent: string;
  seed: number;
  mediaUrl?: string | null;
}> = ({ variant, t, accent, seed, mediaUrl }) => {
  switch (variant) {
    case 'dark_grid':
      return <DarkGrid t={t} accent={accent} seed={seed} />;
    case 'light_technical':
      return <LightTechnical t={t} accent={accent} seed={seed} />;
    case 'blueprint':
      return <Blueprint t={t} accent={accent} seed={seed} />;
    case 'full_typography':
      return <FullTypography t={t} accent={accent} seed={seed} />;
    case 'split_visual':
      return <SplitVisual t={t} accent={accent} seed={seed} />;
    case 'dashboard_ui':
      return <DashboardUI t={t} accent={accent} seed={seed} mediaUrl={mediaUrl} />;
    case 'document_closeup':
      return <DocumentCloseup t={t} accent={accent} seed={seed} mediaUrl={mediaUrl} />;
    case 'site_footage':
      return <SiteFootage t={t} accent={accent} seed={seed} mediaUrl={mediaUrl} />;
    default:
      return <DarkGrid t={t} accent={accent} seed={seed} />;
  }
};

/* deterministic pseudo-random so re-renders are identical */
const rnd = (seed: number, i: number) => {
  const x = Math.sin(seed * 9301 + i * 49297) * 43758.5453;
  return x - Math.floor(x);
};

const DarkGrid: React.FC<{ t: Theme; accent: string; seed: number }> = ({ t, accent, seed }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      background: `radial-gradient(120% 90% at 12% 0%, ${t.c.primary}33 0%, transparent 55%), linear-gradient(160deg, ${t.c.surfaceDark} 0%, #050C16 100%)`,
    }}
  >
    <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.5 }}>
      <defs>
        <pattern id={`grid-${seed}`} width="72" height="72" patternUnits="userSpaceOnUse">
          <path d="M72 0 L0 0 0 72" fill="none" stroke={t.c.secondary} strokeOpacity="0.16" strokeWidth="1.5" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#grid-${seed})`} />
    </svg>
    <div
      style={{
        position: 'absolute',
        width: 620,
        height: 620,
        borderRadius: '50%',
        right: -180,
        top: -220,
        background: `radial-gradient(circle, ${accent}22 0%, transparent 70%)`,
      }}
    />
  </div>
);

const LightTechnical: React.FC<{ t: Theme; accent: string; seed: number }> = ({ t, accent, seed }) => (
  <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(135deg, ${t.c.surfaceLight} 0%, #E4ECF6 100%)` }}>
    <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
      <defs>
        <pattern id={`tech-${seed}`} width="48" height="48" patternUnits="userSpaceOnUse">
          <path d="M48 0 L0 0 0 48" fill="none" stroke={t.c.primary} strokeOpacity="0.10" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#tech-${seed})`} />
      {Array.from({ length: 22 }).map((_, i) => {
        const y = 60 + i * 48;
        return <line key={i} x1="0" y1={y} x2={i % 4 === 0 ? 340 : 160} y2={y} stroke={t.c.primary} strokeOpacity="0.22" strokeWidth="2" />;
      })}
    </svg>
    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 12, background: accent }} />
  </div>
);

const Blueprint: React.FC<{ t: Theme; accent: string; seed: number }> = ({ t, accent, seed }) => (
  <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(140deg, #05264F 0%, ${t.c.primary} 60%, #0A2C6B 100%)` }}>
    <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.34 }}>
      <defs>
        <pattern id={`bp-${seed}`} width="96" height="96" patternUnits="userSpaceOnUse">
          <path d="M96 0 L0 0 0 96 M48 0 L48 96 M0 48 L96 48" fill="none" stroke="#BFE6FF" strokeOpacity="0.34" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#bp-${seed})`} />
    </svg>
    <div
      style={{
        position: 'absolute',
        inset: 40,
        border: `2px solid ${accent}88`,
        borderRadius: 10,
        opacity: 0.8,
      }}
    />
    <div
      style={{
        position: 'absolute',
        right: 64,
        bottom: 56,
        width: 300,
        height: 132,
        border: `2px solid #BFE6FF66`,
        background: '#041B3ACC',
        borderRadius: 8,
        padding: 14,
        color: '#BFE6FF',
        fontFamily: 'monospace',
        fontSize: 20,
        lineHeight: 1.5,
      }}
    >
      <div style={{ color: accent, fontWeight: 700 }}>DRAWING BT-{String(Math.floor(rnd(seed, 3) * 9000) + 1000)}</div>
      <div>SCALE 1:100</div>
      <div>REV C</div>
    </div>
  </div>
);

const FullTypography: React.FC<{ t: Theme; accent: string; seed: number }> = ({ t, accent, seed }) => (
  <div style={{ position: 'absolute', inset: 0, background: t.c.surfaceDark }}>
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: `radial-gradient(90% 70% at ${rnd(seed, 1) > 0.5 ? 78 : 22}% ${rnd(seed, 2) > 0.5 ? 26 : 74}%, ${accent}26 0%, transparent 62%)`,
      }}
    />
    <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.18 }}>
      {Array.from({ length: 16 }).map((_, i) => (
        <line key={i} x1="0" y1={i * 72} x2="100%" y2={i * 72} stroke={t.c.secondary} strokeWidth="1" />
      ))}
    </svg>
  </div>
);

const SplitVisual: React.FC<{ t: Theme; accent: string; seed: number }> = ({ t, accent, seed }) => {
  const flip = rnd(seed, 5) > 0.5;
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
      <div style={{ flex: 1, background: `linear-gradient(150deg, ${t.c.surfaceDark} 0%, #0C2036 100%)` }} />
      <div style={{ flex: 1, background: `linear-gradient(150deg, ${t.c.primary} 0%, ${t.c.secondary}44 100%)` }} />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: flip
            ? 'linear-gradient(90deg, transparent 46%, rgba(0,0,0,0.55) 50%, transparent 54%)'
            : 'linear-gradient(90deg, transparent 46%, rgba(0,0,0,0.55) 50%, transparent 54%)',
        }}
      />
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 10, background: accent }} />
    </div>
  );
};

const DashboardUI: React.FC<{ t: Theme; accent: string; seed: number; mediaUrl?: string | null }> = ({ t, accent, seed, mediaUrl }) => (
  <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(180deg, #0A1526 0%, ${t.c.surfaceDark} 100%)` }}>
    {mediaUrl ? (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `url(${mediaUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.35,
        }}
      />
    ) : null}
    {/* window chrome */}
    <div
      style={{
        position: 'absolute',
        left: 120,
        right: 120,
        top: 110,
        bottom: 110,
        borderRadius: 18,
        border: `2px solid ${t.c.secondary}55`,
        background: 'rgba(8,20,36,0.82)',
        boxShadow: '0 14px 30px rgba(0,0,0,0.5)',
        overflow: 'hidden',
      }}
    >
      <div style={{ height: 52, background: '#0E2138', display: 'flex', alignItems: 'center', padding: '0 20px', gap: 10 }}>
        {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => (
          <div key={c} style={{ width: 14, height: 14, borderRadius: '50%', background: c }} />
        ))}
        <div style={{ marginLeft: 18, height: 12, width: 260, borderRadius: 6, background: '#1B3352' }} />
      </div>
      <div style={{ display: 'flex', height: 'calc(100% - 52px)' }}>
        <div style={{ width: 210, background: '#0B1B2E', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{ height: 12, borderRadius: 6, background: i === 0 ? accent : '#1B3352', opacity: i === 0 ? 0.9 : 0.7 }} />
          ))}
        </div>
        <div style={{ flex: 1, padding: 26, display: 'flex', gap: 18 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ flex: 1, borderRadius: 12, background: '#0E2138', border: '1px solid #1E3A5F', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ height: 10, width: '55%', borderRadius: 5, background: '#24446E' }} />
              <div style={{ height: 52, borderRadius: 8, background: i === 1 ? `${accent}55` : '#152B48' }} />
              <div style={{ flex: 1, borderRadius: 8, background: '#12253D' }} />
            </div>
          ))}
        </div>
      </div>
    </div>
    {rnd(seed, 9) > 0.5 ? <div style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 60px rgba(0,0,0,0.45)' }} /> : null}
  </div>
);

const DocumentCloseup: React.FC<{ t: Theme; accent: string; seed: number; mediaUrl?: string | null }> = ({ t, accent, seed, mediaUrl }) => (
  <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(160deg, #14202E 0%, #0A121C 100%)` }}>
    <div
      style={{
        position: 'absolute',
        left: 260,
        right: 260,
        top: 80,
        bottom: 80,
        background: '#FBFBF8',
        borderRadius: 8,
        boxShadow: '0 16px 34px rgba(0,0,0,0.6)',
        padding: 46,
        overflow: 'hidden',
      }}
    >
      {mediaUrl ? (
        <div style={{ position: 'absolute', inset: 0, backgroundImage: `url(${mediaUrl})`, backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }} />
      ) : null}
      <div style={{ position: 'relative' }}>
        <div style={{ height: 16, width: '46%', background: t.c.primary, borderRadius: 3, marginBottom: 26 }} />
        {Array.from({ length: 9 }).map((_, i) => (
          <div
            key={i}
            style={{
              height: 9,
              width: `${52 + Math.floor(rnd(seed, i) * 44)}%`,
              background: '#C9D2DC',
              borderRadius: 3,
              marginBottom: 13,
            }}
          />
        ))}
      </div>
    </div>
    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 14, background: accent }} />
  </div>
);

/**
 * Generated "site" plate: a crane silhouette over a horizon, drawn in SVG.
 * Used whenever no B-roll has been uploaded, so a media-dependent scene still
 * looks deliberate instead of rendering as an empty box. No stock footage is
 * ever downloaded automatically (licence hygiene, brief section 12).
 */
export const SitePlate: React.FC<{ t: Theme; accent: string; seed: number }> = ({ t, accent, seed }) => (
  <svg width="100%" height="100%" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" style={{ position: 'absolute', inset: 0 }}>
    <defs>
      <linearGradient id={`sky-${seed}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#12304F" />
        <stop offset="62%" stopColor="#2C5A85" />
        <stop offset="100%" stopColor="#7FA6C4" />
      </linearGradient>
    </defs>
    <rect width="1920" height="1080" fill={`url(#sky-${seed})`} />
    <rect y="700" width="1920" height="380" fill="#2A3540" />
    <g fill="#1A232E">
      <rect x="120" y="470" width="220" height="230" />
      <rect x="360" y="560" width="160" height="140" />
      <rect x="1420" y="500" width="260" height="200" />
      <path d="M700 700 L700 240 L760 240 L760 700 Z" />
      <path d="M700 250 L1560 250 L1560 268 L700 268 Z" />
      <path d="M1500 268 L1540 268 L1540 640 L1500 640 Z" />
    </g>
    <rect y="696" width="1920" height="8" fill={accent} opacity="0.85" />
  </svg>
);

/** Generated document plate for document-annotation style scenes. */
export const DocumentPlate: React.FC<{ t: Theme; seed: number }> = ({ t, seed }) => (
  <div style={{ position: 'absolute', inset: 0, background: '#FBFBF8', borderRadius: 8, padding: 46, overflow: 'hidden' }}>
    <div style={{ height: 16, width: '46%', background: t.c.primary, borderRadius: 3, marginBottom: 26 }} />
    {Array.from({ length: 9 }).map((_, i) => (
      <div key={i} style={{ height: 9, width: `${52 + Math.floor(rnd(seed, i) * 44)}%`, background: '#C9D2DC', borderRadius: 3, marginBottom: 13 }} />
    ))}
  </div>
);

const SiteFootage: React.FC<{ t: Theme; accent: string; seed: number; mediaUrl?: string | null }> = ({ t, accent, seed, mediaUrl }) => (
  <div style={{ position: 'absolute', inset: 0, background: '#0B1219' }}>
    {mediaUrl ? (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `url(${mediaUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
    ) : (
      <SitePlate t={t} accent={accent} seed={seed} />
    )}
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: `linear-gradient(90deg, ${t.c.surfaceDark}E6 0%, ${t.c.surfaceDark}B0 45%, transparent 78%)`,
      }}
    />
  </div>
);
