/**
 * Editor contract v1 client.
 *
 * One thin layer over the SAME request/error conventions as `lib/api.ts`
 * (`err.status`, `err.payload`) so the editor shows the real server message and
 * a revision conflict can be told apart from a transport failure.
 *
 * Two rules the whole file exists to enforce:
 *   1. a failed request is a failure. There is no catch-and-fake path, and no
 *      fallback to fixture data — the fixture is only used when it was
 *      explicitly switched on.
 *   2. every response that carries a `revision` is passed through untouched, so
 *      the caller can label a STALE render instead of presenting it as current.
 */
import {
  type AlignmentJobResult,
  type AlignmentStartResult,
  type EditorEnvelope,
  type EditorOperation,
  type EditorPatchRequest,
  type EditorTargetId,
  type PreviewJobResult,
  type PreviewStartResult,
} from './editor-types.js';
import {
  fixtureAcceptAlignment,
  fixtureAlignmentJob,
  fixtureAlignmentStart,
  fixtureEnabled,
  fixtureGet,
  fixturePatch,
  fixturePreviewJob,
  fixturePreviewStart,
  fixtureRedo,
  fixtureUndo,
} from './editor-fixture.js';

export interface EditorRequestError extends Error {
  status: number;
  payload: Record<string, unknown> | null;
}

async function reqEditor<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init?.body !== null;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(path, { ...init, headers: hasBody ? headers : undefined });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const error = new Error(data?.error ?? data?.message ?? `Request failed (${res.status})`) as EditorRequestError;
    error.status = res.status;
    error.payload = data;
    throw error;
  }
  return normalizeEditorResponse(data) as T;
}

/** Translate the server DTO into the existing UI DTO; never invent job success. */
export function normalizeEditorResponse(data: any): any {
  if (!data || typeof data !== 'object') return data;
  if (data.document) {
    const alignment = data.document.alignment ?? {};
    const capabilities = data.capabilities ?? {};
    return {
      ...data,
      document: {
        ...data.document,
        alignment: {
          ...alignment,
          state: alignment.status ?? alignment.state,
          audioHash: alignment.audioSha256 ?? alignment.audioHash ?? null,
        },
      },
      capabilities: {
        ...capabilities,
        voiceGeneration: capabilities.voiceGeneration ?? capabilities.textToSpeech,
      },
    };
  }
  if (Array.isArray(data.rows)) {
    return {
      ...data,
      rows: data.rows.map((row: any) => {
        const start = row.startSec ?? row.proposedStartSec;
        const end = row.endSec ?? row.proposedEndSec;
        const finiteStart = typeof start === 'number' && Number.isFinite(start);
        const finiteEnd = typeof end === 'number' && Number.isFinite(end);
        return {
          ...row,
          cueId: row.cueId ?? null,
          proposedStartSec: finiteStart ? start : null,
          proposedEndSec: finiteEnd ? end : null,
          unresolvedSpan: row.unresolvedSpan === true || !finiteStart || !finiteEnd,
        };
      }),
    };
  }
  return data;
}

function editorPath(projectId: string, suffix = ''): string {
  return `/api/projects/${encodeURIComponent(projectId)}/editor${suffix}`;
}

export function getEditor(projectId: string, targetId: EditorTargetId): Promise<EditorEnvelope> {
  if (fixtureEnabled()) return Promise.resolve(fixtureGet(projectId, targetId));
  return reqEditor<EditorEnvelope>(`${editorPath(projectId)}?targetId=${encodeURIComponent(targetId)}`);
}

export function patchEditor(projectId: string, request: EditorPatchRequest): Promise<EditorEnvelope> {
  if (fixtureEnabled()) return Promise.resolve(fixturePatch(projectId, request));
  return reqEditor<EditorEnvelope>(editorPath(projectId), { method: 'PATCH', body: JSON.stringify(request) });
}

/** Convenience wrapper: one logical edit transaction. */
export function commitOperations(
  projectId: string,
  targetId: EditorTargetId,
  baseRevision: number,
  operations: EditorOperation[],
): Promise<EditorEnvelope> {
  return patchEditor(projectId, { targetId, baseRevision, operations });
}

export function undoEditor(projectId: string, targetId: EditorTargetId, baseRevision: number): Promise<EditorEnvelope> {
  if (fixtureEnabled()) return Promise.resolve(fixtureUndo(projectId, targetId, baseRevision));
  return reqEditor<EditorEnvelope>(editorPath(projectId, '/undo'), { method: 'POST', body: JSON.stringify({ targetId, baseRevision }) });
}

export function redoEditor(projectId: string, targetId: EditorTargetId, baseRevision: number): Promise<EditorEnvelope> {
  if (fixtureEnabled()) return Promise.resolve(fixtureRedo(projectId, targetId, baseRevision));
  return reqEditor<EditorEnvelope>(editorPath(projectId, '/redo'), { method: 'POST', body: JSON.stringify({ targetId, baseRevision }) });
}

export function requestAlignment(projectId: string, targetId: EditorTargetId, sourceAudioId: string): Promise<AlignmentStartResult> {
  if (fixtureEnabled()) return Promise.resolve(fixtureAlignmentStart());
  return reqEditor<AlignmentStartResult>(editorPath(projectId, '/alignment'), {
    method: 'POST',
    body: JSON.stringify({ targetId, sourceAudioId }),
  });
}

export function getAlignmentJob(projectId: string, jobId: string): Promise<AlignmentJobResult> {
  if (fixtureEnabled()) return Promise.resolve(fixtureAlignmentJob());
  return reqEditor<AlignmentJobResult>(editorPath(projectId, `/alignment/${encodeURIComponent(jobId)}`));
}

export function acceptAlignment(
  projectId: string,
  targetId: EditorTargetId,
  proposalId: string,
  baseRevision: number,
): Promise<EditorEnvelope> {
  if (fixtureEnabled()) return Promise.resolve(fixtureAcceptAlignment(projectId, targetId));
  return reqEditor<EditorEnvelope>(editorPath(projectId, `/alignment/${encodeURIComponent(proposalId)}/accept`), {
    method: 'POST',
    body: JSON.stringify({ targetId, baseRevision, reviewed: true }),
  });
}

export function requestPreview(
  projectId: string,
  targetId: EditorTargetId,
  baseRevision: number,
  range?: { startSec: number; endSec: number } | null,
): Promise<PreviewStartResult> {
  if (fixtureEnabled()) return Promise.resolve(fixturePreviewStart(range ?? null));
  return reqEditor<PreviewStartResult>(editorPath(projectId, '/preview'), {
    method: 'POST',
    body: JSON.stringify(range ? { targetId, baseRevision, range } : { targetId, baseRevision }),
  });
}

export function getPreviewJob(
  projectId: string,
  jobId: string,
  range?: { startSec: number; endSec: number } | null,
): Promise<PreviewJobResult> {
  if (fixtureEnabled()) return Promise.resolve(fixturePreviewJob(projectId, 'long', range ?? null));
  return reqEditor<PreviewJobResult>(editorPath(projectId, `/preview/${encodeURIComponent(jobId)}`));
}

/**
 * A stale result is a result rendered from an older revision. It is returned
 * with the flag so the caller can label it — it is never presented as current.
 */
export function isStalePreview(result: PreviewJobResult, currentRevision: number): boolean {
  if (result.revision === null || result.revision === undefined) return false;
  return result.revision !== currentRevision;
}

/* ---- final export (closure round, Gate 4) ---- */

export interface ExportStartResult {
  jobId: string;
  status: 'running' | 'ready' | 'failed';
  revision: number;
}

export interface ExportJobResult {
  jobId: string;
  targetId: EditorTargetId;
  status: 'running' | 'ready' | 'failed';
  /** The saved revision the file was rendered from. It never changes after the export starts. */
  exportedRevision: number;
  /** The document's revision now. Differs from exportedRevision when the document moved on. */
  currentRevision: number | null;
  stale: boolean;
  durationSec: number;
  mediaUrl: string | null;
  evidence: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export function requestExport(projectId: string, targetId: EditorTargetId, baseRevision: number): Promise<ExportStartResult> {
  return reqEditor<ExportStartResult>(editorPath(projectId, '/export'), {
    method: 'POST',
    body: JSON.stringify({ targetId, baseRevision }),
  });
}

export function getExportJob(projectId: string, jobId: string, targetId: EditorTargetId): Promise<ExportJobResult> {
  return reqEditor<ExportJobResult>(editorPath(projectId, `/export/${encodeURIComponent(jobId)}?targetId=${encodeURIComponent(targetId)}`));
}
