/**
 * Content-led rules. Fixtures are not the owner's recording and do not prove
 * that a sentence in that recording starts at 6.022s.
 */
import { describe, expect, it } from 'vitest';
import {
  boundLogoAsset,
  buildFaithfulExternalStoryboard,
  contentLedFindings,
  emptyHistory,
  footageBindingEligibility,
  inputSupportMatrix,
  isTruncatedDuplicate,
  longStaticQc,
  mediaPlaybackKind,
  omitPromotionalStructureFindings,
  planDerivedSample,
  playbackElementFor,
  resolveContentBrand,
  scenesFromSamplePlan,
  selectContiguousWindow,
  showBuiltInWordmark,
  treatmentSupport,
  type ProjectInput,
  type QcFinding,
  type Storyboard,
} from '@buildtrack/core';

function input(overrides: Partial<ProjectInput> = {}): ProjectInput {
  return {
    videoId: 'Derived_Sample',
    videoType: 'long',
    topic: 'fixture',
    targetAudience: '',
    mainProblem: '',
    viewerPromise: '',
    hook: '',
    script: 'تنظر إلى ما فقدت\n\nوتنسى ما أعطيت',
    keyNumbers: [],
    keyPoints: [],
    productName: '',
    productShots: [],
    cta: '',
    voiceoverFile: null,
    brollFiles: [],
    sourceReferences: [],
    outputLanguage: 'ar',
    brandPreset: 'buildtrack',
    shortCount: 0,
    narrationSource: 'external_ready',
    ...overrides,
  };
}

function finding(title: string): QcFinding {
  return { id: title, category: 'content', severity: 'critical', title, detail: 'fixture' };
}

describe('content profile does not inherit the failed template', () => {
  it('refuses BuildTrack for religious content and does not invent a logo', () => {
    const resolved = resolveContentBrand({ brandPreset: 'buildtrack', contentProfile: 'religious' });
    expect(resolved.brand.id).toBe('unbound-religious');
    expect(resolved.brand.logoAssetId).toBeNull();
    expect(resolved.identityBound).toBe(false);
    expect(resolved.refusedPreset).toBe('buildtrack');
    expect(resolved.brand.name).not.toMatch(/BuildTrack/);
  });

  it('does not fall back to BuildTrack for an unknown educational brand', () => {
    const resolved = resolveContentBrand({ brandPreset: 'missing-channel', contentProfile: 'educational' });
    expect(resolved.brand.id).not.toBe('buildtrack');
    expect(resolved.brand.logoAssetId).toBeNull();
  });

  it('binds a logo only by the selected brand id', () => {
    const assets = [
      { id: 'first-logo', kind: 'logo', status: 'active' },
      { id: 'brand-logo-buildtrack', kind: 'logo', status: 'active' },
    ];
    expect(boundLogoAsset(assets, { id: 'unbound-religious', logoAssetId: null })).toBeNull();
    expect(boundLogoAsset(assets, { id: 'buildtrack', logoAssetId: 'brand-logo-buildtrack' })?.id).toBe('brand-logo-buildtrack');
    expect(showBuiltInWordmark('buildtrack', 'religious', false)).toBe(false);
    expect(showBuiltInWordmark('buildtrack', null, false)).toBe(true);
  });

  it('keeps promotional hook and CTA gates, and drops them for imported narration', () => {
    const findings = [
      finding('Missing opening hook'),
      finding('CTA count is not exactly one'),
      finding('Product only appears at the end'),
      finding('Placeholder text left in the script'),
    ];
    expect(omitPromotionalStructureFindings(findings, 'external_ready').map((item) => item.title)).toEqual([
      'Placeholder text left in the script',
    ]);
    expect(omitPromotionalStructureFindings(findings, 'in_app_dialogue')).toHaveLength(4);
  });

  it('does not demand a hook, CTA, or product proof from a religious storyboard', () => {
    const built = buildFaithfulExternalStoryboard({
      input: input({ contentProfile: 'religious' }),
      history: emptyHistory(),
      audioDuration: 18,
    });
    const { historyEntry: _ignored, ...storyboard } = built;
    const titles = longStaticQc(storyboard).map((item) => item.title);
    expect(titles).not.toContain('Missing opening hook');
    expect(titles).not.toContain('CTA count is not exactly one');
    expect(titles).not.toContain('Product only appears at the end');
    expect(storyboard.brand.id).toBe('unbound-religious');
    expect(storyboard.long.scenes.every((scene) => scene.background !== 'blueprint')).toBe(true);
    expect(storyboard.long.scenes.every((scene) => scene.variant !== 'animated_checklist' && scene.variant !== 'process_flow')).toBe(true);
    expect(storyboard.long.scenes.every((scene) => scene.content.headline === '')).toBe(true);
    expect(storyboard.long.scenes.every((scene) => scene.role !== 'cta')).toBe(true);
    const led = contentLedFindings(storyboard);
    expect(led.some((item) => item.title === 'Owner visual not bound')).toBe(true);
    expect(led.some((item) => item.title === 'BuildTrack identity in religious content')).toBe(false);
  });

  it('still demands a hook when the storyboard is promotional', () => {
    const built = buildFaithfulExternalStoryboard({
      input: input(),
      history: emptyHistory(),
      audioDuration: 18,
    });
    const { historyEntry: _ignored, ...storyboard } = built;
    const promotional = { ...storyboard, contentProfile: undefined } as Storyboard;
    expect(longStaticQc(promotional).some((item) => item.title === 'Missing opening hook')).toBe(true);
  });

  it('flags a stale religious storyboard that still carries the failed template', () => {
    const built = buildFaithfulExternalStoryboard({
      input: input({ contentProfile: 'religious' }),
      history: emptyHistory(),
      audioDuration: 18,
    });
    const { historyEntry: _ignored, ...storyboard } = built;
    storyboard.brand = { ...storyboard.brand, id: 'buildtrack', logoAssetId: 'brand-logo-buildtrack', name: 'BuildTrack' };
    storyboard.long.scenes[0].background = 'blueprint';
    storyboard.long.scenes[0].variant = 'animated_checklist';
    storyboard.long.scenes[0].content.headline = 'تنظر';
    const titles = contentLedFindings(storyboard).map((item) => item.title);
    expect(titles).toContain('BuildTrack identity in religious content');
    expect(titles).toContain('Construction background in religious content');
    expect(titles).toContain('Template slide in religious content');
    expect(titles).toContain('Truncated headline duplicates narration');
    expect(isTruncatedDuplicate('تنظر', 'تنظر إلى ما فقدت')).toBe(true);
  });
});

describe('derived samples do not invent media or timing', () => {
  const fixture = [
    { id: 's1', text: 'تنظر إلى ما فقدت', start: 0, end: 6.022 },
    { id: 's2', text: 'وتنسى ما أعطيت', start: 6.022, end: 11.4 },
    { id: 's3', text: 'تظن أن ما ضاع', start: 11.4, end: 16.2 },
  ];

  it('copies approved interval edges and does not hard-code 6.022', () => {
    const planned = planDerivedSample({
      profile: 'religious',
      videoId: 'Rahman_Raheem_Test_01_sample',
      derivedFrom: 'Rahman_Raheem_Test_01',
      brandPreset: 'buildtrack',
      intervals: fixture,
    });
    expect(planned.wordsInserted).toBe(false);
    expect(planned.timingsRewritten).toBe(false);
    expect(planned.canRender).toBe(false);
    expect(planned.scenePlan.map((record) => record.audioStart)).toEqual([0, 6.022, 11.4]);
    expect(planned.scenePlan.map((record) => record.spokenText)).toEqual(fixture.map((item) => item.text));
    const other = planDerivedSample({
      profile: 'religious',
      videoId: 'other',
      intervals: [{ id: 'a', text: 'one', start: 1.25, end: 7.5 }, { id: 'b', text: 'two', start: 7.5, end: 14 }],
    });
    expect(other.scenePlan[1].audioStart).toBe(7.5);
    const { scenes, captions } = scenesFromSamplePlan(planned);
    expect(scenes.every((scene) => scene.background !== 'blueprint' && scene.variant === 'key_statement')).toBe(true);
    expect(captions[1].start).toBe(6.022);
    expect(captions[1].text).toBe('وتنسى ما أعطيت');
  });

  it('does not cut a sentence to force a 12-20s window', () => {
    const blocked = selectContiguousWindow([{ id: 'only', text: 'one line', start: 0, end: 4 }], 12, 20);
    expect(blocked.ok).toBe(false);
    const planned = planDerivedSample({
      profile: 'religious',
      videoId: 'too-short',
      intervals: [{ id: 'only', text: 'one line', start: 0, end: 4 }],
    });
    expect(planned.scenePlan).toEqual([]);
    expect(planned.missing.some((item) => item.id === 'approved-intervals')).toBe(true);
  });

  it('does not present a still as the Excel screen recording', () => {
    const planned = planDerivedSample({
      profile: 'educational',
      videoId: 'BuildTrack_T03_Excel_01_sample',
      brandPreset: 'buildtrack',
      action: 'Select the total.',
      intervals: [{ id: 'step', text: 'Select the total.', start: 0, end: 16, assetId: 'still' }],
      assets: [{ id: 'still', kind: 'image', mimeType: 'image/png', source: 'owner', license: 'owner', path: 'sheet.png' }],
    });
    expect(planned.canRender).toBe(false);
    expect(planned.scenePlan[0].sourceKind).toBe('missing');
    expect(planned.scenePlan[0].motion).toBe('still_not_footage');
    expect(planned.scenePlan[0].blockReason).toMatch(/still/i);
    const { scenes } = scenesFromSamplePlan(planned, { x: 0.2, y: 0.2, width: 0.2, height: 0.1 });
    expect(scenes[0].content.presentation).not.toBe('screen_recording');
    expect(scenes[0].content.mediaKind).not.toBe('video');
    expect(scenes[0].content.pointer).toBeNull();
  });

  it('plans playback only when the recording, the action, and the brand are bound', () => {
    const planned = planDerivedSample({
      profile: 'educational',
      videoId: 'BuildTrack_T03_Excel_01_sample',
      brandPreset: 'buildtrack',
      action: 'Select the total.',
      pointer: { x: 0.42, y: 0.33, width: 0.18, height: 0.08 },
      intervals: [{ id: 'step', text: 'Select the total.', start: 2, end: 18, assetId: 'excel' }],
      assets: [{
        id: 'excel',
        kind: 'video',
        mimeType: 'video/mp4',
        source: 'owner screen recording',
        license: 'owner',
        path: 'data/screen-recordings/BuildTrack_T03_Excel_01.mp4',
      }],
    });
    expect(planned.canRender).toBe(true);
    expect(planned.scenePlan[0].motion).toBe('timed_pointer');
    const { scenes } = scenesFromSamplePlan(planned, { x: 0.42, y: 0.33, width: 0.18, height: 0.08 });
    expect(scenes[0].content.mediaKind).toBe('video');
    expect(scenes[0].content.presentation).toBe('screen_recording');
    expect(scenes[0].content.pointer).toEqual({ x: 0.42, y: 0.33, width: 0.18, height: 0.08 });
    expect(scenes[0].narration).toBe('Select the total.');
    expect(playbackElementFor(mediaPlaybackKind(null, 'video/mp4'))).toBe('video');
    expect(footageBindingEligibility({ status: 'active', source: 'owner', license: 'owner', mimeType: 'image/png' }).eligible).toBe(false);
  });
});

describe('support matrix stays narrower than the wish list', () => {
  it('does not claim unimplemented treatments or still-as-video', () => {
    const treatments = new Map(treatmentSupport().map((item) => [item.id, item.status]));
    expect(treatments.get('short_human_situation')).toBe('not_implemented');
    expect(treatments.get('worked_example')).toBe('not_implemented');
    expect(treatments.get('question_to_answer')).toBe('not_implemented');
    const video = inputSupportMatrix().find((row) => row.input === 'Native video playback');
    expect(video?.detail).toMatch(/still pan is not playback/i);
    expect(inputSupportMatrix().find((row) => row.input === 'Storyboard import')?.status).toBe('unsupported');
    expect(inputSupportMatrix().find((row) => row.input === 'Video B-roll in an image slot')?.status).toBe('unsupported');
  });
});
