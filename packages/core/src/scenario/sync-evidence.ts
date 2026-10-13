/**
 * Synchronization evidence for one narration excerpt (sync work order).
 *
 * Three independent facts are kept apart:
 *  1. The excerpt identity: which audio bytes, which source window, and where
 *     that window sits on the composition. Timing from one window must never be
 *     reused for another, so every piece of evidence is bound to this identity.
 *  2. Forced alignment: the aligner placed the supplied text somewhere in the
 *     audio. This proves the text FITS the audio window. It does not prove that
 *     the text was spoken.
 *  3. Transcript agreement: an independent transcript of the audio was compared
 *     with the supplied text. Only this can show that the words were spoken.
 *
 * A verdict of "verified" needs both (2) and (3) to agree. Forced alignment on
 * its own is never "verified". When no transcript exists the verdict is
 * "unverified", and when the transcript disagrees it is a "discrepancy".
 *
 * Pure functions only. No I/O, no provider calls.
 */
import { createHash } from 'node:crypto';
import { normalizeForMatch } from './ctc-alignment.js';

export const SYNC_EVIDENCE_SCHEMA = 'sync-evidence-v1' as const;

/** Arabic letter folding for comparison only. Displayed text keeps its diacritics. */
const ARABIC_FOLD: Record<string, string> = {
  'أ': 'ا',
  'إ': 'ا',
  'آ': 'ا',
  'ٱ': 'ا',
  'ى': 'ي',
  'ؤ': 'و',
  'ئ': 'ي',
  'ة': 'ه',
};

/**
 * Comparison form of a text: diacritics and tatweel removed, letter variants
 * folded, punctuation dropped, digits kept, case folded. Two texts that differ
 * only in those respects compare equal; any other difference does not.
 */
export function normalizeSpokenText(text: string): string {
  const base = normalizeForMatch(text).toLowerCase();
  let out = '';
  for (const ch of base) out += ARABIC_FOLD[ch] ?? ch;
  return out.replace(/\s+/g, ' ').trim();
}

/** Word tokens of the comparison form. Empty input gives no tokens. */
export function spokenTokens(text: string): string[] {
  const norm = normalizeSpokenText(text);
  return norm === '' ? [] : norm.split(' ');
}

export interface TokenDiff {
  /** Tokens of the supplied script that the transcript does not contain, in order. */
  missing: string[];
  /** Tokens the transcript contains that the script does not, in order. */
  extra: string[];
  matched: number;
  scriptTokens: number;
  transcriptTokens: number;
}

/**
 * Longest-common-subsequence diff of two token lists. Quadratic in length,
 * which is acceptable for one caption set (a few thousand tokens at most).
 */
export function diffTokens(script: readonly string[], transcript: readonly string[]): TokenDiff {
  const n = script.length;
  const m = transcript.length;
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = script[i] === transcript[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const missing: string[] = [];
  const extra: string[] = [];
  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < n && j < m) {
    if (script[i] === transcript[j]) {
      matched += 1;
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      missing.push(script[i]);
      i += 1;
    } else {
      extra.push(transcript[j]);
      j += 1;
    }
  }
  while (i < n) missing.push(script[i++]);
  while (j < m) extra.push(transcript[j++]);
  return { missing, extra, matched, scriptTokens: n, transcriptTokens: m };
}

/** Script-versus-transcript comparison. Exact after normalisation; any gap is a discrepancy. */
export function compareScriptToTranscript(script: string, transcript: string): TokenDiff & { agrees: boolean } {
  const diff = diffTokens(spokenTokens(script), spokenTokens(transcript));
  const agrees = diff.scriptTokens > 0 && diff.missing.length === 0 && diff.extra.length === 0;
  return { ...diff, agrees };
}

/**
 * Identity of one narration excerpt: the audio bytes, the source window, and
 * where that window starts on the composition. Rounded to the millisecond so
 * float noise cannot change the hash. Any change to these inputs changes the hash.
 */
export interface ExcerptIdentityInput {
  audioSha256: string;
  sourceInSec: number;
  sourceOutSec: number;
  compositionStartSec: number;
}

export function excerptIdentitySha256(input: ExcerptIdentityInput): string {
  const ms = (value: number) => Math.round(value * 1000);
  const canonical = JSON.stringify({
    schema: SYNC_EVIDENCE_SCHEMA,
    audioSha256: input.audioSha256,
    sourceInMs: ms(input.sourceInSec),
    sourceOutMs: ms(input.sourceOutSec),
    compositionStartMs: ms(input.compositionStartSec),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export type SyncVerdict = 'verified' | 'discrepancy' | 'unverified' | 'stale' | 'not_requested';

export interface SyncVerdictInput {
  /** The excerpt identity the evidence was produced for. */
  evidenceExcerptSha256: string | null;
  /** The excerpt identity of the audio and window on disk right now. */
  currentExcerptSha256: string | null;
  /** Did the forced aligner place the supplied text? Never sufficient alone. */
  forcedAlignmentAvailable: boolean;
  /** Supplied text (the caption units joined in order). */
  script: string;
  /** Independent transcript, or null when no transcript could be produced. */
  transcript: string | null;
}

export interface SyncVerdictResult {
  verdict: SyncVerdict;
  /** Plain-language reasons. Shown to the owner; never empty when not verified. */
  reasons: string[];
  /** Token diff against the transcript when one exists. */
  diff: (TokenDiff & { agrees: boolean }) | null;
}

/**
 * Verdict for one narration excerpt. Order of checks matters:
 *  - nothing requested or nothing to compare: not_requested
 *  - excerpt identity changed since the evidence was made: stale (review needed)
 *  - no transcript: unverified, whatever the forced alignment said
 *  - transcript disagrees with the script: discrepancy (never auto-moved)
 *  - transcript agrees AND forced alignment placed the text: verified
 *  - transcript agrees but alignment is missing: unverified
 */
export function syncVerdict(input: SyncVerdictInput): SyncVerdictResult {
  if (input.evidenceExcerptSha256 === null && input.currentExcerptSha256 === null) {
    return { verdict: 'not_requested', reasons: ['No alignment has been requested for this narration.'], diff: null };
  }
  if (input.evidenceExcerptSha256 !== input.currentExcerptSha256) {
    return {
      verdict: 'stale',
      reasons: ['The narration audio, its source window, or its place on the timeline changed after this evidence was made. Review the synchronization again.'],
      diff: null,
    };
  }
  if (input.transcript === null) {
    return {
      verdict: 'unverified',
      reasons: [
        input.forcedAlignmentAvailable
          ? 'Forced alignment placed the supplied text, but no independent transcript was available. That shows timing fit, not that the words were spoken.'
          : 'No independent transcript and no forced alignment are available for this narration.',
      ],
      diff: null,
    };
  }
  const diff = compareScriptToTranscript(input.script, input.transcript);
  if (!diff.agrees) {
    const parts: string[] = [];
    if (diff.missing.length > 0) parts.push(`${diff.missing.length} supplied word(s) not heard in the transcript`);
    if (diff.extra.length > 0) parts.push(`${diff.extra.length} transcript word(s) not in the supplied text`);
    if (diff.scriptTokens === 0) parts.push('the supplied text is empty');
    return {
      verdict: 'discrepancy',
      reasons: [`The transcript does not match the supplied text: ${parts.join('; ')}. No timing was applied.`],
      diff,
    };
  }
  if (!input.forcedAlignmentAvailable) {
    return {
      verdict: 'unverified',
      reasons: ['The transcript matches the supplied text, but forced alignment did not place it, so no per-line timing is proven.'],
      diff,
    };
  }
  return {
    verdict: 'verified',
    reasons: ['The independent transcript matches the supplied text, and forced alignment placed it inside this audio window. Listening review is still separate.'],
    diff,
  };
}
