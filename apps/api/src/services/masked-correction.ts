/**
 * G7 original-preserving masked/regional still correction.
 *
 * Durable job JSON lives beside the existing factory drafts. This is not a new
 * queue/database/provider: one configured local runner executes at a time and
 * every write goes through the canonical draft/asset contracts.
 *
 * Real runner output and MOCK/FIXTURE output are deliberately different evidence
 * labels. createMockRunner is a test double and is never registered by production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { FactoryError, type FactoryDraftEnvelope } from '@buildtrack/core';
import {
  bindMaskedCorrectionResult,
  getDraft,
  maskedCorrectionApplicationFor,
  maskedCorrectionTargetFor,
  readVerifiedFactoryImage,
} from './factory-service.js';
import { DATA_DIR } from './platform.js';
import {
  MASKED_CORRECTION_LIMITS,
  MaskedMaskError,
  encodeCanonicalMask,
  fingerprint,
  maskFingerprint,
  parseCanonicalMask,
  type CanonicalMask,
} from './masked-correction-contract.js';

export const MASKED_CORRECTION_JOBS_DIR = path.join(DATA_DIR, 'factory', 'masked-corrections', 'jobs');
const JOB_ID_RE = /^mc-[a-f0-9]{24}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type MaskedCorrectionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'reviewed'
  | 'applying'
  | 'applied'
  | 'rejected'
  | 'cancelled'
  | 'interrupted'
  | 'apply_interrupted';

export interface MaskedCorrectionParameters {
  /** Canonical base64 JSON descriptor (never an arbitrary non-empty string). */
  maskData: string;
  instructions?: string;
}

export interface MaskedCorrectionRunnerProvenance {
  id: string;
  version: string;
  fixture: boolean;
}

export interface MaskedCorrectionJob {
  schemaVersion: 1;
  id: string;
  draftId: string;
  sceneId: string;
  status: MaskedCorrectionStatus;
  originalAssetId: string;
  originalHash: string;
  original: { width: number; height: number; mimeType: string; source: string; license: string };
  maskHash: string;
  parameters: MaskedCorrectionParameters;
  targetFingerprint: string;
  inputFingerprint: string;
  reviewFingerprint: string | null;
  resultAssetId: string | null;
  /** Runner-declared value until Apply verifies the actual library bytes. */
  resultHash: string | null;
  resultVerification: 'pending' | 'verified' | 'failed';
  error: string | null;
  errorCode: string | null;
  reviewed: boolean;
  reviewNotes: string | null;
  revision: number;
  reviewedRevision: number | null;
  appliedRevision: number | null;
  idempotencyKey: string | null;
  attempts: number;
  maxAttempts: number;
  runId: string;
  runner: MaskedCorrectionRunnerProvenance;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  reviewedAt: string | null;
  applyStartedAt: string | null;
  appliedAt: string | null;
  /** Read-only display fields, computed from current canonical state. */
  targetCurrent?: boolean | null;
  targetIssue?: string | null;
}

export interface MaskedCorrectionRunnerContext {
  signal: AbortSignal;
  /** Canonical library path resolved by the server, never by the request. */
  originalPath: string;
  originalBytes: Buffer;
  mask: CanonicalMask;
}

export interface MaskedCorrectionRunner {
  readonly id?: string;
  readonly version?: string;
  readonly fixture?: boolean;
  readonly timeoutMs?: number;
  run(
    job: Readonly<MaskedCorrectionJob>,
    context: MaskedCorrectionRunnerContext,
  ): Promise<{ resultAssetId: string; resultHash: string }>;
}

let configuredRunner: MaskedCorrectionRunner | null = null;
let activeExecution: { jobId: string; runId: string; controller: AbortController } | null = null;

/** Production is always null. Used only by the real-route fault/recovery regression. */
export const maskedCorrectionTestHooks: { afterDraftBindBeforeJobSave: (() => void) | null } = {
  afterDraftBindBeforeJobSave: null,
};

const nowIso = () => new Date().toISOString();
const makeId = () => `mc-${randomBytes(12).toString('hex')}`;
const makeRunId = () => randomBytes(16).toString('hex');
const clone = <T>(value: T): T => structuredClone(value);

function jobFile(jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) throw new FactoryError('FACTORY_MASKED_CORRECTION_NOT_FOUND', 'Masked correction job not found.', 404);
  return path.join(MASKED_CORRECTION_JOBS_DIR, `${jobId}.json`);
}

function saveJob(job: MaskedCorrectionJob): void {
  fs.mkdirSync(MASKED_CORRECTION_JOBS_DIR, { recursive: true });
  const file = jobFile(job.id);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const serialized = JSON.stringify(job, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MASKED_CORRECTION_LIMITS.maxJobFileBytes) throw new Error('Masked correction job exceeds its durable file-size bound.');
    fs.writeFileSync(tmp, serialized, 'utf8');
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function loadJob(jobId: string): MaskedCorrectionJob {
  const file = jobFile(jobId);
  if (!fs.existsSync(file)) throw new FactoryError('FACTORY_MASKED_CORRECTION_NOT_FOUND', 'Masked correction job not found.', 404);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MASKED_CORRECTION_LIMITS.maxJobFileBytes) {
    throw new Error('Masked correction job state is not a bounded regular file.');
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as MaskedCorrectionJob;
  if (parsed.schemaVersion !== 1 || parsed.id !== jobId || typeof parsed.draftId !== 'string' || typeof parsed.sceneId !== 'string' || typeof parsed.runId !== 'string') {
    throw new Error('Masked correction job state is not readable.');
  }
  return parsed;
}

function storedJobs(): MaskedCorrectionJob[] {
  if (!fs.existsSync(MASKED_CORRECTION_JOBS_DIR)) return [];
  return fs.readdirSync(MASKED_CORRECTION_JOBS_DIR)
    .filter((name) => /^mc-[a-f0-9]{24}\.json$/.test(name))
    .sort()
    .map((name) => loadJob(name.slice(0, -5)));
}

function withFreshness(job: MaskedCorrectionJob): MaskedCorrectionJob {
  const out = clone(job);
  if (!['pending', 'running', 'completed', 'reviewed'].includes(out.status)) {
    out.targetCurrent = null;
    out.targetIssue = null;
    return out;
  }
  try {
    const target = maskedCorrectionTargetFor(out.draftId, out.sceneId);
    const current = target.originalAssetId === out.originalAssetId
      && target.originalHash === out.originalHash
      && target.targetFingerprint === out.targetFingerprint;
    out.targetCurrent = current;
    out.targetIssue = current ? null : 'The shot/original changed. This job is stale and cannot be applied.';
  } catch (err) {
    out.targetCurrent = false;
    out.targetIssue = err instanceof Error ? err.message : 'The current target could not be verified.';
  }
  return out;
}

function updateJob(jobId: string, runId: string | null, patch: Partial<MaskedCorrectionJob>): MaskedCorrectionJob {
  const current = loadJob(jobId);
  if (runId !== null && current.runId !== runId) return current;
  Object.assign(current, patch, { updatedAt: nowIso() });
  saveJob(current);
  return current;
}

export function setMaskedCorrectionRunner(next: MaskedCorrectionRunner | null): void {
  if (activeExecution) throw new FactoryError('FACTORY_DRAFT_BUSY', 'A masked correction is still running. Cancel or wait for it before changing its runner.', 409);
  configuredRunner = next;
}

export function getMaskedCorrectionRunner(): MaskedCorrectionRunner {
  if (!configuredRunner) {
    throw new FactoryError('FACTORY_RUNNER_NOT_SET', 'No masked correction runner is configured. Editing and validation remain available; no correction was started.', 503);
  }
  return configuredRunner;
}

function runnerProvenance(runner: MaskedCorrectionRunner): MaskedCorrectionRunnerProvenance {
  return { id: runner.id ?? 'configured-local-runner', version: runner.version ?? 'unversioned', fixture: runner.fixture === true };
}

export function maskedCorrectionReadiness() {
  const active = storedJobs().filter((job) => ['pending', 'running', 'applying'].includes(job.status));
  return {
    ready: configuredRunner !== null,
    runner: configuredRunner ? runnerProvenance(configuredRunner) : null,
    reason: configuredRunner
      ? (configuredRunner.fixture ? 'Labelled test double only. This is not a real inpainting engine.' : 'Configured local masked-correction runner.')
      : 'No masked correction runner configured. No job can start; mask editing and validation are still available.',
    jobsAtOnce: MASKED_CORRECTION_LIMITS.jobsAtOnce,
    busy: activeExecution !== null || active.length > 0,
    activeJobId: activeExecution?.jobId ?? active[0]?.id ?? null,
    limits: MASKED_CORRECTION_LIMITS,
  };
}

/** LABELLED TEST DOUBLE. Never called by server registration and refused in production. */
export function createMockRunner(opts: {
  resultAssetId?: string;
  resultHash?: string;
  delayMs?: number;
  fail?: boolean;
} = {}): MaskedCorrectionRunner {
  if (process.env.NODE_ENV === 'production') throw new Error('The masked-correction mock runner cannot run in production.');
  const delay = Math.max(0, Math.min(60_000, opts.delayMs ?? 5));
  return {
    id: 'labelled-mock-masked-correction',
    version: 'fixture-1',
    fixture: true,
    async run(job, context) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        context.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('The mock correction was aborted.'), { name: 'AbortError' }));
        }, { once: true });
      });
      if (opts.fail) throw new Error('Mock runner forced failure');
      return {
        resultAssetId: opts.resultAssetId ?? `missing-mock-result-${job.id}`,
        resultHash: opts.resultHash ?? '0'.repeat(64),
      };
    },
  };
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  }
  return body as Record<string, unknown>;
}

function expectedRevisionOf(body: Record<string, unknown>): number {
  const expected = body.expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }
  return expected;
}

function idempotencyKeyOf(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new FactoryError('FACTORY_VALIDATION', 'idempotencyKey must be 8–128 safe ASCII characters.', 422);
  }
  return value;
}

function reviewFingerprintOf(job: Pick<MaskedCorrectionJob, 'inputFingerprint' | 'resultAssetId' | 'resultHash'>): string {
  return fingerprint({ kind: 'vf-masked-review-v1', inputFingerprint: job.inputFingerprint, resultAssetId: job.resultAssetId, resultHash: job.resultHash });
}

/** The runner must import a distinct canonical asset and record this exact provenance. */
export function maskedCorrectionResultSource(job: Pick<MaskedCorrectionJob, 'id' | 'runId' | 'runner' | 'originalAssetId' | 'originalHash' | 'maskHash'>): string {
  return `Masked correction result; job=${job.id}; run=${job.runId}; runner=${job.runner.id}@${job.runner.version}; original=${job.originalAssetId}; originalSha256=${job.originalHash}; maskSha256=${job.maskHash}`;
}

function verifyMaskedResult(job: MaskedCorrectionJob): void {
  if (!job.resultAssetId || !job.resultHash) throw new FactoryError('FACTORY_ASSET_INVALID', 'The correction has no result asset to verify.', 422);
  const result = readVerifiedFactoryImage(job.resultAssetId, job.resultHash);
  if (result.width !== job.original.width || result.height !== job.original.height) {
    throw new FactoryError('FACTORY_ASSET_INVALID', 'The corrected image dimensions must exactly match the original.', 422);
  }
  if (job.resultAssetId === job.originalAssetId) {
    throw new FactoryError('FACTORY_ASSET_INVALID', 'The runner returned the original asset as its result. A distinct corrected copy is required.', 422);
  }
  const tags = result.asset.tags ?? [];
  if (!tags.includes('factory') || !tags.includes('masked-correction-result') || result.asset.source !== maskedCorrectionResultSource(job)) {
    throw new FactoryError('FACTORY_ASSET_INVALID', 'The result provenance does not match this exact job, run, original and mask. Import a distinct canonical result with masked-correction-result provenance.', 422);
  }
}

function assertActiveCapacity(): void {
  if (activeExecution) {
    throw new FactoryError('FACTORY_JOB_NOT_READY', 'Another masked correction is still active. Wait for it or cancel it before starting another.', 409, { details: { activeJobId: activeExecution.jobId } });
  }
  const active = storedJobs().find((job) => ['pending', 'running', 'applying'].includes(job.status));
  if (active) {
    throw new FactoryError('FACTORY_JOB_NOT_READY', 'Another masked correction needs recovery or cancellation before a new job can start.', 409, { details: { activeJobId: active.id } });
  }
}

export function createMaskedCorrection(draftId: string, sceneId: string, body: unknown): MaskedCorrectionJob {
  const b = bodyObject(body);
  const expected = expectedRevisionOf(b);
  const draft = getDraft(draftId);
  if (expected !== draft.revision) {
    throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload and create the correction again.', 409, { currentRevision: draft.revision });
  }
  const target = maskedCorrectionTargetFor(draftId, sceneId);
  const originalAssetId = typeof b.originalAssetId === 'string' ? b.originalAssetId : '';
  const originalHash = typeof b.originalHash === 'string' ? b.originalHash : '';
  if (!originalAssetId || !SHA256_RE.test(originalHash)) {
    throw new FactoryError('FACTORY_VALIDATION', 'originalAssetId and a lowercase SHA-256 originalHash are required.', 422);
  }
  if (originalAssetId !== target.originalAssetId || originalHash !== target.originalHash) {
    throw new FactoryError('FACTORY_SOURCE_CHANGED', 'The supplied original id/hash does not match the bound original bytes. Reload the current shot before correction.', 409, { details: { sceneId, assetId: originalAssetId } });
  }
  let mask: CanonicalMask;
  try {
    mask = parseCanonicalMask(b.maskData, { width: target.originalWidth, height: target.originalHeight });
  } catch (err) {
    if (err instanceof MaskedMaskError) throw new FactoryError('FACTORY_VALIDATION', err.message, 422);
    throw err;
  }
  const instructions = typeof b.instructions === 'string' ? b.instructions.trim() : '';
  if (instructions.length > MASKED_CORRECTION_LIMITS.maxInstructionChars) {
    throw new FactoryError('FACTORY_VALIDATION', `instructions must be at most ${MASKED_CORRECTION_LIMITS.maxInstructionChars} characters.`, 422);
  }
  const canonicalMaskData = encodeCanonicalMask(mask);
  const maskHash = maskFingerprint(mask);
  const inputFingerprint = fingerprint({ kind: 'vf-masked-input-v1', targetFingerprint: target.targetFingerprint, maskHash, instructions });
  const idempotencyKey = idempotencyKeyOf(b.idempotencyKey);
  const allJobs = storedJobs();
  const existingJobs = allJobs.filter((job) => job.draftId === draftId);
  if (idempotencyKey) {
    const existing = existingJobs.find((job) => job.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.inputFingerprint !== inputFingerprint || existing.sceneId !== sceneId) {
        throw new FactoryError('FACTORY_REVISION_CONFLICT', 'This idempotencyKey was already used for different correction inputs.', 409);
      }
      return withFreshness(existing);
    }
  }
  const runner = getMaskedCorrectionRunner();
  assertActiveCapacity();
  if (allJobs.length >= MASKED_CORRECTION_LIMITS.maxTotalJobs) {
    throw new FactoryError('FACTORY_BUDGET_EXHAUSTED', `The local correction store has ${MASKED_CORRECTION_LIMITS.maxTotalJobs} jobs. Clean up terminal jobs before creating another.`, 429);
  }
  if (existingJobs.length >= MASKED_CORRECTION_LIMITS.maxJobsPerDraft) {
    throw new FactoryError('FACTORY_BUDGET_EXHAUSTED', `This draft has ${MASKED_CORRECTION_LIMITS.maxJobsPerDraft} stored correction jobs. Clean up terminal jobs before creating another.`, 429);
  }
  const stamp = nowIso();
  let jobId = makeId();
  for (let attempt = 0; fs.existsSync(jobFile(jobId)) && attempt < 4; attempt += 1) jobId = makeId();
  if (fs.existsSync(jobFile(jobId))) throw new Error('Could not allocate a distinct masked-correction job id.');
  const job: MaskedCorrectionJob = {
    schemaVersion: 1,
    id: jobId,
    draftId,
    sceneId,
    status: 'pending',
    originalAssetId: target.originalAssetId,
    originalHash: target.originalHash,
    original: {
      width: target.originalWidth,
      height: target.originalHeight,
      mimeType: target.originalMimeType,
      source: target.originalSource,
      license: target.originalLicense,
    },
    maskHash,
    parameters: { maskData: canonicalMaskData, ...(instructions ? { instructions } : {}) },
    targetFingerprint: target.targetFingerprint,
    inputFingerprint,
    reviewFingerprint: null,
    resultAssetId: null,
    resultHash: null,
    resultVerification: 'pending',
    error: null,
    errorCode: null,
    reviewed: false,
    reviewNotes: null,
    revision: expected,
    reviewedRevision: null,
    appliedRevision: null,
    idempotencyKey,
    attempts: 1,
    maxAttempts: MASKED_CORRECTION_LIMITS.maxAttempts,
    runId: makeRunId(),
    runner: runnerProvenance(runner),
    createdAt: stamp,
    updatedAt: stamp,
    startedAt: null,
    completedAt: null,
    reviewedAt: null,
    applyStartedAt: null,
    appliedAt: null,
  };
  saveJob(job);
  setImmediate(() => { void runJob(job.id, job.runId); });
  return withFreshness(job);
}

async function runJob(jobId: string, runId: string): Promise<void> {
  let job = loadJob(jobId);
  if (job.status !== 'pending' || job.runId !== runId || activeExecution) return;
  const controller = new AbortController();
  activeExecution = { jobId, runId, controller };
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const runner = getMaskedCorrectionRunner();
    job = updateJob(jobId, runId, { status: 'running', startedAt: nowIso(), error: null, errorCode: null });
    const original = readVerifiedFactoryImage(job.originalAssetId, job.originalHash);
    const mask = parseCanonicalMask(job.parameters.maskData, original);
    const timeoutMs = Math.max(1000, Math.min(MASKED_CORRECTION_LIMITS.runnerTimeoutMs, runner.timeoutMs ?? MASKED_CORRECTION_LIMITS.runnerTimeoutMs));
    const execution = runner.run(clone(job), { signal: controller.signal, originalPath: original.file, originalBytes: original.bytes, mask });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new FactoryError('FACTORY_PROVIDER_TIMEOUT', `The correction did not finish within ${Math.round(timeoutMs / 1000)} seconds. Its late result will not be accepted.`, 504));
      }, timeoutMs);
    });
    const result = await Promise.race([execution, timeout]);
    job = loadJob(jobId);
    if (job.runId !== runId || job.status !== 'running') return; // cancelled/replaced: late result is ignored
    if (typeof result.resultAssetId !== 'string' || !result.resultAssetId || !SHA256_RE.test(result.resultHash)) {
      throw new FactoryError('FACTORY_ASSET_INVALID', 'The runner returned an invalid result id or SHA-256. Nothing was applied.', 422);
    }
    if (result.resultAssetId === job.originalAssetId) {
      throw new FactoryError('FACTORY_ASSET_INVALID', 'The runner returned the original asset as its result. A distinct corrected copy is required.', 422);
    }
    job = updateJob(jobId, runId, {
      resultAssetId: result.resultAssetId,
      resultHash: result.resultHash,
      resultVerification: 'pending',
    });
    // Reject an unrelated index entry, false declared hash, changed bytes, bad dimensions,
    // or provenance from another job before this run can become reviewable.
    verifyMaskedResult(job);
    updateJob(jobId, runId, {
      status: 'completed',
      resultVerification: 'verified',
      completedAt: nowIso(),
      error: null,
      errorCode: null,
    });
  } catch (err) {
    const current = loadJob(jobId);
    if (current.runId !== runId || current.status !== 'running') return;
    const error = err as Error & { code?: string };
    updateJob(jobId, runId, {
      status: 'failed',
      error: error?.message ?? 'The correction runner failed.',
      errorCode: typeof error?.code === 'string' ? error.code : 'FACTORY_MASKED_CORRECTION_FAILED',
      resultVerification: current.resultAssetId ? 'failed' : current.resultVerification,
      completedAt: nowIso(),
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (activeExecution?.jobId === jobId && activeExecution.runId === runId) activeExecution = null;
  }
}

export function getMaskedCorrection(jobId: string): MaskedCorrectionJob {
  return withFreshness(loadJob(jobId));
}

export function listMaskedCorrections(draftId: string): MaskedCorrectionJob[] {
  getDraft(draftId);
  return storedJobs()
    .filter((job) => job.draftId === draftId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(withFreshness);
}

export function cancelMaskedCorrection(jobId: string): MaskedCorrectionJob {
  const job = loadJob(jobId);
  if (job.status !== 'pending' && job.status !== 'running') {
    throw new FactoryError('FACTORY_JOB_NOT_READY', `This correction is ${job.status}; there is nothing to cancel.`, 409);
  }
  const nextRunId = makeRunId(); // invalidates every late runner completion
  const cancelled = updateJob(jobId, job.runId, {
    status: 'cancelled',
    runId: nextRunId,
    error: 'Cancelled by the operator. No result was applied.',
    errorCode: 'FACTORY_JOB_CANCELLED',
    completedAt: nowIso(),
  });
  if (activeExecution?.jobId === jobId) activeExecution.controller.abort();
  return withFreshness(cancelled);
}

export function retryMaskedCorrection(jobId: string): MaskedCorrectionJob {
  const job = loadJob(jobId);
  if (!['failed', 'cancelled', 'interrupted', 'rejected'].includes(job.status)) {
    throw new FactoryError('FACTORY_JOB_NOT_READY', 'Only a failed, cancelled, interrupted or rejected correction can be retried.', 409);
  }
  if (job.attempts >= job.maxAttempts) {
    throw new FactoryError('FACTORY_BUDGET_EXHAUSTED', `This correction already used its ${job.maxAttempts} attempts. Create a new correction explicitly.`, 429);
  }
  const target = maskedCorrectionTargetFor(job.draftId, job.sceneId);
  if (target.originalAssetId !== job.originalAssetId || target.originalHash !== job.originalHash || target.targetFingerprint !== job.targetFingerprint) {
    throw new FactoryError('FACTORY_CANDIDATE_STALE', 'The original target changed. Create a new correction rather than retrying the stale job.', 409);
  }
  const runner = getMaskedCorrectionRunner();
  assertActiveCapacity();
  const runId = makeRunId();
  const next = updateJob(jobId, null, {
    status: 'pending',
    runId,
    runner: runnerProvenance(runner),
    attempts: job.attempts + 1,
    resultAssetId: null,
    resultHash: null,
    resultVerification: 'pending',
    error: null,
    errorCode: null,
    reviewed: false,
    reviewNotes: null,
    reviewFingerprint: null,
    reviewedRevision: null,
    reviewedAt: null,
    startedAt: null,
    completedAt: null,
    applyStartedAt: null,
    appliedAt: null,
    appliedRevision: null,
  });
  setImmediate(() => { void runJob(jobId, runId); });
  return withFreshness(next);
}

export function reviewMaskedCorrection(jobId: string, body: unknown): MaskedCorrectionJob {
  const b = bodyObject(body);
  const state = b.state;
  if (state !== 'approved' && state !== 'rejected') {
    throw new FactoryError('FACTORY_VALIDATION', 'state must be approved or rejected.', 422);
  }
  const notes = typeof b.notes === 'string' ? b.notes.trim() : '';
  if (notes.length > 2000) throw new FactoryError('FACTORY_VALIDATION', 'notes must be at most 2000 characters.', 422);
  const job = loadJob(jobId);
  if (job.status !== 'completed') {
    throw new FactoryError('FACTORY_VALIDATION', 'Only a completed correction can be reviewed.', 422);
  }
  if (!job.resultAssetId || !job.resultHash) throw new FactoryError('FACTORY_ASSET_INVALID', 'The correction has no result to review.', 422);
  const target = maskedCorrectionTargetFor(job.draftId, job.sceneId);
  if (target.originalAssetId !== job.originalAssetId || target.originalHash !== job.originalHash || target.targetFingerprint !== job.targetFingerprint) {
    throw new FactoryError('FACTORY_CANDIDATE_STALE', 'The shot/original changed before review. This result cannot be approved for the newer target.', 409);
  }
  try {
    verifyMaskedResult(job);
  } catch (err) {
    updateJob(jobId, null, { status: 'failed', resultVerification: 'failed', error: (err as Error).message, errorCode: (err as { code?: string }).code ?? 'FACTORY_ASSET_INVALID' });
    throw err;
  }
  const stamp = nowIso();
  const reviewed = updateJob(jobId, null, {
    status: state === 'approved' ? 'reviewed' : 'rejected',
    reviewed: true,
    resultVerification: 'verified',
    reviewNotes: notes || null,
    reviewFingerprint: state === 'approved' ? reviewFingerprintOf(job) : null,
    reviewedRevision: getDraft(job.draftId).revision,
    reviewedAt: stamp,
    error: null,
    errorCode: null,
  });
  return withFreshness(reviewed);
}

function validateExpectedForApplied(job: MaskedCorrectionJob, expected: number, currentRevision: number, appliedRevision: number): void {
  if (expected !== currentRevision && expected !== appliedRevision && expected !== appliedRevision - 1) {
    throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The supplied revision does not match this applied correction or the current draft.', 409, { currentRevision });
  }
}

function reconcileApplied(job: MaskedCorrectionJob, expected: number): FactoryDraftEnvelope {
  const marker = maskedCorrectionApplicationFor(job.draftId, job.id);
  if (!marker
    || marker.resultAssetId !== job.resultAssetId
    || marker.resultHash !== job.resultHash
    || marker.targetFingerprint !== job.targetFingerprint
    || marker.reviewFingerprint !== job.reviewFingerprint) {
    updateJob(job.id, null, { status: 'apply_interrupted', error: 'The draft has no matching atomic Apply marker. Automatic rebind is refused to prevent a double-apply.', errorCode: 'FACTORY_CANDIDATE_STALE' });
    throw new FactoryError('FACTORY_CANDIDATE_STALE', 'The correction Apply could not be reconciled with an atomic draft marker. No automatic second bind was attempted.', 409);
  }
  validateExpectedForApplied(job, expected, marker.revision, marker.appliedRevision);
  if (job.status !== 'applied' || job.appliedRevision !== marker.appliedRevision) {
    updateJob(job.id, null, { status: 'applied', appliedRevision: marker.appliedRevision, appliedAt: marker.appliedAt, resultVerification: 'verified', error: null, errorCode: null });
  }
  return getDraft(job.draftId);
}

export function applyMaskedCorrection(jobId: string, body: unknown): FactoryDraftEnvelope {
  const b = bodyObject(body);
  const expected = expectedRevisionOf(b);
  let job = loadJob(jobId);
  if (job.status === 'applied' || job.status === 'applying' || job.status === 'apply_interrupted') {
    return reconcileApplied(job, expected);
  }
  if (job.status !== 'reviewed') {
    throw new FactoryError('FACTORY_VALIDATION', 'Only an approved reviewed correction can be applied.', 422);
  }
  if (!job.resultAssetId || !job.resultHash || !job.reviewFingerprint) {
    throw new FactoryError('FACTORY_VALIDATION', 'The correction has no reviewed result to apply.', 422);
  }
  if (job.reviewFingerprint !== reviewFingerprintOf(job)) {
    throw new FactoryError('FACTORY_CANDIDATE_STALE', 'The result or review fingerprint changed after approval. Review the correction again.', 409);
  }
  try {
    verifyMaskedResult(job);
  } catch (err) {
    updateJob(jobId, null, { resultVerification: 'failed', error: (err as Error).message, errorCode: (err as { code?: string }).code ?? 'FACTORY_ASSET_INVALID' });
    throw err;
  }
  // Persist intent BEFORE binding. A later job-file failure therefore leaves an applying record,
  // while the atomic draft marker written by bindMaskedCorrectionResult proves whether bind committed.
  job = updateJob(jobId, null, { status: 'applying', applyStartedAt: nowIso(), error: null, errorCode: null });
  let draft: FactoryDraftEnvelope;
  try {
    draft = bindMaskedCorrectionResult(job.draftId, {
      jobId: job.id,
      reviewFingerprint: job.reviewFingerprint,
      expectedRevision: expected,
      sceneId: job.sceneId,
      originalAssetId: job.originalAssetId,
      originalHash: job.originalHash,
      targetFingerprint: job.targetFingerprint,
      resultAssetId: job.resultAssetId,
      resultHash: job.resultHash,
    });
  } catch (err) {
    // No draft marker means bind did not commit; returning to reviewed makes an explicit retry safe.
    const marker = maskedCorrectionApplicationFor(job.draftId, job.id);
    if (!marker) updateJob(jobId, null, { status: 'reviewed', error: (err as Error).message, errorCode: (err as { code?: string }).code ?? 'FACTORY_VALIDATION' });
    throw err;
  }
  maskedCorrectionTestHooks.afterDraftBindBeforeJobSave?.();
  updateJob(jobId, null, {
    status: 'applied',
    resultVerification: 'verified',
    appliedRevision: draft.revision,
    appliedAt: nowIso(),
    error: null,
    errorCode: null,
  });
  return draft;
}

/** Delete only terminal, unapplied metadata. Never deletes an asset or changes a draft. */
export function deleteMaskedCorrection(jobId: string): { deleted: true; jobId: string } {
  const job = loadJob(jobId);
  if (!['failed', 'cancelled', 'interrupted', 'rejected', 'completed'].includes(job.status)) {
    throw new FactoryError('FACTORY_JOB_NOT_READY', 'Only an unapplied terminal or unreviewed correction can be cleaned up.', 409);
  }
  fs.rmSync(jobFile(jobId));
  return { deleted: true, jobId };
}

/** Mark interrupted work honestly; finalize only exact atomic Apply markers. */
export function recoverMaskedCorrectionJobs(): void {
  for (const job of storedJobs()) {
    if (job.status === 'pending' || job.status === 'running') {
      updateJob(job.id, null, {
        status: 'interrupted',
        runId: makeRunId(),
        error: 'The server stopped before this correction finished. No missing output is claimed; retry explicitly.',
        errorCode: 'FACTORY_JOB_NOT_READY',
        completedAt: nowIso(),
      });
      continue;
    }
    if (job.status !== 'applying' && job.status !== 'apply_interrupted') continue;
    try {
      const marker = maskedCorrectionApplicationFor(job.draftId, job.id);
      if (marker && marker.reviewFingerprint === job.reviewFingerprint && marker.resultAssetId === job.resultAssetId && marker.resultHash === job.resultHash) {
        verifyMaskedResult(job);
        updateJob(job.id, null, { status: 'applied', appliedRevision: marker.appliedRevision, appliedAt: marker.appliedAt, resultVerification: 'verified', error: null, errorCode: null });
      } else if (job.status === 'applying') {
        updateJob(job.id, null, { status: 'reviewed', error: 'The server stopped before the draft Apply committed. No binding occurred; explicit retry is safe.', errorCode: 'FACTORY_JOB_NOT_READY' });
      }
    } catch {
      updateJob(job.id, null, { status: 'apply_interrupted', error: 'Apply recovery needs operator review. No second bind was attempted.', errorCode: 'FACTORY_JOB_NOT_READY' });
    }
  }
}

/** Test seam: abort the in-process double and unregister it. Durable jobs are deliberately retained. */
export function resetMaskedCorrectionForTests(): void {
  activeExecution?.controller.abort();
  activeExecution = null;
  configuredRunner = null;
  maskedCorrectionTestHooks.afterDraftBindBeforeJobSave = null;
}
