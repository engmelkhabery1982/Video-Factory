import { isGraphicTechniqueId, techniqueReadiness, capabilityOfTechnique, UNAVAILABLE_VISUAL_CAPABILITIES, VISUAL_LANGUAGE_IDS, VISUAL_LANGUAGES, VISUAL_TECHNIQUES, VISUAL_LANGUAGE_REGISTRY_VERSION, type VisualLanguageId, type VisualTechniqueId, type VisualRuntimeFacts } from '@buildtrack/core';
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
  buildTreatments,
  EDITOR_SCHEMA_VERSION,
  FactoryError,
  parseDraftCreate,
  parseDraftPatch,
  parseStoryboard,
  FACTORY_TEXT_AUTHORITIES,
  planFactoryDraft,
  planFactoryTiming,
  predictFactoryTiming,
  composeStillPrompt,
  CONDITIONING_STRENGTH,
  referenceClauseOf,
  reviewRefusals,
  religiousRefusals,
  type ConditioningSetting,
  type VisualReviewRecord,
  parseVisualDescription,
  validateVisualDescription,
  reconcileSelection,
  timingSourceLabel,
  resolveFactorySpeakers,
  resolveContentBrand,
  planSilentTiming,
  resolveNarrationMode,
  roleOfVisual,
  isShotRole,
  completionQueueFor,
  parseIntakeOptions,
  timingLabelOf,
  TEXT_SOURCE_LABELS,
  type FactoryCompletionItem,
  type FactoryErrorCode,
  type FactoryIntakeOptions,
  type FactoryIntakeSummary,
  type FactoryNarrationMode,
  type FactoryStoryboardV1,
  type FactoryTextAuthority,
  type FactoryTextConflictSummary,
  type FactoryTranscriptFact,
  type FactoryVisualRole,
  type FactoryPlanOptions,
  type DeriveAssetRef,
  type EditorContentProfile,
  type FactoryDraftCreateInput,
  type FactoryDerivation,
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
import { localPlannerStatus } from './local-planner.js';
import { getVisionJob } from './local-vision.js';
import { lookupTurn, saveTurn } from './factory-turn-store.js';
import { cancelJob, loadJob, reviewJob, startJob, transcriptionCapability, TranscriptionRefused, type TranscriptionJob } from './factory-transcription.js';
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

/**
 * The optional-input choices and the raw text they were built from. Stored so an intake change can replan
 * without asking for the text again. Legacy drafts have none; their units are used instead (see intakeOf).
 */
interface StoredIntake {
  scriptText: string | null;
  storyboard: FactoryStoryboardV1 | null;
  narrationMode: FactoryNarrationMode | null;
  textAuthority: FactoryTextAuthority | null;
  captions: boolean;
  visualRoles: Record<string, FactoryVisualRole>;
  visualNotes: Record<string, string>;
  /** Reviewed picture descriptions (local picture analysis). Absent on older drafts. */
  visualReview?: Record<string, VisualReviewRecord>;
  /** The picture that conditions local stills, with its strength. Absent or null on older drafts. */
  conditioning?: ConditioningSetting | null;
  transcriptJobId: string | null;
}

interface StoredDraft {
  schemaVersion: 1;
  draftId: string;
  /** Optional-input contract. Absent on legacy drafts (see intakeOf). */
  intake?: StoredIntake;
  /** Draft-level visual language. Absent on legacy drafts, read as null. */
  visualLanguage?: VisualLanguageId | null;
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
    /** Set on a derived rewrite: the draft it came from and the per-unit changes. */
    derivedFrom?: FactoryDerivation | null;
  };
  /** Revision at which a reviewer confirmed this derived rewrite. Speech and apply need it. */
  reviewedRevision?: number | null;
  requestedSpeakers: Array<{ id: string; voiceId: string | null }>;
  units: FactoryPlanUnit[];
  treatments: Array<{ id: string; title: string; rationale: string }>;
  proposals: Record<string, FactoryDraftScene[]>;
  selectedTreatmentId: string | null;
  selection: FactoryDraftScene[];
  /**
   * sha256 of each library file the current selection is bound to, recorded when the asset
   * first becomes referenced. Kept beside the scenes, so scene rows (including locked rows)
   * keep their bytes. Pruned when no scene references the asset, so unbind then bind records again.
   */
  assetHashes?: Record<string, string>;
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

export function factoryCapabilities(localImage: VisualRuntimeFacts['localImage'] = localImageFacts) {
  const planner = localPlannerStatus();
  const probe: FactorySpeechProbe = probeSpeechEngines();
  const sam = probe.samAvailable;
  const speechReason = sam
    ? 'Local sam-js English sample voices run here: robotic, synthetic, not natural speech. Arabic speech is unavailable.'
    : 'No runnable speech engine. Supply approved audio; external audio import still works.';
  return {
    version: 1,
    text: {
      available: true,
      // Semantic planning uses the local OpenAI-compatible server only when it is configured.
      // Otherwise the labelled offline mode is local rules: deterministic, not semantic AI.
      mode: planner.ready ? ('local_llm' as const) : ('local_rules' as const),
      planner,
      reason: planner.ready
        ? 'Semantic planning uses the local planner on loopback. Google is not used for planning.'
        : 'Offline mode: local deterministic rules over the supplied words. No semantic AI runs. ' + planner.reason,
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
    image: {
      available: false,
      route: 'local_stable_diffusion_cpp' as const,
      statusEndpoint: '/api/local-images/status',
      googleUsed: false as const,
      reason: 'Local image generation runs on the owner computer (stable-diffusion.cpp). It needs setup first; see /api/local-images/status. No Google or cloud image generation.',
    },
    visualLanguages: {
      version: VISUAL_LANGUAGE_REGISTRY_VERSION,
      runtime: { localImage },
      languages: VISUAL_LANGUAGE_IDS.map((id) => {
        const lang = VISUAL_LANGUAGES[id];
        const runtime: VisualRuntimeFacts = { localImage };
        return {
          id,
          label: lang.label,
          summary: lang.summary,
          engine: lang.engine,
          requiredInputs: lang.requiredInputs,
          capability: lang.capability,
          reason: lang.reason,
          techniques: lang.techniques.map((t) => ({ id: t, label: VISUAL_TECHNIQUES[t].label, ...capabilityOfTechnique(t, runtime) })),
        };
      }),
      unavailable: UNAVAILABLE_VISUAL_CAPABILITIES,
    },
    transcription: {
      ...transcriptionCapability(),
      // Owner-reviewed text only. Forced alignment is a different runtime and never a transcription.
      contract: 'Local runner (VF_TRANSCRIBE_COMMAND). Output is text only, reviewed by the owner before use. Google is not a transcription engine.',
    },
    vision: {
      available: false,
      reason: 'No local vision engine is configured. A text-only planner does not see pixels, so no picture is described automatically. Describe pictures yourself in the app.',
    },
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

/**
 * Binding rule for one scene. The single source for Apply gating, the editor-facing missing
 * list, and the shot list, so they cannot disagree. A still is never a screen recording, and
 * a scene with no bound file is missing (a prompt is not media).
 */
export type SceneBindingStatus = 'bound' | 'missing' | 'blocked' | 'changed' | 'incompatible';
export interface SceneBinding {
  status: SceneBindingStatus;
  kind: FactoryMissingItem['kind'];
  reason: string;
  mediaType: 'image' | 'video' | null;
  source: string | null;
  license: string | null;
}

function sceneNeedOf(s: FactoryDraftScene): string {
  return s.shot?.assetNeed ?? (s.assetId ? 'existing_library' : 'image_needed');
}

function bindingOf(s: FactoryDraftScene, index: Asset[], refs: Map<string, DeriveAssetRef>, hashes: Record<string, string>): SceneBinding {
  const need = sceneNeedOf(s);
  const none = { mediaType: null, source: null, license: null };
  if (isGraphicTechniqueId(s.technique)) {
    // A procedural graphic has no library asset. It is bound when its supplied values are present.
    return s.graphic
      ? { status: 'bound', kind: 'asset', reason: '', mediaType: null, source: 'Procedural graphic from supplied values', license: null }
      : { status: 'missing', kind: 'asset', reason: `${s.technique} needs supplied values (labels, numbers or steps) before Apply.`, ...none };
  }
  if (!s.assetId) {
    if (need === 'screen_recording_needed') {
      return { status: 'missing', kind: 'recording', reason: 'This scene needs a real screen recording. None is bound. A prompt or a still is not a recording.', ...none };
    }
    return { status: 'missing', kind: 'image', reason: 'No supplied or licensed library image is assigned to this scene. No image engine is configured.', ...none };
  }
  const asset = index.find((a) => a.id === s.assetId);
  if (!asset) return { status: 'blocked', kind: 'asset', reason: `${s.assetId} is no longer in the library.`, ...none };
  if (asset.status !== 'active' || asset.blocked === true) {
    return { status: 'blocked', kind: 'asset', reason: `${asset.name} is blocked or inactive.`, ...none };
  }
  if (!asset.source?.trim() || !asset.license?.trim()) {
    return { status: 'blocked', kind: 'asset', reason: `${asset.name} has no recorded source and licence.`, ...none };
  }
  const ref = refs.get(asset.id);
  if (!ref) return { status: 'incompatible', kind: 'asset', reason: `${asset.name} is not an image or video.`, ...none };
  const meta = { source: ref.source, license: ref.license };
  if (ref.kind !== 'image' && ref.kind !== 'video') {
    return { status: 'incompatible', kind: 'asset', reason: `${asset.name} is ${ref.kind}, and cannot be bound as a visual.`, mediaType: null, ...meta };
  }
  if (need === 'screen_recording_needed' && ref.kind !== 'video') {
    return { status: 'incompatible', kind: 'recording', reason: `${asset.name} is a still image. A still is not a screen recording. Bind a supplied screen recording, or change the need.`, mediaType: 'image', ...meta };
  }
  const file = assetFileOf(asset.id);
  if (!file) return { status: 'blocked', kind: 'asset', reason: `${asset.name} is missing from the library files.`, mediaType: ref.kind, ...meta };
  const recorded = hashes[asset.id];
  if (recorded && sha256(fs.readFileSync(file)) !== recorded) {
    return { status: 'changed', kind: 'asset', reason: `${asset.name} changed after it was bound. Unbind it and bind it again to accept the current file.`, mediaType: ref.kind, ...meta };
  }
  return { status: 'bound', kind: need === 'screen_recording_needed' ? 'recording' : 'image', reason: '', mediaType: ref.kind, ...meta };
}

/**
 * Keep the bound-file hashes in step with the selection: record each newly referenced asset's
 * current bytes, and drop assets no scene references any more. A later change to a referenced
 * file is then detected as "changed" by bindingOf.
 */
function stampBindings(d: StoredDraft): void {
  const referenced = new Set(d.selection.map((s) => s.assetId).filter((id): id is string => Boolean(id)));
  const hashes: Record<string, string> = {};
  for (const id of referenced) {
    if (d.assetHashes?.[id]) {
      hashes[id] = d.assetHashes[id];
      continue;
    }
    const file = assetFileOf(id);
    if (file) hashes[id] = sha256(fs.readFileSync(file));
  }
  d.assetHashes = hashes;
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

/** Last checked local image runtime state. Set by GET /api/factory/capabilities; `unknown` until it is checked. */
let localImageFacts: VisualRuntimeFacts['localImage'] = 'unknown';
export function setLocalImageFacts(state: VisualRuntimeFacts['localImage']): void {
  localImageFacts = state;
}

/** Per-shot readiness for the selected technique, from the real bindings, the language and the runtime facts. */
function visualReadinessOf(d: StoredDraft): Array<{ sceneId: string; technique: VisualTechniqueId | null; state: string; reason: string }> {
  const refs = libraryRefs();
  const runtime: VisualRuntimeFacts = { localImage: localImageFacts };
  return d.selection.map((s) => {
    const ref = s.assetId ? refs.get(s.assetId) : undefined;
    const assetKind = ref && (ref.kind === 'image' || ref.kind === 'video') ? ref.kind : null;
    const r = techniqueReadiness(s.technique ?? null, { hasGraphic: !!s.graphic, assetKind }, runtime, d.visualLanguage ?? null);
    return { sceneId: s.id, technique: s.technique ?? null, state: r.state, reason: r.reason };
  });
}

/** Intake of a draft. Legacy drafts reconstruct the storyboard from their current units (words and reviewed pictures). */
function intakeOf(d: StoredDraft): StoredIntake {
  if (d.intake) return d.intake;
  const storyboard: FactoryStoryboardV1 | null = d.units.length > 0
    ? {
      version: 1,
      scenes: d.units.map((u) => ({
        id: u.id,
        narration: u.narration,
        speakerId: u.speakerHint,
        assetId: u.assetOriginHint === undefined ? u.assetId : null,
        startSec: u.startSec,
        endSec: u.endSec,
        locked: u.locked,
      })),
    }
    : null;
  return { scriptText: null, storyboard, narrationMode: null, textAuthority: null, captions: true, visualRoles: {}, visualNotes: {}, transcriptJobId: null };
}

/** The transcript as planning may use it: reviewed text, only while it was made from the audio attached now. */
function transcriptFactFor(jobId: string | null, audioSha: string | null): FactoryTranscriptFact | null {
  if (!jobId) return null;
  const job = loadJob(jobId);
  if (!job) return { jobId, text: null, stale: true };
  const stale = audioSha === null || job.audioSha256 !== audioSha;
  return { jobId, text: !stale && job.reviewedText ? job.reviewedText : null, stale };
}

function planInputsOf(d: StoredDraft): { input: FactoryDraftCreateInput; opts: FactoryPlanOptions } {
  const intake = intakeOf(d);
  const probe = probeSpeechEngines();
  const visualIds = d.source.visualAssetIds;
  const input: FactoryDraftCreateInput = {
    contentProfile: d.contentProfile,
    format: d.format,
    channelBrandId: d.channelBrandId,
    inputs: {
      brief: d.brief,
      script: intake.scriptText,
      audioAssetId: d.source.audioAssetId,
      visualAssetIds: visualIds,
      storyboard: intake.storyboard,
      intake: {
        narrationMode: intake.narrationMode,
        textAuthority: intake.textAuthority,
        captions: intake.captions,
        visualRoles: intake.visualRoles,
        visualNotes: intake.visualNotes,
        transcriptJobId: intake.transcriptJobId,
      },
    },
    // Re-planning never refuses a stored speaker: a voice that is no longer configured is left out of the plan.
    // Gemini speakers of generated plans are not in the local voice list, so they are not planned here at all.
    requestedSpeakers: d.requestedSpeakers.filter((r) => r.voiceId === null || configuredVoiceIds(probe).includes(r.voiceId)),
    referenceProjectId: d.source.referenceProjectId,
    visualLanguage: d.visualLanguage ?? null,
  };
  const opts: FactoryPlanOptions = {
    capabilities: {
      speechLanguages: { en: probe.samAvailable, ar: false },
      transcriptionAvailable: transcriptionCapability().available,
      voiceIds: configuredVoiceIds(probe),
    },
    libraryVisuals: eligibleVisualRefs().map((r) => ({ id: r.id, kind: r.kind as 'image' | 'video' })),
    suppliedVisualIds: visualIds,
    audioPresent: d.source.audioAssetId !== null,
    transcript: transcriptFactFor(intake.transcriptJobId, d.source.audioSha256),
  };
  return { input, opts };
}

function narrationModeOf(d: StoredDraft): FactoryNarrationMode {
  return resolveNarrationMode(intakeOf(d).narrationMode, d.source.audioAssetId !== null);
}

function intakeSummaryOf(d: StoredDraft): FactoryIntakeSummary {
  const intake = intakeOf(d);
  const job = intake.transcriptJobId ? loadJob(intake.transcriptJobId) : null;
  return {
    narrationMode: narrationModeOf(d),
    requestedNarrationMode: intake.narrationMode,
    storyboard: intake.storyboard,
    textAuthority: intake.textAuthority,
    captions: intake.captions,
    visualRoles: intake.visualRoles,
    visualNotes: intake.visualNotes,
    visualReview: intake.visualReview ?? {},
    conditioning: intake.conditioning ?? null,
    transcript: job
      ? { jobId: job.jobId, status: job.status, reviewed: job.reviewedText !== null, stale: job.audioSha256 !== d.source.audioSha256 }
      : null,
  };
}

/** Silent drafts: reviewed times are kept when every scene has them; otherwise the labelled proposal applies. */
function silentTimingPlanOf(d: StoredDraft): { timingSource: 'supplied' | 'visual_duration_proposal'; label: string } {
  const allTimed = d.selection.length > 0 && d.selection.every((s) => s.startSec !== null && s.endSec !== null);
  const timingSource = allTimed ? 'supplied' as const : 'visual_duration_proposal' as const;
  return { timingSource, label: timingLabelOf(timingSource) };
}

/** Optional suggestions for the review queue. Never required; the owner may ignore each one. */
function suggestionsOf(d: StoredDraft): Array<Omit<FactoryCompletionItem, 'required' | 'kind'> & { kind: FactoryCompletionItem['kind'] }> {
  const out: Array<Omit<FactoryCompletionItem, 'required' | 'kind'> & { kind: FactoryCompletionItem['kind'] }> = [];
  for (const sc of d.selection) {
    if (sc.assetOrigin === 'library' && sc.assetId) {
      out.push({
        id: `library-${sc.id}`,
        kind: 'library_picture',
        sceneId: sc.id,
        label: `Scene ${sc.id} uses a library picture (${sc.assetId}) because no picture was supplied for it.`,
        action: 'Review the library picture for this scene, or supply your own picture.',
      });
    }
  }
  if (narrationModeOf(d) === 'none') {
    out.push({
      id: 'optional-narration',
      kind: 'optional_narration',
      sceneId: null,
      label: 'Narration is none, so this is a silent video.',
      action: 'Optional: set narration to generate or supplied to add speech later.',
    });
  }
  if (!intakeOf(d).captions) {
    out.push({ id: 'captions-off', kind: 'captions', sceneId: null, label: 'Captions are off.', action: 'Optional: turn captions on to show the reviewed narration text.' });
  }
  out.push({
    id: 'background-music',
    kind: 'background_music',
    sceneId: null,
    label: 'No background music is added.',
    action: 'Optional: add a licensed track from the library. Nothing is added automatically.',
  });
  return out;
}

function envelopeOf(d: StoredDraft): FactoryDraftEnvelope {
  const planned = planInputsOf(d);
  const plan = planFactoryDraft(planned.input, planned.opts);
  const conflict: FactoryTextConflictSummary | null = plan.textConflict
    ? { sources: plan.textConflict.sources.map((x) => ({ source: x.source, label: TEXT_SOURCE_LABELS[x.source], units: x.units })), authority: plan.textConflict.authority }
    : null;
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
    visualLanguage: d.visualLanguage ?? null,
    visualReadiness: visualReadinessOf(d),
    treatments,
    speakers: d.speakers,
    missing: d.missing,
    warnings: d.warnings,
    derivedFrom: d.source.derivedFrom ?? null,
    reviewedRevision: d.reviewedRevision ?? null,
    appliedProjects: d.appliedProjects,
    timingPlan: narrationModeOf(d) === 'none'
      ? silentTimingPlanOf(d)
      : predictFactoryTiming({
        hasAudio: d.source.audioAssetId !== null,
        allScenesTimed: d.selection.length > 0 && d.selection.every((s) => s.startSec !== null && s.endSec !== null),
      }),
    intake: intakeSummaryOf(d),
    textConflict: conflict,
    completion: completionQueueFor(d.missing, suggestionsOf(d)),
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

/** Kinds the planner owns at intake level. Per-scene speech and image gaps are recomputed from the selection below. */
const INTAKE_MISSING_KINDS = new Set(['conflict', 'material', 'script', 'transcription', 'audio', 'asset']);

/** Recompute missing items for the current selection with the same rules as planning. */
function missingFor(d: StoredDraft, probe: FactorySpeechProbe): FactoryMissingItem[] {
  const missing: FactoryMissingItem[] = [];
  // A derived rewrite is unapproved until a reviewer confirms it at this revision.
  // The gate sits in the missing list, so speech and apply both refuse until it clears.
  if (d.source.derivedFrom && d.source.derivedFrom.changes.length > 0 && d.reviewedRevision !== d.revision) {
    missing.push({ kind: 'review', sceneId: null, reason: 'This derived rewrite has not been reviewed at this revision. Review the changed narration before speech or apply.' });
  }
  // Intake gaps: conflicting texts, no material, audio without its mode, and so on. Recomputed from the stored intake.
  const planned = planInputsOf(d);
  for (const m of planFactoryDraft(planned.input, planned.opts).missing) {
    if (INTAKE_MISSING_KINDS.has(m.kind) && !missing.some((x) => x.kind === m.kind && x.reason === m.reason)) missing.push(m);
  }
  if (d.units.length === 0) {
    if (missing.length === 0) missing.push({ kind: 'script', sceneId: null, reason: 'Supply a reviewed script or a storyboard.' });
    return missing;
  }
  const mode = narrationModeOf(d);
  const speakerOf = new Map(d.speakers.map((sp) => [sp.id, sp]));
  const index = loadAssetIndex();
  const refs = libraryRefs();
  for (const s of d.selection) {
    const binding = bindingOf(s, index, refs, d.assetHashes ?? {});
    if (binding.status !== 'bound') missing.push({ kind: binding.kind, sceneId: s.id, reason: binding.reason });
    // Speech is needed only for generated narration of a line that has words. Supplied and silent modes need none.
    if (mode !== 'generate' || s.narration.trim().length === 0) continue;
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
  return missing;
}

function refreshStatus(d: StoredDraft): void {
  stampBindings(d);
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
  const intakeIn = input.inputs.intake ?? parseIntakeOptions({}, []);
  const transcript = transcriptFactFor(intakeIn.transcriptJobId, audio?.sha256 ?? null);
  if (intakeIn.transcriptJobId && !loadJob(intakeIn.transcriptJobId)) {
    throw new FactoryError('FACTORY_VALIDATION', 'transcriptJobId does not name a transcription job.', 422);
  }
  const plan = planFactoryDraft(input, {
    capabilities: {
      speechLanguages: { en: probe.samAvailable, ar: false },
      transcriptionAvailable: transcriptionCapability().available,
      voiceIds: configuredVoiceIds(probe),
    },
    libraryVisuals: eligibleVisualRefs().map((r) => ({ id: r.id, kind: r.kind as 'image' | 'video' })),
    suppliedVisualIds: visualIds,
    audioPresent: audio !== null,
    transcript,
  });
  const warnings = [...plan.warnings];
  if (plan.units.length === 0 && plan.narrationMode !== 'none') warnings.push('A brief alone cannot become scenes. Supply reviewed script text, a storyboard, or pictures with narration none. No text is generated here.');
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
    visualLanguage: input.visualLanguage ?? null,
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
    intake: {
      scriptText: input.inputs.script,
      storyboard: input.inputs.storyboard,
      narrationMode: intakeIn.narrationMode,
      textAuthority: intakeIn.textAuthority,
      captions: intakeIn.captions,
      visualRoles: intakeIn.visualRoles,
      visualNotes: intakeIn.visualNotes,
      transcriptJobId: intakeIn.transcriptJobId,
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
    const currentLanguage = d.visualLanguage ?? null;
    // Absent in the patch keeps the draft's language. null clears it.
    const requestedLanguage = patch.visualLanguage === undefined ? currentLanguage : patch.visualLanguage;
    const languageChanged = requestedLanguage !== currentLanguage;
    let proposals = d.proposals;
    let treatmentMeta = d.treatments;
    let currentScenes = d.selection;
    let incomingScenes = patch.scenes;
    if (languageChanged) {
      if (d.source.generatedJobId) {
        throw new FactoryError('FACTORY_VALIDATION', 'A generated plan keeps its visual language. Create a new draft to use another language.', 422);
      }
      if (d.selection.some((r) => r.locked)) {
        throw new FactoryError('FACTORY_SCENE_LOCKED', 'A locked scene is in the current selection. Changing the visual language would change it.', 423);
      }
      // Shot techniques and graphic values are language-specific. Changing them silently would discard owner work.
      const oldProposal = (d.selectedTreatmentId ? d.proposals[d.selectedTreatmentId] : undefined) ?? [];
      const overridden = d.selection.filter((r) => {
        const p = oldProposal.find((x) => x.id === r.id);
        return !p || (r.technique ?? null) !== (p.technique ?? null) || JSON.stringify(r.graphic ?? null) !== JSON.stringify(p.graphic ?? null);
      });
      if (overridden.length > 0 && patch.resetShotTechniques !== true) {
        throw new FactoryError(
          'FACTORY_VALIDATION',
          `Shots ${overridden.map((r) => r.id).join(', ')} have a technique or graphic chosen for the current visual language. Clear those choices before changing the language.`,
          422,
          { details: { sceneIds: overridden.map((r) => r.id) } },
        );
      }
      const rebuilt = buildTreatments(d.contentProfile, d.units, {
        orderLocked: speechOrderLockedOf(d),
        assetKinds: new Map(eligibleVisualRefs().map((r) => [r.id, r.kind as 'image' | 'video'])),
        visualLanguage: requestedLanguage,
        format: d.format,
      });
      proposals = Object.fromEntries(rebuilt.map((t) => [t.id, t.scenes]));
      treatmentMeta = rebuilt.map((t) => ({ id: t.id, title: t.title, rationale: t.rationale }));
      currentScenes = [];
      // A row the new language draws as a graphic cannot keep a picture. The owner's pick is dropped on that row only.
      incomingScenes = patch.scenes.map((row) => {
        // A confirmed reset takes the new language's technique and graphic for every shot.
        const reset = patch.resetShotTechniques === true ? { technique: undefined, graphic: undefined } : {};
        const p = (proposals[patch.selectedTreatmentId] ?? []).find((x: FactoryDraftScene) => x.id === row.id);
        const graphicShot = p && (p.graphic != null || (p.technique != null && isGraphicTechniqueId(p.technique)));
        return { ...row, ...reset, ...(graphicShot ? { assetId: null } : {}) };
      });
    }
    const selection = reconcileSelection({
      currentTreatmentId: d.selectedTreatmentId,
      currentScenes,
      proposals,
      sourceNarration,
      assetAllowed: (id) => eligible.has(id),
      speakerAllowed: () => true,
      orderLocked: speechOrderLockedOf(d),
      incomingTreatmentId: patch.selectedTreatmentId,
      incomingScenes,
      visualLanguage: requestedLanguage,
      format: d.format,
      contentProfile: d.contentProfile,
      skipServerOwnedEcho: languageChanged,
    });
    assertTimeline(selection);
    // A religious still is refused a brand, identity, lettering or scripture request. Only a CHANGED or new
    // description is checked, so an unrelated save never fails on an old description.
    for (const s of selection) {
      const before = d.selection.find((x) => x.id === s.id);
      if (before && before.visualIntent === s.visualIntent) continue;
      const refusals = religiousRefusals(parseVisualDescription(s.visualIntent ?? ''), d.contentProfile);
      if (refusals.length > 0) throw new FactoryError('FACTORY_IDENTITY_REFUSED', refusals.join(' '), 422, { details: { sceneId: s.id, refusals } });
    }
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
    d.proposals = proposals;
    d.treatments = treatmentMeta;
    d.visualLanguage = requestedLanguage;
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
    const graphicShot = isGraphicTechniqueId(s.technique);
    if (graphicShot) {
      if (!s.graphic) blockers.push({ kind: 'asset', sceneId: s.id, reason: `${s.technique} needs supplied values before Apply.` });
    } else if (!s.assetId || !refs.has(s.assetId)) {
      blockers.push({ kind: 'asset', sceneId: s.id, reason: 'This scene has no eligible image or video yet.' });
    }
    const kindNow = s.assetId ? refs.get(s.assetId)?.kind : undefined;
    if (s.technique === 'still_image' && kindNow !== undefined && kindNow !== 'image') {
      blockers.push({ kind: 'image', sceneId: s.id, reason: 'A still image shot needs an image. The bound asset is not an image.' });
    }
    if ((s.technique === 'footage_clip' || s.technique === 'screen_recording') && kindNow !== undefined && kindNow !== 'video') {
      blockers.push({ kind: s.technique === 'screen_recording' ? 'recording' : 'asset', sceneId: s.id, reason: `${s.technique} needs a supplied video. Stills and prompts are not footage or recordings.` });
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
  // A bound asset that is no longer an active, licensed image or video keeps its established code.
  const eligibleNow = new Set(eligibleVisualRefs().map((r) => r.id));
  for (const s of d.selection) {
    if (s.assetId && !eligibleNow.has(s.assetId)) invalidAsset(`scene "${s.id}" no longer references an active image or video.`);
  }
  if (d.status !== 'review_required' || d.missing.length > 0) {
    throw new FactoryError('FACTORY_INPUTS_REQUIRED', 'Required inputs are unresolved. Nothing was applied.', 422, { missing: d.missing });
  }

  // Everything below is checked before any synthesis or write.
  const scenes = d.selection;
  const refs = libraryRefs();
  for (const s of scenes) {
    if (isGraphicTechniqueId(s.technique)) {
      if (!s.graphic) invalidAsset(`scene "${s.id}" is a ${s.technique} with no supplied values.`);
      continue;
    }
    if (!s.assetId || !refs.has(s.assetId) || !eligibleVisualRefs().some((r) => r.id === s.assetId)) {
      invalidAsset(`scene "${s.id}" no longer references an active image or video.`);
    }
  }
  let audio: { sha256: string; durationSec: number } | null = null;
  if (d.source.audioAssetId) audio = validateAudio(d.source.audioAssetId);
  // Silent: no narration track, so no speaker, voice, speech call or audio file. Reviewed scene times are kept.
  const silent = narrationModeOf(d) === 'none';
  if (silent && audio) {
    throw new FactoryError('FACTORY_INPUTS_REQUIRED', 'Audio is attached but narration is none. Choose supplied narration, or remove the audio. Nothing was applied.', 422);
  }
  if (!audio && !silent && scenes.some((s) => s.timingSource === 'supplied')) {
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
  if (!audio && !silent) {
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
    if (!s.assetId) continue;
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
    if (!audio && !silent) {
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
    const timing = silent
      ? planSilentTiming({ units: scenes.map((s) => ({ id: s.id, narration: s.narration, startSec: s.startSec, endSec: s.endSec })) })
      : planFactoryTiming({
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
      visualLanguage: d.visualLanguage ?? null,
      channelBrandId: d.channelBrandId,
      format: d.format,
      scenes: scenes.map((s) => {
        const t = durationOf.get(s.id);
        if (!t) throw new FactoryError('FACTORY_VALIDATION', `scene "${s.id}" has no timing.`, 422);
        const graphicShot = isGraphicTechniqueId(s.technique);
        const visual = graphicShot ? undefined : refs.get(s.assetId as string);
        if (!graphicShot && !visual) invalidAsset(`scene "${s.id}" visual is not eligible.`);
        return {
          id: s.id,
          narration: s.narration,
          language: s.language,
          speakerId: s.speakerId,
          locked: s.locked,
          visual: (visual ?? null) as DeriveAssetRef | null,
          technique: s.technique ?? null,
          graphic: s.graphic ?? null,
          visualDecision: s.visualDecision,
          startSec: t.startSec,
          durationSec: t.durationSec,
          audio: audio ? null : speechRefOf.get(s.id) ?? null,
        };
      }),
      fullAudio: audio && fullRef ? { ref: fullRef, durationSec: audio.durationSec, sha256: audio.sha256 } : null,
      captionsEnabled: d.intake?.captions !== false,
    });

    // 4. Writes, in order: project, editor state, provenance, library (targeted add), draft record.
    const outputLanguage = scenes.filter((s) => s.language === 'ar').length >= scenes.length / 2 ? 'ar' : 'en';
    const input = {
      videoId: derivedId,
      videoType: 'long',
      topic: d.brief.trim().split(/\r?\n/)[0].slice(0, 160) || scenes[0].narration.slice(0, 160) || 'Silent video',
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
        speechPolicy: silent ? 'silent_no_narration' : audio ? 'supplied_full_audio' : 'generated_per_scene_unapproved',
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

  // Educational product mention (owner opt-in, supplied fact only). Inserted once, after the closing line,
  // as its own narration unit and scene in every treatment. It is unapproved until Apply, like every line.
  const pm = plan.productMention;
  let productLine: { id: string; factId: string; text: string; language: 'ar' | 'en'; speaker: string } | null = null;
  if (pm && pm.enabled === true) {
    if (plan.profile === 'religious') throw new FactoryError('FACTORY_VALIDATION', 'religious content cannot include a product mention.', 422);
    const factId = typeof pm.factId === 'string' ? pm.factId : '';
    const text = typeof pm.text === 'string' ? pm.text.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(factId) || !text) throw new FactoryError('FACTORY_AI_INVALID_OUTPUT', 'The product mention has no valid supplied fact.', 422);
    const id = `pm-${factId}`;
    if (lineIds.has(id)) throw new FactoryError('FACTORY_AI_INVALID_OUTPUT', 'The product mention id collides with a line id.', 422);
    const closing = lines[lines.length - 1];
    if (!closing) throw new FactoryError('FACTORY_AI_INVALID_OUTPUT', 'The plan has no closing line for the product mention.', 422);
    // Arabic script means Arabic narration; anything else is English. No guessing beyond that.
    productLine = { id, factId, text, language: /[\u0600-\u06FF]/.test(text) ? 'ar' : 'en', speaker: closing.speaker };
  }

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
    if (productLine) {
      scenes.push({
        id: `${t.id}-${productLine.id}`,
        narration: productLine.text,
        speakerId: speakerIdFor(productLine.speaker),
        visualIntent: 'Neutral visual for the owner-supplied product fact only. No product claims beyond the fact text.',
        assetId: null,
        startSec: null,
        endSec: null,
        locked: false,
        sourceUnitId: productLine.id,
        beat: 'product_mention',
        language: productLine.language,
        assetOrigin: null,
        timingSource: 'unknown',
        visualDecision: SHOT_DECISIONS.medium,
        shot: {
          type: 'medium',
          why: 'Educational product mention. The owner asked for one mention and supplied this fact.',
          assetNeed: 'image_needed',
          visualRequirement: 'Neutral visual for the supplied fact only.',
          productFactId: productLine.factId,
        },
      });
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
  if (productLine) {
    warnings.push(`Educational product mention added after the closing line, using the owner's supplied fact "${productLine.factId}". Review its wording and placement before Apply.`);
  }

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
    units: [
      ...lines.map((l) => ({
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
      ...(productLine
        ? [{
            id: productLine.id,
            narration: productLine.text,
            language: productLine.language,
            speakerHint: productLine.speaker,
            assetId: null,
            startSec: null,
            endSec: null,
            locked: false,
            origin: 'generated' as const,
          }]
        : []),
    ],
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
      if (unit.origin !== 'generated' && unit.origin !== 'derived') {
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
  status: SceneBindingStatus;
  /** Why the scene is not bound. Null when bound. */
  reason: string | null;
  mediaType: 'image' | 'video' | null;
  source: string | null;
  license: string | null;
  /** Still-image prompt for a missing image. Text only: no image is generated here. */
  prompt: string | null;
  /** Brief for a real screen capture. Text only. */
  screenRecordingBrief: string | null;
}

/** Shot list for the selected treatment: what each line needs, what is bound, what is missing. */
export function shotListFor(draftId: string): { draftId: string; revision: number; format: string; aspect: string; treatmentId: string | null; scenes: ShotListScene[] } {
  const d = loadDraft(draftId);
  const aspect = d.format === 'portrait' ? '9:16' : '16:9';
  const index = loadAssetIndex();
  const refs = libraryRefs();
  return {
    draftId: d.draftId,
    revision: d.revision,
    format: d.format,
    aspect,
    treatmentId: d.selectedTreatmentId,
    scenes: d.selection.map((s, i) => {
      const need = sceneNeedOf(s);
      const req = s.shot?.visualRequirement ?? s.visualIntent;
      const binding = bindingOf(s, index, refs, d.assetHashes ?? {});
      const still = need === 'image_needed' ? stillPromptFor(d, s) : null;
      const prompt = binding.status === 'missing' && still ? still.prompt : null;
      const recording =
        binding.status === 'missing' && need === 'screen_recording_needed'
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
        /** The assigned library asset, whatever its status. Null only when nothing is assigned. */
        boundAssetId: s.assetId,
        status: binding.status,
        reason: binding.reason || null,
        mediaType: binding.mediaType,
        source: binding.source,
        license: binding.license,
        prompt,
        imagePrompt: still?.prompt ?? null,
        visualDescription: need === 'image_needed' ? s.visualIntent : null,
        negativePrompt: still?.negativePrompt ?? null,
        promptWarnings: still?.warnings ?? [],
        promptRefusals: still?.refusals ?? [],
        screenRecordingBrief: recording,
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Derived rewrite                                                     */
/* ------------------------------------------------------------------ */

/**
 * Derived rewrite of a draft's narration. The SOURCE draft is never changed: this creates
 * a new draft that copies it, rewrites the named units, and records the before and after
 * text. Supplied, approved narration may be rewritten here. Changed units become origin
 * 'derived'. The new draft is blocked on a review item until a reviewer confirms it at
 * its revision, so speech and apply refuse before any provider spend. Unchanged clips keep
 * their cached bytes, because the clip key covers the text, voice and style.
 */
export function deriveDraft(sourceDraftId: string, body: unknown): { status: 201; body: FactoryDraftEnvelope } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  const b = body as Record<string, unknown>;
  const expected = b.expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }
  const edits = Array.isArray(b.edits) ? (b.edits as Array<Record<string, unknown>>) : [];
  if (edits.length === 0) throw new FactoryError('FACTORY_VALIDATION', 'edits must name at least one narration unit to rewrite.', 422);
  return withLock(sourceDraftId, () => {
    const source = loadDraft(sourceDraftId);
    if (expected !== source.revision) {
      throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload and derive again.', 409, { currentRevision: source.revision });
    }
    const seen = new Set<string>();
    const changes: FactoryDerivation['changes'] = [];
    const next = structuredClone(source) as StoredDraft;
    for (const e of edits) {
      const unitId = typeof e.unitId === 'string' ? e.unitId : '';
      if (seen.has(unitId)) throw new FactoryError('FACTORY_VALIDATION', 'each narration unit can be rewritten once per derivation.', 422);
      seen.add(unitId);
      const unit = next.units.find((u) => u.id === unitId);
      if (!unit) throw new FactoryError('FACTORY_VALIDATION', 'edits name an unknown narration unit.', 422);
      const narration = typeof e.narration === 'string' ? e.narration : null;
      if (narration === null || narration.trim().length === 0 || narration.length > 1000) {
        throw new FactoryError('FACTORY_VALIDATION', 'narration must be 1 to 1000 characters.', 422);
      }
      if (/[<>]/.test(narration)) throw new FactoryError('FACTORY_VALIDATION', 'angle brackets are not allowed in narration.', 422);
      if (narration === unit.narration) continue;
      changes.push({ unitId, before: unit.narration, after: narration });
    }
    if (changes.length === 0) throw new FactoryError('FACTORY_VALIDATION', 'No narration changed, so nothing was derived.', 422);
    const allScenes = () => [next.selection, ...Object.values(next.proposals)].flat();
    for (const c of changes) {
      const unit = next.units.find((u) => u.id === c.unitId)!;
      unit.narration = c.after;
      if (unit.origin === 'supplied') unit.origin = 'derived';
      for (const sc of allScenes()) if (sc.sourceUnitId === c.unitId) sc.narration = c.after;
      // Only the rewritten unit's clip is invalidated. Unchanged clips keep their bytes.
      delete next.speechCache[c.unitId];
    }
    const rootDraftId = source.source.derivedFrom?.rootDraftId ?? source.draftId;
    const stamp = nowIso();
    next.draftId = `dft_${randomBytes(8).toString('hex')}`;
    next.revision = 0;
    next.createdAt = stamp;
    next.updatedAt = stamp;
    next.appliedProjects = [];
    next.reviewedRevision = null;
    next.source = { ...next.source, derivedFrom: { draftId: source.draftId, revision: source.revision, rootDraftId, changes } };
    refreshStatus(next);
    saveDraft(next);
    return { status: 201, body: envelopeOf(next) };
  });
}

/** Reviewer confirmation of a derived rewrite at the revision the reviewer read. */
export function reviewDerivedDraft(draftId: string, body: unknown): FactoryDraftEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  const expected = (body as Record<string, unknown>).expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }
  return withLock(draftId, () => {
    const d = loadDraft(draftId);
    if (!d.source.derivedFrom) throw new FactoryError('FACTORY_NOT_DERIVED', 'This draft is not a derived rewrite, so there is nothing to review.', 409);
    if (expected !== d.revision) {
      throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The derived draft changed since you read it. Reload and review again.', 409, { currentRevision: d.revision });
    }
    d.reviewedRevision = d.revision;
    refreshStatus(d);
    saveDraft(d);
    return envelopeOf(d);
  });
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
    out.push(`- Media: ${s.mediaType ?? 'none'}. Source: ${s.source ?? 'none'}. Licence: ${s.license ?? 'none'}.`);
    if (s.reason) out.push(`- Blocked by: ${s.reason}`);
    if (s.screenRecordingBrief) out.push(`- Screen recording brief: ${s.screenRecordingBrief}`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * The composed still prompt for one image shot. Used by the shot list and the local runner, so both
 * always show the same text. The visual text is the shot's editable visual intent. Its labelled parts
 * (Subject, Environment, Lighting, Composition, Shot, Exclude) become the positive prompt, and the
 * Exclude part becomes this shot's own negative conditioning. No global ban on people.
 */
/**
 * Reviewed descriptions that may be used in still prompts: reviewed, chosen for prompts, on a style or character picture
 * whose bytes still match the analysed hash. Anything else is not used (a changed picture is not used silently).
 */
function reviewedReferencesOf(d: StoredDraft): Array<{ assetId: string; sha256: string; text: string; flags: VisualReviewRecord['flags'] }> {
  const intake = intakeOf(d);
  const index = loadAssetIndex();
  return Object.entries(intake.visualReview ?? {})
    .filter(([, r]) => r.state === 'reviewed' && r.useInPrompts)
    .filter(([assetId]) => intake.visualRoles[assetId] === 'style_reference' || intake.visualRoles[assetId] === 'character_reference')
    .filter(([assetId, r]) => index.find((a) => a.id === assetId)?.sha256 === r.sha256)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([assetId, r]) => ({ assetId, sha256: r.sha256, text: r.text, flags: r.flags }));
}

function stillPromptFor(d: StoredDraft, s: FactoryDraftScene): ReturnType<typeof composeStillPrompt> {
  const refs = reviewedReferencesOf(d);
  const still = composeStillPrompt({
    visual: s.visualIntent,
    profile: d.contentProfile,
    shotType: s.shot?.type ?? null,
    aspect: d.format === 'portrait' ? 'portrait' : 'landscape',
    referenceClause: referenceClauseOf(refs.map((r) => r.text)),
  });
  // A reviewed reference is checked with the same religious rules as the shot itself.
  const refusals = refs.flatMap((r) => reviewRefusals(r.text, d.contentProfile, r.flags).map((m) => `Reference picture ${r.assetId}: ${m}`));
  return refusals.length ? { ...still, refusals: [...still.refusals, ...refusals] } : still;
}

/** Why the draft's conditioning picture cannot be used now. Empty when it can, or when none is chosen. */
function conditioningIssuesOf(d: StoredDraft): string[] {
  const intake = intakeOf(d);
  const c = intake.conditioning;
  if (!c) return [];
  const role = intake.visualRoles[c.assetId];
  const asset = loadAssetIndex().find((a) => a.id === c.assetId);
  if (role !== 'style_reference' && role !== 'character_reference') return ['The conditioning picture must be a style or character reference.'];
  if (!asset) return ['The conditioning picture is no longer in the library.'];
  if (asset.mimeType !== 'image/png' && asset.mimeType !== 'image/jpeg') return ['Reference conditioning accepts PNG or JPEG pictures. Choose another picture.'];
  if (!asset.sha256) return ['The conditioning picture has no recorded hash. Upload it again.'];
  return [];
}

/**
 * The conditioning request for a local job, resolved on the server: the picture file, its hash, the strength.
 * null when the draft has no conditioning. Refuses (422) when the picture cannot be used.
 */
export function conditioningRequestFor(draftId: string): { assetId: string; sourcePath: string; sourceSha256: string; mimeType: 'image/png' | 'image/jpeg'; strength: number } | null {
  const d = loadDraft(draftId);
  const c = intakeOf(d).conditioning;
  if (!c) return null;
  const issues = conditioningIssuesOf(d);
  if (issues.length > 0) throw new FactoryError('FACTORY_VALIDATION', issues.join(' '), 422, { details: { issues } });
  const asset = loadAssetIndex().find((a) => a.id === c.assetId)!;
  const abs = assetFileOf(c.assetId);
  if (!abs) invalidAsset(`"${asset.name}" has no file on disk.`);
  return { assetId: c.assetId, sourcePath: abs as string, sourceSha256: asset.sha256 as string, mimeType: asset.mimeType as 'image/png' | 'image/jpeg', strength: c.strength };
}

/**
 * The shot prompt for one image shot, for the local image runner. Same text as the shot list.
 * Only an image shot can be sent to the runner (or re-sent to replace a bound still).
 * Screen recordings are never generated; a still is not a recording.
 */
export function stillRequestFor(draftId: string, sceneId: string): {
  draftId: string;
  sceneId: string;
  revision: number;
  prompt: string;
  negativePrompt: string;
  warnings: string[];
  /** Requests the rendered religious image must not carry. Non-empty: the shot cannot be generated. */
  refusals: string[];
  aspect: 'landscape' | 'portrait';
  boundAssetId: string | null;
  /** The reference picture that conditions this still, or null. */
  conditioning: ConditioningSetting | null;
  /** Reasons the conditioning picture cannot be used. Non-empty: generation is refused. */
  conditioningIssues: string[];
} {
  const d = loadDraft(draftId);
  const s = d.selection.find((x) => x.id === sceneId);
  if (!s) throw new FactoryError('FACTORY_VALIDATION', 'Unknown shot for this draft.', 422);
  const need = sceneNeedOf(s);
  if (need !== 'image_needed') {
    throw new FactoryError('FACTORY_VALIDATION', 'This shot is not an image shot. A screen recording is supplied by the owner, not generated.', 409, { details: { assetNeed: need } });
  }
  const still = stillPromptFor(d, s);
  return {
    draftId: d.draftId,
    sceneId: s.id,
    revision: d.revision,
    prompt: still.prompt,
    negativePrompt: still.negativePrompt,
    warnings: still.warnings,
    refusals: still.refusals,
    aspect: d.format === 'portrait' ? 'portrait' : 'landscape',
    boundAssetId: s.assetId ?? null,
    conditioning: intakeOf(d).conditioning ?? null,
    conditioningIssues: conditioningIssuesOf(d),
  };
}

/* ------------------------------------------------------------------ */
/* Candidate identity and freshness (local still images)               */
/* ------------------------------------------------------------------ */

/**
 * The identity of one image shot as it would be generated now. The fingerprint covers the draft, the shot,
 * the visual description, the composed positive and negative prompts, the aspect and the profile. It does
 * not cover the revision, narration, timing, or other shots: unrelated edits keep a candidate current.
 * Throws 422 when the description asks for branding, lettering or scripture in a religious still.
 */
export interface CandidateIdentity {
  draftId: string;
  sceneId: string;
  revision: number;
  prompt: string;
  negativePrompt: string;
  aspect: 'landscape' | 'portrait';
  profile: string;
  visualDescription: string;
  fingerprint: string;
}

/**
 * The style and character references attached to this draft, with their roles and SHA-256. Image candidates of the draft
 * depend on them: replacing a reference or changing its role changes this list. A draft with no such reference returns an
 * empty list, so its candidate fingerprints are unchanged. Other drafts are never affected. Final shots and storyboard panels
 * are not references and never appear here.
 */
function referenceIdentityOf(d: StoredDraft): Array<{ assetId: string; role: FactoryVisualRole; sha256: string }> {
  const roles = intakeOf(d).visualRoles;
  const index = loadAssetIndex();
  return Object.entries(roles)
    .filter(([, role]) => role === 'style_reference' || role === 'character_reference')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([assetId, role]) => {
      const asset = index.find((a) => a.id === assetId);
      const sha256 = asset?.sha256 ?? (asset ? `no-hash:${asset.fileName}:${asset.sizeBytes}` : 'missing');
      return { assetId, role, sha256 };
    });
}

function candidateIdentityOf(d: StoredDraft, s: FactoryDraftScene): CandidateIdentity {
  const still = stillPromptFor(d, s);
  if (still.refusals.length > 0) {
    throw new FactoryError('FACTORY_IDENTITY_REFUSED', still.refusals.join(' '), 422, { details: { refusals: still.refusals } });
  }
  const aspect: 'landscape' | 'portrait' = d.format === 'portrait' ? 'portrait' : 'landscape';
  const visualDescription = s.visualIntent ?? '';
  const references = referenceIdentityOf(d);
  const reviewed = reviewedReferencesOf(d);
  const c = intakeOf(d).conditioning ?? null;
  const payload = {
    v: 1,
    draftId: d.draftId,
    sceneId: s.id,
    visualDescription,
    prompt: still.prompt,
    negativePrompt: still.negativePrompt,
    aspect,
    profile: d.contentProfile,
    // Present only when the draft has style or character references, so other candidates keep their fingerprints.
    ...(references.length > 0 ? { references } : {}),
    // Each block is present only when used, so candidates made without reviews or conditioning keep their fingerprints.
    ...(reviewed.length > 0 ? { reviewed: reviewed.map((r) => ({ assetId: r.assetId, sha256: r.sha256, text: r.text })) } : {}),
    ...(c ? { conditioning: { assetId: c.assetId, strength: c.strength } } : {}),
  };
  return {
    draftId: d.draftId,
    sceneId: s.id,
    revision: d.revision,
    prompt: still.prompt,
    negativePrompt: still.negativePrompt,
    aspect,
    profile: d.contentProfile,
    visualDescription,
    fingerprint: sha256(JSON.stringify(payload)),
  };
}

/** The identity of one image shot now. Recording shots are refused. */
export function candidateIdentityFor(draftId: string, sceneId: string): CandidateIdentity {
  const d = loadDraft(draftId);
  const s = d.selection.find((x) => x.id === sceneId);
  if (!s) throw new FactoryError('FACTORY_VALIDATION', 'Unknown shot for this draft.', 422);
  if (sceneNeedOf(s) !== 'image_needed') {
    throw new FactoryError('FACTORY_VALIDATION', 'This shot is not an image shot. A screen recording is supplied by the owner, not generated.', 409, { details: { assetNeed: sceneNeedOf(s) } });
  }
  return candidateIdentityOf(d, s);
}

export type CandidateStaleReason = 'no_identity' | 'other_shot' | 'shot_missing' | 'prompt_refused' | 'prompt_changed';

export interface CandidateRef {
  draftId: string;
  sceneId: string;
  fingerprint: string | null;
}

const STALE_TEXT: Record<CandidateStaleReason, string> = {
  no_identity: 'This candidate has no record of the shot prompt it was made from. It was made before this check existed. Generate a new candidate for this shot.',
  other_shot: 'This candidate was generated for a different shot. Generate a candidate for this shot.',
  shot_missing: 'The shot this candidate was made for no longer exists in the draft.',
  prompt_refused: 'The shot now asks for branding, lettering or scripture in a religious still, so it cannot be generated or bound. Remove that request from the description.',
  prompt_changed: 'The shot description or its prompt changed after this candidate was generated, so the candidate is for an earlier prompt. Generate a new candidate for the current prompt. The earlier file is kept.',
};

/**
 * Pure freshness check of a candidate against one loaded draft. Returns the reason it is not current, or null.
 * Used under the draft lock by bind, and by GET job for display. The server is the authority, not the page.
 */
function candidateStaleIn(d: StoredDraft | null, c: CandidateRef): { reason: CandidateStaleReason; message: string; refusals?: string[] } | null {
  if (!c.fingerprint) return { reason: 'no_identity', message: STALE_TEXT.no_identity };
  if (!d) return { reason: 'shot_missing', message: STALE_TEXT.shot_missing };
  if (c.draftId !== d.draftId) return { reason: 'other_shot', message: STALE_TEXT.other_shot };
  const s = d.selection.find((x) => x.id === c.sceneId);
  if (!s || sceneNeedOf(s) !== 'image_needed') return { reason: 'shot_missing', message: STALE_TEXT.shot_missing };
  let now: CandidateIdentity;
  try {
    now = candidateIdentityOf(d, s);
  } catch (err) {
    const refusals = err instanceof FactoryError && Array.isArray(err.details?.refusals) ? (err.details!.refusals as string[]) : [];
    return { reason: 'prompt_refused', message: `${STALE_TEXT.prompt_refused} ${refusals.join(' ')}`.trim(), refusals };
  }
  if (now.fingerprint !== c.fingerprint) return { reason: 'prompt_changed', message: STALE_TEXT.prompt_changed };
  return null;
}

/** Status for display: current, or the reason it is not. Never throws. */
export function candidateStatus(c: CandidateRef): { current: boolean; reason: CandidateStaleReason | null; message: string | null } {
  let d: StoredDraft | null = null;
  try {
    d = loadDraft(c.draftId);
  } catch {
    d = null;
  }
  const stale = candidateStaleIn(d, c);
  return stale ? { current: false, reason: stale.reason, message: stale.message } : { current: true, reason: null, message: null };
}

/** Approve gate for one job. Throws FACTORY_CANDIDATE_STALE (409) when the candidate is not for the shot as it is now. */
export function assertCandidateCurrent(c: CandidateRef): void {
  let d: StoredDraft | null = null;
  try {
    d = loadDraft(c.draftId);
  } catch {
    d = null;
  }
  const stale = candidateStaleIn(d, c);
  if (stale) throw new FactoryError('FACTORY_CANDIDATE_STALE', stale.message, 409, { details: { reason: stale.reason } });
}

/**
 * Corrects the visual description of one image shot, at the reviewed draft revision. The smallest
 * correction: it replaces the shot's visual intent only. The planner's shot record (type, why,
 * assetNeed, visualRequirement) is server-owned and is not touched. A bound still stays bound until a
 * new one is bound. A screen-recording shot is refused. No provider call, no generation.
 */
export function correctStillPrompt(draftId: string, sceneId: string, body: unknown): FactoryDraftEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  const b = body as Record<string, unknown>;
  const expected = b.expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }
  const text = typeof b.visualDescription === 'string' ? b.visualDescription.trim() : '';
  if (!text) throw new FactoryError('FACTORY_VALIDATION', 'visualDescription is required.', 422);
  if (text.length > 600) throw new FactoryError('FACTORY_VALIDATION', 'visualDescription is longer than 600 characters.', 422);
  return withLock(draftId, () => {
    const d = loadDraft(draftId);
    if (expected !== d.revision) {
      throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload and correct the prompt again.', 409, { currentRevision: d.revision });
    }
    const s = d.selection.find((x) => x.id === sceneId);
    if (!s) throw new FactoryError('FACTORY_VALIDATION', 'Unknown shot for this draft.', 422);
    if (sceneNeedOf(s) !== 'image_needed') {
      throw new FactoryError('FACTORY_VALIDATION', 'Only an image shot has a still prompt. A recording is supplied by the owner.', 409);
    }
    // The correction has the same labelled form the planner must produce, and a religious still is refused a
    // brand, identity, lettering or scripture request before anything is saved.
    const problems = validateVisualDescription(text, d.contentProfile);
    if (problems.length > 0) {
      const refused = problems.some((p) => /religious still/.test(p));
      throw new FactoryError(refused ? 'FACTORY_IDENTITY_REFUSED' : 'FACTORY_VALIDATION', problems.join(' '), 422);
    }
    s.visualIntent = text;
    d.revision += 1;
    d.updatedAt = nowIso();
    refreshStatus(d);
    saveDraft(d);
    return envelopeOf(d);
  });
}

/**
 * Binds an approved still (from the local runner) to one image shot. Requires the current draft
 * revision. Replaces any earlier still on this shot. Source and licence must be recorded.
 */
export function bindLocalImage(draftId: string, body: unknown): FactoryDraftEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  const b = body as Record<string, unknown>;
  const expected = b.expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }
  const sceneId = typeof b.sceneId === 'string' ? b.sceneId : '';
  const assetId = typeof b.assetId === 'string' ? b.assetId : '';
  if (!sceneId || !assetId) throw new FactoryError('FACTORY_VALIDATION', 'sceneId and assetId are required.', 422);
  return withLock(draftId, () => {
    const d = loadDraft(draftId);
    if (expected !== d.revision) {
      throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload and bind again.', 409, { currentRevision: d.revision });
    }
    const s = d.selection.find((x) => x.id === sceneId);
    if (!s) throw new FactoryError('FACTORY_VALIDATION', 'Unknown shot for this draft.', 422);
    if (sceneNeedOf(s) !== 'image_needed') {
      throw new FactoryError('FACTORY_VALIDATION', 'Only an image shot takes a still. Recordings must be supplied by the owner.', 409);
    }
    const asset = loadAssetIndex().find((a) => a.id === assetId);
    const ref = libraryRefs().get(assetId);
    if (!asset || !ref) invalidAsset(`"${assetId}" is not an image in the library.`);
    if (ref.kind !== 'image') invalidAsset(`"${assetId}" is not an image.`);
    if (asset.status !== 'active' || asset.blocked === true) invalidAsset(`"${asset.name}" is blocked or inactive.`);
    if (!asset.source?.trim() || !asset.license?.trim()) invalidAsset(`"${asset.name}" has no recorded source and licence.`);
    // A locally generated still binds only while it is the current result for this shot. Generic library
    // images (no local candidate and not generated locally) bind as before.
    const localRecord = asset as { localCandidate?: { draftId: string; sceneId: string; fingerprint: string } | null };
    const isLocal = localRecord.localCandidate !== undefined || (asset.tags ?? []).includes('generated-locally');
    if (isLocal) {
      const cand = localRecord.localCandidate ?? null;
      const stale = candidateStaleIn(d, cand ? { draftId: cand.draftId, sceneId: cand.sceneId, fingerprint: cand.fingerprint } : { draftId: '', sceneId: '', fingerprint: null });
      if (stale) throw new FactoryError('FACTORY_CANDIDATE_STALE', stale.message, 409, { details: { reason: stale.reason } });
      if (cand && cand.sceneId !== sceneId) throw new FactoryError('FACTORY_CANDIDATE_STALE', STALE_TEXT.other_shot, 409, { details: { reason: 'other_shot' } });
    }
    // A shot-less scene (script-only draft) is an image shot by the check above. Binding a still sets assetId, and
    // without a shot record sceneNeedOf would then read it as an existing library asset and refuse every later
    // still correction. Record the need the server has just verified.
    if (!s.shot) s.shot = { type: 'image', why: 'Image shot. A still is bound to it.', assetNeed: 'image_needed', visualRequirement: s.visualIntent };
    s.assetId = assetId;
    d.revision += 1;
    d.updatedAt = nowIso();
    stampBindings(d);
    refreshStatus(d);
    saveDraft(d);
    return envelopeOf(d);
  });
}

/* ------------------------------------------------------------------ */
/* Intake changes (optional inputs)                                    */
/* ------------------------------------------------------------------ */

const isReferenceRole = (r: string | undefined) => r === 'style_reference' || r === 'character_reference';

function pruneReviews(reviews: Record<string, VisualReviewRecord>, roles: Record<string, FactoryVisualRole>, visualIds: string[]): Record<string, VisualReviewRecord> {
  return Object.fromEntries(Object.entries(reviews).filter(([id]) => visualIds.includes(id) && isReferenceRole(roles[id])));
}

function pruneConditioning(c: ConditioningSetting | null, roles: Record<string, FactoryVisualRole>, visualIds: string[], note: (reason: string) => void): ConditioningSetting | null {
  if (!c) return null;
  if (visualIds.includes(c.assetId) && isReferenceRole(roles[c.assetId])) return c;
  note('The picture that conditioned local stills is no longer a style or character reference, so conditioning was cleared.');
  return null;
}

/**
 * Reviewed descriptions and the conditioning picture (local picture analysis). Revision-checked. No planning and no
 * scene lock check: these settings change no scene. A candidate made under other settings is stale by fingerprint.
 * Refusals leave the draft unchanged.
 */
export function applyVisualReview(draftId: string, body: unknown): FactoryDraftEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  const b = body as Record<string, unknown>;
  const expected = b.expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }
  return withLock(draftId, () => {
    const d = loadDraft(draftId);
    if (expected !== d.revision) {
      throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload and make your change again.', 409, { currentRevision: d.revision });
    }
    const current = intakeOf(d);
    const index = loadAssetIndex();
    let reviews: Record<string, VisualReviewRecord> = { ...(current.visualReview ?? {}) };
    if ('visualReview' in b) {
      const incoming = b.visualReview;
      if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
        throw new FactoryError('FACTORY_VALIDATION', 'visualReview must be an object of picture id to review.', 422);
      }
      const next: Record<string, VisualReviewRecord> = {};
      for (const [assetId, raw] of Object.entries(incoming as Record<string, unknown>)) {
        if (!isReferenceRole(current.visualRoles[assetId])) {
          throw new FactoryError('FACTORY_VALIDATION', 'Only a style or character picture can have a reviewed description.', 422, { details: { assetId } });
        }
        const asset = index.find((a) => a.id === assetId);
        if (!asset) throw new FactoryError('FACTORY_VALIDATION', 'Unknown picture for this draft.', 422, { details: { assetId } });
        const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
        const jobId = typeof r.jobId === 'string' ? r.jobId : '';
        let job;
        try {
          job = getVisionJob(jobId);
        } catch {
          throw new FactoryError('FACTORY_VALIDATION', 'The analysis for this picture was not found. Analyse the picture again.', 422, { details: { assetId } });
        }
        if (job.state !== 'succeeded' || !job.observation || job.assetId !== assetId) {
          throw new FactoryError('FACTORY_VALIDATION', 'Only a finished analysis of this picture can be reviewed.', 422, { details: { assetId } });
        }
        if (!asset.sha256 || job.sha256 !== asset.sha256) {
          throw new FactoryError('FACTORY_CANDIDATE_STALE', 'The picture changed after it was analysed. Analyse it again before reviewing.', 409, { details: { assetId } });
        }
        const flags = { containsText: job.observation.containsText, containsLogoOrBrand: job.observation.containsLogoOrBrand, containsPeople: job.observation.containsPeople };
        if (r.state === 'rejected') {
          next[assetId] = { jobId, sha256: job.sha256, state: 'rejected', text: '', useInPrompts: false, flags };
          continue;
        }
        if (r.state !== 'reviewed') throw new FactoryError('FACTORY_VALIDATION', 'state must be reviewed or rejected.', 422, { details: { assetId } });
        const text = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim() : '';
        if (!text) throw new FactoryError('FACTORY_VALIDATION', 'The reviewed description is empty.', 422, { details: { assetId } });
        const refusals = reviewRefusals(text, d.contentProfile, flags);
        if (refusals.length > 0) throw new FactoryError('FACTORY_IDENTITY_REFUSED', refusals.join(' '), 422, { details: { assetId, refusals } });
        next[assetId] = { jobId, sha256: job.sha256, state: 'reviewed', text, useInPrompts: r.useInPrompts === true, flags };
      }
      reviews = next;
    }
    let conditioning: ConditioningSetting | null = current.conditioning ?? null;
    if ('conditioning' in b) {
      if (b.conditioning === null) conditioning = null;
      else {
        const c = (typeof b.conditioning === 'object' && b.conditioning !== null ? b.conditioning : {}) as Record<string, unknown>;
        const assetId = typeof c.assetId === 'string' ? c.assetId : '';
        const strength = typeof c.strength === 'number' ? Math.round(c.strength * 100) / 100 : NaN;
        if (!assetId || !isReferenceRole(current.visualRoles[assetId])) {
          throw new FactoryError('FACTORY_VALIDATION', 'The conditioning picture must be a style or character reference of this draft.', 422);
        }
        if (!Number.isFinite(strength) || strength < CONDITIONING_STRENGTH.min || strength > CONDITIONING_STRENGTH.max) {
          throw new FactoryError('FACTORY_VALIDATION', 'The strength must be from 0.10 to 1.00.', 422);
        }
        conditioning = { assetId, strength };
        const issues = conditioningIssuesOf({ ...d, intake: { ...current, conditioning } });
        if (issues.length > 0) throw new FactoryError('FACTORY_VALIDATION', issues.join(' '), 422, { details: { issues } });
      }
    }
    d.intake = { ...current, visualReview: reviews, conditioning };
    d.revision += 1;
    d.updatedAt = nowIso();
    saveDraft(d);
    return envelopeOf(d);
  });
}

export interface InvalidatedRow {
  sceneId: string;
  reason: string;
}

function idListOf(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new FactoryError('FACTORY_VALIDATION', `${field} must be an array of asset ids.`, 422);
  if (v.length > 60) throw new FactoryError('FACTORY_VALIDATION', `${field} may hold at most 60 ids.`, 422);
  return v.map((x, i) => {
    if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(x)) throw new FactoryError('FACTORY_VALIDATION', `${field}[${i}] must be an asset id.`, 422);
    return x;
  });
}

/**
 * Keep the owner's choices on a planned row when its narration and picture are unchanged. A changed narration or
 * picture takes the planned row, and the change is reported. Nothing is replaced silently.
 */
function carryOwnerChoices(prev: FactoryDraftScene, row: FactoryDraftScene, report: (reason: string) => void): FactoryDraftScene {
  if (prev.narration !== row.narration) {
    report('Its narration changed, so the planned shot is used.');
    return row;
  }
  if (prev.assetId !== row.assetId) {
    report(`Its picture changed from ${prev.assetId ?? 'none'} to ${row.assetId ?? 'none'}. The planned picture is used.`);
    return row;
  }
  return {
    ...row,
    visualIntent: prev.visualIntent,
    technique: prev.technique,
    graphic: prev.graphic,
    visualDecision: prev.visualDecision,
    speakerId: row.speakerId === null ? null : (prev.speakerId ?? row.speakerId),
  };
}

/**
 * Refusals for a post-create storyboard edit. Every check runs before any write.
 *  - IDs, count and order are fixed here (423 lock and 422 order checks come first for locked panels).
 *  - A locked panel refuses any change to its words, picture, speaker or timing (granular, per panel).
 *  - A timing change needs confirmTiming:true. Scenes must not overlap in time.
 *  - Words that differ from the approved script or the reviewed transcript need an explicit textAuthority. The approved
 *    script is never replaced by a storyboard edit; choosing 'script' refuses the change instead.
 */
function checkStoryboardEdit(
  current: StoredIntake,
  raw: unknown,
  body: Record<string, unknown>,
  selection: FactoryDraftScene[],
  reviewedTranscript: string | null,
  narrationMode: FactoryNarrationMode,
  audioAttached: boolean,
): { storyboard: FactoryStoryboardV1; notes: InvalidatedRow[] } {
  const rawScenes = raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).scenes) ? ((raw as Record<string, unknown>).scenes as unknown[]) : null;
  if (rawScenes && rawScenes.length === 0) {
    throw new FactoryError('FACTORY_STORYBOARD_EMPTY', 'A storyboard needs at least one panel. Removing the last panel is refused. Create a new draft instead.', 422);
  }
  const next = parseStoryboard(raw);
  if (!next) throw new FactoryError('FACTORY_VALIDATION', 'A storyboard is required for a storyboard edit.', 422);
  const before = current.storyboard?.scenes ?? [];
  const beforeIndex = new Map(before.map((sc, i) => [sc.id, i]));
  const nextIndex = new Map(next.scenes.map((sc, i) => [sc.id, i]));
  const nextById = new Map(next.scenes.map((sc) => [sc.id, sc]));
  const removed = before.filter((sc) => !nextIndex.has(sc.id));
  const added = next.scenes.filter((sc) => !beforeIndex.has(sc.id));
  const keptBefore = before.filter((sc) => nextIndex.has(sc.id));
  const keptAfter = next.scenes.filter((sc) => beforeIndex.has(sc.id));
  const reordered = keptBefore.map((sc) => sc.id).join('|') !== keptAfter.map((sc) => sc.id).join('|');
  const isNarrated = (sc: { narration: string }) => sc.narration.trim().length > 0;

  // Locks, per row. A locked row cannot be removed, changed, or shifted to another index by another row's operation.
  const lockedRefused: string[] = [];
  for (const prev of before) {
    const locked = prev.locked || selection.some((r) => r.sourceUnitId === prev.id && r.locked);
    if (!locked) continue;
    const row = nextById.get(prev.id);
    const changed = !row
      || row.narration !== prev.narration || row.assetId !== prev.assetId || row.speakerId !== prev.speakerId
      || row.startSec !== prev.startSec || row.endSec !== prev.endSec
      || nextIndex.get(prev.id) !== beforeIndex.get(prev.id);
    if (changed) lockedRefused.push(prev.id);
  }
  if (lockedRefused.length > 0) {
    throw new FactoryError('FACTORY_SCENE_LOCKED', `Locked panels cannot be changed, removed or moved by this edit: ${lockedRefused.join(', ')}. Unlock them first.`, 423, { details: { sceneIds: lockedRefused } });
  }

  // Structure: add, remove and reorder. Refused where it would change approved timing or supplied narration.
  const structural = removed.length > 0 || added.length > 0 || reordered;
  if (structural) {
    const sceneIds = [...removed.map((sc) => sc.id), ...added.map((sc) => sc.id)];
    if (before.some((sc) => sc.startSec !== null || sc.endSec !== null)) {
      throw new FactoryError('FACTORY_TIMED_STRUCTURE', 'Panels with timings keep their count and order, so their timing stays matched. Clear the timings of the panels you change first (that needs timing confirmation), or create a new draft.', 422, { details: { sceneIds } });
    }
    if (audioAttached) {
      throw new FactoryError('FACTORY_TIMED_STRUCTURE', 'Supplied audio is mapped to these panels. Its panels keep their count and order. Create a new draft to change them.', 422, { details: { sceneIds } });
    }
    if (narrationMode === 'supplied') {
      if (removed.some(isNarrated)) {
        throw new FactoryError('FACTORY_SUPPLIED_ORDER_CHANGED', 'Supplied narration cannot lose a panel with words. Remove only panels without words.', 422, { details: { sceneIds: removed.filter(isNarrated).map((sc) => sc.id) } });
      }
      if (added.some(isNarrated)) {
        throw new FactoryError('FACTORY_SUPPLIED_ORDER_CHANGED', 'Supplied narration cannot gain new words. A panel added here must have no words.', 422, { details: { sceneIds: added.filter(isNarrated).map((sc) => sc.id) } });
      }
      const narratedBefore = keptBefore.filter(isNarrated).map((sc) => sc.id).join('|');
      const narratedAfter = keptAfter.filter(isNarrated).map((sc) => sc.id).join('|');
      if (narratedBefore !== narratedAfter) {
        throw new FactoryError('FACTORY_SUPPLIED_ORDER_CHANGED', 'Supplied narration keeps its order. Move only panels without words.', 422, { details: { sceneIds: keptAfter.filter(isNarrated).map((sc) => sc.id) } });
      }
    }
  }

  // Each changed timing needs confirmation. Scenes must not overlap in time.
  const timing: string[] = [];
  const changedWords: { id: string; text: string }[] = [];
  for (const sc of next.scenes) {
    const prev = before.find((x) => x.id === sc.id);
    if (!prev) continue;
    if (prev.startSec !== sc.startSec || prev.endSec !== sc.endSec) timing.push(sc.id);
    if (prev.narration !== sc.narration && isNarrated(sc)) changedWords.push({ id: sc.id, text: sc.narration });
  }
  for (let i = 1; i < next.scenes.length; i += 1) {
    const a = next.scenes[i - 1];
    const b2 = next.scenes[i];
    if (a.endSec !== null && b2.startSec !== null && b2.startSec < a.endSec) {
      throw new FactoryError('FACTORY_VALIDATION', `Scene ${b2.id} starts before scene ${a.id} ends. Timing must not overlap.`, 422, { details: { sceneIds: [a.id, b2.id] } });
    }
  }
  if (timing.length > 0 && body.confirmTiming !== true) {
    throw new FactoryError('FACTORY_TIMING_CONFIRMATION_REQUIRED', 'These timings change. Confirm the timing change to save it.', 422, { details: { sceneIds: timing } });
  }
  const authorityIn = 'textAuthority' in body ? body.textAuthority : current.textAuthority;
  if (authorityIn !== null && authorityIn !== undefined && !(FACTORY_TEXT_AUTHORITIES as readonly unknown[]).includes(authorityIn)) {
    throw new FactoryError('FACTORY_VALIDATION', 'textAuthority must be script, storyboard or transcript.', 422);
  }
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  const sources: { name: 'script' | 'transcript'; text: string }[] = [];
  if (current.scriptText && current.scriptText.trim().length > 0) sources.push({ name: 'script', text: current.scriptText });
  if (reviewedTranscript) sources.push({ name: 'transcript', text: reviewedTranscript });
  const conflicts: { sceneId: string; against: 'script' | 'transcript' }[] = [];
  for (const w of changedWords) {
    for (const src of sources) {
      if (!norm(src.text).includes(norm(w.text))) conflicts.push({ sceneId: w.id, against: src.name });
    }
  }
  const notes: InvalidatedRow[] = [];
  if (conflicts.length > 0) {
    if (!('textAuthority' in body)) {
      throw new FactoryError('FACTORY_TEXT_CONFLICT', 'These storyboard words differ from the script or the reviewed transcript. Choose which text is authoritative (textAuthority) and send the edit again. Nothing was saved.', 422, { details: { conflicts } });
    }
    if (body.textAuthority === 'script' && conflicts.some((c) => c.against === 'script')) {
      throw new FactoryError('FACTORY_APPROVED_TEXT_IMMUTABLE', 'The approved script is immutable. Choose storyboard or transcript as the text authority, or make a derived edit of the script.', 422, { details: { conflicts } });
    }
    for (const c of conflicts) notes.push({ sceneId: c.sceneId, reason: `Its words differ from the ${c.against === 'script' ? 'approved script' : 'reviewed transcript'}. The textAuthority you chose (${String(body.textAuthority)}) is used.` });
  }
  return { storyboard: next, notes };
}

/**
 * Change the optional inputs of a draft: narration mode, text authority, captions, picture roles and notes, the
 * pictures themselves, and an attached transcript. Text is not changed here. Revision-checked. A locked scene
 * refuses the change. Unchanged owner choices are kept; every replaced or dropped row is listed in `invalidated`.
 */
export function patchIntake(draftId: string, body: unknown): FactoryDraftEnvelope & { invalidated: InvalidatedRow[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  }
  const b = body as Record<string, unknown>;
  const expected = b.expectedRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be a non-negative integer.', 422);
  }
  return withLock(draftId, () => {
    const d = loadDraft(draftId);
    if (expected !== d.revision) {
      throw new FactoryError('FACTORY_REVISION_CONFLICT', 'The draft changed since you loaded it. Reload and make your change again.', 409, { currentRevision: d.revision });
    }
    if (d.source.generatedJobId) {
      throw new FactoryError('FACTORY_VALIDATION', 'A generated plan keeps its own treatments and speakers. Intake changes apply to local-rule drafts; create a new draft to change them.', 422);
    }
    // Other intake changes refuse while any scene is locked. A storyboard edit checks each panel instead (below).
    if (!('storyboard' in b) && d.selection.some((r) => r.locked)) {
      throw new FactoryError('FACTORY_SCENE_LOCKED', 'A locked scene is in the current selection. Unlock it before changing the intake, so its words and picture are not replaced.', 423);
    }
    const current = intakeOf(d);
    const storyboardIds = (current.storyboard?.scenes ?? []).map((sc) => sc.assetId).filter((x): x is string => !!x);
    const requestedIds = 'visualAssetIds' in b ? idListOf(b.visualAssetIds, 'visualAssetIds') : d.source.visualAssetIds;
    const nextVisualIds = [...new Set([...requestedIds, ...storyboardIds])];
    validateVisualIds(nextVisualIds, 'visualAssetIds');

    const invalidated: InvalidatedRow[] = [];
    // A role or note for a picture that is no longer supplied is dropped, and the drop is listed.
    const droppedRoles = Object.keys(current.visualRoles).filter((id) => !nextVisualIds.includes(id));
    const droppedNotes = Object.keys(current.visualNotes).filter((id) => !nextVisualIds.includes(id));
    for (const id of new Set([...droppedRoles, ...droppedNotes])) {
      const usedBy = d.selection.find((r) => r.assetId === id);
      invalidated.push({ sceneId: usedBy?.id ?? '-', reason: `Picture ${id} is no longer supplied, so its role and note were dropped.` });
    }
    const keepIds = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).filter(([k]) => nextVisualIds.includes(k)));

    const transcriptJobId = 'transcriptJobId' in b ? (b.transcriptJobId === null ? null : (typeof b.transcriptJobId === 'string' ? b.transcriptJobId : null)) : current.transcriptJobId;
    if (transcriptJobId && !loadJob(transcriptJobId)) {
      throw new FactoryError('FACTORY_VALIDATION', 'transcriptJobId does not name a transcription job.', 422);
    }
    const parsed = parseIntakeOptions(
      {
        narrationMode: 'narrationMode' in b ? b.narrationMode : current.narrationMode,
        textAuthority: 'textAuthority' in b ? b.textAuthority : current.textAuthority,
        captions: 'captions' in b ? b.captions : current.captions,
        visualRoles: 'visualRoles' in b ? b.visualRoles : keepIds(current.visualRoles),
        visualNotes: 'visualNotes' in b ? b.visualNotes : keepIds(current.visualNotes),
        transcriptJobId,
      },
      nextVisualIds,
    );
    // Post-create storyboard edit: checked in full before anything is written. Refusals leave the draft unchanged.
    let storyboardNext = current.storyboard;
    const textNotes: InvalidatedRow[] = [];
    if ('storyboard' in b) {
      const reviewed = current.transcriptJobId ? loadJob(current.transcriptJobId) : null;
      const reviewedTranscript = reviewed && reviewed.reviewedText !== null && reviewed.audioSha256 === d.source.audioSha256 ? reviewed.reviewedText : null;
      const checked = checkStoryboardEdit(current, b.storyboard, b, d.selection, reviewedTranscript, narrationModeOf(d), d.source.audioAssetId !== null);
      storyboardNext = checked.storyboard;
      textNotes.push(...checked.notes);
      invalidated.push(...textNotes);
    }
    const nextIntake: StoredIntake = {
      ...current,
      storyboard: storyboardNext,
      narrationMode: parsed.narrationMode,
      textAuthority: parsed.textAuthority,
      captions: parsed.captions,
      visualRoles: parsed.visualRoles,
      visualNotes: parsed.visualNotes,
      // A reviewed description stays only for a style or character picture that is still supplied. The rest are dropped.
      visualReview: pruneReviews(current.visualReview ?? {}, parsed.visualRoles, nextVisualIds),
      conditioning: pruneConditioning(current.conditioning ?? null, parsed.visualRoles, nextVisualIds, (reason) => invalidated.push({ sceneId: '-', reason })),
      transcriptJobId: parsed.transcriptJobId,
    };
    // Plan with the new intake. Nothing is written until the whole plan succeeds.
    const trial: StoredDraft = { ...d, intake: nextIntake, source: { ...d.source, visualAssetIds: nextVisualIds } };
    const planned = planInputsOf(trial);
    const plan = planFactoryDraft(planned.input, planned.opts);

    const previousSelected = d.selectedTreatmentId;
    const previousRows = (treatmentId: string): FactoryDraftScene[] => (treatmentId === previousSelected ? d.selection : (d.proposals[treatmentId] ?? []));
    const carry = (treatmentId: string, rows: FactoryDraftScene[]): FactoryDraftScene[] => {
      const isPrevious = treatmentId === previousSelected;
      const prevById = new Map(previousRows(treatmentId).map((r) => [r.sourceUnitId, r]));
      const matched = new Set<string>();
      const out = rows.map((row) => {
        const prev = prevById.get(row.sourceUnitId);
        if (!prev) return row;
        matched.add(prev.sourceUnitId);
        return carryOwnerChoices(prev, row, (reason) => {
          if (isPrevious) invalidated.push({ sceneId: row.id, reason });
        });
      });
      if (isPrevious) {
        for (const prev of prevById.values()) {
          if (!matched.has(prev.sourceUnitId)) invalidated.push({ sceneId: prev.id, reason: 'This scene is no longer in the draft.' });
        }
      }
      return out;
    };
    const selectedId = plan.treatments.some((t) => t.id === previousSelected) ? previousSelected : plan.selectedTreatmentId;
    const treatments = plan.treatments.map((t) => ({ ...t, scenes: carry(t.id, t.scenes) }));
    if (previousSelected !== null && !plan.treatments.some((t) => t.id === previousSelected)) {
      invalidated.push({ sceneId: '-', reason: 'The previously selected treatment is no longer produced, so the first treatment is selected.' });
    }

    const identity = identityFor(d.contentProfile, d.channelBrandId);
    const warnings = [...plan.warnings];
    if (identity.refusal) warnings.push(identity.refusal);
    d.intake = nextIntake;
    if ('storyboard' in b && storyboardNext) d.source.storyboardSha256 = sha256(JSON.stringify(storyboardNext));
    d.source.visualAssetIds = nextVisualIds;
    d.units = plan.units;
    d.treatments = treatments.map((t) => ({ id: t.id, title: t.title, rationale: t.rationale }));
    d.proposals = Object.fromEntries(treatments.map((t) => [t.id, t.scenes]));
    d.selectedTreatmentId = selectedId;
    d.selection = treatments.find((t) => t.id === selectedId)?.scenes ?? [];
    // Silent drafts have no speakers. Other drafts take the planned speakers, which are the same set for the same inputs.
    d.speakers = narrationModeOf(trial) === 'none' ? [] : plan.speakers;
    d.warnings = warnings;
    d.revision += 1;
    d.updatedAt = nowIso();
    refreshStatus(d);
    saveDraft(d);
    return { ...envelopeOf(d), invalidated };
  });
}

/* ------------------------------------------------------------------ */
/* Transcription jobs (audio-only drafts)                              */
/* ------------------------------------------------------------------ */

function asFactoryError(err: unknown): never {
  if (err instanceof TranscriptionRefused) throw new FactoryError(err.code as FactoryErrorCode, err.message, err.status);
  throw err;
}

/** Start a local transcription of a supplied audio asset. Without a configured runner the job is `unavailable`. */
export function createTranscription(body: unknown): { status: 200 | 201; body: TranscriptionJob } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  const id = (body as Record<string, unknown>).audioAssetId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new FactoryError('FACTORY_VALIDATION', 'audioAssetId is required.', 422);
  const audio = validateAudio(id);
  const file = assetFileOf(id);
  if (!file) invalidAsset('The audio asset file is not present in the library.');
  const started = startJob({ audioAssetId: id, audioFile: file, audioDurationSec: audio.durationSec, rerun: (body as Record<string, unknown>).rerun === true });
  return { status: started.created ? 201 : 200, body: started.job };
}

export function getTranscription(jobId: string): TranscriptionJob {
  const job = loadJob(jobId);
  if (!job) throw new FactoryError('FACTORY_TRANSCRIPTION_NOT_FOUND', 'No such transcription job.', 404);
  return job;
}

export function cancelTranscriptionJob(jobId: string): TranscriptionJob {
  try {
    return cancelJob(jobId);
  } catch (err) {
    return asFactoryError(err);
  }
}

export function reviewTranscriptionJob(jobId: string, body: unknown): TranscriptionJob {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FactoryError('FACTORY_VALIDATION', 'Request body must be a JSON object.', 422);
  const b = body as Record<string, unknown>;
  if (typeof b.text !== 'string') throw new FactoryError('FACTORY_VALIDATION', 'text must be the reviewed transcript.', 422);
  if (typeof b.expectedRevision !== 'number' || !Number.isInteger(b.expectedRevision)) {
    throw new FactoryError('FACTORY_VALIDATION', 'expectedRevision must be an integer.', 422);
  }
  try {
    return reviewJob(jobId, b.text, b.expectedRevision);
  } catch (err) {
    return asFactoryError(err);
  }
}
