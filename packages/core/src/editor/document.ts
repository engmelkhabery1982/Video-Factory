/**
 * Versioned editor document (EDITOR_CONTRACT_V1, milestone 1 backend).
 *
 * The persisted document is the single authority for the editor, preview and
 * render. It is a sidecar: the original project.json and its approvals are
 * never written by this module. Pure functions only; persistence lives in the
 * API service layer.
 */
import type { CaptionCue, Project, Scene, SceneContent, ProjectInput } from '../types.js';
import { isGraphicTechniqueId, isVisualLanguageId, isVisualTechniqueId, languageAllowsTechnique, type VisualLanguageId, type VisualTechniqueId } from '../visual-language.js';
import { validateGraphic, type EditorGraphic } from './graphics.js';

export const EDITOR_SCHEMA_VERSION = 1 as const;
export const EDITOR_TARGET_IDS = ['long', 'short_1', 'short_2', 'short_3'] as const;
export type EditorTargetId = (typeof EDITOR_TARGET_IDS)[number];
export const EDITOR_CONTENT_PROFILES = ['religious', 'educational', 'promotional'] as const;
export type EditorContentProfile = (typeof EDITOR_CONTENT_PROFILES)[number];
export const EDITOR_FORMATS = ['landscape', 'portrait'] as const;
export type EditorFormat = (typeof EDITOR_FORMATS)[number];
export const EDITOR_MOTIONS = ['none', 'slow_push', 'pan_left', 'pan_right'] as const;
export type EditorMotion = (typeof EDITOR_MOTIONS)[number];
export const EDITOR_TRANSITIONS = ['cut', 'dissolve', 'fade'] as const;
export type EditorTransition = (typeof EDITOR_TRANSITIONS)[number];
export const EDITOR_ASSET_KINDS = ['image', 'video', 'audio'] as const;
export type EditorAssetKind = (typeof EDITOR_ASSET_KINDS)[number];
export const EDITOR_ALIGNMENT_STATES = ['unavailable', 'not_requested', 'running', 'proposed', 'approved'] as const;
export type EditorAlignmentState = (typeof EDITOR_ALIGNMENT_STATES)[number];

/** Tolerance for floating-point seconds. Times are never rounded to hide a mismatch. */
export const TIME_EPSILON = 0.001;

export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_FRAME: NormalizedBox = { x: 0, y: 0, width: 1, height: 1 };

export interface EditorAsset {
  id: string;
  kind: EditorAssetKind;
  name: string;
  mediaUrl: string;
  durationSec: number | null;
  source: string;
  license: string;
  sha256: string | null;
  /**
   * Narration only: the project's listening approval as last SEEN from the
   * project record. The editor's own clip approval is reset only when this
   * project-side value changes, so a trim that cleared approval stays cleared.
   */
  approvedSeen?: boolean;
}

export interface EditorVisualClip {
  id: string;
  sourceAssetId: string | null;
  /** Composition time (seconds) where this clip starts. Derived from order, never edited directly. */
  startSec: number;
  durationSec: number;
  /** Source time (seconds) of the first frame shown. Null for stills and placeholders. */
  sourceInSec: number | null;
  /** Source time (seconds) after the last frame shown. Null for stills and placeholders. */
  sourceOutSec: number | null;
  crop: NormalizedBox;
  motion: EditorMotion;
  transition: EditorTransition;
  locked: boolean;
  /**
   * Per-shot technique (visual-language registry). Optional: a legacy clip has none and is read as before.
   * A graphic technique needs `graphic` and no media asset. A still needs an image, footage and screen
   * recording need a video. A moving still is never a screen recording.
   */
  technique?: VisualTechniqueId | null;
  /** Procedural graphic data for a graphic technique. Validated in graphics.ts. Null or absent for media clips. */
  graphic?: EditorGraphic | null;
}

export interface EditorAudioClip {
  id: string;
  sourceAssetId: string;
  speakerId: string | null;
  startSec: number;
  sourceInSec: number;
  sourceOutSec: number;
  gainDb: number;
  locked: boolean;
  approved: boolean;
}

export interface EditorCaption {
  id: string;
  startSec: number;
  endSec: number;
  /** Stored exactly. Arabic words, shaping and diacritics are never normalised here. */
  text: string;
  language: string;
  direction: 'rtl' | 'ltr';
  fontSizePx: number;
  position: { x: number; y: number };
  locked: boolean;
  /**
   * Translation link. When set, this caption is a translation of the spoken
   * caption whose id is `cueOf`. It shares that cue's timing exactly. It never
   * carries spoken content of its own: only text. Null or absent for spoken cues.
   * Optional so documents saved before the link existed remain valid.
   */
  cueOf?: string | null;
}

export interface EditorHighlight {
  id: string;
  startSec: number;
  endSec: number;
  visualClipId: string;
  /** Normalized DISPLAY-frame coordinates. Owner/editor annotation, not a recorded cursor. */
  box: NormalizedBox;
  label: string | null;
  locked: boolean;
}

export interface EditorAlignment {
  status: EditorAlignmentState;
  audioSha256: string | null;
  sourceRevision: number | null;
  proposalId: string | null;
  /**
   * Identity of the narration excerpt the alignment was made for (audio bytes,
   * source window, composition start). Optional for documents saved before it existed.
   */
  excerptSha256?: string | null;
  /** Synchronization verdict of the applied or proposed alignment. Optional. */
  syncVerdict?: EditorSyncVerdict | null;
}

/** Same vocabulary as scenario/sync-evidence.ts. Kept as literals to avoid an import cycle. */
export type EditorSyncVerdict = 'verified' | 'discrepancy' | 'unverified' | 'stale' | 'not_requested';

export interface EditorDocument {
  schemaVersion: typeof EDITOR_SCHEMA_VERSION;
  projectId: string;
  revision: number;
  contentProfile: EditorContentProfile;
  /**
   * Project visual language (registry in visual-language.ts). Null or absent: a legacy project, read as before.
   * Separate from the content profile and from each shot's technique.
   */
  visualLanguage?: VisualLanguageId | null;
  channelBrandId: string | null;
  targetId: EditorTargetId;
  format: EditorFormat;
  /**
   * Which caption language preview and export show. Null or absent: spoken captions
   * only (the default). A language code: each spoken cue is shown in that language
   * through its linked translation, or not at all when no translation exists.
   * Spoken and translated text are never shown together.
   */
  captionLanguage?: string | null;
  durationSec: number;
  assets: EditorAsset[];
  visualClips: EditorVisualClip[];
  audioClips: EditorAudioClip[];
  captions: EditorCaption[];
  highlights: EditorHighlight[];
  alignment: EditorAlignment;
}

export type EditorCollection = 'visualClips' | 'audioClips' | 'captions' | 'highlights';

export type EditorOperation =
  | { type: 'insert'; collection: EditorCollection; item: Record<string, unknown> }
  | { type: 'update'; collection: EditorCollection; id: string; changes: Record<string, unknown> }
  | { type: 'remove'; collection: EditorCollection; id: string }
  | { type: 'reorder'; collection: 'visualClips'; ids: string[] }
  | { type: 'split'; collection: 'visualClips'; id: string; atSec: number }
  | { type: 'setDocument'; changes: Record<string, unknown> };

/** Error with a stable machine code. The API maps `status` to HTTP. */
export class EditorError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'EditorError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validBox(box: unknown): box is NormalizedBox {
  if (!isObject(box)) return false;
  const { x, y, width, height } = box as Record<string, unknown>;
  if (![x, y, width, height].every(isFiniteNumber)) return false;
  const b = box as unknown as NormalizedBox;
  return b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0
    && b.x + b.width <= 1 + TIME_EPSILON && b.y + b.height <= 1 + TIME_EPSILON;
}

/**
 * Every problem in the document, as human-readable strings. Empty means valid.
 * Validation never rewrites a value; it only reports.
 */
export function validateEditorDocument(doc: EditorDocument): string[] {
  const problems: string[] = [];
  const add = (msg: string) => problems.push(msg);
  if (!isObject(doc)) return ['document is not an object'];
  if (doc.schemaVersion !== EDITOR_SCHEMA_VERSION) add(`schemaVersion must be ${EDITOR_SCHEMA_VERSION}`);
  if (typeof doc.projectId !== 'string' || doc.projectId.length === 0) add('projectId must be a non-empty string');
  if (!Number.isInteger(doc.revision) || doc.revision < 0) add('revision must be an integer >= 0');
  if (!(EDITOR_CONTENT_PROFILES as readonly string[]).includes(doc.contentProfile)) add('contentProfile must be religious, educational or promotional');
  if (doc.channelBrandId !== null && typeof doc.channelBrandId !== 'string') add('channelBrandId must be a string or null');
  if (doc.captionLanguage !== undefined && doc.captionLanguage !== null && !CAPTION_LANGUAGE_RE.test(doc.captionLanguage)) {
    add('captionLanguage must be a language code such as en or ar-EG, or null');
  }
  if (!(EDITOR_TARGET_IDS as readonly string[]).includes(doc.targetId)) add('targetId is not a known target');
  if (!(EDITOR_FORMATS as readonly string[]).includes(doc.format)) add('format must be landscape or portrait');
  if (doc.visualLanguage !== undefined && doc.visualLanguage !== null && !isVisualLanguageId(doc.visualLanguage)) {
    add('visualLanguage is not a known visual language');
  }
  if (!isFiniteNumber(doc.durationSec) || doc.durationSec <= 0) add('durationSec must be a finite positive number');
  if (!isObject(doc.alignment) || !(EDITOR_ALIGNMENT_STATES as readonly string[]).includes((doc.alignment as EditorAlignment).status)) {
    add('alignment.status is not a known state');
  }

  const assetIds = new Set<string>();
  const assetKind = new Map<string, EditorAssetKind>();
  for (const asset of doc.assets ?? []) {
    if (!asset || typeof asset.id !== 'string' || asset.id.length === 0) { add('asset without id'); continue; }
    if (assetIds.has(asset.id)) add(`duplicate asset id ${asset.id}`);
    assetIds.add(asset.id);
    if (!(EDITOR_ASSET_KINDS as readonly string[]).includes(asset.kind)) add(`asset ${asset.id} has unknown kind`);
    assetKind.set(asset.id, asset.kind);
    if (asset.durationSec !== null && !(isFiniteNumber(asset.durationSec) && asset.durationSec > 0)) add(`asset ${asset.id} durationSec must be null or positive`);
    if (typeof asset.mediaUrl !== 'string' || asset.mediaUrl.length === 0) add(`asset ${asset.id} needs a mediaUrl`);
    if (typeof asset.source !== 'string' || typeof asset.license !== 'string') add(`asset ${asset.id} needs source and license strings`);
  }

  const visualIds = new Set<string>();
  let cursor = 0;
  for (const clip of doc.visualClips ?? []) {
    if (!clip || typeof clip.id !== 'string' || clip.id.length === 0) { add('visual clip without id'); continue; }
    if (visualIds.has(clip.id)) add(`duplicate visual clip id ${clip.id}`);
    visualIds.add(clip.id);
    if (!isFiniteNumber(clip.durationSec) || clip.durationSec <= 0) add(`visual ${clip.id} durationSec must be positive`);
    if (!isFiniteNumber(clip.startSec) || Math.abs(clip.startSec - cursor) > TIME_EPSILON) {
      add(`visual ${clip.id} startSec ${clip.startSec} is not contiguous (expected ${cursor.toFixed(3)})`);
    }
    cursor += isFiniteNumber(clip.durationSec) ? clip.durationSec : 0;
    if (!validBox(clip.crop)) add(`visual ${clip.id} crop must be a normalized box inside the frame`);
    if (!(EDITOR_MOTIONS as readonly string[]).includes(clip.motion)) add(`visual ${clip.id} motion is unknown`);
    if (!(EDITOR_TRANSITIONS as readonly string[]).includes(clip.transition)) add(`visual ${clip.id} transition is unknown`);
    if (typeof clip.locked !== 'boolean') add(`visual ${clip.id} locked must be boolean`);
    if (clip.transition === 'dissolve') add(`visual ${clip.id} transition dissolve is not rendered (amendment A1 pending); use cut or fade`);
    if (clip.sourceAssetId === null) {
      if (clip.sourceInSec !== null || clip.sourceOutSec !== null) add(`visual ${clip.id} placeholder cannot carry a source range`);
      continue;
    }
    const kind = assetKind.get(clip.sourceAssetId);
    if (!kind) { add(`visual ${clip.id} references missing asset ${clip.sourceAssetId}`); continue; }
    if (kind === 'audio') { add(`visual ${clip.id} cannot use an audio asset`); continue; }
    if (kind === 'video' && clip.motion !== 'none') add(`visual ${clip.id} motion applies to still images only; footage must use none`);
    if (kind === 'image') {
      if (clip.sourceInSec !== null || clip.sourceOutSec !== null) add(`still ${clip.id} must have null source range`);
      continue;
    }
    // video: source range must match the composition duration exactly (speed 1)
    if (!isFiniteNumber(clip.sourceInSec) || !isFiniteNumber(clip.sourceOutSec)) { add(`video ${clip.id} needs a source range`); continue; }
    if (clip.sourceInSec < 0 || clip.sourceOutSec <= clip.sourceInSec) add(`video ${clip.id} has an invalid source range`);
    if (isFiniteNumber(clip.durationSec) && Math.abs(clip.sourceOutSec - clip.sourceInSec - clip.durationSec) > TIME_EPSILON) {
      add(`video ${clip.id} source range does not equal its duration`);
    }
    const asset = doc.assets.find((a) => a.id === clip.sourceAssetId);
    if (asset && asset.durationSec !== null && clip.sourceOutSec > asset.durationSec + TIME_EPSILON) {
      add(`video ${clip.id} source range exceeds asset duration`);
    }
  }
  if (isFiniteNumber(doc.durationSec) && (doc.visualClips ?? []).length > 0 && Math.abs(cursor - doc.durationSec) > TIME_EPSILON) {
    add(`durationSec ${doc.durationSec} does not equal the visual timeline ${cursor.toFixed(3)}`);
  }
  // Techniques and graphics. A graphic is structured data for one clip; a media technique must match its asset kind.
  const language = doc.visualLanguage ?? null;
  for (const clip of doc.visualClips ?? []) {
    if (!clip || typeof clip.id !== 'string') continue;
    const hasGraphic = clip.graphic !== undefined && clip.graphic !== null;
    const technique = clip.technique ?? null;
    if (technique !== null && !isVisualTechniqueId(technique)) { add(`visual ${clip.id} technique is unknown`); continue; }
    if (language !== null && isVisualLanguageId(language) && technique !== null && !languageAllowsTechnique(language, technique)) {
      add(`visual ${clip.id} uses ${technique}, which the ${language} visual language does not allow`);
    }
    if (hasGraphic) {
      if (clip.sourceAssetId !== null) add(`visual ${clip.id} has graphic data and a media asset. A graphic clip has no source asset.`);
      for (const problem of validateGraphic(clip.graphic, { durationSec: clip.durationSec, format: doc.format, contentProfile: doc.contentProfile })) {
        add(`visual ${clip.id}: ${problem}`);
      }
      if (technique !== null && technique !== clip.graphic?.kind) add(`visual ${clip.id} technique ${technique} does not match its graphic kind ${String(clip.graphic?.kind)}`);
    } else if (isGraphicTechniqueId(technique)) {
      add(`visual ${clip.id} uses ${technique} but has no graphic data. Nothing is replaced silently: add the graphic or choose another technique.`);
    }
    const kindOf = clip.sourceAssetId ? assetKind.get(clip.sourceAssetId) : undefined;
    if (technique === 'still_image' && clip.sourceAssetId !== null && kindOf !== 'image') add(`visual ${clip.id} is a still but its asset is not an image`);
    if (technique === 'footage_clip' && kindOf !== 'video') add(`visual ${clip.id} is footage but its asset is not a video`);
    if (technique === 'screen_recording') {
      if (kindOf !== 'video') add(`visual ${clip.id} is a screen recording but its asset is not a video. A still is never a recording.`);
    }
  }

  const audioIds = new Set<string>();
  for (const clip of doc.audioClips ?? []) {
    if (!clip || typeof clip.id !== 'string') { add('audio clip without id'); continue; }
    if (audioIds.has(clip.id)) add(`duplicate audio clip id ${clip.id}`);
    audioIds.add(clip.id);
    if (assetKind.get(clip.sourceAssetId) !== 'audio') add(`audio ${clip.id} must reference an audio asset`);
    if (clip.speakerId !== null && typeof clip.speakerId !== 'string') add(`audio ${clip.id} speakerId must be string or null`);
    if (!isFiniteNumber(clip.startSec) || clip.startSec < 0) add(`audio ${clip.id} startSec must be >= 0`);
    if (!isFiniteNumber(clip.sourceInSec) || !isFiniteNumber(clip.sourceOutSec) || clip.sourceInSec < 0 || clip.sourceOutSec <= clip.sourceInSec) {
      add(`audio ${clip.id} has an invalid source range`);
    }
    if (!isFiniteNumber(clip.gainDb)) add(`audio ${clip.id} gainDb must be finite`);
    if (typeof clip.locked !== 'boolean' || typeof clip.approved !== 'boolean') add(`audio ${clip.id} locked/approved must be boolean`);
  }

  // Captions are timed by the narration. They may run past a shortened visual
  // timeline while a narration clip still covers them, but never past both.
  const narrationEnd = (doc.audioClips ?? []).reduce(
    (max, a) => (isFiniteNumber(a.startSec) && isFiniteNumber(a.sourceInSec) && isFiniteNumber(a.sourceOutSec)
      ? Math.max(max, a.startSec + (a.sourceOutSec - a.sourceInSec)) : max),
    0,
  );
  const captionLimit = Math.max(isFiniteNumber(doc.durationSec) ? doc.durationSec : 0, narrationEnd);
  const captionIds = new Set<string>();
  for (const cap of doc.captions ?? []) {
    if (!cap || typeof cap.id !== 'string') { add('caption without id'); continue; }
    if (captionIds.has(cap.id)) add(`duplicate caption id ${cap.id}`);
    captionIds.add(cap.id);
    if (!isFiniteNumber(cap.startSec) || !isFiniteNumber(cap.endSec) || cap.startSec < 0 || cap.endSec <= cap.startSec) {
      add(`caption ${cap.id} has an invalid interval`);
    } else if (cap.endSec > captionLimit + TIME_EPSILON) {
      add(`caption ${cap.id} ends after the narration and visual timeline`);
    }
    if (typeof cap.text !== 'string') add(`caption ${cap.id} text must be a string`);
    if (typeof cap.language !== 'string') add(`caption ${cap.id} language must be a string`);
    if (cap.direction !== 'rtl' && cap.direction !== 'ltr') add(`caption ${cap.id} direction must be rtl or ltr`);
    if (!isFiniteNumber(cap.fontSizePx) || cap.fontSizePx <= 0) add(`caption ${cap.id} fontSizePx must be positive`);
    if (!isObject(cap.position) || !isFiniteNumber(cap.position.x) || !isFiniteNumber(cap.position.y)
      || cap.position.x < 0 || cap.position.x > 1 || cap.position.y < 0 || cap.position.y > 1) {
      add(`caption ${cap.id} position must be normalized`);
    }
    if (typeof cap.locked !== 'boolean') add(`caption ${cap.id} locked must be boolean`);
    if (cap.cueOf !== undefined && cap.cueOf !== null && typeof cap.cueOf !== 'string') add(`caption ${cap.id} cueOf must be a string or null`);
  }
  // Translation links: a translation points at a spoken cue, shares its timing, and is never chained.
  const captionById = new Map((doc.captions ?? []).filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
  for (const cap of doc.captions ?? []) {
    if (!cap || typeof cap.id !== 'string' || !cap.cueOf) continue;
    const spoken = captionById.get(cap.cueOf);
    if (cap.cueOf === cap.id) add(`caption ${cap.id} cannot be a translation of itself`);
    else if (!spoken) add(`translation ${cap.id} refers to missing spoken cue ${cap.cueOf}`);
    else if (spoken.cueOf) add(`translation ${cap.id} refers to ${cap.cueOf}, which is itself a translation`);
    else if (Math.abs(spoken.startSec - cap.startSec) > TIME_EPSILON || Math.abs(spoken.endSec - cap.endSec) > TIME_EPSILON) {
      add(`translation ${cap.id} timing differs from its spoken cue ${cap.cueOf}`);
    }
  }

  const highlightIds = new Set<string>();
  for (const h of doc.highlights ?? []) {
    if (!h || typeof h.id !== 'string') { add('highlight without id'); continue; }
    if (highlightIds.has(h.id)) add(`duplicate highlight id ${h.id}`);
    highlightIds.add(h.id);
    const clip = (doc.visualClips ?? []).find((c) => c.id === h.visualClipId);
    if (!clip) { add(`highlight ${h.id} references missing visual clip ${h.visualClipId}`); continue; }
    if (!isFiniteNumber(h.startSec) || !isFiniteNumber(h.endSec) || h.endSec <= h.startSec) {
      add(`highlight ${h.id} has an invalid interval`);
    } else if (h.startSec < clip.startSec - TIME_EPSILON || h.endSec > clip.startSec + clip.durationSec + TIME_EPSILON) {
      add(`highlight ${h.id} lies outside its visual clip`);
    }
    if (!validBox(h.box)) add(`highlight ${h.id} box must be a normalized box inside the frame`);
    if (h.label !== null && typeof h.label !== 'string') add(`highlight ${h.id} label must be string or null`);
    if (typeof h.locked !== 'boolean') add(`highlight ${h.id} locked must be boolean`);
  }
  return problems;
}

/** Throws EditorError(EDITOR_VALIDATION_FAILED) on the first problem. */
/** Language code: primary subtag plus optional region. Stored exactly as given. */
export const CAPTION_LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/;

/**
 * The captions preview and export show for a caption language. Pure, and the only
 * place that decides it. Spoken cues are shown in their own language. Any other
 * spoken cue is shown through its linked translation in that language. A cue with
 * no such translation is reported and not shown: unsaid text is never filled in.
 */
export function selectCaptions(doc: EditorDocument, language: string | null): { cues: EditorCaption[]; missingTranslations: string[] } {
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

export function assertValidEditorDocument(doc: EditorDocument): void {
  const problems = validateEditorDocument(doc);
  if (problems.length > 0) throw new EditorError('EDITOR_VALIDATION_FAILED', problems[0], 422);
}

/* ------------------------------------------------------------------ */
/* Derivation from an existing project (sidecar; source is not touched) */
/* ------------------------------------------------------------------ */

export interface DeriveAssetRef {
  id: string;
  kind: EditorAssetKind;
  name: string;
  mediaUrl: string;
  durationSec: number | null;
  source: string;
  license: string;
  sha256?: string | null;
  /** Local file path is used only to decide kind compatibility, never returned. */
  mimeType?: string | null;
}

export interface DeriveOptions {
  project: Project;
  targetId: EditorTargetId;
  assets?: DeriveAssetRef[];
  /** Narration asset used for audio clips. Null when no owner recording is bound. */
  narration?: { assetId: string; durationSec: number | null; sha256: string | null; approved: boolean } | null;
}

function editorAssetFromRef(ref: DeriveAssetRef): EditorAsset {
  return {
    id: ref.id,
    kind: ref.kind,
    name: ref.name,
    mediaUrl: ref.mediaUrl,
    durationSec: ref.durationSec,
    source: ref.source,
    license: ref.license,
    sha256: ref.sha256 ?? null,
  };
}

/**
 * Add eligible library assets (image or video) that the document does not
 * contain yet, so a clip can be assigned any of them, including assets
 * uploaded after the editor was opened. Existing assets are not changed. The
 * caller decides eligibility (status, licence) and passes only eligible refs.
 * Returns the same document when nothing is added.
 */
/** A library audio asset is eligible only with a positive duration and the sha256 of its bytes. */
export function isEligibleLibraryAudio(ref: DeriveAssetRef): boolean {
  return ref.kind === 'audio'
    && typeof ref.durationSec === 'number' && Number.isFinite(ref.durationSec) && ref.durationSec > 0
    && typeof ref.sha256 === 'string' && /^[0-9a-f]{64}$/.test(ref.sha256);
}

export function mergeLibraryAssets(doc: EditorDocument, refs: DeriveAssetRef[]): EditorDocument {
  const known = new Set(doc.assets.map((a) => a.id));
  const added = refs
    .filter((r) => !known.has(r.id) && ((r.kind === 'image' || r.kind === 'video') || isEligibleLibraryAudio(r)))
    .map(editorAssetFromRef);
  if (added.length === 0) return doc;
  const next: EditorDocument = { ...doc, assets: [...doc.assets, ...added] };
  assertValidEditorDocument(next);
  return next;
}

export function contentProfileForDocument(input: Pick<ProjectInput, 'contentProfile'> | null | undefined): EditorContentProfile {
  const v = input?.contentProfile;
  return v === 'religious' || v === 'educational' || v === 'promotional' ? v : 'promotional';
}

function scenesForTarget(project: Project, targetId: EditorTargetId): Scene[] {
  if (targetId === 'long') return project.storyboard.long.scenes;
  return project.storyboard.shorts.find((s) => s.id === targetId)?.scenes ?? [];
}

function captionsForTargetLegacy(project: Project, targetId: EditorTargetId): CaptionCue[] {
  if (targetId === 'long') return project.storyboard.captions ?? [];
  return project.storyboard.shortCaptions?.[targetId] ?? [];
}

function formatForTarget(targetId: EditorTargetId): EditorFormat {
  return targetId === 'long' ? 'landscape' : 'portrait';
}

/**
 * Build a versioned editor document from a legacy/production project. Pure:
 * it returns a new object and never mutates the project. Throws when the
 * project has no timeline for the target, rather than inventing one.
 */
export function deriveEditorDocument(opts: DeriveOptions): EditorDocument {
  const { project, targetId } = opts;
  const scenes = scenesForTarget(project, targetId);
  if (scenes.length === 0) {
    throw new EditorError('EDITOR_NO_TIMELINE', `Target ${targetId} has no scenes to edit. Generate its storyboard first.`, 409);
  }
  const assetsById = new Map((opts.assets ?? []).map((a) => [a.id, a]));
  const assets: EditorAsset[] = [];
  const visualClips: EditorVisualClip[] = [];
  let cursor = 0;
  for (const scene of [...scenes].sort((a, b) => a.index - b.index)) {
    const duration = Number(scene.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new EditorError('EDITOR_BAD_SCENE_DURATION', `Scene ${scene.id} has no positive duration.`, 422);
    }
    const ref = scene.assetIds[0] ? assetsById.get(scene.assetIds[0]) : undefined;
    let sourceAssetId: string | null = null;
    let sourceInSec: number | null = null;
    let sourceOutSec: number | null = null;
    if (ref && (ref.kind === 'image' || ref.kind === 'video')) {
      if (!assets.some((a) => a.id === ref.id)) assets.push(editorAssetFromRef(ref));
      sourceAssetId = ref.id;
      if (ref.kind === 'video') {
        // A legacy scene plays its footage from the start of the asset.
        sourceInSec = 0;
        sourceOutSec = duration;
        if (ref.durationSec !== null && duration > ref.durationSec + TIME_EPSILON) {
          throw new EditorError('EDITOR_SOURCE_TOO_SHORT', `Scene ${scene.id} needs ${duration}s but ${ref.id} is ${ref.durationSec}s.`, 422);
        }
      }
    }
    visualClips.push({
      id: `vc_${scene.id}`,
      sourceAssetId,
      startSec: cursor,
      durationSec: duration,
      sourceInSec,
      sourceOutSec,
      crop: { ...FULL_FRAME },
      motion: 'none',
      transition: 'cut',
      locked: Boolean(scene.locked),
    });
    cursor += duration;
  }

  const captions: EditorCaption[] = captionsForTargetLegacy(project, targetId)
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .map((c) => ({
      id: `cap_${c.id}`,
      startSec: c.start,
      endSec: Math.min(c.end, cursor),
      text: c.text,
      language: project.meta.input.outputLanguage || 'und',
      direction: /[\u0600-\u06FF]/.test(c.text) ? 'rtl' as const : 'ltr' as const,
      fontSizePx: 48,
      position: { x: 0.5, y: 0.86 },
      locked: false,
    }))
    .filter((c) => c.endSec > c.startSec);

  const audioClips: EditorAudioClip[] = [];
  if (opts.narration) {
    const n = opts.narration;
    const audio = assetsById.get(n.assetId);
    if (audio && audio.kind === 'audio') {
      const dur = n.durationSec ?? cursor;
      assets.push({
        id: audio.id,
        kind: 'audio',
        name: audio.name,
        mediaUrl: audio.mediaUrl,
        durationSec: dur,
        source: audio.source,
        license: audio.license,
        sha256: n.sha256,
      });
      audioClips.push({
        id: `ac_${audio.id}`,
        sourceAssetId: audio.id,
        speakerId: null,
        startSec: 0,
        sourceInSec: 0,
        sourceOutSec: dur,
        gainDb: 0,
        locked: false,
        approved: n.approved,
      });
    }
  }

  const doc: EditorDocument = {
    schemaVersion: EDITOR_SCHEMA_VERSION,
    projectId: project.meta.input.videoId,
    revision: 0,
    contentProfile: contentProfileForDocument(project.meta.input),
    channelBrandId: project.meta.input.brandPreset || null,
    targetId,
    format: formatForTarget(targetId),
    durationSec: cursor,
    assets,
    visualClips,
    audioClips,
    captions,
    highlights: [],
    alignment: { status: 'not_requested', audioSha256: null, sourceRevision: null, proposalId: null },
  };
  assertValidEditorDocument(doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/* Mapping into the EXISTING render model                              */
/* ------------------------------------------------------------------ */

export interface EditorRenderPlan {
  /** Caption language the plan shows. Null means spoken captions. */
  captionLanguage: string | null;
  /** Spoken cues with no translation in the selected language. They are not shown. */
  missingTranslations: string[];
  projectId: string;
  targetId: EditorTargetId;
  revision: number;
  /** Orientation: landscape maps to the long composition, portrait to the short one. */
  format: EditorFormat;
  /** Channel identity (brand preset). The renderer must use this brand. */
  channelBrandId: string | null;
  durationSec: number;
  scenes: Scene[];
  captions: CaptionCue[];
  /** Timed annotations, in composition time. Shown only inside their intervals. */
  highlights: Array<{ id: string; startSec: number; endSec: number; box: NormalizedBox; label: string | null }>;
}

/** Half window (seconds) of a fade-through-black centred on a clip boundary. */
export const FADE_MAX_HALF_SEC = 0.5;

/**
 * A `fade` clip fades through black across its start boundary. The window is
 * clamped so it never exceeds half of either neighbouring clip. The first clip
 * has no boundary here: the composition's opening fade covers it.
 */
export function fadeHalfWindowFor(doc: EditorDocument, index: number): number {
  const clip = doc.visualClips[index];
  if (!clip || clip.transition !== 'fade' || index === 0) return 0;
  const prev = doc.visualClips[index - 1];
  return Math.min(FADE_MAX_HALF_SEC, prev.durationSec / 2, clip.durationSec / 2);
}

/**
 * One document feeds render. Each visual clip becomes one existing Scene, so
 * the existing SceneRenderer, captions and export path are reused. Source
 * offsets, crop and motion travel inside `content` so a clip that begins after
 * composition time zero still starts from its own source position.
 */
export function editorDocumentToRenderPlan(doc: EditorDocument): EditorRenderPlan {
  assertValidEditorDocument(doc);
  const captionLanguage = doc.captionLanguage ?? null;
  const selected = selectCaptions(doc, captionLanguage);
  const assetKind = new Map(doc.assets.map((a) => [a.id, a]));
  const scenes: Scene[] = doc.visualClips.map((clip, index) => {
    const asset = clip.sourceAssetId ? assetKind.get(clip.sourceAssetId) : undefined;
    const mediaKind: SceneContent['mediaKind'] = asset ? (asset.kind === 'video' ? 'video' : 'image') : 'none';
    const content: SceneContent = {
      headline: '',
      items: [],
      stat: null,
      statLabel: null,
      stat2: null,
      statLabel2: null,
      takeaway: null,
      source: null,
      emphasis: null,
      presentation: asset ? 'owner_picture' : 'reflective',
      mediaKind,
      pointer: null,
      sourceInSec: clip.sourceInSec,
      crop: clip.crop,
      motion: clip.motion,
      fadeSec: fadeHalfWindowFor(doc, index),
      technique: clip.technique ?? null,
      graphic: clip.graphic ?? null,
    };
    return {
      id: clip.id,
      index,
      role: 'body',
      section: '',
      variant: 'key_statement',
      background: 'full_typography',
      // dissolve/fade are stored in the document but not rendered yet; they are
      // reported as unavailable in capabilities rather than mapped to a wrong effect.
      transitionIn: 'direct_cut',
      textPosition: 'lower_third',
      accent: '#E4C98A',
      duration: clip.durationSec,
      startTime: clip.startSec,
      narration: '',
      captionIds: selected.cues
        .filter((c) => c.startSec < clip.startSec + clip.durationSec && c.endSec > clip.startSec)
        .map((c) => c.id),
      content,
      assetIds: clip.sourceAssetId ? [clip.sourceAssetId] : [],
      reason: { detected: 'editor', evidence: 'editor document visual clip', notUsedRecently: [], alternatives: [] },
      locked: clip.locked,
      userEdited: true,
    };
  });
  const captions: CaptionCue[] = selected.cues.map((c) => ({
    id: c.id,
    start: c.startSec,
    end: c.endSec,
    text: c.text,
    sceneId: scenes.find((s) => c.startSec >= s.startTime - TIME_EPSILON && c.startSec < s.startTime + s.duration - TIME_EPSILON)?.id ?? null,
    terms: [],
    userEdited: true,
    // Per-cue style is carried through so the renderer can apply it.
    fontSizePx: c.fontSizePx,
    position: { x: c.position.x, y: c.position.y },
    direction: c.direction,
  }));
  return {
    captionLanguage,
    missingTranslations: selected.missingTranslations,
    projectId: doc.projectId,
    targetId: doc.targetId,
    revision: doc.revision,
    format: doc.format,
    channelBrandId: doc.channelBrandId,
    durationSec: doc.durationSec,
    scenes,
    captions,
    highlights: doc.highlights.map((h) => ({ id: h.id, startSec: h.startSec, endSec: h.endSec, box: h.box, label: h.label })),
  };
}
