/**
 * Gemini planning inputs and job state. Generation happens only on the explicit Generate click.
 *
 * - Reads (status, job polling) never call the provider. Polling only asks the server about a job.
 * - A job's result becomes a draft only when the server reports `succeeded`. Cancelled, failed
 *   and interrupted jobs never produce a draft and never look successful.
 * - The active job id is kept in localStorage so a reload resumes the same job (no new spend).
 * - Refusals keep the brief, the references and the settings on screen.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Tag } from '../ui';
import {
  FactoryApiError,
  type AiJob,
  type AiStatus,
  type FactoryAiClient,
  type FactoryDraftEnvelope,
  type FactoryFormat,
  type FactoryProfile,
  type PlanRequestBody,
} from '../../lib/factory-api';
import {
  failureAdvice,
  generateGate,
  jobStatusView,
  parseReferenceLines,
  textRequestsLeft,
} from '../../lib/gemini-plan-model';

export const ACTIVE_JOB_KEY = 'vf.gemini.activePlanJob';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export interface GeminiPlanPanelProps {
  ai: FactoryAiClient;
  /** Milliseconds between job status checks. Tests use a short interval. */
  pollMs?: number;
  hasUnsavedEdits: boolean;
  onDraft: (env: FactoryDraftEnvelope) => void;
}

const readActiveJob = (): string | null => {
  try {
    return window.localStorage.getItem(ACTIVE_JOB_KEY);
  } catch {
    return null;
  }
};
const writeActiveJob = (id: string | null) => {
  try {
    if (id) window.localStorage.setItem(ACTIVE_JOB_KEY, id);
    else window.localStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {
    /* storage can be disabled; the job is still on the server */
  }
};

export const GeminiPlanPanel: React.FC<GeminiPlanPanelProps> = ({ ai, pollMs = 1500, hasUnsavedEdits, onDraft }) => {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [profile, setProfile] = useState<FactoryProfile>('educational');
  const [format, setFormat] = useState<FactoryFormat>('landscape');
  const [brief, setBrief] = useState('');
  const [refsText, setRefsText] = useState('');
  const [factsText, setFactsText] = useState('');
  const [productMention, setProductMention] = useState(false);
  const [confirmedFreeTier, setConfirmedFreeTier] = useState(false);
  const [job, setJob] = useState<AiJob | null>(null);
  const [jobError, setJobError] = useState<{ code: string; message: string } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await ai.aiStatus();
      if (alive.current) {
        setStatus(s);
        setStatusError(null);
      }
    } catch (e) {
      if (alive.current) setStatusError((e as Error).message);
    }
  }, [ai]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  /* Turn a succeeded job into a draft. Idempotent on the server: a second call returns the same draft. */
  const convert = useCallback(
    async (j: AiJob) => {
      try {
        const env = await ai.planDraft(j.id, { format });
        if (!alive.current) return;
        writeActiveJob(null);
        onDraft(env);
      } catch (e) {
        if (alive.current) setJobError({ code: (e as FactoryApiError).code ?? 'FACTORY_HTTP', message: (e as Error).message });
      }
    },
    [ai, format, onDraft],
  );

  /* Resume the job id stored before a reload. No provider call: it is a status read. */
  useEffect(() => {
    const id = readActiveJob();
    if (!id) return;
    ai.getJob(id)
      .then((j) => {
        if (!alive.current) return;
        setJob(j);
        if (j.status === 'succeeded') void convert(j);
        if (TERMINAL.has(j.status) && j.status !== 'succeeded') writeActiveJob(null);
      })
      .catch((e) => {
        if (alive.current) setCheckError(`The saved plan job could not be checked: ${(e as Error).message}. It may still be running on the server.`);
      });
    // Resume once per mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai]);

  /* Poll a running job. A transport failure keeps the job "unknown", never "failed". */
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const timer = window.setTimeout(() => {
      ai.getJob(job.id)
        .then((j) => {
          if (!alive.current) return;
          setCheckError(null);
          setJob(j);
          if (j.status === 'succeeded') void convert(j);
          if (TERMINAL.has(j.status)) writeActiveJob(null);
        })
        .catch((e) => {
          if (alive.current) setCheckError(`Could not check the job just now (${(e as Error).message}). It may still be running. Nothing is assumed.`);
        });
    }, pollMs);
    return () => window.clearTimeout(timer);
  }, [ai, job, pollMs, convert]);

  const gate = generateGate({
    status,
    statusError,
    confirmedFreeTier,
    briefText: brief,
    jobRunning: job?.status === 'running',
    hasUnsavedEdits,
  });

  const generate = async () => {
    if (!gate.enabled || busy) return;
    const references = parseReferenceLines(refsText);
    const productFacts = parseReferenceLines(factsText);
    const body: PlanRequestBody = {
      profile,
      format,
      brief: brief.trim(),
      references,
      productFacts,
      productMentionRequested: productMention && profile !== 'religious',
    };
    setBusy(true);
    setJobError(null);
    setCheckError(null);
    try {
      const { job: started } = await ai.startPlan(body);
      if (!alive.current) return;
      writeActiveJob(started.id);
      setJob(started);
      void refreshStatus();
      if (started.status === 'succeeded') void convert(started);
    } catch (e) {
      // The brief, references and settings stay on screen. The message is the server's, verbatim.
      if (alive.current) {
        const err = e as FactoryApiError;
        setJobError({ code: err.code ?? 'FACTORY_HTTP', message: err.message });
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    setBusy(true);
    try {
      const j = await ai.cancelJob(job.id);
      if (!alive.current) return;
      setJob(j);
      if (j.status === 'succeeded') {
        // The plan finished before the cancel reached the server. It is a success, so it is offered as one.
        void convert(j);
      } else {
        writeActiveJob(null);
      }
    } catch (e) {
      if (alive.current) setCheckError(`The cancel request did not reach the server (${(e as Error).message}). The job may still finish; it is not adopted unless it succeeds.`);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const view = jobStatusView(job);
  const left = status ? textRequestsLeft(status) : null;
  const productAllowed = profile !== 'religious';

  return (
    <div className="card" data-testid="gemini-plan">
      <h3>1. Inputs (Gemini)</h3>
      <p className="small">
        Gemini writes the script and three treatments from your brief and the references you supply. Nothing is generated on typing or on page load.
        The script is unapproved and must be reviewed. Religious content uses only the references you supply, and never mentions a product.
      </p>
      <div className="row" data-testid="gemini-status" style={{ gap: 8, flexWrap: 'wrap' }}>
        {status ? (
          <>
            <Tag kind={status.state === 'ready' ? 'accent' : 'warn'}>{status.state.replace(/_/g, ' ')}</Tag>
            <span className="small">
              Text requests left this session: {left} of {status.budget.caps.textRequests}. Model: {status.models.text}.
            </span>
          </>
        ) : statusError ? (
          <Banner kind="bad">The server status could not be read: {statusError}. Generation is not assumed.</Banner>
        ) : (
          <span className="small">Checking the server…</span>
        )}
      </div>
      {status ? <p className="small mt">{status.note}</p> : null}
      {!gate.enabled && gate.reason ? (
        <Banner kind="warn" data-testid="gemini-disabled-reason">{gate.reason}</Banner>
      ) : null}

      <div className="grid2 mt">
        <label className="field">
          <span>Content profile</span>
          <select value={profile} onChange={(e) => setProfile(e.target.value as FactoryProfile)} disabled={busy || job?.status === 'running'} data-testid="gemini-profile">
            <option value="educational">Educational</option>
            <option value="religious">Religious</option>
            <option value="promotional">Promotional</option>
          </select>
        </label>
        <label className="field">
          <span>Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as FactoryFormat)} disabled={busy || job?.status === 'running'} data-testid="gemini-format">
            <option value="landscape">Landscape (long video)</option>
            <option value="portrait">Portrait (short video)</option>
          </select>
        </label>
      </div>

      <label className="field mt">
        <span>Brief (what the video is about)</span>
        <input value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Explain why the delivery window is confirmed the night before" data-testid="gemini-brief" />
      </label>

      <label className="field mt">
        <span>References (one per line as id|text; only these may be quoted or used as sources)</span>
        <textarea rows={4} value={refsText} onChange={(e) => setRefsText(e.target.value)} data-testid="gemini-references" />
      </label>

      <label className="row mt" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={productMention && productAllowed}
          disabled={!productAllowed || busy}
          onChange={(e) => setProductMention(e.target.checked)}
          data-testid="gemini-product-mention"
        />
        Mention a product (off by default{productAllowed ? '' : '; never allowed for religious content'})
      </label>
      {productMention && productAllowed ? (
        <label className="field mt">
          <span>Product facts (id|text, the only product claims allowed)</span>
          <textarea rows={3} value={factsText} onChange={(e) => setFactsText(e.target.value)} data-testid="gemini-product-facts" />
        </label>
      ) : null}

      <label className="row mt" style={{ gap: 8 }}>
        <input type="checkbox" checked={confirmedFreeTier} onChange={(e) => setConfirmedFreeTier(e.target.checked)} data-testid="gemini-confirm-free" />
        I confirm this key is on the free tier with a budget limit set in Google AI Studio.
      </label>

      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" disabled={!gate.enabled || busy} onClick={() => void generate()} data-testid="gemini-generate">
          {busy ? 'Starting…' : 'Generate script and three treatments'}
        </button>
      </div>

      {jobError ? (
        <Banner kind="bad" data-testid="gemini-job-error">
          <b>{jobError.code}</b>: {jobError.message}
          <div className="small">{failureAdvice(jobError.code)}</div>
          <div className="small">Your brief and settings are kept. You can change them and try again.</div>
        </Banner>
      ) : null}

      {job ? (
        <div className="card mt" data-testid="gemini-job">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              Job <span className="mono small" data-testid="gemini-job-id">{job.id}</span> · <b data-testid="gemini-job-status">{job.status}</b>
            </span>
            {job.status === 'running' ? (
              <button className="btn sm" onClick={() => void cancel()} disabled={busy} data-testid="gemini-cancel">Cancel</button>
            ) : null}
          </div>
          {view ? <Banner kind={view.tone === 'ok' ? 'info' : view.tone}>{view.text}</Banner> : null}
          {job.status === 'failed' && job.error ? <div className="small">{failureAdvice(job.error.code)}</div> : null}
        </div>
      ) : null}
      {checkError ? <Banner kind="warn" data-testid="gemini-check-error">{checkError}</Banner> : null}
    </div>
  );
};
