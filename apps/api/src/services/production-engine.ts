/**
 * BuildTrack Video Factory - Workstream D Production Engine Service
 *
 * The NEW production authority behind the EXISTING product workflow:
 *
 *   ProjectInput
 *     → generateProductionScenarios()        (Workstream A, no fixtures)
 *     → Scenario per target                  (persisted in the sidecar)
 *     → buildDialogueProductionPlan(production mode → Kokoro)
 *     → Phase 5 plan chain
 *     → Phase 6A resolveProductionAssets (explicit bindings)
 *     → Phase 6C/6D via runPlanBasedProductionExport
 *
 * No fixture scenarios enter this path. No legacy storyboard/Scene[]/
 * targetAudio/exportProject authority is used for video. Kokoro cache
 * failures surface as actionable errors (`npm run provision:tts`).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  generateProductionScenariosFromProjectInput,
  validateScenario,
  resolveProductionAssets,
  buildScenarioStyleFingerprint,
  personaKeyFromCharacterId,
  type Asset,
  type Project,
  type ProjectInput,
  type Scenario,
  type RemotionCompositionPlan,
  type DeliveryTargetId,
} from '@buildtrack/core';
import {
  PRODUCTION_STATE_VERSION,
  applyEditToState,
  computeGenerationFingerprint,
  filterAssetBindingsToGeneratedSlots,
  fingerprintProjectInput,
  invalidateDownstreamForRegeneration,
  isStaleAgainstInput,
  loadProductionState,
  newProductionState,
  recordBuild,
  saveProductionState,
  type ProductionArtifact,
  type ProductionHistoryEntry,
  type ProductionState,
  type ProductionTargetEdit,
  type ProductionTargetId,
} from './production-state.js';
import { buildRemotionPlanFromScenario, runPlanBasedProductionExport } from './plan-production.js';
import { OUTPUT_DIR } from './platform.js';
import {
  mergeUsedInUpdates,
  outputRelativePath,
  writeProductionDeliverables,
  type WriteProductionDeliverablesInput,
} from './production-deliverables.js';

/** The engine/audio authority used by every production build. */
export const PRODUCTION_AUDIO_ENGINE = 'kokoro-js';

export class ProductionError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ProductionError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/*  Generation                                                         */
/* ------------------------------------------------------------------ */

export interface ProductionPersonaHistoryEntry {
  personas: Partial<Record<'challenger' | 'technical_authority' | 'decision_maker', string>>;
  styleFingerprint?: string;
}

/**
 * Input contract for production generation history.
 *
 * The REAL production history (`production_history.json`, written after every
 * successful final production) is the authority for the new Scenario engine.
 * The legacy visual history is kept ONLY as a fallback for legacy/reference
 * projects that predate production history — never as the authority when real
 * production observations exist.
 */
export interface ProductionGenerationHistoryInput {
  /** Real production casting/style observations (production_history.json). */
  productionHistory?: readonly ProductionHistoryEntry[];
  /** Legacy visual history (visual_history.json) — fallback for legacy projects. */
  legacyVisualHistory?: unknown;
}

/** True when a value looks like the legacy VisualHistory document. */
function looksLikeVisualHistory(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as { videos?: unknown }).videos);
}

/**
 * Derive persona history from the REAL production history entries.
 *
 * This is the production-first path: complete persona keys per narrative role
 * plus the semantic style fingerprint are carried straight through from the
 * persisted production observations.
 */
export function personaHistoryFromProductionHistory(
  entries: readonly ProductionHistoryEntry[] | undefined,
): ProductionPersonaHistoryEntry[] {
  const out: ProductionPersonaHistoryEntry[] = [];
  for (const entry of (entries ?? []).slice(-5)) {
    const personas: ProductionPersonaHistoryEntry['personas'] = {};
    for (const [role, key] of Object.entries(entry?.casting ?? {})) {
      if (typeof key === 'string' && key) personas[role as 'challenger'] = key;
    }
    const style = typeof entry?.styleFingerprint === 'string' && entry.styleFingerprint ? entry.styleFingerprint : undefined;
    out.push({ personas, ...(style ? { styleFingerprint: style } : {}) });
  }
  return out;
}

/** Resolved history source + the entries supplied to Scenario generation. */
export interface ResolvedGenerationHistory {
  entries: ProductionPersonaHistoryEntry[];
  source: 'production' | 'legacy-visual' | 'none';
  productionEntryCount: number;
  videoIds: string[];
  personaKeyCount: number;
}

/**
 * Resolve which history generation actually consumes.
 *
 * Policy (deterministic):
 *   1. real production history with at least one observation -> use it;
 *   2. otherwise legacy visual history -> use that (legacy/reference projects);
 *   3. otherwise no history.
 *
 * The caller may pass either `ProductionGenerationHistoryInput` or, for
 * backward compatibility with existing callers, a bare legacy VisualHistory.
 */
export function resolveGenerationHistory(input: ProductionGenerationHistoryInput | unknown): ResolvedGenerationHistory {
  const productionHistory: readonly ProductionHistoryEntry[] = Array.isArray(
    (input as ProductionGenerationHistoryInput)?.productionHistory,
  )
    ? ((input as ProductionGenerationHistoryInput).productionHistory as ProductionHistoryEntry[])
    : [];
  const legacy = looksLikeVisualHistory(input)
    ? input
    : (input as ProductionGenerationHistoryInput)?.legacyVisualHistory;

  if (productionHistory.length > 0) {
    const entries = personaHistoryFromProductionHistory(productionHistory);
    const recent = productionHistory.slice(-5);
    return {
      entries,
      source: 'production',
      productionEntryCount: productionHistory.length,
      videoIds: recent.map((e) => e.videoId),
      personaKeyCount: recent.reduce((n, e) => n + Object.keys(e.casting ?? {}).length, 0),
    };
  }

  const legacyEntries = personaHistoryFromVisualHistory(legacy);
  if (legacyEntries.length > 0) {
    return {
      entries: legacyEntries,
      source: 'legacy-visual',
      productionEntryCount: 0,
      videoIds: [],
      personaKeyCount: legacyEntries.reduce((n, e) => n + Object.keys(e.personas ?? {}).length, 0),
    };
  }

  return { entries: [], source: 'none', productionEntryCount: 0, videoIds: [], personaKeyCount: 0 };
}

/** Derive deterministic persona history from the global visual history (legacy/reference projects only). */
export function personaHistoryFromVisualHistory(history: unknown): ProductionPersonaHistoryEntry[] {
  const videos = (history as { videos?: Array<Record<string, unknown>> })?.videos ?? [];
  const out: ProductionPersonaHistoryEntry[] = [];
  for (const v of videos.slice(-5)) {
    const personas: ProductionPersonaHistoryEntry['personas'] = {};
    const casting = (v as { casting?: Record<string, unknown> }).casting ?? null;
    if (casting && typeof casting === 'object') {
      for (const [role, key] of Object.entries(casting)) {
        if (typeof key === 'string' && key) personas[role as 'challenger'] = key;
      }
    }
    const style = typeof (v as { styleFingerprint?: string }).styleFingerprint === 'string'
      ? (v as { styleFingerprint: string }).styleFingerprint
      : undefined;
    out.push({ personas, ...(style ? { styleFingerprint: style } : {}) });
  }
  return out;
}

/**
 * Deterministic style fingerprint of generated scenarios (for history).
 *
 * The fingerprint is SEMANTIC: complete persona keys by role, the opening
 * configuration, the shot/framing/camera sequences and the setting mix. It
 * contains no videoId, projectId, scenarioId, sceneId or project-slug-bearing
 * character id, so the same visual treatment yields the same fingerprint for
 * two different videos and cross-video avoidance can actually fire.
 *
 * Persisted as a per-target set (Long + Shorts) so each target's treatment can
 * be compared against the same target's recent treatment.
 */
export function scenarioStyleFingerprint(scenarios: Partial<Record<ProductionTargetId, Scenario>>): string {
  const targets: Record<string, ReturnType<typeof buildScenarioStyleFingerprint>> = {};
  for (const t of ['long', 'short_1', 'short_2', 'short_3'] as ProductionTargetId[]) {
    const sc = scenarios[t];
    if (!sc) continue;
    targets[t] = buildScenarioStyleFingerprint(sc);
  }
  return JSON.stringify({ schema: 1, targets });
}

/** Casting/style combination of a production state, for the history sidecar. */
export function personaObservationFromState(state: ProductionState): ProductionPersonaHistoryEntry {
  const personas: ProductionPersonaHistoryEntry['personas'] = {};
  const long = state.scenarios.long as Scenario | undefined;
  const first = long ?? (Object.values(state.scenarios).find(Boolean) as Scenario | undefined);
  if (first) {
    for (const c of first.characters) {
      // Persona keys themselves contain hyphens (`commercial-lead`,
      // `planning-engineer`, `project-manager`), so the COMPLETE key is
      // resolved from the canonical persona library by longest known suffix —
      // never by splitting the id on its last hyphen, which would truncate
      // `commercial-lead` to `lead` and silently break casting history.
      const key = personaKeyFromCharacterId(c.id) ?? c.narrativeFunction;
      personas[c.narrativeFunction as 'challenger'] = key;
    }
  }
  return { personas, styleFingerprint: scenarioStyleFingerprint(state.scenarios as never) };
}

/** Targets a project should generate, from ProjectInput (videoType + shortCount). */
export function targetsForInput(input: ProjectInput): ProductionTargetId[] {
  const shorts = Math.max(0, Math.min(3, input.shortCount ?? 0));
  if (input.videoType === 'short') {
    // Short-only: at least short_1, up to the requested count. Never a hidden Long.
    const n = Math.max(1, shorts);
    return Array.from({ length: n }, (_, i) => `short_${i + 1}` as ProductionTargetId);
  }
  const out: ProductionTargetId[] = ['long'];
  for (let i = 1; i <= shorts; i++) out.push(`short_${i}` as ProductionTargetId);
  return out;
}

/**
 * Generate production scenarios for a project from its ProjectInput.
 * Workstream A authority only — no fixtures. Persists the sidecar.
 */
export function generateProductionState(project: Project, history: unknown): ProductionState {
  const input = project.meta.input;
  const state = loadProductionState(input.videoId) ?? newProductionState(input.videoId);
  state.schemaVersion = PRODUCTION_STATE_VERSION;

  // The REAL production history drives casting/style avoidance. Legacy visual
  // history is only a fallback for projects with no production observations.
  const resolvedHistory = resolveGenerationHistory(history);
  const personaHistory = resolvedHistory.entries;
  const targets = targetsForInput(input);

  state.status = 'generating';
  saveProductionState(state);

  const result = generateProductionScenariosFromProjectInput(input, {
    shortCount: targets.filter((t) => t !== 'long').length,
    projectId: `proj-${input.videoId}`,
    personaHistory,
  });

  state.generationFindings = result.findings.map((f) => ({
    severity: f.severity,
    code: f.code,
    target: f.target,
    message: f.message,
  }));

  if (!result.success) {
    state.status = 'blocked';
    state.scenarios = {};
    state.inputFingerprint = fingerprintProjectInput(input);
    state.generationFingerprint = computeGenerationFingerprint(input, personaHistory);
    saveProductionState(state);
    throw new ProductionError('GENERATION_FAILED', `Production scenario generation failed: ${result.failure?.message ?? 'unknown'}`, {
      failure: result.failure,
      findings: state.generationFindings,
    });
  }

  // Only persist scenarios for requested targets (never a hidden Long for Short-only).
  const scenarios: Partial<Record<ProductionTargetId, Scenario>> = {};
  const missing: string[] = [];
  if (targets.includes('long')) {
    if (result.longScenario) scenarios.long = result.longScenario;
    else missing.push('long');
  }
  for (const t of targets.filter((x) => x !== 'long')) {
    const s = result.shortScenarios[t as 'short_1' | 'short_2' | 'short_3'];
    if (s) scenarios[t] = s;
    else missing.push(t);
  }

  if (missing.length > 0) {
    state.status = 'blocked';
    state.inputFingerprint = fingerprintProjectInput(input);
    saveProductionState(state);
    throw new ProductionError('GENERATION_FAILED', `Generation did not produce requested targets: ${missing.join(', ')}`, {
      missing,
      findings: state.generationFindings,
    });
  }

  // ---- regeneration invalidation -----------------------------------
  // A successful regeneration REPLACES the content authority. Downstream
  // state derived from the replaced Scenarios must never survive as if it
  // belonged to the new content.
  invalidateDownstreamForRegeneration(state);
  state.scenarios = scenarios;
  const bindingFilter = filterAssetBindingsToGeneratedSlots(state, generatedLogicalAssetSlotKeys(scenarios));
  state.inputFingerprint = fingerprintProjectInput(input);
  state.generationFingerprint = computeGenerationFingerprint(input, personaHistory);
  state.historyInput = {
    source: resolvedHistory.source,
    productionEntryCount: resolvedHistory.productionEntryCount,
    videoIds: resolvedHistory.videoIds,
    personaKeyCount: resolvedHistory.personaKeyCount,
    at: new Date().toISOString(),
  };
  state.status = 'generated';
  saveProductionState(state);
  void bindingFilter;
  return state;
}

/* ------------------------------------------------------------------ */
/*  Generated logical asset slots (real, product-generated refs)       */
/* ------------------------------------------------------------------ */

/**
 * Every genuine generated logical asset slot of one generated Scenario.
 *
 * A slot is a `scene.production.screenInsert.assetRef` the generator itself
 * emitted. Nothing else is a real slot: an arbitrary string is never accepted
 * as a binding target (see `PUT /production/assets/:target/:logicalRef`).
 */
export function generatedLogicalAssetRefsForScenario(scenario: unknown): string[] {
  const scenes = (scenario as { scenes?: Array<{ production?: { screenInsert?: { assetRef?: unknown } } }> })?.scenes ?? [];
  const out: string[] = [];
  for (const scene of scenes) {
    const ref = scene?.production?.screenInsert?.assetRef;
    if (typeof ref === 'string' && ref.trim().length > 0) out.push(ref);
  }
  return out;
}

/** Every genuine generated slot of the current production state, keyed `target|logicalRef`. */
export function generatedLogicalAssetSlotKeys(
  scenarios: Partial<Record<ProductionTargetId, unknown>>,
): Set<string> {
  const keys = new Set<string>();
  for (const [target, scenario] of Object.entries(scenarios) as [ProductionTargetId, unknown][]) {
    for (const ref of generatedLogicalAssetRefsForScenario(scenario)) keys.add(`${target}|${ref}`);
  }
  return keys;
}

/** Genuine generated slots for one target of the current state. */
export function generatedLogicalAssetRefsForTarget(state: ProductionState, target: ProductionTargetId): string[] {
  return generatedLogicalAssetRefsForScenario(state.scenarios[target]);
}

/* ------------------------------------------------------------------ */
/*  Edits                                                              */
/* ------------------------------------------------------------------ */

const NUM_FACT_RE = /-?\d+(?:[.,]\d+)?/g;

function numbersOf(text: string): string[] {
  return (text.match(NUM_FACT_RE) ?? []).map((n) => n.replace(',', '.'));
}

function sceneById(scenario: Scenario, sceneId: string) {
  return scenario.scenes.find((s) => s.id === sceneId) ?? null;
}

function turnById(scenario: Scenario, turnId: string) {
  for (const s of scenario.scenes) {
    const t = s.turns.find((x) => x.id === turnId);
    if (t) return { turn: t, scene: s };
  }
  return null;
}

/** Evidence-linked turn? (turn has evidenceId or its scene carries evidenceIds) */
function turnEvidenceIds(scenario: Scenario, sceneId: string, turnId: string): string[] {
  const ids: string[] = [];
  const scene = sceneById(scenario, sceneId);
  if (scene?.evidenceIds) ids.push(...scene.evidenceIds);
  for (const s of scenario.scenes) {
    for (const t of s.turns) {
      if (t.id === turnId && (t as { evidenceId?: string }).evidenceId) ids.push((t as { evidenceId: string }).evidenceId);
    }
  }
  return ids;
}

/**
 * Patch a production scene (visual/production fields only). Timing authority
 * (actual durations) is NEVER edited here — audio owns timing.
 */
export function patchProductionScene(
  state: ProductionState,
  target: ProductionTargetId,
  sceneId: string,
  patch: Record<string, unknown>,
): { state: ProductionState; scenario: Scenario } {
  const scenario = state.scenarios[target] as Scenario | undefined;
  if (!scenario) throw new ProductionError('TARGET_NOT_GENERATED', `Target '${target}' has no generated scenario.`);
  const scene = sceneById(scenario, sceneId);
  if (!scene) throw new ProductionError('SCENE_NOT_FOUND', `Scene '${sceneId}' not found in target '${target}'.`);

  /**
   * Lock/unlock contract (explicit, atomic):
   *  - a locked scene accepts a PURE unlock patch `{ locked: false }`;
   *  - a locked scene rejects any visual/content edit;
   *  - a locked scene rejects `{ locked: false, ...otherEdit }` — unlock first,
   *    then edit, so there is never a half-applied mixed patch;
   *  - an unlocked scene keeps its previous behaviour exactly.
   */
  const patchKeys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  const isUnlockOnly = patchKeys.length === 1 && patchKeys[0] === 'locked' && patch.locked === false;
  if (state.locks[sceneId] && !isUnlockOnly) {
    throw new ProductionError('SCENE_LOCKED', `Scene '${sceneId}' is locked. Unlock it first.`);
  }

  const editable: string[] = ['title', 'onScreenInfo', 'production', 'locationId'];
  for (const k of editable) {
    if (k in patch && patch[k] !== undefined) {
      (scene as unknown as Record<string, unknown>)[k] = patch[k];
    }
  }
  if (typeof patch.locked === 'boolean') {
    state.locks[sceneId] = patch.locked;
  }
  // Explicitly refuse timing edits: actual duration is audio authority.
  if ('estimatedDuration' in patch || 'actualDuration' in patch) {
    throw new ProductionError('TIMING_IS_AUDIO_AUTHORITY', 'Scene duration is derived from production audio and cannot be edited.');
  }

  const report = validateScenario(scenario);
  if (!report.valid) {
    throw new ProductionError('SCENARIO_INVALID', `Scene edit made scenario invalid: ${report.findings.filter((f) => f.severity === 'error').map((f) => f.message).join('; ')}`);
  }

  applyEditToState(state, {
    target,
    kind: 'scene',
    subjectId: sceneId,
    at: new Date().toISOString(),
    summary: `scene patched: ${Object.keys(patch).join(', ')}`,
  });
  saveProductionState(state);
  return { state, scenario };
}

/* ------------------------------------------------------------------ */
/*  Single-scene production regeneration (deterministic equivalent)     */
/* ------------------------------------------------------------------ */

/**
 * Canonical visual-treatment vocabularies. The single-scene "re-roll" cycles
 * through them in this fixed order — the same order the Scenario generator
 * uses — so the result is deterministic for a given scene and edit count.
 */
const REROLL_SHOT_CYCLE = ['wide', 'medium', 'two_shot', 'close_up', 'over_the_shoulder', 'point_of_view', 'detail_macro'] as const;
const REROLL_FRAMING_CYCLE = ['center', 'rule_of_thirds_left', 'symmetric', 'rule_of_thirds_right'] as const;
const REROLL_CAMERA_CYCLE = ['static', 'slow_push', 'pan_right', 'subtle_drift', 'slow_pull', 'pan_left'] as const;

/**
 * Deterministic single-scene regeneration for production projects.
 *
 * The legacy Storyboard offered "regenerate this scene" (a variant re-roll).
 * The production equivalent must not touch dialogue, evidence, captions or
 * audio timing — those are Scenario/audio authority — so this re-roll rotates
 * ONLY the scene's visual treatment (shot type, framing, camera movement) to
 * the next combination in the canonical cycles that still validates.
 *
 * Deterministic: the same scene + same state always produces the same result.
 * Refuses on a locked scene (`SCENE_LOCKED`) and when no rotation validates
 * (`REROLL_UNAVAILABLE`). Screen-insert scenes keep their `screen_insert` shot
 * so the generated media slot contract is never broken.
 */
export function rerollProductionScene(
  state: ProductionState,
  target: ProductionTargetId,
  sceneId: string,
): { state: ProductionState; scenario: Scenario; direction: { shotType: string; framing: string; cameraMovement: string; changed: string[] } } {
  const scenario = state.scenarios[target] as Scenario | undefined;
  if (!scenario) throw new ProductionError('TARGET_NOT_GENERATED', `Target '${target}' has no generated scenario.`);
  const scene = sceneById(scenario, sceneId);
  if (!scene) throw new ProductionError('SCENE_NOT_FOUND', `Scene '${sceneId}' not found in target '${target}'.`);
  if (state.locks[sceneId]) {
    throw new ProductionError('SCENE_LOCKED', `Scene '${sceneId}' is locked. Unlock it first.`);
  }

  const direction = scene.production as unknown as Record<string, unknown>;
  const currentShot = String(direction.shotType ?? '');
  const currentFraming = String(direction.framing ?? '');
  const currentCamera = String(direction.cameraMovement ?? '');
  const shotCandidates = currentShot === 'screen_insert' ? [currentShot] : [...REROLL_SHOT_CYCLE].filter((v) => v !== currentShot);
  const framingCandidates = [...REROLL_FRAMING_CYCLE].filter((v) => v !== currentFraming);
  const cameraCandidates = [...REROLL_CAMERA_CYCLE].filter((v) => v !== currentCamera);

  // Bounded deterministic search: the smallest valid divergence wins.
  let applied: { shotType: string; framing: string; cameraMovement: string } | null = null;
  outer: for (const shot of shotCandidates) {
    for (const framing of framingCandidates) {
      for (const camera of cameraCandidates) {
        const candidate = { ...direction, shotType: shot, framing, cameraMovement: camera };
        (scene as unknown as Record<string, unknown>).production = candidate;
        const report = validateScenario(scenario);
        if (report.valid) {
          applied = { shotType: shot, framing, cameraMovement: camera };
          break outer;
        }
      }
    }
  }
  if (!applied) {
    throw new ProductionError('REROLL_UNAVAILABLE', 'No alternative visual treatment validates for this scene.');
  }

  const changed = [
    applied.shotType !== currentShot ? 'shotType' : null,
    applied.framing !== currentFraming ? 'framing' : null,
    applied.cameraMovement !== currentCamera ? 'cameraMovement' : null,
  ].filter((v): v is string => v !== null);

  applyEditToState(state, {
    target,
    kind: 'scene',
    subjectId: sceneId,
    at: new Date().toISOString(),
    summary: `scene re-rolled: ${changed.join(', ') || 'no change'}`,
  });
  saveProductionState(state);
  return { state, scenario, direction: { ...applied, changed } };
}

/**
 * Patch a production dialogue turn's spokenText (and delivery). Speaker/turn
 * identity is preserved. Evidence safety: when the turn is linked to evidence,
 * the edit is rejected unless every numeric value in the new text is
 * source-supported by that evidence's numericFacts.
 */
export function patchProductionTurn(
  state: ProductionState,
  target: ProductionTargetId,
  turnId: string,
  patch: Record<string, unknown>,
): { state: ProductionState; scenario: Scenario } {
  const scenario = state.scenarios[target] as Scenario | undefined;
  if (!scenario) throw new ProductionError('TARGET_NOT_GENERATED', `Target '${target}' has no generated scenario.`);
  const found = turnById(scenario, turnId);
  if (!found) throw new ProductionError('TURN_NOT_FOUND', `Turn '${turnId}' not found in target '${target}'.`);
  const { turn, scene } = found;

  const newSpeaker = patch.speakerId !== undefined ? String(patch.speakerId) : turn.speakerId;
  if (newSpeaker !== turn.speakerId) {
    throw new ProductionError('SPEAKER_IDENTITY_LOCKED', 'Speaker identity cannot be changed by dialogue editing.');
  }

  if (patch.spokenText !== undefined) {
    const text = String(patch.spokenText).trim();
    if (!text) throw new ProductionError('EMPTY_SPOKEN_TEXT', 'spokenText cannot be empty.');

    const evidenceIds = turnEvidenceIds(scenario, scene.id, turnId);
    if (evidenceIds.length > 0) {
      const supported = new Set<string>();
      for (const ev of scenario.evidence) {
        if (!evidenceIds.includes(ev.id)) continue;
        for (const f of ev.numericFacts) {
          supported.add(String(f.value));
          if (ev.claim) for (const n of numbersOf(ev.claim)) supported.add(n);
        }
      }
      const presented = numbersOf(text);
      const breaking = presented.filter((n) => !supported.has(n));
      if (breaking.length > 0) {
        throw new ProductionError(
          'EVIDENCE_CONFLICT',
          `Edit rejected: the turn is linked to evidence and text introduces numbers not supported by the source record (${breaking.join(', ')}). Update the evidence first or keep the source-supported values.`,
          { evidenceIds, breaking },
        );
      }
    }
    turn.spokenText = text;
  }
  if (patch.delivery !== undefined) turn.delivery = patch.delivery as never;

  const report = validateScenario(scenario);
  if (!report.valid) {
    throw new ProductionError('SCENARIO_INVALID', `Dialogue edit made scenario invalid: ${report.findings.filter((f) => f.severity === 'error').map((f) => f.message).join('; ')}`);
  }

  applyEditToState(state, {
    target,
    kind: 'turn',
    subjectId: turnId,
    at: new Date().toISOString(),
    summary: patch.spokenText !== undefined ? 'spokenText edited' : `patched: ${Object.keys(patch).join(', ')}`,
  });
  saveProductionState(state);
  return { state, scenario };
}

/**
 * Set / clear an explicit asset binding for a logical ref on a target.
 *
 * Hardened production contract for NEW bindings: the logicalRef MUST be a real
 * generated asset slot of THAT target (`scene.production.screenInsert.assetRef`
 * of the target's own generated Scenario). An arbitrary/invented string — or a
 * ref that belongs to another target — is refused with
 * `ASSET_REF_NOT_IN_SCENARIO`, so the mediaMap can never be driven by a fake
 * logical ref.
 *
 * Clearing (`assetId === null`) stays allowed for any ref, so a legacy/stale
 * persisted binding can always be removed.
 */
export function setProductionAssetBinding(
  state: ProductionState,
  target: ProductionTargetId,
  logicalRef: string,
  assetId: string | null,
): ProductionState {
  if (!state.scenarios[target]) throw new ProductionError('TARGET_NOT_GENERATED', `Target '${target}' has no generated scenario.`);
  if (!logicalRef.trim()) throw new ProductionError('INVALID_LOGICAL_REF', 'logicalRef is required.');
  if (assetId !== null) {
    const slots = new Set(generatedLogicalAssetRefsForTarget(state, target));
    if (!slots.has(logicalRef)) {
      throw new ProductionError(
        'ASSET_REF_NOT_IN_SCENARIO',
        `logicalRef '${logicalRef}' is not a generated asset slot of target '${target}'. ` +
          'Bind an asset to a logical media ref the generator actually emitted.',
        { target, logicalRef, availableSlots: [...slots] },
      );
    }
  }
  state.assetBindings = state.assetBindings.filter((b) => !(b.target === target && b.logicalRef === logicalRef));
  if (assetId) {
    state.assetBindings.push({ target, logicalRef, assetId, setAt: new Date().toISOString() });
  }
  applyEditToState(state, {
    target,
    kind: 'asset-binding',
    subjectId: logicalRef,
    at: new Date().toISOString(),
    summary: assetId ? `bound ${logicalRef} -> ${assetId}` : `cleared binding ${logicalRef}`,
  });
  saveProductionState(state);
  return state;
}

/* ------------------------------------------------------------------ */
/*  Plan building + asset resolution                                   */
/* ------------------------------------------------------------------ */

export interface ProductionPlanOptions {
  synthesisBasePath: string;
  canonicalBasePath: string;
}

export interface TargetPlan {
  target: ProductionTargetId;
  scenario: Scenario;
  plan: RemotionCompositionPlan;
  mediaMap: Record<string, string>;
  resolution: ReturnType<typeof resolveProductionAssets>;
}

/**
 * Build the Phase 5 plan for one target with production audio authority
 * (`synthesisMode: 'production'` → Kokoro). Returns the resolved mediaMap too.
 */
export async function buildTargetPlan(
  state: ProductionState,
  target: ProductionTargetId,
  options: ProductionPlanOptions,
  assets: readonly Asset[],
  assetUrlById: Record<string, string>,
): Promise<TargetPlan> {
  const scenario = state.scenarios[target] as Scenario | undefined;
  if (!scenario) throw new ProductionError('TARGET_NOT_GENERATED', `Target '${target}' has no generated scenario.`);

  const built = await buildRemotionPlanFromScenario(scenario, {
    synthesisBasePath: options.synthesisBasePath,
    canonicalBasePath: options.canonicalBasePath,
    synthesisMode: 'production',
  });

  const bindings: Record<string, string> = {};
  for (const b of state.assetBindings.filter((b) => b.target === target)) bindings[b.logicalRef] = b.assetId;

  const resolution = resolveProductionAssets({
    plan: built.plan,
    assets,
    explicitBindings: bindings,
    assetUrlById,
  });

  return {
    target,
    scenario,
    plan: built.plan,
    mediaMap: resolution.mediaMap,
    resolution,
  };
}

/** Build plans for all generated targets of the state. */
export async function buildAllTargetPlans(
  state: ProductionState,
  options: ProductionPlanOptions,
  assets: readonly Asset[],
  assetUrlById: Record<string, string>,
): Promise<TargetPlan[]> {
  const targets = (['long', 'short_1', 'short_2', 'short_3'] as ProductionTargetId[]).filter((t) => state.scenarios[t]);
  const out: TargetPlan[] = [];
  for (const t of targets) out.push(await buildTargetPlan(state, t, options, assets, assetUrlById));
  return out;
}

/** Reconciled production captions for one target (from the built plan). */
export function productionCaptionsForTarget(plan: RemotionCompositionPlan): Array<{ cueId: string; text: string; start: number; end: number; sceneId: string }> {
  const out: Array<{ cueId: string; text: string; start: number; end: number; sceneId: string }> = [];
  for (const scene of plan.scenes) {
    for (const cue of scene.captionCues) {
      out.push({
        cueId: (cue as unknown as { cueId?: string; id?: string }).cueId ?? (cue as unknown as { id: string }).id,
        text: cue.text,
        start: cue.startTimeSeconds,
        end: cue.endTimeSeconds,
        sceneId: scene.sceneId,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Preview / final export                                             */
/* ------------------------------------------------------------------ */

export interface RunProductionBuildInput {
  project: Project;
  state: ProductionState;
  kind: 'preview' | 'final';
  plans: TargetPlan[];
  brand?: unknown;
  /** Repository root for the Phase 6D package-root safety check. Defaults to the repo. */
  repoRoot?: string | null;
  onLog?: (message: string) => void;
  onProgress?: (progress: number, note?: string) => void;
}

export interface RunProductionBuildResult {
  status: 'ok' | 'partial' | 'error';
  outputs: Partial<Record<ProductionTargetId, string>>;
  packageRoot?: string;
  packageStatus?: string;
  /** output-root-relative production product-kit root (production deliverables) */
  productKit?: string;
  /** latest production readiness QC (production authority) */
  readiness?: ProductionState['lastReadiness'];
  targets: ProductionTargetId[];
  audioEngine: string;
  renderResults: unknown;
  targetSet: unknown;
}

/** Resolve output paths (relative to the output root, per target). */
export function productionOutputPaths(videoId: string, kind: 'preview' | 'final', targets: ProductionTargetId[]): Partial<Record<ProductionTargetId, string>> {
  const out: Partial<Record<ProductionTargetId, string>> = {};
  const dir = kind === 'preview' ? 'previews' : '';
  for (const t of targets) {
    const name = kind === 'preview' ? `${t}-preview.mp4` : `${t}.mp4`;
    out[t] = path.join(videoId, dir, name).replace(/\\/g, '/');
  }
  return out;
}

/**
 * Run a production build (preview or final) through the NEW authority:
 * Phase 6C render + (final only) Phase 6D package. Never touches the legacy
 * exportProject video path. Records the build + artifacts into the sidecar.
 */
export async function runProductionBuild(input: RunProductionBuildInput): Promise<RunProductionBuildResult> {
  const { project, state, kind, plans } = input;
  if (plans.length === 0) throw new ProductionError('NO_TARGETS', 'No generated targets to build.');

  const log = input.onLog ?? (() => {});
  const targets = plans.map((p) => p.target);
  const outputByTarget = productionOutputPaths(project.meta.input.videoId, kind, targets);
  const mediaMapByTarget: Partial<Record<DeliveryTargetId, Record<string, string>>> = {};
  const longPlan = plans.find((p) => p.target === 'long')?.plan ?? null;
  const shortPlans: Partial<Record<'short_1' | 'short_2' | 'short_3', RemotionCompositionPlan>> = {};
  for (const p of plans.filter((x) => x.target !== 'long')) {
    shortPlans[p.target as 'short_1' | 'short_2' | 'short_3'] = p.plan;
  }
  for (const p of plans) mediaMapByTarget[p.target as DeliveryTargetId] = p.mediaMap;

  // Final-export gate: unresolved REQUIRED asset refs block the export.
  if (kind === 'final') {
    for (const p of plans) {
      for (const b of p.resolution.bindings) {
        if (b.required && !b.resolved) {
          throw new ProductionError('REQUIRED_ASSET_UNRESOLVED', `Final export blocked: required asset '${b.assetRef}' is unresolved (no active eligible asset bound or tagged).`, {
            target: p.target,
            assetRef: b.assetRef,
          });
        }
      }
    }
  }

  const packageRoot =
    kind === 'final'
      ? path.join(OUTPUT_DIR, project.meta.input.videoId, 'production-package')
      : undefined;

  // The renderer and packager receive ABSOLUTE output paths; the sidecar
  // persists only output-root-relative paths (no machine-specific absolutes).
  const absoluteOutputs: Partial<Record<DeliveryTargetId, string>> = {};
  for (const [t, rel] of Object.entries(outputByTarget) as [DeliveryTargetId, string][]) {
    absoluteOutputs[t] = path.join(OUTPUT_DIR, rel);
  }

  for (const t of targets) {
    log(`${kind} build: rendering ${t} through the plan-based production path`);
  }

  const result = await runPlanBasedProductionExport({
    ...(longPlan ? { longPlan } : {}),
    shortPlans,
    mediaMapByTarget,
    outputByTarget: absoluteOutputs,
    ...(packageRoot ? { packageRoot } : {}),
    quality: kind === 'preview' ? 'preview' : 'final',
    brand: input.brand,
    repoRoot: input.repoRoot ?? null,
    onProgress: input.onProgress,
  });

  /*
   * ARTIFACT PATH CONTRACT: the renderer receives absolute paths, but the
   * sidecar persists ONLY output-root-relative POSIX paths. An output outside
   * the output root is rejected rather than silently stored as an
   * unportable host path.
   */
  const outputs: Partial<Record<ProductionTargetId, string>> = {};
  for (const r of result.renderResult.results) {
    if (r.success && r.outputFile) {
      outputs[r.targetId as ProductionTargetId] = outputRelativePath(r.outputFile);
    }
  }
  const status = result.renderResult.status;
  const packageRelPath = result.packageResult ? outputRelativePath(result.packageResult.packageRoot) : undefined;
  const packageStatus = result.packageResult?.package.summary.packageStatus;

  recordBuild(state, {
    kind,
    targets,
    at: new Date().toISOString(),
    status,
    outputs,
    audioEngine: PRODUCTION_AUDIO_ENGINE,
    ...(result.packageResult && packageRelPath ? { packageRoot: packageRelPath, packageStatus } : {}),
    ...(status !== 'ok' ? { error: result.renderResult.results.filter((r) => !r.success).map((r) => `${r.targetId}: ${r.error?.message ?? ''}`).join('; ') } : {}),
  });

  if (result.packageResult && packageRelPath) {
    const pkg = result.packageResult.package;
    state.lastQcSummary = {
      at: new Date().toISOString(),
      packageStatus: pkg.summary.packageStatus,
      mode: pkg.mode,
      longCount: pkg.summary.longCount,
      shortCount: pkg.summary.shortCount,
      findings: pkg.findings.slice(0, 50).map((f) => ({ severity: f.severity, code: f.code, message: f.message })),
    };
    const pkgAbs = path.resolve(OUTPUT_DIR, packageRelPath);
    const pkgBytes = directorySize(pkgAbs);
    state.artifacts = state.artifacts.filter((a) => a.kind !== 'package');
    state.artifacts.push({ target: 'package', kind: 'package', relPath: packageRelPath, sizeBytes: pkgBytes, createdAt: new Date().toISOString() });
  }

  for (const [t, rel] of Object.entries(outputs) as [ProductionTargetId, string][]) {
    const abs = path.resolve(OUTPUT_DIR, rel);
    const size = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    state.artifacts = state.artifacts.filter((a) => !(a.target === t && a.kind === 'video'));
    state.artifacts.push({ target: t, kind: 'video', relPath: rel, sizeBytes: size, createdAt: new Date().toISOString() });
  }

  /*
   * PRODUCTION-NATIVE NON-VIDEO DELIVERABLES (replaces the legacy
   * writeCaptions/writeMetadata(project, []) pair, which was derived from the
   * legacy Storyboard and passed FAKE empty provenance).
   */
  const observation = personaObservationFromState(state);
  const historyObservation = {
    source: state.historyInput?.source ?? ('none' as const),
    productionEntryCount: state.historyInput?.productionEntryCount ?? 0,
    videoIds: state.historyInput?.videoIds ?? [],
    personaKeyCount: state.historyInput?.personaKeyCount ?? 0,
    personas: observation.personas as Record<string, string>,
    styleFingerprint: observation.styleFingerprint ?? null,
  };
  let deliverables: Awaited<ReturnType<typeof writeProductionDeliverables>> | null = null;
  try {
    deliverables = await writeProductionDeliverables({
      project,
      state,
      kind,
      plans: plans.map((p) => ({
        target: p.target,
        scenario: p.scenario,
        plan: p.plan as unknown as { scenes: Array<{ sceneId: string; captionCues?: unknown[] }>; width?: number; height?: number },
        mediaMap: p.mediaMap,
        resolution: p.resolution as unknown as WriteProductionDeliverablesInput['plans'][number]['resolution'],
      })),
      outputs,
      packageRelPath: packageRelPath ?? null,
      packageStatus: packageStatus ?? null,
      packageFindings: result.packageResult?.package.findings.map((f) => ({ severity: f.severity, code: f.code, message: f.message })) ?? [],
      historyObservation,
      onLog: log,
    });
  } catch (e) {
    log(`production deliverable writer failed: ${(e as Error).message}`);
  }

  if (deliverables) {
    state.productKitPath = deliverables.kitRelPath;
    state.lastReadiness = {
      at: deliverables.readiness.at,
      kind: deliverables.readiness.kind,
      status: deliverables.readiness.status,
      readyForProductionDelivery: deliverables.readiness.readyForProductionDelivery,
      findings: deliverables.readiness.findings.map((f) => ({ severity: f.severity, code: f.code, dimension: f.dimension, message: f.message })),
      dimensions: deliverables.readiness.dimensions.map((d) => ({ dimension: d.dimension, status: d.status, detail: d.detail })),
    };
    for (const f of deliverables.files) {
      const kindForFile = f.relPath.startsWith('thumbnails/')
        ? 'thumbnail'
        : f.relPath.startsWith('contact_sheets/')
          ? 'thumbnail'
          : f.relPath.startsWith('asset_provenance')
            ? 'provenance'
            : f.relPath.startsWith('scenarios/')
              ? 'metadata'
              : null;
      if (!kindForFile) continue;
      state.artifacts = state.artifacts.filter((a) => !(a.kind === kindForFile && a.relPath === `${deliverables!.kitRelPath}/${f.relPath}`));
      state.artifacts.push({
        target: 'package',
        kind: kindForFile,
        relPath: `${deliverables.kitRelPath}/${f.relPath}`,
        sizeBytes: f.sizeBytes,
        createdAt: new Date().toISOString(),
      });
    }

    /*
     * Asset.usedIn is updated ONLY after a SUCCESSFUL final production, from
     * the ACTUAL resolved usage (videoId + sceneId + role), deduplicated.
     */
    if (kind === 'final' && status === 'ok' && !deliverables.readiness.findings.some((f) => f.severity === 'error')) {
      try {
        const { loadAssetIndex, saveAssetIndex } = await import('../routes/assets.js');
        const merged = mergeUsedInUpdates(loadAssetIndex(), deliverables.usedInUpdates);
        if (merged.changed > 0) saveAssetIndex(merged.assets);
      } catch (e) {
        log(`Asset.usedIn update failed (non-fatal): ${(e as Error).message}`);
      }
    }
  }

  saveProductionState(state);

  return {
    status,
    outputs,
    ...(packageRelPath ? { packageRoot: packageRelPath, packageStatus } : {}),
    ...(deliverables ? { productKit: deliverables.kitRelPath, readiness: state.lastReadiness } : {}),
    targets,
    audioEngine: PRODUCTION_AUDIO_ENGINE,
    renderResults: result.renderResult,
    targetSet: result.targetSet,
  };
}

/** Recursive byte size of a directory (0 when it does not exist). */
function directorySize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) total += fs.statSync(abs).size;
    }
  };
  walk(dir);
  return total;
}

/* ------------------------------------------------------------------ */
/*  Status / reopen                                                    */
/* ------------------------------------------------------------------ */

/** Compute the UI status of a project's production state. */
export function productionStatusFor(state: ProductionState, project: Project): ProductionState['status'] {
  if (state.status === 'blocked') return 'blocked';
  if (isStaleAgainstInput(state, project.meta.input)) return 'needs_regeneration';
  if (state.builds.some((b) => b.kind === 'final' && b.status === 'ok')) return 'ready_for_export';
  if (state.builds.some((b) => b.kind === 'preview' && b.status === 'ok')) return 'ready_for_preview';
  if (state.edits.length > 0) return 'edited';
  if (Object.keys(state.scenarios).length > 0) return 'generated';
  return state.status ?? 'not_generated';
}

/** Thumbnail still paths for a rendered target (preserved capability). */
export function productionThumbnailDir(videoId: string): string {
  return path.join(OUTPUT_DIR, videoId, 'thumbnails');
}

export type { ProductionState, ProductionArtifact, ProductionTargetEdit };
