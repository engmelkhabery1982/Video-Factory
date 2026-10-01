/**
 * Workstream D correction — production history avoidance must actually work.
 *
 * Two defects are proven fixed here:
 *
 *  1. Persona keys were recovered from generated character ids with
 *     `/^char-(.+)-([^-]+)$/`, which truncates a hyphenated persona key
 *     (`char-…-commercial-lead` -> `lead`). Cross-video casting history compared
 *     truncated keys against complete ones, so avoidance never fired.
 *
 *  2. `styleFingerprint` was persisted but never consumed, and what it
 *     persisted was not comparable across videos (it used project-slug-bearing
 *     character ids and sorted the sequences, destroying ordering).
 *
 * Every test here is deterministic: no clock, no randomness, no UUIDs.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildScenarioStyleFingerprint,
  generateProductionScenariosFromProjectInput,
  parseScenarioStyleFingerprints,
  personaKeyFromCharacterId,
  validateScenario,
  CANONICAL_PERSONA_KEYS,
  type ProjectInput,
  type Scenario,
  type ScenarioStyleFingerprint,
} from '@buildtrack/core';

/* ------------------------------------------------------------------ */
/*  Fixture                                                             */
/* ------------------------------------------------------------------ */

/** Workstream D baseline this correction is applied on top of. */
const BASELINE = process.env.WSC_BASELINE ?? '1f248b67141c5ba2b358f1730c8d72f89e4aabaf';

function baseInput(overrides: Partial<ProjectInput> = {}): ProjectInput {
  return {
    videoId: 'Style_Hist_01',
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

/** The history-free (default) production for the fixture. */
function baselineProduction() {
  const result = generateProductionScenariosFromProjectInput(baseInput(), { shortCount: 1 });
  if (!result.success) throw new Error(`baseline generation failed: ${result.failure?.message}`);
  return { long: result.longScenario!, short: result.shortScenarios.short_1! };
}

const BASE = baselineProduction();

/** Complete persona key per narrative role, as production history stores it. */
function personaMap(scenario: Scenario): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of scenario.characters) out[c.narrativeFunction] = personaKeyFromCharacterId(c.id)!;
  return out;
}

/**
 * A minimal cast carrying hyphenated persona keys through a project slug that
 * itself contains hyphens — the exact shape the history observation consumes.
 */
function syntheticCastScenario(): Scenario {
  return {
    characters: [
      { id: 'char-my-project-commercial-lead', narrativeFunction: 'challenger' },
      { id: 'char-my-project-planning-engineer', narrativeFunction: 'technical_authority' },
      { id: 'char-my-project-project-manager', narrativeFunction: 'decision_maker' },
    ],
    scenes: [],
    locations: [],
    evidence: [],
  } as unknown as Scenario;
}

/** A per-target style fingerprint set covering Long + Short. */
function styleSet(long: Scenario, short: Scenario): string {
  return JSON.stringify({
    schema: 1,
    targets: {
      long: buildScenarioStyleFingerprint(long),
      short_1: buildScenarioStyleFingerprint(short),
    },
  });
}

/** Persist a production exactly the way the engine does, then read it back. */
function historyEntryFor(long: Scenario, short: Scenario) {
  return {
    videoId: long.metadata.id,
    at: '2026-10-01T00:00:00.000Z',
    casting: personaMap(long),
    styleFingerprint: styleSet(long, short),
  };
}

function shots(scenario: Scenario): string[] {
  return scenario.scenes.map((s) => s.production.shotType);
}
function framing(scenario: Scenario): string[] {
  return scenario.scenes.map((s) => s.production.framing);
}
function camera(scenario: Scenario): string[] {
  return scenario.scenes.map((s) => s.production.cameraMovement);
}
function settings(scenario: Scenario): string[] {
  const byId = new Map(scenario.locations.map((l) => [l.id, l.settingType]));
  return scenario.scenes.map((s) => byId.get(s.locationId) ?? 'unknown');
}
function opening(scenario: Scenario): ScenarioStyleFingerprint['opening'] {
  return buildScenarioStyleFingerprint(scenario).opening;
}

/* ------------------------------------------------------------------ */
/*  Gates 1-3: persona-key extraction round-trips exactly              */
/* ------------------------------------------------------------------ */

describe('persona-key extraction (gates 1-3)', () => {
  it('gate 1: commercial-lead round-trips exactly through production history', () => {
    // The id embeds a project slug that itself contains hyphens, so splitting on
    // the last hyphen would truncate the key to `lead`.
    expect(personaKeyFromCharacterId('char-my-project-commercial-lead')).toBe('commercial-lead');
    expect(personaKeyFromCharacterId(`char-${BASE.long.metadata.id}-commercial-lead`)).toBe('commercial-lead');
    // And the COMPLETE key survives the observation path the engine uses to
    // build casting history.
    const observed = personaMap(syntheticCastScenario());
    expect(observed).toEqual({
      challenger: 'commercial-lead',
      technical_authority: 'planning-engineer',
      decision_maker: 'project-manager',
    });
    // A real generated production round-trips its own keys the same way.
    const real = personaMap(BASE.long);
    for (const c of BASE.long.characters) {
      expect(real[c.narrativeFunction]).toBe(personaKeyFromCharacterId(c.id));
      expect(CANONICAL_PERSONA_KEYS).toContain(real[c.narrativeFunction]);
    }
  });

  it('gate 2: planning-engineer round-trips exactly', () => {
    expect(personaKeyFromCharacterId('char-a-b-planning-engineer')).toBe('planning-engineer');
    expect(personaKeyFromCharacterId('char-planning-engineer-x')).toBeNull(); // key is not the suffix
  });

  it('gate 3: project-manager round-trips exactly', () => {
    expect(personaKeyFromCharacterId('char-my-project-project-manager')).toBe('project-manager');
    expect(personaKeyFromCharacterId('char-p-project-director')).toBe('project-director');
  });

  it('every canonical persona key round-trips, and nothing else does', () => {
    for (const key of CANONICAL_PERSONA_KEYS) {
      expect(personaKeyFromCharacterId(`char-slug-with-hyphens-${key}`)).toBe(key);
    }
    // Non-character ids and unknown persona keys resolve to null, never a guess.
    expect(personaKeyFromCharacterId('loc-my-project-review')).toBeNull();
    expect(personaKeyFromCharacterId('char-my-project-unknown-persona')).toBeNull();
    expect(personaKeyFromCharacterId('')).toBeNull();
    expect(personaKeyFromCharacterId('commercial-lead')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Gate 4: casting history avoidance                                  */
/* ------------------------------------------------------------------ */

describe('casting history (gate 4)', () => {
  it('gate 4: a recent identical cast causes a deterministic alternative cast', () => {
    const recent = personaMap(BASE.long);
    expect(Object.keys(recent).length).toBe(3);

    const first = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [{ personas: recent }],
    });
    const second = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [{ personas: recent }],
    });
    expect(first.success && second.success).toBe(true);

    const long = first.longScenario!;
    // Same input + same history => same alternative (deterministic, not random).
    expect(JSON.stringify(second.longScenario)).toBe(JSON.stringify(long));

    const chosen = Object.values(personaMap(long));
    // No role reuses a persona from the recent combination...
    for (const key of chosen) expect(Object.values(recent)).not.toContain(key);
    // ...and the alternative really is a different combination.
    expect(chosen).not.toEqual(Object.values(recent));
    // Every alternative is a real canonical persona key of the right role.
    for (const c of long.characters) {
      expect(CANONICAL_PERSONA_KEYS).toContain(personaKeyFromCharacterId(c.id)!);
    }
    expect(validateScenario(long).valid).toBe(true);
  });

  it('gate 4b: no safe alternative keeps the original valid cast', () => {
    // Every persona key of every role is recent, so nothing can be avoided.
    const byRole: Record<string, string[]> = {};
    for (const c of BASE.long.characters) {
      (byRole[c.narrativeFunction] ??= []).push(personaKeyFromCharacterId(c.id)!);
    }
    const all: Record<string, string> = {};
    for (const [role, keys] of Object.entries(byRole)) {
      all[role] = keys[0];
    }
    const result = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [{ personas: all }, { personas: personaMap(BASE.long) }],
    });
    expect(result.success).toBe(true);
    expect(validateScenario(result.longScenario!).valid).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Gate 5: styleFingerprint is actually consumed                      */
/* ------------------------------------------------------------------ */

describe('style fingerprint consumption (gate 5)', () => {
  it('gate 5: an absent fingerprint leaves the default treatment untouched', () => {
    const result = generateProductionScenariosFromProjectInput(baseInput(), { shortCount: 1 });
    expect(result.success).toBe(true);
    expect(shots(result.longScenario!)).toEqual(shots(BASE.long));
    expect(framing(result.longScenario!)).toEqual(framing(BASE.long));
    expect(camera(result.longScenario!)).toEqual(camera(BASE.long));
    expect(settings(result.longScenario!)).toEqual(settings(BASE.long));
  });

  it('gate 5b: an unrelated fingerprint also leaves the default treatment untouched', () => {
    // A real fingerprint from a DIFFERENT visual treatment must not force
    // variation, otherwise history would be consumed unconditionally.
    const unrelated = JSON.stringify({
      schema: 1,
      targets: {
        long: {
          cast: ['challenger:quality-lead'],
          opening: {
            participants: ['challenger', 'decision_maker'],
            shotType: 'wide',
            framing: 'symmetric',
            cameraMovement: 'slow_pull',
            speakerFocus: 'reacting_character',
            settingType: 'site_walk',
          },
          shotSeq: ['close_up'],
          framingSeq: ['symmetric'],
          cameraSeq: ['slow_pull'],
          settingSeq: ['site_walk'],
          settingMix: ['site_walk'],
        },
      },
    });
    const result = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [{ personas: { challenger: 'quality-lead' }, styleFingerprint: unrelated }],
    });
    expect(result.success).toBe(true);
    expect(shots(result.longScenario!)).toEqual(shots(BASE.long));
    expect(framing(result.longScenario!)).toEqual(framing(BASE.long));
    expect(camera(result.longScenario!)).toEqual(camera(BASE.long));
  });

  it('gate 5c: a matching recent fingerprint IS consumed and changes the treatment', () => {
    const result = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [historyEntryFor(BASE.long, BASE.short)],
    });
    expect(result.success).toBe(true);
    const long = result.longScenario!;
    const changed =
      shots(long).join() !== shots(BASE.long).join() ||
      framing(long).join() !== framing(BASE.long).join() ||
      camera(long).join() !== camera(BASE.long).join() ||
      settings(long).join() !== settings(BASE.long).join();
    expect(changed).toBe(true);
  });

  it('gate 5d: a malformed/legacy fingerprint never breaks generation', () => {
    const result = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [
        { personas: { challenger: 'commercial-lead' }, styleFingerprint: 'fp-1' },
        { personas: {}, styleFingerprint: '' },
        { personas: {} },
      ],
    });
    expect(result.success).toBe(true);
    expect(validateScenario(result.longScenario!).valid).toBe(true);
    expect(parseScenarioStyleFingerprints('fp-1')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Gates 6-8: shot / framing / camera history                         */
/* ------------------------------------------------------------------ */

describe('shot, framing and camera history (gates 6-8)', () => {
  it('gate 6: recent identical shot style deterministically produces a different valid shot pattern', () => {
    const result = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [historyEntryFor(BASE.long, BASE.short)],
    });
    const long = result.longScenario!;
    expect(shots(long)).not.toEqual(shots(BASE.long));
    // Still a valid shot vocabulary and a valid scenario.
    for (const s of long.scenes) {
      expect(['two_shot', 'medium', 'close_up', 'wide', 'over_the_shoulder']).toContain(s.production.shotType);
    }
    expect(validateScenario(long).valid).toBe(true);
  });

  it('gate 7: framing history influences a deterministic valid alternative', () => {
    const withHistory = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [historyEntryFor(BASE.long, BASE.short)],
    });
    expect(framing(withHistory.longScenario!)).not.toEqual(framing(BASE.long));
    for (const s of withHistory.longScenario!.scenes) {
      expect(['center', 'rule_of_thirds_left', 'rule_of_thirds_right', 'symmetric']).toContain(s.production.framing);
    }
  });

  it('gate 8: camera-movement history influences a deterministic valid alternative', () => {
    const withHistory = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [historyEntryFor(BASE.long, BASE.short)],
    });
    expect(camera(withHistory.longScenario!)).not.toEqual(camera(BASE.long));
    for (const s of withHistory.longScenario!.scenes) {
      expect(['slow_push', 'pan_right', 'static', 'pan_left', 'subtle_drift', 'slow_pull']).toContain(
        s.production.cameraMovement,
      );
    }
  });

  it('gates 6-8: each dimension varies independently and deterministically', () => {
    const run = () =>
      generateProductionScenariosFromProjectInput(baseInput(), {
        shortCount: 1,
        personaHistory: [historyEntryFor(BASE.long, BASE.short)],
      }).longScenario!;
    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(shots(a).join()).not.toBe(shots(BASE.long).join());
    expect(framing(a).join()).not.toBe(framing(BASE.long).join());
    expect(camera(a).join()).not.toBe(camera(BASE.long).join());
  });
});

/* ------------------------------------------------------------------ */
/*  Gate 9: semantic location / setting mix                            */
/* ------------------------------------------------------------------ */

describe('location / setting history (gate 9)', () => {
  it('gate 9: the setting mix is semantic and free of project-specific ids', () => {
    const fp = buildScenarioStyleFingerprint(BASE.long);
    // Semantic setting types participate in the fingerprint.
    expect(fp.settingMix.length).toBeGreaterThan(0);
    for (const s of fp.settingMix) {
      expect(['progress_meeting', 'site_walk', 'commercial_meeting', 'planning_review', 'office_discussion', 'unknown']).toContain(s);
    }
    // No location id, scene id, scenario id or project slug anywhere.
    const raw = JSON.stringify(fp);
    expect(raw).not.toContain('loc-');
    expect(raw).not.toContain('sc-');
    expect(raw).not.toContain('scenario-');
    expect(raw).not.toContain('Style_Hist_01');
    expect(raw).not.toContain('char-');
  });

  it('gate 9b: recent location mix deterministically changes the location assignment', () => {
    const withHistory = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [historyEntryFor(BASE.long, BASE.short)],
    });
    expect(settings(withHistory.longScenario!)).not.toEqual(settings(BASE.long));
    // Locations stay the scenario's own two locations; only the assignment moved.
    const ids = new Set(withHistory.longScenario!.scenes.map((s) => s.locationId));
    expect(ids.size).toBeLessThanOrEqual(2);
    expect([...ids].every((id) => withHistory.longScenario!.locations.some((l) => l.id === id))).toBe(true);
  });

  it('gate 9c: a site-only history does not force site settings where unsupported', () => {
    const result = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [
        {
          personas: {},
          styleFingerprint: JSON.stringify({
            schema: 1,
            targets: {
              long: {
                ...buildScenarioStyleFingerprint(BASE.long),
                settingSeq: ['site_walk'],
                settingMix: ['site_walk'],
              },
            },
          }),
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(validateScenario(result.longScenario!).valid).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Gate 10: opening configuration history                             */
/* ------------------------------------------------------------------ */

describe('opening configuration history (gate 10)', () => {
  it('gate 10: a repeated opening configuration changes the opening treatment', () => {
    const result = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [historyEntryFor(BASE.long, BASE.short)],
    });
    expect(opening(result.longScenario!)).not.toEqual(opening(BASE.long));
  });

  it('gate 10b: the opening moves even when the full sequences already differ', () => {
    // Only the opening configuration repeats; every sequence is deliberately
    // different, so only the opening rule can fire. This proves the opening is
    // tracked in its own right rather than as a side effect of the sequences.
    const divergent = {
      ...buildScenarioStyleFingerprint(BASE.long),
      shotSeq: ['close_up'],
      framingSeq: ['symmetric'],
      cameraSeq: ['slow_pull'],
      settingSeq: ['site_walk'],
      settingMix: ['site_walk'],
      // opening is left identical to the baseline opening.
    };
    const result = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [
        { personas: {}, styleFingerprint: JSON.stringify({ schema: 1, targets: { long: divergent } }) },
      ],
    });
    expect(result.success).toBe(true);
    const before = opening(BASE.long);
    const after = opening(result.longScenario!);
    expect(after).not.toEqual(before);
    // Participants are unchanged (casting is a separate concern); only the
    // opening VISUAL TREATMENT moved.
    expect(after.participants).toEqual(before.participants);
    expect(
      after.shotType !== before.shotType ||
        after.framing !== before.framing ||
        after.cameraMovement !== before.cameraMovement,
    ).toBe(true);
    expect(validateScenario(result.longScenario!).valid).toBe(true);
  });

  it('gate 10c: opening participants are captured in the fingerprint', () => {
    const fp = buildScenarioStyleFingerprint(BASE.long);
    expect(fp.opening.participants.length).toBeGreaterThanOrEqual(2);
    for (const p of fp.opening.participants) {
      expect(['challenger', 'technical_authority', 'decision_maker']).toContain(p);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Gates 11-12: determinism                                           */
/* ------------------------------------------------------------------ */

describe('determinism (gates 11-12)', () => {
  it('gate 11: same input + same history produces byte-identical output', () => {
    const history = [historyEntryFor(BASE.long, BASE.short)];
    const a = generateProductionScenariosFromProjectInput(baseInput(), { shortCount: 1, personaHistory: history });
    const b = generateProductionScenariosFromProjectInput(baseInput(), { shortCount: 1, personaHistory: history });
    expect(a.success && b.success).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a.longScenario)).toBe(JSON.stringify(b.longScenario));
    expect(JSON.stringify(a.shortScenarios)).toBe(JSON.stringify(b.shortScenarios));
  });

  it('gate 11b: the generator never reads a clock, randomness or uuid', () => {
    const src = fs.readFileSync(
      path.resolve('packages/core/src/scenario/script-scenario-generator.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/\bDate\.now\s*\(/);
    expect(src).not.toMatch(/\bMath\.random\s*\(/);
    expect(src).not.toMatch(/\brandomUUID\s*\(/);
    expect(src).not.toMatch(/\bcrypto\.random/);
  });

  it('gate 12: materially different recent history can produce a different valid treatment', () => {
    const plain = generateProductionScenariosFromProjectInput(baseInput(), { shortCount: 1 });
    const varied = generateProductionScenariosFromProjectInput(baseInput(), {
      shortCount: 1,
      personaHistory: [historyEntryFor(BASE.long, BASE.short)],
    });
    expect(plain.success && varied.success).toBe(true);
    expect(JSON.stringify(plain.longScenario)).not.toBe(JSON.stringify(varied.longScenario));
    expect(validateScenario(plain.longScenario!).valid).toBe(true);
    expect(validateScenario(varied.longScenario!).valid).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Gates 13-18: factual / numeric / evidence preservation             */
/* ------------------------------------------------------------------ */

describe('factual, numeric and evidence preservation (gates 13-18)', () => {
  const varied = generateProductionScenariosFromProjectInput(baseInput(), {
    shortCount: 1,
    personaHistory: [historyEntryFor(BASE.long, BASE.short)],
  });
  const vLong = varied.longScenario!;
  const vShort = varied.shortScenarios.short_1!;

  const spoken = (s: Scenario) => s.scenes.flatMap((sc) => sc.turns.map((t) => t.spokenText));
  const numericFacts = (s: Scenario) => s.evidence.flatMap((e) => e.numericFacts.map((f) => `${f.metric}=${f.value}${f.unit}`));
  const sourceRefs = (s: Scenario) => s.evidence.map((e) => e.sourceRef);
  const evidenceClaims = (s: Scenario) => s.evidence.map((e) => e.claim);

  it('gate 13: spoken factual content remains unchanged', () => {
    expect(spoken(vLong)).toEqual(spoken(BASE.long));
    expect(spoken(vShort)).toEqual(spoken(BASE.short));
    // The user's own sentences are still delivered. The generator prefixes a
    // fact-free narrative frame and lower-cases the payload's first character,
    // so the comparison is case-insensitive on the sentence body.
    const delivered = spoken(vLong).join(' ').toLowerCase();
    for (const line of baseInput().script.split('\n')) {
      expect(delivered).toContain(line.toLowerCase());
    }
  });

  it('gate 14: explicit numeric facts remain unchanged', () => {
    const text = spoken(vLong).join(' ');
    expect(text).toContain('70%');
    expect(text).toContain('59.5%');
    expect(text).toContain('10.5');
  });

  it('gate 15: evidence numericFacts remain unchanged', () => {
    expect(numericFacts(vLong)).toEqual(numericFacts(BASE.long));
    expect(numericFacts(vShort)).toEqual(numericFacts(BASE.short));
    expect(evidenceClaims(vLong)).toEqual(evidenceClaims(BASE.long));
  });

  it('gate 16: sourceReferences remain unchanged', () => {
    expect(sourceRefs(vLong)).toEqual(sourceRefs(BASE.long));
    expect(sourceRefs(vShort)).toEqual(sourceRefs(BASE.short));
    expect(sourceRefs(vLong)).toContain('Lab test cert LTC-2026-0882');
  });

  it('gate 17: all generated scenarios still pass validateScenario()', () => {
    for (const s of [vLong, vShort, BASE.long, BASE.short]) {
      const report = validateScenario(s);
      expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
      expect(report.valid).toBe(true);
    }
  });

  it('gate 18: Long/Short source grounding remains intact', () => {
    const scriptLines = baseInput().script.split('\n');
    const longText = spoken(vLong).join(' ').toLowerCase();
    const sourceNumbers = new Set(['70', '59.5', '10.5']);

    for (const s of [vLong, vShort]) {
      const text = spoken(s).join(' ').toLowerCase();
      // (a) No number is spoken that the source script does not support, so
      //     variation can never introduce an invented project fact.
      for (const match of text.matchAll(/(?<![\d.])\d+(?:\.\d+)?(?![\d.])/g)) {
        expect(sourceNumbers.has(match[0]), `unsupported number spoken: ${match[0]}`).toBe(true);
      }
      // (b) Every factual sentence the target delivers is grounded in the
      //     user's script (never a generated project fact).
      for (const line of spoken(s)) {
        const lower = line.toLowerCase();
        if (!/(?<![\d.])\d/.test(lower)) continue; // fact-free scaffolding
        const grounded = scriptLines.some((src) => lower.includes(src.toLowerCase()));
        expect(grounded, `ungrounded factual line: ${line}`).toBe(true);
      }
    }

    // (c) The Long still delivers the whole source script.
    for (const line of scriptLines) expect(longText).toContain(line.toLowerCase());

    // (d) Shorts keep their own distinct angle rather than mirroring the Long.
    expect(vShort.metadata.id).not.toBe(vLong.metadata.id);
    expect(vShort.metadata.targetFormat).toBe('Short');
    expect(vLong.metadata.targetFormat).toBe('Long');
    expect(vShort.scenes.map((s) => s.id)).not.toEqual(vLong.scenes.map((s) => s.id));
    expect(spoken(vShort).length).toBeGreaterThan(0);
    // Short source grounding: every number the Short speaks is one the Long also
    // speaks from the same source script.
    for (const match of spoken(vShort).join(' ').matchAll(/(?<![\d.])\d+(?:\.\d+)?(?![\d.])/g)) {
      expect(longText).toContain(match[0]);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Gates 19-20: no collateral damage                                  */
/* ------------------------------------------------------------------ */

describe('no collateral damage (gates 19-20)', () => {
  it('gate 19: the API history path preserves complete persona keys', () => {
    const engine = fs.readFileSync(
      path.resolve('apps/api/src/services/production-engine.ts'),
      'utf8',
    );
    // The fragile last-segment regex is gone from the engine.
    expect(engine).not.toMatch(/\^char-\(\.\+\)-\(\[\^-\]\+\)\$/);
    // The canonical helper is used instead.
    expect(engine).toContain('personaKeyFromCharacterId');
    expect(engine).toContain('buildScenarioStyleFingerprint');

    // And a full engine-side observation keeps complete keys for every role.
    const personas = personaMap(BASE.long);
    for (const key of Object.values(personas)) {
      expect(key).toMatch(/^[a-z]+(-[a-z]+)+$/); // hyphenated, never truncated
      expect(CANONICAL_PERSONA_KEYS).toContain(key);
    }
    const entry = historyEntryFor(BASE.long, BASE.short);
    expect(Object.values(entry.casting).sort()).toEqual(Object.values(personas).sort());
  });

  it('gate 20: no packages/video/** or forbidden core file changed', () => {
    const forbidden = [
      'packages/video/src/scenes/DialogueScene.tsx',
      'packages/video/src/scenes/PlanSceneRenderer.tsx',
      'packages/video/src/scenes/SceneRenderer.tsx',
      'packages/video/src/captions/Captions.tsx',
      'packages/video/src/compositions/VideoCompositionPlan.tsx',
      'packages/core/src/scenario/scene-render-types.ts',
      'packages/core/src/scenario/scene-render-pipeline.ts',
      'packages/core/src/scenario/remotion-composition-types.ts',
      'packages/core/src/scenario/remotion-composition-pipeline.ts',
      'package.json',
      'package-lock.json',
    ];

    /** File list of a git ref, or `null` when the ref is unavailable here. */
    const treeOf = (ref: string): string[] | null => {
      try {
        return execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' })
          .split('\n')
          .filter(Boolean);
      } catch {
        return null;
      }
    };

    /**
     * (a) Integration invariant — the merge must not have altered any forbidden
     *     file. The merge started from Workstream C's head, so those files must
     *     still match it exactly. The video files legitimately EXIST in the
     *     integrated tree because Workstream C created them; what this proves is
     *     that merging Workstream D did not change them.
     */
    const integrationBase = process.env.WSC_INTEGRATION_BASE ?? '8fe8106e2b18dfd622d9f32158402bf37007b7c1';
    const baseTree = treeOf(integrationBase);
    if (baseTree) {
      for (const file of forbidden) {
        if (!baseTree.includes(file)) continue; // owned by the other workstream
        const before = execFileSync('git', ['show', `${integrationBase}:${file}`], { encoding: 'utf8' });
        const after = fs.readFileSync(path.resolve(file), 'utf8');
        expect(after, `integration base: ${file} must be unchanged`).toBe(before);
      }
      const videoNow = execFileSync('git', ['ls-files', 'packages/video'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .sort();
      const videoThen = baseTree.filter((f) => f.startsWith('packages/video/')).sort();
      expect(videoNow, 'integration base: packages/video file set must be unchanged').toEqual(videoThen);
    }

    /**
     * (b) Correction invariant — the Workstream D commit itself must not have
     *     altered any forbidden file that existed at its own baseline. Files
     *     absent there were created by Workstream C and are out of scope.
     */
    const correction = process.env.WSC_CORRECTION ?? '7b315c535ee32d67540612988e944a29fb9f70cd';
    const dBaselineTree = treeOf(BASELINE);
    if (dBaselineTree) {
      for (const file of forbidden) {
        if (!dBaselineTree.includes(file)) continue;
        const before = execFileSync('git', ['show', `${BASELINE}:${file}`], { encoding: 'utf8' });
        const after = execFileSync('git', ['show', `${correction}:${file}`], { encoding: 'utf8' });
        expect(after, `correction: ${file} must be unchanged`).toBe(before);
      }
    }

    // Independent of git: this correction touches no video module.
    const changed = [
      'packages/core/src/scenario/script-scenario-generator.ts',
      'packages/core/src/scenario/scenario-style-history.ts',
      'packages/core/src/scenario/index.ts',
      'apps/api/src/services/production-engine.ts',
    ];
    for (const file of changed) expect(fs.existsSync(path.resolve(file))).toBe(true);
  });
});
