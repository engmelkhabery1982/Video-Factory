import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  SHORT_IDS,
  type Project,
  type ShortId,
  type TargetId,
} from '@buildtrack/core';
import { DATA_DIR } from '../services/platform.js';
import { loadProject, saveProject } from '../services/store.js';
import { durationOf } from '../services/media.js';
import { pickStream, probe } from '../services/platform.js';
import { resolveDataPath } from '../services/targets.js';

export const MANAGED_VOICEOVER_SUBDIR = 'voiceover';
export const ALLOWED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a'] as const;

export interface TargetAudioStatus {
  targetId: TargetId;
  label: string;
  exists: boolean;
  ready: boolean;
  storedRef: string | null;
  fileName: string | null;
  durationSec: number | null;
  status: 'ready' | 'missing';
  message: string;
  explanation: string;
}

export interface TargetAudioSummary {
  projectId: string;
  readyCount: number;
  missingCount: number;
  totalTargets: number;
  blockedTargets: string[];
  targets: TargetAudioStatus[];
}

function getVoiceoverDir(): string {
  const dir = path.join(DATA_DIR, MANAGED_VOICEOVER_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function targetLabel(target: TargetId): string {
  if (target === 'long') return 'Long video';
  if (target === 'short_1') return 'Short 1';
  if (target === 'short_2') return 'Short 2';
  if (target === 'short_3') return 'Short 3';
  return target;
}

export function targetExplanation(target: TargetId): string {
  if (target === 'long') {
    return 'Full narrative arc (16:9). Used solely for the Long video; never reused for Shorts.';
  }
  if (target === 'short_1') {
    return 'Independent vertical narrative (9:16) for Short 1. Requires its own dedicated audio.';
  }
  if (target === 'short_2') {
    return 'Independent vertical narrative (9:16) for Short 2. Requires its own dedicated audio.';
  }
  if (target === 'short_3') {
    return 'Independent vertical narrative (9:16) for Short 3. Requires its own dedicated audio.';
  }
  return 'Independent narration track for this target.';
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export function isValidTargetId(target: string): target is TargetId {
  return target === 'long' || (SHORT_IDS as readonly string[]).includes(target);
}

export function isTargetInProject(project: Project, target: TargetId): boolean {
  if (target === 'long') return true;
  return (project.storyboard.shorts ?? []).some((s) => s.id === target);
}

export function getDeterministicFileName(videoId: string, target: TargetId, ext: string): string {
  const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeId}_${target}${ext}`;
}

export function isManagedVoiceoverPath(refOrPath: string): boolean {
  const voiceoverDir = path.resolve(getVoiceoverDir());
  const resolved = path.isAbsolute(refOrPath)
    ? path.resolve(refOrPath)
    : path.resolve(resolveDataPath(refOrPath));
  const rel = path.relative(voiceoverDir, resolved);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function getTargetAudioSummary(project: Project): Promise<TargetAudioSummary> {
  const shorts = project.storyboard.shorts ?? [];
  const targetIds: TargetId[] = ['long', ...shorts.map((s) => s.id)];

  const targets: TargetAudioStatus[] = [];
  let readyCount = 0;
  let missingCount = 0;
  const blockedTargets: string[] = [];

  for (const t of targetIds) {
    const isLong = t === 'long';
    const storedRef = isLong
      ? project.meta.input.voiceoverFile ?? null
      : project.meta.input.targetAudio?.[t as ShortId] ?? null;

    let ready = false;
    let fileName: string | null = null;
    let durationSec: number | null = null;

    if (storedRef) {
      const absPath = resolveDataPath(storedRef);
      if (fs.existsSync(absPath)) {
        try {
          const stat = fs.statSync(absPath);
          if (stat.size > 0) {
            durationSec = await durationOf(absPath);
            if (durationSec > 0) {
              ready = true;
              fileName = path.basename(storedRef);
            }
          }
        } catch {
          ready = false;
        }
      }
    }

    const label = targetLabel(t);
    const explanation = targetExplanation(t);

    if (ready) {
      readyCount++;
      targets.push({
        targetId: t,
        label,
        exists: true,
        ready: true,
        storedRef,
        fileName,
        durationSec: durationSec ? Number(durationSec.toFixed(2)) : null,
        status: 'ready',
        message: 'Narration audio ready.',
        explanation,
      });
    } else {
      missingCount++;
      blockedTargets.push(label);
      targets.push({
        targetId: t,
        label,
        exists: true,
        ready: false,
        storedRef: null,
        fileName: null,
        durationSec: null,
        status: 'missing',
        message: 'Narration audio missing. This target is blocked at export.',
        explanation,
      });
    }
  }

  return {
    projectId: project.meta.input.videoId,
    readyCount,
    missingCount,
    totalTargets: targetIds.length,
    blockedTargets,
    targets,
  };
}

export async function registerTargetAudioRoutes(app: FastifyInstance) {
  // GET /api/projects/:id/target-audio
  app.get('/api/projects/:id/target-audio', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    const project = loadProject(id);
    if (!project) {
      return reply.code(404).send({ error: `Project not found: ${id}` });
    }
    const summary = await getTargetAudioSummary(project);
    return summary;
  });

  // POST /api/projects/:id/target-audio/:target
  app.post(
    '/api/projects/:id/target-audio/:target',
    async (req: FastifyRequest<{ Params: { id: string; target: string } }>, reply: FastifyReply) => {
      const { id, target } = req.params;

      if (!isValidTargetId(target)) {
        return reply.code(400).send({
          error: `Invalid target ID "${target}". Must be "long", "short_1", "short_2", or "short_3".`,
        });
      }

      const project = loadProject(id);
      if (!project) {
        return reply.code(404).send({ error: `Project not found: ${id}` });
      }

      if (!isTargetInProject(project, target)) {
        return reply.code(400).send({
          error: `Target "${target}" is not present in project ${id}'s storyboard.`,
        });
      }

      const parts = (req as any).parts();
      let uploadedBuffer: Buffer | null = null;
      let originalFilename = 'audio.mp3';
      let mimeType = '';

      for await (const part of parts) {
        if (part.type === 'file') {
          originalFilename = sanitizeFileName(part.filename ?? 'audio.mp3');
          mimeType = String(part.mimetype ?? '');
          uploadedBuffer = await part.toBuffer();
          break;
        }
      }

      if (!uploadedBuffer || uploadedBuffer.length === 0) {
        return reply.code(400).send({
          error: 'No file uploaded or file is empty.',
        });
      }

      const ext = path.extname(originalFilename).toLowerCase();
      if (!ALLOWED_AUDIO_EXTENSIONS.includes(ext as any)) {
        return reply.code(400).send({
          error: `Unsupported audio format "${ext}". Allowed formats are: ${ALLOWED_AUDIO_EXTENSIONS.join(', ')}.`,
        });
      }

      // MIME type sanity check: reject obvious non-audio types
      if (
        mimeType.startsWith('image/') ||
        mimeType.startsWith('video/webm') ||
        mimeType === 'text/plain' ||
        mimeType === 'application/json'
      ) {
        return reply.code(400).send({
          error: `Invalid MIME type "${mimeType}" for audio upload.`,
        });
      }

      const voiceoverDir = getVoiceoverDir();
      const storageFileName = getDeterministicFileName(project.meta.input.videoId, target, ext);
      const storageFilePath = path.join(voiceoverDir, storageFileName);
      const tempFilePath = path.join(voiceoverDir, `.${storageFileName}.${Date.now()}.tmp`);

      try {
        // Write temporary file first
        fs.writeFileSync(tempFilePath, uploadedBuffer);

        // Probe the temporary file to verify valid audio
        let probeResult: any;
        try {
          probeResult = await probe(tempFilePath);
        } catch (e: any) {
          try { fs.unlinkSync(tempFilePath); } catch { /* ignore */ }
          return reply.code(400).send({
            error: `Uploaded file could not be analyzed as audio: ${e.message}`,
          });
        }

        const audioStream = pickStream(probeResult, 'audio');
        if (!audioStream) {
          try { fs.unlinkSync(tempFilePath); } catch { /* ignore */ }
          return reply.code(400).send({
            error: 'Uploaded file does not contain a valid audio stream.',
          });
        }

        const measuredDuration = await durationOf(tempFilePath);
        if (!(measuredDuration > 0)) {
          try { fs.unlinkSync(tempFilePath); } catch { /* ignore */ }
          return reply.code(400).send({
            error: 'Uploaded audio duration must be greater than zero.',
          });
        }

        // Get old stored reference to clean up if different
        const oldRef =
          target === 'long'
            ? project.meta.input.voiceoverFile
            : project.meta.input.targetAudio?.[target as ShortId];

        // Replace old file with new file atomically
        fs.renameSync(tempFilePath, storageFilePath);

        // Clean up old managed file if different extension
        if (oldRef) {
          const oldAbsPath = resolveDataPath(oldRef);
          if (oldAbsPath !== storageFilePath && isManagedVoiceoverPath(oldAbsPath)) {
            try {
              if (fs.existsSync(oldAbsPath)) fs.unlinkSync(oldAbsPath);
            } catch {
              /* best effort */
            }
          }
        }

        // Store relative reference in project JSON
        const relativeRef = `${MANAGED_VOICEOVER_SUBDIR}/${storageFileName}`;
        if (target === 'long') {
          project.meta.input.voiceoverFile = relativeRef;
        } else {
          project.meta.input.targetAudio = {
            ...(project.meta.input.targetAudio ?? {}),
            [target as ShortId]: relativeRef,
          };
        }

        // Save project state
        saveProject(project);

        // ANTIGRAVITY_PHASE0B_TIMING_INTEGRATION: Deferred to timing agent.
        // Scene timing and storyboard regeneration are NOT altered here.
        const summary = await getTargetAudioSummary(project);
        return reply.code(200).send({
          ok: true,
          message: 'Regenerate the storyboard to apply the new audio timing.',
          summary,
        });
      } catch (err: any) {
        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        } catch {
          /* ignore */
        }
        return reply.code(500).send({
          error: `Failed to process audio upload: ${err.message}`,
        });
      }
    },
  );

  // DELETE /api/projects/:id/target-audio/:target
  app.delete(
    '/api/projects/:id/target-audio/:target',
    async (req: FastifyRequest<{ Params: { id: string; target: string } }>, reply: FastifyReply) => {
      const { id, target } = req.params;

      if (!isValidTargetId(target)) {
        return reply.code(400).send({
          error: `Invalid target ID "${target}". Must be "long", "short_1", "short_2", or "short_3".`,
        });
      }

      const project = loadProject(id);
      if (!project) {
        return reply.code(404).send({ error: `Project not found: ${id}` });
      }

      if (!isTargetInProject(project, target)) {
        return reply.code(400).send({
          error: `Target "${target}" is not present in project ${id}'s storyboard.`,
        });
      }

      const oldRef =
        target === 'long'
          ? project.meta.input.voiceoverFile
          : project.meta.input.targetAudio?.[target as ShortId];

      if (oldRef) {
        const oldAbsPath = resolveDataPath(oldRef);
        // Only delete file if it is strictly inside the managed voiceover directory
        if (isManagedVoiceoverPath(oldAbsPath)) {
          try {
            if (fs.existsSync(oldAbsPath)) {
              fs.unlinkSync(oldAbsPath);
            }
          } catch {
            /* ignore deletion errors if file already removed */
          }
        }
      }

      // Clear reference for this target only
      if (target === 'long') {
        project.meta.input.voiceoverFile = null;
      } else {
        if (project.meta.input.targetAudio) {
          delete project.meta.input.targetAudio[target as ShortId];
        }
      }

      saveProject(project);

      const summary = await getTargetAudioSummary(project);
      return reply.code(200).send({
        ok: true,
        message: `Narration audio removed for ${targetLabel(target)}.`,
        summary,
      });
    },
  );
}
