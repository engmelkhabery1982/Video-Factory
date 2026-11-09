import type { VoiceAudioRenderGateResult } from '@buildtrack/core';
import { loadProject } from './store.js';
import { loadVoiceAudioState } from './voice-audio-state.js';
import { buildRenderGate } from '../routes/voice-audio.js';

/**
 * VS3 — cloned-audio render gate.
 *
 * Called by EVERY entry point that actually renders/exports video. Projects that
 * do not use a cloned voice are explicitly NOT AFFECTED (the existing
 * narration/Kokoro flow keeps working); as soon as one speaker is assigned a
 * cloned voice, the request is refused with stable codes unless the audio is
 * authorized, generated, unmodified and explicitly approved.
 */
export function clonedAudioRenderGate(videoId: string): VoiceAudioRenderGateResult {
  const project = loadProject(videoId);
  const state = loadVoiceAudioState(videoId);
  if (!project) {
    return {
      allowed: false,
      notApplicable: false,
      blockedCodes: ['PREVIEW-MISSING'],
      findings: [
        {
          code: 'PREVIEW-MISSING',
          severity: 'error',
          message: 'Project not found.',
          remediation: 'Reload the project.',
        },
      ],
      reason: 'Project not found.',
    };
  }
  return buildRenderGate(videoId, project, state);
}
