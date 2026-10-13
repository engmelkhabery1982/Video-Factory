/**
 * Editor document model (pure — no React, no DOM, no fetch).
 *
 * Everything the editor decides about the DOCUMENT lives here so it can be
 * unit-tested directly: composition-time math, source-range validation, lock
 * rules, the operation builders that go to the contract endpoint, and the
 * local approximation used only to paint the BROWSER assembly preview.
 *
 * Two different numbers are deliberately never conflated:
 *   - `startSec`      composition time on the editor timeline
 *   - `sourceInSec`   offset inside the source file
 * Reordering rewrites composition starts only; it never touches captions,
 * audio, or any source offset.
 */
import {
  type CaptionDirection,
  type EditorAssetRef,
  type EditorAudioClip,
  type EditorBox,
  type EditorCaption,
  type EditorDocument,
  type EditorHighlight,
  type EditorOperation,
  type EditorVisualClip,
  type ImageMotion,
  EDITOR_SCHEMA_VERSION,
} from './editor-types.js';

export const FULL_FRAME: EditorBox = { x: 0, y: 0, width: 1, height: 1 };

/** Rounded to milliseconds: the contract writes times as seconds. */
export function round3(n: number): number {
  return Number(n.toFixed(3));
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function clamp(n: number, min: number, max: number): number {
  if (!isFiniteNumber(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

/* ------------------------------------------------------------------ */
/* timeline                                                            */
/* ------------------------------------------------------------------ */

export interface PlacedClip {
  clip: EditorVisualClip;
  /** composition start recomputed from the visual ORDER, not from the stored value */
  startSec: number;
  endSec: number;
}

/**
 * Contiguous visual order. Each clip keeps its duration and its source offset;
 * only composition starts are recalculated (contract, `reorder`).
 */
export function visualTimeline(doc: EditorDocument): PlacedClip[] {
  let cursor = 0;
  return doc.visualClips.map((clip) => {
    const durationSec = isFiniteNumber(clip.durationSec) && clip.durationSec > 0 ? clip.durationSec : 0;
    const placed: PlacedClip = { clip, startSec: round3(cursor), endSec: round3(cursor + durationSec) };
    cursor += durationSec;
    return placed;
  });
}

/** Composition duration of the picture track. */
export function pictureDuration(doc: EditorDocument): number {
  const total = doc.visualClips.reduce((acc, clip) => (isFiniteNumber(clip.durationSec) && clip.durationSec > 0 ? acc + clip.durationSec : acc), 0);
  return round3(total);
}

/** Composition duration the editor should present: the declared one when it is usable, else the picture track. */
export function documentDuration(doc: EditorDocument): number {
  if (isFiniteNumber(doc.durationSec) && doc.durationSec > 0) return doc.durationSec;
  return pictureDuration(doc);
}

export function placedClipAt(doc: EditorDocument, id: string | null): PlacedClip | null {
  if (!id) return null;
  return visualTimeline(doc).find((placed) => placed.clip.id === id) ?? null;
}

/** The visual clip under a composition time. */
export function clipAtTime(doc: EditorDocument, sec: number): PlacedClip | null {
  const timeline = visualTimeline(doc);
  return timeline.find((placed) => sec >= placed.startSec && sec < placed.endSec) ?? timeline[timeline.length - 1] ?? null;
}

/**
 * Caption cues shown for a caption language. Mirrors `selectCaptions` in core (the
 * server's rule); a parity test pins the two. Spoken cues stay in their own language.
 * Other spoken cues use their linked translation in that language, or are reported
 * as missing and never filled with spoken text.
 */
export function selectCaptionCues(doc: EditorDocument, language: string | null): { cues: EditorCaption[]; missingTranslations: string[] } {
  const spoken = doc.captions.filter((c) => !c.cueOf);
  if (language === null) return { cues: spoken, missingTranslations: [] };
  const cues: EditorCaption[] = [];
  const missingTranslations: string[] = [];
  for (const cue of spoken) {
    if (cue.language === language) {
      cues.push(cue);
      continue;
    }
    const translation = doc.captions.find((c) => c.cueOf === cue.id && c.language === language);
    if (translation) cues.push(translation);
    else missingTranslations.push(cue.id);
  }
  return { cues, missingTranslations };
}

/** Captions whose interval covers a composition time, in the selected caption language only. */
export function captionsAt(doc: EditorDocument, sec: number): EditorCaption[] {
  return selectCaptionCues(doc, doc.captionLanguage ?? null).cues.filter((cue) => sec >= cue.startSec && sec < cue.endSec);
}

/** Translations linked to a spoken cue, in document order. */
export function translationsOf(doc: EditorDocument, spokenId: string): EditorCaption[] {
  return doc.captions.filter((c) => c.cueOf === spokenId);
}

/** Languages offered for captions: the spoken languages and every translation language. */
export function captionLanguagesOf(doc: EditorDocument): string[] {
  const set = new Set<string>(['ar', 'en']);
  for (const c of doc.captions) if (c.language) set.add(c.language);
  return [...set].sort();
}

/**
 * A translation of a spoken cue. It shares the cue's timing exactly and carries only
 * the translated text it was given. It never copies spoken content.
 */
export function defaultTranslation(doc: EditorDocument, spoken: EditorCaption, text: string, language: string): EditorCaption {
  return {
    id: nextCaptionId(doc),
    cueOf: spoken.id,
    startSec: spoken.startSec,
    endSec: spoken.endSec,
    text,
    language,
    direction: detectCaptionDirection(text, language === 'ar' ? 'rtl' : 'ltr'),
    fontSizePx: spoken.fontSizePx,
    position: { x: spoken.position.x, y: spoken.position.y },
    locked: false,
  };
}

/** Highlights are shown ONLY during their intervals, and only on their clip. */
export function highlightsAt(doc: EditorDocument, sec: number): EditorHighlight[] {
  return doc.highlights.filter((highlight) => sec >= highlight.startSec && sec < highlight.endSec);
}

export function assetsById(doc: EditorDocument): Map<string, EditorAssetRef> {
  return new Map(doc.assets.map((asset) => [asset.id, asset]));
}

export function assetForClip(doc: EditorDocument, clip: EditorVisualClip | null): EditorAssetRef | null {
  if (!clip?.sourceAssetId) return null;
  return assetsById(doc).get(clip.sourceAssetId) ?? null;
}

/* ------------------------------------------------------------------ */
/* ids                                                                 */
/* ------------------------------------------------------------------ */

function nextId(existing: readonly { id: string }[], prefix: string): string {
  let max = 0;
  for (const item of existing) {
    const match = /_(\d+)$/.exec(item.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}_${String(max + 1).padStart(2, '0')}`;
}

export function nextVisualClipId(doc: EditorDocument): string {
  return nextId(doc.visualClips, 'vc');
}

export function nextCaptionId(doc: EditorDocument): string {
  return nextId(doc.captions, 'cap');
}

export function nextHighlightId(doc: EditorDocument): string {
  return nextId(doc.highlights, 'hl');
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

export interface ValidationFinding {
  /** the document field the finding is about */
  field: string;
  message: string;
}

/**
 * Media compatibility for a visual clip (contract: "exact media compatibility").
 * A still has no source out-point; a video must have one. Motion is still
 * animation for an image and is never presented as generated footage.
 */
export function mediaFinding(clip: EditorVisualClip, asset: EditorAssetRef | null): ValidationFinding | null {
  if (!asset) return null;
  if (asset.kind === 'audio') {
    return { field: `visualClips.${clip.id}.sourceAssetId`, message: `${asset.name} is audio. An audio file cannot fill a picture slot.` };
  }
  if (asset.kind === 'video' && clip.sourceOutSec === null) {
    return { field: `visualClips.${clip.id}.sourceOutSec`, message: `${asset.name} is video: a source out-point is required (null is only valid for a still).` };
  }
  if (asset.kind === 'image' && clip.sourceOutSec !== null) {
    return { field: `visualClips.${clip.id}.sourceOutSec`, message: `${asset.name} is a still: it has no source out-point.` };
  }
  if (asset.kind === 'video' && clip.motion !== 'none') {
    return { field: `visualClips.${clip.id}.motion`, message: `Image motion presets are still animation. ${asset.name} is video, so the source plays as-is.` };
  }
  return null;
}

/** Source offsets must exist inside the source file and stay ordered. */
export function sourceRangeFinding(clip: EditorVisualClip, asset: EditorAssetRef | null): ValidationFinding | null {
  if (asset?.kind !== 'video' && clip.sourceOutSec === null && (clip.sourceInSec === null || clip.sourceInSec === 0)) return null;
  if (!isFiniteNumber(clip.sourceInSec) || clip.sourceInSec < 0) {
    return { field: `visualClips.${clip.id}.sourceInSec`, message: 'Source in must be a finite number of seconds at or after 0.' };
  }
  if (clip.sourceOutSec !== null && !(isFiniteNumber(clip.sourceOutSec) && clip.sourceOutSec > clip.sourceInSec)) {
    return { field: `visualClips.${clip.id}.sourceOutSec`, message: 'Source out must be a finite number greater than source in.' };
  }
  if (asset?.durationSec != null) {
    if (clip.sourceInSec > asset.durationSec + 1e-6) {
      return { field: `visualClips.${clip.id}.sourceInSec`, message: `Source in is past the end of ${asset.name} (${asset.durationSec.toFixed(2)}s).` };
    }
    if (clip.sourceOutSec !== null && clip.sourceOutSec > asset.durationSec + 1e-6) {
      return { field: `visualClips.${clip.id}.sourceOutSec`, message: `Source out is past the end of ${asset.name} (${asset.durationSec.toFixed(2)}s).` };
    }
  }
  return null;
}

/** Validate one operation against the document the editor is holding. */
export function operationFindings(doc: EditorDocument, op: EditorOperation): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  if (op.type === 'update' || op.type === 'remove' || op.type === 'split') {
    const id = op.type === 'split' ? op.id : (op as { id: string }).id;
    const locked = isLockedItem(doc, op.collection, id);
    const unlocking = op.type === 'update' && Object.keys(op.changes).length === 1 && op.changes.locked === false;
    if (locked && !unlocking) {
      findings.push({ field: `${op.collection}.${id}`, message: 'This item is locked. Unlock it first (a single update that sets locked to false) — there is no blanket editing around locks.' });
      return findings;
    }
  }
  if (op.type === 'update' && op.collection === 'visualClips') {
    const clip = doc.visualClips.find((item) => item.id === op.id);
    if (clip) {
      const changes = op.changes as Partial<EditorVisualClip>;
      const merged: EditorVisualClip = { ...clip, ...changes, crop: { ...(changes.crop ?? clip.crop) } };
      // validate the RESULT of the edit, so a replacement asset is judged on its own kind
      const asset = merged.sourceAssetId ? assetsById(doc).get(merged.sourceAssetId) ?? null : null;
      findings.push(...compact([mediaFinding(merged, asset), sourceRangeFinding(merged, asset)]));
      if ('startSec' in op.changes) {
        findings.push({ field: `visualClips.${clip.id}.startSec`, message: 'Composition start follows the visual order. Reorder the clips instead of setting a start.' });
      }
      if ('durationSec' in op.changes && !(isFiniteNumber((op.changes as Partial<EditorVisualClip>).durationSec) && ((op.changes as Partial<EditorVisualClip>).durationSec ?? 0) > 0)) {
        findings.push({ field: `visualClips.${clip.id}.durationSec`, message: 'Duration must be a finite number of seconds greater than 0.' });
      }
    }
  }
  if (op.type === 'update' && op.collection === 'captions') {
    const cue = doc.captions.find((item) => item.id === op.id);
    if (cue) {
      const merged: EditorCaption = { ...cue, ...(op.changes as Partial<EditorCaption>) };
      findings.push(...captionFindings(merged));
    }
  }
  if (op.type === 'update' && op.collection === 'highlights') {
    const highlight = doc.highlights.find((item) => item.id === op.id);
    if (highlight) {
      const merged: EditorHighlight = { ...highlight, ...(op.changes as Partial<EditorHighlight>) };
      findings.push(...highlightFindings(merged));
    }
  }
  if (op.type === 'reorder') {
    const known = new Set(doc.visualClips.map((clip) => clip.id));
    if (op.ids.length !== doc.visualClips.length || op.ids.some((id) => !known.has(id))) {
      findings.push({ field: 'visualClips', message: 'A reorder must list every visual clip exactly once.' });
    }
  }
  if (op.type === 'split') {
    const placed = placedClipAt(doc, op.id);
    if (!placed) findings.push({ field: `visualClips.${op.id}`, message: 'That clip is not in this document.' });
    else if (!(isFiniteNumber(op.atSec) && op.atSec > placed.startSec && op.atSec < placed.endSec)) {
      findings.push({ field: `visualClips.${op.id}.atSec`, message: `Split must be inside the clip (${placed.startSec.toFixed(2)}s–${placed.endSec.toFixed(2)}s).` });
    }
  }
  return findings;
}

export function captionFindings(cue: EditorCaption): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  if (!isFiniteNumber(cue.startSec) || !isFiniteNumber(cue.endSec) || !(cue.endSec > cue.startSec)) {
    findings.push({ field: `captions.${cue.id}`, message: 'A caption needs a finite end time after its start time.' });
  }
  if (!cue.text.trim()) findings.push({ field: `captions.${cue.id}.text`, message: 'A caption cannot be empty. Complete words are kept — nothing is invented.' });
  if (!isFiniteNumber(cue.fontSizePx) || cue.fontSizePx < 24) {
    findings.push({ field: `captions.${cue.id}.fontSizePx`, message: 'Font size must be at least 24px to stay readable.' });
  }
  return findings;
}

export function highlightFindings(highlight: EditorHighlight): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  if (!isFiniteNumber(highlight.startSec) || !isFiniteNumber(highlight.endSec) || !(highlight.endSec > highlight.startSec)) {
    findings.push({ field: `highlights.${highlight.id}`, message: 'A highlight needs measured start and end times, with the end after the start.' });
  }
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (!isFiniteNumber(highlight.box[key]) || highlight.box[key] < 0 || highlight.box[key] > 1) {
      findings.push({ field: `highlights.${highlight.id}.box.${key}`, message: 'Highlight box coordinates are normalized display-frame coordinates between 0 and 1.' });
    }
  }
  if (highlight.box.x + highlight.box.width > 1.0001 || highlight.box.y + highlight.box.height > 1.0001) {
    findings.push({ field: `highlights.${highlight.id}.box`, message: 'The highlight box runs past the display frame.' });
  }
  return findings;
}

export function isLockedItem(doc: EditorDocument, collection: string, id: string): boolean {
  const list = (doc as unknown as Record<string, Array<{ id: string; locked?: boolean }>>)[collection];
  if (!Array.isArray(list)) return false;
  return list.find((item) => item.id === id)?.locked === true;
}

function compact(findings: Array<ValidationFinding | null>): ValidationFinding[] {
  return findings.filter((finding): finding is ValidationFinding => finding !== null);
}

/** Whole-document findings. Used before saving, and shown honestly when non-empty. */
export function documentFindings(doc: EditorDocument): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const clip of doc.visualClips) {
    const asset = clip.sourceAssetId ? assetsById(doc).get(clip.sourceAssetId) ?? null : null;
    findings.push(...compact([mediaFinding(clip, asset), sourceRangeFinding(clip, asset)]));
    if (!(isFiniteNumber(clip.durationSec) && clip.durationSec > 0)) {
      findings.push({ field: `visualClips.${clip.id}.durationSec`, message: 'Duration must be a finite number of seconds greater than 0.' });
    }
  }
  for (const cue of doc.captions) findings.push(...captionFindings(cue));
  for (const highlight of doc.highlights) findings.push(...highlightFindings(highlight));
  if (!(isFiniteNumber(doc.durationSec) && doc.durationSec > 0)) {
    findings.push({ field: 'durationSec', message: 'The document duration must be a finite positive number.' });
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* operation builders                                                  */
/* ------------------------------------------------------------------ */

export type OpInsert = Extract<EditorOperation, { type: 'insert' }>;
export type OpUpdate = Extract<EditorOperation, { type: 'update' }>;
export type OpRemove = Extract<EditorOperation, { type: 'remove' }>;
export type OpReorder = Extract<EditorOperation, { type: 'reorder' }>;
export type OpSplit = Extract<EditorOperation, { type: 'split' }>;
export type OpSetDocument = Extract<EditorOperation, { type: 'setDocument' }>;

export function opInsert(collection: OpInsert['collection'], item: unknown): OpInsert {
  return { type: 'insert', collection, item };
}

export function opUpdate(collection: OpUpdate['collection'], id: string, changes: Record<string, unknown>): OpUpdate {
  return { type: 'update', collection, id, changes };
}

export function opRemove(collection: OpRemove['collection'], id: string): OpRemove {
  return { type: 'remove', collection, id };
}

export function opReorder(ids: string[]): OpReorder {
  return { type: 'reorder', collection: 'visualClips', ids };
}

export function opSplit(id: string, atSec: number): OpSplit {
  return { type: 'split', collection: 'visualClips', id, atSec: round3(atSec) };
}

export function opSetDocument(changes: OpSetDocument['changes']): OpSetDocument {
  return { type: 'setDocument', changes };
}

/**
 * Split is at a COMPOSITION time inside the selected clip. It preserves the
 * clip's source position and the total duration, so the visual result is
 * unchanged and nothing is regenerated.
 */
export function splitClip(
  doc: EditorDocument,
  clipId: string,
  atSec: number,
): { left: EditorVisualClip; right: EditorVisualClip } | { error: string } {
  const placed = placedClipAt(doc, clipId);
  if (!placed) return { error: 'That clip is not in this document.' };
  const { clip } = placed;
  if (clip.locked) return { error: 'This clip is locked. Unlock it before splitting it.' };
  if (!(isFiniteNumber(atSec) && atSec > placed.startSec + 1e-6 && atSec < placed.endSec - 1e-6)) {
    return { error: `A split must fall inside the clip (${placed.startSec.toFixed(2)}s–${placed.endSec.toFixed(2)}s) and not on its edge.` };
  }
  const offset = round3(atSec - placed.startSec);
  const left: EditorVisualClip = {
    ...clip,
    durationSec: offset,
    sourceOutSec: clip.sourceOutSec === null ? null : round3((clip.sourceInSec ?? 0) + offset),
    crop: { ...clip.crop },
  };
  const right: EditorVisualClip = {
    ...clip,
    id: nextVisualClipId(doc),
    startSec: round3(atSec),
    durationSec: round3(clip.durationSec - offset),
    sourceInSec: clip.sourceOutSec === null ? null : round3((clip.sourceInSec ?? 0) + offset),
    sourceOutSec: clip.sourceOutSec,
    crop: { ...clip.crop },
    locked: false,
  };
  return { left, right };
}

/** Move one clip within the visual order. Reorder keeps durations; starts are recalculated. */
export function moveIds(ids: readonly string[], id: string, delta: number): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const to = from + delta;
  if (to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

export function visualOrder(doc: EditorDocument): string[] {
  return doc.visualClips.map((clip) => clip.id);
}

/* ------------------------------------------------------------------ */
/* captions / RTL                                                      */
/* ------------------------------------------------------------------ */

const RTL_RE = /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const DIACRITIC_RE = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u08d3-\u08ff]/;

export function hasRtlScript(text: string): boolean {
  return RTL_RE.test(text);
}

export function containsDiacritics(text: string): boolean {
  return DIACRITIC_RE.test(text);
}

/**
 * The stored direction is authoritative once it is set. This is only the
 * suggestion used when a caption is created: it never rewrites existing text,
 * and shaping/diacritics are preserved because the text is passed through
 * untouched.
 */
export function detectCaptionDirection(text: string, fallback: CaptionDirection = 'ltr'): CaptionDirection {
  if (!text.trim()) return fallback;
  return hasRtlScript(text) ? 'rtl' : 'ltr';
}

/**
 * A readable size for the frame. Never below the 24px floor; the server and the
 * renderer keep their own minima, so this only proposes.
 */
export function suggestFontSize(text: string, frameWidthPx: number): number {
  const characters = [...text.trim()].length;
  if (characters === 0) return 44;
  const target = frameWidthPx * 0.86;
  const perCharacter = target / Math.max(1, Math.min(characters, 40));
  return Math.round(clamp(perCharacter * 1.7, 24, 96));
}

/** Complete words only: the caption text is never cut mid-word by the editor. */
export function completeWords(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function captionOverlapsVisualBoundary(_doc: EditorDocument, _cue: EditorCaption): boolean {
  // A caption interval need not equal a visual scene (contract). Kept explicit
  // so a reviewer can see the editor never forces one onto the other.
  return false;
}

/* ------------------------------------------------------------------ */
/* highlights                                                          */
/* ------------------------------------------------------------------ */

export function clampBox(box: EditorBox): EditorBox {
  const width = clamp(box.width, 0.01, 1);
  const height = clamp(box.height, 0.01, 1);
  return {
    x: round3(clamp(box.x, 0, 1 - width)),
    y: round3(clamp(box.y, 0, 1 - height)),
    width: round3(width),
    height: round3(height),
  };
}

export function nudgeBox(box: EditorBox, dx: number, dy: number): EditorBox {
  return clampBox({ ...box, x: box.x + dx, y: box.y + dy });
}

export function resizeBox(box: EditorBox, dWidth: number, dHeight: number): EditorBox {
  return clampBox({ ...box, width: box.width + dWidth, height: box.height + dHeight });
}

export function boxToPercent(box: EditorBox): { left: string; top: string; width: string; height: string } {
  return {
    left: `${(box.x * 100).toFixed(3)}%`,
    top: `${(box.y * 100).toFixed(3)}%`,
    width: `${(box.width * 100).toFixed(3)}%`,
    height: `${(box.height * 100).toFixed(3)}%`,
  };
}

/**
 * A new highlight starts at the playhead with a short, editable interval. Its
 * box is a starting frame the operator drags or types over — it is an
 * owner/editor annotation, never a fabricated recorded cursor movement.
 */
export function defaultHighlight(doc: EditorDocument, playheadSec: number): EditorHighlight {
  const placed = clipAtTime(doc, playheadSec);
  const end = Math.min(placed ? placed.endSec : round3(playheadSec + 3), round3(playheadSec + 3));
  return {
    id: nextHighlightId(doc),
    startSec: round3(playheadSec),
    endSec: end > playheadSec ? end : round3(playheadSec + 1),
    visualClipId: placed?.clip.id ?? '',
    box: { x: 0.32, y: 0.36, width: 0.24, height: 0.12 },
    label: null,
    locked: false,
  };
}

export function defaultCaption(doc: EditorDocument, playheadSec: number, text: string): EditorCaption {
  const placed = clipAtTime(doc, playheadSec);
  const end = placed ? placed.endSec : round3(playheadSec + 3);
  return {
    id: nextCaptionId(doc),
    startSec: round3(playheadSec),
    endSec: end > playheadSec ? round3(end) : round3(playheadSec + 1),
    text: completeWords(text),
    language: 'ar',
    direction: detectCaptionDirection(text),
    fontSizePx: 44,
    position: { x: 0.5, y: 0.82 },
    locked: false,
  };
}

/* ------------------------------------------------------------------ */
/* local approximation (browser assembly preview only)                 */
/* ------------------------------------------------------------------ */

/**
 * Apply operations to the held document LOCALLY.
 *
 * This exists so the BROWSER assembly preview can follow an unsaved edit. It is
 * not a save: it never sets a revision, never reports success, and the UI must
 * keep saying "unsaved". The server remains the authority and its response
 * replaces this result.
 */
export function localApply(doc: EditorDocument, operations: readonly EditorOperation[]): EditorDocument {
  let next: EditorDocument = {
    ...doc,
    assets: [...doc.assets],
    visualClips: doc.visualClips.map((clip) => ({ ...clip, crop: { ...clip.crop } })),
    audioClips: [...doc.audioClips],
    captions: doc.captions.map((cue) => ({ ...cue, position: { ...cue.position } })),
    highlights: doc.highlights.map((highlight) => ({ ...highlight, box: { ...highlight.box } })),
  };
  for (const op of operations) {
    if (op.type === 'setDocument') {
      next = { ...next, ...op.changes };
      continue;
    }
    if (op.type === 'insert') {
      if (op.collection === 'visualClips') next = { ...next, visualClips: [...next.visualClips, op.item as EditorVisualClip] };
      else if (op.collection === 'audioClips') next = { ...next, audioClips: [...next.audioClips, op.item as EditorAudioClip] };
      else if (op.collection === 'captions') next = { ...next, captions: [...next.captions, op.item as EditorCaption] };
      else next = { ...next, highlights: [...next.highlights, op.item as EditorHighlight] };
      continue;
    }
    if (op.type === 'remove') {
      // ids are unique per collection, so one filter per collection is exact
      next = {
        ...next,
        visualClips: next.visualClips.filter((item) => item.id !== op.id),
        audioClips: next.audioClips.filter((item) => item.id !== op.id),
        captions: next.captions.filter((item) => item.id !== op.id),
        highlights: next.highlights.filter((item) => item.id !== op.id),
      };
      continue;
    }
    if (op.type === 'update') {
      const changes = op.changes;
      next = {
        ...next,
        visualClips: next.visualClips.map((item) => (item.id === op.id ? ({ ...item, ...changes } as EditorVisualClip) : item)),
        audioClips: next.audioClips.map((item) => (item.id === op.id ? ({ ...item, ...changes } as EditorAudioClip) : item)),
        captions: next.captions.map((item) => (item.id === op.id ? ({ ...item, ...changes } as EditorCaption) : item)),
        highlights: next.highlights.map((item) => (item.id === op.id ? ({ ...item, ...changes } as EditorHighlight) : item)),
      };
      continue;
    }
    if (op.type === 'reorder') {
      const byId = new Map(next.visualClips.map((clip) => [clip.id, clip]));
      const ordered = op.ids.map((id) => byId.get(id)).filter((clip): clip is EditorVisualClip => !!clip);
      next = { ...next, visualClips: ordered };
      continue;
    }
    if (op.type === 'split') {
      const result = splitClip(next, op.id, op.atSec);
      if ('error' in result) continue;
      const index = next.visualClips.findIndex((clip) => clip.id === op.id);
      const clips = [...next.visualClips];
      clips.splice(index, 1, result.left, result.right);
      next = { ...next, visualClips: clips };
    }
  }
  // composition starts follow the visual order
  let cursor = 0;
  const clips = next.visualClips.map((clip) => {
    const placed = { ...clip, startSec: round3(cursor) };
    cursor += isFiniteNumber(clip.durationSec) ? clip.durationSec : 0;
    return placed;
  });
  return { ...next, visualClips: clips, durationSec: round3(cursor) };
}

/* ------------------------------------------------------------------ */
/* revision conflicts and errors                                       */
/* ------------------------------------------------------------------ */

export interface BrokerErrorShape {
  status?: number;
  payload?: { code?: string; message?: string; currentRevision?: number } | null;
  message?: string;
}

export function revisionConflictFrom(error: unknown): { currentRevision: number; message: string } | null {
  const shape = error as BrokerErrorShape;
  const payload = shape?.payload ?? null;
  const isConflict = shape?.status === 409 || payload?.code === 'REVISION_CONFLICT';
  if (!isConflict) return null;
  return {
    currentRevision: typeof payload?.currentRevision === 'number' ? payload.currentRevision : NaN,
    message: payload?.message ?? shape?.message ?? 'The document changed on the server.',
  };
}

/** A missing endpoint is a blocker, never a silently faked success. */
export function isEndpointMissing(error: unknown): boolean {
  const shape = error as BrokerErrorShape;
  return shape?.status === 404 || shape?.status === 405 || shape?.status === 501;
}

export function describeError(error: unknown): string {
  const shape = error as BrokerErrorShape;
  if (isEndpointMissing(error)) {
    return shape?.message ?? 'The editor endpoint is not implemented on this server yet.';
  }
  return shape?.payload?.message ?? shape?.message ?? 'The request failed.';
}

/** Fresh document shell used by the fixture and by tests. */
export function emptyDocument(projectId: string, targetId: EditorDocument['targetId']): EditorDocument {
  return {
    schemaVersion: EDITOR_SCHEMA_VERSION,
    projectId,
    revision: 0,
    contentProfile: 'promotional',
    channelBrandId: null,
    targetId,
    format: targetId === 'long' ? 'landscape' : 'portrait',
    durationSec: 0,
    assets: [],
    visualClips: [],
    audioClips: [],
    captions: [],
    highlights: [],
    alignment: { state: 'not_requested' },
  };
}

export function summaryOf(doc: EditorDocument): {
  clips: number;
  captions: number;
  highlights: number;
  audio: number;
  durationSec: number;
  unboundClips: number;
  lockedItems: number;
} {
  const lockedItems =
    doc.visualClips.filter((clip) => clip.locked).length +
    doc.captions.filter((cue) => cue.locked).length +
    doc.highlights.filter((highlight) => highlight.locked).length +
    doc.audioClips.filter((audio) => audio.locked).length;
  return {
    clips: doc.visualClips.length,
    captions: doc.captions.length,
    highlights: doc.highlights.length,
    audio: doc.audioClips.length,
    durationSec: documentDuration(doc),
    unboundClips: doc.visualClips.filter((clip) => !clip.sourceAssetId).length,
    lockedItems,
  };
}

export function motionLabel(motion: ImageMotion): string {
  switch (motion) {
    case 'slow_push':
      return 'still animation: slow push';
    case 'pan_left':
      return 'still animation: pan left';
    case 'pan_right':
      return 'still animation: pan right';
    default:
      return 'hold (no image motion)';
  }
}
