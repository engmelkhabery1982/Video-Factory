/**
 * Pure project input for the one synthetic external render.
 *
 * Importing this module does not start a server, generate a WAV, or render.
 * The request is checked here with `satisfies ProjectInput` so a missing
 * media list cannot be posted again by accident.
 */
import type { ProjectInput } from '../packages/core/src/types.js';

export const SYNTHETIC_EXTERNAL_VIDEO_ID = 'Synthetic_External_Render';
export const SYNTHETIC_EXTERNAL_SPOKEN = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ.';

export function syntheticExternalProjectInput(): ProjectInput {
  const input = {
    videoId: SYNTHETIC_EXTERNAL_VIDEO_ID,
    videoType: 'long' as const,
    topic: 'synthetic external render fixture',
    targetAudience: 'none',
    mainProblem: '',
    viewerPromise: '',
    hook: '',
    script: SYNTHETIC_EXTERNAL_SPOKEN,
    keyNumbers: [],
    keyPoints: [],
    productName: '',
    productShots: [],
    cta: '',
    voiceoverFile: null,
    targetAudio: {},
    brollFiles: [],
    sourceReferences: ['Declared synthetic sine fixture. Not a publication and not a human recording.'],
    outputLanguage: 'ar',
    brandPreset: 'buildtrack',
    shortCount: 0,
    narrationSource: 'external_ready' as const,
  } satisfies ProjectInput;
  return input;
}
