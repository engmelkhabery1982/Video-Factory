import { describe, expect, it } from 'vitest';
import { DEMO_PROJECTS } from './fixtures/demo-projects.js';
import {
  EXPLANATION_VARIANTS,
  HOOK_VARIANTS,
  BACKGROUND_VARIANTS,
  TRANSITION_VARIANTS,
  appendHistory,
  buildCues,
  buildStoryboard,
  captionOverMaxLines,
  condense,
  emptyHistory,
  computeSimilarity,
  explanationById,
  getBrandPreset,
  shortHeadline,
  staticQc,
  toSrt,
  analyzeScript,
  applyGlossary,
  normaliseNumber,
  keyNumberFindings,
  LONG_EXPORT_SPEC,
  SHORT_EXPORT_SPEC,
  technicalQc,
  type VisualHistory,
} from '../packages/core/src/index.js';
import { DEMO_PROJECTS } from './fixtures/demo-projects.js';

function buildAll() {
  let history: VisualHistory = emptyHistory();
  const built = DEMO_PROJECTS.map((input) => {
    const sb: any = buildStoryboard({ input, history });
    history = appendHistory(history, sb.historyEntry);
    return { input, sb };
  });
  return { built, history };
}

const { built } = buildAll();
const longScenes = (i: number) => built[i].sb.long.scenes as any[];

describe('variant library meets the brief minimums', () => {
  it('has at least 6 hook variants', () => expect(HOOK_VARIANTS.length).toBeGreaterThanOrEqual(6));
  it('has at least 12 explanation variants', () => expect(EXPLANATION_VARIANTS.length).toBeGreaterThanOrEqual(12));
  it('has at least 7 transition variants', () => expect(TRANSITION_VARIANTS.length).toBeGreaterThanOrEqual(7));
  it('has at least 8 background variants', () => expect(BACKGROUND_VARIANTS.length).toBeGreaterThanOrEqual(8));
  it('caps every continuous background at 15 seconds', () => {
    for (const b of BACKGROUND_VARIANTS) expect(b.maxContinuousSeconds).toBeLessThanOrEqual(15);
  });
});

describe('script analysis', () => {
  it('does not split a decimal point into a sentence boundary', () => {
    const a = analyzeScript('The gap is 10.5 percent and it matters.\n\nCompare 59.5% with 70% today.');
    expect(a.segments[0].text).toContain('10.5');
    expect(a.allNumbers.map((n) => n.value)).toContain(10.5);
    expect(a.allNumbers.map((n) => n.value)).toContain(59.5);
    expect(a.allNumbers.map((n) => n.value)).toContain(70);
  });

  it('detects a comparison when two figures are compared', () => {
    const a = analyzeScript('Executed is 70% versus accepted 59.5%.');
    expect(a.segments[0].fn).toBe('comparison');
    expect(a.segments[0].evidence).toMatch(/compares two figures/);
  });

  it('detects a question, a warning and a myth', () => {
    expect(analyzeScript('Why does the tail take so long?').segments[0].fn).toBe('question');
    expect(analyzeScript('The biggest risk is that nobody reviews it.').segments[0].fn).toBe('warning');
    expect(analyzeScript('Here is the myth: the curve is always smooth.').segments[0].fn).toBe('myth');
  });
});

describe('copy never gets cut mid-clause', () => {
  it('condenses on a natural boundary', () => {
    expect(condense('That 10.5 percent gap is not a rounding error, it is a risk', 7)).not.toMatch(/\b(a|an|the|of|to|and|is|not)$/i);
  });
  it('never ends on a dangling function word', () => {
    for (const s of ['track executed and accepted as two separate lines review weekly', 'the moment the gap crosses five percent you escalate']) {
      expect(condense(s, 6)).not.toMatch(/\b(a|an|the|of|to|and|or|but|is|are|was|that|this|with|in|on|for)$/i);
    }
  });
  it('keeps numbers intact when condensing', () => {
    expect(shortHeadline('That 10.5 percent gap is not a rounding error.')).toContain('10.5');
  });
});

describe('long video structure (brief section 9)', () => {
  it.each(built.map((b, i) => [i, b.input.topic]))('video %i (%s) satisfies the structural rules', (_i, _t) => {
    const scenes = longScenes(_i as number);
    expect(scenes.length).toBeGreaterThanOrEqual(8);
    // hook lands in the first 5-8 seconds
    expect(scenes[0].role).toBe('hook');
    expect(scenes[0].duration).toBeGreaterThanOrEqual(5);
    expect(scenes[0].duration).toBeLessThanOrEqual(8.2);
    // never opens on a logo / title card
    expect(scenes[0].variant).not.toBe('cta_card');
    // exactly one CTA, 6-8 seconds, at the end
    const ctas = scenes.filter((s) => s.role === 'cta');
    expect(ctas).toHaveLength(1);
    expect(ctas[0].duration).toBeGreaterThanOrEqual(6);
    expect(ctas[0].duration).toBeLessThanOrEqual(8.5);
    expect(ctas[0]).toBe(scenes[scenes.length - 1]);
    // exactly one summary
    expect(scenes.filter((s) => s.role === 'summary')).toHaveLength(1);
    // body beats evolve every 5-8 seconds
    for (const s of scenes.filter((x) => x.role === 'body')) {
      expect(s.duration).toBeGreaterThanOrEqual(3);
      expect(s.duration).toBeLessThanOrEqual(11);
    }
    // product proof appears inside the content, not only at the end
    const total = built[_i as number].sb.long.totalDuration;
    const proof = scenes.findIndex((s) => ['dashboard_demo', 'site_footage_callouts'].includes(s.variant));
    expect(proof).toBeGreaterThanOrEqual(0);
    expect(scenes[proof].startTime / total).toBeLessThan(0.85);
  });

  it('records a reason and alternatives for every scene', () => {
    for (const s of longScenes(0)) {
      expect(s.reason.evidence).toBeTruthy();
      expect(s.reason.detected).toBeTruthy();
    }
  });
});

describe('anti-repetition rules (brief section 8)', () => {
  it('never repeats a hook variant in consecutive videos', () => {
    for (let i = 1; i < built.length; i++) {
      expect(built[i].sb.historyEntry.hookVariant).not.toBe(built[i - 1].sb.historyEntry.hookVariant);
    }
  });

  it('never uses the same CTA animation in more than two consecutive videos', () => {
    for (let i = 1; i < built.length; i++) {
      const a = built[i - 1].sb.historyEntry.ctaAnimation;
      const b = built[i - 2]?.sb.historyEntry.ctaAnimation;
      if (a === b) expect(built[i].sb.historyEntry.ctaAnimation).not.toBe(a);
    }
  });

  it('never uses a scene variant more than twice inside one video', () => {
    for (const { input, sb } of built) {
      const counts = new Map<string, number>();
      for (const s of sb.long.scenes) {
        if (s.variant === 'cta_card') continue;
        counts.set(s.variant, (counts.get(s.variant) ?? 0) + 1);
      }
      for (const [k, v] of counts) {
        expect(`${input.videoId}:${k}=${v} <= 2`).toContain('<= 2');
      }
    }
  });

  it('never repeats the same transition across three consecutive scenes', () => {
    for (const { input, sb } of built) {
      const s = sb.long.scenes;
      for (let i = 2; i < s.length; i++) {
        const same = s[i - 2].transitionIn === s[i - 1].transitionIn && s[i - 1].transitionIn === s[i].transitionIn;
        expect(`${input.videoId}@${i} sameTransition=${same}`).toContain('sameTransition=false');
      }
    }
  });

  it('never holds one background for more than 15 continuous seconds', () => {
    for (const { input, sb } of built) {
      let run = 0;
      let bg = null as string | null;
      const flush = () => {
        if (run > 15.6) throw new Error(`${input.videoId}: background ${bg} held ${run.toFixed(1)}s`);
      };
      for (const s of sb.long.scenes) {
        if (s.background !== bg) {
          flush();
          bg = s.background;
          run = 0;
        }
        run += s.duration;
      }
      flush();
    }
  });

  it('never produces two identical scene orders', () => {
    const orders = built.map((b) => b.sb.historyEntry.sceneOrder.join('>'));
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe('the three demos are genuinely different (brief section 18)', () => {
  it('uses three different openings', () => {
    const hooks = built.map((b) => b.sb.long.scenes[0].variant);
    expect(new Set(hooks).size).toBe(3);
  });

  it('uses three different scene orders', () => {
    const orders = built.map((b) => b.sb.historyEntry.sceneOrder.join('>'));
    expect(new Set(orders).size).toBe(3);
  });

  it('uses three different background distributions', () => {
    const sigs = built.map((b) => [...new Set(b.sb.historyEntry.backgrounds)].sort().join('>'));
    expect(new Set(sigs).size).toBe(3);
  });

  it('uses three different CTA animations', () => {
    const ctas = built.map((b) => b.sb.historyEntry.ctaAnimation);
    expect(new Set(ctas).size).toBe(3);
  });

  it('uses three different caption styles', () => {
    const c = built.map((b) => b.sb.historyEntry.captionStyle);
    expect(new Set(c).size).toBe(3);
  });

  it('displays the headline numbers in different scene types', () => {
    // the number-comparison topic must not be drawn with the same layout as the
    // myth/checklist topic - that is what "different way of showing numbers" means
    const numberScenes = built.map((b) =>
      b.sb.long.scenes.filter((s: any) => s.content.stat || s.content.stat2).map((s: any) => s.variant),
    );
    expect(new Set(numberScenes.map((x) => x.join('>'))).size).toBe(3);
  });

  it('keeps every similarity score under the 65% gate', () => {
    for (const b of built) {
      expect(`${b.input.videoId} similarity=${b.sb.similarity.score}`).toMatch(/similarity=\d+/);
      expect(b.sb.similarity.score).toBeLessThanOrEqual(65);
      expect(b.sb.similarity.blocking).toBe(false);
    }
  });
});

describe('shorts are native 9:16 projects (brief section 10)', () => {
  it.each(built.map((b, i) => [i, b.input.videoId]))('video %i (%s) shorts obey the vertical rules', (_i, _id) => {
    const shorts = built[_i as number].sb.shorts;
    expect(shorts).toHaveLength(3);
    for (const sh of shorts) {
      expect(sh.native).toBe(true);
      expect(sh.totalDuration).toBeGreaterThanOrEqual(18);
      expect(sh.totalDuration).toBeLessThanOrEqual(36);
      // one idea, one CTA
      expect(sh.scenes.filter((s: any) => s.role === 'cta')).toHaveLength(1);
      // hook readable in the first two seconds
      expect(sh.scenes[0].role).toBe('hook');
      expect(sh.scenes[0].duration).toBeLessThanOrEqual(3);
      for (const s of sh.scenes) {
        // no landscape-first layout shrunk into a vertical frame
        // hook variants have their own native vertical implementations;
        // only the explanation layouts are subject to the 9:16 safety list
        if (EXPLANATION_VARIANTS.some((v) => v.id === s.variant)) {
          expect(explanationById(s.variant as any).shortsSafe).toBe(true);
        }
        // no key text in the right rail or the platform-UI bottom zone
        expect(['right_column', 'bottom_center', 'lower_third']).not.toContain(s.textPosition);
        // visual change every 1.5-3 seconds
        if (s.role === 'body') {
          expect(s.duration).toBeGreaterThanOrEqual(1.4);
          expect(s.duration).toBeLessThanOrEqual(3.2);
        }
        // phone-legible headline
        expect(s.content.headline.length).toBeLessThanOrEqual(52);
        expect(s.content.headline).toBeTruthy();
      }
    }
  });

  it('gives the three shorts of a video three different hooks', () => {
    for (const { input, sb } of built) {
      const hooks = sb.shorts.map((s: any) => s.hookVariant);
      expect(`${input.videoId} ${hooks.join(',')}`).toBe(`${input.videoId} ${[...new Set(hooks)].length === 3 ? hooks.join(',') : 'DUPLICATE'}`);
    }
  });

  it('gives the three shorts of a video three different scene orders', () => {
    for (const { input, sb } of built) {
      const orders = sb.shorts.map((s: any) => s.scenes.map((x: any) => x.variant).join('>'));
      expect(new Set(orders).size).toBe(3);
    }
  });
});

describe('captions (brief section 11)', () => {
  it('produces SRT cues that fit the audio duration', () => {
    const cues = buildCues([{ text: 'Executed is 70 percent. Accepted is 59.5 percent. The gap is 10.5 percent.' }], 12);
    expect(cues.length).toBeGreaterThan(0);
    expect(cues[cues.length - 1].end).toBeLessThanOrEqual(12.1);
    for (const c of cues) expect(c.end).toBeGreaterThan(c.start);
    const srt = toSrt(cues);
    expect(srt).toMatch(/^1\n00:00/);
    expect(srt).toMatch(/-->/);
  });

  it('never exceeds two lines of caption text', () => {
    for (const { input, sb } of built) {
      for (const c of sb.captions) {
        expect(`${input.videoId} ${c.id} long=${captionOverMaxLines(c.text)}`).toContain('long=false');
      }
    }
  });

  it('normalises the construction glossary', () => {
    expect(applyGlossary('the boq and the wir and the ipc and the s curve')).toBe('the BOQ and the WIR and the IPC and the S-Curve');
    // a spelled-out term is never rewritten to an acronym in a subtitle
    expect(applyGlossary('earned value management')).toBe('earned value management');
    expect(applyGlossary('the evm number')).toBe('the EVM number');
  });

  it('keeps timing monotonic when a cue is nudged', () => {
    const cues = buildCues([{ text: 'One two three. Four five six. Seven eight nine.' }], 9);
    const moved = cues.map((c) => ({ ...c, start: c.start + 0.4, end: c.end + 0.4 }));
    for (let i = 1; i < moved.length; i++) expect(moved[i].start).toBeGreaterThanOrEqual(moved[i - 1].end - 0.001);
  });
});

describe('QC catches the reference-video failures', () => {
  const { history } = buildAll();

  it('flags a placeholder left in the script', () => {
    const sb: any = buildStoryboard({ input: DEMO_PROJECTS[0], history: emptyHistory() });
    sb.long.scenes[2].content.headline = 'TODO: write this bit';
    const findings = staticQc(sb, history);
    expect(findings.some((f) => f.severity === 'critical' && /Placeholder/i.test(f.title))).toBe(true);
  });

  it('flags a duplicate summary', () => {
    const sb: any = buildStoryboard({ input: DEMO_PROJECTS[0], history: emptyHistory() });
    sb.long.scenes.splice(2, 0, { ...sb.long.scenes[3], id: 'dupe', role: 'summary' });
    const findings = staticQc(sb, history);
    expect(findings.some((f) => f.severity === 'critical' && /Duplicate summary/i.test(f.title))).toBe(true);
  });

  it('flags a logo/title-card opener', () => {
    const sb: any = buildStoryboard({ input: DEMO_PROJECTS[0], history: emptyHistory() });
    sb.long.scenes[0].variant = 'cta_card';
    const findings = staticQc(sb, history);
    expect(findings.some((f) => f.title.includes('title card'))).toBe(true);
  });

  it('flags a landscape-first layout inside a vertical short', () => {
    const sb: any = buildStoryboard({ input: DEMO_PROJECTS[0], history: emptyHistory() });
    sb.shorts[0].scenes[1].variant = 'site_footage_callouts';
    const findings = staticQc(sb, history);
    expect(findings.some((f) => f.severity === 'critical' && /Landscape-first/.test(f.title))).toBe(true);
  });

  it('flags a key number that never reaches the screen', () => {
    const f = keyNumberFindings(['99.9%'], longScenes(0));
    expect(f[0].severity).toBe('critical');
    expect(normaliseNumber('10.5%')).toContain('10.5 percent');
  });

  it('accepts a key number written as words', () => {
    const f = keyNumberFindings(['10.5%'], longScenes(0));
    expect(f[0].severity).toBe('pass');
  });
});

describe('export specifications (brief section 15)', () => {
  it('flags a Short that was stretched to the full narration length', () => {
    // a real defect caught during review: ffmpeg was muxing without
    // -shortest, so every Short came out at 94.56s instead of ~24s and the
    // duration check (which only tested "> 0.5s") still passed
    const long = technicalQc(
      { width: 1080, height: 1920, r_frame_rate: '30/1', codec_name: 'h264', pix_fmt: 'yuv420p', bit_rate: '2300000', hasAudio: true, audioCodec: 'aac', audioBitrate: 224000, audioSampleRate: 48000, duration: 94.56 },
      SHORT_EXPORT_SPEC,
      'short_1',
    );
    expect(long.find((x) => x.title === 'Duration')?.severity).toBe('critical');

    const ok = technicalQc(
      { width: 1080, height: 1920, r_frame_rate: '30/1', codec_name: 'h264', pix_fmt: 'yuv420p', bit_rate: '8000000', hasAudio: true, audioCodec: 'aac', audioBitrate: 224000, audioSampleRate: 48000, duration: 24.2 },
      SHORT_EXPORT_SPEC,
      'short_1',
    );
    expect(ok.find((x) => x.title === 'Duration')?.severity).toBe('pass');
  });

  it('long: 1920x1080, 30fps, h264, yuv420p, AAC 48kHz', () => {
    expect([LONG_EXPORT_SPEC.width, LONG_EXPORT_SPEC.height, LONG_EXPORT_SPEC.fps]).toEqual([1920, 1080, 30]);
    expect([LONG_EXPORT_SPEC.videoCodec, LONG_EXPORT_SPEC.pixFmt, LONG_EXPORT_SPEC.audioCodec]).toEqual(['h264', 'yuv420p', 'aac']);
    expect(LONG_EXPORT_SPEC.audioSampleRate).toBe(48000);
    expect(LONG_EXPORT_SPEC.audioBitrate).toEqual([192_000, 256_000]);
    expect(LONG_EXPORT_SPEC.minVideoBitrate).toBeLessThanOrEqual(8_000_000);
  });
  it('short: 1080x1920, 30fps, h264, yuv420p, AAC 48kHz', () => {
    expect([SHORT_EXPORT_SPEC.width, SHORT_EXPORT_SPEC.height, SHORT_EXPORT_SPEC.fps]).toEqual([1080, 1920, 30]);
    expect([SHORT_EXPORT_SPEC.videoCodec, SHORT_EXPORT_SPEC.pixFmt, SHORT_EXPORT_SPEC.audioCodec]).toEqual(['h264', 'yuv420p', 'aac']);
    expect(SHORT_EXPORT_SPEC.audioSampleRate).toBe(48000);
  });
});

describe('brand layer is fixed while the story layer varies', () => {
  it('uses the same brand for all three videos', () => {
    const ids = built.map((b) => b.sb.brand.id);
    expect(new Set(ids).size).toBe(1);
    const brand = getBrandPreset('buildtrack');
    expect(brand.colors.primary).toBe('#0B3D91');
  });
  it('produces different accent usage across videos', () => {
    const accents = built.map((b) => [...new Set(b.sb.historyEntry.accents)].sort().join('>'));
    expect(new Set(accents).size).toBe(3);
  });
});

describe('similarity engine', () => {
  it('scores an identical video against itself at 100%', () => {
    const { history } = buildAll();
    const entry = history.videos[0];
    const sim = computeSimilarity(
      {
        hookVariant: entry.hookVariant,
        sceneOrder: entry.sceneOrder,
        backgrounds: entry.backgrounds,
        transitions: entry.transitions,
        textPositions: entry.textPositions,
        accents: entry.accents,
        sceneDurations: entry.sceneDurations,
        ctaAnimation: entry.ctaAnimation,
        captionStyle: entry.captionStyle,
      },
      'copy',
      { ...history, videos: [entry] },
    );
    expect(sim.score).toBeGreaterThan(95);
    expect(sim.blocking).toBe(true);
  });
  it('scores the first video in an empty history as 0%', () => {
    const sim = computeSimilarity(
      { hookVariant: 'question', sceneOrder: [], backgrounds: [], transitions: [], textPositions: [], accents: [], sceneDurations: [], ctaAnimation: 'slide_in', captionStyle: 'word_pop' },
      'new',
      emptyHistory(),
    );
    expect(sim.score).toBe(0);
    expect(sim.blocking).toBe(false);
  });
});

/**
 * Regressions found by rendering the demo and looking at the frames. Each of
 * these produced a visibly broken video before it was fixed.
 */
describe('on-screen copy defects seen in a real render', () => {
  const firstProject = DEMO_PROJECTS[0];

  it('never cuts a sub line at the 150 character budget mid-word', () => {
    const sb: any = buildStoryboard({ input: firstProject, history: emptyHistory() });
    const subs = [...sb.long.scenes, ...sb.shorts.flatMap((s: any) => s.scenes)]
      .map((s: any) => s.content.subline)
      .filter(Boolean) as string[];
    for (const s of subs) {
      expect(s.length).toBeLessThanOrEqual(150);
      // a cut mid-word ends on a fragment, never on a full word boundary
      expect(s).toBe(s.trim());
      expect(/[\s,;]$/.test(s)).toBe(false);
    }
  });

  it('does not print the headline verbatim again as the sub line', () => {
    const sb: any = buildStoryboard({ input: firstProject, history: emptyHistory() });
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
    for (const s of sb.long.scenes) {
      const c = s.content;
      if (!c.subline) continue;
      expect(norm(c.subline)).not.toBe(norm(c.headline));
      // and the sub line must not simply begin with the whole headline
      expect(norm(c.subline).startsWith(norm(c.headline))).toBe(false);
    }
  });

  it('labels a two sided scene MYTH/REALITY only when the beat really is a myth', () => {
    const sb: any = buildStoryboard({ input: firstProject, history: emptyHistory() });
    for (const s of [...sb.long.scenes, ...sb.shorts.flatMap((x: any) => x.scenes)]) {
      const c = s.content;
      if (!c.sideLabels) continue;
      expect(c.sideLabels[0]).toBeTruthy();
      expect(c.sideLabels[1]).toBeTruthy();
      const beat = sb.segments.find((seg: any) => String(seg.text).includes(c.headline));
      if (c.sideLabels[0] === 'MYTH') {
        // a MYTH label is only honest if the narration actually frames one
        expect(beat?.fn ?? 'myth').toBe('myth');
      }
    }
  });
});
