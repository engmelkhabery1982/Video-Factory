/**
 * Timing provenance: what a timing source is allowed to claim, and whether the
 * timing on screen still matches what apply produced. Pure: no I/O, no hashing.
 * The API computes the boundary hash and passes the comparison result in.
 *
 * Labels are owned here so the API and the UI cannot disagree. None of them says
 * "aligned" for an estimate: word alignment is only claimed when the alignment
 * status is `approved` (reviewed acceptance of an alignment proposal).
 */
import type { EditorAlignmentState, EditorDocument } from '../editor/document.js';
import type { FactoryTimingSource } from './contract.js';

export type TimingAppliedSource = Exclude<FactoryTimingSource, 'unknown'>;

export const TIMING_APPLIED_SOURCES: readonly TimingAppliedSource[] = [
  'estimated_text_length',
  'supplied',
  'measured_synthesis',
];

/** Exact user-facing strings. Changing them is a visible contract change. */
export const TIMING_SOURCE_LABELS: Readonly<Record<TimingAppliedSource, string>> = {
  estimated_text_length: 'Estimated timing — not audio-aligned.',
  supplied: 'Supplied timing — not verified by an alignment engine.',
  measured_synthesis: 'Measured audio duration — not word alignment.',
};

export const TIMING_LABEL_UNRECORDED = 'Timing source not recorded for this project.';
export const TIMING_LABEL_EDITED =
  'Timing edited after apply — the boundaries on screen no longer match the applied timing. Not verified by an alignment engine.';
export const TIMING_LABEL_ALIGNMENT_ACCEPTED =
  'Caption timing aligned by the alignment engine and accepted in review.';
export const TIMING_LABEL_PRE_TRACKING =
  ' Applied before edit tracking existed, so edits made since apply cannot be detected.';

export function isTimingAppliedSource(value: unknown): value is TimingAppliedSource {
  return typeof value === 'string' && (TIMING_APPLIED_SOURCES as readonly string[]).includes(value);
}

/** Label for a stored source. Unknown or missing values never get a claim. */
export function timingSourceLabel(source: unknown): string {
  return isTimingAppliedSource(source) ? TIMING_SOURCE_LABELS[source] : TIMING_LABEL_UNRECORDED;
}

/**
 * Predicted source before apply. Matches planFactoryTiming: measured speech when
 * no full audio is supplied; supplied when audio and every scene already has times;
 * otherwise an estimate from text length.
 */
export function predictFactoryTiming(input: { hasAudio: boolean; allScenesTimed: boolean }): {
  timingSource: TimingAppliedSource;
  label: string;
} {
  const timingSource: TimingAppliedSource = !input.hasAudio
    ? 'measured_synthesis'
    : input.allScenesTimed
      ? 'supplied'
      : 'estimated_text_length';
  return { timingSource, label: TIMING_SOURCE_LABELS[timingSource] };
}

/** The boundaries a timing claim is about. Anything else (text, styling) is not timing. */
export interface TimingBoundaries {
  durationSec: number;
  visual: Array<[string, number, number, number | null, number | null]>;
  audio: Array<[string, number, number, number]>;
  captions: Array<[string, number, number]>;
}

export function timingBoundariesOf(doc: EditorDocument): TimingBoundaries {
  return {
    durationSec: doc.durationSec,
    visual: (doc.visualClips ?? []).map((c) => [c.id, c.startSec, c.durationSec, c.sourceInSec, c.sourceOutSec]),
    audio: (doc.audioClips ?? []).map((c) => [c.id, c.startSec, c.sourceInSec, c.sourceOutSec]),
    captions: (doc.captions ?? []).map((c) => [c.id, c.startSec, c.endSec]),
  };
}

export type TimingStatusKind = 'legacy' | 'applied' | 'edited' | 'alignment_accepted';

export interface TimingStatusInput {
  /** Source recorded at apply time, or null when the project has no provenance timing block. */
  recordedSource: unknown;
  /** Whether a boundary hash was recorded. Pre-tracking projects have a source but no hash. */
  hasBoundaryBaseline: boolean;
  /** Current boundaries differ from the recorded baseline. Null when no baseline exists. */
  boundariesEdited: boolean | null;
  alignmentStatus: EditorAlignmentState | null;
}

export interface TimingStatus {
  status: TimingStatusKind;
  label: string;
  /** The source apply recorded, or null when none was recorded. Never a claim by itself. */
  appliedSource: TimingAppliedSource | null;
  appliedLabel: string;
  alignmentStatus: EditorAlignmentState | null;
  boundariesEdited: boolean | null;
}

/**
 * Status precedence:
 *   1. approved alignment, boundaries not known edited -> alignment_accepted
 *   2. boundaries differ from the baseline          -> edited (wins over approval)
 *   3. recorded source, baseline matches            -> applied (source label)
 *   4. otherwise                                    -> legacy (never a claim of alignment)
 * Alignment `proposed`/`running` never changes the label: a proposal is not applied.
 */
export function timingProvenanceStatus(input: TimingStatusInput): TimingStatus {
  const source = isTimingAppliedSource(input.recordedSource) ? input.recordedSource : null;
  const appliedLabel = source ? TIMING_SOURCE_LABELS[source] : TIMING_LABEL_UNRECORDED;
  const base = { appliedSource: source, appliedLabel, alignmentStatus: input.alignmentStatus, boundariesEdited: input.boundariesEdited };
  const approved = input.alignmentStatus === 'approved';
  if (approved && input.boundariesEdited !== true) {
    return { ...base, status: 'alignment_accepted', label: TIMING_LABEL_ALIGNMENT_ACCEPTED };
  }
  if (input.boundariesEdited === true) {
    return { ...base, status: 'edited', label: TIMING_LABEL_EDITED };
  }
  if (source && input.hasBoundaryBaseline && input.boundariesEdited === false) {
    return { ...base, status: 'applied', label: appliedLabel };
  }
  if (source) {
    return { ...base, status: 'legacy', label: `${appliedLabel}${TIMING_LABEL_PRE_TRACKING}` };
  }
  return { ...base, status: 'legacy', label: TIMING_LABEL_UNRECORDED };
}
