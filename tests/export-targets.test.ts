/**
 * Export-level regression test for target-specific audio and captions.
 *
 * The renderer and ffmpeg are replaced with recorders so the test sees exactly
 * which scenes, captions, audio file and duration each target was given. This
 * is the semantic mismatch the old suite could not detect: every Short was
 * rendered with the Long captions and muxed with the Long narration.
 *
 * Deliberately imports only APIs that already existed before the fix, so the
 * same file can be run against the old pipeline and shown to fail there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  // must be set before platform.ts is evaluated
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-export-'));
  process.env.BUILDTRAKE_DATA = nodePath.join(dir, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(dir, 'output');
  return { dir };
});

const calls = vi.hoisted(() => ({
  render: [] as { format: string; scenes: { id: string }[]; captions: { sceneId: string | null; start: number; end: number; text: string }[]; outputFile: string }[],
  mux: [] as { audioFile: string | null | undefined; outFile: string; durationSec?: number }[],
}));

vi.mock('../apps/api/src/services/render.js', () => ({
  exportSpecFor: (f: 'long' | 'short') => ({ width: f === 'long' ? 1920 : 1080, height: f === 'long' ? 1080 : 1920, fps: 30 }),
  renderTarget: async (t: (typeof calls.render)[number]) => {
    calls.render.push(t);
    return { rawVideo: t.outputFile.replace(/\.mp4$/, '.raw.mp4'), spec: {} };
  },
  muxAndEncode: async (m: (typeof calls.mux)[number]) => {
    calls.mux.push(m);
  },
  renderThumbnails: async () => [],
}));
vi.mock('../apps/api/src/services/media.js', () => ({
  analyseFile: async () => {
    throw new Error('not used: no encoded file exists in this test');
  },
  contactSheet: async () => undefined,
  durationOf: async () => 0,
}));

import { buildStoryboard, emptyHistory, type Project } from '../packages/core/src/index.js';
import { DEMO_PROJECTS } from './fixtures/demo-projects.js';
import { exportProject } from '../apps/api/src/services/pipeline.js';

const input = { ...DEMO_PROJECTS[0], voiceoverFile: 'voiceover/Video_01.mp3' };
const LONG_AUDIO = path.join(tmp.dir, 'Video_01.mp3');
const shortAudio = (id: string) => path.join(tmp.dir, `Video_01_${id}.mp3`);

function project(): Project {
  const sb = buildStoryboard({ input, history: emptyHistory(), audioDuration: 94 });
  const { historyEntry: _h, ...storyboard } = sb;
  const now = new Date().toISOString();
  return { meta: { input, brand: sb.brand, createdAt: now, updatedAt: now, status: 'storyboarded' }, storyboard, artifacts: [], qc: [] } as Project;
}

describe('export: every target renders with its own audio and captions', () => {
  let p: Project;
  let results: { target: string; blocked: boolean; blockReason: string }[];

  beforeAll(async () => {
    for (const f of [LONG_AUDIO, shortAudio('short_1'), shortAudio('short_2'), shortAudio('short_3')]) fs.writeFileSync(f, 'x');
    p = project();
    const res = await exportProject(p, {
      kind: 'preview',
      videoId: 'Video_01',
      includeThumbnails: false,
      history: emptyHistory(),
      assets: [],
      ctaAnimation: 'slide_in',
      captionStyle: 'boxed_center',
      targetAudio: {
        long: { file: LONG_AUDIO, durationSec: 94 },
        short_1: { file: shortAudio('short_1'), durationSec: 30 },
        short_2: { file: shortAudio('short_2'), durationSec: 30 },
        short_3: { file: shortAudio('short_3'), durationSec: 30 },
      },
    } as never);
    results = res.results;
  });

  it('renders the Long and all three Shorts', () => {
    expect(calls.render.map((r) => path.basename(r.outputFile))).toEqual([
      'Video_01_long_preview.mp4',
      'Video_01_short_1_preview.mp4',
      'Video_01_short_2_preview.mp4',
      'Video_01_short_3_preview.mp4',
    ]);
    expect(results.every((r) => !r.blocked || !/audio/i.test(r.blockReason))).toBe(true);
  });

  it('muxes the Long with the Long audio and each Short with its own audio, never the Long audio', () => {
    expect(calls.mux[0].audioFile).toBe(LONG_AUDIO);
    for (const [i, id] of ['short_1', 'short_2', 'short_3'].entries()) {
      const m = calls.mux[i + 1];
      expect(m.outFile).toContain(id);
      expect(m.audioFile).toBe(shortAudio(id));
      expect(m.audioFile).not.toBe(LONG_AUDIO);
    }
  });

  it('renders each Short with captions that reference only that Short and fit inside it', () => {
    const longIds = new Set(p.storyboard.long.scenes.map((s) => s.id));
    for (const [i, plan] of p.storyboard.shorts.entries()) {
      const r = calls.render[i + 1];
      expect(r.format).toBe('short');
      expect(r.scenes.map((s) => s.id)).toEqual(plan.scenes.map((s) => s.id));
      const own = new Set(plan.scenes.map((s) => s.id));
      expect(r.captions.length).toBeGreaterThan(0);
      for (const c of r.captions) {
        expect(longIds.has(c.sceneId ?? '')).toBe(false);
        expect(own.has(c.sceneId ?? '')).toBe(true);
        expect(c.end).toBeLessThanOrEqual(plan.totalDuration + 1e-6);
      }
      expect(calls.mux[i + 1].durationSec).toBe(plan.totalDuration);
    }
  });

  it('writes separate caption files for the Long and every Short, keeping the legacy Long names', () => {
    const dir = path.join(process.env.BUILDTRAKE_OUTPUT!, 'Video_01', 'captions');
    for (const stem of ['Video_01', 'Video_01_long', 'Video_01_short_1', 'Video_01_short_2', 'Video_01_short_3']) {
      for (const ext of ['srt', 'vtt', 'json']) expect(fs.existsSync(path.join(dir, `${stem}.${ext}`))).toBe(true);
    }
    const legacy = JSON.parse(fs.readFileSync(path.join(dir, 'Video_01.json'), 'utf8'));
    expect(legacy.cues).toEqual(p.storyboard.captions);
    const s1 = JSON.parse(fs.readFileSync(path.join(dir, 'Video_01_short_1.json'), 'utf8'));
    const s1Ids = new Set(p.storyboard.shorts[0].scenes.map((s) => s.id));
    expect(s1.cues.every((c: { sceneId: string }) => s1Ids.has(c.sceneId))).toBe(true);
  });
});

describe('export: a Short without its own audio', () => {
  it('blocks only that Short, names it, and still exports the Long and the other Shorts', async () => {
    calls.render.length = 0;
    calls.mux.length = 0;
    const p = project();
    const res = await exportProject(p, {
      kind: 'preview',
      videoId: 'Video_01',
      includeThumbnails: false,
      history: emptyHistory(),
      assets: [],
      ctaAnimation: 'slide_in',
      captionStyle: 'boxed_center',
      targetAudio: {
        long: { file: LONG_AUDIO, durationSec: 94 },
        short_1: { file: shortAudio('short_1'), durationSec: 30 },
        short_3: { file: shortAudio('short_3'), durationSec: 30 },
      },
    } as never);
    const s2 = res.results.find((r) => r.target === 'short_2');
    expect(s2?.blocked).toBe(true);
    expect(s2?.file).toBe('');
    expect(s2?.blockReason).toMatch(/short_2/);
    expect(s2?.blockReason).toMatch(/missing its own narration audio/);
    expect(calls.render.map((r) => path.basename(r.outputFile))).toEqual(['Video_01_long_preview.mp4', 'Video_01_short_1_preview.mp4', 'Video_01_short_3_preview.mp4']);
    expect(calls.mux.map((m) => m.audioFile)).toEqual([LONG_AUDIO, shortAudio('short_1'), shortAudio('short_3')]);
  });
});

describe('export: the project-wide audio/caption contract is gone', () => {
  it('rejects a single project-wide audioFile instead of reusing it for every target', async () => {
    calls.render.length = 0;
    await expect(
      exportProject(project(), {
        kind: 'preview',
        videoId: 'Video_01',
        history: emptyHistory(),
        assets: [],
        ctaAnimation: 'slide_in',
        captionStyle: 'boxed_center',
        audioFile: LONG_AUDIO,
      } as never),
    ).rejects.toThrow(/targetAudio/);
    expect(calls.render).toHaveLength(0);
  });
});

describe('store: saved projects', () => {
  it('loads a v1 project.json from disk through the explicit migration, keeping Long captions and voiceover', async () => {
    const { loadProject } = await import('../apps/api/src/services/store.js');
    const v1 = JSON.parse(JSON.stringify(project())) as Record<string, any>;
    delete v1.schemaVersion;
    delete v1.storyboard.shortCaptions;
    v1.meta.input.videoId = 'Video_09';
    const dir = path.join(process.env.BUILDTRAKE_DATA!, 'projects', 'Video_09');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(v1));
    const loaded = loadProject('Video_09')!;
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.storyboard.captions).toEqual(v1.storyboard.captions);
    expect(loaded.meta.input.voiceoverFile).toBe('voiceover/Video_01.mp3');
    expect(Object.keys(loaded.storyboard.shortCaptions ?? {})).toEqual(['short_1', 'short_2', 'short_3']);
  });
});
