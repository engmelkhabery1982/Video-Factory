/**
 * BuildTrack Video Factory - VS2 Chatterbox Worker Protocol
 *
 * Pure, versioned JSON contract between the Node adapter
 * (`chatterbox-dialogue-synthesizer.ts`) and the isolated Python worker
 * (`tools/chatterbox/worker.py`), plus the failure taxonomy those two sides
 * share and the diagnostics redaction rules.
 *
 * Design rules (all enforced by the validators below):
 *   - the manifest carries a schema id AND a numeric protocol version; a worker
 *     answering with any other version is rejected, never trusted;
 *   - every data path in the manifest is REPO-RELATIVE and portable — absolute
 *     paths (POSIX or Windows) and traversal are protocol errors;
 *   - a response is validated field-by-field BEFORE its audio is used; a
 *     partially-specified success is not accepted;
 *   - the failure taxonomy maps 1:1 onto `AudioSynthesisErrorCode`s so a
 *     worker failure can never be silently swallowed;
 *   - diagnostics identify engine / model / failure category / remediation
 *     without leaking personal paths or machine secrets.
 *
 * No I/O, no clock, no network — pure contracts (Phase 4A doctrine).
 */

import type { AudioSynthesisErrorCode } from './audio-synthesis-types.js';
import {
  CHATTERBOX_ENGINE_ID,
  CHATTERBOX_SAMPLE_RATE,
  type ChatterboxEngineContractId,
  type ChatterboxVoiceSettings,
} from './chatterbox-voice-identity.js';

/* ------------------------------------------------------------------ */
/*  Schema identity and limits                                         */
/* ------------------------------------------------------------------ */

export const CHATTERBOX_WORKER_PROTOCOL_VERSION = 1 as const;
export const CHATTERBOX_WORKER_REQUEST_SCHEMA = 'chatterbox-worker-request/v1' as const;
export const CHATTERBOX_WORKER_RESPONSE_SCHEMA = 'chatterbox-worker-response/v1' as const;

/** Hard bounds of one worker invocation. */
export const CHATTERBOX_WORKER_LIMITS = Object.freeze({
  /** Mirrors the Kokoro/SAM text bound so no engine accepts longer text. */
  maxTextChars: 5000,
  /** Default bounded timeout for a real GPU synthesis (first load included). */
  defaultTimeoutMs: 900_000,
  /** Grace between SIGTERM and SIGKILL when a worker must be terminated. */
  terminationGraceMs: 5_000,
  /** Bounded stdout capture: a response larger than this is not trusted. */
  maxStdoutBytes: 1_048_576,
  /** Bounded stderr capture kept for diagnostics only. */
  maxStderrBytes: 262_144,
  /** Message truncation for diagnostics. */
  maxDiagnosticChars: 600,
});

/* ------------------------------------------------------------------ */
/*  Request manifest                                                   */
/* ------------------------------------------------------------------ */

export interface ChatterboxWorkerAudioTarget {
  /** Repo-relative scratch path the worker writes its RAW 24 kHz WAV to. */
  path: string;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  container: 'wav';
}

export interface ChatterboxWorkerReference {
  /** Repo-relative reference recording path. */
  path: string;
  /** SHA-256 the worker must re-verify before using the recording. */
  sha256: string;
}

export interface ChatterboxWorkerRequest {
  schema: typeof CHATTERBOX_WORKER_REQUEST_SCHEMA;
  protocolVersion: typeof CHATTERBOX_WORKER_PROTOCOL_VERSION;
  /** Deterministic id derived from the request material (no clock). */
  requestId: string;
  /** Engine contract that must run; anything else is a manifest mismatch. */
  engineContractId: ChatterboxEngineContractId;
  /** Model repository id. */
  modelId: string;
  /** RESOLVED model revision recorded at provisioning time. */
  modelRevision: string;
  /** Chatterbox language id (one of the contract's languages). */
  languageId: string;
  /** Exact spoken text — byte-for-byte source authority. */
  text: string;
  /** Reference recording identity (always present for a cloned voice). */
  referenceAudio: ChatterboxWorkerReference;
  /** Declared settings; `settingsSupported` states whether they can be honoured. */
  settings: ChatterboxVoiceSettings;
  settingsSupported: boolean;
  /** Repo-relative model/cache directory the worker must load from (offline). */
  modelDir: string;
  /** Where the raw engine output must be written (always scratch). */
  output: ChatterboxWorkerAudioTarget;
  /** Device policy the worker must satisfy; never silently downgraded here. */
  device: 'cuda' | 'cpu';
  /** The worker must prove the Perth watermark was applied. */
  requireWatermark: true;
}

/* ------------------------------------------------------------------ */
/*  Response manifest                                                  */
/* ------------------------------------------------------------------ */

export interface ChatterboxWorkerEngineReport {
  contractId: ChatterboxEngineContractId;
  modelId: string;
  modelRevision: string;
  /**
   * Checkpoint variant actually loaded. `v3` for the multilingual contract.
   * Absent on workers that predate the post-VS7 correction. A present value
   * that is not the promised variant is a mismatch, not a fallback.
   */
  modelVariant?: string | null;
  packageVersion: string;
  pythonVersion: string;
  device: string;
  torchVersion?: string;
  cudaRuntimeVersion?: string;
  gpuName?: string;
}

export interface ChatterboxWorkerAudioReport {
  /** Repo-relative path actually written (must equal the requested one). */
  path: string;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  durationSeconds: number;
  frameCount: number;
  /** SHA-256 of the bytes on disk, recomputed by the adapter as well. */
  sha256: string;
}

export type ChatterboxWorkerErrorCategory =
  | 'MISSING_PYTHON'
  | 'MISSING_DEPENDENCY'
  | 'MODEL_MISSING'
  | 'MODEL_REVISION_MISMATCH'
  | 'CUDA_REQUIRED'
  | 'CUDA_INIT_FAILED'
  | 'GPU_OUT_OF_MEMORY'
  | 'UNSUPPORTED_LANGUAGE'
  | 'INVALID_REFERENCE'
  | 'SYNTHESIS_FAILED'
  | 'OUTPUT_WRITE_FAILED'
  | 'EMPTY_AUDIO'
  | 'WATERMARK_MISSING'
  | 'INTERNAL_ERROR';

export const CHATTERBOX_WORKER_ERROR_CATEGORIES: readonly ChatterboxWorkerErrorCategory[] =
  Object.freeze([
    'MISSING_PYTHON',
    'MISSING_DEPENDENCY',
    'MODEL_MISSING',
    'MODEL_REVISION_MISMATCH',
    'CUDA_REQUIRED',
    'CUDA_INIT_FAILED',
    'GPU_OUT_OF_MEMORY',
    'UNSUPPORTED_LANGUAGE',
    'INVALID_REFERENCE',
    'SYNTHESIS_FAILED',
    'OUTPUT_WRITE_FAILED',
    'EMPTY_AUDIO',
    'WATERMARK_MISSING',
    'INTERNAL_ERROR',
  ]);

export interface ChatterboxWorkerResponse {
  schema: typeof CHATTERBOX_WORKER_RESPONSE_SCHEMA;
  protocolVersion: typeof CHATTERBOX_WORKER_PROTOCOL_VERSION;
  requestId: string;
  status: 'ok' | 'error';
  engine?: ChatterboxWorkerEngineReport;
  watermark?: { provider: string; applied: boolean };
  audio?: ChatterboxWorkerAudioReport;
  settingsApplied?: { exaggeration: boolean; cfgWeight: boolean; minP: boolean };
  error?: { category: ChatterboxWorkerErrorCategory; message: string; remediation?: string };
  timings?: { loadMs?: number; synthesizeMs?: number };
}

/* ------------------------------------------------------------------ */
/*  Protocol errors                                                    */
/* ------------------------------------------------------------------ */

export type ChatterboxWorkerProtocolErrorCode =
  | 'MALFORMED_REQUEST'
  | 'INVALID_JSON'
  | 'MANIFEST_VERSION_MISMATCH'
  | 'REQUEST_ID_MISMATCH'
  | 'MALFORMED_RESPONSE';

export class ChatterboxWorkerProtocolError extends Error {
  public readonly code: ChatterboxWorkerProtocolErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ChatterboxWorkerProtocolErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ChatterboxWorkerProtocolError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/*  Shared validation helpers                                          */
/* ------------------------------------------------------------------ */

/** Portable repo-relative path check used by the manifest validators. */
export function isPortableRelativeManifestPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(trimmed)) return false;
  const segments = trimmed.split(/[/\\]/);
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return false;
  if (/[\u0000-\u001f<>:"|?*]/.test(trimmed)) return false;
  return true;
}

/** 64 lowercase hex characters. */
export function isSha256HexDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/* ------------------------------------------------------------------ */
/*  Request validation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Validate an outgoing request manifest. Throws `MALFORMED_REQUEST` with a
 * deterministic problem list; the adapter never spawns a worker for an invalid
 * manifest, so a malformed request can never reach Python.
 */
export function assertChatterboxWorkerRequest(value: unknown): ChatterboxWorkerRequest {
  const problems: string[] = [];
  if (!value || typeof value !== 'object') {
    throw new ChatterboxWorkerProtocolError('MALFORMED_REQUEST', 'Request must be a JSON object.', {
      problems: ['not an object'],
    });
  }
  const raw = value as Record<string, unknown>;

  if (raw.schema !== CHATTERBOX_WORKER_REQUEST_SCHEMA) {
    problems.push(`schema must be '${CHATTERBOX_WORKER_REQUEST_SCHEMA}'`);
  }
  if (raw.protocolVersion !== CHATTERBOX_WORKER_PROTOCOL_VERSION) {
    problems.push(`protocolVersion must be ${CHATTERBOX_WORKER_PROTOCOL_VERSION}`);
  }
  if (!isNonEmptyString(raw.requestId)) problems.push('requestId must be a non-empty string');
  if (!isNonEmptyString(raw.engineContractId)) problems.push('engineContractId is required');
  if (!isNonEmptyString(raw.modelId)) problems.push('modelId is required');
  if (!isNonEmptyString(raw.modelRevision)) problems.push('modelRevision is required');
  if (!isNonEmptyString(raw.languageId)) problems.push('languageId is required');
  if (typeof raw.text !== 'string' || raw.text.trim().length === 0) {
    problems.push('text must be a non-empty string');
  } else if (raw.text.length > CHATTERBOX_WORKER_LIMITS.maxTextChars) {
    problems.push(`text exceeds ${CHATTERBOX_WORKER_LIMITS.maxTextChars} characters`);
  }
  if (raw.device !== 'cuda' && raw.device !== 'cpu') {
    problems.push("device must be 'cuda' or 'cpu'");
  }
  if (raw.requireWatermark !== true) problems.push('requireWatermark must be true');
  if (!isPortableRelativeManifestPath(raw.modelDir)) {
    problems.push('modelDir must be a portable repo-relative path');
  }

  const reference = raw.referenceAudio as Record<string, unknown> | undefined;
  if (!reference || typeof reference !== 'object') {
    problems.push('referenceAudio is required');
  } else {
    if (!isPortableRelativeManifestPath(reference.path)) {
      problems.push('referenceAudio.path must be a portable repo-relative path');
    }
    if (!isSha256HexDigest(reference.sha256)) {
      problems.push('referenceAudio.sha256 must be 64 lowercase hex characters');
    }
  }

  const settings = raw.settings as Record<string, unknown> | undefined;
  if (!settings || typeof settings !== 'object') {
    problems.push('settings is required');
  } else {
    if (!isFiniteNumberInRange(settings.exaggeration, 0, 1)) {
      problems.push('settings.exaggeration must be within [0, 1]');
    }
    if (!isFiniteNumberInRange(settings.cfgWeight, 0, 2)) {
      problems.push('settings.cfgWeight must be within [0, 2]');
    }
    if (settings.minP !== undefined && !isFiniteNumberInRange(settings.minP, 0, 1)) {
      problems.push('settings.minP must be within [0, 1] when present');
    }
  }

  const output = raw.output as Record<string, unknown> | undefined;
  if (!output || typeof output !== 'object') {
    problems.push('output is required');
  } else {
    if (!isPortableRelativeManifestPath(output.path)) {
      problems.push('output.path must be a portable repo-relative path');
    }
    if (output.sampleRate !== CHATTERBOX_SAMPLE_RATE) {
      problems.push(`output.sampleRate must be ${CHATTERBOX_SAMPLE_RATE}`);
    }
    if (output.channels !== 1) problems.push('output.channels must be 1');
    if (output.bitDepth !== 16) problems.push('output.bitDepth must be 16');
    if (output.container !== 'wav') problems.push("output.container must be 'wav'");
  }

  if (problems.length > 0) {
    throw new ChatterboxWorkerProtocolError(
      'MALFORMED_REQUEST',
      `Chatterbox worker request is malformed (${problems.length} problem(s)).`,
      { problems }
    );
  }

  return raw as unknown as ChatterboxWorkerRequest;
}

/* ------------------------------------------------------------------ */
/*  Response parsing / validation                                      */
/* ------------------------------------------------------------------ */

/**
 * Parse and validate a worker response. Version and request-id checks happen
 * before any field is read, so a stale or foreign payload is rejected rather
 * than partially trusted.
 */
export function parseChatterboxWorkerResponse(
  raw: string,
  expected: { requestId: string }
): ChatterboxWorkerResponse {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ChatterboxWorkerProtocolError('INVALID_JSON', 'Worker produced no response on stdout.', {
      requestId: expected.requestId,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ChatterboxWorkerProtocolError(
      'INVALID_JSON',
      `Worker stdout is not valid JSON: ${(e as Error).message}`,
      { requestId: expected.requestId }
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ChatterboxWorkerProtocolError('MALFORMED_RESPONSE', 'Worker response must be a JSON object.', {
      requestId: expected.requestId,
    });
  }
  const value = parsed as Record<string, unknown>;

  if (value.schema !== CHATTERBOX_WORKER_RESPONSE_SCHEMA) {
    throw new ChatterboxWorkerProtocolError(
      'MANIFEST_VERSION_MISMATCH',
      `Worker response schema '${String(value.schema)}' is not '${CHATTERBOX_WORKER_RESPONSE_SCHEMA}'.`,
      { requestId: expected.requestId, actualSchema: value.schema }
    );
  }
  if (value.protocolVersion !== CHATTERBOX_WORKER_PROTOCOL_VERSION) {
    throw new ChatterboxWorkerProtocolError(
      'MANIFEST_VERSION_MISMATCH',
      `Worker protocol version '${String(value.protocolVersion)}' is not ${CHATTERBOX_WORKER_PROTOCOL_VERSION}.`,
      { requestId: expected.requestId, actualProtocolVersion: value.protocolVersion }
    );
  }
  if (value.requestId !== expected.requestId) {
    throw new ChatterboxWorkerProtocolError(
      'REQUEST_ID_MISMATCH',
      'Worker response does not answer this request.',
      { requestId: expected.requestId, actualRequestId: value.requestId }
    );
  }
  if (value.status !== 'ok' && value.status !== 'error') {
    throw new ChatterboxWorkerProtocolError(
      'MALFORMED_RESPONSE',
      `Worker status must be 'ok' or 'error' (got '${String(value.status)}').`,
      { requestId: expected.requestId }
    );
  }

  if (value.status === 'error') {
    const error = value.error as Record<string, unknown> | undefined;
    if (!error || typeof error !== 'object') {
      throw new ChatterboxWorkerProtocolError('MALFORMED_RESPONSE', 'Error response has no error detail.', {
        requestId: expected.requestId,
      });
    }
    const category = error.category;
    if (
      typeof category !== 'string' ||
      !CHATTERBOX_WORKER_ERROR_CATEGORIES.includes(category as ChatterboxWorkerErrorCategory)
    ) {
      throw new ChatterboxWorkerProtocolError(
        'MALFORMED_RESPONSE',
        `Unknown worker error category '${String(category)}'.`,
        { requestId: expected.requestId, category }
      );
    }
    if (!isNonEmptyString(error.message)) {
      throw new ChatterboxWorkerProtocolError('MALFORMED_RESPONSE', 'Error response message is empty.', {
        requestId: expected.requestId,
      });
    }
    return value as unknown as ChatterboxWorkerResponse;
  }

  /* status === 'ok': a success must be fully specified, or it is rejected. */
  const problems: string[] = [];
  const engine = value.engine as Record<string, unknown> | undefined;
  if (!engine || typeof engine !== 'object') {
    problems.push('engine report is required on success');
  } else {
    if (!isNonEmptyString(engine.contractId)) problems.push('engine.contractId is required');
    if (!isNonEmptyString(engine.modelId)) problems.push('engine.modelId is required');
    if (!isNonEmptyString(engine.modelRevision)) problems.push('engine.modelRevision is required');
    if (!isNonEmptyString(engine.packageVersion)) problems.push('engine.packageVersion is required');
    if (!isNonEmptyString(engine.pythonVersion)) problems.push('engine.pythonVersion is required');
    if (!isNonEmptyString(engine.device)) problems.push('engine.device is required');
  }

  const watermark = value.watermark as Record<string, unknown> | undefined;
  if (!watermark || typeof watermark !== 'object') {
    problems.push('watermark report is required on success');
  } else {
    if (!isNonEmptyString(watermark.provider)) problems.push('watermark.provider is required');
    /* `applied` must be a BOOLEAN: a structurally missing watermark report is
     * malformed, while an explicit `false` is a truthful negative answer that
     * the adapter turns into CHATTERBOX_WATERMARK_MISSING. */
    if (typeof watermark.applied !== 'boolean') {
      problems.push('watermark.applied must be a boolean');
    }
  }

  const audio = value.audio as Record<string, unknown> | undefined;
  if (!audio || typeof audio !== 'object') {
    problems.push('audio report is required on success');
  } else {
    if (!isPortableRelativeManifestPath(audio.path)) {
      problems.push('audio.path must be a portable repo-relative path');
    }
    if (audio.sampleRate !== CHATTERBOX_SAMPLE_RATE) {
      problems.push(`audio.sampleRate must be ${CHATTERBOX_SAMPLE_RATE}`);
    }
    if (audio.channels !== 1) problems.push('audio.channels must be 1');
    if (audio.bitDepth !== 16) problems.push('audio.bitDepth must be 16');
    if (!isSha256HexDigest(audio.sha256)) problems.push('audio.sha256 must be 64 lowercase hex characters');
    if (typeof audio.durationSeconds !== 'number' || !(audio.durationSeconds > 0)) {
      problems.push('audio.durationSeconds must be > 0');
    }
    if (typeof audio.frameCount !== 'number' || !(audio.frameCount > 0)) {
      problems.push('audio.frameCount must be > 0');
    }
  }

  if (problems.length > 0) {
    throw new ChatterboxWorkerProtocolError(
      'MALFORMED_RESPONSE',
      `Worker success response is incomplete (${problems.length} problem(s)).`,
      { requestId: expected.requestId, problems }
    );
  }

  return value as unknown as ChatterboxWorkerResponse;
}

/* ------------------------------------------------------------------ */
/*  Failure mapping                                                    */
/* ------------------------------------------------------------------ */

export interface ChatterboxWorkerFailureMapping {
  code: AudioSynthesisErrorCode;
  /** Actionable remediation shown in the structured finding. */
  remediation: string;
}

const REQUIRED_ENV_REMEDIATION =
  'Provision the isolated environment once with: npm run provision:voice-clone -- --apply';

/**
 * Map a worker failure category onto the adapter's structured error code and an
 * actionable remediation. Every category maps to a blocking code: there is no
 * "warn and continue" branch anywhere in this table.
 */
export function chatterboxWorkerErrorToAudioSynthesisFailure(
  category: ChatterboxWorkerErrorCategory
): ChatterboxWorkerFailureMapping {
  switch (category) {
    case 'MISSING_PYTHON':
      return { code: 'CHATTERBOX_PYTHON_MISSING', remediation: REQUIRED_ENV_REMEDIATION };
    case 'MISSING_DEPENDENCY':
      return { code: 'CHATTERBOX_WORKER_FAILED', remediation: REQUIRED_ENV_REMEDIATION };
    case 'MODEL_MISSING':
      return { code: 'CHATTERBOX_MODEL_MISSING', remediation: REQUIRED_ENV_REMEDIATION };
    case 'MODEL_REVISION_MISMATCH':
      return {
        code: 'CHATTERBOX_MODEL_REVISION_MISMATCH',
        remediation: REQUIRED_ENV_REMEDIATION,
      };
    case 'CUDA_REQUIRED':
      return {
        code: 'CHATTERBOX_CUDA_REQUIRED',
        remediation:
          'Run on a host with an NVIDIA GPU + CUDA, or explicitly opt into the unverified CPU path.',
      };
    case 'CUDA_INIT_FAILED':
      return {
        code: 'CHATTERBOX_CUDA_INIT_FAILED',
        remediation: 'Check the CUDA driver/runtime pairing for the provisioned torch build.',
      };
    case 'GPU_OUT_OF_MEMORY':
      return {
        code: 'CHATTERBOX_GPU_OUT_OF_MEMORY',
        remediation: 'Free GPU memory (stop other jobs) or use the 350M turbo contract.',
      };
    case 'UNSUPPORTED_LANGUAGE':
      return {
        code: 'CHATTERBOX_UNSUPPORTED_LANGUAGE',
        remediation: 'Select a contract that supports the dialogue language or fix the language tag.',
      };
    case 'INVALID_REFERENCE':
      return {
        code: 'CHATTERBOX_REFERENCE_HASH_MISMATCH',
        remediation: 'Re-record/re-import the approved reference and re-run the publication review.',
      };
    case 'OUTPUT_WRITE_FAILED':
      return { code: 'OUTPUT_WRITE_FAILED', remediation: 'Check scratch-directory permissions and disk space.' };
    case 'EMPTY_AUDIO':
      return {
        code: 'CHATTERBOX_EMPTY_OUTPUT',
        remediation: 'Retry once; if it persists, re-verify the reference clip and the provisioned model.',
      };
    case 'WATERMARK_MISSING':
      return {
        code: 'CHATTERBOX_WATERMARK_MISSING',
        remediation: 'Re-provision the isolated env so resemble-perth is present, then retry.',
      };
    case 'SYNTHESIS_FAILED':
    case 'INTERNAL_ERROR':
    default:
      return { code: 'CHATTERBOX_WORKER_FAILED', remediation: 'Inspect the worker diagnostics and retry.' };
  }
}

/* ------------------------------------------------------------------ */
/*  Diagnostics redaction                                              */
/* ------------------------------------------------------------------ */

/**
 * Redact the personal part of a reference recording path: the directory is kept
 * (it identifies the approved voice class) and the basename is replaced by the
 * reference hash prefix. Never returns a personal file name.
 */
export function redactChatterboxReferenceLabel(
  relativePath: unknown,
  sha256?: string | null
): string {
  const short = typeof sha256 === 'string' && sha256.length >= 8 ? sha256.slice(0, 8) : 'unknown';
  if (typeof relativePath !== 'string' || !relativePath.trim()) return `<reference:${short}>`;
  const normalized = relativePath.trim().replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return `<reference:${short}>`;
  const dir = segments.slice(0, -1).join('/');
  const label = `<reference:${short}>`;
  return dir ? `${dir}/${label}` : label;
}

export interface ChatterboxDiagnosticOptions {
  /** Absolute roots to collapse (e.g. the repo root) so they never leak. */
  redactRoots?: readonly string[];
  maxLength?: number;
}

/**
 * Deterministically sanitize a diagnostic string: collapse absolute personal
 * paths, collapse whitespace and truncate to a bounded length. Bounded output is
 * a contract, so a runaway worker can never flood a log.
 */
export function sanitizeChatterboxDiagnostic(
  text: unknown,
  options: ChatterboxDiagnosticOptions = {}
): string {
  const maxLength = options.maxLength ?? CHATTERBOX_WORKER_LIMITS.maxDiagnosticChars;
  if (typeof text !== 'string') return '';
  let out = text;
  for (const root of options.redactRoots ?? []) {
    if (typeof root === 'string' && root.trim()) {
      out = out.split(root).join('<repo>');
    }
  }
  /* Remaining absolute personal paths: keep the last segment only. */
  out = out.replace(
    /(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"`|,;:]*[\\/])*([^\s'"`|,;:/\\]+)/g,
    (_match, basename: string) => `<path>/${basename}`
  );
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > maxLength) {
    out = `${out.slice(0, Math.max(0, maxLength - 1))}…`;
  }
  return out;
}

export interface ChatterboxDiagnosticInput {
  engineContractId: ChatterboxEngineContractId;
  modelId: string;
  modelRevision: string | null;
  category: string;
  detail: string;
  remediation?: string;
  redactRoots?: readonly string[];
}

/**
 * Bounded, structured diagnostic identifying engine / model / failure category
 * and remediation — with roots and reference names redacted.
 */
export function chatterboxDiagnostic(input: ChatterboxDiagnosticInput): string {
  const revision = input.modelRevision ? input.modelRevision.slice(0, 12) : 'unresolved';
  const parts = [
    `[${CHATTERBOX_ENGINE_ID}/${input.engineContractId} model=${input.modelId} rev=${revision}]`,
    `${input.category}: ${input.detail}`,
  ];
  if (input.remediation) parts.push(`remediation: ${input.remediation}`);
  return sanitizeChatterboxDiagnostic(parts.join(' | '), {
    redactRoots: input.redactRoots,
  });
}


