/**
 * Phase 6E — Dedicated Full Production Evidence Runner
 *
 * Manual closure evidence, NOT run under normal npm test.
 * Supports resumability, background rendering, checkpointing.
 *
 * Usage:
 *   npm run evidence:phase6e
 *   node --import tsx scripts/phase6e-full-production-evidence.ts
 *   node --import tsx scripts/phase6e-full-production-evidence.ts --status
 *   node --import tsx scripts/phase6e-full-production-evidence.ts --internal-render-long
 *   node --import tsx scripts/phase6e-full-production-evidence.ts --internal-render-short
 *
 * Runtime state: .stills/phase6e/
 *   state.json, long-render.log, short-render.log, long.pid, short.pid,
 *   long.mp4, short.mp4, package/, package-rebuild/, runtime-evidence/
 *
 * Committed evidence: EVIDENCE/phase6e/
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  compileScenarioVisualPlan,
  getProgressMeetingScenario,
  loadScenarioFixture,
  resolveProductionAssets,
  buildProductionDeliveryTargets,
  buildDialogueProductionPlan,
  buildVisualProductionPlan,
  buildSceneRenderPlan,
  buildRemotionCompositionProps,
  type RemotionCompositionPlan,
  type Scenario,
} from '@buildtrack/core';
import { renderCompositionPlan } from '../apps/api/src/services/render.js';
import { analyseFile } from '../apps/api/src/services/media.js';
import { buildProductionDeliveryPackage as buildPackageService } from '../apps/api/src/services/plan-package.js';
import { ffmpegPath, chromePath } from '../apps/api/src/services/platform.js';
import {
  CANONICAL_LONG_ASSET_REF,
  CANONICAL_PROJECT_ID,
  CANONICAL_LONG_SCENARIO_ID,
  CANONICAL_SHORT_SCENARIO_ID,
  CANONICAL_SCENE_ID,
  CANONICAL_RENDERER_KEY,
  createCanonicalAssetRecord,
} from '../apps/api/src/services/plan-production.js';

const REPO_ROOT = process.cwd();
const BASELINE = 'e308e9cf303c97f89d87fc6bcd5caec8785b4784';
const STILLS_DIR = path.join(REPO_ROOT, '.stills', 'phase6e');
const STATE_FILE = path.join(STILLS_DIR, 'state.json');
const LONG_MP4 = path.join(STILLS_DIR, 'long.mp4');
const SHORT_MP4 = path.join(STILLS_DIR, 'short.mp4');
const LONG_LOG = path.join(STILLS_DIR, 'long-render.log');
const SHORT_LOG = path.join(STILLS_DIR, 'short-render.log');
const LONG_PID = path.join(STILLS_DIR, 'long.pid');
const SHORT_PID = path.join(STILLS_DIR, 'short.pid');
const PACKAGE_ROOT = path.join(STILLS_DIR, 'package');
const PACKAGE_REBUILD_ROOT = path.join(STILLS_DIR, 'package-rebuild');
const RUNTIME_EVIDENCE_DIR = path.join(STILLS_DIR, 'runtime-evidence');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'EVIDENCE', 'phase6e');
const FIXTURE_RENDER_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'render');

interface Phase6EState {
  baseline: string;
  implementationHead: string | null;
  long: {
    status: 'not_started' | 'running' | 'success' | 'failed';
    pid: number | null;
    outputFile: string;
    started: boolean;
    verified: boolean;
    renderResultFile?: string;
  };
  short: {
    status: 'not_started' | 'running' | 'success' | 'failed';
    pid: number | null;
    outputFile: string;
    started: boolean;
    verified: boolean;
    renderResultFile?: string;
  };
  package: {
    status: 'not_started' | 'success' | 'failed';
  };
}

function ensureDirs() {
  fs.mkdirSync(STILLS_DIR, { recursive: true });
  fs.mkdirSync(RUNTIME_EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

function getImplementationHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function readState(): Phase6EState {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      baseline: BASELINE,
      implementationHead: getImplementationHead(),
      long: { status: 'not_started', pid: null, outputFile: LONG_MP4, started: false, verified: false },
      short: { status: 'not_started', pid: null, outputFile: SHORT_MP4, started: false, verified: false },
      package: { status: 'not_started' },
    };
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Phase6EState;
    // Ensure baseline is correct
    parsed.baseline = BASELINE;
    if (!parsed.implementationHead) parsed.implementationHead = getImplementationHead();
    return parsed;
  } catch {
    return {
      baseline: BASELINE,
      implementationHead: getImplementationHead(),
      long: { status: 'not_started', pid: null, outputFile: LONG_MP4, started: false, verified: false },
      short: { status: 'not_started', pid: null, outputFile: SHORT_MP4, started: false, verified: false },
      package: { status: 'not_started' },
    };
  }
}

function writeState(state: Phase6EState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function readPidFile(file: string): number | null {
  try {
    if (!fs.existsSync(file)) return null;
    const txt = fs.readFileSync(file, 'utf8').trim();
    const pid = parseInt(txt, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(file: string, pid: number) {
  fs.writeFileSync(file, String(pid), 'utf8');
}

function isPidAlive(pid: number | null): boolean {
  if (pid === null || pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sha256FileSync(file: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

async function probeMedia(file: string) {
  return await analyseFile(file);
}

function logToFile(file: string, msg: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, 'utf8');
}

/* ------------------------------------------------------------------ */
/*  Plan building (approved pipeline)                                  */
/* ------------------------------------------------------------------ */

let planSeq = 0;
async function buildPlan(scenario: Scenario): Promise<RemotionCompositionPlan> {
  const tag = `phase6e-${++planSeq}-${Date.now()}`;
  const audioScratch = path.join('.test-phase6e', 'audio', tag);
  fs.mkdirSync(audioScratch, { recursive: true });

  const visual: any = compileScenarioVisualPlan(scenario);
  if (!visual.ok) throw new Error(`compileScenarioVisualPlan failed: ${JSON.stringify(visual.errors)}`);

  const dialogue: any = await buildDialogueProductionPlan(scenario, {
    synthesisBasePath: path.join(audioScratch, 'audio', 'dialogue'),
    canonicalBasePath: path.join(audioScratch, 'audio', 'canonical'),
  });
  if (!dialogue.success) throw new Error(`buildDialogueProductionPlan failed: ${dialogue.error}`);

  const visualProd: any = buildVisualProductionPlan({
    scenario,
    visualPlan: visual.plan,
    dialogueResult: dialogue.result,
  });
  if (!visualProd.success) throw new Error(`buildVisualProductionPlan failed: ${visualProd.error}`);

  const sceneRender: any = buildSceneRenderPlan({
    scenario,
    visualProductionPlan: visualProd.plan,
  });
  if (!sceneRender.success) throw new Error(`buildSceneRenderPlan failed: ${sceneRender.error}`);

  const remotion: any = buildRemotionCompositionProps(sceneRender.plan);
  if (!remotion.success) throw new Error(`buildRemotionCompositionProps failed: ${remotion.error}`);

  return remotion.plan as RemotionCompositionPlan;
}

function buildLongScenario(): Scenario {
  const base = getProgressMeetingScenario();
  const cloned = structuredClone(base) as Scenario;
  cloned.metadata.id = CANONICAL_LONG_SCENARIO_ID;
  cloned.metadata.projectId = CANONICAL_PROJECT_ID;
  cloned.metadata.targetFormat = 'Long';
  return cloned;
}

function buildShortScenario(): Scenario {
  const base = loadScenarioFixture('schedule-risk');
  const cloned = structuredClone(base) as Scenario;
  cloned.metadata = {
    ...cloned.metadata,
    id: CANONICAL_SHORT_SCENARIO_ID,
    projectId: CANONICAL_PROJECT_ID,
    targetFormat: 'Short',
  };
  return cloned;
}

function toRenderableAudioUrl(audioRef: { clipId: string }, baseUrl: string): string {
  return `${baseUrl}/dialogue.wav?clip=${encodeURIComponent(audioRef.clipId)}`;
}

function withRenderableAudio(plan: RemotionCompositionPlan, baseUrl: string): RemotionCompositionPlan {
  return {
    ...plan,
    scenes: plan.scenes.map((scene) => ({
      ...scene,
      audioRefs: scene.audioRefs.map((a) => ({ ...a, canonicalPath: toRenderableAudioUrl(a, baseUrl) })),
    })),
  };
}

async function startLocalServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav' };
  const server = http.createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const name = path.basename(rawPath);
    const file = path.join(FIXTURE_RENDER_DIR, name);
    // Security: ensure file is inside fixture dir
    if (path.dirname(file) !== FIXTURE_RENDER_DIR || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', mime[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? (address as any).port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* ------------------------------------------------------------------ */
/*  Validation helpers                                                 */
/* ------------------------------------------------------------------ */

async function validateLongOutput(file: string): Promise<{ valid: boolean; reason?: string; probe?: any }> {
  if (!fs.existsSync(file)) return { valid: false, reason: 'file does not exist' };
  const stat = fs.statSync(file);
  if (stat.size === 0) return { valid: false, reason: 'file size zero' };
  try {
    const probe = await analyseFile(file);
    if (probe.width !== 1920 || probe.height !== 1080) return { valid: false, reason: `dimensions ${probe.width}x${probe.height} expected 1920x1080`, probe };
    const fps = probe.r_frame_rate;
    // fps should be 30/1 or ~30
    const fpsVal = fps === '30/1' ? 30 : parseFloat(fps.split('/')[0]) / parseFloat(fps.split('/')[1] || '1');
    if (Math.abs(fpsVal - 30) > 0.1) return { valid: false, reason: `fps ${fps} not ~30`, probe };
    if (!probe.codec_name || !['h264', 'avc'].includes(probe.codec_name.toLowerCase())) {
      // H.264 family includes h264, avc
      if (!probe.codec_name?.toLowerCase().includes('h264') && !probe.codec_name?.toLowerCase().includes('avc')) {
        return { valid: false, reason: `video codec ${probe.codec_name} not h264-family`, probe };
      }
    }
    if (!probe.hasAudio) return { valid: false, reason: 'no audio stream', probe };
    if (!probe.audioCodec || !['aac'].includes(probe.audioCodec.toLowerCase())) {
      if (!probe.audioCodec?.toLowerCase().includes('aac')) {
        return { valid: false, reason: `audio codec ${probe.audioCodec} not aac-family`, probe };
      }
    }
    // Duration covers 118.74 authoritative seconds, allow small tolerance for container
    if (probe.duration < 118.74 - 0.5) return { valid: false, reason: `duration ${probe.duration} < 118.74`, probe };
    // Check for early truncation: duration should be close to 118.74, not far less
    // For full 3563 frames at 30fps, duration ~118.76
    return { valid: true, probe };
  } catch (e) {
    return { valid: false, reason: `ffprobe failed: ${(e as Error).message}` };
  }
}

async function validateShortOutput(file: string): Promise<{ valid: boolean; reason?: string; probe?: any }> {
  if (!fs.existsSync(file)) return { valid: false, reason: 'file does not exist' };
  const stat = fs.statSync(file);
  if (stat.size === 0) return { valid: false, reason: 'file size zero' };
  try {
    const probe = await analyseFile(file);
    if (probe.width !== 1080 || probe.height !== 1920) return { valid: false, reason: `dimensions ${probe.width}x${probe.height} expected 1080x1920`, probe };
    const fps = probe.r_frame_rate;
    const fpsVal = fps === '30/1' ? 30 : parseFloat(fps.split('/')[0]) / parseFloat(fps.split('/')[1] || '1');
    if (Math.abs(fpsVal - 30) > 0.1) return { valid: false, reason: `fps ${fps} not ~30`, probe };
    if (!probe.codec_name || !['h264', 'avc'].includes(probe.codec_name.toLowerCase())) {
      if (!probe.codec_name?.toLowerCase().includes('h264') && !probe.codec_name?.toLowerCase().includes('avc')) {
        return { valid: false, reason: `video codec ${probe.codec_name} not h264-family`, probe };
      }
    }
    if (!probe.hasAudio) return { valid: false, reason: 'no audio stream', probe };
    if (!probe.audioCodec || !['aac'].includes(probe.audioCodec.toLowerCase())) {
      if (!probe.audioCodec?.toLowerCase().includes('aac')) {
        return { valid: false, reason: `audio codec ${probe.audioCodec} not aac-family`, probe };
      }
    }
    if (probe.duration < 48.99 - 0.5) return { valid: false, reason: `duration ${probe.duration} < 48.99`, probe };
    return { valid: true, probe };
  } catch (e) {
    return { valid: false, reason: `ffprobe failed: ${(e as Error).message}` };
  }
}

/* ------------------------------------------------------------------ */
/*  Internal renderers (run as background processes)                   */
/* ------------------------------------------------------------------ */

async function internalRenderLong() {
  ensureDirs();
  fs.writeFileSync(LONG_LOG, '', 'utf8');
  const log = (msg: string) => {
    console.log(msg);
    logToFile(LONG_LOG, msg);
  };
  log('[phase6e] internal long render starting');
  log(`[phase6e] baseline ${BASELINE}`);
  log(`[phase6e] head ${getImplementationHead()}`);
  log(`[phase6e] pid ${process.pid}`);

  // Check browser
  try {
    const cp = chromePath();
    if (!fs.existsSync(cp)) {
      log(`[phase6e] ERROR: Chromium not found at ${cp}, run npm run provision`);
      process.exit(1);
    }
  } catch (e) {
    log(`[phase6e] ERROR checking chrome: ${(e as Error).message}`);
    process.exit(1);
  }

  const server = await startLocalServer();
  log(`[phase6e] local server ${server.baseUrl}`);

  try {
    const longScenario = buildLongScenario();
    const shortScenario = buildShortScenario(); // needed for target set? but we render only long via direct composition

    log('[phase6e] building long plan...');
    const longPlan = await buildPlan(longScenario);
    log(`[phase6e] long plan built: ${longPlan.durationInFrames} frames, ${longPlan.totalActualDurationSeconds}s, ${longPlan.scenes.length} scenes`);

    // Asset resolution
    const realAsset = createCanonicalAssetRecord();
    const assetUrl = `${server.baseUrl}/progress-chart.png`;
    const report = resolveProductionAssets({
      plan: longPlan,
      assets: [realAsset],
      assetUrlById: { [realAsset.id]: assetUrl },
    });
    log(`[phase6e] asset resolution valid=${report.valid} errorCount=${report.summary.errorCount} usages=${report.summary.totalUsages} unique=${report.summary.totalUniqueLogicalRefs} resolved=${report.summary.totalResolvedUnique}`);
    if (!report.valid || report.summary.errorCount !== 0 || report.summary.totalUsages !== 2 || report.summary.totalUniqueLogicalRefs !== 1 || report.summary.totalResolvedUnique !== 1) {
      log('[phase6e] ERROR: asset resolution invariants failed');
      log(JSON.stringify(report.summary, null, 2));
      await server.close();
      process.exit(1);
    }
    if (report.mediaMap[CANONICAL_LONG_ASSET_REF] !== assetUrl) {
      log('[phase6e] ERROR: mediaMap does not come from resolver');
      await server.close();
      process.exit(1);
    }

    const renderableLong = withRenderableAudio(longPlan, server.baseUrl);
    const mediaMap = report.mediaMap;

    // Validate canonical scene
    const sc02 = renderableLong.scenes.find((s) => s.sceneId === CANONICAL_SCENE_ID);
    if (!sc02) {
      log(`[phase6e] ERROR: missing scene ${CANONICAL_SCENE_ID}`);
      await server.close();
      process.exit(1);
    }
    if (sc02.rendererKey !== CANONICAL_RENDERER_KEY) {
      log(`[phase6e] ERROR: rendererKey ${sc02.rendererKey} != ${CANONICAL_RENDERER_KEY}`);
      await server.close();
      process.exit(1);
    }

    log(`[phase6e] rendering long to ${LONG_MP4} FULL 3563 frames...`);
    const result = await renderCompositionPlan({
      plan: renderableLong,
      outputFile: LONG_MP4,
      mediaMap,
      onProgress: (p, note) => {
        log(`[phase6e] long progress ${(p * 100).toFixed(1)}% ${note ?? ''}`);
      },
    });

    log(`[phase6e] long render result: ${JSON.stringify(result, null, 2)}`);

    if (result.durationInFrames !== 3563) {
      log(`[phase6e] ERROR: durationInFrames ${result.durationInFrames} != 3563`);
      await server.close();
      process.exit(1);
    }
    if (result.renderedFrameCount !== 3563) {
      log(`[phase6e] ERROR: renderedFrameCount ${result.renderedFrameCount} != 3563`);
      await server.close();
      process.exit(1);
    }
    if (result.compositionId !== 'VideoPlan') {
      log(`[phase6e] ERROR: compositionId ${result.compositionId} != VideoPlan`);
      await server.close();
      process.exit(1);
    }

    // Validate output
    const validation = await validateLongOutput(LONG_MP4);
    if (!validation.valid) {
      log(`[phase6e] ERROR: long validation failed: ${validation.reason}`);
      await server.close();
      process.exit(1);
    }
    log(`[phase6e] long validation ok: ${JSON.stringify(validation.probe, null, 2)}`);

    // Save render result for packaging
    fs.writeFileSync(path.join(RUNTIME_EVIDENCE_DIR, 'long_render_result.json'), JSON.stringify(result, null, 2), 'utf8');
    fs.writeFileSync(path.join(RUNTIME_EVIDENCE_DIR, 'long_asset_resolution.json'), JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(path.join(RUNTIME_EVIDENCE_DIR, 'long_media_probe.json'), JSON.stringify(validation.probe, null, 2), 'utf8');

    log('[phase6e] long render SUCCESS');
    await server.close();
    process.exit(0);
  } catch (e) {
    log(`[phase6e] long render FAILED: ${(e as Error).stack || (e as Error).message}`);
    try {
      await server.close();
    } catch {}
    process.exit(1);
  }
}

async function internalRenderShort() {
  ensureDirs();
  fs.writeFileSync(SHORT_LOG, '', 'utf8');
  const log = (msg: string) => {
    console.log(msg);
    logToFile(SHORT_LOG, msg);
  };
  log('[phase6e] internal short render starting');
  log(`[phase6e] baseline ${BASELINE}`);
  log(`[phase6e] head ${getImplementationHead()}`);
  log(`[phase6e] pid ${process.pid}`);

  try {
    const cp = chromePath();
    if (!fs.existsSync(cp)) {
      log(`[phase6e] ERROR: Chromium not found at ${cp}`);
      process.exit(1);
    }
  } catch (e) {
    log(`[phase6e] ERROR checking chrome: ${(e as Error).message}`);
    process.exit(1);
  }

  const server = await startLocalServer();
  log(`[phase6e] local server ${server.baseUrl}`);

  try {
    const shortScenario = buildShortScenario();
    log('[phase6e] building short plan...');
    const shortPlan = await buildPlan(shortScenario);
    log(`[phase6e] short plan built: ${shortPlan.durationInFrames} frames, ${shortPlan.totalActualDurationSeconds}s, ${shortPlan.scenes.length} scenes`);

    if (shortPlan.durationInFrames !== 1470) {
      log(`[phase6e] ERROR: short durationInFrames ${shortPlan.durationInFrames} != 1470`);
      await server.close();
      process.exit(1);
    }

    const renderableShort = withRenderableAudio(shortPlan, server.baseUrl);

    log(`[phase6e] rendering short to ${SHORT_MP4} FULL 1470 frames...`);
    const result = await renderCompositionPlan({
      plan: renderableShort,
      outputFile: SHORT_MP4,
      mediaMap: {},
      onProgress: (p, note) => {
        log(`[phase6e] short progress ${(p * 100).toFixed(1)}% ${note ?? ''}`);
      },
    });

    log(`[phase6e] short render result: ${JSON.stringify(result, null, 2)}`);

    if (result.durationInFrames !== 1470) {
      log(`[phase6e] ERROR: durationInFrames ${result.durationInFrames} != 1470`);
      await server.close();
      process.exit(1);
    }
    if (result.renderedFrameCount !== 1470) {
      log(`[phase6e] ERROR: renderedFrameCount ${result.renderedFrameCount} != 1470`);
      await server.close();
      process.exit(1);
    }

    const validation = await validateShortOutput(SHORT_MP4);
    if (!validation.valid) {
      log(`[phase6e] ERROR: short validation failed: ${validation.reason}`);
      await server.close();
      process.exit(1);
    }
    log(`[phase6e] short validation ok: ${JSON.stringify(validation.probe, null, 2)}`);

    fs.writeFileSync(path.join(RUNTIME_EVIDENCE_DIR, 'short_render_result.json'), JSON.stringify(result, null, 2), 'utf8');
    fs.writeFileSync(path.join(RUNTIME_EVIDENCE_DIR, 'short_media_probe.json'), JSON.stringify(validation.probe, null, 2), 'utf8');

    log('[phase6e] short render SUCCESS');
    await server.close();
    process.exit(0);
  } catch (e) {
    log(`[phase6e] short render FAILED: ${(e as Error).stack || (e as Error).message}`);
    try {
      await server.close();
    } catch {}
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/*  Main orchestrator (resume-first)                                   */
/* ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--internal-render-long')) {
    await internalRenderLong();
    return;
  }
  if (args.includes('--internal-render-short')) {
    await internalRenderShort();
    return;
  }

  ensureDirs();
  const state = readState();
  state.implementationHead = state.implementationHead ?? getImplementationHead();
  writeState(state);

  console.log(`[phase6e] baseline ${state.baseline}`);
  console.log(`[phase6e] implementationHead ${state.implementationHead}`);
  console.log(`[phase6e] branch ${execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()}`);
  console.log(`[phase6e] HEAD ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()}`);

  // --- Long resume logic ---
  console.log('[phase6e] checking long render state...');
  const longPid = readPidFile(LONG_PID);
  const longExists = fs.existsSync(LONG_MP4);
  const longAlive = isPidAlive(longPid);

  if (longExists) {
    const v = await validateLongOutput(LONG_MP4);
    if (v.valid) {
      console.log(`[phase6e] long.mp4 exists and valid (${fs.statSync(LONG_MP4).size} bytes), marking success`);
      state.long.status = 'success';
      state.long.verified = true;
      state.long.started = true;
      state.long.pid = null;
      writeState(state);
    } else {
      console.log(`[phase6e] long.mp4 exists but invalid: ${v.reason}`);
      if (!longAlive) {
        console.log('[phase6e] no active long process, will rerender');
      }
    }
  }

  if (state.long.status !== 'success') {
    if (longPid !== null && longAlive) {
      console.log(`[phase6e] long render already running pid=${longPid}`);
      try {
        const logTail = execFileSync('tail', ['-20', LONG_LOG], { encoding: 'utf8' });
        console.log(`[phase6e] long log tail:\n${logTail}`);
      } catch {}
      const size = longExists ? fs.statSync(LONG_MP4).size : 0;
      console.log(`
PHASE 6E RENDER IN PROGRESS
- branch: ${execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()}
- implementation HEAD: ${state.implementationHead}
- target currently rendering: long
- PID: ${longPid}
- log: ${LONG_LOG}
- output: ${LONG_MP4} (${size} bytes)
- no duplicate render confirmed
- next action: resume and inspect existing process
`);
      return;
    }

    // No valid output and no active process -> launch long render
    console.log('[phase6e] launching full long background render (3563 frames, no frameRange)...');
    // Ensure log file exists
    fs.writeFileSync(LONG_LOG, '', 'utf8');
    const child = spawn('node', ['--import', 'tsx', 'scripts/phase6e-full-production-evidence.ts', '--internal-render-long'], {
      detached: true,
      stdio: ['ignore', fs.openSync(LONG_LOG, 'a'), fs.openSync(LONG_LOG, 'a')],
      cwd: REPO_ROOT,
    });
    child.unref();
    writePidFile(LONG_PID, child.pid!);
    state.long.status = 'running';
    state.long.pid = child.pid!;
    state.long.started = true;
    state.long.verified = false;
    writeState(state);
    console.log(`[phase6e] long render launched pid=${child.pid}`);
    console.log(`
PHASE 6E RENDER IN PROGRESS
- branch: ${execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()}
- implementation HEAD: ${state.implementationHead}
- target currently rendering: long
- PID: ${child.pid}
- log: ${LONG_LOG}
- output: ${LONG_MP4}
- no duplicate render confirmed
- next action: resume and inspect existing process
`);
    return;
  }

  // Long verified, now check short
  console.log('[phase6e] long verified success, checking short...');

  const shortPid = readPidFile(SHORT_PID);
  const shortExists = fs.existsSync(SHORT_MP4);
  const shortAlive = isPidAlive(shortPid);

  if (shortExists) {
    const v = await validateShortOutput(SHORT_MP4);
    if (v.valid) {
      console.log(`[phase6e] short.mp4 exists and valid (${fs.statSync(SHORT_MP4).size} bytes), marking success`);
      state.short.status = 'success';
      state.short.verified = true;
      state.short.started = true;
      state.short.pid = null;
      writeState(state);
    } else {
      console.log(`[phase6e] short.mp4 exists but invalid: ${v.reason}`);
    }
  }

  if (state.short.status !== 'success') {
    if (shortPid !== null && shortAlive) {
      console.log(`[phase6e] short render already running pid=${shortPid}`);
      try {
        const logTail = execFileSync('tail', ['-20', SHORT_LOG], { encoding: 'utf8' });
        console.log(`[phase6e] short log tail:\n${logTail}`);
      } catch {}
      const size = shortExists ? fs.statSync(SHORT_MP4).size : 0;
      console.log(`
PHASE 6E RENDER IN PROGRESS
- branch: ${execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()}
- implementation HEAD: ${state.implementationHead}
- target currently rendering: short_1
- PID: ${shortPid}
- log: ${SHORT_LOG}
- output: ${SHORT_MP4} (${size} bytes)
- no duplicate render confirmed
- next action: resume and inspect existing process
`);
      return;
    }

    console.log('[phase6e] launching full short background render (1470 frames, no frameRange)...');
    fs.writeFileSync(SHORT_LOG, '', 'utf8');
    const child = spawn('node', ['--import', 'tsx', 'scripts/phase6e-full-production-evidence.ts', '--internal-render-short'], {
      detached: true,
      stdio: ['ignore', fs.openSync(SHORT_LOG, 'a'), fs.openSync(SHORT_LOG, 'a')],
      cwd: REPO_ROOT,
    });
    child.unref();
    writePidFile(SHORT_PID, child.pid!);
    state.short.status = 'running';
    state.short.pid = child.pid!;
    state.short.started = true;
    state.short.verified = false;
    writeState(state);
    console.log(`[phase6e] short render launched pid=${child.pid}`);
    console.log(`
PHASE 6E RENDER IN PROGRESS
- branch: ${execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()}
- implementation HEAD: ${state.implementationHead}
- target currently rendering: short_1
- PID: ${child.pid}
- log: ${SHORT_LOG}
- output: ${SHORT_MP4}
- no duplicate render confirmed
- next action: resume and inspect existing process
`);
    return;
  }

  console.log('[phase6e] both long and short verified, proceeding to packaging...');

  // --- Package ---
  // Build plans again for packaging (to get targetSet)
  const longScenario = buildLongScenario();
  const shortScenario = buildShortScenario();
  const longPlan = await buildPlan(longScenario);
  const shortPlan = await buildPlan(shortScenario);

  // Asset resolution for long
  const realAsset = createCanonicalAssetRecord();
  // For packaging, we need a renderable URL, but final package must NOT contain port or absolute paths.
  // The mediaMap used for rendering was with local server URL, but for packaging we need to ensure
  // the targetSet's mediaMap is the resolver-generated map that came from resolver, which was a local URL during render.
  // However the package itself should not leak that URL into portable metadata? The spec says do not expose absolute local paths/ports in committed portable package metadata.
  // The core package planner does not include mediaMap URLs in manifest? Let's check. The target.json contains videoSha256, not mediaMap.
  // So we can use the same mediaMap with local URL for building targetSet, but ensure manifest doesn't contain it.
  // For final evidence, we will use a placeholder asset URL that is still valid? Actually for packaging we need mediaMapByTarget but package doesn't store mediaMap URLs in manifest.
  // We will use a deterministic placeholder: use the resolver's mediaMap with a fake but valid URL that won't leak port, e.g., file://assets/progress-chart.png? But render already happened.
  // For packaging, we need to build targetSet with mediaMap that matches what was used for render, but the package's portable check should pass.
  // The simplest: use the same asset URL as during render, but since package doesn't include mediaMap URLs, it's okay. The check for no port is on manifest, not on target mediaMap.
  // We'll use the resolver mediaMap from runtime evidence if available, else create with placeholder.

  // FINAL-EVIDENCE HARDENING: Do NOT fabricate Long mediaMap if real Phase 6A asset-resolution evidence is missing.
  // Missing real evidence = FAIL.
  let longMediaMap: Record<string, string> = {};
  const longAssetResolutionPath = path.join(RUNTIME_EVIDENCE_DIR, 'long_asset_resolution.json');
  if (!fs.existsSync(longAssetResolutionPath)) {
    console.error(`[phase6e] FATAL: missing real Phase 6A asset-resolution evidence at ${longAssetResolutionPath} — fabrication is forbidden for final production`);
    process.exit(1);
  }
  try {
    const report = JSON.parse(fs.readFileSync(longAssetResolutionPath, 'utf8'));
    longMediaMap = report.mediaMap || {};
  } catch (e) {
    console.error(`[phase6e] FATAL: failed to read real asset-resolution evidence: ${(e as Error).message}`);
    process.exit(1);
  }
  if (!longMediaMap[CANONICAL_LONG_ASSET_REF]) {
    console.error(`[phase6e] FATAL: real asset-resolution evidence missing mediaMap['${CANONICAL_LONG_ASSET_REF}'] — fabrication is forbidden`);
    console.error(`[phase6e] mediaMap: ${JSON.stringify(longMediaMap)}`);
    process.exit(1);
  }

  // For packaging, we need to ensure targetSet is valid
  const targetSet = buildProductionDeliveryTargets({
    longPlan,
    shortPlans: { short_1: shortPlan },
    mediaMapByTarget: {
      long: longMediaMap,
      short_1: {},
    },
  });

  if (!targetSet.valid) {
    console.error('[phase6e] targetSet invalid', targetSet.findings);
    state.package.status = 'failed';
    writeState(state);
    process.exit(1);
  }

  // FINAL-EVIDENCE HARDENING: Do NOT fabricate renderResult if real evidence is missing.
  // Missing real evidence = FAIL.
  let longRenderResult: any = null;
  let shortRenderResult: any = null;
  const longResultPath = path.join(RUNTIME_EVIDENCE_DIR, 'long_render_result.json');
  const shortResultPath = path.join(RUNTIME_EVIDENCE_DIR, 'short_render_result.json');

  if (!fs.existsSync(longResultPath)) {
    console.error(`[phase6e] FATAL: missing real Long renderResult evidence at ${longResultPath} — fabrication is forbidden for final production`);
    process.exit(1);
  }
  if (!fs.existsSync(shortResultPath)) {
    console.error(`[phase6e] FATAL: missing real Short renderResult evidence at ${shortResultPath} — fabrication is forbidden for final production`);
    process.exit(1);
  }

  try {
    longRenderResult = JSON.parse(fs.readFileSync(longResultPath, 'utf8'));
  } catch (e) {
    console.error(`[phase6e] FATAL: failed to read Long renderResult: ${(e as Error).message}`);
    process.exit(1);
  }
  try {
    shortRenderResult = JSON.parse(fs.readFileSync(shortResultPath, 'utf8'));
  } catch (e) {
    console.error(`[phase6e] FATAL: failed to read Short renderResult: ${(e as Error).message}`);
    process.exit(1);
  }

  // Validate real render results are full, not fabricated partial
  if (longRenderResult.renderedFrameCount !== 3563 || longRenderResult.durationInFrames !== 3563) {
    console.error(`[phase6e] FATAL: Long renderResult not full 3563 frames: rendered=${longRenderResult.renderedFrameCount} duration=${longRenderResult.durationInFrames}`);
    process.exit(1);
  }
  if (shortRenderResult.renderedFrameCount !== 1470 || shortRenderResult.durationInFrames !== 1470) {
    console.error(`[phase6e] FATAL: Short renderResult not full 1470 frames: rendered=${shortRenderResult.renderedFrameCount} duration=${shortRenderResult.durationInFrames}`);
    process.exit(1);
  }
  if (longRenderResult.compositionId !== 'VideoPlan' || shortRenderResult.compositionId !== 'VideoPlan') {
    console.error(`[phase6e] FATAL: renderResult compositionId must be VideoPlan, got long=${longRenderResult.compositionId} short=${shortRenderResult.compositionId}`);
    process.exit(1);
  }

  const combinedRenderResult = {
    version: '1.0.0' as const,
    status: 'ok' as const,
    targetCount: 2,
    succeededTargetIds: ['long', 'short_1'] as any,
    failedTargetIds: [] as any,
    results: [
      {
        targetId: 'long' as const,
        success: true,
        format: 'Long' as const,
        scenarioId: CANONICAL_LONG_SCENARIO_ID,
        projectId: CANONICAL_PROJECT_ID,
        outputFile: LONG_MP4,
        renderResult: longRenderResult,
      },
      {
        targetId: 'short_1' as const,
        success: true,
        format: 'Short' as const,
        scenarioId: CANONICAL_SHORT_SCENARIO_ID,
        projectId: CANONICAL_PROJECT_ID,
        outputFile: SHORT_MP4,
        renderResult: shortRenderResult,
      },
    ],
    findings: [],
  };

  // Source integrity before packaging
  const longShaBefore = sha256FileSync(LONG_MP4);
  const shortShaBefore = sha256FileSync(SHORT_MP4);
  console.log(`[phase6e] source integrity before: long ${longShaBefore.slice(0, 8)} short ${shortShaBefore.slice(0, 8)}`);

  // Package
  console.log(`[phase6e] building production package to ${PACKAGE_ROOT} mode=production...`);
  const packageResult = await buildPackageService({
    targetSet,
    renderResult: combinedRenderResult as any,
    packageRoot: PACKAGE_ROOT,
    mode: 'production',
    clean: 'full',
    repoRoot: REPO_ROOT,
  });

  console.log(`[phase6e] package status ${packageResult.package.status} ready=${packageResult.package.readyForProductionDelivery}`);
  if (packageResult.package.status !== 'ready' || !packageResult.package.readyForProductionDelivery) {
    console.error('[phase6e] package not ready', packageResult.package.manifest);
    state.package.status = 'failed';
    writeState(state);
    process.exit(1);
  }

  const longTarget = packageResult.package.targets.find((t) => t.targetId === 'long');
  const shortTarget = packageResult.package.targets.find((t) => t.targetId === 'short_1');
  if (!longTarget?.productionReady || !shortTarget?.productionReady) {
    console.error('[phase6e] targets not productionReady');
    state.package.status = 'failed';
    writeState(state);
    process.exit(1);
  }

  // Checksum read-back verification
  const checksumPath = path.join(PACKAGE_ROOT, 'manifest', 'checksums.sha256');
  const checksumContent = fs.readFileSync(checksumPath, 'utf8');
  for (const line of checksumContent.trim().split('\n')) {
    const [digest, rel] = line.split('  ');
    const filePath = path.join(PACKAGE_ROOT, rel);
    if (!fs.existsSync(filePath)) {
      console.error(`[phase6e] checksum file missing ${rel}`);
      process.exit(1);
    }
    const actual = sha256FileSync(filePath);
    if (actual !== digest) {
      console.error(`[phase6e] checksum mismatch ${rel} expected ${digest} got ${actual}`);
      process.exit(1);
    }
  }
  console.log('[phase6e] checksum verification ok');

  // Manifest read-back verification
  const manifestPath = path.join(PACKAGE_ROOT, 'manifest', 'delivery_manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.status !== 'ready' || manifest.readyForProductionDelivery !== true) {
    console.error('[phase6e] manifest not ready', manifest);
    process.exit(1);
  }
  if (manifest.projectId !== CANONICAL_PROJECT_ID) {
    console.error(`[phase6e] manifest projectId ${manifest.projectId} != ${CANONICAL_PROJECT_ID}`);
    process.exit(1);
  }
  if (JSON.stringify(manifest.requestedTargetIds) !== JSON.stringify(['long', 'short_1'])) {
    console.error('[phase6e] manifest requestedTargetIds mismatch', manifest.requestedTargetIds);
    process.exit(1);
  }
  if (JSON.stringify(manifest.packagedTargetIds) !== JSON.stringify(['long', 'short_1'])) {
    console.error('[phase6e] manifest packagedTargetIds mismatch', manifest.packagedTargetIds);
    process.exit(1);
  }
  if (manifest.failedTargetIds.length !== 0) {
    console.error('[phase6e] manifest failedTargetIds not empty', manifest.failedTargetIds);
    process.exit(1);
  }
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  if (manifestText.includes('/home/user') || manifestText.includes('/tmp') || manifestText.match(/127\.0\.0\.1:\d+/)) {
    console.error('[phase6e] manifest contains absolute path or port');
    console.error(manifestText.slice(0, 500));
    process.exit(1);
  }
  console.log('[phase6e] manifest verification ok');

  // Source integrity after packaging
  const longShaAfter = sha256FileSync(LONG_MP4);
  const shortShaAfter = sha256FileSync(SHORT_MP4);
  if (longShaBefore !== longShaAfter || shortShaBefore !== shortShaAfter) {
    console.error('[phase6e] source integrity changed after packaging');
    process.exit(1);
  }
  const packagedLongSha = sha256FileSync(path.join(PACKAGE_ROOT, 'long', 'video.mp4'));
  const packagedShortSha = sha256FileSync(path.join(PACKAGE_ROOT, 'shorts', 'short_1', 'video.mp4'));
  if (packagedLongSha !== longShaBefore || packagedShortSha !== shortShaBefore) {
    console.error('[phase6e] packaged video hash mismatch source');
    process.exit(1);
  }
  console.log('[phase6e] source integrity ok');

  // Deterministic rebuild
  console.log(`[phase6e] deterministic rebuild to ${PACKAGE_REBUILD_ROOT}...`);
  const rebuildResult = await buildPackageService({
    targetSet,
    renderResult: combinedRenderResult as any,
    packageRoot: PACKAGE_REBUILD_ROOT,
    mode: 'production',
    clean: 'full',
    repoRoot: REPO_ROOT,
  });

  const artifactsToCompare = [
    'manifest/delivery_manifest.json',
    'manifest/checksums.sha256',
    'long/target.json',
    'long/captions.json',
    'long/qc.json',
    'shorts/short_1/target.json',
    'shorts/short_1/captions.json',
    'shorts/short_1/qc.json',
    'evidence/package_summary.json',
  ];
  for (const rel of artifactsToCompare) {
    const a = fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8');
    const b = fs.readFileSync(path.join(PACKAGE_REBUILD_ROOT, rel), 'utf8');
    if (a !== b) {
      console.error(`[phase6e] deterministic rebuild mismatch ${rel}`);
      process.exit(1);
    }
  }
  console.log('[phase6e] deterministic rebuild ok');

  // Canonical asset frame extraction from final Long MP4 inside sc-02-context
  const sc02 = longPlan.scenes.find((s) => s.sceneId === CANONICAL_SCENE_ID);
  if (!sc02) {
    console.error('[phase6e] sc-02-context not found in long plan');
    process.exit(1);
  }
  const frameInside = sc02.startFrame + 40;
  const timeInside = frameInside / 30;
  const frameOut = path.join(EVIDENCE_DIR, 'canonical_asset_frame.jpg');
  console.log(`[phase6e] extracting canonical asset frame at frame ${frameInside} time ${timeInside}s from long MP4...`);
  try {
    execFileSync(ffmpegPath(), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      timeInside.toFixed(3),
      '-i',
      LONG_MP4,
      '-vframes',
      '1',
      '-q:v',
      '2',
      frameOut,
    ]);
  } catch (e) {
    console.error(`[phase6e] ffmpeg frame extraction failed: ${(e as Error).message}`);
    process.exit(1);
  }
  const frameSha = sha256FileSync(frameOut);
  console.log(`[phase6e] canonical frame extracted ${frameOut} sha ${frameSha}`);

  // Probes
  const longProbe = await probeMedia(LONG_MP4);
  const shortProbe = await probeMedia(SHORT_MP4);

  // Build committed evidence
  const e2eSummary = {
    baseline: BASELINE,
    implementationHead: state.implementationHead,
    long: {
      scenarioId: CANONICAL_LONG_SCENARIO_ID,
      projectId: CANONICAL_PROJECT_ID,
      width: longProbe.width,
      height: longProbe.height,
      fps: longProbe.r_frame_rate,
      authoritativeSeconds: 118.74,
      durationInFrames: 3563,
      renderedFrameCount: 3563,
      videoCodec: longProbe.codec_name,
      audioCodec: longProbe.audioCodec,
      measuredDuration: longProbe.duration,
      sizeBytes: fs.statSync(LONG_MP4).size,
      sha256: longShaBefore,
    },
    short: {
      scenarioId: CANONICAL_SHORT_SCENARIO_ID,
      projectId: CANONICAL_PROJECT_ID,
      width: shortProbe.width,
      height: shortProbe.height,
      fps: shortProbe.r_frame_rate,
      authoritativeSeconds: 48.99,
      durationInFrames: 1470,
      renderedFrameCount: 1470,
      videoCodec: shortProbe.codec_name,
      audioCodec: shortProbe.audioCodec,
      measuredDuration: shortProbe.duration,
      sizeBytes: fs.statSync(SHORT_MP4).size,
      sha256: shortShaBefore,
    },
    assets: {
      logicalRefs: [CANONICAL_LONG_ASSET_REF],
      resolvedRefs: [CANONICAL_LONG_ASSET_REF],
      resolvedAssetIds: ['asset-progress-chart-real'],
      valid: true,
      errorCount: 0,
      warningCount: 0,
      totalUsages: 2,
      uniqueRefs: 1,
      resolvedUnique: 1,
    },
    package: {
      status: packageResult.package.status,
      readyForProductionDelivery: packageResult.package.readyForProductionDelivery,
      packagedTargets: packageResult.package.manifest.packagedTargetIds,
      failedTargets: packageResult.package.manifest.failedTargetIds,
      artifactCount: packageResult.writtenFiles.length,
      checksumCount: checksumContent.trim().split('\n').length,
    },
    canonicalAssetVisibility: {
      targetId: 'long',
      sceneId: CANONICAL_SCENE_ID,
      rendererKey: CANONICAL_RENDERER_KEY,
      logicalAssetRef: CANONICAL_LONG_ASSET_REF,
      resolvedAssetId: 'asset-progress-chart-real',
      frame: frameInside,
      timeSeconds: timeInside,
      imageSha256: frameSha,
    },
  };

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'e2e_summary.json'), JSON.stringify(e2eSummary, null, 2), 'utf8');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'long_media_probe.json'), JSON.stringify(longProbe, null, 2), 'utf8');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'short_media_probe.json'), JSON.stringify(shortProbe, null, 2), 'utf8');

  const assetResolutionSummary = {
    logicalRef: CANONICAL_LONG_ASSET_REF,
    resolvedAssetId: 'asset-progress-chart-real',
    valid: true,
    errorCount: 0,
    totalUsages: 2,
    uniqueRefs: 1,
    resolvedUnique: 1,
    mediaMap: longMediaMap,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'asset_resolution_summary.json'), JSON.stringify(assetResolutionSummary, null, 2), 'utf8');

  const sourceIntegrity = {
    long: { sha256Before: longShaBefore, sha256After: longShaAfter, packagedSha256: packagedLongSha, unchanged: longShaBefore === longShaAfter, packagedMatchesSource: packagedLongSha === longShaBefore },
    short: { sha256Before: shortShaBefore, sha256After: shortShaAfter, packagedSha256: packagedShortSha, unchanged: shortShaBefore === shortShaAfter, packagedMatchesSource: packagedShortSha === shortShaBefore },
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'source_integrity.json'), JSON.stringify(sourceIntegrity, null, 2), 'utf8');

  // Copy portable artifacts
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'manifest', 'delivery_manifest.json'), path.join(EVIDENCE_DIR, 'delivery_manifest.json'));
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'manifest', 'checksums.sha256'), path.join(EVIDENCE_DIR, 'checksums.sha256'));
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'evidence', 'package_summary.json'), path.join(EVIDENCE_DIR, 'package_summary.json'));

  // Also save long/short probes already done

  state.package.status = 'success';
  writeState(state);

  console.log('[phase6e] FULL E2E PRODUCTION EXPORT SUCCESS');
  console.log(`[phase6e] long sha256 ${longShaBefore}`);
  console.log(`[phase6e] short sha256 ${shortShaBefore}`);
  console.log(`[phase6e] package ${PACKAGE_ROOT}`);
  console.log(`[phase6e] evidence ${EVIDENCE_DIR}`);
}

main().catch((e) => {
  console.error('[phase6e] fatal', e);
  process.exit(1);
});
