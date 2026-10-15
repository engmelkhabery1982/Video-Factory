import React from 'react';
import { graphicStateAt, pathPointAt, exactValueLabel, type EditorGraphic, type GraphicObject, type GraphicObjectState } from '@buildtrack/core';

/**
 * Procedural graphic frame, as pure SVG. It has no hooks and no clock: the caller gives the clip time, and the
 * shared evaluator in core gives the state. The same function renders in the Remotion scene (through
 * ProceduralGraphic.tsx) and in the offline frame proof, so a saved value is the drawn value.
 *
 * Coordinates are normalised to the frame (0..1). Font and shape sizes are relative to the frame height so a
 * portrait frame keeps the same proportions. Nothing is stretched: layout is authored per format and checked
 * by validateGraphic.
 */
export interface ProceduralGraphicSvgProps {
  graphic: EditorGraphic;
  timeSec: number;
  width: number;
  height: number;
}

const FONT = "Inter, 'Noto Sans Arabic', 'DejaVu Sans', Arial, sans-serif";

/**
 * Font size that keeps `text` inside `maxWidthPx`. A conservative advance-width estimate (0.6 em per character),
 * so long titles shrink instead of running off the frame. Deterministic: depends only on the text and the size.
 */
export function fitFontSize(text: string, preferredPx: number, maxWidthPx: number): number {
  const chars = Math.max(1, Array.from(text).length);
  return Math.max(8, Math.min(preferredPx, maxWidthPx / (chars * 0.6)));
}

export const ProceduralGraphicSvg: React.FC<ProceduralGraphicSvgProps> = ({ graphic, timeSec, width, height }) => {
  const state = graphicStateAt(graphic, timeSec);
  const px = (x: number) => x * width;
  const py = (y: number) => y * height;
  const unit = Math.min(width, height);
  const rtl = graphic.direction === 'rtl';
  const titleSize = graphic.title ? fitFontSize(graphic.title, height * 0.045, width * 0.9) : height * 0.045;
  const labelSize = height * 0.034;
  const valueSize = height * 0.05;

  const shapes: React.ReactNode[] = [];
  const nodes = graphic.objects.filter((o) => o.type === 'node');

  if (graphic.kind === 'process_path') {
    const points = nodes.map((n) => ({ x: n.x ?? 0.5, y: n.y ?? 0.5 }));
    const marker = graphic.objects.find((o) => o.type === 'marker');
    const progress = marker ? state.get(marker.id)?.progress ?? 0 : 0;
    // Faint full path, then the travelled part of it up to the marker.
    shapes.push(
      <polyline key="path-full" points={points.map((p) => `${px(p.x)},${py(p.y)}`).join(' ')} fill="none" stroke={graphic.textColor} strokeOpacity={0.2} strokeWidth={unit * 0.006} />,
    );
    const travelled: string[] = [];
    const samples = 60;
    for (let i = 0; i <= samples; i++) {
      const p = pathPointAt(points, (progress * i) / samples);
      travelled.push(`${px(p.x)},${py(p.y)}`);
    }
    if (progress > 0 && points.length > 1) {
      shapes.push(<polyline key="path-travelled" points={travelled.join(' ')} fill="none" stroke={graphic.accent} strokeWidth={unit * 0.012} strokeLinecap="round" />);
    }
    nodes.forEach((n) => {
      const s = state.get(n.id);
      if (!s) return;
      const r = unit * 0.035 * s.scale;
      shapes.push(
        <g key={n.id} opacity={s.opacity}>
          <circle cx={px(s.x)} cy={py(s.y)} r={r} fill={n.color ?? graphic.accent} />
          <text x={px(s.x)} y={py(s.y) + unit * 0.085} textAnchor="middle" fontFamily={FONT} fontSize={labelSize} fill={graphic.textColor} direction={rtl ? 'rtl' : 'ltr'}>{n.label}</text>
        </g>,
      );
    });
    if (marker && progress > 0 && points.length > 1) {
      const p = pathPointAt(points, progress);
      shapes.push(<circle key="marker" cx={px(p.x)} cy={py(p.y)} r={unit * 0.022} fill={marker.color ?? graphic.textColor} />);
    }
  }

  if (graphic.kind === 'numeric_comparison') {
    const scaleMax = graphic.scaleMax ?? 1;
    const maxBar = height * 0.52;
    graphic.objects.filter((o) => o.type === 'bar').forEach((o: GraphicObject) => {
      const s: GraphicObjectState | undefined = state.get(o.id);
      if (!s) return;
      const value = o.value ?? 0;
      const barH = maxBar * (value / scaleMax) * s.progress;
      const barW = unit * 0.11;
      const x = px(s.x) - barW / 2;
      const top = py(s.y) - barH;
      shapes.push(
        <g key={o.id} opacity={s.opacity}>
          <rect x={x} y={top} width={barW} height={Math.max(0, barH)} fill={o.color ?? graphic.accent} />
          <text x={px(s.x)} y={top - height * 0.012} textAnchor="middle" fontFamily={FONT} fontWeight={700} fontSize={valueSize} fill={graphic.textColor}>{exactValueLabel(o)}</text>
          <text x={px(s.x)} y={py(s.y) + height * 0.04} textAnchor="middle" fontFamily={FONT} fontSize={labelSize} fill={graphic.textColor} direction={rtl ? 'rtl' : 'ltr'}>{o.label}</text>
        </g>,
      );
    });
  }

  if (graphic.kind === 'actor_action') {
    graphic.objects.forEach((o) => {
      const s = state.get(o.id);
      if (!s) return;
      if (o.type === 'figure') {
        const cx = px(s.x); const cy = py(s.y);
        const k = height * 0.2 * s.scale;
        const headR = k * 0.14;
        const shoulderY = cy - k * 0.55;
        const arm = (k * 0.5);
        const rad = (s.armAngle * Math.PI) / 180;
        const hx = cx + arm * Math.sin(rad);
        const hy = shoulderY + arm * Math.cos(rad);
        shapes.push(
          <g key={o.id} opacity={s.opacity} stroke={o.color ?? graphic.textColor} strokeWidth={unit * 0.012} strokeLinecap="round" fill="none">
            <circle cx={cx} cy={cy - k * 0.8} r={headR} fill={o.color ?? graphic.textColor} stroke="none" />
            <line x1={cx} y1={cy - k * 0.6} x2={cx} y2={cy} />
            <line x1={cx} y1={cy} x2={cx - k * 0.2} y2={cy + k * 0.4} />
            <line x1={cx} y1={cy} x2={cx + k * 0.2} y2={cy + k * 0.4} />
            <line x1={cx} y1={shoulderY} x2={hx} y2={hy} />
            <line x1={cx} y1={shoulderY} x2={cx - (hx - cx)} y2={hy} strokeOpacity={0.5} />
          </g>,
        );
      }
      if (o.type === 'box') {
        const w = px(o.w ?? 0.1) * s.scale;
        const h = py(o.h ?? 0.1) * s.scale;
        const cx = px(s.x); const cy = py(s.y);
        shapes.push(
          <g key={o.id} opacity={s.opacity} transform={`rotate(${s.rotation} ${cx} ${cy})`}>
            <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={unit * 0.004} fill={o.color ?? graphic.accent} />
            {s.label ? <text x={cx} y={cy + labelSize * 0.35} textAnchor="middle" fontFamily={FONT} fontSize={labelSize} fill={graphic.background}>{s.label}</text> : null}
          </g>,
        );
      }
      if (o.type === 'tick') {
        const cx = px(s.x); const cy = py(s.y);
        const k = unit * 0.06 * s.scale;
        shapes.push(
          <polyline key={o.id} opacity={s.opacity} points={`${cx - k},${cy} ${cx - k * 0.3},${cy + k * 0.7} ${cx + k},${cy - k * 0.8}`} fill="none" stroke={o.color ?? graphic.accent} strokeWidth={unit * 0.016} strokeLinecap="round" strokeLinejoin="round" />,
        );
      }
    });
  }

  if (graphic.kind === 'kinetic_text') {
    graphic.objects.filter((o) => o.type === 'word').forEach((o) => {
      const s = state.get(o.id);
      if (!s) return;
      const size = fitFontSize(o.text ?? '', height * (o.size ?? 0.08), width * 0.9);
      const strong = o.emphasis === 'strong';
      const cx = px(s.x); const cy = py(s.y);
      shapes.push(
        <text
          key={o.id}
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="middle"
          fontFamily={FONT}
          fontWeight={strong ? 800 : 500}
          fontSize={size}
          fill={strong ? graphic.accent : graphic.textColor}
          opacity={s.opacity}
          transform={`translate(${cx} ${cy}) scale(${s.scale}) translate(${-cx} ${-cy})`}
          direction={rtl ? 'rtl' : 'ltr'}
        >
          {o.text}
        </text>,
      );
    });
  }

  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} data-graphic-kind={graphic.kind} data-time-sec={timeSec.toFixed(3)}>
      <rect x={0} y={0} width={width} height={height} fill={graphic.background} />
      {graphic.title ? (
        <text x={width / 2} y={height * 0.12} textAnchor="middle" fontFamily={FONT} fontWeight={700} fontSize={titleSize} fill={graphic.textColor} direction={rtl ? 'rtl' : 'ltr'}>{graphic.title}</text>
      ) : null}
      {shapes}
    </svg>
  );
};
