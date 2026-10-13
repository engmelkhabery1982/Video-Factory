/**
 * Milestone 2 factory service: persisted, revisioned drafts and the derived
 * project apply path. Pure planning and validation live in @buildtrack/core;
 * this file owns I/O, locks, source identity and rollback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  assertTimeline,
  buildFactoryEditorDocument,
  EDITOR_SCHEMA_VERSION,
  FactoryError,
  parseDraftCreate,
  parseDraftPatch,
  planFactoryDraft,
  planFactoryTiming,
  reconcileSelection,
  resolveFactorySpeakers,
  resolveContentBrand,
  type DeriveAssetRef,
  type EditorContentProfile,
  type FactoryDraftCreateInput,
  type FactoryDraftEnvelope,
  type FactoryDraftScene,
  type FactoryMissingItem,
  type FactoryPlanUnit,
  type FactorySpeaker,
  type FactoryTreatment,
  type ProjectInput,
  type Asset,
} from '@buildtrack/core';
import { ASSETS_DIR, DATA_DIR, ensureDirs, OUTPUT_DIR, projectDir } from './platform.js';
import { loadProject, newProject, saveProject } from './store.js';
import { editorAssetRefs, writeEditorState } from './editor-store.js';
import { loadAssetIndex, saveAssetIndex } from '../routes/assets.js';
import {
  configuredVoiceIds,
  FACTORY_SAM_VOICES,
  probeSpeechEngines,
  synthesizeScene,
  type FactorySpeechProbe,
} from './factory-speech.js';

export const DRAFTS_DIR = path.join(DATA_DIR, 'factory', 'drafts');
const DRAFT_ID_RE = /^dft_[a-f0-9]{16}$/;

/** A reuse record. Reuse needs the same key AND the same bytes, duration and library identity. */
interface SpeechCacheEntry {
  key: string;
  assetId: string;
  durationSec: number;
  sha256: string;
}

interface StoredDraft {
  schemaVersion: 1;
  draftId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  contentProfile: EditorContentProfile;
  format: 'landscape' | 'portrait';
  channelBrandId: string | null;
  brief: string;
  /** Source identity: what the draft was built from, by hash or id. */
  source: {
    scriptSha256: string | null;
    storyboardSha256: string | null;
    audioAssetId: string | null;
    audioSha256: string | null;
    audioDurationSec: number | null;
    visualAssetIds: string[];
    referenceProjectId: string | null;
  };
  requestedSpeakers: Array<{ id: string; voiceId: string | null }>;
  units: FactoryPlanUnit[];
  treatments: Array<{ id: string; title: string; rationale: string }>;
  proposals: Record<string, FactoryDraftScene[]>;
  selectedTreatmentId: string | null;
  selection: FactoryDraftScene[];
  speakers: FactorySpeaker[];
  status: 'review_required' | 'blocked';
  missing: FactoryMissingItem[];
  warnings: string[];
  /** Reuse record for generated speech: a changed speaker or text gets a new key. */
  speechCache: Record<string, SpeechCacheEntry>;
  appliedProjects: Array<{ projectId: string; editorRevision: number; timingSource: string; appliedAt: string }>;
}

/**
 * Test seam for the apply path. `onStage` is called at each write boundary so a
 * test can inject a concurrent library change or force a failure. It is null in
 * production and does nothing unless a test sets it.
 */
export const factoryTestHooks: { onStage: ((stage: string) => void) | null } = { onStage: null };

const busy = new Set<string>();
function withLock<T>(draftId: string, fn: () => T): T {
  if (busy.has(draftId)) throw new FactoryError('FACTORY_DRAFT_BUSY', 'Another change to this draft is running. Retry shortly.', 409);
  busy.add(draftId);
  try {
    return fn();
  } finally {
    busy.delete(draftId);
  }
}

const sha256 = (buf: string | Buffer) => createHash('sha256').update(buf).digest('hex');
const nowIso = () => new Date().toISOString();

function draftFile(draftId: string): string {
  return path.join(DRAFTS_DIR, `${draftId}.json`);
}

function loadDraft(draftId: string): StoredDraft {
  if (!DRAFT_ID_RE.test(draftId)) throw new FactoryError('FACTORY_DRAFT_NOT_FOUND', 'Draft not found.', 404);
  const file = draftFile(draftId);
  if (!fs.existsSync(file)) throw new FactoryError('FACTORY_DRAFT_NOT_FOUND', 'Draft not found.', 404);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredDraft;
}

function saveDraft(d: StoredDraft): void {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const file = draftFile(d.draftId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

export function factoryCapabilities() {
  const probe: FactorySpeechProbe = probeSpeechEngines();
  const sam = probe.samAvailable;
  const speechReason = sam
    ? 'Local sam-js English sample voices run here: robotic, synthetic, not natural speech. Arabic speech is unavailable.'
    : 'No runnable speech engine. Supply approved audio; external audio import still works.';
  return {
    version: 1,
    text: {
      available: true,
      mode: 'local_rules' as const,
      reason: 'Local deterministic rules over the supplied words. No text provider is configured, so no semantic AI runs.',
    },
    speech: {
      available: sam,
      reason: speechReason,
      voices: sam ? FACTORY_SAM_VOICES.map((v) => ({ id: v.id, language: v.language, speakerLabel: v.speakerLabel })) : [],
      languages: {
        en: { available: sam, reason: sam ? 'Robotic English sample voices (sam-js). Not natural speech.' : speechReason },
        ar: { available: false, reason: 'No runnable Arabic speech engine. sam-js does not pronounce Arabic.' },
      },
      engines: probe.engines,
    },
    image: { available: false, reason: 'No image generation engine is configured. Scenes use supplied or licensed library images only.' },
    transcription: { available: false, reason: 'No transcription engine is configured. Audio text must be supplied as reviewed text.' },
    storyboardImport: { available: true, reason: 'Inline storyboard version 1 is accepted in POST /api/factory/drafts. No file importer exists.' },
  };
}

/* ------------------------------------------------------------------ */
/* Library facts                                                       */
/* ------------------------------------------------------------------ */

const NON_VISUAL_KINDS = new Set(['logo', 'icon', 'font']);

function libraryRefs(): Map<string, DeriveAssetRef> {
  const index = loadAssetIndex();
  const byId = new Map<string, Asset>(index.map((a) => [a.id, a]));
  const refs = new Map<string, DeriveAssetRef>();
  for (const ref of editorAssetRefs(index as unknown as Array<Record<string, unknown>>)) refs.set(ref.id, ref);
  for (const [id, ref] of refs) {
    const a = byId.get(id);
    if (a && (NON_VISUAL_KINDS.has(a.kind) || /svg/i.test(a.mimeType))) refs.delete(id);
  }
  return refs;
}

function eligibleVisualRefs(): DeriveAssetRef[] {
  return [...libraryRefs().values()].filter((r) => r.kind === 'image' || r.kind === 'video');
}

function assetFileOf(assetId: string): string | null {
  const a = loadAssetIndex().find((x) => x.id === assetId);
  if (!a) return null;
  const abs = path.join(ASSETS_DIR, path.basename(a.path));
  return fs.existsSync(abs) ? abs : null;
}

function invalidAsset(message: string): never {
  throw new FactoryError('FACTORY_ASSET_INVALID', message, 422);
}

function validateVisualIds(ids: string[], label: string): void {
  const eligible = new Set(eligibleVisualRefs().map((r) => r.id));
  for (const id of ids) {
    if (!eligible.has(id)) invalidAsset(`${label} "${id}" is not an active image or video in the library.`);
  }
}

/** Audio must be active, licensed, with a positive duration and real bytes. Returns its sha256. */
function validateAudio(id: string): { sha256: string; durationSec: number } {
  const a = loadAssetIndex().find((x) => x.id === id);
  if (!a || a.status !== 'active' || a.blocked === true || !a.mimeType.toLowerCase().startsWith('audio/')) {
    invalidAsset(`audioAssetId "${id}" is not an active audio asset in the library.`);
  }
  if (!a.source?.trim() || !a.license?.trim()) invalidAsset('The audio asset has no recorded source and licence.');
  const dur = a.durationSec;
  if (typeof dur !== 'number' || !(dur > 0)) invalidAsset('The audio asset has no measured duration.');
  const file = assetFileOf(id);
  if (!file) invalidAsset('The audio asset file is not present in the library.');
  return { sha256: sha256(fs.readFileSync(file)), durationSec: dur };
}

function identityFor(profile: EditorContentProfile, channelBrandId: string | null) {
  const requested = channelBrandId ?? '';
  const resolved = resolveContentBrand({ brandPreset: requested, contentProfile: profile });
  if (resolved.refusedPreset) {
    throw new FactoryError('FACTORY_IDENTITY_REFUSED', resolved.refusal ?? 'The requested channel identity was refused for this content profile.', 422);
  }
  return {
    channelBrandId: requested && resolved.identityBound ? requested : null,
    refusal: resolved.refusal,
  };
}

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

/** Supplied speech fixes the order: a recording or supplied scene times. Derived from the draft, so old drafts agree. */
function speechOrderLockedOf(d: StoredDraft): boolean {
  return d.source.audioAssetId !== null || d.units.some((u) => u.startSec !== null && u.endSec !== null);
}

function envelopeOf(d: StoredDraft): FactoryDraftEnvelope {
  const treatments: FactoryTreatment[] = d.treatments.map((t) => {
    const scenes = t.id === d.selectedTreatmentId ? d.selection : (d.proposals[t.id] ?? []);
    return { id: t.id, title: t.title, rationale: t.rationale, orderLocked: speechOrderLockedOf(d), structure: scenes.map((s) => s.beat), scenes };
  });
  return {
    draftId: d.draftId,
    revision: d.revision,
    status: d.status,
    generationMode: 'local_rules',
    speechOrderLocked: speechOrderLockedOf(d),
    selectedTreatmentId: d.selectedTreatmentId,
    treatments,
    speakers: d.speakers,
    missing: d.missing,
    warnings: d.warnings,
  };
}

/** Recompute missing items for the current selection with the same rules as planning. */
function missingFor(d: StoredDraft, probe: FactorySpeechProbe): FactoryMissingItem[] {
  const missing: FactoryMissingItem[] = [];
  if (d.units.length === 0) {
    missing.push(d.source.audioAssetId && d.source.scriptSha256 === null
      ? { kind: 'transcription', sceneId: null, reason: 'The audio text is unknown and no transcription engine is configured. Supply the reviewed script or storyboard.' }
      : { kind: 'script', sceneId: null, reason: 'Supply a reviewed script or a storyboard.' });
    return missing;
  }
  const audioPresent = d.source.audioAssetId !== null;
  for (const s of d.selection) {
    if (!s.assetId) missing.push({ kind: 'image', sceneId: s.id, reason: 'No supplied or licensed library image is assigned to this scene. No image engine is configured.' });
    if (!audioPresent) {
      const speaks = s.language === 'en' ? probe.samAvailable : false;
      if (!speaks) {
        const lang = s.language === 'ar' ? 'Arabic' : s.language === 'en' ? 'English' : 'an undetected language';
        missing.push({ kind: 'speech', sceneId: s.id, reason: `No runnable speech engine for ${lang}. Supply the approved audio, or configure a voice for this language.` });
      }
    }
  }
  return missing;
}

function refreshStatus(d: StoredDraft): void {
  const probe = probeSpeechEngines();
  d.missing = missingFor(d, probe);
  d.status = d.missing.length === 0 && d.selection.length > 0 ? 'review_required' : 'blocked';
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

export function createDraft(body: unknown): { status: 201; body: FactoryDraftEnvelope } {
  const input: FactoryDraftCreateInput = parseDraftCreate(body);
  const identity = identityFor(input.contentProfile, input.channelBrandId);
  const storyboardAssetIds = (input.inputs.storyboard?.scenes ?? []).map((s) => s.assetId).filter((x): x is string => !!x);
  const visualIds = [...new Set([...input.inputs.visualAssetIds, ...storyboardAssetIds])];
  validateVisualIds(visualIds, 'visualAssetIds');
  const audio = input.inputs.audioAssetId ? validateAudio(input.inputs.audioAssetId) : null;
  let referenceProjectId: string | null = null;
  if (input.referenceProjectId) {
    if (!loadProject(input.referenceProjectId)) {
      throw new FactoryError('FACTORY_REFERENCE_NOT_FOUND', 'referenceProjectId does not name an existing project.', 422);
    }
    referenceProjectId = input.referenceProjectId;
  }
  const probe = probeSpeechEngines();
  const plan = planFactoryDraft(input, {
    capabilities: {
      speechLanguages: { en: probe.samAvailable, ar: false },
      transcriptionAvailable: false,
      voiceIds: configuredVoiceIds(probe),
    },
    libraryVisuals: eligibleVisualRefs().map((r) => ({ id: r.id, kind: r.kind as 'image' | 'video' })),
    suppliedVisualIds: visualIds,
    audioPresent: audio !== null,
  });
  const warnings = [...plan.warnings];
  if (plan.units.length === 0) warnings.push('A brief alone cannot become scenes. Supply reviewed script text or a storyboard. No text is generated here.');
  if (identity.refusal) warnings.push(identity.refusal);
  const selection = plan.treatments.find((t) => t.id === plan.selectedTreatmentId)?.scenes ?? [];
  const d: StoredDraft = {
    schemaVersion: 1,
    draftId: `dft_${randomBytes(8).toString('hex')}`,
    revision: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    contentProfile: input.contentProfile,
    format: input.format,
    channelBrandId: identity.channelBrandId,
    brief: input.inputs.brief,
    source: {
      scriptSha256: input.inputs.script ? sha256(input.inputs.script) : null,
      storyboardSha256: input.inputs.storyboard ? sha256(JSON.stringify(input.inputs.storyboard)) : null,
      audioAssetId: input.inputs.audioAssetId,
      audioSha256: audio?.sha256 ?? null,
      audioDurationSec: audio?.durationSec ?? null,
      visualAssetIds: visualIds,
      referenceProjectId,
    },
    requestedSpeakers: input.requestedSpeakers,
    units: plan.units,
    treatments: plan.treatments.map((t) => ({ id: t.id, title: t.title, rationale: t.rationale })),
    proposals: Object.fromEntries(plan.treatments.map((t) => [t.id, t.scenes])),
    selectedTreatmentId: plan.selectedTreatmentId,
    selection,
    speakers: plan.speakers,
    status: plan.status,
    missing: plan.missing,
    warnings,
    speechCache: {},
    appliedProjects: [],
  };
  refreshStatus(d);
  saveDraft(d);
  return { status: 201, body: envelopeOf(d) };
}

/* ------------------------------------------------------------------ */
/* Read and patch                                                      */
/* ------------------------------------------------------------------ */

export function getDraft(draftId: string): FactoryDraftEnvelope {
  return envelopeOf(loadDraft(draftId));
}

export function patchDraft(draftId: string, body: unknown): FactoryDraftEnvelope {
  const patch = parseDraftPatch(body);
  return withLock(draftId, () => {
    const d = loadDraft(draftId);
    if (patch.expectedRevision !== d.revision) {
      throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload and apply your edit again.', 409, { currentRevision: d.revision });
    }
    if (d.units.length === 0) {
      throw new FactoryError('FACTORY_INPUTS_REQUIRED', 'The draft has no narration units yet. Supply a script or storyboard first.', 422, { missing: d.missing });
    }
    const sourceNarration = new Map(d.units.map((u) => [u.id, u.narration]));
    const eligible = new Set(eligibleVisualRefs().map((r) => r.id));
    const selection = reconcileSelection({
      currentTreatmentId: d.selectedTreatmentId,
      currentScenes: d.selection,
      proposals: d.proposals,
      sourceNarration,
      assetAllowed: (id) => eligible.has(id),
      speakerAllowed: () => true,
      orderLocked: speechOrderLockedOf(d),
      incomingTreatmentId: patch.selectedTreatmentId,
      incomingScenes: patch.scenes,
    });
    assertTimeline(selection);
    const probe = probeSpeechEngines();
    const speakerIds: string[] = [];
    for (const s of selection) if (s.speakerId && !speakerIds.includes(s.speakerId)) speakerIds.push(s.speakerId);
    for (const r of patch.speakers) if (!speakerIds.includes(r.id)) speakerIds.push(r.id);
    const { speakers } = resolveFactorySpeakers(
      speakerIds,
      patch.speakers,
      configuredVoiceIds(probe),
      probe.samAvailable,
    );
    d.selectedTreatmentId = patch.selectedTreatmentId;
    d.selection = selection;
    d.speakers = speakers;
    d.revision += 1;
    d.updatedAt = nowIso();
    refreshStatus(d);
    saveDraft(d);
    return envelopeOf(d);
  });
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

export interface ApplyResult {
  status: 201;
  body: {
    projectId: string;
    targetId: 'long';
    format: 'landscape' | 'portrait';
    editorRevision: number;
    timingSource: string;
    speechGenerated: number;
  };
}

export async function applyDraft(draftId: string, body: unknown): Promise<ApplyResult> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  }
  const expected = (body as Record<string, unknown>).expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }
  if (busy.has(draftId)) throw new FactoryError('FACTORY_DRAFT_BUSY', 'Another change to this draft is running. Retry shortly.', 409);
  busy.add(draftId);
  try {
    return await applyLocked(draftId, expected);
  } finally {
    busy.delete(draftId);
  }
}

/** Duration of a PCM WAV from its header and data chunk. Null when the bytes are not a readable WAV. */
export function wavDurationSec(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      rate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      if (!rate || !channels || !bits) return null;
      const available = Math.min(size, buf.length - offset - 8);
      return available / (rate * channels * (bits / 8));
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * Reuse a cached scene speech only when the library still holds the same, active,
 * generated asset, the file bytes hash to the recorded value, and the bytes measure
 * the recorded duration. Anything else returns null and the scene is synthesized again.
 */
function reusableSpeech(cached: SpeechCacheEntry | undefined, key: string, index: Asset[], refs: Map<string, DeriveAssetRef>): DeriveAssetRef | null {
  if (!cached || cached.key !== key || !cached.sha256) return null;
  const asset = index.find((a) => a.id === cached.assetId);
  if (!asset || asset.status !== 'active' || asset.blocked === true || asset.mimeType !== 'audio/wav') return null;
  if (!asset.tags?.includes('generated-speech')) return null;
  if (typeof asset.durationSec !== 'number' || Math.abs(asset.durationSec - cached.durationSec) > 0.0005) return null;
  const ref = refs.get(cached.assetId);
  const file = assetFileOf(cached.assetId);
  if (!ref || !file) return null;
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== cached.sha256) return null;
  const measured = wavDurationSec(bytes);
  if (measured === null || Math.abs(measured - cached.durationSec) > 0.01) return null;
  return ref;
}

async function applyLocked(draftId: string, expected: number): Promise<ApplyResult> {
  const d = loadDraft(draftId);
  if (expected !== d.revision) {
    throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload and apply again.', 409, { currentRevision: d.revision });
  }
  refreshStatus(d);
  if (d.status !== 'review_required' || d.missing.length > 0) {
    throw new FactoryError('FACTORY_INPUTS_REQUIRED', 'Required inputs are unresolved. Nothing was applied.', 422, { missing: d.missing });
  }

  // Everything below is checked before any synthesis or write.
  const scenes = d.selection;
  const refs = libraryRefs();
  for (const s of scenes) {
    if (!s.assetId || !refs.has(s.assetId) || !eligibleVisualRefs().some((r) => r.id === s.assetId)) {
      invalidAsset(`scene "${s.id}" no longer references an active image or video.`);
    }
  }
  let audio: { sha256: string; durationSec: number } | null = null;
  if (d.source.audioAssetId) audio = validateAudio(d.source.audioAssetId);
  if (!audio && scenes.some((s) => s.timingSource === 'supplied')) {
    throw new FactoryError('FACTORY_INPUTS_REQUIRED', 'Supplied scene times cannot be kept while speech is generated per scene. Supply the approved audio, or clear the scene times.', 422, {
      missing: [{ kind: 'timing', sceneId: null, reason: 'Approved scene times need approved full audio.' }],
    });
  }
  if (d.source.referenceProjectId && !loadProject(d.source.referenceProjectId)) {
    throw new FactoryError('FACTORY_REFERENCE_NOT_FOUND', 'The reference project no longer exists. Nothing was applied.', 422);
  }
  const probe = probeSpeechEngines();
  const voiceOf = new Map(d.speakers.map((s) => [s.id, s.voiceId]));
  if (!audio) {
    if (!probe.samAvailable) {
      throw new FactoryError('FACTORY_INPUTS_REQUIRED', 'No speech engine runs here. Supply the approved audio.', 422, {
        missing: scenes.map((s) => ({ kind: 'speech' as const, sceneId: s.id, reason: 'No runnable speech engine. Supply the approved audio.' })),
      });
    }
    for (const s of scenes) {
      const voiceId = s.speakerId ? voiceOf.get(s.speakerId) ?? null : null;
      if (!voiceId || !configuredVoiceIds(probe).includes(voiceId)) {
        throw new FactoryError('FACTORY_INPUTS_REQUIRED', `scene "${s.id}" has no configured voice.`, 422, {
          missing: [{ kind: 'speaker', sceneId: s.id, reason: 'The speaker has no configured voice.' }],
        });
      }
    }
  }

  const derivedId = `Factory_${randomBytes(6).toString('hex')}`;
  const createdFiles: string[] = [];
  const newAssets: Asset[] = [];
  const newCache: StoredDraft['speechCache'] = {};
  const newShaByAsset = new Map<string, string>();
  let projectCreated = false;
  let indexAdded = false;
  const stage = (name: string) => factoryTestHooks.onStage?.(name);
  try {
    // 1. Speech for scenes without supplied audio. A cached clip is reused only when verified.
    let measured: Record<string, number> | null = null;
    const speechRefOf = new Map<string, DeriveAssetRef>();
    if (!audio) {
      measured = {};
      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i];
        const voiceId = voiceOf.get(s.speakerId as string) as string;
        const key = sha256(`${voiceId}\n${s.narration}`);
        const reused = reusableSpeech(d.speechCache[s.id], key, loadAssetIndex(), refs);
        if (reused && d.speechCache[s.id]) {
          measured[s.id] = d.speechCache[s.id].durationSec;
          newCache[s.id] = d.speechCache[s.id];
          speechRefOf.set(s.id, reused);
          continue;
        }
        const assetId = `factory-speech-${randomBytes(6).toString('hex')}`;
        const fileName = `${assetId}.wav`;
        const abs = path.join(ASSETS_DIR, fileName);
        ensureDirs();
        const out = await synthesizeScene({ absTarget: abs, text: s.narration, voiceId, sceneId: s.id, sceneIndex: i });
        createdFiles.push(abs);
        const bytes = fs.readFileSync(abs);
        const fileSha = sha256(bytes);
        const voiceLabel = FACTORY_SAM_VOICES.find((v) => v.id === voiceId)?.speakerLabel ?? voiceId;
        newAssets.push({
          id: assetId,
          name: `Generated speech: ${s.id} (${voiceLabel})`,
          kind: 'sfx',
          fileName,
          path: fileName,
          mimeType: 'audio/wav',
          sizeBytes: out.bytes,
          durationSec: out.durationSec,
          tags: ['factory', 'generated-speech', 'unapproved'],
          status: 'active',
          preferred: false,
          source: 'Generated locally by sam-js: robotic English sample voice, not natural speech. Generated from reviewed narration.',
          license: 'Generated locally from project-owned reviewed text; no third-party voice or model',
          addedAt: nowIso(),
          usedIn: [],
          blocked: false,
        });
        measured[s.id] = out.durationSec;
        newCache[s.id] = { key, assetId, durationSec: out.durationSec, sha256: fileSha };
        newShaByAsset.set(assetId, fileSha);
        speechRefOf.set(s.id, {
          id: assetId,
          kind: 'audio',
          name: `Generated speech: ${s.id}`,
          mediaUrl: `/media/asset/${assetId}`,
          durationSec: out.durationSec,
          source: 'Generated locally by sam-js: robotic English sample voice, not natural speech. Generated from reviewed narration.',
          license: 'Generated locally from project-owned reviewed text; no third-party voice or model',
          sha256: fileSha,
          mimeType: 'audio/wav',
        });
      }
    }
    stage('after-speech');

    // 2. Timing. Measured synthesis or supplied audio; nothing else.
    const timing = planFactoryTiming({
      units: scenes.map((s) => ({ id: s.id, narration: s.narration, startSec: s.startSec, endSec: s.endSec })),
      measuredDurationsSec: measured,
      totalDurationSec: audio ? audio.durationSec : null,
    });
    const durationOf = new Map(timing.items.map((t) => [t.id, t]));

    // 3. Editor document through the canonical builder. Format follows the draft.
    const fullRef = audio ? refs.get(d.source.audioAssetId as string) : undefined;
    if (audio && !fullRef) invalidAsset('The audio asset is not eligible for the editor.');
    const doc = buildFactoryEditorDocument({
      projectId: derivedId,
      contentProfile: d.contentProfile,
      channelBrandId: d.channelBrandId,
      format: d.format,
      scenes: scenes.map((s) => {
        const t = durationOf.get(s.id);
        if (!t) throw new FactoryError('FACTORY_VALIDATION', `scene "${s.id}" has no timing.`, 422);
        const visual = refs.get(s.assetId as string);
        if (!visual) invalidAsset(`scene "${s.id}" visual is not eligible.`);
        return {
          id: s.id,
          narration: s.narration,
          language: s.language,
          speakerId: s.speakerId,
          locked: s.locked,
          visual: visual as DeriveAssetRef,
          visualDecision: s.visualDecision,
          startSec: t.startSec,
          durationSec: t.durationSec,
          audio: audio ? null : speechRefOf.get(s.id) ?? null,
        };
      }),
      fullAudio: audio && fullRef ? { ref: fullRef, durationSec: audio.durationSec, sha256: audio.sha256 } : null,
    });

    // 4. Writes, in order: project, editor state, provenance, library (targeted add), draft record.
    const outputLanguage = scenes.filter((s) => s.language === 'ar').length >= scenes.length / 2 ? 'ar' : 'en';
    const input = {
      videoId: derivedId,
      videoType: 'long',
      topic: d.brief.trim().split(/\r?\n/)[0].slice(0, 160) || scenes[0].narration.slice(0, 160),
      targetAudience: '',
      mainProblem: '',
      viewerPromise: '',
      hook: '',
      script: scenes.map((s) => s.narration).join('\n'),
      keyNumbers: [],
      keyPoints: [],
      productName: '',
      productShots: [],
      cta: '',
      voiceoverFile: null,
      brollFiles: [],
      sourceReferences: d.source.referenceProjectId ? [d.source.referenceProjectId] : [],
      outputLanguage,
      brandPreset: d.channelBrandId ?? '',
      contentProfile: d.contentProfile,
    } as unknown as ProjectInput;
    stage('before-project');
    saveProject(newProject(input));
    projectCreated = true;
    stage('after-project');
    writeEditorState(derivedId, 'long', { schemaVersion: EDITOR_SCHEMA_VERSION, document: doc, undo: [], redo: [] });
    stage('after-editor');
    fs.writeFileSync(
      path.join(projectDir(derivedId), 'factory-provenance.json'),
      JSON.stringify({
        schemaVersion: 1,
        draftId: d.draftId,
        draftRevision: d.revision,
        format: d.format,
        contentProfile: d.contentProfile,
        referenceProjectId: d.source.referenceProjectId,
        source: d.source,
        timingSource: timing.timingSource,
        speechPolicy: audio ? 'supplied_full_audio' : 'generated_per_scene_unapproved',
        generatedAssets: newAssets.map((a) => ({ id: a.id, durationSec: a.durationSec, sha256: newShaByAsset.get(a.id) ?? null })),
        visualDecisions: scenes.map((s) => ({ sceneId: s.id, ...s.visualDecision })),
        createdAt: nowIso(),
      }, null, 2),
      'utf8',
    );
    stage('after-provenance');
    stage('before-index');
    if (newAssets.length > 0) {
      // Targeted add on the current index, never a restore of an earlier snapshot.
      saveAssetIndex([...loadAssetIndex(), ...newAssets]);
      indexAdded = true;
    }
    stage('after-index');
    const nextDraft: StoredDraft = {
      ...d,
      speechCache: { ...d.speechCache, ...newCache },
      appliedProjects: [...d.appliedProjects, { projectId: derivedId, editorRevision: doc.revision, timingSource: timing.timingSource, appliedAt: nowIso() }],
      updatedAt: nowIso(),
    };
    stage('before-draft');
    saveDraft(nextDraft);
    return {
      status: 201,
      body: {
        projectId: derivedId,
        targetId: 'long',
        format: d.format,
        editorRevision: doc.revision,
        timingSource: timing.timingSource,
        speechGenerated: newAssets.length,
      },
    };
  } catch (err) {
    // Roll back only what this apply created. The library index is edited by id, never restored from a snapshot.
    if (projectCreated) {
      fs.rmSync(projectDir(derivedId), { recursive: true, force: true });
      fs.rmSync(path.join(OUTPUT_DIR, derivedId), { recursive: true, force: true });
    }
    for (const f of createdFiles) fs.rmSync(f, { force: true });
    if (indexAdded) {
      const ids = new Set(newAssets.map((a) => a.id));
      saveAssetIndex(loadAssetIndex().filter((a) => !ids.has(a.id)));
    }
    throw err;
  }
}
