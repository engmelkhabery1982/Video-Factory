import React from 'react';
import type { ExplanationVariantId, Scene } from '@buildtrack/core';
import { interpolate, useCurrentFrame } from 'remotion';
import { FONTS, typeScale, type Theme } from '../brand/theme';
import { ease, riseIn, scaleIn, slideIn } from './Hooks';
import { SitePlate } from './Backgrounds';

/**
 * Fit a line of copy to a word budget WITHOUT cutting a thought in half.
 * If a clause boundary (comma, colon, dash, conjunction) falls inside the
 * budget we cut there; otherwise we keep the whole short sentence and let the
 * type scale handle it. This is the main defence against "clipped titles",
 * one of the reference-video failures we must not repeat.
 */
const clip = (text: string, n: number) => {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) return words.join(' ');
  const head = words.slice(0, n).join(' ');
  const boundary = Math.max(
    head.lastIndexOf(', '), head.lastIndexOf(': '), head.lastIndexOf(' - '),
    head.lastIndexOf('; '), head.lastIndexOf(' and '), head.lastIndexOf(' but '),
    head.lastIndexOf(' so '), head.lastIndexOf(' to '),
  );
  if (boundary > head.length * 0.35) return head.slice(0, boundary).trim();
  return words.slice(0, n).join(' ').replace(/[,;:\-]+$/, '');
};

/** Shrink the type size rather than truncate, once the copy is genuinely long. */
/** Upper-cases a label for use as a small caps side heading. */
const titleish = (s: string) => String(s).trim().replace(/\s+/g, ' ');

const fitSize = (text: string, base: number, min = base * 0.62) => {
  const len = text.length;
  if (len <= 34) return base;
  if (len <= 48) return base * 0.88;
  if (len <= 64) return base * 0.78;
  if (len <= 84) return base * 0.68;
  return min;
};

const Explanation: React.FC<{ scene: Scene; t: Theme; accent: string; format: 'long' | 'short'; mediaUrl?: string | null }> = ({
  scene,
  t,
  accent,
  format,
  mediaUrl,
}) => {
  const f = useCurrentFrame();
  const ts = typeScale(format);
  const dark = scene.background !== 'light_technical';
  const fg = dark ? t.c.textOnDark : t.c.textOnLight;
  const sub = dark ? '#9FB6CF' : '#4A5B70';
  const c = scene.content;
  const wide = format === 'long';
  const items = c.items.length ? c.items : [c.headline];

  const pad = wide ? 96 : 72;
  const Frame: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        // the brand rail sits at the very top and the logo at the very bottom,
        // so the safe band is symmetric and the block is optically centred -
        // a top-anchored block leaves half the frame dead
        padding: `${wide ? 130 : 190}px ${pad}px ${wide ? 150 : 300}px`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        ...style,
      }}
    >
      {children}
    </div>
  );

  const H: React.FC<{ children: React.ReactNode; size?: number }> = ({ children, size }) => {
    const txt = String(children);
    return (
      <div
        style={{
          fontFamily: FONTS.heading,
          fontWeight: 800,
          fontSize: fitSize(txt, size ?? (wide ? ts.h2 : 66), wide ? 44 : 40),
          lineHeight: 1.06,
          letterSpacing: wide ? -1.8 : -1.2,
          color: fg,
          maxWidth: '100%',
          textWrap: 'balance',
          overflowWrap: 'break-word',
          ...riseIn(f, 2),
        }}
      >
        {children}
      </div>
    );
  };

  const body: React.ReactNode = (() => {
    switch (scene.variant as ExplanationVariantId) {
      /* ---- Animated Checklist ---- */
      case 'animated_checklist':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 22 : 26, marginTop: wide ? 40 : 34, flex: wide ? undefined : 1, justifyContent: 'center' }}>
            {items.slice(0, wide ? 5 : 3).map((it, i) => {
              const p = ease(f, 10 + i * 7, 22 + i * 7);
              const tick = ease(f, 14 + i * 7, 24 + i * 7);
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: wide ? 24 : 26, opacity: p, transform: `translateX(${(1 - p) * -50}px)` }}>
                  <div
                    style={{
                      flex: '0 0 auto',
                      width: wide ? 54 : 66,
                      height: wide ? 54 : 66,
                      borderRadius: 14,
                      background: `${accent}${tick > 0.5 ? 'EE' : '22'}`,
                      border: `2px solid ${accent}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: tick > 0.5 ? '#0B1220' : accent,
                      fontSize: wide ? 32 : 40,
                      fontWeight: 900,
                      transform: `scale(${0.7 + tick * 0.3})`,
                    }}
                  >
                    {tick > 0.5 ? '✓' : String(i + 1)}
                  </div>
                  <div style={{ fontFamily: FONTS.body, fontSize: wide ? ts.body : 44, fontWeight: 600, color: fg, lineHeight: 1.28, paddingTop: wide ? 8 : 6 }}>{clip(it, wide ? 16 : 11)}</div>
                </div>
              );
            })}
          </div>
        );

      /* ---- Number Comparison ---- */
      case 'number_comparison': {
        const a = c.stat ?? '0%';
        const b = c.stat2 ?? '0%';
        const pa = parseFloat(String(a)) || 0;
        const pb = parseFloat(String(b)) || 0;
        const max = Math.max(pa, pb, 1);
        const wa = ease(f, 6, 30);
        const wb = ease(f, 14, 38);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 30 : 30, marginTop: wide ? 34 : 28 }}>
            {[
              { v: a, w: wa, tone: accent, name: 'EXECUTED' },
              { v: b, w: wb, tone: t.c.secondary, name: 'ACCEPTED' },
            ].map((row, i) => (
              <div key={i} style={{ ...riseIn(f, 4 + i * 8) }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 20, marginBottom: 12 }}>
                  <span style={{ fontFamily: FONTS.numeric, fontWeight: 800, fontSize: wide ? 112 : 118, color: row.tone, letterSpacing: -4, lineHeight: 1 }}>{row.v}</span>
                  <span style={{ fontFamily: FONTS.body, fontSize: wide ? 24 : 30, letterSpacing: 3, color: sub, fontWeight: 700, textTransform: 'uppercase' }}>{row.name}</span>
                </div>
                <div style={{ height: wide ? 34 : 40, borderRadius: 999, background: dark ? '#FFFFFF12' : '#0B122014', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(Math.max(0, parseFloat(String(row.v)) || 0) / max) * 100 * row.w}%`, background: `linear-gradient(90deg, ${row.tone}AA, ${row.tone})`, borderRadius: 999 }} />
                </div>
              </div>
            ))}
            <div style={{ ...riseIn(f, 40), marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 14, alignSelf: wide ? 'flex-start' : 'center', padding: '12px 24px', borderRadius: 12, background: '#E5484D1E', border: `2px solid #E5484D88` }}>
              <span style={{ fontFamily: FONTS.numeric, fontSize: wide ? 44 : 54, fontWeight: 800, color: '#FF7A7E' }}>{Math.abs(pa - pb).toFixed(1)}%</span>
              <span style={{ fontFamily: FONTS.body, fontSize: wide ? 26 : 32, fontWeight: 700, color: '#FFB0B3', letterSpacing: 2 }}>THE GAP</span>
            </div>
          </div>
        );
      }

      /* ---- Progressive Table Reveal: only the row in focus ---- */
      case 'progressive_table':
        return (
          <div style={{ marginTop: wide ? 30 : 26, borderRadius: 14, overflow: 'hidden', border: `2px solid ${dark ? '#FFFFFF1E' : '#0B122014'}`, maxWidth: wide ? 1400 : 940 }}>
            <div style={{ display: 'flex', background: dark ? '#12253D' : '#0B3D91', padding: `${wide ? 18 : 22}px ${wide ? 26 : 24}px`, gap: wide ? 24 : 18 }}>
              {['ITEM', 'VALUE', 'STATUS'].map((h) => (
                <div key={h} style={{ flex: h === 'ITEM' ? 2 : 1, fontFamily: FONTS.body, fontSize: wide ? 22 : 28, letterSpacing: 3, color: '#DCE9F8', fontWeight: 800 }}>{h}</div>
              ))}
            </div>
            {items.slice(0, 4).map((it, i) => {
              const p = ease(f, 8 + i * 9, 20 + i * 9);
              const focus = i === Math.min(1, items.length - 1);
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    padding: `${wide ? 18 : 22}px ${wide ? 26 : 24}px`,
                    gap: wide ? 24 : 18,
                    opacity: p * (focus ? 1 : 0.32),
                    background: focus ? `${accent}1F` : dark ? '#0B1B2E' : '#FFFFFF',
                    borderTop: `1px solid ${dark ? '#FFFFFF12' : '#0B122010'}`,
                    borderLeft: focus ? `5px solid ${accent}` : '5px solid transparent',
                  }}
                >
                  <div style={{ flex: 2, fontFamily: FONTS.body, fontSize: wide ? 28 : 34, color: fg, fontWeight: 600, fontFamily: FONTS.body }}>{clip(it, wide ? 5 : 4)}</div>
                  <div style={{ flex: 1, fontFamily: FONTS.numeric, fontSize: wide ? 30 : 36, color: focus ? accent : sub, fontWeight: 700 }}>{c.stat ?? '—'}</div>
                  <div style={{ flex: 1, fontFamily: FONTS.body, fontSize: wide ? 24 : 30, color: focus ? accent : sub, fontWeight: 700, textTransform: 'uppercase' }}>{focus ? 'in focus' : '—'}</div>
                </div>
              );
            })}
          </div>
        );

      /* ---- Timeline ---- */
      case 'timeline': {
        const steps = items.length >= 3 ? items.slice(0, wide ? 5 : 4) : [...items, ...items];
        return (
          <div style={{ marginTop: wide ? 48 : 40, position: 'relative', paddingLeft: wide ? 40 : 20, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ position: 'absolute', left: wide ? 27 : 13, top: 10, bottom: 10, width: 4, background: `${accent}44` }} />
            {steps.map((s, i) => {
              const p = ease(f, 6 + i * 8, 18 + i * 8);
              const done = ease(f, 12 + i * 8, 26 + i * 8);
              return (
                <div key={i} style={{ display: 'flex', gap: wide ? 30 : 22, alignItems: 'flex-start', marginBottom: wide ? 26 : 24, opacity: p }}>
                  <div
                    style={{
                      position: 'relative',
                      flex: '0 0 auto',
                      width: wide ? 58 : 60,
                      height: wide ? 58 : 60,
                      borderRadius: '50%',
                      background: done > 0.5 ? accent : dark ? '#0F2236' : '#FFFFFF',
                      border: `3px solid ${accent}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: FONTS.numeric,
                      fontWeight: 800,
                      fontSize: wide ? 24 : 28,
                      color: done > 0.5 ? '#0B1220' : accent,
                      transform: `scale(${0.75 + done * 0.25})`,
                    }}
                  >
                    {i + 1}
                  </div>
                  <div style={{ fontFamily: FONTS.body, fontSize: wide ? ts.body : 40, color: fg, fontWeight: 600, lineHeight: 1.25, paddingTop: wide ? 10 : 8, flex: 1 }}>{clip(s, wide ? 12 : 9)}</div>
                </div>
              );
            })}
          </div>
        );
      }

      /* ---- Process Flow ---- */
      case 'process_flow': {
        const nodes = items.slice(0, wide ? 5 : 4);
        return (
          <div style={{ marginTop: wide ? 56 : 44, display: 'flex', flexDirection: wide ? 'row' : 'column', alignItems: 'stretch', gap: wide ? 18 : 16 }}>
            {nodes.map((s, i) => {
              const p = ease(f, 6 + i * 8, 20 + i * 8);
              return (
                <React.Fragment key={i}>
                  <div
                    style={{
                      flex: 1,
                      borderRadius: 14,
                      padding: wide ? '24px 20px' : '20px 22px',
                      background: dark ? 'rgba(18,37,61,0.92)' : 'rgba(255,255,255,0.94)',
                      border: `2px solid ${accent}66`,
                      opacity: p,
                      transform: `translateY(${(1 - p) * 30}px)`,
                      minHeight: wide ? 190 : 150,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    <div style={{ fontFamily: FONTS.numeric, fontSize: wide ? 24 : 30, color: accent, fontWeight: 800, letterSpacing: 2 }}>STEP {i + 1}</div>
                    <div style={{ fontFamily: FONTS.body, fontSize: wide ? 26 : 34, color: fg, fontWeight: 600, lineHeight: 1.24, flex: 1 }}>{clip(s, wide ? 5 : 7)}</div>
                    <div style={{ height: 5, borderRadius: 3, background: `${accent}33`, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${p * 100}%`, background: accent }} />
                    </div>
                  </div>
                  {wide && i < nodes.length - 1 ? (
                    <div style={{ flex: '0 0 34px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: accent, fontSize: 34, opacity: ease(f, 12 + i * 8, 20 + i * 8) }}>→</div>
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        );
      }

      /* ---- Document Annotation ---- */
      case 'document_annotation':
        return (
          <div style={{ marginTop: wide ? 26 : 20, position: 'relative', flex: 1, minHeight: 0 }}>
            <div style={{ position: 'absolute', inset: wide ? '0 120px 0 0' : 0, background: dark ? 'rgba(251,251,248,0.94)' : '#FFFFFF', borderRadius: 10, padding: wide ? 40 : 28, boxShadow: '0 12px 26px rgba(0,0,0,0.35)' }}>
              <div style={{ height: 12, width: '40%', background: t.c.primary, borderRadius: 3, marginBottom: 20 }} />
              {Array.from({ length: wide ? 7 : 5 }).map((_, i) => {
                const p = ease(f, 6 + i * 5, 16 + i * 5);
                return <div key={i} style={{ height: 7, width: `${52 + ((i * 17) % 42)}%`, background: '#C2CDDA', borderRadius: 3, marginBottom: 12, opacity: p }} />;
              })}
              <div
                style={{
                  position: 'absolute',
                  left: wide ? '52%' : '12%',
                  top: wide ? '54%' : '46%',
                  width: wide ? '38%' : '72%',
                  height: wide ? 96 : 80,
                  border: `4px solid ${accent}`,
                  borderRadius: 8,
                  opacity: ease(f, 24, 34),
                }}
              />
            </div>
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: wide ? '38%' : '30%',
                width: wide ? 330 : '86%',
                alignSelf: 'flex-end',
                padding: wide ? '18px 22px' : '16px 20px',
                borderRadius: 12,
                background: accent,
                color: '#0B1220',
                fontFamily: FONTS.body,
                fontWeight: 700,
                fontSize: wide ? 24 : 30,
                lineHeight: 1.2,
                ...slideIn(f, 26, 1),
                boxShadow: '0 10px 22px rgba(0,0,0,0.35)',
              }}
            >
              {clip(items[0] ?? c.subline ?? 'flagged on the document', wide ? 8 : 12)}
            </div>
          </div>
        );

      /* ---- Site Footage with Callouts ---- */
      case 'site_footage_callouts': {
        const marks = items.slice(0, 4);
        return (
          <div style={{ marginTop: wide ? 26 : 20, flex: 1, position: 'relative', minHeight: 0 }}>
            {mediaUrl ? (
              <div style={{ position: 'absolute', inset: 0, backgroundImage: `url(${mediaUrl})`, backgroundSize: 'cover', borderRadius: 12, opacity: 0.9 }} />
            ) : (
              <div style={{ position: 'absolute', inset: 0, borderRadius: 12, overflow: 'hidden' }}>
                <SitePlate t={t} accent={accent} seed={scene.index + 3} />
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(8,18,32,0.45)' }} />
              </div>
            )}
            {marks.map((m, i) => {
              const p = ease(f, 8 + i * 8, 20 + i * 8);
              const top = 14 + (i * 78) % 66;
              const left = i % 2 === 0 ? 8 : 52;
              return (
                <React.Fragment key={i}>
                  <div
                    style={{
                      position: 'absolute',
                      left: `${left}%`,
                      top: `${top}%`,
                      width: wide ? 26 : 30,
                      height: wide ? 26 : 30,
                      borderRadius: '50%',
                      background: accent,
                      boxShadow: `0 0 0 ${6 * (1 - p)}px ${accent}44`,
                      transform: `scale(${p})`,
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      left: `calc(${left}% + ${wide ? 40 : 42}px)`,
                      top: `calc(${top}% - ${wide ? 6 : 6}px)`,
                      padding: wide ? '10px 18px' : '12px 18px',
                      borderRadius: 10,
                      background: 'rgba(8,18,32,0.92)',
                      border: `2px solid ${accent}88`,
                      color: '#F4F8FF',
                      fontFamily: FONTS.body,
                      fontWeight: 700,
                      fontSize: wide ? 24 : 30,
                      maxWidth: wide ? 460 : 420,
                      opacity: p,
                    }}
                  >
                    {clip(m, wide ? 5 : 7)}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        );
      }

      /* ---- Split Screen ---- */
      case 'split_screen': {
        // A split screen only works if the two sides genuinely contrast, and if
        // the side labels mean something. Falling back to "LEFT"/"RIGHT" and
        // repeating the headline on both sides is the classic template tell.
        const sideLabel = (i: number) => {
          const explicit = i === 0 ? c.statLabel : c.statLabel2;
          if (explicit && explicit.trim()) return titleish(explicit);
          if (i === 0 && c.stat) return `${c.stat} reported`;
          if (i === 1 && c.stat2) return `${c.stat2} verified`;
          return i === 0 ? 'The reported number' : 'The real number';
        };
        const sideText = (i: number) => {
          const withStat = i === 0 ? c.stat : c.stat2;
          const it = items[i];
          if (withStat && (i === 0 ? c.statLabel : c.statLabel2)) return `${withStat} - ${i === 0 ? c.statLabel : c.statLabel2}`;
          return it ?? items[0] ?? c.headline;
        };
        const left = sideText(0);
        const right = sideText(1);
        const isSplit = String(c.stat ?? '').includes('/') || /\d/.test(left) !== /\d/.test(right);
        return (
          <div style={{ marginTop: wide ? 30 : 24, display: 'flex', flexDirection: wide ? 'row' : 'column', gap: wide ? 26 : 20, justifyContent: 'center' }}>
            {[left, right].map((txt, i) => {
              const p = ease(f, 6 + i * 10, 22 + i * 10);
              const tone = i === 0 ? t.c.secondary : accent;
              return (
                <div
                  key={i}
                  style={{
                    // size to the copy instead of stretching: an empty card is
                    // worse than a tight one
                    flex: wide ? '1 1 0' : undefined,
                    display: 'flex',
                    gap: wide ? 26 : 20,
                    padding: wide ? '34px 36px' : '26px 24px',
                    borderRadius: 16,
                    background: dark ? 'rgba(12,27,46,0.92)' : 'rgba(255,255,255,0.96)',
                    border: `2px solid ${tone}55`,
                    boxShadow: '0 12px 26px rgba(0,0,0,0.28)',
                    minHeight: 0,
                    opacity: p,
                    transform: `translateX(${(1 - p) * (i === 0 ? -60 : 60)}px)`,
                  }}
                >
                  <div style={{ flex: '0 0 auto', width: wide ? 10 : 12, alignSelf: 'stretch', borderRadius: 6, background: tone }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: FONTS.body, fontSize: wide ? 28 : 30, letterSpacing: 3, color: tone, fontWeight: 800, textTransform: 'uppercase', marginBottom: 16 }}>
                      {sideLabel(i)}
                    </div>
                    <div style={{ fontFamily: FONTS.heading, fontSize: fitSize(txt, wide ? 76 : 62, wide ? 46 : 38), color: fg, fontWeight: 800, lineHeight: 1.1 }}>
                      {clip(txt, wide ? 8 : 6)}
                    </div>
                  </div>
                </div>
              );
            })}
            {isSplit && wide ? (
              <div style={{ position: 'absolute', right: 96, top: 96, fontFamily: FONTS.body, fontSize: 24, letterSpacing: 3, fontWeight: 800, color: sub, textTransform: 'uppercase' }}>
                side by side
              </div>
            ) : null}
          </div>
        );
      }

      /* ---- Dashboard Demo ---- */
      case 'dashboard_demo':
        return (
          <div style={{ marginTop: wide ? 30 : 24, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: wide ? 18 : 16 }}>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                borderRadius: 14,
                background: 'rgba(8,20,36,0.94)',
                border: `2px solid ${t.c.secondary}44`,
                padding: wide ? 26 : 20,
                display: 'flex',
                flexDirection: 'column',
                gap: wide ? 16 : 14,
              }}
            >
              <div style={{ display: 'flex', gap: wide ? 16 : 12 }}>
                {[0, 1, 2].map((i) => {
                  const p = ease(f, 6 + i * 6, 18 + i * 6);
                  return (
                    <div key={i} style={{ flex: 1, borderRadius: 10, background: '#0F2439', padding: wide ? 18 : 14, opacity: p, border: `1px solid ${i === 0 ? `${accent}88` : '#1E3A5F'}` }}>
                      <div style={{ height: 9, width: '60%', background: '#27456D', borderRadius: 5, marginBottom: 12 }} />
                      <div style={{ fontFamily: FONTS.numeric, fontSize: wide ? 42 : 46, fontWeight: 800, color: i === 0 ? accent : '#7FA0C8' }}>{[c.stat, c.stat2, '24%'][i] ?? '—'}</div>
                    </div>
                  );
                })}
              </div>
              <div style={{ flex: 1, minHeight: 0, borderRadius: 10, background: '#0C1E31', position: 'relative', overflow: 'hidden' }}>
                <svg width="100%" height="100%" viewBox="0 0 400 120" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0 }}>
                  <polyline
                    points={Array.from({ length: 12 })
                      .map((_, i) => {
                        const x = (i / 11) * 400;
                        const p = ease(f, 10 + i * 3, 20 + i * 3);
                        const y = 110 - (i / 11) * 92 * p;
                        return `${x.toFixed(1)},${y.toFixed(1)}`;
                      })
                      .join(' ')}
                    fill="none"
                    stroke={accent}
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            </div>
            <div style={{ ...riseIn(f, 34), fontFamily: FONTS.body, fontSize: wide ? 26 : 32, color: sub, maxWidth: '100%', lineHeight: 1.3 }}>
              {clip(c.takeaway ?? c.subline ?? items[0] ?? '', wide ? 18 : 12)}
            </div>
          </div>
        );

      /* ---- Chart Animation ---- */
      case 'chart_animation': {
        const bars = (items.length >= 3 ? items : [...items, ...items, ...items]).slice(0, wide ? 5 : 4);
        const values = bars.map((_, i) => 30 + ((i * 37) % 60));
        return (
          <div style={{ marginTop: wide ? 34 : 26, flex: 1, display: 'flex', alignItems: 'flex-end', gap: wide ? 26 : 18, minHeight: 0 }}>
            {values.map((v, i) => {
              const p = ease(f, 8 + i * 7, 28 + i * 7);
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, height: '100%', justifyContent: 'flex-end' }}>
                  <div style={{ fontFamily: FONTS.numeric, fontSize: wide ? 28 : 32, color: i === values.length - 1 ? accent : sub, fontWeight: 700, opacity: ease(f, 20 + i * 7, 30 + i * 7) }}>
                    {i === values.length - 1 ? (c.stat ?? '100%') : `${v}%`}
                  </div>
                  <div
                    style={{
                      width: '100%',
                      height: `${(v / 100) * p * 100}%`,
                      borderRadius: '10px 10px 0 0',
                      background: i === values.length - 1 ? `linear-gradient(180deg, ${accent}, ${accent}66)` : dark ? 'linear-gradient(180deg, #2A4A72, #16304D)' : 'linear-gradient(180deg, #B9CCE2, #94B0CC)',
                    }}
                  />
                  <div style={{ fontFamily: FONTS.body, fontSize: wide ? 20 : 26, color: sub, textAlign: 'center', fontWeight: 600, lineHeight: 1.15 }}>{clip(bars[i], wide ? 2 : 3)}</div>
                </div>
              );
            })}
          </div>
        );
      }

      /* ---- Myth vs Reality ---- */
      case 'myth_vs_reality':
        return (
          <div style={{ marginTop: wide ? 34 : 26, display: 'flex', flexDirection: 'column', gap: wide ? 22 : 18, flex: wide ? undefined : 1, justifyContent: 'center' }}>
            {[
              { tag: 'MYTH', tone: '#E5484D', text: items[0] ?? c.headline },
              { tag: 'REALITY', tone: t.c.secondary, text: items[1] || c.subline || c.takeaway || items[0] || '' },
            ].map((row, i) => {
              const p = ease(f, 6 + i * 12, 24 + i * 12);
              return (
                <div
                  key={i}
                  style={{
                    padding: wide ? '26px 32px' : '22px 24px',
                    borderRadius: 16,
                    background: dark ? 'rgba(8,18,32,0.9)' : 'rgba(255,255,255,0.95)',
                    borderLeft: `8px solid ${row.tone}`,
                    // shorts: fill the vertical frame, but never stretch into an
                    // empty box - cap the card so the copy stays the hero
                    flex: wide ? undefined : 1,
                    maxHeight: wide ? undefined : 430,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    opacity: p,
                    transform: `scale(${0.94 + p * 0.06})`,
                    boxShadow: '0 10px 22px rgba(0,0,0,0.3)',
                  }}
                >
                  <div style={{ fontFamily: FONTS.body, fontSize: wide ? 24 : 32, letterSpacing: 4, fontWeight: 800, color: row.tone, marginBottom: 14 }}>{row.tag}</div>
                  <div style={{ fontFamily: FONTS.body, fontSize: wide ? ts.body : 46, color: fg, fontWeight: 600, lineHeight: 1.22 }}>{clip(row.text, wide ? 13 : 12)}</div>
                </div>
              );
            })}
          </div>
        );

      /* ---- Problem -> Cause -> Solution ---- */
      case 'problem_cause_solution': {
        const blocks = [
          { tag: 'PROBLEM', tone: '#E5484D', text: items[0] ?? c.headline },
          { tag: 'CAUSE', tone: accent, text: items[1] ?? items[0] ?? c.subline ?? '' },
          { tag: 'SOLUTION', tone: t.c.secondary, text: items[2] ?? items[0] ?? c.takeaway ?? '' },
        ];
        return (
          <div style={{ marginTop: wide ? 34 : 26, display: 'flex', flexDirection: wide ? 'row' : 'column', gap: wide ? 20 : 16, justifyContent: 'center' }}>
            {blocks.map((b, i) => {
              const p = ease(f, 6 + i * 10, 22 + i * 10);
              return (
                <React.Fragment key={i}>
                  <div
                    style={{
                      flex: 1,
                      borderRadius: 16,
                      padding: wide ? '26px 26px' : '20px 22px',
                      background: dark ? 'rgba(14,31,52,0.94)' : 'rgba(255,255,255,0.96)',
                      border: `2px solid ${b.tone}55`,
                      opacity: p,
                      transform: `translateY(${(1 - p) * 40}px)`,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 14,
                      // the three cards share the frame: stretching them full
                      // height leaves each one mostly empty
                      justifyContent: 'center',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 34, height: 6, borderRadius: 3, background: b.tone }} />
                      <div style={{ fontFamily: FONTS.body, fontSize: wide ? 24 : 30, letterSpacing: 3, fontWeight: 800, color: b.tone }}>{b.tag}</div>
                    </div>
                    <div style={{ fontFamily: FONTS.body, fontSize: fitSize(b.text, wide ? 40 : 44, wide ? 26 : 28), color: fg, fontWeight: 600, lineHeight: 1.22 }}>
                      {clip(b.text, wide ? 8 : 7)}
                    </div>
                  </div>
                  {wide && i < blocks.length - 1 ? (
                    <div style={{ flex: '0 0 36px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40, color: accent, opacity: ease(f, 14 + i * 10, 24 + i * 10) }}>→</div>
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        );
      }

      default:
        return null;
    }
  })();

  // On a two-sided layout the cards already carry the message; printing the
  // headline a third time above them is redundant and reads as a template.
  const twoSided = scene.variant === 'split_screen' || scene.variant === 'myth_vs_reality' || scene.variant === 'before_after';
  const bodyCarries = twoSided && c.items.length > 0;

  // The sub line is derived from the same sentence as the headline, so it
  // often just restates it. Show it only when it genuinely adds something.
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9%\.]+/g, '').trim();
  const subAdds = !!c.subline && !bodyCarries && !flat(c.subline!).startsWith(flat(c.headline)) && flat(c.subline!) !== flat(c.headline);
  return (
    <Frame>
      {!bodyCarries ? <H>{clip(c.headline, wide ? 16 : 9)}</H> : null}
      {subAdds ? (
        <div style={{ fontFamily: FONTS.body, fontSize: wide ? 30 : 40, color: sub, marginTop: 16, fontWeight: 500, maxWidth: '92%' }}>
          {clip(c.subline, wide ? 22 : 12)}
        </div>
      ) : null}
      {body}
    </Frame>
  );
};

export { Explanation, clip };
export const _easeUnused = ease;
export const _interp = interpolate;
export const _scale = scaleIn;
