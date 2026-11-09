import React, { useState } from 'react';
import { api } from '../lib/api';
import { usesExternalReadyNarration } from '../lib/narration-source';

/**
 * Explicit transition to ready narration. Rendering this card does not change
 * the project. The operator has to confirm.
 */
export const NarrationSourceSwitch: React.FC<{
  projectId: string;
  narrationSource: unknown;
  toast: (text: string, kind?: 'ok' | 'bad' | 'info') => void;
  onSwitched: () => void;
}> = ({ projectId, narrationSource, toast, onSwitched }) => {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (usesExternalReadyNarration({ narrationSource })) return null;
  const commit = async () => {
    setBusy(true);
    try {
      await api.setNarrationSource(projectId, { narrationSource: 'external_ready', confirm: true });
      toast('Narration source saved. Production files were kept and are no longer the export path. No speech engine was started.', 'ok');
      setConfirming(false);
      onSwitched();
    } catch (error) {
      toast((error as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" data-testid="narration-source-switch">
      <h3>Narration source</h3>
      <p className="sub">
        This project is still on in-app dialogue, or it was created before the choice was saved. Opening this page does not switch it and does not delete production files.
      </p>
      {confirming ? (
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => void commit()}>
            {busy ? 'Saving…' : 'Confirm: use my ready narration'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="btn" onClick={() => setConfirming(true)}>
          Use ready narration from outside the app
        </button>
      )}
    </div>
  );
};
