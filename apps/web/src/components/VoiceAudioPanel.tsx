import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Banner, Field, Tag } from './ui';

/**
 * VS3 — "Voice & Audio" panel.
 *
 * One compact section inside the existing project workflow that lets a user:
 *   1. see truthful engine availability (Available / Not provisioned / Device
 *      unsupported / Blocked by consent or approval / Generation failed) with the
 *      exact remedy, and pick Kokoro or Chatterbox as an explicit choice;
 *   2. upload a voice reference, confirm authorization, review validation and
 *      approve it through the existing VS1 mechanism;
 *   3. assign a voice to each speaker;
 *   4. generate the complete narration preview, watch progress, play it and
 *      approve or reject that exact artifact.
 *
 * The UI never decides anything: every gate lives in the API/core contracts and
 * this panel only reflects them. It never shows a filesystem path.
 */

export interface EngineStatus {
  engine: 'kokoro' | 'chatterbox';
  engineId: string;
  label: string;
  state: 'available' | 'not_provisioned' | 'device_unsupported' | 'blocked_by_approval' | 'generation_failed';
  detail: string;
  remedy: string | null;
  selectable: boolean;
  generatable: boolean;
  unverifiedPath: boolean;
  lastFailure: { code: string; message: string } | null;
}

export interface PublicReference {
  referenceId: string;
  displayName: string;
  sha256Prefix: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  container: string;
  sizeBytes: number;
  createdAt: string;
  authorized: boolean;
  authorizedAt: string | null;
  approved: boolean;
  approvalState: 'pending' | 'approved' | 'rejected';
  approvedAt: string | null;
  blockedCodes: string[];
}

export interface VoiceAudioStatePayload {
  projectId: string;
  engines: EngineStatus[];
  kokoroSeparateChoice: true;
  references: PublicReference[];
  assignments: Array<{
    speakerId: string;
    engine: 'kokoro' | 'chatterbox';
    referenceId?: string | null;
    presetVoiceId?: string | null;
    referenceDisplayName: string | null;
    referenceApproved: boolean;
    speakerLabel: string;
  }>;
  speakers: Array<{ speakerId: string; speakerName: string; assigned: boolean }>;
  preview: {
    previewId: string;
    status: 'running' | 'ready' | 'failed';
    durationSeconds: number | null;
    language: string;
    engineSummary: string;
    createdAt: string;
    artifactAvailable: boolean;
    audioUrl: string | null;
    segments: number;
    timing: { mode: string; perSceneAlignment: boolean; durationSeconds: number | null; integrationPoint: string };
    error: { code: string; message: string; remediation?: string } | null;
  } | null;
  approval: {
    decision: 'approved' | 'rejected';
    approvedAt: string;
    approvedBy: string;
    boundToCurrentPreview: boolean;
    staleCodes: string[];
  } | null;
  renderGate: {
    allowed: boolean;
    notApplicable: boolean;
    blockedCodes: string[];
    findings: Array<{ code: string; message: string; remediation: string }>;
    reason: string;
  };
  clonedVoiceSelected: boolean;
}

export interface VoiceAudioPanelProps {
  projectId: string;
  toast: (text: string, kind?: 'ok' | 'bad' | 'info') => void;
}

const STATE_LABEL: Record<EngineStatus['state'], string> = {
  available: 'Available',
  not_provisioned: 'Not provisioned',
  device_unsupported: 'Device unsupported',
  blocked_by_approval: 'Blocked by consent or approval',
  generation_failed: 'Generation failed',
};

const STATE_KIND: Record<EngineStatus['state'], 'ok' | 'warn' | 'bad'> = {
  available: 'ok',
  not_provisioned: 'warn',
  device_unsupported: 'warn',
  blocked_by_approval: 'bad',
  generation_failed: 'bad',
};

/** Bounded, user-facing play/idle state text for the preview player. */
function previewLabel(state: VoiceAudioStatePayload['preview']): string {
  if (!state) return 'No preview has been generated yet.';
  if (state.status === 'running') return 'Generating the complete narration…';
  if (state.status === 'failed') {
    return `Generation failed (${state.error?.code ?? 'unknown'}): ${state.error?.message ?? 'no detail'}`;
  }
  return `Preview ready — ${state.segments} segment(s), ${state.durationSeconds ?? 0}s of complete speech.`;
}

export const VoiceAudioPanel: React.FC<VoiceAudioPanelProps> = ({ projectId, toast }) => {
  const [state, setState] = useState<VoiceAudioStatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [statement, setStatement] = useState('');
  const [rights, setRights] = useState({
    licenseName: '',
    evidenceUrl: '',
    commercialUse: 'permitted' as 'permitted' | 'not_stated',
  });
  const [job, setJob] = useState<{ status: string; progress?: { completed: number; total: number }; error?: { code: string; message: string } } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.voiceAudio(projectId));
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load the voice & audio state.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
  }, []);

  const chatterbox = state?.engines.find((e) => e.engine === 'chatterbox') ?? null;
  const kokoro = state?.engines.find((e) => e.engine === 'kokoro') ?? null;

  const upload = async (file: File) => {
    setBusy('upload');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('displayName', displayName.trim() || file.name.replace(/\.[^.]+$/, ''));
      const res = await api.uploadVoiceReference(projectId, form);
      toast(
        `Reference stored and validated by content (${res.validation.durationSeconds}s). Confirm authorization to continue.`,
        'ok'
      );
      setDisplayName('');
      await load();
    } catch (e: any) {
      toast(e?.message ?? 'Upload failed.', 'bad');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const confirmAuthorization = async (referenceId: string) => {
    setBusy(referenceId);
    try {
      await api.authorizeVoiceReference(projectId, referenceId, {
        ownerConfirmed: true,
        statement,
        confirmedBy: 'project-owner',
      });
      toast('Authorization recorded. The reference still needs explicit approval.', 'ok');
      setStatement('');
      await load();
    } catch (e: any) {
      toast(e?.message ?? 'Could not record authorization.', 'bad');
    } finally {
      setBusy(null);
    }
  };

  const approveReference = async (referenceId: string, decision: 'approved' | 'rejected') => {
    setBusy(referenceId);
    try {
      await api.approveVoiceReference(projectId, referenceId, {
        decision,
        approver: 'project-owner',
        rights:
          decision === 'approved'
            ? {
                sourceProvider: 'first-party recording (operator-owned)',
                licenseName: rights.licenseName || 'First-party own-voice written release',
                evidenceUrl: rights.evidenceUrl || 'https://rights.example.invalid/own-voice',
                evidenceKind: 'written_permission',
                accessedAt: new Date().toISOString().slice(0, 10),
                commercialUse: rights.commercialUse,
              }
            : undefined,
      });
      toast(decision === 'approved' ? 'Reference approved.' : 'Reference rejected.', decision === 'approved' ? 'ok' : 'info');
      await load();
    } catch (e: any) {
      const payload = e?.payload;
      toast(payload?.error ?? e?.message ?? 'Approval failed.', 'bad');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const removeReference = async (referenceId: string) => {
    setBusy(referenceId);
    try {
      await api.removeVoiceReference(projectId, referenceId);
      toast('Reference recording removed.', 'ok');
      setConfirmRemove(null);
      await load();
    } catch (e: any) {
      toast(e?.message ?? 'Removal failed.', 'bad');
    } finally {
      setBusy(null);
    }
  };

  const assign = async (speakerId: string, engine: 'kokoro' | 'chatterbox', referenceId?: string) => {
    setBusy(`assign:${speakerId}`);
    try {
      const next = new Map((state?.assignments ?? []).map((a) => [a.speakerId, { ...a }]));
      next.set(speakerId, {
        speakerId,
        engine,
        referenceId: engine === 'chatterbox' ? referenceId ?? null : null,
        presetVoiceId: engine === 'kokoro' ? 'af_heart' : null,
        referenceDisplayName: null,
        referenceApproved: false,
        speakerLabel: speakerId,
      });
      const assignments = [...next.values()].map((a) => ({
        speakerId: a.speakerId,
        engine: a.engine,
        referenceId: a.referenceId ?? undefined,
        presetVoiceId: a.presetVoiceId ?? undefined,
      }));
      await api.setVoiceAssignments(projectId, assignments);
      toast('Voice assignment saved.', 'ok');
      await load();
    } catch (e: any) {
      toast(e?.payload?.error ?? e?.message ?? 'Could not save the assignment.', 'bad');
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    setBusy('generate');
    try {
      const res = await api.generateVoicePreview(projectId);
      setJob({ status: 'running', progress: { completed: 0, total: res.totalSegments } });
      toast('Generating the complete narration preview…', 'info');
      const jobId = res.jobId as string;
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const j = await api.voiceAudioJob(projectId, jobId);
          setJob(j);
          if (j.status === 'done' || j.status === 'failed') {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            setBusy(null);
            await load();
            toast(j.status === 'done' ? 'Preview ready — listen to it, then approve.' : `Generation failed: ${j.error?.code ?? 'unknown'}`, j.status === 'done' ? 'ok' : 'bad');
          }
        } catch {
          /* keep polling; a transient poll failure is not a generation failure */
        }
      }, 700);
    } catch (e: any) {
      setBusy(null);
      const payload = e?.payload;
      toast(payload?.error ?? e?.message ?? 'Generation could not start.', 'bad');
      await load();
    }
  };

  const decidePreview = async (decision: 'approved' | 'rejected') => {
    if (!state?.preview) return;
    setBusy('preview');
    try {
      const res = await api.decideVoicePreview(projectId, state.preview.previewId, { decision, approvedBy: 'project-owner' });
      toast(decision === 'approved' ? 'You approved exactly this generated audio.' : 'Generated audio rejected.', decision === 'approved' ? 'ok' : 'info');
      void res;
      await load();
    } catch (e: any) {
      toast(e?.message ?? 'Could not record the decision.', 'bad');
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <section className="card" data-testid="voice-audio-panel">
        <h3>Voice &amp; Audio</h3>
        <Banner kind="bad">{error}</Banner>
      </section>
    );
  }

  return (
    <section className="card" data-testid="voice-audio-panel">
      <h3>Voice &amp; Audio</h3>
      <p className="hint">
        Add your own authorized voice reference, generate a complete narration preview, listen to it, and approve that
        exact audio before rendering. Kokoro presets stay a separate explicit choice; a cloned voice is never silently
        replaced.
      </p>

      {/* ---- 1. engine availability ---- */}
      <div data-testid="engine-status">
        {state?.engines.map((engine) => (
          <div key={engine.engine} className="row" style={{ alignItems: 'center', gap: 8 }}>
            <Tag kind={STATE_KIND[engine.state]}>{STATE_LABEL[engine.state]}</Tag>
            <b>{engine.label}</b>
            <span className="hint">{engine.detail}</span>
            {engine.remedy ? <span className="hint">· {engine.remedy}</span> : null}
          </div>
        ))}
        {chatterbox && chatterbox.state === 'not_provisioned' ? (
          <Banner kind="warn">
            Chatterbox is not provisioned on this machine. Provisioning is always an explicit action:{' '}
            <code>npm run provision:voice-clone -- --apply</code> (nothing is downloaded automatically, and it is never
            triggered by the app).
          </Banner>
        ) : null}
        {chatterbox && chatterbox.state === 'device_unsupported' ? (
          <Banner kind="warn">
            No usable device for cloned-voice synthesis: {chatterbox.detail} CPU execution is opt-in and is NOT verified
            as performant.
          </Banner>
        ) : null}
        {kokoro && kokoro.state === 'not_provisioned' ? (
          <Banner kind="warn">Kokoro presets are not provisioned: <code>npm run provision:tts</code>.</Banner>
        ) : null}
      </div>

      {/* ---- 2. reference recordings ---- */}
      <h4 className="mt">Voice references</h4>
      <Field label="Display name" hint="Shown to you only. It is never included in any export.">
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="My own voice"
          data-testid="reference-display-name"
          disabled={!chatterbox?.selectable}
        />
      </Field>
      <Field
        label="Reference recording"
        hint="A short recording (~10 s) of the speaker's own voice. Validated by content inspection, not by file extension."
      >
        <input
          ref={fileRef}
          type="file"
          accept="audio/wav,audio/mpeg,audio/mp4,audio/flac,audio/ogg,.wav,.mp3,.m4a,.flac,.ogg"
          data-testid="reference-file"
          disabled={!chatterbox?.selectable || busy === 'upload'}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </Field>

      {(state?.references ?? []).length === 0 ? (
        <p className="hint">No reference recording yet. Uploading one grants nothing: authorization and approval are separate steps.</p>
      ) : null}

      {(state?.references ?? []).map((reference) => (
        <div key={reference.referenceId} className="card" data-testid={`reference-${reference.referenceId}`}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <b>{reference.displayName}</b>
            <Tag>{reference.durationSeconds}s</Tag>
            <Tag>{reference.sampleRate} Hz · {reference.channels}ch</Tag>
            <Tag kind={reference.authorized ? 'ok' : 'warn'}>
              {reference.authorized ? 'Authorization recorded' : 'Authorization not confirmed'}
            </Tag>
            <Tag kind={reference.approved ? 'ok' : reference.approvalState === 'rejected' ? 'bad' : 'warn'}>
              {reference.approvalState === 'approved' ? 'Reference approved' : reference.approvalState === 'rejected' ? 'Reference rejected' : 'Reference not approved'}
            </Tag>
          </div>
          {reference.blockedCodes.length > 0 ? (
            <p className="hint">Blocked: {reference.blockedCodes.join(', ')}</p>
          ) : null}

          {!reference.authorized ? (
            <>
              <Field
                label="Authorization"
                hint="Confirm in your own words that this is your own voice, or that you hold documented rights to use it."
              >
                <textarea
                  value={statement}
                  onChange={(e) => setStatement(e.target.value)}
                  rows={2}
                  data-testid={`authorization-statement-${reference.referenceId}`}
                  placeholder="This is my own voice and I authorize its use in this project."
                />
              </Field>
              <div className="row">
                <button
                  className="primary"
                  data-testid={`authorize-${reference.referenceId}`}
                  disabled={busy === reference.referenceId || statement.trim().length < 10}
                  onClick={() => void confirmAuthorization(reference.referenceId)}
                >
                  Confirm authorization
                </button>
              </div>
            </>
          ) : null}

          {reference.authorized && !reference.approved ? (
            <>
              <Field
                label="Commercial-use evidence"
                hint="A licence that is silent about commerce is not permission. Record what permits commercial use."
              >
                <input
                  value={rights.licenseName}
                  placeholder="Licence / release name"
                  onChange={(e) => setRights((r) => ({ ...r, licenseName: e.target.value }))}
                  data-testid={`rights-license-${reference.referenceId}`}
                />
              </Field>
              <Field label="Evidence URL" hint="First-party page where the permission is published.">
                <input
                  value={rights.evidenceUrl}
                  placeholder="https://…"
                  onChange={(e) => setRights((r) => ({ ...r, evidenceUrl: e.target.value }))}
                  data-testid={`rights-url-${reference.referenceId}`}
                />
              </Field>
              <div className="row">
                <button
                  className="primary"
                  data-testid={`approve-reference-${reference.referenceId}`}
                  disabled={busy === reference.referenceId}
                  onClick={() => void approveReference(reference.referenceId, 'approved')}
                >
                  Approve reference
                </button>
                <button
                  data-testid={`reject-reference-${reference.referenceId}`}
                  disabled={busy === reference.referenceId}
                  onClick={() => void approveReference(reference.referenceId, 'rejected')}
                >
                  Reject
                </button>
              </div>
            </>
          ) : null}

          <div className="row mt">
            {confirmRemove === reference.referenceId ? (
              <>
                <Banner kind="warn">Remove “{reference.displayName}” and delete the stored recording?</Banner>
                <button
                  className="danger"
                  data-testid={`confirm-remove-${reference.referenceId}`}
                  disabled={busy === reference.referenceId}
                  onClick={() => void removeReference(reference.referenceId)}
                >
                  Yes, remove it
                </button>
                <button onClick={() => setConfirmRemove(null)}>Cancel</button>
              </>
            ) : (
              <button
                data-testid={`remove-${reference.referenceId}`}
                disabled={busy === reference.referenceId}
                onClick={() => setConfirmRemove(reference.referenceId)}
              >
                Remove reference
              </button>
            )}
          </div>
        </div>
      ))}

      {/* ---- 3. speaker assignments ---- */}
      <h4 className="mt">Speakers</h4>
      <p className="hint">
        Two different names do not imply two different voices. Assign an engine (and a reference) per speaker
        explicitly.
      </p>
      {(state?.speakers ?? []).map((speaker) => {
        const assignment = state?.assignments.find((a) => a.speakerId === speaker.speakerId) ?? null;
        const approvedRefs = (state?.references ?? []).filter((r) => r.approved && r.blockedCodes.length === 0);
        return (
          <div key={speaker.speakerId} className="row" style={{ gap: 8, alignItems: 'center' }} data-testid={`speaker-${speaker.speakerId}`}>
            <b>{speaker.speakerName}</b>
            <select
              data-testid={`engine-${speaker.speakerId}`}
              value={assignment?.engine ?? ''}
              disabled={busy === `assign:${speaker.speakerId}`}
              onChange={(e) => {
                const value = e.target.value;
                if (value === 'kokoro') void assign(speaker.speakerId, 'kokoro');
                if (value === 'chatterbox' && approvedRefs[0]) void assign(speaker.speakerId, 'chatterbox', approvedRefs[0].referenceId);
              }}
            >
              <option value="">— choose a voice —</option>
              <option value="kokoro" disabled={!kokoro?.selectable}>
                Kokoro preset (not a clone)
              </option>
              <option value="chatterbox" disabled={!chatterbox?.selectable || approvedRefs.length === 0}>
                Chatterbox cloned voice (approved reference)
              </option>
            </select>
            {assignment?.engine === 'chatterbox' ? (
              <select
                data-testid={`reference-${speaker.speakerId}`}
                value={assignment.referenceId ?? ''}
                disabled={busy === `assign:${speaker.speakerId}`}
                onChange={(e) => void assign(speaker.speakerId, 'chatterbox', e.target.value)}
              >
                {approvedRefs.map((r) => (
                  <option key={r.referenceId} value={r.referenceId}>
                    {r.displayName}
                  </option>
                ))}
              </select>
            ) : null}
            <span className="hint">
              {assignment ? `${assignment.engine}${assignment.referenceDisplayName ? ` · ${assignment.referenceDisplayName}` : ''}` : 'not assigned'}
            </span>
          </div>
        );
      })}

      {/* ---- 4. preview generation, playback, approval ---- */}
      <h4 className="mt">Audio preview</h4>
      <div className="row">
        <button
          className="primary"
          data-testid="generate-preview"
          disabled={busy !== null || (state?.assignments.length ?? 0) === 0}
          onClick={() => void generate()}
        >
          Generate complete preview
        </button>
        {job?.progress ? (
          <span className="hint" data-testid="generation-progress">
            {job.progress.completed}/{job.progress.total} segments
          </span>
        ) : null}
      </div>

      <p className="hint" data-testid="preview-status">
        {previewLabel(state?.preview ?? null)}
      </p>

      {state?.preview?.status === 'failed' && state.preview.error ? (
        <Banner kind="bad" >
          <b>{state.preview.error.code}</b> — {state.preview.error.message}
          {state.preview.error.remediation ? <> · {state.preview.error.remediation}</> : null}
        </Banner>
      ) : null}

      {state?.preview?.audioUrl ? (
        <div className="row">
          {/* The player always points at THIS project's current preview artifact. */}
          <audio
            controls
            data-testid="preview-audio"
            src={state.preview.audioUrl}
            aria-label="Generated narration preview"
          />
        </div>
      ) : null}

      {state?.preview?.status === 'ready' ? (
        <div className="row">
          <button
            className="primary"
            data-testid="approve-preview"
            disabled={busy === 'preview'}
            onClick={() => void decidePreview('approved')}
          >
            Approve this exact audio
          </button>
          <button data-testid="reject-preview" disabled={busy === 'preview'} onClick={() => void decidePreview('rejected')}>
            Reject
          </button>
          {state.approval ? (
            /* The wrapper carries the test id: `Tag` renders a plain span. */
            <span data-testid="approval-state">
              <Tag kind={state.approval.boundToCurrentPreview ? 'ok' : 'warn'}>
                {state.approval.decision === 'approved'
                  ? state.approval.boundToCurrentPreview
                    ? 'Approved for the current inputs'
                    : `Approval stale (${state.approval.staleCodes.join(', ')})`
                  : 'Rejected'}
              </Tag>
            </span>
          ) : null}
        </div>
      ) : null}

      {state?.preview?.timing ? (
        <p className="hint" data-testid="timing-note">
          Complete speech preserved: {state.preview.timing.durationSeconds ?? '?'}s measured. Per-scene alignment is not
          derived yet, so rendering with a cloned voice stays blocked until the timing integration point is connected.
        </p>
      ) : null}

      {/* ---- render gate ---- */}
      <h4 className="mt">Rendering</h4>
      {state ? (
        <div data-testid="render-gate">
          {state.renderGate.notApplicable ? (
            <Tag kind="ok">No cloned voice selected — the existing narration flow is unchanged.</Tag>
          ) : state.renderGate.allowed ? (
            <Tag kind="ok">Cloned audio is authorized, generated and approved for the current inputs.</Tag>
          ) : (
            <>
              <Tag kind="bad">Rendering blocked for cloned audio</Tag>
              <ul className="hint">
                {state.renderGate.findings.map((f) => (
                  <li key={f.code}>
                    <b>{f.code}</b> — {f.message} · {f.remediation}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
};
