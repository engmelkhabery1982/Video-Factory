/**
 * VS1 FOCUSED TESTS — commercial voice publication gate.
 *
 * Proves the decision boundary that protects published production:
 *
 *   - an approved first-party own voice passes;
 *   - missing, unconfirmed, out-of-scope or REVOKED consent blocks;
 *   - a missing, malformed, unsafe or changed reference-audio identity blocks;
 *   - missing commercial-rights evidence blocks, and a licence that merely does
 *     NOT PROHIBIT commerce is never treated as permission;
 *   - `review_only` and `draft` never publish;
 *   - a rejected or not-tested audition blocks, and an approval stamp on an
 *     incomplete record is not approval;
 *   - a missing engine/model identity blocks;
 *   - the gate is deterministic and its findings are structured.
 *
 * Pure contract tests: no I/O, no network, no synthesis, no render.
 */

import { describe, expect, it } from 'vitest';
import { evaluateVoicePublicationGate, evaluateVoicePublicationGateForVoices, assertVoicesApprovedForProduction, VOICE_PUBLICATION_GATE_RULE_IDS, isSafeRelativeVoicePath, isSha256Hex, isIso8601Timestamp } from '../packages/core/src/scenario/voice-publication-gate.js';
import { DEFAULT_VOICE_REGISTRY } from '../packages/core/src/scenario/voice-registry.js';
import { migrateVoiceProfileForPublication } from '../packages/core/src/scenario/voice-publication-migration.js';
import { VoiceResolutionError } from '../packages/core/src/scenario/voice-types.js';
import {
  approvedOwnVoiceProfile,
  errorCodes,
  OWN_VOICE_REFERENCE,
  OWN_VOICE_REFERENCE_SHA256_ALT,
  patchPublicationField,
  warningCodes,
  withPublication,
} from './helpers/voice-publication-fixtures.js';

/** A migrated legacy Kokoro fixture: the "existing behaviour must not regress" case. */
const legacyKokoroProfile = migrateVoiceProfileForPublication(DEFAULT_VOICE_REGISTRY[0]).profile;

describe('VS1 — commercial voice publication gate', () => {
  describe('approved voices pass', () => {
    it('1. an approved first-party own voice passes with no blocking findings', () => {
      const report = evaluateVoicePublicationGate(approvedOwnVoiceProfile());
      expect(report.allowed).toBe(true);
      expect(report.blocked).toBe(false);
      expect(report.errorCount).toBe(0);
      expect(report.warningCount).toBe(0);
      expect(report.publicationState).toBe('approved');
      expect(report.origin).toBe('authored_first_party');
      expect(report.engine.engine).toBe('chatterbox');
      expect(report.engine.modelId).toBe('local/chatterbox-voice-clone');
      expect(report.engine.modelRevision).toBe('v0.5.0');
      expect(report.acousticIdentity.referenceSha256).toBe(OWN_VOICE_REFERENCE.sha256);
      expect(report.acousticIdentity.acousticSourceId).toBe(`ref:${OWN_VOICE_REFERENCE.sha256}`);
    });

    it('2. a legacy Kokoro fixture passes whether the gate migrates it or it arrives pre-migrated', () => {
      // The raw Phase 4A fixture: no publication record at all.
      const rawFixture = DEFAULT_VOICE_REGISTRY[0];
      expect('publication' in rawFixture).toBe(false);

      const fromRaw = evaluateVoicePublicationGate(rawFixture);
      expect(fromRaw.allowed).toBe(true);
      expect(fromRaw.errorCount).toBe(0);
      expect(fromRaw.migrated).toBe(true);
      expect(fromRaw.publicationState).toBe('approved');
      expect(fromRaw.origin).toBe('legacy_kokoro_fixture');
      expect(fromRaw.engine.engine).toBe('kokoro');
      expect(fromRaw.engine.modelId).toBe('onnx-community/Kokoro-82M-v1.0-ONNX');
      expect(fromRaw.acousticIdentity.acousticSourceId).toBe('preset:af_heart');

      // The same fixture after the migration ran upstream: identical verdict.
      const preMigrated = evaluateVoicePublicationGate(legacyKokoroProfile);
      expect(preMigrated.migrated).toBe(false);
      expect(JSON.stringify(preMigrated.findings)).toBe(JSON.stringify(fromRaw.findings));
      expect(preMigrated.allowed).toBe(true);

      // Disabling migration judges exactly what was handed in: nothing declared.
      const strict = evaluateVoicePublicationGate(rawFixture, { migrateLegacy: false });
      expect(strict.allowed).toBe(false);
      expect(errorCodes(strict)).toContain('MISSING_PUBLICATION_RECORD');
    });

    it('3. the report is deterministic: same input twice yields identical findings', () => {
      const profile = approvedOwnVoiceProfile();
      const first = evaluateVoicePublicationGate(profile);
      const second = evaluateVoicePublicationGate(profile);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(second.findings.map((f) => f.ruleId)).toEqual(first.findings.map((f) => f.ruleId));
    });

    it('4. a review_only voice is allowed when the caller only needs review_only', () => {
      const review = withPublication(approvedOwnVoiceProfile(), { publicationState: 'review_only' });
      expect(evaluateVoicePublicationGate(review).allowed).toBe(false);
      expect(evaluateVoicePublicationGate(review, { requiredPublicationState: 'review_only' }).allowed).toBe(true);
    });

    it('5. every gate code has a stable rule id', () => {
      const ids = Object.values(VOICE_PUBLICATION_GATE_RULE_IDS);
      expect(ids.length).toBe(Object.keys(VOICE_PUBLICATION_GATE_RULE_IDS).length);
      expect(ids.every((id) => /^VOICE-PUB-\d{3}-[A-Z0-9-]+$/.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('6. a malformed profile is blocked instead of crashing the gate', () => {
      for (const bad of [null, undefined, {}, { id: 'x' }, { voiceSlot: 'y' }]) {
        const report = evaluateVoicePublicationGate(bad as never);
        expect(report.allowed).toBe(false);
        expect(errorCodes(report)).toContain('MALFORMED_PROFILE');
      }
    });
  });

  describe('consent blocks', () => {
    it('7. missing consent blocks publication', () => {
      const report = evaluateVoicePublicationGate(patchPublicationField(approvedOwnVoiceProfile(), 'consent', undefined));
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('MISSING_CONSENT');
    });

    it('8. revoked consent blocks publication permanently', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'consent', {
          revoked: true,
          revokedAt: '2026-10-07T09:00:00Z',
          revocationReason: 'Speaker withdrew permission',
        })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('CONSENT_REVOKED');
      const finding = report.findings.find((f) => f.code === 'CONSENT_REVOKED');
      expect(finding?.message).toContain('Speaker withdrew permission');
    });

    it('9. consent that is not the boolean true blocks (never inferred)', () => {
      for (const value of [false, 'yes', 1, null, undefined]) {
        const report = evaluateVoicePublicationGate(
          patchPublicationField(approvedOwnVoiceProfile(), 'consent', { ownerConfirmed: value })
        );
        expect(report.allowed).toBe(false);
        expect(errorCodes(report)).toContain('CONSENT_NOT_CONFIRMED');
      }
    });

    it('10. consent recorded for a narrower use does not authorise commercial publication', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'consent', { scope: ['internal_review'] })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('CONSENT_SCOPE_INSUFFICIENT');
      // The same record IS enough for an internal review build.
      expect(
        evaluateVoicePublicationGate(
          patchPublicationField(approvedOwnVoiceProfile(), 'consent', { scope: ['internal_review'] }),
          { requiredConsentScope: 'internal_review', requiredPublicationState: 'review_only' }
        ).allowed
      ).toBe(true);
    });

    it('11. consent without a recorded timestamp, or with a non-ISO one, blocks', () => {
      const missing = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'consent', { recordedAt: undefined })
      );
      expect(errorCodes(missing)).toContain('MISSING_CONSENT_TIMESTAMP');

      const invalid = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'consent', { recordedAt: 'last tuesday' })
      );
      expect(errorCodes(invalid)).toContain('INVALID_CONSENT_TIMESTAMP');
      expect(invalid.allowed).toBe(false);
    });

    it("12. a cloned human voice without a consent artifact blocks", () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'consent', { evidencePath: undefined })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('MISSING_CONSENT_EVIDENCE');
    });

    it('13. an unsafe consent artifact path blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'consent', { evidencePath: '/etc/secrets/consent.md' })
      );
      expect(errorCodes(report)).toContain('UNSAFE_CONSENT_EVIDENCE_PATH');
    });

    it('14. a cloned voice cannot borrow a model provider preset consent', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'consent', { subject: 'model_provider_preset' })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('CONSENT_SUBJECT_MISMATCH');
    });

    it('15. a preset model voice must not claim a human consent it never got', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(legacyKokoroProfile, 'consent', { subject: 'recorded_speaker' })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('CONSENT_SUBJECT_MISMATCH');
    });

    it('16. an ambiguous revocation state is reported', () => {
      const inconsistent = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'consent', { revoked: false, revokedAt: '2026-10-07T09:00:00Z' })
      );
      expect(inconsistent.allowed).toBe(true);
      expect(warningCodes(inconsistent)).toContain('REVOCATION_STATE_INCONSISTENT');

      const undated = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'consent', { revoked: true })
      );
      expect(undated.allowed).toBe(false);
      expect(warningCodes(undated)).toContain('REVOCATION_STATE_INCONSISTENT');
    });
  });

  describe('reference-audio identity blocks', () => {
    it('17. a missing acoustic source blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'acousticSource', undefined)
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('MISSING_ACOUSTIC_SOURCE');
    });

    it('18. a missing reference hash blocks', () => {
      const profile = approvedOwnVoiceProfile();
      profile.publication!.acousticSource = {
        kind: 'cloned_reference_audio',
        referenceAudio: { ...OWN_VOICE_REFERENCE, sha256: '' },
      };
      const report = evaluateVoicePublicationGate(profile);
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('MISSING_REFERENCE_HASH');
    });

    it('19. a malformed reference hash blocks', () => {
      for (const sha256 of ['DEADBEEF', '6d56830a', 'zz56830ac9693156d339040aa45e4fac875f2254c42cf3a39bdbbcf2f79bc68']) {
        const profile = approvedOwnVoiceProfile();
        profile.publication!.acousticSource = { kind: 'cloned_reference_audio', referenceAudio: { ...OWN_VOICE_REFERENCE, sha256 } };
        const report = evaluateVoicePublicationGate(profile);
        expect(report.allowed).toBe(false);
        expect(errorCodes(report)).toContain('INVALID_REFERENCE_HASH');
      }
    });

    it('20. a changed reference recording is a different acoustic identity', () => {
      const original = evaluateVoicePublicationGate(approvedOwnVoiceProfile());
      const changed = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'acousticSource', {
          kind: 'cloned_reference_audio',
          referenceAudio: { ...OWN_VOICE_REFERENCE, sha256: OWN_VOICE_REFERENCE_SHA256_ALT },
        })
      );
      expect(changed.allowed).toBe(true);
      expect(changed.acousticIdentity.referenceSha256).not.toBe(original.acousticIdentity.referenceSha256);
      expect(changed.acousticIdentity.acousticSourceId).not.toBe(original.acousticIdentity.acousticSourceId);
    });

    it('21. an absolute or traversing reference path blocks', () => {
      for (const path of ['/home/user/voice.wav', 'C:\\voices\\own.wav', '\\\\share\\voice.wav', '../../etc/voice.wav', '~/voice.wav']) {
        const report = evaluateVoicePublicationGate(
          patchPublicationField(approvedOwnVoiceProfile(), 'acousticSource', {
            kind: 'cloned_reference_audio',
            referenceAudio: { ...OWN_VOICE_REFERENCE, path },
          })
        );
        expect(report.allowed).toBe(false);
        expect(errorCodes(report)).toContain('UNSAFE_REFERENCE_PATH');
        expect(isSafeRelativeVoicePath(path)).toBe(false);
      }
      expect(isSafeRelativeVoicePath('assets/voices/own-voice/reference-take-01.wav')).toBe(true);
    });

    it('22. invalid reference metrics block', () => {
      for (const metrics of [
        { durationSeconds: 0 },
        { durationSeconds: -1 },
        { durationSeconds: Number.NaN },
        { sampleRate: 0 },
        { channels: 0 },
        { channels: 1.5 },
      ]) {
        const report = evaluateVoicePublicationGate(
          patchPublicationField(approvedOwnVoiceProfile(), 'acousticSource', {
            kind: 'cloned_reference_audio',
            referenceAudio: { ...OWN_VOICE_REFERENCE, ...metrics },
          })
        );
        expect(report.allowed).toBe(false);
        expect(errorCodes(report)).toContain('INVALID_REFERENCE_METRICS');
      }
    });

    it('23. a preset voice without an identified preset blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(legacyKokoroProfile, 'acousticSource', { kind: 'preset_model_voice', presetVoiceId: '', bundledBy: 'kokoro-js' })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('MISSING_PRESET_VOICE_ID');
    });

    it('24. an unknown acoustic source kind blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'acousticSource', { kind: 'telepathy' })
      );
      expect(errorCodes(report)).toContain('INVALID_ACOUSTIC_SOURCE_KIND');
    });
  });

  describe('commercial-rights evidence blocks', () => {
    it('25. missing rights evidence blocks', () => {
      const report = evaluateVoicePublicationGate(patchPublicationField(approvedOwnVoiceProfile(), 'rights', undefined));
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('MISSING_RIGHTS_EVIDENCE');
    });

    it('26. a licence that does not PROHIBIT commerce is not permission (unknown blocks)', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'rights', { commercialUse: 'unknown' })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('COMMERCIAL_USE_NOT_ESTABLISHED');
      const finding = report.findings.find((f) => f.code === 'COMMERCIAL_USE_NOT_ESTABLISHED');
      expect(finding?.message).toContain('NOT permission');
    });

    it('27. a licence silent on commerce is not permission (not_stated blocks)', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'rights', { commercialUse: 'not_stated' })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('COMMERCIAL_USE_NOT_ESTABLISHED');
    });

    it('28. omitting commercialUse entirely blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'rights', { commercialUse: undefined })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('COMMERCIAL_USE_NOT_ESTABLISHED');
    });

    it('29. a conditional grant is not a permission until the conditions are resolved', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'rights', {
          commercialUse: 'conditional',
          conditions: 'Attribution plus a paid licence above 10k views',
        })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('COMMERCIAL_USE_NOT_PERMITTED');
      expect(report.findings.find((f) => f.code === 'COMMERCIAL_USE_NOT_PERMITTED')?.message).toContain('Attribution');
    });

    it('30. an explicit prohibition blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'rights', { commercialUse: 'prohibited' })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('COMMERCIAL_USE_NOT_PERMITTED');
    });

    it('31. incomplete rights evidence blocks: provider, licence, URL and access date are all required', () => {
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ['sourceProvider', { sourceProvider: '' }, 'MISSING_RIGHTS_PROVIDER'],
        ['licenseName', { licenseName: '   ' }, 'MISSING_LICENSE_NAME'],
        ['evidenceUrl', { evidenceUrl: undefined }, 'MISSING_RIGHTS_EVIDENCE_URL'],
        ['evidenceUrl', { evidenceUrl: 'ftp://files.example.invalid/licence.txt' }, 'INVALID_RIGHTS_EVIDENCE_URL'],
        ['accessedAt', { accessedAt: undefined }, 'MISSING_RIGHTS_ACCESS_DATE'],
        ['accessedAt', { accessedAt: 'sometime last year' }, 'INVALID_RIGHTS_ACCESS_DATE'],
      ];
      for (const [, patch, expected] of cases) {
        const report = evaluateVoicePublicationGate(patchPublicationField(approvedOwnVoiceProfile(), 'rights', patch));
        expect(report.allowed).toBe(false);
        expect(errorCodes(report)).toContain(expected);
      }
    });

    it('32. an unsafe local evidence path blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'rights', { localEvidencePath: '/var/tmp/licence.md' })
      );
      expect(errorCodes(report)).toContain('UNSAFE_RIGHTS_EVIDENCE_PATH');
    });

    it('33. migration-recorded rights evidence warns, and blocks under strict first-party evidence', () => {
      const normal = evaluateVoicePublicationGate(legacyKokoroProfile);
      expect(normal.allowed).toBe(true);
      expect(warningCodes(normal)).toContain('RIGHTS_EVIDENCE_NOT_FIRST_PARTY');

      const strict = evaluateVoicePublicationGate(legacyKokoroProfile, { strictFirstPartyEvidence: true });
      expect(strict.allowed).toBe(false);
      expect(errorCodes(strict)).toContain('RIGHTS_EVIDENCE_NOT_FIRST_PARTY');
    });
  });

  describe('audition and publication state block', () => {
    it('34. a not-tested audition blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'audition', { state: 'not_tested', approver: undefined, reviewedAt: undefined })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('AUDITION_NOT_TESTED');
    });

    it('35. a rejected audition blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'audition', { state: 'rejected', reason: 'Sibilance on the reference take' })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('AUDITION_REJECTED');
      expect(report.findings.find((f) => f.code === 'AUDITION_REJECTED')?.message).toContain('Sibilance');
    });

    it('36. a missing audition record blocks', () => {
      const report = evaluateVoicePublicationGate(patchPublicationField(approvedOwnVoiceProfile(), 'audition', undefined));
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('MISSING_AUDITION');
    });

    it('37. an approval with no named approver or no timestamp blocks', () => {
      const noApprover = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'audition', { approver: undefined })
      );
      expect(errorCodes(noApprover)).toContain('MISSING_AUDITION_APPROVER');

      const noTimestamp = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'audition', { reviewedAt: undefined })
      );
      expect(errorCodes(noTimestamp)).toContain('MISSING_AUDITION_TIMESTAMP');

      const badTimestamp = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'audition', { reviewedAt: '06/10/2026' })
      );
      expect(errorCodes(badTimestamp)).toContain('INVALID_AUDITION_TIMESTAMP');
      expect(badTimestamp.allowed).toBe(false);
    });

    it('38. review_only blocks published production', () => {
      const report = evaluateVoicePublicationGate(withPublication(approvedOwnVoiceProfile(), { publicationState: 'review_only' }));
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('PUBLICATION_STATE_NOT_APPROVED');
      expect(report.findings.find((f) => f.code === 'PUBLICATION_STATE_NOT_APPROVED')?.message).toContain('never published production');
    });

    it('39. draft blocks published production', () => {
      const report = evaluateVoicePublicationGate(withPublication(approvedOwnVoiceProfile(), { publicationState: 'draft' }));
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('PUBLICATION_STATE_NOT_APPROVED');
    });

    it('40. an unknown publication state blocks', () => {
      const report = evaluateVoicePublicationGate(withPublication(approvedOwnVoiceProfile(), { publicationState: 'published' }));
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('PUBLICATION_STATE_NOT_APPROVED');
    });

    it('41. an approval stamp on an incomplete record is not approval', () => {
      const stamped = patchPublicationField(approvedOwnVoiceProfile(), 'consent', undefined);
      expect(stamped.publication!.publicationState).toBe('approved');
      const report = evaluateVoicePublicationGate(stamped);
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('PUBLICATION_APPROVED_WITHOUT_EVIDENCE');
      expect(errorCodes(report)).toContain('MISSING_CONSENT');
    });

    it('42. an inherited approval warns by default and blocks under strict first-party evidence', () => {
      const normal = evaluateVoicePublicationGate(legacyKokoroProfile);
      expect(normal.allowed).toBe(true);
      expect(warningCodes(normal)).toContain('AUDITION_APPROVAL_INHERITED');

      const strict = evaluateVoicePublicationGate(legacyKokoroProfile, { strictFirstPartyEvidence: true });
      expect(strict.allowed).toBe(false);
      expect(errorCodes(strict)).toContain('AUDITION_APPROVAL_INHERITED');
    });

    it('43. a first-party (non-inherited) audition carries no warnings at all', () => {
      const report = evaluateVoicePublicationGate(approvedOwnVoiceProfile(), { strictFirstPartyEvidence: true });
      expect(report.allowed).toBe(true);
      expect(report.warningCount).toBe(0);
      expect(report.errorCount).toBe(0);
    });

    it('44. an unsafe audition sample path blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'audition', { samplePath: '/absolute/audition.wav' })
      );
      expect(errorCodes(report)).toContain('UNSAFE_AUDITION_SAMPLE_PATH');
    });
  });

  describe('engine and model identity block', () => {
    it('45. a missing engine identity blocks', () => {
      const report = evaluateVoicePublicationGate(patchPublicationField(approvedOwnVoiceProfile(), 'engine', undefined));
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('MISSING_ENGINE_IDENTITY');
    });

    it('46. a missing model id blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'engine', { modelId: '' })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('MISSING_MODEL_ID');
    });

    it('47. an unknown engine family blocks', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'engine', { engine: 'elevenlabs' })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('INVALID_ENGINE_KIND');
    });

    it('48. an external engine must name its provider', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'engine', { engine: 'external', provider: undefined })
      );
      expect(report.allowed).toBe(false);
      expect(errorCodes(report)).toContain('MISSING_EXTERNAL_PROVIDER');
    });

    it('49. an empty pinned revision blocks (a pin must be a real pin)', () => {
      const report = evaluateVoicePublicationGate(
        patchPublicationField(approvedOwnVoiceProfile(), 'engine', { modelRevision: '  ' })
      );
      expect(errorCodes(report)).toContain('MISSING_MODEL_ID');
    });

    it('50. a declared engine that disagrees with the engine that would run blocks', () => {
      const mismatch = evaluateVoicePublicationGate(approvedOwnVoiceProfile(), {
        declaredEngineMustMatch: { engineId: 'sam-js', modelId: null },
      });
      expect(mismatch.allowed).toBe(false);
      expect(errorCodes(mismatch)).toContain('ENGINE_DECLARATION_MISMATCH');

      const match = evaluateVoicePublicationGate(legacyKokoroProfile, {
        declaredEngineMustMatch: { engineId: 'kokoro-js', modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX' },
      });
      expect(errorCodes(match)).not.toContain('ENGINE_DECLARATION_MISMATCH');

      const modelMismatch = evaluateVoicePublicationGate(legacyKokoroProfile, {
        declaredEngineMustMatch: { engineId: 'kokoro-js', modelId: 'some-other/model' },
      });
      expect(errorCodes(modelMismatch)).toContain('ENGINE_DECLARATION_MISMATCH');
    });
  });

  describe('batch evaluation and the hard production gate', () => {
    it('51. a mixed batch reports exactly the blocked slots, deterministically', () => {
      const approved = approvedOwnVoiceProfile();
      const blockedVoice = patchPublicationField(approvedOwnVoiceProfile(), 'consent', undefined);
      blockedVoice.id = 'vp_own_voice_blocked_v1';
      blockedVoice.voiceSlot = 'voice_own_blocked';

      const report = evaluateVoicePublicationGateForVoices([blockedVoice, approved, legacyKokoroProfile]);
      expect(report.allowed).toBe(false);
      expect(report.blockedSlots).toEqual(['voice_own_blocked']);
      expect(report.reports.map((r) => r.voiceSlot)).toEqual([
        'voice_en_female_authority',
        'voice_own_blocked',
        'voice_own_operator',
      ]);
      expect(JSON.stringify(evaluateVoicePublicationGateForVoices([approved, blockedVoice, legacyKokoroProfile]))).toBe(
        JSON.stringify(report)
      );
    });

    it('52. an all-approved batch is allowed', () => {
      const report = evaluateVoicePublicationGateForVoices([approvedOwnVoiceProfile(), legacyKokoroProfile]);
      expect(report.allowed).toBe(true);
      expect(report.blockedSlots).toEqual([]);
      expect(report.reports.length).toBe(2);
    });

    it('53. assertVoicesApprovedForProduction throws a structured error for an unapproved voice', () => {
      const blocked = patchPublicationField(approvedOwnVoiceProfile(), 'rights', undefined);
      let thrown: unknown;
      try {
        assertVoicesApprovedForProduction([blocked]);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(VoiceResolutionError);
      const err = thrown as VoiceResolutionError;
      expect(err.code).toBe('VOICE_PUBLICATION_BLOCKED');
      expect(err.message).toContain('voice_own_operator');
      expect(err.message).toContain('MISSING_RIGHTS_EVIDENCE');
      expect((err.details as { blockedSlots: string[] }).blockedSlots).toEqual(['voice_own_operator']);
    });

    it('54. assertVoicesApprovedForProduction returns the report when every voice is approved', () => {
      const report = assertVoicesApprovedForProduction([approvedOwnVoiceProfile(), legacyKokoroProfile]);
      expect(report.allowed).toBe(true);
      expect(report.reports.length).toBe(2);
    });

    it('55. an empty voice set is blocked rather than vacuously allowed', () => {
      expect(() => assertVoicesApprovedForProduction([])).toThrow(VoiceResolutionError);
      expect(evaluateVoicePublicationGateForVoices([]).allowed).toBe(false);
    });
  });

  describe('validators used by the gate', () => {
    it('56. hash, timestamp and URL validators accept real values and reject lookalikes', () => {
      expect(isSha256Hex(OWN_VOICE_REFERENCE.sha256)).toBe(true);
      expect(isSha256Hex(OWN_VOICE_REFERENCE.sha256.toUpperCase())).toBe(false);
      expect(isSha256Hex('abc')).toBe(false);

      expect(isIso8601Timestamp('2026-10-06T10:15:00Z')).toBe(true);
      expect(isIso8601Timestamp('2026-10-06')).toBe(true);
      expect(isIso8601Timestamp('2026-09-29T00:00:00Z')).toBe(true);
      expect(isIso8601Timestamp('06/10/2026')).toBe(false);
      expect(isIso8601Timestamp(1_700_000_000)).toBe(false);

      expect(isSafeRelativeVoicePath('assets/voices/own-voice/consent-signed.md')).toBe(true);
      expect(isSafeRelativeVoicePath('./assets/consent.md')).toBe(false);
      expect(isSafeRelativeVoicePath('assets//consent.md')).toBe(false);
      expect(isSafeRelativeVoicePath('')).toBe(false);
    });
  });
});
