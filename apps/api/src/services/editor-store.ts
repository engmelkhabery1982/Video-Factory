/**
 * Persistence for the editor sidecar (milestone 1).
 *
 * Layout, per project and target:
 *   data/projects/<id>/editor/<targetId>.editor.json   document + undo/redo
 *   data/projects/<id>/editor/.lock                    single-writer lock
 *
 * project.json and its approvals are never written here. Every successful
 * write is atomic (temp file → fsync → rename). A failed write throws
 * EditorError(EDITOR_STORAGE_FAILED) and leaves the previous file in place, so
 * callers never report success for an edit that was not saved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  EditorError,
  EDITOR_SCHEMA_VERSION,
  assertValidEditorDocument,
  deriveEditorDocument,
  mergeLibraryAssets,
  reconcileNarration,
  type NarrationBinding,
  type DeriveAssetRef,
  type EditorDocument,
  type EditorTargetId,
  type Project,
} from '@buildtrack/core';
import { libraryRefsForAdd } from './editor-library-audio.js';
import { projectDir } from './platform.js';

export const EDITOR_HISTORY_LIMIT = 50;
/** A lock older than this belongs to a crashed writer and may be taken over. */
export const EDITOR_LOCK_STALE_MS = 30_000;

export interface EditorState {
  schemaVersion: typeof EDITOR_SCHEMA_VERSION;
  document: EditorDocument;
  /** Snapshots BEFORE each committed transaction, oldest first. */
  undo: EditorDocument[];
  /** Snapshots undone, most recent last. Cleared by any new transaction. */
  redo: EditorDocument[];
}

export function editorDir(videoId: string): string {
  return path.join(projectDir(videoId), 'editor');
}

export function editorStateFile(videoId: string, targetId: EditorTargetId): string {
  return path.join(editorDir(videoId), `${targetId}.editor.json`);
}

function lockFile(videoId: string): string {
  return path.join(editorDir(videoId), '.lock');
}

/** Atomic JSON write. The old file survives any failure before the rename. */
export function atomicWriteJson(file: string, value: unknown): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already failed */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw new EditorError('EDITOR_STORAGE_FAILED', `The edit was not saved: ${(err as Error).message}`, 500);
  }
}

/**
 * Run `fn` while holding the project's editor lock. A second writer gets
 * EDITOR_LOCKED (423) instead of interleaving. A stale lock is taken over once.
 */
export function withEditorLock<T>(videoId: string, fn: () => T): T {
  const file = lockFile(videoId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new EditorError('EDITOR_STORAGE_FAILED', `Cannot take the editor lock: ${(err as Error).message}`, 500);
    }
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < EDITOR_LOCK_STALE_MS) {
      throw new EditorError('EDITOR_LOCKED', 'Another edit is in progress for this project. Retry in a moment.', 423);
    }
    fs.rmSync(file, { force: true });
    fd = fs.openSync(file, 'wx');
  }
  try {
    fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return fn();
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* the stale check cleans up later */ }
  }
}

export function readEditorState(videoId: string, targetId: EditorTargetId): EditorState | null {
  const file = editorStateFile(videoId, targetId);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as EditorState;
  if (raw?.schemaVersion !== EDITOR_SCHEMA_VERSION || !raw.document) {
    throw new EditorError('EDITOR_STATE_CORRUPT', `Editor state for ${targetId} is not readable. The original project was not changed.`, 500);
  }
  assertValidEditorDocument(raw.document);
  return { schemaVersion: EDITOR_SCHEMA_VERSION, document: raw.document, undo: raw.undo ?? [], redo: raw.redo ?? [] };
}

export function writeEditorState(videoId: string, targetId: EditorTargetId, state: EditorState): void {
  assertValidEditorDocument(state.document);
  atomicWriteJson(editorStateFile(videoId, targetId), state);
}

/** Map the project asset index to the editor's asset references. Ineligible assets are not referenced. */
export function editorAssetRefs(assets: Array<Record<string, unknown>>): DeriveAssetRef[] {
  const refs: DeriveAssetRef[] = [];
  for (const a of assets) {
    if (a.status !== 'active' || a.blocked === true) continue;
    const id = typeof a.id === 'string' ? a.id : '';
    const mime = typeof a.mimeType === 'string' ? a.mimeType.toLowerCase() : '';
    const kind = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : null;
    const source = typeof a.source === 'string' ? a.source.trim() : '';
    const license = typeof a.license === 'string' ? a.license.trim() : '';
    if (!id || !kind || !source || !license) continue;
    refs.push({
      id,
      kind,
      name: typeof a.name === 'string' ? a.name : id,
      mediaUrl: `/media/asset/${id}`,
      durationSec: typeof a.durationSec === 'number' && a.durationSec > 0 ? a.durationSec : null,
      source,
      license,
      mimeType: mime,
    });
  }
  return refs;
}

/**
 * Create the sidecar from a legacy project the first time it is opened. The
 * project itself is only read. Returns the existing state when one exists.
 */
/**
 * Add eligible library assets uploaded since the document was last synced. This
 * is a project-side change, like a new narration import: it bumps the revision
 * and clears undo/redo. Returns the same state when nothing was added.
 */
export function syncLibraryState(
  videoId: string,
  targetId: EditorTargetId,
  state: EditorState,
  assets: Array<Record<string, unknown>>,
): EditorState {
  const known = new Set(state.document.assets.map((a) => a.id));
  const refs = libraryRefsForAdd(assets, editorAssetRefs(assets), known);
  const merged = mergeLibraryAssets(state.document, refs);
  if (merged === state.document) return state;
  const next: EditorState = {
    schemaVersion: state.schemaVersion,
    document: { ...merged, revision: state.document.revision + 1 },
    undo: [],
    redo: [],
  };
  writeEditorState(videoId, targetId, next);
  return next;
}

export function ensureEditorState(
  project: Project,
  targetId: EditorTargetId,
  assets: Array<Record<string, unknown>>,
  narration: NarrationBinding | null = null,
): EditorState {
  const videoId = project.meta.input.videoId;
  const existing = readEditorState(videoId, targetId);
  if (existing) return existing;
  const refs = libraryRefsForAdd(assets, editorAssetRefs(assets), new Set());
  const derived = mergeLibraryAssets(deriveEditorDocument({ project, targetId, assets: refs }), refs);
  // First open is revision 0 even when narration is already imported.
  const document = reconcileNarration(derived, narration).doc;
  const state: EditorState = { schemaVersion: EDITOR_SCHEMA_VERSION, document, undo: [], redo: [] };
  writeEditorState(videoId, targetId, state);
  return state;
}
