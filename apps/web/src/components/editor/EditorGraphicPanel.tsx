import React, { useState } from 'react';
import type { EditorDocument, EditorVisualClip } from '../../lib/editor-types';
import { opUpdate } from '../../lib/editor-model';
import { kindOfTechnique } from '../../lib/graphic-form';
import { GraphicActionsEditor, GraphicValuesForm, techniqueChoices } from '../graphic/GraphicEditors';
import type { Stage } from './shared';

/**
 * Visual technique and graphic values for the SELECTED clip, inside the existing inspector.
 * Every change is one canonical staged operation (opUpdate on visualClips): the same undo, redo,
 * save, revision and lock path as every other clip edit. Nothing here stores a second state.
 */
export const EditorGraphicPanel: React.FC<{
  document: EditorDocument;
  clip: EditorVisualClip;
  stage: Stage;
  disabled: boolean;
}> = ({ document, clip, stage, disabled }) => {
  const [findings, setFindings] = useState<string[]>([]);
  const language = document.visualLanguage ?? null;
  const format = document.format === 'portrait' ? 'portrait' : 'landscape';
  const profile = document.contentProfile ?? null;
  const duration = clip.durationSec;
  const kind = kindOfTechnique(clip.technique ?? null);
  const locked = disabled || clip.locked;

  const commit = (changes: Record<string, unknown>) => {
    const found = stage([opUpdate('visualClips', clip.id, changes)]);
    setFindings(found.map((f) => `${f.field}: ${f.message}`));
  };

  const setTechnique = (technique: string | null) => {
    const nextKind = kindOfTechnique(technique);
    if (technique === null) {
      commit({ technique: null, graphic: null });
      return;
    }
    // A graphic technique replaces the picture with the procedural graphic: its source is cleared in the same update.
    if (nextKind !== null) {
      commit({ technique, graphic: clip.graphic && clip.graphic.kind === nextKind ? clip.graphic : null, sourceAssetId: null, sourceInSec: null, sourceOutSec: null });
      return;
    }
    commit({ technique, graphic: null });
  };

  return (
    <div className="stack" data-testid="editor-graphic-panel" style={{ gap: 6, marginBottom: 12 }}>
      <h4 className="small" style={{ marginBottom: 4 }}>Visual technique</h4>
      <label className="field">
        <span>Technique for this clip</span>
        <select aria-label="Clip technique" disabled={locked} value={clip.technique ?? ''} onChange={(e) => setTechnique(e.target.value || null)}>
          <option value="">No technique (as before)</option>
          {techniqueChoices(language).map((t) => (
            <option key={t.id} value={t.id} disabled={!t.allowed && clip.technique !== t.id}>{t.label}{t.allowed ? '' : ' (not in this language)'}</option>
          ))}
        </select>
      </label>
      {language ? <div className="small">Visual language: {language}. A technique outside it is refused on save.</div> : <div className="small">No visual language on this project. Techniques are checked on save.</div>}
      {kind && clip.sourceAssetId !== null ? (
        <div className="small" role="note" style={{ color: 'var(--warn, #b26a00)' }}>Setting graphic values replaces this clip&apos;s picture with the procedural graphic. The picture stays in the library.</div>
      ) : null}
      {kind ? (
        <>
          <GraphicValuesForm
            key={`${clip.id}-${clip.technique}`}
            label={`clip-${clip.id}`}
            technique={clip.technique as NonNullable<EditorVisualClip['technique']>}
            graphic={clip.graphic ?? null}
            format={format}
            profile={profile}
            durationSec={duration}
            disabled={locked}
            onChange={(g) => (g === null ? commit({ graphic: null }) : commit({ graphic: g, sourceAssetId: null, sourceInSec: null, sourceOutSec: null }))}
          />
          {clip.graphic ? (
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
