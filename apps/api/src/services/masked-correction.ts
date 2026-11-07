/**
 * G7: Masked / regional still correction contract.
 *
 * This module implements the ORIGINAL-PRESERVING mask/job/revision/provenance/
 * review/apply contract. The original still is NEVER destroyed — the runner
 * produces a corrected copy that is reviewed and applied separately.
 *
 * Statuses: pending → running → completed → reviewed → applied (or rejected).
 *
 * A mock runner (createMockRunner) verifies the integration ONLY. Real
 * correction requires an actual permitted engine (SD inpainting) on the owner
 * host and remains NOT RUN until that engine produces output.
 *
 * Labels: FIXTURE/RUNNER DOUBLE when the mock runner is used. NOT a real
 * engine output. The apply step binds via bindLocalImage (existing route).
 */
import { FactoryError } from '@buildtrack/core';
import { bindLocalImage, getDraft } from './factory-service.js';
import { createHash, randomBytes } from 'crypto';

export type MaskedCorrectionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'reviewed'
  | 'applied'
  | 'rejected';

export interface MaskedCorrectionParameters {
  /** Base64-encoded mask data (PNG or JSON mask descriptor). */
  maskData: string;
  /** Optional correction instructions. */
  instructions?: string;
}

export interface MaskedCorrectionJob {
  id: string;
  draftId: string;
  sceneId: string;
  status: MaskedCorrectionStatus;
  /** The original still's asset ID — never modified. */
  originalAssetId: string;
  /** SHA-256 of the original still bytes. */
  originalHash: string;
  /** SHA-256 of the mask data. */
  maskHash: string;
  parameters: MaskedCorrectionParameters;
  /** Result asset ID, once the runner completes. */
  resultAssetId: string | null;
  /** SHA-256 of the result bytes. */
  resultHash: string | null;
  /** Error detail if the runner failed. */
  error: string | null;
  /** True once the owner has reviewed (approved or rejected) the result. */
  reviewed: boolean;
  reviewNotes: string | null;
  /** Draft revision at job creation time. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MaskedCorrectionRunner {
  run(job: MaskedCorrectionJob): Promise<{ resultAssetId: string; resultHash: string }>;
}

/** In-memory job store. Jobs are ephemeral — not persisted across restarts. */
const jobs = new Map<string, MaskedCorrectionJob>();

let runner: MaskedCorrectionRunner | null = null;

export function setMaskedCorrectionRunner(r: MaskedCorrectionRunner | null): void {
  runner = r;
}

export function getMaskedCorrectionRunner(): MaskedCorrectionRunner {
  if (!runner) {
    throw new FactoryError('FACTORY_RUNNER_NOT_SET', 'No masked correction runner configured.', 503);
  }
  return runner;
}

/**
 * LABELLED MOCK RUNNER. This is NOT a real engine. It simulates the runner
 * protocol: it accepts a job, waits a short delay, and returns a result.
 * The result is a placeholder — real correction requires SD inpainting on
 * the owner host. Use this for integration tests ONLY.
 */
export function createMockRunner(opts?: {
  resultAssetId?: string;
  resultHash?: string;
  delayMs?: number;
  fail?: boolean;
}): MaskedCorrectionRunner {
  const delay = opts?.delayMs ?? 5;
  return {
    async run(job: MaskedCorrectionJob) {
      await new Promise(resolve => setTimeout(resolve, delay));
      if (opts?.fail) throw new Error('Mock runner forced failure');
      return {
        resultAssetId: opts?.resultAssetId ?? `masked-correction-${job.id}`,
        resultHash: opts?.resultHash ?? createHash('sha256').update(`mock-${job.id}`).digest('hex'),
      };
    },
  };
}

function hashString(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  return `mc-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

function saveJob(job: MaskedCorrectionJob): void {
  jobs.set(job.id, job);
}

function loadJob(jobId: string): MaskedCorrectionJob {
  const job = jobs.get(jobId);
  if (!job) throw new FactoryError('FACTORY_MASKED_CORRECTION_NOT_FOUND', 'Masked correction job not found.', 404);
  return job;
}

function updateJob(job: MaskedCorrectionJob, patch: Partial<MaskedCorrectionJob>): void {
  Object.assign(job, patch, { updatedAt: nowIso() });
  saveJob(job);
}

/**
 * Create a masked correction job. The original still is preserved (never
 * modified). The job starts in 'pending' and the runner is started
 * asynchronously. The HTTP response returns immediately with the job.
 */
export function createMaskedCorrection(
  draftId: string,
  sceneId: string,
  body: unknown,
): MaskedCorrectionJob {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  }
  const b = body as Record<string, unknown>;
  const expected = b.expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }
  const maskData = typeof b.maskData === 'string' ? b.maskData.trim() : '';
  if (!maskData) throw new FactoryError('FACTORY_VALIDATION', 'maskData is required.', 422);
  if (maskData.length > 5_000_000) {
    throw new FactoryError('FACTORY_VALIDATION', 'maskData is too large (max 5 MB).', 422);
  }
  const instructions = typeof b.instructions === 'string' ? b.instructions.trim().slice(0, 2000) : '';
  const originalAssetId = typeof b.originalAssetId === 'string' ? b.originalAssetId : '';
  const originalHash = typeof b.originalHash === 'string' ? b.originalHash : '';
  if (!originalAssetId) throw new FactoryError('FACTORY_VALIDATION', 'originalAssetId is required.', 422);
  if (!originalHash) throw new FactoryError('FACTORY_VALIDATION', 'originalHash is required.', 422);

  // Check draft revision
  const draft = getDraft(draftId);
  if (expected !== draft.revision) {
    throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload and create the correction again.', 409, { currentRevision: draft.revision });
  }

  const job: MaskedCorrectionJob = {
    id: makeId(),
    draftId,
    sceneId,
    status: 'pending',
    originalAssetId,
    originalHash,
    maskHash: hashString(maskData),
    parameters: { maskData, instructions: instructions || undefined },
    resultAssetId: null,
    resultHash: null,
    error: null,
    reviewed: false,
    reviewNotes: null,
    revision: expected,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  saveJob(job);

  // Start runner asynchronously (deferred so the job is returned as 'pending')
  setImmediate(() => void runJob(job));

  return job;
}

async function runJob(job: MaskedCorrectionJob): Promise<void> {
  try {
    updateJob(job, { status: 'running' });
    const result = await getMaskedCorrectionRunner().run(job);
    updateJob(job, {
      status: 'completed',
      resultAssetId: result.resultAssetId,
      resultHash: result.resultHash,
    });
  } catch (err) {
    updateJob(job, { status: 'failed', error: (err as Error)?.message ?? 'The correction runner failed.' });
  }
}

export function getMaskedCorrection(jobId: string): MaskedCorrectionJob {
  return loadJob(jobId);
}

export function listMaskedCorrections(draftId: string): MaskedCorrectionJob[] {
  return Array.from(jobs.values())
    .filter(j => j.draftId === draftId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Review a completed correction. The owner approves or rejects the result.
 * The original is never modified regardless of the review outcome.
 */
export function reviewMaskedCorrection(jobId: string, body: unknown): MaskedCorrectionJob {
  const job = loadJob(jobId);
  if (job.status !== 'completed') {
    throw new FactoryError('FACTORY_VALIDATION', 'Only a completed correction can be reviewed.', 422);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  }
  const b = body as Record<string, unknown>;
  const state = b.state;
  if (state !== 'approved' && state !== 'rejected') {
    throw new FactoryError('FACTORY_VALIDATION', 'state must be approved or rejected.', 422);
  }
  const notes = typeof b.notes === 'string' ? b.notes.slice(0, 2000) : '';
  updateJob(job, {
    status: state === 'approved' ? 'reviewed' : 'rejected',
    reviewed: true,
    reviewNotes: notes || null,
  });
  return job;
}

/**
 * Apply a reviewed correction. Binds the corrected still to the scene via
 * the existing bindLocalImage route. The original is preserved. The draft
 * revision is checked at apply time.
 */
export function applyMaskedCorrection(
  jobId: string,
  body: unknown,
): ReturnType<typeof bindLocalImage> {
  const job = loadJob(jobId);
  if (job.status !== 'reviewed') {
    throw new FactoryError('FACTORY_VALIDATION', 'Only a reviewed correction can be applied.', 422);
  }
  if (!job.resultAssetId || !job.resultHash) {
    throw new FactoryError('FACTORY_VALIDATION', 'The correction has no result to apply.', 422);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  }
  const b = body as Record<string, unknown>;
  const expected = b.expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }

  // Bind the corrected still to the scene via the existing route.
  // The original asset is untouched — only the scene's bound asset changes.
  const draft = bindLocalImage(job.draftId, {
    expectedRevision: expected,
    sceneId: job.sceneId,
    assetId: job.resultAssetId,
    sha256: job.resultHash,
    source: 'Masked correction (original preserved, corrected copy)',
    license: 'Operator owned correction',
  });

  updateJob(job, { status: 'applied' });
  return draft;
}

/** Reset the job store and runner for tests. */
export function resetMaskedCorrectionForTests(): void {
  jobs.clear();
  runner = null;
}
