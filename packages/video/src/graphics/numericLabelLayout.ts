import { exactValueLabel, graphicStateAt, type EditorGraphic } from '@buildtrack/core/visual';
import { actorBoxLabelDirection, layoutActorBoxLabel, type ActorBoxLabelLayout } from './actorBoxLabelLayout';
import { graphicSafeBox } from './graphicSafeBox';

export interface NumericTextRegion { left: number; top: number; width: number; height: number }
export interface NumericTextPlacement {
  text: string;
  direction: 'ltr' | 'rtl';
  region: NumericTextRegion;
  layout: ActorBoxLabelLayout;
}
export interface NumericBarLabels {
  id: string;
  cell: NumericTextRegion;
  category: NumericTextPlacement;
  value: NumericTextPlacement;
}

type Band = { top: number; bottom: number };
/** The existing title baseline is 12% of frame height. Keep numeric text out of its ascent/descent band. */
function availableBand(top: number, bottom: number, height: number, hasTitle: boolean): Band | null {
  const bands = hasTitle ? [{ top, bottom: Math.min(bottom, height * 0.075) }, { top: Math.max(top, height * 0.17), bottom }]
    : [{ top, bottom }];
  return bands.filter((b) => b.bottom > b.top).sort((a, b) => (b.bottom - b.top) - (a.bottom - a.top))[0] ?? null;
}

/**
 * Allocate text only, never bar geometry. Every pair is separated at its midpoint on the axis with the
 * greater normalised distance. Usual charts get columns; vertically separated bars (also valid) get rows.
 * Each cell contains its bar's baseline/centre and is disjoint from every other cell on at least one axis.
 */
export function layoutNumericLabels(graphic: EditorGraphic, width: number, height: number, timeSec = 0): NumericBarLabels[] {
  if (graphic.kind !== 'numeric_comparison' || ![width, height].every((v) => Number.isFinite(v) && v > 0)) return [];
  const bars = graphic.objects.filter((o) => o.type === 'bar');
  const states = graphicStateAt(graphic, timeSec);
  const result: NumericBarLabels[] = [];
  for (const bar of bars) {
    const state = states.get(bar.id)!;
    let left = width * 0.02; let right = width * 0.98;
    let top = height * 0.02; let bottom = height * 0.98;
    for (const other of bars) {
      if (other.id === bar.id) continue;
      const peer = states.get(other.id)!;
      const dx = peer.x - state.x; const dy = peer.y - state.y;
      if (Math.abs(dx) >= Math.abs(dy)) {
        const mid = (state.x + peer.x) * width / 2;
        if (dx > 0) right = Math.min(right, mid); else left = Math.max(left, mid);
      } else {
        const mid = (state.y + peer.y) * height / 2;
        if (dy > 0) bottom = Math.min(bottom, mid); else top = Math.max(top, mid);
      }
    }
    const baseline = state.y * height;
    const gap = Math.min(height * 0.008, (baseline - top) / 4, (bottom - baseline) / 4);
    const cell = { left, top, width: right - left, height: bottom - top };
    // Keep the text centred on its own bar, including unequal spacing and frame-edge bars.
    const centreX = state.x * width;
    const textWidth = 2 * Math.min(centreX - left, right - centreX);
    const textLeft = centreX - textWidth / 2;
    let categoryBand = availableBand(baseline + gap, bottom, height, !!graphic.title);
    let valueBand = availableBand(top, baseline - gap, height, !!graphic.title);
    if (!categoryBand || !valueBand) {
      // A supplied baseline may itself be in the title band. Share the remaining cell space, not the title.
      const available = availableBand(top, bottom, height, !!graphic.title);
      if (!available) continue;
      const mid = (available.top + available.bottom) / 2;
      const halfGap = Math.min(gap, (available.bottom - available.top) * 0.02);
      valueBand = { top: available.top, bottom: mid - halfGap };
      categoryBand = { top: mid + halfGap, bottom: available.bottom };
    }
    const categoryHeight = Math.min(height * 0.16, categoryBand.bottom - categoryBand.top);
    const valueHeight = Math.min(height * 0.18, valueBand.bottom - valueBand.top);
    // Match the existing bar evaluator exactly. Only the text's region is clamped into the frame/cell.
    const barTop = baseline - height * 0.52 * (bar.value! / graphic.scaleMax!) * state.progress;
    const valueTop = Math.max(valueBand.top, Math.min(valueBand.bottom - valueHeight, barTop - gap - valueHeight));
    const categoryRegion = { left: textLeft, top: categoryBand.top, width: textWidth, height: categoryHeight };
    const valueRegion = { left: textLeft, top: valueTop, width: textWidth, height: valueHeight };
    const categoryText = bar.label ?? '';
    const valueText = exactValueLabel(bar); // One exact canonical string, including its decimal padding and unit.
    const category = layoutActorBoxLabel(categoryText, textWidth, categoryHeight, height);
    const value = layoutActorBoxLabel(valueText, textWidth, valueHeight, height, height * 0.05);
    if (!category || !value) continue; // Incomplete/invalid geometry belongs to canonical validation, not layout.
    // Category text starts below the baseline; value text ends above the moving bar top when there is room.
    // These offsets stay within the same padded region; the accepted actor helper keeps its centred default.
    for (const [layout, sign] of [[category, -1], [value, 1]] as const) {
      const offset = sign * (layout.innerHeight - layout.lines.length * layout.lineHeight) / 2;
      layout.lines = layout.lines.map((line) => ({ ...line, top: line.top + offset, baseline: line.baseline + offset }));
    }
    result.push({
      id: bar.id, cell,
      category: { text: categoryText, direction: actorBoxLabelDirection(categoryText, graphic.direction), region: categoryRegion, layout: category },
      value: { text: valueText, direction: actorBoxLabelDirection(valueText, 'ltr'), region: valueRegion, layout: value },
    });
  }
  return result;
}

/** Font sizes/region dimensions do not depend on progress, only their vertical placement does. */
export function numericLabelWarnings(graphic: EditorGraphic, format: 'landscape' | 'portrait'): Array<{ id: string; category: boolean; value: boolean }> {
  const portrait = format === 'portrait';
  const frame = graphicSafeBox(portrait ? 'short' : 'long', portrait ? 1080 : 1920, portrait ? 1920 : 1080);
  return layoutNumericLabels(graphic, frame.width, frame.height).filter((bar) => bar.category.layout.tooSmall || bar.value.layout.tooSmall)
    .map((bar) => ({ id: bar.id, category: bar.category.layout.tooSmall, value: bar.value.layout.tooSmall }));
}
