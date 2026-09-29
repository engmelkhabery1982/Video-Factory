/**
 * Text condensation helpers.
 *
 * The single most visible failure in the reference videos was copy that was cut
 * mid-sentence ("clipped titles"). These helpers make truncation grammatical:
 * they prefer a clause boundary, and they never end on a dangling function word.
 */

const DANGLING = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'that', 'this', 'it', 'as', 'at', 'by', 'from', 'with', 'into', 'than', 'then', 'so', 'if', 'when',
  'be', 'been', 'has', 'have', 'had', 'do', 'does', 'did', 'can', 'will', 'would', 'should', 'not',
]);

const BOUNDARIES = [', ', ': ', '; ', ' — ', ' – ', ' - ', ' because ', ' which ', ' that ', ' and ', ' but ', ' so ', ' while '];

/**
 * Shorten to at most `maxWords` (and optionally `maxChars`), cutting on a
 * natural boundary and never mid-clause.
 */
export function condense(text: string, maxWords: number, maxChars = Infinity): string {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const words = clean.split(' ');
  if (words.length <= maxWords && clean.length <= maxChars) return stripTrailing(clean);

  // A char budget can be tighter than the word budget. `findIndex` returns -1
  // when every word fits, and `-1 || maxWords` is -1 (truthy), which used to
  // silently disable the char limit entirely.
  let limit = maxWords;
  if (clean.length > maxChars) {
    const over = words.findIndex((_, i) => words.slice(0, i + 1).join(' ').length > maxChars);
    limit = Math.min(limit, over > 0 ? over : maxWords);
  }

  // find the last boundary inside the budget
  let head = words.slice(0, Math.max(1, limit)).join(' ');
  let best = -1;
  let bestLen = 0;
  for (const b of BOUNDARIES) {
    const idx = head.lastIndexOf(b);
    if (idx > bestLen) {
      best = idx;
      bestLen = idx;
    }
  }
  if (best > head.length * 0.3) {
    head = head.slice(0, best);
  } else {
    // drop trailing function words so the phrase reads as a complete unit
    while (head.split(' ').length > 1 && DANGLING.has(head.split(' ').pop()!.toLowerCase())) {
      head = head.split(' ').slice(0, -1).join(' ');
    }
  }
  return stripTrailing(head);
}

export function stripTrailing(s: string): string {
  return s.replace(/[\s,;:.!?\-–—]+$/, '');
}

/**
 * Build a short, legible headline from a narration sentence.
 * Numbers win: a Short is one idea, and the number usually IS the idea.
 */
export function shortHeadline(text: string, opts: { preferNumber?: string | null } = {}): string {
  const cleaned = String(text).replace(/^[^A-Za-z0-9%$\-]+/, '');
  // 50 characters is the practical ceiling for phone-sized type at 1080x1920
  const condensed = condense(cleaned, 8, 50);
  // If the sentence carried a figure but the condensation dropped it, lead with
  // the figure instead of appending it - a Short is ONE idea.
  const prefer = opts.preferNumber;
  if (prefer && !condensed.includes(prefer) && condensed.split(/\s+/).length <= 6) {
    return `${prefer} · ${condensed}`;
  }
  return condensed;
}

/** Rough on-screen width budget per format, in characters. */
export function headlineBudget(format: 'long' | 'short'): number {
  return format === 'long' ? 64 : 34;
}
