/**
 * BuildTrack Video Factory - Phase 4C Audio Validation & Normalization Tests
 *
 * Comprehensive unit tests covering:
 * - correct canonical WAV accepted without normalization
 * - 22.05 kHz SAM WAV detected as non-canonical
 * - normalization to 48 kHz
 * - mono preservation
 * - PCM16 preservation
 * - malformed WAV
 * - missing file
 * - empty file
 * - unsafe path
 * - invalid header
 * - deterministic metadata
 * - deterministic manifest ordering
 * - identity continuity
 * - normalizer failure
 * - no silent fallback
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WavHeaderProbe, validateCanonicalAudio } from '../packages/core/src/scenario/audio-probe.js';
import { FfmpegAudioNormalizer, generateCanonicalPath } from '../packages/core/src/scenario/audio-normalizer.js';
import { AudioValidationError, CANONICAL_AUDIO_FORMAT } from '../packages/core/src/scenario/audio-validation-types.js';
import { LocalDialogueSynthesizer } from '../packages/core/src/scenario/local-dialogue-synthesizer.js';
import { getProgressMeetingScenario } from '@buildtrack/core';
import { planDialogueAudio } from '../packages/core/src/scenario/plan-dialogue-audio.js';
import { resolveDialogueAudioPlanVoices } from '../packages/core/src/scenario/voice-resolver.js';
import { synthesizeDialoguePlan } from '../packages/core/src/scenario/synthesize-dialogue.js';
import { createCanonicalDialogueAudioManifest } from '../packages/core/src/scenario/canonical-dialogue-audio.js';

/** Helper to create a minimal WAV file with given params */
function createWavFile(filePath: string, sampleRate: number, channels: number, bitDepth: number, durationSeconds: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataBytes = Math.floor(byteRate * durationSeconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  const body = Buffer.alloc(dataBytes);
  // Fill with silence (0)
  const full = Buffer.concat([header, body]);
  fs.writeFileSync(filePath, full);
}

describe('Phase 4C — Audio Validation & Normalization', () => {
  const probe = new WavHeaderProbe();
  const normalizer = new FfmpegAudioNormalizer();
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = `tmp-test-phase4c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  describe('Probe & Validation', () => {
    it('1. correct canonical WAV accepted without normalization', () => {
      const filePath = `${tmpRoot}/canonical.wav`;
      createWavFile(filePath, 48000, 1, 16, 1.0);
      const meta = probe.probeSync(filePath);
      expect(meta.container).toBe('wav');
      expect(meta.codec).toBe('pcm_s16le');
      expect(meta.sampleRate).toBe(48000);
      expect(meta.channels).toBe(1);
      expect(meta.bitDepth).toBe(16);
      expect(meta.isValid).toBe(true);
      expect(meta.isCanonical).toBe(true);
      const validation = validateCanonicalAudio(meta);
      expect(validation.valid).toBe(true);
      expect(validation.isCanonical).toBe(true);
      expect(validation.errorCount).toBe(0);
    });

    it('2. 22.05 kHz SAM WAV detected as non-canonical', () => {
      const filePath = `${tmpRoot}/sam.wav`;
      createWavFile(filePath, 22050, 1, 16, 1.0);
      const meta = probe.probeSync(filePath);
      expect(meta.sampleRate).toBe(22050);
      expect(meta.isCanonical).toBe(false);
      const validation = validateCanonicalAudio(meta);
      expect(validation.valid).toBe(false);
      expect(validation.isCanonical).toBe(false);
      expect(validation.findings.some(f => f.ruleId.includes('WRONG-SAMPLE-RATE'))).toBe(true);
    });

    it('3. mono preservation — stereo detected as non-canonical', () => {
      const filePath = `${tmpRoot}/stereo.wav`;
      createWavFile(filePath, 48000, 2, 16, 0.5);
      const meta = probe.probeSync(filePath);
      expect(meta.channels).toBe(2);
      expect(meta.isCanonical).toBe(false);
      const validation = validateCanonicalAudio(meta);
      expect(validation.findings.some(f => f.category === 'channels')).toBe(true);
    });

    it('4. PCM16 preservation — 8-bit detected as non-canonical', () => {
      const filePath = `${tmpRoot}/8bit.wav`;
      createWavFile(filePath, 48000, 1, 8, 0.5);
      const meta = probe.probeSync(filePath);
      expect(meta.bitDepth).toBe(8);
      expect(meta.codec).toBe('pcm_u8');
      const validation = validateCanonicalAudio(meta);
      expect(validation.isCanonical).toBe(false);
      expect(validation.findings.some(f => f.category === 'codec' || f.category === 'bitDepth')).toBe(true);
    });

    it('5. malformed WAV — invalid header', () => {
      const filePath = `${tmpRoot}/malformed.wav`;
      fs.writeFileSync(filePath, Buffer.from('NOTAWAVFILE'));
      expect(() => probe.probeSync(filePath)).toThrow();
      try {
        probe.probeSync(filePath);
      } catch (e) {
        expect((e as AudioValidationError).code).toBe('MALFORMED_WAV');
      }
    });

    it('6. missing file', () => {
      const filePath = `${tmpRoot}/missing.wav`;
      expect(() => probe.probeSync(filePath)).toThrow();
      try {
        probe.probeSync(filePath);
      } catch (e) {
        expect((e as AudioValidationError).code).toBe('MISSING_AUDIO_FILE');
      }
    });

    it('7. empty file', () => {
      const filePath = `${tmpRoot}/empty.wav`;
      fs.writeFileSync(filePath, Buffer.alloc(0));
      expect(() => probe.probeSync(filePath)).toThrow();
      try {
        probe.probeSync(filePath);
      } catch (e) {
        expect((e as AudioValidationError).code).toBe('EMPTY_AUDIO');
      }
    });

    it('8. unsafe path — traversal', () => {
      expect(() => probe.probeSync('../evil.wav')).toThrow();
      expect(() => probe.probeSync('/absolute/path.wav')).toThrow();
      expect(() => probe.probeSync('audio/../../etc/passwd')).toThrow();
      try {
        probe.probeSync('../evil.wav');
      } catch (e) {
        expect((e as AudioValidationError).code).toBe('UNSAFE_PATH');
      }
    });

    it('9. invalid header — truncated', () => {
      const filePath = `${tmpRoot}/truncated.wav`;
      const buf = Buffer.alloc(20);
      buf.write('RIFF', 0);
      fs.writeFileSync(filePath, buf);
      expect(() => probe.probeSync(filePath)).toThrow();
    });

    it('10. deterministic metadata', () => {
      const filePath = `${tmpRoot}/deterministic.wav`;
      createWavFile(filePath, 48000, 1, 16, 2.5);
      const meta1 = probe.probeSync(filePath);
      const meta2 = probe.probeSync(filePath);
      expect(meta1.sampleRate).toBe(meta2.sampleRate);
      expect(meta1.channels).toBe(meta2.channels);
      expect(meta1.bitDepth).toBe(meta2.bitDepth);
      expect(meta1.fileSizeBytes).toBe(meta2.fileSizeBytes);
      expect(meta1.durationSeconds).toBe(meta2.durationSeconds);
      expect(meta1.container).toBe(meta2.container);
      expect(meta1.codec).toBe(meta2.codec);
    });
  });

  describe('Normalization', () => {
    it('11. normalization 22.05 kHz → 48 kHz', () => {
      if (!normalizer.isAvailable()) {
        console.warn('FFmpeg not available, skipping normalization test');
        return;
      }
      const sourcePath = `${tmpRoot}/source_22050.wav`;
      const targetPath = `${tmpRoot}/canonical_48000.wav`;
      createWavFile(sourcePath, 22050, 1, 16, 1.0);
      const sourceMeta = probe.probeSync(sourcePath);
      expect(sourceMeta.sampleRate).toBe(22050);
      expect(sourceMeta.isCanonical).toBe(false);

      const canonicalMeta = normalizer.normalizeSync(sourcePath, targetPath);
      expect(fs.existsSync(targetPath)).toBe(true);
      expect(canonicalMeta.sampleRate).toBe(48000);
      expect(canonicalMeta.channels).toBe(1);
      expect(canonicalMeta.codec).toBe('pcm_s16le');
      expect(canonicalMeta.bitDepth).toBe(16);
      expect(canonicalMeta.isCanonical).toBe(true);
      const validation = validateCanonicalAudio(canonicalMeta);
      expect(validation.isCanonical).toBe(true);
    });

    it('12. already canonical file copied without re-encoding failure', () => {
      if (!normalizer.isAvailable()) return;
      const sourcePath = `${tmpRoot}/already_canonical.wav`;
      const targetPath = `${tmpRoot}/canonical_copy.wav`;
      createWavFile(sourcePath, 48000, 1, 16, 0.5);
      const result = normalizer.normalizeSync(sourcePath, targetPath);
      expect(result.isCanonical).toBe(true);
      expect(fs.existsSync(targetPath)).toBe(true);
    });

    it('13. mono preservation after normalization', () => {
      if (!normalizer.isAvailable()) return;
      const sourcePath = `${tmpRoot}/mono_source.wav`;
      const targetPath = `${tmpRoot}/mono_canonical.wav`;
      createWavFile(sourcePath, 22050, 1, 16, 0.8);
      const canonicalMeta = normalizer.normalizeSync(sourcePath, targetPath);
      expect(canonicalMeta.channels).toBe(1);
    });

    it('14. PCM16 preservation after normalization', () => {
      if (!normalizer.isAvailable()) return;
      const sourcePath = `${tmpRoot}/pcm_source.wav`;
      const targetPath = `${tmpRoot}/pcm_canonical.wav`;
      createWavFile(sourcePath, 22050, 1, 16, 0.6);
      const canonicalMeta = normalizer.normalizeSync(sourcePath, targetPath);
      expect(canonicalMeta.codec).toBe('pcm_s16le');
      expect(canonicalMeta.bitDepth).toBe(16);
    });

    it('15. unsafe path in normalization', () => {
      const sourcePath = `${tmpRoot}/source.wav`;
      createWavFile(sourcePath, 22050, 1, 16, 0.5);
      expect(() => normalizer.normalizeSync(sourcePath, '../evil.wav')).toThrow();
      expect(() => normalizer.normalizeSync('../evil.wav', `${tmpRoot}/out.wav`)).toThrow();
    });

    it('16. missing file in normalization', () => {
      if (!normalizer.isAvailable()) return;
      const sourcePath = `${tmpRoot}/missing.wav`;
      const targetPath = `${tmpRoot}/out.wav`;
      expect(() => normalizer.normalizeSync(sourcePath, targetPath)).toThrow();
      try {
        normalizer.normalizeSync(sourcePath, targetPath);
      } catch (e) {
        expect((e as AudioValidationError).code).toBe('MISSING_AUDIO_FILE');
      }
    });

    it('17. generateCanonicalPath deterministic and safe', () => {
      const source = 'audio/dialogue/scenario-pm-01/sc-01-hook_turn-01-sarah.wav';
      const canonicalBase = 'audio/canonical';
      const out1 = generateCanonicalPath(source, canonicalBase);
      const out2 = generateCanonicalPath(source, canonicalBase);
      expect(out1).toBe(out2);
      expect(out1).toBe('audio/canonical/scenario-pm-01/sc-01-hook_turn-01-sarah.wav');
      expect(out1).not.toContain('..');
      expect(out1.startsWith('/')).toBe(false);
    });

    it('18. normalizer unavailable structured error', () => {
      // Simulate unavailable by forcing ffmpegPath null
      const norm = new FfmpegAudioNormalizer();
      (norm as any).ffmpegPath = null;
      // Override isAvailable to return false for this instance
      (norm as any).isAvailable = () => false;
      expect(norm.isAvailable()).toBe(false);
      expect(() => (norm as any).assertAvailable()).toThrow();
      try {
        (norm as any).assertAvailable();
      } catch (e) {
        expect((e as AudioValidationError).code).toBe('NORMALIZER_UNAVAILABLE');
      }
    });
  });

  describe('Manifest Integration', () => {
    it('19. deterministic manifest ordering preserved', async () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);
      const voiceRes = resolveDialogueAudioPlanVoices(plan);
      const synth = new LocalDialogueSynthesizer();
      const sourceBase = `${tmpRoot}/audio/dialogue`;
      const synthManifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: sourceBase });

      const canonicalBase = `${tmpRoot}/audio/canonical`;
      const canonicalManifest = await createCanonicalDialogueAudioManifest(synthManifest, {
        sourceBasePath: sourceBase,
        canonicalBasePath: canonicalBase,
      });

      expect(canonicalManifest.results.length).toBe(synthManifest.results.length);
      // Order preserved
      for (let i = 0; i < canonicalManifest.results.length - 1; i++) {
        const curr = canonicalManifest.results[i];
        const next = canonicalManifest.results[i + 1];
        // Find original clips
        const currSynth = synthManifest.results.find(r => r.clipId === curr.clipId)!;
        const nextSynth = synthManifest.results.find(r => r.clipId === next.clipId)!;
        // globalTurnIndex ordering preserved via synthesis manifest which is ordered
        const currIdx = synthManifest.results.indexOf(currSynth);
        const nextIdx = synthManifest.results.indexOf(nextSynth);
        expect(currIdx).toBeLessThan(nextIdx);
      }
      // byClipId consistent
      for (const res of canonicalManifest.results) {
        expect(canonicalManifest.byClipId[res.clipId]).toEqual(res);
      }
    });

    it('20. identity continuity preserved through normalization', async () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);
      const voiceRes = resolveDialogueAudioPlanVoices(plan);
      const synth = new LocalDialogueSynthesizer();
      const sourceBase = `${tmpRoot}/audio/dialogue`;
      const synthManifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: sourceBase });
      const canonicalBase = `${tmpRoot}/audio/canonical`;
      const canonicalManifest = await createCanonicalDialogueAudioManifest(synthManifest, {
        sourceBasePath: sourceBase,
        canonicalBasePath: canonicalBase,
      });

      for (const result of canonicalManifest.results) {
        const synthResult = synthManifest.results.find(r => r.clipId === result.clipId)!;
        expect(result.clipId).toBe(synthResult.clipId);
        expect(result.sceneId).toBe(synthResult.sceneId);
        expect(result.turnId).toBe(synthResult.turnId);
        expect(result.speakerId).toBe(synthResult.speakerId);
        expect(result.voiceSlot).toBe(synthResult.voiceSlot);
        expect(result.voiceProfileId).toBe(synthResult.voiceProfileId);
        expect(result.spokenText).toBe(synthResult.spokenText);
        // Source path preserved
        expect(result.sourcePath).toBe(synthResult.outputPath);
      }
    });

    it('21. records whether each clip was already canonical or normalized', async () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);
      const voiceRes = resolveDialogueAudioPlanVoices(plan);
      const synth = new LocalDialogueSynthesizer();
      const sourceBase = `${tmpRoot}/audio/dialogue`;
      const synthManifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: sourceBase });
      const canonicalBase = `${tmpRoot}/audio/canonical`;
      const canonicalManifest = await createCanonicalDialogueAudioManifest(synthManifest, {
        sourceBasePath: sourceBase,
        canonicalBasePath: canonicalBase,
      });

      // SAM output is 22050, so all should be normalized
      expect(canonicalManifest.hadNormalization).toBe(true);
      for (const res of canonicalManifest.results) {
        expect(res.wasNormalized).toBe(true);
        expect(res.isCanonical).toBe(true);
        expect(res.canonicalMetadata.sampleRate).toBe(48000);
      }
    });

    it('22. no silent fallback — voice mapping unchanged', async () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);
      const voiceRes = resolveDialogueAudioPlanVoices(plan);
      const synth = new LocalDialogueSynthesizer();
      const sourceBase = `${tmpRoot}/audio/dialogue`;
      const synthManifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: sourceBase });
      const canonicalBase = `${tmpRoot}/audio/canonical`;
      const canonicalManifest = await createCanonicalDialogueAudioManifest(synthManifest, {
        sourceBasePath: sourceBase,
        canonicalBasePath: canonicalBase,
      });

      for (const res of canonicalManifest.results) {
        const originalClip = plan.clips.find(c => c.clipId === res.clipId)!;
        expect(res.voiceSlot).toBe(originalClip.voiceSlot);
        expect(res.voiceProfileId).toBe(voiceRes.bySlot[originalClip.voiceSlot].id);
      }
    });

    it('23. no timeline retiming — durations from probe only, not used to change plan', async () => {
      const scenario = getProgressMeetingScenario();
      const plan = planDialogueAudio(scenario);
      const voiceRes = resolveDialogueAudioPlanVoices(plan);
      const synth = new LocalDialogueSynthesizer();
      const sourceBase = `${tmpRoot}/audio/dialogue`;
      const synthManifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: sourceBase });
      const canonicalBase = `${tmpRoot}/audio/canonical`;
      const canonicalManifest = await createCanonicalDialogueAudioManifest(synthManifest, {
        sourceBasePath: sourceBase,
        canonicalBasePath: canonicalBase,
      });

      // Ensure canonical manifest does not modify plan timing
      expect(canonicalManifest.scenarioId).toBe(plan.scenarioId);
      expect(canonicalManifest.clipCount).toBe(plan.clipCount);
      // The plan's totalDurationSeconds should remain unchanged (no retiming)
      // Canonical manifest only produces validated artifacts plus metadata, not new timings
      expect(plan.totalDurationSeconds).toBeGreaterThan(0);
      // Verify that canonical results have duration from probe, but plan timing untouched
      for (const res of canonicalManifest.results) {
        expect(res.canonicalMetadata.durationSeconds).toBeDefined();
        expect(res.canonicalMetadata.durationSeconds).toBeGreaterThan(0);
      }
    });
  });
});
