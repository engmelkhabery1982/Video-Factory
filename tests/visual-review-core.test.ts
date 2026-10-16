/**
 * Pure rules for local picture understanding: the strict observation parse, the review refusals and the reference clause.
 * Fixture-level unit evidence only. No model, no provider, no network.
 */
import { describe, expect, it } from 'vitest';
import {
  observationVisualText,
  parseVisionObservation,
  referenceClauseOf,
  reviewRefusals,
  VISION_LIMITS,
  type VisionObservation,
} from '../packages/core/src/factory/visual-review.js';

const OBS: VisionObservation = {
  subject: 'a brass desk lamp', environment: 'a wooden table', lighting: 'soft window light', composition: 'centred object',
  shot: 'close-up', exclude: 'people', containsText: false, containsLogoOrBrand: false, containsPeople: false, uncertainties: ['base partly hidden'],
};
const json = (o: unknown) => JSON.stringify(o);

describe('parseVisionObservation (strict)', () => {
  it('accepts the exact shape and returns only the known fields', () => {
    const r = parseVisionObservation(json(OBS));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(Object.keys(OBS).sort());
  });

  it('refuses text that is not one JSON object, including prose around the JSON', () => {
    expect(parseVisionObservation('Sure! ' + json(OBS)).ok).toBe(false);
    expect(parseVisionObservation('[' + json(OBS) + ']').ok).toBe(false);
    expect(parseVisionObservation('null').ok).toBe(false);
    expect(parseVisionObservation('').ok).toBe(false);
  });

  it('refuses an unexpected field rather than ignoring it', () => {
    const r = parseVisionObservation(json({ ...OBS, extra: 'x' }));
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/Unexpected field "extra"/);
  });

  it('refuses a boolean given as text, and a text field given as a number', () => {
    expect(parseVisionObservation(json({ ...OBS, containsText: 'no' })).ok).toBe(false);
    expect(parseVisionObservation(json({ ...OBS, subject: 42 })).ok).toBe(false);
  });

  it('refuses an empty subject, and a field longer than the limit', () => {
    expect(parseVisionObservation(json({ ...OBS, subject: '   ' })).ok).toBe(false);
    expect(parseVisionObservation(json({ ...OBS, environment: 'x'.repeat(VISION_LIMITS.textField + 1) })).ok).toBe(false);
  });

  it('refuses more uncertainties than the limit, and an over-long uncertainty', () => {
    expect(parseVisionObservation(json({ ...OBS, uncertainties: Array(VISION_LIMITS.uncertainties + 1).fill('x') })).ok).toBe(false);
    expect(parseVisionObservation(json({ ...OBS, uncertainties: ['x'.repeat(VISION_LIMITS.uncertaintyLength + 1)] })).ok).toBe(false);
  });

  it('collapses whitespace in text fields and drops empty uncertainties', () => {
    const r = parseVisionObservation(json({ ...OBS, subject: '  a   brass\n lamp ', uncertainties: ['  ', 'ok'] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.subject).toBe('a brass lamp');
      expect(r.value.uncertainties).toEqual(['ok']);
    }
  });
});

describe('observationVisualText and reviewRefusals', () => {
  it('a labelled description from an observation is accepted for an educational still', () => {
    expect(reviewRefusals(observationVisualText(OBS), 'educational', { containsText: false, containsLogoOrBrand: false })).toEqual([]);
  });

  it('a description without labels is refused, whatever the profile', () => {
    const r = reviewRefusals('just a lamp on a table', 'educational', null);
    expect(r.length).toBeGreaterThan(0);
    expect(r.join(' ')).toMatch(/labelled parts/);
  });

  it('religious: a brand or lettering word in the reviewed text is refused', () => {
    const brand = observationVisualText({ ...OBS, subject: 'a cup with a brand mark' });
    expect(reviewRefusals(brand, 'religious', { containsText: false, containsLogoOrBrand: false }).join(' ')).toMatch(/brand|branding|logo/i);
    const lettering = observationVisualText({ ...OBS, subject: 'an open book with lettering' });
    expect(reviewRefusals(lettering, 'religious', { containsText: false, containsLogoOrBrand: false }).join(' ')).toMatch(/lettering|text|word/i);
  });

  it('religious: a picture flagged for lettering or a logo is refused even when the text is clean', () => {
    const clean = observationVisualText(OBS);
    expect(reviewRefusals(clean, 'religious', { containsText: true, containsLogoOrBrand: false }).join(' ')).toMatch(/lettering or a brand/);
    expect(reviewRefusals(clean, 'religious', { containsText: false, containsLogoOrBrand: true }).join(' ')).toMatch(/lettering or a brand/);
  });

  it('educational: the same flagged picture is not refused by the religious rule', () => {
    expect(reviewRefusals(observationVisualText(OBS), 'educational', { containsText: true, containsLogoOrBrand: true })).toEqual([]);
  });

  it('an over-long reviewed text is refused', () => {
    const long = observationVisualText({ ...OBS, subject: 'a'.repeat(VISION_LIMITS.textField) }) + ' '.repeat(VISION_LIMITS.reviewedText);
    expect(reviewRefusals(long, 'educational', null).join(' ')).toMatch(/longer than 600/);
  });
});

describe('referenceClauseOf', () => {
  it('uses subject, environment and lighting only, in a labelled-free clause', () => {
    const c = referenceClauseOf([observationVisualText(OBS)]);
    expect(c.startsWith('reference (reviewed): ')).toBe(true);
    expect(c).toContain('a brass desk lamp');
    expect(c).toContain('soft window light');
    expect(c).not.toContain('centred object');
    expect(c).not.toContain('Exclude');
  });

  it('is empty when there is nothing to add', () => {
    expect(referenceClauseOf([])).toBe('');
  });

  it('is capped at 200 characters however many references are given', () => {
    const many = Array.from({ length: 20 }, (_, i) => observationVisualText({ ...OBS, subject: `subject number ${i} with a long description` }));
    expect(referenceClauseOf(many).length).toBeLessThanOrEqual(200);
  });
});
