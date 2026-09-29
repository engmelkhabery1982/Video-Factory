/**
 * BuildTrack Video Factory - Phase 3D Unified Scenario Playback validator
 *
 * Verifies a ScenarioPlaybackPlan against the ORIGINAL Scenario, not only for
 * internal consistency. It re-derives reference visual and audio plans from
 * the source with the plan's own recorded duration configuration (using the
 * existing Phase 3B / 3C planners) and checks every scene, beat, cue, dialogue
 * entry, voice slot and interval against them and against the source turns.
 *
 * Pure and deterministic; never throws on malformed input.
 */

import type { DialogueTurn, Scenario } from './types.js';
import { DEFAULT_DURATION_CONFIG, type DurationEstimatorConfig } from './duration.js';
import { compileScenarioVisualPlan } from './compile-visual-plan.js';
import { resolveVisualCueSourceText } from './validate-visual-plan.js';
import { planDialogueAudio } from './plan-dialogue-audio.js';
import { DIALOGUE_AUDIO_PLAN_SCHEMA_VERSION, type DialogueAudioClip, type DialogueAudioPlan } from './dialogue-audio-types.js';
import { SCENARIO_VISUAL_PLAN_VERSION, type ScenarioVisualBeat, type ScenarioVisualCue, type ScenarioVisualPlan } from './visual-plan-types.js';
import {
  SCENARIO_PLAYBACK_PLAN_VERSION,
  type ScenarioPlaybackCue,
  type ScenarioPlaybackDialogue,
  type ScenarioPlaybackFinding,
  type ScenarioPlaybackInterval,
  type ScenarioPlaybackPlan,
  type ScenarioPlaybackValidationReport,
} from './scenario-playback-types.js';

/* ------------------------------------------------------------------ */
/* shared helpers (also used by the compiler)                           */
/* ------------------------------------------------------------------ */

/** Seconds -> integer ms. */
export const toMs = (seconds: number): number => Math.round(seconds * 1000);

export const interval = (startMs: number, endMs: number): ScenarioPlaybackInterval => ({ startMs, endMs, durationMs: endMs - startMs });

const DURATION_KEYS = Object.keys(DEFAULT_DURATION_CONFIG) as (keyof DurationEstimatorConfig)[];

/**
 * Resolve partial overrides into a complete estimator config
 * (wordsPerMinute > 0, every other value >= 0, no unknown keys).
 */
export function resolvePlaybackDurationConfig(partial: unknown): { config: DurationEstimatorConfig } | { error: string } {
  if (partial !== undefined && (partial === null || typeof partial !== 'object' || Array.isArray(partial))) return { error: 'durationConfig must be an object.' };
  const src = (partial ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(src)) if (!DURATION_KEYS.includes(k as keyof DurationEstimatorConfig)) return { error: `durationConfig.${k} is not a known estimator setting.` };
  const config = { ...DEFAULT_DURATION_CONFIG };
  for (const k of DURATION_KEYS) {
    const v = src[k] === undefined ? DEFAULT_DURATION_CONFIG[k] : src[k];
    const okZero = k !== 'wordsPerMinute';
    if (typeof v !== 'number' || !Number.isFinite(v) || (okZero ? v < 0 : v <= 0)) return { error: `durationConfig.${k} must be a finite ${okZero ? 'non-negative' : 'positive'} number.` };
    config[k] = v;
  }
  return { config };
}

/** A Phase 3B cue re-expressed with an integer-ms interval. */
export function toPlaybackCue(c: ScenarioVisualCue): ScenarioPlaybackCue {
  const { startSeconds, endSeconds, ...rest } = JSON.parse(JSON.stringify(c)) as ScenarioVisualCue;
  return { ...rest, interval: interval(toMs(startSeconds), toMs(endSeconds)) };
}

/* ------------------------------------------------------------------ */

const ABSOLUTE_PATH = /(^|[\s"'(])(\/(?:home|root|etc|var|tmp|usr|Users|mnt|opt|private|Volumes)\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\)|file:\/\//;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isIv = (x: unknown): x is ScenarioPlaybackInterval =>
  !!x && typeof x === 'object' && isInt((x as ScenarioPlaybackInterval).startMs) && isInt((x as ScenarioPlaybackInterval).endMs) && isInt((x as ScenarioPlaybackInterval).durationMs);
const ivEq = (a: ScenarioPlaybackInterval, b: ScenarioPlaybackInterval) => a.startMs === b.startMs && a.endMs === b.endMs;
const ivStr = (a: ScenarioPlaybackInterval) => `${a.startMs}-${a.endMs}ms`;

function collectStrings(x: unknown, out: string[]): void {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const v of x) collectStrings(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x)) collectStrings(v, out);
}

export function validateScenarioPlaybackPlan(plan: ScenarioPlaybackPlan, sourceScenario: Scenario): ScenarioPlaybackValidationReport {
  const findings: ScenarioPlaybackFinding[] = [];
  const err = (ruleId: string, message: string, location: ScenarioPlaybackFinding['location'] = {}) => findings.push({ severity: 'error', ruleId, message, stage: 'playback', location });
  const done = (): ScenarioPlaybackValidationReport => {
    const errorCount = findings.filter((f) => f.severity === 'error').length;
    return { valid: errorCount === 0, errorCount, warningCount: findings.length - errorCount, findings };
  };

  try {
    return run();
  } catch (e) {
    err('plan.malformed', `Playback plan could not be inspected: ${e instanceof Error ? e.message : String(e)}`);
    return done();
  }

  function run(): ScenarioPlaybackValidationReport {
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.scenes) || !Array.isArray(plan.dialogues)) {
      err('plan.malformed', 'Playback plan is not an object with scenes and dialogues arrays.');
      return done();
    }
    if (!sourceScenario || typeof sourceScenario !== 'object' || !Array.isArray(sourceScenario.scenes) || !sourceScenario.metadata) {
      err('plan.source_malformed', 'Source scenario is not an object with metadata and scenes.');
      return done();
    }
    const meta = sourceScenario.metadata;

    /* ---- identity ---- */
    if (plan.playbackVersion !== SCENARIO_PLAYBACK_PLAN_VERSION) err('plan.version', `Unsupported playback version "${plan.playbackVersion}".`);
    if (plan.scenarioId !== meta.id) err('plan.scenario_id', `scenarioId "${plan.scenarioId}" does not match source "${meta.id}".`);
    if (plan.projectId !== meta.projectId) err('plan.project_id', `projectId "${plan.projectId}" does not match source "${meta.projectId}".`);
    if (plan.language !== meta.language) err('plan.language', `language "${plan.language}" does not match source "${meta.language}".`);
    if (plan.targetFormat !== meta.targetFormat) err('plan.format', `targetFormat "${plan.targetFormat}" does not match source "${meta.targetFormat}".`);
    if (!same(plan.schemaVersions, { scenario: meta.schemaVersion, visualPlan: SCENARIO_VISUAL_PLAN_VERSION, audioPlan: DIALOGUE_AUDIO_PLAN_SCHEMA_VERSION })) err('plan.schema_versions', 'schemaVersions do not match the source scenario and the current plan versions.');

    /* ---- paths ---- */
    const basePathSafe = typeof plan.audioBasePath === 'string' && !!plan.audioBasePath && !plan.audioBasePath.startsWith('/') && !plan.audioBasePath.includes('..') && !plan.audioBasePath.includes(':');
    if (!basePathSafe) err('security.audio_base_path', 'audioBasePath must be a safe relative path.');
    const strings: string[] = [];
    collectStrings(plan, strings);
    for (const str of strings) if (ABSOLUTE_PATH.test(str) || /^\//.test(str) && str.includes('/') && /\.(wav|mp3|png|jpe?g|mp4|json)$/i.test(str)) err('security.absolute_path', `Plan contains an absolute filesystem path: "${str.slice(0, 80)}".`);


    /* ---- duration configuration: complete, valid, then used as the reference ---- */
    let config: DurationEstimatorConfig = DEFAULT_DURATION_CONFIG;
    const cfg = resolvePlaybackDurationConfig(plan.durationConfig);
    if ('error' in cfg) err('plan.duration_config_invalid', cfg.error);
    else if (!same(Object.keys(plan.durationConfig).sort(), [...DURATION_KEYS].sort())) err('plan.duration_config_incomplete', 'durationConfig must record every estimator setting.');
    else config = cfg.config;

    /* ---- reference plans derived from the source ---- */
    const vr = compileScenarioVisualPlan(sourceScenario, config);
    if (!vr.ok) {
      err('plan.source_invalid', `Source scenario is invalid: ${vr.errors.map((e) => e.ruleId).join(', ')}.`);
      return done();
    }
    const refVisual: ScenarioVisualPlan = vr.plan;
    let refAudio: DialogueAudioPlan;
    try {
      refAudio = planDialogueAudio(sourceScenario, { durationConfig: { ...config }, allowSharedVoiceSlots: plan.allowSharedVoiceSlots === true, basePath: basePathSafe ? plan.audioBasePath : 'audio/dialogue' });
    } catch (e) {
      err('plan.audio_reference_failed', `Dialogue audio cannot be planned for this source with the recorded options: ${e instanceof Error ? e.message : String(e)}`);
      return done();
    }
    if (!same(plan.format, refVisual.format)) err('plan.format_profile', 'Format profile differs from the Phase 3B profile for this target format.');
    if (!same(plan.audioFormat, refAudio.audioFormat)) err('plan.audio_format', 'Audio format differs from the Phase 3C specification.');
    if (!same(plan.characters, refAudio.characters.map((c) => ({ characterId: c.characterId, voiceSlot: c.voiceSlot, turnCount: c.turnCount })))) err('voice.characters_changed', 'Character voice table differs from the voice slots resolved from the source.');

    const refClipByTurn = new Map<string, DialogueAudioClip>(refAudio.clips.map((c) => [c.turnId, c]));
    const refBeatById = new Map<string, ScenarioVisualBeat>(refVisual.scenes.flatMap((s) => s.beats.map((b) => [b.id, b] as const)));

    /* ---- ids ---- */
    const ids = new Map<string, number>();
    const addId = (id: unknown) => {
      if (typeof id !== 'string' || !id) return err('id.missing', 'An element has no ID.');
      ids.set(id, (ids.get(id) ?? 0) + 1);
    };

    /* ---- scene coverage ---- */
    const srcScenes = sourceScenario.scenes;
    const srcSceneIds = new Set(srcScenes.map((s) => s.id));
    const sceneSeen = new Map<string, number>();
    for (const ps of plan.scenes) {
      if (!ps || typeof ps !== 'object') {
        err('scene.malformed', 'A playback scene is not an object.');
        continue;
      }
      sceneSeen.set(ps.sourceSceneId, (sceneSeen.get(ps.sourceSceneId) ?? 0) + 1);
      if (!srcSceneIds.has(ps.sourceSceneId)) err('scene.unknown', `Scene "${ps.sourceSceneId}" does not exist in the source.`, { sceneId: ps.sourceSceneId });
    }
    for (const [id, n] of sceneSeen) if (n > 1) err('scene.duplicate', `Source scene "${id}" appears ${n} times.`, { sceneId: id });
    for (const s of srcScenes) if (!sceneSeen.has(s.id)) err('scene.missing', `Source scene "${s.id}" is missing.`, { sceneId: s.id });
    const orderOk = plan.scenes.length === srcScenes.length && plan.scenes.every((ps, i) => ps?.sourceSceneId === srcScenes[i].id);
    if (!orderOk && sceneSeen.size === srcScenes.length && plan.scenes.length === srcScenes.length) err('scene.order', 'Scenes are not in source order.');

    const dialogueById = new Map<string, ScenarioPlaybackDialogue>();
    for (const d of plan.dialogues) if (d && typeof d === 'object' && typeof d.id === 'string' && !dialogueById.has(d.id)) dialogueById.set(d.id, d);

    let prevSceneEnd = 0;
    let sumTransition = 0;
    let sumVisualOnly = 0;
    const checkIv = (iv: unknown, what: string, loc: ScenarioPlaybackFinding['location']): iv is ScenarioPlaybackInterval => {
      if (!isIv(iv) || iv.endMs < iv.startMs || iv.durationMs !== iv.endMs - iv.startMs || iv.startMs < 0) {
        err('timing.interval_invalid', `${what} has an invalid interval ${JSON.stringify(iv)}.`, loc);
        return false;
      }
      return true;
    };
    const checkCues = (cues: unknown, refCues: ScenarioVisualCue[], parent: ScenarioPlaybackInterval, loc: ScenarioPlaybackFinding['location']) => {
      if (!Array.isArray(cues)) return err('cue.malformed', 'Cue list is not an array.', loc);
      const expected = refCues.map(toPlaybackCue);
      const expById = new Map(expected.map((c) => [c.id, c] as const));
      const seen = new Set<string>();
      for (const c of cues as ScenarioPlaybackCue[]) {
        const cl = { ...loc, cueId: c?.id };
        addId(c?.id);
        const exp = expById.get(c?.id);
        if (!exp) {
          err('cue.invented', `Cue "${c?.id}" ("${String(c?.text).slice(0, 60)}") has no source in this scene.`, cl);
          continue;
        }
        seen.add(c.id);
        const resolved = c.source ? resolveVisualCueSourceText(sourceScenario, c.source) : null;
        if (c.text !== exp.text || resolved !== c.text) err('cue.text_changed', `Cue "${c.id}" text differs from its source.`, cl);
        if (c.kind === 'evidence' && !same(c.numericFacts, exp.numericFacts)) err('evidence.numeric_changed', `Cue "${c.id}" numeric facts differ from the source evidence.`, { ...cl, evidenceId: c.source?.evidenceId });
        const { interval: iv, ...rest } = c;
        const { interval: eiv, ...erest } = exp;
        if (!same(rest, erest) && c.text === exp.text) err('cue.changed', `Cue "${c.id}" differs from the Phase 3B cue.`, cl);
        if (checkIv(iv, `Cue "${c.id}"`, cl)) {
          if (iv.startMs < parent.startMs || iv.endMs > parent.endMs) err('timing.cue_outside', `Cue "${c.id}" ${ivStr(iv)} lies outside ${ivStr(parent)}.`, cl);
          else if (!ivEq(iv, eiv)) err('timing.cue_changed', `Cue "${c.id}" timing differs from the reference.`, cl);
        }
      }
      for (const e of expected) if (!seen.has(e.id)) err('cue.missing', `Cue "${e.id}" is missing.`, loc);
    };

    /* ---- per scene ---- */
    plan.scenes.forEach((ps, si) => {
      if (!ps || typeof ps !== 'object') return;
      const loc = { sceneId: ps.sourceSceneId };
      addId(ps.id);
      const rv = refVisual.scenes.find((x) => x.sourceSceneId === ps.sourceSceneId);
      const src = srcScenes.find((x) => x.id === ps.sourceSceneId);
      if (!checkIv(ps.interval, `Scene "${ps.sourceSceneId}"`, loc)) return;
      if (ps.interval.startMs < prevSceneEnd) err('timing.scene_overlap', `Scene "${ps.sourceSceneId}" starts at ${ps.interval.startMs}ms before the previous scene ends at ${prevSceneEnd}ms.`, loc);
      else if (ps.interval.startMs > prevSceneEnd) err('timing.scene_gap', `Gap before scene "${ps.sourceSceneId}" (${prevSceneEnd}-${ps.interval.startMs}ms).`, loc);
      if (ps.interval.durationMs <= 0) err('timing.scene_empty', `Scene "${ps.sourceSceneId}" has no duration.`, loc);
      prevSceneEnd = Math.max(prevSceneEnd, ps.interval.endMs);
      if (!rv || !src) return;

      if (ps.id !== rv.id) err('id.unstable', `Scene ID "${ps.id}" should be "${rv.id}".`, loc);
      if (ps.index !== src.index || ps.index !== si) err('scene.index_changed', `Scene "${src.id}" index ${ps.index} is wrong.`, loc);
      if ((ps.title ?? null) !== (src.title ?? null)) err('scene.title_changed', `Scene "${src.id}" title changed.`, loc);
      if (ps.narrativePurpose !== src.narrativePurpose) err('scene.purpose_changed', `Scene "${src.id}" narrative purpose changed.`, loc);
      if (ps.locationId !== src.locationId) err('scene.location_changed', `Scene "${src.id}" location changed.`, loc);
      if (!same(ps.participantIds, src.participantIds)) err('scene.participants_changed', `Scene "${src.id}" participants changed.`, loc);
      if (ps.visualOnly !== (src.turns.length === 0)) err('scene.visual_only_mismatch', `Scene "${src.id}" visualOnly flag is wrong.`, loc);
      if (!same(ps.production, src.production)) err('scene.production_changed', `Scene "${src.id}" production direction differs from the source.`, loc);
      if (!same(ps.onScreenInfo, src.onScreenInfo ?? null)) err('scene.on_screen_info_changed', `Scene "${src.id}" on-screen information differs from the source.`, loc);
      if (!same(ps.evidence, rv.evidence)) err('evidence.changed', `Scene "${src.id}" evidence records differ from the source evidence.`, loc);
      const refIv = interval(toMs(rv.startSeconds), toMs(rv.endSeconds));
      if (!ivEq(ps.interval, refIv)) err('timing.scene_changed', `Scene "${src.id}" ${ivStr(ps.interval)} should be ${ivStr(refIv)} under the recorded duration configuration.`, loc);

      /* beats */
      const beats = Array.isArray(ps.beats) ? ps.beats : [];
      if (!same(beats.map((b) => b?.id), rv.beats.map((b) => b.id))) err('beat.coverage', `Scene "${src.id}" beats do not match the visual beats derived from the source (missing, extra, duplicate or reordered).`, loc);
      let cursor = ps.interval.startMs;
      let transitionIv: ScenarioPlaybackInterval | null = null;
      beats.forEach((b, bi) => {
        if (!b || typeof b !== 'object') return err('beat.malformed', `Beat ${bi} of "${src.id}" is not an object.`, loc);
        const bl = { ...loc, beatId: b.id };
        addId(b.id);
        if (b.index !== bi) err('beat.index', `Beat "${b.id}" index ${b.index} should be ${bi}.`, bl);
        if (!checkIv(b.interval, `Beat "${b.id}"`, bl)) return;
        if (b.interval.startMs < cursor) err('timing.beat_overlap', `Beat "${b.id}" overlaps the previous beat.`, bl);
        else if (b.interval.startMs > cursor) err('timing.beat_gap', `Gap before beat "${b.id}".`, bl);
        if (b.interval.startMs < ps.interval.startMs || b.interval.endMs > ps.interval.endMs) err('timing.beat_outside', `Beat "${b.id}" lies outside its scene.`, bl);
        cursor = b.interval.endMs;
        const rb = refBeatById.get(b.id);
        if (!rb) return;
        const rbIv = interval(toMs(rb.startSeconds), toMs(rb.endSeconds));
        if (b.kind !== rb.kind) err('beat.kind_changed', `Beat "${b.id}" kind "${b.kind}" should be "${rb.kind}".`, bl);
        if (!ivEq(b.interval, rbIv)) err('timing.beat_changed', `Beat "${b.id}" ${ivStr(b.interval)} should be ${ivStr(rbIv)}.`, bl);
        if (!same(b.shot, rb.shot)) err('beat.shot_changed', `Beat "${b.id}" shot differs from the source direction.`, bl);
        if (b.activeSpeakerId !== rb.activeSpeakerId) err('turn.speaker_changed', `Beat "${b.id}" active speaker differs from the source.`, bl);
        if (b.reactingCharacterId !== rb.reactingCharacterId) err('turn.reaction_changed', `Beat "${b.id}" reacting character differs from the source.`, bl);
        if (!same(b.evidenceIds, rb.evidenceIds)) err('evidence.ids_changed', `Beat "${b.id}" evidence IDs differ from the source.`, bl);
        checkCues(b.cues, rb.cues, b.interval, bl);
        if (rb.kind === 'dialogue') {
          const d = b.dialogueId ? dialogueById.get(b.dialogueId) : undefined;
          if (!d) err('playback.beat_without_clip', `Dialogue beat "${b.id}" has no dialogue/audio entry.`, bl);
          else if (isIv(d.turnSpan) && !ivEq(d.turnSpan, b.interval)) err('timing.turn_span_mismatch', `Dialogue "${d.id}" turn span ${ivStr(d.turnSpan)} differs from its beat ${ivStr(b.interval)}.`, bl);
        } else {
          if (b.dialogueId !== null) err('beat.invented_dialogue', `Non-dialogue beat "${b.id}" references dialogue.`, bl);
          if (rb.kind === 'transition') {
            transitionIv = b.interval;
            sumTransition += b.interval.durationMs;
          } else sumVisualOnly += b.interval.durationMs;
        }
      });
      if (beats.length && cursor !== ps.interval.endMs) err('timing.beats_incomplete', `Beats of "${src.id}" end at ${cursor}ms but the scene ends at ${ps.interval.endMs}ms.`, loc);

      /* transition */
      const tr = ps.transition;
      if (!tr || tr.type !== rv.transitionOut.type || tr.source !== rv.transitionOut.source) err('transition.changed', `Scene "${src.id}" transition differs from the source.`, loc);
      const refTransitionBeat = rv.beats.find((b) => b.kind === 'transition');
      if (!refTransitionBeat) {
        if (tr?.interval) err('transition.untimed_gained_duration', `Scene "${src.id}" transition (${tr.source}) adds no Phase 3A time but has an interval.`, loc);
      } else if (!tr?.interval || !transitionIv || !ivEq(tr.interval, transitionIv)) {
        err('transition.interval_mismatch', `Scene "${src.id}" transition interval does not match its transition beat.`, loc);
      }

      /* scene cues */
      checkCues(ps.sceneCues, rv.sceneCues, ps.interval, loc);

      /* scene dialogue index */
      const expectedDialogueIds = rv.beats.filter((b) => b.kind === 'dialogue').map((b) => b.id);
      if (!same(ps.dialogueIds, expectedDialogueIds)) err('scene.dialogue_ids', `Scene "${src.id}" dialogue list differs from its source turns.`, loc);
      const dBeats = rv.beats.filter((b) => b.kind === 'dialogue');
      const expSpan = dBeats.length ? interval(toMs(dBeats[0].startSeconds), toMs(dBeats[dBeats.length - 1].endSeconds)) : null;
      if (expSpan === null ? ps.dialogueSpan !== null : !isIv(ps.dialogueSpan) || !ivEq(ps.dialogueSpan, expSpan)) err('timing.dialogue_span', `Scene "${src.id}" dialogue span is wrong.`, loc);
    });

    /* ---- dialogue coverage ---- */
    const srcTurns: { turn: DialogueTurn; sceneId: string; sceneIndex: number; turnIndex: number }[] = [];
    srcScenes.forEach((s, si) => s.turns.forEach((turn, ti) => srcTurns.push({ turn, sceneId: s.id, sceneIndex: si, turnIndex: ti })));
    const srcTurnIds = new Set(srcTurns.map((t) => t.turn.id));
    const turnSeen = new Map<string, number>();
    for (const d of plan.dialogues) {
      if (!d || typeof d !== 'object') {
        err('dialogue.malformed', 'A dialogue entry is not an object.');
        continue;
      }
      turnSeen.set(d.turnId, (turnSeen.get(d.turnId) ?? 0) + 1);
      if (!srcTurnIds.has(d.turnId)) err('turn.unknown', `Dialogue turn "${d.turnId}" does not exist in the source.`, { turnId: d.turnId });
    }
    for (const t of srcTurns) {
      const n = turnSeen.get(t.turn.id) ?? 0;
      if (n === 0) err('turn.missing', `Dialogue turn "${t.turn.id}" is missing (no audio clip / dialogue entry).`, { turnId: t.turn.id, sceneId: t.sceneId });
      if (n > 1) err('turn.duplicate', `Dialogue turn "${t.turn.id}" appears ${n} times.`, { turnId: t.turn.id, sceneId: t.sceneId });
    }
    const unique = plan.dialogues.filter((d) => d && srcTurnIds.has(d.turnId));
    if (unique.length === srcTurns.length && turnSeen.size === srcTurns.length && !unique.every((d, i) => d.turnId === srcTurns[i].turn.id)) err('turn.order', 'Dialogue turns are not in source order.');

    const clipIds = new Map<string, number>();
    let prevTurnEnd = 0;
    let sumSpeech = 0;
    let sumPause = 0;
    const srcByTurn = new Map(srcTurns.map((t) => [t.turn.id, t] as const));
    const evidenceIds = new Set(sourceScenario.evidence.map((e) => e.id));
    plan.dialogues.forEach((d, di) => {
      if (!d || typeof d !== 'object') return;
      const s = srcByTurn.get(d.turnId);
      const loc = { turnId: d.turnId, sceneId: d.sceneId, clipId: d.audioClipId };
      clipIds.set(d.audioClipId, (clipIds.get(d.audioClipId) ?? 0) + 1);
      if (!s) return;
      const t = s.turn;
      const refClip = refClipByTurn.get(t.id)!;
      const refVisualScene = refVisual.scenes[s.sceneIndex];
      const expectedBeatId = `${refVisualScene.id}/turn/${t.id}`;
      const refBeat = refBeatById.get(expectedBeatId)!;

      if (d.id !== expectedBeatId || d.visualBeatId !== expectedBeatId) err('id.unstable', `Dialogue "${d.id}" should use beat ID "${expectedBeatId}".`, loc);
      if (d.audioClipId !== refClip.clipId) err('id.unstable', `Dialogue for turn "${t.id}" should use clip ID "${refClip.clipId}".`, loc);
      if (d.globalIndex !== di) err('dialogue.index', `Dialogue "${d.id}" globalIndex ${d.globalIndex} should be ${di}.`, loc);
      if (d.sceneId !== s.sceneId || d.sceneIndex !== s.sceneIndex || d.turnIndex !== s.turnIndex) err('turn.scene_changed', `Dialogue "${d.id}" scene/turn position differs from the source.`, loc);
      if (d.speakerId !== t.speakerId) err('turn.speaker_changed', `Dialogue "${d.id}" speaker differs from the source turn.`, loc);
      if (d.reactingCharacterId !== (t.reactionTargetId ?? null)) err('turn.reaction_changed', `Dialogue "${d.id}" reacting character differs from the source turn.`, loc);
      if (d.spokenText !== t.spokenText) err('turn.text_changed', `Dialogue "${d.id}" spoken text differs from the source turn.`, loc);
      if (d.intent !== t.intent) err('turn.intent_changed', `Dialogue "${d.id}" intent differs from the source turn.`, loc);
      if (!same(d.delivery, t.delivery ?? null)) err('turn.delivery_changed', `Dialogue "${d.id}" delivery differs from the source turn.`, loc);
      if (!same(d.evidenceIds, t.evidenceId ? [t.evidenceId] : [])) err('evidence.ids_changed', `Dialogue "${d.id}" evidence differs from the source turn.`, loc);
      for (const id of d.evidenceIds ?? []) if (!evidenceIds.has(id)) err('evidence.unknown', `Dialogue "${d.id}" cites unknown evidence "${id}".`, { ...loc, evidenceId: id });
      if (d.voiceSlot !== refClip.voiceSlot) err('voice.slot_changed', `Dialogue "${d.id}" voice slot "${d.voiceSlot}" should be "${refClip.voiceSlot}".`, loc);
      if (d.suggestedAudioPath !== refClip.suggestedPath) err('path.changed', `Dialogue "${d.id}" suggested audio path should be "${refClip.suggestedPath}".`, loc);

      if (!checkIv(d.speech, `Speech of "${d.id}"`, loc) || !checkIv(d.pause, `Pause of "${d.id}"`, loc) || !checkIv(d.turnSpan, `Turn span of "${d.id}"`, loc)) return;
      const beatIv = interval(toMs(refBeat.startSeconds), toMs(refBeat.endSeconds));
      if (d.turnSpan.startMs < prevTurnEnd) err('timing.dialogue_overlap', `Dialogue "${d.id}" starts at ${d.turnSpan.startMs}ms before the previous turn ends at ${prevTurnEnd}ms.`, loc);
      prevTurnEnd = Math.max(prevTurnEnd, d.turnSpan.endMs);
      if (!ivEq(d.turnSpan, beatIv)) err('timing.turn_span_changed', `Dialogue "${d.id}" turn span ${ivStr(d.turnSpan)} should be ${ivStr(beatIv)}.`, loc);
      if (d.speech.startMs < beatIv.startMs || d.speech.endMs > beatIv.endMs || d.speech.startMs !== d.turnSpan.startMs) err('timing.speech_outside_beat', `Speech of "${d.id}" ${ivStr(d.speech)} is not anchored inside its visual beat ${ivStr(beatIv)}.`, loc);
      if (d.speech.durationMs !== toMs(refClip.durationSeconds)) err('timing.speech_duration', `Speech of "${d.id}" lasts ${d.speech.durationMs}ms; the estimator gives ${toMs(refClip.durationSeconds)}ms.`, loc);
      if (d.pause.startMs !== d.speech.endMs || d.pause.endMs !== d.turnSpan.endMs) err('timing.pause_outside_turn', `Pause of "${d.id}" ${ivStr(d.pause)} does not run from speech end to turn end.`, loc);
      else if (Math.abs(d.pause.durationMs - toMs(refClip.pauseAfterSeconds)) > 5) err('timing.pause_duration', `Pause of "${d.id}" lasts ${d.pause.durationMs}ms; the source asks for ${toMs(refClip.pauseAfterSeconds)}ms.`, loc);
      sumSpeech += d.speech.durationMs;
      sumPause += d.pause.durationMs;
    });
    for (const [id, n] of clipIds) if (n > 1) err('id.duplicate', `Audio clip ID "${id}" is used ${n} times.`, { clipId: id });

    /* ---- totals ---- */
    const refTotal = toMs(refVisual.totalDurationSeconds);
    if (!isInt(plan.totalDurationMs) || plan.totalDurationMs !== prevSceneEnd || plan.totalDurationMs !== refTotal) err('timing.total_invalid', `totalDurationMs ${plan.totalDurationMs} must equal the last scene end ${prevSceneEnd} and the estimated total ${refTotal}.`);
    if (plan.totalSpeechMs !== sumSpeech) err('timing.total_speech', `totalSpeechMs ${plan.totalSpeechMs} should be ${sumSpeech}.`);
    if (plan.totalPauseMs !== sumPause) err('timing.total_pause', `totalPauseMs ${plan.totalPauseMs} should be ${sumPause}.`);
    if (plan.totalTransitionMs !== sumTransition) err('timing.total_transition', `totalTransitionMs ${plan.totalTransitionMs} should be ${sumTransition}.`);
    if (plan.totalVisualOnlyMs !== sumVisualOnly) err('timing.total_visual_only', `totalVisualOnlyMs ${plan.totalVisualOnlyMs} should be ${sumVisualOnly}.`);
    if (plan.dialogueCount !== plan.dialogues.length || plan.dialogueCount !== srcTurns.length) err('plan.dialogue_count', `dialogueCount ${plan.dialogueCount} should be ${srcTurns.length}.`);

    for (const [id, n] of ids) if (n > 1) err('id.duplicate', `ID "${id}" is used ${n} times.`);

    return done();
  }
}
