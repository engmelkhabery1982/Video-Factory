/**
 * Pure decisions for the Gemini planning UI. No fetch, no DOM. Every disabled state has a reason
 * the owner can read, and every count shown before a confirmation comes from the server.
 */
import type { AiJob, AiStatus, ApplyPreview, FactoryDraftScene, PlanReference } from './factory-api';

export type PlanMethod = 'local' | 'gemini';

export const METHOD_LABELS: Record<PlanMethod, string> = {
  local: 'Offline local rules (labelled: no AI, fixed rules)',
  gemini: 'Gemini generation (explicit Generate; uses your free-tier text quota)',
};

export const PREVIEW_MAX_CHARS = 350;

export interface GenerateGate {
  enabled: boolean;
  reason: string | null;
}

/** Why Generate is or is not allowed. Reads server status only; never calls the provider. */
export function generateGate(input: {
  status: AiStatus | null;
  statusError: string | null;
  confirmedFreeTier: boolean;
  briefText: string;
  jobRunning: boolean;
  hasUnsavedEdits: boolean;
}): GenerateGate {
  if (input.statusError) return { enabled: false, reason: `The server status could not be read: ${input.statusError}. Generation is not assumed.` };
  if (!input.status) return { enabled: false, reason: 'Checking the server status…' };
  const s = input.status;
  if (!s.credentialsPresent) return { enabled: false, reason: 'No Gemini key is configured on this server (credentials missing). Nothing can be generated here.' };
  if (!s.generationEnabled || !s.freeTierConfirmed) {
    return {
      enabled: false,
      reason: 'Generation is off on this server. The owner must confirm a free-tier key and set GEMINI_GENERATION_ENABLED=1 and GEMINI_FREE_TIER_CONFIRMED=1.',
    };
  }
  const textLeft = textRequestsLeft(s);
  if (textLeft <= 0) return { enabled: false, reason: 'The session text budget is used up. No automatic reset or paid fallback exists.' };
  if (input.jobRunning) return { enabled: false, reason: 'A plan is already running. Wait for it or cancel it.' };
  if (input.hasUnsavedEdits) return { enabled: false, reason: 'Save or discard your edits to the current draft first. A new plan would replace the draft on screen.' };
  if (!input.briefText.trim()) return { enabled: false, reason: 'Write the brief first.' };
  if (!input.confirmedFreeTier) return { enabled: false, reason: 'Confirm that the key is on the free tier with a budget limit.' };
  return { enabled: true, reason: null };
}

export function textRequestsLeft(s: AiStatus): number {
  return Math.max(0, s.budget.caps.textRequests - s.budget.used.text);
}

export function previewsLeft(s: AiStatus): number {
  return Math.max(0, s.budget.caps.voicePreviews - s.budget.used.voice);
}

/** Lines of `id|text` into references. Ids are checked by the server; blanks are dropped here. */
export function parseReferenceLines(raw: string): PlanReference[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const i = l.indexOf('|');
      if (i < 0) return { id: '', text: l };
      return { id: l.slice(0, i).trim(), text: l.slice(i + 1).trim() };
    });
}

export function jobStatusView(job: AiJob | null): { tone: 'info' | 'warn' | 'bad' | 'ok'; text: string } | null {
  if (!job) return null;
  switch (job.status) {
    case 'running':
      return { tone: 'info', text: 'Running on the server. The request is bounded and can be cancelled.' };
    case 'succeeded':
      return { tone: 'ok', text: 'The plan passed validation. Three treatments are ready.' };
    case 'cancelled':
      return { tone: 'warn', text: 'Cancelled. Any late result from this request is discarded and nothing was saved from it.' };
    case 'interrupted':
      return { tone: 'warn', text: 'The server restarted while this ran. It is not a success. Start a new plan if you still need one.' };
    case 'failed':
      return { tone: 'bad', text: `Failed: ${job.error?.message ?? 'no detail'}. Your brief and settings are kept.` };
    default:
      return null;
  }
}

/** Human action for a failed provider or budget code. Verbatim server text is shown too. */
export function failureAdvice(code: string | null | undefined): string {
  switch (code) {
    case 'FACTORY_PROVIDER_CREDENTIALS_MISSING':
      return 'No key on this server. The owner sets GEMINI_API_KEY on the server. Nothing was called.';
    case 'FACTORY_PROVIDER_DISABLED':
      return 'Generation is off. Stop here; no automatic fallback is used.';
    case 'FACTORY_BUDGET_EXHAUSTED':
      return 'The budget for this session is used up. Nothing was called. The ledger is not reset here.';
    case 'FACTORY_PROVIDER_AUTH':
      return 'The provider rejected the key (401) or refused access (403). Check the key and the project access on the server. No fallback is used.';
    case 'FACTORY_PROVIDER_QUOTA':
      return 'The provider reports a quota or rate limit (429). Stopped. Wait, or check the free-tier limit. No fallback is used.';
    case 'FACTORY_PROVIDER_TIMEOUT':
      return 'The provider did not finish in time. Nothing was saved as a success. Try again later.';
    case 'FACTORY_PROVIDER_UNAVAILABLE':
      return 'The provider could not be reached. Nothing was saved as a success.';
    case 'FACTORY_AUDIO_INVALID':
      return 'The provider returned audio that failed validation. It was discarded, and the attempt still counts.';
    case 'FACTORY_JOB_CANCELLED':
      return 'Cancelled. A late result is never used.';
    case 'FACTORY_AI_INVALID_OUTPUT':
      return 'The output failed validation after one repair. Nothing was saved. Change the brief and try again.';
    default:
      return 'Nothing was saved from this request.';
  }
}

/** Narration rows the owner changed, as the generated PATCH expects them. Unchanged rows are not sent. */
export function narrationChanges(
  scenes: Array<Pick<FactoryDraftScene, 'sourceUnitId' | 'narration'>>,
  edits: Record<string, string>,
): Array<{ unitId: string; narration: string }> {
  const seen = new Set<string>();
  const out: Array<{ unitId: string; narration: string }> = [];
  for (const s of scenes) {
    if (seen.has(s.sourceUnitId)) continue;
    seen.add(s.sourceUnitId);
    const next = edits[s.sourceUnitId];
    if (next === undefined || next === s.narration) continue;
    out.push({ unitId: s.sourceUnitId, narration: next });
  }
  return out;
}

/** The count panel. The confirmed number is exactly the number the server reported. */
export function applyCountView(preview: ApplyPreview | null): {
  headline: string;
  remainingText: string;
  canConfirmCount: boolean;
} {
  if (!preview) return { headline: 'Checking the apply…', remainingText: '', canConfirmCount: false };
  const remainingText = `Production speech budget: ${preview.budget.remaining} of ${preview.budget.cap} turns left this session.`;
  if (preview.reused) return { headline: 'This revision was already applied. Opening it adds nothing.', remainingText, canConfirmCount: false };
  if (preview.speechCalls === 0) return { headline: 'No Gemini speech call is needed: every changed line already has a verified clip.', remainingText, canConfirmCount: false };
  const n = preview.speechCalls;
  return {
    headline: `This apply makes ${n} Gemini speech ${n === 1 ? 'call' : 'calls'}, one per changed line. Nothing is called until you confirm.`,
    remainingText,
    canConfirmCount: preview.canApply,
  };
}

/** Rows of the preview for one speaker: default text, default language, length check. */
export function previewInput(text: string): { ok: boolean; reason: string | null } {
  const t = text.trim();
  if (!t) return { ok: false, reason: 'Write or choose the reviewed text for the preview.' };
  if (t.length > PREVIEW_MAX_CHARS) return { ok: false, reason: `A preview is at most ${PREVIEW_MAX_CHARS} characters. Shorten the text; nothing is cut silently.` };
  return { ok: true, reason: null };
}
