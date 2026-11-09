/**
 * Local picture analysis routes (owner's computer, loopback llama-server). No provider call, no spend.
 * The client sends a library picture id only. The server reads the file, hashes it and records the hash.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FactoryError } from '@buildtrack/core';
import { ASSETS_DIR } from '../services/platform.js';
import { loadAssetIndex } from './assets.js';
import { cancelVisionJob, getVisionJob, recoverVisionJobs, startVisionJob, visionConfig, visionStatus, VisionError, VISION_ALLOWED_MIME, VISION_MAX_IMAGE_BYTES } from '../services/local-vision.js';

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof VisionError) {
    const body: Record<string, unknown> = { code: err.code, error: err.message };
    if (err.details) Object.assign(body, err.details);
    return reply.code(err.status).send(body);
  }
  if (err instanceof FactoryError) {
    return reply.code(err.status).send({ code: err.code, error: err.message });
  }
  console.error('vision request failed');
  return reply.code(500).send({ code: 'VISION_INTERNAL', error: 'The picture analysis request failed. Nothing was saved.' });
}

export async function registerLocalVisionRoutes(app: FastifyInstance) {
  recoverVisionJobs();

  app.get('/api/vision/status', async (_req, reply) => {
    try {
      return await visionStatus();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Starts one analysis of one library picture. Body: { assetId }. */
  app.post('/api/vision/jobs', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const assetId = typeof b.assetId === 'string' ? b.assetId : '';
      const asset = loadAssetIndex().find((a) => a.id === assetId);
      if (!asset || asset.status !== 'active' || asset.blocked === true) {
        throw new VisionError('VISION_VALIDATION', 'Choose an active image from the library.', 422);
      }
      if (!(VISION_ALLOWED_MIME as readonly string[]).includes(asset.mimeType)) {
        throw new VisionError('VISION_VALIDATION', 'Only PNG, JPEG or WebP pictures can be analysed.', 422);
      }
      const abs = path.join(ASSETS_DIR, path.basename(asset.path));
      if (!fs.existsSync(abs)) throw new VisionError('VISION_VALIDATION', 'The picture file was not found.', 422);
      const size = fs.statSync(abs).size;
      if (size > VISION_MAX_IMAGE_BYTES) throw new VisionError('VISION_VALIDATION', 'The picture is larger than 8 MB.', 422);
      const bytes = fs.readFileSync(abs);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const job = await startVisionJob({ assetId, bytes, sha256, mimeType: asset.mimeType }, visionConfig());
      return reply.code(202).send(job);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/vision/jobs/:jobId', async (req, reply) => {
    try {
      const { jobId } = req.params as { jobId: string };
      return getVisionJob(jobId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/vision/jobs/:jobId/cancel', async (req, reply) => {
    try {
      const { jobId } = req.params as { jobId: string };
      return cancelVisionJob(jobId);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
