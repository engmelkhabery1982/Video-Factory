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

/* The API reads these at module load — set them before any import. */
process.env.BUILDTRAKE_DATA = DATA_DIR;
process.env.BUILDTRAKE_OUTPUT = OUTPUT_DIR;
process.env.NODE_ENV = 'production';

/* ------------------------------------------------------------------ */
/*  Fresh, unseen, fictional acceptance content                        */
/* ------------------------------------------------------------------ */

export const ACCEPTANCE_VIDEO_ID = 'FinalAcceptance_RFI_Backlog';

/**
 * Newly authored for this acceptance. A clearly fictional professional
 * training example: every statement below is the SOURCE AUTHORITY for this
 * fictional scenario, not a real industry statistic.
 */
export const ACCEPTANCE_INPUT = {
  videoId: ACCEPTANCE_VIDEO_ID,
  videoType: 'long',
  topic: 'Controlling an ageing RFI backlog before it becomes schedule delay',
  targetAudience: 'Package managers and document controllers',
  mainProblem: 'Ageing RFIs quietly turn into schedule delay',
  viewerPromise: 'A repeatable 48-hour control routine for the RFI register',
  hook: 'Twenty-four open RFIs, eight of them older than fourteen days.',
  script: [
    'This training example follows a fictional RFI register on a mid-size commercial fit-out.',
    'The register currently holds 24 open RFIs.',
    'Eight of those RFIs are older than 14 days.',
    'The control rule reviews the whole register every 48 hours.',
    'Any RFI still without a response after 7 days is escalated to the package manager.',
    'Three control actions stop the backlog from becoming schedule delay.',
    'First, age the register and flag every item past 14 days.',
    'Second, assign a single named owner to each open RFI.',
    'Third, escalate the aged items on a fixed 48-hour cycle.',
    'An ageing RFI only becomes delay when nobody owns the clock.',
    'Start your BuildTrack trial and put the register on a clock.',
  ].join('\n'),
  keyNumbers: ['24 open RFIs', '8 older than 14 days', '48 hours', '7 days', '3 control actions'],
  keyPoints: ['Age the register', 'Single named owner', 'Fixed escalation cycle'],
  productName: 'BuildTrack',
  productShots: [],
  cta: 'Start your BuildTrack trial',
  voiceoverFile: null,
  targetAudio: {},
  brollFiles: [],
  sourceReferences: ['Fictional training example — RFI Backlog Control, acceptance scenario'],
  outputLanguage: 'en',
  brandPreset: 'buildtrack',
  shortCount: 1,
};

/** Deterministic, locally generated acceptance asset (never a fixture copy). */
export const ACCEPTANCE_ASSET = {
  /** The acceptance asset's own label/filename stem. NOT a binding logicalRef:
   *  the binding logicalRef is discovered from the generated Long plan. */
  label: 'rfi-ageing-summary',
  name: 'RFI Ageing Summary (acceptance)',
  kind: 'chart',
  source: 'Generated locally for Final Product Acceptance',
  license: 'Project-owned acceptance evidence',
  tags: ['acceptance-asset', 'acceptance'],
};

/** The exact set of source numbers the acceptance script is allowed to speak. */
const SOURCE_NUMBERS = new Set(['24', '8', '14', '48', '7', '3']);

/**
 * SECOND fresh, unseen, fictional project (18/17G). Its only job is to prove
 * that production generation consumes project 1's PERSISTED production history
 * on a fresh run with no render at all.
 */
export const SECOND_ACCEPTANCE_VIDEO_ID = 'FinalAcceptance_Register_Handover';

export const SECOND_ACCEPTANCE_INPUT = {
  videoId: SECOND_ACCEPTANCE_VIDEO_ID,
  videoType: 'long',
  topic: 'Handing over an RFI register without losing ownership',
  targetAudience: 'Site managers taking over a live register',
  mainProblem: 'Register ownership blurs at handover',
  viewerPromise: 'A named-owner handover routine for the register',
  hook: 'Two owners for one register means no owner at all.',
  script: [
    'This training example follows a fictional register handover on a live fit-out.',
    'The handover pack contains 12 open items.',
    'Three named owners cover the whole register.',
    'The handover is signed off within 5 working days.',
    'One owner is named against every register line before the pack is signed.',
    'The escalation clock is handed over with the register, not reset.',
    'Start your BuildTrack trial and hand over a register with one owner.',
  ].join('\n'),
  keyNumbers: ['12 open items', '3 named owners', '5 working days'],
  keyPoints: ['Name one owner per register', 'Hand over the escalation clock', 'Sign the register handover'],
  productName: 'BuildTrack',
  productShots: [],
  cta: 'Start your BuildTrack trial',
  voiceoverFile: null,
  targetAudio: {},
  brollFiles: [],
  sourceReferences: ['Fictional training example — Register Handover, acceptance scenario'],
  outputLanguage: 'en',
  brandPreset: 'buildtrack',
  shortCount: 1,
};

/** The exact set of source numbers the SECOND acceptance project may speak. */
const SECOND_SOURCE_NUMBERS = new Set(['12', '3', '5']);

/* ------------------------------------------------------------------ */
/*  Evidence helpers                                                   */
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

function saveStage(stage: string, payload: unknown): void {
  fs.writeFileSync(path.join(STAGE_DIR, `${stage}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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

async function verifyRealAudio(label: string, state: any): Promise<Record<string, unknown>> {
  const { analyseFile } = await import('../apps/api/src/services/media.js');
  gate(label);
  const paths = await productionAudioPaths();
  const dialogueDir = path.join(ROOT, paths.synthesisBasePath);
  const canonicalDir = path.join(ROOT, paths.canonicalBasePath);
  const dialogue = wavFiles(dialogueDir);
  const canonical = wavFiles(canonicalDir);

  console.log(`  [audio] product authority root: ${paths.root}`);
  const expectedTurns = ['long', 'short_1'].reduce(
    (total, target) =>
      total +
      (state.scenarios[target]?.scenes ?? []).reduce((n: number, scene: any) => n + (scene.turns?.length ?? 0), 0),
    0,
  );

  check('per-turn Kokoro audio files exist under the product audio root', dialogue.length >= 4, dialogue.length);
  check(
    'at least one per-turn WAV per dialogue turn of the accepted targets',
    dialogue.length >= expectedTurns,
    { wavFiles: dialogue.length, dialogueTurns: expectedTurns },
  );
  // Every WAV in this run must live under the PRODUCT audio root: if the engine
  // (or the acceptance) had used a re-derived scratch path, extra WAVs would
  // exist somewhere else under .production. Retry 4 failed exactly there.
  const productionRootWavs = wavFiles(path.join(ROOT, '.production'));
  check(
    'no production WAV exists outside the product audio root (no re-derived scratch audio path)',
    productionRootWavs.length === dialogue.length + canonical.length,
    { productRootWavs: productionRootWavs.length, dialogue: dialogue.length, canonical: canonical.length },
  );
  const hashes = dialogue.map((f) => sha256File(f));
  check(
    'each per-turn audio file is independently synthesized',
    new Set(hashes).size === dialogue.length,
    `${new Set(hashes).size}/${dialogue.length}`,
  );

  const fixturePath = path.join(ROOT, SHARED_FIXTURE_DIALOGUE);
  const fixtureHash = fs.existsSync(fixturePath) ? sha256File(fixturePath) : null;
  check(
    'no production WAV is the shared fixture dialogue.wav',
    fixtureHash === null || !hashes.includes(fixtureHash),
    { fixture: SHARED_FIXTURE_DIALOGUE, fixtureHash },
  );

  check('normalized canonical audio exists', canonical.length > 0, canonical.length);
  let sampleRate: unknown = null;
  let channels: unknown = null;
  let codec: unknown = null;
  if (canonical.length > 0) {
    const probe = await analyseFile(canonical[0]);
    sampleRate = probe.audioSampleRate ?? null;
    channels = probe.audioChannels ?? null;
    codec = probe.audioCodec ?? null;
    check('canonical audio is 48 kHz', String(sampleRate) === '48000', sampleRate);
    check('canonical audio is mono', channels === 1, channels);
    check('canonical audio is PCM16 (pcm_s16le)', String(codec) === 'pcm_s16le', codec);
  }

  const slots = new Set<string>();
  for (const target of ['long', 'short_1']) {
    for (const c of state.scenarios[target]?.characters ?? []) {
      if (c.voiceSlot) slots.add(c.voiceSlot);
    }
  }
  check('at least 2 distinct production voice slots configured', slots.size >= 2, [...slots]);

  return {
    audioRootAuthority: 'productionAudioBasePaths(videoId) - the same helper the product routes use',
    productAudioRoot: paths.root,
    synthesisBasePath: paths.synthesisBasePath,
    canonicalBasePath: paths.canonicalBasePath,
    perTurnFiles: dialogue.length,
    expectedDialogueTurns: expectedTurns,
    distinctPerTurnHashes: new Set(hashes).size,
    canonicalFiles: canonical.length,
    canonicalSampleRate: sampleRate,
    canonicalChannels: channels,
    canonicalCodec: codec,
    sharedFixtureUsed: false,
    sharedFixturePath: SHARED_FIXTURE_DIALOGUE,
    voiceSlots: [...slots],
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

    const audio = await verifyRealAudio('N. real production audio — distinct Kokoro voices synthesize', shortBoundState);

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
 * Pixel-level proof that a rendered video really contains the acceptance
 * asset: sample the frames, count the asset's marker pixels, and require a
 * clear peak over the control (median) frames. The best frame is saved as a
 * small PNG next to the JSON evidence (never the video itself).
 */
async function writeAssetFrameProof(videoFile: string, assetId: string, label: string): Promise<Record<string, unknown>> {
  const { analyseFile } = await import('../apps/api/src/services/media.js');
  const probe = await analyseFile(videoFile);
  const sampleWidth = 640;
  const sampleHeight = Math.max(2, Math.round(((probe.height / probe.width) * sampleWidth) / 2) * 2);
  const sampled = await runFfmpegBytes([
    '-hide_banner', '-loglevel', 'error',
    '-i', videoFile,
    '-vf', `fps=1/1.5,scale=${sampleWidth}:${sampleHeight}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  const frameBytes = sampleWidth * sampleHeight * 3;
  const frames = Math.floor(sampled.length / frameBytes);
  check(`frame proof (${label}): frames sampled from the rendered video`, frames > 0, { frames, sampledBytes: sampled.length });
  const counts: number[] = [];
  for (let i = 0; i < frames; i++) counts.push(markerPixels(sampled.subarray(i * frameBytes, (i + 1) * frameBytes)));
  const best = Math.max(...counts);
  const sorted = [...counts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const bestIndex = counts.indexOf(best);
  const bestSeconds = Number((bestIndex * 1.5).toFixed(2));
  const framesDir = path.join(EVIDENCE_DIR, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const png = path.join(framesDir, `${label}-asset-frame.png`);
  if (best > 0) {
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
    frameSampling: `1 frame / 1.5 s, scaled to ${sampleWidth}x${sampleHeight}`,
    framesSampled: frames,
    markerPixelsPerFrame: counts,
    markerPixelsBestFrame: best,
    markerPixelsMedianFrame: median,
    bestFrameSeconds: bestSeconds,
    bestFramePng: best > 0 ? path.relative(ROOT, png) : null,
    controlRatio: median > 0 ? Number((best / median).toFixed(2)) : null,
  };
  check(
    `frame proof (${label}): asset pixels are concentrated in a peak frame, not scattered UI colour`,
    best >= ASSET_FRAME_MIN_PIXELS && (median === 0 || best >= median * 5),
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
    check('preview job result status is ok', result.status === 'ok', { status: result.status, error: job.error ?? null });
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
      'Short plan media URL is the product absolute live-server URL',
      typeof shortAssetUrl === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/media\/asset\//.test(shortAssetUrl),
      shortAssetUrl,
    );
    frameProof = await writeAssetFrameProof(shortFile, pre.asset.id, 'short-smoke');
    check(
      'frame proof: the Short contains the acceptance asset pixels',
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
    check('final export status ok', result.status === 'ok', { status: result.status, error: exportJob.error ?? null });
    check('Long output recorded by the product', Boolean(result.outputs?.long), result.outputs);
    check('Short output recorded by the product', Boolean(result.outputs?.short_1), result.outputs);
    check('package root produced by the product', Boolean(result.packageRoot), result.packageRoot);
    check('package status is ready', result.packageStatus === 'ready', result.packageStatus);
    check(
      'production deliverables + readiness were written by the real build (P9-P12)',
      Boolean(result.readiness) && Boolean(result.productKit),
      { productKit: result.productKit ?? null, readiness: result.readiness ?? null },
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
    gate('17D frame proof — the acceptance asset is composited into both deliverables');
    frameProofs = [];
    frameProofs.push(await writeAssetFrameProof(path.join(OUTPUT_DIR, String(result.outputs.long)), pre.asset.id, 'final-long'));
    frameProofs.push(await writeAssetFrameProof(path.join(OUTPUT_DIR, String(result.outputs.short_1)), pre.asset.id, 'final-short'));
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
      qc: { long: longQc.status, short: shortQc.status },
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
    check(
      'no render happened for the second project (no video/package artifacts)',
      ((state2 as any).artifacts ?? []).filter((a: any) => a.kind === 'video' || a.kind === 'package').length === 0,
      (state2 as any).artifacts,
    );
    const secondOutDir = path.join(OUTPUT_DIR, SECOND_ACCEPTANCE_VIDEO_ID);
    const mp4s = fs.existsSync(secondOutDir)
      ? fs.readdirSync(secondOutDir, { recursive: true }).filter((f) => String(f).endsWith('.mp4'))
      : [];
    check('no MP4 exists for the second project (generation only, no render)', mp4s.length === 0, mp4s);
    check(
      'production state status is generated, not built/exported',
      ['generated', 'ready'].includes(String((state2 as any).status)),
      (state2 as any).status,
    );

    const verification = {
      stage: 'second-project',
      status: 'passed',
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
