/**
 * Milestone 2 factory contract, pure core. No filesystem, no server.
 * Fixture narration only; passing these tests is not owner acceptance.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFactoryEditorDocument,
  buildTreatments,
  classifyUnit,
  visualDecisionFor,
  FactoryError,
  parseDraftCreate,
  parseDraftPatch,
  planFactoryTiming,
  reconcileSelection,
  splitNarrationUnits,
  type DeriveAssetRef,
  type FactoryDraftScene,
  type FactoryPlanUnit,
} from '@buildtrack/core';

const RELIGIOUS_SCRIPT = [
  'قال تعالى: "وَاعْتَصِمُوا بِحَبْلِ اللَّهِ جَمِيعًا وَلَا تَفَرَّقُوا".',
  'الاعتصام هنا جمع للقلوب على الخير وترك الفرقة.',
  'كيف نطبق ذلك في بيوتنا؟ بالتواضع والكلمة الطيبة.',
  'نسأل الله أن يؤلف بين قلوبنا.',
].join('\n');

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

describe('splitNarrationUnits', () => {
  it('keeps supplied words exact and splits at Latin and Arabic punctuation', () => {
    const units = splitNarrationUnits(RELIGIOUS_SCRIPT);
    expect(units).toHaveLength(5);
    expect(units[0]).toBe('قال تعالى: "وَاعْتَصِمُوا بِحَبْلِ اللَّهِ جَمِيعًا وَلَا تَفَرَّقُوا".');
    expect(units[2]).toBe('كيف نطبق ذلك في بيوتنا؟');
    expect(units[3]).toBe('بالتواضع والكلمة الطيبة.');
    expect(units[4]).toBe('نسأل الله أن يؤلف بين قلوبنا.');
  });

  it('drops blank lines and never rewrites the text', () => {
    expect(splitNarrationUnits('  One line.  \n\n  Another one! ')).toEqual(['One line.', 'Another one!']);
  });
});

describe('classifyUnit', () => {
  it('marks quoted or scripture-marked text as a passage for religious content', () => {
    expect(classifyUnit('religious', 'قال تعالى: "وَاعْتَصِمُوا"')).toBe('passage');
    expect(classifyUnit('religious', 'الاعتصام هنا جمع للقلوب.')).toBe('reflection');
  });

  it('separates problem, example, and action for educational content', () => {
    expect(classifyUnit('educational', 'Why does the pour keep failing?')).toBe('problem');
    expect(classifyUnit('educational', 'For example, the truck arrived late.')).toBe('example');
    expect(classifyUnit('educational', 'Check the delivery window the night before.')).toBe('action');
  });
});

describe('buildTreatments', () => {
  it('offers three treatments per profile that each keep every unit exactly once with its text unchanged', () => {
    for (const [profile, script] of [['religious', RELIGIOUS_SCRIPT], ['educational', EDU_SCRIPT]] as const) {
      const units = unitsOf(script);
      const treatments = buildTreatments(profile, units);
      expect(treatments).toHaveLength(3);
      for (const t of treatments) {
        expect(t.scenes.map((s) => s.sourceUnitId).sort()).toEqual(units.map((u) => u.id).sort());
        for (const s of t.scenes) {
          expect(s.narration).toBe(units.find((u) => u.id === s.sourceUnitId)?.narration);
        }
        expect(t.structure).toHaveLength(t.scenes.length);
      }
    }
  });

  it('changes narrative order, speaker roles, and visual intent between alternatives', () => {
    const treatments = buildTreatments('educational', unitsOf(EDU_SCRIPT));
    const orders = treatments.map((t) => t.scenes.map((s) => s.sourceUnitId).join(','));
    expect(new Set(orders).size).toBe(3);
    const speakerSets = treatments.map((t) => t.scenes.map((s) => s.speakerId).join(','));
    expect(new Set(speakerSets).size).toBe(3);
    const visuals = new Set(treatments.map((t) => t.scenes[0].visualIntent));
    expect(visuals.size).toBe(3);
  });

  it('gives educational treatments problem, example, and action beats, not headings', () => {
    const [problemFirst] = buildTreatments('educational', unitsOf(EDU_SCRIPT));
    expect(problemFirst.structure).toEqual(['problem', 'example', 'action', 'action']);
    expect(problemFirst.scenes[1].visualIntent).toMatch(/example/i);
  });

  it('separates religious reading structure from educational structure', () => {
    const rel = buildTreatments('religious', unitsOf(RELIGIOUS_SCRIPT))[0];
    const edu = buildTreatments('educational', unitsOf(EDU_SCRIPT))[0];
    expect(rel.structure).toContain('passage_reading');
    expect(rel.scenes.find((s) => s.beat === 'passage_reading')?.speakerId).toBe('reader');
    expect(edu.structure).not.toContain('passage_reading');
    expect(edu.scenes.some((s) => s.speakerId === 'learner')).toBe(true);
  });
});

describe('parseDraftCreate', () => {
  const base = {
    contentProfile: 'religious',
    format: 'landscape',
    channelBrandId: null,
    inputs: { brief: 'b', script: 'Hello there.', audioAssetId: null, visualAssetIds: [], storyboard: null },
    requestedSpeakers: [],
    referenceProjectId: null,
  };

  it('accepts a complete body', () => {
    expect(parseDraftCreate(base).contentProfile).toBe('religious');
  });

  it('rejects an unknown profile, format, and missing narration with FACTORY_VALIDATION', () => {
    expect(() => parseDraftCreate({ ...base, contentProfile: 'news' })).toThrow(FactoryError);
    expect(() => parseDraftCreate({ ...base, format: 'square' })).toThrow(FactoryError);
    // A brief alone is accepted: the planner returns a blocked draft that asks for reviewed text.
    const briefOnly = parseDraftCreate({ ...base, inputs: { ...base.inputs, script: null, audioAssetId: null } });
    expect(briefOnly.inputs.script).toBeNull();
    expect(briefOnly.inputs.brief).toBe(base.inputs.brief);
  });

  it('refuses an unsupported storyboard version with a stable code', () => {
    try {
      parseDraftCreate({ ...base, inputs: { ...base.inputs, script: null, storyboard: { version: 2, scenes: [] } } });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as FactoryError).code).toBe('FACTORY_STORYBOARD_VERSION_UNSUPPORTED');
      expect((e as FactoryError).status).toBe(422);
    }
  });
});

describe('parseDraftPatch', () => {
  it('rejects unknown scene fields so nothing unreviewed is stored', () => {
    expect(() => parseDraftPatch({
      expectedRevision: 0,
      selectedTreatmentId: 'x',
      scenes: [{ id: 'u01', narration: 'a', speakerId: null, visualIntent: '', assetId: null, startSec: null, endSec: null, locked: false, extra: 1 }],
      speakers: [],
    })).toThrow(/not a field of a factory scene/);
  });
});

describe('reconcileSelection', () => {
  const units = unitsOf(EDU_SCRIPT);
  const treatments = buildTreatments('educational', units);
  const proposals = Object.fromEntries(treatments.map((t) => [t.id, t.scenes]));
  const sourceNarration = new Map(units.map((u) => [u.id, u.narration]));
  const base = {
    currentTreatmentId: treatments[0].id,
    currentScenes: treatments[0].scenes,
    proposals,
    sourceNarration,
    assetAllowed: (id: string) => id === 'owner-image-1',
    speakerAllowed: () => true,
    incomingTreatmentId: treatments[0].id,
  };
  const asIncoming = (rows: FactoryDraftScene[]) => rows.map((r) => ({ ...r }));

  it('accepts a reorder of the same units and keeps narration exact', () => {
    const rows = asIncoming(treatments[0].scenes).reverse();
    const out = reconcileSelection({ ...base, incomingScenes: rows });
    expect(out.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(out[0].narration).toBe(units.find((u) => u.id === out[0].id)?.narration);
  });

  it('refuses edited narration, dropped units, and added narration', () => {
    const rows = asIncoming(treatments[0].scenes);
    expect(() => reconcileSelection({ ...base, incomingScenes: [{ ...rows[0], narration: 'Changed.' }, ...rows.slice(1)] })).toThrow(FactoryError);
    expect(() => reconcileSelection({ ...base, incomingScenes: rows.slice(1) })).toThrow(/every supplied unit/);
    expect(() => reconcileSelection({ ...base, incomingScenes: [...rows, { ...rows[0], id: 'new1', sourceUnitId: 'new1' }] })).toThrow(/is not a supplied unit/);
  });

  it('refuses an asset that is not an eligible library visual with FACTORY_ASSET_INVALID', () => {
    const rows = asIncoming(treatments[0].scenes);
    try {
      reconcileSelection({ ...base, incomingScenes: [{ ...rows[0], assetId: 'not-in-library' }, ...rows.slice(1)] });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as FactoryError).code).toBe('FACTORY_ASSET_INVALID');
      expect((e as FactoryError).status).toBe(422);
    }
  });

  it('keeps a locked row byte-for-byte and refuses any change to it with 423', () => {
    const locked = { ...treatments[0].scenes[0], locked: true };
    const current = [locked, ...treatments[0].scenes.slice(1).map((r) => ({ ...r }))];
    const same = reconcileSelection({ ...base, currentScenes: current, incomingScenes: asIncoming(current) });
    expect(JSON.stringify(same.find((r) => r.id === locked.id))).toBe(JSON.stringify(locked));
    const changed = asIncoming(current);
    changed[0] = { ...changed[0], visualIntent: 'Different intent' };
    try {
      reconcileSelection({ ...base, currentScenes: current, incomingScenes: changed });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as FactoryError).code).toBe('FACTORY_SCENE_LOCKED');
      expect((e as FactoryError).status).toBe(423);
    }
  });

  it('refuses a treatment switch while a locked row is in the selection', () => {
    const current = [{ ...treatments[0].scenes[0], locked: true }, ...treatments[0].scenes.slice(1)];
    try {
      reconcileSelection({
        ...base,
        currentScenes: current,
        incomingTreatmentId: treatments[1].id,
        incomingScenes: asIncoming(treatments[1].scenes),
      });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as FactoryError).status).toBe(423);
    }
  });
});

describe('planFactoryTiming', () => {
  const units = [
    { id: 'a', narration: 'One.', startSec: null, endSec: null },
    { id: 'b', narration: 'Two words here.', startSec: null, endSec: null },
  ];

  it('uses measured per-scene durations and labels them as synthesis, not alignment', () => {
    const plan = planFactoryTiming({ units, measuredDurationsSec: { a: 2, b: 3.5 }, totalDurationSec: null });
    expect(plan.timingSource).toBe('measured_synthesis');
    expect(plan.items).toEqual([{ id: 'a', startSec: 0, durationSec: 2 }, { id: 'b', startSec: 2, durationSec: 3.5 }]);
    expect(plan.totalDurationSec).toBe(5.5);
  });

  it('labels a text-length split of full audio as an estimate that covers the audio exactly', () => {
    const plan = planFactoryTiming({ units, measuredDurationsSec: null, totalDurationSec: 10 });
    expect(plan.timingSource).toBe('estimated_text_length');
    expect(plan.items.reduce((a, b) => a + b.durationSec, 0)).toBeCloseTo(10, 3);
  });

  it('keeps supplied times only when they are contiguous and cover the audio', () => {
    const supplied = [
      { id: 'a', narration: 'One.', startSec: 0, endSec: 4 },
      { id: 'b', narration: 'Two.', startSec: 4, endSec: 10 },
    ];
    expect(planFactoryTiming({ units: supplied, measuredDurationsSec: null, totalDurationSec: 10 }).timingSource).toBe('supplied');
    const gap = [supplied[0], { ...supplied[1], startSec: 5 }];
    expect(() => planFactoryTiming({ units: gap, measuredDurationsSec: null, totalDurationSec: 10 })).toThrow(/contiguous/);
    const short = [supplied[0], { ...supplied[1], endSec: 8 }];
    expect(() => planFactoryTiming({ units: short, measuredDurationsSec: null, totalDurationSec: 10 })).toThrow(/cover/);
  });
});

describe('buildFactoryEditorDocument', () => {
  const HOLD = { framing: 'full' as const, motion: 'none' as const, unexecuted: [] as string[] };
  const image: DeriveAssetRef = {
    id: 'owner-image-1', kind: 'image', name: 'Owner image', mediaUrl: '/media/asset/owner-image-1',
    durationSec: null, source: 'Owner fixture', license: 'Fixture', sha256: null,
  };

  it('maps reviewed scenes to a canonical document with exact captions and no alignment claim', () => {
    const doc = buildFactoryEditorDocument({
      projectId: 'Factory_test',
      contentProfile: 'educational',
      channelBrandId: null,
      format: 'landscape',
      scenes: [
        { id: 'u01', narration: 'Why does the pour fail?', language: 'en', speakerId: 'learner', locked: false, visual: image, visualDecision: HOLD, startSec: 0, durationSec: 3, audio: null },
        { id: 'u02', narration: 'مرحبا بكم', language: 'ar', speakerId: 'instructor', locked: true, visual: image, visualDecision: HOLD, startSec: 3, durationSec: 2, audio: null },
      ],
      fullAudio: null,
    });
    expect(doc.visualClips.map((c) => c.startSec)).toEqual([0, 3]);
    expect(doc.captions[1].text).toBe('مرحبا بكم');
    expect(doc.captions[1].direction).toBe('rtl');
    expect(doc.alignment.status).toBe('not_requested');
    expect(doc.visualClips[1].locked).toBe(true);
    expect(doc.durationSec).toBe(5);
  });

  it('refuses a video shorter than the scene instead of stretching it', () => {
    const video: DeriveAssetRef = { ...image, id: 'clip-1', kind: 'video', durationSec: 2 };
    expect(() => buildFactoryEditorDocument({
      projectId: 'Factory_test', contentProfile: 'promotional', channelBrandId: null, format: 'landscape',
      scenes: [{ id: 'u01', narration: 'Hi.', language: 'en', speakerId: null, locked: false, visual: video, visualDecision: { framing: 'full', motion: 'none', unexecuted: [] }, startSec: 0, durationSec: 5, audio: null }],
      fullAudio: null,
    })).toThrow(/shorter/);
  });
});

describe('review fix: order lock and visual decisions (core)', () => {
  const units: FactoryPlanUnit[] = [
    { id: 'u01', narration: 'Why does the pour fail?', language: 'en', speakerHint: null, assetId: 'img-a', assetOriginHint: 'supplied', startSec: null, endSec: null, locked: false },
    { id: 'u02', narration: 'For example, a pour was booked for seven and the truck came at nine.', language: 'en', speakerHint: null, assetId: 'img-a', assetOriginHint: 'supplied', startSec: null, endSec: null, locked: false },
    { id: 'u03', narration: 'Check the delivery window the night before.', language: 'en', speakerHint: null, assetId: 'img-a', assetOriginHint: 'supplied', startSec: null, endSec: null, locked: false },
  ];
  const kinds = new Map([['img-a', 'image' as const]]);

  it('keeps the supplied order in every treatment when the order is locked, and varies only visuals and labels', () => {
    const locked = buildTreatments('educational', units, { orderLocked: true, assetKinds: kinds });
    for (const t of locked) {
      expect(t.orderLocked).toBe(true);
      expect(t.scenes.map((s) => s.sourceUnitId)).toEqual(['u01', 'u02', 'u03']);
      expect(t.scenes.map((s) => s.narration)).toEqual(units.map((u) => u.narration));
    }
    const free = buildTreatments('educational', units, { orderLocked: false, assetKinds: kinds });
    expect(free.every((t) => t.orderLocked === false)).toBe(true);
    expect(free.some((t) => t.scenes.map((s) => s.sourceUnitId).join() !== 'u01,u02,u03')).toBe(true);
  });

  it('refuses footage motion and reports a screen recording on a still as a gap', () => {
    expect(visualDecisionFor({ intent: 'x', framing: 'full', motion: 'slow_push' }, 'video')).toEqual({
      framing: 'full',
      motion: 'none',
      unexecuted: [expect.stringMatching(/on footage/)],
    });
    const decision = visualDecisionFor({ intent: 'x', framing: 'tight', motion: 'none', needsFootage: true }, 'image');
    expect(decision.framing).toBe('tight');
    expect(decision.unexecuted.join(' ')).toMatch(/still image is shown, not a recording/);
  });

  it('refuses a reordered selection when the order is locked, and accepts the same order', () => {
    const treatments = buildTreatments('educational', units, { orderLocked: true, assetKinds: kinds });
    const proposals = Object.fromEntries(treatments.map((t) => [t.id, t.scenes]));
    const base = {
      currentTreatmentId: treatments[0].id,
      currentScenes: treatments[0].scenes,
      proposals,
      sourceNarration: new Map(units.map((u) => [u.id, u.narration])),
      assetAllowed: () => true,
      speakerAllowed: () => true,
      orderLocked: true,
      incomingTreatmentId: treatments[1].id,
    };
    const same = treatments[1].scenes.map((s) => ({ ...s }));
    expect(() => reconcileSelection({ ...base, incomingScenes: same })).not.toThrow();
    const reversed = [...same].reverse();
    expect(() => reconcileSelection({ ...base, incomingScenes: reversed })).toThrow(FactoryError);
  });
});
