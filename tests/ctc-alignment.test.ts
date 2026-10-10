/**
 * CTC placement comes from emissions. These fixtures are not the user's recording
 * and do not prove a sentence starts at 6.00s.
 */
import { describe, expect, it } from 'vitest';
import {
  forcedAlignCtc,
  normalizeForMatch,
  proposalFromAlignedWords,
  transcriptIsNotTiming,
  wordsFromTokenSpans,
  type AlignedWord,
} from '@buildtrack/core';

const BLANK = 0;
const SPACE = 1;

function vocab(chars: string): Map<string, number> {
  const map = new Map<string, number>([[' ', SPACE]]);
  for (const char of chars) {
    if (!map.has(char)) map.set(char, map.size + 1);
  }
  return map;
}

function peaked(frames: number, vocabSize: number, peaks: Array<{ frame: number; id: number }>): number[][] {
  const rows = Array.from({ length: frames }, () => Array.from({ length: vocabSize }, () => -8));
  for (const row of rows) row[BLANK] = -0.1;
  for (const peak of peaks) {
    rows[peak.frame].fill(-12);
    rows[peak.frame][BLANK] = -10;
    rows[peak.frame][peak.id] = -0.01;
  }
  return rows;
}

function encode(text: string, map: Map<string, number>): number[] {
  return [...normalizeForMatch(text)].map((char) => {
    const id = map.get(char);
    if (id === undefined) throw new Error(`missing ${char}`);
    return id;
  });
}

describe('CTC forced alignment', () => {
  it('ignores Arabic diacritics for matching and keeps the displayed word', () => {
    expect(normalizeForMatch('تَنْظُرُ إِلَى')).toBe(normalizeForMatch('تنظر إلى'));
    expect(normalizeForMatch('تَنْظُرُ')).toBe('تنظر');
    const displayed = 'تَنْظُرُ';
    const map = vocab(normalizeForMatch(displayed));
    const ids = encode(displayed, map);
    const peaks = ids.map((id, index) => ({ frame: 4 + index * 2, id }));
    const aligned = forcedAlignCtc(peaked(20, map.size + 2, peaks), ids, BLANK, 0.02);
    expect(aligned.ok).toBe(true);
    const words = wordsFromTokenSpans([displayed], aligned.spans, SPACE);
    expect(words[0].text).toBe(displayed);
    expect(words[0].supported).toBe(true);
    expect(words[0].start).toBeCloseTo(0.08, 2);
  });

  it('keeps an intra-sentence pause inside one sentence and does not invent 6.00', () => {
    const text = 'تنظر إلى';
    const map = vocab(normalizeForMatch(text));
    const ids = encode(text, map);
    const spaceAt = ids.indexOf(SPACE);
    const peaks = ids.map((id, index) => ({
      frame: index < spaceAt ? 2 + index : 14 + (index - spaceAt - 1),
      id,
    }));
    const aligned = forcedAlignCtc(peaked(30, map.size + 2, peaks), ids, BLANK, 0.05);
    expect(aligned.ok).toBe(true);
    const words = wordsFromTokenSpans(text.split(' '), aligned.spans, SPACE);
    expect(words).toHaveLength(2);
    expect(words[1].start - words[0].end).toBeGreaterThan(0.2);
    const proposal = proposalFromAlignedWords({
      audioDurationSec: 1.5,
      units: [{ sceneId: 'lng_02', cueId: 'cap_02', text, userEdited: false }],
      wordsByScene: new Map([['lng_02', words]]),
    });
    expect(proposal.available).toBe(true);
    expect(proposal.method).toBe('ctc_forced');
    expect(proposal.saved).toBe(false);
    expect(proposal.rows[0].proposedCaptionStart).toBeCloseTo(words[0].start, 2);
    expect(proposal.rows[0].proposedCaptionEnd).toBeCloseTo(words[1].end, 2);
    expect(proposal.rows[0].proposedStart).not.toBe(6);
    expect(proposal.detail).not.toContain('pause');
  });

  it('reports a missing character instead of estimating its time', () => {
    const map = vocab('نظر');
    expect(map.has('ت')).toBe(false);
    const proposal = proposalFromAlignedWords({
      audioDurationSec: 4,
      units: [{ sceneId: 'lng_02', cueId: 'cap_02', text: 'تنظر', userEdited: false }],
      wordsByScene: new Map<string, AlignedWord[]>([[
        'lng_02',
        [{ text: 'تنظر', start: 0, end: 0, supported: false }],
      ]]),
    });
    expect(proposal.available).toBe(false);
    expect(proposal.rows).toEqual([]);
    expect(proposal.unresolved[0].sceneId).toBe('lng_02');
    expect(proposal.detail).toContain('pause estimation was not used');
    expect(proposal.saved).toBe(false);
  });

  it('places a repeated word twice, in order, from separate frames', () => {
    const text = 'ما ما';
    const map = vocab(normalizeForMatch(text));
    const ids = encode(text, map);
    const peaks = [
      { frame: 2, id: ids[0] },
      { frame: 3, id: ids[1] },
      { frame: 4, id: SPACE },
      { frame: 10, id: ids[3] },
      { frame: 11, id: ids[4] },
    ];
    const aligned = forcedAlignCtc(peaked(16, map.size + 2, peaks), ids, BLANK, 0.1);
    expect(aligned.ok).toBe(true);
    const words = wordsFromTokenSpans(['ما', 'ما'], aligned.spans, SPACE);
    expect(words[0].start).toBeCloseTo(0.2, 2);
    expect(words[1].start).toBeCloseTo(1, 2);
    expect(words[1].start).toBeGreaterThan(words[0].end);
  });

  it('does not treat a transcript or a failed path as timing', () => {
    expect(transcriptIsNotTiming().available).toBe(false);
    expect(transcriptIsNotTiming().detail).toContain('no frame times');
    const failed = forcedAlignCtc(
      Array.from({ length: 6 }, () => [-0.01, -8, -8]),
      [1, 2],
      BLANK,
      0.02,
    );
    expect(failed.ok).toBe(false);
    expect(failed.spans).toEqual([]);
    expect(failed.reason).toContain('pause timing was not used');
  });

  it('ends a caption at the last aligned word when the next sentence starts later', () => {
    const proposal = proposalFromAlignedWords({
      audioDurationSec: 10,
      units: [
        { sceneId: 'lng_01', cueId: 'cap_01', text: 'واحد', userEdited: false },
        { sceneId: 'lng_02', cueId: 'cap_02', text: 'اثنان', userEdited: true },
      ],
      wordsByScene: new Map([
        ['lng_01', [{ text: 'واحد', start: 0.4, end: 1.7, supported: true }]],
        ['lng_02', [{ text: 'اثنان', start: 5.84, end: 7.1, supported: true }]],
      ]),
    });
    expect(proposal.available).toBe(true);
    expect(proposal.rows[0].proposedStart).toBe(0);
    expect(proposal.rows[0].proposedCaptionEnd).toBeCloseTo(1.7, 2);
    expect(proposal.rows[0].proposedDurationSec).toBeCloseTo(5.84, 2);
    expect(proposal.rows[1].proposedStart).toBeCloseTo(5.84, 2);
    expect(proposal.rows[1].proposedCaptionStart).toBeCloseTo(5.84, 2);
    expect(proposal.rows[1].proposedCaptionEnd).toBeCloseTo(7.1, 2);
    expect(proposal.rows[1].proposedStart).not.toBe(6);
    expect(proposal.acousticVerification).toBe(false);
  });
});
