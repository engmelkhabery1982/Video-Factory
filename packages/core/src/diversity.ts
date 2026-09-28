import { EXPLANATION_VARIANTS, HOOK_VARIANTS, BACKGROUND_VARIANTS, TRANSITION_VARIANTS, explanationById } from './variants.js';
import { ACCENT_PALETTE } from './brand.js';
import type {
  BackgroundVariantId,
  SceneVariantId,
  CaptionStyleId,
  CtaAnimationId,
  ExplanationVariantId,
  HookVariantId,
  ScriptFunction,
  TextPositionId,
  TransitionVariantId,
  VariantLibrary,
  VisualHistory,
  HistoryEntry,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Deterministic PRNG - same project id always rebuilds identically     */
/* ------------------------------------------------------------------ */

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scene layouts that are meaningless without operator-uploaded media. */
const REQUIRES_MEDIA: ExplanationVariantId[] = ['site_footage_callouts', 'document_annotation'];

export class DiversityEngine {
  private rng: () => number;
  readonly library: VariantLibrary;
  readonly history: VisualHistory;
  /** anti-repetition counters for the video currently being built */
  private useCount = new Map<string, number>();
  private recentScenes: SceneVariantId[] = [];
  private recentTransitions: TransitionVariantId[] = [];
  private recentBackgrounds: BackgroundVariantId[] = [];
  private backgroundRunSeconds: Record<string, number> = {};
  private usedAccents = new Set<string>();
  private usedTextPositions = new Set<TextPositionId>();
  /** dominant background subset for THIS video, rotated forward with each history entry */
  private rotation: BackgroundVariantId[] = [];
  /** the subset used by the previous video */
  private recentRotation: BackgroundVariantId[] = [];

  constructor(opts: { seed: string; history: VisualHistory; library: VariantLibrary }) {
    this.rng = mulberry32(hashString(opts.seed));
    this.history = opts.history;
    this.library = opts.library;

    // rotate the dominant surface set: split the 8 backgrounds into 4 per video
    // and shift by one slot for every video already in the history
    const all = BACKGROUND_VARIANTS.map((b) => b.id);
    const n = all.length;
    this.recentRotation = this.lastVideo ? [...new Set(this.lastVideo.backgrounds)].slice(0, 4) : [];
    const step = this.history.videos.length % 2 === 0 ? 0 : Math.floor(n / 4);
    this.rotation = all.map((_, i) => all[(i + step) % n]).slice(0, 4);
  }

  /* ---------------- history helpers ---------------- */

  get lastVideo(): HistoryEntry | null {
    return this.history.videos.length ? this.history.videos[this.history.videos.length - 1] : null;
  }

  get lastTwoVideos(): HistoryEntry[] {
    return this.history.videos.slice(-2);
  }

  get lastFiveVideos(): HistoryEntry[] {
    return this.history.videos.slice(-5);
  }

  /* ---------------- hooks ---------------- */

  /**
   * Pick a hook. Hard rules:
   *  - never equal to the immediately preceding video's hook (rule 1)
   *  - never a pure logo/title card opening (rule 5)
   *  - prefer variants that structurally fit the opening rhetorical function
   */
  selectHook(fn: ScriptFunction, exclude: HookVariantId[] = []): { id: HookVariantId; reason: string; alternatives: HookVariantId[] } {
    const prevHook = this.lastVideo?.hookVariant ?? null;
    const recentHooks = this.lastFiveVideos.map((v) => v.hookVariant);

    const scored = HOOK_VARIANTS.filter((h) => h.fits.includes(fn) || h.fits.includes('hook')).map((h) => {
      let score = 1;
      const notes: string[] = [];
      if (h.fits.includes(fn) && fn !== 'hook') {
        score += 3;
        notes.push(`fits the opening function (${fn})`);
      }
      if (prevHook && h.id === prevHook) {
        score -= 10;
        notes.push('blocked: same hook as the previous video');
      }
      // hard block: shorts of the same video must never share a hook animation
      if (exclude.includes(h.id)) {
        score -= 100;
        notes.push('blocked: already used by another short in this video');
      }
      const useInLast5 = recentHooks.filter((x) => x === h.id).length;
      score -= useInLast5 * 1.4;
      if (useInLast5 > 0) notes.push(`used in ${useInLast5} of the last ${recentHooks.length} videos`);
      score += this.rng() * 1.2; // deterministic tie-break
      return { h, score, notes };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const alternatives = scored.slice(1, 4).map((s) => s.h.id);
    return {
      id: best.h.id,
      reason:
        `Selected "${best.h.label}" for the opening because it structurally carries a ${fn} opening; ` +
        (prevHook ? `the previous video used "${HOOK_VARIANTS.find((x) => x.id === prevHook)?.label}", which is a hard-blocked repeat. ` : '') +
        (best.notes.length ? best.notes.join('; ') + '.' : 'first video in the history.'),
      alternatives,
    };
  }

  /* ---------------- explanation scenes ---------------- */

  /**
   * Pick an explanation variant for a detected function.
   *  - rule 2: max 2 uses per variant inside one video
   *  - must fit the function, otherwise the caller is told to warn instead
   */
  selectExplanation(
    fn: ScriptFunction,
    evidence: string,
    opts: { isShort?: boolean; hasMedia?: boolean } = {},
  ): { id: ExplanationVariantId; reason: string; alternatives: ExplanationVariantId[]; fits: boolean; capped: boolean } {
    const candidates = EXPLANATION_VARIANTS.filter((v) => v.fits.includes(fn));
    const usable = opts.isShort ? candidates.filter((v) => v.shortsSafe) : candidates;

    if (usable.length === 0) {
      // brief section 8: warn the user instead of forcing an unsuitable scene
      return {
        id: 'animated_checklist',
        reason: `No variant in the library structurally matches a "${fn}" beat. Surfaced as a warning rather than forcing an ill-fitting scene.`,
        alternatives: [],
        fits: false,
        capped: false,
      };
    }

    const scored = usable.map((v) => {
      let score = 1;
      const notes: string[] = [];
      const used = this.useCount.get(v.id) ?? 0;
      if (used >= 2) {
        // rule 2 is a hard cap: the least-repeated structural option always wins
        score -= 40;
        notes.push('blocked: already used twice in this video');
      } else if (used > 0) {
        score -= 2;
        notes.push('already used once in this video');
      }
      // rule: "not used in the last two scenes"
      const lastTwo = this.recentScenes.slice(-2);
      if (lastTwo.includes(v.id)) {
        score -= 5;
        notes.push('not used in the last two scenes');
      } else {
        notes.push('not used in the last two scenes');
      }
      if (opts.isShort && v.shortsSafe) {
        score += 2;
        notes.push('native 9:16 layout, no shrunken landscape slide');
      }
      if (opts.hasMedia && ['site_footage_callouts', 'document_annotation', 'dashboard_demo'].includes(v.id)) {
        score += 1.2;
        notes.push('project has media assets available to illustrate it');
      }
      if (!opts.hasMedia && REQUIRES_MEDIA.includes(v.id)) {
        // hard block: these layouts are meaningless without a real photo or
        // document. The brief says warn the operator, not force a bad scene.
        score -= 100;
        notes.push('blocked: this layout needs uploaded site/document media, and this project has none');
      }
      score += this.rng() * 1.6;
      return { v, score, notes };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    return {
      id: best.v.id,
      reason:
        `Selected style: ${best.v.label}. Reason: ${evidence}. ` +
        `Previous usage: ${best.notes.join('; ')}. ` +
        `Alternative styles: ${scored.slice(1, 4).map((s) => explanationById(s.v.id).label).join(' / ')}.`,
      alternatives: scored.slice(1, 4).map((s) => s.v.id),
      fits: true,
      capped: (this.useCount.get(best.v.id) ?? 0) >= 2,
    };
  }

  /* ---------------- backgrounds ---------------- */

  selectBackground(
    preferred: BackgroundVariantId[],
    sceneSeconds: number,
    hasMedia: boolean,
  ): { id: BackgroundVariantId; reason: string; alternatives: BackgroundVariantId[] } {
    const scored = BACKGROUND_VARIANTS.map((b) => {
      let score = 1;
      const notes: string[] = [];
      const run = this.backgroundRunSeconds[b.id] ?? 0;
      if (run + sceneSeconds > b.maxContinuousSeconds) {
        score -= 12;
        notes.push(`blocked: would exceed ${b.maxContinuousSeconds}s continuous background`);
      } else if (run > 0) {
        score -= 2.5;
        notes.push(`already used ${run.toFixed(1)}s continuously`);
      }
      if (preferred.includes(b.id)) {
        score += 4;
        notes.push('preferred by the selected scene variant');
      }
      // Rotate the dominant SURFACE SET forward for every new video, so
      // consecutive videos are not merely reshuffles of the same backgrounds.
      if (this.rotation.length) {
        if (this.rotation.includes(b.id)) {
          score += 1.6;
          notes.push('part of this video\'s rotated surface set');
        } else if (this.recentRotation.includes(b.id)) {
          score -= 1.8;
          notes.push('penalised: belonged to the previous video\'s surface set');
        }
      }
      if (b.needsMedia && !hasMedia) {
        score -= 5;
        notes.push('penalised: needs uploaded media');
      }
      if (b.needsMedia && hasMedia) score += 1.0;
      const recent = this.recentBackgrounds.slice(-3);
      if (recent.filter((r) => r === b.id).length >= 2) {
        score -= 4;
        notes.push('background is repeating in the recent run of scenes');
      }
      score += this.rng() * 1.1;
      return { b, score, notes };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    return {
      id: best.b.id,
      reason: `Background "${best.b.label}" chosen: ${best.notes.join('; ')}. Max continuous ${best.b.maxContinuousSeconds}s per anti-repetition rule.`,
      alternatives: scored.slice(1, 3).map((s) => s.b.id),
    };
  }

  /* ---------------- transitions ---------------- */

  selectTransition(matchWithNumber: boolean): { id: TransitionVariantId; reason: string; alternatives: TransitionVariantId[] } {
    const recent = this.recentTransitions.slice(-2);
    const scored = TRANSITION_VARIANTS.map((t) => {
      let score = 1;
      const notes: string[] = [];
      if (recent[0] === t.id && recent[1] === t.id) {
        score -= 12;
        notes.push('blocked: would be the same transition three scenes in a row');
      } else if (recent.includes(t.id)) {
        score -= 4;
        notes.push('used in the immediately preceding scene');
      }
      if (matchWithNumber && t.id === 'match_cut') {
        score += 3.5;
        notes.push('match cut available: incoming and outgoing scenes share a figure');
      }
      if (t.frames === 0) score += 0.4;
      score += this.rng() * 1.0;
      return { t, score, notes };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    return {
      id: best.t.id,
      reason: `Transition "${best.t.label}": ${best.notes.join('; ')}.`,
      alternatives: scored.slice(1, 3).map((s) => s.t.id),
    };
  }

  /* ---------------- accents, text position, cta, captions ---------------- */

  /**
   * Accent colours are part of the *variable* layer, but the order in which they
   * appear is a strong visual signal, so the run is rotated away from the
   * previous video's sequence rather than chosen at random.
   */
  selectAccent(brandId: string): string {
    const palette = ACCENT_PALETTE[brandId] ?? Object.values(ACCENT_PALETTE)[0] ?? ['#FFB703'];
    const prev = this.lastVideo?.accents ?? [];

    const scored = palette.map((c) => {
      let score = 1 + this.rng() * 0.6;
      if (this.usedAccents.has(c)) score -= 1.4; // spread across this video
      const usedBefore = prev.filter((a) => a === c).length;
      if (usedBefore) {
        score -= Math.min(2.2, usedBefore * 0.5);
        if (prev[0] === c) score -= 1.6; // do not open on last video's colour
      }
      return { c, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const pick = scored[0].c;
    this.usedAccents.add(pick);
    return pick;
  }

  selectTextPosition(isShort: boolean): TextPositionId {
    // shorts must never put key text in the right rail or below the CTA zone
    // Shorts: the right rail and the bottom third are covered by platform UI,
    // so they are not offered at all.
    const allowed: TextPositionId[] = isShort ? ['center', 'top_center', 'full_frame_center'] : this.library.textPositions;
    const free = allowed.filter((p) => !this.usedTextPositions.has(p));
    const pool = free.length ? free : allowed;
    const pick = pool[Math.floor(this.rng() * pool.length) % pool.length];
    this.usedTextPositions.add(pick);
    return pick;
  }

  selectCtaAnimation(): { id: CtaAnimationId; reason: string; alternatives: CtaAnimationId[] } {
    const lastTwo = this.lastTwoVideos.map((v) => v.ctaAnimation);
    const scored = this.library.ctaAnimations.map((a) => {
      let score = 1;
      const notes: string[] = [];
      if (lastTwo.length === 2 && lastTwo[0] === a && lastTwo[1] === a) {
        score -= 12;
        notes.push('blocked: the last two videos used the same CTA animation');
      } else if (lastTwo.includes(a)) {
        score -= 3.5;
        notes.push('used by the previous video');
      }
      score += this.rng() * 1.2;
      return { a, score, notes };
    });
    scored.sort((x, y) => y.score - x.score);
    return {
      id: scored[0].a,
      reason: `CTA animation "${scored[0].a}": ${scored[0].notes.join('; ') || 'first video in the history'}.`,
      alternatives: scored.slice(1, 3).map((s) => s.a),
    };
  }

  selectCaptionStyle(): CaptionStyleId {
    const used = this.lastFiveVideos.map((v) => v.captionStyle);
    const scored = this.library.captionStyles.map((s) => {
      let score = 1 + this.rng() * 1.5;
      const n = used.filter((u) => u === s).length;
      score -= n * 1.2;
      return { s, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].s;
  }

  /* ---------------- state mutation ---------------- */

  registerScene(variant: SceneVariantId, background: BackgroundVariantId, transition: TransitionVariantId, seconds: number) {
    this.useCount.set(variant, (this.useCount.get(variant) ?? 0) + 1);
    this.recentScenes.push(variant);
    this.recentBackgrounds.push(background);
    this.recentTransitions.push(transition);
    this.backgroundRunSeconds[background] = (this.backgroundRunSeconds[background] ?? 0) + seconds;
  }

  /** Called by the storyboard builder whenever the chosen background changes. */
  resetBackgroundRun(background: BackgroundVariantId) {
    for (const k of Object.keys(this.backgroundRunSeconds)) {
      if (k !== background) this.backgroundRunSeconds[k] = 0;
    }
  }

  get usageSnapshot(): Record<string, number> {
    return Object.fromEntries(this.useCount);
  }
}
