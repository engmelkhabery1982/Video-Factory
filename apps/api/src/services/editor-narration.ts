/**
 * Binds the editor to the project's EXISTING narration import (external
 * narration state). Read-only with respect to the narration: the file, its
 * import record and its approvals are never written here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EditorError, reconcileNarration, type NarrationBinding, type TargetId } from '@buildtrack/core';
import { DATA_DIR } from './platform.js';
import { loadVoiceAudioState } from './voice-audio-state.js';
import { readEditorState, writeEditorState, type EditorState } from './editor-store.js';

const VOICEOVER_ROOT = path.resolve(DATA_DIR, 'voiceover');

/** Stored narration refs are `voiceover/<file>` under the data root. Anything else is refused. */
export function narrationFileAbs(storedRef: string): string | null {
  if (!/^voiceover\/[^/\\]+$/.test(storedRef)) return null;
  const abs = path.resolve(DATA_DIR, storedRef);
  return abs.startsWith(VOICEOVER_ROOT + path.sep) ? abs : null;
}

export function sha256OfBytes(abs: string): string {
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function licenseText(kind: string, ownershipConfirmed: boolean): string {
  return `${kind} (operator declaration; ownership ${ownershipConfirmed ? 'declared' : 'NOT declared'})`;
}

/**
 * The narration currently recorded for this target, or null when none was
 * imported. Throws EDITOR_NARRATION_CHANGED when a record exists but its file is
 * missing or its bytes no longer match the recorded SHA-256. Silently dropping
 * narration in that case would hide a real problem.
 */
export function narrationBindingFor(videoId: string, targetId: TargetId): NarrationBinding | null {
  const state = loadVoiceAudioState(videoId);
  const imp = state.externalNarration?.imports?.[targetId];
  if (!imp) return null;
  const abs = narrationFileAbs(imp.storedRef);
  if (!abs || !fs.existsSync(abs)) {
    throw new EditorError('EDITOR_NARRATION_CHANGED', `The imported narration file for ${targetId} is missing. Re-import it; the editor will not guess.`, 409);
  }
  if (sha256OfBytes(abs) !== imp.sha256) {
    throw new EditorError('EDITOR_NARRATION_CHANGED', `The imported narration file for ${targetId} no longer matches its recorded SHA-256. Re-import it.`, 409);
  }
  const approval = state.externalNarration?.approvals?.[targetId];
  const approved =
    approval?.decision === 'approved' && approval.importId === imp.importId && approval.artifactSha256 === imp.sha256;
  const declaration = imp.declaration as unknown as { sourceKind?: string; ownershipConfirmed?: boolean } | undefined;
  return {
    importId: imp.importId,
    name: imp.fileName,
    mediaUrl: `/api/projects/${videoId}/editor/media/narration/${imp.importId}`,
    source: 'external_narration_import',
    license: licenseText(String(declaration?.sourceKind ?? 'unknown'), declaration?.ownershipConfirmed === true),
    durationSec: imp.durationSec,
    sha256: imp.sha256,
    approved,
  };
}

/** Absolute path of the narration file for a given import id, or null when it is not the current import. */
export function currentNarrationFile(videoId: string, targetId: TargetId, importId: string): string | null {
  const imp = loadVoiceAudioState(videoId).externalNarration?.imports?.[targetId];
  if (!imp || imp.importId !== importId) return null;
  return narrationFileAbs(imp.storedRef);
}

/** Narration file for an import id, searched across targets. Null when the id is not a current import. */
export function narrationFileByImportId(videoId: string, importId: string): { file: string; mimeType: string } | null {
  const imports = loadVoiceAudioState(videoId).externalNarration?.imports ?? {};
  for (const imp of Object.values(imports)) {
    if (!imp || imp.importId !== importId) continue;
    const file = narrationFileAbs(imp.storedRef);
    return file ? { file, mimeType: imp.mimeType || 'audio/wav' } : null;
  }
  return null;
}

/**
 * Bring the editor's narration asset in line with the project's current import.
 * A change is a new document revision with EMPTY history: an undo cannot restore
 * a narration the project no longer uses. Returns the same state when nothing changed.
 */
export function syncNarrationState(videoId: string, targetId: TargetId, state: EditorState, binding: NarrationBinding | null): EditorState {
  const r = reconcileNarration(state.document, binding);
  if (!r.changed) return state;
  const next: EditorState = {
    schemaVersion: state.schemaVersion,
    document: { ...r.doc, revision: state.document.revision + 1 },
    undo: [],
    redo: [],
  };
  writeEditorState(videoId, targetId, next);
  return next;
}

export function currentRevisionOf(videoId: string, targetId: TargetId): number | null {
  return readEditorState(videoId, targetId)?.document.revision ?? null;
}
