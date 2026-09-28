import type { HistoryEntry, HookVariantId, SimilarityFactor, SimilarityResult, VisualHistory } from './types.js';

export const SIMILARITY_THRESHOLD = 65;
export const HISTORY_FILE = 'visual_history.json';

export function emptyHistory(): VisualHistory {
  return { version: 1, videos: [] };
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function multisetOverlap(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  let inter = 0;
  for (const x of b) inter += Math.min(counts.get(x) ?? 0, b.filter((y) => y === x).length);
  const denom = Math.max(a.length, b.length, 1);
  return inter / denom;
}

/** longest common prefix of the ordered scene sequence (0..1) */
function orderedOverlap(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i / Math.max(a.length, b.length, 1);
}

function durationShape(d: number[]): number[] {
  if (!d.length) return [];
  const total = d.reduce((a, b) => a + b, 0) || 1;
  return d.map((x) => x / total);
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function clamp(x: number): number {
  return Math.max(0, Math.min(100, x));
}

export interface SignatureInput {
  hookVariant: HistoryEntry['hookVariant'];
  sceneOrder: HistoryEntry['sceneOrder'];
  backgrounds: HistoryEntry['backgrounds'];
  transitions: HistoryEntry['transitions'];
  textPositions: HistoryEntry['textPositions'];
  accents: HistoryEntry['accents'];
  sceneDurations: number[];
  ctaAnimation: HistoryEntry['ctaAnimation'];
  captionStyle: HistoryEntry['captionStyle'];
}

const WEIGHTS: { key: keyof SignatureInput; label: string; weight: number; fn: (a: SignatureInput, b: HistoryEntry) => number }[] = [
  { key: 'hookVariant', label: 'Hook variant', weight: 0.18, fn: (a, b) => (a.hookVariant === b.hookVariant ? 100 : 0) },
  { key: 'sceneOrder', label: 'Scene order', weight: 0.26, fn: (a, b) => clamp((0.6 * orderedOverlap(a.sceneOrder, b.sceneOrder) + 0.4 * multisetOverlap(a.sceneOrder, b.sceneOrder)) * 100) },
  { key: 'backgrounds', label: 'Background distribution', weight: 0.14, fn: (a, b) => clamp(jaccard(a.backgrounds, b.backgrounds) * 100) },
  { key: 'transitions', label: 'Transition distribution', weight: 0.1, fn: (a, b) => clamp(jaccard(a.transitions, b.transitions) * 100) },
  { key: 'textPositions', label: 'Text positions', weight: 0.05, fn: (a, b) => clamp(jaccard(a.textPositions, b.textPositions) * 100) },
  { key: 'accents', label: 'Accent colours', weight: 0.05, fn: (a, b) => clamp(jaccard(a.accents, b.accents) * 100) },
  { key: 'sceneDurations', label: 'Scene duration rhythm', weight: 0.07, fn: (a, b) => clamp(cosine(durationShape(a.sceneDurations), durationShape(b.sceneDurations)) * 100) },
  { key: 'ctaAnimation', label: 'CTA animation', weight: 0.1, fn: (a, b) => (a.ctaAnimation === b.ctaAnimation ? 100 : 0) },
  { key: 'captionStyle', label: 'Caption style', weight: 0.05, fn: (a, b) => (a.captionStyle === b.captionStyle ? 100 : 0) },
];

/**
 * Compare a candidate video signature against the most recent five videos.
 * Returns 0..100 where 100 means "structurally indistinguishable".
 */
export function computeSimilarity(
  candidate: SignatureInput,
  videoId: string,
  history: VisualHistory,
): SimilarityResult {
  const against = history.videos.filter((v) => v.videoId !== videoId).slice(-5);
  if (against.length === 0) {
    return {
      score: 0,
      against: [],
      factors: [],
      reasons: ['First video recorded in visual_history.json - nothing to compare against yet.'],
      blocking: false,
      threshold: SIMILARITY_THRESHOLD,
    };
  }

  const perVideo = against.map((v) => {
    let total = 0;
    let wsum = 0;
    const factors: SimilarityFactor[] = [];
    for (const w of WEIGHTS) {
      const s = clamp(w.fn(candidate, v));
      total += s * w.weight;
      wsum += w.weight;
      factors.push({ label: w.label, weight: w.weight, score: Math.round(s), detail: `${Math.round(s)}% match on ${w.label.toLowerCase()}` });
    }
    return { videoId: v.videoId, topic: v.topic, score: clamp(total / (wsum || 1)), factors };
  });

  const worst = perVideo.reduce((a, b) => (b.score > a.score ? b : a));
  const factors = WEIGHTS.map((w) => {
    const f = worst.factors.find((x) => x.label === w.label);
    return f!;
  });

  const score = Math.round(worst.score);
  const reasons = factors
    .filter((f) => f.score >= 55)
    .sort((a, b) => b.score * b.weight - a.score * a.weight)
    .map((f) => `${f.label} is ${f.score}% similar to "${worst.topic}" (${worst.videoId})`);

  return {
    score,
    against: perVideo.map((p) => ({ videoId: p.videoId, topic: p.topic, score: Math.round(p.score) })),
    factors,
    reasons: reasons.length ? reasons : [`No dominant similarity factor against "${worst.topic}"`],
    blocking: score > SIMILARITY_THRESHOLD,
    threshold: SIMILARITY_THRESHOLD,
  };
}

export function appendHistory(history: VisualHistory, entry: HistoryEntry): VisualHistory {
  const next: VisualHistory = { version: history.version ?? 1, videos: [...history.videos.filter((v) => v.videoId !== entry.videoId), entry] };
  return next;
}

/**
 * Re-score a video AFTER the operator has edited scenes.
 *
 * The similarity gate must reflect what will actually be rendered, not the
 * first generated draft. This rebuilds the signature from the live storyboard
 * and re-runs the same weighted comparison against the last five videos.
 */
export function recomputeSimilarity(
  storyboard: {
    long: { scenes: { variant: string; background: string; transitionIn: string; textPosition: string; accent: string; duration: number }[] };
    shorts: { hookVariant: HookVariantId; scenes: { variant: string }[] }[];
  },
  entry: HistoryEntry,
  videoId: string,
  history: VisualHistory,
): SimilarityResult {
  const scenes = storyboard.long.scenes;
  const live: SignatureInput = {
    hookVariant: entry.hookVariant,
    sceneOrder: scenes.map((s) => s.variant) as HistoryEntry['sceneOrder'],
    backgrounds: scenes.map((s) => s.background) as HistoryEntry['backgrounds'],
    transitions: scenes.map((s) => s.transitionIn) as HistoryEntry['transitions'],
    textPositions: scenes.map((s) => s.textPosition) as HistoryEntry['textPositions'],
    accents: scenes.map((s) => s.accent) as HistoryEntry['accents'],
    sceneDurations: scenes.map((s) => s.duration),
    ctaAnimation: entry.ctaAnimation,
    captionStyle: entry.captionStyle,
  };
  return computeSimilarity(live, videoId, history);
}
