/**
 * BuildTrack Video Factory - Phase 4A Integration Test
 *
 * Proves: Scenario → DialogueAudioPlan → Voice Resolution
 * One focused integration test as required by Phase 4A acceptance criteria.
 */

import { describe, it, expect } from 'vitest';
import {
  getProgressMeetingScenario,
  getClaimVariationScenario,
  getScheduleRiskScenario,
} from '@buildtrack/core';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { validateDialogueAudioPlan } from '../packages/core/src/scenario/validate-dialogue-audio-plan.js';
import {
  resolveDialogueAudioPlanVoices,
  resolveVoiceSlot,
} from '../packages/core/src/scenario/voice-resolver.js';
import { DEFAULT_VOICE_REGISTRY } from '../packages/core/src/scenario/voice-registry.js';

describe('Phase 4A — Integration: Scenario → DialogueAudioPlan → Voice Resolution', () => {
  it('1. Progress Meeting fixture: Scenario → Plan → Voice profiles (deterministic)', () => {
    const scenario = getProgressMeetingScenario();

    // Step 1: Plan dialogue audio (Phase 3C)
    const plan = planDialogueAudio(scenario);
    expect(plan.scenarioId).toBe(scenario.metadata.id);
    expect(plan.clipCount).toBe(12);

    // Validate plan
    const validation = validateDialogueAudioPlan(plan, scenario);
    expect(validation.valid).toBe(true);

    // Step 2: Resolve voices (Phase 4A)
    const voiceResolution = resolveDialogueAudioPlanVoices(plan);

    expect(voiceResolution.scenarioId).toBe(scenario.metadata.id);
    expect(voiceResolution.language).toBe(scenario.metadata.language);
    expect(voiceResolution.resolved.length).toBe(plan.characters.length);

    // Every character's voiceSlot must resolve
    for (const char of plan.characters) {
      const resolved = voiceResolution.bySlot[char.voiceSlot];
      expect(resolved).toBeDefined();
      expect(resolved.voiceSlot).toBe(char.voiceSlot);
      expect(resolved.enabled).toBe(true);
    }

    // Every clip's voiceSlot must resolve
    for (const clip of plan.clips) {
      const resolved = voiceResolution.bySlot[clip.voiceSlot];
      expect(resolved).toBeDefined();
      expect(resolved.voiceSlot).toBe(clip.voiceSlot);
      // Language compatibility check: plan language en-GB must be compatible
      expect(resolved.languages.map(l => l.toLowerCase())).toEqual(
        expect.arrayContaining([expect.stringMatching(/en/i)])
      );
    }

    // Determinism: second resolution must be identical
    const secondResolution = resolveDialogueAudioPlanVoices(plan);
    expect(secondResolution.resolved.map(r => r.profile.id).sort()).toEqual(
      voiceResolution.resolved.map(r => r.profile.id).sort()
    );
    expect(secondResolution.bySlot).toEqual(voiceResolution.bySlot);

    // Check specific expected mappings for this fixture
    const slots = voiceResolution.resolved.map(r => r.requestedSlot).sort();
    expect(slots).toContain('voice_en_female_authority');
    expect(slots).toContain('voice_en_male_practical');
    expect(slots).toContain('voice_en_male_commercial');

    // Resolve individual slots deterministically
    const authority = resolveVoiceSlot('voice_en_female_authority', { language: plan.language });
    expect(authority.profile.displayName).toContain('Female');
    expect(authority.profile.gender).toBe('female');
  });

  it('2. Claim Variation fixture: Scenario → Plan → Voice profiles', () => {
    const scenario = getClaimVariationScenario();
    const plan = planDialogueAudio(scenario);
    const validation = validateDialogueAudioPlan(plan, scenario);
    expect(validation.valid).toBe(true);

    const voiceResolution = resolveDialogueAudioPlanVoices(plan);
    expect(voiceResolution.resolved.length).toBe(plan.characters.length);
    expect(voiceResolution.resolved.length).toBe(2);

    const slots = voiceResolution.resolved.map(r => r.requestedSlot).sort();
    expect(slots).toContain('voice_en_female_legal');
    expect(slots).toContain('voice_en_male_advocate');
  });

  it('3. Schedule Risk fixture (Short): Scenario → Plan → Voice profiles with en-US', () => {
    const scenario = getScheduleRiskScenario();
    const plan = planDialogueAudio(scenario);
    const validation = validateDialogueAudioPlan(plan, scenario);
    expect(validation.valid).toBe(true);

    const voiceResolution = resolveDialogueAudioPlanVoices(plan);
    expect(voiceResolution.resolved.length).toBe(plan.characters.length);
    expect(voiceResolution.language).toBe(scenario.metadata.language); // en-US

    const slots = voiceResolution.resolved.map(r => r.requestedSlot).sort();
    expect(slots).toContain('voice_us_female_analytic');
    expect(slots).toContain('voice_us_male_executive');
    expect(slots).toContain('voice_us_male_field');

    // All US voices should support en-US
    for (const r of voiceResolution.resolved) {
      expect(r.profile.languages.map(l => l.toLowerCase())).toEqual(
        expect.arrayContaining([expect.stringMatching(/en/i)])
      );
    }
  });

  it('4. End-to-end: all fixtures resolve without fallback and without error', () => {
    const scenarios = [
      getProgressMeetingScenario(),
      getClaimVariationScenario(),
      getScheduleRiskScenario(),
    ];

    for (const scenario of scenarios) {
      const plan = planDialogueAudio(scenario);
      const voiceResolution = resolveDialogueAudioPlanVoices(plan);
      expect(voiceResolution.hadFallback).toBe(false);
      expect(voiceResolution.resolved.every(r => !r.usedFallback)).toBe(true);

      // Verify every profile comes from default registry
      for (const r of voiceResolution.resolved) {
        const inDefault = DEFAULT_VOICE_REGISTRY.find(p => p.id === r.profile.id);
        expect(inDefault).toBeDefined();
      }
    }
  });

  it('5. Public API usable by future Phase 4B: exports and types', async () => {
    // Dynamic import of public exports
    const core = await import('@buildtrack/core');
    expect(core.DEFAULT_VOICE_REGISTRY).toBeDefined();
    expect(core.resolveVoiceSlot).toBeDefined();
    expect(core.resolveVoiceSlots).toBeDefined();
    expect(core.resolveDialogueAudioPlanVoices).toBeDefined();
    expect(core.validateVoiceRegistry).toBeDefined();
    expect(core.isLanguageCompatible).toBeDefined();
    expect(typeof core.resolveVoiceSlot).toBe('function');
  });
});
