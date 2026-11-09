import React, { useState } from 'react';
import { Tag } from '../ui';
import type { CaptionDirection, EditorCaption, EditorDocument, EditorHighlight } from '../../lib/editor-types';
import {
  boxToPercent,
  captionLanguagesOf,
  clampBox,
  containsDiacritics,
  defaultCaption,
  defaultHighlight,
  defaultTranslation,
  detectCaptionDirection,
  hasRtlScript,
  opInsert,
  opRemove,
  opSetDocument,
  opUpdate,
  round3,
  selectCaptionCues,
  suggestFontSize,
  translationsOf,
} from '../../lib/editor-model';
import { NumberInput, Select, TextInput, type Stage } from './shared';

const directionOptions = [
  { value: 'rtl', label: 'rtl — right to left' },
  { value: 'ltr', label: 'ltr — left to right' },
];

/**
 * Caption editor.
 *
 * Full RTL support: the text is edited in its own direction with a
 * right-to-left rendering font and preserved shaping/diacritics (nothing is
 * normalized or re-encoded). A caption carries its own time bounds and
 * placement, and its interval does NOT have to match a visual scene.
 */
export const EditorCaptionPanel: React.FC<{
  document: EditorDocument;
  playhead: number;
  selectedCaptionId: string | null;
  onSelectCaption: (id: string | null) => void;
  stage: Stage;
  disabled: boolean;
}> = ({ document, playhead, selectedCaptionId, onSelectCaption, stage, disabled }) => {
  const cue = document.captions.find((item) => item.id === selectedCaptionId) ?? null;
  const [draftText, setDraftText] = useState('');
  const [draftStart, setDraftStart] = useState(playhead);

  const update = (changes: Partial<EditorCaption>) => {
    if (!cue) return;
    stage([opUpdate('captions', cue.id, changes as Record<string, unknown>)]);
  };

  const addCaption = () => {
    const text = draftText.trim();
    if (!text) return;
    const created = defaultCaption(document, draftStart, text);
    const findings = stage([opInsert('captions', created)]);
    if (!findings.length) {
      onSelectCaption(created.id);
      setDraftText('');
    }
  };

  return (
    <div className="card">
      <h3>Captions</h3>
      <p className="sub">
        Complete words, shaping and diacritics are preserved. One caption interval need not equal one visual clip: an interval may span a
        cut, and a clip may carry several cues.
      </p>

      <CaptionLanguageControl document={document} stage={stage} disabled={disabled} />

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <TextInput label="New caption text" value={draftText} placeholder="اكتب نص الترجمة" disabled={disabled} onCommit={setDraftText} />
        </div>
        <div style={{ width: 130 }}>
          <NumberInput label="Starts at" value={draftStart} step={0.1} min={0} suffix="seconds" disabled={disabled} onCommit={(value) => setDraftStart(round3(Math.max(0, value)))} />
        </div>
        <button className="btn sm primary" style={{ marginBottom: 12 }} disabled={disabled || !draftText.trim()} onClick={addCaption}>
          + Add caption
        </button>
      </div>

      <div className="row" style={{ flexWrap: 'wrap' }}>
        {document.captions.map((item) => (
          <button
            key={item.id}
            data-testid={`caption-chip-${item.id}`}
            className={`btn sm ${item.id === selectedCaptionId ? 'primary' : ''}`}
            onClick={() => onSelectCaption(item.id)}
          >
            {item.id}{item.cueOf ? ` (${item.language} translation of ${item.cueOf})` : ''} · {item.startSec.toFixed(2)}–{item.endSec.toFixed(2)}s {item.locked ? '🔒' : ''}
          </button>
        ))}
        {!document.captions.length ? <span className="small">No captions yet.</span> : null}
      </div>

      {cue ? (
        <div className="mt">
          <div className="field">
            <label>
              Caption text ({cue.direction === 'rtl' ? 'right-to-left' : 'left-to-right'}
              {containsDiacritics(cue.text) ? ', diacritics preserved' : ''})
            </label>
            <textarea
              data-testid="caption-text"
              dir={cue.direction}
              lang={cue.language}
              value={cue.text}
              disabled={disabled || cue.locked}
              style={{
                minHeight: 90,
                direction: cue.direction,
                textAlign: cue.direction === 'rtl' ? 'right' : 'left',
                fontFamily: cue.direction === 'rtl' ? '"Noto Naskh Arabic", "Noto Sans Arabic", Amiri, Tahoma, sans-serif' : 'inherit',
                fontSize: Math.max(16, Math.min(30, cue.fontSizePx * 0.45)),
                lineHeight: 1.7,
              }}
              onChange={(e) => update({ text: e.target.value })}
            />
            <div className="hint">
              {hasRtlScript(cue.text) ? 'Arabic script detected.' : 'No right-to-left script detected in this text.'} Direction is stored
              explicitly and is never re-derived from the text behind your back.
            </div>
          </div>

          <div className="grid2">
            {cue.cueOf ? (
              <div className="hint" data-testid="translation-timing" style={{ gridColumn: '1 / -1' }}>
                Timing follows spoken cue {cue.cueOf} ({cue.startSec.toFixed(2)}–{cue.endSec.toFixed(2)}s). Edit the spoken cue to move it.
              </div>
            ) : (
              <>
                <NumberInput label="Start" value={cue.startSec} step={0.1} min={0} suffix="seconds" disabled={disabled || cue.locked} onCommit={(value) => update({ startSec: round3(Math.max(0, value)) })} />
                <NumberInput label="End" value={cue.endSec} step={0.1} min={0} suffix="seconds" disabled={disabled || cue.locked} onCommit={(value) => update({ endSec: round3(Math.max(0, value)) })} />
              </>
            )}
            <NumberInput label="Font size" value={cue.fontSizePx} step={1} min={24} suffix="px in the frame" disabled={disabled || cue.locked} onCommit={(value) => update({ fontSizePx: Math.max(24, Math.round(value)) })} />
            <div className="field" style={{ marginBottom: 8 }}>
              <label>Readability</label>
              <button className="btn sm" disabled={disabled || cue.locked} onClick={() => update({ fontSizePx: suggestFontSize(cue.text, document.format === 'landscape' ? 1920 : 1080) })}>
                Suggest a readable size for this text
              </button>
            </div>
            <NumberInput label="Position x" value={cue.position.x} step={0.01} min={0} max={1} suffix="normalized" disabled={disabled || cue.locked} onCommit={(value) => update({ position: { ...cue.position, x: Math.min(1, Math.max(0, value)) } })} />
            <NumberInput label="Position y" value={cue.position.y} step={0.01} min={0} max={1} suffix="normalized" disabled={disabled || cue.locked} onCommit={(value) => update({ position: { ...cue.position, y: Math.min(1, Math.max(0, value)) } })} />
            <Select label="Direction" value={cue.direction} disabled={disabled || cue.locked} options={directionOptions} onCommit={(value) => update({ direction: value as CaptionDirection })} />
            <TextInput label="Language" value={cue.language} disabled={disabled || cue.locked} onCommit={(value) => update({ language: value.trim() || 'ar' })} />
          </div>

          <div className="row">
            <button className="btn sm" disabled={disabled} onClick={() => update({ locked: !cue.locked })}>
              {cue.locked ? 'Unlock caption' : 'Lock caption'}
            </button>
            <button className="btn sm" disabled={disabled || cue.locked} onClick={() => update({ direction: detectCaptionDirection(cue.text, cue.direction) })}>
              Re-detect direction from the text
            </button>
            <button className="btn sm danger" disabled={disabled || cue.locked} onClick={() => { stage([opRemove('captions', cue.id)]); onSelectCaption(null); }}>
              Delete caption
            </button>
          </div>

          {!cue.cueOf ? <TranslationEditor document={document} spoken={cue} stage={stage} disabled={disabled} /> : null}
        </div>
      ) : null}
    </div>
  );
};

/**
 * Which caption language preview and export show. One language at a time: spoken and
 * translated text never appear together. Missing translations are listed, not filled in.
 */
const CaptionLanguageControl: React.FC<{ document: EditorDocument; stage: Stage; disabled: boolean }> = ({ document, stage, disabled }) => {
  const current = document.captionLanguage ?? null;
  const options = [
    { value: '', label: 'Spoken captions only (default)' },
    ...captionLanguagesOf(document).map((language) => ({ value: language, label: `${language}: show this language` })),
  ];
  const { missingTranslations } = selectCaptionCues(document, current);
  return (
    <div className="field" data-testid="caption-language-control">
      <Select
        label="Caption language shown in preview and export"
        value={current ?? ''}
        options={options}
        disabled={disabled}
        onCommit={(value) => stage([opSetDocument({ captionLanguage: value === '' ? null : value })])}
      />
      {current === null ? (
        <div className="hint">Spoken captions only. Translations are kept but not shown.</div>
      ) : (
        <div className="hint">Only the {current} captions are shown. Spoken and translated text never appear together.</div>
      )}
      {current !== null && missingTranslations.length > 0 ? (
        <div className="hint" data-testid="caption-missing-translations" role="alert">
          {missingTranslations.length} spoken cue(s) have no {current} translation and are not shown: {missingTranslations.join(', ')}. Nothing is filled in from the spoken text. Add a translation below.
        </div>
      ) : null}
    </div>
  );
};

/**
 * Translations of one spoken cue. A translation shares the cue's timing exactly. Its
 * text edits never move it, and it never carries spoken content of its own.
 */
const TranslationEditor: React.FC<{ document: EditorDocument; spoken: EditorCaption; stage: Stage; disabled: boolean }> = ({ document, spoken, stage, disabled }) => {
  const linked = translationsOf(document, spoken.id);
  const [language, setLanguage] = useState(spoken.language === 'ar' ? 'en' : 'ar');
  const [text, setText] = useState('');
  const add = () => {
    const value = text.trim();
    if (!value) return;
    const created = defaultTranslation(document, spoken, value, language.trim() || 'en');
    const findings = stage([opInsert('captions', created)]);
    if (!findings.length) setText('');
  };
  return (
    <div className="mt" data-testid="translations">
      <h4>Translations of {spoken.id}</h4>
      <div className="hint">
        Timing is shared with this spoken cue ({spoken.startSec.toFixed(2)}–{spoken.endSec.toFixed(2)}s). Translation text never changes timing and never adds spoken content.
      </div>
      {linked.map((tr) => (
        <div key={tr.id} className="field" data-testid={`translation-${tr.id}`}>
          <label>{tr.language} translation ({tr.id})</label>
          <textarea
            data-testid={`translation-text-${tr.id}`}
            dir={tr.direction}
            lang={tr.language}
            value={tr.text}
            disabled={disabled || tr.locked}
            style={{ minHeight: 60 }}
            onChange={(e) => stage([opUpdate('captions', tr.id, { text: e.target.value })])}
          />
          <button className="btn sm danger" disabled={disabled || tr.locked} onClick={() => stage([opRemove('captions', tr.id)])}>
            Remove translation
          </button>
        </div>
      ))}
      {linked.length === 0 ? <div className="small">No translation for this cue yet.</div> : null}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ width: 120 }}>
          <TextInput label="Language" value={language} disabled={disabled} onCommit={setLanguage} />
        </div>
        <div style={{ flex: 1 }}>
          <TextInput label="Translation text" value={text} placeholder="Translated text only" disabled={disabled} onCommit={setText} />
        </div>
        <button className="btn sm primary" style={{ marginBottom: 12 }} disabled={disabled || !text.trim()} onClick={add}>
          + Add translation
        </button>
      </div>
    </div>
  );
};

/**
 * Timed highlights.
 *
 * A highlight always has BOTH measured display coordinates and start/end times;
 * it is drawn only inside its interval, it is tied to a specific visual clip,
 * and it cannot cover more than the operator asked for. It is an annotation,
 * not a recorded cursor movement.
 */
export const EditorHighlightPanel: React.FC<{
  document: EditorDocument;
  playhead: number;
  selectedHighlightId: string | null;
  onSelectHighlight: (id: string | null) => void;
  stage: Stage;
  disabled: boolean;
}> = ({ document, playhead, selectedHighlightId, onSelectHighlight, stage, disabled }) => {
  const highlight = document.highlights.find((item) => item.id === selectedHighlightId) ?? null;
  const clipOptions = document.visualClips.map((clip) => ({ value: clip.id, label: `${clip.id} (${clip.startSec.toFixed(2)}s)` }));

  const update = (changes: Partial<EditorHighlight>) => {
    if (!highlight) return;
    stage([opUpdate('highlights', highlight.id, changes as Record<string, unknown>)]);
  };

  const add = () => {
    if (!document.visualClips.length) return;
    const created = defaultHighlight(document, playhead);
    const findings = stage([opInsert('highlights', created)]);
    if (!findings.length) onSelectHighlight(created.id);
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Timed highlights</h3>
        <button className="btn sm primary" disabled={disabled || !document.visualClips.length} onClick={add}>
          + Highlight at playhead ({playhead.toFixed(2)}s)
        </button>
      </div>
      <p className="sub">
        Display coordinates are normalized to the frame, so they survive a resize. Highlights are shown only during their interval and are
        editable in the preview by dragging, with the arrow keys, or numerically here.
      </p>

      <div className="row" style={{ flexWrap: 'wrap' }}>
        {document.highlights.map((item) => (
          <button key={item.id} data-testid={`highlight-chip-${item.id}`} className={`btn sm ${item.id === selectedHighlightId ? 'primary' : ''}`} onClick={() => onSelectHighlight(item.id)}>
            {item.label ?? item.id} · {item.startSec.toFixed(2)}–{item.endSec.toFixed(2)}s
          </button>
        ))}
        {!document.highlights.length ? <span className="small">No highlights yet.</span> : null}
      </div>

      {highlight ? (
        <div className="mt">
          <div className="grid2">
            <NumberInput label="Start" value={highlight.startSec} step={0.1} min={0} suffix="seconds" disabled={disabled || highlight.locked} onCommit={(value) => update({ startSec: round3(Math.max(0, value)) })} />
            <NumberInput label="End" value={highlight.endSec} step={0.1} min={0} suffix="seconds" disabled={disabled || highlight.locked} onCommit={(value) => update({ endSec: round3(Math.max(0, value)) })} />
            <NumberInput label="box x" value={highlight.box.x} step={0.01} min={0} max={1} disabled={disabled || highlight.locked} onCommit={(value) => update({ box: clampBox({ ...highlight.box, x: value }) })} />
            <NumberInput label="box y" value={highlight.box.y} step={0.01} min={0} max={1} disabled={disabled || highlight.locked} onCommit={(value) => update({ box: clampBox({ ...highlight.box, y: value }) })} />
            <NumberInput label="box width" value={highlight.box.width} step={0.01} min={0.01} max={1} disabled={disabled || highlight.locked} onCommit={(value) => update({ box: clampBox({ ...highlight.box, width: value }) })} />
            <NumberInput label="box height" value={highlight.box.height} step={0.01} min={0.01} max={1} disabled={disabled || highlight.locked} onCommit={(value) => update({ box: clampBox({ ...highlight.box, height: value }) })} />
            <Select label="Attached visual clip" value={highlight.visualClipId} disabled={disabled || highlight.locked} options={clipOptions} onCommit={(value) => update({ visualClipId: value })} />
            <TextInput label="Label" value={highlight.label ?? ''} disabled={disabled || highlight.locked} onCommit={(value) => update({ label: value.trim() ? value : null })} />
          </div>
          <div className="small mono">
            display box: {boxToPercent(highlight.box).left} / {boxToPercent(highlight.box).top} / {boxToPercent(highlight.box).width} / {boxToPercent(highlight.box).height}
          </div>
          <div className="row mt">
            <button className="btn sm" disabled={disabled} onClick={() => update({ locked: !highlight.locked })}>
              {highlight.locked ? 'Unlock highlight' : 'Lock highlight'}
            </button>
            <button
              className="btn sm"
              disabled={disabled || highlight.locked}
              onClick={() => update({ endSec: round3(Math.min(document.durationSec, highlight.startSec + 3)) })}
            >
              Set a 3s interval from the start
            </button>
            <button className="btn sm danger" disabled={disabled || highlight.locked} onClick={() => { stage([opRemove('highlights', highlight.id)]); onSelectHighlight(null); }}>
              Delete highlight
            </button>
          </div>
        </div>
      ) : null}
      {document.highlights.length ? <Tag kind="accent">Drawn in the preview during their own interval only</Tag> : null}
    </div>
  );
};
