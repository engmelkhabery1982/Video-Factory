import { DiversityEngine } from './diversity.js';
import { computeSimilarity } from './history.js';
import { getBrandPreset } from './brand.js';
import { VARIANT_LIBRARY, explanationById, transitionFrames } from './variants.js';
import { buildCues, linkCuesToScenes } from './captions.js';
import { condense, shortHeadline, stripTrailing } from './util.js';
import { analyzeScript, type ScriptAnalysis, type DetectedSegment } from './analyze.js';
import type {
  BrandPreset,
  CaptionCue,
  ExplanationVariantId,
  HistoryEntry,
  HookVariantId,
  ProjectInput,
  Scene,
  SceneContent,
  ShortPlan,
  Storyboard,
  VisualHistory,
} from './types.js';

export interface BuildOptions {
  input: ProjectInput;
  history: VisualHistory;
  /** real voiceover duration in seconds, if an audio file was uploaded */
  audioDuration?: number | null;
  /** ids of assets the operator uploaded for this project */
  assetIds?: string[];
  hasMedia?: boolean;
  /** reuse a previous storyboard's scene order where scenes are locked */
  previous?: Storyboard | null;
}

const WORDS_PER_MINUTE = 155;

function estimateDuration(words: number): number {
  return (words / WORDS_PER_MINUTE) * 60;
}

function clampDuration(d: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, d));
}

function titleCase(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Words that cannot end a headline without leaving it sounding broken. */
const DANGLING = /^(a|an|the|is|are|was|were|be|been|being|to|of|and|or|but|not|that|this|these|those|it|its|as|at|by|for|from|in|into|on|onto|than|then|so|if|when|while|which|who|whom|whose|with|without|your|our|my)$/i;

/**
 * A headline cut on a real linguistic boundary, never at an arbitrary word
 * count. "That 10.5 percent gap is not a rounding error" must not become
 * "That 10.5 percent gap is not a", which is exactly what a naive word slice
 * produces - and exactly the kind of clipped title the reference videos had.
 *
 * Order of preference:
 *   1. a complete sentence, if one fits the budget;
 *   2. a clause that ends on a full word (split at , ; : and conjunctions);
 *   3. the longest prefix that does not end on a dangling function word.
 * A dot between digits is a decimal point, never a sentence boundary.
 */
/**
 * The sub line is usually the same sentence the headline was cut from, so a
 * naive render printed the headline twice: "That 10.5 percent gap" directly
 * above "That 10.5 percent gap is not a rounding error". If the sub line merely
 * restates the headline, drop that shared prefix and keep only the part that
 * adds information - or suppress the sub line entirely if nothing is left.
 */
function dropHeadlineEcho(sub: string, headline: string): string | undefined {
  if (!sub) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
  const h = norm(headline ?? '');
  if (!h) return sub;

  // same wording all the way through - nothing left to say
  if (norm(sub) === h) return undefined;

  // If the sub line restates the headline, prefer the *next* whole sentence so
  // the two lines are genuinely different. Cutting mid-sentence ("Error. It is
  // a commercial risk...") is worse than the repetition it fixes. A dot between
  // digits is a decimal point, never a sentence boundary.
  const sentences = sub
    .split(/(?<![\d])[.!?]+\s+(?=[A-Z0-9"])|\s*\.\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length > 1) {
    const later = sentences.find((s) => !norm(s).startsWith(h.slice(0, Math.min(h.length, 18))));
    if (later) return later;
  }

  // otherwise strip the repeated leading clause
  const words = sub.split(' ');
  const hWords = h.split(' ').length;
  for (let take = hWords; take > 0; take--) {
    if (norm(words.slice(0, take).join(' ')) === h) {
      const rest = words.slice(take).join(' ').replace(/^[^A-Za-z0-9]+/, '');
      if (rest.split(' ').length < 4) return undefined;
      return rest.charAt(0).toUpperCase() + rest.slice(1);
    }
  }
  return sub;
}

function firstSentence(s: string, maxWords = 9): string {  const text = s.replace(/\s+/g, ' ').trim();
  const words = text.split(' ');
  if (words.length <= maxWords) return stripTrailing(text);

  // 1. a complete sentence inside the budget
  const sentence = text.match(new RegExp(`^(?:[.!?](?![\\d])|[^.!?\\d])*?[.!?](?![\\s]?\\d)`));
  if (sentence && sentence[0].trim().split(' ').length <= maxWords) return stripTrailing(sentence[0]);

  // 2. break at the last clause boundary inside the budget
  const budget = words.slice(0, maxWords).join(' ');
  const parts = budget.split(/(,|;|:|\s-\s|\band\b|\bbut\b|\bwhich\b|\bthat\b|\bbecause\b|\bso\b)/i);
  // walk back to the last boundary that leaves a substantial clause
  for (let end = parts.length - 2; end >= 0; end -= 2) {
    const candidate = parts.slice(0, end + 1).join('').trim();
    if (candidate.split(' ').length >= 4) return stripTrailing(candidate);
  }

  // 3. longest prefix that does not end on a dangling word
  const head = words.slice(0, maxWords);
  while (head.length > 3 && DANGLING.test(head[head.length - 1])) head.pop();
  return stripTrailing(head.join(' '));
}

/** Pull the two most meaningful figures out of a segment for comparison scenes. */
function statsOf(seg: DetectedSegment, input: ProjectInput): { stat: string | null; stat2: string | null; label: string | null; label2: string | null } {
  const nums = seg.numbers;
  if (nums.length >= 2) {
    return { stat: nums[0], stat2: nums[1], label: null, label2: null };
  }
  if (nums.length === 1) {
    return { stat: nums[0], stat2: null, label: null, label2: null };
  }
  if (input.keyNumbers.length >= 2) {
    return { stat: input.keyNumbers[0], stat2: input.keyNumbers[1], label: null, label2: null };
  }
  if (input.keyNumbers.length === 1) {
    return { stat: input.keyNumbers[0], stat2: null, label: null, label2: null };
  }
  return { stat: null, stat2: null, label: null, label2: null };
}

function buildContent(
  seg: DetectedSegment,
  variant: ExplanationVariantId | HookVariantId,
  input: ProjectInput,
  override?: Partial<SceneContent>,
): SceneContent {
  const { stat, stat2, label, label2 } = statsOf(seg, input);
  const headline = titleCase(firstSentence(seg.text, 8)).replace(/[.!?]$/, '');
  // A hard `slice(0, 150)` cut mid-word ("the value is n"). Trim to whole
  // sentences that fit, then to a whole clause, then to whole words.
  const subline = seg.text.length > 60 ? dropHeadlineEcho(condense(titleCase(seg.text), 22, 150), headline) : undefined;
  // NOTE: split on sentence punctuation only when it is NOT part of a decimal.
  const clauses = seg.text
    .split(/(?<![\d])[.;:]\s+|\s*\.\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
  const items =
    input.keyPoints.length > 0 && seg.fn === 'steps' ? input.keyPoints.slice(0, 4) : clauses.slice(0, 4);

  const base: SceneContent = {
    headline,
    subline,
    items: items.length ? items : input.keyPoints.slice(0, 3),
    stat,
    statLabel: label,
    stat2,
    statLabel2: label2,
    takeaway: seg.fn === 'warning' ? 'This is where most projects lose control.' : null,
  };

  // hook-specific content
  if (variant === 'surprising_number') {
    base.headline = stat ? `${stat}` : base.headline;
    base.subline = input.topic;
  }
  if (variant === 'question') {
    base.headline = seg.text.trim().replace(/^.*?\?/, (m) => m).slice(0, 90);
  }
  if (variant === 'before_after') {
    base.headline = stat && stat2 ? `${stat}  vs  ${stat2}` : base.headline;
  }
  if (variant === 'common_mistake' || variant === 'risk_warning') {
    base.headline = firstSentence(seg.text, 7).replace(/[.!?]$/, '');
  }
  if (variant === 'product_result') {
    base.headline = stat ? `${stat}` : input.productName;
    base.subline = input.viewerPromise || input.topic;
  }
  if (variant === 'document_zoom') {
    base.headline = titleCase(input.mainProblem).slice(0, 60) || base.headline;
  }
  if (variant === 'scenario_story') {
    base.headline = firstSentence(seg.text, 7).replace(/[.!?]$/, '');
  }

  if (TWO_SIDED.has(variant)) {
    base.items = ensureDistinctSides(base, input);
    // A myth/reality layout prints the literal words MYTH and REALITY. Only
    // call it that when the beat really is a myth - otherwise a plain
    // comparison was captioned with a label that misdescribes it.
    base.sideLabels =
      seg.fn === 'myth'
        ? ['MYTH', 'REALITY']
        : variant === 'number_comparison'
          ? [label ?? 'THIS', label2 ?? 'THAT']
          : ['CLAIM', 'EVIDENCE'];
  }
  if (variant === 'process_flow') {
    base.items = ensureFlowSteps(base, input);
  }

  // Merge only values that are actually provided: an explicit `undefined` in an
  // override must not wipe the derived headline.
  const merged: SceneContent = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  }
  if (TWO_SIDED.has(variant)) merged.items = ensureDistinctSides(merged, input);
  if (TWO_SIDED.has(variant) && !merged.sideLabels) merged.sideLabels = base.sideLabels;
  if (variant === 'process_flow') merged.items = ensureFlowSteps(merged, input);
  return merged;
}

/**
 * A process flow with one or two steps is not a flow - it is a bullet list in
 * disguise, and it leaves the frame looking empty. Pad from the rest of the
 * script so the layout always has at least three real steps to show.
 */
function ensureFlowSteps(base: SceneContent, input: ProjectInput): string[] {
  const items = base.items.filter(Boolean);
  if (items.length >= 3) return items.slice(0, 5);

  const seen = new Set(items.map((s) => s.toLowerCase().slice(0, 28)));
  const pool = [
    ...input.keyPoints,
    ...(base.subline ? [base.subline] : []),
    ...(base.takeaway ? [base.takeaway] : []),
  ].filter((s) => s && !seen.has(s.toLowerCase().slice(0, 28)));

  const out = [...items];
  for (const s of pool) {
    out.push(condense(s, 9, 62));
    if (out.length >= 4) break;
  }
  return out.slice(0, 5);
}

/** Variants that present a pair of contrasting ideas and need two different sides. */
const TWO_SIDED = new Set([
  'split_screen',
  'myth_vs_reality',
  'number_comparison',
  'before_after',
  'problem_cause_solution',
]);

/**
 * A two-sided layout must never print the same sentence twice: showing the same
 * line on the left and on the right is the single most obvious "template" tell.
 * When a beat only yields one clause, the second side is derived from the other
 * available material (sub line, takeaway, key points, the paired number) and is
 * shortened so the two sides read as a genuine contrast rather than a repeat.
 */
function ensureDistinctSides(base: SceneContent, input: ProjectInput): string[] {
  const items = base.items.filter(Boolean);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%\.]+/g, ' ').trim();

  const pool: string[] = [
    ...items.slice(1),
    ...(base.subline ? [base.subline] : []),
    ...(base.takeaway ? [base.takeaway] : []),
    ...input.keyPoints,
  ].filter((s) => s && norm(s) !== norm(items[0] ?? ''));

  const first = items[0] ?? base.headline;
  if (items.length >= 2 && norm(items[0]) !== norm(items[1])) return items.slice(0, 3);

  const second = pool[0];
  if (!second) {
    // last resort: pair the two numbers so the layout still contrasts something
    if (base.stat && base.stat2) return [`${base.stat} ${base.statLabel ?? ''}`.trim(), `${base.stat2} ${base.statLabel2 ?? ''}`.trim()];
    return [first, condense(base.headline === first ? base.subline || base.takeaway || '' : base.headline, 8, 50)];
  }
  return [first, condense(second, 10, 70)];
}

function nextId(prefix: string, n: number): string {
  return `${prefix}_${String(n).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* LONG VIDEO (brief section 9)                                       */
/* ------------------------------------------------------------------ */

interface SceneOpts {
  role: Scene['role'];
  section: string;
  variant: Scene['variant'];
  narration: string;
  duration: number;
  content: SceneContent;
  startTime: number;
  index: number;
  idPrefix: string;
  isShort: boolean;
}

function buildLongStoryboard(
  analysis: ScriptAnalysis,
  input: ProjectInput,
  brand: BrandPreset,
  engine: DiversityEngine,
  hasMedia: boolean,
  audioDuration: number | null,
  opts: BuildOptions,
): { scenes: Scene[]; hookVariant: HookVariantId; warnings: string[] } {
  const warnings: string[] = [];
  const scenes: Scene[] = [];
  let t = 0;
  let idx = 0;

  const estTotal = audioDuration ?? estimateDuration(analysis.estimatedWords);
  // Body beats target 5-8s of visual evolution each.
  const bodyBudget = Math.max(0, estTotal - 6 - 6 - 7 - 8); // hook, promise, summary, cta
  const bodySegments = analysis.segments.filter((s) => !['cta', 'summary'].includes(s.fn));
  const bodyWords = bodySegments.reduce((a, s) => a + s.words, 0) || 1;
  const targetBeats = clampDuration(bodyBudget / 6.5, 3, Math.max(3, Math.ceil(bodySegments.length || 3)));

  /* ---- 1. HOOK (5-8s) ---- */
  const hookSource =
    analysis.segments.find((s) => s.fn === 'question' || s.fn === 'comparison' || s.fn === 'warning') ??
    analysis.segments[0] ??
    ({ index: 0, text: input.hook || input.topic, fn: 'hook' as const, confidence: 1, evidence: 'operator supplied hook field', numbers: [], words: 8 } as DetectedSegment);

  const hookPick = engine.selectHook(hookSource.fn === 'hook' ? 'hook' : hookSource.fn);
  const hookDuration = clampDuration(audioDuration ? Math.min(8, Math.max(5, estTotal * 0.08)) : 6, 5, 8);
  const hookContent = buildContent(hookSource, hookPick.id, input, {
    headline: hookPick.id === 'question' ? condense(titleCase(input.hook || hookSource.text), 12, 66) : undefined,
  });
  const hookBg = engine.selectBackground(['full_typography', 'dark_grid', 'split_visual'], hookDuration, hasMedia);
  const hookTr = engine.selectTransition(false);
  engine.registerScene(hookPick.id, hookBg.id, hookTr.id, hookDuration);
  engine.resetBackgroundRun(hookBg.id);
  scenes.push({
    id: nextId('lng', idx + 1),
    index: idx,
    role: 'hook',
    section: 'Hook',
    variant: hookPick.id,
    background: hookBg.id,
    transitionIn: hookTr.id,
    textPosition: engine.selectTextPosition(false),
    accent: engine.selectAccent(brand.id),
    duration: hookDuration,
    startTime: Number(t.toFixed(3)),
    narration: hookSource.text,
    captionIds: [],
    content: hookContent,
    assetIds: [],
    reason: {
      detected: `hook function = ${hookSource.fn}`,
      evidence: hookPick.reason,
      notUsedRecently: engine.usageSnapshot ? [] : [],
      alternatives: hookPick.alternatives,
    },
    locked: false,
    userEdited: false,
  });
  t += hookDuration;
  idx++;

  /* ---- 2. PROMISE ---- */
  const promiseSource: DetectedSegment = {
    index: -1,
    text: input.viewerPromise || `By the end of this video you will be able to ${input.mainProblem || input.topic}.`,
    fn: 'promise',
    confidence: 1,
    evidence: 'viewer promise field supplied by the operator',
    numbers: [],
    words: 16,
  };
  const promisePick = engine.selectExplanation('promise', 'the operator supplied a viewer promise, which needs a fast, concrete on-screen contract', {});
  const promiseDuration = clampDuration(5.5, 4, 7);
  const promiseBg = engine.selectBackground(['light_technical', 'dark_grid', 'blueprint'], promiseDuration, hasMedia);
  const promiseTr = engine.selectTransition(false);
  engine.registerScene(promisePick.id, promiseBg.id, promiseTr.id, promiseDuration);
  engine.resetBackgroundRun(promiseBg.id);
  scenes.push({
    id: nextId('lng', idx + 1),
    index: idx,
    role: 'body',
    section: 'The Promise',
    variant: promisePick.id,
    background: promiseBg.id,
    transitionIn: promiseTr.id,
    textPosition: engine.selectTextPosition(false),
    accent: engine.selectAccent(brand.id),
    duration: promiseDuration,
    startTime: Number(t.toFixed(3)),
    narration: promiseSource.text,
    captionIds: [],
    content: {
      headline: input.viewerPromise ? condense(titleCase(input.viewerPromise), 13, 66) : 'What you will get',
      subline: input.topic,
      items: input.keyPoints.slice(0, 3),
      stat: null,
      statLabel: null,
      stat2: null,
      statLabel2: null,
      takeaway: null,
    },
    assetIds: [],
    reason: { detected: 'promise beat', evidence: promisePick.reason, notUsedRecently: [], alternatives: promisePick.alternatives },
    locked: false,
    userEdited: false,
  });
  t += promiseDuration;
  idx++;

  /* ---- 3. BODY (grouped into 5-8s beats) ---- */
  const groups: DetectedSegment[][] = [];
  let acc: DetectedSegment[] = [];
  let accWords = 0;
  for (const seg of bodySegments) {
    acc.push(seg);
    accWords += seg.words;
    const share = accWords / bodyWords;
    if (acc.length >= 1 && (accWords / WORDS_PER_MINUTE) * 60 >= 6.5 && groups.length < targetBeats - 1) {
      groups.push(acc);
      acc = [];
      accWords = 0;
    }
  }
  if (acc.length) groups.push(acc);
  if (groups.length === 0) groups.push([bodySegments[0] ?? promiseSource]);

  // group by dominant function so the whole group shares a narrative role
  const grouped = groups.map((g) => {
    const counts = new Map<string, number>();
    for (const s of g) counts.set(s.fn, (counts.get(s.fn) ?? 0) + 1);
    let bestFn = g[0].fn;
    let bestN = 0;
    for (const [k, v] of counts) if (v > bestN) {
      bestFn = k as DetectedSegment['fn'];
      bestN = v;
    }
    return { segs: g, fn: bestFn as DetectedSegment['fn'], evidence: g.map((s) => s.evidence)[0] };
  });

  // a product-proof beat is injected where the problem is described
  const problemIdx = grouped.findIndex((g) => g.fn === 'warning' || g.fn === 'myth' || g.fn === 'comparison');
  const insertProofAt = problemIdx >= 0 ? problemIdx : Math.min(1, grouped.length - 1);

  // When a real voiceover exists, the body beats are distributed to fill the
  // remaining runtime in proportion to their word count, so picture and voice
  // stay locked. Without audio we fall back to the 155 wpm estimate.
  const bodyBeats = grouped.map((g) => g.segs.reduce((a, s) => a + s.words, 0));
  const bodyWordsTotal = bodyBeats.reduce((a, b) => a + b, 0) || 1;
  const PROOF_SEC = 5.5;
  const plannedBody = grouped.length * 6.5;
  const availableBody = audioDuration ? Math.max(9, audioDuration - 6 - 5.5 - 6 - 7 - PROOF_SEC) : plannedBody;
  // Brief section 9 asks for a visual change every 5-8s. A long beat used to
  // be allowed up to 11s, which is exactly the "static slide" failure. The cap
  // is 8.2s; a beat with too many words for that gets its own follow-up scene
  // rather than being held on screen.
  const durFor = (words: number, _fallback: number) => {
    if (!audioDuration) return clampDuration(estimateDuration(words), 5, 8);
    return clampDuration((words / bodyWordsTotal) * availableBody, 3.4, 8.2);
  };

  grouped.forEach((g, gi) => {
    const primary = g.segs[0];
    const narration = g.segs.map((s) => s.text).join(' ');
    const duration = durFor(bodyBeats[gi], 0);
    const pick = engine.selectExplanation(g.fn, g.evidence, { hasMedia });
    if (!pick.fits) warnings.push(`Scene ${gi + 3}: no scene variant structurally fits a "${g.fn}" beat - review this section manually.`);
    if (pick.capped) warnings.push(`Scene ${gi + 3}: every structural variant for "${g.fn}" was already used twice in this video, so this beat repeats - change it manually.`);

    const content = buildContent(primary, pick.id, input);
    content.headline = condense(content.headline, 13, 62);
    if (pick.id === 'progressive_table') {
      // brief section 9: never show a full table in small type - only the row in focus
      content.items = content.items.slice(0, 3);
      content.subline = 'Row by row - the rest stays off screen until it is explained.';
    }

    const bg = engine.selectBackground(explanationById(pick.id).prefers, duration, hasMedia);
    const tr = engine.selectTransition(!!content.stat && !!content.stat2);
    engine.registerScene(pick.id, bg.id, tr.id, duration);
    engine.resetBackgroundRun(bg.id);
    scenes.push({
      id: nextId('lng', scenes.length + 1),
      index: scenes.length,
      role: 'body',
      section: sectionNameFor(g.fn, gi, grouped.length),
      variant: pick.id,
      background: bg.id,
      transitionIn: tr.id,
      textPosition: engine.selectTextPosition(false),
      accent: engine.selectAccent(brand.id),
      duration: Number(duration.toFixed(2)),
      startTime: Number(t.toFixed(3)),
      narration,
      captionIds: [],
      content,
      assetIds: [],
      reason: { detected: `script function = ${g.fn}`, evidence: pick.reason, notUsedRecently: [], alternatives: pick.alternatives },
      locked: false,
      userEdited: false,
    });
    t += duration;
  });

  /* ---- 4. PRODUCT PROOF inside the content ---- */
  if (input.productName) {
    const proofSource: DetectedSegment = {
      index: -1,
      text: `${input.productName} shows the live position, not a spreadsheet guess: ${input.mainProblem || input.topic}.`,
      fn: 'product_proof',
      confidence: 1,
      evidence: 'product proof must appear where the problem is described, not only in the final second',
      numbers: [],
      words: 18,
    };
    const pick = engine.selectExplanation('product_proof', proofSource.evidence, { hasMedia });
    const duration = 5.5;
    const content = buildContent(proofSource, pick.id, input, {
      headline: input.productName,
      subline: input.viewerPromise || input.topic,
    });
    const bg = engine.selectBackground(explanationById(pick.id).prefers, duration, hasMedia);
    const tr = engine.selectTransition(false);
    engine.registerScene(pick.id, bg.id, tr.id, duration);
    engine.resetBackgroundRun(bg.id);
    const at = Math.min(insertProofAt + 1, scenes.length);
    const scene: Scene = {
      id: nextId('lng', scenes.length + 1),
      index: 0,
      role: 'body',
      section: 'Proof',
      variant: pick.id,
      background: bg.id,
      transitionIn: tr.id,
      textPosition: engine.selectTextPosition(false),
      accent: engine.selectAccent(brand.id),
      duration,
      startTime: 0,
      narration: proofSource.text,
      captionIds: [],
      content,
      assetIds: (opts.assetIds ?? []).slice(0, 1),
      reason: { detected: 'product proof beat', evidence: pick.reason, notUsedRecently: [], alternatives: pick.alternatives },
      locked: false,
      userEdited: false,
    };
    scenes.splice(at, 0, scene);
    void t;
  }

  /* ---- 5. EXACTLY ONE SUMMARY ---- */
  const summarySource =
    analysis.segments.find((s) => s.fn === 'summary') ??
    ({
      index: -1,
      text: `In short: ${input.keyPoints.slice(0, 3).join('; ') || input.viewerPromise || input.topic}.`,
      fn: 'summary',
      confidence: 1,
      evidence: 'exactly one summary block, never repeated',
      numbers: [],
      words: 20,
    } as DetectedSegment);
  const sumPick = engine.selectExplanation('summary', summarySource.evidence, {});
  const sumDuration = 6;
  const sumBg = engine.selectBackground(['light_technical', 'dark_grid', 'full_typography'], sumDuration, hasMedia);
  const sumTr = engine.selectTransition(false);
  engine.registerScene(sumPick.id, sumBg.id, sumTr.id, sumDuration);
  engine.resetBackgroundRun(sumBg.id);
  const sumContent = buildContent(summarySource, sumPick.id, input, {
    headline: 'The takeaway',
    items: input.keyPoints.length ? input.keyPoints.slice(0, 4) : sumContentItems(summarySource.text),
  });
  scenes.push({
    id: nextId('lng', scenes.length + 1),
    index: scenes.length,
    role: 'summary',
    section: 'Summary',
    variant: sumPick.id,
    background: sumBg.id,
    transitionIn: sumTr.id,
    textPosition: engine.selectTextPosition(false),
    accent: engine.selectAccent(brand.id),
    duration: sumDuration,
    startTime: 0,
    narration: summarySource.text,
    captionIds: [],
    content: sumContent,
    assetIds: [],
    reason: { detected: 'summary beat (single occurrence)', evidence: sumPick.reason, notUsedRecently: [], alternatives: sumPick.alternatives },
    locked: false,
    userEdited: false,
  });

  /* ---- 6. CTA (6-8s) + end-screen reserve ---- */
  const ctaPick = engine.selectCtaAnimation();
  const ctaDuration = 7;
  scenes.push({
    id: nextId('lng', scenes.length + 1),
    index: scenes.length,
    role: 'cta',
    section: 'Call to action',
    variant: 'cta_card',
    background: 'dark_grid',
    transitionIn: engine.selectTransition(false).id,
    textPosition: 'left_column',
    accent: engine.selectAccent(brand.id),
    duration: ctaDuration,
    startTime: 0,
    narration: input.cta,
    captionIds: [],
    content: {
      headline: condense(input.cta, 13, 66),
      subline: input.productName,
      items: [],
      stat: null,
      statLabel: null,
      stat2: null,
      statLabel2: null,
      takeaway: null,
    },
    assetIds: [],
    reason: {
      detected: 'CTA beat',
      evidence: `${ctaPick.reason} CTA is placed once, at the end, lasting ${ctaDuration}s, with the last 8s of the frame kept clear for YouTube end-screen elements.`,
      notUsedRecently: [],
      alternatives: [],
    },
    locked: false,
    userEdited: false,
  });

  return { scenes, hookVariant: hookPick.id, warnings };
}

function content_stat(seg: DetectedSegment, input: ProjectInput): string | null {
  if (seg.numbers.length) return seg.numbers[0];
  if (input.keyNumbers.length) return input.keyNumbers[0];
  return null;
}

function sumContentItems(text: string): string[] {
  return text
    .split(/(?<![\d])[.;:]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8)
    .slice(0, 4);
}

function sectionNameFor(fn: string, i: number, total: number): string {
  const map: Record<string, string> = {
    question: 'The problem',
    comparison: 'The gap',
    steps: 'Method',
    timeline: 'Sequence',
    table: 'The data',
    warning: 'Risk',
    product_proof: 'Proof',
    data: 'Evidence',
    example: 'In practice',
    myth: 'Myth check',
    promise: 'Promise',
  };
  const base = map[fn] ?? `Part ${i + 1}`;
  return total > 6 ? `${base} (${Math.floor((i / total) * 3) + 1}/3)` : base;
}

/* ------------------------------------------------------------------ */
/* SHORTS (brief section 10) - native 9:16, built from the idea         */
/* ------------------------------------------------------------------ */

interface ShortSpec {
  id: 'short_1' | 'short_2' | 'short_3';
  angle: ShortPlan['angle'];
  fn: DetectedSegment['fn'];
  title: string;
}

function shortSpecs(analysis: ScriptAnalysis, input: ProjectInput): ShortSpec[] {
  const pick = (fns: DetectedSegment['fn'][]) => analysis.segments.find((s) => fns.includes(s.fn)) ?? null;
  const q = pick(['question', 'warning', 'myth']);
  const c = pick(['comparison', 'data', 'table']);
  const m = pick(['example', 'steps', 'product_proof']);

  const base: ShortSpec[] = [
    { id: 'short_1', angle: 'question_problem', fn: 'question', title: 'The question / problem' },
    { id: 'short_2', angle: 'number_comparison', fn: 'comparison', title: 'The number / comparison' },
    { id: 'short_3', angle: 'mistake_warning_result', fn: 'warning', title: 'The mistake / warning / result' },
  ];
  return base.map((spec, i) => {
    const src = [q, c, m][i];
    return { ...spec, fn: src ? src.fn : spec.fn };
  });
}

function buildShort(
  spec: ShortSpec,
  analysis: ScriptAnalysis,
  input: ProjectInput,
  brand: BrandPreset,
  engine: DiversityEngine,
  hasMedia: boolean,
  usedHook: HookVariantId,
  bannedHooks: HookVariantId[],
): { plan: ShortPlan; hook: HookVariantId } {
  const warnings: string[] = [];
  const source =
    analysis.segments.find((s) => s.fn === spec.fn) ??
    analysis.segments[
      spec.id === 'short_1' ? 0 : spec.id === 'short_2' ? Math.min(1, analysis.segments.length - 1) : Math.max(0, analysis.segments.length - 2)
    ] ??
    ({ index: 0, text: input.topic, fn: spec.fn, confidence: 0.5, evidence: 'topic only', numbers: [], words: 8 } as DetectedSegment);

  const hookPick = engine.selectHook(spec.fn, bannedHooks);
  const banned = [...bannedHooks, hookPick.id];

  const scenes: Scene[] = [];
  let t = 0;

  /* hook: complete and readable within the first 2 seconds */
  const hookText =
    spec.angle === 'number_comparison'
      ? `${input.keyNumbers[0] ?? source.numbers[0] ?? '—'} vs ${input.keyNumbers[1] ?? source.numbers[1] ?? '—'}`
      : spec.angle === 'question_problem'
        ? titleCase(input.hook || source.text).slice(0, 72)
        : titleCase((input.keyPoints[0] ?? source.text)).slice(0, 72);

  const hookContent: SceneContent = {
    headline: condense(hookText, 8, 50),
    subline: input.topic,
    items: [],
    stat: spec.angle === 'number_comparison' ? (input.keyNumbers[0] ?? null) : null,
    statLabel: null,
    stat2: spec.angle === 'number_comparison' ? (input.keyNumbers[1] ?? null) : null,
    statLabel2: null,
    takeaway: null,
  };

  const hookDuration = 2.6;
  const hookBg = engine.selectBackground(['full_typography', 'split_visual', 'dark_grid'], hookDuration, hasMedia);
  const hookTr = engine.selectTransition(false);
  engine.registerScene(hookPick.id, hookBg.id, hookTr.id, hookDuration);
  engine.resetBackgroundRun(hookBg.id);
  scenes.push({
    id: `${spec.id}_s01`,
    index: 0,
    role: 'hook',
    section: 'Hook',
    variant: hookPick.id,
    background: hookBg.id,
    transitionIn: hookTr.id,
    textPosition: 'center',
    accent: engine.selectAccent(brand.id),
    duration: hookDuration,
    startTime: 0,
    narration: source.text,
    captionIds: [],
    content: hookContent,
    assetIds: [],
    reason: {
      detected: `short angle = ${spec.angle}`,
      evidence: `${hookPick.reason} Short hooks are re-chosen per short so the three shorts never share an opening animation.`,
      notUsedRecently: [],
      alternatives: hookPick.alternatives,
    },
    locked: false,
    userEdited: false,
  });
  t += hookDuration;

  /* body: ONE idea, but several beats, visual change every 1.5-3s, native 9:16.
     Beats are drawn from every script segment relevant to this angle, not from
     the long timeline - a short is its own native vertical project. */
  const ANGLE_FNS: Record<ShortSpec['angle'], DetectedSegment['fn'][]> = {
    question_problem: ['question', 'warning', 'myth', 'comparison'],
    number_comparison: ['comparison', 'data', 'table', 'question'],
    mistake_warning_result: ['warning', 'example', 'steps', 'product_proof', 'myth'],
  };
  const wanted = ANGLE_FNS[spec.angle];
  const relevant = analysis.segments.filter((s) => wanted.includes(s.fn));
  const pool = relevant.length ? relevant : [source];
  // interleave so consecutive beats come from different rhetorical moves
  const ordered = [...pool].sort((a, b) => a.index - b.index);

  const sentenceBeats: { text: string; seg: DetectedSegment }[] = [];
  for (const seg of ordered) {
    for (const sent of seg.text.split(/(?<=[.!?؟])\s+/).map((x) => x.trim()).filter((x) => x.length > 12)) {
      sentenceBeats.push({ text: sent, seg });
      if (sentenceBeats.length >= 11) break;
    }
    if (sentenceBeats.length >= 11) break;
  }
  if (!sentenceBeats.length) sentenceBeats.push({ text: source.text, seg: source });

  // Top-up: an angle with few matching segments must still reach the 20s floor.
  // Only structural "explanatory" segments are used - never the CTA or summary.
  const MIN_BEATS = 8;
  if (sentenceBeats.length < MIN_BEATS) {
    for (const seg of analysis.segments) {
      if (seg.fn === 'cta' || seg.fn === 'summary') continue;
      if (pool.includes(seg)) continue;
      for (const sent of seg.text.split(/(?<=[.!?؟])\s+/).map((x) => x.trim()).filter((x) => x.length > 12)) {
        sentenceBeats.push({ text: sent, seg });
        if (sentenceBeats.length >= 11) break;
      }
      if (sentenceBeats.length >= 11) break;
    }
  }
  // keep at most 11 beats: 11 x 3s + hook + cta = 38s, trimmed back to <= 35 below
  if (sentenceBeats.length > 11) sentenceBeats.length = 11;

  // target 20-35s: hook (2.6) + cta (2.5) leaves ~19s of body at ~2.2s a beat
  const BODY_BUDGET = 19;
  const perBeatDuration = Number(clampDuration(BODY_BUDGET / sentenceBeats.length, 1.5, 3).toFixed(2));
  const usableBeats = sentenceBeats;

  usableBeats.forEach((b, i) => {
    const seg = b.seg;
    const pick = engine.selectExplanation(seg.fn, seg.evidence, { isShort: true, hasMedia });
    if (!pick.fits) warnings.push(`${spec.id} beat ${i + 1}: no 9:16-native variant structurally fits - review manually.`);
    if (pick.capped) warnings.push(`${spec.id} beat ${i + 1}: every 9:16-safe variant for "${seg.fn}" was already used twice, so this beat repeats - consider changing it.`);
    const content = buildContent({ ...seg, text: b.text }, pick.id, input, {
      // big type for phones: one idea, grammatically complete
      headline: shortHeadline(b.text, { preferNumber: content_stat(seg, input) }),
    });
    if (pick.id === 'progressive_table' || pick.id === 'document_annotation' || pick.id === 'site_footage_callouts') {
      // these are landscape-first layouts; shortsSafe already excluded them,
      // this is a defensive guard so a shrunken landscape slide can never ship
      content.items = content.items.slice(0, 2);
    }
    const bg = engine.selectBackground(
      explanationById(pick.id).prefers.filter((p) => p !== 'site_footage' && p !== 'document_closeup'),
      perBeatDuration,
      hasMedia,
    );
    const tr = engine.selectTransition(!!content.stat && !!content.stat2);
    engine.registerScene(pick.id, bg.id, tr.id, perBeatDuration);
    engine.resetBackgroundRun(bg.id);
    scenes.push({
      id: `${spec.id}_s${String(i + 2).padStart(2, '0')}`,
      index: scenes.length,
      role: 'body',
      section: spec.title,
      variant: pick.id,
      background: bg.id,
      transitionIn: tr.id,
      textPosition: engine.selectTextPosition(true),
      accent: engine.selectAccent(brand.id),
      duration: perBeatDuration,
      startTime: Number(t.toFixed(3)),
      narration: b.text,
      captionIds: [],
      content,
      assetIds: [],
      reason: {
        detected: `short body beat ${i + 1} (${seg.fn})`,
        evidence: `${pick.reason} Laid out natively for 1080x1920 - never a resized landscape frame.`,
        notUsedRecently: [],
        alternatives: pick.alternatives,
      },
      locked: false,
      userEdited: false,
    });
    t += perBeatDuration;
  });

  /* single CTA, 2.5s, kept out of the bottom platform-UI zone */
  const ctaDuration = 2.5;
  scenes.push({
    id: `${spec.id}_s${String(scenes.length + 1).padStart(2, '0')}`,
    index: scenes.length,
    role: 'cta',
    section: 'CTA',
    variant: 'cta_card',
    background: 'dark_grid',
    transitionIn: engine.selectTransition(false).id,
    textPosition: 'center',
    accent: engine.selectAccent(brand.id),
    duration: ctaDuration,
    startTime: Number(t.toFixed(3)),
    narration: input.cta,
    captionIds: [],
    content: {
      // a phone screen cannot carry the full long-form CTA sentence
      headline: condense(input.cta, 6, 42),
      subline: input.productName,
      items: [],
      stat: null,
      statLabel: null,
      stat2: null,
      statLabel2: null,
      takeaway: null,
    },
    assetIds: [],
    reason: {
      detected: 'short CTA',
      evidence: 'Exactly one CTA per short, held high enough on the frame to survive platform UI overlays.',
      notUsedRecently: [],
      alternatives: [],
    },
    locked: false,
    userEdited: false,
  });
  t += ctaDuration;

  if (t > 35) {
    for (let i = 1; i < scenes.length - 1; i++) {
      scenes[i].duration = Number(Math.max(1.5, scenes[i].duration * (35 / t)).toFixed(2));
    }
    let acc = 0;
    for (const s of scenes) {
      s.startTime = Number(acc.toFixed(3));
      acc += s.duration;
    }
    t = acc;
  }

  return {
    plan: { id: spec.id, angle: spec.angle, hookVariant: hookPick.id, scenes, totalDuration: Number(t.toFixed(2)), native: true },
    hook: hookPick.id,
  };
  void usedHook;
}

/* ------------------------------------------------------------------ */
/* Public builder                                                     */
/* ------------------------------------------------------------------ */

export function buildStoryboard(options: BuildOptions): Storyboard & { historyEntry: HistoryEntry } {
  const { input, history } = options;
  const brand = getBrandPreset(input.brandPreset);
  const analysis = analyzeScript(input.script);
  const hasMedia = options.hasMedia ?? (input.productShots.length > 0 || input.brollFiles.length > 0);

  const engine = new DiversityEngine({
    seed: `${input.videoId}::${input.topic}::${input.videoType}`,
    history,
    library: VARIANT_LIBRARY,
  });

  const long = buildLongStoryboard(analysis, input, brand, engine, hasMedia, options.audioDuration ?? null, options);
  const warnings = [...long.warnings];

  // shorts get their own engine state so short-specific rules (native 9:16,
  // per-short hooks) are evaluated on top of the long video's usage counters
  const banned: HookVariantId[] = [long.hookVariant];
  const shorts: ShortPlan[] = [];
  const shortHooks: HookVariantId[] = [];
  for (const spec of shortSpecs(analysis, input)) {
    const built = buildShort(spec, analysis, input, brand, engine, hasMedia, long.hookVariant, banned);
    banned.push(built.hook);
    shortHooks.push(built.hook);
    shorts.push(built.plan);
    warnings.push(...[]);
  }
  const shortCount = Math.max(0, Math.min(3, input.shortCount ?? 3));
  const keptShorts = shorts.slice(0, shortCount);

  /* timing: recompute start times after inserts */
  let acc = 0;
  for (const s of long.scenes) {
    s.index = long.scenes.indexOf(s);
    s.id = nextId('lng', s.index + 1);
    s.startTime = Number(acc.toFixed(3));
    acc += s.duration;
  }
  const longTotal = Number(acc.toFixed(2));

  const captionSource = analysis.segments.map((s) => ({ text: s.text, index: s.index }));
  let cues: CaptionCue[] = buildCues(captionSource, options.audioDuration ?? longTotal, { minCue: 1.6, maxCue: 6 });
  cues = linkCuesToScenes(cues, long.scenes);

  const ctaAnimation = pickCtaAnimationForEntry(long.scenes, history);

  const historyEntry: HistoryEntry = {
    videoId: input.videoId,
    createdAt: new Date().toISOString(),
    topic: input.topic,
    hookVariant: long.hookVariant,
    sceneOrder: long.scenes.map((s) => s.variant),
    backgrounds: long.scenes.map((s) => s.background),
    transitions: long.scenes.map((s) => s.transitionIn),
    textPositions: long.scenes.map((s) => s.textPosition),
    accents: long.scenes.map((s) => s.accent),
    sceneDurations: long.scenes.map((s) => s.duration),
    ctaAnimation,
    captionStyle: engine.selectCaptionStyle(),
    shortHooks,
    shortOrders: keptShorts.map((s) => s.scenes.map((x) => x.variant)),
    assetIds: options.assetIds ?? [],
    thumbConcepts: [],
  };

  const similarity = computeSimilarity(historyEntry, input.videoId, history);
  if (similarity.blocking) {
    warnings.unshift(
      `Visual similarity ${similarity.score}% exceeds the ${similarity.threshold}% gate against "${similarity.against.find((a) => a.score === Math.max(...similarity.against.map((x) => x.score)))?.topic ?? 'a recent video'}" - re-roll the highlighted scenes before exporting.`,
    );
  }

  return {
    videoId: input.videoId,
    createdAt: new Date().toISOString(),
    brand,
    long: { scenes: long.scenes, totalDuration: longTotal, endScreenReserveSeconds: 8 },
    shorts: keptShorts,
    captions: cues,
    segments: analysis.segments.map((s, i) => ({
      index: i,
      start: long.scenes.find((sc) => sc.narration.startsWith(s.text.slice(0, 24)))?.startTime ?? 0,
      end: 0,
      text: s.text,
    })),
    warnings,
    similarity,
    historyEntry,
  };
}

function pickCtaAnimationForEntry(scenes: Scene[], history: VisualHistory): HistoryEntry['ctaAnimation'] {
  const lastTwo = history.videos.slice(-2).map((v) => v.ctaAnimation);
  const options: HistoryEntry['ctaAnimation'][] = ['slide_in', 'typewriter', 'counter_up', 'scale_pop', 'wipe_reveal'];
  const cta = scenes.find((s) => s.role === 'cta');
  if (lastTwo.length === 2 && lastTwo[0] === lastTwo[1]) {
    const pick = options.find((o) => o !== lastTwo[0]);
    if (pick) return pick;
  }
  if (cta) {
    const m = cta.reason.evidence.match(/CTA animation "([a-z_]+)"/);
    if (m) {
      const found = options.find((o) => o === m[1]);
      if (found) return found;
    }
  }
  return options[0];
}
