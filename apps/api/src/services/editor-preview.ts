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
  narrationFile: string | null;
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
 * Narration file for a frozen document. The current import must still match the
 * sha256 the document was built with, otherwise the preview would be a lie.
 */
export function narrationFileForDocument(videoId: string, targetId: TargetId, doc: EditorDocument): string | null {
  const asset = doc.assets.find((a) => a.id === 'narration');
  if (!asset) return null;
  const binding = narrationBindingFor(videoId, targetId);
  if (!binding || binding.sha256 !== asset.sha256) {
    throw new EditorError('EDITOR_NARRATION_CHANGED', 'The narration changed after this revision. Reload the editor before previewing.', 409);
  }
  const file = currentNarrationFile(videoId, targetId, binding.importId);
  if (!file) throw new EditorError('EDITOR_NARRATION_CHANGED', 'The narration file is not available for this preview.', 409);
  return file;
}

export function createPreviewJob(input: {
  videoId: string;
  targetId: TargetId;
  doc: EditorDocument;
  range: PreviewRange;
  frozenFile: string;
  narrationFile: string | null;
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
    narrationFile: input.narrationFile,
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
      narrationFile: job.narrationFile,
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
