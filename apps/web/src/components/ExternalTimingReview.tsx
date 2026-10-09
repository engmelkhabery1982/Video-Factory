/**
 * VS5 timing review, mounted inside the existing external-narration panel.
 *
 * One editor writes the storyboard timing for the selected target. It does not
 * open a second timeline, and it does not change the audio.
 */
import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

export interface TimingSceneRow {
  sceneId: string;
  index: number;
  role?: string;
  startTime: number;
  durationSec: number;
  narration: string;
  timingSource: 'estimated' | 'imported_structural' | 'exact';
}

export interface TimingCaptionRow {
  cueId: string;
  sceneId: string | null;
  start: number;
  end: number;
  text: string;
  timingSource?: string;
}

export interface TimingReviewPayload {
  targetId: string;
  label?: string;
  audioDurationSec: number | null;
  timelineDurationSec: number | null;
  endCardSeconds: number;
  alignmentVerified?: boolean;
  acousticVerification?: false;
  timingReview?: {
    source: string;
    review: string;
    sourceLabel: string;
    reviewLabel: string;
    detail: string;
    acousticVerification: false;
  } | null;
  scenes: TimingSceneRow[];
  captions?: TimingCaptionRow[];
  findings?: { code: string; severity: string; message: string; remediation: string }[];
  blockReasons?: string[];
}

interface DraftScene {
  sceneId: string;
  startTime: string;
  durationSec: string;
}
interface DraftCue {
  cueId: string;
  start: string;
  end: string;
}

function sourceHeading(timing: TimingReviewPayload): string {
  if (timing.timingReview?.source === 'imported_structural') {
    return 'Script-matched imported timing (not a listening check)';
  }
  if (timing.timingReview?.review === 'approved') {
    return 'Manually reviewed timing';
  }
  return 'ESTIMATED scene timing (not verified alignment)';
}

function formatPosition(value: number): string {
  return `${value.toFixed(2)}s`;
}

export const ExternalTimingReview: React.FC<{
  projectId: string;
  targetId: string;
  targetLabel: string;
  timing: TimingReviewPayload;
  audio: HTMLAudioElement | null;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: (timing: TimingReviewPayload) => void;
  onError: (message: string) => void;
  toast: (text: string, kind?: 'ok' | 'bad' | 'info') => void;
}> = ({ projectId, targetId, targetLabel, timing, audio, busy, onBusy, onSaved, onError, toast }) => {
  const [scenes, setScenes] = useState<DraftScene[]>([]);
  const [captions, setCaptions] = useState<DraftCue[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [position, setPosition] = useState(0);
  const [issues, setIssues] = useState<{ message: string; remediation: string }[]>([]);

  useEffect(() => {
    setScenes(timing.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      startTime: scene.startTime.toFixed(2),
      durationSec: scene.durationSec.toFixed(2),
    })));
    setCaptions((timing.captions ?? []).map((cue) => ({
      cueId: cue.cueId,
      start: cue.start.toFixed(2),
      end: cue.end.toFixed(2),
    })));
    setReviewed(false);
    setIssues([]);
  }, [timing]);

  useEffect(() => {
    if (!audio) return;
    const onTime = () => setPosition(audio.currentTime || 0);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('seeked', onTime);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('seeked', onTime);
    };
  }, [audio]);

  const playFrom = (seconds: number) => {
    if (!audio) return;
    audio.currentTime = seconds;
    setPosition(seconds);
    void audio.play?.();
  };

  const payload = () => ({
    scenes: scenes.map((scene) => ({
      sceneId: scene.sceneId,
      startTime: Number(scene.startTime),
      durationSec: Number(scene.durationSec),
    })),
    captions: captions.map((cue) => ({
      cueId: cue.cueId,
      start: Number(cue.start),
      end: Number(cue.end),
    })),
  });

  const showIssues = (err: any) => {
    const list = err?.payload?.issues ?? err?.payload?.blocking ?? [];
    setIssues(Array.isArray(list) ? list.map((item: any) => ({
      message: item.code ? `${item.code}: ${item.message}` : item.message,
      remediation: item.remediation ?? '',
    })) : []);
    onError(err?.message ?? 'The timing could not be saved.');
  };

  const check = async () => {
    onBusy(true);
    try {
      const result = await api.validateExternalNarrationTiming(projectId, targetId, payload());
      setIssues(result.issues ?? []);
      toast(result.allowed ? 'Timing is valid.' : 'Timing has errors.', result.allowed ? 'ok' : 'bad');
    } catch (err: any) {
      showIssues(err);
    } finally {
      onBusy(false);
    }
  };

  const save = async () => {
    onBusy(true);
    try {
      const result = await api.saveExternalNarrationTiming(projectId, targetId, payload());
      setIssues([]);
      onSaved(result.timing);
      toast('Timing saved. Approve it again before export.', 'ok');
    } catch (err: any) {
      showIssues(err);
      toast(err?.message ?? 'The timing could not be saved.', 'bad');
    } finally {
      onBusy(false);
    }
  };

  const approve = async () => {
    onBusy(true);
    try {
      const result = await api.approveExternalNarrationTiming(projectId, targetId, {
        decision: 'approved',
        reviewed: true,
        decidedBy: 'project-owner',
      });
      onSaved(result.timing);
      toast('Timing approved for this audio and script.', 'ok');
    } catch (err: any) {
      showIssues(err);
      toast(err?.message ?? 'The timing could not be approved.', 'bad');
    } finally {
      onBusy(false);
    }
  };

  const review = timing.timingReview;
  return (
    <div style={{ marginTop: 10, fontSize: 12 }} data-testid={`timing-review-${targetId}`}>
      <strong>Timing for {targetLabel}</strong>
      <div>{sourceHeading(timing)}</div>
      {timing.audioDurationSec != null ? (
        <div className="sub" style={{ margin: '4px 0', fontSize: 11.5 }}>
          Active audio for {targetLabel}: {timing.audioDurationSec.toFixed(2)}s measured. This editor does not change the file.
        </div>
      ) : null}
      <p className="sub" style={{ margin: '6px 0', fontSize: 11.5 }}>
        {review?.detail ?? 'Review these times against the approved audio. Estimates are not verified alignment.'}
      </p>
      <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span className="mono" data-testid={`playback-position-${targetId}`}>Playback position: {formatPosition(position)}</span>
        <span>{review?.sourceLabel ?? 'Estimated timing'}</span>
        <span>{review?.reviewLabel ?? 'Timing not approved'}</span>
        {timing.acousticVerification === false ? <span>Not acoustically verified</span> : null}
      </div>

      <table className="mono" style={{ width: '100%', marginTop: 6, fontSize: 11.5, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>#</th>
            <th style={{ textAlign: 'left' }}>Scene</th>
            <th style={{ textAlign: 'right' }}>Start</th>
            <th style={{ textAlign: 'right' }}>Duration</th>
            <th style={{ textAlign: 'left' }}>Timing source</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {timing.scenes.map((scene, index) => {
            const draft = scenes[index];
            return (
              <tr key={scene.sceneId}>
                <td>{scene.index + 1}</td>
                <td>{scene.sceneId}</td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    aria-label={`Scene ${scene.sceneId} start for ${targetLabel}`}
                    value={draft?.startTime ?? ''}
                    onChange={(event) => setScenes((rows) => rows.map((row, i) => i === index ? { ...row, startTime: event.target.value } : row))}
                    style={{ width: 72 }}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    aria-label={`Scene ${scene.sceneId} duration for ${targetLabel}`}
                    value={draft?.durationSec ?? ''}
                    onChange={(event) => setScenes((rows) => rows.map((row, i) => i === index ? { ...row, durationSec: event.target.value } : row))}
                    style={{ width: 72 }}
                  />
                </td>
                <td>{scene.timingSource === 'imported_structural' || scene.timingSource === 'exact' ? 'script-matched' : 'estimated'}</td>
                <td>
                  <button
                    className="btn sm ghost"
                    type="button"
                    aria-label={`Play from scene ${scene.sceneId} for ${targetLabel}`}
                    onClick={() => playFrom(Number(draft?.startTime ?? scene.startTime))}
                  >
                    Play from here
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {(timing.captions ?? []).length > 0 ? (
        <table className="mono" style={{ width: '100%', marginTop: 10, fontSize: 11.5, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Caption</th>
              <th style={{ textAlign: 'right' }}>Start</th>
              <th style={{ textAlign: 'right' }}>End</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(timing.captions ?? []).map((cue, index) => {
              const draft = captions[index];
              return (
                <tr key={cue.cueId}>
                  <td>{cue.text}</td>
                  <td style={{ textAlign: 'right' }}>
                    <input
                      aria-label={`Caption ${cue.cueId} start for ${targetLabel}`}
                      value={draft?.start ?? ''}
                      onChange={(event) => setCaptions((rows) => rows.map((row, i) => i === index ? { ...row, start: event.target.value } : row))}
                      style={{ width: 72 }}
                    />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <input
                      aria-label={`Caption ${cue.cueId} end for ${targetLabel}`}
                      value={draft?.end ?? ''}
                      onChange={(event) => setCaptions((rows) => rows.map((row, i) => i === index ? { ...row, end: event.target.value } : row))}
                      style={{ width: 72 }}
                    />
                  </td>
                  <td>
                    <button
                      className="btn sm ghost"
                      type="button"
                      aria-label={`Play from caption ${cue.cueId} for ${targetLabel}`}
                      onClick={() => playFrom(Number(draft?.start ?? cue.start))}
                    >
                      Play from here
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {issues.length > 0 ? (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#ffd166' }}>
          {issues.map((issue) => (
            <li key={issue.message}>{issue.message} {issue.remediation}</li>
          ))}
        </ul>
      ) : null}

      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn sm" type="button" disabled={busy} aria-label={`Check timing for ${targetLabel}`} onClick={() => void check()}>
          Check timing
        </button>
        <button className="btn sm primary" type="button" disabled={busy} aria-label={`Save timing for ${targetLabel}`} onClick={() => void save()}>
          Save timing
        </button>
      </div>
      <label className="row" style={{ gap: 6, fontSize: 12, marginTop: 8 }}>
        <input
          type="checkbox"
          checked={reviewed}
          aria-label={`I reviewed the timing against the audio for ${targetLabel}`}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        I reviewed these times against this audio
      </label>
      <button
        className="btn sm primary"
        type="button"
        disabled={busy || !reviewed}
        aria-label={`Approve timing for ${targetLabel}`}
        onClick={() => void approve()}
        title={reviewed ? undefined : 'Review the times against the audio first.'}
      >
        Approve this timing
      </button>
    </div>
  );
};
