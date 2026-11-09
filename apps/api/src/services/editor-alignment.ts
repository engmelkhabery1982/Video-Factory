/**
 * Alignment jobs and proposals (milestone 1). A proposal is a reviewed-timing
 * candidate: it changes nothing until the owner accepts it, and it becomes
 * stale the moment the document or the narration bytes change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  EditorError,
  alignmentIdentityPayload,
  alignmentUnits,
  applyAlignmentRows,
  excerptIdentitySha256,
  narrationMappingOf,
  syncVerdict,
  validateAlignmentRows,
  type AlignmentRow,
  type EditorDocument,
  type NarrationBinding,
  type SyncVerdict,
  type TargetId,
} from '@buildtrack/core';
import { loadVoiceAudioState, voiceAudioStatePath } from './voice-audio-state.js';
import { narrationBindingFor, narrationFileAbs } from './editor-narration.js';
import { loadAssetIndex } from '../routes/assets.js';
import { libraryAudioFile, sha256File } from './editor-library-audio.js';
import { editorDir, readEditorState, withEditorLock, writeEditorState, type EditorState } from './editor-store.js';
import { loadRecord, newId, saveRecord } from './editor-jobs.js';
import { rebaseTimingBaseline } from './factory-timing-store.js';
import { alignRuntime, boundariesPath, parseBoundaries, runAlignRunner, type AlignRuntime, type TranscriptProvenanceSummary } from './vf-align-worker.js';

export type AlignmentJobStatus = 'running' | 'proposed' | 'failed' | 'unavailable';
export type ProposalStatus = 'proposed' | 'accepted' | 'stale';

export interface AlignmentJobRecord {
  jobId: string;
  projectId: string;
  targetId: TargetId;
  status: AlignmentJobStatus;
  sourceRevision: number;
  audioSha256: string;
  importId: string;
  identitySha256: string;
  /**
   * Identity of the narration excerpt this job runs on: audio bytes, source
   * window and composition start. Null for jobs started before this existed.
   */
  excerptSha256?: string | null;
  /** The snapshot the worker reads (canonical editor units), and its digest. */
  snapshotFile: string;
  snapshotSha256: string;
  durationSec: number;
  reviewDir: string;
  proposalId: string | null;
  error: string | null;
  detail: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Server-resolved library file; never accepted from a client. */
  libraryWavFile?: string;
  libraryStateFile?: string;
}

export interface ProposalRecord {
  proposalId: string;
  jobId: string;
  projectId: string;
  targetId: TargetId;
  status: ProposalStatus;
  sourceRevision: number;
  audioSha256: string;
  importId: string;
  identitySha256: string;
  rows: AlignmentRow[];
  unresolved: unknown[];
  detail: string;
  createdAt: string;
  acceptedRevision: number | null;
  staleReasons: string[];
  /** Excerpt identity the proposal was made for. Missing on older proposals, which are then stale. */
  excerptSha256?: string | null;
  /** Synchronization verdict: forced alignment alone is never verified. */
  syncVerdict?: SyncVerdict;
  syncReasons?: string[];
  /** Independent transcript that was compared, when one was produced. */
  transcript?: string | null;
  /** Where the compared transcript came from. Null when none was compared. */
  transcriptProvenance?: TranscriptProvenanceSummary | null;
}

/** Identity of the narration excerpt as it stands in this document right now. Null when there is no narration. */
export function currentExcerptSha256(doc: EditorDocument, narration: NarrationBinding | null): string | null {
  const mapping = narrationMappingOf(doc);
  if (!narration || !mapping) return null;
  return excerptIdentitySha256({
    audioSha256: narration.sha256,
    sourceInSec: mapping.sourceInSec,
    sourceOutSec: mapping.sourceOutSec,
    compositionStartSec: mapping.startSec,
  });
}

const sha256Text = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Alignment reads the script from the `long` import only. Other targets are refused, not guessed. */
export const ALIGNMENT_TARGET = 'long' as const;

/** Job ids this process started and has not finished. A restart leaves none, so a stuck "running" state can be retried. */
const activeJobs = new Map<string, string>();
const activeKey = (videoId: string, targetId: TargetId) => `${videoId}:${targetId}`;

export function reviewRootFor(rt: AlignRuntime, videoId: string, jobId: string): string {
  return path.join(rt.reviewRoot, videoId, jobId);
}

export function alignmentStatusView(job: AlignmentJobRecord, dependencyStale: boolean) {
  return {
    jobId: job.jobId,
    targetId: job.targetId,
    status: job.status,
    sourceRevision: job.sourceRevision,
    stale: job.status === 'proposed' && dependencyStale,
    proposalId: job.proposalId,
    error: job.error,
    detail: job.detail,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

/**
 * Start the runner for the current narration. Must be called under the editor
 * lock with the current state. Returns the job record. The runner's result is
 * applied later by finishAlignment.
 */
/**
 * Immutable input for the worker: one unit per caption cue (its id as the scene
 * id, its text as the narration), in document order. Visual clips are not inputs.
 * The identity hashes the same units, so the two cannot disagree.
 */
export function buildAlignmentSnapshot(doc: EditorDocument, targetId: TargetId): { snapshot: Record<string, unknown>; text: string } {
  const units = alignmentUnits(doc);
  if (units.length === 0) throw new EditorError('ALIGNMENT_NO_CAPTIONS', 'There are no captions to align. Add or generate captions first.', 422);
  const starts = doc.captions.filter((c) => !c.cueOf).map((c) => c.startSec);
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i] < starts[i - 1]) {
      throw new EditorError('ALIGNMENT_CAPTIONS_UNORDERED', 'Captions must be in time order before they can be aligned.', 422);
    }
  }
  const snapshot = {
    schema: 'editor-alignment-snapshot-v2',
    targetId,
    storyboard: {
      long: {
        scenes: units.map((u, index) => ({ id: u.unitId, index, narration: u.text, startTime: null, duration: null, userEdited: true })),
      },
      captions: [],
    },
  };
  return { snapshot, text: JSON.stringify(snapshot, null, 2) };
}

/** WAV header duration, computed the way the runner computes it (24 kHz mono PCM16 is checked there). */
export function wavDurationSec(bytes: Buffer): number | null {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let rate: number | null = null;
  let channels: number | null = null;
  let bits: number | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(start + 2);
      rate = bytes.readUInt32LE(start + 4);
      bits = bytes.readUInt16LE(start + 14);
    } else if (id === 'data') {
      dataBytes = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!rate || !channels || !bits || dataBytes === null) return null;
  return Number((dataBytes / (rate * channels * (bits / 8))).toFixed(3));
}

/**
 * Write the job's expected WAV identity from the narration import. The sha256 is
 * the import's recorded digest; the byte size and duration come from the file
 * that must match it. The runner refuses any other file.
 */
function writeExpectedAudio(job: AlignmentJobRecord, wavFile: string): string {
  const bytes = fs.readFileSync(wavFile);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== job.audioSha256) {
    throw new EditorError('EDITOR_NARRATION_CHANGED', 'The narration file no longer matches the import this alignment was started for.', 409);
  }
  const duration = wavDurationSec(bytes);
  if (duration === null) throw new EditorError('EDITOR_BAD_AUDIO', 'The narration file is not a readable WAV.', 422);
  const file = path.join(job.reviewDir, 'input', 'expected-audio.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sha256: sha, bytes: bytes.length, durationSec: duration }, null, 2) + '\n', 'utf8');
  return file;
}

export function beginAlignment(
  videoId: string,
  targetId: TargetId,
  state: EditorState,
  binding: NarrationBinding,
  rt: AlignRuntime,
): AlignmentJobRecord {
  if (activeJobs.has(activeKey(videoId, targetId))) {
    throw new EditorError('ALIGNMENT_ALREADY_RUNNING', 'An alignment job is already running for this target.', 409);
  }
  const jobId = newId('aln');
  const reviewDir = reviewRootFor(rt, videoId, jobId);
  const built = buildAlignmentSnapshot(state.document, targetId);
  const snapshotFile = path.join(reviewDir, 'input', 'project-snapshot.json');
  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
  fs.writeFileSync(snapshotFile, built.text, 'utf8');
  const job: AlignmentJobRecord = {
    jobId,
    projectId: videoId,
    targetId,
    status: 'running',
    sourceRevision: state.document.revision,
    audioSha256: binding.sha256,
    importId: binding.importId,
    identitySha256: sha256Text(alignmentIdentityPayload(state.document)),
    excerptSha256: currentExcerptSha256(state.document, binding),
    snapshotFile,
    snapshotSha256: sha256Text(built.text),
    durationSec: binding.durationSec,
    reviewDir,
    proposalId: null,
    error: null,
    detail: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  if (binding.importId.startsWith('library:')) {
    const entry = loadAssetIndex().find(a => a.id === binding.importId.slice(8));
    const file = libraryAudioFile(entry as unknown as Record<string, unknown>);
    if (!file || sha256File(file) !== binding.sha256) throw new EditorError('EDITOR_AUDIO_CHANGED', 'The supplied recording changed before alignment.', 409);
    job.libraryWavFile = file;
    job.libraryStateFile = path.join(reviewDir, 'input', 'library-narration-state.json');
    // Runner input snapshot only. No import, approval or source project is written.
    fs.writeFileSync(job.libraryStateFile, JSON.stringify({externalNarration:{imports:{long:{scriptText:alignmentUnits(state.document).map(u=>u.text).join('\n')}}}}), 'utf8');
  }
  saveRecord(videoId, 'alignment', jobId, job);
  const doc: EditorDocument = {
    ...state.document,
    alignment: { status: 'running', audioSha256: binding.sha256, sourceRevision: state.document.revision, proposalId: null },
  };
  writeEditorState(videoId, targetId, { ...state, document: doc });
  activeJobs.set(activeKey(videoId, targetId), jobId);
  return job;
}

/** Launch the runner in the background. The caller does not wait for it. */
export function launchAlignment(videoId: string, targetId: TargetId, job: AlignmentJobRecord, rt: AlignRuntime): void {
  const wav = job.libraryWavFile ?? narrationFileAbs(readStoredRef(videoId, targetId));
  void (async () => {
    let outcome;
    try {
      const inputs = {
        wavPath: wav ?? '',
        projectJsonPath: job.snapshotFile,
        stateJsonPath: job.libraryStateFile ?? voiceAudioStatePath(videoId),
        expectedAudioJsonPath: writeExpectedAudio(job, wav ?? ''),
        reviewDir: job.reviewDir,
        logDir: path.join(editorDir(videoId), 'alignment-logs', job.jobId),
      };
      outcome = await runAlignRunner(rt, inputs);
    } catch (err) {
      outcome = { exitCode: null, timedOut: false, spawnError: (err as Error).message, stdoutTail: '', stderrTail: '' };
    }
    try {
      await finishAlignment(videoId, targetId, job, outcome);
    } finally {
      activeJobs.delete(activeKey(videoId, targetId));
    }
  })();
}

function readStoredRef(videoId: string, targetId: TargetId): string {
  return loadVoiceAudioState(videoId).externalNarration?.imports?.[targetId]?.storedRef ?? '';
}

/** Turn a runner outcome into a job result, and a proposal only when every row is valid. */
/** The worker's input must be byte-identical to what the identity was computed from. */
function snapshotIntact(job: AlignmentJobRecord): boolean {
  try {
    return sha256Text(fs.readFileSync(job.snapshotFile, 'utf8')) === job.snapshotSha256;
  } catch {
    return false;
  }
}

export async function finishAlignment(
  videoId: string,
  targetId: TargetId,
  job: AlignmentJobRecord,
  outcome: { exitCode: number | null; timedOut: boolean; spawnError: string | null; stdoutTail: string; stderrTail: string },
): Promise<AlignmentJobRecord> {
  const finished: AlignmentJobRecord = { ...job, finishedAt: new Date().toISOString() };
  let proposal: ProposalRecord | null = null;
  const blocker = /BLOCKER=[^\s]+/.exec(`${outcome.stderrTail}\n${outcome.stdoutTail}`)?.[0] ?? null;
  try {
    if (outcome.spawnError) {
      finished.status = 'failed';
      finished.error = `The alignment runner could not start: ${outcome.spawnError}`;
    } else if (outcome.timedOut) {
      finished.status = 'failed';
      finished.error = 'The alignment runner timed out. Nothing was saved.';
    } else if (outcome.exitCode !== 0) {
      finished.status = 'failed';
      finished.error = blocker ?? `The alignment runner exited with code ${outcome.exitCode}. Nothing was saved.`;
    } else if (!snapshotIntact(job)) {
      finished.status = 'failed';
      finished.error = 'The alignment input snapshot changed while the runner was running. Nothing was saved.';
    } else {
      const parsed = parseBoundaries(boundariesPath(job.reviewDir));
      if (!parsed.available) {
        finished.status = 'unavailable';
        finished.detail = parsed.detail;
      } else if (parsed.audioSha256 !== job.audioSha256) {
        throw new EditorError('ALIGNMENT_OUTPUT_MISMATCH', 'The narration bytes changed during alignment. Nothing was saved.', 422);
      } else {
        const rows = validateAlignmentRows(parsed.rows, parsed.audioDurationSec ?? job.durationSec);
        // Independent comparison. The script is the snapshot's own units, which the identity already covers.
        const verdict = syncVerdict({
          evidenceExcerptSha256: job.excerptSha256 ?? null,
          currentExcerptSha256: job.excerptSha256 ?? null,
          forcedAlignmentAvailable: rows.length > 0,
          script: snapshotScriptText(job),
          transcript: parsed.transcript,
        });
        proposal = {
          excerptSha256: job.excerptSha256 ?? null,
          syncVerdict: verdict.verdict,
          syncReasons: parsed.transcriptRejected ? [...verdict.reasons, parsed.transcriptRejected] : verdict.reasons,
          transcript: parsed.transcript,
          transcriptProvenance: parsed.transcriptProvenance,
          proposalId: newId('prp'),
          jobId: job.jobId,
          projectId: videoId,
          targetId,
          status: 'proposed',
          sourceRevision: job.sourceRevision,
          audioSha256: job.audioSha256,
          importId: job.importId,
          identitySha256: job.identitySha256,
          rows,
          unresolved: parsed.unresolved,
          detail: parsed.detail,
          createdAt: new Date().toISOString(),
          acceptedRevision: null,
          staleReasons: [],
        };
        finished.status = 'proposed';
        finished.proposalId = proposal.proposalId;
      }
    }
  } catch (err) {
    finished.status = 'failed';
    finished.error = (err as Error).message;
  }

  // The document is updated only if this job still owns the running state.
  await withEditorLockAsync(videoId, () => {
    const state = readEditorState(videoId, targetId);
    if (!state || state.document.alignment.status !== 'running') return;
    const current = state.document;
    const staleReasons = proposal ? proposalStaleReasons(proposal, current, narrationForTarget(videoId, targetId)) : [];
    const usable = proposal !== null && staleReasons.length === 0;
    if (proposal && !usable) {
      proposal.status = 'stale';
      proposal.staleReasons = staleReasons;
      finished.proposalId = proposal.proposalId;
    }
    const alignment = usable && proposal
      ? { status: 'proposed' as const, audioSha256: job.audioSha256, sourceRevision: job.sourceRevision, proposalId: proposal.proposalId }
      : { status: 'not_requested' as const, audioSha256: null, sourceRevision: null, proposalId: null };
    writeEditorState(videoId, targetId, { ...state, document: { ...current, alignment } });
  });
  if (proposal) saveRecord(videoId, 'proposal', proposal.proposalId, proposal);
  saveRecord(videoId, 'alignment', job.jobId, finished);
  return finished;
}

/** Caption texts the alignment ran on, read from the verified snapshot. Empty if the snapshot cannot be read. */
function snapshotScriptText(job: AlignmentJobRecord): string {
  try {
    const raw = JSON.parse(fs.readFileSync(job.snapshotFile, 'utf8')) as { storyboard?: { long?: { scenes?: Array<{ narration?: string }> } } };
    return (raw.storyboard?.long?.scenes ?? []).map((s) => s.narration ?? '').join('\n');
  } catch {
    return '';
  }
}

/** Take the editor lock, waiting briefly if a writer holds it. Does not block the event loop. */
async function withEditorLockAsync(videoId: string, fn: () => void): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      withEditorLock(videoId, fn);
      return;
    } catch (err) {
      if (!(err instanceof EditorError) || err.code !== 'EDITOR_LOCKED' || attempt >= 60) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export function loadAlignmentJob(videoId: string, jobId: string): AlignmentJobRecord | null {
  const job = loadRecord<AlignmentJobRecord>(videoId, 'alignment', jobId);
  if (!job || job.status !== 'running' || activeJobs.get(activeKey(videoId, job.targetId)) === job.jobId) return job;
  // A job with no live runner (server restarted) is failed, and the document's
  // "running" marker is cleared so the owner can start again.
  const failed: AlignmentJobRecord = {
    ...job,
    status: 'failed',
    error: 'The alignment was interrupted before it finished (the server restarted). Start it again.',
    finishedAt: new Date().toISOString(),
  };
  saveRecord(videoId, 'alignment', job.jobId, failed);
  withEditorLock(videoId, () => {
    const state = readEditorState(videoId, job.targetId);
    if (!state || state.document.alignment.status !== 'running') return;
    const alignment = { status: 'not_requested' as const, audioSha256: null, sourceRevision: null, proposalId: null };
    writeEditorState(videoId, job.targetId, { ...state, document: { ...state.document, alignment } });
  });
  return failed;
}

export function loadProposal(videoId: string, proposalId: string): ProposalRecord | null {
  return loadRecord<ProposalRecord>(videoId, 'proposal', proposalId);
}

/** Every reason the proposal can no longer be applied. Empty means it is fresh. */
export function proposalStaleReasons(
  proposal: ProposalRecord,
  doc: EditorDocument,
  narration: NarrationBinding | null,
): string[] {
  const reasons: string[] = [];
  if (proposal.status === 'stale') reasons.push('the proposal was already marked stale');
  if (!narration) reasons.push('the narration is no longer imported for this target');
  else {
    if (narration.importId !== proposal.importId) reasons.push('a different narration import is now current');
    if (narration.sha256 !== proposal.audioSha256) reasons.push('the narration file bytes changed');
  }
  if (sha256Text(alignmentIdentityPayload(doc)) !== proposal.identitySha256) {
    reasons.push('caption text, caption order or the narration timing changed since the alignment');
  }
  // The excerpt check covers the audio bytes, the source window and the timeline placement together.
  // A proposal without excerpt evidence (made before this check) is stale: run the alignment again.
  const excerpt = currentExcerptSha256(doc, narration);
  if (!proposal.excerptSha256) {
    reasons.push('the alignment predates excerpt evidence; run it again');
  } else if (excerpt !== proposal.excerptSha256) {
    reasons.push('the narration excerpt changed (audio, source in/out, or timeline placement) since the alignment');
  }
  return reasons;
}

export function narrationForTarget(videoId: string, targetId: TargetId): NarrationBinding | null {
  try {
    const imported = narrationBindingFor(videoId, targetId);
    if (imported) return imported;
    const doc = readEditorState(videoId, targetId)?.document;
    if (!doc || doc.audioClips.length !== 1) return null;
    const clip = doc.audioClips[0];
    const asset = doc.assets.find(a => a.id === clip.sourceAssetId && a.kind === 'audio');
    const entry = loadAssetIndex().find(a => a.id === clip.sourceAssetId);
    const file = libraryAudioFile(entry as unknown as Record<string, unknown>);
    if (!asset?.sha256 || !asset.durationSec || !entry || entry.status !== 'active' || entry.blocked || !file || sha256File(file) !== asset.sha256) return null;
    return {importId:'library:'+asset.id, name:asset.name, mediaUrl:asset.mediaUrl, source:asset.source, license:asset.license, durationSec:asset.durationSec, sha256:asset.sha256, approved:clip.approved};
  } catch {
    return null;
  }
}

/** Apply a fresh proposal as one undoable transaction. Throws EDITOR_ALIGNMENT_STALE when it cannot apply. */
export function acceptProposal(
  videoId: string,
  targetId: TargetId,
  proposal: ProposalRecord,
  state: EditorState,
  binding: NarrationBinding | null,
): { next: EditorState; proposal: ProposalRecord } {
  const reasons = proposalStaleReasons(proposal, state.document, binding);
  if (reasons.length > 0) {
    const stale: ProposalRecord = { ...proposal, status: 'stale', staleReasons: reasons };
    const doc: EditorDocument = { ...state.document, alignment: { status: 'not_requested', audioSha256: null, sourceRevision: null, proposalId: null, excerptSha256: null, syncVerdict: null } };
    writeEditorState(videoId, targetId, { ...state, document: doc });
    saveRecord(videoId, 'proposal', proposal.proposalId, stale);
    throw new EditorError('ALIGNMENT_PROPOSAL_STALE', `The proposal is stale: ${reasons.join('; ')}. Nothing was applied.`, 409);
  }
  // A transcript that disagrees with the supplied text is never applied. The proposal is kept for review, unchanged.
  if (proposal.syncVerdict === 'discrepancy') {
    throw new EditorError(
      'ALIGNMENT_TRANSCRIPT_DISCREPANCY',
      `The transcript does not match the supplied text, so this alignment cannot be applied. ${(proposal.syncReasons ?? []).join(' ')} Nothing was applied.`,
      409,
    );
  }
  const applied = applyAlignmentRows(state.document, proposal.rows, {
    audioSha256: proposal.audioSha256,
    proposalId: proposal.proposalId,
    sourceRevision: proposal.sourceRevision,
    excerptSha256: proposal.excerptSha256 ?? null,
    syncVerdict: proposal.syncVerdict ?? 'unverified',
  });
  const next: EditorState = {
    schemaVersion: state.schemaVersion,
    document: { ...applied, revision: state.document.revision + 1 },
    undo: [...state.undo, state.document].slice(-50),
    redo: [],
  };
  writeEditorState(videoId, targetId, next);
  try {
    // Accepted alignment is the new reviewed baseline for timing provenance. Failure here never undoes the accept.
    rebaseTimingBaseline(videoId, next.document);
  } catch {
    // Left as the older baseline: the status then reports later boundary changes as edited, which is the safe reading.
  }
  const accepted: ProposalRecord = { ...proposal, status: 'accepted', acceptedRevision: next.document.revision };
  saveRecord(videoId, 'proposal', proposal.proposalId, accepted);
  return { next, proposal: accepted };
}

