/**
 * Opt-in DEVELOPMENT fixture for the editor contract.
 *
 * Why it exists: Arena implements `apps/api` concurrently against the same
 * fixed contract, so the frontend needs a way to be operated (and screenshotted)
 * before those routes exist.
 *
 * The rules that keep it honest:
 *   - it is OFF by default and can only be switched on by an explicit URL flag
 *     AND a development build (`import.meta.env.DEV`); a production build
 *     refuses it outright,
 *   - it is a separate module the normal code path never falls back into: an
 *     API failure is reported as a failure, never as a fixture success,
 *   - every screen that uses it says so, and the substitution switches (fake
 *     render media, "pretend the alignment runtime exists") are separate,
 *     explicit actions of the dev toolbar.
 */
import type {
  AlignmentJobResult,
  AlignmentStartResult,
  EditorAssetRef,
  EditorCapabilities,
  EditorDocument,
  EditorEnvelope,
  EditorOperation,
  EditorPatchRequest,
  EditorTargetId,
  PreviewJobResult,
  PreviewStartResult,
} from './editor-types.js';
import { localApply, round3 } from './editor-model.js';

export type FixtureMode = 'on';

export interface FixtureEnv {
  DEV?: boolean;
  PROD?: boolean;
}

/**
 * `?editorFixture=1` in a development build only. Anything else (no flag, any
 * value other than `1`, a production build) returns null, i.e. normal mode.
 */
export function fixtureModeFrom(href: string, env: FixtureEnv): FixtureMode | null {
  if (env.PROD === true) return null;
  if (env.DEV !== true) return null;
  let flag: string | null = null;
  try {
    flag = new URL(href, 'http://localhost').searchParams.get('editorFixture');
  } catch {
    return null;
  }
  return flag === '1' ? 'on' : null;
}

export function fixtureMode(): FixtureMode | null {
  const env = (import.meta as unknown as { env?: FixtureEnv }).env ?? {};
  const href = typeof location === 'undefined' ? '' : location.href;
  return fixtureModeFrom(href, env);
}

export function fixtureEnabled(): boolean {
  return fixtureMode() === 'on';
}

/* ------------------------------------------------------------------ */
/* development-only control surface                                    */
/* ------------------------------------------------------------------ */

export interface FixtureControls {
  /** the next save fails with a 500 (the operator's pending edits must survive) */
  failNextSave: boolean;
  /** the server is "ahead": the next save conflicts with a newer revision */
  serverRevisionAhead: number | null;
  /** pretend the dedicated alignment runtime exists, so the review path can be walked */
  alignmentRuntime: boolean;
  /** substitute a real served asset URL for the server render (explicitly labelled) */
  previewSubstituteUrl: string | null;
}

const controls: FixtureControls = {
  failNextSave: false,
  serverRevisionAhead: null,
  alignmentRuntime: false,
  previewSubstituteUrl: null,
};

export function fixtureControls(): FixtureControls {
  return controls;
}

export function setFixtureControl<K extends keyof FixtureControls>(key: K, value: FixtureControls[K]): void {
  controls[key] = value;
}

/* ------------------------------------------------------------------ */
/* fixture "server" state                                              */
/* ------------------------------------------------------------------ */

interface FixtureState {
  document: EditorDocument;
  undo: EditorDocument[];
  redo: EditorDocument[];
}

const states = new Map<string, FixtureState>();

/**
 * The fixture's asset library. The real server materialises the document's
 * asset table from its own library when a clip is bound by id; the fixture does
 * the same for the files the operator registered, so a binding is visible
 * without the frontend inventing metadata.
 */
let fixtureLibrary: EditorAssetRef[] = [];

export function setFixtureLibrary(assets: EditorAssetRef[]): void {
  fixtureLibrary = [...assets];
}

export function fixtureError(status: number, payload: Record<string, unknown>): Error & { status: number; payload: Record<string, unknown> } {
  const error = new Error(String(payload.message ?? payload.error ?? 'fixture error')) as Error & { status: number; payload: Record<string, unknown> };
  error.status = status;
  error.payload = payload;
  return error;
}

function key(projectId: string, targetId: string): string {
  return `${projectId}:${targetId}`;
}

/** Deterministic starting document: one video clip, two stills, approved imported narration. */
export function fixtureDocument(projectId: string, targetId: EditorTargetId): EditorDocument {
  const portrait = targetId !== 'long';
  return {
    schemaVersion: 1,
    projectId,
    revision: 3,
    contentProfile: 'educational',
    channelBrandId: null,
    targetId,
    format: portrait ? 'portrait' : 'landscape',
    durationSec: 38,
    assets: [
      {
        id: 'asset-excel-walkthrough',
        kind: 'video',
        name: 'BuildTrack_T03_Excel_01.mp4',
        mediaUrl: '/media/asset/asset-excel-walkthrough',
        durationSec: 62.4,
        source: 'owner screen recording (development fixture)',
        license: 'owner',
        sha256: null,
      },
      {
        id: 'asset-sheet-still',
        kind: 'image',
        name: 'workbook_summary.png',
        mediaUrl: '/media/asset/asset-sheet-still',
        durationSec: null,
        source: 'owner screenshot (development fixture)',
        license: 'owner',
        sha256: null,
      },
      {
        id: 'asset-narration-approved',
        kind: 'audio',
        name: 'BuildTrack_T03_Excel_01_approved.wav',
        mediaUrl: '/media/asset/asset-narration-approved',
        durationSec: 38.2,
        source: 'owner recording, approved (development fixture)',
        license: 'owner',
        sha256: 'fixture-not-a-real-hash',
      },
    ],
    visualClips: [
      {
        id: 'vc_01',
        sourceAssetId: 'asset-excel-walkthrough',
        startSec: 0,
        durationSec: 16,
        sourceInSec: 4,
        sourceOutSec: 20,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        motion: 'none',
        transition: 'cut',
        locked: false,
      },
      {
        id: 'vc_02',
        sourceAssetId: 'asset-sheet-still',
        startSec: 16,
        durationSec: 12,
        sourceInSec: 0,
        sourceOutSec: null,
        crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
        motion: 'slow_push',
        transition: 'dissolve',
        locked: false,
      },
      {
        id: 'vc_03',
        sourceAssetId: null,
        startSec: 28,
        durationSec: 10,
        sourceInSec: 0,
        sourceOutSec: null,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        motion: 'none',
        transition: 'fade',
        locked: false,
      },
    ],
    audioClips: [
      {
        id: 'ac_01',
        sourceAssetId: 'asset-narration-approved',
        speakerId: null,
        startSec: 0,
        sourceInSec: 0,
        sourceOutSec: 38,
        gainDb: 0,
        locked: true,
        approved: true,
      },
    ],
    captions: [
      {
        id: 'cap_01',
        startSec: 4,
        endSec: 9.5,
        text: 'افتح ورقة الملخص ثم حدد الإجمالي',
        language: 'ar',
        direction: 'rtl',
        fontSizePx: 44,
        position: { x: 0.5, y: 0.82 },
        locked: false,
      },
      {
        id: 'cap_02',
        startSec: 12,
        endSec: 17,
        text: 'لاحظ الفرق بين المنفذ والمقبول',
        language: 'ar',
        direction: 'rtl',
        fontSizePx: 44,
        position: { x: 0.5, y: 0.82 },
        locked: false,
      },
    ],
    highlights: [
      {
        id: 'hl_01',
        startSec: 6,
        endSec: 11,
        visualClipId: 'vc_01',
        box: { x: 0.42, y: 0.33, width: 0.18, height: 0.08 },
        label: 'total cell',
        locked: false,
      },
    ],
    alignment: { state: 'not_requested', audioHash: 'fixture-not-a-real-hash', sourceRevision: 3, proposalId: null },
  };
}

function stateFor(projectId: string, targetId: EditorTargetId): FixtureState {
  const id = key(projectId, targetId);
  let state = states.get(id);
  if (!state) {
    state = { document: fixtureDocument(projectId, targetId), undo: [], redo: [] };
    states.set(id, state);
  }
  return state;
}

/** Test/demo hook: forget every fixture document. */
export function resetFixture(): void {
  states.clear();
  fixtureLibrary = [];
  controls.failNextSave = false;
  controls.serverRevisionAhead = null;
  controls.alignmentRuntime = false;
  controls.previewSubstituteUrl = null;
}

export function fixtureCapabilities(): EditorCapabilities {
  return {
    targets: ['long', 'short_1'],
    alignment: controls.alignmentRuntime
      ? { available: true, engine: 'vf-align (development fixture)' }
      : { available: false, reason: 'The dedicated vf-align runtime is not available on this host.' },
    voiceGeneration: {
      available: false,
      reason: 'No voice-generation engine is bound in this development fixture.',
      engines: [{ id: 'local-speech', available: false, reason: 'not installed in the fixture' }],
    },
    preview: { available: controls.previewSubstituteUrl !== null, reason: controls.previewSubstituteUrl === null ? 'The fixture cannot render a file. The browser assembly preview is approximate and labelled.' : null },
    render: { available: controls.previewSubstituteUrl !== null, reason: controls.previewSubstituteUrl === null ? 'Fixture mode does not render.' : null },
    notes: ['DEVELOPMENT FIXTURE — the editor contract is served from the frontend, not from apps/api.'],
  };
}

function envelope(state: FixtureState): EditorEnvelope {
  return {
    document: state.document,
    undoAvailable: state.undo.length > 0,
    redoAvailable: state.redo.length > 0,
    capabilities: fixtureCapabilities(),
  };
}

export function fixtureGet(projectId: string, targetId: EditorTargetId): EditorEnvelope {
  return envelope(stateFor(projectId, targetId));
}

function materialiseAssets(document: EditorDocument): EditorDocument {
  const known = new Set(document.assets.map((asset) => asset.id));
  const referenced = [
    ...document.visualClips.map((clip) => clip.sourceAssetId),
    ...document.audioClips.map((clip) => clip.sourceAssetId),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0 && !known.has(id));
  if (!referenced.length) return document;
  const extra = [...new Set(referenced)]
    .map((id) => fixtureLibrary.find((asset) => asset.id === id))
    .filter((asset): asset is EditorAssetRef => !!asset);
  if (!extra.length) return document;
  return { ...document, assets: [...document.assets, ...extra] };
}

function pushOperations(state: FixtureState, operations: EditorOperation[]): EditorDocument {
  state.undo.push(state.document);
  state.redo = [];
  state.document = materialiseAssets(localApply(state.document, operations));
  state.document = { ...state.document, revision: state.document.revision + 1, alignment: { ...state.document.alignment, sourceRevision: state.document.revision + 1 } };
  return state.document;
}

export function fixturePatch(projectId: string, request: EditorPatchRequest): EditorEnvelope {
  const state = stateFor(projectId, request.targetId);
  const current = state.document.revision;
  const ahead = controls.serverRevisionAhead;
  if (ahead !== null && request.baseRevision < ahead) {
    state.document = { ...state.document, revision: ahead };
    throw fixtureError(409, {
      code: 'REVISION_CONFLICT',
      message: `The document is at revision ${ahead}; this save was based on revision ${request.baseRevision}.`,
      currentRevision: ahead,
    });
  }
  if (request.baseRevision !== current) {
    throw fixtureError(409, {
      code: 'REVISION_CONFLICT',
      message: `The document is at revision ${current}; this save was based on revision ${request.baseRevision}.`,
      currentRevision: current,
    });
  }
  if (controls.failNextSave) {
    controls.failNextSave = false;
    throw fixtureError(500, { error: 'Fixture: the save failed. Nothing was persisted.' });
  }
  pushOperations(state, request.operations);
  return envelope(state);
}

export function fixtureUndo(projectId: string, targetId: EditorTargetId, baseRevision: number): EditorEnvelope {
  const state = stateFor(projectId, targetId);
  if (baseRevision !== state.document.revision) {
    throw fixtureError(409, { code: 'REVISION_CONFLICT', message: `The document is at revision ${state.document.revision}.`, currentRevision: state.document.revision });
  }
  const previous = state.undo.pop();
  if (!previous) throw fixtureError(409, { error: 'Nothing to undo.' });
  state.redo.push(state.document);
  state.document = { ...previous, revision: state.document.revision + 1 };
  return envelope(state);
}

export function fixtureRedo(projectId: string, targetId: EditorTargetId, baseRevision: number): EditorEnvelope {
  const state = stateFor(projectId, targetId);
  if (baseRevision !== state.document.revision) {
    throw fixtureError(409, { code: 'REVISION_CONFLICT', message: `The document is at revision ${state.document.revision}.`, currentRevision: state.document.revision });
  }
  const next = state.redo.pop();
  if (!next) throw fixtureError(409, { error: 'Nothing to redo.' });
  state.undo.push(state.document);
  state.document = { ...next, revision: state.document.revision + 1 };
  return envelope(state);
}

export function fixtureAlignmentStart(): AlignmentStartResult {
  if (!controls.alignmentRuntime) {
    return {
      status: 'unavailable',
      blocker: {
        code: 'ALIGNMENT_RUNTIME_MISSING',
        message: 'The dedicated vf-align runtime is not available on this host. Timing was not estimated and nothing was proposed.',
        missing: ['vf-align WSL runtime', 'CTC model cache'],
      },
    };
  }
  return { jobId: 'fixture-align-job', status: 'running' };
}

export function fixtureAlignmentJob(): AlignmentJobResult {
  if (!controls.alignmentRuntime) {
    return { status: 'unavailable', error: 'The dedicated vf-align runtime is not available on this host.' };
  }
  return {
    status: 'proposed',
    proposalId: 'fixture-proposal-1',
    rows: [
      { sceneId: 'vc_01', cueId: 'cap_01', proposedStartSec: 4.21, proposedEndSec: 9.63, unresolvedSpan: false },
      { sceneId: 'vc_02', cueId: 'cap_02', proposedStartSec: 12.04, proposedEndSec: 17.4, unresolvedSpan: false },
      { sceneId: 'vc_03', cueId: null, proposedStartSec: 28.5, proposedEndSec: null, unresolvedSpan: true, note: 'No emission for this span. It stays unresolved.' },
    ],
  };
}

export function fixtureAcceptAlignment(projectId: string, targetId: EditorTargetId): EditorEnvelope {
  const state = stateFor(projectId, targetId);
  const rows = fixtureAlignmentJob().rows ?? [];
  const captions = state.document.captions.map((cue) => {
    const row = rows.find((item) => item.cueId === cue.id);
    if (!row || row.proposedStartSec === null || row.proposedEndSec === null) return cue;
    return { ...cue, startSec: round3(row.proposedStartSec), endSec: round3(row.proposedEndSec) };
  });
  state.document = {
    ...state.document,
    captions,
    alignment: { ...state.document.alignment, state: 'approved', proposalId: 'fixture-proposal-1' },
  };
  return envelope(state);
}

export function fixturePreviewStart(range?: { startSec: number; endSec: number } | null): PreviewStartResult {
  if (!controls.previewSubstituteUrl) {
    return {
      status: 'unavailable',
      blocker: { code: 'PREVIEW_RENDER_UNAVAILABLE', message: 'Fixture mode cannot render. The browser assembly preview is approximate and is labelled as such.' },
    };
  }
  return { jobId: `fixture-preview-${range ? 'range' : 'full'}`, status: 'running' };
}

export function fixturePreviewJob(projectId: string, targetId: EditorTargetId, range?: { startSec: number; endSec: number } | null): PreviewJobResult {
  if (!controls.previewSubstituteUrl) {
    return { status: 'unavailable', error: 'Fixture mode cannot render a snapshot.' };
  }
  return {
    status: 'ready',
    revision: stateFor(projectId, targetId).document.revision,
    range: range ?? null,
    mediaUrl: controls.previewSubstituteUrl,
    error: null,
  };
}
