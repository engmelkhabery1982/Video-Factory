/**
 * BuildTrack Video Factory - Phase 3E Scenario Captions Test Suite
 *
 * Comprehensive tests verifying deterministic, speaker-aware scenario captions:
 * canonical scenario processing, word-for-word text reconstruction,
 * non-overlapping monotonic timing strictly within speech intervals (no pause encroachment),
 * speaker & voice-slot metadata, Long/Short/reusable profile distinctions,
 * JSON round-trips, mutation resistance, and negative validation rejections.
 */

import { describe, it, expect } from 'vitest';
import {
  getProgressMeetingScenario,
  getClaimVariationScenario,
  getScheduleRiskScenario,
} from '@buildtrack/core';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { compileScenarioCaptions } from '../packages/core/src/scenario/compile-scenario-captions.js';
import { validateScenarioCaptionPlan } from '../packages/core/src/scenario/validate-scenario-captions.js';
import {
  ScenarioCaptionPlan,
  CAPTION_PROFILES,
} from '../packages/core/src/scenario/scenario-caption-types.js';

describe('Phase 3E — Deterministic Speaker-Aware Scenario Caption Planner', () => {
  describe('Canonical Scenarios Compilation & Validation', () => {
    it('1. successfully compiles captions for Progress Meeting fixture (Long)', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const plan = res.plan;
      expect(plan.scenarioId).toBe(scenario.metadata.id);
      expect(plan.targetFormat).toBe('Long');
      expect(plan.speakers.length).toBe(3);
      expect(plan.cueCount).toBeGreaterThanOrEqual(scenario.scenes.reduce((acc, s) => acc + s.turns.length, 0));

      const report = validateScenarioCaptionPlan(plan, scenario, audioPlan);
      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
    });

    it('2. successfully compiles captions for Claim & Variation fixture (Long)', () => {
      const scenario = getClaimVariationScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const plan = res.plan;
      expect(plan.scenarioId).toBe(scenario.metadata.id);
      expect(plan.targetFormat).toBe('Long');
      expect(plan.speakers.length).toBe(2);

      const report = validateScenarioCaptionPlan(plan, scenario, audioPlan);
      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
    });

    it('3. successfully compiles captions for Schedule Risk fixture (Short)', () => {
      const scenario = getScheduleRiskScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const plan = res.plan;
      expect(plan.scenarioId).toBe(scenario.metadata.id);
      expect(plan.targetFormat).toBe('Short');
      expect(plan.profile.maxCharsPerCue).toBe(CAPTION_PROFILES.Short.maxCharsPerCue);

      const report = validateScenarioCaptionPlan(plan, scenario, audioPlan);
      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
    });

    it('4. represents every source dialogue turn and preserves every source word in order', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const plan = res.plan;

      for (const scene of scenario.scenes) {
        for (const turn of scene.turns) {
          const turnCues = plan.cues.filter(c => c.turnId === turn.id);
          expect(turnCues.length).toBeGreaterThanOrEqual(1);

          // Word-for-word reconstruction
          const reconstructedText = turnCues.map(c => c.text).join(' ').trim().replace(/\s+/g, ' ');
          const expectedText = turn.spokenText.trim().replace(/\s+/g, ' ');
          expect(reconstructedText).toBe(expectedText);

          // Verify contiguous word indices
          let expectedWordStart = 0;
          for (const cue of turnCues) {
            expect(cue.sourceWordStart).toBe(expectedWordStart);
            expect(cue.sourceWordEnd).toBe(expectedWordStart + cue.wordCount);
            expectedWordStart = cue.sourceWordEnd;
          }
        }
      }
    });
  });

  describe('Metadata & Speaker Awareness', () => {
    it('5. preserves speaker ID, role, and name as metadata without altering caption text', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const plan = res.plan;
      for (const cue of plan.cues) {
        // Speaker metadata is present
        expect(cue.speakerId).toBeTruthy();
        expect(cue.voiceSlot).toBeTruthy();

        // Spoken text does not have invented "Speaker: " label prefixes
        expect(cue.text.startsWith('Sarah:')).toBe(false);
        expect(cue.text.startsWith('David:')).toBe(false);
        expect(cue.text.startsWith('Marcus:')).toBe(false);
      }
    });

    it('6. preserves reacting-character metadata when present on dialogue turns', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const reactingTurns = scenario.scenes.flatMap(s => s.turns).filter(t => t.reactionTargetId);
      expect(reactingTurns.length).toBeGreaterThan(0);

      for (const turn of reactingTurns) {
        const turnCues = res.plan.cues.filter(c => c.turnId === turn.id);
        for (const cue of turnCues) {
          expect(cue.reactingCharacterId).toBe(turn.reactionTargetId);
        }
      }
    });

    it('7. preserves resolved voice-slot metadata from DialogueAudioPlan', () => {
      const scenario = getClaimVariationScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      for (const cue of res.plan.cues) {
        const matchingClip = audioPlan.clips.find(c => c.clipId === cue.clipId);
        expect(cue.voiceSlot).toBe(matchingClip?.voiceSlot);
      }
    });
  });

  describe('Timing, Interval Bounds & Pause Protection', () => {
    it('8. ensures caption cues stay strictly inside the clip speech interval and never encroach on pauses', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const plan = res.plan;

      for (const clip of audioPlan.clips) {
        const turnCues = plan.cues.filter(c => c.clipId === clip.clipId);
        expect(turnCues.length).toBeGreaterThan(0);

        const firstCue = turnCues[0];
        const lastCue = turnCues[turnCues.length - 1];

        // First cue starts at clip start
        expect(firstCue.startSeconds).toBeCloseTo(clip.startTimeSeconds, 3);

        // Last cue ends exactly at clip speech end (NOT clip endTime + pauseAfterSeconds)
        expect(lastCue.endSeconds).toBeCloseTo(clip.endTimeSeconds, 3);
        expect(lastCue.endSeconds).toBeLessThanOrEqual(clip.endTimeSeconds + 0.001);

        // Entire turn pause window [clip.endTimeSeconds, clip.endTimeSeconds + clip.pauseAfterSeconds] is untouched
        if (clip.pauseAfterSeconds > 0) {
          expect(lastCue.endSeconds).toBeLessThan(clip.endTimeSeconds + clip.pauseAfterSeconds);
        }
      }
    });

    it('9. maintains strictly monotonic, non-overlapping cue timing', () => {
      const scenario = getScheduleRiskScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const cues = res.plan.cues;
      for (let i = 1; i < cues.length; i++) {
        const prev = cues[i - 1];
        const curr = cues[i];

        expect(curr.startSeconds).toBeGreaterThanOrEqual(prev.endSeconds - 0.001);
        expect(curr.endSeconds).toBeGreaterThan(curr.startSeconds);
      }
    });
  });

  describe('Format Profiles & Text Splitting Rules', () => {
    it('10. applies distinct format profiles for Long vs Short vs reusable', () => {
      const scenario = getScheduleRiskScenario();
      const audioPlan = planDialogueAudio(scenario);

      const resShort = compileScenarioCaptions(scenario, audioPlan);
      expect(resShort.success).toBe(true);
      if (!resShort.success) return;
      expect(resShort.plan.profile.maxCharsPerLine).toBe(28);

      // Reusable uses strict Short limits
      const scenarioReusable = { ...scenario, metadata: { ...scenario.metadata, targetFormat: 'reusable' as const } };
      const audioPlanReusable = { ...audioPlan, targetFormat: 'reusable' as const };
      const resReusable = compileScenarioCaptions(scenarioReusable, audioPlanReusable);
      expect(resReusable.success).toBe(true);
      if (!resReusable.success) return;
      expect(resReusable.plan.profile.maxCharsPerLine).toBe(28);
    });

    it('11. preserves numbers, percentages, and punctuation intact', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const allCaptionText = res.plan.cues.map(c => c.text).join(' ');
      expect(allCaptionText).toContain('58%');
      expect(allCaptionText).toContain('42%');
      expect(allCaptionText).toContain('28.5 MPa');
      expect(allCaptionText).toContain('35.0 MPa');
      expect(allCaptionText).toContain('185000 GBP');
    });

    it('12. avoids single-word orphan fragments for multi-word turns', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      for (const cue of res.plan.cues) {
        if (cue.wordCount === 1) {
          const matchingTurn = scenario.scenes.flatMap(s => s.turns).find(t => t.id === cue.turnId);
          const turnWords = matchingTurn?.spokenText.trim().split(/\s+/).filter(Boolean) || [];
          expect(turnWords.length).toBe(1);
        }
      }
    });

    it('13. splits multi-sentence turns at natural sentence boundaries', () => {
      const scenario = getClaimVariationScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const turn = scenario.scenes[0].turns[0];
      const turnCues = res.plan.cues.filter(c => c.turnId === turn.id);
      expect(turnCues.length).toBeGreaterThan(1);
    });

    it('14. short single-word complete sentences remain acceptable when the whole turn is 1 word', () => {
      const scenario = getProgressMeetingScenario();
      // Turn with single word "Agreed."
      const singleWordTurn = scenario.scenes.flatMap(s => s.turns).find(t => t.spokenText.trim() === 'Agreed.');
      if (singleWordTurn) {
        const audioPlan = planDialogueAudio(scenario);
        const res = compileScenarioCaptions(scenario, audioPlan);
        expect(res.success).toBe(true);
        if (!res.success) return;

        const cues = res.plan.cues.filter(c => c.turnId === singleWordTurn.id);
        expect(cues.length).toBe(1);
        expect(cues[0].text).toBe('Agreed.');
        expect(cues[0].wordCount).toBe(1);
      }
    });
  });

  describe('Stability, Immutability & JSON Round-Trip', () => {
    it('15. produces byte-for-byte identical output across repeated compilations', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);

      const res1 = compileScenarioCaptions(scenario, audioPlan);
      const res2 = compileScenarioCaptions(scenario, audioPlan);

      expect(JSON.stringify(res1)).toBe(JSON.stringify(res2));
    });

    it('16. guarantees lossless JSON round-trip stability', () => {
      const scenario = getClaimVariationScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const jsonStr = JSON.stringify(res.plan, null, 2);
      const parsed = JSON.parse(jsonStr) as ScenarioCaptionPlan;

      expect(parsed).toEqual(res.plan);
      const report = validateScenarioCaptionPlan(parsed, scenario, audioPlan);
      expect(report.valid).toBe(true);
    });

    it('17. never mutates the input source Scenario or DialogueAudioPlan', () => {
      const scenario = getScheduleRiskScenario();
      const audioPlan = planDialogueAudio(scenario);

      const scenarioSnap = JSON.stringify(scenario);
      const audioSnap = JSON.stringify(audioPlan);

      compileScenarioCaptions(scenario, audioPlan);

      expect(JSON.stringify(scenario)).toBe(scenarioSnap);
      expect(JSON.stringify(audioPlan)).toBe(audioSnap);
    });
  });

  describe('Validation & Negative Rejections', () => {
    it('18. returns structured refusal for malformed or incompatible input', () => {
      // @ts-expect-error test invalid null
      const res = compileScenarioCaptions(null, null);
      expect(res.success).toBe(false);
      expect(res.findings.length).toBeGreaterThan(0);
    });

    it('19. returns structured refusal when scenarioId does not match audioPlan', () => {
      const scenario = getScheduleRiskScenario();
      const audioPlan = planDialogueAudio(scenario);
      const modifiedAudioPlan = { ...audioPlan, scenarioId: 'different-scenario' };

      const res = compileScenarioCaptions(scenario, modifiedAudioPlan);
      expect(res.success).toBe(false);
      expect(res.findings.some(f => f.ruleId === 'SCP-001-SCENARIO-ID-MISMATCH')).toBe(true);
    });

    it('20. validator detects foreign or missing clip reference', () => {
      const scenario = getScheduleRiskScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const modifiedPlan = JSON.parse(JSON.stringify(res.plan)) as ScenarioCaptionPlan;
      modifiedPlan.cues[0].clipId = 'clip_non_existent';

      const report = validateScenarioCaptionPlan(modifiedPlan, scenario, audioPlan);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'VAL-010-FOREIGN-CLIP')).toBe(true);
    });

    it('21. validator rejects altered speaker ID', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const modifiedPlan = JSON.parse(JSON.stringify(res.plan)) as ScenarioCaptionPlan;
      modifiedPlan.cues[0].speakerId = 'char-intruder';

      const report = validateScenarioCaptionPlan(modifiedPlan, scenario, audioPlan);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'VAL-011-SPEAKER-MISMATCH')).toBe(true);
    });

    it('22. validator rejects altered voice slot', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const modifiedPlan = JSON.parse(JSON.stringify(res.plan)) as ScenarioCaptionPlan;
      modifiedPlan.cues[0].voiceSlot = 'voice_tampered';

      const report = validateScenarioCaptionPlan(modifiedPlan, scenario, audioPlan);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'VAL-012-VOICE-SLOT-MISMATCH')).toBe(true);
    });

    it('23. validator rejects altered or missing words in caption text', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const modifiedPlan = JSON.parse(JSON.stringify(res.plan)) as ScenarioCaptionPlan;
      modifiedPlan.cues[0].text = modifiedPlan.cues[0].text.replace(/\b\w+\b/, '');

      const report = validateScenarioCaptionPlan(modifiedPlan, scenario, audioPlan);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'VAL-019-TEXT-MISMATCH')).toBe(true);
    });

    it('24. validator rejects duplicated words in caption text', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const modifiedPlan = JSON.parse(JSON.stringify(res.plan)) as ScenarioCaptionPlan;
      modifiedPlan.cues[0].text = modifiedPlan.cues[0].text + ' ' + modifiedPlan.cues[0].text;

      const report = validateScenarioCaptionPlan(modifiedPlan, scenario, audioPlan);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'VAL-019-TEXT-MISMATCH')).toBe(true);
    });

    it('25. validator rejects cue extending into pause interval', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const modifiedPlan = JSON.parse(JSON.stringify(res.plan)) as ScenarioCaptionPlan;
      const firstClip = audioPlan.clips[0];
      modifiedPlan.cues[0].endSeconds = firstClip.endTimeSeconds + 0.5;

      const report = validateScenarioCaptionPlan(modifiedPlan, scenario, audioPlan);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'VAL-014-CUE-EXTENDS-INTO-PAUSE')).toBe(true);
    });

    it('26. validator rejects overlapping cue timings', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const modifiedPlan = JSON.parse(JSON.stringify(res.plan)) as ScenarioCaptionPlan;
      if (modifiedPlan.cues.length > 1) {
        modifiedPlan.cues[1].startSeconds = modifiedPlan.cues[0].startSeconds;
      }

      const report = validateScenarioCaptionPlan(modifiedPlan, scenario, audioPlan);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'VAL-016-CUE-OVERLAP')).toBe(true);
    });

    it('27. validator rejects invented speaker name labels in caption text', () => {
      const scenario = getProgressMeetingScenario();
      const audioPlan = planDialogueAudio(scenario);
      const res = compileScenarioCaptions(scenario, audioPlan);

      expect(res.success).toBe(true);
      if (!res.success) return;

      const modifiedPlan = JSON.parse(JSON.stringify(res.plan)) as ScenarioCaptionPlan;
      modifiedPlan.cues[0].text = 'Sarah: ' + modifiedPlan.cues[0].text;

      const report = validateScenarioCaptionPlan(modifiedPlan, scenario, audioPlan);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'VAL-009-INVENTED-SPEAKER-LABEL')).toBe(true);
    });
  });
});
