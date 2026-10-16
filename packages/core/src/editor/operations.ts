/**
 * Edit operations for the editor document. Pure: every call returns a NEW
 * document or throws EditorError. Nothing is written here; persistence and
 * revision checks live in the API layer.
 *
 * Rules enforced here (EDITOR_CONTRACT_V1):
 *  - visual clips form one contiguous timeline from 0; only visual starts are
 *    recalculated, never captions, audio or approvals;
 *  - a locked item rejects every mutation except an update whose only change
 *    is `locked:false`;
 *  - trim changes the source range and the composition duration together;
 *  - split keeps the source position continuous and the total duration;
 *  - an audio trim/replacement invalidates that clip's approval and alignment;
 *  - a visual edit never rewrites caption text or retimes narration.
 */
import { isVisualLanguageId, isVisualTechniqueId } from '../visual-language.js';
import { validateGraphic } from './graphics.js';
import {
  EditorError,
  TIME_EPSILON,
  assertValidEditorDocument,
  CAPTION_LANGUAGE_RE,
  type EditorAudioClip,
  type EditorCaption,
  type EditorCollection,
  type EditorDocument,
  type EditorHighlight,
  type EditorOperation,
  type EditorVisualClip,
  EDITOR_FORMATS,
  EDITOR_CONTENT_PROFILES,
} from './document.js';

export const MAX_OPERATIONS_PER_TRANSACTION = 100;

const UPDATABLE: Record<EditorCollection, readonly string[]> = {
  visualClips: ['sourceAssetId', 'durationSec', 'sourceInSec', 'sourceOutSec', 'crop', 'motion', 'transition', 'locked', 'technique', 'graphic'],
  audioClips: ['sourceAssetId', 'speakerId', 'startSec', 'sourceInSec', 'sourceOutSec', 'gainDb', 'locked', 'approved'],
  captions: ['startSec', 'endSec', 'text', 'language', 'direction', 'fontSizePx', 'position', 'locked'],
  highlights: ['startSec', 'endSec', 'visualClipId', 'box', 'label', 'locked'],
};
const INSERTABLE: Record<EditorCollection, readonly string[]> = {
  visualClips: ['id', ...UPDATABLE.visualClips],
  audioClips: ['id', ...UPDATABLE.audioClips],
  // cueOf is fixed at creation. A link cannot be re-pointed by an update.
  captions: ['id', ...UPDATABLE.captions, 'cueOf'],
  highlights: ['id', ...UPDATABLE.highlights],
};
const COLLECTIONS: readonly EditorCollection[] = ['visualClips', 'audioClips', 'captions', 'highlights'];
/** Changing these on an audio clip means the narration itself changed. */
const AUDIO_DEPENDENCY_FIELDS = ['sourceAssetId', 'startSec', 'sourceInSec', 'sourceOutSec'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function collectionOf(doc: EditorDocument, collection: EditorCollection): Array<{ id: string; locked?: boolean }> {
  return doc[collection] as unknown as Array<{ id: string; locked?: boolean }>;
}

function findIndex(doc: EditorDocument, collection: EditorCollection, id: string): number {
  const idx = collectionOf(doc, collection).findIndex((item) => item.id === id);
  if (idx < 0) throw new EditorError('EDITOR_ITEM_NOT_FOUND', `${collection} item ${id} does not exist.`, 404);
  return idx;
}

function assertKnownCollection(collection: unknown): asserts collection is EditorCollection {
  if (typeof collection !== 'string' || !(COLLECTIONS as readonly string[]).includes(collection)) {
    throw new EditorError('EDITOR_UNKNOWN_COLLECTION', `Unknown collection ${String(collection)}.`, 422);
  }
}

function assertAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[], what: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new EditorError('EDITOR_INVALID_CHANGE', `${what} may not set "${key}".`, 422);
    }
  }
}

function lockedError(collection: string, id: string): EditorError {
  return new EditorError('EDITOR_LOCKED_ITEM', `${collection} item ${id} is locked. Unlock it with an update that sets only locked:false.`, 423);
}

/** Visual starts are contiguous from 0. Recalculated after any visual change. */
function recalcVisualStarts(doc: EditorDocument) {
  let cursor = 0;
  for (const clip of doc.visualClips) {
    clip.startSec = cursor;
    cursor += clip.durationSec;
  }
  if (doc.visualClips.length > 0) doc.durationSec = cursor;
}

/**
 * Video trim. The source range and the composition duration are one value at
 * speed 1: durationSec == sourceOutSec - sourceInSec. Setting durationSec alone
 * trims the end; setting sourceInSec/sourceOutSec moves the in/out points.
 */
function applyVideoTrim(clip: EditorVisualClip, changes: Record<string, unknown>) {
  const hasIn = changes.sourceInSec !== undefined;
  const hasOut = changes.sourceOutSec !== undefined;
  const hasDur = changes.durationSec !== undefined;
  let inSec = hasIn ? (changes.sourceInSec as number) : clip.sourceInSec;
  let outSec = hasOut ? (changes.sourceOutSec as number) : clip.sourceOutSec;
  if (hasDur) {
    const dur = changes.durationSec as number;
    if (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0) {
      throw new EditorError('EDITOR_INVALID_CHANGE', 'durationSec must be a positive number.', 422);
    }
    if (hasIn && hasOut) {
      if (Math.abs(dur - ((outSec as number) - (inSec as number))) > TIME_EPSILON) {
        throw new EditorError('EDITOR_TRIM_MISMATCH', 'For video, durationSec must equal sourceOutSec minus sourceInSec.', 422);
      }
    } else if (hasOut) {
      inSec = (outSec as number) - dur;
    } else {
      outSec = (inSec as number) + dur;
    }
  }
  if (typeof inSec !== 'number' || typeof outSec !== 'number' || !Number.isFinite(inSec) || !Number.isFinite(outSec)) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'A video clip needs a numeric source range.', 422);
  }
  if (inSec < 0 || outSec <= inSec) {
    throw new EditorError('EDITOR_TRIM_MISMATCH', 'sourceInSec must be >= 0 and sourceOutSec must be after it.', 422);
  }
  clip.sourceInSec = inSec;
  clip.sourceOutSec = outSec;
  clip.durationSec = outSec - inSec;
}

function applyUpdate(doc: EditorDocument, collection: EditorCollection, id: string, changes: Record<string, unknown>) {
  assertAllowedKeys(changes, UPDATABLE[collection], `${collection} update`);
  const idx = findIndex(doc, collection, id);
  const item = collectionOf(doc, collection)[idx] as unknown as Record<string, unknown> & { id: string; locked?: boolean };
  const onlyUnlock = Object.keys(changes).length === 1 && 'locked' in changes && changes.locked === false;
  if (item.locked === true && !onlyUnlock) throw lockedError(collection, id);

  if (collection === 'visualClips') {
    if ('startSec' in changes) throw new EditorError('EDITOR_INVALID_CHANGE', 'startSec is derived from order. Use reorder or split.', 422);
    const clip = item as unknown as EditorVisualClip;
    const { durationSec, sourceInSec, sourceOutSec, ...plain } = changes;
    // Dissolve needs two scenes composited at once, which the renderer does not do yet.
    // It is refused, not rendered as a cut. See amendment A1 (docs/execution/milestone-1/AMENDMENT_A1_DISSOLVE.md).
    if (plain.transition === 'dissolve') {
      throw new EditorError('EDITOR_CAPABILITY_UNAVAILABLE', 'transition dissolve is not available. Amendment A1 is pending review. cut and fade are rendered.', 422);
    }
    if ('technique' in plain && plain.technique !== null && !isVisualTechniqueId(plain.technique)) {
      throw new EditorError('EDITOR_INVALID_CHANGE', `technique ${String(plain.technique)} is not in the visual-language registry.`, 422);
    }
    // Validate the MERGED clip exactly once, as it will be after this change: the graphic that will be stored
    // (the replacement when one is supplied, otherwise the current one) against the duration that will be stored.
    // A replacement or removal in the same change is judged on its own, never against the old graphic.
    const nextDuration = typeof durationSec === 'number' ? durationSec : clip.durationSec;
    const nextGraphic = 'graphic' in plain ? plain.graphic : clip.graphic;
    if (nextGraphic !== null && nextGraphic !== undefined) {
      const problems = validateGraphic(nextGraphic, { durationSec: nextDuration, format: doc.format, contentProfile: doc.contentProfile });
      if (problems.length > 0) {
        throw new EditorError('EDITOR_INVALID_CHANGE', `${clip.id} graphic is refused at ${nextDuration}s: ${problems.join(' ')}`, 422);
      }
    }
    Object.assign(clip, plain);
    const asset = clip.sourceAssetId ? doc.assets.find((a) => a.id === clip.sourceAssetId) : undefined;
    if (clip.sourceAssetId !== null && !asset) {
      throw new EditorError('EDITOR_INVALID_CHANGE', `asset ${clip.sourceAssetId} is not in this document.`, 422);
    }
    if (asset?.kind === 'video') {
      applyVideoTrim(clip, { sourceInSec, sourceOutSec, durationSec });
    } else {
      // stills and placeholders: no source range; duration is free
      if ((sourceInSec !== undefined && sourceInSec !== null) || (sourceOutSec !== undefined && sourceOutSec !== null)) {
        throw new EditorError('EDITOR_INVALID_CHANGE', 'Only video clips have a source range.', 422);
      }
      clip.sourceInSec = null;
      clip.sourceOutSec = null;
      if (durationSec !== undefined) {
        if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
          throw new EditorError('EDITOR_INVALID_CHANGE', 'durationSec must be a positive number.', 422);
        }
        clip.durationSec = durationSec;
      }
    }
    return;
  }
  if (collection === 'audioClips') {
    const clip = item as unknown as EditorAudioClip;
    Object.assign(clip, changes);
    if (AUDIO_DEPENDENCY_FIELDS.some((k) => k in changes)) {
      // The narration source or its range changed: the old approval and the synchronization evidence no longer cover it.
      clip.approved = false;
      doc.alignment = { status: 'not_requested', audioSha256: null, sourceRevision: null, proposalId: null, excerptSha256: null, syncVerdict: null };
    }
    return;
  }
  if (collection === 'captions') {
    const cap = item as unknown as EditorCaption;
    const retimes = 'startSec' in changes || 'endSec' in changes;
    if (retimes && cap.cueOf) {
      throw new EditorError('EDITOR_TRANSLATION_TIMING_LOCKED', `caption ${id} is a translation; its timing follows its spoken cue. Edit the spoken cue instead.`, 422);
    }
    Object.assign(item, changes);
    if (retimes) {
      // A spoken cue's timing is shared with its translations. Text edits never reach them.
      for (const translation of doc.captions) {
        if (translation.cueOf !== id) continue;
        if (translation.locked) throw lockedError('captions', translation.id);
        translation.startSec = cap.startSec;
        translation.endSec = cap.endSec;
      }
    }
    return;
  }
  Object.assign(item, changes);
}

function applyInsert(doc: EditorDocument, collection: EditorCollection, rawItem: Record<string, unknown>) {
  if (!isObject(rawItem)) throw new EditorError('EDITOR_INVALID_CHANGE', 'insert item must be an object.', 422);
  assertAllowedKeys(rawItem, INSERTABLE[collection], `${collection} insert`);
  if (typeof rawItem.id !== 'string' || rawItem.id.length === 0) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'insert item needs a non-empty string id.', 422);
  }
  if (collectionOf(doc, collection).some((item) => item.id === rawItem.id)) {
    throw new EditorError('EDITOR_DUPLICATE_ID', `${collection} item ${rawItem.id} already exists.`, 409);
  }
  const item = clone(rawItem);
  if (collection === 'captions' && item.cueOf !== undefined && item.cueOf !== null) {
    const spoken = doc.captions.find((c) => c.id === item.cueOf);
    if (typeof item.cueOf !== 'string' || !spoken) {
      throw new EditorError('EDITOR_INVALID_CHANGE', `translation ${rawItem.id} needs an existing spoken cue to link to.`, 422);
    }
    if (spoken.cueOf) throw new EditorError('EDITOR_INVALID_CHANGE', 'a translation cannot link to another translation.', 422);
    // A translation takes the spoken cue's timing. Supplied timing must agree with it; missing timing is copied.
    for (const key of ['startSec', 'endSec'] as const) {
      if (item[key] === undefined) item[key] = spoken[key];
      else if (Math.abs((item[key] as number) - spoken[key]) > TIME_EPSILON) {
        throw new EditorError('EDITOR_TRANSLATION_TIMING_LOCKED', `translation ${rawItem.id} must share the timing of spoken cue ${spoken.id}.`, 422);
      }
    }
  }
  if (collection === 'visualClips') {
    (item as unknown as EditorVisualClip).startSec = 0;
    doc.visualClips.push(item as unknown as EditorVisualClip);
    recalcVisualStarts(doc);
    return;
  }
  (doc[collection] as unknown[]).push(item);
}

function applyRemove(doc: EditorDocument, collection: EditorCollection, id: string) {
  const idx = findIndex(doc, collection, id);
  const item = collectionOf(doc, collection)[idx];
  if (item.locked) throw lockedError(collection, id);
  if (collection === 'captions') {
    const linked = doc.captions.filter((c) => c.cueOf === id);
    if (linked.length > 0) {
      throw new EditorError('EDITOR_CUE_HAS_TRANSLATIONS', `spoken cue ${id} has translation ${linked[0].id}. Remove the translation first.`, 409);
    }
  }
  if (collection === 'visualClips') {
    if (doc.visualClips.length === 1) {
      throw new EditorError('EDITOR_EMPTY_TIMELINE', 'The last visual clip cannot be removed.', 409);
    }
    const referenced = doc.highlights.filter((h) => h.visualClipId === id);
    if (referenced.length > 0) {
      throw new EditorError('EDITOR_HIGHLIGHT_REFERENCED', `Highlight ${referenced[0].id} uses this clip. Remove or move it first.`, 409);
    }
    doc.visualClips.splice(idx, 1);
    recalcVisualStarts(doc);
    return;
  }
  (doc[collection] as unknown[]).splice(idx, 1);
}

function applyReorder(doc: EditorDocument, ids: unknown) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'reorder ids must be an array of strings.', 422);
  }
  const current = doc.visualClips.map((c) => c.id);
  if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => !current.includes(id as string))) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'reorder ids must be a permutation of the visual clips.', 422);
  }
  for (const clip of doc.visualClips) {
    if (clip.locked && ids.indexOf(clip.id) !== current.indexOf(clip.id)) throw lockedError('visualClips', clip.id);
  }
  const byId = new Map(doc.visualClips.map((c) => [c.id, c]));
  doc.visualClips = (ids as string[]).map((id) => byId.get(id)!);
  recalcVisualStarts(doc);
}

function applySplit(doc: EditorDocument, id: string, atSec: unknown) {
  if (typeof atSec !== 'number' || !Number.isFinite(atSec)) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'split atSec must be a finite number.', 422);
  }
  const idx = findIndex(doc, 'visualClips', id);
  const clip = doc.visualClips[idx];
  if (clip.locked) throw lockedError('visualClips', id);
  if (clip.graphic) {
    // Its timed actions belong to one clock. Splitting would need every action re-timed, which is not done silently.
    throw new EditorError('EDITOR_INVALID_CHANGE', `${id} is a procedural graphic. Its timed actions cannot be split yet; shorten or replace it instead.`, 422);
  }
  const start = clip.startSec;
  const end = clip.startSec + clip.durationSec;
  if (!(atSec > start + TIME_EPSILON && atSec < end - TIME_EPSILON)) {
    throw new EditorError('EDITOR_SPLIT_OUT_OF_RANGE', `split must fall strictly inside ${id} (${start.toFixed(3)}–${end.toFixed(3)}s).`, 422);
  }
  const relative = atSec - start;
  let n = 2;
  let newId = `${id}_s${n}`;
  while (doc.visualClips.some((c) => c.id === newId)) newId = `${id}_s${++n}`;

  const isVideo = clip.sourceInSec !== null && clip.sourceOutSec !== null;
  const second: EditorVisualClip = {
    ...clone(clip),
    id: newId,
    startSec: atSec,
    durationSec: end - atSec,
    sourceInSec: isVideo ? (clip.sourceInSec as number) + relative : null,
    sourceOutSec: isVideo ? clip.sourceOutSec : null,
    locked: false,
  };
  const firstOut = isVideo ? (clip.sourceInSec as number) + relative : null;
  clip.durationSec = relative;
  clip.sourceOutSec = firstOut;

  // Timed highlights follow the half that contains them. A highlight that
  // straddles the cut is refused rather than split silently.
  for (const h of doc.highlights.filter((x) => x.visualClipId === id)) {
    if (h.endSec <= atSec + TIME_EPSILON) continue;
    if (h.startSec >= atSec - TIME_EPSILON) { h.visualClipId = newId; continue; }
    throw new EditorError('EDITOR_HIGHLIGHT_SPANS_SPLIT', `Highlight ${h.id} spans the cut. Adjust its interval first.`, 422);
  }
  doc.visualClips.splice(idx + 1, 0, second);
  recalcVisualStarts(doc);
}

function applySetDocument(doc: EditorDocument, changes: unknown) {
  if (!isObject(changes)) throw new EditorError('EDITOR_INVALID_CHANGE', 'setDocument changes must be an object.', 422);
  assertAllowedKeys(changes, ['contentProfile', 'channelBrandId', 'format', 'captionLanguage', 'visualLanguage'], 'setDocument');
  if ('visualLanguage' in changes && changes.visualLanguage !== null && !isVisualLanguageId(changes.visualLanguage)) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'visualLanguage must be a registered visual language or null.', 422);
  }
  if ('captionLanguage' in changes && changes.captionLanguage !== null && (typeof changes.captionLanguage !== 'string' || !CAPTION_LANGUAGE_RE.test(changes.captionLanguage))) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'captionLanguage must be a language code such as en or ar-EG, or null.', 422);
  }
  if ('contentProfile' in changes && !(EDITOR_CONTENT_PROFILES as readonly unknown[]).includes(changes.contentProfile)) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'contentProfile must be religious, educational or promotional.', 422);
  }
  if ('format' in changes && !(EDITOR_FORMATS as readonly unknown[]).includes(changes.format)) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'format must be landscape or portrait.', 422);
  }
  if ('channelBrandId' in changes && changes.channelBrandId !== null && typeof changes.channelBrandId !== 'string') {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'channelBrandId must be a string or null.', 422);
  }
  Object.assign(doc, changes);
}

/**
 * Apply an ordered list of operations to a copy of `doc`. The result keeps
 * `doc.revision`; the caller advances it when it persists the transaction.
 * Throws EditorError on the first refused operation; the input is untouched.
 */
export function applyEditorOperations(doc: EditorDocument, operations: unknown): EditorDocument {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new EditorError('EDITOR_INVALID_CHANGE', 'operations must be a non-empty array.', 422);
  }
  if (operations.length > MAX_OPERATIONS_PER_TRANSACTION) {
    throw new EditorError('EDITOR_INVALID_CHANGE', `at most ${MAX_OPERATIONS_PER_TRANSACTION} operations per transaction.`, 422);
  }
  const next = clone(doc);
  for (const raw of operations as EditorOperation[]) {
    if (!isObject(raw)) throw new EditorError('EDITOR_INVALID_CHANGE', 'each operation must be an object.', 422);
    switch (raw.type) {
      case 'insert':
        assertKnownCollection(raw.collection);
        applyInsert(next, raw.collection, raw.item as Record<string, unknown>);
        break;
      case 'update':
        assertKnownCollection(raw.collection);
        if (typeof raw.id !== 'string' || !isObject(raw.changes)) {
          throw new EditorError('EDITOR_INVALID_CHANGE', 'update needs an id and changes.', 422);
        }
        applyUpdate(next, raw.collection, raw.id, raw.changes);
        break;
      case 'remove':
        assertKnownCollection(raw.collection);
        if (typeof raw.id !== 'string') throw new EditorError('EDITOR_INVALID_CHANGE', 'remove needs an id.', 422);
        applyRemove(next, raw.collection, raw.id);
        break;
      case 'reorder':
        if (raw.collection !== 'visualClips') throw new EditorError('EDITOR_INVALID_CHANGE', 'reorder applies to visualClips only.', 422);
        applyReorder(next, raw.ids);
        break;
      case 'split':
        if (raw.collection !== 'visualClips') throw new EditorError('EDITOR_INVALID_CHANGE', 'split applies to visualClips only.', 422);
        applySplit(next, raw.id, raw.atSec);
        break;
      case 'setDocument':
        applySetDocument(next, raw.changes);
        break;
      default:
        throw new EditorError('EDITOR_INVALID_CHANGE', `unknown operation ${String((raw as { type?: unknown }).type)}.`, 422);
    }
    // Visual starts follow durations after every step, so later operations
    // in the same transaction see a consistent timeline. Captions and audio are untouched.
    if (next.visualClips.length > 0) recalcVisualStarts(next);
  }
  assertValidEditorDocument(next);
  return next;
}

/** Helpers exported for tests and the API layer. */
export function visualClipAt(doc: EditorDocument, compositionSec: number): EditorVisualClip | null {
  return doc.visualClips.find((c) => compositionSec >= c.startSec - TIME_EPSILON && compositionSec < c.startSec + c.durationSec - TIME_EPSILON) ?? null;
}

/** Source time inside the clip for a composition time (null for stills). */
export function sourceTimeAt(clip: EditorVisualClip, compositionSec: number): number | null {
  if (clip.sourceInSec === null) return null;
  return clip.sourceInSec + (compositionSec - clip.startSec);
}

export type { EditorCaption, EditorHighlight };
