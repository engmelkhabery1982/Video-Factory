/**
 * VS4 — "Narration from outside the app" panel.
 *
 * The two narration sources of this product sit next to each other on the same
 * page:
 *   1. Voice & Audio — narration generated INSIDE the app (no local engine is
 *      required for the other path);
 *   2. this panel — narration produced OUTSIDE the app (Kaggle, a studio, a
 *      licensed vendor), imported as a file.
 *
 * The panel is deliberately explicit about what a declaration is and is not:
 * typing an engine name documents the source, it does not verify the rights,
 * and only listening to the exact imported bytes plus an explicit approval
 * makes the narration usable. It never claims estimated scene timing is
 * verified alignment.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { ExternalTimingReview, type TimingReviewPayload } from './ExternalTimingReview';
import { Banner, Field, Tag } from './ui';

export interface ExternalNarrationFinding {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  remediation: string;
}

/** Server projection. The panel displays these strings; it does not decide them. */
export interface ExternalNarrationReadinessLine {
  key: string;
  label: string;
  state: string;
  ok: boolean | null;
  detail: string;
}

export interface ExternalNarrationReadinessBlocker {
  code: string;
  message: string;
  remediation: string;
  control: string;
  where: 'captions';
}

export interface ExternalNarrationReadinessSummary {
  applies: boolean;
  inheritsLongNarration: boolean;
  exportAttemptReady: boolean;
  publicationApproved: false;
  lines: ExternalNarrationReadinessLine[];
  blockers: ExternalNarrationReadinessBlocker[];
}

export interface ExternalNarrationTargetView {
  targetId: 'long' | 'short_1' | 'short_2' | 'short_3';
  label: string;
  import: {
    importId: string;
    fileName: string;
    durationSec: number;
    scriptText: string;
    scriptSha256: string;
    declaration: {
      sourceKind: 'own_recording' | 'authorized_external_synthesis';
      ownershipConfirmed: boolean;
      ownershipStatement: string;
      speakerName: string;
      speakerId?: string | null;
      engineName?: string | null;
      modelName?: string | null;
      voiceName?: string | null;
      sourceNotes?: string | null;
    };
    alignment: {
      mode: 'exact_scene_timing' | 'estimated_from_script' | 'none';
      verified: boolean;
      sceneCount: number | null;
      detail: string;
    } | null;
    createdAt: string;
  } | null;
  approval: {
    decision: 'approved' | 'rejected';
    listened: boolean;
    decidedAt: string;
    decidedBy: string;
    note?: string;
    timingRevision: string;
  } | null;
  ready: boolean;
  summary: string;
  blockReasons: string[];
  findings: ExternalNarrationFinding[];
  alignment: {
    mode: 'exact_scene_timing' | 'estimated_from_script' | 'none';
    verified: boolean;
    sceneCount: number | null;
    detail: string;
  } | null;
  audioDurationSec: number | null;
  timelineDurationSec: number | null;
  endCardSeconds: number;
  timingRevision: string;
  readiness?: ExternalNarrationReadinessSummary | null;
}

export interface ExternalNarrationSummary {
  projectId: string;
  totalTargets: number;
  importedCount: number;
  readyCount: number;
  blockedCount: number;
  targets: ExternalNarrationTargetView[];
}

export interface ExternalNarrationPanelProps {
  projectId: string;
  toast: (text: string, kind?: 'ok' | 'bad' | 'info') => void;
  onAudioChange?: () => void;
}

interface ImportDraft {
  file: File | null;
  scriptText: string;
  sourceKind: 'own_recording' | 'authorized_external_synthesis';
  ownershipConfirmed: boolean;
  ownershipStatement: string;
  speakerName: string;
  engineName: string;
  modelName: string;
  voiceName: string;
  sourceNotes: string;
}

const EMPTY_DRAFT: ImportDraft = {
  file: null,
  scriptText: '',
  sourceKind: 'own_recording',
  ownershipConfirmed: false,
  ownershipStatement: '',
  speakerName: '',
  engineName: '',
  modelName: '',
  voiceName: '',
  sourceNotes: '',
};

function formatSeconds(value: number | null): string {
  if (value === null || value === undefined) return '—';
  if (value < 60) return `${value.toFixed(2)}s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${minutes}m ${seconds}s (${value.toFixed(2)}s)`;
}

function sourceLabel(kind: string | undefined): string {
  if (kind === 'own_recording') return 'my own recording';
  if (kind === 'authorized_external_synthesis') return 'authorized external synthesis';
  return 'not declared';
}

/**
 * Renders the server readiness projection. It does not recompute approval,
 * coverage, or publication. `onFix` is the existing Captions navigation.
 */
export const ExternalNarrationReadinessCard: React.FC<{
  target: ExternalNarrationTargetView;
  onFix?: () => void;
}> = ({ target, onFix }) => {
  const readiness = target.readiness;
  if (!readiness) return null;
  const publication = readiness.lines.find((line) => line.key === 'publication');
  return (
    <div
      data-testid={`external-readiness-${target.targetId}`}
      style={{ margin: '8px 0', fontSize: 12, lineHeight: 1.55 }}
    >
      <div className="row" style={{ gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <Tag kind={readiness.exportAttemptReady ? 'ok' : readiness.applies || readiness.inheritsLongNarration ? 'warn' : ''}>
          {readiness.lines.find((line) => line.key === 'export')?.state ?? 'Readiness'}
        </Tag>
        <Tag kind="">{publication?.state ?? 'Not publication approved'}</Tag>
      </div>
      <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>
        {readiness.lines.map((line) => (
          <li key={line.key}>
            <b>{line.label}:</b> {line.state}. {line.detail}
          </li>
        ))}
      </ul>
      {readiness.blockers.length > 0 ? (
        <ul style={{ margin: '0 0 6px', paddingLeft: 18, color: '#ffd166' }}>
          {readiness.blockers.map((blocker) => (
            <li key={`${blocker.code}-${blocker.message}`}>
              {blocker.message} {blocker.remediation} Fix with {blocker.control} on Captions.
            </li>
          ))}
        </ul>
      ) : null}
      {onFix ? (
        <button
          className="btn sm"
          type="button"
          onClick={onFix}
          aria-label={`Open narration review for ${target.label}`}
        >
          Open narration review
        </button>
      ) : null}
    </div>
  );
};

export const ExternalNarrationPanel: React.FC<ExternalNarrationPanelProps> = ({
  projectId,
  toast,
  onAudioChange,
}) => {
  const [summary, setSummary] = useState<ExternalNarrationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [openTarget, setOpenTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState<ImportDraft>(EMPTY_DRAFT);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [listened, setListened] = useState<Record<string, boolean>>({});
  const [timingFor, setTimingFor] = useState<string | null>(null);
  const [timing, setTiming] = useState<any | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});

  const load = useCallback(async () => {
    try {
      setPanelError(null);
      const data = (await api.externalNarration(projectId)) as ExternalNarrationSummary;
      setSummary(data);
    } catch (err: any) {
      setPanelError(err?.message ?? 'Failed to load the imported narration state.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const targets = summary?.targets ?? [];

  const startImport = (targetId: string) => {
    setOpenTarget(targetId === openTarget ? null : targetId);
    setDraft(EMPTY_DRAFT);
    setPanelError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const submitImport = async (targetId: string) => {
    if (!draft.file) {
      setPanelError('Choose the narration file to import.');
      return;
    }
    if (!draft.scriptText.trim()) {
      setPanelError('Enter the exact spoken script of this narration.');
      return;
    }
    if (!draft.speakerName.trim()) {
      setPanelError('Name the speaker heard in this narration.');
      return;
    }
    if (!draft.ownershipConfirmed || !draft.ownershipStatement.trim()) {
      setPanelError('Confirm that you own this recording or are authorized to publish it, and type the statement.');
      return;
    }
    setBusyTarget(targetId);
    setPanelError(null);
    try {
      const form = new FormData();
      form.append('file', draft.file);
      form.append('scriptText', draft.scriptText);
      form.append('sourceKind', draft.sourceKind);
      form.append('ownershipConfirmed', 'true');
      form.append('ownershipStatement', draft.ownershipStatement);
      form.append('speakerName', draft.speakerName);
      if (draft.engineName.trim()) form.append('engineName', draft.engineName.trim());
      if (draft.modelName.trim()) form.append('modelName', draft.modelName.trim());
      if (draft.voiceName.trim()) form.append('voiceName', draft.voiceName.trim());
      if (draft.sourceNotes.trim()) form.append('sourceNotes', draft.sourceNotes.trim());
      const res = await api.importExternalNarration(projectId, targetId, form);
      setOpenTarget(null);
      setDraft(EMPTY_DRAFT);
      await load();
      const view = res?.view as ExternalNarrationTargetView | undefined;
      toast(
        view
          ? `Imported ${view.label} narration (${formatSeconds(view.audioDurationSec)} measured). Regenerate the storyboard, then listen and approve.`
          : 'Narration imported.',
        'ok',
      );
      if (onAudioChange) onAudioChange();
    } catch (err: any) {
      setPanelError(err?.message ?? 'The narration could not be imported.');
      toast(err?.message ?? 'The narration could not be imported.', 'bad');
    } finally {
      setBusyTarget(null);
    }
  };

  const approve = async (targetId: string, decision: 'approved' | 'rejected') => {
    setBusyTarget(targetId);
    setPanelError(null);
    try {
      await api.externalNarrationApproval(projectId, targetId, {
        decision,
        listened: decision === 'approved' ? listened[targetId] === true : false,
        decidedBy: 'project-owner',
      });
      await load();
      toast(decision === 'approved' ? 'Narration approved for this target.' : 'Narration rejected.', 'ok');
      if (onAudioChange) onAudioChange();
    } catch (err: any) {
      setPanelError(err?.message ?? 'The approval could not be recorded.');
      toast(err?.message ?? 'The approval could not be recorded.', 'bad');
    } finally {
      setBusyTarget(null);
    }
  };

  const showTiming = async (targetId: string) => {
    if (timingFor === targetId) {
      setTimingFor(null);
      setTiming(null);
      return;
    }
    try {
      const data = await api.externalNarrationTiming(projectId, targetId);
      setTiming(data?.timing ?? null);
      setTimingFor(targetId);
    } catch (err: any) {
      setPanelError(err?.message ?? 'The timing review could not be loaded.');
    }
  };

  if (loading && !summary) {
    return (
      <div className="card external-narration-panel" aria-busy="true" aria-live="polite">
        <h3 id="external-narration-heading">Narration from outside the app</h3>
        <p className="sub">Loading imported narration…</p>
      </div>
    );
  }

  return (
    <div className="card external-narration-panel" aria-labelledby="external-narration-heading">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h3 id="external-narration-heading" style={{ fontSize: 16, margin: '0 0 4px', color: 'var(--text)' }}>
            Narration from outside the app
          </h3>
          <p className="sub" style={{ margin: 0 }}>
            {summary?.importedCount ?? 0} of {summary?.totalTargets ?? 0} targets use imported narration
            {summary && summary.importedCount > 0
              ? ` · ${summary.readyCount} ready to attempt export · ${summary.blockedCount} blocked`
              : ' · none imported yet'}
          </p>
        </div>
        <div className="row">
          {summary && summary.importedCount > 0 && summary.blockedCount === 0 ? (
            <Tag kind="ok">Ready to attempt export</Tag>
          ) : summary && summary.blockedCount > 0 ? (
            <Tag kind="warn">⚠ {summary.blockedCount} blocked</Tag>
          ) : (
            <Tag kind="">Nothing imported</Tag>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <p className="sub" style={{ margin: '0 0 8px', fontSize: 12.5, lineHeight: 1.6 }}>
          Two ways to get narration into a target. <strong>Generate inside the app</strong> uses the Voice &amp; Audio
          panel above. <strong>Import from outside</strong> takes a file you produced elsewhere (for example on Kaggle)
          — no local voice engine is needed, nothing is downloaded and no model is provisioned.
        </p>
        <Banner kind="info">
          Declaring where a file came from documents the source. It is not a rights check. Only listening to the exact
          imported bytes and approving them makes the narration usable. Ready to attempt export is not publication
          approval, and a later render would not be commercial-rights clearance. Scene timing is regenerated from the
          measured audio duration — accepted audio is never trimmed to fit old scene durations. Estimated timing is
          not acoustic alignment.
        </Banner>
      </div>

      {panelError && (
        <Banner kind="bad">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{panelError}</span>
            <button className="btn sm ghost" onClick={() => setPanelError(null)} aria-label="Dismiss error">
              ✕
            </button>
          </div>
        </Banner>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {targets.map((target) => {
          const isOpen = openTarget === target.targetId;
          const isBusy = busyTarget === target.targetId;
          const imported = target.import !== null;
          const approved = target.approval?.decision === 'approved';
          return (
            <div
              key={target.targetId}
              className="target-audio-row"
              data-testid={`external-narration-${target.targetId}`}
              style={{
                padding: '12px 16px',
                background: '#0b192c',
                border: `1px solid ${target.ready ? 'var(--line)' : imported ? '#4a3215' : 'var(--line)'}`,
                borderRadius: 10,
              }}
            >
              <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{target.label}</span>
                {!imported && !target.readiness?.inheritsLongNarration && <Tag kind="">No imported narration</Tag>}
                {(imported ? (target.readiness ? target.readiness.exportAttemptReady : target.ready) : false) && (
                  <Tag kind="ok">Ready to attempt export</Tag>
                )}
                {((imported && !(target.readiness ? target.readiness.exportAttemptReady : target.ready)) ||
                  target.readiness?.inheritsLongNarration) && <Tag kind="warn">Blocked</Tag>}
                {approved && <Tag kind="ok">Approved</Tag>}
                {target.approval?.decision === 'rejected' && <Tag kind="bad">Rejected</Tag>}
                {imported && target.alignment?.verified && <Tag kind="warn">Script-matched timing</Tag>}
                {imported && !target.alignment?.verified && <Tag kind="warn">Estimated timing</Tag>}
              </div>

              {imported ? (
                <>
                  <div className="sub" style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}>
                    📄 {target.import!.fileName} · ⏱ {formatSeconds(target.audioDurationSec)} measured · source:{' '}
                    {sourceLabel(target.import!.declaration.sourceKind)} · speaker: {target.import!.declaration.speakerName}
                    {target.import!.declaration.engineName
                      ? ` · documented engine: ${target.import!.declaration.engineName}`
                      : ''}
                    {target.import!.declaration.modelName ? ` / ${target.import!.declaration.modelName}` : ''}
                    {target.import!.declaration.voiceName ? ` / ${target.import!.declaration.voiceName}` : ''}
                  </div>
                  <div className="sub" style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}>
                    Timeline: {formatSeconds(target.timelineDurationSec)} · silent end card:{' '}
                    {formatSeconds(target.endCardSeconds)} · {target.alignment?.detail ?? 'no alignment recorded'}
                  </div>

                  <div style={{ margin: '0 0 8px' }}>
                    <audio
                      controls
                      preload="none"
                      ref={(node) => { audioRefs.current[target.targetId] = node; }}
                      src={api.externalNarrationAudioUrl(projectId, target.targetId)}
                      aria-label={`Listen to the imported narration for ${target.label}`}
                      style={{ width: '100%', maxWidth: 520 }}
                    />
                    <label className="row" style={{ gap: 6, fontSize: 12, marginTop: 6 }}>
                      <input
                        type="checkbox"
                        checked={listened[target.targetId] === true}
                        onChange={(e) => setListened((s) => ({ ...s, [target.targetId]: e.target.checked }))}
                        aria-label={`I listened to the whole imported narration for ${target.label}`}
                      />
                      I listened to the whole file
                    </label>
                  </div>

                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn sm primary"
                      disabled={isBusy || busyTarget !== null || listened[target.targetId] !== true}
                      onClick={() => void approve(target.targetId, 'approved')}
                      aria-label={`Approve the imported narration for ${target.label}`}
                      title={
                        listened[target.targetId] === true
                          ? undefined
                          : 'Listen to the whole file first, then confirm it above.'
                      }
                    >
                      {isBusy ? 'Working…' : 'Approve this exact audio'}
                    </button>
                    <button
                      className="btn sm danger"
                      disabled={isBusy || busyTarget !== null}
                      onClick={() => void approve(target.targetId, 'rejected')}
                      aria-label={`Reject the imported narration for ${target.label}`}
                    >
                      Reject
                    </button>
                    <button
                      className="btn sm ghost"
                      disabled={isBusy || busyTarget !== null}
                      onClick={() => void showTiming(target.targetId)}
                      aria-label={`Review the scene timing for ${target.label}`}
                    >
                      {timingFor === target.targetId ? 'Hide timing review' : 'Review timing'}
                    </button>
                    <button
                      className="btn sm ghost"
                      disabled={isBusy || busyTarget !== null}
                      onClick={() => startImport(target.targetId)}
                      aria-label={`Replace the imported narration for ${target.label}`}
                    >
                      Replace import
                    </button>
                  </div>

                  {target.readiness ? (
                    <ExternalNarrationReadinessCard target={target} />
                  ) : (
                    !target.ready && target.blockReasons.length > 0 && (
                      <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: '#ffd166' }}>
                        {target.blockReasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    )
                  )}

                  {timingFor === target.targetId && timing && (
                    <ExternalTimingReview
                      projectId={projectId}
                      targetId={target.targetId}
                      targetLabel={target.label}
                      timing={timing as TimingReviewPayload}
                      audio={audioRefs.current[target.targetId] ?? null}
                      busy={isBusy}
                      onBusy={(next) => setBusyTarget(next ? target.targetId : null)}
                      onSaved={(next) => {
                        setTiming(next);
                        void load();
                      }}
                      onError={(message) => setPanelError(message)}
                      toast={toast}
                    />
                  )}
                </>
              ) : (
                <>
                  <div className="sub" style={{ margin: '0 0 8px', fontSize: 12 }}>
                    No imported narration. Import a file you produced outside the app, or generate narration inside the
                    app with the Voice &amp; Audio panel. This target will not inherit another target's audio.
                  </div>
                  {target.readiness ? <ExternalNarrationReadinessCard target={target} /> : null}
                </>
              )}

              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <button
                  className={`btn sm ${imported ? 'ghost' : 'primary'}`}
                  disabled={isBusy || busyTarget !== null}
                  onClick={() => startImport(target.targetId)}
                  aria-label={`Import external narration for ${target.label}`}
                >
                  {isOpen ? 'Cancel import' : imported ? 'Replace imported narration' : 'Import external narration'}
                </button>
              </div>

              {isOpen && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Field label="Narration file" hint="WAV, MP3 or M4A. The file is decoded and measured on import; its extension is never trusted.">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4"
                      aria-label={`Choose the narration file for ${target.label}`}
                      onChange={(e) => setDraft((d) => ({ ...d, file: e.target.files?.[0] ?? null }))}
                    />
                  </Field>

                  <Field
                    label="Exact spoken script"
                    hint="The words that are actually spoken, in order. The approval is bound to this text by digest."
                  >
                    <textarea
                      rows={4}
                      value={draft.scriptText}
                      aria-label={`Exact spoken script for ${target.label}`}
                      onChange={(e) => setDraft((d) => ({ ...d, scriptText: e.target.value }))}
                    />
                  </Field>

                  <Field label="Where this narration came from" hint="A declaration, not a rights check.">
                    <div className="row" style={{ gap: 12 }}>
                      <label className="row" style={{ gap: 6, fontSize: 12 }}>
                        <input
                          type="radio"
                          name={`source-${target.targetId}`}
                          value="own_recording"
                          checked={draft.sourceKind === 'own_recording'}
                          onChange={() => setDraft((d) => ({ ...d, sourceKind: 'own_recording' }))}
                          aria-label={`My own recording for ${target.label}`}
                        />
                        My own recording
                      </label>
                      <label className="row" style={{ gap: 6, fontSize: 12 }}>
                        <input
                          type="radio"
                          name={`source-${target.targetId}`}
                          value="authorized_external_synthesis"
                          checked={draft.sourceKind === 'authorized_external_synthesis'}
                          onChange={() => setDraft((d) => ({ ...d, sourceKind: 'authorized_external_synthesis' }))}
                          aria-label={`Authorized external synthesis for ${target.label}`}
                        />
                        Authorized external synthesis
                      </label>
                    </div>
                  </Field>

                  <Field
                    label="Speaker"
                    hint="Who is heard. The approval is bound to this speaker identity."
                  >
                    <input
                      type="text"
                      value={draft.speakerName}
                      aria-label={`Speaker heard in the imported narration for ${target.label}`}
                      onChange={(e) => setDraft((d) => ({ ...d, speakerName: e.target.value }))}
                    />
                  </Field>

                  <Field
                    label="Engine / model / voice (when known)"
                    hint="Documented source information you type in. It is recorded as declared information and is never treated as verification of rights."
                  >
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        placeholder="engine"
                        value={draft.engineName}
                        aria-label={`Declared engine for ${target.label}`}
                        onChange={(e) => setDraft((d) => ({ ...d, engineName: e.target.value }))}
                      />
                      <input
                        type="text"
                        placeholder="model"
                        value={draft.modelName}
                        aria-label={`Declared model for ${target.label}`}
                        onChange={(e) => setDraft((d) => ({ ...d, modelName: e.target.value }))}
                      />
                      <input
                        type="text"
                        placeholder="voice"
                        value={draft.voiceName}
                        aria-label={`Declared voice for ${target.label}`}
                        onChange={(e) => setDraft((d) => ({ ...d, voiceName: e.target.value }))}
                      />
                    </div>
                  </Field>

                  <Field label="Ownership / authorization" hint="Required. Your own confirmation, recorded as a declaration.">
                    <label className="row" style={{ gap: 6, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={draft.ownershipConfirmed}
                        aria-label={`I confirm I may publish the narration for ${target.label}`}
                        onChange={(e) => setDraft((d) => ({ ...d, ownershipConfirmed: e.target.checked }))}
                      />
                      I own this recording, or I am authorized to publish it.
                    </label>
                    <input
                      type="text"
                      placeholder="Confirmation statement (e.g. licensed vendor invoice #1234)"
                      value={draft.ownershipStatement}
                      aria-label={`Ownership confirmation statement for ${target.label}`}
                      onChange={(e) => setDraft((d) => ({ ...d, ownershipStatement: e.target.value }))}
                    />
                  </Field>

                  <div className="row" style={{ gap: 8 }}>
                    <button
                      className="btn sm primary"
                      disabled={isBusy || busyTarget !== null}
                      onClick={() => void submitImport(target.targetId)}
                      aria-label={`Import the selected narration file for ${target.label}`}
                    >
                      {isBusy ? 'Importing…' : 'Import narration'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
