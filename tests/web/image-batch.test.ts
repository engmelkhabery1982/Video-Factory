import { describe, expect, it } from 'vitest';
import {
  addBatchFiles, cardsFromBatch, moveBatchRow, requeueFailed, rowsToUpload, setRow, summarizeBatch, type BatchRow,
} from '../../apps/web/src/lib/image-batch';
import type { StoryboardPanelDraft } from '../../apps/web/src/lib/factory-model';

const img = (name: string, type = 'image/png') => ({ name, type, size: 100 });
const doneRow = (key: string, assetId: string, role: BatchRow['role'] = 'final_shot'): BatchRow => ({
  key, fileName: `${assetId}.png`, sizeBytes: 1, role, status: 'done', assetId, sha256: 'f'.repeat(64), error: null, carded: false,
});
const panel = (id: string, assetId: string | null, narration = ''): StoryboardPanelDraft => ({
  key: `k-${id}`, id, narration, assetId, speakerId: 'host', startSec: 1, endSec: 2, locked: true,
});

describe('ordered image batch', () => {
  it('keeps the order given, refuses non-images with a reason, and never queues them', () => {
    const r = addBatchFiles([], [img('one.png'), img('notes.pdf', 'application/pdf'), img('two.jpg', 'image/jpeg'), img('three.svg', 'image/svg+xml')]);
    expect(r.rows.map((x) => x.fileName)).toEqual(['one.png', 'two.jpg']);
    expect(r.refused.map((x) => x.fileName)).toEqual(['notes.pdf', 'three.svg']);
    expect(r.refused[0].reason).toMatch(/Not a PNG, JPEG, WebP or GIF/);
  });

  it('uploads one at a time in the shown order, and a failed file is retried alone', () => {
    let rows = addBatchFiles([], [img('a.png'), img('b.png'), img('c.png')]).rows;
    expect(rowsToUpload(rows, false)).toEqual([0, 1, 2]);
    rows = setRow(rows, rows[0].key, { status: 'done', assetId: 'asset-a', sha256: 'a'.repeat(64) });
    rows = setRow(rows, rows[1].key, { status: 'failed', error: 'Upload refused' });
    rows = setRow(rows, rows[2].key, { status: 'done', assetId: 'asset-c' });
    // The next run touches only the failed row. Done rows are never uploaded again.
    expect(rowsToUpload(rows, false)).toEqual([]);
    expect(rowsToUpload(rows, true)).toEqual([1]);
    rows = requeueFailed(rows);
    expect(rowsToUpload(rows, false)).toEqual([1]);
    expect(rows.find((r) => r.assetId === 'asset-a')?.status).toBe('done');
  });

  it('a partial failure never reads as complete, and the summary says what is kept', () => {
    let rows = addBatchFiles([], [img('a.png'), img('b.png')]).rows;
    rows = setRow(rows, rows[0].key, { status: 'done', assetId: 'asset-a' });
    rows = setRow(rows, rows[1].key, { status: 'failed', error: 'Too large' });
    const s = summarizeBatch(rows);
    expect(s.line).toMatch(/1 of 2 in the library\. 1 failed/);
    expect(s.line).not.toMatch(/All 2/);
    rows = setRow(rows, rows[1].key, { status: 'done', assetId: 'asset-b' });
    expect(summarizeBatch(rows).line).toBe('All 2 pictures are in the library.');
  });

  it('reordering moves the row and is refused while a row is uploading', () => {
    let rows = addBatchFiles([], [img('a.png'), img('b.png'), img('c.png')]).rows;
    rows = moveBatchRow(rows, 2, -1);
    expect(rows.map((r) => r.fileName)).toEqual(['a.png', 'c.png', 'b.png']);
    rows = setRow(rows, rows[0].key, { status: 'uploading' });
    expect(moveBatchRow(rows, 0, 1)).toBe(rows);
  });

  it('one card per final or storyboard picture, in batch order, existing cards untouched; references are never cards', () => {
    const existing = [panel('p1', 'asset-old', 'Keep me.')];
    const rows = [
      doneRow('k1', 'asset-s1', 'final_shot'),
      doneRow('k2', 'asset-style', 'style_reference'),
      doneRow('k3', 'asset-s2', 'storyboard_panel'),
      { ...doneRow('k4', 'asset-old', 'final_shot') },
      { ...doneRow('k5', 'asset-bad', 'final_shot'), status: 'failed' as const, assetId: null },
    ];
    const r = cardsFromBatch(rows, existing);
    expect(r.carded).toEqual(['asset-s1', 'asset-s2']);
    expect(r.skipped).toEqual(['asset-old']);
    expect(r.references).toEqual([{ assetId: 'asset-style', role: 'style_reference' }]);
    expect(r.panels.map((p) => p.assetId)).toEqual(['asset-old', 'asset-s1', 'asset-s2']);
    // Existing card keeps every field, including timing and lock.
    expect(r.panels[0]).toEqual(existing[0]);
    // Every done picture is attached to the draft, references and carded pictures alike, each once.
    expect(r.attachIds).toEqual(['asset-s1', 'asset-style', 'asset-s2', 'asset-old']);
  });

  it('a second "add as cards" adds nothing: carded pictures are not carded twice', () => {
    const rows = [doneRow('k1', 'asset-s1'), doneRow('k2', 'asset-s2')];
    const first = cardsFromBatch(rows, []);
    expect(first.panels).toHaveLength(2);
    const second = cardsFromBatch(first.rows, first.panels);
    expect(second.carded).toEqual([]);
    expect(second.panels).toHaveLength(2);
  });
});
