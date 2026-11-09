/**
 * Entry-path rules for the content plan form (pure model, no DOM).
 * Negative cases: each required input missing must block with an actionable reason.
 * Positive cases: each mode sends exactly the inputs it owns; supplied words are preserved byte-for-byte.
 * Fixture text only; the Arabic line is a neutral greeting, not a quotation.
 */
import { describe, expect, it } from 'vitest';
import { buildCreateBody, checkPlanForm, EMPTY_PLAN_FORM, type PlanForm } from '../../apps/web/src/lib/factory-model';

const ARABIC = 'مَرْحَبًا بِكُمْ فِي الدَّرْسِ';

function form(patch: Partial<PlanForm>): PlanForm {
  return { ...EMPTY_PLAN_FORM, brief: 'A short explainer about cold storage.', ...patch };
}

describe('negative: the form refuses only what it cannot send; gaps come back from the server as an exact list', () => {
  it('no topic and no material is refused locally: nothing is guessed', () => {
    const check = checkPlanForm(form({ brief: '', inputMode: 'brief', script: '' }));
    expect(check.ok).toBe(false);
    expect(check.errors[0]).toMatch(/Write a topic, or add material/);
  });

  it('a whitespace-only brief with no material is refused with the same topic rule', () => {
    const check = checkPlanForm(form({ brief: '   ', inputMode: 'brief', script: '' }));
    expect(check.ok).toBe(false);
    expect(check.errors[0]).toMatch(/Write a topic, or add material/);
  });

  it('a whitespace-only brief with a picture is accepted: the picture is material, and the server reports what else is missing', () => {
    expect(checkPlanForm(form({ brief: '   ', inputMode: 'images', visualAssetIds: ['a1'] })).ok).toBe(true);
  });

  it('images without a script is accepted; the form sends no script and the server reports the exact gap', () => {
    const f = form({ inputMode: 'images', visualAssetIds: ['a1'], script: '   ' });
    expect(checkPlanForm(f).ok).toBe(true);
    expect(buildCreateBody(f, null).inputs.script).toBeNull();
  });

  it('images without a picture is accepted: the reviewed script is kept and the picture gap comes from the server', () => {
    const f = form({ inputMode: 'images', script: ARABIC, visualAssetIds: [] });
    expect(checkPlanForm(f).ok).toBe(true);
    expect(buildCreateBody(f, null).inputs).toMatchObject({ script: ARABIC, visualAssetIds: [] });
  });

  it('video with narration and footage but no audio is accepted; footage is never generated', () => {
    const f = form({ inputMode: 'video_narration', audioAssetId: null, script: ARABIC, visualAssetIds: ['clip-1'] });
    expect(checkPlanForm(f).ok).toBe(true);
    expect(buildCreateBody(f, null).inputs.visualAssetIds).toEqual(['clip-1']);
  });

  it('audio_script without the spoken script is accepted; no transcript text is invented', () => {
    const f = form({ inputMode: 'audio_script', audioAssetId: 'a9', script: '' });
    expect(checkPlanForm(f).ok).toBe(true);
    expect(buildCreateBody(f, null).inputs).toMatchObject({ audioAssetId: 'a9', script: null, transcriptJobId: null });
  });
});

describe('positive: each entry path sends exactly the inputs it owns', () => {
  it('brief-only route is accepted and drops any leftover script text from the body', () => {
    const f = form({ inputMode: 'brief', script: 'stale text the brief route must not send' });
    expect(checkPlanForm(f).ok).toBe(true);
    const body = buildCreateBody(f, null);
    expect(body.inputs.script).toBeNull();
    expect(body.inputs.audioAssetId).toBeNull();
    expect(body.inputs.brief).toBe('A short explainer about cold storage.');
  });

  it('images route preserves the supplied script verbatim, including Arabic diacritics', () => {
    const f = form({ inputMode: 'images', script: ARABIC, visualAssetIds: ['pic-1', 'pic-2'] });
    expect(checkPlanForm(f).ok).toBe(true);
    const body = buildCreateBody(f, null);
    expect(body.inputs.script).toBe(ARABIC);
    expect(body.inputs.visualAssetIds).toEqual(['pic-1', 'pic-2']);
    expect(body.inputs.audioAssetId).toBeNull();
    expect(body.inputs.storyboard).toBeNull();
  });

  it('video_narration sends the approved narration audio id, the script and footage ids', () => {
    const f = form({ inputMode: 'video_narration', audioAssetId: 'narr-1', script: ARABIC, visualAssetIds: ['clip-1'] });
    expect(checkPlanForm(f).ok).toBe(true);
    const body = buildCreateBody(f, null);
    expect(body.inputs.audioAssetId).toBe('narr-1');
    expect(body.inputs.script).toBe(ARABIC);
    expect(body.inputs.visualAssetIds).toEqual(['clip-1']);
  });

  it('no channel identity is sent unless BuildTrack is chosen for non-religious content', () => {
    expect(buildCreateBody(form({ identity: 'none' }), null).channelBrandId).toBeNull();
    expect(buildCreateBody(form({ identity: 'buildtrack', profile: 'educational' }), null).channelBrandId).toBe('buildtrack');
  });
});
