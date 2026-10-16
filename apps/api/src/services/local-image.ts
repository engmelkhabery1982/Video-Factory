/**
 * Local still-image generation on the owner's computer (stable-diffusion.cpp `sd-cli`).
 *
 * No provider, no network call, no spend. The runtime and the model weights live outside Git,
 * under the path set by the owner (F: on the owner's machine). Nothing is downloaded or installed here.
 *
 * Flow: shot prompt -> job (one at a time) -> candidate preview -> approve -> bind to the shot.
 * A candidate is NOT in the library until it is approved. An approved image is registered with its
 * provenance: seed, prompt hash, model hash, dimensions, runner release and backend.
 *
 * Output is validated before anything is registered: a full PNG decode check (signature, chunk
 * CRCs, IHDR, inflated scanline length, IEND) and the requested dimensions.
 *
 * Unverified until the owner runs setup: the flag names passed to sd-cli. The probe checks them
 * against `sd-cli -h` and reports any that the installed build does not list.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, type ChildProcess } from 'node:child_process';
import { ASSETS_DIR, DATA_DIR } from './platform.js';
import { cachedFileSha256, sha256FileStream } from './file-hash.js';
import { loadAssetIndex, saveAssetIndex } from '../routes/assets.js';

/** Pinned from the upstream GitHub release API (digests as reported by GitHub). */
export const LOCAL_IMAGE_PINNED = {
  project: 'leejet/stable-diffusion.cpp',
  projectLicense: 'MIT',
  release: 'master-964-1d0a58a',
  releaseCommit: '1d0a58a35050d285b1d6fb1bc68a92924d35825e',
  releasePublishedAt: '2026-10-13T18:01:29Z',
  windowsCpuAsset: {
    name: 'sd-master-1d0a58a-bin-win-cpu-x64.zip',
    bytes: 17574585,
    sha256: '8e4e7bde781ff246817019a182040a087314caf4d21bc15fe4ff045167bd336d',
  },
  windowsVulkanAsset: {
    name: 'sd-master-1d0a58a-bin-win-vulkan-x64.zip',
    bytes: 30155040,
    sha256: '74211cb5c382aec2aeb086b64f2fdf525efec5faec4200a2d3257bc2328954ab',
  },
  /**
   * Lightweight SD 1.x weights: the FP16 conversion in the Comfy-Org archive repo, pinned to one commit.
   * `upstreamSha256` is the upstream expected digest (the Hugging Face LFS object id, which is SHA-256 for LFS
   * files), read from the repo tree API. It is NOT a hash of a file this project has downloaded. The digest of
   * the file the owner actually downloaded is calculated at setup and recorded in LOCAL_IMAGE_MODEL_SHA256.
   */
  model: {
    name: 'v1-5-pruned-emaonly-fp16.safetensors',
    repo: 'Comfy-Org/stable-diffusion-v1-5-archive',
    revision: '9cfd069101959ca3828bf9c04a4419870832b74f',
    url: 'https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/9cfd069101959ca3828bf9c04a4419870832b74f/v1-5-pruned-emaonly-fp16.safetensors',
    sizeBytes: 2132696762,
    upstreamSha256: 'e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916',
    license: 'CreativeML Open RAIL-M (repo card: creativeml-openrail-m; use restrictions apply, owner must accept them)',
  },
  /**
   * Reference conditioning (IP-Adapter for SD 1.5). Upstream docs: docs/ip_adapter.md at 1d0a58a. The weights come from
   * h94/IP-Adapter (repo licence apache-2.0). Hashes are the Hugging Face LFS object ids (SHA-256), read from the tree API.
   * The CLIP image encoder is the same repo's models/image_encoder/model.safetensors (OpenCLIP ViT-H/14 weights).
   * Its upstream licence text is an owner review item, not verified here.
   */
  conditioning: {
    ipAdapter: {
      file: 'ip-adapter_sd15.safetensors',
      repo: 'h94/IP-Adapter',
      revision: '018e402774aeeddd60609b4ecdb7e298259dc729',
      path: 'models/ip-adapter_sd15.safetensors',
      sizeBytes: 44642768,
      upstreamSha256: '289b45f16d043d0bf542e45831f971dcdaabe18b656f11e86d9dfba7e9ee3369',
      licence: 'apache-2.0 (repo card)',
    },
    clipVision: {
      file: 'clip_vision_h.safetensors',
      repo: 'h94/IP-Adapter',
      revision: '018e402774aeeddd60609b4ecdb7e298259dc729',
      path: 'models/image_encoder/model.safetensors',
      sizeBytes: 2528373448,
      upstreamSha256: '6ca9667da1ca9e0b0f75e46bb030f7e011f44f86cbfb8d5a36590fcd7507b030',
      licence: 'apache-2.0 (repo card); upstream OpenCLIP licence to review',
    },
  },
} as const;

/**
 * Guidance scale passed to sd-cli. Upstream default is 7.0 (common.cpp, --cfg-scale). 7.5 is this project's choice.
 */
export const CFG_SCALE = 7.5;

/** Flags used only when a reference picture conditions a still. Checked by the same probe, reported separately. */
export const CONDITIONING_FLAGS = ['--clip_vision', '--ip-adapter', '--ip-adapter-image', '--ip-adapter-strength'] as const;
export const CONDITIONING_STRENGTH_RANGE = { min: 0.1, max: 1.0 } as const;

/**
 * The flags this adapter passes. The probe checks each one appears in `sd-cli -h`.
 * Meanings, checked against the pinned source (examples/common/common.cpp and examples/cli/main.cpp @1d0a58a):
 *   -m  model path (upstream README)           -p  prompt                      -n  negative prompt
 *   -W  width in pixels (default 512)           -H  height in pixels (default 512)
 *   -s  RNG seed: default 42, a negative value picks a random seed. We always pass 0..2147483647.
 *   --steps  sample steps (default 20)         --cfg-scale  guidance scale (default 7.0)
 *   -o  output path; with one image, this exact file is written (parent directories are created)
 */
export const REQUIRED_RUNNER_FLAGS = ['-m', '-p', '-n', '-W', '-H', '-s', '-o', '--steps', '--cfg-scale', '--vae-tiling'] as const;

export const LOCAL_IMAGE_SIZES = {
  // Native SD dimensions use its 64-pixel grid; the renderer crops to the video canvas.
  landscape: { width: 640, height: 384 },
  portrait: { width: 384, height: 640 },
} as const;


// Compatibility helper for earlier callers/tests. Production uses the exact server-composed pair.
const NEGATIVE_PROMPT = 'text, watermark, logo, caption, signature, blurry, low quality, deformed';

/** SD does not reliably interpret prose negation in its positive prompt. Move
 * an explicit owner exclusion to the negative conditioning instead. This is
 * shot-specific: religious or educational scenes may still depict people. */
export function localImagePromptPair(prompt: string): { prompt: string; negativePrompt: string } {
  const exclusion = /\b(?:no|without)\s+(?:people|persons?|humans?|human figures?|characters?)\b|(?:بدون|دون|بلا)\s+(?:أشخاص|اشخاص|ناس|بشر|شخصيات)/gi;
  if (!exclusion.test(prompt)) return { prompt, negativePrompt: NEGATIVE_PROMPT };
  exclusion.lastIndex = 0;
  return {
    prompt: prompt.replace(exclusion, 'unoccupied scene'),
    negativePrompt: `${NEGATIVE_PROMPT}, person, people, human, man, woman, child, face, portrait, body, silhouette`,
  };
}

export interface LocalImageConfig {
  enabled: boolean;
  runnerPath: string | null;
  modelPath: string | null;
  modelSha256: string | null;
  backend: 'cpu' | 'vulkan';
  steps: number;
  timeoutMs: number;
  root: string;
  /** Optional reference conditioning. Absent paths mean conditioning is not set up; text-to-image still works. */
  clipVisionPath: string | null;
  clipVisionSha256: string | null;
  ipAdapterPath: string | null;
  ipAdapterSha256: string | null;
}

export function readLocalImageConfig(env: NodeJS.ProcessEnv, defaultRoot: string): LocalImageConfig {
  const intEnv = (v: string | undefined, dflt: number, lo: number, hi: number) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  return {
    enabled: env.LOCAL_IMAGE_ENABLED === '1',
    runnerPath: env.LOCAL_IMAGE_RUNNER?.trim() || null,
    modelPath: env.LOCAL_IMAGE_MODEL?.trim() || null,
    modelSha256: env.LOCAL_IMAGE_MODEL_SHA256?.trim().toLowerCase() || null,
    backend: env.LOCAL_IMAGE_BACKEND?.trim() === 'vulkan' ? 'vulkan' : 'cpu',
    steps: intEnv(env.LOCAL_IMAGE_STEPS, 20, 4, 40),
    timeoutMs: intEnv(env.LOCAL_IMAGE_TIMEOUT_SEC, 900, 60, 3600) * 1000,
    root: env.LOCAL_IMAGE_ROOT?.trim() || path.join(defaultRoot, 'factory', 'local-images'),
    clipVisionPath: env.LOCAL_IMAGE_CLIP_VISION?.trim() || null,
    clipVisionSha256: env.LOCAL_IMAGE_CLIP_VISION_SHA256?.trim().toLowerCase() || null,
    ipAdapterPath: env.LOCAL_IMAGE_IP_ADAPTER?.trim() || null,
    ipAdapterSha256: env.LOCAL_IMAGE_IP_ADAPTER_SHA256?.trim().toLowerCase() || null,
  };
}

let sharedConfig: LocalImageConfig | null = null;
/** The process-wide config. Tests may adjust it; the routes read the same object. */
export function localImageConfig(): LocalImageConfig {
  if (!sharedConfig) sharedConfig = readLocalImageConfig(process.env, DATA_DIR);
  return sharedConfig;
}

export class LocalImageError extends Error {
  readonly code: 'LOCAL_IMAGE_SETUP_REQUIRED' | 'LOCAL_IMAGE_BUSY' | 'LOCAL_IMAGE_NOT_FOUND' | 'LOCAL_IMAGE_STATE' | 'LOCAL_IMAGE_TIMEOUT' | 'LOCAL_IMAGE_FAILED' | 'LOCAL_IMAGE_INVALID_OUTPUT' | 'LOCAL_IMAGE_VALIDATION' | 'LOCAL_IMAGE_REFERENCE_CHANGED';
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(code: LocalImageError['code'], message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'LocalImageError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const sha256File = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/* ------------------------------------------------------------------ */
/* Status and probe                                                    */
/* ------------------------------------------------------------------ */

const hashCache = new Map<string, { key: string; sha256: string }>();
function cachedModelHash(file: string): string {
  const st = fs.statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = hashCache.get(file);
  if (hit && hit.key === key) return hit.sha256;
  // Streamed hash: the weights are gigabytes.
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  try {
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  const sha256 = h.digest('hex');
  hashCache.set(file, { key, sha256 });
  return sha256;
}

/** Runs `runner -h` with a short timeout. Returns the help text, or an error string. */
function runnerCommand(runner: string, args: string[]): [string, string[]] {
  // Windows cannot execute a Node shebang fixture. Never enable this path outside Vitest.
  if (process.env.VITEST && path.resolve(runner) === path.resolve('tests/fixtures/fake-sd-cli.mjs')) {
    return [process.execPath, [runner, ...args]];
  }
  return [runner, args];
}
function probeHelp(runner: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcess;
    try {
      child = spawn(...runnerCommand(runner, ['-h']), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, error: 'the runner could not be started' });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'the runner did not answer -h within 15 seconds' });
    }, 15000);
    child.stdout?.on('data', (d) => { if (out.length < 65536) out += d.toString(); });
    child.stderr?.on('data', (d) => { if (out.length < 65536) out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, error: 'the runner could not be started' }); });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim().length > 0 ? { ok: true, text: out } : { ok: false, error: 'the runner printed no help text' });
    });
  });
}

export interface LocalImageStatus {
  state: 'setup_required' | 'ready';
  ready: boolean;
  reason: string;
  missing: string[];
  project: string;
  release: string;
  backend: 'cpu' | 'vulkan';
  steps: number;
  timeoutSec: number;
  googleUsed: false;
  paidSpend: false;
  jobsAtOnce: 1;
  busy: boolean;
  model: {
    name: string;
    license: string;
    /** Upstream expected digest for the pinned file (not a hash of a local file). */
    upstreamSha256: string;
    /** The owner's recorded digest (LOCAL_IMAGE_MODEL_SHA256) equals the upstream digest. Null when none recorded. */
    recordedMatchesUpstream: boolean | null;
    sha256Pinned: boolean;
    sha256Matches: boolean | null;
  };
  flagsChecked: readonly string[];
  flagsMissing: string[];
  /** Reference conditioning. Reported on its own: it never makes text-to-image setup "not ready". */
  conditioning: {
    ready: boolean;
    missing: string[];
    flagsChecked: readonly string[];
    flagsMissing: string[];
    ipAdapter: { name: string; licence: string; sha256Matches: boolean | null };
    clipVision: { name: string; licence: string; sha256Matches: boolean | null };
    strengthRange: { min: number; max: number };
  };
}

let probeCache: { at: number; key: string; flagsMissing: string[]; conditioningFlagsMissing: string[]; error: string | null } | null = null;

export async function localImageStatus(cfg: LocalImageConfig = localImageConfig()): Promise<LocalImageStatus> {
  const missing: string[] = [];
  if (!cfg.enabled) missing.push('LOCAL_IMAGE_ENABLED=1 is not set. Local generation is off.');
  let runnerOk = false;
  if (!cfg.runnerPath) missing.push('LOCAL_IMAGE_RUNNER is not set (path to sd-cli.exe, outside Git).');
  else if (!fs.existsSync(cfg.runnerPath)) missing.push('The LOCAL_IMAGE_RUNNER file was not found.');
  else runnerOk = true;

  let modelOk = false;
  let sha256Matches: boolean | null = null;
  if (!cfg.modelPath) missing.push('LOCAL_IMAGE_MODEL is not set (path to the SD 1.x weights, outside Git).');
  else if (!fs.existsSync(cfg.modelPath)) missing.push('The LOCAL_IMAGE_MODEL file was not found.');
  else {
    modelOk = true;
    if (!cfg.modelSha256) missing.push('LOCAL_IMAGE_MODEL_SHA256 is not set. Record the weights hash before first use.');
    else {
      const actual = cachedModelHash(cfg.modelPath);
      sha256Matches = actual === cfg.modelSha256;
      if (!sha256Matches) missing.push('The model file does not match LOCAL_IMAGE_MODEL_SHA256.');
    }
  }

  let flagsMissing: string[] = [];
  if (runnerOk) {
    const key = `${cfg.runnerPath}:${fs.statSync(cfg.runnerPath as string).mtimeMs}`;
    if (!probeCache || probeCache.key !== key || Date.now() - probeCache.at > 60000) {
      const help = await probeHelp(cfg.runnerPath as string);
      if (!help.ok) probeCache = { at: Date.now(), key, flagsMissing: [...REQUIRED_RUNNER_FLAGS], conditioningFlagsMissing: [...CONDITIONING_FLAGS], error: help.error };
      else {
        const missingFlags = REQUIRED_RUNNER_FLAGS.filter((f) => !new RegExp(`(^|[\\s,|\\[])${f.replace(/-/g, '\\-')}(?=[\\s,=\\]|]|$)`, 'm').test(help.text));
        const condMissing = CONDITIONING_FLAGS.filter((f) => !new RegExp(`(^|[\\s,|\\[])${f.replace(/-/g, '\\-')}(?=[\\s,=\\]|]|$)`, 'm').test(help.text));
        probeCache = { at: Date.now(), key, flagsMissing: missingFlags, conditioningFlagsMissing: condMissing, error: null };
      }
    }
    flagsMissing = probeCache.flagsMissing;
    if (probeCache.error) missing.push(`Runner probe failed: ${probeCache.error}.`);
    else if (flagsMissing.length > 0) missing.push(`This sd-cli build does not list: ${flagsMissing.join(', ')}. Check the release or the flags.`);
  }

  if (cfg.backend === 'vulkan') {
    const marker = path.join(cfg.root, 'vulkan-probe.json');
    let ok = false;
    try {
      const m = JSON.parse(fs.readFileSync(marker, 'utf8')) as { ok?: boolean };
      ok = m.ok === true;
    } catch {
      ok = false;
    }
    if (!ok) missing.push('Vulkan is selected but no successful Vulkan probe is recorded. Use the CPU baseline, or record the probe first.');
  }

  const ready = missing.length === 0;

  // Reference conditioning: its own readiness. Files are hashed in a stream and the result is cached.
  const condMissing: string[] = [];
  let ipMatch: boolean | null = null;
  let clipMatch: boolean | null = null;
  if (!cfg.ipAdapterPath || !fs.existsSync(cfg.ipAdapterPath)) condMissing.push('LOCAL_IMAGE_IP_ADAPTER is not set, or the file was not found (ip-adapter_sd15.safetensors, outside Git).');
  else if (!cfg.ipAdapterSha256) condMissing.push('LOCAL_IMAGE_IP_ADAPTER_SHA256 is not set. Record the IP-Adapter hash before using reference conditioning.');
  else {
    ipMatch = (await cachedFileSha256(cfg.ipAdapterPath)) === cfg.ipAdapterSha256;
    if (!ipMatch) condMissing.push('The IP-Adapter file does not match LOCAL_IMAGE_IP_ADAPTER_SHA256.');
  }
  if (!cfg.clipVisionPath || !fs.existsSync(cfg.clipVisionPath)) condMissing.push('LOCAL_IMAGE_CLIP_VISION is not set, or the file was not found (the ViT-H/14 CLIP-Vision encoder, outside Git).');
  else if (!cfg.clipVisionSha256) condMissing.push('LOCAL_IMAGE_CLIP_VISION_SHA256 is not set. Record the CLIP-Vision hash before using reference conditioning.');
  else {
    clipMatch = (await cachedFileSha256(cfg.clipVisionPath)) === cfg.clipVisionSha256;
    if (!clipMatch) condMissing.push('The CLIP-Vision file does not match LOCAL_IMAGE_CLIP_VISION_SHA256.');
  }
  const condFlagsMissing = probeCache?.conditioningFlagsMissing ?? [];
  if (runnerOk && condFlagsMissing.length > 0) condMissing.push(`This sd-cli build does not list the reference flags: ${condFlagsMissing.join(', ')}.`);
  return {
    state: ready ? 'ready' : 'setup_required',
    ready,
    reason: ready
      ? 'Ready. Local generation runs on this computer. No provider and no spend.'
      : 'Setup required. Local image generation is not ready: ' + missing[0],
    missing,
    project: LOCAL_IMAGE_PINNED.project,
    release: LOCAL_IMAGE_PINNED.release,
    backend: cfg.backend,
    steps: cfg.steps,
    timeoutSec: Math.round(cfg.timeoutMs / 1000),
    googleUsed: false,
    paidSpend: false,
    jobsAtOnce: 1,
    busy: active !== null,
    model: {
      name: LOCAL_IMAGE_PINNED.model.name,
      license: LOCAL_IMAGE_PINNED.model.license,
      upstreamSha256: LOCAL_IMAGE_PINNED.model.upstreamSha256,
      recordedMatchesUpstream: cfg.modelSha256 ? cfg.modelSha256 === LOCAL_IMAGE_PINNED.model.upstreamSha256 : null,
      sha256Pinned: Boolean(cfg.modelSha256),
      sha256Matches,
    },
    flagsChecked: REQUIRED_RUNNER_FLAGS,
    flagsMissing,
    conditioning: {
      ready: condMissing.length === 0 && runnerOk,
      missing: runnerOk ? condMissing : [...condMissing, 'The runner (LOCAL_IMAGE_RUNNER) is not available for reference conditioning.'],
      flagsChecked: CONDITIONING_FLAGS,
      flagsMissing: condFlagsMissing,
      ipAdapter: { name: LOCAL_IMAGE_PINNED.conditioning.ipAdapter.file, licence: LOCAL_IMAGE_PINNED.conditioning.ipAdapter.licence, sha256Matches: ipMatch },
      clipVision: { name: LOCAL_IMAGE_PINNED.conditioning.clipVision.file, licence: LOCAL_IMAGE_PINNED.conditioning.clipVision.licence, sha256Matches: clipMatch },
      strengthRange: { ...CONDITIONING_STRENGTH_RANGE },
    },
  };
}

/* ------------------------------------------------------------------ */
/* PNG validation (decode check, no image library)                     */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Throws LOCAL_IMAGE_INVALID_OUTPUT unless the bytes are a complete, decodable 8-bit PNG of w x h. */
export function validatePng(buf: Buffer, width: number, height: number): void {
  const bad = (why: string): never => {
    throw new LocalImageError('LOCAL_IMAGE_INVALID_OUTPUT', `The generated file is not a valid PNG (${why}). It was not saved.`, 422);
  };
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) bad('signature');
  let pos = 8;
  let ihdr: { w: number; h: number; depth: number; ctype: number; interlace: number } | null = null;
  const idat: Buffer[] = [];
  let sawEnd = false;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) bad('truncated chunk');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const crc = buf.readUInt32BE(pos + 8 + len);
    if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== crc) bad(`CRC of ${type}`);
    if (type === 'IHDR') {
      if (len !== 13) bad('IHDR length');
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], ctype: data[9], interlace: data[12] };
      if (data[10] !== 0 || data[11] !== 0) bad('IHDR method');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') {
      sawEnd = true;
      pos += 12 + len;
      break;
    }
    pos += 12 + len;
  }
  if (!ihdr) bad('missing IHDR');
  if (!sawEnd) bad('missing IEND');
  if (pos !== buf.length) bad('trailing bytes after IEND');
  const h = ihdr!;
  if (h.w !== width || h.h !== height) bad(`size ${h.w}x${h.h}, expected ${width}x${height}`);
  if (h.depth !== 8) bad('bit depth');
  if (h.interlace !== 0) bad('interlaced');
  const channels = h.ctype === 2 ? 3 : h.ctype === 6 ? 4 : h.ctype === 0 ? 1 : 0;
  if (!channels) bad('colour type');
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return bad('image data does not inflate');
  }
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) bad('image data length');
  for (let y = 0; y < height; y++) {
    if (raw[y * (stride + 1)] > 4) bad('filter type');
  }
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export type LocalJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';

/**
 * The shot identity the job was generated for: the composed prompt and its inputs, fingerprinted by the server.
 * Approve and bind compare it with the shot as it is NOW. A change to the visual description, the composed
 * prompt or negative, the aspect or the profile makes the candidate stale. Unrelated edits do not.
 * null for a job recorded before this check existed: such a candidate is never approved or bound.
 */
export interface CandidateShot {
  fingerprint: string;
  visualDescription: string;
  aspect: 'landscape' | 'portrait';
  profile: string;
}

/** The reference picture a job was conditioned on. The file is a copy taken at start; its hash is checked again. */
export interface LocalConditioning {
  assetId: string;
  /** SHA-256 of the reference bytes that were copied and passed to the runner. */
  sha256: string;
  mimeType: 'image/png' | 'image/jpeg';
  strength: number;
  ipAdapterSha256: string;
  clipVisionSha256: string;
  /** File name inside the job folder: the copy the runner was given with --ip-adapter-image. */
  file: string;
}

export interface LocalImageJob {
  id: string;
  draftId: string;
  sceneId: string;
  shot: CandidateShot | null;
  state: LocalJobState;
  progress: number;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  backend: 'cpu' | 'vulkan';
  /** null for a text-to-image job. Set only when a reference picture conditions the still. */
  conditioning: LocalConditioning | null;
  createdAt: string;
  updatedAt: string;
  error: { code: string; message: string } | null;
  approvedAssetId: string | null;
  provenance: null | {
    project: string;
    release: string;
    modelName: string;
    modelSha256: string;
    modelLicense: string;
    promptSha256: string;
    /** Per-shot negative conditioning sent with -n. Recorded so a preview can be traced to its exclusions. */
    negativePromptSha256: string;
    seed: number;
    width: number;
    height: number;
    steps: number;
    backend: 'cpu' | 'vulkan';
    outputSha256: string;
    /** The reference that conditioned this still, or null. */
    conditioning: LocalConditioning | null;
    generatedAt: string;
    vaeTiling?: boolean;
  };
}

const JOB_ID_RE = /^lij_[a-f0-9]{16}$/;
const jobsDir = (cfg: LocalImageConfig) => path.join(cfg.root, 'jobs');
const jobFile = (cfg: LocalImageConfig, id: string) => path.join(jobsDir(cfg), `${id}.json`);
const outFile = (cfg: LocalImageConfig, id: string) => path.join(jobsDir(cfg), id, 'candidate.png');

function saveJob(cfg: LocalImageConfig, job: LocalImageJob): void {
  fs.mkdirSync(jobsDir(cfg), { recursive: true });
  const file = jobFile(cfg, job.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function getLocalJob(id: string, cfg: LocalImageConfig = localImageConfig()): LocalImageJob {
  if (!JOB_ID_RE.test(id)) throw new LocalImageError('LOCAL_IMAGE_NOT_FOUND', 'Job not found.', 404);
  try {
    return JSON.parse(fs.readFileSync(jobFile(cfg, id), 'utf8')) as LocalImageJob;
  } catch {
    throw new LocalImageError('LOCAL_IMAGE_NOT_FOUND', 'Job not found.', 404);
  }
}

/** Jobs that were running when the server stopped are marked interrupted. Nothing is resumed. */
export function recoverLocalJobs(cfg: LocalImageConfig = localImageConfig()): void {
  if (!fs.existsSync(jobsDir(cfg))) return;
  for (const f of fs.readdirSync(jobsDir(cfg))) {
    if (!f.endsWith('.json')) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobsDir(cfg), f), 'utf8')) as LocalImageJob;
      if (job.state === 'running' || job.state === 'queued') {
        job.state = 'interrupted';
        job.error = { code: 'LOCAL_IMAGE_FAILED', message: 'The server stopped during generation. Start the job again.' };
        job.updatedAt = new Date().toISOString();
        saveJob(cfg, job);
      }
    } catch {
      // A damaged job file is ignored; it is never registered.
    }
  }
}

interface Active {
  id: string;
  child: ChildProcess | null;
  cancelled: boolean;
  timedOut: boolean;
}
let active: Active | null = null;

export function activeJobId(): string | null {
  return active?.id ?? null;
}

/**
 * Starts one job. The caller passes the shot prompt (see factory-service stillRequestFor).
 * Returns the queued job at once. Generation runs in the background; poll the job.
 */
export async function startLocalJob(input: {
  draftId: string;
  sceneId: string;
  /** The shot identity this job is generated for (see factory-service candidateIdentityFor). */
  shot: CandidateShot;
  prompt: string;
  /** Per-shot negative conditioning, built by the server from this shot's exclusions. */
  negativePrompt: string;
  aspect: 'landscape' | 'portrait';
  seed?: number;
  /** Optional reference picture for IP-Adapter conditioning. The server resolves it; the runner gets the picture itself. */
  conditioning?: { assetId: string; sourcePath: string; sourceSha256: string; mimeType: 'image/png' | 'image/jpeg'; strength: number };
}, cfg: LocalImageConfig = localImageConfig()): Promise<LocalImageJob> {
  const status = await localImageStatus(cfg);
  if (!status.ready) {
    throw new LocalImageError('LOCAL_IMAGE_SETUP_REQUIRED', status.reason, 503, { missing: status.missing });
  }
  if (active) throw new LocalImageError('LOCAL_IMAGE_BUSY', 'Another local image is being generated. Wait for it or cancel it.', 409);
  const seed = input.seed ?? crypto.randomInt(1, 2_147_483_647);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) throw new LocalImageError('LOCAL_IMAGE_VALIDATION', 'The seed must be an integer from 0 to 2147483647.', 422);
  if (typeof input.negativePrompt !== 'string' || input.negativePrompt.length === 0 || input.negativePrompt.length > 1000) {
    throw new LocalImageError('LOCAL_IMAGE_VALIDATION', 'The negative prompt must be 1 to 1000 characters.', 422);
  }
  const { width, height } = LOCAL_IMAGE_SIZES[input.aspect];
  const now = new Date().toISOString();
  let conditioning: LocalConditioning | null = null;
  if (input.conditioning) {
    const c = input.conditioning;
    if (!status.conditioning.ready) {
      throw new LocalImageError('LOCAL_IMAGE_SETUP_REQUIRED', 'Reference conditioning is not ready on this computer. Generate without a reference, or set it up first.', 503, { missing: status.conditioning.missing });
    }
    if (!Number.isFinite(c.strength) || c.strength < CONDITIONING_STRENGTH_RANGE.min || c.strength > CONDITIONING_STRENGTH_RANGE.max) {
      throw new LocalImageError('LOCAL_IMAGE_VALIDATION', 'The reference strength must be from 0.1 to 1.0.', 422);
    }
    if (c.mimeType !== 'image/png' && c.mimeType !== 'image/jpeg') {
      throw new LocalImageError('LOCAL_IMAGE_VALIDATION', 'Reference conditioning accepts PNG or JPEG pictures. Choose another picture.', 422);
    }
    // The reference the runner reads must be the one the shot was approved against. A changed file is refused here.
    if ((await cachedFileSha256(c.sourcePath)) !== c.sourceSha256) {
      throw new LocalImageError('LOCAL_IMAGE_REFERENCE_CHANGED', 'The reference picture changed after it was chosen. Choose it again.', 409);
    }
    conditioning = {
      assetId: c.assetId,
      sha256: c.sourceSha256,
      mimeType: c.mimeType,
      strength: c.strength,
      ipAdapterSha256: cfg.ipAdapterSha256 as string,
      clipVisionSha256: cfg.clipVisionSha256 as string,
      file: c.mimeType === 'image/png' ? 'reference.png' : 'reference.jpg',
    };
  }
  if (!input.shot || typeof input.shot.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.shot.fingerprint)) {
    throw new LocalImageError('LOCAL_IMAGE_VALIDATION', 'The shot identity is missing. Reload the shot and generate again.', 422);
  }
  const job: LocalImageJob = {
    id: `lij_${crypto.randomBytes(8).toString('hex')}`,
    draftId: input.draftId,
    sceneId: input.sceneId,
    shot: { ...input.shot },
    state: 'queued',
    progress: 0,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    width,
    height,
    seed,
    steps: cfg.steps,
    backend: cfg.backend,
    conditioning,
    createdAt: now,
    updatedAt: now,
    error: null,
    approvedAssetId: null,
    provenance: null,
  };
  fs.mkdirSync(path.join(jobsDir(cfg), job.id), { recursive: true });
  if (input.conditioning && conditioning) {
    // The runner gets a copy of the picture inside the job folder, and the copy must hash to the same SHA-256.
    const copy = path.join(jobsDir(cfg), job.id, conditioning.file);
    fs.copyFileSync(input.conditioning.sourcePath, copy);
    if ((await sha256FileStream(copy)) !== conditioning.sha256) {
      fs.rmSync(copy, { force: true });
      throw new LocalImageError('LOCAL_IMAGE_REFERENCE_CHANGED', 'The reference picture changed while it was being copied. Choose it again.', 409);
    }
  }
  saveJob(cfg, job);
  active = { id: job.id, child: null, cancelled: false, timedOut: false };
  // Any unexpected error still ends the job and frees the one-job slot. Nothing is saved on error.
  void runLocalJob(job.id, cfg)
    .catch(() => {
      try {
        const j = getLocalJob(job.id, cfg);
        if (j.state === 'queued' || j.state === 'running') {
          finish(cfg, j, 'failed', { code: 'LOCAL_IMAGE_FAILED', message: 'The local runner stopped unexpectedly. Nothing was saved.' });
        }
      } catch {
        // The job file is unreadable; nothing to record.
      }
    })
    .finally(() => {
      if (active?.id === job.id) active = null;
    });
  return job;
}

function finish(cfg: LocalImageConfig, job: LocalImageJob, state: LocalJobState, error: LocalImageJob['error']): LocalImageJob {
  job.state = state;
  job.error = error;
  job.updatedAt = new Date().toISOString();
  if (state === 'succeeded') job.progress = 1;
  saveJob(cfg, job);
  return job;
}

async function runLocalJob(id: string, cfg: LocalImageConfig): Promise<void> {
  const job = getLocalJob(id, cfg);
  const act = active!;
  const status = await localImageStatus(cfg);
  const modelSha = status.model.sha256Matches ? (cfg.modelSha256 as string) : '';
  const out = outFile(cfg, id);
  const args = [
    '-m', cfg.modelPath as string,
    '-p', job.prompt,
    '-n', job.negativePrompt,
    '-W', String(job.width),
    '-H', String(job.height),
    '-s', String(job.seed),
    '--steps', String(job.steps),
    '--cfg-scale', String(CFG_SCALE),
    '--vae-tiling',
    // Reference conditioning: the picture itself, the encoder and the adapter, with the strength the owner chose.
    ...(job.conditioning
      ? [
        '--clip_vision', cfg.clipVisionPath as string,
        '--ip-adapter', cfg.ipAdapterPath as string,
        '--ip-adapter-image', path.join(jobsDir(cfg), id, job.conditioning.file),
        '--ip-adapter-strength', job.conditioning.strength.toFixed(2),
      ]
      : []),
    '-o', out,
  ];
  let tail = '';
  job.state = 'running';
  job.updatedAt = new Date().toISOString();
  saveJob(cfg, job);

  const result = await new Promise<{ code: number | null; signal: string | null; error?: string }>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(...runnerCommand(cfg.runnerPath as string, args), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: null, signal: null, error: 'the runner could not be started' });
      return;
    }
    act.child = child;
    const timer = setTimeout(() => {
      act.timedOut = true;
      child.kill('SIGKILL');
    }, cfg.timeoutMs);
    const onData = (d: Buffer) => {
      const text = d.toString();
      tail = (tail + text).slice(-2000);
      // Progress lines look like "|==>   | 5/20 - 1.2s/it". Keep the last step seen.
      const m = [...text.matchAll(/(\d+)\/(\d+)\s*-/g)].pop();
      if (m && Number(m[2]) === job.steps) {
        const p = Math.min(0.95, Number(m[1]) / Number(m[2]) * 0.95);
        if (p > job.progress) {
          job.progress = p;
          saveJob(cfg, job);
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, error: 'the runner could not be started' });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  active = null;
  if (act.cancelled) {
    finish(cfg, job, 'cancelled', { code: 'LOCAL_IMAGE_STATE', message: 'Cancelled. Nothing was saved.' });
    return;
  }
  if (act.timedOut) {
    finish(cfg, job, 'timed_out', { code: 'LOCAL_IMAGE_TIMEOUT', message: `The generation did not finish within ${Math.round(cfg.timeoutMs / 1000)} seconds. Nothing was saved. Lower the steps or raise the timeout.` });
    return;
  }
  if (result.error || result.code !== 0) {
    const last = tail.split(/\r?\n/).filter((l) => l.trim()).pop() ?? '';
    const safe = last.replace(/[A-Za-z]:\\[^\s"']*/g, '[path]').replace(/\/[^\s"']*\//g, '[path]').slice(0, 160);
    finish(cfg, job, 'failed', { code: 'LOCAL_IMAGE_FAILED', message: result.error ?? `The runner stopped with code ${result.code}${safe ? `: ${safe}` : ''}. Nothing was saved.` });
    return;
  }
  try {
    if (!fs.existsSync(out)) throw new LocalImageError('LOCAL_IMAGE_INVALID_OUTPUT', 'The runner finished but wrote no image. Nothing was saved.', 422);
    const bytes = fs.readFileSync(out);
    validatePng(bytes, job.width, job.height);
    job.provenance = {
      project: LOCAL_IMAGE_PINNED.project,
      release: LOCAL_IMAGE_PINNED.release,
      modelName: path.basename(cfg.modelPath as string),
      modelSha256: modelSha || cachedModelHash(cfg.modelPath as string),
      modelLicense: LOCAL_IMAGE_PINNED.model.license,
      promptSha256: crypto.createHash('sha256').update(job.prompt).digest('hex'),
      negativePromptSha256: crypto.createHash('sha256').update(job.negativePrompt).digest('hex'),
      seed: job.seed,
      width: job.width,
      height: job.height,
      steps: job.steps,
      backend: job.backend,
      outputSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      conditioning: job.conditioning,
      generatedAt: new Date().toISOString(),
      vaeTiling: true,
    };
    finish(cfg, job, 'succeeded', null);
  } catch (err) {
    if (err instanceof LocalImageError) finish(cfg, job, 'failed', { code: err.code, message: err.message });
    else finish(cfg, job, 'failed', { code: 'LOCAL_IMAGE_FAILED', message: 'The output could not be read. Nothing was saved.' });
  }
}

/** Cancels the running job (kills the runner) or marks a queued one cancelled. */
export function cancelLocalJob(id: string, cfg: LocalImageConfig = localImageConfig()): LocalImageJob {
  const job = getLocalJob(id, cfg);
  if (active && active.id === id) {
    active.cancelled = true;
    active.child?.kill('SIGKILL');
    return getLocalJob(id, cfg);
  }
  if (job.state === 'queued') return finish(cfg, job, 'cancelled', { code: 'LOCAL_IMAGE_STATE', message: 'Cancelled before it started. Nothing was saved.' });
  throw new LocalImageError('LOCAL_IMAGE_STATE', `This job is ${job.state}; there is nothing to cancel.`, 409);
}

/**
 * Registers an approved candidate in the asset library, once. Same job, same asset.
 * The file is copied to the asset folder; the provenance is kept on the record.
 */
export function approveLocalJob(id: string, cfg: LocalImageConfig = localImageConfig()): { job: LocalImageJob; assetId: string } {
  const job = getLocalJob(id, cfg);
  if (job.state !== 'succeeded' || !job.provenance) {
    throw new LocalImageError('LOCAL_IMAGE_STATE', `Only a succeeded preview can be approved. This job is ${job.state}.`, 409);
  }
  if (job.approvedAssetId) return { job, assetId: job.approvedAssetId };
  const bytes = fs.readFileSync(outFile(cfg, id));
  validatePng(bytes, job.width, job.height);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const assetId = `loc_${sha.slice(0, 16)}`;
  const fileName = `${assetId}.png`;
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const file = path.join(ASSETS_DIR, fileName);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  const index = loadAssetIndex();
  // Identical bytes are one asset. If it already exists under another candidate identity (the same picture was made
  // again for the same or another shot), the approval just given is the latest identity: re-stamp the record so the
  // bind checks this shot's current fingerprint, not a superseded one.
  const existing = index.find((a: any) => a.id === assetId) as any;
  if (existing && job.shot) {
    const next = { jobId: job.id, draftId: job.draftId, sceneId: job.sceneId, fingerprint: job.shot.fingerprint };
    const prev = existing.localCandidate ?? null;
    if (!prev || prev.jobId !== next.jobId || prev.draftId !== next.draftId || prev.sceneId !== next.sceneId || prev.fingerprint !== next.fingerprint) {
      existing.localCandidate = next;
      saveAssetIndex(index);
    }
  }
  if (!existing) {
    const record = {
      id: assetId,
      name: `Local still ${assetId.slice(4, 12)} (${job.provenance.release}, seed ${job.seed})`,
      kind: 'broll',
      fileName,
      path: fileName,
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      tags: ['generated-locally', 'still'],
      status: 'active',
      preferred: false,
      source: `Generated locally on the owner's computer: ${job.provenance.project} ${job.provenance.release}, model ${job.provenance.modelName} (sha256 ${job.provenance.modelSha256}), seed ${job.seed}. Not a screen recording.`,
      license: `Generated locally from ${job.provenance.modelLicense} model weights. Owner review required before publication.`,
      provenance: job.provenance,
      /** The shot this candidate was generated for. Binding checks it against the shot as it is now. */
      localCandidate: job.shot ? { jobId: job.id, draftId: job.draftId, sceneId: job.sceneId, fingerprint: job.shot.fingerprint } : null,
      addedAt: new Date().toISOString(),
      usedIn: [],
      blocked: false,
    };
    saveAssetIndex([...index, record as never]);
  }
  job.approvedAssetId = assetId;
  job.updatedAt = new Date().toISOString();
  saveJob(cfg, job);
  return { job, assetId };
}

/** Candidate PNG bytes for preview. Only for a succeeded job whose file still validates. */
export function localJobImage(id: string, cfg: LocalImageConfig = localImageConfig()): Buffer {
  const job = getLocalJob(id, cfg);
  if (job.state !== 'succeeded') throw new LocalImageError('LOCAL_IMAGE_STATE', 'No preview: this job did not succeed.', 409);
  const bytes = fs.readFileSync(outFile(cfg, id));
  validatePng(bytes, job.width, job.height);
  return bytes;
}

/** Test helper: removes the in-memory worker state. Not used by routes. */
export function resetLocalImageWorkerForTests(): void {
  active = null;
  probeCache = null;
  hashCache.clear();
}
