/**
 * Phase 6B — REAL render evidence.
 *
 * These tests actually bundle the Remotion app, select the `VideoPlan`
 * composition, drive a real Chromium and encode real media. They are the only
 * place the production render path is proven end to end.
 *
 * Cost control (Phase 6B §14): the plan is never shortened or re-timed. A SHORT
 * SUB-RANGE of the canonical 3563-frame composition is encoded via Remotion's
 * `frameRange`, so the plan's `durationInFrames` stays the authority while the
 * encode stays cheap.
 *
 * Offline by construction (Phase 6B §15/§16): every image and every audio clip
 * is served by a local HTTP server bound to 127.0.0.1 on a random port. No
 * remote host is contacted and no stock asset is downloaded. The one thing the
 * test rewrites is the audit-only `canonicalPath` field of each audio ref: the
 * plan stores a repo-relative path (production serves it over the API), while a
 * browser needs a URL. That mapping is `toRenderableAudioUrl` and it is
 * asserted to touch only that field.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  PLAN_RENDER_CANONICAL,
  compileScenarioVisualPlan,
  getBrandPreset,
  getProgressMeetingScenario,
  resolveProductionAssets,
  validatePlanForRender,
  type Asset,
  type RemotionCompositionPlan,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';
import { renderCompositionPlan, renderPlanStill, resetBundle } from '../apps/api/src/services/render.js';
import { analyseFile } from '../apps/api/src/services/media.js';
import { chromePath } from '../apps/api/src/services/platform.js';

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'render');
const SCRATCH = path.join(process.cwd(), '.stills', 'phase6b');
const TMP = '.test-phase6b';
const CANONICAL_SCENE = 'sc-02-context';
const CANONICAL_ASSET_REF = 'asset-iva-progress-chart';

/**
 * The locally provisioned Chromium is required for a real render. It is 200 MB
 * and is deliberately NOT installed in CI (see .github/workflows/ci.yml: the
 * render "is deliberately NOT run here"), so these tests SKIP when it is
 * absent instead of failing the suite. Locally they always run.
 */
function browserAvailable(): boolean {
  try {
    return !!chromePath() && fs.existsSync(chromePath());
  } catch {
    return false;
  }
}
const HAS_BROWSER = browserAvailable();
const describeReal = HAS_BROWSER ? describe : describe.skip;
if (!HAS_BROWSER) {
  // eslint-disable-next-line no-console
  console.warn('[phase6b] no provisioned Chromium - skipping real render evidence (run `npm run provision`).');
}

/**
 * Test-only transport mapping: plan `canonicalPath` (repo-relative, served by
 * the API in production) -> a URL the local fixture server can answer.
 * Production does NOT need this; it is the "test fixture asset URL" of §16.
 */
function toRenderableAudioUrl(audioRef: { clipId: string }, base: string): string {
  return `${base}/dialogue.wav?clip=${encodeURIComponent(audioRef.clipId)}`;
}

function withRenderableAudio(plan: RemotionCompositionPlan, base: string): RemotionCompositionPlan {
  return {
    ...plan,
    // Only canonicalPath changes. Timing, ids, order and every other field are
    // copied verbatim so the render still exercises the real plan.
    scenes: plan.scenes.map((scene) => ({
      ...scene,
      audioRefs: scene.audioRefs.map((a) => ({ ...a, canonicalPath: toRenderableAudioUrl(a, base) })),
    })),
  };
}

let server: http.Server;
let baseUrl = '';
let canonical: RemotionCompositionPlan;
let canonicalMediaMap: Record<string, string> = {};

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav' };

beforeAll(async () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  server = http.createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const name = path.basename(rawPath);
    const file = path.join(FIXTURE_DIR, name);
    if (path.dirname(file) !== FIXTURE_DIR || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  resetBundle();

  // ── the real Phase 5C chain, built once ──────────────────────────────
  const scenario = getProgressMeetingScenario();
  const visual = compileScenarioVisualPlan(scenario);
  if (!visual.ok) throw new Error('compileScenarioVisualPlan failed');
  const dialogue = await buildDialogueProductionPlan(scenario, {
    synthesisBasePath: `${TMP}/audio/dialogue`,
    canonicalBasePath: `${TMP}/audio/canonical`,
  });
  if (!dialogue.success) throw new Error(`buildDialogueProductionPlan failed: ${dialogue.error}`);
  const visualProd = buildVisualProductionPlan({ scenario, visualPlan: visual.plan, dialogueResult: dialogue.result });
  if (!visualProd.success) throw new Error(`buildVisualProductionPlan failed: ${visualProd.error}`);
  const sceneRender = buildSceneRenderPlan({ scenario, visualProductionPlan: visualProd.plan });
  if (!sceneRender.success) throw new Error(`buildSceneRenderPlan failed: ${sceneRender.error}`);
  const remotion = buildRemotionCompositionProps(sceneRender.plan);
  if (!remotion.success) throw new Error(`buildRemotionCompositionProps failed: ${remotion.error}`);
  canonical = remotion.plan;

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
  canonicalMediaMap = resolveProductionAssets({
    plan: canonical,
    assets: [chart],
    assetUrlById: { 'asset-progress-chart-real': `${baseUrl}/progress-chart.png` },
  }).mediaMap;
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('Phase 6B — canonical sc-02-context visibly renders the resolved asset (real frames)', () => {
  it('renders a different real frame when the resolved asset changes, and none when unresolved', async () => {
    const scene = canonical.scenes.find((s) => s.sceneId === CANONICAL_SCENE)!;
    const frame = scene.startFrame + 40;
    const renderable = withRenderableAudio(canonical, baseUrl);

    const blue = await renderPlanStill({
      plan: renderable,
      output: path.join(SCRATCH, 'sc02-resolved.png'),
      frame,
      mediaMap: { [CANONICAL_ASSET_REF]: `${baseUrl}/progress-chart.png` },
    });
    const red = await renderPlanStill({
      plan: renderable,
      output: path.join(SCRATCH, 'sc02-alt.png'),
      frame,
      mediaMap: { [CANONICAL_ASSET_REF]: `${baseUrl}/progress-chart-alt.png` },
    });
    const none = await renderPlanStill({
      plan: renderable,
      output: path.join(SCRATCH, 'sc02-unresolved.png'),
      frame,
      mediaMap: {},
    });

    for (const f of [blue.file, red.file, none.file]) {
      expect(fs.existsSync(f)).toBe(true);
      expect(fs.statSync(f).size).toBeGreaterThan(0);
    }

    // If the renderer ignored mediaUrl all three would be byte-identical.
    const a = sha(blue.file);
    const b = sha(red.file);
    const c = sha(none.file);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  }, 900_000);

  it('keeps the canonical rendererKey, scene identity and timing while showing the asset', async () => {
    const scene = canonical.scenes.find((s) => s.sceneId === CANONICAL_SCENE)!;
    expect(scene.rendererKey).toBe('explanation:key_statement');
    expect(scene.assetRefs.map((r) => r.assetRef)).toEqual([CANONICAL_ASSET_REF, CANONICAL_ASSET_REF]);
    expect(canonicalMediaMap[CANONICAL_ASSET_REF]).toBe(`${baseUrl}/progress-chart.png`);
    expect(validatePlanForRender(canonical, canonicalMediaMap)).toEqual([]);
  });
});

describe('Phase 6B — real sub-range render of the canonical plan', () => {
  it('produces a real, non-empty MP4 that carries the canonical audio stream', async () => {
    const scene = canonical.scenes.find((s) => s.sceneId === CANONICAL_SCENE)!;
    const from = scene.startFrame;
    const to = Math.min(scene.endFrame - 1, from + 59);
    const outputFile = path.join(SCRATCH, 'phase6b-canonical-sc02.mp4');

    const result = await renderCompositionPlan({
      plan: withRenderableAudio(canonical, baseUrl),
      outputFile,
      mediaMap: canonicalMediaMap,
      brand: getBrandPreset('buildtrack'),
      frameRange: [from, to],
      quality: 'preview',
    });

    // ── plan-derived metadata ─────────────────────────────────────────
    expect(result.compositionId).toBe('VideoPlan');
    expect(result.scenarioId).toBe('scenario-pm-01');
    expect(result.projectId).toBe('proj-hospital-expansion');
    expect(result.fps).toBe(30);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    // the PLAN's duration is authoritative, whatever sub-range was encoded
    expect(result.durationInFrames).toBe(3563);
    expect(result.authoritativeDurationSeconds).toBe(118.74);
    expect(result.renderedFrameCount).toBe(to - from + 1);
    expect(result.mediaMapEntryCount).toBe(1);
    expect(result.renderedWithAudio).toBe(true);

    // ── real file ─────────────────────────────────────────────────────
    expect(fs.existsSync(outputFile)).toBe(true);
    const size = fs.statSync(outputFile).size;
    expect(size).toBeGreaterThan(0);

    const analysis = await analyseFile(outputFile);
    expect(analysis.codec_name).toBe('h264');
    expect(analysis.width).toBe(canonical.width);
    expect(analysis.height).toBe(canonical.height);
    expect(analysis.r_frame_rate).toBe('30/1');
    expect(analysis.hasAudio).toBe(true);
    expect(analysis.audioCodec).toBe('aac');
    expect(analysis.sizeBytes).toBe(size);
    // the encoded sub-range covers the requested frames, allowing only normal
    // container/audio-priming rounding - this is NOT Phase 5 timing drift
    const expectedSeconds = (to - from + 1) / 30;
    expect(analysis.duration).toBeGreaterThan(expectedSeconds - 0.25);
    expect(analysis.duration).toBeLessThan(expectedSeconds + 0.6);
    // the canonical clip is a tone: prove the stream is audible, not silence
    expect(analysis.longestSilence).toBeLessThan(expectedSeconds / 2);
  }, 900_000);

  it('a plan whose timeline could truncate the authoritative content is rejected before rendering', () => {
    const truncated: RemotionCompositionPlan = {
      ...canonical,
      scenes: canonical.scenes.map((s, i) =>
        i === canonical.scenes.length - 1 ? { ...s, endFrame: s.endFrame - 1, durationInFrames: s.durationInFrames - 1 } : s,
      ),
    };
    const errors = validatePlanForRender(truncated).filter((f) => f.severity === 'error');
    expect(errors.map((e) => e.code)).toContain('PLAN_RENDER_TIMING_MISMATCH');
  });

  it('preserves the locked 118.74s / 3563-frame policy as a structural fact', () => {
    expect(canonical.totalActualDurationSeconds).toBe(PLAN_RENDER_CANONICAL.authoritativeSeconds);
    expect(canonical.durationInFrames).toBe(PLAN_RENDER_CANONICAL.durationInFrames);
    expect(canonical.durationInFrames - 1).toBe(PLAN_RENDER_CANONICAL.lastValidFrame);
    expect(canonical.scenes[canonical.scenes.length - 1]!.endFrame).toBe(3563);
    // the 102s estimator must not size the composition
    expect(canonical.totalEstimatedDurationSeconds).toBe(102);
    expect(canonical.durationInFrames).not.toBe(Math.ceil(102 * 30));
  });
});
