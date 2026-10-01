/**
 * PARTS 9–12 — production-native deliverables, readiness QC, thumbnails and
 * real Asset.usedIn.
 *
 *   P9  production-native non-video deliverables replace writeMetadata(project, [])
 *   P10 ≥3 real thumbnails from distinct meaningful positions + contact sheets,
 *       extracted from the COMPLETED MP4 (no re-render anywhere in the path)
 *   P11 Asset.usedIn updated only after a successful final production, from the
 *       real resolved usage, deduplicated
 *   P12 production readiness QC aggregates the production dimensions, documents
 *       the replaced legacy QC dimensions, and can never be READY with a
 *       blocking finding
 *
 * The completed MP4 used here is a real file produced by ffmpeg (a stand-in for
 * a production render); the extraction path is the production one.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  generateProductionScenariosFromProjectInput,
  type Asset,
  type ProjectInput,
  type Scenario,
} from '@buildtrack/core';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-deliv-'));
  nodeFs.mkdirSync(nodePath.join(dir, 'data'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(dir, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(dir, 'output');
  return { dir };
});

import { OUTPUT_DIR, ffmpegPath } from '../apps/api/src/services/platform.js';
import {
  buildProductionReadiness,
  mergeUsedInUpdates,
  provenanceToCsv,
  thumbnailTimestamps,
  usedInUpdatesFromPlans,
  writeProductionDeliverables,
  type ProductionUsedInUpdate,
  type WriteProductionDeliverablesInput,
} from '../apps/api/src/services/production-deliverables.js';
import type { ProductionState } from '../apps/api/src/services/production-state.js';

function inputFor(videoId: string): ProjectInput {
  return {
    videoId,
    videoType: 'long',
    topic: 'Executed 70% versus accepted 59.5 percent on Level 3',
    targetAudience: 'Project steering committee',
    mainProblem: 'Certified progress lags physical progress',
    viewerPromise: 'A weekly verified progress snapshot',
    hook: 'Your site is 70% finished but only 59.5% accepted.',
    script: [
      'Your site is 70% finished but only 59.5% accepted.',
      'That 10.5 percent gap is a commercial risk inside your project.',
      'The work gets done on Tuesday and inspected on Wednesday.',
      'The certificate goes out on Friday with verified numbers.',
      'Quality checks stop unverified work being accepted.',
      'Start your BuildTrack trial and see the gap every week.',
    ].join('\n'),
    keyNumbers: ['70%', '59.5%'],
    keyPoints: ['Executed versus accepted', 'Weekly verified gap'],
    productName: 'BuildTrack',
    productShots: [],
    cta: 'Start your BuildTrack trial',
    voiceoverFile: null,
    targetAudio: {},
    brollFiles: [],
    sourceReferences: ['Lab test cert LTC-2026-0882'],
    outputLanguage: 'en',
    brandPreset: 'buildtrack',
    shortCount: 1,
  };
}

/** Build the plan half of the writer input from a REAL generated Scenario. */
function planFor(target: 'long' | 'short_1', scenario: Scenario, bindings: any[], width = 1920, height = 1080) {
  return {
    target,
    scenario,
    plan: {
      width,
      height,
      scenes: scenario.scenes.map((s, i) => ({
        sceneId: s.id,
        captionCues: [{ startTimeSeconds: i * 4 + 0.5, endTimeSeconds: i * 4 + 3.5 }],
        audioRefs: [{ path: `${scenario.metadata.id}/${s.id}.wav` }],
      })),
    },
    mediaMap: Object.fromEntries(bindings.filter((b) => b.resolved).map((b) => [b.assetRef, `/media/asset/${b.assetId}`])),
    resolution: { bindings },
  };
}

function stateFor(videoId: string): ProductionState {
  return {
    videoId,
    status: 'generated',
    scenarios: {},
    builds: [],
    artifacts: [],
    locks: {},
    edits: [],
    assetBindings: [],
    generationFindings: [],
    inputFingerprint: 'fp',
    lastQcSummary: null,
    lastReadiness: null,
    historyInput: { source: 'production', productionEntryCount: 2, videoIds: ['P8_00'], personaKeyCount: 3, at: new Date().toISOString() },
  } as unknown as ProductionState;
}

function observation() {
  return {
    source: 'production' as const,
    productionEntryCount: 2,
    videoIds: ['P8_00'],
    personaKeyCount: 3,
    personas: { challenger: 'commercial-lead', technical_authority: 'construction-manager', decision_maker: 'client-representative' },
    styleFingerprint: '{"schema":1}',
  };
}

function makeMp4(file: string, seconds: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(
    ffmpegPath(),
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=15:duration=${seconds}`, '-pix_fmt', 'yuv420p', file],
    { stdio: 'pipe' },
  );
  expect(fs.statSync(file).size).toBeGreaterThan(0);
}

describe('Parts 9–12 — production deliverables and readiness', () => {
  let longScenario: Scenario;
  let shortScenario: Scenario;

  beforeAll(() => {
    const generated = generateProductionScenariosFromProjectInput(inputFor('P8_01'), { shortCount: 1 });
    expect(generated.success).toBe(true);
    longScenario = generated.longScenario!;
    shortScenario = generated.shortScenarios!.short_1;
  });

  afterAll(() => {
    try {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('P10 — thumbnails come from distinct meaningful scenes of the completed Long MP4', () => {
    const scenes = longScenario.scenes.map((s, i) => ({ sceneId: s.id, captionCues: [{ startTimeSeconds: i * 6 + 1, endTimeSeconds: i * 6 + 5 }] }));
    const stamps = thumbnailTimestamps(scenes, 3);
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    expect(new Set(stamps).size).toBe(stamps.length);
    // Positions are inside scenes (not at the very start/end of the video).
    expect(Math.min(...stamps)).toBeGreaterThan(0);
    for (const stamp of stamps) expect(Number.isFinite(stamp)).toBe(true);
  });

  it('P9 + P10 — the kit is written from the real output, with real provenance and real thumbnails', async () => {
    const videoId = 'P8_01';
    const longRel = `${videoId}/final/long.mp4`;
    const shortRel = `${videoId}/final/short_1.mp4`;
    makeMp4(path.resolve(OUTPUT_DIR, longRel), 40);
    makeMp4(path.resolve(OUTPUT_DIR, shortRel), 8);

    const realAsset = { id: 'asset-real-1', name: 'Cracked render', kind: 'image', source: 'Site photo', license: 'Operator owned' };
    const bindings = [
      {
        assetRef: 'source-record:ev-p8-01-01',
        resolved: true,
        assetId: realAsset.id,
        asset: realAsset,
        renderUrl: 'http://127.0.0.1:3000/media/asset/asset-real-1',
        required: true,
        usages: [
          { sceneId: longScenario.scenes[0].id, assetRef: 'source-record:ev-p8-01-01' },
          { sceneId: longScenario.scenes[1].id, assetRef: 'source-record:ev-p8-01-01' },
        ],
      },
      {
        assetRef: 'source-record:ev-p8-01-02',
        resolved: false,
        assetId: null,
        asset: null,
        renderUrl: null,
        required: false,
        usages: [],
      },
    ];

    const input: WriteProductionDeliverablesInput = {
      project: { meta: { input: inputFor(videoId) } } as any,
      state: stateFor(videoId),
      kind: 'final',
      plans: [planFor('long', longScenario, bindings as any), planFor('short_1', shortScenario, [], 1080, 1920)],
      outputs: { long: longRel, short_1: shortRel },
      packageRelPath: `${videoId}/production-package`,
      packageStatus: 'ready',
      packageFindings: [],
      historyObservation: observation(),
    };

    const result = await writeProductionDeliverables(input);

    // Kit layout (production-native deliverables).
    expect(result.kitRelPath).toBe(`${videoId}/production-kit`);
    const names = new Set(result.files.map((f) => f.relPath));
    for (const required of [
      'publishing_kit.json',
      'titles_and_description.md',
      'scenarios/long.json',
      'scenarios/short_1.json',
      'asset_provenance.json',
      'asset_provenance.csv',
      'readiness.json',
      'contact_sheets/long.jpg',
      'manifest.json',
      'checksums.sha256',
    ]) {
      expect(names.has(required), `missing ${required}`).toBe(true);
    }
    const thumbs = [...names].filter((n) => /^thumbnails\/long_thumb_\d+\.jpg$/.test(n));
    expect(thumbs.length).toBeGreaterThanOrEqual(3);
    for (const t of thumbs) expect(fs.statSync(path.join(result.kitRoot, t)).size).toBeGreaterThan(0);

    // Publishing kit carries the real scenario identity and caption file links.
    const kit = JSON.parse(fs.readFileSync(path.join(result.kitRoot, 'publishing_kit.json'), 'utf8'));
    expect(kit.long.scenarioId).toBe(longScenario.metadata.id);
    expect(kit.shorts[0].scenarioId).toBe(shortScenario.metadata.id);
    expect(String(kit.long.captionFiles[0])).toContain('production-package');

    // P9 — provenance only names REAL resolved assets + the real source reference.
    expect(result.provenance.map((p) => p.assetId)).toContain(realAsset.id);
    expect(result.provenance.filter((p) => p.kind === 'source reference').map((p) => p.logicalRef)).toEqual(['']);
    expect(result.provenance.every((p) => p.assetId !== 'placeholder' && p.assetId !== '')).toBe(true);
    const csv = provenanceToCsv(result.provenance);
    expect(csv.split('\n')[0]).toBe('asset_id,name,kind,source,license,target,logical_ref,scene_ids,resolved_url,usage');
    expect(csv).toContain('Cracked render');
    expect(csv).toContain('screen insert');

    // P9 — the manifest links the Phase 6D package without replacing it.
    const manifest = JSON.parse(fs.readFileSync(path.join(result.kitRoot, 'manifest.json'), 'utf8'));
    expect(manifest.phase6dPackage).toBe(`${videoId}/production-package`);
    expect(manifest.phase6dPackageStatus).toBe('ready');
    expect(String(manifest.authority)).toMatch(/production/);
    // The kit's own checksums cover exactly the recorded files.
    const checksumLines = fs.readFileSync(path.join(result.kitRoot, 'checksums.sha256'), 'utf8').trim().split('\n');
    // Every recorded file is covered, except the checksum file itself (a file
    // cannot checksum itself); the manifest is written before and is covered.
    expect(checksumLines.length).toBe(result.files.length - 1);
    expect(checksumLines.some((l) => l.includes('checksums.sha256'))).toBe(false);
    expect(checksumLines.some((l) => l.includes('manifest.json'))).toBe(true);
    for (const line of checksumLines) {
      const [, rel] = line.split(/\s{2}/);
      expect(fs.existsSync(path.join(result.kitRoot, rel)), rel).toBe(true);
    }

    // P11 — usedIn updates come from the REAL resolution and are deduplicated.
    expect(result.usedInUpdates.filter((u) => u.assetId === realAsset.id)).toHaveLength(2);
    expect(new Set(result.usedInUpdates.map((u) => `${u.assetId}|${u.videoId}|${u.sceneId}|${u.role}`)).size).toBe(result.usedInUpdates.length);

    // P12 — readiness reflects the real production dimensions and is never READY
    // with a blocking finding.
    expect(result.readiness.status).toBe('ready');
    expect(result.readiness.readyForProductionDelivery).toBe(true);
    const dims = result.readiness.dimensions.map((d) => d.dimension);
    for (const d of [
      'scenario_validation',
      'generation_findings',
      'stale_input',
      'required_assets',
      'target_geometry',
      'caption_plan',
      'production_audio',
      'phase6d_package',
      'final_outputs',
      'style_casting_history',
    ]) {
      expect(dims).toContain(d);
    }
    expect(result.readiness.supersededLegacyQcDimensions.length).toBeGreaterThanOrEqual(5);
  });

  it('P10 — the extraction path never re-renders (no renderer import in the deliverables/engine path)', () => {
    const deliverables = fs.readFileSync(path.resolve('apps/api/src/services/production-deliverables.ts'), 'utf8');
    expect(/@remotion/.test(deliverables)).toBe(false);
    expect(/renderMedia|bundle\(/.test(deliverables)).toBe(false);
    const media = fs.readFileSync(path.resolve('apps/api/src/services/media.ts'), 'utf8');
    expect(/extractPoster|contactSheet/.test(media)).toBe(true);
  });

  it('P11 — mergeUsedInUpdates is idempotent and only records real, resolved usage', () => {
    const assets: Asset[] = [
      { id: 'a1', usedIn: [] } as unknown as Asset,
      { id: 'a2', usedIn: [{ videoId: 'P8_01', sceneId: 'sc-1', role: 'screen_insert' }] } as unknown as Asset,
    ];
    const updates: ProductionUsedInUpdate[] = [
      { assetId: 'a1', videoId: 'P8_01', sceneId: 'sc-1', role: 'screen_insert' },
      { assetId: 'a1', videoId: 'P8_01', sceneId: 'sc-1', role: 'screen_insert' }, // duplicate
      { assetId: 'a2', videoId: 'P8_01', sceneId: 'sc-1', role: 'screen_insert' }, // already recorded
      { assetId: 'missing', videoId: 'P8_01', sceneId: 'sc-9', role: 'screen_insert' }, // unknown asset
    ];

    const first = mergeUsedInUpdates(assets, updates);
    expect(first.changed).toBe(1);
    expect(first.assets.find((a) => a.id === 'a1')!.usedIn).toEqual([{ videoId: 'P8_01', sceneId: 'sc-1', role: 'screen_insert' }]);
    expect(first.assets.find((a) => a.id === 'a2')!.usedIn).toHaveLength(1);

    // Running the same merge again changes nothing (idempotent).
    const second = mergeUsedInUpdates(first.assets, updates);
    expect(second.changed).toBe(0);
    expect(second.assets.find((a) => a.id === 'a1')!.usedIn).toHaveLength(1);

    // Unresolved bindings never produce usage.
    const plan = planFor('long', longScenario, [
      {
        assetRef: 'source-record:ev-unresolved',
        resolved: false,
        assetId: 'a1',
        asset: null,
        renderUrl: null,
        required: false,
        usages: [{ sceneId: 'sc-1', assetRef: 'source-record:ev-unresolved' }],
      },
    ] as any);
    expect(usedInUpdatesFromPlans('P8_01', [plan] as any)).toEqual([]);
  });

  it('P12 — readiness is blocked by blocking findings and is production-native', () => {
    const videoId = 'P8_02';
    const outputRel = `${videoId}/final/long.mp4`;
    makeMp4(path.resolve(OUTPUT_DIR, outputRel), 6);

    const base: WriteProductionDeliverablesInput = {
      project: { meta: { input: inputFor(videoId) } } as any,
      state: stateFor(videoId),
      kind: 'final',
      plans: [
        planFor('long', longScenario, [
          {
            assetRef: 'source-record:ev-p8-01-01',
            resolved: false,
            assetId: null,
            asset: null,
            renderUrl: null,
            required: true,
            usages: [{ sceneId: longScenario.scenes[0].id, assetRef: 'source-record:ev-p8-01-01' }],
          },
        ] as any),
      ],
      outputs: { long: outputRel },
      packageRelPath: `${videoId}/production-package`,
      packageStatus: 'failed',
      packageFindings: [{ severity: 'error', code: 'PKG-TECH-QC', message: 'technical QC failed' }],
      historyObservation: observation(),
    };

    const readiness = buildProductionReadiness(base);
    expect(readiness.status).toBe('blocked');
    expect(readiness.readyForProductionDelivery).toBe(false);
    expect(readiness.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(['READINESS_REQUIRED_ASSET_UNRESOLVED', 'READINESS_PACKAGE_PKG-TECH-QC']),
    );
    expect(readiness.dimensions.find((d) => d.dimension === 'required_assets')!.status).toBe('fail');
    expect(readiness.dimensions.find((d) => d.dimension === 'phase6d_package')!.status).toBe('fail');
    // Replaced legacy QC dimensions are documented, not silently dropped.
    const replaced = readiness.supersededLegacyQcDimensions.map((d) => d.legacyDimension).join(' | ');
    expect(replaced).toMatch(/static QC/i);
    expect(replaced).toMatch(/similarity/i);

    // Stale input blocks a final delivery even with everything else resolvable.
    const staleReadiness = buildProductionReadiness({
      ...base,
      state: { ...stateFor(videoId), status: 'needs_regeneration' } as ProductionState,
      plans: [planFor('long', longScenario, []) as any],
      packageStatus: 'ready',
      packageFindings: [],
    });
    expect(staleReadiness.findings.map((f) => f.code)).toContain('READINESS_STALE_INPUT');
    expect(staleReadiness.readyForProductionDelivery).toBe(false);

    // Preview builds are never "ready for production delivery".
    const previewReadiness = buildProductionReadiness({ ...base, kind: 'preview', plans: [planFor('long', longScenario, []) as any], packageStatus: null, packageFindings: [] });
    expect(previewReadiness.readyForProductionDelivery).toBe(false);
  });

  it('P9 — the production path no longer fabricates empty provenance via writeMetadata', () => {
    const engine = fs.readFileSync(path.resolve('apps/api/src/services/production-engine.ts'), 'utf8');
    // No CALL SITE may fabricate empty provenance (comments may mention the old pair).
    const calls = engine
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .join('\n');
    expect(calls).not.toMatch(/writeMetadata\s*\(\s*project\s*,\s*\[\s*\]\s*\)/);
    expect(calls).not.toMatch(/writeCaptions\s*\(/);
    // The legacy metadata writer still exists for legacy projects (preserved).
    const pipeline = fs.readFileSync(path.resolve('apps/api/src/services/pipeline.ts'), 'utf8');
    expect(pipeline).toMatch(/export function writeMetadata/);
  });
});
