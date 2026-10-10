/**
 * Forced alignment of a known script to CTC frame emissions.
 *
 * A greedy transcript is not timing. Script length and silence detection are
 * not substitutes when a word cannot be placed.
 */

export const OMNIASR_CTC_300M = {
  modelCard: 'omniASR_CTC_300M_v2',
  checkpointName: 'omniASR-CTC-300M-v2.pt',
  officialUrl: 'https://dl.fbaipublicfiles.com/mms/omniASR-CTC-300M-v2.pt',
  tokenizerUrl: 'https://dl.fbaipublicfiles.com/mms/omniASR_tokenizer_written_v2.model',
  downloadSize: '1.3 GiB',
  license: 'Apache-2.0',
  frameHopSamples: 320,
  sampleRate: 16000,
} as const;

export interface CtcTokenSpan {
  tokenId: number;
  startFrame: number;
  endFrame: number;
  start: number;
  end: number;
  supported: boolean;
}

export interface ForcedAlignment {
  ok: boolean;
  score: number;
  spans: CtcTokenSpan[];
  reason: string;
}

export interface AlignedWord {
  text: string;
  start: number;
  end: number;
  supported: boolean;
}

export interface UnresolvedAlignment {
  sceneId: string;
  text: string;
  reason: string;
  word?: string;
  wordIndex?: number;
}

export interface CtcSentenceUnit {
  sceneId: string;
  cueId: string | null;
  text: string;
  userEdited: boolean;
}

export interface CtcTimingRow {
  sceneId: string;
  cueId: string | null;
  text: string;
  userEdited: boolean;
  proposedStart: number;
  proposedDurationSec: number;
  proposedCaptionStart: number;
  proposedCaptionEnd: number;
  warnings: string[];
}

export interface CtcTimingProposal {
  available: boolean;
  method: 'ctc_forced' | 'unavailable';
  sourceLabel: string;
  detail: string;
  acousticVerification: false;
  verified: false;
  rows: CtcTimingRow[];
  warnings: string[];
  unresolved: UnresolvedAlignment[];
  saved: false;
}

const NEG = Number.NEGATIVE_INFINITY;
const SUPPORT_MARGIN = 1;

/** Matching only. Displayed text is never passed through this function for storage. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\u0640/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function forcedAlignCtc(
  logProbs: readonly (readonly number[])[],
  tokenIds: readonly number[],
  blankId: number,
  frameSec: number,
): ForcedAlignment {
  const frames = logProbs.length;
  const count = tokenIds.length;
  if (!(frameSec > 0)) return { ok: false, score: NEG, spans: [], reason: 'The emission frame duration is unknown. No times were invented.' };
  if (frames === 0 || count === 0) return { ok: false, score: NEG, spans: [], reason: 'There are no emissions or no known tokens to align.' };
  if (count > frames) return { ok: false, score: NEG, spans: [], reason: 'The known text has more tokens than acoustic frames. It was not shortened to fit.' };
  for (const id of tokenIds) {
    if (!Number.isInteger(id) || id < 0 || id === blankId) {
      return { ok: false, score: NEG, spans: [], reason: 'A known token is missing from the CTC vocabulary. Timing was not estimated from text length.' };
    }
  }

  const states = count * 2 + 1;
  const labels = new Array<number>(states);
  for (let state = 0; state < states; state += 1) {
    labels[state] = state % 2 === 0 ? blankId : tokenIds[(state - 1) / 2];
  }
  let prev = new Array<number>(states).fill(NEG);
  prev[0] = logProbs[0][labels[0]] ?? NEG;
  if (states > 1) prev[1] = logProbs[0][labels[1]] ?? NEG;
  const back = Array.from({ length: frames }, () => new Array<number>(states).fill(-1));

  for (let time = 1; time < frames; time += 1) {
    const next = new Array<number>(states).fill(NEG);
    for (let state = 0; state < states; state += 1) {
      let best = prev[state];
      let from = state;
      if (state > 0 && prev[state - 1] > best) {
        best = prev[state - 1];
        from = state - 1;
      }
      if (state % 2 === 1 && state > 1 && labels[state] !== labels[state - 2] && prev[state - 2] > best) {
        best = prev[state - 2];
        from = state - 2;
      }
      const emit = logProbs[time][labels[state]];
      if (best === NEG || emit === undefined || !Number.isFinite(emit)) continue;
      next[state] = best + emit;
      back[time][state] = from;
    }
    prev = next;
  }

  let endState = states - 1;
  if (states > 1 && prev[states - 2] > prev[endState]) endState = states - 2;
  if (prev[endState] === NEG) {
    return { ok: false, score: NEG, spans: [], reason: 'No CTC path covers the known text. Pause timing was not used instead.' };
  }

  const stateAt = new Array<number>(frames);
  stateAt[frames - 1] = endState;
  for (let time = frames - 1; time > 0; time -= 1) {
    const from = back[time][stateAt[time]];
    if (from < 0) return { ok: false, score: prev[endState], spans: [], reason: 'The CTC path could not be traced. No times were saved.' };
    stateAt[time - 1] = from;
  }

  const spans: CtcTokenSpan[] = tokenIds.map((tokenId) => ({
    tokenId,
    startFrame: -1,
    endFrame: -1,
    start: 0,
    end: 0,
    supported: false,
  }));
  for (let time = 0; time < frames; time += 1) {
    const state = stateAt[time];
    if (state % 2 === 0) continue;
    const index = (state - 1) / 2;
    const span = spans[index];
    if (span.startFrame < 0) span.startFrame = time;
    span.endFrame = time + 1;
  }
  for (const span of spans) {
    if (span.startFrame < 0 || span.endFrame <= span.startFrame) {
      return { ok: false, score: prev[endState], spans: [], reason: 'A known token received no acoustic frame. Its time was not guessed.' };
    }
    span.start = round3(span.startFrame * frameSec);
    span.end = round3(span.endFrame * frameSec);
    span.supported = false;
    for (let time = span.startFrame; time < span.endFrame; time += 1) {
      const token = logProbs[time][span.tokenId] ?? NEG;
      const blank = logProbs[time][blankId] ?? NEG;
      if (token + SUPPORT_MARGIN >= blank) span.supported = true;
    }
  }
  if (spans.some((span) => !span.supported)) {
    return {
      ok: false,
      score: prev[endState],
      spans: [],
      reason: 'A known token was placed where the blank is more likely. That time was not kept, and pause timing was not used.',
    };
  }
  return { ok: true, score: prev[endState], spans, reason: '' };
}

export function wordsFromTokenSpans(
  originalWords: readonly string[],
  spans: readonly CtcTokenSpan[],
  spaceId: number,
): AlignedWord[] {
  const words: AlignedWord[] = [];
  let cursor = 0;
  for (const text of originalWords) {
    const letters = normalizeForMatch(text).replace(/\s/g, '').length;
    const owned: CtcTokenSpan[] = [];
    while (cursor < spans.length && spans[cursor].tokenId === spaceId) cursor += 1;
    for (let i = 0; i < letters && cursor < spans.length; i += 1) {
      owned.push(spans[cursor]);
      cursor += 1;
    }
    if (owned.length !== letters || owned.length === 0) {
      words.push({ text, start: 0, end: 0, supported: false });
      continue;
    }
    words.push({
      text,
      start: owned[0].start,
      end: owned[owned.length - 1].end,
      supported: owned.every((span) => span.supported),
    });
  }
  return words;
}

export function proposalFromAlignedWords(input: {
  audioDurationSec: number;
  units: readonly CtcSentenceUnit[];
  wordsByScene: ReadonlyMap<string, readonly AlignedWord[]>;
  unresolved?: readonly UnresolvedAlignment[];
}): CtcTimingProposal {
  const unresolved = [...(input.unresolved ?? [])];
  const placed: Array<{ unit: CtcSentenceUnit; start: number; speechEnd: number }> = [];
  for (const unit of input.units) {
    const words = input.wordsByScene.get(unit.sceneId) ?? [];
    const expected = unit.text.trim().split(/\s+/).filter(Boolean);
    if (words.length !== expected.length || words.some((word) => !word.supported || !(word.end > word.start))) {
      unresolved.push({
        sceneId: unit.sceneId,
        text: unit.text,
        reason: 'One or more words have no supported acoustic span. Their time was not taken from text length or pauses.',
      });
      continue;
    }
    placed.push({ unit, start: words[0].start, speechEnd: words[words.length - 1].end });
  }
  if (unresolved.length > 0 || placed.length !== input.units.length) {
    return unavailableProposal(
      'CTC alignment did not place every known sentence. Saved timings were not replaced, and pause estimation was not used.',
      unresolved,
    );
  }
  const starts = placed.map((row, index) => (index === 0 ? 0 : round3(row.start)));
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i] <= starts[i - 1]) {
      return unavailableProposal(
        `The aligned start of ${placed[i].unit.sceneId} does not follow ${placed[i - 1].unit.sceneId}. Nothing was saved.`,
        unresolved,
      );
    }
  }
  if (starts[starts.length - 1] >= input.audioDurationSec) {
    return unavailableProposal('The last aligned sentence starts at or after the end of the recording. Nothing was saved.', unresolved);
  }
  const rows: CtcTimingRow[] = placed.map((row, index) => {
    const sceneStart = starts[index];
    const nextStart = index === placed.length - 1 ? input.audioDurationSec : starts[index + 1];
    const captionStart = index === 0 ? round3(Math.max(sceneStart, row.start)) : sceneStart;
    const captionEnd = round3(Math.min(nextStart, Math.max(captionStart + 0.001, row.speechEnd)));
    return {
      sceneId: row.unit.sceneId,
      cueId: row.unit.cueId,
      text: row.unit.text,
      userEdited: row.unit.userEdited,
      proposedStart: sceneStart,
      proposedDurationSec: round3(nextStart - sceneStart),
      proposedCaptionStart: captionStart,
      proposedCaptionEnd: captionEnd,
      warnings: [],
    };
  });
  return {
    available: true,
    method: 'ctc_forced',
    sourceLabel: 'CTC word alignment',
    detail: 'Sentence times come from one CTC forced alignment of the known text to frame emissions. A transcript without those emissions is not timing. This is not a listening approval.',
    acousticVerification: false,
    verified: false,
    rows,
    warnings: [],
    unresolved,
    saved: false,
  };
}

export function unavailableProposal(detail: string, unresolved: readonly UnresolvedAlignment[] = []): CtcTimingProposal {
  return {
    available: false,
    method: 'unavailable',
    sourceLabel: 'Alignment unavailable',
    detail,
    acousticVerification: false,
    verified: false,
    rows: [],
    warnings: [detail],
    unresolved: [...unresolved],
    saved: false,
  };
}

export function transcriptIsNotTiming(): CtcTimingProposal {
  return unavailableProposal(
    'A text transcript has no frame times. Greedy CTC decoding was not treated as alignment, and pause estimation was not used.',
  );
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
