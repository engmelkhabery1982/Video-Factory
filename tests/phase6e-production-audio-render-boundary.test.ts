/**
 * RETRY-12 defect 1 — Remotion cannot resolve REAL production audio.
 *
 * The single product audio authority is
 * `apps/api/src/services/platform.ts::productionAudioBasePaths(videoId)`:
 *
 *   .production/<videoId>/audio/dialogue
 *   .production/<videoId>/audio/canonical
 *
 * The plan's `audioRefs[].canonicalPath` carries a repo-relative path under
 * that root (e.g. `.production/FinalAcceptance_RFI_Backlog/audio/canonical/
 * t1.wav`) and the composition renders it through `<Audio src={...} />`. The
 * Remotion bundle is served from `.remotion`, so a bare relative src resolves
 * to `.remotion/.production/...` — a path that does not (and must not) exist —
 * and the real render dies with HTTP 404 / PLAN_RENDER_FAILED.
 *
 * Fix contract proven here (no browser needed — the Remotion modules are
 * stubbed at their boundary, while the plan, the composition wiring, the
 * product server route and the REAL files on disk are all exercised):
 *
 *   1. With a live product-server origin set, the props handed to the browser
 *      by `renderCompositionPlan` / `renderPlanStill` point every production
 *      canonical audio src at `GET /media/production-audio/*`, and that route
 *      answers with the EXACT bytes of the real `.production` file.
 *      (This assertion FAILS under the pre-fix code: the boundary exported no
 *      transport at all, so the browser received the bare relative src.)
 *   2. The `.remotion/.production/...` path the failure resolved to is
 *      verified NOT to exist — the fix is the URL transport, never a moved,
 *      copied or duplicated audio root.
 *   3. The plan object itself is never mutated (authority untouched), and
 *      with no server origin the props pass through byte-for-byte unchanged
 *      (existing test transports keep working untouched).
 *   4. Only repo-relative `.production/...` paths are mapped; absolute
 *      URLs/files and non-production relatives pass through. The route is
 *      hardened to `.wav` files of the canonical shape inside the production
 *      audio root — traversal, shape escapes and non-WAV are 404.
 *   5. The composition still consumes `audio.canonicalPath` unchanged and no
 *      substitute/fixture audio is introduced anywhere in the product path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RemotionCompositionPlan } from '@buildtrack/core';

/* Keep every side effect out of the repo's real data/output dirs: platform.ts
   reads these at import time, and vi.hoisted runs before any import. */
const sandbox = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-prodaudio-boundary-'));
  process.env.BUILDTRAKE_DATA = nodePath.join(dir, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(dir, 'output');
  return { dir: dir as string };
});

const captured = vi.hoisted(() => ({
  renderMediaProps: undefined as Record<string, unknown> | undefined,
  selectCompositionProps: undefined as Record<string, unknown> | undefined,
  renderStillProps: undefined as Record<string, unknown> | undefined,
}));

/* Stub ONLY the Remotion transport so the boundary (props construction) runs
   for real without a browser: bundle/select/render are recorded, the output
   file is written so the post-render evidence check proceeds. */
vi.mock('@remotion/bundler', () => ({
  bundle: async () => path.join(process.cwd(), '.remotion'),
}));
vi.mock('@remotion/renderer', () => ({
  selectComposition: async (input: { inputProps?: Record<string, unknown> }) => {
    captured.selectCompositionProps = input.inputProps;
    const plan = input.inputProps?.plan as { fps: number; width: number; height: number; durationInFrames: number };
    return { fps: plan.fps, width: plan.width, height: plan.height, durationInFrames: plan.durationInFrames };
  },
  renderMedia: async (input: { outputLocation: string; inputProps?: Record<string, unknown> }) => {
    captured.renderMediaProps = input.inputProps;
    fs.mkdirSync(path.dirname(input.outputLocation), { recursive: true });
    fs.writeFileSync(input.outputLocation, Buffer.from('%MP4-BOUNDARY-STUB'));
  },
  renderStill: async (input: { output: string; inputProps?: Record<string, unknown> }) => {
    captured.renderStillProps = input.inputProps;
    fs.mkdirSync(path.dirname(input.output), { recursive: true });
    fs.writeFileSync(input.output, Buffer.from('%PNG-BOUNDARY-STUB'));
  },
}));
vi.mock('../apps/api/src/services/media.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    analyseFile: async () => ({
      width: 1080,
      height: 1920,
      r_frame_rate: '30/1',
      codec_name: 'h264',
      duration: 8,
      hasAudio: true,
      audioCodec: 'aac',
      sizeBytes: 1,
    }),
  };
});
vi.mock('../apps/api/src/services/platform.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, chromePath: () => '/usr/bin/vf-boundary-fake-chrome', prepareBrowserEnv: () => undefined };
});

import { ROOT } from '../apps/api/src/services/platform.js';
import {
  getProductionMediaOrigin,
  productionAudioRenderableSrc,
  renderCompositionPlan,
  renderPlanStill,
  setProductionMediaOrigin,
  withRenderableProductionAudio,
} from '../apps/api/src/services/render.js';
import { buildServerApp } from '../apps/api/src/server.js';

/* ------------------------------------------------------------------ */
/*  Scratch authority content — REAL files under the REAL authority    */
/*  root (`.production/` is the git-ignored production scratch). The   */
/*  uniquely named videoId subtree below is removed in afterAll.       */
/* ------------------------------------------------------------------ */

const TEST_VIDEO_ID = 'VF_ProdAudioBoundary_Test';
const AUDIO_ABS_DIR = path.join(ROOT, '.production', TEST_VIDEO_ID, 'audio', 'canonical');
const DIALOGUE_ABS_DIR = path.join(ROOT, '.production', TEST_VIDEO_ID, 'audio', 'dialogue');
const CLIP_NAME = 'sc-a_t1.wav';
/** Deterministic ASCII payload so byte identity survives HTTP transport. */
const WAV_TEXT = 'RIFF-VOICEFACTORY-CANONICAL-PRODUCTION-AUDIO-0001';
const WAV_BYTES = Buffer.from(WAV_TEXT, 'ascii');

const productionRelPath = (file = CLIP_NAME) => `.production/${TEST_VIDEO_ID}/audio/canonical/${file}`;

function makeShortPlan(canonicalPath: string): RemotionCompositionPlan {
  const fps = 30;
  const totalFrames = 240;
  return {
    version: '1.0.0',
    scenarioId: 'audio-boundary-short',
    projectId: 'proj-audio-boundary',
    targetFormat: 'Short',
    fps,
    width: 1080,
    height: 1920,
    durationInFrames: totalFrames,
    totalActualDurationSeconds: totalFrames / fps,
    totalEstimatedDurationSeconds: 11,
    characters: [],
    scenes: [
      {
        sceneId: 'sc-a',
        rendererKey: 'explanation:key_statement',
        startFrame: 0,
        endFrame: totalFrames,
        durationInFrames: totalFrames,
        actualStartSeconds: 0,
        actualEndSeconds: totalFrames / fps,
        actualDurationSeconds: totalFrames / fps,
        transition: { type: 'cut', durationInFrames: 0 },
        visualTreatment: { accent: '#3B82F6' },
        assetRefs: [],
        audioRefs: [
          {
            clipId: 'clip_sc-a_t1',
            canonicalPath,
            actualStartSeconds: 0,
            actualEndSeconds: totalFrames / fps,
            actualDurationSeconds: totalFrames / fps,
            durationInFrames: totalFrames,
            localStartFrame: 0,
            localDurationInFrames: totalFrames,
          },
        ],
        captionCues: [
          {
            id: 'cue-sc-a-1',
            sceneId: 'sc-a',
            sceneIndex: 0,
            turnId: 'sc-a-t1',
            turnIndex: 0,
            globalTurnIndex: 0,
            clipId: 'clip_sc-a_t1',
            text: 'Real production audio for the boundary test.',
            speakerId: 'char-x',
            voiceSlot: 'voice_en_female_authority',
            startTimeSeconds: 0,
            endTimeSeconds: totalFrames / fps,
            startFrame: 0,
            endFrame: totalFrames,
            durationInFrames: totalFrames,
            localStartFrame: 0,
            localEndFrame: totalFrames,
            localStartSeconds: 0,
            localEndSeconds: totalFrames / fps,
          },
        ],
        beats: [],
      },
    ],
  } as unknown as RemotionCompositionPlan;
}

function audioSrcsOf(props: Record<string, unknown> | undefined): string[] {
  const plan = props?.plan as { scenes: Array<{ audioRefs: Array<{ canonicalPath: string }> }> };
  return plan.scenes.flatMap((s) => s.audioRefs.map((a) => a.canonicalPath));
}

let app: FastifyInstance | null = null;
const outDir = path.join(sandbox.dir, 'renders');

beforeAll(async () => {
  fs.mkdirSync(AUDIO_ABS_DIR, { recursive: true });
  fs.writeFileSync(path.join(AUDIO_ABS_DIR, CLIP_NAME), WAV_BYTES);
  // A WAV OUTSIDE the two canonical subdirs and a non-WAV INSIDE them, both
  // for route-shape checks:
  fs.mkdirSync(path.join(ROOT, '.production', TEST_VIDEO_ID, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.production', TEST_VIDEO_ID, 'notes', 'secret.wav'), Buffer.from('NO'));
  fs.mkdirSync(DIALOGUE_ABS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DIALOGUE_ABS_DIR, 'not-audio.txt'), Buffer.from('NO'));
  app = await buildServerApp();
  await app.ready();
});

afterEach(() => {
  setProductionMediaOrigin(null);
  captured.renderMediaProps = undefined;
  captured.selectCompositionProps = undefined;
  captured.renderStillProps = undefined;
});

afterAll(async () => {
  await app?.close();
  try {
    fs.rmSync(path.join(ROOT, '.production', TEST_VIDEO_ID), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(sandbox.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* ------------------------------------------------------------------ */

describe('Production audio at the Remotion render boundary (retry-12 defect 1)', () => {
  it('reproduces the acceptance precondition: the bundle-root path the old render resolved does NOT exist, the real file does', () => {
    // This is exactly the acceptance failure shape: the bundle is served
    // from `.remotion`, so a relative `.production/...` src would be looked
    // up at `.remotion/.production/...`, which never exists (and must not).
    const bundleResolved = path.join(ROOT, '.remotion', '.production', TEST_VIDEO_ID, 'audio', 'canonical', CLIP_NAME);
    expect(fs.existsSync(bundleResolved)).toBe(false);
    expect(fs.existsSync(path.join(AUDIO_ABS_DIR, CLIP_NAME))).toBe(true);
    // Without a live origin the boundary is pure passthrough, so the old
    // (failing) relative src is what a render would still receive:
    expect(getProductionMediaOrigin()).toBeNull();
    const plan = makeShortPlan(productionRelPath());
    expect(productionAudioRenderableSrc(productionRelPath())).toBeNull();
    expect(withRenderableProductionAudio(plan)).toBe(plan);
  });

  it('maps ONLY the canonicalPath of real production-relative audio, leaving every other field and the plan object untouched', () => {
    setProductionMediaOrigin('http://127.0.0.1:41234');
    const plan = makeShortPlan(productionRelPath());
    const before = structuredClone(plan);
    const mapped = withRenderableProductionAudio(plan);

    expect(mapped).not.toBe(plan); // a copy is handed to the browser
    expect(plan).toEqual(before); // ...and the authority plan was NOT mutated

    const src = mapped.scenes[0].audioRefs[0].canonicalPath;
    expect(src).toBe('http://127.0.0.1:41234/media/production-audio/VF_ProdAudioBoundary_Test/audio/canonical/sc-a_t1.wav');

    // Only that field differs — timing, ids, order, clip ids, everything else identical.
    const strip = (p: RemotionCompositionPlan) =>
      JSON.parse(
        JSON.stringify({
          ...p,
          scenes: p.scenes.map((s) => ({ ...s, audioRefs: s.audioRefs.map((a) => ({ ...a, canonicalPath: '<S>' })) })),
        }),
      );
    expect(strip(mapped)).toEqual(strip(plan));

    // Selective passthrough: absolute URLs, absolute fs paths and
    // non-production relative paths are never touched.
    expect(productionAudioRenderableSrc('http://127.0.0.1:9/dialogue.wav?clip=x')).toBeNull();
    expect(productionAudioRenderableSrc('file:///abs/dialogue.wav')).toBeNull();
    expect(productionAudioRenderableSrc('/abs/path/dialogue.wav')).toBeNull();
    expect(productionAudioRenderableSrc('audio/canonical/x.wav')).toBeNull();
    expect(productionAudioRenderableSrc('.production/V/audio/canonical/x.mp3')).toBeNull();
    expect(productionAudioRenderableSrc('.production/../etc/passwd')).toBeNull();
    expect(productionAudioRenderableSrc('')).toBeNull();
    expect(productionAudioRenderableSrc(undefined)).toBeNull();
  });

  it('recognizes the exact failing acceptance path shape (.production/FinalAcceptance_RFI_Backlog/audio/...)', () => {
    setProductionMediaOrigin('http://127.0.0.1:3000');
    expect(productionAudioRenderableSrc('.production/FinalAcceptance_RFI_Backlog/audio/canonical/clip_1.wav')).toBe(
      'http://127.0.0.1:3000/media/production-audio/FinalAcceptance_RFI_Backlog/audio/canonical/clip_1.wav',
    );
    expect(productionAudioRenderableSrc('.production/FinalAcceptance_RFI_Backlog/audio/dialogue/clip_1.wav')).toBe(
      'http://127.0.0.1:3000/media/production-audio/FinalAcceptance_RFI_Backlog/audio/dialogue/clip_1.wav',
    );
  });

  it('renderCompositionPlan hands the browser production audio the LIVE PRODUCT SERVER can serve, from the real authority files', async () => {
    setProductionMediaOrigin('http://127.0.0.1:41234');
    const plan = makeShortPlan(productionRelPath());
    const outputFile = path.join(outDir, 'short_1.mp4');

    await renderCompositionPlan({ plan, outputFile, mediaMap: {}, quality: 'final' });

    // One builder => select and render received identical mapped props.
    expect(captured.selectCompositionProps).toBeDefined();
    expect(captured.renderMediaProps).toEqual(captured.selectCompositionProps);

    const srcs = audioSrcsOf(captured.renderMediaProps);
    expect(srcs.length).toBe(1);
    const url = new URL(srcs[0]!);
    // No longer a `.remotion/.production/...` candidate: an absolute,
    // resolvable product-server URL.
    expect(url.protocol).toBe('http:');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/media/production-audio/VF_ProdAudioBoundary_Test/audio/canonical/sc-a_t1.wav');
    expect(srcs[0]!.startsWith('.production/')).toBe(false);

    // Fetchability proof: the live product server answers THAT url with the
    // exact bytes of the real `.production` file — no fixture, no synthesis.
    const res = await app!.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('audio/wav');
    expect(res.body).toBe(WAV_TEXT);

    // The authority still lives at `.production` and was never moved or
    // copied into the bundle: the old resolution target does not exist.
    expect(fs.existsSync(path.join(ROOT, '.remotion', '.production'))).toBe(false);
    expect(fs.readFileSync(path.join(AUDIO_ABS_DIR, CLIP_NAME)).equals(WAV_BYTES)).toBe(true);
  }, 60_000);

  it('renderPlanStill receives the identical transport mapping', async () => {
    setProductionMediaOrigin('http://127.0.0.1:41234');
    const plan = makeShortPlan(productionRelPath());
    await renderPlanStill({ plan, output: path.join(outDir, 'still.png'), frame: 12, mediaMap: {} });
    expect(audioSrcsOf(captured.renderStillProps)).toEqual([
      'http://127.0.0.1:41234/media/production-audio/VF_ProdAudioBoundary_Test/audio/canonical/sc-a_t1.wav',
    ]);
  }, 60_000);

  it('without a live origin the browser props pass through byte-for-byte unchanged (no legacy fallback, no substitute)', async () => {
    setProductionMediaOrigin(null);
    const plan = makeShortPlan(productionRelPath());
    await renderCompositionPlan({ plan, outputFile: path.join(outDir, 'passthru.mp4'), mediaMap: {}, quality: 'preview' });
    expect(audioSrcsOf(captured.renderMediaProps)).toEqual([productionRelPath()]);
    expect(getProductionMediaOrigin()).toBeNull();
  }, 60_000);

  it('the composition still renders the plan field directly (the boundary was fixed, not the content)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'packages/video/src/compositions/VideoCompositionPlan.tsx'), 'utf8');
    expect(src).toContain('<Audio src={audio.canonicalPath}');
    expect(src).not.toMatch(/tests\/fixtures\/render\/dialogue\.wav/);
  });
});

describe('/media/production-audio route (read-only transport, media-security hardened)', () => {
  const inject = (url: string) => app!.inject({ method: 'GET', url });

  it('serves the real canonical WAV for a well-formed rel path', async () => {
    const res = await inject(`/media/production-audio/${TEST_VIDEO_ID}/audio/canonical/${CLIP_NAME}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(WAV_TEXT);
  });

  it('404s traversal, shape escapes, missing files and non-WAV content', async () => {
    expect((await inject(`/media/production-audio/..%2f..%2fpackage.json`)).statusCode).toBe(404);
    expect((await inject(`/media/production-audio/${TEST_VIDEO_ID}/audio/canonical/..%2f..%2f..%2f..%2fpackage.json`)).statusCode).toBe(404);
    // Outside the <videoId>/audio/<canonical|dialogue>/<file>.wav shape:
    expect((await inject(`/media/production-audio/${TEST_VIDEO_ID}/notes/secret.wav`)).statusCode).toBe(404);
    expect((await inject(`/media/production-audio/${TEST_VIDEO_ID}/audio/canonical/`)).statusCode).toBe(404);
    // Inside the shape but not WAV:
    expect((await inject(`/media/production-audio/${TEST_VIDEO_ID}/audio/dialogue/not-audio.txt`)).statusCode).toBe(404);
    // Missing file:
    expect((await inject(`/media/production-audio/${TEST_VIDEO_ID}/audio/canonical/nope.wav`)).statusCode).toBe(404);
    // Backslash trickery never selects a file:
    expect((await inject(`/media/production-audio/${TEST_VIDEO_ID}\\..\\package.json`)).statusCode).toBe(404);
  });
});
