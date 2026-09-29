/**
 * BuildTrack Video Factory - Phase 3A Scenario Contract & Engine Test Suite
 *
 * Validates the canonical scenario data contract, deterministic validator,
 * duration estimator, anti-repetition diversity analyzer, and realistic fixtures.
 */

import { describe, it, expect } from 'vitest';
import {
  SCENARIO_SCHEMA_VERSION,
  Scenario,
  validateScenario,
  estimateScenarioDuration,
  estimateTurnDuration,
  estimateSceneDuration,
  analyzeScenarioDiversity,
  getProgressMeetingScenario,
  getClaimVariationScenario,
  getScheduleRiskScenario,
  loadScenarioFixture,
} from '@buildtrack/core';

describe('Phase 3A - Scenario Contract & Deterministic Engine', () => {
  describe('Canonical Fixtures Validation', () => {
    it('1. accepts the Progress Meeting fixture without errors', () => {
      const scenario = getProgressMeetingScenario();
      const report = validateScenario(scenario);

      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
      expect(report.summary.totalScenes).toBe(5);
      expect(report.summary.totalCharacters).toBe(3);
      expect(report.summary.totalEvidence).toBe(2);
      expect(report.summary.targetFormat).toBe('Long');
    });

    it('2. accepts the Claim & Variation fixture without errors', () => {
      const scenario = getClaimVariationScenario();
      const report = validateScenario(scenario);

      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
      expect(report.summary.totalScenes).toBe(4);
      expect(report.summary.totalCharacters).toBe(2);
      expect(report.summary.totalEvidence).toBe(2);
      expect(report.summary.targetFormat).toBe('Long');
    });

    it('3. accepts the Schedule Risk Short fixture without errors', () => {
      const scenario = getScheduleRiskScenario();
      const report = validateScenario(scenario);

      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
      expect(report.summary.totalScenes).toBe(3);
      expect(report.summary.totalCharacters).toBe(3);
      expect(report.summary.targetFormat).toBe('Short');
      expect(report.summary.estimatedDuration).toBeLessThanOrEqual(60);
    });

    it('4. confirms all three fixtures are structurally and narratively distinct', () => {
      const pm = getProgressMeetingScenario();
      const cv = getClaimVariationScenario();
      const sr = getScheduleRiskScenario();

      // Distinct target formats and lengths
      expect(sr.metadata.targetFormat).toBe('Short');
      expect(pm.metadata.targetFormat).toBe('Long');
      expect(cv.metadata.targetFormat).toBe('Long');

      // Distinct character counts
      expect(pm.characters.length).toBe(3);
      expect(cv.characters.length).toBe(2);
      expect(sr.characters.length).toBe(3);

      // Distinct character IDs and professional roles
      const pmRoles = pm.characters.map(c => c.role);
      const cvRoles = cv.characters.map(c => c.role);
      const srRoles = sr.characters.map(c => c.role);
      expect(pmRoles).toContain('Senior Site Engineer');
      expect(cvRoles).toContain('Employer\'s Agent & Lead Consultant');
      expect(srRoles).toContain('Lead Planning Engineer');

      // Distinct settings
      expect(pm.locations[0].settingType).toBe('progress_meeting');
      expect(cv.locations[0].settingType).toBe('commercial_meeting');
      expect(sr.locations[0].settingType).toBe('planning_review');

      // Distinct evidence types
      const pmEvTypes = pm.evidence.map(e => e.evidenceType);
      const cvEvTypes = cv.evidence.map(e => e.evidenceType);
      const srEvTypes = sr.evidence.map(e => e.evidenceType);
      expect(pmEvTypes).toContain('quality_audit');
      expect(cvEvTypes).toContain('site_inspection');
      expect(srEvTypes).toContain('schedule_metric');

      // Distinct production camera movements
      const pmShots = pm.scenes.map(s => s.production.shotType);
      const cvShots = cv.scenes.map(s => s.production.shotType);
      expect(pmShots).toContain('wide');
      expect(cvShots).toContain('over_the_shoulder');
    });
  });

  describe('Integrity & Reference Rejection Rules', () => {
    it('5. rejects non-existent speaker references', () => {
      const scenario = getProgressMeetingScenario();
      scenario.scenes[0].turns[0].speakerId = 'char-ghost-speaker';

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-003-SPEAKER-EXISTS');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
      expect(finding?.message).toContain('char-ghost-speaker');
    });

    it('6. rejects speakers who are not included in scene.participantIds', () => {
      const scenario = getProgressMeetingScenario();
      // Scene 0 has participants Sarah and Marcus; inject David as speaker without adding him to participants
      scenario.scenes[0].turns.push({
        id: 'turn-intruder',
        speakerId: 'char-david-site',
        spokenText: 'I am speaking without being in the room participants list.',
        intent: 'objection',
      });

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-019-SPEAKER-IN-PARTICIPANTS');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
    });

    it('7. rejects non-existent evidence references', () => {
      const scenario = getProgressMeetingScenario();
      scenario.scenes[1].turns[0].evidenceId = 'ev-phantom-doc';

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-004-EVIDENCE-REF');
      expect(finding).toBeDefined();
      expect(finding?.message).toContain('ev-phantom-doc');
    });

    it('8. rejects duplicate character IDs', () => {
      const scenario = getProgressMeetingScenario();
      scenario.characters.push({
        id: scenario.characters[0].id,
        name: 'Clone Persona',
        role: 'Duplicate Engineer',
        narrativeFunction: 'advocate',
        communicationStyle: 'Identical clone',
      });

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-002-UNIQUE-IDS' && f.message.includes('Duplicate character'));
      expect(finding).toBeDefined();
    });

    it('9. rejects duplicate scene IDs', () => {
      const scenario = getProgressMeetingScenario();
      scenario.scenes[1].id = scenario.scenes[0].id;

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-002-UNIQUE-IDS' && f.message.includes('Duplicate scene'));
      expect(finding).toBeDefined();
    });

    it('10. rejects duplicate dialogue turn IDs', () => {
      const scenario = getProgressMeetingScenario();
      scenario.scenes[0].turns[1].id = scenario.scenes[0].turns[0].id;

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-002-UNIQUE-IDS' && f.message.includes('Duplicate dialogue turn'));
      expect(finding).toBeDefined();
    });

    it('11. rejects duplicate evidence IDs', () => {
      const scenario = getProgressMeetingScenario();
      scenario.evidence.push({
        ...scenario.evidence[0],
        claim: 'Another claim with identical ID',
      });

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-002-UNIQUE-IDS' && f.message.includes('Duplicate evidence'));
      expect(finding).toBeDefined();
    });

    it('12. rejects scenario with zero characters', () => {
      const scenario = getProgressMeetingScenario();
      scenario.characters = [];

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'RULE-005-CHARACTERS-REQUIRED')).toBe(true);
    });

    it('13. rejects empty spoken text in dialogue turns', () => {
      const scenario = getProgressMeetingScenario();
      scenario.scenes[0].turns[0].spokenText = '   ';

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'RULE-007-NONEMPTY-DIALOGUE')).toBe(true);
    });

    it('14. rejects unsupported major schema version', () => {
      const scenario = getProgressMeetingScenario();
      scenario.metadata.schemaVersion = '2.0.0';

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'RULE-001-SCHEMA-VERSION')).toBe(true);
    });

    it('14a. rejects malformed schema versions even when they start with major version 1', () => {
      const scenario = getProgressMeetingScenario();
      scenario.metadata.schemaVersion = '1.invalid';

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'RULE-001-SCHEMA-VERSION')).toBe(true);
    });

    it('14b. rejects fixture path traversal', () => {
      expect(() => loadScenarioFixture('../package')).toThrow(/must not contain path segments/);
    });
  });

  describe('Narrative & Pacing Rules', () => {
    it('15. rejects scenario where first scene is not a hook', () => {
      const scenario = getProgressMeetingScenario();
      scenario.scenes[0].narrativePurpose = 'context';

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-008-FIRST-SCENE-HOOK');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
    });

    it('16. rejects published scenario lacking a final CTA', () => {
      const scenario = getProgressMeetingScenario();
      const lastScene = scenario.scenes[scenario.scenes.length - 1];
      lastScene.narrativePurpose = 'context';
      lastScene.turns.forEach(t => {
        if (t.intent === 'call_to_action') t.intent = 'assertion';
      });

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-009-FINAL-SCENE-CTA');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
    });

    it('17. rejects non-deterministic or descending scene indices', () => {
      const scenario = getProgressMeetingScenario();
      scenario.scenes[2].index = 1; // duplicate/out of order index

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'RULE-010-SCENE-ORDER')).toBe(true);
    });

    it('17a. rejects ascending scene-index gaps', () => {
      const scenario = getProgressMeetingScenario();
      scenario.scenes[2].index = 3;

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'RULE-010-SCENE-ORDER')).toBe(true);
    });

    it('18. warns when participating character is completely unused in the scene', () => {
      const scenario = getProgressMeetingScenario();
      // Sarah and Marcus are participants in scene 0; add David without him speaking or being targeted
      scenario.scenes[0].participantIds.push('char-david-site');

      const report = validateScenario(scenario);
      const warning = report.findings.find(f => f.ruleId === 'RULE-018-UNUSED-PARTICIPANT');
      expect(warning).toBeDefined();
      expect(warning?.severity).toBe('warning');
      expect(warning?.message).toContain('char-david-site');
    });

    it('19. rejects promotional CTA disguised as factual evidence', () => {
      const scenario = getProgressMeetingScenario();
      scenario.evidence.push({
        id: 'ev-fake-cta',
        claim: 'Click the link below to subscribe and book a demo today!',
        evidenceType: 'quality_audit',
        sourceRef: 'Marketing Brochure',
        numericFacts: [],
        confidence: 'unconfirmed',
        usedInSceneIds: [],
        usedInTurnIds: [],
      });

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'RULE-020-CTA-AS-EVIDENCE')).toBe(true);
    });

    it('20. rejects sensitive secrets and absolute filesystem paths in dialogue', () => {
      const scenario = getProgressMeetingScenario();
      scenario.scenes[0].turns[0].spokenText = 'Here is the database secret sk-proj-1234567890abcdef123456 for the server.';

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'RULE-014-FORBIDDEN-PATH-SECRET')).toBe(true);

      const scenarioPath = getProgressMeetingScenario();
      scenarioPath.scenes[0].turns[0].spokenText = 'Please open the file located at /etc/shadow on the host.';
      const reportPath = validateScenario(scenarioPath);
      expect(reportPath.valid).toBe(false);
      expect(reportPath.findings.some(f => f.ruleId === 'RULE-014-FORBIDDEN-PATH-SECRET')).toBe(true);
    });
  });

  describe('Duration Estimation & Timing Rules', () => {
    it('21. estimates individual dialogue turn duration deterministically', () => {
      const turn = {
        id: 'turn-t1',
        speakerId: 'spk-1',
        spokenText: 'This is a ten word sample sentence for the meeting.',
        intent: 'assertion',
        pauseAfterSeconds: 0.5,
      };

      const est = estimateTurnDuration(turn, {
        wordsPerMinute: 150, // 2.5 words/sec -> 10 words = 4.0s
        minTurnSeconds: 0.8,
        defaultPauseSeconds: 0.3,
        transitionAllowanceSeconds: 0.5,
        nonDialogueBeatSeconds: 2.0,
      });

      expect(est.wordCount).toBe(10);
      expect(est.speechDurationSeconds).toBe(4.0);
      expect(est.pauseSeconds).toBe(0.5);
      expect(est.totalSeconds).toBe(4.5);
    });

    it('22. enforces minTurnSeconds floor for very brief single-word turns', () => {
      const turn = {
        id: 'turn-brief',
        speakerId: 'spk-1',
        spokenText: 'Agreed.',
        intent: 'agreement',
        pauseAfterSeconds: 0.2,
      };

      const est = estimateTurnDuration(turn, {
        wordsPerMinute: 150,
        minTurnSeconds: 1.0,
        defaultPauseSeconds: 0.3,
        transitionAllowanceSeconds: 0.5,
        nonDialogueBeatSeconds: 2.0,
      });

      expect(est.wordCount).toBe(1);
      expect(est.speechDurationSeconds).toBe(1.0); // clamped to floor
      expect(est.totalSeconds).toBe(1.2);
    });

    it('23. estimates complete scene and scenario durations with transition buffers', () => {
      const scenario = getScheduleRiskScenario();
      const estimate = estimateScenarioDuration(scenario);

      expect(estimate.totalSeconds).toBeGreaterThan(30);
      expect(estimate.totalSeconds).toBeLessThan(65);
      expect(estimate.scenes.length).toBe(scenario.scenes.length);
      expect(estimate.wordsPerMinute).toBe(150);
      expect(estimate.assumptions).toBeDefined();
    });

    it('24. rejects Short scenario exceeding 65.0s hard ceiling', () => {
      const scenario = getScheduleRiskScenario();
      // Add very long dialogue turns that inflate duration well beyond 65s
      for (let i = 0; i < 4; i++) {
        scenario.scenes[1].turns.push({
          id: `turn-bloat-${i}`,
          speakerId: 'char-tom-director',
          spokenText: 'We need to conduct an exhaustive multi-hour review of every single conduit run, pull schedule, terminal block, and cable bracket across the entirety of building four before any authorization can proceed.',
          intent: 'instruction',
          pauseAfterSeconds: 1.0,
        });
      }

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-021-SHORT-DURATION-CEILING');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
    });

    it('25. warns if spoken text citing evidence omits exact numeric figures', () => {
      const scenario = getProgressMeetingScenario();
      // Modify turn citing ev-cube-fail-04 (28.5 MPa) to omit the number 28.5
      const turn = scenario.scenes[2].turns[0];
      turn.spokenText = 'Here is the third party lab certificate. The concrete cube test broke well below our required design threshold.';

      const report = validateScenario(scenario);
      const warning = report.findings.find(f => f.ruleId === 'RULE-013-NUMERIC-FACT-PRESERVED' && f.location.evidenceId === 'ev-cube-fail-04');
      expect(warning).toBeDefined();
      expect(warning?.severity).toBe('warning');
      expect(warning?.message).toContain('28.5');
    });
  });

  describe('Anti-Repetition & Diversity Analyzer', () => {
    it('26. detects and rejects excessive uninterrupted monologue without justification', () => {
      const scenario = getProgressMeetingScenario();
      // Add 2 consecutive turns by Marcus right after turn-02 (also Marcus) in scene 0 without monologueReason
      scenario.scenes[0].turns.push(
        {
          id: 'turn-extra-1',
          speakerId: 'char-marcus-qs',
          spokenText: 'Furthermore, the curing temperature logs from last Thursday are completely missing.',
          intent: 'assertion',
        },
        {
          id: 'turn-extra-2',
          speakerId: 'char-marcus-qs',
          spokenText: 'And on top of that, your site engineer never countersigned the pour log.',
          intent: 'assertion',
        }
      );

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-015-EXCESSIVE-MONOLOGUE');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
    });

    it('27. permits consecutive monologue turns when explicit monologueReason is declared', () => {
      const scenario = getProgressMeetingScenario();
      // Add consecutive turns by Marcus with monologueReason
      scenario.scenes[0].turns.push(
        {
          id: 'turn-extra-1',
          speakerId: 'char-marcus-qs',
          spokenText: 'Furthermore, the curing temperature logs from last Thursday are completely missing.',
          intent: 'assertion',
          monologueReason: 'Detailing multi-item formal compliance discrepancy list',
        },
        {
          id: 'turn-extra-2',
          speakerId: 'char-marcus-qs',
          spokenText: 'And on top of that, your site engineer never countersigned the pour log.',
          intent: 'assertion',
          monologueReason: 'Detailing multi-item formal compliance discrepancy list',
        }
      );

      const report = validateScenario(scenario);
      const monologueError = report.findings.find(f => f.ruleId === 'RULE-015-EXCESSIVE-MONOLOGUE');
      expect(monologueError).toBeUndefined();
    });

    it('28. detects and rejects exact repeated substantive sentences across turns', () => {
      const scenario = getProgressMeetingScenario();
      const duplicateSentence = 'We submitted fifty-eight percent because the physical casting is complete.';
      scenario.scenes[0].turns[0].spokenText = `${duplicateSentence} Let us start the review now.`;
      scenario.scenes[1].turns[0].spokenText = `${duplicateSentence} What justification exists for holding it down?`;

      const report = validateScenario(scenario);
      expect(report.valid).toBe(false);
      const finding = report.findings.find(f => f.ruleId === 'RULE-016-REPEATED-SENTENCE');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('error');
    });

    it('29. warns when camera shot type is mechanically repeated across consecutive scenes', () => {
      const scenario = getProgressMeetingScenario();
      // Set all 5 scenes to 'wide' without justification
      scenario.scenes.forEach(s => {
        s.production.shotType = 'wide';
      });

      const report = validateScenario(scenario);
      const warning = report.findings.find(f => f.ruleId === 'RULE-017-REPEATED-SHOT');
      expect(warning).toBeDefined();
      expect(warning?.severity).toBe('warning');
    });

    it('30. suppresses repeated shot warning when explicit scene justification is provided', () => {
      const scenario = getProgressMeetingScenario();
      scenario.scenes.forEach(s => {
        s.production.shotType = 'wide';
        s.justifications = {
          repeatedShot: 'Static group courtroom-style wide staging maintained for formal multi-party dispute',
        };
      });

      const report = validateScenario(scenario);
      const warning = report.findings.find(f => f.ruleId === 'RULE-017-REPEATED-SHOT');
      expect(warning).toBeUndefined();
    });

    it('31. generates comprehensive diversity metrics and participation share', () => {
      const scenario = getProgressMeetingScenario();
      const diversity = analyzeScenarioDiversity(scenario);

      expect(diversity.participation.length).toBe(3);
      expect(diversity.overallDiversityScore).toBeGreaterThanOrEqual(80);
      const totalShare = diversity.participation.reduce((acc, p) => acc + p.turnSharePercent, 0);
      expect(Math.round(totalShare)).toBeCloseTo(100, 0);
    });
  });

  describe('Deterministic Round-Trip Serialization', () => {
    it('32. guarantees lossless JSON stringify and parse round-trip', () => {
      const scenario = getClaimVariationScenario();
      const serialized = JSON.stringify(scenario, null, 2);
      const parsed = JSON.parse(serialized) as Scenario;

      expect(parsed).toEqual(scenario);

      const report = validateScenario(parsed);
      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
    });

    it('33. produces identical deterministic validation findings across consecutive runs', () => {
      const scenario = getProgressMeetingScenario();
      const report1 = validateScenario(scenario);
      const report2 = validateScenario(scenario);

      expect(report1).toEqual(report2);
    });
  });
});
