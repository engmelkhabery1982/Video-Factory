/**
 * Phase 4 Regression Gate
 * Focused checkpoint: "Did I break Voices & Dialogue?"
 * Covers 4A voice resolution, 4B synthesis, 4C canonicalization, 4D timing reconciliation, 4E final integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  getProgressMeetingScenario,
  planDialogueAudio,
  compileScenarioVisualPlan,
  compileScenarioCaptions,
} from '@buildtrack/core';
import { resolveDialogueAudioPlanVoices, isLanguageCompatible } from '../packages/core/src/scenario/voice-resolver.js';
import { LocalDialogueSynthesizer } from '../packages/core/src/scenario/local-dialogue-synthesizer.js';
import { synthesizeDialoguePlan } from '../packages/core/src/scenario/synthesize-dialogue.js';
import { createCanonicalDialogueAudioManifest } from '../packages/core/src/scenario/canonical-dialogue-audio.js';
import { WavHeaderProbe, validateCanonicalAudio } from '../packages/core/src/scenario/audio-probe.js';
import { reconcileTiming } from '../packages/core/src/scenario/reconcile-timing.js';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';

describe('Phase 4 Regression Gate — Voices & Dialogue', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = `tmp-test-phase4-regression-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('4A voice resolution — deterministic, no silent fallback, language compatible', () => {
    const scenario = getProgressMeetingScenario();
    const plan = planDialogueAudio(scenario);
    const res1 = resolveDialogueAudioPlanVoices(plan);
    const res2 = resolveDialogueAudioPlanVoices(plan);
    expect(res1.scenarioId).toBe(plan.scenarioId);
    expect(Object.keys(res1.bySlot).length).toBeGreaterThan(0);
    expect(JSON.stringify(res1)).toBe(JSON.stringify(res2)); // deterministic
    expect(res1.hadFallback).toBe(false); // strict, no fallback
    // language compatibility
    expect(isLanguageCompatible('en', ['en-GB', 'en-US'])).toBe(true);
    expect(isLanguageCompatible('ar', ['en'])).toBe(false);
  });

  it('4B synthesis — real SAM produces valid WAV artifacts', async () => {
    const scenario = getProgressMeetingScenario();
    const plan = planDialogueAudio(scenario);
    const voiceRes = resolveDialogueAudioPlanVoices(plan);
    const synth = new LocalDialogueSynthesizer();
    expect(synth.engineId).toBe('sam-js');
    const manifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: `${tmpRoot}/audio/dialogue` });
    expect(manifest.clipCount).toBe(plan.clipCount);
    expect(manifest.hadFailures).toBe(false);
    expect(manifest.results.every(r => r.success)).toBe(true);
    for (const r of manifest.results) {
      expect(fs.existsSync(r.outputPath)).toBe(true);
      expect(r.spokenText).toBe(plan.clips.find(c => c.clipId === r.clipId)!.spokenText);
    }
  });

  it('4C canonicalization — SAM 22.05kHz detected non-canonical, normalized to 48kHz mono PCM16', async () => {
    const scenario = getProgressMeetingScenario();
    const plan = planDialogueAudio(scenario);
    const voiceRes = resolveDialogueAudioPlanVoices(plan);
    const synth = new LocalDialogueSynthesizer();
    const sourceBase = `${tmpRoot}/audio/dialogue`;
    const synthManifest = await synthesizeDialoguePlan(plan, voiceRes, synth, { basePath: sourceBase });
    const probe = new WavHeaderProbe();
    const sourceMeta = probe.probeSync(synthManifest.results[0].outputPath);
    expect(sourceMeta.sampleRate).toBe(22050);
    expect(sourceMeta.isCanonical).toBe(false);
    expect(validateCanonicalAudio(sourceMeta).isCanonical).toBe(false);

    const canonicalBase = `${tmpRoot}/audio/canonical`;
    const canonicalManifest = await createCanonicalDialogueAudioManifest(synthManifest, {
      sourceBasePath: sourceBase,
      canonicalBasePath: canonicalBase,
    });
    expect(canonicalManifest.hadNormalization).toBe(true);
    const canonicalMeta = probe.probeSync(canonicalManifest.results[0].canonicalPath);
    expect(canonicalMeta.sampleRate).toBe(48000);
    expect(canonicalMeta.channels).toBe(1);
    expect(canonicalMeta.codec).toBe('pcm_s16le');
    expect(canonicalMeta.isCanonical).toBe(true);
    expect(validateCanonicalAudio(canonicalMeta).isCanonical).toBe(true);
    // duration preserved
    expect(canonicalMeta.durationSeconds).toBeCloseTo(sourceMeta.durationSeconds!, 1);
  });

  it('4D timing reconciliation — actual timing replaces estimated, playback/captions aligned', async () => {
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

    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error('visual failed');
    const captionRes = compileScenarioCaptions(scenario, plan);
    if (!captionRes.success) throw new Error('caption failed');

    const { reconciledDialogue, reconciledPlayback, reconciledCaptions } = reconcileTiming({
      scenario,
      dialoguePlan: plan,
      canonicalManifest,
      visualPlan: visualRes.plan,
      captionPlan: captionRes.plan,
    });

    // actual timing from canonical
    for (const clip of reconciledDialogue.clips) {
      const canon = canonicalManifest.byClipId[clip.clipId];
      expect(clip.actualDurationSeconds).toBe(canon.canonicalMetadata.durationSeconds);
    }
    // no overlaps
    for (let i = 0; i < reconciledDialogue.clips.length - 1; i++) {
      const curr = reconciledDialogue.clips[i];
      const next = reconciledDialogue.clips[i + 1];
      expect(curr.actualStartTimeSeconds + curr.actualTotalSpanSeconds).toBeLessThanOrEqual(next.actualStartTimeSeconds + 0.001);
    }
    // playback matches reconciled
    for (const dlg of reconciledPlayback.dialogues) {
      const recon = reconciledDialogue.clips.find(c => c.clipId === dlg.audioClipId)!;
      expect(dlg.speech.startMs).toBe(Math.round(recon.actualStartTimeSeconds * 1000));
    }
    // captions within actual
    for (const cue of reconciledCaptions.cues) {
      const recon = reconciledDialogue.clips.find(c => c.clipId === cue.clipId)!;
      expect(cue.startTimeSeconds).toBeGreaterThanOrEqual(recon.actualStartTimeSeconds - 0.001);
      expect(cue.endTimeSeconds).toBeLessThanOrEqual(recon.actualEndTimeSeconds + 0.001);
    }
  });

  it('4E final integration — one orchestration API produces validated result', async () => {
    const scenario = getProgressMeetingScenario();
    const result = await buildDialogueProductionPlan(scenario, {
      synthesisBasePath: `${tmpRoot}/audio/dialogue`,
      canonicalBasePath: `${tmpRoot}/audio/canonical`,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.valid).toBe(true);
    expect(result.result.summary.sceneCount).toBe(scenario.scenes.length);
    expect(result.result.summary.clipCount).toBe(result.result.dialoguePlan.clipCount);
    expect(result.result.summary.canonicalAudioCount).toBe(result.result.dialoguePlan.clipCount);
    expect(result.result.summary.voiceProfileCount).toBeGreaterThan(0);
    expect(result.result.summary.captionCueCount).toBeGreaterThan(0);
    expect(result.result.summary.status).toBe('ok');
    // deterministic summary
    expect(result.result.summary.scenarioId).toBe(scenario.metadata.id);
  }, 60000);
});
