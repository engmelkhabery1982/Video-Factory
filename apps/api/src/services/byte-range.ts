/**
 * Single-range byte requests for the narration player.
 *
 * A full response without Accept-Ranges makes the browser treat the file as
 * non-seekable: moving the playhead or setting currentTime restarts at 0.
 * This parser never reads a file and never echoes the request header.
 */

export type ByteRangePlan =
  | { kind: 'absent' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

const MAX_RANGE_HEADER = 256;

export function contentRangeHeader(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

export function unsatisfiableRangeHeader(size: number): string {
  return `bytes */${size}`;
}

/**
 * Parse one Range header against a known file size.
 *
 * Absent or a non-bytes unit means the caller should send the whole file.
 * An open end, a suffix, and an end past the file are satisfied as one slice.
 * A multipart range, a backwards range, or a start past the end is refused.
 */
export function parseSingleByteRange(header: string | undefined, size: number): ByteRangePlan {
  if (header === undefined || header.trim() === '') return { kind: 'absent' };
  if (!Number.isSafeInteger(size) || size < 0) return { kind: 'unsatisfiable' };
  const trimmed = header.trim();
  if (trimmed.length > MAX_RANGE_HEADER || /[\r\n]/.test(trimmed)) return { kind: 'unsatisfiable' };
  const match = /^bytes\s*=\s*(.*)$/i.exec(trimmed);
  if (!match) return { kind: 'absent' };
  const spec = match[1].trim();
  if (spec === '' || spec.includes(',')) return { kind: 'unsatisfiable' };
  if (size === 0) return { kind: 'unsatisfiable' };

  const suffix = /^-(\d+)$/.exec(spec);
  if (suffix) {
    const length = Number(suffix[1]);
    if (!Number.isSafeInteger(length) || length <= 0) return { kind: 'unsatisfiable' };
    const take = Math.min(length, size);
    return { kind: 'partial', start: size - take, end: size - 1 };
  }

  const bounded = /^(\d+)-(\d*)$/.exec(spec);
  if (!bounded) return { kind: 'unsatisfiable' };
  const start = Number(bounded[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { kind: 'unsatisfiable' };
  if (bounded[2] === '') return { kind: 'partial', start, end: size - 1 };
  const end = Number(bounded[2]);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}
