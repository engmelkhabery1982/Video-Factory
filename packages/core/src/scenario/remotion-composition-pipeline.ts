/**
 * BuildTrack Video Factory - Phase 5C Remotion Composition Pipeline
 *
 * Deterministic adapter SceneRenderPlan → RemotionCompositionPlan
 * Maps actual Phase 4 timing to Remotion frame ranges, resolves renderer keys,
 * wires beats, assets, audio, captions, transitions.
 *
 * Time→Frame Policy (documented):
 *   fps = 30 (matches packages/video/src/brand/theme.ts FPS)
 *   Authoritative seconds timing remains unchanged (Phase 4 actual).
 *   Internal absolute boundaries: startFrame = Math.round(actualStartSeconds * fps) // absolute, avoids drift
 *   Internal absolute boundaries: endFrame = Math.round(actualEndSeconds * fps) // absolute
 *   Duration: durationInFrames = endFrame - startFrame (derived from absolute boundaries, not independently rounded)
 *   Final composition boundary: totalDurationInFrames = Math.ceil(totalActualDurationSeconds * fps) // ceil to prevent truncation of authoritative audio timeline
 *   For canonical fixture 118.74s *30 = 3562.2 raw → ceil = 3563 frames, render capacity = 3563/30=118.766...s, extra partial-frame coverage prevents truncation, authoritative seconds still 118.74s
 *   For last scene, endFrame forced to totalDurationInFrames to guarantee exact match and never shorter than authoritative duration.
 *   No cumulative drift because boundaries derived from absolute times, not summed durations.
 *   Contiguous scenes in seconds remain contiguous in frames: if actualEnd_prev == actualStart_next, then round(prevEnd*fps)==round(nextStart*fps) → prev.endFrame==next.startFrame
 *   Internal shared boundaries use same rounded absolute frame.
 *   Transition frame duration: when absolute start/end available, durationInFrames = endFrame - startFrame (not independently rounded) to keep no-drift policy.
 *   Minimum 1 frame per scene/beat/audio/caption.
 *   Local timing: localStartSeconds = globalStart - sceneStart, localStartFrame = globalStartFrame - sceneStartFrame
 */

import {
  REMOTION_COMPOSITION_VERSION,
  REMOTION_FPS as FPS_CONST,
  REMOTION_LAYOUT,
  KNOWN_RENDERER_KEYS,
  KNOWN_TRANSITION_KEYS,
  RemotionCompositionPlan,
  RemotionSceneCompositionSpec,
  RemotionBeatCompositionSpec,
  RemotionAudioCompositionSpec,
  RemotionCaptionCompositionSpec,
  RemotionAssetCompositionSpec,
  RemotionTransitionCompositionSpec,
  RemotionCompositionSummary,
  RemotionCompositionFinding,
  RemotionCompositionErrorCode,
  BuildRemotionCompositionResult,
  VideoCompositionProps,
} from './remotion-composition-types.js';
import { SceneRenderPlan, SceneRenderSpec } from './scene-render-types.js';
import { validateSceneRenderPlan } from './scene-render-pipeline.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeFinding(
  severity: 'error' | 'warning',
  code: RemotionCompositionErrorCode,
  message: string,
  location?: RemotionCompositionFinding['location']
): RemotionCompositionFinding {
  return { severity, code, message, location };
}

/**
 * Deterministic seconds → frame conversion.
 * Uses Math.round to avoid systematic bias, derives from absolute time to prevent drift.
 */
export function deterministicSecondsToFrame(seconds: number, fps: number = FPS_CONST): number {
  return Math.round(seconds * fps);
}

export function deterministicDurationToFrames(durationSeconds: number, fps: number = FPS_CONST): number {
  return Math.max(1, Math.round(durationSeconds * fps));
}

/** Resolve dimensions from targetFormat */
export function resolveDimensions(targetFormat: string): { width: number; height: number } {
  const fmt = targetFormat.toLowerCase() as keyof typeof REMOTION_LAYOUT;
  if (fmt === 'short' || fmt === 'short'.toLowerCase() as any) {
    return { width: REMOTION_LAYOUT.short.width, height: REMOTION_LAYOUT.short.height };
  }
  if (fmt === 'long' || fmt === 'reusable' || fmt === 'Long' || fmt === 'Short') {
    // Handle both cases
    const lower = targetFormat.toLowerCase();
    if (lower === 'short') return { width: REMOTION_LAYOUT.short.width, height: REMOTION_LAYOUT.short.height };
    return { width: REMOTION_LAYOUT.long.width, height: REMOTION_LAYOUT.long.height };
  }
  // Default to long
  return { width: REMOTION_LAYOUT.long.width, height: REMOTION_LAYOUT.long.height };
}

/** Renderer resolver - validates rendererKey exists */
export function resolveRendererKey(rendererKey: string): { valid: boolean; category?: string; error?: string } {
  if (KNOWN_RENDERER_KEYS.has(rendererKey)) {
    const category = rendererKey.split(':')[0];
    return { valid: true, category };
  }
  return { valid: false, error: `Unknown renderer key '${rendererKey}'` };
}

/** Validate SceneRenderPlan before conversion */
function validateInput(plan: SceneRenderPlan): RemotionCompositionFinding[] {
  const findings: RemotionCompositionFinding[] = [];
  if (!plan) {
    findings.push(makeFinding('error', 'MISSING_PHASE_OUTPUT', 'SceneRenderPlan is required'));
    return findings;
  }
  const validation = validateSceneRenderPlan(plan);
  for (const f of validation.findings) {
    if (f.severity === 'error') {
      findings.push({
        severity: 'error',
        code: f.code as any,
        message: f.message,
        location: f.location as any,
      });
    }
  }
  return findings;
}

function buildSummary(
  partial: Omit<RemotionCompositionPlan, 'summary' | 'findings' | 'valid'>,
  findings: RemotionCompositionFinding[]
): RemotionCompositionSummary {
  const warnings = findings.filter(f => f.severity === 'warning').length;
  const hasError = findings.some(f => f.severity === 'error');
  const rendererKeys = [...new Set(partial.scenes.map(s => s.rendererKey))].sort() as any;
  const categories = [...new Set(partial.scenes.map(s => s.rendererCategory))].sort() as any;

  return {
    scenarioId: partial.scenarioId,
    projectId: partial.projectId,
    language: partial.language,
    targetFormat: partial.targetFormat,
    fps: partial.fps,
    width: partial.width,
    height: partial.height,
    sceneCount: partial.scenes.length,
    rendererKeysUsed: rendererKeys,
    rendererCategoriesUsed: categories,
    beatCount: partial.scenes.reduce((sum, s) => sum + s.beats.length, 0),
    audioRefCount: partial.scenes.reduce((sum, s) => sum + s.audioRefs.length, 0),
    captionCueCount: partial.scenes.reduce((sum, s) => sum + s.captionCues.length, 0),
    assetRefCount: partial.scenes.reduce((sum, s) => sum + s.assetRefs.length, 0),
    transitionCount: partial.scenes.filter(s => s.transition && s.transition.type && s.transition.type !== 'cut' && s.transition.type !== 'none' && s.transition.type !== 'direct_cut').length,
    fallbackCount: partial.scenes.filter(s => s.fallbackUsed).length,
    totalActualDurationSeconds: round2(partial.totalActualDurationSeconds),
    totalDurationInFrames: partial.durationInFrames,
    warningCount: warnings,
    status: hasError ? 'error' : warnings > 0 ? 'warning' : 'ok',
  };
}

function validateCompositionInvariants(plan: RemotionCompositionPlan): RemotionCompositionFinding[] {
  const findings: RemotionCompositionFinding[] = [];
  const err = (code: RemotionCompositionErrorCode, msg: string, loc?: any) => {
    findings.push(makeFinding('error', code, msg, loc));
  };
  const warn = (code: RemotionCompositionErrorCode, msg: string, loc?: any) => {
    findings.push(makeFinding('warning', code, msg, loc));
  };

  // Check duplicate scene ID
  const seenIds = new Set<string>();
  for (const scene of plan.scenes) {
    if (seenIds.has(scene.sceneId)) {
      err('DUPLICATE_SCENE_ID', `Duplicate sceneId '${scene.sceneId}'`, { sceneId: scene.sceneId });
    }
    seenIds.add(scene.sceneId);
  }

  // Check render order
  const seenOrders = new Set<number>();
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i];
    if (scene.renderOrder !== i) {
      err('DUPLICATE_RENDER_ORDER', `Render order mismatch for scene '${scene.sceneId}': expected ${i}, got ${scene.renderOrder}`, { sceneId: scene.sceneId });
    }
    if (seenOrders.has(scene.renderOrder)) {
      err('DUPLICATE_RENDER_ORDER', `Duplicate renderOrder ${scene.renderOrder}`, { sceneId: scene.sceneId });
    }
    seenOrders.add(scene.renderOrder);

    // Frame range validation
    if (scene.startFrame < 0 || scene.endFrame <= scene.startFrame) {
      err('INVALID_FRAME_RANGE', `Invalid frame range for scene '${scene.sceneId}': [${scene.startFrame}, ${scene.endFrame})`, { sceneId: scene.sceneId });
    }
    if (scene.durationInFrames <= 0) {
      err('INVALID_FRAME_RANGE', `Scene '${scene.sceneId}' durationInFrames must be positive`, { sceneId: scene.sceneId });
    }
    if (scene.durationInFrames !== scene.endFrame - scene.startFrame) {
      err('COMPOSITION_DURATION_MISMATCH', `Scene '${scene.sceneId}' durationInFrames ${scene.durationInFrames} != end-start ${scene.endFrame - scene.startFrame}`, { sceneId: scene.sceneId });
    }

    // Renderer key validation
    const resolved = resolveRendererKey(scene.rendererKey);
    if (!resolved.valid) {
      // Allow generic fallback if explicitly marked
      if (scene.fallbackUsed && scene.rendererKey === 'generic:generic') {
        warn('RENDERER_MAPPING_MISSING', `Fallback renderer used for scene '${scene.sceneId}': ${scene.fallbackFrom} → ${scene.rendererKey}`, { sceneId: scene.sceneId, rendererKey: scene.rendererKey });
      } else {
        err('UNKNOWN_RENDERER_KEY', `Unknown renderer key '${scene.rendererKey}' for scene '${scene.sceneId}'`, { sceneId: scene.sceneId, rendererKey: scene.rendererKey });
      }
    }

    // Monotonic frame ranges, no overlap
    if (i > 0) {
      const prev = plan.scenes[i - 1];
      if (prev.endFrame > scene.startFrame) {
        // Allow exact equality, but not overlap
        if (prev.endFrame !== scene.startFrame) {
          // Check if time gap exists - if actualStart > prev actualEnd, gap is allowed
          const timeGap = scene.actualStartSeconds - prev.actualEndSeconds;
          if (timeGap <= 0.001) {
            err('OVERLAP_DETECTED', `Scene frame overlap between '${prev.sceneId}' [${prev.startFrame},${prev.endFrame}) and '${scene.sceneId}' [${scene.startFrame},${scene.endFrame})`, { sceneId: scene.sceneId });
          }
        }
      }
    }

    // Beat frame ranges
    for (const beat of scene.beats) {
      if (beat.startFrame < scene.startFrame || beat.endFrame > scene.endFrame) {
        err('REMOTION_SCENE_BINDING_FAILED', `Beat '${beat.id}' frame range [${beat.startFrame},${beat.endFrame}) outside scene '${scene.sceneId}' [${scene.startFrame},${scene.endFrame})`, { sceneId: scene.sceneId, beatId: beat.id });
      }
      if (beat.durationInFrames <= 0) {
        err('INVALID_FRAME_RANGE', `Beat '${beat.id}' durationInFrames must be positive`, { sceneId: scene.sceneId, beatId: beat.id });
      }
      if (beat.localStartFrame < 0 || beat.localEndFrame > scene.durationInFrames) {
        err('REMOTION_SCENE_BINDING_FAILED', `Beat '${beat.id}' local frame range outside scene`, { sceneId: scene.sceneId, beatId: beat.id });
      }
    }

    // Audio binding
    for (const audio of scene.audioRefs) {
      if (!audio.canonicalPath || !audio.canonicalPath.includes('audio/canonical')) {
        err('AUDIO_TIMELINE_BINDING_FAILED', `Audio clip '${audio.clipId}' must use canonical path, got '${audio.canonicalPath}'`, { sceneId: scene.sceneId, clipId: audio.clipId });
      }
      if (audio.sceneId !== scene.sourceSceneId && audio.sceneId !== scene.sceneId) {
        err('AUDIO_BINDING_MISMATCH', `Audio clip '${audio.clipId}' sceneId mismatch for scene '${scene.sceneId}'`, { sceneId: scene.sceneId, clipId: audio.clipId });
      }
      if (audio.startFrame < scene.startFrame || audio.endFrame > scene.endFrame) {
        err('AUDIO_TIMELINE_BINDING_FAILED', `Audio clip '${audio.clipId}' frame range outside scene`, { sceneId: scene.sceneId, clipId: audio.clipId });
      }
    }

    // Caption binding
    for (const cue of scene.captionCues) {
      if (cue.sceneId !== scene.sourceSceneId && cue.sceneId !== scene.sceneId) {
        err('CAPTION_BINDING_MISMATCH', `Caption cue '${cue.id}' sceneId mismatch for scene '${scene.sceneId}'`, { sceneId: scene.sceneId, cueId: cue.id });
      }
      if (cue.startFrame < scene.startFrame || cue.endFrame > scene.endFrame) {
        err('CAPTION_TIMELINE_BINDING_FAILED', `Caption cue '${cue.id}' frame range outside scene '${scene.sceneId}'`, { sceneId: scene.sceneId, cueId: cue.id });
      }
      // Text unchanged - we trust Phase 5B, but ensure non-empty
      if (!cue.text || typeof cue.text !== 'string') {
        err('CAPTION_BINDING_MISMATCH', `Caption cue '${cue.id}' text invalid`, { sceneId: scene.sceneId, cueId: cue.id });
      }
    }

    // Asset binding
    for (const asset of scene.assetRefs) {
      if (asset.sceneId !== scene.sourceSceneId && asset.sceneId !== scene.sceneId) {
        err('ASSET_BINDING_MISMATCH', `Asset '${asset.assetRef}' sceneId mismatch for scene '${scene.sceneId}'`, { sceneId: scene.sceneId, assetRef: asset.assetRef });
      }
    }

    // Transition binding
    if (scene.transition) {
      if (!KNOWN_TRANSITION_KEYS.has(scene.transition.type) && !KNOWN_TRANSITION_KEYS.has(scene.transition.rendererKey)) {
        err('TRANSITION_TIMELINE_BINDING_FAILED', `Unknown transition type '${scene.transition.type}' / rendererKey '${scene.transition.rendererKey}' for scene '${scene.sceneId}'`, {
          sceneId: scene.sceneId,
          transitionKey: scene.transition.type,
        });
      }
      if (scene.transition.durationInFrames !== null && scene.transition.durationInFrames !== undefined) {
        if (scene.transition.durationInFrames < 0) {
          err('TRANSITION_TIMELINE_BINDING_FAILED', `Transition duration negative for scene '${scene.sceneId}'`, { sceneId: scene.sceneId });
        }
      }
    }
  }

  // Total duration check
  if (plan.scenes.length > 0) {
    const last = plan.scenes[plan.scenes.length - 1];
    if (last.endFrame !== plan.durationInFrames) {
      err('COMPOSITION_DURATION_MISMATCH', `Last scene endFrame ${last.endFrame} != total durationInFrames ${plan.durationInFrames}`);
    }
    if (Math.abs(plan.totalActualDurationSeconds - plan.scenes[plan.scenes.length - 1].actualEndSeconds) > 0.01) {
      err('COMPOSITION_DURATION_MISMATCH', `Total actual duration mismatch`);
    }
    // No cumulative drift: sum of durations should equal total
    const sumFrames = plan.scenes.reduce((sum, s) => sum + s.durationInFrames, 0);
    if (sumFrames !== plan.durationInFrames) {
      err('COMPOSITION_DURATION_MISMATCH', `Sum scene durationInFrames ${sumFrames} != total ${plan.durationInFrames}`);
    }
  }

  return findings;
}

export interface RemotionCompositionOptions {
  fps?: number;
  width?: number;
  height?: number;
  allowGenericFallback?: boolean;
}

export function buildRemotionCompositionProps(
  sceneRenderPlan: SceneRenderPlan,
  options?: RemotionCompositionOptions
): BuildRemotionCompositionResult {
  const fps = options?.fps ?? FPS_CONST;
  const findings: RemotionCompositionFinding[] = [];

  if (!sceneRenderPlan) {
    return {
      success: false,
      error: 'Missing SceneRenderPlan',
      findings: [makeFinding('error', 'MISSING_PHASE_OUTPUT', 'SceneRenderPlan is required')],
    };
  }

  // Validate input plan
  const inputFindings = validateInput(sceneRenderPlan);
  if (inputFindings.some(f => f.severity === 'error')) {
    return {
      success: false,
      error: `SceneRenderPlan validation failed: ${inputFindings.filter(f => f.severity === 'error').map(f => f.message).join('; ')}`,
      findings: inputFindings,
    };
  }

  findings.push(...inputFindings.filter(f => f.severity === 'warning'));

  const dimensions = resolveDimensions(sceneRenderPlan.targetFormat);
  const width = options?.width ?? dimensions.width;
  const height = options?.height ?? dimensions.height;

  // Final composition boundary uses ceil to prevent truncation of authoritative audio timeline
  const totalDurationInFrames = Math.ceil(sceneRenderPlan.totalActualDurationSeconds * fps);

  const scenes: RemotionSceneCompositionSpec[] = [];

  for (let sIdx = 0; sIdx < sceneRenderPlan.scenes.length; sIdx++) {
    const rScene = sceneRenderPlan.scenes[sIdx];

    // Renderer resolution - fail explicitly if unknown and not fallback
    const resolved = resolveRendererKey(rScene.rendererKey);
    if (!resolved.valid) {
      if (rScene.fallbackUsed && rScene.rendererKey === 'generic:generic') {
        findings.push(
          makeFinding('warning', 'RENDERER_MAPPING_MISSING', `Fallback renderer preserved for scene '${rScene.sceneId}': ${rScene.fallbackFrom} → ${rScene.rendererKey}`, {
            sceneId: rScene.sceneId,
            rendererKey: rScene.rendererKey,
          })
        );
      } else {
        const errFinding = makeFinding('error', 'UNKNOWN_RENDERER_KEY', `Unknown renderer key '${rScene.rendererKey}' for scene '${rScene.sceneId}'`, {
          sceneId: rScene.sceneId,
          rendererKey: rScene.rendererKey,
        });
        return {
          success: false,
          error: errFinding.message,
          findings: [...findings, errFinding],
        };
      }
    }

    // Frame ranges from absolute actual timing
    let startFrame = deterministicSecondsToFrame(rScene.actualStartSeconds, fps);
    let endFrame = deterministicSecondsToFrame(rScene.actualEndSeconds, fps);

    // For last scene, force endFrame to total to avoid rounding mismatch
    if (sIdx === sceneRenderPlan.scenes.length - 1) {
      endFrame = totalDurationInFrames;
    }

    // Ensure at least 1 frame and monotonic
    if (endFrame <= startFrame) {
      endFrame = startFrame + 1;
    }
    if (sIdx > 0) {
      const prev = scenes[sIdx - 1];
      if (startFrame < prev.endFrame) {
        // If actual timing says no gap, align to prev end; if gap, preserve gap in frames
        const actualGap = rScene.actualStartSeconds - sceneRenderPlan.scenes[sIdx - 1].actualEndSeconds;
        if (actualGap <= 0.001) {
          startFrame = prev.endFrame;
          if (endFrame <= startFrame) {
            endFrame = startFrame + deterministicDurationToFrames(rScene.actualDurationSeconds, fps);
          }
        }
      }
    }

    const durationInFrames = endFrame - startFrame;

    // Beats with local/global frame mapping
    const beats: RemotionBeatCompositionSpec[] = rScene.beats.map(beat => {
      const globalStartFrame = deterministicSecondsToFrame(beat.actualStartSeconds, fps);
      const globalEndFrame = deterministicSecondsToFrame(beat.actualEndSeconds, fps);
      const localStartSeconds = round2(beat.actualStartSeconds - rScene.actualStartSeconds);
      const localEndSeconds = round2(beat.actualEndSeconds - rScene.actualStartSeconds);
      const localDurationSeconds = round2(localEndSeconds - localStartSeconds);
      // Local frames derived from global - scene start to avoid drift
      const localStartFrame = globalStartFrame - startFrame;
      const localEndFrame = globalEndFrame - startFrame;
      const localDurationInFrames = localEndFrame - localStartFrame;

      return {
        id: beat.id,
        sceneId: beat.sceneId,
        index: beat.index,
        kind: beat.kind,
        actualStartSeconds: beat.actualStartSeconds,
        actualEndSeconds: beat.actualEndSeconds,
        actualDurationSeconds: beat.actualDurationSeconds,
        relativeStart: beat.relativeStart,
        relativeEnd: beat.relativeEnd,
        startFrame: globalStartFrame,
        endFrame: globalEndFrame,
        durationInFrames: Math.max(1, globalEndFrame - globalStartFrame),
        localStartSeconds,
        localEndSeconds,
        localDurationSeconds,
        localStartFrame,
        localEndFrame,
        localDurationInFrames: Math.max(1, localDurationInFrames),
        turnId: beat.turnId,
        activeSpeakerId: beat.activeSpeakerId,
        reactingCharacterId: beat.reactingCharacterId,
        spokenText: beat.spokenText,
        intent: beat.intent,
        delivery: beat.delivery,
        shot: beat.shot,
        evidenceIds: [...beat.evidenceIds],
        cues: beat.cues.map(c => ({ ...c })),
        audioRef: beat.audioRef ? { ...beat.audioRef } : null,
        captionCueIds: [...beat.captionCueIds],
      };
    });

    // Audio refs with frame mapping
    const audioRefs: RemotionAudioCompositionSpec[] = rScene.audioRefs.map(audio => {
      const sFrame = deterministicSecondsToFrame(audio.actualStartSeconds, fps);
      const eFrame = deterministicSecondsToFrame(audio.actualEndSeconds, fps);
      return {
        ...audio,
        startFrame: sFrame,
        endFrame: eFrame,
        durationInFrames: Math.max(1, eFrame - sFrame),
        localStartFrame: sFrame - startFrame,
        localEndFrame: eFrame - startFrame,
        localStartSeconds: round2(audio.actualStartSeconds - rScene.actualStartSeconds),
        localEndSeconds: round2(audio.actualEndSeconds - rScene.actualStartSeconds),
      };
    });

    // Caption cues with frame mapping
    const captionCues: RemotionCaptionCompositionSpec[] = rScene.captionCues.map(cue => {
      const sFrame = deterministicSecondsToFrame(cue.startTimeSeconds, fps);
      const eFrame = deterministicSecondsToFrame(cue.endTimeSeconds, fps);
      return {
        ...cue,
        startFrame: sFrame,
        endFrame: eFrame,
        durationInFrames: Math.max(1, eFrame - sFrame),
        localStartFrame: sFrame - startFrame,
        localEndFrame: eFrame - startFrame,
        localStartSeconds: round2(cue.startTimeSeconds - rScene.actualStartSeconds),
        localEndSeconds: round2(cue.endTimeSeconds - rScene.actualStartSeconds),
      };
    });

    // Asset refs deterministic order preserved
    const assetRefs: RemotionAssetCompositionSpec[] = rScene.assetRefs.map((asset, idx) => ({
      ...asset,
      order: idx,
    }));

    // Transition mapping - duration derived from absolute boundaries when available (no-drift)
    const transStartFrame = rScene.transition.actualStartSeconds !== null ? deterministicSecondsToFrame(rScene.transition.actualStartSeconds, fps) : null;
    const transEndFrame = rScene.transition.actualEndSeconds !== null ? deterministicSecondsToFrame(rScene.transition.actualEndSeconds, fps) : null;
    let transDurationFrames: number | null = null;
    if (transStartFrame !== null && transEndFrame !== null) {
      transDurationFrames = transEndFrame - transStartFrame;
    } else if (rScene.transition.actualDurationSeconds !== null) {
      transDurationFrames = deterministicDurationToFrames(rScene.transition.actualDurationSeconds, fps);
    }

    const transition: RemotionTransitionCompositionSpec = {
      type: rScene.transition.type,
      rendererKey: rScene.transition.rendererKey,
      durationSeconds: rScene.transition.durationSeconds,
      source: rScene.transition.source,
      actualStartSeconds: rScene.transition.actualStartSeconds,
      actualEndSeconds: rScene.transition.actualEndSeconds,
      actualDurationSeconds: rScene.transition.actualDurationSeconds,
      startFrame: transStartFrame,
      endFrame: transEndFrame,
      durationInFrames: transDurationFrames,
      localStartFrame: transStartFrame !== null ? transStartFrame - startFrame : null,
      localEndFrame: transEndFrame !== null ? transEndFrame - startFrame : null,
      outgoingSceneId: sIdx > 0 ? sceneRenderPlan.scenes[sIdx - 1].sceneId : null,
      incomingSceneId: rScene.sceneId,
    };

    scenes.push({
      scenarioId: rScene.scenarioId,
      projectId: rScene.projectId,
      sceneId: rScene.sceneId,
      sourceSceneId: rScene.sourceSceneId,
      sceneIndex: rScene.sceneIndex,
      renderOrder: rScene.renderOrder,
      title: rScene.title,
      narrativePurpose: rScene.narrativePurpose,
      rendererKey: rScene.rendererKey,
      rendererCategory: rScene.rendererCategory,
      fallbackUsed: rScene.fallbackUsed,
      fallbackFrom: rScene.fallbackFrom,
      actualStartSeconds: rScene.actualStartSeconds,
      actualEndSeconds: rScene.actualEndSeconds,
      actualDurationSeconds: rScene.actualDurationSeconds,
      estimatedStartSeconds: rScene.estimatedStartSeconds,
      estimatedEndSeconds: rScene.estimatedEndSeconds,
      estimatedDurationSeconds: rScene.estimatedDurationSeconds,
      startFrame: startFrame,
      endFrame: endFrame,
      durationInFrames: durationInFrames,
      visualTreatment: { ...rScene.visualTreatment },
      production: { ...rScene.production },
      onScreenInfo: rScene.onScreenInfo ? { ...rScene.onScreenInfo } : null,
      locationId: rScene.locationId,
      participantIds: [...rScene.participantIds],
      turnIds: [...rScene.turnIds],
      speakerIds: [...rScene.speakerIds],
      visualOnly: rScene.visualOnly,
      beats,
      assetRefs,
      audioRefs,
      captionCues,
      transition,
      targetFormat: rScene.targetFormat,
      formatInfo: rScene.formatInfo,
      width,
      height,
    });
  }

  const partialPlan: Omit<RemotionCompositionPlan, 'summary' | 'findings' | 'valid'> = {
    planVersion: REMOTION_COMPOSITION_VERSION,
    scenarioId: sceneRenderPlan.scenarioId,
    projectId: sceneRenderPlan.projectId,
    language: sceneRenderPlan.language,
    targetFormat: sceneRenderPlan.targetFormat,
    fps,
    width,
    height,
    durationInFrames: totalDurationInFrames,
    totalActualDurationSeconds: round2(sceneRenderPlan.totalActualDurationSeconds),
    totalEstimatedDurationSeconds: round2(sceneRenderPlan.totalEstimatedDurationSeconds),
    totalDeltaSeconds: round2(sceneRenderPlan.totalActualDurationSeconds - sceneRenderPlan.totalEstimatedDurationSeconds),
    scenes,
  };

  const summary = buildSummary(partialPlan, findings);
  const tempPlan: RemotionCompositionPlan = {
    ...partialPlan,
    summary,
    findings,
    valid: true,
  };

  const invariantFindings = validateCompositionInvariants(tempPlan);
  const allFindings = [...findings, ...invariantFindings];
  const finalSummary = buildSummary(partialPlan, allFindings);
  const hasError = allFindings.some(f => f.severity === 'error');

  const finalPlan: RemotionCompositionPlan = {
    ...partialPlan,
    summary: finalSummary,
    findings: allFindings,
    valid: !hasError,
  };

  if (hasError) {
    return {
      success: false,
      error: `Remotion composition invariants failed: ${allFindings.filter(f => f.severity === 'error').map(f => f.message).join('; ')}`,
      findings: allFindings,
      partialPlan: finalPlan,
    };
  }

  return {
    success: true,
    plan: finalPlan,
  };
}

export function validateRemotionCompositionPlan(plan: RemotionCompositionPlan): { valid: boolean; findings: RemotionCompositionFinding[] } {
  if (!plan || typeof plan !== 'object') {
    return {
      valid: false,
      findings: [makeFinding('error', 'MISSING_PHASE_OUTPUT', 'RemotionCompositionPlan must be non-null object')],
    };
  }
  const findings: RemotionCompositionFinding[] = [...(plan.findings ?? [])];
  const invariantFindings = validateCompositionInvariants(plan);
  const allFindings = [...findings, ...invariantFindings];
  return {
    valid: !allFindings.some(f => f.severity === 'error'),
    findings: allFindings,
  };
}

/** Public API alias for VideoCompositionProps */
export function buildVideoCompositionProps(
  sceneRenderPlan: SceneRenderPlan,
  options?: RemotionCompositionOptions
): BuildRemotionCompositionResult {
  return buildRemotionCompositionProps(sceneRenderPlan, options);
}

/** Frame utility public */
export const frameUtils = {
  secondsToFrame: deterministicSecondsToFrame,
  durationToFrames: deterministicDurationToFrames,
};
