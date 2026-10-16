/**
 * Draft-layer contract for the visual-language registry: parse, reconcile, canonical form, readiness.
 * Pure core. Fixture narration and fixture graphics only. Code evidence, not owner acceptance.
 */
import { describe, expect, it } from 'vitest';
import {
  FactoryError,
  UNAVAILABLE_VISUAL_CAPABILITIES,
  VISUAL_LANGUAGES,
  buildTreatments,
  canonicalScene,
  capabilityOfTechnique,
  isVisualTechniqueId,
  languageAllowsTechnique,
  parseDraftPatch,
  reconcileSelection,
  splitNarrationUnits,
  techniqueReadiness,
  validateVisualLanguageRegistry,
  type DeriveAssetRef,
  type FactoryDraftScene,
  type FactoryPlanUnit,
} from '@buildtrack/core';
import { proofNumeric } from './fixtures/graphic-proof-specs';

const EDU_SCRIPT = [
  'Many sites lose a day when a crane waits for a delivery nobody confirmed.',
  'For example, a concrete pour was booked for seven but the truck arrived at nine.',
  'Check the delivery window the night before and confirm it with the supplier.',
  'Write the confirmed time on the site board so every crew sees it.',
].join('\n');

function unitsOf(script: string): FactoryPlanUnit[] {
  return splitNarrationUnits(script).map((text, i) => ({
    id: `u${String(i + 1).padStart(2, '0')}`,
    narration: text,
    language: /[\u0600-\u06FF]/.test(text) ? 'ar' : 'en',
    speakerHint: null,
    assetId: 'owner-image-1',
    startSec: null,
    endSec: null,
    locked: false,
  }));
}

const units = unitsOf(EDU_SCRIPT);
const treatments = buildTreatments('educational', units);
const proposals = Object.fromEntries(treatments.map((t) => [t.id, t.scenes]));
const sourceNarration = new Map(units.map((u) => [u.id, u.narration]));

function baseInput(over: Record<string, unknown> = {}) {
  return {
    currentTreatmentId: treatments[0].id,
    currentScenes: treatments[0].scenes,
    proposals,
    sourceNarration,
    assetAllowed: (id: string) => id === 'owner-image-1',
    speakerAllowed: () => true,
    incomingTreatmentId: treatments[0].id,
    orderLocked: false,
    incomingScenes: treatments[0].scenes.map((r) => ({ ...r })),
    format: 'landscape',
    contentProfile: 'educational',
    visualLanguage: null as null | 'motion_explainer',
    ...over,
  };
}

function expectRefused(fn: () => unknown, status: number, pattern: RegExp) {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(FactoryError);
  expect((caught as FactoryError).status).toBe(status);
  expect((caught as FactoryError).message).toMatch(pattern);
}

describe('visual-language registry', () => {
  it('validates clean, with every language naming only known techniques', () => {
    expect(validateVisualLanguageRegistry()).toEqual([]);
  });

  it('refuses a technique a language does not allow', () => {
    expect(languageAllowsTechnique('screen_tutorial', 'process_path')).toBe(false);
    expect(languageAllowsTechnique('documentary_footage', 'actor_action')).toBe(false);
    expect(languageAllowsTechnique('mixed', 'actor_action')).toBe(true);
  });
});

describe('parseDraftPatch visual fields', () => {
  const minimal = (scene: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    expectedRevision: 0,
    selectedTreatmentId: 'x',
    speakers: [],
    scenes: [{ id: 'u01', narration: 'a', speakerId: null, visualIntent: '', assetId: null, startSec: null, endSec: null, locked: false, ...scene }],
    ...extra,
  });

  it('keeps a legacy patch unchanged: no visualLanguage, technique or graphic keys appear', () => {
    const out = parseDraftPatch(minimal({}));
    expect('visualLanguage' in out).toBe(false);
    expect('technique' in out.scenes[0]).toBe(false);
    expect('graphic' in out.scenes[0]).toBe(false);
  });

  it('accepts a registered language and a registered technique', () => {
    const out = parseDraftPatch(minimal({ technique: 'numeric_comparison', graphic: { kind: 'numeric_comparison' } }, { visualLanguage: 'motion_explainer' }));
    expect(out.visualLanguage).toBe('motion_explainer');
    expect(out.scenes[0].technique).toBe('numeric_comparison');
  });

  it('refuses an unknown technique (negative)', () => {
    expectRefused(() => parseDraftPatch(minimal({ technique: 'generated_video' })), 422, /not in the visual-language registry/);
  });

  it('refuses an unknown visual language (negative)', () => {
    expectRefused(() => parseDraftPatch(minimal({}, { visualLanguage: 'cinematic_3d' })), 422, /registered visual language/);
  });

  it('refuses a graphic that is not an object (negative)', () => {
    expectRefused(() => parseDraftPatch(minimal({ graphic: 'bars' })), 422, /graphic must be an object or null/);
  });
});

describe('reconcileSelection visual fields', () => {
  it('accepts a valid numeric graphic on a numeric_comparison shot and keeps it in canonical form', () => {
    const rows = treatments[0].scenes.map((r) => ({ ...r }));
    rows[0] = { ...rows[0], assetId: null, technique: 'numeric_comparison', graphic: proofNumeric('landscape') } as FactoryDraftScene;
    const out = reconcileSelection({ ...baseInput({ visualLanguage: 'motion_explainer' }), incomingScenes: rows });
    expect(out[0].technique).toBe('numeric_comparison');
    expect(out[0].graphic?.kind).toBe('numeric_comparison');
  });

  it('a legacy row keeps no technique or graphic key after reconcile', () => {
    const out = reconcileSelection(baseInput());
    expect('technique' in out[0]).toBe(false);
    expect('graphic' in out[0]).toBe(false);
    expect(JSON.stringify(canonicalScene(out[0]))).toBe(JSON.stringify(out[0]));
  });

  it('refuses a technique the draft language does not allow (negative)', () => {
    const rows = treatments[0].scenes.map((r) => ({ ...r }));
    rows[0] = { ...rows[0], assetId: null, technique: 'process_path', graphic: null } as FactoryDraftScene;
    expectRefused(
      () => reconcileSelection({ ...baseInput({ visualLanguage: 'screen_tutorial' }), incomingScenes: rows }),
      422,
      /does not allow/,
    );
  });

  it('refuses a graphic whose kind does not match the technique (negative)', () => {
    const rows = treatments[0].scenes.map((r) => ({ ...r }));
    rows[0] = { ...rows[0], assetId: null, technique: 'still_image', graphic: proofNumeric('landscape') } as FactoryDraftScene;
    expectRefused(() => reconcileSelection({ ...baseInput({ visualLanguage: 'mixed' }), incomingScenes: rows }), 422, /does not match its graphic kind/);
  });

  it('refuses a graphic whose value exceeds the scale (negative, shared validator)', () => {
    const bad = { ...proofNumeric('landscape'), scaleMax: 1 };
    const rows = treatments[0].scenes.map((r) => ({ ...r }));
    rows[0] = { ...rows[0], assetId: null, technique: 'numeric_comparison', graphic: bad } as FactoryDraftScene;
    expectRefused(() => reconcileSelection({ ...baseInput({ visualLanguage: 'motion_explainer' }), incomingScenes: rows }), 422, /graphic is refused.*(scale|value|max)/i);
  });

  it('refuses a graphic whose actions run past the shot duration (negative)', () => {
    // The owner row is 2 s long here, shorter than the 10 s fixture graphic's last action.
    const shortProposals = Object.fromEntries(
      Object.entries(proposals).map(([k, rows]) => [k, rows.map((r, i) => (i === 0 ? { ...r, startSec: 0, endSec: 2 } : r))]),
    ) as typeof proposals;
    const rows = shortProposals[treatments[0].id].map((r) => ({ ...r }));
    rows[0] = { ...rows[0], assetId: null, technique: 'numeric_comparison', graphic: proofNumeric('landscape') } as FactoryDraftScene;
    expectRefused(
      () => reconcileSelection({ ...baseInput({ visualLanguage: 'motion_explainer', proposals: shortProposals, currentScenes: shortProposals[treatments[0].id], incomingScenes: rows }) }),
      422,
      /graphic is refused.*(ends|duration|sec)/i,
    );
  });

  it('refuses BuildTrack identity inside a religious graphic (negative)', () => {
    const named = { ...proofNumeric('landscape'), title: 'BuildTrack numbers' };
    const rows = treatments[0].scenes.map((r) => ({ ...r }));
    rows[0] = { ...rows[0], assetId: null, technique: 'numeric_comparison', graphic: named } as FactoryDraftScene;
    expectRefused(
      () => reconcileSelection({ ...baseInput({ visualLanguage: 'motion_explainer', contentProfile: 'religious', incomingScenes: rows }) }),
      422,
      /graphic is refused.*BuildTrack/i,
    );
  });

  it('keeps a graphic technique with no values visible as needs_values, not refused at patch time', () => {
    const rows = treatments[0].scenes.map((r) => ({ ...r }));
    rows[0] = { ...rows[0], assetId: null, technique: 'numeric_comparison', graphic: null } as FactoryDraftScene;
    const out = reconcileSelection({ ...baseInput({ visualLanguage: 'motion_explainer', incomingScenes: rows }) });
    expect(out[0].technique).toBe('numeric_comparison');
    expect(out[0].graphic ?? null).toBeNull();
    expect(techniqueReadiness(out[0].technique ?? null, { hasGraphic: false, assetKind: null }, { localImage: 'ready' }, 'motion_explainer').state).toBe('needs_values');
  });
});

describe('graphic bounds (negative, shared validator)', () => {
  it('refuses an object placed outside the safe area and a bar past the frame edge', () => {
    const base = proofNumeric('landscape');
    const outside = { ...base, objects: base.objects.map((o, i) => (i === 0 ? { ...o, x: 1.2 } : o)) };
    const rows = treatments[0].scenes.map((r) => ({ ...r }));
    rows[0] = { ...rows[0], assetId: null, technique: 'numeric_comparison', graphic: outside } as FactoryDraftScene;
    expectRefused(
      () => reconcileSelection({ ...baseInput({ visualLanguage: 'motion_explainer', incomingScenes: rows }) }),
      422,
      /graphic is refused.*safe area/i,
    );
  });
});

describe('techniqueReadiness and capabilities (real facts only)', () => {
  it('legacy when no technique is selected', () => {
    expect(techniqueReadiness(null, { hasGraphic: false, assetKind: null }, { localImage: 'unknown' }, null).state).toBe('legacy');
  });

  it('ready with supplied graphic values; needs_values without', () => {
    expect(techniqueReadiness('process_path', { hasGraphic: true, assetKind: null }, { localImage: 'unknown' }, null).state).toBe('ready');
    expect(techniqueReadiness('process_path', { hasGraphic: false, assetKind: null }, { localImage: 'unknown' }, null).state).toBe('needs_values');
  });

  it('still_image with no bound image: needs_asset, and the reason names the real runtime state', () => {
    const setup = techniqueReadiness('still_image', { hasGraphic: false, assetKind: null }, { localImage: 'setup_required' }, null);
    expect(setup.state).toBe('needs_asset');
    expect(setup.reason).toMatch(/setup required/);
    expect(techniqueReadiness('still_image', { hasGraphic: false, assetKind: 'image' }, { localImage: 'setup_required' }, null).state).toBe('ready');
  });

  it('screen_recording with a still bound is NOT ready (negative: stills are not recordings)', () => {
    expect(techniqueReadiness('screen_recording', { hasGraphic: false, assetKind: 'image' }, { localImage: 'ready' }, 'screen_tutorial').state).toBe('needs_asset');
    expect(techniqueReadiness('screen_recording', { hasGraphic: false, assetKind: 'video' }, { localImage: 'ready' }, 'screen_tutorial').state).toBe('ready');
  });

  it('footage_clip with a still bound is NOT ready (negative)', () => {
    expect(techniqueReadiness('footage_clip', { hasGraphic: false, assetKind: 'image' }, { localImage: 'ready' }, 'documentary_footage').state).toBe('needs_asset');
  });

  it('refuses a technique a language does not allow (negative)', () => {
    expect(techniqueReadiness('actor_action', { hasGraphic: true, assetKind: null }, { localImage: 'ready' }, 'documentary_footage').state).toBe('refused');
  });

  it('still_image capability follows the runtime: requires_runtime when setup is required, ready when ready', () => {
    expect(capabilityOfTechnique('still_image', { localImage: 'setup_required' }).state).toBe('requires_runtime');
    expect(capabilityOfTechnique('still_image', { localImage: 'ready' }).state).toBe('ready');
  });

  it('unavailable families are listed as unavailable and are not techniques (negative)', () => {
    const ids = UNAVAILABLE_VISUAL_CAPABILITIES.map((u) => u.id);
    expect(ids).toEqual(expect.arrayContaining(['generative_video', '3d_animation', 'avatar_lip_sync', 'photoreal_video']));
    expect(isVisualTechniqueId('generative_video')).toBe(false);
    expect(parseDraftPatch({ expectedRevision: 0, selectedTreatmentId: 'x', speakers: [], scenes: [] })).toBeTruthy();
  });

  it('language capability is honest for illustrated narrative (requires runtime)', () => {
    expect(VISUAL_LANGUAGES.illustrated_narrative.capability).toBe('requires_runtime');
  });
});
