/**
 * Request validation and selection reconciliation for the Milestone 2 contract.
 * Pure: no filesystem, no network. Every check runs before the API writes.
 */
import {
  FACTORY_CONTENT_PROFILES,
  FACTORY_FORMATS,
  FACTORY_STORYBOARD_VERSION,
  FactoryError,
  type FactoryContentProfile,
  type FactoryDraftScene,
  type FactoryFormat,
  type FactoryStoryboardSceneInput,
  type FactoryStoryboardV1,
  type FactoryAssetOrigin,
} from './contract.js';
import { FACTORY_MAX_UNITS } from './planning.js';

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_BRIEF = 2000;
const MAX_SCRIPT = 20000;
const MAX_NARRATION = 2000;
const MAX_INTENT = 300;
const MAX_ASSETS = 60;

export interface FactoryRequestedSpeaker {
  id: string;
  voiceId: string | null;
}

export interface FactoryDraftCreateInput {
  contentProfile: FactoryContentProfile;
  format: FactoryFormat;
  channelBrandId: string | null;
  inputs: {
    brief: string;
    script: string | null;
    audioAssetId: string | null;
    visualAssetIds: string[];
    storyboard: FactoryStoryboardV1 | null;
  };
  requestedSpeakers: FactoryRequestedSpeaker[];
  referenceProjectId: string | null;
}

export interface FactoryPatchScene {
  id: string;
  narration: string;
  speakerId: string | null;
  visualIntent: string;
  assetId: string | null;
  startSec: number | null;
  endSec: number | null;
  locked: boolean;
}

export interface FactoryDraftPatchInput {
  expectedRevision: number;
  selectedTreatmentId: string;
  scenes: Array<FactoryPatchScene & Partial<ServerOwnedFields>>;
  speakers: FactoryRequestedSpeaker[];
}

interface ServerOwnedFields {
  sourceUnitId: string;
  beat: string;
  language: string;
  assetOrigin: FactoryAssetOrigin;
  timingSource: string;
  visualDecision: unknown;
}

const SERVER_OWNED = ['sourceUnitId', 'beat', 'language', 'assetOrigin', 'timingSource', 'visualDecision'] as const;
const PATCH_SCENE_KEYS = ['id', 'narration', 'speakerId', 'visualIntent', 'assetId', 'startSec', 'endSec', 'locked'] as const;

const invalid = (message: string): never => {
  throw new FactoryError('FACTORY_VALIDATION', message, 422);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function optionalId(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !ID_RE.test(v)) invalid(`${field} must be an id of 1-40 letters, digits, '_' or '-'.`);
  return v as string;
}

function nonEmptyString(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.trim().length === 0) invalid(`${field} must be a non-empty string.`);
  if ((v as string).length > max) invalid(`${field} is longer than ${max} characters.`);
  return v as string;
}

function timeOrNull(v: unknown, field: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) invalid(`${field} must be a finite number of seconds or null.`);
  return v as number;
}

function checkTimes(start: number | null, end: number | null, field: string): void {
  if ((start === null) !== (end === null)) invalid(`${field}: startSec and endSec must both be set or both be null.`);
  if (start !== null && end !== null && !(end > start)) invalid(`${field}: endSec must be greater than startSec.`);
}

function parseStoryboard(v: unknown): FactoryStoryboardV1 | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) invalid('storyboard must be null or an object.');
  const obj = v as Record<string, unknown>;
  if (obj.version !== FACTORY_STORYBOARD_VERSION) {
    throw new FactoryError('FACTORY_STORYBOARD_VERSION_UNSUPPORTED', 'Only storyboard version 1 is supported.', 422);
  }
  if (!Array.isArray(obj.scenes) || obj.scenes.length === 0) invalid('storyboard.scenes must be a non-empty array.');
  if ((obj.scenes as unknown[]).length > FACTORY_MAX_UNITS) invalid(`storyboard.scenes may hold at most ${FACTORY_MAX_UNITS} scenes.`);
  const seen = new Set<string>();
  const scenes: FactoryStoryboardSceneInput[] = (obj.scenes as unknown[]).map((raw, i) => {
    if (!isObj(raw)) invalid(`storyboard.scenes[${i}] must be an object.`);
    const s = raw as Record<string, unknown>;
    const id = optionalId(s.id, `storyboard.scenes[${i}].id`);
    if (!id) invalid(`storyboard.scenes[${i}].id is required.`);
    if (seen.has(id as string)) invalid(`storyboard scene id "${id}" is duplicated.`);
    seen.add(id as string);
    const narration = nonEmptyString(s.narration, `storyboard.scenes[${i}].narration`, MAX_NARRATION);
    const startSec = timeOrNull(s.startSec, `storyboard.scenes[${i}].startSec`);
    const endSec = timeOrNull(s.endSec, `storyboard.scenes[${i}].endSec`);
    checkTimes(startSec, endSec, `storyboard.scenes[${i}]`);
    if (typeof s.locked !== 'boolean' && s.locked !== undefined) invalid(`storyboard.scenes[${i}].locked must be a boolean.`);
    return {
      id: id as string,
      narration,
      speakerId: optionalId(s.speakerId, `storyboard.scenes[${i}].speakerId`),
      assetId: optionalId(s.assetId, `storyboard.scenes[${i}].assetId`),
      startSec,
      endSec,
      locked: s.locked === true,
    };
  });
  return { version: 1, scenes };
}

/** Validate a POST /api/factory/drafts body. Shape only; asset and identity checks are the API's. */
export function parseDraftCreate(body: unknown): FactoryDraftCreateInput {
  if (!isObj(body)) invalid('Request body must be a JSON object.');
  const b = body as Record<string, unknown>;
  if (!FACTORY_CONTENT_PROFILES.includes(b.contentProfile as FactoryContentProfile)) {
    invalid('contentProfile must be religious, educational, or promotional.');
  }
  if (!FACTORY_FORMATS.includes(b.format as FactoryFormat)) invalid('format must be landscape or portrait.');
  const channelBrandId = optionalId(b.channelBrandId, 'channelBrandId');
  if (!isObj(b.inputs)) invalid('inputs must be an object.');
  const inp = b.inputs as Record<string, unknown>;
  const brief = typeof inp.brief === 'string' ? inp.brief : invalid('inputs.brief must be a string.');
  if (brief.length > MAX_BRIEF) invalid(`inputs.brief is longer than ${MAX_BRIEF} characters.`);
  let script: string | null = null;
  if (inp.script !== null && inp.script !== undefined) {
    if (typeof inp.script !== 'string') invalid('inputs.script must be a string or null.');
    if ((inp.script as string).length > MAX_SCRIPT) invalid(`inputs.script is longer than ${MAX_SCRIPT} characters.`);
    script = (inp.script as string).trim() ? (inp.script as string) : null;
  }
  const audioAssetId = optionalId(inp.audioAssetId, 'inputs.audioAssetId');
  if (!Array.isArray(inp.visualAssetIds)) invalid('inputs.visualAssetIds must be an array.');
  if ((inp.visualAssetIds as unknown[]).length > MAX_ASSETS) invalid(`inputs.visualAssetIds may hold at most ${MAX_ASSETS} ids.`);
  const visualAssetIds = (inp.visualAssetIds as unknown[]).map((v, i) => {
    const id = optionalId(v, `inputs.visualAssetIds[${i}]`);
    if (!id) invalid(`inputs.visualAssetIds[${i}] must not be null.`);
    return id as string;
  });
  const storyboard = parseStoryboard(inp.storyboard);
  // A brief alone is accepted and returns a blocked draft that asks for reviewed text. No text is generated.
  if (storyboard && script) invalid('Provide either a script or a storyboard, not both.');
  let requestedSpeakers: FactoryRequestedSpeaker[] = [];
  if (b.requestedSpeakers !== undefined) {
    requestedSpeakers = parseSpeakers(b.requestedSpeakers, 'requestedSpeakers');
  }
  const referenceProjectId = optionalId(b.referenceProjectId, 'referenceProjectId');
  return {
    contentProfile: b.contentProfile as FactoryContentProfile,
    format: b.format as FactoryFormat,
    channelBrandId,
    inputs: { brief, script, audioAssetId, visualAssetIds, storyboard },
    requestedSpeakers,
    referenceProjectId,
  };
}

function parseSpeakers(v: unknown, field: string): FactoryRequestedSpeaker[] {
  if (!Array.isArray(v)) invalid(`${field} must be an array.`);
  const seen = new Set<string>();
  return (v as unknown[]).map((raw, i) => {
    if (!isObj(raw)) invalid(`${field}[${i}] must be an object.`);
    const s = raw as Record<string, unknown>;
    const id = optionalId(s.id, `${field}[${i}].id`);
    if (!id) invalid(`${field}[${i}].id is required.`);
    if (seen.has(id as string)) invalid(`${field} id "${id}" is duplicated.`);
    seen.add(id as string);
    const voiceId = optionalId(s.voiceId, `${field}[${i}].voiceId`);
    return { id: id as string, voiceId };
  });
}

/** Validate a PATCH body. Shape only; selection semantics are in `reconcileSelection`. */
export function parseDraftPatch(body: unknown): FactoryDraftPatchInput {
  if (!isObj(body)) invalid('Request body must be a JSON object.');
  const b = body as Record<string, unknown>;
  if (typeof b.expectedRevision !== 'number' || !Number.isInteger(b.expectedRevision) || b.expectedRevision < 0) {
    invalid('expectedRevision must be a non-negative integer.');
  }
  const selectedTreatmentId = optionalId(b.selectedTreatmentId, 'selectedTreatmentId');
  if (!selectedTreatmentId) invalid('selectedTreatmentId is required.');
  if (!Array.isArray(b.scenes)) invalid('scenes must be an array.');
  if ((b.scenes as unknown[]).length > FACTORY_MAX_UNITS) invalid(`scenes may hold at most ${FACTORY_MAX_UNITS} rows.`);
  const scenes = (b.scenes as unknown[]).map((raw, i) => {
    if (!isObj(raw)) invalid(`scenes[${i}] must be an object.`);
    const s = raw as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (!(PATCH_SCENE_KEYS as readonly string[]).includes(key) && !(SERVER_OWNED as readonly string[]).includes(key)) {
        invalid(`scenes[${i}].${key} is not a field of a factory scene.`);
      }
    }
    const id = optionalId(s.id, `scenes[${i}].id`);
    if (!id) invalid(`scenes[${i}].id is required.`);
    const startSec = timeOrNull(s.startSec, `scenes[${i}].startSec`);
    const endSec = timeOrNull(s.endSec, `scenes[${i}].endSec`);
    checkTimes(startSec, endSec, `scenes[${i}]`);
    if (typeof s.locked !== 'boolean') invalid(`scenes[${i}].locked must be a boolean.`);
    if (typeof s.visualIntent !== 'string' || (s.visualIntent as string).length > MAX_INTENT) {
      invalid(`scenes[${i}].visualIntent must be a string of at most ${MAX_INTENT} characters.`);
    }
    const row: FactoryPatchScene & Partial<ServerOwnedFields> = {
      id: id as string,
      narration: typeof s.narration === 'string' ? s.narration : invalid(`scenes[${i}].narration must be a string.`),
      speakerId: optionalId(s.speakerId, `scenes[${i}].speakerId`),
      visualIntent: s.visualIntent as string,
      assetId: optionalId(s.assetId, `scenes[${i}].assetId`),
      startSec,
      endSec,
      locked: s.locked as boolean,
    };
    const owned = row as unknown as Record<string, unknown>;
    for (const key of SERVER_OWNED) {
      if (s[key] !== undefined) owned[key] = s[key];
    }
    return row;
  });
  const speakers = b.speakers === undefined ? [] : parseSpeakers(b.speakers, 'speakers');
  return { expectedRevision: b.expectedRevision as number, selectedTreatmentId: selectedTreatmentId as string, scenes, speakers };
}

/** Stable key order so locked rows compare byte-for-byte. */
export function canonicalScene(row: FactoryDraftScene): FactoryDraftScene {
  return {
    id: row.id,
    narration: row.narration,
    speakerId: row.speakerId,
    visualIntent: row.visualIntent,
    assetId: row.assetId,
    startSec: row.startSec,
    endSec: row.endSec,
    locked: row.locked,
    sourceUnitId: row.sourceUnitId,
    beat: row.beat,
    language: row.language,
    assetOrigin: row.assetOrigin,
    timingSource: row.timingSource,
    visualDecision: row.visualDecision,
  };
}

export interface ReconcileInput {
  /** Treatment and rows currently selected on the draft. */
  currentTreatmentId: string | null;
  currentScenes: FactoryDraftScene[];
  /** Proposal rows for every treatment, used for server-owned fields. */
  proposals: Record<string, FactoryDraftScene[]>;
  /** Supplied units: id -> exact narration text. */
  sourceNarration: Map<string, string>;
  /** Asset ids the caller may assign to a scene. Returns false for ineligible ids. */
  assetAllowed: (assetId: string) => boolean;
  /** Speaker ids a scene may reference. */
  speakerAllowed: (speakerId: string) => boolean;
  /** True when supplied speech fixes the scene order. Treatments may then vary visuals only. */
  orderLocked: boolean;
  incomingTreatmentId: string;
  incomingScenes: Array<FactoryPatchScene & Partial<ServerOwnedFields>>;
}

/**
 * Reconcile a PATCH selection against the stored draft.
 *  - Every supplied unit must appear exactly once; narration must match the supplied text.
 *  - A stored locked row must come back identical, else FACTORY_SCENE_LOCKED (423).
 *  - Switching treatment while a row is locked is refused the same way.
 *  - Server-owned fields may be echoed but not changed.
 * Returns the new selection in canonical form. Throws before any write.
 */
export function reconcileSelection(input: ReconcileInput): FactoryDraftScene[] {
  const proposal = input.proposals[input.incomingTreatmentId];
  if (!proposal) invalid('selectedTreatmentId does not name a treatment of this draft.');
  const stored = new Map(input.currentScenes.map((r) => [r.id, canonicalScene(r)]));
  const lockedStored = input.currentScenes.filter((r) => r.locked).map(canonicalScene);
  const treatmentChanged = input.incomingTreatmentId !== input.currentTreatmentId;
  if (treatmentChanged && lockedStored.length > 0) {
    throw new FactoryError('FACTORY_SCENE_LOCKED', 'A locked scene is in the current selection. Switching treatment would change it.', 423);
  }
  if (input.orderLocked) {
    const fixed = proposal.map((p) => p.id).join('\n');
    if (input.incomingScenes.map((r) => r.id).join('\n') !== fixed) {
      invalid('Scene order is fixed by the supplied narration. Treatments change visuals and labels, not the order of speech.');
    }
  }
  const sameTreatment = input.incomingTreatmentId === input.currentTreatmentId;
  const ids = new Set<string>();
  const out: FactoryDraftScene[] = [];
  for (const row of input.incomingScenes) {
    if (ids.has(row.id)) invalid(`scene id "${row.id}" appears more than once.`);
    ids.add(row.id);
    const source = input.sourceNarration.get(row.id);
    if (source === undefined) invalid(`scene "${row.id}" is not a supplied unit. Narration cannot be added.`);
    if (row.narration !== source) {
      throw new FactoryError('FACTORY_VALIDATION', `scene "${row.id}" narration does not match the supplied text. Supplied words are not edited here.`, 422);
    }
    // Server-owned fields come from the treatment that is being selected, not from the
    // previous selection. A stored row is used only while its treatment stays selected.
    const fromStored = sameTreatment ? stored.get(row.id) : undefined;
    const base = fromStored ?? proposal.find((p) => p.id === row.id) ?? null;
    if (!base) invalid(`scene "${row.id}" has no proposal row.`);
    // Server-owned fields: echo must equal the value the server holds for this treatment.
    for (const key of ['sourceUnitId', 'beat', 'language', 'timingSource', 'visualDecision'] as const) {
      const v = row[key];
      if (v !== undefined && JSON.stringify(v) !== JSON.stringify((base as unknown as Record<string, unknown>)[key])) {
        invalid(`scene "${row.id}".${key} is server-owned and cannot be changed.`);
      }
    }
    // Times come from the source unit (supplied recording or storyboard). Editing them is refused.
    const owner = proposal.find((p) => p.id === row.id) as FactoryDraftScene;
    if (row.startSec !== owner.startSec || row.endSec !== owner.endSec) {
      invalid(`scene "${row.id}" times belong to its source unit and cannot be edited here.`);
    }
    const next = canonicalScene({
      ...(base as FactoryDraftScene),
      speakerId: row.speakerId,
      visualIntent: row.visualIntent,
      assetId: row.assetId,
      startSec: owner.startSec,
      endSec: owner.endSec,
      locked: row.locked,
      sourceUnitId: owner.sourceUnitId,
      narration: row.narration,
      assetOrigin: row.assetId === null ? null
        : row.assetId === (base as FactoryDraftScene).assetId ? (base as FactoryDraftScene).assetOrigin : 'reviewer',
      timingSource: owner.timingSource,
    });
    if (next.assetId !== null && !input.assetAllowed(next.assetId)) {
      throw new FactoryError('FACTORY_ASSET_INVALID', `scene "${row.id}" references an asset that is not an active image or video in the library.`, 422);
    }
    if (!input.speakerAllowed(next.speakerId ?? '') && next.speakerId !== null) {
      invalid(`scene "${row.id}" references a speaker this draft does not know.`);
    }
    out.push(next);
  }
  if (out.length !== input.sourceNarration.size || [...input.sourceNarration.keys()].some((k) => !ids.has(k))) {
    invalid('scenes must contain every supplied unit exactly once.');
  }
  // Locked rows must come back identical. Position may change around them.
  for (const locked of lockedStored) {
    const match = out.find((r) => r.id === locked.id);
    if (!match || JSON.stringify(match) !== JSON.stringify(locked)) {
      throw new FactoryError('FACTORY_SCENE_LOCKED', `scene "${locked.id}" is locked and cannot be changed or removed.`, 423);
    }
  }
  return out;
}

export function isServerOwnedKey(key: string): boolean {
  return (SERVER_OWNED as readonly string[]).includes(key);
}

export function assertTimeline(scenes: FactoryDraftScene[]): void {
  let cursor: number | null = null;
  for (const s of scenes) {
    if (s.startSec === null) {
      cursor = null;
      continue;
    }
    if (cursor !== null && Math.abs(s.startSec - cursor) > 0.001) {
      throw new FactoryError('FACTORY_VALIDATION', `scene "${s.id}" does not start where the previous supplied scene ends.`, 422);
    }
    cursor = s.endSec;
  }
}
