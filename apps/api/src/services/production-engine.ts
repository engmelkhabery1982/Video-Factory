/**
 * BuildTrack Video Factory - Workstream D Production Engine Service
 *
 * The NEW production authority behind the EXISTING product workflow:
 *
 *   ProjectInput
 *     → generateProductionScenarios()        (Workstream A, no fixtures)
 *     → Scenario per target                  (persisted in the sidecar)
 *     → buildDialogueProductionPlan(production mode → Kokoro)
 *     → Phase 5 plan chain
 *     → Phase 6A resolveProductionAssets (explicit bindings)
 *     → Phase 6C/6D via runPlanBasedProductionExport
 *
 * No fixture scenarios enter this path. No legacy storyboard/Scene[]/
 * targetAudio/exportProject authority is used for video. Kokoro cache
 * failures surface as actionable errors (`npm run provision:tts`).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  generateProductionScenariosFromProjectInput,
  validateScenario,
  resolveProductionAssets,
  type Asset,
  type Project,
  type ProjectInput,
  type Scenario,
  type RemotionCompositionPlan,
  type DeliveryTargetId,
} from '@buildtrack/core';
import {
  PRODUCTION_STATE_VERSION,
  applyEditToState,
  computeGenerationFingerprint,
  fingerprintProjectInput,
  isStaleAgainstInput,
  loadProductionState,
  newProductionState,
  recordBuild,
  saveProductionState,
  type ProductionArtifact,
  type ProductionState,
  type ProductionTargetEdit,
  type ProductionTargetId,
} from './production-state.js';
import { buildRemotionPlanFromScenario, runPlanBasedProductionExport } from './plan-production.js';
import { OUTPUT_DIR } from './platform.js';
import { writeCaptions, writeMetadata } from './pipeline.js';

/** The engine/audio authority used by every production build. */
export const PRODUCTION_AUDIO_ENGINE = 'kokoro-js';

export class ProductionError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ProductionError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/*  Generation                                                         */
/* ------------------------------------------------------------------ */

export interface ProductionPersonaHistoryEntry {
  personas: Partial<Record<'challenger' | 'technical_authority' | 'decision_maker', string>>;
  styleFingerprint?: string;
}

/** Derive deterministic persona history from the global visual history. */
export function personaHistoryFromVisualHistory(history: unknown): ProductionPersonaHistoryEntry[] {
  const videos = (history as { videos?: Array<Record<string, unknown>> })?.videos ?? [];
  const out: ProductionPersonaHistoryEntry[] = [];
  for (const v of videos.slice(-5)) {
    const personas: ProductionPersonaHistoryEntry['personas'] = {};
    const casting = (v as { casting?: Record<string, unknown> }).casting ?? null;
    if (casting && typeof casting === 'object') {
      for (const [role, key] of Object.entries(casting)) {
        if (typeof key === 'string' && key) personas[role as 'challenger'] = key;
      }
    }
    const style = typeof (v as { styleFingerprint?: string }).styleFingerprint === 'string'
      ? (v as { styleFingerprint: string }).styleFingerprint
      : undefined;
    out.push({ personas, ...(style ? { styleFingerprint: style } : {}) });
  }
  return out;
}

/** Deterministic style fingerprint of generated scenarios (for history). */
export function scenarioStyleFingerprint(scenarios: Partial<Record<ProductionTargetId, Scenario>>): string {
  const shotSeq: string[] = [];
  const cameraSeq: string[] = [];
  const framingSeq: string[] = [];
  const cast: string[] = [];
  for (const t of ['long', 'short_1', 'short_2', 'short_3'] as ProductionTargetId[]) {
    const sc = scenarios[t];
    if (!sc) continue;
    for (const s of sc.scenes) {
      shotSeq.push(s.production.shotType);
      cameraSeq.push(s.production.cameraMovement);
      framingSeq.push(s.production.framing);
    }
    for (const c of sc.characters) cast.push(c.id);
  }
  return JSON.stringify({ cast: [...new Set(cast)].sort(), shotSeq, cameraSeq: [...new Set(cameraSeq)].sort(), framingSeq: [...new Set(framingSeq)].sort() });
}

/** Casting/style combination of a production state, for the history sidecar. */
export function personaObservationFromState(state: ProductionState): ProductionPersonaHistoryEntry {
  const personas: ProductionPersonaHistoryEntry['personas'] = {};
  const long = state.scenarios.long as Scenario | undefined;
  const first = long ?? (Object.values(state.scenarios).find(Boolean) as Scenario | undefined);
  if (first) {
    for (const c of first.characters) {
      // The generator assigns ids `char-<videoSlug>-<personaKey>`; the slug
      // itself may contain hyphens, so anchor on the last segment.
      const m = c.id.match(/^char-(.+)-([^-]+)$/);
      const key = m?.[2] ?? c.narrativeFunction;
      personas[c.narrativeFunction as 'challenger'] = key;
    }
  }
  return { personas, styleFingerprint: scenarioStyleFingerprint(state.scenarios as never) };
}

/** Targets a project should generate, from ProjectInput (videoType + shortCount). */
export function targetsForInput(input: ProjectInput): ProductionTargetId[] {
  const shorts = Math.max(0, Math.min(3, input.shortCount ?? 0));
  if (input.videoType === 'short') {
    // Short-only: at least short_1, up to the requested count. Never a hidden Long.
    const n = Math.max(1, shorts);
    return Array.from({ length: n }, (_, i) => `short_${i + 1}` as ProductionTargetId);
  }
  const out: ProductionTargetId[] = ['long'];
  for (let i = 1; i <= shorts; i++) out.push(`short_${i}` as ProductionTargetId);
  return out;
}

/**
 * Generate production scenarios for a project from its ProjectInput.
 * Workstream A authority only — no fixtures. Persists the sidecar.
 */
export function generateProductionState(project: Project, history: unknown): ProductionState {
  const input = project.meta.input;
  const state = loadProductionState(input.videoId) ?? newProductionState(input.videoId);
  state.schemaVersion = PRODUCTION_STATE_VERSION;

  const personaHistory = personaHistoryFromVisualHistory(history);
  const targets = targetsForInput(input);

  state.status = 'generating';
  saveProductionState(state);

  const result = generateProductionScenariosFromProjectInput(input, {
    shortCount: targets.filter((t) => t !== 'long').length,
    projectId: `proj-${input.videoId}`,
    personaHistory,
  });

  state.generationFindings = result.findings.map((f) => ({
    severity: f.severity,
    code: f.code,
    target: f.target,
    message: f.message,
  }));

  if (!result.success) {
    state.status = 'blocked';
    state.scenarios = {};
    state.inputFingerprint = fingerprintProjectInput(input);
    state.generationFingerprint = computeGenerationFingerprint(input, personaHistory);
    saveProductionState(state);
    throw new ProductionError('GENERATION_FAILED', `Production scenario generation failed: ${result.failure?.message ?? 'unknown'}`, {
      failure: result.failure,
      findings: state.generationFindings,
    });
  }

  // Only persist scenarios for requested targets (never a hidden Long for Short-only).
  const scenarios: Partial<Record<ProductionTargetId, Scenario>> = {};
  const missing: string[] = [];
  if (targets.includes('long')) {
    if (result.longScenario) scenarios.long = result.longScenario;
    else missing.push('long');
  }
  for (const t of targets.filter((x) => x !== 'long')) {
    const s = result.shortScenarios[t as 'short_1' | 'short_2' | 'short_3'];
    if (s) scenarios[t] = s;
    else missing.push(t);
  }

  if (missing.length > 0) {
    state.status = 'blocked';
    state.inputFingerprint = fingerprintProjectInput(input);
    saveProductionState(state);
    throw new ProductionError('GENERATION_FAILED', `Generation did not produce requested targets: ${missing.join(', ')}`, {
      missing,
      findings: state.generationFindings,
    });
  }

  state.scenarios = scenarios;
  state.inputFingerprint = fingerprintProjectInput(input);
  state.generationFingerprint = computeGenerationFingerprint(input, personaHistory);
  state.status = 'generated';
  saveProductionState(state);
  return state;
}

/* ------------------------------------------------------------------ */
/*  Edits                                                              */
/* ------------------------------------------------------------------ */

const NUM_FACT_RE = /-?\d+(?:[.,]\d+)?/g;

function numbersOf(text: string): string[] {
  return (text.match(NUM_FACT_RE) ?? []).map((n) => n.replace(',', '.'));
}

function sceneById(scenario: Scenario, sceneId: string) {
  return scenario.scenes.find((s) => s.id === sceneId) ?? null;
}

function turnById(scenario: Scenario, turnId: string) {
  for (const s of scenario.scenes) {
    const t = s.turns.find((x) => x.id === turnId);
    if (t) return { turn: t, scene: s };
  }
  return null;
}

/** Evidence-linked turn? (turn has evidenceId or its scene carries evidenceIds) */
function turnEvidenceIds(scenario: Scenario, sceneId: string, turnId: string): string[] {
  const ids: string[] = [];
  const scene = sceneById(scenario, sceneId);
  if (scene?.evidenceIds) ids.push(...scene.evidenceIds);
  for (const s of scenario.scenes) {
    for (const t of s.turns) {
      if (t.id === turnId && (t as { evidenceId?: string }).evidenceId) ids.push((t as { evidenceId: string }).evidenceId);
    }
  }
  return ids;
}

/**
 * Patch a production scene (visual/production fields only). Timing authority
 * (actual durations) is NEVER edited here — audio owns timing.
 */
export function patchProductionScene(
  state: ProductionState,
  target: ProductionTargetId,
  sceneId: string,
  patch: Record<string, unknown>,
): { state: ProductionState; scenario: Scenario } {
  const scenario = state.scenarios[target] as Scenario | undefined;
  if (!scenario) throw new ProductionError('TARGET_NOT_GENERATED', `Target '${target}' has no generated scenario.`);
  const scene = sceneById(scenario, sceneId);
  if (!scene) throw new ProductionError('SCENE_NOT_FOUND', `Scene '${sceneId}' not found in target '${target}'.`);
  if (state.locks[sceneId]) throw new ProductionError('SCENE_LOCKED', `Scene '${sceneId}' is locked. Unlock it first.`);

  const editable: string[] = ['title', 'onScreenInfo', 'production', 'locationId'];
  for (const k of editable) {
    if (k in patch && patch[k] !== undefined) {
      (scene as unknown as Record<string, unknown>)[k] = patch[k];
    }
  }
  if (typeof patch.locked === 'boolean') {
    state.locks[sceneId] = patch.locked;
  }
  // Explicitly refuse timing edits: actual duration is audio authority.
  if ('estimatedDuration' in patch || 'actualDuration' in patch) {
    throw new ProductionError('TIMING_IS_AUDIO_AUTHORITY', 'Scene duration is derived from production audio and cannot be edited.');
  }

  const report = validateScenario(scenario);
  if (!report.valid) {
    throw new ProductionError('SCENARIO_INVALID', `Scene edit made scenario invalid: ${report.findings.filter((f) => f.severity === 'error').map((f) => f.message).join('; ')}`);
  }

  applyEditToState(state, {
    target,
    kind: 'scene',
    subjectId: sceneId,
    at: new Date().toISOString(),
    summary: `scene patched: ${Object.keys(patch).join(', ')}`,
  });
  saveProductionState(state);
  return { state, scenario };
}

/**
 * Patch a production dialogue turn's spokenText (and delivery). Speaker/turn
 * identity is preserved. Evidence safety: when the turn is linked to evidence,
 * the edit is rejected unless every numeric value in the new text is
 * source-supported by that evidence's numericFacts.
 */
export function patchProductionTurn(
  state: ProductionState,
  target: ProductionTargetId,
  turnId: string,
  patch: Record<string, unknown>,
): { state: ProductionState; scenario: Scenario } {
  const scenario = state.scenarios[target] as Scenario | undefined;
  if (!scenario) throw new ProductionError('TARGET_NOT_GENERATED', `Target '${target}' has no generated scenario.`);
  const found = turnById(scenario, turnId);
  if (!found) throw new ProductionError('TURN_NOT_FOUND', `Turn '${turnId}' not found in target '${target}'.`);
  const { turn, scene } = found;

  const newSpeaker = patch.speakerId !== undefined ? String(patch.speakerId) : turn.speakerId;
  if (newSpeaker !== turn.speakerId) {
    throw new ProductionError('SPEAKER_IDENTITY_LOCKED', 'Speaker identity cannot be changed by dialogue editing.');
  }

  if (patch.spokenText !== undefined) {
    const text = String(patch.spokenText).trim();
    if (!text) throw new ProductionError('EMPTY_SPOKEN_TEXT', 'spokenText cannot be empty.');

    const evidenceIds = turnEvidenceIds(scenario, scene.id, turnId);
    if (evidenceIds.length > 0) {
      const supported = new Set<string>();
      for (const ev of scenario.evidence) {
        if (!evidenceIds.includes(ev.id)) continue;
        for (const f of ev.numericFacts) {
          supported.add(String(f.value));
          if (ev.claim) for (const n of numbersOf(ev.claim)) supported.add(n);
        }
      }
      const presented = numbersOf(text);
      const breaking = presented.filter((n) => !supported.has(n));
      if (breaking.length > 0) {
        throw new ProductionError(
          'EVIDENCE_CONFLICT',
          `Edit rejected: the turn is linked to evidence and text introduces numbers not supported by the source record (${breaking.join(', ')}). Update the evidence first or keep the source-supported values.`,
          { evidenceIds, breaking },
        );
      }
    }
    turn.spokenText = text;
  }
  if (patch.delivery !== undefined) turn.delivery = patch.delivery as never;

  const report = validateScenario(scenario);
  if (!report.valid) {
    throw new ProductionError('SCENARIO_INVALID', `Dialogue edit made scenario invalid: ${report.findings.filter((f) => f.severity === 'error').map((f) => f.message).join('; ')}`);
  }

  applyEditToState(state, {
    target,
    kind: 'turn',
    subjectId: turnId,
    at: new Date().toISOString(),
    summary: patch.spokenText !== undefined ? 'spokenText edited' : `patched: ${Object.keys(patch).join(', ')}`,
  });
  saveProductionState(state);
  return { state, scenario };
}

/** Set / clear an explicit asset binding for a logical ref on a target. */
export function setProductionAssetBinding(
  state: ProductionState,
  target: ProductionTargetId,
  logicalRef: string,
  assetId: string | null,
): ProductionState {
  if (!state.scenarios[target]) throw new ProductionError('TARGET_NOT_GENERATED', `Target '${target}' has no generated scenario.`);
  if (!logicalRef.trim()) throw new ProductionError('INVALID_LOGICAL_REF', 'logicalRef is required.');
  state.assetBindings = state.assetBindings.filter((b) => !(b.target === target && b.logicalRef === logicalRef));
  if (assetId) {
    state.assetBindings.push({ target, logicalRef, assetId, setAt: new Date().toISOString() });
  }
  applyEditToState(state, {
    target,
    kind: 'asset-binding',
    subjectId: logicalRef,
    at: new Date().toISOString(),
    summary: assetId ? `bound ${logicalRef} -> ${assetId}` : `cleared binding ${logicalRef}`,
  });
  saveProductionState(state);
  return state;
}

/* ------------------------------------------------------------------ */
/*  Plan building + asset resolution                                   */
/* ------------------------------------------------------------------ */

export interface ProductionPlanOptions {
  synthesisBasePath: string;
  canonicalBasePath: string;
}

export interface TargetPlan {
  target: ProductionTargetId;
  scenario: Scenario;
  plan: RemotionCompositionPlan;
  mediaMap: Record<string, string>;
  resolution: ReturnType<typeof resolveProductionAssets>;
}

/**
 * Build the Phase 5 plan for one target with production audio authority
 * (`synthesisMode: 'production'` → Kokoro). Returns the resolved mediaMap too.
 */
export async function buildTargetPlan(
  state: ProductionState,
  target: ProductionTargetId,
  options: ProductionPlanOptions,
  assets: readonly Asset[],
  assetUrlById: Record<string, string>,
): Promise<TargetPlan> {
  const scenario = state.scenarios[target] as Scenario | undefined;
  if (!scenario) throw new ProductionError('TARGET_NOT_GENERATED', `Target '${target}' has no generated scenario.`);

  const built = await buildRemotionPlanFromScenario(scenario, {
    synthesisBasePath: options.synthesisBasePath,
    canonicalBasePath: options.canonicalBasePath,
    synthesisMode: 'production',
  });

  const bindings: Record<string, string> = {};
  for (const b of state.assetBindings.filter((b) => b.target === target)) bindings[b.logicalRef] = b.assetId;

  const resolution = resolveProductionAssets({
    plan: built.plan,
    assets,
    explicitBindings: bindings,
    assetUrlById,
  });

  return {
    target,
    scenario,
    plan: built.plan,
    mediaMap: resolution.mediaMap,
    resolution,
  };
}

/** Build plans for all generated targets of the state. */
export async function buildAllTargetPlans(
  state: ProductionState,
  options: ProductionPlanOptions,
  assets: readonly Asset[],
  assetUrlById: Record<string, string>,
): Promise<TargetPlan[]> {
  const targets = (['long', 'short_1', 'short_2', 'short_3'] as ProductionTargetId[]).filter((t) => state.scenarios[t]);
  const out: TargetPlan[] = [];
  for (const t of targets) out.push(await buildTargetPlan(state, t, options, assets, assetUrlById));
  return out;
}

/** Reconciled production captions for one target (from the built plan). */
export function productionCaptionsForTarget(plan: RemotionCompositionPlan): Array<{ cueId: string; text: string; start: number; end: number; sceneId: string }> {
  const out: Array<{ cueId: string; text: string; start: number; end: number; sceneId: string }> = [];
  for (const scene of plan.scenes) {
    for (const cue of scene.captionCues) {
      out.push({
        cueId: (cue as unknown as { cueId?: string; id?: string }).cueId ?? (cue as unknown as { id: string }).id,
        text: cue.text,
        start: cue.startTimeSeconds,
        end: cue.endTimeSeconds,
        sceneId: scene.sceneId,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Preview / final export                                             */
/* ------------------------------------------------------------------ */

export interface RunProductionBuildInput {
  project: Project;
  state: ProductionState;
  kind: 'preview' | 'final';
  plans: TargetPlan[];
  brand?: unknown;
  /** Repository root for the Phase 6D package-root safety check. Defaults to the repo. */
  repoRoot?: string | null;
  onLog?: (message: string) => void;
  onProgress?: (progress: number, note?: string) => void;
}

export interface RunProductionBuildResult {
  status: 'ok' | 'partial' | 'error';
  outputs: Partial<Record<ProductionTargetId, string>>;
  packageRoot?: string;
  packageStatus?: string;
  targets: ProductionTargetId[];
  audioEngine: string;
  renderResults: unknown;
  targetSet: unknown;
}

/** Resolve output paths (relative to the output root, per target). */
export function productionOutputPaths(videoId: string, kind: 'preview' | 'final', targets: ProductionTargetId[]): Partial<Record<ProductionTargetId, string>> {
  const out: Partial<Record<ProductionTargetId, string>> = {};
  const dir = kind === 'preview' ? 'previews' : '';
  for (const t of targets) {
    const name = kind === 'preview' ? `${t}-preview.mp4` : `${t}.mp4`;
    out[t] = path.join(videoId, dir, name).replace(/\\/g, '/');
  }
  return out;
}

/**
 * Run a production build (preview or final) through the NEW authority:
 * Phase 6C render + (final only) Phase 6D package. Never touches the legacy
 * exportProject video path. Records the build + artifacts into the sidecar.
 */
export async function runProductionBuild(input: RunProductionBuildInput): Promise<RunProductionBuildResult> {
  const { project, state, kind, plans } = input;
  if (plans.length === 0) throw new ProductionError('NO_TARGETS', 'No generated targets to build.');

  const log = input.onLog ?? (() => {});
  const targets = plans.map((p) => p.target);
  const outputByTarget = productionOutputPaths(project.meta.input.videoId, kind, targets);
  const mediaMapByTarget: Partial<Record<DeliveryTargetId, Record<string, string>>> = {};
  const longPlan = plans.find((p) => p.target === 'long')?.plan ?? null;
  const shortPlans: Partial<Record<'short_1' | 'short_2' | 'short_3', RemotionCompositionPlan>> = {};
  for (const p of plans.filter((x) => x.target !== 'long')) {
    shortPlans[p.target as 'short_1' | 'short_2' | 'short_3'] = p.plan;
  }
  for (const p of plans) mediaMapByTarget[p.target as DeliveryTargetId] = p.mediaMap;

  // Final-export gate: unresolved REQUIRED asset refs block the export.
  if (kind === 'final') {
    for (const p of plans) {
      for (const b of p.resolution.bindings) {
        if (b.required && !b.resolved) {
          throw new ProductionError('REQUIRED_ASSET_UNRESOLVED', `Final export blocked: required asset '${b.assetRef}' is unresolved (no active eligible asset bound or tagged).`, {
            target: p.target,
            assetRef: b.assetRef,
          });
        }
      }
    }
  }

  const packageRoot =
    kind === 'final'
      ? path.join(OUTPUT_DIR, project.meta.input.videoId, 'production-package')
      : undefined;

  // The renderer and packager receive ABSOLUTE output paths; the sidecar
  // persists only output-root-relative paths (no machine-specific absolutes).
  const absoluteOutputs: Partial<Record<DeliveryTargetId, string>> = {};
  for (const [t, rel] of Object.entries(outputByTarget) as [DeliveryTargetId, string][]) {
    absoluteOutputs[t] = path.join(OUTPUT_DIR, rel);
  }

  for (const t of targets) {
    log(`${kind} build: rendering ${t} through the plan-based production path`);
  }

  const result = await runPlanBasedProductionExport({
    ...(longPlan ? { longPlan } : {}),
    shortPlans,
    mediaMapByTarget,
    outputByTarget: absoluteOutputs,
    ...(packageRoot ? { packageRoot } : {}),
    quality: kind === 'preview' ? 'preview' : 'final',
    brand: input.brand,
    repoRoot: input.repoRoot ?? null,
    onProgress: input.onProgress,
  });

  const outputs: Partial<Record<ProductionTargetId, string>> = {};
  for (const r of result.renderResult.results) {
    if (r.success && r.outputFile) outputs[r.targetId as ProductionTargetId] = r.outputFile.replace(/\\/g, '/');
  }
  const status = result.renderResult.status;

  recordBuild(state, {
    kind,
    targets,
    at: new Date().toISOString(),
    status,
    outputs,
    audioEngine: PRODUCTION_AUDIO_ENGINE,
    ...(result.packageResult
      ? { packageRoot: path.relative(OUTPUT_DIR, result.packageResult.packageRoot).replace(/\\/g, '/'), packageStatus: result.packageResult.package.summary.packageStatus }
      : {}),
    ...(status !== 'ok' ? { error: result.renderResult.results.filter((r) => !r.success).map((r) => `${r.targetId}: ${r.error?.message ?? ''}`).join('; ') } : {}),
  });

  if (result.packageResult) {
    const pkg = result.packageResult.package;
    state.lastQcSummary = {
      at: new Date().toISOString(),
      packageStatus: pkg.summary.packageStatus,
      mode: pkg.mode,
      longCount: pkg.summary.longCount,
      shortCount: pkg.summary.shortCount,
      findings: pkg.findings.slice(0, 50).map((f) => ({ severity: f.severity, code: f.code, message: f.message })),
    };
    const relPkg = path.relative(OUTPUT_DIR, result.packageResult.packageRoot).replace(/\\/g, '/');
    state.artifacts = state.artifacts.filter((a) => a.kind !== 'package');
    state.artifacts.push({ target: 'package', kind: 'package', relPath: relPkg, sizeBytes: 0, createdAt: new Date().toISOString() });
  }

  for (const [t, rel] of Object.entries(outputs) as [ProductionTargetId, string][]) {
    const abs = path.join(OUTPUT_DIR, rel);
    const size = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    state.artifacts = state.artifacts.filter((a) => !(a.target === t && a.kind === 'video'));
    state.artifacts.push({ target: t, kind: 'video', relPath: rel, sizeBytes: size, createdAt: new Date().toISOString() });
  }

  saveProductionState(state);

  // Keep legacy NON-video deliverables fresh (metadata, provenance, captions).
  try {
    writeCaptions(project);
    writeMetadata(project, []);
  } catch {
    /* deliverable writers must never break the production build */
  }

  return {
    status,
    outputs,
    ...(result.packageResult
      ? { packageRoot: path.relative(OUTPUT_DIR, result.packageResult.packageRoot).replace(/\\/g, '/'), packageStatus: result.packageResult.package.summary.packageStatus }
      : {}),
    targets,
    audioEngine: PRODUCTION_AUDIO_ENGINE,
    renderResults: result.renderResult,
    targetSet: result.targetSet,
  };
}

/* ------------------------------------------------------------------ */
/*  Status / reopen                                                    */
/* ------------------------------------------------------------------ */

/** Compute the UI status of a project's production state. */
export function productionStatusFor(state: ProductionState, project: Project): ProductionState['status'] {
  if (state.status === 'blocked') return 'blocked';
  if (isStaleAgainstInput(state, project.meta.input)) return 'needs_regeneration';
  if (state.builds.some((b) => b.kind === 'final' && b.status === 'ok')) return 'ready_for_export';
  if (state.builds.some((b) => b.kind === 'preview' && b.status === 'ok')) return 'ready_for_preview';
  if (state.edits.length > 0) return 'edited';
  if (Object.keys(state.scenarios).length > 0) return 'generated';
  return state.status ?? 'not_generated';
}

/** Thumbnail still paths for a rendered target (preserved capability). */
export function productionThumbnailDir(videoId: string): string {
  return path.join(OUTPUT_DIR, videoId, 'thumbnails');
}

export type { ProductionState, ProductionArtifact, ProductionTargetEdit };
