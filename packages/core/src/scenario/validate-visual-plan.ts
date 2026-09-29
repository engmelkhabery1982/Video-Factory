/**
 * BuildTrack Video Factory - Phase 3B Scenario Visual-Plan Validator
 *
 * Checks a ScenarioVisualPlan against the Scenario it claims to come from:
 * exact scene and dialogue-turn coverage, faithful copies of dialogue,
 * evidence, numeric facts and production directions, traceability of every
 * visible cue, monotonic non-overlapping timing, unique stable IDs and the
 * absence of absolute filesystem paths. Pure and deterministic; never throws
 * on malformed input.
 */

import type { Scenario, ScenarioScene } from './types.js';
import {
  SCENARIO_VISUAL_PLAN_VERSION,
  type ScenarioVisualCue,
  type ScenarioVisualPlan,
  type ScenarioVisualPlanFinding,
  type ScenarioVisualPlanValidationReport,
  type ScenarioVisualSource,
} from './visual-plan-types.js';

const EPS = 1e-6;
const ABSOLUTE_PATH = /(^|[\s"'(])(\/(?:home|root|etc|var|tmp|usr|Users|mnt|opt)\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\)|file:\/\//;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The exact source text a cue claims to copy, or null when the pointer is dangling. */
export function resolveVisualCueSourceText(scenario: Scenario, source: ScenarioVisualSource): string | null {
  const scene = scenario.scenes.find((s) => s.id === source.sceneId);
  if (!scene) return null;
  const turn = source.turnId ? scene.turns.find((t) => t.id === source.turnId) : undefined;
  if (source.turnId && !turn) return null;
  switch (source.field) {
    case 'turn.spokenText':
      return turn ? turn.spokenText : null;
    case 'turn.onScreenText':
      return turn?.onScreenText ?? null;
    case 'evidence.claim': {
      const e = scenario.evidence.find((x) => x.id === source.evidenceId);
      if (!e) return null;
      // traceable only if the scene or the turn actually cites it
      const cited = turn ? turn.evidenceId === e.id : (scene.evidenceIds ?? []).includes(e.id);
      return cited ? e.claim : null;
    }
    case 'scene.title':
      return scene.title ?? null;
    case 'onScreenInfo.title':
      return scene.onScreenInfo?.title ?? null;
    case 'onScreenInfo.subtitle':
      return scene.onScreenInfo?.subtitle ?? null;
    case 'onScreenInfo.callout':
      return scene.onScreenInfo?.callout ?? null;
    case 'onScreenInfo.bulletPoints':
      return typeof source.itemIndex === 'number' ? scene.onScreenInfo?.bulletPoints?.[source.itemIndex] ?? null : null;
    case 'production.screenInsert.title':
      return scene.production.screenInsert?.title ?? null;
    case 'production.screenInsert.description':
      return scene.production.screenInsert?.description ?? null;
    case 'production.overlayIntent':
      return scene.production.overlayIntent ?? null;
    case 'production.bRollIntent':
      return scene.production.bRollIntent ?? null;
    case 'production.environmentalAction':
      return scene.production.environmentalAction ?? null;
    default:
      return null;
  }
}

function collectStrings(x: unknown, out: string[]): void {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const v of x) collectStrings(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) collectStrings(v, out);
}

/**
 * Validate a compiled plan against its source Scenario.
 */
export function validateScenarioVisualPlan(plan: ScenarioVisualPlan, sourceScenario: Scenario): ScenarioVisualPlanValidationReport {
  const findings: ScenarioVisualPlanFinding[] = [];
  const err = (ruleId: string, message: string, location: ScenarioVisualPlanFinding['location'] = {}) => findings.push({ severity: 'error', ruleId, message, location });
  const warn = (ruleId: string, message: string, location: ScenarioVisualPlanFinding['location'] = {}) => findings.push({ severity: 'warning', ruleId, message, location });
  const done = (): ScenarioVisualPlanValidationReport => {
    const errorCount = findings.filter((f) => f.severity === 'error').length;
    return { valid: errorCount === 0, errorCount, warningCount: findings.length - errorCount, findings };
  };

  if (!plan || typeof plan !== 'object' || !Array.isArray((plan as ScenarioVisualPlan).scenes)) {
    err('plan.malformed', 'Visual plan is not an object with a scenes array.');
    return done();
  }
  if (!sourceScenario || !Array.isArray(sourceScenario.scenes)) {
    err('plan.source_malformed', 'Source scenario is not an object with a scenes array.');
    return done();
  }
  const meta = sourceScenario.metadata;
  if (plan.planVersion !== SCENARIO_VISUAL_PLAN_VERSION) err('plan.version', `Unsupported plan version "${plan.planVersion}".`);
  if (plan.scenarioId !== meta?.id) err('plan.scenario_id', `Plan scenarioId "${plan.scenarioId}" does not match source "${meta?.id}".`);
  if (plan.format?.targetFormat !== meta?.targetFormat) err('plan.format', `Plan format "${plan.format?.targetFormat}" does not match source "${meta?.targetFormat}".`);

  /* ---- scene coverage: exactly one visual scene per source scene, same order ---- */
  const srcScenes = sourceScenario.scenes;
  const srcById = new Map<string, ScenarioScene>(srcScenes.map((s) => [s.id, s]));
  const seenScene = new Map<string, number>();
  for (const vs of plan.scenes) {
    if (!vs || typeof vs !== 'object') {
      err('scene.malformed', 'A plan scene is not an object.');
      continue;
    }
    seenScene.set(vs.sourceSceneId, (seenScene.get(vs.sourceSceneId) ?? 0) + 1);
    if (!srcById.has(vs.sourceSceneId)) err('scene.unknown', `Plan scene "${vs.sourceSceneId}" does not exist in the source.`, { sceneId: vs.sourceSceneId });
  }
  for (const [id, n] of seenScene) if (n > 1) err('scene.duplicate', `Source scene "${id}" appears ${n} times in the plan.`, { sceneId: id });
  for (const s of srcScenes) if (!seenScene.has(s.id)) err('scene.missing', `Source scene "${s.id}" is missing from the plan.`, { sceneId: s.id });
  if (plan.scenes.length === srcScenes.length) {
    plan.scenes.forEach((vs, i) => {
      if (vs && vs.sourceSceneId !== srcScenes[i].id) err('scene.order', `Plan scene ${i} is "${vs.sourceSceneId}" but the source has "${srcScenes[i].id}".`, { sceneId: vs.sourceSceneId });
    });
  }

  /* ---- per-scene fidelity ---- */
  const turnSeen = new Map<string, number>();
  const ids = new Map<string, number>();
  const addId = (id: unknown, where: ScenarioVisualPlanFinding['location']) => {
    if (typeof id !== 'string' || !id) return err('id.missing', 'An element has no ID.', where);
    ids.set(id, (ids.get(id) ?? 0) + 1);
  };
  const evidenceById = new Map(sourceScenario.evidence.map((e) => [e.id, e] as const));

  const checkCue = (c: ScenarioVisualCue, sceneId: string, lo: number, hi: number, beatId?: string) => {
    const where = { sceneId, cueId: c?.id, ...(beatId ? { beatId } : {}) };
    addId(c?.id, where);
    if (!c?.source) return err('cue.untraceable', `Cue "${c?.id}" has no source pointer.`, where);
    const expected = resolveVisualCueSourceText(sourceScenario, c.source);
    if (expected === null) err('cue.untraceable', `Cue "${c.id}" points to ${c.source.field} that does not exist in scene "${c.source.sceneId}".`, where);
    else if (c.text !== expected) err('cue.text_changed', `Cue "${c.id}" text differs from its source ${c.source.field}.`, where);
    if (c.source.sceneId !== sceneId) err('cue.wrong_scene', `Cue "${c.id}" is placed in "${sceneId}" but comes from "${c.source.sceneId}".`, where);
    if (c.kind === 'evidence') {
      const e = c.source.evidenceId ? evidenceById.get(c.source.evidenceId) : undefined;
      if (!e) err('evidence.unknown', `Cue "${c.id}" cites unknown evidence "${c.source.evidenceId}".`, where);
      else {
        if (!same(c.numericFacts, e.numericFacts ?? [])) err('evidence.numeric_changed', `Cue "${c.id}" numeric facts differ from evidence "${e.id}".`, { ...where, evidenceId: e.id });
        if (c.evidenceSourceRef !== e.sourceRef) err('evidence.source_ref_changed', `Cue "${c.id}" source reference differs from evidence "${e.id}".`, { ...where, evidenceId: e.id });
      }
    } else if (c.numericFacts !== undefined) {
      err('cue.numbers_invented', `Non-evidence cue "${c.id}" carries numeric facts.`, where);
    }
    if (!isNum(c.startSeconds) || !isNum(c.endSeconds) || c.endSeconds < c.startSeconds - EPS || c.startSeconds < lo - EPS || c.endSeconds > hi + EPS) {
      err('timing.cue_outside', `Cue "${c.id}" timing ${c.startSeconds}-${c.endSeconds}s is outside ${lo}-${hi}s.`, where);
    }
  };

  let prevEnd = 0;
  plan.scenes.forEach((vs, i) => {
    if (!vs || typeof vs !== 'object') return;
    const s = srcById.get(vs.sourceSceneId);
    const where = { sceneId: vs.sourceSceneId };
    addId(vs.id, where);
    if (vs.id !== `${plan.scenarioId}/${vs.sourceSceneId}`) err('id.unstable', `Scene ID "${vs.id}" is not derived from the scenario and scene IDs.`, where);

    // timing: monotonic, non-overlapping, contiguous from zero
    if (!isNum(vs.startSeconds) || !isNum(vs.endSeconds) || vs.endSeconds <= vs.startSeconds) err('timing.scene_invalid', `Scene "${vs.sourceSceneId}" has invalid timing ${vs.startSeconds}-${vs.endSeconds}s.`, where);
    else {
      if (vs.startSeconds < prevEnd - EPS) err('timing.overlap', `Scene "${vs.sourceSceneId}" starts at ${vs.startSeconds}s before the previous scene ends at ${prevEnd}s.`, where);
      else if (vs.startSeconds > prevEnd + EPS) warn('timing.gap', `Gap of ${(vs.startSeconds - prevEnd).toFixed(3)}s before scene "${vs.sourceSceneId}".`, where);
      if (Math.abs(vs.endSeconds - vs.startSeconds - vs.durationSeconds) > 1e-3) err('timing.duration_mismatch', `Scene "${vs.sourceSceneId}" duration does not equal end - start.`, where);
      prevEnd = Math.max(prevEnd, vs.endSeconds);
    }
    if (i === plan.scenes.length - 1 && isNum(plan.totalDurationSeconds) && Math.abs(plan.totalDurationSeconds - prevEnd) > 1e-3) {
      err('timing.total_mismatch', `Plan total ${plan.totalDurationSeconds}s does not equal the last scene end ${prevEnd}s.`);
    }
    if (!s) return;

    if (vs.index !== s.index) err('scene.index_changed', `Scene "${s.id}" index ${vs.index} differs from source ${s.index}.`, where);
    if (vs.narrativePurpose !== s.narrativePurpose) err('scene.purpose_changed', `Scene "${s.id}" narrative purpose changed.`, where);
    if (vs.locationId !== s.locationId) err('scene.location_changed', `Scene "${s.id}" location changed.`, where);
    if (!same(vs.participantIds, s.participantIds)) err('scene.participants_changed', `Scene "${s.id}" participants changed.`, where);
    if (!same(vs.turnIds, s.turns.map((t) => t.id))) err('scene.turns_changed', `Scene "${s.id}" turn list differs from the source.`, where);
    if (!same(vs.production, s.production)) err('scene.production_changed', `Scene "${s.id}" production direction differs from the source.`, where);
    if (!same(vs.onScreenInfo, s.onScreenInfo ?? null)) err('scene.on_screen_info_changed', `Scene "${s.id}" on-screen information differs from the source.`, where);
    if (vs.visualOnly !== (s.turns.length === 0)) err('scene.visual_only_mismatch', `Scene "${s.id}" visualOnly flag is wrong.`, where);
    for (const e of vs.evidence ?? []) {
      const src = evidenceById.get(e.id);
      if (!src) err('evidence.unknown', `Scene "${s.id}" lists unknown evidence "${e.id}".`, { ...where, evidenceId: e.id });
      else if (!same(e, { id: src.id, claim: src.claim, evidenceType: src.evidenceType, sourceRef: src.sourceRef, numericFacts: src.numericFacts ?? [], confidence: src.confidence })) {
        err('evidence.changed', `Scene "${s.id}" evidence "${e.id}" differs from the source record.`, { ...where, evidenceId: e.id });
      }
      const cited = (s.evidenceIds ?? []).includes(e.id) || s.turns.some((t) => t.evidenceId === e.id);
      if (src && !cited) err('evidence.untraceable', `Scene "${s.id}" shows evidence "${e.id}" that neither the scene nor its turns cite.`, { ...where, evidenceId: e.id });
    }

    // beats: ordered, contiguous inside the scene, every turn once
    const beats = Array.isArray(vs.beats) ? vs.beats : [];
    if (!beats.length) err('beat.none', `Scene "${s.id}" has no beats.`, where);
    let t = vs.startSeconds;
    beats.forEach((b, bi) => {
      const bw = { ...where, beatId: b?.id };
      addId(b?.id, bw);
      if (!b || !isNum(b.startSeconds) || !isNum(b.endSeconds) || b.endSeconds < b.startSeconds - EPS) return err('timing.beat_invalid', `Beat ${bi} of "${s.id}" has invalid timing.`, bw);
      if (b.startSeconds < t - EPS) err('timing.beat_overlap', `Beat "${b.id}" overlaps the previous beat.`, bw);
      if (b.startSeconds < vs.startSeconds - EPS || b.endSeconds > vs.endSeconds + EPS) err('timing.beat_outside', `Beat "${b.id}" lies outside its scene.`, bw);
      if (b.index !== bi) err('beat.index', `Beat "${b.id}" index ${b.index} should be ${bi}.`, bw);
      t = b.endSeconds;
      if (b.kind === 'dialogue') {
        const turn = s.turns.find((x) => x.id === b.turnId);
        if (!b.turnId || !turn) {
          err('turn.unknown', `Beat "${b.id}" references turn "${b.turnId}" that scene "${s.id}" does not contain.`, bw);
        } else {
          if (b.id !== `${vs.id}/turn/${turn.id}`) err('id.unstable', `Beat ID "${b.id}" is not derived from the scene and turn IDs.`, bw);
          if (b.activeSpeakerId !== turn.speakerId) err('turn.speaker_changed', `Beat "${b.id}" speaker differs from the source turn.`, { ...bw, turnId: turn.id });
          if (b.spokenText !== turn.spokenText) err('turn.text_changed', `Beat "${b.id}" spoken text differs from the source turn.`, { ...bw, turnId: turn.id });
          if ((b.reactingCharacterId ?? null) !== (turn.reactionTargetId ?? null)) err('turn.reaction_changed', `Beat "${b.id}" reacting character differs from the source turn.`, { ...bw, turnId: turn.id });
        }
        if (b.turnId) turnSeen.set(b.turnId, (turnSeen.get(b.turnId) ?? 0) + 1);
      } else if (b.turnId || b.spokenText || b.activeSpeakerId) {
        err('beat.invented_dialogue', `Non-dialogue beat "${b.id}" carries dialogue.`, bw);
      }
      for (const c of b.cues ?? []) checkCue(c, s.id, b.startSeconds, b.endSeconds, b.id);
    });
    if (beats.length && Math.abs(t - vs.endSeconds) > 1e-3) err('timing.beats_incomplete', `Beats of "${s.id}" end at ${t}s, scene ends at ${vs.endSeconds}s.`, where);
    for (const c of vs.sceneCues ?? []) checkCue(c, s.id, vs.startSeconds, vs.endSeconds);
  });

  /* ---- dialogue-turn coverage across the whole plan ---- */
  const allTurns = srcScenes.flatMap((s) => s.turns.map((t) => t.id));
  for (const id of allTurns) {
    const n = turnSeen.get(id) ?? 0;
    if (n === 0) err('turn.missing', `Dialogue turn "${id}" is missing from the plan.`, { turnId: id });
    if (n > 1) err('turn.duplicate', `Dialogue turn "${id}" appears ${n} times in the plan.`, { turnId: id });
  }

  for (const [id, n] of ids) if (n > 1) err('id.duplicate', `ID "${id}" is used ${n} times.`);

  /* ---- no absolute filesystem paths anywhere ---- */
  const strings: string[] = [];
  collectStrings(plan, strings);
  for (const str of strings) if (ABSOLUTE_PATH.test(str)) err('security.absolute_path', `Plan contains an absolute filesystem path: "${str.slice(0, 80)}".`);

  return done();
}
