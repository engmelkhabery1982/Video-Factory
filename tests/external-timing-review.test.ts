/**
 * VS5 — pure timing-review contract.
 *
 * Estimates stay labelled as estimates. A word-for-word timing file is a
 * structural match, not acoustic verification. Manual approval is a separate
 * fact, bound to the audio digest, the spoken script and the caption/scene
 * revision.
 */
import { describe, expect, it } from 'vitest';
import {
  describeTimingReview,
  evaluateExternalTimingApproval,
  externalNarrationSpeechTimingRevision,
  speechEndSec,
  validateSpeechTiming,
  type ExternalNarrationTimingApproval,
  type SpeechTimingSnapshot,
} from '@buildtrack/core';

const PROJECT = 'Video_01';
const ARTIFACT = 'a'.repeat(64);
const SCRIPT = 'b'.repeat(64);

function snapshot(overrides: Partial<SpeechTimingSnapshot> = {}): SpeechTimingSnapshot {
  return {
    projectId: PROJECT,
    targetId: 'long',
    artifactSha256: ARTIFACT,
    scriptSha256: SCRIPT,
    audioDurationSec: 10,
    endCardSeconds: 8,
    scenes: [
      { sceneId: 's1', startTime: 0, durationSec: 4, narration: 'First sentence.', role: 'hook' },
      { sceneId: 's2', startTime: 4, durationSec: 6, narration: 'Second sentence.', role: 'body' },
      { sceneId: 'end', startTime: 10, durationSec: 2, narration: '', role: 'endcard' },
    ],
    captions: [
      { cueId: 'c1', sceneId: 's1', start: 0.1, end: 3.8, text: 'First sentence.' },
      { cueId: 'c2', sceneId: 's2', start: 4.1, end: 9.5, text: 'Second sentence.' },
    ],
    ...overrides,
  };
}

function validate(next: SpeechTimingSnapshot = snapshot()) {
  return validateSpeechTiming({
    snapshot: next,
    ownedSceneIds: ['s1', 's2', 'end'],
    ownedCueIds: ['c1', 'c2'],
    storedNarrationByScene: { s1: 'First sentence.', s2: 'Second sentence.', end: '' },
    storedCaptionTextByCue: { c1: 'First sentence.', c2: 'Second sentence.' },
  });
}

function approval(overrides: Partial<ExternalNarrationTimingApproval> = {}): ExternalNarrationTimingApproval {
  return {
    decision: 'approved',
    projectId: PROJECT,
    targetId: 'long',
    artifactSha256: ARTIFACT,
    scriptSha256: SCRIPT,
    speechTimingRevision: externalNarrationSpeechTimingRevision(snapshot()),
    reviewed: true,
    decidedAt: '2026-10-08T00:00:00.000Z',
    decidedBy: 'project-owner',
    ...overrides,
  };
}

describe('VS5: timing source labels stay honest', () => {
  it('labels proportional timing as estimated and not acoustically verified', () => {
    const described = describeTimingReview({
      alignment: { mode: 'estimated_from_script', verified: false, sceneCount: null, detail: 'estimate' },
      approval: null,
      validationAllowed: true,
      approvalAllowed: false,
    });
    expect(described.source).toBe('estimated');
    expect(described.sourceLabel).toBe('Estimated timing');
    expect(described.acousticVerification).toBe(false);
    expect(described.detail.toLowerCase()).not.toContain('acoustically verified');
    expect(described.detail.toLowerCase()).toContain('not word-accurate');
  });

  it('labels a matching timing file as structural, not as a listening check', () => {
    const described = describeTimingReview({
      alignment: { mode: 'exact_scene_timing', verified: true, sceneCount: 2, detail: 'match' },
      approval: null,
      validationAllowed: true,
      approvalAllowed: false,
    });
    expect(described.source).toBe('imported_structural');
    expect(described.sourceLabel).toBe('Script-matched timing');
    expect(described.acousticVerification).toBe(false);
    expect(described.detail.toLowerCase()).toContain('not proof that anyone listened');
  });

  it('labels an explicit review as manually approved', () => {
    const described = describeTimingReview({
      alignment: { mode: 'estimated_from_script', verified: false, sceneCount: null, detail: 'estimate' },
      approval: approval(),
      validationAllowed: true,
      approvalAllowed: true,
    });
    expect(described.review).toBe('approved');
    expect(described.reviewLabel).toBe('Timing approved');
    expect(described.detail.toLowerCase()).toContain('estimates');
  });

  it('labels a mismatched approval as stale and an invalid plan as invalid', () => {
    const stale = describeTimingReview({
      alignment: null,
      approval: approval({ speechTimingRevision: 'other' }),
      validationAllowed: true,
      approvalAllowed: false,
    });
    expect(stale.review).toBe('stale');
    const invalid = describeTimingReview({
      alignment: null,
      approval: null,
      validationAllowed: false,
      approvalAllowed: false,
    });
    expect(invalid.review).toBe('invalid');
  });
});

describe('VS5: speech timing validation', () => {
  it('accepts a timeline that covers the audio and keeps a silent end card after speech', () => {
    expect(validate().allowed).toBe(true);
    expect(speechEndSec(snapshot().scenes)).toBe(10);
  });

  it('rejects negative, NaN, infinite and reversed times', () => {
    const negative = snapshot();
    negative.captions[0] = { ...negative.captions[0], start: -1, end: 2 };
    expect(validate(negative).blocking.map((item) => item.code)).toContain('TIMING-TIME-INVALID');

    const nan = snapshot();
    nan.scenes[0] = { ...nan.scenes[0], startTime: Number.NaN };
    expect(validate(nan).blocking.map((item) => item.code)).toContain('TIMING-TIME-INVALID');

    const infinite = snapshot();
    infinite.scenes[1] = { ...infinite.scenes[1], durationSec: Number.POSITIVE_INFINITY };
    expect(validate(infinite).blocking.map((item) => item.code)).toContain('TIMING-TIME-INVALID');

    const reversed = snapshot();
    reversed.captions[1] = { ...reversed.captions[1], start: 9, end: 4 };
    expect(validate(reversed).blocking.map((item) => item.code)).toContain('TIMING-TIME-INVALID');
  });

  it('rejects times past the end-card allowance', () => {
    const next = snapshot();
    next.scenes[2] = { ...next.scenes[2], durationSec: 20 };
    expect(validate(next).blocking.map((item) => item.code)).toContain('TIMING-OUT-OF-BOUNDS');
  });

  it('rejects unintended caption overlap and scene gaps or overlaps', () => {
    const overlap = snapshot();
    overlap.captions[1] = { ...overlap.captions[1], start: 3 };
    expect(validate(overlap).blocking.map((item) => item.code)).toContain('TIMING-CUE-OVERLAP');

    const gap = snapshot();
    gap.scenes[1] = { ...gap.scenes[1], startTime: 5 };
    expect(validate(gap).blocking.map((item) => item.code)).toContain('TIMING-SCENE-GAP');

    const sceneOverlap = snapshot();
    sceneOverlap.scenes[1] = { ...sceneOverlap.scenes[1], startTime: 3 };
    expect(validate(sceneOverlap).blocking.map((item) => item.code)).toContain('TIMING-SCENE-OVERLAP');
  });

  it('rejects a missing scene and a cue from another target', () => {
    const missing = snapshot();
    missing.scenes = missing.scenes.filter((scene) => scene.sceneId !== 's2');
    expect(validate(missing).blocking.map((item) => item.code)).toContain('TIMING-SCENE-COVERAGE');

    const foreign = snapshot();
    foreign.captions = [...foreign.captions, { cueId: 'long_cue', sceneId: 'long_scene', start: 0, end: 1, text: 'Long only' }];
    const result = validateSpeechTiming({
      snapshot: foreign,
      ownedSceneIds: ['s1', 's2', 'end'],
      ownedCueIds: ['c1', 'c2'],
      storedNarrationByScene: { s1: 'First sentence.', s2: 'Second sentence.', end: '' },
      storedCaptionTextByCue: { c1: 'First sentence.', c2: 'Second sentence.' },
    });
    expect(result.blocking.map((item) => item.code)).toContain('TIMING-TARGET-MISMATCH');
  });

  it('rejects a timing edit that deletes spoken words', () => {
    const next = snapshot();
    next.scenes[0] = { ...next.scenes[0], narration: 'First.' };
    next.captions[1] = { ...next.captions[1], text: '' };
    const codes = validate(next).blocking.map((item) => item.code);
    expect(codes.filter((code) => code === 'TIMING-SCRIPT-ALTERED').length).toBe(2);
  });

  it('rejects an end card that is created by cutting the final speech', () => {
    const next = snapshot();
    next.scenes[1] = { ...next.scenes[1], durationSec: 4 };
    next.scenes[2] = { ...next.scenes[2], startTime: 8, durationSec: 4 };
    expect(validate(next).blocking.map((item) => item.code)).toContain('TIMING-SPEECH-SHORTER-THAN-AUDIO');
  });

  it('allows an end-card extension that leaves the spoken scenes intact', () => {
    const next = snapshot();
    next.scenes[2] = { ...next.scenes[2], durationSec: 4 };
    expect(validate(next).allowed).toBe(true);
    expect(speechEndSec(next.scenes)).toBe(10);
  });
});

describe('VS5: timing approval binding', () => {
  it('binds approval to the current revision and rejects a missing one', () => {
    expect(evaluateExternalTimingApproval({
      projectId: PROJECT,
      targetId: 'long',
      artifactSha256: ARTIFACT,
      scriptSha256: SCRIPT,
      speechTimingRevision: approval().speechTimingRevision,
      approval: approval(),
    }).allowed).toBe(true);
    expect(evaluateExternalTimingApproval({
      projectId: PROJECT,
      targetId: 'long',
      artifactSha256: ARTIFACT,
      scriptSha256: SCRIPT,
      speechTimingRevision: approval().speechTimingRevision,
      approval: null,
    }).blocking.map((item) => item.code)).toContain('TIMING-APPROVAL-MISSING');
  });

  it('rejects a mismatched digest, script, target or revision', () => {
    const base = {
      projectId: PROJECT,
      targetId: 'long' as const,
      artifactSha256: ARTIFACT,
      scriptSha256: SCRIPT,
      speechTimingRevision: approval().speechTimingRevision,
    };
    expect(evaluateExternalTimingApproval({ ...base, approval: approval({ artifactSha256: 'c'.repeat(64) }) }).blocking.map((item) => item.code)).toContain('TIMING-APPROVAL-STALE');
    expect(evaluateExternalTimingApproval({ ...base, approval: approval({ scriptSha256: 'd'.repeat(64) }) }).blocking.map((item) => item.code)).toContain('TIMING-APPROVAL-STALE');
    expect(evaluateExternalTimingApproval({ ...base, approval: approval({ targetId: 'short_1' }) }).blocking.map((item) => item.code)).toContain('TIMING-TARGET-MISMATCH');
    const moved = snapshot();
    moved.captions[0] = { ...moved.captions[0], end: 3.2 };
    expect(evaluateExternalTimingApproval({
      ...base,
      speechTimingRevision: externalNarrationSpeechTimingRevision(moved),
      approval: approval(),
    }).blocking.map((item) => item.code)).toContain('TIMING-APPROVAL-STALE');
  });

  it('does not change the speech revision when only a visual field would have changed', () => {
    const left = externalNarrationSpeechTimingRevision(snapshot());
    const right = externalNarrationSpeechTimingRevision(snapshot());
    expect(left).toBe(right);
    const moved = snapshot();
    moved.scenes[0] = { ...moved.scenes[0], durationSec: 4.2 };
    moved.scenes[1] = { ...moved.scenes[1], startTime: 4.2, durationSec: 5.8 };
    expect(externalNarrationSpeechTimingRevision(moved)).not.toBe(left);
  });
});
