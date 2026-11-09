/**
 * VS3 — engine availability facts and preview generation.
 *
 * This service answers two questions truthfully and does nothing else:
 *
 *   1. "Could this engine run right now on this machine?" — answered from the
 *      filesystem and the host, never optimistically. Kokoro is available when
 *      its npm runtime resolves AND its model cache is provisioned. Chatterbox
 *      is available when the isolated Python environment, the pinned worker
 *      script and a VERIFIED provisioning marker exist AND the device policy can
 *      be satisfied.
 *   2. "Generate the complete narration" — which runs the EXISTING
 *      `AudioSynthesizer` adapters (no second synthesizer) per speaker segment,
 *      preserving the complete spoken text, and then reports each artifact's
 *      real measured duration.
 *
 * Provisioning boundaries (VS3 §5): nothing here downloads model weights,
 * creates a Python environment or triggers provisioning. Missing capabilities
 * produce a blocking status plus the exact existing command to run.
 *
 * TEST FIXTURE (explicitly labelled): when `BUILDTRAKE_CHATTERBOX_TEST_WORKER=1`
 * is set, the Chatterbox adapter is pointed at the deterministic fake worker
 * under `tests/fixtures/`. That flag exists so automated tests can exercise the
 * process protocol without a GPU or a model; it is NOT a production path, it
 * always reports the engine as fixture-backed, and normal operation never sets
 * it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  CHATTERBOX_ENGINE_ID,
  CHATTERBOX_PACKAGE_VERSION,
  CHATTERBOX_PROVISION_MARKER_PATH,
  ChatterboxDialogueSynthesizer,
  KOKORO_CACHE_DIR,
  KOKORO_ENGINE_ID,
  KOKORO_JS_VERSION,
  KOKORO_MODEL_ID,
  chatterboxVoiceSettingsOrDefaults,
  getChatterboxEngineContract,
  type AudioSynthesisError,
  type AudioSynthesisRequest,
  type ChatterboxEngineContractId,
  type VoiceAudioEngineFacts,
  type VoiceAudioEngineKind,
} from '@buildtrack/core';
import { KokoroDialogueSynthesizer } from '@buildtrack/core/node';
import { DATA_DIR, OUTPUT_DIR, ROOT } from './platform.js';

export const CHATTERBOX_PROVISION_COMMAND = 'npm run provision:voice-clone -- --apply';
export const KOKORO_PROVISION_COMMAND = 'npm run provision:tts';

export interface EngineProbe {
  kind: VoiceAudioEngineKind;
  label: string;
  modelId: string;
  modelRevision: string | null;
  runtimeInstalled: boolean;
  provisioned: boolean;
  deviceSatisfied: boolean;
  deviceDetail: string;
  cpuRequiresOptIn: boolean;
  provisionRemedy: string;
  notes: string[];
}

function kokoroRuntimeResolvable(): boolean {
  try {
    // Resolve without loading: the adapter lazy-requires the runtime.
    const resolved = path.join(ROOT, 'node_modules', 'kokoro-js', 'package.json');
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

function kokoroModelCached(): boolean {
  const dir = path.join(ROOT, KOKORO_CACHE_DIR);
  if (!fs.existsSync(dir)) return false;
  try {
    /* The transformers.js FS cache stores models under models--<owner>--<name>. */
    return fs.readdirSync(dir).some((entry) => entry.startsWith('models--'));
  } catch {
    return false;
  }
}

export function missingNvidiaGpu(): boolean {
  /* Truthful CPU-only detection: no CUDA toolkit and no GPU device node. */
  if (fs.existsSync('/dev/nvidia0')) return false;
  const cudaLib = process.env.CUDA_HOME ?? '/usr/local/cuda';
  return !fs.existsSync(cudaLib);
}

export function isChatterboxTestFixtureEnabled(): boolean {
  return process.env.BUILDTRAKE_CHATTERBOX_TEST_WORKER === '1';
}

export function chatterboxContractId(): ChatterboxEngineContractId {
  const configured = process.env.BUILDTRAKE_CHATTERBOX_CONTRACT;
  const contract = getChatterboxEngineContract(configured);
  return contract ? contract.id : 'chatterbox-multilingual-v3';
}

function readChatterboxMarker(): { revision: string | null; verified: boolean; detail: string } {
  const markerPath = process.env.BUILDTRAKE_CHATTERBOX_MARKER ?? CHATTERBOX_PROVISION_MARKER_PATH;
  const abs = path.isAbsolute(markerPath) ? markerPath : path.join(ROOT, markerPath);
  if (!fs.existsSync(abs)) {
    return { revision: null, verified: false, detail: 'No verified provisioning marker.' };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
    const revision = typeof raw.modelRevision === 'string' ? raw.modelRevision : null;
    const contractOk = raw.engineContractId === chatterboxContractId();
    const packageOk = raw.packageVersion === CHATTERBOX_PACKAGE_VERSION;
    return {
      revision,
      verified: !!revision && contractOk && packageOk,
      detail: revision
        ? `Provisioned ${String(raw.engineContractId)} @ ${revision.slice(0, 12)}…`
        : 'Marker has no resolved revision.',
    };
  } catch (e) {
    return { revision: null, verified: false, detail: `Marker is unreadable: ${(e as Error).message}` };
  }
}

/** Truthful facts for both engines, without loading a model or downloading. */
export function probeEngines(): EngineProbe[] {
  const marker = readChatterboxMarker();
  const fixture = isChatterboxTestFixtureEnabled();
  const contract = getChatterboxEngineContract(chatterboxContractId())!;
  const workerPath = process.env.BUILDTRAKE_CHATTERBOX_WORKER ?? 'tools/chatterbox/worker.py';
  const workerAbs = path.isAbsolute(workerPath) ? workerPath : path.join(ROOT, workerPath);
  const pythonPath = process.env.BUILTRAKE_CHATTERBOX_PYTHON ?? '';
  const pythonOk = fixture
    ? true
    : (() => {
        try {
          const candidate = pythonPath || 'python3.11';
          const res = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: false });
          return res.status === 0 && /Python 3\.11\./.test(String(res.stdout));
        } catch {
          return false;
        }
      })();

  const cpuOptIn = process.env.CHATTERBOX_ALLOW_CPU === '1';
  const gpuMissing = missingNvidiaGpu();
  const notes: string[] = [];
  if (fixture) {
    notes.push(
      'TEST FIXTURE: the deterministic fake worker under tests/fixtures/ is in use. This is NOT real Chatterbox output.'
    );
  }
  if (cpuOptIn) {
    notes.push('CPU execution is explicitly opted in. CPU performance is NOT verified by this repository.');
  }

  return [
    {
      kind: 'chatterbox',
      label: `Chatterbox voice cloning (${contract.label})`,
      modelId: contract.modelId,
      modelRevision: marker.revision,
      runtimeInstalled: fixture || (pythonOk && fs.existsSync(workerAbs)),
      provisioned: fixture || (marker.verified && pythonOk && fs.existsSync(workerAbs)),
      deviceSatisfied: fixture ? true : !gpuMissing || cpuOptIn,
      deviceDetail: fixture
        ? 'Fixture-backed: device policy is not exercised.'
        : gpuMissing
          ? 'No NVIDIA GPU detected. CUDA execution is required unless CPU is explicitly opted in.'
          : 'NVIDIA GPU detected.',
      cpuRequiresOptIn: gpuMissing,
      provisionRemedy: CHATTERBOX_PROVISION_COMMAND,
      notes,
    },
    {
      kind: 'kokoro',
      label: 'Kokoro 82M presets (local, CPU)',
      modelId: KOKORO_MODEL_ID,
      modelRevision: 'v1.0',
      runtimeInstalled: kokoroRuntimeResolvable(),
      provisioned: kokoroRuntimeResolvable() && kokoroModelCached(),
      deviceSatisfied: true,
      deviceDetail: 'Runs locally on CPU.',
      cpuRequiresOptIn: false,
      provisionRemedy: KOKORO_PROVISION_COMMAND,
      notes: [`Runtime pin ${KOKORO_JS_VERSION}. Preset voices, not a clone.`],
    },
  ];
}

export function engineFacts(
  probes: readonly EngineProbe[],
  approvalBlockedCodes: Readonly<Record<string, readonly string[]>> = {},
  lastFailures: Readonly<Record<string, { code: string; message: string } | null>> = {}
): VoiceAudioEngineFacts[] {
  return probes.map((probe) => ({
    engine: probe.kind,
    label: probe.label,
    runtimeInstalled: probe.runtimeInstalled,
    provisioned: probe.provisioned,
    deviceSatisfied: probe.deviceSatisfied,
    deviceDetail: probe.deviceDetail,
    cpuRequiresOptIn: probe.cpuRequiresOptIn,
    approvalBlockedCodes: approvalBlockedCodes[probe.kind] ?? [],
    lastFailure: lastFailures[probe.kind] ?? null,
    provisionRemedy: probe.provisionRemedy,
  }));
}

/* ------------------------------------------------------------------ */
/*  Synthesizer construction                                           */
/* ------------------------------------------------------------------ */

export interface SynthesizerContext {
  engineContractId?: ChatterboxEngineContractId;
  /** Repo-relative scratch dir for the Chatterbox raw output. */
  scratchDir?: string;
}

/**
 * Build the EXISTING adapter for an engine. Returns null when the engine is not
 * usable — callers must then answer with the engine status instead of silently
 * substituting another engine.
 */
export function buildSynthesizer(
  kind: VoiceAudioEngineKind,
  context: SynthesizerContext = {}
): { synthesizer: import('@buildtrack/core').AudioSynthesizer; notes: string[] } | null {
  const probes = probeEngines();
  const probe = probes.find((p) => p.kind === kind);
  if (!probe || !probe.provisioned || !probe.deviceSatisfied) return null;

  if (kind === 'chatterbox') {
    const contractId = context.engineContractId ?? chatterboxContractId();
    const contract = getChatterboxEngineContract(contractId);
    if (!contract) return null;
    const fixture = isChatterboxTestFixtureEnabled();
    /**
     * Approved storage roots are DERIVED from the app's configured data/output
     * directories (never hard-coded) so a deployment that relocates
     * `BUILDTRAKE_DATA` keeps working, and so a test that isolates the data
     * directory is exercising the same code path as production.
     */
    const rootRel = (dir: string): string => {
      const rel = path.relative(ROOT, path.resolve(dir)).split(path.sep).join('/');
      return rel.endsWith('/') ? rel : `${rel}/`;
    };
    const dataRoot = rootRel(DATA_DIR);
    const outputRoot = rootRel(OUTPUT_DIR);
    const synthesizer = new ChatterboxDialogueSynthesizer({
      engineContractId: contractId,
      ...(process.env.BUILDTRAKE_CHATTERBOX_PYTHON ? { pythonPath: process.env.BUILTRAKE_CHATTERBOX_PYTHON } : {}),
      ...(fixture ? { workerScriptPath: 'tests/fixtures/chatterbox-fake-worker.py' } : {}),
      /*
       * TEST/FIXTURE ONLY: the deterministic fake worker selects its behaviour
       * from `FAKE_CHATTERBOX_MODE`, and the adapter deliberately runs it with a
       * sanitized environment allow-list. The escape hatch is therefore gated
       * behind the same `BUILDTRAKE_CHATTERBOX_TEST_WORKER=1` flag that selects
       * the fake worker at all, so it can never be reached in normal operation.
       */
      ...(fixture && process.env.FAKE_CHATTERBOX_MODE
        ? { workerEnv: { FAKE_CHATTERBOX_MODE: process.env.FAKE_CHATTERBOX_MODE } }
        : {}),
      ...(process.env.BUILDTRAKE_CHATTERBOX_MARKER ? { markerPath: process.env.BUILDTRAKE_CHATTERBOX_MARKER } : {}),
      ...(context.scratchDir ? { scratchDir: context.scratchDir } : {}),
      voiceSettings: chatterboxVoiceSettingsOrDefaults(contractId),
      device: probe.deviceSatisfied && !missingNvidiaGpu() ? 'cuda' : 'cpu',
      allowCpu: process.env.CHATTERBOX_ALLOW_CPU === '1' || fixture,
      /**
       * Storage roots deliberately narrowed to the project data tree — the
       * default adapter allow-list (audio/, output/, .chatterbox/) is wider than
       * this route needs and this route must never write a repository source
       * file.
       */
      outputRoots: [dataRoot, '.chatterbox/'],
      scratchRoots: ['.chatterbox/', dataRoot, outputRoot],
      referenceRoots: [dataRoot],
    });
    return {
      synthesizer,
      notes: [
        ...probe.notes,
        `Contract ${contractId} → ${contract.modelId} @ ${probe.modelRevision?.slice(0, 12) ?? 'unresolved'}`,
      ],
    };
  }

  /* Kokoro: the adapter is constructed but its model is only loaded when it is
   * actually asked to synthesize (its own lazy `ensureLoaded`). */
  return {
    synthesizer: new KokoroDialogueSynthesizer(),
    notes: [`Kokoro presets (runtime ${KOKORO_JS_VERSION}); no cloned voice is used.`],
  };
}

export function sha256OfFile(absPath: string): string {
  return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/** Sanitized message for a synthesis failure: no absolute paths, no secrets. */
export function sanitizeEngineError(error: unknown): { code: string; message: string; remediation?: string } {
  const e = error as Partial<AudioSynthesisError> & { message?: string };
  const code = typeof e?.code === 'string' ? e.code : 'VOICE_AUDIO_GENERATION_FAILED';
  const details = (e?.details ?? {}) as Record<string, unknown>;
  const remediation = typeof details.remediation === 'string' ? details.remediation : undefined;
  const raw = typeof e?.message === 'string' ? e.message : 'Audio generation failed.';
  const message = raw
    .split(ROOT)
    .join('<repo>')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"`|,;:]*[\\/])*([^\s'"`|,;:/\\]+)/g, '<path>/$1')
    .slice(0, 600);
  return { code, message, ...(remediation ? { remediation } : {}) };
}

/** Truthful label for the engine id that produced a preview. */
export function engineSummaryFor(kind: VoiceAudioEngineKind, notes: readonly string[]): string {
  const base = kind === 'chatterbox' ? `Chatterbox (${CHATTERBOX_ENGINE_ID})` : `Kokoro (${KOKORO_ENGINE_ID})`;
  return notes.length > 0 ? `${base} — ${notes.join(' ')}` : base;
}

/**
 * Build the synthesis request for ONE speaker segment. The complete spoken text
 * is preserved verbatim: this function never trims, splits or re-times speech.
 */
export function segmentRequest(input: {
  projectId: string;
  sceneIndex: number;
  turnIndex: number;
  globalTurnIndex: number;
  speakerId: string;
  speakerName: string;
  voiceSlot: string;
  voiceProfileId: string;
  voiceProfile: import('@buildtrack/core').VoiceProfile;
  language: string;
  spokenText: string;
  targetPath: string;
}): AudioSynthesisRequest {
  return {
    scenarioId: input.projectId,
    sceneId: `voice-audio-${input.sceneIndex + 1}`,
    turnId: `turn-${String(input.turnIndex + 1).padStart(2, '0')}`,
    clipId: `clip_voice-audio_${input.speakerId}_${input.globalTurnIndex + 1}`,
    speakerId: input.speakerId,
    speakerName: input.speakerName,
    voiceSlot: input.voiceSlot,
    voiceProfileId: input.voiceProfileId,
    voiceProfile: input.voiceProfile,
    language: input.language,
    spokenText: input.spokenText,
    targetPath: input.targetPath,
    audioFormat: { container: 'wav', sampleRate: 48000, channels: 1, codec: 'pcm_s16le', bitDepth: 16 },
    sceneIndex: input.sceneIndex,
    turnIndex: input.turnIndex,
    globalTurnIndex: input.globalTurnIndex,
  };
}

export { VOICE_AUDIO_TIMING_INTEGRATION_POINT } from '@buildtrack/core';
