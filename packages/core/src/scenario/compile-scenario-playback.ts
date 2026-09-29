/**
 * BuildTrack Video Factory - Phase 3D Unified Scenario Playback compiler
 *
 * compileScenarioPlayback(scenario, options) runs the Phase 3B visual compiler
 * and the Phase 3C dialogue audio planner with ONE shared duration
 * configuration, checks that both plans agree with each other and with the
 * source, and joins them into a single integer-millisecond timeline.
 *
 * Pure: no I/O, no clocks, no randomness, no mutation of the input.
 * Never throws for malformed input: failures become `{ ok: false, errors }`.
 */

import type { Scenario } from './types.js';
import type { DurationEstimatorConfig } from './duration.js';
import { compileScenarioVisualPlan } from './compile-visual-plan.js';
import { validateScenarioVisualPlan } from './validate-visual-plan.js';
import { planDialogueAudio } from './plan-dialogue-audio.js';
import { validateDialogueAudioPlan } from './validate-dialogue-audio-plan.js';
import type { DialogueAudioClip, DialogueAudioPlan } from './dialogue-audio-types.js';
import type { ScenarioVisualPlan } from './visual-plan-types.js';
import {
  SCENARIO_PLAYBACK_PLAN_VERSION,
  type CompileScenarioPlaybackResult,
  type ScenarioPlaybackBeat,
  type ScenarioPlaybackDialogue,
  type ScenarioPlaybackFinding,
  type ScenarioPlaybackInterval,
  type ScenarioPlaybackOptions,
  type ScenarioPlaybackPlan,
  type ScenarioPlaybackScene,
} from './scenario-playback-types.js';
import { interval, resolvePlaybackDurationConfig, toMs, toPlaybackCue, validateScenarioPlaybackPlan } from './validate-scenario-playback.js';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const playbackCue = toPlaybackCue;

const fail = (ruleId: string, message: string, stage: ScenarioPlaybackFinding['stage'], location: ScenarioPlaybackFinding['location'] = {}): ScenarioPlaybackFinding => ({ severity: 'error', ruleId, message, stage, location });

/**
 * Join an already-compiled visual plan and audio plan. Exported for the
 * validator's reference path and for tests; normal callers use
 * compileScenarioPlayback. Returns join errors instead of throwing.
 */
export function joinScenarioPlayback(
  visual: ScenarioVisualPlan,
  audio: DialogueAudioPlan,
  config: DurationEstimatorConfig,
  scenarioSchemaVersion: string,
  audioBasePath = 'audio/dialogue',
): { plan: ScenarioPlaybackPlan | null; errors: ScenarioPlaybackFinding[] } {
  const errors: ScenarioPlaybackFinding[] = [];
  if (JSON.stringify(audio.durationConfig) !== JSON.stringify(config)) {
    errors.push(fail('playback.duration_config_mismatch', 'The audio plan was produced with a different duration configuration.', 'audio'));
  }

  // index audio clips by turn, detecting clips that have no visual beat
  const clipByTurn = new Map<string, DialogueAudioClip>();
  for (const clip of audio.clips) {
    if (clipByTurn.has(clip.turnId)) errors.push(fail('playback.clip_duplicate', `Turn "${clip.turnId}" has more than one audio clip.`, 'audio', { turnId: clip.turnId, clipId: clip.clipId }));
    clipByTurn.set(clip.turnId, clip);
  }
  const usedClips = new Set<string>();

  const scenes: ScenarioPlaybackScene[] = [];
  const dialogues: ScenarioPlaybackDialogue[] = [];
  let totalSpeechMs = 0;
  let totalPauseMs = 0;
  let totalTransitionMs = 0;
  let totalVisualOnlyMs = 0;

  visual.scenes.forEach((vs) => {
    const beats: ScenarioPlaybackBeat[] = [];
    const dialogueIds: string[] = [];
    let transitionInterval: ScenarioPlaybackInterval | null = null;
    let dStart: number | null = null;
    let dEnd: number | null = null;

    vs.beats.forEach((b, bi) => {
      const bIv = interval(toMs(b.startSeconds), toMs(b.endSeconds));
      let dialogueId: string | null = null;
      if (b.kind === 'dialogue') {
        const clip = b.turnId ? clipByTurn.get(b.turnId) : undefined;
        if (!clip || clip.sceneId !== vs.sourceSceneId) {
          errors.push(fail('playback.beat_without_clip', `Visual beat "${b.id}" has no matching audio clip.`, 'playback', { sceneId: vs.sourceSceneId, beatId: b.id, turnId: b.turnId ?? undefined }));
        } else {
          usedClips.add(clip.clipId);
          const speechMs = toMs(clip.durationSeconds);
          const clipStart = toMs(clip.startTimeSeconds);
          if (Math.abs(clipStart - bIv.startMs) > 1 || Math.abs(toMs(clip.totalSpanSeconds) - bIv.durationMs) > 1 || Math.abs(toMs(b.speechSeconds) - speechMs) > 1) {
            errors.push(fail('playback.timing_disagreement', `Audio clip "${clip.clipId}" (${clip.startTimeSeconds}s + ${clip.totalSpanSeconds}s) disagrees with visual beat "${b.id}" (${b.startSeconds}-${b.endSeconds}s).`, 'playback', { sceneId: vs.sourceSceneId, beatId: b.id, clipId: clip.clipId }));
          }
          const speech = interval(bIv.startMs, bIv.startMs + speechMs);
          const entry: ScenarioPlaybackDialogue = {
            id: b.id,
            globalIndex: dialogues.length,
            sceneId: vs.sourceSceneId,
            sceneIndex: vs.index,
            turnId: clip.turnId,
            turnIndex: clip.turnIndex,
            visualBeatId: b.id,
            audioClipId: clip.clipId,
            speakerId: clip.speakerId,
            reactingCharacterId: b.reactingCharacterId,
            voiceSlot: clip.voiceSlot,
            spokenText: clip.spokenText,
            intent: clip.intent,
            delivery: clip.delivery ? clone(clip.delivery) : null,
            evidenceIds: [...b.evidenceIds],
            suggestedAudioPath: clip.suggestedPath,
            speech,
            pause: interval(speech.endMs, bIv.endMs),
            turnSpan: bIv,
          };
          // the two planners must say the same thing about the turn
          if (b.activeSpeakerId !== clip.speakerId || b.spokenText !== clip.spokenText || b.intent !== clip.intent || JSON.stringify(b.delivery) !== JSON.stringify(clip.delivery ?? null) || JSON.stringify(b.evidenceIds) !== JSON.stringify(clip.evidenceId ? [clip.evidenceId] : [])) {
            errors.push(fail('playback.plan_disagreement', `Visual beat "${b.id}" and audio clip "${clip.clipId}" disagree on speaker, text, intent, delivery or evidence.`, 'playback', { beatId: b.id, clipId: clip.clipId }));
          }
          totalSpeechMs += entry.speech.durationMs;
          totalPauseMs += entry.pause.durationMs;
          dialogues.push(entry);
          dialogueIds.push(entry.id);
          dialogueId = entry.id;
          dStart ??= bIv.startMs;
          dEnd = bIv.endMs;
        }
      } else if (b.kind === 'transition') {
        transitionInterval = bIv;
        totalTransitionMs += bIv.durationMs;
      } else {
        totalVisualOnlyMs += bIv.durationMs;
      }
      beats.push({
        id: b.id,
        index: bi,
        kind: b.kind,
        interval: bIv,
        dialogueId,
        activeSpeakerId: b.activeSpeakerId,
        reactingCharacterId: b.reactingCharacterId,
        shot: clone(b.shot),
        evidenceIds: [...b.evidenceIds],
        cues: b.cues.map(playbackCue),
      });
    });

    scenes.push({
      id: vs.id,
      sourceSceneId: vs.sourceSceneId,
      index: vs.index,
      title: vs.title,
      narrativePurpose: vs.narrativePurpose,
      locationId: vs.locationId,
      participantIds: [...vs.participantIds],
      visualOnly: vs.visualOnly,
      interval: interval(toMs(vs.startSeconds), toMs(vs.endSeconds)),
      dialogueSpan: dStart === null || dEnd === null ? null : interval(dStart, dEnd),
      transition: { type: vs.transitionOut.type, source: vs.transitionOut.source, interval: transitionInterval },
      production: clone(vs.production),
      onScreenInfo: vs.onScreenInfo ? clone(vs.onScreenInfo) : null,
      evidence: clone(vs.evidence),
      sceneCues: vs.sceneCues.map(playbackCue),
      beats,
      dialogueIds,
    });
  });

  for (const clip of audio.clips) {
    if (!usedClips.has(clip.clipId)) errors.push(fail('playback.clip_without_beat', `Audio clip "${clip.clipId}" has no matching visual dialogue beat.`, 'playback', { turnId: clip.turnId, clipId: clip.clipId }));
  }
  const totalDurationMs = scenes.length ? scenes[scenes.length - 1].interval.endMs : 0;
  if (Math.abs(toMs(audio.totalDurationSeconds) - totalDurationMs) > 1) {
    errors.push(fail('playback.total_disagreement', `Audio total ${audio.totalDurationSeconds}s disagrees with visual total ${totalDurationMs / 1000}s.`, 'playback'));
  }
  if (errors.length) return { plan: null, errors };

  const plan: ScenarioPlaybackPlan = {
    playbackVersion: SCENARIO_PLAYBACK_PLAN_VERSION,
    scenarioId: visual.scenarioId,
    projectId: visual.projectId,
    language: visual.language,
    targetFormat: visual.format.targetFormat,
    schemaVersions: { scenario: scenarioSchemaVersion, visualPlan: visual.planVersion, audioPlan: audio.schemaVersion },
    durationConfig: { ...config },
    allowSharedVoiceSlots: audio.allowSharedVoiceSlots,
    audioBasePath,
    format: clone(visual.format),
    audioFormat: clone(audio.audioFormat),
    totalDurationMs,
    totalSpeechMs,
    totalPauseMs,
    totalTransitionMs,
    totalVisualOnlyMs,
    dialogueCount: dialogues.length,
    characters: audio.characters.map((c) => ({ characterId: c.characterId, voiceSlot: c.voiceSlot, turnCount: c.turnCount })),
    scenes,
    dialogues,
    warnings: [...visual.findings, ...visual.diversity.warnings]
      .filter((f) => f.severity === 'warning')
      .map((f) => ({ severity: 'warning' as const, ruleId: f.ruleId, message: f.message, stage: 'visual' as const, location: clone(f.location) })),
  };
  return { plan, errors: [] };
}

/**
 * Compile a canonical Scenario into one authoritative playback manifest.
 */
export function compileScenarioPlayback(scenario: Scenario, options: ScenarioPlaybackOptions = {}): CompileScenarioPlaybackResult {
  const refuse = (errors: ScenarioPlaybackFinding[], sourceWarnings: ScenarioPlaybackFinding[] = []): CompileScenarioPlaybackResult => ({ ok: false, plan: null, errors, sourceWarnings });
  try {
    const resolved = resolvePlaybackDurationConfig(options?.durationConfig);
    if ('error' in resolved) return refuse([fail('playback.duration_config_invalid', resolved.error, 'playback')]);
    const config = resolved.config;

    // Phase 3B (also validates the source and refuses structurally)
    const visualResult = compileScenarioVisualPlan(scenario, config);
    const toFinding = (stage: ScenarioPlaybackFinding['stage']) => (f: { severity: 'error' | 'warning'; ruleId: string; message: string; location?: object }): ScenarioPlaybackFinding => ({
      severity: f.severity,
      ruleId: f.ruleId,
      message: f.message,
      stage,
      location: clone((f.location ?? {}) as ScenarioPlaybackFinding['location']),
    });
    const sourceWarnings = visualResult.sourceWarnings.map(toFinding('source'));
    if (!visualResult.ok) return refuse(visualResult.errors.map(toFinding('source')), sourceWarnings);
    const visual = visualResult.plan;

    // Phase 3C with the very same configuration
    let audio: DialogueAudioPlan;
    try {
      audio = planDialogueAudio(scenario, {
        durationConfig: { ...config },
        allowSharedVoiceSlots: options.allowSharedVoiceSlots === true,
        ...(options.audioBasePath !== undefined ? { basePath: options.audioBasePath } : {}),
      });
    } catch (e) {
      return refuse([fail('playback.audio_plan_refused', `Dialogue audio planner refused the scenario: ${e instanceof Error ? e.message : String(e)}`, 'audio')], sourceWarnings);
    }

    // both sub-plans must be valid against the source before joining
    const vReport = validateScenarioVisualPlan(visual, scenario);
    const aReport = validateDialogueAudioPlan(audio, scenario);
    const subErrors = [
      ...vReport.findings.filter((f) => f.severity === 'error').map(toFinding('visual')),
      ...aReport.findings.filter((f) => f.severity === 'error').map(toFinding('audio')),
    ];
    if (subErrors.length) return refuse(subErrors, sourceWarnings);

    const joined = joinScenarioPlayback(visual, audio, config, scenario.metadata.schemaVersion, options.audioBasePath ?? 'audio/dialogue');
    if (!joined.plan) return refuse(joined.errors, sourceWarnings);

    // final gate: the manifest must validate against the original scenario
    const report = validateScenarioPlaybackPlan(joined.plan, scenario);
    const finalErrors = report.findings.filter((f) => f.severity === 'error');
    if (finalErrors.length) return refuse(finalErrors, sourceWarnings);
    return { ok: true, plan: joined.plan, sourceWarnings };
  } catch (e) {
    return refuse([fail('playback.source_unreadable', `Scenario could not be compiled: ${e instanceof Error ? e.message : String(e)}`, 'source')]);
  }
}
