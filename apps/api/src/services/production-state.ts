/**
 * BuildTrack Video Factory - Workstream D Production State Persistence
 *
 * Versioned sidecar state for every project under the existing project
 * directory (`<data>/projects/<id>/production-state.json`), so the NEW
 * production authority (Workstream A scenarios -> Phase 4 -> 5 -> 6) survives
 * application restart without bloating the legacy Project model.
 *
 * Design rules:
 *  - writes are ATOMIC: temp file + rename in the same directory;
 *  - no absolute machine-specific paths are persisted;
 *  - input fingerprint detects stale state after a ProjectInput change;
 *  - every per-target scenario edit is recorded so downstream audio/plan
 *    artifacts can be invalidated deterministically;
 *  - missing/corrupt sidecar loads as null (legacy projects keep working).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR, projectDir } from './platform.js';
import type { ProjectInput } from '@buildtrack/core';

export const PRODUCTION_STATE_VERSION = 1;
export const PRODUCTION_STATE_FILE = 'production-state.json';
export const PRODUCTION_HISTORY_FILE = 'production_history.json';

/** Canonical production target ids (mirror Phase 6C delivery target ids). */
export type ProductionTargetId = 'long' | 'short_1' | 'short_2' | 'short_3';

/** Which edit kinds invalidate downstream audio/plan artifacts. */
export type ProductionEditKind = 'scene' | 'turn' | 'asset-binding';

/** Per-target scenario edit / override record. */
export interface ProductionTargetEdit {
  target: ProductionTargetId;
  kind: ProductionEditKind;
  /** sceneId or turnId that was edited */
  subjectId: string;
  /** deterministic ISO timestamp (audit only, never used for logic) */
  at: string;
  /** short human summary of what changed */
  summary: string;
}

/** Explicit asset binding: logical asset ref -> Asset Library id. */
export interface ProductionAssetBinding {
  target: ProductionTargetId;
  /** logicalAssetRef from the composition plan, e.g. `asset-iva-progress-chart` */
  logicalRef: string;
  /** Asset Library entry id, e.g. `asset-progress-chart-real` */
  assetId: string;
  setAt: string;
}

/** One production build (preview or final) outcome summary. */
export interface ProductionBuildRecord {
  kind: 'preview' | 'final';
  targets: ProductionTargetId[];
  at: string;
  status: 'ok' | 'partial' | 'error';
  /** targetId -> output file path relative to the output root */
  outputs: Partial<Record<ProductionTargetId, string>>;
  /** audio authority used for the build */
  audioEngine: string;
  error?: string;
  packageRoot?: string;
  packageStatus?: string;
}

/** Last QC/package summary attached to a final build. */
export interface ProductionQcSummary {
  at: string;
  packageStatus: string;
  mode: string;
  longCount: number;
  shortCount: number;
  findings: Array<{ severity: string; code: string; message: string }>;
}

/** Production artifact (video/package/caption/metadata file), relative paths only. */
export interface ProductionArtifact {
  target: ProductionTargetId | 'package';
  kind: 'video' | 'package' | 'captions' | 'metadata' | 'thumbnail' | 'provenance';
  /** path relative to the output root, never absolute */
  relPath: string;
  sizeBytes: number;
  createdAt: string;
}

/** Full versioned sidecar document. */
export interface ProductionState {
  schemaVersion: number;
  videoId: string;
  /** generation status for the UI */
  status:
    | 'not_generated'
    | 'generating'
    | 'generated'
    | 'edited'
    | 'needs_regeneration'
    | 'ready_for_preview'
    | 'ready_for_export'
    | 'blocked';
  /** deterministic fingerprint of the ProjectInput the state was generated from */
  inputFingerprint: string | null;
  /** Workstream A generation findings */
  generationFindings: Array<{ severity: string; code: string; target: string; message: string }>;
  /** generated scenarios per target (only targets that were actually generated) */
  scenarios: Partial<Record<ProductionTargetId, unknown>>;
  /** per-target scenario edit history (append-only) */
  edits: ProductionTargetEdit[];
  /** per-target lock map: sceneId -> locked */
  locks: Record<string, boolean>;
  /**
   * Audio/plan synthesis base path (output-root-relative, safe-relative to the
   * process cwd where production runs). Never an absolute machine path.
   */
  audioBasePath?: string;
  /** explicit asset bindings (logicalRef -> asset id) per target */
  assetBindings: ProductionAssetBinding[];
  /** last build attempts (preview + final), newest last */
  builds: ProductionBuildRecord[];
  /** last QC/package summary from the latest successful final build */
  lastQcSummary: ProductionQcSummary | null;
  /** production artifacts (relative paths) */
  artifacts: ProductionArtifact[];
  /** generation + style fingerprint of the generation inputs */
  generationFingerprint: string | null;
  updatedAt: string;
}

/** Stable fingerprint of a ProjectInput (ignores volatile ordering noise). */
export function fingerprintProjectInput(input: ProjectInput): string {
  const stable = {
    videoId: input.videoId,
    videoType: input.videoType,
    topic: (input.topic ?? '').trim(),
    targetAudience: (input.targetAudience ?? '').trim(),
    mainProblem: (input.mainProblem ?? '').trim(),
    viewerPromise: (input.viewerPromise ?? '').trim(),
    hook: (input.hook ?? '').trim(),
    script: input.script ?? '',
    keyNumbers: [...(input.keyNumbers ?? [])].sort(),
    keyPoints: input.keyPoints ?? [],
    productName: input.productName ?? '',
    cta: input.cta ?? '',
    outputLanguage: input.outputLanguage ?? '',
    brandPreset: input.brandPreset ?? '',
    shortCount: input.shortCount ?? 0,
    sourceReferences: input.sourceReferences ?? [],
  };
  return sha256Json(stable);
}

/** Deterministic fingerprint of generation options + persona history. */
export function fingerprintGenerationOptions(options: unknown): string {
  return sha256Json(options ?? null);
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Sidecar path for a project. */
export function productionStateFile(videoId: string): string {
  return path.join(projectDir(videoId), PRODUCTION_STATE_FILE);
}

/** Atomic JSON write: temp file in the same directory + rename. */
function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Load the sidecar; null when absent or unreadable (legacy projects). */
export function loadProductionState(videoId: string): ProductionState | null {
  const f = productionStateFile(videoId);
  try {
    if (!fs.existsSync(f)) return null;
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as ProductionState;
    if (typeof raw?.schemaVersion !== 'number' || raw.schemaVersion > PRODUCTION_STATE_VERSION) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Persist the sidecar atomically. */
export function saveProductionState(state: ProductionState): void {
  state.updatedAt = new Date().toISOString();
  atomicWriteJson(productionStateFile(state.videoId), state);
}

/** Delete the sidecar (used when the whole project is deleted). */
export function deleteProductionState(videoId: string): void {
  const f = productionStateFile(videoId);
  try {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  } catch {
    /* deletion must never break project deletion */
  }
}

/** Create an initial sidecar for a project (status: not_generated). */
export function newProductionState(videoId: string): ProductionState {
  return {
    schemaVersion: PRODUCTION_STATE_VERSION,
    videoId,
    status: 'not_generated',
    inputFingerprint: null,
    generationFindings: [],
    scenarios: {},
    edits: [],
    locks: {},
    assetBindings: [],
    builds: [],
    lastQcSummary: null,
    artifacts: [],
    generationFingerprint: null,
    updatedAt: new Date().toISOString(),
  };
}

/** True when the ProjectInput changed after generation. */
export function isStaleAgainstInput(state: ProductionState, input: ProjectInput): boolean {
  if (!state.inputFingerprint) return false;
  return state.inputFingerprint !== fingerprintProjectInput(input);
}

/**
 * Deterministic generation fingerprint covering the content source (topic +
 * script) and the persona history used, so regenerated content can be traced.
 */
export function computeGenerationFingerprint(input: ProjectInput, personaHistory: unknown): string {
  return sha256Json({
    topic: (input.topic ?? '').trim(),
    scriptHash: createHash('sha256').update(input.script ?? '').digest('hex'),
    shortCount: input.shortCount ?? 0,
    videoType: input.videoType,
    personaHistory: personaHistory ?? null,
  });
}

/**
 * Append a per-target edit and invalidate downstream video/package artifacts
 * of that target. Audio invalidation is derived deterministically at build
 * time by comparing edit timestamps against the last successful build.
 */
export function applyEditToState(
  state: ProductionState,
  edit: ProductionTargetEdit,
): void {
  state.edits.push(edit);
  if (state.edits.length > 200) state.edits.splice(0, state.edits.length - 200);

  // Scene/turn edits change spoken audio AND the plan; asset-binding edits
  // only change the plan mediaMap.
  const invalidate: ProductionArtifact['kind'][] =
    edit.kind === 'asset-binding' ? ['video', 'package'] : ['video', 'package', 'captions'];

  state.artifacts = state.artifacts.filter((a) => {
    if (a.target !== edit.target) return true;
    return !invalidate.includes(a.kind);
  });

  if (state.status === 'generated' || state.status === 'ready_for_preview' || state.status === 'ready_for_export') {
    state.status = 'edited';
  }
}

/**
 * True when a scene/turn edit for the target happened AFTER the last
 * successful build of that target — i.e. audio/plan must be regenerated.
 */
export function targetNeedsAudioRebuild(state: ProductionState, target: ProductionTargetId): boolean {
  const lastEdit = [...state.edits].reverse().find((e) => e.target === target && e.kind !== 'asset-binding');
  if (!lastEdit) return false;
  const lastBuild = [...state.builds].reverse().find((b) => b.targets.includes(target) && b.status === 'ok');
  if (!lastBuild) return true;
  return lastEdit.at > lastBuild.at;
}

/* ------------------------------------------------------------------ */
/*  Production history (cross-video diversity, deterministic)          */
/* ------------------------------------------------------------------ */

/** One deterministic persona/style observation from a completed production. */
export interface ProductionHistoryEntry {
  videoId: string;
  at: string;
  /** persona keys by narrative role, e.g. { challenger: 'commercial-lead' } */
  casting: Partial<Record<'challenger' | 'technical_authority' | 'decision_maker', string>>;
  /** deterministic fingerprint of shot/camera/framing patterns and cast */
  styleFingerprint: string;
}

function productionHistoryFile(): string {
  return path.join(DATA_DIR, PRODUCTION_HISTORY_FILE);
}

/** Load production persona/style history (empty when absent/corrupt). */
export function loadProductionHistory(): ProductionHistoryEntry[] {
  try {
    const f = productionHistoryFile();
    if (!fs.existsSync(f)) return [];
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as { entries?: ProductionHistoryEntry[] };
    return Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

/** Append one observation atomically (most recent last). */
export function appendProductionHistoryEntry(entry: ProductionHistoryEntry): void {
  const entries = loadProductionHistory();
  entries.push(entry);
  const trimmed = entries.slice(-100);
  const f = productionHistoryFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, entries: trimmed }, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

/** Record a build outcome and update status. */
export function recordBuild(state: ProductionState, build: ProductionBuildRecord): void {
  state.builds.push(build);
  if (state.builds.length > 20) state.builds.splice(0, state.builds.length - 20);
  for (const [target, out] of Object.entries(build.outputs) as [ProductionTargetId, string][]) {
    if (!out) continue;
    state.artifacts = state.artifacts.filter((a) => !(a.target === target && a.kind === 'video'));
    state.artifacts.push({
      target,
      kind: 'video',
      relPath: out,
      sizeBytes: 0,
      createdAt: build.at,
    });
  }
  if (build.kind === 'final' && build.status === 'ok') {
    state.status = 'ready_for_export';
  }
}
