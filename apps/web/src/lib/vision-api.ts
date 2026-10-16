/**
 * Client for local picture analysis and reviewed references. Same error shape as factory-api (FactoryApiError), so the
 * UI reads `code` and `currentRevision` the same way. Reads never start an analysis; only the explicit POSTs do.
 * No provider is called from here. The server runs the local vision engine or refuses.
 */
import { FactoryApiError, type FactoryDraftEnvelope } from './factory-api';
import type { VisionObservation, VisualReviewRecord, ConditioningSetting } from '@buildtrack/core/visual';

export type VisionJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted';

export interface VisionJobView {
  id: string;
  assetId: string;
  sha256: string;
  state: VisionJobState;
  timeoutSec: number;
  createdAt: string;
  updatedAt: string;
  error: { code: string; message: string } | null;
  observation: VisionObservation | null;
}

export interface VisionStatusView {
  ready: boolean;
  missing: string[];
  serverReachable: boolean;
  model: { name: string; licence: string; sha256Matches: boolean };
  projector: { name: string; licence: string; sha256Matches: boolean };
  /** Shown to the owner. Never a claim that the model reads pictures correctly. */
  evidence: string;
}

/** Existing reviews are sent whole on every save (the server replaces the map). */
export type VisualReviewInput = Record<string, { jobId: string; state: 'reviewed' | 'rejected'; text: string; useInPrompts: boolean }>;

export interface VisionClient {
  visionStatus(): Promise<VisionStatusView>;
  startVision(assetId: string): Promise<VisionJobView>;
  getVision(jobId: string): Promise<VisionJobView>;
  cancelVision(jobId: string): Promise<VisionJobView>;
  saveReview(draftId: string, body: { expectedRevision: number; visualReview?: VisualReviewInput; conditioning?: ConditioningSetting | null }): Promise<FactoryDraftEnvelope>;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new FactoryApiError({ message: 'The server did not reply. Nothing is confirmed. Reload before doing anything else.', status: null, code: 'TRANSPORT', answered: false });
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    throw new FactoryApiError({
      message: typeof data?.error === 'string' ? data.error : `The request failed (${res.status}).`,
      status: res.status,
      code: typeof data?.code === 'string' ? data.code : 'FACTORY_HTTP',
      answered: true,
      currentRevision: typeof data?.currentRevision === 'number' ? data.currentRevision : null,
      details: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
    });
  }
  return data as T;
}

export const visionApi: VisionClient = {
  visionStatus: () => call<VisionStatusView>('GET', '/api/vision/status'),
  startVision: (assetId) => call<VisionJobView>('POST', '/api/vision/jobs', { assetId }),
  getVision: (jobId) => call<VisionJobView>('GET', `/api/vision/jobs/${encodeURIComponent(jobId)}`),
  cancelVision: (jobId) => call<VisionJobView>('POST', `/api/vision/jobs/${encodeURIComponent(jobId)}/cancel`),
  saveReview: (draftId, body) => call<FactoryDraftEnvelope>('POST', `/api/factory/drafts/${encodeURIComponent(draftId)}/visual-review`, body),
};

/** The review map as the server stored it, in the form the server accepts back. Used so one save keeps the others. */
export function reviewMapOf(records: Record<string, VisualReviewRecord> | undefined): VisualReviewInput {
  const out: VisualReviewInput = {};
  for (const [assetId, r] of Object.entries(records ?? {})) {
    out[assetId] = { jobId: r.jobId, state: r.state, text: r.text, useInPrompts: r.useInPrompts };
  }
  return out;
}
