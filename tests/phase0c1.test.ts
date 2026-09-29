/**
 * Phase 0C.1 - natural caption phrases and semantic section labels.
 */
import { describe, expect, it } from 'vitest';
import {
  PORTRAIT,
  buildShortCaptions,
  buildStoryboard,
  isCaptionFragment,
  portraitCaptionBottom,
  portraitSafeZoneFindings,
  resolveTargetMedia,
  sectionForScene,
  targetStaticQc,
  type Storyboard,
} from '../packages/core/src/index';
import { emptyHistory } from '../packages/core/src/history';
import { DEMO_PROJECTS } from './fixtures/demo-projects';

const boards = DEMO_PROJECTS.map((p) => buildStoryboard({ input: p, history: emptyHistory() }) as Storyboard);
const v01 = boards[0];
const s1 = v01.shorts[0];
const cues = buildShortCaptions(s1);
const texts = cues.map((c) => c.text);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const S1 = 'That 10.5 percent gap is not a rounding error.';
const S2 = 'It is a commercial risk sitting inside your project.';
const S3 = 'So where does the gap actually come from?';
const CTA = 'Start your BuildTrack trial and see your executed-vs-accepted gap every week.';

describe('1-3. one natural caption per source sentence', () => {
  it('adjacent beats of the same sentence produce ONE caption sentence', () => {
    for (const s of [S1, S2, S3]) expect(texts).toContain(s);
    // the beats themselves are still separate scenes (timing + emphasis intact)
    expect(s1.scenes.filter((x) => x.content.source === S1)).toHaveLength(2);
    expect(s1.scenes.filter((x) => x.content.source === S1).map((x) => x.content.emphasis)).toEqual(['That 10.5 percent', 'gap is not a rounding error.']);
  });

  it('no source sentence is captioned twice', () => {
    for (const s of [S1, S2, S3]) expect(texts.filter((t) => t === s)).toHaveLength(1);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('the known fragment captions are gone, in every demo Short', () => {
    for (const bad of ['That 10.5 percent', 'It is a commercial', 'So where does', 'gap is not a rounding error.', 'risk sitting inside your project.']) {
      expect(texts).not.toContain(bad);
    }
    for (const sb of boards) for (const sh of sb.shorts) {
      const sentences = sh.scenes.map((x) => x.content.source ?? x.narration).filter(Boolean) as string[];
      sentences.sort((a, b) => b.length - a.length);
      for (const c of buildShortCaptions(sh)) expect(`${sh.id} "${c.text}" fragment=${isCaptionFragment(c.text, sentences)}`).toContain('fragment=false');
    }
  });
});

describe('4-6. semantic caption-fragment rule', () => {
  const known = [S1, S2, S3, CTA, 'Why?', 'Three checks decide it.'];
  it('catches fragments of three or more words', () => {
    expect(isCaptionFragment('That 10.5 percent', known)).toBe(true);
    expect(isCaptionFragment('It is a commercial', known)).toBe(true);
    expect(isCaptionFragment('So where does', known)).toBe(true);
    expect(isCaptionFragment('gap is not a rounding error.', known)).toBe(true);
  });

  it('accepts genuine short sentences and whole sentences', () => {
    expect(isCaptionFragment('Why?', known)).toBe(false);
    expect(isCaptionFragment('Three checks decide it.', known)).toBe(false);
    expect(isCaptionFragment(S2, known)).toBe(false);
  });

  it('accepts the CTA split at its conjunction and a clause ending at a comma', () => {
    expect(isCaptionFragment('Start your BuildTrack trial', known)).toBe(false);
    expect(isCaptionFragment('and see your executed-vs-accepted gap every week.', known)).toBe(false);
    expect(isCaptionFragment('Step one,', ['Step one, the work gets done.'])).toBe(false);
    expect(texts.slice(-2)).toEqual(['Start your BuildTrack trial', 'and see your executed-vs-accepted gap every week.']);
  });

  it('target QC reports a planted fragment cue as critical, and the real cues as clean', () => {
    const bad = clone(cues);
    bad[1].text = 'It is a commercial';
    expect(targetStaticQc(v01, 'short_1', bad).some((f) => f.severity === 'critical' && f.title === 'Caption fragment')).toBe(true);
    expect(targetStaticQc(v01, 'short_1', cues).filter((f) => f.severity === 'critical')).toEqual([]);
  });
});

describe('7-8. timing and linkage', () => {
  it('captions are monotonic and inside the target duration', () => {
    for (const sb of boards) for (const sh of sb.shorts) {
      const cs = buildShortCaptions(sh);
      for (let i = 0; i < cs.length; i++) {
        expect(cs[i].start).toBeGreaterThanOrEqual(0);
        expect(cs[i].end).toBeGreaterThanOrEqual(cs[i].start);
        expect(cs[i].end).toBeLessThanOrEqual(sh.totalDuration + 1e-6);
        if (i) expect(cs[i].start).toBeGreaterThanOrEqual(cs[i - 1].end - 1e-6);
      }
    }
  });

  it('a cue spanning a beat boundary links to a real scene of its sentence, the one it starts in', () => {
    const cue = cues.find((c) => c.text === S1)!;
    const beats = s1.scenes.filter((x) => x.content.source === S1);
    expect(cue.sceneId).toBe(beats[0].id);
    expect(cue.start).toBeGreaterThanOrEqual(beats[0].startTime);
    expect(cue.end).toBeGreaterThan(beats[1].startTime); // spans the boundary
    expect(cue.end).toBeLessThanOrEqual(beats[1].startTime + beats[1].duration);
    const ids = new Set(s1.scenes.map((x) => x.id));
    for (const c of cues) expect(ids.has(c.sceneId!)).toBe(true);
  });
});

describe('9-10. semantic section labels', () => {
  it('maps intent and role deterministically', () => {
    expect(sectionForScene('body', 'steps')).toBe('How it works');
    expect(sectionForScene('body', 'question')).toBe('The question / problem');
    expect(sectionForScene('body', 'warning')).toBe('The question / problem');
    expect(sectionForScene('body', 'stat')).toBe('Key number');
    expect(sectionForScene('body', 'comparison')).toBe('The gap');
    expect(sectionForScene('cta', undefined)).toBe('Next step');
  });

  it('Step scenes use a process label, never the problem label', () => {
    const steps = s1.scenes.filter((x) => /^Step (one|two|three)/.test(x.narration ?? ''));
    expect(steps).toHaveLength(3);
    for (const s of steps) expect(s.section).toBe('How it works');
  });

  it('question and warning scenes keep a truthful problem label', () => {
    for (const s of s1.scenes.filter((x) => x.content.source === S3 || x.content.source === S2)) expect(s.section).toBe('The question / problem');
    for (const s of s1.scenes.filter((x) => x.content.source === S1)) expect(s.section).toBe('Key number');
  });

  it('labels come from each scene\'s intent, not its position', () => {
    for (const sb of boards) for (const sh of sb.shorts) for (const s of sh.scenes) {
      if (s.role === 'cta') expect(s.section).toBe('Next step');
      if (s.role === 'body' && s.content.intent && s.content.intent !== 'statement') expect(s.section).toBe(sectionForScene('body', s.content.intent));
    }
  });
});

describe('11-12. earlier guarantees', () => {
  it('Phase 0A: a Short resolves to its own audio and its own captions, never the Long', () => {
    const now = new Date().toISOString();
    const { historyEntry: _h, ...storyboard } = v01 as any;
    const project: any = { schemaVersion: 1, meta: { input: DEMO_PROJECTS[0], brand: v01.brand, createdAt: now, updatedAt: now, status: 'storyboarded' }, storyboard, artifacts: [], qc: [] };
    const audio: any = { long: { file: '/a/Video_01.mp3', durationSec: 94 }, short_1: { file: '/a/Video_01_short_1.mp3', durationSec: 28 } };
    const r: any = resolveTargetMedia(project, 'short_1', audio);
    expect(r.ok).toBe(true);
    expect(r.media.audioFile).toBe('/a/Video_01_short_1.mp3');
    expect(r.media.captions.length).toBeGreaterThan(0);
    for (const c of r.media.captions) expect(s1.scenes.some((x) => x.id === c.sceneId)).toBe(true);
    expect(r.media.captions.map((c: any) => c.text)).toContain(S1);
  });

  it('Phase 0C: the safe-zone contract is unchanged and still clean', () => {
    expect(PORTRAIT.content).toEqual({ top: 180, bottom: 1310 });
    expect(PORTRAIT.caption).toEqual({ top: 1330, bottom: 1580 });
    expect(portraitCaptionBottom()).toBe(340);
    for (const sb of boards) for (const sh of sb.shorts) expect(portraitSafeZoneFindings(sh.scenes)).toEqual([]);
  });
});
