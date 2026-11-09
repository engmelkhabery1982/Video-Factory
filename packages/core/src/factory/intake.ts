/**
 * Optional-input contract for the factory intake. Pure: no I/O.
 *
 * Every combination of brief, script, storyboard, audio, pictures, video and a reviewed transcript is accepted.
 * Nothing is replaced silently: when two text sources disagree the owner picks the authority, and the planner
 * reports the conflict instead of choosing. Required gaps and optional suggestions are kept apart.
 */
import type {
  FactoryCompletionItem,
  FactoryCompletionKind,
  FactoryMissingItem,
  FactoryMissingKind,
  FactoryNarrationMode,
  FactoryTextAuthority,
  FactoryVisualRole,
} from './contract.js';

/** Silent scenes without reviewed times get this proposal duration. It is labelled and editable, never speech timing. */
export const FACTORY_SILENT_SCENE_SECONDS = 4;

/** Legacy resolution: an explicit mode wins; otherwise supplied audio means supplied narration, else generate. */
export function resolveNarrationMode(requested: FactoryNarrationMode | null | undefined, audioPresent: boolean): FactoryNarrationMode {
  if (requested) return requested;
  return audioPresent ? 'supplied' : 'generate';
}

/** Role of a picture. Absent roles keep the legacy meaning: a final shot. */
export function roleOfVisual(roles: Record<string, FactoryVisualRole> | undefined, assetId: string): FactoryVisualRole {
  return roles?.[assetId] ?? 'final_shot';
}

/** Pictures that may appear as shots. Reference roles never do. */
export function isShotRole(role: FactoryVisualRole): boolean {
  return role === 'final_shot' || role === 'storyboard_panel';
}

/** Comparison form of a text unit: whitespace collapsed, case and diacritics kept (Arabic diacritics are words). */
export function normalizeUnitText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface TextSourceUnits {
  source: FactoryTextAuthority;
  /** Units in order. Empty units are not compared. */
  units: string[];
}

/**
 * Whether the non-empty units of every source are the same sequence. A panel with no narration does not
 * count as a difference: it simply carries no words.
 */
export function textSourcesAgree(sources: TextSourceUnits[]): boolean {
  if (sources.length <= 1) return true;
  const seqs = sources.map((s) => s.units.map(normalizeUnitText).filter((t) => t.length > 0));
  const first = seqs[0];
  return seqs.every((seq) => seq.length === first.length && seq.every((t, i) => t === first[i]));
}

export const TEXT_SOURCE_LABELS: Record<FactoryTextAuthority, string> = {
  script: 'Script',
  storyboard: 'Storyboard text',
  transcript: 'Reviewed transcript',
};

/** The action the owner takes for each missing kind. Exact wording is part of the review queue contract. */
export const MISSING_ACTIONS: Record<FactoryMissingKind, string> = {
  script: 'Paste the reviewed script, or write a storyboard with narration.',
  transcription: 'Run local transcription on the audio, review the transcript, or supply the script.',
  speech: 'Choose narration none, supply the approved audio, or configure a voice for this language.',
  image: 'Add a picture or video for this scene, or choose a library picture for it.',
  recording: 'Record or supply the real screen recording for this shot. Nothing is fabricated.',
  speaker: 'Choose a voice for this speaker, or set narration to none.',
  timing: 'Give every scene a start and end time, or none, so the timeline is contiguous.',
  asset: 'Replace the asset that is not eligible, or change its role.',
  review: 'Review the derived rewrite at this revision.',
  conflict: 'Choose which text is the authority. Nothing is applied until you choose.',
  material: 'Add a topic, a script, a storyboard, or pictures. Nothing is guessed.',
  audio: 'Upload the approved audio, or choose generate or none for narration.',
};

/** Required gaps first (from missing items), then optional suggestions. Order is stable. */
export function completionQueueFor(
  missing: FactoryMissingItem[],
  suggestions: Array<Omit<FactoryCompletionItem, 'required' | 'kind'> & { kind: FactoryCompletionKind }> = [],
): FactoryCompletionItem[] {
  const required: FactoryCompletionItem[] = missing.map((m, i) => ({
    id: `missing-${m.kind}-${m.sceneId ?? 'draft'}-${i}`,
    kind: m.kind,
    required: true,
    sceneId: m.sceneId,
    label: m.reason,
    action: MISSING_ACTIONS[m.kind],
  }));
  const optional: FactoryCompletionItem[] = suggestions.map((s) => ({ ...s, required: false }));
  return [...required, ...optional];
}

/** Silent mode text for the review and the warnings list. */
export const SILENT_WARNING =
  'Silent video: no narration track. No speaker, voice, speech call, transcript or alignment is needed. Captions and titles stay optional.';
