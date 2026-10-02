/**
 * AUDIT ITEM G — portable asset provenance in the delivered product kit.
 *
 * The product kit must NOT persist a process-local live media URL such as
 * `http://127.0.0.1:<port>/media/asset/<id>` as the durable reference for a
 * bound asset. The durable identity of a bound asset is:
 *
 *   assetId + logicalRef + target/scene usage + a data-root relative file
 *   reference + sha256/size integrity of that file.
 *
 * This suite proves, with a real asset file in an isolated data root:
 *
 *   G1  the kit records the durable reference + integrity, never a live URL;
 *   G2  no kit file contains a loopback/HTTP media URL, even though the render
 *       plan carried one as a runtime diagnostic;
 *   G3  the kit's provenance still resolves after the server is gone and the
 *       data tree has MOVED (copied to another root), which a stored
 *       `127.0.0.1:<port>` URL can never do;
 *   G4  the manifest documents the durable-reference policy.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { generateProductionScenariosFromProjectInput, type ProjectInput, type Scenario } from '@buildtrack/core';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-kit-portable-'));
  nodeFs.mkdirSync(nodePath.join(dir, 'data', 'assets', 'stock'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(dir, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(dir, 'output');
  return { dir };
});

import { ASSETS_DIR, OUTPUT_DIR } from '../apps/api/src/services/platform.js';
import {
  provenanceToCsv,
  writeProductionDeliverables,
  type WriteProductionDeliverablesInput,
} from '../apps/api/src/services/production-deliverables.js';
import type { ProductionState } from '../apps/api/src/services/production-state.js';

const ASSET_REL = 'stock/cracked-render.png';
const ASSET_BYTES = Buffer.from('PORTABLE-ASSET-BYTES-0123456789', 'utf8');
const LIVE_PORT = 4555;
const LIVE_URL = `http://127.0.0.1:${LIVE_PORT}/media/asset/asset-portable-1`;

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
    sourceReferences: [],
    outputLanguage: 'en',
    brandPreset: 'buildtrack',
    shortCount: 1,
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
  } as unknown as ProductionState;
}

/** Every text file in the kit (the preview kit has no binary files). */
function kitTextFiles(kitRoot: string): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push({ rel: path.relative(kitRoot, abs).split(path.sep).join('/'), text: fs.readFileSync(abs, 'utf8') });
    }
  };
  walk(kitRoot);
  return out;
}

describe('audit G — product-kit asset provenance is portable, not process-local', () => {
  const videoId = 'PORT_01';
  let scenario: Scenario;
  let kitRoot = '';

  afterAll(() => {
    try {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('writes the asset file and a kit that references it durably', async () => {
    scenario = generateProductionScenariosFromProjectInput(inputFor(videoId), { shortCount: 1 }).longScenario!;
    expect(scenario).toBeTruthy();

    // Real asset file on disk under the isolated data root.
    fs.writeFileSync(path.resolve(ASSETS_DIR, ASSET_REL), ASSET_BYTES);
    const expectedSha = createHash('sha256').update(ASSET_BYTES).digest('hex');

    const bindings = [
      {
        assetRef: 'source-record:ev-port-01',
        resolved: true,
        assetId: 'asset-portable-1',
        asset: {
          id: 'asset-portable-1',
          name: 'Cracked render',
          kind: 'image',
          source: 'Site photo',
          license: 'Operator owned',
          path: ASSET_REL,
          fileName: 'cracked-render.png',
          sizeBytes: ASSET_BYTES.length,
        },
        // Per-job runtime diagnostic: present in the plan, must never be persisted.
        renderUrl: LIVE_URL,
        required: true,
        usages: [{ sceneId: scenario.scenes[0].id, assetRef: 'source-record:ev-port-01' }],
      },
    ];

    const input: WriteProductionDeliverablesInput = {
      project: { meta: { input: inputFor(videoId) } } as any,
      state: stateFor(videoId),
      kind: 'preview',
      plans: [
        {
          target: 'long',
          scenario,
          plan: {
            width: 1920,
            height: 1080,
            scenes: scenario.scenes.map((s, i) => ({
              sceneId: s.id,
              captionCues: [{ startTimeSeconds: i * 4 + 0.5, endTimeSeconds: i * 4 + 3.5 }],
              audioRefs: [{ path: `${scenario.metadata.id}/${s.id}.wav` }],
            })),
          },
          mediaMap: { 'source-record:ev-port-01': `/media/asset/asset-portable-1` },
          resolution: { bindings: bindings as any },
        },
      ],
      outputs: {},
      packageRelPath: null,
      packageStatus: null,
      packageFindings: [],
      historyObservation: {
        source: 'none',
        productionEntryCount: 0,
        videoIds: [],
        personaKeyCount: 0,
        personas: {},
        styleFingerprint: null,
      },
    };

    const result = await writeProductionDeliverables(input);
    kitRoot = result.kitRoot;
    expect(result.kitRelPath).toBe(`${videoId}/production-kit`);

    // ── G1: durable row identity + integrity, no live URL field ──────────
    const row = result.provenance.find((r) => r.assetId === 'asset-portable-1');
    expect(row).toBeTruthy();
    expect(row!.logicalRef).toBe('source-record:ev-port-01');
    expect(row!.target).toBe('long');
    expect(row!.sceneIds).toEqual([scenario.scenes[0].id]);
    expect(row!.mediaRef).toBe(`assets/${ASSET_REL}`);
    expect(row!.integrity).toEqual({ algorithm: 'sha256', sha256: expectedSha, sizeBytes: ASSET_BYTES.length });
    expect(JSON.stringify(row)).not.toMatch(/127\.0\.0\.1|http:\/\//);

    const provenanceJson = JSON.parse(fs.readFileSync(path.join(kitRoot, 'asset_provenance.json'), 'utf8'));
    expect(provenanceJson[0].resolvedUrl).toBeUndefined();
    expect(provenanceJson[0].mediaRef).toBe(`assets/${ASSET_REL}`);

    const csv = provenanceToCsv(result.provenance);
    expect(csv.split('\n')[0]).toBe(
      'asset_id,name,kind,source,license,target,logical_ref,scene_ids,media_ref,integrity_sha256,size_bytes,usage',
    );
    expect(csv).toContain(`assets/${ASSET_REL}`);
    expect(csv).toContain(expectedSha);
    expect(csv).not.toMatch(/127\.0\.0\.1|http:\/\//);
  });

  it('G2 — no kit file anywhere leaks the live loopback media URL', () => {
    const files = kitTextFiles(kitRoot);
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      expect(file.text, `${file.rel} leaked a live URL`).not.toMatch(/127\.0\.0\.1|http:\/\//);
      expect(file.text, `${file.rel} leaked the live port`).not.toContain(String(LIVE_PORT));
    }
    // Sanity: the live URL really was different from anything persisted.
    const provenance = fs.readFileSync(path.join(kitRoot, 'asset_provenance.json'), 'utf8');
    expect(provenance).not.toContain(LIVE_URL);
  });

  it('G3 — the kit keeps its meaning after the server stops and the data tree moves', () => {
    // Simulate: a different machine / moved data root, no API process at all.
    const movedRoot = path.join(tmp.dir, 'moved-data');
    fs.cpSync(ASSETS_DIR, path.join(movedRoot, 'assets'), { recursive: true });
    fs.cpSync(kitRoot, path.join(movedRoot, 'output', videoId, 'production-kit'), { recursive: true });

    const movedProvenance = JSON.parse(
      fs.readFileSync(path.join(movedRoot, 'output', videoId, 'production-kit', 'asset_provenance.json'), 'utf8'),
    ) as Array<{ assetId: string; mediaRef: string; integrity: { sha256: string; sizeBytes: number } }>;
    expect(movedProvenance.length).toBeGreaterThan(0);
    for (const row of movedProvenance) {
      if (!row.mediaRef) continue;
      const movedFile = path.join(movedRoot, row.mediaRef);
      expect(fs.existsSync(movedFile), `durable ref ${row.mediaRef} must resolve after the move`).toBe(true);
      const sha = createHash('sha256').update(fs.readFileSync(movedFile)).digest('hex');
      expect(sha).toBe(row.integrity.sha256);
      expect(fs.statSync(movedFile).size).toBe(row.integrity.sizeBytes);
    }
  });

  it('G4 — the manifest documents the durable-reference policy', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(kitRoot, 'manifest.json'), 'utf8'));
    expect(manifest.assetProvenance).toEqual({
      mediaRefBase: 'data',
      integrity: 'sha256 of the referenced asset file at kit-write time',
      liveUrlPolicy:
        'per-job loopback media URLs (API host and port of the running render job) are runtime render diagnostics and are never written into this kit',
    });
    expect(manifest.files).toContain('asset_provenance.json');
    expect(manifest.files).toContain('asset_provenance.csv');
    const checksums = fs.readFileSync(path.join(kitRoot, 'checksums.sha256'), 'utf8');
    expect(checksums).toContain('asset_provenance.json');
    expect(checksums).toContain('asset_provenance.csv');
    // The kit files really live under the output root.
    expect(kitRoot.startsWith(path.resolve(OUTPUT_DIR))).toBe(true);
  });
});
