import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { EditorGraphic } from '@buildtrack/core';
import { ProceduralGraphicSvg } from './ProceduralGraphicSvg';

/**
 * Remotion scene body for a procedural graphic. The clock is the scene's own frame (the Sequence resets it), so a
 * graphic starts at its clip start and its action times are clip-relative. No wall-clock timers.
 */
export const ProceduralGraphic: React.FC<{ graphic: EditorGraphic }> = ({ graphic }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  return (
    <AbsoluteFill>
      <ProceduralGraphicSvg graphic={graphic} timeSec={frame / fps} width={width} height={height} />
    </AbsoluteFill>
  );
};
