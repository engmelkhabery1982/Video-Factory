/**
 * Maps a reviewed Milestone 2 selection onto the canonical editor document.
 *
 * Timing is never invented. Each scene gets its time from exactly one source:
 *  - `measured_synthesis`: the duration of audio the local engine wrote for
 *    that scene (real byte length, not an alignment).
 *  - `supplied`: start/end the reviewer approved in a storyboard.
 *  - `estimated_text_length`: a proportional split of supplied full audio by
 *    character count. It is an ESTIMATE, labelled as such, and never acoustic
 *    proof. Alignment stays `not_requested`.
 */
import {
  assertValidEditorDocument,
  EDITOR_SCHEMA_VERSION,
  FULL_FRAME,
  TIME_EPSILON,
  type DeriveAssetRef,
  type EditorAsset,
  type EditorAudioClip,
  type EditorCaption,
  type EditorDocument,
  type EditorFormat,
  type EditorContentProfile,
  type EditorVisualClip,
} from '../editor/document.js';
import { FactoryError, type FactoryLanguage, type FactoryTimingSource } from './contract.js';

export interface FactoryTimingUnit {
  id: string;
  narration: string;
  startSec: number | null;
  endSec: number | null;
}

export interface FactoryTimingPlan {
  timingSource: FactoryTimingSource;
  totalDurationSec: number;
  items: Array<{ id: string; startSec: number; durationSec: number }>;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Decide the timeline. Exactly one of `measuredDurationsSec` (per-scene
 * synthesis) or `totalDurationSec` (supplied full audio) must be provided.
 */
export function planFactoryTiming(input: {
  units: FactoryTimingUnit[];
  measuredDurationsSec: Record<string, number> | null;
  totalDurationSec: number | null;
}): FactoryTimingPlan {
  const { units } = input;
  if (units.length === 0) throw new FactoryError('FACTORY_VALIDATION', 'No scenes to time.', 422);
  if (input.measuredDurationsSec) {
    const items = units.map((u) => {
      const d = input.measuredDurationsSec?.[u.id];
      if (typeof d !== 'number' || !(d > 0)) throw new FactoryError('FACTORY_SPEECH_FAILED', `Scene "${u.id}" has no measured audio duration.`, 422);
      return { id: u.id, durationSec: round3(d) };
    });
    let cursor = 0;
    const sequenced = items.map((it) => {
      const row = { id: it.id, startSec: round3(cursor), durationSec: it.durationSec };
      cursor += it.durationSec;
      return row;
    });
    return { timingSource: 'measured_synthesis', totalDurationSec: round3(cursor), items: sequenced };
  }
  const total = input.totalDurationSec;
  if (typeof total !== 'number' || !(total > 0)) {
    throw new FactoryError('FACTORY_INPUTS_REQUIRED', 'Full audio needs a positive measured duration before scenes can be timed.', 422);
  }
  const allSupplied = units.every((u) => u.startSec !== null && u.endSec !== null);
  if (allSupplied) {
    let cursor = 0;
    const items = units.map((u) => {
      if (Math.abs((u.startSec as number) - cursor) > TIME_EPSILON) {
        throw new FactoryError('FACTORY_VALIDATION', `Scene "${u.id}" does not start where the previous scene ends. The editor timeline must be contiguous.`, 422);
      }
      const dur = round3((u.endSec as number) - (u.startSec as number));
      if (!(dur > 0)) throw new FactoryError('FACTORY_VALIDATION', `Scene "${u.id}" has no positive duration.`, 422);
      const row = { id: u.id, startSec: round3(cursor), durationSec: dur };
      cursor += dur;
      return row;
    });
    if (Math.abs(cursor - total) > 0.05) {
      throw new FactoryError('FACTORY_VALIDATION', 'Supplied scene times do not cover the supplied audio duration.', 422);
    }
    return { timingSource: 'supplied', totalDurationSec: round3(total), items };
  }
  // Estimate only: split by character count, last scene absorbs rounding.
  const weights = units.map((u) => Math.max(1, Array.from(u.narration).length));
  const sum = weights.reduce((a, b) => a + b, 0);
  let cursor = 0;
  const items = units.map((u, i) => {
    const dur = i === units.length - 1 ? round3(total - cursor) : round3((total * weights[i]) / sum);
    const row = { id: u.id, startSec: round3(cursor), durationSec: dur };
    cursor += dur;
    return row;
  });
  return { timingSource: 'estimated_text_length', totalDurationSec: round3(total), items };
}

export interface FactoryEditorSceneInput {
  id: string;
  narration: string;
  language: FactoryLanguage;
  speakerId: string | null;
  locked: boolean;
  visual: DeriveAssetRef;
  startSec: number;
  durationSec: number;
  /** Per-scene audio (synthesized) or null when the full narration covers the scene. */
  audio: DeriveAssetRef | null;
}

export interface FactoryEditorBuildInput {
  projectId: string;
  contentProfile: EditorContentProfile;
  channelBrandId: string | null;
  format: EditorFormat;
  scenes: FactoryEditorSceneInput[];
  /** Supplied full narration audio, or null when every scene has its own audio. */
  fullAudio: { ref: DeriveAssetRef; durationSec: number; sha256: string | null } | null;
  /** Assets generated for this build (already registered in the library by the caller). */
  generatedAssets?: DeriveAssetRef[];
}

const isRtl = (text: string) => /[\u0600-\u06FF]/.test(text);

function editorAsset(ref: DeriveAssetRef, durationSec: number | null, sha256: string | null): EditorAsset {
  return {
    id: ref.id,
    kind: ref.kind,
    name: ref.name,
    mediaUrl: ref.mediaUrl,
    durationSec,
    source: ref.source,
    license: ref.license,
    sha256,
  };
}

/** Build the canonical editor document for one derived project. Pure. */
export function buildFactoryEditorDocument(input: FactoryEditorBuildInput): EditorDocument {
  if (input.scenes.length === 0) throw new FactoryError('FACTORY_VALIDATION', 'No scenes to map.', 422);
  const assets = new Map<string, EditorAsset>();
  const visualClips: EditorVisualClip[] = [];
  const audioClips: EditorAudioClip[] = [];
  const captions: EditorCaption[] = [];
  let total = 0;
  for (const s of input.scenes) {
    if (!(s.durationSec > 0)) throw new FactoryError('FACTORY_VALIDATION', `Scene "${s.id}" has no positive duration.`, 422);
    const isVideo = s.visual.kind === 'video';
    if (isVideo && (s.visual.durationSec === null || s.visual.durationSec + TIME_EPSILON < s.durationSec)) {
      throw new FactoryError('FACTORY_ASSET_INVALID', `Scene "${s.id}" needs ${s.durationSec}s of video but ${s.visual.id} is shorter.`, 422);
    }
    if (!assets.has(s.visual.id)) assets.set(s.visual.id, editorAsset(s.visual, s.visual.durationSec, s.visual.sha256 ?? null));
    visualClips.push({
      id: `vc_${s.id}`,
      sourceAssetId: s.visual.id,
      startSec: round3(s.startSec),
      durationSec: round3(s.durationSec),
      sourceInSec: isVideo ? 0 : null,
      sourceOutSec: isVideo ? round3(s.durationSec) : null,
      crop: { ...FULL_FRAME },
      motion: 'none',
      transition: 'cut',
      locked: s.locked,
    });
    if (s.audio) {
      if (!assets.has(s.audio.id)) assets.set(s.audio.id, editorAsset(s.audio, s.audio.durationSec, s.audio.sha256 ?? null));
      audioClips.push({
        id: `ac_${s.id}`,
        sourceAssetId: s.audio.id,
        speakerId: s.speakerId,
        startSec: round3(s.startSec),
        sourceInSec: 0,
        sourceOutSec: round3(s.durationSec),
        gainDb: 0,
        locked: s.locked,
        approved: false,
      });
    }
    captions.push({
      id: `cap_${s.id}`,
      startSec: round3(s.startSec),
      endSec: round3(s.startSec + s.durationSec),
      text: s.narration,
      language: s.language,
      direction: isRtl(s.narration) ? 'rtl' : 'ltr',
      fontSizePx: 48,
      position: { x: 0.5, y: 0.86 },
      locked: false,
    });
    total = Math.max(total, s.startSec + s.durationSec);
  }
  if (input.fullAudio) {
    const f = input.fullAudio;
    if (!assets.has(f.ref.id)) assets.set(f.ref.id, editorAsset(f.ref, f.durationSec, f.sha256));
    audioClips.unshift({
      id: 'ac_full_narration',
      sourceAssetId: f.ref.id,
      speakerId: null,
      startSec: 0,
      sourceInSec: 0,
      sourceOutSec: round3(f.durationSec),
      gainDb: 0,
      locked: false,
      approved: false,
    });
  }
  const doc: EditorDocument = {
    schemaVersion: EDITOR_SCHEMA_VERSION,
    projectId: input.projectId,
    revision: 0,
    contentProfile: input.contentProfile,
    channelBrandId: input.channelBrandId,
    targetId: 'long',
    format: input.format,
    durationSec: round3(total),
    assets: [...assets.values()],
    visualClips,
    audioClips,
    captions,
    highlights: [],
    alignment: {
      status: 'not_requested',
      audioSha256: input.fullAudio?.sha256 ?? null,
      sourceRevision: null,
      proposalId: null,
    },
  };
  assertValidEditorDocument(doc);
  return doc;
}
