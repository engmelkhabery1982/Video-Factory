import type { ScriptFunction } from './types.js';

/**
 * Script analysis (brief section 7).
 *
 * The selection engine must never pick a scene at random. This module turns a
 * plain-text script into segments with a detected rhetorical FUNCTION plus the
 * evidence that produced the detection. The evidence string is copied straight
 * into the storyboard reason field so the operator can audit every choice.
 */

export interface DetectedSegment {
  index: number;
  text: string;
  fn: ScriptFunction;
  confidence: number;
  evidence: string;
  numbers: string[];
  /** rough word count, used for duration estimation */
  words: number;
}

export interface ScriptAnalysis {
  segments: DetectedSegment[];
  allNumbers: { value: number; text: string; segment: number }[];
  hasTableLikeContent: boolean;
  hasQuestion: boolean;
  hasWarning: boolean;
  hasTimeline: boolean;
  hasMyth: boolean;
  hasExample: boolean;
  estimatedWords: number;
}

const QUESTION_RE = /(\?\s*$)|(\?\s)/;
const NUMBER_RE = /(?<![\d.])(\d{1,3}(?:[.,]\d+)?\s?%)|(?<![\d.])(\b\d{1,4}(?:[.,]\d+)?\s?(?:k|m|bn|million|billion|x|days?|weeks?|months?|years?|items?|units?)\b)|(?<![\d.])(\b\d{1,4}(?:\.\d+)?\b)/gi;

const STEP_RE = /(^|\s)(step\s*\d|first|second|third|finally|next|then|start by|begin by|1\.|2\.|3\.|4\.|5\.)/i;
const TIME_RE = /\b(week|month|year|quarter|phase\s*\d|stage\s*\d|day\s*\d|january|february|march|april|may|june|july|august|september|october|november|december|q1|q2|q3|q4|20\d\d)\b/i;
const WARNING_RE = /\b(risk|danger|warning|caution|mistake|never|avoid|wrong|ignore|blind spot|watch out|careful|fail|fails|failing|problem|trouble|collapse|delay|penalt)\w*/i;
const MYTH_RE = /\b(myth|actually|in reality|the truth|people think|commonly believed|it is assumed|turns out|contrary)\b/i;
const EXAMPLE_RE = /\b(for example|for instance|let us say|imagine|consider a|suppose|on a real project|case study|in one project|a contractor)\b/i;
const DATA_RE = /\b(percent|percentage|chart|graph|data|measured|reported|statistic|average|median|rate|ratio|index|curve|s-curve)\b/i;
const PRODUCT_RE = /\b(dashboard|report|export|buildtrack|platform|portal|screen|interface|tracker|analytics|project file|auto-?generated)\b/i;
const TABLE_RE = /(\|.*\|)|(\n\s*[-:]{3,}\s*\n)|(\bvs\b)|(\bversus\b)|(\bcompared (to|with)\b)|(\bwhereas\b)/i;
const SUMMARY_RE = /\b(to summaris|to summariz|in summary|recap|tl;?dr|key takeaway|the bottom line|so to wrap|putting it together)\b/i;
const CTA_RE = /\b(subscribe|download|start your|try it|get started|link in the description|comment below|follow us|book a|free trial|request a|sign up|read more)\b/i;
const COMPARE_RE = /\b(vs\.?|versus|compared (to|with)|whereas|instead of|but only|yet only|while .{0,24}\b\d|against|against a)\b/i;

function countNumbers(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  NUMBER_RE.lastIndex = 0;
  while ((m = NUMBER_RE.exec(text)) !== null) {
    const v = m[0].trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function detect(text: string, numbers: string[]): { fn: ScriptFunction; confidence: number; evidence: string } {
  // order matters: the most specific rhetorical move wins
  if (CTA_RE.test(text)) return { fn: 'cta', confidence: 0.9, evidence: 'narration contains a direct call to action' };
  if (SUMMARY_RE.test(text)) return { fn: 'summary', confidence: 0.85, evidence: 'narration signals a recap/summary block' };
  if (MYTH_RE.test(text)) return { fn: 'myth', confidence: 0.85, evidence: 'narration frames a belief versus reality' };
  if (WARNING_RE.test(text)) {
    const hit = text.match(WARNING_RE)?.[0];
    return { fn: 'warning', confidence: 0.8, evidence: `warning language detected ("${hit}")` };
  }
  if (COMPARE_RE.test(text) && numbers.length >= 2) {
    return {
      fn: 'comparison',
      confidence: 0.9,
      evidence: `narration compares two figures (${numbers[0]} vs ${numbers[1]})`,
    };
  }
  if (TIME_RE.test(text) && (STEP_RE.test(text) || /\b(week|month|quarter|phase|stage)\b/i.test(text))) {
    const hit = text.match(TIME_RE)?.[0];
    return { fn: 'timeline', confidence: 0.78, evidence: `narration references a time axis ("${hit}")` };
  }
  if (STEP_RE.test(text)) {
    return { fn: 'steps', confidence: 0.8, evidence: 'narration enumerates steps in order' };
  }
  if (TABLE_RE.test(text) && numbers.length >= 2) {
    return { fn: 'table', confidence: 0.75, evidence: 'narration presents structured rows/columns of data' };
  }
  if (QUESTION_RE.test(text)) {
    return { fn: 'question', confidence: 0.85, evidence: 'narration poses a direct question' };
  }
  if (EXAMPLE_RE.test(text)) {
    return { fn: 'example', confidence: 0.8, evidence: 'narration gives a concrete example' };
  }
  if (PRODUCT_RE.test(text)) {
    return { fn: 'product_proof', confidence: 0.75, evidence: 'narration demonstrates the product / evidence of proof' };
  }
  if (DATA_RE.test(text) || numbers.length >= 1) {
    return {
      fn: 'data',
      confidence: numbers.length ? 0.72 : 0.6,
      evidence: numbers.length ? `narration reports a figure (${numbers[0]})` : 'narration reports data',
    };
  }
  return { fn: 'promise', confidence: 0.4, evidence: 'explanatory narration, no strong signal - default role' };
}

export function splitScript(script: string): string[] {
  const normalised = script.replace(/\r\n/g, '\n').trim();
  if (!normalised) return [];
  const blocks = normalised
    .split(/\n\s*\n+/)
    .map((b) => b.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const block of blocks) {
    // Split very long blocks on sentence boundaries so each scene gets one idea.
    // CRITICAL: a period between two digits is a DECIMAL, not a sentence end.
    // "executed 70%, accepted 59.5%" must never become "59." + "5%".
    const sentences = block
      .split(/(?<=[.!?؟])[\u2010-\u2015]?[\s"')]+|(?<=[.!?؟])$/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!sentences.length) continue;
    if (sentences.length <= 2) {
      out.push(block);
      continue;
    }
    let buf = '';
    for (const s of sentences) {
      const t = s.trim();
      if (!t) continue;
      if (buf && (buf + ' ' + t).split(/\s+/).length > 42) {
        out.push(buf);
        buf = t;
      } else {
        buf = buf ? `${buf} ${t}` : t;
      }
    }
    if (buf) out.push(buf);
  }
  return out.filter((s) => s.replace(/[^\p{L}\p{N}]/gu, '').length > 0);
}

export function analyzeScript(script: string): ScriptAnalysis {
  const chunks = splitScript(script);
  const segments: DetectedSegment[] = chunks.map((text, index) => {
    const numbers = countNumbers(text);
    const d = detect(text, numbers);
    return {
      index,
      text,
      fn: d.fn,
      confidence: d.confidence,
      evidence: d.evidence,
      numbers,
      words: text.split(/\s+/).filter(Boolean).length,
    };
  });

  const allNumbers: ScriptAnalysis['allNumbers'] = [];
  segments.forEach((s) => {
    s.numbers.forEach((t) => {
      const num = Number.parseFloat(t.replace(/[^0-9.,]/g, '').replace(',', '.'));
      if (Number.isFinite(num)) allNumbers.push({ value: num, text: t, segment: s.index });
    });
  });

  return {
    segments,
    allNumbers,
    hasTableLikeContent: segments.some((s) => s.fn === 'table'),
    hasQuestion: segments.some((s) => s.fn === 'question'),
    hasWarning: segments.some((s) => s.fn === 'warning'),
    hasTimeline: segments.some((s) => s.fn === 'timeline'),
    hasMyth: segments.some((s) => s.fn === 'myth'),
    hasExample: segments.some((s) => s.fn === 'example'),
    estimatedWords: segments.reduce((a, s) => a + s.words, 0),
  };
}
