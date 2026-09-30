/**
 * BuildTrack Video Factory - Phase 6A Core Production Asset Contract
 *
 * Deterministic resolution contract that maps RemotionCompositionPlan logical
 * asset references to Asset library entries, optional render URLs, and the
 * renderer-facing mediaMap.
 *
 * Version: 1.0.0
 * Architecture: Renderer-agnostic, zero filesystem I/O, zero network calls.
 */

import type { Asset } from '../types.js';
import type {
  RemotionCompositionPlan,
  RemotionAssetCompositionSpec,
} from './remotion-composition-types.js';

export const PRODUCTION_ASSET_RESOLUTION_VERSION = '1.0.0' as const;

/** Alias tag prefix used for exact logical asset reference matching */
export const PRODUCTION_ASSET_ALIAS_PREFIX = 'asset-ref:' as const;

/** Structured error taxonomy for production asset resolution */
export type ProductionAssetErrorCode =
  | 'PRODUCTION_ASSET_REFERENCE_INVALID'
  | 'PRODUCTION_ASSET_BINDING_MISSING'
  | 'PRODUCTION_ASSET_BINDING_AMBIGUOUS'
  | 'PRODUCTION_ASSET_LIBRARY_ENTRY_MISSING'
  | 'PRODUCTION_ASSET_INACTIVE'
  | 'PRODUCTION_ASSET_BLOCKED'
  | 'PRODUCTION_ASSET_PROVENANCE_INVALID'
  | 'PRODUCTION_ASSET_URL_MISSING'
  | 'PRODUCTION_ASSET_IDENTITY_MISMATCH';

/** Location information for a production asset finding */
export interface ProductionAssetFindingLocation {
  scenarioId?: string;
  projectId?: string;
  sceneId?: string;
  cueId?: string;
  beatId?: string;
  cueKind?: string;
  assetRef?: string;
  assetId?: string;
}

/** Structured finding reported during production asset resolution */
export interface ProductionAssetFinding {
  severity: 'error' | 'warning';
  code: ProductionAssetErrorCode;
  message: string;
  location?: ProductionAssetFindingLocation;
  details?: Record<string, unknown>;
}

/** Provenance of a single asset usage in the composition plan */
export interface ProductionAssetUsage {
  sceneId: string;
  cueId: string;
  beatId: string;
  cueKind: string;
  sourceField?: string;
  required: boolean;
  order: number;
}

/** Resolution mechanism that resolved the logical asset reference */
export type ProductionAssetResolutionSource =
  | 'explicit'
  | 'exact_id'
  | 'alias_tag'
  | 'unresolved';

/** Binding representing the resolution of a unique logical asset reference */
export interface ProductionAssetBinding {
  /** Unique logical asset reference from the composition plan */
  assetRef: string;
  /** Whether the reference was successfully resolved to an eligible asset */
  resolved: boolean;
  /** Resolved asset library ID (null if unresolved) */
  assetId: string | null;
  /** Resolved asset library entry (null if unresolved) */
  asset: Asset | null;
  /** Renderable URL/path for the asset (null if unresolved or not supplied) */
  renderUrl: string | null;
  /** Which deterministic rule resolved this reference */
  resolutionSource: ProductionAssetResolutionSource;
  /** True if any usage of this logical reference was required */
  required: boolean;
  /** All usages of this logical reference across the composition plan */
  usages: ProductionAssetUsage[];
  /** Findings associated specifically with this asset reference */
  findings: ProductionAssetFinding[];
}

/** High-level summary of the asset resolution run */
export interface ProductionAssetResolutionSummary {
  scenarioId: string;
  projectId: string;
  /** Total asset usages encountered in the composition plan */
  totalUsages: number;
  /** Total distinct logical asset references encountered */
  totalUniqueLogicalRefs: number;
  /** Total unique references successfully resolved to an eligible asset */
  totalResolvedUnique: number;
  /** Total unique references that failed resolution */
  totalUnresolvedUnique: number;
  /** Total unique references that have a renderable URL mapped */
  totalRenderUrlsResolved: number;
  /** Number of error-severity findings */
  errorCount: number;
  /** Number of warning-severity findings */
  warningCount: number;
  /** Overall status */
  status: 'ok' | 'warning' | 'error';
  /** True if errorCount === 0 */
  valid: boolean;
}

/** Complete output report of production asset resolution */
export interface ProductionAssetResolutionReport {
  version: typeof PRODUCTION_ASSET_RESOLUTION_VERSION;
  scenarioId: string;
  projectId: string;
  /** True if resolution completed without error-level findings */
  valid: boolean;
  /** Resolved bindings ordered by first appearance in the plan */
  bindings: ProductionAssetBinding[];
  /** Renderer-facing media map: logicalAssetRef -> renderableUrl */
  mediaMap: Record<string, string>;
  /** Identifier map: logicalAssetRef -> assetLibraryId */
  assetIdMap: Record<string, string>;
  /** Summary counts and metrics */
  summary: ProductionAssetResolutionSummary;
  /** All structured findings from the resolution run */
  findings: ProductionAssetFinding[];
}

/** Input passed to resolveProductionAssets */
export interface ProductionAssetResolutionInput {
  /** Approved Remotion composition plan */
  plan: RemotionCompositionPlan;
  /** Existing asset library entries */
  assets: readonly Asset[] | Asset[];
  /** Optional explicit binding map: logicalAssetRef -> assetLibraryId */
  explicitBindings?: Record<string, string>;
  /** Optional render URL map: assetLibraryId -> renderableUrlOrPath */
  assetUrlById?: Record<string, string>;
}

/** Error thrown when asset resolution fails hard in strict mode */
export class ProductionAssetResolutionError extends Error {
  public readonly code: ProductionAssetErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly findings?: ProductionAssetFinding[];

  constructor(
    code: ProductionAssetErrorCode,
    message: string,
    details?: Record<string, unknown>,
    findings?: ProductionAssetFinding[]
  ) {
    super(message);
    this.name = 'ProductionAssetResolutionError';
    this.code = code;
    this.details = details;
    this.findings = findings;
  }
}
