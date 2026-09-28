import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { CaptionCue, CaptionStyleId, CtaAnimationId, Scene } from '@buildtrack/core';
import { theme } from '../brand/theme';
import { FPS, LAYOUT, typeScale } from '../brand/theme';
import { SceneRenderer } from '../scenes/SceneRenderer';
import { Captions } from '../captions/Captions';
import { Transition, transitionLength } from '../scenes/Transitions';

export interface VideoProps {
  scenes: Scene[];
  captions: CaptionCue[];
  brand: any;
  format: 'long' | 'short';
  ctaAnimation: CtaAnimationId;
  captionStyle: CaptionStyleId;
  ctaText: string;
  productName: string;
  logoSrc?: string | null;
  audioSrc?: string | null;
  /** burned-in captions, for the "captions embedded" deliverable */
  burnedCaptions?: boolean;
  mediaMap?: Record<string, string>;
  sceneProgress?: boolean;
}

const sec = (n: number) => Math.max(1, Math.round(n * FPS));

/**
 * One composition drives BOTH deliverables.
 * The long video is a 16:9 sequence; the shorts are native 9:16 sequences
 * built from their own storyboard - never a resized landscape frame.
 */
export const VideoComposition: React.FC<VideoProps> = ({
  scenes,
  captions,
  brand,
  format,
  ctaAnimation,
  captionStyle,
  ctaText,
  productName,
  logoSrc,
  audioSrc,
  burnedCaptions = true,
  mediaMap,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = theme(brand);
  const L = format === 'long' ? LAYOUT.long : LAYOUT.short;

  // build the frame-accurate scene table once
  const table = React.useMemo(() => {
    const out: { scene: Scene; from: number; to: number }[] = [];
    let at = 0;
    for (const s of scenes) {
      const len = sec(s.duration);
      out.push({ scene: s, from: at, to: at + len });
      at += len;
    }
    return out;
  }, [scenes]);

  const current = table.find((x) => frame >= x.from && frame < x.to) ?? table[table.length - 1];
  if (!current) return null;

  const localFrame = frame - current.from;
  const sceneProgress = (localFrame / Math.max(1, current.to - current.from));

  // transition into this scene
  const tLen = transitionLength(current.scene.transitionIn);
  const tFrames = tLen * fps;
  let transitionEl: React.ReactElement | null = null;
  if (localFrame < tFrames && current.from > 0 && current.scene.transitionIn !== 'direct_cut') {
    const p = tFrames > 0 ? localFrame / tFrames : 1;
    transitionEl = <Transition variant={current.scene.transitionIn} p={p} accent={current.scene.accent} fromSide={current.scene.index % 2 === 0 ? 'left' : 'right'} />;
  }

  // scene-level intro motion (keeps the frame alive even on a static layout)
  // Gentle per-scene motion. Applied to the background plate only: it reads as
  // camera movement but costs one cheap transform instead of re-rasterising the
  // whole 1920x1080 tree every frame.
  const panX = interpolate(sceneProgress, [0, 1], [format === 'long' ? -14 : -9, format === 'long' ? 14 : 9]);
  const intro = spring({ frame: localFrame, fps, config: { damping: 200, mass: 0.7 }, durationInFrames: 14 });

  return (
    <AbsoluteFill style={{ backgroundColor: t.c.surfaceDark, width: L.width, height: L.height }}>
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
          <SceneRenderer
            scene={current.scene}
            t={t}
            format={format}
            ctaAnimation={ctaAnimation}
            ctaText={ctaText}
            productName={productName}
            logoSrc={logoSrc}
            mediaUrl={current.scene.assetIds[0] ? mediaMap?.[current.scene.assetIds[0]] : null}
            progress={frame / Math.max(1, table[table.length - 1].to)}
            parallax={panX}
            reveal={intro}
          />
        </div>
      </AbsoluteFill>

      {transitionEl}

      {/* global fade-in / fade-out so exports never start or end on a hard cut */}
      <AbsoluteFill
        style={{
          backgroundColor: '#000',
          opacity: interpolate(frame, [0, 12, totalFramesSafe(table) - 14, totalFramesSafe(table)], [1, 0, 0, 0.55], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          pointerEvents: 'none',
        }}
      />

      {burnedCaptions ? <Captions cues={captions} style={captionStyle} t={t} accent={t.c.accent} format={format} sceneAccent={current.scene.accent} /> : null}

      {audioSrc ? <Audio src={audioSrc} /> : null}
    </AbsoluteFill>
  );
};

function totalFramesSafe(table: { to: number }[]) {
  return table.length ? table[table.length - 1].to : 1;
}

export const easing = Easing.bezier(0.22, 1, 0.36, 1);
export const _ts = typeScale;
