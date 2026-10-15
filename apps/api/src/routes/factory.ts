/**
 * Milestone 2 factory routes. Thin HTTP layer: every rule lives in the service
 * or in @buildtrack/core. Errors are `{code, error}` with no stack or paths.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { FactoryError } from '@buildtrack/core';
import { GeminiProviderError } from '../services/gemini-client.js';
import { httpStatusForJobError } from '../services/gemini-service.js';
import { applyDraft, bindLocalImage, correctStillPrompt, createDraft, deriveDraft, factoryCapabilities, getDraft, patchDraft, projectTiming, reviewDerivedDraft, stillRequestFor, setLocalImageFacts } from '../services/factory-service.js';
import { localImageStatus } from '../services/local-image.js';

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof FactoryError) {
    const body: Record<string, unknown> = { code: err.code, error: err.message };
    if (err.missing) body.missing = err.missing;
    if (err.currentRevision !== undefined) body.currentRevision = err.currentRevision;
    if (err.details) Object.assign(body, err.details);
    return reply.code(err.status).send(body);
  }
  if (err instanceof GeminiProviderError) {
    // Provider failures keep their own code and status (401, 403, 429, 504 and so on). Nothing is saved.
    return reply.code(httpStatusForJobError(err.code)).send({ code: err.code, error: err.message });
  }
  // Never echo internals: log server-side, return a generic code.
  console.error('factory request failed');
  return reply.code(500).send({ code: 'FACTORY_INTERNAL', error: 'The factory request failed. Nothing was changed.' });
}

export async function registerFactoryRoutes(app: FastifyInstance) {
  app.get('/api/factory/capabilities', async () => {
    // The local image runtime is checked for real (config and files), then the visual-language block reflects it.
    const status = await localImageStatus();
    const localImage = status.ready ? 'ready' : 'setup_required';
    setLocalImageFacts(localImage);
    return { ...factoryCapabilities(localImage) };
  });

  app.post('/api/factory/drafts', async (req, reply) => {
    try {
      const out = createDraft(req.body);
      return reply.code(out.status).send(out.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Derived rewrite of narration. The source draft is never changed. The new draft needs review before speech or apply. */
  app.post('/api/factory/drafts/:draftId/derive', async (req, reply) => {
    try {
      const { draftId } = req.params as { draftId: string };
      const out = deriveDraft(draftId, req.body ?? {});
      return reply.code(out.status).send(out.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Reviewer confirmation of a derived rewrite at the revision the reviewer read. */
  app.post('/api/factory/drafts/:draftId/review', async (req, reply) => {
    try {
      const { draftId } = req.params as { draftId: string };
      return reviewDerivedDraft(draftId, req.body ?? {});
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

  /** Prompt and revision for one image shot. Used by the local image runner. No provider call. */
  app.get('/api/factory/drafts/:draftId/scenes/:sceneId/still-request', async (req, reply) => {
    try {
      const { draftId, sceneId } = req.params as { draftId: string; sceneId: string };
      return stillRequestFor(draftId, sceneId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Binds an approved local still to one image shot at the revision the reviewer read. */
  /** Corrects one image shot's visual description at the reviewed revision. Body: { expectedRevision, visualDescription }. No generation. */
  app.post('/api/factory/drafts/:draftId/scenes/:sceneId/still-prompt', async (req, reply) => {
    try {
      const { draftId, sceneId } = req.params as { draftId: string; sceneId: string };
      return correctStillPrompt(draftId, sceneId, req.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/factory/drafts/:draftId/bind-image', async (req, reply) => {
    try {
      const { draftId } = req.params as { draftId: string };
      return bindLocalImage(draftId, req.body);
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
