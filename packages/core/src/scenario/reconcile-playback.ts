/**
 * BuildTrack Video Factory - Phase 4D Playback Reconciliation
 *
 * Produces actual-timing-compatible ScenarioPlaybackPlan or reconciled equivalent.
 * Preserves existing playback contract if it can safely represent reconciled actual timings,
 * otherwise introduces smallest additive reconciled playback type.
 *
 * Reconciled playback must match actual audio boundaries.
 */

import { Scenario } from './types.js';
import { ScenarioVisualPlan } from './visual-plan-types.js';
import { ReconciledDialogueAudioPlan } from './timing-reconciliation-types.js';
import {
  ReconciledPlaybackPlan,
  ReconciledPlaybackDialogue,
  ReconciledPlaybackScene,
  ReconciledPlaybackInterval,
  TimingReconciliationError,
} from './timing-reconciliation-types.js';
import { ScenarioPlaybackPlan } from './scenario-playback-types.js';

function toMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

function interval(startMs: number, endMs: number): ReconciledPlaybackInterval {
  return {
    startMs,
    endMs,
    durationMs: endMs - startMs,
  };
}

/** Validate visual plan matches reconciled dialogue plan in scene/turn identity */
function validateVisualMatchesReconciled(
  visual: ScenarioVisualPlan,
  reconciled: ReconciledDialogueAudioPlan
): void {
  const vSceneIds = visual.scenes.map(s => s.sourceSceneId);
  const rSceneIds = reconciled.scenes.map(s => s.sceneId);
  if (JSON.stringify(vSceneIds) !== JSON.stringify(rSceneIds)) {
    throw new TimingReconciliationError('SCENE_MISMATCH', `Visual scenes [${vSceneIds.join(',')}] vs reconciled [${rSceneIds.join(',')}] mismatch`, {
      vSceneIds,
      rSceneIds,
    });
  }

  for (let i = 0; i < visual.scenes.length; i++) {
    const vScene = visual.scenes[i];
    const rScene = reconciled.scenes[i];
    const vTurnIds = vScene.turnIds;
    const rTurnIds = rScene.clips.map(c => c.turnId);
    if (JSON.stringify(vTurnIds) !== JSON.stringify(rTurnIds)) {
      throw new TimingReconciliationError('TURN_MISMATCH', `Scene '${vScene.sourceSceneId}' turn IDs mismatch: visual [${vTurnIds.join(',')}] vs reconciled [${rTurnIds.join(',')}]`, {
        sceneId: vScene.sourceSceneId,
      });
    }
  }
}

/**
 * Reconcile playback timing from actual dialogue timing
 * Preserves visual beats but retimes them to match actual audio
 */
export function reconcilePlaybackTiming(
  scenario: Scenario,
  visualPlan: ScenarioVisualPlan,
  reconciledDialogue: ReconciledDialogueAudioPlan
): ReconciledPlaybackPlan {
  if (!scenario || typeof scenario !== 'object') {
    throw new TimingReconciliationError('MISSING_SCENARIO', 'Scenario must be non-null object.', {});
  }
  if (!visualPlan || typeof visualPlan !== 'object') {
    throw new TimingReconciliationError('MISSING_DIALOGUE_PLAN', 'Visual plan must be non-null object.', {});
  }
  if (!reconciledDialogue || typeof reconciledDialogue !== 'object') {
    throw new TimingReconciliationError('MISSING_CANONICAL_MANIFEST', 'Reconciled dialogue plan must be non-null object.', {});
  }

  validateVisualMatchesReconciled(visualPlan, reconciledDialogue);

  const dialogues: ReconciledPlaybackDialogue[] = [];
  const scenes: ReconciledPlaybackScene[] = [];

  let totalSpeechMs = 0;
  let totalPauseMs = 0;
  let totalTransitionMs = 0;
  let totalVisualOnlyMs = 0;

  for (let sIdx = 0; sIdx < visualPlan.scenes.length; sIdx++) {
    const vScene = visualPlan.scenes[sIdx];
    const rScene = reconciledDialogue.scenes[sIdx];

    const sceneStartMs = toMs(rScene.actualStartTimeSeconds);
    const sceneEndMs = toMs(rScene.actualEndTimeSeconds);
    const sceneInterval = interval(sceneStartMs, sceneEndMs);

    let dialogueStartMs: number | null = null;
    let dialogueEndMs: number | null = null;

    const beats: ReconciledPlaybackScene['beats'] = [];
    const dialogueIds: string[] = [];

    // Map reconciled clips by turnId for quick lookup
    const clipByTurnId = new Map(rScene.clips.map(c => [c.turnId, c]));

    for (let bIdx = 0; bIdx < vScene.beats.length; bIdx++) {
      const vBeat = vScene.beats[bIdx];
      let beatInterval: ReconciledPlaybackInterval;

      if (vBeat.kind === 'dialogue') {
        const turnId = vBeat.turnId!;
        const rClip = clipByTurnId.get(turnId);
        if (!rClip) {
          throw new TimingReconciliationError('MISSING_CANONICAL_CLIP', `Missing reconciled clip for turn '${turnId}' in scene '${vScene.sourceSceneId}'`, {
            turnId,
            sceneId: vScene.sourceSceneId,
          });
        }

        const speechStartMs = toMs(rClip.actualStartTimeSeconds);
        const speechEndMs = toMs(rClip.actualEndTimeSeconds);
        const turnEndMs = toMs(rClip.actualStartTimeSeconds + rClip.actualTotalSpanSeconds);

        beatInterval = interval(speechStartMs, turnEndMs);

        const dialogueId = vBeat.id; // preserve visual beat ID as dialogue ID

        const speechInterval = interval(speechStartMs, speechEndMs);
        const pauseInterval = interval(speechEndMs, turnEndMs);
        const turnSpanInterval = interval(speechStartMs, turnEndMs);

        const entry: ReconciledPlaybackDialogue = {
          id: dialogueId,
          globalIndex: dialogues.length,
          sceneId: vScene.sourceSceneId,
          sceneIndex: sIdx,
          turnId: rClip.turnId,
          turnIndex: rClip.turnIndex,
          visualBeatId: vBeat.id,
          audioClipId: rClip.clipId,
          speakerId: rClip.speakerId,
          reactingCharacterId: vBeat.reactingCharacterId ?? null,
          voiceSlot: rClip.voiceSlot,
          voiceProfileId: rClip.voiceProfileId,
          spokenText: rClip.spokenText,
          intent: rClip.intent,
          delivery: rClip.delivery ?? null,
          evidenceIds: [...vBeat.evidenceIds],
          suggestedAudioPath: rClip.estimatedPath,
          canonicalAudioPath: rClip.canonicalPath,
          speech: speechInterval,
          pause: pauseInterval,
          turnSpan: turnSpanInterval,
          actualDurationSeconds: rClip.actualDurationSeconds,
          estimatedDurationSeconds: rClip.estimatedDurationSeconds,
        };

        totalSpeechMs += speechInterval.durationMs;
        totalPauseMs += pauseInterval.durationMs;

        dialogues.push(entry);
        dialogueIds.push(entry.id);
        beats.push({
          id: vBeat.id,
          index: bIdx,
          kind: vBeat.kind,
          interval: beatInterval,
          dialogueId: entry.id,
        });

        dialogueStartMs ??= beatInterval.startMs;
        dialogueEndMs = beatInterval.endMs;
      } else if (vBeat.kind === 'transition') {
        // Transition interval: from end of last dialogue beat to scene end, preserving transitionSeconds from reconciled scene
        const transitionDurationMs = toMs(rScene.transitionSeconds);
        const transStartMs = dialogueEndMs ?? sceneStartMs;
        const transEndMs = transStartMs + transitionDurationMs;
        beatInterval = interval(transStartMs, transEndMs);
        totalTransitionMs += beatInterval.durationMs;
        beats.push({
          id: vBeat.id,
          index: bIdx,
          kind: vBeat.kind,
          interval: beatInterval,
          dialogueId: null,
        });
      } else {
        // visual_only
        const visualOnlyDurationMs = toMs(rScene.visualOnlySeconds);
        const voStartMs = dialogueEndMs ?? sceneStartMs;
        const voEndMs = voStartMs + visualOnlyDurationMs;
        beatInterval = interval(voStartMs, voEndMs);
        totalVisualOnlyMs += beatInterval.durationMs;
        beats.push({
          id: vBeat.id,
          index: bIdx,
          kind: vBeat.kind,
          interval: beatInterval,
          dialogueId: null,
        });
      }
    }

    // Ensure last beat ends at sceneEndMs (absorb rounding)
    if (beats.length > 0) {
      const lastBeat = beats[beats.length - 1];
      if (lastBeat.interval.endMs !== sceneEndMs) {
        // Adjust last beat to end at scene end for exact tiling
        lastBeat.interval = interval(lastBeat.interval.startMs, sceneEndMs);
        // Recalculate duration
        lastBeat.interval.durationMs = sceneEndMs - lastBeat.interval.startMs;
      }
    }

    const dialogueSpan = dialogueStartMs !== null && dialogueEndMs !== null ? interval(dialogueStartMs, dialogueEndMs) : null;

    scenes.push({
      id: vScene.id,
      sourceSceneId: vScene.sourceSceneId,
      index: sIdx,
      title: vScene.title,
      interval: sceneInterval,
      dialogueSpan,
      transition: {
        type: vScene.transitionOut.type,
        source: vScene.transitionOut.source,
        interval: rScene.transitionSeconds > 0 ? interval((dialogueEndMs ?? sceneStartMs), sceneEndMs) : null,
      },
      beats,
      dialogueIds,
      estimatedDurationMs: toMs(rScene.estimatedDurationSeconds),
      actualDurationMs: toMs(rScene.actualDurationSeconds),
    });
  }

  const actualTotalDurationMs = scenes.length > 0 ? scenes[scenes.length - 1].interval.endMs : 0;
  const estimatedTotalDurationMs = visualPlan.totalDurationSeconds * 1000;

  // Check for overlaps
  for (let i = 0; i < dialogues.length - 1; i++) {
    const curr = dialogues[i];
    const next = dialogues[i + 1];
    if (curr.turnSpan.endMs > next.turnSpan.startMs) {
      throw new TimingReconciliationError('OVERLAP_DETECTED', `Overlap between dialogues '${curr.id}' and '${next.id}': curr ends ${curr.turnSpan.endMs}ms, next starts ${next.turnSpan.startMs}ms`, {
        currId: curr.id,
        nextId: next.id,
      });
    }
  }

  return {
    playbackVersion: '1.0.0-reconciled',
    scenarioId: scenario.metadata.id,
    projectId: scenario.metadata.projectId,
    language: scenario.metadata.language,
    targetFormat: scenario.metadata.targetFormat,
    audioFormat: reconciledDialogue.audioFormat,
    durationConfig: reconciledDialogue.durationConfig,
    allowSharedVoiceSlots: reconciledDialogue.allowSharedVoiceSlots,
    audioBasePath: 'audio/dialogue',
    canonicalBasePath: 'audio/canonical',
    estimatedTotalDurationMs,
    actualTotalDurationMs,
    totalSpeechMs,
    totalPauseMs,
    totalTransitionMs,
    totalVisualOnlyMs,
    dialogueCount: dialogues.length,
    scenes,
    dialogues,
  };
}

/** Convert reconciled playback to standard ScenarioPlaybackPlan shape for compatibility (optional) */
export function toScenarioPlaybackPlan(reconciled: ReconciledPlaybackPlan, visualPlan: ScenarioVisualPlan): ScenarioPlaybackPlan {
  // Map reconciled playback to standard playback plan structure, preserving actual timings
  // This is additive and does not break Phase 3D APIs — it produces a plan that would pass validation if visual plan were also reconciled
  // For simplicity, we construct a plan with actual timings

  const scenes = reconciled.scenes.map(rs => {
    const vScene = visualPlan.scenes.find(vs => vs.sourceSceneId === rs.sourceSceneId)!;
    return {
      id: rs.id,
      sourceSceneId: rs.sourceSceneId,
      index: rs.index,
      title: rs.title,
      narrativePurpose: vScene.narrativePurpose,
      locationId: vScene.locationId,
      participantIds: [...vScene.participantIds],
      visualOnly: vScene.visualOnly,
      interval: {
        startMs: rs.interval.startMs,
        endMs: rs.interval.endMs,
        durationMs: rs.interval.durationMs,
      },
      dialogueSpan: rs.dialogueSpan ? { startMs: rs.dialogueSpan.startMs, endMs: rs.dialogueSpan.endMs, durationMs: rs.dialogueSpan.durationMs } : null,
      transition: {
        type: vScene.transitionOut.type as any,
        source: vScene.transitionOut.source as any,
        interval: rs.transition.interval ? { startMs: rs.transition.interval.startMs, endMs: rs.transition.interval.endMs, durationMs: rs.transition.interval.durationMs } : null,
      },
      production: vScene.production,
      onScreenInfo: vScene.onScreenInfo,
      evidence: [...vScene.evidence],
      sceneCues: [...vScene.sceneCues].map(c => ({
        ...c,
        interval: {
          startMs: Math.round(c.startSeconds * 1000),
          endMs: Math.round(c.endSeconds * 1000),
          durationMs: Math.round((c.endSeconds - c.startSeconds) * 1000),
        },
      })),
      beats: rs.beats.map((rb, idx) => {
        const vBeat = vScene.beats[idx];
        return {
          id: rb.id,
          index: rb.index,
          kind: vBeat.kind as any,
          interval: { startMs: rb.interval.startMs, endMs: rb.interval.endMs, durationMs: rb.interval.durationMs },
          dialogueId: rb.dialogueId,
          activeSpeakerId: vBeat.activeSpeakerId,
          reactingCharacterId: vBeat.reactingCharacterId,
          shot: vBeat.shot,
          evidenceIds: [...vBeat.evidenceIds],
          cues: [...vBeat.cues].map(c => ({
            ...c,
            interval: {
              startMs: Math.round(c.startSeconds * 1000),
              endMs: Math.round(c.endSeconds * 1000),
              durationMs: Math.round((c.endSeconds - c.startSeconds) * 1000),
            },
          })),
        };
      }),
      dialogueIds: [...rs.dialogueIds],
    };
  });

  const dialogues = reconciled.dialogues.map(rd => ({
    id: rd.id,
    globalIndex: rd.globalIndex,
    sceneId: rd.sceneId,
    sceneIndex: rd.sceneIndex,
    turnId: rd.turnId,
    turnIndex: rd.turnIndex,
    visualBeatId: rd.visualBeatId,
    audioClipId: rd.audioClipId,
    speakerId: rd.speakerId,
    reactingCharacterId: rd.reactingCharacterId,
    voiceSlot: rd.voiceSlot,
    spokenText: rd.spokenText,
    intent: rd.intent,
    delivery: rd.delivery,
    evidenceIds: [...rd.evidenceIds],
    suggestedAudioPath: rd.suggestedAudioPath,
    speech: { startMs: rd.speech.startMs, endMs: rd.speech.endMs, durationMs: rd.speech.durationMs },
    pause: { startMs: rd.pause.startMs, endMs: rd.pause.endMs, durationMs: rd.pause.durationMs },
    turnSpan: { startMs: rd.turnSpan.startMs, endMs: rd.turnSpan.endMs, durationMs: rd.turnSpan.durationMs },
  }));

  return {
    playbackVersion: '1.0.0' as any,
    scenarioId: reconciled.scenarioId,
    projectId: reconciled.projectId,
    language: reconciled.language,
    targetFormat: reconciled.targetFormat,
    schemaVersions: {
      scenario: '1.0.0',
      visualPlan: '1.0.0',
      audioPlan: '1.0.0',
    },
    durationConfig: reconciled.durationConfig,
    allowSharedVoiceSlots: reconciled.allowSharedVoiceSlots,
    audioBasePath: reconciled.audioBasePath,
    format: visualPlan.format,
    audioFormat: reconciled.audioFormat,
    totalDurationMs: reconciled.actualTotalDurationMs,
    totalSpeechMs: reconciled.totalSpeechMs,
    totalPauseMs: reconciled.totalPauseMs,
    totalTransitionMs: reconciled.totalTransitionMs,
    totalVisualOnlyMs: reconciled.totalVisualOnlyMs,
    dialogueCount: reconciled.dialogueCount,
    characters: visualPlan.scenes.flatMap(s => s.beats.filter(b => b.kind === 'dialogue').map(b => b.activeSpeakerId)).filter((v, i, a) => v && a.indexOf(v) === i).map(id => ({ characterId: id!, voiceSlot: '', turnCount: 0 })) as any,
    scenes: scenes as any,
    dialogues: dialogues as any,
    warnings: [],
  };
}
