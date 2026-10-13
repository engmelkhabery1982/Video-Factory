/**
 * Final export of the saved editor revision (closure round, Gate 4).
 *
 * The export renders the frozen revision the server saves when the job starts.
 * Edits made afterwards do not change that file; the panel says whether the
 * document has moved on (stale) so nobody mistakes an old file for the current cut.
 */
import React, { useEffect, useState } from 'react';
import { Banner, Tag } from '../ui';
import { getExportJob, requestExport, type ExportJobResult } from '../../lib/editor-api';
import type { EditorTargetId } from '../../lib/editor-types';
import { describeError } from '../../lib/editor-model';

interface Props {
  projectId: string;
  targetId: EditorTargetId;
  /** The saved revision the server is at. Pending local edits are not part of an export. */
  savedRevision: number;
  dirty: boolean;
}

export const EditorExportPanel: React.FC<Props> = ({ projectId, targetId, savedRevision, dirty }) => {
  const [job, setJob] = useState<ExportJobResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll the running job. Stops on ready/failed or when the panel unmounts.
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    let cancelled = false;
    const timer = setInterval(() => {
      getExportJob(projectId, job.jobId, targetId)
        .then((next) => {
          if (!cancelled) setJob(next);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(describeError(e));
        });
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job, projectId, targetId]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await requestExport(projectId, targetId, savedRevision);
      const first = await getExportJob(projectId, started.jobId, targetId);
      setJob(first);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const stale = job ? job.stale : false;

  return (
    <div className="card" data-testid="editor-export-panel">
      <h3 style={{ marginTop: 0 }}>Final export</h3>
      <p className="small">
        Renders the whole saved revision through the same renderer and audio resolver as the server preview. Pending local edits are not
        included: save first.
      </p>
      {dirty ? <Banner kind="warn">You have unsaved edits. Save them, then export, so the file matches what you see.</Banner> : null}
      <div className="row">
        <button className="btn primary" disabled={busy || dirty || job?.status === 'running'} onClick={() => void start()}>
          {busy || job?.status === 'running' ? 'Exporting…' : `Export revision ${savedRevision}`}
        </button>
      </div>
      {error ? <Banner kind="warn">{error}</Banner> : null}
      {job ? (
        <div className="small mt" data-testid="editor-export-status">
          <div>
            Export <span className="mono">{job.jobId}</span> · status <b>{job.status}</b> · exported revision{' '}
            <b data-testid="editor-export-revision">{job.exportedRevision}</b>
            {job.currentRevision !== null ? <> · current revision {job.currentRevision}</> : null}{' '}
            {job.status === 'ready' ? (
              stale ? <Tag kind="warn">stale: the document changed after this export</Tag> : <Tag kind="ok">matches the current revision</Tag>
            ) : null}
          </div>
          {job.status === 'failed' ? <Banner kind="bad">The export failed: {job.error}</Banner> : null}
          {job.status === 'ready' && job.mediaUrl ? (
            <div className="mt">
              <video controls preload="metadata" src={job.mediaUrl} style={{ maxWidth: '100%', maxHeight: 360 }} data-testid="editor-export-video" />
              <div>
                <a className="btn sm" href={job.mediaUrl} download>
                  Download the exported file
                </a>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
