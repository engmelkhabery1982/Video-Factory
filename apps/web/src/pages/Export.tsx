import React, { useEffect, useState } from 'react';
import { api, videoUrl } from '../lib/api';
import { SeverityTag, Tag } from '../components/ui';

export const ExportPage: React.FC<{ projectId: string; onBack: () => void; toast: (t: string, k?: any) => void }> = ({ projectId, onBack, toast }) => {
  const [p, setP] = useState<any>(null);
  const [prod, setProd] = useState<any>(null);
  const [job, setJob] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState('');
  const [useOverride, setUseOverride] = useState(false);
  const [qcr, setQcr] = useState<any>(null);

  const load = async () => {
    const r = await api.project(projectId);
    setP(r.project);
    try {
      const pr = await api.production(projectId);
      setProd(pr.production);
    } catch {
      setProd(null);
    }
  };
  useEffect(() => {
    void load();
  }, [projectId]);

  useEffect(() => {
    if (!job?.jobId) return;
    const poll = job.production
      ? () => api.productionJob(projectId, job.jobId)
      : () => api.job(job.jobId);
    const t = setInterval(async () => {
      const st = await poll();
      setJob((j: any) => ({ ...j, ...st }));
      if (st.status !== 'running') {
        clearInterval(t);
        void load();
        if (st.status === 'done') toast(job.production ? 'Production build finished.' : 'Export finished.', 'ok');
        if (st.status === 'failed') toast(st.error ?? 'Export failed', 'bad');
      }
    }, 2000);
    return () => clearInterval(t);
  }, [job?.jobId, job?.production, projectId]);

  if (!p) return <div className="card">Loading…</div>;
  const artifacts = p.artifacts ?? [];
  const sim = p.storyboard.similarity;

  const start = async (kind: 'preview' | 'final') => {
    setBusy(true);
    try {
      // Production mode (new plan-based authority) when production state exists.
      if (prod?.exists) {
        const r = kind === 'preview' ? await api.productionPreview(projectId) : await api.productionExport(projectId);
        setJob({ jobId: r.jobId, status: 'running', log: [], production: true });
        return;
      }
      const r = await api.startExport(projectId, {
        kind,
        includeShorts: true,
        includeThumbnails: true,
        override: useOverride && override.trim() ? { reason: override.trim() } : null,
      });
      setJob({ jobId: r.jobId, status: 'running', log: [] });
    } catch (e: any) {
      setQcr(e.payload ?? null);
      const fix = e.payload?.fix ? ` Fix: ${e.payload.fix}` : '';
      toast(e.message + fix, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const runQcNow = async () => {
    const r = await api.runQc(projectId, { target: 'long', file: artifacts.find((a: any) => a.target === 'long')?.relPath ?? null });
    setQcr(r);
    toast(`QC verdict: ${r.report.verdict.toUpperCase()}`, r.report.verdict === 'fail' ? 'bad' : 'ok');
  };

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2>Quality control &amp; export</h2>
            <p className="sub" style={{ margin: 0 }}>
              Final export is blocked while any critical QC finding is open, unless you record an override reason.
            </p>
          </div>
          <button className="btn" onClick={onBack}>
            ← Captions
          </button>
        </div>
      </div>

      {sim ? (
        <div className={`banner ${sim.blocking ? 'bad' : 'ok'}`}>
          Visual similarity <b>{sim.score}%</b> (gate {sim.threshold}%). {sim.reasons.join(' · ')}
        </div>
      ) : null}

      {prod?.exists ? (
        <div className={`banner ${prod.status === 'needs_regeneration' || prod.status === 'blocked' ? 'bad' : 'ok'}`}>
          <b>Production mode</b> — status: {String(prod.status).replace(/_/g, ' ')} · audio engine: {prod.audioEngine} · targets:{' '}
          {(prod.targets ?? []).join(', ') || 'none'}
          {prod.lastQcSummary ? ` · last package: ${prod.lastQcSummary.packageStatus}` : ''}
          {prod.status === 'needs_regeneration' ? ' — regenerate in the Storyboard before exporting.' : ''}
        </div>
      ) : null}

      <div className="grid2">
        <div className="card">
          <h3>Render</h3>
          <p className="sub">
            {prod?.exists
              ? 'Preview and final export build from production scenarios with local Kokoro dialogue audio through the plan-based renderer. Final also writes the Phase 6D delivery package.'
              : 'Preview renders the whole timeline quickly at a lower bitrate. Final renders 1920×1080 + up to three 1080×1920 shorts at the delivery bitrate, then runs ffprobe on the real file.'}
          </p>
          <div className="row">
            <button className="btn" disabled={busy || job?.status === 'running'} onClick={() => start('preview')}>
              Generate preview
            </button>
            <button className="btn primary" disabled={busy || job?.status === 'running'} onClick={() => start('final')}>
              Final export
            </button>
            <button className="btn ghost" onClick={runQcNow}>
              Run QC now
            </button>
          </div>

          <div className="mt">
            <label className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={useOverride} onChange={(e) => setUseOverride(e.target.checked)} />
              Override a critical QC failure (reason is recorded in the report)
            </label>
            {useOverride ? (
              <div className="field mt">
                <label>Override reason</label>
                <input value={override} onChange={(e) => setOverride(e.target.value)} placeholder="Why this failure is acceptable for this video" />
              </div>
            ) : null}
          </div>

          {job?.status === 'running' ? (
            <>
              <div className="meter mt"><div style={{ width: '60%', background: 'var(--secondary)' }} /></div>
              <div className="small mt">Rendering… this can take several minutes per video on modest hardware.</div>
            </>
          ) : null}
          {job?.log?.length ? <div className="logbox mt">{job.log.join('\n')}</div> : null}
          {job?.error ? <div className="banner bad mt">{job.error}</div> : null}
        </div>

        <div className="card">
          <h3>Rendered files</h3>
          {!artifacts.length ? (
            <div className="banner info">Nothing rendered yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Kind</th>
                  <th>Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {artifacts.map((a: any, i: number) => (
                  <tr key={i}>
                    <td className="mono">{a.target}</td>
                    <td>
                      <Tag kind={a.kind === 'final' ? 'ok' : 'warn'}>{a.kind}</Tag>
                    </td>
                    <td className="small">{(a.sizeBytes / 1e6).toFixed(2)} MB</td>
                    <td>
                      <div className="row">
                        <a className="btn sm" href={videoUrl(projectId, a.relPath)} target="_blank" rel="noreferrer">
                          Open
                        </a>
                        <a className="btn sm ghost" href={`/output/${projectId}/${a.relPath}?download=1`}>
                          Download
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className="mt">Embedded preview players</h3>
          {artifacts.filter((a: any) => a.kind === 'final').length === 0 ? (
            <div className="banner info">Run a final export to see the delivered files here.</div>
          ) : (
            artifacts
              .filter((a: any) => a.kind === 'final')
              .map((a: any, i: number) => (
                <div key={i} className="mb">
                  <div className="small mb">
                    <span className="mono">{a.target}</span> — {a.width || ''} {a.width ? '×' : ''} {a.height || ''}
                    {a.probe?.durationSec ? ` · ${a.probe.durationSec}s · ${a.probe.width}×${a.probe.height} @ ${a.probe.fps}` : ''}
                  </div>
                  <div className="preview-stage">
                    <video controls src={videoUrl(projectId, a.relPath)} style={{ maxHeight: 360 }} />
                  </div>
                </div>
              ))
          )}
        </div>
      </div>

      {qcr ? (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>QC report — {qcr.report.target}</h2>
            <SeverityTag v={qcr.report.verdict} />
          </div>
          {qcr.blocked ? <div className="banner bad mt">{qcr.blockReason}</div> : null}
          {qcr.report.override ? <div className="banner warn mt">Override recorded: {qcr.report.override.reason}</div> : null}
          <div className="grid2 mt">
            <div>
              <h3>Measurements</h3>
              <div className="kv">
                {Object.entries(qcr.report.metrics ?? {}).map(([k, v]) => (
                  <div key={k}>
                    <span>{k}</span>
                    <span>{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3>Findings</h3>
              <div style={{ maxHeight: 420, overflow: 'auto' }}>
                {qcr.report.findings.map((f: any) => (
                  <div key={f.id + f.title} className={`finding ${f.severity}`}>
                    <span className="sev">{f.severity.toUpperCase()}</span>
                    <div>
                      <b>{f.title}</b> — {f.detail}
                      {f.where ? <div className="small">at {f.where}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {(p.qc ?? []).length ? (
        <div className="card">
          <h3>Saved QC reports for this project</h3>
          <table>
            <thead>
              <tr>
                <th>Target</th>
                <th>Verdict</th>
                <th>Critical</th>
                <th>Warnings</th>
                <th>Generated</th>
              </tr>
            </thead>
            <tbody>
              {p.qc.map((r: any, i: number) => (
                <tr key={i}>
                  <td className="mono">{r.target}</td>
                  <td>
                    <SeverityTag v={r.verdict} />
                  </td>
                  <td>{r.findings.filter((f: any) => f.severity === 'critical').length}</td>
                  <td>{r.findings.filter((f: any) => f.severity === 'warn').length}</td>
                  <td className="small">{new Date(r.generatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
};
