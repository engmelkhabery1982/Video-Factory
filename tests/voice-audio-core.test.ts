/**
 * VS3 — Voice & Audio CORE contract suite (pure, deterministic).
 *
 * These tests cover the pure half of the VS3 workflow: engine availability
 * truthfulness, reference checks, the bridge to the SHIPPED VS1 publication
 * gate, artifact-bound approval, invalidation and the cloned-audio render gate.
 * No I/O, no clock, no network, no engine: every input is authored here.
 *
 * The three facts (legal authorization, reference approval, generated-audio
 * approval) are asserted to stay separate, and no test is allowed to pass by
 * weakening a rule: where something must block, it blocks.
 */
import { describe, expect, it } from 'vitest';
import {
  VOICE_AUDIO_ENGINE_IDS,
  buildReferencePublicationProfile,
  checkVoiceReference,
  evaluateClonedAudioRenderGate,
  evaluateReferencePublicationProfile,
  evaluateVoiceAudioPreviewApproval,
  toPublicVoiceReference,
  voiceAudioEngineStatus,
  voiceAudioEngineStatuses,
  voiceAudioIdentityDigest,
  voiceAudioTiming,
  voicePreviewTextSha256,
  type VoiceAudioAssignment,
  type VoiceAudioEngineFacts,
  type VoiceReferenceRecord,
} from '../packages/core/src/scenario/voice-audio-approval.js';

const CHATTERBOX_MODEL = 'ResembleAI/chatterbox';
const REVISION = 'abcdef0123456789abcdef0123456789abcdef01';
const REF_SHA = 'a'.repeat(64);
const NOW = '2026-10-08T12:00:00.000Z';

function facts(overrides: Partial<VoiceAudioEngineFacts> = {}): VoiceAudioEngineFacts {
  return {
    engine: 'chatterbox',
    label: 'Chatterbox voice cloning',
    runtimeInstalled: true,
    provisioned: true,
    deviceSatisfied: true,
    deviceDetail: 'NVIDIA GPU detected.',
    cpuRequiresOptIn: false,
    approvalBlockedCodes: [],
    lastFailure: null,
    provisionRemedy: 'npm run provision:voice-clone -- --apply',
    ...overrides,
  };
}

function assignment(overrides: Partial<VoiceAudioAssignment> = {}): VoiceAudioAssignment {
  return {
    speakerId: 'narrator',
    engine: 'chatterbox',
    engineId: VOICE_AUDIO_ENGINE_IDS.chatterbox,
    modelId: CHATTERBOX_MODEL,
    modelRevision: REVISION,
    settingsDigest: null,
    referenceId: 'ref_1',
    referenceSha256: REF_SHA,
    presetVoiceId: null,
    ...overrides,
  };
}

function reference(overrides: Partial<VoiceReferenceRecord> = {}): VoiceReferenceRecord {
  return {
    referenceId: 'ref_1',
    displayName: 'Operator voice',
    storedRef: 'data/projects/P1/voice-audio/references/ref_1.wav',
    sha256: REF_SHA,
    sizeBytes: 288_044,
    durationSeconds: 6,
    sampleRate: 24_000,
    channels: 1,
    container: 'wav',
    createdAt: NOW,
    authorization: {
      ownerConfirmed: true,
      confirmedBy: 'project-owner',
      confirmedAt: NOW,
      statement: 'This is my own voice and I authorize its use.',
    },
    approval: { state: 'approved', approver: 'project-owner', reviewedAt: NOW },
    consentEvidenceRef: 'data/projects/P1/voice-audio/references/ref_1.consent.json',
    ...overrides,
  };
}

const rights = {
  sourceProvider: 'first-party recording (operator-owned)',
  licenseName: 'First-party own-voice written release',
  evidenceUrl: 'https://rights.example.invalid/own-voice',
  evidenceKind: 'written_permission' as const,
  accessedAt: '2026-10-08',
  commercialUse: 'permitted' as const,
};

const target = {
  engine: 'chatterbox' as const,
  engineId: VOICE_AUDIO_ENGINE_IDS.chatterbox,
  engineFamily: 'chatterbox' as const,
  modelId: CHATTERBOX_MODEL,
  modelRevision: REVISION,
  runtimeId: VOICE_AUDIO_ENGINE_IDS.chatterbox,
  runtimeVersion: '0.1.7',
};

/* ------------------------------------------------------------------ */
/*  A. Engine availability                                             */
/* ------------------------------------------------------------------ */

describe('VS3 core: engine availability is truthful', () => {
  it('reports available only when provisioned AND the device policy is satisfied', () => {
    const status = voiceAudioEngineStatus(facts());
    expect(status.state).toBe('available');
    expect(status.selectable).toBe(true);
    expect(status.generatable).toBe(true);
    expect(status.remedy).toBeNull();
    expect(status.unverifiedPath).toBe(false);
  });

  it('answers not_provisioned with the exact provisioning command', () => {
    const status = voiceAudioEngineStatus(facts({ provisioned: false, runtimeInstalled: false }));
    expect(status.state).toBe('not_provisioned');
    expect(status.selectable).toBe(false);
    expect(status.generatable).toBe(false);
    expect(status.remedy).toBe('npm run provision:voice-clone -- --apply');
    expect(status.detail).toBeTruthy();
  });

  it('answers device_unsupported and marks the CPU path as an unverified opt-in', () => {
    const status = voiceAudioEngineStatus(
      facts({ deviceSatisfied: false, cpuRequiresOptIn: true, deviceDetail: 'No NVIDIA GPU detected.' })
    );
    expect(status.state).toBe('device_unsupported');
    expect(status.selectable).toBe(false);
    expect(status.unverifiedPath).toBe(true);
    expect(status.remedy).toMatch(/CPU/);
  });

  it('answers blocked_by_approval when consent or approval is missing', () => {
    const status = voiceAudioEngineStatus(facts({ approvalBlockedCodes: ['REFERENCE-NOT-APPROVED'] }));
    expect(status.state).toBe('blocked_by_approval');
    expect(status.generatable).toBe(false);
    expect(status.selectable).toBe(true);
    expect(status.remedy).toMatch(/authorization|approv/i);
  });

  it('answers generation_failed with the recorded failure and its remedy', () => {
    const status = voiceAudioEngineStatus(
      facts({ lastFailure: { code: 'CHATTERBOX_WORKER_EXIT_NONZERO', message: 'worker exited 7' } })
    );
    expect(status.state).toBe('generation_failed');
    expect(status.lastFailure?.code).toBe('CHATTERBOX_WORKER_EXIT_NONZERO');
    expect(status.remedy).toMatch(/generate again/i);
  });

  it('never lets a failing engine look selectable, and keeps both engines listed', () => {
    const statuses = voiceAudioEngineStatuses([
      facts(),
      facts({ engine: 'kokoro', label: 'Kokoro 82M presets', provisioned: false }),
    ]);
    expect(statuses.map((s) => s.engine)).toEqual(['chatterbox', 'kokoro']);
    const kokoro = statuses.find((s) => s.engine === 'kokoro')!;
    expect(kokoro.state).toBe('not_provisioned');
    expect(kokoro.selectable).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  B. Reference checks                                                */
/* ------------------------------------------------------------------ */

describe('VS3 core: reference checks keep the three facts separate', () => {
  it('treats a missing reference as blocked, never as a default voice', () => {
    const check = checkVoiceReference(null, null);
    expect(check.allowed).toBe(false);
    expect(check.blockedCodes).toContain('REFERENCE-MISSING');
  });

  it('requires authorization, approval and an intact recording', () => {
    expect(checkVoiceReference(reference(), REF_SHA).allowed).toBe(true);

    const unauthorized = checkVoiceReference(reference({ authorization: null }), REF_SHA);
    expect(unauthorized.allowed).toBe(false);
    expect(unauthorized.blockedCodes).toContain('REFERENCE-NOT-AUTHORIZED');

    const unapproved = checkVoiceReference(
      reference({ approval: { state: 'pending' } }),
      REF_SHA
    );
    expect(unapproved.allowed).toBe(false);
    expect(unapproved.blockedCodes).toContain('REFERENCE-NOT-APPROVED');

    const rejected = checkVoiceReference(
      reference({ approval: { state: 'rejected', approver: 'x', reviewedAt: NOW } }),
      REF_SHA
    );
    expect(rejected.allowed).toBe(false);
    expect(rejected.blockedCodes).toContain('REFERENCE-REJECTED');

    const tampered = checkVoiceReference(reference(), 'b'.repeat(64));
    expect(tampered.allowed).toBe(false);
    expect(tampered.blockedCodes).toContain('REFERENCE-HASH-MISMATCH');
  });

  it('projects a reference publicly without a path or the full hash', () => {
    const json = JSON.stringify(toPublicVoiceReference(reference()));
    expect(json).not.toContain('references/ref_1.wav');
    expect(json).not.toContain(REF_SHA);
    expect(json).toContain(REF_SHA.slice(0, 12));
    const pub = toPublicVoiceReference(reference());
    expect(pub.approved).toBe(true);
    expect(pub.authorized).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  B. The VS1 bridge                                                  */
/* ------------------------------------------------------------------ */

describe('VS3 core: reference approval is decided by the SHIPPED VS1 gate', () => {
  it('allows a first-party own-voice reference that has consent, an artifact and rights', () => {
    const report = evaluateReferencePublicationProfile({
      record: reference(),
      target,
      rights,
      approver: 'project-owner',
      reviewedAt: NOW,
    });
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.allowed).toBe(true);
    expect(report.publicationState).toBe('approved');
    expect(report.engine.engine).toBe('chatterbox');
  });

  it('blocks without commercial-rights evidence: silence is never permission', () => {
    const report = evaluateReferencePublicationProfile({
      record: reference(),
      target,
      rights: null,
      approver: 'project-owner',
      reviewedAt: NOW,
    });
    expect(report.allowed).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('MISSING_RIGHTS_EVIDENCE');
  });

  it('blocks when commercial use is only conditional or not stated', () => {
    for (const commercialUse of ['conditional', 'not_stated', 'unknown'] as const) {
      const report = evaluateReferencePublicationProfile({
        record: reference(),
        target,
        rights: { ...rights, commercialUse },
        approver: 'project-owner',
        reviewedAt: NOW,
      });
      expect(report.allowed).toBe(false);
    }
  });

  it('blocks when the consent artifact is missing (a boolean is not evidence)', () => {
    const report = evaluateReferencePublicationProfile({
      record: reference({ consentEvidenceRef: null }),
      target,
      rights,
      approver: 'project-owner',
      reviewedAt: NOW,
    });
    expect(report.allowed).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('MISSING_CONSENT_EVIDENCE');
  });

  it('blocks when the user never confirmed authorization', () => {
    const report = evaluateReferencePublicationProfile({
      record: reference({ authorization: null }),
      target,
      rights,
      approver: 'project-owner',
      reviewedAt: NOW,
    });
    expect(report.allowed).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('MISSING_CONSENT');
  });

  it('authors a real voice profile the gate can read (id + voiceSlot + publication)', () => {
    const profile = buildReferencePublicationProfile({
      record: reference(),
      target,
      rights,
      approver: 'project-owner',
      reviewedAt: NOW,
    });
    expect(profile.id).toBe('vp_ref_ref_1');
    expect(profile.voiceSlot).toBe('voice_ref_ref_1');
    expect(profile.publication?.acousticSource?.kind).toBe('cloned_reference_audio');
    expect(profile.publication?.consent?.ownerConfirmed).toBe(true);
    expect(profile.publication?.publicationState).toBe('approved');
  });
});

/* ------------------------------------------------------------------ */
/*  C. Preview approval + invalidation                                 */
/* ------------------------------------------------------------------ */

describe('VS3 core: approval is bound to one exact artifact', () => {
  const identity = voiceAudioIdentityDigest({
    projectId: 'P1',
    scriptSha256: voicePreviewTextSha256('Every site supervisor knows.'),
    language: 'en',
    assignments: [assignment()],
  });

  const preview = {
    previewId: 'prv_1',
    identityDigest: identity,
    textSha256: voicePreviewTextSha256('Every site supervisor knows.'),
    status: 'ready' as const,
    artifactRef: 'data/projects/P1/voice-audio/previews/prv_1/preview.wav',
    artifactSha256: 'c'.repeat(64),
    durationSeconds: 3.4,
    language: 'en',
    engineSummary: 'Chatterbox (chatterbox-tts)',
    segments: [
      {
        index: 0,
        speakerId: 'narrator',
        speakerName: 'Narrator',
        engine: 'chatterbox' as const,
        engineId: VOICE_AUDIO_ENGINE_IDS.chatterbox,
        spokenText: 'Every site supervisor knows.',
        textSha256: voicePreviewTextSha256('Every site supervisor knows.'),
        durationSeconds: 3.4,
        outputRef: null,
      },
    ],
    createdAt: NOW,
    completedAt: NOW,
    error: null,
    timing: voiceAudioTiming(3.4),
  };

  const approval = {
    decision: 'approved' as const,
    identityDigest: identity,
    artifactSha256: 'c'.repeat(64),
    approvedAt: NOW,
    approvedBy: 'project-owner',
  };

  it('allows the exact artifact that was approved', () => {
    const evaluation = evaluateVoiceAudioPreviewApproval({
      preview,
      approval,
      currentIdentityDigest: identity,
      currentArtifactSha256: 'c'.repeat(64),
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.findings).toEqual([]);
  });

  it('blocks when nothing was generated yet, or generation is running/failed', () => {
    expect(
      evaluateVoiceAudioPreviewApproval({
        preview: null,
        approval: null,
        currentIdentityDigest: identity,
        currentArtifactSha256: null,
      }).findings.map((f) => f.code)
    ).toContain('PREVIEW-MISSING');

    expect(
      evaluateVoiceAudioPreviewApproval({
        preview: { ...preview, status: 'running' },
        approval: null,
        currentIdentityDigest: identity,
        currentArtifactSha256: null,
      }).findings.map((f) => f.code)
    ).toContain('PREVIEW-RUNNING');

    expect(
      evaluateVoiceAudioPreviewApproval({
        preview: { ...preview, status: 'failed', artifactRef: null, artifactSha256: null },
        approval: null,
        currentIdentityDigest: identity,
        currentArtifactSha256: null,
      }).findings.map((f) => f.code)
    ).toContain('PREVIEW-FAILED');
  });

  it('blocks a missing artifact and an artifact that is not the approved one', () => {
    expect(
      evaluateVoiceAudioPreviewApproval({
        preview,
        approval,
        currentIdentityDigest: identity,
        currentArtifactSha256: null,
      }).findings.map((f) => f.code)
    ).toContain('PREVIEW-ARTIFACT-MISSING');

    expect(
      evaluateVoiceAudioPreviewApproval({
        preview,
        approval,
        currentIdentityDigest: identity,
        currentArtifactSha256: 'd'.repeat(64),
      }).findings.map((f) => f.code)
    ).toContain('APPROVAL-ARTIFACT-MISMATCH');
  });

  it('blocks an approval whose identity no longer matches (script/reference/engine/settings)', () => {
    const staleScript = voiceAudioIdentityDigest({
      projectId: 'P1',
      scriptSha256: voicePreviewTextSha256('Every site supervisor knows. And one more sentence.'),
      language: 'en',
      assignments: [assignment()],
    });
    expect(
      evaluateVoiceAudioPreviewApproval({
        preview,
        approval,
        currentIdentityDigest: staleScript,
        currentArtifactSha256: 'c'.repeat(64),
      }).findings.map((f) => f.code)
    ).toContain('APPROVAL-STALE-IDENTITY');

    const otherReference = voiceAudioIdentityDigest({
      projectId: 'P1',
      scriptSha256: voicePreviewTextSha256('Every site supervisor knows.'),
      language: 'en',
      assignments: [assignment({ referenceId: 'ref_2', referenceSha256: 'b'.repeat(64) })],
    });
    expect(
      evaluateVoiceAudioPreviewApproval({
        preview,
        approval,
        currentIdentityDigest: otherReference,
        currentArtifactSha256: 'c'.repeat(64),
      }).findings.map((f) => f.code)
    ).toContain('APPROVAL-STALE-IDENTITY');

    const otherEngine = voiceAudioIdentityDigest({
      projectId: 'P1',
      scriptSha256: voicePreviewTextSha256('Every site supervisor knows.'),
      language: 'en',
      assignments: [assignment({ modelRevision: 'f'.repeat(40), settingsDigest: 'settings-v2' })],
    });
    expect(
      evaluateVoiceAudioPreviewApproval({
        preview,
        approval,
        currentIdentityDigest: otherEngine,
        currentArtifactSha256: 'c'.repeat(64),
      }).findings.map((f) => f.code)
    ).toContain('APPROVAL-STALE-IDENTITY');
  });

  it('blocks when the approval decision is missing or rejected', () => {
    expect(
      evaluateVoiceAudioPreviewApproval({
        preview,
        approval: null,
        currentIdentityDigest: identity,
        currentArtifactSha256: 'c'.repeat(64),
      }).findings.map((f) => f.code)
    ).toContain('APPROVAL-MISSING');

    expect(
      evaluateVoiceAudioPreviewApproval({
        preview,
        approval: { ...approval, decision: 'rejected' },
        currentIdentityDigest: identity,
        currentArtifactSha256: 'c'.repeat(64),
      }).findings.map((f) => f.code)
    ).toContain('APPROVAL-REJECTED');
  });

  it('preserves the complete speech and never claims per-scene alignment', () => {
    const timing = voiceAudioTiming(3.4);
    expect(timing.mode).toBe('full_duration_preserved');
    expect(timing.perSceneAlignment).toBe(false);
    expect(timing.durationSeconds).toBe(3.4);
    expect(timing.integrationPoint).toMatch(/generateStoryboard|readTiming/);
    expect(preview.segments[0].spokenText).toBe('Every site supervisor knows.');
  });
});

/* ------------------------------------------------------------------ */
/*  D. Render gate                                                     */
/* ------------------------------------------------------------------ */

describe('VS3 core: the cloned-audio render gate', () => {
  const identity = voiceAudioIdentityDigest({
    projectId: 'P1',
    scriptSha256: voicePreviewTextSha256('Every site supervisor knows.'),
    language: 'en',
    assignments: [assignment()],
  });
  const statuses = Object.fromEntries(
    voiceAudioEngineStatuses([facts()]).map((status) => [status.engine, status])
  );
  const base = {
    clonedVoiceSelected: true,
    assignments: [assignment()],
    references: [reference()],
    referenceChecks: { ref_1: checkVoiceReference(reference(), REF_SHA) },
    engineStatuses: statuses,
    preview: {
      previewId: 'prv_1',
      identityDigest: identity,
      textSha256: voicePreviewTextSha256('Every site supervisor knows.'),
      status: 'ready' as const,
      artifactRef: 'data/projects/P1/voice-audio/previews/prv_1/preview.wav',
      artifactSha256: 'c'.repeat(64),
      durationSeconds: 3.4,
      language: 'en',
      engineSummary: 'Chatterbox (chatterbox-tts)',
      segments: [],
      createdAt: NOW,
      completedAt: NOW,
      error: null,
      timing: voiceAudioTiming(3.4),
    },
    approval: {
      decision: 'approved' as const,
      identityDigest: identity,
      artifactSha256: 'c'.repeat(64),
      approvedAt: NOW,
      approvedBy: 'project-owner',
    },
    currentIdentityDigest: identity,
    currentArtifactSha256: 'c'.repeat(64),
    perSceneTimingAligned: false,
  };

  it('is not applicable when no cloned voice is selected (existing flow unchanged)', () => {
    const gate = evaluateClonedAudioRenderGate({ ...base, clonedVoiceSelected: false, assignments: [] });
    expect(gate.allowed).toBe(true);
    expect(gate.notApplicable).toBe(true);
  });

  it('still blocks the documented timing integration point for cloned audio', () => {
    const gate = evaluateClonedAudioRenderGate(base);
    expect(gate.allowed).toBe(false);
    expect(gate.blockedCodes).toContain('VOICE-AUDIO-060-TIMING-ALIGNMENT-PENDING');
    expect(gate.findings[0]?.remediation).toBeTruthy();
  });

  it('blocks a cloned assignment with no reference at all', () => {
    const gate = evaluateClonedAudioRenderGate({
      ...base,
      references: [],
      referenceChecks: {},
      assignments: [assignment({ referenceId: null, referenceSha256: null })],
    });
    expect(gate.allowed).toBe(false);
    expect(gate.blockedCodes).toContain('VOICE-AUDIO-010-ASSIGNMENT-MISSING-REFERENCE');
  });

  it('blocks an unapproved or removed reference', () => {
    const blocked = evaluateClonedAudioRenderGate({
      ...base,
      references: [reference({ approval: { state: 'pending' } })],
      referenceChecks: { ref_1: checkVoiceReference(reference({ approval: { state: 'pending' } }), REF_SHA) },
    });
    expect(blocked.blockedCodes).toContain('VOICE-AUDIO-011-REFERENCE-BLOCKED');
  });

  it('blocks when the engine is not provisioned or the device is unsupported', () => {
    const notProvisioned = evaluateClonedAudioRenderGate({
      ...base,
      engineStatuses: Object.fromEntries(
        voiceAudioEngineStatuses([facts({ provisioned: false })]).map((s) => [s.engine, s])
      ),
    });
    expect(notProvisioned.blockedCodes).toContain('VOICE-AUDIO-040-ENGINE-NOT-PROVISIONED');

    const noDevice = evaluateClonedAudioRenderGate({
      ...base,
      engineStatuses: Object.fromEntries(
        voiceAudioEngineStatuses([facts({ deviceSatisfied: false, cpuRequiresOptIn: true })]).map((s) => [
          s.engine,
          s,
        ])
      ),
    });
    expect(noDevice.blockedCodes).toContain('VOICE-AUDIO-041-DEVICE-UNSUPPORTED');
  });

  it('blocks a stale identity, a missing preview and a missing approval', () => {
    expect(evaluateClonedAudioRenderGate({ ...base, currentIdentityDigest: 'e'.repeat(64) }).blockedCodes).toContain(
      'APPROVAL-STALE-IDENTITY'
    );
    expect(evaluateClonedAudioRenderGate({ ...base, preview: null, approval: null }).blockedCodes).toContain(
      'PREVIEW-MISSING'
    );
    expect(evaluateClonedAudioRenderGate({ ...base, approval: null }).blockedCodes).toContain('APPROVAL-MISSING');
  });

  it('never widens itself when per-scene timing is not connected', () => {
    expect(evaluateClonedAudioRenderGate({ ...base, perSceneTimingAligned: true }).blockedCodes).not.toContain(
      'VOICE-AUDIO-060-TIMING-ALIGNMENT-PENDING'
    );
  });
});
