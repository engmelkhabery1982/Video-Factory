/**
 * Local still-image routes (owner's computer, stable-diffusion.cpp). No provider call, no spend.
 * The prompt is built on the server from the draft shot; the client sends only ids and the revision.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { FactoryError } from '@buildtrack/core';
import {
  approveLocalJob,
  cancelLocalJob,
  getLocalJob,
  LocalImageError,
  localImageStatus,
  localJobImage,
  recoverLocalJobs,
  startLocalJob,
} from '../services/local-image.js';
import { assertCandidateCurrent, candidateIdentityFor, candidateStatus, conditioningRequestFor, stillRequestFor } from '../services/factory-service.js';

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof LocalImageError) {
    const body: Record<string, unknown> = { code: err.code, error: err.message };
    if (err.details) Object.assign(body, err.details);
    return reply.code(err.status).send(body);
  }
  if (err instanceof FactoryError) {
    const body: Record<string, unknown> = { code: err.code, error: err.message };
    if (err.currentRevision !== undefined) body.currentRevision = err.currentRevision;
    if (err.details) Object.assign(body, err.details);
    return reply.code(err.status).send(body);
  }
  console.error('local image request failed');
  return reply.code(500).send({ code: 'LOCAL_IMAGE_INTERNAL', error: 'The local image request failed. Nothing was saved.' });
}

export async function registerLocalImageRoutes(app: FastifyInstance) {
  recoverLocalJobs();

  app.get('/api/local-images/status', async (_req, reply) => {
    try {
      return await localImageStatus();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Starts one local job for one image shot. Body: { draftId, sceneId, expectedRevision, seed? }. */
  app.post('/api/local-images/jobs', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const draftId = typeof b.draftId === 'string' ? b.draftId : '';
      const sceneId = typeof b.sceneId === 'string' ? b.sceneId : '';
      const expected = b.expectedRevision;
      const request = stillRequestFor(draftId, sceneId);
      if (typeof expected !== 'number' || expected !== request.revision) {
        throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload before generating.', 409, { currentRevision: request.revision });
      }
      // The shot identity is fingerprinted from the same server text the job is sent. A religious request that
      // asks for branding, lettering or scripture is refused here, before any runner starts (422).
      const identity = candidateIdentityFor(draftId, sceneId);
      const seed = b.seed === undefined ? undefined : Number(b.seed);
      // The reference picture (if any) is resolved here from the draft's own setting. The client never sends a path.
      const conditioning = conditioningRequestFor(draftId);
      const job = await startLocalJob({
        draftId,
        sceneId,
        shot: { fingerprint: identity.fingerprint, visualDescription: identity.visualDescription, aspect: identity.aspect, profile: identity.profile },
        prompt: identity.prompt,
        negativePrompt: identity.negativePrompt,
        aspect: identity.aspect,
        seed,
        conditioning: conditioning ?? undefined,
      });
      return reply.code(202).send(job);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** The job, plus whether it is still the current candidate for its shot (the server decides, not the page). */
  app.get('/api/local-images/jobs/:jobId', async (req, reply) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const job = getLocalJob(jobId);
      return { ...job, candidate: candidateStatus({ draftId: job.draftId, sceneId: job.sceneId, fingerprint: job.shot?.fingerprint ?? null }) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** The candidate PNG for preview. Served only after the file decodes again. */
  app.get('/api/local-images/jobs/:jobId/image', async (req, reply) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const bytes = localJobImage(jobId);
      return reply.header('Content-Type', 'image/png').header('Cache-Control', 'no-store').send(bytes);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/local-images/jobs/:jobId/cancel', async (req, reply) => {
    try {
      const { jobId } = req.params as { jobId: string };
      return cancelLocalJob(jobId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Registers the approved preview in the library (once). Returns the asset id to bind. */
  app.post('/api/local-images/jobs/:jobId/approve', async (req, reply) => {
    try {
      const { jobId } = req.params as { jobId: string };
      // Refuses (409 FACTORY_CANDIDATE_STALE) when the shot's prompt changed after this job started. Files are kept.
      // Bind repeats this check under the draft lock, so an approve that races an edit still cannot bind.
      const job = getLocalJob(jobId);
      assertCandidateCurrent({ draftId: job.draftId, sceneId: job.sceneId, fingerprint: job.shot?.fingerprint ?? null });
      const out = approveLocalJob(jobId);
      return { job: out.job, assetId: out.assetId };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
