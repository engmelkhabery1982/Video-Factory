/**
 * Editor routes — EDITOR_CONTRACT_V1 (milestone 1, backend).
 *
 * Every mutation runs under the project's editor lock, checks baseRevision,
 * validates the complete result, and persists atomically before success is
 * returned. Undo/redo restore whole logical transactions. Jobs (alignment,
 * preview) run outside the lock and record their results separately.
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  EditorError,
  EDITOR_TARGET_IDS,
  applyEditorOperations,
  type EditorDocument,
  type EditorTargetId,
  type NarrationBinding,
  type Project,
} from '@buildtrack/core';
import { loadAssetIndex } from './assets.js';
import { sendEditorMedia } from '../services/editor-media.js';
import { loadProject } from '../services/store.js';
import {
  EDITOR_HISTORY_LIMIT,
  ensureEditorState,
  syncLibraryState,
  readEditorState,
  withEditorLock,
  writeEditorState,
  type EditorState,
} from '../services/editor-store.js';
import { loadAlignmentJob, loadProposal, alignmentStatusView, acceptProposal, beginAlignment, launchAlignment, narrationForTarget, proposalStaleReasons, ALIGNMENT_TARGET } from '../services/editor-alignment.js';
import { alignRuntime } from '../services/vf-align-worker.js';
import { narrationBindingFor, narrationFileByImportId, syncNarrationState } from '../services/editor-narration.js';
import { freezeRevision, isSafeEditorId } from '../services/editor-jobs.js';
import { previewAvailability, previewFrames, PREVIEW_MAX_SEC, type PreviewRange } from '../services/editor-render.js';
import { createPreviewJob, enqueuePreview, loadPreviewJob, audioFilesForDocument } from '../services/editor-preview.js';
import type { ProposalRecord } from '../services/editor-alignment.js';

export interface EditorCapabilities {
  editor: { available: true };
  operations: string[];
  undoRedo: { available: true; limit: number };
  transitions: { cut: boolean; dissolve: boolean; fade: boolean };
  motion: { none: boolean; slow_push: boolean; pan_left: boolean; pan_right: boolean };
  preview: { available: boolean; reason: string | null; maxSec: number };
  alignment: { available: boolean; reason: string | null; targetId: string };
  importStoryboard: { available: boolean; reason: string | null };
  audioOnlyTranscription: { available: boolean; reason: string | null };
  textToSpeech: { available: boolean; reason: string | null };
}

export function editorCapabilities(): EditorCapabilities {
  const preview = previewAvailability();
  const align = alignRuntime();
  return {
    editor: { available: true },
    operations: ['insert', 'update', 'remove', 'reorder', 'split', 'setDocument'],
    undoRedo: { available: true, limit: EDITOR_HISTORY_LIMIT },
    transitions: { cut: true, dissolve: false, fade: true },
    motion: { none: true, slow_push: true, pan_left: true, pan_right: true },
    preview: { available: preview.available, reason: preview.reason, maxSec: PREVIEW_MAX_SEC },
    alignment: {
      available: align.available,
      reason: align.reason,
      targetId: ALIGNMENT_TARGET,
    },
    importStoryboard: { available: false, reason: 'Later milestone. Not claimed in this delivery.' },
    audioOnlyTranscription: { available: false, reason: 'Later milestone. A transcript is not timing.' },
    textToSpeech: { available: false, reason: 'No new voices are synthesized in this milestone. Approved narration is preserved.' },
  };
}

function isTargetId(v: unknown): v is EditorTargetId {
  return typeof v === 'string' && (EDITOR_TARGET_IDS as readonly string[]).includes(v);
}

function envelope(state: EditorState) {
  return {
    document: state.document,
    undoAvailable: state.undo.length > 0,
    redoAvailable: state.redo.length > 0,
    capabilities: editorCapabilities(),
  };
}

function sendError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof EditorError) {
    return reply.code(err.status).send({ code: err.code, error: err.message, message: err.message });
  }
  throw err;
}

function badTarget(reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  return reply.code(400).send({ code: 'EDITOR_BAD_TARGET', error: 'targetId must be long, short_1, short_2 or short_3.' });
}

/** Create or sync the state for a target. Caller MUST hold the editor lock. */
function syncedState(project: Project, targetId: EditorTargetId): EditorState {
  const videoId = project.meta.input.videoId;
  const binding: NarrationBinding | null = narrationBindingFor(videoId, targetId);
  const assets = loadAssetIndex() as unknown as Array<Record<string, unknown>>;
  const created = ensureEditorState(project, targetId, assets, binding);
  // Library assets uploaded after the document was created become assignable here.
  const withLibrary = syncLibraryState(videoId, targetId, created, assets);
  return syncNarrationState(videoId, targetId, withLibrary, binding);
}

/** Read-side load: takes the lock itself. Never call from inside withEditorLock. */
function currentState(project: Project, targetId: EditorTargetId): EditorState {
  return withEditorLock(project.meta.input.videoId, () => syncedState(project, targetId));
}

function revisionConflict(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, id: string, targetId: EditorTargetId, err: EditorError) {
  const current = readEditorState(id, targetId);
  return reply.code(409).send({ code: 'REVISION_CONFLICT', message: err.message, currentRevision: current?.document.revision ?? null });
}

export async function registerEditorRoutes(app: FastifyInstance) {
  const requireProject = (id: string) => {
    const project = loadProject(id);
    return project && project.meta.input.videoId === id ? project : null;
  };

  app.get('/api/projects/:id/editor', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { targetId?: string };
    const targetId = q.targetId ?? 'long';
    if (!isTargetId(targetId)) return badTarget(reply);
    try {
      const project = requireProject(id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      return envelope(currentState(project, targetId));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/projects/:id/editor', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { targetId?: unknown; baseRevision?: unknown; operations?: unknown };
    if (!isTargetId(body.targetId)) return badTarget(reply);
    if (!Number.isInteger(body.baseRevision) || (body.baseRevision as number) < 0) {
      return reply.code(400).send({ code: 'EDITOR_BAD_REVISION', error: 'baseRevision must be an integer >= 0.' });
    }
    const targetId = body.targetId;
    try {
      const project = requireProject(id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const state = withEditorLock(id, () => {
        const current = syncedState(project, targetId);
        if (body.baseRevision !== current.document.revision) {
          throw new EditorError('REVISION_CONFLICT', `Expected revision ${body.baseRevision}, current is ${current.document.revision}. Reload and reapply.`, 409);
        }
        const next: EditorDocument = { ...applyEditorOperations(current.document, body.operations), revision: current.document.revision + 1 };
        const saved: EditorState = {
          schemaVersion: current.schemaVersion,
          document: next,
          undo: [...current.undo, current.document].slice(-EDITOR_HISTORY_LIMIT),
          redo: [],
        };
        writeEditorState(id, targetId, saved);
        return saved;
      });
      return envelope(state);
    } catch (err) {
      if (err instanceof EditorError && err.code === 'REVISION_CONFLICT') return revisionConflict(reply, id, targetId, err);
      return sendError(reply, err);
    }
  });

  const historyStep = (direction: 'undo' | 'redo') => async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { targetId?: unknown; baseRevision?: unknown };
    if (!isTargetId(body.targetId)) return badTarget(reply);
    if (!Number.isInteger(body.baseRevision)) return reply.code(400).send({ code: 'EDITOR_BAD_REVISION', error: 'baseRevision must be an integer.' });
    const targetId = body.targetId;
    try {
      const project = requireProject(id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const state = withEditorLock(id, () => {
        const current = syncedState(project, targetId);
        if (body.baseRevision !== current.document.revision) {
          throw new EditorError('REVISION_CONFLICT', `Expected revision ${body.baseRevision}, current is ${current.document.revision}.`, 409);
        }
        const from = direction === 'undo' ? current.undo : current.redo;
        if (from.length === 0) {
          throw new EditorError(direction === 'undo' ? 'EDITOR_NOTHING_TO_UNDO' : 'EDITOR_NOTHING_TO_REDO', `Nothing to ${direction}.`, 409);
        }
        const snapshot = from[from.length - 1];
        const restored: EditorDocument = { ...snapshot, revision: current.document.revision + 1 };
        const saved: EditorState = direction === 'undo'
          ? {
              schemaVersion: current.schemaVersion,
              document: restored,
              undo: current.undo.slice(0, -1),
              redo: [...current.redo, current.document].slice(-EDITOR_HISTORY_LIMIT),
            }
          : {
              schemaVersion: current.schemaVersion,
              document: restored,
              undo: [...current.undo, current.document].slice(-EDITOR_HISTORY_LIMIT),
              redo: current.redo.slice(0, -1),
            };
        writeEditorState(id, targetId, saved);
        return saved;
      });
      return envelope(state);
    } catch (err) {
      if (err instanceof EditorError && err.code === 'REVISION_CONFLICT') return revisionConflict(reply, id, targetId, err);
      return sendError(reply, err);
    }
  };
  app.post('/api/projects/:id/editor/undo', historyStep('undo'));
  app.post('/api/projects/:id/editor/redo', historyStep('redo'));

  /* ---- alignment ---- */
  app.post('/api/projects/:id/editor/alignment', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { targetId?: unknown; sourceAudioId?: unknown; baseRevision?: unknown };
    if (!isTargetId(body.targetId)) return badTarget(reply);
    const targetId = body.targetId;
    if (typeof body.sourceAudioId !== 'string' || body.sourceAudioId.length === 0) {
      return reply.code(400).send({ code: 'EDITOR_BAD_AUDIO', error: 'sourceAudioId is required (the narration asset id, "narration").' });
    }
    if (targetId !== ALIGNMENT_TARGET) {
      return reply.code(422).send({ code: 'ALIGNMENT_TARGET_UNSUPPORTED', error: `Alignment runs for ${ALIGNMENT_TARGET} only. The runner reads the ${ALIGNMENT_TARGET} narration script.` });
    }
    const rt = alignRuntime();
    if (!rt.available) {
      return reply.code(503).send({ code: 'ALIGNMENT_RUNTIME_UNAVAILABLE', error: rt.reason, status: 'blocked' });
    }
    try {
      const project = requireProject(id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      if (body.baseRevision !== undefined && !Number.isInteger(body.baseRevision)) {
        return reply.code(400).send({ code: 'EDITOR_BAD_REVISION', error: 'baseRevision must be an integer when given.' });
      }
      const job = withEditorLock(id, () => {
        const state = syncedState(project, targetId);
        if (body.baseRevision !== undefined && body.baseRevision !== state.document.revision) {
          throw new EditorError('REVISION_CONFLICT', `Expected revision ${body.baseRevision}, current is ${state.document.revision}.`, 409);
        }
        const binding = narrationBindingFor(id, targetId);
        if (!binding) throw new EditorError('ALIGNMENT_NARRATION_MISSING', 'No narration is imported for this target. Import the recording first.', 422);
        if (body.sourceAudioId !== 'narration' && body.sourceAudioId !== binding.importId) {
          throw new EditorError('ALIGNMENT_SOURCE_MISMATCH', `sourceAudioId ${String(body.sourceAudioId)} is not the current narration.`, 422);
        }
        return beginAlignment(id, targetId, state, binding, rt);
      });
      launchAlignment(id, targetId, job, rt);
      return reply.code(202).send({ jobId: job.jobId, status: 'running', targetId, sourceRevision: job.sourceRevision });
    } catch (err) {
      if (err instanceof EditorError && err.code === 'REVISION_CONFLICT') return revisionConflict(reply, id, targetId, err);
      return sendError(reply, err);
    }
  });

  app.get('/api/projects/:id/editor/alignment/:jobId', async (req, reply) => {
    const { id, jobId } = req.params as { id: string; jobId: string };
    if (!requireProject(id)) return reply.code(404).send({ error: 'project not found' });
    const job = isSafeEditorId(jobId) ? loadAlignmentJob(id, jobId) : null;
    if (!job) return reply.code(404).send({ code: 'ALIGNMENT_JOB_NOT_FOUND', error: `No alignment job ${jobId} exists.` });
    const current = readEditorState(id, job.targetId)?.document ?? null;
    const proposal = job.proposalId ? loadProposal(id, job.proposalId) : null;
    const staleReasons = proposal
      ? (current ? proposalStaleReasons(proposal, current, narrationForTarget(id, job.targetId)) : ['the editor document is missing'])
      : [];
    return {
      ...alignmentStatusView(job, staleReasons.length > 0),
      rows: proposal ? proposal.rows : null,
      unresolved: proposal ? proposal.unresolved : null,
      proposal: proposal ? proposalView(proposal, staleReasons) : null,
    };
  });

  app.post('/api/projects/:id/editor/alignment/:proposalId/accept', async (req, reply) => {
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    const body = (req.body ?? {}) as { targetId?: unknown; baseRevision?: unknown; reviewed?: unknown };
    if (!isTargetId(body.targetId)) return badTarget(reply);
    const targetId = body.targetId;
    if (body.reviewed !== true) return reply.code(400).send({ code: 'EDITOR_REVIEW_REQUIRED', error: 'Accepting timing requires reviewed:true from the owner.' });
    if (!Number.isInteger(body.baseRevision) || (body.baseRevision as number) < 0) {
      return reply.code(400).send({ code: 'EDITOR_BAD_REVISION', error: 'baseRevision must be an integer >= 0.' });
    }
    const project = requireProject(id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const proposal = isSafeEditorId(proposalId) ? loadProposal(id, proposalId) : null;
    if (!proposal || proposal.targetId !== targetId) {
      return reply.code(404).send({ code: 'ALIGNMENT_PROPOSAL_NOT_FOUND', error: `No alignment proposal ${proposalId} exists for ${targetId}. Nothing was applied.` });
    }
    try {
      const result = withEditorLock(id, () => {
        const state = syncedState(project, targetId);
        if (body.baseRevision !== state.document.revision) {
          throw new EditorError('REVISION_CONFLICT', `Expected revision ${body.baseRevision}, current is ${state.document.revision}. Reload and reapply.`, 409);
        }
        if (proposal.status === 'accepted') {
          throw new EditorError('ALIGNMENT_PROPOSAL_NOT_ACCEPTABLE', 'This proposal was already applied.', 409);
        }
        const accepted = acceptProposal(id, targetId, proposal, state, narrationForTarget(id, targetId));
        return accepted.next;
      });
      return envelope(result);
    } catch (err) {
      if (err instanceof EditorError && err.code === 'REVISION_CONFLICT') return revisionConflict(reply, id, targetId, err);
      return sendError(reply, err);
    }
  });

  /* ---- preview ---- */
  app.post('/api/projects/:id/editor/preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { targetId?: unknown; baseRevision?: unknown; range?: { startSec?: unknown; endSec?: unknown } };
    if (!isTargetId(body.targetId)) return badTarget(reply);
    const targetId = body.targetId;
    // Availability first: a host without a renderer is told so, whatever the body.
    const availability = previewAvailability();
    if (!availability.available) {
      return reply.code(501).send({ code: 'PREVIEW_UNAVAILABLE', error: availability.reason, status: 'blocked' });
    }
    if (!Number.isInteger(body.baseRevision) || (body.baseRevision as number) < 0) {
      return reply.code(400).send({ code: 'EDITOR_BAD_REVISION', error: 'baseRevision must be an integer >= 0.' });
    }
    const project = requireProject(id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    try {
      const created = withEditorLock(id, () => {
        const state = syncedState(project, targetId);
        if (body.baseRevision !== state.document.revision) {
          throw new EditorError('REVISION_CONFLICT', `Expected revision ${body.baseRevision}, current is ${state.document.revision}.`, 409);
        }
        const doc = state.document;
        const range: PreviewRange = body.range
          ? { startSec: Number(body.range.startSec), endSec: Number(body.range.endSec) }
          : { startSec: 0, endSec: Math.min(doc.durationSec, PREVIEW_MAX_SEC) };
        previewFrames(doc, range);
        const audioFiles = audioFilesForDocument(id, targetId, doc, loadAssetIndex() as unknown as Array<Record<string, unknown>>);
        const frozenFile = freezeRevision(id, targetId, doc);
        const job = createPreviewJob({ videoId: id, targetId, doc, range, frozenFile, audioFiles });
        return { job, range };
      });
      enqueuePreview(id, created.job, project, `http://127.0.0.1:${(req.socket as { localPort?: number }).localPort ?? 3000}`);
      return reply.code(202).send({ jobId: created.job.jobId, status: 'running', revision: created.job.revision, range: created.range });
    } catch (err) {
      if (err instanceof EditorError && err.code === 'REVISION_CONFLICT') return revisionConflict(reply, id, targetId, err);
      return sendError(reply, err);
    }
  });

  app.get('/api/projects/:id/editor/preview/:jobId', async (req, reply) => {
    const { id, jobId } = req.params as { id: string; jobId: string };
    if (!requireProject(id)) return reply.code(404).send({ error: 'project not found' });
    const job = isSafeEditorId(jobId) ? loadPreviewJob(id, jobId) : null;
    if (!job) return reply.code(404).send({ code: 'PREVIEW_JOB_NOT_FOUND', error: `No preview job ${jobId} exists.` });
    const current = readEditorState(id, job.targetId)?.document.revision ?? null;
    return {
      jobId: job.jobId,
      targetId: job.targetId,
      status: job.status,
      revision: job.revision,
      stale: current !== job.revision,
      range: job.range,
      mediaUrl: job.status === 'ready' ? job.mediaUrl : null,
      evidence: job.evidence,
      error: job.error,
    };
  });

  app.get('/api/projects/:id/editor/preview/:jobId/media', async (req, reply) => {
    const { id, jobId } = req.params as { id: string; jobId: string };
    if (!requireProject(id)) return reply.code(404).send({ error: 'project not found' });
    const job = isSafeEditorId(jobId) ? loadPreviewJob(id, jobId) : null;
    if (!job) return reply.code(404).send({ code: 'PREVIEW_JOB_NOT_FOUND', error: `No preview job ${jobId} exists.` });
    if (job.status !== 'ready' || !fs.existsSync(job.outputFile)) {
      return reply.code(409).send({ code: 'PREVIEW_NOT_READY', error: `Preview is ${job.status}.` });
    }
    return sendEditorMedia(req, reply, job.outputFile, 'video/mp4');
  });

  /* ---- narration media (the owner's existing import, read-only) ---- */
  app.get('/api/projects/:id/editor/media/narration/:importId', async (req, reply) => {
    const { id, importId } = req.params as { id: string; importId: string };
    if (!requireProject(id)) return reply.code(404).send({ error: 'project not found' });
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(importId)) return reply.code(404).send({ error: 'not found' });
    const found = narrationFileByImportId(id, importId);
    if (!found || !fs.existsSync(found.file)) return reply.code(404).send({ error: 'narration not found' });
    return sendEditorMedia(req, reply, found.file, found.mimeType);
  });
}

function proposalView(p: ProposalRecord, staleReasons: string[]) {
  return {
    proposalId: p.proposalId,
    targetId: p.targetId,
    status: p.status,
    sourceRevision: p.sourceRevision,
    stale: staleReasons.length > 0,
    rows: p.rows,
    unresolved: p.unresolved,
    detail: p.detail,
    staleReasons,
    acceptedRevision: p.acceptedRevision,
  };
}
