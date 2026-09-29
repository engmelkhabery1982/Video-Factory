import React from 'react';
import type { Scene } from '@buildtrack/core';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { HOOK_VARIANTS, explanationById } from '@buildtrack/core';
import { Background } from './Backgrounds';
import { Chrome, Hook } from './Hooks';
import { Explanation } from './Explanations';
import { CtaCard } from './Cta';
import type { Theme } from '../brand/theme';

const HOOK_IDS = new Set(HOOK_VARIANTS.map((h) => h.id));

/**
 * A single scene: background -> content -> brand chrome.
 * The layout is driven purely by the storyboard, so changing a scene variant in
 * the UI changes the rendered frame with no code edit.
 */
export const SceneRenderer: React.FC<{
  scene: Scene;
  t: Theme;
  format: 'long' | 'short';
  ctaAnimation: Scene['transitionIn'] extends never ? never : 'slide_in' | 'typewriter' | 'counter_up' | 'scale_pop' | 'wipe_reveal';
  ctaText: string;
  productName: string;
  logoSrc?: string | null;
  mediaUrl?: string | null;
  /** 0..1 position inside the scene, used for the progress rail */
  progress?: number;
  /** px of camera drift, applied to the background plate only (perf) */
  parallax?: number;
  /** 0..1 scene reveal */
  reveal?: number;
}> = ({ scene, t, format, ctaAnimation, ctaText, productName, logoSrc, mediaUrl, progress = 0, parallax = 0, reveal = 1 }) => {
  const dark = scene.background !== 'light_technical';

  return (
    <div style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'hidden', background: t.c.surfaceDark }}>
      <div
        style={{
          position: 'absolute',
          inset: -48,
          transform: `translate3d(${parallax}px, 0, 0) scale(${(1.004 + (1 - reveal) * 0.02).toFixed(4)})`,
          willChange: 'transform',
        }}
      >
        <Background variant={scene.background} t={t} accent={scene.accent} seed={scene.index + 1} mediaUrl={mediaUrl} />
      </div>

      {scene.variant === 'cta_card' ? (
        <CtaCard
          scene={scene}
          t={t}
          accent={scene.accent}
          format={format}
          animation={ctaAnimation}
          productName={productName}
          ctaText={ctaText}
          logoSrc={logoSrc}
        />
      ) : HOOK_IDS.has(scene.variant as never) ? (
        <Hook scene={scene} t={t} accent={scene.accent} format={format} />
      ) : (
        <Explanation scene={scene} t={t} accent={scene.accent} format={format} mediaUrl={mediaUrl} />
      )}

      <Chrome
        t={t}
        accent={scene.accent}
        section={scene.role === 'body' ? scene.section : undefined}
        dark={dark}
        format={format}
        progress={progress}
        logoSrc={logoSrc}
        endScreenClear={format === 'long' && scene.role === 'cta'}
      />
    </div>
  );
};

export const isHookScene = (s: Scene) => HOOK_IDS.has(s.variant as never);
export const variantLabel = (s: Scene) =>
  HOOK_IDS.has(s.variant as never)
    ? HOOK_VARIANTS.find((h) => h.id === s.variant)?.label ?? String(s.variant)
    : s.variant === 'cta_card'
      ? 'CTA card'
      : (safeLabel(s.variant) ?? String(s.variant));

const safeLabel = (id: string) => {
  try {
    return explanationById(id as never).label;
  } catch {
    return undefined;
  }
};

/** Used by the preview player to show a thin scene-boundary ruler. */
export const SceneRuler: React.FC<{ scenes: Scene[]; format: 'long' | 'short' }> = ({ scenes, format }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  void durationInFrames;
  void format;
  const t = frame;
  void t;
  return <div style={{ display: 'none' }} />;
};
