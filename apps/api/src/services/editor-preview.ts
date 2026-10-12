/**
 * Preview jobs (milestone 1). A preview renders ONE frozen revision for a short
 * range. Jobs run one at a time in this process. A job left "running" by a
 * restart is reported as interrupted, never as ready.
 */
import path from 'node:path';
import { EditorError, type EditorDocument, type TargetId, type Project } from '@buildtrack/core';
import { editorDir } from './editor-store.js';
import { loadRecord, loadFrozenRevision, saveRecord, newId } from './editor-jobs.js';
import { narrationBindingFor, currentNarrationFile } from './editor-narration.js';
import { renderEditorPreview, type PreviewEvidence, type PreviewRange } from './editor-render.js';

export interface PreviewJobRecord {
  jobId: string;
  projectId: string;
  targetId: TargetId;
  status: 'running' | 'ready' | 'failed';
  revision: number;
  range: PreviewRange;
  frozenFile: string;
  outputFile: string;
  audioFiles: Record<string, string>;
  mediaUrl: string | null;
  evidence: PreviewEvidence | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const active = new Set<string>();
let chain: Promise<void> = Promise.resolve();

export function previewOutputFile(videoId: string, jobId: string): string {
  return path.join(editorDir(videoId), 'previews', `${jobId}.mp4`);
}

/**
 * Audio files for a frozen document, keyed by audio asset id. Each file must
 * still match the sha256 the document was built with, otherwise the preview
 * would be a lie. Only the owner's narration exists as an audio asset today.
 */
export function audioFilesForDocument(videoId: string, targetId: TargetId, doc: EditorDocument): Record<string, string> {
  const files: Record<string, string> = {};
  for (const asset of doc.assets.filter((a) => a.kind === 'audio')) {
    if (asset.id !== 'narration') {
      throw new EditorError('EDITOR_AUDIO_UNAVAILABLE', `Audio asset ${asset.id} has no file source yet.`, 422);
    }
    const binding = narrationBindingFor(videoId, targetId);
    if (!binding || binding.sha256 !== asset.sha256) {
      throw new EditorError('EDITOR_NARRATION_CHANGED', 'The narration changed after this revision. Reload the editor before previewing.', 409);
    }
    const file = currentNarrationFile(videoId, targetId, binding.importId);
    if (!file) throw new EditorError('EDITOR_NARRATION_CHANGED', 'The narration file is not available for this preview.', 409);
    files[asset.id] = file;
  }
  return files;
}

export function createPreviewJob(input: {
  videoId: string;
  targetId: TargetId;
  doc: EditorDocument;
  range: PreviewRange;
  frozenFile: string;
  audioFiles: Record<string, string>;
}): PreviewJobRecord {
  const jobId = newId('prv');
  const job: PreviewJobRecord = {
    jobId,
    projectId: input.videoId,
    targetId: input.targetId,
    status: 'running',
    revision: input.doc.revision,
    range: input.range,
    frozenFile: input.frozenFile,
    outputFile: previewOutputFile(input.videoId, jobId),
    audioFiles: input.audioFiles,
    mediaUrl: null,
    evidence: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  saveRecord(input.videoId, 'preview', jobId, job);
  return job;
}

/** Queue the job. Runs after the current job finishes. Errors are recorded on the job. */
export function enqueuePreview(videoId: string, job: PreviewJobRecord, project: Project, mediaOrigin: string): void {
  active.add(job.jobId);
  chain = chain
    .then(() => runPreview(videoId, job, project, mediaOrigin))
    .catch(() => undefined)
    .finally(() => active.delete(job.jobId));
}

async function runPreview(videoId: string, job: PreviewJobRecord, project: Project, mediaOrigin: string): Promise<void> {
  let finished: PreviewJobRecord = { ...job, finishedAt: new Date().toISOString() };
  try {
    const doc = loadFrozenRevision(job.frozenFile);
    const evidence = await renderEditorPreview({
      videoId,
      doc,
      project,
      range: job.range,
      audioFiles: job.audioFiles,
      mediaOrigin,
      workDir: path.join(editorDir(videoId), 'preview-work', job.jobId),
      outputFile: job.outputFile,
    });
    finished = {
      ...finished,
      status: 'ready',
      evidence,
      mediaUrl: `/api/projects/${videoId}/editor/preview/${job.jobId}/media`,
    };
  } catch (err) {
    finished = { ...finished, status: 'failed', error: (err as Error).message };
  }
  saveRecord(videoId, 'preview', job.jobId, finished);
}

/** A running job with no live worker (after a restart) is marked failed, not left running. */
export function loadPreviewJob(videoId: string, jobId: string): PreviewJobRecord | null {
  const job = loadRecord<PreviewJobRecord>(videoId, 'preview', jobId);
  if (!job) return null;
  if (job.status === 'running' && !active.has(job.jobId)) {
    const interrupted: PreviewJobRecord = {
      ...job,
      status: 'failed',
      error: 'The preview was interrupted before it finished (the server restarted). Start a new preview.',
      finishedAt: new Date().toISOString(),
    };
    saveRecord(videoId, 'preview', job.jobId, interrupted);
    return interrupted;
  }
  return job;
}
