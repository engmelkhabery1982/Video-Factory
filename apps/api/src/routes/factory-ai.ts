/**
 * Milestone 3 provider routes (Gemini). Additive: the M2 factory routes are unchanged.
 * Thin HTTP layer. Jobs run in the background: POST returns 202 with the job; the
 * client polls GET. Cancel is a separate POST. Nothing runs on GET.
 */
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { FactoryError } from '@buildtrack/core';
import { DATA_DIR } from '../services/platform.js';
import { ProviderStore, type JobRecord } from '../services/gemini-store.js';
import {
  aiCapabilities,
  readGeminiConfig,
  startPlanJob,
  startSpeechPreviewJob,
  type AiDeps,
} from '../services/gemini-service.js';

let deps: AiDeps | null = null;
function getDeps(): AiDeps {
  if (!deps) {
    const dir = path.join(DATA_DIR, 'factory', 'ai');
    const store = new ProviderStore(dir);
    deps = { cfg: readGeminiConfig(process.env, dir), store };
  }
  return deps;
}

/** Public view of a job. The provider key is never part of any job. */
function publicJob(job: JobRecord) {
  return { ...job };
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof FactoryError) {
    return reply.code(err.status).send({ code: err.code, error: err.message });
  }
  console.error('factory ai request failed');
  return reply.code(500).send({ code: 'FACTORY_INTERNAL', error: 'The request failed. Nothing was called or saved.' });
}

export async function registerFactoryAiRoutes(app: FastifyInstance) {
  app.get('/api/factory/ai/status', async (_req, reply) => {
    try {
      const d = getDeps();
      return aiCapabilities(d.cfg, d.store);
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
}
