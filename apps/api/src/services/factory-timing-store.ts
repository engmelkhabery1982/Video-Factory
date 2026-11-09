/**
 * Timing provenance I/O. The pure rules (labels, precedence) live in
 * @buildtrack/core; this file reads and writes the `timing` block of
 * `factory-provenance.json` and hashes the boundaries the claim is about.
 *
 * Projects made before this block existed have no baseline. Their status says
 * so; their timing is never upgraded to a claim they did not record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { timingBoundariesOf, timingProvenanceStatus, type EditorDocument, type TimingStatus } from '@buildtrack/core';
import { projectDir } from './platform.js';

const PROVENANCE_FILE = 'factory-provenance.json';

/** Written by apply. `boundariesSha256` moves when alignment is accepted, so only later manual edits count as edits. */
export interface TimingBlock {
  schemaVersion: 1;
  source: string;
  boundariesSha256: string;
  appliedAt: string;
}

export function timingBoundariesSha256(doc: EditorDocument): string {
  return createHash('sha256').update(JSON.stringify(timingBoundariesOf(doc))).digest('hex');
}

function provenancePath(projectId: string): string {
  return path.join(projectDir(projectId), PROVENANCE_FILE);
}

export function readProvenance(projectId: string): Record<string, unknown> | null {
  const file = provenancePath(projectId);
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Called when an alignment proposal is accepted. Acceptance is a real review
 * step that changes the captions on purpose, so the baseline moves to the accepted
 * boundaries. Later edits then show as `edited`. Projects with no timing block
 * are left alone. Failures are reported to the caller, not thrown into the accept.
 */
export function rebaseTimingBaseline(projectId: string, doc: EditorDocument): void {
  const prov = readProvenance(projectId);
  const block = prov?.timing;
  if (!prov || !block || typeof block !== 'object') return;
  writeJsonAtomic(provenancePath(projectId), {
    ...prov,
    timing: { ...(block as TimingBlock), boundariesSha256: timingBoundariesSha256(doc) },
  });
}

/** Status for a project from its provenance and its current editor document (null when none). */
export function timingStatusFor(projectId: string, doc: EditorDocument | null): TimingStatus {
  const prov = readProvenance(projectId);
  const block = prov?.timing && typeof prov.timing === 'object' ? (prov.timing as Partial<TimingBlock>) : null;
  const baseline = typeof block?.boundariesSha256 === 'string' ? block.boundariesSha256 : null;
  const recordedSource = block?.source ?? prov?.timingSource ?? null;
  return timingProvenanceStatus({
    recordedSource,
    hasBoundaryBaseline: baseline !== null,
    boundariesEdited: doc && baseline !== null ? timingBoundariesSha256(doc) !== baseline : null,
    alignmentStatus: doc?.alignment?.status ?? null,
  });
}
