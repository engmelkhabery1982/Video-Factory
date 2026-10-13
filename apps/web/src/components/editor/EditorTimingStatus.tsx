/**
 * Timing provenance for the open project, as the server reports it. Refetches when
 * the document revision changes (save, undo, redo, accepted alignment), so the label
 * never describes an older document. A failed request shows an error, not a label.
 */
import React, { useEffect, useState } from 'react';
import { factoryApi, type FactoryTimingStatus } from '../../lib/factory-api';

const ALIGNMENT_NOTES: Record<string, string> = {
  proposed: 'An alignment proposal is waiting for review. It is not applied to the timing.',
  running: 'Alignment is running. It is not applied to the timing.',
  approved: 'Alignment accepted in review.',
};

export const EditorTimingStatus: React.FC<{ projectId: string; revision: number }> = ({ projectId, revision }) => {
  const [status, setStatus] = useState<FactoryTimingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    factoryApi
      .projectTiming(projectId)
      .then((t) => {
        if (!alive) return;
        setError(null);
        setStatus(t);
      })
      .catch(() => {
        if (!alive) return;
        setStatus(null);
        setError('Timing status could not be loaded.');
      });
    return () => {
      alive = false;
    };
  }, [projectId, revision]);

  if (error) {
    return <p className="small warn-text" data-testid="editor-timing">{error}</p>;
  }
  if (!status) {
    return <p className="small" data-testid="editor-timing">Checking timing…</p>;
  }
  const note = ALIGNMENT_NOTES[status.alignmentStatus ?? ''];
  return (
    <div className="small" data-testid="editor-timing" data-status={status.status}>
      <div>
        <strong>Timing:</strong> {status.label}
      </div>
      {status.status !== 'applied' && status.appliedSource ? (
        <div>Applied from apply: {status.appliedLabel}</div>
      ) : null}
      {note && status.status !== 'alignment_accepted' ? <div>{note}</div> : null}
    </div>
  );
};
