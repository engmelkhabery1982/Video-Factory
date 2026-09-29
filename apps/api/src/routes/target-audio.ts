import fs from 'node:fs';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
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

/**
 * Maximum upload size for a single narration track: 250 MB.
 *
 * Rationale: a studio-quality 60-minute mono MP3 at 320 kbps is ~144 MB;
 * 250 MB is a generous ceiling that covers high-bitrate stereo narration
 * without allowing arbitrary large payload attacks on a local-only service.
 * The server-level multipart limit (512 MB) remains as the hard ceiling,
 * but we enforce our own tighter limit per-file in the route handler.
 */
export const MAX_AUDIO_UPLOAD_BYTES = 250 * 1024 * 1024; // 250 MB

export function maxAudioUploadBytes(): number {
  const configured = Number(process.env.BUILDTRACK_MAX_AUDIO_UPLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : MAX_AUDIO_UPLOAD_BYTES;
}

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

/**
 * Returns a deterministic base filename for the current managed audio of a
 * target (without considering extension). Used only to compute a stable
 * display name; the actual stored filename may include a random suffix to
 * support transaction-safe replacement.
 */
export function getDeterministicFileName(videoId: string, target: TargetId, ext: string): string {
  const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeId}_${target}${ext}`;
}

/**
 * Returns a collision-resistant temporary filename inside the voiceover dir.
 * Uses randomBytes so that simultaneous uploads of the same target cannot
 * collide even when started at the same millisecond.
 */
export function makeTempFileName(ext: string): string {
  const rand = randomBytes(8).toString('hex');
  return `.tmp_${Date.now()}_${rand}${ext}`;
}

/**
 * Returns a unique candidate filename for a validated replacement.
 * Including a random suffix prevents in-place overwrites of the old file
 * and makes transaction rollback safe (the old file path is never reused
 * until after the project reference has been updated successfully).
 */
export function makeCandidateFileName(videoId: string, target: TargetId, ext: string): string {
  const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const rand = randomBytes(6).toString('hex');
  return `${safeId}_${target}_${rand}${ext}`;
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

/**
 * Stream a multipart file part to a temporary file with a hard byte-limit.
 * Returns { tempPath, bytesWritten } on success.
 * Throws with { code: 'LIMIT_EXCEEDED' } when the limit is breached.
 * Always cleans up the temp file on failure before rethrowing.
 */
async function streamPartToTemp(
  part: any,
  tempPath: string,
  maxBytes: number,
): Promise<{ tempPath: string; bytesWritten: number }> {
  const writeStream = fs.createWriteStream(tempPath);
  let bytesWritten = 0;
  const source: AsyncIterable<Buffer> = part.file;

  try {
    await pipeline(
      source,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          bytesWritten += chunk.length;
          if (bytesWritten > maxBytes) {
            throw Object.assign(new Error('Upload limit exceeded'), { code: 'LIMIT_EXCEEDED' });
          }
          yield chunk;
        }
      },
      writeStream,
    );
  } catch (err: any) {
    // Always clean up the partial temp file
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw err;
  }

  if (part.file?.truncated) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw Object.assign(new Error('Upload limit exceeded'), { code: 'LIMIT_EXCEEDED' });
  }

  return { tempPath, bytesWritten };
}

async function drainFilePart(part: any): Promise<void> {
  try {
    part.file.resume();
    await finished(part.file);
  } catch {
    /* The request is already being rejected; draining is best effort. */
  }
}

function tryUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* best effort */ }
}

type SaveProjectFn = (project: Project) => unknown;

/**
 * Persist a new target reference without mutating the caller's project. If the
 * save partially succeeds and then throws, a best-effort second save restores
 * the original project before the candidate audio is removed.
 */
export function commitTargetAudioReplacement(
  project: Project,
  target: TargetId,
  relativeRef: string,
  candidateFilePath: string,
  oldRef: string | null | undefined,
  deps: { save?: SaveProjectFn; unlink?: (filePath: string) => void } = {},
): Project {
  const save = deps.save ?? saveProject;
  const unlink = deps.unlink ?? tryUnlink;
  const next = structuredClone(project);

  if (target === 'long') {
    next.meta.input.voiceoverFile = relativeRef;
  } else {
    next.meta.input.targetAudio = {
      ...(next.meta.input.targetAudio ?? {}),
      [target as ShortId]: relativeRef,
    };
  }

  try {
    save(next);
  } catch (error) {
    try { save(project); } catch { /* best-effort restoration after a partial save */ }
    unlink(candidateFilePath);
    throw error;
  }

  if (oldRef) {
    const oldAbsPath = resolveDataPath(oldRef);
    if (oldAbsPath !== candidateFilePath && isManagedVoiceoverPath(oldAbsPath)) {
      unlink(oldAbsPath);
    }
  }

  return next;
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
      let originalFilename = 'audio.mp3';
      let mimeType = '';
      let filePart: any = null;

      for await (const part of parts) {
        if (part.type === 'file') {
          originalFilename = sanitizeFileName(part.filename ?? 'audio.mp3');
          mimeType = String(part.mimetype ?? '');
          filePart = part;
          break;
        }
      }

      if (!filePart) {
        return reply.code(400).send({ error: 'No file uploaded or file is empty.' });
      }

      const ext = path.extname(originalFilename).toLowerCase();
      if (!ALLOWED_AUDIO_EXTENSIONS.includes(ext as any)) {
        await drainFilePart(filePart);
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
        await drainFilePart(filePart);
        return reply.code(400).send({
          error: `Invalid MIME type "${mimeType}" for audio upload.`,
        });
      }

      const voiceoverDir = getVoiceoverDir();
      // Collision-resistant temp file: timestamp + random bytes
      const tempFileName = makeTempFileName(ext);
      const tempFilePath = path.join(voiceoverDir, tempFileName);

      // Stream to temp file with byte limit
      let bytesWritten = 0;
      try {
        const result = await streamPartToTemp(filePart, tempFilePath, maxAudioUploadBytes());
        bytesWritten = result.bytesWritten;
      } catch (err: any) {
        if (err.code === 'LIMIT_EXCEEDED' || err.code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({
            error: `Audio file exceeds the maximum allowed size of ${Math.round(maxAudioUploadBytes() / 1024 / 1024)} MB.`,
          });
        }
        tryUnlink(tempFilePath);
        return reply.code(400).send({
          error: `Upload was truncated or failed during transfer: ${err.message}`,
        });
      }

      if (bytesWritten === 0) {
        tryUnlink(tempFilePath);
        return reply.code(400).send({ error: 'No file uploaded or file is empty.' });
      }

      // Probe the completed temp file for a genuine audio stream
      let probeResult: any;
      try {
        probeResult = await probe(tempFilePath);
      } catch (e: any) {
        tryUnlink(tempFilePath);
        return reply.code(400).send({
          error: `Uploaded file could not be analyzed as audio: ${e.message}`,
        });
      }

      const audioStream = pickStream(probeResult, 'audio');
      if (!audioStream) {
        tryUnlink(tempFilePath);
        return reply.code(400).send({
          error: 'Uploaded file does not contain a valid audio stream.',
        });
      }

      const measuredDuration = await durationOf(tempFilePath);
      if (!(measuredDuration > 0)) {
        tryUnlink(tempFilePath);
        return reply.code(400).send({
          error: 'Uploaded audio duration must be greater than zero.',
        });
      }

      // ── Transaction-safe replacement ──────────────────────────────────────
      // The validated temp file now becomes the candidate.
      // We store it under a unique name so the old file is never overwritten
      // in-place. The old reference stays alive until after saveProject() succeeds.

      const oldRef =
        target === 'long'
          ? project.meta.input.voiceoverFile
          : project.meta.input.targetAudio?.[target as ShortId];

      const candidateFileName = makeCandidateFileName(project.meta.input.videoId, target, ext);
      const candidateFilePath = path.join(voiceoverDir, candidateFileName);
      const relativeRef = `${MANAGED_VOICEOVER_SUBDIR}/${candidateFileName}`;

      // Move validated temp → candidate location
      try {
        fs.renameSync(tempFilePath, candidateFilePath);
      } catch (err: any) {
        tryUnlink(tempFilePath);
        return reply.code(500).send({
          error: `Failed to stage audio file: ${err.message}`,
        });
      }

      let savedProject: Project;
      try {
        savedProject = commitTargetAudioReplacement(
          project,
          target,
          relativeRef,
          candidateFilePath,
          oldRef,
        );
      } catch (saveErr: any) {
        return reply.code(500).send({
          error: `Failed to save project; audio upload rolled back: ${saveErr.message}`,
        });
      }

      // ANTIGRAVITY_PHASE0B_TIMING_INTEGRATION: Deferred to timing agent.
      // Scene timing and storyboard regeneration are NOT altered here.
      const summary = await getTargetAudioSummary(savedProject);
      return reply.code(200).send({
        ok: true,
        message: 'Regenerate the storyboard to apply the new audio timing.',
        summary,
      });
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

      // ── Safe deletion: clear project reference FIRST, then delete file ────
      // Clear only the selected target reference on a clone; leave every other target untouched.
      const updatedProject = structuredClone(project);
      if (target === 'long') {
        updatedProject.meta.input.voiceoverFile = null;
      } else {
        if (updatedProject.meta.input.targetAudio) {
          delete updatedProject.meta.input.targetAudio[target as ShortId];
        }
      }

      // Save the cleared reference before touching the file system
      try {
        saveProject(updatedProject);
      } catch (error: any) {
        return reply.code(500).send({
          error: `Failed to update the project; narration audio was not removed: ${error.message}`,
        });
      }

      // Delete the managed physical file. If this fails, log the issue but
      // do NOT restore the (now cleared) project reference — the reference is
      // already gone and re-setting it would point to a deleted/missing file.
      let cleanupWarning: string | undefined;
      if (oldRef) {
        const oldAbsPath = resolveDataPath(oldRef);
        if (isManagedVoiceoverPath(oldAbsPath)) {
          try {
            if (fs.existsSync(oldAbsPath)) fs.unlinkSync(oldAbsPath);
          } catch (e: any) {
            cleanupWarning = `Audio reference cleared, but the physical file could not be deleted: ${e.message}`;
          }
        }
      }

      const summary = await getTargetAudioSummary(updatedProject);
      return reply.code(200).send({
        ok: true,
        message: `Narration audio removed for ${targetLabel(target)}.`,
        ...(cleanupWarning ? { cleanupWarning } : {}),
        summary,
      });
    },
  );
}
