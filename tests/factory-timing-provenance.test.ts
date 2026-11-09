/**
 * Pure rules for timing provenance (@buildtrack/core). No server, no I/O.
 * These pin the exact labels and the status precedence the API reports.
 */
import { describe, expect, it } from 'vitest';
import {
  predictFactoryTiming,
  timingProvenanceStatus,
  timingSourceLabel,
  TIMING_LABEL_UNRECORDED,
  TIMING_SOURCE_LABELS,
} from '../packages/core/src/factory/timing-provenance';

describe('exact timing labels', () => {
  it('uses the three approved strings, unchanged', () => {
    expect(TIMING_SOURCE_LABELS).toEqual({
      estimated_text_length: 'Estimated timing — not audio-aligned.',
      supplied: 'Supplied timing — not verified by an alignment engine.',
      measured_synthesis: 'Measured audio duration — not word alignment.',
    });
  });

  it('gives no claim for unknown or missing sources', () => {
    expect(timingSourceLabel('unknown')).toBe(TIMING_LABEL_UNRECORDED);
    expect(timingSourceLabel(undefined)).toBe(TIMING_LABEL_UNRECORDED);
    expect(timingSourceLabel('aligned')).toBe(TIMING_LABEL_UNRECORDED);
  });
});

describe('predicted source before apply', () => {
  it('measured without audio, supplied with audio and every scene timed, estimate otherwise', () => {
    expect(predictFactoryTiming({ hasAudio: false, allScenesTimed: false }).timingSource).toBe('measured_synthesis');
    expect(predictFactoryTiming({ hasAudio: false, allScenesTimed: true }).timingSource).toBe('measured_synthesis');
    expect(predictFactoryTiming({ hasAudio: true, allScenesTimed: true }).timingSource).toBe('supplied');
    expect(predictFactoryTiming({ hasAudio: true, allScenesTimed: false }).timingSource).toBe('estimated_text_length');
  });
});

describe('status precedence', () => {
  const base = { recordedSource: 'estimated_text_length', hasBoundaryBaseline: true, boundariesEdited: false, alignmentStatus: 'not_requested' as const };

  it('an estimate applied and unedited is "applied" with the estimate label, never aligned', () => {
    const s = timingProvenanceStatus(base);
    expect(s.status).toBe('applied');
    expect(s.label).toBe(TIMING_SOURCE_LABELS.estimated_text_length);
    expect(s.label).not.toMatch(/aligned(?<! not audio-aligned)/i);
  });

  it('approved alignment with unchanged boundaries is alignment_accepted, even for an estimate', () => {
    const s = timingProvenanceStatus({ ...base, alignmentStatus: 'approved' });
    expect(s.status).toBe('alignment_accepted');
    expect(s.appliedSource).toBe('estimated_text_length');
  });

  it('edits win over approval and over the applied label', () => {
    expect(timingProvenanceStatus({ ...base, boundariesEdited: true }).status).toBe('edited');
    expect(timingProvenanceStatus({ ...base, alignmentStatus: 'approved', boundariesEdited: true }).status).toBe('edited');
  });

  it('a proposal never changes the label', () => {
    const s = timingProvenanceStatus({ ...base, alignmentStatus: 'proposed' });
    expect(s.status).toBe('applied');
    expect(s.alignmentStatus).toBe('proposed');
  });

  it('records without a baseline stay legacy and never gain a stronger claim', () => {
    const s = timingProvenanceStatus({ recordedSource: 'supplied', hasBoundaryBaseline: false, boundariesEdited: null, alignmentStatus: 'not_requested' });
    expect(s.status).toBe('legacy');
    expect(s.label).toMatch(/cannot be detected/);
    expect(s.label).toContain(TIMING_SOURCE_LABELS.supplied);
  });

  it('no record at all is legacy with the unrecorded label', () => {
    const s = timingProvenanceStatus({ recordedSource: null, hasBoundaryBaseline: false, boundariesEdited: null, alignmentStatus: null });
    expect(s).toMatchObject({ status: 'legacy', label: TIMING_LABEL_UNRECORDED, appliedSource: null });
  });
});
