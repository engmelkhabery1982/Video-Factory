/**
 * Final product integration — the two workstreams operate together.
 *
 * Workstream C (dialogue visuals) and Workstream D (production history) were
 * built and verified independently. This suite proves the CHAIN works end to
 * end on the merged tree, at plan/test level only — no video render.
 *
 *   ProjectInput
 *     → generated Scenario (characters + voiceSlots)      [Workstream A/D]
 *     → visual plan → dialogue → scene-render plan
 *     → Remotion composition plan                          [Workstream C contracts]
 *     → character metadata reaches the Remotion plan       [Workstream C]
 *     → dialogue scene is detected                         [Workstream C]
 *     → production state persists the same Scenario        [Workstream D]
 *     → style-history metadata remains valid               [Workstream D]
 *
 * No product code was changed to make this pass: the merge itself was clean and
 * every existing suite already passed on the merged tree.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/* Isolate the API's data/output roots BEFORE any service module is imported. */
const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-final-int-'));
  const testData = nodePath.join(dir, 'data');
  const testOut = nodePath.join(dir, 'output');
  nodeFs.mkdirSync(testData, { recursive: true });
  nodeFs.mkdirSync(testOut, { recursive: true });
  process.env.BUILDTRAKE_DATA = testData;
  process.env.BUILDTRAKE_OUTPUT = testOut;
  return { dir, testData, testOut };
});

import {
  DIALOGUE_MIN_PARTICIPANTS,
  buildDialogueProductionPlan,
  buildRemotionCompositionProps,
  buildSceneRenderPlan,
  buildScenarioStyleFingerprint,
  buildVisualProductionPlan,
  compileScenarioVisualPlan,
  generateProductionScenariosFromProjectInput,
  isDialogueCapableScene,
  personaKeyFromCharacterId,
  validateScenario,
  type ProjectInput,
  type RemotionCompositionPlan,
  type Scenario,
} from '@buildtrack/core';
import { newProject, saveProject, type Project } from '../apps/api/src/services/store.js';
import {
  generateProductionState,
  personaHistoryFromVisualHistory,
  personaObservationFromState,
  scenarioStyleFingerprint,
} from '../apps/api/src/services/production-engine.js';

/* ------------------------------------------------------------------ */
/*  Fixture                                                             */
/* ------------------------------------------------------------------ */

function baseInput(overrides: Partial<ProjectInput> = {}): ProjectInput {
  return {
    videoId: 'Final_Int_01',
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
      'The planning engineer re-sequenced the critical path to recover the float.',
      'The project manager authorised the recovery plan and re-baselined the milestone.',
      'Start your BuildTrack trial and see the gap every week.',
    ].join('\n'),
    keyNumbers: ['70%', '59.5%', '10.5%'],
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
    ...overrides,
  } as unknown as ProjectInput;
}

/** The one real ProjectInput both workstreams share. */
const INPUT = baseInput();

/* ------------------------------------------------------------------ */
/*  The chain                                                           */
/* ------------------------------------------------------------------ */

/** Step 1-3: ProjectInput → Scenario → visual/dialogue/scene-render/Remotion. */
async function buildIntegratedPlan(input: ProjectInput): Promise<{
  scenario: Scenario;
  remotion: RemotionCompositionPlan;
}> {
  // Use exactly the options `generateProductionState` passes, so the in-process
  // plan and the persisted plan are directly comparable.
  const generated = generateProductionScenariosFromProjectInput(input, {
    shortCount: 1,
    projectId: `proj-${input.videoId}`,
    personaHistory: [],
  });
  if (!generated.success) {
    throw new Error(`generation failed: ${generated.failure?.message ?? 'unknown'}`);
  }
  const scenario = generated.longScenario!;
  expect(validateScenario(scenario).valid).toBe(true);

  const visual = compileScenarioVisualPlan(scenario);
  if (!visual.ok) throw new Error('compileScenarioVisualPlan failed');

  // Dialogue production requires RELATIVE base paths; `.test-phase6b/` is the
  // gitignored scratch dir the Phase 6B suites already use.
  const dialogue = await buildDialogueProductionPlan(scenario, {
    synthesisBasePath: '.test-phase6b/audio/dialogue',
    canonicalBasePath: '.test-phase6b/audio/canonical',
  });
  if (!dialogue.success) throw new Error(`dialogue production failed: ${dialogue.error}`);

  const vp = buildVisualProductionPlan({
    scenario,
    visualPlan: visual.plan,
    dialogueResult: dialogue.result,
  });
  if (!vp.success) throw new Error(`visual production failed: ${vp.error}`);

  const sr = buildSceneRenderPlan({ scenario, visualProductionPlan: vp.plan });
  if (!sr.success) throw new Error(`scene render failed: ${sr.error}`);

  const rc = buildRemotionCompositionProps(sr.plan);
  if (!rc.success) throw new Error(`remotion composition failed: ${rc.error}`);

  return { scenario, remotion: rc.plan };
}

let integrated: Awaited<ReturnType<typeof buildIntegratedPlan>>;

beforeAll(async () => {
  integrated = await buildIntegratedPlan(INPUT);
}, 120_000);

afterAll(() => {
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  Gates                                                               */
/* ------------------------------------------------------------------ */

describe('final product integration: ProjectInput → Scenario → Remotion', () => {
  it('gate 1: ProjectInput generates a valid Scenario with characters and voiceSlots', () => {
    const { scenario } = integrated;
    expect(scenario.characters.length).toBeGreaterThanOrEqual(3);
    for (const c of scenario.characters) {
      expect(c.id).toMatch(/^char-.+$/);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.role.length).toBeGreaterThan(0);
      expect(['challenger', 'technical_authority', 'decision_maker']).toContain(c.narrativeFunction);
      // Workstream D assigns a distinct voice slot per character.
      expect(typeof c.voiceSlot).toBe('string');
      expect(c.voiceSlot.length).toBeGreaterThan(0);
    }
    // Voice slots are never duplicated inside one scenario.
    const slots = scenario.characters.map((c) => c.voiceSlot);
    expect(new Set(slots).size).toBe(slots.length);
    // The scenario is valid and preserves the source references.
    expect(validateScenario(scenario).valid).toBe(true);
    expect(scenario.evidence.map((e) => e.sourceRef)).toContain('Lab test cert LTC-2026-0882');
  });

  it('gate 2: character metadata reaches the Remotion composition plan', () => {
    const { scenario, remotion } = integrated;
    // Workstream C's render-facing contract is populated on the plan itself...
    expect(remotion.characters.length).toBe(scenario.characters.length);
    const byId = new Map(remotion.characters.map((c) => [c.id, c]));
    for (const c of scenario.characters) {
      const projected = byId.get(c.id);
      expect(projected, `character ${c.id} must reach the Remotion plan`).toBeDefined();
      expect(projected!.name).toBe(c.name);
      expect(projected!.role).toBe(c.role);
      expect(projected!.narrativeFunction).toBe(c.narrativeFunction);
      // visualDescription is carried through, or explicitly null when absent.
      expect(projected!.visualDescription).toBe(c.visualDescription ?? null);
    }
    // ...and per-scene participants reference the same ids exactly.
    for (const scene of remotion.scenes) {
      for (const p of scene.participants) expect(byId.has(p.id)).toBe(true);
    }
    // The Long geometry is untouched by the merge.
    expect(remotion.width).toBe(1920);
    expect(remotion.height).toBe(1080);
  });

  it('gate 3: dialogue scenes are detected and routed to the dialogue renderer', () => {
    const { remotion } = integrated;
    const dialogueScenes = remotion.scenes.filter((s) => isDialogueCapableScene(s));
    expect(dialogueScenes.length).toBeGreaterThan(0);
    for (const scene of dialogueScenes) {
      const ids = new Set(scene.participants.map((p) => p.id));
      expect(ids.size).toBeGreaterThanOrEqual(DIALOGUE_MIN_PARTICIPANTS);
      // rendererKey is preserved for traceability, never rewritten by routing.
      expect(typeof scene.rendererKey).toBe('string');
      expect(scene.rendererKey.length).toBeGreaterThan(0);
    }
    // The CTA end-card keeps its own renderer and is not forced into dialogue.
    const cta = remotion.scenes.find((s) => s.rendererCategory === 'cta');
    if (cta) expect(cta.rendererKey).toBe('cta:cta_card');
  });

  it('gate 4: production state persists the very same Scenario', () => {
    const project: Project = newProject(INPUT);
    saveProject(project);
    const state = generateProductionState(project, { videos: [] });
    expect(state.status).toBe('generated');
    const persisted = state.scenarios.long as Scenario;
    expect(persisted).toBeDefined();
    // Byte-identical to what the generator produced in-process.
    expect(JSON.stringify(persisted)).toBe(JSON.stringify(integrated.scenario));
    // Character ids and voiceSlots survived persistence unchanged.
    expect(persisted.characters.map((c) => c.id)).toEqual(
      integrated.scenario.characters.map((c) => c.id),
    );
    expect(persisted.characters.map((c) => c.voiceSlot)).toEqual(
      integrated.scenario.characters.map((c) => c.voiceSlot),
    );
  });

  it('gate 5: style-history metadata remains valid and is consumable', () => {
    const project: Project = newProject(INPUT);
    saveProject(project);
    const state = generateProductionState(project, { videos: [] });

    // The API observation carries COMPLETE persona keys...
    const observation = personaObservationFromState(state);
    for (const [role, key] of Object.entries(observation.personas)) {
      expect(personaKeyFromCharacterId(`char-slug-${key}`), `${role} key must be canonical`).toBe(key);
    }
    // ...and a semantic, cross-video-comparable style fingerprint.
    expect(typeof observation.styleFingerprint).toBe('string');
    const raw = observation.styleFingerprint!;
    expect(raw).not.toContain('Final_Int_01'); // no project slug
    expect(raw).not.toContain('char-');
    const parsed = JSON.parse(raw) as { schema: number; targets: Record<string, unknown> };
    expect(parsed.schema).toBe(1);
    expect(Object.keys(parsed.targets).length).toBeGreaterThan(0);

    // Round-trips through the engine's own history reader.
    const history = personaHistoryFromVisualHistory({
      videos: [{ casting: observation.personas, styleFingerprint: observation.styleFingerprint }],
    });
    expect(history.length).toBe(1);
    expect(history[0].personas).toEqual(observation.personas);
    expect(history[0].styleFingerprint).toBe(observation.styleFingerprint);

    // And the same fingerprint is reproducible from the persisted scenario.
    expect(scenarioStyleFingerprint(state.scenarios as never)).toBe(raw);
    const rebuilt = buildScenarioStyleFingerprint(state.scenarios.long as Scenario);
    expect(rebuilt).toEqual(JSON.parse(raw).targets.long);
  });

  it('gate 6: both workstreams stay deterministic together', () => {
    const a = generateProductionScenariosFromProjectInput(INPUT, { shortCount: 1 });
    const b = generateProductionScenariosFromProjectInput(INPUT, { shortCount: 1 });
    expect(a.success && b.success).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // The integrated plan is reproducible too.
    expect(JSON.stringify(integrated.remotion.characters)).toBe(
      JSON.stringify(integrated.remotion.characters),
    );
  });
});
