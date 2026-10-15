/**
 * Still-prompt composition, pure (no server, no model).
 *
 * Shows: the labelled visual description is validated; the positive prompt carries the subject and an
 * aspect-correct framing token; per-shot exclusions reach only their own shot's negative prompt (there
 * is no global ban on people); religious content never names BuildTrack and refuses lettering and
 * scripture in the picture; the two prompt pairs for visual acceptance differ in content.
 *
 * Code and fixture evidence only. These prompts are not generated images and not visual acceptance.
 */
import { describe, expect, it } from 'vitest';
import { composeStillPrompt, parseVisualDescription, validateVisualDescription } from '../packages/core/src/factory/still-prompt.js';
import { validateGeneratedPlan } from '../packages/core/src/factory/gemini-contract.js';
import { educationalCtx, fixtureEducationalPlan } from './gemini/helpers.js';

const RELIGIOUS_WARM_ROOM =
  'Subject: a closed plain leather book and a brass oil lamp on a low table; ' +
  'Environment: an empty warm room, plain white walls, a woven rug; ' +
  'Lighting: soft warm lamp light from the left; ' +
  'Composition: book and lamp on the right third, empty wall on the left; ' +
  'Shot: still life; ' +
  'Exclude: people, text';

const EDUCATIONAL_ILLUSTRATION =
  'Subject: a delivery truck beside a stack of three cardboard boxes, a green tick floating above them; ' +
  'Environment: a plain warm-grey site yard with a gravel edge; ' +
  'Lighting: flat even daylight, no hard shadows; ' +
  'Composition: truck on the left, boxes on the right, empty sky across the top; ' +
  'Shot: wide; ' +
  'Exclude: none';

describe('visual description: labelled form is required', () => {
  it('a complete labelled description has no validation errors', () => {
    expect(validateVisualDescription(RELIGIOUS_WARM_ROOM)).toEqual([]);
    expect(validateVisualDescription(EDUCATIONAL_ILLUSTRATION)).toEqual([]);
  });

  it('vague prose is refused: it has no labelled parts', () => {
    const errors = validateVisualDescription('A nice picture of a peaceful room with good light.');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/labelled parts/);
  });

  it('a one-word part such as "Lighting: good" is refused, but a one-word shot name is accepted', () => {
    const vague = RELIGIOUS_WARM_ROOM.replace('Lighting: soft warm lamp light from the left', 'Lighting: good');
    expect(validateVisualDescription(vague).some((e) => /Lighting/.test(e))).toBe(true);
    expect(validateVisualDescription(EDUCATIONAL_ILLUSTRATION.replace('Shot: wide', 'Shot: close-up'))).toEqual([]);
  });

  it('a missing required part is named', () => {
    const noLight = RELIGIOUS_WARM_ROOM.replace(/Lighting:[^;]*; /, '');
    expect(validateVisualDescription(noLight).join(' ')).toMatch(/Lighting/);
  });

  it('parts are parsed in order and Exclude is optional', () => {
    const p = parseVisualDescription(EDUCATIONAL_ILLUSTRATION);
    expect(p.structured).toBe(true);
    expect(p.subject).toMatch(/delivery truck/);
    expect(p.shot).toBe('wide');
    expect(p.exclude).toBe('none');
  });
});

describe('composeStillPrompt: aspect, exclusions, religious safeguards', () => {
  it('uses the framing token for the frame aspect, and only that one', () => {
    const land = composeStillPrompt({ visual: EDUCATIONAL_ILLUSTRATION, profile: 'educational', aspect: 'landscape' });
    const port = composeStillPrompt({ visual: EDUCATIONAL_ILLUSTRATION, profile: 'educational', aspect: 'portrait' });
    expect(land.prompt).toMatch(/16:9 frame/);
    expect(land.prompt).not.toMatch(/9:16 frame/);
    expect(port.prompt).toMatch(/9:16 frame/);
    expect(port.prompt).not.toMatch(/16:9 frame/);
  });

  it('per-shot exclusions reach that shot only: no global people ban', () => {
    const withPeopleExcluded = composeStillPrompt({ visual: RELIGIOUS_WARM_ROOM, profile: 'religious', aspect: 'landscape' });
    const noExclusion = composeStillPrompt({ visual: EDUCATIONAL_ILLUSTRATION, profile: 'educational', aspect: 'landscape' });
    expect(withPeopleExcluded.negativePrompt).toMatch(/people/);
    expect(noExclusion.negativePrompt).not.toMatch(/people/);
    expect(noExclusion.prompt).not.toMatch(/\bpeople\b/i);
  });

  it('religious content never names BuildTrack, in the prompt or the negative', () => {
    const r = composeStillPrompt({ visual: RELIGIOUS_WARM_ROOM, profile: 'religious', aspect: 'landscape' });
    expect(r.prompt).not.toMatch(/buildtrack/i);
    expect(r.negativePrompt).not.toMatch(/buildtrack/i);
    expect(r.negativePrompt).toMatch(/scripture/);
    expect(r.negativePrompt).toMatch(/arabic script/i);
  });

  it('an educational still keeps the base text negatives but not the religious list', () => {
    const e = composeStillPrompt({ visual: EDUCATIONAL_ILLUSTRATION, profile: 'educational', aspect: 'landscape' });
    expect(e.negativePrompt).toMatch(/watermark/);
    expect(e.negativePrompt).not.toMatch(/scripture/);
  });
});

describe('two materially different concrete prompt pairs (visual acceptance inputs)', () => {
  const religious = composeStillPrompt({ visual: RELIGIOUS_WARM_ROOM, profile: 'religious', aspect: 'landscape' });
  const educational = composeStillPrompt({ visual: EDUCATIONAL_ILLUSTRATION, profile: 'educational', aspect: 'landscape' });

  it('the religious still-life prompt is concrete: subject, room, light and composition are all present', () => {
    expect(religious.prompt).toMatch(/closed plain leather book/);
    expect(religious.prompt).toMatch(/empty warm room/);
    expect(religious.prompt).toMatch(/soft warm lamp light/);
    // Under the SD 1.x token budget, so no truncation warning.
    expect(religious.warnings).toEqual([]);
    expect(religious.prompt).toMatch(/right third/);
    expect(religious.prompt).toMatch(/quiet, reverent, realistic photograph/);
  });

  it('the educational illustration prompt is concrete and in its own style', () => {
    expect(educational.prompt).toMatch(/delivery truck/);
    expect(educational.prompt).toMatch(/clean editorial illustration/);
    expect(educational.prompt).not.toMatch(/reverent/);
  });

  it('the two prompts share no template: their subjects, rooms and styles differ', () => {
    expect(religious.prompt.slice(0, 40)).not.toBe(educational.prompt.slice(0, 40));
    expect(religious.prompt).not.toMatch(/delivery truck/);
    expect(educational.prompt).not.toMatch(/leather book/);
  });
});

/**
 * The plan boundary: a generated plan whose religious shot asks for a brand, lettering or scripture is refused
 * when the plan is validated, before any draft is created. The same plan with a plain still passes this check.
 */
describe('religious plan boundary: validateGeneratedPlan refuses branding, lettering and scripture in shot descriptions', () => {
  const religiousCtx = educationalCtx({ profile: 'religious' });
  const withS1 = (visualRequirement: string) => {
    const plan = fixtureEducationalPlan() as any;
    plan.treatments[0].scenes[0].visualRequirement = visualRequirement;
    return plan;
  };
  const refusalsOf = (errors: string[]) => errors.filter((e) => /religious still/.test(e));

  it('a BuildTrack logo request in a religious plan is refused, and the error names the term and the scene', () => {
    const r = validateGeneratedPlan(withS1(
      'Subject: a closed plain leather book with a BuildTrack logo on the cover; Environment: an empty warm room; Lighting: soft warm light; Composition: book on the right third; Shot: still life; Exclude: people'
    ), religiousCtx);
    expect(r.ok).toBe(false);
    const refusals = refusalsOf(r.errors);
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.join(' ')).toMatch(/"BuildTrack"/);
    expect(r.errors.join(' ')).toMatch(/treatment 0 scene 0/);
  });

  it('a request for text on the pages (scripture-like lettering) in a religious plan is refused', () => {
    const r = validateGeneratedPlan(withS1(
      'Subject: an open book with a Quran verse printed on the pages; Environment: an empty warm room; Lighting: soft warm light; Composition: book on the right third; Shot: still life'
    ), religiousCtx);
    expect(r.ok).toBe(false);
    expect(refusalsOf(r.errors).join(' ')).toMatch(/scripture|lettering|verse|Quran/i);
  });

  it('a plain closed book with a negated lettering request raises no religious refusal', () => {
    const r = validateGeneratedPlan(withS1(
      'Subject: a closed plain leather book on a low table; Environment: an empty warm room with a window; Lighting: soft warm light; Composition: book on the right third; Shot: still life; Exclude: text, logo'
    ), religiousCtx);
    expect(refusalsOf(r.errors)).toEqual([]);
  });

  it('the same brand request is not refused by the educational profile (identity rules are religious-only)', () => {
    const r = validateGeneratedPlan(withS1(
      'Subject: a closed plain leather book with a BuildTrack logo on the cover; Environment: an empty warm room; Lighting: soft warm light; Composition: book on the right third; Shot: still life'
    ), educationalCtx());
    expect(refusalsOf(r.errors)).toEqual([]);
  });
});
