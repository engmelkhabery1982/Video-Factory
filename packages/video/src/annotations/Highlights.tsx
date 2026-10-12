import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * Timed owner/editor annotation. The box is in normalized DISPLAY-frame
 * coordinates and is shown only inside [startSec, endSec) of composition time.
 * It is an annotation, never a recorded cursor movement.
 */
export interface HighlightSpec {
  id: string;
  startSec: number;
  endSec: number;
  box: { x: number; y: number; width: number; height: number };
  label: string | null;
}

export const HighlightLayer: React.FC<{ highlights: HighlightSpec[]; accent: string }> = ({ highlights, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const active = highlights.filter((h) => t >= h.startSec && t < h.endSec);
  return (
    <>
      {active.map((h) => (
        <div
          key={h.id}
          data-highlight-id={h.id}
          style={{
            position: 'absolute',
            left: `${h.box.x * 100}%`,
            top: `${h.box.y * 100}%`,
            width: `${h.box.width * 100}%`,
            height: `${h.box.height * 100}%`,
            border: `5px solid ${accent}`,
            background: 'rgba(228, 201, 138, 0.12)',
            boxSizing: 'border-box',
            pointerEvents: 'none',
          }}
        >
          {h.label ? (
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: -48,
                background: accent,
                color: '#0B1220',
                fontSize: 30,
                padding: '4px 12px',
                fontFamily: 'Inter, sans-serif',
                whiteSpace: 'nowrap',
              }}
            >
              {h.label}
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
};
