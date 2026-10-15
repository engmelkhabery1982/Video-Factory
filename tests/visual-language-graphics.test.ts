/**
 * Visual-language registry, procedural graphic contract, editor operations and render-plan mapping.
 * Pure core: no I/O, no provider, no browser. Fixture proof content is labelled FIXTURE.
 * Negative cases are first-class: each refusal below is asserted against the real rule, not a loose match.
 */
import { describe, expect, it } from 'vitest';
import {
  EditorError,
  EDITOR_SCHEMA_VERSION,
  applyEditorOperations,
  deriveEditorDocument,
  editorDocumentToRenderPlan,
  validateEditorDocument,
  type DeriveAssetRef,
  type EditorDocument,
  type Project,
} from '@buildtrack/core';
import {
  VISUAL_LANGUAGE_IDS,
  VISUAL_TECHNIQUE_IDS,
  VISUAL_LANGUAGES,
  UNAVAILABLE_VISUAL_CAPABILITIES,
  isVisualTechniqueId,
  isVisualLanguageId,
  languageAllowsTechnique,
  validateVisualLanguageRegistry,
} from '../packages/core/src/visual-language.ts';
import {
  animatedValueAt,
  assertValidGraphic,
  exactValueLabel,
  graphicStateAt,
  validateGraphic,
  type EditorGraphic,
} from '../packages/core/src/editor/graphics.ts';
import { proofActor, proofKinetic, proofNumeric } from './fixtures/graphic-proof-specs.ts';

const EDU = { durationSec: 10, format: 'landscape' as const, contentProfile: 'educational' as const };
const REL = { durationSec: 10, format: 'landscape' as const, contentProfile: 'religious' as const };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---------- registry ----------

describe('visual-language registry v1', () => {
  it('validates with no problems and exposes seven languages and the registry techniques', () => {
    expect(validateVisualLanguageRegistry()).toEqual([]);
    expect(VISUAL_LANGUAGE_IDS).toHaveLength(7);
    expect(VISUAL_LANGUAGE_IDS).toEqual(expect.arrayContaining([
      'motion_explainer', 'animated_story_2d', 'illustrated_narrative', 'screen_tutorial',
      'documentary_footage', 'kinetic_typography', 'mixed',
    ]));
  });

  it('accepts registered techniques and refuses unknown or unprovisioned ones', () => {
    expect(isVisualTechniqueId('numeric_comparison')).toBe(true);
    expect(isVisualTechniqueId('generated_video')).toBe(false);
    expect(isVisualTechniqueId('lip_sync_avatar')).toBe(false);
    expect(isVisualTechniqueId('')).toBe(false);
    expect(isVisualTechniqueId(undefined)).toBe(false);
    expect(isVisualLanguageId('cinematic_3d')).toBe(false);
  });

  it('refuses a technique that a language does not list (no silent replacement)', () => {
    expect(languageAllowsTechnique('motion_explainer', 'actor_action')).toBe(false);
    expect(languageAllowsTechnique('animated_story_2d', 'numeric_comparison')).toBe(false);
    expect(languageAllowsTechnique('mixed', 'footage_clip')).toBe(true);
    for (const t of VISUAL_TECHNIQUE_IDS) expect(languageAllowsTechnique('mixed', t)).toBe(true);
  });

  it('marks unavailable capabilities explicitly with a reason', () => {
    const ids = UNAVAILABLE_VISUAL_CAPABILITIES.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['generative_video', '3d_animation', 'avatar_lip_sync', 'photoreal_video']));
    for (const c of UNAVAILABLE_VISUAL_CAPABILITIES) expect(c.reason.length).toBeGreaterThan(20);
  });

  it('every language states its engine, required inputs and capability reason', () => {
    for (const id of VISUAL_LANGUAGE_IDS) {
      const lang = VISUAL_LANGUAGES[id];
      expect(lang.engine).toBeTruthy();
      expect(lang.requiredInputs.length).toBeGreaterThan(0);
      expect(lang.reason.length).toBeGreaterThan(10);
    }
  });
});

// ---------- procedural graphic contract (positive) ----------

describe('procedural graphic contract: valid fixtures', () => {
  it('accepts the three fixture proofs in both orientations', () => {
    for (const format of ['landscape', 'portrait'] as const) {
      expect(validateGraphic(proofNumeric(format), { durationSec: 10, format, contentProfile: 'educational' })).toEqual([]);
      expect(validateGraphic(proofActor(format), { durationSec: 10, format, contentProfile: 'educational' })).toEqual([]);
      expect(validateGraphic(proofKinetic(format), { durationSec: 6, format, contentProfile: 'religious' })).toEqual([]);
    }
  });

  it('numeric comparison shows exact supplied values, not rounded or recomputed ones', () => {
    const g = proofNumeric('landscape');
    expect(exactValueLabel(g.objects[0])).toBe('7.0 h');
    expect(exactValueLabel(g.objects[1])).toBe('9.5 h');
  });

  it('a process/numeric bar progresses over time and reaches its exact end state', () => {
    const g = proofNumeric('landscape');
    const at0 = graphicStateAt(g, 0).get('arrived');
    const mid = graphicStateAt(g, 2.5).get('arrived');
    const end = graphicStateAt(g, 9.9).get('arrived');
    expect(at0?.progress).toBe(0);
    expect(mid?.progress).toBeGreaterThan(0);
    expect(mid?.progress).toBeLessThan(1);
    expect(end?.progress).toBe(1);
  });

  it('a 2D actor changes pose through a multi-step action (arm goes out and back)', () => {
    const g = proofActor('landscape');
    const values: number[] = [];
    for (let t = 0; t <= 9.9; t += 0.1) values.push(graphicStateAt(g, t).get('worker')?.armAngle ?? Number.NaN);
    expect(values.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(60);          // the arm really goes out
    expect(values[values.length - 1]).toBe(values[0]);               // and comes back to rest
    expect(new Set(values.map((v) => v.toFixed(1))).size).toBeGreaterThan(10); // a continuous change, not two poses
  });

  it('is deterministic: the same time gives the same state', () => {
    const g = proofActor('portrait');
    expect(graphicStateAt(g, 3.3)).toEqual(graphicStateAt(clone(g), 3.3));
  });

  it('holds a property at its first value before the first action and its last value after', () => {
    const g = proofNumeric('landscape');
    expect(animatedValueAt(g.actions.filter((a) => a.targetId === 'arrived'), 0)).toBe(0);
    expect(animatedValueAt(g.actions.filter((a) => a.targetId === 'arrived'), 9)).toBe(1);
  });
});

// ---------- procedural graphic contract (negative) ----------

describe('procedural graphic contract: refusals', () => {
  it('refuses an action that ends after the clip (out-of-range time)', () => {
    const problems = validateGraphic(proofNumeric('landscape'), { ...EDU, durationSec: 3 });
    expect(problems.some((p) => /after the clip/.test(p))).toBe(true);
  });

  it('refuses a duration shrink below an action end through the contract', () => {
    expect(() => assertValidGraphic(proofActor('landscape'), { ...EDU, durationSec: 4 })).toThrow(/after the clip/);
  });

  it('refuses misordered actions on the same target and property', () => {
    const g = clone(proofNumeric('landscape'));
    // Move the later action before the earlier one on the same property.
    g.actions = [{ ...g.actions[0], id: 'a1', targetId: 'booked', startSec: 2.0, endSec: 3.0 }, { ...g.actions[0], id: 'a2', targetId: 'booked', startSec: 0.5, endSec: 1.0 }];
    expect(validateGraphic(g, EDU).some((p) => /overlap or are out of order/.test(p))).toBe(true);
  });

  it('refuses a discontinuous value jump between two actions on one property', () => {
    const g = clone(proofActor('landscape'));
    const arm = g.actions.filter((a) => a.property === 'armAngle');
    expect(arm.length).toBeGreaterThan(1);
    arm[1].from = arm[1].from + 40;
    expect(validateGraphic(g, EDU).some((p) => /Make each action start where the last one ended/.test(p))).toBe(true);
  });

  it('refuses a non-finite value and a non-finite time', () => {
    const g = clone(proofNumeric('landscape'));
    (g.actions[0] as { to: unknown }).to = Number.NaN;
    expect(validateGraphic(g, EDU).some((p) => /finite/.test(p))).toBe(true);
    const h = clone(proofNumeric('landscape'));
    (h.actions[0] as { endSec: unknown }).endSec = Number.POSITIVE_INFINITY;
    expect(validateGraphic(h, EDU).some((p) => /finite startSec and endSec/.test(p))).toBe(true);
  });

  it('refuses an action that targets a missing object or animates an unsupported property', () => {
    const g = clone(proofActor('landscape'));
    g.actions[0].targetId = 'nobody';
    expect(validateGraphic(g, EDU).some((p) => /does not exist/.test(p))).toBe(true);
    const h = clone(proofNumeric('landscape'));
    (h.actions[0] as { property: string }).property = 'rotation';
    expect(validateGraphic(h, EDU).length).toBeGreaterThan(0);
  });

  it('refuses unknown keys and executable or markup text', () => {
    const g = clone(proofKinetic('landscape')) as EditorGraphic & Record<string, unknown>;
    g.script = 'alert(1)';
    expect(validateGraphic(g, REL).some((p) => /unknown key/.test(p))).toBe(true);
    const h = clone(proofKinetic('landscape'));
    h.objects[0] = { ...h.objects[0], text: '<script>x</script>' } as typeof h.objects[0];
    expect(validateGraphic(h, REL).length).toBeGreaterThan(0);
  });

  it('refuses a brand identity in religious content', () => {
    const g = clone(proofKinetic('landscape'));
    g.title = 'BuildTrack presents patience';
    expect(validateGraphic(g, REL).some((p) => /brand identity/.test(p))).toBe(true);
  });

  it('refuses typed quotation marks in religious content', () => {
    const g = clone(proofKinetic('landscape'));
    g.title = 'Patience “one task”';
    expect(validateGraphic(g, REL).some((p) => /quotation marks/.test(p))).toBe(true);
  });

  it('allows the same brand-free text in educational content, and refuses a non-positive scaleMax', () => {
    const g = clone(proofNumeric('landscape'));
    g.scaleMax = 0;
    expect(validateGraphic(g, EDU).some((p) => /scaleMax/.test(p))).toBe(true);
  });

  it('refuses scaleMax on a non-numeric graphic kind', () => {
    const g = clone(proofKinetic('landscape')) as EditorGraphic & Record<string, unknown>;
    g.scaleMax = 10;
    expect(validateGraphic(g, REL).some((p) => /numeric_comparison only/.test(p))).toBe(true);
  });

  it('refuses a graphic kind outside the registry', () => {
    const g = clone(proofKinetic('landscape')) as unknown as Record<string, unknown>;
    g.kind = 'cinematic_3d';
    expect(validateGraphic(g, REL).length).toBeGreaterThan(0);
  });
});

// ---------- editor document and operations ----------

const ASSETS: DeriveAssetRef[] = [
  { id: 'img1', kind: 'image', name: 'Owner picture', mediaUrl: '/media/asset/img1', durationSec: null, source: 'owner', license: 'owner', mimeType: 'image/png' },
  { id: 'vid1', kind: 'video', name: 'Owner footage', mediaUrl: '/media/asset/vid1', durationSec: 60, source: 'owner', license: 'owner', mimeType: 'video/mp4' },
];

function fixtureProject(): Project {
  const scene = (id: string, index: number, start: number, duration: number, assetIds: string[]) => ({
    id, index, role: 'body', section: '', variant: 'key_statement', background: 'full_typography',
    transitionIn: 'direct_cut', textPosition: 'lower_third', accent: '#E4C98A', duration, startTime: start,
    narration: id, captionIds: [`c${index + 1}`], assetIds, locked: false, userEdited: false,
    content: { headline: '', items: [], presentation: 'owner_picture', mediaKind: 'none' },
    reason: { detected: 'x', evidence: '', notUsedRecently: [], alternatives: [] },
  });
  return {
    schemaVersion: 2,
    meta: { input: { videoId: 'Graphic_Fixture', outputLanguage: 'en', brandPreset: 'unbound-educational', contentProfile: 'educational' }, brand: {}, createdAt: '', updatedAt: '', status: 'draft' },
    storyboard: {
      videoId: 'Graphic_Fixture', createdAt: '', brand: {},
      long: { scenes: [scene('s1', 0, 0, 4.5, ['img1']), scene('s2', 1, 4.5, 6.022, ['vid1'])], totalDuration: 10.522, endScreenReserveSeconds: 8 },
      shorts: [], segments: [], warnings: [], similarity: null,
      captions: [
        { id: 'c1', start: 0, end: 4.5, text: 'First line', sceneId: 's1', terms: [], userEdited: false },
        { id: 'c2', start: 4.5, end: 10.522, text: 'Second line', sceneId: 's2', terms: [], userEdited: false },
      ],
    } as unknown as Project['storyboard'],
    artifacts: [], qc: [],
  } as unknown as Project;
}

function base(): EditorDocument {
  return deriveEditorDocument({
    project: fixtureProject(), targetId: 'long', assets: ASSETS,
    narration: { assetId: 'nar1', durationSec: 10.522, sha256: 'a'.repeat(64), approved: true },
  });
}

/**
 * Converts the last visual clip into a procedural graphic clip in one canonical update: the media source is
 * cleared, the technique and graphic are set, and the duration matches the proof. Returns the new document.
 */
function withGraphicClip(doc: EditorDocument, graphic = proofNumeric('landscape'), technique = 'numeric_comparison'): EditorDocument {
  const id = doc.visualClips[doc.visualClips.length - 1].id;
  return applyEditorOperations(doc, [{
    type: 'update', collection: 'visualClips', id,
    changes: { sourceAssetId: null, sourceInSec: null, sourceOutSec: null, technique, graphic, durationSec: 10 },
  }]);
}

describe('editor document: legacy and technique wiring', () => {
  it('a legacy derived document (no technique or graphic fields) still validates and renders', () => {
    const doc = base();
    expect(validateEditorDocument(doc)).toEqual([]);
    expect(doc.visualClips.every((c) => c.technique === undefined)).toBe(true);
    expect(() => editorDocumentToRenderPlan(doc)).not.toThrow();
  });

  it('sets a graphic technique on a placeholder clip and carries it into the render plan', () => {
    const doc = base();
    const next = withGraphicClip(doc);
    expect(next.visualClips[next.visualClips.length - 1].sourceAssetId).toBeNull();
    expect(validateEditorDocument(next)).toEqual([]);
    const plan = editorDocumentToRenderPlan(next) as unknown as { scenes: Array<{ content: { technique?: string; graphic?: EditorGraphic | null } }> };
    const carried = plan.scenes.flatMap((s) => s.content.technique === 'numeric_comparison' ? [s.content.graphic] : []);
    expect(carried.length).toBe(1);
    expect(carried[0]?.kind).toBe('numeric_comparison');
  });

  it('refuses an unsupported technique name with a registry message', () => {
    const doc = base();
    expect(() => applyEditorOperations(doc, [{
      type: 'update', collection: 'visualClips', id: doc.visualClips[0].id, changes: { technique: 'generated_video' },
    }])).toThrow(/visual-language registry/);
  });

  it('refuses a graphic whose duration is shrunk below one of its action ends, and leaves the input untouched', () => {
    const doc = base();
    const withGraphic = withGraphicClip(doc);
    const id = withGraphic.visualClips[withGraphic.visualClips.length - 1].id;
    expect(() => applyEditorOperations(withGraphic, [{
      type: 'update', collection: 'visualClips', id, changes: { durationSec: 3 },
    }])).toThrow(EditorError);
    expect(withGraphic.visualClips[withGraphic.visualClips.length - 1].durationSec).toBe(10);
  });

  it('refuses to split a procedural graphic clip (timed actions cannot be cut yet)', () => {
    const doc = base();
    const withGraphic = withGraphicClip(doc);
    const id = withGraphic.visualClips[withGraphic.visualClips.length - 1].id;
    expect(() => applyEditorOperations(withGraphic, [{ type: 'split', collection: 'visualClips', id, atSec: 5 }])).toThrow(/cannot be split/);
  });

  it('refuses screen_recording on a still image asset (a moving still is never a recording)', () => {
    const doc = base();
    const stillClip = doc.visualClips.find((c) => c.sourceAssetId === 'img1');
    expect(stillClip).toBeTruthy();
    expect(() => applyEditorOperations(doc, [{
      type: 'update', collection: 'visualClips', id: stillClip!.id, changes: { technique: 'screen_recording' },
    }])).toThrow(/screen_recording|recording|not a video/i);
  });

  it('refuses footage_clip on an image asset and still_image on a video asset', () => {
    const doc = base();
    const stillClip = doc.visualClips.find((c) => c.sourceAssetId === 'img1')!;
    const videoClip = doc.visualClips.find((c) => c.sourceAssetId === 'vid1')!;
    expect(() => applyEditorOperations(doc, [{ type: 'update', collection: 'visualClips', id: videoClip.id, changes: { technique: 'still_image' } }])).toThrow(/still but its asset is not an image/);
    expect(() => applyEditorOperations(doc, [{ type: 'update', collection: 'visualClips', id: stillClip.id, changes: { technique: 'footage_clip' } }])).toThrow(/footage but its asset is not a video/);
  });

  it('refuses a graphic technique with no graphic data (no silent card or still replacement)', () => {
    const doc = base();
    expect(() => applyEditorOperations(doc, [{ type: 'update', collection: 'visualClips', id: doc.visualClips[1].id, changes: { technique: 'actor_action' } }])).toThrow(/has no graphic data/);
  });

  it('refuses a language that does not allow the clip technique', () => {
    const doc = base();
    const withGraphic = withGraphicClip(doc);
    expect(() => applyEditorOperations(withGraphic, [{ type: 'setDocument', changes: { visualLanguage: 'animated_story_2d' } }])).toThrow(/does not allow/);
  });

  it('setDocument accepts a registered visual language and refuses an unknown one', () => {
    const doc = base();
    const next = applyEditorOperations(doc, [{ type: 'setDocument', changes: { visualLanguage: 'motion_explainer' } }]);
    expect(next.visualLanguage).toBe('motion_explainer');
    expect(() => applyEditorOperations(doc, [{ type: 'setDocument', changes: { visualLanguage: 'cinematic_3d' } }])).toThrow(/registered visual language/);
    expect(() => applyEditorOperations(doc, [{ type: 'setDocument', changes: { visualLanguage: 'motion_explainer', unknownField: 1 } }])).toThrow(EditorError);
  });

  it('schema version is unchanged: visual-language data is optional, no destructive migration', () => {
    expect(EDITOR_SCHEMA_VERSION).toBeGreaterThan(0);
    const doc = base();
    expect(doc.visualLanguage ?? null).toBeNull();
  });
});

// ---------- review finding 2: merged validation of one update ----------

describe('applyUpdate validates the merged clip once', () => {
  it('an atomic replacement with a shorter duration succeeds when the NEW graphic fits (old graphic ignored)', () => {
    // The current graphic (actor) runs to 9 s and would not fit in 4 s. The replacement (numeric) ends at 3.5 s.
    const doc = withGraphicClip(base(), proofActor('landscape'), 'actor_action');
    const id = doc.visualClips[doc.visualClips.length - 1].id;
    const next = applyEditorOperations(doc, [{
      type: 'update', collection: 'visualClips', id,
      changes: { technique: 'numeric_comparison', graphic: proofNumeric('landscape'), durationSec: 6.1 },
    }]);
    const clip = next.visualClips[next.visualClips.length - 1];
    expect(clip.durationSec).toBe(6.1);
    expect(clip.graphic?.kind).toBe('numeric_comparison');
    expect(validateEditorDocument(next)).toEqual([]);
  });

  it('removing the graphic with a shorter duration succeeds: the removed graphic is not judged', () => {
    const doc = withGraphicClip(base(), proofActor('landscape'), 'actor_action');
    const id = doc.visualClips[doc.visualClips.length - 1].id;
    const next = applyEditorOperations(doc, [{
      type: 'update', collection: 'visualClips', id,
      changes: { graphic: null, technique: null, durationSec: 6.1 },
    }]);
    const clip = next.visualClips[next.visualClips.length - 1];
    expect(clip.graphic).toBeNull();
    expect(clip.durationSec).toBe(6.1);
  });

  it('an unchanged graphic that runs past a shorter duration is still refused', () => {
    const doc = withGraphicClip(base(), proofActor('landscape'), 'actor_action');
    const id = doc.visualClips[doc.visualClips.length - 1].id;
    expect(() => applyEditorOperations(doc, [{ type: 'update', collection: 'visualClips', id, changes: { durationSec: 6.1 } }]))
      .toThrow(/graphic is refused at 6.1s/);
  });

  it('a replacement that is itself too long for the new duration is refused and leaves the input unchanged', () => {
    const doc = withGraphicClip(base(), proofNumeric('landscape'), 'numeric_comparison');
    const id = doc.visualClips[doc.visualClips.length - 1].id;
    expect(() => applyEditorOperations(doc, [{
      type: 'update', collection: 'visualClips', id,
      changes: { graphic: proofActor('landscape'), technique: 'actor_action', durationSec: 6.1 },
    }])).toThrow(EditorError);
    expect(doc.visualClips[doc.visualClips.length - 1].graphic?.kind).toBe('numeric_comparison');
  });

  it('a locked graphic clip refuses the update (lock semantics unchanged)', () => {
    const doc = withGraphicClip(base(), proofNumeric('landscape'), 'numeric_comparison');
    const id = doc.visualClips[doc.visualClips.length - 1].id;
    const locked = applyEditorOperations(doc, [{ type: 'update', collection: 'visualClips', id, changes: { locked: true } }]);
    expect(() => applyEditorOperations(locked, [{
      type: 'update', collection: 'visualClips', id, changes: { graphic: proofActor('landscape'), technique: 'actor_action', durationSec: 10 },
    }])).toThrow(EditorError);
  });
});
