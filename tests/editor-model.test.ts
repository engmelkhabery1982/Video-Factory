/**
 * Milestone 1 editor — document model, contract operations and fixture rules.
 *
 * Pure logic, no DOM: composition-time math, source-range/media validation,
 * lock semantics, the operation builders that go to the contract endpoint, the
 * local approximation used only for the browser assembly preview, and the
 * opt-in rules of the development fixture.
 *
 * A successful run here is NOT end-to-end acceptance: the server endpoints do
 * not exist in this workspace yet (see LOCAL_VERIFY_STEPS.txt).
 */
import { describe, expect, it } from 'vitest';
import {
  boxToPercent,
  clampBox,
  completeWords,
  containsDiacritics,
  defaultCaption,
  defaultHighlight,
  describeError,
  detectCaptionDirection,
  documentDuration,
  documentFindings,
  hasRtlScript,
  isEndpointMissing,
  localApply,
  moveIds,
  opInsert,
  opRemove,
  opReorder,
  opSetDocument,
  opSplit,
  opUpdate,
  operationFindings,
  pictureDuration,
  placedClipAt,
  revisionConflictFrom,
  splitClip,
  suggestFontSize,
  summaryOf,
  visualTimeline,
} from '../apps/web/src/lib/editor-model.js';
import {
  fixtureControls,
  fixtureDocument,
  fixtureEnabled,
  fixtureGet,
  fixtureModeFrom,
  fixturePatch,
  fixturePreviewStart,
  fixtureReset,
  resetFixture,
  setFixtureControl,
} from '../apps/web/src/lib/editor-fixture.js';
import type { EditorDocument, EditorOperation } from '../apps/web/src/lib/editor-types.js';

function doc(overrides: Partial<EditorDocument> = {}): EditorDocument {
  return { ...fixtureDocument('Editor_Test', 'long'), ...overrides };
}

describe('composition time is not source time', () => {
  it('recalculates composition starts from the visual order and keeps durations', () => {
    const document = doc();
    const timeline = visualTimeline(document);
    expect(timeline.map((placed) => placed.startSec)).toEqual([0, 16, 28]);
    expect(timeline.map((placed) => placed.clip.durationSec)).toEqual([16, 12, 10]);
    expect(pictureDuration(document)).toBe(38);
  });

  it('reorder changes only the visual order: captions, audio and source offsets are untouched', () => {
    const document = doc();
    const ids = moveIds(
      document.visualClips.map((clip) => clip.id),
      'vc_03',
      -2,
    );
    expect(ids).toEqual(['vc_03', 'vc_01', 'vc_02']);
    const moved: EditorDocument = {
      ...document,
      visualClips: ids!.map((id) => document.visualClips.find((clip) => clip.id === id)!),
    };
    const timeline = visualTimeline(moved);
    expect(timeline.map((placed) => placed.clip.id)).toEqual(['vc_03', 'vc_01', 'vc_02']);
    expect(timeline.map((placed) => placed.startSec)).toEqual([0, 10, 26]);
    // the video clip still reads the same bytes: source in/out unchanged
    expect(timeline[1].clip.sourceInSec).toBe(4);
    expect(timeline[1].clip.sourceOutSec).toBe(20);
    expect(moved.captions).toEqual(document.captions);
    expect(moved.audioClips).toEqual(document.audioClips);
  });

  it('moveIds refuses to move past either end', () => {
    expect(moveIds(['a', 'b'], 'a', -1)).toBeNull();
    expect(moveIds(['a', 'b'], 'b', 1)).toBeNull();
    expect(moveIds(['a', 'b'], 'missing', 1)).toBeNull();
  });

  it('declared duration wins while it is usable, otherwise the picture track does', () => {
    expect(documentDuration(doc())).toBe(38);
    expect(documentDuration(doc({ durationSec: Number.NaN }))).toBe(38);
    expect(documentDuration(doc({ durationSec: 0, visualClips: doc().visualClips.slice(0, 1) }))).toBe(16);
  });
});

describe('split preserves source position, total duration and the visual result', () => {
  it('splits a video clip at a composition time and rewrites both source in/out', () => {
    const document = doc();
    const result = splitClip(document, 'vc_01', 6);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.left.durationSec).toBe(6);
    expect(result.left.sourceInSec).toBe(4);
    expect(result.left.sourceOutSec).toBe(10);
    expect(result.right.durationSec).toBe(10);
    expect(result.right.sourceInSec).toBe(10);
    expect(result.right.sourceOutSec).toBe(20);
    expect(result.left.durationSec + result.right.durationSec).toBe(16);
    expect(result.left.crop).toEqual(result.right.crop);
  });

  it('a still keeps a null source out-point on both halves', () => {
    const result = splitClip(doc(), 'vc_02', 20);
    if ('error' in result) throw new Error(result.error);
    expect(result.left.sourceOutSec).toBeNull();
    expect(result.right.sourceOutSec).toBeNull();
  });

  it('refuses a split on the edge, outside the clip, or on a locked clip', () => {
    const document = doc();
    expect('error' in splitClip(document, 'vc_01', 0)).toBe(true);
    expect('error' in splitClip(document, 'vc_01', 16)).toBe(true);
    expect('error' in splitClip(document, 'nope', 5)).toBe(true);
    const locked = doc({ visualClips: doc().visualClips.map((clip) => (clip.id === 'vc_01' ? { ...clip, locked: true } : clip)) });
    expect('error' in splitClip(locked, 'vc_01', 6)).toBe(true);
    expect(operationFindings(document, opSplit('vc_01', 40))[0].field).toBe('visualClips.vc_01.atSec');
  });
});

describe('validation refuses what the contract cannot express', () => {
  it('refuses a start time in an update: composition start follows the order', () => {
    const findings = operationFindings(doc(), opUpdate('visualClips', 'vc_01', { startSec: 5 }));
    expect(findings.some((finding) => finding.message.includes('follows the visual order'))).toBe(true);
  });

  it('refuses media that does not match the slot', () => {
    const audioIntoPicture = operationFindings(doc(), opUpdate('visualClips', 'vc_01', { sourceAssetId: 'asset-narration-approved' }));
    expect(audioIntoPicture.some((finding) => finding.message.includes('cannot fill a picture slot'))).toBe(true);

    const stillWithOutPoint = operationFindings(doc(), opUpdate('visualClips', 'vc_02', { sourceOutSec: 9 }));
    expect(stillWithOutPoint.some((finding) => finding.message.includes('no source out-point'))).toBe(true);

    const videoWithoutOutPoint = operationFindings(doc(), opUpdate('visualClips', 'vc_01', { sourceOutSec: null }));
    expect(videoWithoutOutPoint.some((finding) => finding.message.includes('source out-point is required'))).toBe(true);
  });

  it('refuses a source range outside the file', () => {
    const findings = operationFindings(doc(), opUpdate('visualClips', 'vc_01', { sourceOutSec: 900 }));
    expect(findings.some((finding) => finding.message.includes('past the end'))).toBe(true);
  });

  it('refuses a caption whose end is not after its start, and an empty caption', () => {
    expect(operationFindings(doc(), opUpdate('captions', 'cap_01', { endSec: 1 })).some((f) => f.message.includes('end time after its start'))).toBe(true);
    expect(operationFindings(doc(), opUpdate('captions', 'cap_01', { text: '   ' })).some((f) => f.message.includes('cannot be empty'))).toBe(true);
  });

  it('refuses a highlight without measured times or with a box outside the frame', () => {
    expect(operationFindings(doc(), opUpdate('highlights', 'hl_01', { endSec: 6 })).some((f) => f.message.includes('measured start and end times'))).toBe(true);
    expect(operationFindings(doc(), opUpdate('highlights', 'hl_01', { box: { x: 0.9, y: 0.1, width: 0.5, height: 0.2 } })).some((f) => f.message.includes('past the display frame'))).toBe(true);
  });

  it('a locked item rejects mutation unless the update only unlocks it', () => {
    const document = doc();
    const lockedClip = opUpdate('visualClips', 'vc_01', { durationSec: 5 });
    expect(operationFindings(document, lockedClip)).toEqual([]);
    const withLock = doc({ visualClips: document.visualClips.map((clip) => (clip.id === 'vc_01' ? { ...clip, locked: true } : clip)) });
    expect(operationFindings(withLock, lockedClip)[0].message).toContain('locked');
    expect(operationFindings(withLock, opUpdate('visualClips', 'vc_01', { locked: false }))).toEqual([]);
    expect(operationFindings(withLock, opUpdate('visualClips', 'vc_01', { locked: false, durationSec: 5 }))[0].message).toContain('locked');
  });

  it('refuses a reorder that does not list every clip exactly once', () => {
    expect(operationFindings(doc(), opReorder(['vc_01', 'vc_02']))[0].message).toContain('every visual clip exactly once');
    expect(operationFindings(doc(), opReorder(['vc_01', 'vc_02', 'vc_03']))).toEqual([]);
  });

  it('reports the document findings without hiding them', () => {
    const document = doc({ visualClips: doc().visualClips.map((clip) => (clip.id === 'vc_03' ? { ...clip, sourceAssetId: 'asset-narration-approved' } : clip)) });
    expect(documentFindings(document).some((finding) => finding.message.includes('cannot fill a picture slot'))).toBe(true);
    expect(summaryOf(document).unboundClips).toBe(0);
  });
});

describe('RTL captions keep complete words, shaping and diacritics', () => {
  it('detects a right-to-left script and reports diacritics', () => {
    expect(hasRtlScript('افتح ورقة الملخص')).toBe(true);
    expect(hasRtlScript('open the summary sheet')).toBe(false);
    expect(detectCaptionDirection('مرحبا')).toBe('rtl');
    expect(detectCaptionDirection('hello')).toBe('ltr');
    expect(detectCaptionDirection('', 'rtl')).toBe('rtl');
    expect(containsDiacritics('الرَّحْمَٰن')).toBe(true);
    expect(containsDiacritics('مرحبا')).toBe(false);
  });

  it('never cuts a caption mid-word and keeps a readable floor', () => {
    expect(completeWords('  فتح   الورقة  ')).toBe('فتح الورقة');
    expect(suggestFontSize('افتح ورقة الملخص ثم حدد الإجمالي', 1920)).toBeGreaterThanOrEqual(24);
    expect(suggestFontSize('افتح ورقة الملخص ثم حدد الإجمالي', 1920)).toBeLessThanOrEqual(96);
    expect(suggestFontSize('', 1080)).toBe(44);
  });

  it('creates a caption whose interval is its own, not a scene’s', () => {
    const cue = defaultCaption(doc(), 17, 'لاحظ الفرق بين المنفذ والمقبول');
    expect(cue.startSec).toBe(17);
    // 17s sits inside vc_02 (16–28s) but the interval is the caption's own
    expect(cue.endSec).toBe(28);
    expect(cue.direction).toBe('rtl');
    expect(cue.position.y).toBeGreaterThan(0.5);
  });
});

describe('highlights carry measured display coordinates and times', () => {
  it('clamps a box into the display frame and converts it to percentages', () => {
    expect(clampBox({ x: -0.2, y: 0.9, width: 1.4, height: 0.5 })).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
    expect(boxToPercent({ x: 0.5, y: 0.25, width: 0.25, height: 0.1 })).toEqual({ left: '50.000%', top: '25.000%', width: '25.000%', height: '10.000%' });
  });

  it('starts a new highlight at the playhead inside the current clip', () => {
    const highlight = defaultHighlight(doc(), 6);
    expect(highlight.startSec).toBe(6);
    expect(highlight.endSec).toBe(9);
    expect(highlight.visualClipId).toBe('vc_01');
    expect(highlight.label).toBeNull();
  });
});

describe('localApply is the assembly-preview approximation, not a save', () => {
  it('applies operations without ever touching the revision', () => {
    const document = doc();
    const next = localApply(document, [opUpdate('visualClips', 'vc_01', { durationSec: 10 }), opReorder(['vc_03', 'vc_01', 'vc_02'])]);
    expect(next.revision).toBe(document.revision);
    expect(next.visualClips.map((clip) => clip.id)).toEqual(['vc_03', 'vc_01', 'vc_02']);
    expect(next.visualClips.map((clip) => clip.startSec)).toEqual([0, 10, 20]);
    expect(next.durationSec).toBe(32);
  });

  it('applies insert, remove and setDocument without mutating the input document', () => {
    const document = doc();
    const operations: EditorOperation[] = [
      opInsert('captions', { id: 'cap_09', startSec: 0, endSec: 1, text: 'جديد', language: 'ar', direction: 'rtl', fontSizePx: 44, position: { x: 0.5, y: 0.8 }, locked: false }),
      opRemove('highlights', 'hl_01'),
      opSetDocument({ contentProfile: 'religious', channelBrandId: 'owner-brand', format: 'portrait' }),
    ];
    const next = localApply(document, operations);
    expect(next.captions.map((cue) => cue.id)).toContain('cap_09');
    expect(next.highlights).toEqual([]);
    expect(next.contentProfile).toBe('religious');
    expect(next.format).toBe('portrait');
    expect(document.captions.map((cue) => cue.id)).not.toContain('cap_09');
    expect(document.contentProfile).toBe('educational');
  });

  it('ignores a split that is out of range instead of inventing a clip', () => {
    const document = doc();
    const next = localApply(document, [opSplit('vc_01', 40)]);
    expect(next.visualClips).toHaveLength(document.visualClips.length);
  });

  it('placedClipAt finds the clip a composition time lands in', () => {
    expect(placedClipAt(doc(), 'vc_02')?.startSec).toBe(16);
    expect(placedClipAt(doc(), null)).toBeNull();
  });
});

describe('errors are reported, never turned into success', () => {
  it('separates a revision conflict from a transport failure', () => {
    const conflict = revisionConflictFrom({ status: 409, payload: { code: 'REVISION_CONFLICT', message: 'stale', currentRevision: 7 } });
    expect(conflict).toEqual({ currentRevision: 7, message: 'stale' });
    expect(revisionConflictFrom({ status: 409, payload: { currentRevision: 7 } })?.currentRevision).toBe(7);
    expect(revisionConflictFrom({ status: 500, payload: { error: 'boom' } })).toBeNull();
    expect(revisionConflictFrom(new Error('offline'))).toBeNull();
  });

  it('treats a missing endpoint as a blocker with its own message', () => {
    expect(isEndpointMissing({ status: 404 })).toBe(true);
    expect(isEndpointMissing({ status: 501 })).toBe(true);
    expect(isEndpointMissing({ status: 500 })).toBe(false);
    expect(describeError({ status: 404, message: 'no editor route' })).toBe('no editor route');
    expect(describeError({ status: 500, payload: { message: 'server exploded' } })).toBe('server exploded');
  });
});

describe('the development fixture is opt-in and cannot claim production', () => {
  it('is off without the explicit flag, and in a production build', () => {
    expect(fixtureModeFrom('http://localhost:3000/?p=Demo', { DEV: true })).toBeNull();
    expect(fixtureModeFrom('http://localhost:3000/?editorFixture=0', { DEV: true })).toBeNull();
    expect(fixtureModeFrom('http://localhost:3000/?editorFixture=1', { DEV: true })).toBe('on');
    expect(fixtureModeFrom('http://localhost:3000/?editorFixture=1', { PROD: true, DEV: true })).toBeNull();
    expect(fixtureModeFrom('not a url', { DEV: true })).toBeNull();
    // the suite itself does not run with the flag, so normal mode is the default
    expect(fixtureEnabled()).toBe(false);
  });

  it('counts revisions and refuses a save based on a stale revision', () => {
    resetFixture();
    const first = fixtureGet('Fixture_A', 'long');
    expect(first.document.revision).toBe(3);
    const saved = fixturePatch('Fixture_A', { targetId: 'long', baseRevision: 3, operations: [opUpdate('visualClips', 'vc_01', { durationSec: 10 })] });
    expect(saved.document.revision).toBe(4);
    expect(saved.undoAvailable).toBe(true);
    let thrown: unknown = null;
    try {
      fixturePatch('Fixture_A', { targetId: 'long', baseRevision: 3, operations: [] });
    } catch (error) {
      thrown = error;
    }
    expect(revisionConflictFrom(thrown)?.currentRevision).toBe(4);
    resetFixture();
  });

  it('reports an unavailable alignment runtime and an unrenderable preview as blockers', () => {
    resetFixture();
    const alignment = fixtureGet('Fixture_B', 'long');
    expect(alignment.capabilities.alignment?.available).toBe(false);
    const start = fixturePreviewStart(null);
    expect(start.status).toBe('unavailable');
    expect(start.blocker?.code).toBe('PREVIEW_RENDER_UNAVAILABLE');
    resetFixture();
  });

  it('exposes substitution switches that default to OFF', () => {
    resetFixture();
    const controls = fixtureControls();
    expect(controls.failNextSave).toBe(false);
    expect(controls.serverRevisionAhead).toBeNull();
    expect(controls.alignmentRuntime).toBe(false);
    expect(controls.previewSubstituteUrl).toBeNull();
    setFixtureControl('failNextSave', true);
    expect(fixtureControls().failNextSave).toBe(true);
    resetFixture();
  });
});
