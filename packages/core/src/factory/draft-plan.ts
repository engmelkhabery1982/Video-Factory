/**
 * Pure draft planning: units, treatments, speakers, missing items, warnings.
 * The API supplies facts about the library and the engines it verified; this
 * module never probes anything itself.
 */
import {
  FactoryError,
  type FactoryDraftScene,
  type FactoryDraftStatus,
  type FactoryMissingItem,
  type FactoryCompletionItem,
  type FactoryCompletionKind,
  type FactoryNarrationMode,
  type FactorySpeaker,
  type FactoryTextAuthority,
  type FactoryTreatment,
} from './contract.js';
import type { FactoryDraftCreateInput } from './validation.js';
import {
  buildTreatments,
  detectLanguage,
  FACTORY_MAX_UNITS,
  splitNarrationUnits,
  type FactoryPlanUnit,
} from './planning.js';
import {
  completionQueueFor,
  isShotRole,
  resolveNarrationMode,
  roleOfVisual,
  SILENT_WARNING,
  TEXT_SOURCE_LABELS,
  textSourcesAgree,
  type TextSourceUnits,
} from './intake.js';

export interface FactoryLibraryVisual {
  id: string;
  kind: 'image' | 'video';
}

export interface FactoryPlanCapabilities {
  /** Language -> a runnable speech engine exists for it. */
  speechLanguages: { en: boolean; ar: boolean };
  transcriptionAvailable: boolean;
  /** Configured, verified voice ids. Empty when no speech engine runs. */
  voiceIds: string[];
}

/** A reviewed transcript of the supplied audio. `text` is set only when the owner reviewed it. */
export interface FactoryTranscriptFact {
  jobId: string;
  text: string | null;
  /** True when the transcript was made from different audio than the audio now attached. Never used. */
  stale: boolean;
}

export interface FactoryPlanOptions {
  capabilities: FactoryPlanCapabilities;
  /** Eligible library visuals in library order, used to fulfil scenes that have no supplied asset. */
  libraryVisuals: FactoryLibraryVisual[];
  /** Ids of supplied visual assets (already verified by the API). */
  suppliedVisualIds: string[];
  /** True when a supplied audio asset is attached. */
  audioPresent: boolean;
  /** Reviewed transcript for the attached audio, when the owner has one. */
  transcript?: FactoryTranscriptFact | null;
}

/** Which sources disagree and what the owner chose. Null when the texts agree or there is no text. */
export interface FactoryTextConflict {
  sources: TextSourceUnits[];
  /** Owner's choice, or null when none has been made yet. */
  authority: FactoryTextAuthority | null;
  /** Human labels for the sources, in the order shown to the owner. */
  labels: Record<string, string>;
}

export interface FactoryPlanResult {
  status: FactoryDraftStatus;
  units: FactoryPlanUnit[];
  treatments: FactoryTreatment[];
  selectedTreatmentId: string | null;
  speakers: FactorySpeaker[];
  speechOrderLocked: boolean;
  missing: FactoryMissingItem[];
  warnings: string[];
  /** The resolved narration mode. Legacy requests resolve to supplied or generate. */
  narrationMode: FactoryNarrationMode;
  textConflict: FactoryTextConflict | null;
  /** Required gaps and optional suggestions, in review order. */
  completion: FactoryCompletionItem[];
}

export const FACTORY_LOCAL_RULES_WARNING =
  'Treatments are deterministic local rules over the supplied words. They are not semantic AI and no text provider was used.';

const pad = (n: number) => String(n).padStart(2, '0');

export function planFactoryDraft(input: FactoryDraftCreateInput, opts: FactoryPlanOptions): FactoryPlanResult {
  const warnings: string[] = [FACTORY_LOCAL_RULES_WARNING];
  // Shown before any early return, so a blocked draft still says why a transcript was not used.
  if (opts.transcript?.stale) {
    warnings.push('A transcript was made from different audio than the audio attached now. It is not used. Run transcription again.');
  }
  const missing: FactoryMissingItem[] = [];
  const suggestions: Array<Omit<FactoryCompletionItem, 'required' | 'kind'> & { kind: FactoryCompletionKind }> = [];
  const profile = input.contentProfile;
  const intake = input.inputs.intake ?? {
    narrationMode: null, textAuthority: null, videoAudioPolicy: null, captions: true, visualRoles: {}, visualNotes: {}, transcriptJobId: null,
  };
  const narrationMode = resolveNarrationMode(intake.narrationMode, opts.audioPresent);
  const storyboard = input.inputs.storyboard;
  const transcript = opts.transcript ?? null;
  const transcriptText = transcript && !transcript.stale && transcript.text ? transcript.text : null;

  // 0. Mode checks that concern the attached audio. The owner resolves them; nothing is dropped silently.
  if (narrationMode === 'supplied' && !opts.audioPresent) {
    missing.push({ kind: 'audio', sceneId: null, reason: 'Supplied narration needs the approved audio. Upload it, or choose generate or none.' });
  }
  if (narrationMode !== 'supplied' && opts.audioPresent) {
    missing.push({
      kind: 'conflict',
      sceneId: null,
      reason: `Audio is attached but narration is set to ${narrationMode}. Choose supplied narration, or remove the audio.`,
    });
  }

  // 1. Text sources. Each is compared on its non-empty units; the owner chooses the authority when they differ.
  const sources: TextSourceUnits[] = [];
  if (storyboard) {
    const units = storyboard.scenes.map((sc) => sc.narration).filter((t) => t.trim().length > 0);
    if (units.length > 0) sources.push({ source: 'storyboard', units });
  }
  if (input.inputs.script) {
    const units = splitNarrationUnits(input.inputs.script);
    if (units.length > FACTORY_MAX_UNITS) {
      throw new FactoryError('FACTORY_VALIDATION', `The script has more than ${FACTORY_MAX_UNITS} narration units.`, 422);
    }
    sources.push({ source: 'script', units });
  }
  if (transcriptText) sources.push({ source: 'transcript', units: splitNarrationUnits(transcriptText) });

  const agree = textSourcesAgree(sources);
  const authority = intake.textAuthority;
  let textConflict: FactoryTextConflict | null = null;
  let primary: FactoryTextAuthority | null = null;
  if (sources.length > 0) {
    if (authority && !sources.some((x) => x.source === authority)) {
      // A chosen authority that is not supplied is refused, never ignored.
      textConflict = {
        sources,
        authority,
        labels: Object.fromEntries(sources.map((x) => [x.source, TEXT_SOURCE_LABELS[x.source]])),
      };
      missing.push({
        kind: 'conflict',
        sceneId: null,
        reason: `The chosen authority (${TEXT_SOURCE_LABELS[authority]}) is not supplied. Choose one of: ${sources.map((x) => TEXT_SOURCE_LABELS[x.source]).join(', ')}.`,
      });
    } else if (agree) {
      // Same words: the storyboard keeps its panels, then the script, then the transcript.
      primary = sources.find((x) => x.source === 'storyboard')?.source ?? sources.find((x) => x.source === 'script')?.source ?? 'transcript';
    } else if (authority && sources.some((x) => x.source === authority)) {
      primary = authority;
    } else {
      textConflict = {
        sources,
        authority: authority ?? null,
        labels: Object.fromEntries(sources.map((x) => [x.source, TEXT_SOURCE_LABELS[x.source]])),
      };
      missing.push({
        kind: 'conflict',
        sceneId: null,
        reason: authority
          ? `The chosen authority (${TEXT_SOURCE_LABELS[authority]}) is not supplied. Choose one of: ${sources.map((x) => TEXT_SOURCE_LABELS[x.source]).join(', ')}.`
          : `The texts disagree: ${sources.map((x) => TEXT_SOURCE_LABELS[x.source]).join(' and ')}. Choose the authority. Nothing was applied.`,
      });
    }
  } else if (authority) {
    missing.push({ kind: 'conflict', sceneId: null, reason: `The chosen authority (${TEXT_SOURCE_LABELS[authority]}) is not supplied.` });
  }

  // 2. Units. Storyboard panels are units as they are. A script or transcript is split; when a storyboard also
  //    exists and the script is the authority, panels map one-to-one by position, carrying their pictures and times.
  let units: FactoryPlanUnit[] = [];
  let unitsFromPanels = false;
  const suppliedFinals = opts.suppliedVisualIds.filter((id) => isShotRole(roleOfVisual(intake.visualRoles, id)));
  const picturesOnly = narrationMode === 'none' && sources.length === 0 && suppliedFinals.length > 0;
  // An explicitly supplied silent storyboard still owns panel identity, order, pictures and times.
  // Its empty narration does not make the attached library list authoritative.
  if (storyboard && (primary === 'storyboard' || (!primary && sources.length === 0 && narrationMode === 'none'))) {
    units = storyboard.scenes.map((sc) => ({
      id: sc.id,
      narration: sc.narration,
      language: detectLanguage(sc.narration),
      speakerHint: sc.speakerId,
      assetId: sc.assetId,
      startSec: sc.startSec,
      endSec: sc.endSec,
      locked: sc.locked,
    }));
    unitsFromPanels = true;
  } else if (primary && primary !== 'storyboard') {
    const texts = sources.find((x) => x.source === primary)?.units ?? [];
    const panels = storyboard?.scenes ?? [];
    if (storyboard && panels.length > 0 && panels.length !== texts.length) {
      missing.push({
        kind: 'conflict',
        sceneId: null,
        reason: `The ${TEXT_SOURCE_LABELS[primary].toLowerCase()} has ${texts.length} unit${texts.length === 1 ? '' : 's'} and the storyboard has ${panels.length} panel${panels.length === 1 ? '' : 's'}. Make them match one-to-one, or choose the storyboard as the authority.`,
      });
    } else {
      units = texts.map((text, i) => {
        const panel = storyboard && panels.length > 0 ? panels[i] : null;
        return {
          id: panel ? panel.id : `u${pad(i + 1)}`,
          narration: text,
          language: detectLanguage(text),
          speakerHint: panel ? panel.speakerId : null,
          assetId: panel ? panel.assetId : null,
          startSec: panel ? panel.startSec : null,
          endSec: panel ? panel.endSec : null,
          locked: panel ? panel.locked : false,
        };
      });
      unitsFromPanels = Boolean(panels.length > 0);
    }
  } else if (picturesOnly) {
    // Silent pictures: one shot per supplied picture, in the reviewed order, with no words.
    units = suppliedFinals.map((assetId, i) => ({
      id: `p${pad(i + 1)}`,
      narration: '',
      language: 'und' as const,
      speakerHint: null,
      assetId,
      startSec: null,
      endSec: null,
      locked: false,
    }));
    unitsFromPanels = true;
  }

  if (units.length > FACTORY_MAX_UNITS) {
    throw new FactoryError('FACTORY_VALIDATION', `The draft has more than ${FACTORY_MAX_UNITS} scenes.`, 422);
  }

  // 3. Missing text, only when nothing else produced units and no conflict already explains it.
  if (units.length === 0 && !textConflict && !missing.some((m) => m.kind === 'conflict')) {
    if (narrationMode === 'none') {
      missing.push({
        kind: 'material',
        sceneId: null,
        reason: 'A silent video needs a topic, a storyboard, or pictures. A brief alone cannot become scenes, and no suggestion is written here.',
      });
    } else if (opts.audioPresent && !transcriptText) {
      missing.push({ kind: 'transcription', sceneId: null, reason: 'The audio text is unknown. Run local transcription and review it, or supply the reviewed script or storyboard.' });
    } else {
      const pictureNote = suppliedFinals.length > 0 ? ' Pictures alone need narration set to none (silent).' : '';
      missing.push({ kind: 'script', sceneId: null, reason: `Supply a reviewed script or a storyboard.${pictureNote}` });
    }
  }
  if (missing.length > 0 && units.length === 0) {
    return {
      status: 'blocked', units: [], treatments: [], selectedTreatmentId: null, speakers: [], speechOrderLocked: false,
      missing, warnings, narrationMode, textConflict,
      completion: completionQueueFor(missing, suggestions),
    };
  }
  if (units.length < 2 && narrationMode !== 'none') {
    warnings.push('Only one narration unit was supplied. The three treatments cannot reorder anything; add more narration to compare structures.');
  }

  // 4. Speech per scene. Supplied audio covers the narration; none is silent; generate speaks each line that has words.
  if (narrationMode === 'generate') {
    for (const u of units) {
      if (u.narration.trim().length === 0) continue;
      const speaks = u.language === 'en' ? opts.capabilities.speechLanguages.en
        : u.language === 'ar' ? opts.capabilities.speechLanguages.ar
          : false;
      if (!speaks) {
        const lang = u.language === 'ar' ? 'Arabic' : u.language === 'en' ? 'English' : 'an undetected language';
        missing.push({
          kind: 'speech',
          sceneId: u.id,
          reason: `No runnable speech engine for ${lang}. Supply the approved audio, or configure a voice for this language.`,
        });
      }
    }
  }

  // 5. Visuals. Reference pictures are never shots. Supplied shots are kept; other scenes take supplied, then library.
  const references = opts.suppliedVisualIds.filter((id) => !isShotRole(roleOfVisual(intake.visualRoles, id)));
  if (references.length > 0) {
    warnings.push(`${references.length} reference picture${references.length === 1 ? ' is' : 's are'} kept for reference only. ${references.length === 1 ? 'It is' : 'They are'} never shown as a shot.`);
  }
  for (const u of units) {
    if (u.assetId && !isShotRole(roleOfVisual(intake.visualRoles, u.assetId))) {
      missing.push({
        kind: 'asset',
        sceneId: u.id,
        reason: `Picture "${u.assetId}" is a reference, so it cannot be this scene's shot. Change its role, or pick another picture.`,
      });
    }
  }
  const fallbacks: Array<{ id: string; origin: 'supplied' | 'library' }> = [
    ...suppliedFinals.map((id) => ({ id, origin: 'supplied' as const })),
    // A picture attached to this draft as a reference (style or character) is never a shot, including as a fallback.
    ...opts.libraryVisuals
      .filter((v) => !opts.suppliedVisualIds.includes(v.id) && isShotRole(roleOfVisual(intake.visualRoles, v.id)))
      .map((v) => ({ id: v.id, origin: 'library' as const })),
  ];
  let cursor = 0;
  units = units.map((u) => {
    if (u.assetId) return u;
    if (fallbacks.length === 0) {
      missing.push({ kind: 'image', sceneId: u.id, reason: 'No supplied or licensed library image is available for this scene. No image engine is configured.' });
      return u;
    }
    const pick = fallbacks[cursor % fallbacks.length];
    cursor += 1;
    return { ...u, assetId: pick.id, assetOriginHint: pick.origin };
  });
  for (const u of units) {
    if (u.assetOriginHint === 'library') {
      suggestions.push({
        id: `library-${u.id}`,
        kind: 'library_picture',
        sceneId: u.id,
        label: `Scene ${u.id} uses a library picture (${u.assetId}) because no picture was supplied for it.`,
        action: 'Review the library picture for this scene, or supply your own picture.',
      });
    }
  }

  // 6. Order, treatments, speakers. Supplied audio, supplied times and reviewed silent panels keep their order.
  const speechOrderLocked = narrationMode === 'supplied'
    || units.some((u) => u.startSec !== null && u.endSec !== null)
    || (narrationMode === 'none' && unitsFromPanels);
  const assetKinds = new Map(opts.libraryVisuals.map((v) => [v.id, v.kind]));
  const visualLanguage = input.visualLanguage ?? null;
  let treatments = buildTreatments(profile, units, { orderLocked: speechOrderLocked, assetKinds, visualLanguage, format: input.format });
  if (speechOrderLocked && narrationMode === 'supplied') {
    warnings.push('Scene order is fixed to the supplied narration order. Treatments vary techniques, pacing and beat labels only; they do not reorder speech.');
  }
  if (narrationMode === 'supplied') {
    warnings.push('Speaker labels on a supplied recording are attributions for review. The recording is not re-voiced.');
  }
  for (const r of input.requestedSpeakers) {
    if (r.voiceId !== null && !opts.capabilities.voiceIds.includes(r.voiceId)) {
      throw new FactoryError('FACTORY_VALIDATION', `voiceId "${r.voiceId}" is not a configured voice.`, 422);
    }
  }
  let speakers: FactorySpeaker[] = [];
  if (narrationMode === 'none') {
    // Silent: no speaker, no voice, no TTS. Speaker fields are cleared on every scene.
    treatments = treatments.map((t) => ({ ...t, scenes: t.scenes.map((sc) => ({ ...sc, speakerId: null })) }));
    warnings.push(SILENT_WARNING);
  } else {
    const speakerIds: string[] = [];
    for (const t of treatments) {
      for (const sc of t.scenes) if (sc.speakerId && !speakerIds.includes(sc.speakerId)) speakerIds.push(sc.speakerId);
    }
    for (const r of input.requestedSpeakers) if (!speakerIds.includes(r.id)) speakerIds.push(r.id);
    const voices = opts.capabilities.voiceIds;
    const resolved = resolveFactorySpeakers(speakerIds, input.requestedSpeakers, voices, opts.capabilities.speechLanguages.en || opts.capabilities.speechLanguages.ar);
    speakers = resolved.speakers;
    if (resolved.reused) warnings.push('More speakers than configured voices. Some speakers share a voice; voice diversity is not complete.');
    if (voices.length === 0) {
      warnings.push('No speech engine runs here. No speaker has a voice; speech must be supplied as approved audio.');
    } else {
      warnings.push('Configured local voices are synthetic and not natural voices. Voice diversity is not complete.');
    }
  }
  if (profile === 'religious' && !units.some((u) => /[﴿﴾«»"“”]|قال|يقول|تعالى/.test(u.narration))) {
    warnings.push('No quoted or scripture-marked passage was detected. Mark passages with quotation marks or ﴿﴾ so the reader structure applies.');
  }
  if (textConflict) {
    warnings.push('The texts disagree. The treatments below are shown for review only; choose the authority before Apply.');
  }
  if (narrationMode !== 'none' && !intake.captions) {
    warnings.push('Captions are off for this draft.');
  }

  // 7. Status and the review queue.
  const status: FactoryDraftStatus = missing.length === 0 ? 'review_required' : 'blocked';
  return {
    status,
    units,
    treatments,
    selectedTreatmentId: treatments[0]?.id ?? null,
    speakers,
    speechOrderLocked,
    missing,
    warnings,
    narrationMode,
    textConflict,
    completion: completionQueueFor(missing, suggestions),
  };
}

/**
 * Resolve speakers to configured voices. Requested voices are kept when they
 * are configured; others take free voices in order, and share one only when
 * voices run out (reported as `reused`). A speaker is available only when a
 * voice is assigned and a speech engine runs.
 */
export function resolveFactorySpeakers(
  speakerIds: string[],
  requested: Array<{ id: string; voiceId: string | null }>,
  voices: string[],
  speechAvailable: boolean,
): { speakers: FactorySpeaker[]; reused: boolean } {
  for (const r of requested) {
    if (r.voiceId !== null && !voices.includes(r.voiceId)) {
      throw new FactoryError('FACTORY_VALIDATION', `voiceId "${r.voiceId}" is not a configured voice.`, 422);
    }
  }
  const requestedVoice = new Map(requested.map((r) => [r.id, r.voiceId]));
  const used = new Set<string>();
  for (const v of requestedVoice.values()) if (v) used.add(v);
  let reused = false;
  const speakers: FactorySpeaker[] = speakerIds.map((id) => {
    let voiceId = requestedVoice.get(id) ?? null;
    if (!voiceId && voices.length > 0) {
      const free = voices.find((v) => !used.has(v));
      if (free) {
        voiceId = free;
        used.add(free);
      } else {
        voiceId = voices[speakerIds.indexOf(id) % voices.length];
        reused = true;
      }
    }
    return { id, voiceId, available: voiceId !== null && speechAvailable };
  });
  return { speakers, reused };
}

/** Scenes of the selected treatment are the current selection until a PATCH changes them. */
export function selectionOf(treatments: FactoryTreatment[], selectedTreatmentId: string | null): FactoryDraftScene[] {
  return treatments.find((t) => t.id === selectedTreatmentId)?.scenes ?? [];
}
