/**
 * VS3 — project-scoped "Voice & Audio" routes.
 *
 * Route map (all project-scoped, all under the existing `/api/projects/:id`):
 *
 *   GET    /voice-audio                          project voice/audio state + engine availability + render gate
 *   POST   /voice-audio/references               upload + validate a reference recording (never approves it)
 *   POST   /voice-audio/references/:refId/authorize   explicit legal authorization confirmation
 *   POST   /voice-audio/references/:refId/approve     reference approval through the SHIPPED VS1 gate
 *   DELETE /voice-audio/references/:refId        deliberate removal (file + record)
 *   PUT    /voice-audio/assignments              speaker -> engine/voice assignment
 *   POST   /voice-audio/previews                 start generation (background job)
 *   GET    /voice-audio/jobs/:jobId              generation progress/status
 *   GET    /voice-audio/previews/:previewId/audio  stream the CURRENT preview artifact
 *   POST   /voice-audio/previews/:previewId/approval  approve/reject THAT artifact
 *   GET    /voice-audio/render-gate              the cloned-audio render gate result
 *
 * Safety rules enforced here (never in the UI only):
 *   - uploads are validated by CONTENT (ffprobe must find a real audio stream
 *     with real metrics), not by extension alone;
 *   - an upload can never grant authorization or approval: those are separate,
 *     explicit, audited actions;
 *   - every path is derived from a server-generated id and re-checked for
 *     containment inside the project's own root;
 *   - generation refuses to substitute an engine or a voice;
 *   - failed generation cleans up its own partial artifacts and never touches
 *     the reference recordings;
 *   - responses never include absolute paths, source filenames or the stored
 *     reference file names.
 */

import fs from 'node:fs';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  buildSynthesisVoiceProfile,
  checkVoiceReference,
  evaluateClonedAudioRenderGate,
  evaluateReferencePublicationProfile,
  evaluateVoiceAudioPreviewApproval,
  toPublicVoiceReference,
  voiceAudioTiming,
  voiceAudioEngineStatuses,
  voiceAudioIdentityDigest,
  voicePreviewTextSha256,
  type PublicVoiceReference,
  type VoiceAudioAssignment,
  type VoiceAudioEngineKind,
  type VoiceAudioPreviewRecord,
  type VoiceAudioPreviewSegment,
  type VoiceAudioRenderGateResult,
  type VoiceReferenceRecord,
  type VoiceRightsEvidence,
} from '@buildtrack/core';
import { loadProject } from '../services/store.js';
import { probe } from '../services/platform.js';
import { durationOf } from '../services/media.js';
import {
  buildSynthesizer,
  engineFacts,
  engineSummaryFor,
  probeEngines,
  sanitizeEngineError,
  segmentRequest,
  sha256OfFile,
} from '../services/voice-audio-engine.js';
import {
  ALLOWED_REFERENCE_EXTENSIONS,
  MAX_REFERENCE_DURATION_SECONDS,
  MAX_REFERENCE_UPLOAD_BYTES,
  cleanupTempArtifacts,
  deletePreviewArtifacts,
  deleteReferenceFile,
  findReference,
  isSafeReferenceId,
  isReferenceAssigned,
  loadVoiceAudioState,
  newPreviewId,
  newReferenceId,
  previewArtifactAbsPath,
  previewDir,
  pruneOtherPreviews,
  referenceAbsPath,
  referencesDir,
  resolveInsideProject,
  saveVoiceAudioState,
  toRepoRelative,
  voiceAudioRoot,
  type VoiceAudioPersistedState,
} from '../services/voice-audio-state.js';

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

const JSON_ERROR = (message: string) => ({ error: message });

/**
 * Raised when the narration cannot be planned without losing words. The preview
 * route turns it into a blocking 409: incomplete planning is never "generated".
 */
export class VoiceAudioPlanningError extends Error {
  readonly code = 'VOICE-AUDIO-010-ASSIGNMENT-MISSING-REFERENCE';
}

function sanitizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > 80) return null;
  if (/[\u0000-\u001f]/.test(trimmed)) return null;
  return trimmed;
}

function toErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 400);
}

/* ------------------------------------------------------------------ */
/*  State projection                                                   */
/* ------------------------------------------------------------------ */

interface VoiceAudioStateResponse {
  projectId: string;
  schemaVersion: string;
  /**
   * The deterministic status PLUS the facts it was derived from, so the UI can
   * show the remedy, the exact device truth and any fixture notice without
   * re-deriving anything (and without ever being told "available" loosely).
   */
  engines: Array<
    ReturnType<typeof voiceAudioEngineStatuses>[number] & {
      modelId: string;
      modelRevision: string | null;
      runtimeInstalled: boolean;
      provisioned: boolean;
      deviceSatisfied: boolean;
      deviceDetail: string;
      cpuRequiresOptIn: boolean;
      provisionRemedy: string;
      approvalBlockedCodes: string[];
      notes: string[];
    }
  >;
  kokoroSeparateChoice: true;
  references: PublicVoiceReference[];
  assignments: (VoiceAudioAssignment & {
    referenceDisplayName: string | null;
    referenceApproved: boolean;
    speakerLabel: string;
  })[];
  speakers: { speakerId: string; speakerName: string; assigned: boolean }[];
  preview: {
    previewId: string;
    status: VoiceAudioPreviewRecord['status'];
    durationSeconds: number | null;
    language: string;
    engineSummary: string;
    createdAt: string;
    artifactAvailable: boolean;
    audioUrl: string | null;
    segments: number;
    timing: VoiceAudioPreviewRecord['timing'];
    error: VoiceAudioPreviewRecord['error'];
  } | null;
  approval: {
    decision: 'approved' | 'rejected';
    approvedAt: string;
    approvedBy: string;
    boundToCurrentPreview: boolean;
    staleCodes: string[];
  } | null;
  renderGate: VoiceAudioRenderGateResult;
  clonedVoiceSelected: boolean;
  privacy: { referenceRecordingsCommitted: false; exportedInDeliverables: false };
}

/** Speakers of the project: characters of the storyboard, else a single narrator. */
export function projectSpeakers(project: ReturnType<typeof loadProject>): { speakerId: string; speakerName: string }[] {
  if (!project) return [{ speakerId: 'narrator', speakerName: 'Narrator' }];
  const characters = new Set<string>();
  const scenes = project.storyboard?.long?.scenes ?? [];
  for (const scene of scenes) {
    for (const turn of (scene as unknown as { turns?: { speakerId?: string; speakerName?: string }[] }).turns ?? []) {
      if (turn?.speakerId) characters.add(turn.speakerId);
    }
  }
  if (characters.size === 0) return [{ speakerId: 'narrator', speakerName: 'Narrator' }];
  return [...characters]
    .sort()
    .map((id) => ({ speakerId: id, speakerName: id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }));
}

export function referenceChecks(
  state: VoiceAudioPersistedState,
  videoId: string
): Record<string, ReturnType<typeof checkVoiceReference>> {
  const out: Record<string, ReturnType<typeof checkVoiceReference>> = {};
  for (const record of state.references) {
    const abs = referenceAbsPath(videoId, record);
    let sha: string | null = null;
    try {
      if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) sha = sha256OfFile(abs);
    } catch {
      sha = null;
    }
    out[record.referenceId] = checkVoiceReference(record, sha);
  }
  return out;
}

/**
 * Identity digest of a set of PLANNED segments.
 *
 * This is the single definition of "which request set produced this audio".
 * Generation stores it and every later evaluation recomputes it from the same
 * inputs, so an approval is bound to exactly what was generated and nothing
 * else. Deriving the script digest from the planned segments (rather than from
 * the raw script string) is what keeps the two identical: a change to the
 * script, to a speaker, to a turn or to an assignment changes the plan and
 * therefore the digest.
 */
export function identityDigestForSegments(
  videoId: string,
  project: ReturnType<typeof loadProject>,
  state: VoiceAudioPersistedState,
  segments: readonly PlannedSegment[]
): string {
  const checks = referenceChecks(state, videoId);
  return voiceAudioIdentityDigest({
    projectId: videoId,
    scriptSha256: voicePreviewTextSha256(
      segments.map((segment) => `${segment.speakerId}:${segment.spokenText}`).join('\u0000')
    ),
    language: project?.meta?.input?.outputLanguage ?? 'en',
    assignments: segments.map((segment) => {
      const assignment = segment.assignment;
      const record = assignment.referenceId ? findReference(state, assignment.referenceId) : null;
      const check = assignment.referenceId ? checks[assignment.referenceId] : undefined;
      return {
        ...assignment,
        speakerId: segment.speakerId,
        referenceSha256: record && check?.allowed ? record.sha256 : null,
      };
    }),
  });
}

/**
 * The identity digest of the CURRENT project inputs. When the plan itself is
 * impossible (a speaker without an assignment) there is no valid identity, and
 * the digest is deliberately not reproducible: the approval cannot stay bound.
 */
export function currentIdentityDigest(
  videoId: string,
  project: ReturnType<typeof loadProject>,
  state: VoiceAudioPersistedState
): string {
  let segments: PlannedSegment[] = [];
  try {
    if (project) segments = planSegments(project, state);
  } catch {
    return voiceAudioIdentityDigest({
      projectId: videoId,
      scriptSha256: voicePreviewTextSha256(''),
      language: project?.meta?.input?.outputLanguage ?? 'en',
      assignments: [],
    });
  }
  return identityDigestForSegments(videoId, project, state, segments);
}

export function currentArtifactSha256(
  videoId: string,
  state: VoiceAudioPersistedState
): string | null {
  const abs = previewArtifactAbsPath(videoId, state.preview);
  if (!abs || !fs.existsSync(abs)) return null;
  try {
    return sha256OfFile(abs);
  } catch {
    return null;
  }
}

export function buildRenderGate(
  videoId: string,
  project: ReturnType<typeof loadProject>,
  state: VoiceAudioPersistedState
): VoiceAudioRenderGateResult {
  const checks = referenceChecks(state, videoId);
  const clonedVoiceSelected = state.assignments.some((a) => a.engine === 'chatterbox');
  const statuses = voiceAudioEngineStatuses(engineFacts(probeEngines()));
  const statusByKind: Record<string, (typeof statuses)[number]> = {};
  for (const status of statuses) statusByKind[status.engine] = status;
  return evaluateClonedAudioRenderGate({
    clonedVoiceSelected,
    assignments: state.assignments,
    references: state.references,
    referenceChecks: checks,
    engineStatuses: statusByKind,
    preview: state.preview,
    approval: state.approval,
    currentIdentityDigest: currentIdentityDigest(videoId, project, state),
    currentArtifactSha256: currentArtifactSha256(videoId, state),
    perSceneTimingAligned: false,
  });
}

/**
 * Blocking codes that come from consent/approval rather than provisioning, so
 * the UI can say "blocked by consent or approval" truthfully and immediately.
 */
export function approvalBlockedCodesFor(
  state: VoiceAudioPersistedState,
  checks: Record<string, ReturnType<typeof checkVoiceReference>>
): Record<string, readonly string[]> {
  const blocked: Record<string, readonly string[]> = { chatterbox: [], kokoro: [] };
  const cloned = state.assignments.filter((a) => a.engine === 'chatterbox');
  const codes: string[] = [];
  for (const assignment of cloned) {
    const check = assignment.referenceId ? checks[assignment.referenceId] : undefined;
    if (!check) {
      codes.push('REFERENCE-MISSING');
      continue;
    }
    if (!check.allowed) codes.push(...check.blockedCodes);
  }
  blocked.chatterbox = codes;
  return blocked;
}

/* ------------------------------------------------------------------ */
/*  Generation job registry (existing pattern: in-memory + polling)     */
/* ------------------------------------------------------------------ */

interface GenerationJob {
  jobId: string;
  status: 'running' | 'done' | 'failed';
  progress: { completed: number; total: number; currentSpeaker: string | null };
  log: string[];
  error?: { code: string; message: string; remediation?: string };
  previewId?: string;
  startedAt: string;
  finishedAt?: string;
}

export const voiceAudioJobs = new Map<string, GenerationJob>();

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

export async function registerVoiceAudioRoutes(app: FastifyInstance) {
  /* ---------------- state ---------------- */

  app.get('/api/projects/:id/voice-audio', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    const project = loadProject(id);
    if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));

    const state = loadVoiceAudioState(id);
    const checks = referenceChecks(state, id);
    const probes = probeEngines();
    const facts = engineFacts(
      probes,
      approvalBlockedCodesFor(state, checks),
      state.preview?.status === 'failed' ? { chatterbox: state.preview.error ?? null } : {}
    );
    const statuses = voiceAudioEngineStatuses(facts);
    const gate = buildRenderGate(id, project, state);
    const approvalEvaluation = evaluateVoiceAudioPreviewApproval({
      preview: state.preview,
      approval: state.approval,
      currentIdentityDigest: currentIdentityDigest(id, project, state),
      currentArtifactSha256: currentArtifactSha256(id, state),
    });
    const artifactAbs = previewArtifactAbsPath(id, state.preview);

    const payload: VoiceAudioStateResponse = {
      projectId: id,
      schemaVersion: '1.0.0',
      engines: statuses.map((status) => {
        const fact = facts.find((f) => f.engine === status.engine);
        const probe = probes.find((p) => p.kind === status.engine);
        return {
          ...status,
          modelId: probe?.modelId ?? '',
          modelRevision: probe?.modelRevision ?? null,
          runtimeInstalled: fact?.runtimeInstalled ?? false,
          provisioned: fact?.provisioned ?? false,
          deviceSatisfied: fact?.deviceSatisfied ?? false,
          deviceDetail: fact?.deviceDetail ?? '',
          cpuRequiresOptIn: fact?.cpuRequiresOptIn === true,
          provisionRemedy: fact?.provisionRemedy ?? '',
          approvalBlockedCodes: [...(fact?.approvalBlockedCodes ?? [])],
          notes: [...(probe?.notes ?? [])],
        };
      }),
      kokoroSeparateChoice: true,
      references: state.references
        .filter((r) => !r.removedAt)
        .map((record) => toPublicVoiceReference(record, checks[record.referenceId])),
      assignments: state.assignments.map((assignment) => {
        const record = assignment.referenceId ? findReference(state, assignment.referenceId) : null;
        const speaker = projectSpeakers(project).find((s) => s.speakerId === assignment.speakerId);
        return {
          ...assignment,
          referenceDisplayName: record?.displayName ?? null,
          referenceApproved: record ? checks[record.referenceId]?.approved === true : false,
          speakerLabel: speaker?.speakerName ?? assignment.speakerName ?? assignment.speakerId,
        };
      }),
      speakers: projectSpeakers(project).map((speaker) => ({
        ...speaker,
        assigned: state.assignments.some((a) => a.speakerId === speaker.speakerId),
      })),
      preview: state.preview
        ? {
            previewId: state.preview.previewId,
            status: state.preview.status,
            durationSeconds: state.preview.durationSeconds,
            language: state.preview.language,
            engineSummary: state.preview.engineSummary,
            createdAt: state.preview.createdAt,
            artifactAvailable: !!artifactAbs && fs.existsSync(artifactAbs),
            audioUrl:
              state.preview.status === 'ready' && artifactAbs && fs.existsSync(artifactAbs)
                ? `/api/projects/${encodeURIComponent(id)}/voice-audio/previews/${state.preview.previewId}/audio`
                : null,
            segments: state.preview.segments.length,
            timing: state.preview.timing,
            error: state.preview.error ?? null,
          }
        : null,
      approval: state.approval
        ? {
            decision: state.approval.decision,
            approvedAt: state.approval.approvedAt,
            approvedBy: state.approval.approvedBy,
            boundToCurrentPreview: approvalEvaluation.allowed,
            staleCodes: approvalEvaluation.findings.map((f) => f.code),
          }
        : null,
      renderGate: gate,
      clonedVoiceSelected: state.assignments.some((a) => a.engine === 'chatterbox'),
      privacy: { referenceRecordingsCommitted: false, exportedInDeliverables: false },
    };
    return payload;
  });

  /* ---------------- reference upload ---------------- */

  app.post(
    '/api/projects/:id/voice-audio/references',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));

      /*
       * Multipart handling — the file part is CONSUMED inside the loop.
       *
       * `@fastify/multipart` only advances to the next part once the current
       * part's stream has been read, so a loop that merely keeps a reference to
       * a file part and keeps iterating deadlocks until the client times out.
       * Streaming the recording to its staging file as it arrives keeps the
       * memory bounded, lets every text field be collected whatever the order
       * (a browser may send `file` first), and preserves the 400/413 answers.
       */
      const fields: Record<string, string> = {};
      let staged: {
        abs: string;
        bytes: number;
        originalName: string;
        mime: string;
        referenceId: string;
        ext: string;
      } | null = null;
      let rejection: { status: number; message: string } | null = null;

      try {
        for await (const part of (req as any).parts({
          /*
           * The size limit is given to the multipart parser itself, so an
           * oversized recording is truncated and DISCARDED by busboy and the
           * message still parses to its end. Leaving the rest of the body
           * unread would stall the request forever, which is why the limit is
           * enforced here rather than by aborting a half-read stream.
           */
          limits: { fileSize: MAX_REFERENCE_UPLOAD_BYTES },
        })) {
          if (part.type !== 'file') {
            const key = String(part.fieldname ?? '');
            if (key) fields[key] = String(part.value ?? '');
            continue;
          }
          if (staged) {
            /* Only the first recording is considered; the rest is discarded. */
            await drain(part);
            continue;
          }

          const originalName = String(part.filename ?? 'reference.wav');
          const mime = String(part.mimetype ?? '');
          const ext = path.extname(originalName).toLowerCase();
          if (!ALLOWED_REFERENCE_EXTENSIONS.includes(ext as (typeof ALLOWED_REFERENCE_EXTENSIONS)[number])) {
            await drain(part);
            rejection ??= {
              status: 400,
              message: `Unsupported reference format "${ext || '(none)'}". Allowed: ${ALLOWED_REFERENCE_EXTENSIONS.join(', ')}.`,
            };
            continue;
          }
          if (mime.startsWith('image/') || mime.startsWith('video/') || mime === 'application/json' || mime === 'text/plain') {
            await drain(part);
            rejection ??= { status: 400, message: `MIME type "${mime}" is not an accepted audio type.` };
            continue;
          }

          const referenceId = newReferenceId();
          const dir = referencesDir(id);
          fs.mkdirSync(dir, { recursive: true });
          const tempAbs = resolveInsideProject(id, path.join(dir, `.tmp_${randomBytes(6).toString('hex')}${ext}`));
          if (!tempAbs) {
            await drain(part);
            rejection ??= { status: 500, message: 'Could not allocate a safe staging path.' };
            continue;
          }
          try {
            const result = await streamToFile(part, tempAbs, MAX_REFERENCE_UPLOAD_BYTES);
            staged = { abs: tempAbs, bytes: result.bytesWritten, originalName, mime, referenceId, ext };
          } catch (e) {
            tryUnlink(tempAbs);
            rejection ??=
              (e as { code?: string }).code === 'LIMIT_EXCEEDED'
                ? {
                    status: 413,
                    message: `Reference recording exceeds the maximum size of ${MAX_REFERENCE_UPLOAD_BYTES / 1024 / 1024} MB.`,
                  }
                : { status: 400, message: `Upload failed during transfer: ${toErrorMessage(e)}` };
          }
        }
      } catch (e) {
        /*
         * A multipart parse failure (including the size limit above) is answered
         * instead of being allowed to abort the connection half-read.
         */
        const tooLarge = (e as { code?: string; statusCode?: number }).code === 'FST_REQ_FILE_TOO_LARGE'
          || (e as { statusCode?: number }).statusCode === 413;
        rejection ??= tooLarge
          ? { status: 413, message: `Reference recording exceeds the maximum size of ${MAX_REFERENCE_UPLOAD_BYTES / 1024 / 1024} MB.` }
          : { status: 400, message: `The upload could not be read: ${toErrorMessage(e)}` };
      }

      /* Nothing partial is ever left behind by a rejected upload. */
      if (rejection && staged) tryUnlink(staged.abs);

      if (rejection) return reply.code(rejection.status).send(JSON_ERROR(rejection.message));
      if (!staged) return reply.code(400).send(JSON_ERROR('No reference recording was uploaded.'));

      const { originalName } = staged;
      const displayName = sanitizeDisplayName(fields.displayName ?? path.parse(originalName).name);
      if (!displayName) {
        tryUnlink(staged.abs);
        return reply.code(400).send(JSON_ERROR('A display name of 1-80 characters is required.'));
      }

      const ext = staged.ext;
      const referenceId = staged.referenceId;
      const dir = referencesDir(id);
      const tempAbs = staged.abs;
      const bytes = staged.bytes;
      if (bytes === 0) {
        tryUnlink(tempAbs);
        return reply.code(400).send(JSON_ERROR('The uploaded reference recording is empty.'));
      }

      /* CONTENT validation: ffprobe must find a real audio stream. */
      let metrics: { durationSeconds: number; sampleRate: number; channels: number; container: string };
      try {
        metrics = await probeReferenceAudio(tempAbs);
      } catch (e) {
        tryUnlink(tempAbs);
        return reply.code(400).send(JSON_ERROR(toErrorMessage(e)));
      }

      /* Content/extension agreement: a `.wav` that contains MP3 is refused. */
      const contentExt = `.${metrics.container === 'matroska,webm' ? 'webm' : metrics.container.split(',')[0]}`;
      const extMatches =
        metrics.container.includes(ext.replace('.', '')) ||
        (ext === '.m4a' && metrics.container.includes('mov')) ||
        (ext === '.ogg' && metrics.container.includes('ogg')) ||
        (ext === '.wav' && metrics.container.includes('wav')) ||
        (ext === '.mp3' && metrics.container.includes('mp3')) ||
        (ext === '.flac' && metrics.container.includes('flac'));
      if (!extMatches) {
        tryUnlink(tempAbs);
        return reply.code(400).send(
          JSON_ERROR(
            `The file's contents (${contentExt.replace('.', '') || metrics.container}) do not match its extension "${ext}".`
          )
        );
      }

      const storedRel = toRepoRelative(path.join(dir, `${referenceId}${ext}`));
      try {
        fs.renameSync(tempAbs, path.join(process.cwd(), storedRel));
      } catch (e) {
        tryUnlink(tempAbs);
        return reply.code(500).send(JSON_ERROR(`Failed to store the reference recording: ${toErrorMessage(e)}`));
      }

      const sha256 = sha256OfFile(path.join(process.cwd(), storedRel));
      const record: VoiceReferenceRecord = {
        referenceId,
        displayName,
        storedRef: storedRel,
        sha256,
        sizeBytes: bytes,
        durationSeconds: metrics.durationSeconds,
        sampleRate: metrics.sampleRate,
        channels: metrics.channels,
        container: metrics.container,
        createdAt: new Date().toISOString(),
        /* Upload grants NOTHING: authorization and approval are separate actions. */
        authorization: null,
        approval: { state: 'pending' },
      };

      const state = loadVoiceAudioState(id);
      state.references = [...state.references, record];
      saveVoiceAudioState(state);

      const check = checkVoiceReference(record, sha256);
      return reply.code(201).send({
        ok: true,
        reference: toPublicVoiceReference(record, check),
        validation: {
          durationSeconds: metrics.durationSeconds,
          sampleRate: metrics.sampleRate,
          channels: metrics.channels,
          container: metrics.container,
          sizeBytes: bytes,
          checkedBy: 'ffprobe content inspection (not the file extension alone)',
        },
        nextSteps: [
          'Confirm that this is your own voice or that you hold documented authorization to use it.',
          'Approve the reference recording before assigning it to a speaker.',
        ],
        authorized: false,
        approved: false,
      });
    }
  );

  /* ---------------- authorization ---------------- */

  app.post(
    '/api/projects/:id/voice-audio/references/:refId/authorize',
    async (req: FastifyRequest<{ Params: { id: string; refId: string } }>, reply: FastifyReply) => {
      const { id, refId } = req.params;
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
      if (!isSafeReferenceId(refId)) return reply.code(400).send(JSON_ERROR('Invalid reference id.'));

      const body = (req.body ?? {}) as Record<string, unknown>;
      /* Explicit confirmation only. `ownerConfirmed` must be the boolean true. */
      if (body.ownerConfirmed !== true) {
        return reply.code(400).send(
          JSON_ERROR(
            'Authorization must be confirmed explicitly. Uploading a file never grants authorization.'
          )
        );
      }
      const statement = typeof body.statement === 'string' ? body.statement.trim().slice(0, 500) : '';
      if (statement.length < 10) {
        return reply.code(400).send(
          JSON_ERROR('Describe the authorization in your own words (at least 10 characters).')
        );
      }
      const confirmedBy = sanitizeDisplayName(body.confirmedBy) ?? 'project-owner';

      const state = loadVoiceAudioState(id);
      const record = findReference(state, refId);
      if (!record || record.removedAt) return reply.code(404).send(JSON_ERROR('Reference recording not found.'));

      const confirmedAt = new Date().toISOString();
      /* The authorization is RECORDED as an artifact: the VS1 gate requires an
       * auditable consent artifact for a cloned human voice, and an auditable
       * record is exactly what the user just confirmed. */
      const consentRel = toRepoRelative(path.join(referencesDir(id), `${refId}.consent.json`));
      const consentAbs = resolveInsideProject(id, path.join(process.cwd(), consentRel));
      if (consentAbs) {
        fs.writeFileSync(
          consentAbs,
          JSON.stringify(
            {
              kind: 'voice-reference-authorization',
              schemaVersion: 1,
              projectId: id,
              referenceId: refId,
              displayName: record.displayName,
              referenceSha256: record.sha256,
              ownerConfirmed: true,
              confirmedBy,
              confirmedAt,
              statement,
              scope: ['commercial_video_publication', 'synthetic_voice_cloning'],
            },
            null,
            2
          ),
          'utf8'
        );
        record.consentEvidenceRef = consentRel;
      }
      record.authorization = {
        ownerConfirmed: true,
        confirmedBy,
        confirmedAt,
        statement,
      };
      /* Authorization alone never approves: the approval stays as it was. */
      saveVoiceAudioState(state);

      const checks = referenceChecks(state, id);
      return {
        ok: true,
        reference: toPublicVoiceReference(record, checks[record.referenceId]),
        note: 'Authorization recorded. The reference still needs explicit approval before it can be used.',
      };
    }
  );

  /* ---------------- reference approval (VS1 gate) ---------------- */

  app.post(
    '/api/projects/:id/voice-audio/references/:refId/approve',
    async (req: FastifyRequest<{ Params: { id: string; refId: string } }>, reply: FastifyReply) => {
      const { id, refId } = req.params;
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
      if (!isSafeReferenceId(refId)) return reply.code(400).send(JSON_ERROR('Invalid reference id.'));

      const body = (req.body ?? {}) as Record<string, unknown>;
      const decision = body.decision === 'rejected' ? 'rejected' : body.decision === 'approved' ? 'approved' : null;
      if (!decision) return reply.code(400).send(JSON_ERROR('decision must be "approved" or "rejected".'));
      const approver = sanitizeDisplayName(body.approver) ?? 'project-owner';
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 400) : undefined;

      const state = loadVoiceAudioState(id);
      const record = findReference(state, refId);
      if (!record || record.removedAt) return reply.code(404).send(JSON_ERROR('Reference recording not found.'));

      if (decision === 'rejected') {
        record.approval = { state: 'rejected', approver, reviewedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
        saveVoiceAudioState(state);
        const checks = referenceChecks(state, id);
        return { ok: true, reference: toPublicVoiceReference(record, checks[record.referenceId]) };
      }

      /* Rights evidence belongs to the approval request: silence is not permission. */
      const rawRights = body.rights as Record<string, unknown> | undefined;
      const rights: VoiceRightsEvidence | null =
        rawRights && typeof rawRights === 'object'
          ? ({
              sourceProvider: String(rawRights.sourceProvider ?? ''),
              licenseName: String(rawRights.licenseName ?? ''),
              evidenceUrl: String(rawRights.evidenceUrl ?? ''),
              evidenceKind: (rawRights.evidenceKind as VoiceRightsEvidence['evidenceKind']) ?? 'written_permission',
              accessedAt: String(rawRights.accessedAt ?? new Date().toISOString().slice(0, 10)),
              commercialUse: (rawRights.commercialUse as VoiceRightsEvidence['commercialUse']) ?? 'not_stated',
              ...(typeof rawRights.commercialUseStatement === 'string'
                ? { commercialUseStatement: rawRights.commercialUseStatement }
                : {}),
              ...(typeof rawRights.conditions === 'string' ? { conditions: rawRights.conditions } : {}),
            } as VoiceRightsEvidence)
          : null;

      const probes = probeEngines();
      const chatterbox = probes.find((p) => p.kind === 'chatterbox')!;
      const reviewedAt = new Date().toISOString();
      const gate = evaluateReferencePublicationProfile({
        record: { ...record, approval: { state: 'approved', approver, reviewedAt } },
        target: {
          engine: 'chatterbox',
          engineId: 'chatterbox-tts',
          engineFamily: 'chatterbox',
          modelId: chatterbox.modelId,
          modelRevision: chatterbox.modelRevision,
          runtimeId: 'chatterbox-tts',
          runtimeVersion: '0.1.7',
        },
        rights,
        approver,
        reviewedAt,
        language: project.meta?.input?.outputLanguage ?? 'en',
        ...(reason ? { reason } : {}),
      });

      record.rights = rights;
      record.approval = {
        state: gate.allowed ? 'approved' : 'pending',
        approver,
        reviewedAt,
        ...(reason ? { reason } : {}),
        gateAllowed: gate.allowed,
        gateCodes: gate.findings.map((f) => f.code),
      };
      saveVoiceAudioState(state);

      if (!gate.allowed) {
        const blocked = gate.findings.filter((f) => f.severity === 'error').map((f) => f.code);
        return reply.code(422).send({
          error: `The reference recording cannot be approved: ${blocked.join(', ')}.`,
          blockedCodes: blocked,
          findings: gate.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
          reference: toPublicVoiceReference(record, checkVoiceReference(record, record.sha256)),
        });
      }

      const checks = referenceChecks(state, id);
      return {
        ok: true,
        reference: toPublicVoiceReference(record, checks[record.referenceId]),
        gate: { allowed: gate.allowed, errorCount: gate.errorCount, warningCount: gate.warningCount },
      };
    }
  );

  /* ---------------- reference removal ---------------- */

  app.delete(
    '/api/projects/:id/voice-audio/references/:refId',
    async (req: FastifyRequest<{ Params: { id: string; refId: string } }>, reply: FastifyReply) => {
      const { id, refId } = req.params;
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
      if (!isSafeReferenceId(refId)) return reply.code(400).send(JSON_ERROR('Invalid reference id.'));

      const state = loadVoiceAudioState(id);
      const record = findReference(state, refId);
      if (!record || record.removedAt) return reply.code(404).send(JSON_ERROR('Reference recording not found.'));

      const body = (req.body ?? {}) as Record<string, unknown>;
      /* `clearAssignments` may arrive as a query flag (what the UI sends) or in
       * a JSON body: either way it must be the explicit boolean true. */
      const query = (req.query ?? {}) as Record<string, unknown>;
      const clearingAssignment = body.clearAssignments === true || query.clearAssignments === 'true';
      if (isReferenceAssigned(state, refId) && !clearingAssignment) {
        return reply.code(409).send(
          JSON_ERROR(
            'This reference recording is assigned to a speaker. Reassign the speaker first, or confirm the removal to clear the assignment.'
          )
        );
      }

      /* Clear the assignment and any approval that depended on it BEFORE the file goes. */
      state.assignments = state.assignments.filter((a) => a.referenceId !== refId);
      record.removedAt = new Date().toISOString();
      record.approval = { ...record.approval, state: 'pending' };
      saveVoiceAudioState(state);

      deleteReferenceFile(id, record);

      return {
        ok: true,
        removedReferenceId: refId,
        clearedAssignments: clearingAssignment,
        note: 'The stored recording was deleted. The project no longer references it.',
      };
    }
  );

  /* ---------------- speaker assignments ---------------- */

  app.put(
    '/api/projects/:id/voice-audio/assignments',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));

      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = Array.isArray(body.assignments) ? (body.assignments as Record<string, unknown>[]) : null;
      if (!raw) return reply.code(400).send(JSON_ERROR('assignments must be an array.'));

      const known = new Set(projectSpeakers(project).map((s) => s.speakerId));
      const state = loadVoiceAudioState(id);
      const checks = referenceChecks(state, id);
      const next: VoiceAudioAssignment[] = [];

      for (const entry of raw) {
        const speakerId = String(entry.speakerId ?? '');
        if (!known.has(speakerId)) {
          return reply.code(400).send(JSON_ERROR(`Unknown speaker "${speakerId}" for this project.`));
        }
        const engine = entry.engine === 'kokoro' ? 'kokoro' : entry.engine === 'chatterbox' ? 'chatterbox' : null;
        if (!engine) return reply.code(400).send(JSON_ERROR(`Unknown engine "${String(entry.engine)}".`));

        if (engine === 'chatterbox') {
          const referenceId = String(entry.referenceId ?? '');
          if (!isSafeReferenceId(referenceId)) {
            return reply.code(400).send(JSON_ERROR('A cloned-voice assignment requires an approved reference id.'));
          }
          const record = findReference(state, referenceId);
          if (!record || record.removedAt) return reply.code(400).send(JSON_ERROR('Reference recording not found.'));
          const check = checks[referenceId];
          if (!check?.allowed) {
            /* Refuse to create an assignment that cannot possibly run. */
            return reply.code(422).send({
              error: `The reference recording is not usable yet: ${check?.blockedCodes.join(', ') ?? 'unknown'}.`,
              blockedCodes: check?.blockedCodes ?? [],
              findings: check?.findings ?? [],
            });
          }
          const probes = probeEngines();
          const chatterbox = probes.find((p) => p.kind === 'chatterbox')!;
          next.push({
            speakerId,
            engine,
            engineId: 'chatterbox-tts',
            modelId: chatterbox.modelId,
            modelRevision: chatterbox.modelRevision,
            settingsDigest: null,
            referenceId,
            referenceSha256: record.sha256,
          });
        } else {
          const presetVoiceId = typeof entry.presetVoiceId === 'string' && entry.presetVoiceId.trim()
            ? entry.presetVoiceId.trim().slice(0, 64)
            : 'af_heart';
          next.push({
            speakerId,
            engine,
            engineId: 'kokoro-js',
            modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
            modelRevision: 'v1.0',
            presetVoiceId,
            referenceId: null,
            referenceSha256: null,
          });
        }
      }

      state.assignments = next;
      /* Any assignment change invalidates the preview approval, never silently. */
      saveVoiceAudioState(state);
      const gate = buildRenderGate(id, project, state);
      return { ok: true, assignments: state.assignments, renderGate: gate };
    }
  );

  /* ---------------- preview generation ---------------- */

  app.post(
    '/api/projects/:id/voice-audio/previews',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));

      const state = loadVoiceAudioState(id);
      if (state.assignments.length === 0) {
        return reply.code(409).send(
          JSON_ERROR('Assign a voice to at least one speaker before generating a preview.')
        );
      }
      const checks = referenceChecks(state, id);
      const cloned = state.assignments.filter((a) => a.engine === 'chatterbox');
      for (const assignment of cloned) {
        const check = assignment.referenceId ? checks[assignment.referenceId] : undefined;
        if (!check?.allowed) {
          return reply.code(409).send({
            error: `Speaker "${assignment.speakerId}" has no usable approved reference recording.`,
            blockedCodes: check?.blockedCodes ?? ['REFERENCE-MISSING'],
            findings: check?.findings ?? ['No reference recording is assigned.'],
          });
        }
      }

      /*
       * Kokoro stays an explicit, separate choice: no substitution happens here.
       * Usability is decided by the PROBE (provisioned + device), never by
       * "an adapter object could be constructed" — an unprovisioned engine must
       * refuse to start a job instead of failing halfway through generation.
       */
      const kinds = [...new Set(state.assignments.map((a) => a.engine))];
      const probes = probeEngines();
      for (const kind of kinds) {
        const probe = probes.find((p) => p.kind === kind)!;
        const built = buildSynthesizer(kind);
        if (!built || !probe.provisioned || !probe.deviceSatisfied) {
          return reply.code(409).send({
            error:
              kind === 'chatterbox'
                ? `Chatterbox is not usable on this machine: ${probe.deviceDetail}${probe.provisioned ? '' : ' It is not provisioned.'}`
                : 'Kokoro is not provisioned on this machine.',
            engine: kind,
            remedy: probe.provisionRemedy,
            deviceDetail: probe.deviceDetail,
            provisioned: probe.provisioned,
          });
        }
      }

      const previewId = newPreviewId();
      const jobId = `${id}:voice-audio:${previewId}`;
      const segments = planSegments(project, state);
      const job: GenerationJob = {
        jobId,
        status: 'running',
        progress: { completed: 0, total: segments.length, currentSpeaker: null },
        log: [],
        previewId,
        startedAt: new Date().toISOString(),
      };
      voiceAudioJobs.set(jobId, job);

      const dir = previewDir(id, previewId);
      fs.mkdirSync(dir, { recursive: true });
      const scratchDir = path.join(voiceAudioRoot(id), 'scratch');
      fs.mkdirSync(scratchDir, { recursive: true });

      void runGeneration({ videoId: id, project, state, previewId, job, segments, scratchDir });

      return reply.code(202).send({ jobId, previewId, status: 'running', totalSegments: segments.length });
    }
  );

  app.get(
    '/api/projects/:id/voice-audio/jobs/:jobId',
    async (req: FastifyRequest<{ Params: { id: string; jobId: string } }>, reply: FastifyReply) => {
      const { jobId } = req.params;
      const job = voiceAudioJobs.get(jobId);
      if (!job) return reply.code(404).send(JSON_ERROR('Unknown generation job.'));
      return job;
    }
  );

  /* ---------------- preview audio streaming ---------------- */

  app.get(
    '/api/projects/:id/voice-audio/previews/:previewId/audio',
    async (req: FastifyRequest<{ Params: { id: string; previewId: string } }>, reply: FastifyReply) => {
      const { id, previewId } = req.params;
      if (!loadProject(id)) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
      const state = loadVoiceAudioState(id);
      /* Only the CURRENT preview of THIS project is ever served. */
      if (!state.preview || state.preview.previewId !== previewId) {
        return reply.code(404).send(JSON_ERROR('Preview not found for this project.'));
      }
      const abs = previewArtifactAbsPath(id, state.preview);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return reply.code(404).send(JSON_ERROR('Preview audio is not available.'));
      }
      reply.header('Content-Type', 'audio/wav');
      reply.header('Cache-Control', 'no-store');
      return reply.send(fs.createReadStream(abs));
    }
  );

  /* ---------------- approval of the exact artifact ---------------- */

  app.post(
    '/api/projects/:id/voice-audio/previews/:previewId/approval',
    async (req: FastifyRequest<{ Params: { id: string; previewId: string } }>, reply: FastifyReply) => {
      const { id, previewId } = req.params;
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));

      const state = loadVoiceAudioState(id);
      if (!state.preview || state.preview.previewId !== previewId) {
        return reply.code(404).send(JSON_ERROR('Preview not found for this project.'));
      }
      if (state.preview.status !== 'ready') {
        return reply.code(409).send(JSON_ERROR('Only a finished preview can be approved.'));
      }
      const artifactSha256 = currentArtifactSha256(id, state);
      if (!artifactSha256) return reply.code(409).send(JSON_ERROR('The preview artifact is missing on disk.'));

      const body = (req.body ?? {}) as Record<string, unknown>;
      const decision = body.decision === 'rejected' ? 'rejected' : body.decision === 'approved' ? 'approved' : null;
      if (!decision) return reply.code(400).send(JSON_ERROR('decision must be "approved" or "rejected".'));
      const approvedBy = sanitizeDisplayName(body.approvedBy) ?? 'project-owner';
      const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 400) : undefined;

      state.approval = {
        decision,
        identityDigest: state.preview.identityDigest,
        artifactSha256,
        approvedAt: new Date().toISOString(),
        approvedBy,
        ...(notes ? { notes } : {}),
      };
      saveVoiceAudioState(state);

      const gate = buildRenderGate(id, project, state);
      return { ok: true, approval: state.approval, renderGate: gate };
    }
  );

  /* ---------------- render gate ---------------- */

  app.get(
    '/api/projects/:id/voice-audio/render-gate',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
      const state = loadVoiceAudioState(id);
      const gate = buildRenderGate(id, project, state);
      return reply.code(gate.allowed ? 200 : 409).send(gate);
    }
  );
}

/* ------------------------------------------------------------------ */
/*  Generation internals                                               */
/* ------------------------------------------------------------------ */

interface PlannedSegment {
  index: number;
  speakerId: string;
  speakerName: string;
  engine: VoiceAudioEngineKind;
  spokenText: string;
  assignment: VoiceAudioAssignment;
}

/**
 * Split the project's narration into per-speaker segments.
 *
 * The COMPLETE script is preserved: every character of the source text appears
 * in exactly one segment. Nothing is trimmed, re-timed or dropped.
 */
export function planSegments(
  project: NonNullable<ReturnType<typeof loadProject>>,
  state: VoiceAudioPersistedState
): PlannedSegment[] {
  const script = (project.meta?.input?.script ?? '').trim();
  const assignments = state.assignments;
  const bySpeaker = new Map(assignments.map((a) => [a.speakerId, a]));
  const speakers = projectSpeakers(project);

  /* Dialogue turns, when the storyboard has them. */
  type Turn = { speakerId?: string; speakerName?: string; spokenText?: string; text?: string };
  const turns: { speakerId: string; speakerName: string; text: string }[] = [];
  for (const scene of project.storyboard?.long?.scenes ?? []) {
    for (const turn of ((scene as unknown as { turns?: Turn[] }).turns ?? [])) {
      const text = (turn.spokenText ?? turn.text ?? '').trim();
      if (!text) continue;
      const speakerId = turn.speakerId ?? 'narrator';
      turns.push({
        speakerId,
        speakerName: turn.speakerName ?? speakers.find((s) => s.speakerId === speakerId)?.speakerName ?? speakerId,
        text,
      });
    }
  }

  const single = speakers.length === 1 ? speakers[0] : null;
  const source =
    turns.length > 0
      ? turns
      : [{ speakerId: single?.speakerId ?? 'narrator', speakerName: single?.speakerName ?? 'Narrator', text: script }];

  const planned: PlannedSegment[] = [];
  source.forEach((entry) => {
    if (!entry.text) return;
    /**
     * Which assignment covers this speaker. A single-speaker project may use its
     * one assignment for the narrator; anything else must be EXPLICIT — an
     * unassigned speaker is a hard error, because silently dropping their words
     * (or quietly lending them another speaker's voice) would corrupt the
     * narration. Different names never imply different voices, and a missing
     * name never implies a default voice either.
     */
    const assignment = bySpeaker.get(entry.speakerId) ?? (single ? bySpeaker.get(single.speakerId) : undefined);
    if (!assignment) {
      throw new VoiceAudioPlanningError(
        `Speaker "${entry.speakerId}" has no voice assignment. Assign a voice to every speaker before generating a preview; the narration is never generated with missing speakers.`
      );
    }
    planned.push({
      index: planned.length,
      speakerId: entry.speakerId,
      speakerName: entry.speakerName,
      engine: assignment.engine,
      spokenText: entry.text,
      assignment,
    });
  });
  return planned;
}

async function runGeneration(input: {
  videoId: string;
  project: NonNullable<ReturnType<typeof loadProject>>;
  state: VoiceAudioPersistedState;
  previewId: string;
  job: GenerationJob;
  segments: PlannedSegment[];
  scratchDir: string;
}): Promise<void> {
  const { videoId, project, previewId, job, segments, scratchDir } = input;
  const dir = previewDir(videoId, previewId);
  const producedSegments: VoiceAudioPreviewSegment[] = [];
  const log = (message: string): void => {
    job.log.push(`${new Date().toISOString().slice(11, 19)}  ${message}`);
    if (job.log.length > 200) job.log.splice(0, 50);
  };

  const storedSegments: { rel: string; spokenText: string; speakerId: string; speakerName: string; engine: VoiceAudioEngineKind; durationSeconds: number | null }[] = [];

  try {
    let total = 0;
    for (const segment of segments) {
      job.progress.currentSpeaker = segment.speakerName;
      const built = buildSynthesizer(segment.engine, { scratchDir: toRepoRelative(scratchDir) });
      if (!built) throw new Error(`The ${segment.engine} engine is not usable on this machine.`);

      const segName = `seg-${String(segment.index + 1).padStart(2, '0')}.wav`;
      const segAbs = resolveInsideProject(videoId, path.join(dir, segName));
      if (!segAbs) throw new Error('Refusing to write outside the project voice-audio root.');

      const record = segment.assignment.referenceId
        ? findReference(input.state, segment.assignment.referenceId)
        : null;
      const profile = buildSegmentProfile(segment, record, input.state, project);

      const request = segmentRequest({
        projectId: videoId,
        sceneIndex: 0,
        turnIndex: segment.index,
        globalTurnIndex: segment.index,
        speakerId: segment.speakerId,
        speakerName: segment.speakerName,
        voiceSlot: segment.assignment.referenceId
          ? `voice_ref_${segment.assignment.referenceId}`
          : `voice_preset_${segment.assignment.presetVoiceId ?? 'default'}`,
        voiceProfileId: segment.assignment.referenceId
          ? `vp_ref_${segment.assignment.referenceId}`
          : `vp_preset_${segment.assignment.presetVoiceId ?? 'default'}`,
        voiceProfile: profile,
        language: project.meta?.input?.outputLanguage ?? 'en',
        spokenText: segment.spokenText,
        targetPath: toRepoRelative(segAbs),
      });

      const result = await built.synthesizer.synthesize(request);
      if (!result.success) throw new Error(`Synthesis reported failure for segment ${segment.index + 1}.`);

      const measured = await durationOf(segAbs);
      total += Number.isFinite(measured) ? measured : 0;
      storedSegments.push({
        rel: toRepoRelative(segAbs),
        spokenText: segment.spokenText,
        speakerId: segment.speakerId,
        speakerName: segment.speakerName,
        engine: segment.engine,
        durationSeconds: Number.isFinite(measured) ? Number(measured.toFixed(3)) : null,
      });
      producedSegments.push({
        index: segment.index,
        speakerId: segment.speakerId,
        speakerName: segment.speakerName,
        engine: segment.engine,
        engineId: built.synthesizer.engineId,
        spokenText: segment.spokenText,
        textSha256: voicePreviewTextSha256(segment.spokenText),
        durationSeconds: Number.isFinite(measured) ? Number(measured.toFixed(3)) : null,
        outputRef: toRepoRelative(segAbs),
      });
      job.progress.completed += 1;
      log(`segment ${segment.index + 1}/${segments.length} (${segment.speakerName}) ready`);
    }

    const assignmentSummary = segments.length
      ? engineSummaryFor(segments[0].engine, buildSynthesizer(segments[0].engine, { scratchDir: toRepoRelative(scratchDir) })?.notes ?? [])
      : 'no segments';

    const segmentsDigest = voicePreviewTextSha256(
      storedSegments.map((s) => `${s.speakerId}:${s.spokenText}`).join('\u0000')
    );
    const identityDigest = identityDigestForSegments(videoId, project, input.state, segments);

    /* The single narration artifact is the concatenation of the segments, in
     * order, with no re-timing: the complete speech is preserved. */
    const artifactAbs = resolveInsideProject(videoId, path.join(dir, 'preview.wav'));
    if (!artifactAbs) throw new Error('Refusing to write outside the project voice-audio root.');
    await concatWavs(
      storedSegments.map((s) => path.join(process.cwd(), s.rel)),
      artifactAbs
    );
    const artifactSha256 = sha256OfFile(artifactAbs);
    const artifactDuration = await durationOf(artifactAbs);

    const latest = loadVoiceAudioState(videoId);
    const preview: VoiceAudioPreviewRecord = {
      previewId,
      identityDigest,
      textSha256: segmentsDigest,
      status: 'ready',
      artifactRef: toRepoRelative(artifactAbs),
      artifactSha256,
      durationSeconds: Number.isFinite(artifactDuration) ? Number(artifactDuration.toFixed(3)) : Number(total.toFixed(3)),
      language: project.meta?.input?.outputLanguage ?? 'en',
      engineSummary: assignmentSummary,
      segments: producedSegments,
      createdAt: job.startedAt,
      completedAt: new Date().toISOString(),
      error: null,
      timing: voiceAudioTiming(Number.isFinite(artifactDuration) ? artifactDuration : total),
    };
    latest.preview = preview;
    /* A NEW preview never inherits the previous approval. */
    latest.approval = null;
    saveVoiceAudioState(latest);

    /* Remove the per-segment intermediates and any other preview directory. */
    for (const segment of producedSegments) {
      if (!segment.outputRef) continue;
      const abs = resolveInsideProject(videoId, path.join(process.cwd(), segment.outputRef));
      if (abs && abs !== artifactAbs) tryUnlink(abs);
    }
    pruneOtherPreviews(videoId, previewId);
    cleanupTempArtifacts(videoId);

    job.previewId = previewId;
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.progress.currentSpeaker = null;
    log('preview ready');
  } catch (e) {
    const sanitized = sanitizeEngineError(e);
    job.status = 'failed';
    job.error = sanitized;
    job.finishedAt = new Date().toISOString();
    job.progress.currentSpeaker = null;
    log(`FAILED: ${sanitized.code}`);

    /* Cleanup: remove partial artifacts of THIS preview only. Reference
     * recordings are never touched by a failed generation. */
    deletePreviewArtifacts(videoId, previewId);

    const state = loadVoiceAudioState(videoId);
    state.preview = {
      previewId,
      identityDigest: '',
      textSha256: '',
      status: 'failed',
      artifactRef: null,
      artifactSha256: null,
      durationSeconds: null,
      language: project.meta?.input?.outputLanguage ?? 'en',
      engineSummary: 'generation failed',
      segments: [],
      createdAt: job.startedAt,
      completedAt: new Date().toISOString(),
      error: sanitized,
      timing: voiceAudioTiming(null),
    };
    state.approval = null;
    saveVoiceAudioState(state);
  }
}

function buildSegmentProfile(
  segment: PlannedSegment,
  record: VoiceReferenceRecord | null,
  state: VoiceAudioPersistedState,
  project: NonNullable<ReturnType<typeof loadProject>>
): import('@buildtrack/core').VoiceProfile {
  if (segment.engine === 'chatterbox') {
    if (!record) {
      /* A cloned segment without its approved reference record must NEVER be
       * synthesized with a preset or a default voice. */
      throw new VoiceAudioPlanningError(
        `Speaker "${segment.speakerId}" is assigned the cloned voice engine but has no usable reference recording.`
      );
    }
    const probes = probeEngines();
    const chatterbox = probes.find((p) => p.kind === 'chatterbox')!;
    const reviewedAt = record.approval?.reviewedAt ?? record.createdAt;
    return buildSynthesisVoiceProfile({
      referenceId: record.referenceId,
      displayName: record.displayName,
      storedRef: record.storedRef,
      sha256: record.sha256,
      durationSeconds: record.durationSeconds,
      sampleRate: record.sampleRate,
      channels: record.channels,
      container: record.container,
      language: project.meta?.input?.outputLanguage ?? 'en',
      modelId: chatterbox.modelId,
      modelRevision: chatterbox.modelRevision,
      runtimeId: 'chatterbox-tts',
      runtimeVersion: '0.1.7',
      approver: record.approval?.approver ?? 'project-owner',
      reviewedAt,
      consentEvidencePath: record.consentEvidenceRef ?? `${record.storedRef}.consent.json`,
      rights: record.rights as VoiceRightsEvidence,
    });
  }
  /* Kokoro preset profile: a preset voice, never a clone. */
  return {
    id: `vp_preset_${segment.assignment.presetVoiceId ?? 'default'}`,
    voiceSlot: `voice_preset_${segment.assignment.presetVoiceId ?? 'default'}`,
    displayName: `Kokoro preset ${segment.assignment.presetVoiceId ?? 'default'}`,
    description: 'Local Kokoro preset voice (not a cloned voice).',
    primaryLanguage: project.meta?.input?.outputLanguage ?? 'en',
    languages: [project.meta?.input?.outputLanguage ?? 'en'],
    gender: 'neutral',
    roleHint: 'authority',
    enabled: true,
    version: '1.0.0',
    createdAt: new Date(0).toISOString(),
    publication: {
      schemaVersion: '1.0.0',
      engine: {
        engine: 'kokoro',
        modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
        modelRevision: 'v1.0',
        runtimeId: 'kokoro-js',
        runtimeVersion: '1.2.1',
        requiresNetwork: false,
        localOnly: true,
      },
      acousticSource: {
        kind: 'preset_model_voice',
        presetVoiceId: segment.assignment.presetVoiceId ?? 'af_heart',
        bundledBy: 'kokoro-js@1.2.1 npm package',
      },
      consent: {
        subject: 'model_provider_preset',
        authorizedSpeaker: 'Kokoro (onnx-community export, Apache-2.0)',
        ownerConfirmed: true,
        confirmedBy: 'vs1-legacy-kokoro-migration',
        recordedAt: '2026-10-08T00:00:00.000Z',
        scope: ['commercial_video_publication'],
        revoked: false,
      },
      rights: {
        sourceProvider: 'hexgrad/kokoro',
        licenseName: 'Apache-2.0',
        evidenceUrl: 'https://github.com/hexgrad/kokoro/blob/main/LICENSE',
        evidenceKind: 'license_text',
        accessedAt: '2026-10-08',
        commercialUse: 'permitted',
      },
      audition: { state: 'not_tested' },
      publicationState: 'approved',
      origin: 'legacy_kokoro_fixture',
      updatedAt: '2026-10-08T00:00:00.000Z',
    },
  } as unknown as import('@buildtrack/core').VoiceProfile;
}

/* ------------------------------------------------------------------ */
/*  Small local utilities                                              */
/* ------------------------------------------------------------------ */

async function streamToFile(
  part: any,
  targetAbs: string,
  maxBytes: number
): Promise<{ bytesWritten: number }> {
  const writeStream = fs.createWriteStream(targetAbs);
  let bytesWritten = 0;
  try {
    await pipeline(
      part.file as AsyncIterable<Buffer>,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          bytesWritten += chunk.length;
          if (bytesWritten > maxBytes) {
            throw Object.assign(new Error('Upload limit exceeded'), { code: 'LIMIT_EXCEEDED' });
          }
          yield chunk;
        }
      },
      writeStream
    );
  } catch (e) {
    writeStream.destroy();
    try { await finished(writeStream); } catch { /* pipeline error is authoritative */ }
    tryUnlink(targetAbs);
    throw e;
  }
  if (part.file?.truncated) {
    tryUnlink(targetAbs);
    throw Object.assign(new Error('Upload limit exceeded'), { code: 'LIMIT_EXCEEDED' });
  }
  return { bytesWritten };
}

async function drain(part: any): Promise<void> {
  try {
    part.file.resume();
    await finished(part.file);
  } catch {
    /* best effort */
  }
}

function tryUnlink(file: string): void {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* best effort */
  }
}

/** Content-level validation of a reference recording through ffprobe. */
async function probeReferenceAudio(
  absPath: string
): Promise<{ durationSeconds: number; sampleRate: number; channels: number; container: string }> {
  const info = (await probe(absPath)) as {
    streams?: { codec_type?: string; sample_rate?: string; channels?: number }[];
    format?: { format_name?: string; duration?: string };
  };
  const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!audio) throw new Error('The uploaded file does not contain an audio stream.');
  const duration = Number(info.format?.duration ?? 0);
  if (!(duration > 0)) throw new Error('The uploaded audio has no measurable duration.');
  if (duration < 1) throw new Error('The reference recording is too short to clone a voice (at least 1 second).');
  if (duration > MAX_REFERENCE_DURATION_SECONDS) {
    throw new Error(
      `The reference recording is ${Math.round(duration)}s long; the maximum accepted length is ${MAX_REFERENCE_DURATION_SECONDS}s.`
    );
  }
  const sampleRate = Number(audio.sample_rate ?? 0);
  const channels = Number(audio.channels ?? 0);
  if (!(sampleRate >= 8000) || !(channels >= 1)) {
    throw new Error('The uploaded audio has unusable sample-rate/channel metadata.');
  }
  return {
    durationSeconds: Number(duration.toFixed(3)),
    sampleRate,
    channels,
    container: String(info.format?.format_name ?? 'unknown'),
  };
}

/** Concatenate canonical WAV segments in order (no trimming, no re-timing). */
async function concatWavs(inputs: readonly string[], outputAbs: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const ffmpeg = (await import('../services/platform.js')).ffmpegPath();
  const listFile = `${outputAbs}.tmp-list.txt`;
  fs.writeFileSync(
    listFile,
    inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listFile,
          '-ar',
          '48000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          outputAbs,
        ],
        { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Audio concatenation failed (ffmpeg exit ${String(code)}).`));
      });
    });
  } finally {
    tryUnlink(listFile);
  }
}
