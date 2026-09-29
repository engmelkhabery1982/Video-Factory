/**
 * Phase 0C - visual semantics, caption safe zones and text quality.
 * Every rule is exercised with the known bad cases from the Phase 0A render
 * AND with every Short the demo fixtures produce, so the rules are general.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PORTRAIT,
  PORTRAIT_LAYOUT_BOXES,
  bandBox,
  boxesOverlap,
  buildShortCaptions,
  buildStoryboard,
  chunkCaptionText,
  classifyIntent,
  completeText,
  ctaParts,
  displayText,
  hasGenuineContrast,
  isCueRedundant,
  isFragmentHeadline,
  isGenericFiller,
  isOrphanCue,
  portraitSafeZoneFindings,
  shortBeatContent,
  targetStaticQc,
  type Storyboard,
} from '../packages/core/src/index';
import { emptyHistory } from '../packages/core/src/history';
import { DEMO_PROJECTS } from './fixtures/demo-projects';

const boards = DEMO_PROJECTS.map((p) => ({ p, sb: buildStoryboard({ input: p, history: emptyHistory() }) as Storyboard }));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const v01 = boards[0].sb;
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ */
describe('A. hook semantics', () => {
  it('Video_01 short_1 hook shows its own sentence, dominant, and is not BEFORE/AFTER', () => {
    const hook = v01.shorts[0].scenes[0];
    expect(hook.narration).toBe('Your site is 70% finished.');
    expect(hook.content.headline).toBe('Your site is 70% finished.');
    expect(hook.variant).not.toBe('before_after');
    expect(hook.variant).toBe('surprising_number');
    expect(hook.content.stat).toBe('70%');
    expect(hook.content.stat2 ?? null).toBeNull();
  });

  it('a single statistic is not a genuine contrast; two figures or an explicit pair are', () => {
    expect(hasGenuineContrast('Your site is 70% finished.')).toBe(false);
    expect(hasGenuineContrast('Executed 70 percent, accepted 59.5 percent.')).toBe(true);
    expect(hasGenuineContrast('Before the audit it was fine, after it was not.')).toBe(true);
    expect(hasGenuineContrast('Plan versus reality')).toBe(true);
  });

  it('no demo Short uses before_after unless its hook text has two sides', () => {
    for (const { sb } of boards) for (const sh of sb.shorts) for (const s of sh.scenes) {
      if (s.variant === 'before_after') expect(hasGenuineContrast(s.narration ?? '', s.content.stat, s.content.stat2)).toBe(true);
    }
  });

  it('layout choice is deterministic for the same input', () => {
    const again = buildStoryboard({ input: DEMO_PROJECTS[0], history: emptyHistory() }) as Storyboard;
    expect(again.shorts.map((s) => s.scenes.map((x) => x.variant))).toEqual(v01.shorts.map((s) => s.scenes.map((x) => x.variant)));
  });

  it('QC flags a forced before_after on a one-sided hook, and a hook that hides its text', () => {
    const sb = clone(v01);
    sb.shorts[0].scenes[0].variant = 'before_after';
    const f1 = targetStaticQc(sb, 'short_1');
    expect(f1.some((f) => f.severity === 'critical' && f.title === 'Before/after layout without two sides')).toBe(true);
    const sb2 = clone(v01);
    sb2.shorts[0].scenes[0].content.headline = '';
    expect(targetStaticQc(sb2, 'short_1').some((f) => f.severity === 'critical' && f.title === 'Hook text missing')).toBe(true);
  });

  it('classifies intent from the text', () => {
    expect(classifyIntent('Your site is 70% finished.')).toBe('stat');
    expect(classifyIntent('So where does the gap actually come from?')).toBe('question');
    expect(classifyIntent('Executed 70 percent, accepted 59.5 percent.')).toBe('comparison');
    expect(classifyIntent('It is a commercial risk sitting inside your project.')).toBe('warning');
  });
});

/* ------------------------------------------------------------------ */
describe('B. complete headlines (no fixed-word-count cuts)', () => {
  const S1 = 'That 10.5 percent gap is not a rounding error.';
  const S2 = 'It is a commercial risk sitting inside your project.';
  const S3 = 'So where does the gap actually come from?';

  it('the three known Phase 0A fragments are detected', () => {
    expect(isFragmentHeadline('That 10.5 percent', S1)).toBe(true);
    expect(isFragmentHeadline('It is a commercial', S2)).toBe(true);
    expect(isFragmentHeadline('gap actually come from?', S3)).toBe(true);
    expect(isFragmentHeadline('So where does the', S3)).toBe(true);
  });

  it('complete sentences and clause-bounded leads are accepted', () => {
    expect(isFragmentHeadline(S1, S1)).toBe(false);
    expect(isFragmentHeadline('Three checks decide it.', 'Three checks decide it.')).toBe(false);
    expect(isFragmentHeadline('Start your BuildTrack trial', 'Start your BuildTrack trial and see your gap every week.')).toBe(false);
  });

  it('completeText cuts only at clause boundaries, or refuses', () => {
    expect(completeText(S1)).toBe(S1);
    expect(completeText('Start your BuildTrack trial and see your executed-vs-accepted gap every week.', 42)).toBe('Start your BuildTrack trial');
    expect(completeText('Walk the floor and compare what you see with what is reported.', 40)).toBe('Walk the floor');
    // no boundary that leaves >= 3 words: refuse instead of clipping
    expect(completeText('Supercalifragilistic expialidocious wordsmithery overwhelms', 20)).toBeNull();
  });

  it('both beats of a split sentence show the SAME complete sentence and highlight their own half', () => {
    const a = shortBeatContent(S1, 'That 10.5 percent', true);
    const b = shortBeatContent(S1, 'gap is not a rounding error.', true);
    expect(displayText(a.variant, a.content)).toBe(S1);
    expect(displayText(b.variant, b.content)).toBe(S1);
    expect(a.content.emphasis).toBe('That 10.5 percent');
    expect(b.content.emphasis).toBe('gap is not a rounding error.');
  });

  it('no demo Short shows a fragment on any scene', () => {
    for (const { sb } of boards) for (const sh of sb.shorts) for (const s of sh.scenes) {
      const shown = s.role === 'cta' ? s.content.headline : displayText(s.variant, s.content);
      expect(`${sh.id} ${s.id} "${shown}" fragment=${isFragmentHeadline(shown, s.content.source ?? (s.role === 'cta' ? s.narration : null))}`).toContain('fragment=false');
    }
  });

  it('QC flags a fragment headline as critical', () => {
    const sb = clone(v01);
    const s = sb.shorts[0].scenes[1];
    s.variant = 'animated_checklist';
    s.content.headline = 'That 10.5 percent';
    expect(targetStaticQc(sb, 'short_1').some((f) => f.severity === 'critical' && f.title === 'Fragment headline')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
describe('C. no generic filler', () => {
  const FILLER = 'This is where most projects lose control.';

  it('the old filler sentence appears nowhere in any storyboard', () => {
    for (const { sb } of boards) expect(JSON.stringify(sb)).not.toContain(FILLER);
  });

  it('unrelated Short scenes never share identical secondary text', () => {
    for (const { sb } of boards) for (const sh of sb.shorts) {
      const seen = new Map<string, string>();
      for (const s of sh.scenes) for (const t of [s.content.subline, s.content.takeaway].filter(Boolean) as string[]) {
        const prev = seen.get(t);
        if (prev) expect(prev).toBe(s.content.source ?? s.id);
        seen.set(t, s.content.source ?? s.id);
      }
    }
  });

  it('body scenes without secondary evidence use the single-block layout', () => {
    for (const s of v01.shorts[0].scenes.filter((x) => x.role === 'body')) {
      if (!s.content.stat2) expect(s.variant).toBe('key_statement');
      expect(s.content.items).toEqual([]);
    }
  });

  it('QC flags generic filler injected into a scene', () => {
    expect(isGenericFiller(FILLER)).toBe(true);
    const sb = clone(v01);
    sb.shorts[0].scenes[2].content.takeaway = FILLER;
    expect(targetStaticQc(sb, 'short_1').some((f) => f.severity === 'critical' && /generic filler/i.test(f.title))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
describe('D. portrait caption safe zone', () => {
  it('bands are ordered, inside the frame and never overlap', () => {
    const order = [PORTRAIT.chrome, PORTRAIT.content, PORTRAIT.caption, PORTRAIT.platform];
    for (let i = 1; i < order.length; i++) expect(order[i].top).toBeGreaterThanOrEqual(order[i - 1].bottom);
    expect(PORTRAIT.platform.bottom).toBe(PORTRAIT.height);
    expect(boxesOverlap(bandBox(PORTRAIT.content), bandBox(PORTRAIT.caption))).toBe(false);
    // the reserved speaker band (future dialogue) sits inside content, clear of captions
    expect(PORTRAIT.speaker.top).toBeGreaterThanOrEqual(PORTRAIT.content.top);
    expect(PORTRAIT.speaker.bottom).toBeLessThanOrEqual(PORTRAIT.content.bottom);
    // a two-line 54px caption block fits the caption band
    expect(PORTRAIT.caption.bottom - PORTRAIT.caption.top).toBeGreaterThanOrEqual(2 * 54 * 1.22 + 40);
  });

  it('every layout a demo Short uses has a declared box clear of the caption band', () => {
    for (const { sb } of boards) for (const sh of sb.shorts) {
      for (const s of sh.scenes) expect(PORTRAIT_LAYOUT_BOXES[s.variant]).toBeTruthy();
      expect(portraitSafeZoneFindings(sh.scenes)).toEqual([]);
    }
  });

  it('QC reports an undeclared layout as a critical safe-zone collision', () => {
    const sb = clone(v01);
    (sb.shorts[0].scenes[2] as { variant: string }).variant = 'progressive_table';
    expect(targetStaticQc(sb, 'short_1').some((f) => f.severity === 'critical' && f.title === 'Caption safe-zone collision')).toBe(true);
  });

  it('layouts and captions read the SAME contract (no private magic numbers)', () => {
    const cap = src('packages/video/src/captions/Captions.tsx');
    expect(cap).toMatch(/portraitCaptionBottom\(\)/);
    expect(cap).not.toMatch(/bottom: 430|bottom: 380/);
    for (const f of ['packages/video/src/scenes/Explanations.tsx', 'packages/video/src/scenes/Hooks.tsx', 'packages/video/src/scenes/Cta.tsx']) {
      const s = src(f);
      expect(s).toMatch(/portraitContentPaddingCss\(\)/);
      expect(s).not.toMatch(/'300px 72px 620px'|'0 72px 300px'|'120px 72px'|'180px 72px'|'160px 72px'/);
    }
  });
});

/* ------------------------------------------------------------------ */
describe('E. no duplicate prominent text', () => {
  it('a cue that repeats the scene text is redundant; a different one is not', () => {
    expect(isCueRedundant('That 10.5 percent', 'That 10.5 percent gap is not a rounding error.')).toBe(true);
    expect(isCueRedundant('Your site is 70% finished.', 'Your site is 70% finished. 70%')).toBe(true);
    expect(isCueRedundant('Start your BuildTrack trial and see your executed-vs-accepted gap every week.', 'Start your BuildTrack trial See your executed-vs-accepted gap every week.')).toBe(true);
    expect(isCueRedundant('The engineer inspects the work.', 'Your site is 70% finished.')).toBe(false);
  });

  it('the burned caption has a compact branch; sidecar cues keep the full text', () => {
    expect(src('packages/video/src/captions/Captions.tsx')).toMatch(/isCueRedundant\(/);
    const cues = buildShortCaptions(v01.shorts[0]);
    const spoken = v01.shorts[0].scenes.map((s) => s.narration).join(' ').replace(/\s+/g, ' ');
    expect(cues.map((c) => c.text).join(' ')).toBe(spoken);
  });
});

/* ------------------------------------------------------------------ */
describe('F. caption chunking without orphans', () => {
  const CTA = 'Start your BuildTrack trial and see your executed-vs-accepted gap every week.';

  it('never leaves a final one-word fragment', () => {
    const long = 'Start your BuildTrack trial today and see your executed-versus-accepted gap in one place every single week.';
    const chunks = chunkCaptionText(long, 72);
    expect(chunks.join(' ')).toBe(long);
    for (const c of chunks) expect(c.split(' ').length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the long CTA together within the two-line limit', () => {
    const chunks = chunkCaptionText(CTA, 72);
    expect(chunks.join(' ')).toBe(CTA);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(84);
    expect(chunks[chunks.length - 1]).not.toBe('week.');
  });

  it('prefers phrase boundaries and keeps punctuation with its word', () => {
    const t = 'Executed is seventy percent of the contract value, accepted is only fifty nine and a half percent, and the gap keeps growing.';
    const chunks = chunkCaptionText(t, 72);
    expect(chunks.join(' ')).toBe(t);
    expect(chunks[0].endsWith(',')).toBe(true);
    for (const c of chunks) expect(/^[,.;:]/.test(c)).toBe(false);
  });

  it('never merges across a sentence end; a genuine short sentence is not an orphan', () => {
    expect(chunkCaptionText('Why? Because the value is not accepted.', 72)).toEqual(['Why?', 'Because the value is not accepted.']);
    expect(isOrphanCue('Why?', ['Why?'])).toBe(false);
    expect(isOrphanCue('week.', ['Start your trial and see the gap every week.'])).toBe(true);
  });

  it('every demo Short: no orphan cue and every cue ends within the duration', () => {
    for (const { sb } of boards) for (const sh of sb.shorts) {
      const cues = buildShortCaptions(sh);
      const sentences = sh.scenes.flatMap((s) => String(s.narration ?? '').split(/(?<=[.!?])\s+/));
      for (const c of cues) {
        expect(`${sh.id} "${c.text}" orphan=${isOrphanCue(c.text, sentences)}`).toContain('orphan=false');
        expect(c.end).toBeLessThanOrEqual(sh.totalDuration + 1e-6);
      }
    }
  });

  it('QC flags an orphan cue and a cue beyond the duration', () => {
    const sh = v01.shorts[0];
    const cues = buildShortCaptions(sh);
    const bad = [...cues, { ...cues[cues.length - 1], id: 'x', text: 'week.', start: sh.totalDuration - 0.2, end: sh.totalDuration + 1 }];
    const f = targetStaticQc(v01, 'short_1', bad);
    expect(f.some((x) => x.severity === 'critical' && x.title === 'Orphan caption cue')).toBe(true);
    expect(f.some((x) => x.severity === 'critical' && x.title === 'Caption beyond the video duration')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
describe('G. CTA hierarchy', () => {
  it('headline is a complete clause and the support line is the rest of the same sentence', () => {
    expect(ctaParts('Start your BuildTrack trial and see your executed-vs-accepted gap every week.')).toEqual({
      headline: 'Start your BuildTrack trial',
      subline: 'See your executed-vs-accepted gap every week',
    });
    const p = ctaParts('Start a BuildTrack trial to track your tail phase properly from day one.');
    expect(p.headline).toBe('Start a BuildTrack trial');
    expect(p.subline).toBe('Track your tail phase properly from day one');
  });

  it('every demo Short CTA headline is short, complete and not the full spoken sentence', () => {
    for (const { sb } of boards) for (const sh of sb.shorts) {
      const cta = sh.scenes.find((s) => s.role === 'cta')!;
      expect(cta.content.headline.length).toBeLessThanOrEqual(42);
      expect(isFragmentHeadline(cta.content.headline, cta.narration)).toBe(false);
      expect(cta.content.headline).not.toBe(cta.narration);
    }
  });

  it('the portrait CTA renders the scene headline, not the full CTA sentence, at a reduced scale', () => {
    const s = src('packages/video/src/scenes/Cta.tsx');
    expect(s).toMatch(/scene\.content\.headline \|\| ctaText/);
    expect(s).not.toMatch(/fontSize: wide \? ts\.h1 : 86/);
  });
});

/* ------------------------------------------------------------------ */
describe('Phase 0C keeps Video_01 short_1 clean', () => {
  it('zero critical static QC findings', () => {
    const crit = targetStaticQc(v01, 'short_1').filter((f) => f.severity === 'critical');
    expect(crit.map((f) => f.detail)).toEqual([]);
  });
});
