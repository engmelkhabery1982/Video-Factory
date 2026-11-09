/**
 * Milestone 3 provider routes (Gemini). Additive: the M2 factory routes are unchanged.
 * Thin HTTP layer. Jobs run in the background: POST returns 202 with the job; the
 * client polls GET. Cancel is a separate POST. Nothing runs on GET.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { FactoryError } from '@buildtrack/core';
import { GeminiProviderError } from '../services/gemini-client.js';
import { refreshGoogleVoices, savedGoogleVoices } from '../services/gemini-voices.js';
import { localPlannerConfig, localPlannerStatus } from '../services/local-planner.js';
import { type JobRecord } from '../services/gemini-store.js';
import {
  aiCapabilities,
  geminiDeps as getDeps,
  httpStatusForJobError,
  startPlanJob,
  startSpeechPreviewJob,
} from '../services/gemini-service.js';
import {
  createDraftFromPlanJob,
  patchGeneratedDraft,
  applyPreview,
  shotListFor,
  shotListMarkdown,
} from '../services/factory-service.js';

/** Public view of a job. The provider key is never part of any job. */
function publicJob(job: JobRecord) {
  return { ...job };
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof FactoryError) {
    return reply.code(err.status).send({ code: err.code, error: err.message, ...(err.details ?? {}) });
  }
  if (err instanceof GeminiProviderError) {
    return reply.code(httpStatusForJobError(err.code)).send({ code: err.code, error: err.message });
  }
  console.error('factory ai request failed');
  return reply.code(500).send({ code: 'FACTORY_INTERNAL', error: 'The request failed. Nothing was called or saved.' });
}

export async function registerFactoryAiRoutes(app: FastifyInstance) {
  app.get('/api/factory/ai/voices', async () => ({ voices: savedGoogleVoices(), source: 'saved_catalog' }));
  app.post('/api/factory/ai/voices/refresh', async (req, reply) => {
    try { return await refreshGoogleVoices((req.body ?? {}) as Record<string, unknown>); }
    catch (err) { return sendError(reply, err); }
  });
  app.get('/api/factory/ai/status', async (_req, reply) => {
    try {
      const d = getDeps();
      return { ...aiCapabilities(d.cfg, d.store), planner: localPlannerStatus(d.planner ?? localPlannerConfig()) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/factory/ai/plans', async (req, reply) => {
    try {
      const d = getDeps();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const out = startPlanJob(d, body as never);
      out.done.catch(() => undefined);
      return reply.code(out.reused && out.job.status !== 'running' ? 200 : 202).send({ job: publicJob(out.job), reused: out.reused });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/factory/ai/speech-previews', async (req, reply) => {
    try {
      const d = getDeps();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const out = startSpeechPreviewJob(d, body as never);
      out.done.catch(() => undefined);
      return reply.code(out.reused && out.job.status !== 'running' ? 200 : 202).send({ job: publicJob(out.job), reused: out.reused });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/factory/ai/jobs/:jobId', async (req, reply) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const job = getDeps().store.getJob(jobId);
      if (!job) return reply.code(404).send({ code: 'FACTORY_JOB_NOT_FOUND', error: 'No such job.' });
      return { job: publicJob(job) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/factory/ai/jobs/:jobId/cancel', async (req, reply) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const job = getDeps().store.cancelJob(jobId);
      if (!job) return reply.code(404).send({ code: 'FACTORY_JOB_NOT_FOUND', error: 'No such job.' });
      return { job: publicJob(job) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/factory/ai/jobs/:jobId/audio', async (req, reply) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const d = getDeps();
      const job = d.store.getJob(jobId);
      if (!job || job.kind !== 'speech_preview' || job.status !== 'succeeded') {
        return reply.code(404).send({ code: 'FACTORY_JOB_NOT_FOUND', error: 'No finished preview for this job.' });
      }
      const bytes = d.store.readArtifact(`${jobId}.wav`);
      if (!bytes) return reply.code(404).send({ code: 'FACTORY_JOB_NOT_FOUND', error: 'The preview file is missing.' });
      return reply.type('audio/wav').header('cache-control', 'no-store').send(bytes);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Converts a succeeded plan into a persisted draft. Idempotent per plan job. */
  app.post('/api/factory/ai/plans/:jobId/draft', async (req, reply) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const out = createDraftFromPlanJob(jobId, req.body ?? {});
      return reply.code(out.status).send(out.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Edits to a generated draft: unapproved narration, speaker voice and style. Revision-checked. */
  app.patch('/api/factory/drafts/:draftId/generated', async (req, reply) => {
    try {
      const { draftId } = req.params as { draftId: string };
      return patchGeneratedDraft(draftId, req.body ?? {});
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Read-only: the speech calls the next apply would make, the budget, and the blockers. Nothing is written. */
  app.get('/api/factory/drafts/:draftId/apply-preview', async (req, reply) => {
    try {
      const { draftId } = req.params as { draftId: string };
      return applyPreview(draftId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Shot list for the selected treatment. JSON by default; ?format=md gives the markdown package. */
  app.get('/api/factory/drafts/:draftId/shot-list', async (req, reply) => {
    try {
      const { draftId } = req.params as { draftId: string };
      const { format } = (req.query ?? {}) as { format?: string };
      const list = shotListFor(draftId);
      if (format === 'md') return reply.type('text/markdown; charset=utf-8').header('cache-control', 'no-store').send(shotListMarkdown(list));
      return list;
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
