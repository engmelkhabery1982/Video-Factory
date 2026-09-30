/**
 * @vitest-environment happy-dom
 *
 * Phase 6A — Cross-Track Integration Tests
 * Core Production Asset Resolution (Track A) → Remotion Renderer Consumption (Track B)
 *
 * Proves the integrated chain:
 *   Phase 5 RemotionCompositionPlan
 *           ↓
 *   resolveProductionAssets(...) [Track A]
 *           ↓
 *   ProductionAssetResolutionReport.mediaMap
 *           ↓ direct (no translation / no adapter)
 *   VideoCompositionPlan [Track B]
 *           ↓
 *   resolveSceneMediaUrl(...)
 *           ↓
 *   PlanSceneRenderer → SceneRenderer → Background / Explanation media path
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import {
  getProgressMeetingScenario,
  compileScenarioVisualPlan,
  resolveProductionAssets,
  type Asset,
  type RemotionCompositionPlan,
  type RemotionSceneCompositionSpec,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';
import {
  VideoCompositionPlan,
  resolveSceneMediaUrl,
} from '../packages/video/src/compositions/VideoCompositionPlan.js';

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  return {
    ...actual,
    useCurrentFrame: () => 0,
    useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080, durationInFrames: 3563 }),
    Sequence: (props: { children?: React.ReactNode }) => (props.children ?? null) as React.ReactElement,
    Audio: () => null,
  };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CANONICAL_URL = 'http://127.0.0.1:3000/media/asset/asset-progress-chart-real';

function renderCompositionToHtml(props: React.ComponentProps<typeof VideoCompositionPlan>): string {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root | null = null;
  act(() => {
    root = createRoot(host);
    root.render(React.createElement(VideoCompositionPlan, props));
  });
  return host.innerHTML;
}

describe('Phase 6A — Cross-Track Integration: Core Resolver → Remotion Consumption', () => {
  let canonicalPlan: RemotionCompositionPlan;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = `tmp-test-phase6a-integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });

    // Build real canonical Phase 5 pipeline
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

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('Step 5 & 6 — Canonical Pipeline & Track A Resolution Evidence', () => {
    it('proves canonical Phase 5 invariants are strictly preserved', () => {
      expect(canonicalPlan.valid).toBe(true);
      expect(canonicalPlan.scenes.length).toBe(5);
      expect(canonicalPlan.totalActualDurationSeconds).toBe(118.74);
      expect(canonicalPlan.fps).toBe(30);
      expect(canonicalPlan.durationInFrames).toBe(3563);
      expect(canonicalPlan.summary.beatCount).toBe(12);
      expect(canonicalPlan.summary.audioRefCount).toBe(12);
      expect(canonicalPlan.summary.captionCueCount).toBe(28);
      expect(canonicalPlan.summary.assetRefCount).toBe(2);
    });

    it('resolves canonical asset with real Track A API: 2 usages → 1 unique logical ref → 1 render URL', () => {
      const realAsset: Asset = {
        id: 'asset-progress-chart-real',
        name: 'Progress Chart',
        kind: 'chart',
        fileName: 'progress-chart.png',
        path: 'assets/progress-chart.png',
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
      };

      const assetUrlById = {
        'asset-progress-chart-real': CANONICAL_URL,
      };

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [realAsset],
        assetUrlById,
      });

      // Verification of Step 6 requirements
      expect(report.valid).toBe(true);
      expect(report.summary.status).toBe('ok');
      expect(report.summary.totalUsages).toBe(2);
      expect(report.summary.totalUniqueLogicalRefs).toBe(1);
      expect(report.summary.totalResolvedUnique).toBe(1);
      expect(report.summary.totalRenderUrlsResolved).toBe(1);
      expect(report.summary.errorCount).toBe(0);
      expect(report.summary.warningCount).toBe(0);

      // Provenance preserved across both usages
      expect(report.bindings[0].usages.length).toBe(2);
      expect(report.bindings[0].usages[0].cueKind).toBe('screen_insert_title');
      expect(report.bindings[0].usages[1].cueKind).toBe('screen_insert_description');

      // Asset ID mapping and media map mapping
      expect(report.assetIdMap['asset-iva-progress-chart']).toBe('asset-progress-chart-real');
      expect(report.mediaMap['asset-iva-progress-chart']).toBe(CANONICAL_URL);
    });
  });

  describe('Step 7 & 10 — Direct Contract Flow (Track A mediaMap → Track B resolveSceneMediaUrl)', () => {
    it('feeds Track A report.mediaMap directly into Track B without translation', () => {
      const realAsset: Asset = {
        id: 'asset-progress-chart-real',
        name: 'Progress Chart',
        kind: 'chart',
        fileName: 'progress-chart.png',
        path: 'assets/progress-chart.png',
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
      };

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [realAsset],
        assetUrlById: { 'asset-progress-chart-real': CANONICAL_URL },
      });

      // Target scene: sc-02-context (which carries asset-iva-progress-chart)
      const targetScene = canonicalPlan.scenes.find((s) => s.sceneId === 'sc-02-context');
      expect(targetScene).toBeDefined();

      // Direct feed: pass report.mediaMap directly to resolveSceneMediaUrl
      const resolvedMediaUrl = resolveSceneMediaUrl(targetScene!, report.mediaMap);
      expect(resolvedMediaUrl).toBe(CANONICAL_URL);

      // Verify scenes without asset references return null
      const nonMediaScenes = canonicalPlan.scenes.filter((s) => s.sceneId !== 'sc-02-context');
      for (const scene of nonMediaScenes) {
        expect(resolveSceneMediaUrl(scene, report.mediaMap)).toBeNull();
      }
    });
  });

  describe('Step 8 — Real Component Integration Proof (DOM Evidence)', () => {
    it('renders canonical VideoCompositionPlan with Track A mediaMap without error', () => {
      const realAsset: Asset = {
        id: 'asset-progress-chart-real',
        name: 'Progress Chart',
        kind: 'chart',
        fileName: 'progress-chart.png',
        path: 'assets/progress-chart.png',
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
      };

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [realAsset],
        assetUrlById: { 'asset-progress-chart-real': CANONICAL_URL },
      });

      // Render the actual VideoCompositionPlan with the canonical plan and Track A's mediaMap
      const html = renderCompositionToHtml({
        plan: canonicalPlan,
        mediaMap: report.mediaMap,
        burnedCaptions: false,
      });

      expect(html.length).toBeGreaterThan(0);
      expect(html).toContain('BuildTrack');
    });

    it('proves the Track A resolved URL reaches real SceneRenderer Background & Explanation DOM plates', () => {
      const realAsset: Asset = {
        id: 'asset-progress-chart-real',
        name: 'Progress Chart',
        kind: 'chart',
        fileName: 'progress-chart.png',
        path: 'assets/progress-chart.png',
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
      };

      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [realAsset],
        assetUrlById: { 'asset-progress-chart-real': CANONICAL_URL },
      });

      // Construct a plan where the resolved asset reference is placed in a scene with media plates
      const mediaScene: RemotionSceneCompositionSpec = {
        ...canonicalPlan.scenes[1],
        sceneId: 'sc-02-context-media',
        rendererKey: 'explanation:site_footage_callouts',
        visualTreatment: { background: 'site_footage', accent: '#3B82F6' },
      };

      const testPlan: RemotionCompositionPlan = {
        ...canonicalPlan,
        scenes: [mediaScene, canonicalPlan.scenes[0]],
      };

      const html = renderCompositionToHtml({
        plan: testPlan,
        mediaMap: report.mediaMap,
        burnedCaptions: false,
      });

      // Proven: URL generated by Track A appears in real DOM plates (both Background and Explanation plates)
      expect(html).toContain(CANONICAL_URL);
      expect(html).toContain('background-image: url(');
      const occurrences = html.split(CANONICAL_URL).length - 1;
      expect(occurrences).toBe(2);
    });
  });

  describe('Step 9 — Unresolved Optional Integration Case', () => {
    it('unresolved optional reference emits warning in Track A and renders non-media path in Track B', () => {
      // No matching asset provided for optional ref
      const report = resolveProductionAssets({
        plan: canonicalPlan,
        assets: [],
      });

      // Track A verification: valid=true, status='warning', warningCount=1
      expect(report.valid).toBe(true);
      expect(report.summary.status).toBe('warning');
      expect(report.summary.warningCount).toBe(1);
      expect(report.summary.errorCount).toBe(0);
      expect(report.mediaMap).toEqual({});

      // Track B verification: resolveSceneMediaUrl returns null
      const targetScene = canonicalPlan.scenes.find((s) => s.sceneId === 'sc-02-context');
      expect(resolveSceneMediaUrl(targetScene!, report.mediaMap)).toBeNull();

      // Render verification: renders cleanly without URL, no error, no throws
      const html = renderCompositionToHtml({
        plan: canonicalPlan,
        mediaMap: report.mediaMap,
        burnedCaptions: false,
      });

      expect(html.length).toBeGreaterThan(0);
      expect(html).not.toContain(CANONICAL_URL);
      expect(html).not.toContain('url(http');
    });
  });

  describe('Step 13 — Compatibility Hardening Verification', () => {
    it('treats whitespace-only mediaMap URL as unresolved and returns null', () => {
      const targetScene = canonicalPlan.scenes.find((s) => s.sceneId === 'sc-02-context');
      expect(targetScene).toBeDefined();

      const whitespaceMap = {
        'asset-iva-progress-chart': '   ',
      };

      expect(resolveSceneMediaUrl(targetScene!, whitespaceMap)).toBeNull();
    });
  });
});
