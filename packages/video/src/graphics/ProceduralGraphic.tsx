import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { EditorGraphic } from '@buildtrack/core';
import { ProceduralGraphicSvg } from './ProceduralGraphicSvg';

/**
 * Actions use the clip's clock. Sequence callers already reset the clock; the legacy composition supplies
 * its scene's absolute start frame instead. No wall-clock timers.
 */
export const ProceduralGraphic: React.FC<{ graphic: EditorGraphic; width?: number; height?: number; fromFrame?: number }> = ({ graphic, width, height, fromFrame = 0 }) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const w = width ?? config.width;
  const h = height ?? config.height;
  return (
    <AbsoluteFill>
      <ProceduralGraphicSvg graphic={graphic} timeSec={(frame - fromFrame) / config.fps} width={w} height={h} />
    </AbsoluteFill>
  );
};
