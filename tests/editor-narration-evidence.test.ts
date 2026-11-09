import { describe, expect, it } from 'vitest';
import type { EditorDocument } from '@buildtrack/core';
import { narrationInRange } from '../apps/api/src/services/editor-render.js';

const document = (id: string, sourceAssetId: string) => ({
  audioClips: [{ id, sourceAssetId, startSec: 4, sourceInSec: 2, sourceOutSec: 5 }],
}) as unknown as EditorDocument;

describe('recorded narration preview evidence', () => {
  it('recognizes factory narration with a library-generated asset id', () => {
    expect(narrationInRange(document('ac_full_narration', 'narration-252835a3'), { startSec: 5, endSec: 6 })).toBe(true);
  });
  it('preserves the legacy narration binding', () => {
    expect(narrationInRange(document('ac_narration', 'narration'), { startSec: 5, endSec: 6 })).toBe(true);
  });
  it('does not count unrelated library music', () => {
    expect(narrationInRange(document('ac_music', 'music'), { startSec: 5, endSec: 6 })).toBe(false);
  });
  it('respects the trimmed clip range and exclusive boundaries', () => {
    const doc = document('ac_full_narration', 'library-audio');
    expect(narrationInRange(doc, { startSec: 0, endSec: 4 })).toBe(false);
    expect(narrationInRange(doc, { startSec: 7, endSec: 8 })).toBe(false);
    expect(narrationInRange(doc, { startSec: 6, endSec: 8 })).toBe(true);
  });
});
