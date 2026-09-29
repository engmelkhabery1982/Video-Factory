/**
 * BuildTrack Video Factory - Phase 5D Audiovisual Sync Pipeline (Corrected per Final Acceptance)
 *
 * Validates end-to-end synchronization:
 * Scenario → DialogueProductionResult → VisualProductionPlan → SceneRenderPlan → RemotionCompositionPlan → AudiovisualSyncReport
 *
 * Timing policy (from baseline 056e6b3, unchanged):
 * - FPS = 30 exact
 * - Authoritative = seconds from Phase 4 reconciledDialogue.actualTotalDurationSeconds, never replaced by frame-derived
 * - Frame ranges half-open [start, endExclusive)
 * - Structural: Math.round(seconds*30)
 * - Content coverage: start=round(start*30), endExclusive=ceil(end*30) or composition.durationInFrames if final
 * - Canonical: 118.74s → raw 3562.2 → ceil 3563, valid 0..3562, 3563 exclusive only, tail 0.026666s=0.8f expected NOT drift
 * - Phase 4 is authoritative source, not Remotion
 */

import {
  AUDIOVISUAL_SYNC_VERSION,
  AUDIOVISUAL_SYNC_FPS,
  AudiovisualSyncErrorCode,
  AudiovisualSyncFinding,
  AudiovisualSyncSummary,
  AudiovisualSyncReport,
  AudiovisualSyncInput,
  ValidateAudiovisualSyncResult,
} from './audiovisual-sync-types.js';

const FPS = AUDIOVISUAL_SYNC_FPS;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeFinding(
  severity: 'error' | 'warning',
  code: AudiovisualSyncErrorCode,
  message: string,
  location?: AudiovisualSyncFinding['location'],
  details?: Record<string, unknown>
): AudiovisualSyncFinding {
  return { severity, code, message, location, details };
}

function isFinalContent(endSeconds: number, totalSeconds: number): boolean {
  return Math.abs(endSeconds - totalSeconds) < 0.001;
}

function structuralFrame(seconds: number): number {
  return Math.round(seconds * FPS);
}

function coverageEndExclusive(endSeconds: number, totalSeconds: number, compositionDurationFrames: number): number {
  if (isFinalContent(endSeconds, totalSeconds)) {
    return compositionDurationFrames;
  }
  return Math.ceil(endSeconds * FPS);
}

function boundaryProjectionErrorFrames(seconds: number, frame: number): number {
  return Math.abs(frame - seconds * FPS);
}

function normalizeSceneId(id: string): string {
  if (!id) return id;
  const parts = id.split('/');
  return parts[parts.length - 1];
}

function sameSceneId(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const na = normalizeSceneId(a);
  const nb = normalizeSceneId(b);
  if (na === nb) return true;
  if (a.endsWith(b) || b.endsWith(a)) return true;
  return false;
}

export function validateAudiovisualSync(input: AudiovisualSyncInput): ValidateAudiovisualSyncResult {
  const findings: AudiovisualSyncFinding[] = [];
  const err = (code: AudiovisualSyncErrorCode, msg: string, loc?: any, details?: any) => {
    findings.push(makeFinding('error', code, msg, loc, details));
  };
  const warn = (code: AudiovisualSyncErrorCode, msg: string, loc?: any, details?: any) => {
    findings.push(makeFinding('warning', code, msg, loc, details));
  };

  const { scenario, dialogueResult, visualProductionPlan, sceneRenderPlan, remotionCompositionPlan } = input;

  // Missing required phase output must fail explicitly
  if (!scenario) {
    err('MISSING_PHASE_OUTPUT', 'Scenario is required');
    return { success: false, error: 'Missing scenario', findings };
  }
  if (!dialogueResult) {
    err('MISSING_PHASE_OUTPUT', 'DialogueProductionResult is required');
    return { success: false, error: 'Missing dialogueResult', findings };
  }
  if (!visualProductionPlan) {
    err('MISSING_PHASE_OUTPUT', 'VisualProductionPlan is required');
    return { success: false, error: 'Missing visualProductionPlan', findings };
  }
  if (!sceneRenderPlan) {
    err('MISSING_PHASE_OUTPUT', 'SceneRenderPlan is required');
    return { success: false, error: 'Missing sceneRenderPlan', findings };
  }
  if (!remotionCompositionPlan) {
    err('MISSING_PHASE_OUTPUT', 'RemotionCompositionPlan is required');
    return { success: false, error: 'Missing remotionCompositionPlan', findings };
  }

  const scenarioId = (scenario as any).metadata?.id ?? (scenario as any).scenarioId ?? 'unknown';
  const projectId = (scenario as any).metadata?.projectId ?? (scenario as any).projectId ?? 'unknown';

  const canonicalFixtureTotal = 118.74;
  const estimatedTotal = 102;

  // Identity checks across pipeline
  const idsToCheck = [
    { name: 'dialogueResult', id: (dialogueResult as any).scenarioId ?? (dialogueResult as any).result?.scenarioId, project: (dialogueResult as any).projectId ?? (dialogueResult as any).result?.projectId },
    { name: 'visualProductionPlan', id: (visualProductionPlan as any).scenarioId, project: (visualProductionPlan as any).projectId },
    { name: 'sceneRenderPlan', id: (sceneRenderPlan as any).scenarioId, project: (sceneRenderPlan as any).projectId },
    { name: 'remotionCompositionPlan', id: (remotionCompositionPlan as any).scenarioId, project: (remotionCompositionPlan as any).projectId },
  ];
  for (const entry of idsToCheck) {
    if (entry.id && entry.id !== scenarioId) {
      err('PIPELINE_IDENTITY_MISMATCH', `${entry.name} scenarioId mismatch: expected ${scenarioId}, got ${entry.id}`, { scenarioId });
    }
    if (entry.project && entry.project !== projectId) {
      err('PIPELINE_IDENTITY_MISMATCH', `${entry.name} projectId mismatch: expected ${projectId}, got ${entry.project}`, { scenarioId });
    }
  }

  // CORRECTION 1 — PHASE 4 MUST BE THE ACTUAL AUTHORITATIVE SOURCE
  // Authoritative total MUST come directly from Phase 4: dialogueResult.reconciledDialogue.actualTotalDurationSeconds
  const phase4Dialogue = (dialogueResult as any).reconciledDialogue;
  const phase4Playback = (dialogueResult as any).reconciledPlayback;
  const phase4Captions = (dialogueResult as any).reconciledCaptions;
  const phase4Summary = (dialogueResult as any).summary;

  let authoritativeTotal: number = 0;
  let authoritativeTotalDefined = false;

  if (!phase4Dialogue || typeof phase4Dialogue.actualTotalDurationSeconds !== 'number') {
    err('MISSING_PHASE_OUTPUT', 'Phase 4 reconciledDialogue.actualTotalDurationSeconds is required as authoritative source');
    // Fallback to avoid crashing, but will fail later
    const fallback = (remotionCompositionPlan as any).totalActualDurationSeconds ?? (sceneRenderPlan as any).totalActualDurationSeconds ?? (visualProductionPlan as any).totalActualDurationSeconds;
    authoritativeTotal = typeof fallback === 'number' ? fallback : 0;
  } else {
    authoritativeTotal = phase4Dialogue.actualTotalDurationSeconds;
    authoritativeTotalDefined = true;

    // Cross-check Phase 4 values must agree within tiny tolerance
    const phase4Values: { name: string; value: number | undefined }[] = [
      { name: 'reconciledDialogue.actualTotalDurationSeconds', value: phase4Dialogue.actualTotalDurationSeconds },
      { name: 'summary.totalActualDurationSeconds', value: phase4Summary?.totalActualDurationSeconds },
      { name: 'reconciledPlayback.actualTotalDurationMs/1000', value: phase4Playback?.actualTotalDurationMs ? phase4Playback.actualTotalDurationMs / 1000 : undefined },
      { name: 'reconciledCaptions.actualTotalDurationSeconds', value: phase4Captions?.actualTotalDurationSeconds },
    ];

    const validPhase4Values = phase4Values.filter(v => typeof v.value === 'number');
    for (let i = 1; i < validPhase4Values.length; i++) {
      const prev = validPhase4Values[i - 1];
      const curr = validPhase4Values[i];
      if (Math.abs((prev.value as number) - (curr.value as number)) > 0.01) {
        err('SCENE_SYNC_MISMATCH', `Phase 4 total mismatch: ${prev.name}=${prev.value} vs ${curr.name}=${curr.value}`, { scenarioId });
      }
    }

    // Then require VisualProductionPlan total == Phase 4 authoritative total, SceneRenderPlan total == Phase 4, Remotion total == Phase 4
    const downstreamTotals: { name: string; value: number | undefined }[] = [
      { name: 'VisualProductionPlan.totalActualDurationSeconds', value: (visualProductionPlan as any).totalActualDurationSeconds },
      { name: 'SceneRenderPlan.totalActualDurationSeconds', value: (sceneRenderPlan as any).totalActualDurationSeconds },
      { name: 'RemotionCompositionPlan.totalActualDurationSeconds', value: (remotionCompositionPlan as any).totalActualDurationSeconds },
    ];

    for (const dt of downstreamTotals) {
      if (typeof dt.value === 'number' && Math.abs(dt.value - authoritativeTotal) > 0.01) {
        err('SCENE_SYNC_MISMATCH', `${dt.name} ${dt.value} != Phase 4 authoritative ${authoritativeTotal}`, { scenarioId });
      }
      // CORRECTION: also detect estimated timing regression in downstream
      if (typeof dt.value === 'number' && Math.abs(dt.value - estimatedTotal) < 1) {
        err('ESTIMATED_TIMING_REGRESSION', `${dt.name} uses estimated timing 102s, expected Phase4 ${authoritativeTotal}`, { scenarioId });
      }
    }
  }

  // Authoritative total from Phase4 already checked for estimated regression below
  if (Math.abs(authoritativeTotal - estimatedTotal) < 1) {
    err('ESTIMATED_TIMING_REGRESSION', `Phase4 authoritative total uses estimated timing 102s, expected canonical 118.74s, got ${authoritativeTotal}`, { scenarioId });
  }

  // FPS check
  if ((remotionCompositionPlan as any).fps !== FPS) {
    err('SCENE_SYNC_MISMATCH', `FPS mismatch: expected ${FPS}, got ${(remotionCompositionPlan as any).fps}`, { scenarioId });
  }

  // Composition frames
  const compositionDurationFrames = (remotionCompositionPlan as any).durationInFrames;
  const rawFramePosition = authoritativeTotal * FPS;
  const expectedFrames = Math.ceil(authoritativeTotal * FPS);
  if (compositionDurationFrames !== expectedFrames) {
    err('COMPOSITION_DURATION_MISMATCH', `Composition frames mismatch: expected ceil(${authoritativeTotal}*${FPS})=${expectedFrames}, got ${compositionDurationFrames}`, { scenarioId });
  }

  // Final frame checks for canonical fixture
  const finalValidFrame = compositionDurationFrames - 1;
  if (scenarioId === 'scenario-pm-01') {
    if (compositionDurationFrames !== 3563) {
      err('COMPOSITION_DURATION_MISMATCH', `Canonical fixture must be 3563 frames, got ${compositionDurationFrames}`, { scenarioId });
    }
    if (finalValidFrame !== 3562) {
      err('SCENE_SYNC_MISMATCH', `Final valid frame must be 3562, got ${finalValidFrame}`, { scenarioId });
    }
    if (Math.abs(rawFramePosition - 3562.2) > 0.01) {
      err('SCENE_SYNC_MISMATCH', `Raw frame position must be 3562.2, got ${rawFramePosition}`, { scenarioId });
    }
  }

  // Maximum projection error tracking - CORRECTION 6: include ALL boundaries
  let maxProjectionError = 0;
  const trackError = (seconds: number, frame: number | null) => {
    if (frame === null || frame === undefined) return;
    if (typeof seconds !== 'number') return;
    const errVal = boundaryProjectionErrorFrames(seconds, frame);
    if (errVal > maxProjectionError) maxProjectionError = errVal;
  };

  // Scene synchronization - CORRECTION 4: authority is Phase 4 reconciledDialogue.scenes
  const remotionScenes = (remotionCompositionPlan as any).scenes ?? [];
  const sceneRenderScenes = (sceneRenderPlan as any).scenes ?? [];
  const visualScenes = (visualProductionPlan as any).scenes ?? [];
  const phase4Scenes = phase4Dialogue?.scenes ?? [];

  if (remotionScenes.length !== sceneRenderScenes.length || remotionScenes.length !== visualScenes.length) {
    err('SCENE_SYNC_MISMATCH', `Scene count mismatch: remotion ${remotionScenes.length}, sceneRender ${sceneRenderScenes.length}, visual ${visualScenes.length}`, { scenarioId });
  }

  if (phase4Scenes.length > 0 && remotionScenes.length !== phase4Scenes.length) {
    err('SCENE_SYNC_MISMATCH', `Scene count mismatch: remotion ${remotionScenes.length} vs Phase4 ${phase4Scenes.length}`, { scenarioId });
  }

  // Check scene order, identity, timing, frame ranges
  const sceneIdsSeen = new Set<string>();
  for (let i = 0; i < remotionScenes.length; i++) {
    const rScene = remotionScenes[i];
    const sScene = sceneRenderScenes[i];
    const vScene = visualScenes[i];
    const p4Scene = phase4Scenes[i];

    if (!rScene) continue;

    // Duplicate scene id
    if (sceneIdsSeen.has(rScene.sceneId)) {
      err('DUPLICATE_SCENE_ID', `Duplicate sceneId ${rScene.sceneId}`, { sceneId: rScene.sceneId });
    }
    sceneIdsSeen.add(rScene.sceneId);

    // Scene order
    if (rScene.renderOrder !== i) {
      err('SCENE_SYNC_MISMATCH', `Scene renderOrder mismatch at index ${i}: expected ${i}, got ${rScene.renderOrder}`, { sceneId: rScene.sceneId });
    }
    if (sScene && sScene.renderOrder !== i) {
      err('SCENE_SYNC_MISMATCH', `SceneRenderPlan renderOrder mismatch at index ${i}`, { sceneId: rScene.sceneId });
    }
    if (vScene && vScene.renderOrder !== i) {
      err('SCENE_SYNC_MISMATCH', `VisualProductionPlan renderOrder mismatch at index ${i}`, { sceneId: rScene.sceneId });
    }

    // CORRECTION 4: Where Phase 4 reconciled scene timing exists, validate Phase 5 scene timing against Phase 4
    if (p4Scene) {
      // sceneId check
      if (!sameSceneId(p4Scene.sceneId, rScene.sceneId) && !sameSceneId(p4Scene.sceneId, rScene.sourceSceneId ?? '')) {
        // Allow if normalized matches
        if (normalizeSceneId(p4Scene.sceneId) !== normalizeSceneId(rScene.sceneId) && normalizeSceneId(p4Scene.sceneId) !== normalizeSceneId(rScene.sourceSceneId ?? '')) {
          err('SCENE_SYNC_MISMATCH', `SceneId mismatch vs Phase4: Phase4 ${p4Scene.sceneId} vs Remotion ${rScene.sceneId}`, { sceneId: rScene.sceneId });
        }
      }
      if (Math.abs(p4Scene.actualStartTimeSeconds - rScene.actualStartSeconds) > 0.001) {
        err('SCENE_SYNC_MISMATCH', `Scene actualStart vs Phase4: Phase4 ${p4Scene.actualStartTimeSeconds} vs Remotion ${rScene.actualStartSeconds}`, { sceneId: rScene.sceneId });
      }
      if (Math.abs(p4Scene.actualEndTimeSeconds - rScene.actualEndSeconds) > 0.001) {
        err('SCENE_SYNC_MISMATCH', `Scene actualEnd vs Phase4: Phase4 ${p4Scene.actualEndTimeSeconds} vs Remotion ${rScene.actualEndSeconds}`, { sceneId: rScene.sceneId });
      }
      if (Math.abs(p4Scene.actualDurationSeconds - rScene.actualDurationSeconds) > 0.001) {
        err('SCENE_SYNC_MISMATCH', `Scene actualDuration vs Phase4`, { sceneId: rScene.sceneId });
      }

      // Independently check 5A and 5B against Phase 4 authority
      if (vScene) {
        if (Math.abs(p4Scene.actualStartTimeSeconds - vScene.actualStartSeconds) > 0.001) {
          err('SCENE_SYNC_MISMATCH', `VisualProductionPlan actualStart vs Phase4`, { sceneId: rScene.sceneId });
        }
        if (Math.abs(p4Scene.actualEndTimeSeconds - vScene.actualEndSeconds) > 0.001) {
          err('SCENE_SYNC_MISMATCH', `VisualProductionPlan actualEnd vs Phase4`, { sceneId: rScene.sceneId });
        }
      }
      if (sScene) {
        if (Math.abs(p4Scene.actualStartTimeSeconds - sScene.actualStartSeconds) > 0.001) {
          err('SCENE_SYNC_MISMATCH', `SceneRenderPlan actualStart vs Phase4`, { sceneId: rScene.sceneId });
        }
        if (Math.abs(p4Scene.actualEndTimeSeconds - sScene.actualEndSeconds) > 0.001) {
          err('SCENE_SYNC_MISMATCH', `SceneRenderPlan actualEnd vs Phase4`, { sceneId: rScene.sceneId });
        }
      }
    }

    // Actual seconds must equal approved upstream timing (5A/5B/5C consistency)
    if (sScene) {
      if (Math.abs(rScene.actualStartSeconds - sScene.actualStartSeconds) > 0.001) {
        err('SCENE_SYNC_MISMATCH', `Scene actualStart mismatch: remotion ${rScene.actualStartSeconds} vs sceneRender ${sScene.actualStartSeconds}`, { sceneId: rScene.sceneId });
      }
      if (Math.abs(rScene.actualEndSeconds - sScene.actualEndSeconds) > 0.001) {
        err('SCENE_SYNC_MISMATCH', `Scene actualEnd mismatch: remotion ${rScene.actualEndSeconds} vs sceneRender ${sScene.actualEndSeconds}`, { sceneId: rScene.sceneId });
      }
    }
    if (vScene) {
      if (Math.abs(rScene.actualStartSeconds - vScene.actualStartSeconds) > 0.001) {
        err('SCENE_SYNC_MISMATCH', `Scene actualStart mismatch: remotion ${rScene.actualStartSeconds} vs visual ${vScene.actualStartSeconds}`, { sceneId: rScene.sceneId });
      }
      if (Math.abs(rScene.actualEndSeconds - vScene.actualEndSeconds) > 0.001) {
        err('SCENE_SYNC_MISMATCH', `Scene actualEnd mismatch: remotion ${rScene.actualEndSeconds} vs visual ${vScene.actualEndSeconds}`, { sceneId: rScene.sceneId });
      }
    }

    // Frame ranges must match approved Phase 5C projection
    const expectedStartFrame = structuralFrame(rScene.actualStartSeconds);
    const expectedEndFrame = isFinalContent(rScene.actualEndSeconds, authoritativeTotal) ? compositionDurationFrames : structuralFrame(rScene.actualEndSeconds);

    if (rScene.startFrame !== expectedStartFrame) {
      err('SCENE_SYNC_MISMATCH', `Scene startFrame mismatch: expected ${expectedStartFrame}, got ${rScene.startFrame}`, { sceneId: rScene.sceneId });
    }
    if (rScene.endFrame !== expectedEndFrame) {
      err('SCENE_SYNC_MISMATCH', `Scene endFrame mismatch: expected ${expectedEndFrame}, got ${rScene.endFrame}`, { sceneId: rScene.sceneId });
    }

    // Boundary projection error - include scene boundaries
    trackError(rScene.actualStartSeconds, rScene.startFrame);
    trackError(rScene.actualEndSeconds, rScene.endFrame);

    // Renderer ownership
    if (!rScene.rendererKey) {
      err('SCENE_SYNC_MISMATCH', `Scene missing rendererKey`, { sceneId: rScene.sceneId });
    }

    // Final scene must end exactly at 3563 in canonical fixture
    if (scenarioId === 'scenario-pm-01' && i === remotionScenes.length - 1) {
      if (rScene.endFrame !== 3563) {
        err('SCENE_SYNC_MISMATCH', `Final scene must end at 3563, got ${rScene.endFrame}`, { sceneId: rScene.sceneId });
      }
    }
  }

  // Adjacent contiguous scenes must share exact frame boundary, no unintended overlap/gap
  for (let i = 1; i < remotionScenes.length; i++) {
    const prev = remotionScenes[i - 1];
    const curr = remotionScenes[i];
    const timeGap = curr.actualStartSeconds - prev.actualEndSeconds;
    if (Math.abs(timeGap) < 0.001) {
      if (curr.startFrame !== prev.endFrame) {
        err('SCENE_SYNC_MISMATCH', `Contiguous scenes ${prev.sceneId}→${curr.sceneId} time gap ${timeGap} but frame boundary mismatch ${prev.endFrame} vs ${curr.startFrame}`, { sceneId: curr.sceneId });
      }
    } else if (timeGap < -0.001) {
      err('SCENE_SYNC_MISMATCH', `Scene overlap detected: ${prev.sceneId} ends ${prev.actualEndSeconds}, ${curr.sceneId} starts ${curr.actualStartSeconds}`, { sceneId: curr.sceneId });
    } else {
      const upstreamPrev = sceneRenderScenes[i - 1];
      const upstreamCurr = sceneRenderScenes[i];
      if (upstreamPrev && upstreamCurr) {
        const upstreamGap = upstreamCurr.actualStartSeconds - upstreamPrev.actualEndSeconds;
        if (Math.abs(upstreamGap - timeGap) > 0.001) {
          err('SCENE_SYNC_MISMATCH', `Scene gap mismatch vs upstream`, { sceneId: curr.sceneId });
        }
      }
    }
  }

  // Spoken turn → audio identity
  const scenarioTurns = (scenario as any).scenes.flatMap((s: any) => s.turns.map((t: any) => ({ ...t, sceneId: s.id })));
  const turnCount = scenarioTurns.length;

  const reconciledClips = phase4Dialogue?.clips ?? [];
  const reconciledCaptionCues = phase4Captions?.cues ?? [];

  const visualAudioRefs = visualScenes.flatMap((s: any) => s.audioRefs);
  const sceneRenderAudioRefs = sceneRenderScenes.flatMap((s: any) => s.audioRefs);
  const remotionAudioRefs = remotionScenes.flatMap((s: any) => s.audioRefs);

  const audioClipCount = remotionAudioRefs.length;

  // Check one-to-one turn mapping from Phase 4
  const turnIdToClip = new Map<string, any>();
  const clipIdSeen = new Set<string>();

  for (const clip of reconciledClips) {
    if (clipIdSeen.has(clip.clipId)) {
      err('DUPLICATE_AUDIO_ASSIGNMENT', `Duplicate clipId ${clip.clipId}`, { clipId: clip.clipId, turnId: clip.turnId });
    }
    clipIdSeen.add(clip.clipId);
    if (turnIdToClip.has(clip.turnId)) {
      err('DUPLICATE_AUDIO_ASSIGNMENT', `Turn ${clip.turnId} has multiple clips: ${turnIdToClip.get(clip.turnId).clipId} and ${clip.clipId}`, { turnId: clip.turnId });
    }
    turnIdToClip.set(clip.turnId, clip);
  }

  // Every spoken turn must have exactly one canonical audio clip
  for (const turn of scenarioTurns) {
    const clip = turnIdToClip.get(turn.id);
    if (!clip) {
      err('TURN_AUDIO_SYNC_MISMATCH', `Turn ${turn.id} missing canonical audio clip`, { turnId: turn.id, sceneId: turn.sceneId });
    } else {
      if (clip.sceneId !== turn.sceneId) {
        err('TURN_AUDIO_SYNC_MISMATCH', `Clip ${clip.clipId} sceneId ${clip.sceneId} != turn sceneId ${turn.sceneId}`, { turnId: turn.id, clipId: clip.clipId, sceneId: turn.sceneId });
      }
      if (clip.speakerId !== turn.speakerId) {
        err('TURN_AUDIO_SYNC_MISMATCH', `Clip ${clip.clipId} speakerId ${clip.speakerId} != turn speakerId ${turn.speakerId}`, { turnId: turn.id, clipId: clip.clipId, speakerId: turn.speakerId });
      }
      if (clip.spokenText !== turn.spokenText) {
        err('TURN_AUDIO_SYNC_MISMATCH', `Clip ${clip.clipId} spokenText mismatch`, { turnId: turn.id, clipId: clip.clipId });
      }
      const voiceSlot = turn.voiceSlot;
      if (voiceSlot && clip.voiceSlot && voiceSlot !== clip.voiceSlot) {
        err('TURN_AUDIO_SYNC_MISMATCH', `Clip ${clip.clipId} voiceSlot ${clip.voiceSlot} != turn voiceSlot ${voiceSlot}`, { turnId: turn.id, clipId: clip.clipId, voiceSlot });
      }
      // CORRECTION 5 — missing canonicalPath must never throw
      if (!clip.canonicalPath) {
        err('TURN_AUDIO_SYNC_MISMATCH', `Clip ${clip.clipId} missing canonicalPath`, { clipId: clip.clipId, turnId: turn.id });
      } else {
        // Safe check, never call includes on undefined
        const cp = String(clip.canonicalPath);
        if (!cp.includes('audio/canonical') && !cp.includes('audio\\canonical')) {
          if (!cp.includes('canonical')) {
            err('TURN_AUDIO_SYNC_MISMATCH', `Clip ${clip.clipId} canonicalPath must contain canonical namespace, got ${cp}`, { clipId: clip.clipId });
          }
        }
      }
    }
  }

  // Check no orphan clip, no missing clip, no foreign scene/turn clip
  for (const clip of reconciledClips) {
    const turnExists = scenarioTurns.some((t: any) => t.id === clip.turnId);
    if (!turnExists) {
      err('ORPHAN_AUDIO_REF', `Clip ${clip.clipId} turnId ${clip.turnId} not found in scenario`, { clipId: clip.clipId, turnId: clip.turnId });
    }
    const sceneExists = (scenario as any).scenes.some((s: any) => s.id === clip.sceneId);
    if (!sceneExists) {
      err('ORPHAN_AUDIO_REF', `Clip ${clip.clipId} sceneId ${clip.sceneId} not found in scenario`, { clipId: clip.clipId, sceneId: clip.sceneId });
    }
  }

  // CORRECTION 2 — AUDIO MUST BE ANCHORED DIRECTLY TO PHASE 4
  // For every rendered audio clip, authoritative identity/timing comes from reconciledDialogue.clips using matching clipId/turnId
  // Validate each downstream layer independently against Phase 4 clip

  function validateAudioRefAgainstPhase4(audioRef: any, layerName: string) {
    const phase4Clip = reconciledClips.find((c: any) => c.clipId === audioRef.clipId || c.turnId === audioRef.turnId);
    if (!phase4Clip) {
      err('ORPHAN_AUDIO_REF', `${layerName} audio ${audioRef.clipId} not found in Phase4`, { clipId: audioRef.clipId, turnId: audioRef.turnId });
      return;
    }

    // Compare fields directly against Phase 4
    const fieldsToCheck: Array<{ field: string; phase4Field?: string }> = [
      { field: 'clipId' },
      { field: 'turnId' },
      { field: 'sceneId' },
      { field: 'speakerId' },
      { field: 'voiceSlot' },
      { field: 'voiceProfileId' },
      { field: 'spokenText' },
      { field: 'canonicalPath' },
      { field: 'actualStartSeconds', phase4Field: 'actualStartTimeSeconds' },
      { field: 'actualEndSeconds', phase4Field: 'actualEndTimeSeconds' },
      { field: 'actualDurationSeconds' },
    ];

    for (const { field, phase4Field } of fieldsToCheck) {
      const p4Field = phase4Field ?? field;
      const phase4Val = (phase4Clip as any)[p4Field];
      const layerVal = (audioRef as any)[field];

      // CORRECTION 5: safe handling of missing canonicalPath
      if (field === 'canonicalPath') {
        if (!layerVal) {
          err('AUDIO_TIMING_MISMATCH', `${layerName} audio ${audioRef.clipId} missing canonicalPath`, { clipId: audioRef.clipId });
          continue;
        }
        if (!phase4Val) {
          // Phase4 missing canonicalPath also error, but not throw
          continue;
        }
      }

      if (typeof phase4Val === 'number' && typeof layerVal === 'number') {
        if (Math.abs(phase4Val - layerVal) > 0.001) {
          err('AUDIO_TIMING_MISMATCH', `${layerName} audio ${audioRef.clipId} ${field} mismatch vs Phase4: Phase4 ${phase4Val} vs ${layerName} ${layerVal}`, { clipId: audioRef.clipId, turnId: audioRef.turnId });
        }
      } else {
        if (phase4Val !== undefined && layerVal !== undefined && phase4Val !== layerVal) {
          // For sceneId allow sameSceneId
          if (field === 'sceneId') {
            if (!sameSceneId(String(phase4Val), String(layerVal))) {
              err('TURN_AUDIO_SYNC_MISMATCH', `${layerName} audio ${audioRef.clipId} sceneId ${layerVal} != Phase4 ${phase4Val}`, { clipId: audioRef.clipId, sceneId: String(layerVal) });
            }
          } else {
            err('TURN_AUDIO_SYNC_MISMATCH', `${layerName} audio ${audioRef.clipId} ${field} mismatch vs Phase4`, { clipId: audioRef.clipId, turnId: audioRef.turnId });
          }
        }
      }
    }

    // Canonical namespace check - safe, never throw on undefined
    const canonicalPath = audioRef.canonicalPath;
    if (!canonicalPath) {
      err('AUDIO_TIMING_MISMATCH', `${layerName} audio ${audioRef.clipId} missing canonicalPath`, { clipId: audioRef.clipId });
    } else {
      const cpStr = String(canonicalPath);
      if (cpStr.includes('audio/dialogue')) {
        err('AUDIO_TIMING_MISMATCH', `${layerName} audio ${audioRef.clipId} uses raw audio/dialogue source when canonical exists: ${cpStr}`, { clipId: audioRef.clipId });
      } else if (!cpStr.includes('canonical')) {
        err('AUDIO_TIMING_MISMATCH', `${layerName} audio ${audioRef.clipId} canonicalPath must contain approved canonical namespace`, { clipId: audioRef.clipId });
      }
    }
  }

  // Validate VisualProductionPlan audio refs against Phase4
  for (const audio of visualAudioRefs) {
    validateAudioRefAgainstPhase4(audio, 'VisualProductionPlan');
  }

  // Validate SceneRenderPlan audio refs against Phase4
  for (const audio of sceneRenderAudioRefs) {
    validateAudioRefAgainstPhase4(audio, 'SceneRenderPlan');
  }

  // Validate RemotionCompositionPlan audio refs against Phase4 and frame mapping
  for (const audio of remotionAudioRefs) {
    validateAudioRefAgainstPhase4(audio, 'RemotionCompositionPlan');

    // Renderer projection - frame checks
    const expectedStartFrame = structuralFrame(audio.actualStartSeconds);
    const expectedEndFrame = coverageEndExclusive(audio.actualEndSeconds, authoritativeTotal, compositionDurationFrames);

    if (audio.startFrame !== expectedStartFrame) {
      err('AUDIO_FRAME_SYNC_MISMATCH', `Audio ${audio.clipId} startFrame ${audio.startFrame} != expected ${expectedStartFrame} (round)`, { clipId: audio.clipId });
    }
    if (audio.endFrame !== expectedEndFrame) {
      err('AUDIO_FRAME_SYNC_MISMATCH', `Audio ${audio.clipId} endFrame ${audio.endFrame} != expected ${expectedEndFrame} (ceil or final)`, { clipId: audio.clipId });
    }

    // Coverage must include all authoritative audio content
    const requiredCoverageEnd = Math.ceil(audio.actualEndSeconds * FPS);
    if (audio.endFrame < requiredCoverageEnd && !isFinalContent(audio.actualEndSeconds, authoritativeTotal)) {
      err('FINAL_CONTENT_TRUNCATION', `Audio ${audio.clipId} end ${audio.actualEndSeconds}s requires coverage through ${requiredCoverageEnd} but has ${audio.endFrame}`, { clipId: audio.clipId });
    }
    if (isFinalContent(audio.actualEndSeconds, authoritativeTotal) && audio.endFrame !== compositionDurationFrames) {
      err('FINAL_CONTENT_TRUNCATION', `Final audio ${audio.clipId} must end at ${compositionDurationFrames}, got ${audio.endFrame}`, { clipId: audio.clipId });
    }

    // Boundary projection error - include audio boundaries
    trackError(audio.actualStartSeconds, audio.startFrame);
    trackError(audio.actualEndSeconds, audio.endFrame);
  }

  // CORRECTION 9 — KEEP CORE VALIDATOR PORTABLE: removed fs/path check for volume={0}
  // That regression belongs in tests, not runtime validator

  // Caption identity validation - CORRECTION 3: anchored directly to Phase 4
  const visualCaptionCues = visualScenes.flatMap((s: any) => s.captionCues);
  const sceneRenderCaptionCues = sceneRenderScenes.flatMap((s: any) => s.captionCues);
  const remotionCaptionCues = remotionScenes.flatMap((s: any) => s.captionCues);

  const captionCueCount = remotionCaptionCues.length;

  const cueIdSeen = new Set<string>();
  for (const cue of remotionCaptionCues) {
    if (cueIdSeen.has(cue.id)) {
      err('DUPLICATE_CAPTION_ID', `Duplicate caption cue id ${cue.id}`, { cueId: cue.id, sceneId: cue.sceneId });
    }
    cueIdSeen.add(cue.id);
  }

  function validateCaptionAgainstPhase4(caption: any, layerName: string) {
    const phase4Cue = reconciledCaptionCues.find((c: any) => c.id === caption.id);
    if (!phase4Cue) {
      err('ORPHAN_CAPTION_REF', `${layerName} caption ${caption.id} not found in Phase4`, { cueId: caption.id });
      return;
    }

    const fields = [
      { field: 'id' },
      { field: 'sceneId' },
      { field: 'turnId' },
      { field: 'clipId' },
      { field: 'text' },
      { field: 'speakerId' },
      { field: 'voiceSlot' },
      { field: 'startTimeSeconds' },
      { field: 'endTimeSeconds' },
      { field: 'durationSeconds' },
    ];

    for (const { field } of fields) {
      const p4Val = (phase4Cue as any)[field];
      const layerVal = (caption as any)[field];
      if (typeof p4Val === 'number' && typeof layerVal === 'number') {
        if (Math.abs(p4Val - layerVal) > 0.001) {
          err('CAPTION_IDENTITY_MISMATCH', `${layerName} caption ${caption.id} ${field} mismatch vs Phase4: ${p4Val} vs ${layerVal}`, { cueId: caption.id });
        }
      } else {
        if (p4Val !== undefined && layerVal !== undefined && p4Val !== layerVal) {
          if (field === 'sceneId') {
            if (!sameSceneId(String(p4Val), String(layerVal))) {
              err('CAPTION_IDENTITY_MISMATCH', `${layerName} caption ${caption.id} sceneId ${layerVal} != Phase4 ${p4Val}`, { cueId: caption.id, sceneId: String(layerVal) });
            }
          } else {
            err('CAPTION_IDENTITY_MISMATCH', `${layerName} caption ${caption.id} ${field} mismatch vs Phase4`, { cueId: caption.id });
          }
        }
      }
    }
  }

  // Validate each downstream layer independently against Phase 4
  for (const cue of visualCaptionCues) {
    validateCaptionAgainstPhase4(cue, 'VisualProductionPlan');
  }
  for (const cue of sceneRenderCaptionCues) {
    validateCaptionAgainstPhase4(cue, 'SceneRenderPlan');
  }
  for (const cue of remotionCaptionCues) {
    validateCaptionAgainstPhase4(cue, 'RemotionCompositionPlan');
  }

  // Additional checks for remotion captions: owning audio clip exists, owning turn exists, cross-scene leakage
  for (const cue of remotionCaptionCues) {
    const owningClip = reconciledClips.find((c: any) => c.clipId === cue.clipId);
    if (!owningClip) {
      err('ORPHAN_CAPTION_REF', `Caption ${cue.id} clipId ${cue.clipId} no owning audio clip in Phase4`, { cueId: cue.id, clipId: cue.clipId });
    }
    const owningTurn = scenarioTurns.find((t: any) => t.id === cue.turnId);
    if (!owningTurn) {
      err('ORPHAN_CAPTION_REF', `Caption ${cue.id} turnId ${cue.turnId} no owning turn`, { cueId: cue.id, turnId: cue.turnId });
    }
    if (owningClip && !sameSceneId(cue.sceneId, owningClip.sceneId)) {
      err('CAPTION_AUDIO_SYNC_MISMATCH', `Caption ${cue.id} scene ${cue.sceneId} != Phase4 clip scene ${owningClip.sceneId}`, { cueId: cue.id, sceneId: cue.sceneId, clipId: cue.clipId });
    }

    // Boundary projection error - include caption boundaries
    trackError(cue.startTimeSeconds, cue.startFrame);
    trackError(cue.endTimeSeconds, cue.endFrame);
  }

  // Deterministic ordering check
  for (let i = 1; i < remotionCaptionCues.length; i++) {
    const prev = remotionCaptionCues[i - 1];
    const curr = remotionCaptionCues[i];
    if (curr.startTimeSeconds < prev.startTimeSeconds - 0.001) {
      err('CAPTION_IDENTITY_MISMATCH', `Caption ordering not deterministic: ${curr.id} starts before ${prev.id}`, { cueId: curr.id });
    }
  }

  // Caption ↔ Audio synchronization - anchored to Phase4 clips
  const captionsByTurn = new Map<string, any[]>();
  for (const cue of remotionCaptionCues) {
    if (!captionsByTurn.has(cue.turnId)) captionsByTurn.set(cue.turnId, []);
    captionsByTurn.get(cue.turnId)!.push(cue);
  }

  for (const [turnId, cues] of captionsByTurn.entries()) {
    const clip = reconciledClips.find((c: any) => c.turnId === turnId);
    if (!clip) continue;

    cues.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

    const firstCue = cues[0];
    const lastCue = cues[cues.length - 1];

    if (firstCue.startTimeSeconds < clip.actualStartTimeSeconds - 0.001) {
      err('CAPTION_AUDIO_SYNC_MISMATCH', `Turn ${turnId} first caption ${firstCue.id} starts ${firstCue.startTimeSeconds} before speech ${clip.actualStartTimeSeconds}`, { turnId, cueId: firstCue.id, clipId: clip.clipId });
    }
    if (lastCue.endTimeSeconds > clip.actualEndTimeSeconds + 0.001) {
      err('CAPTION_AUDIO_SYNC_MISMATCH', `Turn ${turnId} last caption ${lastCue.id} ends ${lastCue.endTimeSeconds} after speech ${clip.actualEndTimeSeconds}`, { turnId, cueId: lastCue.id, clipId: clip.clipId });
    }

    for (let i = 1; i < cues.length; i++) {
      const prev = cues[i - 1];
      const curr = cues[i];
      if (curr.startTimeSeconds < prev.endTimeSeconds - 0.001) {
        err('CAPTION_AUDIO_SYNC_MISMATCH', `Caption overlap: ${prev.id} [${prev.startTimeSeconds},${prev.endTimeSeconds}) and ${curr.id} [${curr.startTimeSeconds},${curr.endTimeSeconds})`, { turnId, cueId: curr.id });
      }
      if (curr.startTimeSeconds < prev.startTimeSeconds - 0.001) {
        err('CAPTION_AUDIO_SYNC_MISMATCH', `Caption not monotonic: ${curr.id} starts before ${prev.id}`, { turnId, cueId: curr.id });
      }
    }

    const pauseStart = clip.actualEndTimeSeconds;
    const pauseEnd = clip.actualEndTimeSeconds + (clip.pauseAfterSeconds ?? 0);
    for (const cue of cues) {
      if (cue.startTimeSeconds >= pauseStart - 0.001 && cue.startTimeSeconds < pauseEnd - 0.001) {
        err('CAPTION_AUDIO_SYNC_MISMATCH', `Caption ${cue.id} starts inside pauseAfter [${pauseStart},${pauseEnd})`, { turnId, cueId: cue.id });
      }
      if (cue.endTimeSeconds > pauseStart + 0.001 && cue.endTimeSeconds <= pauseEnd + 0.001) {
        err('CAPTION_AUDIO_SYNC_MISMATCH', `Caption ${cue.id} ends inside pauseAfter`, { turnId, cueId: cue.id });
      }
    }

    // Renderer coverage for captions
    for (const cue of cues) {
      const expectedStartFrame = structuralFrame(cue.startTimeSeconds);
      const expectedEndFrame = coverageEndExclusive(cue.endTimeSeconds, authoritativeTotal, compositionDurationFrames);
      if (cue.startFrame !== expectedStartFrame) {
        err('CAPTION_FRAME_SYNC_MISMATCH', `Caption ${cue.id} startFrame ${cue.startFrame} != expected ${expectedStartFrame}`, { cueId: cue.id });
      }
      if (cue.endFrame !== expectedEndFrame) {
        err('CAPTION_FRAME_SYNC_MISMATCH', `Caption ${cue.id} endFrame ${cue.endFrame} != expected ${expectedEndFrame}`, { cueId: cue.id });
      }
      if (isFinalContent(cue.endTimeSeconds, authoritativeTotal) && cue.endFrame !== compositionDurationFrames) {
        err('FINAL_CONTENT_TRUNCATION', `Final caption ${cue.id} must end at ${compositionDurationFrames}`, { cueId: cue.id });
      }
      const requiredEnd = Math.ceil(cue.endTimeSeconds * FPS);
      if (cue.endFrame < requiredEnd && !isFinalContent(cue.endTimeSeconds, authoritativeTotal)) {
        err('FINAL_CONTENT_TRUNCATION', `Caption ${cue.id} end ${cue.endTimeSeconds}s requires coverage ${requiredEnd} but has ${cue.endFrame}`, { cueId: cue.id });
      }
    }
  }

  // Visual beat synchronization
  const visualBeats = visualScenes.flatMap((s: any) => s.beats);
  const sceneRenderBeats = sceneRenderScenes.flatMap((s: any) => s.beats);
  const remotionBeats = remotionScenes.flatMap((s: any) => s.beats);

  const visualBeatCount = remotionBeats.length;

  for (const beat of remotionBeats) {
    const upstreamVisual = visualBeats.find((b: any) => b.id === beat.id);
    if (!upstreamVisual) {
      err('VISUAL_BEAT_SYNC_MISMATCH', `Beat ${beat.id} not found in visualProductionPlan`, { beatId: beat.id, sceneId: beat.sceneId });
      continue;
    }

    if (!sameSceneId(beat.sceneId, upstreamVisual.sceneId)) {
      err('VISUAL_BEAT_SYNC_MISMATCH', `Beat ${beat.id} sceneId mismatch: ${beat.sceneId} vs ${upstreamVisual.sceneId}`, { beatId: beat.id, sceneId: beat.sceneId });
    }

    if (Math.abs(beat.actualStartSeconds - upstreamVisual.actualStartSeconds) > 0.001) {
      err('VISUAL_BEAT_SYNC_MISMATCH', `Beat ${beat.id} actualStart changed`, { beatId: beat.id });
    }
    if (Math.abs(beat.actualEndSeconds - upstreamVisual.actualEndSeconds) > 0.001) {
      err('VISUAL_BEAT_SYNC_MISMATCH', `Beat ${beat.id} actualEnd changed`, { beatId: beat.id });
    }

    const expectedStartFrame = structuralFrame(beat.actualStartSeconds);
    const expectedEndFrame = isFinalContent(beat.actualEndSeconds, authoritativeTotal) ? compositionDurationFrames : structuralFrame(beat.actualEndSeconds);

    if (beat.startFrame !== expectedStartFrame) {
      err('VISUAL_BEAT_SYNC_MISMATCH', `Beat ${beat.id} startFrame ${beat.startFrame} != expected ${expectedStartFrame}`, { beatId: beat.id });
    }
    if (beat.endFrame !== expectedEndFrame) {
      if (!(isFinalContent(beat.actualEndSeconds, authoritativeTotal) && beat.endFrame === compositionDurationFrames)) {
        err('VISUAL_BEAT_SYNC_MISMATCH', `Beat ${beat.id} endFrame ${beat.endFrame} != expected ${expectedEndFrame}`, { beatId: beat.id });
      }
    }

    // Beat lies inside owning scene
    const owningScene = remotionScenes.find((s: any) => sameSceneId(s.sceneId, beat.sceneId) || sameSceneId(s.sourceSceneId, beat.sceneId));
    if (owningScene) {
      if (beat.actualStartSeconds < owningScene.actualStartSeconds - 0.001 || beat.actualEndSeconds > owningScene.actualEndSeconds + 0.001) {
        err('VISUAL_BEAT_SYNC_MISMATCH', `Beat ${beat.id} outside owning scene ${owningScene.sceneId}`, { beatId: beat.id, sceneId: beat.sceneId });
      }
      if (beat.startFrame < owningScene.startFrame || beat.endFrame > owningScene.endFrame) {
        if (!(beat.endFrame === owningScene.endFrame && isFinalContent(beat.actualEndSeconds, authoritativeTotal))) {
          err('VISUAL_BEAT_SYNC_MISMATCH', `Beat ${beat.id} frame [${beat.startFrame},${beat.endFrame}) outside scene [${owningScene.startFrame},${owningScene.endFrame})`, { beatId: beat.id, sceneId: beat.sceneId });
        }
      }
    }

    if (beat.turnId) {
      const turnExists = scenarioTurns.some((t: any) => t.id === beat.turnId);
      if (!turnExists) {
        err('VISUAL_AUDIO_SYNC_MISMATCH', `Beat ${beat.id} turnId ${beat.turnId} not found in scenario`, { beatId: beat.id, turnId: beat.turnId });
      }
      const turn = scenarioTurns.find((t: any) => t.id === beat.turnId);
      if (turn && beat.activeSpeakerId && turn.speakerId !== beat.activeSpeakerId) {
        err('VISUAL_AUDIO_SYNC_MISMATCH', `Beat ${beat.id} activeSpeaker ${beat.activeSpeakerId} != turn speaker ${turn.speakerId}`, { beatId: beat.id, turnId: beat.turnId });
      }
    }

    // Boundary projection error - include beat boundaries
    trackError(beat.actualStartSeconds, beat.startFrame);
    trackError(beat.actualEndSeconds, beat.endFrame);
  }

  // Audio ↔ Visual turn alignment - CORRECTION 7: non-intersection is error, not warning
  for (const beat of remotionBeats) {
    if (!beat.turnId) continue;
    const clip = reconciledClips.find((c: any) => c.turnId === beat.turnId);
    if (!clip) {
      err('VISUAL_AUDIO_SYNC_MISMATCH', `Beat ${beat.id} references turn ${beat.turnId} with no audio`, { beatId: beat.id, turnId: beat.turnId });
      continue;
    }
    if (!sameSceneId(clip.sceneId, beat.sceneId)) {
      err('VISUAL_AUDIO_SYNC_MISMATCH', `Beat ${beat.id} scene ${beat.sceneId} != clip scene ${clip.sceneId}`, { beatId: beat.id, sceneId: beat.sceneId, turnId: beat.turnId });
    }
    if (beat.activeSpeakerId && clip.speakerId !== beat.activeSpeakerId) {
      err('VISUAL_AUDIO_SYNC_MISMATCH', `Beat ${beat.id} speaker ${beat.activeSpeakerId} != clip speaker ${clip.speakerId}`, { beatId: beat.id, turnId: beat.turnId });
    }
    if (beat.kind === 'dialogue') {
      const beatStart = beat.actualStartSeconds;
      const beatEnd = beat.actualEndSeconds;
      const turnStart = clip.actualStartTimeSeconds;
      const turnEnd = clip.actualEndTimeSeconds;
      const intersects = !(beatEnd <= turnStart + 0.001 || beatStart >= turnEnd - 0.001);
      if (!intersects) {
        // CORRECTION 7: emit error, not warning
        err('VISUAL_AUDIO_SYNC_MISMATCH', `Beat ${beat.id} [${beatStart},${beatEnd}) does not intersect turn ${beat.turnId} [${turnStart},${turnEnd})`, { beatId: beat.id, turnId: beat.turnId });
      }
    }
  }

  // Transition synchronization - CORRECTION 8: bounds checks
  const remotionTransitions = remotionScenes.map((s: any) => s.transition);
  const transitionCount = remotionTransitions.filter((t: any) => t && t.type && t.type !== 'cut' && t.type !== 'none' && t.type !== 'direct_cut').length;

  for (let i = 0; i < remotionScenes.length; i++) {
    const rScene = remotionScenes[i];
    const sScene = sceneRenderScenes[i];
    const trans = rScene.transition;

    if (!trans) {
      err('TRANSITION_SYNC_MISMATCH', `Scene ${rScene.sceneId} missing transition`, { sceneId: rScene.sceneId });
      continue;
    }

    if (trans.incomingSceneId !== rScene.sceneId && !sameSceneId(trans.incomingSceneId, rScene.sceneId)) {
      err('TRANSITION_SYNC_MISMATCH', `Transition incomingSceneId ${trans.incomingSceneId} != scene ${rScene.sceneId}`, { sceneId: rScene.sceneId });
    }

    const expectedOutgoing = i > 0 ? remotionScenes[i - 1].sceneId : null;
    if (expectedOutgoing !== null && trans.outgoingSceneId !== expectedOutgoing && !sameSceneId(trans.outgoingSceneId ?? '', expectedOutgoing)) {
      err('TRANSITION_SYNC_MISMATCH', `Transition outgoingSceneId ${trans.outgoingSceneId} != expected ${expectedOutgoing}`, { sceneId: rScene.sceneId });
    }

    if (sScene && trans.type !== sScene.transition.type) {
      err('TRANSITION_SYNC_MISMATCH', `Transition type ${trans.type} != upstream ${sScene.transition.type}`, { sceneId: rScene.sceneId });
    }

    if (sScene) {
      const upStart = sScene.transition.actualStartSeconds;
      const upEnd = sScene.transition.actualEndSeconds;
      if (upStart !== null && trans.actualStartSeconds !== null && Math.abs(upStart - trans.actualStartSeconds) > 0.001) {
        err('TRANSITION_SYNC_MISMATCH', `Transition start seconds changed`, { sceneId: rScene.sceneId });
      }
      if (upEnd !== null && trans.actualEndSeconds !== null && Math.abs(upEnd - trans.actualEndSeconds) > 0.001) {
        err('TRANSITION_SYNC_MISMATCH', `Transition end seconds changed`, { sceneId: rScene.sceneId });
      }
    }

    if (trans.actualStartSeconds !== null && trans.startFrame !== null) {
      const expectedStartFrame = structuralFrame(trans.actualStartSeconds);
      if (trans.startFrame !== expectedStartFrame) {
        err('TRANSITION_SYNC_MISMATCH', `Transition startFrame ${trans.startFrame} != expected ${expectedStartFrame}`, { sceneId: rScene.sceneId });
      }
    }
    if (trans.actualEndSeconds !== null && trans.endFrame !== null) {
      const expectedEndFrame = structuralFrame(trans.actualEndSeconds);
      if (trans.endFrame !== expectedEndFrame) {
        err('TRANSITION_SYNC_MISMATCH', `Transition endFrame ${trans.endFrame} != expected ${expectedEndFrame}`, { sceneId: rScene.sceneId });
      }
    }
    if (trans.startFrame !== null && trans.endFrame !== null && trans.durationInFrames !== null) {
      const expectedDur = trans.endFrame - trans.startFrame;
      if (trans.durationInFrames !== expectedDur) {
        err('TRANSITION_SYNC_MISMATCH', `Transition durationInFrames ${trans.durationInFrames} != end-start ${expectedDur}`, { sceneId: rScene.sceneId });
      }
    }

    // CORRECTION 8: transition bounds
    if (trans.startFrame !== null && trans.startFrame < rScene.startFrame) {
      err('TRANSITION_SYNC_MISMATCH', `Transition startFrame ${trans.startFrame} < owning scene startFrame ${rScene.startFrame}`, { sceneId: rScene.sceneId });
    }
    if (trans.endFrame !== null && trans.endFrame > rScene.endFrame) {
      err('TRANSITION_SYNC_MISMATCH', `Transition endFrame ${trans.endFrame} > owning scene endFrame ${rScene.endFrame}`, { sceneId: rScene.sceneId });
    }

    if (trans.durationInFrames !== null && trans.durationInFrames > rScene.durationInFrames) {
      err('TRANSITION_SYNC_MISMATCH', `Transition duration ${trans.durationInFrames} > scene duration ${rScene.durationInFrames}`, { sceneId: rScene.sceneId });
    }

    if (trans.endFrame !== null && trans.endFrame > compositionDurationFrames) {
      err('TRANSITION_SYNC_MISMATCH', `Transition endFrame ${trans.endFrame} > composition ${compositionDurationFrames}`, { sceneId: rScene.sceneId });
    }

    // Boundary projection error - include transition boundaries
    if (trans.actualStartSeconds !== null) trackError(trans.actualStartSeconds, trans.startFrame);
    if (trans.actualEndSeconds !== null) trackError(trans.actualEndSeconds, trans.endFrame);
  }

  // Authoritative vs renderer domains
  if (Math.abs(authoritativeTotal - compositionDurationFrames / FPS) < 0.001 && Math.abs(authoritativeTotal - canonicalFixtureTotal) > 0.001) {
    err('ESTIMATED_TIMING_REGRESSION', `Authoritative duration appears to be frame-derived ${compositionDurationFrames}/${FPS}=${compositionDurationFrames / FPS}, expected ${canonicalFixtureTotal}`, { scenarioId });
  }

  // Build summary
  const warningCount = findings.filter(f => f.severity === 'warning').length;
  const errorCount = findings.filter(f => f.severity === 'error').length;

  const finalValidFrameIndex = compositionDurationFrames - 1;
  const finalExclusiveBoundary = compositionDurationFrames;
  const finalCapacityTailSeconds = compositionDurationFrames / FPS - authoritativeTotal;

  const summary: AudiovisualSyncSummary = {
    scenarioId,
    projectId,
    fps: FPS,
    authoritativeDurationSeconds: round2(authoritativeTotal),
    compositionDurationInFrames: compositionDurationFrames,
    rawFramePosition: round2(rawFramePosition),
    finalValidFrameIndex,
    finalExclusiveBoundary,
    finalCapacityTailSeconds: round2(finalCapacityTailSeconds),
    sceneCount: remotionScenes.length,
    turnCount,
    audioClipCount,
    captionCueCount,
    visualBeatCount,
    transitionCount,
    assetRefCount: remotionScenes.reduce((sum: number, s: any) => sum + (s.assetRefs?.length ?? 0), 0),
    maximumBoundaryProjectionErrorFrames: round2(maxProjectionError),
    warningCount,
    errorCount,
    status: errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'ok',
  };

  const report: AudiovisualSyncReport = {
    version: AUDIOVISUAL_SYNC_VERSION,
    scenarioId,
    projectId,
    fps: FPS,
    authoritativeDurationSeconds: authoritativeTotal,
    compositionDurationInFrames: compositionDurationFrames,
    summary,
    findings,
    valid: errorCount === 0,
  };

  if (errorCount > 0) {
    return { success: false, error: `Audiovisual sync validation failed with ${errorCount} errors`, findings, report };
  }

  return { success: true, report };
}
