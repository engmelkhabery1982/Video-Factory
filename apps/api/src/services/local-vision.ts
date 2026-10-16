/**
 * Local picture understanding (one picture per job) through the owner's llama-server with a vision projector.
 *
 * Runtime: llama.cpp llama-server (the same pinned release as the local planner), started by the owner with a vision
 * GGUF and its --mmproj projector, on a LOOPBACK address. The server calls it over the OpenAI-compatible
 * /v1/chat/completions route with the picture as a data URL. No cloud, no provider, no spend.
 *
 * Contract:
 *  - one job at a time; a job has a timeout and can be cancelled; a late answer after cancel is discarded;
 *  - the answer is parsed strictly (packages/core visual-review) before anything is stored; raw text is not kept;
 *  - a job records the picture SHA-256 it analysed. A reviewed description only stays valid for that SHA-256;
 *  - a job still running at restart is recorded as interrupted, never as success.
 *
 * Evidence: a fixture test double of the server proves the protocol mechanics only. Real understanding quality is
 * not claimed here; it needs the owner's runtime and a review of the observations.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseVisionObservation, VISION_SYSTEM_PROMPT, VISION_USER_PROMPT, type VisionObservation } from '@buildtrack/core';
import { DATA_DIR } from './platform.js';
import { loopbackChatUrl } from './local-planner.js';
import { cachedFileSha256 } from './file-hash.js';

/** Pinned from the upstream release and model metadata (read from the GitHub and Hugging Face APIs). Not downloaded here. */
export const VISION_PINNED = {
  runtime: { project: 'ggml-org/llama.cpp', release: 'b11429', licence: 'MIT', server: 'llama-server (same release as the local planner)' },
  model: {
    repo: 'ggml-org/Qwen2-VL-2B-Instruct-GGUF',
    revision: 'bb307c036e8a1ed7b663bbd0c35b41c4c9294cfd',
    file: 'Qwen2-VL-2B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/ggml-org/Qwen2-VL-2B-Instruct-GGUF/resolve/bb307c036e8a1ed7b663bbd0c35b41c4c9294cfd/Qwen2-VL-2B-Instruct-Q4_K_M.gguf',
    sizeBytes: 986046944,
    upstreamSha256: '5745685d2e607a82a0696c1118e56a2a1ae0901da450fd9cd4f161c6b62867d7',
    licence: 'Apache-2.0 (repo metadata)',
  },
  projector: {
    file: 'mmproj-Qwen2-VL-2B-Instruct-Q8_0.gguf',
    url: 'https://huggingface.co/ggml-org/Qwen2-VL-2B-Instruct-GGUF/resolve/bb307c036e8a1ed7b663bbd0c35b41c4c9294cfd/mmproj-Qwen2-VL-2B-Instruct-Q8_0.gguf',
    sizeBytes: 709883360,
    upstreamSha256: 'a0ad91f00a7a80dcf84d719a61b00ee2e07b71794f4ee2dfa81a254621a8c418',
    licence: 'Apache-2.0 (repo metadata)',
  },
} as const;

export const VISION_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const VISION_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface VisionConfig {
  enabled: boolean;
  url: string | null;
  modelPath: string | null;
  modelSha256: string | null;
  projectorPath: string | null;
  projectorSha256: string | null;
  timeoutMs: number;
  maxTokens: number;
  root: string;
}

export function readVisionConfig(env: NodeJS.ProcessEnv, defaultRoot: string): VisionConfig {
  const intEnv = (v: string | undefined, dflt: number, lo: number, hi: number) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  return {
    enabled: env.VISION_ENABLED === '1',
    url: env.VISION_URL?.trim() || null,
    modelPath: env.VISION_MODEL_PATH?.trim() || null,
    modelSha256: env.VISION_MODEL_SHA256?.trim().toLowerCase() || null,
    projectorPath: env.VISION_PROJECTOR_PATH?.trim() || null,
    projectorSha256: env.VISION_PROJECTOR_SHA256?.trim().toLowerCase() || null,
    timeoutMs: intEnv(env.VISION_TIMEOUT_SEC, 240, 30, 900) * 1000,
    maxTokens: intEnv(env.VISION_MAX_TOKENS, 400, 64, 1024),
    root: env.VISION_ROOT?.trim() || path.join(defaultRoot, 'factory', 'vision-analysis'),
  };
}

let sharedVisionConfig: VisionConfig | null = null;
export function visionConfig(): VisionConfig {
  if (!sharedVisionConfig) sharedVisionConfig = readVisionConfig(process.env, DATA_DIR);
  return sharedVisionConfig;
}

export class VisionError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: Record<string, unknown>) {
    super(message);
  }
}

export interface VisionStatus {
  ready: boolean;
  missing: string[];
  endpoint: string | null;
  serverReachable: boolean | null;
  model: { name: string; licence: string; sha256Matches: boolean | null };
  projector: { name: string; licence: string; sha256Matches: boolean | null };
  busy: boolean;
  timeoutSec: number;
  pinned: typeof VISION_PINNED;
}

async function healthOf(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function visionStatus(cfg: VisionConfig = visionConfig()): Promise<VisionStatus> {
  const missing: string[] = [];
  if (!cfg.enabled) missing.push('VISION_ENABLED=1 is not set. Local picture analysis is off.');
  let endpoint: string | null = null;
  if (!cfg.url) missing.push('VISION_URL is not set (the loopback address of the vision llama-server, for example http://127.0.0.1:8081).');
  else {
    endpoint = loopbackChatUrl(cfg.url);
    if (!endpoint) missing.push('VISION_URL must be a loopback http address (127.0.0.1, localhost or ::1). Cloud or LAN hosts are refused.');
  }
  let modelMatch: boolean | null = null;
  if (!cfg.modelPath || !fs.existsSync(cfg.modelPath)) missing.push('VISION_MODEL_PATH is not set, or the file was not found (the Qwen2-VL-2B GGUF, outside Git).');
  else if (!cfg.modelSha256) missing.push('VISION_MODEL_SHA256 is not set. Record the model hash before first use.');
  else {
    modelMatch = (await cachedFileSha256(cfg.modelPath)) === cfg.modelSha256;
    if (!modelMatch) missing.push('The vision model file does not match VISION_MODEL_SHA256.');
  }
  let projMatch: boolean | null = null;
  if (!cfg.projectorPath || !fs.existsSync(cfg.projectorPath)) missing.push('VISION_PROJECTOR_PATH is not set, or the file was not found (the mmproj GGUF, outside Git).');
  else if (!cfg.projectorSha256) missing.push('VISION_PROJECTOR_SHA256 is not set. Record the projector hash before first use.');
  else {
    projMatch = (await cachedFileSha256(cfg.projectorPath)) === cfg.projectorSha256;
    if (!projMatch) missing.push('The vision projector file does not match VISION_PROJECTOR_SHA256.');
  }
  let reachable: boolean | null = null;
  if (endpoint) {
    reachable = await healthOf(endpoint);
    if (!reachable) missing.push('The vision llama-server is not answering on VISION_URL. Start it on the loopback address with the model and --mmproj.');
  }
  return {
    ready: missing.length === 0,
    missing,
    endpoint,
    serverReachable: reachable,
    model: { name: VISION_PINNED.model.file, licence: VISION_PINNED.model.licence, sha256Matches: modelMatch },
    projector: { name: VISION_PINNED.projector.file, licence: VISION_PINNED.projector.licence, sha256Matches: projMatch },
    busy: active !== null,
    timeoutSec: cfg.timeoutMs / 1000,
    pinned: VISION_PINNED,
  };
}

export type VisionJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export const VISION_TERMINAL: ReadonlySet<VisionJobState> = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);

export interface VisionJob {
  id: string;
  assetId: string;
  /** SHA-256 of the picture bytes that were sent. */
  sha256: string;
  mimeType: string;
  state: VisionJobState;
  timeoutSec: number;
  createdAt: string;
  updatedAt: string;
  error: { code: string; message: string } | null;
  observation: VisionObservation | null;
}

const JOB_ID_RE = /^lvj_[a-f0-9]{16}$/;
const jobsDir = (cfg: VisionConfig) => path.join(cfg.root, 'jobs');
const jobFile = (cfg: VisionConfig, id: string) => path.join(jobsDir(cfg), `${id}.json`);

function saveJob(cfg: VisionConfig, job: VisionJob): void {
  fs.mkdirSync(jobsDir(cfg), { recursive: true });
  const tmp = `${jobFile(cfg, job.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, jobFile(cfg, job.id));
}

export function getVisionJob(id: string, cfg: VisionConfig = visionConfig()): VisionJob {
  if (!JOB_ID_RE.test(id)) throw new VisionError('VISION_NOT_FOUND', 'No such analysis job.', 404);
  try {
    return JSON.parse(fs.readFileSync(jobFile(cfg, id), 'utf8')) as VisionJob;
  } catch {
    throw new VisionError('VISION_NOT_FOUND', 'No such analysis job.', 404);
  }
}

/** A job that was running when the process stopped is interrupted. It is never shown as a result. */
export function recoverVisionJobs(cfg: VisionConfig = visionConfig()): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(jobsDir(cfg));
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobsDir(cfg), n), 'utf8')) as VisionJob;
      if (job.state === 'queued' || job.state === 'running') {
        job.state = 'interrupted';
        job.error = { code: 'VISION_INTERRUPTED', message: 'The analysis was running when the server stopped. Start it again.' };
        job.updatedAt = new Date().toISOString();
        saveJob(cfg, job);
      }
    } catch {
      // unreadable job file: left as it is
    }
  }
}

interface Active {
  id: string;
  controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
}
let active: Active | null = null;

export function activeVisionJobId(): string | null {
  return active?.id ?? null;
}

/** Starts one analysis of one picture. The caller has read the picture bytes and computed their SHA-256. */
export async function startVisionJob(
  input: { assetId: string; bytes: Buffer; sha256: string; mimeType: string },
  cfg: VisionConfig = visionConfig(),
): Promise<VisionJob> {
  const status = await visionStatus(cfg);
  if (!status.ready) throw new VisionError('VISION_SETUP_REQUIRED', 'Local picture analysis is not ready on this computer.', 503, { missing: status.missing });
  if (active) throw new VisionError('VISION_BUSY', 'Another picture is being analysed. Wait for it or cancel it.', 409);
  if (!(VISION_ALLOWED_MIME as readonly string[]).includes(input.mimeType)) {
    throw new VisionError('VISION_VALIDATION', 'Only PNG, JPEG or WebP pictures can be analysed.', 422);
  }
  if (input.bytes.length === 0 || input.bytes.length > VISION_MAX_IMAGE_BYTES) {
    throw new VisionError('VISION_VALIDATION', `The picture must be 1 byte to ${VISION_MAX_IMAGE_BYTES} bytes.`, 422);
  }
  const now = new Date().toISOString();
  const job: VisionJob = {
    id: `lvj_${crypto.randomBytes(8).toString('hex')}`,
    assetId: input.assetId,
    sha256: input.sha256,
    mimeType: input.mimeType,
    state: 'queued',
    timeoutSec: cfg.timeoutMs / 1000,
    createdAt: now,
    updatedAt: now,
    error: null,
    observation: null,
  };
  saveJob(cfg, job);
  active = { id: job.id, controller: new AbortController(), cancelled: false, timedOut: false };
  void runVisionJob(job.id, input.bytes, cfg).finally(() => {
    if (active?.id === job.id) active = null;
  });
  return job;
}

function finishJob(cfg: VisionConfig, id: string, state: VisionJobState, error: VisionJob['error'], observation: VisionObservation | null): VisionJob {
  const job = getVisionJob(id, cfg);
  job.state = state;
  job.error = error;
  job.observation = observation;
  job.updatedAt = new Date().toISOString();
  saveJob(cfg, job);
  return job;
}

async function runVisionJob(id: string, bytes: Buffer, cfg: VisionConfig): Promise<void> {
  const act = active!;
  const job = getVisionJob(id, cfg);
  job.state = 'running';
  job.updatedAt = new Date().toISOString();
  saveJob(cfg, job);
  const base = cfg.url ? loopbackChatUrl(cfg.url) : null;
  const timer = setTimeout(() => {
    act.timedOut = true;
    act.controller.abort();
  }, cfg.timeoutMs);
  try {
    if (!base) throw new Error('no endpoint');
    const dataUrl = `data:${job.mimeType};base64,${bytes.toString('base64')}`;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'local-vision',
        stream: false,
        temperature: 0,
        max_tokens: cfg.maxTokens,
        messages: [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          { role: 'user', content: [{ type: 'text', text: VISION_USER_PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] },
        ],
      }),
      signal: act.controller.signal,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = typeof body.choices?.[0]?.message?.content === 'string' ? (body.choices![0]!.message!.content as string) : '';
    if (act.cancelled) return; // a late answer after cancel is discarded
    const parsed = parseVisionObservation(text);
    if (!parsed.ok) {
      finishJob(cfg, id, 'failed', { code: 'VISION_OUTPUT_INVALID', message: `The answer was refused: ${parsed.reason} Analyse the picture again.` }, null);
      return;
    }
    finishJob(cfg, id, 'succeeded', null, parsed.value);
  } catch {
    if (act.cancelled) {
      // Already recorded by cancelVisionJob. Keep the record as cancelled.
      return;
    }
    if (act.timedOut) {
      finishJob(cfg, id, 'timed_out', { code: 'VISION_TIMEOUT', message: `The analysis did not finish within ${Math.round(cfg.timeoutMs / 1000)} seconds. Nothing was saved.` }, null);
      return;
    }
    finishJob(cfg, id, 'failed', { code: 'VISION_UNAVAILABLE', message: 'The local vision server could not be reached or did not answer. Check that it is running on the loopback address.' }, null);
  } finally {
    clearTimeout(timer);
  }
}

export function cancelVisionJob(id: string, cfg: VisionConfig = visionConfig()): VisionJob {
  const job = getVisionJob(id, cfg);
  if (job.state !== 'queued' && job.state !== 'running') return job;
  if (active?.id === id) {
    active.cancelled = true;
    active.controller.abort();
  }
  return finishJob(cfg, id, 'cancelled', null, null);
}

export function resetVisionForTests(): void {
  active = null;
  sharedVisionConfig = null;
}
