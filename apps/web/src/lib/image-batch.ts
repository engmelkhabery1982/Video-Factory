/**
 * Ordered multi-image batch (pure logic, no DOM). The server's measured upload (POST /api/assets) is the authority for
 * type and bytes; the client check here only refuses obvious non-images before any request.
 *
 * Rules the tests hold:
 *  - uploads run one at a time, in the order shown;
 *  - a failed file is retried alone; a file that already uploaded is never uploaded again (no duplicate library entry);
 *  - one card per final-shot or storyboard-panel image, appended in batch order; existing cards are untouched;
 *  - a picture already on a card is not carded twice; a reference never becomes a card or footage.
 */
import type { FactoryVisualRole } from '@buildtrack/core';
import type { StoryboardPanelDraft } from './factory-model';
import { newPanel } from './factory-model';

export const BATCH_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const BATCH_MAX_FILES = 20;

export type BatchStatus = 'queued' | 'uploading' | 'done' | 'failed';

export interface BatchRow {
  /** Stable for this session. Never reused for another file. */
  key: string;
  fileName: string;
  sizeBytes: number;
  role: FactoryVisualRole;
  status: BatchStatus;
  /** Library id once the server has stored this file. Set only on `done`. */
  assetId: string | null;
  /** SHA-256 the server computed for the stored bytes. Set only on `done`. */
  sha256: string | null;
  /** Server or client reason. Set on `failed`. */
  error: string | null;
  /** True once this picture has become a card. A second "add as cards" does not card it again. */
  carded: boolean;
}

export interface BatchAddResult {
  rows: BatchRow[];
  refused: Array<{ fileName: string; reason: string }>;
}

let keySeq = 0;
const nextKey = () => `batch-${Date.now().toString(36)}-${(keySeq += 1)}`;

/** Add files in the order given. Non-images and files over the batch limit are refused with a reason, never queued. */
export function addBatchFiles(rows: BatchRow[], files: Array<{ name: string; type: string; size: number }>): BatchAddResult {
  const refused: BatchAddResult['refused'] = [];
  const added: BatchRow[] = [];
  for (const f of files) {
    if (!(BATCH_IMAGE_TYPES as readonly string[]).includes(f.type.toLowerCase())) {
      refused.push({ fileName: f.name, reason: 'Not a PNG, JPEG, WebP or GIF picture. Nothing was queued for it.' });
      continue;
    }
    if (rows.length + added.length >= BATCH_MAX_FILES) {
      refused.push({ fileName: f.name, reason: `A batch holds at most ${BATCH_MAX_FILES} pictures.` });
      continue;
    }
    added.push({ key: nextKey(), fileName: f.name, sizeBytes: f.size, role: 'final_shot', status: 'queued', assetId: null, sha256: null, error: null, carded: false });
  }
  return { rows: [...rows, ...added], refused };
}

/** Move a row one place. Refused (unchanged) when the row is uploading or the move is off the list. */
export function moveBatchRow(rows: BatchRow[], index: number, delta: -1 | 1): BatchRow[] {
  const to = index + delta;
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return rows;
  if (rows[index].status === 'uploading' || rows[to].status === 'uploading') return rows;
  const next = [...rows];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** The rows the next run will upload, in order: queued rows, and failed rows when `retryFailed` is set. */
export function rowsToUpload(rows: BatchRow[], retryFailed: boolean): number[] {
  return rows.flatMap((r, i) => (r.status === 'queued' || (retryFailed && r.status === 'failed') ? [i] : []));
}

/** Immutable status change for one row. */
export function setRow(rows: BatchRow[], key: string, change: Partial<BatchRow>): BatchRow[] {
  return rows.map((r) => (r.key === key ? { ...r, ...change } : r));
}

/** A failed row goes back to queued for a retry. Done rows are left alone: they are never uploaded twice. */
export function requeueFailed(rows: BatchRow[]): BatchRow[] {
  return rows.map((r) => (r.status === 'failed' ? { ...r, status: 'queued', error: null } : r));
}

export interface BatchSummary {
  total: number;
  done: number;
  failed: number;
  queued: number;
  uploading: number;
  /** A human line for the owner. It never says "complete" while anything is failed or queued. */
  line: string;
}

export function summarizeBatch(rows: BatchRow[]): BatchSummary {
  const done = rows.filter((r) => r.status === 'done').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const queued = rows.filter((r) => r.status === 'queued').length;
  const uploading = rows.filter((r) => r.status === 'uploading').length;
  const total = rows.length;
  let line: string;
  if (total === 0) line = 'No pictures in this batch yet.';
  else if (uploading > 0) line = `Uploading ${done + 1} of ${total}…`;
  else if (failed === 0 && queued === 0) line = `All ${total} pictures are in the library.`;
  else line = `${done} of ${total} in the library. ${failed} failed${queued > 0 ? `, ${queued} not yet uploaded` : ''}. Retry the failed ones; the others are kept.`;
  return { total, done, failed, queued, uploading, line };
}

export interface CardsFromBatch {
  panels: StoryboardPanelDraft[];
  rows: BatchRow[];
  /** Pictures added as cards by this call. */
  carded: string[];
  /** References attached with their role, for the draft's visual roles. Never a card. */
  references: Array<{ assetId: string; role: FactoryVisualRole }>;
  /** Pictures attached to the draft (every done row), so the server accepts their panels and roles. */
  attachIds: string[];
  /** Done pictures already on a card, or already carded: not added again. */
  skipped: string[];
}

/**
 * Create one card per done final-shot or storyboard-panel picture, appended in batch order. Existing cards are not moved or
 * changed. A picture already carded is skipped, so a second click adds nothing.
 */
export function cardsFromBatch(rows: BatchRow[], panels: StoryboardPanelDraft[]): CardsFromBatch {
  const onCard = new Set(panels.map((p) => p.assetId).filter((x): x is string => !!x));
  const out: StoryboardPanelDraft[] = [...panels];
  const carded: string[] = [];
  const skipped: string[] = [];
  const references: CardsFromBatch['references'] = [];
  const attachIds: string[] = [];
  const nextRows = rows.map((r) => ({ ...r }));
  for (const row of nextRows) {
    if (row.status !== 'done' || !row.assetId) continue;
    attachIds.push(row.assetId);
    if (row.role === 'style_reference' || row.role === 'character_reference') {
      // Attached with its role and processed. Idempotent: attaching it again changes nothing.
      references.push({ assetId: row.assetId, role: row.role });
      row.carded = true;
      continue;
    }
    if (row.carded || onCard.has(row.assetId)) {
      skipped.push(row.assetId);
      row.carded = true;
      continue;
    }
    out.push(newPanel(out, row.assetId));
    onCard.add(row.assetId);
    carded.push(row.assetId);
    row.carded = true;
  }
  return { panels: out, rows: nextRows, carded, references, attachIds: Array.from(new Set(attachIds)), skipped };
}
