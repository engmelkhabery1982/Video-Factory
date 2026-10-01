/**
 * BuildTrack Video Factory - Workstream A
 * Deterministic script -> Scenario generator.
 *
 * This is the local, offline, fully deterministic implementation of the
 * ScenarioGenerator adapter contract. It turns a real `ProjectInput`
 * (topic, script, explicit numbers, references, CTA) into:
 *
 *   ProjectInput / user script
 *        |
 *        v
 *   validated Long Scenario            (targetFormat: 'Long')
 *        |
 *        +--> 0-3 validated Short Scenarios (targetFormat: 'Short')
 *
 * Hard guarantees implemented here:
 *  - Determinism: no clock, no randomness, no environment-derived ids, no
 *    network or LLM. Identical input yields byte-equivalent logical output.
 *  - Factual authority: every factual utterance is a sentence taken from the
 *    user's script. Numeric facts are carried through verbatim.
 *  - No fixture fallback: nothing here reads tests/fixtures/scenarios.
 *  - Contract authority: output is the existing `Scenario` model and every
 *    emitted scenario is validated with `validateScenario()`.
 */

import { analyzeScript } from '../analyze.js';
import type { ProjectInput, ScriptFunction } from '../types.js';
import type {
  CameraMovement,
  DialogueTurn,
  FramingAlignment,
  Scenario,
  SceneNarrativePurpose,
  ScenarioCharacter,
  ScenarioEvidence,
  ScenarioLocation,
  ScenarioScene,
  ScenarioSettingType,
  SpeakerFocus,
  TurnDelivery,
  TurnIntent,
} from './types.js';
import { SCENARIO_SCHEMA_VERSION } from './types.js';
import type { ScenarioPersonaHistoryEntry } from './scenario-generation-types.js';
import {
  MAX_STYLE_HISTORY_ENTRIES,
  resolveStyleVariation,
  styleFingerprintsFromPersonaHistory,
  type ScenarioStyleDefaults,
  type ScenarioStyleFingerprint,
  type ScenarioStyleHistory,
  type ScenarioStyleVariation,
} from './scenario-style-history.js';
import { estimateSceneDuration, DEFAULT_DURATION_CONFIG } from './duration.js';
import { validateScenario, type ValidationReport } from './validate.js';
import { repairScenarioInPlace, type ScenarioRepairContext } from './scenario-generation-repair.js';
import {
  MAX_SHORT_SCENARIOS,
  type ProductionScenarioGenerationResult,
  type ScenarioGenerationFailureCode,
  type ScenarioGenerationFinding,
  type ScenarioGenerationOptions,
  type ShortScenarioKey,
} from './scenario-generation-types.js';
import {
  LOCAL_SCRIPT_SCENARIO_GENERATOR_ID,
  type ScenarioGenerationRequest,
  type ScenarioGenerator,
} from './scenario-generator.js';

/* ------------------------------------------------------------------ */
/* Deterministic text helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * Decimal-safe number token finder.
 * `59.5` matches as one token; a bare `5` inside `59.5` never matches because
 * the lookbehind rejects a preceding `.` and the lookahead rejects a trailing
 * digit or decimal point.
 */
const NUMBER_TOKEN_RE = /(?<![\d.])\d+(?:\.\d+)?(?![\d.])/g;

/** Same sentence splitter used by `analyze.ts`, kept decimal-safe. */
const SENTENCE_SPLIT_RE = /(?<=[.!?؟])[\u2010-\u2015]?[\s"')]+|(?<=[.!?؟])$/;

/** Neutral, non-factual fallback CTA used only when ProjectInput.cta is empty. */
const NEUTRAL_CTA_TURNS = [
  'Take this into your next project review and act on the verified position before the next reporting cycle closes.',
  'Apply the same check on your own project before the next reporting cycle closes.',
  'Close the gap on your own project before the next review, and keep the verified record visible.',
];

function slugify(value: string, maxLength = 40): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'x';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** True when `text` contains `value` as a standalone figure (never inside 59.5). */
export function containsExactValue(text: string, value: number): boolean {
  const token = value.toString();
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.]|\\.[\\d])`).test(text);
}

interface ParsedNumber {
  value: number;
  unit: string;
  raw: string;
}

/** Parses an explicit key-number token such as `70%`, `59.5%`, `18 days`, `5%`. */
export function parseKeyNumber(token: string): ParsedNumber | null {
  const trimmed = (token || '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([+-]?\d+(?:\.\d+)?)\s*(.*)$/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: (match[2] || '').trim(), raw: trimmed };
}

/** Extracts every standalone figure from a piece of source text. */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  NUMBER_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_TOKEN_RE.exec(text)) !== null) {
    const value = Number.parseFloat(match[0]);
    if (Number.isFinite(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.replace(/[^\p{L}\p{N}]/gu, '').length > 0);
}

function lowerFirstCharacter(text: string): string {
  if (!text) return text;
  const first = text[0];
  const second = text[1];
  if (first !== first.toLowerCase() && first === first.toUpperCase() && second === second?.toLowerCase()) {
    return first.toLowerCase() + text.slice(1);
  }
  return text;
}

function totalSecondsOf(scenes: ScenarioScene[]): number {
  return round2(
    scenes.reduce((acc, scene) => acc + estimateSceneDuration(scene, DEFAULT_DURATION_CONFIG).totalSeconds, 0),
  );
}

/* ------------------------------------------------------------------ */
/* Deterministic persona library                                        */
/* ------------------------------------------------------------------ */

type PersonaRole = 'challenger' | 'technical_authority' | 'decision_maker';

interface PersonaArchetype {
  key: string;
  name: string;
  role: string;
  narrativeFunction: PersonaRole;
  communicationStyle: string;
  visualDescription: string;
  constraints: string[];
  keywords: string[];
}

/**
 * Fixed professional archetypes. These are deterministic narrative scaffolding
 * (exactly like the Phase 3A fixtures' personas) and are NOT user facts; the
 * generator emits an `info` finding saying so.
 */
const PERSONA_LIBRARY: PersonaArchetype[] = [
  // --- challengers -------------------------------------------------
  {
    key: 'commercial-lead',
    name: 'Dana Whitfield',
    role: 'Commercial Manager',
    narrativeFunction: 'challenger',
    communicationStyle: 'Assertive, valuation-focused, presses for certified progress and cashflow certainty.',
    visualDescription: 'High-vis vest over a dark suit, carrying an interim valuation binder.',
    constraints: ['Accountable for the monthly application being reviewed'],
    keywords: ['commercial', 'valuation', 'invoice', 'claim', 'payment', 'cashflow', 'boq', 'certificate', 'variation', 'application'],
  },
  {
    key: 'construction-manager',
    name: 'Omar Haddad',
    role: 'Construction Manager',
    narrativeFunction: 'challenger',
    communicationStyle: 'Direct, delivery-focused, argues from physical progress and crew output.',
    visualDescription: 'Site PPE and hardhat, tablet showing the daily progress log.',
    constraints: ['Responsible for keeping the physical works moving'],
    keywords: ['site', 'crew', 'productivity', 'delivery', 'progress', 'executed', 'physical', 'installation', 'pour', 'trade'],
  },
  {
    key: 'client-representative',
    name: 'Priya Raman',
    role: 'Client Representative',
    narrativeFunction: 'challenger',
    communicationStyle: 'Questioning, scope-protective, insists on verified acceptance before sign-off.',
    visualDescription: 'Formal attire with a site pass, holding the scope acceptance register.',
    constraints: ['Cannot accept work that is not independently verified'],
    keywords: ['client', 'employer', 'stakeholder', 'acceptance', 'handover', 'scope', 'satisfaction', 'sign-off'],
  },
  {
    key: 'controls-lead',
    name: 'Lucas Ferreira',
    role: 'Project Controls Lead',
    narrativeFunction: 'challenger',
    communicationStyle: 'Metric-driven, challenges any figure that is not tied to a measured source.',
    visualDescription: 'Casual professional dress in front of a controls dashboard.',
    constraints: ['Owns the integrity of the reported progress numbers'],
    keywords: ['controls', 'schedule', 's-curve', 'earned value', 'evm', 'float', 'baseline', 'metrics', 'report', 'dashboard'],
  },
  {
    key: 'quality-lead',
    name: 'Nadia Farouk',
    role: 'Quality Assurance Lead',
    narrativeFunction: 'challenger',
    communicationStyle: 'Evidence-first, refuses to let unverified work be treated as accepted work.',
    visualDescription: 'White coat over site PPE, clipboard with the inspection checklist.',
    constraints: ['Blocks acceptance where the verification record is incomplete'],
    keywords: ['quality', 'qa', 'inspection', 'defect', 'snag', 'test', 'compliance', 'standard', 'audit', 'wir'],
  },
  // --- technical authorities ---------------------------------------
  {
    key: 'planning-engineer',
    name: 'Yusuf Karim',
    role: 'Lead Planning Engineer',
    narrativeFunction: 'technical_authority',
    communicationStyle: 'Precise, schedule-logic driven, explains dependency and float effects clearly.',
    visualDescription: 'High-vis vest, dual monitors showing schedule logic diagrams.',
    constraints: ['Must keep the critical path logic defensible'],
    keywords: ['schedule', 'critical path', 'float', 'primavera', 'logic', 'delay', 'milestone', 'dependency', 'timeline'],
  },
  {
    key: 'structural-engineer',
    name: 'Ingrid Halvorsen',
    role: 'Structural Engineer',
    narrativeFunction: 'technical_authority',
    communicationStyle: 'Methodical, specification-led, cites test records before conceding anything.',
    visualDescription: 'Hardhat and site boots, structural drawings rolled under one arm.',
    constraints: ['Bound by the approved design specification'],
    keywords: ['structural', 'concrete', 'steel', 'design', 'load', 'strength', 'specification', 'drawing', 'cube', 'core'],
  },
  {
    key: 'mep-engineer',
    name: 'Rashid Al-Amin',
    role: 'MEP Lead Engineer',
    narrativeFunction: 'technical_authority',
    communicationStyle: 'Pragmatic, execution-focused, verifies productivity and statutory compliance.',
    visualDescription: 'Coveralls and hardhat, carrying electrical single-line schematics.',
    constraints: ['Ensures statutory electrical safety compliance'],
    keywords: ['mep', 'electrical', 'mechanical', 'hvac', 'cable', 'substation', 'commissioning', 'switchgear', 'containment'],
  },
  {
    key: 'quantity-surveyor',
    name: 'Tomas Delgado',
    role: 'Quantity Surveyor',
    narrativeFunction: 'technical_authority',
    communicationStyle: 'Measured and exact, separates what was built from what can be measured and paid.',
    visualDescription: 'Open measurement book and a marked-up bill of quantities.',
    constraints: ['May only certify measured, conforming work'],
    keywords: ['quantity', 'measurement', 'boq', 'rate', 'cost', 'budget', 'variation', 'valuation', 'claim'],
  },
  {
    key: 'data-analyst',
    name: 'Mei Tanaka',
    role: 'Project Data Analyst',
    narrativeFunction: 'technical_authority',
    communicationStyle: 'Calm and exact, reconciles reported figures against the underlying records.',
    visualDescription: 'Laptop open to a reconciliation model, second screen with trend charts.',
    constraints: ['Reports only what the source records support'],
    keywords: ['data', 'analytics', 'chart', 'curve', 'trend', 'model', 'reconcil', 'metric', 'figure', 'statistic'],
  },
  // --- decision makers ---------------------------------------------
  {
    key: 'project-director',
    name: 'Helena Brandt',
    role: 'Project Director',
    narrativeFunction: 'decision_maker',
    communicationStyle: 'Decisive, weighs acceleration cost against exposure, closes the discussion.',
    visualDescription: 'Standing at a milestone board, composed and deliberate.',
    constraints: ['Authorised to release contingency and approve recovery actions'],
    keywords: ['director', 'executive', 'decision', 'authorize', 'authorise', 'strategy', 'board', 'sponsor', 'exposure'],
  },
  {
    key: 'project-manager',
    name: 'Samuel Adeyemi',
    role: 'Project Manager',
    narrativeFunction: 'decision_maker',
    communicationStyle: 'Coordinating, converts disagreement into an owned action with a date.',
    visualDescription: 'Site PPE over business attire, meeting agenda in hand.',
    constraints: ['Owns the agreed action list and its deadlines'],
    keywords: ['project manager', 'coordination', 'delivery', 'team', 'risk', 'escalation', 'action', 'review'],
  },
  {
    key: 'programme-manager',
    name: 'Viktor Novak',
    role: 'Programme Manager',
    narrativeFunction: 'decision_maker',
    communicationStyle: 'Portfolio-minded, sequences decisions and protects downstream phases.',
    visualDescription: 'Programme roadmap printed across a wide wall display.',
    constraints: ['Balances competing package commitments'],
    keywords: ['programme', 'portfolio', 'phase', 'stage', 'gate', 'roadmap', 'dependency', 'sequence'],
  },
  {
    key: 'operations-director',
    name: 'Farah Al-Saud',
    role: 'Operations Director',
    narrativeFunction: 'decision_maker',
    communicationStyle: 'Throughput-oriented, commits resources once the constraint is proven.',
    visualDescription: 'Operations review room, shift board behind her.',
    constraints: ['Controls shift and resource allocation'],
    keywords: ['operations', 'production', 'capacity', 'resource', 'shift', 'throughput', 'plant', 'output'],
  },
  {
    key: 'engineering-manager',
    name: 'Colin Mbeki',
    role: 'Engineering Manager',
    narrativeFunction: 'decision_maker',
    communicationStyle: 'Governance-led, demands the verified record before technical sign-off.',
    visualDescription: 'Design review room, specification register on the table.',
    constraints: ['Holds technical sign-off authority'],
    keywords: ['engineering', 'governance', 'sign-off', 'design review', 'standards', 'authority', 'approval'],
  },
];

const PERSONA_ROLE_ORDER: PersonaRole[] = ['challenger', 'technical_authority', 'decision_maker'];

/**
 * Prefix of every generated character id: `char-<videoSlug>-<personaKey>`.
 * The slug itself may contain hyphens, so the id can never be split on the last
 * hyphen to recover the persona key.
 */
const CHARACTER_ID_PREFIX = 'char-';

/** Every canonical persona key, in fixed library order. */
export const CANONICAL_PERSONA_KEYS: readonly string[] = PERSONA_LIBRARY.map((p) => p.key);

/**
 * Recover the COMPLETE persona key from a generated character id.
 *
 * Persona keys themselves contain hyphens (`commercial-lead`,
 * `planning-engineer`, `project-manager`, `client-representative`), so the key
 * is resolved by matching the LONGEST canonical persona key that is a suffix of
 * the id — never by splitting on the last hyphen, which would truncate
 * `commercial-lead` to `lead` and silently break cross-video casting history.
 *
 * Returns `null` when the id is not a generated persona character id, so
 * callers can fall back to a safe default instead of guessing.
 */
export function personaKeyFromCharacterId(characterId: string): string | null {
  if (typeof characterId !== 'string' || !characterId.startsWith(CHARACTER_ID_PREFIX)) return null;
  let best: string | null = null;
  for (const persona of PERSONA_LIBRARY) {
    if (!characterId.endsWith(`-${persona.key}`)) continue;
    if (best === null || persona.key.length > best.length) best = persona.key;
  }
  if (best === null) return null;
  // A non-empty project slug must sit between the prefix and the persona key.
  const slug = characterId.slice(
    CHARACTER_ID_PREFIX.length,
    characterId.length - best.length - 1,
  );
  return slug.length > 0 ? best : null;
}

/**
 * Semantic style fingerprint of one generated scenario.
 *
 * Contains only semantic production style — complete persona keys by role, the
 * opening configuration, the shot/framing/camera sequences and the setting mix.
 * It deliberately contains no project slug, scenario id, scene id or character
 * id, so the same visual treatment produces the same fingerprint for two
 * different videos and cross-video avoidance can actually fire.
 */
export function buildScenarioStyleFingerprint(scenario: Scenario): ScenarioStyleFingerprint {
  const settingById = new Map(scenario.locations.map((l) => [l.id, l.settingType]));
  const roleById = new Map(scenario.characters.map((c) => [c.id, c.narrativeFunction]));

  const cast = scenario.characters
    .map((c) => `${c.narrativeFunction}:${personaKeyFromCharacterId(c.id) ?? c.id}`)
    .sort();

  const shotSeq: string[] = [];
  const framingSeq: string[] = [];
  const cameraSeq: string[] = [];
  const settingSeq: string[] = [];
  for (const scene of scenario.scenes) {
    shotSeq.push(scene.production.shotType);
    framingSeq.push(scene.production.framing);
    cameraSeq.push(scene.production.cameraMovement);
    settingSeq.push(settingById.get(scene.locationId) ?? 'unknown');
  }

  const first = scenario.scenes[0];
  const opening: ScenarioStyleFingerprint['opening'] = first
    ? {
        participants: Array.from(
          new Set(first.participantIds.map((id) => roleById.get(id) ?? id)),
        ).sort(),
        shotType: first.production.shotType,
        framing: first.production.framing,
        cameraMovement: first.production.cameraMovement,
        speakerFocus: first.production.speakerFocus,
        settingType: settingById.get(first.locationId) ?? 'unknown',
      }
    : {
        participants: [],
        shotType: '',
        framing: '',
        cameraMovement: '',
        speakerFocus: '',
        settingType: '',
      };

  return {
    cast,
    opening,
    shotSeq,
    framingSeq,
    cameraSeq,
    settingSeq,
    settingMix: Array.from(new Set(settingSeq)).sort(),
  };
}

/** Deterministically picks one archetype per narrative function. */
function selectPersonas(haystack: string): Record<PersonaRole, PersonaArchetype> {
  const chosen = {} as Record<PersonaRole, PersonaArchetype>;

  for (const role of PERSONA_ROLE_ORDER) {
    const pool = PERSONA_LIBRARY.filter((p) => p.narrativeFunction === role);
    let best = pool[0];
    let bestScore = -1;
    let bestPosition = Number.MAX_SAFE_INTEGER;

    for (const candidate of pool) {
      let score = 0;
      let position = 0;
      for (const keyword of candidate.keywords) {
        const at = haystack.indexOf(keyword);
        if (at >= 0) {
          score += 1;
          position += at;
        }
      }
      // Higher keyword coverage wins; ties break toward the earliest mention,
      // then toward the fixed library order. No randomness anywhere.
      if (score > bestScore || (score === bestScore && position < bestPosition)) {
        best = candidate;
        bestScore = score;
        bestPosition = position;
      }
    }
    chosen[role] = best;
  }

  return chosen;
}

/**
 * Deterministic persona-history avoidance (Workstream D cross-video diversity).
 *
 * Given the keyword-driven selection and the explicit persona history, prefer a
 * combination whose persona keys were NOT all used by any of the most recent
 * history entries. The scan order is fully deterministic: for each role the
 * candidates are visited in fixed library order, and the first combination that
 * avoids every recent combination wins; when nothing can be avoided, the
 * keyword selection is kept unchanged. No randomness is involved.
 */
function avoidRecentPersonaCombinations(
  chosen: Record<PersonaRole, PersonaArchetype>,
  haystack: string,
  history: readonly ScenarioPersonaHistoryEntry[] | undefined,
): Record<PersonaRole, PersonaArchetype> {
  const recent = (history ?? []).slice(0, 5);
  if (recent.length === 0) return chosen;

  const recentKeys = new Set<string>();
  for (const entry of recent) {
    for (const key of Object.values(entry.personas ?? {})) {
      if (typeof key === 'string' && key) recentKeys.add(key);
    }
  }
  if (recentKeys.size === 0) return chosen;

  // Score each candidate exactly like selectPersonas does, so avoidance only
  // ever swaps between candidates of equal keyword merit first.
  const scoreOf = (candidate: PersonaArchetype): { score: number; position: number } => {
    let score = 0;
    let position = 0;
    for (const keyword of candidate.keywords) {
      const at = haystack.indexOf(keyword);
      if (at >= 0) {
        score += 1;
        position += at;
      }
    }
    return { score, position };
  };

  const pools = new Map<PersonaRole, PersonaArchetype[]>();
  for (const role of PERSONA_ROLE_ORDER) {
    pools.set(
      role,
      PERSONA_LIBRARY.filter((p) => p.narrativeFunction === role),
    );
  }

  const avoided = { ...chosen };
  const swappedRoles: PersonaRole[] = [];
  for (const role of PERSONA_ROLE_ORDER) {
    if (recentKeys.has(chosen[role].key)) {
      const candidates = (pools.get(role) ?? []).filter((p) => !recentKeys.has(p.key));
      if (candidates.length > 0) {
        // Deterministic swap: highest keyword score, then earliest mention,
        // then fixed library order — the same ranking selectPersonas uses.
        let best = candidates[0];
        let bestRank = scoreOf(best);
        for (const candidate of candidates.slice(1)) {
          const rank = scoreOf(candidate);
          if (
            rank.score > bestRank.score ||
            (rank.score === bestRank.score && rank.position < bestRank.position)
          ) {
            best = candidate;
            bestRank = rank;
          }
        }
        avoided[role] = best;
        swappedRoles.push(role);
      }
    }
  }

  return avoided;
}

/* ------------------------------------------------------------------ */
/* Source model                                                        */
/* ------------------------------------------------------------------ */

const FUNCTION_TO_PURPOSE: Record<ScriptFunction, SceneNarrativePurpose> = {
  hook: 'hook',
  promise: 'context',
  question: 'clarification',
  comparison: 'disagreement',
  steps: 'solution',
  timeline: 'context',
  table: 'evidence',
  warning: 'problem',
  product_proof: 'demonstration',
  data: 'evidence',
  example: 'demonstration',
  myth: 'disagreement',
  summary: 'result',
  cta: 'decision',
};

const FUNCTION_TO_INTENT: Record<ScriptFunction, TurnIntent> = {
  hook: 'assertion',
  promise: 'assertion',
  question: 'question',
  comparison: 'assertion',
  steps: 'instruction',
  timeline: 'assertion',
  table: 'assertion',
  warning: 'assertion',
  product_proof: 'assertion',
  data: 'assertion',
  example: 'assertion',
  myth: 'assertion',
  summary: 'assertion',
  cta: 'assertion',
};

/** Secondary-speaker reaction intents, rotated per sentence inside a scene. */
const PURPOSE_REACTION_INTENTS: Record<SceneNarrativePurpose, TurnIntent[]> = {
  hook: ['question', 'clarification'],
  context: ['clarification', 'question', 'agreement'],
  problem: ['objection', 'question'],
  evidence: ['objection', 'question'],
  disagreement: ['clarification', 'objection'],
  clarification: ['clarification', 'agreement'],
  demonstration: ['question', 'agreement'],
  solution: ['agreement', 'question'],
  result: ['clarification', 'agreement'],
  decision: ['agreement', 'question'],
  cta: ['assertion'],
};

/**
 * Deterministic editorial cue for "this sentence is the remedy".
 *
 * This classifies the USER'S OWN words into a narrative beat. It invents
 * nothing - it only decides where a source sentence is staged.
 */
const REMEDY_CUE_RE =
  /\b(now the fix|the fix is|here is the fix|what to do instead|the practical step|the remedy|how to close it|to close (it|the gap|that)|start by|begin by|do this instead|require |enforce|adopt|implement|re-?plan|escalate)\b/i;

/** Primary / secondary speaker per narrative purpose. */
const PURPOSE_SPEAKERS: Record<SceneNarrativePurpose, { primary: PersonaRole; secondary: PersonaRole }> = {
  hook: { primary: 'challenger', secondary: 'decision_maker' },
  context: { primary: 'technical_authority', secondary: 'challenger' },
  problem: { primary: 'challenger', secondary: 'technical_authority' },
  evidence: { primary: 'technical_authority', secondary: 'challenger' },
  disagreement: { primary: 'challenger', secondary: 'technical_authority' },
  clarification: { primary: 'technical_authority', secondary: 'challenger' },
  demonstration: { primary: 'technical_authority', secondary: 'decision_maker' },
  solution: { primary: 'technical_authority', secondary: 'challenger' },
  result: { primary: 'decision_maker', secondary: 'technical_authority' },
  decision: { primary: 'decision_maker', secondary: 'challenger' },
  cta: { primary: 'decision_maker', secondary: 'challenger' },
};

type ShotTypeLike = 'two_shot' | 'medium' | 'close_up' | 'wide' | 'over_the_shoulder';

/** Preferred camera framing per narrative purpose. */
const PURPOSE_SHOT_TYPE: Record<SceneNarrativePurpose, ShotTypeLike> = {
  hook: 'two_shot',
  context: 'medium',
  problem: 'medium',
  evidence: 'close_up',
  disagreement: 'over_the_shoulder',
  clarification: 'medium',
  demonstration: 'wide',
  solution: 'medium',
  result: 'two_shot',
  decision: 'medium',
  cta: 'two_shot',
};

const SHOT_CYCLE: ShotTypeLike[] = ['two_shot', 'medium', 'close_up', 'wide', 'over_the_shoulder'];
const CAMERA_CYCLE: CameraMovement[] = ['slow_push', 'pan_right', 'static', 'pan_left', 'subtle_drift', 'slow_pull'];
const FRAMING_CYCLE: FramingAlignment[] = ['center', 'rule_of_thirds_left', 'rule_of_thirds_right', 'symmetric'];

/** Field/review location rotation length: review, review, field. */
const SETTING_CYCLE_LENGTH = 3;

/**
 * True when a scene is staged in the field/verification location. Rotated by
 * `settingOffset` for deterministic location-mix variation; `demonstration`
 * purposes are always field because they cannot be staged in a review room.
 */
function isFieldScene(purpose: SceneNarrativePurpose, sceneIndex: number, settingOffset: number): boolean {
  return purpose === 'demonstration' || (sceneIndex + settingOffset) % SETTING_CYCLE_LENGTH === 2;
}

/** Rotate a purpose shot inside the shot vocabulary (identity at offset 0). */
function rotateShotType(base: ShotTypeLike, shotOffset: number): ShotTypeLike {
  if (shotOffset === 0) return base;
  const at = SHOT_CYCLE.indexOf(base);
  if (at < 0) return base;
  return SHOT_CYCLE[(at + shotOffset) % SHOT_CYCLE.length];
}

/**
 * The shot sequence emitted for these purposes, including the run-length guard
 * that breaks three identical shots in a row. Shared by the emitter and by the
 * style-default computation so the two can never disagree about what the
 * history-free output looks like.
 */
function shotSequenceFor(purposes: SceneNarrativePurpose[], shotOffset: number): ShotTypeLike[] {
  const out: ShotTypeLike[] = [];
  let shotRun = 0;
  let lastShot: ShotTypeLike | '' = '';
  purposes.forEach((purpose, sceneIndex) => {
    let shot = rotateShotType(PURPOSE_SHOT_TYPE[purpose], shotOffset);
    if (shot === lastShot) {
      shotRun += 1;
      if (shotRun >= 3) {
        shot = SHOT_CYCLE[(sceneIndex + 2) % SHOT_CYCLE.length];
        if (shot === lastShot) shot = SHOT_CYCLE[(sceneIndex + 3) % SHOT_CYCLE.length];
        shotRun = 1;
      }
    } else {
      shotRun = 1;
    }
    lastShot = shot;
    out.push(shot);
  });
  return out;
}

/** Participant narrative roles for a purpose, given the scenario's cast. */
function participantRolesFor(purpose: SceneNarrativePurpose, roles: PersonaRole[]): PersonaRole[] {
  const speakers = PURPOSE_SPEAKERS[purpose];
  const primary = roles.includes(speakers.primary) ? speakers.primary : roles[0];
  const secondary = roles.includes(speakers.secondary)
    ? speakers.secondary
    : roles.find((r) => r !== primary) || roles[0];
  return Array.from(new Set([primary, secondary]));
}

/**
 * Recent style observations for one target, most recent last. A history entry
 * that predates per-target fingerprints (or was written for another target)
 * falls back to the Long observation, which every production has.
 */
function recentStyleObservations(ctx: GenerationContext, targetTag: string): ScenarioStyleFingerprint[] {
  const out: ScenarioStyleFingerprint[] = [];
  for (const entry of ctx.styleHistory) {
    const fingerprint = entry[targetTag] ?? entry.long;
    if (fingerprint) out.push(fingerprint);
  }
  return out.slice(-MAX_STYLE_HISTORY_ENTRIES);
}

/**
 * The history-free visual treatment of one target. Includes the synthetic CTA
 * end-card, which `buildScenes` always appends with a fixed treatment, so the
 * default sequences match the emitted scenario exactly.
 */
function buildStyleDefaults(
  purposes: SceneNarrativePurpose[],
  roles: PersonaRole[],
  ctx: GenerationContext,
): ScenarioStyleDefaults {
  const shotSeq = shotSequenceFor(purposes, 0).map((s) => s as string);
  const framingSeq = purposes.map((_, i) => FRAMING_CYCLE[i % FRAMING_CYCLE.length] as string);
  const cameraSeq = purposes.map((_, i) => CAMERA_CYCLE[i % CAMERA_CYCLE.length] as string);
  const settingSeq = purposes.map((purpose, i) =>
    isFieldScene(purpose, i, 0) ? 'site_walk' : ctx.reviewSettingType,
  );
  shotSeq.push('two_shot');
  framingSeq.push('center');
  cameraSeq.push('subtle_drift');
  settingSeq.push(ctx.reviewSettingType);

  const first = purposes[0];
  return {
    shotSeq,
    framingSeq,
    cameraSeq,
    settingSeq,
    opening: {
      participants: participantRolesFor(first, roles).slice().sort(),
      shotType: shotSeq[0],
      framing: framingSeq[0],
      cameraMovement: cameraSeq[0],
      speakerFocus: speakerFocusFor(first),
      settingType: settingSeq[0],
    },
  };
}

const PURPOSE_LABEL: Record<SceneNarrativePurpose, string> = {
  hook: 'The Opening',
  context: 'Context',
  problem: 'The Risk',
  evidence: 'The Record',
  disagreement: 'The Objection',
  clarification: 'Clarification',
  demonstration: 'Worked Example',
  solution: 'The Fix',
  result: 'The Outcome',
  decision: 'The Decision',
  cta: 'Next Step',
};

interface SourceSentence {
  /** Position in the full source script, used to resolve evidence linkage. */
  index: number;
  /** The verbatim source sentence. */
  text: string;
  fn: ScriptFunction;
  purpose: SceneNarrativePurpose;
  numbers: number[];
}

interface FactAllocation {
  /** Evidence record id per global sentence index. */
  evidenceIdBySentence: Map<number, string>;
  /** Numeric values the generator is required to preserve verbatim. */
  requiredValues: number[];
  /** Fresh, per-target evidence records (cloned for every emitted scenario). */
  evidence: ScenarioEvidence[];
}

/* ------------------------------------------------------------------ */
/* Sentence frames (deterministic, fact-free connective scaffolding)   */
/* ------------------------------------------------------------------ */

interface SentenceFrame {
  /** Unique leading text; also the deduplication key. */
  lead: string;
  /** Lowercase the first character of the source sentence. */
  lowerFirst?: boolean;
}

const BARE_FRAME: SentenceFrame = { lead: '' };

const PURPOSE_FRAMES: Record<SceneNarrativePurpose, SentenceFrame[]> = {
  hook: [
    { lead: 'Start here. ' },
    { lead: 'Before anything else: ', lowerFirst: true },
    { lead: 'Here is the situation. ' },
    BARE_FRAME,
  ],
  context: [
    { lead: 'For context, ', lowerFirst: true },
    { lead: 'The background matters here. ' },
    { lead: 'To set the scene, ', lowerFirst: true },
    BARE_FRAME,
  ],
  problem: [
    { lead: 'And here is the risk. ' },
    { lead: 'This is where it goes wrong. ' },
    { lead: 'The exposure is real. ' },
    BARE_FRAME,
  ],
  evidence: [
    { lead: 'The record is unambiguous. ' },
    { lead: 'Look at the evidence. ' },
    { lead: 'Here is what the figures show. ' },
    BARE_FRAME,
  ],
  disagreement: [
    { lead: 'I dispute that. ' },
    { lead: 'That is the misconception. ' },
    { lead: 'In reality, ', lowerFirst: true },
    BARE_FRAME,
  ],
  clarification: [
    { lead: 'Let me clarify. ' },
    { lead: 'To be precise, ', lowerFirst: true },
    { lead: 'The distinction is this. ' },
    BARE_FRAME,
  ],
  demonstration: [
    { lead: 'Here is how it plays out. ' },
    { lead: 'Consider the worked case. ' },
    { lead: 'On a real project it looks like this. ' },
    BARE_FRAME,
  ],
  solution: [
    { lead: 'The fix is straightforward. ' },
    { lead: 'What to do instead. ' },
    { lead: 'Here is the practical step. ' },
    BARE_FRAME,
  ],
  result: [
    { lead: 'The outcome is this. ' },
    { lead: 'To summarise, ', lowerFirst: true },
    { lead: 'The bottom line: ' },
    BARE_FRAME,
  ],
  decision: [
    { lead: 'The decision is this. ' },
    { lead: 'We proceed on that basis. ' },
    BARE_FRAME,
  ],
  cta: [
    { lead: 'So, concretely, ', lowerFirst: true },
    BARE_FRAME,
  ],
};

/** Fact-free reaction lines, keyed by the reaction intent they carry. */
const REACTION_LINES: Record<TurnIntent, string[]> = {
  question: [
    'What does the record actually say about that?',
    'How do we evidence that before the next review?',
    'Who owns the follow-up on this one?',
    'Where does that leave the remaining scope?',
    'Can you show me the source behind that?',
    'What is the consequence if we accept it as stated?',
    'How would we defend that position later?',
    'What changes if nothing is done about it?',
    'Which record settles that question?',
    'Does that hold up against the latest submission?',
    'Who signed off on that position?',
    'What is the exposure if we leave it as stated?',
  ],
  objection: [
    'I am not convinced that reading survives contact with the record.',
    'That is the claim as submitted, not the verified position.',
    'We have heard that version before, and the paperwork disagreed.',
    'I need to push back on that before we carry it forward.',
    'That assumption is doing a lot of work in this argument.',
    'The record does not support that conclusion yet.',
    'I would not sign off on that reading today.',
    'That is where the commercial exposure starts to bite.',
    'I cannot take that to the board without the source attached.',
    'That conclusion runs ahead of the evidence we hold.',
    'I want the verified figure before we agree anything.',
    'That is an assumption dressed up as a measurement.',
  ],
  clarification: [
    'Let me be precise about what that means in practice.',
    'To be exact, that distinction matters more than it sounds.',
    'The mechanism behind it is simpler than it appears.',
    'That is the part most teams skip, and it is the part that bites.',
    'Unpacking that, the sequence is what creates the exposure.',
    'In plain terms, the two are not interchangeable.',
    'The detail that matters sits underneath that statement.',
    'Being specific here removes most of the argument.',
    'The distinction is between what is claimed and what is shown.',
    'What sits behind that number is the part worth examining.',
    'The sequence of events is what turns that into a problem.',
    'That is the point where the two records stop agreeing.',
  ],
  agreement: [
    'That is the position I can defend.',
    'Agreed, and that is what I will take forward.',
    'That holds up, so let us lock it in.',
    'I can work with that.',
    'That is consistent with what we are seeing on the ground.',
    'Understood, and I will reflect it in the record.',
    'That is a fair reading of the same evidence.',
    'I accept that reading of the record.',
    'That is a defensible basis for proceeding.',
    'I will carry that position into the next review.',
    'That matches what the team is reporting.',
    'I am satisfied with that as the agreed position.',
  ],
  concession: [
    'Fair point, I will concede that part of it.',
    'You are right, and I will adjust the position.',
    'I accept that correction.',
    'Understood, I will revise my reading.',
  ],
  instruction: [
    'Log it and bring it back with the source attached.',
    'Circulate that to the team before the week closes.',
    'Record the decision and the reason behind it.',
    'Assign it an owner and a date.',
    'Keep the verified record alongside the claim.',
    'Put that in writing before the next checkpoint.',
    'Track it weekly rather than waiting for the cycle to close.',
    'Close it out properly rather than leaving it open.',
    'Bring the evidence pack to the next review.',
    'Make the owner and the deadline explicit.',
    'Do not let that close without a documented reason.',
    'Reconcile the two records before the next submission.',
  ],
  assertion: [
    'That is the position, and it is the one the record supports.',
    'I will hold that line in the next review.',
    'That is where we need to be decisive.',
    'That is the version I will report upwards.',
    'That is the position the evidence carries.',
    'I will stand behind that in the next meeting.',
  ],
  call_to_action: ['Act on the verified position before the next reporting cycle closes.'],
  /** Support line for the synthetic closing CTA scene. */
  cta_support: [
    'That is the position I will carry back to the team.',
    'Understood, and I will reflect it in the record.',
    'That holds up, so let us lock it in and move.',
    'I will make sure the team acts on that this week.',
    'Agreed, and I will report the outcome upwards.',
    'That is the version I will put in the minutes.',
  ],
};

/**
 * Very short connective lines. `analyzeScenarioDiversity` only flags
 * substantive sentences (normalized length > 15), so these are exempt from
 * RULE-016 by construction and are used as the guaranteed-unique last resort.
 */
const SHORT_SAFE_LINES = ['Noted.', 'Understood.', 'Agreed.', 'Fair.', 'Logged.', 'Clear.', 'Right.'];

/**
 * Hands out fact-free connective text without ever repeating a line.
 *
 * `seed` rotates the starting point of every pool so the Long and each Short
 * get different connective scaffolding even when they quote the same source
 * sentence. The seed is derived from the target identity, so it stays
 * deterministic.
 */
class LineAllocator {
  private readonly usedFrames = new Set<string>();
  private readonly usedLines = new Set<string>();
  private frameCount = 0;
  private lineCount = 0;
  private shortIndex = 0;

  constructor(private readonly seed = 0) {}

  frame(purpose: SceneNarrativePurpose): SentenceFrame {
    const pool = PURPOSE_FRAMES[purpose];
    const offset = (this.seed + this.frameCount) % pool.length;
    this.frameCount++;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[(offset + i) % pool.length];
      if (candidate.lead !== '' && !this.usedFrames.has(candidate.lead)) {
        this.usedFrames.add(candidate.lead);
        return candidate;
      }
    }
    return BARE_FRAME;
  }

  line(intent: TurnIntent): string {
    const pool = REACTION_LINES[intent] || REACTION_LINES.assertion;
    const offset = (this.seed + this.lineCount) % pool.length;
    this.lineCount++;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[(offset + i) % pool.length];
      if (!this.usedLines.has(candidate)) {
        this.usedLines.add(candidate);
        return candidate;
      }
    }
    // Deterministic last resort: short lines are exempt from RULE-016.
    return SHORT_SAFE_LINES[this.shortIndex++ % SHORT_SAFE_LINES.length];
  }

  /** Picks the first candidate body not already spoken in this scenario. */
  body(candidates: string[]): string {
    for (const candidate of candidates) {
      if (!this.usedLines.has(candidate)) {
        this.usedLines.add(candidate);
        return candidate;
      }
    }
    return SHORT_SAFE_LINES[this.shortIndex++ % SHORT_SAFE_LINES.length];
  }
}

/* ------------------------------------------------------------------ */
/* Short editorial angles                                              */
/* ------------------------------------------------------------------ */

interface ShortAngleSpec {
  key: ShortScenarioKey;
  label: string;
  /** Preferred narrative purposes for this angle. */
  purposes: SceneNarrativePurpose[];
  /** Widening order used only when the angle lacks enough source content. */
  widen: SceneNarrativePurpose[];
}

const SHORT_ANGLES: ShortAngleSpec[] = [
  {
    key: 'short_1',
    label: 'The Risk',
    purposes: ['problem', 'evidence'],
    widen: ['hook', 'disagreement', 'demonstration', 'result'],
  },
  {
    key: 'short_2',
    label: 'The Objection',
    purposes: ['disagreement', 'clarification', 'decision'],
    widen: ['hook', 'problem', 'evidence', 'result'],
  },
  {
    key: 'short_3',
    label: 'The Fix',
    purposes: ['demonstration', 'solution', 'result'],
    widen: ['hook', 'context', 'clarification', 'decision'],
  },
];

const ALL_PURPOSES: SceneNarrativePurpose[] = [
  'hook',
  'context',
  'problem',
  'evidence',
  'disagreement',
  'clarification',
  'demonstration',
  'solution',
  'result',
  'decision',
];

/* ------------------------------------------------------------------ */
/* Generation context                                                  */
/* ------------------------------------------------------------------ */

interface GenerationContext {
  videoId: string;
  videoSlug: string;
  projectId: string;
  language: string;
  topic: string;
  brief: string;
  audience: string;
  outcome: string;
  ctaText: string;
  productName: string;
  sourceReferences: string[];
  characters: ScenarioCharacter[];
  characterIdByRole: Record<PersonaRole, string>;
  locations: ScenarioLocation[];
  reviewLocationId: string;
  fieldLocationId: string;
  /** Semantic setting type of the review location (e.g. `planning_review`). */
  reviewSettingType: ScenarioSettingType;
  /** Recent per-target style observations, for deterministic avoidance. */
  styleHistory: ScenarioStyleHistory;
  sentences: SourceSentence[];
  factAllocation: FactAllocation;
  maxRepairPasses: number;
  longTargetSeconds?: number;
  shortTargetSeconds?: number;
  findings: ScenarioGenerationFinding[];
}

interface EvidenceDraft {
  claim: string;
  evidenceType: 'source_metric' | 'source_reference';
  sourceRef: string;
  numericFacts: { metric: string; value: number; unit: string }[];
  confidence: 'verified' | 'provisional';
  sentenceIndex?: number;
}

/* ------------------------------------------------------------------ */
/* Fact / evidence allocation                                          */
/* ------------------------------------------------------------------ */

/**
 * Builds evidence records from source-supported material only:
 * explicit keyNumbers, script clauses that contain those figures, and the
 * explicit sourceReferences. Numeric values are copied verbatim.
 */
function allocateFacts(
  keyNumbers: string[],
  sentences: SourceSentence[],
  sourceReferences: string[],
  topic: string,
  videoSlug: string,
): FactAllocation {
  const evidenceIdBySentence = new Map<number, string>();
  const requiredValues: number[] = [];

  const parsedKeyNumbers = keyNumbers
    .map((token) => ({ token, parsed: parseKeyNumber(token) }))
    .filter((entry): entry is { token: string; parsed: ParsedNumber } => entry.parsed !== null);

  // Map each explicit key figure onto the first script clause that states it.
  const keyNumbersBySentence = new Map<number, ParsedNumber[]>();
  const uncovered: { parsed: ParsedNumber }[] = [];

  for (const entry of parsedKeyNumbers) {
    const sentenceIndex = sentences.findIndex((s) => containsExactValue(s.text, entry.parsed.value));
    if (sentenceIndex >= 0) {
      const list = keyNumbersBySentence.get(sentenceIndex) || [];
      list.push(entry.parsed);
      keyNumbersBySentence.set(sentenceIndex, list);
    } else {
      uncovered.push({ parsed: entry.parsed });
    }
  }

  // A figure keeps one unit across the whole project: if the user declared it
  // as a key number (e.g. `42%`), later bare mentions of `42` inherit `%`.
  const unitByValue = new Map<number, string>();
  for (const entry of parsedKeyNumbers) {
    if (!unitByValue.has(entry.parsed.value)) unitByValue.set(entry.parsed.value, entry.parsed.unit);
  }

  const drafts: EvidenceDraft[] = [];

  sentences.forEach((sentence, index) => {
    const keyed = keyNumbersBySentence.get(index) || [];
    const values = [...keyed.map((k) => k.value)];
    for (const value of sentence.numbers) {
      if (!values.includes(value)) values.push(value);
    }
    if (values.length === 0) return;

    drafts.push({
      claim: sentence.text,
      evidenceType: 'source_metric',
      sourceRef: sourceReferences.length > 0 ? sourceReferences[drafts.length % sourceReferences.length] : 'user_script',
      numericFacts: values.map((value, ordinal) => ({
        metric: metricNameFor(value, keyed, ordinal),
        value,
        unit: unitFor(value, keyed, unitByValue),
      })),
      // The user's script and explicit facts are the factual authority.
      confidence: 'verified',
      sentenceIndex: index,
    });

    for (const value of values) if (!requiredValues.includes(value)) requiredValues.push(value);
  });

  for (const entry of uncovered) {
    drafts.push({
      claim: `${topic} - reported figure ${entry.parsed.raw}.`,
      evidenceType: 'source_metric',
      sourceRef: sourceReferences.length > 0 ? sourceReferences[drafts.length % sourceReferences.length] : 'user_script',
      numericFacts: [{ metric: `figure_${drafts.length + 1}`, value: entry.parsed.value, unit: entry.parsed.unit }],
      confidence: 'provisional',
    });
    if (!requiredValues.includes(entry.parsed.value)) requiredValues.push(entry.parsed.value);
  }

  // Guarantee every explicit sourceReference survives into an evidence record.
  const usedRefs = new Set(drafts.map((d) => d.sourceRef));
  for (const ref of sourceReferences) {
    if (usedRefs.has(ref)) continue;
    drafts.push({
      claim: `${topic} - source reference on record for this position.`,
      evidenceType: 'source_reference',
      sourceRef: ref,
      numericFacts: [],
      confidence: 'provisional',
    });
    usedRefs.add(ref);
  }

  const evidence: ScenarioEvidence[] = drafts.map((draft, index) => {
    const id = `ev-${videoSlug}-${String(index + 1).padStart(2, '0')}`;
    if (draft.sentenceIndex !== undefined) evidenceIdBySentence.set(draft.sentenceIndex, id);
    return {
      id,
      claim: draft.claim,
      evidenceType: draft.evidenceType,
      sourceRef: draft.sourceRef,
      numericFacts: draft.numericFacts,
      confidence: draft.confidence,
      usedInSceneIds: [],
      usedInTurnIds: [],
    };
  });

  return { evidenceIdBySentence, requiredValues, evidence };
}

function metricNameFor(value: number, keyed: ParsedNumber[], ordinal: number): string {
  const unit = keyed.find((k) => k.value === value)?.unit || '';
  if (unit === '%') return `percentage_${ordinal + 1}`;
  if (/(day|week|month|year|hour|minute)/i.test(unit)) return `duration_${ordinal + 1}`;
  return `figure_${ordinal + 1}`;
}

function unitFor(value: number, keyed: ParsedNumber[], unitByValue?: Map<number, string>): string {
  const match = keyed.find((k) => k.value === value);
  if (match) return match.unit;
  const inherited = unitByValue?.get(value);
  return inherited !== undefined ? inherited : '';
}

/* ------------------------------------------------------------------ */
/* Input normalisation                                                 */
/* ------------------------------------------------------------------ */

/** Fields that must be present for any generation to be possible. */
const REQUIRED_FIELDS: { field: 'videoId'; label: string }[] = [{ field: 'videoId', label: 'videoId' }];

function makeFailure(
  target: 'input' | 'long' | ShortScenarioKey,
  code: ScenarioGenerationFailureCode,
  message: string,
  ruleIds: string[] = [],
): ProductionScenarioGenerationResult {
  return {
    success: false,
    projectId: '',
    sourceVideoId: '',
    shortScenarios: {},
    findings: [{ severity: 'error', code: `generation.${code}`, target, message }],
    failure: { code, message, target, ruleIds },
  };
}

type ContextResult = { ok: true; ctx: GenerationContext } | { ok: false; error: ProductionScenarioGenerationResult };

function buildContext(input: ProjectInput, options: ScenarioGenerationOptions): ContextResult {
  const findings: ScenarioGenerationFinding[] = [];

  for (const required of REQUIRED_FIELDS) {
    const value = input[required.field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return {
        ok: false,
        error: makeFailure(
          'input',
          'MISSING_REQUIRED_FIELD',
          `ProjectInput.${required.label} is required and must be a non-empty string.`,
        ),
      };
    }
  }

  const videoId = input.videoId.trim();
  const videoSlug = slugify(videoId);

  // An empty or whitespace-only script is an empty SOURCE, not a missing field.
  if (!(input.script || '').trim()) {
    return {
      ok: false,
      error: makeFailure('input', 'EMPTY_SOURCE', 'ProjectInput.script is empty; there is no source content to generate from.'),
    };
  }

  const analysis = analyzeScript(input.script);
  const sentences: SourceSentence[] = [];
  for (const segment of analysis.segments) {
    for (const raw of splitSentences(segment.text)) {
      const classified = analyzeScript(raw).segments[0];
      const fn: ScriptFunction = classified ? classified.fn : 'promise';
      sentences.push({
        index: sentences.length,
        text: raw,
        fn,
        purpose: FUNCTION_TO_PURPOSE[fn],
        numbers: extractNumbers(raw),
      });
    }
  }

  if (sentences.length === 0) {
    return {
      ok: false,
      error: makeFailure('input', 'EMPTY_SOURCE', 'ProjectInput.script contains no substantive sentences to build a scenario from.'),
    };
  }

  // The opening sentence is always the hook beat (RULE-008).
  sentences[0].purpose = 'hook';

  // Stage remedy cues as the solution beat. Editorial classification only.
  for (const sentence of sentences) {
    if (sentence.purpose === 'hook') continue;
    if (sentence.purpose === 'decision' || sentence.purpose === 'result') continue;
    if (REMEDY_CUE_RE.test(sentence.text)) sentence.purpose = 'solution';
  }

  // The closing content sentence is the takeaway beat. This is a purely
  // positional editorial rule: it never changes the wording of the source.
  // The script's own closing call-to-action keeps its 'decision' beat.
  let lastContentIndex = -1;
  for (let i = sentences.length - 1; i > 0; i--) {
    if (sentences[i].fn !== 'cta') {
      lastContentIndex = i;
      break;
    }
  }
  if (lastContentIndex > 0) sentences[lastContentIndex].purpose = 'result';

  const topic = (input.topic || '').trim() || sentences[0].text.slice(0, 120);
  const brief = (input.mainProblem || '').trim() || topic;
  const audience = (input.targetAudience || '').trim() || 'Project delivery professionals';
  const outcome = (input.viewerPromise || '').trim() || brief;
  const ctaText = (input.cta || '').trim();
  const productName = (input.productName || '').trim();
  const sourceReferences = (input.sourceReferences || []).map((r) => (r || '').trim()).filter(Boolean);

  if (!(input.targetAudience || '').trim()) {
    findings.push({
      severity: 'info',
      code: 'source.target_audience_defaulted',
      target: 'input',
      message: 'ProjectInput.targetAudience is empty; a neutral, non-factual audience descriptor was used.',
    });
  }

  const haystack = [
    topic,
    audience,
    brief,
    outcome,
    (input.hook || '').trim(),
    input.script,
    ...(input.keyPoints || []),
    ...sourceReferences,
    productName,
  ]
    .join(' ')
    .toLowerCase();

  // Cross-video diversity: deterministically avoid persona combinations used
  // by the most recent production history entries (explicit input, no randomness).
  const personas = avoidRecentPersonaCombinations(selectPersonas(haystack), haystack, options.personaHistory);
  const characterIdByRole: Record<PersonaRole, string> = {
    challenger: `char-${videoSlug}-${personas.challenger.key}`,
    technical_authority: `char-${videoSlug}-${personas.technical_authority.key}`,
    decision_maker: `char-${videoSlug}-${personas.decision_maker.key}`,
  };

  // Deterministic voice-slot assignment from the Phase 4A default registry.
  // Slot selection follows the persona's gender presentation when available and
  // never assigns the same slot to two characters of one scenario, so every
  // generated scenario is directly synthesizable with distinct production voices.
  const VOICE_SLOT_BY_PERSONA: Record<string, string> = {
    'commercial-lead': 'voice_en_male_commercial',
    'construction-manager': 'voice_en_male_practical',
    'client-representative': 'voice_en_female_authority',
    'controls-lead': 'voice_us_male_executive',
    'quality-lead': 'voice_en_female_legal',
    'planning-engineer': 'voice_us_female_analytic',
    'structural-engineer': 'voice_en_male_practical',
    'mep-engineer': 'voice_us_male_field',
    'quantity-surveyor': 'voice_en_male_advocate',
    'data-analyst': 'voice_us_female_analytic',
    'project-director': 'voice_us_male_executive',
    'project-manager': 'voice_en_female_authority',
    'programme-manager': 'voice_en_male_advocate',
    'operations-director': 'voice_us_male_field',
    'engineering-manager': 'voice_en_male_practical',
  };
  const usedSlots = new Set<string>();
  const characters: ScenarioCharacter[] = PERSONA_ROLE_ORDER.map((role) => {
    const persona = personas[role];
    let voiceSlot = VOICE_SLOT_BY_PERSONA[persona.key] ?? 'voice_en_female_authority';
    if (usedSlots.has(voiceSlot)) {
      // Deterministic distinct-slot fallbacks (registry slots, never duplicated).
      const fallbacks = ['voice_en_male_practical', 'voice_en_female_legal', 'voice_en_male_commercial', 'voice_us_male_field', 'voice_en_female_authority', 'voice_us_male_executive'];
      voiceSlot = fallbacks.find((s) => !usedSlots.has(s)) ?? voiceSlot;
    }
    usedSlots.add(voiceSlot);
    return {
      id: characterIdByRole[role],
      name: persona.name,
      role: persona.role,
      narrativeFunction: persona.narrativeFunction,
      voiceSlot,
      visualDescription: persona.visualDescription,
      communicationStyle: persona.communicationStyle,
      constraints: [...persona.constraints],
    };
  });

  findings.push({
    severity: 'info',
    code: 'source.cast_is_narrative_scaffolding',
    target: 'input',
    message:
      'Characters are deterministic narrative personas derived from the project context. They are not user-supplied facts and assert no project data.',
  });

  const hasTimelineOrSteps = analysis.hasTimeline || sentences.some((s) => s.fn === 'steps');
  const hasWarning = analysis.hasWarning || sentences.some((s) => s.fn === 'warning');
  const reviewSetting = hasTimelineOrSteps ? 'planning_review' : hasWarning ? 'progress_meeting' : 'office_discussion';
  const reviewSettingType: ScenarioSettingType = reviewSetting;
  const shortTopic = topic.length > 48 ? `${topic.slice(0, 45).trimEnd()}...` : topic;

  const reviewLocationId = `loc-${videoSlug}-review`;
  const fieldLocationId = `loc-${videoSlug}-field`;
  const locations: ScenarioLocation[] = [
    {
      id: reviewLocationId,
      name: `${shortTopic} - Review Room`,
      settingType: reviewSetting,
      description: 'Controlled review setting where the reported position is examined against the source records.',
      environment: 'indoor',
    },
    {
      id: fieldLocationId,
      name: `${shortTopic} - Site Verification Area`,
      settingType: 'site_walk',
      description: 'Physical work area used to verify the reported position against what is actually in place.',
      environment: 'hybrid',
    },
  ];

  return {
    ok: true,
    ctx: {
      videoId,
      videoSlug,
      projectId: options.projectId?.trim() || `proj-${videoSlug}`,
      language: (input.outputLanguage || '').trim() || 'en',
      topic,
      brief,
      audience,
      outcome,
      ctaText,
      productName,
      sourceReferences,
      characters,
      characterIdByRole,
      locations,
      reviewLocationId,
      fieldLocationId,
      reviewSettingType,
      styleHistory: styleFingerprintsFromPersonaHistory(options.personaHistory),
      sentences,
      factAllocation: allocateFacts(input.keyNumbers || [], sentences, sourceReferences, topic, videoSlug),
      maxRepairPasses: options.maxRepairPasses ?? 4,
      longTargetSeconds: options.longTargetSeconds,
      shortTargetSeconds: options.shortTargetSeconds,
      findings,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Scene assembly                                                      */
/* ------------------------------------------------------------------ */

interface SceneBlueprint {
  purpose: SceneNarrativePurpose;
  sentences: SourceSentence[];
}

/**
 * Groups consecutive sentences that share a narrative purpose, then splits any
 * group larger than `maxPerScene` so no single scene becomes an undifferentiated
 * block of turns.
 */
function groupIntoBlueprints(sentences: SourceSentence[], maxPerScene: number): SceneBlueprint[] {
  const grouped: SceneBlueprint[] = [];
  for (const sentence of sentences) {
    const last = grouped[grouped.length - 1];
    if (last && last.purpose === sentence.purpose && last.sentences.length < maxPerScene) {
      last.sentences.push(sentence);
    } else {
      grouped.push({ purpose: sentence.purpose, sentences: [sentence] });
    }
  }
  return grouped;
}

interface TargetSpec {
  key: 'long' | ShortScenarioKey;
  targetTag: string;
  targetFormat: 'Long' | 'Short';
  scenarioId: string;
  title: string;
  characterCount: 2 | 3;
  /** Upper bound on source sentences carried by a single scene. */
  maxSentencesPerScene: number;
}

/**
 * Builds the scene list for one target.
 *
 * `evidenceById` holds this target's own CLONE of the evidence records, so the
 * `usedInSceneIds` / `usedInTurnIds` bookkeeping written here can never leak
 * from the Long into a Short (or between two Shorts).
 */
function buildScenes(
  ctx: GenerationContext,
  spec: TargetSpec,
  sentences: SourceSentence[],
  evidenceById: Map<string, ScenarioEvidence>,
): ScenarioScene[] {
  const allocator = new LineAllocator(allocatorSeedFor(spec));
  const blueprints = groupIntoBlueprints(sentences, spec.maxSentencesPerScene);
  if (blueprints.length === 0) return [];

  // The opening beat is always the hook (RULE-008).
  blueprints[0].purpose = 'hook';

  const roles: PersonaRole[] =
    spec.characterCount === 3
      ? ['challenger', 'technical_authority', 'decision_maker']
      : ['challenger', 'decision_maker'];

  // Deterministic style variation from recent production history (Workstream D).
  // The history-free treatment is kept unless it substantially repeats a recent
  // video; otherwise the SMALLEST diverging rotation of each cycle is applied.
  // Purely visual: spoken text, numbers, evidence and references are untouched.
  const styleVariation = resolveStyleVariation(
    buildStyleDefaults(
      blueprints.map((b) => b.purpose),
      roles,
      ctx,
    ),
    recentStyleObservations(ctx, spec.targetTag),
    {
      shot: SHOT_CYCLE,
      framing: FRAMING_CYCLE,
      camera: CAMERA_CYCLE,
      setting: [ctx.reviewSettingType, ctx.reviewSettingType, 'site_walk'],
    },
  );

  const scenes: ScenarioScene[] = [];
  let shotRun = 0;
  let lastShot: ShotTypeLike | '' = '';

  blueprints.forEach((blueprint, sceneIndex) => {
    const purpose = blueprint.purpose;
    const speakers = PURPOSE_SPEAKERS[purpose];
    const primaryRole = roles.includes(speakers.primary) ? speakers.primary : roles[0];
    const secondaryRole = roles.includes(speakers.secondary)
      ? speakers.secondary
      : roles.find((r) => r !== primaryRole) || roles[0];
    const primaryId = ctx.characterIdByRole[primaryRole];
    const secondaryId = ctx.characterIdByRole[secondaryRole];

    const sceneId = `sc-${ctx.videoSlug}-${spec.targetTag}-${String(sceneIndex + 1).padStart(2, '0')}-${purpose}`;
    const turns: DialogueTurn[] = [];
    const sceneEvidenceIds: string[] = [];

    blueprint.sentences.forEach((sentence, sentenceIndex) => {
      if (sentenceIndex > 0) {
        // Reaction beat between two factual statements keeps the exchange alive.
        const reactionIntent = reactionIntentFor(purpose, sentenceIndex);
        turns.push({
          id: `${sceneId}-turn-${String(turns.length + 1).padStart(2, '0')}`,
          speakerId: secondaryId,
          spokenText: allocator.line(reactionIntent),
          intent: reactionIntent,
          delivery: reactionIntent === 'objection' ? 'skeptical' : 'collaborative',
          pauseAfterSeconds: 0.3,
          reactionTargetId: primaryId,
        });
      }

      // A directive sentence (the script's own call to action) reads best bare,
      // and a frame that repeats a word the payload already uses is dropped.
      const frame =
        sentence.fn === 'cta' || frameClashesWithPayload(allocator.frame(purpose), sentence.text)
          ? BARE_FRAME
          : allocator.frame(purpose);
      const payload = frame.lowerFirst ? lowerFirstCharacter(sentence.text) : sentence.text;
      const evidenceId = ctx.factAllocation.evidenceIdBySentence.get(sentence.index);
      if (evidenceId && !sceneEvidenceIds.includes(evidenceId)) sceneEvidenceIds.push(evidenceId);

      turns.push({
        id: `${sceneId}-turn-${String(turns.length + 1).padStart(2, '0')}`,
        speakerId: primaryId,
        spokenText: `${frame.lead}${payload}`,
        intent: FUNCTION_TO_INTENT[sentence.fn],
        delivery: deliveryFor(purpose, sentenceIndex),
        pauseAfterSeconds: 0.4,
        ...(evidenceId ? { evidenceId } : {}),
        onScreenText: onScreenTextFor(sentence.text),
      });
    });

    // Closing reaction so the scene ends on an exchange, not a monologue.
    // It rotates on the scene index so different scenes close differently.
    const closingIntent = reactionIntentFor(purpose, sceneIndex);
    turns.push({
      id: `${sceneId}-turn-${String(turns.length + 1).padStart(2, '0')}`,
      speakerId: secondaryId,
      spokenText: allocator.line(closingIntent),
      intent: closingIntent,
      delivery: closingIntent === 'objection' ? 'skeptical' : 'collaborative',
      pauseAfterSeconds: 0.3,
      reactionTargetId: primaryId,
    });

    // ---- production direction ------------------------------------
    let shot: ShotTypeLike = rotateShotType(PURPOSE_SHOT_TYPE[purpose], styleVariation.shotOffset);
    if (shot === lastShot) {
      shotRun += 1;
      if (shotRun >= 3) {
        shot = SHOT_CYCLE[(sceneIndex + 2) % SHOT_CYCLE.length];
        if (shot === lastShot) shot = SHOT_CYCLE[(sceneIndex + 3) % SHOT_CYCLE.length];
        shotRun = 1;
      }
    } else {
      shotRun = 1;
    }
    lastShot = shot;

    const isField = isFieldScene(purpose, sceneIndex, styleVariation.settingOffset);
    const evidenceRecord = sceneEvidenceIds.length > 0 ? evidenceById.get(sceneEvidenceIds[0]) : undefined;

    scenes.push({
      id: sceneId,
      index: sceneIndex,
      title: PURPOSE_LABEL[purpose],
      narrativePurpose: purpose,
      locationId: isField ? ctx.fieldLocationId : ctx.reviewLocationId,
      estimatedDuration: 1,
      participantIds: Array.from(new Set([primaryId, secondaryId])),
      turns,
      production: {
        shotType: shot,
        framing: FRAMING_CYCLE[(sceneIndex + styleVariation.framingOffset) % FRAMING_CYCLE.length],
        speakerFocus: speakerFocusFor(purpose),
        cameraMovement: CAMERA_CYCLE[(sceneIndex + styleVariation.cameraOffset) % CAMERA_CYCLE.length],
        ...(evidenceRecord
          ? { screenInsert: { title: 'Source Record', description: evidenceRecord.claim } }
          : {}),
        transitionIntent: { type: 'cut' },
      },
      ...(sceneEvidenceIds.length > 0 ? { evidenceIds: [...sceneEvidenceIds] } : {}),
      onScreenInfo: {
        title: `${PURPOSE_LABEL[purpose]} // ${ctx.topic.slice(0, 48)}`,
        ...(evidenceRecord && evidenceRecord.numericFacts.length > 0
          ? {
              callout: evidenceRecord.numericFacts
                .map((f) => `${f.metric}: ${f.value}${f.unit}`)
                .join(' | '),
            }
          : {}),
      },
    });
  });

  // ---- synthetic CTA scene ----------------------------------------
  const ctaSceneId = `sc-${ctx.videoSlug}-${spec.targetTag}-${String(scenes.length + 1).padStart(2, '0')}-cta`;
  const ctaSpeaker = ctx.characterIdByRole.decision_maker;
  const ctaSupport = ctx.characterIdByRole.challenger;
  const usedSentenceText = new Set(sentences.map((s) => s.text));
  // The user's CTA wins when supplied and not already spoken verbatim;
  // otherwise a neutral, non-factual template is used.
  const ctaCandidates = ctx.ctaText && !usedSentenceText.has(ctx.ctaText)
    ? [ctx.ctaText, ...NEUTRAL_CTA_TURNS]
    : NEUTRAL_CTA_TURNS;
  const ctaBody = allocator.body(ctaCandidates);

  scenes.push({
    id: ctaSceneId,
    index: scenes.length,
    title: PURPOSE_LABEL.cta,
    narrativePurpose: 'cta',
    locationId: ctx.reviewLocationId,
    estimatedDuration: 1,
    participantIds: [ctaSpeaker, ctaSupport],
    turns: [
      {
        id: `${ctaSceneId}-turn-01`,
        speakerId: ctaSpeaker,
        spokenText: ctaBody,
        intent: 'call_to_action',
        delivery: 'authoritative',
        pauseAfterSeconds: 0.6,
        onScreenText: ctx.productName ? `${ctx.productName.toUpperCase()} // NEXT STEP` : 'NEXT STEP',
      },
      {
        id: `${ctaSceneId}-turn-02`,
        speakerId: ctaSupport,
        spokenText: allocator.line('cta_support'),
        intent: 'assertion',
        delivery: 'collaborative',
        pauseAfterSeconds: 0.3,
        reactionTargetId: ctaSpeaker,
      },
    ],
    production: {
      shotType: 'two_shot',
      framing: 'center',
      speakerFocus: 'speaking_character',
      cameraMovement: 'subtle_drift',
      transitionIntent: { type: 'fade_black', durationSeconds: 0.6 },
    },
    onScreenInfo: {
      title: `${PURPOSE_LABEL.cta} // ${ctx.topic.slice(0, 48)}`,
    },
    transitionIntent: { type: 'fade_black', durationSeconds: 0.6 },
  });

  // ---- evidence usage bookkeeping ---------------------------------
  for (const scene of scenes) {
    for (const turn of scene.turns) {
      if (!turn.evidenceId) continue;
      const record = evidenceById.get(turn.evidenceId);
      if (!record) continue;
      if (!record.usedInSceneIds.includes(scene.id)) record.usedInSceneIds.push(scene.id);
      if (!record.usedInTurnIds.includes(turn.id)) record.usedInTurnIds.push(turn.id);
    }
  }

  return scenes;
}

/**
 * True when a frame's own content words already appear in the payload, which
 * would read as redundant ("The fix is straightforward. Now the fix.").
 * Only the opening words of the payload are considered, so ordinary topic
 * overlap deeper in the sentence is not treated as a clash.
 */
function frameClashesWithPayload(frame: SentenceFrame, payload: string): boolean {
  if (!frame.lead) return false;
  const frameWords = frame.lead.toLowerCase().match(/[a-z]{3,}/g) || [];
  if (frameWords.length === 0) return false;
  const opening = payload.toLowerCase().split(/\s+/).slice(0, 5).join(' ');
  return frameWords.some((word) => opening.includes(word));
}

/** Deterministic per-target seed for the connective scaffolding. */
function allocatorSeedFor(spec: TargetSpec): number {
  if (spec.key === 'long') return 0;
  const ordinal = Number(spec.targetTag.replace('short', ''));
  return Number.isFinite(ordinal) ? ordinal + 1 : 1;
}

/** Rotates the secondary speaker's reaction intent inside a scene. */
function reactionIntentFor(purpose: SceneNarrativePurpose, index: number): TurnIntent {
  const pool = PURPOSE_REACTION_INTENTS[purpose];
  return pool[index % pool.length];
}

function deliveryFor(purpose: SceneNarrativePurpose, index: number): TurnDelivery {
  if (purpose === 'problem' || purpose === 'hook') return index === 0 ? 'urgent' : 'firm';
  if (purpose === 'evidence') return 'authoritative';
  if (purpose === 'disagreement') return 'skeptical';
  if (purpose === 'decision') return 'authoritative';
  if (purpose === 'cta') return 'firm';
  return 'calm';
}

function speakerFocusFor(purpose: SceneNarrativePurpose): SpeakerFocus {
  if (purpose === 'evidence') return 'document';
  if (purpose === 'demonstration') return 'group';
  return 'speaking_character';
}

function onScreenTextFor(sentence: string): string {
  const cleaned = sentence.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 64) return cleaned.toUpperCase();
  const clipped = cleaned.slice(0, 61).replace(/\s+\S*$/, '');
  return `${clipped.toUpperCase()}...`;
}

/* ------------------------------------------------------------------ */
/* Scenario assembly + validation                                      */
/* ------------------------------------------------------------------ */

function assembleScenario(ctx: GenerationContext, spec: TargetSpec, sentences: SourceSentence[]): Scenario {
  // One evidence clone per emitted scenario: usage bookkeeping is per-target.
  const evidenceById = new Map<string, ScenarioEvidence>();
  for (const record of ctx.factAllocation.evidence) {
    evidenceById.set(record.id, JSON.parse(JSON.stringify(record)) as ScenarioEvidence);
  }

  const scenes = buildScenes(ctx, spec, sentences, evidenceById);
  const total = totalSecondsOf(scenes);

  const rawTarget = spec.targetFormat === 'Short' ? (ctx.shortTargetSeconds ?? total) : (ctx.longTargetSeconds ?? total);
  const targetSeconds =
    spec.targetFormat === 'Short' ? Math.max(1, Math.min(58, Math.round(rawTarget))) : Math.max(1, Math.round(rawTarget));

  const evidence = Array.from(evidenceById.values());

  return {
    metadata: {
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      id: spec.scenarioId,
      projectId: ctx.projectId,
      title: spec.title,
      language: ctx.language,
      targetFormat: spec.targetFormat,
      sourceBrief: ctx.brief,
      targetAudience: ctx.audience,
      intendedOutcome: ctx.outcome,
      estimatedDuration: {
        targetSeconds,
        minSeconds: Math.max(1, Math.round(targetSeconds * 0.9)),
        maxSeconds: Math.round(targetSeconds * 1.1),
        estimatedSeconds: total,
      },
    },
    characters: ctx.characters.map((c) => ({ ...c, constraints: [...(c.constraints || [])] })),
    locations: ctx.locations.map((l) => ({ ...l })),
    evidence,
    scenes,
  };
}

/** Scene durations are derived from the dialogue, never padded. */
function syncSceneDurations(scenario: Scenario): void {
  for (const scene of scenario.scenes) {
    scene.estimatedDuration = Math.max(
      0.5,
      round2(estimateSceneDuration(scene, DEFAULT_DURATION_CONFIG).totalSeconds),
    );
  }
}

function protectedSceneIds(scenario: Scenario): Set<string> {
  const protectedIds = new Set<string>();
  const evidenceWithFacts = new Set(scenario.evidence.filter((e) => e.numericFacts.length > 0).map((e) => e.id));
  for (const scene of scenario.scenes) {
    if (scene.narrativePurpose === 'hook' || scene.narrativePurpose === 'cta') {
      protectedIds.add(scene.id);
      continue;
    }
    if (scene.turns.some((t) => t.evidenceId && evidenceWithFacts.has(t.evidenceId))) {
      protectedIds.add(scene.id);
    }
  }
  return protectedIds;
}

interface ValidatedTarget {
  ok: boolean;
  report?: ValidationReport;
  repairActions: string[];
}

function validateAndRepair(scenario: Scenario, ctx: GenerationContext, spec: TargetSpec): ValidatedTarget {
  const repairContext: ScenarioRepairContext = {
    targetFormat: spec.targetFormat,
    // The generator targets the warning-free window of the Short contract
    // (60s) so emitted Shorts never trip the 65s hard ceiling either.
    hardDurationCeiling: spec.targetFormat === 'Short' ? 60 : undefined,
    protectedSceneIds: protectedSceneIds(scenario),
  };

  let report = validateScenario(scenario);
  if (report.valid) return { ok: true, report, repairActions: [] };

  const outcome = repairScenarioInPlace(scenario, repairContext, ctx.maxRepairPasses);
  syncSceneDurations(scenario);

  // Recompute the metadata block after any structural repair.
  const total = totalSecondsOf(scenario.scenes);
  const rawTarget = spec.targetFormat === 'Short' ? (ctx.shortTargetSeconds ?? total) : (ctx.longTargetSeconds ?? total);
  const targetSeconds =
    spec.targetFormat === 'Short' ? Math.max(1, Math.min(58, Math.round(rawTarget))) : Math.max(1, Math.round(rawTarget));
  scenario.metadata.estimatedDuration = {
    targetSeconds,
    minSeconds: Math.max(1, Math.round(targetSeconds * 0.9)),
    maxSeconds: Math.round(targetSeconds * 1.1),
    estimatedSeconds: total,
  };

  report = validateScenario(scenario);
  return { ok: report.valid, report, repairActions: outcome.actions };
}

/* ------------------------------------------------------------------ */
/* Short selection                                                     */
/* ------------------------------------------------------------------ */

/**
 * Ranks every source sentence for one editorial angle.
 *
 * The angle's preferred purposes come first, then its widening chain, then any
 * remaining purpose. Within a rank, original source order is preserved so the
 * narrative still reads in the order the user wrote it.
 */
function rankSentencesForAngle(ctx: GenerationContext, angle: ShortAngleSpec): SourceSentence[] {
  const has = (purpose: SceneNarrativePurpose) => ctx.sentences.some((s) => s.purpose === purpose);

  // Preference order: the angle's own purposes first, then its widening chain,
  // then anything still unplaced. De-duplicated so a later list can never
  // overwrite the rank a purpose already earned.
  const seen = new Set<SceneNarrativePurpose>();
  const preferred: SceneNarrativePurpose[] = [];
  for (const purpose of [...angle.purposes, ...angle.widen, ...ALL_PURPOSES]) {
    if (seen.has(purpose) || !has(purpose)) continue;
    seen.add(purpose);
    preferred.push(purpose);
  }

  const rank = new Map<SceneNarrativePurpose, number>(preferred.map((purpose, index) => [purpose, index]));

  return [...ctx.sentences]
    .filter((sentence) => rank.has(sentence.purpose))
    .sort((a, b) => {
      const rankA = rank.get(a.purpose) as number;
      const rankB = rank.get(b.purpose) as number;
      if (rankA !== rankB) return rankA - rankB;
      return a.index - b.index;
    });
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

/**
 * Generates the production scenario set for one project.
 *
 * Deterministic and offline. The caller's `input` object is never mutated.
 */
export function generateProductionScenariosFromProjectInput(
  input: ProjectInput,
  options: ScenarioGenerationOptions = {},
): ProductionScenarioGenerationResult {
  // Snapshot so the caller's object can never be mutated by generation.
  const frozen: ProjectInput = JSON.parse(JSON.stringify(input)) as ProjectInput;

  const requestedShortCount = options.shortCount ?? frozen.shortCount ?? 0;
  if (!Number.isInteger(requestedShortCount) || requestedShortCount < 0 || requestedShortCount > MAX_SHORT_SCENARIOS) {
    return makeFailure(
      'input',
      'SHORT_COUNT_OUT_OF_RANGE',
      `shortCount must be an integer between 0 and ${MAX_SHORT_SCENARIOS}; received ${String(requestedShortCount)}.`,
    );
  }

  const built = buildContext(frozen, options);
  if (!built.ok) return built.error;
  const ctx = built.ctx;

  const findings: ScenarioGenerationFinding[] = [...ctx.findings];
  const shortScenarios: Partial<Record<ShortScenarioKey, Scenario>> = {};

  const longSpec: TargetSpec = {
    key: 'long',
    targetTag: 'long',
    targetFormat: 'Long',
    scenarioId: `scenario-${ctx.videoSlug}-long`,
    title: ctx.topic,
    characterCount: 3,
    maxSentencesPerScene: 3,
  };

  const longScenario = assembleScenario(ctx, longSpec, ctx.sentences);
  syncSceneDurations(longScenario);
  const longResult = validateAndRepair(longScenario, ctx, longSpec);

  for (const finding of longResult.report?.findings || []) {
    findings.push({
      severity: finding.severity,
      code: `long.${finding.ruleId}`,
      target: 'long',
      message: finding.message,
      ruleId: finding.ruleId,
    });
  }

  if (!longResult.ok) {
    return {
      success: false,
      projectId: ctx.projectId,
      sourceVideoId: ctx.videoId,
      shortScenarios: {},
      findings,
      failure: {
        code: 'LONG_SCENARIO_INVALID',
        message: 'The generated Long scenario could not be made valid after bounded deterministic repair.',
        target: 'long',
        ruleIds: (longResult.report?.findings || []).filter((f) => f.severity === 'error').map((f) => f.ruleId),
      },
    };
  }

  if (requestedShortCount === 0) {
    return {
      success: true,
      projectId: ctx.projectId,
      sourceVideoId: ctx.videoId,
      longScenario,
      shortScenarios,
      findings,
    };
  }

  // Each requested Short must be a genuinely different edit of the same
  // source. If two angles would be forced to use the identical set of source
  // sentences, the requested count cannot be honoured without duplicating
  // content, and generation fails with a structured error instead.
  const shortSourceSelections = new Map<string, string>();

  for (const angle of SHORT_ANGLES.slice(0, requestedShortCount)) {
    const ranked = rankSentencesForAngle(ctx, angle);
    if (ranked.length < 2) {
      findings.push({
        severity: 'error',
        code: `short.unavailable.${angle.key}`,
        target: angle.key,
        message: `Not enough distinct source content for the "${angle.label}" angle without inventing facts.`,
      });
      return {
        success: false,
        projectId: ctx.projectId,
        sourceVideoId: ctx.videoId,
        longScenario,
        shortScenarios,
        findings,
        failure: {
          code: 'INSUFFICIENT_SOURCE_CONTENT',
          message: `The requested Short "${angle.key}" (${angle.label}) cannot be produced from this source without inventing facts.`,
          target: angle.key,
          ruleIds: [],
        },
      };
    }

    const spec: TargetSpec = {
      key: angle.key,
      targetTag: angle.key.replace('_', ''),
      targetFormat: 'Short',
      scenarioId: `scenario-${ctx.videoSlug}-${angle.key.replace('_', '-')}`,
      title: `${ctx.topic} - ${angle.label}`,
      characterCount: ctx.sentences.length >= 6 ? 3 : 2,
      maxSentencesPerScene: 2,
    };

    // Duration budget: the Short contract warns above 60s and errors above
    // 65s, so the generator targets the warning-free window. It keeps the
    // LONGEST prefix of the angle's preference-ordered sentences that still
    // fits, which is what makes the three angles genuinely different edits of
    // the same source rather than the same clip trimmed three ways.
    const budget = Math.max(2, Math.min(58, Math.round(ctx.shortTargetSeconds ?? 52)));

    let shortScenario: Scenario | null = null;
    let bestCount = 0;

    for (let count = 2; count <= ranked.length; count++) {
      const sourceOrdered = [...ranked.slice(0, count)].sort((a, b) => a.index - b.index);
      const built = assembleScenario(ctx, spec, sourceOrdered);
      syncSceneDurations(built);
      if (totalSecondsOf(built.scenes) <= budget) {
        shortScenario = built;
        bestCount = count;
      }
    }

    if (!shortScenario) {
      findings.push({
        severity: 'error',
        code: `short.too_long.${angle.key}`,
        target: angle.key,
        message: `Even the shortest honest selection for the "${angle.label}" angle exceeds the Short duration budget of ${budget}s.`,
      });
      return {
        success: false,
        projectId: ctx.projectId,
        sourceVideoId: ctx.videoId,
        longScenario,
        shortScenarios,
        findings,
        failure: {
          code: 'INSUFFICIENT_SOURCE_CONTENT',
          message: `The requested Short "${angle.key}" (${angle.label}) cannot be produced within the Short duration ceiling from this source.`,
          target: angle.key,
          ruleIds: [],
        },
      };
    }

    const selectionSignature = [...ranked.slice(0, bestCount)]
      .sort((a, b) => a.index - b.index)
      .map((sentence) => sentence.text)
      .join('\u0000');

    const duplicatingAngle = shortSourceSelections.get(selectionSignature);
    if (duplicatingAngle) {
      findings.push({
        severity: 'error',
        code: `short.duplicate_angle.${angle.key}`,
        target: angle.key,
        message: `The "${angle.label}" angle would repeat the same source content already used by "${duplicatingAngle}"; the source does not support ${requestedShortCount} distinct Shorts.`,
      });
      return {
        success: false,
        projectId: ctx.projectId,
        sourceVideoId: ctx.videoId,
        longScenario,
        shortScenarios,
        findings,
        failure: {
          code: 'INSUFFICIENT_SOURCE_CONTENT',
          message: `The requested Short "${angle.key}" (${angle.label}) would duplicate the source content of "${duplicatingAngle}"; this source cannot support ${requestedShortCount} distinct Shorts without repeating content.`,
          target: angle.key,
          ruleIds: [],
        },
      };
    }
    shortSourceSelections.set(selectionSignature, angle.label);

    findings.push({
      severity: 'info',
      code: `short.selection.${angle.key}`,
      target: angle.key,
      message: `Short "${angle.key}" (${angle.label}) selected ${bestCount} of ${ranked.length} ranked source sentences to fit the ${budget}s Short budget.`,
    });

    const shortResult = validateAndRepair(shortScenario, ctx, spec);

    for (const finding of shortResult.report?.findings || []) {
      findings.push({
        severity: finding.severity,
        code: `${angle.key}.${finding.ruleId}`,
        target: angle.key,
        message: finding.message,
        ruleId: finding.ruleId,
      });
    }

    if (!shortResult.ok) {
      return {
        success: false,
        projectId: ctx.projectId,
        sourceVideoId: ctx.videoId,
        longScenario,
        shortScenarios,
        findings,
        failure: {
          code: 'SHORT_SCENARIO_INVALID',
          message: `The generated Short "${angle.key}" could not be made valid after bounded deterministic repair.`,
          target: angle.key,
          ruleIds: (shortResult.report?.findings || []).filter((f) => f.severity === 'error').map((f) => f.ruleId),
        },
      };
    }

    shortScenarios[angle.key] = shortScenario;
  }

  return {
    success: true,
    projectId: ctx.projectId,
    sourceVideoId: ctx.videoId,
    longScenario,
    shortScenarios,
    findings,
  };
}

/* ------------------------------------------------------------------ */
/* Generator implementation                                            */
/* ------------------------------------------------------------------ */

/**
 * The shipped local, deterministic, offline scenario generator.
 *
 * It is the direct adapter from the existing `ProjectInput` shape to the
 * existing `Scenario` contract. It never reads a fixture, never calls the
 * clock, and never generates a random identifier.
 */
export class ScriptScenarioGenerator implements ScenarioGenerator {
  readonly id = LOCAL_SCRIPT_SCENARIO_GENERATOR_ID;
  readonly deterministic = true;

  generate(request: ScenarioGenerationRequest): ProductionScenarioGenerationResult {
    if (!request || typeof request !== 'object' || !request.input) {
      return makeFailure('input', 'MISSING_REQUIRED_FIELD', 'A ScenarioGenerationRequest with an `input` is required.');
    }
    return generateProductionScenariosFromProjectInput(request.input, request.options || {});
  }
}

/** Convenience factory for the shipped generator. */
export function createScriptScenarioGenerator(): ScriptScenarioGenerator {
  return new ScriptScenarioGenerator();
}

/** Alias used by the production adapter registry. */
export function createLocalScenarioGenerator(): ScriptScenarioGenerator {
  return new ScriptScenarioGenerator();
}

/**
 * Stable public entry point for the production content engine.
 *
 * Equivalent to `createScriptScenarioGenerator().generate({ input, options })`.
 */
export function generateProductionScenarios(
  input: ProjectInput,
  options?: ScenarioGenerationOptions,
): ProductionScenarioGenerationResult {
  return createScriptScenarioGenerator().generate({ input, options: options || {} });
}
