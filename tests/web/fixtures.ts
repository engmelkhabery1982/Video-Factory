/**
 * TEST DOUBLES ONLY. Nothing in this file is imported by the application.
 * They stand in for the factory API in the DOM tests so the page logic can be
 * exercised without a server. Results from these doubles are labelled as mock
 * results in the delivery report and are never presented as live evidence.
 */
import { FactoryApiError, type FactoryCapabilities, type FactoryClient, type FactoryDraftEnvelope, type FactoryDraftScene } from '../../apps/web/src/lib/factory-api';

export function sceneOf(id: string, patch: Partial<FactoryDraftScene> = {}): FactoryDraftScene {
  return {
    id,
    narration: `Narration for ${id}.`,
    speakerId: 'instructor',
    visualIntent: 'Owner image that names the concept.',
    assetId: 'img-a',
    startSec: null,
    endSec: null,
    locked: false,
    sourceUnitId: id,
    beat: 'explanation',
    language: 'en',
    assetOrigin: 'supplied',
    timingSource: 'unknown',
    visualDecision: { framing: 'full', motion: 'none', unexecuted: [] },
    ...patch,
  };
}

export const CAPS: FactoryCapabilities = {
  version: 1,
  text: { available: true, mode: 'local_rules', reason: 'Local deterministic rules over the supplied words.' },
  speech: {
    available: true,
    reason: 'Local sam-js English sample voices run here: robotic, synthetic, not natural speech. Arabic speech is unavailable.',
    voices: [
      { id: 'sam-reader', language: 'en', speakerLabel: 'Robotic English sample voice (sam-js, slow preset)' },
      { id: 'sam-narrator', language: 'en', speakerLabel: 'Robotic English sample voice (sam-js, medium preset)' },
    ],
    languages: {
      en: { available: true, reason: 'Robotic English sample voices (sam-js). Not natural speech.' },
      ar: { available: false, reason: 'No runnable Arabic speech engine. sam-js does not pronounce Arabic.' },
    },
    engines: [{ id: 'sam-js', available: true, reason: 'loads' }, { id: 'kokoro', available: false, reason: 'not provisioned' }],
  },
  image: { available: false, reason: 'No image generation engine is configured.' },
  transcription: { available: false, reason: 'No transcription engine is configured.' },
  storyboardImport: { available: true, reason: 'Inline storyboard version 1 only.' },
};

export function envelopeOf(over: Partial<FactoryDraftEnvelope> = {}): FactoryDraftEnvelope {
  const scenesA = [sceneOf('u01', { beat: 'problem', speakerId: 'learner', sourceUnitId: 'u01', narration: 'Why does the pour fail?' }), sceneOf('u02', { beat: 'walkthrough_example', sourceUnitId: 'u02', narration: 'For example, a pour was booked for seven.' })];
  const scenesB = [sceneOf('u02', { beat: 'worked_example', sourceUnitId: 'u02', narration: 'For example, a pour was booked for seven.', speakerId: 'instructor', visualDecision: { framing: 'tight', motion: 'none', unexecuted: ['screen recording: a still image is shown, not a recording. Supply footage for this scene.'] } }), sceneOf('u01', { beat: 'problem_context', sourceUnitId: 'u01', narration: 'Why does the pour fail?', speakerId: 'learner', assetId: null, assetOrigin: null, visualDecision: { framing: 'full', motion: 'pan_right', unexecuted: ['side-by-side comparison (split view is not rendered)'] } })];
  const scenesC = [sceneOf('u01', { beat: 'problem', sourceUnitId: 'u01', narration: 'Why does the pour fail?', speakerId: 'learner' }), sceneOf('u02', { beat: 'explanation', sourceUnitId: 'u02', narration: 'For example, a pour was booked for seven.' })];
  return {
    draftId: 'dft_0123456789abcdef',
    revision: 3,
    status: 'review_required',
    generationMode: 'local_rules',
    speechOrderLocked: false,
    selectedTreatmentId: 'edu-problem-example-action',
    treatments: [
      { id: 'edu-problem-example-action', title: 'Problem, example, action', rationale: 'Names the problem first.', orderLocked: false, structure: ['problem', 'explanation'], scenes: scenesA },
      { id: 'edu-worked-example-first', title: 'Worked example first', rationale: 'Shows the result first.', orderLocked: false, structure: ['worked_example', 'problem_context'], scenes: scenesB },
      { id: 'edu-question-walkthrough', title: 'Question-led walkthrough', rationale: 'Opens on the question.', orderLocked: false, structure: ['question', 'walkthrough_explanation'], scenes: scenesC },
    ],
    speakers: [
      { id: 'learner', voiceId: null, available: false },
      { id: 'instructor', voiceId: 'sam-narrator', available: true },
    ],
    missing: [],
    warnings: ['Treatments are deterministic local rules over the supplied words.'],
    appliedProjects: [],
    profile: { contentProfile: 'educational', format: 'landscape', channelBrandId: null },
    inputs: { audioAssetId: null, audioDurationSec: null, visualAssetIds: ['img-a'], scriptSupplied: true, storyboardSupplied: false },
    ...over,
  };
}

export function apiError(code: string, status: number | null, extra: Partial<ConstructorParameters<typeof FactoryApiError>[0]> = {}) {
  return new FactoryApiError({ message: `${code} test message`, status, code, answered: true, ...extra });
}

/** TEST DOUBLE. Records calls. Every method has a default that a test may override. */
export function fakeClient(over: Partial<FactoryClient> = {}): FactoryClient & { calls: Array<{ name: string; args: unknown[] }> } {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const rec = <T,>(name: string, value: (...a: unknown[]) => Promise<T>) => (...args: unknown[]) => {
    calls.push({ name, args });
    return value(...args);
  };
  return {
    calls,
    capabilities: rec('capabilities', async () => CAPS),
    createDraft: rec('createDraft', async () => envelopeOf()),
    getDraft: rec('getDraft', async () => envelopeOf()),
    // Echoes the selected treatment and bumps the revision, as the server does.
    patchDraft: rec('patchDraft', async (...args: unknown[]) => {
      const [, body] = args as [string, { expectedRevision: number; selectedTreatmentId: string }];
      return envelopeOf({ revision: body.expectedRevision + 1, selectedTreatmentId: body.selectedTreatmentId });
    }),
    applyDraft: rec('applyDraft', async () => ({ projectId: 'Factory_aaaaaaaaaaaa', targetId: 'long' as const, format: 'landscape' as const, editorRevision: 0, timingSource: 'measured_synthesis', speechGenerated: 2 })),
    ...over,
  } as FactoryClient & { calls: Array<{ name: string; args: unknown[] }> };
}
