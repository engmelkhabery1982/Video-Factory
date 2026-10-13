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
export type FactoryMissingKind = 'script' | 'transcription' | 'speech' | 'image' | 'speaker' | 'timing' | 'asset';

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
  treatments: FactoryTreatment[];
  speakers: FactorySpeaker[];
  missing: FactoryMissingItem[];
  warnings: string[];
  appliedProjects: FactoryAppliedProject[];
  /** Additive. Absent when talking to a server that predates timing provenance. */
  timingPlan?: FactoryTimingPlan;
  profile: { contentProfile: FactoryProfile; format: FactoryFormat; channelBrandId: string | null };
  inputs: {
    audioAssetId: string | null;
    audioDurationSec: number | null;
    visualAssetIds: string[];
    scriptSupplied: boolean;
    storyboardSupplied: boolean;
  };
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
}

export interface FactoryPatchBody {
  expectedRevision: number;
  selectedTreatmentId: string;
  scenes: Array<Pick<FactoryDraftScene, 'id' | 'narration' | 'speakerId' | 'visualIntent' | 'assetId' | 'startSec' | 'endSec' | 'locked'>
    & Partial<Pick<FactoryDraftScene, 'sourceUnitId' | 'beat' | 'language' | 'assetOrigin' | 'timingSource' | 'visualDecision'>>>;
  speakers: Array<{ id: string; voiceId: string | null }>;
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

  constructor(opts: { message: string; status: number | null; code: string; answered: boolean; missing?: FactoryMissingItem[]; currentRevision?: number | null }) {
    super(opts.message);
    this.name = 'FactoryApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.answered = opts.answered;
    this.missing = opts.missing ?? [];
    this.currentRevision = opts.currentRevision ?? null;
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
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
    });
  }
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
