/**
 * Panels for a draft made by Gemini: voices and short previews, the apply count confirmation,
 * and the shot list with exports. Each one reads the server's own numbers. Nothing here calls
 * the provider on load, typing, saving, polling or reopening.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Banner, Tag } from '../ui';
import {
  FactoryApiError,
  GEMINI_VOICE_NAMES,
  type AiJob,
  type AiStatus,
  type ApplyPreview,
  type FactoryAiClient,
  type FactoryDraftEnvelope,
  type ShotList,
} from '../../lib/factory-api';
import type { PlanLibraryItem } from '../../pages/ContentPlan';
import { applyCountView, failureAdvice, jobStatusView, previewInput, previewsLeft } from '../../lib/gemini-plan-model';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

/* ---------------------------------------------------------------- voices */

export interface GeminiVoicesPanelProps {
  ai: FactoryAiClient;
  env: FactoryDraftEnvelope;
  status: AiStatus | null;
  pollMs: number;
  disabled: boolean;
  onAdopt: (env: FactoryDraftEnvelope) => void;
  onStatus: () => void;
}

export const GeminiVoicesPanel: React.FC<GeminiVoicesPanelProps> = ({ ai, env, status, pollMs, disabled, onAdopt, onStatus }) => {
  const speakers = env.speakers.filter((s) => s.available);
  const [voiceEdits, setVoiceEdits] = useState<Record<string, { voice: string; style: string }>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, { text: string; language: 'ar' | 'en' }>>({});
  const [previewJob, setPreviewJob] = useState<Record<string, AiJob | null>>({});
  const [previewError, setPreviewError] = useState<Record<string, { code: string; message: string }>>({});
  const [busy, setBusy] = useState(false);

  const firstLineFor = (speakerId: string): { text: string; language: 'ar' | 'en' } => {
    const selected = env.treatments.find((t) => t.id === env.selectedTreatmentId);
    const line = selected?.scenes.find((s) => s.speakerId === speakerId);
    return { text: line?.narration ?? '', language: line?.language === 'ar' ? 'ar' : 'en' };
  };
  const previewFor = (speakerId: string) => preview[speakerId] ?? firstLineFor(speakerId);
  const voiceOf = (speakerId: string) => {
    const sp = speakers.find((s) => s.id === speakerId);
    return voiceEdits[speakerId]?.voice ?? sp?.voiceId ?? GEMINI_VOICE_NAMES[0];
  };
  const styleOf = (speakerId: string) => {
    const sp = speakers.find((s) => s.id === speakerId);
    return voiceEdits[speakerId]?.style ?? sp?.style ?? '';
  };

  const save = async () => {
    const changes = speakers
      .filter((s) => voiceEdits[s.id] !== undefined)
      .map((s) => ({ id: s.id, voice: voiceEdits[s.id].voice, style: voiceEdits[s.id].style }))
      .filter((c) => {
        const sp = speakers.find((s) => s.id === c.id);
        return c.voice !== sp?.voiceId || c.style !== (sp?.style ?? '');
      });
    if (changes.length === 0) return;
    setBusy(true);
    setSaveError(null);
    try {
      const next = await ai.patchGenerated(env.draftId, { expectedRevision: env.revision, speakers: changes });
      setVoiceEdits({});
      onAdopt(next);
    } catch (e) {
      // The edits stay on screen so nothing is lost. A conflict says so and asks for a reload.
      setSaveError(`${(e as FactoryApiError).code}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (speakerId: string) => {
    const p = previewFor(speakerId);
    const check = previewInput(p.text);
    if (!check.ok) {
      setPreviewError((m) => ({ ...m, [speakerId]: { code: 'FACTORY_VALIDATION', message: check.reason ?? '' } }));
      return;
    }
    setPreviewError((m) => {
      const next = { ...m };
      delete next[speakerId];
      return next;
    });
    setBusy(true);
    try {
      const { job } = await ai.startSpeechPreview({ text: p.text.trim(), voice: voiceOf(speakerId), language: p.language, style: styleOf(speakerId) });
      setPreviewJob((m) => ({ ...m, [speakerId]: job }));
      onStatus();
      let current = job;
      while (!TERMINAL.has(current.status)) {
        await new Promise((r) => window.setTimeout(r, pollMs));
        current = await ai.getJob(job.id);
        setPreviewJob((m) => ({ ...m, [speakerId]: current }));
      }
      if (current.status !== 'succeeded') {
        setPreviewError((m) => ({ ...m, [speakerId]: { code: current.error?.code ?? current.status, message: current.error?.message ?? current.status } }));
      }
      onStatus();
    } catch (e) {
      setPreviewError((m) => ({ ...m, [speakerId]: { code: (e as FactoryApiError).code ?? 'FACTORY_HTTP', message: (e as Error).message } }));
      onStatus();
    } finally {
      setBusy(false);
    }
  };

  const left = status ? previewsLeft(status) : null;
  return (
    <div className="card" data-testid="gemini-voices">
      <h3>5. Voices and delivery (Gemini)</h3>
      <p className="small">
        Each speaker uses one prebuilt Gemini voice. Delivery style is separate from the words. The words are the reviewed narration, unchanged.
        A preview is a short unapproved clip for a listening check. It is not a production render.
      </p>
      <p className="small" data-testid="voice-preview-budget">
        Voice previews left this session: {left === null ? '…' : `${left} of ${status?.budget.caps.voicePreviews}`}. Production speech is charged only on Apply.
      </p>
      {speakers.map((sp) => {
        const p = previewFor(sp.id);
        const job = previewJob[sp.id];
        const view = job ? jobStatusView(job) : null;
        const err = previewError[sp.id];
        return (
          <div key={sp.id} className="card mt" data-testid={`gemini-speaker-${sp.id}`}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <b>{sp.id}</b>
              <div className="row" style={{ gap: 8 }}>
                <label className="field">
                  <span className="small">Voice</span>
                  <select
                    aria-label={`Voice for ${sp.id}`}
                    value={voiceOf(sp.id)}
                    disabled={disabled || busy}
                    onChange={(e) => setVoiceEdits((m) => ({ ...m, [sp.id]: { voice: e.target.value, style: styleOf(sp.id) } }))}
                  >
                    {GEMINI_VOICE_NAMES.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="small">Delivery style (not spoken)</span>
                  <input
                    aria-label={`Style for ${sp.id}`}
                    value={styleOf(sp.id)}
                    maxLength={200}
                    disabled={disabled || busy}
                    onChange={(e) => setVoiceEdits((m) => ({ ...m, [sp.id]: { voice: voiceOf(sp.id), style: e.target.value } }))}
                  />
                </label>
              </div>
            </div>
            <label className="field mt">
              <span className="small">Preview text (reviewed; at most {350} characters)</span>
              <textarea
                aria-label={`Preview text for ${sp.id}`}
                rows={2}
                value={p.text}
                dir={p.language === 'ar' ? 'rtl' : 'ltr'}
                onChange={(e) => setPreview((m) => ({ ...m, [sp.id]: { text: e.target.value, language: p.language } }))}
              />
            </label>
            <div className="row mt" style={{ gap: 8 }}>
              <select
                aria-label={`Preview language for ${sp.id}`}
                value={p.language}
                onChange={(e) => setPreview((m) => ({ ...m, [sp.id]: { text: p.text, language: e.target.value as 'ar' | 'en' } }))}
              >
                <option value="en">English</option>
                <option value="ar">Arabic</option>
              </select>
              <button
                className="btn sm"
                disabled={busy || disabled || left === 0}
                onClick={() => void runPreview(sp.id)}
                data-testid={`preview-${sp.id}`}
              >
                Preview this voice{left === null ? '' : ` (${left} left)`}
              </button>
            </div>
            {view ? <Banner kind={view.tone === 'ok' ? 'info' : view.tone}>{view.text}</Banner> : null}
            {job && job.status === 'succeeded' ? (
              <audio controls preload="none" src={ai.previewAudioUrl(job.id)} data-testid={`audio-${sp.id}`} style={{ marginTop: 8 }} />
            ) : null}
            {err ? <Banner kind="bad"><b>{err.code}</b>: {err.message}<div className="small">{failureAdvice(err.code)}</div></Banner> : null}
          </div>
        );
      })}
      {saveError ? <Banner kind="bad" data-testid="voices-save-error">{saveError}. Reload the draft before saving again.</Banner> : null}
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <button className="btn sm primary" disabled={busy || disabled || Object.keys(voiceEdits).length === 0} onClick={() => void save()} data-testid="save-voices">
          Save voices and style
        </button>
      </div>
    </div>
  );
};

/* ----------------------------------------------------------------- apply */

export interface GeneratedApplyPanelProps {
  ai: FactoryAiClient;
  env: FactoryDraftEnvelope;
  unsaved: boolean;
  reviewed: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onOpenEditor: (projectId: string) => void;
  onNotice: (msg: string) => void;
  onError: (e: unknown) => void;
}

export const GeneratedApplyPanel: React.FC<GeneratedApplyPanelProps> = ({ ai, env, unsaved, reviewed, busy, setBusy, onOpenEditor, onNotice, onError }) => {
  const [preview, setPreview] = useState<ApplyPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ count: number; revision: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setPending(null);
    ai.applyPreview(env.draftId)
      .then((p) => {
        if (alive) {
          setPreview(p);
          setPreviewError(null);
        }
      })
      .catch((e) => {
        if (alive) setPreviewError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [ai, env.draftId, env.revision]);

  const view = applyCountView(preview);
  const canStart = !!preview && preview.canApply && !busy && !unsaved && reviewed;

  const doApply = async (revision: number, count?: number) => {
    setBusy(true);
    try {
      const result = await ai.applyGenerated(env.draftId, revision, count);
      setPending(null);
      onNotice(result.reused ? `This revision was already applied. Opening ${result.projectId}; nothing new was created.` : `Created ${result.projectId}. Opening it in the editor.`);
      onOpenEditor(result.projectId);
    } catch (e) {
      const err = e as FactoryApiError;
      setPending(null);
      if (err.code === 'FACTORY_INPUTS_REQUIRED' && typeof err.details.speechCalls === 'number') {
        // The count changed under the confirmation. Show the new number; nothing is sent until the user confirms again.
        setPreview((p) => (p ? { ...p, speechCalls: err.details.speechCalls as number, sceneIds: (err.details.sceneIds as string[]) ?? p.sceneIds, canApply: true } : p));
        setPreviewError(`The count is now ${err.details.speechCalls}. Review it and confirm again. Nothing was called.`);
      } else if (err.status === 409) {
        setPreviewError('The draft changed since you loaded it. Reload the draft, then apply again.');
      }
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    if (!preview || !canStart) return;
    if (preview.speechCalls === 0) {
      void doApply(preview.revision);
      return;
    }
    // The confirmation is bound to this revision and to the count the owner sees now.
    setPending({ count: preview.speechCalls, revision: preview.revision });
  };

  return (
    <div className="card" data-testid="generated-apply">
      <h3>6. Apply to a new project</h3>
      <p className="small">
        Apply creates a NEW project from the saved selection and opens it in the editor. Generated speech is unapproved and not listened-reviewed.
        Speech is charged only for changed lines that have no verified clip yet. Re-applying an unchanged draft calls nothing.
      </p>
      {previewError ? <Banner kind="warn" data-testid="apply-preview-error">{previewError}</Banner> : null}
      {preview ? (
        <>
          <p data-testid="apply-count"><b>{view.headline}</b></p>
          <p className="small" data-testid="apply-budget">{view.remainingText}</p>
          {preview.blockers.length > 0 ? (
            <ul className="small" data-testid="apply-blockers">
              {preview.blockers.map((b, i) => <li key={`${b.kind}-${b.sceneId ?? ''}-${i}`}>{b.sceneId ? `${b.sceneId}: ` : ''}{b.reason}</li>)}
            </ul>
          ) : null}
        </>
      ) : null}
      {unsaved ? <Banner kind="warn">Save your edits before applying.</Banner> : null}
      {!reviewed && !unsaved ? <p className="small">Tick the review box above before applying.</p> : null}

      {pending ? (
        <div className="card mt" data-testid="apply-confirm">
          <p>
            <b>Confirm {pending.count} Gemini speech {pending.count === 1 ? 'call' : 'calls'}.</b> This is the number shown above for this revision ({pending.revision}).
            If the count changes, nothing is called and you are asked again.
          </p>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn sm" onClick={() => setPending(null)} disabled={busy} data-testid="apply-cancel">Cancel</button>
            <button
              className="btn sm primary"
              onClick={() => void doApply(pending.revision, pending.count)}
              disabled={busy}
              data-testid="apply-confirm-go"
            >
              Confirm {pending.count} and apply
            </button>
          </div>
        </div>
      ) : (
        <div className="row mt" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={!canStart} onClick={start} data-testid="apply-draft">
            {busy ? 'Working…' : preview && preview.speechCalls > 0 ? `Apply (${preview.speechCalls} speech ${preview.speechCalls === 1 ? 'call' : 'calls'})` : 'Apply to a new project'}
          </button>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------ shot list */

export interface ShotListPanelProps {
  ai: FactoryAiClient;
  env: FactoryDraftEnvelope;
  library: PlanLibraryItem[];
}

export const ShotListPanel: React.FC<ShotListPanelProps> = ({ ai, env, library }) => {
  const [list, setList] = useState<ShotList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ai.shotList(env.draftId)
      .then((l) => {
        if (alive) {
          setList(l);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [ai, env.draftId, env.revision]);

  return (
    <div className="card" data-testid="shot-list">
      <h3>Shot list and missing assets</h3>
      <p className="small">
        Each shot shows its type, why it serves the line, and what is bound. Prompts and briefs are text only: no image or video is generated here.
        A still image is not a screen recording. Missing pictures stop Apply before any provider call.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <a className="btn sm" href={`/api/factory/drafts/${encodeURIComponent(env.draftId)}/shot-list`} download="shot-list.json" data-testid="export-shot-json">Export JSON</a>
        <a className="btn sm" href={ai.shotListMarkdownUrl(env.draftId)} download="shot-list.md" data-testid="export-shot-md">Export Markdown</a>
      </div>
      {error ? <Banner kind="bad">The shot list could not be read: {error}</Banner> : null}
      {list ? (
        <table className="plan-table mt" style={{ width: '100%', fontSize: 13 }} data-testid="shot-rows">
          <thead>
            <tr><th>#</th><th>Line</th><th>Shot type</th><th>Why it serves the line</th><th>Picture</th><th>Status</th></tr>
          </thead>
          <tbody>
            {list.scenes.map((s) => {
              const asset = s.boundAssetId ? library.find((a) => a.id === s.boundAssetId) : undefined;
              const media = asset ? (asset.mimeType ?? '').startsWith('video') ? 'video' : 'image' : null;
              return (
                <tr key={s.sceneId} data-testid={`shot-${s.sceneId}`} style={{ verticalAlign: 'top' }}>
                  <td>{s.index + 1}</td>
                  <td className="mono small">{s.sourceUnitId}</td>
                  <td>{s.shotType ?? '—'}</td>
                  <td className="small">{s.why ?? '—'}</td>
                  <td className="small">
                    {asset ? (
                      <>
                        <Tag kind="accent">{media}</Tag> {asset.name}
                        <div className="small">Source: {asset.source ?? 'not recorded'} · Licence: {asset.license ?? 'not recorded'}</div>
                      </>
                    ) : (
                      <span className="warn-text">Missing: {s.assetNeed}</span>
                    )}
                  </td>
                  <td className="small">
                    {s.status === 'bound' ? <Tag kind="accent">bound</Tag> : <Tag kind="warn">missing</Tag>}
                    {s.status === 'missing' && s.prompt ? <pre className="small" style={{ whiteSpace: 'pre-wrap' }} data-testid={`prompt-${s.sceneId}`}>{s.prompt}</pre> : null}
                    {s.screenRecordingBrief ? <div className="small">Screen recording brief: {s.screenRecordingBrief}</div> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  );
};

export interface DerivedRewritePanelProps {
  ai: FactoryAiClient;
  env: FactoryDraftEnvelope;
  disabled: boolean;
  onAdopt: (next: FactoryDraftEnvelope) => void;
  onError: (e: unknown) => void;
}

/**
 * Derived rewrite of narration. The current draft is never changed: the rewrite is a new
 * draft with the changed text recorded before and after. It needs a reviewer's confirmation
 * before speech or apply. Edits typed here stay in the form if the server refuses them.
 */
export const DerivedRewritePanel: React.FC<DerivedRewritePanelProps> = ({ ai, env, disabled, onAdopt, onError }) => {
  const units = useMemo(() => {
    const selected = env.treatments.find((t) => t.id === env.selectedTreatmentId);
    const seen = new Map<string, { unitId: string; narration: string }>();
    for (const sc of selected?.scenes ?? []) {
      if (sc.sourceUnitId && !seen.has(sc.sourceUnitId)) seen.set(sc.sourceUnitId, { unitId: sc.sourceUnitId, narration: sc.narration });
    }
    return [...seen.values()];
  }, [env]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const changed = units.filter((u) => (drafts[u.unitId] ?? u.narration) !== u.narration && (drafts[u.unitId] ?? '').trim().length > 0);
  const derivedFrom = env.derivedFrom ?? null;
  const reviewed = env.reviewedRevision === env.revision && derivedFrom !== null;

  if (derivedFrom) {
    return (
      <div className="card" data-testid="derived-rewrite">
        <h3>Derived rewrite</h3>
        <p className="small">
          Made from draft <span className="mono">{derivedFrom.draftId}</span> at revision {derivedFrom.revision}. The original is unchanged.
          This rewrite is unapproved until a reviewer confirms it. Speech and apply stay blocked until then.
        </p>
        <ul className="small" data-testid="derived-changes">
          {derivedFrom.changes.map((c) => (
            <li key={c.unitId}>
              <span className="mono">{c.unitId}</span>: <s>{c.before}</s> → {c.after}
            </li>
          ))}
        </ul>
        {reviewed ? (
          <p className="small" data-testid="derived-reviewed">Reviewed at revision {env.revision}.</p>
        ) : (
          <button
            className="btn sm primary"
            data-testid="derived-review"
            disabled={disabled || busy}
            onClick={async () => {
              setBusy(true);
              try {
                onAdopt(await ai.reviewDerived(env.draftId, env.revision));
              } catch (e) {
                onError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            I reviewed these changes
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="card" data-testid="derive-rewrite">
      <h3>Rewrite narration (derived proposal)</h3>
      <p className="small">
        Supplied, approved narration stays as it is. Type a rewrite below to create a NEW draft. Only the changed lines are sent,
        and the rewrite needs your review before speech or apply. No provider is called here.
      </p>
      {units.map((u) => (
        <div className="field" key={u.unitId}>
          <label>
            Line <span className="mono">{u.unitId}</span>
          </label>
          <textarea
            data-testid={`derive-text-${u.unitId}`}
            value={drafts[u.unitId] ?? u.narration}
            disabled={disabled || busy}
            style={{ minHeight: 60 }}
            onChange={(e) => setDrafts((d) => ({ ...d, [u.unitId]: e.target.value }))}
          />
        </div>
      ))}
      <button
        className="btn sm primary"
        data-testid="derive-submit"
        disabled={disabled || busy || changed.length === 0}
        onClick={async () => {
          setBusy(true);
          try {
            const next = await ai.deriveDraft(env.draftId, {
              expectedRevision: env.revision,
              edits: changed.map((u) => ({ unitId: u.unitId, narration: (drafts[u.unitId] ?? '').trim() })),
            });
            setDrafts({});
            onAdopt(next);
          } catch (e) {
            // The typed text stays in the form. Nothing was derived.
            onError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Create derived rewrite ({changed.length} line{changed.length === 1 ? '' : 's'} changed)
      </button>
    </div>
  );
};
