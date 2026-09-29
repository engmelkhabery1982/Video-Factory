/**
 * BuildTrack Video Factory - Phase 5A Visual Production Pipeline (Phase 4 → Phase 5 Adapter)
 *
 * Deterministic adapter that converts approved Phase 4 output + Phase 3B visual plan into canonical visual production contract.
 *
 * Timing authority: Phase 4 actual reconciled timing.
 * No rendering, no Remotion, no image generation, no audio retiming.
 *
 * Visual timing mapping policy:
 *   Preserve relative position within scene.
 *   For each scene, compute original estimated scene interval [estStart, estEnd] duration estDur from Phase 3B visual plan.
 *   Compute actual scene interval [actStart, actEnd] duration actDur from Phase 4 reconciledDialogue.
 *   For each visual beat, compute relativeStart = (beat.estStart - scene.estStart) / scene.estDur, relativeEnd = (beat.estEnd - scene.estStart) / scene.estDur
 *   Then actual beat start = scene.actStart + relativeStart * scene.actDur, actual end = scene.actStart + relativeEnd * scene.actDur
 *   Clamp to scene actual interval, preserve order, ensure no negative duration, last beat ends exactly at scene actual end to avoid gaps.
 *   Visual cues within beat are similarly mapped relative to beat interval.
 *   This preserves beat identity, order, visual purpose, associated scene, intended relative placement.
 *   Does NOT invent visual content.
 */

import { Scenario } from './types.js';
import { ScenarioVisualPlan, ScenarioVisualScene, ScenarioVisualBeat, ScenarioVisualCue } from './visual-plan-types.js';
import { DialogueProductionResult } from './dialogue-production-types.js';
import {
  VisualProductionPlan,
  VisualProductionScene,
  VisualProductionBeat,
  VisualProductionCue,
  VisualProductionAudioRef,
  VisualProductionAssetRef,
  VisualProductionSummary,
  VisualProductionFinding,
  VisualProductionErrorCode,
  VISUAL_PRODUCTION_PLAN_VERSION,
  BuildVisualProductionResult,
} from './visual-production-types.js';
import { ReconciledCaptionCue } from './timing-reconciliation-types.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeFinding(
  severity: 'error' | 'warning',
  code: VisualProductionErrorCode,
  message: string,
  location?: VisualProductionFinding['location']
): VisualProductionFinding {
  return { severity, code, message, location };
}

function validateSafeAssetRef(assetRef: string): { valid: boolean; warning?: string } {
  if (!assetRef || typeof assetRef !== 'string') {
    return { valid: false, warning: 'assetRef must be non-empty string' };
  }
  const trimmed = assetRef.trim();
  if (!trimmed) {
    return { valid: false, warning: 'assetRef empty after trim' };
  }
  // Basic structural validation: should not contain unsafe path traversal or absolute
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    return { valid: false, warning: `assetRef absolute not allowed: '${trimmed}'` };
  }
  if (trimmed.includes('..')) {
    return { valid: false, warning: `assetRef contains traversal: '${trimmed}'` };
  }
  // Allow logical asset refs like 'asset:screen-insert:xyz' or relative paths
  return { valid: true };
}

/** Cross-phase identity validation */
function validateIdentities(inputs: {
  scenario: Scenario;
  visualPlan: ScenarioVisualPlan;
  dialogueResult: DialogueProductionResult;
}): VisualProductionFinding[] {
  const findings: VisualProductionFinding[] = [];
  const { scenario, visualPlan, dialogueResult } = inputs;
  const err = (code: VisualProductionErrorCode, msg: string, loc?: any) => {
    findings.push(makeFinding('error', code, msg, loc));
  };

  const scenarioId = scenario.metadata.id;

  if (visualPlan.scenarioId !== scenarioId) {
    err('PIPELINE_IDENTITY_MISMATCH', `visualPlan.scenarioId mismatch: expected '${scenarioId}', got '${visualPlan.scenarioId}'`, { scenarioId });
  }
  if (dialogueResult.scenarioId !== scenarioId) {
    err('PIPELINE_IDENTITY_MISMATCH', `dialogueResult.scenarioId mismatch: expected '${scenarioId}', got '${dialogueResult.scenarioId}'`, { scenarioId });
  }
  if (visualPlan.projectId !== scenario.metadata.projectId) {
    err('PIPELINE_IDENTITY_MISMATCH', `visualPlan.projectId mismatch`, { scenarioId });
  }
  if (dialogueResult.projectId !== scenario.metadata.projectId) {
    err('PIPELINE_IDENTITY_MISMATCH', `dialogueResult.projectId mismatch`, { scenarioId });
  }
  if (visualPlan.format.targetFormat !== scenario.metadata.targetFormat) {
    err('PIPELINE_IDENTITY_MISMATCH', `visualPlan targetFormat mismatch`, { scenarioId });
  }
  if (dialogueResult.targetFormat !== scenario.metadata.targetFormat) {
    err('PIPELINE_IDENTITY_MISMATCH', `dialogueResult targetFormat mismatch`, { scenarioId });
  }

  const scenarioSceneIds = scenario.scenes.map(s => s.id);
  const visualSceneIds = visualPlan.scenes.map(s => s.sourceSceneId);
  const dialogueSceneIds = dialogueResult.reconciledDialogue.scenes.map(s => s.sceneId);

  if (JSON.stringify(scenarioSceneIds) !== JSON.stringify(visualSceneIds)) {
    err('VISUAL_SCENE_MISMATCH', `Scene IDs/order mismatch scenario vs visualPlan: ${scenarioSceneIds.join(',')} vs ${visualSceneIds.join(',')}`, { scenarioId });
  }
  if (JSON.stringify(scenarioSceneIds) !== JSON.stringify(dialogueSceneIds)) {
    err('VISUAL_SCENE_MISMATCH', `Scene IDs/order mismatch scenario vs dialogueResult`, { scenarioId });
  }
  if (visualPlan.scenes.length !== dialogueResult.reconciledDialogue.scenes.length) {
    err('VISUAL_SCENE_MISMATCH', `Scene count mismatch visualPlan (${visualPlan.scenes.length}) vs dialogueResult (${dialogueResult.reconciledDialogue.scenes.length})`, { scenarioId });
  }

  // Turn IDs
  const scenarioTurnIds = scenario.scenes.flatMap(s => s.turns.map(t => t.id));
  const dialogueTurnIds = dialogueResult.dialoguePlan.clips.map(c => c.turnId);
  if (JSON.stringify(scenarioTurnIds) !== JSON.stringify(dialogueTurnIds)) {
    err('VISUAL_SCENE_MISMATCH', `Turn IDs/order mismatch scenario vs dialoguePlan`, { scenarioId });
  }

  return findings;
}

/** Final invariants */
function validateInvariants(plan: VisualProductionPlan): VisualProductionFinding[] {
  const findings: VisualProductionFinding[] = [];
  const err = (code: VisualProductionErrorCode, msg: string, loc?: any) => {
    findings.push(makeFinding('error', code, msg, loc));
  };

  // every scene exists in both visual and dialogue pipelines — already checked, but final gate
  if (plan.scenes.length === 0) {
    err('MISSING_SCENE', `Visual production plan must have at least one scene`);
  }

  // scene order matches — renderOrder should equal index and be deterministic
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i];
    if (scene.renderOrder !== scene.index || scene.index !== i) {
      err('VISUAL_SCENE_MISMATCH', `Scene renderOrder/index mismatch for scene '${scene.sceneId}': index ${scene.index}, renderOrder ${scene.renderOrder}, position ${i}`, { sceneId: scene.sceneId });
    }
  }

  // actual scene timing positive and monotonic, no overlap unless allowed
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i];
    if (scene.actualDurationSeconds <= 0) {
      err('INVALID_DURATION', `Scene '${scene.sceneId}' actual duration must be positive, got ${scene.actualDurationSeconds}`, { sceneId: scene.sceneId });
    }
    if (scene.actualStartSeconds < 0 || scene.actualEndSeconds <= scene.actualStartSeconds) {
      err('MISSING_ACTUAL_TIMING', `Scene '${scene.sceneId}' has invalid actual timing boundaries`, { sceneId: scene.sceneId });
    }
    if (i > 0) {
      const prev = plan.scenes[i - 1];
      if (prev.actualEndSeconds > scene.actualStartSeconds + 0.001) {
        err('OVERLAP_DETECTED', `Scene overlap between '${prev.sceneId}' and '${scene.sceneId}': prev ends ${prev.actualEndSeconds}, next starts ${scene.actualStartSeconds}`, { sceneId: scene.sceneId });
      }
    }
  }

  // visual beat order deterministic, every beat maps inside its scene interval
  for (const scene of plan.scenes) {
    // beat order
    for (let i = 0; i < scene.beats.length; i++) {
      const beat = scene.beats[i];
      if (beat.index !== i) {
        err('VISUAL_BEAT_MISMATCH', `Beat index mismatch in scene '${scene.sceneId}': expected ${i}, got ${beat.index}`, { sceneId: scene.sceneId, beatId: beat.id });
      }
      if (beat.sceneId !== scene.sourceSceneId && beat.sourceSceneId !== scene.sourceSceneId) {
        err('VISUAL_BEAT_MISMATCH', `Beat '${beat.id}' scene association mismatch`, { sceneId: scene.sceneId, beatId: beat.id });
      }
      // inside scene interval
      if (beat.actualStartSeconds < scene.actualStartSeconds - 0.001 || beat.actualEndSeconds > scene.actualEndSeconds + 0.001) {
        err('VISUAL_BEAT_MISMATCH', `Beat '${beat.id}' outside scene '${scene.sceneId}' interval [${scene.actualStartSeconds}, ${scene.actualEndSeconds}] got [${beat.actualStartSeconds}, ${beat.actualEndSeconds}]`, {
          sceneId: scene.sceneId,
          beatId: beat.id,
        });
      }
      if (beat.actualDurationSeconds <= 0) {
        err('INVALID_DURATION', `Beat '${beat.id}' actual duration must be positive`, { sceneId: scene.sceneId, beatId: beat.id });
      }
    }
    // beat order monotonic
    for (let i = 0; i < scene.beats.length - 1; i++) {
      const curr = scene.beats[i];
      const next = scene.beats[i + 1];
      if (curr.actualEndSeconds > next.actualStartSeconds + 0.001) {
        err('OVERLAP_DETECTED', `Beat overlap in scene '${scene.sceneId}' between '${curr.id}' and '${next.id}'`, { sceneId: scene.sceneId, beatId: curr.id });
      }
    }

    // every spoken turn maps to canonical audio
    for (const beat of scene.beats) {
      if (beat.kind === 'dialogue') {
        if (!beat.audioRef) {
          err('AUDIO_REFERENCE_MISMATCH', `Dialogue beat '${beat.id}' must have audioRef`, { sceneId: scene.sceneId, beatId: beat.id, turnId: beat.turnId ?? undefined });
        } else {
          // canonical path must exist (structurally, we don't check fs here, but must be non-empty and canonical)
          if (!beat.audioRef.canonicalPath || !beat.audioRef.canonicalPath.trim()) {
            err('AUDIO_REFERENCE_MISMATCH', `AudioRef canonicalPath missing for beat '${beat.id}'`, { sceneId: scene.sceneId, beatId: beat.id });
          }
          // actual duration must match
          if (beat.audioRef.actualDurationSeconds <= 0) {
            err('INVALID_DURATION', `AudioRef actual duration invalid for beat '${beat.id}'`, { sceneId: scene.sceneId, beatId: beat.id });
          }
        }
      }
    }

    // every caption maps to valid turn
    for (const cue of scene.captionCues) {
      if (!scene.turnIds.includes(cue.turnId)) {
        err('CAPTION_REFERENCE_MISMATCH', `Caption cue '${cue.id}' turnId '${cue.turnId}' not in scene '${scene.sceneId}' turnIds`, { sceneId: scene.sceneId, cueId: cue.id, turnId: cue.turnId });
      }
      // cue boundaries within actual speech interval — should already be validated in Phase 4, but final gate
      const audioRef = scene.audioRefs.find(a => a.turnId === cue.turnId);
      if (audioRef) {
        if (cue.startTimeSeconds < audioRef.actualStartSeconds - 0.001 || cue.endTimeSeconds > audioRef.actualEndSeconds + 0.001) {
          err('CAPTION_REFERENCE_MISMATCH', `Caption cue '${cue.id}' outside actual speech interval for turn '${cue.turnId}' in scene '${scene.sceneId}'`, {
            sceneId: scene.sceneId,
            cueId: cue.id,
            turnId: cue.turnId,
          });
        }
      }
    }

    // all referenced assets structurally valid
    for (const asset of scene.assetRefs) {
      if (!asset.assetRef || !asset.assetRef.trim()) {
        err('ASSET_REFERENCE_INVALID', `Asset reference empty in scene '${scene.sceneId}'`, { sceneId: scene.sceneId, assetRef: asset.assetRef });
      }
      const validation = validateSafeAssetRef(asset.assetRef);
      if (!validation.valid && asset.required) {
        err('ASSET_REFERENCE_INVALID', `Invalid required assetRef '${asset.assetRef}' in scene '${scene.sceneId}': ${validation.warning}`, {
          sceneId: scene.sceneId,
          assetRef: asset.assetRef,
        });
      }
    }
  }

  // total plan duration matches Phase 4 actual total duration
  if (plan.scenes.length > 0) {
    const lastScene = plan.scenes[plan.scenes.length - 1];
    if (Math.abs(lastScene.actualEndSeconds - plan.totalActualDurationSeconds) > 0.01) {
      err('VISUAL_PRODUCTION_INVARIANT_FAILED', `Total plan duration mismatch: last scene ends ${lastScene.actualEndSeconds}, plan total ${plan.totalActualDurationSeconds}`, {
        scenarioId: plan.scenarioId,
      });
    }
  }

  // no estimated timing overrides actual timing — check that actual timing is used
  // We ensure actualStart/End are from Phase 4, not estimated
  // This is enforced by construction, but we check that actual != estimated for at least one scene if Phase 4 delta non-zero? Not required, just check positive
  // Instead check that totalActual matches sum of actual scene durations (which are from Phase 4)
  const sumActual = plan.scenes.reduce((sum, s) => sum + s.actualDurationSeconds, 0);
  if (Math.abs(sumActual - plan.totalActualDurationSeconds) > 0.01) {
    err('VISUAL_PRODUCTION_INVARIANT_FAILED', `Total actual duration mismatch: sum scenes ${sumActual} vs plan total ${plan.totalActualDurationSeconds}`);
  }

  return findings;
}

function buildSummary(plan: Omit<VisualProductionPlan, 'summary' | 'findings' | 'valid'>, findings: VisualProductionFinding[]): VisualProductionSummary {
  const totalEstimated = plan.scenes.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);
  const totalActual = plan.totalActualDurationSeconds;
  const warnings = findings.filter(f => f.severity === 'warning').length;
  const hasError = findings.some(f => f.severity === 'error');

  return {
    scenarioId: plan.scenarioId,
    projectId: plan.projectId,
    language: plan.language,
    targetFormat: plan.targetFormat,
    sceneCount: plan.scenes.length,
    visualBeatCount: plan.scenes.reduce((sum, s) => sum + s.beats.length, 0),
    audioClipCount: plan.scenes.reduce((sum, s) => sum + s.audioRefs.length, 0),
    captionCueCount: plan.scenes.reduce((sum, s) => sum + s.captionCues.length, 0),
    assetReferenceCount: plan.scenes.reduce((sum, s) => sum + s.assetRefs.length, 0),
    totalActualDurationSeconds: round2(totalActual),
    totalEstimatedDurationSeconds: round2(totalEstimated),
    totalDeltaSeconds: round2(totalActual - totalEstimated),
    warningCount: warnings,
    status: hasError ? 'error' : warnings > 0 ? 'warning' : 'ok',
  };
}

/** Main adapter: DialogueProductionResult + VisualPlan + Scenario → VisualProductionPlan */
export function buildVisualProductionPlan(inputs: {
  scenario: Scenario;
  visualPlan: ScenarioVisualPlan;
  dialogueResult: DialogueProductionResult;
}): BuildVisualProductionResult {
  const { scenario, visualPlan, dialogueResult } = inputs;

  // Presence checks
  if (!scenario || !visualPlan || !dialogueResult) {
    const missing: string[] = [];
    if (!scenario) missing.push('scenario');
    if (!visualPlan) missing.push('visualPlan');
    if (!dialogueResult) missing.push('dialogueResult');
    return {
      success: false,
      error: `Missing phase outputs: ${missing.join(', ')}`,
      findings: missing.map(name => ({
        severity: 'error' as const,
        code: 'MISSING_PHASE_OUTPUT' as const,
        message: `Missing phase output: ${name}`,
      })),
    };
  }

  // Check actual timing exists before identity validation (which accesses reconciledDialogue)
  if (!dialogueResult.reconciledDialogue || !dialogueResult.reconciledDialogue.scenes || dialogueResult.reconciledDialogue.scenes.length === 0) {
    return {
      success: false,
      error: 'Missing actual timing from Phase 4',
      findings: [makeFinding('error', 'MISSING_ACTUAL_TIMING', 'Reconciled dialogue timing missing or empty', { scenarioId: scenario.metadata.id })],
    };
  }

  // Identity validation
  const identityFindings = validateIdentities({ scenario, visualPlan, dialogueResult });
  if (identityFindings.some(f => f.severity === 'error')) {
    return {
      success: false,
      error: `Identity validation failed: ${identityFindings.filter(f => f.severity === 'error').map(f => f.message).join('; ')}`,
      findings: identityFindings,
    };
  }

  const findings: VisualProductionFinding[] = [...identityFindings];
  const scenes: VisualProductionScene[] = [];

  // Map for quick lookup of reconciled scenes and clips
  const reconciledSceneById = new Map(dialogueResult.reconciledDialogue.scenes.map(s => [s.sceneId, s]));
  const reconciledClipsByTurnId = new Map(dialogueResult.reconciledDialogue.clips.map(c => [c.turnId, c]));
  const captionCuesBySceneId = new Map<string, ReconciledCaptionCue[]>();
  for (const cue of dialogueResult.reconciledCaptions.cues) {
    const arr = captionCuesBySceneId.get(cue.sceneId) ?? [];
    arr.push(cue);
    captionCuesBySceneId.set(cue.sceneId, arr);
  }
  const captionCuesByTurnId = new Map<string, ReconciledCaptionCue[]>();
  for (const cue of dialogueResult.reconciledCaptions.cues) {
    const arr = captionCuesByTurnId.get(cue.turnId) ?? [];
    arr.push(cue);
    captionCuesByTurnId.set(cue.turnId, arr);
  }

  for (let sIdx = 0; sIdx < visualPlan.scenes.length; sIdx++) {
    const vScene = visualPlan.scenes[sIdx];
    const rScene = reconciledSceneById.get(vScene.sourceSceneId);

    if (!rScene) {
      findings.push(makeFinding('error', 'MISSING_SCENE', `Missing reconciled scene for visual scene '${vScene.sourceSceneId}'`, { sceneId: vScene.sourceSceneId }));
      continue;
    }

    // Timing authority: actual from Phase 4
    const actualStart = rScene.actualStartTimeSeconds;
    const actualEnd = rScene.actualEndTimeSeconds;
    const actualDuration = rScene.actualDurationSeconds;

    const estimatedStart = vScene.startSeconds;
    const estimatedEnd = vScene.endSeconds;
    const estimatedDuration = vScene.durationSeconds;

    if (actualDuration <= 0) {
      findings.push(makeFinding('error', 'INVALID_DURATION', `Actual scene duration invalid for scene '${vScene.sourceSceneId}'`, { sceneId: vScene.sourceSceneId }));
    }

    // Audio refs for this scene
    const audioRefs: VisualProductionAudioRef[] = rScene.clips.map(clip => ({
      clipId: clip.clipId,
      turnId: clip.turnId,
      sceneId: clip.sceneId,
      sceneIndex: clip.sceneIndex,
      turnIndex: clip.turnIndex,
      globalTurnIndex: clip.globalTurnIndex,
      speakerId: clip.speakerId,
      voiceSlot: clip.voiceSlot,
      voiceProfileId: clip.voiceProfileId,
      spokenText: clip.spokenText,
      canonicalPath: clip.canonicalPath,
      sourcePath: clip.sourcePath,
      actualDurationSeconds: clip.actualDurationSeconds,
      actualStartSeconds: clip.actualStartTimeSeconds,
      actualEndSeconds: clip.actualEndTimeSeconds,
      actualTotalSpanSeconds: clip.actualTotalSpanSeconds,
      pauseAfterSeconds: clip.pauseAfterSeconds,
    }));

    // Caption cues for this scene
    const captionCues = (captionCuesBySceneId.get(vScene.sourceSceneId) ?? []).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    // Asset refs from visual plan sceneCues and beat cues
    const assetRefs: VisualProductionAssetRef[] = [];

    for (const sceneCue of vScene.sceneCues) {
      if (sceneCue.assetRef) {
        const validation = validateSafeAssetRef(sceneCue.assetRef);
        assetRefs.push({
          assetRef: sceneCue.assetRef,
          cueKind: sceneCue.kind,
          cueId: sceneCue.id,
          beatId: `scene-${vScene.id}-sceneCue`,
          sceneId: vScene.sourceSceneId,
          sourceField: sceneCue.source.field,
          required: false,
          warning: validation.valid ? undefined : validation.warning,
        });
        if (!validation.valid) {
          findings.push(
            makeFinding('warning', 'ASSET_REFERENCE_INVALID', `Optional assetRef invalid in scene '${vScene.sourceSceneId}': ${validation.warning}`, {
              sceneId: vScene.sourceSceneId,
              cueId: sceneCue.id,
              assetRef: sceneCue.assetRef,
            })
          );
        }
      }
    }

    // Beats adapted to actual timing — preserve relative position within scene
    const beats: VisualProductionBeat[] = [];
    const sceneEstDur = estimatedDuration > 0 ? estimatedDuration : 1; // avoid div by zero

    for (let bIdx = 0; bIdx < vScene.beats.length; bIdx++) {
      const vBeat = vScene.beats[bIdx];

      // Relative position preservation
      const relStart = (vBeat.startSeconds - estimatedStart) / sceneEstDur;
      const relEnd = (vBeat.endSeconds - estimatedStart) / sceneEstDur;

      // Clamp relative to [0,1]
      const clampedRelStart = Math.max(0, Math.min(1, relStart));
      const clampedRelEnd = Math.max(0, Math.min(1, relEnd));

      let actualBeatStart = round2(actualStart + clampedRelStart * actualDuration);
      let actualBeatEnd = round2(actualStart + clampedRelEnd * actualDuration);

      // For last beat, ensure it ends exactly at scene actual end to avoid gaps
      if (bIdx === vScene.beats.length - 1) {
        actualBeatEnd = round2(actualEnd);
      }

      // Ensure positive duration
      if (actualBeatEnd <= actualBeatStart) {
        actualBeatEnd = round2(actualBeatStart + 0.01);
      }

      // Audio ref for dialogue beats
      let audioRef: VisualProductionAudioRef | null = null;
      let captionCueIds: string[] = [];
      if (vBeat.kind === 'dialogue' && vBeat.turnId) {
        const clip = reconciledClipsByTurnId.get(vBeat.turnId);
        if (clip) {
          audioRef = {
            clipId: clip.clipId,
            turnId: clip.turnId,
            sceneId: clip.sceneId,
            sceneIndex: clip.sceneIndex,
            turnIndex: clip.turnIndex,
            globalTurnIndex: clip.globalTurnIndex,
            speakerId: clip.speakerId,
            voiceSlot: clip.voiceSlot,
            voiceProfileId: clip.voiceProfileId,
            spokenText: clip.spokenText,
            canonicalPath: clip.canonicalPath,
            sourcePath: clip.sourcePath,
            actualDurationSeconds: clip.actualDurationSeconds,
            actualStartSeconds: clip.actualStartTimeSeconds,
            actualEndSeconds: clip.actualEndTimeSeconds,
            actualTotalSpanSeconds: clip.actualTotalSpanSeconds,
            pauseAfterSeconds: clip.pauseAfterSeconds,
          };
          const cues = captionCuesByTurnId.get(vBeat.turnId) ?? [];
          captionCueIds = cues.map(c => c.id);
        } else {
          findings.push(
            makeFinding('error', 'AUDIO_REFERENCE_MISMATCH', `Missing reconciled clip for dialogue beat '${vBeat.id}' turn '${vBeat.turnId}'`, {
              sceneId: vScene.sourceSceneId,
              beatId: vBeat.id,
              turnId: vBeat.turnId,
            })
          );
        }
      }

      // Cues within beat adapted relative to beat
      const beatEstDur = vBeat.endSeconds - vBeat.startSeconds;
      const beatEstDurSafe = beatEstDur > 0 ? beatEstDur : 1;
      const beatActualDur = actualBeatEnd - actualBeatStart;

      const adaptedCues: VisualProductionCue[] = vBeat.cues.map(cue => {
        const cueRelStart = (cue.startSeconds - vBeat.startSeconds) / beatEstDurSafe;
        const cueRelEnd = (cue.endSeconds - vBeat.startSeconds) / beatEstDurSafe;
        const clampedCueRelStart = Math.max(0, Math.min(1, cueRelStart));
        const clampedCueRelEnd = Math.max(0, Math.min(1, cueRelEnd));
        const cueActualStart = round2(actualBeatStart + clampedCueRelStart * beatActualDur);
        const cueActualEnd = round2(actualBeatStart + clampedCueRelEnd * beatActualDur);

        // Asset ref handling
        if (cue.assetRef) {
          const validation = validateSafeAssetRef(cue.assetRef);
          assetRefs.push({
            assetRef: cue.assetRef,
            cueKind: cue.kind,
            cueId: cue.id,
            beatId: vBeat.id,
            sceneId: vScene.sourceSceneId,
            sourceField: cue.source.field,
            required: false,
            warning: validation.valid ? undefined : validation.warning,
          });
          if (!validation.valid) {
            findings.push(
              makeFinding('warning', 'ASSET_REFERENCE_INVALID', `Optional assetRef invalid in beat '${vBeat.id}' cue '${cue.id}': ${validation.warning}`, {
                sceneId: vScene.sourceSceneId,
                beatId: vBeat.id,
                cueId: cue.id,
                assetRef: cue.assetRef,
              })
            );
          }
        }

        return {
          id: cue.id,
          kind: cue.kind,
          text: cue.text,
          estimatedStartSeconds: cue.startSeconds,
          estimatedEndSeconds: cue.endSeconds,
          actualStartSeconds: cueActualStart,
          actualEndSeconds: cueActualEnd,
          actualDurationSeconds: round2(cueActualEnd - cueActualStart),
          source: {
            sceneId: cue.source.sceneId,
            field: cue.source.field,
            turnId: cue.source.turnId,
            evidenceId: cue.source.evidenceId,
            itemIndex: cue.source.itemIndex,
          },
          assetRef: cue.assetRef,
        };
      });

      beats.push({
        id: vBeat.id,
        sceneId: vBeat.sceneId,
        sourceSceneId: vScene.sourceSceneId,
        index: bIdx,
        kind: vBeat.kind as any,
        estimatedStartSeconds: vBeat.startSeconds,
        estimatedEndSeconds: vBeat.endSeconds,
        estimatedDurationSeconds: round2(vBeat.endSeconds - vBeat.startSeconds),
        actualStartSeconds: actualBeatStart,
        actualEndSeconds: actualBeatEnd,
        actualDurationSeconds: round2(actualBeatEnd - actualBeatStart),
        relativeStart: round2(clampedRelStart),
        relativeEnd: round2(clampedRelEnd),
        turnId: vBeat.turnId,
        activeSpeakerId: vBeat.activeSpeakerId,
        reactingCharacterId: vBeat.reactingCharacterId,
        spokenText: vBeat.spokenText,
        intent: vBeat.intent,
        delivery: vBeat.delivery,
        shot: {
          shotType: vBeat.shot.shotType,
          framing: vBeat.shot.framing,
          speakerFocus: vBeat.shot.speakerFocus,
          cameraMovement: vBeat.shot.cameraMovement,
          focusCharacterId: vBeat.shot.focusCharacterId,
        },
        evidenceIds: [...vBeat.evidenceIds],
        cues: adaptedCues,
        audioRef,
        captionCueIds,
      });
    }

    // Ensure beats are ordered and non-overlapping after adaptation (by construction they should be, but we adjust last beat)
    beats.sort((a, b) => a.actualStartSeconds - b.actualStartSeconds);
    // Fix any small overlaps due to rounding by ensuring monotonic
    for (let i = 0; i < beats.length - 1; i++) {
      const curr = beats[i];
      const next = beats[i + 1];
      if (curr.actualEndSeconds > next.actualStartSeconds) {
        // Adjust curr to end at next start
        curr.actualEndSeconds = round2(next.actualStartSeconds);
        curr.actualDurationSeconds = round2(curr.actualEndSeconds - curr.actualStartSeconds);
      }
    }
    // Last beat ends at scene actual end
    if (beats.length > 0) {
      const last = beats[beats.length - 1];
      if (Math.abs(last.actualEndSeconds - actualEnd) > 0.01) {
        last.actualEndSeconds = round2(actualEnd);
        last.actualDurationSeconds = round2(last.actualEndSeconds - last.actualStartSeconds);
      }
    }

    // Transition actual interval
    let transActualStart: number | null = null;
    let transActualEnd: number | null = null;
    let transActualDur: number | null = null;
    if (rScene.transitionSeconds > 0) {
      // Transition is at end of scene, after dialogue
      const dialogueBeats = beats.filter(b => b.kind === 'dialogue');
      const lastDialogueEnd = dialogueBeats.length > 0 ? dialogueBeats[dialogueBeats.length - 1].actualEndSeconds : actualStart;
      transActualStart = round2(lastDialogueEnd);
      transActualEnd = round2(actualEnd);
      transActualDur = round2(transActualEnd - transActualStart);
    }

    scenes.push({
      id: vScene.id,
      sourceSceneId: vScene.sourceSceneId,
      sceneId: vScene.sourceSceneId,
      index: sIdx,
      title: vScene.title,
      narrativePurpose: vScene.narrativePurpose,
      locationId: vScene.locationId,
      participantIds: [...vScene.participantIds],
      turnIds: [...vScene.turnIds],
      speakerIds: [...vScene.speakerIds],
      visualOnly: vScene.visualOnly,
      estimatedStartSeconds: estimatedStart,
      estimatedEndSeconds: estimatedEnd,
      estimatedDurationSeconds: estimatedDuration,
      actualStartSeconds: actualStart,
      actualEndSeconds: actualEnd,
      actualDurationSeconds: actualDuration,
      production: vScene.production,
      onScreenInfo: vScene.onScreenInfo,
      transition: {
        type: vScene.transitionOut.type,
        durationSeconds: vScene.transitionOut.durationSeconds,
        source: vScene.transitionOut.source,
        actualStartSeconds: transActualStart,
        actualEndSeconds: transActualEnd,
        actualDurationSeconds: transActualDur,
      },
      beats,
      audioRefs,
      captionCues,
      assetRefs,
      renderOrder: sIdx,
    });
  }

  const totalActual = dialogueResult.reconciledDialogue.actualTotalDurationSeconds;
  const totalEstimated = visualPlan.totalDurationSeconds;

  const partialPlan: Omit<VisualProductionPlan, 'summary' | 'findings' | 'valid'> = {
    planVersion: VISUAL_PRODUCTION_PLAN_VERSION,
    scenarioId: scenario.metadata.id,
    projectId: scenario.metadata.projectId,
    language: scenario.metadata.language,
    targetFormat: scenario.metadata.targetFormat,
    totalActualDurationSeconds: round2(totalActual),
    totalEstimatedDurationSeconds: round2(totalEstimated),
    totalDeltaSeconds: round2(totalActual - totalEstimated),
    scenes,
  };

  // Build summary and validate invariants
  const summary = buildSummary(partialPlan, findings);
  const invariantFindings = (() => {
    const tempPlan: VisualProductionPlan = {
      ...partialPlan,
      summary,
      findings,
      valid: true,
    };
    return validateInvariants(tempPlan);
  })();

  const allFindings = [...findings, ...invariantFindings];
  const finalSummary = buildSummary(partialPlan, allFindings);
  const hasError = allFindings.some(f => f.severity === 'error');

  const finalPlan: VisualProductionPlan = {
    ...partialPlan,
    summary: finalSummary,
    findings: allFindings,
    valid: !hasError,
  };

  if (hasError) {
    return {
      success: false,
      error: `Visual production invariants failed: ${allFindings.filter(f => f.severity === 'error').map(f => f.message).join('; ')}`,
      findings: allFindings,
      partialPlan: finalPlan,
    };
  }

  return {
    success: true,
    plan: finalPlan,
  };
}

/** Validate visual production plan (public API) */
export function validateVisualProductionPlan(plan: VisualProductionPlan): { valid: boolean; findings: VisualProductionFinding[] } {
  if (!plan || typeof plan !== 'object') {
    return {
      valid: false,
      findings: [makeFinding('error', 'MISSING_PHASE_OUTPUT', 'VisualProductionPlan must be non-null object')],
    };
  }

  const identityFindings: VisualProductionFinding[] = [];
  if (!plan.scenarioId || !plan.projectId) {
    identityFindings.push(makeFinding('error', 'PIPELINE_IDENTITY_MISMATCH', 'Missing scenarioId or projectId'));
  }

  const invariantFindings = validateInvariants(plan);
  const allFindings = [...identityFindings, ...invariantFindings, ...plan.findings];

  return {
    valid: !allFindings.some(f => f.severity === 'error'),
    findings: allFindings,
  };
}
