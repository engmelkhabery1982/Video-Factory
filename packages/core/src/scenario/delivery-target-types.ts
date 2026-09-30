/**
 * BuildTrack Video Factory - Phase 6C Plan-Based Delivery Target Contract
 *
 * Phase 6C sits ABOVE the approved Phase 6B renderer. It adds deterministic
 * production DELIVERY TARGET orchestration for the plan-based system:
 *
 *   Scenario -> Phase 4 dialogue timing -> Phase 5 plans
 *     -> RemotionCompositionPlan -> Phase 6A mediaMap
 *       -> Phase 6B renderCompositionPlan() -> VideoPlan -> real media
 *
 * Each delivery target owns its OWN authoritative RemotionCompositionPlan.
 * A Short target is never derived by cropping, trimming or resizing the Long
 * plan: it is supplied as its own approved Short-format composition plan.
 *
 * This contract is deliberately NOT a second renderer and NOT a replacement
 * for the legacy `packages/core/src/targets.ts` LongVideo/ShortVideo path,
 * which stays for backward compatibility.
 *
 * Determinism: no timestamps, no randomness, no environment-derived ordering.
 * Target ordering is always long -> short_1 -> short_2 -> short_3.
 */

import type { RemotionCompositionPlan } from './remotion-composition-types.js';
import type { PlanRenderResult } from './plan-render-types.js';

export const PRODUCTION_DELIVERY_VERSION = '1.0.0' as const;

/* ------------------------------------------------------------------ */
/*  Target identity                                                     */
/* ------------------------------------------------------------------ */

/** The only delivery target ids Phase 6C understands. */
export type DeliveryTargetId = 'long' | 'short_1' | 'short_2' | 'short_3';

/** Short-only subset of `DeliveryTargetId`. */
export type ShortDeliveryTargetId = Exclude<DeliveryTargetId, 'long'>;

/**
 * Canonical, stable delivery ordering. Every ordered list this phase emits
 * (target arrays, summaries, render results) is sorted by this, never by
 * object key order, insertion order or anything environment-dependent.
 */
export const DELIVERY_TARGET_ORDER: readonly DeliveryTargetId[] = ['long', 'short_1', 'short_2', 'short_3'] as const;

export const LONG_DELIVERY_TARGET_ID: DeliveryTargetId = 'long';

export const SHORT_DELIVERY_TARGET_IDS: readonly ShortDeliveryTargetId[] = ['short_1', 'short_2', 'short_3'] as const;

/** The zero-to-three Short targets Phase 6C supports. */
export const MAX_SHORT_TARGETS = 3 as const;

/* ------------------------------------------------------------------ */
/*  Target format                                                       */
/* ------------------------------------------------------------------ */

/**
 * Delivery target format. Mirrors `ScenarioTargetFormat` minus `reusable`,
 * which is a production-reuse classification and not a delivery target.
 */
export type DeliveryTargetFormat = 'Long' | 'Short';

/** Locked geometry for each delivery format. */
export interface DeliveryTargetSpec {
  format: DeliveryTargetFormat;
  width: number;
  height: number;
  fps: number;
}

/**
 * Format -> locked dimensions. Mirrors `REMOTION_LAYOUT` in
 * `remotion-composition-types.ts` so a target can never disagree with the
 * composition contract it is rendered through.
 */
export const DELIVERY_TARGET_SPECS: Readonly<Record<DeliveryTargetFormat, DeliveryTargetSpec>> = {
  Long: { format: 'Long', width: 1920, height: 1080, fps: 30 },
  Short: { format: 'Short', width: 1080, height: 1920, fps: 30 },
} as const;

/** The format a target id must carry. `long` is Long; every short is Short. */
export function expectedFormatForTargetId(targetId: DeliveryTargetId): DeliveryTargetFormat {
  return targetId === LONG_DELIVERY_TARGET_ID ? 'Long' : 'Short';
}

/* ------------------------------------------------------------------ */
/*  Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Small, closed delivery-target error taxonomy. This is intentionally NOT a
 * second error framework: it is the target-level vocabulary that sits beside
 * the Phase 6B `PlanRenderErrorCode` it delegates structural checks to.
 */
export type ProductionDeliveryTargetErrorCode =
  | 'DELIVERY_TARGET_MISSING_PLAN'
  | 'DELIVERY_TARGET_FORMAT_MISMATCH'
  | 'DELIVERY_TARGET_DIMENSIONS_MISMATCH'
  | 'DELIVERY_TARGET_FPS_MISMATCH'
  | 'DELIVERY_TARGET_PROJECT_MISMATCH'
  | 'DELIVERY_TARGET_DUPLICATE_OUTPUT'
  | 'DELIVERY_TARGET_INVALID_PLAN'
  | 'DELIVERY_TARGET_OUTPUT_MISSING'
  | 'DELIVERY_TARGET_RENDER_FAILED';

export const PRODUCTION_DELIVERY_TARGET_ERROR_CODES: readonly ProductionDeliveryTargetErrorCode[] = [
  'DELIVERY_TARGET_MISSING_PLAN',
  'DELIVERY_TARGET_FORMAT_MISMATCH',
  'DELIVERY_TARGET_DIMENSIONS_MISMATCH',
  'DELIVERY_TARGET_FPS_MISMATCH',
  'DELIVERY_TARGET_PROJECT_MISMATCH',
  'DELIVERY_TARGET_DUPLICATE_OUTPUT',
  'DELIVERY_TARGET_INVALID_PLAN',
  'DELIVERY_TARGET_OUTPUT_MISSING',
  'DELIVERY_TARGET_RENDER_FAILED',
] as const;

/** Structured error for the delivery-target layer. */
export class ProductionDeliveryTargetError extends Error {
  public readonly code: ProductionDeliveryTargetErrorCode;
  public readonly targetId?: DeliveryTargetId;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ProductionDeliveryTargetErrorCode,
    message: string,
    options?: { targetId?: DeliveryTargetId; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'ProductionDeliveryTargetError';
    this.code = code;
    if (options?.targetId !== undefined) this.targetId = options.targetId;
    if (options?.details !== undefined) this.details = options.details;
  }
}

/* ------------------------------------------------------------------ */
/*  Findings                                                            */
/* ------------------------------------------------------------------ */

/** A per-target finding. `targetId` is always set so failures stay isolated. */
export interface ProductionDeliveryTargetFinding {
  severity: 'error' | 'warning';
  code: ProductionDeliveryTargetErrorCode;
  message: string;
  targetId?: DeliveryTargetId;
  sceneId?: string;
}

/* ------------------------------------------------------------------ */
/*  Target                                                              */
/* ------------------------------------------------------------------ */

/**
 * One authoritative delivery target.
 *
 * The target owns an immutable, deep-cloned copy of its plan and its mediaMap.
 * Nothing here is shared with another target or with the caller's input, so a
 * failure or mutation attempt in one target can never alter another.
 */
export interface ProductionDeliveryTarget {
  targetId: DeliveryTargetId;
  format: DeliveryTargetFormat;
  scenarioId: string;
  projectId: string;
  /** This target's own authoritative Phase 5C plan (immutable clone). */
  plan: RemotionCompositionPlan;
  /** This target's own Phase 6A mediaMap: logicalAssetRef -> render URL. */
  mediaMap: Record<string, string>;
  fps: number;
  width: number;
  height: number;
  /** `plan.totalActualDurationSeconds` - Phase 4 actual timing, never an estimate. */
  authoritativeDurationSeconds: number;
  durationInFrames: number;
  /** Canonical Phase 4 dialogue clips declared by this target's own plan. */
  canonicalAudioRefCount: number;
  /** Caption cues declared by this target's own plan. */
  captionCueCount: number;
  /** Logical asset usages declared by this target's own plan. */
  assetRefCount: number;
  sceneCount: number;
}

/* ------------------------------------------------------------------ */
/*  Target set                                                          */
/* ------------------------------------------------------------------ */

export interface ProductionDeliveryTargetSetSummary {
  /** Targets that survived validation, in canonical order. */
  targetCount: number;
  /** Every target the caller asked for (delivered or not), canonical order. */
  requestedTargetIds: DeliveryTargetId[];
  /** Targets that survived validation, canonical order. */
  deliveredTargetIds: DeliveryTargetId[];
  longCount: number;
  shortCount: number;
  /** Shared project identity, or null when no target validated. */
  projectId: string | null;
  errorCount: number;
  warningCount: number;
}

/**
 * The deterministic result of `buildProductionDeliveryTargets(...)`.
 * No timestamps and no runtime measurements: repeated builds of the same
 * input are structurally identical.
 */
export interface ProductionDeliveryTargetSet {
  version: typeof PRODUCTION_DELIVERY_VERSION;
  /** The Long target, or null when it is missing or invalid. */
  long: ProductionDeliveryTarget | null;
  /** The Short targets that validated, in canonical order. */
  shorts: ProductionDeliveryTarget[];
  /** `long` then `shorts`, i.e. every delivered target in canonical order. */
  targets: ProductionDeliveryTarget[];
  findings: ProductionDeliveryTargetFinding[];
  summary: ProductionDeliveryTargetSetSummary;
  /** True only when no target produced an error-severity finding. */
  valid: boolean;
}

/* ------------------------------------------------------------------ */
/*  Build input                                                         */
/* ------------------------------------------------------------------ */

/**
 * Input of `buildProductionDeliveryTargets(...)`.
 *
 * Only plan-based authority is accepted. Legacy `Scene[]`, `TargetMedia`,
 * `Project.storyboard`, `voiceoverFile` and `targetAudio` are NOT accepted:
 * they belong to the legacy path in `packages/core/src/targets.ts`.
 */
export interface BuildDeliveryTargetSetInput {
  /** The Long target's own approved Long-format plan. */
  longPlan?: RemotionCompositionPlan | null;
  /**
   * Short targets, keyed by target id. A Short is REQUESTED when its key is
   * present; a requested Short with a nullish plan is a structured error,
   * while a Short that was never requested is simply omitted.
   */
  shortPlans?: Partial<Record<ShortDeliveryTargetId, RemotionCompositionPlan | null>> | null;
  /**
   * Per-target Phase 6A mediaMap. `mediaMapByTarget[targetId]` is used for
   * that target ONLY - the Long map is never copied onto a Short. A missing
   * entry means `{}` for that target.
   */
  mediaMapByTarget?: Partial<Record<DeliveryTargetId, Record<string, string> | null>> | null;
}

/* ------------------------------------------------------------------ */
/*  Render (Phase 6B delegation)                                        */
/* ------------------------------------------------------------------ */

/** Overall delivery outcome: every target, some targets, or no target. */
export type ProductionDeliveryRenderStatus = 'ok' | 'partial' | 'error';

export interface ProductionDeliveryTargetRenderError {
  code: string;
  message: string;
  targetId: DeliveryTargetId;
}

/**
 * Per-target render outcome. A failing target never erases the results of
 * targets that succeeded, and nothing is silently substituted.
 */
export interface ProductionDeliveryTargetRenderResult {
  targetId: DeliveryTargetId;
  success: boolean;
  format: DeliveryTargetFormat | null;
  scenarioId: string | null;
  projectId: string | null;
  outputFile: string | null;
  renderResult?: PlanRenderResult;
  error?: ProductionDeliveryTargetRenderError;
}

export interface ProductionDeliveryRenderResult {
  version: typeof PRODUCTION_DELIVERY_VERSION;
  status: ProductionDeliveryRenderStatus;
  /** Every target the set covered, in canonical order. */
  targetCount: number;
  succeededTargetIds: DeliveryTargetId[];
  failedTargetIds: DeliveryTargetId[];
  /** One entry per covered target, in canonical order. */
  results: ProductionDeliveryTargetRenderResult[];
  /** Output-path and other delivery findings, including failed targets. */
  findings: ProductionDeliveryTargetFinding[];
}

/**
 * Input of `renderProductionDeliveryTargets(...)` (apps/api service).
 *
 * Output layout is CALLER-OWNED: Phase 6C never designs the export package,
 * so the caller supplies one output path per target.
 */
export interface RenderProductionDeliveryTargetsInput {
  targetSet: ProductionDeliveryTargetSet;
  /** Output `.mp4` path per target. Every covered target needs one. */
  outputByTarget: Partial<Record<DeliveryTargetId, string | null>>;
  quality?: 'preview' | 'final';
  brand?: unknown;
  /**
   * Optional per-target inclusive frame sub-range for cost control. This
   * encodes fewer frames; it never changes the plan or its timing authority.
   */
  frameRangeByTarget?: Partial<Record<DeliveryTargetId, [number, number] | null>>;
  onProgress?: (progress: number, note?: string) => void;
}
