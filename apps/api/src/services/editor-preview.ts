/**
 * Preview jobs (milestone 1). A preview renders ONE frozen revision for a short
 * range. Jobs run one at a time in this process. A job left "running" by a
 * restart is reported as interrupted, never as ready.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EditorError, type EditorDocument, type TargetId, type Project } from '@buildtrack/core';
import { editorDir } from './editor-store.js';
import {
  cleanupEditorRenderScratch,
  chooseScratchRoot,
  fitsBudget,
  newScratchName,
  openEditorRenderScratch,
  isUnlinkedPath,
  SCRATCH_KIND,
  SCRATCH_MARKER,
  type RenderScratch,
} from './editor-render-paths.js';
import { loadRecord, loadFrozenRevision, saveRecord, newId } from './editor-jobs.js';
import { narrationBindingFor, currentNarrationFile } from './editor-narration.js';
import { libraryAudioFile, sha256File } from './editor-library-audio.js';
import { renderEditorPreview, type PreviewEvidence, type PreviewRange } from './editor-render.js';

export interface PreviewJobRecord {
  jobId: string;
  /** `export` jobs render the whole frozen document as the final file. Older records have no kind and are previews. */
  kind?: 'preview' | 'export';
  projectId: string;
  targetId: TargetId;
  status: 'running' | 'ready' | 'failed';
  revision: number;
  range: PreviewRange;
  frozenFile: string;
  outputFile: string;
  /**
   * The app-relative work folder this job was planned for. Recorded for
   * diagnostics only: the directory actually used is `scratchDir`, which may be in
   * the system temp directory when the app tree is too long for the binaries.
   * Absent on older records.
   */
  workDir?: string;
  /** Short, uniquely owned scratch directory. Only a directory carrying our marker is deleted. */
  scratchDir?: string | null;
  scratchName?: string;
  /** Cleanup failure leaves the render outcome intact and is recorded for diagnosis. */
  cleanupWarning?: string;
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

export function exportOutputFile(videoId: string, jobId: string): string {
  return path.join(editorDir(videoId), 'exports', `${jobId}.mp4`);
}

export function jobKindOf(job: Pick<PreviewJobRecord, 'kind'>): 'preview' | 'export' {
  return job.kind === 'export' ? 'export' : 'preview';
}

/**
 * The app's own scratch root. Kept under the project editor folder when that
 * path is short enough for the installed binaries, otherwise the caller's
 * `chooseScratchRoot` falls back to the system temp directory.
 */
export function renderScratchRoot(videoId: string, kind: 'preview' | 'export'): string {
  return path.join(editorDir(videoId), kind === 'export' ? 'export-work' : 'preview-work');
}

/**
 * Would the interactive ffmpeg binaries be able to open this job's paths?
 *
 * Checked by the route BEFORE it answers 202, so an unsupported path is a precise
 * refusal instead of a render that fails after minutes of work. It creates
 * nothing; the real directory is made when the job runs.
 */
export function renderPathReadiness(input: {
  videoId: string;
  kind: 'preview' | 'export';
  outputFile: string;
}): { ready: boolean; reason: string | null; scratchSource: string | null } {
  const choice = chooseScratchRoot({
    candidate: renderScratchRoot(input.videoId, input.kind),
    name: newScratchName(input.kind === 'export' ? 'exp' : 'edt'),
    outputFile: input.outputFile,
  });
  if (!choice.root) {
    return { ready: false, reason: choice.reason, scratchSource: null };
  }
  if (!fitsBudget(input.outputFile)) {
    return {
      ready: false,
      reason: `The final file path is ${path.resolve(input.outputFile).length} characters, beyond what the installed binaries support. Nothing would be rendered. Use a shorter data root for this project's editor folder.`,
      scratchSource: choice.source,
    };
  }
  return { ready: true, reason: null, scratchSource: choice.source };
}

/**
 * Audio files for a frozen document, keyed by audio asset id. Each file must
 * still match the sha256 the document recorded, otherwise the preview would be a
 * lie. The narration resolves through the owner's import. Any other audio asset
 * resolves through the library index entry and its file under ASSETS_DIR, and
 * must still be an eligible entry (active, not blocked) with the same bytes.
 */
export function audioFilesForDocument(
  videoId: string,
  targetId: TargetId,
  doc: EditorDocument,
  assets: Array<Record<string, unknown>>,
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const asset of doc.assets.filter((a) => a.kind === 'audio')) {
    if (asset.id === 'narration') {
      const binding = narrationBindingFor(videoId, targetId);
      if (!binding || binding.sha256 !== asset.sha256) {
        throw new EditorError('EDITOR_NARRATION_CHANGED', 'The narration changed after this revision. Reload the editor before previewing.', 409);
      }
      const file = currentNarrationFile(videoId, targetId, binding.importId);
      if (!file) throw new EditorError('EDITOR_NARRATION_CHANGED', 'The narration file is not available for this preview.', 409);
      files[asset.id] = file;
      continue;
    }
    const entry = assets.find((a) => a.id === asset.id);
    if (!entry || entry.status !== 'active' || entry.blocked === true) {
      throw new EditorError('EDITOR_AUDIO_UNAVAILABLE', `Audio asset ${asset.id} is no longer active in the library.`, 422);
    }
    const file = libraryAudioFile(entry);
    if (!file) throw new EditorError('EDITOR_AUDIO_UNAVAILABLE', `Audio asset ${asset.id} has no file under the assets folder.`, 422);
    if (!asset.sha256 || sha256File(file) !== asset.sha256) {
      throw new EditorError('EDITOR_AUDIO_CHANGED', `Audio asset ${asset.id} changed after it was added. Reload the editor before previewing.`, 409);
    }
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
  const outputFile = previewOutputFile(input.videoId, jobId);
  const job: PreviewJobRecord = {
    jobId,
    projectId: input.videoId,
    targetId: input.targetId,
    status: 'running',
    revision: input.doc.revision,
    range: input.range,
    frozenFile: input.frozenFile,
    outputFile,
    workDir: path.join(editorDir(input.videoId), 'preview-work', jobId),
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

/**
 * A final export of the frozen document: the whole timeline, the same renderer,
 * plan and audio resolver as a preview. The document is frozen before this is
 * called, so later edits cannot change the file this job writes.
 */
export function createExportJob(input: {
  videoId: string;
  targetId: TargetId;
  doc: EditorDocument;
  frozenFile: string;
  audioFiles: Record<string, string>;
}): PreviewJobRecord {
  const jobId = newId('exp');
  const outputFile = exportOutputFile(input.videoId, jobId);
  const job: PreviewJobRecord = {
    jobId,
    kind: 'export',
    projectId: input.videoId,
    targetId: input.targetId,
    status: 'running',
    revision: input.doc.revision,
    range: { startSec: 0, endSec: input.doc.durationSec },
    frozenFile: input.frozenFile,
    outputFile,
    workDir: path.join(editorDir(input.videoId), 'export-work', jobId),
    audioFiles: input.audioFiles,
    mediaUrl: null,
    evidence: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  saveRecord(input.videoId, 'export', jobId, job);
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
  const kind = jobKindOf(job);
  let scratch: RenderScratch | null = null;
  // `finishedAt` is assigned only when the job actually settles (CLOSEOUT07). It used
  // to be stamped before awaiting the render, so a slow export reported a completion
  // time almost identical to its creation time. Only `createdAt` and `finishedAt`
  // exist; no render duration is computed or implied, because `createdAt` is the
  // enqueue time, not the start time.
  let finished: PreviewJobRecord = { ...job };
  try {
    const doc = loadFrozenRevision(job.frozenFile);
    // The raw render and audio copies go to a short owned scratch directory. The
    // canonical outputFile is untouched: same project id, revision and media URL.
    const name = newScratchName(kind === 'export' ? 'exp' : 'edt');
    const candidate = renderScratchRoot(videoId, kind);
    const choice = chooseScratchRoot({ name, candidate, outputFile: job.outputFile });
    // Journal intent before allocating anything. After a process interruption,
    // recovery knows the exact candidate; only its job-bound marker permits deletion.
    finished = { ...finished, scratchDir: choice.root, scratchName: name };
    saveRecord(videoId, kind, job.jobId, finished);
    scratch = openEditorRenderScratch({
      name,
      jobId: job.jobId,
      outputFile: job.outputFile,
      candidate,
    });
    if (!scratch) {
      // Refuse before rendering instead of paying for frames and failing afterwards.
      throw new EditorError(
        'EDITOR_PATH_UNSUPPORTED',
        'No scratch directory could be created that is short enough for the installed ffmpeg, and no safe short root is available. Nothing was rendered. Move the data root to a shorter path or free space in the system temp directory.',
        500,
      );
    }
    const evidence = await renderEditorPreview({
      videoId,
      doc,
      project,
      range: job.range,
      full: kind === 'export',
      audioFiles: job.audioFiles,
      mediaOrigin,
      workDir: scratch.dir,
      outputFile: job.outputFile,
    });
    finished = {
      ...finished,
      scratchDir: scratch.dir,
      status: 'ready',
      finishedAt: new Date().toISOString(),
      evidence,
      mediaUrl: kind === 'export'
        ? `/api/projects/${videoId}/editor/export/${job.jobId}/media`
        : `/api/projects/${videoId}/editor/preview/${job.jobId}/media`,
    };
  } catch (err) {
    finished = {
      ...finished,
      scratchDir: scratch?.dir ?? null,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: (err as Error).message,
    };
  } finally {
    // Disposable intermediates only. A directory without our marker is never removed.
    try {
      cleanupEditorRenderScratch(scratch ? path.dirname(scratch.dir) : null, scratch ? path.basename(scratch.dir) : '');
    } catch {
      finished.cleanupWarning = 'Temporary render files could not be removed. The completed render outcome is preserved; the owned scratch directory remains for diagnosis.';
    }
  }
  saveRecord(videoId, kind, job.jobId, finished);
}

/** A running job with no live worker (after a restart) is marked failed, not left running. */
export function loadPreviewJob(videoId: string, jobId: string): PreviewJobRecord | null {
  return loadJob(videoId, 'preview', jobId);
}

export function loadExportJob(videoId: string, jobId: string): PreviewJobRecord | null {
  return loadJob(videoId, 'export', jobId);
}

/** Recover only this exact job's marked directory, never a root or arbitrary record path. */
function cleanupInterruptedScratch(videoId: string, kind: 'preview' | 'export', jobId: string, job: PreviewJobRecord): string | undefined {
  if (!job.scratchDir) return;
  const warning = 'Interrupted scratch files were preserved because exact job ownership or safe cleanup could not be verified.';
  try {
    if (typeof job.scratchDir !== 'string' || job.jobId !== jobId || job.projectId !== videoId || jobKindOf(job) !== kind) return warning;
    const dir = path.resolve(job.scratchDir); const root = path.dirname(dir); const name = path.basename(dir);
    const expectedName = kind === 'export' ? /^exp-[a-f0-9]{32}$/ : /^edt-[a-f0-9]{32}$/;
    const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (!expectedName.test(name) || name !== job.scratchName || ![renderScratchRoot(videoId, kind), os.tmpdir()].some(allowed => key(root) === key(allowed)) || !isUnlinkedPath(dir)) return warning;
    if (!fs.existsSync(dir)) return;
    const markerFile = path.join(dir, SCRATCH_MARKER); const stat = fs.lstatSync(markerFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) return warning;
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    if (marker?.kind !== SCRATCH_KIND || marker?.name !== name || marker?.jobId !== jobId) return warning;
    cleanupEditorRenderScratch(root, name);
    return fs.existsSync(dir) ? warning : undefined;
  } catch { return warning; }
}

function loadJob(videoId: string, kind: 'preview' | 'export', jobId: string): PreviewJobRecord | null {
  const job = loadRecord<PreviewJobRecord>(videoId, kind, jobId);
  if (!job) return null;
  if (job.status === 'running' && !active.has(job.jobId)) {
    const cleanupWarning = cleanupInterruptedScratch(videoId, kind, jobId, job);
    const interrupted: PreviewJobRecord = {
      ...job,
      status: 'failed',
      error: kind === 'export'
        ? 'The export was interrupted before it finished (the server restarted). Start a new export.'
        : 'The preview was interrupted before it finished (the server restarted). Start a new preview.',
      finishedAt: new Date().toISOString(),
      ...(cleanupWarning ? { cleanupWarning } : {}),
    };
    saveRecord(videoId, kind, job.jobId, interrupted);
    return interrupted;
  }
  return job;
}
