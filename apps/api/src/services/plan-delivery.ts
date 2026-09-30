/**
 * BuildTrack Video Factory - Phase 6C Plan-Based Delivery Service
 *
 * Renders a built `ProductionDeliveryTargetSet` by delegating to the approved
 * Phase 6B renderer, ONCE PER TARGET.
 *
 *   ProductionDeliveryTargetSet -> renderCompositionPlan(...) -> VideoPlan
 *
 * Contract:
 *   - no Remotion logic is duplicated here; Phase 6B owns rendering;
 *   - the legacy `renderTarget(...)` / `muxAndEncode(...)` path in
 *     `services/pipeline.ts` and `services/render.ts` is NEVER used for these
 *     plan-based targets;
 *   - each target keeps its own plan, its own Phase 6A mediaMap, its own
 *     canonical Phase 4 audio and its own captions. Nothing is shared, copied
 *     or substituted between targets;
 *   - one target failing never erases the results of the others;
 *   - output layout is CALLER-OWNED (Phase 6D owns the export package).
 */

import {
  coveredDeliveryTargetIds,
  deliveryTargetErrorsByTarget,
  validateDeliveryOutputPaths,
  ProductionDeliveryTargetError,
  PRODUCTION_DELIVERY_VERSION,
  type DeliveryTargetId,
  type ProductionDeliveryRenderResult,
  type ProductionDeliveryTarget,
  type ProductionDeliveryTargetFinding,
  type ProductionDeliveryTargetRenderResult,
  type RenderProductionDeliveryTargetsInput,
} from '@buildtrack/core';
import { PlanRenderError, renderCompositionPlan } from './render.js';

/** Render error code used when an unexpected (non Phase 6B) failure occurs. */
const DEFAULT_RENDER_ERROR = 'DELIVERY_TARGET_RENDER_FAILED';

function outputFor(
  input: RenderProductionDeliveryTargetsInput,
  targetId: DeliveryTargetId,
): string | null {
  const raw = input.outputByTarget?.[targetId];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

/**
 * Render every delivered target in the set.
 *
 * Targets that failed validation or output-path checks are reported as
 * structured per-target failures and are never rendered; targets that
 * validated are rendered independently so a failure cannot cascade.
 */
export async function renderProductionDeliveryTargets(
  input: RenderProductionDeliveryTargetsInput,
): Promise<ProductionDeliveryRenderResult> {
  const targetSet = input?.targetSet;
  if (!targetSet) {
    throw new ProductionDeliveryTargetError(
      'DELIVERY_TARGET_INVALID_PLAN',
      'renderProductionDeliveryTargets requires a built ProductionDeliveryTargetSet',
    );
  }

  // Every target the set knows about, in canonical long -> short_N order.
  const covered = coveredDeliveryTargetIds(targetSet);

  // ── caller-owned output layout ──────────────────────────────────────
  const findings: ProductionDeliveryTargetFinding[] = [...validateDeliveryOutputPaths(covered, input.outputByTarget)];

  const validationErrors = deliveryTargetErrorsByTarget(targetSet.findings);
  const outputErrors = deliveryTargetErrorsByTarget(findings);

  const byId = new Map<DeliveryTargetId, ProductionDeliveryTarget>();
  for (const target of targetSet.targets) byId.set(target.targetId, target);

  const results: ProductionDeliveryTargetRenderResult[] = [];
  const total = Math.max(1, covered.length);

  for (const targetId of covered) {
    const target = byId.get(targetId) ?? null;
    const blocking = [...(validationErrors.get(targetId) ?? []), ...(outputErrors.get(targetId) ?? [])];

    // ── blocked before rendering: structured, isolated, never substituted ──
    if (!target || blocking.length > 0) {
      const first = blocking[0];
      results.push({
        targetId,
        success: false,
        format: target?.format ?? null,
        scenarioId: target?.scenarioId ?? null,
        projectId: target?.projectId ?? null,
        outputFile: outputFor(input, targetId),
        error: {
          // Phase 6B codes survive verbatim; target-level codes stay as-is.
          code: first?.code ?? 'DELIVERY_TARGET_INVALID_PLAN',
          message: first?.message ?? `target ${targetId} was not delivered by the target set`,
          targetId,
        },
      });
      continue;
    }

    const outputFile = outputFor(input, targetId)!;
    const done = results.length;

    try {
      const renderResult = await renderCompositionPlan({
        // The target's OWN plan, mediaMap and canonical audio. No cross-target
        // reuse, no external targetAudio, no re-muxing.
        plan: target.plan,
        outputFile,
        mediaMap: target.mediaMap,
        ...(input.brand !== undefined ? { brand: input.brand } : {}),
        ...(input.quality !== undefined ? { quality: input.quality } : {}),
        frameRange: input.frameRangeByTarget?.[targetId] ?? null,
        onProgress: (progress: number, note?: string) => {
          input.onProgress?.(
            Math.min(1, (done + Math.min(1, Math.max(0, progress))) / total),
            note ? `${targetId}: ${note}` : targetId,
          );
        },
      });

      results.push({
        targetId,
        success: true,
        format: target.format,
        scenarioId: target.scenarioId,
        projectId: target.projectId,
        outputFile,
        renderResult,
      });
    } catch (err) {
      // Isolation: record and continue. Other targets keep their results.
      const failure = err as Partial<PlanRenderError> & Error;
      const code =
        typeof failure?.code === 'string' && failure.code.length > 0
          ? failure.code
          : err instanceof PlanRenderError
            ? failure.code ?? DEFAULT_RENDER_ERROR
            : DEFAULT_RENDER_ERROR;

      results.push({
        targetId,
        success: false,
        format: target.format,
        scenarioId: target.scenarioId,
        projectId: target.projectId,
        outputFile,
        error: {
          code,
          message: failure?.message ?? String(err),
          targetId,
        },
      });
    }
  }

  const succeededTargetIds = results.filter((r) => r.success).map((r) => r.targetId);
  const failedTargetIds = results.filter((r) => !r.success).map((r) => r.targetId);

  const status: ProductionDeliveryRenderResult['status'] =
    results.length === 0 || succeededTargetIds.length === 0
      ? 'error'
      : failedTargetIds.length === 0
        ? 'ok'
        : 'partial';

  input.onProgress?.(1, 'delivery render complete');

  return {
    version: PRODUCTION_DELIVERY_VERSION,
    status,
    targetCount: results.length,
    succeededTargetIds,
    failedTargetIds,
    results,
    findings,
  };
}
