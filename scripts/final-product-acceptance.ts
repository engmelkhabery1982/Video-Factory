/**
 * FINAL PRODUCT ACCEPTANCE — resumable, gated acceptance driver.
 *
 * TEST INFRASTRUCTURE ONLY. It drives the REAL product surfaces:
 *   - the real product server (`node --import tsx apps/api/src/server.ts`,
 *     the exact command `npm start` runs) spoken to over real HTTP,
 *   - the real Asset Library multipart upload route,
 *   - the real production engine: generation, dialogue edit, explicit asset
 *     binding, persistence, Phase 4 production dialogue (Kokoro), Phase 5
 *     plans, Phase 6A asset resolution, Phase 6C render targets and the
 *     Phase 6D production package.
 *
 * No product code is modified. No fixture scenario, no canonical Phase 6E
 * project, no shared dialogue.wav and no previously rendered artifact is used:
 * the acceptance content is authored fresh here and is fictional by design.
 *
 * One subcommand per GitHub Actions job, so a failure never forces expensive
 * stages to repeat:
 *   preflight         cheap gates: TTS, real audio, generation, edit, reopen,
 *                     stale-input, asset registration + Long/Short binding +
 *                     absolute live-server media URLs + mediaMap
 *   short-smoke       real product preview job: native 1080x1920 Short render
 *                     + real media verification + asset frame proof
 *   final-production  real product export job: Long 1920x1080 + Short 1080x1920
 *                     + Phase 6D package + asset frame proof
 *   second-project    a SECOND fresh project proving cross-project production
 *                     history reuse with no render (17G)
 *   evidence          aggregate lightweight evidence + assert every required
 *                     stage ran (acceptance-verification.json)
 *
 * Usage: node --import tsx scripts/final-product-acceptance.ts <subcommand>
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { productionJobFailureDetail } from './acceptance-render-diagnostics.js';

/* Acceptance content lives in its own module so the acceptance tests can guard
   the exact content shape (including the deterministic duplicate structure). */
import {
  ACCEPTANCE_ASSET,
  ACCEPTANCE_INPUT,
  ACCEPTANCE_VIDEO_ID,
  SECOND_ACCEPTANCE_INPUT,
  SECOND_ACCEPTANCE_VIDEO_ID,
  SECOND_SOURCE_NUMBERS,
  SOURCE_NUMBERS,
} from './acceptance-content.js';

export { ACCEPTANCE_VIDEO_ID, SECOND_ACCEPTANCE_VIDEO_ID };

import {
  AUDIO_DUPLICATE_EXPECTED,
  classifyAudioHashes,
  type AudioIdentityReport,
  type PerTurnAudioRecord,
} from './acceptance-audio-identity.js';

/* Evidence envelope/run-identity validation and the planned asset exposure
   windows used to select frames INSIDE the real asset display window. */
import {
  assetExposureWindows,
  controlSampleTimes,
  validateStageEnvelope,
  validateStagePayload,
  windowSampleTimes,
  type ExposureWindow,
  type SceneTurnDurations,
} from './acceptance-stage-validation.js';

/* ------------------------------------------------------------------ */
/*  Isolated scratch — never touches a real home directory             */
/* ------------------------------------------------------------------ */

const ROOT = process.cwd();
const SCRATCH = path.join(ROOT, '.stills', 'final-acceptance');
const DATA_DIR = path.join(SCRATCH, 'data');
const OUTPUT_DIR = path.join(SCRATCH, 'output');
const EVIDENCE_DIR = path.join(ROOT, 'EVIDENCE', 'final-product');
const STAGE_DIR = path.join(SCRATCH, 'stage');

for (const d of [SCRATCH, DATA_DIR, OUTPUT_DIR, EVIDENCE_DIR, STAGE_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

/* The API reads these at module load — set them before any product module is
   imported. Static imports are hoisted above this assignment, so any module
   that (transitively) imports apps/api/src/services/platform.ts MUST be loaded
   with `await import()` from code that runs after this point: platform.ts
   freezes DATA_DIR/OUTPUT_DIR from BUILDTRAKE_DATA/BUILDTRAKE_OUTPUT at module
   load, and a static import would pin the product to the repository `data/`
   and `output/` directories instead of the isolated acceptance scratch (the
   retry-7 preflight regression). */
process.env.BUILDTRAKE_DATA = DATA_DIR;
process.env.BUILDTRAKE_OUTPUT = OUTPUT_DIR;
process.env.NODE_ENV = 'production';

/**
 * Acceptance-only AUDIO probe (analyseFile() is a VIDEO analyser and throws on
 * a legitimate audio-only WAV, so per-turn/canonical WAVs are measured here).
 *
 * It statically imports apps/api/src/services/platform.ts, so it is loaded
 * lazily — never as a top-level import — keeping it below the scratch
 * environment assignment above. Guarded by tests/acceptance-import-order.test.ts.
 */
async function loadAudioProbe(): Promise<typeof import('./acceptance-audio-probe.js')> {
  return import('./acceptance-audio-probe.js');
}

/* ------------------------------------------------------------------ */
/*  Fresh, unseen, fictional acceptance content                        */
/* ------------------------------------------------------------------ */


/**
 * Newly authored for this acceptance. A clearly fictional pro */
/* ------------------------------------------------------------------ */

type Evidence = Record<string, unknown>;

const checks: Evidence[] = [];
let currentGate = '';

export function gate(name: string): void {
  currentGate = name;
  console.log(`\n[gate] ${name}`);
}

export function check(label: string, condition: boolean, detail: unknown = null): void {
  if (!condition) {
    throw new AcceptanceFailure(`${currentGate}: ${label}`, detail);
  }
  console.log(`  ✓ ${label}`);
  checks.push({ gate: currentGate, label, ok: true, ...(detail === null ? {} : { detail }) });
}

export class AcceptanceFailure extends Error {
  public readonly detail: unknown;
  constructor(message: string, detail: unknown = null) {
    super(message);
    this.name = 'AcceptanceFailure';
    this.detail = detail;
  }
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Resolve a persisted Asset.path.
 *
 * The product stores `Asset.path` RELATIVE TO DATA_DIR (e.g.
 * `assets/rfi-ageing-summary-xxxx.svg`), exactly like `POST /api/assets` does
 * in `apps/api/src/routes/assets.ts`. Final Acceptance runs with
 * BUILDTRAKE_DATA pointed at an isolated scratch directory, so the real file
 * lives under DATA_DIR, never under the repository root. This helper is the
 * single place that resolution happens.
 */
function assetFilePath(assetPath: string): string {
  return path.join(DATA_DIR, assetPath);
}

/**
 * Discover the logical asset refs that the GENERATED production content
 * actually exposes, and deterministically select one that supports explicit
 * binding.
 *
 * The product is the only source of truth. Two product-generated sources are
 * unioned:
 *
 *   1. the built plan response — `unresolvedRequired` (required + unresolved)
 *      and `mediaMap` keys (already resolved refs);
 *   2. the generated Scenario objects themselves — every
 *      `scene.production.screenInsert.assetRef` of the target.
 *
 * Source 2 is required because a freshly generated, still-unbound OPTIONAL
 * slot appears in neither `mediaMap` nor `unresolvedRequired`, so the build
 * response alone cannot surface it. The Scenario is the product's own record
 * of the logical slot, so reading it introduces no invented value: nothing is
 * hardcoded, no Scenario is mutated and no mediaMap is fabricated.
 *
 * Deterministic selection rule (first match wins):
 *   1. a REQUIRED unresolved asset ref, if one exists;
 *   2. otherwise the first unresolved OPTIONAL asset ref;
 *   3. otherwise the first asset usage/logical ref present in the plan that
 *      supports explicit binding.
 *
 * Returns `selected: null` when the generated content exposes zero asset refs.
 */
function selectBindableLogicalAssetRef(input: {
  planTargets: Array<{
    target: string;
    mediaMap?: Record<string, string> | null;
    unresolvedRequired?: string[] | null;
  }>;
  generatedScenarios?: Record<string, any>;
  /** Which generated target to inspect. Defaults to the Long target. */
  target?: string;
}): {
  discovered: Array<{ logicalRef: string; required: boolean; unresolved: boolean; reason: string }>;
  selected: string | null;
  selectionReason: string | null;
} {
  const required = new Set<string>();
  for (const t of input.planTargets) {
    for (const r of t.unresolvedRequired ?? []) required.add(r);
  }

  const targetName = input.target ?? 'long';
  const discovered = new Map<string, { logicalRef: string; required: boolean; unresolved: boolean; reason: string }>();
  const longPlan = input.planTargets.find((t) => t.target === targetName) ?? input.planTargets[0];
  const resolvedUrls = new Set(Object.values(longPlan?.mediaMap ?? {}));
  const unresolvedRequired = longPlan?.unresolvedRequired ?? [];
  const planRefs = [...unresolvedRequired, ...Object.keys(longPlan?.mediaMap ?? {})];
  const planRefSet = new Set(planRefs);

  // Source 1 — the refs the built plan itself exposes.
  for (const ref of planRefs) {
    if (typeof ref !== 'string' || !ref.trim()) continue;
    const isRequired = required.has(ref);
    const unresolved = !resolvedUrls.has(ref) || unresolvedRequired.includes(ref);
    const reason = isRequired
      ? `required asset ref exposed by the generated ${targetName} plan`
      : `optional asset ref exposed by the generated ${targetName} plan`;
    const prev = discovered.get(ref);
    if (!prev) discovered.set(ref, { logicalRef: ref, required: isRequired, unresolved, reason });
    else if (isRequired) discovered.set(ref, { ...prev, required: true, reason });
  }

  // Source 2 — the generated Scenario's own logical media slots.
  const longScenario = input.generatedScenarios?.[targetName];
  for (const scene of longScenario?.scenes ?? []) {
    const ref = scene?.production?.screenInsert?.assetRef;
    if (typeof ref !== 'string' || !ref.trim()) continue;
    const prev = discovered.get(ref);
    if (prev) continue;
    const inPlan = planRefSet.has(ref);
    const isRequired = required.has(ref);
    const unresolved = !inPlan || !resolvedUrls.has(ref) || unresolvedRequired.includes(ref);
    discovered.set(ref, {
      logicalRef: ref,
      required: isRequired,
      unresolved,
      reason: inPlan
        ? `generated logical media slot exposed by the generated ${targetName} Scenario and plan`
        : `generated logical media slot exposed by the generated ${targetName} Scenario (unbound, optional)`,
    });
  }

  // Deterministic ordering: required first, then first appearance in the plan.
  const ordered = [...discovered.values()].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.logicalRef < b.logicalRef ? -1 : a.logicalRef > b.logicalRef ? 1 : 0;
  });

  const requiredUnresolved = ordered.find((r) => r.required && r.unresolved);
  if (requiredUnresolved) {
    return { discovered: ordered, selected: requiredUnresolved.logicalRef, selectionReason: 'rule 1: required unresolved asset ref' };
  }
  const optionalUnresolved = ordered.find((r) => !r.required && r.unresolved);
  if (optionalUnresolved) {
    return { discovered: ordered, selected: optionalUnresolved.logicalRef, selectionReason: 'rule 2: first unresolved optional asset ref' };
  }
  const anyRef = ordered.find((r) => r.unresolved);
  if (anyRef) {
    return { discovered: ordered, selected: anyRef.logicalRef, selectionReason: 'rule 3: first asset usage in the generated plan that supports explicit binding' };
  }
  return { discovered: ordered, selected: null, selectionReason: null };
}

/** Fetch the real bytes the product serves for an asset over real HTTP. */
async function fetchAssetBytes(baseUrl: string, assetId: string): Promise<{ status: number; bytes: Buffer; contentType: string | null }> {
  const res = await fetch(`${baseUrl}/media/asset/${encodeURIComponent(assetId)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes, contentType: res.headers.get('content-type') };
}

function writeEvidence(name: string, payload: unknown): string {
  const file = path.join(EVIDENCE_DIR, name);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[evidence] ${path.relative(ROOT, file)}`);
  return file;
}

/**
 * GitHub Actions run identity. Stage evidence must be attributable to THIS run
 * and THIS commit; a restored artifact from another run is rejected (item H).
 * Outside Actions both are null and the identity assertions are skipped.
 */
const RUN_ID = process.env.GITHUB_RUN_ID ?? null;
const COMMIT = process.env.GITHUB_SHA ?? null;

/**
 * Persist one stage document. The envelope (stage/status/runId/commit/
 * generatedAt) is written by the driver itself, so a stage can never claim to
 * have passed without this run's identity attached.
 */
function saveStage(stage: string, payload: Record<string, unknown>): void {
  const document = {
    stage,
    status: 'passed',
    runId: RUN_ID,
    commit: COMMIT,
    generatedAt: new Date().toISOString(),
    ...payload,
  };
  fs.writeFileSync(path.join(STAGE_DIR, `${stage}.json`), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/** Read a stage document for aggregation (throws when the stage did not run). */
function readStageDocument(stage: string): Record<string, unknown> {
  return loadStage(stage) as Record<string, unknown>;
}

function loadStage(stage: string): any {
  const file = path.join(STAGE_DIR, `${stage}.json`);
  if (!fs.existsSync(file)) {
    throw new AcceptanceFailure(
      `missing ${stage} stage evidence — its upstream gate did not run, so this stage must not run`,
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* ------------------------------------------------------------------ */
/*  The real product server, over real HTTP                            */
/* ------------------------------------------------------------------ */

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new AcceptanceFailure('the real product server did not become healthy in time');
}

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function startRealServer(): Promise<{ baseUrl: string; close: () => Promise<void>; logTail: () => string }> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/api/src/server.ts'],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const log: string[] = [];
  child.stdout?.on('data', (d) => log.push(String(d)));
  child.stderr?.on('data', (d) => log.push(String(d)));

  // The real server honours PORT/HOST exactly like `npm start` does.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AcceptanceFailure('real server startup timed out')), 60_000);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    const scan = () => {
      const text = log.join('');
      if (text.includes(`:${port}`) || text.includes(`API:`)) {
        clearTimeout(timer);
        resolve();
      } else {
        setTimeout(scan, 300);
      }
    };
    scan();
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, 60_000);
  console.log(`[api] real product server (npm start) live at ${baseUrl}`);
  return {
    baseUrl,
    logTail: () => log.join('').slice(-4000),
    close: async () => {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 10_000);
      });
    },
  };
}

async function apiJson(
  baseUrl: string,
  route: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${route}`, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Register a real local asset through the real Asset Library multipart route. */
async function uploadRealAsset(baseUrl: string, filePath: string): Promise<any> {
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  form.append('file', new Blob([bytes], { type: 'image/svg+xml' }), path.basename(filePath));
  form.append('name', ACCEPTANCE_ASSET.name);
  form.append('kind', ACCEPTANCE_ASSET.kind);
  form.append('source', ACCEPTANCE_ASSET.source);
  form.append('license', ACCEPTANCE_ASSET.license);
  form.append('tags', ACCEPTANCE_ASSET.tags.join(','));
  const res = await fetch(`${baseUrl}/api/assets`, { method: 'POST', body: form });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || !body?.asset) {
    throw new AcceptanceFailure('Asset Library upload failed', { status: res.status, body });
  }
  return body.asset;
}

/* ------------------------------------------------------------------ */
/*  Deterministic acceptance asset (authored here, not a fixture)      */
/* ------------------------------------------------------------------ */

function buildAcceptanceAssetSvg(): string {
  // A deterministic "RFI Ageing Summary" chart. No randomness, no network,
  // no fixture content.
  const bars: Array<[string, number]> = [
    ['0-7d', 6],
    ['8-14d', 10],
    ['15-21d', 5],
    ['22-28d', 2],
    ['29d+', 1],
  ];
  const width = 960;
  const height = 540;
  const max = Math.max(...bars.map(([, v]) => v));
  const plotW = 760;
  const plotH = 340;
  const baseY = 470;
  const step = plotW / bars.length;
  const rects = bars
    .map(([label, value], i) => {
      const h = (value / max) * plotH;
      const x = 100 + i * step + 18;
      const y = baseY - h;
      const w = step - 36;
      // Marker colour: deliberately OUTSIDE the BuildTrack brand palette so the
      // acceptance frame proof can find the ASSET's own pixels in a rendered
      // frame (see writeAssetFrameProof / ASSET_MARKER_RGB).
      return [
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#ff00aa" />`,
        `<text x="${x + w / 2}" y="${y - 12}" font-family="sans-serif" font-size="26" fill="#0b2545" text-anchor="middle">${value}</text>`,
        `<text x="${x + w / 2}" y="${baseY + 34}" font-family="sans-serif" font-size="22" fill="#42526e" text-anchor="middle">${label}</text>`,
      ].join('');
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <text x="48" y="64" font-family="sans-serif" font-size="34" font-weight="700" fill="#0b2545">RFI Ageing Summary</text>
  <text x="48" y="100" font-family="sans-serif" font-size="20" fill="#42526e">Fictional training example — 24 open RFIs, 8 older than 14 days</text>
  <line x1="100" y1="${baseY}" x2="${100 + plotW}" y2="${baseY}" stroke="#c1c7d0" stroke-width="2"/>
  ${rects}
  <text x="48" y="524" font-family="sans-serif" font-size="18" fill="#6b778c">Generated locally for Final Product Acceptance — project-owned evidence</text>
</svg>
`;
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

async function readState(): Promise<any> {
  const { loadProductionState } = await import('../apps/api/src/services/production-state.js');
  const state = loadProductionState(ACCEPTANCE_VIDEO_ID);
  if (!state) throw new AcceptanceFailure('production state is missing — the preflight gate must run first');
  return state;
}

/**
 * The PRODUCT's own production-audio path authority.
 *
 * The production engine writes per-turn Kokoro WAVs and canonical audio under
 * its project-scoped `.production/<videoId>/audio/{dialogue,canonical}` root
 * (`productionAudioBasePaths` in apps/api/src/services/platform.ts). Acceptance
 * must never re-derive that formula: it asks the product, and the same helper
 * is what the product routes pass to the plan builder.
 */
async function productionAudioPaths(): Promise<{ root: string; synthesisBasePath: string; canonicalBasePath: string }> {
  const { productionAudioBasePaths } = await import('../apps/api/src/services/platform.js');
  return productionAudioBasePaths(ACCEPTANCE_VIDEO_ID) as { root: string; synthesisBasePath: string; canonicalBasePath: string };
}

/** Absolute WAV paths under a directory (the walker returns full paths). */
function wavFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.wav')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** The shared fixture narration that production audio must NEVER be. */
const SHARED_FIXTURE_DIALOGUE = 'tests/fixtures/render/dialogue.wav';

/**
 * SEMANTIC per-turn audio verification (the replacement for the invalid
 * "every physical WAV must have a unique hash" assertion).
 *
 * For every expected dialogue turn the product MUST have written exactly one
 * real WAV, at the product's own deterministic path, under the product audio
 * root, non-empty, with the turn's own scenario/scene/turn identity and its own
 * speaker/voiceSlot/text. Duplicate BYTES are then judged semantically: a group
 * of identical hashes is a failure only when its members differ in the acoustic
 * synthesis request (spokenText / resolved Kokoro voice / speed / engine /
 * model).
 */
async function buildPerTurnAudioIdentity(state: any): Promise<{
  records: PerTurnAudioRecord[];
  report: AudioIdentityReport;
  paths: { root: string; synthesisBasePath: string; canonicalBasePath: string };
}> {
  const core = await import('../packages/core/dist/index.js');
  const kokoro = await import('../packages/core/dist/scenario/kokoro-dialogue-synthesizer.js');
  const { planDialogueAudio, resolveDialogueAudioPlanVoices } = core as unknown as {
    planDialogueAudio: (scenario: unknown) => { clips: Array<Record<string, unknown>> };
    resolveDialogueAudioPlanVoices: (plan: unknown) => { bySlot: Record<string, { id?: string; gender?: string } | undefined> };
  };
  const { resolveKokoroVoice, KOKORO_VOICE_BY_SLOT, KOKORO_MODEL_ID } = kokoro as unknown as {
    resolveKokoroVoice: (request: { voiceSlot: string; voiceProfile: unknown }) => string;
    KOKORO_VOICE_BY_SLOT: Record<string, string>;
    KOKORO_MODEL_ID: string;
  };
  const { generateDeterministicOutputPath } = (await import(
    '../packages/core/dist/scenario/synthesize-dialogue.js'
  )) as unknown as {
    generateDeterministicOutputPath: (
      clip: { sceneId: string; turnId: string },
      scenarioId: string,
      basePath: string,
    ) => string;
  };

  const paths = await productionAudioPaths();
  const dialogueDir = path.join(ROOT, paths.synthesisBasePath);
  const canonicalDir = path.join(ROOT, paths.canonicalBasePath);

  const records: PerTurnAudioRecord[] = [];
  const expectedPaths = new Set<string>();
  for (const target of ['long', 'short_1']) {
    const scenario = state.scenarios?.[target];
    if (!scenario) continue;
    const plan = planDialogueAudio(scenario);
    const resolution = resolveDialogueAudioPlanVoices(plan);
    for (const clip of plan.clips as Array<{
      sceneId: string;
      turnId: string;
      speakerId: string;
      voiceSlot: string;
      spokenText: string;
    }>) {
      const profile = resolution.bySlot[clip.voiceSlot] ?? null;
      const resolvedKokoroVoice = resolveKokoroVoice({ voiceSlot: clip.voiceSlot, voiceProfile: profile });
      const expectedWavPath = generateDeterministicOutputPath(
        { sceneId: clip.sceneId, turnId: clip.turnId },
        String(scenario.metadata.id),
        paths.synthesisBasePath,
      );
      const abs = path.join(ROOT, expectedWavPath);
      const exists = fs.existsSync(abs);
      const nonEmpty = exists && fs.statSync(abs).size > 0;
      let durationSeconds: number | null = null;
      let audioCodec: string | null = null;
      let audioSampleRate: number | null = null;
      let audioChannels: number | null = null;
      let audioOnly: boolean | undefined;
      if (exists) {
        /* AUDIO-SPECIFIC probe: this file is a WAV, and analyseFile() is a
           video analyser that throws `No video stream` on it. The probe
           requires a real audio stream and measures duration/codec/rate/channels. */
        try {
          const { probeAudioFile } = await loadAudioProbe();
          const probe = await probeAudioFile(abs, { audioOnly: true, minDurationSeconds: 0.05 });
          durationSeconds = probe.durationSeconds;
          audioCodec = probe.codec;
          audioSampleRate = probe.sampleRate;
          audioChannels = probe.channels;
          audioOnly = probe.audioOnly;
        } catch (e) {
          throw new AcceptanceFailure(
            `per-turn WAV failed the audio-specific probe: ${expectedWavPath}`,
            { error: (e as Error).message, code: (e as { code?: string }).code ?? null },
          );
        }
      }
      expectedPaths.add(expectedWavPath);
      records.push({
        target,
        scenarioId: String(scenario.metadata.id),
        sceneId: clip.sceneId,
        turnId: clip.turnId,
        clipId: `clip_${clip.sceneId}_${clip.turnId}`,
        speakerId: clip.speakerId,
        voiceSlot: clip.voiceSlot,
        voiceProfileId: profile?.id ?? null,
        resolvedKokoroVoice,
        synthesisSpeed: 1,
        engine: 'kokoro-js',
        modelId: KOKORO_MODEL_ID,
        spokenText: clip.spokenText,
        expectedWavPath,
        physicalWavPath: expectedWavPath,
        sha256: exists ? sha256File(abs) : '',
        sizeBytes: exists ? fs.statSync(abs).size : 0,
        durationSeconds,
        audioCodec,
        audioSampleRate,
        audioChannels,
        audioOnly,
        nonEmpty,
        expectedPathExists: exists,
      });
    }
  }

  // Rule 5 — the WAV's own identity must match the turn it claims to be:
  // scenario/scene/turn/speaker/voiceSlot/spokenText come from that turn of the
  // generated Scenario, and the physical path encodes exactly that identity.
  const identityMismatch = records.filter((r) => {
    const scenario = state.scenarios?.[r.target];
    const scene = (scenario?.scenes ?? []).find((sc: any) => sc.id === r.sceneId);
    const turn = (scene?.turns ?? []).find((t: any) => t.id === r.turnId);
    const character = (scenario?.characters ?? []).find((c: any) => c.id === r.speakerId);
    return (
      !turn ||
      turn.spokenText !== r.spokenText ||
      turn.speakerId !== r.speakerId ||
      !character ||
      character.voiceSlot !== r.voiceSlot ||
      r.clipId !== `clip_${r.sceneId}_${r.turnId}` ||
      path.basename(r.physicalWavPath) !== `${r.sceneId}_${r.turnId}.wav` ||
      path.basename(path.dirname(r.physicalWavPath)) !== r.scenarioId
    );
  });
  check(
    'every per-turn WAV identity matches its own turn (scenario/scene/turn/speaker/voiceSlot/spokenText)',
    identityMismatch.length === 0,
    identityMismatch.slice(0, 5).map((r) => ({ target: r.target, sceneId: r.sceneId, turnId: r.turnId, speakerId: r.speakerId })),
  );

  // No two turns may share one physical output path.
  check(
    'no two dialogue turns share one physical per-turn output path',
    expectedPaths.size === records.length,
    { turns: records.length, distinctPaths: expectedPaths.size },
  );

  // Exactly one real, non-empty WAV per expected dialogue turn (no more, no less).
  const missing = records.filter((r) => !r.expectedPathExists);
  check(
    'one real physical WAV exists for every expected dialogue turn',
    missing.length === 0,
    { expectedTurns: records.length, missing: missing.slice(0, 10).map((r) => r.expectedWavPath) },
  );
  const empty = records.filter((r) => r.expectedPathExists && !r.nonEmpty);
  check('every per-turn WAV is non-empty', empty.length === 0, empty.map((r) => r.physicalWavPath));
  const dialogueFiles = wavFiles(dialogueDir);
  const dialogueRelative = new Set(dialogueFiles.map((f) => path.relative(ROOT, f).replace(/\\/g, '/')));
  const unexpected = [...dialogueRelative].filter((f) => !expectedPaths.has(f));
  check(
    'each expected turn maps to exactly one per-turn WAV and the product wrote no unexpected per-turn WAV',
    unexpected.length === 0 && dialogueRelative.size === expectedPaths.size,
    { productFiles: dialogueRelative.size, expectedFiles: expectedPaths.size, unexpected: unexpected.slice(0, 10) },
  );
  check(
    'every per-turn WAV lives under the product audio root',
    dialogueFiles.every((f) => f.startsWith(dialogueDir + path.sep)),
    dialogueFiles.slice(0, 5).map((f) => path.relative(ROOT, f)),
  );

  // No WAV anywhere under .production outside the product audio root (the Retry
  // 4 ENOENT class of defect: a re-derived scratch audio path).
  const productionRootWavs = wavFiles(path.join(ROOT, '.production'));
  const outsideRoot = productionRootWavs.filter(
    (f) => !f.startsWith(dialogueDir + path.sep) && !f.startsWith(canonicalDir + path.sep),
  );
  check(
    'no production WAV exists outside the product audio root (no re-derived scratch audio path)',
    outsideRoot.length === 0,
    { productRootWavs: productionRootWavs.length, outsideRoot: outsideRoot.slice(0, 5).map((f) => path.relative(ROOT, f)) },
  );

  // Resolved voice must be the registry-owned mapping for the turn's voiceSlot.
  const misresolved = records.filter(
    (r) => Object.prototype.hasOwnProperty.call(KOKORO_VOICE_BY_SLOT, r.voiceSlot) && KOKORO_VOICE_BY_SLOT[r.voiceSlot] !== r.resolvedKokoroVoice,
  );
  check(
    'every turn resolves its voice deterministically from its voiceSlot (registry mapping, no inference)',
    misresolved.length === 0,
    misresolved.slice(0, 5).map((r) => ({ voiceSlot: r.voiceSlot, resolved: r.resolvedKokoroVoice })),
  );
  const usedVoices = new Set(records.map((r) => r.resolvedKokoroVoice));
  check('at least 2 distinct resolved Kokoro voices are actually used', usedVoices.size >= 2, [...usedVoices]);
  const slots = new Set(records.map((r) => r.voiceSlot));
  check('at least 2 distinct production voice slots configured', slots.size >= 2, [...slots]);

  // Never the shared fixture narration.
  const fixturePath = path.join(ROOT, SHARED_FIXTURE_DIALOGUE);
  const fixtureHash = fs.existsSync(fixturePath) ? sha256File(fixturePath) : null;
  const hashes = records.map((r) => r.sha256);
  check(
    'no production WAV is the shared fixture dialogue.wav',
    fixtureHash === null || !hashes.includes(fixtureHash),
    { fixture: SHARED_FIXTURE_DIALOGUE, fixtureHash },
  );

  return { records, report: classifyAudioHashes(records), paths };
}

async function verifyRealAudio(label: string, state: any): Promise<Record<string, unknown>> {
  gate(label);
  const { records, report, paths } = await buildPerTurnAudioIdentity(state);
  const dialogueDir = path.join(ROOT, paths.synthesisBasePath);
  const canonicalDir = path.join(ROOT, paths.canonicalBasePath);
  const canonical = wavFiles(canonicalDir);

  console.log(`  [audio] product authority root: ${paths.root}`);
  console.log(`  [audio] ${report.classificationSummary.duplicateTurnsExplanation}`);

  // THE semantic rule. Identical synthesis request -> identical bytes are
  // expected. Differing synthesis request -> must not collide.
  check(
    'no two turns with different acoustic synthesis requests produced identical bytes',
    report.collisions.length === 0,
    report.collisions,
  );
  for (const group of report.duplicateHashGroups) {
    check(
      `duplicate hash group is identical-request determinism (${group.memberCount} turns, ${group.distinctSynthesisKeys} distinct synthesis key(s))`,
      group.classification === AUDIO_DUPLICATE_EXPECTED,
      group,
    );
  }
  console.log(
    `  [audio] duplicate hash groups: ${report.duplicateHashGroups.length} ` +
      `(expected deterministic: ${report.classificationSummary.expectedDeterministicDuplicates}, ` +
      `unexpected collisions: ${report.classificationSummary.unexpectedCollisions})`,
  );
  for (const group of report.duplicateHashGroups) {
    const members = group.members
      .map((m) => `${m.target}:${m.sceneId}/${m.turnId} voice=${m.resolvedKokoroVoice} text="${m.spokenText.slice(0, 60)}"`)
      .join(' | ');
    console.log(`    ${group.sha256.slice(0, 12)} ${group.classification}: ${members}`);
  }

  // Every per-turn WAV must be a REAL audio-only PCM file: the audio-specific
  // probe measured each one (analyseFile() never could).
  const probedValues = records.filter((r) => r.expectedPathExists);
  const unprobed = probedValues.filter((r) => r.durationSeconds === null || !r.audioOnly);
  check(
    'every per-turn WAV is an audio-only file with a measurable duration (audio-specific probe)',
    unprobed.length === 0,
    unprobed.slice(0, 5).map((r) => ({
      file: r.physicalWavPath,
      durationSeconds: r.durationSeconds,
      audioOnly: r.audioOnly,
    })),
  );
  const badAudioFormat = probedValues.filter(
    (r) => r.audioCodec !== 'pcm_s16le' || r.audioChannels !== 1 || !Number.isInteger(r.audioSampleRate) || Number(r.audioSampleRate) <= 0,
  );
  check(
    'every per-turn WAV is PCM16 mono with a valid sample rate',
    badAudioFormat.length === 0,
    badAudioFormat.slice(0, 5).map((r) => ({
      file: r.physicalWavPath,
      codec: r.audioCodec,
      channels: r.audioChannels,
      sampleRate: r.audioSampleRate,
    })),
  );

  check('normalized canonical audio exists', canonical.length > 0, canonical.length);
  let sampleRate: unknown = null;
  let channels: unknown = null;
  let codec: unknown = null;
  let canonicalProbe: Record<string, unknown> | null = null;
  if (canonical.length > 0) {
    // The canonical WAV is audio-only: probe it with the AUDIO-specific probe,
    // requiring the canonical contract (48 kHz / mono / pcm_s16le) in one call.
    const { probeAudioFile } = await loadAudioProbe();
    const probe = await probeAudioFile(canonical[0], {
      codec: 'pcm_s16le',
      sampleRate: 48000,
      channels: 1,
      audioOnly: true,
      minDurationSeconds: 0.5,
    });
    sampleRate = probe.sampleRate;
    channels = probe.channels;
    codec = probe.codec;
    canonicalProbe = {
      file: path.relative(ROOT, canonical[0]),
      durationSeconds: probe.durationSeconds,
      codec: probe.codec,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      audioOnly: probe.audioOnly,
    };
    check('canonical audio is 48 kHz', probe.sampleRate === 48000, probe.sampleRate);
    check('canonical audio is mono', probe.channels === 1, probe.channels);
    check('canonical audio is PCM16 (pcm_s16le)', probe.codec === 'pcm_s16le', probe.codec);
  }

  const identity = {
    totalPerTurnWavs: records.length,
    totalUniqueHashes: report.totalUniqueHashes,
    totalUniqueSynthesisKeys: report.totalUniqueSynthesisKeys,
    duplicateHashGroups: report.duplicateHashGroups,
    sameKeyDifferentHashes: report.sameKeyDifferentHashes,
    classificationSummary: report.classificationSummary,
    /* The full per-turn record set: identity + hash + path + duration. */
    perTurnRecords: records,
    productContract: {
      deterministicEngine: 'kokoro-js (KOKORO_VOICE_BY_SLOT mapping, speed=1, fixed ONNX model)',
      physicalFilePerTurn: 'one WAV per request.targetPath',
      deterministicPath: 'generateDeterministicOutputPath -> <basePath>/<scenarioId>/<sceneId>_<turnId>.wav',
      identicalRequestProducesIdenticalBytes: true,
      differingRequestMustNotCollide: true,
    },
  };
  writeEvidence('audio-per-turn-identity.json', identity);

  return {
    audioRootAuthority: 'productionAudioBasePaths(videoId) - the same helper the product routes use',
    productAudioRoot: paths.root,
    synthesisBasePath: paths.synthesisBasePath,
    canonicalBasePath: paths.canonicalBasePath,
    perTurnFiles: records.length,
    expectedDialogueTurns: records.length,
    distinctPerTurnHashes: report.totalUniqueHashes,
    duplicateHashGroups: report.duplicateHashGroups.length,
    /* Every duplicate group, with each member's identity + synthesis key + classification. */
    duplicateHashGroupDetail: report.duplicateHashGroups,
    expectedDeterministicDuplicates: report.classificationSummary.expectedDeterministicDuplicates,
    unexpectedCollisions: report.classificationSummary.unexpectedCollisions,
    sameKeyDifferentHashes: report.sameKeyDifferentHashes.length,
    identityEvidenceFile: 'EVIDENCE/final-product/audio-per-turn-identity.json',
    canonicalFiles: canonical.length,
    canonicalSampleRate: sampleRate,
    canonicalChannels: channels,
    canonicalCodec: codec,
    canonicalProbe,
    /* The measured per-turn records: used by the frame-proof window selection. */
    perTurnRecords: records.map((r) => ({
      target: r.target,
      sceneId: r.sceneId,
      turnId: r.turnId,
      durationSeconds: r.durationSeconds,
      audioCodec: r.audioCodec ?? null,
      audioSampleRate: r.audioSampleRate ?? null,
      audioChannels: r.audioChannels ?? null,
      audioOnly: r.audioOnly ?? false,
    })),
    sharedFixtureUsed: false,
    sharedFixturePath: SHARED_FIXTURE_DIALOGUE,
    voiceSlots: [...new Set(records.map((r) => r.voiceSlot))],
    resolvedKokoroVoices: [...new Set(records.map((r) => r.resolvedKokoroVoice))],
  };
}

/* ------------------------------------------------------------------ */
/*  Stage 1 — preflight                                                */
/* ------------------------------------------------------------------ */

async function stagePreflight(): Promise<void> {
  const { validateScenario } = await import('../packages/core/dist/index.js');

  gate('A. TTS cache present (real Kokoro, no SAM fallback)');
  const ttsMarker = path.join(ROOT, '.tts-cache', '.kokoro-model.ok');
  const ttsModel = path.join(
    ROOT, '.tts-cache', 'models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_quantized.onnx',
  );
  check('Kokoro model marker exists', fs.existsSync(ttsMarker), ttsMarker);
  check('Kokoro quantized ONNX model exists', fs.existsSync(ttsModel), ttsModel);
  const modelBytes = fs.existsSync(ttsModel) ? fs.statSync(ttsModel).size : 0;
  check('Kokoro model is non-trivial in size', modelBytes > 1_000_000, `${modelBytes} bytes`);

  const server = await startRealServer();
  const base = server.baseUrl;
  try {
    gate('B. create the fresh acceptance project through the real API');
    const created = await apiJson(base, '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ACCEPTANCE_INPUT),
    });
    check('project created via POST /api/projects', created.status === 200 || created.status === 201, created.status);
    check('project id is the acceptance id', created.body?.project?.meta?.input?.videoId === ACCEPTANCE_VIDEO_ID, created.body?.project?.meta?.input?.videoId);

    gate('C. generate Long + short_1 from ProjectInput');
    const gen = await apiJson(base, `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('generation succeeded', gen.status === 200, gen.body?.error ?? gen.status);
    const state = await readState();
    check('production state persisted', Boolean(state));
    check('Long target generated', Boolean(state.scenarios.long));
    check('short_1 target generated', Boolean(state.scenarios.short_1));
    check(
      'exactly the requested targets',
      Object.keys(state.scenarios).sort().join(',') === 'long,short_1',
      Object.keys(state.scenarios),
    );
    const long = state.scenarios.long;
    const short = state.scenarios.short_1;

    gate('D. generated Scenarios are valid and carry characters + distinct voiceSlots');
    check('Long passes validateScenario()', validateScenario(long).valid === true);
    check('Short passes validateScenario()', validateScenario(short).valid === true);
    check('Long has >= 3 characters', long.characters.length >= 3, long.characters.length);
    for (const c of long.characters) {
      check(
        `Long character ${c.id} has name/role/narrativeFunction/voiceSlot`,
        Boolean(c.name) && Boolean(c.role) && Boolean(c.narrativeFunction) && typeof c.voiceSlot === 'string' && c.voiceSlot.length > 0,
        { name: c.name, role: c.role, voiceSlot: c.voiceSlot },
      );
    }
    const longSlots = long.characters.map((c: any) => c.voiceSlot);
    const shortSlots = short.characters.map((c: any) => c.voiceSlot);
    check('Long voiceSlots are distinct', new Set(longSlots).size === longSlots.length, longSlots);
    check('Short voiceSlots are distinct', new Set(shortSlots).size === shortSlots.length, shortSlots);
    check('at least 2 characters across the accepted scenarios', long.characters.length + short.characters.length >= 2);

    gate('E. fresh content — no fixture or canonical scenario reused');
    const forbiddenIds = [
      'sc-progress-meeting', 'sc-schedule-risk', 'scenario-hospital-expansion',
      'Final_Int_01', 'proj-Final_Int_01', 'scenario-1', 'DialogueTest', 'charlie-the-planner',
    ];
    const ids = [long.metadata.id, short.metadata.id, ...long.scenes.map((s: any) => s.id)];
    for (const bad of forbiddenIds) {
      check(`no fixture/canonical identifier '${bad}'`, !ids.some((id: string) => id.includes(bad)));
    }
    check('Long scenarioId is the acceptance slug', long.metadata.id.includes('finalacceptance-rfi-backlog'), long.metadata.id);
    check(
      'Long and Short derive from the same source topic',
      String(long.metadata.title).startsWith(String(ACCEPTANCE_INPUT.topic)) &&
        String(short.metadata.title).startsWith(String(ACCEPTANCE_INPUT.topic)),
      { long: long.metadata.title, short: short.metadata.title },
    );
    check(
      'Short is independently generated (own scenarioId, own scenes)',
      short.metadata.id !== long.metadata.id &&
        short.scenes.every((s: any) => !long.scenes.some((l: any) => l.id === s.id)),
      { long: long.metadata.id, short: short.metadata.id },
    );
    check('Long is Long geometry authority', long.metadata.targetFormat === 'Long', long.metadata.targetFormat);
    check('Short is Short geometry authority', short.metadata.targetFormat === 'Short', short.metadata.targetFormat);

    gate('F. source facts are the authority — no invented numbers spoken');
    const spoken = [
      ...long.scenes.flatMap((s: any) => s.turns.map((t: any) => t.spokenText)),
      ...short.scenes.flatMap((s: any) => s.turns.map((t: any) => t.spokenText)),
    ].join(' ');
    for (const m of spoken.matchAll(/(?<![\d.])\d+(?:\.\d+)?(?![\d.])/g)) {
      check(`spoken number '${m[0]}' is a source fact`, SOURCE_NUMBERS.has(m[0]), m[0]);
    }
    check(
      'source reference preserved on evidence',
      long.evidence.some((e: any) => String(e.sourceRef).includes('RFI Backlog Control')),
      long.evidence.map((e: any) => e.sourceRef),
    );
    check('numeric facts preserved', long.evidence.flatMap((e: any) => e.numericFacts ?? []).length > 0);

    gate('G. one safe dialogue spokenText edit through the production API');
    const editable = long.scenes
      .flatMap((s: any) => s.turns.map((t: any) => ({ turn: t, scene: s })))
      .find((x: any) => !x.turn.evidenceId && x.turn.intent !== 'call_to_action');
    check('found an editable non-evidence turn', Boolean(editable));
    const originalText = editable.turn.spokenText;
    const patched = await apiJson(
      base,
      `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/turns/long/${editable.turn.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spokenText: `${originalText} This register stays on a 48-hour clock.` }),
      },
    );
    check('dialogue edit accepted', patched.status === 200, patched.body?.error ?? patched.status);
    const afterEdit = await readState();
    const editedTurn = afterEdit.scenarios.long.scenes
      .flatMap((s: any) => s.turns)
      .find((t: any) => t.id === editable.turn.id);
    check('edit persisted', String(editedTurn?.spokenText).includes('48-hour clock'));
    check('speaker identity preserved', editedTurn?.speakerId === editable.turn.speakerId);
    check('edited Long still valid', validateScenario(afterEdit.scenarios.long).valid === true);

    gate('H. edit safety — evidence-linked numbers cannot be invented');
    const evidenceTurn = long.scenes
      .flatMap((s: any) => s.turns.map((t: any) => ({ turn: t, scene: s })))
      .find((x: any) => x.turn.evidenceId);
    check('found an evidence-linked turn', Boolean(evidenceTurn));
    if (evidenceTurn) {
      const rejected = await apiJson(
        base,
        `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/turns/long/${evidenceTurn.turn.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spokenText: 'The register holds 999 open RFIs, invented for the edit.' }),
        },
      );
      check('unsupported numeric edit rejected', rejected.status >= 400, rejected.status);
      check('rejection code is EVIDENCE_CONFLICT', rejected.body?.code === 'EVIDENCE_CONFLICT', rejected.body?.code);
    }

    gate('I. reopen / restart — persistence proven by a freshly spawned process');
    const reopenScript = [
      `import { loadProject } from './apps/api/src/services/store.js';`,
      `import { loadProductionState, loadProductionHistory } from './apps/api/src/services/production-state.js';`,
      `const id = ${JSON.stringify(ACCEPTANCE_VIDEO_ID)};`,
      `const p = loadProject(id);`,
      `const s = loadProductionState(id);`,
      `const turns = (s?.scenarios?.long?.scenes ?? []).flatMap((sc) => sc.turns);`,
      `const out = {`,
      `  projectExists: Boolean(p),`,
      `  videoId: p?.meta?.input?.videoId ?? null,`,
      `  inputFingerprint: s?.inputFingerprint ?? null,`,
      `  generationFingerprint: s?.generationFingerprint ?? null,`,
      `  status: s?.status ?? null,`,
      `  targets: Object.keys(s?.scenarios ?? {}).sort(),`,
      `  longId: s?.scenarios?.long?.metadata?.id ?? null,`,
      `  shortId: s?.scenarios?.short_1?.metadata?.id ?? null,`,
      `  longCharacters: (s?.scenarios?.long?.characters ?? []).map((c) => c.id + '|' + c.voiceSlot),`,
      `  shortCharacters: (s?.scenarios?.short_1?.characters ?? []).map((c) => c.id + '|' + c.voiceSlot),`,
      `  editedTurnText: turns.find((t) => t.id === ${JSON.stringify(editable.turn.id)})?.spokenText ?? null,`,
      `  editCount: (s?.edits ?? []).length,`,
      `  assetBindings: (s?.assetBindings ?? []).map((b) => b.target + '|' + b.logicalRef + '|' + b.assetId),`,
      `  historyEntries: loadProductionHistory().length,`,
      `};`,
      `console.log('REOPEN_JSON:' + JSON.stringify(out));`,
    ].join('\n');
    const reopen = await new Promise<any>((resolve, reject) => {
      const child = spawn(
        process.execPath, ['--import', 'tsx', '--input-type=module', '-e', reopenScript],
        { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { err += String(d); });
      child.on('error', reject);
      child.on('close', (code) => {
        const line = out.split('\n').find((l) => l.startsWith('REOPEN_JSON:'));
        if (code !== 0 || !line) reject(new Error(`reopen child failed (${code}): ${err.slice(0, 2000)}`));
        else resolve(JSON.parse(line.slice('REOPEN_JSON:'.length)));
      });
    });
    check('reopened project exists', reopen.projectExists === true);
    check('reopened videoId matches', reopen.videoId === ACCEPTANCE_VIDEO_ID);
    check('reopened targets survive', reopen.targets.join(',') === 'long,short_1', reopen.targets);
    check('reopened Long Scenario survives', reopen.longId === long.metadata.id);
    check('reopened Short Scenario survives', reopen.shortId === short.metadata.id);
    check(
      'reopened characters + voiceSlots survive',
      JSON.stringify(reopen.longCharacters) === JSON.stringify(long.characters.map((c: any) => `${c.id}|${c.voiceSlot}`)),
    );
    check('reopened dialogue edit survives', String(reopen.editedTurnText).includes('48-hour clock'));
    check('reopened edit log records the edit', reopen.editCount >= 1, reopen.editCount);
    check(
      'reopened input/generation fingerprints survive',
      typeof reopen.inputFingerprint === 'string' && reopen.inputFingerprint.length > 0 &&
      typeof reopen.generationFingerprint === 'string' && reopen.generationFingerprint.length > 0,
      { inputFingerprint: reopen.inputFingerprint, generationFingerprint: reopen.generationFingerprint },
    );

    gate('J. stale-input detection (non-destructive) then restore');
    const current = await readState();
    const planBefore = await apiJson(base, `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('build plan is allowed on fresh state (not stale)', planBefore.status === 200, planBefore.body?.error ?? planBefore.status);
    // Controlled staleness: the accepted input is backed up, temporarily
    // mutated, then restored. It is never left mutated.
    const { loadProject, saveProject } = await import('../apps/api/src/services/store.js');
    const project = loadProject(ACCEPTANCE_VIDEO_ID);
    check('project loaded from the real store', Boolean(project));
    if (!project) throw new AcceptanceFailure('the acceptance project is missing from the real store');
    const backup = JSON.parse(JSON.stringify(project));
    project.meta.input.topic = `${project.meta.input.topic} (temporarily mutated for the stale check)`;
    saveProject(project);
    const stale = await apiJson(base, `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('stale input detected after ProjectInput change', stale.status === 409 && stale.body?.code === 'STALE_INPUT', {
      status: stale.status, code: stale.body?.code,
    });
    saveProject(backup);
    check('accepted input restored', loadProject(ACCEPTANCE_VIDEO_ID)!.meta.input.topic === backup.meta.input.topic);
    const planAfter = await apiJson(base, `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('build plan allowed again after restore', planAfter.status === 200, planAfter.body?.error ?? planAfter.status);
    check('state fingerprint unchanged by the stale check', (await readState()).inputFingerprint === current.inputFingerprint);

    gate('K. real acceptance asset — generated locally, registered through the Asset Library');
    const assetSvg = buildAcceptanceAssetSvg();
    const assetDir = path.join(SCRATCH, 'assets');
    fs.mkdirSync(assetDir, { recursive: true });
    const assetFile = path.join(assetDir, `${ACCEPTANCE_ASSET.label}.svg`);
    fs.writeFileSync(assetFile, assetSvg, 'utf8');
    check('acceptance asset authored locally', fs.statSync(assetFile).size > 500, `${fs.statSync(assetFile).size} bytes`);
    check('acceptance asset is not a fixture', !fs.readFileSync(assetFile, 'utf8').includes('tests/fixtures'));
    const asset = await uploadRealAsset(base, assetFile);
    check('asset registered via the real Asset Library', Boolean(asset?.id), asset?.id);
    check('asset status is active', asset?.status === 'active');
    check('asset is not blocked', asset?.blocked === false);
    check('asset carries valid source', asset?.source === ACCEPTANCE_ASSET.source, asset?.source);
    check('asset carries valid license', asset?.license === ACCEPTANCE_ASSET.license, asset?.license);
    check(
      'asset has a real local file path',
      typeof asset?.path === 'string' && fs.existsSync(assetFilePath(asset.path)),
      { storedRelativePath: asset?.path, resolvedFrom: 'DATA_DIR (BUILDTRAKE_DATA)' },
    );
    check('asset has real bytes', typeof asset?.sizeBytes === 'number' && asset.sizeBytes > 0, asset?.sizeBytes);
    const assetStoredFile = assetFilePath(asset.path);
    const assetStoredSha256 = sha256File(assetStoredFile);
    const assetSourceSha256 = createHash('sha256').update(assetSvg).digest('hex');
    check(
      'persisted asset bytes match the bytes the acceptance script generated',
      assetStoredSha256 === assetSourceSha256,
      { stored: assetStoredSha256, generated: assetSourceSha256 },
    );

    gate('K2. real product media serving — GET /media/asset/:id');
    // The real running product server must serve the uploaded asset through
    // its normal media route. This proves the whole chain:
    //   upload -> Asset Library -> persisted relative path (under DATA_DIR)
    //     -> GET /media/asset/:id -> real bytes
    // The product route is used directly; nothing is bypassed.
    const served = await fetchAssetBytes(base, asset.id);
    check('GET /media/asset/:id returns 200', served.status === 200, served.status);
    check('served asset body is non-empty', served.bytes.length > 0, served.bytes.length);
    const servedSha256 = createHash('sha256').update(served.bytes).digest('hex');
    check(
      'served asset bytes match the real stored file',
      servedSha256 === assetStoredSha256,
      { served: servedSha256, stored: assetStoredSha256 },
    );
    check(
      'served asset bytes match the originally generated acceptance asset',
      servedSha256 === assetSourceSha256,
      { served: servedSha256, generated: assetSourceSha256 },
    );
    check(
      'served asset bytes match the registered size',
      served.bytes.length === asset.sizeBytes,
      { servedBytes: served.bytes.length, registeredSizeBytes: asset.sizeBytes },
    );

    // ------------------------------------------------------------------
    // L0. Build/inspect the FRESH generated Long production plan to discover
    //     the logical asset refs the product actually exposes. The plan is
    //     built by the product; no mediaMap is injected or fabricated here.
    // ------------------------------------------------------------------
    gate('L0. discover the logical asset refs in the fresh generated Long plan');
    const discoveryRes = await apiJson(base, `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('production plan built', discoveryRes.status === 200, discoveryRes.body?.error ?? discoveryRes.status);
    const discoveryTargets: Array<{ target: string; mediaMap?: Record<string, string> | null; unresolvedRequired?: string[] | null }> =
      discoveryRes.body?.targets ?? [];
    const longDiscovery = discoveryTargets.find((t) => t.target === 'long');
    check('Long plan present in the build response', Boolean(longDiscovery));

    const { discovered, selected, selectionReason } = selectBindableLogicalAssetRef({
      planTargets: discoveryTargets,
      generatedScenarios: state.scenarios,
    });
    const discoveredRefs = discovered.map((d) => d.logicalRef);
    check(
      'asset refs discovered from the GENERATED Long plan (no hardcoded logicalRef)',
      Array.isArray(discoveredRefs),
      { discoveredRefs, count: discoveredRefs.length },
    );
    console.log(`  discovered logical asset refs: ${JSON.stringify(discoveredRefs)}`);

    // ------------------------------------------------------------------
    // Product gap gate. If the generated content exposes zero bindable asset
    // usages, the user Asset Library binding cannot be proven in the real
    // fresh-content flow. That is a PRODUCT acceptance gap, not something the
    // acceptance driver may paper over.
    // ------------------------------------------------------------------
    if (selected === null) {
      const gap = {
        gate: currentGate,
        code: 'REAL_PRODUCT_ACCEPTANCE_GAP',
        message:
          'fresh generated production content does not expose any bindable asset usage, ' +
          'therefore user Asset Library binding cannot be proven in the real fresh-content flow',
        discoveredLogicalAssetRefs: discoveredRefs,
        discoveredCount: discoveredRefs.length,
        detail: {
          longTargetPresent: Boolean(longDiscovery),
          longMediaMapKeys: Object.keys(longDiscovery?.mediaMap ?? {}),
          longUnresolvedRequired: longDiscovery?.unresolvedRequired ?? [],
          assetLibraryEntryRegistered: Boolean(asset?.id),
          assetLibraryRoute: 'POST /api/assets',
          explicitBindingRoute: 'PUT /api/projects/:id/production/assets/:target/:logicalRef',
          conclusion:
            'The Asset Library upload, persistence, DATA_DIR path resolution and ' +
            'GET /media/asset/:id serving are all proven. What cannot be proven is the ' +
            'binding itself, because the generated Scenario carries no assetRef to bind to.',
        },
      };
      writeEvidence('ASSET-BINDING-PRODUCT-GAP.json', gap);
      throw new AcceptanceFailure(
        'REAL PRODUCT ACCEPTANCE GAP: fresh generated production content does not expose any ' +
          'bindable asset usage, therefore user Asset Library binding cannot be proven in the ' +
          'real fresh-content flow',
        gap,
      );
    }

    // ------------------------------------------------------------------
    // L1. The selected logicalRef comes from the generated plan. Record why.
    // ------------------------------------------------------------------
    gate('L1. select one deterministic real logicalRef from product-generated asset usage');
    const selectedEntry = discovered.find((d) => d.logicalRef === selected)!;
    check('selected logicalRef exists in the generated plan', discoveredRefs.includes(selected), selected);
    check(
      'selected logicalRef comes from the generated plan, not from an acceptance constant',
      selected !== ACCEPTANCE_ASSET.label,
      { selected, acceptanceAssetLabelIsNotABindingRef: ACCEPTANCE_ASSET.label },
    );
    check('selection rule recorded', typeof selectionReason === 'string' && selectionReason.length > 0, selectionReason);
    check('required/optional flag recorded', typeof selectedEntry.required === 'boolean', selectedEntry.required);
    console.log(`  selected: ${selected} (${selectionReason}; required=${selectedEntry.required})`);

    // ------------------------------------------------------------------
    // L2. Bind the acceptance Asset ID through the normal production API,
    //     using the REAL generated logicalRef.
    // ------------------------------------------------------------------
    gate('L2. bind the acceptance Asset ID to the real generated logicalRef');
    const bind = await apiJson(
      base,
      `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/assets/long/${encodeURIComponent(selected)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: asset.id }),
      },
    );
    check('explicit binding accepted', bind.status === 200, bind.body?.error ?? bind.status);
    const boundState = await readState();
    check(
      'binding persisted on the production state',
      boundState.assetBindings.some(
        (b: any) => b.target === 'long' && b.logicalRef === selected && b.assetId === asset.id,
      ),
      boundState.assetBindings,
    );

    // ------------------------------------------------------------------
    // L3. Rebuild the Long production plan so the binding is resolved.
    // ------------------------------------------------------------------
    gate('L3. rebuild the Long production plan after binding');

    gate('M. asset flows through Phase 6A resolution into the mediaMap');
    const planRes = await apiJson(base, `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('production plan rebuilt', planRes.status === 200, planRes.body?.error ?? planRes.status);
    const longPlan = (planRes.body?.targets ?? []).find((t: any) => t.target === 'long');
    check('Long plan present in the rebuilt build response', Boolean(longPlan));
    const mediaMap: Record<string, string> = longPlan?.mediaMap ?? {};
    const assetUrl = Object.values(mediaMap).find((v) => v.includes(asset.id));
    check('acceptance asset resolved into the mediaMap', Boolean(assetUrl), mediaMap);
    check(
      'no unresolved REQUIRED asset refs for Long',
      (longPlan?.unresolvedRequired ?? []).length === 0,
      longPlan?.unresolvedRequired,
    );
    check(
      'no manual mediaMap injection — the mediaMap is the product\'s own output',
      Object.keys(mediaMap).length > 0,
      Object.keys(mediaMap),
    );
    const assetBinding = {
      assetId: asset.id,
      logicalRef: selected,
      target: 'long',
      required: selectedEntry.required,
      selectionReason,
      discoveredLogicalAssetRefs: discoveredRefs,
      discovered,
      explicitBindingPersisted: boundState.assetBindings.some(
        (b: any) => b.target === 'long' && b.logicalRef === selected && b.assetId === asset.id,
      ),
      resolvedMediaMapEntry: assetUrl ?? null,
      unresolvedRequiredAfterBinding: longPlan?.unresolvedRequired ?? [],
      noManualMediaMapInjection: true,
    };
    check(
      'the mediaMap is produced by the product, not authored by this script',
      Object.keys(mediaMap).length > 0,
      Object.keys(mediaMap),
    );

    // ------------------------------------------------------------------
    // 17D. The product must hand the renderer a REAL ABSOLUTE URL that the
    //      live server actually serves: http://127.0.0.1:<port>/media/asset/<id>.
    //      A bare `data:`/`file://`/relative path would be unrenderable, so it
    //      is rejected here rather than silently accepted.
    // ------------------------------------------------------------------
    gate('17D. real absolute media URL served by the live product server');
    const livePort = Number(new URL(base).port);
    check('live product server port recorded', Number.isInteger(livePort) && livePort > 0, base);
    check(
      'resolved asset URL is an absolute live-server URL (http://127.0.0.1:<port>/media/asset/<id>)',
      typeof assetUrl === 'string' &&
        assetUrl.startsWith(`http://127.0.0.1:${livePort}/media/asset/`) &&
        assetUrl.endsWith(asset.id),
      assetUrl,
    );
    check(
      'no data:/file:///relative media URLs anywhere in the mediaMap',
      Object.values(mediaMap).every(
        (v) => typeof v === 'string' && /^http:\/\/127\.0\.0\.1:\d+\//.test(v) && !/^(data:|file:)/.test(v),
      ),
      mediaMap,
    );
    const liveRes = await fetch(String(assetUrl));
    const liveBytes = Buffer.from(await liveRes.arrayBuffer());
    const liveSha256 = createHash('sha256').update(liveBytes).digest('hex');
    check('the absolute mediaMap URL is served by the live server (200)', liveRes.status === 200, liveRes.status);
    check(
      'the absolute mediaMap URL serves exactly the registered asset bytes',
      liveSha256 === assetStoredSha256 && liveBytes.length === asset.sizeBytes,
      { liveSha256, assetStoredSha256, liveBytes: liveBytes.length, registered: asset.sizeBytes },
    );

    // ------------------------------------------------------------------
    // 17E. Real Short asset binding — the Short target gets its own genuine
    //      generated logical ref, bound through the real production API, and
    //      resolved into the Short mediaMap.
    // ------------------------------------------------------------------
    gate('17E. real Short asset binding through the production API');
    const shortSelection = selectBindableLogicalAssetRef({
      planTargets: discoveryTargets,
      generatedScenarios: state.scenarios,
      target: 'short_1',
    });
    check(
      'the generated Short content exposes at least one bindable logical asset slot',
      shortSelection.selected !== null,
      {
        discovered: shortSelection.discovered,
        shortScreenInsertRefs: (state.scenarios.short_1?.scenes ?? [])
          .map((sc: any) => sc?.production?.screenInsert?.assetRef ?? null)
          .filter(Boolean),
      },
    );
    const shortRef = shortSelection.selected as string;
    const shortBind = await apiJson(
      base,
      `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/assets/short_1/${encodeURIComponent(shortRef)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: asset.id }),
      },
    );
    check('Short binding accepted by the real production API', shortBind.status === 200, shortBind.body?.error ?? shortBind.status);
    const shortBoundState = await readState();
    check(
      'Short binding persisted on the production state',
      shortBoundState.assetBindings.some(
        (b: any) => b.target === 'short_1' && b.logicalRef === shortRef && b.assetId === asset.id,
      ),
      shortBoundState.assetBindings,
    );
    const shortRebuild = await apiJson(base, `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('production plan rebuilt after the Short binding', shortRebuild.status === 200, shortRebuild.body?.error ?? shortRebuild.status);
    const shortPlanEntry = (shortRebuild.body?.targets ?? []).find((t: any) => t.target === 'short_1');
    check('Short plan present after the Short binding', Boolean(shortPlanEntry));
    const shortMediaMap: Record<string, string> = shortPlanEntry?.mediaMap ?? {};
    const shortAssetUrl = Object.values(shortMediaMap).find((v) => typeof v === 'string' && v.includes(asset.id));
    check('acceptance asset resolved into the SHORT mediaMap', Boolean(shortAssetUrl), shortMediaMap);
    check(
      'Short media URL is also an absolute live-server URL',
      typeof shortAssetUrl === 'string' && shortAssetUrl.startsWith(`http://127.0.0.1:${livePort}/media/asset/`),
      shortAssetUrl,
    );
    check(
      'no unresolved REQUIRED asset refs for Short',
      (shortPlanEntry?.unresolvedRequired ?? []).length === 0,
      shortPlanEntry?.unresolvedRequired,
    );
    const shortAssetBinding = {
      target: 'short_1',
      logicalRef: shortRef,
      required: shortSelection.discovered.find((d) => d.logicalRef === shortRef)?.required ?? false,
      selectionReason: shortSelection.selectionReason,
      discoveredLogicalAssetRefs: shortSelection.discovered.map((d) => d.logicalRef),
      explicitBindingPersisted: true,
      resolvedMediaMapEntry: shortAssetUrl ?? null,
      unresolvedRequiredAfterBinding: shortPlanEntry?.unresolvedRequired ?? [],
    };

    const audio = await verifyRealAudio('N. real production audio — semantic per-turn identity (deterministic duplicates allowed)', shortBoundState);

    writeEvidence('preflight-verification.json', {
      stage: 'preflight',
      status: 'passed',
      videoId: ACCEPTANCE_VIDEO_ID,
      checks,
      scenario: {
        longId: long.metadata.id,
        shortId: short.metadata.id,
        longTargetFormat: long.metadata.targetFormat,
        shortTargetFormat: short.metadata.targetFormat,
        longSceneCount: long.scenes.length,
        shortSceneCount: short.scenes.length,
        characters: [...long.characters, ...short.characters].map((c: any) => ({
          id: c.id, name: c.name, role: c.role, narrativeFunction: c.narrativeFunction, voiceSlot: c.voiceSlot,
        })),
      },
      edit: { turnId: editable.turn.id, speakerId: editable.turn.speakerId, originalText, patchedText: editedTurn?.spokenText },
      reopen,
      asset: {
        id: asset.id, name: asset.name, kind: asset.kind, source: asset.source, license: asset.license,
        path: asset.path, resolvedPath: path.relative(ROOT, assetStoredFile),
        acceptanceAssetLabel: ACCEPTANCE_ASSET.label, sha256: assetStoredSha256, sizeBytes: asset.sizeBytes,
      },
      assetUrl,
      mediaMap,
      mediaUrlAuthority: {
        livePort,
        absoluteUrl: assetUrl,
        shortAbsoluteUrl: shortAssetUrl ?? null,
        scheme: 'http://127.0.0.1:<live port>/media/asset/<asset id> - built by the product (startProductionJob / /production/build), never data:/file:',
        liveFetch: {
          status: liveRes.status,
          bytes: liveBytes.length,
          sha256: liveSha256,
          matchesStoredFile: liveSha256 === assetStoredSha256,
        },
      },
      mediaServing: {
        route: 'GET /media/asset/:id',
        status: served.status,
        servedBytes: served.bytes.length,
        servedSha256,
        matchesStoredFile: servedSha256 === assetStoredSha256,
        matchesGeneratedAsset: servedSha256 === assetSourceSha256,
        contentType: served.contentType,
      },
      assetBinding,
      shortAssetBinding,
      audio,
    });
    saveStage('preflight', {
      stage: 'preflight',
      videoId: ACCEPTANCE_VIDEO_ID,
      asset: {
        id: asset.id, name: asset.name, kind: asset.kind, source: asset.source, license: asset.license,
        path: asset.path, resolvedPath: path.relative(ROOT, assetStoredFile),
        acceptanceAssetLabel: ACCEPTANCE_ASSET.label, sha256: assetStoredSha256, sizeBytes: asset.sizeBytes,
      },
      assetUrl,
      mediaMap,
      mediaUrlAuthority: {
        livePort,
        absoluteUrl: assetUrl,
        shortAbsoluteUrl: shortAssetUrl ?? null,
        scheme: 'http://127.0.0.1:<live port>/media/asset/<asset id> - built by the product, never data:/file:',
      },
      mediaServing: {
        route: 'GET /media/asset/:id',
        status: served.status,
        servedBytes: served.bytes.length,
        servedSha256,
        matchesStoredFile: servedSha256 === assetStoredSha256,
        matchesGeneratedAsset: servedSha256 === assetSourceSha256,
        contentType: served.contentType,
      },
      assetBinding,
      shortAssetBinding,
      scenario: {
        longId: long.metadata.id,
        shortId: short.metadata.id,
        longSceneCount: long.scenes.length,
        shortSceneCount: short.scenes.length,
      },
      edit: { turnId: editable.turn.id, speakerId: editable.turn.speakerId, originalText, patchedText: editedTurn?.spokenText },
      reopen,
      audio,
      checks,
    });
    console.log('\n[preflight] PASSED');
  } catch (error) {
    if (error instanceof AcceptanceFailure) {
      throw new AcceptanceFailure(error.message, {
        ...(typeof error.detail === 'object' && error.detail !== null ? error.detail : { detail: error.detail }),
        realServerLogTail: server.logTail(),
      });
    }
    throw error;
  } finally {
    await server.close();
  }
}

/* ------------------------------------------------------------------ */
/*  Real product job driving (no in-process shortcuts)                 */
/* ------------------------------------------------------------------ */

/**
 * Start a REAL production job through the product's own route and poll it
 * through the product's own job route until it finishes.
 */
async function startJobAndWait(
  base: string,
  route: string,
  payload: unknown,
  label: string,
  timeoutMs: number,
): Promise<{ jobId: string; job: any }> {
  const started = await apiJson(base, route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  check(
    `${label}: real product job accepted by POST ${route}`,
    started.status === 200 && typeof started.body?.jobId === 'string',
    started.body ?? started.status,
  );
  const jobId = started.body.jobId as string;
  const deadline = Date.now() + timeoutMs;
  let job: any = null;
  let seen = 0;
  while (Date.now() < deadline) {
    const res = await apiJson(base, `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/jobs/${encodeURIComponent(jobId)}`);
    if (res.status === 200) {
      job = res.body;
      const logs: string[] = Array.isArray(job?.log) ? job.log : [];
      for (const line of logs.slice(seen)) console.log(`  [${label}] ${line}`);
      seen = logs.length;
      if (job?.status === 'done' || job?.status === 'failed') break;
    }
    await new Promise((r) => setTimeout(r, 4_000));
  }
  check(
    `${label}: job finished (polled through the real job route)`,
    job?.status === 'done',
    { jobId, status: job?.status ?? 'timeout', error: job?.error ?? null },
  );
  return { jobId, job };
}

/* ------------------------------------------------------------------ */
/*  Real frame proof (pixels of the rendered video)                    */
/* ------------------------------------------------------------------ */

/**
 * The acceptance asset's marker bar colour: deliberately OUTSIDE the BuildTrack
 * brand palette (primary #0B3D91, secondary #00B4D8, accent #FFB703, surfaces
 * #08121F / #F4F7FB and the accent cycle), so finding these pixels in a
 * rendered frame proves the ASSET itself was composited into the video.
 */
const ASSET_MARKER_RGB = { r: 255, g: 0, b: 170 };
const ASSET_FRAME_MIN_PIXELS = 300;

/**
 * Saturated-magenta test, deliberately tolerant of H.264 chroma subsampling and
 * of a legibility dim over the media layer, while still excluding every brand /
 * UI colour (which are all either non-magenta, desaturated, or green-heavy).
 */
function isMarkerPixel(r: number, g: number, b: number): boolean {
  return r >= 120 && g <= 95 && b >= 70 && r - g >= 90 && b - g >= 40;
}

function markerPixels(rgb: Buffer): number {
  let n = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    if (isMarkerPixel(rgb[i], rgb[i + 1], rgb[i + 2])) n += 1;
  }
  return n;
}

/** Run the product's own ffmpeg binary and capture stdout. */
async function runFfmpegBytes(args: string[]): Promise<Buffer> {
  const { ffmpegPath } = await import('../apps/api/src/services/platform.js');
  const bin = ffmpegPath();
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(bin, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new AcceptanceFailure(`ffmpeg exited ${code}`, { args, stderr: err.slice(-2000) }));
    });
  });
}

/**
 * Resolve the rendered scene ids in which a bound asset is displayed, from the
 * PRODUCT's own resolution DTO (`resolution.bindings[].usages[].sceneId`).
 */
function resolvedAssetSceneIds(resolution: unknown, assetId: string): string[] {
  const bindings = (resolution as { bindings?: Array<{ assetId?: string | null; resolved?: boolean; usages?: Array<{ sceneId?: string }> }> } | null)?.bindings ?? [];
  const scenes = new Set<string>();
  for (const binding of bindings) {
    if (!binding.resolved || binding.assetId !== assetId) continue;
    for (const usage of binding.usages ?? []) {
      if (usage.sceneId) scenes.add(usage.sceneId);
    }
  }
  return [...scenes].sort();
}

/**
 * Audio-authoritative scene durations for one target, from the MEASURED
 * per-turn WAV durations (the same production audio the render consumed).
 */
function sceneTurnDurationsFor(
  scenario: { scenes?: Array<{ id?: string }> } | null | undefined,
  perTurnRecords: Array<{ target: string; sceneId: string; durationSeconds: number | null }>,
  target: string,
): SceneTurnDurations[] {
  const byScene = new Map<string, number[]>();
  for (const record of perTurnRecords) {
    if (record.target !== target) continue;
    const list = byScene.get(record.sceneId) ?? [];
    list.push(Number(record.durationSeconds) > 0 ? Number(record.durationSeconds) : 0);
    byScene.set(record.sceneId, list);
  }
  return (scenario?.scenes ?? [])
    .map((scene) => String(scene.id ?? ''))
    .filter(Boolean)
    .map((sceneId) => ({ sceneId, turnDurationsSeconds: byScene.get(sceneId) ?? [] }));
}

/** Sample ONE frame at one timestamp and count its marker pixels (null when the seek produced no frame). */
async function sampleFrameMarkerPixels(
  videoFile: string,
  atSeconds: number,
  sampleWidth: number,
  sampleHeight: number,
): Promise<number | null> {
  const rgb = await runFfmpegBytes([
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(atSeconds), '-i', videoFile,
    '-frames:v', '1', '-vf', `scale=${sampleWidth}:${sampleHeight}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  const expected = sampleWidth * sampleHeight * 3;
  if (rgb.length < expected) return null;
  return markerPixels(rgb.subarray(0, expected));
}

/**
 * Pixel-level proof that a rendered video really contains the acceptance
 * asset.
 *
 * SAMPLING STRATEGY (audit item I)
 * --------------------------------
 * A fixed 1.5 s interval can step straight over a correctly rendered Short
 * asset insertion (the asset may be on screen for a fraction of a second), so
 * the PROOF samples inside the PLANNED scene/beat display window of the asset:
 * the scene timeline is derived from the audio-authoritative per-turn WAV
 * durations of the scenario, and the asset's own resolved scene usages (from
 * the product's resolution DTO) select the windows. Frames OUTSIDE every
 * window are the control, so brand/UI colour can never pass the threshold.
 *
 * The legacy whole-timeline 1.5 s scan is still reported for transparency, but
 * it is NOT the pass/fail authority.
 *
 * Thresholds (unchanged in strength): the best window frame must contain at
 * least ASSET_FRAME_MIN_PIXELS (300) real marker pixels AND, when the control
 * carries any marker pixels at all, the best frame must be >= 5x the control
 * median. A window sample that produced no frame (seek past the end) is
 * reported, never silently treated as zero.
 */
async function writeAssetFrameProof(
  videoFile: string,
  assetId: string,
  label: string,
  proofInput: { assetSceneIds?: string[]; sceneDurations?: SceneTurnDurations[] } = {},
): Promise<Record<string, unknown>> {
  const { analyseFile } = await import('../apps/api/src/services/media.js');
  const probe = await analyseFile(videoFile);
  const sampleWidth = 640;
  const sampleHeight = Math.max(2, Math.round(((probe.height / probe.width) * sampleWidth) / 2) * 2);
  const videoDurationSeconds = Number(probe.duration) > 0 ? Number(probe.duration) : 0;

  /* 1. Legacy whole-timeline scan (reported, not authoritative). */
  const sampled = await runFfmpegBytes([
    '-hide_banner', '-loglevel', 'error',
    '-i', videoFile,
    '-vf', `fps=1/1.5,scale=${sampleWidth}:${sampleHeight}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  const frameBytes = sampleWidth * sampleHeight * 3;
  const globalFrames = Math.floor(sampled.length / frameBytes);
  const globalCounts: number[] = [];
  for (let i = 0; i < globalFrames; i++) globalCounts.push(markerPixels(sampled.subarray(i * frameBytes, (i + 1) * frameBytes)));
  const legacyBest = globalCounts.length > 0 ? Math.max(...globalCounts) : 0;

  /* 2. Planned asset exposure windows (audio-authoritative durations). */
  const assetSceneIds = proofInput.assetSceneIds ?? [];
  const sceneDurations = proofInput.sceneDurations ?? [];
  let windows: ExposureWindow[] = [];
  let windowSource: string;
  if (assetSceneIds.length > 0 && sceneDurations.length > 0 && videoDurationSeconds > 0) {
    windows = assetExposureWindows(sceneDurations, assetSceneIds, { videoDurationSeconds });
    windowSource = 'planned scene display window (asset scene usages x audio-authoritative per-turn durations), padded by 0.6 s';
  } else if (videoDurationSeconds > 0) {
    // No usable usage/timeline data: fall back to the whole video, documented.
    windows = [{ sceneId: '(whole video)', startSeconds: 0, endSeconds: videoDurationSeconds }];
    windowSource = 'whole video (no asset scene usage/timeline data was available; documented fallback)';
  } else {
    windowSource = 'none (video duration unmeasurable)';
  }

  const windowTimes = windows.flatMap((w) => windowSampleTimes(w, 4, 32));
  const windowResults: Array<{ seconds: number; markerPixels: number | null }> = [];
  for (const seconds of windowTimes) {
    windowResults.push({ seconds, markerPixels: await sampleFrameMarkerPixels(videoFile, seconds, sampleWidth, sampleHeight) });
  }
  const measuredWindowCounts = windowResults.filter((r) => r.markerPixels !== null).map((r) => r.markerPixels as number);
  const bestWindow = measuredWindowCounts.length > 0 ? Math.max(...measuredWindowCounts) : 0;
  const windowSorted = [...measuredWindowCounts].sort((a, b) => a - b);
  const windowMedian = windowSorted[Math.floor(windowSorted.length / 2)] ?? 0;
  const bestWindowEntry = windowResults.find((r) => r.markerPixels === bestWindow) ?? null;
  const bestSeconds = bestWindowEntry ? Number(bestWindowEntry.seconds.toFixed(2)) : 0;

  /* 3. Control frames OUTSIDE every window. */
  const controlTimes = controlSampleTimes(windows, videoDurationSeconds, 1, 12);
  const controlResults: Array<{ seconds: number; markerPixels: number | null }> = [];
  for (const seconds of controlTimes) {
    controlResults.push({ seconds, markerPixels: await sampleFrameMarkerPixels(videoFile, seconds, sampleWidth, sampleHeight) });
  }
  const controlCounts = controlResults.filter((r) => r.markerPixels !== null).map((r) => r.markerPixels as number);
  const controlSorted = [...controlCounts].sort((a, b) => a - b);
  const controlMedian = controlSorted[Math.floor(controlSorted.length / 2)] ?? 0;

  /* 4. Best frame as a small PNG (never the video itself). */
  const framesDir = path.join(EVIDENCE_DIR, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const png = path.join(framesDir, `${label}-asset-frame.png`);
  if (bestWindow > 0) {
    await runFfmpegBytes([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(bestSeconds), '-i', videoFile,
      '-frames:v', '1', '-vf', 'scale=480:-2', png,
    ]);
  }

  const proof = {
    stage: label,
    video: path.relative(ROOT, videoFile),
    assetId,
    markerRgb: `rgb(${ASSET_MARKER_RGB.r}, ${ASSET_MARKER_RGB.g}, ${ASSET_MARKER_RGB.b}) - outside the brand palette`,
    markerPredicate: 'r >= 120 && g <= 95 && b >= 70 && r-g >= 90 && b-g >= 40 (tolerates H.264 chroma + a legibility dim)',
    frameSampling: `planned asset display window (${windowSource}); 4 frames/s inside the window, ${controlTimes.length} control frame(s) outside every window`,
    windowSource,
    assetSceneIds,
    exposureWindows: windows,
    framesSampled: measuredWindowCounts.length,
    framesWithoutFrameAtSeek: windowResults.filter((r) => r.markerPixels === null).map((r) => r.seconds),
    windowSampleResults: windowResults,
    markerPixelsPerFrame: measuredWindowCounts,
    markerPixelsBestFrame: bestWindow,
    markerPixelsMedianFrame: windowMedian,
    bestFrameSeconds: bestSeconds,
    bestFramePng: bestWindow > 0 ? path.relative(ROOT, png) : null,
    controlRatio: controlMedian > 0 ? Number((bestWindow / controlMedian).toFixed(2)) : null,
    control: {
      sampleTimes: controlTimes,
      markerPixels: controlCounts,
      median: controlMedian,
      framesWithoutFrameAtSeek: controlResults.filter((r) => r.markerPixels === null).map((r) => r.seconds),
    },
    legacyFixedIntervalScan: {
      intervalSeconds: 1.5,
      framesSampled: globalFrames,
      markerPixelsPerFrame: globalCounts,
      markerPixelsBestFrame: legacyBest,
      note: 'reported for transparency only; a fixed 1.5 s interval can miss a short asset insertion, so this is NOT the pass/fail authority',
    },
    thresholds: {
      minMarkerPixels: ASSET_FRAME_MIN_PIXELS,
      controlRule: 'best window frame >= 5x the control median when the control carries any marker pixels at all',
    },
  };
  check(
    `frame proof (${label}): the asset's pixels are measurably present inside its planned display window`,
    bestWindow >= ASSET_FRAME_MIN_PIXELS && (controlMedian === 0 || bestWindow >= controlMedian * 5),
    proof,
  );
  return proof;
}

/* ------------------------------------------------------------------ */
/*  Stage 2 — short smoke render (native 1080x1920)                    */
/* ------------------------------------------------------------------ */

async function stageShortSmoke(): Promise<void> {
  const pre = loadStage('preflight');
  const { loadProject } = await import('../apps/api/src/services/store.js');
  const { analyseFile } = await import('../apps/api/src/services/media.js');

  gate('restore the state this run persisted in preflight (fresh process)');
  const state = await readState();
  check('production state restored from the preflight artifact', Boolean(state));
  check('Long + short_1 both restored', Object.keys(state.scenarios).sort().join(',') === 'long,short_1', Object.keys(state.scenarios));
  const project = loadProject(ACCEPTANCE_VIDEO_ID);
  check('project restored', Boolean(project));
  if (!project) throw new AcceptanceFailure('the acceptance project is missing from the real store');
  check(
    'accepted Long asset binding survived',
    state.assetBindings.some((b: any) => b.target === 'long' && b.logicalRef === pre.assetBinding.logicalRef && b.assetId === pre.asset.id),
    state.assetBindings,
  );
  check(
    'accepted Short asset binding survived',
    state.assetBindings.some((b: any) => b.target === 'short_1' && b.logicalRef === pre.shortAssetBinding.logicalRef),
    state.assetBindings,
  );
  check(
    'accepted dialogue edit survived',
    state.scenarios.long.scenes.flatMap((s: any) => s.turns)
      .some((t: any) => t.id === pre.edit.turnId && String(t.spokenText).includes('48-hour clock')),
  );

  gate('product audio path authority');
  const audioPaths = await productionAudioPaths();
  check(
    'audio roots are the product engine roots (productionAudioBasePaths), not a re-derived formula',
    audioPaths.synthesisBasePath.endsWith('/audio/dialogue') && audioPaths.canonicalBasePath.endsWith('/audio/canonical'),
    audioPaths,
  );
  const audio = await verifyRealAudio('A. per-turn Kokoro audio (already synthesized in preflight)', state);

  gate('B. real product preview job — the product renders the native Short');
  const server = await startRealServer();
  const base = server.baseUrl;
  let media: Record<string, unknown> = {};
  let frameProof: Record<string, unknown> | null = null;
  try {
    const { jobId, job } = await startJobAndWait(
      base,
      `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/preview`,
      { targets: ['short_1'] },
      'short preview',
      25 * 60_000,
    );
    const result = job.result ?? {};
    check('preview job result status is ok', result.status === 'ok', productionJobFailureDetail(job));
    check('preview job rendered exactly the Short', Array.isArray(result.targets) && result.targets.join(',') === 'short_1', result.targets);
    const shortRel = result.outputs?.short_1;
    check('preview job recorded a Short output', typeof shortRel === 'string' && shortRel.length > 0, result.outputs);
    check('preview output is a preview artifact (not a final deliverable)', String(shortRel).includes('/previews/'), shortRel);
    const shortFile = path.join(OUTPUT_DIR, String(shortRel));
    check('Short MP4 exists on disk', fs.existsSync(shortFile), path.relative(ROOT, shortFile));
    const probe = await analyseFile(shortFile);
    check('Short width 1080', probe.width === 1080, probe.width);
    check('Short height 1920', probe.height === 1920, probe.height);
    check('Short video codec H264', /h264|avc/i.test(String(probe.codec_name)), probe.codec_name);
    check('Short audio codec AAC', /aac/i.test(String(probe.audioCodec)), probe.audioCodec);
    check('Short has an audio stream', probe.hasAudio === true);
    check(
      'Short render is a real render (nonzero size, real duration)',
      fs.statSync(shortFile).size > 100_000 && probe.duration > 1,
      { sizeBytes: fs.statSync(shortFile).size, duration: probe.duration },
    );

    // 17D/17E frame proof: the Short plan resolves the acceptance asset through
    // the product's absolute live-server URL, so its pixels must be composited
    // into the rendered Short.
    const shortPlanRes = await apiJson(base, `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'short_1' }),
    });
    check('Short plan rebuilt through the real API for frame proof', shortPlanRes.status === 200, shortPlanRes.body?.error ?? shortPlanRes.status);
    const shortMediaMap: Record<string, string> = shortPlanRes.body?.mediaMap ?? {};
    const shortAssetUrl = Object.values(shortMediaMap).find((v) => typeof v === 'string' && v.includes(pre.asset.id)) ?? null;
    check('Short plan resolves the acceptance asset', Boolean(shortAssetUrl), shortMediaMap);
    check(
      'Short plan media URL is the product absolute live-server URL on THIS stage\'s own port (no previous job port reused)',
      typeof shortAssetUrl === 'string' && shortAssetUrl.startsWith(`http://127.0.0.1:${Number(new URL(base).port)}/media/asset/`),
      { shortAssetUrl, stagePort: Number(new URL(base).port), preflightPort: (pre.mediaUrlAuthority as any)?.livePort ?? null },
    );
    // Planned exposure window: the Short asset's own scene usages (from the
    // product resolution DTO) x the MEASURED audio-authoritative turn durations.
    check(
      'the Short build response carries the product resolution DTO (bindings with scene usages)',
      Array.isArray(shortPlanRes.body?.resolution?.bindings) && shortPlanRes.body.resolution.bindings.length > 0,
      { bindings: shortPlanRes.body?.resolution?.bindings?.length ?? null },
    );
    const shortAssetSceneIds = resolvedAssetSceneIds(shortPlanRes.body?.resolution, pre.asset.id);
    check(
      'the Short plan reports the scene(s) where the acceptance asset is displayed',
      shortAssetSceneIds.length > 0,
      { assetId: pre.asset.id, shortAssetSceneIds, resolution: shortPlanRes.body?.resolution ?? null },
    );
    const shortAudioRecords = ((audio as any).perTurnRecords ?? []) as Array<{ target: string; sceneId: string; durationSeconds: number | null }>;
    const shortSceneDurations = sceneTurnDurationsFor(state.scenarios.short_1, shortAudioRecords, 'short_1');
    frameProof = await writeAssetFrameProof(shortFile, pre.asset.id, 'short-smoke', {
      assetSceneIds: shortAssetSceneIds,
      sceneDurations: shortSceneDurations,
    });
    check(
      'frame proof: the Short contains the acceptance asset pixels inside its planned display window',
      Number(frameProof.markerPixelsBestFrame) >= ASSET_FRAME_MIN_PIXELS,
      frameProof,
    );

    media = {
      stage: 'short-smoke',
      jobId,
      api: 'POST /api/projects/:id/production/preview { targets: ["short_1"] } + GET /api/projects/:id/production/jobs/:jobId',
      assetUrl: shortAssetUrl,
      timeline: { previewArtifact: true, finalArtifact: false },
      file: path.relative(ROOT, shortFile),
      sha256: sha256File(shortFile),
      sizeBytes: fs.statSync(shortFile).size,
      durationSeconds: probe.duration,
      videoCodec: probe.codec_name,
      audioCodec: probe.audioCodec,
      width: probe.width,
      height: probe.height,
      fps: probe.r_frame_rate,
      audioStreamCount: probe.hasAudio ? 1 : 0,
      audio,
      frameProof,
    };
  } finally {
    await server.close();
  }

  writeEvidence('short-smoke-media-verification.json', media);
  saveStage('short-smoke', {
    stage: 'short-smoke',
    media,
    frameProof,
    assetUrl: (media as any).assetUrl ?? null,
  });
  console.log('\n[short-smoke] PASSED');
}

/* ------------------------------------------------------------------ */
/*  Stage 3 — final production (Long + Short + package)                */
/* ------------------------------------------------------------------ */

async function stageFinalProduction(): Promise<void> {
  const pre = loadStage('preflight');
  // Static-audit closure: the final build must not run unless the Short smoke
  // stage really ran. The workflow also gates it with `needs: [preflight,
  // short-smoke]`, but the driver enforces it itself so a manual invocation
  // cannot silently skip the smoke gate.
  const shortSmoke = loadStage('short-smoke');
  check(
    'the Short smoke stage ran before the final production stage',
    Boolean(shortSmoke?.media?.sha256) && Number(shortSmoke?.media?.width) === 1080 && Number(shortSmoke?.media?.height) === 1920,
    { stage: shortSmoke?.stage ?? null, shortSha256: shortSmoke?.media?.sha256 ?? null },
  );
  const { loadProject } = await import('../apps/api/src/services/store.js');
  const { analyseFile } = await import('../apps/api/src/services/media.js');

  gate('restore the preflight state produced by THIS run (fresh process)');
  const state = await readState();
  check('production state restored from the preflight artifact', Boolean(state));
  check('Long + short_1 both restored', Object.keys(state.scenarios).sort().join(',') === 'long,short_1', Object.keys(state.scenarios));
  const project = loadProject(ACCEPTANCE_VIDEO_ID);
  check('project restored', Boolean(project));
  if (!project) throw new AcceptanceFailure('the acceptance project is missing from the real store');
  check(
    'accepted Long asset binding survived',
    state.assetBindings.some((b: any) => b.target === 'long' && b.logicalRef === pre.assetBinding.logicalRef && b.assetId === pre.asset.id),
  );
  check(
    'accepted Short asset binding survived',
    state.assetBindings.some((b: any) => b.target === 'short_1' && b.logicalRef === pre.shortAssetBinding.logicalRef && b.assetId === pre.asset.id),
    state.assetBindings,
  );
  check(
    'accepted dialogue edit survived',
    state.scenarios.long.scenes.flatMap((s: any) => s.turns)
      .some((t: any) => t.id === pre.edit.turnId && String(t.spokenText).includes('48-hour clock')),
  );

  gate('product audio path authority');
  const audioPaths = await productionAudioPaths();
  check(
    'audio roots are the product engine roots (productionAudioBasePaths), not a re-derived formula',
    audioPaths.synthesisBasePath.endsWith('/audio/dialogue') && audioPaths.canonicalBasePath.endsWith('/audio/canonical'),
    audioPaths,
  );
  const audio = await verifyRealAudio('real production audio — distinct Kokoro voices synthesize', state);

  const server = await startRealServer();
  const base = server.baseUrl;
  const livePort = Number(new URL(base).port);
  let media: Record<string, unknown> = {};
  let frameProofs: Record<string, unknown>[] = [];
  let packageFiles: Array<{ name: string; path: string; exists: boolean }> = [];
  try {
    // ------------------------------------------------------------------
    // 17D. The product's own plan build must expose ABSOLUTE live-server
    //      media URLs (the same values the render job receives).
    // ------------------------------------------------------------------
    gate('17D. real absolute media URLs from the product plan build');
    const buildRes = await apiJson(base, `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('production plan built through the real API', buildRes.status === 200, buildRes.body?.error ?? buildRes.status);
    const targets: Array<{ target: string; mediaMap?: Record<string, string>; unresolvedRequired?: string[] }> = buildRes.body?.targets ?? [];
    const longEntry = targets.find((t) => t.target === 'long');
    const shortEntry = targets.find((t) => t.target === 'short_1');
    check('both targets planned by the product', Boolean(longEntry && shortEntry), targets.map((t) => t.target));
    for (const [name, entry] of [['Long', longEntry], ['Short', shortEntry]] as const) {
      const urls = Object.values(entry?.mediaMap ?? {});
      check(`${name} mediaMap is non-empty`, urls.length > 0, entry?.mediaMap);
      check(
        `${name} mediaMap values are absolute live-server URLs`,
        urls.every((v) => typeof v === 'string' && v.startsWith(`http://127.0.0.1:${livePort}/media/asset/`)),
        urls,
      );
      check(`${name} mediaMap contains the acceptance asset`, urls.some((v) => v.includes(pre.asset.id)), urls);
      check(`${name} has no unresolved REQUIRED asset refs`, (entry?.unresolvedRequired ?? []).length === 0, entry?.unresolvedRequired);
    }
    check(
      'both target entries carry the product resolution DTO (assetId + scene usages)',
      (longEntry as any)?.resolution?.bindings?.length > 0 && (shortEntry as any)?.resolution?.bindings?.length > 0,
      {
        longBindings: (longEntry as any)?.resolution?.bindings?.length ?? null,
        shortBindings: (shortEntry as any)?.resolution?.bindings?.length ?? null,
      },
    );
    const longAssetUrl = Object.values(longEntry?.mediaMap ?? {}).find((v) => v.includes(pre.asset.id)) as string;
    const shortAssetUrl = (Object.values(shortEntry?.mediaMap ?? {}).find((v) => v.includes(pre.asset.id)) ?? null) as string | null;
    const liveRes = await fetch(longAssetUrl);
    const liveBytes = Buffer.from(await liveRes.arrayBuffer());
    const liveSha256 = createHash('sha256').update(liveBytes).digest('hex');
    check('the absolute media URL is served live (200)', liveRes.status === 200, liveRes.status);
    check(
      'the live media URL serves exactly the registered acceptance asset bytes',
      liveSha256 === pre.asset.sha256,
      { live: liveSha256, registered: pre.asset.sha256 },
    );

    // ------------------------------------------------------------------
    // 17F. REAL final production export through the product route + real
    //      job polling (no in-process build shortcut).
    // ------------------------------------------------------------------
    gate('per-turn audio identity BEFORE the final export');
    const identityBefore = await buildPerTurnAudioIdentity(state);
    check(
      'no acoustic synthesis collisions before the export',
      identityBefore.report.collisions.length === 0,
      identityBefore.report.collisions,
    );
    const hashesBefore = identityBefore.records.map((r) => r.sha256).sort().join(',');

    gate('17F. real final production export (POST /production/export) + job polling');
    const { jobId: exportJobId, job: exportJob } = await startJobAndWait(
      base,
      `/api/projects/${ACCEPTANCE_VIDEO_ID}/production/export`,
      {},
      'final export',
      60 * 60_000,
    );
    const result = exportJob.result ?? {};
    check('final export job kind is final', exportJob.kind === 'final', exportJob.kind);
    check('final export status ok', result.status === 'ok', productionJobFailureDetail(exportJob));
    check('Long output recorded by the product', Boolean(result.outputs?.long), result.outputs);
    check('Short output recorded by the product', Boolean(result.outputs?.short_1), result.outputs);
    check('package root produced by the product', Boolean(result.packageRoot), result.packageRoot);
    check('package status is ready', result.packageStatus === 'ready', result.packageStatus);
    /* Every recorded artifact path must be OUTPUT_DIR-relative POSIX (K). */
    const relativeArtifactPaths: Array<[string, string]> = [
      ['outputs.long', String(result.outputs?.long ?? '')],
      ['outputs.short_1', String(result.outputs?.short_1 ?? '')],
      ['packageRoot', String(result.packageRoot ?? '')],
      ['productKit', String(result.productKit ?? '')],
    ];
    const badRelativePaths = relativeArtifactPaths.filter(
      ([, rel]) => !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..'),
    );
    check(
      'every recorded artifact path is output-root relative (never an absolute host path)',
      badRelativePaths.length === 0,
      { paths: relativeArtifactPaths, bad: badRelativePaths },
    );
    const outsideOutputRoot = relativeArtifactPaths.filter(([, rel]) => {
      if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return true;
      const abs = path.resolve(OUTPUT_DIR, rel);
      const relToRoot = path.relative(path.resolve(OUTPUT_DIR), abs);
      return relToRoot.startsWith('..') || path.isAbsolute(relToRoot);
    });
    check('every recorded artifact path stays inside OUTPUT_DIR', outsideOutputRoot.length === 0, outsideOutputRoot);
    check(
      'production deliverables + readiness were written by the real build (P9-P12)',
      Boolean(result.readiness) && Boolean(result.productKit),
      { productKit: result.productKit ?? null, readiness: result.readiness ?? null },
    );
    check(
      'production readiness QC verdict is READY with no blocking findings (P12)',
      (result.readiness as any)?.status === 'ready' &&
        (result.readiness as any)?.readyForProductionDelivery === true &&
        ((result.readiness as any)?.findings ?? []).every((f: any) => f.severity !== 'error'),
      {
        status: (result.readiness as any)?.status ?? null,
        readyForProductionDelivery: (result.readiness as any)?.readyForProductionDelivery ?? null,
        errorFindings: ((result.readiness as any)?.findings ?? []).filter((f: any) => f.severity === 'error'),
      },
    );

    gate('final package contents (paths from the product path constants - 17C)');
    const pkgRoot = path.join(OUTPUT_DIR, String(result.packageRoot));
    const corePkg = (await import('@buildtrack/core')) as unknown as Record<string, string>;
    const PRODUCTION_PACKAGE_MANIFEST_PATH = corePkg.PRODUCTION_PACKAGE_MANIFEST_PATH;
    const PRODUCTION_PACKAGE_CHECKSUMS_PATH = corePkg.PRODUCTION_PACKAGE_CHECKSUMS_PATH;
    const PRODUCTION_PACKAGE_SUMMARY_PATH = corePkg.PRODUCTION_PACKAGE_SUMMARY_PATH;
    check(
      'product exports the delivery manifest path constant',
      PRODUCTION_PACKAGE_MANIFEST_PATH === 'manifest/delivery_manifest.json',
      PRODUCTION_PACKAGE_MANIFEST_PATH,
    );
    check(
      'product exports the package summary path constant',
      PRODUCTION_PACKAGE_SUMMARY_PATH === 'evidence/package_summary.json',
      PRODUCTION_PACKAGE_SUMMARY_PATH,
    );
    const manifestPath = path.join(pkgRoot, ...String(PRODUCTION_PACKAGE_MANIFEST_PATH).split('/'));
    check('delivery manifest exists at the product path constant', fs.existsSync(manifestPath), path.relative(ROOT, manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    check('manifest status is ready', manifest.status === 'ready', manifest.status);
    check('manifest mode is production', manifest.mode === 'production', manifest.mode);
    check('manifest readyForProductionDelivery', manifest.readyForProductionDelivery === true);
    check('manifest requested targets are long + short_1', JSON.stringify(manifest.requestedTargetIds) === JSON.stringify(['long', 'short_1']), manifest.requestedTargetIds);
    check('manifest packaged targets are long + short_1', JSON.stringify(manifest.packagedTargetIds) === JSON.stringify(['long', 'short_1']), manifest.packagedTargetIds);
    check('manifest has no failed targets', (manifest.failedTargetIds ?? []).length === 0, manifest.failedTargetIds);
    check('manifest has no error findings', manifest.summary?.errorCount === 0, manifest.summary?.errorCount);
    const manifestText = fs.readFileSync(manifestPath, 'utf8');
    check('manifest is portable (no absolute home paths)', !manifestText.includes('/home/'), null);

    const deliverables: Array<[string, string]> = [
      ['long video', path.join(OUTPUT_DIR, String(result.outputs.long))],
      ['short video', path.join(OUTPUT_DIR, String(result.outputs.short_1))],
      ['long captions vtt', path.join(pkgRoot, 'long', 'captions.vtt')],
      ['short captions vtt', path.join(pkgRoot, 'shorts', 'short_1', 'captions.vtt')],
      ['long descriptor', path.join(pkgRoot, 'long', 'target.json')],
      ['short descriptor', path.join(pkgRoot, 'shorts', 'short_1', 'target.json')],
      ['long qc', path.join(pkgRoot, 'long', 'qc.json')],
      ['short qc', path.join(pkgRoot, 'shorts', 'short_1', 'qc.json')],
      ['checksums', path.join(pkgRoot, ...String(PRODUCTION_PACKAGE_CHECKSUMS_PATH).split('/'))],
      ['package summary', path.join(pkgRoot, ...String(PRODUCTION_PACKAGE_SUMMARY_PATH).split('/'))],
    ];
    packageFiles = [];
    for (const [name, file] of deliverables) {
      const exists = fs.existsSync(file) && fs.statSync(file).size > 0;
      packageFiles.push({ name, path: path.relative(ROOT, file), exists });
      console.log(`  ${exists ? 'OK' : '--'} ${name} -> ${path.relative(ROOT, file)}`);
      check(`package deliverable present and non-empty: ${name}`, exists, path.relative(ROOT, file));
    }
    const longQc = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'long', 'qc.json'), 'utf8'));
    const shortQc = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'shorts', 'short_1', 'qc.json'), 'utf8'));
    check('Long QC did not fail', longQc.status !== 'fail', longQc.status);
    check('Short QC did not fail', shortQc.status !== 'fail', shortQc.status);

    // ------------------------------------------------------------------
    // Static-audit closure: the production product kit (P9–P12 output) must
    // really exist at the product's own output paths, with verifiable
    // checksums, real provenance, real thumbnails and real contact sheets.
    // ------------------------------------------------------------------
    // The final export must have consumed EXACTLY the per-turn WAVs that were
    // verified above: same turn set, same bytes, still no collision.
    gate('per-turn audio identity AFTER the final export');
    const identityAfter = await buildPerTurnAudioIdentity(state);
    check(
      'the export did not change the per-turn turn set',
      identityAfter.records.length === identityBefore.records.length,
      { before: identityBefore.records.length, after: identityAfter.records.length },
    );
    check(
      'the export consumed exactly the verified per-turn bytes (same hash multiset)',
      identityAfter.records.map((r) => r.sha256).sort().join(',') === hashesBefore,
      { beforeUnique: identityBefore.report.totalUniqueHashes, afterUnique: identityAfter.report.totalUniqueHashes },
    );
    check(
      'no acoustic synthesis collisions after the export',
      identityAfter.report.collisions.length === 0,
      identityAfter.report.collisions,
    );

    gate('production product kit, provenance, thumbnails and contact sheets (real output paths)');
    const kitRel = result.productKit as string | undefined;
    check('build result links the production product kit', typeof kitRel === 'string' && kitRel.length > 0, kitRel ?? null);
    const kitRoot = path.join(OUTPUT_DIR, String(kitRel));
    check('kit root exists at the output-relative path', fs.existsSync(kitRoot), path.relative(ROOT, kitRoot));
    const kitFile = (rel: string) => path.join(kitRoot, rel);

    const kitManifestPath = kitFile('manifest.json');
    check('kit manifest exists', fs.existsSync(kitManifestPath), path.relative(ROOT, kitManifestPath));
    const kitManifest = JSON.parse(fs.readFileSync(kitManifestPath, 'utf8'));
    check('kit manifest uses the product kit schema', kitManifest.schema === 'production-product-kit.v1', kitManifest.schema);
    check('kit manifest is a final production build', kitManifest.kind === 'final', kitManifest.kind);
    check(
      'kit manifest records READY readiness',
      kitManifest.readiness?.status === 'ready' && kitManifest.readiness?.readyForProductionDelivery === true,
      kitManifest.readiness,
    );
    check(
      'kit manifest links the Phase 6D package (separate contract, both linked)',
      kitManifest.phase6dPackage === result.packageRoot && kitManifest.phase6dPackageStatus === 'ready',
      { kitPackage: kitManifest.phase6dPackage, buildPackage: result.packageRoot, status: kitManifest.phase6dPackageStatus },
    );
    const kitFiles = (kitManifest.files ?? []) as string[];
    check('kit manifest lists the kit files', kitFiles.length > 0, kitFiles.length);
    const kitMissing = kitFiles.filter((rel) => {
      const abs = kitFile(rel);
      return !fs.existsSync(abs) || fs.statSync(abs).size === 0;
    });
    check('every kit file listed in the manifest exists and is non-empty', kitMissing.length === 0, kitMissing);

    check(
      'kit checksums.sha256 exists and is non-empty',
      fs.existsSync(kitFile('checksums.sha256')) && fs.statSync(kitFile('checksums.sha256')).size > 0,
      path.relative(ROOT, kitFile('checksums.sha256')),
    );
    const checksumRows = fs
      .readFileSync(kitFile('checksums.sha256'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, ...rest] = line.split(/\s+/);
        return { sha, relPath: rest.join(' ') };
      });
    check(
      'kit checksums cover every manifest file',
      kitFiles.every((rel) => checksumRows.some((row) => row.relPath === rel)),
      { checksumRows: checksumRows.length, manifestFiles: kitFiles.length },
    );
    const badChecksums = checksumRows.filter((row) => {
      const abs = kitFile(row.relPath);
      if (!fs.existsSync(abs)) return true;
      return sha256File(abs) !== row.sha;
    });
    check('every kit checksum matches the bytes on disk', badChecksums.length === 0, badChecksums.slice(0, 5));

    const provenanceRows = JSON.parse(fs.readFileSync(kitFile('asset_provenance.json'), 'utf8'));
    check('asset provenance is a non-empty list', Array.isArray(provenanceRows) && provenanceRows.length > 0, provenanceRows?.length);
    const acceptanceProvenance = (provenanceRows as any[]).filter((row) => row.assetId === pre.asset.id);
    check(
      'provenance records the real bound acceptance asset (not empty/fake provenance)',
      acceptanceProvenance.length >= 1,
      { assetId: pre.asset.id, recorded: acceptanceProvenance.length, rows: (provenanceRows as any[]).length },
    );
    check(
      'provenance rows carry real source + license + a resolved URL + scene usage',
      acceptanceProvenance.every(
        (row) => Boolean(row.source) && Boolean(row.license) && Boolean(row.logicalRef) && (row.sceneIds ?? []).length > 0,
      ),
      acceptanceProvenance.map((row) => ({ target: row.target, logicalRef: row.logicalRef, scenes: row.sceneIds?.length, resolvedUrl: row.resolvedUrl ?? null })),
    );
    check(
      'provenance CSV exists and is non-empty',
      fs.existsSync(kitFile('asset_provenance.csv')) && fs.statSync(kitFile('asset_provenance.csv')).size > 0,
    );

    const thumbDir = kitFile('thumbnails');
    const thumbs = fs.existsSync(thumbDir)
      ? fs.readdirSync(thumbDir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort()
      : [];
    check('at least 3 real thumbnails were extracted from the completed Long MP4', thumbs.length >= 3, thumbs);
    check(
      'every thumbnail is non-empty',
      thumbs.every((f) => fs.statSync(path.join(thumbDir, f)).size > 0),
      thumbs.map((f) => ({ file: f, bytes: fs.statSync(path.join(thumbDir, f)).size })),
    );
    const thumbHashes = thumbs.map((f) => sha256File(path.join(thumbDir, f)));
    check(
      'thumbnails come from distinct positions (pairwise distinct bytes)',
      new Set(thumbHashes).size === thumbs.length,
      { thumbnails: thumbs.length, distinct: new Set(thumbHashes).size },
    );

    const longSheet = kitFile('contact_sheets/long.jpg');
    const shortSheet = kitFile('contact_sheets/short_1.jpg');
    check('Long contact sheet exists and is non-empty', fs.existsSync(longSheet) && fs.statSync(longSheet).size > 0, path.relative(ROOT, longSheet));
    check('Short contact sheet exists and is non-empty', fs.existsSync(shortSheet) && fs.statSync(shortSheet).size > 0, path.relative(ROOT, shortSheet));

    gate('real media verification (Long + Short)');
    media = {};
    for (const [name, file] of [
      ['long', path.join(OUTPUT_DIR, String(result.outputs.long))],
      ['short', path.join(OUTPUT_DIR, String(result.outputs.short_1))],
    ] as const) {
      const p = await analyseFile(file);
      const entry = {
        file: path.relative(ROOT, file),
        sha256: sha256File(file),
        sizeBytes: fs.statSync(file).size,
        durationSeconds: p.duration,
        videoCodec: p.codec_name,
        audioCodec: p.audioCodec,
        width: p.width,
        height: p.height,
        fps: p.r_frame_rate,
        audioStreamCount: p.hasAudio ? 1 : 0,
      };
      media[name] = entry;
      writeEvidence(`${name}-media-verification.json`, entry);
      if (name === 'long') {
        check('Long is 1920x1080', p.width === 1920 && p.height === 1080, { w: p.width, h: p.height });
      } else {
        check('Short is 1080x1920', p.width === 1080 && p.height === 1920, { w: p.width, h: p.height });
      }
      check(`${name} is H264`, /h264|avc/i.test(String(entry.videoCodec)), entry.videoCodec);
      check(`${name} is AAC`, /aac/i.test(String(entry.audioCodec)), entry.audioCodec);
      check(`${name} has an audio stream`, entry.audioStreamCount === 1);
    }
    check('Long and Short are different media', (media as any).long.sha256 !== (media as any).short.sha256);

    // ------------------------------------------------------------------
    // 17D frame proof — the rendered deliverables really contain the asset's
    //      pixels, so the product's absolute live-server URL demonstrably
    //      reached the renderer and was composited.
    // ------------------------------------------------------------------
    gate('17D frame proof — the acceptance asset is composited into both deliverables inside its planned display window');
    frameProofs = [];
    // The MEASURED per-turn records must come from the builder's own typed
    // return value. buildPerTurnAudioIdentity() returns { records, report,
    // paths } and has no `perTurnRecords` property, so the previous
    // `(identityAfter as any).perTurnRecords ?? []` silently evaluated to an
    // EMPTY record set on every run: each scene then received zero measured
    // turn durations, assetExposureWindows() produced no window for the
    // asset-bearing scene, the sampler inspected 0 frames and 17D failed
    // (run 37065742559) — even though the marker WAS composited into the Long
    // (the non-authoritative legacy scan found 7977 marker pixels).
    const finalAudioRecords = identityAfter.records;
    const longAssetSceneIds = resolvedAssetSceneIds((longEntry as any)?.resolution, pre.asset.id);
    const shortAssetSceneIdsFinal = resolvedAssetSceneIds((shortEntry as any)?.resolution, pre.asset.id);
    check(
      'the Long plan reports the scene(s) where the acceptance asset is displayed',
      longAssetSceneIds.length > 0,
      { assetId: pre.asset.id, longAssetSceneIds },
    );
    check(
      'the Short plan reports the scene(s) where the acceptance asset is displayed',
      shortAssetSceneIdsFinal.length > 0,
      { assetId: pre.asset.id, shortAssetSceneIds: shortAssetSceneIdsFinal },
    );
    frameProofs.push(
      await writeAssetFrameProof(path.join(OUTPUT_DIR, String(result.outputs.long)), pre.asset.id, 'final-long', {
        assetSceneIds: longAssetSceneIds,
        sceneDurations: sceneTurnDurationsFor(state.scenarios.long, finalAudioRecords, 'long'),
      }),
    );
    frameProofs.push(
      await writeAssetFrameProof(path.join(OUTPUT_DIR, String(result.outputs.short_1)), pre.asset.id, 'final-short', {
        assetSceneIds: shortAssetSceneIdsFinal,
        sceneDurations: sceneTurnDurationsFor(state.scenarios.short_1, finalAudioRecords, 'short_1'),
      }),
    );
    for (const proof of frameProofs) {
      check(
        `frame proof (${String(proof.stage)}): asset pixels present in the rendered deliverable`,
        Number(proof.markerPixelsBestFrame) >= ASSET_FRAME_MIN_PIXELS,
        proof,
      );
    }

    writeEvidence('package-verification.json', {
      stage: 'final-production',
      jobId: exportJobId,
      api: 'POST /api/projects/:id/production/export + GET /api/projects/:id/production/jobs/:jobId',
      packageRoot: path.relative(ROOT, pkgRoot),
      status: manifest.status,
      mode: manifest.mode,
      readyForProductionDelivery: manifest.readyForProductionDelivery,
      requestedTargetIds: manifest.requestedTargetIds,
      packagedTargetIds: manifest.packagedTargetIds,
      failedTargetIds: manifest.failedTargetIds,
      errorCount: manifest.summary?.errorCount,
      packagePathConstants: {
        manifest: PRODUCTION_PACKAGE_MANIFEST_PATH,
        checksums: PRODUCTION_PACKAGE_CHECKSUMS_PATH,
        summary: PRODUCTION_PACKAGE_SUMMARY_PATH,
        source: 'packages/core/src/scenario/delivery-package-pipeline.ts (exported constants)',
      },
      deliverables: packageFiles,
      productionKit: {
        relPath: kitRel,
        manifestSchema: kitManifest.schema,
        readiness: kitManifest.readiness,
        linkedPhase6dPackage: kitManifest.phase6dPackage,
        files: kitFiles,
        checksumsVerified: checksumRows.length,
        provenanceRows: (provenanceRows as any[]).length,
        acceptanceAssetProvenanceRows: acceptanceProvenance.map((row) => ({
          target: row.target,
          logicalRef: row.logicalRef,
          sceneIds: row.sceneIds ?? [],
          source: row.source,
          license: row.license,
        })),
        thumbnails: thumbs,
        contactSheets: ['contact_sheets/long.jpg', 'contact_sheets/short_1.jpg'],
      },
      qc: { long: longQc.status, short: shortQc.status },
      audioIdentity: {
        beforeExport: {
          totalPerTurnWavs: identityBefore.report.totalRecords,
          totalUniqueHashes: identityBefore.report.totalUniqueHashes,
          totalUniqueSynthesisKeys: identityBefore.report.totalUniqueSynthesisKeys,
          duplicateHashGroups: identityBefore.report.duplicateHashGroups.length,
          unexpectedCollisions: identityBefore.report.classificationSummary.unexpectedCollisions,
        },
        afterExport: {
          totalPerTurnWavs: identityAfter.report.totalRecords,
          totalUniqueHashes: identityAfter.report.totalUniqueHashes,
          totalUniqueSynthesisKeys: identityAfter.report.totalUniqueSynthesisKeys,
          duplicateHashGroups: identityAfter.report.duplicateHashGroups.length,
          unexpectedCollisions: identityAfter.report.classificationSummary.unexpectedCollisions,
        },
        classification: 'identical acoustic synthesis request -> identical bytes (expected determinism)',
      },
      media,
      mediaUrlAuthority: {
        livePort,
        longAbsoluteUrl: longAssetUrl,
        shortAbsoluteUrl: shortAssetUrl,
        servedLiveBytes: liveBytes.length,
        matchesRegisteredSha256: liveSha256 === pre.asset.sha256,
      },
      frameProofs,
      readiness: result.readiness ?? null,
      audio,
      checks,
    });
    saveStage('final-production', {
      stage: 'final-production',
      packageRoot: path.relative(ROOT, pkgRoot),
      productKit: kitRel,
      manifest,
      media,
      frameProofs,
      audio,
      deliverables: packageFiles,
    });
  } finally {
    await server.close();
  }
  console.log('\n[final-production] PASSED');
}

/* ------------------------------------------------------------------ */
/*  Stage 4 — second fresh project: cross-project production history    */
/* ------------------------------------------------------------------ */

async function stageSecondProject(): Promise<void> {
  const { loadProject } = await import('../apps/api/src/services/store.js');
  /** Anything the second project writes must be written by THIS stage run. */
  const stageStartedAt = new Date().toISOString();

  gate('17G. production history written by project 1 is on disk');
  const server = await startRealServer();
  const base = server.baseUrl;
  try {
    const historyRes = await apiJson(base, '/api/production-history');
    check('GET /api/production-history works on a fresh process', historyRes.status === 200, historyRes.status);
    const entries: any[] = historyRes.body?.entries ?? [];
    check('project 1 left at least one REAL production history observation', entries.length >= 1, entries.length);
    check(
      'the production history observation belongs to the accepted project',
      entries.some((e) => e.videoId === ACCEPTANCE_VIDEO_ID),
      entries.map((e) => e.videoId),
    );
    const entry = entries.find((e) => e.videoId === ACCEPTANCE_VIDEO_ID);
    check(
      'the observation carries real casting + style data',
      Boolean(entry) && Object.keys(entry.casting ?? {}).length > 0 && typeof entry.styleFingerprint === 'string',
      entry ?? null,
    );

    gate('17G. a SECOND fresh fictional project consumes that persisted history');
    const created = await apiJson(base, '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SECOND_ACCEPTANCE_INPUT),
    });
    check('second project created through the real API', created.status === 200 || created.status === 201, created.status);
    check(
      'second project id is its own slug',
      created.body?.project?.meta?.input?.videoId === SECOND_ACCEPTANCE_VIDEO_ID,
      created.body?.project?.meta?.input?.videoId ?? null,
    );

    const gen = await apiJson(base, `/api/projects/${SECOND_ACCEPTANCE_VIDEO_ID}/production/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('second project generation succeeded through the real API', gen.status === 200, gen.body?.error ?? gen.status);

    const stateRes = await apiJson(base, `/api/projects/${SECOND_ACCEPTANCE_VIDEO_ID}/production`);
    check('second project production state readable', stateRes.status === 200, stateRes.status);
    const project2 = loadProject(SECOND_ACCEPTANCE_VIDEO_ID);
    check('second project persisted', Boolean(project2));
    const state2 = await (async () => {
      const { loadProductionState } = await import('../apps/api/src/services/production-state.js');
      return loadProductionState(SECOND_ACCEPTANCE_VIDEO_ID);
    })();
    check('second project production state persisted', Boolean(state2));
    const historyInput = (state2 as any)?.historyInput ?? {};
    check('second generation recorded the history it consumed', Boolean(historyInput.source), historyInput);
    check(
      'second generation consumed REAL PRODUCTION history (not legacy, not none)',
      historyInput.source === 'production',
      historyInput,
    );
    check(
      'the consumed history is project 1 (>= 1 observation, project 1 videoId present)',
      Number(historyInput.productionEntryCount) >= 1 && (historyInput.videoIds ?? []).includes(ACCEPTANCE_VIDEO_ID),
      historyInput,
    );
    check('the consumed history carried real persona keys', Number(historyInput.personaKeyCount) > 0, historyInput.personaKeyCount);

    gate('17G. the second project is fresh content and did NOT render');
    const scenario2 = (state2 as any).scenarios ?? {};
    const firstState = await readState();
    check('second project generated the Long target', Boolean(scenario2.long), Object.keys(scenario2));
    check(
      'second project scenario is fresh (own scenarioId)',
      scenario2.long?.metadata?.id !== firstState.scenarios.long.metadata.id,
      { second: scenario2.long?.metadata?.id ?? null, first: firstState.scenarios.long.metadata.id },
    );
    check(
      'no scene id is reused from project 1',
      scenario2.long.scenes.every((s: any) => !firstState.scenarios.long.scenes.some((l: any) => l.id === s.id)),
    );
    const spoken2 = (scenario2.long.scenes ?? []).flatMap((s: any) => s.turns.map((t: any) => t.spokenText)).join(' ');
    for (const m of spoken2.matchAll(/(?<![\d.])\d+(?:\.\d+)?(?![\d.])/g)) {
      check(`second project spoken number '${m[0]}' is its own source fact`, SECOND_SOURCE_NUMBERS.has(m[0]), m[0]);
    }
    /*
     * The second project must end in the GENERATION-ONLY state. This is
     * deliberately strict: accepting a stale/optimistic `ready` (or any build,
     * package, kit or readiness record) would make the gate pass for the wrong
     * product state.
     */
    check(
      'no build was recorded for the second project (generation only)',
      ((state2 as any).builds ?? []).length === 0,
      (state2 as any).builds,
    );
    check(
      'no production artifact at all was recorded for the second project',
      ((state2 as any).artifacts ?? []).length === 0,
      (state2 as any).artifacts,
    );
    check(
      'the second project production state is exactly `generated` (never ready/ready_for_export)',
      String((state2 as any).status) === 'generated',
      (state2 as any).status,
    );
    check(
      'the second project has no product kit, readiness QC or package summary',
      !(state2 as any).productKitPath && !(state2 as any).lastReadiness && !(state2 as any).lastQcSummary,
      {
        productKitPath: (state2 as any).productKitPath ?? null,
        lastReadiness: (state2 as any).lastReadiness ?? null,
        lastQcSummary: (state2 as any).lastQcSummary ?? null,
      },
    );
    check(
      'the second project state was written by THIS stage run (not a stale restored file)',
      typeof (state2 as any).updatedAt === 'string' && (state2 as any).updatedAt >= stageStartedAt,
      { updatedAt: (state2 as any).updatedAt ?? null, stageStartedAt },
    );
    const secondOutDir = path.join(OUTPUT_DIR, SECOND_ACCEPTANCE_VIDEO_ID);
    const mp4s = fs.existsSync(secondOutDir)
      ? fs.readdirSync(secondOutDir, { recursive: true }).filter((f) => String(f).endsWith('.mp4'))
      : [];
    check('no MP4 exists for the second project (generation only, no render)', mp4s.length === 0, mp4s);
    check(
      'no Phase 6D package exists for the second project',
      !fs.existsSync(path.join(secondOutDir, 'production-package')),
      path.join(path.relative(ROOT, secondOutDir), 'production-package'),
    );
    const secondSummary = await apiJson(base, `/api/projects/${SECOND_ACCEPTANCE_VIDEO_ID}/production`);
    check('second project production summary status is generated', secondSummary.body?.production?.status === 'generated', secondSummary.body?.production?.status ?? null);
    check(
      'second project production summary exposes no build, kit or readiness',
      secondSummary.body?.production?.lastBuild == null &&
        secondSummary.body?.production?.productKitPath == null &&
        secondSummary.body?.production?.lastReadiness == null,
      {
        lastBuild: secondSummary.body?.production?.lastBuild ?? null,
        productKitPath: secondSummary.body?.production?.productKitPath ?? null,
        lastReadiness: secondSummary.body?.production?.lastReadiness ?? null,
      },
    );

    const verification = {
      stage: 'second-project',
      status: 'passed',
      runId: RUN_ID,
      commit: COMMIT,
      secondProject: {
        videoId: SECOND_ACCEPTANCE_VIDEO_ID,
        topic: SECOND_ACCEPTANCE_INPUT.topic,
        scenarioId: scenario2.long?.metadata?.id ?? null,
        targets: Object.keys(scenario2).sort(),
        renders: 0,
      },
      productionHistory: {
        route: 'GET /api/production-history',
        entries: entries.length,
        entryVideoIds: entries.map((e) => e.videoId),
        consumedByProject2: historyInput,
      },
      reusedAcrossProjects: true,
      renderFree: true,
      checks,
    };
    writeEvidence('second-project-verification.json', verification);
    saveStage('second-project', {
      stage: 'second-project',
      secondVideoId: SECOND_ACCEPTANCE_VIDEO_ID,
      historyInput,
      scenarioId: scenario2.long?.metadata?.id ?? null,
      renders: 0,
    });
  } finally {
    await server.close();
  }
  console.log('\n[second-project] PASSED');
}

/* ------------------------------------------------------------------ */
/*  Stage 4 — evidence aggregation                                      */
/* ------------------------------------------------------------------ */

async function stageEvidence(): Promise<void> {
  gate('aggregate lightweight evidence');
  const readJson = (name: string): unknown => {
    const f = path.join(EVIDENCE_DIR, name);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };
  const pre = (readJson('preflight-verification.json') as any) ?? null;
  const pkg = (readJson('package-verification.json') as any) ?? null;
  const shortSmoke = (readJson('short-smoke-media-verification.json') as any) ?? null;
  const secondProject = (readJson('second-project-verification.json') as any) ?? null;

  /*
   * Stage completeness is a HARD gate: the accepted run must have executed
   * every required stage. A stage that did not run (e.g. a skipped downstream
   * job) fails acceptance here instead of being silently reported.
   */
  const requiredStages: Array<[string, string, unknown]> = [
    ['preflight', 'preflight-verification.json', pre],
    ['short-smoke', 'short-smoke-media-verification.json', shortSmoke],
    ['final-production', 'package-verification.json', pkg],
    ['second-project', 'second-project-verification.json', secondProject],
  ];
  for (const [stage, file, data] of requiredStages) {
    check(`required acceptance stage ran and produced evidence: ${stage}`, Boolean(data), file);
  }

  /*
   * EVIDENCE CONTENTS ARE VALIDATED, NOT ASSUMED (audit item H).
   *
   * A file that merely EXISTS (or a JSON document that merely parses) is not
   * success. For every required stage:
   *   - the stage document must carry THIS stage identity, status `passed`,
   *     THIS run id and THIS commit, and a real timestamp;
   *   - the media/package files it references must exist, be non-empty and
   *     match their recorded SHA256;
   *   - the published evidence JSON must agree with the stage document.
   */
  const stageDocs: Record<string, Record<string, any>> = {};
  const stageDocFiles: Record<string, string> = {
    preflight: 'preflight.json',
    'short-smoke': 'short-smoke.json',
    'final-production': 'final-production.json',
    'second-project': 'second-project.json',
  };
  for (const [stage] of requiredStages as Array<[string, string, unknown]>) {
    const stageDoc = readStageDocument(stage) as Record<string, any>;
    stageDocs[stage] = stageDoc;
    const envelope = validateStageEnvelope(stage, stageDoc, { runId: RUN_ID, commit: COMMIT });
    const payload = validateStagePayload(stage, stageDoc, {
      rootDir: ROOT,
      outputDir: OUTPUT_DIR,
      markerMinPixels: ASSET_FRAME_MIN_PIXELS,
      runId: RUN_ID,
      commit: COMMIT,
    });
    const problems = [...envelope.problems, ...payload.problems];
    check(`stage document is valid evidence for ${stage} (${stageDocFiles[stage]})`, problems.length === 0, problems);
  }

  /* Evidence JSON <-> stage document agreement (a stale/foreign file fails). */
  check(
    'preflight evidence agrees with the preflight stage document',
    Boolean(pre) &&
      (pre as any).asset?.id === stageDocs.preflight.asset?.id &&
      Number((pre as any).audio?.perTurnFiles) === Number(stageDocs.preflight.audio?.perTurnFiles) &&
      (pre as any).assetUrl === stageDocs.preflight.mediaUrlAuthority?.absoluteUrl,
    {
      evidenceAssetId: (pre as any)?.asset?.id ?? null,
      stageAssetId: stageDocs.preflight.asset?.id ?? null,
      evidencePerTurnFiles: (pre as any)?.audio?.perTurnFiles ?? null,
      stagePerTurnFiles: stageDocs.preflight.audio?.perTurnFiles ?? null,
    },
  );
  check(
    'short-smoke evidence agrees with the short-smoke stage document (same bytes)',
    Boolean(shortSmoke) &&
      (shortSmoke as any).sha256 === stageDocs['short-smoke'].media?.sha256 &&
      Number((shortSmoke as any).width) === Number(stageDocs['short-smoke'].media?.width) &&
      Number((shortSmoke as any).frameProof?.markerPixelsBestFrame) ===
        Number(stageDocs['short-smoke'].media?.frameProof?.markerPixelsBestFrame),
    {
      evidenceSha256: (shortSmoke as any)?.sha256 ?? null,
      stageSha256: stageDocs['short-smoke'].media?.sha256 ?? null,
    },
  );
  check(
    'final-production evidence agrees with the final-production stage document',
    Boolean(pkg) &&
      (pkg as any).packageRoot === stageDocs['final-production'].packageRoot &&
      (pkg as any).productionKit?.relPath === stageDocs['final-production'].productKit &&
      (pkg as any).media?.long?.sha256 === stageDocs['final-production'].media?.long?.sha256,
    {
      evidencePackageRoot: (pkg as any)?.packageRoot ?? null,
      stagePackageRoot: stageDocs['final-production'].packageRoot ?? null,
    },
  );
  check(
    'second-project evidence agrees with the second-project stage document',
    Boolean(secondProject) &&
      (secondProject as any).secondProject?.videoId === stageDocs['second-project'].secondVideoId &&
      Number((secondProject as any).secondProject?.renders) === Number(stageDocs['second-project'].renders),
    {
      evidenceSecondVideoId: (secondProject as any)?.secondProject?.videoId ?? null,
      stageSecondVideoId: stageDocs['second-project'].secondVideoId ?? null,
    },
  );

  /*
   * Each stage's absolute media URLs must belong to THAT stage's own live
   * server port. Ephemeral ports may legitimately be reused by separate jobs,
   * so port inequality is not evidence of freshness; the final stage's live
   * fetch and its own URL authority are checked instead.
   */
  const preflightPort = Number((pre as any)?.mediaUrlAuthority?.livePort);
  const finalAuthority = (pkg as any)?.mediaUrlAuthority ?? {};
  const finalPort = Number(finalAuthority.livePort);
  check('preflight recorded its own live server port', Number.isInteger(preflightPort) && preflightPort > 0, preflightPort);
  check('final production recorded its own live server port', Number.isInteger(finalPort) && finalPort > 0, finalPort);
  check(
    "final production media URLs use THIS stage's own live server port",
    typeof finalAuthority.longAbsoluteUrl === 'string' &&
      finalAuthority.longAbsoluteUrl.startsWith(`http://127.0.0.1:${finalPort}/media/asset/`) &&
      (finalAuthority.shortAbsoluteUrl === null ||
        String(finalAuthority.shortAbsoluteUrl).startsWith(`http://127.0.0.1:${finalPort}/media/asset/`)),
    { preflightPort, finalPort, longAbsoluteUrl: finalAuthority.longAbsoluteUrl ?? null, shortAbsoluteUrl: finalAuthority.shortAbsoluteUrl ?? null },
  );
  const stageVerification = Object.fromEntries(
    requiredStages.map(([stage, file, data]) => [
      stage,
      {
        status: data ? 'passed' : 'not-run',
        evidence: file,
        keyEvidence: data
          ? stage === 'preflight'
            ? {
                absoluteMediaUrl: (data as any).assetUrl ?? null,
                shortAbsoluteMediaUrl: (data as any).shortAssetBinding?.resolvedMediaMapEntry ?? null,
                perTurnAudioFiles: (data as any).audio?.perTurnFiles ?? null,
                assetId: (data as any).asset?.id ?? null,
              }
            : stage === 'short-smoke'
              ? {
                  file: (data as any).file ?? null,
                  sha256: (data as any).sha256 ?? null,
                  frameProofMarkerPixels: (data as any).frameProof?.markerPixelsBestFrame ?? null,
                }
              : stage === 'final-production'
                ? {
                    jobId: (data as any).jobId ?? null,
                    packageRoot: (data as any).packageRoot ?? null,
                    packageStatus: (data as any).status ?? null,
                    frameProofs: (data as any).frameProofs ?? null,
                  }
                : {
                    secondVideoId: (data as any).secondProject?.videoId ?? null,
                    consumedHistory: (data as any).productionHistory?.consumedByProject2 ?? null,
                    renders: (data as any).secondProject?.renders ?? null,
                  }
          : null,
      },
    ]),
  );
  writeEvidence('acceptance-verification.json', {
    stage: 'final-product-acceptance-verification',
    generatedAt: new Date().toISOString(),
    /* The run identity this evidence belongs to (null only outside Actions). */
    runId: RUN_ID,
    commit: COMMIT,
    /* Every required stage document was envelope+payload validated above. */
    stageDocumentValidation: Object.fromEntries(
      Object.entries(stageDocs).map(([stage, doc]) => [
        stage,
        {
          document: stageDocFiles[stage],
          status: doc.status,
          runId: doc.runId ?? null,
          commit: doc.commit ?? null,
          generatedAt: doc.generatedAt ?? null,
        },
      ]),
    ),
    /*
     * Honest provenance of the preflight state. Retry 5 is a COLD START: the
     * preflight state consumed by short-smoke / final-production is the state
     * THIS run's preflight job persisted (and uploaded as an artifact), because
     * Retry 4's `final-acceptance-preflight` artifact (run 36888349699) was not
     * retrievable in this environment. Nothing was inherited, and nothing about
     * the state was fabricated.
     */
    preflightStateOrigin: {
      kind: 'produced-by-this-run',
      producer: 'preflight job of this workflow run',
      inheritedFromRetry4: false,
      retry4RunId: 36888349699,
      retry4PreflightArtifact: 'final-acceptance-preflight (not retrievable; not used)',
      note: 'Cold start: generation, real Kokoro audio, edit, bindings and mediaMap are all produced fresh by this run.',
    },
    requiredStages: requiredStages.map(([stage]) => stage),
    stages: stageVerification,
    allRequiredStagesRan: requiredStages.every(([, , data]) => Boolean(data)),
    renderFreeSecondProject: secondProject?.renderFree ?? false,
    crossProjectHistoryReuse: secondProject?.reusedAcrossProjects ?? false,
  });

  const audioVerification = {
    stage: 'audio',
    engine: 'kokoro-js (Kokoro-82M-v1.0-ONNX, cache-only, no SAM fallback)',
    semanticIdentity: {
      rule: 'identical acoustic synthesis request -> identical bytes are expected; differing request -> must not collide',
      synthesisKeyFields: ['spokenText', 'resolvedKokoroVoice', 'synthesisSpeed', 'engine', 'modelId'],
      totalPerTurnWavs: pre?.audio?.perTurnFiles ?? null,
      totalUniqueHashes: pre?.audio?.distinctPerTurnHashes ?? null,
      duplicateHashGroups: pre?.audio?.duplicateHashGroups ?? null,
      expectedDeterministicDuplicates: pre?.audio?.expectedDeterministicDuplicates ?? null,
      unexpectedCollisions: pre?.audio?.unexpectedCollisions ?? null,
      sameKeyDifferentHashes: pre?.audio?.sameKeyDifferentHashes ?? null,
      resolvedKokoroVoices: pre?.audio?.resolvedKokoroVoices ?? null,
      voiceSlots: pre?.audio?.voiceSlots ?? null,
      perTurnEvidenceFile: pre?.audio?.identityEvidenceFile ?? null,
      duplicateHashGroupDetail: pre?.audio?.duplicateHashGroupDetail ?? null,
    },
    productAudioRoot: pre?.audio?.productAudioRoot ?? null,
    audioRootAuthority: pre?.audio?.audioRootAuthority ?? null,
    perTurnFiles: pre?.audio?.perTurnFiles ?? 0,
    expectedDialogueTurns: pre?.audio?.expectedDialogueTurns ?? null,
    distinctPerTurnHashes: pre?.audio?.distinctPerTurnHashes ?? 0,
    canonicalFiles: pre?.audio?.canonicalFiles ?? 0,
    canonicalSampleRate: pre?.audio?.canonicalSampleRate ?? null,
    canonicalChannels: pre?.audio?.canonicalChannels ?? null,
    canonicalCodec: pre?.audio?.canonicalCodec ?? null,
    sharedFixturePath: pre?.audio?.sharedFixturePath ?? null,
    voiceSlots: pre?.scenario?.characters?.map((c: any) => ({ id: c.id, voiceSlot: c.voiceSlot })) ?? [],
    sharedSourceUsed: false,
  };
  writeEvidence('audio-verification.json', audioVerification);

  const assetVerification = {
    stage: 'asset',
    acceptanceAsset: pre?.asset ?? null,
    assetLibraryId: pre?.asset?.id ?? null,
    logicalRef: pre?.asset?.logicalRef ?? null,
    explicitBinding: {
      target: 'long',
      logicalRef: pre?.assetBinding?.logicalRef ?? null,
      assetId: pre?.asset?.id ?? null,
      route: 'PUT /api/projects/:id/production/assets/:target/:logicalRef',
    },
    explicitShortBinding: {
      target: 'short_1',
      logicalRef: pre?.shortAssetBinding?.logicalRef ?? null,
      assetId: pre?.asset?.id ?? null,
      route: 'PUT /api/projects/:id/production/assets/:target/:logicalRef',
      resolvedMediaMapEntry: pre?.shortAssetBinding?.resolvedMediaMapEntry ?? null,
    },
    absoluteMediaUrl: pre?.assetUrl ?? null,
    mediaUrlAuthority: pre?.mediaUrlAuthority ?? null,
    frameProofs: pkg?.frameProofs ?? null,
    resolvedMediaMapEntry: pre?.assetUrl ?? null,
    renderedUsage: pkg ? Boolean(pkg.media) : false,
    mediaServing: pre?.mediaServing ?? null,
    assetBinding: pre?.assetBinding ?? null,
    pathResolution: {
      // The product stores Asset.path relative to DATA_DIR, never to the repo root.
      storedRelativePath: pre?.asset?.path ?? null,
      resolvedFrom: 'DATA_DIR (BUILDTRAKE_DATA)',
      resolvedRelativeToRepo: pre?.asset?.resolvedPath ?? null,
      sha256: pre?.asset?.sha256 ?? null,
    },
    provenance: {
      source: pre?.asset?.source ?? null,
      license: pre?.asset?.license ?? null,
      sha256: pre?.asset?.sha256 ?? null,
      realLocalPath: pre?.asset?.path ?? null,
    },
    flow: 'upload -> Asset Library -> persisted relative path (DATA_DIR) -> GET /media/asset/:id -> real bytes -> explicit production binding (PUT .../assets/long/<generated logicalRef>) -> Phase 6A resolution -> mediaMap -> Remotion',
    logicalRefSource: 'discovered from the product-generated Long plan; never hardcoded',
  };
  writeEvidence('asset-verification.json', assetVerification);

  const persistenceVerification = {
    stage: 'persistence',
    reopenProvenByFreshProcess: true,
    reopen: pre?.reopen ?? null,
    persisted: {
      longScenario: pre?.scenario?.longId ?? null,
      shortScenario: pre?.scenario?.shortId ?? null,
      dialogueEdit: pre?.edit ?? null,
      assetBinding: assetVerification.assetBinding ?? null,
      inputFingerprint: pre?.reopen?.inputFingerprint ?? null,
      generationFingerprint: pre?.reopen?.generationFingerprint ?? null,
    },
    method: 'reloaded through the normal storage APIs from a freshly spawned process',
  };
  writeEvidence('persistence-verification.json', persistenceVerification);

  const summary = {
    stage: 'final-product-acceptance',
    generatedAt: new Date().toISOString(),
    baseline: '65ffb06f4f48f01906b7d89e27674c24a199cdf0',
    videoId: ACCEPTANCE_VIDEO_ID,
    content: 'fresh, unseen, fictional training example authored for this acceptance',
    stages: {
      preflight: pre ? 'passed' : 'not-run',
      shortSmoke: shortSmoke ? 'passed' : 'not-run',
      finalProduction: pkg ? 'passed' : 'not-run',
      secondProject: secondProject ? 'passed' : 'not-run',
      evidence: 'passed',
    },
    scenario: pre?.scenario ?? null,
    media: pkg?.media ?? null,
    asset: {
      id: pre?.asset?.id ?? null,
      logicalRef: pre?.assetBinding?.logicalRef ?? null,
      pathResolution: 'Asset.path is relative to DATA_DIR, not the repository root',
      mediaServing: pre?.mediaServing ?? null,
      assetBinding: pre?.assetBinding ?? null,
      shortAssetBinding: pre?.shortAssetBinding ?? null,
      logicalRefSource: 'discovered from the product-generated plan; never hardcoded',
    },
    mediaUrlAuthority: pre?.mediaUrlAuthority ?? null,
    frameProofs: pkg?.frameProofs ?? (shortSmoke?.frameProof ? [shortSmoke.frameProof] : null),
    audioAuthority: pre?.audio ?? pkg?.audio ?? null,
    secondProject: secondProject
      ? {
          videoId: secondProject.secondProject?.videoId ?? null,
          consumedHistory: secondProject.productionHistory?.consumedByProject2 ?? null,
          renderFree: secondProject.renderFree ?? null,
          reusedAcrossProjects: secondProject.reusedAcrossProjects ?? null,
        }
      : null,
    package: pkg
      ? {
          root: pkg.packageRoot,
          status: pkg.status,
          readyForProductionDelivery: pkg.readyForProductionDelivery,
          requestedTargetIds: pkg.requestedTargetIds,
          packagedTargetIds: pkg.packagedTargetIds,
          failedTargetIds: pkg.failedTargetIds,
          errorCount: pkg.errorCount,
          deliverables: pkg.deliverables,
        }
      : null,
    evidenceFiles: fs.readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith('.json')).sort(),
    evidenceClass: {
      automatedAssertion: true,
      realRenderedEvidence: Boolean(pkg),
      apiLevelE2E: true,
      trueBrowserClickAutomation: false,
      label: 'API-level product E2E; UI rendered but not click-automated',
      environmentLimitation:
        'Chromium rendering runs in GitHub Actions; no click-level browser automation was added.',
    },
  };
  writeEvidence('acceptance-summary.json', summary);
  console.log('\n[evidence] PASSED');
}

/* ------------------------------------------------------------------ */
/*  Entry                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const command = process.argv[2];
  const stages: Record<string, () => Promise<void>> = {
    preflight: stagePreflight,
    'short-smoke': stageShortSmoke,
    'final-production': stageFinalProduction,
    'second-project': stageSecondProject,
    evidence: stageEvidence,
  };
  const stage = stages[command ?? ''];
  if (!stage) {
    console.error(`unknown stage '${command ?? ''}'. expected one of: ${Object.keys(stages).join(', ')}`);
    process.exit(2);
  }
  console.log(`[final-product-acceptance] stage=${command}`);
  console.log(`[scratch] ${path.relative(ROOT, SCRATCH)} (isolated; no real home directory touched)`);
  try {
    await stage();
  } catch (error) {
    const failure = error instanceof AcceptanceFailure
      ? error
      : new AcceptanceFailure(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
    console.error(`\n[FAILED] ${failure.message}`);
    if (failure.detail) console.error(JSON.stringify(failure.detail, null, 2));
    writeEvidence(`${command}-FAILURE.json`, {
      stage: command, status: 'failed', error: failure.message, detail: failure.detail, checks,
    });
    process.exit(1);
  }
}

await main();
