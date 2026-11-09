import { useRef, useState } from 'react';
import { FACTORY_VISUAL_ROLE_LABELS, type FactoryVisualRole } from '../../lib/factory-api';
import {
  addBatchFiles, cardsFromBatch, moveBatchRow, requeueFailed, rowsToUpload, setRow, summarizeBatch, type BatchRow, type CardsFromBatch,
} from '../../lib/image-batch';
import type { StoryboardPanelDraft } from '../../lib/factory-model';

const ROLE_ORDER: FactoryVisualRole[] = ['final_shot', 'storyboard_panel', 'style_reference', 'character_reference'];

export interface ImageBatchUploadProps {
  /** Source and licence are required for every library file. The page owns them. */
  source: string;
  license: string;
  /** The page's existing upload (POST /api/assets through the same client). The server measures and stores each file. */
  upload: (form: FormData) => Promise<unknown>;
  onLibraryChanged: () => Promise<void>;
  /** Current cards. Used to add pictures as cards without moving existing ones. */
  panels: StoryboardPanelDraft[];
  /** Applies the cards, the pictures attached to the draft, and any reference roles. The page owns the form. */
  onCards: (result: CardsFromBatch) => void;
  busy: boolean;
}

/**
 * Ordered multi-picture upload. One file at a time, in the order shown. Each row shows its own result. A failed file is
 * retried alone; a stored file is never uploaded again. Cards are made only when the owner asks, one per final or
 * storyboard picture, in this order.
 */
export function ImageBatchUpload({ source, license, upload, onLibraryChanged, panels, onCards, busy }: ImageBatchUploadProps) {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // The rows and their files live here for the session. A retry re-sends the failed file, never a stored one.
  const rowsRef = useRef<BatchRow[]>([]);
  const filesRef = useRef<Map<string, File>>(new Map());
  const runningRef = useRef(false);
  const commit = (next: BatchRow[]) => {
    rowsRef.current = next;
    setRows(next);
  };

  const onPick = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const reasons: string[] = [];
    // One file at a time, in the order picked, so each new row maps to exactly its own file.
    for (const file of Array.from(list)) {
      const before = rowsRef.current.length;
      const result = addBatchFiles(rowsRef.current, [{ name: file.name, type: file.type, size: file.size }]);
      if (result.rows.length > before) {
        filesRef.current.set(result.rows[result.rows.length - 1].key, file);
        commit(result.rows);
      }
      for (const x of result.refused) reasons.push(`${x.fileName}: ${x.reason}`);
    }
    setRefused(reasons);
    setMessage(null);
  };

  const run = async (retryFailed: boolean) => {
    if (runningRef.current) return;
    if (!source.trim() || !license.trim()) {
      setMessage('Enter the source and the licence for the pictures before uploading. Pictures without them are refused.');
      return;
    }
    runningRef.current = true;
    setRunning(true);
    try {
      if (retryFailed) commit(requeueFailed(rowsRef.current));
      const indexes = rowsToUpload(rowsRef.current, false);
      for (const index of indexes) {
        const row = rowsRef.current[index];
        const file = filesRef.current.get(row.key);
        if (!file) {
          commit(setRow(rowsRef.current, row.key, { status: 'failed', error: 'The file is no longer in this session. Choose it again.' }));
          continue;
        }
        commit(setRow(rowsRef.current, row.key, { status: 'uploading', error: null }));
        const fd = new FormData();
        fd.append('file', file);
        fd.append('kind', 'screenshot');
        fd.append('name', row.fileName.replace(/\.[^.]+$/, ''));
        fd.append('source', source.trim());
        fd.append('license', license.trim());
        try {
          const res = (await upload(fd)) as { asset?: { id?: string; sha256?: string } } | null;
          const assetId = res?.asset?.id;
          if (!assetId) throw new Error('The server did not return the stored picture. It is not counted as added.');
          commit(setRow(rowsRef.current, row.key, { status: 'done', assetId, sha256: res?.asset?.sha256 ?? null, error: null }));
        } catch (e) {
          commit(setRow(rowsRef.current, row.key, { status: 'failed', error: (e as Error).message || 'Upload refused.' }));
        }
      }
      await onLibraryChanged();
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const summary = summarizeBatch(rows);
  const pending = rows.filter((r) => r.status === 'done' && !r.carded);
  const cardable = pending.filter((r) => r.role === 'final_shot' || r.role === 'storyboard_panel').length;
  const referencesToAttach = pending.length - cardable;

  return (
    <fieldset className="mt" data-testid="image-batch">
      <legend>Add several pictures, in order</legend>
      <p className="small">
        PNG, JPEG, WebP or GIF. Each file is measured by the server and stored with your source and licence. One file uploads at a time,
        in the order shown. A failed file is retried alone; a stored file is never uploaded again.
      </p>
      <label className="btn sm">
        Choose pictures
        <input
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          disabled={busy || running}
          aria-label="Pictures to add in order"
          onChange={(e) => {
            onPick(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {refused.length > 0 ? (
        <ul className="small" data-testid="image-batch-refused">
          {refused.map((r) => <li key={r}>{r}</li>)}
        </ul>
      ) : null}
      {rows.length > 0 ? (
        <>
          <p className="small" role="status" data-testid="image-batch-summary">{summary.line}</p>
          <ol className="small" data-testid="image-batch-rows" style={{ paddingLeft: 18 }}>
            {rows.map((r, i) => (
              <li key={r.key} data-testid="image-batch-row" className="mt">
                <span className="mono">{i + 1}. {r.fileName}</span>{' '}
                <span data-testid="image-batch-status">
                  {r.status === 'queued' ? 'Not uploaded yet' : r.status === 'uploading' ? 'Uploading…' : r.status === 'done' ? `In the library${r.sha256 ? ` · sha256 ${r.sha256.slice(0, 12)}…` : ''}` : `Failed: ${r.error}`}
                </span>
                <span className="row" style={{ gap: 6, marginTop: 4 }}>
                  <label className="field">
                    <span>Role</span>
                    <select
                      aria-label={`Role of ${r.fileName}`}
                      value={r.role}
                      disabled={r.status === 'uploading' || r.carded}
                      onChange={(e) => commit(setRow(rowsRef.current, r.key, { role: e.target.value as FactoryVisualRole }))}
                    >
                      {ROLE_ORDER.map((role) => <option key={role} value={role}>{FACTORY_VISUAL_ROLE_LABELS[role]}</option>)}
                    </select>
                  </label>
                  <button className="btn sm" type="button" disabled={running || i === 0} onClick={() => commit(moveBatchRow(rowsRef.current, i, -1))} aria-label={`Move picture ${i + 1} up`}>Up</button>
                  <button className="btn sm" type="button" disabled={running || i === rows.length - 1} onClick={() => commit(moveBatchRow(rowsRef.current, i, 1))} aria-label={`Move picture ${i + 1} down`}>Down</button>
                  {r.status === 'queued' || r.status === 'failed' ? (
                    <button
                      className="btn sm"
                      type="button"
                      disabled={running}
                      onClick={() => {
                        filesRef.current.delete(r.key);
                        commit(rowsRef.current.filter((x) => x.key !== r.key));
                      }}
                      aria-label={`Remove picture ${i + 1}`}
                    >
                      Remove
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
          <div className="row mt" style={{ gap: 8 }}>
            <button className="btn sm" type="button" disabled={busy || running || summary.queued === 0} onClick={() => void run(false)} data-testid="image-batch-upload">
              Upload {summary.queued} in order
            </button>
            <button className="btn sm" type="button" disabled={busy || running || summary.failed === 0} onClick={() => void run(true)} data-testid="image-batch-retry">
              Retry {summary.failed} failed
            </button>
            <button
              className="btn sm"
              type="button"
              disabled={busy || running || pending.length === 0}
              data-testid="image-batch-cards"
              onClick={() => {
                const result = cardsFromBatch(rowsRef.current, panels);
                commit(result.rows);
                onCards(result);
                const parts = [];
                if (result.carded.length > 0) parts.push(`${result.carded.length} card(s) added at the end, in this order. Existing cards were not changed.`);
                if (result.references.length > 0) parts.push(`${result.references.length} reference(s) attached with their role. A reference is never a card or footage.`);
                setMessage(parts.join(' ') || 'Nothing new to add.');
              }}
            >
              {cardable > 0 ? `Add ${cardable} as card${cardable === 1 ? '' : 's'}` : ''}
              {cardable > 0 && referencesToAttach > 0 ? ' and ' : ''}
              {referencesToAttach > 0 ? `attach ${referencesToAttach} reference${referencesToAttach === 1 ? '' : 's'}` : ''}
            </button>
          </div>
        </>
      ) : null}
      {message ? <p className="small" role="status">{message}</p> : null}
      {summary.failed > 0 ? <p className="small" role="alert">{summary.failed} not added. The stored pictures are kept.</p> : null}
    </fieldset>
  );
}
