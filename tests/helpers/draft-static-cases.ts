/** DRAFT-STATIC01: actual pure parser/reconciliation/editor mapping; synthetic data, no I/O or renderer. */
import assert from 'node:assert/strict';
import { FactoryError, type FactoryDraftScene } from '../../packages/core/src/factory/contract.js';
import { buildKineticGraphic, buildNumericGraphic, buildProcessGraphic, defaultGraphicActions } from '../../packages/core/src/editor/graphic-builders.js';
import { deriveGraphic, buildTreatments } from '../../packages/core/src/factory/planning.js';
import { parseDraftPatch, reconcileSelection, canonicalScene } from '../../packages/core/src/factory/validation.js';
import { buildFactoryEditorDocument, timedGraphic } from '../../packages/core/src/factory/editor-mapping.js';

export function draftScene(): FactoryDraftScene {
  return {
    id: 's1', narration: 'Check the drawing.', speakerId: null, visualIntent: 'Synthetic scene', assetId: null,
    startSec: null, endSec: null, locked: false, sourceUnitId: 's1', beat: 'explanation', language: 'en',
    assetOrigin: null, timingSource: 'unknown', visualDecision: { framing: 'full', motion: 'none', unexecuted: [], pacing: 'measured' },
    technique: 'still_image', graphic: null,
  };
}
export function reconcileDraft(base: FactoryDraftScene, edit: Record<string, unknown> = {}, options: Partial<Parameters<typeof reconcileSelection>[0]> = {}) {
  const patch = parseDraftPatch({ expectedRevision: 0, selectedTreatmentId: 't1', scenes: [{ ...base, ...edit }], speakers: [] });
  return reconcileSelection({
    currentTreatmentId: 't1', currentScenes: [base], proposals: { t1: [base] }, sourceNarration: new Map([[base.sourceUnitId, base.narration]]),
    assetAllowed: () => true, speakerAllowed: () => true, orderLocked: false, incomingTreatmentId: patch.selectedTreatmentId,
    incomingScenes: patch.scenes, format: 'landscape', contentProfile: 'educational', visualLanguage: 'motion_explainer', ...options,
  })[0];
}
export function mapDraft(row: FactoryDraftScene, format: 'landscape' | 'portrait' = 'landscape') {
  return buildFactoryEditorDocument({
    projectId: 'draft-static-pure', contentProfile: 'educational', channelBrandId: null, format,
    visualLanguage: row.graphic?.kind === 'actor_action' ? 'animated_story_2d' : 'motion_explainer', fullAudio: null, captionsEnabled: false,
    scenes: [{ ...row, visual: null, audio: null, startSec: 0, durationSec: 4 }],
  });
}
export function plannedScene(): FactoryDraftScene {
  return { ...draftScene(), technique: 'kinetic_text', graphic: deriveGraphic('kinetic_text', 'Check the drawing.', 'educational', 'landscape').graphic };
}
export function authoredStatic(): FactoryDraftScene {
  const graphic = buildKineticGraphic({ title: '', items: ['Check', 'Save'] }, 'landscape', 3);
  graphic.actions = [];
  return reconcileDraft(draftScene(), { technique: 'kinetic_text', graphic });
}
export const draftStaticCases: Array<{ name: string; run: () => void; beforeFix?: boolean }> = [
  { name: 'DRAFT-STATIC01: explicit static draft actions survive reconciliation/reopen/Apply mapping', beforeFix: true, run: () => {
    const saved = authoredStatic(); assert.deepEqual(saved.graphic!.actions, []);
    const reopened = canonicalScene(JSON.parse(JSON.stringify(saved)));
    const doc = mapDraft(reopened);
    assert.deepEqual(doc.visualClips[0].graphic!.actions, []);
    assert.deepEqual(doc.visualClips[0].graphic, saved.graphic);
    assert.equal(doc.durationSec, 4); assert.deepEqual(doc.audioClips, []); assert.deepEqual(doc.captions, []);
  } },
  { name: 'DRAFT-STATIC01: an untouched legacy/planner empty graphic still gets existing default motion', beforeFix: true, run: () => {
    const base = plannedScene(); const original = JSON.stringify(base);
    assert.deepEqual(base.graphic!.actions, []);
    const saved = reconcileDraft(base); const doc = mapDraft(saved);
    assert.deepEqual(doc.visualClips[0].graphic!.actions, defaultGraphicActions(base.graphic!, 4, 'measured'));
    assert(doc.visualClips[0].graphic!.actions.length > 0); assert.equal(JSON.stringify(base), original);
  } },
];

const refuses = (code: string) => (error: unknown) => error instanceof FactoryError && error.code === code;
draftStaticCases.push(
  { name: 'DRAFT-STATIC01: explicit same-bytes action edit gets server provenance, not a persisted client command', run: () => {
    const base = plannedScene(); const before = JSON.stringify(base);
    const saved = reconcileDraft(base, { graphicActionsEdit: true });
    assert.equal(saved.graphicActionsAuthored, true); assert.deepEqual(saved.graphic, base.graphic);
    assert(!('graphicActionsEdit' in saved));
    assert.deepEqual(mapDraft(saved).visualClips[0].graphic!.actions, []);
    assert.equal(JSON.stringify(base), before);
  } },
  { name: 'DRAFT-STATIC01: clearing previously nonempty actions works for existing clients without the new command', run: () => {
    const base = { ...plannedScene(), graphic: buildKineticGraphic({ title: '', items: ['Check', 'Save'] }, 'landscape', 3) };
    const saved = reconcileDraft(base, { graphic: { ...base.graphic, actions: [] } });
    assert.equal(saved.graphicActionsAuthored, true); assert.deepEqual(mapDraft(saved).visualClips[0].graphic!.actions, []);
    assert(base.graphic.actions.length > 0);
  } },
  { name: 'DRAFT-STATIC01: authored static survives serialization, canonicalization, omitted fields and unrelated saves', run: () => {
    const original = authoredStatic(); const reopened = canonicalScene(JSON.parse(JSON.stringify(original)));
    const saved = reconcileDraft(reopened, { graphic: undefined, graphicActionsAuthored: undefined, visualIntent: 'Explicitly edited intent' });
    assert.equal(saved.graphicActionsAuthored, true); assert.deepEqual(saved.graphic, original.graphic);
    assert.deepEqual(mapDraft(saved).visualClips[0].graphic, original.graphic);
    const clip = mapDraft(saved).visualClips[0];
    assert(!('graphicActionsAuthored' in clip)); assert(!('graphicActionsAuthored' in clip.graphic!));
  } },
  { name: 'DRAFT-STATIC01: nonempty authored and legacy actions retain exact IDs, values and fractional times', run: () => {
    const graphic = buildKineticGraphic({ title: 'Exact', items: ['Check', 'Save'] }, 'landscape', 3);
    graphic.actions[0] = { ...graphic.actions[0], id: 'owner-action', from: 0.125, to: 0.875, startSec: 0.123456, endSec: 1.876543 };
    const before = JSON.stringify(graphic);
    const saved = reconcileDraft(draftScene(), { technique: 'kinetic_text', graphic });
    assert.equal(JSON.stringify(mapDraft(saved).visualClips[0].graphic), before);
    assert.equal(JSON.stringify(mapDraft({ ...saved, graphicActionsAuthored: undefined }).visualClips[0].graphic), before);
    assert.equal(JSON.stringify(graphic), before);
  } },
  { name: 'DRAFT-STATIC01: changing only text on an untimed proposal does not silently disable default actions', run: () => {
    const base = plannedScene(); const graphic = structuredClone(base.graphic!); graphic.objects[0].text = '  Exact changed wording  ';
    const saved = reconcileDraft(base, { graphic });
    assert.equal(saved.graphicActionsAuthored, undefined);
    const applied = mapDraft(saved).visualClips[0].graphic!;
    assert.deepEqual(applied.objects, graphic.objects); assert.deepEqual(applied.actions, defaultGraphicActions(graphic, 4, 'measured'));
  } },
  { name: 'DRAFT-STATIC01: client-forged server provenance cannot freeze a planner or erase authored static', run: () => {
    const planner = plannedScene(); const owner = authoredStatic(); const before = JSON.stringify([planner, owner]);
    for (const flag of [true, false, 'true', null, {}]) assert.throws(() => reconcileDraft(planner, { graphicActionsAuthored: flag }), refuses('FACTORY_VALIDATION'));
    for (const flag of [false, null, 'true']) assert.throws(() => reconcileDraft(owner, { graphicActionsAuthored: flag }), refuses('FACTORY_VALIDATION'));
    assert.equal(reconcileDraft(owner).graphicActionsAuthored, true);
    assert.equal(JSON.stringify([planner, owner]), before);
  } },
  { name: 'DRAFT-STATIC01: action intent must be explicit true with a valid supplied graphic', run: () => {
    const base = plannedScene();
    for (const graphicActionsEdit of [false, 'true', null]) assert.throws(() => reconcileDraft(base, { graphicActionsEdit }), refuses('FACTORY_VALIDATION'));
    for (const graphic of [null, undefined, { kind: 'kinetic_text' }]) assert.throws(() => reconcileDraft(base, { graphicActionsEdit: true, graphic }), refuses('FACTORY_VALIDATION'));
  } },
  { name: 'DRAFT-STATIC01: provenance participates in locked-row equality, but an unchanged legacy echo still succeeds', run: () => {
    const locked = { ...plannedScene(), locked: true }; const before = JSON.stringify(locked);
    assert.throws(() => reconcileDraft(locked, { graphicActionsEdit: true }), refuses('FACTORY_SCENE_LOCKED'));
    assert.equal(reconcileDraft(locked).graphicActionsAuthored, undefined);
    const authoredLocked = { ...authoredStatic(), locked: true };
    assert.deepEqual(reconcileDraft(authoredLocked), canonicalScene(authoredLocked));
    assert.equal(JSON.stringify(locked), before);
  } },
  { name: 'DRAFT-STATIC01: removing a graphic clears its provenance instead of leaving a stale static flag on media', run: () => {
    const cleared = reconcileDraft(authoredStatic(), { graphic: null, technique: 'still_image', assetId: 'synthetic-image' });
    assert.equal(cleared.graphicActionsAuthored, undefined); assert(cleared.graphic == null);
    assert.equal(canonicalScene({ ...cleared, graphicActionsAuthored: true }).graphicActionsAuthored, undefined);
  } },
  { name: 'DRAFT-STATIC01: selecting a fresh treatment uses its own default origin, not the previous selection static flag', run: () => {
    const owner = authoredStatic(); const fresh = plannedScene();
    const result = reconcileDraft(owner, { ...fresh, graphicActionsAuthored: undefined }, {
      proposals: { t1: [owner], t2: [fresh] }, incomingTreatmentId: 't2',
    });
    assert.equal(result.graphicActionsAuthored, undefined); assert(mapDraft(result).visualClips[0].graphic!.actions.length > 0);
  } },
  { name: 'DRAFT-STATIC01: reset reconciliation cannot take provenance from an old client echo', run: () => {
    const owner = authoredStatic(); const fresh = plannedScene();
    const result = reconcileDraft(owner, { graphic: undefined, graphicActionsEdit: undefined, graphicActionsAuthored: true }, {
      currentScenes: [], proposals: { t1: [fresh] }, skipServerOwnedEcho: true,
    });
    assert.equal(result.graphicActionsAuthored, undefined); assert(mapDraft(result).visualClips[0].graphic!.actions.length > 0);
  } },
  { name: 'DRAFT-STATIC01: fresh treatment rebuilds do not inherit authored provenance from source narration', run: () => {
    const owner = authoredStatic();
    const treatments = buildTreatments('educational', [{
      id: owner.sourceUnitId, narration: owner.narration, language: owner.language, speakerHint: null,
      assetId: null, startSec: null, endSec: null, locked: false,
    }], { visualLanguage: 'motion_explainer', format: 'landscape' });
    assert(treatments.some((t) => t.scenes.some((s) => s.graphic)));
    for (const t of treatments) for (const s of t.scenes) assert.equal(s.graphicActionsAuthored, undefined);
    assert.equal(owner.graphicActionsAuthored, true);
  } },
  { name: 'DRAFT-STATIC01: timedGraphic remains backward-compatible and requires literal provenance for static data', run: () => {
    const g = plannedScene().graphic!;
    for (const pacing of ['measured', 'brisk', 'held'] as const) {
      assert.deepEqual(timedGraphic(g, 4, pacing).actions, defaultGraphicActions(g, 4, pacing));
      assert.equal(timedGraphic(g, 4, pacing, true), g);
    }
    assert.deepEqual(g.actions, []);
  } },
);
for (const format of ['landscape', 'portrait'] as const) draftStaticCases.push({
  name: `DRAFT-STATIC01: ${format} static graphics in all existing families preserve exact canonical data`, run: () => {
    const kinetic = buildKineticGraphic({ title: '  Exact  ', items: ['راجع', 'Save'] }, format, 3);
    const graphics = [kinetic,
      buildNumericGraphic({ title: '', scaleMax: '20', rows: [{ label: 'A', value: '12.3456', unit: 'h' }, { label: 'B', value: '0.0001', unit: 'h' }] }, format, 3),
      buildProcessGraphic({ title: '', items: ['راجع', 'احفظ'] }, format, 3),
      { ...kinetic, kind: 'actor_action' as const, objects: [{ id: 'person', type: 'figure' as const, x: 0.5, y: 0.5, scale: 1, armAngle: 10, opacity: 0.8 }] },
    ];
    for (const graphic of graphics) {
      graphic.actions = []; const original = JSON.stringify(graphic);
      const saved = reconcileDraft(draftScene(), { technique: graphic.kind, graphic }, { format, visualLanguage: graphic.kind === 'actor_action' ? 'animated_story_2d' : 'motion_explainer' });
      assert.equal(JSON.stringify(mapDraft(saved, format).visualClips[0].graphic), original);
      assert.equal(JSON.stringify(graphic), original);
    }
  },
});

draftStaticCases.push(
  { name: 'DRAFT-STATIC01: an action intent cannot bypass immutable narration/source-time checks', run: () => {
    const base = plannedScene(); const original = JSON.stringify(base);
    assert.throws(() => reconcileDraft(base, { graphicActionsEdit: true, narration: 'Different source words.' }), refuses('FACTORY_VALIDATION'));
    assert.throws(() => reconcileDraft(base, { graphicActionsEdit: true, startSec: 0, endSec: 3 }), refuses('FACTORY_VALIDATION'));
    assert.equal(JSON.stringify(base), original);
  } },
  { name: 'DRAFT-STATIC01: authored provenance never excuses out-of-clip nonempty actions', run: () => {
    const base = { ...plannedScene(), startSec: 0, endSec: 3 };
    const graphic = buildKineticGraphic({ title: '', items: ['Check'] }, 'landscape', 3);
    graphic.actions[0].endSec = 4;
    assert.throws(() => reconcileDraft(base, { graphic, graphicActionsEdit: true }), refuses('FACTORY_VALIDATION'));
    assert.deepEqual(base.graphic!.actions, []);
  } },
);
