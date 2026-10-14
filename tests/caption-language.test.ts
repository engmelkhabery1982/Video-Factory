/**
 * Caption language selection (preview and export), pure core. No I/O, no provider, no browser.
 * Fixture-level checks: translation links are shown in one language at a time.
 */
import { describe, expect, it } from 'vitest';
import {
  EDITOR_SCHEMA_VERSION,
  applyEditorOperations,
  deriveEditorDocument,
  editorDocumentToRenderPlan,
  selectCaptions,
  validateEditorDocument,
  type DeriveAssetRef,
  type EditorDocument,
  type Project,
} from '@buildtrack/core';

const AR_1 = 'اتقوا الله في الجميع';
const AR_2 = 'وتنسى ما أعطيت';

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
    meta: { input: { videoId: 'Caption_Fixture', outputLanguage: 'ar', brandPreset: 'unbound-religious', contentProfile: 'religious' }, brand: {}, createdAt: '', updatedAt: '', status: 'draft' },
    storyboard: {
      videoId: 'Caption_Fixture', createdAt: '', brand: {},
      long: { scenes: [scene('s1', 0, 0, 4.5, ['img1']), scene('s2', 1, 4.5, 6.022, ['vid1'])], totalDuration: 10.522, endScreenReserveSeconds: 8 },
      shorts: [], segments: [], warnings: [], similarity: null,
      captions: [
        { id: 'c1', start: 0, end: 4.5, text: AR_1, sceneId: 's1', terms: [], userEdited: false },
        { id: 'c2', start: 4.5, end: 10.522, text: AR_2, sceneId: 's2', terms: [], userEdited: false },
      ],
    } as unknown as Project['storyboard'],
    artifacts: [], qc: [],
  } as unknown as Project;
}

const ASSETS: DeriveAssetRef[] = [
  { id: 'img1', kind: 'image', name: 'Owner picture', mediaUrl: '/media/asset/img1', durationSec: null, source: 'owner', license: 'owner', mimeType: 'image/png' },
  { id: 'vid1', kind: 'video', name: 'Owner footage', mediaUrl: '/media/asset/vid1', durationSec: 60, source: 'owner', license: 'owner', mimeType: 'video/mp4' },
];

/** Spoken cap_c1 and cap_c2. A translation of cap_c1 only, so cap_c2 has no English text and must not be filled in. */
function withTranslation(): EditorDocument {
  const doc = deriveEditorDocument({
    project: fixtureProject(),
    targetId: 'long',
    assets: ASSETS,
    narration: { assetId: 'nar1', durationSec: 10.522, sha256: 'a'.repeat(64), approved: true },
  });
  return applyEditorOperations(doc, [{
    type: 'insert', collection: 'captions',
    item: { id: 'tr_c1', cueOf: 'cap_c1', text: 'Fear God in all', language: 'en', direction: 'ltr', fontSizePx: 40, position: { x: 0.5, y: 0.9 }, locked: false },
  }]);
}

const shownText = (doc: EditorDocument) => editorDocumentToRenderPlan(doc).captions.map((c) => `${c.id}:${c.text}`);

describe('caption language selection (preview and export)', () => {
  it('by default shows spoken captions only, so spoken and translated text never overlay', () => {
    const doc = withTranslation();
    const plan = editorDocumentToRenderPlan(doc);
    expect(plan.captionLanguage).toBeNull();
    expect(plan.missingTranslations).toEqual([]);
    expect(shownText(doc)).toEqual([`cap_c1:${AR_1}`, `cap_c2:${AR_2}`]);
  });

  it('a selected language shows each spoken cue once, in that language, on the spoken cue timing', () => {
    const doc = applyEditorOperations(withTranslation(), [{ type: 'setDocument', changes: { captionLanguage: 'en' } }]);
    const plan = editorDocumentToRenderPlan(doc);
    expect(plan.captionLanguage).toBe('en');
    expect(plan.captions.map((c) => c.id)).toEqual(['tr_c1']);
    expect(plan.captions[0]).toMatchObject({ text: 'Fear God in all', start: 0, end: 4.5 });
    expect(plan.scenes[0].captionIds).toEqual(['tr_c1']);
  });

  it('a spoken cue with no translation in the selected language is reported, never filled with spoken text', () => {
    const doc = applyEditorOperations(withTranslation(), [{ type: 'setDocument', changes: { captionLanguage: 'en' } }]);
    const plan = editorDocumentToRenderPlan(doc);
    expect(plan.missingTranslations).toEqual(['cap_c2']);
    expect(plan.captions.some((c) => c.text === AR_2)).toBe(false);
    expect(plan.scenes[1].captionIds).toEqual([]);
  });

  it('selecting the spoken language shows the spoken cues again and no translation', () => {
    const doc = applyEditorOperations(withTranslation(), [{ type: 'setDocument', changes: { captionLanguage: 'ar' } }]);
    expect(shownText(doc)).toEqual([`cap_c1:${AR_1}`, `cap_c2:${AR_2}`]);
  });

  it('selectCaptions is the single rule: spoken cues in their language, translations only for the selected language', () => {
    const doc = withTranslation();
    expect(selectCaptions(doc, null).cues.map((c) => c.id)).toEqual(['cap_c1', 'cap_c2']);
    expect(selectCaptions(doc, 'en')).toEqual({ cues: [doc.captions.find((c) => c.id === 'tr_c1')], missingTranslations: ['cap_c2'] });
  });

  it('the language is validated: a malformed code is refused by the operation and by validation', () => {
    const doc = withTranslation();
    expect(() => applyEditorOperations(doc, [{ type: 'setDocument', changes: { captionLanguage: 'EN' } }])).toThrow(/captionLanguage must be a language code/);
    expect(() => applyEditorOperations(doc, [{ type: 'setDocument', changes: { captionLanguage: 'english please' } }])).toThrow(/captionLanguage/);
    const bad = { ...doc, captionLanguage: 'not a code' } as EditorDocument;
    expect(validateEditorDocument(bad).join(' ')).toMatch(/captionLanguage must be a language code/);
  });

  it('save and reopen keep the selection, the link, and the shared timing', () => {
    const selected = applyEditorOperations(withTranslation(), [{ type: 'setDocument', changes: { captionLanguage: 'en' } }]);
    const reopened = JSON.parse(JSON.stringify(selected)) as EditorDocument;
    expect(reopened.schemaVersion).toBe(EDITOR_SCHEMA_VERSION);
    expect(validateEditorDocument(reopened)).toEqual([]);
    expect(reopened.captionLanguage).toBe('en');
    expect(JSON.stringify(editorDocumentToRenderPlan(reopened))).toBe(JSON.stringify(editorDocumentToRenderPlan(selected)));
  });

  it('editing a translation text keeps the selection, its link, and its timing', () => {
    const selected = applyEditorOperations(withTranslation(), [
      { type: 'setDocument', changes: { captionLanguage: 'en' } },
      { type: 'update', collection: 'captions', id: 'tr_c1', changes: { text: 'Be mindful of God' } },
    ]);
    const tr = selected.captions.find((c) => c.id === 'tr_c1')!;
    expect(tr).toMatchObject({ cueOf: 'cap_c1', startSec: 0, endSec: 4.5, text: 'Be mindful of God' });
    expect(editorDocumentToRenderPlan(selected).captions[0].text).toBe('Be mindful of God');
  });
});
