import React from 'react';
import { Tag } from '../ui';
import type { EditorAssetRef, EditorDocument, EditorVisualClip, ImageMotion, ClipTransition } from '../../lib/editor-types';
import { CLIP_TRANSITIONS, IMAGE_MOTIONS } from '../../lib/editor-types';
import {
  FULL_FRAME,
  assetForClip,
  clampBox,
  motionLabel,
  opRemove,
  opReorder,
  opSplit,
  opUpdate,
  placedClipAt,
  round3,
  visualOrder,
  moveIds,
} from '../../lib/editor-model';
import { NumberInput, Provenance, Select, kindLabel, seconds, type Stage } from './shared';

/**
 * Everything the operator can do to the SELECTED clip.
 *
 * Every control is numeric or a button: the same edit is reachable with the
 * keyboard. Source in/out are distinct from composition time, and a still has
 * no source out-point at all.
 */
export const EditorClipInspector: React.FC<{
  document: EditorDocument;
  selectedClipId: string | null;
  playhead: number;
  stage: Stage;
  onSelectClip: (id: string | null) => void;
  onAssign: (asset: EditorAssetRef) => void;
  onAddClip: () => void;
  disabled: boolean;
}> = ({ document, selectedClipId, playhead, stage, onSelectClip, onAssign, onAddClip, disabled }) => {
  const placed = placedClipAt(document, selectedClipId);
  const clip = placed?.clip ?? null;
  const asset = assetForClip(document, clip);
  const library = document.assets;

  const update = (changes: Partial<EditorVisualClip>) => {
    if (!clip) return [];
    return stage([opUpdate('visualClips', clip.id, changes as Record<string, unknown>)]);
  };

  const reorder = (delta: number) => {
    if (!clip) return;
    const ids = moveIds(visualOrder(document), clip.id, delta);
    if (ids) stage([opReorder(ids)]);
  };

  const trimStart = () => {
    if (!placed || !clip) return;
    const delta = round3(playhead - placed.startSec);
    if (!(delta > 0.05)) return;
    update({
      durationSec: round3(clip.durationSec - delta),
      sourceInSec: asset?.kind === 'video' ? round3((clip.sourceInSec ?? 0) + delta) : null,
    });
  };

  const trimEnd = () => {
    if (!placed || !clip) return;
    const duration = round3(playhead - placed.startSec);
    if (!(duration > 0.05)) return;
    update({
      durationSec: duration,
      sourceOutSec: asset?.kind === 'video' ? round3((clip.sourceInSec ?? 0) + duration) : null,
    });
  };

  /** The page validates the split against the document and refuses an out-of-range one with the reason. */
  const split = () => {
    if (!clip) return;
    stage([opSplit(clip.id, playhead)]);
  };

  const zoom = (factor: number) => {
    if (!clip) return;
    const next = clampBox({
      x: round3(clip.crop.x + (clip.crop.width * (1 - factor)) / 2),
      y: round3(clip.crop.y + (clip.crop.height * (1 - factor)) / 2),
      width: round3(clip.crop.width * factor),
      height: round3(clip.crop.height * factor),
    });
    update({ crop: next });
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Clip inspector</h3>
        <div className="row">
          <button className="btn sm" onClick={onAddClip} disabled={disabled}>
            + Add empty clip
          </button>
        </div>
      </div>

      {!clip || !placed ? (
        <div className="banner info">Select a clip on the timeline (or press “Focus first clip”) to trim, split, reorder, crop or replace it.</div>
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <b className="mono">{clip.id}</b>
              <div className="small">
                composition {placed.startSec.toFixed(2)}–{placed.endSec.toFixed(2)}s · duration {clip.durationSec.toFixed(2)}s
              </div>
            </div>
            <div className="row">
              {clip.locked ? <Tag kind="warn">locked</Tag> : <Tag>unlocked</Tag>}
              <button
                className="btn sm"
                disabled={disabled}
                onClick={() => update({ locked: !clip.locked })}
              >
                {clip.locked ? 'Unlock clip' : 'Lock clip'}
              </button>
            </div>
          </div>

          <div className="mt">
            <Provenance asset={asset} />
            {!asset && clip.sourceAssetId ? (
              <div className="banner warn" style={{ marginTop: 8 }}>
                This clip references <span className="mono">{clip.sourceAssetId}</span>, but the document's asset table does not describe it yet.
                The editor shows the id rather than inventing a kind, source or licence for it.
              </div>
            ) : null}
          </div>

          <div className="mt">
            <Select
              label="Replace with a library asset (this binds the file to THIS clip)"
              value={asset?.id ?? clip.sourceAssetId ?? ''}
              disabled={disabled}
              options={[{ value: '', label: '— choose an asset —' }, ...library.map((item) => ({ value: item.id, label: `${item.name} — ${kindLabel(item.kind)}${item.durationSec === null ? '' : ` · ${seconds(item.durationSec)}`}` }))]}
              onCommit={(id) => {
                const next = library.find((item) => item.id === id);
                if (next) onAssign(next);
              }}
            />
            {asset ? (
              <button className="btn sm danger" disabled={disabled} onClick={() => update({ sourceAssetId: null })}>
                Unbind asset (the file stays in the library)
              </button>
            ) : null}
          </div>

          <div className="grid2 mt">
            <NumberInput label="Duration" value={clip.durationSec} min={0.1} step={0.1} suffix="seconds" disabled={disabled || clip.locked} onCommit={(value) => update({ durationSec: round3(Math.max(0.1, value)) })} />
            <NumberInput
              label="Source in"
              value={clip.sourceInSec ?? 0}
              min={0}
              step={0.1}
              suffix="seconds into the file"
              disabled={disabled || clip.locked || asset?.kind !== 'video'}
              onCommit={(value) => update({ sourceInSec: round3(Math.max(0, value)) })}
            />
            <NumberInput
              label="Source out (stills have none)"
              value={clip.sourceOutSec ?? 0}
              min={0}
              step={0.1}
              suffix="seconds into the file"
              disabled={disabled || clip.locked || clip.sourceOutSec === null}
              onCommit={(value) => update({ sourceOutSec: round3(value) })}
            />
            <Select
              label="Motion preset (still animation only)"
              value={clip.motion}
              disabled={disabled || clip.locked || asset?.kind === 'video'}
              options={IMAGE_MOTIONS.map((motion) => ({ value: motion, label: motionLabel(motion) }))}
              onCommit={(value) => update({ motion: value as ImageMotion })}
            />
            <Select
              label="Transition in"
              value={clip.transition}
              disabled={disabled || clip.locked}
              options={CLIP_TRANSITIONS.map((transition) => ({ value: transition, label: transition }))}
              onCommit={(value) => update({ transition: value as ClipTransition })}
            />
          </div>

          <h4 className="small" style={{ marginBottom: 4 }}>Crop / zoom (normalized source coordinates)</h4>
          <div className="grid2">
            <NumberInput label="crop x" value={clip.crop.x} step={0.01} min={0} max={1} disabled={disabled || clip.locked} onCommit={(value) => update({ crop: clampBox({ ...clip.crop, x: value }) })} />
            <NumberInput label="crop y" value={clip.crop.y} step={0.01} min={0} max={1} disabled={disabled || clip.locked} onCommit={(value) => update({ crop: clampBox({ ...clip.crop, y: value }) })} />
            <NumberInput label="crop width" value={clip.crop.width} step={0.01} min={0.01} max={1} disabled={disabled || clip.locked} onCommit={(value) => update({ crop: clampBox({ ...clip.crop, width: value }) })} />
            <NumberInput label="crop height" value={clip.crop.height} step={0.01} min={0.01} max={1} disabled={disabled || clip.locked} onCommit={(value) => update({ crop: clampBox({ ...clip.crop, height: value }) })} />
          </div>
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="btn sm" disabled={disabled || clip.locked} onClick={() => zoom(0.9)}>Zoom in 10%</button>
            <button className="btn sm" disabled={disabled || clip.locked} onClick={() => zoom(1.1)}>Zoom out 10%</button>
            <button className="btn sm ghost" disabled={disabled || clip.locked} onClick={() => update({ crop: { ...FULL_FRAME } })}>Reset crop</button>
          </div>

          <h4 className="small" style={{ marginBottom: 4 }}>Trim and reorder</h4>
          <div className="row">
            <button className="btn sm" disabled={disabled || clip.locked} onClick={trimStart} title="Trim the start to the playhead and keep the source mapping">
              Trim start → playhead
            </button>
            <button className="btn sm" disabled={disabled || clip.locked} onClick={trimEnd} title="Trim the end to the playhead">
              Trim end → playhead
            </button>
            <button className="btn sm primary" disabled={disabled || clip.locked} onClick={split} title="Split at the playhead; the source position and total duration are preserved">
              Split at playhead
            </button>
          </div>
          <div className="row mt">
            <button className="btn sm" disabled={disabled || clip.locked} onClick={() => reorder(-1)}>← Move earlier</button>
            <button className="btn sm" disabled={disabled || clip.locked} onClick={() => reorder(1)}>Move later →</button>
            <button className="btn sm danger" disabled={disabled || clip.locked} onClick={() => { stage([opRemove('visualClips', clip.id)]); onSelectClip(null); }}>
              Delete clip
            </button>
          </div>
          <p className="small" style={{ marginTop: 8 }}>
            Reordering rewrites composition starts only: each clip keeps its duration, captions and audio are untouched, and no narration is
            regenerated.
          </p>
        </>
      )}
    </div>
  );
};
