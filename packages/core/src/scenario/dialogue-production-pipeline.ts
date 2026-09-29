/**
 * BuildTrack Video Factory - Phase 4E Dialogue Production Pipeline
 *
 * Final orchestration boundary for Phase 4 Voices & Dialogue System.
 * Composes approved Phase 4A-4D APIs into one deterministic system.
 *
 * Pipeline:
 * Scenario → DialogueAudioPlan → Voice Resolution → Audio Synthesis → Validation/Normalization → Actual Timing Reconciliation → Reconciled Playback → Reconciled Captions → Final Result
 *
 * Reuses existing APIs, does NOT duplicate logic.
 */

import { Scenario } from './types.js';
import { planDialogueAudio } from './plan-dialogue-audio.js';
import { compileScenarioVisualPlan } from './compile-visual-plan.js';
import { compileScenarioCaptions } from './compile-scenario-captions.js';
import { resolveDialogueAudioPlanVoices } from './voice-resolver.js';
import { LocalDialogueSynthesizer } from './local-dialogue-synthesizer.js';
import { synthesizeDialoguePlan } from './synthesize-dialogue.js';
import { createCanonicalDialogueAudioManifest } from './canonical-dialogue-audio.js';
import { reconcileTiming } from './reconcile-timing.js';
import { DialogueAudioPlan } from './dialogue-audio-types.js';
import { DialogueAudioPlanVoiceResolution } from './voice-types.js';
import { DialogueSynthesisManifest } from './audio-synthesis-types.js';
import { CanonicalDialogueAudioManifest } from './audio-validation-types.js';
import { ScenarioVisualPlan } from './visual-plan-types.js';
import { ScenarioCaptionPlan } from './scenario-caption-types.js';
import {
  DialogueProductionResult,
  DialogueProductionSummary,
  DialogueProductionFinding,
  DialogueProductionOptions,
  BuildDialogueProductionResult,
  DIALOGUE_PRODUCTION_RESULT_SCHEMA_VERSION,
  DialogueProductionError,
} from './dialogue-production-types.js';
import { validateDialogueProductionResult } from './dialogue-production-validation.js';
import { ReconciledDialogueAudioPlan, ReconciledPlaybackPlan, ReconciledCaptionPlan } from './timing-reconciliation-types.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Build deterministic summary */
function buildSummary(inputs: {
  scenario: Scenario;
  dialoguePlan: DialogueAudioPlan;
  canonicalManifest: CanonicalDialogueAudioManifest;
  reconciledDialogue: ReconciledDialogueAudioPlan;
  reconciledCaptions: ReconciledCaptionPlan;
  voiceResolution: DialogueAudioPlanVoiceResolution;
  findings: DialogueProductionFinding[];
}): DialogueProductionSummary {
  const scenario = inputs.scenario;
  const dialoguePlan = inputs.dialoguePlan;
  const canonicalManifest = inputs.canonicalManifest;
  const reconciledDialogue = inputs.reconciledDialogue;
  const reconciledCaptions = inputs.reconciledCaptions;
  const voiceResolution = inputs.voiceResolution;

  const turnCount = scenario.scenes.reduce((sum, s) => sum + s.turns.length, 0);
  const normalizedCount = canonicalManifest.results.filter(r => r.wasNormalized).length;

  const totalEstimated = dialoguePlan.totalDurationSeconds;
  const totalActual = reconciledDialogue.actualTotalDurationSeconds;

  const warningsCount = inputs.findings.filter(f => f.severity === 'warning').length;
  const hasError = inputs.findings.some(f => f.severity === 'error');

  return {
    scenarioId: scenario.metadata.id,
    projectId: scenario.metadata.projectId,
    language: scenario.metadata.language,
    targetFormat: scenario.metadata.targetFormat,
    sceneCount: scenario.scenes.length,
    turnCount,
    clipCount: dialoguePlan.clipCount,
    canonicalAudioCount: canonicalManifest.results.length,
    normalizedClipCount: normalizedCount,
    totalActualDurationSeconds: round2(totalActual),
    totalEstimatedDurationSeconds: round2(totalEstimated),
    totalDeltaSeconds: round2(totalActual - totalEstimated),
    voiceProfileCount: Object.keys(voiceResolution.bySlot).length,
    captionCueCount: reconciledCaptions.cueCount,
    warningsCount,
    status: hasError ? 'error' : warningsCount > 0 ? 'warning' : 'ok',
  };
}

/** Build final DialogueProductionResult from already reconciled artifacts */
export function buildDialogueProductionResultFromArtifacts(inputs: {
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
}): BuildDialogueProductionResult {
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

  // Validate presence
  if (!scenario || !dialoguePlan || !voiceResolution || !synthesisManifest || !canonicalManifest || !reconciledDialogue || !reconciledPlayback || !reconciledCaptions || !visualPlan || !captionPlan) {
    const missing: string[] = [];
    if (!scenario) missing.push('scenario');
    if (!dialoguePlan) missing.push('dialoguePlan');
    if (!voiceResolution) missing.push('voiceResolution');
    if (!synthesisManifest) missing.push('synthesisManifest');
    if (!canonicalManifest) missing.push('canonicalManifest');
    if (!reconciledDialogue) missing.push('reconciledDialogue');
    if (!reconciledPlayback) missing.push('reconciledPlayback');
    if (!reconciledCaptions) missing.push('reconciledCaptions');
    if (!visualPlan) missing.push('visualPlan');
    if (!captionPlan) missing.push('captionPlan');
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

  // Cross-phase validation
  const validation = validateDialogueProductionResult({
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
  });

  const summary = buildSummary({
    scenario,
    dialoguePlan,
    canonicalManifest,
    reconciledDialogue,
    reconciledCaptions,
    voiceResolution,
    findings: validation.findings,
  });

  const result: DialogueProductionResult = {
    schemaVersion: DIALOGUE_PRODUCTION_RESULT_SCHEMA_VERSION,
    scenarioId: scenario.metadata.id,
    projectId: scenario.metadata.projectId,
    language: scenario.metadata.language,
    targetFormat: scenario.metadata.targetFormat,
    dialoguePlan,
    voiceResolution,
    synthesisManifest,
    canonicalManifest,
    reconciledDialogue,
    reconciledPlayback,
    reconciledCaptions,
    visualPlan,
    captionPlan,
    summary,
    findings: validation.findings,
    valid: validation.valid,
  };

  if (!validation.valid) {
    return {
      success: false,
      error: `Final invariants failed: ${validation.findings.filter(f => f.severity === 'error').map(f => f.message).join('; ')}`,
      findings: validation.findings,
      partialResult: result,
    };
  }

  return {
    success: true,
    result,
  };
}

/** Full end-to-end orchestration from Scenario → Final Result (includes synthesis) */
export async function buildDialogueProductionPlan(
  scenario: Scenario,
  options: DialogueProductionOptions = {}
): Promise<BuildDialogueProductionResult> {
  if (!scenario || typeof scenario !== 'object') {
    return {
      success: false,
      error: 'Scenario must be non-null object',
      findings: [
        {
          severity: 'error',
          code: 'MISSING_PHASE_OUTPUT',
          message: 'Scenario is required',
        },
      ],
    };
  }

  const synthesisBasePath = (options.synthesisBasePath ?? 'audio/dialogue').trim();
  const canonicalBasePath = (options.canonicalBasePath ?? 'audio/canonical').trim();
  const synthesizer = options.synthesizer ?? new LocalDialogueSynthesizer();

  try {
    // 1. DialogueAudioPlan
    const dialoguePlan = planDialogueAudio(scenario);

    // 2. Visual plan (needed for playback)
    const visualRes = compileScenarioVisualPlan(scenario);
    if (!visualRes.ok) {
      return {
        success: false,
        error: `Visual plan failed: ${visualRes.errors.map(e => e.ruleId).join(',')}`,
        findings: [
          {
            severity: 'error',
            code: 'MISSING_PHASE_OUTPUT',
            message: `Visual plan compilation failed`,
          },
        ],
      };
    }
    const visualPlan = visualRes.plan;

    // 3. Caption plan (estimated, needed for reconciliation input)
    const captionRes = compileScenarioCaptions(scenario, dialoguePlan);
    if (!captionRes.success) {
      return {
        success: false,
        error: `Caption plan failed: ${captionRes.error}`,
        findings: [
          {
            severity: 'error',
            code: 'MISSING_PHASE_OUTPUT',
            message: `Caption plan compilation failed: ${captionRes.error}`,
          },
        ],
      };
    }
    const captionPlan = captionRes.plan;

    // 4. Voice resolution
    const voiceResolution = resolveDialogueAudioPlanVoices(dialoguePlan, options.voiceResolutionOptions ?? {});

    // 5. Audio synthesis
    const synthesisManifest = await synthesizeDialoguePlan(dialoguePlan, voiceResolution, synthesizer, {
      basePath: synthesisBasePath,
    });

    if (synthesisManifest.hadFailures) {
      // Continue to collect findings, but final validation will fail
    }

    // 6. Canonical audio manifest
    const canonicalManifest = await createCanonicalDialogueAudioManifest(synthesisManifest, {
      sourceBasePath: synthesisBasePath,
      canonicalBasePath,
    });

    // 7. Timing reconciliation (actual timing, playback, captions)
    const { reconciledDialogue, reconciledPlayback, reconciledCaptions } = reconcileTiming({
      scenario,
      dialoguePlan,
      canonicalManifest,
      visualPlan,
      captionPlan,
    });

    // 8. Build final result with validation
    return buildDialogueProductionResultFromArtifacts({
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
    });
  } catch (e) {
    const err = e as Error;
    // Map known error codes to final findings
    const code = (err as any).code ?? 'FINAL_INVARIANT_FAILED';
    return {
      success: false,
      error: err.message,
      findings: [
        {
          severity: 'error',
          code: mapErrorCode(code),
          message: err.message,
        },
      ],
    };
  }
}

/** Synchronous variant for cases where synthesis already done and artifacts available */
export function buildDialogueProductionResultFromCanonical(
  scenario: Scenario,
  dialoguePlan: DialogueAudioPlan,
  voiceResolution: DialogueAudioPlanVoiceResolution,
  synthesisManifest: DialogueSynthesisManifest,
  canonicalManifest: CanonicalDialogueAudioManifest
): BuildDialogueProductionResult {
  // Need visual and caption plans — compile them deterministically from scenario and dialoguePlan
  const visualRes = compileScenarioVisualPlan(scenario);
  if (!visualRes.ok) {
    return {
      success: false,
      error: `Visual plan failed`,
      findings: [{ severity: 'error', code: 'MISSING_PHASE_OUTPUT', message: 'Visual plan failed' }],
    };
  }
  const captionRes = compileScenarioCaptions(scenario, dialoguePlan);
  if (!captionRes.success) {
    return {
      success: false,
      error: `Caption plan failed`,
      findings: [{ severity: 'error', code: 'MISSING_PHASE_OUTPUT', message: 'Caption plan failed' }],
    };
  }

  const { reconciledDialogue, reconciledPlayback, reconciledCaptions } = reconcileTiming({
    scenario,
    dialoguePlan,
    canonicalManifest,
    visualPlan: visualRes.plan,
    captionPlan: captionRes.plan,
  });

  return buildDialogueProductionResultFromArtifacts({
    scenario,
    dialoguePlan,
    voiceResolution,
    synthesisManifest,
    canonicalManifest,
    reconciledDialogue,
    reconciledPlayback,
    reconciledCaptions,
    visualPlan: visualRes.plan,
    captionPlan: captionRes.plan,
  });
}

function mapErrorCode(raw: string): any {
  const known = [
    'PIPELINE_IDENTITY_MISMATCH',
    'MISSING_PHASE_OUTPUT',
    'FINAL_INVARIANT_FAILED',
    'PLAYBACK_AUDIO_MISMATCH',
    'CAPTION_AUDIO_MISMATCH',
    'CANONICAL_ARTIFACT_MISMATCH',
    'DUPLICATE_CLIP_ID',
    'MISSING_TURN',
    'MISSING_CLIP',
    'INVALID_DURATION',
    'OVERLAP_DETECTED',
    'VOICE_RESOLUTION_MISMATCH',
    'SYNTHESIS_MANIFEST_MISMATCH',
    'CANONICAL_MANIFEST_MISMATCH',
    'RECONCILED_TIMING_MISMATCH',
    'PLAYBACK_TIMING_MISMATCH',
    'CAPTION_TIMING_MISMATCH',
  ];
  if (known.includes(raw)) return raw;
  // Map from earlier phase codes
  if (raw.includes('MISSING') || raw.includes('CLIP')) return 'MISSING_CLIP';
  if (raw.includes('DUPLICATE')) return 'DUPLICATE_CLIP_ID';
  if (raw.includes('IDENTITY') || raw.includes('MISMATCH')) return 'PIPELINE_IDENTITY_MISMATCH';
  if (raw.includes('DURATION')) return 'INVALID_DURATION';
  if (raw.includes('OVERLAP')) return 'OVERLAP_DETECTED';
  return 'FINAL_INVARIANT_FAILED';
}
