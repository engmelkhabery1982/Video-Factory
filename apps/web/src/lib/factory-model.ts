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
  FactoryNarrationMode,
  FactoryProfile,
  FactoryTimingSource,
  FactoryTreatment,
  FactoryCreateBody,
  FactoryVisualRole,
} from './factory-api';
import { FactoryApiError } from './factory-api';
import { DEFAULT_VISUAL_LANGUAGE_FOR_PROFILE, type VisualLanguageId } from '@buildtrack/core/visual';

/** The six entry paths. Each reaches the same reviewable draft; only the supplied inputs differ. */
export type PlanInputMode = 'brief' | 'script' | 'audio_script' | 'storyboard' | 'images' | 'video_narration';
export type PlanIdentity = 'none' | 'buildtrack';

/** `auto` keeps the legacy rule (supplied audio when audio is attached, otherwise generate). */
export type PlanNarrationChoice = 'auto' | FactoryNarrationMode;

/** One storyboard card. The narration is optional: a picture panel may carry no words. */
export interface StoryboardPanelDraft {
  key: string;
  id: string;
  narration: string;
  assetId: string | null;
  /** Kept through import and export. Cards may leave these unset; the server keeps what it stored. */
  speakerId?: string | null;
  startSec?: number | null;
  endSec?: number | null;
  locked?: boolean;
}

export interface PlanForm {
  profile: FactoryProfile;
  format: FactoryFormat;
  identity: PlanIdentity;
  brief: string;
  /** Starting point only. It chooses which library kinds the attachment list offers; every material stays editable. */
  inputMode: PlanInputMode;
  script: string;
  storyboardText: string;
  audioAssetId: string | null;
  visualAssetIds: string[];
  /** Project visual language. Pre-selected from the profile default; the owner may change it before Create. */
  visualLanguage: VisualLanguageId | null;
  /* Optional-input contract. */
  narrationChoice: PlanNarrationChoice;
  captions: boolean;
  visualRoles: Record<string, FactoryVisualRole>;
  /** Manual descriptions the owner typed for pictures. Never generated. Sent only for attached pictures. */
  visualNotes: Record<string, string>;
  /** Storyboard cards, edited in the UI. The JSON text is an import and export, never required. */
  panels: StoryboardPanelDraft[];
  /** A reviewed transcript of the attached audio, once the owner has reviewed one. */
  transcriptJobId: string | null;
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
  visualLanguage: DEFAULT_VISUAL_LANGUAGE_FOR_PROFILE.educational,
  narrationChoice: 'auto',
  captions: true,
  visualRoles: {},
  visualNotes: {},
  panels: [],
  transcriptJobId: null,
};

/* ------------------------------------------------------------------ */
/* Storyboard cards                                                    */
/* ------------------------------------------------------------------ */

let panelCounter = 0;

/** A new card with an id no other card uses. */
export function newPanel(panels: StoryboardPanelDraft[], assetId: string | null = null): StoryboardPanelDraft {
  const used = new Set(panels.map((p) => p.id));
  let n = panels.length + 1;
  while (used.has(`p${String(n).padStart(2, '0')}`)) n += 1;
  panelCounter += 1;
  return { key: `panel-${panelCounter}`, id: `p${String(n).padStart(2, '0')}`, narration: '', assetId };
}

/** Move a card up (-1) or down (+1). Out-of-range moves are refused by returning the list unchanged. */
export function movePanel(panels: StoryboardPanelDraft[], index: number, delta: -1 | 1): StoryboardPanelDraft[] {
  const to = index + delta;
  if (index < 0 || index >= panels.length || to < 0 || to >= panels.length) return panels;
  const next = [...panels];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** The storyboard document for the cards. Versioned. Every field a card carries is written back exactly. */
export function panelsToStoryboard(panels: StoryboardPanelDraft[]): { version: 1; scenes: Array<Record<string, unknown>> } {
  return {
    version: 1,
    scenes: panels.map((p) => ({
      id: p.id,
      narration: p.narration,
      speakerId: p.speakerId ?? null,
      assetId: p.assetId,
      startSec: p.startSec ?? null,
      endSec: p.endSec ?? null,
      locked: p.locked === true,
    })),
  };
}

/** Cards from a versioned storyboard document (import). Ids, assets, speakers, times and locks are kept as given. */
export function panelsFromStoryboard(sb: { version: 1; scenes: Array<Record<string, unknown>> }): StoryboardPanelDraft[] {
  return sb.scenes.map((sc, i) => {
    panelCounter += 1;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      key: `panel-${panelCounter}`,
      id: typeof sc.id === 'string' && sc.id ? sc.id : `p${String(i + 1).padStart(2, '0')}`,
      narration: typeof sc.narration === 'string' ? sc.narration : '',
      assetId: typeof sc.assetId === 'string' && sc.assetId ? sc.assetId : null,
      speakerId: typeof sc.speakerId === 'string' && sc.speakerId ? sc.speakerId : null,
      startSec: num(sc.startSec),
      endSec: num(sc.endSec),
      locked: sc.locked === true,
    };
  });
}

/**
 * Parse a Start or End control. Empty means no time (null). Anything that is not a finite number of seconds
 * from 0 is 'invalid'; the server checks the pair again.
 */
export function parseSeconds(raw: string): number | null | 'invalid' {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : 'invalid';
}

/** Client-side hints for timing (both or neither; end after start; no overlap). The server's check is authoritative. */
export function storyboardTimingProblems(panels: StoryboardPanelDraft[]): string[] {
  const out: string[] = [];
  panels.forEach((p, i) => {
    const s = p.startSec ?? null;
    const e = p.endSec ?? null;
    if ((s === null) !== (e === null)) out.push(`Panel ${i + 1}: set both Start and End, or neither.`);
    else if (s !== null && e !== null && !(e > s)) out.push(`Panel ${i + 1}: End must be after Start.`);
  });
  for (let i = 1; i < panels.length; i += 1) {
    const a = panels[i - 1].endSec ?? null;
    const b = panels[i].startSec ?? null;
    if (a !== null && b !== null && b < a) out.push(`Panel ${i + 1} starts before panel ${i} ends.`);
  }
  return out;
}

/** Panels whose timing differs from the stored storyboard. Changing these needs the owner's confirmation. */
export function timingChangedIds(panels: StoryboardPanelDraft[], stored: Array<{ id: string; startSec: number | null; endSec: number | null }>): string[] {
  const byId = new Map(stored.map((s) => [s.id, s]));
  return panels.filter((p) => {
    const prev = byId.get(p.id);
    return prev !== undefined && (prev.startSec !== (p.startSec ?? null) || prev.endSec !== (p.endSec ?? null));
  }).map((p) => p.id);
}

/** Change the profile and pre-select that profile's default visual language. The owner can override it. */
export function withProfile(form: PlanForm, profile: FactoryProfile): PlanForm {
  return { ...form, profile, visualLanguage: DEFAULT_VISUAL_LANGUAGE_FOR_PROFILE[profile] };
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

/**
 * Pictures and footage that an input mode can use. A mode's attachments are an explicit list shown in the form.
 * When the mode changes, any attachment the new mode cannot use is removed and the owner is told which one and why.
 * Attachments that the new mode can use are kept, so brief + references and storyboard + assets keep their choices.
 */
export const MODE_ATTACHMENT_KINDS: Record<PlanInputMode, ReadonlyArray<'image' | 'video'>> = {
  brief: ['image', 'video'],
  script: ['image', 'video'],
  audio_script: ['image', 'video'],
  storyboard: ['image', 'video'],
  images: ['image'],
  video_narration: ['video'],
};

/** A library item's attachment kind from its MIME type: pictures are images, recordings and clips are video. */
export function visualKindOf(mimeType: string | null | undefined): 'image' | 'video' | null {
  const m = (mimeType ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return null;
}

export interface AttachmentChange {
  kept: string[];
  removed: Array<{ id: string; name: string; kind: string }>;
}

/** Keep the attachments the mode accepts. Unknown ids (not in the library) are removed, never silently sent. */
export function attachmentsForMode(
  mode: PlanInputMode,
  attached: readonly string[],
  library: ReadonlyArray<{ id: string; name: string; kind: string }>,
): AttachmentChange {
  const accepted = MODE_ATTACHMENT_KINDS[mode];
  const kept: string[] = [];
  const removed: AttachmentChange['removed'] = [];
  for (const id of attached) {
    const item = library.find((a) => a.id === id);
    if (item && (accepted as readonly string[]).includes(item.kind)) kept.push(id);
    else removed.push({ id, name: item?.name ?? id, kind: item?.kind ?? 'unknown' });
  }
  return { kept, removed };
}

/** A visible sentence for removed attachments, or null when nothing was removed. */
export function attachmentNotice(mode: PlanInputMode, removed: AttachmentChange['removed']): string | null {
  if (removed.length === 0) return null;
  const names = removed.map((r) => `${r.name} (${r.kind})`).join(', ');
  return `Removed ${names}: ${INPUT_MODE_LABELS[mode]} accepts ${MODE_ATTACHMENT_KINDS[mode].join(' or ')} only.`;
}

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
  images: 'Reviewed script with supplied pictures',
  video_narration: 'Video with narration (ready audio, its script, supplied footage)',
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
  if (profile === 'educational') return 'Educational treatments add no product mention or call to action. Only words you supply in the script are used. A separate contextual product-mention option is not built yet.';
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
  // No material is mandatory because a starting point was chosen. With no material at all, a topic is asked for.
  // The brief starting point does not send script text (see scriptSentFor), so that text is not material either.
  const hasMaterial = scriptSentFor(form) || !!form.audioAssetId || form.visualAssetIds.length > 0 || form.panels.length > 0 || !!form.storyboardText.trim();
  if (!form.brief.trim() && !hasMaterial) {
    errors.push('Write a topic, or add material: a script, audio, pictures, a storyboard or a video. Nothing is guessed.');
  }
  if (form.panels.length > 0) {
    storyboard = panelsToStoryboard(form.panels);
  } else if (form.storyboardText.trim()) {
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
/**
 * Plain-text storyboard: one panel per non-blank line. A line may start with `id:` (letters, digits, `_` or `-`) to name
 * the panel; otherwise the panel gets the next free `pNN` id. Words are optional: `p03:` alone is a picture panel.
 * Plain text carries IDs and words only. Timing, speaker and lock are JSON-only and are never invented here.
 */
export function parsePlainStoryboard(text: string): { ok: true; storyboard: { version: 1; scenes: Array<Record<string, unknown>> } } | { ok: false; error: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: false, error: 'The storyboard text is empty. Nothing was sent.' };
  if (lines.length > 200) return { ok: false, error: 'A storyboard text may hold at most 200 panels.' };
  const explicit = /^([A-Za-z0-9_-]{1,40}):\s*(.*)$/;
  const scenes: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    const m = explicit.exec(line);
    const id = m ? m[1] : `p${String(i + 1).padStart(2, '0')}`;
    const words = m ? m[2] : line;
    scenes.push({ id, narration: words, speakerId: null, assetId: null, startSec: null, endSec: null, locked: false });
    seen.add(id);
  });
  if (seen.size !== scenes.length) return { ok: false, error: 'Two panels have the same id. Give each panel its own id, then import again.' };
  return { ok: true, storyboard: { version: 1, scenes } };
}

/** Plain-text export of the cards: `id: words`, one per line. Lossy by design (see parsePlainStoryboard). */
export function panelsToPlainText(panels: StoryboardPanelDraft[]): string {
  return panels.map((p) => (p.narration.trim() ? `${p.id}: ${p.narration.replace(/\s*\n\s*/g, ' ')}` : `${p.id}:`)).join('\n');
}

export function parseStoryboardText(text: string): { ok: true; storyboard: { version: 1; scenes: Array<Record<string, unknown>> } } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: 'Paste a storyboard JSON document (version 1) or plain text, one panel per line.' };
  if (!/^\s*[{[]/.test(text)) return parsePlainStoryboard(text);
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

/**
 * Script text is sent unless the starting point is `brief`. A brief route never sends text the owner set aside
 * for another route: the field is kept, shown with a note, and not sent.
 */
export function scriptSentFor(form: Pick<PlanForm, 'inputMode' | 'script'>): boolean {
  return form.inputMode !== 'brief' && form.script.trim().length > 0;
}

/**
 * The create request for a checked form. Materials are additive: every material the form holds is sent, and
 * the server reports what is missing. Roles are sent only for pictures that are still attached.
 * Callers must check `checkPlanForm` first.
 */
export function buildCreateBody(form: PlanForm, storyboard: FactoryCreateBody['inputs']['storyboard']): FactoryCreateBody {
  const roles = Object.fromEntries(Object.entries(form.visualRoles).filter(([id]) => form.visualAssetIds.includes(id)));
  const notes = Object.fromEntries(Object.entries(form.visualNotes).filter(([id, text]) => form.visualAssetIds.includes(id) && text.trim().length > 0));
  return {
    contentProfile: form.profile,
    format: form.format,
    channelBrandId: form.identity === 'buildtrack' ? 'buildtrack' : null,
    inputs: {
      brief: form.brief.trim(),
      script: scriptSentFor(form) ? form.script : null,
      audioAssetId: form.audioAssetId,
      visualAssetIds: form.visualAssetIds,
      storyboard,
      narrationMode: form.narrationChoice === 'auto' ? null : form.narrationChoice,
      captions: form.captions,
      visualRoles: roles,
      visualNotes: notes,
      transcriptJobId: form.audioAssetId ? form.transcriptJobId : null,
    },
    requestedSpeakers: [],
    referenceProjectId: null,
    visualLanguage: form.visualLanguage,
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

/* ------------------------------------------------------------------ */
/* Reloading cards over unsaved edits (3-way merge by panel id).       */
/* ------------------------------------------------------------------ */

const MERGE_FIELDS = ['narration', 'assetId', 'speakerId', 'startSec', 'endSec', 'locked'] as const;
type MergeField = (typeof MERGE_FIELDS)[number];

export interface StoryboardMergeConflict {
  id: string;
  field: MergeField;
  yours: unknown;
  theirs: unknown;
}

export interface StoryboardMergeResult {
  panels: StoryboardPanelDraft[];
  /** Same field changed both here and in the newer stored storyboard. Your value is kept and listed. */
  conflicts: StoryboardMergeConflict[];
  /** Panels the newer stored storyboard added. They appear after your cards. */
  addedByOthers: string[];
  /** Panels the newer stored storyboard removed, but you changed, so they are kept. */
  keptRemoved: string[];
}

const sameValue = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/**
 * Merge unsaved card edits (`local`) with the newer stored storyboard (`server`), against the storyboard the cards were
 * loaded from (`base`). A field you did not change takes the newer stored value. A field you changed keeps your value.
 * A field changed on both sides keeps your value and is reported as a conflict. Your order is kept. Nothing is dropped
 * silently: a stored panel you removed stays removed unless you changed it, and then it is kept and reported.
 */
export function mergeStoryboardEdits(
  base: StoryboardPanelDraft[],
  local: StoryboardPanelDraft[],
  server: StoryboardPanelDraft[],
): StoryboardMergeResult {
  const baseById = new Map(base.map((p) => [p.id, p]));
  const serverById = new Map(server.map((p) => [p.id, p]));
  const localIds = new Set(local.map((p) => p.id));
  const conflicts: StoryboardMergeConflict[] = [];
  const keptRemoved: string[] = [];
  const panels: StoryboardPanelDraft[] = [];

  for (const mine of local) {
    const before = baseById.get(mine.id);
    const theirs = serverById.get(mine.id);
    if (!theirs) {
      const removedByOthers = before !== undefined;
      if (removedByOthers && MERGE_FIELDS.every((f) => sameValue(before![f], mine[f]))) continue; // removed on both sides
      if (removedByOthers) keptRemoved.push(mine.id);
      panels.push(mine);
      continue;
    }
    const merged: StoryboardPanelDraft = { ...theirs, key: mine.key };
    for (const f of MERGE_FIELDS) {
      const youChanged = before === undefined || !sameValue(before[f], mine[f]);
      const theyChanged = before === undefined || !sameValue(before[f], theirs[f]);
      if (youChanged) {
        (merged as unknown as Record<string, unknown>)[f] = mine[f];
        if (theyChanged && !sameValue(mine[f], theirs[f])) conflicts.push({ id: mine.id, field: f, yours: mine[f], theirs: theirs[f] });
      }
    }
    panels.push(merged);
  }
  const addedByOthers: string[] = [];
  for (const theirs of server) {
    if (localIds.has(theirs.id) || baseById.has(theirs.id)) continue;
    addedByOthers.push(theirs.id);
    panels.push(theirs);
  }
  return { panels, conflicts, addedByOthers, keptRemoved };
}
