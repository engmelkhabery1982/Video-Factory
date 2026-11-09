/**
 * Narration binding, alignment-row application and proposal identity for the
 * editor. Pure functions: no I/O, no hashing (the API hashes; core stays
 * browser-safe).
 */
import {
  EditorError,
  TIME_EPSILON,
  type EditorSyncVerdict,
  validateEditorDocument,
  type EditorAudioClip,
  type EditorAsset,
  type EditorDocument,
} from './document.js';

/** Stable ids: a new owner import replaces the same asset and clip. */
export const NARRATION_ASSET_ID = 'narration';
export const NARRATION_CLIP_ID = 'ac_narration';

/** The existing project narration, as the editor sees it. */
export interface NarrationBinding {
  importId: string;
  name: string;
  mediaUrl: string;
  source: string;
  license: string;
  durationSec: number;
  sha256: string;
  /** True only when the existing listening approval matches this exact import and file. */
  approved: boolean;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function assertBinding(b: NarrationBinding): void {
  if (!SHA256_RE.test(b.sha256)) throw new EditorError('EDITOR_INVALID_CHANGE', 'narration sha256 is not a SHA-256 digest.', 422);
  if (!Number.isFinite(b.durationSec) || b.durationSec <= 0) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'narration duration must be a positive number.', 422);
  }
  if (!b.mediaUrl || !b.name || !b.source || !b.license) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'narration reference needs name, mediaUrl, source and license.', 422);
  }
}

function resetAlignment(doc: EditorDocument): void {
  doc.alignment = { status: 'not_requested', audioSha256: null, sourceRevision: null, proposalId: null };
}

/**
 * Make the narration asset and its audio clip match the project's current
 * narration. Returns the same document when nothing changed.
 *
 * - A new recording (different import or file bytes) replaces the asset, resets
 *   the clip to the full file, clears its approval and resets alignment. The
 *   old trim no longer describes the new file.
 * - An approval change alone only updates `approved`; trim and alignment stay.
 * - No binding removes the narration asset and clip and resets alignment.
 */
export function reconcileNarration(
  doc: EditorDocument,
  binding: NarrationBinding | null,
): { doc: EditorDocument; changed: boolean } {
  const next = JSON.parse(JSON.stringify(doc)) as EditorDocument;
  const asset = next.assets.find((a) => a.id === NARRATION_ASSET_ID);
  const clip = next.audioClips.find((c) => c.id === NARRATION_CLIP_ID);

  if (!binding) {
    if (!asset && !clip) return { doc, changed: false };
    next.assets = next.assets.filter((a) => a.id !== NARRATION_ASSET_ID);
    next.audioClips = next.audioClips.filter((c) => c.id !== NARRATION_CLIP_ID);
    resetAlignment(next);
    return { doc: next, changed: true };
  }

  assertBinding(binding);
  const matches =
    asset !== undefined &&
    clip !== undefined &&
    asset.sha256 === binding.sha256 &&
    asset.durationSec === binding.durationSec &&
    asset.mediaUrl === binding.mediaUrl &&
    asset.name === binding.name &&
    asset.source === binding.source &&
    asset.license === binding.license;

  if (!matches) {
    const replacement: EditorAsset = {
      id: NARRATION_ASSET_ID,
      kind: 'audio',
      name: binding.name,
      mediaUrl: binding.mediaUrl,
      durationSec: binding.durationSec,
      source: binding.source,
      license: binding.license,
      sha256: binding.sha256,
      approvedSeen: binding.approved,
    };
    next.assets = [...next.assets.filter((a) => a.id !== NARRATION_ASSET_ID), replacement];
    const full: EditorAudioClip = {
      id: NARRATION_CLIP_ID,
      sourceAssetId: NARRATION_ASSET_ID,
      speakerId: clip?.speakerId ?? null,
      startSec: 0,
      sourceInSec: 0,
      sourceOutSec: binding.durationSec,
      gainDb: clip?.gainDb ?? 0,
      locked: clip?.locked ?? false,
      approved: binding.approved,
    };
    next.audioClips = [...next.audioClips.filter((c) => c.id !== NARRATION_CLIP_ID), full];
    resetAlignment(next);
    return { doc: next, changed: true };
  }

  // Only a change on the PROJECT side moves the clip's approval. An editor
  // edit (for example a trim, which clears approval) is kept until the project
  // itself changes its listening decision.
  if (asset.approvedSeen !== binding.approved) {
    asset.approvedSeen = binding.approved;
    clip.approved = binding.approved;
    return { doc: next, changed: true };
  }
  return { doc, changed: false };
}

export interface AlignmentRow {
  sceneId: string;
  /** Source time (seconds) inside the narration file. */
  startSec: number;
  endSec: number;
}

/**
 * Validate worker rows before they can become a proposal. Rows are source times
 * in the narration file. They must be finite, ordered, unique per scene and
 * inside the file.
 */
export function validateAlignmentRows(rows: unknown, audioDurationSec: number): AlignmentRow[] {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new EditorError('ALIGNMENT_ROWS_INVALID', 'alignment rows must be a non-empty array.', 422);
  }
  const seen = new Set<string>();
  let previousEnd = -Infinity;
  const out: AlignmentRow[] = [];
  for (const raw of rows) {
    const r = raw as Partial<AlignmentRow>;
    if (typeof r.sceneId !== 'string' || r.sceneId.length === 0) {
      throw new EditorError('ALIGNMENT_ROWS_INVALID', 'every alignment row needs a sceneId.', 422);
    }
    if (seen.has(r.sceneId)) throw new EditorError('ALIGNMENT_ROWS_INVALID', `duplicate sceneId ${r.sceneId}.`, 422);
    seen.add(r.sceneId);
    if (typeof r.startSec !== 'number' || typeof r.endSec !== 'number' || !Number.isFinite(r.startSec) || !Number.isFinite(r.endSec)) {
      throw new EditorError('ALIGNMENT_ROWS_INVALID', `row ${r.sceneId} has non-finite times.`, 422);
    }
    if (!(r.endSec > r.startSec + TIME_EPSILON)) throw new EditorError('ALIGNMENT_ROWS_INVALID', `row ${r.sceneId} must end after it starts.`, 422);
    if (r.startSec < previousEnd - TIME_EPSILON) throw new EditorError('ALIGNMENT_ROWS_INVALID', `row ${r.sceneId} overlaps the previous row.`, 422);
    if (r.endSec > audioDurationSec + TIME_EPSILON) throw new EditorError('ALIGNMENT_ROWS_INVALID', `row ${r.sceneId} ends after the narration file.`, 422);
    previousEnd = r.endSec;
    out.push({ sceneId: r.sceneId, startSec: r.startSec, endSec: r.endSec });
  }
  return out;
}

/**
 * One spoken unit per caption cue, in document order. Units are independent of
 * visual clips: a visual split or trim does not change them. Each unit is the
 * caption id and its text, which is exactly what the alignment worker is given
 * (as a project snapshot) and what the proposal identity hashes.
 */
export interface AlignmentUnit {
  unitId: string;
  text: string;
}

export function alignmentUnits(doc: EditorDocument): AlignmentUnit[] {
  return doc.captions.filter((c) => !c.cueOf).map((c) => ({ unitId: c.id, text: c.text }));
}

/** The narration mapping that decides where source times land on the timeline. */
export function narrationMappingOf(doc: EditorDocument): { startSec: number; sourceInSec: number; sourceOutSec: number } | null {
  // A factory draft with one supplied recording keeps its library source. It
  // must not be copied into a second, overlapping narration track to align it.
  // Several library tracks are ambiguous; never pick the first music/voice.
  const audio = doc.audioClips.find((c) => c.id === NARRATION_CLIP_ID)
    ?? (doc.audioClips.length === 1 ? doc.audioClips[0] : undefined);
  return audio ? { startSec: audio.startSec, sourceInSec: audio.sourceInSec, sourceOutSec: audio.sourceOutSec } : null;
}

/**
 * The inputs an alignment depends on: the caption units (ids and texts, in
 * order) and the narration mapping. Visual clips are not inputs. The API hashes
 * this string. Changing a caption's text or the narration trim makes a proposal
 * stale; visual edits do not.
 */
export function alignmentIdentityPayload(doc: EditorDocument): string {
  return JSON.stringify({ units: alignmentUnits(doc), narration: narrationMappingOf(doc) });
}

/**
 * Apply reviewed alignment rows to captions. Each row is a caption id with the
 * ACTUAL speech boundaries the worker emitted, in narration source time. Each
 * boundary is moved to the timeline through the narration clip's offset
 * (composition = clip.startSec + (source - clip.sourceInSec)). No caption is
 * scaled inside a visual clip. Captions without a row are untouched.
 */
export function applyAlignmentRows(
  doc: EditorDocument,
  rows: AlignmentRow[],
  meta: { audioSha256: string; proposalId: string; sourceRevision: number; excerptSha256?: string | null; syncVerdict?: EditorSyncVerdict | null },
): EditorDocument {
  const next = JSON.parse(JSON.stringify(doc)) as EditorDocument;
  const audio = next.audioClips.find((c) => c.id === NARRATION_CLIP_ID);
  if (!audio) throw new EditorError('ALIGNMENT_NARRATION_MISSING', 'The narration clip is missing; the alignment cannot be placed.', 422);
  const toComposition = (src: number) => audio.startSec + (src - audio.sourceInSec);
  // A shorter picture track must not truncate source-confirmed speech timing.
  // Whole-document validation checks the narration/visual extent afterwards.
  const clampTime = (t: number) => Math.max(0, t);

  for (const row of rows) {
    const caption = next.captions.find((c) => c.id === row.sceneId);
    if (!caption) throw new EditorError('ALIGNMENT_ROWS_INVALID', `no caption with id ${row.sceneId}.`, 422);
    if (caption.cueOf) {
      throw new EditorError('EDITOR_TRANSLATION_TIMING_LOCKED', `caption ${caption.id} is a translation; its timing follows its spoken cue. Align the spoken cue instead.`, 422);
    }
    const start = clampTime(toComposition(row.startSec));
    const end = clampTime(toComposition(row.endSec));
    if (!(end > start + TIME_EPSILON)) {
      throw new EditorError('ALIGNMENT_ROWS_INVALID', `caption ${row.sceneId} would end before it starts on the timeline.`, 422);
    }
    const moves = Math.abs(caption.startSec - start) > TIME_EPSILON || Math.abs(caption.endSec - end) > TIME_EPSILON;
    if (moves && caption.locked) {
      throw new EditorError('EDITOR_LOCKED_ITEM', `caption ${caption.id} is locked; the alignment would move it. Nothing was applied.`, 423);
    }
    caption.startSec = start;
    caption.endSec = end;
    // Linked translations share the spoken cue's timing exactly. Text is never touched.
    for (const translation of next.captions) {
      if (translation.cueOf !== caption.id) continue;
      if (translation.locked && moves) {
        throw new EditorError('EDITOR_LOCKED_ITEM', `translation ${translation.id} is locked; it follows its spoken cue, so the alignment would move it. Nothing was applied.`, 423);
      }
      translation.startSec = start;
      translation.endSec = end;
    }
  }

  next.alignment = {
    status: 'approved',
    audioSha256: meta.audioSha256,
    sourceRevision: meta.sourceRevision,
    proposalId: meta.proposalId,
    excerptSha256: meta.excerptSha256 ?? null,
    syncVerdict: meta.syncVerdict ?? null,
  };
  const errors = validateEditorDocument(next);
  if (errors.length > 0) throw new EditorError('EDITOR_INVALID_CHANGE', `alignment would produce an invalid document: ${errors[0]}`, 422);
  return next;
}
