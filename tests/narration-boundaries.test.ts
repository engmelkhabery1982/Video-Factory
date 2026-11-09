/**
 * Pause-aware boundaries are still estimates. They are not the user's
 * listening notes and not acoustic verification.
 */
import { describe, expect, it } from 'vitest';
import {
  applyBoundaryEdit,
  applyNarrationProposal,
  narrationWeight,
  parseSilenceDetectLog,
  preserveReviewedExternalTiming,
  proposeNarrationBoundaries,
  repairDurationsFromStarts,
  speechIntervalsFromSilence,
} from '@buildtrack/core';

const VOCALIZED = 'تَنْظُرُ إِلَى مَا فَقَدْتَ';
const PLAIN = 'تنظر إلى ما فقدت';

function proportionalStarts(duration: number, weights: number[]): number[] {
  const sum = weights.reduce((total, weight) => total + weight, 0);
  let cursor = 0;
  return weights.map((weight) => {
    const start = cursor;
    cursor += (duration * weight) / sum;
    return start;
  });
}

describe('narration boundary estimation', () => {
  it('ignores Arabic diacritics and tatweel when weighing, and never rewrites the text', () => {
    expect(narrationWeight(VOCALIZED)).toBe(narrationWeight(PLAIN));
    expect(narrationWeight(VOCALIZED)).toBeGreaterThan(0);
    expect(narrationWeight(`رحم\u0640ان`)).toBe(narrationWeight('رحمان'));
    const proposal = proposeNarrationBoundaries({
      audioDurationSec: 4,
      silences: [{ start: 2, end: 2.5 }],
      detectionFailed: false,
      units: [
        { sceneId: 'lng_01', cueId: 'cap_01', text: VOCALIZED, userEdited: false },
        { sceneId: 'lng_02', cueId: 'cap_02', text: 'وَتَنْسَى مَا أُعْطِيتَ', userEdited: false },
      ],
    });
    expect(proposal.rows.map((row) => row.text)).toEqual([VOCALIZED, 'وَتَنْسَى مَا أُعْطِيتَ']);
    expect(proposal.verified).toBe(false);
    expect(proposal.acousticVerification).toBe(false);
  });

  it('moves boundaries in both directions when pauses are uneven, without a global offset', () => {
    const duration = 22;
    const silences = [
      { start: 3, end: 3.4 },
      { start: 9, end: 14 },
      { start: 18, end: 18.2 },
    ];
    const proposal = proposeNarrationBoundaries({
      audioDurationSec: duration,
      silences,
      detectionFailed: false,
      units: ['one', 'two', 'three', 'four'].map((text, index) => ({
        sceneId: `lng_${index + 1}`,
        cueId: `cap_${index + 1}`,
        text,
        userEdited: false,
      })),
    });
    expect(proposal.available).toBe(true);
    expect(proposal.method).toBe('speech_intervals');
    expect(proposal.sourceLabel).toBe('Pause-aware estimate');
    expect(proposal.detail).toContain('not word-accurate alignment');
    expect(proposal.detail).toContain('not acoustically verified');
    const starts = proposal.rows.map((row) => row.proposedStart);
    const proportional = proportionalStarts(duration, [1, 1, 1, 1]);
    const deltas = starts.map((start, index) => start - proportional[index]);
    expect(deltas.some((delta) => delta < -0.5)).toBe(true);
    expect(deltas.some((delta) => delta > 0.5)).toBe(true);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeCloseTo(3.4, 2);
    expect(starts[2]).toBeCloseTo(14, 2);
    expect(proposal.rows[0].proposedCaptionEnd).toBeLessThan(3.4);
    expect(proposal.rows[1].proposedCaptionEnd).toBeLessThanOrEqual(9);
    expect(proposal.rows[2].proposedCaptionStart).toBeGreaterThanOrEqual(14);
    for (let i = 1; i < proposal.rows.length; i += 1) {
      const previousEnd = proposal.rows[i - 1].proposedStart + proposal.rows[i - 1].proposedDurationSec;
      expect(proposal.rows[i].proposedStart).toBeCloseTo(previousEnd, 2);
      expect(proposal.rows[i].proposedCaptionStart).toBeGreaterThanOrEqual(proposal.rows[i - 1].proposedCaptionEnd - 0.001);
    }
    const last = proposal.rows[proposal.rows.length - 1];
    expect(last.proposedStart + last.proposedDurationSec).toBeCloseTo(duration, 2);
  });

  it('does not turn every pause into a caption and does not claim alignment when detection fails', () => {
    const speech = speechIntervalsFromSilence(10, [{ start: 4, end: 6 }]);
    expect(speech).toEqual([{ start: 4, end: 6 }].length ? [
      { start: 0, end: 4 },
      { start: 6, end: 10 },
    ] : []);
    const failed = proposeNarrationBoundaries({
      audioDurationSec: 10,
      silences: [],
      detectionFailed: true,
      detectionMessage: 'Pause detection could not read this recording. Current timings were not changed. This is not alignment.',
      units: [{ sceneId: 'lng_01', cueId: 'cap_01', text: 'Keep this.', userEdited: false }],
    });
    expect(failed.available).toBe(false);
    expect(failed.method).toBe('unavailable');
    expect(failed.sourceLabel).toBe('Alignment unavailable');
    expect(failed.rows).toEqual([]);
    expect(failed.verified).toBe(false);
    const noPauses = proposeNarrationBoundaries({
      audioDurationSec: 8,
      silences: [],
      detectionFailed: false,
      units: [
        { sceneId: 'lng_01', cueId: 'cap_01', text: 'aa', userEdited: false },
        { sceneId: 'lng_02', cueId: 'cap_02', text: 'aa', userEdited: false },
      ],
    });
    expect(noPauses.method).toBe('script_proportion');
    expect(noPauses.sourceLabel).toBe('Estimated timing');
    expect(noPauses.detail).toContain('not word-accurate alignment');
  });

  it('parses silence logs without keeping a file path', () => {
    const log = [
      'Input #0, wav, from /home/private/recording.wav',
      'silence_start: 1.25',
      'silence_end: 1.90 | silence_duration: 0.65',
      'silence_start: 4',
    ].join('\n');
    expect(parseSilenceDetectLog(log, 5)).toEqual([
      { start: 1.25, end: 1.9 },
      { start: 4, end: 5 },
    ]);
    expect(JSON.stringify(parseSilenceDetectLog(log, 5))).not.toContain('/home/');
  });
});

describe('scene and caption boundary handling', () => {
  const scenes = [
    { sceneId: 'lng_01', startTime: 0, durationSec: 4.89 },
    { sceneId: 'lng_02', startTime: 4.89, durationSec: 4.21 },
    { sceneId: 'lng_03', startTime: 9.1, durationSec: 10 },
  ];
  const captions = [
    { cueId: 'cap_01', sceneId: 'lng_01', start: 0, end: 4.89 },
    { cueId: 'cap_02', sceneId: 'lng_02', start: 4.89, end: 9.1 },
    { cueId: 'cap_03', sceneId: 'lng_03', start: 9.1, end: 19.1 },
  ];

  it('recalculates duration when a start moves so the next scene is not overlapped', () => {
    const result = applyBoundaryEdit({
      scenes,
      captions,
      audioDurationSec: 19.1,
      edit: { kind: 'scene-start', sceneId: 'lng_02', startTime: 6 },
    });
    expect(result.applied).toBe(true);
    expect(result.scenes[0].durationSec).toBeCloseTo(6, 2);
    expect(result.scenes[1].startTime).toBeCloseTo(6, 2);
    expect(result.scenes[1].durationSec).toBeCloseTo(3.1, 2);
    expect(result.scenes[1].startTime + result.scenes[1].durationSec).toBeCloseTo(9.1, 2);
    expect(result.scenes[2].startTime).toBeCloseTo(9.1, 2);
    expect(result.captions[1].start).toBeCloseTo(6, 2);
    expect(result.captions[1].end).toBeCloseTo(9.1, 2);
    expect(result.captions[0].end).toBeCloseTo(6, 2);
  });

  it('repairs a stored duration that no longer matches the next start', () => {
    const broken = [
      scenes[0],
      { ...scenes[1], startTime: 6, durationSec: 4.21 },
      scenes[2],
    ];
    const brokenCaptions = [
      { ...captions[0], end: 6 },
      { ...captions[1], start: 6, end: 9.1 },
      captions[2],
    ];
    const result = repairDurationsFromStarts({
      scenes: broken,
      captions: brokenCaptions,
      audioDurationSec: 19.1,
    });
    expect(result.applied).toBe(true);
    expect(result.scenes[1].durationSec).toBeCloseTo(3.1, 2);
    expect(result.scenes[1].startTime + result.scenes[1].durationSec).toBeCloseTo(result.scenes[2].startTime, 2);
  });

  it('lets a caption end before the next sentence without moving that scene', () => {
    const result = applyBoundaryEdit({
      scenes,
      captions,
      audioDurationSec: 19.1,
      edit: { kind: 'caption-end', cueId: 'cap_01', end: 3.1 },
    });
    expect(result.applied).toBe(true);
    expect(result.captions[0].end).toBeCloseTo(3.1, 2);
    expect(result.scenes[1].startTime).toBeCloseTo(4.89, 2);
    expect(result.scenes[0].durationSec).toBeCloseTo(4.89, 2);
  });

  it('warns when a caption stays unreadably short instead of stealing the next sentence', () => {
    const result = applyBoundaryEdit({
      scenes: [
        { sceneId: 'lng_01', startTime: 0, durationSec: 11 },
        { sceneId: 'lng_02', startTime: 11, durationSec: 0.29 },
        { sceneId: 'lng_03', startTime: 11.29, durationSec: 8.71 },
      ],
      captions: [
        { cueId: 'cap_01', sceneId: 'lng_01', start: 0, end: 11 },
        { cueId: 'cap_02', sceneId: 'lng_02', start: 11, end: 11.29 },
        { cueId: 'cap_03', sceneId: 'lng_03', start: 11.29, end: 20 },
      ],
      audioDurationSec: 20,
      edit: { kind: 'caption-start', cueId: 'cap_02', start: 11 },
    });
    expect(result.applied).toBe(true);
    expect(result.captions[1].end - result.captions[1].start).toBeLessThan(0.45);
    expect(result.captions[1].end).toBeLessThanOrEqual(result.captions[2].start + 0.001);
    expect(result.warnings.join(' ')).toContain('0.29s');
  });

  it('keeps manual edits unless replacement is explicit', () => {
    const proposal = {
      available: true,
      method: 'speech_intervals' as const,
      sourceLabel: 'Pause-aware estimate',
      detail: 'Sentence times follow measured pauses. This is not word-accurate alignment and not acoustically verified.',
      acousticVerification: false as const,
      verified: false as const,
      silenceCount: 1,
      warnings: [],
      rows: [
        { sceneId: 'lng_01', cueId: 'cap_01', text: 'one', userEdited: false, proposedStart: 0, proposedDurationSec: 4, proposedCaptionStart: 0, proposedCaptionEnd: 3.5, warnings: [] },
        { sceneId: 'lng_02', cueId: 'cap_02', text: 'two', userEdited: true, proposedStart: 4, proposedDurationSec: 3, proposedCaptionStart: 4, proposedCaptionEnd: 6.5, warnings: [] },
        { sceneId: 'lng_03', cueId: 'cap_03', text: 'three', userEdited: false, proposedStart: 7, proposedDurationSec: 2, proposedCaptionStart: 7, proposedCaptionEnd: 9, warnings: [] },
      ],
    };
    const currentScenes = [
      { sceneId: 'lng_01', startTime: 0, durationSec: 4.2, narration: 'one', userEdited: false },
      { sceneId: 'lng_02', startTime: 4.2, durationSec: 2.6, narration: 'two', userEdited: true },
      { sceneId: 'lng_03', startTime: 6.8, durationSec: 2.2, narration: 'three', userEdited: false },
    ];
    const currentCaptions = [
      { cueId: 'cap_01', sceneId: 'lng_01', start: 0, end: 3.5, text: 'one', userEdited: false },
      { cueId: 'cap_02', sceneId: 'lng_02', start: 4.2, end: 6.8, text: 'two', userEdited: true },
      { cueId: 'cap_03', sceneId: 'lng_03', start: 6.8, end: 9, text: 'three', userEdited: false },
    ];
    const kept = applyNarrationProposal({
      audioDurationSec: 9,
      includeManual: false,
      currentScenes,
      currentCaptions,
      proposal,
    });
    expect(kept.ok).toBe(true);
    expect(kept.scenes[1].startTime).toBe(4.2);
    expect(kept.captions[1].start).toBe(4.2);
    expect(kept.scenes[0].startTime).toBe(0);
    const replaced = applyNarrationProposal({
      audioDurationSec: 9,
      includeManual: true,
      currentScenes,
      currentCaptions,
      proposal,
    });
    expect(replaced.ok).toBe(true);
    expect(replaced.scenes[1].startTime).toBe(4);
    const blocked = applyNarrationProposal({
      audioDurationSec: 9,
      includeManual: false,
      currentScenes,
      currentCaptions,
      proposal: { ...proposal, available: false, method: 'unavailable', rows: [] },
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.scenes[1].startTime).toBe(4.2);
  });

  it('preserves reviewed timings across a storyboard rebuild when the words are unchanged', () => {
    const previousScenes = [
      { id: 'lng_01', narration: 'one', startTime: 0, duration: 5, userEdited: true },
      { id: 'lng_02', narration: 'two', startTime: 5, duration: 4, userEdited: true },
    ];
    const previousCaptions = [
      { id: 'cap_01', sceneId: 'lng_01', text: 'one', start: 0, end: 5, userEdited: true },
      { id: 'cap_02', sceneId: 'lng_02', text: 'two', start: 5, end: 9, userEdited: true },
    ];
    const kept = preserveReviewedExternalTiming({
      previousScenes,
      previousCaptions,
      nextScenes: [
        { id: 'lng_01', narration: 'one', startTime: 0, duration: 3, userEdited: false },
        { id: 'lng_02', narration: 'two', startTime: 3, duration: 6, userEdited: false },
      ],
      nextCaptions: [
        { id: 'cap_01', sceneId: 'lng_01', text: 'one', start: 0, end: 3, userEdited: false },
        { id: 'cap_02', sceneId: 'lng_02', text: 'two', start: 3, end: 9, userEdited: false },
      ],
      audioDurationSec: 9,
    });
    expect(kept.scenes[1].startTime).toBe(5);
    expect(kept.captions[1].start).toBe(5);
    expect(kept.warning).toContain('kept');
    const changedWords = preserveReviewedExternalTiming({
      previousScenes,
      previousCaptions,
      nextScenes: [
        { id: 'lng_01', narration: 'different', startTime: 0, duration: 4, userEdited: false },
        { id: 'lng_02', narration: 'two', startTime: 4, duration: 5, userEdited: false },
      ],
      nextCaptions: previousCaptions.map((cue) => ({ ...cue, userEdited: false })),
      audioDurationSec: 9,
    });
    expect(changedWords.scenes[0].narration).toBe('different');
    expect(changedWords.scenes[0].startTime).toBe(0);
  });
});
