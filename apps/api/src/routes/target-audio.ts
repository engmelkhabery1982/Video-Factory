import fs from 'node:fs';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
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

/** Human-readable byte ceiling. Small test limits must not collapse to "0 MB". */
export function formatAudioByteLimit(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 bytes';
  const whole = Math.floor(bytes);
  const mb = 1024 * 1024;
  if (whole >= mb) {
    const value = whole / mb;
    return Number.isInteger(value) ? `${value} MB` : `${value.toFixed(1)} MB`;
  }
  if (whole >= 1024) {
    const value = whole / 1024;
    return Number.isInteger(value) ? `${value} KB` : `${value.toFixed(1)} KB`;
  }
  return `${whole} bytes`;
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
export function validateNarrationFileType(
  originalFilename: string,
  mimeType: string,
): { ok: true; ext: string } | { ok: false; status: number; error: string } {
  const ext = path.extname(originalFilename).toLowerCase();
  if (!ALLOWED_AUDIO_EXTENSIONS.includes(ext as any)) {
    return {
      ok: false,
      status: 400,
      error: `Unsupported audio format "${ext}". Allowed formats are: ${ALLOWED_AUDIO_EXTENSIONS.join(', ')}.`,
    };
  }
  if (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('video/webm') ||
    mimeType === 'text/plain' ||
    mimeType === 'application/json'
  ) {
    return { ok: false, status: 400, error: `Invalid MIME type "${mimeType}" for audio upload.` };
  }
  return { ok: true, ext };
}

export interface StagedNarrationPart {
  tempPath: string;
  bytesWritten: number;
}

export type StagedNarrationResult =
  | { staged: StagedNarrationPart }
  | { error: NarrationUploadResult & { ok: false } };

export interface AcceptedNarrationUpload {
  relativeRef: string;
  absPath: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  durationSec: number;
  sha256: string;
}

export type NarrationUploadResult =
  | { ok: true; upload: AcceptedNarrationUpload }
  | { ok: false; status: number; error: string };

export async function acceptNarrationUpload(
  project: Project,
  target: TargetId,
  filePart: any,
  originalFilename: string,
  mimeType: string,
): Promise<NarrationUploadResult> {
  const typeCheck = validateNarrationFileType(originalFilename, mimeType);
  if (!typeCheck.ok) {
    await drainFilePart(filePart);
    return { ok: false, status: typeCheck.status, error: typeCheck.error };
  }
  const stagedResult = await stageNarrationPart(filePart, typeCheck.ext);
  if ('error' in stagedResult) return stagedResult.error;
  return acceptStagedNarration(project, target, stagedResult.staged, originalFilename, mimeType);
}

export async function stageNarrationPart(filePart: any, ext: string): Promise<StagedNarrationResult> {
  const voiceoverDir = getVoiceoverDir();
  const tempFileName = makeTempFileName(ext);
  const tempFilePath = path.join(voiceoverDir, tempFileName);
  const limit = maxAudioUploadBytes();
  try {
    const result = await streamPartToTemp(filePart, tempFilePath, limit);
    if (result.bytesWritten === 0) {
      tryUnlink(tempFilePath);
      return { error: { ok: false as const, status: 400, error: 'No file uploaded or file is empty.' } };
    }
    return { staged: { tempPath: tempFilePath, bytesWritten: result.bytesWritten } };
  } catch (err: any) {
    if (err.code === 'LIMIT_EXCEEDED' || err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return {
        error: {
          ok: false as const,
          status: 413,
          error: `Audio file exceeds the maximum allowed size of ${formatAudioByteLimit(limit)}.`,
        },
      };
    }
    tryUnlink(tempFilePath);
    return { error: { ok: false as const, status: 400, error: 'Upload was truncated or failed during transfer.' } };
  }
}

export async function acceptStagedNarration(
  project: Project,
  target: TargetId,
  staged: StagedNarrationPart,
  originalFilename: string,
  mimeType: string,
): Promise<NarrationUploadResult> {
  const { tempPath, bytesWritten } = staged;
  const ext = path.extname(originalFilename).toLowerCase();

  let probeResult: any;
  try {
    probeResult = await probe(tempPath);
  } catch (e: any) {
    tryUnlink(tempPath);
    return { ok: false, status: 400, error: 'Uploaded file could not be analyzed as audio.' };
  }

  const audioStream = pickStream(probeResult, 'audio');
  if (!audioStream) {
    tryUnlink(tempPath);
    return { ok: false, status: 400, error: 'Uploaded file does not contain a valid audio stream.' };
  }

  const measuredDuration = await durationOf(tempPath);
  if (!(measuredDuration > 0)) {
    tryUnlink(tempPath);
    return { ok: false, status: 400, error: 'Uploaded audio duration must be greater than zero.' };
  }

  const candidateFileName = makeCandidateFileName(project.meta.input.videoId, target, ext);
  const candidateFilePath = path.join(getVoiceoverDir(), candidateFileName);
  try {
    fs.renameSync(tempPath, candidateFilePath);
  } catch (err: any) {
    tryUnlink(tempPath);
    return { ok: false, status: 500, error: 'Failed to stage audio file.' };
  }

  return {
    ok: true,
    upload: {
      relativeRef: `${MANAGED_VOICEOVER_SUBDIR}/${candidateFileName}`,
      absPath: candidateFilePath,
      fileName: sanitizeFileName(originalFilename),
      mimeType,
      byteSize: bytesWritten,
      durationSec: Number(measuredDuration.toFixed(3)),
      sha256: sha256OfFile(candidateFilePath),
    },
  };
}

/** SHA-256 of a file's bytes; an unreadable file hashes to ''. */
export function sha256OfFile(filePath: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

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
    // The byte-limit can reject before createWriteStream has finished opening
    // its file descriptor. Wait for the writer to settle before unlinking;
    // otherwise an ENOENT cleanup can race with the later open and leave a
    // newly-created .tmp file behind on fast Linux CI runners.
    writeStream.destroy();
    try { await finished(writeStream); } catch { /* the original pipeline error is authoritative */ }
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

      // The upload itself (extension + MIME filter, the shared byte limit, real
      // ffprobe decoding and the measured duration) lives in the shared
      // narration upload path, so the ordinary per-target upload and the VS4
      // external-narration import go through exactly ONE upload system.
      const accepted = await acceptNarrationUpload(project, target, filePart, originalFilename, mimeType);
      if (!accepted.ok) {
        return reply.code(accepted.status).send({ error: accepted.error });
      }

      const relativeRef = accepted.upload.relativeRef;
      const candidateFilePath = accepted.upload.absPath;

      // ── Transaction-safe replacement ──────────────────────────────────────
      // The validated candidate is already stored under a unique name, so the
      // old file is never overwritten in-place. The old reference stays alive
      // until after saveProject() succeeds.

      const oldRef =
        target === 'long'
          ? project.meta.input.voiceoverFile
          : project.meta.input.targetAudio?.[target as ShortId];

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
