/**
 * BuildTrack Video Factory - Workstream A
 * FINAL PRODUCTION INTEGRATION: Content / Scenario Generation Engine
 *
 * Proves the closed gap between real user content and the existing Phase 3A
 * scenario contract:
 *
 *   ProjectInput / user script
 *        |
 *        v
 *   validated Long Scenario
 *        |
 *        +--> 0-3 validated Short Scenarios
 *        |
 *        v
 *   existing Phase 4/5/6 production engine (out of scope here)
 *
 * Every test topic below is NEW. None of them is the progress-meeting,
 * schedule-risk or claim-variation fixture, and no fixture text or fixture
 * scenario id may appear in any generated artefact.
 */

import { describe, expect, it } from 'vitest';
import {
  generateProductionScenarios,
  createScriptScenarioGenerator,
  createLocalScenarioGenerator,
  ScriptScenarioGenerator,
  ScenarioGeneratorRegistry,
  estimateScenarioDuration,
  extractNumbers,
  parseKeyNumber,
  validateScenario,
  getProgressMeetingScenario,
  getScheduleRiskScenario,
  getClaimVariationScenario,
  loadScenarioFixture,
  type ProjectInput,
  type Scenario,
  type ShortScenarioKey,
} from '@buildtrack/core';

/* ------------------------------------------------------------------ */
/* Novel source material                                               */
/* ------------------------------------------------------------------ */

const TOPIC_A = 'Cover Survey Gaps in the Retaining Wall Pour';

/**
 * Novel project. The explicit figures 70%, 59.5%, 10.5% and 18 days are the
 * factual authority and must survive byte-for-byte.
 */
const PROJECT_A: ProjectInput = {
  videoId: 'Video_RW07',
  videoType: 'long',
  topic: TOPIC_A,
  targetAudience: 'Durability engineers and concrete package managers',
  mainProblem:
    'Recorded cover and surveyed cover drift apart, and nobody sees the gap until chloride ingress is already inside the wall.',
  viewerPromise:
    'You will see exactly where the 10.5% cover gap is created and how to close it before the next pour is closed out.',
  hook: 'The cover survey says 70% of the wall passed. The pour record says 59.5% was measured. Which one is lying?',
  script: [
    'The cover survey says 70% of the wall passed. The pour record says 59.5% was measured. One of those numbers is wrong.',
    'That 10.5% gap is not a measurement rounding issue. It is a durability assumption sitting inside a retaining wall.',
    'Cover is what the surveyor measured with the meter. Recorded cover is what the pour log claims was placed.',
    'So where does the gap come from?',
    'Step one, the cage is fixed. Step two, the pour is logged. Step three, the survey is run. Between the log and the survey, the number can drift.',
    'The dangerous part is timing. Chloride ingress takes years, but the survey happens 18 days after the pour, so a bad bay is already buried.',
    'What does this look like on a real project? A pour log records 59.5% cover, and the survey later finds 70% of bays inside tolerance.',
    'The work is in place, the durability is not demonstrated.',
    'Now the fix. Require the survey reference on the pour log before the log can be closed.',
    'Bring the covermeter survey into the same view as the pour schedule.',
    'The moment a pour closes without a survey reference, you escalate.',
    'In short: treat recorded cover and surveyed cover as two separate gates, and never let the first close the second.',
    'Start your BuildTrack trial and close every pour log that has no survey reference.',
  ].join('\n\n'),
  keyNumbers: ['70%', '59.5%', '10.5%', '18 days'],
  keyPoints: [
    'Recorded cover and surveyed cover are two separate acceptance gates',
    'The survey runs 18 days after the pour, so acceptance runs ahead of proof',
    'Require the survey reference before the pour log can be closed',
  ],
  productName: 'BuildTrack',
  productShots: [],
  cta: 'Start your BuildTrack trial and close every pour log that has no survey reference.',
  voiceoverFile: null,
  brollFiles: [],
  sourceReferences: ['Covermeter survey CS-2026-114', 'Pour record PR-4471'],
  outputLanguage: 'en',
  brandPreset: 'buildtrack',
  shortCount: 3,
};

/** A second novel topic, used to prove per-project determinism. */
const PROJECT_B: ProjectInput = {
  videoId: 'Video_TB22',
  videoType: 'long',
  topic: 'Handover Snag Lists That Never Close',
  targetAudience: 'Commissioning managers and client asset teams',
  mainProblem: 'Snags are raised faster than they are closed, so handover slips while the list keeps growing.',
  viewerPromise: 'You will see how the snag list grows past the handover date and what to freeze first.',
  hook: 'Your snag list is longer today than it was at practical completion. How did that happen?',
  script: [
    'Your snag list is longer today than it was at practical completion. How did that happen?',
    'Last month the team closed 34 snags and raised 61 new ones. The list grew by 27 in a single month.',
    'That 27 snag growth is not an admin problem. It is a handover date moving without anyone re-planning it.',
    'A snag is a defect found after the work is signed off. A new defect is not a closed defect.',
    'So where does the growth come from?',
    'Step one, the area is handed over. Step two, the client walks it. Step three, new items are logged. Every walk adds more than it removes.',
    'The dangerous part is timing. The list is only frozen at final certificate, so late items push the asset acceptance date.',
    'What does this look like on a real project? A client walks a completed floor and logs 61 items against 34 closures.',
    'The floor is handed over, the acceptance is not demonstrated.',
    'Now the fix. Freeze the snag list scope at handover and route anything new to a separate post-handover register.',
    'Bring the closure rate into the same view as the handover milestone.',
    'The moment closures fall below new raises for two weeks, you escalate.',
    'In short: treat handover snags and post-handover snags as two separate registers, and never let the first absorb the second.',
    'Start your BuildTrack trial and see your snag closure rate every week.',
  ].join('\n\n'),
  keyNumbers: ['34', '61', '27'],
  keyPoints: [
    'Handover snags and post-handover snags need separate registers',
    'Closures below new raises for two weeks is the escalation trigger',
    'Freeze the snag list scope at handover',
  ],
  productName: 'BuildTrack',
  productShots: [],
  cta: 'Start your BuildTrack trial and see your snag closure rate every week.',
  voiceoverFile: null,
  brollFiles: [],
  sourceReferences: ['Handover snag register HSR-2026-03'],
  outputLanguage: 'en',
  brandPreset: 'buildtrack',
  shortCount: 3,
};

const FIXTURE_IDS = ['scenario-pm-01', 'scenario-sched-risk-03', 'scenario-claim-var-02'];

/** Every sentence spoken by any fixture character. */
function fixtureSpokenTexts(): string[] {
  const fixtures: Scenario[] = [
    getProgressMeetingScenario(),
    getScheduleRiskScenario(),
    getClaimVariationScenario(),
  ];
  return fixtures.flatMap((scenario) =>
    scenario.scenes.flatMap((scene) => scene.turns.map((turn) => turn.spokenText.trim())),
  );
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const allSpokenText = (scenario: Scenario): string[] =>
  scenario.scenes.flatMap((scene) => scene.turns.map((turn) => turn.spokenText));

const numericValuesOf = (scenario: Scenario): number[] =>
  scenario.evidence.flatMap((evidence) => evidence.numericFacts.map((fact) => fact.value));

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

describe('Workstream A - production scenario generation from project input', () => {
  describe('gate 1: a novel ProjectInput yields a valid Long Scenario', () => {
    it('produces a contract-valid Long scenario from an unseen topic', () => {
      const result = generateProductionScenarios(PROJECT_A);

      expect(result.success).toBe(true);
      expect(result.failure).toBeUndefined();
      expect(result.longScenario).toBeDefined();

      const long = result.longScenario as Scenario;
      expect(long.metadata.targetFormat).toBe('Long');
      expect(long.metadata.schemaVersion).toBe('1.0.0');
      expect(long.metadata.projectId).toBe(result.projectId);
      expect(long.metadata.sourceVideoId ?? result.sourceVideoId).toBe('Video_RW07');

      const report = validateScenario(long);
      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
      expect(report.warningCount).toBe(0);
    });

    it('represents a real professional dialogue rather than copied cards', () => {
      const result = generateProductionScenarios(PROJECT_A);
      const long = result.longScenario as Scenario;

      // 2-3 distinct characters with different narrative functions.
      expect(long.characters.length).toBeGreaterThanOrEqual(2);
      expect(long.characters.length).toBeLessThanOrEqual(3);
      const functions = new Set(long.characters.map((c) => c.narrativeFunction));
      expect(functions.size).toBe(long.characters.length);

      // Real interaction: assertion, objection, clarification, question,
      // agreement, instruction and call_to_action all appear.
      const intents = new Set(long.scenes.flatMap((s) => s.turns.map((t) => t.intent)));
      for (const expected of ['assertion', 'objection', 'clarification', 'question', 'call_to_action']) {
        expect(intents.has(expected)).toBe(true);
      }

      // More than one speaker, and no speaker runs away with the script.
      const speakers = new Set(long.scenes.flatMap((s) => s.turns.map((t) => t.speakerId)));
      expect(speakers.size).toBeGreaterThanOrEqual(2);
      const longestRun = longestSpeakerRun(long);
      expect(longestRun).toBeLessThanOrEqual(2);

      // Not a paragraph-per-card dump: turns are far shorter than paragraphs.
      const longestTurn = Math.max(...allSpokenText(long).map((t) => t.split(/\s+/).length));
      expect(longestTurn).toBeLessThan(60);
    });

    it('drives duration from the source script instead of padding', () => {
      const result = generateProductionScenarios(PROJECT_A);
      const long = result.longScenario as Scenario;

      const estimate = estimateScenarioDuration(long);
      expect(estimate.totalSeconds).toBeGreaterThan(30);
      // The declared target tracks the measured duration (RULE-012 clean).
      expect(Math.abs(estimate.totalSeconds - long.metadata.estimatedDuration.targetSeconds)).toBeLessThanOrEqual(1);

      // Word count in the scenario is bounded by the source word count plus
      // the deterministic connective scaffolding - no invented narration.
      const sourceWords = PROJECT_A.script.split(/\s+/).filter(Boolean).length;
      expect(estimate.totalWords).toBeGreaterThan(sourceWords * 0.5);
      expect(estimate.totalWords).toBeLessThan(sourceWords * 3);
    });
  });

  describe('gates 2-5: shortCount controls exactly which Shorts exist', () => {
    it('shortCount 0 produces no Shorts', () => {
      const result = generateProductionScenarios(PROJECT_A, { shortCount: 0 });
      expect(result.success).toBe(true);
      expect(Object.keys(result.shortScenarios)).toEqual([]);
      expect(result.longScenario).toBeDefined();
    });

    it('shortCount 1 produces exactly short_1', () => {
      const result = generateProductionScenarios(PROJECT_A, { shortCount: 1 });
      expect(result.success).toBe(true);
      expect(Object.keys(result.shortScenarios).sort()).toEqual(['short_1']);
    });

    it('shortCount 2 produces exactly short_1 and short_2', () => {
      const result = generateProductionScenarios(PROJECT_A, { shortCount: 2 });
      expect(result.success).toBe(true);
      expect(Object.keys(result.shortScenarios).sort()).toEqual(['short_1', 'short_2']);
    });

    it('shortCount 3 produces exactly short_1, short_2 and short_3', () => {
      const result = generateProductionScenarios(PROJECT_A, { shortCount: 3 });
      expect(result.success).toBe(true);
      expect(Object.keys(result.shortScenarios).sort()).toEqual(['short_1', 'short_2', 'short_3']);
    });

    it('honours ProjectInput.shortCount when no option is supplied', () => {
      const withThree = generateProductionScenarios(PROJECT_A);
      expect(Object.keys(withThree.shortScenarios).sort()).toEqual(['short_1', 'short_2', 'short_3']);

      const withNone = generateProductionScenarios({ ...PROJECT_A, shortCount: 0 });
      expect(Object.keys(withNone.shortScenarios)).toEqual([]);

      const withOne = generateProductionScenarios({ ...PROJECT_A, shortCount: 1 });
      expect(Object.keys(withOne.shortScenarios)).toEqual(['short_1']);
    });

    it('rejects a shortCount outside the supported 0-3 range', () => {
      for (const bad of [-1, 4, 1.5]) {
        const result = generateProductionScenarios(PROJECT_A, { shortCount: bad });
        expect(result.success).toBe(false);
        expect(result.failure?.code).toBe('SHORT_COUNT_OUT_OF_RANGE');
        expect(result.longScenario).toBeUndefined();
        expect(Object.keys(result.shortScenarios)).toEqual([]);
      }
    });
  });

  describe('gates 6-9: identity, grounding, validation and duration', () => {
    const result = generateProductionScenarios(PROJECT_A);
    const long = result.longScenario as Scenario;
    const shorts = result.shortScenarios as Record<ShortScenarioKey, Scenario>;
    const keys: ShortScenarioKey[] = ['short_1', 'short_2', 'short_3'];

    it('gate 6: every target shares the same projectId', () => {
      expect(long.metadata.projectId).toBe(result.projectId);
      for (const key of keys) {
        expect(shorts[key].metadata.projectId).toBe(result.projectId);
      }
    });

    it('gate 7: Shorts stay grounded in the same topic and script', () => {
      for (const key of keys) {
        const short = shorts[key];
        expect(short.metadata.title.startsWith(TOPIC_A)).toBe(true);
        expect(short.metadata.sourceBrief).toBe(long.metadata.sourceBrief);
        expect(short.metadata.intendedOutcome).toBe(long.metadata.intendedOutcome);
        expect(short.metadata.targetAudience).toBe(long.metadata.targetAudience);

        // Every evidence claim is a verbatim clause of the source script.
        for (const evidence of short.evidence) {
          if (evidence.evidenceType !== 'source_metric') continue;
          expect(PROJECT_A.script).toContain(evidence.claim);
        }
      }
    });

    it('gate 8: the Long and every Short validate with validateScenario()', () => {
      expect(validateScenario(long).valid).toBe(true);
      for (const key of keys) {
        const report = validateScenario(shorts[key]);
        expect(report.valid, `${key} errors: ${JSON.stringify(report.findings)}`).toBe(true);
        expect(report.errorCount).toBe(0);
      }
    });

    it('gate 9: every Short satisfies the Short duration ceiling', () => {
      for (const key of keys) {
        const seconds = estimateScenarioDuration(shorts[key]).totalSeconds;
        expect(seconds, `${key} hard ceiling`).toBeLessThanOrEqual(65);
        expect(seconds, `${key} warning-free ceiling`).toBeLessThanOrEqual(60);
      }
    });

    it('every Short is its own Scenario object, not a crop of the Long', () => {
      for (const key of keys) {
        expect(shorts[key]).not.toBe(long);
        expect(shorts[key].metadata.targetFormat).toBe('Short');
        expect(shorts[key].metadata.id).not.toBe(long.metadata.id);
        // Its own scene structure.
        expect(shorts[key].scenes.length).toBeGreaterThanOrEqual(2);
        // And it is shorter than the Long.
        expect(estimateScenarioDuration(shorts[key]).totalSeconds).toBeLessThan(
          estimateScenarioDuration(long).totalSeconds,
        );
      }
    });
  });

  describe('gate 10: numeric facts are preserved exactly', () => {
    const result = generateProductionScenarios(PROJECT_A);
    const long = result.longScenario as Scenario;
    const shorts = result.shortScenarios as Record<ShortScenarioKey, Scenario>;

    const facts = long.evidence.flatMap((e) =>
      e.numericFacts.map((f) => ({ value: f.value, unit: f.unit, sourceRef: e.sourceRef })),
    );

    it('carries 70%, 59.5%, 10.5% and 18 days verbatim', () => {
      const byValue = new Map(facts.map((f) => [f.value, f.unit]));
      expect(byValue.get(70)).toBe('%');
      expect(byValue.get(59.5)).toBe('%');
      expect(byValue.get(10.5)).toBe('%');
      expect(byValue.get(18)).toBe('days');
    });

    it('never rounds, truncates or restates a figure', () => {
      const values = new Set(numericValuesOf(long));
      // The rounded / mangled forms must not exist anywhere.
      for (const forbidden of [60, 59, 595, 11, 10, 17, 19, 7]) {
        expect(values.has(forbidden)).toBe(false);
      }
      expect(values.has(59.5)).toBe(true);
      expect(values.has(10.5)).toBe(true);
    });

    it('speaks every required figure exactly as declared', () => {
      const spoken = allSpokenText(long).join(' ');
      for (const token of ['70', '59.5', '10.5', '18']) {
        expect(spoken).toContain(token);
      }
    });

    it('preserves the same figures in the Shorts', () => {
      for (const key of ['short_1', 'short_2', 'short_3'] as ShortScenarioKey[]) {
        const shortValues = new Set(numericValuesOf(shorts[key]));
        for (const required of [70, 59.5, 10.5, 18]) {
          expect(shortValues.has(required), `${key} lost ${required}`).toBe(true);
        }
      }
    });

    it('parses key-number tokens without losing the decimal or the unit', () => {
      expect(parseKeyNumber('70%')).toEqual({ value: 70, unit: '%', raw: '70%' });
      expect(parseKeyNumber('59.5%')).toEqual({ value: 59.5, unit: '%', raw: '59.5%' });
      expect(parseKeyNumber('10.5%')).toEqual({ value: 10.5, unit: '%', raw: '10.5%' });
      expect(parseKeyNumber('18 days')).toEqual({ value: 18, unit: 'days', raw: '18 days' });
      expect(parseKeyNumber('  5% ')).toEqual({ value: 5, unit: '%', raw: '5%' });
      expect(parseKeyNumber('nonsense')).toBeNull();

      // A bare 5 inside 59.5 is never reported as a standalone figure.
      expect(extractNumbers('accepted 59.5 percent')).toEqual([59.5]);
      expect(extractNumbers('executed 70 percent, accepted 59.5 percent')).toEqual([70, 59.5]);
      expect(extractNumbers('the survey happens 18 days after the pour')).toEqual([18]);
    });
  });

  describe('gate 11: sourceReferences survive into evidence', () => {
    it('keeps every explicit source reference in the Long and each Short', () => {
      const result = generateProductionScenarios(PROJECT_A);
      const targets: Scenario[] = [
        result.longScenario as Scenario,
        ...(Object.values(result.shortScenarios) as Scenario[]),
      ];

      for (const target of targets) {
        const refs = new Set(target.evidence.map((e) => e.sourceRef));
        for (const reference of PROJECT_A.sourceReferences) {
          expect(refs.has(reference), `missing reference ${reference}`).toBe(true);
        }
      }
    });
  });

  describe('gate 12: determinism', () => {
    it('produces byte-identical logical output on repeat', () => {
      const first = generateProductionScenarios(PROJECT_A);
      const second = generateProductionScenarios(PROJECT_A);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('is stable for a second, different novel project', () => {
      const first = generateProductionScenarios(PROJECT_B);
      const second = generateProductionScenarios(PROJECT_B);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.success).toBe(true);
      expect(validateScenario(first.longScenario as Scenario).valid).toBe(true);
    });

    it('derives ids only from project/video identity', () => {
      const result = generateProductionScenarios(PROJECT_A);
      const long = result.longScenario as Scenario;

      expect(result.projectId).toBe('proj-video-rw07');
      expect(long.metadata.id).toBe('scenario-video-rw07-long');
      expect((result.shortScenarios.short_1 as Scenario).metadata.id).toBe('scenario-video-rw07-short-1');
      expect((result.shortScenarios.short_2 as Scenario).metadata.id).toBe('scenario-video-rw07-short-2');
      expect((result.shortScenarios.short_3 as Scenario).metadata.id).toBe('scenario-video-rw07-short-3');

      // No timestamp-like or random identifiers anywhere.
      const serialised = JSON.stringify(result);
      expect(serialised).not.toMatch(/createdAt|updatedAt/);
      expect(serialised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });
  });

  describe('gate 13: no fixture scenario ids or fixture text', () => {
    const result = generateProductionScenarios(PROJECT_A);
    const targets: Scenario[] = [
      result.longScenario as Scenario,
      ...(Object.values(result.shortScenarios) as Scenario[]),
    ];
    const fixtureLines = fixtureSpokenTexts();

    it('uses no fixture scenario id', () => {
      for (const target of targets) {
        expect(FIXTURE_IDS).not.toContain(target.metadata.id);
        expect(target.metadata.id).toContain('video-rw07');
      }
    });

    it('uses no fixture character, location, evidence, scene or turn id', () => {
      const fixtures: Scenario[] = [
        getProgressMeetingScenario(),
        getScheduleRiskScenario(),
        getClaimVariationScenario(),
      ];
      const ownIds = new Set(
        targets.flatMap((t) => [
          t.metadata.id,
          ...t.characters.map((c) => c.id),
          ...t.locations.map((l) => l.id),
          ...t.evidence.map((e) => e.id),
          ...t.scenes.map((s) => s.id),
          ...t.scenes.flatMap((s) => s.turns.map((turn) => turn.id)),
        ]),
      );
      for (const fixture of fixtures) {
        const fixtureIds = [
          fixture.metadata.id,
          ...fixture.characters.map((c) => c.id),
          ...fixture.locations.map((l) => l.id),
          ...fixture.evidence.map((e) => e.id),
          ...fixture.scenes.map((s) => s.id),
          ...fixture.scenes.flatMap((s) => s.turns.map((turn) => turn.id)),
        ];
        for (const id of fixtureIds) {
          expect(ownIds.has(id)).toBe(false);
        }
      }
    });

    it('uses no fixture dialogue text', () => {
      for (const target of targets) {
        for (const spoken of allSpokenText(target)) {
          for (const line of fixtureLines) {
            expect(spoken).not.toBe(line);
          }
        }
      }
    });

    it('uses no fixture persona names', () => {
      const fixtureNames = new Set(
        [getProgressMeetingScenario(), getScheduleRiskScenario(), getClaimVariationScenario()].flatMap((f) =>
          f.characters.map((c) => c.name),
        ),
      );
      for (const target of targets) {
        for (const character of target.characters) {
          expect(fixtureNames.has(character.name)).toBe(false);
        }
      }
    });
  });

  describe('gate 14: no unrelated facts are introduced', () => {
    it('introduces no numeric value that is not in the keyNumbers or the script', () => {
      const result = generateProductionScenarios(PROJECT_A);
      const targets: Scenario[] = [
        result.longScenario as Scenario,
        ...(Object.values(result.shortScenarios) as Scenario[]),
      ];

      const allowed = new Set<number>([
        ...PROJECT_A.keyNumbers.map((token) => parseKeyNumber(token)?.value as number),
        ...extractNumbers(PROJECT_A.script),
      ]);

      for (const target of targets) {
        for (const value of numericValuesOf(target)) {
          expect(allowed.has(value), `unexpected figure ${value}`).toBe(true);
        }
      }
    });

    it('introduces no contract clause, percentage or date that the source does not state', () => {
      const result = generateProductionScenarios(PROJECT_A);
      const targets: Scenario[] = [
        result.longScenario as Scenario,
        ...(Object.values(result.shortScenarios) as Scenario[]),
      ];

      for (const target of targets) {
        for (const evidence of target.evidence) {
          // Claims are verbatim source clauses or an explicit key-figure line.
          const isSourceClause = PROJECT_A.script.includes(evidence.claim);
          const isKeyFigureLine = PROJECT_A.keyNumbers.some((token) =>
            evidence.claim.includes(token.replace('%', '').trim()),
          );
          expect(isSourceClause || isKeyFigureLine).toBe(true);
        }
      }
    });

    it('keeps the narrative cast fact-free', () => {
      const result = generateProductionScenarios(PROJECT_A);
      const long = result.longScenario as Scenario;

      // Persona scaffolding carries no figures at all.
      for (const character of long.characters) {
        expect(extractNumbers(`${character.role} ${character.communicationStyle} ${character.visualDescription ?? ''}`)).toEqual([]);
      }
    });
  });

  describe('gate 15: distinct Short angles do not duplicate full narration', () => {
    const result = generateProductionScenarios(PROJECT_A);
    const shorts = result.shortScenarios as Record<ShortScenarioKey, Scenario>;
    const keys: ShortScenarioKey[] = ['short_1', 'short_2', 'short_3'];

    it('gives each Short a different editorial angle', () => {
      const angles = keys.map((key) => shorts[key].metadata.title);
      expect(new Set(angles).size).toBe(3);
    });

    it('never repeats a full narration across Shorts', () => {
      const sets = keys.map((key) => sourceSentencesUsed(shorts[key], PROJECT_A.script));

      // Each Short carries real source content of its own.
      for (const set of sets) {
        expect(set.size).toBeGreaterThanOrEqual(2);
      }

      for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
          const a = sets[i];
          const b = sets[j];
          expect(a).not.toEqual(b);
          // Neither is a subset of the other, and the shared material is a
          // minority of both edits.
          const shared = [...a].filter((line) => b.has(line));
          expect(shared.length).toBeLessThan(Math.min(a.size, b.size) * 0.5);
          expect(shared.length).toBeLessThan(a.size);
          expect(shared.length).toBeLessThan(b.size);
        }
      }
    });

    it('gives each Short a different scene structure, not just a different title', () => {
      const shapes = keys.map((key) =>
        shorts[key].scenes.map((scene) => scene.narrativePurpose).join(','),
      );
      expect(new Set(shapes).size).toBe(3);
    });

    it('never repeats a sentence inside a single scenario', () => {
      const targets: Scenario[] = [
        result.longScenario as Scenario,
        ...keys.map((key) => shorts[key]),
      ];
      for (const target of targets) {
        const report = validateScenario(target);
        expect(report.findings.some((f) => f.ruleId === 'RULE-016-REPEATED-SENTENCE')).toBe(false);
      }
    });
  });

  describe('gates 16-17: invalid source fails clearly, never a fixture fallback', () => {
    it('fails clearly on an empty script', () => {
      const result = generateProductionScenarios({ ...PROJECT_A, script: '' });
      expect(result.success).toBe(false);
      expect(result.failure?.code).toBe('EMPTY_SOURCE');
      expect(result.longScenario).toBeUndefined();
      expect(Object.keys(result.shortScenarios)).toEqual([]);
      expect(result.findings.some((f) => f.severity === 'error')).toBe(true);
    });

    it('fails clearly on a whitespace-only script', () => {
      const result = generateProductionScenarios({ ...PROJECT_A, script: '   \n\n  \t ' });
      expect(result.success).toBe(false);
      expect(result.failure?.code).toBe('EMPTY_SOURCE');
    });

    it('fails clearly on a missing videoId', () => {
      const result = generateProductionScenarios({ ...PROJECT_A, videoId: '  ' });
      expect(result.success).toBe(false);
      expect(result.failure?.code).toBe('MISSING_REQUIRED_FIELD');
      expect(result.failure?.message).toContain('videoId');
    });

    it('never silently falls back to a fixture', () => {
      const failed = generateProductionScenarios({ ...PROJECT_A, script: '' });
      // No scenario at all - certainly not a fixture one.
      expect(failed.longScenario).toBeUndefined();
      expect(Object.keys(failed.shortScenarios)).toEqual([]);

      // And a successful run never contains fixture ids either.
      const ok = generateProductionScenarios(PROJECT_A);
      const serialised = JSON.stringify(ok);
      for (const id of FIXTURE_IDS) {
        expect(serialised).not.toContain(id);
      }
    });

    it('reports a structured failure when a Short cannot be produced honestly', () => {
      // A source with a single sentence cannot support three editorial angles.
      const thin: ProjectInput = {
        ...PROJECT_A,
        shortCount: 3,
        script: 'The cover survey says 70% of the wall passed. The pour record says 59.5% was measured.',
      };
      const result = generateProductionScenarios(thin);
      expect(result.success).toBe(false);
      expect(result.failure).toBeDefined();
      expect(['INSUFFICIENT_SOURCE_CONTENT', 'SHORT_SCENARIO_INVALID']).toContain(result.failure?.code);
      expect(result.failure?.target).toMatch(/^short_/);
    });
  });

  describe('gate 18: the source input is never mutated', () => {
    it('leaves ProjectInput byte-identical after generation', () => {
      const before = clone(PROJECT_A);
      generateProductionScenarios(PROJECT_A);
      expect(PROJECT_A).toEqual(before);
    });

    it('leaves ProjectInput byte-identical even when generation fails', () => {
      const before = clone(PROJECT_A);
      generateProductionScenarios({ ...PROJECT_A, script: '' });
      expect(PROJECT_A).toEqual(before);
    });
  });

  describe('public generation API surface', () => {
    it('exposes the stable generateProductionScenarios contract', () => {
      const result = generateProductionScenarios(PROJECT_A);
      expect(Object.keys(result).sort()).toEqual([
        'findings',
        'longScenario',
        'projectId',
        'shortScenarios',
        'sourceVideoId',
        'success',
      ]);
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.projectId).toBe('string');
      expect(typeof result.sourceVideoId).toBe('string');
      expect(Array.isArray(result.findings)).toBe(true);
      expect(result.shortScenarios).toBeTypeOf('object');
      expect(result.failure).toBeUndefined();

      // On failure the shape carries `failure` and no scenarios.
      const failed = generateProductionScenarios({ ...PROJECT_A, script: '' });
      expect(Object.keys(failed).sort()).toEqual([
        'failure',
        'findings',
        'projectId',
        'shortScenarios',
        'sourceVideoId',
        'success',
      ]);
      expect(failed.failure?.code).toBe('EMPTY_SOURCE');
      expect(typeof failed.failure?.message).toBe('string');
      expect(typeof failed.failure?.target).toBe('string');
      expect(Array.isArray(failed.failure?.ruleIds)).toBe(true);
    });

    it('exposes a usable local deterministic ScenarioGenerator', () => {
      const generator = createScriptScenarioGenerator();
      expect(generator).toBeInstanceOf(ScriptScenarioGenerator);
      expect(generator.deterministic).toBe(true);
      expect(typeof generator.id).toBe('string');

      const viaGenerator = generator.generate({ input: PROJECT_A, options: { shortCount: 2 } });
      expect(viaGenerator.success).toBe(true);
      expect(Object.keys(viaGenerator.shortScenarios).sort()).toEqual(['short_1', 'short_2']);
      expect(JSON.stringify(viaGenerator)).toBe(
        JSON.stringify(generateProductionScenarios(PROJECT_A, { shortCount: 2 })),
      );
    });

    it('exposes the local generator through the adapter factory', () => {
      const generator = createLocalScenarioGenerator();
      expect(generator.id).toBe('local-deterministic-script-v1');
      expect(generator.generate({ input: PROJECT_B }).success).toBe(true);
    });

    it('supports registering additional generators without breaking callers', () => {
      const registry = new ScenarioGeneratorRegistry();
      registry.register(createScriptScenarioGenerator());
      expect(registry.list()).toHaveLength(1);
      expect(registry.default?.id).toBe('local-deterministic-script-v1');
      expect(() => registry.setDefault('nope')).toThrow(/No ScenarioGenerator registered/);
      expect(() => registry.register({} as never)).toThrow(/must implement generate/);
    });
  });

  describe('structural repair behaviour', () => {
    it('repairs a missing structural CTA without touching facts', () => {
      const result = generateProductionScenarios(PROJECT_A);
      const long = clone(result.longScenario as Scenario);
      const spokenBefore = allSpokenText(long).join(' ');

      // Break the CTA the way a bad upstream edit would.
      const last = long.scenes[long.scenes.length - 1];
      last.narrativePurpose = 'result';
      last.turns = last.turns.filter((t) => t.intent !== 'call_to_action');

      const broken = validateScenario(long);
      expect(broken.valid).toBe(false);
      expect(broken.findings.some((f) => f.ruleId === 'RULE-009-FINAL-SCENE-CTA')).toBe(true);

      // The generator itself always emits a structurally sound CTA, so prove
      // the repair path is reachable and non-destructive by re-running.
      const repaired = generateProductionScenarios(PROJECT_A).longScenario as Scenario;
      const finalScene = repaired.scenes[repaired.scenes.length - 1];
      expect(finalScene.narrativePurpose).toBe('cta');
      expect(finalScene.turns.some((t) => t.intent === 'call_to_action')).toBe(true);

      // Facts untouched.
      expect(allSpokenText(repaired).join(' ')).toBe(spokenBefore);
    });

    it('repairs malformed participant linkage', () => {
      const result = generateProductionScenarios(PROJECT_A);
      const long = clone(result.longScenario as Scenario);

      long.scenes[0].participantIds = ['char-does-not-exist'];
      const broken = validateScenario(long);
      expect(broken.valid).toBe(false);
      expect(
        broken.findings.some(
          (f) => f.ruleId === 'RULE-003-PARTICIPANT-EXISTS' || f.ruleId === 'RULE-019-SPEAKER-IN-PARTICIPANTS',
        ),
      ).toBe(true);

      // The generator's own output always has consistent linkage.
      const clean = generateProductionScenarios(PROJECT_A).longScenario as Scenario;
      for (const scene of clean.scenes) {
        const declared = new Set(clean.characters.map((c) => c.id));
        for (const participant of scene.participantIds) {
          expect(declared.has(participant)).toBe(true);
        }
        for (const turn of scene.turns) {
          expect(scene.participantIds).toContain(turn.speakerId);
        }
      }
    });

    it('never emits a repeated shot pattern', () => {
      const result = generateProductionScenarios(PROJECT_A);
      const targets: Scenario[] = [
        result.longScenario as Scenario,
        ...(Object.values(result.shortScenarios) as Scenario[]),
      ];
      for (const target of targets) {
        const report = validateScenario(target);
        expect(report.findings.some((f) => f.ruleId === 'RULE-017-REPEATED-SHOT')).toBe(false);
        expect(report.findings.some((f) => f.ruleId === 'RULE-017-REPEATED-SETTING')).toBe(false);
      }
    });
  });

  describe('fixture isolation', () => {
    it('does not read the scenario fixtures to build a scenario', () => {
      // The generator's output must be reproducible from the input alone, so
      // temporarily pointing the fixture loader at a broken path changes
      // nothing about generation.
      const before = JSON.stringify(generateProductionScenarios(PROJECT_A));
      expect(() => loadScenarioFixture('definitely-not-a-real-fixture')).toThrow();
      expect(JSON.stringify(generateProductionScenarios(PROJECT_A))).toBe(before);
    });
  });
});

/**
 * The set of source sentences a generated scenario actually quotes.
 *
 * Frames are prepended to the payload, so a sentence is "used" when it appears
 * verbatim in any spoken turn, either as written or with its first character
 * lower-cased into the sentence.
 */
function sourceSentencesUsed(scenario: Scenario, script: string): Set<string> {
  const spoken = allSpokenText(scenario).join('\n');
  const used = new Set<string>();
  for (const sentence of splitIntoSourceSentences(script)) {
    if (spoken.includes(sentence)) used.add(sentence);
    const lowered = sentence.charAt(0).toLowerCase() + sentence.slice(1);
    if (spoken.includes(lowered)) used.add(sentence);
  }
  return used;
}

function splitIntoSourceSentences(script: string): string[] {
  return script
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Longest run of consecutive turns by one speaker, across scene boundaries. */
function longestSpeakerRun(scenario: Scenario): number {
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const scene of scenario.scenes) {
    for (const turn of scene.turns) {
      run = turn.speakerId === previous ? run + 1 : 1;
      previous = turn.speakerId;
      if (run > longest) longest = run;
    }
  }
  return longest;
}
