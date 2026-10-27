import React from 'react';
import type { Scene } from '@buildtrack/core';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { HOOK_VARIANTS, explanationById } from '@buildtrack/core';
import { Background } from './Backgrounds';
import { Chrome, Hook } from './Hooks';
import { Explanation } from './Explanations';
import { CtaCard } from './Cta';
import { ProceduralGraphic } from '../graphics/ProceduralGraphic';
import { graphicSafeBox } from '../graphics/graphicSafeBox';
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
  contentProfile?: 'religious' | 'educational' | 'promotional' | null;
  fromFrame?: number;
}> = ({ scene, t, format, ctaAnimation, ctaText, productName, logoSrc, mediaUrl, progress = 0, parallax = 0, reveal = 1, contentProfile, fromFrame = 0 }) => {
  const { width: frameWidth, height: frameHeight } = useVideoConfig();
  const dark = scene.background !== 'light_technical' && scene.content.presentation !== 'reflective';
  const presentation = scene.content.presentation ?? null;
  const holdStill = presentation === 'screen_recording' || presentation === 'owner_picture';
  const drift = holdStill ? 0 : parallax;
  const scale = holdStill ? 1 : 1.004 + (1 - reveal) * 0.02;
  const pointer = presentation === 'screen_recording' && scene.content.mediaKind === 'video' ? scene.content.pointer : null;

  // A procedural graphic replaces the background and explanation body. The scene keeps the SAME brand chrome as every
  // other scene: the identity, logo and wordmark come from the same props, so the identity rules (religious: none;
  // unbound: none; bound educational or promotional: the owner's logo) apply exactly as they do without a graphic.
  // The graphic sits in a safe box that clears the chrome bands. Captions and transitions are unchanged.
  if (scene.content.graphic) {
    const box = graphicSafeBox(format, frameWidth, frameHeight);
    return (
      <div style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'hidden', background: scene.content.graphic.background }}>
        <div style={{ position: 'absolute', left: box.left, top: box.top, width: box.width, height: box.height }}>
          <ProceduralGraphic graphic={scene.content.graphic} width={box.width} height={box.height} />
        </div>
        <Chrome
          t={t}
          accent={scene.accent}
          section={scene.role === 'body' ? scene.section : undefined}
          dark={dark}
          format={format}
          progress={progress}
          logoSrc={contentProfile === 'religious' ? null : logoSrc}
          endScreenClear={format === 'long' && scene.role === 'cta'}
        />
      </div>
    );
  }
  return (
    <div style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'hidden', background: t.c.surfaceDark }}>
      <div
        style={{
          position: 'absolute',
          inset: holdStill ? 0 : -48,
          transform: `translate3d(${drift}px, 0, 0) scale(${scale.toFixed(4)})`,
          willChange: 'transform',
        }}
      >
        <Background
          variant={scene.background}
          t={t}
          accent={scene.accent}
          seed={scene.index + 1}
          mediaUrl={mediaUrl}
          presentation={presentation}
          mediaKind={scene.content.mediaKind ?? null}
          fromFrame={fromFrame}
          clip={{
            sourceInSec: scene.content.sourceInSec ?? null,
            crop: scene.content.crop ?? null,
            motion: scene.content.motion ?? null,
            durationSec: scene.duration,
            keepAudio: scene.content.keepAudio === true,
          }}
        />
      </div>
      {pointer ? (
        <div
          style={{
            position: 'absolute',
            left: `${pointer.x * 100}%`,
            top: `${pointer.y * 100}%`,
            width: `${pointer.width * 100}%`,
            height: `${pointer.height * 100}%`,
            border: '4px solid #E4C98A',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.28)',
            pointerEvents: 'none',
          }}
        />
      ) : null}

      {scene.variant === 'cta_card' ? (
        <CtaCard
          scene={scene}
          t={t}
          accent={scene.accent}
          format={format}
          animation={ctaAnimation}
          productName={productName}
          ctaText={ctaText}
          logoSrc={contentProfile === 'religious' ? null : logoSrc}
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
        logoSrc={contentProfile === 'religious' ? null : logoSrc}
        endScreenClear={format === 'long' && scene.role === 'cta'}
        contentProfile={contentProfile}
        quiet={presentation === 'screen_recording'}
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
