#!/usr/bin/env node
/**
 * Phase 6B evidence collector.
 *
 * Runs the REAL plan render path against the canonical `scenario-pm-01` plan
 * and writes the Phase 6B artifacts into EVIDENCE/phase6b/:
 *
 *   canonical_sc02_context_frame.jpg   the canonical asset scene, as rendered
 *   sc02_media_visibility.json         proof the resolved asset is VISUALLY used
 *   plan_contract.json                 plan identity, timing and findings
 *   short_render_result.json           PlanRenderResult of the real render
 *   short_render_ffprobe.json          ffprobe + media analysis of the MP4
 *   canonical_timing.json              118.74s -> 3563 frames evidence
 *   full_render_result.json            only when a full canonical render ran
 *
 * Deterministic and offline: every image and audio clip is served from
 * tests/fixtures/render by a local HTTP server on 127.0.0.1.
 *
 *   node --import tsx tests/phase6b-evidence.ts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PLAN_RENDER_CANONICAL,
  compileScenarioVisualPlan,
  getBrandPreset,
  getProgressMeetingScenario,
  resolveProductionAssets,
  type Asset,
  type RemotionCompositionPlan,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';
import { renderCompositionPlan, renderPlanStill } from '../apps/api/src/services/render.js';
import { analyseFile } from '../apps/api/src/services/media.js';
import { ffmpegPath, ffprobePath, runOrThrow } from '../apps/api/src/services/platform.js';
import { validatePlanForRender } from '@buildtrack/core';

const ROOT = process.cwd();
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'render');
const EVIDENCE_DIR = path.join(ROOT, 'EVIDENCE', 'phase6b');
const SCRATCH = path.join(ROOT, '.stills', 'phase6b');
const CANONICAL_SCENE = 'sc-02-context';
const CANONICAL_ASSET_REF = 'asset-iva-progress-chart';

const MIME: Record<string, string> = { '.png': 'image/png', '.wav': 'audio/wav' };

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (name: string, value: unknown) => {
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const log = (...a: unknown[]) => console.log('[phase6b-evidence]', ...a);

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(SCRATCH, { recursive: true });

  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
    const file = path.join(FIXTURE_DIR, name);
    if (path.dirname(file) !== FIXTURE_DIR || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  log('fixture server', base);

  /* ── the real Phase 5C chain ────────────────────────────────────── */
  const tmp = '.tmp-probe/evidence/canonical';
  fs.rmSync('.tmp-probe/evidence', { recursive: true, force: true });
  const scenario = getProgressMeetingScenario();
  const visual = compileScenarioVisualPlan(scenario);
  if (!visual.ok) throw new Error('compileScenarioVisualPlan failed');
  const dialogue = await buildDialogueProductionPlan(scenario, {
    synthesisBasePath: `${tmp}/audio/dialogue`,
    canonicalBasePath: `${tmp}/audio/canonical`,
  });
  if (!dialogue.success) throw new Error(`buildDialogueProductionPlan failed: ${dialogue.error}`);
  const visualProd = buildVisualProductionPlan({ scenario, visualPlan: visual.plan, dialogueResult: dialogue.result });
  if (!visualProd.success) throw new Error(`buildVisualProductionPlan failed: ${visualProd.error}`);
  const sceneRender = buildSceneRenderPlan({ scenario, visualProductionPlan: visualProd.plan });
  if (!sceneRender.success) throw new Error(`buildSceneRenderPlan failed: ${sceneRender.error}`);
  const remotion = buildRemotionCompositionProps(sceneRender.plan);
  if (!remotion.success) throw new Error(`buildRemotionCompositionProps failed: ${remotion.error}`);
  const plan: RemotionCompositionPlan = remotion.plan;

  const chart: Asset = {
    id: 'asset-progress-chart-real',
    name: 'Progress Chart',
    kind: 'chart',
    fileName: 'progress-chart.png',
    path: 'assets/progress-chart.png',
    mimeType: 'image/png',
    sizeBytes: fs.statSync(path.join(FIXTURE_DIR, 'progress-chart.png')).size,
    tags: [`asset-ref:${CANONICAL_ASSET_REF}`],
    status: 'active',
    preferred: true,
    source: 'Local fixture (deterministic, offline)',
    license: 'Generated for tests',
    addedAt: '2026-09-30T00:00:00.000Z',
    usedIn: [],
    blocked: false,
  };
  const report = resolveProductionAssets({
    plan,
    assets: [chart],
    assetUrlById: { 'asset-progress-chart-real': `${base}/progress-chart.png` },
  });
  const mediaMap = report.mediaMap;
  const scene = plan.scenes.find((s) => s.sceneId === CANONICAL_SCENE)!;

  write('plan_contract.json', {
    planVersion: plan.planVersion,
    scenarioId: plan.scenarioId,
    projectId: plan.projectId,
    language: plan.language,
    targetFormat: plan.targetFormat,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    durationInFrames: plan.durationInFrames,
    totalActualDurationSeconds: plan.totalActualDurationSeconds,
    totalEstimatedDurationSeconds: plan.totalEstimatedDurationSeconds,
    valid: plan.valid,
    summary: plan.summary,
    findings: validatePlanForRender(plan, mediaMap),
    scenes: plan.scenes.map((s) => ({
      sceneId: s.sceneId,
      rendererKey: s.rendererKey,
      startFrame: s.startFrame,
      endFrame: s.endFrame,
      durationInFrames: s.durationInFrames,
      assetRefs: s.assetRefs,
      audioRefCount: s.audioRefs.length,
      captionCueCount: s.captionCues.length,
    })),
  });

  write('canonical_timing.json', {
    locked: PLAN_RENDER_CANONICAL,
    observed: {
      authoritativeDurationSeconds: plan.totalActualDurationSeconds,
      estimatorDurationSeconds: plan.totalEstimatedDurationSeconds,
      fps: plan.fps,
      rawFrameValue: plan.totalActualDurationSeconds * plan.fps,
      durationInFrames: plan.durationInFrames,
      lastValidFrameIndex: plan.durationInFrames - 1,
      finalSceneEndFrame: plan.scenes[plan.scenes.length - 1]!.endFrame,
    },
    estimatorWouldHaveBeenFrames: Math.ceil(plan.totalEstimatedDurationSeconds * plan.fps),
    usesEstimatorTiming: plan.durationInFrames === Math.ceil(plan.totalEstimatedDurationSeconds * plan.fps),
  });

  /* ── canonical asset visibility, on real frames ──────────────────── */
  const renderPlan: RemotionCompositionPlan = {
    ...plan,
    scenes: plan.scenes.map((s) => ({
      ...s,
      audioRefs: s.audioRefs.map((a) => ({ ...a, canonicalPath: `${base}/dialogue.wav?clip=${encodeURIComponent(a.clipId)}` })),
    })),
  };
  const frame = scene.startFrame + 40;
  const stills = {
    resolved: await renderPlanStill({ plan: renderPlan, output: path.join(SCRATCH, 'ev-resolved.png'), frame, mediaMap }),
    alt: await renderPlanStill({
      plan: renderPlan,
      output: path.join(SCRATCH, 'ev-alt.png'),
      frame,
      mediaMap: { [CANONICAL_ASSET_REF]: `${base}/progress-chart-alt.png` },
    }),
    unresolved: await renderPlanStill({ plan: renderPlan, output: path.join(SCRATCH, 'ev-unresolved.png'), frame, mediaMap: {} }),
  };
  const digests = Object.fromEntries(
    Object.entries(stills).map(([k, v]) => [k, { file: path.basename(v.file), bytes: fs.statSync(v.file).size, sha256: sha(v.file) }]),
  );
  write('sc02_media_visibility.json', {
    scenarioId: plan.scenarioId,
    scene: CANONICAL_SCENE,
    rendererKey: scene.rendererKey,
    assetRef: CANONICAL_ASSET_REF,
    assetRefsInPlan: scene.assetRefs,
    resolvedMediaMap: mediaMap,
    frame,
    frameContext: { sceneStartFrame: scene.startFrame, sceneEndFrame: scene.endFrame },
    stills: digests,
    verdict: {
      resolvedDiffersFromAltFixture: digests.resolved!.sha256 !== digests.alt!.sha256,
      resolvedDiffersFromUnresolved: digests.resolved!.sha256 !== digests.unresolved!.sha256,
      assetVisuallyConsumed:
        digests.resolved!.sha256 !== digests.alt!.sha256 && digests.resolved!.sha256 !== digests.unresolved!.sha256,
      rendererKeyUnchanged: scene.rendererKey === 'explanation:key_statement',
    },
  });
  log('visibility', JSON.stringify({ resolved: digests.resolved!.sha256.slice(0, 12), alt: digests.alt!.sha256.slice(0, 12), unresolved: digests.unresolved!.sha256.slice(0, 12) }));

  await runOrThrow(ffmpegPath(), [
    '-y', '-loglevel', 'error', '-i', stills.resolved.file, '-vf', 'scale=1280:-2', '-q:v', '4',
    path.join(EVIDENCE_DIR, 'canonical_sc02_context_frame.jpg'),
  ]);

  /* ── real sub-range render ───────────────────────────────────────── */
  const from = scene.startFrame;
  const to = Math.min(scene.endFrame - 1, from + 59);
  const outputFile = path.join(SCRATCH, 'evidence-canonical-sc02.mp4');
  const result = await renderCompositionPlan({
    plan: renderPlan,
    outputFile,
    mediaMap,
    brand: getBrandPreset('buildtrack'),
    frameRange: [from, to],
    quality: 'preview',
  });
  write('short_render_result.json', {
    ...result,
    outputFile: path.relative(ROOT, result.outputFile),
    frameRange: { firstFrame: from, lastFrameInclusive: to },
    note: 'sub-range render: the plan durationInFrames stays authoritative at 3563',
  });

  const analysis = await analyseFile(outputFile);
  const probe = JSON.parse(
    execFileSync(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', outputFile], { encoding: 'utf8' }),
  );
  write('short_render_ffprobe.json', {
    file: path.relative(ROOT, outputFile),
    fileBytes: fs.statSync(outputFile).size,
    fileSha256: sha(outputFile),
    streams: (probe.streams ?? []).map((s: Record<string, unknown>) => ({
      type: s.codec_type,
      codec: s.codec_name,
      profile: s.profile ?? null,
      width: s.width ?? null,
      height: s.height ?? null,
      rFrameRate: s.r_frame_rate ?? null,
      pixFmt: s.pix_fmt ?? null,
      sampleRate: s.sample_rate ?? null,
      channels: s.channels ?? null,
      duration: s.duration ?? null,
      nbFrames: s.nb_frames ?? null,
    })),
    format: {
      formatName: probe.format?.format_name,
      durationSeconds: Number(probe.format?.duration ?? 0),
      sizeBytes: Number(probe.format?.size ?? 0),
      bitRate: Number(probe.format?.bit_rate ?? 0),
    },
    mediaAnalysis: {
      videoCodec: analysis.codec_name,
      audioCodec: analysis.audioCodec,
      hasAudio: analysis.hasAudio,
      rFrameRate: analysis.r_frame_rate,
      width: analysis.width,
      height: analysis.height,
      durationSeconds: Number(analysis.duration.toFixed(3)),
      longestSilenceSec: Number(analysis.longestSilence.toFixed(3)),
      blackSeconds: Number(analysis.blackSeconds.toFixed(3)),
    },
  });
  log('short render', path.basename(outputFile), `${fs.statSync(outputFile).size} bytes`, `audio=${analysis.hasAudio}`);

  /* ── full render, only if one was performed ──────────────────────── */
  const fullFile = path.join(SCRATCH, 'full_render_result.json');
  if (fs.existsSync(fullFile)) {
    const full = JSON.parse(fs.readFileSync(fullFile, 'utf8'));
    write('full_render_result.json', full);
    const fullMedia = full.outputFile;
    if (fullMedia && fs.existsSync(fullMedia)) {
      const fullAnalysis = await analyseFile(fullMedia);
      const fullProbe = JSON.parse(
        execFileSync(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', fullMedia], { encoding: 'utf8' }),
      );
      write('full_render_ffprobe.json', {
        file: path.relative(ROOT, fullMedia),
        fileBytes: fs.statSync(fullMedia).size,
        fileSha256: sha(fullMedia),
        format: {
          formatName: fullProbe.format?.format_name,
          durationSeconds: Number(fullProbe.format?.duration ?? 0),
          sizeBytes: Number(fullProbe.format?.size ?? 0),
        },
        mediaAnalysis: {
          videoCodec: fullAnalysis.codec_name,
          audioCodec: fullAnalysis.audioCodec,
          hasAudio: fullAnalysis.hasAudio,
          width: fullAnalysis.width,
          height: fullAnalysis.height,
          rFrameRate: fullAnalysis.r_frame_rate,
          durationSeconds: Number(fullAnalysis.duration.toFixed(3)),
        },
      });
    }
    log('full render evidence copied');
  } else {
    log('no full render result found at', fullFile);
  }

  server.close();
  log('done ->', EVIDENCE_DIR);
}

main().catch((err) => {
  console.error('[phase6b-evidence] failed:', err);
  process.exit(1);
});
