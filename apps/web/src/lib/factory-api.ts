import type { EditorGraphic, VisualTechniqueId } from '@buildtrack/core';
/**
 * Typed client for the Milestone 2 content-planning API (`/api/factory/*`).
 *
 * Contract source: FACTORY_CONTRACT_V1 in @buildtrack/core (types mirrored here
 * so the browser bundle never imports the core barrel). Requests go through the
 * same-origin dev proxy. There is no fallback data: a failed request is a failed
 * request, and the error object says whether the server answered.
 */

export type FactoryProfile = 'religious' | 'educational' | 'promotional';
export type FactoryFormat = 'landscape' | 'portrait';
export type FactoryDraftStatus = 'review_required' | 'blocked';
export type FactoryTimingSource = 'unknown' | 'supplied' | 'measured_synthesis' | 'estimated_text_length';
export type FactoryAssetOrigin = 'supplied' | 'library' | 'reviewer' | null;
export type FactoryMissingKind = 'script' | 'transcription' | 'speech' | 'image' | 'recording' | 'speaker' | 'timing' | 'asset' | 'review';

export interface FactoryMissingItem {
  kind: FactoryMissingKind;
  sceneId: string | null;
  reason: string;
}

export interface FactoryVisualDecision {
  framing: 'full' | 'tight';
  motion: 'none' | 'slow_push' | 'pan_left' | 'pan_right';
  unexecuted: string[];
}

export interface FactoryDraftScene {
  id: string;
  narration: string;
  speakerId: string | null;
  visualIntent: string;
  assetId: string | null;
  startSec: number | null;
  endSec: number | null;
  locked: boolean;
  sourceUnitId: string;
  beat: string;
  language: 'ar' | 'en' | 'und';
  assetOrigin: FactoryAssetOrigin;
  timingSource: FactoryTimingSource;
  visualDecision: FactoryVisualDecision;
  /** Server-owned shot record. Sent back unchanged on every patch; the server rejects a changed value. */
  shot?: Record<string, unknown>;
  /** Per-shot technique from the visual-language registry. Absent or null: the scene renders as before. */
  technique?: VisualTechniqueId | null;
  /** Procedural graphic with supplied values. Validated by the server. */
  graphic?: EditorGraphic | null;
}

export interface FactoryTreatment {
  id: string;
  title: string;
  rationale: string;
  orderLocked: boolean;
  structure: string[];
  scenes: FactoryDraftScene[];
}

export interface FactorySpeaker {
  id: string;
  voiceId: string | null;
  available: boolean;
  /** 'gemini' for generated speakers. Absent on local drafts. */
  provider?: 'sam' | 'gemini';
  /** Delivery style for Gemini speakers. Never spoken. */
  style?: string;
}

export interface FactoryAppliedProject {
  projectId: string;
  editorRevision: number;
  timingSource: string;
  appliedAt: string;
  /** Absent on records made before reuse tracking. */
  draftRevision?: number;
}

/** Predicted timing before apply. Labels are the server's exact strings. */
export interface FactoryTimingPlan {
  timingSource: FactoryTimingSource;
  label: string;
}

/** Timing provenance for an applied project (GET /api/factory/projects/:id/timing). */
export type FactoryTimingStatusKind = 'legacy' | 'applied' | 'edited' | 'alignment_accepted';

export interface FactoryTimingStatus {
  projectId: string;
  editorRevision: number | null;
  status: FactoryTimingStatusKind;
  label: string;
  appliedSource: string | null;
  appliedLabel: string;
  alignmentStatus: string | null;
  boundariesEdited: boolean | null;
}

export interface FactoryDraftEnvelope {
  draftId: string;
  revision: number;
  status: FactoryDraftStatus;
  generationMode: 'local_rules' | 'gemini_plan';
  speechOrderLocked: boolean;
  selectedTreatmentId: string | null;
  /** Draft-level visual language. Null for drafts that have not chosen one (legacy behaviour). */
  visualLanguage?: string | null;
  /** Per-shot readiness for the selected technique, from real bindings and runtime facts. */
  visualReadiness?: Array<{ sceneId: string; technique: string | null; state: string; reason: string }>;
  treatments: FactoryTreatment[];
  speakers: FactorySpeaker[];
  missing: FactoryMissingItem[];
  warnings: string[];
  appliedProjects: FactoryAppliedProject[];
  /** Additive. Absent when talking to a server that predates timing provenance. */
  timingPlan?: FactoryTimingPlan;
  /** Set on a derived rewrite: the source draft and the per-unit before and after text. */
  derivedFrom?: FactoryDerivation | null;
  /** Revision a reviewer confirmed this derived rewrite at. Null until reviewed. */
  reviewedRevision?: number | null;
  profile: { contentProfile: FactoryProfile; format: FactoryFormat; channelBrandId: string | null };
  inputs: {
    audioAssetId: string | null;
    audioDurationSec: number | null;
    visualAssetIds: string[];
    scriptSupplied: boolean;
    storyboardSupplied: boolean;
  };
}

export interface FactoryDerivation {
  draftId: string;
  revision: number;
  rootDraftId: string;
  changes: Array<{ unitId: string; before: string; after: string }>;
}

export interface DeriveBody {
  expectedRevision: number;
  edits: Array<{ unitId: string; narration: string }>;
}

export interface FactoryVoice {
  id: string;
  language: 'en';
  speakerLabel: string;
}

export interface FactoryEngineStatus {
  id: string;
  available: boolean;
  reason: string;
}

export interface FactoryCapabilities {
  version: 1;
  text: { available: boolean; mode: 'local_rules' | 'configured_provider' | 'unavailable'; reason: string };
  speech: {
    available: boolean;
    reason: string;
    voices: FactoryVoice[];
    languages: Record<string, { available: boolean; reason: string }>;
    engines: FactoryEngineStatus[];
  };
  image: { available: boolean; reason: string };
  transcription: { available: boolean; reason: string };
  storyboardImport: { available: boolean; reason: string };
  /** Visual-language registry with runtime facts. Absent on servers that predate it. */
  visualLanguages?: {
    version: 1;
    runtime: { localImage: 'ready' | 'setup_required' | 'unknown' };
    languages: Array<{
      id: string; label: string; summary: string; engine: string; requiredInputs: string[]; capability: string; reason: string;
      techniques: Array<{ id: string; label: string; state: string; reason: string }>;
    }>;
    unavailable: Array<{ id: string; label: string; reason: string }>;
  };
}

export interface FactoryApplyResult {
  projectId: string;
  targetId: 'long';
  format: FactoryFormat;
  editorRevision: number;
  timingSource: string;
  /** Additive. Exact label for the applied source. */
  timingLabel?: string;
  speechGenerated: number;
  /** Additive. True when an existing application for this draft revision was returned. */
  reused?: boolean;
}

export interface FactoryCreateBody {
  contentProfile: FactoryProfile;
  format: FactoryFormat;
  channelBrandId: string | null;
  inputs: {
    brief: string;
    script: string | null;
    audioAssetId: string | null;
    visualAssetIds: string[];
    storyboard: { version: 1; scenes: Array<Record<string, unknown>> } | null;
  };
  requestedSpeakers: Array<{ id: string; voiceId: string | null }>;
  referenceProjectId: null;
  /** Project visual language. Null = legacy project with no per-shot techniques. */
  visualLanguage?: string | null;
}

export interface FactoryPatchBody {
  expectedRevision: number;
  selectedTreatmentId: string;
  scenes: Array<Pick<FactoryDraftScene, 'id' | 'narration' | 'speakerId' | 'visualIntent' | 'assetId' | 'startSec' | 'endSec' | 'locked'>
    & Partial<Pick<FactoryDraftScene, 'sourceUnitId' | 'beat' | 'language' | 'assetOrigin' | 'timingSource' | 'visualDecision' | 'shot' | 'technique' | 'graphic'>>>;
  speakers: Array<{ id: string; voiceId: string | null }>;
  /** Absent keeps the draft's language. null clears it. */
  visualLanguage?: string | null;
  /** Language change only: discard per-shot technique and graphic choices made for the old language. */
  resetShotTechniques?: boolean;
}

/**
 * A failed call. `answered` is false when no HTTP reply arrived (transport
 * failure). In that case the caller must NOT report that the change happened.
 */
export class FactoryApiError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly answered: boolean;
  readonly missing: FactoryMissingItem[];
  readonly currentRevision: number | null;
  /** Safe extra fields from the server (for example speechCalls, remaining). */
  readonly details: Record<string, unknown>;

  constructor(opts: { message: string; status: number | null; code: string; answered: boolean; missing?: FactoryMissingItem[]; currentRevision?: number | null; details?: Record<string, unknown> }) {
    super(opts.message);
    this.name = 'FactoryApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.answered = opts.answered;
    this.missing = opts.missing ?? [];
    this.currentRevision = opts.currentRevision ?? null;
    this.details = opts.details ?? {};
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, asText = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new FactoryApiError({
      message: 'The server did not reply. Nothing is confirmed. Reload the draft before doing anything else.',
      status: null,
      code: 'TRANSPORT',
      answered: false,
    });
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new FactoryApiError({
      message: typeof data?.error === 'string' ? data.error : `The request failed (${res.status}).`,
      status: res.status,
      code: typeof data?.code === 'string' ? data.code : 'FACTORY_HTTP',
      answered: true,
      missing: Array.isArray(data?.missing) ? data.missing : [],
      currentRevision: typeof data?.currentRevision === 'number' ? data.currentRevision : null,
      details: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
    });
  }
  if (asText) return text as unknown as T;
  return data as T;
}

/** The surface the pages use. Tests may pass a different implementation; production uses `factoryApi`. */
export interface FactoryClient {
  capabilities(): Promise<FactoryCapabilities>;
  createDraft(body: FactoryCreateBody): Promise<FactoryDraftEnvelope>;
  getDraft(draftId: string): Promise<FactoryDraftEnvelope>;
  patchDraft(draftId: string, body: FactoryPatchBody): Promise<FactoryDraftEnvelope>;
  applyDraft(draftId: string, expectedRevision: number): Promise<FactoryApplyResult>;
  projectTiming(projectId: string): Promise<FactoryTimingStatus>;
}

export const factoryApi: FactoryClient = {
  capabilities: () => call<FactoryCapabilities>('GET', '/api/factory/capabilities'),
  createDraft: (body) => call<FactoryDraftEnvelope>('POST', '/api/factory/drafts', body),
  getDraft: (draftId) => call<FactoryDraftEnvelope>('GET', `/api/factory/drafts/${encodeURIComponent(draftId)}`),
  patchDraft: (draftId, body) => call<FactoryDraftEnvelope>('PATCH', `/api/factory/drafts/${encodeURIComponent(draftId)}`, body),
  applyDraft: (draftId, expectedRevision) =>
    call<FactoryApplyResult>('POST', `/api/factory/drafts/${encodeURIComponent(draftId)}/apply`, { expectedRevision }),
  projectTiming: (projectId) => call<FactoryTimingStatus>('GET', `/api/factory/projects/${encodeURIComponent(projectId)}/timing`),
};

/* ------------------------------------------------------------------ */
/* Generated plans (Milestone 3). Same routes as the server, typed here.*/
/* Gemini calls only happen on an explicit POST. Reads never call them. */
/* ------------------------------------------------------------------ */

/** Mirrors GEMINI_PREBUILT_VOICES in @buildtrack/core. A test asserts the two lists are equal. */
export const GEMINI_VOICE_NAMES: readonly string[] = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

export type AiJobKind = 'plan' | 'speech_preview';
export type AiJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface AiJob {
  id: string;
  kind: AiJobKind;
  status: AiJobStatus;
  model: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error: { code: string; message: string } | null;
  result: Record<string, unknown> | null;
}

export interface AiStatus {
  planner?: { ready: boolean; reason: string; model: string | null; route: 'local_llm'; googleUsed: false };
  state: 'credentials_missing' | 'catalog_reachable' | 'ready' | 'quota_blocked' | 'live_test_unverified';
  credentialsPresent: boolean;
  generationEnabled: boolean;
  freeTierConfirmed: boolean;
  models: { text: string; tts: string };
  budget: { session: string; caps: { textRequests: number; voicePreviews: number; productionTurns?: number }; used: { text: number; voice: number; production: number } };
  productionSpeech: Record<'ar' | 'en', { ready: boolean; reason: string }>;
  verification: { binding: 'none' | 'current' | 'mismatch'; speechLanguagesLive: string[] } | null;
  note: string;
}

export interface PlanReference {
  id: string;
  text: string;
}

export interface PlanRequestBody {
  profile: 'educational' | 'religious' | 'promotional';
  format: FactoryFormat;
  brief: string;
  references?: PlanReference[];
  productFacts?: PlanReference[];
  productMentionRequested?: boolean;
  idempotencyKey?: string;
}

export interface ApplyPreview {
  draftId: string;
  revision: number;
  canApply: boolean;
  reused: boolean;
  blockers: FactoryMissingItem[];
  speechCalls: number;
  sceneIds: string[];
  budget: { cap: number; used: number; remaining: number };
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
  /** The assigned library asset, whatever its status. Null when nothing is assigned. */
  boundAssetId: string | null;
  status: 'bound' | 'missing' | 'blocked' | 'changed' | 'incompatible';
  /** Why the scene is not bound. Null when bound. */
  reason: string | null;
  mediaType: 'image' | 'video' | null;
  source: string | null;
  license: string | null;
  prompt: string | null;
  /** The composed still prompt for every image shot (bound or not), so a replacement can be reviewed. Null for recordings. */
  imagePrompt: string | null;
  /** The shot's current visual description (the text the prompt is built from). Edit it to correct the prompt. */
  visualDescription: string | null;
  /** This shot's own negative conditioning (text, branding, and its Exclude part). Null for recordings. */
  negativePrompt: string | null;
  /** Reasons to look again before generating (for example a non-structured description). */
  promptWarnings: string[];
  /** Religious-content refusals for this shot's prompt (branding, lettering, scripture). Non-empty: it cannot be generated. */
  promptRefusals: string[];
  screenRecordingBrief: string | null;
}

export interface ShotList {
  draftId: string;
  revision: number;
  format: FactoryFormat;
  aspect: string;
  treatmentId: string | null;
  scenes: ShotListScene[];
}

export interface GeneratedPatchBody {
  expectedRevision: number;
  edits?: Array<{ unitId: string; narration: string }>;
  speakers?: Array<{ id: string; voice?: string; style?: string }>;
}

export interface SpeechPreviewBody {
  text: string;
  voice: string;
  language: 'ar' | 'en';
  style?: string;
  idempotencyKey?: string;
}

export interface FactoryAiClient {
  savedVoices?(): Promise<{ voices: GoogleVoice[] }>;
  loadVoices?(filters: { search?: string; language_code?: string; gender?: string; page_token?: string }): Promise<{ voices: GoogleVoice[]; nextPageToken: string }>;
  aiStatus(): Promise<AiStatus>;
  startPlan(body: PlanRequestBody): Promise<{ job: AiJob; reused: boolean }>;
  getJob(jobId: string): Promise<AiJob>;
  cancelJob(jobId: string): Promise<AiJob>;
  planDraft(jobId: string, body: { format: FactoryFormat }): Promise<FactoryDraftEnvelope>;
  patchGenerated(draftId: string, body: GeneratedPatchBody): Promise<FactoryDraftEnvelope>;
  startSpeechPreview(body: SpeechPreviewBody): Promise<{ job: AiJob; reused: boolean }>;
  /** Same-origin URL for a finished preview's WAV. The browser fetches it; nothing is sent to Google. */
  previewAudioUrl(jobId: string): string;
  applyPreview(draftId: string): Promise<ApplyPreview>;
  /** `confirmSpeechCalls` must equal the count the user saw in applyPreview. Absent = the safe refusal. */
  applyGenerated(draftId: string, expectedRevision: number, confirmSpeechCalls?: number): Promise<FactoryApplyResult>;
  shotList(draftId: string): Promise<ShotList>;
  shotListMarkdownUrl(draftId: string): string;
  /** Derived rewrite of narration. The source draft is not changed. The new draft needs review. No provider call. */
  deriveDraft(draftId: string, body: DeriveBody): Promise<FactoryDraftEnvelope>;
  /** Reviewer confirmation at the revision that was read. No provider call. */
  reviewDerived(draftId: string, expectedRevision: number): Promise<FactoryDraftEnvelope>;
}

export const factoryAi: FactoryAiClient = {
  savedVoices: () => call('GET', '/api/factory/ai/voices'),
  loadVoices: (filters) => call('POST', '/api/factory/ai/voices/refresh', filters),
  aiStatus: () => call<AiStatus>('GET', '/api/factory/ai/status'),
  startPlan: (body) => call<{ job: AiJob; reused: boolean }>('POST', '/api/factory/ai/plans', body),
  getJob: (jobId) => call<{ job: AiJob }>('GET', `/api/factory/ai/jobs/${encodeURIComponent(jobId)}`).then((r) => r.job),
  cancelJob: (jobId) => call<{ job: AiJob }>('POST', `/api/factory/ai/jobs/${encodeURIComponent(jobId)}/cancel`).then((r) => r.job),
  planDraft: (jobId, body) => call<FactoryDraftEnvelope>('POST', `/api/factory/ai/plans/${encodeURIComponent(jobId)}/draft`, body),
  patchGenerated: (draftId, body) => call<FactoryDraftEnvelope>('PATCH', `/api/factory/drafts/${encodeURIComponent(draftId)}/generated`, body),
  startSpeechPreview: (body) => call<{ job: AiJob; reused: boolean }>('POST', '/api/factory/ai/speech-previews', body),
  previewAudioUrl: (jobId) => `/api/factory/ai/jobs/${encodeURIComponent(jobId)}/audio`,
  applyPreview: (draftId) => call<ApplyPreview>('GET', `/api/factory/drafts/${encodeURIComponent(draftId)}/apply-preview`),
  applyGenerated: (draftId, expectedRevision, confirmSpeechCalls) =>
    call<FactoryApplyResult>(
      'POST',
      `/api/factory/drafts/${encodeURIComponent(draftId)}/apply`,
      confirmSpeechCalls === undefined ? { expectedRevision } : { expectedRevision, confirmSpeechCalls },
    ),
  shotList: (draftId) => call<ShotList>('GET', `/api/factory/drafts/${encodeURIComponent(draftId)}/shot-list`),
  shotListMarkdownUrl: (draftId) => `/api/factory/drafts/${encodeURIComponent(draftId)}/shot-list?format=md`,
  deriveDraft: (draftId, body) => call<FactoryDraftEnvelope>('POST', `/api/factory/drafts/${encodeURIComponent(draftId)}/derive`, body),
  reviewDerived: (draftId, expectedRevision) =>
    call<FactoryDraftEnvelope>('POST', `/api/factory/drafts/${encodeURIComponent(draftId)}/review`, { expectedRevision }),
};

export interface GoogleVoice {
  id: string; name: string; description: string; language: string; gender: string; pitch: string; persona: string;
}

/** Text download for the markdown shot list (same route, no provider call). */
export const fetchShotListMarkdown = (draftId: string) =>
  call<string>('GET', `/api/factory/drafts/${encodeURIComponent(draftId)}/shot-list?format=md`, undefined, true);


/* ------------------------------------------------------------------ */
/* Local still images (owner's computer). No Google, no provider, no spend. */
/* ------------------------------------------------------------------ */

export interface LocalImageStatus {
  state: 'setup_required' | 'ready';
  ready: boolean;
  reason: string;
  missing: string[];
  project: string;
  release: string;
  backend: 'cpu' | 'vulkan';
  steps: number;
  timeoutSec: number;
  googleUsed: false;
  paidSpend: false;
  jobsAtOnce: 1;
  busy: boolean;
  model: {
    name: string;
    license: string;
    upstreamSha256: string;
    recordedMatchesUpstream: boolean | null;
    sha256Pinned: boolean;
    sha256Matches: boolean | null;
  };
  flagsChecked: string[];
  flagsMissing: string[];
}

export type LocalImageJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';

export interface LocalImageJob {
  id: string;
  draftId: string;
  sceneId: string;
  state: LocalImageJobState;
  progress: number;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  backend: 'cpu' | 'vulkan';
  error: { code: string; message: string } | null;
  approvedAssetId: string | null;
  /** Server-decided freshness of this candidate for its shot. current false: it cannot be approved or bound. */
  candidate?: { current: boolean; reason: string | null; message: string | null } | null;
  provenance: null | {
    project: string;
    release: string;
    modelName: string;
    modelSha256: string;
    modelLicense: string;
    promptSha256: string;
    negativePromptSha256?: string;
    seed: number;
    width: number;
    height: number;
    steps: number;
    backend: string;
    outputSha256: string;
    generatedAt: string;
  };
}

export interface LocalImageClient {
  status(): Promise<LocalImageStatus>;
  start(body: { draftId: string; sceneId: string; expectedRevision: number; seed?: number }): Promise<LocalImageJob>;
  job(jobId: string): Promise<LocalImageJob>;
  cancel(jobId: string): Promise<LocalImageJob>;
  approve(jobId: string): Promise<{ job: LocalImageJob; assetId: string }>;
  /** Same-origin URL of the candidate PNG. Served only after it decodes again. */
  imageUrl(jobId: string): string;
  bind(draftId: string, body: { expectedRevision: number; sceneId: string; assetId: string }): Promise<FactoryDraftEnvelope>;
  /** Corrects one image shot's visual description at the reviewed revision. No generation. */
  correctPrompt(draftId: string, sceneId: string, body: { expectedRevision: number; visualDescription: string }): Promise<FactoryDraftEnvelope>;
}

export const localImageApi: LocalImageClient = {
  status: () => call<LocalImageStatus>('GET', '/api/local-images/status'),
  start: (body) => call<LocalImageJob>('POST', '/api/local-images/jobs', body),
  job: (jobId) => call<LocalImageJob>('GET', `/api/local-images/jobs/${encodeURIComponent(jobId)}`),
  cancel: (jobId) => call<LocalImageJob>('POST', `/api/local-images/jobs/${encodeURIComponent(jobId)}/cancel`),
  approve: (jobId) => call<{ job: LocalImageJob; assetId: string }>('POST', `/api/local-images/jobs/${encodeURIComponent(jobId)}/approve`),
  imageUrl: (jobId) => `/api/local-images/jobs/${encodeURIComponent(jobId)}/image`,
  bind: (draftId, body) => call<FactoryDraftEnvelope>('POST', `/api/factory/drafts/${encodeURIComponent(draftId)}/bind-image`, body),
  correctPrompt: (draftId, sceneId, body) =>
    call<FactoryDraftEnvelope>('POST', `/api/factory/drafts/${encodeURIComponent(draftId)}/scenes/${encodeURIComponent(sceneId)}/still-prompt`, body),
};
