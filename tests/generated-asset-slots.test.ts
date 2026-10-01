/**
 * GENERATOR — real bindable asset slots.
 *
 * Proves freshly generated production Scenarios expose deterministic logical
 * asset refs through the EXISTING contract
 * (`scene.production.screenInsert.assetRef`), without inventing a second asset
 * contract and without requiring a user asset to exist.
 *
 * No fixture Scenario is used as production authority anywhere in this file.
 */

import { describe, it, expect } from 'vitest';
import {
  generateProductionScenariosFromProjectInput,
  generatedSourceRecordAssetRef,
  GENERATED_SOURCE_RECORD_ASSET_REF_PREFIX,
  validateScenario,
  type ProjectInput,
  type Scenario,
} from '../packages/core/src/index.js';

/* ------------------------------------------------------------------ */
/*  Fresh, fictional, unseen acceptance-style content                 */
/* ------------------------------------------------------------------ */

const INPUT: ProjectInput = {
  videoId: 'GenAssetSlot_01',
  videoType: 'long',
  topic: 'Controlling an ageing RFI backlog before it becomes schedule delay',
  targetAudience: 'Package managers and document controllers',
  mainProblem: 'Ageing RFIs quietly turn into schedule delay',
  viewerPromise: 'A repeatable 48-hour control routine for the RFI register',
  hook: 'Twenty-four open RFIs, eight of them older than fourteen days.',
  script: [
    'This training example follows a fictional RFI register on a mid-size commercial fit-out.',
    'The register currently holds 24 open RFIs.',
    'Eight of those RFIs are older than 14 days.',
    'The control rule reviews the whole register every 48 hours.',
    'Any RFI still without a response after 7 days is escalated to the package manager.',
    'Three control actions stop the backlog from becoming schedule delay.',
    'First, age the register and flag every item past 14 days.',
    'Second, assign a single named owner to each open RFI.',
    'Third, escalate the aged items on a fixed 48-hour cycle.',
    'An ageing RFI only becomes delay when nobody owns the clock.',
    'Start your BuildTrack trial and put the register on a clock.',
  ].join('\n'),
  keyNumbers: ['24 open RFIs', '8 older than 14 days', '48 hours', '7 days', '3 control actions'],
  keyPoints: ['Age the register', 'Single named owner', 'Fixed escalation cycle'],
  productName: 'BuildTrack',
  productShots: [],
  cta: 'Start your BuildTrack trial',
  voiceoverFile: null,
  targetAudio: {},
  brollFiles: [],
  sourceReferences: ['Fictional training example — RFI Backlog Control, generator asset-slot test'],
  outputLanguage: 'en',
  brandPreset: 'buildtrack',
  shortCount: 1,
};

function generate(): { long: Scenario; short_1: Scenario | null } {
  const r = generateProductionScenariosFromProjectInput(INPUT, { shortCount: 1 });
  expect(r.success).toBe(true);
  if (!r.success) throw new Error('generation failed');
  return {
    long: r.longScenario,
    short_1: r.shortScenarios.short_1 ?? null,
  };
}

/** Logical asset refs carried by a generated Scenario, in scene order. */
function refsOf(scenario: Scenario): string[] {
  return scenario.scenes
    .map((s) => s.production?.screenInsert?.assetRef)
    .filter((r): r is string => typeof r === 'string' && r.length > 0);
}

/* ------------------------------------------------------------------ */

describe('generator — real bindable asset slots', () => {
  it('gate G1: a fresh generated Long with evidence/screenInsert produces >=1 logical assetRef', () => {
    const { long } = generate();
    const refs = refsOf(long);
    expect(refs.length).toBeGreaterThanOrEqual(1);
    // Every scene that carries a screenInsert carries a ref, and vice versa.
    const insertScenes = long.scenes.filter((s) => s.production?.screenInsert);
    expect(insertScenes.length).toBeGreaterThanOrEqual(1);
    expect(refs.length).toBe(insertScenes.length);
  });

  it('gate G2: the relevant Short does likewise when it contains such a screenInsert', () => {
    const { short_1 } = generate();
    expect(short_1).not.toBeNull();
    const refs = refsOf(short_1!);
    const insertScenes = short_1!.scenes.filter((s) => s.production?.screenInsert);
    expect(insertScenes.length).toBeGreaterThanOrEqual(1);
    expect(refs.length).toBe(insertScenes.length);
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('gate G3: identical input produces identical logical refs', () => {
    const a = generate();
    const b = generate();
    expect(refsOf(a.long)).toEqual(refsOf(b.long));
    expect(refsOf(a.short_1!)).toEqual(refsOf(b.short_1!));
    // Stable across a deep re-serialisation of the same input too.
    const c = generateProductionScenariosFromProjectInput(
      JSON.parse(JSON.stringify(INPUT)) as ProjectInput,
      { shortCount: 1 },
    );
    expect(c.success).toBe(true);
    if (!c.success) return;
    expect(refsOf(c.longScenario)).toEqual(refsOf(a.long));
  });

  it('gate G4: refs contain no random, time-derived or uuid components', () => {
    const { long, short_1 } = generate();
    for (const ref of [...refsOf(long), ...refsOf(short_1!)]) {
      expect(ref).not.toMatch(/\d{10,}/); // epoch-ish
      expect(ref).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i); // uuid
      expect(ref).not.toMatch(/Date\.now|performance\.now/);
    }
    // And the whole Scenario is byte-identical across runs, not just the refs.
    const a = JSON.stringify(generate().long);
    const b = JSON.stringify(generate().long);
    expect(a).toBe(b);
  });

  it('gate G5: no facts, dialogue, evidence or numeric authority changes', () => {
    const a = generate();
    const b = generate();
    const strip = (s: Scenario) => ({
      evidence: s.evidence,
      turns: s.scenes.flatMap((sc) => sc.turns.map((t) => ({ id: t.id, text: t.spokenText, speaker: t.speakerId, evidenceId: t.evidenceId }))),
      numeric: s.evidence.flatMap((e) => e.numericFacts.map((f) => `${f.metric}=${f.value}${f.unit}`)),
    });
    expect(strip(a.long)).toEqual(strip(b.long));
    // The screenInsert description is still the evidence claim — unchanged.
    for (const scene of a.long.scenes) {
      const si = scene.production?.screenInsert;
      if (!si) continue;
      const ev = a.long.evidence.find((e) => e.usedInSceneIds.includes(scene.id));
      if (ev) expect(si.description).toBe(ev.claim);
    }
    // Spoken numbers are untouched by the slot.
    const spoken = a.long.scenes.flatMap((sc) => sc.turns.map((t) => t.spokenText)).join(' ');
    expect(spoken).toContain('24');
    expect(spoken).toContain('48');
  });

  it('gate G6: Scenario validation remains valid with an unbound slot', () => {
    const { long, short_1 } = generate();
    expect(validateScenario(long).valid).toBe(true);
    expect(validateScenario(short_1!).valid).toBe(true);
  });

  it('gate G7: no fixture fallback — refs carry no fixture identity', () => {
    const { long, short_1 } = generate();
    const all = [...refsOf(long), ...refsOf(short_1!)];
    expect(all.length).toBeGreaterThanOrEqual(1);
    for (const ref of all) {
      expect(ref).not.toContain('progress-meeting');
      expect(ref).not.toContain('schedule-risk');
      expect(ref).not.toContain('hospital-expansion');
      expect(ref).not.toContain('rfi-ageing-summary'); // no acceptance constant
      expect(ref).not.toContain('iva-progress-chart');
    }
  });

  it('gate G8: screenInsert without an external binding remains legal and optional', () => {
    const { long } = generate();
    // The contract field is optional; a generated slot is just a logical identity.
    const scene = long.scenes.find((s) => s.production?.screenInsert?.assetRef)!;
    expect(scene.production!.screenInsert!.assetRef).toBeTruthy();
    // No Asset Library id leaks into the Scenario: it is a logical slot only.
    expect(scene.production!.screenInsert!.assetRef).toMatch(
      new RegExp(`^${GENERATED_SOURCE_RECORD_ASSET_REF_PREFIX.replace(':', '\\:')}`),
    );
    expect(scene.production!.screenInsert!.assetRef).not.toMatch(/^asset-/);
  });

  it('gate G9: the ref convention is derived from evidence identity, deterministically', () => {
    expect(generatedSourceRecordAssetRef('ev-x-01')).toBe('source-record:ev-x-01');
    expect(generatedSourceRecordAssetRef('ev-x-01')).toBe(generatedSourceRecordAssetRef('ev-x-01'));
    expect(generatedSourceRecordAssetRef('ev-x-01')).not.toBe(generatedSourceRecordAssetRef('ev-x-02'));
  });

  it('gate G10: a ref is derived from the scene primary evidence record; sharing is deliberate', () => {
    const { long, short_1 } = generate();

    for (const scenario of [long, short_1!]) {
      // A scene may reference several evidence records in its turns, but its
      // "Source Record" screenInsert is the scene's PRIMARY evidence — so the
      // generated ref must be that primary evidence record's slot.
      for (const scene of scenario.scenes) {
        const ref = scene.production?.screenInsert?.assetRef;
        if (!ref) continue;
        const primaryEvidenceId = (scene.evidenceIds ?? [])[0];
        expect(primaryEvidenceId, `scene ${scene.id} has a slot but no evidence`).toBeTruthy();
        expect(ref).toBe(generatedSourceRecordAssetRef(primaryEvidenceId));
      }

      // Distinct primary evidence records -> distinct refs. Two scenes that
      // share a primary evidence record deliberately share one logical slot
      // (one source record, one media slot, resolved once by Phase 6A).
      const primaryToRef = new Map<string, string>();
      for (const scene of scenario.scenes) {
        const ref = scene.production?.screenInsert?.assetRef;
        if (!ref) continue;
        const primaryEvidenceId = (scene.evidenceIds ?? [])[0]!;
        const existing = primaryToRef.get(primaryEvidenceId);
        if (existing) expect(existing).toBe(ref);
        else primaryToRef.set(primaryEvidenceId, ref);
      }
      const refs = [...primaryToRef.values()];
      expect(new Set(refs).size).toBe(refs.length);
    }
  });

  it('gate G11: refs survive a Scenario round-trip through persistence', () => {
    const { long } = generate();
    const reloaded = JSON.parse(JSON.stringify(long)) as Scenario;
    expect(refsOf(reloaded)).toEqual(refsOf(long));
    expect(validateScenario(reloaded).valid).toBe(true);
  });
});
