/**
 * Phase 6A Track A — Core Production Asset Resolution Tests
 *
 * Validates deterministic resolution of RemotionCompositionPlan logical asset
 * references to Asset library entries, optional render URLs, and mediaMap.
 *
 * Covers:
 * - Canonical scenario-pm-01 fixture with 2 usages of asset-iva-progress-chart
 * - Deduplication of logical refs with preservation of all usage provenances
 * - Locked priority: Explicit binding > Exact ID > Alias tag
 * - Eligibility rules: status, blocked, source, license
 * - Required vs optional reference policy
 * - Ambiguity handling
 * - mediaMap key direction (logical ref -> render URL) and assetIdMap
 * - Structured findings taxonomy
 * - Immutability of inputs
 * - Strict determinism
 * - All 13 minimum negative tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import {
  getProgressMeetingScenario,
  compileScenarioVisualPlan,
  resolveProductionAssets,
  validateLogicalAssetRef,
  formatAssetRefAliasTag,
  parseAssetRefAliasTag,
  isProductionAssetEligible,
  PRODUCTION_ASSET_RESOLUTION_VERSION,
  type Asset,
  type RemotionCompositionPlan,
  type ProductionAssetResolutionInput,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && (typeof val === 'object' || typeof val === 'function') && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function makeTestAsset(overrides?: Partial<Asset>): Asset {
  return {
    id: 'asset-progress-chart-real',
    name: 'Progress Chart',
    kind: 'chart',
    fileName: 'chart.png',
    path: 'charts/chart.png',
    mimeType: 'image/png',
    sizeBytes: 12345,
    tags: ['asset-ref:asset-iva-progress-chart'],
    status: 'active',
    preferred: true,
    source: 'Operator upload',
    license: 'Operator owned',
    addedAt: '2026-09-30T00:00:00.000Z',
    usedIn: [],
    blocked: false,
    ...overrides,
  };
}

describe('Phase 6A Track A — Production Asset Resolution', () => {
  let canonicalPlan: RemotionCompositionPlan;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = `tmp-test-phase6a-assets-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });

    const scenario = getProgressMeetingScenario();
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error('compileScenarioVisualPlan failed');

    const dialogueRes = await buildDialogueProductionPlan(scenario, {
      synthesisBasePath: `${tmpRoot}/audio/dialogue`,
      canonicalBasePath: `${tmpRoot}/audio/canonical`,
    });
    if (!dialogueRes.success) throw new Error(`buildDialogueProductionPlan failed: ${dialogueRes.error}`);

    const visualProdRes = buildVisualProductionPlan({
      scenario,
      visualPlan: visualRes.plan,
      dialogueResult: dialogueRes.result,
    });
    if (!visualProdRes.success) throw new Error(`buildVisualProductionPlan failed: ${visualProdRes.error}`);

    const sceneRenderRes = buildSceneRenderPlan({
      scenario,
      visualProductionPlan: visualProdRes.plan,
    });
    if (!sceneRenderRes.success) throw new Error(`buildSceneRenderPlan failed: ${sceneRenderRes.error}`);

    const remotionRes = buildRemotionCompositionProps(sceneRenderRes.plan);
    if (!remotionRes.success) throw new Error(`buildRemotionCompositionProps failed: ${remotionRes.error}`);

    canonicalPlan = remotionRes.plan;
  });

  afterAll(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('Section 12 — Canonical Fixture Test (scenario-pm-01)', () => {
    it('proves canonical asset usage count matches approved Phase 5 count (2)', () => {
      const totalInPlan = canonicalPlan.scenes.reduce(
        (sum, s) => sum + s.assetRefs.length,
        0
      );
      expect(totalInPlan).toBe(2);
      expect(canonicalPlan.summary.assetRefCount).toBe(2);
    });

    it('resolves duplicate usages of asset-iva-progress-chart as ONE unique logical ref while preserving all usages', () => {
      const asset = makeTestAsset();
      const assetUrlById = {
        'asset-progress-chart-real': 'http://127.0.0.1:3000/media/asset/asset-progress-chart-real',
      };

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [asset],
        assetUrlById,
      });

      expect(report.version).toBe(PRODUCTION_ASSET_RESOLUTION_VERSION);
      expect(report.valid).toBe(true);
      expect(report.summary.status).toBe('ok');
      expect(report.summary.totalUsages).toBe(2);
      expect(report.summary.totalUniqueLogicalRefs).toBe(1);
      expect(report.summary.totalResolvedUnique).toBe(1);
      expect(report.summary.totalUnresolvedUnique).toBe(0);
      expect(report.summary.totalRenderUrlsResolved).toBe(1);
      expect(report.summary.errorCount).toBe(0);
      expect(report.summary.warningCount).toBe(0);

      // Unique binding
      expect(report.bindings.length).toBe(1);
      const binding = report.bindings[0];
      expect(binding.assetRef).toBe('asset-iva-progress-chart');
      expect(binding.resolved).toBe(true);
      expect(binding.assetId).toBe('asset-progress-chart-real');
      expect(binding.resolutionSource).toBe('alias_tag');
      expect(binding.renderUrl).toBe('http://127.0.0.1:3000/media/asset/asset-progress-chart-real');

      // Preserved usages
      expect(binding.usages.length).toBe(2);
      expect(binding.usages[0].sceneId).toBe('sc-02-context');
      expect(binding.usages[0].cueKind).toBe('screen_insert_title');
      expect(binding.usages[0].cueId).toContain('screen_insert_title');
      expect(binding.usages[0].required).toBe(false);

      expect(binding.usages[1].sceneId).toBe('sc-02-context');
      expect(binding.usages[1].cueKind).toBe('screen_insert_description');
      expect(binding.usages[1].cueId).toContain('screen_insert_description');
      expect(binding.usages[1].required).toBe(false);

      // mediaMap key direction: logical ref -> URL
      expect(report.mediaMap['asset-iva-progress-chart']).toBe(
        'http://127.0.0.1:3000/media/asset/asset-progress-chart-real'
      );
      // Not assetId -> URL
      expect((report.mediaMap as any)['asset-progress-chart-real']).toBeUndefined();

      // assetIdMap
      expect(report.assetIdMap['asset-iva-progress-chart']).toBe('asset-progress-chart-real');
    });

    it('resolves via Priority 1 (explicit binding)', () => {
      const assetA = makeTestAsset({
        id: 'asset-override-1',
        tags: [],
      });
      const assetB = makeTestAsset({
        id: 'asset-progress-chart-real',
        tags: ['asset-ref:asset-iva-progress-chart'],
      });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [assetA, assetB],
        explicitBindings: {
          'asset-iva-progress-chart': 'asset-override-1',
        },
        assetUrlById: {
          'asset-override-1': 'http://127.0.0.1:3000/media/asset/asset-override-1',
          'asset-progress-chart-real': 'http://127.0.0.1:3000/media/asset/asset-progress-chart-real',
        },
      });

      expect(report.valid).toBe(true);
      expect(report.bindings[0].resolutionSource).toBe('explicit');
      expect(report.bindings[0].assetId).toBe('asset-override-1');
      expect(report.mediaMap['asset-iva-progress-chart']).toBe(
        'http://127.0.0.1:3000/media/asset/asset-override-1'
      );
    });

    it('resolves via Priority 2 (exact Asset ID)', () => {
      const exactAsset = makeTestAsset({
        id: 'asset-iva-progress-chart', // exact match
        tags: [],
      });
      const aliasAsset = makeTestAsset({
        id: 'asset-different-id',
        tags: ['asset-ref:asset-iva-progress-chart'],
      });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [exactAsset, aliasAsset],
        assetUrlById: {
          'asset-iva-progress-chart': 'http://127.0.0.1:3000/media/asset/exact',
          'asset-different-id': 'http://127.0.0.1:3000/media/asset/alias',
        },
      });

      expect(report.valid).toBe(true);
      expect(report.bindings[0].resolutionSource).toBe('exact_id');
      expect(report.bindings[0].assetId).toBe('asset-iva-progress-chart');
      expect(report.mediaMap['asset-iva-progress-chart']).toBe(
        'http://127.0.0.1:3000/media/asset/exact'
      );
    });

    it('resolves via Priority 3 (explicit alias tag)', () => {
      const aliasAsset = makeTestAsset({
        id: 'asset-progress-chart-real',
        tags: ['asset-ref:asset-iva-progress-chart'],
      });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [aliasAsset],
        assetUrlById: {
          'asset-progress-chart-real': 'http://127.0.0.1:3000/media/asset/alias-url',
        },
      });

      expect(report.valid).toBe(true);
      expect(report.bindings[0].resolutionSource).toBe('alias_tag');
      expect(report.bindings[0].assetId).toBe('asset-progress-chart-real');
      expect(report.mediaMap['asset-iva-progress-chart']).toBe(
        'http://127.0.0.1:3000/media/asset/alias-url'
      );
    });
  });

  describe('Section 13 — 13 Mandatory Negative Tests', () => {
    it('1. unresolved optional ref → warning, report remains valid', () => {
      // Empty library: canonical refs are optional
      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [],
      });

      expect(report.valid).toBe(true);
      expect(report.summary.status).toBe('warning');
      expect(report.summary.warningCount).toBe(1);
      expect(report.summary.errorCount).toBe(0);
      expect(report.summary.totalUnresolvedUnique).toBe(1);
      expect(report.summary.totalResolvedUnique).toBe(0);

      const finding = report.findings.find(
        f => f.code === 'PRODUCTION_ASSET_BINDING_MISSING'
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warning');
      expect(finding?.location?.assetRef).toBe('asset-iva-progress-chart');
      expect(finding?.location?.sceneId).toBe('sc-02-context');
    });

    it('2. unresolved required ref → error', () => {
      // Create a plan with a required ref
      const planWithRequired = clone(canonicalPlan);
      planWithRequired.scenes[1].assetRefs[0].required = true;

      const report = resolveProductionAssets({
        plan: planWithRequired,
        assets: [],
      });

      expect(report.valid).toBe(false);
      expect(report.summary.status).toBe('error');
      expect(report.summary.errorCount).toBeGreaterThanOrEqual(1);

      const finding = report.findings.find(
        f => f.code === 'PRODUCTION_ASSET_BINDING_MISSING'
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
    });

    it('3. explicit binding to nonexistent asset', () => {
      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [makeTestAsset()],
        explicitBindings: {
          'asset-iva-progress-chart': 'non-existent-asset-id',
        },
      });

      expect(report.valid).toBe(false);
      expect(report.summary.status).toBe('error');

      const finding = report.findings.find(
        f => f.code === 'PRODUCTION_ASSET_LIBRARY_ENTRY_MISSING'
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.message).toContain('non-existent-asset-id');
    });

    it('4. explicit binding to archived asset', () => {
      const archivedAsset = makeTestAsset({
        id: 'asset-archived-01',
        status: 'archived',
      });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [archivedAsset],
        explicitBindings: {
          'asset-iva-progress-chart': 'asset-archived-01',
        },
      });

      expect(report.valid).toBe(false);
      expect(report.summary.status).toBe('error');

      const finding = report.findings.find(
        f => f.code === 'PRODUCTION_ASSET_INACTIVE'
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.location?.assetId).toBe('asset-archived-01');
    });

    it('5. explicit binding to blocked asset', () => {
      const blockedAsset = makeTestAsset({
        id: 'asset-blocked-01',
        blocked: true,
      });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [blockedAsset],
        explicitBindings: {
          'asset-iva-progress-chart': 'asset-blocked-01',
        },
      });

      expect(report.valid).toBe(false);
      expect(report.summary.status).toBe('error');

      const finding = report.findings.find(
        f => f.code === 'PRODUCTION_ASSET_BLOCKED'
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.location?.assetId).toBe('asset-blocked-01');
    });

    it('6. empty source', () => {
      const assetWithEmptySource = makeTestAsset({
        id: 'asset-empty-source',
        source: '   ',
      });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [assetWithEmptySource],
        explicitBindings: {
          'asset-iva-progress-chart': 'asset-empty-source',
        },
      });

      expect(report.valid).toBe(false);
      expect(report.summary.status).toBe('error');

      const finding = report.findings.find(
        f => f.code === 'PRODUCTION_ASSET_PROVENANCE_INVALID'
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.message).toContain('source');
    });

    it('7. empty license', () => {
      const assetWithEmptyLicense = makeTestAsset({
        id: 'asset-empty-license',
        license: '',
      });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [assetWithEmptyLicense],
        explicitBindings: {
          'asset-iva-progress-chart': 'asset-empty-license',
        },
      });

      expect(report.valid).toBe(false);
      expect(report.summary.status).toBe('error');

      const finding = report.findings.find(
        f => f.code === 'PRODUCTION_ASSET_PROVENANCE_INVALID'
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.message).toContain('license');
    });

    it('8. ambiguous alias tags', () => {
      const asset1 = makeTestAsset({
        id: 'asset-chart-variant-1',
        tags: ['asset-ref:asset-iva-progress-chart'],
      });
      const asset2 = makeTestAsset({
        id: 'asset-chart-variant-2',
        tags: ['asset-ref:asset-iva-progress-chart'],
      });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [asset1, asset2],
      });

      expect(report.valid).toBe(false);
      expect(report.summary.status).toBe('error');

      const finding = report.findings.find(
        f => f.code === 'PRODUCTION_ASSET_BINDING_AMBIGUOUS'
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.message).toContain('asset-chart-variant-1');
      expect(finding?.message).toContain('asset-chart-variant-2');
      expect(report.bindings[0].resolved).toBe(false);
    });

    it('9. resolved asset without render URL', () => {
      const asset = makeTestAsset();

      // Canonical refs are optional: missing URL produces warning, report remains valid
      const reportOptional = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [asset],
        // no assetUrlById supplied
      });

      expect(reportOptional.valid).toBe(true);
      expect(reportOptional.summary.status).toBe('warning');
      expect(reportOptional.bindings[0].resolved).toBe(true);
      expect(reportOptional.bindings[0].assetId).toBe('asset-progress-chart-real');
      expect(reportOptional.bindings[0].renderUrl).toBeNull();
      expect(reportOptional.mediaMap['asset-iva-progress-chart']).toBeUndefined();
      expect(reportOptional.assetIdMap['asset-iva-progress-chart']).toBe('asset-progress-chart-real');

      const finding = reportOptional.findings.find(
        f => f.code === 'PRODUCTION_ASSET_URL_MISSING'
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warning');

      // If ref is required: missing URL produces error, report invalid
      const planWithRequired = clone(canonicalPlan);
      planWithRequired.scenes[1].assetRefs[0].required = true;
      const reportRequired = resolveProductionAssets({
        plan: planWithRequired,
        assets: [asset],
      });
      expect(reportRequired.valid).toBe(false);
      expect(reportRequired.summary.status).toBe('error');
      const reqFinding = reportRequired.findings.find(
        f => f.code === 'PRODUCTION_ASSET_URL_MISSING'
      );
      expect(reqFinding?.severity).toBe('error');
    });

    it('10. malformed logical asset reference', () => {
      const planWithMalformed = clone(canonicalPlan);
      planWithMalformed.scenes[1].assetRefs[0].assetRef = '../../etc/passwd';
      planWithMalformed.scenes[1].assetRefs[1].assetRef = '../../etc/passwd';

      const report = resolveProductionAssets({
        plan: planWithMalformed,
        assets: [makeTestAsset()],
      });

      expect(report.valid).toBe(false);
      expect(report.summary.status).toBe('error');

      const finding = report.findings.find(
        f => f.code === 'PRODUCTION_ASSET_REFERENCE_INVALID'
      );
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.message).toContain('path traversal');
    });

    it('11. duplicate usages remain grouped without duplicate resolution', () => {
      const asset = makeTestAsset();
      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [asset],
        assetUrlById: {
          'asset-progress-chart-real': 'http://127.0.0.1:3000/media/chart.png',
        },
      });

      expect(report.summary.totalUsages).toBe(2);
      expect(report.summary.totalUniqueLogicalRefs).toBe(1);
      expect(report.bindings.length).toBe(1);
      expect(report.bindings[0].usages.length).toBe(2);
      expect(report.bindings[0].usages[0].cueKind).toBe('screen_insert_title');
      expect(report.bindings[0].usages[1].cueKind).toBe('screen_insert_description');
    });

    it('12. no input mutation (deeply frozen inputs)', () => {
      const planCopy = deepFreeze(clone(canonicalPlan));
      const assetCopy = deepFreeze([makeTestAsset()]);
      const explicitBindings = deepFreeze({
        'asset-iva-progress-chart': 'asset-progress-chart-real',
      });
      const assetUrlById = deepFreeze({
        'asset-progress-chart-real': 'http://127.0.0.1:3000/media/chart.png',
      });

      // Executing resolveProductionAssets against frozen objects will throw if mutation is attempted
      const report = resolveProductionAssets({
        plan: planCopy,
        assets: assetCopy,
        explicitBindings,
        assetUrlById,
      });

      expect(report.valid).toBe(true);
      expect(report.bindings[0].resolved).toBe(true);
    });

    it('13. deterministic repeat output (byte-equivalent across runs)', () => {
      const asset = makeTestAsset();
      const input: ProductionAssetResolutionInput = {
        plan: canonicalPlan,
        assets: [asset],
        assetUrlById: {
          'asset-progress-chart-real': 'http://127.0.0.1:3000/media/asset/asset-progress-chart-real',
        },
      };

      const run1 = resolveProductionAssets(input);
      const str1 = JSON.stringify(run1);

      for (let i = 0; i < 10; i++) {
        const runN = resolveProductionAssets(input);
        const strN = JSON.stringify(runN);
        expect(strN).toBe(str1);
      }
    });
  });

  describe('Priority and Fallthrough Semantics', () => {
    it('explicit binding overrides exact ID match and alias tag', () => {
      const assetExplicit = makeTestAsset({ id: 'asset-1', tags: [] });
      const assetExact = makeTestAsset({ id: 'asset-iva-progress-chart', tags: [] });
      const assetAlias = makeTestAsset({ id: 'asset-3', tags: ['asset-ref:asset-iva-progress-chart'] });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [assetExact, assetAlias, assetExplicit],
        explicitBindings: {
          'asset-iva-progress-chart': 'asset-1',
        },
        assetUrlById: {
          'asset-1': 'http://127.0.0.1:3000/1',
          'asset-iva-progress-chart': 'http://127.0.0.1:3000/2',
          'asset-3': 'http://127.0.0.1:3000/3',
        },
      });

      expect(report.valid).toBe(true);
      expect(report.bindings[0].resolutionSource).toBe('explicit');
      expect(report.bindings[0].assetId).toBe('asset-1');
      expect(report.mediaMap['asset-iva-progress-chart']).toBe('http://127.0.0.1:3000/1');
    });

    it('exact ID overrides alias tag when no explicit binding exists', () => {
      const assetExact = makeTestAsset({ id: 'asset-iva-progress-chart', tags: [] });
      const assetAlias = makeTestAsset({ id: 'asset-3', tags: ['asset-ref:asset-iva-progress-chart'] });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [assetAlias, assetExact],
        assetUrlById: {
          'asset-iva-progress-chart': 'http://127.0.0.1:3000/exact',
          'asset-3': 'http://127.0.0.1:3000/alias',
        },
      });

      expect(report.valid).toBe(true);
      expect(report.bindings[0].resolutionSource).toBe('exact_id');
      expect(report.bindings[0].assetId).toBe('asset-iva-progress-chart');
      expect(report.mediaMap['asset-iva-progress-chart']).toBe('http://127.0.0.1:3000/exact');
    });

    it('explicit binding removes ambiguity when multiple alias tags match', () => {
      const asset1 = makeTestAsset({ id: 'asset-a', tags: ['asset-ref:asset-iva-progress-chart'] });
      const asset2 = makeTestAsset({ id: 'asset-b', tags: ['asset-ref:asset-iva-progress-chart'] });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [asset1, asset2],
        explicitBindings: {
          'asset-iva-progress-chart': 'asset-b',
        },
        assetUrlById: {
          'asset-b': 'http://127.0.0.1:3000/b',
        },
      });

      expect(report.valid).toBe(true);
      expect(report.bindings[0].resolutionSource).toBe('explicit');
      expect(report.bindings[0].assetId).toBe('asset-b');
      expect(report.summary.errorCount).toBe(0);
    });

    it('does NOT silently fall through from an invalid explicit binding to an alias tag', () => {
      const archivedAsset = makeTestAsset({ id: 'asset-archived', status: 'archived' });
      const validAsset = makeTestAsset({
        id: 'asset-valid',
        tags: ['asset-ref:asset-iva-progress-chart'],
      });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [archivedAsset, validAsset],
        explicitBindings: {
          'asset-iva-progress-chart': 'asset-archived',
        },
      });

      expect(report.valid).toBe(false);
      expect(report.bindings[0].resolved).toBe(false);
      expect(report.findings.some(f => f.code === 'PRODUCTION_ASSET_INACTIVE')).toBe(true);
    });

    it('archived asset with alias tag does not trigger ambiguity if only one active asset matches', () => {
      const archived = makeTestAsset({
        id: 'asset-old',
        status: 'archived',
        tags: ['asset-ref:asset-iva-progress-chart'],
      });
      const active = makeTestAsset({
        id: 'asset-current',
        status: 'active',
        tags: ['asset-ref:asset-iva-progress-chart'],
      });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [archived, active],
        assetUrlById: {
          'asset-current': 'http://127.0.0.1:3000/current',
        },
      });

      expect(report.valid).toBe(true);
      expect(report.bindings[0].resolved).toBe(true);
      expect(report.bindings[0].assetId).toBe('asset-current');
      expect(report.bindings[0].resolutionSource).toBe('alias_tag');
    });
  });

  describe('Edge Cases and Invariants', () => {
    it('handles empty plan with zero asset references cleanly', () => {
      const emptyPlan = clone(canonicalPlan);
      for (const scene of emptyPlan.scenes) {
        scene.assetRefs = [];
      }

      const report = resolveProductionAssets({
        plan: emptyPlan,
        assets: [makeTestAsset()],
      });

      expect(report.valid).toBe(true);
      expect(report.summary.status).toBe('ok');
      expect(report.summary.totalUsages).toBe(0);
      expect(report.summary.totalUniqueLogicalRefs).toBe(0);
      expect(report.summary.totalResolvedUnique).toBe(0);
      expect(report.summary.totalUnresolvedUnique).toBe(0);
      expect(report.bindings).toEqual([]);
      expect(report.mediaMap).toEqual({});
      expect(report.assetIdMap).toEqual({});
      expect(report.findings).toEqual([]);
    });

    it('rejects duplicate asset IDs in the asset library', () => {
      const assetA = makeTestAsset({ id: 'duplicate-id' });
      const assetB = makeTestAsset({ id: 'duplicate-id' });

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [assetA, assetB],
      });

      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.code === 'PRODUCTION_ASSET_IDENTITY_MISMATCH')).toBe(true);
    });

    it('safely handles missing or null plan input', () => {
      const report = resolveProductionAssets(null as any);
      expect(report.valid).toBe(false);
      expect(report.summary.errorCount).toBe(1);
      expect(report.findings[0].code).toBe('PRODUCTION_ASSET_IDENTITY_MISMATCH');
    });

    it('helper functions validateLogicalAssetRef, formatAssetRefAliasTag, parseAssetRefAliasTag work', () => {
      expect(validateLogicalAssetRef('asset-1').valid).toBe(true);
      expect(validateLogicalAssetRef('').valid).toBe(false);
      expect(validateLogicalAssetRef('   ').valid).toBe(false);
      expect(validateLogicalAssetRef('/absolute/path').valid).toBe(false);
      expect(validateLogicalAssetRef('C:\\path').valid).toBe(false);
      expect(validateLogicalAssetRef('../traversal').valid).toBe(false);

      expect(formatAssetRefAliasTag('chart-1')).toBe('asset-ref:chart-1');
      expect(parseAssetRefAliasTag('asset-ref:chart-1')).toBe('chart-1');
      expect(parseAssetRefAliasTag('unrelated-tag')).toBeNull();
    });

    it('isProductionAssetEligible validates all 4 criteria', () => {
      const valid = makeTestAsset();
      expect(isProductionAssetEligible(valid).eligible).toBe(true);

      const inactive = makeTestAsset({ status: 'archived' });
      expect(isProductionAssetEligible(inactive).eligible).toBe(false);
      expect(isProductionAssetEligible(inactive).errorCode).toBe('PRODUCTION_ASSET_INACTIVE');

      const blocked = makeTestAsset({ blocked: true });
      expect(isProductionAssetEligible(blocked).eligible).toBe(false);
      expect(isProductionAssetEligible(blocked).errorCode).toBe('PRODUCTION_ASSET_BLOCKED');

      const emptySource = makeTestAsset({ source: '' });
      expect(isProductionAssetEligible(emptySource).eligible).toBe(false);
      expect(isProductionAssetEligible(emptySource).errorCode).toBe('PRODUCTION_ASSET_PROVENANCE_INVALID');

      const emptyLicense = makeTestAsset({ license: '   ' });
      expect(isProductionAssetEligible(emptyLicense).eligible).toBe(false);
      expect(isProductionAssetEligible(emptyLicense).errorCode).toBe('PRODUCTION_ASSET_PROVENANCE_INVALID');
    });
  });
});
