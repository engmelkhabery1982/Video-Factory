/**
 * Phase 0C - visual semantics and on-screen text quality.
 *
 * Reusable, local, deterministic rules (no AI, no network):
 *  - what a scene is *about* (its intent) so the layout follows the content;
 *  - whether a text really has two contrasting sides (before/after, A vs B);
 *  - complete, grammatical on-screen text cut only at clause boundaries;
 *  - detection of fragments and generic filler for QC.
 */

export type SceneIntent = 'stat' | 'question' | 'warning' | 'comparison' | 'steps' | 'statement';

/** Words that cannot end on-screen text without leaving it sounding broken. */
export const DANGLING_WORD =
  /^(a|an|the|is|are|was|were|be|been|being|to|of|and|or|but|not|that|this|these|those|it|its|as|at|by|for|from|in|into|on|onto|than|then|so|if|when|while|which|who|whom|whose|with|without|your|our|my|their|his|her|where|what|how|why|do|does|did|has|have|had|can|will|would|should|could|actually|very|just)$/i;

/** Generic sentences that were once injected into unrelated scenes. Never allowed on screen. */
export const GENERIC_FILLER: string[] = [
  'This is where most projects lose control.',
  'The reported number',
  'The real number',
  'THIS IS THE REAL NUMBER',
];

const NUM = /\d+(?:[.,]\d+)?\s*(?:%|percent\b)?/gi;

export function numbersIn(text: string): string[] {
  return (String(text).match(NUM) ?? []).map((s) => s.trim()).filter((s) => /\d/.test(s));
}

const norm = (s: string) =>
  String(s)
    .toLowerCase()
    .replace(/percent/g, '%')
    .replace(/[^a-z0-9%.]+/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
export const normText = norm;

/**
 * Two genuinely contrasting sides exist only when the text itself names them:
 * two different figures, or an explicit contrast pair. A single statistic
 * ("Your site is 70% finished.") is NOT a before/after.
 */
export function hasGenuineContrast(text: string, stat?: string | null, stat2?: string | null): boolean {
  const t = String(text);
  const nums = [...new Set(numbersIn(t).map(norm))];
  if (nums.length >= 2) return true;
  if (/\b(before|used to)\b[\s\S]*\b(after|now)\b/i.test(t)) return true;
  if (/\b(vs\.?|versus)\b/i.test(t)) return true;
  if (/\bmyth\b[\s\S]*\b(reality|truth|fact)\b/i.test(t)) return true;
  // explicit pair supplied by the scene itself, both figures present in the spoken text
  if (stat && stat2 && norm(stat) !== norm(stat2) && t.includes(String(stat).replace(/%$/, '')) && t.includes(String(stat2).replace(/%$/, ''))) return true;
  return false;
}

/** Deterministic semantic intent of a scene's spoken text. */
export function classifyIntent(text: string): SceneIntent {
  const t = String(text).trim();
  if (/[?؟]\s*$/.test(t)) return 'question';
  if (hasGenuineContrast(t)) return 'comparison';
  if (/^(step|first|second|third|next|then|finally)\b/i.test(t)) return 'steps';
  if (/\b(risk|warning|danger|lose|losing|late|overrun|dispute|penalt|mistake|never|fail)/i.test(t)) return numbersIn(t).length ? 'stat' : 'warning';
  if (numbersIn(t).length) return 'stat';
  return 'statement';
}

function stripEnd(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/[\s,;:\-–—]+$/, '');
}

function endsDangling(s: string): boolean {
  const last = stripEnd(s).replace(/[.!?]+$/, '').split(' ').pop() ?? '';
  return DANGLING_WORD.test(last);
}

/**
 * Complete on-screen text for a sentence, within `max` characters, cut ONLY at
 * a clause boundary. Never a fixed-word-count slice. Order of preference:
 *   1. the whole sentence;
 *   2. the whole sentence without a leading discourse marker ("So, ...");
 *   3. the longest leading clause ending at , ; : - or before a coordinating /
 *      subordinating conjunction, with at least 3 words and a non-dangling end;
 * Returns null when no complete unit fits: the caller must pick a layout that
 * does not need a headline (e.g. the figure alone) instead of clipping.
 */
export function completeText(sentence: string, max = 52): string | null {
  const full = stripEnd(sentence);
  if (!full) return null;
  const fits = (s: string) => s.length <= max && s.split(' ').length >= 2;
  if (fits(full)) return full;
  const noMarker = full.replace(/^(so|and|but|now|then|also|here is the thing|in short|that is why)[,:]?\s+/i, '');
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (noMarker !== full && fits(noMarker)) return cap(noMarker);

  const base = noMarker;
  const cuts: number[] = [];
  const re = /(?<!\d)[,;:](?!\d)|\s[-–—]\s|\s(?=(?:and|but|because|which|while|when|where|until|unless|although|since|before|after|if)\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(base))) cuts.push(m.index);
  for (const at of cuts.sort((a, b) => b - a)) {
    const cand = stripEnd(base.slice(0, at));
    if (cand.length <= max && cand.split(' ').length >= 3 && !endsDangling(cand)) return cap(cand);
  }
  // last tier: a complete leading phrase before a prepositional phrase
  const pre: number[] = [];
  const re2 = /\s(?=(?:to|for|with|from|inside|in|on|at|over|by|without|during|every)\s)/gi;
  while ((m = re2.exec(base))) pre.push(m.index);
  for (const at of pre.sort((a, b) => b - a)) {
    const cand = stripEnd(base.slice(0, at));
    if (cand.length <= max && cand.split(' ').length >= 3 && !endsDangling(cand)) return cap(cand);
  }
  return null;
}

/**
 * A headline is a fragment when it is not a complete unit of its source
 * sentence: it starts mid-sentence (lower-case), ends on a dangling word, or is
 * a prefix of the source that stops somewhere other than a clause boundary.
 * Used by QC; `source` is the full spoken sentence when known.
 */
export function isFragmentHeadline(headline: string, source?: string | null): boolean {
  const h = stripEnd(String(headline ?? ''));
  if (!h) return true;
  if (/^[a-z]/.test(h)) return true;
  if (source && norm(h) === norm(stripEnd(String(source)))) return false; // the whole sentence
  // a sentence with terminal punctuation may legitimately end on "it." / "from?"
  if (!/[.!?\u061F]$/.test(h) && endsDangling(h)) return true;
  if (source) {
    const s = stripEnd(String(source));
    const hn = norm(h);
    const sn = norm(s);
    if (numbersIn(h).length && hn.replace(/%/g, '').trim().split(' ').length <= 1) return false; // a lone figure is a figure, not a fragment
    // allow the leading-marker variant
    const idx = sn.indexOf(hn);
    if (idx < 0) return false; // not derived from the source: judged by the generic rules only
    const after = sn.slice(idx + hn.length).trim();
    if (!after) return false;
    // the raw text right after the headline must be a clause boundary
    const rawIdx = s.toLowerCase().indexOf(h.toLowerCase());
    if (rawIdx < 0) return false;
    const tail = s.slice(rawIdx + h.length);
    return !/^\s*([,;:.!?]|[-–—]\s|\s(and|but|so|because|which|while|when|where|until|unless|although|since|before|after|if|to|for|with|from|inside|in|on|at|over|by|without|during|every)\b)/i.test(tail);
  }
  return false;
}

export function isGenericFiller(text: string | null | undefined): boolean {
  if (!text) return false;
  const n = norm(text);
  return GENERIC_FILLER.some((g) => norm(g) === n);
}

/** Longest sentence a single-block portrait layout shows in full (about 4 lines at 64px). */
export const DISPLAY_SENTENCE_MAX = 100;

/**
 * The text a scene actually shows as its main block. A single-block statement
 * shows the complete spoken sentence (with the current beat highlighted) when
 * it fits; every other layout shows its headline.
 */
export function displayText(variant: string, content: { headline: string; source?: string | null }): string {
  // only while the headline is still derived from the sentence: a user-edited
  // headline always wins
  if (
    (variant === 'key_statement' || variant === 'number_comparison') &&
    content.source &&
    content.source.length <= DISPLAY_SENTENCE_MAX &&
    norm(content.source).startsWith(norm(content.headline))
  )
    return content.source;
  return content.headline;
}

/**
 * Phase 0C - a burned caption cue is redundant when the scene already shows
 * (almost) the same words as its main text. The cue is then rendered compact
 * so the frame never carries two equally prominent copies of one sentence.
 * Sidecar SRT/VTT files are unaffected.
 */
export function isCueRedundant(cueText: string, sceneText: string, threshold = 0.8): boolean {
  const words = norm(cueText).split(' ').filter((w) => w.length > 1 || /\d/.test(w));
  if (!words.length) return false;
  const shown = new Set(norm(sceneText).split(' '));
  const hit = words.filter((w) => shown.has(w)).length;
  return hit / words.length >= threshold;
}
