import type { CaptionCue, AudioSegment } from './types.js';

/**
 * Captions (brief section 11).
 *
 * The MVP must run fully offline with no paid TTS/STT. We therefore align the
 * *known script text* to the *known audio duration* using a duration-weighted
 * word/char model, then let the operator correct words before export. If a
 * local whisper.cpp binary is present the API layer upgrades these cues with a
 * real forced alignment - see `services/transcription.ts`.
 */

/** Construction terminology dictionary. Applied to every generated cue. */
export const GLOSSARY: { canonical: string; aliases: string[]; note: string }[] = [
  { canonical: 'BOQ', aliases: ['boq', 'b o q'], note: 'Bill of Quantities' },
  { canonical: 'WIR', aliases: ['wir', 'w i r'], note: 'Work Inspected and Rejected/Report' },
  { canonical: 'IPC', aliases: ['ipc', 'i p c'], note: 'Interim Payment Certificate' },
  // NB: a caption must stay readable - a spelled-out term is never rewritten to
  // an acronym. Only spacing/casing of the acronym itself is normalised.
  { canonical: 'EVM', aliases: ['evm', 'e v m'], note: 'Earned Value Management' },
  { canonical: 'S-Curve', aliases: ['s curve', 's-curve', 'scurve'], note: 'Cumulative progress S-curve' },
  { canonical: 'Baseline', aliases: ['baseline'], note: 'Approved baseline plan' },
  { canonical: 'Float', aliases: ['float', 'floats'], note: 'Schedule float' },
  { canonical: 'Progress', aliases: ['progress'], note: 'Physical progress' },
];

export function applyGlossary(text: string): string {
  let out = text;
  for (const entry of GLOSSARY) {
    for (const alias of entry.aliases) {
      const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      out = out.replace(re, entry.canonical);
    }
  }
  return out;
}

export function glossaryHits(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const e of GLOSSARY) {
    if (e.aliases.some((a) => lower.includes(a.toLowerCase()))) hits.push(e.canonical);
  }
  return hits;
}

const MAX_CHARS_PER_LINE = 42;
const MAX_LINES = 2;

export function wrapCaption(text: string, maxChars = MAX_CHARS_PER_LINE, maxLines = MAX_LINES): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  return lines;
}

const CUE_DANGLING = /^(a|an|the|is|are|to|of|and|or|but|that|this|it|as|at|by|for|from|in|into|on|than|so|if|when|with|your|our|my|their|where|what|does|do)$/i;

/**
 * Phase 0C - caption chunking on phrase boundaries, with no orphan cues.
 *
 *  1. sentences are never merged across a sentence end;
 *  2. a sentence longer than `max` characters is split at phrase boundaries
 *     (, ; : dashes, before a conjunction), then at balanced word boundaries;
 *  3. a trailing piece of fewer than 3 words that is not a sentence on its own
 *     ("week.") is merged into its neighbour, or the pair is rebalanced into
 *     two halves when the merge would exceed the two-line limit.
 * Every word is kept, in order.
 */
export function chunkCaptionText(text: string, max = MAX_CHARS_PER_LINE * MAX_LINES - 12): string[] {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?\u061F])\s+(?=[A-Z0-9"\u0600-\u06FF])/).filter(Boolean);
  const out: string[] = [];
  const hard = MAX_CHARS_PER_LINE * MAX_LINES;
  const wc = (s: string) => s.split(' ').filter(Boolean).length;

  const balanced = (words: string[]): [string, string] => {
    let best = 1;
    let score = Infinity;
    for (let i = 1; i < words.length; i++) {
      const l = words.slice(0, i).join(' ');
      const r = words.slice(i).join(' ');
      let sc = Math.abs(l.length - r.length);
      if (/[,;:]$/.test(words[i - 1])) sc -= 12;
      if (CUE_DANGLING.test(words[i - 1].replace(/[^A-Za-z]/g, ''))) sc += 25;
      if (i < 3 || words.length - i < 3) sc += 40;
      if (sc < score) {
        score = sc;
        best = i;
      }
    }
    return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
  };

  const splitLong = (s: string): string[] => {
    if (s.length <= max) return [s];
    // phrase boundaries first
    const phrases = s.split(/(?<=[,;:])\s+|\s+(?=[-\u2013\u2014]\s)|\s+(?=(?:and|but|because|which|while|so)\s)/i).filter(Boolean);
    const packed: string[] = [];
    let buf = '';
    for (const ph of phrases) {
      const next = buf ? `${buf} ${ph}` : ph;
      if (next.length <= max) buf = next;
      else {
        if (buf) packed.push(buf);
        buf = ph;
      }
    }
    if (buf) packed.push(buf);
    return packed.flatMap((p) => (p.length <= max ? [p] : (() => {
      const words = p.split(' ');
      if (words.length < 2) return [p];
      const [a, b] = balanced(words);
      return [...splitLong(a), ...splitLong(b)];
    })()));
  };

  for (const sent of sentences) {
    const pieces = splitLong(sent);
    // orphan repair inside the sentence
    for (let i = pieces.length - 1; i > 0; i--) {
      const small = wc(pieces[i]) < 3 ? i : wc(pieces[i - 1]) < 3 ? i - 1 : -1;
      if (small < 0) continue;
      const merged = `${pieces[i - 1]} ${pieces[i]}`;
      if (merged.length <= hard) pieces.splice(i - 1, 2, merged);
      else pieces.splice(i - 1, 2, ...balanced(merged.split(' ')));
    }
    out.push(...pieces);
  }
  return out;
}

/** A cue that is a leftover fragment: fewer than 3 words and not a complete sentence. */
export function isOrphanCue(text: string, sentenceTexts: string[] = []): boolean {
  const t = String(text).trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 3) return false;
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
  // a short sentence spoken on its own ("Why?") is not an orphan
  return !sentenceTexts.some((s) => n(s) === n(t));
}

export function captionOverMaxLines(text: string): boolean {
  return text.length > MAX_CHARS_PER_LINE * MAX_LINES;
}

/** reading-speed guard: captions faster than this are unreadable */
export const MAX_CPS = 21;

export function charactersPerSecond(text: string, seconds: number): number {
  if (seconds <= 0) return 999;
  return text.replace(/\s+/g, '').length / seconds;
}

/**
 * Build caption cues by distributing the script over the real audio duration.
 * Weighting by character count keeps long sentences on screen longer, which is
 * what a real forced aligner would produce for steady narration.
 */
export function buildCues(
  segments: { text: string; index: number }[],
  audioDuration: number,
  opts: { minCue?: number; maxCue?: number; leadIn?: number } = {},
): CaptionCue[] {
  const minCue = opts.minCue ?? 1.4;
  const maxCue = opts.maxCue ?? 6.0;
  const cleaned = segments.map((s) => applyGlossary(s.text).trim()).filter(Boolean);
  if (!cleaned.length) return [];

  // split long segments into cue-sized chunks
  const chunks: string[] = [];
  for (const seg of cleaned) chunks.push(...chunkCaptionText(seg));
  if (!chunks.length) return [];

  const totalChars = chunks.reduce((a, c) => a + c.length + 1, 0);
  const start = opts.leadIn ?? 0.12;
  const usable = Math.max(0.5, audioDuration - start - 0.18);

  const cues: CaptionCue[] = [];
  let t = start;
  chunks.forEach((text, i) => {
    const share = (text.length + 1) / totalChars;
    let dur = Math.max(minCue, Math.min(maxCue, share * usable));
    // never let the last cue overrun the audio
    if (t + dur > audioDuration) dur = Math.max(0.6, audioDuration - t);
    cues.push({
      id: `cue_${String(i + 1).padStart(3, '0')}`,
      start: Number(t.toFixed(3)),
      end: Number((t + dur).toFixed(3)),
      text,
      sceneId: null,
      terms: glossaryHits(text),
      userEdited: false,
    });
    t += dur;
  });
  return cues;
}

function srtTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function toSrt(cues: CaptionCue[]): string {
  return cues
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

export function toVtt(cues: CaptionCue[]): string {
  const body = cues
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${srtTime(c.start).replace(',', '.')} --> ${srtTime(c.end).replace(',', '.')}\n${c.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** Attach cues to the scene that contains their midpoint. */
export function linkCuesToScenes<T extends { id: string; startTime: number; duration: number }>(cues: CaptionCue[], scenes: T[]): CaptionCue[] {
  return cues.map((c) => {
    const mid = (c.start + c.end) / 2;
    const s = scenes.find((x) => mid >= x.startTime && mid < x.startTime + x.duration);
    return { ...c, sceneId: s ? s.id : scenes.length ? scenes[scenes.length - 1].id : null };
  });
}

/** Link audio segments to scenes the same way. */
export function linkSegmentsToScenes(segments: AudioSegment[], scenes: { id: string; startTime: number; duration: number }[]): AudioSegment[] {
  return segments.map((sg) => {
    const mid = (sg.start + sg.end) / 2;
    const s = scenes.find((x) => mid >= x.startTime && mid < x.startTime + x.duration);
    return { ...sg, text: sg.text, index: sg.index };
  });
}

/**
 * Move a cue boundary while keeping neighbours monotonic - used when the
 * operator nudges timing by hand (brief section 11: move scene timing without
 * losing sync).
 */
export function retimeCues(cues: CaptionCue[], cueId: string, newStart: number, newEnd: number): CaptionCue[] {
  const sorted = cues.slice().sort((a, b) => a.start - b.start);
  const i = sorted.findIndex((c) => c.id === cueId);
  if (i < 0) return cues;
  const prev = sorted[i - 1];
  const next = sorted[i + 1];
  let s = Math.max(0, newStart);
  let e = Math.max(s + 0.4, newEnd);
  if (prev) s = Math.max(s, prev.end + 0.05);
  if (next) e = Math.min(e, next.start - 0.05);
  if (e <= s) e = s + 0.4;
  sorted[i] = { ...sorted[i], start: Number(s.toFixed(3)), end: Number(e.toFixed(3)), userEdited: true };
  return sorted;
}
