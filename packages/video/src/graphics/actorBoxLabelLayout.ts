import type { GraphicAction, GraphicObject } from '@buildtrack/core/visual';
import { graphicSafeBox } from './graphicSafeBox';

/** Pure label layout, shared by the SVG and the inspector. No font downloads, DOM measurement or data edits. */
export interface ActorBoxLabelLayout {
  fontSize: number;
  lineHeight: number;
  paddingX: number;
  paddingY: number;
  innerWidth: number;
  innerHeight: number;
  /** Relative to the box centre. Width is the SVG textLength, not an unverified font-metric measurement. */
  lines: Array<{ text: string; width: number; top: number; baseline: number }>;
  tooSmall: boolean;
}

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const MARK = /\p{Mark}/gu;
const BREAK_SPACE = /^\s/u;
const NO_BREAK_SPACE = /^[\u00a0\u2007\u202f]/u;

/** Estimates only choose wrapping. SVG lengthAdjust bounds the final horizontal advances in the actual font. */
function advance(cluster: string): number {
  if (BREAK_SPACE.test(cluster)) return 0.35;
  if (/[MW@#%]|\p{Extended_Pictographic}|[\u2e80-\u9fff]/u.test(cluster)) return 1;
  return 0.65;
}

/**
 * Fit without an 8px floor: valid tiny boxes sometimes require sub-pixel text, which must be warned about,
 * not hidden/truncated or "fixed" by changing the owner's geometry. Inputs are current, scaled SVG pixels.
 * Lines are exact substrings. Never trim/collapse/normalise whitespace, reverse RTL, or split a grapheme.
 */
export function layoutActorBoxLabel(text: string, boxWidth: number, boxHeight: number, frameHeight: number): ActorBoxLabelLayout | null {
  if (![boxWidth, boxHeight, frameHeight].every((n) => Number.isFinite(n) && n > 0)) return null;
  const paddingX = boxWidth * 0.08;
  const paddingY = boxHeight * 0.1;
  const innerWidth = boxWidth - 2 * paddingX;
  const innerHeight = boxHeight - 2 * paddingY;
  const preferred = frameHeight * 0.034; // Existing actor label size, now an upper bound rather than a fixed size.
  const clusters = Array.from(segmenter.segment(text), (part) => part.segment);
  const widths = clusters.map(advance);
  // Generous ascent/descent, plus room for unusually deep combining-mark stacks. Marks stay with their base.
  const extraMarks = clusters.reduce((max, c) => Math.max(max, (c.match(MARK)?.length ?? 0) - 2), 0);
  const ascent = 1.25 + extraMarks * 0.3;
  const lineEm = ascent + 0.55;
  const prefix = [0];
  widths.forEach((w) => prefix.push(prefix[prefix.length - 1] + w));

  const wrap = (font: number) => {
    const capacity = innerWidth / font;
    const lines: Array<{ text: string; units: number }> = [];
    let start = 0;
    while (start < clusters.length) {
      let end = start;
      let boundary = start;
      while (end < clusters.length && prefix[end + 1] - prefix[start] <= capacity) {
        if (BREAK_SPACE.test(clusters[end]) && !NO_BREAK_SPACE.test(clusters[end])) boundary = end + 1;
        end += 1;
      }
      // Prefer a word boundary. An unbroken identifier is split only between whole graphemes.
      if (end < clusters.length && boundary > start) end = boundary;
      if (end === start) end += 1; // Even an oversized grapheme makes progress; fits() will reject this size.
      lines.push({ text: clusters.slice(start, end).join(''), units: prefix[end] - prefix[start] });
      start = end;
    }
    return lines;
  };
  const fits = (font: number) => {
    const lines = wrap(font);
    return lines.length * font * lineEm <= innerHeight && lines.every((l) => l.units * font <= innerWidth);
  };

  let low = 0;
  let high = preferred;
  if (fits(preferred)) low = preferred;
  else for (let i = 0; i < 36; i += 1) { // Fixed bounded work; independent of fonts, frame time and wall clock.
    const mid = (low + high) / 2;
    if (fits(mid)) low = mid; else high = mid;
  }
  const fontSize = low;
  const lineHeight = fontSize * lineEm;
  const wrapped = wrap(fontSize);
  const top = -wrapped.length * lineHeight / 2;
  return {
    fontSize, lineHeight, paddingX, paddingY, innerWidth, innerHeight,
    lines: wrapped.map((line, i) => ({ text: line.text, width: Math.min(innerWidth, line.units * fontSize), top: top + i * lineHeight, baseline: top + i * lineHeight + ascent * fontSize })),
    // Advisory at <2% of the graphic's height (about 59% of the preferred label size), not a content limit.
    tooSmall: text.length > 0 && fontSize < frameHeight * 0.02,
  };
}

/** Use the existing scene safe area and the smallest base/animated scale for an advisory in the inspector. */
export function actorBoxLabelTooSmall(object: GraphicObject, actions: readonly GraphicAction[], format: 'landscape' | 'portrait'): boolean {
  if (object.type !== 'box' || !object.label || object.w === undefined || object.h === undefined) return false;
  const scales = [object.scale ?? 1, ...actions.filter((a) => a.targetId === object.id && a.property === 'scale').flatMap((a) => [a.from, a.to])];
  if (!scales.every((s) => Number.isFinite(s) && s > 0)) return false; // Validation handles incomplete/invalid inputs separately.
  const scale = Math.min(...scales);
  const portrait = format === 'portrait';
  const frame = graphicSafeBox(portrait ? 'short' : 'long', portrait ? 1080 : 1920, portrait ? 1920 : 1080);
  return layoutActorBoxLabel(object.label, object.w * frame.width * scale, object.h * frame.height * scale, frame.height)?.tooSmall ?? false;
}
