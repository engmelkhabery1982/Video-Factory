/**
 * Opt-in production adapter for the existing local stable-diffusion.cpp sd-cli.
 * No download, provisioning, provider, shell command or new engine is involved.
 * Startup registers it only after its files, model pin and actual `-h` flags pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Asset } from '@buildtrack/core';
import { ASSETS_DIR, DATA_DIR } from './platform.js';
import { cachedFileSha256 } from './file-hash.js';
import { loadAssetIndex, readWritableAssetIndex, saveAssetIndex } from '../routes/assets.js';
import { validatePng } from './local-image.js';
import {
  maskedCorrectionResultSource,
  setMaskedCorrectionRunner,
  type MaskedCorrectionJob,
  type MaskedCorrectionRunner,
  type MaskedCorrectionRunnerContext,
} from './masked-correction.js';
import {
  SD_CLI_INPAINT_COMMIT,
  SD_CLI_INPAINT_DEFAULT_NEGATIVE_PROMPT,
  SD_CLI_INPAINT_MODEL_LICENSE,
  SD_CLI_INPAINT_MODELS,
  SD_CLI_INPAINT_PROJECT,
  SD_CLI_INPAINT_RELEASE,
  SD_CLI_INPAINT_REQUIRED_FLAGS,
  encodeSdCliMaskPng,
  sdCliInpaintArguments,
} from './masked-correction-sd-cli-contract.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const FIXTURE_RUNNER = 'tests/fixtures/fake-sd-cli.mjs';

export interface SdCliMaskedCorrectionConfig {
  enabled: boolean;
  runnerPath: string | null;
  modelPath: string | null;
  modelSha256: string | null;
  steps: number;
  timeoutMs: number;
  strength: number;
  cfgScale: number;
  root: string;
}

function integerEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function numberEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function readSdCliMaskedCorrectionConfig(env: NodeJS.ProcessEnv, defaultRoot = DATA_DIR): SdCliMaskedCorrectionConfig {
  return {
    enabled: env.MASKED_CORRECTION_ENABLED === '1',
    // The existing SD CLI may be shared; the inpainting model and enable gate are deliberately separate.
    runnerPath: env.MASKED_CORRECTION_RUNNER?.trim() || env.LOCAL_IMAGE_RUNNER?.trim() || null,
    modelPath: env.MASKED_CORRECTION_MODEL?.trim() || null,
    modelSha256: env.MASKED_CORRECTION_MODEL_SHA256?.trim().toLowerCase() || null,
    steps: integerEnv(env.MASKED_CORRECTION_STEPS, 20, 4, 40),
    timeoutMs: integerEnv(env.MASKED_CORRECTION_TIMEOUT_SEC, 900, 60, 900) * 1000,
    strength: numberEnv(env.MASKED_CORRECTION_STRENGTH, 1, 0.05, 1),
    cfgScale: numberEnv(env.MASKED_CORRECTION_CFG_SCALE, 7.5, 1, 30),
    root: env.MASKED_CORRECTION_ROOT?.trim() || path.join(defaultRoot, 'factory', 'masked-corrections', 'sd-cli'),
  };
}

function isFixtureRunner(runnerPath: string | null): boolean {
  return Boolean(process.env.VITEST && runnerPath && path.resolve(runnerPath) === path.resolve(FIXTURE_RUNNER));
}

function runnerCommand(runnerPath: string, args: string[]): [string, string[]] {
  // Windows cannot execute a Node shebang. This branch exists only inside Vitest.
  if (isFixtureRunner(runnerPath)) return [process.execPath, [runnerPath, ...args]];
  return [runnerPath, args];
}

function regularFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

const SCRATCH_KIND = 'vf-sd-cli-scratch-v1';
const SCRATCH_NAME = /^mc-[a-f0-9]{24}-[a-f0-9]{32}$/;

function unlinkedPath(candidate: string): boolean {
  let current = path.resolve(candidate);
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) return false; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

/** Remove only an owned, marked run below the exact scratch root, never the work root itself. */
function cleanupOwnedRun(root: string, name: string): void {
  if (!SCRATCH_NAME.test(name)) return;
  const work = path.resolve(root, 'work');
  const run = path.resolve(work, name);
  if (!run.startsWith(work + path.sep) || !unlinkedPath(run)) return;
  const markerFile = path.join(run, 'scratch-owner.json');
  try {
    const stat = fs.lstatSync(markerFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) return;
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    if (!marker || typeof marker !== 'object' || marker.kind !== SCRATCH_KIND || `${marker.jobId}-${marker.runId}` !== name) return;
    fs.rmSync(run, { recursive: true, force: true });
  } catch (err) {
    if (!(err instanceof SyntaxError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function cleanupOwnedScratch(root: string): void {
  const work = path.resolve(root, 'work');
  if (!unlinkedPath(work) || !fs.existsSync(work)) return;
  for (const entry of fs.readdirSync(work, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) cleanupOwnedRun(root, entry.name);
  }
}

function probeHelp(runnerPath: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let output = '';
    let child: ChildProcess;
    try {
      child = spawn(...runnerCommand(runnerPath, ['-h']), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, error: 'the runner could not be started' });
      return;
    }
    let settled = false;
    const finish = (result: { ok: true; text: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'the runner did not answer -h within 15 seconds' });
    }, 15_000);
    const onData = (chunk: Buffer) => { if (output.length < 65_536) output += chunk.toString(); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => finish({ ok: false, error: 'the runner could not be started' }));
    child.on('close', () => finish(output.trim()
      ? { ok: true, text: output }
      : { ok: false, error: 'the runner printed no help text' }));
  });
}

function helpHasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,|\\[])${escaped}(?=[\\s,=\\]|]|$)`, 'm').test(help);
}

export interface SdCliMaskedCorrectionProbe {
  ready: boolean;
  missing: string[];
  flagsChecked: readonly string[];
  flagsMissing: string[];
  modelSha256Matches: boolean | null;
  model: { name: string; license: string; expectedUpstreamArtifact: boolean };
  project: string;
  interfaceRelease: string;
  interfaceCommit: string;
  googleUsed: false;
  paidSpend: false;
  fixture: boolean;
}

let helpCache: { key: string; at: number; result: { ok: true; text: string } | { ok: false; error: string } } | null = null;

export async function probeSdCliMaskedCorrection(cfg: SdCliMaskedCorrectionConfig): Promise<SdCliMaskedCorrectionProbe> {
  const missing: string[] = [];
  const fixture = isFixtureRunner(cfg.runnerPath);
  if (!cfg.enabled) missing.push('MASKED_CORRECTION_ENABLED=1 is not set. Masked correction is off.');
  if (!unlinkedPath(path.resolve(cfg.root, 'work'))) missing.push('The scratch root must not contain symbolic links or junctions.');

  let runnerOk = false;
  if (!cfg.runnerPath) missing.push('MASKED_CORRECTION_RUNNER is not set (or reuse LOCAL_IMAGE_RUNNER for the existing sd-cli).');
  else if (!regularFile(cfg.runnerPath)) missing.push('The masked-correction sd-cli runner is missing or not a regular non-symlink file.');
  else runnerOk = true;

  let modelOk = false;
  if (!cfg.modelPath) missing.push('MASKED_CORRECTION_MODEL is not set (the separate SD 1.5 inpainting weights, outside Git).');
  else if (!regularFile(cfg.modelPath)) missing.push('The MASKED_CORRECTION_MODEL file is missing or not a regular non-symlink file.');
  else modelOk = true;

  const expectedArtifact = Boolean(cfg.modelSha256 && SD_CLI_INPAINT_MODELS.some((model) => model.sha256 === cfg.modelSha256));
  if (!fixture && !expectedArtifact) {
    missing.push('MASKED_CORRECTION_MODEL_SHA256 must identify one of the two exact SD 1.5 inpainting artifacts in the engine decision sheet.');
  }
  if (!cfg.modelSha256 || !SHA256_RE.test(cfg.modelSha256)) {
    missing.push('MASKED_CORRECTION_MODEL_SHA256 must be the lowercase SHA-256 of the inpainting weights.');
  }

  let modelSha256Matches: boolean | null = null;
  if (modelOk && cfg.modelPath && cfg.modelSha256 && SHA256_RE.test(cfg.modelSha256)) {
    try {
      modelSha256Matches = await cachedFileSha256(cfg.modelPath) === cfg.modelSha256;
      if (!modelSha256Matches) missing.push('The inpainting model bytes do not match MASKED_CORRECTION_MODEL_SHA256.');
    } catch {
      modelSha256Matches = false;
      missing.push('The inpainting model could not be hashed.');
    }
  }

  let flagsMissing: string[] = [];
  if (runnerOk && cfg.runnerPath) {
    const stat = fs.statSync(cfg.runnerPath);
    const key = `${path.resolve(cfg.runnerPath)}:${stat.size}:${stat.mtimeMs}`;
    if (!helpCache || helpCache.key !== key || Date.now() - helpCache.at > 60_000) {
      helpCache = { key, at: Date.now(), result: await probeHelp(cfg.runnerPath) };
    }
    const help = helpCache.result;
    if (!help.ok) {
      flagsMissing = [...SD_CLI_INPAINT_REQUIRED_FLAGS];
      missing.push(`Runner probe failed: ${help.error}.`);
    } else {
      flagsMissing = SD_CLI_INPAINT_REQUIRED_FLAGS.filter((flag) => !helpHasFlag(help.text, flag));
      if (flagsMissing.length > 0) missing.push(`This sd-cli build does not list the required inpainting flags: ${flagsMissing.join(', ')}.`);
    }
  }

  return {
    ready: missing.length === 0,
    missing,
    flagsChecked: SD_CLI_INPAINT_REQUIRED_FLAGS,
    flagsMissing,
    modelSha256Matches,
    model: {
      name: cfg.modelPath ? path.basename(cfg.modelPath) : 'SD 1.5 inpainting',
      license: SD_CLI_INPAINT_MODEL_LICENSE,
      expectedUpstreamArtifact: fixture ? false : expectedArtifact,
    },
    project: SD_CLI_INPAINT_PROJECT,
    interfaceRelease: SD_CLI_INPAINT_RELEASE,
    interfaceCommit: SD_CLI_INPAINT_COMMIT,
    googleUsed: false,
    paidSpend: false,
    fixture,
  };
}

function abortError(): Error {
  return Object.assign(new Error('The masked-correction sd-cli process was cancelled. No result was imported.'), { name: 'AbortError' });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function hashBytes(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assetWithId(id: string): Asset | undefined {
  return loadAssetIndex().find((asset) => asset.id === id);
}

/** Canonical, run-specific asset import. Existing original bytes/index entries are never overwritten. */
function importResultAsset(
  job: MaskedCorrectionJob,
  bytes: Buffer,
  details: { seed: number; steps: number; strength: number; cfgScale: number; maskPngSha256: string; modelPath: string; modelSha256: string },
): { resultAssetId: string; resultHash: string } {
  const resultHash = hashBytes(bytes);
  if (resultHash === job.originalHash) {
    throw new Error('The sd-cli result is byte-identical to the original. No corrected asset was imported.');
  }
  const resultAssetId = `mc_${job.id.slice(3)}_${job.runId.slice(0, 12)}`;
  const fileName = `${resultAssetId}.png`;
  const file = path.join(ASSETS_DIR, fileName);
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  let createdFile = false;
  try {
    if (fs.existsSync(file)) {
      if (!regularFile(file) || hashBytes(fs.readFileSync(file)) !== resultHash) {
        throw new Error('The run-specific result path already exists with different bytes. Import was refused.');
      }
    } else {
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, bytes, { flag: 'wx' });
        // Atomic no-overwrite publication on the same asset volume.
        fs.linkSync(tmp, file);
        createdFile = true;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }

    const existing = assetWithId(resultAssetId) as (Asset & { provenance?: unknown }) | undefined;
    if (existing) {
      const provenanceMatches = existing.sha256 === resultHash
        && existing.source === maskedCorrectionResultSource(job)
        && existing.tags.includes('factory')
        && existing.tags.includes('masked-correction-result');
      if (!provenanceMatches) throw new Error('The run-specific asset id already has different provenance. Import was refused.');
      return { resultAssetId, resultHash };
    }

    const record: Asset & { provenance?: Record<string, unknown> } = {
      id: resultAssetId,
      name: `Masked correction ${job.id} / ${job.runId.slice(0, 8)}`,
      kind: 'broll',
      fileName,
      path: fileName,
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      sha256: resultHash,
      width: job.original.width,
      height: job.original.height,
      tags: ['factory', 'masked-correction-result', 'generated-locally', 'still'],
      status: 'active',
      preferred: false,
      source: maskedCorrectionResultSource(job),
      license: `Generated locally from ${SD_CLI_INPAINT_MODEL_LICENSE} inpainting weights. Owner visual review required before publication.`,
      addedAt: new Date().toISOString(),
      usedIn: [],
      blocked: false,
      provenance: {
        kind: 'vf-sd-cli-masked-correction-v1',
        project: SD_CLI_INPAINT_PROJECT,
        interfaceRelease: SD_CLI_INPAINT_RELEASE,
        interfaceCommit: SD_CLI_INPAINT_COMMIT,
        jobId: job.id,
        runId: job.runId,
        draftId: job.draftId,
        sceneId: job.sceneId,
        originalAssetId: job.originalAssetId,
        originalSha256: job.originalHash,
        maskSha256: job.maskHash,
        maskPngSha256: details.maskPngSha256,
        resultSha256: resultHash,
        modelName: path.basename(details.modelPath),
        modelSha256: details.modelSha256,
        modelLicense: SD_CLI_INPAINT_MODEL_LICENSE,
        promptSha256: crypto.createHash('sha256').update(job.parameters.instructions ?? '').digest('hex'),
        negativePromptSha256: crypto.createHash('sha256').update(SD_CLI_INPAINT_DEFAULT_NEGATIVE_PROMPT).digest('hex'),
        seed: details.seed,
        steps: details.steps,
        strength: details.strength,
        cfgScale: details.cfgScale,
        width: job.original.width,
        height: job.original.height,
        generatedAt: new Date().toISOString(),
        googleUsed: false,
        paidSpend: false,
      },
    };
    const index = readWritableAssetIndex();
    if (index.some((asset) => asset.id === resultAssetId)) throw new Error('The asset index changed during import. Retry verification instead of overwriting it.');
    saveAssetIndex([...index, record]);
    return { resultAssetId, resultHash };
  } catch (err) {
    if (createdFile) fs.rmSync(file, { force: true });
    throw err;
  }
}

export function createSdCliMaskedCorrectionRunner(cfg: SdCliMaskedCorrectionConfig): MaskedCorrectionRunner {
  const fixture = isFixtureRunner(cfg.runnerPath);
  if (path.resolve(cfg.runnerPath ?? '') === path.resolve(FIXTURE_RUNNER) && !fixture) {
    throw new Error('The fake sd-cli fixture cannot be registered outside Vitest.');
  }
  const id = fixture ? 'labelled-fake-sd-cli-inpainting' : 'local-sd-cli-inpainting';
  const version = fixture ? 'fixture-1' : `flags-${SD_CLI_INPAINT_RELEASE}`;
  return {
    id,
    version,
    fixture,
    timeoutMs: cfg.timeoutMs,
    description: fixture
      ? 'Labelled fake sd-cli fixture is configured for tests only. This is not real inpainting.'
      : `Verified local sd-cli inpainting interface ${SD_CLI_INPAINT_RELEASE}; model SHA-256 and required flags checked at registration and before each run. No generation is claimed until a job completes.`,
    async run(job: Readonly<MaskedCorrectionJob>, context: MaskedCorrectionRunnerContext) {
      throwIfAborted(context.signal);
      if (job.runner.id !== id || job.runner.version !== version || job.runner.fixture !== fixture) {
        throw new Error('The frozen job runner identity does not match this sd-cli adapter. Retry with the current runner.');
      }
      if (hashBytes(context.originalBytes) !== job.originalHash) {
        throw new Error('The frozen original bytes do not match the job hash. The runner was not started.');
      }
      const prompt = job.parameters.instructions?.trim() ?? '';
      if (!prompt) throw new Error('A concrete correction instruction is required for sd-cli inpainting.');
      const probe = await probeSdCliMaskedCorrection(cfg);
      throwIfAborted(context.signal);
      if (!probe.ready) throw new Error(`The sd-cli inpainting setup is no longer ready: ${probe.missing[0]}`);
      if (!cfg.runnerPath || !cfg.modelPath || !cfg.modelSha256) throw new Error('The sd-cli inpainting configuration is incomplete.');

      const workDir = path.join(cfg.root, 'work', `${job.id}-${job.runId}`);
      const initPath = path.join(workDir, job.original.mimeType === 'image/jpeg' ? 'original.jpg' : 'original.png');
      const maskPath = path.join(workDir, 'mask.png');
      const outputPath = path.join(workDir, 'result.png');
      if (!unlinkedPath(workDir)) throw new Error('Unsafe linked scratch path. The runner was not started.');
      fs.mkdirSync(path.dirname(workDir), { recursive: true });
      fs.mkdirSync(workDir, { recursive: false, mode: 0o700 });
      let child: ChildProcess | null = null;
      const onAbort = () => { child?.kill('SIGKILL'); };
      try {
        fs.writeFileSync(path.join(workDir, 'scratch-owner.json'), JSON.stringify({ kind: SCRATCH_KIND, jobId: job.id, runId: job.runId }), { flag: 'wx' });
        // Run against frozen bytes, not a library pathname that could change during generation.
        fs.writeFileSync(initPath, context.originalBytes, { flag: 'wx' });
        const maskBytes = encodeSdCliMaskPng(context.mask);
        fs.writeFileSync(maskPath, maskBytes, { flag: 'wx' });
        const seed = crypto.randomInt(1, 2_147_483_647);
        const args = sdCliInpaintArguments({
          modelPath: cfg.modelPath,
          prompt,
          negativePrompt: SD_CLI_INPAINT_DEFAULT_NEGATIVE_PROMPT,
          initPath,
          maskPath,
          outputPath,
          width: job.original.width,
          height: job.original.height,
          seed,
          steps: cfg.steps,
          strength: cfg.strength,
          cfgScale: cfg.cfgScale,
        });
        context.signal.addEventListener('abort', onAbort, { once: true });
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            if (err) reject(err); else resolve();
          };
          let spawned: ChildProcess;
          try {
            spawned = spawn(...runnerCommand(cfg.runnerPath as string, args), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            child = spawned;
          } catch {
            finish(new Error('The sd-cli inpainting runner could not be started.'));
            return;
          }
          // Drain both streams so a verbose runner cannot block on a full pipe.
          // Diagnostics stay in this bounded closure and are never returned with host paths.
          let stderrTail = '';
          const onData = (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-2000); };
          spawned.stdout?.on('data', onData);
          spawned.stderr?.on('data', onData);
          spawned.on('error', () => finish(new Error('The sd-cli inpainting runner could not be started.')));
          spawned.on('close', (code) => {
            if (context.signal.aborted) finish(abortError());
            else if (code !== 0) finish(new Error(`The sd-cli inpainting runner exited with code ${code ?? 'unknown'}. No result was imported.`));
            else finish();
          });
        });
        throwIfAborted(context.signal);
        if (!regularFile(outputPath)) throw new Error('The sd-cli runner finished without a regular PNG result. Nothing was imported.');
        const stat = fs.lstatSync(outputPath);
        if (stat.size <= 0 || stat.size > MAX_OUTPUT_BYTES) throw new Error('The sd-cli result exceeds the bounded output size. Nothing was imported.');
        const bytes = fs.readFileSync(outputPath);
        validatePng(bytes, job.original.width, job.original.height);
        throwIfAborted(context.signal);
        const imported = importResultAsset(job as MaskedCorrectionJob, bytes, {
          seed,
          steps: cfg.steps,
          strength: cfg.strength,
          cfgScale: cfg.cfgScale,
          maskPngSha256: hashBytes(maskBytes),
          modelPath: cfg.modelPath,
          modelSha256: cfg.modelSha256,
        });
        throwIfAborted(context.signal);
        return imported;
      } finally {
        context.signal.removeEventListener('abort', onAbort);
        child = null;
        // Inputs, mask and unimported scratch output are disposable. The canonical result is in ASSETS_DIR.
        cleanupOwnedRun(cfg.root, path.basename(workDir));
      }
    },
  };
}

export interface SdCliRegistrationResult {
  ready: boolean;
  reason: string;
  missing: string[];
  runner: { id: string; version: string; fixture: boolean } | null;
}

/** Called once by the real server. Invalid/partial opt-in config stays visibly unconfigured. */
export async function configureSdCliMaskedCorrection(
  env: NodeJS.ProcessEnv = process.env,
  defaultRoot = DATA_DIR,
): Promise<SdCliRegistrationResult> {
  const cfg = readSdCliMaskedCorrectionConfig(env, defaultRoot);
  // This directory contains only frozen per-run inputs/masks/unimported output.
  // Canonical imported results live in ASSETS_DIR and are never removed here.
  // setMaskedCorrectionRunner is deliberately first: its busy guard prevents
  // a configuration call from deleting an active process's frozen inputs.
  const cleanupScratch = () => cleanupOwnedScratch(cfg.root);
  if (!cfg.enabled) {
    setMaskedCorrectionRunner(null);
    cleanupScratch();
    return { ready: false, reason: 'No masked correction runner configured. Set MASKED_CORRECTION_ENABLED=1 only after the separate inpainting model is authorized and present.', missing: [], runner: null };
  }
  const probe = await probeSdCliMaskedCorrection(cfg);
  if (!probe.ready) {
    const reason = `Masked correction setup is incomplete: ${probe.missing[0]}`;
    setMaskedCorrectionRunner(null, { reason, missing: probe.missing });
    cleanupScratch();
    return { ready: false, reason, missing: probe.missing, runner: null };
  }
  const runner = createSdCliMaskedCorrectionRunner(cfg);
  setMaskedCorrectionRunner(runner);
  cleanupScratch();
  const provenance = { id: runner.id ?? 'configured-local-runner', version: runner.version ?? 'unversioned', fixture: runner.fixture === true };
  const reason = runner.fixture
    ? 'Labelled fake sd-cli fixture is configured for tests only. This is not real inpainting.'
    : `Verified local sd-cli inpainting interface ${SD_CLI_INPAINT_RELEASE}; model SHA-256 and required flags checked. No generation has run yet.`;
  return { ready: true, reason, missing: [], runner: provenance };
}

export function resetSdCliMaskedCorrectionProbeForTests(): void {
  helpCache = null;
}
