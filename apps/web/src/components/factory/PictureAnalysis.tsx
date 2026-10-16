/**
 * Local picture analysis for reference pictures (style or character). Analyse → review → use reviewed description,
 * and an optional reference that conditions generated stills (passed to the local image runner itself).
 *
 * Rules shown to the owner:
 *  - Nothing is used until a person reviews it. A model's description is a suggestion.
 *  - Typed text is kept on every recoverable error. Nothing is saved from a failed request.
 *  - Religious stills cannot use a picture with lettering or a brand; the server refuses, and this says why.
 *  - Manual descriptions (PictureRoles) are separate and are never overwritten here.
 * DOM evidence only. Browser acceptance is separate.
 */
import { useEffect, useRef, useState } from 'react';
import type { FactoryDraftEnvelope } from '../../lib/factory-api';
import { FactoryApiError } from '../../lib/factory-api';
import { observationVisualText, CONDITIONING_STRENGTH } from '@buildtrack/core/visual';
import { reviewMapOf, type VisionClient, type VisionJobState, type VisionJobView, type VisionStatusView } from '../../lib/vision-api';

const POLL_MS = 800;

/** The owner's manual approval, typed here. Kept on every recoverable error. */
interface ManualDraft {
  text: string;
  source: string;
  license: string;
  containsText: boolean;
  containsLogoOrBrand: boolean;
  containsPeople: boolean;
}
const isRef = (r: string | undefined) => r === 'style_reference' || r === 'character_reference';

const JOB_LABEL: Record<VisionJobState, string> = {
  queued: 'Queued. This computer will analyse the picture when the engine is free.',
  running: 'Analysing this picture on this computer. Nothing is sent to a provider.',
  succeeded: 'Analysis finished. Check the description before you use it.',
  failed: 'The analysis failed. Nothing was saved. Your typed text is kept.',
  timed_out: 'The analysis timed out. Nothing was saved. Your typed text is kept.',
  cancelled: 'Cancelled. A late answer is discarded.',
  interrupted: 'The analysis was interrupted when the server stopped. Analyse the picture again.',
};

/** Manual fields start from the stored manual approval, or from the library record (source and licence to confirm). */
function manualFrom(env: FactoryDraftEnvelope, p: { id: string; source?: string | null; license?: string | null }): ManualDraft {
  const rec = env.intake?.visualReview?.[p.id];
  const manualRec = rec && rec.method === 'manual' ? rec : null;
  return {
    text: manualRec?.text ?? '',
    source: manualRec?.source ?? p.source ?? '',
    license: manualRec?.license ?? p.license ?? '',
    containsText: manualRec?.flags.containsText ?? false,
    containsLogoOrBrand: manualRec?.flags.containsLogoOrBrand ?? false,
    containsPeople: manualRec?.flags.containsPeople ?? false,
  };
}

function errorText(e: unknown): string {
  if (e instanceof FactoryApiError) {
    if (e.code === 'FACTORY_REVISION_CONFLICT') return 'The draft changed since you loaded it. Reload, then save again. Your typed text is kept.';
    if (e.code === 'FACTORY_CANDIDATE_STALE') return 'The picture changed after it was analysed. Analyse it again. Your typed text is kept.';
    if (e.code === 'FACTORY_IDENTITY_REFUSED') return `${e.message} Your typed text is kept so you can edit it.`;
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong. Nothing was saved.';
}

export interface PictureAnalysisProps {
  client: VisionClient;
  env: FactoryDraftEnvelope;
  /** Pictures attached to this draft, with their display names. Only style and character pictures are analysed. */
  pictures: Array<{ id: string; name: string; source?: string | null; license?: string | null; sha256?: string | null }>;
  /** Called with the server's new draft after a successful save. The parent adopts it. */
  onSaved: (next: FactoryDraftEnvelope) => void;
}

export function PictureAnalysis({ client, env, pictures, onSaved }: PictureAnalysisProps) {
  const [status, setStatus] = useState<VisionStatusView | null>(null);
  const [jobs, setJobs] = useState<Record<string, VisionJobView>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refs = pictures.filter((p) => isRef(env.intake?.visualRoles?.[p.id]));
  const conditioning = env.intake?.conditioning ?? null;
  const [condPicture, setCondPicture] = useState<string>(conditioning?.assetId ?? '');
  const [condStrength, setCondStrength] = useState<number>(conditioning?.strength ?? CONDITIONING_STRENGTH.default);
  const [condError, setCondError] = useState<string | null>(null);
  const [manual, setManual] = useState<Record<string, ManualDraft>>({});
  const religious = env.profile?.contentProfile === 'religious';

  useEffect(() => {
    let live = true;
    client.visionStatus()
      .then((s) => { if (live && alive.current) setStatus(s); })
      .catch((e) => { if (live && alive.current) setStatus({ ready: false, missing: [errorText(e)], serverReachable: false, model: { name: '', licence: '', sha256Matches: false }, projector: { name: '', licence: '', sha256Matches: false }, evidence: '' }); });
    return () => { live = false; };
  }, [client]);

  // Poll only while an analysis runs. Stop on unmount so a late answer never lands on another screen.
  useEffect(() => {
    const active = Object.values(jobs).find((j) => j.state === 'queued' || j.state === 'running');
    if (!active) return undefined;
    const timer = setTimeout(async () => {
      try {
        const next = await client.getVision(active.id);
        if (alive.current) setJobs((prev) => ({ ...prev, [next.assetId]: next }));
      } catch (e) {
        if (alive.current) setErrors((prev) => ({ ...prev, [active.assetId]: errorText(e) }));
      }
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [client, jobs]);

  // A finished analysis fills the editable description, unless the owner has already typed in that box.
  useEffect(() => {
    for (const j of Object.values(jobs)) {
      if (j.state === 'succeeded' && j.observation && !dirty[j.assetId] && typed[j.assetId] === undefined) {
        setTyped((t) => ({ ...t, [j.assetId]: observationVisualText(j.observation!) }));
      }
    }
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  const setError = (assetId: string, message: string | null) => setErrors((prev) => ({ ...prev, [assetId]: message ?? '' }));

  async function analyse(assetId: string) {
    setError(assetId, null);
    setBusy(assetId);
    try {
      const job = await client.startVision(assetId);
      if (!alive.current) return;
      setJobs((prev) => ({ ...prev, [assetId]: job }));
      setTyped((t) => { const n = { ...t }; delete n[assetId]; return n; });
      setDirty((d) => ({ ...d, [assetId]: false }));
    } catch (e) {
      if (alive.current) setError(assetId, errorText(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function cancel(assetId: string) {
    const job = jobs[assetId];
    if (!job) return;
    try {
      const next = await client.cancelVision(job.id);
      if (alive.current) setJobs((prev) => ({ ...prev, [assetId]: next }));
    } catch (e) {
      if (alive.current) setError(assetId, errorText(e));
    }
  }

  async function saveReview(assetId: string, state: 'reviewed' | 'rejected') {
    const job = jobs[assetId];
    if (!job || job.state !== 'succeeded') return;
    setError(assetId, null);
    setBusy(assetId);
    const text = (typed[assetId] ?? '').replace(/\s+/g, ' ').trim();
    // The server replaces the whole review map, so every other picture's review is sent back unchanged.
    const map = reviewMapOf(env.intake?.visualReview);
    map[assetId] = state === 'reviewed'
      ? { jobId: job.id, state: 'reviewed', text, useInPrompts: true }
      : { jobId: job.id, state: 'rejected', text: '', useInPrompts: false };
    try {
      const next = await client.saveReview(env.draftId, { expectedRevision: env.revision, visualReview: map });
      if (alive.current) {
        onSaved(next);
        setDirty((d) => ({ ...d, [assetId]: false }));
      }
    } catch (e) {
      if (alive.current) setError(assetId, errorText(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  /**
   * Manual approval, with no AI analysis. Readiness for conditioning does not depend on the vision engine. The server
   * checks the bytes (this picture's hash as the library records it), the source and licence, the declared flags and
   * the religious rules, and refuses anything else. Nothing is saved on refusal and the typed text is kept.
   */
  async function saveManual(p: { id: string; name: string; source?: string | null; license?: string | null; sha256?: string | null }) {
    const m = manual[p.id] ?? manualFrom(env, p);
    setError(p.id, null);
    if (!p.sha256) { setError(p.id, 'This picture has no recorded hash. Upload it again.'); return; }
    const text = m.text.replace(/\s+/g, ' ').trim();
    setBusy(p.id);
    const map = reviewMapOf(env.intake?.visualReview);
    map[p.id] = {
      jobId: '', method: 'manual', state: 'reviewed', text, useInPrompts: true, sha256: p.sha256,
      flags: { containsText: m.containsText, containsLogoOrBrand: m.containsLogoOrBrand, containsPeople: m.containsPeople },
      source: m.source, license: m.license,
    };
    try {
      const next = await client.saveReview(env.draftId, { expectedRevision: env.revision, visualReview: map });
      if (alive.current) onSaved(next);
    } catch (e) {
      if (alive.current) setError(p.id, errorText(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function saveConditioning(next: { assetId: string; strength: number } | null) {
    setCondError(null);
    setBusy('conditioning');
    try {
      const out = await client.saveReview(env.draftId, { expectedRevision: env.revision, conditioning: next });
      if (alive.current) onSaved(out);
    } catch (e) {
      if (alive.current) setCondError(errorText(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  if (pictures.length === 0) return null;

  const ready = status?.ready === true;
  return (
    <fieldset className="mt" data-testid="picture-analysis">
      <legend>Picture analysis</legend>
      {status === null ? <p className="small">Checking local picture analysis…</p> : null}
      {status && !ready ? (
        <p className="small" data-testid="vision-note">
          Automatic description of pictures is unavailable: {status.missing.length > 0 ? status.missing.join(' ') : 'no local vision engine is set up on this computer.'} Describe panels by hand.
        </p>
      ) : null}
      {status && ready ? (
        <p className="small" data-testid="vision-ready">
          Local picture analysis is set up. A description is a suggestion from a local model. Review it before you use it. Nothing is sent to a provider.
        </p>
      ) : null}

      {refs.length === 0 ? (
        <p className="small">Only a style or character reference can be described or used to condition stills. Set a picture's role to one of them above.</p>
      ) : null}

      {refs.map((p) => {
        const job = jobs[p.id];
        const running = job && (job.state === 'queued' || job.state === 'running');
        const rec = env.intake?.visualReview?.[p.id];
        const how = rec?.method === 'manual' ? 'Approved manually (source and licence checked).' : 'Reviewed.';
        const reviewLine = !rec
          ? 'Not reviewed. Not used in stills.'
          : rec.state === 'rejected'
            ? 'Rejected. Not used in stills.'
            : rec.useInPrompts
              ? `${how} Used in stills.`
              : `${how} Not used in stills.`;
        const m = manual[p.id] ?? manualFrom(env, p);
        const setM = (patch: Partial<ManualDraft>) => setManual((prev) => ({ ...prev, [p.id]: { ...(prev[p.id] ?? manualFrom(env, p)), ...patch } }));
        const flagged = job?.observation && (job.observation.containsText || job.observation.containsLogoOrBrand);
        return (
          <div key={p.id} className="card mt" data-testid="picture-analysis-item" data-asset-id={p.id}>
            <p><strong>{p.name}</strong></p>
            <p className="small" data-testid="review-line">{reviewLine}</p>
            <div className="row">
              <button type="button" onClick={() => void analyse(p.id)} disabled={!ready || !!running || busy === p.id}>
                Analyse picture
              </button>
              {running ? <button type="button" onClick={() => void cancel(p.id)}>Cancel analysis</button> : null}
            </div>
            {job ? <p className="small" role="status" aria-live="polite">{JOB_LABEL[job.state]}</p> : null}
            {errors[p.id] ? <p className="small" role="alert">{errors[p.id]}</p> : null}
            {job?.state === 'succeeded' && job.observation ? (
              <>
                {flagged ? (
                  <p className="small" data-testid="picture-flag">
                    This picture shows lettering or a logo.{religious ? ' A religious still cannot use it as a reference.' : ' Check the description before you use it.'}
                  </p>
                ) : null}
                <label className="field mt">
                  <span className="small">Description to review (edit it, then use it or reject it)</span>
                  <textarea
                    rows={3}
                    maxLength={600}
                    aria-label={`Reviewed description of ${p.name}`}
                    value={typed[p.id] ?? ''}
                    onChange={(e) => {
                      setTyped((t) => ({ ...t, [p.id]: e.target.value }));
                      setDirty((d) => ({ ...d, [p.id]: true }));
                    }}
                  />
                </label>
                {job.observation.uncertainties.length > 0 ? (
                  <p className="small">Not sure: {job.observation.uncertainties.join('; ')}</p>
                ) : null}
                <div className="row">
                  <button type="button" onClick={() => void saveReview(p.id, 'reviewed')} disabled={busy === p.id}>Use this description in stills</button>
                  <button type="button" onClick={() => void saveReview(p.id, 'rejected')} disabled={busy === p.id}>Reject this description</button>
                </div>
              </>
            ) : null}
            <details className="mt" data-testid="manual-approval">
              <summary className="small">Approve without analysis (you write the description)</summary>
              <p className="small">
                Use this when you have checked the picture yourself. It does not need the local vision engine. Confirm the source and licence exactly as the library records them.
                {p.sha256 ? ` Picture hash: ${p.sha256.slice(0, 12)}…` : ' This picture has no recorded hash, so it cannot be approved yet.'}
              </p>
              <label className="field">
                <span className="small">Source (as recorded)</span>
                <input aria-label={`Source of ${p.name}`} value={m.source} onChange={(e) => setM({ source: e.target.value })} />
              </label>
              <label className="field">
                <span className="small">Licence (as recorded)</span>
                <input aria-label={`Licence of ${p.name}`} value={m.license} onChange={(e) => setM({ license: e.target.value })} />
              </label>
              <fieldset className="mt">
                <legend className="small">What the picture shows (declare each)</legend>
                <label className="small"><input type="checkbox" aria-label={`${p.name} contains text`} checked={m.containsText} onChange={(e) => setM({ containsText: e.target.checked })} /> Text or lettering</label>{' '}
                <label className="small"><input type="checkbox" aria-label={`${p.name} contains a logo or brand`} checked={m.containsLogoOrBrand} onChange={(e) => setM({ containsLogoOrBrand: e.target.checked })} /> A logo or brand</label>{' '}
                <label className="small"><input type="checkbox" aria-label={`${p.name} contains people`} checked={m.containsPeople} onChange={(e) => setM({ containsPeople: e.target.checked })} /> People</label>
              </fieldset>
              <label className="field mt">
                <span className="small">Description (labelled: Subject; Environment; Lighting; Composition; Shot)</span>
                <textarea rows={3} maxLength={600} aria-label={`Approval description of ${p.name}`} value={m.text} onChange={(e) => setM({ text: e.target.value })} />
              </label>
              {religious ? <p className="small">A religious still cannot use a picture with lettering or a brand. The server refuses that.</p> : null}
              <div className="row">
                <button type="button" onClick={() => void saveManual(p)} disabled={busy === p.id || !p.sha256}>Approve this description manually</button>
              </div>
            </details>
          </div>
        );
      })}

      {refs.length > 0 ? (
        <div className="card mt" data-testid="conditioning-controls">
          <p><strong>Reference-conditioned stills</strong></p>
          <p className="small">
            The chosen picture is passed to the local image runner itself (IP-Adapter), not only described in the prompt. Strength runs from 0.10 (weak) to 1.00 (strong).
            The picture must be reviewed first: analyse it, or approve it manually with its source and licence. Conditioning does not need the vision engine. Changing the picture or the strength makes earlier candidates stale, and a stale candidate cannot be approved.
          </p>
          <label className="field">
            <span>Picture that conditions stills</span>
            <select aria-label="Conditioning picture" value={condPicture} onChange={(e) => setCondPicture(e.target.value)}>
              <option value="">None (text only)</option>
              {refs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Strength: {condStrength.toFixed(2)}</span>
            <input
              type="range"
              aria-label="Conditioning strength"
              min={CONDITIONING_STRENGTH.min}
              max={CONDITIONING_STRENGTH.max}
              step={CONDITIONING_STRENGTH.step}
              value={condStrength}
              onChange={(e) => setCondStrength(Number(e.target.value))}
            />
          </label>
          <div className="row">
            <button
              type="button"
              disabled={!condPicture || busy === 'conditioning'}
              onClick={() => void saveConditioning({ assetId: condPicture, strength: condStrength })}
            >
              Use this picture to condition stills
            </button>
            <button type="button" disabled={!conditioning || busy === 'conditioning'} onClick={() => { setCondPicture(''); void saveConditioning(null); }}>
              Stop conditioning
            </button>
          </div>
          {conditioning ? <p className="small" data-testid="conditioning-line">Saved: conditioning at strength {conditioning.strength.toFixed(2)}.</p> : <p className="small" data-testid="conditioning-line">Saved: text only.</p>}
          {condError ? <p className="small" role="alert">{condError}</p> : null}
        </div>
      ) : null}
    </fieldset>
  );
}
