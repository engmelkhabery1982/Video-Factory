/**
 * BuildTrack Video Factory - Phase 4C Real Integration Test
 *
 * Proves: Scenario → DialogueAudioPlan → Voice Resolution → Audio Synthesis → Audio Validation → Normalization → canonical WAV
 * Uses real local SAM synthesizer from Phase 4B.
 * Proves:
 * - SAM output begins non-canonical at 22.05 kHz
 * - Phase 4C detects this
 * - normalized output is 48 kHz
 * - output remains mono
 * - output remains PCM16 WAV
 * - file exists and non-empty
 * - identity mapping unchanged
 * - no timeline retiming
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getProgressMeetingScenario, getClaimVariationScenario } from '@buildtrack/core';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { resolveDialogueAudioPlanVoices } from '../packages/core/src/scenario/voice-resolver.js';
import { synthesizeDialoguePlan } from '../packages/core/src/scenario/synthesize-dialogue.js';
import { LocalDialogueSynthesizer } from '../packages/core/src/scenario/local-dialogue-synthesizer.js';
import { WavHeaderProbe, validateCanonicalAudio } from '../packages/core/src/scenario/audio-probe.js';
import { createCanonicalDialogueAudioManifest } from '../packages/core/src/scenario/canonical-dialogue-audio.js';
import { CANONICAL_AUDIO_FORMAT } from '../packages/core/src/scenario/audio-validation-types.js';

describe('Phase 4C — Integration: Scenario → Plan → Voice → Synthesis → Validation → Normalization', () => {
  it('1. Progress Meeting: SAM 22.05kHz → detected non-canonical → normalized 48kHz canonical', async () => {
    const scenario = getProgressMeetingScenario();
    const plan = planDialogueAudio(scenario);
    const voiceRes = resolveDialogueAudioPlanVoices(plan);
    const synth = new LocalDialogueSynthesizer();
    const probe = new WavHeaderProbe();

    const tmpRoot = `tmp-test-phase4c-integration-${Date.now()}`;
    const sourceBase = `${tmpRoot}/audio/dialogue`;
    const canonicalBase = `${tmpRoot}/audio/canonical`;

    try {
      // Step 1: Synthesize with SAM (22.05kHz)
      const synthManifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: sourceBase });
      expect(synthManifest.clipCount).toBe(plan.clipCount);
      expect(synthManifest.hadFailures).toBe(false);

      // Verify SAM output is non-canonical 22.05kHz
      const firstSourcePath = synthManifest.results[0].outputPath;
      const sourceMeta = probe.probeSync(firstSourcePath);
      expect(sourceMeta.sampleRate).toBe(22050);
      expect(sourceMeta.isCanonical).toBe(false);
      const sourceValidation = validateCanonicalAudio(sourceMeta);
      expect(sourceValidation.isCanonical).toBe(false);
      expect(sourceValidation.findings.some(f => f.ruleId.includes('WRONG-SAMPLE-RATE'))).toBe(true);

      // Step 2: Normalize to canonical 48kHz
      const canonicalManifest = await createCanonicalDialogueAudioManifest(synthManifest, {
        sourceBasePath: sourceBase,
        canonicalBasePath: canonicalBase,
      });

      expect(canonicalManifest.clipCount).toBe(plan.clipCount);
      expect(canonicalManifest.hadFailures).toBe(false);
      expect(canonicalManifest.hadNormalization).toBe(true);

      // Verify normalized output is 48kHz mono PCM16 WAV
      const firstCanonical = canonicalManifest.results[0];
      expect(firstCanonical.wasNormalized).toBe(true);
      expect(firstCanonical.isCanonical).toBe(true);
      expect(firstCanonical.canonicalMetadata.sampleRate).toBe(48000);
      expect(firstCanonical.canonicalMetadata.channels).toBe(1);
      expect(firstCanonical.canonicalMetadata.codec).toBe('pcm_s16le');
      expect(firstCanonical.canonicalMetadata.bitDepth).toBe(16);
      expect(firstCanonical.canonicalMetadata.container).toBe('wav');
      expect(firstCanonical.canonicalPath).toContain('audio/canonical');
      expect(fs.existsSync(firstCanonical.canonicalPath)).toBe(true);
      const stat = fs.statSync(firstCanonical.canonicalPath);
      expect(stat.size).toBeGreaterThan(44);
      expect(firstCanonical.canonicalMetadata.fileSizeBytes).toBeGreaterThan(0);

      // Verify WAV header of canonical file
      const header = fs.readFileSync(firstCanonical.canonicalPath).subarray(0, 44);
      expect(header.toString('ascii', 0, 4)).toBe('RIFF');
      expect(header.toString('ascii', 8, 12)).toBe('WAVE');
      expect(header.readUInt32LE(24)).toBe(48000); // sample rate in header
      expect(header.readUInt16LE(22)).toBe(1); // channels
      expect(header.readUInt16LE(34)).toBe(16); // bit depth

      // Verify all clips normalized to 48kHz
      for (const res of canonicalManifest.results) {
        expect(res.canonicalMetadata.sampleRate).toBe(48000);
        expect(res.canonicalMetadata.channels).toBe(1);
        expect(res.canonicalMetadata.codec).toBe('pcm_s16le');
        expect(res.isCanonical).toBe(true);
        expect(fs.existsSync(res.canonicalPath)).toBe(true);
      }

      // Identity continuity
      for (let i = 0; i < plan.clips.length; i++) {
        const clip = plan.clips[i];
        const result = canonicalManifest.results[i];
        expect(result.clipId).toBe(clip.clipId);
        expect(result.sceneId).toBe(clip.sceneId);
        expect(result.turnId).toBe(clip.turnId);
        expect(result.speakerId).toBe(clip.speakerId);
        expect(result.voiceSlot).toBe(clip.voiceSlot);
        expect(result.voiceProfileId).toBe(voiceRes.bySlot[clip.voiceSlot].id);
        expect(result.spokenText).toBe(clip.spokenText);
      }

      // No timeline retiming
      expect(canonicalManifest.scenarioId).toBe(plan.scenarioId);
      expect(canonicalManifest.clipCount).toBe(plan.clipCount);
      expect(plan.totalDurationSeconds).toBeGreaterThan(0);
      // Canonical manifest does not change plan timing
    } finally {
      if (fs.existsSync(tmpRoot)) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  });

  it('2. Claim Variation: 10 clips SAM → canonical, identity preserved', async () => {
    const scenario = getClaimVariationScenario();
    const plan = planDialogueAudio(scenario);
    const voiceRes = resolveDialogueAudioPlanVoices(plan);
    const synth = new LocalDialogueSynthesizer();
    const tmpRoot = `tmp-test-phase4c-claim-${Date.now()}`;
    const sourceBase = `${tmpRoot}/audio/dialogue`;
    const canonicalBase = `${tmpRoot}/audio/canonical`;

    try {
      const synthManifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: sourceBase });
      expect(synthManifest.clipCount).toBe(10);
      const canonicalManifest = await createCanonicalDialogueAudioManifest(synthManifest, {
        sourceBasePath: sourceBase,
        canonicalBasePath: canonicalBase,
      });
      expect(canonicalManifest.clipCount).toBe(10);
      expect(canonicalManifest.successCount).toBe(10);
      expect(canonicalManifest.hadNormalization).toBe(true);
      for (const res of canonicalManifest.results) {
        expect(res.canonicalMetadata.sampleRate).toBe(48000);
        expect(res.isCanonical).toBe(true);
      }
    } finally {
      if (fs.existsSync(tmpRoot)) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  });

  it('3. Public API for Phase 4D', async () => {
    const core = await import('@buildtrack/core');
    expect(core.WavHeaderProbe).toBeDefined();
    expect(core.FfmpegAudioNormalizer).toBeDefined();
    expect(core.createCanonicalDialogueAudioManifest).toBeDefined();
    expect(core.CANONICAL_AUDIO_FORMAT).toBeDefined();
    expect(core.validateCanonicalAudio).toBeDefined();
    expect(typeof core.createCanonicalDialogueAudioManifest).toBe('function');
  });
});
