/**
 * Target-media contract (Phase 0): each export target resolves its own scenes,
 * captions, audio, duration and narration - and a Short never inherits the
 * Long audio or Long captions.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_SCHEMA_VERSION,
  SHORT_IDS,
  buildStoryboard,
  captionsByTarget,
  captionsForTarget,
  emptyHistory,
  migrateProject,
  planTargets,
  resolveTargetMedia,
  targetNarration,
  type Project,
  type ProjectInput,
  type TargetAudioMap,
} from '../packages/core/src/index.js';
import { DEMO_PROJECTS } from './fixtures/demo-projects.js';

const ROOT = path.resolve(__dirname, '..');

function makeProject(input: ProjectInput, shortAudioDurations: Partial<Record<'short_1' | 'short_2' | 'short_3', number>> = {}): Project {
  const sb = buildStoryboard({ input, history: emptyHistory(), audioDuration: 94, shortAudioDurations });
  const { historyEntry: _h, ...storyboard } = sb;
  const now = new Date().toISOString();
  return { schemaVersion: PROJECT_SCHEMA_VERSION, meta: { input, brand: sb.brand, createdAt: now, updatedAt: now, status: 'storyboarded' }, storyboard, artifacts: [], qc: [] };
}

const V1 = { ...DEMO_PROJECTS[0], voiceoverFile: 'voiceover/Video_01.mp3' };
const AUDIO: TargetAudioMap = {
  long: { file: '/a/Video_01.mp3', durationSec: 94 },
  short_1: { file: '/a/Video_01_short_1.mp3', durationSec: 31 },
  short_2: { file: '/a/Video_01_short_2.mp3', durationSec: 29 },
  short_3: { file: '/a/Video_01_short_3.mp3', durationSec: 33 },
};
const DUR = { short_1: 31, short_2: 29, short_3: 33 };

describe('target resolver', () => {
  const p = makeProject(V1, DUR);
  const longIds = new Set(p.storyboard.long.scenes.map((s) => s.id));

  it('1. Long resolves to Long scenes, Long captions and Long audio', () => {
    const r = resolveTargetMedia(p, 'long', AUDIO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.media.format).toBe('long');
    expect(r.media.scenes).toBe(p.storyboard.long.scenes);
    expect(r.media.captions).toBe(p.storyboard.captions);
    expect(r.media.audioFile).toBe('/a/Video_01.mp3');
    expect(r.media.durationSec).toBe(p.storyboard.long.totalDuration);
    expect(r.media.narration).toBe(targetNarration(p.storyboard.long.scenes));
  });

  it('2. each Short resolves to its own scenes, captions, audio and duration', () => {
    for (const plan of p.storyboard.shorts) {
      const r = resolveTargetMedia(p, plan.id, AUDIO);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.media.targetId).toBe(plan.id);
      expect(r.media.format).toBe('short');
      expect(r.media.scenes.map((s) => s.id)).toEqual(plan.scenes.map((s) => s.id));
      expect(r.media.audioFile).toBe(AUDIO[plan.id]!.file);
      expect(r.media.durationSec).toBe(plan.totalDuration);
      expect(r.media.narration).toBe(targetNarration(plan.scenes));
      expect(r.media.captions).toEqual(captionsForTarget(p.storyboard, plan.id));
    }
  });

  it('3. no Short receives the Long audio', () => {
    for (const id of SHORT_IDS) {
      const r = resolveTargetMedia(p, id, AUDIO);
      if (r.ok) expect(r.media.audioFile).not.toBe(AUDIO.long!.file);
    }
    // even when a Short is explicitly pointed at the Long file
    const bad = resolveTargetMedia(p, 'short_1', { ...AUDIO, short_1: { file: AUDIO.long!.file, durationSec: 94 } });
    expect(bad.ok).toBe(false);
  });

  it('4. no Short receives captions linked to Long scene ids', () => {
    for (const plan of p.storyboard.shorts) {
      const cues = captionsForTarget(p.storyboard, plan.id);
      expect(cues.length).toBeGreaterThan(0);
      const own = new Set(plan.scenes.map((s) => s.id));
      for (const c of cues) {
        expect(longIds.has(c.sceneId ?? '')).toBe(false);
        expect(own.has(c.sceneId ?? '')).toBe(true);
      }
      expect(cues).not.toEqual(p.storyboard.captions);
    }
  });

  it('5. Short captions are created from that Short\'s narration', () => {
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
    for (const plan of p.storyboard.shorts) {
      const cues = captionsForTarget(p.storyboard, plan.id);
      for (const scene of plan.scenes) {
        const text = cues.filter((c) => c.sceneId === scene.id).map((c) => c.text).join(' ');
        // the glossary may normalise casing/spacing of terms; words are preserved
        expect(norm(text)).toBe(norm(scene.narration).replace(/\bs curve\b/g, 's-curve'));
      }
    }
  });

  it('6. Short caption times stay inside the Short duration, which follows the Short audio', () => {
    for (const plan of p.storyboard.shorts) {
      expect(plan.totalDuration).toBeCloseTo(DUR[plan.id] + 0.3, 1);
      const cues = captionsForTarget(p.storyboard, plan.id);
      for (const c of cues) {
        expect(c.start).toBeGreaterThanOrEqual(0);
        expect(c.end).toBeGreaterThanOrEqual(c.start);
        expect(c.end).toBeLessThanOrEqual(plan.totalDuration);
      }
      const acc = plan.scenes.reduce((a, s) => a + s.duration, 0);
      expect(acc).toBeCloseTo(plan.totalDuration, 1);
    }
  });

  it('7. missing Short audio blocks only that Short, with a clear error naming it', () => {
    const { short_2: _drop, ...partial } = AUDIO;
    const plan = planTargets(p, partial);
    expect(plan.map((r) => r.targetId)).toEqual(['long', 'short_1', 'short_2', 'short_3']);
    const blocked = plan.filter((r) => !r.ok);
    expect(blocked.map((r) => r.targetId)).toEqual(['short_2']);
    const b = blocked[0];
    if (!b.ok) {
      expect(b.error).toContain('Video_01 short_2');
      expect(b.error).toMatch(/missing its own narration audio/);
      expect(b.error).toMatch(/never reused/);
    }
  });

  it('captionsByTarget exposes every target, with the Long alias unchanged', () => {
    const all = captionsByTarget(p.storyboard);
    expect(Object.keys(all)).toEqual(['long', 'short_1', 'short_2', 'short_3']);
    expect(all.long).toBe(p.storyboard.captions);
  });
});

describe('backwards compatibility', () => {
  it('8. a Long-only project (legacy voiceover, no Shorts) stays valid', () => {
    const p = makeProject({ ...V1, shortCount: 0 });
    expect(p.storyboard.shorts).toHaveLength(0);
    const plan = planTargets(p, { long: AUDIO.long });
    expect(plan).toHaveLength(1);
    expect(plan[0].ok).toBe(true);
    // and a project with no audio at all still exports a silent Long, as before
    const silent = resolveTargetMedia(p, 'long', {});
    expect(silent.ok && silent.media.audioFile).toBe(null);
  });

  it('9. a saved v1 project migrates to v2 without losing anything', () => {
    const current = makeProject(V1);
    // reproduce what the previous build wrote to disk
    const v1 = JSON.parse(JSON.stringify(current)) as Project & Record<string, unknown>;
    delete v1.schemaVersion;
    delete (v1.storyboard as Partial<typeof v1.storyboard>).shortCaptions;
    delete (v1.meta.input as Partial<ProjectInput>).targetAudio;
    const before = JSON.parse(JSON.stringify(v1));

    const m = migrateProject(JSON.parse(JSON.stringify(v1)));
    expect(m.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    // nothing existing is removed or rewritten
    expect(m.storyboard.captions).toEqual(before.storyboard.captions);
    expect(m.storyboard.long).toEqual(before.storyboard.long);
    expect(m.storyboard.shorts).toEqual(before.storyboard.shorts);
    expect(m.meta.input.voiceoverFile).toBe('voiceover/Video_01.mp3');
    const { targetAudio, ...restInput } = m.meta.input;
    expect(restInput).toEqual(before.meta.input);
    expect(targetAudio).toEqual({});
    expect(m.artifacts).toEqual(before.artifacts);
    // the legacy voiceover is treated as Long audio only
    expect(planTargets(m, { long: AUDIO.long }).filter((r) => !r.ok).map((r) => r.targetId)).toEqual(['short_1', 'short_2', 'short_3']);
    // Shorts gain their own captions
    for (const plan of m.storyboard.shorts) {
      const own = new Set(plan.scenes.map((s) => s.id));
      expect(m.storyboard.shortCaptions?.[plan.id]?.every((c) => own.has(c.sceneId ?? ''))).toBe(true);
    }
    // idempotent, and a future schema is refused rather than misread
    expect(migrateProject(m)).toBe(m);
    expect(() => migrateProject({ ...m, schemaVersion: PROJECT_SCHEMA_VERSION + 1 })).toThrow(/schema/);
  });
});

describe('offline demo narration', () => {
  it('10. generates a distinct, non-empty audio file for the Long and every Short, spoken from each target\'s own text', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-vo-'));
    try {
      execFileSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'tools/make-demo-voiceovers.mjs'), '--only', 'Video_01', '--out', out], { cwd: ROOT, stdio: 'pipe' });
      const files = ['Video_01.mp3', 'Video_01_short_1.mp3', 'Video_01_short_2.mp3', 'Video_01_short_3.mp3'].map((f) => path.join(out, f));
      const hashes = files.map((f) => {
        expect(fs.existsSync(f)).toBe(true);
        expect(fs.statSync(f).size).toBeGreaterThan(10_000);
        return createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      });
      expect(new Set(hashes).size).toBe(4);

      const require = createRequire(import.meta.url);
      const ffprobe = (require('ffprobe-static') as { path: string }).path;
      const dur = (f: string) => Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
      const longSec = dur(files[0]);
      const sb = buildStoryboard({ input: DEMO_PROJECTS[0], history: emptyHistory() });
      for (const [i, plan] of sb.shorts.entries()) {
        const sec = dur(files[i + 1]);
        // a Short track is not a trimmed copy of the Long: it is its own, shorter speech
        expect(sec).toBeGreaterThan(15);
        expect(sec).toBeLessThanOrEqual(35);
        expect(sec).toBeLessThan(longSec);
        const spoken = fs.readFileSync(path.join(out, `Video_01_${plan.id}.txt`), 'utf8').trim();
        expect(spoken).toBe(targetNarration(plan.scenes));
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
