/**
 * Transitions for the technique and graphic of ONE editor clip. Pure: no React, no I/O.
 *
 * The inspector uses these plans to decide what, if anything, is staged. A plan is either:
 *  - stage: one canonical opUpdate on visualClips that the server will accept (the same validator as the route);
 *  - pending: the owner's choice is shown but nothing is staged yet (for example a graphic technique with no values);
 *  - refused: the choice cannot be saved as it stands, with the reason shown to the owner.
 *
 * An incomplete graphic is never staged. A staged graphic always carries its values and clears the picture source
 * in the same update, so the saved clip is never half-converted.
 */
import type { EditorGraphic } from '@buildtrack/core/visual';
import { kindOfTechnique } from './graphic-form';

/** The picture or footage a clip used before it became a graphic. Restored when the owner goes back to media. */
export interface MediaRestore {
  sourceAssetId: string;
  sourceInSec: number | null;
  sourceOutSec: number | null;
}

export interface ClipGraphicState {
  technique?: string | null;
  graphic?: EditorGraphic | null;
  sourceAssetId: string | null;
}

export type TechniquePlan =
  | { status: 'stage'; changes: Record<string, unknown> }
  | { status: 'pending'; technique: string | null; reason: string }
  | { status: 'refused'; technique: string | null; reason: string };

const MEDIA_TECHNIQUES = new Set(['still_image', 'footage_clip', 'screen_recording']);

/** Plan a change of the clip's technique. `next` null means no technique (the clip returns to its picture). */
export function planTechniqueChange(clip: ClipGraphicState, next: string | null, restore: MediaRestore | null): TechniquePlan {
  if (next === null) {
    if (clip.sourceAssetId !== null) return { status: 'stage', changes: { technique: null, graphic: null } };
    if (restore) return { status: 'stage', changes: { technique: null, graphic: null, ...restore } };
    return { status: 'refused', technique: null, reason: 'This clip has no picture or footage. Choose one in the picture picker below, then clear the technique.' };
  }
  const kind = kindOfTechnique(next);
  if (kind !== null) {
    if (clip.graphic && clip.graphic.kind === kind) return { status: 'stage', changes: { technique: next } };
    return { status: 'pending', technique: next, reason: 'Enter the values for this graphic. Nothing is saved until they are complete.' };
  }
  if (MEDIA_TECHNIQUES.has(next)) {
    if (clip.sourceAssetId !== null) return { status: 'stage', changes: { technique: next, graphic: null } };
    if (restore) return { status: 'stage', changes: { technique: next, graphic: null, ...restore } };
    return { status: 'refused', technique: next, reason: 'Choose a picture or footage for this clip in the picture picker below first. A media technique needs a supplied asset.' };
  }
  return { status: 'refused', technique: next, reason: `${next} is not a technique of the visual-language registry.` };
}

/** Plan the values of a graphic for a technique. `graphic` null means the values are not complete yet. */
export function planGraphicValues(technique: string, graphic: EditorGraphic | null): TechniquePlan {
  const kind = kindOfTechnique(technique);
  if (kind === null) return { status: 'refused', technique, reason: `${technique} is not a graphic technique.` };
  if (graphic === null) return { status: 'pending', technique, reason: 'Not saved: enter every value to save this graphic.' };
  if (graphic.kind !== kind) return { status: 'refused', technique, reason: `The graphic is a ${graphic.kind}, not a ${kind}.` };
  return {
    status: 'stage',
    changes: { technique: kind, graphic, sourceAssetId: null, sourceInSec: null, sourceOutSec: null },
  };
}
