/**
 * BuildTrack Video Factory - Phase 4A Voice Registry & Resolution Tests
 *
 * Comprehensive unit tests for:
 * - VoiceProfile contract validation
 * - Registry validation (duplicates, malformed entries)
 * - Deterministic lookup from voiceSlot
 * - Language compatibility handling
 * - Structured errors
 * - Explicit fallback policy
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VOICE_REGISTRY,
  validateVoiceRegistry,
  createVoiceRegistry,
} from '../packages/core/src/scenario/voice-registry.js';
import {
  resolveVoiceSlot,
  resolveVoiceSlots,
  resolveDialogueAudioPlanVoices,
  isLanguageCompatible,
  listKnownVoiceSlots,
  getVoiceProfileById,
} from '../packages/core/src/scenario/voice-resolver.js';
import { VoiceResolutionError, VoiceProfile } from '../packages/core/src/scenario/voice-types.js';
import { getProgressMeetingScenario, getClaimVariationScenario, getScheduleRiskScenario } from '@buildtrack/core';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';

describe('Phase 4A — Voice Registry & Deterministic Resolution', () => {
  describe('Voice Registry Contract', () => {
    it('1. default registry contains expected known slots from fixtures', () => {
      const slots = listKnownVoiceSlots();
      expect(slots).toContain('voice_en_female_authority');
      expect(slots).toContain('voice_en_male_practical');
      expect(slots).toContain('voice_en_male_commercial');
      expect(slots).toContain('voice_en_female_legal');
      expect(slots).toContain('voice_en_male_advocate');
      expect(slots).toContain('voice_us_female_analytic');
      expect(slots).toContain('voice_us_male_executive');
      expect(slots).toContain('voice_us_male_field');
      expect(slots.length).toBeGreaterThanOrEqual(8);
    });

    it('2. default registry validates successfully', () => {
      const report = validateVoiceRegistry(DEFAULT_VOICE_REGISTRY);
      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
    });

    it('3. registry entries have required fields and valid structure', () => {
      for (const profile of DEFAULT_VOICE_REGISTRY) {
        expect(profile.id).toBeTruthy();
        expect(profile.voiceSlot).toBeTruthy();
        expect(profile.displayName).toBeTruthy();
        expect(profile.primaryLanguage).toBeTruthy();
        expect(profile.languages.length).toBeGreaterThan(0);
        expect(profile.languages.map(l => l.toLowerCase())).toContain(profile.primaryLanguage.toLowerCase());
        expect(typeof profile.enabled).toBe('boolean');
        expect(profile.version).toBeTruthy();
        expect(profile.voiceSlot.startsWith('voice_')).toBe(true);
      }
    });

    it('4. registry is immutable (frozen)', () => {
      expect(Object.isFrozen(DEFAULT_VOICE_REGISTRY)).toBe(true);
    });

    it('5. createVoiceRegistry returns immutable copy and validates', () => {
      const copy = createVoiceRegistry([...DEFAULT_VOICE_REGISTRY] as VoiceProfile[]);
      expect(copy.length).toBe(DEFAULT_VOICE_REGISTRY.length);
      expect(Object.isFrozen(copy)).toBe(true);
    });
  });

  describe('Registry Validation — Error Detection', () => {
    it('6. detects duplicate voice IDs', () => {
      const dup = [
        ...DEFAULT_VOICE_REGISTRY,
        { ...DEFAULT_VOICE_REGISTRY[0], voiceSlot: 'voice_duplicate_test' },
      ] as VoiceProfile[];
      const report = validateVoiceRegistry(dup);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId.includes('DUPLICATE-ID'))).toBe(true);
    });

    it('7. detects duplicate voiceSlots', () => {
      const dup = [
        ...DEFAULT_VOICE_REGISTRY,
        { ...DEFAULT_VOICE_REGISTRY[0], id: 'vp_duplicate_slot_test' },
      ] as VoiceProfile[];
      const report = validateVoiceRegistry(dup);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId.includes('DUPLICATE-SLOT'))).toBe(true);
    });

    it('8. detects malformed entries — missing id', () => {
      const malformed = [
        { ...DEFAULT_VOICE_REGISTRY[0], id: '' },
      ] as unknown as VoiceProfile[];
      const report = validateVoiceRegistry(malformed);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId.includes('MISSING-ID'))).toBe(true);
    });

    it('9. detects malformed entries — missing voiceSlot', () => {
      const malformed = [
        { ...DEFAULT_VOICE_REGISTRY[0], voiceSlot: '' },
      ] as unknown as VoiceProfile[];
      const report = validateVoiceRegistry(malformed);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId.includes('MISSING-SLOT'))).toBe(true);
    });

    it('10. detects malformed entries — invalid language code', () => {
      const malformed = [
        { ...DEFAULT_VOICE_REGISTRY[0], primaryLanguage: 'not-a-valid-lang-!!!', languages: ['not-a-valid-lang-!!!'] },
      ] as unknown as VoiceProfile[];
      const report = validateVoiceRegistry(malformed);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.category === 'language')).toBe(true);
    });

    it('11. detects malformed entries — empty languages array', () => {
      const malformed = [
        { ...DEFAULT_VOICE_REGISTRY[0], languages: [] },
      ] as unknown as VoiceProfile[];
      const report = validateVoiceRegistry(malformed);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId.includes('MISSING-LANGUAGES'))).toBe(true);
    });

    it('12. detects malformed entries — primaryLanguage not in languages', () => {
      const malformed = [
        { ...DEFAULT_VOICE_REGISTRY[0], primaryLanguage: 'fr-FR', languages: ['en-GB', 'en'] },
      ] as unknown as VoiceProfile[];
      const report = validateVoiceRegistry(malformed);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId.includes('PRIMARY-NOT-IN-LANGUAGES'))).toBe(true);
    });

    it('13. detects malformed entries — missing displayName', () => {
      const malformed = [
        { ...DEFAULT_VOICE_REGISTRY[0], displayName: '' },
      ] as unknown as VoiceProfile[];
      const report = validateVoiceRegistry(malformed);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId.includes('MISSING-DISPLAY-NAME'))).toBe(true);
    });

    it('14. detects malformed entries — enabled not boolean', () => {
      const malformed = [
        { ...DEFAULT_VOICE_REGISTRY[0], enabled: 'yes' as unknown as boolean },
      ] as unknown as VoiceProfile[];
      const report = validateVoiceRegistry(malformed);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId.includes('INVALID-ENABLED'))).toBe(true);
    });

    it('15. detects empty registry', () => {
      const report = validateVoiceRegistry([]);
      expect(report.valid).toBe(false);
      expect(report.findings.some(f => f.ruleId.includes('EMPTY-REGISTRY'))).toBe(true);
    });

    it('16. createVoiceRegistry throws on invalid registry', () => {
      const dup = [
        ...DEFAULT_VOICE_REGISTRY,
        { ...DEFAULT_VOICE_REGISTRY[0], id: 'vp_duplicate' },
      ] as VoiceProfile[];
      expect(() => createVoiceRegistry(dup)).toThrow();
    });
  });

  describe('Deterministic Voice Resolution', () => {
    it('17. known voiceSlot resolves deterministically to one valid profile', () => {
      const a = resolveVoiceSlot('voice_en_female_authority');
      const b = resolveVoiceSlot('voice_en_female_authority');
      expect(a.profile.voiceSlot).toBe('voice_en_female_authority');
      expect(a.profile.id).toBe('vp_en_female_authority_v1');
      expect(a.resolvedSlot).toBe('voice_en_female_authority');
      expect(a.requestedSlot).toBe('voice_en_female_authority');
      expect(a.usedFallback).toBe(false);
      // Determinism
      expect(a.profile).toEqual(b.profile);
      expect(a.resolvedSlot).toBe(b.resolvedSlot);
    });

    it('18. all fixture slots resolve deterministically', () => {
      const slots = [
        'voice_en_female_authority',
        'voice_en_male_practical',
        'voice_en_male_commercial',
        'voice_en_female_legal',
        'voice_en_male_advocate',
        'voice_us_female_analytic',
        'voice_us_male_executive',
        'voice_us_male_field',
      ];
      for (const slot of slots) {
        const resolved = resolveVoiceSlot(slot);
        expect(resolved.profile.voiceSlot).toBe(slot);
        expect(resolved.profile.enabled).toBe(true);
      }
    });

    it('19. unknown voiceSlot fails explicitly with UNKNOWN_VOICE_SLOT', () => {
      expect(() => resolveVoiceSlot('voice_unknown_nonexistent')).toThrow(VoiceResolutionError);
      try {
        resolveVoiceSlot('voice_unknown_nonexistent');
      } catch (e) {
        expect((e as VoiceResolutionError).code).toBe('UNKNOWN_VOICE_SLOT');
        expect((e as VoiceResolutionError).message).toMatch(/Unknown voiceSlot/);
        expect((e as VoiceResolutionError).details).toBeDefined();
      }
    });

    it('20. invalid voiceSlot format fails with INVALID_VOICE_SLOT_FORMAT', () => {
      expect(() => resolveVoiceSlot('')).toThrow(VoiceResolutionError);
      expect(() => resolveVoiceSlot('   ')).toThrow(VoiceResolutionError);
      try {
        resolveVoiceSlot('');
      } catch (e) {
        expect((e as VoiceResolutionError).code).toBe('INVALID_VOICE_SLOT_FORMAT');
      }
    });

    it('21. resolveVoiceSlots deduplicates but preserves order of first appearance', () => {
      const slots = ['voice_en_female_authority', 'voice_en_male_practical', 'voice_en_female_authority'];
      const resolved = resolveVoiceSlots(slots);
      expect(resolved.length).toBe(2);
      expect(resolved[0].requestedSlot).toBe('voice_en_female_authority');
      expect(resolved[1].requestedSlot).toBe('voice_en_male_practical');
    });

    it('22. resolution is deterministic across multiple calls', () => {
      const slot = 'voice_us_female_analytic';
      const results = Array.from({ length: 5 }, () => resolveVoiceSlot(slot));
      for (let i = 1; i < results.length; i++) {
        expect(results[i].profile).toEqual(results[0].profile);
        expect(results[i].resolvedSlot).toBe(results[0].resolvedSlot);
      }
    });

    it('23. disabled profile rejected unless allowDisabled=true', () => {
      const disabledProfile: VoiceProfile = {
        ...DEFAULT_VOICE_REGISTRY[0],
        id: 'vp_disabled_test',
        voiceSlot: 'voice_disabled_test',
        enabled: false,
      };
      const registry = [...DEFAULT_VOICE_REGISTRY, disabledProfile] as VoiceProfile[];
      expect(() => resolveVoiceSlot('voice_disabled_test', { registry })).toThrow(VoiceResolutionError);
      try {
        resolveVoiceSlot('voice_disabled_test', { registry });
      } catch (e) {
        expect((e as VoiceResolutionError).code).toBe('DISABLED_VOICE_PROFILE');
      }
      // With allowDisabled
      const allowed = resolveVoiceSlot('voice_disabled_test', { registry, allowDisabled: true });
      expect(allowed.profile.voiceSlot).toBe('voice_disabled_test');
    });
  });

  describe('Language Compatibility', () => {
    it('24. isLanguageCompatible exact match', () => {
      expect(isLanguageCompatible('en-GB', ['en-GB', 'en-US'])).toBe(true);
      expect(isLanguageCompatible('en-US', ['en-GB', 'en-US'])).toBe(true);
    });

    it('25. isLanguageCompatible base language match allowed by default', () => {
      expect(isLanguageCompatible('en-GB', ['en'])).toBe(true);
      expect(isLanguageCompatible('en', ['en-GB'])).toBe(true);
      expect(isLanguageCompatible('en-US', ['en-GB', 'en'])).toBe(true);
    });

    it('26. isLanguageCompatible strict mode requires exact match', () => {
      expect(isLanguageCompatible('en-GB', ['en'], true)).toBe(false);
      expect(isLanguageCompatible('en-GB', ['en-GB'], true)).toBe(true);
      expect(isLanguageCompatible('en', ['en-GB'], true)).toBe(false);
    });

    it('27. isLanguageCompatible case-insensitive', () => {
      expect(isLanguageCompatible('EN-GB', ['en-gb'])).toBe(true);
      expect(isLanguageCompatible('en-gb', ['EN-GB'])).toBe(true);
    });

    it('28. isLanguageCompatible returns true when no requested language', () => {
      expect(isLanguageCompatible(undefined, ['en-GB'])).toBe(true);
      expect(isLanguageCompatible('', ['en-GB'])).toBe(true);
    });

    it('29. resolution enforces language compatibility', () => {
      // Default registry profiles support en-GB, en-US, en — so en-GB should work
      const ok = resolveVoiceSlot('voice_en_female_authority', { language: 'en-GB' });
      expect(ok.profile.voiceSlot).toBe('voice_en_female_authority');

      // Requesting fr-FR should fail because none of default profiles support fr
      expect(() => resolveVoiceSlot('voice_en_female_authority', { language: 'fr-FR' })).toThrow(VoiceResolutionError);
      try {
        resolveVoiceSlot('voice_en_female_authority', { language: 'fr-FR' });
      } catch (e) {
        expect((e as VoiceResolutionError).code).toBe('INCOMPATIBLE_LANGUAGE');
      }
    });

    it('30. language compatibility with custom registry', () => {
      const frenchProfile: VoiceProfile = {
        id: 'vp_fr_female_test',
        voiceSlot: 'voice_fr_female_test',
        displayName: 'French Female Test',
        primaryLanguage: 'fr-FR',
        languages: ['fr-FR', 'fr'],
        gender: 'female',
        enabled: true,
        version: '1.0.0',
      };
      const registry = [...DEFAULT_VOICE_REGISTRY, frenchProfile] as VoiceProfile[];
      // fr-FR should work for french profile
      const resolvedFr = resolveVoiceSlot('voice_fr_female_test', { registry, language: 'fr-FR' });
      expect(resolvedFr.profile.primaryLanguage).toBe('fr-FR');

      // fr-FR should NOT work for English-only profile if we create an English-only one
      const englishOnly: VoiceProfile = {
        id: 'vp_en_only',
        voiceSlot: 'voice_en_only',
        displayName: 'English Only',
        primaryLanguage: 'en-GB',
        languages: ['en-GB'],
        enabled: true,
        version: '1.0.0',
      };
      const reg2 = [englishOnly] as VoiceProfile[];
      expect(() => resolveVoiceSlot('voice_en_only', { registry: reg2, language: 'fr-FR' })).toThrow();
      // But base en should work with en-GB in non-strict mode
      expect(() => resolveVoiceSlot('voice_en_only', { registry: reg2, language: 'en-US' })).not.toThrow();
      // Strict mode should fail for en-US vs en-GB
      expect(() => resolveVoiceSlot('voice_en_only', { registry: reg2, language: 'en-US', strictLanguageMatch: true })).toThrow();
    });
  });

  describe('Explicit Fallback Policy', () => {
    it('31. no implicit fallback — unknown slot fails without fallbackMap', () => {
      expect(() => resolveVoiceSlot('voice_unknown_xyz')).toThrow();
      const err = (() => {
        try {
          resolveVoiceSlot('voice_unknown_xyz');
        } catch (e) {
          return e as VoiceResolutionError;
        }
      })();
      expect(err?.code).toBe('UNKNOWN_VOICE_SLOT');
    });

    it('32. explicit fallbackMap allows controlled substitution', () => {
      const fallbackMap = {
        'voice_unknown_xyz': 'voice_en_female_authority',
      };
      const resolved = resolveVoiceSlot('voice_unknown_xyz', { fallbackMap });
      expect(resolved.usedFallback).toBe(true);
      expect(resolved.fallbackFrom).toBe('voice_unknown_xyz');
      expect(resolved.resolvedSlot).toBe('voice_en_female_authority');
      expect(resolved.profile.voiceSlot).toBe('voice_en_female_authority');
    });

    it('33. fallbackMap with invalid target fails explicitly', () => {
      const fallbackMap = {
        'voice_unknown_xyz': 'voice_nonexistent_target',
      };
      expect(() => resolveVoiceSlot('voice_unknown_xyz', { fallbackMap })).toThrow(VoiceResolutionError);
      try {
        resolveVoiceSlot('voice_unknown_xyz', { fallbackMap });
      } catch (e) {
        expect((e as VoiceResolutionError).code).toBe('UNKNOWN_VOICE_SLOT');
        expect((e as VoiceResolutionError).message).toMatch(/Fallback target/);
      }
    });

    it('34. fallback not used when direct match exists', () => {
      const fallbackMap = {
        'voice_en_female_authority': 'voice_en_male_practical', // should be ignored because direct exists
      };
      const resolved = resolveVoiceSlot('voice_en_female_authority', { fallbackMap });
      expect(resolved.usedFallback).toBe(false);
      expect(resolved.resolvedSlot).toBe('voice_en_female_authority');
    });
  });

  describe('Helpers', () => {
    it('35. listKnownVoiceSlots returns sorted list', () => {
      const slots = listKnownVoiceSlots();
      const sorted = [...slots].sort();
      expect(slots).toEqual(sorted);
    });

    it('36. getVoiceProfileById returns correct profile', () => {
      const profile = getVoiceProfileById('vp_en_female_authority_v1');
      expect(profile?.voiceSlot).toBe('voice_en_female_authority');
      expect(getVoiceProfileById('nonexistent')).toBeUndefined();
    });
  });

  describe('DialogueAudioPlan Voice Resolution', () => {
    it('37. resolves voices from a DialogueAudioPlan', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);
      const resolution = resolveDialogueAudioPlanVoices(plan);
      expect(resolution.scenarioId).toBe(scenario.metadata.id);
      expect(resolution.resolved.length).toBeGreaterThan(0);
      expect(resolution.resolved.length).toBe(plan.characters.length);
      expect(Object.keys(resolution.bySlot).length).toBeGreaterThan(0);
      for (const r of resolution.resolved) {
        expect(r.profile.enabled).toBe(true);
        expect(r.profile.voiceSlot).toBeTruthy();
      }
    });

    it('38. resolution respects plan language', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);
      // plan language is en-GB, which should be compatible with default registry
      const res = resolveDialogueAudioPlanVoices(plan);
      expect(res.language).toBe(plan.language);
      // If we override with incompatible language, should fail
      expect(() => resolveDialogueAudioPlanVoices(plan, { language: 'fr-FR' })).toThrow();
    });
  });
});
