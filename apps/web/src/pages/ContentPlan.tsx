/**
 * Content plan (Milestone 2). A workflow beside the existing steps, not a new app.
 *
 * Flow: inputs -> draft (server-side, revisioned) -> three treatments -> explicit
 * selection and review -> apply into a NEW project that opens in the existing Editor.
 *
 * Honesty rules enforced here:
 *   - the form is never cleared on an error; the server's refusal is shown verbatim,
 *   - a transport failure is never reported as completed; the draft is reloaded to check,
 *   - apply is blocked while there are unsaved selection edits or missing inputs,
 *   - speech and timing labels say what is measured, estimated, or unknown,
 *   - there is no fallback data. A failed load is shown as failed.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Banner, Tag } from '../components/ui';
import { api } from '../lib/api';
import {
  applyBlockers,
  buildCreateBody,
  checkPlanForm,
  EMPTY_PLAN_FORM,
  errorView,
  identityOptionsFor,
  INPUT_MODE_LABELS,
  materialLabel,
  materialSummaryOf,
  moveScene,
  PROFILE_LABELS,
  profileNoteFor,
  speakerRowsFor,
  speechStatusFor,
  timingLabel,
  visualExecutionLabel,
  type ErrorView,
  type PlanForm,
  type PlanInputMode,
} from '../lib/factory-model';
import {
  factoryApi,
  FactoryApiError,
  type FactoryApplyResult,
  type FactoryCapabilities,
  type FactoryClient,
  type FactoryDraftEnvelope,
  type FactoryDraftScene,
  type FactoryPatchBody,
} from '../lib/factory-api';
import type { LibraryAudio } from '../lib/audio-track-ops';

/** A library entry as the planner needs it. Mirrors the asset index fields it reads. */
export interface PlanLibraryItem extends LibraryAudio {
  mimeType?: string;
  width?: number;
  height?: number;
}

/** Injected dependencies. Production uses `defaultPlanDeps`; tests pass their own labelled doubles. */
export interface PlanDeps {
  client: FactoryClient;
  loadLibrary: () => Promise<PlanLibraryItem[]>;
  uploadLibraryFile: (form: FormData) => Promise<unknown>;
}

export const defaultPlanDeps: PlanDeps = {
  client: factoryApi,
  loadLibrary: async () => ((await api.assets()).assets ?? []) as PlanLibraryItem[],
  uploadLibraryFile: (form) => api.uploadAsset(form),
};

const isAudio = (a: PlanLibraryItem) => (a.mimeType ?? '').toLowerCase().startsWith('audio/') && a.status !== 'inactive';
const isVisual = (a: PlanLibraryItem) => {
  const m = (a.mimeType ?? '').toLowerCase();
  const k = a.kind;
  return (m.startsWith('image/') || m.startsWith('video/')) && !['logo', 'icon', 'font'].includes(k) && !m.includes('svg');
};
const usable = (a: PlanLibraryItem) => a.status !== 'inactive' && a.blocked !== true;

export interface ContentPlanProps {
  initialDraftId: string | null;
  onOpenEditor: (projectId: string) => void;
  deps?: PlanDeps;
}

export const ContentPlanPage: React.FC<ContentPlanProps> = ({ initialDraftId, onOpenEditor, deps = defaultPlanDeps }) => {
  const [form, setForm] = useState<PlanForm>(EMPTY_PLAN_FORM);
  const [caps, setCaps] = useState<FactoryCapabilities | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [library, setLibrary] = useState<PlanLibraryItem[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [env, setEnv] = useState<FactoryDraftEnvelope | null>(null);
  const [sceneEdits, setSceneEdits] = useState<FactoryDraftScene[] | null>(null);
  const [speakerEdits, setSpeakerEdits] = useState<Record<string, string | null>>({});
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [applied, setApplied] = useState<FactoryApplyResult | null>(null);
  const [uploadDraft, setUploadDraft] = useState({ source: '', license: '' });

  const { client } = deps;
  const orderLocked = env?.speechOrderLocked ?? false;
  const selected = env?.treatments.find((t) => t.id === env.selectedTreatmentId) ?? null;
  const rows = sceneEdits ?? selected?.scenes ?? [];
  const unsaved = sceneEdits !== null || Object.keys(speakerEdits).length > 0;

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await deps.loadLibrary());
      setLibraryError(null);
    } catch (e) {
      setLibrary([]);
      setLibraryError(`The library could not be read: ${(e as Error).message}`);
    }
  }, [deps]);

  useEffect(() => {
    let alive = true;
    client
      .capabilities()
      .then((c) => alive && setCaps(c))
      .catch((e) => alive && setCapsError(`Capabilities could not be read: ${(e as Error).message}. Generation is not assumed.`));
    void refreshLibrary();
    return () => {
      alive = false;
    };
  }, [client, refreshLibrary]);

  const adopt = useCallback((next: FactoryDraftEnvelope, keepEdits = false) => {
    setEnv(next);
    if (!keepEdits) {
      setSceneEdits(null);
      setSpeakerEdits({});
    }
    setReviewed(false);
    setApplied(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('draft', next.draftId);
      window.history.replaceState(null, '', url.toString());
    } catch {
      /* URL update is a convenience for reopen; the page works without it. */
    }
  }, []);

  /* Reopen: the draft id in the address restores the draft, its selection and its speaker decisions. */
  useEffect(() => {
    if (!initialDraftId) return;
    let alive = true;
    setLoadingDraft(true);
    client
      .getDraft(initialDraftId)
      .then((e) => {
        if (alive) adopt(e);
      })
      .catch((e) => {
        if (alive) setError(errorView(e));
      })
      .finally(() => alive && setLoadingDraft(false));
    return () => {
      alive = false;
    };
  }, [client, initialDraftId, adopt]);

  /* ---- create ---------------------------------------------------- */

  const create = async () => {
    const check = checkPlanForm(form);
    if (!check.ok) {
      setError({ title: 'Check the inputs', detail: check.errors.join(' '), missing: [], next: 'fix_input', completionConfirmed: null });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await client.createDraft(buildCreateBody(form, check.storyboard));
      adopt(created);
      setNotice(created.status === 'blocked' ? 'The draft is saved but blocked. Resolve the list below.' : 'Draft saved. Review the treatments below.');
    } catch (e) {
      // The form is kept exactly as the user left it.
      setError(errorView(e));
    } finally {
      setBusy(false);
    }
  };

  /* ---- selection ------------------------------------------------- */

  const patchSelection = async (treatmentId: string, scenes: FactoryDraftScene[], speakers: Record<string, string | null>, keepEdits: boolean) => {
    if (!env) return;
    const speakerRows = env.speakers.map((s) => ({ id: s.id, voiceId: s.id in speakers ? speakers[s.id] : s.voiceId }));
    const body: FactoryPatchBody = {
      expectedRevision: env.revision,
      selectedTreatmentId: treatmentId,
      scenes: scenes.map((s) => ({
        id: s.id,
        narration: s.narration,
        speakerId: s.speakerId,
        visualIntent: s.visualIntent,
        assetId: s.assetId,
        startSec: s.startSec,
        endSec: s.endSec,
        locked: s.locked,
        sourceUnitId: s.sourceUnitId,
        beat: s.beat,
        language: s.language,
        assetOrigin: s.assetOrigin,
        timingSource: s.timingSource,
        visualDecision: s.visualDecision,
      })),
      speakers: speakerRows,
    };
    setBusy(true);
    setError(null);
    try {
      const next = await client.patchDraft(env.draftId, body);
      adopt(next, false);
      setNotice('Selection saved. Nothing is applied until you confirm the review below.');
    } catch (e) {
      // Keep the user's edits on screen so nothing is lost on a recoverable refusal.
      if (keepEdits) setSceneEdits(scenes);
      setError(errorView(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseTreatment = (treatmentId: string) => {
    if (!env || treatmentId === env.selectedTreatmentId) return;
    // Switching treatment replaces the scene rows, so unsaved scene edits must be saved or abandoned first.
    if (sceneEdits !== null) {
      setError({ title: 'Save or discard your scene edits first', detail: 'Switching treatment would replace the unsaved scene edits on this screen. Use “Save selection” first.', missing: [], next: 'fix_input', completionConfirmed: null });
      return;
    }
    const target = env.treatments.find((t) => t.id === treatmentId);
    if (!target) return;
    void patchSelection(treatmentId, target.scenes, speakerEdits, false);
  };

  const saveSelection = () => {
    if (!env) return;
    void patchSelection(env.selectedTreatmentId ?? '', rows, speakerEdits, true);
  };

  const editScene = (index: number, change: Partial<FactoryDraftScene>) => {
    const next = rows.map((r, i) => (i === index ? { ...r, ...change } : r));
    setSceneEdits(next);
    setReviewed(false);
  };

  const move = (index: number, delta: -1 | 1) => {
    const next = moveScene(rows, index, delta, orderLocked);
    if (next !== rows) {
      setSceneEdits(next);
      setReviewed(false);
    }
  };

  /* ---- apply ----------------------------------------------------- */

  const blockers = applyBlockers(env, unsaved, reviewed);

  const apply = async () => {
    if (!env || blockers.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.applyDraft(env.draftId, env.revision);
      setApplied(result);
      setNotice(`Created project ${result.projectId} (${result.format}). Opening it in the editor.`);
      onOpenEditor(result.projectId);
    } catch (e) {
      setError(errorView(e));
      if (e instanceof FactoryApiError && !e.answered) {
        // No reply: check the server for a project before anyone is told the apply failed.
        const before = env.appliedProjects.length;
        try {
          const check = await client.getDraft(env.draftId);
          if (check.appliedProjects.length > before) {
            adopt(check);
            setNotice(`The server shows that project ${check.appliedProjects[check.appliedProjects.length - 1].projectId} was created by this draft.`);
          } else {
            setEnv(check);
          }
        } catch {
          /* still unknown: the message above already says no completion is confirmed */
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const reloadDraft = async () => {
    if (!env) return;
    setBusy(true);
    try {
      const next = await client.getDraft(env.draftId);
      adopt(next, true);
      setNotice('Draft reloaded. Your unsaved selection edits are kept on screen. Save them again to apply them to this revision.');
      setError(null);
    } catch (e) {
      setError(errorView(e));
    } finally {
      setBusy(false);
    }
  };

  /* ---- library upload (reuses the existing asset endpoint) ------- */

  const upload = async (file: File, kind: 'audio' | 'visual') => {
    if (!uploadDraft.source.trim() || !uploadDraft.license.trim()) {
      setLibraryError('Enter the source and the licence for the file before uploading. Audio without them is refused.');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind === 'audio' ? 'sfx' : file.type.startsWith('video') ? 'broll' : 'screenshot');
    fd.append('source', uploadDraft.source.trim());
    fd.append('license', uploadDraft.license.trim());
    setBusy(true);
    try {
      await deps.uploadLibraryFile(fd);
      await refreshLibrary();
      setLibraryError(null);
      if (kind === 'audio') setForm((f) => ({ ...f, audioAssetId: null }));
    } catch (e) {
      setLibraryError(`The file was NOT added to the library: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const audioChoices = useMemo(() => library.filter((a) => isAudio(a) && usable(a) && (a.durationSec ?? 0) > 0), [library]);
  const visualChoices = useMemo(() => library.filter((a) => isVisual(a) && usable(a)), [library]);
  const identityOptions = identityOptionsFor(form.profile);
  const speakerRows = speakerRowsFor(env ?? emptyEnv, caps);

  const setField = <K extends keyof PlanForm>(key: K, value: PlanForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="plan-page" data-testid="content-plan">
      <div className="card">
        <h2>Content plan</h2>
        <p className="small">
          Plan a video from your own words and pictures. Three treatments are proposed by fixed local rules. Nothing here is written by an AI.
          Applying creates a new project that opens in the editor.
        </p>
        {capsError ? <Banner kind="warn">{capsError}</Banner> : null}
        <details className="mt">
          <summary>Engine status (technical)</summary>
          <EngineStatus caps={caps} />
        </details>
      </div>

      {error ? <ErrorBanner view={error} onReload={env ? reloadDraft : undefined} /> : null}
      {notice ? <Banner kind="info">{notice}</Banner> : null}
      {loadingDraft ? <div className="card">Loading the draft…</div> : null}

      {!env ? (
        <div className="card" data-testid="plan-form">
          <h3>1. Inputs</h3>
          <div className="grid2">
            <label className="field">
              <span>Content profile</span>
              <select value={form.profile} onChange={(e) => setField('profile', e.target.value as PlanForm['profile'])}>
                {Object.entries(PROFILE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              <small className="small">{profileNoteFor(form.profile)}</small>
            </label>
            <label className="field">
              <span>Format</span>
              <select value={form.format} onChange={(e) => setField('format', e.target.value as PlanForm['format'])}>
                <option value="landscape">Landscape (long video)</option>
                <option value="portrait">Portrait (short video)</option>
              </select>
              <small className="small">Format is kept on the new project and selects the matching composition.</small>
            </label>
            <label className="field">
              <span>Channel identity</span>
              <select value={form.identity} onChange={(e) => setField('identity', e.target.value as PlanForm['identity'])}>
                {identityOptions.map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
                ))}
              </select>
              {identityOptions.find((o) => o.disabled) ? <small className="small">{identityOptions.find((o) => o.disabled)?.reason}</small> : null}
            </label>
          </div>

          <label className="field mt">
            <span>Brief (one line, not narration)</span>
            <input value={form.brief} onChange={(e) => setField('brief', e.target.value)} placeholder="What this video is about" />
          </label>

          <fieldset className="mt">
            <legend>Input you have</legend>
            {(Object.keys(INPUT_MODE_LABELS) as PlanInputMode[]).map((mode) => (
              <label key={mode} className="row" style={{ gap: 8 }}>
                <input type="radio" name="inputMode" checked={form.inputMode === mode} onChange={() => setField('inputMode', mode)} />
                {INPUT_MODE_LABELS[mode]}
              </label>
            ))}
            {form.inputMode === 'brief' ? (
              <Banner kind="warn">
                No text engine is configured. A brief alone is blocked until you supply reviewed script text. No script is generated.
              </Banner>
            ) : null}
          </fieldset>

          {form.inputMode === 'script' || form.inputMode === 'audio_script' ? (
            <label className="field mt">
              <span>Reviewed script{form.inputMode === 'audio_script' ? ' (the words the audio speaks)' : ''}</span>
              <textarea rows={8} value={form.script} onChange={(e) => setField('script', e.target.value)} />
              <small className="small">Your words are kept exactly. Each sentence becomes one scene. Nothing is rewritten.</small>
            </label>
          ) : null}

          {form.inputMode === 'audio_script' ? (
            <div className="mt">
              <label className="field">
                <span>Ready audio (library)</span>
                <select value={form.audioAssetId ?? ''} onChange={(e) => setField('audioAssetId', e.target.value || null)}>
                  <option value="">Choose an audio file</option>
                  {audioChoices.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({(a.durationSec ?? 0).toFixed(1)} s measured)</option>
                  ))}
                </select>
              </label>
              <p className="small">The audio is used as supplied and is not understood or transcribed. Its text comes from the script you enter.</p>
            </div>
          ) : null}

          {form.inputMode === 'storyboard' ? (
            <label className="field mt">
              <span>Storyboard JSON (version 1)</span>
              <textarea rows={10} value={form.storyboardText} onChange={(e) => setField('storyboardText', e.target.value)} />
              <small className="small">Scenes carry your narration, optional speaker, asset id and start/end seconds. Times you supply are kept as yours.</small>
            </label>
          ) : null}

          <fieldset className="mt">
            <legend>Pictures and footage (library)</legend>
            {visualChoices.length === 0 ? <p className="small">No picture or footage is in the library yet. Upload some below, or continue: scenes will show as missing.</p> : null}
            <div className="grid2">
              {visualChoices.map((a) => (
                <label key={a.id} className="row" style={{ gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={form.visualAssetIds.includes(a.id)}
                    onChange={(e) => setField('visualAssetIds', e.target.checked ? [...form.visualAssetIds, a.id] : form.visualAssetIds.filter((x) => x !== a.id))}
                  />
                  {a.name} <span className="small">({a.kind})</span>
                </label>
              ))}
            </div>
          </fieldset>

          <LibraryUpload draft={uploadDraft} setDraft={setUploadDraft} onFile={upload} busy={busy} libraryError={libraryError} />

          <div className="row mt" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" disabled={busy} onClick={() => void create()} data-testid="create-draft">
              {busy ? 'Saving…' : 'Create draft'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="card" data-testid="draft-status">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3>2. Draft <span className="mono small">{env.draftId}</span></h3>
                <div className="small">
                  Revision {env.revision} · {PROFILE_LABELS[env.profile.contentProfile].split(' (')[0]} · {env.profile.format}
                  {env.profile.channelBrandId ? ` · identity ${env.profile.channelBrandId}` : ' · no channel identity'}
                </div>
              </div>
              <div className="row">
                <Tag kind={env.status === 'review_required' ? 'ok' : 'warn'}>{env.status === 'review_required' ? 'ready for review' : 'blocked'}</Tag>
                <Tag kind={env.speechOrderLocked ? 'accent' : ''}>{env.speechOrderLocked ? 'order fixed by supplied speech' : 'order may change'}</Tag>
                <button className="btn sm" onClick={() => { setEnv(null); setSceneEdits(null); setSpeakerEdits({}); setApplied(null); setReviewed(false); setError(null); setNotice(null); window.history.replaceState(null, '', window.location.pathname); }}>
                  Start a new plan
                </button>
              </div>
            </div>
            <InputsSummary env={env} />
            {env.missing.length > 0 ? (
              <div className="banner warn" data-testid="missing-list">
                <b>Missing ({env.missing.length})</b>
                <ul>
                  {env.missing.map((m, i) => (
                    <li key={`${m.kind}-${m.sceneId ?? i}`}>
                      <span className="mono small">{m.kind}{m.sceneId ? ` · ${m.sceneId}` : ''}</span> {m.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {env.warnings.length > 0 ? (
              <ul className="small" data-testid="warnings">
                {env.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            ) : null}
            {env.appliedProjects.length > 0 ? (
              <div className="small">
                Applied so far: {env.appliedProjects.map((p) => (
                  <button key={p.projectId} className="btn sm" style={{ marginLeft: 6 }} onClick={() => onOpenEditor(p.projectId)}>
                    Open {p.projectId}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="card" data-testid="treatments">
            <h3>3. Treatments</h3>
            <p className="small">
              Each treatment keeps your words unchanged. They differ in visual framing, motion and speaker labels
              {env.speechOrderLocked ? '. The order of speech is fixed because a recording or your timing is supplied.' : ', and in scene order, because no recording is supplied.'}
            </p>
            {env.treatments.map((t) => {
              const mat = materialSummaryOf(t);
              const isSel = t.id === env.selectedTreatmentId;
              return (
                <div key={t.id} className={`treatment ${isSel ? 'selected' : ''}`} data-testid={`treatment-${t.id}`} style={{ borderLeft: isSel ? '3px solid var(--accent, #0B3D91)' : '3px solid transparent', padding: '8px 10px', marginTop: 8 }}>
                  <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <input type="radio" name="treatment" checked={isSel} disabled={busy} onChange={() => chooseTreatment(t.id)} />
                    <span>
                      <b>{t.title}</b>
                      <div className="small">{t.rationale}</div>
                    </span>
                  </label>
                  <div className="small" style={{ marginTop: 4 }}>
                    Scene order: {t.scenes.map((s) => s.sourceUnitId).join(' → ')} · Beats: {t.structure.join(', ')}
                    {' · '}Pictures: {mat.supplied} supplied, {mat.library} library, {mat.reviewer} chosen in review, {mat.missing} missing
                    {mat.gaps.length ? ` · ${mat.gaps.length} requested visual feature(s) not executed` : ''}
                  </div>
                  {isSel ? null : (
                    <ol className="small" style={{ marginTop: 4 }}>
                      {t.scenes.map((s) => (
                        <li key={s.id}>{s.sourceUnitId} · {s.beat} · {speakerLabel(s.speakerId)} · {s.visualIntent}</li>
                      ))}
                    </ol>
                  )}
                </div>
              );
            })}
          </div>

          {selected ? (
            <div className="card" data-testid="selected-scenes">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3>4. Scenes of “{selected.title}”</h3>
                <div className="row">
                  {unsaved ? <Tag kind="warn">unsaved edits</Tag> : null}
                  <button className="btn sm primary" disabled={!unsaved || busy} onClick={saveSelection} data-testid="save-selection">Save selection</button>
                </div>
              </div>
              <p className="small">Speech is the supplied text and is not edited here. Speaker, picture, lock and order are the decisions you can change.</p>
              <table className="plan-table" style={{ width: '100%', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>#</th><th>Speech (supplied, unchanged)</th><th>Speaker</th><th>Picture</th><th>Visual execution</th><th>Timing</th><th>Lock</th><th>Order</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s, i) => {
                    const mat = materialLabel(s);
                    const sceneGaps = s.visualDecision.unexecuted;
                    return (
                      <tr key={s.id} data-testid={`scene-${s.id}`} style={{ verticalAlign: 'top' }}>
                        <td className="mono">{s.sourceUnitId}</td>
                        <td dir={s.language === 'ar' ? 'rtl' : 'ltr'}>
                          {s.narration}
                          <div className="small">{s.beat} · {s.language === 'ar' ? 'Arabic' : s.language === 'en' ? 'English' : 'language not detected'}</div>
                        </td>
                        <td>
                          <select aria-label={`Speaker for ${s.id}`} value={s.speakerId ?? ''} onChange={(e) => editScene(i, { speakerId: e.target.value || null })} disabled={busy}>
                            <option value="">None</option>
                            {(env?.speakers ?? []).map((sp) => <option key={sp.id} value={sp.id}>{sp.id}</option>)}
                            {s.speakerId && !(env?.speakers ?? []).some((sp) => sp.id === s.speakerId) ? <option value={s.speakerId}>{s.speakerId}</option> : null}
                          </select>
                        </td>
                        <td>
                          <select aria-label={`Picture for ${s.id}`} value={s.assetId ?? ''} onChange={(e) => editScene(i, { assetId: e.target.value || null })} disabled={busy}>
                            <option value="">None (missing)</option>
                            {visualOptions(library, s.assetId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </select>
                          <div className="small">{mat.label}</div>
                        </td>
                        <td className="small">
                          {visualExecutionLabel(s)}
                          {sceneGaps.map((g) => <div key={g} className="warn-text">Not executed: {g}</div>)}
                        </td>
                        <td className="small">{timingLabel(s.timingSource)}{s.startSec !== null ? ` (${s.startSec}–${s.endSec} s)` : ''}</td>
                        <td>
                          <input type="checkbox" aria-label={`Lock ${s.id}`} checked={s.locked} disabled={busy} onChange={(e) => editScene(i, { locked: e.target.checked })} />
                        </td>
                        <td>
                          {orderLocked ? <span className="small">fixed</span> : (
                            <>
                              <button className="btn sm" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${s.id} up`}>↑</button>
                              <button className="btn sm" disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${s.id} down`}>↓</button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="card" data-testid="voices">
            <h3>5. Voices and audio</h3>
            {speakerRows.length === 0 ? <p className="small">No speaker is assigned in the selected treatment.</p> : null}
            {speakerRows.map((r) => (
              <div key={r.speakerId} className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }} data-testid={`speaker-${r.speakerId}`}>
                <div>
                  <b>{r.speakerId}</b> <span className="small">({r.languages.map((l) => (l === 'ar' ? 'Arabic' : l === 'en' ? 'English' : 'unknown language')).join(', ')})</span>
                  <div className="small">{r.message}</div>
                </div>
                {r.status === 'audio_supplied' || r.status === 'unavailable' ? (
                  <Tag kind={r.status === 'unavailable' ? 'warn' : 'accent'}>{r.status === 'unavailable' ? 'generation unavailable' : 'supplied recording'}</Tag>
                ) : (
                  <select
                    aria-label={`Voice for ${r.speakerId}`}
                    value={r.speakerId in speakerEdits ? speakerEdits[r.speakerId] ?? '' : r.voiceId ?? ''}
                    onChange={(e) => { setSpeakerEdits((m) => ({ ...m, [r.speakerId]: e.target.value || null })); setReviewed(false); }}
                    disabled={busy || r.options.length === 0}
                  >
                    <option value="">No voice</option>
                    {r.options.map((v) => <option key={v.id} value={v.id}>{v.speakerLabel}</option>)}
                  </select>
                )}
              </div>
            ))}
            <p className="small">
              Voices are the local sample voices reported by the capability check. They are robotic English samples, not natural speech.
              Arabic speech is not available here, so Arabic lines need imported approved audio (supply it at input, or add it in the editor).
            </p>
          </div>

          <div className="card" data-testid="apply">
            <h3>6. Apply</h3>
            <p className="small">
              Apply creates a NEW project from the saved selection and opens it in the editor. It does not approve any audio.
              Generated speech is unapproved. A supplied recording stays as supplied and unapproved until you approve it in the editor.
              The reference project and existing library files are not changed.
            </p>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={unsaved || busy} data-testid="review-confirm" />
              I reviewed the selected treatment, its scene order, pictures and speakers.
            </label>
            {blockers.length > 0 ? (
              <ul className="small" data-testid="apply-blockers">
                {blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            ) : null}
            <div className="row mt" style={{ justifyContent: 'flex-end' }}>
              <button className="btn primary" disabled={busy || blockers.length > 0} onClick={() => void apply()} data-testid="apply-draft">
                {busy ? 'Working…' : 'Apply to a new project'}
              </button>
            </div>
            {applied ? <p className="small">Created {applied.projectId}.</p> : null}
          </div>
        </>
      )}
    </div>
  );
};

const emptyEnv: FactoryDraftEnvelope = {
  draftId: '',
  revision: 0,
  status: 'blocked',
  generationMode: 'local_rules',
  speechOrderLocked: false,
  selectedTreatmentId: null,
  treatments: [],
  speakers: [],
  missing: [],
  warnings: [],
  appliedProjects: [],
  profile: { contentProfile: 'educational', format: 'landscape', channelBrandId: null },
  inputs: { audioAssetId: null, audioDurationSec: null, visualAssetIds: [], scriptSupplied: false, storyboardSupplied: false },
};

function speakerLabel(id: string | null): string {
  return id ?? 'no speaker';
}

/** Picture choices for a scene: the library's usable visuals, plus the scene's current asset even if it was removed. */
function visualOptions(library: PlanLibraryItem[], current: string | null) {
  const list = library.filter((a) => isVisual(a) && usable(a));
  if (current && !list.some((a) => a.id === current)) return [...list, { id: current, name: `${current} (not in library)`, kind: 'image' }];
  return list;
}

const InputsSummary: React.FC<{ env: FactoryDraftEnvelope }> = ({ env }) => (
  <div className="small" style={{ marginTop: 6 }} data-testid="inputs-summary">
    Inputs: {env.inputs.scriptSupplied ? 'reviewed script' : env.inputs.storyboardSupplied ? 'storyboard' : 'no script (brief only)'}
    {env.inputs.audioAssetId ? ` · ready audio ${env.inputs.audioAssetId}${env.inputs.audioDurationSec ? ` (${env.inputs.audioDurationSec.toFixed(1)} s measured)` : ''}` : ' · no audio supplied'}
    {' · '}{env.inputs.visualAssetIds.length} picture(s) supplied
  </div>
);

const EngineStatus: React.FC<{ caps: FactoryCapabilities | null }> = ({ caps }) => {
  if (!caps) return <p className="small">Capabilities have not loaded.</p>;
  const en = speechStatusFor(caps, 'en');
  const ar = speechStatusFor(caps, 'ar');
  return (
    <ul className="small" data-testid="engine-status">
      <li>Text: {caps.text.mode === 'local_rules' ? 'local rules only (no semantic AI)' : caps.text.mode} — {caps.text.reason}</li>
      <li>Speech English: {en.available ? 'available' : 'unavailable'} — {en.reason}</li>
      <li>Speech Arabic: {ar.available ? 'available' : 'unavailable'} — {ar.reason}</li>
      <li>Pictures: {caps.image.available ? 'available' : 'unavailable'} — {caps.image.reason}</li>
      <li>Transcription: {caps.transcription.available ? 'available' : 'unavailable'} — {caps.transcription.reason}</li>
      {caps.speech.engines.map((e) => <li key={e.id}>Engine {e.id}: {e.available ? 'available' : 'not available'} — {e.reason}</li>)}
    </ul>
  );
};

const ErrorBanner: React.FC<{ view: ErrorView; onReload?: () => void }> = ({ view, onReload }) => (
  <div className="banner bad" role="alert" data-testid="plan-error">
    <b>{view.title}.</b> {view.detail}
    {view.missing.length > 0 ? (
      <ul>{view.missing.map((m, i) => <li key={`${m.kind}-${i}`}>{m.kind}{m.sceneId ? ` · ${m.sceneId}` : ''}: {m.reason}</li>)}</ul>
    ) : null}
    {view.next === 'reload' && onReload ? <div className="row mt"><button className="btn sm" onClick={onReload}>Reload draft</button></div> : null}
  </div>
);

const LibraryUpload: React.FC<{
  draft: { source: string; license: string };
  setDraft: (d: { source: string; license: string }) => void;
  onFile: (file: File, kind: 'audio' | 'visual') => void;
  busy: boolean;
  libraryError: string | null;
}> = ({ draft, setDraft, onFile, busy, libraryError }) => (
  <fieldset className="mt" data-testid="library-upload">
    <legend>Add a file to the library</legend>
    <div className="grid2">
      <label className="field"><span>Source (required)</span><input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} /></label>
      <label className="field"><span>Licence (required)</span><input value={draft.license} onChange={(e) => setDraft({ ...draft, license: e.target.value })} /></label>
    </div>
    <div className="row mt">
      <label className="btn sm">
        Upload audio
        <input type="file" accept="audio/*" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f, 'audio'); e.target.value = ''; }} />
      </label>
      <label className="btn sm">
        Upload picture or footage
        <input type="file" accept="image/*,video/*" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f, 'visual'); e.target.value = ''; }} />
      </label>
    </div>
    {libraryError ? <Banner kind="bad">{libraryError}</Banner> : null}
  </fieldset>
);
