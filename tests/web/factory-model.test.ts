import { describe, expect, it } from 'vitest';
import {
  applyBlockers,
  buildCreateBody,
  checkPlanForm,
  EMPTY_PLAN_FORM,
  errorView,
  identityOptionsFor,
  materialSummaryOf,
  moveScene,
  parseStoryboardText,
  speakerRowsFor,
  timingLabel,
  planningTimingLabel,
  TIMING_LABELS,
  voiceOptionsFor,
  type PlanForm,
} from '../../apps/web/src/lib/factory-model';
import { FactoryApiError } from '../../apps/web/src/lib/factory-api';
import { TIMING_LABEL_UNRECORDED, TIMING_SOURCE_LABELS } from '@buildtrack/core';
import { CAPS, envelopeOf, sceneOf } from './fixtures';

const form = (over: Partial<PlanForm> = {}): PlanForm => ({ ...EMPTY_PLAN_FORM, brief: 'Concrete windows', script: 'One. Two.', ...over });

describe('input modes', () => {
  it('accepts a brief with a reviewed script', () => {
    const c = checkPlanForm(form());
    expect(c.ok).toBe(true);
    expect(buildCreateBody(form(), null).inputs).toMatchObject({ brief: 'Concrete windows', script: 'One. Two.', audioAssetId: null, storyboard: null });
  });

  it('allows a brief alone: the server returns a blocked draft that asks for reviewed text', () => {
    const c = checkPlanForm(form({ inputMode: 'brief', script: '' }));
    expect(c.ok).toBe(true);
    expect(buildCreateBody(form({ inputMode: 'brief', script: '' }), null).inputs.script).toBeNull();
  });

  it('ready audio with no script is accepted by the form; the audio text gap is reported by the server, and no transcript is assumed', () => {
    const f = form({ inputMode: 'audio_script', script: '', audioAssetId: 'aud-1' });
    const c = checkPlanForm(f);
    expect(c.ok).toBe(true);
    expect(buildCreateBody(f, null).inputs).toMatchObject({ audioAssetId: 'aud-1', script: null, transcriptJobId: null });
  });

  it('sends audio with its script, and sends no storyboard in script mode', () => {
    const body = buildCreateBody(form({ inputMode: 'audio_script', audioAssetId: 'aud-1' }), null);
    expect(body.inputs.audioAssetId).toBe('aud-1');
    expect(body.inputs.script).toBe('One. Two.');
    expect(body.inputs.storyboard).toBeNull();
  });

  it('checks a storyboard for version and shape, and keeps the text when it is refused', () => {
    expect(parseStoryboardText('{"version":2,"scenes":[{}]}').ok).toBe(false);
    // Text that does not start with a brace is plain text (one panel per line); malformed JSON is still refused.
    expect(parseStoryboardText('{"version":1,').ok).toBe(false);
    expect(parseStoryboardText('not json').ok).toBe(true);
    expect(parseStoryboardText('{"version":1,"scenes":[]}').ok).toBe(false);
    const good = parseStoryboardText('{"version":1,"scenes":[{"id":"s1","narration":"Hi."}]}');
    expect(good.ok).toBe(true);
    const c = checkPlanForm(form({ inputMode: 'storyboard', storyboardText: '{"version":1,"scenes":[{"id":"s1","narration":"Hi."}]}' }));
    expect(c.ok).toBe(true);
    expect(c.storyboard?.scenes).toHaveLength(1);
  });
});

describe('channel identity', () => {
  it('never offers BuildTrack for religious content, as a selectable option', () => {
    const opts = identityOptionsFor('religious');
    const bt = opts.find((o) => o.value === 'buildtrack');
    expect(bt?.disabled).toBe(true);
    expect(bt?.reason).toMatch(/No fallback identity/);
  });

  it('refuses a religious BuildTrack request in the form before any request is sent', () => {
    const c = checkPlanForm(form({ profile: 'religious', identity: 'buildtrack' }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toMatch(/cannot be used for religious content/);
  });

  it('lets educational content choose an explicit identity or none', () => {
    const opts = identityOptionsFor('educational');
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });
});

describe('capability results per speaker and language', () => {
  it('offers only the reported voices for English and none for Arabic', () => {
    expect(voiceOptionsFor(CAPS, 'en').map((v) => v.id)).toEqual(['sam-reader', 'sam-narrator']);
    expect(voiceOptionsFor(CAPS, 'ar')).toEqual([]);
  });

  it('labels voices as robotic English samples and never as natural', () => {
    for (const v of CAPS.speech.voices) expect(v.speakerLabel).toMatch(/^Robotic English sample voice/);
  });

  it('says generation is unavailable for Arabic and points to imported audio', () => {
    const env = envelopeOf();
    const arabic = { ...env, treatments: env.treatments.map((t) => ({ ...t, scenes: t.scenes.map((s) => ({ ...s, language: 'ar' as const })) })) };
    const rows = speakerRowsFor(arabic, CAPS);
    const instructor = rows.find((r) => r.speakerId === 'instructor');
    expect(instructor?.status).toBe('unavailable');
    expect(instructor?.message).toMatch(/Generation unavailable for Arabic/);
    expect(instructor?.message).toMatch(/Import approved audio/);
  });

  it('describes a supplied recording as attribution only, with no voice generated', () => {
    const env = envelopeOf({ inputs: { audioAssetId: 'aud-1', audioDurationSec: 12, visualAssetIds: [], scriptSupplied: true, storyboardSupplied: false } });
    const rows = speakerRowsFor(env, CAPS);
    expect(rows.every((r) => r.status === 'audio_supplied')).toBe(true);
    expect(rows[0].message).toMatch(/no voice is generated/);
  });
});

describe('timing and material labels stay truthful', () => {
  it('never says aligned, and says estimated when the timing is an estimate', () => {
    const all = ['unknown', 'supplied', 'measured_synthesis', 'estimated_text_length'] as const;
    for (const t of all) expect(timingLabel(t)).not.toMatch(/aligned(?<! not audio-aligned)/i);
    expect(timingLabel('estimated_text_length')).toMatch(/Estimated/);
    // No source is decided before apply; the label says so and never claims a measurement.
    expect(timingLabel('unknown')).toBe(TIMING_LABELS.decidedAtApply);
    expect(timingLabel('unknown')).not.toMatch(/Unknown until apply measures it/);
  });

  it('uses the exact core labels, so the browser copy cannot drift from the server', () => {
    expect(TIMING_LABELS.estimated_text_length).toBe(TIMING_SOURCE_LABELS.estimated_text_length);
    expect(TIMING_LABELS.supplied).toBe(TIMING_SOURCE_LABELS.supplied);
    expect(TIMING_LABELS.measured_synthesis).toBe(TIMING_SOURCE_LABELS.measured_synthesis);
    expect(TIMING_LABELS.unrecorded).toBe(TIMING_LABEL_UNRECORDED);
    expect(timingLabel('supplied')).toBe('Supplied timing — not verified by an alignment engine.');
    expect(timingLabel('estimated_text_length')).toBe('Estimated timing — not audio-aligned.');
    expect(timingLabel('measured_synthesis')).toBe('Measured audio duration — not word alignment.');
  });

  it('prefers the server predicted label in the planning column', () => {
    expect(planningTimingLabel({ timingPlan: { label: 'Estimated timing — not audio-aligned.' } }, 'unknown')).toBe('Estimated timing — not audio-aligned.');
    expect(planningTimingLabel({}, 'unknown')).toBe(TIMING_LABELS.decidedAtApply);
  });

  it('counts supplied, library, reviewer and missing pictures and lists every unexecuted feature', () => {
    const env = envelopeOf();
    const mat = materialSummaryOf(env.treatments[1]);
    expect(mat.missing).toBe(1);
    expect(mat.gaps.map((g) => g.sceneId)).toEqual(['u02', 'u01']);
    expect(mat.gaps.some((g) => /screen recording/.test(g.text))).toBe(true);
  });
});

describe('scene order and apply', () => {
  it('moves rows only when the order is not locked and neither row is locked', () => {
    const rows = [sceneOf('a'), sceneOf('b'), sceneOf('c')];
    expect(moveScene(rows, 0, 1, true)).toBe(rows);
    expect(moveScene(rows, 0, 1, false).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    const locked = [sceneOf('a', { locked: true }), sceneOf('b')];
    expect(moveScene(locked, 0, 1, false)).toBe(locked);
  });

  it('blocks apply while edits are unsaved, while inputs are missing, and until the review is confirmed', () => {
    const env = envelopeOf();
    expect(applyBlockers(env, false, true)).toEqual([]);
    expect(applyBlockers(env, true, true).join(' ')).toMatch(/Save your selection first/);
    expect(applyBlockers(env, false, false).join(' ')).toMatch(/Confirm that you reviewed/);
    const missing = envelopeOf({ status: 'blocked', missing: [{ kind: 'image', sceneId: 'u01', reason: 'none' }] });
    expect(applyBlockers(missing, false, true).join(' ')).toMatch(/required item/);
  });
});

describe('error presentation', () => {
  it('a transport failure never claims completion', () => {
    const v = errorView(new FactoryApiError({ message: 'x', status: null, code: 'TRANSPORT', answered: false }));
    expect(v.completionConfirmed).toBe(false);
    expect(v.next).toBe('reload');
    expect(v.detail).toMatch(/No completion is confirmed/);
  });

  it('maps conflicts, locks, refused identity and inputs to distinct actions', () => {
    expect(errorView(new FactoryApiError({ message: 'm', status: 409, code: 'FACTORY_REVISION_CONFLICT', answered: true, currentRevision: 5 })).detail).toMatch(/revision 5/);
    expect(errorView(new FactoryApiError({ message: 'm', status: 423, code: 'FACTORY_SCENE_LOCKED', answered: true })).title).toMatch(/locked/);
    expect(errorView(new FactoryApiError({ message: 'm', status: 422, code: 'FACTORY_IDENTITY_REFUSED', answered: true })).next).toBe('fix_input');
    const inputs = errorView(new FactoryApiError({ message: 'm', status: 422, code: 'FACTORY_INPUTS_REQUIRED', answered: true, missing: [{ kind: 'image', sceneId: 'u01', reason: 'none' }] }));
    expect(inputs.missing).toHaveLength(1);
  });
});
