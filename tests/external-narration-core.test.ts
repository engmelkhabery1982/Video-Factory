/**
 * VS4 — external narration contract (core, pure).
 *
 * Every rule that decides whether imported narration may be exported lives in
 * `packages/core/src/scenario/external-narration.ts` and is exercised here
 * without any I/O: the declaration, the script digest, the artifact digest, the
 * speaker identity, the timing/alignment revision, the timeline coverage and
 * the per-turn dialogue rules.
 *
 * No engine is involved anywhere in this file — that is the point of the
 * workflow these rules protect.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateExternalDialogueCoverage,
  evaluateExternalNarrationApproval,
  evaluateExternalNarrationReadiness,
  evaluateExternalNarrationTiming,
  externalNarrationIntendedSpokenSha256,
  externalNarrationScriptSha256,
  externalNarrationTimingRevision,
  type ExternalDialogueTurnImport,
  type ExternalNarrationAlignment,
  type ExternalNarrationApproval,
  type ExternalNarrationImport,
  type TargetId,
} from '@buildtrack/core';

const PROJECT = 'Video_01';
const TARGET: TargetId = 'long';
const SCRIPT = 'Every site supervisor knows that safety inspections take time and discipline.';
const SCRIPT_SHA = externalNarrationScriptSha256(SCRIPT);
const ARTIFACT_SHA = 'a'.repeat(64);
const OTHER_ARTIFACT_SHA = 'b'.repeat(64);

const ALIGNED: ExternalNarrationAlignment = {
  mode: 'exact_scene_timing',
  verified: true,
  sceneCount: 3,
  detail: 'measured per-scene timing',
};

const ESTIMATED: ExternalNarrationAlignment = {
  mode: 'estimated_from_script',
  verified: false,
  sceneCount: null,
  detail: 'estimated from the script',
};

function makeImport(overrides: Partial<ExternalNarrationImport> = {}): ExternalNarrationImport {
  return {
    importId: 'imp_abcdef01',
    projectId: PROJECT,
    targetId: TARGET,
    fileName: 'narration.wav',
    storedRef: 'voiceover/Video_01_long_ab12cd.wav',
    mimeType: 'audio/wav',
    byteSize: 12345,
    sha256: ARTIFACT_SHA,
    durationSec: 62.4,
    durationSource: 'ffprobe',
    scriptText: SCRIPT,
    scriptSha256: SCRIPT_SHA,
    declaration: {
      sourceKind: 'authorized_external_synthesis',
      ownershipConfirmed: true,
      ownershipStatement: 'Licensed vendor, invoice 1234',
      speakerName: 'Operator voice',
      speakerId: 'narrator',
      engineName: 'Chatterbox',
      modelName: 'turbo',
      voiceName: 'clone-a',
    },
    alignment: ESTIMATED,
    createdAt: '2026-10-08T10:00:00.000Z',
    ...overrides,
  };
}

function revisionFor(overrides: Partial<Parameters<typeof externalNarrationTimingRevision>[0]> = {}): string {
  return externalNarrationTimingRevision({
    projectId: PROJECT,
    targetId: TARGET,
    artifactSha256: ARTIFACT_SHA,
    scriptSha256: SCRIPT_SHA,
    audioDurationSec: 62.4,
    alignment: ESTIMATED,
    timelineDurationSec: 62.7,
    endCardSeconds: 8,
    ...overrides,
  });
}

function makeApproval(overrides: Partial<ExternalNarrationApproval> = {}): ExternalNarrationApproval {
  return {
    decision: 'approved',
    importId: 'imp_abcdef01',
    projectId: PROJECT,
    targetId: TARGET,
    artifactSha256: ARTIFACT_SHA,
    scriptSha256: SCRIPT_SHA,
    speakerId: 'narrator',
    timingRevision: revisionFor(),
    listened: true,
    decidedAt: '2026-10-08T10:05:00.000Z',
    decidedBy: 'project-owner',
    ...overrides,
  };
}

function evaluateApproval(overrides: Partial<Parameters<typeof evaluateExternalNarrationApproval>[0]> = {}) {
  return evaluateExternalNarrationApproval({
    projectId: PROJECT,
    targetId: TARGET,
    import: makeImport(),
    currentArtifactSha256: ARTIFACT_SHA,
    approval: makeApproval(),
    currentSpeakerId: 'narrator',
    currentTimingRevision: revisionFor(),
    ...overrides,
  });
}

function codes(result: { findings: { code: string }[] }): string[] {
  return result.findings.map((f) => f.code);
}

describe('VS4: imported narration approval is bound to the exact facts', () => {
  it('approves a fully declared, listened-to, current import', () => {
    const result = evaluateApproval();
    expect(result.allowed).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('blocks when nothing was imported', () => {
    const result = evaluateApproval({ import: null, approval: null });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-MISSING');
  });

  it('blocks an import without a source declaration', () => {
    const result = evaluateApproval({
      import: makeImport({
        declaration: { ...makeImport().declaration, sourceKind: undefined as never },
      }),
    });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-DECLARATION-INCOMPLETE');
  });

  it('blocks an import whose ownership was never confirmed', () => {
    const result = evaluateApproval({
      import: makeImport({
        declaration: { ...makeImport().declaration, ownershipConfirmed: false, ownershipStatement: '' },
      }),
    });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-OWNERSHIP-UNCONFIRMED');
  });

  it('blocks an import without the exact spoken script', () => {
    const result = evaluateApproval({ import: makeImport({ scriptText: '  ', scriptSha256: '' }) });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-SCRIPT-MISSING');
  });

  it('blocks an import whose duration was never measured', () => {
    const result = evaluateApproval({ import: makeImport({ durationSec: 0 }) });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-DURATION-UNKNOWN');
  });

  it('blocks an import whose file is no longer readable', () => {
    const result = evaluateApproval({ currentArtifactSha256: null });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-ARTIFACT-MISSING');
  });

  it('blocks when the import was never approved', () => {
    const result = evaluateApproval({ approval: null });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-APPROVAL-MISSING');
  });

  it('blocks an approval that was never listened to', () => {
    const result = evaluateApproval({ approval: makeApproval({ listened: false }) });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-LISTENING-NOT-CONFIRMED');
  });

  it('blocks a rejected approval', () => {
    const result = evaluateApproval({ approval: makeApproval({ decision: 'rejected' }) });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-APPROVAL-REJECTED');
  });

  it('invalidates the approval when the audio file is replaced', () => {
    const result = evaluateApproval({ currentArtifactSha256: OTHER_ARTIFACT_SHA });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-APPROVAL-STALE-ARTIFACT');
  });

  it('invalidates the approval when the spoken script changes', () => {
    const changed = externalNarrationScriptSha256('A different script entirely.');
    const result = evaluateApproval({
      import: makeImport({ scriptText: 'A different script entirely.', scriptSha256: changed }),
    });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-APPROVAL-STALE-SCRIPT');
  });

  it('invalidates the approval when the speaker assignment changes', () => {
    const result = evaluateApproval({ currentSpeakerId: 'other_narrator' });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-APPROVAL-STALE-SPEAKER');
  });

  it('invalidates the approval when the timing/alignment revision changes', () => {
    const result = evaluateApproval({ currentTimingRevision: revisionFor({ timelineDurationSec: 70 }) });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-APPROVAL-STALE-TIMING');
  });

  it('never lets an approval of another target count for this one', () => {
    const result = evaluateApproval({ approval: makeApproval({ targetId: 'short_1' as TargetId }) });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-APPROVAL-STALE-TARGET');
  });

  it('binds the approval to the project as well as the target', () => {
    const result = evaluateApproval({ approval: makeApproval({ projectId: 'Video_99' }) });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-APPROVAL-STALE-TARGET');
  });
});

describe('VS4: the timeline must cover the measured audio', () => {
  function timing(overrides: Partial<Parameters<typeof evaluateExternalNarrationTiming>[0]> = {}) {
    return evaluateExternalNarrationTiming({
      targetId: TARGET,
      audioDurationSec: 62.4,
      timelineDurationSec: 62.7,
      endCardSeconds: 8,
      approvedTimingRevision: null,
      currentTimingRevision: revisionFor(),
      alignment: ESTIMATED,
      planRegeneratedForAudio: true,
      ...overrides,
    });
  }

  it('accepts a timeline that covers the audio plus the end card', () => {
    expect(timing().allowed).toBe(true);
  });

  it('blocks a timeline shorter than the audio (the final words would be cut)', () => {
    const result = timing({ timelineDurationSec: 55 });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('TIMING-TIMELINE-SHORTER-THAN-AUDIO');
  });

  it('warns when the timeline runs far past the audio beyond the end card', () => {
    const result = timing({ timelineDurationSec: 90 });
    expect(result.allowed).toBe(true);
    expect(codes(result)).toContain('TIMING-TIMELINE-LONGER-THAN-AUDIO');
  });

  it('blocks a plan that was never regenerated after the import', () => {
    const result = timing({ planRegeneratedForAudio: false });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('TIMING-STALE-PLAN');
  });

  it('reports estimated alignment as a warning and never as verified', () => {
    const result = timing({ alignment: ESTIMATED });
    expect(result.allowed).toBe(true);
    expect(codes(result)).toContain('TIMING-ALIGNMENT-ESTIMATED');
    expect(result.findings.find((f) => f.code === 'TIMING-ALIGNMENT-ESTIMATED')?.severity).toBe('warning');
  });

  it('reports missing alignment honestly', () => {
    const result = timing({ alignment: null });
    expect(codes(result)).toContain('TIMING-ALIGNMENT-MISSING');
  });

  it('adds no alignment warning for measured per-scene timing', () => {
    const result = timing({ alignment: ALIGNED });
    expect(codes(result)).not.toContain('TIMING-ALIGNMENT-ESTIMATED');
    expect(codes(result)).not.toContain('TIMING-ALIGNMENT-MISSING');
  });

  it('detects a timing revision that changed after approval', () => {
    const result = timing({ approvedTimingRevision: 'different-revision' });
    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain('IMPORT-APPROVAL-STALE-TIMING');
  });

  it('derives the same revision from the same facts and a different one when the audio changes', () => {
    expect(revisionFor()).toBe(revisionFor());
    expect(revisionFor({ artifactSha256: OTHER_ARTIFACT_SHA })).not.toBe(revisionFor());
    expect(revisionFor({ alignment: ALIGNED })).not.toBe(revisionFor());
    expect(revisionFor({ audioDurationSec: 70 })).not.toBe(revisionFor());
    expect(revisionFor({ scriptSha256: 'd'.repeat(64) })).not.toBe(revisionFor());
    expect(revisionFor({ targetId: 'short_1' as TargetId })).not.toBe(revisionFor());
  });
});

describe('VS4: readiness combines declaration, approval and timing', () => {
  it('is ready only when every rule passes', () => {
    const readiness = evaluateExternalNarrationReadiness({
      projectId: PROJECT,
      targetId: TARGET,
      import: makeImport({ alignment: ALIGNED }),
      currentArtifactSha256: ARTIFACT_SHA,
      approval: makeApproval({ timingRevision: revisionFor({ alignment: ALIGNED }) }),
      currentSpeakerId: 'narrator',
      timing: {
        targetId: TARGET,
        audioDurationSec: 62.4,
        timelineDurationSec: 62.7,
        endCardSeconds: 8,
        approvedTimingRevision: revisionFor({ alignment: ALIGNED }),
        currentTimingRevision: revisionFor({ alignment: ALIGNED }),
        alignment: ALIGNED,
        planRegeneratedForAudio: true,
      },
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.blockReasons).toHaveLength(0);
  });

  it('lists every blocking reason of a blocked target', () => {
    const readiness = evaluateExternalNarrationReadiness({
      projectId: PROJECT,
      targetId: TARGET,
      import: makeImport({ durationSec: 0 }),
      currentArtifactSha256: OTHER_ARTIFACT_SHA,
      approval: makeApproval(),
      currentSpeakerId: 'narrator',
      timing: {
        targetId: TARGET,
        audioDurationSec: 62.4,
        timelineDurationSec: 40,
        endCardSeconds: 8,
        approvedTimingRevision: makeApproval().timingRevision,
        currentTimingRevision: revisionFor(),
        alignment: ESTIMATED,
        planRegeneratedForAudio: false,
      },
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockReasons.length).toBeGreaterThan(1);
    expect(readiness.blockReasons.some((r) => r.includes('shorter than the imported narration'))).toBe(true);
  });
});

describe('VS4: per-turn dialogue imports never imply per-speaker verification', () => {
  const expectations = [
    { sceneId: 'scn_1', turnId: 'turn_1', speakerId: 'narrator', spokenText: 'First line.' },
    { sceneId: 'scn_1', turnId: 'turn_2', speakerId: 'expert', spokenText: 'Second line.' },
  ];

  function clip(overrides: Partial<ExternalDialogueTurnImport> = {}): ExternalDialogueTurnImport {
    return {
      importId: 'ext_abcdef01',
      projectId: PROJECT,
      scenarioId: 'Scenario_01',
      sceneId: 'scn_1',
      turnId: 'turn_1',
      speakerId: 'narrator',
      speakerName: 'Operator voice',
      spokenText: 'First line.',
      spokenTextSha256: externalNarrationScriptSha256('First line.'),
      storedRef: '.production/Video_01/audio/dialogue/ext_abcdef01.wav',
      sha256: 'c'.repeat(64),
      durationSec: 2.5,
      combinedTrack: false,
      createdAt: '2026-10-08T10:00:00.000Z',
      ...overrides,
    };
  }

  it('verifies a per-turn clip bound to the right speaker and text', () => {
    const result = evaluateExternalDialogueCoverage(expectations, [clip()]);
    expect(result.coveredTurns).toBe(1);
    expect(result.coverage[0].verifiedPerSpeaker).toBe(true);
    expect(result.findings.some((f) => f.code === 'DIALOGUE-TURN-CLIP-MISSING')).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it('verifies every turn when each has its own clip', () => {
    const result = evaluateExternalDialogueCoverage(expectations, [
      clip(),
      clip({
        importId: 'ext_abcdef02',
        turnId: 'turn_2',
        speakerId: 'expert',
        speakerName: 'Expert',
        spokenText: 'Second line.',
        spokenTextSha256: externalNarrationScriptSha256('Second line.'),
      }),
    ]);
    expect(result.allowed).toBe(true);
    expect(result.coveredTurns).toBe(2);
    expect(result.coverage.every((c) => c.verifiedPerSpeaker)).toBe(true);
  });

  it('never treats a combined track as verified per-speaker audio', () => {
    const result = evaluateExternalDialogueCoverage(expectations, [
      clip({ combinedTrack: true }),
      clip({
        importId: 'ext_abcdef02',
        turnId: 'turn_2',
        speakerId: 'expert',
        spokenText: 'Second line.',
        spokenTextSha256: externalNarrationScriptSha256('Second line.'),
        combinedTrack: true,
      }),
    ]);
    expect(result.coverage.every((c) => c.covered && !c.verifiedPerSpeaker)).toBe(true);
    expect(result.findings.filter((f) => f.code === 'DIALOGUE-COMBINED-TRACK-NOT-PER-SPEAKER')).toHaveLength(2);
    expect(result.allowed).toBe(false);
  });

  it('blocks a clip whose spoken text does not match the turn', () => {
    const result = evaluateExternalDialogueCoverage(expectations, [
      clip({ spokenText: 'Something else entirely.', spokenTextSha256: externalNarrationScriptSha256('Something else entirely.') }),
    ]);
    expect(codes(result)).toContain('DIALOGUE-TURN-TEXT-MISMATCH');
  });

  it('blocks a clip bound to the wrong speaker', () => {
    const result = evaluateExternalDialogueCoverage(expectations, [clip({ speakerId: 'expert' })]);
    expect(codes(result)).toContain('DIALOGUE-TURN-SPEAKER-MISMATCH');
  });

  it('blocks a clip with no measured duration', () => {
    const result = evaluateExternalDialogueCoverage(expectations, [clip({ durationSec: 0 })]);
    expect(codes(result)).toContain('DIALOGUE-DURATION-UNKNOWN');
  });
});

describe('post-VS7: intended spoken identity is not the imported transcript', () => {
  const approved = externalNarrationIntendedSpokenSha256({
    targetId: 'long',
    projectScript: SCRIPT,
    narration: ['scene one', 'scene two'],
  });

  it('stales a long approval when the project script changes and leaves the import transcript alone', () => {
    const result = evaluateApproval({
      approval: makeApproval({ intendedSpokenSha256: approved }),
      currentIntendedSpokenSha256: externalNarrationIntendedSpokenSha256({
        targetId: 'long',
        projectScript: 'A different spoken script.',
        narration: ['scene one', 'scene two'],
      }),
    });
    expect(codes(result)).toContain('IMPORT-APPROVAL-STALE-INTENDED-SCRIPT');
    expect(codes(result)).not.toContain('IMPORT-APPROVAL-STALE-SCRIPT');
  });

  it('matches again when the same spoken content is restored', () => {
    const result = evaluateApproval({
      approval: makeApproval({ intendedSpokenSha256: approved }),
      currentIntendedSpokenSha256: approved,
    });
    expect(codes(result)).not.toContain('IMPORT-APPROVAL-STALE-INTENDED-SCRIPT');
  });

  it('does not compare a short narration with the long script', () => {
    const short = externalNarrationIntendedSpokenSha256({
      targetId: 'short_1',
      projectScript: 'This long script must not be part of the short identity.',
      narration: ['A different short narration.'],
    });
    const sameNarrationDifferentLongScript = externalNarrationIntendedSpokenSha256({
      targetId: 'short_1',
      projectScript: 'Completely different long script.',
      narration: ['A different short narration.'],
    });
    expect(short).toBe(sameNarrationDifferentLongScript);
    const longFromSameWords = externalNarrationIntendedSpokenSha256({
      targetId: 'long',
      projectScript: 'A different short narration.',
      narration: ['A different short narration.'],
    });
    expect(longFromSameWords).not.toBe(short);
  });
});
