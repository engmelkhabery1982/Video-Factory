/**
 * VS7 — plan for the later manual outside-narration acceptance.
 *
 * This module does not import audio, re-approve listening or timing, start a
 * workflow, or render. A person imports the recording, listens, and approves
 * timing in the browser first. The later command may only:
 *
 *   1. reject an inside-repo, symlink, or voice-audio path;
 *   2. require a measured duration inside an explicit finite bound
 *      (20–30 seconds unless --duration-min and --duration-max are set);
 *   3. compare that file's digest with the stored import SHA-256;
 *   4. require the stored gate to be ready to attempt export, and still not
 *      publication approved;
 *   5. send one `POST /api/projects/:id/export` with
 *      `{ kind: 'final', includeShorts: false }` and no QC override;
 *   6. poll `GET /api/jobs/:jobId`;
 *   7. stop on HTTP 409. No retry, and no override.
 *
 * Diagnostics never include an absolute path. Nothing here is invoked by a
 * workflow. Running this file without `--confirm-single-export` does not
 * contact the export endpoint.
 *
 * The later authorized recording is a Gemini narration of 58.84 seconds
 * (`rahman_raheem_narration.wav`). Accepted pronunciation is not commercial
 * rights clearance. Slima is not a prerequisite. The default bound stays
 * 20–30 seconds; that recording needs `--duration-min 58 --duration-max 60`.
 * This planner does not import the file, grant approval, or modify a project.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseProbeDuration, resolveAppFfprobe } from './ffprobe-resolution.js';

export const ACCEPTANCE_DURATION_MIN_SEC = 20;
export const ACCEPTANCE_DURATION_MAX_SEC = 30;
export const ACCEPTANCE_DURATION_TOLERANCE_SEC = 0.5;

/**
 * The later authorized recording is a Gemini narration of 58.84 seconds.
 * That is not a Slima prerequisite and not a relaxation of the default bound.
 * The later command must pass this finite bound explicitly.
 */
export const GEMINI_NARRATION_DURATION_SEC = 58.84;
export const GEMINI_NARRATION_DURATION_BOUND: DurationBound = { minSec: 58, maxSec: 60 };

export interface DurationBound {
  minSec: number;
  maxSec: number;
}

export const DEFAULT_ACCEPTANCE_DURATION_BOUND: DurationBound = {
  minSec: ACCEPTANCE_DURATION_MIN_SEC,
  maxSec: ACCEPTANCE_DURATION_MAX_SEC,
};

const MAX_ACCEPTANCE_DURATION_SEC = 180;
const MAX_ACCEPTANCE_BOUND_SPAN_SEC = 5;

export const VOICE_AUDIO_SEGMENT = 'voice-audio';

export interface PathClassification {
  allowed: boolean;
  problems: string[];
  /** Basename only. Never an absolute path. */
  label: string;
}

export interface StoredNarrationGate {
  projectId: string;
  targetId: string;
  sha256: string;
  durationSec: number;
  exportAttemptReady: boolean;
  /** Must be false. A true value is a reason to refuse, not a clearance. */
  publicationApproved: boolean;
  blockedCodes: string[];
}

export interface CandidateAudioFacts {
  label: string;
  sha256: string;
  durationSec: number;
  pathAllowed: boolean;
  pathProblems: string[];
}

export type PlannedPurpose = 'read-stored-narration' | 'export-final-long' | 'poll-job';

export interface PlannedRequest {
  method: 'GET' | 'POST';
  path: string;
  purpose: PlannedPurpose;
  body?: { kind: 'final'; includeShorts: false };
}

export interface AcceptancePlan {
  allowed: boolean;
  problems: string[];
  projectId: string;
  targetId: 'long';
  expectedSha256: string;
  /** The only requests the later command may send, in order. */
  requests: PlannedRequest[];
  exportAttempts: 1 | 0;
  sendOverride: false;
  retryExport: false;
  durationBound: DurationBound;
}

export interface AcceptanceClient {
  request(input: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<{ status: number; body: unknown }>;
}

export interface AcceptanceRunResult {
  ok: boolean;
  stopped: boolean;
  exportAttempts: number;
  sentOverride: false;
  retriedExport: false;
  publicationApproved: false;
  status: number | null;
  jobStatus: string | null;
  problems: string[];
}

export function redactAcceptanceDiagnostic(text: string): string {
  return text
    .replace(/(?:[A-Za-z]:)?(?:\/|\\)(?:[\w .@+=-]+(?:\/|\\))+[\w .@+=-]*/g, '[path]')
    .replace(/\bvoiceover\/[^\s'"]+/g, '[narration-store]');
}

export function durationInAcceptanceBound(
  durationSec: number,
  bound: DurationBound = DEFAULT_ACCEPTANCE_DURATION_BOUND,
): boolean {
  return Number.isFinite(durationSec)
    && durationSec >= bound.minSec
    && durationSec <= bound.maxSec;
}

/**
 * Parse an explicit duration window. Omitting both sides keeps the 20–30 second
 * default. One side, a non-finite value, a negative, an inverted pair, or a
 * window wide enough to accept an arbitrary recording is rejected.
 */
export function parseDurationBound(minRaw: unknown, maxRaw: unknown): { ok: true; bound: DurationBound } | { ok: false; problems: string[] } {
  if (minRaw == null && maxRaw == null) return { ok: true, bound: DEFAULT_ACCEPTANCE_DURATION_BOUND };
  if (minRaw == null || maxRaw == null || minRaw === '' || maxRaw === '') {
    return { ok: false, problems: ['Both duration bounds are required. The default 20–30 second window was not widened.'] };
  }
  const minSec = typeof minRaw === 'number' ? minRaw : Number(minRaw);
  const maxSec = typeof maxRaw === 'number' ? maxRaw : Number(maxRaw);
  const problems: string[] = [];
  if (!Number.isFinite(minSec) || !Number.isFinite(maxSec)) {
    problems.push('The duration bound must be finite. Unbounded or non-numeric bounds are rejected.');
  }
  if (Number.isFinite(minSec) && minSec < 0) problems.push('The duration minimum cannot be negative.');
  if (Number.isFinite(maxSec) && maxSec < 0) problems.push('The duration maximum cannot be negative.');
  if (Number.isFinite(minSec) && Number.isFinite(maxSec) && minSec > maxSec) {
    problems.push('The duration bound is inverted. The minimum is greater than the maximum.');
  }
  if (Number.isFinite(minSec) && minSec < 1) problems.push('The duration minimum is unreasonably small for this acceptance.');
  if (Number.isFinite(maxSec) && maxSec > MAX_ACCEPTANCE_DURATION_SEC) {
    problems.push('The duration maximum is unreasonably long for this acceptance.');
  }
  if (Number.isFinite(minSec) && Number.isFinite(maxSec) && maxSec - minSec > MAX_ACCEPTANCE_BOUND_SPAN_SEC) {
    problems.push('The duration bound is too wide. This acceptance does not accept an arbitrary range.');
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, bound: { minSec, maxSec } };
}

function isInside(root: string, candidate: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(candidate)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasSegment(filePath: string, segment: string): boolean {
  return filePath.split(/[/\\]/).some((part) => part === segment);
}

/**
 * Classify a candidate recording without echoing its location.
 * `realPath` is the symlink-resolved path. A link is rejected even when the
 * target is outside the repository.
 */
export function classifyAcceptanceAudioPath(input: {
  candidatePath: string;
  repoRoot: string;
  realPath: string;
  isSymlink: boolean;
}): PathClassification {
  const problems: string[] = [];
  const label = path.basename(input.candidatePath) || 'audio-file';
  if (!path.isAbsolute(input.candidatePath) || !path.isAbsolute(input.realPath) || !path.isAbsolute(input.repoRoot)) {
    problems.push('The candidate audio must be an absolute file outside this repository.');
  }
  if (input.isSymlink) {
    problems.push('The candidate audio is a symlink. Use the real file, not a link.');
  }
  if (isInside(input.repoRoot, input.candidatePath) || isInside(input.repoRoot, input.realPath)) {
    problems.push('The candidate audio is inside the repository. Keep the recording outside the repo.');
  }
  if (hasSegment(input.candidatePath, VOICE_AUDIO_SEGMENT) || hasSegment(input.realPath, VOICE_AUDIO_SEGMENT)) {
    problems.push('The candidate audio is in voice-audio storage. That is not the outside recording.');
  }
  return { allowed: problems.length === 0, problems, label };
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function safeProjectId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(value);
}

export function planExternalNarrationAcceptance(input: {
  projectId: string;
  candidate: CandidateAudioFacts;
  stored: StoredNarrationGate;
  durationBound?: DurationBound;
}): AcceptancePlan {
  const problems = [...input.candidate.pathProblems];
  if (!input.candidate.pathAllowed && input.candidate.pathProblems.length === 0) {
    problems.push('The candidate audio path was rejected.');
  }
  if (!safeProjectId(input.projectId) || input.projectId !== input.stored.projectId) {
    problems.push('The project id is missing or does not match the stored narration.');
  }
  if (input.stored.targetId !== 'long') {
    problems.push('This acceptance exports the Long video only. A Short is not substituted.');
  }
  if (!isSha256(input.candidate.sha256) || !isSha256(input.stored.sha256)) {
    problems.push('The stored narration has no SHA-256 to compare.');
  } else if (input.candidate.sha256.toLowerCase() !== input.stored.sha256.toLowerCase()) {
    problems.push('The candidate file does not match the stored narration digest.');
  }
  const bound = input.durationBound ?? DEFAULT_ACCEPTANCE_DURATION_BOUND;
  if (!durationInAcceptanceBound(input.candidate.durationSec, bound) || !durationInAcceptanceBound(input.stored.durationSec, bound)) {
    problems.push(`The recording must be ${bound.minSec}–${bound.maxSec} seconds. This acceptance does not guess a duration.`);
  } else if (Math.abs(input.candidate.durationSec - input.stored.durationSec) > ACCEPTANCE_DURATION_TOLERANCE_SEC) {
    problems.push('The measured duration does not match the duration stored with the import.');
  }
  if (input.stored.publicationApproved !== false) {
    problems.push('Publication approval must stay false. This command does not grant it.');
  }
  if (!input.stored.exportAttemptReady || input.stored.blockedCodes.length > 0) {
    problems.push('The stored gate is not ready to attempt export. Fix it in the browser, then run this command again. It will not import or re-approve.');
  }

  const allowed = problems.length === 0;
  const projectId = safeProjectId(input.projectId) ? input.projectId : 'project';
  const requests: PlannedRequest[] = allowed
    ? [
        {
          method: 'GET',
          path: `/api/projects/${projectId}/external-narration`,
          purpose: 'read-stored-narration',
        },
        {
          method: 'POST',
          path: `/api/projects/${projectId}/export`,
          purpose: 'export-final-long',
          body: { kind: 'final', includeShorts: false },
        },
        {
          method: 'GET',
          path: '/api/jobs/:jobId',
          purpose: 'poll-job',
        },
      ]
    : [];
  return {
    allowed,
    problems: problems.map(redactAcceptanceDiagnostic),
    projectId,
    targetId: 'long',
    expectedSha256: isSha256(input.stored.sha256) ? input.stored.sha256.toLowerCase() : '',
    requests,
    exportAttempts: allowed ? 1 : 0,
    sendOverride: false,
    retryExport: false,
    durationBound: bound,
  };
}

export function narrationGateFromView(body: unknown, projectId: string, targetId = 'long'): StoredNarrationGate | null {
  if (!body || typeof body !== 'object') return null;
  const view = body as { projectId?: unknown; targets?: unknown };
  if (!Array.isArray(view.targets)) return null;
  const target = view.targets.find((item) => item && typeof item === 'object' && (item as { targetId?: unknown }).targetId === targetId) as
    | {
        targetId?: unknown;
        import?: { sha256?: unknown; durationSec?: unknown } | null;
        readiness?: { exportAttemptReady?: unknown; publicationApproved?: unknown; blockers?: { code?: unknown }[] };
      }
    | undefined;
  if (!target?.import || typeof target.import.sha256 !== 'string' || typeof target.import.durationSec !== 'number') return null;
  const readiness = target.readiness;
  if (!readiness) return null;
  return {
    projectId: typeof view.projectId === 'string' ? view.projectId : projectId,
    targetId,
    sha256: target.import.sha256,
    durationSec: target.import.durationSec,
    exportAttemptReady: readiness.exportAttemptReady === true,
    publicationApproved: readiness.publicationApproved === false ? false : true,
    blockedCodes: Array.isArray(readiness.blockers)
      ? readiness.blockers.map((item) => (typeof item?.code === 'string' ? item.code : '')).filter(Boolean)
      : [],
  };
}

export function interpretExportStatus(status: number): { stop: boolean; retryExport: false; sendOverride: false; reason: string } {
  if (status === 409) {
    return {
      stop: true,
      retryExport: false,
      sendOverride: false,
      reason: 'Export was rejected with 409. Stopped. No override will be sent and the export will not be retried.',
    };
  }
  if (status >= 200 && status < 300) {
    return { stop: false, retryExport: false, sendOverride: false, reason: '' };
  }
  return {
    stop: true,
    retryExport: false,
    sendOverride: false,
    reason: `Export was not accepted (HTTP ${status}). Stopped. No override and no retry.`,
  };
}

export function interpretJobStatus(status: string): { action: 'poll' | 'done' | 'stop'; publicationApproved: false } {
  if (status === 'running') return { action: 'poll', publicationApproved: false };
  if (status === 'done') return { action: 'done', publicationApproved: false };
  return { action: 'stop', publicationApproved: false };
}

export function jobPollPath(jobId: string): string | null {
  if (!jobId || /[\\/]|\.\./.test(jobId)) return null;
  return `/api/jobs/${jobId}`;
}

function readJobId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const jobId = (body as { jobId?: unknown }).jobId;
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : null;
}

function readJobStatus(body: unknown): string {
  if (!body || typeof body !== 'object') return 'unknown';
  const status = (body as { status?: unknown }).status;
  return typeof status === 'string' ? status : 'unknown';
}

/**
 * Perform the planned requests and nothing else.
 * A 409, a digest mismatch, or a failed job stops the run. Export is never
 * repeated and `override` is never added to a body.
 */
export async function executeAcceptancePlan(input: {
  client: AcceptanceClient;
  plan: AcceptancePlan;
  candidate: CandidateAudioFacts;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}): Promise<AcceptanceRunResult> {
  const refused = (problems: string[], status: number | null = null, exportAttempts = 0, jobStatus: string | null = null): AcceptanceRunResult => ({
    ok: false,
    stopped: true,
    exportAttempts,
    sentOverride: false,
    retriedExport: false,
    publicationApproved: false,
    status,
    jobStatus,
    problems: problems.map(redactAcceptanceDiagnostic),
  });
  if (!input.plan.allowed) return refused(input.plan.problems);
  if (input.plan.sendOverride !== false || input.plan.retryExport !== false || input.plan.exportAttempts !== 1) {
    return refused(['The plan asked for an override or a retry. Refusing.']);
  }

  let exportAttempts = 0;
  let jobStatus: string | null = null;
  let status: number | null = null;
  for (const request of input.plan.requests) {
    if (request.purpose === 'read-stored-narration') {
      const response = await input.client.request({ method: 'GET', path: request.path });
      status = response.status;
      if (response.status !== 200) return refused([`The stored narration could not be read (HTTP ${response.status}).`], response.status);
      const live = narrationGateFromView(response.body, input.plan.projectId, 'long');
      if (!live) return refused(['The stored narration view has no digest for the Long target.']);
      const livePlan = planExternalNarrationAcceptance({
        projectId: input.plan.projectId,
        candidate: input.candidate,
        stored: live,
        durationBound: input.plan.durationBound,
      });
      if (!livePlan.allowed) return refused(livePlan.problems, response.status);
      continue;
    }
    if (request.purpose === 'export-final-long') {
      if (exportAttempts > 0) return refused(['A second export is not allowed.'], status, exportAttempts, jobStatus);
      if (!request.body || request.body.kind !== 'final' || request.body.includeShorts !== false || 'override' in request.body) {
        return refused(['The export body is not the single Long final export.']);
      }
      exportAttempts += 1;
      const response = await input.client.request({ method: 'POST', path: request.path, body: { kind: 'final', includeShorts: false } });
      status = response.status;
      const decision = interpretExportStatus(response.status);
      if (decision.stop) return refused([decision.reason], response.status, exportAttempts, jobStatus);
      const jobId = readJobId(response.body);
      const pollPath = jobId ? jobPollPath(jobId) : null;
      if (!pollPath) return refused(['Export did not return a job id. Stopped without retry.'], response.status, exportAttempts);
      const maxPolls = input.maxPolls ?? 1;
      const sleep = input.sleep ?? (async () => undefined);
      const interval = input.pollIntervalMs ?? 0;
      for (let poll = 0; poll < maxPolls; poll += 1) {
        const job = await input.client.request({ method: 'GET', path: pollPath });
        jobStatus = readJobStatus(job.body);
        const next = interpretJobStatus(jobStatus);
        if (next.action === 'done') {
          return {
            ok: true,
            stopped: true,
            exportAttempts,
            sentOverride: false,
            retriedExport: false,
            publicationApproved: false,
            status,
            jobStatus,
            problems: [],
          };
        }
        if (next.action === 'stop') {
          return refused([`Export job ${jobStatus}. Stopped. No override and no retry.`], status, exportAttempts, jobStatus);
        }
        if (poll < maxPolls - 1) await sleep(interval);
      }
      return refused(['Export job was still running when polling stopped. It was not retried.'], status, exportAttempts, jobStatus);
    }
  }
  return refused(['The plan did not include an export.'], status, exportAttempts, jobStatus);
}

/** PCM WAV duration from the header. Returns null for any other container. */
export function wavDurationSec(bytes: Buffer): number | null {
  if (bytes.length < 44) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let byteRate = 0;
  let dataSize: number | null = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && start + 16 <= bytes.length) byteRate = bytes.readUInt32LE(start + 8);
    if (id === 'data') {
      dataSize = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!byteRate || dataSize === null || dataSize <= 0) return null;
  return dataSize / byteRate;
}

export function sha256OfFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

export function measureCandidateDuration(filePath: string, probeCommand?: string): number | null {
  const wav = wavDurationSec(fs.readFileSync(filePath));
  if (wav !== null) return wav;
  const resolved = probeCommand
    ? { executable: probeCommand, problem: null as string | null }
    : resolveAppFfprobe();
  if (!resolved.executable) return null;
  const result = spawnSync(resolved.executable, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  return parseProbeDuration(String(result.stdout ?? ''));
}

function printProblems(problems: string[]): void {
  for (const problem of problems) console.error(redactAcceptanceDiagnostic(problem));
}

async function main(): Promise<void> {
  const projectId = readFlag('--project');
  const audio = readFlag('--audio');
  const repoRoot = readFlag('--repo-root') ?? process.cwd();
  const base = (readFlag('--base') ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const confirm = process.argv.includes('--confirm-single-export');
  if (!projectId || !audio) {
    console.error('Usage: node --import tsx scripts/external-narration-acceptance-plan.ts --project <id> --audio <file-outside-repo> [--duration-min 20 --duration-max 30] [--base http://127.0.0.1:3000] [--confirm-single-export]');
    console.error('The default bound is 20–30 seconds. The later Gemini narration of 58.84 seconds needs --duration-min 58 --duration-max 60. Slima is not a prerequisite.');
    console.error('Without --confirm-single-export this command does not contact the export endpoint.');
    process.exit(2);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(projectId)) {
    console.error('The project id is not a single project name. No request was sent.');
    process.exit(2);
  }
  if (!/^https?:\/\//.test(base)) {
    console.error('The API base must be an http(s) URL. No file path is accepted there.');
    process.exit(2);
  }
  let stat: fs.Stats;
  let realPath = audio;
  try {
    stat = fs.lstatSync(audio);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      console.error('The candidate audio is not a file. No path is printed.');
      process.exit(2);
    }
    realPath = fs.realpathSync(audio);
  } catch {
    console.error('The candidate audio could not be read. No path is printed.');
    process.exit(2);
  }
  const classified = classifyAcceptanceAudioPath({
    candidatePath: path.resolve(audio),
    repoRoot: path.resolve(repoRoot),
    realPath: path.resolve(realPath),
    isSymlink: stat.isSymbolicLink(),
  });
  if (!classified.allowed) {
    printProblems(classified.problems);
    process.exit(2);
  }
  if (!confirm) {
    console.log(`Planner only. ${classified.label} passed the path check.`);
    console.log('Browser import, listening, and timing approval must already be recorded.');
    console.log('Re-run with --confirm-single-export to verify the stored digest and send one Long final export. This is not publication approval.');
    process.exit(0);
  }
  const boundResult = parseDurationBound(readFlag('--duration-min'), readFlag('--duration-max'));
  if (!boundResult.ok) {
    printProblems(boundResult.problems);
    process.exit(2);
  }
  const durationSec = measureCandidateDuration(realPath);
  if (durationSec === null) {
    const probe = resolveAppFfprobe();
    console.error(probe.problem ?? 'Duration could not be measured. Set BUILDTRAKE_FFPROBE or install ffprobe. Refusing to guess, import, or export.');
    process.exit(2);
  }
  const candidate: CandidateAudioFacts = {
    label: classified.label,
    sha256: sha256OfFile(realPath),
    durationSec,
    pathAllowed: true,
    pathProblems: [],
  };
  const client: AcceptanceClient = {
    async request(call) {
      const response = await fetch(`${base}${call.path}`, {
        method: call.method,
        headers: call.body ? { 'content-type': 'application/json' } : undefined,
        body: call.body ? JSON.stringify(call.body) : undefined,
      });
      const text = await response.text();
      let body: unknown = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { error: 'The server did not return JSON.' };
        }
      }
      return { status: response.status, body };
    },
  };
  const viewed = await client.request({ method: 'GET', path: `/api/projects/${projectId}/external-narration` });
  if (viewed.status !== 200) {
    console.error(`The stored narration could not be read (HTTP ${viewed.status}). No export was sent.`);
    process.exit(2);
  }
  const stored = narrationGateFromView(viewed.body, projectId, 'long');
  if (!stored) {
    console.error('The stored Long narration has no digest. No export was sent.');
    process.exit(2);
  }
  const plan = planExternalNarrationAcceptance({
    projectId,
    candidate,
    stored,
    durationBound: boundResult.bound,
  });
  if (!plan.allowed) {
    printProblems(plan.problems);
    console.error('No export was sent. This command does not import or re-approve audio.');
    process.exit(2);
  }
  const result = await executeAcceptancePlan({
    client,
    plan,
    candidate,
    maxPolls: 120,
    pollIntervalMs: 2000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  if (!result.ok) {
    printProblems(result.problems);
    console.error('Stopped. Publication is not approved.');
    process.exit(1);
  }
  console.log('Export job finished. This is not publication approval.');
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  await main();
}
