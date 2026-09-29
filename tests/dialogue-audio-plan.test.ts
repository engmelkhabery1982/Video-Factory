/**
 * BuildTrack Video Factory - Phase 3C Dialogue Audio Plan Tests
 *
 * Comprehensive test suite verifying deterministic dialogue audio planning:
 * canonical scenario processing, multi-character voice-slot assignment,
 * relative clip paths, monotonic timelines, pause preservation, duration consistency,
 * JSON round-trips, and negative integrity rejections.
 */

import { describe, it, expect } from 'vitest';
import {
  getProgressMeetingScenario,
  getClaimVariationScenario,
  getScheduleRiskScenario,
  estimateScenarioDuration,
  Scenario,
} from '@buildtrack/core';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { validateDialogueAudioPlan } from '../packages/core/src/scenario/validate-dialogue-audio-plan.js';
import {
  DEFAULT_AUDIO_FORMAT,
  DialogueAudioPlan,
} from '../packages/core/src/scenario/dialogue-audio-types.js';

describe('Phase 3C — Deterministic Multi-Character Dialogue Audio Planner', () => {
  describe('Canonical Scenarios Planning', () => {
    it('1. successfully plans dialogue audio for Progress Meeting fixture (Long)', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);

      expect(plan.scenarioId).toBe(scenario.metadata.id);
      expect(plan.targetFormat).toBe('Long');
      expect(plan.clipCount).toBe(12);
      expect(plan.clips.length).toBe(12);
      expect(plan.characters.length).toBe(3);
      expect(plan.audioFormat).toEqual(DEFAULT_AUDIO_FORMAT);

      const report = validateDialogueAudioPlan(plan, scenario);
      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
    });

    it('2. successfully plans dialogue audio for Claim & Variation fixture (Long)', () => {
      const scenario = getClaimVariationScenario();
      const plan = planDialogueAudio(scenario);

      expect(plan.scenarioId).toBe(scenario.metadata.id);
      expect(plan.targetFormat).toBe('Long');
      expect(plan.clipCount).toBe(10);
      expect(plan.clips.length).toBe(10);
      expect(plan.characters.length).toBe(2);

      const report = validateDialogueAudioPlan(plan, scenario);
      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
    });

    it('3. successfully plans dialogue audio for Schedule Risk fixture (Short)', () => {
      const scenario = getScheduleRiskScenario();
      const plan = planDialogueAudio(scenario);

      expect(plan.scenarioId).toBe(scenario.metadata.id);
      expect(plan.targetFormat).toBe('Short');
      expect(plan.clipCount).toBe(7);
      expect(plan.clips.length).toBe(7);
      expect(plan.characters.length).toBe(3);
      expect(plan.totalDurationSeconds).toBeLessThanOrEqual(60);

      const report = validateDialogueAudioPlan(plan, scenario);
      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
    });

    it('4. represents every dialogue turn in the source scenario exactly once', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);

      const sourceTurnIds: string[] = [];
      scenario.scenes.forEach(s => s.turns.forEach(t => sourceTurnIds.push(t.id)));

      expect(plan.clips.length).toBe(sourceTurnIds.length);
      const planTurnIds = plan.clips.map(c => c.turnId);
      expect(planTurnIds).toEqual(sourceTurnIds);

      // Verify uniqueness
      const uniqueIds = new Set(planTurnIds);
      expect(uniqueIds.size).toBe(sourceTurnIds.length);
    });
  });

  describe('Voice Slot Resolution & Separation', () => {
    it('5. enforces distinct multi-character voice-slot separation', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);

      const voiceSlots = plan.characters.map(c => c.voiceSlot);
      expect(new Set(voiceSlots).size).toBe(voiceSlots.length);
      expect(voiceSlots).toContain('voice_en_female_authority');
      expect(voiceSlots).toContain('voice_en_male_practical');
      expect(voiceSlots).toContain('voice_en_male_commercial');
    });

    it('6. applies turn-level voice-slot override when present on a dialogue turn', () => {
      const scenario = getProgressMeetingScenario();
      // Sarah has default voice_en_female_authority; override turn 1 with special whisper/call slot
      scenario.scenes[0].turns[0].voiceSlot = 'voice_en_female_whisper';

      const plan = planDialogueAudio(scenario);
      const firstClip = plan.clips[0];

      expect(firstClip.turnId).toBe(scenario.scenes[0].turns[0].id);
      expect(firstClip.voiceSlot).toBe('voice_en_female_whisper');

      // Sarah's next turn retains her character default
      const sarahThirdTurn = plan.clips.find(c => c.speakerId === 'char-sarah-pm' && c.turnId !== firstClip.turnId);
      expect(sarahThirdTurn?.voiceSlot).toBe('voice_en_female_authority');
    });

    it('7. rejects planning when a speaking character has no voice slot assigned', () => {
      const scenario = getProgressMeetingScenario();
      delete scenario.characters[0].voiceSlot;

      expect(() => planDialogueAudio(scenario)).toThrowError(
        /has no voiceSlot defined/i
      );
    });

    it('8. rejects accidental duplicate/shared voice-slot assignment by default', () => {
      const scenario = getProgressMeetingScenario();
      // Sarah and Marcus assigned same voice slot
      scenario.characters[0].voiceSlot = 'shared_voice_generic';
      scenario.characters[2].voiceSlot = 'shared_voice_generic';

      expect(() => planDialogueAudio(scenario)).toThrowError(
        /Multi-character dialogue requires distinct voice slots by default/i
      );
    });

    it('9. permits shared voice-slot assignment when allowSharedVoiceSlots is explicitly true', () => {
      const scenario = getProgressMeetingScenario();
      scenario.characters[0].voiceSlot = 'shared_voice_generic';
      scenario.characters[2].voiceSlot = 'shared_voice_generic';

      const plan = planDialogueAudio(scenario, { allowSharedVoiceSlots: true });
      expect(plan.clipCount).toBe(12);

      const sarahClips = plan.clips.filter(c => c.speakerId === 'char-sarah-pm');
      const marcusClips = plan.clips.filter(c => c.speakerId === 'char-marcus-qs');

      expect(sarahClips[0].voiceSlot).toBe('shared_voice_generic');
      expect(marcusClips[0].voiceSlot).toBe('shared_voice_generic');
    });
  });

  describe('Path Safety & Determinism', () => {
    it('10. generates deterministic, safe, relative suggested clip paths', () => {
      const scenario = getScheduleRiskScenario();
      const plan = planDialogueAudio(scenario);

      plan.clips.forEach(clip => {
        expect(clip.suggestedPath).toMatch(/^audio\/dialogue\/[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-]+\.wav$/);
        expect(clip.suggestedPath.startsWith('/')).toBe(false);
        expect(clip.suggestedPath.includes('..')).toBe(false);
      });
    });

    it('11. respects custom relative basePath option', () => {
      const scenario = getScheduleRiskScenario();
      const plan = planDialogueAudio(scenario, { basePath: 'custom/project_audio/clips' });

      expect(plan.clips[0].suggestedPath.startsWith('custom/project_audio/clips/')).toBe(true);
      expect(plan.clips[0].suggestedPath.endsWith('.wav')).toBe(true);
    });

    it('12. rejects basePath with directory traversal or absolute components', () => {
      const scenario = getScheduleRiskScenario();

      expect(() => planDialogueAudio(scenario, { basePath: '../escaped_root' })).toThrowError(
        /path traversal/i
      );
      expect(() => planDialogueAudio(scenario, { basePath: '/absolute/path' })).toThrowError(
        /relative path/i
      );
    });
  });

  describe('Content Preservation & Contract Invariants', () => {
    it('13. preserves exact spoken text without mutation or truncation', () => {
      const scenario = getClaimVariationScenario();
      const plan = planDialogueAudio(scenario);

      scenario.scenes.forEach(scene => {
        scene.turns.forEach(turn => {
          const clip = plan.clips.find(c => c.turnId === turn.id);
          expect(clip).toBeDefined();
          expect(clip?.spokenText).toBe(turn.spokenText);
          expect(clip?.intent).toBe(turn.intent);
          expect(clip?.delivery).toBe(turn.delivery);
        });
      });
    });

    it('14. preserves evidence references on dialogue turns', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);

      const evidenceTurns = scenario.scenes.flatMap(s => s.turns).filter(t => t.evidenceId);
      expect(evidenceTurns.length).toBeGreaterThan(0);

      evidenceTurns.forEach(turn => {
        const clip = plan.clips.find(c => c.turnId === turn.id);
        expect(clip?.evidenceId).toBe(turn.evidenceId);
      });
    });

    it('15. strictly preserves scene and turn ordering', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);

      let lastSceneIndex = -1;
      let lastGlobalTurn = -1;

      plan.clips.forEach(clip => {
        expect(clip.sceneIndex).toBeGreaterThanOrEqual(lastSceneIndex);
        expect(clip.globalTurnIndex).toBe(lastGlobalTurn + 1);
        lastSceneIndex = clip.sceneIndex;
        lastGlobalTurn = clip.globalTurnIndex;
      });
    });

    it('16. produces strictly monotonic, non-overlapping clip timelines', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);

      for (let i = 1; i < plan.clips.length; i++) {
        const prev = plan.clips[i - 1];
        const curr = plan.clips[i];

        // Speech ends before or at pause completion
        expect(curr.startTimeSeconds).toBeGreaterThanOrEqual(prev.endTimeSeconds);
        // Clip timeline is monotonic
        expect(curr.startTimeSeconds).toBeGreaterThan(prev.startTimeSeconds);
        // End time equals startTime + duration
        expect(curr.endTimeSeconds).toBeCloseTo(curr.startTimeSeconds + curr.durationSeconds, 2);
      }
    });

    it('17. preserves deliberate silence and pauses between turns', () => {
      const scenario = getScheduleRiskScenario();
      const plan = planDialogueAudio(scenario);

      const firstSceneClips = plan.scenes[0].clips;
      for (let i = 0; i < firstSceneClips.length - 1; i++) {
        const clip = firstSceneClips[i];
        const nextClip = firstSceneClips[i + 1];

        const gap = Math.round((nextClip.startTimeSeconds - clip.endTimeSeconds) * 100) / 100;
        expect(gap).toBe(clip.pauseAfterSeconds);
      }
    });

    it('18. total planned duration matches scenario duration estimator within rounding tolerance', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);
      const estimate = estimateScenarioDuration(scenario);

      expect(Math.abs(plan.totalDurationSeconds - estimate.totalSeconds)).toBeLessThanOrEqual(0.05);
    });
  });

  describe('Stability, Mutation & Negative Validation', () => {
    it('19. produces byte-for-byte identical output across repeated runs', () => {
      const scenario = getProgressMeetingScenario();
      const plan1 = planDialogueAudio(scenario);
      const plan2 = planDialogueAudio(scenario);

      expect(JSON.stringify(plan1)).toBe(JSON.stringify(plan2));
    });

    it('20. guarantees lossless JSON round-trip stability', () => {
      const scenario = getClaimVariationScenario();
      const plan = planDialogueAudio(scenario);

      const jsonStr = JSON.stringify(plan, null, 2);
      const parsedPlan = JSON.parse(jsonStr) as DialogueAudioPlan;

      expect(parsedPlan).toEqual(plan);
      const report = validateDialogueAudioPlan(parsedPlan, scenario);
      expect(report.valid).toBe(true);
    });

    it('21. never mutates the input source Scenario object', () => {
      const scenario = getScheduleRiskScenario();
      const snapshot = JSON.stringify(scenario);

      planDialogueAudio(scenario);
      expect(JSON.stringify(scenario)).toBe(snapshot);
    });

    it('22. rejects an invalid source scenario before planning', () => {
      const scenario = getScheduleRiskScenario();
      // Break scenario by removing all scenes
      scenario.scenes = [];

      expect(() => planDialogueAudio(scenario)).toThrowError(
        /Input Scenario failed validation/i
      );
    });

    it('23. validateDialogueAudioPlan rejects malformed plan manifests', () => {
      const scenario = getScheduleRiskScenario();
      const plan = planDialogueAudio(scenario);

      // Inject overlap defect
      plan.clips[1].startTimeSeconds = plan.clips[0].startTimeSeconds;
      plan.clips[1].endTimeSeconds = plan.clips[1].startTimeSeconds + plan.clips[1].durationSeconds;

      const report = validateDialogueAudioPlan(plan, scenario);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'DAP-011-CLIP-OVERLAP')).toBe(true);
    });

    it('24. validateDialogueAudioPlan rejects path traversal in suggestedPath', () => {
      const scenario = getScheduleRiskScenario();
      const plan = planDialogueAudio(scenario);

      plan.clips[0].suggestedPath = 'audio/../../etc/shadow.wav';

      const report = validateDialogueAudioPlan(plan, scenario);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'DAP-009-PATH-TRAVERSAL')).toBe(true);
    });

    it('25. validateDialogueAudioPlan detects missing dialogue turns compared to source', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);

      // Remove last clip
      plan.clips.pop();
      plan.clipCount = plan.clips.length;

      const report = validateDialogueAudioPlan(plan, scenario);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId === 'DAP-014-TOTAL-TURNS-COUNT')).toBe(true);
    });
  });
});
