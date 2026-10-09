/**
 * Identity and audio bytes a final export is allowed to consume.
 *
 * Validation used to compare project id, updatedAt, the script digest, and
 * audio file digests, then reload the project and pass the original audio
 * path to the muxer. A caption PATCH does not change updatedAt, so that
 * identity stayed equal while the reload picked up unapproved cues. The muxer
 * also reread the source path after the last digest check.
 *
 * This module binds the check to the target speech-timing revision and the
 * listening/timing approval records, and copies the approved audio bytes into
 * a private per-export directory. Concurrent edits are isolated by that
 * snapshot. They are not locked. A mismatch while copying rejects the export.
 * The original recording is never modified, and cleanup deletes only that
 * export's directory.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  externalNarrationSpeechTimingRevision,
  type Project,
  type TargetAudioMap,
  type TargetId,
} from '@buildtrack/core';
import { durationOf } from './media.js';
import { DATA_DIR } from './platform.js';
import { loadProject } from './store.js';
import { loadVoiceAudioState, type VoiceAudioPersistedState } from './voice-audio-state.js';
import { allTargetIds, digestOfFile, speechSnapshot, targetAudioAbsPath } from '../routes/external-narration.js';

export interface ExportAudioIdentity {
  targetId: string;
  ref: string | null;
  sha256: string | null;
}

export interface ExportReviewIdentity {
  targetId: string;
  speechTimingRevision: string | null;
  listeningSha256: string | null;
  timingApprovalSha256: string | null;
}

export interface ExportIdentity {
  projectId: string;
  updatedAt: string;
  scriptSha256: string;
  /** Targets whose speech timing and approvals this identity covers. */
  reviewTargets: string[];
  audio: ExportAudioIdentity[];
  review: ExportReviewIdentity[];
}

/**
 * Deterministic seam for the async boundary. Production leaves these null.
 * A test sets one to mutate the project, the approval, or the audio file.
 */
export const exportValidationHooks: {
  afterInitialRead: null | (() => void | Promise<void>);
  beforeConsume: null | (() => void | Promise<void>);
  /** Runs immediately before the approved bytes are read for the snapshot. */
  duringAudioAcquire: null | ((targetId: string) => void | Promise<void>);
} = {
  afterInitialRead: null,
  beforeConsume: null,
  duringAudioAcquire: null,
};

const JOB_TOKEN_RE = /^job_[a-f0-9]{32}$/;
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg']);

function narrationRef(project: Project, target: TargetId): string | null {
  return target === 'long'
    ? project.meta.input.voiceoverFile ?? null
    : project.meta.input.targetAudio?.[target as 'short_1' | 'short_2' | 'short_3'] ?? null;
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function listeningSha256(state: VoiceAudioPersistedState, target: TargetId): string | null {
  const approval = state.externalNarration?.approvals?.[target];
  if (!approval) return null;
  return digestJson({
    decision: approval.decision,
    importId: approval.importId,
    artifactSha256: approval.artifactSha256,
    scriptSha256: approval.scriptSha256,
    intendedSpokenSha256: approval.intendedSpokenSha256 ?? null,
    speakerId: approval.speakerId,
    listened: approval.listened,
  });
}

function timingApprovalSha256(state: VoiceAudioPersistedState, target: TargetId): string | null {
  const approval = state.externalNarration?.timingApprovals?.[target];
  if (!approval) return null;
  return digestJson({
    decision: approval.decision,
    artifactSha256: approval.artifactSha256,
    scriptSha256: approval.scriptSha256,
    speechTimingRevision: approval.speechTimingRevision,
    reviewed: approval.reviewed,
  });
}

function speechRevisionOf(project: Project, target: TargetId, state: VoiceAudioPersistedState): string | null {
  const record = state.externalNarration?.imports?.[target];
  if (!record) return null;
  const sha = digestOfFile(targetAudioAbsPath(project, target)) ?? record.sha256;
  const speech = speechSnapshot(project, target, sha, record.scriptSha256, record.durationSec ?? 0);
  return externalNarrationSpeechTimingRevision(speech.snapshot);
}

function reviewTargetsOf(project: Project, requested?: readonly string[]): string[] {
  const known = new Set(allTargetIds(project));
  const source = requested ?? allTargetIds(project);
  return [...new Set(source.filter((id) => known.has(id as TargetId)))].sort();
}

export function identityOf(project: Project, opts: { reviewTargets?: readonly string[] } = {}): ExportIdentity {
  const state = loadVoiceAudioState(project.meta.input.videoId);
  const reviewTargets = reviewTargetsOf(project, opts.reviewTargets);
  return {
    projectId: project.meta.input.videoId,
    updatedAt: project.meta.updatedAt,
    scriptSha256: createHash('sha256').update(project.meta.input.script, 'utf8').digest('hex'),
    reviewTargets,
    audio: allTargetIds(project).map((target) => ({
      targetId: target,
      ref: narrationRef(project, target),
      sha256: digestOfFile(targetAudioAbsPath(project, target)),
    })),
    review: reviewTargets.map((target) => ({
      targetId: target,
      speechTimingRevision: speechRevisionOf(project, target as TargetId, state),
      listeningSha256: listeningSha256(state, target as TargetId),
      timingApprovalSha256: timingApprovalSha256(state, target as TargetId),
    })),
  };
}

export function readExportIdentity(videoId: string, reviewTargets?: readonly string[]): ExportIdentity | null {
  const project = loadProject(videoId);
  return project ? identityOf(project, { reviewTargets }) : null;
}

export function sameExportIdentity(left: ExportIdentity | null | undefined, right: ExportIdentity | null | undefined): boolean {
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function reviewIdentityChanged(left: ExportIdentity, right: ExportIdentity): boolean {
  return JSON.stringify(left.review) !== JSON.stringify(right.review);
}

/** Private root for per-export audio copies. Not a public media route and not a Git path. */
export function exportAudioScratchRoot(): string {
  return path.join(DATA_DIR, 'export-audio-scratch');
}

export function newExportAudioJobToken(): string {
  return `job_${randomBytes(16).toString('hex')}`;
}

function jobDirectory(token: string): string | null {
  if (!JOB_TOKEN_RE.test(token)) return null;
  const root = exportAudioScratchRoot();
  fs.mkdirSync(root, { recursive: true });
  const rootReal = fs.realpathSync(root);
  const dir = path.resolve(rootReal, token);
  if (path.dirname(dir) !== rootReal) return null;
  return dir;
}

/** Deletes one export's scratch directory. Never the root, the original, or another job. */
export function cleanupExportAudioJob(token: string): void {
  const dir = jobDirectory(token);
  if (!dir) return;
  let listed: fs.Stats;
  try {
    listed = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (listed.isSymbolicLink()) {
    fs.unlinkSync(dir);
    return;
  }
  if (!listed.isDirectory()) return;
  const real = fs.realpathSync(dir);
  const rootReal = fs.realpathSync(exportAudioScratchRoot());
  if (real !== rootReal && path.dirname(real) !== rootReal) return;
  fs.rmSync(real, { recursive: true, force: true });
}

function audioExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext) ? ext : '.bin';
}

export interface FrozenExportAudio {
  ok: true;
  token: string;
  audio: TargetAudioMap;
}

export interface FrozenExportAudioFailure {
  ok: false;
  error: string;
}

/**
 * Copy the approved narration bytes into this export's private directory and
 * hash the file that was written. The hash must match the approved identity.
 * A digest taken earlier is not reused as proof of the copy.
 */
export async function freezeApprovedAudio(input: {
  project: Project;
  identity: ExportIdentity;
  token?: string;
}): Promise<FrozenExportAudio | FrozenExportAudioFailure> {
  const token = input.token ?? newExportAudioJobToken();
  const dir = jobDirectory(token);
  if (!dir) {
    return { ok: false, error: 'The approved narration could not be frozen for export. Nothing was exported.' };
  }
  fs.mkdirSync(dir, { recursive: true });
  const audio: TargetAudioMap = {};
  try {
    for (const item of input.identity.audio) {
      const target = item.targetId as TargetId;
      if (!item.sha256) {
        audio[target] = null;
        continue;
      }
      await exportValidationHooks.duringAudioAcquire?.(target);
      const source = targetAudioAbsPath(input.project, target);
      if (!source) {
        cleanupExportAudioJob(token);
        return { ok: false, error: 'The approved narration changed while export was copying it. Nothing was exported.' };
      }
      const dest = path.join(dir, `${target}${audioExtension(source)}`);
      if (path.dirname(path.resolve(dest)) !== dir) {
        cleanupExportAudioJob(token);
        return { ok: false, error: 'The approved narration could not be frozen for export. Nothing was exported.' };
      }
      const fd = fs.openSync(source, 'r');
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const out = fs.openSync(dest, 'wx');
      try {
        fs.writeFileSync(out, bytes);
      } finally {
        fs.closeSync(out);
      }
      const written = fs.lstatSync(dest);
      if (!written.isFile() || written.isSymbolicLink()) {
        cleanupExportAudioJob(token);
        return { ok: false, error: 'The approved narration could not be frozen for export. Nothing was exported.' };
      }
      const writtenHash = createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
      if (writtenHash !== item.sha256) {
        cleanupExportAudioJob(token);
        return { ok: false, error: 'The approved narration changed while export was copying it. Nothing was exported.' };
      }
      let durationSec: number | null = null;
      try {
        durationSec = await durationOf(dest);
      } catch {
        durationSec = null;
      }
      audio[target] = { file: dest, durationSec, sceneTiming: null };
    }
    return { ok: true, token, audio };
  } catch {
    cleanupExportAudioJob(token);
    return { ok: false, error: 'The approved narration could not be frozen for export. Nothing was exported.' };
  }
}
