import { applyGlossary, chunkCaptionText, glossaryHits } from './captions.js';
import type { CaptionCue, Project, Scene, ShortPlan, Storyboard } from './types.js';

/**
 * Target-media contract (Phase 0).
 *
 * An export produces one Long and up to three Shorts. Each Short has its own
 * scenes and its own narration, so it must also get its own audio, its own
 * captions and its own duration. Everything the renderer, the mux step, the
 * caption writers and QC need for ONE target is resolved here, in one place,
 * so no caller can take scenes from one target and audio/captions from another.
 */

export const SHORT_IDS = ['short_1', 'short_2', 'short_3'] as const;
export type ShortId = ShortPlan['id'];
export type TargetId = 'long' | ShortId;
export type TargetFormat = 'long' | 'short';

/** A resolved, on-disk narration file for one target. */
export interface TargetAudio {
  file: string;
  /** measured duration in seconds, when known */
  durationSec: number | null;
  /**
   * Optional exact speech timing: how long each scene's narration occupies in
   * this file, in scene order, with the text that was spoken. Produced by the
   * demo generator; used only when the texts match the Short's scenes.
   */
  sceneTiming?: SceneTiming[] | null;
}

export interface SceneTiming {
  text: string;
  /** seconds of audio for this scene, including its trailing pause */
  duration: number;
}

/** Audio keyed by target. A Short's lookup reads ONLY its own key. */
export type TargetAudioMap = Partial<Record<TargetId, TargetAudio | null>>;

export interface TargetMedia {
  targetId: TargetId;
  format: TargetFormat;
  scenes: Scene[];
  captions: CaptionCue[];
  /** exactly one resolved narration file, or null for a silent legacy Long */
  audioFile: string | null;
  audioDurationSec: number | null;
  /** delivered duration: the target's own timeline */
  durationSec: number;
  /** the spoken script of this target, scene narration in scene order */
  narration: string;
}

export type TargetResolution =
  | { ok: true; targetId: TargetId; format: TargetFormat; media: TargetMedia }
  | { ok: false; targetId: TargetId; format: TargetFormat; error: string };

export function isShortId(id: string): id is ShortId {
  return (SHORT_IDS as readonly string[]).includes(id);
}

export function formatOf(id: TargetId): TargetFormat {
  return id === 'long' ? 'long' : 'short';
}

/** The spoken text of a target: each scene's narration in scene order. */
export function targetNarration(scenes: Scene[]): string {
  return scenes
    .map((s) => (s.narration ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/** Targets present in a storyboard, Long first. */
export function listTargets(st: Storyboard): TargetId[] {
  return ['long', ...st.shorts.map((s) => s.id)];
}

/* ------------------------------------------------------------------ */
/* Short timing and captions                                           */
/* ------------------------------------------------------------------ */

const CUE_CHARS = 72; // two 42-char lines, minus headroom (matches buildCues)

function chunkText(text: string): string[] {
  // Phase 0C: phrase-boundary chunking with orphan repair, shared with the Long
  return chunkCaptionText(applyGlossary(text), CUE_CHARS);
}

/** readability limits for a Short's timeline (brief section 10) */
export const SHORT_TIMING = { hookMax: 3, bodyMin: 1.5, bodyMax: 3.2, ctaMin: 1.5, ctaMax: 8, tail: 0.3 } as const;

function boundsFor(role: Scene['role']): [number, number] {
  if (role === 'hook') return [1.2, SHORT_TIMING.hookMax];
  if (role === 'cta') return [SHORT_TIMING.ctaMin, SHORT_TIMING.ctaMax];
  return [SHORT_TIMING.bodyMin, SHORT_TIMING.bodyMax];
}

/**
 * Distribute `total` over weights while respecting per-scene [min,max] bounds
 * (water-filling). If the bounds cannot absorb `total`, the result is clamped
 * and the difference lands on the CTA/last scene so nothing is ever cut.
 */
function clampedShares(weights: number[], bounds: [number, number][], total: number): number[] {
  const n = weights.length;
  const out = new Array<number>(n).fill(0);
  const fixed = new Array<boolean>(n).fill(false);
  for (let iter = 0; iter < n + 1; iter++) {
    const freeIdx = [...Array(n).keys()].filter((i) => !fixed[i]);
    const remaining = total - out.reduce((a, d, i) => a + (fixed[i] ? d : 0), 0);
    const wsum = freeIdx.reduce((a, i) => a + weights[i], 0) || 1;
    let changed = false;
    for (const i of freeIdx) {
      const d = (weights[i] / wsum) * remaining;
      const [lo, hi] = bounds[i];
      if (d < lo || d > hi) {
        out[i] = Math.min(hi, Math.max(lo, d));
        fixed[i] = true;
        changed = true;
      } else out[i] = d;
    }
    if (!changed) break;
  }
  const diff = total - out.reduce((a, b) => a + b, 0);
  if (Math.abs(diff) > 1e-6) out[n - 1] = Math.max(0.5, out[n - 1] + diff);
  return out;
}

/**
 * Re-time a Short so its scenes follow its OWN narration audio. Nothing is
 * trimmed: the Short lasts as long as its audio plus a short tail.
 *
 * With exact `timing` (per-scene speech durations whose texts match the
 * scenes) each scene is exactly as long as its spoken beat, so the scene on
 * screen - and its captions - are the ones being heard. Otherwise scenes are
 * weighted by narration length within the readability bounds.
 */
export function fitShortToAudio(plan: ShortPlan, audioDurationSec: number, timing?: SceneTiming[] | null): ShortPlan {
  if (!(audioDurationSec > 0) || !plan.scenes.length) return plan;
  const total = Number((audioDurationSec + SHORT_TIMING.tail).toFixed(3));
  let durations: number[];
  const exact =
    timing &&
    timing.length === plan.scenes.length &&
    timing.every((t, i) => t.text.trim() === (plan.scenes[i].narration ?? '').trim() && t.duration > 0);
  if (exact) {
    durations = timing!.map((t) => t.duration);
    const sum = durations.reduce((a, b) => a + b, 0);
    durations[durations.length - 1] += Math.max(0, total - sum);
  } else {
    const weights = plan.scenes.map((s) => Math.max(1, (s.narration ?? '').length));
    durations = clampedShares(weights, plan.scenes.map((s) => boundsFor(s.role)), total);
  }
  let acc = 0;
  const scenes = plan.scenes.map((s, i) => {
    const duration = Number(durations[i].toFixed(3));
    const out = { ...s, startTime: Number(acc.toFixed(3)), duration };
    acc += duration;
    return out;
  });
  return { ...plan, scenes, totalDuration: Number(acc.toFixed(2)) };
}

/**
 * Captions for a Short, built from that Short's scene narration. Each scene's
 * text is placed inside that scene's own time window, so every cue references
 * a scene of this Short and never runs past the Short's end.
 */
export function buildShortCaptions(plan: ShortPlan): CaptionCue[] {
  // Phase 0C.1: visual beats that are halves of ONE sentence are captioned from
  // the reconstructed sentence, once, across the combined window. Scene timing,
  // audio and emphasis are untouched; a cue may span the beat boundary and is
  // linked to the scene in which it starts.
  const cues: CaptionCue[] = [];
  const end = plan.totalDuration;
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9%.]+/g, ' ').trim();
  const groups: Scene[][] = [];
  for (const scene of plan.scenes) {
    const last = groups[groups.length - 1];
    const src = scene.content?.source;
    if (last && src && scene.content?.emphasis && last[0].content?.source === src && last[0].content?.emphasis) last.push(scene);
    else groups.push([scene]);
  }
  for (const g of groups) {
    const joined = g.map((s) => s.narration ?? '').join(' ');
    const src = g[0].content?.source ?? '';
    // only when the beats really are that sentence, word for word
    const text = g.length > 1 && flat(joined) === flat(src) ? src : joined;
    const chunks = chunkText(text);
    if (!chunks.length) continue;
    const winStart = g[0].startTime + 0.05;
    const last = g[g.length - 1];
    const winEnd = Math.min(end, last.startTime + last.duration) - 0.05;
    const span = Math.max(0.1, winEnd - winStart);
    const chars = chunks.reduce((a, c) => a + c.length + 1, 0);
    let t = winStart;
    for (const chunk of chunks) {
      const d = ((chunk.length + 1) / chars) * span;
      const start = Math.max(0, Math.min(t, end));
      const stop = Math.min(end, t + d);
      const owner = [...g].reverse().find((s) => s.startTime <= start + 1e-6) ?? g[0];
      cues.push({
        id: `${plan.id}_cue_${String(cues.length + 1).padStart(3, '0')}`,
        start: Number(start.toFixed(3)),
        end: Number(Math.max(start, stop).toFixed(3)),
        text: chunk,
        sceneId: owner.id,
        terms: glossaryHits(chunk),
        userEdited: false,
      });
      t += d;
    }
  }
  return cues;
}

function captionsValidFor(cues: CaptionCue[], scenes: Scene[], duration: number): boolean {
  const ids = new Set(scenes.map((s) => s.id));
  return cues.every((c) => c.sceneId !== null && ids.has(c.sceneId) && c.start >= 0 && c.end <= duration + 1e-6 && c.start <= c.end);
}

/**
 * Captions for one target. Long -> `storyboard.captions` (the legacy field).
 * A Short -> its stored captions when they still belong to it, otherwise
 * captions freshly derived from its own scenes. Never the Long cues.
 */
export function captionsForTarget(st: Storyboard, id: TargetId): CaptionCue[] {
  if (id === 'long') return st.captions;
  const plan = st.shorts.find((s) => s.id === id);
  if (!plan) return [];
  const stored = st.shortCaptions?.[id];
  if (stored && stored.length && captionsValidFor(stored, plan.scenes, plan.totalDuration)) return stored;
  return buildShortCaptions(plan);
}

export function captionsByTarget(st: Storyboard): Partial<Record<TargetId, CaptionCue[]>> {
  const out: Partial<Record<TargetId, CaptionCue[]>> = {};
  for (const id of listTargets(st)) out[id] = captionsForTarget(st, id);
  return out;
}

/* ------------------------------------------------------------------ */
/* The resolver                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve everything that belongs to ONE export target. This is the single
 * source of truth for rendering, muxing, captions, QC and target metadata.
 *
 * Audio rules:
 *  - Long uses `audio.long` (the legacy `voiceoverFile`). A Long without audio
 *    stays exportable as a silent video, exactly as before.
 *  - A Short uses `audio[shortId]` and nothing else. Missing Short audio blocks
 *    that Short with an actionable error; the Long audio is never substituted.
 */
export function resolveTargetMedia(project: Project, id: TargetId, audio: TargetAudioMap): TargetResolution {
  const st = project.storyboard;
  const format = formatOf(id);
  const videoId = project.meta.input.videoId;

  if (id === 'long') {
    const a = audio.long ?? null;
    return {
      ok: true,
      targetId: id,
      format,
      media: {
        targetId: id,
        format,
        scenes: st.long.scenes,
        captions: st.captions,
        audioFile: a?.file ?? null,
        audioDurationSec: a?.durationSec ?? null,
        durationSec: st.long.totalDuration,
        narration: targetNarration(st.long.scenes),
      },
    };
  }

  const plan = st.shorts.find((s) => s.id === id);
  if (!plan) {
    return { ok: false, targetId: id, format, error: `${videoId} ${id}: this Short is not in the storyboard. Regenerate the storyboard or lower the Short count.` };
  }
  const a = audio[id] ?? null;
  if (!a || !a.file) {
    return {
      ok: false,
      targetId: id,
      format,
      error:
        `${videoId} ${id} is missing its own narration audio. ` +
        `Upload a narration recorded from ${id}'s scene script and set it as the ${id} voiceover, then export again. ` +
        `The Long voiceover is never reused for a Short.`,
    };
  }
  const longFile = audio.long?.file ?? null;
  if (longFile && a.file === longFile) {
    return {
      ok: false,
      targetId: id,
      format,
      error: `${videoId} ${id} points at the Long voiceover (${a.file}). A Short needs narration of its own scenes; upload a separate ${id} voiceover.`,
    };
  }
  return {
    ok: true,
    targetId: id,
    format,
    media: {
      targetId: id,
      format,
      scenes: plan.scenes,
      captions: captionsForTarget(st, id),
      audioFile: a.file,
      audioDurationSec: a.durationSec,
      durationSec: plan.totalDuration,
      narration: targetNarration(plan.scenes),
    },
  };
}

/**
 * Targets a project export will actually render.
 * `includeShorts !== false` means every Short, matching the historical default.
 * A Short is never added by falling back to the Long id.
 */
export function exportTargetIds(project: Project, opts: { includeShorts?: boolean } = {}): TargetId[] {
  return listTargets(project.storyboard).filter((id) => id === 'long' || opts.includeShorts !== false);
}

/** Resolve every requested target. Blocked targets never affect the others. */
export function planTargets(project: Project, audio: TargetAudioMap, opts: { includeShorts?: boolean } = {}): TargetResolution[] {
  return exportTargetIds(project, opts).map((id) => resolveTargetMedia(project, id, audio));
}

/* ------------------------------------------------------------------ */
/* Project schema                                                      */
/* ------------------------------------------------------------------ */

/**
 * v1: legacy - one project-wide voiceover and one caption track.
 * v2: target-specific media - `meta.input.targetAudio` and
 *     `storyboard.shortCaptions`. `voiceoverFile` / `storyboard.captions`
 *     keep their meaning as the LONG audio / LONG captions.
 */
export const PROJECT_SCHEMA_VERSION = 2;

/**
 * Upgrade a saved project to the current schema. Purely additive: no existing
 * field is removed or rewritten, Long captions and the Long voiceover are kept
 * byte-for-byte, and Short captions are derived from each Short's own scenes.
 */
export function migrateProject(raw: Project): Project {
  const from = raw.schemaVersion ?? 1;
  if (from > PROJECT_SCHEMA_VERSION) {
    throw new Error(`Project ${raw.meta?.input?.videoId ?? '?'} uses schema v${from}; this build understands up to v${PROJECT_SCHEMA_VERSION}.`);
  }
  if (from === PROJECT_SCHEMA_VERSION) return raw;
  const st = raw.storyboard;
  const shortCaptions: Partial<Record<ShortId, CaptionCue[]>> = { ...(st.shortCaptions ?? {}) };
  for (const plan of st.shorts ?? []) {
    if (!shortCaptions[plan.id]) shortCaptions[plan.id] = buildShortCaptions(plan);
  }
  return {
    ...raw,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    meta: { ...raw.meta, input: { ...raw.meta.input, targetAudio: { ...(raw.meta.input.targetAudio ?? {}) } } },
    storyboard: { ...st, shortCaptions },
  };
}
