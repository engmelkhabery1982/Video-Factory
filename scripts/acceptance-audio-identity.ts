/**
 * ACCEPTANCE — SEMANTIC PER-TURN AUDIO IDENTITY.
 *
 * TEST INFRASTRUCTURE ONLY (no product behaviour).
 *
 * Why this exists
 * ---------------
 * The production TTS contract is DETERMINISTIC:
 *
 *     same spokenText + same resolved Kokoro voice + same speed
 *     + same engine/model  ->  identical waveform bytes
 *
 * while the product still writes one physical WAV per dialogue turn at the
 * deterministic path `<basePath>/<scenarioId>/<sceneId>_<turnId>.wav`.
 *
 * So "every physical WAV must have a unique SHA256" is NOT a valid product
 * contract: two turns that legitimately share one acoustic synthesis request
 * (for example the same CTA sentence spoken by the same character in the Long
 * target and in the Short target) MUST produce identical bytes — and the
 * acceptance must not call that a failure.
 *
 * The valid invariant is therefore SEMANTIC:
 *
 *   identical synthesis key   -> identical bytes are allowed (and expected)
 *   differing synthesis key   -> must NOT collide in this acceptance proof
 *
 * This module implements that invariant as a pure function over per-turn
 * records so it can be unit-tested and reused by the acceptance driver.
 */

/** The acoustic inputs that determine the waveform bytes of one turn. */
export interface SynthesisKey {
  /** normalized/exact spokenText passed to the engine */
  spokenText: string;
  /** resolved Kokoro voice id (e.g. 'af_heart') */
  resolvedKokoroVoice: string;
  /** synthesis speed (production contract: 1) */
  synthesisSpeed: number;
  /** synthesis engine identity */
  engine: string;
  /** model identity */
  modelId: string;
}

/** One per-turn synthesis result as measured on disk by the acceptance run. */
export interface PerTurnAudioRecord {
  target: string;
  scenarioId: string;
  sceneId: string;
  turnId: string;
  clipId: string;
  speakerId: string;
  voiceSlot: string;
  voiceProfileId: string | null;
  resolvedKokoroVoice: string;
  synthesisSpeed: number;
  engine: string;
  modelId: string;
  spokenText: string;
  /** repo-relative deterministic path the product MUST have written */
  expectedWavPath: string;
  /** repo-relative path actually measured (equals expectedWavPath when verified) */
  physicalWavPath: string;
  sha256: string;
  sizeBytes: number;
  durationSeconds: number | null;
  nonEmpty: boolean;
  expectedPathExists: boolean;
}

export const AUDIO_DUPLICATE_EXPECTED = 'expected_deterministic_duplicate' as const;
export const AUDIO_COLLISION_UNEXPECTED = 'unexpected_collision' as const;

export type AudioDuplicateClassification =
  | typeof AUDIO_DUPLICATE_EXPECTED
  | typeof AUDIO_COLLISION_UNEXPECTED;

export interface DuplicateHashGroupMember {
  target: string;
  scenarioId: string;
  sceneId: string;
  turnId: string;
  clipId: string;
  speakerId: string;
  voiceSlot: string;
  resolvedKokoroVoice: string;
  spokenText: string;
  sha256: string;
  physicalWavPath: string;
  synthesisKey: SynthesisKey;
}

export interface DuplicateHashGroup {
  sha256: string;
  memberCount: number;
  members: DuplicateHashGroupMember[];
  /** distinct synthesis keys inside this hash group (1 = legitimate determinism) */
  distinctSynthesisKeys: number;
  classification: AudioDuplicateClassification;
  note: string;
}

export interface SameKeyDifferentHashPair {
  synthesisKey: SynthesisKey;
  members: Array<{ target: string; sceneId: string; turnId: string; sha256: string; physicalWavPath: string }>;
  note: string;
}

export interface AudioIdentityReport {
  totalRecords: number;
  totalUniqueHashes: number;
  totalUniqueSynthesisKeys: number;
  duplicateHashGroups: DuplicateHashGroup[];
  /** hash groups whose members do NOT share one synthesis key: hard failure */
  collisions: DuplicateHashGroup[];
  /**
   * Turns that share one synthesis key but produced different bytes. Allowed by
   * the invariant (identical request => identical bytes is permitted, not
   * required), but recorded for inspection.
   */
  sameKeyDifferentHashes: SameKeyDifferentHashPair[];
  classificationSummary: {
    expectedDeterministicDuplicates: number;
    unexpectedCollisions: number;
    duplicateTurnsExplanation: string;
  };
}

/** The acoustic synthesis key of a record, canonicalized for comparison. */
export function synthesisKeyOf(record: {
  spokenText: string;
  resolvedKokoroVoice: string;
  synthesisSpeed: number;
  engine: string;
  modelId: string;
}): SynthesisKey {
  return {
    spokenText: record.spokenText,
    resolvedKokoroVoice: record.resolvedKokoroVoice,
    synthesisSpeed: record.synthesisSpeed,
    engine: record.engine,
    modelId: record.modelId,
  };
}

/** Stable serialization of a synthesis key (used for grouping + evidence). */
export function synthesisKeyString(key: SynthesisKey): string {
  return JSON.stringify([
    key.spokenText,
    key.resolvedKokoroVoice,
    key.synthesisSpeed,
    key.engine,
    key.modelId,
  ]);
}

/**
 * Group per-turn records by SHA256 and classify every duplicate group.
 *
 * A duplicate group is legitimate ("expected_deterministic_duplicate") exactly
 * when all of its members share ONE synthesis key. If any two members differ in
 * spokenText, resolved voice, speed, engine or model while the bytes are
 * identical, the group is an "unexpected_collision" and must fail acceptance.
 */
export function classifyAudioHashes(records: readonly PerTurnAudioRecord[]): AudioIdentityReport {
  const byHash = new Map<string, PerTurnAudioRecord[]>();
  for (const record of records) {
    const list = byHash.get(record.sha256);
    if (list) list.push(record);
    else byHash.set(record.sha256, [record]);
  }

  const duplicateHashGroups: DuplicateHashGroup[] = [];
  for (const [sha256, members] of [...byHash.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (members.length < 2) continue;
    const keys = new Set(members.map((m) => synthesisKeyString(synthesisKeyOf(m))));
    const classification: AudioDuplicateClassification =
      keys.size === 1 ? AUDIO_DUPLICATE_EXPECTED : AUDIO_COLLISION_UNEXPECTED;
    duplicateHashGroups.push({
      sha256,
      memberCount: members.length,
      members: members.map((m) => ({
        target: m.target,
        scenarioId: m.scenarioId,
        sceneId: m.sceneId,
        turnId: m.turnId,
        clipId: m.clipId,
        speakerId: m.speakerId,
        voiceSlot: m.voiceSlot,
        resolvedKokoroVoice: m.resolvedKokoroVoice,
        spokenText: m.spokenText,
        sha256: m.sha256,
        physicalWavPath: m.physicalWavPath,
        synthesisKey: synthesisKeyOf(m),
      })),
      distinctSynthesisKeys: keys.size,
      classification,
      note:
        classification === AUDIO_DUPLICATE_EXPECTED
          ? 'every member shares one identical acoustic synthesis request, so identical bytes are the expected deterministic result'
          : 'members differ in the acoustic synthesis request but produced identical bytes: real audio identity gap',
    });
  }

  // Same key, different bytes (allowed, recorded for inspection).
  const byKey = new Map<string, PerTurnAudioRecord[]>();
  for (const record of records) {
    const k = synthesisKeyString(synthesisKeyOf(record));
    const list = byKey.get(k);
    if (list) list.push(record);
    else byKey.set(k, [record]);
  }
  const sameKeyDifferentHashes: SameKeyDifferentHashPair[] = [];
  for (const [, members] of byKey) {
    if (members.length < 2) continue;
    if (new Set(members.map((m) => m.sha256)).size < 2) continue;
    sameKeyDifferentHashes.push({
      synthesisKey: synthesisKeyOf(members[0]!),
      members: members.map((m) => ({
        target: m.target,
        sceneId: m.sceneId,
        turnId: m.turnId,
        sha256: m.sha256,
        physicalWavPath: m.physicalWavPath,
      })),
      note: 'one identical acoustic synthesis request produced different bytes; permitted by the invariant, recorded for inspection',
    });
  }

  const collisions = duplicateHashGroups.filter((g) => g.classification === AUDIO_COLLISION_UNEXPECTED);
  const expectedDuplicates = duplicateHashGroups.filter((g) => g.classification === AUDIO_DUPLICATE_EXPECTED);

  return {
    totalRecords: records.length,
    totalUniqueHashes: byHash.size,
    totalUniqueSynthesisKeys: byKey.size,
    duplicateHashGroups,
    collisions,
    sameKeyDifferentHashes,
    classificationSummary: {
      expectedDeterministicDuplicates: expectedDuplicates.length,
      unexpectedCollisions: collisions.length,
      duplicateTurnsExplanation:
        `${records.length} physical per-turn WAV(s), ${byHash.size} unique SHA256 hash(es), ` +
        `${byKey.size} unique acoustic synthesis key(s). ` +
        `${records.length - byHash.size} turn(s) share bytes with another turn; ` +
        `${expectedDuplicates.length} duplicate group(s) are identical-request determinism, ` +
        `${collisions.length} group(s) differ in the request and are collisions.`,
    },
  };
}
