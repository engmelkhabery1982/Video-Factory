/**
 * Form model for procedural-graphic shots. Pure: no fetch, no React.
 *
 * The builders, timing and validation rules live in core (packages/core/src/editor/graphic-builders.ts) so the
 * server derives the same graphics from supplied words. This module keeps the owner-facing form helpers and
 * re-exports the builders under their existing names.
 */
import {
  buildNumericGraphic,
  decimalsOf,
  exactValueLabel,
  GRAPHIC_ANIMATABLE,
  GRAPHIC_EASINGS,
  GRAPHIC_PROPERTIES,
  defaultGraphicActions,
  graphicProblems as coreGraphicProblems,
  type EditorGraphic,
  type GraphicEasing,
  type GraphicKind,
  type GraphicProperty,
  type GraphicPacing,
  type NumericFormInput,
  type ListFormInput,
} from '@buildtrack/core/visual';

export {
  buildKineticGraphic,
  buildNumericGraphic,
  buildProcessGraphic,
  decimalsOf,
  listIncomplete,
  numericIncomplete,
  GRAPHIC_PACINGS,
  GRAPHIC_PACING_LABELS,
  type GraphicFormat,
  type GraphicPacing,
} from '@buildtrack/core/visual';

export type NumericRowForm = NumericFormInput['rows'][number] & { objectId?: string };
export type NumericForm = Omit<NumericFormInput, 'rows'> & { rows: NumericRowForm[] };
export type ListForm = ListFormInput;

/** Default timing for a graphic at the given shot duration. measured reproduces the original defaults. */
export function defaultActions(graphic: EditorGraphic, durationSec: number, pacing: GraphicPacing = 'measured') {
  return defaultGraphicActions(graphic, durationSec, pacing);
}

/** Problems against the same rules the server applies. Empty = valid for this shot. */
export function graphicProblems(graphic: EditorGraphic, durationSec: number, format: 'landscape' | 'portrait', profile: 'religious' | 'educational' | 'promotional' | null): string[] {
  return coreGraphicProblems(graphic, durationSec, format, profile);
}

/** Animatable properties for a target object type, for the timed-actions editor. */
export function animatablePropertiesFor(graphic: EditorGraphic, targetId: string): GraphicProperty[] {
  const target = graphic.objects.find((o) => o.id === targetId);
  return target ? [...GRAPHIC_ANIMATABLE[target.type]] : [];
}

export const EASING_CHOICES: readonly GraphicEasing[] = GRAPHIC_EASINGS;
export const PROPERTY_CHOICES: readonly GraphicProperty[] = GRAPHIC_PROPERTIES;

/** Seed a numeric form from an existing graphic, so editing keeps the owner's values exactly. */
export function numericFormFrom(graphic: EditorGraphic): NumericForm {
  const bars = graphic.objects.filter((o) => o.type === 'bar');
  return {
    title: graphic.title ?? '',
    scaleMax: graphic.scaleMax === null ? '' : String(graphic.scaleMax),
    rows: bars.map((b) => ({
      objectId: b.id,
      label: b.label ?? '',
      value: b.value === undefined ? '' : exactValueLabel({ ...b, unit: undefined }),
      unit: b.unit ?? '',
    })),
  };
}

/** Numeric text edits must not rebuild the owner's positions, IDs, exact values, palette or supplied actions. */
export function buildNumericValues(form: NumericForm, format: 'landscape' | 'portrait', durationSec: number, previous: EditorGraphic | null): EditorGraphic {
  const existing = previous?.kind === 'numeric_comparison' ? previous : null;
  const built = buildNumericGraphic(form, format, durationSec, { direction: existing?.direction ?? 'ltr' });
  const ids = new Set(existing?.objects.map((o) => o.id) ?? []);
  const objects = form.rows.map((row, i) => {
    const original = existing?.objects.find((o) => o.id === row.objectId && o.type === 'bar');
    const next = { ...(original ?? built.objects[i]), label: row.label };
    if (!original) {
      let suffix = 1;
      while (ids.has(`bar${suffix}`)) suffix += 1;
      next.id = `bar${suffix}`; ids.add(next.id);
    }
    if (!original || row.value !== exactValueLabel({ ...original, unit: undefined })) {
      next.value = Number(row.value); next.decimals = decimalsOf(row.value);
    }
    if (!original || row.unit !== (original.unit ?? '')) {
      if (row.unit === '') delete next.unit; else next.unit = row.unit;
    }
    return next;
  });
  return { ...(existing ?? built), title: existing && form.title === (existing.title ?? '') ? existing.title : (form.title || null),
    scaleMax: Number(form.scaleMax), objects, actions: existing?.actions ?? built.actions };
}

/** Seed a list form from an existing kinetic or process graphic. */
export function listFormFrom(graphic: EditorGraphic): ListForm {
  const items = graphic.kind === 'kinetic_text'
    ? graphic.objects.filter((o) => o.type === 'word').map((o) => o.text ?? '')
    : graphic.objects.filter((o) => o.type === 'node').map((o) => o.label ?? '');
  return { title: graphic.title ?? '', items };
}

export function kindOfTechnique(technique: string | null | undefined): GraphicKind | null {
  return technique === 'process_path' || technique === 'numeric_comparison' || technique === 'actor_action' || technique === 'kinetic_text'
    ? technique
    : null;
}
