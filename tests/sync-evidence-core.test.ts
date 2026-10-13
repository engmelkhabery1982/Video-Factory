/**
 * Synchronization evidence, pure core. No I/O, no provider, no browser.
 * Fixture-level checks only: they prove the rules, not owner-recording sync.
 */
import { describe, expect, it } from 'vitest';
import {
  EDITOR_SCHEMA_VERSION,
  NARRATION_CLIP_ID,
  applyAlignmentRows,
  applyEditorOperations,
  assertValidEditorDocument,
  compareScriptToTranscript,
  deriveEditorDocument,
  diffTokens,
  excerptIdentitySha256,
  normalizeSpokenText,
  reconcileNarration,
  spokenTokens,
  syncVerdict,
  validateAlignmentRows,
  validateEditorDocument,
  type DeriveAssetRef,
  type EditorDocument,
  type Project,
} from '@buildtrack/core';

const AR_CAPTION = 'اتقوا الله في الجميع';
const AR_CAPTION_2 = 'وتنسى ما أعطيت';

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
      input: { videoId: 'Sync_Fixture', outputLanguage: 'ar', brandPreset: 'unbound-religious', contentProfile: 'religious' },
      brand: {}, createdAt: '', updatedAt: '', status: 'draft',
    },
    storyboard: {
      videoId: 'Sync_Fixture', createdAt: '', brand: {},
      long: {
        scenes: [scene('s1', 0, 0, 4.5, ['img1']), scene('s2', 1, 4.5, 6.022, ['vid1']), scene('s3', 2, 10.522, 7.5, [])],
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

const cap = (doc: EditorDocument, id: string) => doc.captions.find((c) => c.id === id)!;

describe('Arabic comparison: display text is kept, comparison ignores diacritics and letter variants only', () => {
  it('ignores harakat and tatweel, folds alef and ta marbuta variants', () => {
    expect(normalizeSpokenText('اتَّقُوا اللَّهَ')).toBe(normalizeSpokenText('اتقوا الله'));
    expect(normalizeSpokenText('إِنَّ')).toBe(normalizeSpokenText('ان'));
    expect(normalizeSpokenText('رَحْمَة')).toBe(normalizeSpokenText('رحمه'));
    expect(normalizeSpokenText('ـــــ')).toBe('');
  });

  it('does not treat different words as equal', () => {
    expect(compareScriptToTranscript('وتنسى ما أعطيت', 'وتنسى ما اعطيت').agrees).toBe(true);
    expect(compareScriptToTranscript('وتنسى ما أعطيت', 'وتنسى ما منحت').agrees).toBe(false);
  });

  it('keeps the stored text unchanged (normalisation is comparison only)', () => {
    const stored = 'اتَّقُوا اللَّهَ';
    normalizeSpokenText(stored);
    expect(stored).toBe('اتَّقُوا اللَّهَ');
  });
});

describe('token diff', () => {
  it('reports missing and extra words in order', () => {
    const d = diffTokens(['a', 'b', 'c', 'd'], ['a', 'x', 'c']);
    expect(d.missing).toEqual(['b', 'd']);
    expect(d.extra).toEqual(['x']);
    expect(d.matched).toBe(2);
  });

  it('an absent final sentence is a missing tail, not an empty match', () => {
    const script = `${AR_CAPTION} ${AR_CAPTION_2}`;
    const d = compareScriptToTranscript(script, AR_CAPTION);
    expect(d.agrees).toBe(false);
    expect(d.missing).toEqual(spokenTokens(AR_CAPTION_2));
  });

  it('empty script never agrees', () => {
    expect(compareScriptToTranscript('', '').agrees).toBe(false);
  });
});

describe('excerpt identity', () => {
  const base = { audioSha256: 'b'.repeat(64), sourceInSec: 1.25, sourceOutSec: 9.5, compositionStartSec: 2 };

  it('is stable for the same inputs and ignores float noise below the millisecond', () => {
    expect(excerptIdentitySha256(base)).toBe(excerptIdentitySha256({ ...base }));
    expect(excerptIdentitySha256({ ...base, sourceInSec: 0.1 + 0.2 })).toBe(excerptIdentitySha256({ ...base, sourceInSec: 0.3 }));
  });

  it('changes when the audio bytes, the source window, or the timeline placement change', () => {
    const h = excerptIdentitySha256(base);
    expect(excerptIdentitySha256({ ...base, audioSha256: 'c'.repeat(64) })).not.toBe(h);
    expect(excerptIdentitySha256({ ...base, sourceInSec: 1.251 })).not.toBe(h);
    expect(excerptIdentitySha256({ ...base, sourceOutSec: 9.4 })).not.toBe(h);
    expect(excerptIdentitySha256({ ...base, compositionStartSec: 2.5 })).not.toBe(h);
  });
});

describe('verdict: forced alignment alone is never verified', () => {
  const ex = 'e'.repeat(64);
  const script = `${AR_CAPTION} ${AR_CAPTION_2}`;

  it('no alignment requested', () => {
    expect(syncVerdict({ evidenceExcerptSha256: null, currentExcerptSha256: null, forcedAlignmentAvailable: false, script, transcript: null }).verdict).toBe('not_requested');
  });

  it('evidence made for another excerpt is stale, whatever the transcript says', () => {
    const r = syncVerdict({ evidenceExcerptSha256: ex, currentExcerptSha256: 'f'.repeat(64), forcedAlignmentAvailable: true, script, transcript: script });
    expect(r.verdict).toBe('stale');
  });

  it('forced alignment with no transcript is unverified and says it proves timing fit only', () => {
    const r = syncVerdict({ evidenceExcerptSha256: ex, currentExcerptSha256: ex, forcedAlignmentAvailable: true, script, transcript: null });
    expect(r.verdict).toBe('unverified');
    expect(r.reasons.join(' ')).toMatch(/not that the words were spoken/);
  });

  it('a transcript that omits a supplied sentence is a discrepancy, not verified', () => {
    const r = syncVerdict({ evidenceExcerptSha256: ex, currentExcerptSha256: ex, forcedAlignmentAvailable: true, script, transcript: AR_CAPTION });
    expect(r.verdict).toBe('discrepancy');
    expect(r.diff?.missing.length).toBeGreaterThan(0);
  });

  it('a transcript that agrees with forced alignment present is verified', () => {
    const r = syncVerdict({ evidenceExcerptSha256: ex, currentExcerptSha256: ex, forcedAlignmentAvailable: true, script, transcript: `${AR_CAPTION} ${AR_CAPTION_2}` });
    expect(r.verdict).toBe('verified');
  });

  it('a transcript that agrees but with no forced placement is unverified', () => {
    const r = syncVerdict({ evidenceExcerptSha256: ex, currentExcerptSha256: ex, forcedAlignmentAvailable: false, script, transcript: script });
    expect(r.verdict).toBe('unverified');
  });
});

describe('trim invalidation survives reload', () => {
  it('a narration trim clears approval, alignment and its evidence, and the cleared state validates after a JSON round trip', () => {
    const bound = reconcileNarration(
      deriveEditorDocument({ project: fixtureProject(), targetId: 'long', assets: ASSETS }),
      { importId: 'imp_t', name: 'n', mediaUrl: '/n', source: 's', license: 'l', durationSec: 22.5, sha256: 'a'.repeat(64), approved: true },
    ).doc;
    const withEvidence: EditorDocument = {
      ...bound,
      alignment: { status: 'approved', audioSha256: 'a'.repeat(64), sourceRevision: bound.revision, proposalId: 'prp_1', excerptSha256: 'e'.repeat(64), syncVerdict: 'verified' },
    };
    const trimmed = applyEditorOperations(withEvidence, [
      { type: 'update', collection: 'audioClips', id: NARRATION_CLIP_ID, changes: { sourceOutSec: 20 } },
    ]);
    expect(trimmed.alignment).toEqual({ status: 'not_requested', audioSha256: null, sourceRevision: null, proposalId: null, excerptSha256: null, syncVerdict: null });
    expect(trimmed.audioClips.find((c) => c.id === NARRATION_CLIP_ID)!.approved).toBe(false);
    const reloaded = JSON.parse(JSON.stringify(trimmed)) as EditorDocument;
    expect(() => assertValidEditorDocument(reloaded)).not.toThrow();
    expect(reloaded.alignment.status).toBe('not_requested');
    expect(reloaded.alignment.syncVerdict).toBeNull();
  });

  it('a document saved before the evidence fields existed still validates and reads as not requested', () => {
    const legacy = derived() as EditorDocument & { alignment: Record<string, unknown> };
    legacy.alignment = { status: 'not_requested', audioSha256: null, sourceRevision: null, proposalId: null };
    expect(validateEditorDocument(legacy)).toEqual([]);
  });
});

describe('highlights stay on the timeline: refused when outside their clip, never moved', () => {
  const withHighlight = () => applyEditorOperations(derived(), [{
    type: 'insert', collection: 'highlights',
    item: { id: 'h1', startSec: 5, endSec: 6, visualClipId: 'vc_s2', box: { x: 0.4, y: 0.3, width: 0.2, height: 0.1 }, label: 'Total', locked: false },
  }]);

  it('moving a highlight out of its clip is refused and the input is untouched', () => {
    const doc = withHighlight();
    const snapshot = JSON.stringify(doc);
    expect(() => applyEditorOperations(doc, [{ type: 'update', collection: 'highlights', id: 'h1', changes: { startSec: 30, endSec: 31 } }]))
      .toThrow(/outside its visual clip/);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('trimming the visual clip so a highlight falls outside is refused, and the highlight does not move', () => {
    const doc = withHighlight();
    const clip = doc.visualClips.find((c) => c.id === 'vc_s2')!;
    expect(() => applyEditorOperations(doc, [{ type: 'update', collection: 'visualClips', id: 'vc_s2', changes: { durationSec: 0.5 } }]))
      .toThrow(/outside its visual clip/);
    expect(doc.highlights[0].startSec).toBe(5);
    expect(doc.highlights[0].endSec).toBe(6);
    expect(clip.durationSec).toBeGreaterThan(0.5);
  });
});

describe('caption translation link (cueOf)', () => {
  const linkedTo = (spokenId: string, changes: Record<string, unknown> = {}) => applyEditorOperations(derived(), [{
    type: 'insert', collection: 'captions',
    item: { id: 'tr_1', cueOf: spokenId, text: 'translation text', language: 'en', direction: 'ltr', fontSizePx: 40, position: { x: 0.5, y: 0.9 }, locked: false, ...changes },
  }]);

  it('a translation copies the spoken cue timing when none is supplied', () => {
    const doc = linkedTo('cap_c1');
    expect(cap(doc, 'tr_1').startSec).toBe(cap(doc, 'cap_c1').startSec);
    expect(cap(doc, 'tr_1').endSec).toBe(cap(doc, 'cap_c1').endSec);
  });

  it('a translation with timing that differs from its spoken cue is refused', () => {
    expect(() => linkedTo('cap_c1', { startSec: 1, endSec: 2 })).toThrow(/share the timing/);
  });

  it('a translation cannot link to a missing cue or to another translation', () => {
    expect(() => linkedTo('nope')).toThrow(/needs an existing spoken cue/);
    const doc = linkedTo('cap_c1');
    expect(() => applyEditorOperations(doc, [{
      type: 'insert', collection: 'captions',
      item: { id: 'tr_2', cueOf: 'tr_1', text: 'x', language: 'en', direction: 'ltr', fontSizePx: 40, position: { x: 0.5, y: 0.9 }, locked: false },
    }])).toThrow(/another translation/);
  });

  it('timing edits on a translation are refused, and the document is unchanged', () => {
    const doc = linkedTo('cap_c1');
    expect(() => applyEditorOperations(doc, [{ type: 'update', collection: 'captions', id: 'tr_1', changes: { startSec: 0.5 } }]))
      .toThrow(/follows its spoken cue/);
    expect(cap(doc, 'tr_1').startSec).toBe(cap(doc, 'cap_c1').startSec);
  });

  it('editing translation text keeps its timing exactly and never touches the spoken cue', () => {
    const doc = linkedTo('cap_c1');
    const next = applyEditorOperations(doc, [{ type: 'update', collection: 'captions', id: 'tr_1', changes: { text: 'a new wording' } }]);
    expect(cap(next, 'tr_1').text).toBe('a new wording');
    expect(cap(next, 'tr_1').startSec).toBe(cap(doc, 'tr_1').startSec);
    expect(cap(next, 'tr_1').endSec).toBe(cap(doc, 'tr_1').endSec);
    expect(cap(next, 'cap_c1').text).toBe(AR_CAPTION);
  });

  it('retiming the spoken cue moves its translations to the same timing', () => {
    const doc = linkedTo('cap_c1');
    const next = applyEditorOperations(doc, [{ type: 'update', collection: 'captions', id: 'cap_c1', changes: { startSec: 0.5, endSec: 3.5 } }]);
    expect(cap(next, 'tr_1').startSec).toBe(0.5);
    expect(cap(next, 'tr_1').endSec).toBe(3.5);
    expect(() => assertValidEditorDocument(next)).not.toThrow();
  });

  it('a spoken cue with a translation cannot be removed until the translation is removed', () => {
    const doc = linkedTo('cap_c1');
    expect(() => applyEditorOperations(doc, [{ type: 'remove', collection: 'captions', id: 'cap_c1' }])).toThrow(/Remove the translation first/);
    const removed = applyEditorOperations(doc, [{ type: 'remove', collection: 'captions', id: 'tr_1' }, { type: 'remove', collection: 'captions', id: 'cap_c1' }]);
    expect(removed.captions.find((c) => c.id === 'cap_c1')).toBeUndefined();
  });

  it('the link cannot be re-pointed by an update', () => {
    const doc = linkedTo('cap_c1');
    expect(() => applyEditorOperations(doc, [{ type: 'update', collection: 'captions', id: 'tr_1', changes: { cueOf: 'cap_c2' } }]))
      .toThrow();
  });

  it('a document where a translation disagrees with its cue is reported by validation', () => {
    const doc = linkedTo('cap_c1');
    const broken = { ...doc, captions: doc.captions.map((c) => (c.id === 'tr_1' ? { ...c, startSec: c.startSec + 1 } : c)) };
    expect(validateEditorDocument(broken).join(' ')).toMatch(/timing differs from its spoken cue/);
  });

  it('accepted alignment rows cannot move a translation directly, and move its spoken cue with it', () => {
    const doc = linkedTo('cap_c1');
    const bound = reconcileNarration(doc, {
      importId: 'imp_x', name: 'n', mediaUrl: '/n', source: 's', license: 'l', durationSec: 22.5, sha256: 'c'.repeat(64), approved: true,
    }).doc;
    const meta = { audioSha256: 'c'.repeat(64), proposalId: 'p_sync', sourceRevision: bound.revision };
    expect(() => applyAlignmentRows(bound, validateAlignmentRows([{ sceneId: 'tr_1', startSec: 1, endSec: 2 }], 22.5), meta))
      .toThrow(/follows its spoken cue/);
    const aligned = applyAlignmentRows(bound, validateAlignmentRows([{ sceneId: 'cap_c1', startSec: 1, endSec: 2.5 }], 22.5), meta);
    expect(cap(aligned, 'tr_1').startSec).toBe(cap(aligned, 'cap_c1').startSec);
    expect(cap(aligned, 'tr_1').endSec).toBe(cap(aligned, 'cap_c1').endSec);
    expect(cap(aligned, 'tr_1').text).toBe('translation text');
    expect(aligned.alignment.excerptSha256).toBeNull();
  });
});

describe('schema', () => {
  it('derived documents are on the current schema and carry no translation links by default', () => {
    const doc = derived();
    expect(doc.schemaVersion).toBe(EDITOR_SCHEMA_VERSION);
    expect(doc.captions.every((c) => !c.cueOf)).toBe(true);
  });
});
