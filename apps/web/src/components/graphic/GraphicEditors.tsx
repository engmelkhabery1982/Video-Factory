import React, { useState } from 'react';
import type { EditorGraphic, GraphicAction } from '@buildtrack/core/visual';
import { VISUAL_LANGUAGES, VISUAL_TECHNIQUES, type VisualTechniqueId } from '@buildtrack/core/visual';
import {
  EASING_CHOICES,
  animatablePropertiesFor,
  buildKineticGraphic,
  buildNumericGraphic,
  buildProcessGraphic,
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
  const targets = new Set(next.objects.map((o) => o.id));
  const kept = (previous && previous.kind === next.kind ? previous.actions : []).filter((a) => targets.has(a.targetId));
  return kept.length > 0 ? kept : defaultActions(next, durationSec);
}

const NUM_STYLE: React.CSSProperties = { width: 90 };

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
    return (
      <p className="small" data-testid={`actor-form-${label}`}>
        Actor scenes (figures and boxes) are not authored here yet. Adjust the timing of an existing actor graphic in the Editor.
      </p>
    );
  }

  const apply = () => {
    let reasonsNow: string[];
    let built: EditorGraphic | null = null;
    if (kind === 'numeric_comparison') {
      reasonsNow = numericIncomplete(numeric);
      if (reasonsNow.length === 0) built = buildNumericGraphic(numeric, format, durationSec);
    } else {
      reasonsNow = listIncomplete(kind, list);
      if (reasonsNow.length === 0) built = kind === 'kinetic_text' ? buildKineticGraphic(list, format, durationSec) : buildProcessGraphic(list, format, durationSec);
    }
    if (built) {
      const problems = graphicProblems(built, durationSec, format, profile);
      if (problems.length > 0) { setReasons(problems); return; }
      built.actions = mergeActions(built, seeded, durationSec);
      setReasons([]);
      onChange(built);
    } else {
      setReasons(reasonsNow);
    }
  };

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
              <button type="button" className="btn sm" disabled={disabled || list.items.length <= 1} onClick={() => setList((f) => ({ ...f, items: f.items.filter((_, j) => j !== i) }))}>Remove</button>
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
}> = ({ graphic, format, profile, durationSec, disabled, label, onChange }) => {
  const setActions = (actions: GraphicAction[]) => onChange({ ...graphic, actions });
  const update = (i: number, change: Partial<GraphicAction>) => setActions(graphic.actions.map((a, j) => (j === i ? { ...a, ...change } : a)));
  const problems = graphicProblems(graphic, durationSec, format, profile).filter((p) => /action|target|property|start|end|from|to|easing|duration|clip|range/i.test(p));
  const firstTarget = graphic.objects[0];
  return (
    <div className="stack" data-testid={`actions-${label}`} style={{ gap: 6 }}>
      <div className="small"><b>Timed actions</b> (seconds on the clip&apos;s own clock; 0 is its first frame)</div>
      {graphic.actions.length === 0 ? <div className="small">No timed actions. The shot is static.</div> : null}
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
            <label className="small">from <input aria-label={`${label} action ${a.id} from`} type="number" step="any" style={NUM_STYLE} disabled={disabled} value={a.from} onChange={(e) => update(i, { from: Number(e.target.value) })} /></label>
            <label className="small">to <input aria-label={`${label} action ${a.id} to`} type="number" step="any" style={NUM_STYLE} disabled={disabled} value={a.to} onChange={(e) => update(i, { to: Number(e.target.value) })} /></label>
            <label className="small">start s <input aria-label={`${label} action ${a.id} start`} type="number" step="0.1" style={NUM_STYLE} disabled={disabled} value={a.startSec} onChange={(e) => update(i, { startSec: Number(e.target.value) })} /></label>
            <label className="small">end s <input aria-label={`${label} action ${a.id} end`} type="number" step="0.1" style={NUM_STYLE} disabled={disabled} value={a.endSec} onChange={(e) => update(i, { endSec: Number(e.target.value) })} /></label>
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
          setActions([...graphic.actions, { id: `action-${graphic.actions.length + 1}`, targetId: firstTarget.id, property: prop, from: 0, to: 1, startSec: 0, endSec: Math.min(1, Math.max(0.1, durationSec - 0.1)), easing: 'ease_out' }]);
        }}>Add timed action</button>
        <button type="button" className="btn sm" disabled={disabled} onClick={() => setActions(defaultActions(graphic, durationSec))}>Reset to default timing</button>
      </div>
      {problems.map((p) => <div key={p} className="warn-text small" role="alert">{p}</div>)}
    </div>
  );
};
