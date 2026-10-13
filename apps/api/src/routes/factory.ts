/**
 * Milestone 2 factory routes. Thin HTTP layer: every rule lives in the service
 * or in @buildtrack/core. Errors are `{code, error}` with no stack or paths.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { FactoryError } from '@buildtrack/core';
import {
  applyDraft,
  createDraft,
  factoryCapabilities,
  getDraft,
  patchDraft,
  projectTiming,
} from '../services/factory-service.js';

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof FactoryError) {
    const body: Record<string, unknown> = { code: err.code, error: err.message };
    if (err.missing) body.missing = err.missing;
    if (err.currentRevision !== undefined) body.currentRevision = err.currentRevision;
    return reply.code(err.status).send(body);
  }
  // Never echo internals: log server-side, return a generic code.
  console.error('factory request failed');
  return reply.code(500).send({ code: 'FACTORY_INTERNAL', error: 'The factory request failed. Nothing was changed.' });
}

export async function registerFactoryRoutes(app: FastifyInstance) {
  app.get('/api/factory/capabilities', async () => ({ ...factoryCapabilities() }));

  app.post('/api/factory/drafts', async (req, reply) => {
    try {
      const out = createDraft(req.body);
      return reply.code(out.status).send(out.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/factory/drafts/:draftId', async (req, reply) => {
    try {
      const { draftId } = req.params as { draftId: string };
      return getDraft(draftId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/factory/drafts/:draftId', async (req, reply) => {
    try {
      const { draftId } = req.params as { draftId: string };
      return patchDraft(draftId, req.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/factory/projects/:projectId/timing', async (req, reply) => {
    try {
      const { projectId } = req.params as { projectId: string };
      return projectTiming(projectId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/factory/drafts/:draftId/apply', async (req, reply) => {
    try {
      const { draftId } = req.params as { draftId: string };
      const out = await applyDraft(draftId, req.body);
      return reply.code(out.status).send(out.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
