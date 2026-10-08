/**
 * BuildTrack Video Factory - VS2 Chatterbox Voice-Clone Dialogue Synthesizer
 *
 * A real `AudioSynthesizer` implementation that clones an APPROVED OWN VOICE
 * with a local Chatterbox model running in an isolated Python environment. It
 * reuses the existing orchestration unchanged: per-turn target paths, validated
 * reuse sidecars, the VS1 publication gate, the canonical normalizer and the
 * canonical dialogue-audio manifest. There is no second dialogue pipeline.
 *
 * Engine contracts (see `chatterbox-voice-identity.ts`):
 *   - `chatterbox-turbo`          -> ResembleAI/chatterbox-turbo   (350M, English)
 *   - `chatterbox-multilingual-v3`-> ResembleAI/chatterbox         (500M, 23 languages)
 * Both are MIT-licensed (`chatterbox-tts==0.1.7`), run fully locally and emit
 * 24 kHz mono audio that is normalized to the canonical 48 kHz mono PCM16 WAV.
 * Every generated file carries Resemble AI's Perth neural watermark.
 *
 * Safety order enforced for EVERY clip (nothing is written before step 4):
 *   1. request shape + exact text + portable target path;
 *   2. the voice must DECLARE this exact engine contract and a cloned reference
 *      recording — an approved voice is never silently produced by Kokoro, by
 *      another Chatterbox model, or by a preset/default voice;
 *   3. the VS1 commercial publication gate (consent, rights, audition,
 *      publication state) must allow the voice;
 *   4. the reference recording is re-hashed and must match the approved profile;
 *   5. the provisioning marker + isolated Python 3.11 env + worker script must
 *      exist, and the model revision must match what was provisioned;
 *   6. the language must be supported by the contract;
 *   7. the device policy must be satisfiable (CUDA GPU by default; CPU is only
 *      used after an explicit opt-in, and is reported as unverified);
 *   8. only then is the Python worker spawned — directly, with `shell: false`,
 *      a bounded timeout, SIGTERM->SIGKILL termination, a versioned JSON
 *      manifest on stdin/stdout, and full response validation;
 *   9. the raw 24 kHz WAV is integrity-checked (size, hash, header, silence) and
 *      normalized to canonical 48 kHz mono PCM16 at `request.targetPath`.
 *
 * Node-only module (fs/child_process): never import it from the pure contract
 * layer or from browser-bundled code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { AudioSynthesizer } from './audio-synthesizer.js';
import {
  AudioSynthesisError,
  type AudioSynthesisErrorCode,
  type AudioSynthesisRequest,
  type AudioSynthesisResult,
} from './audio-synthesis-types.js';
import { AudioFormatSpec } from './dialogue-audio-types.js';
import { CANONICAL_AUDIO_FORMAT, AudioValidationError } from './audio-validation-types.js';
import { FfmpegAudioNormalizer } from './audio-normalizer.js';
import { WavHeaderProbe, validateCanonicalAudio } from './audio-probe.js';
import { assertVoicesApprovedForProduction } from './voice-publication-gate.js';
import {
  VoiceProfile,
  VoicePublicationGateOptions,
  VoiceResolutionError,
} from './voice-types.js';
import {
  CHATTERBOX_CANONICAL_CONTRACT,
  CHATTERBOX_ENGINE_CONTRACTS,
  CHATTERBOX_ENGINE_ID,
  CHATTERBOX_MODEL_DIR,
  CHATTERBOX_PACKAGE_VERSION,
  CHATTERBOX_PROVISION_MARKER_PATH,
  CHATTERBOX_SAMPLE_RATE,
  CHATTERBOX_SCRATCH_DIR,
  CHATTERBOX_WATERMARK_PROVIDER,
  chatterboxVoiceSettingsOrDefaults,
  isChatterboxEngineContractId,
  mapLanguageTagForContract,
  parseChatterboxProvisionMarker,
  validateChatterboxVoiceSettings,
  type ChatterboxEngineContract,
  type ChatterboxEngineContractId,
  type ChatterboxProvisionMarker,
  type ChatterboxVoiceSettings,
} from './chatterbox-voice-identity.js';
import {
  CHATTERBOX_WORKER_LIMITS,
  CHATTERBOX_WORKER_PROTOCOL_VERSION,
  CHATTERBOX_WORKER_REQUEST_SCHEMA,
  chatterboxDiagnostic,
  chatterboxWorkerErrorToAudioSynthesisFailure,
  isSha256HexDigest,
  parseChatterboxWorkerResponse,
  redactChatterboxReferenceLabel,
  sanitizeChatterboxDiagnostic,
  assertChatterboxWorkerRequest,
  ChatterboxWorkerProtocolError,
  type ChatterboxWorkerRequest,
  type ChatterboxWorkerResponse,
} from './chatterbox-worker-protocol.js';
import {
  ChatterboxPathSafetyError,
  resolveChatterboxPath,
  type ChatterboxPathPolicy,
} from './chatterbox-path-safety.js';

/* ------------------------------------------------------------------ */
/*  Worker process plumbing                                            */
/* ------------------------------------------------------------------ */

export interface ChatterboxWorkerInvocation {
  pythonPath: string;
  workerScriptPath: string;
  cwd: string;
  env: Record<string, string>;
  requestJson: string;
  timeoutMs: number;
}

export interface ChatterboxWorkerSpawnResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnErrorCode?: string;
  stdoutOverflow?: boolean;
  stderrOverflow?: boolean;
}

export type ChatterboxWorkerSpawner = (
  invocation: ChatterboxWorkerInvocation
) => Promise<ChatterboxWorkerSpawnResult>;

/**
 * Real spawner: launches the interpreter DIRECTLY (no shell, no string
 * concatenation), writes the JSON manifest to stdin, collects bounded output and
 * terminates an over-running child with SIGTERM then SIGKILL.
 */
const defaultChatterboxWorkerSpawner: ChatterboxWorkerSpawner = (invocation) =>
  new Promise<ChatterboxWorkerSpawnResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.pythonPath, [invocation.workerScriptPath], {
        cwd: invocation.cwd,
        env: invocation.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: (e as Error).message,
        timedOut: false,
        spawnErrorCode: (e as NodeJS.ErrnoException).code ?? 'SPAWN_FAILED',
      });
      return;
    }

    const limit = CHATTERBOX_WORKER_LIMITS;
    let stdout = '';
    let stderr = '';
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const finish = (result: ChatterboxWorkerSpawnResult): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, limit.terminationGraceMs);
      killTimer.unref?.();
    }, invocation.timeoutMs);
    timeoutTimer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutOverflow) return;
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > limit.maxStdoutBytes) {
        stdoutOverflow = true;
        stdout = stdout.slice(0, 4096);
        child.kill('SIGKILL');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrOverflow) return;
      stderr += chunk.toString('utf8');
      if (Buffer.byteLength(stderr, 'utf8') > limit.maxStderrBytes) {
        stderrOverflow = true;
        stderr = stderr.slice(0, 4096);
      }
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}\n${e.message}`,
        timedOut,
        spawnErrorCode: e.code ?? 'SPAWN_FAILED',
        stdoutOverflow,
        stderrOverflow,
      });
    });
    child.on('close', (code, signal) => {
      finish({
        exitCode: code,
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut,
        stdoutOverflow,
        stderrOverflow,
      });
    });

    try {
      child.stdin?.write(invocation.requestJson);
      child.stdin?.end();
    } catch (e) {
      /* stdin failure surfaces through close/error; keep diagnostics bounded. */
      stderr = `${stderr}\nstdin: ${(e as Error).message}`.slice(0, 2048);
    }
  });

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

export interface ChatterboxGpuStatus {
  available: boolean;
  name?: string;
  memoryTotalMiB?: number;
  driverVersion?: string;
}

export interface ChatterboxSynthesizerOptions {
  /**
   * Repository root. MUST equal `process.cwd()`: the adapter mirrors the
   * pipeline's repo-relative-path contract, and the isolated worker is spawned
   * with this directory as its cwd.
   */
  repoRoot?: string;
  /** Engine contract to run. Default `chatterbox-multilingual-v3`. */
  engineContractId?: ChatterboxEngineContractId;
  /** Interpreter override. Default: marker -> `.chatterbox/env/bin/python` -> env -> `python3.11`. */
  pythonPath?: string;
  /** Worker script override (repo-relative or absolute). Default `tools/chatterbox/worker.py`. */
  workerScriptPath?: string;
  /** Declared settings. Turbo refuses settings instead of pretending to apply them. */
  voiceSettings?: Partial<ChatterboxVoiceSettings>;
  /** Expected model revision; when omitted the provisioned revision is used. */
  modelRevision?: string;
  /** Device policy. Default `cuda`; CPU requires `allowCpu: true`. */
  device?: 'cuda' | 'cpu';
  /** Explicit, truthful opt-in to the unverified CPU path. Default false. */
  allowCpu?: boolean;
  /** Bounded timeout for one worker invocation (default 900_000 ms). */
  timeoutMs?: number;
  /** Repo-relative scratch directory (default `.chatterbox/scratch`). */
  scratchDir?: string;
  /** Repo-relative or absolute provisioning marker path. */
  markerPath?: string;
  /** Repo-relative model/cache directory (default `.chatterbox/models`). */
  modelDir?: string;
  referenceRoots?: readonly string[];
  outputRoots?: readonly string[];
  scratchRoots?: readonly string[];
  /** Additional sanitized environment entries for the worker (config only). */
  workerEnv?: Record<string, string>;
  /** Publication-gate options used to re-verify the voice per clip. */
  publicationGate?: VoicePublicationGateOptions;
  /** Injectable GPU detection (tests / hosts without `nvidia-smi`). */
  detectGpu?: () => ChatterboxGpuStatus;
  /** Injectable worker spawner (tests only; production uses the real spawner). */
  spawnWorker?: ChatterboxWorkerSpawner;
}

/* ------------------------------------------------------------------ */
/*  Default GPU detection                                              */
/* ------------------------------------------------------------------ */

/**
 * Default NVIDIA detection: runs `nvidia-smi` directly (no shell). Absence of
 * the binary is a truthful "no GPU here", never an error to hide.
 */
export function detectNvidiaGpu(): ChatterboxGpuStatus {
  try {
    const result = spawnSync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
      { shell: false, encoding: 'utf8', timeout: 10_000 }
    );
    if (result.status !== 0 || typeof result.stdout !== 'string') return { available: false };
    const firstLine = result.stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    if (!firstLine) return { available: false };
    const [name, memory, driver] = firstLine.split(',').map((part) => part.trim());
    const memoryTotalMiB = Number.parseInt(memory ?? '', 10);
    return {
      available: true,
      ...(name ? { name } : {}),
      ...(Number.isFinite(memoryTotalMiB) ? { memoryTotalMiB } : {}),
      ...(driver ? { driverVersion: driver } : {}),
    };
  } catch {
    return { available: false };
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function sha256File(absolutePath: string): string {
  return createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

/** Peak absolute sample of a 16-bit PCM WAV body (silence detection). */
function wavPeakAmplitude(buffer: Buffer): number {
  /* Locate the data chunk after a 44-byte canonical header; be tolerant of
   * extra chunks by scanning chunk ids. */
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      const start = offset + 8;
      const end = Math.min(buffer.length, start + chunkSize);
      let peak = 0;
      for (let i = start; i + 1 < end; i += 2) {
        const sample = Math.abs(buffer.readInt16LE(i));
        if (sample > peak) peak = sample;
      }
      return peak;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return -1; // no data chunk found
}

/* ------------------------------------------------------------------ */
/*  Adapter                                                            */
/* ------------------------------------------------------------------ */

export class ChatterboxDialogueSynthesizer implements AudioSynthesizer {
  readonly engineId = CHATTERBOX_ENGINE_ID;
  readonly engineVersion = CHATTERBOX_PACKAGE_VERSION;
  /** Synthesis is cache-only and offline; provisioning (separate tool) uses network. */
  readonly requiresNetwork = false;
  readonly isLocal = true;

  /** Model repository this adapter runs — read structurally by the reuse layer. */
  readonly modelId: string;
  /** RESOLVED model revision in use (option or provisioning marker; else null). */
  readonly modelRevision: string | null;
  /**
   * Digest of everything about the voice SETTINGS that determines the waveform
   * (contract id, canonical-format contract, effective settings). It is carried
   * into the synthesis reuse key/sidecar, so changing any setting invalidates
   * reuse instead of silently serving bytes produced with other settings.
   */
  readonly settingsDigest: string;

  readonly engineContractId: ChatterboxEngineContractId;
  readonly contract: ChatterboxEngineContract;

  private readonly repoRoot: string;
  private readonly scratchDir: string;
  private readonly modelDir: string;
  private readonly markerPath: string;
  private readonly marker: ChatterboxProvisionMarker | null;
  private readonly markerProblems: readonly string[];
  private readonly pythonPathOption: string | undefined;
  private readonly workerScriptPathOption: string | undefined;
  private readonly settings: ChatterboxVoiceSettings;
  private readonly devicePolicy: 'cuda' | 'cpu';
  private readonly allowCpu: boolean;
  private readonly timeoutMs: number;
  private readonly workerEnv: Record<string, string>;
  private readonly publicationGateOptions: VoicePublicationGateOptions;
  private readonly detectGpu: () => ChatterboxGpuStatus;
  private readonly spawnWorker: ChatterboxWorkerSpawner;
  private readonly pathPolicy: ChatterboxPathPolicy;
  private readonly normalizer = new FfmpegAudioNormalizer();
  private readonly probe = new WavHeaderProbe();

  constructor(options: ChatterboxSynthesizerOptions = {}) {
    this.repoRoot = path.resolve(options.repoRoot ?? process.cwd());
    if (this.repoRoot !== path.resolve(process.cwd())) {
      throw new AudioSynthesisError(
        'MALFORMED_SYNTHESIS_REQUEST',
        'ChatterboxDialogueSynthesizer must run with repoRoot === process.cwd(): the pipeline and the worker are repo-relative.',
        { repoRoot: this.repoRoot }
      );
    }

    const contractId = options.engineContractId ?? 'chatterbox-multilingual-v3';
    if (!isChatterboxEngineContractId(contractId)) {
      throw new AudioSynthesisError(
        'MALFORMED_SYNTHESIS_REQUEST',
        `Unsupported Chatterbox engine contract: '${String(contractId)}'.`,
        { engineContractId: contractId }
      );
    }
    this.engineContractId = contractId;
    this.contract = CHATTERBOX_ENGINE_CONTRACTS[contractId];
    this.modelId = this.contract.modelId;

    const declaredSettings = options.voiceSettings ?? {};
    const settingsProblems = validateChatterboxVoiceSettings(contractId, declaredSettings);
    if (settingsProblems.length > 0) {
      throw new AudioSynthesisError(
        'MALFORMED_SYNTHESIS_REQUEST',
        `Chatterbox voice settings are invalid for contract '${contractId}': ${settingsProblems.join(' ')}`,
        { engineContractId: contractId, problems: settingsProblems }
      );
    }
    this.settings = chatterboxVoiceSettingsOrDefaults(contractId, declaredSettings);

    this.markerPath = options.markerPath ?? CHATTERBOX_PROVISION_MARKER_PATH;
    this.markerPath = path.isAbsolute(this.markerPath)
      ? this.markerPath
      : path.join(this.repoRoot, this.markerPath);
    const markerRead = this.readProvisionMarker();
    this.marker = markerRead.marker;
    this.markerProblems = markerRead.problems;
    this.modelRevision = options.modelRevision ?? this.marker?.modelRevision ?? null;

    this.modelDir = options.modelDir ?? CHATTERBOX_MODEL_DIR;
    this.scratchDir = (options.scratchDir ?? CHATTERBOX_SCRATCH_DIR).replace(/\\/g, '/').replace(/\/+$/, '');
    this.pythonPathOption = options.pythonPath;
    this.workerScriptPathOption = options.workerScriptPath;
    this.devicePolicy = options.device ?? 'cuda';
    this.allowCpu = options.allowCpu === true;
    this.timeoutMs = options.timeoutMs ?? CHATTERBOX_WORKER_LIMITS.defaultTimeoutMs;
    this.workerEnv = { ...(options.workerEnv ?? {}) };
    this.publicationGateOptions = { ...(options.publicationGate ?? {}) };
    this.detectGpu = options.detectGpu ?? detectNvidiaGpu;
    this.spawnWorker = options.spawnWorker ?? defaultChatterboxWorkerSpawner;
    this.pathPolicy = {
      repoRoot: this.repoRoot,
      ...(options.referenceRoots ? { approvedReferenceRoots: options.referenceRoots } : {}),
      ...(options.outputRoots ? { approvedOutputRoots: options.outputRoots } : {}),
      ...(options.scratchRoots ? { approvedScratchRoots: options.scratchRoots } : {}),
    };

    this.settingsDigest = createHash('sha256')
      .update(
        JSON.stringify({
          v: 1,
          contractId: this.engineContractId,
          canonicalContract: CHATTERBOX_CANONICAL_CONTRACT,
          supportsVoiceSettings: this.contract.supportsVoiceSettings,
          sampleRate: this.contract.sampleRate,
          settings: {
            exaggeration: this.settings.exaggeration,
            cfgWeight: this.settings.cfgWeight,
            minP: this.settings.minP ?? null,
          },
        })
      )
      .digest('hex');
  }

  /* ---------------------------------------------------------------- */
  /*  Provisioning marker / environment / device                        */
  /* ---------------------------------------------------------------- */

  private readProvisionMarker(): {
    marker: ChatterboxProvisionMarker | null;
    problems: string[];
  } {
    try {
      if (!fs.existsSync(this.markerPath)) {
        return { marker: null, problems: ['provisioning marker is absent'] };
      }
      const parsed = JSON.parse(fs.readFileSync(this.markerPath, 'utf8')) as unknown;
      return parseChatterboxProvisionMarker(parsed);
    } catch (e) {
      return { marker: null, problems: [`provisioning marker is unreadable: ${(e as Error).message}`] };
    }
  }

  /** Resolve the interpreter without spawning it. */
  private resolvePythonCandidate(): { pythonPath: string; source: string } {
    if (this.pythonPathOption) {
      return { pythonPath: this.pythonPathOption, source: 'option' };
    }
    const venvPython = path.join(this.repoRoot, '.chatterbox/env/bin/python');
    if (fs.existsSync(venvPython)) {
      return { pythonPath: venvPython, source: 'isolated-env' };
    }
    const fromMarker = this.marker?.pythonPath;
    if (fromMarker) {
      const absolute = path.isAbsolute(fromMarker) ? fromMarker : path.join(this.repoRoot, fromMarker);
      if (fs.existsSync(absolute)) return { pythonPath: absolute, source: 'marker' };
    }
    if (process.env.CHATTERBOX_PYTHON) {
      return { pythonPath: process.env.CHATTERBOX_PYTHON, source: 'env' };
    }
    return { pythonPath: 'python3.11', source: 'path' };
  }

  private resolveWorkerScriptPath(): string {
    const worker = this.workerScriptPathOption ?? 'tools/chatterbox/worker.py';
    return path.isAbsolute(worker) ? worker : path.join(this.repoRoot, worker);
  }

  /**
   * Verify the environment without writing anything and without loading the
   * model: marker contract, interpreter, worker script.
   */
  private assertProvisioned(): { pythonPath: string; workerScriptPath: string } {
    if (!this.marker) {
      throw this.failure(
        'CHATTERBOX_MODEL_MISSING',
        'PROVISION_MARKER_MISSING',
        `No verified provisioning marker at '${CHATTERBOX_PROVISION_MARKER_PATH}' (${this.markerProblems.join('; ')}).`,
        { markerPath: CHATTERBOX_PROVISION_MARKER_PATH, problems: this.markerProblems },
        'Provision once with: npm run provision:voice-clone -- --apply'
      );
    }

    if (this.marker.engineContractId !== this.engineContractId) {
      throw this.failure(
        'CHATTERBOX_MODEL_REVISION_MISMATCH',
        'MODEL_CONTRACT_MISMATCH',
        `Provisioned contract '${this.marker.engineContractId}' but this adapter runs '${this.engineContractId}'.`,
        { provisionedContract: this.marker.engineContractId, adapterContract: this.engineContractId },
        'Provision the required contract or construct the adapter for the provisioned one.'
      );
    }
    if (this.marker.modelId !== this.modelId) {
      throw this.failure(
        'CHATTERBOX_MODEL_REVISION_MISMATCH',
        'MODEL_ID_MISMATCH',
        `Provisioned model '${this.marker.modelId}' but this adapter runs '${this.modelId}'.`,
        { provisionedModelId: this.marker.modelId, adapterModelId: this.modelId },
        'Re-run provisioning for this contract.'
      );
    }
    if (this.marker.packageVersion !== CHATTERBOX_PACKAGE_VERSION) {
      throw this.failure(
        'CHATTERBOX_MODEL_REVISION_MISMATCH',
        'PACKAGE_VERSION_MISMATCH',
        `Provisioned chatterbox-tts '${this.marker.packageVersion}' but this adapter pins '${CHATTERBOX_PACKAGE_VERSION}'.`,
        { provisionedPackageVersion: this.marker.packageVersion, adapterPackageVersion: CHATTERBOX_PACKAGE_VERSION },
        'Re-run provisioning to install the pinned package version.'
      );
    }
    if (!this.marker.modelRevision) {
      throw this.failure(
        'CHATTERBOX_MODEL_REVISION_MISMATCH',
        'MARKER_HAS_NO_RESOLVED_REVISION',
        'Provisioning marker carries no resolved model revision; reuse identity cannot be trusted.',
        { markerPath: CHATTERBOX_PROVISION_MARKER_PATH },
        'Re-run provisioning so the resolved upstream revision is recorded.'
      );
    }
    if (this.modelRevision && this.modelRevision !== this.marker.modelRevision) {
      throw this.failure(
        'CHATTERBOX_MODEL_REVISION_MISMATCH',
        'PINNED_REVISION_MISMATCH',
        'The adapter is pinned to a different model revision than the provisioned one.',
        {
          adapterRevision: this.modelRevision,
          provisionedRevision: this.marker.modelRevision,
        },
        'Re-provision the pinned revision or align the adapter pin.'
      );
    }

    const { pythonPath, source } = this.resolvePythonCandidate();
    const probeResult = spawnSync(pythonPath, ['--version'], {
      shell: false,
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (probeResult.error || probeResult.status !== 0) {
      throw this.failure(
        'CHATTERBOX_PYTHON_MISSING',
        'PYTHON_INTERPRETER_UNAVAILABLE',
        `Python interpreter '${pythonPath}' (${source}) could not be executed (${(probeResult.error as NodeJS.ErrnoException | undefined)?.code ?? `exit ${String(probeResult.status)}`}).`,
        { pythonSource: source },
        'Provision once with: npm run provision:voice-clone -- --apply'
      );
    }

    const workerScriptPath = this.resolveWorkerScriptPath();
    if (!fs.existsSync(workerScriptPath)) {
      throw this.failure(
        'CHATTERBOX_WORKER_MISSING',
        'WORKER_SCRIPT_MISSING',
        `Chatterbox worker script is missing at '${path.relative(this.repoRoot, workerScriptPath)}'.`,
        { workerScript: path.relative(this.repoRoot, workerScriptPath) },
        'Restore tools/chatterbox/worker.py from the repository.'
      );
    }

    return { pythonPath, workerScriptPath };
  }

  /** Decide and verify the execution device; never silently downgrades. */
  private assertDevicePolicy(): { device: 'cuda' | 'cpu'; gpu: ChatterboxGpuStatus } {
    const gpu = this.detectGpu();
    if (this.devicePolicy === 'cuda') {
      if (!gpu.available) {
        throw this.failure(
          'CHATTERBOX_CUDA_REQUIRED',
          'NO_NVIDIA_GPU_DETECTED',
          'CUDA execution was required but no NVIDIA GPU is available on this host (nvidia-smi absent or failing).',
          { cpuAllowed: this.allowCpu },
          this.allowCpu
            ? 'Construct the adapter with device: "cpu" to approve the unverified CPU path explicitly.'
            : 'Run on a CUDA host, or approve the unverified CPU path with device: "cpu", allowCpu: true.'
        );
      }
      return { device: 'cuda', gpu };
    }
    if (!this.allowCpu) {
      throw this.failure(
        'CHATTERBOX_CUDA_REQUIRED',
        'CPU_PATH_NOT_APPROVED',
        'CPU execution was requested without the explicit allowCpu opt-in; CPU performance is not verified.',
        { cpuAllowed: this.allowCpu },
        'Pass allowCpu: true after verifying CPU synthesis on this host.'
      );
    }
    return { device: 'cpu', gpu };
  }

  /** Sanitized worker environment: allowlist + explicit configuration only. */
  private buildWorkerEnv(device: 'cuda' | 'cpu'): Record<string, string> {
    const modelDirAbs = path.join(this.repoRoot, this.modelDir);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'C.UTF-8',
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      /* Synthesis is offline by contract: the model was provisioned already. */
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_HOME: modelDirAbs,
    };
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    if (device === 'cuda' && process.env.CUDA_VISIBLE_DEVICES !== undefined) {
      env.CUDA_VISIBLE_DEVICES = process.env.CUDA_VISIBLE_DEVICES;
    }
    for (const [key, value] of Object.entries(this.workerEnv)) {
      env[key] = value;
    }
    return env;
  }

  /* ---------------------------------------------------------------- */
  /*  Structured failures                                                */
  /* ---------------------------------------------------------------- */

  private failure(
    code: AudioSynthesisErrorCode,
    category: string,
    detail: string,
    extra: Record<string, unknown> = {},
    remediation?: string
  ): AudioSynthesisError {
    const message = chatterboxDiagnostic({
      engineContractId: this.engineContractId,
      modelId: this.modelId,
      modelRevision: this.modelRevision,
      category,
      detail,
      ...(remediation ? { remediation } : {}),
      redactRoots: [this.repoRoot],
    });
    return new AudioSynthesisError(code, message, {
      engineContractId: this.engineContractId,
      modelId: this.modelId,
      modelRevision: this.modelRevision,
      category,
      ...(remediation ? { remediation } : {}),
      ...extra,
    });
  }

  private pathFailure(
    error: ChatterboxPathSafetyError,
    role: 'reference' | 'output' | 'scratch',
    extra: Record<string, unknown> = {}
  ): AudioSynthesisError {
    return this.failure(
      'UNSAFE_PATH',
      `PATH_${error.code}`,
      error.message,
      { pathSafetyCode: error.code, pathRole: role, ...extra },
      'Use a portable repo-relative path inside the approved roots.'
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Request / voice declaration validation                            */
  /* ---------------------------------------------------------------- */

  private validateRequest(request: AudioSynthesisRequest): void {
    if (!request || typeof request !== 'object') {
      throw new AudioSynthesisError('MALFORMED_SYNTHESIS_REQUEST', 'Synthesis request must be a non-null object.', {
        request,
      });
    }
    const required = [
      'scenarioId',
      'sceneId',
      'turnId',
      'clipId',
      'speakerId',
      'voiceSlot',
      'voiceProfileId',
      'language',
      'spokenText',
      'targetPath',
    ] as const;
    for (const field of required) {
      const value = (request as unknown as Record<string, unknown>)[field];
      if (!value || (typeof value === 'string' && !value.trim())) {
        throw new AudioSynthesisError('MALFORMED_SYNTHESIS_REQUEST', `Missing required field: ${field}`, { field });
      }
    }
    if (typeof request.spokenText !== 'string' || !request.spokenText.trim()) {
      throw new AudioSynthesisError('INVALID_TEXT', 'spokenText must be a non-empty string.', {
        clipId: request.clipId,
      });
    }
    if (request.spokenText.trim().length > CHATTERBOX_WORKER_LIMITS.maxTextChars) {
      throw new AudioSynthesisError(
        'INVALID_TEXT',
        `spokenText exceeds maximum length of ${CHATTERBOX_WORKER_LIMITS.maxTextChars} (got ${request.spokenText.trim().length}).`,
        { clipId: request.clipId, length: request.spokenText.length }
      );
    }
    if (!request.voiceProfile || typeof request.voiceProfile !== 'object') {
      throw new AudioSynthesisError('MALFORMED_SYNTHESIS_REQUEST', 'voiceProfile must be present in request.', {
        clipId: request.clipId,
      });
    }
    try {
      resolveChatterboxPath(this.pathPolicy, request.targetPath, 'output');
    } catch (e) {
      if (e instanceof ChatterboxPathSafetyError) {
        throw this.pathFailure(e, 'output', { clipId: request.clipId, targetPath: request.targetPath });
      }
      throw e;
    }
  }

  /**
   * The voice must DECLARE this exact engine contract and a cloned reference
   * recording. This is the "no silent fallback" contract: an approved voice is
   * never produced by Kokoro, by another Chatterbox model, or by a preset.
   */
  private assertVoiceDeclaresThisEngine(profile: VoiceProfile): {
    referencePath: string;
    referenceSha256: string;
  } {
    const blocked: (reason: string, detail: string, extra?: Record<string, unknown>) => never = (
      reason,
      detail,
      extra = {}
    ) => {
      throw this.failure(
        'CHATTERBOX_VOICE_FALLBACK_BLOCKED',
        `VOICE_FALLBACK_BLOCKED_${reason}`,
        detail,
        { blockedCodes: [`CHATTERBOX-VOICE-${reason}`], voiceProfileId: profile.id, ...extra },
        'Resolve the dialogue with the voice engine the profile actually declares.'
      );
    };

    const publication = profile.publication;
    if (!publication || typeof publication !== 'object') {
      blocked('NO_PUBLICATION_RECORD', 'The voice profile declares no publication record.', {
        voiceSlot: profile.voiceSlot,
      });
    }
    const engine = publication?.engine;
    if (!engine || typeof engine !== 'object' || !engine.modelId) {
      blocked('NO_ENGINE_IDENTITY', 'The voice profile declares no engine identity.', {
        voiceSlot: profile.voiceSlot,
      });
    }
    if (engine.engine !== 'chatterbox') {
      blocked(
        'ENGINE_FAMILY_MISMATCH',
        `The voice declares engine family '${engine.engine}', not 'chatterbox'.`,
        { declaredEngine: engine.engine }
      );
    }
    if (engine.modelId !== this.modelId) {
      blocked(
        'MODEL_CONTRACT_MISMATCH',
        `The voice declares model '${engine.modelId}', but this adapter runs '${this.modelId}'.`,
        { declaredModelId: engine.modelId, adapterModelId: this.modelId }
      );
    }
    if (engine.runtimeId && engine.runtimeId !== CHATTERBOX_ENGINE_ID) {
      blocked(
        'RUNTIME_MISMATCH',
        `The voice declares runtime '${engine.runtimeId}', but this adapter runs '${CHATTERBOX_ENGINE_ID}'.`,
        { declaredRuntimeId: engine.runtimeId }
      );
    }
    if (engine.runtimeVersion && engine.runtimeVersion !== CHATTERBOX_PACKAGE_VERSION) {
      blocked(
        'RUNTIME_VERSION_MISMATCH',
        `The voice declares runtime version '${engine.runtimeVersion}', but this adapter pins '${CHATTERBOX_PACKAGE_VERSION}'.`,
        { declaredRuntimeVersion: engine.runtimeVersion }
      );
    }
    if (engine.modelRevision && this.modelRevision && engine.modelRevision !== this.modelRevision) {
      throw this.failure(
        'CHATTERBOX_MODEL_REVISION_MISMATCH',
        'VOICE_PROFILE_REVISION_MISMATCH',
        `The voice declares model revision '${engine.modelRevision}', but the provisioned revision is '${this.modelRevision}'.`,
        {
          scope: 'voice-profile',
          declaredRevision: engine.modelRevision,
          provisionedRevision: this.modelRevision,
          voiceProfileId: profile.id,
        },
        'Re-provision the declared revision or re-review the voice against the provisioned model.'
      );
    }

    const source = publication?.acousticSource;
    if (!source || typeof source !== 'object' || source.kind !== 'cloned_reference_audio') {
      blocked(
        'NO_CLONED_REFERENCE',
        'The voice declares no cloned reference recording, so it cannot be cloned here.',
        { declaredSourceKind: source && typeof source === 'object' ? source.kind : 'undeclared' }
      );
    }
    const reference = source && source.kind === 'cloned_reference_audio' ? source.referenceAudio : undefined;
    if (!reference || !isSha256HexDigest(reference.sha256)) {
      blocked(
        'REFERENCE_HASH_MISSING',
        'The voice has no well-formed SHA-256 for its reference recording.',
        { voiceSlot: profile.voiceSlot }
      );
    }

    return { referencePath: reference.path, referenceSha256: reference.sha256 };
  }

  /* ---------------------------------------------------------------- */
  /*  Reference integrity                                                */
  /* ---------------------------------------------------------------- */

  private verifyReference(
    request: AudioSynthesisRequest,
    referencePath: string,
    approvedSha256: string
  ): { relativePath: string; absolutePath: string; sha256: string } {
    let resolved: { relativePath: string; absolutePath: string };
    try {
      resolved = resolveChatterboxPath(this.pathPolicy, referencePath, 'reference');
    } catch (e) {
      if (e instanceof ChatterboxPathSafetyError) {
        throw this.pathFailure(e, 'reference', { clipId: request.clipId, voiceProfileId: request.voiceProfileId });
      }
      throw e;
    }

    if (!fs.existsSync(resolved.absolutePath) || !fs.statSync(resolved.absolutePath).isFile()) {
      throw this.failure(
        'CHATTERBOX_REFERENCE_MISSING',
        'REFERENCE_FILE_MISSING',
        `Approved reference recording is missing at '${redactChatterboxReferenceLabel(resolved.relativePath, approvedSha256)}'.`,
        {
          clipId: request.clipId,
          voiceProfileId: request.voiceProfileId,
          referenceLabel: redactChatterboxReferenceLabel(resolved.relativePath, approvedSha256),
        },
        'Restore the approved reference recording (Git-ignored) or re-run the publication review.'
      );
    }

    const actualSha256 = sha256File(resolved.absolutePath);
    const declaredIdentityHash = request.voiceAcousticIdentity?.referenceSha256 ?? null;
    if (actualSha256 !== approvedSha256 || (declaredIdentityHash !== null && declaredIdentityHash !== approvedSha256)) {
      throw this.failure(
        'CHATTERBOX_REFERENCE_HASH_MISMATCH',
        'REFERENCE_HASH_MISMATCH',
        `Reference recording hash does not match the approved profile (expected ${approvedSha256.slice(0, 12)}…, found ${actualSha256.slice(0, 12)}…).`,
        {
          clipId: request.clipId,
          voiceProfileId: request.voiceProfileId,
          referenceLabel: redactChatterboxReferenceLabel(resolved.relativePath, approvedSha256),
          approvedReferenceSha256: approvedSha256,
          actualReferenceSha256: actualSha256,
        },
        'The recording changed after review: re-hash, re-review and re-approve the voice.'
      );
    }

    return { ...resolved, sha256: actualSha256 };
  }

  /* ---------------------------------------------------------------- */
  /*  Worker invocation                                                  */
  /* ---------------------------------------------------------------- */

  private buildWorkerRequest(
    request: AudioSynthesisRequest,
    reference: { relativePath: string; sha256: string },
    languageId: string,
    scratchRelativePath: string,
    device: 'cuda' | 'cpu'
  ): ChatterboxWorkerRequest {
    const requestId = createHash('sha256')
      .update(
        JSON.stringify({
          clipId: request.clipId,
          contractId: this.engineContractId,
          modelId: this.modelId,
          modelRevision: this.modelRevision,
          languageId,
          text: request.spokenText,
          referenceSha256: reference.sha256,
          settings: this.settings,
          targetPath: request.targetPath,
        })
      )
      .digest('hex')
      .slice(0, 32);

    return {
      schema: CHATTERBOX_WORKER_REQUEST_SCHEMA,
      protocolVersion: CHATTERBOX_WORKER_PROTOCOL_VERSION,
      requestId,
      engineContractId: this.engineContractId,
      modelId: this.modelId,
      modelRevision: this.modelRevision as string,
      languageId,
      text: request.spokenText,
      referenceAudio: { path: reference.relativePath, sha256: reference.sha256 },
      settings: this.settings,
      settingsSupported: this.contract.supportsVoiceSettings,
      modelDir: this.modelDir.replace(/\\/g, '/'),
      output: {
        path: scratchRelativePath,
        sampleRate: CHATTERBOX_SAMPLE_RATE,
        channels: 1,
        bitDepth: 16,
        container: 'wav',
      },
      device,
      requireWatermark: true,
    };
  }

  private async runWorker(
    workerRequest: ChatterboxWorkerRequest,
    pythonPath: string,
    workerScriptPath: string,
    device: 'cuda' | 'cpu'
  ): Promise<ChatterboxWorkerResponse> {
    let manifest: ChatterboxWorkerRequest;
    try {
      manifest = assertChatterboxWorkerRequest(workerRequest);
    } catch (e) {
      if (e instanceof ChatterboxWorkerProtocolError) {
        throw this.failure('CHATTERBOX_WORKER_FAILED', `PROTOCOL_${e.code}`, e.message, {
          problems: (e.details as { problems?: unknown } | undefined)?.problems,
        });
      }
      throw e;
    }

    const result = await this.spawnWorker({
      pythonPath,
      workerScriptPath,
      cwd: this.repoRoot,
      env: this.buildWorkerEnv(device),
      requestJson: `${JSON.stringify(manifest)}\n`,
      timeoutMs: this.timeoutMs,
    });

    /* Worker stderr is machine-generated and may quote absolute paths: it is
     * sanitized (roots collapsed, absolute paths reduced to their basename) and
     * length-bounded BEFORE it can enter a structured finding. */
    const stderrTail = sanitizeChatterboxDiagnostic(result.stderr.slice(-2000), {
      redactRoots: [this.repoRoot],
      maxLength: 2000,
    });

    if (result.spawnErrorCode) {
      throw this.failure(
        'CHATTERBOX_PYTHON_MISSING',
        'WORKER_SPAWN_FAILED',
        `Could not start the Chatterbox worker (${result.spawnErrorCode}).`,
        { spawnErrorCode: result.spawnErrorCode, stderrTail },
        'Provision once with: npm run provision:voice-clone -- --apply'
      );
    }
    if (result.timedOut) {
      throw this.failure(
        'CHATTERBOX_WORKER_TIMEOUT',
        'WORKER_TIMEOUT',
        `Chatterbox worker exceeded the bounded timeout of ${this.timeoutMs} ms and was terminated.`,
        { timeoutMs: this.timeoutMs, stderrTail },
        'Reduce input length, verify GPU availability, or raise the timeout deliberately.'
      );
    }
    if (result.stdoutOverflow || result.stderrOverflow) {
      throw this.failure(
        'CHATTERBOX_WORKER_FAILED',
        'WORKER_OUTPUT_OVERFLOW',
        'Chatterbox worker produced more output than the bounded capture allows.',
        { stdoutOverflow: result.stdoutOverflow === true, stderrOverflow: result.stderrOverflow === true }
      );
    }
    if (result.exitCode !== 0) {
      throw this.failure(
        'CHATTERBOX_WORKER_EXIT_NONZERO',
        'WORKER_EXIT_NONZERO',
        `Chatterbox worker exited with code ${String(result.exitCode)} (signal ${String(result.signal)}).`,
        { exitCode: result.exitCode, signal: result.signal, stderrTail }
      );
    }

    let response: ChatterboxWorkerResponse;
    try {
      response = parseChatterboxWorkerResponse(result.stdout, { requestId: manifest.requestId });
    } catch (e) {
      if (e instanceof ChatterboxWorkerProtocolError) {
        const code: AudioSynthesisErrorCode =
          e.code === 'INVALID_JSON'
            ? 'CHATTERBOX_INVALID_JSON'
            : e.code === 'MANIFEST_VERSION_MISMATCH'
              ? 'CHATTERBOX_MANIFEST_VERSION_MISMATCH'
              : 'CHATTERBOX_WORKER_FAILED';
        throw this.failure(code, `PROTOCOL_${e.code}`, e.message, {
          protocolCode: e.code,
          stderrTail,
          ...(e.details ?? {}),
        });
      }
      throw e;
    }

    if (response.status === 'error' && response.error) {
      const mapping = chatterboxWorkerErrorToAudioSynthesisFailure(response.error.category);
      throw this.failure(
        mapping.code,
        `WORKER_${response.error.category}`,
        response.error.message,
        {
          workerCategory: response.error.category,
          workerRemediation: response.error.remediation,
          stderrTail,
        },
        response.error.remediation ?? mapping.remediation
      );
    }

    /* Cross-check engine identity: a worker answering with another model or
     * revision is not trustworthy evidence for this voice. */
    const engine = response.engine;
    if (!engine || engine.modelId !== this.modelId || engine.modelRevision !== this.modelRevision) {
      throw this.failure(
        'CHATTERBOX_MODEL_REVISION_MISMATCH',
        'WORKER_ENGINE_IDENTITY_MISMATCH',
        'The worker reported a different engine/model/revision than requested.',
        {
          reportedModelId: engine?.modelId,
          reportedModelRevision: engine?.modelRevision,
          requestedModelId: this.modelId,
          requestedModelRevision: this.modelRevision,
        }
      );
    }
    if (engine.contractId !== this.engineContractId) {
      throw this.failure(
        'CHATTERBOX_VOICE_FALLBACK_BLOCKED',
        'WORKER_CONTRACT_MISMATCH',
        `The worker ran contract '${engine.contractId}' instead of '${this.engineContractId}'.`,
        { reportedContractId: engine.contractId, requestedContractId: this.engineContractId }
      );
    }
    if (!response.watermark || response.watermark.applied !== true) {
      throw this.failure(
        'CHATTERBOX_WATERMARK_MISSING',
        'WATERMARK_NOT_APPLIED',
        `The Perth neural watermark (${CHATTERBOX_WATERMARK_PROVIDER}) was not confirmed by the worker.`,
        { watermark: response.watermark }
      );
    }
    if (response.audio && response.audio.path !== manifest.output.path) {
      throw this.failure(
        'UNSAFE_PATH',
        'WORKER_WROTE_UNEXPECTED_PATH',
        'The worker reported writing a different path than the requested scratch path.',
        { reportedPath: response.audio.path }
      );
    }

    return response;
  }

  /* ---------------------------------------------------------------- */
  /*  Raw output verification + canonical normalization                  */
  /* ---------------------------------------------------------------- */

  private verifyRawOutput(
    response: ChatterboxWorkerResponse,
    scratch: { relativePath: string; absolutePath: string }
  ): void {
    if (!fs.existsSync(scratch.absolutePath)) {
      throw this.failure(
        'CHATTERBOX_EMPTY_OUTPUT',
        'SCRATCH_OUTPUT_MISSING',
        'The worker reported success but no raw audio file exists.',
        { scratchLabel: scratch.relativePath }
      );
    }
    const stat = fs.statSync(scratch.absolutePath);
    if (stat.size <= 44) {
      throw this.failure(
        'CHATTERBOX_EMPTY_OUTPUT',
        'SCRATCH_OUTPUT_TOO_SMALL',
        `Raw engine output is too small to contain audio (${stat.size} bytes).`,
        { sizeBytes: stat.size }
      );
    }

    const reportedSha256 = response.audio?.sha256;
    const actualSha256 = sha256File(scratch.absolutePath);
    if (!reportedSha256 || reportedSha256 !== actualSha256) {
      throw this.failure(
        'CHATTERBOX_INVALID_WAV',
        'RAW_INTEGRITY_MISMATCH',
        'Raw engine output does not match the hash the worker reported.',
        { reportedSha256, actualSha256 }
      );
    }

    let metadata;
    try {
      metadata = this.probe.probeSync(scratch.relativePath);
    } catch (e) {
      const validationError = e instanceof AudioValidationError ? e : null;
      throw this.failure(
        validationError?.code === 'EMPTY_AUDIO' ? 'CHATTERBOX_EMPTY_OUTPUT' : 'CHATTERBOX_INVALID_WAV',
        'RAW_HEADER_INVALID',
        `Raw engine output is not a readable WAV (${(e as Error).message}).`,
        { validationCode: validationError?.code, scratchLabel: scratch.relativePath }
      );
    }
    if (
      metadata.container !== 'wav' ||
      metadata.channels !== 1 ||
      metadata.bitDepth !== 16 ||
      metadata.sampleRate !== CHATTERBOX_SAMPLE_RATE
    ) {
      throw this.failure(
        'CHATTERBOX_INVALID_WAV',
        'RAW_FORMAT_UNEXPECTED',
        `Raw engine output is not 24 kHz mono PCM16 WAV (got ${metadata.container}/${metadata.sampleRate} Hz/${metadata.channels}ch/${String(metadata.bitDepth)}-bit).`,
        {
          container: metadata.container,
          sampleRate: metadata.sampleRate,
          channels: metadata.channels,
          bitDepth: metadata.bitDepth,
        }
      );
    }

    const bytes = fs.readFileSync(scratch.absolutePath);
    const peak = wavPeakAmplitude(bytes);
    if (peak <= 0) {
      throw this.failure(
        peak === 0 ? 'CHATTERBOX_SILENT_OUTPUT' : 'CHATTERBOX_INVALID_WAV',
        peak === 0 ? 'RAW_OUTPUT_SILENT' : 'RAW_DATA_CHUNK_MISSING',
        peak === 0
          ? 'Raw engine output contains only silence.'
          : 'Raw engine output has no readable PCM data chunk.',
        { peakAmplitude: peak }
      );
    }
  }

  private normalizeToCanonical(scratchRelativePath: string, targetPath: string): { durationSeconds: number; fileSizeBytes: number } {
    let metadata;
    try {
      metadata = this.normalizer.normalizeSync(scratchRelativePath, targetPath);
    } catch (e) {
      if (e instanceof AudioValidationError) {
        const code: AudioSynthesisErrorCode =
          e.code === 'NORMALIZER_UNAVAILABLE'
            ? 'SYNTHESIZER_UNAVAILABLE'
            : e.code === 'EMPTY_AUDIO' || e.code === 'MISSING_AUDIO_FILE'
              ? 'CHATTERBOX_EMPTY_OUTPUT'
              : e.code === 'OUTPUT_WRITE_FAILED'
                ? 'OUTPUT_WRITE_FAILED'
                : 'CHATTERBOX_INVALID_WAV';
        throw this.failure(code, `NORMALIZATION_${e.code}`, e.message, {
          targetPath,
          validationCode: e.code,
        });
      }
      throw e;
    }

    const canonicalCheck = validateCanonicalAudio(metadata);
    if (!canonicalCheck.isCanonical) {
      throw this.failure(
        'CHATTERBOX_INVALID_WAV',
        'CANONICAL_CONTRACT_VIOLATION',
        `Normalized output is not canonical 48 kHz mono PCM16 (${canonicalCheck.findings
          .map((f) => f.ruleId)
          .join(', ')}).`,
        { findings: canonicalCheck.findings.map((f) => f.ruleId) }
      );
    }

    return {
      durationSeconds: typeof metadata.durationSeconds === 'number' ? metadata.durationSeconds : 0,
      fileSizeBytes: metadata.fileSizeBytes,
    };
  }

  /* ---------------------------------------------------------------- */
  /*  AudioSynthesizer implementation                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Availability without side effects: no file is created, no model is loaded
   * and no download can happen. It answers "could this adapter synthesize right
   * now?" from the marker, the interpreter, the worker script and the device
   * policy. Callers must enforce the publication gate BEFORE asking (the
   * orchestration does).
   */
  isAvailable(): boolean {
    try {
      this.assertProvisioned();
      this.assertDevicePolicy();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Synthesize one clip through the isolated worker and normalize the result to
   * canonical 48 kHz mono PCM16 at `request.targetPath`.
   */
  async synthesize(request: AudioSynthesisRequest): Promise<AudioSynthesisResult> {
    /* 1. Request shape, exact text, portable target path. */
    this.validateRequest(request);

    /* 2. The voice must declare this exact engine contract (no fallback). */
    const declared = this.assertVoiceDeclaresThisEngine(request.voiceProfile);

    /* 3. VS1 publication gate: consent, rights, audition, publication state.
     *    Nothing has been written and no worker exists yet. */
    try {
      /* The report itself is audited by the orchestration (`synthesisDialoguePlan`
       * attaches the batch report to the manifest); here only the decision is
       * needed, and only an allowed decision may continue. */
      assertVoicesApprovedForProduction([request.voiceProfile], this.publicationGateOptions);
    } catch (e) {
      if (e instanceof VoiceResolutionError) {
        throw new AudioSynthesisError('VOICE_PUBLICATION_BLOCKED', e.message, {
          voiceResolutionCode: e.code,
          clipId: request.clipId,
          voiceProfileId: request.voiceProfileId,
          ...(e.details ?? {}),
        });
      }
      throw e;
    }

    /* 4. Reference recording identity: path safety + recomputed SHA-256. */
    const reference = this.verifyReference(request, declared.referencePath, declared.referenceSha256);

    /* 5. Provisioning: marker, model revision, isolated interpreter, worker. */
    const { pythonPath, workerScriptPath } = this.assertProvisioned();

    /* 6. Language support for THIS contract. */
    const languageId = mapLanguageTagForContract(this.engineContractId, request.language);
    if (!languageId) {
      throw this.failure(
        'CHATTERBOX_UNSUPPORTED_LANGUAGE',
        'UNSUPPORTED_LANGUAGE',
        `Contract '${this.engineContractId}' cannot speak language '${request.language}'.`,
        {
          language: request.language,
          supportedLanguages: this.contract.languages,
        },
        'Use a contract that supports this language, or fix the dialogue language tag.'
      );
    }

    /* 7. Device policy: CUDA by default; CPU only with an explicit opt-in. */
    const { device } = this.assertDevicePolicy();

    /* 8. Scratch path + worker invocation. */
    const requestId = createHash('sha256')
      .update(
        JSON.stringify({
          clipId: request.clipId,
          text: request.spokenText,
          languageId,
          referenceSha256: reference.sha256,
          settings: this.settings,
        })
      )
      .digest('hex')
      .slice(0, 16);
    let scratch: { relativePath: string; absolutePath: string };
    try {
      scratch = resolveChatterboxPath(this.pathPolicy, `${this.scratchDir}/cb-${requestId}.wav`, 'scratch');
    } catch (e) {
      if (e instanceof ChatterboxPathSafetyError) {
        throw this.pathFailure(e, 'scratch', { clipId: request.clipId, scratchDir: this.scratchDir });
      }
      throw e;
    }
    if (fs.existsSync(scratch.absolutePath)) {
      /* The deterministic scratch name can collide with a previous failed run;
       * remove it so a stale file can never be read as this clip's output. */
      try {
        fs.unlinkSync(scratch.absolutePath);
      } catch (e) {
        throw this.failure('OUTPUT_WRITE_FAILED', 'SCRATCH_CLEANUP_FAILED', (e as Error).message, {
          scratchLabel: scratch.relativePath,
        });
      }
    }

    const workerRequest = this.buildWorkerRequest(request, reference, languageId, scratch.relativePath, device);

    /* The bounded diagnostic trail lives in any thrown structured error; this
     * adapter never logs, so no personal path can leak through stdout. */
    let response: ChatterboxWorkerResponse;
    response = await this.runWorker(workerRequest, pythonPath, workerScriptPath, device);

    /* 9. Verify the raw engine output, then normalize to canonical. */
    try {
      this.verifyRawOutput(response, scratch);
      const canonical = this.normalizeToCanonical(scratch.relativePath, request.targetPath);
      return {
        clipId: request.clipId,
        sceneId: request.sceneId,
        turnId: request.turnId,
        speakerId: request.speakerId,
        voiceSlot: request.voiceSlot,
        voiceProfileId: request.voiceProfileId,
        spokenText: request.spokenText, // exact preservation — source of truth
        outputPath: request.targetPath,
        audioFormat: CANONICAL_AUDIO_FORMAT as AudioFormatSpec,
        success: true,
        durationSeconds: Math.round(canonical.durationSeconds * 1000) / 1000,
        fileSizeBytes: canonical.fileSizeBytes,
        metadata: {
          scenarioId: request.scenarioId,
          language: request.language,
          engine: this.engineId,
          engineVersion: this.engineVersion,
        },
      };
    } finally {
      /* The raw scratch file is an intermediate: remove it on success AND on
       * failure so no un-normalized audio survives a run. */
      try {
        if (fs.existsSync(scratch.absolutePath)) fs.unlinkSync(scratch.absolutePath);
      } catch {
        /* Best effort only: scratch lives in a Git-ignored directory. */
      }
    }
  }
}
