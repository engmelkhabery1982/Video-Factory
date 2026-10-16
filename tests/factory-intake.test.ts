/**
 * Optional-input contract, pure planning. No I/O, no server.
 * Covers the input matrix, conflict handling, reference roles, silent timing and the review queue.
 * These are CODE tests of planFactoryDraft; they are not browser, render or owner-media evidence.
 */
import { describe, expect, it } from 'vitest';
import {
  completionQueueFor,
  FACTORY_SILENT_SCENE_SECONDS,
  planFactoryDraft,
  planSilentTiming,
  resolveNarrationMode,
  textSourcesAgree,
  type FactoryDraftCreateInput,
  type FactoryPlanOptions,
  type FactoryStoryboardV1,
} from '@buildtrack/core';

type Intake = NonNullable<FactoryDraftCreateInput['inputs']['intake']>;

function input(over: { script?: string | null; storyboard?: FactoryStoryboardV1 | null; audio?: boolean; visuals?: string[]; intake?: Partial<Intake>; brief?: string; profile?: FactoryDraftCreateInput['contentProfile'] } = {}): FactoryDraftCreateInput {
  return {
    contentProfile: over.profile ?? 'educational',
    format: 'landscape',
    channelBrandId: null,
    inputs: {
      brief: over.brief ?? '',
      script: over.script ?? null,
      audioAssetId: over.audio ? 'aud-1' : null,
      visualAssetIds: over.visuals ?? [],
      storyboard: over.storyboard ?? null,
      intake: {
        narrationMode: null, textAuthority: null, captions: true, visualRoles: {}, visualNotes: {}, transcriptJobId: null,
        ...(over.intake ?? {}),
      },
    },
    requestedSpeakers: [],
    referenceProjectId: null,
    visualLanguage: null,
  };
}

const OPTS: FactoryPlanOptions = {
  capabilities: { speechLanguages: { en: false, ar: false }, transcriptionAvailable: false, voiceIds: [] },
  libraryVisuals: [],
  suppliedVisualIds: [],
  audioPresent: false,
};
const plan = (i: FactoryDraftCreateInput, o: Partial<FactoryPlanOptions> = {}) =>
  planFactoryDraft(i, { ...OPTS, suppliedVisualIds: i.inputs.visualAssetIds, audioPresent: i.inputs.audioAssetId !== null, ...o });

const SCRIPT = 'First line of the reviewed script.\n\nSecond line of the reviewed script.';
const panel = (id: string, narration: string, assetId: string | null = null) => ({
  id, narration, speakerId: null, assetId, startSec: null, endSec: null, locked: false,
});

describe('narration mode resolution (legacy and explicit)', () => {
  it('legacy requests resolve by audio presence; explicit modes win', () => {
    expect(resolveNarrationMode(null, true)).toBe('supplied');
    expect(resolveNarrationMode(null, false)).toBe('generate');
    expect(resolveNarrationMode('none', true)).toBe('none');
    expect(resolveNarrationMode('generate', false)).toBe('generate');
  });
});

describe('input matrix: every combination is accepted and reported, never rejected for mixing', () => {
  it('idea only: blocked with a required script item and the exact action; nothing is guessed', () => {
    const r = plan(input({ brief: 'A topic' }));
    expect(r.status).toBe('blocked');
    expect(r.units).toEqual([]);
    expect(r.missing.map((m) => m.kind)).toEqual(['script']);
    expect(r.completion[0]).toMatchObject({ kind: 'script', required: true });
  });

  it('idea only with narration none: a material gap, not a script gap (silent video needs pictures or a storyboard)', () => {
    const r = plan(input({ brief: 'A topic', intake: { narrationMode: 'none' } }));
    expect(r.status).toBe('blocked');
    expect(r.missing.map((m) => m.kind)).toEqual(['material']);
  });

  it('script only: reviewed units, no conflict, legacy generate mode', () => {
    const r = plan(input({ script: SCRIPT }));
    expect(r.narrationMode).toBe('generate');
    expect(r.units.map((u) => u.narration)).toEqual(['First line of the reviewed script.', 'Second line of the reviewed script.']);
    expect(r.textConflict).toBeNull();
    expect(r.missing.some((m) => m.kind === 'script' || m.kind === 'conflict')).toBe(false);
  });

  it('audio only: blocked on the audio text (transcription), never presented as independent transcription', () => {
    const r = plan(input({ audio: true }));
    expect(r.narrationMode).toBe('supplied');
    expect(r.status).toBe('blocked');
    expect(r.missing).toEqual([expect.objectContaining({ kind: 'transcription' })]);
  });

  it('audio plus a reviewed transcript: the transcript text becomes the units; no transcription gap remains', () => {
    const r = plan(input({ audio: true, visuals: ['img-1'] }), {
      transcript: { jobId: 'trs_0123456789abcdef', text: 'Reviewed transcript line one.\n\nReviewed transcript line two.', stale: false },
    });
    expect(r.units.map((u) => u.narration)).toEqual(['Reviewed transcript line one.', 'Reviewed transcript line two.']);
    expect(r.missing.some((m) => m.kind === 'transcription')).toBe(false);
  });

  it('a stale transcript (made from other audio) is never used, and the gap comes back with a warning', () => {
    const r = plan(input({ audio: true, visuals: ['img-1'] }), {
      transcript: { jobId: 'trs_0123456789abcdef', text: 'Old words.', stale: true },
    });
    expect(r.units).toEqual([]);
    expect(r.missing.some((m) => m.kind === 'transcription')).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/different audio/);
  });

  it('images only, silent: one shot per picture in the supplied order, no speaker, no narration', () => {
    const r = plan(input({ visuals: ['img-b', 'img-a'], intake: { narrationMode: 'none' } }));
    expect(r.status).toBe('review_required');
    expect(r.units.map((u) => u.assetId)).toEqual(['img-b', 'img-a']);
    expect(r.units.every((u) => u.narration === '')).toBe(true);
    expect(r.speakers).toEqual([]);
    for (const t of r.treatments) expect(t.scenes.every((s) => s.speakerId === null)).toBe(true);
    expect(r.speechOrderLocked).toBe(true);
  });

  it('images only without narration none: blocked, with the reason to choose silent', () => {
    const r = plan(input({ visuals: ['img-a'] }));
    expect(r.status).toBe('blocked');
    expect(r.missing[0].reason).toMatch(/narration set to none/);
  });

  it('text storyboard with silent panels: panels keep order and pictures; a panel with no words is valid', () => {
    const sb: FactoryStoryboardV1 = { version: 1, scenes: [panel('s1', 'Panel one words.', 'img-a'), panel('s2', '', 'img-b')] };
    const r = plan(input({ storyboard: sb, visuals: ['img-a', 'img-b'], intake: { narrationMode: 'none' } }));
    expect(r.status).toBe('review_required');
    expect(r.units.map((u) => u.id)).toEqual(['s1', 's2']);
    expect(r.units[1].narration).toBe('');
    expect(r.units.map((u) => u.assetId)).toEqual(['img-a', 'img-b']);
  });

  it('a video with its own audio: supplied audio, no speech needed, and the attached clip is a shot', () => {
    const r = plan(input({ script: SCRIPT, audio: true, visuals: ['vid-1'] }), { libraryVisuals: [{ id: 'vid-1', kind: 'video' }] });
    expect(r.narrationMode).toBe('supplied');
    expect(r.missing.some((m) => m.kind === 'speech')).toBe(false);
    expect(r.units[0].assetId).toBe('vid-1');
  });

  it('a silent video with a clip and no audio: silent, with the clip as the shot', () => {
    const r = plan(input({ visuals: ['vid-1'], intake: { narrationMode: 'none' } }));
    expect(r.status).toBe('review_required');
    expect(r.units[0].assetId).toBe('vid-1');
  });

  it('mixed materials: script plus pictures plus narration generate, with speech gaps only where text exists', () => {
    const r = plan(input({ script: SCRIPT, visuals: ['img-a'] }));
    expect(r.units.length).toBe(2);
    expect(r.missing.every((m) => m.kind === 'speech')).toBe(true);
  });
});

describe('conflicts: owner chooses the authority; nothing is replaced silently', () => {
  const sb = (texts: string[]): FactoryStoryboardV1 => ({ version: 1, scenes: texts.map((t, i) => panel(`s${i + 1}`, t, `img-${i + 1}`)) });

  it('differing script and storyboard with no authority: blocked, both texts listed, no units', () => {
    const r = plan(input({ script: SCRIPT, storyboard: sb(['Other words.', 'More other words.']), visuals: ['img-1', 'img-2'] }));
    expect(r.status).toBe('blocked');
    expect(r.units).toEqual([]);
    expect(r.textConflict?.sources.map((x) => x.source).sort()).toEqual(['script', 'storyboard']);
    expect(r.missing[0].kind).toBe('conflict');
  });

  it('authority = storyboard: the storyboard panels are the units; the script is not used', () => {
    const r = plan(input({ script: SCRIPT, storyboard: sb(['Other words.', 'More other words.']), visuals: ['img-1', 'img-2'], intake: { textAuthority: 'storyboard' } }));
    expect(r.units.map((u) => u.narration)).toEqual(['Other words.', 'More other words.']);
    expect(r.units.map((u) => u.id)).toEqual(['s1', 's2']);
    expect(r.missing.some((m) => m.kind === 'conflict')).toBe(false);
  });

  it('authority = script with matching counts: the script words go to the panels by position, keeping their pictures and ids', () => {
    const r = plan(input({ script: SCRIPT, storyboard: sb(['Other words.', 'More other words.']), visuals: ['img-1', 'img-2'], intake: { textAuthority: 'script' } }));
    expect(r.units.map((u) => u.narration)).toEqual(['First line of the reviewed script.', 'Second line of the reviewed script.']);
    expect(r.units.map((u) => u.id)).toEqual(['s1', 's2']);
    expect(r.units.map((u) => u.assetId)).toEqual(['img-1', 'img-2']);
  });

  it('authority = script with mismatched counts: refused with a conflict; the panels are never dropped', () => {
    const r = plan(input({ script: SCRIPT, storyboard: sb(['Only one panel.']), visuals: ['img-1'], intake: { textAuthority: 'script' } }));
    expect(r.status).toBe('blocked');
    expect(r.units).toEqual([]);
    expect(r.missing[0].reason).toMatch(/one-to-one/);
  });

  it('an authority that is not supplied is refused, with the supplied choices listed (single source too)', () => {
    const r = plan(input({ script: SCRIPT, intake: { textAuthority: 'transcript' } }));
    expect(r.status).toBe('blocked');
    expect(r.units).toEqual([]);
    expect(r.missing[0]).toMatchObject({ kind: 'conflict' });
    expect(r.missing[0].reason).toMatch(/not supplied/);
  });

  it('same words with different spacing are not a conflict; panels without words are not compared', () => {
    const r = plan(input({ script: 'First  line of the reviewed script.\n\nSecond line of the reviewed script.', storyboard: { version: 1, scenes: [panel('s1', 'First line of the reviewed script.', 'img-1'), panel('s2', ''), panel('s3', 'Second line of the reviewed script.', 'img-2')] }, visuals: ['img-1', 'img-2'] }));
    expect(r.textConflict).toBeNull();
    expect(r.units.map((u) => u.id)).toEqual(['s1', 's2', 's3']);
  });

  it('Arabic diacritics are words: a change to a diacritic is a conflict', () => {
    expect(textSourcesAgree([{ source: 'script', units: ['كَتَبَ'] }, { source: 'storyboard', units: ['كَتَبَ'] }])).toBe(true);
    expect(textSourcesAgree([{ source: 'script', units: ['كَتَبَ'] }, { source: 'storyboard', units: ['كتب'] }])).toBe(false);
  });

  it('audio attached with narration none is a conflict, never a silent drop of the audio', () => {
    const r = plan(input({ script: SCRIPT, audio: true, intake: { narrationMode: 'none' } }));
    expect(r.status).toBe('blocked');
    expect(r.missing.some((m) => m.kind === 'conflict' && /Audio is attached/.test(m.reason))).toBe(true);
  });
});

describe('reference pictures are never shots', () => {
  it('a style reference is not used as a fallback shot and is reported as a reference', () => {
    const r = plan(input({ script: SCRIPT, visuals: ['ref-1', 'img-1'], intake: { visualRoles: { 'ref-1': 'style_reference' } } }), {
      libraryVisuals: [],
    });
    expect(r.units.every((u) => u.assetId !== 'ref-1')).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/reference picture/);
  });

  it('a storyboard panel that names a reference picture is refused as an asset gap', () => {
    const sb: FactoryStoryboardV1 = { version: 1, scenes: [panel('s1', 'Words.', 'ref-1')] };
    const r = plan(input({ storyboard: sb, visuals: ['ref-1'], intake: { visualRoles: { 'ref-1': 'character_reference' } } }));
    expect(r.status).toBe('blocked');
    expect(r.missing.some((m) => m.kind === 'asset' && m.sceneId === 's1')).toBe(true);
  });

  it('library pictures that fill unassigned scenes are reported as optional suggestions, not silently accepted', () => {
    const r = plan(input({ script: SCRIPT, visuals: [] }), { libraryVisuals: [{ id: 'lib-1', kind: 'image' }] });
    expect(r.completion.filter((c) => c.kind === 'library_picture').length).toBe(2);
    expect(r.completion.filter((c) => c.kind === 'library_picture').every((c) => c.required === false)).toBe(true);
  });
});

describe('silent timing: reviewed times or one labelled proposal; partial times refused', () => {
  it('no scene timed: every scene gets the labelled proposal, contiguous', () => {
    const t = planSilentTiming({ units: [{ id: 'a', narration: '', startSec: null, endSec: null }, { id: 'b', narration: '', startSec: null, endSec: null }] });
    expect(t.timingSource).toBe('visual_duration_proposal');
    expect(t.items.map((x) => [x.startSec, x.durationSec])).toEqual([[0, FACTORY_SILENT_SCENE_SECONDS], [FACTORY_SILENT_SCENE_SECONDS, FACTORY_SILENT_SCENE_SECONDS]]);
    expect(t.totalDurationSec).toBe(2 * FACTORY_SILENT_SCENE_SECONDS);
  });

  it('all scenes timed and contiguous: the reviewed times are kept as supplied', () => {
    const t = planSilentTiming({ units: [{ id: 'a', narration: '', startSec: 0, endSec: 3 }, { id: 'b', narration: '', startSec: 3, endSec: 7.5 }] });
    expect(t.timingSource).toBe('supplied');
    expect(t.totalDurationSec).toBe(7.5);
  });

  it('partly timed: refused, never completed by guessing', () => {
    expect(() => planSilentTiming({ units: [{ id: 'a', narration: '', startSec: 0, endSec: 3 }, { id: 'b', narration: '', startSec: null, endSec: null }] })).toThrow(/Some scenes have times/);
  });

  it('a gap between timed scenes is refused (contiguous timeline)', () => {
    expect(() => planSilentTiming({ units: [{ id: 'a', narration: '', startSec: 0, endSec: 3 }, { id: 'b', narration: '', startSec: 4, endSec: 6 }] })).toThrow(/contiguous/);
  });
});

describe('review queue: required gaps first, optional suggestions after, each with its action', () => {
  it('orders required before optional and never marks a suggestion as required', () => {
    const q = completionQueueFor(
      [{ kind: 'conflict', sceneId: null, reason: 'Choose.' }],
      [{ id: 'captions-off', kind: 'captions', sceneId: null, label: 'Captions are off.', action: 'Optional: turn them on.' }],
    );
    expect(q.map((x) => x.required)).toEqual([true, false]);
    expect(q[0].action).toMatch(/authority/);
  });
});

describe('web and core stay in step for the optional-input enums', () => {
  it('the web labels cover exactly the core roles and narration modes', async () => {
    const web = await import('../apps/web/src/lib/factory-api');
    const core = await import('@buildtrack/core');
    expect(Object.keys(web.FACTORY_VISUAL_ROLE_LABELS).sort()).toEqual([...core.FACTORY_VISUAL_ROLES].sort());
    expect(Object.keys(web.FACTORY_NARRATION_LABELS).sort()).toEqual([...core.FACTORY_NARRATION_MODES].sort());
  });
});
