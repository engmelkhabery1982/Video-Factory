/**
 * Phase 0A regression tests:
 *  1. burned captions: seconds vs frames
 *  2. target-specific static QC and key numbers
 *  3. no repeated narration inside a Short
 *  4. realistic narration-rate contract in the demo generator
 *  5. Short timing within readability limits
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SHORT_TIMING,
  buildShortCaptions,
  buildStoryboard,
  emptyHistory,
  fitShortToAudio,
  narrationSentences,
  normSentence,
  shortKeyNumberFindings,
  spokenWordCount,
  staticQc,
  targetStaticQc,
  type ShortPlan,
  type Storyboard,
} from '../packages/core/src/index.js';
import { activeCue, captionAppear, cueStartFrame, isCueLive } from '../packages/video/src/captions/timing.js';
import { DEMO_PROJECTS } from './fixtures/demo-projects.js';

const ROOT = path.resolve(__dirname, '..');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const boards = DEMO_PROJECTS.map((input) => ({ input, sb: buildStoryboard({ input, history: emptyHistory(), audioDuration: 94 }) }));

/* ------------------------------------------------------------------ */
describe('burned captions are timed in seconds, rendered in frames', () => {
  const cue = { id: 'c', start: 1.0, end: 2.0, text: 'hello', terms: [], sceneId: 's', userEdited: false };

  it.each([24, 25, 30, 60])('a 1.0-2.0s cue is live exactly on its frames at %i fps', (fps) => {
    const first = fps * 1;
    const lastExclusive = fps * 2;
    expect(isCueLive(cue, first - 1, fps)).toBe(false);
    expect(isCueLive(cue, first, fps)).toBe(true);
    expect(isCueLive(cue, Math.floor((first + lastExclusive) / 2), fps)).toBe(true);
    expect(isCueLive(cue, lastExclusive - 1, fps)).toBe(true);
    expect(isCueLive(cue, lastExclusive, fps)).toBe(false);
    expect(isCueLive(cue, 0, fps)).toBe(false);
    // the old defect compared the frame number with seconds: frame 1 was "live"
    expect(isCueLive(cue, 1, fps)).toBe(false);
  });

  it('the entrance animation starts at the cue\'s real start frame at any fps', () => {
    for (const fps of [25, 30, 60]) {
      const f0 = cueStartFrame(cue, fps);
      expect(f0).toBe(fps);
      expect(captionAppear(cue, f0 - 1, fps)).toBe(0);
      expect(captionAppear(cue, f0, fps)).toBe(0);
      expect(captionAppear(cue, f0 + 2, fps)).toBeCloseTo(0.5);
      expect(captionAppear(cue, f0 + 4, fps)).toBe(1);
    }
  });

  it('every Long cue is shown during its own interval and nowhere else', () => {
    const cues = boards[0].sb.captions;
    const fps = 30;
    for (const c of cues) {
      const mid = Math.round(((c.start + c.end) / 2) * fps);
      expect(activeCue(cues, mid, fps)?.id).toBe(c.id);
    }
    const lastEnd = Math.max(...cues.map((c) => c.end));
    expect(activeCue(cues, Math.round(lastEnd * fps) + 1, fps)).toBeUndefined();
  });

  it('the caption component uses the fps-aware helpers, not a raw frame-vs-seconds compare', () => {
    const src = fs.readFileSync(path.join(ROOT, 'packages/video/src/captions/Captions.tsx'), 'utf8');
    expect(src).toMatch(/useVideoConfig\(\)/);
    expect(src).toMatch(/activeCue\(cues, f, fps\)/);
    expect(src).not.toMatch(/f >= c\.start/);
    expect(src).not.toMatch(/Math\.round\(live\.start\)/);
  });
});

/* ------------------------------------------------------------------ */
describe('static QC is target-specific', () => {
  const titles = (fs: { title: string; detail: string }[]) => fs.map((f) => `${f.title}: ${f.detail}`).join('\n');

  it('a defect in short_2 does not appear in the short_1 report, and a short_1 defect does', () => {
    const sb = clone(boards[0].sb) as Storyboard;
    sb.shorts[1].scenes[0].duration = 7; // short_2 hook too slow
    sb.shorts[1].scenes[2].content.headline = 'TODO fix this'; // short_2 placeholder (critical)
    const s1 = targetStaticQc(sb, 'short_1');
    expect(titles(s1)).not.toMatch(/short_2/);
    expect(s1.some((f) => f.severity === 'critical')).toBe(false);
    const s2 = targetStaticQc(sb, 'short_2');
    expect(titles(s2)).toMatch(/short_2 hook lasts 7\.0s/);
    expect(s2.some((f) => f.title === 'Placeholder text in short')).toBe(true);

    sb.shorts[0].scenes[3].content.headline = 'lorem ipsum';
    const s1b = targetStaticQc(sb, 'short_1');
    expect(s1b.some((f) => f.title === 'Placeholder text in short' && /short_1/.test(f.detail))).toBe(true);
  });

  it('Long findings stay out of Short reports and Short findings stay out of the Long report', () => {
    const sb = clone(boards[0].sb) as Storyboard;
    sb.long.scenes = sb.long.scenes.filter((s) => s.role !== 'cta'); // Long defect
    sb.shorts[2].scenes[0].duration = 9; // short_3 defect
    const s1 = targetStaticQc(sb, 'short_1');
    expect(s1.some((f) => f.title === 'CTA count is not exactly one')).toBe(false);
    expect(titles(s1)).not.toMatch(/short_3/);
    const long = targetStaticQc(sb, 'long');
    expect(long.some((f) => f.title === 'CTA count is not exactly one')).toBe(true);
    expect(titles(long)).not.toMatch(/short_\d/);
    // the explicit project-wide check still sees everything
    const all = titles(staticQc(sb, emptyHistory()));
    expect(all).toMatch(/CTA count is not exactly one/);
    expect(all).toMatch(/short_3 hook lasts 9\.0s/);
  });

  it('short key numbers: only numbers the Short uses, checked against the Short\'s own screen', () => {
    const sb = clone(boards[0].sb) as Storyboard;
    const plan = sb.shorts[0];
    const keys = ['70%', '59.5%', '10.5%', '5%'];
    // a Short that uses none of the numbers -> not applicable, not a pass-by-Long
    const bare: ShortPlan = { ...plan, scenes: plan.scenes.map((s) => ({ ...s, narration: 'No figures here.', content: { ...s.content, headline: 'Plain', subline: '', items: [], stat: null, stat2: null } })) };
    const na = shortKeyNumberFindings(keys, bare);
    expect(na).toHaveLength(1);
    expect(na[0].title).toMatch(/not applicable/);
    // speaks 42% but never shows it -> reported, even though the Long is irrelevant
    const spoken: ShortPlan = { ...bare, scenes: bare.scenes.map((s, i) => (i === 1 ? { ...s, narration: 'The gap is 42% today.' } : s)) };
    const miss = shortKeyNumberFindings(['42%', ...keys], spoken);
    expect(miss[0].title).toBe('Spoken key number not on screen');
    expect(miss[0].detail).toMatch(/42%/);
    expect(miss[0].detail).not.toMatch(/59\.5%/); // not used by this Short -> not checked
    // shown on the Short's screen -> pass
    const shown: ShortPlan = { ...spoken, scenes: spoken.scenes.map((s, i) => (i === 1 ? { ...s, content: { ...s.content, stat: '42%' } } : s)) };
    expect(shortKeyNumberFindings(['42%'], shown)[0].severity).toBe('pass');
  });
});

/* ------------------------------------------------------------------ */
describe('Short narration is never repeated', () => {
  it.each(boards.map((b) => [b.input.videoId, b]))('%s: no normalised sentence is spoken twice in any Short', (_id, b) => {
    const { sb, input } = b as (typeof boards)[number];
    for (const short of sb.shorts) {
      // body beats may be halves of one sentence, so re-join the full narration
      const sentences = narrationSentences(short.scenes.map((s) => s.narration).join(' '));
      const dup = sentences.filter((s, i) => sentences.indexOf(s) !== i);
      expect(dup, `${short.id}: ${dup.join(' | ')}`).toEqual([]);

      const hook = short.scenes[0];
      // concise hook: <= 3s of speech, and it is what is on screen
      expect(spokenWordCount(hook.narration)).toBeLessThanOrEqual(6);
      expect(normSentence(hook.content.headline)).toBe(normSentence(hook.narration));
      // the hook's words are not restated by the body beats
      const body = normSentence(short.scenes.slice(1, -1).map((s) => s.narration).join(' '));
      expect(body.includes(normSentence(hook.narration))).toBe(false);
      // the CTA does not repeat an earlier explanatory sentence
      const cta = short.scenes[short.scenes.length - 1];
      expect(cta.role).toBe('cta');
      expect(cta.narration).toBe(input.cta);
      expect(narrationSentences(short.scenes.slice(0, -1).map((s) => s.narration).join(' '))).not.toContain(normSentence(input.cta));
    }
  });

  it('is deterministic for the same input and history', () => {
    const again = buildStoryboard({ input: DEMO_PROJECTS[0], history: emptyHistory(), audioDuration: 94 });
    expect(again.shorts.map((s) => s.scenes.map((x) => x.narration))).toEqual(boards[0].sb.shorts.map((s) => s.scenes.map((x) => x.narration)));
  });

  it('keeps each Short inside a budget a natural voice can speak in 20-35s', () => {
    for (const { sb } of boards) {
      for (const short of sb.shorts) {
        const words = short.scenes.reduce((a, s) => a + spokenWordCount(s.narration), 0);
        expect(words).toBeLessThanOrEqual(35 * 2.2);
        expect(short.totalDuration).toBeGreaterThanOrEqual(20);
        expect(short.totalDuration).toBeLessThanOrEqual(35);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
describe('Short timing follows its audio within readability limits', () => {
  const plan = boards[0].sb.shorts[0];

  it('uses exact per-scene speech timing when the texts match', () => {
    const timing = plan.scenes.map((s, i) => ({ text: s.narration, duration: i === 0 ? 2.9 : i === plan.scenes.length - 1 ? 5 : 2 }));
    const total = timing.reduce((a, t) => a + t.duration, 0);
    const fitted = fitShortToAudio(plan, total, timing);
    expect(fitted.scenes.slice(0, -1).map((s) => s.duration)).toEqual(timing.slice(0, -1).map((t) => t.duration));
    expect(fitted.totalDuration).toBeCloseTo(total + SHORT_TIMING.tail, 2);
    for (const c of buildShortCaptions(fitted)) expect(c.end).toBeLessThanOrEqual(fitted.totalDuration);
    // mismatched text -> timing ignored, falls back to bounded weights
    const stale = timing.map((t, i) => (i === 1 ? { ...t, text: 'something else' } : t));
    expect(fitShortToAudio(plan, total, stale).scenes[1].duration).not.toBe(2);
  });

  it('without timing, keeps the hook <= 3s and body beats within 1.5-3.2s', () => {
    const fitted = fitShortToAudio(plan, 26);
    expect(fitted.scenes[0].duration).toBeLessThanOrEqual(SHORT_TIMING.hookMax + 1e-6);
    for (const s of fitted.scenes.filter((x) => x.role === 'body')) {
      expect(s.duration).toBeGreaterThanOrEqual(SHORT_TIMING.bodyMin - 1e-6);
      expect(s.duration).toBeLessThanOrEqual(SHORT_TIMING.bodyMax + 1e-6);
    }
    expect(fitted.totalDuration).toBeCloseTo(26.3, 1);
  });
});

/* ------------------------------------------------------------------ */
describe('demo narration rate contract', () => {
  it('refuses to accelerate an over-long Short and says "Short narration is too long"', async () => {
    const gen = await import('../tools/make-demo-voiceovers.mjs');
    const { default: SamJs } = await import('sam-js');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-long-'));
    try {
      const para = 'This beat keeps talking about progress, certificates and the gap between them for far too long.';
      const texts = Array.from({ length: 12 }, () => para);
      expect(() => gen.synthShort(SamJs, texts, path.join(out, 'x.mp3'), 'Video_99_short_1')).toThrow(/Short narration is too long: Video_99_short_1/);
      expect(fs.existsSync(path.join(out, 'x.mp3'))).toBe(false);
      expect(gen.SHORT_FASTEST_SPEED).toBeGreaterThanOrEqual(56);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
