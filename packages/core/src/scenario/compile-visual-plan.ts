/**
 * BuildTrack Video Factory - Phase 3B Deterministic Scenario Visual-Plan Compiler
 *
 * Pure function: Scenario -> ScenarioVisualPlan.
 *  - validates the source with the Phase 3A validator and refuses invalid input
 *    with a structured result (never a thrown runtime error);
 *  - times scenes and beats with the Phase 3A duration estimator;
 *  - surfaces Phase 3A diversity signals as warnings, never rewriting content;
 *  - copies every visible string verbatim and records where it came from;
 *  - uses integer milliseconds internally so timing is exact and byte-stable;
 *  - builds IDs only from scenario / scene / turn / evidence IDs.
 * No clocks, randomness, environment or filesystem access.
 */

import type { DialogueTurn, Scenario, ScenarioEvidence, ScenarioScene, ScenarioTargetFormat } from './types.js';
import { validateScenario } from './validate.js';
import { estimateScenarioDuration, DEFAULT_DURATION_CONFIG, type DurationEstimatorConfig } from './duration.js';
import { analyzeScenarioDiversity } from './diversity.js';
import {
  SCENARIO_VISUAL_PLAN_VERSION,
  type CompileScenarioVisualPlanResult,
  type ScenarioVisualBeat,
  type ScenarioVisualCue,
  type ScenarioVisualCueKind,
  type ScenarioVisualEvidence,
  type ScenarioVisualFormatProfile,
  type ScenarioVisualPlan,
  type ScenarioVisualPlanFinding,
  type ScenarioVisualScene,
  type ScenarioVisualShot,
  type ScenarioVisualSource,
  type ScenarioVisualTransition,
} from './visual-plan-types.js';

/** Format profiles. `reusable` takes the stricter of Long and Short so it fits both. */
export const SCENARIO_VISUAL_FORMAT_PROFILES: Record<ScenarioTargetFormat, ScenarioVisualFormatProfile> = {
  Long: { targetFormat: 'Long', orientation: 'landscape', aspectRatio: '16:9', maxBulletsPerFrame: 5, maxSceneTextCues: 4 },
  Short: { targetFormat: 'Short', orientation: 'portrait', aspectRatio: '9:16', maxBulletsPerFrame: 3, maxSceneTextCues: 3 },
  reusable: { targetFormat: 'reusable', orientation: 'format_neutral', aspectRatio: 'any', maxBulletsPerFrame: 3, maxSceneTextCues: 3 },
};

const ms = (seconds: number): number => Math.round(seconds * 1000);
const sec = (millis: number): number => millis / 1000;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function sceneVisualId(scenarioId: string, sceneId: string): string {
  return `${scenarioId}/${sceneId}`;
}

function evidenceView(e: ScenarioEvidence): ScenarioVisualEvidence {
  return {
    id: e.id,
    claim: e.claim,
    evidenceType: e.evidenceType,
    sourceRef: e.sourceRef,
    numericFacts: clone(e.numericFacts ?? []),
    confidence: e.confidence,
  };
}

function shotFor(scene: ScenarioScene, turn: DialogueTurn | null): ScenarioVisualShot {
  const p = scene.production;
  let focusCharacterId: string | null = null;
  if (turn && p.speakerFocus === 'speaking_character') focusCharacterId = turn.speakerId;
  if (turn && p.speakerFocus === 'reacting_character') focusCharacterId = turn.reactionTargetId ?? null;
  return { shotType: p.shotType, framing: p.framing, speakerFocus: p.speakerFocus, cameraMovement: p.cameraMovement, focusCharacterId };
}

function transitionFor(scene: ScenarioScene, estimatedSeconds: number): ScenarioVisualTransition {
  if (scene.transitionIntent) {
    return { type: scene.transitionIntent.type, durationSeconds: estimatedSeconds, source: 'scene.transitionIntent' };
  }
  if (scene.production.transitionIntent) {
    // production-level intent is carried for the renderer but is not part of the
    // Phase 3A duration estimate, so it adds no time to the plan
    return { type: scene.production.transitionIntent.type, durationSeconds: 0, source: 'production.transitionIntent' };
  }
  return { type: 'cut', durationSeconds: 0, source: 'default' };
}

interface CueDraft {
  kind: ScenarioVisualCueKind;
  text: string;
  source: ScenarioVisualSource;
  extra?: Partial<ScenarioVisualCue>;
}

function cue(idBase: string, d: CueDraft, startMs: number, endMs: number): ScenarioVisualCue {
  const suffix = d.source.itemIndex !== undefined ? `${d.kind}/${d.source.itemIndex}` : d.source.evidenceId ? `${d.kind}/${d.source.evidenceId}` : d.kind;
  return {
    id: `${idBase}/cue/${suffix}`,
    kind: d.kind,
    text: d.text,
    startSeconds: sec(startMs),
    endSeconds: sec(endMs),
    source: d.source,
    ...(d.extra ?? {}),
  };
}

function evidenceCue(sceneId: string, e: ScenarioEvidence, turnId?: string): CueDraft {
  return {
    kind: 'evidence',
    text: e.claim,
    source: { sceneId, field: 'evidence.claim', evidenceId: e.id, ...(turnId ? { turnId } : {}) },
    extra: { numericFacts: clone(e.numericFacts ?? []), evidenceSourceRef: e.sourceRef, evidenceConfidence: e.confidence },
  };
}

/** Scene-wide cue drafts, in a fixed order, copied verbatim from the source scene. */
function sceneCueDrafts(scene: ScenarioScene): CueDraft[] {
  const out: CueDraft[] = [];
  const s = scene.id;
  const info = scene.onScreenInfo;
  if (scene.title) out.push({ kind: 'scene_title', text: scene.title, source: { sceneId: s, field: 'scene.title' } });
  if (info?.title) out.push({ kind: 'lower_third_title', text: info.title, source: { sceneId: s, field: 'onScreenInfo.title' } });
  if (info?.subtitle) out.push({ kind: 'lower_third_subtitle', text: info.subtitle, source: { sceneId: s, field: 'onScreenInfo.subtitle' } });
  if (info?.callout) out.push({ kind: 'callout', text: info.callout, source: { sceneId: s, field: 'onScreenInfo.callout' } });
  (info?.bulletPoints ?? []).forEach((b, i) => out.push({ kind: 'bullet_point', text: b, source: { sceneId: s, field: 'onScreenInfo.bulletPoints', itemIndex: i } }));
  const p = scene.production;
  if (p.screenInsert) {
    const asset = p.screenInsert.assetRef ? { assetRef: p.screenInsert.assetRef } : {};
    out.push({ kind: 'screen_insert_title', text: p.screenInsert.title, source: { sceneId: s, field: 'production.screenInsert.title' }, extra: asset });
    out.push({ kind: 'screen_insert_description', text: p.screenInsert.description, source: { sceneId: s, field: 'production.screenInsert.description' }, extra: asset });
  }
  if (p.overlayIntent) out.push({ kind: 'overlay', text: p.overlayIntent, source: { sceneId: s, field: 'production.overlayIntent' } });
  if (p.bRollIntent) out.push({ kind: 'b_roll', text: p.bRollIntent, source: { sceneId: s, field: 'production.bRollIntent' } });
  if (p.environmentalAction) out.push({ kind: 'environment', text: p.environmentalAction, source: { sceneId: s, field: 'production.environmentalAction' } });
  return out;
}

const TEXT_CUE_KINDS = new Set<ScenarioVisualCueKind>(['lower_third_title', 'lower_third_subtitle', 'callout', 'screen_insert_title']);

function finding(severity: ScenarioVisualPlanFinding['severity'], ruleId: string, message: string, location: ScenarioVisualPlanFinding['location'] = {}): ScenarioVisualPlanFinding {
  return { severity, ruleId, message, location };
}

/**
 * Compile a canonical Scenario into a renderer-neutral visual plan.
 * Invalid scenarios are refused with `{ ok: false, errors }`.
 */
export function compileScenarioVisualPlan(
  scenario: Scenario,
  config: DurationEstimatorConfig = DEFAULT_DURATION_CONFIG,
): CompileScenarioVisualPlanResult {
  let report;
  try {
    report = validateScenario(scenario);
  } catch (err) {
    // a structurally broken object must still yield a structured refusal
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      plan: null,
      errors: [{ severity: 'error', category: 'schema', ruleId: 'visual_plan.source_unreadable', message: `Scenario could not be validated: ${message}`, location: {} }],
      sourceWarnings: [],
    };
  }
  const errors = report.findings.filter((f) => f.severity === 'error');
  const sourceWarnings = report.findings.filter((f) => f.severity === 'warning');
  if (!report.valid || errors.length) return { ok: false, plan: null, errors, sourceWarnings };

  // work on a private copy so nothing can leak back into the caller's object
  const src = clone(scenario);
  const meta = src.metadata;
  const format = SCENARIO_VISUAL_FORMAT_PROFILES[meta.targetFormat] ?? SCENARIO_VISUAL_FORMAT_PROFILES.reusable;
  const estimate = estimateScenarioDuration(src, config);
  const evidenceById = new Map(src.evidence.map((e) => [e.id, e] as const));
  const findings: ScenarioVisualPlanFinding[] = [];

  const scenes: ScenarioVisualScene[] = [];
  let cursor = 0;
  src.scenes.forEach((scene, si) => {
    const est = estimate.scenes[si];
    const sceneId = sceneVisualId(meta.id, scene.id);
    const startMs = cursor;
    const endMs = startMs + ms(est.totalSeconds);
    const beats: ScenarioVisualBeat[] = [];
    let t = startMs;

    scene.turns.forEach((turn, ti) => {
      const te = est.turns[ti];
      const bStart = t;
      const bEnd = t + ms(te.totalSeconds);
      const beatId = `${sceneId}/turn/${turn.id}`;
      const drafts: CueDraft[] = [{ kind: 'dialogue', text: turn.spokenText, source: { sceneId: scene.id, field: 'turn.spokenText', turnId: turn.id } }];
      if (turn.onScreenText) drafts.push({ kind: 'on_screen_text', text: turn.onScreenText, source: { sceneId: scene.id, field: 'turn.onScreenText', turnId: turn.id } });
      const ev = turn.evidenceId ? evidenceById.get(turn.evidenceId) : undefined;
      if (ev) drafts.push(evidenceCue(scene.id, ev, turn.id));
      beats.push({
        id: beatId,
        sceneId,
        index: beats.length,
        kind: 'dialogue',
        startSeconds: sec(bStart),
        endSeconds: sec(bEnd),
        turnId: turn.id,
        activeSpeakerId: turn.speakerId,
        reactingCharacterId: turn.reactionTargetId ?? null,
        spokenText: turn.spokenText,
        intent: turn.intent,
        delivery: turn.delivery ?? null,
        speechSeconds: te.speechDurationSeconds,
        pauseSeconds: te.pauseSeconds,
        shot: shotFor(scene, turn),
        evidenceIds: ev ? [ev.id] : [],
        // spoken content is timed to the speech, not the trailing pause
        cues: drafts.map((d) => cue(beatId, d, bStart, Math.min(bEnd, bStart + ms(te.speechDurationSeconds)))),
      });
      t = bEnd;
    });

    if (scene.turns.length === 0) {
      const beatId = `${sceneId}/visual`;
      const bEnd = t + ms(est.visualBeatSeconds);
      beats.push({
        id: beatId,
        sceneId,
        index: beats.length,
        kind: 'visual_only',
        startSeconds: sec(t),
        endSeconds: sec(bEnd),
        turnId: null,
        activeSpeakerId: null,
        reactingCharacterId: null,
        spokenText: null,
        intent: null,
        delivery: null,
        speechSeconds: 0,
        pauseSeconds: 0,
        shot: shotFor(scene, null),
        evidenceIds: [],
        cues: [],
      });
      t = bEnd;
    }

    if (est.transitionSeconds > 0) {
      const beatId = `${sceneId}/transition`;
      beats.push({
        id: beatId,
        sceneId,
        index: beats.length,
        kind: 'transition',
        startSeconds: sec(t),
        endSeconds: sec(endMs),
        turnId: null,
        activeSpeakerId: null,
        reactingCharacterId: null,
        spokenText: null,
        intent: null,
        delivery: null,
        speechSeconds: 0,
        pauseSeconds: 0,
        shot: shotFor(scene, null),
        evidenceIds: [],
        cues: [],
      });
      t = endMs;
    }
    // absorb any 10ms rounding difference between the per-turn and scene totals
    if (beats.length) beats[beats.length - 1].endSeconds = sec(endMs);

    // scene-level evidence not already cited by a turn
    const turnEvidence = new Set(scene.turns.map((x) => x.evidenceId).filter(Boolean) as string[]);
    const declared = [...new Set([...(scene.evidenceIds ?? []), ...turnEvidence])];
    const drafts = sceneCueDrafts(scene);
    for (const id of scene.evidenceIds ?? []) {
      const e = evidenceById.get(id);
      if (e && !turnEvidence.has(id)) drafts.push(evidenceCue(scene.id, e));
    }
    const sceneCues = drafts.map((d) => cue(sceneId, d, startMs, endMs));

    // format fit: surfaced, never truncated
    const bullets = scene.onScreenInfo?.bulletPoints?.length ?? 0;
    if (bullets > format.maxBulletsPerFrame) {
      findings.push(finding('warning', 'format.bullets_exceed_frame', `Scene ${scene.id} has ${bullets} bullet points; a ${format.targetFormat} frame carries at most ${format.maxBulletsPerFrame}. Review the layout; the text was not changed.`, { sceneId: scene.id }));
    }
    const textCues = sceneCues.filter((c) => TEXT_CUE_KINDS.has(c.kind)).length;
    if (textCues > format.maxSceneTextCues) {
      findings.push(finding('warning', 'format.scene_text_crowded', `Scene ${scene.id} has ${textCues} scene-wide text elements; ${format.targetFormat} allows ${format.maxSceneTextCues} at once.`, { sceneId: scene.id }));
    }

    const tr = transitionFor(scene, est.transitionSeconds);
    scenes.push({
      id: sceneId,
      sourceSceneId: scene.id,
      index: scene.index,
      title: scene.title ?? null,
      narrativePurpose: scene.narrativePurpose,
      locationId: scene.locationId,
      participantIds: [...scene.participantIds],
      turnIds: scene.turns.map((x) => x.id),
      speakerIds: [...new Set(scene.turns.map((x) => x.speakerId))],
      visualOnly: scene.turns.length === 0,
      startSeconds: sec(startMs),
      endSeconds: sec(endMs),
      durationSeconds: sec(endMs - startMs),
      production: clone(scene.production),
      onScreenInfo: scene.onScreenInfo ? clone(scene.onScreenInfo) : null,
      evidenceIds: declared,
      evidence: declared.map((id) => evidenceById.get(id)).filter(Boolean).map((e) => evidenceView(e as ScenarioEvidence)),
      transitionOut: tr,
      beats,
      sceneCues,
    });
    cursor = endMs;
  });

  // duration against the declared target: surfaced, never "fixed"
  const total = sec(cursor);
  const target = meta.estimatedDuration;
  if (typeof target.maxSeconds === 'number' && total > target.maxSeconds) {
    findings.push(finding('warning', 'format.duration_over_target', `Estimated ${total}s exceeds the ${meta.targetFormat} maximum of ${target.maxSeconds}s.`));
  }
  if (typeof target.minSeconds === 'number' && total < target.minSeconds) {
    findings.push(finding('warning', 'format.duration_under_target', `Estimated ${total}s is below the ${meta.targetFormat} minimum of ${target.minSeconds}s.`));
  }

  // diversity: Phase 3A signals plus the visual pattern, as warnings only
  const div = analyzeScenarioDiversity(src);
  const diversityWarnings: ScenarioVisualPlanFinding[] = [];
  for (const run of [...div.consecutiveSpeakerRuns, ...div.repeatedShotRuns, ...div.repeatedSettingRuns, ...div.repeatedPurposeRuns]) {
    if (run.isJustified) continue;
    const loc = run.locations[0] ?? {};
    diversityWarnings.push(
      finding('warning', `diversity.${run.type}`, `Unjustified ${run.type.replace(/_/g, ' ')} run: "${run.value}" x${run.count}.`, {
        ...(loc.sceneId ? { sceneId: loc.sceneId } : {}),
        ...(loc.turnId ? { turnId: loc.turnId } : {}),
      }),
    );
  }
  for (const rep of div.repeatedSentences) {
    const first = rep.occurrences[0];
    diversityWarnings.push(finding('warning', 'diversity.repeated_sentence', `Sentence spoken ${rep.occurrences.length} times: "${rep.sentence}".`, { sceneId: first?.sceneId, turnId: first?.turnId }));
  }
  for (let i = 1; i < src.scenes.length; i++) {
    const a = src.scenes[i - 1].production;
    const b = src.scenes[i].production;
    const same = a.shotType === b.shotType && a.framing === b.framing && a.cameraMovement === b.cameraMovement && a.speakerFocus === b.speakerFocus;
    if (same && !src.scenes[i].justifications?.repeatedShot) {
      diversityWarnings.push(
        finding('warning', 'diversity.repeated_visual_pattern', `Scenes ${src.scenes[i - 1].id} and ${src.scenes[i].id} use the identical shot, framing, focus and movement.`, { sceneId: src.scenes[i].id }),
      );
    }
  }

  const plan: ScenarioVisualPlan = {
    planVersion: SCENARIO_VISUAL_PLAN_VERSION,
    scenarioId: meta.id,
    projectId: meta.projectId,
    scenarioSchemaVersion: meta.schemaVersion,
    language: meta.language,
    format: { ...format },
    totalDurationSeconds: total,
    targetDuration: { targetSeconds: target.targetSeconds, minSeconds: target.minSeconds ?? null, maxSeconds: target.maxSeconds ?? null },
    scenes,
    diversity: { overallDiversityScore: div.overallDiversityScore, warnings: diversityWarnings },
    findings,
  };
  return { ok: true, plan, sourceWarnings };
}
