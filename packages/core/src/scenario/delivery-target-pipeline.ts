/**
 * BuildTrack Video Factory - Phase 6C Plan-Based Delivery Target Pipeline
 *
 * Deterministic orchestration ABOVE the approved Phase 6B renderer.
 *
 * What this module does:
 *   - gives every delivery target its own identity, format, dimensions,
 *     plan, mediaMap and output;
 *   - validates each target independently (delegating the structural contract
 *     to the Phase 6B `validatePlanForRender`);
 *   - enforces the project-identity policy;
 *   - keeps targets isolated from each other and from the caller's input.
 *
 * What this module does NOT do:
 *   - it never renders (that is `renderProductionDeliveryTargets` calling
 *     Phase 6B `renderCompositionPlan`);
 *   - it never creates Short creative content from a Long scenario;
 *   - it never crops, trims or resizes a Long plan into a Short;
 *   - it never touches the legacy `targets.ts` LongVideo/ShortVideo path.
 *
 * Determinism: no timestamps, no randomness, no environment-derived ordering.
 * Every ordered output is sorted by `DELIVERY_TARGET_ORDER`.
 */

import type { RemotionCompositionPlan } from './remotion-composition-types.js';
import { validatePlanForRender } from './plan-render-validation.js';
import {
  DELIVERY_TARGET_ORDER,
  DELIVERY_TARGET_SPECS,
  LONG_DELIVERY_TARGET_ID,
  PRODUCTION_DELIVERY_VERSION,
  SHORT_DELIVERY_TARGET_IDS,
  expectedFormatForTargetId,
  type BuildDeliveryTargetSetInput,
  type DeliveryTargetFormat,
  type DeliveryTargetId,
  type ProductionDeliveryTarget,
  type ProductionDeliveryTargetFinding,
  type ProductionDeliveryTargetSet,
  type ProductionDeliveryTargetSetSummary,
  type ShortDeliveryTargetId,
} from './delivery-target-types.js';

/* ------------------------------------------------------------------ */
/*  Small deterministic helpers                                         */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isShortTargetId(targetId: DeliveryTargetId): targetId is ShortDeliveryTargetId {
  return targetId !== LONG_DELIVERY_TARGET_ID;
}

/** Sort any collection of target ids into the canonical delivery order. */
export function sortDeliveryTargetIds(ids: Iterable<DeliveryTargetId>): DeliveryTargetId[] {
  const present = new Set(ids);
  return DELIVERY_TARGET_ORDER.filter((id) => present.has(id));
}

function finding(
  severity: ProductionDeliveryTargetFinding['severity'],
  code: ProductionDeliveryTargetFinding['code'],
  message: string,
  targetId: DeliveryTargetId,
  sceneId?: string,
): ProductionDeliveryTargetFinding {
  return sceneId === undefined ? { severity, code, message, targetId } : { severity, code, message, targetId, sceneId };
}

function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + (pick(item) || 0), 0);
}

function countOf(plan: RemotionCompositionPlan, key: 'audioRefs' | 'captionCues' | 'assetRefs'): number {
  return sumBy(plan.scenes ?? [], (scene) => (Array.isArray(scene[key]) ? (scene[key] as unknown[]).length : 0));
}

/**
 * Deep-freeze so a target can never be mutated after it is built. Used on the
 * target's OWN COPY of the plan, never on the caller's input object.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // Plans are JSON-shaped; this only runs if structuredClone is unavailable
    // or the payload holds something unclonable.
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/**
 * A target's mediaMap is its own. A missing map is `{}` - the Long map is
 * never copied onto a Short. The Phase 6A contract is unchanged:
 * logicalAssetRef -> render URL.
 */
function normaliseMediaMap(input?: Record<string, string> | null): Record<string, string> {
  if (!input || !isRecord(input)) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Output-path comparison is textual (separator-normalised), never cwd-derived. */
function normaliseOutputPath(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

/* ------------------------------------------------------------------ */
/*  Per-target plan validation                                          */
/* ------------------------------------------------------------------ */

/**
 * Validate one target's plan against the locked geometry for its target id,
 * then hand the structural contract to the Phase 6B validator.
 *
 * The Phase 6B structural contract is REUSED, never duplicated.
 */
export function validateDeliveryTargetPlan(
  targetId: DeliveryTargetId,
  plan: unknown,
  mediaMap: Record<string, string> = {},
): ProductionDeliveryTargetFinding[] {
  const out: ProductionDeliveryTargetFinding[] = [];
  const expectedFormat = expectedFormatForTargetId(targetId);
  const spec = DELIVERY_TARGET_SPECS[expectedFormat];

  // A legacy Scene[] / TargetMedia / storyboard payload is not a plan authority.
  if (!isRecord(plan)) {
    out.push(
      finding(
        'error',
        'DELIVERY_TARGET_INVALID_PLAN',
        `target ${targetId} requires its own approved ${expectedFormat}-format RemotionCompositionPlan; a legacy Scene[]/TargetMedia/storyboard payload is not a plan authority`,
        targetId,
      ),
    );
    return out;
  }

  const p = plan as Partial<RemotionCompositionPlan>;

  if (p.valid === false) {
    out.push(
      finding(
        'error',
        'DELIVERY_TARGET_INVALID_PLAN',
        `the ${expectedFormat} plan supplied for target ${targetId} is marked invalid by the Phase 5C pipeline`,
        targetId,
      ),
    );
  }

  if (p.targetFormat !== expectedFormat) {
    out.push(
      finding(
        'error',
        'DELIVERY_TARGET_FORMAT_MISMATCH',
        `target ${targetId} requires targetFormat ${expectedFormat} but the supplied plan declares ${String(p.targetFormat)}`,
        targetId,
      ),
    );
  }

  if (p.width !== spec.width || p.height !== spec.height) {
    out.push(
      finding(
        'error',
        'DELIVERY_TARGET_DIMENSIONS_MISMATCH',
        `target ${targetId} requires ${spec.width}x${spec.height} but the supplied plan declares ${String(p.width)}x${String(p.height)}`,
        targetId,
      ),
    );
  }

  if (p.fps !== spec.fps) {
    out.push(
      finding(
        'error',
        'DELIVERY_TARGET_FPS_MISMATCH',
        `target ${targetId} requires ${spec.fps}fps but the supplied plan declares ${String(p.fps)}fps`,
        targetId,
      ),
    );
  }

  // Phase 6B remains the structural authority for anything that will be handed
  // to `renderCompositionPlan`. Warnings (for example an unresolved optional
  // asset) are surfaced but never fatal.
  for (const f of validatePlanForRender(p, mediaMap)) {
    out.push({
      severity: f.severity,
      code: 'DELIVERY_TARGET_INVALID_PLAN',
      message: `phase 6B ${f.severity} (${f.code}): ${f.message}`,
      targetId,
      ...(f.sceneId !== undefined ? { sceneId: f.sceneId } : {}),
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/*  Target construction                                                 */
/* ------------------------------------------------------------------ */

/**
 * Build a target from its own plan and its own mediaMap.
 *
 * The plan is DEEP-CLONED and then deep-frozen, so:
 *   - the caller's input plan is never mutated and never frozen;
 *   - one target can never mutate another target's plan.
 */
function makeTarget(
  targetId: DeliveryTargetId,
  plan: RemotionCompositionPlan,
  mediaMap: Record<string, string>,
): ProductionDeliveryTarget {
  const ownPlan = deepFreeze(cloneValue(plan));
  const ownMediaMap = deepFreeze({ ...mediaMap });

  return deepFreeze({
    targetId,
    // The plan's own declared format, preserved exactly (validation has
    // already proved it matches what this target id requires).
    format: ownPlan.targetFormat as DeliveryTargetFormat,
    scenarioId: ownPlan.scenarioId,
    projectId: ownPlan.projectId,
    plan: ownPlan,
    mediaMap: ownMediaMap,
    fps: ownPlan.fps,
    width: ownPlan.width,
    height: ownPlan.height,
    authoritativeDurationSeconds: ownPlan.totalActualDurationSeconds,
    durationInFrames: ownPlan.durationInFrames,
    canonicalAudioRefCount: countOf(ownPlan, 'audioRefs'),
    captionCueCount: countOf(ownPlan, 'captionCues'),
    assetRefCount: countOf(ownPlan, 'assetRefs'),
    sceneCount: (ownPlan.scenes ?? []).length,
  });
}

/* ------------------------------------------------------------------ */
/*  Build the delivery target set                                       */
/* ------------------------------------------------------------------ */

/**
 * Build the deterministic production delivery target set.
 *
 * `long` is always required. A Short is "requested" when its id appears as an
 * own key of `shortPlans`; a requested Short with no plan is a structured
 * error, while a Short that was never requested is simply omitted.
 */
export function buildProductionDeliveryTargets(input: BuildDeliveryTargetSetInput = {}): ProductionDeliveryTargetSet {
  const shortPlans = input.shortPlans ?? null;
  const mediaMapByTarget = input.mediaMapByTarget ?? null;

  const findings: ProductionDeliveryTargetFinding[] = [];
  const candidates: ProductionDeliveryTarget[] = [];

  // ── Long ────────────────────────────────────────────────────────────
  const longPlan = input.longPlan ?? null;
  if (longPlan === null || longPlan === undefined) {
    findings.push(
      finding(
        'error',
        'DELIVERY_TARGET_MISSING_PLAN',
        'the long target requires its own approved Long-format RemotionCompositionPlan',
        LONG_DELIVERY_TARGET_ID,
      ),
    );
  } else {
    const mediaMap = normaliseMediaMap(mediaMapByTarget?.[LONG_DELIVERY_TARGET_ID]);
    const targetFindings = validateDeliveryTargetPlan(LONG_DELIVERY_TARGET_ID, longPlan, mediaMap);
    findings.push(...targetFindings);
    if (!targetFindings.some((f) => f.severity === 'error')) {
      candidates.push(makeTarget(LONG_DELIVERY_TARGET_ID, longPlan, mediaMap));
    }
  }

  // ── Shorts, always in canonical order ───────────────────────────────
  const requestedShortIds = SHORT_DELIVERY_TARGET_IDS.filter(
    (id) => shortPlans !== null && Object.prototype.hasOwnProperty.call(shortPlans, id),
  );

  for (const targetId of requestedShortIds) {
    const plan = (shortPlans as Partial<Record<ShortDeliveryTargetId, RemotionCompositionPlan | null>>)[targetId];
    if (plan === null || plan === undefined) {
      findings.push(
        finding(
          'error',
          'DELIVERY_TARGET_MISSING_PLAN',
          `short target ${targetId} was requested but no Short-format RemotionCompositionPlan was supplied; Phase 6C does not infer, crop or generate one`,
          targetId,
        ),
      );
      continue;
    }
    const mediaMap = normaliseMediaMap(mediaMapByTarget?.[targetId]);
    const targetFindings = validateDeliveryTargetPlan(targetId, plan, mediaMap);
    findings.push(...targetFindings);
    if (!targetFindings.some((f) => f.severity === 'error')) {
      candidates.push(makeTarget(targetId, plan, mediaMap));
    }
  }

  // ── Project identity policy ─────────────────────────────────────────
  // Every target in one delivery set must belong to the same projectId.
  // scenarioId is NOT required to match: a Short may be a separate approved
  // scenario derived for the same production/project, and each target's
  // scenarioId is preserved exactly. Identity is never rewritten.
  if (candidates.length > 0) {
    const reference = candidates[0]!.projectId;
    for (const target of candidates) {
      if (target.projectId !== reference) {
        findings.push(
          finding(
            'error',
            'DELIVERY_TARGET_PROJECT_MISMATCH',
            `target ${target.targetId} belongs to project ${target.projectId} but this delivery set is scoped to project ${reference}; identity is never rewritten`,
            target.targetId,
          ),
        );
      }
    }
  }

  // ── Per-target failure isolation ────────────────────────────────────
  const errorTargetIds = new Set<DeliveryTargetId>();
  for (const f of findings) {
    if (f.severity === 'error' && f.targetId) errorTargetIds.add(f.targetId);
  }

  const delivered = sortDeliveryTargetIds(candidates.map((t) => t.targetId)).map(
    (id) => candidates.find((t) => t.targetId === id)!,
  );
  const targets = delivered.filter((t) => !errorTargetIds.has(t.targetId));

  const long = targets.find((t) => t.targetId === LONG_DELIVERY_TARGET_ID) ?? null;
  const shorts = targets.filter((t) => isShortTargetId(t.targetId));

  const summary: ProductionDeliveryTargetSetSummary = {
    targetCount: targets.length,
    requestedTargetIds: [LONG_DELIVERY_TARGET_ID, ...requestedShortIds],
    deliveredTargetIds: targets.map((t) => t.targetId),
    longCount: targets.filter((t) => t.targetId === LONG_DELIVERY_TARGET_ID).length,
    shortCount: shorts.length,
    projectId: targets[0]?.projectId ?? null,
    errorCount: findings.filter((f) => f.severity === 'error').length,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
  };

  const errorCount = summary.errorCount;

  return {
    version: PRODUCTION_DELIVERY_VERSION,
    long,
    shorts,
    targets,
    findings,
    summary,
    valid: errorCount === 0 && long !== null,
  };
}

/* ------------------------------------------------------------------ */
/*  Output path policy (caller-owned output layout)                     */
/* ------------------------------------------------------------------ */

/**
 * Validate the caller-supplied output paths.
 *
 * Phase 6C does not design the export package, so the caller owns the layout
 * and must supply one distinct path per covered target.
 */
export function validateDeliveryOutputPaths(
  targetIds: readonly DeliveryTargetId[],
  outputByTarget?: Partial<Record<DeliveryTargetId, string | null>> | null,
): ProductionDeliveryTargetFinding[] {
  const out: ProductionDeliveryTargetFinding[] = [];
  const seen = new Map<string, DeliveryTargetId>();

  for (const targetId of sortDeliveryTargetIds(targetIds)) {
    const raw = outputByTarget?.[targetId];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      out.push(
        finding(
          'error',
          'DELIVERY_TARGET_OUTPUT_MISSING',
          `no output path was supplied for target ${targetId}`,
          targetId,
        ),
      );
      continue;
    }
    const normalised = normaliseOutputPath(raw);
    const owner = seen.get(normalised);
    if (owner !== undefined) {
      out.push(
        finding(
          'error',
          'DELIVERY_TARGET_DUPLICATE_OUTPUT',
          `target ${targetId} would write to the same output as target ${owner}: ${normalised}`,
          targetId,
        ),
      );
      continue;
    }
    seen.set(normalised, targetId);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/*  Consumers                                                           */
/* ------------------------------------------------------------------ */

/** Error-severity findings grouped by target, in canonical order. */
export function deliveryTargetErrorsByTarget(
  findings: readonly ProductionDeliveryTargetFinding[],
): Map<DeliveryTargetId, ProductionDeliveryTargetFinding[]> {
  const byTarget = new Map<DeliveryTargetId, ProductionDeliveryTargetFinding[]>();
  for (const f of findings) {
    if (f.severity !== 'error' || !f.targetId) continue;
    const list = byTarget.get(f.targetId) ?? [];
    list.push(f);
    byTarget.set(f.targetId, list);
  }
  return byTarget;
}

/**
 * Every target the set covers: the ones that validated plus the ones that
 * failed validation, so a failed target stays visible in render results
 * instead of silently disappearing.
 */
export function coveredDeliveryTargetIds(set: ProductionDeliveryTargetSet): DeliveryTargetId[] {
  const ids = new Set<DeliveryTargetId>();
  for (const t of set.targets) ids.add(t.targetId);
  for (const f of set.findings) if (f.targetId) ids.add(f.targetId);
  return sortDeliveryTargetIds(ids);
}
