/**
 * BuildTrack Video Factory - Phase 4B Integration Test
 *
 * Proves: Scenario → DialogueAudioPlan → Voice Resolution → Dialogue Audio Synthesis
 * Verifies identity continuity for scenario, scene, turn, character/speaker, voice slot, VoiceProfile, spoken text, generated clip path.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getProgressMeetingScenario,
  getClaimVariationScenario,
  getScheduleRiskScenario,
} from '@buildtrack/core';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { resolveDialogueAudioPlanVoices } from '../packages/core/src/scenario/voice-resolver.js';
import { synthesizeDialoguePlan } from '../packages/core/src/scenario/synthesize-dialogue.js';
import { AudioSynthesisRequest, AudioSynthesisResult } from '../packages/core/src/scenario/audio-synthesis-types.js';
import { AudioSynthesizer } from '../packages/core/src/scenario/audio-synthesizer.js';
import { LocalDialogueSynthesizer } from '../packages/core/src/scenario/local-dialogue-synthesizer.js';

class MockSynthesizer implements AudioSynthesizer {
  readonly engineId = 'mock-integration';
  readonly requiresNetwork = false;
  readonly isLocal = true;
  public requests: AudioSynthesisRequest[] = [];

  async synthesize(request: AudioSynthesisRequest): Promise<AudioSynthesisResult> {
    this.requests.push(request);
    return {
      clipId: request.clipId,
      sceneId: request.sceneId,
      turnId: request.turnId,
      speakerId: request.speakerId,
      voiceSlot: request.voiceSlot,
      voiceProfileId: request.voiceProfileId,
      spokenText: request.spokenText,
      outputPath: request.targetPath,
      audioFormat: request.audioFormat,
      success: true,
      durationSeconds: 1.5,
      fileSizeBytes: 2048,
      metadata: {
        scenarioId: request.scenarioId,
        language: request.language,
        engine: this.engineId,
      },
    };
  }

  isAvailable(): boolean {
    return true;
  }
}

describe('Phase 4B — Integration: Scenario → DialogueAudioPlan → Voice Resolution → Synthesis', () => {
  it('1. Progress Meeting: full pipeline identity continuity', async () => {
    const scenario = getProgressMeetingScenario();
    const plan = planDialogueAudio(scenario);
    const voiceRes = resolveDialogueAudioPlanVoices(plan);
    const synth = new MockSynthesizer();

    const manifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: 'audio/dialogue' });

    expect(manifest.scenarioId).toBe(scenario.metadata.id);
    expect(manifest.language).toBe(scenario.metadata.language);
    expect(manifest.clipCount).toBe(plan.clipCount);
    expect(manifest.successCount).toBe(plan.clipCount);
    expect(manifest.hadFailures).toBe(false);
    expect(manifest.results.length).toBe(plan.clips.length);

    // Verify identity continuity for each clip
    for (let i = 0; i < plan.clips.length; i++) {
      const clip = plan.clips[i];
      const result = manifest.results[i];
      const request = synth.requests[i];

      // scenario
      expect(result.metadata?.scenarioId).toBe(scenario.metadata.id);
      expect(request.scenarioId).toBe(scenario.metadata.id);

      // scene
      expect(result.sceneId).toBe(clip.sceneId);
      expect(request.sceneId).toBe(clip.sceneId);

      // turn
      expect(result.turnId).toBe(clip.turnId);
      expect(request.turnId).toBe(clip.turnId);

      // character/speaker
      expect(result.speakerId).toBe(clip.speakerId);
      expect(request.speakerId).toBe(clip.speakerId);

      // voice slot
      expect(result.voiceSlot).toBe(clip.voiceSlot);
      expect(request.voiceSlot).toBe(clip.voiceSlot);

      // VoiceProfile
      const expectedProfile = voiceRes.bySlot[clip.voiceSlot];
      expect(expectedProfile).toBeDefined();
      expect(result.voiceProfileId).toBe(expectedProfile.id);
      expect(request.voiceProfileId).toBe(expectedProfile.id);

      // spoken text (exact preservation)
      expect(result.spokenText).toBe(clip.spokenText);
      expect(request.spokenText).toBe(clip.spokenText);

      // generated clip path (deterministic, safe)
      expect(result.outputPath).toBeTruthy();
      expect(result.outputPath.endsWith('.wav')).toBe(true);
      expect(result.outputPath).not.toContain('..');
      expect(result.outputPath.startsWith('/')).toBe(false);
      expect(result.outputPath).toContain('audio/dialogue');
    }

    // Determinism: second run identical
    const synth2 = new MockSynthesizer();
    const manifest2 = await synthesizeDialoguePlan(plan, voiceRes, synth2, { basePath: 'audio/dialogue' });
    expect(manifest2.results.map(r => r.clipId)).toEqual(manifest.results.map(r => r.clipId));
    expect(manifest2.results.map(r => r.outputPath)).toEqual(manifest.results.map(r => r.outputPath));
  });

  it('2. Claim Variation: 2 voices, 10 clips, identity continuity', async () => {
    const scenario = getClaimVariationScenario();
    const plan = planDialogueAudio(scenario);
    const voiceRes = resolveDialogueAudioPlanVoices(plan);
    const synth = new MockSynthesizer();
    const manifest = await synthesizeDialoguePlan(plan, voiceRes, synth);

    expect(manifest.clipCount).toBe(plan.clipCount);
    expect(manifest.clipCount).toBe(10);
    expect(manifest.results.length).toBe(10);
    const uniqueSlots = [...new Set(manifest.results.map(r => r.voiceSlot))].sort();
    expect(uniqueSlots.length).toBe(2);
    expect(uniqueSlots).toContain('voice_en_female_legal');
    expect(uniqueSlots).toContain('voice_en_male_advocate');
  });

  it('3. Schedule Risk: en-US, 3 voices', async () => {
    const scenario = getScheduleRiskScenario();
    const plan = planDialogueAudio(scenario);
    const voiceRes = resolveDialogueAudioPlanVoices(plan);
    const synth = new MockSynthesizer();
    const manifest = await synthesizeDialoguePlan(plan, voiceRes, synth);

    expect(manifest.language).toBe('en-US');
    expect(manifest.clipCount).toBe(plan.clipCount);
    const slots = manifest.results.map(r => r.voiceSlot).sort();
    expect(slots).toContain('voice_us_female_analytic');
    expect(slots).toContain('voice_us_male_executive');
    expect(slots).toContain('voice_us_male_field');
  });

  it('4. Public API usable by future Phase 4C/4D', async () => {
    const core = await import('@buildtrack/core');
    expect(core.synthesizeDialoguePlan).toBeDefined();
    expect(core.LocalDialogueSynthesizer).toBeDefined();
    expect(core.buildSynthesisRequest).toBeDefined();
    expect(typeof core.synthesizeDialoguePlan).toBe('function');
  });

  it('5. Real local synthesizer smoke test (SAM) - single clip', async () => {
    // This test uses the real local synthesizer to generate actual audio
    // It is lightweight enough for integration test (one clip)
    const scenario = getProgressMeetingScenario();
    const plan = planDialogueAudio(scenario);
    const voiceRes = resolveDialogueAudioPlanVoices(plan);
    const synth = new LocalDialogueSynthesizer();

    expect(synth.isAvailable()).toBe(true);
    expect(synth.engineId).toBe('sam-js');
    expect(synth.isLocal).toBe(true);
    expect(synth.requiresNetwork).toBe(false);

    // Use relative temp directory for output to satisfy safe relative path policy
    const tmpDirName = `tmp-test-phase4b-smoke-${Date.now()}`;
    const basePath = `${tmpDirName}/audio/dialogue`;
    const absoluteTmpDir = path.join(process.cwd(), tmpDirName);

    try {
      const manifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath });

      // Check first result only for smoke (to keep test fast, we synthesize all but verify one file)
      const firstResult = manifest.results[0];
      expect(firstResult.success).toBe(true);
      expect(fs.existsSync(firstResult.outputPath)).toBe(true);
      const stats = fs.statSync(firstResult.outputPath);
      expect(stats.size).toBeGreaterThan(44); // WAV header is 44 bytes, so must be larger
      expect(firstResult.audioFormat.container).toBe('wav');
      expect(firstResult.fileSizeBytes).toBeGreaterThan(0);
      expect(firstResult.durationSeconds).toBeGreaterThan(0);

      // Verify WAV header
      const header = fs.readFileSync(firstResult.outputPath).subarray(0, 12);
      expect(header.toString('ascii', 0, 4)).toBe('RIFF');
      expect(header.toString('ascii', 8, 12)).toBe('WAVE');

      // Verify all clips succeeded (SAM should handle all)
      expect(manifest.hadFailures).toBe(false);
      expect(manifest.successCount).toBe(plan.clipCount);
    } finally {
      // Cleanup temp dir
      if (fs.existsSync(absoluteTmpDir)) {
        fs.rmSync(absoluteTmpDir, { recursive: true, force: true });
      }
    }
  });
});
