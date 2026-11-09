/**
 * VS1 FOCUSED TESTS — deterministic voice publication migration.
 *
 * Proves the migration/default path the work order requires:
 *
 *   - existing registry fixtures stay readable and valid;
 *   - the eight legacy Kokoro fixtures become EXPLICIT local Kokoro profiles
 *     with a documented engine identity, and still pass the publication gate,
 *     so existing production behaviour does not regress;
 *   - migration is deterministic, idempotent, order-preserving and never mutates
 *     the frozen registry;
 *   - migration NEVER marks an unverified new/custom voice publication-approved,
 *     and never invents the evidence it does not have;
 *   - serialisation round-trips are stable and contain no absolute paths.
 *
 * No I/O beyond reading the modules, no network, no synthesis, no render.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_REGISTRY,
  MIGRATED_DEFAULT_VOICE_REGISTRY,
  createVoiceRegistry,
  validateVoiceRegistry,
} from '../packages/core/src/scenario/voice-registry.js';
import {
  LEGACY_KOKORO_FIXTURES,
  LOCAL_KOKORO_RIGHTS_EVIDENCE,
  VS1_MIGRATION_ID,
  VS1_MIGRATION_RECORDED_AT,
  isLegacyKokoroFixture,
  legacyKokoroPublicationFor,
  migrateVoiceProfileForPublication,
  migrateVoiceRegistryForPublication,
  unverifiedVoicePublicationFor,
} from '../packages/core/src/scenario/voice-publication-migration.js';
import { evaluateVoicePublicationGate, findAbsolutePaths } from '../packages/core/src/scenario/voice-publication-gate.js';
import { voiceAcousticIdentityOf, UNDECLARED_VOICE_ACOUSTIC_IDENTITY } from '../packages/core/src/scenario/voice-acoustic-identity.js';
import { KOKORO_VOICE_BY_SLOT, KOKORO_MODEL_ID, KOKORO_JS_VERSION } from '../packages/core/src/scenario/kokoro-voice-identity.js';
import { resolveDialogueAudioPlanVoices, resolveVoiceSlot, resolveVoiceSlots } from '../packages/core/src/scenario/voice-resolver.js';
import { VoiceResolutionError, type VoiceProfile } from '../packages/core/src/scenario/voice-types.js';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { getProgressMeetingScenario } from '@buildtrack/core';
import { approvedOwnVoiceProfile, errorCodes, warningCodes } from './helpers/voice-publication-fixtures.js';

/** A brand-new custom voice that declared nothing. */
function customVoiceProfile(): VoiceProfile {
  return {
    id: 'vp_custom_contractor_v1',
    voiceSlot: 'voice_custom_contractor',
    displayName: 'Custom Contractor Voice',
    primaryLanguage: 'en-GB',
    languages: ['en-GB', 'en'],
    gender: 'male',
    roleHint: 'advocate',
    enabled: true,
    version: '1.0.0',
    createdAt: '2026-10-07T09:00:00Z',
  };
}

describe('VS1 — deterministic voice publication migration', () => {
  describe('legacy Kokoro fixtures become explicit local Kokoro profiles', () => {
    it('1. every default fixture is recognised and migrated to an approved local Kokoro profile', () => {
      expect(DEFAULT_VOICE_REGISTRY.length).toBe(8);
      expect(LEGACY_KOKORO_FIXTURES.length).toBe(DEFAULT_VOICE_REGISTRY.length);

      for (const fixture of DEFAULT_VOICE_REGISTRY) {
        expect(isLegacyKokoroFixture(fixture)).toBe(true);

        const { profile, migrated, legacyKokoroFixture, publication } = migrateVoiceProfileForPublication(fixture);
        expect(migrated).toBe(true);
        expect(legacyKokoroFixture).toBe(true);
        expect(publication).toBeDefined();

        // Explicit, documented engine identity.
        expect(profile.publication?.engine).toEqual({
          engine: 'kokoro',
          modelId: KOKORO_MODEL_ID,
          modelRevision: 'v1.0',
          runtimeId: 'kokoro-js',
          runtimeVersion: KOKORO_JS_VERSION,
          provider: 'hexgrad/kokoro (runtime) — onnx-community ONNX model export',
          requiresNetwork: false,
          localOnly: true,
          extra: { dtype: 'q8', cacheDir: '.tts-cache/models' },
        });

        // The preset voice is the documented one for that slot, not a guess.
        const source = profile.publication?.acousticSource;
        expect(source?.kind).toBe('preset_model_voice');
        expect(source && source.kind === 'preset_model_voice' ? source.presetVoiceId : '').toBe(
          KOKORO_VOICE_BY_SLOT[fixture.voiceSlot]
        );

        expect(profile.publication?.publicationState).toBe('approved');
        expect(profile.publication?.origin).toBe('legacy_kokoro_fixture');
        expect(profile.publication?.provenance?.migratedBy).toBe(VS1_MIGRATION_ID);

        // Consent names the provider preset; no human signature is invented.
        expect(profile.publication?.consent?.subject).toBe('model_provider_preset');
        expect(profile.publication?.consent?.ownerConfirmed).toBe(true);
        expect(profile.publication?.consent?.revoked).toBe(false);
        expect(profile.publication?.consent?.scope).toContain('commercial_video_publication');
        expect(profile.publication?.consent?.authorizedSpeaker).toContain('no private individual');

        // Commercial rights are explicit, not inferred from silence.
        expect(profile.publication?.rights?.licenseName).toBe('Apache-2.0');
        expect(profile.publication?.rights?.commercialUse).toBe('permitted');
        expect(profile.publication?.rights?.commercialUseStatement).toContain('royalty-free');
        expect(profile.publication?.rights?.evidenceUrl).toMatch(/^https:\/\//);

        // The audition approval says where it came from.
        expect(profile.publication?.audition?.state).toBe('approved');
        expect(profile.publication?.audition?.inherited).toBe(true);
        expect(profile.publication?.audition?.approver).toBe(VS1_MIGRATION_ID);

        // Every legacy fixture still passes the gate.
        const report = evaluateVoicePublicationGate(profile);
        expect(report.allowed).toBe(true);
        expect(report.errorCount).toBe(0);
      }
    });

    it('2. every distinct preset voice is used exactly once across the migrated registry', () => {
      const presets = MIGRATED_DEFAULT_VOICE_REGISTRY.map((p) => {
        const source = p.publication?.acousticSource;
        return source && source.kind === 'preset_model_voice' ? source.presetVoiceId : '';
      });
      expect(presets.every(Boolean)).toBe(true);
      expect(new Set(presets).size).toBe(presets.length);
      expect(presets.slice().sort()).toEqual(Object.values(KOKORO_VOICE_BY_SLOT).sort());
    });

    it('3. the migrated registry is frozen, complete and keeps the fixture order and identities', () => {
      expect(Object.isFrozen(MIGRATED_DEFAULT_VOICE_REGISTRY)).toBe(true);
      expect(MIGRATED_DEFAULT_VOICE_REGISTRY.length).toBe(DEFAULT_VOICE_REGISTRY.length);
      expect(MIGRATED_DEFAULT_VOICE_REGISTRY.map((p) => p.id)).toEqual(DEFAULT_VOICE_REGISTRY.map((p) => p.id));
      expect(MIGRATED_DEFAULT_VOICE_REGISTRY.map((p) => p.voiceSlot)).toEqual(DEFAULT_VOICE_REGISTRY.map((p) => p.voiceSlot));
      expect(validateVoiceRegistry(MIGRATED_DEFAULT_VOICE_REGISTRY).valid).toBe(true);
      expect(validateVoiceRegistry(MIGRATED_DEFAULT_VOICE_REGISTRY).errorCount).toBe(0);
    });

    it('4. migration reports exactly two honest warnings per legacy fixture and never blocks', () => {
      for (const profile of MIGRATED_DEFAULT_VOICE_REGISTRY) {
        const report = evaluateVoicePublicationGate(profile);
        expect(report.allowed).toBe(true);
        expect(warningCodes(report).sort()).toEqual(['AUDITION_APPROVAL_INHERITED', 'RIGHTS_EVIDENCE_NOT_FIRST_PARTY']);
      }
    });

    it('5. migration is deterministic, idempotent and never reads the clock', () => {
      const first = JSON.stringify(migrateVoiceRegistryForPublication(DEFAULT_VOICE_REGISTRY));
      const second = JSON.stringify(migrateVoiceRegistryForPublication(DEFAULT_VOICE_REGISTRY));
      expect(second).toBe(first);

      // Idempotent: migrating an already migrated profile changes nothing.
      const once = migrateVoiceProfileForPublication(DEFAULT_VOICE_REGISTRY[0]);
      const twice = migrateVoiceProfileForPublication(once.profile);
      expect(twice.migrated).toBe(false);
      expect(JSON.stringify(twice.profile)).toBe(JSON.stringify(once.profile));

      // Fixed timestamps, so the record is reproducible on any machine.
      expect(once.publication?.consent?.recordedAt).toBe(VS1_MIGRATION_RECORDED_AT);
      expect(once.publication?.audition?.reviewedAt).toBe(VS1_MIGRATION_RECORDED_AT);
      expect(once.publication?.provenance?.migratedAt).toBe(VS1_MIGRATION_RECORDED_AT);
      expect(once.publication?.updatedAt).toBe(VS1_MIGRATION_RECORDED_AT);
    });

    it('6. migration never mutates the registry it was given', () => {
      const before = JSON.stringify(DEFAULT_VOICE_REGISTRY);
      const migrated = migrateVoiceRegistryForPublication(DEFAULT_VOICE_REGISTRY);
      expect(JSON.stringify(DEFAULT_VOICE_REGISTRY)).toBe(before);
      expect(Object.isFrozen(DEFAULT_VOICE_REGISTRY)).toBe(true);
      for (const fixture of DEFAULT_VOICE_REGISTRY) {
        expect('publication' in fixture).toBe(false);
      }
      // Migrated profiles are NEW objects, never the frozen registry entries.
      for (const [index, profile] of migrated.entries()) {
        expect(profile).not.toBe(DEFAULT_VOICE_REGISTRY[index]);
        expect(profile.publication).toBeDefined();
      }
    });

    it('7. the legacy rights evidence constants are the ones the records carry', () => {
      expect(LOCAL_KOKORO_RIGHTS_EVIDENCE.licenseName).toBe('Apache-2.0');
      expect(LOCAL_KOKORO_RIGHTS_EVIDENCE.commercialUse).toBe('permitted');
      expect(LOCAL_KOKORO_RIGHTS_EVIDENCE.localEvidencePath).toBe('node_modules/kokoro-js/LICENSE');
      expect(legacyKokoroPublicationFor(DEFAULT_VOICE_REGISTRY[0]).rights).toEqual({ ...LOCAL_KOKORO_RIGHTS_EVIDENCE });
    });
  });

  describe('an unverified new or custom voice is never silently approved', () => {
    it('8. a custom voice migrates to a blocked draft skeleton', () => {
      const custom = customVoiceProfile();
      expect(isLegacyKokoroFixture(custom)).toBe(false);

      const { profile, migrated, legacyKokoroFixture, publication } = migrateVoiceProfileForPublication(custom);
      expect(migrated).toBe(true);
      expect(legacyKokoroFixture).toBe(false);
      expect(publication?.publicationState).toBe('draft');
      expect(publication?.origin).toBe('custom_unverified');
      expect(profile.publication?.publicationState).toBe('draft');

      const report = evaluateVoicePublicationGate(profile);
      expect(report.allowed).toBe(false);
      expect(report.blocked).toBe(true);
      expect(errorCodes(report).sort()).toEqual(
        [
          'AUDITION_NOT_TESTED',
          'MISSING_ACOUSTIC_SOURCE',
          'MISSING_CONSENT',
          'MISSING_ENGINE_IDENTITY',
          'MISSING_RIGHTS_EVIDENCE',
          'PUBLICATION_STATE_NOT_APPROVED',
        ].sort()
      );
    });

    it('9. the draft skeleton invents nothing: no engine, no reference, no consent, no rights', () => {
      const skeleton = unverifiedVoicePublicationFor();
      expect(skeleton.engine).toBeUndefined();
      expect(skeleton.acousticSource).toBeUndefined();
      expect(skeleton.consent).toBeUndefined();
      expect(skeleton.rights).toBeUndefined();
      expect(skeleton.audition).toEqual({ state: 'not_tested' });
      expect(skeleton.publicationState).toBe('draft');
      expect(skeleton.provenance?.notes).toContain('never invents');
      expect(voiceAcousticIdentityOf({ ...customVoiceProfile(), publication: skeleton })).toEqual(
        UNDECLARED_VOICE_ACOUSTIC_IDENTITY
      );
    });

    it('10. a profile that spoofs a legacy slot or a legacy id does not inherit approval', () => {
      const legacy = DEFAULT_VOICE_REGISTRY[0];

      const spoofedId: VoiceProfile = { ...legacy, id: 'vp_impostor_v1' };
      const spoofedSlot: VoiceProfile = { ...legacy, voiceSlot: 'voice_impostor_slot' };
      const spoofedBoth: VoiceProfile = { ...legacy, id: 'vp_impostor_v1', voiceSlot: 'voice_impostor_slot' };

      for (const spoof of [spoofedId, spoofedSlot, spoofedBoth]) {
        expect(isLegacyKokoroFixture(spoof)).toBe(false);
        const migratedSpoof = migrateVoiceProfileForPublication(spoof);
        expect(migratedSpoof.legacyKokoroFixture).toBe(false);
        expect(migratedSpoof.publication?.publicationState).toBe('draft');
        expect(evaluateVoicePublicationGate(migratedSpoof.profile).allowed).toBe(false);
      }

      // A legacy slot whose documented preset was removed cannot inherit either.
      expect(isLegacyKokoroFixture({ id: 'vp_en_female_authority_v1', voiceSlot: 'voice_en_female_authority' })).toBe(true);
      expect(isLegacyKokoroFixture(null)).toBe(false);
      expect(isLegacyKokoroFixture({})).toBe(false);
    });

    it('11. an authored publication record is preserved exactly, never upgraded or repaired', () => {
      const authored = approvedOwnVoiceProfile();
      const before = JSON.stringify(authored.publication);
      const result = migrateVoiceProfileForPublication(authored);
      expect(result.migrated).toBe(false);
      expect(result.profile).toBe(authored);
      expect(JSON.stringify(result.profile.publication)).toBe(before);
      expect(result.publication?.origin).toBe('authored_first_party');
    });

    it('12. an authored record claiming a legacy origin is still judged on its own evidence', () => {
      const lying = approvedOwnVoiceProfile();
      lying.publication = { ...lying.publication!, origin: 'legacy_kokoro_fixture', audition: { state: 'not_tested' } };
      const report = evaluateVoicePublicationGate(lying);
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('AUDITION_NOT_TESTED');
    });

    it('13. a malformed publication field is never replaced by an inherited approval', () => {
      const legacy = DEFAULT_VOICE_REGISTRY[0];
      expect(isLegacyKokoroFixture(legacy)).toBe(true);

      for (const garbage of ['approved', 42, true, [], NaN]) {
        const corrupt = { ...legacy, publication: garbage } as unknown as VoiceProfile;
        const result = migrateVoiceProfileForPublication(corrupt);
        // Nothing is invented on top of a corrupt declaration.
        expect(result.migrated, String(garbage)).toBe(false);
        const report = evaluateVoicePublicationGate(corrupt);
        expect(report.allowed, String(garbage)).toBe(false);
        expect(report.publicationState, String(garbage)).not.toBe('approved');
      }
    });
  });

  describe('existing registry fixtures stay readable and behaviour does not regress', () => {
    it('14. the untouched Phase 4A registry is still valid and still resolves', () => {
      const report = validateVoiceRegistry(DEFAULT_VOICE_REGISTRY);
      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
      expect(report.findings.length).toBe(0);

      const resolved = resolveVoiceSlot('voice_en_female_authority', { migrateLegacyPublication: false });
      expect(resolved.profile.id).toBe('vp_en_female_authority_v1');
      expect('publication' in resolved.profile).toBe(false);
      expect(resolved.usedFallback).toBe(false);
    });

    it('15. resolution migrates by default and the migration is opt-out', () => {
      const migrated = resolveVoiceSlot('voice_en_female_authority');
      expect(migrated.profile.publication?.publicationState).toBe('approved');
      expect(migrated.profile.publication?.engine?.engine).toBe('kokoro');
      expect('publication' in migrated).toBe(false);

      const raw = resolveVoiceSlot('voice_en_female_authority', { migrateLegacyPublication: false });
      expect(raw.profile.publication).toBeUndefined();

      // Everything else about the profile is untouched by migration.
      expect({ ...migrated.profile, publication: undefined }).toEqual({ ...raw.profile, publication: undefined });
    });

    it('16. language, disabled, unknown-slot and fallback behaviour is unchanged', () => {
      expect(() => resolveVoiceSlot('voice_en_female_authority', { language: 'en-GB' })).not.toThrow();
      expect(() => resolveVoiceSlot('voice_en_female_authority', { language: 'fr-FR' })).toThrow(VoiceResolutionError);
      expect(() => resolveVoiceSlot('voice_en_female_authority', { language: 'fr-FR' })).toThrow(/INCOMPATIBLE_LANGUAGE|does not support/);

      const disabledRegistry = createVoiceRegistry([
        { ...MIGRATED_DEFAULT_VOICE_REGISTRY[0], enabled: false } as VoiceProfile,
      ]);
      expect(() => resolveVoiceSlot('voice_en_female_authority', { registry: disabledRegistry })).toThrow(/disabled/);
      expect(() =>
        resolveVoiceSlot('voice_en_female_authority', { registry: disabledRegistry, allowDisabled: true })
      ).not.toThrow();

      expect(() => resolveVoiceSlot('voice_does_not_exist')).toThrow(VoiceResolutionError);
      const fallback = resolveVoiceSlot('voice_does_not_exist', { fallbackMap: { voice_does_not_exist: 'voice_en_male_practical' } });
      expect(fallback.usedFallback).toBe(true);
      expect(fallback.resolvedSlot).toBe('voice_en_male_practical');
      expect(fallback.profile.publication?.publicationState).toBe('approved');

      const slots = resolveVoiceSlots(['voice_us_male_field', 'voice_us_male_field', 'voice_en_female_legal']);
      expect(slots.map((s) => s.requestedSlot)).toEqual(['voice_us_male_field', 'voice_en_female_legal']);
    });

    it('17. a real scenario plan resolves with every voice migrated and approved', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);
      const resolution = resolveDialogueAudioPlanVoices(plan);
      expect(resolution.resolved.length).toBeGreaterThan(0);
      for (const voice of resolution.resolved) {
        expect(voice.profile.publication?.publicationState).toBe('approved');
        expect(evaluateVoicePublicationGate(voice.profile).allowed).toBe(true);
      }
      // No gate report is attached unless the gate was requested.
      expect(resolution.publicationGate).toBeUndefined();
    });

    it('18. requirePublicationApproval allows the default fixtures and blocks an unapproved custom voice', () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);

      const approved = resolveDialogueAudioPlanVoices(plan, { requirePublicationApproval: true });
      expect(approved.publicationGate?.allowed).toBe(true);
      expect(approved.publicationGate?.blockedSlots).toEqual([]);
      expect(approved.publicationGate?.reports.length).toBe(approved.resolved.length);
      expect(approved.resolved.every((r) => r.publication?.allowed)).toBe(true);

      const customRegistry = createVoiceRegistry([customVoiceProfile(), ...MIGRATED_DEFAULT_VOICE_REGISTRY] as VoiceProfile[]);
      let thrown: unknown;
      try {
        resolveDialogueAudioPlanVoices(plan, { registry: customRegistry, requirePublicationApproval: true });
      } catch (e) {
        thrown = e;
      }
      // The custom voice is not in the plan, so this plan still resolves.
      expect(thrown).toBeUndefined();

      const customPlan = { ...plan, characters: plan.characters.map((c, i) => (i === 0 ? { ...c, voiceSlot: 'voice_custom_contractor' } : c)), clips: plan.clips.map((c) => (c.speakerId === plan.characters[0].characterId ? { ...c, voiceSlot: 'voice_custom_contractor' } : c)) };
      let blocked: unknown;
      try {
        resolveDialogueAudioPlanVoices(customPlan, { registry: customRegistry, requirePublicationApproval: true });
      } catch (e) {
        blocked = e;
      }
      expect(blocked).toBeInstanceOf(VoiceResolutionError);
      const blockedError = blocked as VoiceResolutionError;
      expect(blockedError.code).toBe('VOICE_PUBLICATION_BLOCKED');
      expect(blockedError.message).toContain('voice_custom_contractor');
      const details = blockedError.details as { blockedCodes: string[]; publicationState: string; findings: unknown[] };
      expect(details.publicationState).toBe('draft');
      expect(details.blockedCodes).toEqual(
        expect.arrayContaining(['MISSING_ENGINE_IDENTITY', 'MISSING_ACOUSTIC_SOURCE', 'MISSING_CONSENT', 'MISSING_RIGHTS_EVIDENCE', 'AUDITION_NOT_TESTED', 'PUBLICATION_STATE_NOT_APPROVED'])
      );
      expect(details.findings.length).toBe(6);
      // Without the gate the same custom voice still resolves (Phase 4A behaviour).
      expect(() => resolveDialogueAudioPlanVoices(customPlan, { registry: customRegistry })).not.toThrow();
    });

    it('19. the Kokoro engine adapter still exports the same identity constants', async () => {
      const adapter = await import('../packages/core/dist/scenario/kokoro-dialogue-synthesizer.js');
      expect(adapter.KOKORO_MODEL_ID).toBe(KOKORO_MODEL_ID);
      expect(adapter.KOKORO_JS_VERSION).toBe(KOKORO_JS_VERSION);
      expect(adapter.KOKORO_VOICE_BY_SLOT).toEqual(KOKORO_VOICE_BY_SLOT);
      expect(typeof adapter.resolveKokoroVoice).toBe('function');
      expect(adapter.KOKORO_ENGINE_ID).toBe('kokoro-js');
    });
  });

  describe('serialisation round-trip is stable and portable', () => {
    it('20. a migrated legacy record survives JSON round-trip unchanged', () => {
      for (const profile of MIGRATED_DEFAULT_VOICE_REGISTRY) {
        const serialized = JSON.stringify(profile);
        const parsed = JSON.parse(serialized) as VoiceProfile;
        expect(parsed).toEqual(profile);
        expect(JSON.stringify(parsed)).toBe(serialized);
        expect(evaluateVoicePublicationGate(parsed).allowed).toBe(true);
        expect(JSON.stringify(evaluateVoicePublicationGate(parsed).findings)).toBe(
          JSON.stringify(evaluateVoicePublicationGate(profile).findings)
        );
      }
    });

    it('21. an authored own-voice record survives JSON round-trip unchanged', () => {
      const profile = approvedOwnVoiceProfile();
      const serialized = JSON.stringify(profile);
      const parsed = JSON.parse(serialized) as VoiceProfile;
      expect(parsed).toEqual(profile);
      expect(JSON.stringify(parsed)).toBe(serialized);
      expect(evaluateVoicePublicationGate(parsed).allowed).toBe(true);
      expect(voiceAcousticIdentityOf(parsed)).toEqual(voiceAcousticIdentityOf(profile));
    });

    it('22. no serialised voice record contains an absolute path', () => {
      const serializedRegistry = JSON.stringify(MIGRATED_DEFAULT_VOICE_REGISTRY);
      expect(findAbsolutePaths(JSON.parse(serializedRegistry))).toEqual([]);
      expect(findAbsolutePaths(JSON.parse(JSON.stringify(approvedOwnVoiceProfile())))).toEqual([]);
      expect(findAbsolutePaths(JSON.parse(JSON.stringify(migrateVoiceProfileForPublication(customVoiceProfile()).profile)))).toEqual([]);

      // The check itself really does catch absolute paths.
      expect(findAbsolutePaths({ path: '/home/user/voice.wav' })).toEqual(['/home/user/voice.wav']);
      expect(findAbsolutePaths([{ path: 'C:\\voices\\own.wav' }])).toEqual(['C:\\voices\\own.wav']);
      expect(findAbsolutePaths({ nested: { list: ['assets/ok.wav', '\\\\share\\voice.wav'] } })).toEqual(['\\\\share\\voice.wav']);
      // A first-party https evidence URL is not a filesystem path and stays legal.
      expect(findAbsolutePaths({ evidenceUrl: 'https://github.com/hexgrad/kokoro' })).toEqual([]);
    });

    it('23. every declared path in every migrated and authored record is a safe relative path', () => {
      const paths: string[] = [];
      for (const profile of [...MIGRATED_DEFAULT_VOICE_REGISTRY, approvedOwnVoiceProfile()]) {
        const publication = profile.publication!;
        const source = publication.acousticSource;
        if (source?.kind === 'cloned_reference_audio') paths.push(source.referenceAudio.path);
        if (publication.consent?.evidencePath) paths.push(publication.consent.evidencePath);
        if (publication.rights?.localEvidencePath) paths.push(publication.rights.localEvidencePath);
        if (publication.audition?.samplePath) paths.push(publication.audition.samplePath);
        if (publication.audition?.evidencePath) paths.push(publication.audition.evidencePath);
      }
      expect(paths.length).toBeGreaterThan(0);
      for (const value of paths) {
        expect(value.startsWith('/')).toBe(false);
        expect(value.includes('..')).toBe(false);
        expect(findAbsolutePaths(value)).toEqual([]);
      }
    });
  });

  describe('registry validation of publication records', () => {
    it('24. a structurally invalid publication record is rejected by the registry', () => {
      const base = approvedOwnVoiceProfile();
      const publication = base.publication!;
      const referenceAudio = publication.acousticSource!.kind === 'cloned_reference_audio'
        ? publication.acousticSource!.referenceAudio
        : { path: 'assets/x.wav', sha256: 'a'.repeat(64), durationSeconds: 1, sampleRate: 48000, channels: 1 };

      const invalid: Array<[string, VoiceProfile, string]> = [
        ['publicationState', { ...base, publication: { ...publication, publicationState: 'published' } as never }, 'VOICE-REG-041'],
        ['origin', { ...base, publication: { ...publication, origin: 'somewhere' } as never }, 'VOICE-REG-042'],
        ['schemaVersion', { ...base, publication: { ...publication, schemaVersion: '' } }, 'VOICE-REG-043'],
        ['engine kind', { ...base, publication: { ...publication, engine: { ...publication.engine!, engine: 'elevenlabs' } as never } }, 'VOICE-REG-044'],
        ['model id', { ...base, publication: { ...publication, engine: { ...publication.engine!, modelId: '' } } }, 'VOICE-REG-044'],
        ['acoustic kind', { ...base, publication: { ...publication, acousticSource: { kind: 'telepathy' } as never } }, 'VOICE-REG-045'],
        ['absolute reference path', { ...base, publication: { ...publication, acousticSource: { kind: 'cloned_reference_audio', referenceAudio: { ...referenceAudio, path: '/home/user/voice.wav' } } } }, 'VOICE-REG-046'],
        ['absolute consent path', { ...base, publication: { ...publication, consent: { ...publication.consent!, evidencePath: '/etc/consent.md' } } }, 'VOICE-REG-046'],
        ['consent subject', { ...base, publication: { ...publication, consent: { ...publication.consent!, subject: 'nobody' } as never } }, 'VOICE-REG-047'],
        ['consent scope', { ...base, publication: { ...publication, consent: { ...publication.consent!, scope: ['everything'] as never } } }, 'VOICE-REG-048'],
        ['commercialUse', { ...base, publication: { ...publication, rights: { ...publication.rights!, commercialUse: 'maybe' } as never } }, 'VOICE-REG-049'],
        ['audition state', { ...base, publication: { ...publication, audition: { ...publication.audition!, state: 'shrug' } as never } }, 'VOICE-REG-050'],
      ];

      for (const [label, profile, ruleId] of invalid) {
        const report = validateVoiceRegistry([profile]);
        expect(report.valid, label).toBe(false);
        expect(
          report.findings.some((f) => f.ruleId.startsWith(ruleId)),
          `${label}: ${report.findings.map((f) => f.ruleId).join(',')}`
        ).toBe(true);
        expect(() => createVoiceRegistry([profile]), label).toThrow(VoiceResolutionError);
      }
    });

    it('25. a structurally valid but unapproved record is accepted by the registry and blocked by the gate', () => {
      const draft = migrateVoiceProfileForPublication(customVoiceProfile()).profile;
      const report = validateVoiceRegistry([draft, ...MIGRATED_DEFAULT_VOICE_REGISTRY] as VoiceProfile[]);
      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
      expect(evaluateVoicePublicationGate(draft).allowed).toBe(false);
      expect(createVoiceRegistry([draft] as VoiceProfile[]).length).toBe(1);
    });
  });
});
