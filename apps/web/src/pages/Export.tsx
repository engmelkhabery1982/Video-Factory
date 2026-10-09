import React, { useEffect, useState } from 'react';
import { api, outputUrl, videoUrl } from '../lib/api';
import { ExternalNarrationReadinessCard, type ExternalNarrationSummary } from '../components/ExternalNarrationPanel';
import { NarrationSourceSwitch } from '../components/NarrationSourceSwitch';
import { SeverityTag, Tag } from '../components/ui';
import { usesExternalReadyNarration } from '../lib/narration-source';

/**
 * EXPORT / QC PAGE — production-aware.
 *
 * Production projects (production state exists) use ONLY the production
 * authority end to end:
 *
 *   POST /api/projects/:id/production/preview
 *   POST /api/projects/:id/production/export
 *   GET  /api/projects/:id/production/jobs/:jobId
 *   production state artifacts + production readiness QC/package state
 *
 * The legacy `exportProject` video path is never invoked for a production
 * project, and the legacy QC runner is not offered there either (it would run
 * Storyboard static QC over a different data model).
 *
 * Legacy projects (no production state) keep the previous export and QC UI.
 */
export const ExportPage: React.FC<{ projectId: string; onBack: () => void; toast: (t: string, k?: any) => void }> = ({ projectId, onBack, toast }) => {
  const [p, setP] = useState<any>(null);
  const [prod, setProd] = useState<any>(null);
  const [job, setJob] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState('');
  const [useOverride, setUseOverride] = useState(false);
  const [qcr, setQcr] = useState<any>(null);
  const [narration, setNarration] = useState<ExternalNarrationSummary | null>(null);
  const [exportBlock, setExportBlock] = useState<any>(null);

  const load = async () => {
    const r = await api.project(projectId);
    setP(r.project);
    const externalReady = usesExternalReadyNarration(r.project?.meta?.input);
    let production: any = null;
    try {
      const pr = await api.production(projectId);
      production = pr.production;
      setProd(production);
    } catch {
      setProd(null);
    }
    /* Ready narration uses the ordinary export, even if an old production
     * sidecar still exists. Production export synthesizes dialogue and is not
     * this check. */
    if (externalReady || !production?.exists) {
      try {
        setNarration(await api.externalNarration(projectId));
      } catch {
        setNarration(null);
      }
    } else {
      setNarration(null);
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
        if (st.status === 'done') toast(job.production ? 'Production build finished. This is not publication approval.' : 'Export finished. This is not publication approval.', 'ok');
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
      // Production mode only when this project did not choose ready narration.
      if (prod?.exists && !usesExternalReadyNarration(p.meta?.input)) {
        const r = kind === 'preview' ? await api.productionPreview(projectId) : await api.productionExport(projectId);
        setJob({ jobId: r.jobId, status: 'running', log: [], production: true });
        return;
      }
      if (kind === 'final') {
        try {
          const fresh = await api.externalNarration(projectId);
          setNarration(fresh);
          const blocked = (fresh.targets ?? []).filter(
            (target: { readiness?: { exportAttemptReady?: boolean; applies?: boolean; inheritsLongNarration?: boolean; blockers?: Array<{ message?: string }> } | null }) =>
              target.readiness && !target.readiness.exportAttemptReady && (target.readiness.applies || target.readiness.inheritsLongNarration),
          );
          if (blocked.length > 0) {
            setExportBlock({
              blockReason: blocked[0].readiness?.blockers[0]?.message ?? 'Imported narration is not ready to attempt export.',
              externalNarrationGate: {
                findings: blocked.flatMap((target: { readiness?: { blockers?: unknown[] } | null }) => target.readiness?.blockers ?? []),
                targets: blocked,
              },
            });
            toast('Imported narration is not ready to attempt export. Fix the items below, then try again.', 'bad');
            return;
          }
        } catch {
          /* The export request revalidates on the server if this read fails. */
        }
      }
      const r = await api.startExport(projectId, {
        kind,
        includeShorts: true,
        includeThumbnails: true,
        override: useOverride && override.trim() ? { reason: override.trim() } : null,
      });
      setExportBlock(null);
      setJob({ jobId: r.jobId, status: 'running', log: [] });
    } catch (e: any) {
      if (e.payload?.externalNarrationGate) {
        setExportBlock(e.payload);
        setQcr(null);
      } else {
        setQcr(e.payload ?? null);
      }
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

  const externalReady = usesExternalReadyNarration(p.meta?.input);

  /* ───────────────────── production mode ───────────────────── */
  if (prod?.exists && !externalReady) {
    const stale = prod.status === 'needs_regeneration' || prod.stale === true;
    /*
     * STALE INPUT (audit item D): when the ProjectInput changed, every derived
     * record — builds, Phase 6D package, QC, readiness, artifacts, product kit —
     * belongs to the replaced content. The API already reports them as absent;
     * this UI guard keeps the rule visible even if a record ever leaks through.
     */
    const readiness = stale ? null : (prod.lastReadiness ?? null);
    const packageRoot: string | null = stale ? null : (prod.lastBuild?.packageRoot ?? null);
    const prodArtifacts = stale ? [] : (prod.artifacts ?? []);
    const qcSummary = stale ? null : (prod.lastQcSummary ?? null);
    const statusTone = stale || prod.status === 'blocked' ? 'bad' : prod.status === 'ready_for_export' ? 'ok' : 'warn';
    return (
      <>
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2>Production QC &amp; export</h2>
              <p className="sub" style={{ margin: 0 }}>
                Long + Shorts are produced from production scenarios and Kokoro dialogue audio through the plan-based renderer; the final
                build also writes the Phase 6D package and the production product kit. This production export does not use narration
                imported on the Captions page. Passing it is not publication approval.
              </p>
            </div>
            <button className="btn" onClick={onBack}>
              ← Captions
            </button>
          </div>
        </div>

        <div className={`banner ${statusTone}`}>
          <b>Production mode</b> — status: {String(prod.status).replace(/_/g, ' ')} · audio engine: {prod.audioEngine} · targets:{' '}
          {(prod.targets ?? []).join(', ') || 'none'}
          {packageRoot ? ` · package: ${packageRoot}` : ''}
          {!stale && prod.productKitPath ? ` · kit: ${prod.productKitPath}` : ''}
          {stale
            ? ' — ProjectInput changed: previous builds, package, QC, readiness and the product kit are no longer current. Regenerate in the Storyboard before exporting.'
            : ''}
        </div>

        <div className="grid2">
          <div className="card">
            <h3>Render</h3>
            <div className="row">
              <button className="btn" disabled={busy || job?.status === 'running' || stale} onClick={() => start('preview')}>
                Generate preview
              </button>
              <button className="btn primary" disabled={busy || job?.status === 'running' || stale} onClick={() => start('final')}>
                Final production export
              </button>
            </div>
            <p className="sub mt">
              Both actions call the real production API ({' '}
              <span className="mono">/production/preview</span> or <span className="mono">/production/export</span> ) and are polled through{' '}
              <span className="mono">/production/jobs/:jobId</span>. Final export appends the production casting/style observation.
            </p>
            {stale ? <div className="banner bad">Production state is stale: regeneration is required before rendering.</div> : null}

            {job?.status === 'running' ? (
              <>
                <div className="meter mt">
                  <div style={{ width: '60%', background: 'var(--secondary)' }} />
                </div>
                <div className="small mt">Rendering the production plan… (Kokoro audio + Phase 6C render).</div>
              </>
            ) : null}
            {job?.log?.length ? <div className="logbox mt">{job.log.join('\n')}</div> : null}
            {job?.error ? <div className="banner bad mt">{job.error}</div> : null}
          </div>

          <div className="card">
            <h3>Production readiness QC</h3>
            {!readiness ? (
              <div className="banner info">
                {stale
                  ? 'The previous readiness result belongs to replaced input and is not shown as current. Regenerate, then run a preview or final export.'
                  : 'No production readiness result yet. Run a preview or final export to produce one.'}
              </div>
            ) : (
              <>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <div className="small">
                      kind: {readiness.kind} · generated {new Date(readiness.at).toLocaleString()}
                    </div>
                  </div>
                  <Tag kind={readiness.readyForProductionDelivery ? 'ok' : readiness.status === 'blocked' ? 'bad' : 'warn'}>
                    {readiness.status}
                  </Tag>
                </div>
                <table className="mt">
                  <thead>
                    <tr>
                      <th>Dimension</th>
                      <th>Status</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(readiness.dimensions ?? []).map((d: any) => (
                      <tr key={d.dimension}>
                        <td className="mono small">{d.dimension}</td>
                        <td>
                          <Tag kind={d.status === 'pass' ? 'ok' : d.status === 'fail' ? 'bad' : d.status === 'warn' ? 'warn' : ''}>{d.status}</Tag>
                        </td>
                        <td className="small">{d.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(readiness.findings ?? []).filter((f: any) => f.severity === 'error').length > 0 ? (
                  <div className="banner bad mt">
                    {(readiness.findings ?? [])
                      .filter((f: any) => f.severity === 'error')
                      .map((f: any) => `${f.code}: ${f.message}`)
                      .join(' · ')}
                  </div>
                ) : (
                  <div className="banner ok mt">No blocking production finding.</div>
                )}
              </>
            )}

            {qcSummary ? (
              <p className="small mt">
                Phase 6D package: <b>{qcSummary.packageStatus}</b> · mode {qcSummary.mode} · long {qcSummary.longCount} · shorts{' '}
                {qcSummary.shortCount}
              </p>
            ) : null}
          </div>
        </div>

        <div className="card">
          <h3>Production artifacts</h3>
          {!prodArtifacts.length ? (
            <div className="banner info">Nothing produced yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Kind</th>
                  <th>Path</th>
                  <th>Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {prodArtifacts.map((a: any, i: number) => (
                  <tr key={`${a.relPath}-${i}`}>
                    <td className="mono">{a.target}</td>
                    <td>
                      <Tag kind={a.kind === 'video' || a.kind === 'package' ? 'ok' : 'warn'}>{a.kind}</Tag>
                    </td>
                    <td className="mono small">{a.relPath}</td>
                    <td className="small">{(Number(a.sizeBytes ?? 0) / 1e6).toFixed(2)} MB</td>
                    <td>
                      <a className="btn sm" href={outputUrl(a.relPath)} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {packageRoot ? (
            <p className="small mt">
              Phase 6D package: <span className="mono">{packageRoot}</span> (manifest + checksums) ·{' '}
              <a className="btn sm ghost" href={outputUrl(`${packageRoot}/manifest/delivery_manifest.json`)} target="_blank" rel="noreferrer">
                manifest
              </a>{' '}
              <a className="btn sm ghost" href={outputUrl(`${packageRoot}/evidence/package_summary.json`)} target="_blank" rel="noreferrer">
                package summary
              </a>
            </p>
          ) : null}
          {!stale && prod.productKitPath ? (
            <p className="small">
              Production product kit (publishing kit, titles/description, scenario snapshots, provenance, thumbnails, contact sheets,
              readiness): <span className="mono">{prod.productKitPath}</span>{' '}
              <a className="btn sm ghost" href={outputUrl(`${prod.productKitPath}/manifest.json`)} target="_blank" rel="noreferrer">
                kit manifest
              </a>
            </p>
          ) : null}
          {stale ? (
            <div className="banner warn mt">
              The ProjectInput changed after this content was produced, so previous builds, package, readiness QC and the product kit are not
              shown as current. Regenerate the production scenarios, then run the export again.
            </div>
          ) : null}
        </div>
      </>
    );
  }

  /* ───────────────────── legacy mode (unchanged) ───────────────────── */
  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2>{externalReady ? 'Ready narration export' : 'Quality control & export'}</h2>
            <p className="sub" style={{ margin: 0 }}>
              {externalReady
                ? 'Final export uses the imported narration, the approved text, and the approved scenes. It does not synthesize Kokoro or Chatterbox. A QC override does not bypass this check.'
                : 'Legacy project · final export is blocked while any critical QC finding is open, unless you record an override reason. An override does not bypass imported-narration readiness. Preview does not run that check and is not an export attempt.'}
            </p>
          </div>
          <button className="btn" onClick={onBack}>
            ← Captions
          </button>
        </div>
      </div>

      <NarrationSourceSwitch projectId={projectId} narrationSource={p.meta?.input?.narrationSource} toast={toast} onSwitched={() => void load()} />
      {externalReady && prod?.exists ? (
        <div className="banner info">Production files were kept and are not the export path. This page uses the imported narration.</div>
      ) : null}
      <div className="card" data-testid="export-narration-readiness">
        <h3>Imported narration readiness</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Same server check the final export enforces. Ready to attempt export is not publication approval. Saved review
          work stays on the project; this page does not clear it.
        </p>
        {!narration ? (
          <div className="banner info">Imported-narration readiness could not be loaded. Final export still rechecks on the server.</div>
        ) : narration.importedCount === 0 && !narration.targets.some((target) => target.readiness?.inheritsLongNarration) ? (
          <div className="banner info">
            No narration was imported from outside the app. This export uses each target's own file, if any, and does not
            borrow another target's audio.
          </div>
        ) : (
          narration.targets
            .filter((target) => target.readiness && (target.readiness.applies || target.readiness.inheritsLongNarration))
            .map((target) => (
              <ExternalNarrationReadinessCard key={target.targetId} target={target} onFix={onBack} />
            ))
        )}
        {exportBlock ? (
          <div className="banner bad mt">
            {exportBlock.blockReason ?? exportBlock.error ?? 'Final export was rejected.'}
            {Array.isArray(exportBlock.externalNarrationGate?.findings)
              ? exportBlock.externalNarrationGate.findings.map((finding: { code?: string; message?: string; remediation?: string }) => (
                  <div key={`${finding.code}-${finding.message}`} className="small">
                    {finding.message} {finding.remediation}
                  </div>
                ))
              : null}
          </div>
        ) : null}
      </div>

      {sim ? (
        <div className={`banner ${sim.blocking ? 'bad' : 'ok'}`}>
          Visual similarity <b>{sim.score}%</b> (gate {sim.threshold}%). {sim.reasons.join(' · ')}
        </div>
      ) : null}

      <div className="grid2">
        <div className="card">
          <h3>Render</h3>
          <p className="sub">
            Preview renders the whole timeline quickly at a lower bitrate. Final renders 1920×1080 + up to three 1080×1920 shorts at the
            delivery bitrate, then runs ffprobe on the real file.
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
            <p className="small mt">A QC override is recorded for QC only. It does not approve imported narration or clear publication.</p>
          </div>

          {job?.status === 'running' ? (
            <>
              <div className="meter mt">
                <div style={{ width: '60%', background: 'var(--secondary)' }} />
              </div>
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
