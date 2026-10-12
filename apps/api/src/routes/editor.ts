/**
 * Editor routes — EDITOR_CONTRACT_V1 (milestone 1, backend).
 *
 * Every mutation runs under the project's editor lock, checks baseRevision,
 * validates the complete result, and persists atomically before success is
 * returned. Undo/redo restore whole logical transactions.
 */
import type { FastifyInstance } from 'fastify';
import {
  EditorError,
  EDITOR_TARGET_IDS,
  applyEditorOperations,
  type EditorDocument,
  type EditorTargetId,
} from '@buildtrack/core';
import { loadAssetIndex } from './assets.js';
import { loadProject } from '../services/store.js';
import {
  EDITOR_HISTORY_LIMIT,
  ensureEditorState,
  readEditorState,
  withEditorLock,
  writeEditorState,
  type EditorState,
} from '../services/editor-store.js';

export interface EditorCapabilities {
  editor: { available: true };
  operations: string[];
  undoRedo: { available: true; limit: number };
  transitions: { cut: boolean; dissolve: boolean; fade: boolean };
  motion: { none: boolean; slow_push: boolean; pan_left: boolean; pan_right: boolean };
  preview: { available: boolean; reason: string | null };
  alignment: { available: boolean; reason: string | null };
  importStoryboard: { available: boolean; reason: string | null };
  audioOnlyTranscription: { available: boolean; reason: string | null };
  textToSpeech: { available: boolean; reason: string | null };
}

export function editorCapabilities(): EditorCapabilities {
  return {
    editor: { available: true },
    operations: ['insert', 'update', 'remove', 'reorder', 'split', 'setDocument'],
    undoRedo: { available: true, limit: EDITOR_HISTORY_LIMIT },
    transitions: { cut: true, dissolve: false, fade: false },
    motion: { none: true, slow_push: true, pan_left: true, pan_right: true },
    preview: {
      available: false,
      reason: 'Short-range preview from a frozen revision is not wired in this checkout. No render is started and no full-length render is run.',
    },
    alignment: {
      available: false,
      reason: 'The vf-align WSL bridge is not connected in this checkout. On the Linux sandbox there is no WSL runtime, so no alignment job can start. No proposal is produced and none is applied.',
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

export async function registerEditorRoutes(app: FastifyInstance) {
  /** Load (creating the sidecar on first open) the state for one project and target. */
  const openState = (videoId: string, targetId: EditorTargetId) => {
    const project = loadProject(videoId);
    if (!project) return { error: 'project not found' as const };
    const state = withEditorLock(videoId, () => ensureEditorState(project, targetId, loadAssetIndex() as unknown as Array<Record<string, unknown>>));
    return { state };
  };

  app.get('/api/projects/:id/editor', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { targetId?: string };
    const targetId = q.targetId ?? 'long';
    if (!isTargetId(targetId)) return reply.code(400).send({ code: 'EDITOR_BAD_TARGET', error: 'targetId must be long, short_1, short_2 or short_3.' });
    try {
      const r = openState(id, targetId);
      if ('error' in r) return reply.code(404).send({ error: r.error });
      return envelope(r.state);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/projects/:id/editor', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { targetId?: unknown; baseRevision?: unknown; operations?: unknown };
    if (!isTargetId(body.targetId)) return reply.code(400).send({ code: 'EDITOR_BAD_TARGET', error: 'targetId must be long, short_1, short_2 or short_3.' });
    if (!Number.isInteger(body.baseRevision) || (body.baseRevision as number) < 0) {
      return reply.code(400).send({ code: 'EDITOR_BAD_REVISION', error: 'baseRevision must be an integer >= 0.' });
    }
    const targetId = body.targetId;
    try {
      const project = loadProject(id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const state = withEditorLock(id, () => {
        const current = ensureEditorState(project, targetId, loadAssetIndex() as unknown as Array<Record<string, unknown>>);
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
      if (err instanceof EditorError && err.code === 'REVISION_CONFLICT') {
        const current = readEditorState(id, targetId);
        return reply.code(409).send({ code: 'REVISION_CONFLICT', message: err.message, currentRevision: current?.document.revision ?? null });
      }
      return sendError(reply, err);
    }
  });

  const historyStep = (direction: 'undo' | 'redo') => async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { targetId?: unknown; baseRevision?: unknown };
    if (!isTargetId(body.targetId)) return reply.code(400).send({ code: 'EDITOR_BAD_TARGET', error: 'targetId must be long, short_1, short_2 or short_3.' });
    if (!Number.isInteger(body.baseRevision)) return reply.code(400).send({ code: 'EDITOR_BAD_REVISION', error: 'baseRevision must be an integer.' });
    const targetId = body.targetId;
    try {
      const project = loadProject(id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const state = withEditorLock(id, () => {
        const current = ensureEditorState(project, targetId, loadAssetIndex() as unknown as Array<Record<string, unknown>>);
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
      if (err instanceof EditorError && err.code === 'REVISION_CONFLICT') {
        return reply.code(409).send({ code: 'REVISION_CONFLICT', message: err.message, currentRevision: readEditorState(id, targetId)?.document.revision ?? null });
      }
      return sendError(reply, err);
    }
  };
  app.post('/api/projects/:id/editor/undo', historyStep('undo'));
  app.post('/api/projects/:id/editor/redo', historyStep('redo'));

  /* ---- alignment: no fake job. The bridge is not connected here. ---- */
  app.post('/api/projects/:id/editor/alignment', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { targetId?: unknown; sourceAudioId?: unknown };
    if (!isTargetId(body.targetId)) return reply.code(400).send({ code: 'EDITOR_BAD_TARGET', error: 'targetId must be long, short_1, short_2 or short_3.' });
    if (typeof body.sourceAudioId !== 'string' || body.sourceAudioId.length === 0) {
      return reply.code(400).send({ code: 'EDITOR_BAD_AUDIO', error: 'sourceAudioId is required.' });
    }
    if (!loadProject(id)) return reply.code(404).send({ error: 'project not found' });
    return reply.code(503).send({
      code: 'ALIGNMENT_RUNTIME_UNAVAILABLE',
      error: editorCapabilities().alignment.reason,
      status: 'blocked',
    });
  });

  app.get('/api/projects/:id/editor/alignment/:jobId', async (req, reply) => {
    const { id, jobId } = req.params as { id: string; jobId: string };
    if (!loadProject(id)) return reply.code(404).send({ error: 'project not found' });
    return reply.code(404).send({ code: 'ALIGNMENT_JOB_NOT_FOUND', error: `No alignment job ${jobId} exists. No job was started.`, status: 'not_found' });
  });

  app.post('/api/projects/:id/editor/alignment/:proposalId/accept', async (req, reply) => {
    const { id, proposalId } = req.params as { id: string; proposalId: string };
    const body = (req.body ?? {}) as { targetId?: unknown; baseRevision?: unknown; reviewed?: unknown };
    if (!isTargetId(body.targetId)) return reply.code(400).send({ code: 'EDITOR_BAD_TARGET', error: 'targetId must be long, short_1, short_2 or short_3.' });
    if (body.reviewed !== true) return reply.code(400).send({ code: 'EDITOR_REVIEW_REQUIRED', error: 'Accepting timing requires reviewed:true from the owner.' });
    if (!loadProject(id)) return reply.code(404).send({ error: 'project not found' });
    return reply.code(404).send({ code: 'ALIGNMENT_PROPOSAL_NOT_FOUND', error: `No alignment proposal ${proposalId} exists. Nothing was applied.` });
  });

  /* ---- preview: not wired. Honest refusal; no render is started. ---- */
  app.post('/api/projects/:id/editor/preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!loadProject(id)) return reply.code(404).send({ error: 'project not found' });
    return reply.code(501).send({ code: 'PREVIEW_UNAVAILABLE', error: editorCapabilities().preview.reason, status: 'blocked' });
  });

  app.get('/api/projects/:id/editor/preview/:jobId', async (req, reply) => {
    const { id, jobId } = req.params as { id: string; jobId: string };
    if (!loadProject(id)) return reply.code(404).send({ error: 'project not found' });
    return reply.code(404).send({ code: 'PREVIEW_JOB_NOT_FOUND', error: `No preview job ${jobId} exists.` });
  });
}
