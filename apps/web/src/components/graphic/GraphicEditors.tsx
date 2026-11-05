import React, { useState } from 'react';
import type { EditorGraphic, GraphicAction } from '@buildtrack/core/visual';
import { GRAPHIC_PROPERTY_RANGE, graphicStateAt, VISUAL_LANGUAGES, VISUAL_TECHNIQUES, type VisualTechniqueId } from '@buildtrack/core/visual';
import {
  EASING_CHOICES,
  animatablePropertiesFor,
  buildKineticGraphic,
  buildNumericValues,
  buildProcessValues,
  defaultActions,
  graphicProblems,
  kindOfTechnique,
  listFormFrom,
  listIncomplete,
  numericFormFrom,
  numericIncomplete,
  type GraphicFormat,
  type ListForm,
  type NumericForm,
} from '../../lib/graphic-form';

import { actorRemovalProblem, emptyActorGraphic, newActorObject } from '../../lib/actor-form';
import { actorBoxLabelTooSmall } from '../../../../../packages/video/src/graphics/actorBoxLabelLayout';
import { numericLabelWarnings } from '../../../../../packages/video/src/graphics/numericLabelLayout';
import { processLabelWarnings } from '../../../../../packages/video/src/graphics/processLabelLayout';

export type GraphicProfileName = 'religious' | 'educational' | 'promotional' | null;

/** Technique choices for a language. With no language set, every registered technique is offered (legacy behaviour). */
export function techniqueChoices(language: string | null | undefined): Array<{ id: VisualTechniqueId; label: string; allowed: boolean }> {
  const all = Object.values(VISUAL_TECHNIQUES);
  if (!language || !(language in VISUAL_LANGUAGES)) return all.map((t) => ({ id: t.id, label: t.label, allowed: true }));
  const lang = VISUAL_LANGUAGES[language as keyof typeof VISUAL_LANGUAGES];
  return all.map((t) => ({ id: t.id, label: t.label, allowed: lang.techniques.includes(t.id) }));
}

/** Keep the owner's timing for actions whose target still exists. Anything else gets the default. */
export function mergeActions(next: EditorGraphic, previous: EditorGraphic | null | undefined, durationSec: number): GraphicAction[] {
  // An empty action list is the owner's explicit static-shot choice.
  if (previous?.kind === next.kind && previous.actions.length === 0) return [];
  const targets = new Set(next.objects.map((o) => o.id));
  const kept = (previous && previous.kind === next.kind ? previous.actions : []).filter((a) => targets.has(a.targetId));
  return kept.length > 0 ? kept : defaultActions(next, durationSec);
}

const NUM_STYLE: React.CSSProperties = { width: 90 };

type ActorNumberKey = 'x' | 'y' | 'scale' | 'opacity' | 'armAngle' | 'w' | 'h' | 'rotation';
const ACTOR_NUMBER_FIELDS: Record<ActorNumberKey, { label: string; min: number; max: number }> = {
  x: { label: 'X (frame fraction)', ...GRAPHIC_PROPERTY_RANGE.x },
  y: { label: 'Y (frame fraction)', ...GRAPHIC_PROPERTY_RANGE.y },
  scale: { label: 'Scale', ...GRAPHIC_PROPERTY_RANGE.scale },
  opacity: { label: 'Opacity', ...GRAPHIC_PROPERTY_RANGE.opacity },
  armAngle: { label: 'Arm angle (degrees)', ...GRAPHIC_PROPERTY_RANGE.armAngle },
  rotation: { label: 'Rotation (degrees)', ...GRAPHIC_PROPERTY_RANGE.rotation },
  w: { label: 'Width (frame fraction)', min: 0.02, max: 0.6 },
  h: { label: 'Height (frame fraction)', min: 0.02, max: 0.6 },
};
const COMMON_ACTOR_FIELDS: ActorNumberKey[] = ['x', 'y', 'scale', 'opacity'];

/** Extend the reviewed appearance controls with explicit creation and pose edits. Apply is the only mutation. */
const ActorAuthoringForm: React.FC<{
  graphic: EditorGraphic | null; durationSec: number; format: GraphicFormat;
  profile: GraphicProfileName; disabled?: boolean; label: string;
  onChange: (graphic: EditorGraphic | null) => void;
}> = ({ graphic, durationSec, format, profile, disabled, label, onChange }) => {
  const [draft, setDraft] = useState(() => graphic ?? emptyActorGraphic());
  // Keep raw numeric input until Apply: blank/partial/non-finite text is not silently coerced to zero.
  const [numbers, setNumbers] = useState<Record<string, Partial<Record<ActorNumberKey, string>>>>({});
  const [reasons, setReasons] = useState<string[]>([]);
  const reservedIds = React.useRef(new Set<string>());
  draft.objects.forEach((o) => reservedIds.current.add(o.id));
  React.useEffect(() => { setDraft(graphic ?? emptyActorGraphic()); setNumbers({}); setReasons([]); }, [graphic]);
  const edit = (id: string, change: { label?: string; color?: string }) => setDraft({ ...draft, objects: draft.objects.map((o) => o.id === id ? { ...o, ...change } : o) });
  const add = (type: 'figure' | 'box') => {
    const object = newActorObject(draft, type, reservedIds.current);
    reservedIds.current.add(object.id);
    setDraft({ ...draft, objects: [...draft.objects, object] });
    setReasons([]);
  };
  const candidate: EditorGraphic = { ...draft, objects: draft.objects.map((o) => {
    const edits = Object.entries(numbers[o.id] ?? {}).map(([key, value]) => [key, value.trim() === '' ? NaN : Number(value)]);
    return { ...o, ...Object.fromEntries(edits) };
  }) };
  return <div className="stack" data-testid={`actor-form-${label}`}>
    <p className="small">Add procedural figures and boxes, then apply. New objects use the displayed starting positions and sizes, with no timed actions. Supplied ticks keep their appearance controls; other kinds cannot be created here.</p>
    <p className="small">Base values do not rewrite timed actions. An animated property follows its action values, even if its base value is edited.</p>
    {!draft.objects.some((o) => o.type === 'figure') ? <p className="small" role="status">Incomplete actor graphic: add at least one figure before applying. Boxes are optional.</p> : null}
    <label className="field">Title (optional)
      <input aria-label={`${label} title`} disabled={disabled} value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value || null })} />
    </label>
    {draft.objects.map((o) => {
      const fields: ActorNumberKey[] = o.type === 'figure' ? [...COMMON_ACTOR_FIELDS, 'armAngle'] : o.type === 'box' ? [...COMMON_ACTOR_FIELDS, 'w', 'h', 'rotation'] : [];
      return <div key={o.id} className="stack" data-testid={`actor-object-${label}-${o.id}`}>
        <b className="small">{o.id} ({o.type})</b>
        {actorBoxLabelTooSmall(candidate.objects.find((item) => item.id === o.id)!, draft.actions, format) ? (
          <div className="small warn-text" role="note" aria-live="polite" data-testid={`actor-label-warning-${label}-${o.id}`}>
            Readability: this label will be very small at the base or smallest animated scale. Enlarge the box or shorten the label. All text is kept; this warning does not block Apply.
          </div>
        ) : null}
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {o.type === 'box' ? <label>Label <input aria-label={`${label} actor ${o.id} label`} disabled={disabled} value={o.label ?? ''} onChange={(e) => edit(o.id, { label: e.target.value })} /></label> : null}
          <label>Colour <input aria-label={`${label} actor ${o.id} color`} disabled={disabled} value={o.color ?? ''} placeholder="Optional #RRGGBB" onChange={(e) => {
            const color = e.target.value;
            setDraft({ ...draft, objects: draft.objects.map((item) => {
              if (item.id !== o.id) return item;
              const next = { ...item }; if (color.trim()) next.color = color; else delete next.color; return next;
            }) });
          }} /></label>
          {fields.map((key) => <label key={key} className="small">{ACTOR_NUMBER_FIELDS[key].label}
            <input aria-label={`${label} actor ${o.id} ${key}`} type="number" step="any" min={ACTOR_NUMBER_FIELDS[key].min} max={ACTOR_NUMBER_FIELDS[key].max}
              style={NUM_STYLE} disabled={disabled} value={numbers[o.id]?.[key] ?? o[key] ?? ''} placeholder="Default"
              onChange={(e) => setNumbers({ ...numbers, [o.id]: { ...numbers[o.id], [key]: e.target.value } })} />
          </label>)}
          {fields.length ? <button type="button" className="btn sm" aria-label={`${label} remove actor ${o.id}`} disabled={disabled} onClick={() => {
            const reason = actorRemovalProblem(draft, o.id);
            if (reason) { setReasons([reason]); return; }
            setDraft({ ...draft, objects: draft.objects.filter((item) => item.id !== o.id) });
            setReasons([]);
          }}>Remove {o.type}</button> : null}
        </div>
      </div>;
    })}
    <div className="row" style={{ gap: 8 }}>
      <button type="button" className="btn sm" disabled={disabled || draft.objects.filter((o) => o.type === 'figure').length >= 3} onClick={() => add('figure')}>Add figure</button>
      <button type="button" className="btn sm" disabled={disabled || draft.objects.filter((o) => o.type === 'box').length >= 6} onClick={() => add('box')}>Add box</button>
      <button type="button" className="btn sm" disabled={disabled} data-testid={`apply-actor-${label}`} onClick={() => {
        const problems = graphicProblems(candidate, durationSec, format, profile);
        setReasons(problems); if (!problems.length) onChange(candidate);
      }}>Apply actor values</button>
    </div>
    {reasons.map((reason) => <div key={reason} role="alert" className="warn-text small">{reason}</div>)}
  </div>;
};

/** Owner-typed values for one graphic shot. Nothing is invented: a value exists only if typed. */
export const GraphicValuesForm: React.FC<{
  technique: VisualTechniqueId;
  graphic: EditorGraphic | null;
  format: GraphicFormat;
  profile: GraphicProfileName;
  durationSec: number;
  disabled?: boolean;
  onChange: (graphic: EditorGraphic | null) => void;
  label: string;
}> = ({ technique, graphic, format, profile, durationSec, disabled, onChange, label }) => {
  const kind = kindOfTechnique(technique);
  const seeded = graphic && graphic.kind === kind ? graphic : null;
  const [numeric, setNumeric] = useState<NumericForm>(() => (seeded?.kind === 'numeric_comparison' ? numericFormFrom(seeded) : { title: '', scaleMax: '', rows: [{ label: '', value: '', unit: '' }, { label: '', value: '', unit: '' }] }));
  const [list, setList] = useState<ListForm>(() => (seeded && (seeded.kind === 'kinetic_text' || seeded.kind === 'process_path') ? listFormFrom(seeded) : { title: '', items: [''] }));
  const [reasons, setReasons] = useState<string[]>([]);

  if (kind === null) return null;
  if (kind === 'actor_action') {
    return <ActorAuthoringForm key={label} graphic={seeded} durationSec={durationSec} format={format} profile={profile} disabled={disabled} label={label} onChange={onChange} />;
  }

  const apply = () => {
    const options = { direction: seeded?.direction ?? 'ltr' as const };
    let reasonsNow: string[];
    let built: EditorGraphic | null = null;
    if (kind === 'numeric_comparison') {
      reasonsNow = numericIncomplete(numeric);
      if (reasonsNow.length === 0) built = buildNumericValues(numeric, format, durationSec, seeded);
    } else {
      reasonsNow = listIncomplete(kind, list);
      if (reasonsNow.length === 0) built = kind === 'kinetic_text' ? buildKineticGraphic(list, format, durationSec, options) : buildProcessValues(list, format, durationSec, seeded);
    }
    if (built) {
      const problems = graphicProblems(built, durationSec, format, profile);
      if (problems.length > 0) { setReasons(problems); return; }
      if (kind === 'kinetic_text') built.actions = mergeActions(built, seeded, durationSec);
      setReasons([]);
      onChange(built);
    } else {
      setReasons(reasonsNow);
    }
  };

  const numericPreview = kind === 'numeric_comparison' && numericIncomplete(numeric).length === 0
    ? buildNumericValues(numeric, format, durationSec, seeded) : null;
  const numericWarnings = numericPreview && graphicProblems(numericPreview, durationSec, format, profile).length === 0
    ? numericLabelWarnings(numericPreview, format) : [];
  const processPreview = kind === 'process_path' && listIncomplete(kind, list).length === 0
    ? buildProcessValues(list, format, durationSec, seeded) : null;
  const processWarnings = processPreview && graphicProblems(processPreview, durationSec, format, profile).length === 0
    ? processLabelWarnings(processPreview, format) : [];

  const setRow = (i: number, change: Partial<NumericForm['rows'][number]>) => setNumeric((f) => ({ ...f, rows: f.rows.map((r, j) => (j === i ? { ...r, ...change } : r)) }));

  return (
    <div className="stack" data-testid={`values-${label}`} style={{ gap: 6 }}>
      <label className="field">
        <span>Title (optional)</span>
        <input aria-label={`${label} title`} disabled={disabled} value={kind === 'numeric_comparison' ? numeric.title : list.title}
          onChange={(e) => (kind === 'numeric_comparison' ? setNumeric((f) => ({ ...f, title: e.target.value })) : setList((f) => ({ ...f, title: e.target.value })))} />
      </label>
      {kind === 'numeric_comparison' ? (
        <>
          <label className="field">
            <span>Scale maximum (the value a full bar represents)</span>
            <input aria-label={`${label} scale maximum`} type="number" step="any" style={NUM_STYLE} disabled={disabled} value={numeric.scaleMax}
              onChange={(e) => setNumeric((f) => ({ ...f, scaleMax: e.target.value }))} />
          </label>
          {numeric.rows.map((r, i) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <input aria-label={`${label} value ${i + 1} label`} placeholder="Label" disabled={disabled} value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} />
              <input aria-label={`${label} value ${i + 1} number`} placeholder="Exact value" inputMode="decimal" style={NUM_STYLE} disabled={disabled} value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
              <input aria-label={`${label} value ${i + 1} unit`} placeholder="Unit" style={{ width: 70 }} disabled={disabled} value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })} />
              <button type="button" className="btn sm" disabled={disabled || numeric.rows.length <= 1} onClick={() => setNumeric((f) => ({ ...f, rows: f.rows.filter((_, j) => j !== i) }))}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn sm" disabled={disabled || numeric.rows.length >= 6} onClick={() => setNumeric((f) => ({ ...f, rows: [...f.rows, { label: '', value: '', unit: '' }] }))}>Add value</button>
        </>
      ) : (
        <>
          {list.items.map((t, i) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <input aria-label={`${label} ${kind === 'kinetic_text' ? 'word' : 'step'} ${i + 1}`} disabled={disabled} value={t}
                onChange={(e) => setList((f) => ({ ...f, items: f.items.map((x, j) => (j === i ? e.target.value : x)) }))} />
              <button type="button" className="btn sm" disabled={disabled || list.items.length <= 1} onClick={() => setList((f) => ({ ...f, items: f.items.filter((_, j) => j !== i), objectIds: f.objectIds?.filter((_, j) => j !== i) }))}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn sm" disabled={disabled || list.items.length >= 8} onClick={() => setList((f) => ({ ...f, items: [...f.items, ''] }))}>
            {kind === 'kinetic_text' ? 'Add word or phrase' : 'Add step'}
          </button>
        </>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn sm" disabled={disabled} onClick={apply} data-testid={`apply-values-${label}`}>Apply these values to the shot</button>
        {graphic ? <span className="small">Values saved on this shot: {graphic.kind}</span> : <span className="small">No values yet. This shot is missing its graphic values.</span>}
      </div>
      {numericWarnings.map((warning) => <div key={warning.id} role="note" aria-live="polite" className="warn-text small" data-testid={`numeric-label-warning-${label}-${warning.id}`}>
        Readability: {warning.id} {warning.category && warning.value ? 'category and value/unit text' : warning.category ? 'category label' : 'value/unit text'} will be very small in its available region.
        Consider shorter category wording or an explicitly reviewed chart layout. Exact values, units and all text are kept; this warning does not block Apply.
      </div>)}
      {processWarnings.map((id) => <div key={id} role="note" aria-live="polite" className="warn-text small" data-testid={`process-label-warning-${label}-${id}`}>
        Readability: {id} step text will be very small in its available region. Consider shorter wording or an explicitly reviewed layout.
        All text and saved node positions are kept; this warning does not block Apply.
      </div>)}
      {reasons.map((r) => <div key={r} className="warn-text small" role="alert">{r}</div>)}
    </div>
  );
};

/** Timed actions of one graphic: target, property, from/to, start/end seconds, easing. Server re-validates on save. */
export const GraphicActionsEditor: React.FC<{
  graphic: EditorGraphic;
  format: GraphicFormat;
  profile: GraphicProfileName;
  durationSec: number;
  disabled?: boolean;
  label: string;
  onChange: (graphic: EditorGraphic) => void;
}> = ({ graphic: savedGraphic, format, profile, durationSec, disabled, label, onChange }) => {
  const [pendingActor, setPendingActor] = useState<EditorGraphic | null>(null);
  React.useEffect(() => { setPendingActor(null); }, [savedGraphic]);
  const graphic = pendingActor ?? savedGraphic;
  const setActions = (actions: GraphicAction[]) => {
    const next = { ...graphic, actions };
    if (graphic.kind === 'actor_action' && graphicProblems(next, durationSec, format, profile).length) {
      setPendingActor(next); // Incomplete action edits are visible, but never reach canonical staging.
      return;
    }
    setPendingActor(null);
    onChange(next);
  };
  const number = (value: string) => graphic.kind === 'actor_action' && value.trim() === '' ? NaN : Number(value);
  const update = (i: number, change: Partial<GraphicAction>) => setActions(graphic.actions.map((a, j) => (j === i ? { ...a, ...change } : a)));
  const problems = graphicProblems(graphic, durationSec, format, profile).filter((p) => /action|target|property|start|end|from|to|easing|duration|clip|range/i.test(p));
  const firstTarget = graphic.objects[0];
  return (
    <div className="stack" data-testid={`actions-${label}`} style={{ gap: 6 }}>
      <div className="small"><b>Timed actions</b> (seconds on the clip&apos;s own clock; 0 is its first frame)</div>
      {graphic.actions.length === 0 ? <div className="small">No timed actions. The shot is static.</div> : null}
      {graphic.kind === 'actor_action' ? <div className="small">New actor actions hold the base value until you choose a destination. Timing is explicit below.</div> : null}
      {pendingActor ? <div className="small warn-text" role="status">Action edits are not applied yet. Correct the errors below or remove the incomplete action.</div> : null}
      {graphic.actions.map((a, i) => {
        const target = graphic.objects.find((o) => o.id === a.targetId);
        const props = target ? animatablePropertiesFor(graphic, a.targetId) : [];
        return (
          <div key={a.id} className="row" style={{ gap: 6, flexWrap: 'wrap' }} data-testid={`action-${label}-${a.id}`}>
            <select aria-label={`${label} action ${a.id} target`} disabled={disabled} value={a.targetId} onChange={(e) => {
              const next = graphic.objects.find((o) => o.id === e.target.value);
              const prop = next ? animatablePropertiesFor(graphic, next.id)[0] : a.property;
              update(i, { targetId: e.target.value, property: prop ?? a.property });
            }}>
              {graphic.objects.map((o) => <option key={o.id} value={o.id}>{o.id} ({o.type})</option>)}
            </select>
            <select aria-label={`${label} action ${a.id} property`} disabled={disabled} value={a.property} onChange={(e) => update(i, { property: e.target.value as GraphicAction['property'] })}>
              {(props.length ? props : [a.property]).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <label className="small">from <input aria-label={`${label} action ${a.id} from`} type="number" step="any" style={NUM_STYLE} disabled={disabled} value={Number.isFinite(a.from) ? a.from : ''} onChange={(e) => update(i, { from: number(e.target.value) })} /></label>
            <label className="small">to <input aria-label={`${label} action ${a.id} to`} type="number" step="any" style={NUM_STYLE} disabled={disabled} value={Number.isFinite(a.to) ? a.to : ''} onChange={(e) => update(i, { to: number(e.target.value) })} /></label>
            <label className="small">start s <input aria-label={`${label} action ${a.id} start`} type="number" step="0.1" style={NUM_STYLE} disabled={disabled} value={Number.isFinite(a.startSec) ? a.startSec : ''} onChange={(e) => update(i, { startSec: number(e.target.value) })} /></label>
            <label className="small">end s <input aria-label={`${label} action ${a.id} end`} type="number" step="0.1" style={NUM_STYLE} disabled={disabled} value={Number.isFinite(a.endSec) ? a.endSec : ''} onChange={(e) => update(i, { endSec: number(e.target.value) })} /></label>
            <select aria-label={`${label} action ${a.id} easing`} disabled={disabled} value={a.easing} onChange={(e) => update(i, { easing: e.target.value as GraphicAction['easing'] })}>
              {EASING_CHOICES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <button type="button" className="btn sm" disabled={disabled} onClick={() => setActions(graphic.actions.filter((_, j) => j !== i))}>Remove</button>
          </div>
        );
      })}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn sm" disabled={disabled || !firstTarget || animatablePropertiesFor(graphic, firstTarget.id).length === 0} onClick={() => {
          if (!firstTarget) return;
          const prop = animatablePropertiesFor(graphic, firstTarget.id)[0];
          const ids = new Set(graphic.actions.map((a) => a.id));
          let suffix = 1;
          while (ids.has(`action-${suffix}`)) suffix += 1;
          // Actor positions cannot use the other families' 0..1 reveal default. Start with an explicit hold
          // at the object's base value; the owner chooses the destination and timing in these same controls.
          const actor = graphic.kind === 'actor_action';
          const from = actor ? graphicStateAt({ ...graphic, actions: [] }, 0).get(firstTarget.id)![prop] : 0;
          setActions([...graphic.actions, { id: `action-${suffix}`, targetId: firstTarget.id, property: prop, from, to: actor ? from : 1, startSec: 0, endSec: actor ? Math.min(1, durationSec) : Math.min(1, Math.max(0.1, durationSec - 0.1)), easing: 'ease_out' }]);
        }}>Add timed action</button>
        <button type="button" className="btn sm" disabled={disabled} onClick={() => setActions(defaultActions(graphic, durationSec))}>{graphic.kind === 'actor_action' ? 'Clear timed actions (static)' : 'Reset to default timing'}</button>
      </div>
      {problems.map((p) => <div key={p} className="warn-text small" role="alert">{p}</div>)}
    </div>
  );
};
