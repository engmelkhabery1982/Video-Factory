/**
 * Milestone 1 editor (apps/web).
 *
 * A practical editor over the FIXED v1 contract: project content profile and
 * channel identity, an asset panel that actually binds a library file to a
 * selected clip, a timeline with select/reorder/split/trim/replace/crop/motion/
 * lock, undo/redo through the contract, RTL captions with their own intervals,
 * timed highlights with measured display coordinates, an alignment review flow
 * with real blockers, and a range-limited server preview whose result is
 * labelled STALE when it no longer matches the document.
 *
 * Honesty rules enforced here (not in prose):
 *   - a failed save is a failure: pending edits are kept and never reported as
 *     saved, and there is no fallback to fixture data,
 *   - a 409 REVISION_CONFLICT is surfaced with the server's current revision and
 *     two explicit resolutions; the document is never overwritten silently,
 *   - a missing engine (alignment, render, speech) is reported as unavailable
 *     with its reason instead of being papered over,
 *   - the browser assembly preview and the server render are labelled
 *     differently and never substituted for one another.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Banner, Tag } from '../components/ui';
import { api } from '../lib/api';
import {
  acceptAlignment,
  commitOperations,
  getAlignmentJob,
  getEditor,
  getPreviewJob,
  redoEditor,
  requestAlignment,
  requestPreview,
  undoEditor,
} from '../lib/editor-api';
import { fixtureEnabled } from '../lib/editor-fixture';
import type {
  AlignmentJobResult,
  EditorAssetRef,
  EditorEnvelope,
  EditorOperation,
  EditorTargetId,
  PreviewJobResult,
} from '../lib/editor-types';
import { EDITOR_TARGET_IDS } from '../lib/editor-types';
import {
  FULL_FRAME,
  documentDuration,
  documentFindings,
  describeError,
  localApply,
  nextVisualClipId,
  opInsert,
  opUpdate,
  operationFindings,
  revisionConflictFrom,
  round3,
  summaryOf,
  type ValidationFinding,
} from '../lib/editor-model';
import { EditorStage, type ServerPreviewView } from '../components/editor/EditorStage';
import { EditorTimeline } from '../components/editor/EditorTimeline';
import { EditorClipInspector } from '../components/editor/EditorClipInspector';
import { EditorAssetPanel, EditorDocumentPanel, EditorNarrationPanel, type LibraryAsset } from '../components/editor/EditorMediaPanels';
import { EditorCaptionPanel, EditorHighlightPanel } from '../components/editor/EditorTextPanels';
import { EditorAlignmentPanel, EditorServerPreviewPanel, type PreviewRange } from '../components/editor/EditorServerPanels';
import { EditorDevBar } from '../components/editor/EditorDevBar';
import { FindingsList, type Stage } from '../components/editor/shared';

export const EditorPage: React.FC<{ projectId: string; onBack?: () => void; onNext?: () => void }> = ({ projectId, onBack, onNext }) => {
  const [targetId, setTargetId] = useState<EditorTargetId>('long');
  const [envelope, setEnvelope] = useState<EditorEnvelope | null>(null);
  const [pending, setPending] = useState<EditorOperation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentRevision: number; message: string } | null>(null);
  const [stageFindings, setStageFindings] = useState<ValidationFinding[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [brand, setBrand] = useState<{ id: string; name: string; logoAssetId: string | null } | null>(null);
  const [brandIdentityBound, setBrandIdentityBound] = useState<boolean | null>(null);
  const [brandRefusal, setBrandRefusal] = useState<string | null>(null);
  const [brandError, setBrandError] = useState<string | null>(null);
  const [previewRange, setPreviewRange] = useState<PreviewRange | null>(null);
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<PreviewJobResult | null>(null);
  const [previewBlocker, setPreviewBlocker] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [alignmentJobId, setAlignmentJobId] = useState<string | null>(null);
  const [alignmentResult, setAlignmentResult] = useState<AlignmentJobResult | null>(null);
  const [alignmentBlocker, setAlignmentBlocker] = useState<string | null>(null);
  const [alignmentError, setAlignmentError] = useState<string | null>(null);
  const [alignmentBusy, setAlignmentBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [devTick, setDevTick] = useState(0);

  const fixture = fixtureEnabled();
  const serverDocument = envelope?.document ?? null;
  /** The document being edited: the server revision with the unsaved operations applied locally. */
  const document = useMemo(() => (serverDocument ? localApply(serverDocument, pending) : null), [serverDocument, pending]);
  const dirty = pending.length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await getEditor(projectId, targetId);
      setEnvelope(result);
      setPending([]);
      setSaveError(null);
      setSaveNote(null);
      setConflict(null);
      setStageFindings([]);
    } catch (e) {
      setEnvelope(null);
      setLoadError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, targetId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .assets()
      .then((r) => {
        setLibrary((r.assets ?? []) as LibraryAsset[]);
        setLibraryError(null);
      })
      .catch((e: Error) => setLibraryError(e.message));
    fetch(`/api/projects/${encodeURIComponent(projectId)}/brand`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`brand resolution failed (${res.status})`);
        return (await res.json()) as { brand: { id: string; name: string; logoAssetId: string | null }; identityBound?: boolean; refusal?: string | null };
      })
      .then((r) => {
        setBrand(r.brand);
        setBrandIdentityBound(r.identityBound ?? null);
        setBrandRefusal(r.refusal ?? null);
        setBrandError(null);
      })
      .catch((e: Error) => setBrandError(e.message));
  }, [projectId, devTick]);

  /* ---- staging --------------------------------------------------- */

  const stage: Stage = (operations) => {
    if (!document) return [];
    const findings: ValidationFinding[] = [];
    let running = document;
    for (const operation of operations) {
      const found = operationFindings(running, operation);
      if (found.length) findings.push(...found);
      else running = localApply(running, [operation]);
    }
    if (findings.length) {
      setStageFindings(findings);
      return findings;
    }
    setStageFindings([]);
    setPending((previous) => [...previous, ...operations]);
    setSaveNote(null);
    return [];
  };

  /* ---- save / undo / redo ---------------------------------------- */

  const save = async (baseRevisionOverride?: number) => {
    if (!serverDocument || !pending.length) return;
    setSaving(true);
    setSaveError(null);
    setConflict(null);
    try {
      const result = await commitOperations(projectId, targetId, baseRevisionOverride ?? serverDocument.revision, pending);
      setEnvelope(result);
      setPending([]);
      setSaveNote(`Saved — revision ${result.document.revision}`);
    } catch (e) {
      const conflictInfo = revisionConflictFrom(e);
      setSaveNote(null);
      if (conflictInfo) {
        setConflict(conflictInfo);
        setPending((previous) => [...previous]);
      } else {
        setSaveError(describeError(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const undo = async () => {
    if (!serverDocument || pending.length || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await undoEditor(projectId, targetId, serverDocument.revision);
      setEnvelope(result);
      setSaveNote(`Undone — revision ${result.document.revision}`);
    } catch (e) {
      const conflictInfo = revisionConflictFrom(e);
      if (conflictInfo) setConflict(conflictInfo);
      else setSaveError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const redo = async () => {
    if (!serverDocument || pending.length || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await redoEditor(projectId, targetId, serverDocument.revision);
      setEnvelope(result);
      setSaveNote(`Redone — revision ${result.document.revision}`);
    } catch (e) {
      const conflictInfo = revisionConflictFrom(e);
      if (conflictInfo) setConflict(conflictInfo);
      else setSaveError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  /* ---- jobs ------------------------------------------------------ */

  useEffect(() => {
    if (!previewJobId) return;
    let alive = true;
    const tick = async () => {
      try {
        const result = await getPreviewJob(projectId, previewJobId, previewRange);
        if (!alive) return;
        setPreviewResult(result);
        if (result.status !== 'running') setPreviewJobId(null);
        if (result.error) setPreviewError(result.error);
      } catch (e) {
        if (!alive) return;
        setPreviewError(describeError(e));
        setPreviewJobId(null);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [previewJobId, projectId, previewRange]);

  useEffect(() => {
    if (!alignmentJobId) return;
    let alive = true;
    const tick = async () => {
      try {
        const result = await getAlignmentJob(projectId, alignmentJobId);
        if (!alive) return;
        setAlignmentResult(result);
        if (result.status !== 'running') {
          setAlignmentJobId(null);
          if (pending.length) setSaveNote('Alignment finished. Save or discard your pending edits, then reload to see the new alignment state.');
          else void load();
        }
        if (result.error) setAlignmentError(result.error);
      } catch (e) {
        if (!alive) return;
        setAlignmentError(describeError(e));
        setAlignmentJobId(null);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // `pending`/`load` are intentionally read at completion time, not subscribed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alignmentJobId, projectId]);

  /* ---- actions --------------------------------------------------- */

  const assignAsset = (asset: EditorAssetRef) => {
    if (!document) return;
    const clipId = selectedClipId ?? document.visualClips[0]?.id ?? null;
    if (!clipId) return;
    const clip = document.visualClips.find((item) => item.id === clipId);
    if (!clip) return;
    const changes: Record<string, unknown> = { sourceAssetId: asset.id, sourceInSec: asset.kind === 'video' ? 0 : null };
    if (asset.kind === 'video') {
      changes.sourceOutSec = round3(Math.min(asset.durationSec ?? clip.durationSec, clip.durationSec));
      changes.motion = 'none';
    } else {
      // a still has no source out-point; audio is refused by the validator
      changes.sourceOutSec = null;
    }
    const findings = stage([opUpdate('visualClips', clipId, changes)]);
    if (!findings.length) setSelectedClipId(clipId);
  };

  const addClip = () => {
    if (!document) return;
    const clip = {
      id: nextVisualClipId(document),
      sourceAssetId: null,
      startSec: documentDuration(document),
      durationSec: 3,
      sourceInSec: null,
      sourceOutSec: null,
      crop: { ...FULL_FRAME },
      motion: 'none' as const,
      transition: 'cut' as const,
      locked: false,
    };
    const findings = stage([opInsert('visualClips', clip)]);
    if (!findings.length) setSelectedClipId(clip.id);
  };

  const runPreview = async (range: PreviewRange | null) => {
    if (!serverDocument) return;
    if (pending.length) {
      setPreviewBlocker(null);
      setPreviewError('Save or discard your pending edits first: a server preview renders a frozen revision.');
      return;
    }
    setPreviewBusy(true);
    setPreviewError(null);
    setPreviewBlocker(null);
    setPreviewResult(null);
    setPreviewJobId(null);
    try {
      const start = await requestPreview(projectId, targetId, serverDocument.revision, range);
      if (start.blocker) setPreviewBlocker(start.blocker.message);
      else if (start.jobId) setPreviewJobId(start.jobId);
      else setPreviewBlocker('The server did not return a job id for this render.');
    } catch (e) {
      setPreviewError(describeError(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  const runAlignment = async () => {
    if (!document) return;
    setAlignmentBusy(true);
    setAlignmentBlocker(null);
    setAlignmentError(null);
    setAlignmentResult(null);
    setAlignmentJobId(null);
    try {
      const start = await requestAlignment(projectId, targetId, document.audioClips[0]?.sourceAssetId ?? '');
      if (start.blocker) setAlignmentBlocker(`${start.blocker.message}${start.blocker.missing?.length ? ` Missing: ${start.blocker.missing.join(', ')}.` : ''}`);
      else if (start.jobId) setAlignmentJobId(start.jobId);
      else setAlignmentBlocker('The server did not return an alignment job id.');
    } catch (e) {
      setAlignmentError(describeError(e));
    } finally {
      setAlignmentBusy(false);
    }
  };

  const acceptReviewed = async () => {
    if (!serverDocument || !alignmentResult?.proposalId) return;
    if (pending.length) {
      setAlignmentError('Save or discard your pending edits before accepting a reviewed proposal.');
      return;
    }
    setAlignmentBusy(true);
    try {
      const result = await acceptAlignment(projectId, targetId, alignmentResult.proposalId, serverDocument.revision);
      setEnvelope(result);
      setSaveNote(`Reviewed timing accepted — revision ${result.document.revision}`);
      setReviewed(false);
    } catch (e) {
      const conflictInfo = revisionConflictFrom(e);
      if (conflictInfo) setConflict(conflictInfo);
      else setAlignmentError(describeError(e));
    } finally {
      setAlignmentBusy(false);
    }
  };

  if (loading) return <div className="card">Loading the editor document…</div>;

  if (!document || !envelope) {
    return (
      <div className="card">
        <h2>Editor unavailable</h2>
        <Banner kind="bad">
          {loadError ?? 'The editor document could not be read.'} Nothing was invented in its place: without a document there is no timeline,
          no captions and no render.
        </Banner>
        <div className="row">
          <button className="btn" onClick={() => void load()}>
            Try again
          </button>
          {onBack ? (
            <button className="btn ghost" onClick={onBack}>
              ← Back
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const capabilities = envelope.capabilities ?? {};
  const targets = (capabilities.targets ?? EDITOR_TARGET_IDS).filter((target): target is EditorTargetId => EDITOR_TARGET_IDS.includes(target));
  const summary = summaryOf(document);
  const findings = documentFindings(document);
  const serverPreview: ServerPreviewView | null =
    previewResult?.status === 'ready' && previewResult.mediaUrl
      ? {
          mediaUrl: previewResult.mediaUrl,
          revision: previewResult.revision ?? -1,
          range: previewResult.range ?? null,
          stale: previewResult.revision !== document.revision,
        }
      : null;

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>Editor — {projectId}</h2>
            <p className="sub" style={{ margin: '4px 0 0' }}>
              {summary.clips} clips · {summary.captions} captions · {summary.highlights} highlights · {summary.audio} narration clip(s) ·{' '}
              {summary.durationSec.toFixed(2)}s · revision <span className="mono">{document.revision}</span>
              {summary.lockedItems ? ` · ${summary.lockedItems} locked item(s)` : ''}
              {summary.unboundClips ? ` · ${summary.unboundClips} clip(s) with no asset bound` : ''}
            </p>
          </div>
          <div className="row">
            {onBack ? (
              <button className="btn ghost" onClick={onBack}>
                ← Storyboard
              </button>
            ) : null}
            <button className="btn" disabled={!envelope.undoAvailable || dirty || saving} onClick={() => void undo()} title={dirty ? 'Save or discard your pending edits first.' : 'Undo the last logical edit'}>
              ↶ Undo
            </button>
            <button className="btn" disabled={!envelope.redoAvailable || dirty || saving} onClick={() => void redo()} title={dirty ? 'Save or discard your pending edits first.' : 'Redo'}>
              ↷ Redo
            </button>
            {dirty ? (
              <button className="btn ghost" disabled={saving} onClick={() => { setPending([]); setSaveNote('Pending edits discarded. The server document is unchanged.'); }}>
                Discard {pending.length} pending edit(s)
              </button>
            ) : null}
            <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : `Save${dirty ? ` (${pending.length})` : ''}`}
            </button>
            {onNext ? (
              <button className="btn" onClick={onNext}>
                Captions &amp; export →
              </button>
            ) : null}
          </div>
        </div>

        <div className="row mt">
          <span className="small">target:</span>
          {targets.map((target) => (
            <button
              key={target}
              className={`step ${target === targetId ? 'active' : ''}`}
              disabled={saving || dirty}
              title={dirty ? 'Save or discard your pending edits before switching target.' : `Edit ${target}`}
              onClick={() => {
                setTargetId(target);
                setSelectedClipId(null);
                setSelectedCaptionId(null);
                setSelectedHighlightId(null);
                setPlayhead(0);
              }}
            >
              {target}
            </button>
          ))}
          <span className="small">·</span>
          <span className="small">{dirty ? `${pending.length} operation(s) not saved` : 'no unsaved changes'}</span>
        </div>
      </div>

      {fixture ? <EditorDevBar revision={document.revision} mediaUrls={document.assets.map((asset) => asset.mediaUrl).filter(Boolean)} onChanged={() => setDevTick((value) => value + 1)} /> : null}
      {fixture ? (
        <Banner kind="warn">
          DEVELOPMENT FIXTURE MODE is on: this screen is driven by the frontend fixture for the agreed contract, not by <span className="mono">apps/api</span>.
          Every save, alignment result and render badge below is a labelled fixture. The browser assembly preview is the real editor either way.
        </Banner>
      ) : null}
      {saveNote ? <Banner kind="ok">{saveNote}</Banner> : null}
      {saveError ? (
        <Banner kind="bad">
          <b>The save failed and nothing was persisted.</b> {saveError} Your {pending.length} pending edit(s) are kept — fix the problem and save
          again.
        </Banner>
      ) : null}
      {conflict ? (
        <Banner kind="bad">
          <b>Revision conflict.</b> {conflict.message}
          {Number.isFinite(conflict.currentRevision) ? ` The server is at revision ${conflict.currentRevision}.` : ''} Nothing was overwritten.
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm primary" disabled={saving} onClick={() => void save(conflict.currentRevision)}>
              Keep my {pending.length} edit(s) and apply them on revision {conflict.currentRevision}
            </button>
            <button className="btn sm" disabled={saving} onClick={() => { setConflict(null); void load(); }}>
              Discard my edits and reload the server revision
            </button>
          </div>
        </Banner>
      ) : null}
      <FindingsList findings={stageFindings} />
      {findings.length ? (
        <Banner kind="warn">
          <b>The editor document has {findings.length} outstanding validation finding(s).</b> They are shown, not hidden — saving is still
          allowed, but the server may refuse the same document.
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {findings.slice(0, 6).map((finding, index) => (
              <li key={index}>
                <span className="mono">{finding.field}</span> — {finding.message}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <div className="editor-layout">
        <div>
          <EditorStage
            document={document}
            playhead={playhead}
            setPlayhead={setPlayhead}
            playing={playing}
            setPlaying={setPlaying}
            stage={stage}
            selectedHighlightId={selectedHighlightId}
            onSelectHighlight={setSelectedHighlightId}
            serverPreview={serverPreview}
          />
          <EditorTimeline
            document={document}
            playhead={playhead}
            setPlayhead={setPlayhead}
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            selectedAudioId={selectedAudioId}
            onSelectAudio={setSelectedAudioId}
            selectedCaptionId={selectedCaptionId}
            onSelectCaption={setSelectedCaptionId}
            selectedHighlightId={selectedHighlightId}
            onSelectHighlight={setSelectedHighlightId}
          />
          <EditorClipInspector
            document={document}
            selectedClipId={selectedClipId}
            playhead={playhead}
            stage={stage}
            onSelectClip={setSelectedClipId}
            onAssign={assignAsset}
            onAddClip={addClip}
            disabled={saving}
          />
          <EditorCaptionPanel
            document={document}
            playhead={playhead}
            selectedCaptionId={selectedCaptionId}
            onSelectCaption={setSelectedCaptionId}
            stage={stage}
            disabled={saving}
          />
          <EditorHighlightPanel
            document={document}
            playhead={playhead}
            selectedHighlightId={selectedHighlightId}
            onSelectHighlight={setSelectedHighlightId}
            stage={stage}
            disabled={saving}
          />
        </div>
        <div>
          <EditorDocumentPanel
            document={document}
            capabilities={capabilities}
            brand={brand}
            brandIdentityBound={brandIdentityBound}
            brandRefusal={brandRefusal}
            brandError={brandError}
            stage={stage}
            disabled={saving}
          />
          <EditorAssetPanel
            document={document}
            library={library}
            libraryError={libraryError}
            uploadBusy={uploadBusy}
            selectedClipId={selectedClipId}
            onUpload={async (file) => {
              setUploadBusy(true);
              try {
                const form = new FormData();
                form.append('file', file);
                await api.uploadAsset(form);
                const refreshed = await api.assets();
                setLibrary((refreshed.assets ?? []) as LibraryAsset[]);
                setLibraryError(null);
              } catch (e) {
                setLibraryError((e as Error).message);
              } finally {
                setUploadBusy(false);
              }
            }}
            onAssign={assignAsset}
            disabled={saving}
          />
          <EditorNarrationPanel document={document} selectedAudioId={selectedAudioId} onSelectAudio={setSelectedAudioId} stage={stage} disabled={saving} />
          <EditorAlignmentPanel
            document={document}
            capabilities={capabilities}
            jobId={alignmentJobId}
            result={alignmentResult}
            blocker={alignmentBlocker}
            error={alignmentError}
            busy={alignmentBusy}
            reviewed={reviewed}
            onReviewedChange={setReviewed}
            onRequest={() => void runAlignment()}
            onAccept={() => void acceptReviewed()}
            disabled={saving}
          />
          <EditorServerPreviewPanel
            document={document}
            capabilities={capabilities}
            range={previewRange}
            onRangeChange={setPreviewRange}
            jobId={previewJobId}
            result={previewResult}
            blocker={previewBlocker}
            error={previewError}
            busy={previewBusy}
            dirty={dirty}
            playhead={playhead}
            onRequest={(range) => void runPreview(range)}
          />
          <div className="card">
            <h3>Save state</h3>
            <div className="small" style={{ lineHeight: 1.8 }}>
              revision: <span className="mono">{document.revision}</span> · undo {envelope.undoAvailable ? 'available' : 'not available'} ·
              redo {envelope.redoAvailable ? 'available' : 'not available'} · pending operations{' '}
              <span className="mono">{pending.length}</span>
              <div>
                {dirty ? <Tag kind="warn">unsaved changes — they exist only in this browser</Tag> : <Tag kind="ok">matches the saved revision</Tag>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
