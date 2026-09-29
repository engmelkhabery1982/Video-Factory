/**
 * BuildTrack Video Factory - Phase 4E Dialogue Production Validation
 *
 * Cross-phase identity validation and final invariant enforcement.
 * Validates continuity across all Phase 4 layers.
 */

import { Scenario } from './types.js';
import { DialogueAudioPlan } from './dialogue-audio-types.js';
import { DialogueAudioPlanVoiceResolution } from './voice-types.js';
import { DialogueSynthesisManifest } from './audio-synthesis-types.js';
import { CanonicalDialogueAudioManifest } from './audio-validation-types.js';
import { ReconciledDialogueAudioPlan, ReconciledPlaybackPlan, ReconciledCaptionPlan } from './timing-reconciliation-types.js';
import { ScenarioVisualPlan } from './visual-plan-types.js';
import { ScenarioCaptionPlan } from './scenario-caption-types.js';
import {
  DialogueProductionFinding,
  DialogueProductionErrorCode,
  DialogueProductionError,
} from './dialogue-production-types.js';

function makeFinding(
  severity: 'error' | 'warning',
  code: DialogueProductionErrorCode,
  message: string,
  location?: DialogueProductionFinding['location']
): DialogueProductionFinding {
  return { severity, code, message, location };
}

/** Cross-phase identity validation */
export function validateDialogueProductionIdentities(inputs: {
  scenario: Scenario;
  dialoguePlan: DialogueAudioPlan;
  voiceResolution: DialogueAudioPlanVoiceResolution;
  synthesisManifest: DialogueSynthesisManifest;
  canonicalManifest: CanonicalDialogueAudioManifest;
  reconciledDialogue: ReconciledDialogueAudioPlan;
  reconciledPlayback: ReconciledPlaybackPlan;
  reconciledCaptions: ReconciledCaptionPlan;
  visualPlan: ScenarioVisualPlan;
  captionPlan: ScenarioCaptionPlan;
}): DialogueProductionFinding[] {
  const findings: DialogueProductionFinding[] = [];
  const {
    scenario,
    dialoguePlan,
    voiceResolution,
    synthesisManifest,
    canonicalManifest,
    reconciledDialogue,
    reconciledPlayback,
    reconciledCaptions,
    visualPlan,
    captionPlan,
  } = inputs;

  // Helper to push error
  const err = (code: DialogueProductionErrorCode, msg: string, loc?: any) => {
    findings.push(makeFinding('error', code, msg, loc));
  };

  // scenarioId
  const scenarioId = scenario.metadata.id;
  const checks: Array<[string, string, string]> = [
    ['dialoguePlan', dialoguePlan.scenarioId, scenarioId],
    ['canonicalManifest', canonicalManifest.scenarioId, scenarioId],
    ['reconciledDialogue', reconciledDialogue.scenarioId, scenarioId],
    ['reconciledPlayback', reconciledPlayback.scenarioId, scenarioId],
    ['reconciledCaptions', reconciledCaptions.scenarioId, scenarioId],
    ['visualPlan', (visualPlan as any).scenarioId ?? scenarioId, scenarioId], // visual plan may not have scenarioId? Check
    ['captionPlan', captionPlan.scenarioId, scenarioId],
    ['synthesisManifest', synthesisManifest.scenarioId, scenarioId],
    ['voiceResolution', voiceResolution.scenarioId, scenarioId],
  ];
  // visualPlan actually has no scenarioId in its type? Let's check — compile-visual-plan has scenarioId? We skip if not present
  // For safety, we check only if present
  for (const [name, actual, expected] of checks) {
    if (actual !== undefined && actual !== expected) {
      err('PIPELINE_IDENTITY_MISMATCH', `${name}.scenarioId mismatch: expected '${expected}', got '${actual}'`, { scenarioId: expected });
    }
  }

  // projectId
  if (dialoguePlan.projectId !== scenario.metadata.projectId) {
    err('PIPELINE_IDENTITY_MISMATCH', `dialoguePlan.projectId mismatch: expected '${scenario.metadata.projectId}', got '${dialoguePlan.projectId}'`);
  }
  if (reconciledDialogue.projectId !== scenario.metadata.projectId) {
    err('PIPELINE_IDENTITY_MISMATCH', `reconciledDialogue.projectId mismatch`);
  }

  // language
  if (dialoguePlan.language !== scenario.metadata.language) {
    err('PIPELINE_IDENTITY_MISMATCH', `dialoguePlan.language mismatch`);
  }
  if (canonicalManifest.language !== scenario.metadata.language) {
    err('PIPELINE_IDENTITY_MISMATCH', `canonicalManifest.language mismatch`);
  }

  // targetFormat
  if (dialoguePlan.targetFormat !== scenario.metadata.targetFormat) {
    err('PIPELINE_IDENTITY_MISMATCH', `dialoguePlan.targetFormat mismatch`);
  }
  if (reconciledDialogue.targetFormat !== scenario.metadata.targetFormat) {
    err('PIPELINE_IDENTITY_MISMATCH', `reconciledDialogue.targetFormat mismatch`);
  }

  // scene order and IDs
  const scenarioSceneIds = scenario.scenes.map(s => s.id);
  const dialogueSceneIds = dialoguePlan.scenes.map(s => s.sceneId);
  const reconciledSceneIds = reconciledDialogue.scenes.map(s => s.sceneId);
  const visualSceneIds = visualPlan.scenes.map(s => s.sourceSceneId);
  const playbackSceneIds = reconciledPlayback.scenes.map(s => s.sourceSceneId);

  if (JSON.stringify(scenarioSceneIds) !== JSON.stringify(dialogueSceneIds)) {
    err('PIPELINE_IDENTITY_MISMATCH', `Scene IDs/order mismatch scenario vs dialoguePlan: ${scenarioSceneIds.join(',')} vs ${dialogueSceneIds.join(',')}`);
  }
  if (JSON.stringify(scenarioSceneIds) !== JSON.stringify(reconciledSceneIds)) {
    err('PIPELINE_IDENTITY_MISMATCH', `Scene IDs/order mismatch scenario vs reconciledDialogue`);
  }
  if (JSON.stringify(scenarioSceneIds) !== JSON.stringify(visualSceneIds)) {
    err('PIPELINE_IDENTITY_MISMATCH', `Scene IDs/order mismatch scenario vs visualPlan`);
  }
  if (JSON.stringify(scenarioSceneIds) !== JSON.stringify(playbackSceneIds)) {
    err('PIPELINE_IDENTITY_MISMATCH', `Scene IDs/order mismatch scenario vs reconciledPlayback`);
  }

  // turn order and IDs, clip IDs, speaker IDs, voiceSlot, VoiceProfile ID, spoken text, canonical path, actual duration
  const dialogueClips = dialoguePlan.clips;
  const canonicalById = new Map(canonicalManifest.results.map(r => [r.clipId, r]));
  const reconciledById = new Map(reconciledDialogue.clips.map(c => [c.clipId, c]));
  const synthesisById = new Map(synthesisManifest.results.map(r => [r.clipId, r]));

  // Check clip count consistency
  if (dialogueClips.length !== canonicalManifest.results.length) {
    err('CANONICAL_MANIFEST_MISMATCH', `Clip count mismatch dialoguePlan (${dialogueClips.length}) vs canonicalManifest (${canonicalManifest.results.length})`);
  }
  if (dialogueClips.length !== reconciledDialogue.clips.length) {
    err('RECONCILED_TIMING_MISMATCH', `Clip count mismatch dialoguePlan vs reconciledDialogue`);
  }
  if (dialogueClips.length !== synthesisManifest.results.length) {
    err('SYNTHESIS_MANIFEST_MISMATCH', `Clip count mismatch dialoguePlan vs synthesisManifest`);
  }

  // Per-clip identity checks
  for (const clip of dialogueClips) {
    const canon = canonicalById.get(clip.clipId);
    const recon = reconciledById.get(clip.clipId);
    const synth = synthesisById.get(clip.clipId);

    if (!canon) {
      err('MISSING_CLIP', `Missing canonical artifact for clip '${clip.clipId}'`, { clipId: clip.clipId });
      continue;
    }
    if (!recon) {
      err('MISSING_CLIP', `Missing reconciled clip for '${clip.clipId}'`, { clipId: clip.clipId });
      continue;
    }
    if (!synth) {
      err('MISSING_CLIP', `Missing synthesis result for '${clip.clipId}'`, { clipId: clip.clipId });
      continue;
    }

    // turn IDs
    if (clip.turnId !== canon.turnId) {
      err('PIPELINE_IDENTITY_MISMATCH', `TurnId mismatch for clip '${clip.clipId}': dialogue ${clip.turnId} vs canonical ${canon.turnId}`, { clipId: clip.clipId, turnId: clip.turnId });
    }
    if (clip.turnId !== recon.turnId) {
      err('PIPELINE_IDENTITY_MISMATCH', `TurnId mismatch for clip '${clip.clipId}': dialogue vs reconciled`, { clipId: clip.clipId });
    }

    // speaker IDs
    if (clip.speakerId !== canon.speakerId) {
      err('PIPELINE_IDENTITY_MISMATCH', `SpeakerId mismatch for clip '${clip.clipId}'`, { clipId: clip.clipId, speakerId: clip.speakerId });
    }

    // voiceSlot
    if (clip.voiceSlot !== canon.voiceSlot) {
      err('PIPELINE_IDENTITY_MISMATCH', `VoiceSlot mismatch for clip '${clip.clipId}'`, { clipId: clip.clipId, voiceSlot: clip.voiceSlot });
    }
    if (clip.voiceSlot !== recon.voiceSlot) {
      err('PIPELINE_IDENTITY_MISMATCH', `VoiceSlot mismatch for clip '${clip.clipId}' dialogue vs reconciled`, { clipId: clip.clipId });
    }

    // VoiceProfile ID
    const expectedVoiceProfileId = voiceResolution.bySlot[clip.voiceSlot]?.id;
    if (expectedVoiceProfileId && canon.voiceProfileId !== expectedVoiceProfileId) {
      err('VOICE_RESOLUTION_MISMATCH', `VoiceProfileId mismatch for clip '${clip.clipId}': expected '${expectedVoiceProfileId}' from resolution, got '${canon.voiceProfileId}'`, {
        clipId: clip.clipId,
        voiceSlot: clip.voiceSlot,
        voiceProfileId: canon.voiceProfileId,
      });
    }
    if (recon.voiceProfileId !== canon.voiceProfileId) {
      err('VOICE_RESOLUTION_MISMATCH', `VoiceProfileId mismatch reconciled vs canonical for clip '${clip.clipId}'`, { clipId: clip.clipId });
    }

    // spoken text
    if (clip.spokenText !== canon.spokenText) {
      err('PIPELINE_IDENTITY_MISMATCH', `Spoken text mismatch for clip '${clip.clipId}'`, { clipId: clip.clipId });
    }
    if (clip.spokenText !== recon.spokenText) {
      err('PIPELINE_IDENTITY_MISMATCH', `Spoken text mismatch dialogue vs reconciled for clip '${clip.clipId}'`, { clipId: clip.clipId });
    }

    // canonical audio path
    if (!canon.canonicalPath || typeof canon.canonicalPath !== 'string') {
      err('CANONICAL_ARTIFACT_MISMATCH', `Canonical path missing for clip '${clip.clipId}'`, { clipId: clip.clipId });
    }
    if (recon.canonicalPath !== canon.canonicalPath) {
      err('CANONICAL_ARTIFACT_MISMATCH', `Canonical path mismatch reconciled vs canonical manifest for clip '${clip.clipId}'`, { clipId: clip.clipId });
    }

    // actual audio duration
    if (typeof canon.canonicalMetadata.durationSeconds !== 'number' || !Number.isFinite(canon.canonicalMetadata.durationSeconds) || canon.canonicalMetadata.durationSeconds <= 0) {
      err('INVALID_DURATION', `Invalid canonical duration for clip '${clip.clipId}': ${canon.canonicalMetadata.durationSeconds}`, { clipId: clip.clipId });
    }
    if (canon.canonicalMetadata.durationSeconds !== undefined && Math.abs(recon.actualDurationSeconds - canon.canonicalMetadata.durationSeconds) > 0.001) {
      err('CANONICAL_ARTIFACT_MISMATCH', `Actual duration mismatch reconciled vs canonical for clip '${clip.clipId}': ${recon.actualDurationSeconds} vs ${canon.canonicalMetadata.durationSeconds}`, { clipId: clip.clipId });
    }

    // reconciled timing boundaries
    if (recon.actualStartTimeSeconds < 0 || recon.actualEndTimeSeconds <= recon.actualStartTimeSeconds) {
      err('RECONCILED_TIMING_MISMATCH', `Invalid reconciled timing boundaries for clip '${clip.clipId}'`, { clipId: clip.clipId });
    }
  }

  // playback references
  for (const dlg of reconciledPlayback.dialogues) {
    if (!reconciledById.has(dlg.audioClipId)) {
      err('PLAYBACK_AUDIO_MISMATCH', `Playback dialogue '${dlg.id}' references unknown clip '${dlg.audioClipId}'`, { clipId: dlg.audioClipId });
    }
    const reconClip = reconciledById.get(dlg.audioClipId);
    if (reconClip) {
      // playback timing must match reconciled dialogue timing
      const speechStartMs = Math.round(reconClip.actualStartTimeSeconds * 1000);
      const speechEndMs = Math.round(reconClip.actualEndTimeSeconds * 1000);
      if (Math.abs(dlg.speech.startMs - speechStartMs) > 1 || Math.abs(dlg.speech.endMs - speechEndMs) > 1) {
        err('PLAYBACK_AUDIO_MISMATCH', `Playback timing mismatch for clip '${dlg.audioClipId}': playback ${dlg.speech.startMs}-${dlg.speech.endMs}ms vs reconciled ${speechStartMs}-${speechEndMs}ms`, { clipId: dlg.audioClipId });
      }
    }
  }

  // caption references
  for (const cue of reconciledCaptions.cues) {
    if (!reconciledById.has(cue.clipId)) {
      err('CAPTION_AUDIO_MISMATCH', `Caption cue '${cue.id}' references unknown clip '${cue.clipId}'`, { clipId: cue.clipId });
    }
    const reconClip = reconciledById.get(cue.clipId);
    if (reconClip) {
      if (cue.startTimeSeconds < reconClip.actualStartTimeSeconds - 0.001 || cue.endTimeSeconds > reconClip.actualEndTimeSeconds + 0.001) {
        err('CAPTION_AUDIO_MISMATCH', `Caption cue '${cue.id}' outside actual clip interval [${reconClip.actualStartTimeSeconds}, ${reconClip.actualEndTimeSeconds}] got [${cue.startTimeSeconds}, ${cue.endTimeSeconds}]`, {
          clipId: cue.clipId,
        });
      }
      if (cue.endTimeSeconds > reconClip.actualEndTimeSeconds + 0.001) {
        err('CAPTION_AUDIO_MISMATCH', `Caption final boundary exceeds clip end for cue '${cue.id}'`, { clipId: cue.clipId });
      }
    }
  }

  // duplicate clip IDs check across all manifests
  const allClipIds = [
    ...dialogueClips.map(c => c.clipId),
    ...canonicalManifest.results.map(r => r.clipId),
    ...reconciledDialogue.clips.map(c => c.clipId),
  ];
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of allClipIds) {
    if (seen.has(id) && !dupes.has(id)) {
      // We need to check per-manifest duplicates separately; cross-manifest same IDs are expected
      // So this check is actually not for cross-manifest but for within each manifest
    }
    seen.add(id);
  }
  // Check within each manifest for duplicates (should already be caught by earlier phases, but final gate)
  const checkDupes = (ids: string[], name: string) => {
    const s = new Set<string>();
    for (const id of ids) {
      if (s.has(id)) {
        err('DUPLICATE_CLIP_ID', `Duplicate clipId '${id}' in ${name}`, { clipId: id });
      }
      s.add(id);
    }
  };
  checkDupes(dialogueClips.map(c => c.clipId), 'dialoguePlan');
  checkDupes(canonicalManifest.results.map(r => r.clipId), 'canonicalManifest');
  checkDupes(reconciledDialogue.clips.map(c => c.clipId), 'reconciledDialogue');
  checkDupes(synthesisManifest.results.map(r => r.clipId), 'synthesisManifest');

  return findings;
}

/** Final invariants enforcement */
export function validateDialogueProductionInvariants(inputs: {
  scenario: Scenario;
  dialoguePlan: DialogueAudioPlan;
  voiceResolution: DialogueAudioPlanVoiceResolution;
  synthesisManifest: DialogueSynthesisManifest;
  canonicalManifest: CanonicalDialogueAudioManifest;
  reconciledDialogue: ReconciledDialogueAudioPlan;
  reconciledPlayback: ReconciledPlaybackPlan;
  reconciledCaptions: ReconciledCaptionPlan;
}): DialogueProductionFinding[] {
  const findings: DialogueProductionFinding[] = [];
  const {
    scenario,
    dialoguePlan,
    voiceResolution,
    synthesisManifest,
    canonicalManifest,
    reconciledDialogue,
    reconciledPlayback,
    reconciledCaptions,
  } = inputs;

  const err = (code: DialogueProductionErrorCode, msg: string, loc?: any) => {
    findings.push(makeFinding('error', code, msg, loc));
  };
  const warn = (code: DialogueProductionErrorCode, msg: string, loc?: any) => {
    findings.push(makeFinding('warning', code, msg, loc));
  };

  // every dialogue turn has exactly one resolved voice
  for (const clip of dialoguePlan.clips) {
    if (!voiceResolution.bySlot[clip.voiceSlot]) {
      err('VOICE_RESOLUTION_MISMATCH', `Every dialogue turn must have exactly one resolved voice — missing for clip '${clip.clipId}' slot '${clip.voiceSlot}'`, {
        clipId: clip.clipId,
        voiceSlot: clip.voiceSlot,
      });
    }
  }

  // every dialogue clip has exactly one synthesized audio artifact
  for (const clip of dialoguePlan.clips) {
    const synth = synthesisManifest.byClipId[clip.clipId];
    if (!synth) {
      err('MISSING_CLIP', `Every clip must have exactly one synthesized artifact — missing for '${clip.clipId}'`, { clipId: clip.clipId });
    } else if (!synth.success) {
      err('MISSING_CLIP', `Synthesis failed for clip '${clip.clipId}': ${synth.error?.message}`, { clipId: clip.clipId });
    }
  }

  // every final audio artifact is canonical
  for (const res of canonicalManifest.results) {
    if (!res.isCanonical) {
      err('CANONICAL_ARTIFACT_MISMATCH', `Every final audio artifact must be canonical — clip '${res.clipId}' isCanonical false`, { clipId: res.clipId });
    }
    if (!res.canonicalMetadata.isCanonical) {
      err('CANONICAL_ARTIFACT_MISMATCH', `Canonical metadata not canonical for clip '${res.clipId}'`, { clipId: res.clipId });
    }
    // also check format: 48kHz mono pcm_s16le
    if (res.canonicalMetadata.sampleRate !== 48000) {
      err('CANONICAL_ARTIFACT_MISMATCH', `Canonical sampleRate must be 48000 for clip '${res.clipId}', got ${res.canonicalMetadata.sampleRate}`, { clipId: res.clipId });
    }
    if (res.canonicalMetadata.channels !== 1) {
      err('CANONICAL_ARTIFACT_MISMATCH', `Canonical channels must be 1 for clip '${res.clipId}'`, { clipId: res.clipId });
    }
  }

  // every canonical clip has valid positive duration
  for (const res of canonicalManifest.results) {
    const dur = res.canonicalMetadata.durationSeconds;
    if (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0) {
      err('INVALID_DURATION', `Every canonical clip must have valid positive duration — clip '${res.clipId}' has ${dur}`, { clipId: res.clipId });
    }
  }

  // every reconciled clip maps to exactly one canonical audio artifact
  for (const recon of reconciledDialogue.clips) {
    if (!canonicalManifest.byClipId[recon.clipId]) {
      err('CANONICAL_ARTIFACT_MISMATCH', `Every reconciled clip must map to exactly one canonical artifact — missing for '${recon.clipId}'`, { clipId: recon.clipId });
    }
  }

  // no duplicate clip IDs (already checked, but final gate)
  const clipIds = canonicalManifest.results.map(r => r.clipId);
  if (new Set(clipIds).size !== clipIds.length) {
    err('DUPLICATE_CLIP_ID', `Duplicate clip IDs in canonical manifest`);
  }

  // no missing turns
  const scenarioTurnIds = new Set(scenario.scenes.flatMap(s => s.turns.map(t => t.id)));
  const dialogueTurnIds = new Set(dialoguePlan.clips.map(c => c.turnId));
  for (const tid of scenarioTurnIds) {
    if (!dialogueTurnIds.has(tid)) {
      err('MISSING_TURN', `Missing turn '${tid}' from scenario in dialogue plan`, { turnId: tid });
    }
  }

  // no unexpected overlaps in reconciled dialogue
  for (let i = 0; i < reconciledDialogue.clips.length - 1; i++) {
    const curr = reconciledDialogue.clips[i];
    const next = reconciledDialogue.clips[i + 1];
    if (curr.actualStartTimeSeconds + curr.actualTotalSpanSeconds > next.actualStartTimeSeconds + 0.001) {
      err('OVERLAP_DETECTED', `Overlap detected between clips '${curr.clipId}' and '${next.clipId}'`, { clipId: curr.clipId });
    }
  }
  for (let i = 0; i < reconciledDialogue.scenes.length - 1; i++) {
    const curr = reconciledDialogue.scenes[i];
    const next = reconciledDialogue.scenes[i + 1];
    if (curr.actualEndTimeSeconds > next.actualStartTimeSeconds + 0.001) {
      err('OVERLAP_DETECTED', `Overlap between scenes '${curr.sceneId}' and '${next.sceneId}'`, { sceneId: curr.sceneId });
    }
  }

  // playback timing matches reconciled dialogue timing
  for (const dlg of reconciledPlayback.dialogues) {
    const recon = reconciledDialogue.clips.find(c => c.clipId === dlg.audioClipId);
    if (!recon) {
      err('PLAYBACK_AUDIO_MISMATCH', `Playback dialogue '${dlg.id}' references unknown clip '${dlg.audioClipId}'`, { clipId: dlg.audioClipId });
      continue;
    }
    if (Math.abs(dlg.speech.startMs - Math.round(recon.actualStartTimeSeconds * 1000)) > 1) {
      err('PLAYBACK_AUDIO_MISMATCH', `Playback timing mismatch for clip '${dlg.audioClipId}'`, { clipId: dlg.audioClipId });
    }
    if (Math.abs(dlg.speech.endMs - Math.round(recon.actualEndTimeSeconds * 1000)) > 1) {
      err('PLAYBACK_AUDIO_MISMATCH', `Playback end mismatch for clip '${dlg.audioClipId}'`, { clipId: dlg.audioClipId });
    }
  }

  // captions stay within source actual speech intervals
  for (const cue of reconciledCaptions.cues) {
    const recon = reconciledDialogue.clips.find(c => c.clipId === cue.clipId);
    if (!recon) {
      err('CAPTION_AUDIO_MISMATCH', `Caption cue '${cue.id}' references unknown clip '${cue.clipId}'`, { clipId: cue.clipId });
      continue;
    }
    if (cue.startTimeSeconds < recon.actualStartTimeSeconds - 0.001 || cue.endTimeSeconds > recon.actualEndTimeSeconds + 0.001) {
      err('CAPTION_AUDIO_MISMATCH', `Caption cue '${cue.id}' not within actual speech interval for clip '${cue.clipId}'`, { clipId: cue.clipId });
    }
    if (cue.endTimeSeconds > recon.actualEndTimeSeconds + 0.001) {
      err('CAPTION_TIMING_MISMATCH', `Caption final boundary exceeds clip end for cue '${cue.id}'`, { clipId: cue.clipId });
    }
  }

  // scenario/scene/turn ordering preserved
  const scenarioSceneOrder = scenario.scenes.map(s => s.id);
  const reconciledSceneOrder = reconciledDialogue.scenes.map(s => s.sceneId);
  if (JSON.stringify(scenarioSceneOrder) !== JSON.stringify(reconciledSceneOrder)) {
    err('PIPELINE_IDENTITY_MISMATCH', `Scene ordering not preserved`);
  }
  const scenarioTurnOrder = scenario.scenes.flatMap(s => s.turns.map(t => t.id));
  const dialogueTurnOrder = dialoguePlan.clips.map(c => c.turnId);
  if (JSON.stringify(scenarioTurnOrder) !== JSON.stringify(dialogueTurnOrder)) {
    err('PIPELINE_IDENTITY_MISMATCH', `Turn ordering not preserved`);
  }

  // no silent fallback or skipping — check hadFallback and hadFailures
  if (voiceResolution.hadFallback) {
    warn('VOICE_RESOLUTION_MISMATCH', `Voice resolution used fallback — should be explicit for Phase 4 closure, but allowed with warning`);
  }
  if (synthesisManifest.hadFailures) {
    err('FINAL_INVARIANT_FAILED', `Synthesis manifest had failures — no silent skipping allowed`);
  }
  if (canonicalManifest.hadFailures) {
    err('FINAL_INVARIANT_FAILED', `Canonical manifest had failures — no silent skipping allowed`);
  }

  return findings;
}

/** Full validation combining identity + invariants */
export function validateDialogueProductionResult(inputs: {
  scenario: Scenario;
  dialoguePlan: DialogueAudioPlan;
  voiceResolution: DialogueAudioPlanVoiceResolution;
  synthesisManifest: DialogueSynthesisManifest;
  canonicalManifest: CanonicalDialogueAudioManifest;
  reconciledDialogue: ReconciledDialogueAudioPlan;
  reconciledPlayback: ReconciledPlaybackPlan;
  reconciledCaptions: ReconciledCaptionPlan;
  visualPlan: ScenarioVisualPlan;
  captionPlan: ScenarioCaptionPlan;
}): { valid: boolean; findings: DialogueProductionFinding[] } {
  const identityFindings = validateDialogueProductionIdentities(inputs);
  const invariantFindings = validateDialogueProductionInvariants(inputs);

  const allFindings = [...identityFindings, ...invariantFindings];
  const hasError = allFindings.some(f => f.severity === 'error');

  return {
    valid: !hasError,
    findings: allFindings,
  };
}
