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
import { FACTORY_SILENT_SCENE_SECONDS } from './intake.js';
import {
  assertValidEditorDocument,
  EDITOR_SCHEMA_VERSION,
  FULL_FRAME,
  type NormalizedBox,
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
import { FactoryError, type FactoryLanguage, type FactoryTimingSource, type FactoryVisualDecision } from './contract.js';
import type { EditorGraphic } from '../editor/graphics.js';
import { defaultGraphicActions, type GraphicPacing } from '../editor/graphic-builders.js';
import { isVisualLanguageId, isVisualTechniqueId, type VisualLanguageId, type VisualTechniqueId } from '../visual-language.js';

/** Tight framing: a centred 80% crop. The only framing the renderer applies from a treatment. */
export const TIGHT_FRAME: NormalizedBox = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

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
 * Timeline for a silent draft (no narration track). Nothing here is speech timing.
 * - Every scene has reviewed times: they must be contiguous and are kept (`supplied`).
 * - No scene has times: each scene gets the same labelled proposal duration (`visual_duration_proposal`), which the owner edits.
 * - Some but not all scenes have times: refused. A partial timeline is never completed by guessing.
 */
export function planSilentTiming(input: { units: FactoryTimingUnit[] }): FactoryTimingPlan {
  const { units } = input;
  if (units.length === 0) throw new FactoryError('FACTORY_VALIDATION', 'No scenes to time.', 422);
  const timed = units.filter((u) => u.startSec !== null && u.endSec !== null).length;
  if (timed > 0 && timed < units.length) {
    throw new FactoryError(
      'FACTORY_VALIDATION',
      'Some scenes have times and others do not. Give every scene times, or none, so the silent timeline is not guessed.',
      422,
    );
  }
  if (timed === 0) {
    const sec = FACTORY_SILENT_SCENE_SECONDS;
    let cursor = 0;
    const items = units.map((u) => {
      const row = { id: u.id, startSec: round3(cursor), durationSec: sec };
      cursor += sec;
      return row;
    });
    return { timingSource: 'visual_duration_proposal', totalDurationSec: round3(cursor), items };
  }
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
  return { timingSource: 'supplied', totalDurationSec: round3(cursor), items };
}

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
  /** Null for a procedural graphic scene, which has no source asset. */
  visual: DeriveAssetRef | null;
  /** Per-shot technique from the visual-language registry. Absent for legacy scenes. */
  technique?: VisualTechniqueId | null;
  /** Procedural graphic data. Present only for a graphic technique. */
  graphic?: EditorGraphic | null;
  /** Visual decisions executed on the editor clip (crop framing and still motion). */
  visualDecision: FactoryVisualDecision;
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
  /** Project visual language from the draft. Absent or null leaves the document as it was for legacy projects. */
  visualLanguage?: VisualLanguageId | null;
  /** Captions from narration text. Absent means on (legacy). A scene with no words never gets a caption. */
  captionsEnabled?: boolean;
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

/**
 * A planned graphic has no actions yet: the shot duration is only known here. Default actions are generated from
 * that duration and the treatment's pacing. Actions the owner already set are kept. Narration and captions are
 * never retimed by this.
 */
export function timedGraphic(graphic: EditorGraphic, durationSec: number, pacing: GraphicPacing | undefined): EditorGraphic {
  if (graphic.actions.length > 0) return graphic;
  return { ...graphic, actions: defaultGraphicActions(graphic, durationSec, pacing ?? 'measured') };
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
    const graphicScene = s.graphic !== undefined && s.graphic !== null;
    if (s.technique !== undefined && s.technique !== null && !isVisualTechniqueId(s.technique)) {
      throw new FactoryError('FACTORY_VALIDATION', `Scene "${s.id}" technique ${String(s.technique)} is not in the visual-language registry.`, 422);
    }
    if (graphicScene && s.visual) {
      throw new FactoryError('FACTORY_VALIDATION', `Scene "${s.id}" is a graphic shot and cannot also use a picture or footage. Clear one of them.`, 422);
    }
    if (!graphicScene && !s.visual) {
      throw new FactoryError('FACTORY_ASSET_INVALID', `Scene "${s.id}" needs an image or video, or a procedural graphic with supplied values.`, 422);
    }
    const isVideo = !!s.visual && s.visual.kind === 'video';
    if (s.visual && isVideo && (s.visual.durationSec === null || s.visual.durationSec + TIME_EPSILON < s.durationSec)) {
      throw new FactoryError('FACTORY_ASSET_INVALID', `Scene "${s.id}" needs ${s.durationSec}s of video but ${s.visual.id} is shorter.`, 422);
    }
    if (s.visual && !assets.has(s.visual.id)) assets.set(s.visual.id, editorAsset(s.visual, s.visual.durationSec, s.visual.sha256 ?? null));
    visualClips.push({
      id: `vc_${s.id}`,
      sourceAssetId: s.visual ? s.visual.id : null,
      startSec: round3(s.startSec),
      durationSec: round3(s.durationSec),
      sourceInSec: isVideo ? 0 : null,
      sourceOutSec: isVideo ? round3(s.durationSec) : null,
      crop: s.visualDecision.framing === 'tight' ? { ...TIGHT_FRAME } : { ...FULL_FRAME },
      motion: isVideo ? 'none' : s.visualDecision.motion,
      transition: 'cut',
      locked: s.locked,
      // A graphic clip's technique is its graphic kind. A media clip carries its selected technique, if any.
      ...(graphicScene ? { technique: s.graphic!.kind, graphic: timedGraphic(s.graphic!, s.durationSec, s.visualDecision.pacing) } : (s.technique ? { technique: s.technique } : {})),
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
    if (input.captionsEnabled !== false && s.narration.trim().length > 0) {
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
    }
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
  if (input.visualLanguage !== undefined && input.visualLanguage !== null && !isVisualLanguageId(input.visualLanguage)) {
    throw new FactoryError('FACTORY_VALIDATION', 'visualLanguage is not a registered visual language.', 422);
  }
  const doc: EditorDocument = {
    schemaVersion: EDITOR_SCHEMA_VERSION,
    projectId: input.projectId,
    revision: 0,
    contentProfile: input.contentProfile,
    channelBrandId: input.channelBrandId,
    targetId: 'long',
    format: input.format,
    ...(input.visualLanguage ? { visualLanguage: input.visualLanguage } : {}),
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
