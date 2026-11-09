/**
 * BuildTrack Video Factory - VS3 Voice Audio Approval (pure contracts)
 *
 * The application-facing half of the voice-cloning workflow: what the UI and the
 * API need in order to (a) state truthfully whether an engine can run, (b) turn
 * an uploaded reference recording into the VS1 publication profile that the
 * EXISTING gate evaluates, (c) bind an approval to one exact generated audio
 * artifact, and (d) block rendering when something changed.
 *
 * Design rules (all pure - no I/O, no clock, no network):
 *   - the VS1 gate stays the single decision point for consent/rights/audition:
 *     this module AUTHORS a profile and lets `evaluateVoicePublicationGate`
 *     decide. It never re-implements the rules;
 *   - authorization (legal), reference approval (audition) and generated-audio
 *     approval (artifact) are three separate facts with three separate records;
 *   - an approval is bound to `identityDigest` AND `artifactSha256`. Changing the
 *     script, the speaker assignment, the reference identity, the engine, the
 *     model revision or the synthesis settings changes the digest and therefore
 *     invalidates the approval instead of silently keeping it;
 *   - every blocked outcome carries a stable code, an actionable message and a
 *     remediation: nothing is ever "warned about" and then allowed.
 */

import { createHash } from 'node:crypto';
import {
  UNDECLARED_VOICE_ACOUSTIC_IDENTITY,
  voiceAcousticIdentityOf,
} from './voice-acoustic-identity.js';
import { evaluateVoicePublicationGate } from './voice-publication-gate.js';
import {
  VOICE_PUBLICATION_SCHEMA_VERSION,
  type VoiceConsentRecord,
  type VoiceConsentScope,
  type VoicePublicationGateOptions,
  type VoicePublicationGateReport,
  type VoicePublicationProfile,
  type VoiceProfile,
  type VoiceRightsEvidence,
} from './voice-types.js';

export const VOICE_AUDIO_SCHEMA_VERSION = '1.0.0' as const;

/** Canonical-format contract the preview artifacts must satisfy. */
export const VOICE_AUDIO_CANONICAL_CONTRACT = 'audio/canonical@1.0.0' as const;

/* ------------------------------------------------------------------ */
/*  Engine kinds and truthfulness                                      */
/* ------------------------------------------------------------------ */

export type VoiceAudioEngineKind = 'kokoro' | 'chatterbox';

/** Engine id reported by each adapter (matches `AudioSynthesizer.engineId`). */
export const VOICE_AUDIO_ENGINE_IDS: Readonly<Record<VoiceAudioEngineKind, string>> = Object.freeze({
  kokoro: 'kokoro-js',
  chatterbox: 'chatterbox-tts',
});

/**
 * Truthful availability states. `available` means "this engine could run right
 * now" - never "it might work".
 */
export type VoiceAudioAvailabilityState =
  | 'available'
  | 'not_provisioned'
  | 'device_unsupported'
  | 'blocked_by_approval'
  | 'generation_failed';

export interface VoiceAudioEngineFacts {
  engine: VoiceAudioEngineKind;
  label: string;
  /** Runtime package/env resolvable (kokoro-js installed; chatterbox env present). */
  runtimeInstalled: boolean;
  /** Model + isolated environment VERIFIED (never "probably there"). */
  provisioned: boolean;
  /** The device policy this engine needs is satisfied on this host. */
  deviceSatisfied: boolean;
  /** Human-readable device truth, e.g. "no NVIDIA GPU detected". */
  deviceDetail: string;
  /** True when the only usable device is the explicitly-approvable CPU path. */
  cpuRequiresOptIn?: boolean;
  /** Blocking codes from consent/approval for the CURRENTLY selected assignments. */
  approvalBlockedCodes?: readonly string[];
  /** Last generation failure recorded for this engine+project, if any. */
  lastFailure?: { code: string; message: string } | null;
  /** Exact command/short instruction that resolves the current blocker. */
  provisionRemedy: string;
}

export interface VoiceAudioEngineStatus {
  engine: VoiceAudioEngineKind;
  engineId: string;
  label: string;
  state: VoiceAudioAvailabilityState;
  /** One-line truthful explanation shown in the UI. */
  detail: string;
  /** Present whenever the state is not `available`. */
  remedy: string | null;
  /** The user may SELECT this engine (it could run once approved). */
  selectable: boolean;
  /** The engine can actually synthesize right now (provisioned + device + allowed). */
  generatable: boolean;
  /** True when a COSTLY/UNVERIFIED path would be needed (CPU). */
  unverifiedPath: boolean;
  lastFailure: { code: string; message: string } | null;
}

/**
 * Deterministic availability report.
 *
 * Precedence is "what the user must fix first": consent/approval, then
 * provisioning, then the device, then a recorded generation failure.
 */
export function voiceAudioEngineStatus(facts: VoiceAudioEngineFacts): VoiceAudioEngineStatus {
  const engineId = VOICE_AUDIO_ENGINE_IDS[facts.engine];
  const approvalBlocked = (facts.approvalBlockedCodes ?? []).length > 0;
  const lastFailure = facts.lastFailure ?? null;
  const unverifiedPath = facts.deviceSatisfied === false && facts.cpuRequiresOptIn === true;

  let state: VoiceAudioAvailabilityState;
  let detail: string;
  let remedy: string | null = null;

  if (approvalBlocked) {
    state = 'blocked_by_approval';
    detail = `Blocked by consent or approval: ${(facts.approvalBlockedCodes ?? []).join(', ')}.`;
    remedy = 'Confirm authorization for the reference recording and approve it before generating.';
  } else if (!facts.provisioned) {
    state = 'not_provisioned';
    detail = facts.runtimeInstalled
      ? 'Runtime present but the model/environment is not verified as provisioned.'
      : 'Not provisioned: the runtime and model are absent.';
    remedy = facts.provisionRemedy;
  } else if (!facts.deviceSatisfied) {
    state = 'device_unsupported';
    detail = facts.deviceDetail;
    remedy = unverifiedPath
      ? 'CPU execution is opt-in and NOT verified as performant: enable the explicit CPU opt-in only after testing it.'
      : facts.deviceDetail;
  } else if (lastFailure) {
    state = 'generation_failed';
    detail = `Last generation failed (${lastFailure.code}): ${lastFailure.message}`;
    remedy = 'Fix the reported cause and generate again.';
  } else {
    state = 'available';
    detail = 'Ready to generate.';
  }

  const selectable = facts.provisioned && facts.deviceSatisfied;
  return {
    engine: facts.engine,
    engineId,
    label: facts.label,
    state,
    detail,
    remedy,
    selectable,
    generatable: selectable && !approvalBlocked,
    unverifiedPath,
    lastFailure,
  };
}

/** Availability for a set of engines, in deterministic order. */
export function voiceAudioEngineStatuses(
  facts: readonly VoiceAudioEngineFacts[]
): VoiceAudioEngineStatus[] {
  return facts
    .map((entry) => voiceAudioEngineStatus(entry))
    .sort((a, b) => (a.engine < b.engine ? -1 : a.engine > b.engine ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/*  Reference recordings                                               */
/* ------------------------------------------------------------------ */

/** Which engine/model a reference is being prepared for. */
export interface VoiceAudioEngineTarget {
  engine: VoiceAudioEngineKind;
  engineId: string;
  /** Publication engine family (VS1 vocabulary). */
  engineFamily: 'kokoro' | 'chatterbox';
  modelId: string;
  modelRevision: string | null;
  runtimeId: string;
  runtimeVersion: string;
  provider?: string;
}

/** Explicit, user-declared legal authorization. NEVER inferred from upload. */
export interface VoiceReferenceAuthorization {
  ownerConfirmed: boolean;
  confirmedBy: string;
  confirmedAt: string;
  /** The user's own words: own voice, or the authorization they hold. */
  statement: string;
}

export type VoiceReferenceApprovalState = 'pending' | 'approved' | 'rejected';

export interface VoiceReferenceApproval {
  state: VoiceReferenceApprovalState;
  approver?: string;
  reviewedAt?: string;
  reason?: string;
  /** Whether the VS1 gate allowed the authored profile at approval time. */
  gateAllowed?: boolean;
  /** Gate finding codes (errors + warnings) recorded with the decision. */
  gateCodes?: string[];
}

/** A validated, project-scoped reference recording. */
export interface VoiceReferenceRecord {
  referenceId: string;
  displayName: string;
  /** Project-scoped, safe, repo-relative path. Never an absolute path. */
  storedRef: string;
  sha256: string;
  sizeBytes: number;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  container: string;
  createdAt: string;
  authorization: VoiceReferenceAuthorization | null;
  approval: VoiceReferenceApproval;
  /** Rights evidence supplied by the user when asking for approval. */
  rights?: VoiceRightsEvidence | null;
  /**
   * Safe repo-relative path of the RECORDED authorization artifact written when
   * the user confirmed authorization. The VS1 gate requires an auditable consent
   * artifact for a cloned human voice, so this path is what the synthesized
   * profile's `consent.evidencePath` points at.
   */
  consentEvidenceRef?: string | null;
  /** Set when the user deliberately removed it (kept for audit). */
  removedAt?: string;
}

/** Codes a reference can be blocked with, before any synthesis. */
export type VoiceReferenceBlockCode =
  | 'REFERENCE-MISSING'
  | 'REFERENCE-REMOVED'
  | 'REFERENCE-NOT-AUTHORIZED'
  | 'REFERENCE-NOT-APPROVED'
  | 'REFERENCE-REJECTED'
  | 'REFERENCE-HASH-MISMATCH'
  | 'REFERENCE-CONTENT-INVALID';

export interface VoiceReferenceCheck {
  referenceId: string;
  allowed: boolean;
  blockedCodes: VoiceReferenceBlockCode[];
  findings: string[];
  /** True only when authorization AND approval are both truly complete. */
  authorized: boolean;
  approved: boolean;
}

/**
 * Structural check of a stored reference against the bytes actually on disk.
 * `actualSha256` is supplied by the caller (which reads the file) so this stays
 * pure; `null` means the file could not be read.
 */
export function checkVoiceReference(
  record: VoiceReferenceRecord | null | undefined,
  actualSha256: string | null
): VoiceReferenceCheck {
  const blockedCodes: VoiceReferenceBlockCode[] = [];
  const findings: string[] = [];

  if (!record) {
    return {
      referenceId: '',
      allowed: false,
      blockedCodes: ['REFERENCE-MISSING'],
      findings: ['No reference recording is stored for this slot.'],
      authorized: false,
      approved: false,
    };
  }

  if (record.removedAt) {
    blockedCodes.push('REFERENCE-REMOVED');
    findings.push('This reference recording was removed.');
  }
  const authorization = record.authorization;
  const authorized =
    !!authorization && authorization.ownerConfirmed === true && !!authorization.statement?.trim();
  if (!authorized) {
    blockedCodes.push('REFERENCE-NOT-AUTHORIZED');
    findings.push(
      'Authorization was not confirmed. Uploading a file never grants authorization: confirm it explicitly.'
    );
  }
  const approved = record.approval?.state === 'approved';
  if (record.approval?.state === 'rejected') {
    blockedCodes.push('REFERENCE-REJECTED');
    findings.push('This reference recording was rejected at review.');
  } else if (!approved) {
    blockedCodes.push('REFERENCE-NOT-APPROVED');
    findings.push('The reference recording has not been approved yet.');
  }
  if (!actualSha256 || actualSha256 !== record.sha256) {
    blockedCodes.push('REFERENCE-HASH-MISMATCH');
    findings.push('The stored recording does not match the hash recorded at upload.');
  }
  if (!(record.durationSeconds > 0) || !(record.sampleRate > 0) || !(record.channels > 0)) {
    blockedCodes.push('REFERENCE-CONTENT-INVALID');
    findings.push('The stored recording has no usable audio metrics.');
  }

  return {
    referenceId: record.referenceId,
    allowed: blockedCodes.length === 0,
    blockedCodes,
    findings,
    authorized,
    approved,
  };
}

export interface BuildReferenceProfileInput {
  record: VoiceReferenceRecord;
  target: VoiceAudioEngineTarget;
  /** Consent scopes the user declares. Commercial publication is required to publish. */
  consentScope?: readonly VoiceConsentScope[];
  /** Rights evidence required for approval; absence blocks (never inferred). */
  rights: VoiceRightsEvidence | null;
  /** Who reviewed the reference and when. */
  approver: string;
  reviewedAt: string;
  reason?: string;
  /** Language the reference will be spoken in (defaults to English). */
  language?: string;
}

/**
 * Author the VS1 VOICE PROFILE for a stored reference.
 *
 * This is the ONLY bridge between the app's reference record and the shipped
 * consent/rights/audition rules: the decision itself is always taken by
 * `evaluateVoicePublicationGate`. Nothing here decides anything, and nothing is
 * invented: every element the gate can demand is either taken from the recorded
 * authorization/rights evidence or left absent so the gate blocks.
 *
 * The returned object is a full `VoiceProfile` (the gate's own input shape): a
 * bare publication record is not a profile and would be rejected as malformed
 * before any real rule ran.
 */
export function buildReferencePublicationProfile(
  input: BuildReferenceProfileInput
): VoiceProfile {
  const { record, target } = input;
  const authorization = record.authorization;
  const scope: VoiceConsentScope[] = [
    ...(input.consentScope ?? ['commercial_video_publication', 'synthetic_voice_cloning']),
  ];
  const language = (input.language ?? 'en').trim() || 'en';
  const approved = record.approval?.state === 'approved';

  const consent: VoiceConsentRecord | undefined = authorization
    ? {
        subject: 'recorded_speaker',
        authorizedSpeaker: authorization.statement,
        ownerConfirmed: authorization.ownerConfirmed === true,
        confirmedBy: authorization.confirmedBy,
        recordedAt: authorization.confirmedAt,
        scope,
        revoked: false,
        /*
         * The auditable artifact the user's confirmation was written to. The
         * gate requires it for a cloned human voice: a boolean is not evidence.
         */
        ...(record.consentEvidenceRef ? { evidencePath: record.consentEvidenceRef } : {}),
      }
    : undefined;

  return {
    id: `vp_ref_${record.referenceId}`,
    voiceSlot: `voice_ref_${record.referenceId}`,
    displayName: record.displayName,
    primaryLanguage: language,
    languages: [language],
    enabled: true,
    version: VOICE_AUDIO_SCHEMA_VERSION,
    createdAt: record.createdAt,
    publication: {
      schemaVersion: VOICE_PUBLICATION_SCHEMA_VERSION,
      engine: {
        engine: target.engineFamily,
        modelId: target.modelId,
        ...(target.modelRevision ? { modelRevision: target.modelRevision } : {}),
        runtimeId: target.runtimeId,
        runtimeVersion: target.runtimeVersion,
        ...(target.provider ? { provider: target.provider } : {}),
        requiresNetwork: false,
        localOnly: true,
      },
      acousticSource: {
        kind: 'cloned_reference_audio',
        referenceAudio: {
          path: record.storedRef,
          sha256: record.sha256,
          durationSeconds: record.durationSeconds,
          sampleRate: record.sampleRate,
          channels: record.channels,
          container: record.container,
          capturedAt: record.createdAt,
        },
      },
      ...(consent ? { consent } : {}),
      ...(input.rights ? { rights: input.rights } : {}),
      audition: {
        state: approved ? 'approved' : record.approval?.state === 'rejected' ? 'rejected' : 'not_tested',
        approver: input.approver,
        reviewedAt: input.reviewedAt,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      publicationState: approved ? 'approved' : 'draft',
      origin: 'authored_first_party',
      updatedAt: input.reviewedAt,
    },
  };
}

/** Evaluate the authored profile with the SHIPPED VS1 gate. */
export function evaluateReferencePublicationProfile(
  input: BuildReferenceProfileInput,
  options: VoicePublicationGateOptions = {}
): VoicePublicationGateReport {
  return evaluateVoicePublicationGate(buildReferencePublicationProfile(input), options);
}

/* ------------------------------------------------------------------ */
/*  Speaker assignments and the preview identity                       */
/* ------------------------------------------------------------------ */

/**
 * Speaker -> engine/voice assignment.
 *
 * Two different display names NEVER imply two different voices: every distinct
 * voice a speaker gets must be an explicit assignment naming its engine and its
 * reference (cloned voice) or preset voice id.
 */
export interface VoiceAudioAssignment {
  speakerId: string;
  speakerName?: string;
  engine: VoiceAudioEngineKind;
  engineId: string;
  modelId: string;
  modelRevision: string | null;
  /** Chatterbox/AI settings digest when the engine has tunable settings. */
  settingsDigest?: string | null;
  /** Cloned voices: the approved reference. */
  referenceId?: string | null;
  referenceSha256?: string | null;
  /** Preset voices (Kokoro): the preset id. */
  presetVoiceId?: string | null;
}

export interface VoiceAudioIdentityInput {
  projectId: string;
  /** SHA-256 of the exact script/narration text that will be spoken. */
  scriptSha256: string;
  language: string;
  assignments: readonly VoiceAudioAssignment[];
  /** Canonical audio contract id; a format change invalidates the approval. */
  canonicalContract?: string;
}

/** SHA-256 of the exact spoken text (never the display name, never a label). */
export function voicePreviewTextSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonicalAssignment(assignment: VoiceAudioAssignment) {
  return {
    speakerId: assignment.speakerId,
    engine: assignment.engine,
    engineId: assignment.engineId,
    modelId: assignment.modelId,
    modelRevision: assignment.modelRevision ?? null,
    settingsDigest: assignment.settingsDigest ?? null,
    referenceId: assignment.referenceId ?? null,
    referenceSha256: assignment.referenceSha256 ?? null,
    presetVoiceId: assignment.presetVoiceId ?? null,
  };
}

/**
 * Deterministic identity digest of a preview request.
 *
 * It is the complete acoustic identity of the whole narration: the project, the
 * exact script text, the language, the canonical format contract and, per
 * speaker, the engine + model + revision + settings + reference hash. Every one
 * of those inputs invalidates an approval when it changes.
 */
export function voiceAudioIdentityDigest(input: VoiceAudioIdentityInput): string {
  const material = {
    schema: VOICE_AUDIO_SCHEMA_VERSION,
    projectId: input.projectId,
    scriptSha256: input.scriptSha256,
    language: input.language,
    canonicalContract: input.canonicalContract ?? VOICE_AUDIO_CANONICAL_CONTRACT,
    assignments: [...input.assignments]
      .map(canonicalAssignment)
      .sort((a, b) => (a.speakerId < b.speakerId ? -1 : a.speakerId > b.speakerId ? 1 : 0)),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

/* ------------------------------------------------------------------ */
/*  Preview + approval records                                         */
/* ------------------------------------------------------------------ */

export type VoiceAudioPreviewStatus = 'running' | 'ready' | 'failed';

export interface VoiceAudioPreviewSegment {
  index: number;
  speakerId: string;
  speakerName?: string;
  engine: VoiceAudioEngineKind;
  engineId: string;
  /** Exact spoken text of this segment (complete speech; never trimmed). */
  spokenText: string;
  textSha256: string;
  durationSeconds: number | null;
  outputRef: string | null;
}

export interface VoiceAudioPreviewRecord {
  previewId: string;
  /** Identity of the request set this artifact was generated from. */
  identityDigest: string;
  textSha256: string;
  status: VoiceAudioPreviewStatus;
  /** Project-scoped safe path of the generated narration artifact. */
  artifactRef: string | null;
  artifactSha256: string | null;
  durationSeconds: number | null;
  language: string;
  engineSummary: string;
  segments: VoiceAudioPreviewSegment[];
  createdAt: string;
  completedAt?: string;
  error?: { code: string; message: string; remediation?: string } | null;
  /**
   * How the real duration reaches the timing pipeline. This phase preserves the
   * complete speech and its measured duration but does NOT derive per-scene
   * alignment, so the project is not silently marked render-ready.
   */
  timing: {
    mode: 'full_duration_preserved';
    perSceneAlignment: false;
    durationSeconds: number | null;
    integrationPoint: string;
  };
}

export type VoiceAudioApprovalDecision = 'approved' | 'rejected';

export interface VoiceAudioApprovalRecord {
  decision: VoiceAudioApprovalDecision;
  /** The identity the artifact was generated from, at decision time. */
  identityDigest: string;
  /** The exact bytes that were approved. */
  artifactSha256: string;
  approvedAt: string;
  approvedBy: string;
  notes?: string;
}

export type VoiceAudioApprovalCode =
  | 'PREVIEW-MISSING'
  | 'PREVIEW-RUNNING'
  | 'PREVIEW-FAILED'
  | 'PREVIEW-ARTIFACT-MISSING'
  | 'APPROVAL-MISSING'
  | 'APPROVAL-REJECTED'
  | 'APPROVAL-STALE-IDENTITY'
  | 'APPROVAL-ARTIFACT-MISMATCH';

export interface VoiceAudioApprovalFinding {
  code: VoiceAudioApprovalCode;
  severity: 'error';
  message: string;
  remediation: string;
}

export interface VoiceAudioApprovalEvaluation {
  allowed: boolean;
  matched: boolean;
  findings: VoiceAudioApprovalFinding[];
}

/**
 * Decide whether the CURRENT preview has been approved.
 *
 * An approval counts only when it matches BOTH the current identity digest (the
 * script, assignments, reference identity, engine, model and settings are
 * unchanged) and the artifact hash on disk. Anything else blocks.
 */
export function evaluateVoiceAudioPreviewApproval(input: {
  preview: VoiceAudioPreviewRecord | null;
  approval: VoiceAudioApprovalRecord | null;
  currentIdentityDigest: string;
  /** SHA-256 of the artifact currently on disk; null when unreadable/missing. */
  currentArtifactSha256: string | null;
}): VoiceAudioApprovalEvaluation {
  const findings: VoiceAudioApprovalFinding[] = [];
  const { preview, approval } = input;

  if (preview) {
    if (preview.status === 'running') {
      findings.push({
        code: 'PREVIEW-RUNNING',
        severity: 'error',
        message: 'Generation is still running.',
        remediation: 'Wait for generation to finish, then listen to the preview.',
      });
    } else if (preview.status === 'failed') {
      findings.push({
        code: 'PREVIEW-FAILED',
        severity: 'error',
        message: `The last generation failed (${preview.error?.code ?? 'unknown'}): ${preview.error?.message ?? 'no detail'}`,
        remediation: preview.error?.remediation ?? 'Fix the reported cause and generate again.',
      });
    }
  } else {
    findings.push({
      code: 'PREVIEW-MISSING',
      severity: 'error',
      message: 'No audio preview has been generated for this project yet.',
      remediation: 'Generate a preview, listen to it, then approve it.',
    });
  }

  const artifactMissing =
    !!preview && preview.status === 'ready' && (!input.currentArtifactSha256 || !preview.artifactRef);
  if (artifactMissing) {
    findings.push({
      code: 'PREVIEW-ARTIFACT-MISSING',
      severity: 'error',
      message: 'The generated preview artifact is missing on disk.',
      remediation: 'Generate the preview again.',
    });
  }

  if (!approval) {
    findings.push({
      code: 'APPROVAL-MISSING',
      severity: 'error',
      message: 'The generated audio has not been approved.',
      remediation: 'Listen to the preview and approve exactly that artifact.',
    });
  } else if (approval.decision === 'rejected') {
    findings.push({
      code: 'APPROVAL-REJECTED',
      severity: 'error',
      message: 'The generated audio was rejected.',
      remediation: 'Change the settings/reference, generate a new preview and approve it.',
    });
  } else {
    if (approval.identityDigest !== input.currentIdentityDigest) {
      findings.push({
        code: 'APPROVAL-STALE-IDENTITY',
        severity: 'error',
        message:
          'The script, speaker assignment, reference recording, engine, model or settings changed after approval.',
        remediation: 'Generate a new preview from the current inputs and approve it.',
      });
    }
    if (input.currentArtifactSha256 && approval.artifactSha256 !== input.currentArtifactSha256) {
      findings.push({
        code: 'APPROVAL-ARTIFACT-MISMATCH',
        severity: 'error',
        message: 'The approved artifact is no longer the artifact on disk.',
        remediation: 'Listen to the current audio and approve it explicitly.',
      });
    }
  }

  return { allowed: findings.length === 0, matched: findings.length === 0, findings };
}

/* ------------------------------------------------------------------ */
/*  Render gate                                                        */
/* ------------------------------------------------------------------ */

export type VoiceAudioRenderGateCode =
  | 'VOICE-AUDIO-000-NO-CLONED-VOICE'
  | 'VOICE-AUDIO-010-ASSIGNMENT-MISSING-REFERENCE'
  | 'VOICE-AUDIO-011-REFERENCE-BLOCKED'
  | 'VOICE-AUDIO-040-ENGINE-NOT-PROVISIONED'
  | 'VOICE-AUDIO-041-DEVICE-UNSUPPORTED'
  | 'VOICE-AUDIO-060-TIMING-ALIGNMENT-PENDING'
  | VoiceAudioApprovalCode;

export interface VoiceAudioRenderGateFinding {
  code: VoiceAudioRenderGateCode;
  severity: 'error';
  message: string;
  remediation: string;
}

export interface VoiceAudioRenderGateInput {
  /** True when at least one speaker is assigned a cloned (Chatterbox) voice. */
  clonedVoiceSelected: boolean;
  assignments: readonly VoiceAudioAssignment[];
  references: readonly VoiceReferenceRecord[];
  /** Reference check results, keyed by referenceId (from `checkVoiceReference`). */
  referenceChecks?: Readonly<Record<string, VoiceReferenceCheck>>;
  /** Engine statuses, keyed by engine kind. */
  engineStatuses?: Readonly<Record<string, VoiceAudioEngineStatus>>;
  preview: VoiceAudioPreviewRecord | null;
  approval: VoiceAudioApprovalRecord | null;
  currentIdentityDigest: string;
  currentArtifactSha256: string | null;
  /** Per-scene timing alignment is a documented follow-up, not an assumption. */
  perSceneTimingAligned?: boolean;
}

export interface VoiceAudioRenderGateResult {
  allowed: boolean;
  /** `true` when cloning is not in use at all (the existing flow is untouched). */
  notApplicable: boolean;
  blockedCodes: VoiceAudioRenderGateCode[];
  findings: VoiceAudioRenderGateFinding[];
  /** Stable short summary for API/UI error payloads. */
  reason: string;
}

/**
 * The render gate for cloned audio.
 *
 * A project that does not use cloning is explicitly `notApplicable` and
 * allowed: the existing narration/Kokoro flow keeps working unchanged. As soon
 * as one speaker uses a cloned voice, EVERY requirement must hold.
 */
export function evaluateClonedAudioRenderGate(
  input: VoiceAudioRenderGateInput
): VoiceAudioRenderGateResult {
  if (!input.clonedVoiceSelected) {
    return {
      allowed: true,
      notApplicable: true,
      blockedCodes: ['VOICE-AUDIO-000-NO-CLONED-VOICE'],
      findings: [],
      reason: 'No cloned voice is selected; the existing narration flow applies.',
    };
  }

  const findings: VoiceAudioRenderGateFinding[] = [];
  const push = (
    code: VoiceAudioRenderGateCode,
    message: string,
    remediation: string
  ): void => {
    if (!findings.some((f) => f.code === code)) findings.push({ code, severity: 'error', message, remediation });
  };

  for (const assignment of input.assignments) {
    if (assignment.engine !== 'chatterbox') continue;
    if (!assignment.referenceId) {
      push(
        'VOICE-AUDIO-010-ASSIGNMENT-MISSING-REFERENCE',
        `Speaker '${assignment.speakerName ?? assignment.speakerId}' has no approved voice reference.`,
        'Assign an approved reference recording to this speaker.'
      );
      continue;
    }
    const reference = input.references.find((r) => r.referenceId === assignment.referenceId) ?? null;
    const check =
      input.referenceChecks?.[assignment.referenceId] ?? checkVoiceReference(reference, reference?.sha256 ?? null);
    if (!check.allowed) {
      push(
        'VOICE-AUDIO-011-REFERENCE-BLOCKED',
        `Reference for speaker '${assignment.speakerName ?? assignment.speakerId}' is blocked: ${check.blockedCodes.join(', ')}.`,
        check.findings[0] ?? 'Confirm authorization and approve the reference recording.'
      );
    }
    const status = input.engineStatuses?.chatterbox;
    if (status && status.state === 'not_provisioned') {
      push(
        'VOICE-AUDIO-040-ENGINE-NOT-PROVISIONED',
        status.detail,
        status.remedy ?? 'Provision the voice-clone engine explicitly.'
      );
    }
    if (status && status.state === 'device_unsupported') {
      push('VOICE-AUDIO-041-DEVICE-UNSUPPORTED', status.detail, status.remedy ?? 'Run on a supported device.');
    }
  }

  const approvalEvaluation = evaluateVoiceAudioPreviewApproval({
    preview: input.preview,
    approval: input.approval,
    currentIdentityDigest: input.currentIdentityDigest,
    currentArtifactSha256: input.currentArtifactSha256,
  });
  for (const finding of approvalEvaluation.findings) {
    push(finding.code, finding.message, finding.remediation);
  }

  if (input.perSceneTimingAligned !== true) {
    push(
      'VOICE-AUDIO-060-TIMING-ALIGNMENT-PENDING',
      'Per-scene speech alignment for the cloned preview has not been produced, so scene timings cannot be derived from it yet.',
      'Keep the complete generated audio: regenerate scene timings from the measured full duration, or connect the documented timing integration point.'
    );
  }

  const blockedCodes = findings.map((f) => f.code);
  return {
    allowed: findings.length === 0,
    notApplicable: false,
    blockedCodes,
    findings,
    reason:
      findings.length === 0
        ? 'Cloned audio is authorized, generated and approved for the current inputs.'
        : `Rendering is blocked for cloned audio: ${blockedCodes.join(', ')}.`,
  };
}

/** Public (privacy-safe) projection of a reference for API responses. */
export interface PublicVoiceReference {
  referenceId: string;
  displayName: string;
  sha256Prefix: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  container: string;
  sizeBytes: number;
  createdAt: string;
  /** True only when authorization was explicitly confirmed. */
  authorized: boolean;
  authorizedAt: string | null;
  /** True only when the reference was approved. */
  approved: boolean;
  approvalState: VoiceReferenceApprovalState;
  approvedAt: string | null;
  /** Present when the reference is blocked, with the blocking codes. */
  blockedCodes: VoiceReferenceBlockCode[];
}

/**
 * Project a stored record into what a client may see: never a filesystem path,
 * never the raw stored filename. Only a short hash prefix identifies it.
 */
export function toPublicVoiceReference(
  record: VoiceReferenceRecord,
  check?: VoiceReferenceCheck
): PublicVoiceReference {
  const evaluated = check ?? checkVoiceReference(record, record.sha256);
  return {
    referenceId: record.referenceId,
    displayName: record.displayName,
    sha256Prefix: record.sha256.slice(0, 12),
    durationSeconds: Number(record.durationSeconds.toFixed(3)),
    sampleRate: record.sampleRate,
    channels: record.channels,
    container: record.container,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
    authorized: evaluated.authorized,
    authorizedAt: record.authorization?.confirmedAt ?? null,
    approved: evaluated.approved,
    approvalState: record.approval?.state ?? 'pending',
    approvedAt: record.approval?.reviewedAt ?? null,
    blockedCodes: evaluated.blockedCodes,
  };
}

/**
 * Acoustic identity of a Kokoro preset assignment, so a preset voice also carries
 * a comparable identity into the reuse key (no invented reference hash).
 */
export function presetAcousticIdentity(presetVoiceId: string) {
  return {
    ...UNDECLARED_VOICE_ACOUSTIC_IDENTITY,
    engine: 'kokoro' as const,
    sourceKind: 'preset_model_voice' as const,
    presetVoiceId,
    acousticSourceId: `preset:${presetVoiceId}`,
  };
}

/** Acoustic identity declared by a cloned reference (reuses the VS1 derivation). */
export function referenceAcousticIdentity(profile: VoiceProfile) {
  return voiceAcousticIdentityOf(profile);
}

/* ------------------------------------------------------------------ */
/*  Timing hand-off                                                    */
/* ------------------------------------------------------------------ */

/**
 * Where the measured full duration of a cloned preview must be wired into the
 * EXISTING timing pipeline. This phase preserves the complete speech and its
 * measured duration but does not derive per-scene alignment, so the value is
 * reported (and the render gate blocks) instead of being guessed.
 */
export const VOICE_AUDIO_TIMING_INTEGRATION_POINT =
  'apps/api/src/services/store.ts#generateStoryboard({ audioDuration, shortAudioDurations, shortSceneTimings }) ' +
  'and apps/api/src/services/targets.ts#readTiming(<name>.timing.json)';

/** Structured timing hand-off: measured duration only, never a re-timing. */
export function voiceAudioTiming(durationSeconds: number | null): {
  mode: 'full_duration_preserved';
  perSceneAlignment: false;
  durationSeconds: number | null;
  integrationPoint: string;
} {
  return {
    mode: 'full_duration_preserved',
    perSceneAlignment: false,
    durationSeconds:
      typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
        ? Number(durationSeconds.toFixed(3))
        : null,
    integrationPoint: VOICE_AUDIO_TIMING_INTEGRATION_POINT,
  };
}

/* ------------------------------------------------------------------ */
/*  Synthesis-time profile for an approved reference                    */
/* ------------------------------------------------------------------ */

export interface SynthesisVoiceProfileInput {
  referenceId: string;
  displayName: string;
  storedRef: string;
  sha256: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  container: string;
  language: string;
  modelId: string;
  modelRevision: string | null;
  runtimeId: string;
  runtimeVersion: string;
  approver: string;
  reviewedAt: string;
  /**
   * Safe repo-relative path of the recorded authorization artifact. REQUIRED for
   * a cloned human voice: the VS1 gate refuses a `recorded_speaker` consent
   * without an auditable consent artifact.
   */
  consentEvidencePath: string;
  rights: VoiceRightsEvidence;
}

/**
 * Build the `VoiceProfile` handed to the Chatterbox adapter for one clip.
 *
 * It is authored from the APPROVED reference record so the adapter's own
 * declaration checks (engine family, model id, runtime, revision, reference
 * hash) and the VS1 gate both evaluate exactly the voice the user approved.
 */
export function buildSynthesisVoiceProfile(input: SynthesisVoiceProfileInput): VoiceProfile {
  return {
    id: `vp_ref_${input.referenceId}`,
    voiceSlot: `voice_ref_${input.referenceId}`,
    displayName: input.displayName,
    description: 'Approved own-voice clone (project-scoped reference recording).',
    primaryLanguage: input.language,
    languages: [input.language],
    gender: 'neutral',
    roleHint: 'authority',
    enabled: true,
    version: '1.0.0',
    createdAt: input.reviewedAt,
    publication: {
      schemaVersion: VOICE_PUBLICATION_SCHEMA_VERSION,
      engine: {
        engine: 'chatterbox',
        modelId: input.modelId,
        ...(input.modelRevision ? { modelRevision: input.modelRevision } : {}),
        runtimeId: input.runtimeId,
        runtimeVersion: input.runtimeVersion,
        requiresNetwork: false,
        localOnly: true,
      },
      acousticSource: {
        kind: 'cloned_reference_audio',
        referenceAudio: {
          path: input.storedRef,
          sha256: input.sha256,
          durationSeconds: input.durationSeconds,
          sampleRate: input.sampleRate,
          channels: input.channels,
          container: input.container,
        },
      },
      consent: {
        subject: 'recorded_speaker',
        authorizedSpeaker: input.displayName,
        ownerConfirmed: true,
        confirmedBy: input.approver,
        recordedAt: input.reviewedAt,
        scope: ['commercial_video_publication', 'synthetic_voice_cloning'],
        revoked: false,
        evidencePath: input.consentEvidencePath,
      },
      rights: input.rights,
      audition: {
        state: 'approved',
        approver: input.approver,
        reviewedAt: input.reviewedAt,
        reason: 'Reference recording reviewed and approved in the Voice & Audio panel.',
      },
      publicationState: 'approved',
      origin: 'authored_first_party',
      updatedAt: input.reviewedAt,
    },
  } as unknown as VoiceProfile;
}
