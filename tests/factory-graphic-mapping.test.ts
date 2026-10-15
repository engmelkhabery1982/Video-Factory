/**
 * Draft → editor document mapping for procedural-graphic scenes. Pure core, fixture data only.
 * Code evidence, not render or owner acceptance.
 */
import { describe, expect, it } from 'vitest';
import {
  FactoryError,
  assertValidEditorDocument,
  buildFactoryEditorDocument,
  validateEditorDocument,
  type DeriveAssetRef,
  type FactoryEditorSceneInput,
} from '@buildtrack/core';
import { proofNumeric } from './fixtures/graphic-proof-specs';

const HOLD = { framing: 'full' as const, motion: 'none' as const, unexecuted: [] as string[] };
const image: DeriveAssetRef = {
  id: 'owner-image-1', kind: 'image', name: 'Owner image', mediaUrl: '/media/asset/owner-image-1',
  durationSec: null, source: 'Owner fixture', license: 'Fixture', sha256: null,
};

function graphicScene(over: Partial<FactoryEditorSceneInput> = {}): FactoryEditorSceneInput {
  return {
    id: 'u01', narration: 'Booked seven, arrived nine.', language: 'en', speakerId: null, locked: false,
    visual: null, technique: 'numeric_comparison', graphic: proofNumeric('landscape'),
    visualDecision: HOLD, startSec: 0, durationSec: 10, audio: null, ...over,
  };
}

function mediaScene(over: Partial<FactoryEditorSceneInput> = {}): FactoryEditorSceneInput {
  return {
    id: 'u02', narration: 'Check the window.', language: 'en', speakerId: null, locked: false,
    visual: image, visualDecision: HOLD, startSec: 10, durationSec: 3, audio: null, ...over,
  };
}

const base = { projectId: 'Factory_graphic_test', contentProfile: 'educational' as const, channelBrandId: null, format: 'landscape' as const, fullAudio: null };

describe('buildFactoryEditorDocument with procedural graphic scenes', () => {
  it('maps a graphic scene to a graphic clip with no source asset, beside a media clip, and records the language', () => {
    const doc = buildFactoryEditorDocument({ ...base, scenes: [graphicScene(), mediaScene()], visualLanguage: 'motion_explainer' });
    expect(doc.visualLanguage).toBe('motion_explainer');
    const [g, m] = doc.visualClips;
    expect(g.sourceAssetId).toBeNull();
    expect(g.technique).toBe('numeric_comparison');
    expect(g.graphic?.kind).toBe('numeric_comparison');
    expect(m.sourceAssetId).toBe('owner-image-1');
    expect(m.graphic).toBeUndefined();
    expect(() => assertValidEditorDocument(doc)).not.toThrow();
  });

  it('keeps a legacy build (no language, media only) unchanged: no language key, no technique on clips', () => {
    const doc = buildFactoryEditorDocument({ ...base, scenes: [mediaScene({ startSec: 0 })] });
    expect('visualLanguage' in doc && doc.visualLanguage !== undefined).toBe(false);
    expect('technique' in doc.visualClips[0] && doc.visualClips[0].technique !== undefined).toBe(false);
    expect(() => assertValidEditorDocument(doc)).not.toThrow();
  });

  it('refuses a scene with neither media nor a graphic (negative)', () => {
    expect(() => buildFactoryEditorDocument({ ...base, scenes: [graphicScene({ graphic: null, technique: null, visual: null })] }))
      .toThrow(FactoryError);
  });

  it('refuses an unregistered technique (negative)', () => {
    expect(() => buildFactoryEditorDocument({ ...base, scenes: [mediaScene({ technique: 'generated_video' as never })] }))
      .toThrow(/not in the visual-language registry/);
  });

  it('refuses a graphic value outside its scale at build time (negative, same validator as save)', () => {
    const bad = { ...proofNumeric('landscape'), scaleMax: 1 };
    expect(() => buildFactoryEditorDocument({ ...base, scenes: [graphicScene({ graphic: bad })] }))
      .toThrow(/booked value 7 is above scaleMax 1/);
  });

  it('refuses a graphic whose actions run past its clip at build time (negative)', () => {
    expect(() => buildFactoryEditorDocument({ ...base, scenes: [graphicScene({ durationSec: 2 })] }))
      .toThrow(/ends at 2\.5s, after the clip \(2s\)/);
  });

  it('the saved document validator returns no problems for the valid mixed build', () => {
    const doc = buildFactoryEditorDocument({ ...base, scenes: [graphicScene(), mediaScene()], visualLanguage: 'motion_explainer' });
    expect(validateEditorDocument(doc)).toEqual([]);
  });
});
