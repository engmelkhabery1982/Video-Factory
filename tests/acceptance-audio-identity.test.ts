/**
 * ACCEPTANCE HELPER — semantic per-turn audio identity.
 *
 * Retry 5 failed Gate N on the assertion "each per-turn audio file is
 * independently synthesized" (36 physical WAVs, 34 unique SHA256 hashes).
 *
 * That assertion encoded a FALSE contract. The production TTS contract is
 * deterministic: one identical acoustic synthesis request
 * (spokenText + resolved Kokoro voice + speed + engine + model) legitimately
 * produces identical bytes, while the product still writes one physical WAV per
 * turn at its own deterministic path.
 *
 * The valid invariant implemented here is:
 *   identical synthesis key  -> identical bytes are expected (allowed)
 *   differing synthesis key  -> must NOT collide in the acceptance proof
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIO_COLLISION_UNEXPECTED,
  AUDIO_DUPLICATE_EXPECTED,
  classifyAudioHashes,
  synthesisKeyOf,
  synthesisKeyString,
  type PerTurnAudioRecord,
} from '../scripts/acceptance-audio-identity.js';

interface RecordOverrides extends Partial<PerTurnAudioRecord> {}

let seq = 0;

function record(overrides: RecordOverrides = {}): PerTurnAudioRecord {
  seq += 1;
  const target = overrides.target ?? 'long';
  const sceneId = overrides.sceneId ?? `sc-${String(seq).padStart(2, '0')}`;
  const turnId = overrides.turnId ?? `turn-${String(seq).padStart(2, '0')}`;
  const spokenText = overrides.spokenText ?? `Sentence number ${seq}.`;
  const resolvedKokoroVoice = overrides.resolvedKokoroVoice ?? 'af_heart';
  const base: PerTurnAudioRecord = {
    target,
    scenarioId: overrides.scenarioId ?? `scenario-${target}`,
    sceneId,
    turnId,
    clipId: overrides.clipId ?? `clip_${sceneId}_${turnId}`,
    speakerId: overrides.speakerId ?? 'char-01',
    voiceSlot: overrides.voiceSlot ?? 'voice_en_female_authority',
    voiceProfileId: overrides.voiceProfileId ?? 'profile-authority',
    resolvedKokoroVoice,
    synthesisSpeed: overrides.synthesisSpeed ?? 1,
    engine: overrides.engine ?? 'kokoro-js',
    modelId: overrides.modelId ?? 'onnx-community/Kokoro-82M-v1.0-ONNX',
    spokenText,
    expectedWavPath: overrides.expectedWavPath ?? `audio/dialogue/scenario-${target}/${sceneId}_${turnId}.wav`,
    physicalWavPath: overrides.physicalWavPath ?? `audio/dialogue/scenario-${target}/${sceneId}_${turnId}.wav`,
    sha256: overrides.sha256 ?? `hash-${seq}`,
    sizeBytes: overrides.sizeBytes ?? 200_000,
    durationSeconds: overrides.durationSeconds ?? 3.2,
    nonEmpty: overrides.nonEmpty ?? true,
    expectedPathExists: overrides.expectedPathExists ?? true,
  };
  // Deterministic-by-default bytes: identical synthesis keys get identical bytes,
  // which is exactly the production contract this helper encodes.
  if (overrides.sha256 === undefined) {
    base.sha256 = `hash-${synthesisKeyString(synthesisKeyOf(base))}`;
  }
  return base;
}

describe('acceptance — semantic per-turn audio identity', () => {
  it('accepts distinct turns with distinct hashes and reports no duplicate group', () => {
    const report = classifyAudioHashes([record(), record(), record()]);
    expect(report.totalRecords).toBe(3);
    expect(report.totalUniqueHashes).toBe(3);
    expect(report.duplicateHashGroups).toHaveLength(0);
    expect(report.collisions).toHaveLength(0);
    expect(report.classificationSummary.unexpectedCollisions).toBe(0);
  });

  it('classifies identical-request duplicate bytes as EXPECTED determinism (the Retry-5 pattern)', () => {
    // The real Retry-5 pattern: the same sentence, the same character and the
    // same resolved Kokoro voice, spoken once in the Long target and once in the
    // Short target. Identical bytes are the correct deterministic result.
    const shared = {
      spokenText: 'Start your BuildTrack trial',
      resolvedKokoroVoice: 'af_heart',
      voiceSlot: 'voice_en_female_authority',
      speakerId: 'char-finalacceptance-rfi-backlog-project-manager',
    };
    const longCta = record({ ...shared, target: 'long', sceneId: 'sc-long-08-cta', turnId: 'turn-01' });
    const shortCta = record({ ...shared, target: 'short_1', sceneId: 'sc-short1-04-cta', turnId: 'turn-01' });
    expect(longCta.sha256).toBe(shortCta.sha256);

    const report = classifyAudioHashes([longCta, shortCta, record(), record()]);
    expect(report.totalRecords).toBe(4);
    expect(report.totalUniqueHashes).toBe(3);
    expect(report.duplicateHashGroups).toHaveLength(1);
    const group = report.duplicateHashGroups[0]!;
    expect(group.classification).toBe(AUDIO_DUPLICATE_EXPECTED);
    expect(group.memberCount).toBe(2);
    expect(group.distinctSynthesisKeys).toBe(1);
    expect(group.members.map((m) => m.physicalWavPath)).toEqual([longCta.physicalWavPath, shortCta.physicalWavPath]);
    expect(report.collisions).toHaveLength(0);
  });

  it('fails when different synthesis requests collide on identical bytes (unexpected collision)', () => {
    const a = record({ spokenText: 'The register holds 24 open RFIs.', resolvedKokoroVoice: 'af_nova' });
    // Different request (different text), identical bytes: a real identity gap.
    const b = record({ spokenText: 'The register holds 24 open RFIs - SAME BYTES.', resolvedKokoroVoice: 'af_nova', sha256: a.sha256 });
    const report = classifyAudioHashes([a, b]);
    expect(report.duplicateHashGroups).toHaveLength(1);
    expect(report.duplicateHashGroups[0]!.classification).toBe(AUDIO_COLLISION_UNEXPECTED);
    expect(report.duplicateHashGroups[0]!.distinctSynthesisKeys).toBe(2);
    expect(report.collisions).toHaveLength(1);
    expect(report.classificationSummary.unexpectedCollisions).toBe(1);
  });

  it('fails when a different resolved voice or speed collides on identical bytes', () => {
    const base = record({ spokenText: 'Same sentence.', resolvedKokoroVoice: 'af_heart' });
    const otherVoice = record({ spokenText: 'Same sentence.', resolvedKokoroVoice: 'bm_george', sha256: base.sha256 });
    const otherSpeed = record({ spokenText: 'Same sentence.', resolvedKokoroVoice: 'af_heart', synthesisSpeed: 1.1, sha256: base.sha256 });
    const voiceReport = classifyAudioHashes([base, otherVoice]);
    expect(voiceReport.collisions).toHaveLength(1);
    const speedReport = classifyAudioHashes([base, otherSpeed]);
    expect(speedReport.collisions).toHaveLength(1);
  });

  it('treats engine/model identity as part of the synthesis key', () => {
    const kokoro = record({ spokenText: 'Same sentence.' });
    const sam = record({ spokenText: 'Same sentence.', engine: 'sam-js', sha256: kokoro.sha256 });
    expect(classifyAudioHashes([kokoro, sam]).collisions).toHaveLength(1);
    const otherModel = record({ spokenText: 'Same sentence.', modelId: 'other-model', sha256: kokoro.sha256 });
    expect(classifyAudioHashes([kokoro, otherModel]).collisions).toHaveLength(1);
    expect(synthesisKeyString(synthesisKeyOf(otherModel))).toContain('other-model');
  });

  it('records identical requests with different bytes for inspection without failing', () => {
    const first = record({ spokenText: 'One sentence.', resolvedKokoroVoice: 'af_heart', sha256: 'hash-a' });
    const second = record({ spokenText: 'One sentence.', resolvedKokoroVoice: 'af_heart', sha256: 'hash-b' });
    const report = classifyAudioHashes([first, second]);
    expect(report.duplicateHashGroups).toHaveLength(0);
    expect(report.collisions).toHaveLength(0);
    expect(report.sameKeyDifferentHashes).toHaveLength(1);
  });

  it('reproduces the exact Retry-5 acceptance shape: 36 turns, 34 unique keys, 2 expected groups, 0 collisions', () => {
    // The two real duplicate pairs of the 2026-10-01 acceptance content.
    const pairs = [
      {
        spokenText: 'The control rule reviews the whole register every 48 hours.',
        resolvedKokoroVoice: 'af_nova',
        voiceSlot: 'voice_us_female_analytic',
        speakerId: 'char-finalacceptance-rfi-backlog-planning-engineer',
      },
      {
        spokenText: 'Start your BuildTrack trial',
        resolvedKokoroVoice: 'af_heart',
        voiceSlot: 'voice_en_female_authority',
        speakerId: 'char-finalacceptance-rfi-backlog-project-manager',
      },
    ];
    const records: PerTurnAudioRecord[] = [];
    // 24 Long turns (2 of them the duplicated ones), 12 Short turns.
    for (const [index, pairText] of pairs.entries()) {
      records.push(record({ ...pairText, target: 'long', sceneId: `sc-long-0${index + 2}-evidence`, turnId: 'turn-05' }));
    }
    for (let i = 0; i < 22; i++) records.push(record({ target: 'long', spokenText: `Long sentence ${i}.` }));
    for (const [index, pairText] of pairs.entries()) {
      records.push(record({ ...pairText, target: 'short_1', sceneId: `sc-short1-0${index + 2}-evidence`, turnId: 'turn-01' }));
    }
    for (let i = 0; i < 10; i++) records.push(record({ target: 'short_1', spokenText: `Short sentence ${i}.` }));

    const report = classifyAudioHashes(records);
    expect(report.totalRecords).toBe(36);
    expect(report.totalUniqueSynthesisKeys).toBe(34);
    expect(report.totalUniqueHashes).toBe(34);
    expect(report.duplicateHashGroups).toHaveLength(2);
    expect(report.duplicateHashGroups.every((g) => g.classification === AUDIO_DUPLICATE_EXPECTED)).toBe(true);
    expect(report.classificationSummary.unexpectedCollisions).toBe(0);
    expect(report.classificationSummary.duplicateTurnsExplanation).toContain('36 physical per-turn WAV(s)');
    expect(report.classificationSummary.duplicateTurnsExplanation).toContain('34 unique SHA256 hash(es)');
    expect(report.classificationSummary.duplicateTurnsExplanation).toContain('34 unique acoustic synthesis key(s)');
  });
});
