/**
 * Library audio for the editor. An uploaded audio asset is an index entry whose
 * file lives under ASSETS_DIR. The file is resolved by the basename of the
 * entry's path (never by a path the client sends), hashed once when it is added
 * to a document, and checked again against that hash before any preview uses it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DeriveAssetRef } from '@buildtrack/core';
import { ASSETS_DIR } from './platform.js';

export type IndexEntry = Record<string, unknown>;

/** The file for an index entry, or null when the entry does not point to a regular file in ASSETS_DIR. */
export function libraryAudioFile(entry: IndexEntry | undefined): string | null {
  if (!entry || typeof entry.path !== 'string') return null;
  const base = path.basename(entry.path);
  if (!base || base === '.' || base === '..') return null;
  const root = path.resolve(ASSETS_DIR);
  const abs = path.resolve(root, base);
  if (!abs.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/** sha256 of a file, read in chunks so large audio never sits in memory. Synchronous: called under the editor lock. */
export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Editor references for the library. Audio references get a sha256 only when
 * `knownIds` does not already contain them, so each file is hashed once, on add.
 * An audio entry whose file cannot be read gets no sha and is not added.
 */
export function libraryRefsForAdd(
  assets: IndexEntry[],
  refs: DeriveAssetRef[],
  knownIds: ReadonlySet<string>,
): DeriveAssetRef[] {
  const out: DeriveAssetRef[] = [];
  for (const ref of refs) {
    if (ref.kind !== 'audio' || knownIds.has(ref.id) || ref.durationSec === null) {
      out.push(ref);
      continue;
    }
    const file = libraryAudioFile(assets.find((a) => a.id === ref.id));
    out.push({ ...ref, sha256: file ? sha256File(file) : null });
  }
  return out;
}
