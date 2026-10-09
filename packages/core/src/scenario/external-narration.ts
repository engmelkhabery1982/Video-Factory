/**
 * BuildTrack Video Factory — VS4 External Narration Import contract.
 *
 * Narration that was produced OUTSIDE this app (on Kaggle, in a studio, by a
 * licensed vendor) is imported as a file. The file itself is never trusted on
 * its own: it only becomes usable for a target once
 *
 *   1. it was really decoded and measured (never the file extension),
 *   2. the operator declared where it came from and confirmed they are allowed
 *      to publish it — a DECLARATION, not a verification,
 *   3. the exact spoken script is on record, bound by digest,
 *   4. somebody listened to exactly those bytes and approved them,
 *   5. the scene/caption timing of that target was regenerated from the
 *      MEASURED duration and covers the whole audio.
 *
 * Everything here is pure and deterministic: no I/O, no clock, no network. The
 * API layer feeds it facts and reports the findings verbatim, so a blocking
 * reason in the UI always comes from one of the codes below.
 *
 * Three different things are deliberately kept apart and never conflated:
 *   - `ownershipConfirmed` — the operator's own declaration of rights,
 *   - `engineName`/`modelName`/`voiceName`/`sourceNotes` — documented source
 *     info the operator typed in (may be incomplete or absent),
 *   - the listening approval — a human actually heard these exact bytes.
 * Declared provenance is NOT verification, and none of them substitutes for
 * another.
 */
import { createHash } from 'node:crypto';
import type { TargetId } from '../targets.js';
import { voicePreviewTextSha256 } from './voice-audio-approval.js';

export const EXTERNAL_NARRATION_SCHEMA_VERSION = '1.0.0' as const;

/** Where the imported file claims to come from. Declared by the operator. */
export type ExternalNarrationSourceKind = 'own_recording' | 'authorized_external_synthesis';

/**
 * How the per-scene timing of a target relates to the imported audio.
 * `verified` is true ONLY for real per-scene timing whose text matches the
 * scenes word for word; anything else is an estimate and is labelled as one.
 */
export type ExternalNarrationAlignmentMode = 'exact_scene_timing' | 'estimated_from_script' | 'none';

export interface ExternalNarrationAlignment {
  mode: ExternalNarrationAlignmentMode;
  /** True only when per-scene speech timing was measured and text-matched. */
  verified: boolean;
  /** Number of per-scene timing entries, when a timing file was found. */
  sceneCount: number | null;
  /** Plain-language statement of what this alignment is (and is not). */
  detail: string;
}

export interface ExternalNarrationDeclaration {
  sourceKind: ExternalNarrationSourceKind;
  /** Operator's declaration that they may publish this audio. Not a proof. */
  ownershipConfirmed: boolean;
  /** Free text the operator typed when confirming ownership/authorization. */
  ownershipStatement: string;
  /** Who is heard. Binds the approval to a speaker identity. */
  speakerName: string;
  /** Optional link to a registered voice identity, when one exists. */
  speakerId?: string | null;
  /** Documented source info — typed in by the operator, never verified here. */
  engineName?: string | null;
  modelName?: string | null;
  voiceName?: string | null;
  sourceNotes?: string | null;
}

/** One imported narration file for ONE target. */
export interface ExternalNarrationImport {
  importId: string;
  projectId: string;
  targetId: TargetId;
  /** Sanitized original file name (display only; never used as a path). */
  fileName: string;
  /** Managed, project-scoped narration reference (publishable narration). */
  storedRef: string;
  mimeType: string;
  byteSize: number;
  /** SHA-256 of the exact bytes that were stored. */
  sha256: string;
  /** Duration measured from the decoded container by ffprobe. */
  durationSec: number;
  /** How the duration above was obtained. Never a guess. */
  durationSource: 'ffprobe';
  scriptText: string;
  scriptSha256: string;
  declaration: ExternalNarrationDeclaration;
  alignment: ExternalNarrationAlignment;
  createdAt: string;
}

export type ExternalNarrationApprovalDecision = 'approved' | 'rejected';

export interface ExternalNarrationApproval {
  decision: ExternalNarrationApprovalDecision;
  importId: string;
  projectId: string;
  targetId: TargetId;
  /** SHA-256 of the approved bytes. */
  artifactSha256: string;
  /**
   * SHA-256 of the imported file's declared transcript. Never rewritten to
   * match a later project edit.
   */
  scriptSha256: string;
  /**
   * SHA-256 of the intended spoken content this approval was made against.
   * Distinct from `scriptSha256`. Absent on approvals written before the
   * post-VS7 correction; those are stale once a current identity is supplied.
   */
  intendedSpokenSha256?: string;
  /** Speaker identity the approval is bound to. */
  speakerId: string;
  /** Timing/alignment revision the approval is bound to. */
  timingRevision: string;
  /** True when the approver states they listened to the whole file. */
  listened: boolean;
  decidedAt: string;
  decidedBy: string;
  note?: string;
}

/* ------------------------------------------------------------------ */
/*  Digests                                                            */
/* ------------------------------------------------------------------ */

/** SHA-256 of the exact spoken text (never a label, never a file name). */
export function externalNarrationScriptSha256(text: string): string {
  return voicePreviewTextSha256(text);
}

/**
 * Identity of the spoken content a project currently intends for one target.
 *
 * Long includes the project script and that target's own scene narration.
 * A Short includes only its own scene narration, never the Long script, so a
 * legitimately different Short narration is not compared with Long text.
 * Caption text and scene timing are not part of this identity.
 *
 * The same script and the same narration text produce the same digest. Restoring
 * that content matches the existing approval without a new recording. Storyboard
 * regeneration does not rewrite an approval; if the resulting narration still
 * differs, the approval stays stale.
 */
export function externalNarrationIntendedSpokenSha256(input: {
  targetId: TargetId;
  projectScript: string;
  narration: readonly string[];
}): string {
  const narration = input.narration.map((line) => line);
  const material = input.targetId === 'long'
    ? {
        schema: 'external-narration-intended-spoken/v1',
        targetId: 'long' as const,
        projectScript: input.projectScript,
        narration,
      }
    : {
        schema: 'external-narration-intended-spoken/v1',
        targetId: input.targetId,
        narration,
      };
  return voicePreviewTextSha256(JSON.stringify(material));
}

export interface ExternalNarrationTimingRevisionInput {
  projectId: string;
  targetId: TargetId;
  artifactSha256: string;
  scriptSha256: string;
  /** Measured audio duration of the approved artifact. */
  audioDurationSec: number;
  alignment: ExternalNarrationAlignment;
  /** Current planned timeline length of that target (scenes + end card). */
  timelineDurationSec: number | null;
  /** Silent end-card length allowed after the last spoken word. */
  endCardSeconds: number;
}

/**
 * The timing/alignment revision an approval is bound to.
 *
 * It changes when the audio changes, when the script changes, when the measured
 * duration changes, when the alignment mode changes (exact ↔ estimated) or when
 * the planned timeline changes. Any of those means the approved timing no
 * longer describes reality, so the approval is stale and must be reviewed
 * again. It deliberately does NOT contain a clock: the same facts always
 * produce the same revision.
 */
export function externalNarrationTimingRevision(input: ExternalNarrationTimingRevisionInput): string {
  const material = {
    schema: EXTERNAL_NARRATION_SCHEMA_VERSION,
    projectId: input.projectId,
    targetId: input.targetId,
    artifactSha256: input.artifactSha256,
    scriptSha256: input.scriptSha256,
    audioDurationSec: Number(input.audioDurationSec.toFixed(3)),
    alignmentMode: input.alignment.mode,
    alignmentSceneCount: input.alignment.sceneCount ?? null,
    timelineDurationSec:
      input.timelineDurationSec === null ? null : Number(input.timelineDurationSec.toFixed(3)),
    endCardSeconds: Number(input.endCardSeconds.toFixed(3)),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

/* ------------------------------------------------------------------ */
/*  Findings                                                           */
/* ------------------------------------------------------------------ */

export type ExternalNarrationCode =
  /* import-time */
  | 'IMPORT-MISSING'
  | 'IMPORT-DECLARATION-INCOMPLETE'
  | 'IMPORT-OWNERSHIP-UNCONFIRMED'
  | 'IMPORT-SCRIPT-MISSING'
  | 'IMPORT-DURATION-UNKNOWN'
  | 'IMPORT-ARTIFACT-MISSING'
  /* approval-time */
  | 'IMPORT-APPROVAL-MISSING'
  | 'IMPORT-APPROVAL-REJECTED'
  | 'IMPORT-LISTENING-NOT-CONFIRMED'
  | 'IMPORT-APPROVAL-STALE-TARGET'
  | 'IMPORT-APPROVAL-STALE-ARTIFACT'
  | 'IMPORT-APPROVAL-STALE-SCRIPT'
  | 'IMPORT-APPROVAL-STALE-INTENDED-SCRIPT'
  | 'IMPORT-APPROVAL-STALE-SPEAKER'
  | 'IMPORT-APPROVAL-STALE-TIMING'
  /* timing-time */
  | 'TIMING-STALE-PLAN'
  | 'TIMING-TIMELINE-SHORTER-THAN-AUDIO'
  | 'TIMING-TIMELINE-LONGER-THAN-AUDIO'
  | 'TIMING-ALIGNMENT-ESTIMATED'
  | 'TIMING-ALIGNMENT-MISSING'
  /* VS5 timing review — caption/scene corrections and their own approval */
  | 'TIMING-APPROVAL-MISSING'
  | 'TIMING-APPROVAL-STALE'
  | 'TIMING-APPROVAL-REJECTED'
  | 'TIMING-REVIEW-NOT-CONFIRMED'
  | 'TIMING-TIME-INVALID'
  | 'TIMING-OUT-OF-BOUNDS'
  | 'TIMING-CUE-OVERLAP'
  | 'TIMING-CUE-ORDER'
  | 'TIMING-CUE-MISSING'
  | 'TIMING-SCENE-GAP'
  | 'TIMING-SCENE-OVERLAP'
  | 'TIMING-SCENE-COVERAGE'
  | 'TIMING-SPEECH-SHORTER-THAN-AUDIO'
  | 'TIMING-SCRIPT-ALTERED'
  | 'TIMING-TARGET-MISMATCH'
  /* per-turn dialogue imports */
  | 'DIALOGUE-TURN-CLIP-MISSING'
  | 'DIALOGUE-TURN-TEXT-MISMATCH'
  | 'DIALOGUE-TURN-SPEAKER-MISMATCH'
  | 'DIALOGUE-COMBINED-TRACK-NOT-PER-SPEAKER'
  | 'DIALOGUE-DURATION-UNKNOWN';

export interface ExternalNarrationFinding {
  code: ExternalNarrationCode;
  severity: 'error' | 'warning';
  message: string;
  remediation: string;
}

export interface ExternalNarrationEvaluation {
  allowed: boolean;
  findings: ExternalNarrationFinding[];
  /** Error findings only — the ones that actually block. */
  blocking: ExternalNarrationFinding[];
}

/* ------------------------------------------------------------------ */
/*  Import + approval evaluation                                       */
/* ------------------------------------------------------------------ */

export interface ExternalNarrationApprovalInput {
  projectId: string;
  targetId: TargetId;
  /** The import currently recorded for this target, if any. */
  import: ExternalNarrationImport | null;
  /** SHA-256 of the narration bytes on disk right now (null when unreadable). */
  currentArtifactSha256: string | null;
  approval: ExternalNarrationApproval | null;
  /** Speaker identity currently assigned to this target, when known. */
  currentSpeakerId?: string | null;
  /** Timing revision derived from the CURRENT facts. */
  currentTimingRevision: string;
  /**
   * Intended spoken-content identity of this target right now. When supplied,
   * it is compared with `approval.intendedSpokenSha256`, not with the imported
   * file's declared transcript.
   */
  currentIntendedSpokenSha256?: string | null;
}

function finding(
  code: ExternalNarrationCode,
  severity: 'error' | 'warning',
  message: string,
  remediation: string,
): ExternalNarrationFinding {
  return { code, severity, message, remediation };
}

/**
 * Decide whether the imported narration of ONE target may be exported.
 *
 * An approval counts only when it belongs to this project+target and matches
 * the artifact digest, the spoken-script digest, the speaker identity and the
 * timing/alignment revision. Replacing the audio, editing the script, changing
 * the speaker assignment or regenerating the timing all invalidate it.
 */
export function evaluateExternalNarrationApproval(
  input: ExternalNarrationApprovalInput,
): ExternalNarrationEvaluation {
  const findings: ExternalNarrationFinding[] = [];
  const record = input.import;

  if (!record) {
    findings.push(
      finding(
        'IMPORT-MISSING',
        'error',
        'No externally imported narration is recorded for this target.',
        'Import the narration file for this target, listen to it, then approve it.',
      ),
    );
  } else {
    if (!record.declaration || typeof record.declaration !== 'object') {
      findings.push(
        finding(
          'IMPORT-DECLARATION-INCOMPLETE',
          'error',
          'The source declaration of the imported narration is missing.',
          'Re-import the file and declare where the narration came from.',
        ),
      );
    } else {
      if (!record.declaration.sourceKind) {
        findings.push(
          finding(
            'IMPORT-DECLARATION-INCOMPLETE',
            'error',
            'The imported narration has no declared source.',
            'Declare whether this is your own recording or an authorized external synthesis.',
          ),
        );
      }
      if (!record.declaration.ownershipConfirmed || !record.declaration.ownershipStatement.trim()) {
        findings.push(
          finding(
            'IMPORT-OWNERSHIP-UNCONFIRMED',
            'error',
            'Ownership/authorization of the imported narration is not confirmed.',
            'Confirm that you own this recording or are authorized to publish it, then approve again.',
          ),
        );
      }
    }
    if (!record.scriptText.trim() || !record.scriptSha256) {
      findings.push(
        finding(
          'IMPORT-SCRIPT-MISSING',
          'error',
          'The exact spoken script of the imported narration is not on record.',
          'Enter the exact spoken text of this narration and approve it again.',
        ),
      );
    }
    if (!(record.durationSec > 0)) {
      findings.push(
        finding(
          'IMPORT-DURATION-UNKNOWN',
          'error',
          'The duration of the imported narration was never measured.',
          'Re-import the file so its decoded duration can be measured.',
        ),
      );
    }
    if (!record.sha256 || !input.currentArtifactSha256) {
      findings.push(
        finding(
          'IMPORT-ARTIFACT-MISSING',
          'error',
          'The imported narration file is not readable on disk.',
          'Re-import the narration file for this target.',
        ),
      );
    }
  }

  const approval = input.approval;
  if (!approval) {
    findings.push(
      finding(
        'IMPORT-APPROVAL-MISSING',
        'error',
        'The imported narration has not been approved.',
        'Listen to the imported file and approve exactly those bytes.',
      ),
    );
  } else if (approval.decision === 'rejected') {
    findings.push(
      finding(
        'IMPORT-APPROVAL-REJECTED',
        'error',
        'The imported narration was rejected.',
        'Import the corrected narration and approve it explicitly.',
      ),
    );
  } else {
    if (!approval.listened) {
      findings.push(
        finding(
          'IMPORT-LISTENING-NOT-CONFIRMED',
          'error',
          'The imported narration was approved without confirming that it was listened to.',
          'Listen to the whole file, then approve it again with the listening confirmation.',
        ),
      );
    }
    if (approval.projectId !== input.projectId || approval.targetId !== input.targetId) {
      findings.push(
        finding(
          'IMPORT-APPROVAL-STALE-TARGET',
          'error',
          'The approval belongs to a different project or target.',
          'Approve the narration of this target explicitly.',
        ),
      );
    }
    if (record && approval.importId !== record.importId) {
      findings.push(
        finding(
          'IMPORT-APPROVAL-STALE-ARTIFACT',
          'error',
          'The approved narration is no longer the imported file of this target.',
          'Listen to the current file and approve it explicitly.',
        ),
      );
    }
    /* The approval must match BOTH the recorded import and the bytes that are
     * on disk right now; a replaced file fails either way. */
    if (
      record &&
      (approval.artifactSha256 !== record.sha256 ||
        (input.currentArtifactSha256 !== null && approval.artifactSha256 !== input.currentArtifactSha256))
    ) {
      findings.push(
        finding(
          'IMPORT-APPROVAL-STALE-ARTIFACT',
          'error',
          'The approved audio is no longer the audio on disk.',
          'Listen to the current file and approve it explicitly.',
        ),
      );
    }
    if (record && approval.scriptSha256 !== record.scriptSha256) {
      findings.push(
        finding(
          'IMPORT-APPROVAL-STALE-SCRIPT',
          'error',
          'The imported file\'s declared transcript changed after the narration was approved.',
          'The declared transcript is not rewritten to match a project edit. Import the corrected file if the transcript itself changed.',
        ),
      );
    }
    if (
      input.currentIntendedSpokenSha256
      && approval.intendedSpokenSha256 !== input.currentIntendedSpokenSha256
    ) {
      findings.push(
        finding(
          'IMPORT-APPROVAL-STALE-INTENDED-SCRIPT',
          'error',
          'The project\'s intended spoken script changed after this recording was approved.',
          'Restore the approved spoken script, or listen again and approve this recording for the current script. The imported transcript was not changed. Restoring the same spoken content does not require a new recording.',
        ),
      );
    }
    const speakerId = input.currentSpeakerId ?? record?.declaration?.speakerId ?? null;
    if (record && speakerId && approval.speakerId !== speakerId) {
      findings.push(
        finding(
          'IMPORT-APPROVAL-STALE-SPEAKER',
          'error',
          'The speaker assignment changed after the narration was approved.',
          'Re-assign the speaker or approve the narration again for the current speaker.',
        ),
      );
    }
    if (approval.timingRevision !== input.currentTimingRevision) {
      findings.push(
        finding(
          'IMPORT-APPROVAL-STALE-TIMING',
          'error',
          'The scene/caption timing changed after the narration was approved.',
          'Review the regenerated timing and approve the narration again.',
        ),
      );
    }
  }

  const blocking = findings.filter((f) => f.severity === 'error');
  return { allowed: blocking.length === 0, findings, blocking };
}

/* ------------------------------------------------------------------ */
/*  Timing evaluation                                                  */
/* ------------------------------------------------------------------ */

export interface ExternalNarrationTimingInput {
  targetId: TargetId;
  /** Measured duration of the approved audio. */
  audioDurationSec: number | null;
  /** Planned timeline length of the target (scenes, including the end card). */
  timelineDurationSec: number | null;
  /** Silent end-card length that is allowed after the last spoken word. */
  endCardSeconds: number;
  /** Timing/alignment revision recorded with the approval, when approved. */
  approvedTimingRevision?: string | null;
  /** Timing/alignment revision derived from the current facts. */
  currentTimingRevision: string;
  alignment: ExternalNarrationAlignment | null;
  /** True when the plan was regenerated after the audio was imported. */
  planRegeneratedForAudio?: boolean;
}

/**
 * Check that the planned timeline of a target still matches the real audio.
 *
 * The timeline must COVER the audio (the final words may never be cut) and may
 * only exceed it by the silent end card. Alignment is reported honestly:
 * estimates are warnings, never verified alignment.
 */
export function evaluateExternalNarrationTiming(
  input: ExternalNarrationTimingInput,
): ExternalNarrationEvaluation {
  const findings: ExternalNarrationFinding[] = [];
  const audio = input.audioDurationSec;
  const timeline = input.timelineDurationSec;

  if (audio !== null && !(audio > 0)) {
    findings.push(
      finding(
        'IMPORT-DURATION-UNKNOWN',
        'error',
        'The imported narration has no measured duration.',
        'Re-import the file so its decoded duration can be measured.',
      ),
    );
  }

  if (audio !== null && timeline !== null && audio > 0) {
    const slack = Number((timeline - audio).toFixed(3));
    if (slack < -0.05) {
      findings.push(
        finding(
          'TIMING-TIMELINE-SHORTER-THAN-AUDIO',
          'error',
          `The planned timeline is ${Math.abs(slack).toFixed(2)}s shorter than the imported narration, so the final words would be cut.`,
          'Regenerate the storyboard from the imported audio (or extend the last scene) so the timeline covers the whole narration.',
        ),
      );
    } else if (slack > Number((input.endCardSeconds + 0.25).toFixed(3))) {
      findings.push(
        finding(
          'TIMING-TIMELINE-LONGER-THAN-AUDIO',
          'warning',
          `The planned timeline runs ${slack.toFixed(2)}s past the end of the narration, which is more than the ${input.endCardSeconds.toFixed(2)}s silent end card.`,
          'Shorten the end card or regenerate the storyboard from the imported audio.',
        ),
      );
    }
  }

  if (input.planRegeneratedForAudio === false) {
    findings.push(
      finding(
        'TIMING-STALE-PLAN',
        'error',
        'The scene timing was not regenerated after this narration was imported.',
        'Regenerate the storyboard so scenes and captions follow the measured audio duration.',
      ),
    );
  }

  if (input.approvedTimingRevision && input.approvedTimingRevision !== input.currentTimingRevision) {
    findings.push(
      finding(
        'IMPORT-APPROVAL-STALE-TIMING',
        'error',
        'The timing/alignment revision changed after approval.',
        'Review the current timing and approve the narration again.',
      ),
    );
  }

  const alignment = input.alignment;
  if (!alignment || alignment.mode === 'none') {
    findings.push(
      finding(
        'TIMING-ALIGNMENT-MISSING',
        'warning',
        'No per-scene speech timing is available for this narration.',
        'Scene durations are estimates from the script, not measured alignment.',
      ),
    );
  } else if (alignment.mode === 'estimated_from_script') {
    findings.push(
      finding(
        'TIMING-ALIGNMENT-ESTIMATED',
        'warning',
        'Scene timing is ESTIMATED from the script; it is not verified alignment.',
        'Review the timing per scene and adjust it, or supply a per-scene timing file.',
      ),
    );
  }

  const blocking = findings.filter((f) => f.severity === 'error');
  return { allowed: blocking.length === 0, findings, blocking };
}

/* ------------------------------------------------------------------ */
/*  Readiness                                                          */
/* ------------------------------------------------------------------ */

export interface ExternalNarrationReadinessInput {
  projectId: string;
  targetId: TargetId;
  import: ExternalNarrationImport | null;
  currentArtifactSha256: string | null;
  approval: ExternalNarrationApproval | null;
  currentSpeakerId?: string | null;
  timing: ExternalNarrationTimingInput;
  /**
   * VS5 findings from the separate timing approval. Omitted by older callers,
   * which keep the VS4 readiness result. The export view always supplies them
   * when an import exists.
   */
  extraFindings?: ExternalNarrationFinding[];
  /** See `ExternalNarrationApprovalInput.currentIntendedSpokenSha256`. */
  currentIntendedSpokenSha256?: string | null;
}

export interface ExternalNarrationReadiness {
  targetId: TargetId;
  ready: boolean;
  /** Short operator-facing summary, e.g. "approved · timing covers 62.4s audio". */
  summary: string;
  findings: ExternalNarrationFinding[];
  blocking: ExternalNarrationFinding[];
  /** Distinct, de-duplicated blocking reasons in stable order. */
  blockReasons: string[];
}

/** Combined readiness of one target: declaration + approval + timing. */
export function evaluateExternalNarrationReadiness(
  input: ExternalNarrationReadinessInput,
): ExternalNarrationReadiness {
  const approvalEval = evaluateExternalNarrationApproval({
    projectId: input.projectId,
    targetId: input.targetId,
    import: input.import,
    currentArtifactSha256: input.currentArtifactSha256,
    approval: input.approval,
    currentSpeakerId: input.currentSpeakerId,
    currentTimingRevision: input.timing.currentTimingRevision,
    currentIntendedSpokenSha256: input.currentIntendedSpokenSha256,
  });
  const timingEval = evaluateExternalNarrationTiming(input.timing);

  const findings = [...approvalEval.findings, ...timingEval.findings, ...(input.extraFindings ?? [])];
  const blocking = findings.filter((f) => f.severity === 'error');
  const blockReasons: string[] = [];
  for (const f of blocking) if (!blockReasons.includes(f.message)) blockReasons.push(f.message);

  const audio = input.timing.audioDurationSec;
  const summary =
    blocking.length > 0
      ? `blocked: ${blocking[0].code}`
      : `approved · timeline covers ${audio === null ? 'the narration' : `${audio.toFixed(2)}s of audio`}`;

  return {
    targetId: input.targetId,
    ready: blocking.length === 0,
    summary,
    findings,
    blocking,
    blockReasons,
  };
}

/* ------------------------------------------------------------------ */
/*  Per-turn dialogue imports                                          */
/* ------------------------------------------------------------------ */

/**
 * One imported per-turn dialogue clip.
 *
 * A clip is only ever bound to ONE turn of ONE scene and ONE speaker. There is
 * deliberately no way to record a combined multi-speaker track as a set of
 * verified per-speaker clips: `combinedTrack` marks exactly that case, and the
 * coverage evaluation refuses to call it verified.
 */
export interface ExternalDialogueTurnImport {
  importId: string;
  projectId: string;
  scenarioId: string;
  sceneId: string;
  turnId: string;
  speakerId: string;
  speakerName: string;
  /** Exact spoken text of THIS turn. */
  spokenText: string;
  spokenTextSha256: string;
  /** Managed, project-scoped clip reference inside the dialogue audio root. */
  storedRef: string;
  sha256: string;
  durationSec: number;
  /** True when this single file carries more than one turn/speaker. */
  combinedTrack: boolean;
  /** Speaker identity declared for this clip (documented info, not proof). */
  engineName?: string | null;
  modelName?: string | null;
  voiceName?: string | null;
  createdAt: string;
}

export interface ExternalDialogueTurnExpectation {
  sceneId: string;
  turnId: string;
  speakerId: string;
  spokenText: string;
}

export interface ExternalDialogueCoverage {
  sceneId: string;
  turnId: string;
  speakerId: string;
  covered: boolean;
  /** True only for a clip bound to this turn+speaker+text (not a combined track). */
  verifiedPerSpeaker: boolean;
  findings: ExternalNarrationFinding[];
}

export interface ExternalDialogueEvaluation {
  allowed: boolean;
  coveredTurns: number;
  totalTurns: number;
  coverage: ExternalDialogueCoverage[];
  findings: ExternalNarrationFinding[];
  blocking: ExternalNarrationFinding[];
}

/**
 * Check imported per-turn clips against the turns the scenario actually has.
 *
 * A combined track never counts as verified per-speaker audio: it is reported
 * as coverage with `verifiedPerSpeaker: false` plus an explicit finding, so a
 * single uploaded file can never make a multi-speaker scene look verified.
 */
export function evaluateExternalDialogueCoverage(
  expectations: readonly ExternalDialogueTurnExpectation[],
  imports: readonly ExternalDialogueTurnImport[],
): ExternalDialogueEvaluation {
  const findings: ExternalNarrationFinding[] = [];
  const coverage: ExternalDialogueCoverage[] = [];
  let coveredTurns = 0;

  const byTurn = new Map<string, ExternalDialogueTurnImport[]>();
  for (const clip of imports) {
    const key = `${clip.sceneId}::${clip.turnId}`;
    const list = byTurn.get(key) ?? [];
    list.push(clip);
    byTurn.set(key, list);
  }

  for (const expectation of expectations) {
    const clips = byTurn.get(`${expectation.sceneId}::${expectation.turnId}`) ?? [];
    const local: ExternalNarrationFinding[] = [];
    if (clips.length === 0) {
      local.push(
        finding(
          'DIALOGUE-TURN-CLIP-MISSING',
          'error',
          `No imported clip exists for turn ${expectation.turnId} of scene ${expectation.sceneId}.`,
          'Import a clip for that turn, or generate it inside the app.',
        ),
      );
    }
    let verifiedPerSpeaker = false;
    for (const clip of clips) {
      if (!(clip.durationSec > 0)) {
        local.push(
          finding(
            'DIALOGUE-DURATION-UNKNOWN',
            'error',
            `Imported clip for turn ${expectation.turnId} has no measured duration.`,
            'Re-import the clip so its decoded duration can be measured.',
          ),
        );
      }
      if (clip.speakerId !== expectation.speakerId) {
        local.push(
          finding(
            'DIALOGUE-TURN-SPEAKER-MISMATCH',
            'error',
            `Imported clip for turn ${expectation.turnId} belongs to speaker ${clip.speakerId}, not ${expectation.speakerId}.`,
            'Import the clip again for the correct speaker.',
          ),
        );
      }
      if (clip.spokenTextSha256 !== externalNarrationScriptSha256(expectation.spokenText)) {
        local.push(
          finding(
            'DIALOGUE-TURN-TEXT-MISMATCH',
            'error',
            `Imported clip for turn ${expectation.turnId} does not match the spoken text of that turn.`,
            'Import a clip whose spoken text is exactly this turn, or correct the turn text.',
          ),
        );
      }
      if (clip.combinedTrack) {
        local.push(
          finding(
            'DIALOGUE-COMBINED-TRACK-NOT-PER-SPEAKER',
            'error',
            `The audio imported for turn ${expectation.turnId} is a combined track, so it is not verified audio for speaker ${expectation.speakerId}.`,
            'Import one clip per turn and speaker instead of a combined track.',
          ),
        );
      } else if (clip.speakerId === expectation.speakerId && clip.durationSec > 0) {
        verifiedPerSpeaker = true;
      }
    }
    if (clips.length > 0) coveredTurns += 1;
    coverage.push({
      sceneId: expectation.sceneId,
      turnId: expectation.turnId,
      speakerId: expectation.speakerId,
      covered: clips.length > 0,
      verifiedPerSpeaker,
      findings: local,
    });
    findings.push(...local);
  }

  const blocking = findings.filter((f) => f.severity === 'error');
  return {
    allowed: blocking.length === 0,
    coveredTurns,
    totalTurns: expectations.length,
    coverage,
    findings,
    blocking,
  };
}
