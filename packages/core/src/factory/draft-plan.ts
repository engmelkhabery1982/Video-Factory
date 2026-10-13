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
  type FactorySpeaker,
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

export interface FactoryPlanOptions {
  capabilities: FactoryPlanCapabilities;
  /** Eligible library visuals in library order, used to fulfil scenes that have no supplied asset. */
  libraryVisuals: FactoryLibraryVisual[];
  /** Ids of supplied visual assets (already verified by the API). */
  suppliedVisualIds: string[];
  /** True when a supplied audio asset covers the narration. */
  audioPresent: boolean;
}

export interface FactoryPlanResult {
  status: FactoryDraftStatus;
  units: FactoryPlanUnit[];
  treatments: FactoryTreatment[];
  selectedTreatmentId: string | null;
  speakers: FactorySpeaker[];
  missing: FactoryMissingItem[];
  warnings: string[];
}

export const FACTORY_LOCAL_RULES_WARNING =
  'Treatments are deterministic local rules over the supplied words. They are not semantic AI and no text provider was used.';

export function planFactoryDraft(input: FactoryDraftCreateInput, opts: FactoryPlanOptions): FactoryPlanResult {
  const warnings: string[] = [FACTORY_LOCAL_RULES_WARNING];
  const missing: FactoryMissingItem[] = [];
  const profile = input.contentProfile;

  // 1. Units. Storyboard scenes are already units; a script is split.
  let units: FactoryPlanUnit[] = [];
  if (input.inputs.storyboard) {
    units = input.inputs.storyboard.scenes.map((s) => ({
      id: s.id,
      narration: s.narration,
      language: detectLanguage(s.narration),
      speakerHint: s.speakerId,
      assetId: s.assetId,
      startSec: s.startSec,
      endSec: s.endSec,
      locked: s.locked,
    }));
  } else if (input.inputs.script) {
    const texts = splitNarrationUnits(input.inputs.script);
    if (texts.length > FACTORY_MAX_UNITS) {
      throw new FactoryError('FACTORY_VALIDATION', `The script has more than ${FACTORY_MAX_UNITS} narration units.`, 422);
    }
    units = texts.map((text, i) => ({
      id: `u${String(i + 1).padStart(2, '0')}`,
      narration: text,
      language: detectLanguage(text),
      speakerHint: null,
      assetId: null,
      startSec: null,
      endSec: null,
      locked: false,
    }));
  }

  // 2. Missing text. Audio text is unknown without a transcription engine.
  if (units.length === 0) {
    if (input.inputs.audioAssetId && !opts.capabilities.transcriptionAvailable) {
      missing.push({
        kind: 'transcription',
        sceneId: null,
        reason: 'The audio text is unknown and no transcription engine is configured. Supply the reviewed script or storyboard.',
      });
    } else {
      missing.push({ kind: 'script', sceneId: null, reason: 'Supply a reviewed script or a storyboard.' });
    }
    return { status: 'blocked', units: [], treatments: [], selectedTreatmentId: null, speakers: [], missing, warnings };
  }
  if (units.length < 2) {
    warnings.push('Only one narration unit was supplied. The three treatments cannot reorder anything; add more narration to compare structures.');
  }

  // 3. Speech per scene, unless supplied audio already covers the narration.
  if (!opts.audioPresent) {
    for (const u of units) {
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

  // 4. Visuals. Supplied assets are kept; other scenes take supplied, then library, images in order.
  const supplied = opts.suppliedVisualIds;
  const fallbacks: Array<{ id: string; origin: 'supplied' | 'library' }> = [
    ...supplied.map((id) => ({ id, origin: 'supplied' as const })),
    ...opts.libraryVisuals
      .filter((v) => !supplied.includes(v.id))
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

  // 5. Speakers. Requested voices must be configured; unassigned speakers take free voices in order.
  const treatments = buildTreatments(profile, units);
  const speakerIds: string[] = [];
  for (const t of treatments) {
    for (const s of t.scenes) if (s.speakerId && !speakerIds.includes(s.speakerId)) speakerIds.push(s.speakerId);
  }
  for (const r of input.requestedSpeakers) if (!speakerIds.includes(r.id)) speakerIds.push(r.id);
  const voices = opts.capabilities.voiceIds;
  for (const r of input.requestedSpeakers) {
    if (r.voiceId !== null && !voices.includes(r.voiceId)) {
      throw new FactoryError('FACTORY_VALIDATION', `voiceId "${r.voiceId}" is not a configured voice.`, 422);
    }
  }
  const { speakers, reused } = resolveFactorySpeakers(speakerIds, input.requestedSpeakers, voices, opts.capabilities.speechLanguages.en || opts.capabilities.speechLanguages.ar);
  if (reused) warnings.push('More speakers than configured voices. Some speakers share a voice; voice diversity is not complete.');
  if (voices.length === 0) {
    warnings.push('No speech engine runs here. No speaker has a voice; speech must be supplied as approved audio.');
  } else {
    warnings.push('Configured local voices are synthetic and not natural voices. Voice diversity is not complete.');
  }
  if (profile === 'religious' && !units.some((u) => /[﴿﴾«»"“”]|قال|يقول|تعالى/.test(u.narration))) {
    warnings.push('No quoted or scripture-marked passage was detected. Mark passages with quotation marks or ﴿﴾ so the reader structure applies.');
  }

  // 6. Selection and status.
  const status: FactoryDraftStatus = missing.length === 0 ? 'review_required' : 'blocked';
  return {
    status,
    units,
    treatments,
    selectedTreatmentId: treatments[0]?.id ?? null,
    speakers,
    missing,
    warnings,
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
