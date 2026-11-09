/**
 * Milestone 1 editor document — pure core rules.
 * Fixture only. These do not prove anything about the owner's recording.
 */
import { describe, expect, it } from 'vitest';
import { applyAlignmentRows, alignmentIdentityPayload, reconcileNarration, validateAlignmentRows, NARRATION_ASSET_ID, NARRATION_CLIP_ID } from '@buildtrack/core';
import {
  EditorError,
  applyEditorOperations,
  deriveEditorDocument,
  editorDocumentToRenderPlan,
  mergeLibraryAssets,
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

/** Derived without any narration, so narration tests start from an empty audio track. */
function plainDoc(): EditorDocument {
  return deriveEditorDocument({ project: fixtureProject(), targetId: 'long', assets: ASSETS });
}

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
  it('refuses dissolve (amendment A1 pending) instead of silently rendering a cut', () => {
    expect(() => applyEditorOperations(derived(), [
      { type: 'update', collection: 'visualClips', id: 'vc_s2', changes: { transition: 'dissolve' } },
    ])).toThrow(expect.objectContaining({ code: 'EDITOR_CAPABILITY_UNAVAILABLE', status: 422 }));
  });

  it('accepts fade and maps a clamped fade window onto the boundary scene', () => {
    const next = applyEditorOperations(derived(), [
      { type: 'update', collection: 'visualClips', id: 'vc_s2', changes: { transition: 'fade' } },
    ]);
    const plan = editorDocumentToRenderPlan(next);
    // s1 is 4.5s and s2 is 6.022s: the half window is min(0.5, 4.5/2, 6.022/2) = 0.5
    expect(plan.scenes[1].content.fadeSec).toBeCloseTo(0.5, 6);
    expect(plan.scenes[0].content.fadeSec ?? 0).toBe(0);
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

describe('narration binding', () => {
  const SHA_A = 'a'.repeat(64);
  const SHA_B = 'b'.repeat(64);
  const binding = (over: Partial<Parameters<typeof reconcileNarration>[1] & object> = {}) => ({
    importId: 'imp_1', name: 'Owner narration', mediaUrl: '/x/narration', source: 'external_narration_import',
    license: 'owner_recording (operator declaration)', durationSec: 22.5, sha256: SHA_A, approved: true, ...over,
  });

  it('adds the narration asset and a full-file audio clip with the approval', () => {
    const r = reconcileNarration(plainDoc(), binding());
    expect(r.changed).toBe(true);
    const clip = r.doc.audioClips.find((c) => c.id === NARRATION_CLIP_ID)!;
    expect(clip.sourceAssetId).toBe(NARRATION_ASSET_ID);
    expect([clip.startSec, clip.sourceInSec, clip.sourceOutSec, clip.approved]).toEqual([0, 0, 22.5, true]);
    expect(validateEditorDocument(r.doc)).toEqual([]);
  });

  it('is idempotent when nothing changed', () => {
    const once = reconcileNarration(plainDoc(), binding()).doc;
    const twice = reconcileNarration(once, binding());
    expect(twice.changed).toBe(false);
    expect(twice.doc).toBe(once);
  });

  it('keeps a trim through an approval-only change, and resets it for a new file', () => {
    const bound = reconcileNarration(plainDoc(), binding()).doc;
    const trimmed = applyEditorOperations(bound, [{ type: 'update', collection: 'audioClips', id: NARRATION_CLIP_ID, changes: { sourceInSec: 2 } }]);
    const revoked = reconcileNarration(trimmed, binding({ approved: false }));
    expect(revoked.doc.audioClips[0].sourceInSec).toBe(2);
    expect(revoked.doc.audioClips[0].approved).toBe(false);
    const replaced = reconcileNarration(trimmed, binding({ sha256: SHA_B, approved: false }));
    expect(replaced.doc.audioClips[0].sourceInSec).toBe(0);
    expect(replaced.doc.alignment.status).toBe('not_requested');
  });

  it('removes the narration when the project no longer has one', () => {
    const bound = reconcileNarration(plainDoc(), binding()).doc;
    const removed = reconcileNarration(bound, null);
    expect(removed.doc.audioClips).toEqual([]);
    expect(removed.doc.assets.some((a) => a.id === NARRATION_ASSET_ID)).toBe(false);
  });
});

/** Narration starting at timeline 2 s, reading the source from 1 s: source t maps to timeline t + 1. */
function offsetDoc(): EditorDocument {
  const bound = reconcileNarration(plainDoc(), {
    importId: 'imp_1', name: 'n', mediaUrl: '/n', source: 's', license: 'l', durationSec: 22.5, sha256: 'c'.repeat(64), approved: true,
  }).doc;
  return applyEditorOperations(bound, [
    { type: 'update', collection: 'audioClips', id: NARRATION_CLIP_ID, changes: { startSec: 2, sourceInSec: 1, sourceOutSec: 22.5 } },
  ]);
}

const ROW_META = { audioSha256: 'c'.repeat(64), proposalId: 'p1', sourceRevision: 0 };

describe('alignment rows (caption units)', () => {
  it('rejects unordered, overlapping, duplicate or out-of-file rows', () => {
    expect(() => validateAlignmentRows([{ sceneId: 's1', startSec: 2, endSec: 1 }], 22.5)).toThrow(/end after/);
    expect(() => validateAlignmentRows([{ sceneId: 's1', startSec: 0, endSec: 5 }, { sceneId: 's2', startSec: 4, endSec: 6 }], 22.5)).toThrow(/overlaps/);
    expect(() => validateAlignmentRows([{ sceneId: 's1', startSec: 0, endSec: 5 }, { sceneId: 's1', startSec: 6, endSec: 7 }], 22.5)).toThrow(/duplicate/);
    expect(() => validateAlignmentRows([{ sceneId: 's1', startSec: 0, endSec: 30 }], 22.5)).toThrow(/after the narration file/);
    expect(() => validateAlignmentRows([], 22.5)).toThrow(/non-empty/);
  });

  it('places each caption through the narration offset, with no linear scaling', () => {
    const d = offsetDoc();
    // Two captions in source time: 1.5–3.0 s and 5.0–9.2 s. Timeline = source + 1 (2 + (src − 1)).
    const rows = validateAlignmentRows([
      { sceneId: 'cap_c1', startSec: 1.5, endSec: 3.0 },
      { sceneId: 'cap_c2', startSec: 5.0, endSec: 9.2 },
    ], 22.5);
    const next = applyAlignmentRows(d, rows, ROW_META);
    const c1 = next.captions.find((c) => c.id === 'cap_c1')!;
    const c2 = next.captions.find((c) => c.id === 'cap_c2')!;
    expect(c1.startSec).toBeCloseTo(2.5, 9);
    expect(c1.endSec).toBeCloseTo(4.0, 9);
    expect(c2.startSec).toBeCloseTo(6.0, 9);
    expect(c2.endSec).toBeCloseTo(10.2, 9);
    expect(next.alignment.status).toBe('approved');
  });

  it('keeps the same caption placement when visual clips are split and trimmed', () => {
    const base = offsetDoc();
    const rows = validateAlignmentRows([
      { sceneId: 'cap_c1', startSec: 1.5, endSec: 3.0 },
      { sceneId: 'cap_c2', startSec: 5.0, endSec: 9.2 },
    ], 22.5);
    // Trim the footage clip (video), then split it inside the trimmed range: captions must not depend on visuals.
    const visual = applyEditorOperations(base, [
      { type: 'update', collection: 'visualClips', id: 'vc_s2', changes: { sourceInSec: 0.5, sourceOutSec: 4.5 } },
      { type: 'split', collection: 'visualClips', id: 'vc_s2', atSec: 6 },
    ]);
    expect(visual.visualClips.length).toBe(base.visualClips.length + 1);
    const plain = applyAlignmentRows(base, rows, ROW_META);
    const split = applyAlignmentRows(visual, rows, ROW_META);
    expect(split.captions.map((c) => [c.id, c.startSec, c.endSec])).toEqual(plain.captions.map((c) => [c.id, c.startSec, c.endSec]));
    // And the visual clips are untouched by the alignment itself.
    expect(split.visualClips).toEqual(visual.visualClips);
    expect(split.audioClips).toEqual(visual.audioClips);
  });

  it('preserves narration caption times beyond a shortened visual track', () => {
    const base = offsetDoc();
    const shortened = applyEditorOperations(base, base.visualClips.map((clip) => ({
      type: 'update' as const, collection: 'visualClips' as const, id: clip.id, changes: { durationSec: 0.5 },
    })));
    const next = applyAlignmentRows(shortened, validateAlignmentRows([
      { sceneId: 'cap_c2', startSec: 5, endSec: 9.2 },
    ], 22.5), ROW_META);
    expect(next.captions.find((c) => c.id === 'cap_c2')!.endSec).toBeCloseTo(10.2, 9);
    expect(next.visualClips).toEqual(shortened.visualClips);
  });

  it('refuses a row for an unknown caption id', () => {
    const rows = validateAlignmentRows([{ sceneId: 'vc_s1', startSec: 1, endSec: 3 }], 22.5);
    expect(() => applyAlignmentRows(offsetDoc(), rows, ROW_META)).toThrow(expect.objectContaining({ code: 'ALIGNMENT_ROWS_INVALID' }));
  });

  it('refuses the whole alignment when it would move a locked caption, and changes nothing', () => {
    const d = offsetDoc();
    const locked = applyEditorOperations(d, [{ type: 'update', collection: 'captions', id: 'cap_c2', changes: { locked: true } }]);
    const rows = validateAlignmentRows([
      { sceneId: 'cap_c1', startSec: 1.5, endSec: 3.0 },
      { sceneId: 'cap_c2', startSec: 5.0, endSec: 9.2 },
    ], 22.5);
    expect(() => applyAlignmentRows(locked, rows, ROW_META)).toThrow(expect.objectContaining({ code: 'EDITOR_LOCKED_ITEM' }));
    expect(locked.captions.find((c) => c.id === 'cap_c1')!.startSec).toBe(d.captions.find((c) => c.id === 'cap_c1')!.startSec);
  });

  it('identity covers caption ids, texts and the narration mapping, not visual clips or caption timings', () => {
    const d = offsetDoc();
    const base = alignmentIdentityPayload(d);
    const reworded = applyEditorOperations(d, [{ type: 'update', collection: 'captions', id: 'cap_c1', changes: { text: 'مرحبا' } }]);
    expect(alignmentIdentityPayload(reworded)).not.toBe(base);
    const retimedVisual = applyEditorOperations(d, [{ type: 'update', collection: 'visualClips', id: 'vc_s2', changes: { durationSec: 3 } }]);
    expect(alignmentIdentityPayload(retimedVisual)).toBe(base);
    const splitVisual = applyEditorOperations(d, [{ type: 'split', collection: 'visualClips', id: 'vc_s2', atSec: 6 }]);
    expect(alignmentIdentityPayload(splitVisual)).toBe(base);
    const trimmedNarration = applyEditorOperations(d, [{ type: 'update', collection: 'audioClips', id: NARRATION_CLIP_ID, changes: { sourceInSec: 2 } }]);
    expect(alignmentIdentityPayload(trimmedNarration)).not.toBe(base);
    const moved = applyAlignmentRows(d, validateAlignmentRows([{ sceneId: 'cap_c1', startSec: 1.5, endSec: 3.0 }], 22.5), ROW_META);
    expect(alignmentIdentityPayload(moved)).toBe(base);
  });
});

describe('library audio (distinct sources)', () => {
  const LIB_MUSIC = 'f'.repeat(64);
  const audioRef = (id: string, sha: string | null, durationSec: number | null = 12): DeriveAssetRef => ({
    id, kind: 'audio', name: id, mediaUrl: `/media/asset/${id}`, durationSec, source: 'src', license: 'lic', sha256: sha, mimeType: 'audio/mpeg',
  });

  it('adds eligible audio with its sha256 and refuses audio without a duration or a sha256', () => {
    const doc = plainDoc();
    const merged = mergeLibraryAssets(doc, [
      audioRef('music_a', LIB_MUSIC),
      audioRef('no_duration', LIB_MUSIC, null),
      audioRef('no_sha', null),
      audioRef('bad_sha', 'XYZ'),
    ]);
    const added = merged.assets.filter((a) => a.kind === 'audio');
    expect(added.map((a) => a.id)).toEqual(['music_a']);
    expect(added[0].sha256).toBe(LIB_MUSIC);
    expect(added[0].durationSec).toBe(12);
    expect(mergeLibraryAssets(merged, [audioRef('music_a', LIB_MUSIC)])).toBe(merged);
  });

  it('allows two independent audio sources next to the narration in one document', () => {
    const withTwo = mergeLibraryAssets(offsetDoc(), [audioRef('music_a', LIB_MUSIC), audioRef('sfx_b', 'e'.repeat(64), 4)]);
    const next = applyEditorOperations(withTwo, [
      { type: 'insert', collection: 'audioClips', item: { id: 'ac_music', sourceAssetId: 'music_a', speakerId: null, startSec: 0, sourceInSec: 0, sourceOutSec: 8, gainDb: -12, locked: false, approved: false } },
      { type: 'insert', collection: 'audioClips', item: { id: 'ac_sfx', sourceAssetId: 'sfx_b', speakerId: null, startSec: 3, sourceInSec: 0, sourceOutSec: 2, gainDb: -6, locked: false, approved: false } },
    ]);
    expect(validateEditorDocument(next)).toEqual([]);
    expect(new Set(next.audioClips.map((c) => c.sourceAssetId))).toEqual(new Set(['narration', 'music_a', 'sfx_b']));
  });
});

describe('video audio policy and keepAudio coherence', () => {
  it('accepts keepAudio on a video clip under original or add policy', () => {
    for (const policy of ['original', 'add'] as const) {
      const doc = derived();
      const clips = doc.visualClips.map((c) => (c.sourceAssetId === 'vid1' ? { ...c, keepAudio: true } : c));
      expect(validateEditorDocument({ ...doc, videoAudioPolicy: policy, visualClips: clips })).toEqual([]);
    }
  });

  it('refuses keepAudio without a policy and under muted policies', () => {
    const doc = derived();
    const clips = doc.visualClips.map((c) => (c.sourceAssetId === 'vid1' ? { ...c, keepAudio: true } : c));
    expect(validateEditorDocument({ ...doc, visualClips: clips }).join(' ')).toMatch(/videoAudioPolicy/);
    for (const policy of ['silent', 'replace'] as const) {
      expect(validateEditorDocument({ ...doc, videoAudioPolicy: policy, visualClips: clips }).join(' ')).toMatch(/mutes every clip/);
    }
  });

  it('refuses keepAudio on a still image and an unknown policy enum', () => {
    const doc = derived();
    const imageClips = doc.visualClips.map((c) => (c.sourceAssetId === 'img1' ? { ...c, keepAudio: true } : c));
    expect(validateEditorDocument({ ...doc, videoAudioPolicy: 'original', visualClips: imageClips }).join(' ')).toMatch(/only on video footage/);
    const bad = validateEditorDocument({ ...doc, videoAudioPolicy: 'loud' as never });
    expect(bad.join(' ')).toMatch(/videoAudioPolicy must be one of/);
  });

  it('carries keepAudio through the render plan into the scene content', () => {
    const doc = derived();
    const clips = doc.visualClips.map((c) => (c.sourceAssetId === 'vid1' ? { ...c, keepAudio: true } : c));
    const plan = editorDocumentToRenderPlan({ ...doc, videoAudioPolicy: 'original', visualClips: clips });
    const scene = plan.scenes.find((s) => s.content.mediaKind === 'video')!;
    expect(scene.content.keepAudio).toBe(true);
    expect(plan.scenes.filter((s) => s.content.keepAudio === true)).toHaveLength(1);
  });
});
