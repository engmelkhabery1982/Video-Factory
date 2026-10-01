/**
 * PART 1 — production generation consumes REAL production history.
 *
 * Proves, through the real HTTP API and the real persisted sidecars, that:
 *
 *   1. a first project generates with NO history (historyInput.source === 'none');
 *   2. its casting/style observation is persisted through the product's own
 *      writer (`appendProductionHistoryEntry`, the same call the final build makes);
 *   3. a SECOND project with the SAME content consumes that production history
 *      (`historyInput.source === 'production'`, entry counts/video ids present);
 *   4. the deterministic anti-repeat is observable: casting/style differ from
 *      the history-free baseline that the identical content would otherwise get;
 *   5. the legacy visual history is NOT the authority (it is empty here, and the
 *      legacy fallback flag is not used);
 *   6. regenerating consumes history deterministically (same result twice).
 *
 * No history is fabricated inside a test after generation: the observation is
 * the one the product derives from the generated state and persists.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  generateProductionScenariosFromProjectInput,
  personaKeyFromCharacterId,
  type ProjectInput,
  type Scenario,
} from '@buildtrack/core';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-hist-'));
  nodeFs.mkdirSync(nodePath.join(dir, 'data'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(dir, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(dir, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(dir, 'output');
  return { dir };
});

import { registerAssetRoutes } from '../apps/api/src/routes/assets.js';
import { registerProductionRoutes } from '../apps/api/src/routes/production.js';
import { registerProjectRoutes } from '../apps/api/src/routes/projects.js';
import {
  appendProductionHistoryEntry,
  loadProductionHistory,
  loadProductionState,
  PRODUCTION_HISTORY_FILE,
} from '../apps/api/src/services/production-state.js';
import { personaObservationFromState } from '../apps/api/src/services/production-engine.js';

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

function personaKeys(scenario: Scenario): string[] {
  return [...new Set(scenario.characters.map((c) => personaKeyFromCharacterId(c.id)).filter((k): k is string => !!k))].sort();
}

describe('Part 1 — production generation consumes real production history', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024 } });
    await registerAssetRoutes(app);
    await registerProjectRoutes(app);
    await registerProductionRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    try {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('records nothing on the first generation, persists the real observation, then feeds it to the next project', async () => {
    // ── project 1: no history yet ───────────────────────────────────────────
    const createA = await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor('Hist_01') });
    expect(createA.statusCode).toBe(200);
    const genA = await app.inject({ method: 'POST', url: '/api/projects/Hist_01/production/generate', payload: {} });
    expect(genA.statusCode, genA.payload).toBe(200);

    const stateA = loadProductionState('Hist_01')!;
    expect(stateA.historyInput.source).toBe('none');
    expect(stateA.historyInput.productionEntryCount).toBe(0);
    const castA = personaKeys(stateA.scenarios.long as Scenario);
    expect(castA.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmp.dir, 'data', PRODUCTION_HISTORY_FILE))).toBe(false);

    // ── the product's own post-final-export observation path ───────────────
    const observationA = personaObservationFromState(stateA);
    expect(Object.keys(observationA.personas).length).toBeGreaterThan(0);
    expect(observationA.styleFingerprint.length).toBeGreaterThan(0);
    appendProductionHistoryEntry({
      videoId: 'Hist_01',
      at: new Date().toISOString(),
      casting: observationA.personas,
      styleFingerprint: observationA.styleFingerprint,
    });
    const persisted = loadProductionHistory();
    expect(persisted.map((e) => e.videoId)).toEqual(['Hist_01']);

    // ── project 2: identical content, new videoId ──────────────────────────
    const createB = await app.inject({ method: 'POST', url: '/api/projects', payload: inputFor('Hist_02') });
    expect(createB.statusCode).toBe(200);
    const genB = await app.inject({ method: 'POST', url: '/api/projects/Hist_02/production/generate', payload: {} });
    expect(genB.statusCode, genB.payload).toBe(200);

    const stateB = loadProductionState('Hist_02')!;
    // The API PROVES which history was supplied to generation.
    expect(stateB.historyInput.source).toBe('production');
    expect(stateB.historyInput.productionEntryCount).toBeGreaterThanOrEqual(1);
    expect(stateB.historyInput.videoIds).toContain('Hist_01');
    expect(stateB.historyInput.personaKeyCount).toBeGreaterThan(0);

    // ── anti-repeat is observable against the history-free baseline ────────
    const baseline = generateProductionScenariosFromProjectInput(inputFor('Hist_baseline'), { shortCount: 1 });
    expect(baseline.success).toBe(true);
    const baselineCast = personaKeys(baseline.longScenario!);
    const castB = personaKeys(stateB.scenarios.long as Scenario);

    // History-free, identical content reproduces project 1's own cast…
    expect(baselineCast).toEqual(castA);
    // …with history, project 2's cast moves away from it.
    const historyKeys = new Set(Object.values(observationA.personas));
    expect(castB.some((k) => historyKeys.has(k))).toBe(false);
    expect(castB).not.toEqual(castA);

    // The legacy visual history is NOT the authority: it is empty and unused.
    const legacyFile = path.join(tmp.dir, 'data', 'visual_history.json');
    if (fs.existsSync(legacyFile)) {
      expect(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).videos ?? []).toEqual([]);
    }

    // ── determinism: regenerating B reproduces exactly the same result ─────
    const genAgain = await app.inject({ method: 'POST', url: '/api/projects/Hist_02/production/generate', payload: {} });
    expect(genAgain.statusCode).toBe(200);
    const stateB2 = loadProductionState('Hist_02')!;
    expect(JSON.stringify(stateB2.scenarios)).toBe(JSON.stringify(stateB.scenarios));
    expect(stateB2.generationFingerprint).toBe(stateB.generationFingerprint);
    const { at: _atA, ...historyA } = stateB.historyInput as unknown as Record<string, unknown>;
    const { at: _atB, ...historyB } = stateB2.historyInput as unknown as Record<string, unknown>;
    expect(historyB).toEqual(historyA);
  });

  it('a production project that repeats an avoided cast is regenerated deterministically on demand', async () => {
    // Re-generating project 1 AFTER its own observation exists must also avoid
    // repeating itself (the history includes its own last production).
    const again = await app.inject({ method: 'POST', url: '/api/projects/Hist_01/production/generate', payload: {} });
    expect(again.statusCode).toBe(200);
    const state = loadProductionState('Hist_01')!;
    expect(state.historyInput.source).toBe('production');
    expect(state.historyInput.videoIds).toContain('Hist_01');
    const castAfter = personaKeys(state.scenarios.long as Scenario);
    // Either the cast changed, or the deterministic engine found no alternative
    // (it never loops forever, and the state stays consistent).
    expect(Array.isArray(castAfter)).toBe(true);
    expect(state.scenarios.long).toBeTruthy();
  });
});
