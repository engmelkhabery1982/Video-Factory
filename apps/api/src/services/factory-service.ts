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
  predictFactoryTiming,
  reconcileSelection,
  timingSourceLabel,
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
import { GEMINI_PREBUILT_VOICES, type GeneratedPlan, type PlanSourceNote } from '@buildtrack/core';
import { geminiDeps, speechProductionReady, synthesizeProductionTurn } from './gemini-service.js';
import { lookupTurn, saveTurn } from './factory-turn-store.js';
import { loadProject, newProject, saveProject } from './store.js';
import { editorAssetRefs, readEditorState, writeEditorState } from './editor-store.js';
import { timingBoundariesSha256, timingStatusFor } from './factory-timing-store.js';
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
  /** Gemini clips record model, voice, language, style and text identity. Absent for local sam-js clips. */
  provenance?: { provider: 'gemini'; model: string; voice: string; language: string; style: string; textSha256: string };
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
    /** Set when the draft was converted from a Gemini plan job. */
    generatedJobId?: string | null;
    generatedPlanSha256?: string | null;
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
  appliedProjects: Array<{ projectId: string; editorRevision: number; timingSource: string; appliedAt: string; draftRevision?: number }>;
  /** Internal reuse records: one per successful fresh apply. Never sent to clients. */
  successfulApplies?: SuccessfulApply[];
}

/** A source the apply depended on, by identity and hash. Reuse re-checks each one. */
interface SourceRecord {
  kind: 'audio' | 'image';
  assetId: string;
  sha256: string;
}

interface SuccessfulApply {
  projectId: string;
  draftRevision: number;
  editorRevision: number;
  timingSource: string;
  appliedAt: string;
  sources: SourceRecord[];
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
    generationMode: d.source.generatedJobId ? 'gemini_plan' : 'local_rules',
    speechOrderLocked: speechOrderLockedOf(d),
    selectedTreatmentId: d.selectedTreatmentId,
    treatments,
    speakers: d.speakers,
    missing: d.missing,
    warnings: d.warnings,
    appliedProjects: d.appliedProjects,
    timingPlan: predictFactoryTiming({
      hasAudio: d.source.audioAssetId !== null,
      allScenesTimed: d.selection.length > 0 && d.selection.every((s) => s.startSec !== null && s.endSec !== null),
    }),
    profile: { contentProfile: d.contentProfile, format: d.format, channelBrandId: d.channelBrandId },
    inputs: {
      audioAssetId: d.source.audioAssetId,
      audioDurationSec: d.source.audioDurationSec,
      visualAssetIds: d.source.visualAssetIds,
      scriptSupplied: d.source.scriptSha256 !== null,
      storyboardSupplied: d.source.storyboardSha256 !== null,
    },
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
  const speakerOf = new Map(d.speakers.map((sp) => [sp.id, sp]));
  for (const s of d.selection) {
    if (!s.assetId) missing.push({ kind: 'image', sceneId: s.id, reason: 'No supplied or licensed library image is assigned to this scene. No image engine is configured.' });
    if (!audioPresent) {
      const speaker = s.speakerId ? speakerOf.get(s.speakerId) : undefined;
      if (speaker?.provider === 'gemini') {
        const lang = s.language === 'ar' ? 'ar' : 'en';
        const ready = speechProductionReady(geminiDeps(), lang);
        if (!ready.ready) missing.push({ kind: 'speech', sceneId: s.id, reason: ready.reason });
        continue;
      }
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
    let speakers: FactorySpeaker[];
    if (d.source.generatedJobId) {
      // Generated drafts keep their Gemini voices and styles. Change them through PATCH /generated.
      speakers = d.speakers;
    } else {
      const speakerIds: string[] = [];
      for (const s of selection) if (s.speakerId && !speakerIds.includes(s.speakerId)) speakerIds.push(s.speakerId);
      for (const r of patch.speakers) if (!speakerIds.includes(r.id)) speakerIds.push(r.id);
      ({ speakers } = resolveFactorySpeakers(speakerIds, patch.speakers, configuredVoiceIds(probe), probe.samAvailable));
    }
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
  /** 201 for a fresh apply, 200 when an existing application for this draft revision is returned. */
  status: 200 | 201;
  body: {
    projectId: string;
    targetId: 'long';
    format: 'landscape' | 'portrait';
    editorRevision: number;
    timingSource: string;
    timingLabel: string;
    speechGenerated: number;
    reused: boolean;
  };
}

/**
 * Applies are serialized per draft with a promise chain, so identical concurrent
 * requests run one after another. The second one finds the first one's record and
 * returns it instead of creating another project. PATCH keeps its own busy check.
 */
const applyQueues = new Map<string, Promise<void>>();

export async function applyDraft(draftId: string, body: unknown): Promise<ApplyResult> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  }
  const expected = (body as Record<string, unknown>).expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }
  const confirmRaw = (body as Record<string, unknown>).confirmSpeechCalls;
  if (confirmRaw !== undefined && (typeof confirmRaw !== 'number' || !Number.isInteger(confirmRaw) || confirmRaw < 0)) {
    throw new FactoryError('FACTORY_VALIDATION', 'confirmSpeechCalls must be a non-negative integer when given.', 422);
  }
  const confirmSpeechCalls = typeof confirmRaw === 'number' ? confirmRaw : null;
  const run = async (): Promise<ApplyResult> => {
    if (busy.has(draftId)) throw new FactoryError('FACTORY_DRAFT_BUSY', 'Another change to this draft is running. Retry shortly.', 409);
    busy.add(draftId);
    try {
      return await applyLocked(draftId, expected, confirmSpeechCalls);
    } finally {
      busy.delete(draftId);
    }
  };
  const current = (applyQueues.get(draftId) ?? Promise.resolve()).then(run);
  const settled = current.then(() => undefined, () => undefined);
  applyQueues.set(draftId, settled);
  void settled.then(() => {
    if (applyQueues.get(draftId) === settled) applyQueues.delete(draftId);
  });
  return current;
}

/**
 * Read-only preview of an apply. Writes nothing and calls no provider. It reports the
 * Gemini speech calls the next apply would make, the remaining production budget, and the
 * blockers that would stop it. The count it reports is the count the apply checks against.
 */
export interface ApplyPreview {
  draftId: string;
  revision: number;
  canApply: boolean;
  /** True when this revision was already applied and the apply would return that project. */
  reused: boolean;
  blockers: FactoryMissingItem[];
  speechCalls: number;
  sceneIds: string[];
  budget: { cap: number; used: number; remaining: number };
}

export function applyPreview(draftId: string): ApplyPreview {
  const d = loadDraft(draftId);
  const gemini = geminiDeps();
  const cap = gemini.cfg.budget.productionTurns ?? 0;
  const used = gemini.store.usage(gemini.cfg.sessionId).production;
  const budget = { cap, used, remaining: gemini.store.productionRemaining(gemini.cfg.sessionId, gemini.cfg.budget) };
  const base = { draftId, revision: d.revision, budget };
  if (reusableApply(d)) return { ...base, canApply: true, reused: true, blockers: [], speechCalls: 0, sceneIds: [] };
  refreshStatus(d);
  const blockers: FactoryMissingItem[] = [...d.missing];
  if (d.status !== 'review_required' && blockers.length === 0) {
    blockers.push({ kind: 'asset', sceneId: null, reason: 'The draft is not ready to apply.' });
  }
  const refs = libraryRefs();
  const index = loadAssetIndex();
  const sceneIds: string[] = [];
  for (const s of d.selection) {
    if (!s.assetId || !refs.has(s.assetId)) {
      blockers.push({ kind: 'asset', sceneId: s.id, reason: 'This scene has no eligible image or video yet.' });
    }
    const speaker = d.speakers.find((sp) => sp.id === s.speakerId);
    if (speaker?.provider !== 'gemini') continue;
    const lang = s.language === 'ar' ? 'ar' : 'en';
    const ready = speechProductionReady(gemini, lang);
    if (!ready.ready) {
      blockers.push({ kind: 'speech', sceneId: s.id, reason: ready.reason });
      continue;
    }
    if (!(GEMINI_PREBUILT_VOICES as readonly string[]).includes(speaker.voiceId ?? '')) {
      blockers.push({ kind: 'speaker', sceneId: s.id, reason: 'The speaker has no prebuilt Gemini voice.' });
      continue;
    }
    const key = geminiClipKey(gemini.cfg.ttsModel, speaker, s);
    if (!reusableSpeech(d.speechCache[s.sourceUnitId], key, index, refs) && !lookupTurn(key)) sceneIds.push(s.id);
  }
  const speechCalls = sceneIds.length;
  if (speechCalls > budget.remaining) {
    blockers.push({ kind: 'speech', sceneId: null, reason: `This apply needs ${speechCalls} speech turns but only ${budget.remaining} remain in this session's budget.` });
  }
  return { ...base, canApply: blockers.length === 0, reused: false, blockers, speechCalls, sceneIds };
}

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/** Recheck each recorded source: present, active, not blocked, same bytes. Empty when all hold. */
function sourceProblems(sources: SourceRecord[]): FactoryMissingItem[] {
  const byId = new Map(loadAssetIndex().map((a) => [a.id, a]));
  const problems: FactoryMissingItem[] = [];
  for (const src of sources) {
    const kind = src.kind === 'audio' ? 'asset' : 'image';
    const asset = byId.get(src.assetId);
    if (!asset) {
      problems.push({ kind, sceneId: null, reason: `${src.assetId} is no longer in the library.` });
      continue;
    }
    if (asset.status !== 'active' || asset.blocked === true) {
      problems.push({ kind, sceneId: null, reason: `${asset.name} is blocked or inactive.` });
      continue;
    }
    const file = assetFileOf(src.assetId);
    if (!file) {
      problems.push({ kind, sceneId: null, reason: `${asset.name} is missing from the library files.` });
      continue;
    }
    if (sha256(fs.readFileSync(file)) !== src.sha256) {
      problems.push({ kind, sceneId: null, reason: `${asset.name} changed since it was applied.` });
    }
  }
  return problems;
}

/**
 * Reuse for this draft revision. Newest record first; a record whose project or
 * editor state is gone is skipped, so a fresh apply can run. A changed, blocked
 * or missing source refuses explicitly and never falls through to a new project.
 */
function reusableApply(d: StoredDraft): ApplyResult | null {
  const records = (d.successfulApplies ?? []).filter((r) => r.draftRevision === d.revision);
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (!PROJECT_ID_RE.test(rec.projectId)) continue;
    const project = loadProject(rec.projectId);
    const state = project ? readEditorState(rec.projectId, 'long') : null;
    if (!project || !state) continue;
    if (d.source.referenceProjectId && !loadProject(d.source.referenceProjectId)) {
      throw new FactoryError('FACTORY_REFERENCE_NOT_FOUND', 'The reference project no longer exists. Nothing was reused.', 422);
    }
    const problems = sourceProblems(rec.sources);
    if (problems.length > 0) {
      throw new FactoryError(
        'FACTORY_SOURCE_CHANGED',
        'A source for this draft changed, was blocked, or is missing. Nothing was reused or written. Edit the draft to apply again.',
        409,
        { missing: problems },
      );
    }
    return {
      status: 200,
      body: {
        projectId: rec.projectId,
        targetId: 'long',
        format: d.format,
        editorRevision: state.document.revision,
        timingSource: rec.timingSource,
        timingLabel: timingSourceLabel(rec.timingSource),
        speechGenerated: 0,
        reused: true,
      },
    };
  }
  return null;
}

/** Timing status for a project's long editor target, from its provenance and current document. */
export function projectTiming(projectId: string) {
  if (!PROJECT_ID_RE.test(projectId) || !loadProject(projectId)) {
    throw new FactoryError('FACTORY_PROJECT_NOT_FOUND', 'Project not found.', 404);
  }
  const state = readEditorState(projectId, 'long');
  const status = timingStatusFor(projectId, state?.document ?? null);
  return { projectId, editorRevision: state?.document.revision ?? null, ...status };
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

async function applyLocked(draftId: string, expected: number, confirmSpeechCalls: number | null): Promise<ApplyResult> {
  const d = loadDraft(draftId);
  if (expected !== d.revision) {
    throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload and apply again.', 409, { currentRevision: d.revision });
  }
  // Same draft revision already applied with sources verified: return that project. Nothing is written.
  const reused = reusableApply(d);
  if (reused) return reused;
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
  const speakerById = new Map(d.speakers.map((s) => [s.id, s]));
  const gemini = geminiDeps();
  // Every Gemini cost and gate is decided here, before the first provider call. Nothing is called below this line.
  const plannedGemini: string[] = [];
  if (!audio) {
    const samScenes = scenes.filter((s) => speakerById.get(s.speakerId ?? '')?.provider !== 'gemini');
    if (samScenes.length > 0 && !probe.samAvailable) {
      throw new FactoryError('FACTORY_INPUTS_REQUIRED', 'No local speech engine runs here. Supply the approved audio, or use a Gemini voice.', 422, {
        missing: samScenes.map((s) => ({ kind: 'speech' as const, sceneId: s.id, reason: 'No runnable speech engine. Supply the approved audio.' })),
      });
    }
    for (const s of scenes) {
      const speaker = speakerById.get(s.speakerId ?? '');
      if (speaker?.provider === 'gemini') {
        const voice = speaker.voiceId ?? '';
        if (!(GEMINI_PREBUILT_VOICES as readonly string[]).includes(voice)) {
          throw new FactoryError('FACTORY_INPUTS_REQUIRED', `scene "${s.id}" has no prebuilt Gemini voice.`, 422, {
            missing: [{ kind: 'speaker', sceneId: s.id, reason: 'The speaker has no prebuilt Gemini voice.' }],
          });
        }
        const lang = s.language === 'ar' ? 'ar' : 'en';
        const ready = speechProductionReady(gemini, lang);
        if (!ready.ready) {
          throw new FactoryError('FACTORY_INPUTS_REQUIRED', `Gemini speech is not ready for ${lang === 'ar' ? 'Arabic' : 'English'}. Nothing was called.`, 422, {
            missing: [{ kind: 'speech', sceneId: s.id, reason: ready.reason }],
          });
        }
        const key = geminiClipKey(gemini.cfg.ttsModel, speaker, s);
        // A turn is already paid for when the durable turn store holds it verified. Those are not planned again.
        if (!reusableSpeech(d.speechCache[s.sourceUnitId], key, loadAssetIndex(), libraryRefs()) && !lookupTurn(key)) plannedGemini.push(s.id);
      } else {
        const voiceId = s.speakerId ? voiceOf.get(s.speakerId) ?? null : null;
        if (!voiceId || !configuredVoiceIds(probe).includes(voiceId)) {
          throw new FactoryError('FACTORY_INPUTS_REQUIRED', `scene "${s.id}" has no configured voice.`, 422, {
            missing: [{ kind: 'speaker', sceneId: s.id, reason: 'The speaker has no configured voice.' }],
          });
        }
      }
    }
    if (plannedGemini.length > 0) {
      const n = plannedGemini.length;
      if (confirmSpeechCalls !== n) {
        throw new FactoryError(
          'FACTORY_INPUTS_REQUIRED',
          `This apply needs ${n} Gemini speech ${n === 1 ? 'call' : 'calls'} (one per changed turn). Confirm the count with confirmSpeechCalls to continue. Nothing was called.`,
          422,
          { details: { speechCalls: n, sceneIds: plannedGemini, remaining: gemini.store.productionRemaining(gemini.cfg.sessionId, gemini.cfg.budget) } },
        );
      }
      const remaining = gemini.store.productionRemaining(gemini.cfg.sessionId, gemini.cfg.budget);
      if (n > remaining) {
        throw new FactoryError(
          'FACTORY_BUDGET_EXHAUSTED',
          `This apply needs ${n} production speech turns but only ${remaining} remain in this session's budget. Nothing was called. Apply fewer changed turns in a later session, or raise GEMINI_PRODUCTION_TURNS deliberately.`,
          429,
          { details: { speechCalls: n, remaining } },
        );
      }
    }
  }

  // Source identities for reuse: each library file the apply reads, by hash. Read only; nothing written yet.
  const sourceByAsset = new Map<string, SourceRecord>();
  for (const s of scenes) {
    if (sourceByAsset.has(s.assetId as string)) continue;
    const file = assetFileOf(s.assetId as string);
    if (!file) invalidAsset(`scene "${s.id}" visual is not present in the library.`);
    sourceByAsset.set(s.assetId as string, { kind: 'image', assetId: s.assetId as string, sha256: sha256(fs.readFileSync(file)) });
  }
  if (audio && d.source.audioAssetId) {
    sourceByAsset.set(d.source.audioAssetId, { kind: 'audio', assetId: d.source.audioAssetId, sha256: audio.sha256 });
  }
  const sourceRecords = [...sourceByAsset.values()];

  const derivedId = `Factory_${randomBytes(6).toString('hex')}`;
  const appliedAt = nowIso();
  const createdFiles: string[] = [];
  const newAssets: Asset[] = [];
  const newCache: StoredDraft['speechCache'] = {};
  const newShaByAsset = new Map<string, string>();
  let projectCreated = false;
  let indexAdded = false;
  const stage = (name: string) => factoryTestHooks.onStage?.(name);
  try {
    // 1. Speech for scenes without supplied audio. A cached clip is reused only when verified.
    //    Cache identity is the source unit, so switching treatments reuses unchanged clips.
    let measured: Record<string, number> | null = null;
    const speechRefOf = new Map<string, DeriveAssetRef>();
    if (!audio) {
      measured = {};
      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i];
        const unitKey = s.sourceUnitId;
        const speaker = speakerById.get(s.speakerId ?? '');
        if (speaker?.provider === 'gemini') {
          const lang = s.language === 'ar' ? 'ar' : 'en';
          const voice = speaker.voiceId as string;
          const style = speaker.style ?? '';
          const key = geminiClipKey(gemini.cfg.ttsModel, speaker, s);
          const reused = reusableSpeech(d.speechCache[unitKey], key, loadAssetIndex(), refs);
          if (reused && d.speechCache[unitKey]) {
            measured[s.id] = d.speechCache[unitKey].durationSec;
            newCache[unitKey] = d.speechCache[unitKey];
            speechRefOf.set(s.id, reused);
            continue;
          }
          // A verified turn from an earlier, rolled-back attempt is reused without a provider call.
          // A newly validated turn is saved durably before anything else in this apply can fail.
          const stored = lookupTurn(key);
          const clip = stored
            ? {
                bytes: stored.bytesData, sha256: stored.sha256, durationSec: stored.durationSec, sampleRate: stored.sampleRate,
                channels: stored.channels, mimeType: 'audio/wav' as const, model: stored.model, voice: stored.voice,
                language: stored.language, style: stored.style, textSha256: stored.textSha256,
              }
            : await synthesizeProductionTurn(gemini, { text: s.narration, style, voice, language: lang });
          if (!stored) {
            saveTurn(key, clip);
            stage(`after-turn:${s.id}`);
          }
          const assetId = `factory-speech-${randomBytes(6).toString('hex')}`;
          const fileName = `${assetId}.wav`;
          const abs = path.join(ASSETS_DIR, fileName);
          ensureDirs();
          fs.writeFileSync(abs, clip.bytes);
          createdFiles.push(abs);
          const fileSha = sha256(Buffer.from(clip.bytes));
          const voiceLabel = `Gemini ${voice}`;
          newAssets.push({
            id: assetId,
            name: `Generated speech: ${unitKey} (${voiceLabel}, ${lang})`,
            kind: 'sfx',
            fileName,
            path: fileName,
            mimeType: 'audio/wav',
            sizeBytes: clip.bytes.byteLength,
            durationSec: clip.durationSec,
            tags: ['factory', 'generated-speech', 'unapproved', 'gemini-tts'],
            status: 'active',
            preferred: false,
            source: `Generated by Gemini TTS (model ${clip.model}, voice ${voice}, language ${lang}, style ${style || 'none'}) from reviewed narration. Unapproved: not listened-reviewed.`,
            license: 'Generated through the Gemini API under the owner\'s key. Check the provider terms before publishing.',
            addedAt: nowIso(),
            usedIn: [],
            blocked: false,
          });
          measured[s.id] = clip.durationSec;
          newCache[unitKey] = {
            key,
            assetId,
            durationSec: clip.durationSec,
            sha256: fileSha,
            provenance: { provider: 'gemini', model: clip.model, voice, language: lang, style, textSha256: clip.textSha256 },
          };
          newShaByAsset.set(assetId, fileSha);
          speechRefOf.set(s.id, {
            id: assetId,
            kind: 'audio',
            name: `Generated speech: ${unitKey}`,
            mediaUrl: `/media/asset/${assetId}`,
            durationSec: clip.durationSec,
            source: `Generated by Gemini TTS (model ${clip.model}, voice ${voice}). Unapproved.`,
            license: 'Generated through the Gemini API under the owner\'s key.',
            sha256: fileSha,
            mimeType: 'audio/wav',
          });
          continue;
        }
        const voiceId = voiceOf.get(s.speakerId as string) as string;
        const key = sha256(`${voiceId}\n${s.narration}`);
        const reused = reusableSpeech(d.speechCache[unitKey], key, loadAssetIndex(), refs);
        if (reused && d.speechCache[unitKey]) {
          measured[s.id] = d.speechCache[unitKey].durationSec;
          newCache[unitKey] = d.speechCache[unitKey];
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
        newCache[unitKey] = { key, assetId, durationSec: out.durationSec, sha256: fileSha };
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
    const timingBaseline = timingBoundariesSha256(doc);
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
        timing: { schemaVersion: 1, source: timing.timingSource, boundariesSha256: timingBaseline, appliedAt },
        speechPolicy: audio ? 'supplied_full_audio' : 'generated_per_scene_unapproved',
        generatedAssets: newAssets.map((a) => ({ id: a.id, durationSec: a.durationSec, sha256: newShaByAsset.get(a.id) ?? null })),
        visualDecisions: scenes.map((s) => ({ sceneId: s.id, ...s.visualDecision })),
        createdAt: appliedAt,
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
      appliedProjects: [...d.appliedProjects, { projectId: derivedId, editorRevision: doc.revision, timingSource: timing.timingSource, appliedAt, draftRevision: d.revision }],
      successfulApplies: [
        ...(d.successfulApplies ?? []),
        { projectId: derivedId, draftRevision: d.revision, editorRevision: doc.revision, timingSource: timing.timingSource, appliedAt, sources: sourceRecords },
      ],
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
        timingLabel: timingSourceLabel(timing.timingSource),
        speechGenerated: newAssets.length,
        reused: false,
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

/* ------------------------------------------------------------------ */
/* Gemini plan drafts (Milestone 3). Converts a validated plan job     */
/* into the same persisted draft model. Semantic alternatives are kept.*/
/* ------------------------------------------------------------------ */

/** Cache identity for one Gemini clip: model, voice, language, style and text. Reuse needs all five to match. */
export function geminiClipKey(model: string, speaker: FactorySpeaker, s: FactoryDraftScene): string {
  return sha256(
    JSON.stringify({ provider: 'gemini', model, voice: speaker.voiceId, language: s.language, style: speaker.style ?? '', text: s.narration }),
  );
}

const SHOT_DECISIONS: Record<string, { framing: 'full' | 'tight'; motion: 'none' | 'slow_push'; unexecuted: string[] }> = {
  close_up: { framing: 'tight', motion: 'slow_push', unexecuted: [] },
  medium: { framing: 'tight', motion: 'none', unexecuted: [] },
  wide: { framing: 'full', motion: 'none', unexecuted: [] },
  screen_recording: { framing: 'full', motion: 'none', unexecuted: ['Needs a real screen capture. Nothing is generated for it.'] },
  overlay_on_still: { framing: 'full', motion: 'slow_push', unexecuted: ['Overlay is not rendered in this milestone. Captions still show the words.'] },
  split_comparison: { framing: 'full', motion: 'none', unexecuted: ['Split layout is not rendered in this milestone.'] },
  title_card: { framing: 'full', motion: 'none', unexecuted: ['Title card is not rendered. The supplied words appear as captions.'] },
};

function tryLoadDraft(draftId: string): StoredDraft | null {
  try {
    return loadDraft(draftId);
  } catch {
    return null;
  }
}

const SPEAKER_SLUG = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'speaker';

/**
 * Converts a succeeded plan job into a persisted draft. Idempotent: a second call returns the
 * same draft (200). Nothing is generated here; this is a pure conversion of reviewed plan data.
 */
export function createDraftFromPlanJob(jobId: string, body: unknown): { status: 200 | 201; body: FactoryDraftEnvelope } {
  const deps = geminiDeps();
  const job = deps.store.getJob(jobId);
  if (!job || job.kind !== 'plan') throw new FactoryError('FACTORY_JOB_NOT_FOUND', 'No plan job with that id.', 404);
  if (job.status !== 'succeeded' || !job.result || typeof job.result.plan !== 'object') {
    throw new FactoryError('FACTORY_JOB_NOT_READY', 'The plan is not ready. Only a succeeded plan can become a draft.', 409);
  }
  const existingId = typeof job.result.draftId === 'string' ? job.result.draftId : null;
  if (existingId) {
    const existing = tryLoadDraft(existingId);
    if (existing) return { status: 200, body: envelopeOf(existing) };
  }
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (b.format !== 'landscape' && b.format !== 'portrait') throw new FactoryError('FACTORY_VALIDATION', 'format must be landscape or portrait.', 422);
  const plan = job.result.plan as GeneratedPlan;
  const lines = plan.script.lines;
  const lineIds = new Set<string>();
  for (const l of lines) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(l.id) || lineIds.has(l.id)) throw new FactoryError('FACTORY_AI_INVALID_OUTPUT', 'The plan has an invalid or duplicate line id.', 422);
    lineIds.add(l.id);
  }

  // Speakers: one per distinct label in the plan. Voices default to the prebuilt list, in order.
  const labels: string[] = [];
  for (const l of lines) if (!labels.includes(l.speaker)) labels.push(l.speaker);
  const requestedRaw = Array.isArray(b.speakers) ? (b.speakers as Array<Record<string, unknown>>) : [];
  const speakerIdOfLabel = new Map<string, string>();
  for (const label of labels) {
    let id = SPEAKER_SLUG(label);
    while ([...speakerIdOfLabel.values()].includes(id)) id = `${id}-x`;
    speakerIdOfLabel.set(label, id);
  }
  const speakers: FactorySpeaker[] = labels.map((label, index) => {
    const req = requestedRaw.find((r) => r && r.label === label);
    const voice = req && typeof req.voice === 'string' ? req.voice : GEMINI_PREBUILT_VOICES[index % GEMINI_PREBUILT_VOICES.length];
    if (!(GEMINI_PREBUILT_VOICES as readonly string[]).includes(voice)) {
      throw new FactoryError('FACTORY_VALIDATION', `voice for "${label}" must be a prebuilt Gemini voice.`, 422);
    }
    const style = req && typeof req.style === 'string' ? req.style : '';
    if (style.length > 200 || /[<>]/.test(style)) throw new FactoryError('FACTORY_VALIDATION', `style for "${label}" is invalid.`, 422);
    return { id: speakerIdOfLabel.get(label) as string, voiceId: voice, available: true, provider: 'gemini', style };
  });
  const speakerIdFor = (label: string) => speakerIdOfLabel.get(label) as string;

  // Treatments. Each keeps its own shot sequence. Scenes are expanded to one per line so speech is per line.
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const treatments: StoredDraft['treatments'] = [];
  const proposals: Record<string, FactoryDraftScene[]> = {};
  for (const t of plan.treatments) {
    const seen = new Map<string, number>();
    const scenes: FactoryDraftScene[] = [];
    for (const sc of t.scenes) {
      for (const lid of sc.lineIds) {
        const line = lineById.get(lid);
        if (!line) throw new FactoryError('FACTORY_AI_INVALID_OUTPUT', `treatment ${t.id} refers to an unknown line.`, 422);
        seen.set(lid, (seen.get(lid) ?? 0) + 1);
        scenes.push({
          id: `${t.id}-${lid}`,
          narration: line.text,
          speakerId: speakerIdFor(line.speaker),
          visualIntent: sc.visualRequirement,
          assetId: null,
          startSec: null,
          endSec: null,
          locked: false,
          sourceUnitId: lid,
          beat: sc.shotType,
          language: line.language,
          assetOrigin: null,
          timingSource: 'unknown',
          visualDecision: SHOT_DECISIONS[sc.shotType] ?? { framing: 'full', motion: 'none', unexecuted: [] },
          shot: { type: sc.shotType, why: sc.why, assetNeed: sc.assetNeed, visualRequirement: sc.visualRequirement },
        });
      }
    }
    for (const l of lines) {
      if (seen.get(l.id) !== 1) throw new FactoryError('FACTORY_AI_INVALID_OUTPUT', `treatment ${t.id} must use every line exactly once.`, 422);
    }
    treatments.push({ id: t.id, title: t.title, rationale: t.rationale });
    proposals[t.id] = scenes;
  }
  if (treatments.length === 0) throw new FactoryError('FACTORY_AI_INVALID_OUTPUT', 'The plan has no treatments.', 422);

  const identity = identityFor(plan.profile as EditorContentProfile, typeof b.channelBrandId === 'string' ? b.channelBrandId : null);
  const warnings = [
    `Generated by Gemini (${plan.profile}) from your brief. The narration is unapproved until you apply.`,
    ...plan.sourceNotes
      .filter((n: PlanSourceNote) => n.status === 'needs_verification')
      .slice(0, 10)
      .map((n) => `Unsupported claim, marked for verification: ${n.claim}`),
  ];
  if (plan.treatments.some((t) => t.scenes.some((s) => s.shotType === 'screen_recording' || s.assetNeed === 'screen_recording_needed'))) {
    warnings.push('A screen recording is planned. It must be a real capture, reviewed for suitability before use.');
  }
  if (identity.refusal) warnings.push(identity.refusal);

  const selectedTreatmentId = treatments[0].id;
  const d: StoredDraft = {
    schemaVersion: 1,
    draftId: `dft_${randomBytes(8).toString('hex')}`,
    revision: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    contentProfile: plan.profile as EditorContentProfile,
    format: b.format,
    channelBrandId: identity.channelBrandId,
    brief: '',
    source: {
      scriptSha256: sha256(JSON.stringify(plan.script)),
      storyboardSha256: null,
      audioAssetId: null,
      audioSha256: null,
      audioDurationSec: null,
      visualAssetIds: [],
      referenceProjectId: null,
      generatedJobId: job.id,
      generatedPlanSha256: sha256(JSON.stringify(plan)),
    },
    requestedSpeakers: speakers.map((sp) => ({ id: sp.id, voiceId: sp.voiceId })),
    units: lines.map((l) => ({
      id: l.id,
      narration: l.text,
      language: l.language,
      speakerHint: l.speaker,
      assetId: null,
      startSec: null,
      endSec: null,
      locked: false,
      origin: 'generated' as const,
    })),
    treatments,
    proposals,
    selectedTreatmentId,
    selection: proposals[selectedTreatmentId],
    speakers,
    status: 'blocked',
    missing: [],
    warnings,
    speechCache: {},
    appliedProjects: [],
  };
  refreshStatus(d);
  saveDraft(d);
  job.result = { ...job.result, draftId: d.draftId };
  deps.store.saveJob(job);
  return { status: 201, body: envelopeOf(d) };
}

/**
 * Edits to a generated draft. Narration changes are allowed only on generated units, and they
 * invalidate that unit's speech only. Speaker voice or style changes invalidate that speaker's speech.
 * Supplied (approved) narration is refused: rewrite it through a derived draft.
 */
export function patchGeneratedDraft(draftId: string, body: unknown): FactoryDraftEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  const b = body as Record<string, unknown>;
  const expected = b.expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }
  const edits = Array.isArray(b.edits) ? (b.edits as Array<Record<string, unknown>>) : [];
  const speakerEdits = Array.isArray(b.speakers) ? (b.speakers as Array<Record<string, unknown>>) : [];
  return withLock(draftId, () => {
    const d = loadDraft(draftId);
    if (!d.source.generatedJobId) {
      throw new FactoryError('FACTORY_NOT_GENERATED', 'This draft was not created from a Gemini plan. Use PATCH /api/factory/drafts/:id.', 409);
    }
    if (expected !== d.revision) {
      throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload and apply your edit again.', 409, { currentRevision: d.revision });
    }
    const allScenes = () => [d.selection, ...Object.values(d.proposals)].flat();
    for (const e of edits) {
      const unitId = typeof e.unitId === 'string' ? e.unitId : '';
      const unit = d.units.find((u) => u.id === unitId);
      if (!unit) throw new FactoryError('FACTORY_VALIDATION', 'edits name an unknown narration unit.', 422);
      if (unit.origin !== 'generated') {
        throw new FactoryError('FACTORY_SCRIPT_APPROVED', 'This narration is supplied and approved, so it is immutable here. Create a derived draft to rewrite it.', 409);
      }
      const narration = typeof e.narration === 'string' ? e.narration : null;
      if (narration === null || narration.trim().length === 0 || narration.length > 1000) {
        throw new FactoryError('FACTORY_VALIDATION', 'narration must be 1 to 1000 characters.', 422);
      }
      if (/[<>]/.test(narration)) throw new FactoryError('FACTORY_VALIDATION', 'angle brackets are not allowed in narration.', 422);
      if (narration === unit.narration) continue;
      unit.narration = narration;
      for (const sc of allScenes()) if (sc.sourceUnitId === unitId) sc.narration = narration;
      // Only this unit's speech is invalidated. Other clips keep their bytes.
      delete d.speechCache[unitId];
    }
    for (const sp of speakerEdits) {
      const id = typeof sp.id === 'string' ? sp.id : '';
      const speaker = d.speakers.find((x) => x.id === id);
      if (!speaker) throw new FactoryError('FACTORY_VALIDATION', 'speakers name an unknown speaker.', 422);
      const voice = sp.voice === undefined ? speaker.voiceId : sp.voice;
      if (typeof voice !== 'string' || !(GEMINI_PREBUILT_VOICES as readonly string[]).includes(voice)) {
        throw new FactoryError('FACTORY_VALIDATION', 'voice must be a prebuilt Gemini voice.', 422);
      }
      const style = sp.style === undefined ? speaker.style ?? '' : sp.style;
      if (typeof style !== 'string' || style.length > 200 || /[<>]/.test(style)) {
        throw new FactoryError('FACTORY_VALIDATION', 'style must be at most 200 characters with no angle brackets.', 422);
      }
      if (voice === speaker.voiceId && style === (speaker.style ?? '') && speaker.provider === 'gemini') continue;
      speaker.voiceId = voice;
      speaker.style = style;
      speaker.provider = 'gemini';
      speaker.available = true;
      for (const sc of allScenes()) if (sc.speakerId === id) delete d.speechCache[sc.sourceUnitId];
    }
    d.revision += 1;
    d.updatedAt = nowIso();
    refreshStatus(d);
    saveDraft(d);
    return envelopeOf(d);
  });
}

export interface ShotListScene {
  index: number;
  sceneId: string;
  sourceUnitId: string;
  narration: string;
  shotType: string | null;
  why: string | null;
  assetNeed: string;
  visualRequirement: string;
  boundAssetId: string | null;
  status: 'bound' | 'missing';
  /** Still-image prompt for a missing image. Text only: no image is generated here. */
  prompt: string | null;
  /** Brief for a real screen capture. Text only. */
  screenRecordingBrief: string | null;
}

/** Shot list for the selected treatment: what each line needs, what is bound, what is missing. */
export function shotListFor(draftId: string): { draftId: string; revision: number; format: string; aspect: string; treatmentId: string | null; scenes: ShotListScene[] } {
  const d = loadDraft(draftId);
  const aspect = d.format === 'portrait' ? '9:16' : '16:9';
  const religious = d.contentProfile === 'religious';
  return {
    draftId: d.draftId,
    revision: d.revision,
    format: d.format,
    aspect,
    treatmentId: d.selectedTreatmentId,
    scenes: d.selection.map((s, i) => {
      const need = s.shot?.assetNeed ?? (s.assetId ? 'existing_library' : 'image_needed');
      const req = s.shot?.visualRequirement ?? s.visualIntent;
      const bound = s.assetId;
      const prompt =
        !bound && need === 'image_needed'
          ? `Create a still image in ${aspect} for a video scene. ${req}.${s.shot?.why ? ` Purpose: ${s.shot.why}.` : ''} Realistic and uncluttered. No text, no logos, no watermarks.${religious ? ' Respectful and dignified; no text or quotations in the image.' : ''}`
          : null;
      const recording =
        !bound && need === 'screen_recording_needed'
          ? `Capture a real screen recording in ${aspect}. ${req}. Use real software and real data only; do not stage or invent results. Review for suitability before use.`
          : null;
      return {
        index: i + 1,
        sceneId: s.id,
        sourceUnitId: s.sourceUnitId,
        narration: s.narration,
        shotType: s.shot?.type ?? null,
        why: s.shot?.why ?? null,
        assetNeed: need,
        visualRequirement: req,
        boundAssetId: bound,
        status: bound ? 'bound' : 'missing',
        prompt,
        screenRecordingBrief: recording,
      };
    }),
  };
}

/** Markdown shot-list package for missing assets. Built from the same data as the JSON view. */
export function shotListMarkdown(list: ReturnType<typeof shotListFor>): string {
  const out: string[] = [
    `# Shot list: ${list.draftId} (revision ${list.revision})`,
    '',
    `Format: ${list.format} (${list.aspect}). Treatment: ${list.treatmentId ?? 'none'}.`,
    'Text only. No image or video is generated by this export.',
    '',
  ];
  for (const s of list.scenes) {
    out.push(`## ${s.index}. ${s.sceneId} [${s.status}]`);
    out.push(`- Line: ${s.narration}`);
    out.push(`- Shot: ${s.shotType ?? 'n/a'}. Why: ${s.why ?? 'n/a'}`);
    out.push(`- Asset need: ${s.assetNeed}. Bound asset: ${s.boundAssetId ?? 'none'}`);
    if (s.prompt) out.push(`- Image prompt: ${s.prompt}`);
    if (s.screenRecordingBrief) out.push(`- Screen recording brief: ${s.screenRecordingBrief}`);
    out.push('');
  }
  return out.join('\n');
}
