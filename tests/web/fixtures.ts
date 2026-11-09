/**
 * TEST DOUBLES ONLY. Nothing in this file is imported by the application.
 * They stand in for the factory API in the DOM tests so the page logic can be
 * exercised without a server. Results from these doubles are labelled as mock
 * results in the delivery report and are never presented as live evidence.
 */
import { FactoryApiError, type FactoryCapabilities, type FactoryClient, type FactoryDraftEnvelope, type FactoryDraftScene, type FactoryTimingStatus } from '../../apps/web/src/lib/factory-api';

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

/** Exact server label for a measured source. Test double only. */
export const MEASURED_LABEL = 'Measured audio duration — not word alignment.';

/** TEST DOUBLE. A timing status as the server would report it for an applied, unedited project. */
export function timingStatusOf(over: Partial<FactoryTimingStatus> = {}): FactoryTimingStatus {
  return {
    projectId: 'Factory_aaaaaaaaaaaa',
    editorRevision: 0,
    status: 'applied',
    label: MEASURED_LABEL,
    appliedSource: 'measured_synthesis',
    appliedLabel: MEASURED_LABEL,
    alignmentStatus: 'not_requested',
    boundariesEdited: false,
    ...over,
  };
}

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
    timingPlan: { timingSource: 'measured_synthesis', label: MEASURED_LABEL },
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
    // Labelled fakes for the optional-input routes. They return the envelope or job shape the server returns.
    patchIntake: rec('patchIntake', async () => envelopeOf()),
    startTranscription: rec('startTranscription', async () => ({ jobId: 'trs_0123456789abcdef', audioAssetId: 'aud-1', audioSha256: 'x', status: 'unavailable', progress: null, reason: 'No local transcription runtime is configured.', transcript: null, reviewedText: null, provenance: null, revision: 0 })),
    getTranscription: rec('getTranscription', async () => ({ jobId: 'trs_0123456789abcdef', audioAssetId: 'aud-1', audioSha256: 'x', status: 'unavailable', progress: null, reason: 'No local transcription runtime is configured.', transcript: null, reviewedText: null, provenance: null, revision: 0 })),
    cancelTranscription: rec('cancelTranscription', async () => ({ jobId: 'trs_0123456789abcdef', audioAssetId: 'aud-1', audioSha256: 'x', status: 'canceled', progress: null, reason: null, transcript: null, reviewedText: null, provenance: null, revision: 1 })),
    reviewTranscription: rec('reviewTranscription', async () => ({ jobId: 'trs_0123456789abcdef', audioAssetId: 'aud-1', audioSha256: 'x', status: 'succeeded', progress: 1, reason: null, transcript: 'x', reviewedText: 'x', provenance: null, revision: 2 })),
    getDraft: rec('getDraft', async () => envelopeOf()),
    // Echoes the selected treatment and bumps the revision, as the server does.
    patchDraft: rec('patchDraft', async (...args: unknown[]) => {
      const [, body] = args as [string, { expectedRevision: number; selectedTreatmentId: string }];
      return envelopeOf({ revision: body.expectedRevision + 1, selectedTreatmentId: body.selectedTreatmentId });
    }),
    applyDraft: rec('applyDraft', async () => ({ projectId: 'Factory_aaaaaaaaaaaa', targetId: 'long' as const, format: 'landscape' as const, editorRevision: 0, timingSource: 'measured_synthesis', timingLabel: MEASURED_LABEL, speechGenerated: 2, reused: false })),
    projectTiming: rec('projectTiming', async () => timingStatusOf()),
    // Labelled fakes for the no-material topic route and the built-in PDF importer. No model, no parse, no provider.
    topicSuggestions: rec('topicSuggestions', async () => ({
      route: 'local_rules' as const,
      language: 'en' as const,
      suggestions: [
        { id: 'topic-1', title: 'The one mistake beginners make with pumps', angle: 'Problem-first explainer angle.', nextStep: 'Pick the topic, then paste reviewed lesson text.' },
        { id: 'topic-2', title: 'A worked example that explains pumps', angle: 'A worked example using facts you supply.', nextStep: 'Pick the topic, then paste reviewed lesson text.' },
        { id: 'topic-3', title: 'Three practical steps to apply pumps today', angle: 'Practical steps, no generated facts.', nextStep: 'Pick the topic, then paste reviewed lesson text.' },
      ],
    })),
    importStoryboardPdf: rec('importStoryboardPdf', async () => ({
      parser: 'builtin-pdf-storyboard-parser-v1',
      storyboard: {
        version: 1 as const,
        scenes: [
          { id: 'page-01', narration: 'First panel words', speakerId: null, assetId: 'pic-1', startSec: null, endSec: null, locked: false },
          { id: 'page-02', narration: 'Second panel words', speakerId: null, assetId: null, startSec: null, endSec: null, locked: false },
        ],
      },
      visualAssetIds: ['pic-1'],
      report: { sourceFileName: 'storyboard.pdf', pageCount: 2, warnings: [], perPage: [
        { page: 1, id: 'page-01', chars: 17, pictureAssetId: 'pic-1', unsupported: [] },
        { page: 2, id: 'page-02', chars: 18, pictureAssetId: null, unsupported: [] },
      ] },
    })),
    ...over,
  } as FactoryClient & { calls: Array<{ name: string; args: unknown[] }> };
}
