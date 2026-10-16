/**
 * Optional-input panels for the content plan: narration choice, storyboard cards, picture roles, local
 * transcription, and the review queue. Every control either edits the local form or sends one revision-checked
 * request through the factory client. Nothing here calls a provider.
 */
import { useEffect, useRef, useState } from 'react';
import {
  FACTORY_NARRATION_LABELS,
  FACTORY_VISUAL_ROLE_LABELS,
  type FactoryApiError,
  type FactoryClient,
  type FactoryCompletionItemView,
  type FactoryDraftEnvelope,
  type FactoryTextAuthority,
  type FactoryTranscriptionJob,
  type FactoryVisualRole,
} from '../../lib/factory-api';
import {
  movePanel,
  newPanel,
  panelsFromStoryboard,
  panelsToStoryboard,
  parseSeconds,
  parseStoryboardText,
  storyboardTimingProblems,
  timingChangedIds,
  type PlanNarrationChoice,
  type StoryboardPanelDraft,
} from '../../lib/factory-model';

const ROLE_ORDER: FactoryVisualRole[] = ['final_shot', 'storyboard_panel', 'style_reference', 'character_reference'];

/* ------------------------------------------------------------------ */
/* Narration choice                                                    */
/* ------------------------------------------------------------------ */

export function NarrationChoice({ value, onChange, audioAttached }: { value: PlanNarrationChoice; onChange: (v: PlanNarrationChoice) => void; audioAttached: boolean }) {
  const options: Array<{ value: PlanNarrationChoice; label: string }> = [
    { value: 'auto', label: audioAttached ? 'Automatic: supplied audio when audio is attached' : 'Automatic: speech generated after confirmation when text exists' },
    { value: 'supplied', label: FACTORY_NARRATION_LABELS.supplied },
    { value: 'generate', label: FACTORY_NARRATION_LABELS.generate },
    { value: 'none', label: FACTORY_NARRATION_LABELS.none },
  ];
  return (
    <fieldset className="mt" data-testid="narration-choice">
      <legend>Narration</legend>
      {options.map((o) => (
        <label key={o.value} className="row" style={{ gap: 8 }}>
          <input type="radio" name="narrationChoice" value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} data-testid={`narration-${o.value}`} />
          {o.label}
        </label>
      ))}
      <p className="small">
        Silent video needs no speaker, voice, transcript, alignment or audio approval. Captions and titles stay optional.
        Speech is never generated until you confirm the call count on Apply.
      </p>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ */
/* Storyboard cards                                                    */
/* ------------------------------------------------------------------ */

export function StoryboardCards({
  panels,
  onChange,
  pictures,
}: {
  panels: StoryboardPanelDraft[];
  onChange: (next: StoryboardPanelDraft[]) => void;
  pictures: Array<{ id: string; name: string }>;
}) {
  const [json, setJson] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const update = (i: number, change: Partial<StoryboardPanelDraft>) => onChange(panels.map((p, k) => (k === i ? { ...p, ...change } : p)));
  return (
    <fieldset className="mt" data-testid="storyboard-cards">
      <legend>Storyboard panels</legend>
      <p className="small">
        One card per panel, in order. Words are optional: a picture panel may have none. Each card is checked before Apply.
      </p>
      {panels.length === 0 ? <p className="small">No panels yet. Add one, or import a storyboard file below.</p> : null}
      <ol className="small" style={{ paddingLeft: 0, listStyle: 'none' }}>
        {panels.map((p, i) => (
          <li key={p.key} className="card" data-testid="storyboard-card" style={{ marginBottom: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="mono">Panel {i + 1} · {p.id}</span>
              <span className="row" style={{ gap: 6 }}>
                <button className="btn sm" type="button" onClick={() => onChange(movePanel(panels, i, -1))} disabled={i === 0} aria-label={`Move panel ${i + 1} up`}>Up</button>
                <button className="btn sm" type="button" onClick={() => onChange(movePanel(panels, i, 1))} disabled={i === panels.length - 1} aria-label={`Move panel ${i + 1} down`}>Down</button>
                <button className="btn sm" type="button" onClick={() => onChange(panels.filter((_, k) => k !== i))} aria-label={`Remove panel ${i + 1}`}>Remove</button>
              </span>
            </div>
            <label className="field mt">
              <span>Picture</span>
              <select aria-label={`Picture for panel ${i + 1}`} value={p.assetId ?? ''} onChange={(e) => update(i, { assetId: e.target.value || null })}>
                <option value="">No picture yet (missing)</option>
                {pictures.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label className="field mt">
              <span>Words for this panel (optional)</span>
              <textarea rows={2} value={p.narration} onChange={(e) => update(i, { narration: e.target.value })} aria-label={`Words for panel ${i + 1}`} />
            </label>
            <div className="row mt" style={{ gap: 8 }}>
              <label className="field">
                <span>Start (seconds, optional)</span>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  aria-label={`Start seconds for panel ${i + 1}`}
                  value={p.startSec ?? ''}
                  onChange={(e) => {
                    const v = parseSeconds(e.target.value);
                    if (v !== 'invalid') update(i, { startSec: v });
                  }}
                />
              </label>
              <label className="field">
                <span>End (seconds, optional)</span>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  aria-label={`End seconds for panel ${i + 1}`}
                  value={p.endSec ?? ''}
                  onChange={(e) => {
                    const v = parseSeconds(e.target.value);
                    if (v !== 'invalid') update(i, { endSec: v });
                  }}
                />
              </label>
              {p.locked ? <span className="small">Locked: its words, picture and timing cannot change.</span> : null}
            </div>
          </li>
        ))}
      </ol>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" type="button" onClick={() => onChange([...panels, newPanel(panels)])} data-testid="add-panel">Add panel</button>
        <button
          className="btn sm"
          type="button"
          onClick={() => {
            setJsonError(null);
            setJson(JSON.stringify(panelsToStoryboard(panels), null, 2));
          }}
        >
          Export JSON
        </button>
      </div>
      <details className="mt">
        <summary>Import a storyboard file (JSON, version 1)</summary>
        <p className="small">Optional. Pasting JSON replaces the cards after it is checked. Nothing is sent if it fails.</p>
        <textarea rows={6} aria-label="Storyboard JSON" value={json ?? ''} onChange={(e) => setJson(e.target.value)} />
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn sm"
            type="button"
            onClick={() => {
              const parsed = parseStoryboardText(json ?? '');
              if (!parsed.ok) {
                setJsonError(parsed.error);
                return;
              }
              setJsonError(null);
              onChange(panelsFromStoryboard(parsed.storyboard as { version: 1; scenes: Array<Record<string, unknown>> }));
            }}
          >
            Import panels
          </button>
        </div>
        {jsonError ? <p className="small" role="alert">{jsonError}</p> : null}
      </details>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ */
/* Picture roles                                                       */
/* ------------------------------------------------------------------ */

export function PictureRoles({
  pictures,
  roles,
  onChange,
}: {
  pictures: Array<{ id: string; name: string }>;
  roles: Record<string, FactoryVisualRole>;
  onChange: (next: Record<string, FactoryVisualRole>) => void;
}) {
  if (pictures.length === 0) return null;
  return (
    <fieldset className="mt" data-testid="picture-roles">
      <legend>Picture roles</legend>
      <p className="small">
        A final shot or a storyboard panel can appear in the video. A style or character reference never does: it is kept for reference only.
        The default is a final shot. Pictures are never relabelled as generated footage.
      </p>
      {pictures.map((a) => {
        const role = roles[a.id] ?? 'final_shot';
        return (
          <label key={a.id} className="field mt">
            <span>{a.name}</span>
            <select aria-label={`Role of ${a.name}`} value={role} onChange={(e) => onChange({ ...roles, [a.id]: e.target.value as FactoryVisualRole })}>
              {ROLE_ORDER.map((r) => <option key={r} value={r}>{FACTORY_VISUAL_ROLE_LABELS[r]}</option>)}
            </select>
          </label>
        );
      })}
      <p className="small" data-testid="vision-note">
        Automatic description of pictures is unavailable: no local vision engine is configured in this build. Describe panels by hand in the cards above.
      </p>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ */
/* Local transcription                                                 */
/* ------------------------------------------------------------------ */

const POLL_MS = 800;

export function TranscriptionPanel({
  client,
  audioAssetId,
  attachedJobId,
  onAttach,
}: {
  client: FactoryClient;
  audioAssetId: string | null;
  attachedJobId: string | null;
  onAttach: (jobId: string | null) => void;
}) {
  const [job, setJob] = useState<FactoryTranscriptionJob | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Poll only while the runner is working; stop on unmount so a late answer never lands on another screen.
  useEffect(() => {
    if (!job || (job.status !== 'running' && job.status !== 'queued')) return undefined;
    const timer = setTimeout(async () => {
      try {
        const next = await client.getTranscription(job.jobId);
        if (alive.current) setJob(next);
      } catch (e) {
        if (alive.current) setError((e as Error).message);
      }
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [client, job]);

  useEffect(() => {
    if (job?.status === 'succeeded') setText(job.transcript ?? '');
  }, [job?.jobId, job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!audioAssetId) return;
    setBusy(true);
    setError(null);
    try {
      const j = await client.startTranscription(audioAssetId);
      if (alive.current) setJob(j);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const cancel = async () => {
    if (!job) return;
    setBusy(true);
    try {
      const j = await client.cancelTranscription(job.jobId);
      if (alive.current) setJob(j);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const accept = async () => {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      const j = await client.reviewTranscription(job.jobId, text, job.revision);
      if (alive.current) {
        setJob(j);
        onAttach(j.jobId);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  if (!audioAssetId) return null;
  return (
    <fieldset className="mt" data-testid="transcription-panel">
      <legend>Audio text (local transcription)</legend>
      <p className="small">
        Runs only when you press Transcribe, on a local engine. The transcript is text only: it gives no word timing and is not alignment.
        Google is never used. A transcript is not your script and is never presented as one.
      </p>
      {!job ? (
        <button className="btn sm" type="button" onClick={() => void start()} disabled={busy} data-testid="transcribe-start">Transcribe this audio locally</button>
      ) : null}
      {job ? (
        <div data-testid="transcription-status">
          <div className="small">
            Status: <strong>{job.status}</strong>
            {job.progress !== null && job.status === 'running' ? ` · ${Math.round(job.progress * 100)}%` : ''}
            {job.revision ? ` · revision ${job.revision}` : ''}
          </div>
          {job.reason ? <p className="small">{job.reason}</p> : null}
          {job.status === 'running' || job.status === 'queued' ? (
            <button className="btn sm" type="button" onClick={() => void cancel()} disabled={busy} data-testid="transcribe-cancel">Cancel transcription</button>
          ) : null}
          {job.status === 'succeeded' ? (
            <>
              {job.provenance?.fixture ? <p className="small" role="note">FIXTURE output (tests only). This is not a real transcription.</p> : null}
              <label className="field mt">
                <span>Transcript (review and correct before use)</span>
                <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} aria-label="Transcript to review" />
              </label>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm primary" type="button" onClick={() => void accept()} disabled={busy || !text.trim()} data-testid="transcribe-accept">
                  Accept reviewed text
                </button>
                {attachedJobId === job.jobId ? <span className="small">Attached to this plan.</span> : null}
              </div>
            </>
          ) : null}
          {job.status !== 'running' && job.status !== 'queued' ? (
            <button className="btn sm" type="button" onClick={() => { setJob(null); setText(''); }} disabled={busy}>Start over</button>
          ) : null}
        </div>
      ) : null}
      {attachedJobId && !job ? <p className="small">A reviewed transcript is attached to this plan.</p> : null}
      {error ? <p className="small" role="alert">{error}</p> : null}
    </fieldset>
  );
}

/* ------------------------------------------------------------------ */
/* Review queue and text authority (after Create)                      */
/* ------------------------------------------------------------------ */

export function IntakeReview({
  env,
  busy,
  onPatch,
}: {
  env: FactoryDraftEnvelope;
  busy: boolean;
  onPatch: (change: Record<string, unknown>) => void;
}) {
  const queue: FactoryCompletionItemView[] = env.completion ?? [];
  const required = queue.filter((q) => q.required);
  const optional = queue.filter((q) => !q.required);
  const conflict = env.textConflict ?? null;
  return (
    <div className="card mt" data-testid="intake-review">
      <h3>Review queue</h3>
      {required.length === 0 ? <p className="small" data-testid="queue-clear">Nothing required is missing.</p> : null}
      {required.length > 0 ? (
        <ol data-testid="queue-required" className="small">
          {required.map((q) => (
            <li key={q.id}>
              <strong>{q.label}</strong> <span>{q.action}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {conflict ? (
        <div className="mt" data-testid="text-conflict">
          <p className="small">
            The texts disagree. Nothing has been replaced. Choose which text is the authority; the others stay listed and unused.
          </p>
          {conflict.sources.map((s) => (
            <div key={s.source} className="small" style={{ marginBottom: 6 }}>
              <strong>{s.label}</strong>: {s.units.slice(0, 2).join(' / ') || '(no words)'}
              <div>
                <button
                  className="btn sm"
                  type="button"
                  disabled={busy}
                  onClick={() => onPatch({ textAuthority: s.source as FactoryTextAuthority })}
                  data-testid={`authority-${s.source}`}
                >
                  Use {s.label}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {optional.length > 0 ? (
        <div className="mt" data-testid="queue-optional">
          <h4>Optional suggestions (you may ignore these)</h4>
          <ul className="small">
            {optional.map((q) => <li key={q.id}>{q.label} <span>{q.action}</span></li>)}
          </ul>
        </div>
      ) : null}
      {env.intake ? (
        <label className="row mt" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={env.intake.captions}
            disabled={busy}
            onChange={(e) => onPatch({ captions: e.target.checked })}
            data-testid="captions-toggle"
          />
          Captions on the video (optional; they follow the narration text when there is one)
        </label>
      ) : null}
    </div>
  );
}

/** Post-create storyboard editor. Saves through the revision-checked intake route. A refusal keeps every typed edit. */
export function PostCreateStoryboard({
  storyboard,
  revision,
  busy,
  pictures,
  onSave,
}: {
  storyboard: { version: 1; scenes: Array<Record<string, unknown>> } | null;
  revision: number;
  busy: boolean;
  pictures: Array<{ id: string; name: string }>;
  onSave: (body: { expectedRevision: number; storyboard: { version: 1; scenes: Array<Record<string, unknown>> }; confirmTiming: boolean; textAuthority?: FactoryTextAuthority }) => Promise<void>;
}) {
  const [panels, setPanels] = useState<StoryboardPanelDraft[]>(() => (storyboard ? panelsFromStoryboard(storyboard) : []));
  const [error, setError] = useState<string | null>(null);
  const [confirmTiming, setConfirmTiming] = useState(false);
  const [needsAuthority, setNeedsAuthority] = useState(false);
  const [authority, setAuthority] = useState<FactoryTextAuthority>('storyboard');
  // The cards reload only when the stored storyboard itself changes. A refused save keeps the typed edits.
  const storedKey = JSON.stringify(storyboard);
  const lastStored = useRef(storedKey);
  useEffect(() => {
    if (lastStored.current !== storedKey) {
      lastStored.current = storedKey;
      setPanels(storyboard ? panelsFromStoryboard(storyboard) : []);
    }
  }, [storedKey, storyboard]);

  const update = (i: number, change: Partial<StoryboardPanelDraft>) => setPanels((prev) => prev.map((p, k) => (k === i ? { ...p, ...change } : p)));
  const stored = storyboard?.scenes ?? [];
  const timingIds = timingChangedIds(panels, stored.map((sc) => ({ id: String(sc.id), startSec: (sc.startSec as number | null) ?? null, endSec: (sc.endSec as number | null) ?? null })));

  const save = async (textAuthorityChoice?: FactoryTextAuthority) => {
    const problems = storyboardTimingProblems(panels);
    if (problems.length > 0) {
      setError(problems.join(' '));
      return;
    }
    if (timingIds.length > 0 && !confirmTiming) {
      setError(`These timings change: ${timingIds.join(', ')}. Tick the timing confirmation, then save.`);
      return;
    }
    try {
      await onSave({
        expectedRevision: revision,
        storyboard: panelsToStoryboard(panels) as { version: 1; scenes: Array<Record<string, unknown>> },
        confirmTiming,
        ...(textAuthorityChoice ? { textAuthority: textAuthorityChoice } : {}),
      });
      setError(null);
      setNeedsAuthority(false);
      setConfirmTiming(false);
    } catch (e) {
      const err = e as FactoryApiError;
      const code = err?.code ?? '';
      if (code === 'FACTORY_REVISION_CONFLICT') {
        setError(`The draft changed since you loaded it (now revision ${err.currentRevision ?? 'unknown'}). Your typed edits are kept. Reload the draft, then save again.`);
      } else if (code === 'FACTORY_SCENE_LOCKED') {
        const ids = Array.isArray(err.details?.sceneIds) ? (err.details.sceneIds as string[]).join(', ') : '';
        setError(`Locked panels cannot change${ids ? `: ${ids}` : ''}. Unlock them first. Your typed edits are kept.`);
      } else if (code === 'FACTORY_TEXT_CONFLICT') {
        setNeedsAuthority(true);
        setError('These storyboard words differ from the script or the reviewed transcript. Choose which text is authoritative, then save. Your typed edits are kept.');
      } else if (code === 'FACTORY_APPROVED_TEXT_IMMUTABLE') {
        setError('The approved script is immutable. Choose storyboard or transcript as the text authority, or make a derived edit. Your typed edits are kept.');
      } else {
        setError(`${err?.message ?? 'The storyboard was not saved.'} Your typed edits are kept.`);
      }
    }
  };

  return (
    <fieldset className="card mt" data-testid="post-create-storyboard">
      <legend>Storyboard (saved to this draft)</legend>
      <p className="small">Edits are checked in full before anything is saved. A locked panel refuses changes to its words, picture and timing.</p>
      {panels.length === 0 ? <p className="small">This draft has no storyboard to edit.</p> : null}
      {panels.map((p, i) => (
        <div key={p.key} className="mt" data-testid="post-create-panel">
          <span className="mono small">Panel {i + 1} · {p.id}{p.locked ? ' · locked' : ''}</span>
          <label className="field">
            <span>Words</span>
            <textarea rows={2} aria-label={`Post-save words for panel ${i + 1}`} value={p.narration} disabled={p.locked} onChange={(e) => update(i, { narration: e.target.value })} />
          </label>
          <label className="field">
            <span>Picture</span>
            <select aria-label={`Post-save picture for panel ${i + 1}`} value={p.assetId ?? ''} disabled={p.locked} onChange={(e) => update(i, { assetId: e.target.value || null })}>
              <option value="">No picture (missing)</option>
              {pictures.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <div className="row" style={{ gap: 8 }}>
            <label className="field">
              <span>Start (seconds)</span>
              <input type="number" min={0} step={0.1} aria-label={`Post-save start for panel ${i + 1}`} disabled={p.locked} value={p.startSec ?? ''} onChange={(e) => { const v = parseSeconds(e.target.value); if (v !== 'invalid') update(i, { startSec: v }); }} />
            </label>
            <label className="field">
              <span>End (seconds)</span>
              <input type="number" min={0} step={0.1} aria-label={`Post-save end for panel ${i + 1}`} disabled={p.locked} value={p.endSec ?? ''} onChange={(e) => { const v = parseSeconds(e.target.value); if (v !== 'invalid') update(i, { endSec: v }); }} />
            </label>
          </div>
        </div>
      ))}
      {timingIds.length > 0 ? (
        <label className="field mt">
          <input type="checkbox" checked={confirmTiming} onChange={(e) => setConfirmTiming(e.target.checked)} aria-label="Confirm timing changes" />
          <span>I confirm these timing changes ({timingIds.join(', ')}).</span>
        </label>
      ) : null}
      {needsAuthority ? (
        <div className="row mt" style={{ gap: 8 }}>
          <label className="field">
            <span>Text authority</span>
            <select aria-label="Text authority" value={authority} onChange={(e) => setAuthority(e.target.value as FactoryTextAuthority)}>
              <option value="storyboard">Storyboard words</option>
              <option value="transcript">Reviewed transcript</option>
              <option value="script">Approved script</option>
            </select>
          </label>
          <button className="btn sm" type="button" disabled={busy} onClick={() => void save(authority)}>Save with this authority</button>
        </div>
      ) : null}
      {error ? <p className="small" role="alert" data-testid="post-create-error">{error}</p> : null}
      <div className="row mt">
        <button className="btn primary" type="button" disabled={busy || panels.length === 0} onClick={() => void save()} data-testid="post-create-save">Save storyboard</button>
      </div>
    </fieldset>
  );
}
