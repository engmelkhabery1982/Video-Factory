/**
 * Persisted provider jobs, the per-session budget ledger, and capability state.
 *
 * - Jobs are JSON files under <dir>/jobs. Writes are atomic (temp file + rename).
 * - Budget reservations are made BEFORE a provider call and are never refunded,
 *   so failed attempts still count. This is the conservative choice.
 * - On startup, any job still `running` becomes `interrupted`. A restart never
 *   reports success.
 * - No secret is ever written to a job, the ledger, or the verification record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GEMINI_HARD_CAPS } from '@buildtrack/core';

export type JobKind = 'plan' | 'speech_preview';
export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface JobRecord {
  id: string;
  kind: JobKind;
  idempotencyKey: string;
  sessionId: string;
  status: JobStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  model: string;
  error: { code: string; message: string } | null;
  /** Non-secret input summary, for example the sha256 of the prompt or the text. */
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

export interface Budget {
  textRequests: number;
  voicePreviews: number;
  /** Production speech turns per session. Separate from the 2 verification previews. Default 0 (off). */
  productionTurns?: number;
  /** Paid still-image generations per session. Default 0 (off). Hard cap in visual-generation.ts. */
  imageStills?: number;
}

/** Hard ceiling for still-image generations per session. Config can lower it, never raise it. */
export const IMAGE_STILL_HARD_CAP = 4;

export interface VerificationRecord {
  checkedAt: string;
  sessionId: string;
  catalogReachable: boolean;
  /** Models and endpoint the evidence was recorded against. A different model or key does not inherit it. */
  endpoint: string | null;
  /** HMAC fingerprint of the credential that produced the evidence. Never the key. */
  credentialFingerprint: string | null;
  textModel: string | null;
  ttsModel: string | null;
  textGenerationOk: boolean;
  speechGenerationOk: boolean;
  /** Languages with a live generation recorded. Arabic and English are separate. */
  speechLanguagesLive: string[];
}

/** Effective cap for one ledger kind. Config can lower a cap, never raise it past the hard cap. */
export function productionCapOf(kind: 'text' | 'voice' | 'production' | 'image', caps: Budget): number {
  if (kind === 'text') return Math.min(caps.textRequests, GEMINI_HARD_CAPS.textRequests);
  if (kind === 'voice') return Math.min(caps.voicePreviews, GEMINI_HARD_CAPS.voicePreviews);
  if (kind === 'image') return Math.min(Math.max(0, caps.imageStills ?? 0), IMAGE_STILL_HARD_CAP);
  return Math.min(Math.max(0, caps.productionTurns ?? 0), GEMINI_HARD_CAPS.productionTurns);
}

export class ProviderStore {
  readonly dir: string;
  private readonly jobsDir: string;
  private readonly ledgerFile: string;
  private readonly controllers = new Map<string, AbortController>();

  constructor(dir: string) {
    this.dir = dir;
    this.jobsDir = path.join(dir, 'jobs');
    this.ledgerFile = path.join(dir, 'budget.json');
    fs.mkdirSync(this.jobsDir, { recursive: true });
    this.recoverInterrupted();
  }

  private jobPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid job id');
    return path.join(this.jobsDir, `${id}.json`);
  }

  private writeAtomic(file: string, data: string | Uint8Array) {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  getJob(id: string): JobRecord | null {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null; // malformed ids are simply not found
    let raw: string;
    try {
      raw = fs.readFileSync(this.jobPath(id), 'utf8');
    } catch {
      return null;
    }
    return JSON.parse(raw) as JobRecord;
  }

  saveJob(job: JobRecord) {
    this.writeAtomic(this.jobPath(job.id), JSON.stringify(job, null, 2));
  }

  listJobs(): JobRecord[] {
    return fs
      .readdirSync(this.jobsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.jobsDir, f), 'utf8')) as JobRecord);
  }

  findByKey(key: string): JobRecord | null {
    return this.listJobs().find((j) => j.idempotencyKey === key) ?? null;
  }

  newJob(input: Omit<JobRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'error' | 'result' | 'attempts'>): JobRecord {
    const now = new Date().toISOString();
    const job: JobRecord = { ...input, id: randomUUID(), status: 'running', attempts: 1, createdAt: now, updatedAt: now, error: null, result: null };
    this.saveJob(job);
    return job;
  }

  /** Registers the in-process controller so a cancel request can abort the call. */
  registerController(jobId: string): AbortController {
    const c = new AbortController();
    this.controllers.set(jobId, c);
    return c;
  }
  releaseController(jobId: string) {
    this.controllers.delete(jobId);
  }

  /** Cancels a running job. Returns the record. A late provider result is discarded by the runner. */
  cancelJob(id: string): JobRecord | null {
    const job = this.getJob(id);
    if (!job) return null;
    if (job.status !== 'running') return job;
    job.status = 'cancelled';
    job.error = { code: 'FACTORY_JOB_CANCELLED', message: 'The job was cancelled by the owner. Any late result was discarded.' };
    job.updatedAt = new Date().toISOString();
    this.saveJob(job);
    this.controllers.get(id)?.abort();
    return job;
  }

  /** A restart never claims success: running jobs become interrupted. */
  recoverInterrupted(): number {
    let n = 0;
    for (const job of this.listJobs()) {
      if (job.status === 'running') {
        job.status = 'interrupted';
        job.error = { code: 'FACTORY_JOB_INTERRUPTED', message: 'The server restarted before this job finished. Nothing was saved. Start the job again if you still need it.' };
        job.updatedAt = new Date().toISOString();
        this.saveJob(job);
        n++;
      }
    }
    return n;
  }

  // ---- budget ledger -------------------------------------------------------

  private readLedger(): Record<string, { text: number; voice: number; production?: number; image?: number }> {
    try {
      return JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8'));
    } catch {
      return {};
    }
  }

  /** Reserves one unit for a session. Returns false when the cap is reached. */
  reserve(sessionId: string, kind: 'text' | 'voice' | 'production' | 'image', caps: Budget): boolean {
    const ledger = this.readLedger();
    const row = ledger[sessionId] ?? { text: 0, voice: 0, production: 0 };
    const cap = productionCapOf(kind, caps);
    if ((row[kind] ?? 0) >= cap) return false;
    row[kind] = (row[kind] ?? 0) + 1;
    ledger[sessionId] = row;
    this.writeAtomic(this.ledgerFile, JSON.stringify(ledger, null, 2));
    return true;
  }

  usage(sessionId: string): { text: number; voice: number; production: number; image: number } {
    const row = this.readLedger()[sessionId];
    return { text: row?.text ?? 0, voice: row?.voice ?? 0, production: row?.production ?? 0, image: row?.image ?? 0 };
  }

  /** Remaining production turns for a session, without reserving any. */
  productionRemaining(sessionId: string, caps: Budget): number {
    return Math.max(0, productionCapOf('production', caps) - this.usage(sessionId).production);
  }

  // ---- verification record (written only by the Windows verify script) ----

  readVerification(file: string): VerificationRecord | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as VerificationRecord;
    } catch {
      return null;
    }
  }

  /** Writes a non-secret audio file (previews) under the store directory. */
  writeArtifact(name: string, data: Uint8Array): string {
    const dir = path.join(this.dir, 'artifacts');
    fs.mkdirSync(dir, { recursive: true });
    if (!/^[0-9a-f-]{36}\.wav$/.test(name)) throw new Error('invalid artifact name');
    const file = path.join(dir, name);
    this.writeAtomic(file, data);
    return file;
  }
  readArtifact(name: string): Buffer | null {
    if (!/^[0-9a-f-]{36}\.wav$/.test(name)) return null;
    try {
      return fs.readFileSync(path.join(this.dir, 'artifacts', name));
    } catch {
      return null;
    }
  }
}
