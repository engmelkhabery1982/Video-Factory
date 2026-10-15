/**
 * Visual language registry, version 1. One versioned, validated list consumed by the planner, the API, the
 * editor UI and the renderer. It separates three things that used to be mixed:
 *
 *   (a) content profile and brand      -> EditorDocument.contentProfile / channelBrandId (unchanged)
 *   (b) project visual language        -> EditorDocument.visualLanguage (this file)
 *   (c) per-shot technique + parameters -> EditorVisualClip.technique / .graphic (editor/graphics.ts)
 *
 * A language declares the techniques it supports, the inputs it needs, the engine that actually produces the
 * pixels, and a capability state with the reason. Capabilities that no engine implements are listed as
 * UNAVAILABLE so they are never shown as ready.
 *
 * Nothing here calls a provider or starts a runtime. Declaring a technique does not prove it renders; the
 * renderer and its tests do that.
 */

export const VISUAL_LANGUAGE_REGISTRY_VERSION = 1 as const;

export const VISUAL_TECHNIQUE_IDS = [
  'process_path',
  'numeric_comparison',
  'actor_action',
  'kinetic_text',
  'still_image',
  'footage_clip',
  'screen_recording',
] as const;
export type VisualTechniqueId = (typeof VISUAL_TECHNIQUE_IDS)[number];

/** Techniques whose pixels come from structured data in the document (no media asset). */
export const GRAPHIC_TECHNIQUE_IDS = ['process_path', 'numeric_comparison', 'actor_action', 'kinetic_text'] as const;
export type GraphicTechniqueId = (typeof GRAPHIC_TECHNIQUE_IDS)[number];

export type VisualEngine = 'procedural_svg' | 'supplied_image' | 'supplied_video' | 'supplied_recording';
export type CapabilityState = 'ready' | 'requires_input' | 'requires_runtime';

export interface VisualTechnique {
  id: VisualTechniqueId;
  label: string;
  engine: VisualEngine;
  /** What the owner must supply or confirm before this technique can be used on a shot. */
  requiredInputs: string[];
  /** `ready`: rendered from document data. `requires_input`: needs a supplied asset. `requires_runtime`: needs a local runtime. */
  capability: CapabilityState;
  reason: string;
}

export interface VisualLanguage {
  id: VisualLanguageId;
  version: 1;
  label: string;
  summary: string;
  /** Techniques a shot in this language may use. */
  techniques: VisualTechniqueId[];
  /** The engine that actually produces the pixels for this language's own techniques. */
  engine: string;
  requiredInputs: string[];
  capability: CapabilityState;
  reason: string;
}

export const VISUAL_LANGUAGE_IDS = [
  'motion_explainer',
  'animated_story_2d',
  'illustrated_narrative',
  'screen_tutorial',
  'documentary_footage',
  'kinetic_typography',
  'mixed',
] as const;
export type VisualLanguageId = (typeof VISUAL_LANGUAGE_IDS)[number];

export const VISUAL_TECHNIQUES: Record<VisualTechniqueId, VisualTechnique> = {
  process_path: {
    id: 'process_path', label: 'Process path (animated nodes and a travelling marker)', engine: 'procedural_svg',
    requiredInputs: ['2 to 6 ordered steps with short labels'], capability: 'ready',
    reason: 'Drawn from structured steps. Frame-exact, no media.',
  },
  numeric_comparison: {
    id: 'numeric_comparison', label: 'Numeric comparison (bars with exact values)', engine: 'procedural_svg',
    requiredInputs: ['2 to 6 labelled numbers supplied by the owner, with a unit and a scale maximum'], capability: 'ready',
    reason: 'Bars grow to supplied values. Labels show the supplied value exactly, never an estimate.',
  },
  actor_action: {
    id: 'actor_action', label: '2D animated actors (poses and timed actions)', engine: 'procedural_svg',
    requiredInputs: ['1 to 6 simple actors or objects, and ordered timed actions'], capability: 'ready',
    reason: 'Procedural vector shapes with editable poses. Not generated cinema and not lip-sync.',
  },
  kinetic_text: {
    id: 'kinetic_text', label: 'Kinetic text (word and phrase emphasis)', engine: 'procedural_svg',
    requiredInputs: ['1 to 8 words or short phrases in the supplied language'], capability: 'ready',
    reason: 'Text is rendered as text, not as diffusion lettering. Direction follows the language.',
  },
  still_image: {
    id: 'still_image', label: 'Still image (local generation or owner-supplied)', engine: 'supplied_image',
    requiredInputs: ['an approved image: a bound local still or a supplied image with source and licence'], capability: 'requires_runtime',
    reason: 'Local generation needs the owner-host runtime, which is not verified. A supplied image works without it.',
  },
  footage_clip: {
    id: 'footage_clip', label: 'Footage clip (supplied video)', engine: 'supplied_video',
    requiredInputs: ['a supplied video with source and licence'], capability: 'requires_input',
    reason: 'Needs a supplied video. Trims and crops are supported; no generated footage.',
  },
  screen_recording: {
    id: 'screen_recording', label: 'Screen recording (supplied recording)', engine: 'supplied_recording',
    requiredInputs: ['a real screen recording supplied by the owner, with source and licence'], capability: 'requires_input',
    reason: 'Only a supplied video is a screen recording. A still is never a recording.',
  },
};

export const VISUAL_LANGUAGES: Record<VisualLanguageId, VisualLanguage> = {
  motion_explainer: {
    id: 'motion_explainer', version: 1, label: 'Motion-graphics explainer',
    summary: 'Animated diagrams, process paths, comparisons and data graphics driven by structured values.',
    techniques: ['process_path', 'numeric_comparison', 'kinetic_text', 'still_image'], engine: 'procedural_svg',
    requiredInputs: ['structured steps or supplied values'], capability: 'ready',
    reason: 'Procedural graphics are ready. Still images in this language need an approved image.',
  },
  animated_story_2d: {
    id: 'animated_story_2d', version: 1, label: '2D animated story',
    summary: 'Reusable local vector actors or objects with editable poses, positions and timed actions. Procedural 2D animation.',
    techniques: ['actor_action', 'kinetic_text'], engine: 'procedural_svg',
    requiredInputs: ['actors and ordered actions'], capability: 'ready',
    reason: 'Procedural 2D animation is ready. It is not generated cinema and it has no lip-sync.',
  },
  illustrated_narrative: {
    id: 'illustrated_narrative', version: 1, label: 'Illustrated narrative',
    summary: 'Locally generated or owner-supplied images, with deliberate composition and editable camera motion.',
    techniques: ['still_image'], engine: 'supplied_image',
    requiredInputs: ['approved stills (local generation or supplied)'], capability: 'requires_runtime',
    reason: 'Supplied stills work now. Local generation needs the owner-host runtime, which is not verified here.',
  },
  screen_tutorial: {
    id: 'screen_tutorial', version: 1, label: 'Screen tutorial',
    summary: 'Real screen recordings with source offset, timed focus, highlight and pointer, and readable file detail.',
    techniques: ['screen_recording', 'kinetic_text'], engine: 'supplied_recording',
    requiredInputs: ['real screen recordings with source and licence'], capability: 'requires_input',
    reason: 'Needs supplied recordings. Highlights are timed editor annotations over the recording.',
  },
  documentary_footage: {
    id: 'documentary_footage', version: 1, label: 'Documentary / footage',
    summary: 'Real supplied clips with supported trims and crops, and restrained overlays.',
    techniques: ['footage_clip', 'still_image'], engine: 'supplied_video',
    requiredInputs: ['supplied footage with source and licence'], capability: 'requires_input',
    reason: 'Needs supplied footage. No generated footage.',
  },
  kinetic_typography: {
    id: 'kinetic_typography', version: 1, label: 'Kinetic typography',
    summary: 'Deliberate word and phrase emphasis with RTL-safe layout. Rendered accurately as text.',
    techniques: ['kinetic_text'], engine: 'procedural_svg',
    requiredInputs: ['words or phrases in the supplied language'], capability: 'ready',
    reason: 'Ready. Text is rendered as text, never requested as lettering in a diffusion image.',
  },
  mixed: {
    id: 'mixed', version: 1, label: 'Mixed',
    summary: 'An editable combination of the above. Each shot records its own technique and reason.',
    techniques: [...VISUAL_TECHNIQUE_IDS], engine: 'composite',
    requiredInputs: ['depends on each shot technique'], capability: 'requires_input',
    reason: 'Ready for the techniques marked ready. Each other shot shows what it needs.',
  },
};

/**
 * Capabilities named in the product brief that no engine implements in this repository. They are listed so the
 * UI can say so. None is ever shown as ready, and none can be selected as a technique.
 */
export const UNAVAILABLE_VISUAL_CAPABILITIES: ReadonlyArray<{ id: string; label: string; reason: string }> = [
  { id: 'generative_video', label: 'Generated video', reason: 'No local or approved video generation engine is provisioned. Not available.' },
  { id: '3d_animation', label: '3D animation', reason: 'No 3D engine is provisioned. Not available.' },
  { id: 'avatar_lip_sync', label: 'Avatar or lip-sync', reason: 'No avatar or lip-sync engine is provisioned. Not available.' },
  { id: 'photoreal_video', label: 'Photorealistic generated video', reason: 'No photorealistic video engine is provisioned. Not available.' },
];

export function isVisualLanguageId(v: unknown): v is VisualLanguageId {
  return typeof v === 'string' && (VISUAL_LANGUAGE_IDS as readonly string[]).includes(v);
}

export function isVisualTechniqueId(v: unknown): v is VisualTechniqueId {
  return typeof v === 'string' && (VISUAL_TECHNIQUE_IDS as readonly string[]).includes(v);
}

export function isGraphicTechniqueId(v: unknown): v is GraphicTechniqueId {
  return typeof v === 'string' && (GRAPHIC_TECHNIQUE_IDS as readonly string[]).includes(v);
}

/**
 * Whether a language allows a technique on a shot. `mixed` allows every technique. The check is about the
 * declared list only: the technique's own inputs are checked where the shot is stored.
 */
export function languageAllowsTechnique(language: VisualLanguageId, technique: VisualTechniqueId): boolean {
  return VISUAL_LANGUAGES[language].techniques.includes(technique);
}

/** Every problem with the registry itself. Empty means the registry is internally consistent. */
export function validateVisualLanguageRegistry(): string[] {
  const problems: string[] = [];
  for (const id of VISUAL_LANGUAGE_IDS) {
    const lang = VISUAL_LANGUAGES[id];
    if (!lang) { problems.push(`language ${id} is missing`); continue; }
    if (lang.id !== id) problems.push(`language ${id} has a mismatched id`);
    if (lang.techniques.length === 0) problems.push(`language ${id} declares no technique`);
    for (const t of lang.techniques) {
      if (!VISUAL_TECHNIQUES[t]) problems.push(`language ${id} names unknown technique ${t}`);
    }
    if (!lang.reason || !lang.requiredInputs.length) problems.push(`language ${id} needs a capability reason and required inputs`);
  }
  for (const id of VISUAL_TECHNIQUE_IDS) {
    const t = VISUAL_TECHNIQUES[id];
    if (!t) { problems.push(`technique ${id} is missing`); continue; }
    if (!t.reason || !t.requiredInputs.length) problems.push(`technique ${id} needs a reason and required inputs`);
  }
  return problems;
}
