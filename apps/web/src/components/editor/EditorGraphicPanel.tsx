import React, { useRef, useState } from 'react';
import type { EditorGraphic } from '@buildtrack/core/visual';
import type { EditorDocument, EditorVisualClip } from '../../lib/editor-types';
import { opUpdate } from '../../lib/editor-model';
import { kindOfTechnique } from '../../lib/graphic-form';
import { planGraphicValues, planTechniqueChange, type MediaRestore, type TechniquePlan } from '../../lib/graphic-clip-edit';
import { GraphicActionsEditor, GraphicValuesForm, techniqueChoices } from '../graphic/GraphicEditors';
import type { Stage } from './shared';

/**
 * Visual technique and graphic values for the SELECTED clip, inside the existing inspector.
 *
 * Every saved change is one canonical staged operation (opUpdate on visualClips), so undo, redo, save,
 * revision and lock work exactly as for every other clip edit. An incomplete choice is shown as PENDING: it
 * stays on screen with its reason and is not staged, so an incomplete graphic can never be saved. Nothing here
 * stores a second animation state.
 */
export const EditorGraphicPanel: React.FC<{
  document: EditorDocument;
  clip: EditorVisualClip;
  stage: Stage;
  disabled: boolean;
}> = ({ document, clip, stage, disabled }) => {
  const [findings, setFindings] = useState<string[]>([]);
  const [pending, setPending] = useState<{ technique: string | null; reason: string } | null>(null);
  // The picture or footage the clip used before it became a graphic. Kept while this panel is mounted only.
  const restoreRef = useRef<MediaRestore | null>(null);
  if (clip.sourceAssetId !== null) {
    restoreRef.current = { sourceAssetId: clip.sourceAssetId, sourceInSec: clip.sourceInSec ?? null, sourceOutSec: clip.sourceOutSec ?? null };
  }
  const language = document.visualLanguage ?? null;
  const format = document.format === 'portrait' ? 'portrait' : 'landscape';
  const profile = document.contentProfile ?? null;
  const duration = clip.durationSec;
  const effective = pending ? pending.technique : (clip.technique ?? null);
  const kind = kindOfTechnique(effective);
  const locked = disabled || clip.locked;

  /** Stage one canonical update. Returns true only when the canonical stage accepted it. */
  const commit = (changes: Record<string, unknown>): boolean => {
    const found = stage([opUpdate('visualClips', clip.id, changes)]);
    if (found.length > 0) {
      setFindings(found.map((f) => `${f.field}: ${f.message}`));
      return false;
    }
    setFindings([]);
    setPending(null);
    return true;
  };

  const applyPlan = (plan: TechniquePlan, choice: string | null) => {
    if (plan.status === 'stage') {
      if (!commit(plan.changes)) setPending({ technique: choice, reason: 'Not saved. See the message below.' });
      return;
    }
    setFindings(plan.status === 'refused' ? [plan.reason] : []);
    setPending({ technique: plan.technique, reason: plan.reason });
  };

  const setTechnique = (technique: string | null) => {
    if (technique === (clip.technique ?? null) && !pending) return;
    applyPlan(planTechniqueChange(clip, technique, restoreRef.current), technique);
  };

  const setValues = (g: EditorGraphic | null) => {
    if (!effective) return;
    const plan = planGraphicValues(effective, g);
    if (plan.status === 'stage') {
      commit(plan.changes);
      return;
    }
    setFindings(plan.status === 'refused' ? [plan.reason] : []);
    setPending({ technique: effective, reason: plan.reason });
  };

  const showGraphicPending = pending !== null && kind !== null;
  const graphicForEffective = clip.graphic && kind !== null && clip.graphic.kind === kind ? clip.graphic : null;

  return (
    <div className="stack" data-testid="editor-graphic-panel" style={{ gap: 6, marginBottom: 12 }}>
      <h4 className="small" style={{ marginBottom: 4 }}>Visual technique</h4>
      <label className="field">
        <span>Technique for this clip</span>
        <select aria-label="Clip technique" disabled={locked} value={effective ?? ''} onChange={(e) => setTechnique(e.target.value || null)}>
          <option value="">No technique (as before)</option>
          {techniqueChoices(language).map((t) => (
            <option key={t.id} value={t.id} disabled={!t.allowed && effective !== t.id}>{t.label}{t.allowed ? '' : ' (not in this language)'}</option>
          ))}
        </select>
      </label>
      {language ? <div className="small">Visual language: {language}. A technique outside it is refused on save.</div> : <div className="small">No visual language on this project. Techniques are checked on save.</div>}
      {kind && clip.sourceAssetId !== null ? (
        <div className="small" role="note" style={{ color: 'var(--warn, #b26a00)' }}>Setting graphic values replaces this clip&apos;s picture with the procedural graphic. The picture stays in the library.</div>
      ) : null}
      {showGraphicPending && pending ? <div className="small" role="status" data-testid="graphic-pending">{pending.reason}</div> : null}
      {kind ? (
        <>
          <GraphicValuesForm
            key={`${clip.id}-${effective}`}
            label={`clip-${clip.id}`}
            technique={effective as NonNullable<EditorVisualClip['technique']>}
            graphic={graphicForEffective}
            format={format}
            profile={profile}
            durationSec={duration}
            disabled={locked}
            onChange={setValues}
          />
          {clip.graphic && graphicForEffective ? (
            <GraphicActionsEditor
              label={`clip-${clip.id}`}
              graphic={clip.graphic}
              format={format}
              profile={profile}
              durationSec={duration}
              disabled={locked}
              onChange={(g) => commit({ graphic: g })}
            />
          ) : null}
        </>
      ) : null}
      {findings.map((f) => <div key={f} className="small" role="alert" style={{ color: 'var(--danger, #b00020)' }}>{f}</div>)}
    </div>
  );
};
