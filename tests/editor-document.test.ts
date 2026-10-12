/**
 * Milestone 1 editor document — pure core rules.
 * Fixture only. These do not prove anything about the owner's recording.
 */
import { describe, expect, it } from 'vitest';
import {
  EditorError,
  applyEditorOperations,
  deriveEditorDocument,
  editorDocumentToRenderPlan,
  validateEditorDocument,
  type DeriveAssetRef,
  type EditorDocument,
  type Project,
} from '@buildtrack/core';

const AR_CAPTION = 'تَنْظُرُ إِلَى مَا فَقَدْتَ';
const AR_CAPTION_2 = 'وَتَنْسَى مَا أُعْطِيتَ';

function fixtureProject(): Project {
  const scene = (id: string, index: number, start: number, duration: number, assetIds: string[]) => ({
    id, index, role: 'body', section: '', variant: 'key_statement', background: 'full_typography',
    transitionIn: 'direct_cut', textPosition: 'lower_third', accent: '#E4C98A', duration, startTime: start,
    narration: id, captionIds: [`cap_${id}`], assetIds, locked: false, userEdited: false,
    content: { headline: '', items: [], presentation: 'owner_picture', mediaKind: 'none' },
    reason: { detected: 'x', evidence: '', notUsedRecently: [], alternatives: [] },
  });
  return {
    schemaVersion: 2,
    meta: {
      input: { videoId: 'Editor_Fixture', outputLanguage: 'ar', brandPreset: 'unbound-religious', contentProfile: 'religious' },
      brand: {}, createdAt: '', updatedAt: '', status: 'draft',
    },
    storyboard: {
      videoId: 'Editor_Fixture', createdAt: '', brand: {},
      long: {
        scenes: [
          scene('s1', 0, 0, 4.5, ['img1']),
          scene('s2', 1, 4.5, 6.022, ['vid1']),
          scene('s3', 2, 10.522, 7.5, []),
        ],
        totalDuration: 18.022, endScreenReserveSeconds: 8,
      },
      shorts: [], segments: [], warnings: [], similarity: null,
      captions: [
        { id: 'c1', start: 0, end: 4.5, text: AR_CAPTION, sceneId: 's1', terms: [], userEdited: false },
        { id: 'c2', start: 4.5, end: 10.522, text: AR_CAPTION_2, sceneId: 's2', terms: [], userEdited: false },
      ],
    } as unknown as Project['storyboard'],
    artifacts: [], qc: [],
  } as unknown as Project;
}

const ASSETS: DeriveAssetRef[] = [
  { id: 'img1', kind: 'image', name: 'Owner picture', mediaUrl: '/media/asset/img1', durationSec: null, source: 'owner', license: 'owner', mimeType: 'image/png' },
  { id: 'vid1', kind: 'video', name: 'Owner footage', mediaUrl: '/media/asset/vid1', durationSec: 60, source: 'owner', license: 'owner', mimeType: 'video/mp4' },
  { id: 'nar1', kind: 'audio', name: 'Approved narration', mediaUrl: '/media/asset/nar1', durationSec: 22.5, source: 'owner', license: 'owner', mimeType: 'audio/wav' },
];

function derived(): EditorDocument {
  return deriveEditorDocument({
    project: fixtureProject(),
    targetId: 'long',
    assets: ASSETS,
    narration: { assetId: 'nar1', durationSec: 22.5, sha256: 'a'.repeat(64), approved: true },
  });
}

describe('derivation from a legacy project', () => {
  it('builds a contiguous visual timeline and never mutates the source project', () => {
    const project = fixtureProject();
    const before = JSON.stringify(project);
    const doc = deriveEditorDocument({ project, targetId: 'long', assets: ASSETS });
    expect(JSON.stringify(project)).toBe(before);
    expect(doc.visualClips.map((c) => c.startSec)).toEqual([0, 4.5, 10.522]);
    expect(doc.durationSec).toBeCloseTo(18.022, 6);
    expect(validateEditorDocument(doc)).toEqual([]);
    expect(doc.visualClips[1].sourceInSec).toBe(0);
    expect(doc.visualClips[1].sourceOutSec).toBeCloseTo(6.022, 6);
    expect(doc.visualClips[2].sourceAssetId).toBeNull();
  });

  it('keeps Arabic caption text, shaping and diacritics byte-for-byte', () => {
    const doc = derived();
    expect(doc.captions[0].text).toBe(AR_CAPTION);
    expect(doc.captions[0].direction).toBe('rtl');
    expect(doc.captions[1].text).toBe(AR_CAPTION_2);
  });

  it('refuses a video scene that needs more footage than the asset has', () => {
    const short = ASSETS.map((a) => (a.id === 'vid1' ? { ...a, durationSec: 3 } : a));
    expect(() => deriveEditorDocument({ project: fixtureProject(), targetId: 'long', assets: short })).toThrow(EditorError);
  });

  it('refuses a target with no timeline instead of inventing one', () => {
    expect(() => deriveEditorDocument({ project: fixtureProject(), targetId: 'short_1', assets: ASSETS })).toThrow(/no scenes/);
  });
});

describe('trim', () => {
  it('moves the source in/out and the duration together, leaving narration and captions alone', () => {
    const doc = derived();
    const next = applyEditorOperations(doc, [
      { type: 'update', collection: 'visualClips', id: 'vc_s2', changes: { sourceInSec: 2, sourceOutSec: 6.022 } },
    ]);
    const clip = next.visualClips[1];
    expect(clip.durationSec).toBeCloseTo(4.022, 6);
    expect(clip.sourceInSec).toBe(2);
    expect(next.visualClips[2].startSec).toBeCloseTo(8.522, 6);
    expect(next.captions).toEqual(doc.captions);
    expect(next.audioClips).toEqual(doc.audioClips);
  });

  it('trims the end when only durationSec changes', () => {
    const next = applyEditorOperations(derived(), [
      { type: 'update', collection: 'visualClips', id: 'vc_s2', changes: { durationSec: 3 } },
    ]);
    expect(next.visualClips[1].sourceOutSec).toBeCloseTo(3, 6);
    expect(next.visualClips[1].sourceInSec).toBe(0);
  });

  it('rejects a trim where durationSec disagrees with the source range', () => {
    expect(() => applyEditorOperations(derived(), [
      { type: 'update', collection: 'visualClips', id: 'vc_s2', changes: { sourceInSec: 1, sourceOutSec: 4, durationSec: 5 } },
    ])).toThrow(/durationSec must equal/);
  });
});

describe('split keeps source position and total duration', () => {
  it('splits a video clip and continues its source after the cut', () => {
    const doc = derived();
    const next = applyEditorOperations(doc, [{ type: 'split', collection: 'visualClips', id: 'vc_s2', atSec: 6 }]);
    const [a, b] = [next.visualClips[1], next.visualClips[2]];
    expect(a.startSec).toBe(4.5);
    expect(a.durationSec).toBeCloseTo(1.5, 6);
    expect(a.sourceInSec).toBe(0);
    expect(a.sourceOutSec).toBeCloseTo(1.5, 6);
    expect(b.startSec).toBe(6);
    expect(b.sourceInSec).toBeCloseTo(1.5, 6);
    expect(b.sourceOutSec).toBeCloseTo(6.022, 6);
    expect(next.durationSec).toBeCloseTo(doc.durationSec, 6);
    expect(next.visualClips[3].startSec).toBeCloseTo(10.522, 6);
  });

  it('refuses a cut at the clip edge or outside the clip', () => {
    expect(() => applyEditorOperations(derived(), [{ type: 'split', collection: 'visualClips', id: 'vc_s2', atSec: 4.5 }])).toThrow(/strictly inside/);
    expect(() => applyEditorOperations(derived(), [{ type: 'split', collection: 'visualClips', id: 'vc_s2', atSec: 12 }])).toThrow(/strictly inside/);
  });
});

describe('reorder', () => {
  it('recalculates visual starts only; captions and narration keep their times and approval', () => {
    const doc = derived();
    const next = applyEditorOperations(doc, [{ type: 'reorder', collection: 'visualClips', ids: ['vc_s3', 'vc_s1', 'vc_s2'] }]);
    expect(next.visualClips.map((c) => c.id)).toEqual(['vc_s3', 'vc_s1', 'vc_s2']);
    // s3 (7.5s) first, then s1 (4.5s), then s2 (6.022s)
    expect(next.visualClips.map((c) => c.startSec)).toEqual([0, 7.5, 12]);
    expect(next.captions.map((c) => [c.startSec, c.endSec])).toEqual(doc.captions.map((c) => [c.startSec, c.endSec]));
    expect(next.audioClips[0].approved).toBe(true);
  });

  it('rejects a list that is not a permutation', () => {
    expect(() => applyEditorOperations(derived(), [{ type: 'reorder', collection: 'visualClips', ids: ['vc_s1', 'vc_s1', 'vc_s2'] }])).toThrow(/permutation/);
  });
});

describe('locks', () => {
  it('blocks mutation of a locked item and allows only an unlock', () => {
    const locked = applyEditorOperations(derived(), [{ type: 'update', collection: 'visualClips', id: 'vc_s1', changes: { locked: true } }]);
    expect(() => applyEditorOperations(locked, [{ type: 'update', collection: 'visualClips', id: 'vc_s1', changes: { durationSec: 2 } }]))
      .toThrow(expect.objectContaining({ code: 'EDITOR_LOCKED_ITEM', status: 423 }));
    expect(() => applyEditorOperations(locked, [{ type: 'remove', collection: 'visualClips', id: 'vc_s1' }])).toThrow(/locked/);
    expect(() => applyEditorOperations(locked, [{ type: 'split', collection: 'visualClips', id: 'vc_s1', atSec: 2 }])).toThrow(/locked/);
    expect(() => applyEditorOperations(locked, [{ type: 'reorder', collection: 'visualClips', ids: ['vc_s2', 'vc_s1', 'vc_s3'] }])).toThrow(/locked/);
    const unlocked = applyEditorOperations(locked, [{ type: 'update', collection: 'visualClips', id: 'vc_s1', changes: { locked: false } }]);
    expect(unlocked.visualClips[0].locked).toBe(false);
  });

  it('refuses an unlock that also changes anything else', () => {
    const locked = applyEditorOperations(derived(), [{ type: 'update', collection: 'visualClips', id: 'vc_s1', changes: { locked: true } }]);
    expect(() => applyEditorOperations(locked, [{ type: 'update', collection: 'visualClips', id: 'vc_s1', changes: { locked: false, durationSec: 2 } }]))
      .toThrow(/locked/);
  });
});

describe('audio approvals', () => {
  it('invalidates the approval when the narration source range changes', () => {
    const next = applyEditorOperations(derived(), [
      { type: 'update', collection: 'audioClips', id: 'ac_nar1', changes: { sourceOutSec: 20 } },
    ]);
    expect(next.audioClips[0].approved).toBe(false);
    expect(next.alignment.status).toBe('not_requested');
  });

  it('keeps narration approval through a visual-only edit', () => {
    const next = applyEditorOperations(derived(), [
      { type: 'update', collection: 'visualClips', id: 'vc_s1', changes: { motion: 'slow_push' } },
      { type: 'split', collection: 'visualClips', id: 'vc_s2', atSec: 6 },
    ]);
    expect(next.audioClips[0].approved).toBe(true);
  });
});

describe('highlights', () => {
  const withHighlight = (startSec: number, endSec: number) => applyEditorOperations(derived(), [{
    type: 'insert', collection: 'highlights',
    item: { id: 'h1', startSec, endSec, visualClipId: 'vc_s2', box: { x: 0.4, y: 0.3, width: 0.2, height: 0.1 }, label: 'Total', locked: false },
  }]);

  it('moves a highlight to the half of a split that contains it', () => {
    const next = applyEditorOperations(withHighlight(6.2, 6.8), [{ type: 'split', collection: 'visualClips', id: 'vc_s2', atSec: 6 }]);
    expect(next.highlights[0].visualClipId).toBe('vc_s2_s2');
  });

  it('refuses a split that cuts through a highlight', () => {
    expect(() => applyEditorOperations(withHighlight(5.5, 6.5), [{ type: 'split', collection: 'visualClips', id: 'vc_s2', atSec: 6 }]))
      .toThrow(/spans the cut/);
  });

  it('refuses a highlight outside its clip', () => {
    expect(() => applyEditorOperations(derived(), [{
      type: 'insert', collection: 'highlights',
      item: { id: 'h9', startSec: 1, endSec: 2, visualClipId: 'vc_s2', box: { x: 0, y: 0, width: 0.5, height: 0.5 }, label: null, locked: false },
    }])).toThrow(/outside its visual clip/);
  });
});

describe('render plan from the same document', () => {
  it('a clip that begins after composition time zero keeps its own source offset', () => {
    const doc = applyEditorOperations(derived(), [{ type: 'split', collection: 'visualClips', id: 'vc_s2', atSec: 6 }]);
    const plan = editorDocumentToRenderPlan(doc);
    const later = plan.scenes.find((s) => s.id === 'vc_s2_s2')!;
    expect(later.startTime).toBe(6);
    expect(later.content.sourceInSec).toBeCloseTo(1.5, 6);
    expect(later.content.mediaKind).toBe('video');
    expect(later.duration).toBeCloseTo(4.522, 6);
    expect(plan.captions.map((c) => c.text)).toEqual([AR_CAPTION, AR_CAPTION_2]);
    expect(plan.durationSec).toBeCloseTo(18.022, 6);
  });
});

describe('capability honesty', () => {
  it('refuses dissolve and fade instead of silently rendering a cut', () => {
    for (const transition of ['dissolve', 'fade']) {
      expect(() => applyEditorOperations(derived(), [
        { type: 'update', collection: 'visualClips', id: 'vc_s1', changes: { transition } },
      ])).toThrow(expect.objectContaining({ code: 'EDITOR_CAPABILITY_UNAVAILABLE', status: 422 }));
    }
  });

  it('refuses still-animation motion on footage', () => {
    expect(() => applyEditorOperations(derived(), [
      { type: 'update', collection: 'visualClips', id: 'vc_s2', changes: { motion: 'slow_push' } },
    ])).toThrow(/still images only/);
  });

  it('accepts still-animation motion on a still and maps it into the render plan', () => {
    const next = applyEditorOperations(derived(), [
      { type: 'update', collection: 'visualClips', id: 'vc_s1', changes: { motion: 'pan_left' } },
    ]);
    expect(next.visualClips[0].motion).toBe('pan_left');
    const plan = editorDocumentToRenderPlan(next);
    expect(plan.scenes[0].content.motion).toBe('pan_left');
  });
});

describe('transaction guards', () => {
  it('rejects unknown fields and identity changes', () => {
    expect(() => applyEditorOperations(derived(), [{ type: 'update', collection: 'captions', id: 'cap_c1', changes: { id: 'x' } }])).toThrow(/may not set "id"/);
    expect(() => applyEditorOperations(derived(), [{ type: 'update', collection: 'visualClips', id: 'vc_s1', changes: { startSec: 3 } }])).toThrow(/may not set "startSec"/);
    expect(() => applyEditorOperations(derived(), [{ type: 'setDocument', changes: { targetId: 'short_1' } }])).toThrow(/may not set/);
  });

  it('applies setDocument for profile and format only', () => {
    const next = applyEditorOperations(derived(), [{ type: 'setDocument', changes: { format: 'portrait', contentProfile: 'educational' } }]);
    expect(next.format).toBe('portrait');
    expect(next.contentProfile).toBe('educational');
  });

  it('never changes the input document on a refused operation', () => {
    const doc = derived();
    const before = JSON.stringify(doc);
    expect(() => applyEditorOperations(doc, [
      { type: 'update', collection: 'visualClips', id: 'vc_s1', changes: { durationSec: 2 } },
      { type: 'remove', collection: 'visualClips', id: 'vc_missing' },
    ])).toThrow(EditorError);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
