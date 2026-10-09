/**
 * VS5 — review and correct caption/scene timing against an approved narration.
 *
 * The storyboard remains the only timing store. This module does not create a
 * second timeline, does not change audio bytes, and does not call a
 * transcription or alignment model.
 *
 * Four facts stay distinct:
 *   - estimated: durations were distributed from the script and the measured
 *     total. That is not word-accurate alignment.
 *   - imported structural match: a sibling timing file matches the scene text
 *     word for word. That proves script consistency, not that anyone listened
 *     to the synchronization.
 *   - manually approved: a person reviewed these exact times against this
 *     audio and approved this revision.
 *   - stale or invalid: the times no longer match the audio, the script, or
 *     the rules below.
 *
 * `acousticVerification` is always false here. Nothing in this module heard
 * the audio.
 */
import { createHash } from 'node:crypto';
import type { TargetId } from '../targets.js';
import type { ExternalNarrationAlignment, ExternalNarrationFinding } from './external-narration.js';

export const SPEECH_TIMING_SCHEMA = 'speech-timing-1' as const;

export type TimingSourceLabel = 'estimated' | 'imported_structural' | 'none';
export type TimingReviewStatus = 'not_approved' | 'approved' | 'stale' | 'rejected' | 'invalid';

export interface SpeechSceneTiming {
  sceneId: string;
  startTime: number;
  durationSec: number;
  narration: string;
  /** Used to recognise a silent end card. Not part of the speech revision. */
  role?: string;
}

export interface SpeechCaptionTiming {
  cueId: string;
  sceneId: string | null;
  start: number;
  end: number;
  text: string;
}

export interface SpeechTimingSnapshot {
  projectId: string;
  targetId: TargetId;
  artifactSha256: string;
  scriptSha256: string;
  audioDurationSec: number;
  endCardSeconds: number;
  scenes: SpeechSceneTiming[];
  captions: SpeechCaptionTiming[];
}

export interface ExternalNarrationTimingApproval {
  decision: 'approved' | 'rejected';
  projectId: string;
  targetId: TargetId;
  artifactSha256: string;
  scriptSha256: string;
  speechTimingRevision: string;
  /** True only when the operator states they reviewed the times against the audio. */
  reviewed: boolean;
  decidedAt: string;
  decidedBy: string;
  note?: string;
}

export interface TimingReviewDescription {
  source: TimingSourceLabel;
  review: TimingReviewStatus;
  /** Plain label for the source. Never "acoustically verified". */
  sourceLabel: string;
  reviewLabel: string;
  detail: string;
  acousticVerification: false;
}

const ROUND = 1000;

function round3(value: number): number {
  return Math.round(value * ROUND) / ROUND;
}

function finding(
  code: ExternalNarrationFinding['code'],
  severity: 'error' | 'warning',
  message: string,
  remediation: string,
): ExternalNarrationFinding {
  return { code, severity, message, remediation };
}

/**
 * Digest of the speech-relevant times only.
 *
 * Scene presentation (variant, background, assets, layout) is intentionally
 * absent, so a visual edit does not invalidate a timing approval. Caption and
 * scene boundaries, narration text, the audio digest and the spoken-script
 * digest are included, so any of those changes the revision.
 */
export function externalNarrationSpeechTimingRevision(snapshot: SpeechTimingSnapshot): string {
  const material = {
    schema: SPEECH_TIMING_SCHEMA,
    projectId: snapshot.projectId,
    targetId: snapshot.targetId,
    artifactSha256: snapshot.artifactSha256,
    scriptSha256: snapshot.scriptSha256,
    audioDurationSec: round3(snapshot.audioDurationSec),
    endCardSeconds: round3(snapshot.endCardSeconds),
    scenes: snapshot.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      startTime: round3(scene.startTime),
      durationSec: round3(scene.durationSec),
      narration: scene.narration,
    })),
    captions: snapshot.captions.map((cue) => ({
      cueId: cue.cueId,
      sceneId: cue.sceneId,
      start: round3(cue.start),
      end: round3(cue.end),
      text: cue.text,
    })),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export interface SpeechTimingValidationInput {
  snapshot: SpeechTimingSnapshot;
  /** Scene ids that belong to this target. A foreign id is a target mismatch. */
  ownedSceneIds: readonly string[];
  /** Cue ids that belong to this target. */
  ownedCueIds: readonly string[];
  /** Narration text currently stored for each owned scene, in storyboard order. */
  storedNarrationByScene: Readonly<Record<string, string>>;
  /** Caption text currently stored for each owned cue. */
  storedCaptionTextByCue: Readonly<Record<string, string>>;
}

export interface SpeechTimingValidation {
  allowed: boolean;
  issues: ExternalNarrationFinding[];
  blocking: ExternalNarrationFinding[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** End of the spoken scenes. A silent end card or CTA does not count as speech. */
export function speechEndSec(scenes: readonly SpeechSceneTiming[]): number {
  const spoken = scenes.filter((scene) => {
    if (scene.role === 'endcard' || scene.role === 'cta') return false;
    return true;
  });
  const relevant = spoken.length > 0 ? spoken : scenes;
  if (relevant.length === 0) return 0;
  return Math.max(...relevant.map((scene) => scene.startTime + scene.durationSec));
}

/**
 * Validate a proposed caption/scene timing for one target.
 *
 * Invalid proposals are rejected. They are never repaired by trimming audio,
 * stretching time, or deleting words.
 */
export function validateSpeechTiming(input: SpeechTimingValidationInput): SpeechTimingValidation {
  const issues: ExternalNarrationFinding[] = [];
  const { snapshot } = input;
  const audio = snapshot.audioDurationSec;
  const endCard = snapshot.endCardSeconds;
  const ownedScenes = new Set(input.ownedSceneIds);
  const ownedCues = new Set(input.ownedCueIds);

  if (!isFiniteNumber(audio) || audio <= 0) {
    issues.push(
      finding(
        'IMPORT-DURATION-UNKNOWN',
        'error',
        'The imported narration has no measured duration to review against.',
        'Re-import the narration so its decoded duration can be measured.',
      ),
    );
  }
  if (!isFiniteNumber(endCard) || endCard < 0) {
    issues.push(
      finding(
        'TIMING-TIME-INVALID',
        'error',
        'The silent end-card allowance is not a finite non-negative number.',
        'Reload the target and review its timing again.',
      ),
    );
  }

  const seenScenes = new Set<string>();
  for (const scene of snapshot.scenes) {
    if (!ownedScenes.has(scene.sceneId)) {
      issues.push(
        finding(
          'TIMING-TARGET-MISMATCH',
          'error',
          `Scene ${scene.sceneId} does not belong to this target.`,
          'Edit only the scenes of the selected target.',
        ),
      );
      continue;
    }
    if (seenScenes.has(scene.sceneId)) {
      issues.push(
        finding(
          'TIMING-SCENE-COVERAGE',
          'error',
          `Scene ${scene.sceneId} is listed more than once.`,
          'Submit each scene of this target once.',
        ),
      );
    }
    seenScenes.add(scene.sceneId);
    if (!isFiniteNumber(scene.startTime) || !isFiniteNumber(scene.durationSec)) {
      issues.push(
        finding(
          'TIMING-TIME-INVALID',
          'error',
          `Scene ${scene.sceneId} has a time that is not a finite number.`,
          'Enter a finite start and duration for that scene.',
        ),
      );
      continue;
    }
    if (scene.startTime < 0 || scene.durationSec <= 0) {
      issues.push(
        finding(
          'TIMING-TIME-INVALID',
          'error',
          `Scene ${scene.sceneId} must start at or after 0 and have a duration greater than 0.`,
          'Correct the start and duration of that scene.',
        ),
      );
    }
    const stored = input.storedNarrationByScene[scene.sceneId];
    if (stored !== undefined && scene.narration !== stored) {
      issues.push(
        finding(
          'TIMING-SCRIPT-ALTERED',
          'error',
          `Scene ${scene.sceneId} narration text changed during a timing edit.`,
          'Keep the spoken words. Change only the times, or update the spoken script through the import.',
        ),
      );
    }
  }
  for (const sceneId of input.ownedSceneIds) {
    if (!seenScenes.has(sceneId)) {
      issues.push(
        finding(
          'TIMING-SCENE-COVERAGE',
          'error',
          `Scene ${sceneId} is missing from the timing review.`,
          'Include every scene of this target.',
        ),
      );
    }
  }

  const ordered = snapshot.scenes
    .filter((scene) => ownedScenes.has(scene.sceneId) && isFiniteNumber(scene.startTime) && isFiniteNumber(scene.durationSec))
    .slice()
    .sort((a, b) => a.startTime - b.startTime);
  if (ordered.length > 0 && ordered[0].startTime > 0.02) {
    issues.push(
      finding(
        'TIMING-SCENE-GAP',
        'error',
        'The first scene does not start at the beginning of the timeline.',
        'Start the first scene at 0.',
      ),
    );
  }
  for (let i = 1; i < ordered.length; i += 1) {
    const previousEnd = ordered[i - 1].startTime + ordered[i - 1].durationSec;
    const gap = ordered[i].startTime - previousEnd;
    if (gap > 0.02) {
      issues.push(
        finding(
          'TIMING-SCENE-GAP',
          'error',
          `Scene ${ordered[i].sceneId} leaves a gap after ${ordered[i - 1].sceneId}.`,
          'Make each scene start where the previous scene ends.',
        ),
      );
    } else if (gap < -0.02) {
      issues.push(
        finding(
          'TIMING-SCENE-OVERLAP',
          'error',
          `Scene ${ordered[i].sceneId} overlaps ${ordered[i - 1].sceneId}.`,
          'Remove the overlap so the scenes tile the timeline.',
        ),
      );
    }
  }

  const timelineEnd = ordered.length
    ? ordered[ordered.length - 1].startTime + ordered[ordered.length - 1].durationSec
    : 0;
  const spokenEnd = speechEndSec(ordered);
  if (isFiniteNumber(audio) && audio > 0 && spokenEnd < audio - 0.05) {
    issues.push(
      finding(
        'TIMING-SPEECH-SHORTER-THAN-AUDIO',
        'error',
        `Spoken scenes end ${ (audio - spokenEnd).toFixed(2) }s before the narration ends, so the final words would be cut.`,
        'Extend the spoken scenes so they cover the whole narration. A silent end card may follow the last word; it must not replace it.',
      ),
    );
  }
  if (isFiniteNumber(audio) && isFiniteNumber(endCard) && timelineEnd > audio + endCard + 0.25) {
    issues.push(
      finding(
        'TIMING-OUT-OF-BOUNDS',
        'error',
        `The timeline runs ${(timelineEnd - audio).toFixed(2)}s past the narration, which is more than the ${endCard.toFixed(2)}s silent end card.`,
        'Shorten the end card so it stays within the allowed silence after the last word.',
      ),
    );
  }

  const seenCues = new Set<string>();
  for (const cue of snapshot.captions) {
    if (!ownedCues.has(cue.cueId)) {
      issues.push(
        finding(
          'TIMING-TARGET-MISMATCH',
          'error',
          `Caption ${cue.cueId} does not belong to this target.`,
          'Edit only the captions of the selected target.',
        ),
      );
      continue;
    }
    if (seenCues.has(cue.cueId)) {
      issues.push(
        finding(
          'TIMING-CUE-ORDER',
          'error',
          `Caption ${cue.cueId} is listed more than once.`,
          'Submit each caption of this target once.',
        ),
      );
    }
    seenCues.add(cue.cueId);
    if (cue.sceneId && !ownedScenes.has(cue.sceneId)) {
      issues.push(
        finding(
          'TIMING-TARGET-MISMATCH',
          'error',
          `Caption ${cue.cueId} is linked to a scene outside this target.`,
          'Keep each caption linked to a scene of this target.',
        ),
      );
    }
    if (!isFiniteNumber(cue.start) || !isFiniteNumber(cue.end)) {
      issues.push(
        finding(
          'TIMING-TIME-INVALID',
          'error',
          `Caption ${cue.cueId} has a time that is not a finite number.`,
          'Enter a finite start and end for that caption.',
        ),
      );
      continue;
    }
    if (cue.start < 0 || cue.end < 0 || cue.start >= cue.end) {
      issues.push(
        finding(
          'TIMING-TIME-INVALID',
          'error',
          `Caption ${cue.cueId} must start at or after 0 and end after it starts.`,
          'Correct the start and end of that caption.',
        ),
      );
    }
    if (isFiniteNumber(timelineEnd) && cue.end > timelineEnd + 0.02) {
      issues.push(
        finding(
          'TIMING-OUT-OF-BOUNDS',
          'error',
          `Caption ${cue.cueId} ends after the timeline.`,
          'Keep the caption inside this target timeline.',
        ),
      );
    }
    const stored = input.storedCaptionTextByCue[cue.cueId];
    if (stored !== undefined && cue.text !== stored) {
      issues.push(
        finding(
          'TIMING-SCRIPT-ALTERED',
          'error',
          `Caption ${cue.cueId} text changed during a timing edit.`,
          'Keep the caption words. Change only the times.',
        ),
      );
    }
  }
  for (const cueId of input.ownedCueIds) {
    if (!seenCues.has(cueId)) {
      issues.push(
        finding(
          'TIMING-CUE-MISSING',
          'error',
          `Caption ${cueId} is missing from the timing review.`,
          'Include every caption of this target. Do not drop words by deleting a cue.',
        ),
      );
    }
  }

  const orderedCues = snapshot.captions
    .filter((cue) => ownedCues.has(cue.cueId) && isFiniteNumber(cue.start) && isFiniteNumber(cue.end))
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < orderedCues.length; i += 1) {
    if (orderedCues[i].start < orderedCues[i - 1].end - 0.001) {
      issues.push(
        finding(
          'TIMING-CUE-OVERLAP',
          'error',
          `Caption ${orderedCues[i].cueId} overlaps ${orderedCues[i - 1].cueId}.`,
          'Move the captions so they do not overlap. Touching boundaries are allowed.',
        ),
      );
    }
  }

  const blocking = issues.filter((item) => item.severity === 'error');
  return { allowed: blocking.length === 0, issues, blocking };
}

export interface TimingApprovalEvaluationInput {
  projectId: string;
  targetId: TargetId;
  artifactSha256: string;
  scriptSha256: string;
  speechTimingRevision: string;
  approval: ExternalNarrationTimingApproval | null;
}

/** Whether the explicit timing approval still describes this audio, script and revision. */
export function evaluateExternalTimingApproval(
  input: TimingApprovalEvaluationInput,
): { allowed: boolean; findings: ExternalNarrationFinding[]; blocking: ExternalNarrationFinding[] } {
  const findings: ExternalNarrationFinding[] = [];
  const approval = input.approval;
  if (!approval) {
    findings.push(
      finding(
        'TIMING-APPROVAL-MISSING',
        'error',
        'The caption and scene timing has not been approved for this narration.',
        'Review the times against the approved audio, then approve this timing revision.',
      ),
    );
  } else if (approval.decision === 'rejected') {
    findings.push(
      finding(
        'TIMING-APPROVAL-REJECTED',
        'error',
        'The caption and scene timing was rejected.',
        'Correct the times and approve them explicitly.',
      ),
    );
  } else {
    if (!approval.reviewed) {
      findings.push(
        finding(
          'TIMING-REVIEW-NOT-CONFIRMED',
          'error',
          'The timing was approved without confirming that it was reviewed against the audio.',
          'Review the times against the audio, then approve again.',
        ),
      );
    }
    if (approval.projectId !== input.projectId || approval.targetId !== input.targetId) {
      findings.push(
        finding(
          'TIMING-TARGET-MISMATCH',
          'error',
          'The timing approval belongs to a different project or target.',
          'Approve the timing of this target explicitly. A Short does not inherit the Long timing.',
        ),
      );
    }
    if (
      approval.artifactSha256 !== input.artifactSha256 ||
      approval.scriptSha256 !== input.scriptSha256 ||
      approval.speechTimingRevision !== input.speechTimingRevision
    ) {
      findings.push(
        finding(
          'TIMING-APPROVAL-STALE',
          'error',
          'The timing approval does not match the current audio, spoken script, or caption/scene times.',
          'Review the current times against the current audio and approve them again.',
        ),
      );
    }
  }
  const blocking = findings.filter((item) => item.severity === 'error');
  return { allowed: blocking.length === 0, findings, blocking };
}

export function describeTimingReview(input: {
  alignment: ExternalNarrationAlignment | null;
  approval: ExternalNarrationTimingApproval | null;
  validationAllowed: boolean;
  approvalAllowed: boolean;
}): TimingReviewDescription {
  const structural = input.alignment?.mode === 'exact_scene_timing' && input.alignment.verified === true;
  const source: TimingSourceLabel = !input.alignment || input.alignment.mode === 'none'
    ? 'none'
    : structural
      ? 'imported_structural'
      : 'estimated';
  const sourceLabel = structural
    ? 'Script-matched timing'
    : source === 'none'
      ? 'No per-scene timing'
      : 'Estimated timing';
  const sourceDetail = structural
    ? 'A timing file matches every scene word for word. That proves the script matches the file. It is not proof that anyone listened to the synchronization, and it is not automatic word-accurate alignment.'
    : 'Scene and caption times are estimates from the script and the measured duration. They are not word-accurate alignment.';

  let review: TimingReviewStatus = 'not_approved';
  let reviewLabel = 'Timing not approved';
  let reviewDetail = 'These times have not been explicitly approved against this audio.';
  if (!input.validationAllowed) {
    review = 'invalid';
    reviewLabel = 'Timing invalid';
    reviewDetail = 'The current times break a timing rule. Export stays blocked until they are corrected.';
  } else if (input.approval?.decision === 'rejected') {
    review = 'rejected';
    reviewLabel = 'Timing rejected';
    reviewDetail = 'The timing was rejected and cannot be exported as ready.';
  } else if (input.approval && !input.approvalAllowed) {
    review = 'stale';
    reviewLabel = 'Timing stale';
    reviewDetail = 'The timing approval does not match the current audio, spoken script, or caption/scene times.';
  } else if (input.approval && input.approvalAllowed && input.approval.decision === 'approved') {
    review = 'approved';
    reviewLabel = 'Timing approved';
    reviewDetail = 'These times were explicitly reviewed against this audio and approved for this revision.';
  }

  return {
    source,
    review,
    sourceLabel,
    reviewLabel,
    detail: review === 'approved' ? `${reviewDetail} ${sourceDetail}` : `${sourceDetail} ${reviewDetail}`,
    acousticVerification: false,
  };
}
