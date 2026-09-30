/**
 * BuildTrack Video Factory - Phase 6A Core Production Asset Resolution
 *
 * Deterministically resolves RemotionCompositionPlan logical asset references
 * to Asset library entries, optional render URLs, and the renderer-facing mediaMap.
 *
 * Locked resolution order:
 * 1. Priority 1 — Explicit binding (explicitBindings[assetRef])
 * 2. Priority 2 — Exact Asset ID (active asset with asset.id === assetRef)
 * 3. Priority 3 — Explicit alias tag (asset-ref:<logicalAssetRef>)
 * Otherwise — Unresolved
 *
 * Invariants:
 * - Pure function: zero I/O, zero network, zero filesystem dependencies.
 * - Plan immutability: never mutates input plan, assets, or maps.
 * - Strict determinism: identical inputs produce byte-equivalent outputs.
 * - Duplicate logical references resolved ONCE, all usages preserved.
 * - mediaMap key direction: logicalAssetRef -> renderURL.
 */

import type { Asset } from '../types.js';
import {
  PRODUCTION_ASSET_ALIAS_PREFIX,
  PRODUCTION_ASSET_RESOLUTION_VERSION,
  type ProductionAssetBinding,
  type ProductionAssetErrorCode,
  type ProductionAssetFinding,
  type ProductionAssetFindingLocation,
  type ProductionAssetResolutionInput,
  type ProductionAssetResolutionReport,
  type ProductionAssetResolutionSource,
  type ProductionAssetResolutionSummary,
  type ProductionAssetUsage,
} from './production-asset-types.js';

/** Validates that a logical asset reference string is structurally safe and non-empty */
export function validateLogicalAssetRef(assetRef: unknown): { valid: boolean; warning?: string } {
  if (!assetRef || typeof assetRef !== 'string') {
    return { valid: false, warning: 'assetRef must be a non-empty string' };
  }
  const trimmed = assetRef.trim();
  if (!trimmed) {
    return { valid: false, warning: 'assetRef cannot be empty or whitespace' };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    return { valid: false, warning: `assetRef absolute paths not allowed: '${trimmed}'` };
  }
  if (trimmed.includes('..')) {
    return { valid: false, warning: `assetRef contains path traversal (..): '${trimmed}'` };
  }
  return { valid: true };
}

/** Formats an exact alias tag for a given logical asset reference */
export function formatAssetRefAliasTag(logicalAssetRef: string): string {
  return `${PRODUCTION_ASSET_ALIAS_PREFIX}${logicalAssetRef}`;
}

/** Parses the logical asset reference from an alias tag, or null if not matching prefix */
export function parseAssetRefAliasTag(tag: string): string | null {
  if (typeof tag === 'string' && tag.startsWith(PRODUCTION_ASSET_ALIAS_PREFIX)) {
    return tag.slice(PRODUCTION_ASSET_ALIAS_PREFIX.length);
  }
  return null;
}

/**
 * Checks whether an Asset library entry meets production eligibility criteria:
 * - status === 'active'
 * - blocked === false
 * - source is non-empty string
 * - license is non-empty string
 */
export function isProductionAssetEligible(asset: Asset): {
  eligible: boolean;
  errorCode?: ProductionAssetErrorCode;
  reason?: string;
} {
  if (!asset) {
    return {
      eligible: false,
      errorCode: 'PRODUCTION_ASSET_LIBRARY_ENTRY_MISSING',
      reason: 'Asset is null or undefined',
    };
  }
  if (asset.status !== 'active') {
    return {
      eligible: false,
      errorCode: 'PRODUCTION_ASSET_INACTIVE',
      reason: `Asset '${asset.id}' is not active (status: '${asset.status}')`,
    };
  }
  if (asset.blocked === true) {
    return {
      eligible: false,
      errorCode: 'PRODUCTION_ASSET_BLOCKED',
      reason: `Asset '${asset.id}' is blocked from production selection`,
    };
  }
  if (!asset.source || typeof asset.source !== 'string' || asset.source.trim().length === 0) {
    return {
      eligible: false,
      errorCode: 'PRODUCTION_ASSET_PROVENANCE_INVALID',
      reason: `Asset '${asset.id}' has missing or empty source provenance`,
    };
  }
  if (!asset.license || typeof asset.license !== 'string' || asset.license.trim().length === 0) {
    return {
      eligible: false,
      errorCode: 'PRODUCTION_ASSET_PROVENANCE_INVALID',
      reason: `Asset '${asset.id}' has missing or empty license provenance`,
    };
  }
  return { eligible: true };
}

interface GroupedLogicalRef {
  assetRef: string;
  usages: ProductionAssetUsage[];
  required: boolean;
}

/**
 * Deterministically resolves RemotionCompositionPlan logical asset references
 * to Asset library entries, optional render URLs, and mediaMap.
 */
export function resolveProductionAssets(
  input: ProductionAssetResolutionInput
): ProductionAssetResolutionReport {
  // Input validation - zero mutation
  if (!input || !input.plan) {
    const errorFinding: ProductionAssetFinding = {
      severity: 'error',
      code: 'PRODUCTION_ASSET_IDENTITY_MISMATCH',
      message: 'Missing or null RemotionCompositionPlan input',
      location: {},
    };
    return {
      version: PRODUCTION_ASSET_RESOLUTION_VERSION,
      scenarioId: '',
      projectId: '',
      valid: false,
      bindings: [],
      mediaMap: {},
      assetIdMap: {},
      summary: {
        scenarioId: '',
        projectId: '',
        totalUsages: 0,
        totalUniqueLogicalRefs: 0,
        totalResolvedUnique: 0,
        totalUnresolvedUnique: 0,
        totalRenderUrlsResolved: 0,
        errorCount: 1,
        warningCount: 0,
        status: 'error',
        valid: false,
      },
      findings: [errorFinding],
    };
  }

  const scenarioId = input.plan.scenarioId ?? '';
  const projectId = input.plan.projectId ?? '';
  const assetList: readonly Asset[] = Array.isArray(input.assets) ? input.assets : [];

  // Index asset library by id deterministically
  const assetById = new Map<string, Asset>();
  const assetLibraryFindings: ProductionAssetFinding[] = [];

  for (const asset of assetList) {
    if (!asset || typeof asset.id !== 'string' || !asset.id.trim()) {
      assetLibraryFindings.push({
        severity: 'error',
        code: 'PRODUCTION_ASSET_IDENTITY_MISMATCH',
        message: 'Asset in library has missing or invalid id',
        location: { scenarioId, projectId },
      });
      continue;
    }
    const cleanId = asset.id.trim();
    if (assetById.has(cleanId)) {
      assetLibraryFindings.push({
        severity: 'error',
        code: 'PRODUCTION_ASSET_IDENTITY_MISMATCH',
        message: `Duplicate asset id '${cleanId}' in asset library`,
        location: { scenarioId, projectId, assetId: cleanId },
      });
      continue;
    }
    assetById.set(cleanId, asset);
  }

  // Collect all asset usages grouped by unique logical assetRef
  // Order of unique groups preserves the order of first appearance in the plan.
  const groupedRefs = new Map<string, GroupedLogicalRef>();
  let totalUsagesCount = 0;

  if (Array.isArray(input.plan.scenes)) {
    for (const scene of input.plan.scenes) {
      if (!scene || !Array.isArray(scene.assetRefs)) continue;
      for (let i = 0; i < scene.assetRefs.length; i++) {
        const spec = scene.assetRefs[i];
        if (!spec) continue;

        totalUsagesCount++;
        const rawRef = spec.assetRef;
        const usage: ProductionAssetUsage = {
          sceneId: spec.sceneId || scene.sceneId || scene.sourceSceneId || '',
          cueId: spec.cueId || '',
          beatId: spec.beatId || '',
          cueKind: spec.cueKind || '',
          sourceField: spec.sourceField,
          required: Boolean(spec.required),
          order: typeof spec.order === 'number' ? spec.order : i,
        };

        let group = groupedRefs.get(rawRef);
        if (!group) {
          group = {
            assetRef: rawRef,
            usages: [],
            required: false,
          };
          groupedRefs.set(rawRef, group);
        }
        group.usages.push(usage);
        if (usage.required) {
          group.required = true;
        }
      }
    }
  }

  const bindings: ProductionAssetBinding[] = [];
  const mediaMap: Record<string, string> = {};
  const assetIdMap: Record<string, string> = {};

  // Resolve each unique logical asset reference exactly once
  for (const group of groupedRefs.values()) {
    const { assetRef, usages, required } = group;
    const firstUsage = usages[0];
    const bindingFindings: ProductionAssetFinding[] = [];

    const makeFindingLocation = (assetId?: string): ProductionAssetFindingLocation => ({
      scenarioId,
      projectId,
      sceneId: firstUsage?.sceneId,
      cueId: firstUsage?.cueId,
      beatId: firstUsage?.beatId,
      cueKind: firstUsage?.cueKind,
      assetRef,
      assetId: assetId ?? undefined,
    });

    // 1. Validate logical asset reference format
    const refValidation = validateLogicalAssetRef(assetRef);
    if (!refValidation.valid) {
      bindingFindings.push({
        severity: 'error',
        code: 'PRODUCTION_ASSET_REFERENCE_INVALID',
        message: `Logical asset reference '${assetRef}' is invalid: ${refValidation.warning}`,
        location: makeFindingLocation(),
        details: usages.length > 1 ? { usageCount: usages.length } : undefined,
      });

      bindings.push({
        assetRef,
        resolved: false,
        assetId: null,
        asset: null,
        renderUrl: null,
        resolutionSource: 'unresolved',
        required,
        usages: [...usages],
        findings: bindingFindings,
      });
      continue;
    }

    let resolvedAsset: Asset | null = null;
    let resolutionSource: ProductionAssetResolutionSource = 'unresolved';

    // Priority 1 — Explicit binding
    const hasExplicit = Boolean(
      input.explicitBindings &&
        Object.prototype.hasOwnProperty.call(input.explicitBindings, assetRef)
    );

    if (hasExplicit) {
      const explicitAssetId = input.explicitBindings![assetRef];
      if (!explicitAssetId || typeof explicitAssetId !== 'string' || !explicitAssetId.trim()) {
        bindingFindings.push({
          severity: 'error',
          code: 'PRODUCTION_ASSET_LIBRARY_ENTRY_MISSING',
          message: `Explicit binding for logical reference '${assetRef}' specifies an empty asset ID`,
          location: makeFindingLocation(),
        });
      } else {
        const cleanExplicitId = explicitAssetId.trim();
        const candidate = assetById.get(cleanExplicitId);
        if (!candidate) {
          bindingFindings.push({
            severity: 'error',
            code: 'PRODUCTION_ASSET_LIBRARY_ENTRY_MISSING',
            message: `Explicitly bound asset ID '${cleanExplicitId}' for reference '${assetRef}' not found in asset library`,
            location: makeFindingLocation(cleanExplicitId),
          });
        } else {
          const elig = isProductionAssetEligible(candidate);
          if (!elig.eligible) {
            bindingFindings.push({
              severity: 'error',
              code: elig.errorCode ?? 'PRODUCTION_ASSET_INACTIVE',
              message: `Explicitly bound asset '${cleanExplicitId}' for reference '${assetRef}' is not eligible: ${elig.reason}`,
              location: makeFindingLocation(cleanExplicitId),
            });
          } else {
            resolvedAsset = candidate;
            resolutionSource = 'explicit';
          }
        }
      }
    }

    // Priority 2 — Exact Asset ID (only if not explicitly bound)
    if (!hasExplicit && !resolvedAsset) {
      const exactCandidate = assetById.get(assetRef);
      if (exactCandidate) {
        const elig = isProductionAssetEligible(exactCandidate);
        if (elig.eligible) {
          resolvedAsset = exactCandidate;
          resolutionSource = 'exact_id';
        }
      }
    }

    // Priority 3 — Explicit alias tag (only if not explicitly bound and not resolved by exact ID)
    if (!hasExplicit && !resolvedAsset) {
      const aliasTag = formatAssetRefAliasTag(assetRef);
      const matchingAssets = assetList.filter(
        a => Array.isArray(a.tags) && a.tags.includes(aliasTag)
      );
      const eligibleMatches = matchingAssets.filter(
        a => isProductionAssetEligible(a).eligible
      );

      if (eligibleMatches.length === 1) {
        resolvedAsset = eligibleMatches[0];
        resolutionSource = 'alias_tag';
      } else if (eligibleMatches.length > 1) {
        const matchingIds = eligibleMatches.map(a => a.id).sort();
        bindingFindings.push({
          severity: 'error',
          code: 'PRODUCTION_ASSET_BINDING_AMBIGUOUS',
          message: `Logical asset reference '${assetRef}' matches multiple eligible assets by alias tag '${aliasTag}': [${matchingIds.join(', ')}]`,
          location: makeFindingLocation(),
          details: { matchingAssetIds: matchingIds },
        });
      } else if (matchingAssets.length > 0) {
        // Tag matched assets, but none were eligible
        const firstIneligible = matchingAssets[0];
        const elig = isProductionAssetEligible(firstIneligible);
        bindingFindings.push({
          severity: 'error',
          code: elig.errorCode ?? 'PRODUCTION_ASSET_INACTIVE',
          message: `Asset '${firstIneligible.id}' matching alias tag '${aliasTag}' for reference '${assetRef}' is not eligible: ${elig.reason}`,
          location: makeFindingLocation(firstIneligible.id),
        });
      } else {
        // Did an exact ID candidate exist but was ineligible?
        const exactCandidate = assetById.get(assetRef);
        if (exactCandidate) {
          const elig = isProductionAssetEligible(exactCandidate);
          bindingFindings.push({
            severity: 'error',
            code: elig.errorCode ?? 'PRODUCTION_ASSET_INACTIVE',
            message: `Exact ID match '${exactCandidate.id}' for reference '${assetRef}' is not eligible: ${elig.reason}`,
            location: makeFindingLocation(exactCandidate.id),
          });
        } else {
          // Unresolved
          bindingFindings.push({
            severity: required ? 'error' : 'warning',
            code: 'PRODUCTION_ASSET_BINDING_MISSING',
            message: `Asset reference '${assetRef}' could not be resolved in the asset library (required: ${required})`,
            location: makeFindingLocation(),
          });
        }
      }
    }

    // Render URL resolution for resolved assets
    let renderUrl: string | null = null;
    if (resolvedAsset) {
      const assetId = resolvedAsset.id;
      assetIdMap[assetRef] = assetId;

      const hasUrl = Boolean(
        input.assetUrlById &&
          Object.prototype.hasOwnProperty.call(input.assetUrlById, assetId)
      );
      const rawUrl = hasUrl ? input.assetUrlById![assetId] : undefined;

      if (typeof rawUrl === 'string' && rawUrl.trim().length > 0) {
        renderUrl = rawUrl.trim();
        mediaMap[assetRef] = renderUrl;
      } else {
        bindingFindings.push({
          severity: required ? 'error' : 'warning',
          code: 'PRODUCTION_ASSET_URL_MISSING',
          message: `No renderable URL supplied in assetUrlById for resolved asset '${assetId}' (reference '${assetRef}')`,
          location: makeFindingLocation(assetId),
        });
      }
    }

    bindings.push({
      assetRef,
      resolved: resolvedAsset !== null,
      assetId: resolvedAsset ? resolvedAsset.id : null,
      asset: resolvedAsset,
      renderUrl,
      resolutionSource,
      required,
      usages: [...usages],
      findings: bindingFindings,
    });
  }

  // Aggregate findings
  const allFindings: ProductionAssetFinding[] = [
    ...assetLibraryFindings,
    ...bindings.flatMap(b => b.findings),
  ];

  const errorCount = allFindings.filter(f => f.severity === 'error').length;
  const warningCount = allFindings.filter(f => f.severity === 'warning').length;
  const valid = errorCount === 0;
  const status: 'ok' | 'warning' | 'error' =
    errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'ok';

  const totalResolvedUnique = bindings.filter(b => b.resolved).length;
  const totalUnresolvedUnique = bindings.filter(b => !b.resolved).length;
  const totalRenderUrlsResolved = bindings.filter(b => b.renderUrl !== null).length;

  const summary: ProductionAssetResolutionSummary = {
    scenarioId,
    projectId,
    totalUsages: totalUsagesCount,
    totalUniqueLogicalRefs: bindings.length,
    totalResolvedUnique,
    totalUnresolvedUnique,
    totalRenderUrlsResolved,
    errorCount,
    warningCount,
    status,
    valid,
  };

  return {
    version: PRODUCTION_ASSET_RESOLUTION_VERSION,
    scenarioId,
    projectId,
    valid,
    bindings,
    mediaMap,
    assetIdMap,
    summary,
    findings: allFindings,
  };
}
