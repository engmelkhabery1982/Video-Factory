/** Explicit procedural actor authoring. UI defaults only; validation stays in core. */
import { GRAPHIC_SCHEMA_VERSION, type EditorGraphic, type GraphicObject } from '@buildtrack/core/visual';

/** Empty is deliberately invalid until the user adds at least one figure. No text or actions are invented. */
export function emptyActorGraphic(): EditorGraphic {
  return {
    schemaVersion: GRAPHIC_SCHEMA_VERSION, kind: 'actor_action', title: null,
    background: '#14202b', textColor: '#f2f5f7', accent: '#f2b84b', direction: 'ltr',
    scaleMax: null, objects: [], actions: [],
  };
}

/** IDs are not array indices: removing an object never renumbers a survivor or its action targets. */
export function newActorObject(graphic: EditorGraphic, type: 'figure' | 'box', reserved: Iterable<string> = []): GraphicObject {
  const ids = new Set([...reserved, ...graphic.objects.map((o) => o.id), ...graphic.actions.map((a) => a.targetId)]);
  let suffix = 1;
  while (ids.has(`${type}-${suffix}`)) suffix += 1;
  const base = { id: `${type}-${suffix}`, type, x: type === 'figure' ? 0.3 : 0.65, y: 0.6, scale: 1, opacity: 1 };
  return type === 'figure'
    ? { ...base, armAngle: 0 }
    : { ...base, w: 0.16, h: 0.12, rotation: 0, label: '' };
}

/** Refuse instead of deleting actions implicitly. The existing action controls let the user resolve references. */
export function actorRemovalProblem(graphic: EditorGraphic, id: string): string | null {
  const refs = graphic.actions.filter((a) => a.targetId === id).map((a) => a.id);
  return refs.length
    ? `Cannot remove ${id}: referenced by actions ${refs.join(', ')}. Remove or retarget those actions in Timed actions first.`
    : null;
}
