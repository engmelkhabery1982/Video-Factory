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

describe('negative: required inputs per entry path', () => {
  it('images without the reviewed script is blocked and says nothing is written for the owner', () => {
    const check = checkPlanForm(form({ inputMode: 'images', visualAssetIds: ['a1'], script: '   ' }));
    expect(check.ok).toBe(false);
    expect(check.errors).toEqual(['Paste the reviewed script that the pictures illustrate. Nothing is written for you.']);
  });

  it('images without any supplied picture is blocked with the exact missing item', () => {
    const check = checkPlanForm(form({ inputMode: 'images', script: ARABIC, visualAssetIds: [] }));
    expect(check.ok).toBe(false);
    expect(check.errors).toHaveLength(1);
    expect(check.errors[0]).toMatch(/Choose at least one supplied picture/);
  });

  it('images with neither script nor picture reports both missing items', () => {
    const check = checkPlanForm(form({ inputMode: 'images', script: '', visualAssetIds: [] }));
    expect(check.errors).toHaveLength(2);
  });

  it('video_narration reports each missing input separately (audio, script, footage)', () => {
    const check = checkPlanForm(form({ inputMode: 'video_narration', audioAssetId: null, script: '', visualAssetIds: [] }));
    expect(check.ok).toBe(false);
    expect(check.errors).toHaveLength(3);
    expect(check.errors[0]).toMatch(/ready narration audio/);
    expect(check.errors[1]).toMatch(/Paste the reviewed script/);
    expect(check.errors[2]).toMatch(/footage clip/);
  });

  it('video_narration never generates footage: the reason says so', () => {
    const check = checkPlanForm(form({ inputMode: 'video_narration', audioAssetId: 'n1', script: ARABIC, visualAssetIds: [] }));
    expect(check.errors).toEqual(['Choose at least one supplied footage clip from the library, or upload one. Footage is never generated.']);
  });

  it('audio_script without the spoken script is blocked (no transcription engine is assumed)', () => {
    const check = checkPlanForm(form({ inputMode: 'audio_script', audioAssetId: 'a9', script: '' }));
    expect(check.ok).toBe(false);
    expect(check.errors[0]).toMatch(/no transcription engine is configured/);
  });

  it('religious content with the BuildTrack identity is refused before any request', () => {
    const check = checkPlanForm(form({ profile: 'religious', identity: 'buildtrack', inputMode: 'brief', script: '' }));
    expect(check.ok).toBe(false);
    expect(check.errors[0]).toMatch(/BuildTrack identity cannot be used for religious content/);
  });

  it('a whitespace-only brief is refused: the brief names the video and is required', () => {
    const check = checkPlanForm(form({ brief: '   ', inputMode: 'brief', script: '' }));
    expect(check.ok).toBe(false);
    expect(check.errors[0]).toMatch(/one-line brief/);
  });

  it('storyboard mode with malformed JSON is refused with the parser error, not silently dropped', () => {
    const check = checkPlanForm(form({ inputMode: 'storyboard', storyboardText: '{ not json' }));
    expect(check.ok).toBe(false);
    expect(check.storyboard).toBeNull();
    expect(check.errors.length).toBeGreaterThan(0);
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
