/**
 * Persisted editor job records, proposals and frozen revisions. All files live
 * under the project's editor folder, never in the owner's project.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EditorError, type EditorDocument, type EditorTargetId } from '@buildtrack/core';
import { atomicWriteJson, editorDir } from './editor-store.js';

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** Ids come from newId(); anything else is refused so it can never become a path. */
export function isSafeEditorId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{2,6}_[a-f0-9]{16}$/.test(value);
}

function jobPath(videoId: string, kind: 'alignment' | 'preview' | 'export' | 'proposal', id: string): string {
  return path.join(editorDir(videoId), kind === 'proposal' ? 'proposals' : `${kind}-jobs`, `${id}.json`);
}

export function saveRecord(videoId: string, kind: 'alignment' | 'preview' | 'export' | 'proposal', id: string, record: unknown): void {
  atomicWriteJson(jobPath(videoId, kind, id), record);
}

export function loadRecord<T>(videoId: string, kind: 'alignment' | 'preview' | 'export' | 'proposal', id: string): T | null {
  if (!isSafeEditorId(id)) return null;
  const file = jobPath(videoId, kind, id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** A revision never changes after it is frozen; a preview renders from this copy only. */
export function freezeRevision(videoId: string, targetId: EditorTargetId, doc: EditorDocument): string {
  const file = path.join(editorDir(videoId), 'frozen', `${targetId}-r${doc.revision}.json`);
  if (!fs.existsSync(file)) atomicWriteJson(file, doc);
  return file;
}

export function loadFrozenRevision(file: string): EditorDocument {
  if (!fs.existsSync(file)) throw new EditorError('EDITOR_STATE_CORRUPT', 'The frozen revision for this preview is missing.', 500);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as EditorDocument;
}
