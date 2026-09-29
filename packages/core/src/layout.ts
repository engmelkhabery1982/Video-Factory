/**
 * Phase 0C - portrait (1080x1920) safe-zone contract.
 *
 * ONE source of truth shared by the scene layouts, the caption layer and QC.
 * Bands are stacked top to bottom and never overlap:
 *
 *   0    ─ chrome     (progress rail, section label)
 *   180  ─ content    (hook, cards, panels, numbers, CTA)
 *   1080 ─ speaker    (sub-band at the bottom of content, reserved for a future
 *                      dialogue speaker label; empty today, kept inside content)
 *   1330 ─ caption    (burned captions only)
 *   1580 ─ platform   (YouTube/TikTok/Reels UI + brand logo; no key text)
 *   1920
 *
 * Horizontally every band keeps `side` px of margin; the platform action rail
 * on the right is covered by `rightRail` for the caption and content bands.
 */

export interface Band {
  top: number;
  bottom: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PORTRAIT = {
  width: 1080,
  height: 1920,
  side: 72,
  rightRail: 96,
  chrome: { top: 0, bottom: 180 } as Band,
  content: { top: 180, bottom: 1310 } as Band,
  speaker: { top: 1180, bottom: 1310 } as Band,
  caption: { top: 1330, bottom: 1580 } as Band,
  platform: { top: 1580, bottom: 1920 } as Band,
} as const;

/** CSS padding that confines a full-frame portrait layout to the content band. */
export function portraitContentPadding(): { top: number; right: number; bottom: number; left: number } {
  return {
    top: PORTRAIT.content.top,
    right: PORTRAIT.side,
    bottom: PORTRAIT.height - PORTRAIT.content.bottom,
    left: PORTRAIT.side,
  };
}

export function portraitContentPaddingCss(): string {
  const p = portraitContentPadding();
  return `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;
}

/** CSS `bottom` for the caption block: it sits on the lower edge of the caption band. */
export function portraitCaptionBottom(): number {
  return PORTRAIT.height - PORTRAIT.caption.bottom;
}

/** Largest caption block height that still stays inside the caption band. */
export function portraitCaptionMaxHeight(): number {
  return PORTRAIT.caption.bottom - PORTRAIT.caption.top;
}

export function bandBox(b: Band): Box {
  return { x: PORTRAIT.side, y: b.top, w: PORTRAIT.width - PORTRAIT.side * 2, h: b.bottom - b.top };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function insideFrame(a: Box): boolean {
  return a.x >= PORTRAIT.side && a.y >= 0 && a.x + a.w <= PORTRAIT.width - PORTRAIT.side && a.y + a.h <= PORTRAIT.height;
}

/**
 * The region each portrait layout may draw key content into. Every Short
 * layout the renderer can produce MUST be listed; QC flags anything unknown.
 * Layouts confine themselves with `portraitContentPadding()`.
 */
const CONTENT = bandBox(PORTRAIT.content);
export const PORTRAIT_LAYOUT_BOXES: Record<string, Box> = {
  // hooks
  question: CONTENT,
  surprising_number: CONTENT,
  before_after: CONTENT,
  common_mistake: CONTENT,
  risk_warning: CONTENT,
  scenario_story: CONTENT,
  document_zoom: CONTENT,
  product_result: CONTENT,
  // body
  key_statement: CONTENT,
  number_comparison: CONTENT,
  split_screen: CONTENT,
  myth_vs_reality: CONTENT,
  animated_checklist: CONTENT,
  timeline: CONTENT,
  process_flow: CONTENT,
  dashboard_demo: CONTENT,
  chart_animation: CONTENT,
  problem_cause_solution: CONTENT,
  // closing
  cta_card: CONTENT,
};

export interface SafeZoneFinding {
  sceneId: string;
  variant: string;
  problem: string;
}

/** Deterministic safe-zone check for a Short's scenes against the caption band. */
export function portraitSafeZoneFindings(scenes: { id: string; variant: string }[]): SafeZoneFinding[] {
  const out: SafeZoneFinding[] = [];
  const cap = bandBox(PORTRAIT.caption);
  const plat = bandBox(PORTRAIT.platform);
  for (const s of scenes) {
    const box = PORTRAIT_LAYOUT_BOXES[s.variant];
    if (!box) {
      out.push({ sceneId: s.id, variant: s.variant, problem: 'layout has no declared portrait safe-zone box' });
      continue;
    }
    if (boxesOverlap(box, cap)) out.push({ sceneId: s.id, variant: s.variant, problem: 'layout content overlaps the caption band' });
    if (boxesOverlap(box, plat)) out.push({ sceneId: s.id, variant: s.variant, problem: 'layout content enters the platform UI band' });
    if (!insideFrame(box)) out.push({ sceneId: s.id, variant: s.variant, problem: 'layout content breaks the side margins' });
  }
  return out;
}
