import { applyGlossary, glossaryHits } from './captions.js';
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
  const words = applyGlossary(text).split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;
  for (const w of words) {
    buf.push(w);
    len += w.length + 1;
    if (len >= CUE_CHARS) {
      out.push(buf.join(' '));
      buf = [];
      len = 0;
    }
  }
  if (buf.length) out.push(buf.join(' '));
  return out;
}

/**
 * Re-time a Short so its scenes follow its own narration audio. Each scene gets
 * a share of the audio proportional to the length of its narration, so the
 * scene on screen is the one being spoken. Nothing is trimmed: the Short's
 * duration becomes the audio duration plus a short tail.
 */
export function fitShortToAudio(plan: ShortPlan, audioDurationSec: number): ShortPlan {
  if (!(audioDurationSec > 0) || !plan.scenes.length) return plan;
  const total = Number((audioDurationSec + 0.3).toFixed(2));
  const MIN = 1.2;
  const weights = plan.scenes.map((s) => Math.max(1, (s.narration ?? '').length));
  const sum = weights.reduce((a, b) => a + b, 0);
  let durations = weights.map((w) => Math.max(MIN, (w / sum) * total));
  // the MIN floor can push the sum over; rescale the rest to land exactly on total
  const over = durations.reduce((a, b) => a + b, 0) - total;
  if (over > 0) {
    const flex = durations.filter((d) => d > MIN).reduce((a, b) => a + b - MIN, 0);
    durations = durations.map((d) => (d > MIN && flex > 0 ? d - ((d - MIN) / flex) * over : d));
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
  const cues: CaptionCue[] = [];
  const end = plan.totalDuration;
  for (const scene of plan.scenes) {
    const chunks = chunkText(scene.narration ?? '');
    if (!chunks.length) continue;
    const winStart = scene.startTime + 0.05;
    const winEnd = Math.min(end, scene.startTime + scene.duration) - 0.05;
    const span = Math.max(0.1, winEnd - winStart);
    const chars = chunks.reduce((a, c) => a + c.length + 1, 0);
    let t = winStart;
    for (const text of chunks) {
      const d = ((text.length + 1) / chars) * span;
      const start = Math.max(0, Math.min(t, end));
      const stop = Math.min(end, t + d);
      cues.push({
        id: `${plan.id}_cue_${String(cues.length + 1).padStart(3, '0')}`,
        start: Number(start.toFixed(3)),
        end: Number(Math.max(start, stop).toFixed(3)),
        text,
        sceneId: scene.id,
        terms: glossaryHits(text),
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

/** Resolve every requested target. Blocked targets never affect the others. */
export function planTargets(project: Project, audio: TargetAudioMap, opts: { includeShorts?: boolean } = {}): TargetResolution[] {
  const ids = listTargets(project.storyboard).filter((id) => id === 'long' || opts.includeShorts !== false);
  return ids.map((id) => resolveTargetMedia(project, id, audio));
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
