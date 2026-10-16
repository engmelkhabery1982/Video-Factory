/**
 * Local transcription of supplied audio, for audio-only drafts. Separate from forced alignment.
 *
 * Contract (the owner's local runtime must satisfy it; nothing is installed or downloaded here):
 *   VF_TRANSCRIBE_COMMAND   JSON array: launcher and fixed leading args of an independent transcriber.
 *                           It is started as: <command...> <audioFile> <outFile>.
 *   VF_TRANSCRIBE_TIMEOUT_SEC  optional; 60..7200, default 1800.
 *   The runner writes <outFile> as JSON:
 *     { "transcript": "...", "audioSha256": "<hex of the audio file>",
 *       "engine": "<id>", "provenance": { "method": "greedy_ctc" | "fixture_stand_in",
 *         "independentOfScript": true, "scriptCopied": false, "fixture": false, "emissionsSha256": "<hex>" } }
 *   and may print lines "PROGRESS <0..1>" on stdout.
 *
 * Rules:
 *  - A transcript is text only. It is never word timing, and it is never alignment.
 *  - It is accepted only when the runner names this exact audio (hash) and says it was not copied from a script.
 *  - A fixture stand-in is accepted only with VF_ALLOW_FIXTURE_TRANSCRIPT=1 (tests), and is labelled as a fixture.
 *  - Google is never a transcription engine here.
 *  - A canceled or late result never replaces the job state.
 *  - Nothing is claimed until the owner reviews the text. Only the reviewed text can feed planning.
 *
 * The vf-align runtime is not used: its runner forces a known script onto audio. Its transcript side output is
 * accepted only through its own provenance check (vf-align-worker.ts), never as a transcription mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { DATA_DIR } from './platform.js';

export const TRANSCRIPTS_DIR = path.join(DATA_DIR, 'factory', 'transcripts');
const JOB_ID_RE = /^trs_[a-f0-9]{16}$/;

export type TranscriptionStatus = 'unavailable' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';

export interface TranscriptionProvenance {
  method: 'greedy_ctc' | 'fixture_stand_in';
  fixture: boolean;
  independentOfScript: true;
  audioSha256: string;
  emissionsSha256: string | null;
  engine: string;
}

export interface TranscriptionJob {
  schemaVersion: 1;
  jobId: string;
  audioAssetId: string;
  audioSha256: string;
  audioDurationSec: number;
  status: TranscriptionStatus;
  /** 0..1 while running; null when unknown. */
  progress: number | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  /** Text the runner produced. Not reviewed, so not used for planning. */
  transcript: string | null;
  provenance: TranscriptionProvenance | null;
  /** Owner-reviewed text. Only this feeds planning, and only while the audio hash still matches. */
  reviewedText: string | null;
  reviewedAt: string | null;
  /** Job revision, bumped on each change. Review must name it. */
  revision: number;
}

export interface TranscriptionCapability {
  available: boolean;
  reason: string;
  /** Runner launcher, when configured. Never includes secrets; paths are the owner's own. */
  configured: boolean;
  timeoutSec: number;
}

const UNAVAILABLE_REASON =
  'No local transcription runtime is configured (VF_TRANSCRIBE_COMMAND is not set). Nothing was installed or downloaded. Supply the reviewed script or storyboard, or run transcription on the owner machine.';

export function transcriptionCapability(env: NodeJS.ProcessEnv = process.env): TranscriptionCapability {
  const timeoutRaw = Number(env.VF_TRANSCRIBE_TIMEOUT_SEC ?? 1800);
  const timeoutSec = Number.isFinite(timeoutRaw) && timeoutRaw >= 60 && timeoutRaw <= 7200 ? timeoutRaw : 1800;
  const argv = parseCommand(env);
  if (!argv) return { available: false, reason: UNAVAILABLE_REASON, configured: false, timeoutSec };
  return {
    available: true,
    reason: 'A local transcription runner is configured. It is used only when you start a job. Its output is reviewed before any use.',
    configured: true,
    timeoutSec,
  };
}

function parseCommand(env: NodeJS.ProcessEnv): string[] | null {
  const raw = (env.VF_TRANSCRIBE_COMMAND ?? '').trim();
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x.length > 0)) return null;
    return v as string[];
  } catch {
    return null;
  }
}

const now = () => new Date().toISOString();
const sha256Hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Running children, by job id. A child is removed when it exits or is canceled. */
const children = new Map<string, ChildProcess>();

function jobFile(jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) throw new Error('bad job id');
  return path.join(TRANSCRIPTS_DIR, `${jobId}.json`);
}

export function saveJob(job: TranscriptionJob): void {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const tmp = `${jobFile(job.jobId)}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');
  fs.renameSync(tmp, jobFile(job.jobId));
}

/** Read a job. A job left running by a previous process is marked interrupted: no result is assumed. */
export function loadJob(jobId: string): TranscriptionJob | null {
  if (!JOB_ID_RE.test(jobId)) return null;
  const file = jobFile(jobId);
  if (!fs.existsSync(file)) return null;
  const job = JSON.parse(fs.readFileSync(file, 'utf8')) as TranscriptionJob;
  if ((job.status === 'running' || job.status === 'queued') && !children.has(job.jobId)) {
    job.status = 'interrupted';
    job.reason = 'The job was running when the API stopped. No transcript was assumed. Start a new job.';
    job.progress = null;
    job.revision += 1;
    job.updatedAt = now();
    saveJob(job);
  }
  return job;
}

/**
 * Read a job exactly as stored. Used only where the runner's own exit is being applied: the child has already
 * left `children`, so loadJob would mistake the live job for one left by a previous process.
 */
function readJobRaw(jobId: string): TranscriptionJob | null {
  if (!JOB_ID_RE.test(jobId)) return null;
  const file = jobFile(jobId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TranscriptionJob;
}

export interface StartInput {
  audioAssetId: string;
  audioFile: string;
  audioDurationSec: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Create a job. Without a configured runner it is recorded as `unavailable` and nothing runs. With one, the
 * runner starts in the background; poll with loadJob, cancel with cancelJob.
 */
export function startJob(input: StartInput): { job: TranscriptionJob; created: boolean } {
  const env = input.env ?? process.env;
  const capability = transcriptionCapability(env);
  const audioBytes = fs.readFileSync(input.audioFile);
  const audioSha256 = sha256Hex(audioBytes);
  // One running job per audio: a repeated request returns the running job instead of starting another runner.
  for (const jobId of children.keys()) {
    const active = loadJob(jobId);
    if (active && active.audioSha256 === audioSha256 && (active.status === 'running' || active.status === 'queued')) {
      return { job: active, created: false };
    }
  }
  const stamp = now();
  const job: TranscriptionJob = {
    schemaVersion: 1,
    jobId: `trs_${randomBytes(8).toString('hex')}`,
    audioAssetId: input.audioAssetId,
    audioSha256,
    audioDurationSec: input.audioDurationSec,
    status: capability.available ? 'queued' : 'unavailable',
    progress: null,
    reason: capability.available ? null : capability.reason,
    createdAt: stamp,
    updatedAt: stamp,
    transcript: null,
    provenance: null,
    reviewedText: null,
    reviewedAt: null,
    revision: 0,
  };
  saveJob(job);
  if (!capability.available) return { job, created: true };
  const argv = parseCommand(env) as string[];
  const outFile = path.join(TRANSCRIPTS_DIR, `${job.jobId}.out.json`);
  const [cmd, ...lead] = argv;
  const child = spawn(cmd, [...lead, input.audioFile, outFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, VF_TRANSCRIBE_OUT: outFile },
    windowsHide: true,
  });
  children.set(job.jobId, child);
  job.status = 'running';
  job.updatedAt = now();
  job.revision += 1;
  saveJob(job);

  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    const m = /PROGRESS\s+([01](?:\.\d+)?)/g;
    let hit: RegExpExecArray | null;
    let last: number | null = null;
    while ((hit = m.exec(stdout)) !== null) last = Number(hit[1]);
    const current = loadJob(job.jobId);
    if (last !== null && current && current.status === 'running') {
      current.progress = last;
      current.revision += 1;
      current.updatedAt = now();
      saveJob(current);
    }
  });
  child.stderr.on('data', () => {
    // Runner diagnostics stay out of the API response. Nothing is echoed.
  });
  const timer = setTimeout(() => {
    if (children.get(job.jobId) === child) child.kill('SIGTERM');
  }, capability.timeoutSec * 1000);
  child.on('close', (code) => {
    clearTimeout(timer);
    children.delete(job.jobId);
    finish(job.jobId, code, outFile, audioSha256, env);
  });
  return { job, created: true };
}

/** Applies the runner's output to the job, only if the job is still running. Late answers are ignored. */
function finish(jobId: string, code: number | null, outFile: string, audioSha256: string, env: NodeJS.ProcessEnv): void {
  const job = readJobRaw(jobId);
  if (!job || job.status !== 'running') {
    fs.rmSync(outFile, { force: true });
    return;
  }
  const fail = (reason: string) => {
    job.status = 'failed';
    job.reason = reason;
    job.progress = null;
    job.revision += 1;
    job.updatedAt = now();
    saveJob(job);
  };
  try {
    if (code !== 0 || !fs.existsSync(outFile)) return fail('The transcription runner did not produce a result. No transcript was used.');
    const parsed = parseRunnerOutput(JSON.parse(fs.readFileSync(outFile, 'utf8')), audioSha256, env);
    if (typeof parsed === 'string') return fail(parsed);
    job.status = 'succeeded';
    job.transcript = parsed.transcript;
    job.provenance = parsed.provenance;
    job.reason = parsed.provenance.fixture ? 'FIXTURE stand-in transcript (tests only). Not a real transcription.' : null;
    job.progress = 1;
    job.revision += 1;
    job.updatedAt = now();
    saveJob(job);
  } catch {
    fail('The transcription runner wrote an unreadable result. No transcript was used.');
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

/** Shape and provenance check. Returns the accepted transcript or the reason it was refused. */
export function parseRunnerOutput(
  raw: unknown,
  audioSha256: string,
  env: NodeJS.ProcessEnv = process.env,
): { transcript: string; provenance: TranscriptionProvenance } | string {
  if (!raw || typeof raw !== 'object') return 'The runner result is not an object. No transcript was used.';
  const r = raw as Record<string, unknown>;
  if (typeof r.transcript !== 'string' || r.transcript.trim().length === 0) return 'The runner returned no transcript text.';
  if (r.audioSha256 !== audioSha256) return 'The runner result names other audio. No transcript was used.';
  const p = (r.provenance ?? null) as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return 'The runner result has no provenance. No transcript was used.';
  if (p.independentOfScript !== true || p.scriptCopied === true) {
    return 'The transcript is not an independent decode of this audio. No transcript was used.';
  }
  const fixture = p.fixture === true;
  if (fixture && env.VF_ALLOW_FIXTURE_TRANSCRIPT !== '1') {
    return 'A fixture transcript is accepted only in tests. No transcript was used.';
  }
  if (p.method !== 'greedy_ctc' && p.method !== 'fixture_stand_in') return 'The transcription method is not accepted here. No transcript was used.';
  if (p.method === 'greedy_ctc' && (typeof p.emissionsSha256 !== 'string' || p.emissionsSha256.length === 0)) {
    return 'The transcript names no emissions. No transcript was used.';
  }
  return {
    transcript: r.transcript,
    provenance: {
      method: p.method,
      fixture,
      independentOfScript: true,
      audioSha256,
      emissionsSha256: typeof p.emissionsSha256 === 'string' ? p.emissionsSha256 : null,
      engine: typeof r.engine === 'string' ? r.engine.slice(0, 80) : 'unnamed',
    },
  };
}

export class TranscriptionRefused extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

/** Cancel a running job. Its late output is discarded. Finished jobs are not changed. */
export function cancelJob(jobId: string): TranscriptionJob {
  const job = loadJob(jobId);
  if (!job) throw new TranscriptionRefused('FACTORY_TRANSCRIPTION_NOT_FOUND', 'No such transcription job.', 404);
  if (job.status !== 'running' && job.status !== 'queued') {
    throw new TranscriptionRefused('FACTORY_TRANSCRIPTION_NOT_RUNNING', `This job is ${job.status}. Nothing to cancel.`, 409);
  }
  const child = children.get(job.jobId);
  children.delete(job.jobId);
  if (child) child.kill('SIGTERM');
  job.status = 'canceled';
  job.reason = 'Canceled by the owner. Any late output from the runner is discarded.';
  job.progress = null;
  job.revision += 1;
  job.updatedAt = now();
  saveJob(job);
  return job;
}

/** Review: the owner accepts or edits the transcript text. Revision-checked. Never changes timing. */
export function reviewJob(jobId: string, text: string, expectedRevision: number): TranscriptionJob {
  const job = loadJob(jobId);
  if (!job) throw new TranscriptionRefused('FACTORY_TRANSCRIPTION_NOT_FOUND', 'No such transcription job.', 404);
  if (job.revision !== expectedRevision) {
    throw new TranscriptionRefused('FACTORY_REVISION_CONFLICT', 'The transcript changed since you loaded it. Reload and review again.', 409);
  }
  if (job.status !== 'succeeded') {
    throw new TranscriptionRefused('FACTORY_TRANSCRIPTION_NOT_READY', `This job is ${job.status}. Only a succeeded transcript can be reviewed.`, 422);
  }
  const clean = text.trim();
  if (clean.length === 0) throw new TranscriptionRefused('FACTORY_VALIDATION', 'The reviewed transcript is empty.', 422);
  if (clean.length > 20000) throw new TranscriptionRefused('FACTORY_VALIDATION', 'The reviewed transcript is longer than 20000 characters.', 422);
  job.reviewedText = clean;
  job.reviewedAt = now();
  job.revision += 1;
  job.updatedAt = now();
  saveJob(job);
  return job;
}

/** Test support: forget running children without killing them (used by test teardown only). */
export function _resetChildrenForTests(): void {
  for (const c of children.values()) c.kill('SIGTERM');
  children.clear();
}
