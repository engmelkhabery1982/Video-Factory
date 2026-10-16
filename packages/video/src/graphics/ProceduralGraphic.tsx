import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { EditorGraphic } from '@buildtrack/core';
import { ProceduralGraphicSvg } from './ProceduralGraphicSvg';

/**
 * Remotion scene body for a procedural graphic. The clock is the scene's own frame (the Sequence resets it), so a
 * graphic starts at its clip start and its action times are clip-relative. No wall-clock timers.
 */
export const ProceduralGraphic: React.FC<{ graphic: EditorGraphic; width?: number; height?: number }> = ({ graphic, width, height }) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const w = width ?? config.width;
  const h = height ?? config.height;
  return (
    <AbsoluteFill>
      <ProceduralGraphicSvg graphic={graphic} timeSec={frame / config.fps} width={w} height={h} />
    </AbsoluteFill>
  );
};
