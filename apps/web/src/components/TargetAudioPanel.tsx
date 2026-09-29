import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { Banner, Tag } from './ui';

export interface TargetAudioStatus {
  targetId: 'long' | 'short_1' | 'short_2' | 'short_3';
  label: string;
  exists: boolean;
  ready: boolean;
  storedRef: string | null;
  fileName: string | null;
  durationSec: number | null;
  status: 'ready' | 'missing';
  message: string;
  explanation: string;
}

export interface TargetAudioSummary {
  projectId: string;
  readyCount: number;
  missingCount: number;
  totalTargets: number;
  blockedTargets: string[];
  targets: TargetAudioStatus[];
}

export interface TargetAudioPanelProps {
  projectId: string;
  toast: (text: string, kind?: 'ok' | 'bad' | 'info') => void;
  onAudioChange?: () => void;
  initialSummary?: TargetAudioSummary;
}

export const TargetAudioPanel: React.FC<TargetAudioPanelProps> = ({
  projectId,
  toast,
  onAudioChange,
  initialSummary,
}) => {
  const [summary, setSummary] = useState<TargetAudioSummary | null>(initialSummary ?? null);
  const [loading, setLoading] = useState(!initialSummary);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [timingNotice, setTimingNotice] = useState<string | null>(null);

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const loadSummary = useCallback(async () => {
    try {
      setLoading(true);
      setPanelError(null);
      const data = await api.targetAudio(projectId);
      setSummary(data);
    } catch (err: any) {
      setPanelError(err.message ?? 'Failed to load narration audio status.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const handleUpload = async (targetId: string, file: File) => {
    if (!file) return;
    setBusyTarget(targetId);
    setPanelError(null);
    setTimingNotice(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await api.uploadTargetAudio(projectId, targetId, formData);
      if (res.summary) {
        setSummary(res.summary);
      } else {
        await loadSummary();
      }
      // ANTIGRAVITY_PHASE0B_TIMING_INTEGRATION:
      // Audio duration is recorded; storyboard timing regeneration is explicitly deferred.
      const noticeMsg = res.message ?? 'Regenerate the storyboard to apply the new audio timing.';
      setTimingNotice(noticeMsg);
      toast(`Narration uploaded for ${targetId === 'long' ? 'Long video' : targetId}. ${noticeMsg}`, 'ok');
      if (onAudioChange) onAudioChange();
    } catch (err: any) {
      const msg = err.message ?? 'Upload failed.';
      setPanelError(msg);
      toast(msg, 'bad');
    } finally {
      setBusyTarget(null);
      // Reset input value so re-selecting same file triggers onChange
      if (fileInputRefs.current[targetId]) {
        fileInputRefs.current[targetId]!.value = '';
      }
    }
  };

  const handleRemove = async (targetId: string) => {
    setBusyTarget(targetId);
    setPanelError(null);
    setTimingNotice(null);

    try {
      const res = await api.deleteTargetAudio(projectId, targetId);
      if (res.summary) {
        setSummary(res.summary);
      } else {
        await loadSummary();
      }
      toast(`Narration audio removed for ${targetId === 'long' ? 'Long video' : targetId}.`, 'ok');
      if (onAudioChange) onAudioChange();
    } catch (err: any) {
      const msg = err.message ?? 'Failed to remove audio.';
      setPanelError(msg);
      toast(msg, 'bad');
    } finally {
      setBusyTarget(null);
    }
  };

  const formatDuration = (sec: number | null) => {
    if (sec === null || sec === undefined) return null;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m ${s}s (${sec.toFixed(1)}s)`;
  };

  if (loading && !summary) {
    return (
      <div className="card narration-audio-panel" aria-busy="true" aria-live="polite">
        <h3 id="narration-heading">Narration audio</h3>
        <p className="sub">Loading narration audio status…</p>
      </div>
    );
  }

  const targets = summary?.targets ?? [];
  const readyCount = summary?.readyCount ?? 0;
  const totalCount = summary?.totalTargets ?? targets.length;
  const missingCount = summary?.missingCount ?? 0;
  const blockedTargets = summary?.blockedTargets ?? [];

  return (
    <div className="card narration-audio-panel" aria-labelledby="narration-heading">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h3 id="narration-heading" style={{ fontSize: 16, margin: '0 0 4px', color: 'var(--text)' }}>
            Narration audio
          </h3>
          <p className="sub" style={{ margin: 0 }}>
            {readyCount} of {totalCount} narration tracks ready
            {missingCount > 0 ? ` · ${missingCount} missing audio` : ' · All targets ready for export'}
          </p>
        </div>
        <div className="row">
          {missingCount === 0 ? (
            <Tag kind="ok">✓ All targets ready</Tag>
          ) : (
            <Tag kind="warn">⚠ {missingCount} target{missingCount > 1 ? 's' : ''} blocked</Tag>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <p className="sub" style={{ margin: '0 0 8px', fontSize: 12.5, lineHeight: 1.5 }}>
          Each Short requires its own narration. Long narration is not reused automatically. Missing audio
          blocks only the affected target; other ready targets can still be exported.
        </p>
        {blockedTargets.length > 0 && (
          <div
            className="row"
            style={{
              padding: '6px 12px',
              background: '#2c1e08',
              border: '1px solid #5c430e',
              borderRadius: 8,
              fontSize: 12,
              color: '#ffd166',
            }}
          >
            <strong>Blocked from export:</strong>
            <span>{blockedTargets.join(', ')}</span>
          </div>
        )}
      </div>

      {panelError && (
        <Banner kind="bad">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{panelError}</span>
            <button className="btn sm ghost" onClick={() => setPanelError(null)} aria-label="Dismiss error">
              ✕
            </button>
          </div>
        </Banner>
      )}

      {timingNotice && (
        <Banner kind="ok">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{timingNotice}</span>
            <button className="btn sm ghost" onClick={() => setTimingNotice(null)} aria-label="Dismiss notice">
              ✕
            </button>
          </div>
        </Banner>
      )}

      <div className="target-audio-list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {targets.map((target) => {
          const isBusy = busyTarget === target.targetId;
          const isReady = target.ready;

          return (
            <div
              key={target.targetId}
              className="target-audio-row"
              data-testid={`target-audio-${target.targetId}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 14,
                alignItems: 'center',
                padding: '12px 16px',
                background: '#0b192c',
                border: `1px solid ${isReady ? 'var(--line)' : '#4a3215'}`,
                borderRadius: 10,
              }}
            >
              <div>
                <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
                    {target.label}
                  </span>
                  {isReady ? (
                    <Tag kind="ok">Ready</Tag>
                  ) : (
                    <Tag kind="bad">Missing audio</Tag>
                  )}
                  {isBusy && <Tag kind="accent">Busy…</Tag>}
                </div>

                <div className="sub" style={{ margin: '0 0 6px', fontSize: 12 }}>
                  {target.explanation}
                </div>

                {isReady ? (
                  <div className="row" style={{ gap: 12, fontSize: 12, color: 'var(--muted)' }}>
                    {target.fileName && (
                      <span className="mono" style={{ color: 'var(--text)', fontSize: 12 }}>
                        📄 {target.fileName}
                      </span>
                    )}
                    {target.durationSec !== null && (
                      <span className="mono" style={{ color: 'var(--good)', fontWeight: 600 }}>
                        ⏱ {formatDuration(target.durationSec)}
                      </span>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: '#e0a96d' }}>
                    Narration missing. Upload an MP3, WAV, or M4A file to enable this target.
                  </div>
                )}
              </div>

              <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                <input
                  type="file"
                  ref={(el) => {
                    fileInputRefs.current[target.targetId] = el;
                  }}
                  accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4,audio/x-m4a"
                  style={{ display: 'none' }}
                  aria-label={`Upload narration audio for ${target.label}`}
                  disabled={isBusy || busyTarget !== null}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleUpload(target.targetId, f);
                  }}
                />

                {isReady ? (
                  <>
                    <button
                      className="btn sm"
                      disabled={isBusy || busyTarget !== null}
                      onClick={() => fileInputRefs.current[target.targetId]?.click()}
                      aria-label={`Replace narration audio for ${target.label}`}
                    >
                      {isBusy ? 'Uploading…' : 'Replace audio'}
                    </button>
                    <button
                      className="btn sm danger"
                      disabled={isBusy || busyTarget !== null}
                      onClick={() => handleRemove(target.targetId)}
                      aria-label={`Remove narration audio for ${target.label}`}
                    >
                      {isBusy ? 'Removing…' : 'Remove'}
                    </button>
                  </>
                ) : (
                  <button
                    className="btn sm primary"
                    disabled={isBusy || busyTarget !== null}
                    onClick={() => fileInputRefs.current[target.targetId]?.click()}
                    aria-label={`Upload narration audio for ${target.label}`}
                  >
                    {isBusy ? 'Uploading…' : 'Upload audio'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
