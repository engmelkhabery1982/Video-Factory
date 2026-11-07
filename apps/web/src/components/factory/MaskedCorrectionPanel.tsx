import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Tag } from '../ui';
import {
  maskedCorrectionApi,
  type FactoryAiClient,
  type FactoryDraftEnvelope,
  type MaskedCorrectionClient,
  type MaskedCorrectionJob,
  type MaskedCorrectionReadiness,
  type ShotListScene,
} from '../../lib/factory-api';
import { makeMaskedCorrectionData, parseMaskInteger } from '../../lib/masked-correction';

interface Props {
  env: FactoryDraftEnvelope;
  ai: FactoryAiClient;
  onAdopt: (next: FactoryDraftEnvelope) => void;
  /** Test double for the typed HTTP client. Production uses maskedCorrectionApi. */
  corrections?: MaskedCorrectionClient;
}

const active = (job: MaskedCorrectionJob) => ['pending', 'running', 'applying'].includes(job.status);
const eligibleShot = (shot: ShotListScene) =>
  shot.status === 'bound'
  && !shot.locked
  && shot.mediaType === 'image'
  && !!shot.boundAssetId
  && !!shot.boundAssetSha256
  && !!shot.boundAssetWidth
  && !!shot.boundAssetHeight
  && (shot.boundAssetMimeType === 'image/png' || shot.boundAssetMimeType === 'image/jpeg');
const retryable = (job: MaskedCorrectionJob) => ['failed', 'cancelled', 'interrupted', 'rejected'].includes(job.status);
const cleanable = (job: MaskedCorrectionJob) => ['failed', 'cancelled', 'interrupted', 'rejected', 'completed'].includes(job.status);
const newSubmissionKey = () => `ui-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
const errorText = (err: unknown) => err instanceof Error ? err.message : 'The correction request failed.';

/** Existing canonical shot-list -> masked job -> reviewed bind workflow. No second editor/queue. */
export const MaskedCorrectionPanel: React.FC<Props> = ({ env, ai, onAdopt, corrections = maskedCorrectionApi }) => {
  const [shots, setShots] = useState<ShotListScene[]>([]);
  const [jobs, setJobs] = useState<MaskedCorrectionJob[]>([]);
  const [readiness, setReadiness] = useState<MaskedCorrectionReadiness | null>(null);
  const [sceneId, setSceneId] = useState('');
  const [region, setRegion] = useState({ x: '0', y: '0', width: '1', height: '1' });
  const [instructions, setInstructions] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const actionRef = useRef(false);
  const submissionKey = useRef(newSubmissionKey());

  const eligible = useMemo(() => shots.filter(eligibleShot), [shots]);
  const selected = eligible.find((shot) => shot.sceneId === sceneId) ?? null;

  const refresh = useCallback(async (showErrors = true) => {
    try {
      const [nextReadiness, nextJobs, shotList] = await Promise.all([
        corrections.readiness(),
        corrections.list(env.draftId),
        ai.shotList(env.draftId),
      ]);
      setReadiness(nextReadiness);
      setJobs(nextJobs);
      setShots(shotList.scenes);
      const candidates = shotList.scenes.filter(eligibleShot);
      setSceneId((current) => candidates.some((shot) => shot.sceneId === current) ? current : (candidates[0]?.sceneId ?? ''));
      if (showErrors) setError(null);
    } catch (err) {
      if (showErrors) setError(errorText(err));
    }
  }, [ai, corrections, env.draftId]);

  useEffect(() => { void refresh(); }, [refresh]);
  const hasActive = jobs.some(active);
  useEffect(() => {
    if (!hasActive) return;
    const timer = setTimeout(() => { void refresh(true); }, 500);
    return () => clearTimeout(timer);
  }, [hasActive, jobs, refresh]);

  const formChanged = (update: () => void) => {
    update();
    submissionKey.current = newSubmissionKey();
    setNotice(null);
    setError(null);
  };

  const run = async (label: string, action: () => Promise<void>) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setBusy(label);
    setError(null);
    setNotice(null);
    try { await action(); } catch (err) { setError(errorText(err)); } finally {
      actionRef.current = false;
      setBusy(null);
    }
  };

  const maskData = () => {
    if (!selected?.boundAssetWidth || !selected.boundAssetHeight) throw new Error('Select a bound PNG or JPEG still first.');
    return makeMaskedCorrectionData(
      { width: selected.boundAssetWidth, height: selected.boundAssetHeight },
      {
        x: parseMaskInteger(region.x, 'x'),
        y: parseMaskInteger(region.y, 'y'),
        width: parseMaskInteger(region.width, 'Region width'),
        height: parseMaskInteger(region.height, 'Region height'),
      },
    );
  };

  const validate = () => {
    try {
      maskData();
      setError(null);
      setNotice('The mask descriptor is locally valid. The server will verify it again against the current original bytes.');
    } catch (err) { setNotice(null); setError(errorText(err)); }
  };

  const create = () => run('create', async () => {
    if (!selected?.boundAssetId || !selected.boundAssetSha256) throw new Error('Select an eligible bound still.');
    if (!instructions.trim()) throw new Error('Describe the correction instruction for the marked region.');
    const job = await corrections.create(env.draftId, {
      sceneId: selected.sceneId,
      expectedRevision: env.revision,
      maskData: maskData(),
      originalAssetId: selected.boundAssetId,
      originalHash: selected.boundAssetSha256,
      instructions: instructions.trim(),
      idempotencyKey: submissionKey.current,
    });
    submissionKey.current = newSubmissionKey();
    setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    setNotice(job.runner.fixture ? 'Labelled mock runner job created. This is not real inpainting output.' : 'Configured runner job created. Review the actual result before Apply.');
    await refresh(false);
  });

  const mutate = (label: string, action: () => Promise<MaskedCorrectionJob>, message: string) => run(label, async () => {
    const job = await action();
    setJobs((current) => current.map((item) => item.id === job.id ? job : item));
    setNotice(message);
    await refresh(false);
  });

  const apply = (job: MaskedCorrectionJob) => run(`apply-${job.id}`, async () => {
    const next = await corrections.apply(job.id, env.revision);
    onAdopt(next);
    setNotice(`Correction ${job.id} applied at draft revision ${next.revision}. The original asset remains in the library.`);
    await refresh(false);
  });

  const remove = (job: MaskedCorrectionJob) => run(`remove-${job.id}`, async () => {
    await corrections.remove(job.id);
    setJobs((current) => current.filter((item) => item.id !== job.id));
    setNotice('Terminal job metadata was cleaned up. No asset or draft binding was deleted.');
  });

  return (
    <section className="card" data-testid="masked-correction-panel">
      <h3>Masked / regional still correction</h3>
      <p className="sub">
        Select an existing bound still, mark a pixel region and review a distinct corrected copy.
        The original asset is preserved. No generation is claimed when a runner is unavailable or labelled as a fixture.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Tag kind={readiness?.ready ? (readiness.runner?.fixture ? 'warn' : 'ok') : 'bad'}>
          {readiness?.ready ? (readiness.runner?.fixture ? 'test-double runner' : 'configured local runner') : 'runner unconfigured'}
        </Tag>
        <Tag kind="accent">one job at a time</Tag>
        {readiness?.busy ? <Tag kind="warn">runner busy</Tag> : null}
      </div>
      {readiness ? <p className="small" data-testid="masked-readiness">{readiness.reason}</p> : null}
      {error ? <Banner kind="bad" data-testid="masked-error">{error}</Banner> : null}
      {notice ? <Banner kind="info" data-testid="masked-notice">{notice}</Banner> : null}

      <div className="grid two" style={{ gap: 12 }}>
        <label>Bound still / scene
          <select data-testid="masked-scene" value={sceneId} onChange={(event) => formChanged(() => setSceneId(event.target.value))}>
            <option value="">Select an eligible still</option>
            {eligible.map((shot) => <option key={shot.sceneId} value={shot.sceneId}>{shot.index}. {shot.narration || shot.sceneId}</option>)}
          </select>
        </label>
        <div className="small">
          {selected ? <><strong>{selected.boundAssetWidth}×{selected.boundAssetHeight}</strong> · {selected.boundAssetMimeType}<br />Original SHA-256: <code>{selected.boundAssetSha256}</code></> : 'No unlocked, bound PNG/JPEG still is eligible.'}
        </div>
      </div>

      <fieldset disabled={!selected || busy !== null}>
        <legend>Mask rectangle in original pixels</legend>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {(['x', 'y', 'width', 'height'] as const).map((field) => (
            <label key={field}>{field}
              <input
                style={{ width: 90 }}
                inputMode="numeric"
                data-testid={`masked-${field}`}
                value={region[field]}
                onChange={(event) => formChanged(() => setRegion((current) => ({ ...current, [field]: event.target.value })))}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <label>Correction instruction
        <textarea
          data-testid="masked-instructions"
          rows={3}
          maxLength={2000}
          value={instructions}
          onChange={(event) => formChanged(() => setInstructions(event.target.value))}
          placeholder="For example: remove only the marked background object; preserve everything else"
        />
      </label>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn" data-testid="masked-validate" onClick={validate} disabled={!selected || busy !== null}>Validate mask</button>
        <button className="btn primary" data-testid="masked-create" onClick={() => void create()} disabled={!selected || !readiness?.ready || readiness.busy || busy !== null}>Submit bounded correction</button>
        <button className="btn" data-testid="masked-refresh" onClick={() => void refresh()} disabled={busy !== null}>Refresh / reopen jobs</button>
      </div>

      <label>Review notes (used by Approve / Reject)
        <input data-testid="masked-notes" value={notes} maxLength={2000} onChange={(event) => setNotes(event.target.value)} />
      </label>

      <div data-testid="masked-jobs">
        {jobs.length === 0 ? <p className="small">No persisted correction jobs for this draft.</p> : jobs.map((job) => (
          <article className="card" key={job.id} data-testid={`masked-job-${job.id}`}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Tag kind={job.status === 'failed' || job.status === 'apply_interrupted' ? 'bad' : job.status === 'applied' ? 'ok' : 'accent'}>{job.status}</Tag>
              <Tag kind={job.runner.fixture ? 'warn' : 'ok'}>{job.runner.fixture ? 'FIXTURE / not an engine' : job.runner.id}</Tag>
              <span className="small">attempt {job.attempts}/{job.maxAttempts} · created revision {job.revision}</span>
            </div>
            <p className="small"><code>{job.id}</code> · scene <code>{job.sceneId}</code> · runner {job.runner.id}@{job.runner.version}</p>
            {job.error ? <Banner kind="bad">{job.error}</Banner> : null}
            {job.targetCurrent === false ? <Banner kind="warn">{job.targetIssue ?? 'This job is stale.'}</Banner> : null}

            <div className="grid two" style={{ gap: 12, alignItems: 'start' }}>
              <figure>
                <figcaption className="small">Original (preserved) · {job.original.width}×{job.original.height}</figcaption>
                <img style={{ maxWidth: '100%' }} src={corrections.assetUrl(job.originalAssetId)} alt={`Original still for correction ${job.id}`} />
                <p className="small">Source: {job.original.source}<br />Licence: {job.original.license}<br />SHA-256: <code>{job.originalHash}</code></p>
              </figure>
              <figure>
                <figcaption className="small">Result candidate · last byte verification: {job.resultVerification} (review/Apply rechecks)</figcaption>
                {job.resultAssetId ? <img style={{ maxWidth: '100%' }} src={corrections.assetUrl(job.resultAssetId)} alt={`Corrected candidate for ${job.id}`} /> : <p className="small">No result asset. Nothing is shown as a successful correction.</p>}
                <p className="small">Result id: <code>{job.resultAssetId ?? 'none'}</code><br />Declared result SHA-256: <code>{job.resultHash ?? 'none'}</code></p>
              </figure>
            </div>
            <details>
              <summary>Frozen provenance / review state</summary>
              <p className="small">Mask SHA-256: <code>{job.maskHash}</code><br />Input fingerprint: <code>{job.inputFingerprint}</code><br />Target fingerprint: <code>{job.targetFingerprint}</code><br />Review fingerprint: <code>{job.reviewFingerprint ?? 'not approved'}</code><br />Review notes: {job.reviewNotes ?? 'none'} · Applied revision: {job.appliedRevision ?? 'not applied'}</p>
            </details>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {job.status === 'pending' || job.status === 'running' ? <button className="btn" onClick={() => void mutate(`cancel-${job.id}`, () => corrections.cancel(job.id), 'Correction cancelled; any late result is ignored.')}>Cancel</button> : null}
              {job.status === 'completed' ? <><button className="btn primary" onClick={() => void mutate(`approve-${job.id}`, () => corrections.review(job.id, 'approved', notes), 'Result approved at its frozen review fingerprint. Apply verifies the bytes and target again.')}>Approve result</button><button className="btn" onClick={() => void mutate(`reject-${job.id}`, () => corrections.review(job.id, 'rejected', notes), 'Result rejected. The original and current draft are unchanged.')}>Reject</button></> : null}
              {job.status === 'reviewed' || job.status === 'applying' || job.status === 'apply_interrupted' ? <button className="btn primary" data-testid={`masked-apply-${job.id}`} disabled={job.targetCurrent === false || busy !== null} onClick={() => void apply(job)}>{job.status === 'reviewed' ? 'Apply reviewed correction' : 'Reconcile Apply'}</button> : null}
              {retryable(job) ? <button className="btn" disabled={!readiness?.ready || job.attempts >= job.maxAttempts || busy !== null} onClick={() => void mutate(`retry-${job.id}`, () => corrections.retry(job.id), 'Retry started with the same frozen inputs; no newer target is overwritten.')}>Retry</button> : null}
              {cleanable(job) ? <button className="btn" disabled={busy !== null} onClick={() => void remove(job)}>Clean up metadata</button> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
};
