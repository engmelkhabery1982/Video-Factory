/**
 * Phase 4E — Negative integration coverage
 * Intentionally corrupt one layer and prove final validation refuses it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  getProgressMeetingScenario,
  planDialogueAudio,
  compileScenarioVisualPlan,
  compileScenarioCaptions,
} from '@buildtrack/core';
import { resolveDialogueAudioPlanVoices } from '../packages/core/src/scenario/voice-resolver.js';
import { LocalDialogueSynthesizer } from '../packages/core/src/scenario/local-dialogue-synthesizer.js';
import { synthesizeDialoguePlan } from '../packages/core/src/scenario/synthesize-dialogue.js';
import { createCanonicalDialogueAudioManifest } from '../packages/core/src/scenario/canonical-dialogue-audio.js';
import { reconcileTiming } from '../packages/core/src/scenario/reconcile-timing.js';
import { buildDialogueProductionResultFromArtifacts } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { validateDialogueProductionResult } from '../packages/core/src/scenario/dialogue-production-validation.js';

describe('Phase 4E — Negative cross-phase integration', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = `tmp-test-phase4e-neg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  async function buildValidPipeline() {
    const scenario = getProgressMeetingScenario();
    const dialoguePlan = planDialogueAudio(scenario);
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) throw new Error('visual failed');
    const visualPlan = visualRes.plan;
    const captionRes = compileScenarioCaptions(scenario, dialoguePlan);
    if (!captionRes.success) throw new Error('caption failed');
    const captionPlan = captionRes.plan;

    const voiceResolution = resolveDialogueAudioPlanVoices(dialoguePlan);
    const synth = new LocalDialogueSynthesizer();
    const sourceBase = `${tmpRoot}/audio/dialogue`;
    const synthManifest = await synthesizeDialoguePlan(dialoguePlan, voiceResolution, synth, { basePath: sourceBase });
    const canonicalBase = `${tmpRoot}/audio/canonical`;
    const canonicalManifest = await createCanonicalDialogueAudioManifest(synthManifest, {
      sourceBasePath: sourceBase,
      canonicalBasePath: canonicalBase,
    });

    const { reconciledDialogue, reconciledPlayback, reconciledCaptions } = reconcileTiming({
      scenario,
      dialoguePlan,
      canonicalManifest,
      visualPlan,
      captionPlan,
    });

    return {
      scenario,
      dialoguePlan,
      voiceResolution,
      synthesisManifest: synthManifest,
      canonicalManifest,
      reconciledDialogue,
      reconciledPlayback,
      reconciledCaptions,
      visualPlan,
      captionPlan,
    };
  }

  it('refuses missing canonical clip', async () => {
    const pipeline = await buildValidPipeline();
    const missingClipId = pipeline.canonicalManifest.results[0].clipId;
    const filteredResults = pipeline.canonicalManifest.results.filter(r => r.clipId !== missingClipId);
    const corruptedManifest = {
      ...pipeline.canonicalManifest,
      results: filteredResults,
      byClipId: Object.fromEntries(filteredResults.map(r => [r.clipId, r])),
      clipCount: filteredResults.length,
    };

    const result = buildDialogueProductionResultFromArtifacts({
      ...pipeline,
      canonicalManifest: corruptedManifest as any,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.findings.some(f => f.code === 'MISSING_CLIP' || f.code === 'CANONICAL_MANIFEST_MISMATCH' || f.code === 'MISSING_PHASE_OUTPUT')).toBe(true);
    }
  });

  it('refuses wrong voiceProfileId', async () => {
    const pipeline = await buildValidPipeline();
    const firstClipId = pipeline.canonicalManifest.results[0].clipId;
    const corruptedResults = pipeline.canonicalManifest.results.map(r => {
      if (r.clipId === firstClipId) {
        return { ...r, voiceProfileId: 'wrong-voice-profile-id' };
      }
      return r;
    });
    const corruptedManifest = {
      ...pipeline.canonicalManifest,
      results: corruptedResults,
      byClipId: Object.fromEntries(corruptedResults.map(r => [r.clipId, r])),
    };

    const result = buildDialogueProductionResultFromArtifacts({
      ...pipeline,
      canonicalManifest: corruptedManifest as any,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.findings.some(f => f.code === 'VOICE_RESOLUTION_MISMATCH' || f.code === 'PIPELINE_IDENTITY_MISMATCH')).toBe(true);
    }
  });

  it('refuses wrong clipId in canonical manifest', async () => {
    const pipeline = await buildValidPipeline();
    const corruptedResults = pipeline.canonicalManifest.results.map((r, idx) => {
      if (idx === 0) {
        return { ...r, clipId: 'wrong-clip-id-123' };
      }
      return r;
    });
    const corruptedManifest = {
      ...pipeline.canonicalManifest,
      results: corruptedResults,
      byClipId: Object.fromEntries(corruptedResults.map(r => [r.clipId, r])),
    };

    const validation = validateDialogueProductionResult({
      scenario: pipeline.scenario,
      dialoguePlan: pipeline.dialoguePlan,
      voiceResolution: pipeline.voiceResolution,
      synthesisManifest: pipeline.synthesisManifest,
      canonicalManifest: corruptedManifest as any,
      reconciledDialogue: pipeline.reconciledDialogue,
      reconciledPlayback: pipeline.reconciledPlayback,
      reconciledCaptions: pipeline.reconciledCaptions,
      visualPlan: pipeline.visualPlan,
      captionPlan: pipeline.captionPlan,
    });

    expect(validation.valid).toBe(false);
    expect(validation.findings.some(f => f.severity === 'error')).toBe(true);
  });

  it('refuses changed spoken text', async () => {
    const pipeline = await buildValidPipeline();
    const firstClipId = pipeline.canonicalManifest.results[0].clipId;
    const corruptedResults = pipeline.canonicalManifest.results.map(r => {
      if (r.clipId === firstClipId) {
        return { ...r, spokenText: 'This is completely different spoken text that should not match' };
      }
      return r;
    });
    const corruptedManifest = {
      ...pipeline.canonicalManifest,
      results: corruptedResults,
      byClipId: Object.fromEntries(corruptedResults.map(r => [r.clipId, r])),
    };

    const result = buildDialogueProductionResultFromArtifacts({
      ...pipeline,
      canonicalManifest: corruptedManifest as any,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.findings.some(f => f.code === 'PIPELINE_IDENTITY_MISMATCH')).toBe(true);
    }
  });

  it('refuses playback timing mismatch', async () => {
    const pipeline = await buildValidPipeline();
    const corruptedPlayback = {
      ...pipeline.reconciledPlayback,
      dialogues: pipeline.reconciledPlayback.dialogues.map((d, idx) => {
        if (idx === 0) {
          return {
            ...d,
            speech: { startMs: d.speech.startMs + 5000, endMs: d.speech.endMs + 5000, durationMs: d.speech.durationMs },
          };
        }
        return d;
      }),
    };

    const validation = validateDialogueProductionResult({
      scenario: pipeline.scenario,
      dialoguePlan: pipeline.dialoguePlan,
      voiceResolution: pipeline.voiceResolution,
      synthesisManifest: pipeline.synthesisManifest,
      canonicalManifest: pipeline.canonicalManifest,
      reconciledDialogue: pipeline.reconciledDialogue,
      reconciledPlayback: corruptedPlayback as any,
      reconciledCaptions: pipeline.reconciledCaptions,
      visualPlan: pipeline.visualPlan,
      captionPlan: pipeline.captionPlan,
    });

    expect(validation.valid).toBe(false);
    expect(validation.findings.some(f => f.code === 'PLAYBACK_AUDIO_MISMATCH')).toBe(true);
  });

  it('refuses caption outside actual clip interval', async () => {
    const pipeline = await buildValidPipeline();
    const firstCue = pipeline.reconciledCaptions.cues[0];
    const reconClip = pipeline.reconciledDialogue.clips.find(c => c.clipId === firstCue.clipId)!;
    const corruptedCaptions = {
      ...pipeline.reconciledCaptions,
      cues: pipeline.reconciledCaptions.cues.map((cue, idx) => {
        if (idx === 0) {
          return {
            ...cue,
            startTimeSeconds: reconClip.actualEndTimeSeconds + 1,
            endTimeSeconds: reconClip.actualEndTimeSeconds + 2,
          };
        }
        return cue;
      }),
    };

    const validation = validateDialogueProductionResult({
      scenario: pipeline.scenario,
      dialoguePlan: pipeline.dialoguePlan,
      voiceResolution: pipeline.voiceResolution,
      synthesisManifest: pipeline.synthesisManifest,
      canonicalManifest: pipeline.canonicalManifest,
      reconciledDialogue: pipeline.reconciledDialogue,
      reconciledPlayback: pipeline.reconciledPlayback,
      reconciledCaptions: corruptedCaptions as any,
      visualPlan: pipeline.visualPlan,
      captionPlan: pipeline.captionPlan,
    });

    expect(validation.valid).toBe(false);
    expect(validation.findings.some(f => f.code === 'CAPTION_AUDIO_MISMATCH' || f.code === 'CAPTION_TIMING_MISMATCH')).toBe(true);
  });

  it('refuses duplicate canonical clip', async () => {
    const pipeline = await buildValidPipeline();
    const duplicate = pipeline.canonicalManifest.results[0];
    const corruptedResults = [...pipeline.canonicalManifest.results, duplicate];
    const corruptedManifest = {
      ...pipeline.canonicalManifest,
      results: corruptedResults,
      byClipId: Object.fromEntries(corruptedResults.map(r => [r.clipId, r])),
      clipCount: corruptedResults.length,
    };

    const validation = validateDialogueProductionResult({
      scenario: pipeline.scenario,
      dialoguePlan: pipeline.dialoguePlan,
      voiceResolution: pipeline.voiceResolution,
      synthesisManifest: pipeline.synthesisManifest,
      canonicalManifest: corruptedManifest as any,
      reconciledDialogue: pipeline.reconciledDialogue,
      reconciledPlayback: pipeline.reconciledPlayback,
      reconciledCaptions: pipeline.reconciledCaptions,
      visualPlan: pipeline.visualPlan,
      captionPlan: pipeline.captionPlan,
    });

    expect(validation.valid).toBe(false);
    expect(validation.findings.some(f => f.code === 'DUPLICATE_CLIP_ID')).toBe(true);
  });
});
