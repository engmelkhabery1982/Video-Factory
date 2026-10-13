import React from 'react';
import { Banner, Tag } from '../ui';
import type { AlignmentJobResult, EditorCapabilities, EditorDocument, PreviewJobResult } from '../../lib/editor-types';
import { documentDuration, round3 } from '../../lib/editor-model';
import { EngineState, NumberInput } from './shared';

export interface PreviewRange {
  startSec: number;
  endSec: number;
}

/**
 * Alignment: request → progress → reviewed proposal → explicit acceptance.
 *
 * A missing runtime is a BLOCKER with the real reason. Times are never guessed,
 * a transcript is not alignment, and accepting a reviewed proposal is kept
 * separate from publishing anything.
 */
export const EditorAlignmentPanel: React.FC<{
  document: EditorDocument;
  capabilities: EditorCapabilities;
  jobId: string | null;
  result: AlignmentJobResult | null;
  blocker: string | null;
  error: string | null;
  busy: boolean;
  reviewed: boolean;
  onReviewedChange: (value: boolean) => void;
  onRequest: () => void;
  onAccept: () => void;
  disabled: boolean;
}> = ({ document, capabilities, jobId, result, blocker, error, busy, reviewed, onReviewedChange, onRequest, onAccept, disabled }) => {
  const state = document.alignment.state;
  const audio = document.audioClips[0] ?? null;
  const rows = result?.rows ?? [];
  const unresolved = rows.filter((row) => row.unresolvedSpan).length;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Narration alignment</h3>
        <div className="row">
          <Tag kind={state === 'approved' ? 'ok' : state === 'unavailable' ? 'bad' : 'accent'}>{state}</Tag>
          <button className="btn sm primary" disabled={disabled || busy || !audio} onClick={onRequest}>
            {busy ? 'Requesting…' : 'Request alignment'}
          </button>
        </div>
      </div>

      <div className="small" style={{ lineHeight: 1.7 }}>
        <EngineState label="Alignment runtime" available={capabilities.alignment?.available === true} reason={capabilities.alignment?.reason ?? null} />
        <div>
          source audio: <span className="mono">{audio ? `${audio.id} (${audio.sourceAssetId})` : 'none'}</span> · audio hash:{' '}
          <span className="mono">{document.alignment.audioHash ?? 'not recorded'}</span> · source revision:{' '}
          <span className="mono">{document.alignment.sourceRevision ?? 'not recorded'}</span> · proposal:{' '}
          <span className="mono">{document.alignment.proposalId ?? 'none'}</span>
        </div>
      </div>

      {blocker ? (
        <Banner kind="bad">
          <b>Alignment did not start.</b> {blocker} No timing was estimated, and no proposal was written.
        </Banner>
      ) : null}
      {error ? <Banner kind="bad">Alignment job failed: {error}</Banner> : null}

      {jobId && !blocker ? (
        <div className="small">
          job <span className="mono">{jobId}</span> — status {result?.status ?? 'running'}
          {result?.status === 'running' ? '…' : ''}
        </div>
      ) : null}

      {rows.length ? (
        <>
          <h4 className="small mt">Review proposal {result?.proposalId ?? ''}</h4>
          <table>
            <thead>
              <tr>
                <th>scene</th>
                <th>cue</th>
                <th>proposed start</th>
                <th>proposed end</th>
                <th>unresolved</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.sceneId}-${row.cueId ?? 'none'}`}>
                  <td className="mono">{row.sceneId}</td>
                  <td className="mono">{row.cueId ?? '—'}</td>
                  <td>{row.proposedStartSec === null ? '—' : `${row.proposedStartSec.toFixed(2)}s`}</td>
                  <td>{row.proposedEndSec === null ? '—' : `${row.proposedEndSec.toFixed(2)}s`}</td>
                  <td>{row.unresolvedSpan ? <Tag kind="warn">unresolved span</Tag> : <Tag kind="ok">emitted</Tag>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {unresolved ? (
            <p className="small">
              {unresolved} span(s) have no emission. They stay unresolved until a reviewed proposal covers them — the editor does not fill
              them in.
            </p>
          ) : null}
          <label className="row small" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={reviewed} onChange={(e) => onReviewedChange(e.target.checked)} /> I reviewed these time bounds
            against the recording.
          </label>
          <div className="row">
            <button className="btn sm primary" disabled={disabled || !reviewed || !result?.proposalId} onClick={onAccept}>
              Accept reviewed timing
            </button>
            <span className="small">
              Accepting the reviewed timing is separate from synthesis rights and from final publication approval.
            </span>
          </div>
        </>
      ) : !blocker && !jobId ? (
        <p className="small">
          A transcript is not alignment and an available model is not an executed result. Until a proposal exists, no times are shown.
        </p>
      ) : null}
    </div>
  );
};

/**
 * Server snapshot preview.
 *
 * The range is explicit and partial: a 15-second window must not render a full
 * minute. The result carries the FROZEN revision it was rendered from, so a
 * render that no longer matches the current edit is labelled STALE instead of
 * being shown as current. The returned URL is the real local media URL.
 */
export const EditorServerPreviewPanel: React.FC<{
  document: EditorDocument;
  capabilities: EditorCapabilities;
  range: PreviewRange | null;
  onRangeChange: (range: PreviewRange | null) => void;
  jobId: string | null;
  result: PreviewJobResult | null;
  blocker: string | null;
  error: string | null;
  busy: boolean;
  dirty: boolean;
  playhead: number;
  onRequest: (range: PreviewRange | null) => void;
}> = ({ document, capabilities, range, onRangeChange, jobId, result, blocker, error, busy, dirty, playhead, onRequest }) => {
  const total = documentDuration(document);
  const stale = result?.status === 'ready' && result.revision !== null && result.revision !== undefined && result.revision !== document.revision;
  const ready = result?.status === 'ready' && result.mediaUrl;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Server snapshot preview</h3>
        <div className="row">
          <Tag kind={ready ? (stale ? 'warn' : 'ok') : 'accent'}>{ready ? (stale ? 'stale render' : 'current render') : 'no render yet'}</Tag>
        </div>
      </div>

      <EngineState label="Preview renderer" available={capabilities.preview?.available === true} reason={capabilities.preview?.reason ?? null} />

      {dirty ? (
        <Banner kind="warn">
          You have unsaved edits. A server render uses a frozen revision, so save first — otherwise the render will not contain what you are
          looking at, and it will be labelled stale.
        </Banner>
      ) : null}

      <div className="grid3 mt">
        <NumberInput
          label="Range start"
          value={range?.startSec ?? round3(playhead)}
          step={0.5}
          min={0}
          suffix="seconds"
          onCommit={(value) => onRangeChange({ startSec: round3(Math.max(0, value)), endSec: range?.endSec ?? round3(Math.max(0, value) + 15) })}
        />
        <NumberInput
          label="Range end"
          value={range?.endSec ?? round3(Math.min(total, playhead + 15))}
          step={0.5}
          min={0}
          suffix="seconds"
          onCommit={(value) => onRangeChange({ startSec: range?.startSec ?? round3(playhead), endSec: round3(Math.max(0, value)) })}
        />
        <div className="field" style={{ marginBottom: 8 }}>
          <label>Range actions</label>
          <div className="row">
            <button className="btn sm" disabled={busy} onClick={() => onRangeChange({ startSec: round3(playhead), endSec: round3(Math.min(total, playhead + 15)) })}>
              playhead → +15s
            </button>
            <button className="btn sm ghost" disabled={busy} onClick={() => onRangeChange(null)}>
              full document
            </button>
          </div>
        </div>
      </div>

      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => onRequest(range)}>
          {busy ? 'Requesting…' : range ? `Render ${round3(range.endSec - range.startSec).toFixed(1)}s range` : 'Render full preview'}
        </button>
        <span className="small">
          {range ? `A partial preview renders only ${round3(range.endSec - range.startSec).toFixed(1)}s, from a frozen revision.` : 'No range selected: the whole document.'}
        </span>
      </div>

      {blocker ? (
        <Banner kind="warn">
          <b>No render was started.</b> {blocker}
        </Banner>
      ) : null}
      {error ? <Banner kind="bad">The preview job failed: {error}</Banner> : null}
      {jobId && !ready && !error ? (
        <div className="small">
          job <span className="mono">{jobId}</span> — status {result?.status ?? 'running'}
        </div>
      ) : null}

      {ready ? (
        <div className="mt">
          <div className={`banner ${stale ? 'warn' : 'ok'}`}>
            {stale ? (
              <>
                <b>STALE.</b> This file was rendered from revision {result?.revision}, and the document is now at revision {document.revision}.
                It does not contain your current edit.
              </>
            ) : (
              <>
                <b>Current.</b> Rendered from revision {result?.revision}
                {result?.range ? ` · range ${result.range.startSec.toFixed(2)}–${result.range.endSec.toFixed(2)}s` : ' · full document'}.
              </>
            )}
          </div>
          <div className="preview-stage">
            <video src={result!.mediaUrl!} controls muted playsInline style={{ width: '100%' }} />
          </div>
          <div className="small mono" style={{ marginTop: 6, wordBreak: 'break-all' }}>
            returned media URL: {result!.mediaUrl}
          </div>
        </div>
      ) : null}

      <p className="small" style={{ marginTop: 8 }}>
        The browser assembly preview above the timeline is an editing aid. It is labelled distinctly and is never presented as this render.
      </p>
    </div>
  );
};
