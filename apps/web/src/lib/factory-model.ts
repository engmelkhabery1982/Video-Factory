/**
 * Pure rules for the content-planning workflow. No React, no I/O.
 *
 * Every rule here is a UI-side guard or a presentation mapping. The server stays
 * the authority: anything this file allows is still checked by the API, and any
 * server refusal is shown through `errorView`, never hidden.
 */
import type {
  FactoryCapabilities,
  FactoryDraftEnvelope,
  FactoryDraftScene,
  FactoryFormat,
  FactoryMissingItem,
  FactoryProfile,
  FactoryTimingSource,
  FactoryTreatment,
  FactoryCreateBody,
} from './factory-api';
import { FactoryApiError } from './factory-api';

export type PlanInputMode = 'brief' | 'script' | 'audio_script' | 'storyboard';
export type PlanIdentity = 'none' | 'buildtrack';

export interface PlanForm {
  profile: FactoryProfile;
  format: FactoryFormat;
  identity: PlanIdentity;
  brief: string;
  inputMode: PlanInputMode;
  script: string;
  storyboardText: string;
  audioAssetId: string | null;
  visualAssetIds: string[];
}

export const EMPTY_PLAN_FORM: PlanForm = {
  profile: 'educational',
  format: 'landscape',
  identity: 'none',
  brief: '',
  inputMode: 'script',
  script: '',
  storyboardText: '',
  audioAssetId: null,
  visualAssetIds: [],
};

export const PROFILE_LABELS: Record<FactoryProfile, string> = {
  religious: 'Religious (reader and narrator; passages keep their wording)',
  educational: 'Educational (instructor and learner)',
  promotional: 'Promotional (host and customer)',
};

export const INPUT_MODE_LABELS: Record<PlanInputMode, string> = {
  brief: 'Brief only',
  script: 'Reviewed script',
  audio_script: 'Ready audio with its reviewed script',
  storyboard: 'Versioned storyboard (JSON, version 1)',
};

/** Profile-specific copy. Religious never offers the BuildTrack identity. */
export function identityOptionsFor(profile: FactoryProfile): Array<{ value: PlanIdentity; label: string; disabled: boolean; reason: string | null }> {
  if (profile === 'religious') {
    return [
      { value: 'none', label: 'No channel identity', disabled: false, reason: null },
      {
        value: 'buildtrack',
        label: 'BuildTrack identity',
        disabled: true,
        reason: 'Not available for religious content. No fallback identity is substituted.',
      },
    ];
  }
  return [
    { value: 'none', label: 'No channel identity', disabled: false, reason: null },
    { value: 'buildtrack', label: 'BuildTrack identity (explicit)', disabled: false, reason: null },
  ];
}

/** One plain sentence about how the profile treats product and call-to-action copy. */
export function profileNoteFor(profile: FactoryProfile): string {
  if (profile === 'religious') return 'Passages keep their supplied wording. No product mention or call to action is added.';
  if (profile === 'educational') return 'Offline treatments keep your supplied script. Local AI planning offers an optional contextual product mention using facts you provide; it is off by default.';
  return 'The supplied call-to-action line stays as written. No call-to-action card is rendered.';
}

export interface PlanFormCheck {
  ok: boolean;
  errors: string[];
  /** Storyboard JSON parsed and checked for shape only. The server validates the rest. */
  storyboard: FactoryCreateBody['inputs']['storyboard'];
}

/**
 * Turn the form into a create request, or list every reason it cannot be sent.
 * Nothing is cleared on failure: the caller keeps the form as the user left it.
 */
export function checkPlanForm(form: PlanForm): PlanFormCheck {
  const errors: string[] = [];
  let storyboard: FactoryCreateBody['inputs']['storyboard'] = null;
  if (form.profile === 'religious' && form.identity === 'buildtrack') {
    errors.push('BuildTrack identity cannot be used for religious content. Choose no channel identity.');
  }
  if (!form.brief.trim()) errors.push('Write a one-line brief. It names the video; it is not used as narration.');
  if (form.inputMode === 'script' && !form.script.trim()) errors.push('Paste the reviewed script for this mode.');
  if (form.inputMode === 'audio_script') {
    if (!form.audioAssetId) errors.push('Choose a ready audio file from the library, or upload one.');
    if (!form.script.trim()) {
      errors.push('Audio alone cannot be understood here: no transcription engine is configured. Paste the reviewed script that the audio speaks.');
    }
  }
  if (form.inputMode === 'storyboard') {
    const parsed = parseStoryboardText(form.storyboardText);
    if (!parsed.ok) errors.push(parsed.error);
    else storyboard = parsed.storyboard;
  }
  return {
    ok: errors.length === 0,
    errors,
    storyboard,
  };
}

/** Shape check for a versioned storyboard. Ids, times and asset ids are checked by the server. */
export function parseStoryboardText(text: string): { ok: true; storyboard: { version: 1; scenes: Array<Record<string, unknown>> } } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: 'Paste a storyboard JSON document (version 1).' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The storyboard is not valid JSON. Nothing was sent; the text is kept so you can correct it.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'The storyboard must be a JSON object with "version" and "scenes".' };
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return { ok: false, error: 'Only storyboard version 1 is accepted.' };
  if (!Array.isArray(obj.scenes) || obj.scenes.length === 0) return { ok: false, error: 'The storyboard needs at least one scene.' };
  return { ok: true, storyboard: { version: 1, scenes: obj.scenes as Array<Record<string, unknown>> } };
}

/** The create request for a checked form. Callers must check `checkPlanForm` first. */
export function buildCreateBody(form: PlanForm, storyboard: FactoryCreateBody['inputs']['storyboard']): FactoryCreateBody {
  const useScript = form.inputMode === 'script' || form.inputMode === 'audio_script';
  return {
    contentProfile: form.profile,
    format: form.format,
    channelBrandId: form.identity === 'buildtrack' ? 'buildtrack' : null,
    inputs: {
      brief: form.brief.trim(),
      script: useScript && form.script.trim() ? form.script : null,
      audioAssetId: form.inputMode === 'audio_script' ? form.audioAssetId : null,
      visualAssetIds: form.visualAssetIds,
      storyboard: form.inputMode === 'storyboard' ? storyboard : null,
    },
    requestedSpeakers: [],
    referenceProjectId: null,
  };
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

/** Speech status for one language, from the capability result. Unknown languages are unavailable. */
export function speechStatusFor(caps: FactoryCapabilities | null, language: 'en' | 'ar' | 'und'): { available: boolean; reason: string } {
  if (!caps) return { available: false, reason: 'Capabilities have not loaded. Generation is not assumed.' };
  if (language === 'und') return { available: false, reason: 'The language of this line was not detected. Generation is not assumed.' };
  const entry = caps.speech.languages[language];
  if (!entry) return { available: false, reason: `No speech capability is reported for ${language === 'ar' ? 'Arabic' : 'English'}.` };
  return entry;
}

/** Voice options for a language. Empty when the engine does not run or the language is unsupported. */
export function voiceOptionsFor(caps: FactoryCapabilities | null, language: 'en' | 'ar' | 'und'): FactoryCapabilities['speech']['voices'] {
  if (!caps || !caps.speech.available || !speechStatusFor(caps, language).available) return [];
  return caps.speech.voices.filter((v) => v.language === language);
}

/** Labels only. Robotic sample voices are named as such; nothing is called natural or professional. */
export function voiceLabelOf(voiceId: string | null, caps: FactoryCapabilities | null): string {
  if (!voiceId) return 'No voice assigned';
  const voice = caps?.speech.voices.find((v) => v.id === voiceId);
  return voice ? voice.speakerLabel : voiceId;
}

export interface SpeakerRow {
  speakerId: string;
  voiceId: string | null;
  languages: Array<'en' | 'ar' | 'und'>;
  options: FactoryCapabilities['speech']['voices'];
  status: 'ready' | 'unavailable' | 'no_voice' | 'audio_supplied';
  message: string;
}

/**
 * One row per speaker of the selected treatment, from the capability result.
 * When full audio is supplied, speakers are attribution labels only and no voice is generated.
 */
export function speakerRowsFor(env: FactoryDraftEnvelope, caps: FactoryCapabilities | null): SpeakerRow[] {
  const selected = env.treatments.find((t) => t.id === env.selectedTreatmentId);
  const scenes = selected?.scenes ?? [];
  const speakerIds = [...new Set(scenes.map((s) => s.speakerId).filter((x): x is string => !!x))];
  const rows = speakerIds.map((speakerId): SpeakerRow => {
    const langs = [...new Set(scenes.filter((s) => s.speakerId === speakerId).map((s) => s.language))];
    const current = env.speakers.find((s) => s.id === speakerId);
    const voiceId = current?.voiceId ?? null;
    if (env.inputs.audioAssetId) {
      return {
        speakerId,
        voiceId,
        languages: langs,
        options: [],
        status: 'audio_supplied',
        message: 'The supplied recording is used as-is. Speakers are labels for review; no voice is generated.',
      };
    }
    const unavailable = langs.map((l) => ({ l, s: speechStatusFor(caps, l) })).filter((x) => !x.s.available);
    const options = [...new Map(langs.flatMap((l) => voiceOptionsFor(caps, l)).map((v) => [v.id, v])).values()];
    if (unavailable.length > 0) {
      const names = unavailable.map((x) => (x.l === 'ar' ? 'Arabic' : x.l === 'en' ? 'English' : 'an unknown language')).join(', ');
      return {
        speakerId,
        voiceId,
        languages: langs,
        options,
        status: 'unavailable',
        message: `Generation unavailable for ${names}: ${unavailable[0].s.reason} Import approved audio for these lines instead.`,
      };
    }
    if (!voiceId) {
      return { speakerId, voiceId, languages: langs, options, status: 'no_voice', message: 'Choose a voice. Generated speech is unapproved until you review it.' };
    }
    return { speakerId, voiceId, languages: langs, options, status: 'ready', message: 'Generated speech is unapproved until you review and approve it in the editor.' };
  });
  return rows;
}

/* ------------------------------------------------------------------ */
/* Material and timing labels                                          */
/* ------------------------------------------------------------------ */

/**
 * Exact timing labels. Mirrors TIMING_SOURCE_LABELS in @buildtrack/core; a test
 * compares the two so they cannot drift. The browser bundle does not import core.
 */
export const TIMING_LABELS = {
  estimated_text_length: 'Estimated timing — not audio-aligned.',
  supplied: 'Supplied timing — not verified by an alignment engine.',
  measured_synthesis: 'Measured audio duration — not word alignment.',
  unrecorded: 'Timing source not recorded for this project.',
  decidedAtApply: 'Timing is decided when apply runs.',
} as const;

/** Label for a timing source. `unknown` means no source is decided yet, never a measured claim. */
export function timingLabel(source: FactoryTimingSource): string {
  switch (source) {
    case 'supplied': return TIMING_LABELS.supplied;
    case 'measured_synthesis': return TIMING_LABELS.measured_synthesis;
    case 'estimated_text_length': return TIMING_LABELS.estimated_text_length;
    default: return TIMING_LABELS.decidedAtApply;
  }
}

/** The planning column: the server's predicted label when present, else the scene's own source. */
export function planningTimingLabel(env: { timingPlan?: { label: string } }, sceneSource: FactoryTimingSource): string {
  return env.timingPlan ? env.timingPlan.label : timingLabel(sceneSource);
}

export function materialLabel(scene: FactoryDraftScene): { status: 'supplied' | 'library' | 'reviewer' | 'missing'; label: string } {
  if (!scene.assetId) return { status: 'missing', label: 'Missing: no picture assigned. No image engine is configured.' };
  if (scene.assetOrigin === 'supplied') return { status: 'supplied', label: 'Available: your supplied picture' };
  if (scene.assetOrigin === 'reviewer') return { status: 'reviewer', label: 'Available: chosen in review' };
  return { status: 'library', label: 'Available: picked from the library' };
}

export interface TreatmentMaterial {
  supplied: number;
  library: number;
  reviewer: number;
  missing: number;
  /** Every requested feature the renderer does not execute, with the scene it belongs to. */
  gaps: Array<{ sceneId: string; text: string }>;
}

export function materialSummaryOf(treatment: FactoryTreatment): TreatmentMaterial {
  const out: TreatmentMaterial = { supplied: 0, library: 0, reviewer: 0, missing: 0, gaps: [] };
  for (const s of treatment.scenes) {
    const m = materialLabel(s).status;
    out[m === 'missing' ? 'missing' : m] += 1;
    for (const text of s.visualDecision.unexecuted) out.gaps.push({ sceneId: s.id, text });
  }
  return out;
}

/** Labelled execution of a treatment's visual decisions, in plain words. Never "implemented" for a gap. */
export function visualExecutionLabel(scene: FactoryDraftScene): string {
  const d = scene.visualDecision;
  const framing = d.framing === 'tight' ? 'tight framing (crop applied)' : 'full frame';
  const motion = d.motion === 'none' ? 'no motion' : `${d.motion.replace('_', ' ')} (still motion applied)`;
  return `${framing}, ${motion}`;
}

/* ------------------------------------------------------------------ */
/* Scene editing                                                       */
/* ------------------------------------------------------------------ */

/**
 * Move a row one place. A locked order (supplied speech) or a locked row never moves.
 * Returns the same array when the move is not allowed.
 */
export function moveScene(scenes: FactoryDraftScene[], index: number, delta: -1 | 1, orderLocked: boolean): FactoryDraftScene[] {
  if (orderLocked) return scenes;
  const to = index + delta;
  if (to < 0 || to >= scenes.length) return scenes;
  if (scenes[index].locked || scenes[to].locked) return scenes;
  const next = scenes.slice();
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** Why Apply is not available right now. An empty list means it is available. */
export function applyBlockers(env: FactoryDraftEnvelope | null, unsavedEdits: boolean, reviewConfirmed: boolean): string[] {
  const reasons: string[] = [];
  if (!env) return ['Load a draft first.'];
  if (env.status !== 'review_required') reasons.push('Required inputs are missing. Resolve the list above first.');
  if (env.missing.length > 0) reasons.push(`${env.missing.length} required item(s) are missing.`);
  if (unsavedEdits) reasons.push('Save your selection first. Apply uses the saved draft only.');
  if (!reviewConfirmed) reasons.push('Confirm that you reviewed the selected treatment and its narration.');
  return reasons;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export interface ErrorView {
  title: string;
  detail: string;
  missing: FactoryMissingItem[];
  /** The action the user can take next. */
  next: 'reload' | 'fix_input' | 'retry' | 'none';
  /** Set on transport failures: no completion may be claimed. */
  completionConfirmed: false | null;
}

/**
 * Presentation of a failed call. The form and the draft on screen are kept by
 * the caller in every case; this only describes the failure.
 */
export function errorView(err: unknown): ErrorView {
  if (!(err instanceof FactoryApiError)) {
    return { title: 'Unexpected error', detail: 'Nothing is confirmed. Your inputs are kept.', missing: [], next: 'retry', completionConfirmed: null };
  }
  if (!err.answered) {
    return {
      title: 'No reply from the server',
      detail: 'No completion is confirmed. Reload the draft to check whether anything was created before you retry.',
      missing: [],
      next: 'reload',
      completionConfirmed: false,
    };
  }
  switch (err.code) {
    case 'FACTORY_REVISION_CONFLICT':
      return { title: 'The draft changed elsewhere', detail: `Your selection is kept on screen. Reload the draft (current revision ${err.currentRevision ?? 'unknown'}) and apply your choice again.`, missing: [], next: 'reload', completionConfirmed: null };
    case 'FACTORY_DRAFT_BUSY':
      return { title: 'Another change is running', detail: 'Wait a moment and retry. Nothing was changed.', missing: [], next: 'retry', completionConfirmed: null };
    case 'FACTORY_SCENE_LOCKED':
      return { title: 'A locked scene would change', detail: 'Locked scenes keep their row and speech. Keep the current selection, or ask for the treatment change after the lock is cleared.', missing: [], next: 'fix_input', completionConfirmed: null };
    case 'FACTORY_IDENTITY_REFUSED':
      return { title: 'Identity refused', detail: err.message, missing: [], next: 'fix_input', completionConfirmed: null };
    case 'FACTORY_ASSET_INVALID':
      return { title: 'An assigned picture is not usable', detail: err.message, missing: [], next: 'fix_input', completionConfirmed: null };
    case 'FACTORY_INPUTS_REQUIRED':
      return { title: 'Inputs are missing', detail: err.message, missing: err.missing, next: 'fix_input', completionConfirmed: null };
    case 'FACTORY_DRAFT_NOT_FOUND':
      return { title: 'Draft not found', detail: 'This draft no longer exists on the server. Start a new plan.', missing: [], next: 'none', completionConfirmed: null };
    case 'FACTORY_SPEECH_FAILED':
      return { title: 'Speech engine failed', detail: 'No audio was registered. Retry, or import approved audio.', missing: [], next: 'retry', completionConfirmed: null };
    case 'FACTORY_INTERNAL':
      return { title: 'The server could not finish', detail: 'The server reports that nothing was changed.', missing: [], next: 'retry', completionConfirmed: null };
    default:
      return { title: 'Request refused', detail: err.message, missing: err.missing, next: 'fix_input', completionConfirmed: null };
  }
}
