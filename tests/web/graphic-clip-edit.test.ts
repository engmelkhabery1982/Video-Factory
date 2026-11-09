/**
 * Pure transitions for one clip's technique and graphic values (apps/web/src/lib/graphic-clip-edit.ts).
 * These decide what the inspector stages. Fixture data only; not browser acceptance.
 */
import { describe, expect, it } from 'vitest';
import { planGraphicValues, planTechniqueChange } from '../../apps/web/src/lib/graphic-clip-edit';
import { buildKineticGraphic, buildNumericGraphic } from '../../apps/web/src/lib/graphic-form';

const media = { technique: null, graphic: null, sourceAssetId: 'img-1' };
const restore = { sourceAssetId: 'img-1', sourceInSec: null, sourceOutSec: null };
const numeric = buildNumericGraphic(
  { title: 'Hours', scaleMax: '10', rows: [{ label: 'Before', value: '7', unit: 'h' }, { label: 'After', value: '9.5', unit: 'h' }] },
  'landscape',
  6,
);

describe('planTechniqueChange', () => {
  it('a media technique on a picture stages one update with no graphic', () => {
    expect(planTechniqueChange(media, 'still_image', null)).toEqual({ status: 'stage', changes: { technique: 'still_image', graphic: null } });
  });

  it('a graphic technique without values is pending, never staged', () => {
    const plan = planTechniqueChange(media, 'numeric_comparison', null);
    expect(plan.status).toBe('pending');
    expect(plan.status === 'pending' && plan.reason).toMatch(/Enter the values/);
  });

  it('switching kind on a graphic clip is pending until the new values are complete', () => {
    const clip = { technique: 'numeric_comparison', graphic: numeric, sourceAssetId: null };
    expect(planTechniqueChange(clip, 'kinetic_text', null).status).toBe('pending');
    expect(planTechniqueChange(clip, 'numeric_comparison', null)).toEqual({ status: 'stage', changes: { technique: 'numeric_comparison' } });
  });

  it('going back to media on a graphic clip restores the remembered picture in the same update', () => {
    const clip = { technique: 'numeric_comparison', graphic: numeric, sourceAssetId: null };
    expect(planTechniqueChange(clip, 'still_image', restore)).toEqual({
      status: 'stage',
      changes: { technique: 'still_image', graphic: null, sourceAssetId: 'img-1', sourceInSec: null, sourceOutSec: null },
    });
  });

  it('a media technique with no picture anywhere is refused with the reason, never staged', () => {
    const plan = planTechniqueChange({ technique: null, graphic: null, sourceAssetId: null }, 'still_image', null);
    expect(plan.status).toBe('refused');
  });

  it('clearing the technique on a graphic clip with no remembered picture is refused', () => {
    const clip = { technique: 'numeric_comparison', graphic: numeric, sourceAssetId: null };
    expect(planTechniqueChange(clip, null, null).status).toBe('refused');
    expect(planTechniqueChange(clip, null, restore)).toEqual({
      status: 'stage',
      changes: { technique: null, graphic: null, sourceAssetId: 'img-1', sourceInSec: null, sourceOutSec: null },
    });
  });

  it('an unknown technique is refused', () => {
    expect(planTechniqueChange(media, 'hologram' as never, null).status).toBe('refused');
  });
});

describe('planGraphicValues', () => {
  it('incomplete values (null) are pending and never a stage', () => {
    expect(planGraphicValues('numeric_comparison', null).status).toBe('pending');
  });

  it('complete values stage the graphic and clear the picture source in the same update', () => {
    expect(planGraphicValues('numeric_comparison', numeric)).toEqual({
      status: 'stage',
      changes: { technique: 'numeric_comparison', graphic: numeric, sourceAssetId: null, sourceInSec: null, sourceOutSec: null },
    });
  });

  it('values of the wrong kind are refused', () => {
    const kinetic = buildKineticGraphic({ title: '', items: ['One', 'Two'] }, 'landscape', 6);
    expect(planGraphicValues('numeric_comparison', kinetic).status).toBe('refused');
  });
});
