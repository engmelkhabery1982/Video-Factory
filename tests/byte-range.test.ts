import { describe, expect, it } from 'vitest';
import { contentRangeHeader, parseSingleByteRange, unsatisfiableRangeHeader } from '../apps/api/src/services/byte-range.js';

describe('single byte range', () => {
  it('treats a missing header as a full response', () => {
    expect(parseSingleByteRange(undefined, 100)).toEqual({ kind: 'absent' });
    expect(parseSingleByteRange('  ', 100)).toEqual({ kind: 'absent' });
  });

  it('ignores a range unit other than bytes', () => {
    expect(parseSingleByteRange('items=0-1', 100)).toEqual({ kind: 'absent' });
  });

  it('satisfies a closed, open, and suffix range', () => {
    expect(parseSingleByteRange('bytes=0-9', 100)).toEqual({ kind: 'partial', start: 0, end: 9 });
    expect(parseSingleByteRange('bytes=40-', 100)).toEqual({ kind: 'partial', start: 40, end: 99 });
    expect(parseSingleByteRange('bytes=-8', 100)).toEqual({ kind: 'partial', start: 92, end: 99 });
    expect(parseSingleByteRange('bytes=-1000', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseSingleByteRange('bytes=10-999', 50)).toEqual({ kind: 'partial', start: 10, end: 49 });
  });

  it('refuses an unsatisfiable or malformed byte range', () => {
    expect(parseSingleByteRange('bytes=100-120', 100).kind).toBe('unsatisfiable');
    expect(parseSingleByteRange('bytes=20-10', 100).kind).toBe('unsatisfiable');
    expect(parseSingleByteRange('bytes=0-1,2-3', 100).kind).toBe('unsatisfiable');
    expect(parseSingleByteRange('bytes=abc', 100).kind).toBe('unsatisfiable');
    expect(parseSingleByteRange('bytes=-0', 100).kind).toBe('unsatisfiable');
    expect(parseSingleByteRange('bytes=0-1', 0).kind).toBe('unsatisfiable');
    expect(unsatisfiableRangeHeader(128)).toBe('bytes */128');
    expect(contentRangeHeader(4, 7, 128)).toBe('bytes 4-7/128');
  });
});
