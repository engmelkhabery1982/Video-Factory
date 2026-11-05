import { type EditorGraphic } from '@buildtrack/core/visual';
import { actorBoxLabelDirection, layoutActorBoxLabel } from './actorBoxLabelLayout';
import { graphicSafeBox } from './graphicSafeBox';

/** Text allocation only: saved nodes, path order, marker and animation never move. */
export function layoutProcessLabels(graphic: EditorGraphic, width: number, height: number) {
  if (graphic.kind !== 'process_path' || ![width, height].every((n) => Number.isFinite(n) && n > 0)) return [];
  const nodes = graphic.objects.filter((o) => o.type === 'node');
  return nodes.flatMap((node) => {
    const x = node.x! * width; const y = node.y! * height;
    let left = width * .02; let right = width * .98;
    let top = height * .02; let bottom = height * .98;
    for (const other of nodes) {
      if (other.id === node.id) continue;
      const dx = other.x! - node.x!; const dy = other.y! - node.y!;
      // Pairwise midpoint cuts give disjoint cells even for irregular two-dimensional layouts.
      if (Math.abs(dx) >= Math.abs(dy)) {
        const mid = (x + other.x! * width) / 2;
        if (dx > 0) right = Math.min(right, mid); else left = Math.max(left, mid);
      } else {
        const mid = (y + other.y! * height) / 2;
        if (dy > 0) bottom = Math.min(bottom, mid); else top = Math.max(top, mid);
      }
    }
    const scale = Math.max(node.scale ?? 1, ...graphic.actions.filter((a) => a.targetId === node.id && a.property === 'scale').flatMap((a) => [a.from, a.to]));
    const gap = Math.min(width, height) * (.035 * scale + .015);
    const splitTitle = (a: number, b: number) => (graphic.title
      ? [{ top: a, bottom: Math.min(b, height * .075) }, { top: Math.max(a, height * .17), bottom: b }]
      : [{ top: a, bottom: b }]).filter((band) => band.bottom > band.top);
    const nearest = nodes.filter((o) => o.id !== node.id).sort((a, b) =>
      Math.max(Math.abs(a.x! - node.x!), Math.abs(a.y! - node.y!)) - Math.max(Math.abs(b.x! - node.x!), Math.abs(b.y! - node.y!)))[0];
    const vertical = nearest && Math.abs(nearest.y! - node.y!) > Math.abs(nearest.x! - node.x!);
    const side = [{ left, right: Math.min(right, x - gap) }, { left: Math.max(left, x + gap), right }]
      .filter((s) => s.right > s.left).sort((a, b) => (b.right - b.left) - (a.right - a.left))[0];
    const below = splitTitle(Math.max(top, y + gap), bottom);
    const above = splitTitle(top, Math.min(bottom, y - gap));
    // Prefer below the node; extreme valid geometry falls back to the largest title-free cell band.
    const bands = [...below, ...above];
    const beside = vertical && side;
    const band = (beside ? splitTitle(top, bottom) : bands.length ? bands : splitTitle(top, bottom)).sort((a, b) => (b.bottom - b.top) - (a.bottom - a.top))[0];
    if (!band) return [];
    const region = { left: beside ? side.left : left, top: band.top, width: beside ? side.right - side.left : right - left, height: Math.min(height * .2, band.bottom - band.top) };
    if (beside) region.top = Math.max(band.top, Math.min(band.bottom - region.height, y - region.height / 2));
    else if (band.bottom <= y) region.top = band.bottom - region.height;
    const text = node.label ?? '';
    const layout = layoutActorBoxLabel(text, region.width, region.height, height);
    return layout ? [{ id: node.id, text, region, layout, direction: actorBoxLabelDirection(text, graphic.direction) }] : [];
  });
}

export function processLabelWarnings(graphic: EditorGraphic, format: 'landscape' | 'portrait') {
  const portrait = format === 'portrait';
  const frame = graphicSafeBox(portrait ? 'short' : 'long', portrait ? 1080 : 1920, portrait ? 1920 : 1080);
  return layoutProcessLabels(graphic, frame.width, frame.height).filter((p) => p.layout.tooSmall).map((p) => p.id);
}
