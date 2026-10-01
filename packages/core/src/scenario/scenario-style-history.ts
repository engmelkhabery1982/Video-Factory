/**
 * Workstream D — semantic production-style history.
 *
 * A style fingerprint must describe *semantic* production style so it is
 * comparable across DIFFERENT videos. It deliberately contains no
 * project-specific identifier (videoId, projectId, scenarioId, sceneId) and no
 * character id that embeds a project slug: those are unique per video, so any
 * fingerprint built from them would be trivially different every time and
 * avoidance could never fire.
 *
 * What a fingerprint carries instead:
 *   - casting            `role:personaKey` pairs (COMPLETE persona keys)
 *   - opening            opening-scene participants + treatment + setting
 *   - shotSeq            ordered shot types
 *   - framingSeq         ordered framing alignments
 *   - cameraSeq          ordered camera movements
 *   - settingMix         distinct semantic setting types
 *
 * Everything here is pure and deterministic — no clocks, no randomness.
 */

import type { ScenarioPersonaHistoryEntry } from './scenario-generation-types.js';

/** How many recent production observations style avoidance considers. */
export const MAX_STYLE_HISTORY_ENTRIES = 5;

/** Semantic style fingerprint of ONE generated scenario. */
export interface ScenarioStyleFingerprint {
  /** Sorted `narrativeFunction:personaKey` pairs, e.g. `challenger:commercial-lead`. */
  cast: string[];
  /** Opening-scene configuration (participants, treatment and setting). */
  opening: {
    /** Sorted narrative roles participating in the opening scene. */
    participants: string[];
    shotType: string;
    framing: string;
    cameraMovement: string;
    speakerFocus: string;
    settingType: string;
  };
  /** Ordered shot types across the scenario's scenes. */
  shotSeq: string[];
  framingSeq: string[];
  cameraSeq: string[];
  /** Ordered setting types across the scenario's scenes. */
  settingSeq: string[];
  /** Sorted distinct setting types used anywhere in the scenario. */
  settingMix: string[];
}

/** Per-target style fingerprints of one production (Long + Shorts). */
export interface ScenarioStyleFingerprintSet {
  schema: number;
  targets: Record<string, ScenarioStyleFingerprint>;
}

/** Deterministic style variation to apply to the default visual treatment. */
export interface ScenarioStyleVariation {
  /** Rotation applied to the purpose shot inside the shot vocabulary. */
  shotOffset: number;
  /** Rotation applied to the framing cycle index. */
  framingOffset: number;
  /** Rotation applied to the camera-movement cycle index. */
  cameraOffset: number;
  /** Rotation applied to the review/field location assignment. */
  settingOffset: number;
}

/** The default (history-free) visual treatment of one target. */
export interface ScenarioStyleDefaults {
  shotSeq: string[];
  framingSeq: string[];
  cameraSeq: string[];
  settingSeq: string[];
  opening: ScenarioStyleFingerprint['opening'];
}

/** Style cycles the generator rotates. Lengths bound every offset. */
export interface ScenarioStyleCycles {
  shot: readonly string[];
  framing: readonly string[];
  camera: readonly string[];
  setting: readonly string[];
}

/** One production's style observation, keyed by target tag. */
export type ScenarioStyleHistoryEntry = Record<string, ScenarioStyleFingerprint>;

/** Recent style observations, most recent last. */
export type ScenarioStyleHistory = readonly ScenarioStyleHistoryEntry[];

/* ------------------------------------------------------------------ */
/*  Serialisation                                                       */
/* ------------------------------------------------------------------ */

/** Stable JSON for one fingerprint set (key order is fixed, not sorted). */
export function serializeScenarioStyleFingerprints(set: ScenarioStyleFingerprintSet): string {
  return JSON.stringify(set);
}

/**
 * Parse a persisted style fingerprint. Returns `null` for anything that is not
 * a recognisable fingerprint set — including legacy single-string values — so a
 * malformed or legacy history entry can never break generation.
 */
export function parseScenarioStyleFingerprints(raw: unknown): ScenarioStyleFingerprintSet | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Partial<ScenarioStyleFingerprintSet>;
  if (!candidate.targets || typeof candidate.targets !== 'object') return null;
  const targets: Record<string, ScenarioStyleFingerprint> = {};
  for (const [tag, fp] of Object.entries(candidate.targets)) {
    const normalised = normalizeFingerprint(fp);
    if (normalised) targets[tag] = normalised;
  }
  if (Object.keys(targets).length === 0) return null;
  return { schema: typeof candidate.schema === 'number' ? candidate.schema : 1, targets };
}

function normalizeFingerprint(value: unknown): ScenarioStyleFingerprint | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ScenarioStyleFingerprint>;
  const opening = raw.opening;
  if (!opening || typeof opening !== 'object') return null;
  return {
    cast: stringArray(raw.cast),
    opening: {
      participants: stringArray(opening.participants),
      shotType: str(opening.shotType),
      framing: str(opening.framing),
      cameraMovement: str(opening.cameraMovement),
      speakerFocus: str(opening.speakerFocus),
      settingType: str(opening.settingType),
    },
    shotSeq: stringArray(raw.shotSeq),
    framingSeq: stringArray(raw.framingSeq),
    cameraSeq: stringArray(raw.cameraSeq),
    settingSeq: stringArray(raw.settingSeq),
    settingMix: stringArray(raw.settingMix),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/* ------------------------------------------------------------------ */
/*  History extraction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Pull the style observations out of the explicit persona history input.
 *
 * The generator already receives `personaHistory`, and each entry carries an
 * optional `styleFingerprint`. Unparseable/legacy fingerprints are skipped
 * rather than treated as a match, so an old entry simply stops influencing
 * style instead of forcing variation.
 */
export function styleFingerprintsFromPersonaHistory(
  history: readonly ScenarioPersonaHistoryEntry[] | undefined,
): ScenarioStyleHistory {
  const out: ScenarioStyleHistoryEntry[] = [];
  for (const entry of history ?? []) {
    const set = parseScenarioStyleFingerprints(entry?.styleFingerprint);
    if (set) out.push(set.targets);
  }
  return out.slice(-MAX_STYLE_HISTORY_ENTRIES);
}

/* ------------------------------------------------------------------ */
/*  Variation resolution                                                */
/* ------------------------------------------------------------------ */

/**
 * Deterministically decide how far to rotate the default visual treatment so
 * it does not substantially repeat the recent production history.
 *
 * For every dimension the default sequence is kept when it already differs from
 * every recent observation; otherwise the SMALLEST rotation that diverges from
 * every recent observation is applied. When no rotation helps (for example a
 * one-element vocabulary) the offset stays 0 and the original valid style is
 * preserved. Nothing here is random, and nothing changes spoken content.
 */
export function resolveStyleVariation(
  defaults: ScenarioStyleDefaults,
  recent: readonly ScenarioStyleFingerprint[],
  cycles: ScenarioStyleCycles,
): ScenarioStyleVariation {
  const variation: ScenarioStyleVariation = {
    shotOffset: 0,
    framingOffset: 0,
    cameraOffset: 0,
    settingOffset: 0 };
  const window = recent.slice(-MAX_STYLE_HISTORY_ENTRIES);
  if (window.length === 0) return variation;

  const sceneCount = defaults.shotSeq.length;

  variation.shotOffset = smallestDivergingRotation(
    defaults.shotSeq,
    window.map((r) => r.shotSeq),
    cycles.shot.length,
    (offset) => defaults.shotSeq.map((shot) => rotateValue(shot, offset, cycles.shot)),
  );

  variation.framingOffset = smallestDivergingRotation(
    defaults.framingSeq,
    window.map((r) => r.framingSeq),
    cycles.framing.length,
    (offset) => cycleSequence(cycles.framing, offset, sceneCount),
  );

  variation.cameraOffset = smallestDivergingRotation(
    defaults.cameraSeq,
    window.map((r) => r.cameraSeq),
    cycles.camera.length,
    (offset) => cycleSequence(cycles.camera, offset, sceneCount),
  );

  variation.settingOffset = smallestDivergingRotation(
    defaults.settingSeq,
    window.map((r) => r.settingSeq),
    cycles.setting.length,
    (offset) => cycleSequence(cycles.setting, offset, sceneCount),
  );

  // The opening configuration must itself move when it repeats. A different
  // scene count can leave every full sequence above already diverging while the
  // opening still matches, so it is checked on its own.
  if (window.some((r) => openingsEqual(r.opening, defaults.opening))) {
    const framing = smallestDivergingRotation(
      [defaults.opening.framing],
      window.map((r) => [r.opening.framing]),
      cycles.framing.length,
      (offset) => [cycleValue(cycles.framing, offset, 0)],
    );
    if (framing > 0) {
      if (variation.framingOffset === 0) variation.framingOffset = framing;
    } else {
      const camera = smallestDivergingRotation(
        [defaults.opening.cameraMovement],
        window.map((r) => [r.opening.cameraMovement]),
        cycles.camera.length,
        (offset) => [cycleValue(cycles.camera, offset, 0)],
      );
      if (camera > 0 && variation.cameraOffset === 0) variation.cameraOffset = camera;
    }
  }

  return variation;
}

/**
 * Smallest rotation in `1..cycleLength-1` whose generated sequence differs from
 * EVERY recent sequence. `0` when the default already differs from all of them
 * or when no rotation can diverge.
 */
function smallestDivergingRotation(
  defaults: readonly string[],
  recent: readonly string[][],
  cycleLength: number,
  rotatedAt: (offset: number) => string[],
): number {
  if (recent.length === 0 || cycleLength <= 1) return 0;
  if (recent.every((r) => !sequencesEqual(defaults, r))) return 0;
  for (let offset = 1; offset < cycleLength; offset += 1) {
    const candidate = rotatedAt(offset);
    if (recent.every((r) => !sequencesEqual(candidate, r))) return offset;
  }
  return 0;
}

/** `cycle[(index + offset) % cycle.length]` for a whole scene run. */
function cycleSequence(cycle: readonly string[], offset: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => cycleValue(cycle, offset, index));
}

function cycleValue(cycle: readonly string[], offset: number, index: number): string {
  if (cycle.length === 0) return '';
  return cycle[(((index + offset) % cycle.length) + cycle.length) % cycle.length];
}

/** Rotate one vocabulary VALUE inside its cycle; unknown values pass through. */
function rotateValue(value: string, offset: number, cycle: readonly string[]): string {
  const at = cycle.indexOf(value);
  if (at < 0) return value;
  return cycle[(at + offset) % cycle.length];
}

function sequencesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function openingsEqual(
  a: ScenarioStyleFingerprint['opening'],
  b: ScenarioStyleFingerprint['opening'],
): boolean {
  return (
    sequencesEqual(a.participants, b.participants) &&
    a.shotType === b.shotType &&
    a.framing === b.framing &&
    a.cameraMovement === b.cameraMovement &&
    a.speakerFocus === b.speakerFocus &&
    a.settingType === b.settingType
  );
}
