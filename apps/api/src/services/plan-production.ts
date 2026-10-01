/**
 * BuildTrack Video Factory - Phase 6E Thin Final Orchestration Service
 *
 * Proves the complete approved production chain works together:
 *   Scenario / approved Phase 4 authority
 *     ↓ Phase 5 production plans
 *     ↓ Phase 6A asset resolution
 *     ↓ Phase 6B VideoPlan rendering
 *     ↓ Phase 6C Long + Short delivery targets
 *     ↓ Phase 6D production package + QC
 *     ↓ FINAL READY DELIVERY PACKAGE
 *
 * This is a THIN orchestrator: it delegates to approved existing APIs and
 * never duplicates rendering, packaging, timing, caption or asset-resolution logic.
 *
 * Approved APIs reused:
 *   Phase 5:
 *     - compileScenarioVisualPlan
 *     - buildVisualProductionPlan
 *     - buildSceneRenderPlan
 *     - buildRemotionCompositionProps
 *     - buildDialogueProductionPlan (Phase 4E, required to feed Phase 5A)
 *   Phase 6A:
 *     - resolveProductionAssets
 *   Phase 6C:
 *     - buildProductionDeliveryTargets
 *     - renderProductionDeliveryTargets
 *   Phase 6D:
 *     - buildProductionDeliveryPackage (core planner) via service buildProductionDeliveryPackage
 *
 * No legacy fallback:
 *   - Project.storyboard, Scene[], TargetMedia, renderTarget(LongVideo/ShortVideo),
 *     external narration mux, targetAudio, storyboard captions, exportProject
 *   are NEVER used as final production authority.
 */

import type { Asset } from '@buildtrack/core';
import {
  compileScenarioVisualPlan,
  getProgressMeetingScenario,
  loadScenarioFixture,
  resolveProductionAssets,
  buildProductionDeliveryTargets,
  buildDialogueProductionPlan,
  buildVisualProductionPlan,
  buildSceneRenderPlan,
  buildRemotionCompositionProps,
  type RemotionCompositionPlan,
  type Scenario,
  type ProductionAssetResolutionReport,
  type ProductionDeliveryTargetSet,
  type DeliveryTargetId,
} from '@buildtrack/core';

// Phase 6C + 6D services (approved)
import { renderProductionDeliveryTargets } from './plan-delivery.js';
import { buildProductionDeliveryPackage as buildPackageService } from './plan-package.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const CANONICAL_LONG_SCENARIO_ID = 'scenario-pm-01';
export const CANONICAL_SHORT_SCENARIO_ID = 'scenario-sched-risk-03';
export const CANONICAL_PROJECT_ID = 'proj-hospital-expansion';
export const CANONICAL_LONG_ASSET_REF = 'asset-iva-progress-chart';
export const CANONICAL_ASSET_ALIAS = 'asset-ref:asset-iva-progress-chart';
export const CANONICAL_SCENE_ID = 'sc-02-context';
export const CANONICAL_RENDERER_KEY = 'explanation:key_statement';

export const LONG_EXPECTED = {
  targetFormat: 'Long' as const,
  width: 1920,
  height: 1080,
  fps: 30,
  sceneCount: 5,
  audioRefCount: 12,
  captionCueCount: 28,
  beatCount: 12,
  assetUsageCount: 2,
  authoritativeSeconds: 118.74,
  durationInFrames: 3563,
  lastValidFrame: 3562,
  estimatedSeconds: 102,
} as const;

export const SHORT_EXPECTED = {
  targetFormat: 'Short' as const,
  width: 1080,
  height: 1920,
  fps: 30,
  sceneCount: 3,
  audioRefCount: 7,
  captionCueCount: 15,
  authoritativeSeconds: 48.99,
  durationInFrames: 1470,
} as const;

/* ------------------------------------------------------------------ */
/*  Scenario builders                                                  */
/* ------------------------------------------------------------------ */

/**
 * Canonical Long scenario: scenario-pm-01 / proj-hospital-expansion
 * Returns a deep clone so caller can mutate without affecting fixture.
 */
export function buildCanonicalLongScenario(): Scenario {
  const base = getProgressMeetingScenario();
  // Ensure identity is exactly canonical (fixture already is, but we enforce)
  const cloned = structuredClone(base) as Scenario;
  cloned.metadata.id = CANONICAL_LONG_SCENARIO_ID;
  cloned.metadata.projectId = CANONICAL_PROJECT_ID;
  cloned.metadata.targetFormat = 'Long';
  return cloned;
}

/**
 * Short scenario: scenario-sched-risk-03 aligned immutably to proj-hospital-expansion.
 * Does NOT mutate original fixture: we clone and set targetFormat BEFORE pipeline.
 */
export function buildCanonicalShortScenario(
  scenarioId: string = CANONICAL_SHORT_SCENARIO_ID,
  projectId: string = CANONICAL_PROJECT_ID,
): Scenario {
  const base = loadScenarioFixture('schedule-risk');
  const cloned = structuredClone(base) as Scenario;
  cloned.metadata = {
    ...cloned.metadata,
    id: scenarioId,
    projectId,
    targetFormat: 'Short',
  };
  return cloned;
}

/* ------------------------------------------------------------------ */
/*  Phase 5 plan builder                                               */
/* ------------------------------------------------------------------ */

export interface BuildRemotionPlanOptions {
  synthesisBasePath: string;
  canonicalBasePath: string;
  /**
   * Phase 4 synthesis mode. 'production' selects the local Kokoro synthesizer
   * (cache-only, actionable failure when unprovisioned); 'reference' keeps SAM.
   * Workstream D production/preview builds ALWAYS pass 'production'.
   */
  synthesisMode?: 'reference' | 'production';
}

export interface BuildRemotionPlanResult {
  plan: RemotionCompositionPlan;
  scenario: Scenario;
}

/**
 * Run the approved Scenario -> Phase 5 chain for one scenario.
 * This is the ONLY way a plan enters Phase 6E: nothing hand-builds a composition plan.
 */
export async function buildRemotionPlanFromScenario(
  scenario: Scenario,
  options: BuildRemotionPlanOptions,
): Promise<BuildRemotionPlanResult> {
  const visual = compileScenarioVisualPlan(scenario);
  if (!visual.ok) {
    throw new Error(`compileScenarioVisualPlan failed: ${JSON.stringify(visual.errors)}`);
  }

  const dialogue: any = await buildDialogueProductionPlan(scenario, {
    synthesisBasePath: options.synthesisBasePath,
    canonicalBasePath: options.canonicalBasePath,
    ...(options.synthesisMode ? { synthesisMode: options.synthesisMode } : {}),
  });
  if (!dialogue.success) {
    throw new Error(`buildDialogueProductionPlan failed: ${dialogue.error}`);
  }

  const visualProd: any = buildVisualProductionPlan({
    scenario,
    visualPlan: visual.plan,
    dialogueResult: dialogue.result,
  });
  if (!visualProd.success) {
    throw new Error(`buildVisualProductionPlan failed: ${visualProd.error}`);
  }

  const sceneRender: any = buildSceneRenderPlan({
    scenario,
    visualProductionPlan: visualProd.plan,
  });
  if (!sceneRender.success) {
    throw new Error(`buildSceneRenderPlan failed: ${sceneRender.error}`);
  }

  const remotion: any = buildRemotionCompositionProps(sceneRender.plan);
  if (!remotion.success) {
    throw new Error(`buildRemotionCompositionProps failed: ${remotion.error}`);
  }

  return {
    plan: remotion.plan as RemotionCompositionPlan,
    scenario,
  };
}

/* ------------------------------------------------------------------ */
/*  Phase 6A asset resolution                                          */
/* ------------------------------------------------------------------ */

/**
 * Create a real eligible local Asset record for asset-iva-progress-chart.
 * Must be active, blocked=false, source non-empty, license non-empty, with exact alias tag.
 */
export function createCanonicalAssetRecord(overrides: Partial<Asset> = {}): Asset {
  const base: Asset = {
    id: 'asset-progress-chart-real',
    name: 'Progress Chart',
    kind: 'chart',
    fileName: 'progress-chart.png',
    path: 'assets/progress-chart.png',
    mimeType: 'image/png',
    sizeBytes: 2135,
    tags: [CANONICAL_ASSET_ALIAS],
    status: 'active',
    preferred: true,
    source: 'Local deterministic fixture (offline)',
    license: 'Generated for Phase 6E production',
    addedAt: '2026-09-30T00:00:00.000Z',
    usedIn: [],
    blocked: false,
    ...overrides,
  } as Asset;
  return base;
}

/**
 * Resolve Long production assets through approved Phase 6A API.
 * Asserts resolver contract: valid, errorCount 0, totalUsages 2, unique refs 1, resolved unique 1,
 * and mediaMap['asset-iva-progress-chart'] comes from resolver (not fabricated).
 */
export function resolveLongProductionAssets(input: {
  plan: RemotionCompositionPlan;
  assets: readonly Asset[];
  assetUrlById: Record<string, string>;
}): ProductionAssetResolutionReport {
  const report = resolveProductionAssets({
    plan: input.plan,
    assets: input.assets,
    assetUrlById: input.assetUrlById,
  });

  // The caller (evidence runner / tests) must assert these invariants; we do not throw
  // here to keep this a thin delegation, but we expose the report for validation.
  return report;
}

/* ------------------------------------------------------------------ */
/*  Phase 6C target set                                                */
/* ------------------------------------------------------------------ */

export interface BuildFinalTargetSetInput {
  /** Long plan. Optional for Short-only projects. */
  longPlan?: RemotionCompositionPlan | null;
  /** Short plans keyed by Phase 6C target id. Any subset of short_1..short_3. */
  shortPlans?: Partial<Record<'short_1' | 'short_2' | 'short_3', RemotionCompositionPlan | null>> | null;
  /** Back-compat alias for `shortPlans.short_1` (earlier Phase 6E callers). */
  shortPlan?: RemotionCompositionPlan | null;
  mediaMapByTarget: Partial<Record<DeliveryTargetId, Record<string, string>>>;
}

/** Merge the legacy singular `shortPlan` alias into the keyed `shortPlans` map. */
function mergeShortPlans(input: {
  shortPlan?: RemotionCompositionPlan | null;
  shortPlans?: Partial<Record<'short_1' | 'short_2' | 'short_3', RemotionCompositionPlan | null>> | null;
}): Partial<Record<'short_1' | 'short_2' | 'short_3', RemotionCompositionPlan>> {
  const merged: Partial<Record<'short_1' | 'short_2' | 'short_3', RemotionCompositionPlan>> = {};
  if (input.shortPlan) merged.short_1 = input.shortPlan;
  for (const [k, v] of Object.entries(input.shortPlans ?? {})) {
    if (v) merged[k as 'short_1' | 'short_2' | 'short_3'] = v;
  }
  return merged;
}

/**
 * Generalized target-set builder (Workstream D):
 * supports Long-only, Short-only, and Long + any subset of Shorts by passing
 * the plans through to the approved Phase 6C API unchanged.
 */
export function buildFinalTargetSet(input: BuildFinalTargetSetInput): ProductionDeliveryTargetSet {
  return buildProductionDeliveryTargets({
    ...(input.longPlan ? { longPlan: input.longPlan } : {}),
    shortPlans: mergeShortPlans(input),
    mediaMapByTarget: input.mediaMapByTarget,
  });
}

/* ------------------------------------------------------------------ */
/*  Full E2E orchestration                                             */
/* ------------------------------------------------------------------ */

export interface RunPlanBasedProductionExportInput {
  /** Long plan. Optional for Short-only projects. */
  longPlan?: RemotionCompositionPlan | null;
  /** Short plans keyed by Phase 6C target id. Any subset of short_1..short_3. */
  shortPlans?: Partial<Record<'short_1' | 'short_2' | 'short_3', RemotionCompositionPlan | null>> | null;
  /** Back-compat alias for `shortPlans.short_1` (earlier Phase 6E callers). */
  shortPlan?: RemotionCompositionPlan | null;
  mediaMapByTarget: Partial<Record<DeliveryTargetId, Record<string, string>>>;
  outputByTarget: Partial<Record<DeliveryTargetId, string>>;
  /**
   * Package root. When omitted (or empty) NO Phase 6D package is built and the
   * render result is returned directly — used by the product preview path.
   */
  packageRoot?: string;
  mode?: 'production' | 'test-evidence';
  clean?: 'none' | 'stale' | 'full';
  repoRoot?: string | null;
  quality?: 'preview' | 'final';
  brand?: unknown;
  onProgress?: (progress: number, note?: string) => void;
}

export interface RunPlanBasedProductionExportResult {
  targetSet: ProductionDeliveryTargetSet;
  renderResult: Awaited<ReturnType<typeof renderProductionDeliveryTargets>>;
  packageResult?: Awaited<ReturnType<typeof buildPackageService>>;
}

/**
 * Thin final orchestrator: delegates to approved Phase 6C + 6D APIs.
 * Does NOT duplicate rendering, packaging, timing, caption or asset-resolution logic.
 * No legacy fallback.
 *
 * Supports Long-only, Short-only, and Long + any subset of Shorts. For
 * Short-only projects the intentional core 'long requires a plan' finding is
 * expected and filtered; per-target validation is unaffected. When `packageRoot`
 * is omitted, only the render runs (preview path) and `packageResult` stays
 * undefined.
 */
export async function runPlanBasedProductionExport(
  input: RunPlanBasedProductionExportInput,
): Promise<RunPlanBasedProductionExportResult> {
  const remergedShortPlans = mergeShortPlans(input);
  const hasLong = Boolean(input.longPlan);
  const shortsProvided = Object.keys(remergedShortPlans) as Array<'short_1' | 'short_2' | 'short_3'>;
  if (!hasLong && shortsProvided.length === 0) {
    throw new Error('runPlanBasedProductionExport requires at least one target (longPlan or shortPlans)');
  }

  // Phase 6C: build the target set from the provided plans (any combination)
  const targetSet = buildFinalTargetSet({
    longPlan: input.longPlan ?? null,
    shortPlans: remergedShortPlans,
    mediaMapByTarget: input.mediaMapByTarget,
  });

  // Short-only projects: the core long-plan finding is intentional, not an error.
  const relevantFindings = hasLong
    ? targetSet.findings
    : targetSet.findings.filter((f) => !(f.targetId === 'long' && f.code === 'DELIVERY_TARGET_MISSING_PLAN'));
  const blockingErrors = relevantFindings.filter((f) => f.severity === 'error');
  if (blockingErrors.length > 0 || targetSet.targets.length === 0) {
    throw new Error(`ProductionDeliveryTargetSet invalid: ${JSON.stringify(relevantFindings)}`);
  }

  // Phase 6C: render through Phase 6B authority (VideoPlan), per target
  const renderResult = await renderProductionDeliveryTargets({
    targetSet,
    outputByTarget: input.outputByTarget,
    quality: input.quality ?? 'final',
    brand: input.brand,
    onProgress: input.onProgress,
  });

  // Phase 6D: package with mode production (only production may reach READY).
  // Preview runs skip packaging entirely.
  if (!input.packageRoot) {
    return { targetSet, renderResult };
  }

  const packageResult = await buildPackageService({
    targetSet,
    renderResult,
    packageRoot: input.packageRoot,
    mode: input.mode ?? 'production',
    clean: input.clean ?? 'full',
    repoRoot: input.repoRoot ?? null,
  });

  return {
    targetSet,
    renderResult,
    packageResult,
  };
}

/* ------------------------------------------------------------------ */
/*  Validation helpers for failure gates (fast, no full render)        */
/* ------------------------------------------------------------------ */

export function validateLongPlanInvariants(plan: RemotionCompositionPlan): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (plan.scenarioId !== CANONICAL_LONG_SCENARIO_ID) errors.push(`scenarioId expected ${CANONICAL_LONG_SCENARIO_ID} got ${plan.scenarioId}`);
  if (plan.projectId !== CANONICAL_PROJECT_ID) errors.push(`projectId expected ${CANONICAL_PROJECT_ID} got ${plan.projectId}`);
  if (plan.targetFormat !== LONG_EXPECTED.targetFormat) errors.push(`targetFormat expected Long got ${plan.targetFormat}`);
  if (plan.width !== LONG_EXPECTED.width || plan.height !== LONG_EXPECTED.height) errors.push(`dimensions expected ${LONG_EXPECTED.width}x${LONG_EXPECTED.height} got ${plan.width}x${plan.height}`);
  if (plan.fps !== LONG_EXPECTED.fps) errors.push(`fps expected ${LONG_EXPECTED.fps} got ${plan.fps}`);
  if (plan.scenes.length !== LONG_EXPECTED.sceneCount) errors.push(`sceneCount expected ${LONG_EXPECTED.sceneCount} got ${plan.scenes.length}`);
  if (plan.durationInFrames !== LONG_EXPECTED.durationInFrames) errors.push(`durationInFrames expected ${LONG_EXPECTED.durationInFrames} got ${plan.durationInFrames}`);
  if (plan.totalActualDurationSeconds !== LONG_EXPECTED.authoritativeSeconds) errors.push(`authoritativeSeconds expected ${LONG_EXPECTED.authoritativeSeconds} got ${plan.totalActualDurationSeconds}`);
  const audioCount = plan.scenes.reduce((n, s) => n + (s.audioRefs?.length ?? 0), 0);
  const captionCount = plan.scenes.reduce((n, s) => n + (s.captionCues?.length ?? 0), 0);
  const beatCount = plan.scenes.reduce((n, s) => n + (s.beats?.length ?? 0), 0);
  const assetCount = plan.scenes.reduce((n, s) => n + (s.assetRefs?.length ?? 0), 0);
  if (audioCount !== LONG_EXPECTED.audioRefCount) errors.push(`audioRefCount expected ${LONG_EXPECTED.audioRefCount} got ${audioCount}`);
  if (captionCount !== LONG_EXPECTED.captionCueCount) errors.push(`captionCueCount expected ${LONG_EXPECTED.captionCueCount} got ${captionCount}`);
  if (beatCount !== LONG_EXPECTED.beatCount) errors.push(`beatCount expected ${LONG_EXPECTED.beatCount} got ${beatCount}`);
  if (assetCount !== LONG_EXPECTED.assetUsageCount) errors.push(`assetUsageCount expected ${LONG_EXPECTED.assetUsageCount} got ${assetCount}`);

  // Canonical asset visibility: sc-02-context must remain rendererKey = explanation:key_statement
  const sc02 = plan.scenes.find((s) => s.sceneId === CANONICAL_SCENE_ID);
  if (!sc02) errors.push(`missing scene ${CANONICAL_SCENE_ID}`);
  else if (sc02.rendererKey !== CANONICAL_RENDERER_KEY) errors.push(`rendererKey for ${CANONICAL_SCENE_ID} expected ${CANONICAL_RENDERER_KEY} got ${sc02.rendererKey}`);

  return { valid: errors.length === 0, errors };
}

export function validateShortPlanInvariants(plan: RemotionCompositionPlan): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (plan.targetFormat !== SHORT_EXPECTED.targetFormat) errors.push(`targetFormat expected Short got ${plan.targetFormat}`);
  if (plan.width !== SHORT_EXPECTED.width || plan.height !== SHORT_EXPECTED.height) errors.push(`dimensions expected ${SHORT_EXPECTED.width}x${SHORT_EXPECTED.height} got ${plan.width}x${plan.height}`);
  if (plan.fps !== SHORT_EXPECTED.fps) errors.push(`fps expected ${SHORT_EXPECTED.fps} got ${plan.fps}`);
  if (plan.scenes.length !== SHORT_EXPECTED.sceneCount) errors.push(`sceneCount expected ${SHORT_EXPECTED.sceneCount} got ${plan.scenes.length}`);
  if (plan.durationInFrames !== SHORT_EXPECTED.durationInFrames) errors.push(`durationInFrames expected ${SHORT_EXPECTED.durationInFrames} got ${plan.durationInFrames}`);
  if (plan.totalActualDurationSeconds !== SHORT_EXPECTED.authoritativeSeconds) errors.push(`authoritativeSeconds expected ${SHORT_EXPECTED.authoritativeSeconds} got ${plan.totalActualDurationSeconds}`);
  const audioCount = plan.scenes.reduce((n, s) => n + (s.audioRefs?.length ?? 0), 0);
  const captionCount = plan.scenes.reduce((n, s) => n + (s.captionCues?.length ?? 0), 0);
  if (audioCount !== SHORT_EXPECTED.audioRefCount) errors.push(`audioRefCount expected ${SHORT_EXPECTED.audioRefCount} got ${audioCount}`);
  if (captionCount !== SHORT_EXPECTED.captionCueCount) errors.push(`captionCueCount expected ${SHORT_EXPECTED.captionCueCount} got ${captionCount}`);
  if (plan.projectId !== CANONICAL_PROJECT_ID) errors.push(`projectId expected ${CANONICAL_PROJECT_ID} got ${plan.projectId}`);
  return { valid: errors.length === 0, errors };
}

export function validateAssetResolutionReport(report: ProductionAssetResolutionReport): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!report.valid) errors.push('resolution.valid must be true');
  if (report.summary.errorCount !== 0) errors.push(`errorCount expected 0 got ${report.summary.errorCount}`);
  if (report.summary.totalUsages !== 2) errors.push(`totalUsages expected 2 got ${report.summary.totalUsages}`);
  if (report.summary.totalUniqueLogicalRefs !== 1) errors.push(`totalUniqueLogicalRefs expected 1 got ${report.summary.totalUniqueLogicalRefs}`);
  if (report.summary.totalResolvedUnique !== 1) errors.push(`totalResolvedUnique expected 1 got ${report.summary.totalResolvedUnique}`);
  if (!report.mediaMap[CANONICAL_LONG_ASSET_REF]) errors.push(`mediaMap missing ${CANONICAL_LONG_ASSET_REF}`);
  if (!report.assetIdMap[CANONICAL_LONG_ASSET_REF]) errors.push(`assetIdMap missing ${CANONICAL_LONG_ASSET_REF}`);
  return { valid: errors.length === 0, errors };
}
