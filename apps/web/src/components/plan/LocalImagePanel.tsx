/**
 * Local still images for image shots. Generation runs on the owner's computer through the local
 * runner; nothing here calls Google or any provider. Flow per shot:
 *   prompt -> Generate locally (one job at a time) -> progress / Cancel -> preview ->
 *   Approve (registers the file with provenance) -> Bind to this shot (checked against the draft revision).
 *
 * A candidate is not a library asset until approved. A cancelled, failed or late job never shows a preview.
 * Errors keep the shot and the candidate on screen so nothing typed or chosen is lost.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Banner, Tag } from '../ui';
import {
  FactoryApiError,
  type FactoryAiClient,
  type FactoryDraftEnvelope,
  type LocalImageClient,
  type LocalImageJob,
  type LocalImageStatus,
  type ShotList,
  type ShotListScene,
} from '../../lib/factory-api';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);

export interface LocalImagePanelProps {
  ai: FactoryAiClient;
  images: LocalImageClient;
  env: FactoryDraftEnvelope;
  /** Called with the server's new draft after a successful bind. */
  onAdopt: (next: FactoryDraftEnvelope) => void;
  pollMs?: number;
}

interface RowState {
  job: LocalImageJob | null;
  approvedAssetId: string | null;
  error: string | null;
  /** A neutral message (for example "saved"). Not an error. */
  notice: string | null;
  busy: boolean;
}

const emptyRow = (): RowState => ({ job: null, approvedAssetId: null, error: null, notice: null, busy: false });

export const LocalImagePanel: React.FC<LocalImagePanelProps> = ({ ai, images, env, onAdopt, pollMs = 1000 }) => {
  const [status, setStatus] = useState<LocalImageStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [list, setList] = useState<ShotList | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  /** Unsaved visual-description text per shot. Empty until the user edits a shot. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  /** Jobs the user cancelled. A late poll result for these is ignored, never shown as success. */
  const cancelled = useRef<Set<string>>(new Set());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Status and shot list are reads. They make no generation call.
  useEffect(() => {
    let alive = true;
    images
      .status()
      .then((s) => alive && setStatus(s))
      .catch((e) => alive && setStatusError((e as Error).message));
    ai.shotList(env.draftId)
      .then((l) => alive && setList(l))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [ai, images, env.draftId, env.revision]);

  const setRow = (sceneId: string, patch: Partial<RowState>) =>
    setRows((r) => ({ ...r, [sceneId]: { ...(r[sceneId] ?? emptyRow()), ...patch } }));

  /** Polls one job until it is terminal. Stops when the component unmounts or the scene changes. */
  const follow = (sceneId: string, jobId: string) => {
    const tick = async () => {
      if (!mounted.current || cancelled.current.has(jobId)) return;
      try {
        const job = await images.job(jobId);
        if (!mounted.current || cancelled.current.has(jobId)) return;
        setRow(sceneId, { job, error: job.state === 'failed' || job.state === 'timed_out' ? job.error?.message ?? null : null });
        if (!TERMINAL.has(job.state)) setTimeout(tick, pollMs);
        else setRow(sceneId, { busy: false });
      } catch (e) {
        if (mounted.current) setRow(sceneId, { busy: false, error: (e as Error).message });
      }
    };
    void tick();
  };

  const generate = async (scene: ShotListScene) => {
    setRow(scene.sceneId, { busy: true, error: null, notice: null, approvedAssetId: null });
    try {
      const job = await images.start({ draftId: env.draftId, sceneId: scene.sceneId, expectedRevision: env.revision });
      setRow(scene.sceneId, { job, busy: true });
      follow(scene.sceneId, job.id);
    } catch (e) {
      const err = e as FactoryApiError;
      setRow(scene.sceneId, { busy: false, error: err.message, job: null });
    }
  };

  const cancel = async (scene: ShotListScene, jobId: string) => {
    cancelled.current.add(jobId);
    try {
      const job = await images.cancel(jobId);
      setRow(scene.sceneId, { job, busy: false, error: null });
    } catch (e) {
      // The server refused (for example it had already finished). Show that, and keep the preview if any.
      cancelled.current.delete(jobId);
      const fresh = await images.job(jobId).catch(() => null);
      setRow(scene.sceneId, { error: (e as Error).message, job: fresh ?? undefined, busy: false });
    }
  };

  const approve = async (scene: ShotListScene, jobId: string) => {
    setRow(scene.sceneId, { busy: true, error: null });
    try {
      const out = await images.approve(jobId);
      setRow(scene.sceneId, { busy: false, approvedAssetId: out.assetId, job: out.job });
    } catch (e) {
      setRow(scene.sceneId, { busy: false, error: (e as Error).message });
    }
  };

  /**
   * Saves a corrected visual description at the reviewed revision. The prompt is rebuilt by the server.
   * The earlier preview was made from the old prompt, so it is discarded. Nothing is bound by this.
   */
  const correct = async (scene: ShotListScene) => {
    const text = (drafts[scene.sceneId] ?? scene.visualDescription ?? '').trim();
    setRow(scene.sceneId, { busy: true, error: null });
    try {
      const next = await images.correctPrompt(env.draftId, scene.sceneId, { expectedRevision: env.revision, visualDescription: text });
      setDrafts((d) => {
        const copy = { ...d };
        delete copy[scene.sceneId];
        return copy;
      });
      setRows((r) => ({ ...r, [scene.sceneId]: { ...emptyRow(), notice: 'Prompt saved. The earlier preview was made from the old prompt and was discarded. Nothing was bound.' } }));
      onAdopt(next);
    } catch (e) {
      const err = e as FactoryApiError;
      setRow(scene.sceneId, {
        busy: false,
        error:
          err.code === 'FACTORY_REVISION_CONFLICT'
            ? 'The draft changed since you loaded it. Reload, then save the correction again. Your text is still here.'
            : err.message,
      });
    }
  };

  const bind = async (scene: ShotListScene, assetId: string) => {
    setRow(scene.sceneId, { busy: true, error: null });
    try {
      const next = await images.bind(env.draftId, { expectedRevision: env.revision, sceneId: scene.sceneId, assetId });
      setRows((r) => ({ ...r, [scene.sceneId]: emptyRow() }));
      onAdopt(next);
    } catch (e) {
      const err = e as FactoryApiError;
      // Stale revision or refused asset: keep the candidate and say what to do.
      setRow(scene.sceneId, {
        busy: false,
        error:
          err.code === 'FACTORY_REVISION_CONFLICT'
            ? 'The draft changed since this preview was made. Reload the draft, then bind again. The image was not bound.'
            : err.message,
      });
    }
  };

  const imageShots = (list?.scenes ?? []).filter((s) => s.assetNeed === 'image_needed');
  const ready = status?.ready === true;

  return (
    <div className="card" data-testid="local-images">
      <h3>Local still images</h3>
      <p className="small">
        Stills are generated on this computer with a local runner. No Google or cloud image service is used, and nothing is spent.
        A prompt, a manual upload, or an exported prompt does not complete generation. A still is never a screen recording.
      </p>
      {statusError ? <Banner kind="bad">The local image status could not be read: {statusError}</Banner> : null}
      {status && !ready ? (
        <Banner kind="warn" data-testid="local-images-setup">
          <strong>Setup required.</strong> Local image generation is not ready on this computer.
          <ul className="small" data-testid="local-images-missing">
            {status.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          Follow docs/execution/milestone-3/LOCAL_IMAGE_SETUP.md. Nothing has been downloaded or installed by the factory.
        </Banner>
      ) : null}
      {status && ready ? (
        <p className="small" data-testid="local-images-ready">
          Ready: {status.project} {status.release}, backend {status.backend}, {status.steps} steps, timeout {status.timeoutSec} s. One job at a time.
          Model licence: {status.model.license}.
        </p>
      ) : null}
      {imageShots.length === 0 ? <p className="small">No image shot in this draft needs a still.</p> : null}
      {imageShots.map((s) => {
        const row = rows[s.sceneId] ?? emptyRow();
        const job = row.job;
        const candidateReady = job?.state === 'succeeded' && job.provenance !== null;
        const anotherRunning = status?.busy === true && !job;
        return (
          <div key={s.sceneId} className="mt" data-testid={`local-shot-${s.sceneId}`} style={{ borderTop: '1px solid var(--line, #ddd)', paddingTop: 8 }}>
            <div className="small">
              <strong>Shot {s.index + 1}</strong> · line <span className="mono">{s.sourceUnitId}</span> · <Tag kind="warn">{s.status}</Tag>
            </div>
            <pre className="small" style={{ whiteSpace: 'pre-wrap' }} data-testid={`local-prompt-${s.sceneId}`}>{s.imagePrompt ?? s.prompt ?? s.visualRequirement}</pre>
            {s.negativePrompt ? (
              <div className="small" data-testid={`local-negative-${s.sceneId}`}>
                <strong>Excluded in this image:</strong> {s.negativePrompt}
              </div>
            ) : null}
            {s.promptWarnings.map((w) => (
              <Banner kind="warn" key={w} data-testid={`local-prompt-warning-${s.sceneId}`}>{w}</Banner>
            ))}
            {s.visualDescription !== null ? (
              <div className="mt">
                <label className="small" htmlFor={`local-correct-${s.sceneId}`}>
                  Visual description (Subject; Environment; Lighting; Composition; Shot; Exclude). The prompt is rebuilt from it when you save.
                </label>
                <textarea
                  id={`local-correct-${s.sceneId}`}
                  data-testid={`local-correct-text-${s.sceneId}`}
                  rows={4}
                  maxLength={600}
                  style={{ width: '100%' }}
                  value={drafts[s.sceneId] ?? s.visualDescription}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.sceneId]: e.target.value }))}
                  disabled={row.busy || (job !== null && !TERMINAL.has(job.state))}
                />
                <button
                  className="btn sm"
                  data-testid={`local-correct-save-${s.sceneId}`}
                  disabled={
                    row.busy ||
                    (job !== null && !TERMINAL.has(job.state)) ||
                    (drafts[s.sceneId] ?? s.visualDescription).trim() === '' ||
                    (drafts[s.sceneId] ?? s.visualDescription).trim() === s.visualDescription.trim()
                  }
                  onClick={() => void correct(s)}
                >
                  Save prompt correction
                </button>
              </div>
            ) : null}
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn sm"
                data-testid={`local-generate-${s.sceneId}`}
                disabled={!ready || row.busy || anotherRunning || (job !== null && !TERMINAL.has(job.state))}
                onClick={() => void generate(s)}
              >
                {s.boundAssetId ? 'Generate a replacement locally' : 'Generate locally'}
              </button>
              {job && !TERMINAL.has(job.state) ? (
                <button className="btn sm" data-testid={`local-cancel-${s.sceneId}`} onClick={() => void cancel(s, job.id)}>
                  Cancel
                </button>
              ) : null}
            </div>
            {job && !TERMINAL.has(job.state) ? (
              <div className="small mt" data-testid={`local-progress-${s.sceneId}`} role="status">
                Generating on this computer: {Math.round(job.progress * 100)}% (seed {job.seed}, {job.width}×{job.height})
              </div>
            ) : null}
            {job?.state === 'cancelled' ? <div className="small mt" data-testid={`local-cancelled-${s.sceneId}`}>Cancelled. Nothing was saved.</div> : null}
            {row.notice ? <div className="small mt" data-testid={`local-notice-${s.sceneId}`} role="status">{row.notice}</div> : null}
            {row.error ? <Banner kind="bad">{row.error}</Banner> : null}
            {candidateReady && job ? (
              <div className="mt" data-testid={`local-candidate-${s.sceneId}`}>
                <img
                  src={images.imageUrl(job.id)}
                  alt={`Local preview for shot ${s.index + 1} (not approved)`}
                  width={job.width / 3}
                  height={job.height / 3}
                  data-testid={`local-preview-${s.sceneId}`}
                />
                <div className="small">
                  Preview only until approved. Model {job.provenance?.modelName} · sha256 {job.provenance?.modelSha256.slice(0, 16)}… · {job.provenance?.release} · seed {job.provenance?.seed} · {job.width}×{job.height} · {job.backend}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {!row.approvedAssetId ? (
                    <button className="btn sm" data-testid={`local-approve-${s.sceneId}`} disabled={row.busy} onClick={() => void approve(s, job.id)}>
                      Approve preview
                    </button>
                  ) : (
                    <button className="btn sm primary" data-testid={`local-bind-${s.sceneId}`} disabled={row.busy} onClick={() => void bind(s, row.approvedAssetId as string)}>
                      Bind to this shot
                    </button>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
