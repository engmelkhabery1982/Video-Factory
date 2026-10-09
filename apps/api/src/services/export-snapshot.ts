/**
 * Identity of the project and narration bytes a final export is allowed to consume.
 *
 * The export handler used to load a project, await the external-narration gate
 * (which reloads independently and measures audio), then render the earlier
 * object and resolve audio from the path again. A script edit or a file
 * replacement during that await could be approved against one state and
 * rendered from another. This module is the comparison both sides use.
 * A mismatch rejects the export. It does not copy a newer gate onto older
 * content, and it does not follow a replaced file through an unchanged path.
 */
import { createHash } from 'node:crypto';
import type { Project, TargetId } from '@buildtrack/core';
import { loadProject } from './store.js';
import { allTargetIds, digestOfFile, targetAudioAbsPath } from '../routes/external-narration.js';

export interface ExportAudioIdentity {
  targetId: string;
  ref: string | null;
  sha256: string | null;
}

export interface ExportIdentity {
  projectId: string;
  updatedAt: string;
  scriptSha256: string;
  audio: ExportAudioIdentity[];
}

/**
 * Deterministic seam for the async boundary. Production leaves these null.
 * A test sets one to mutate the project or the audio file, then the re-check
 * must reject before any renderer runs.
 */
export const exportValidationHooks: {
  afterInitialRead: null | (() => void | Promise<void>);
  beforeConsume: null | (() => void | Promise<void>);
} = {
  afterInitialRead: null,
  beforeConsume: null,
};

function narrationRef(project: Project, target: TargetId): string | null {
  return target === 'long'
    ? project.meta.input.voiceoverFile ?? null
    : project.meta.input.targetAudio?.[target as 'short_1' | 'short_2' | 'short_3'] ?? null;
}

export function identityOf(project: Project): ExportIdentity {
  return {
    projectId: project.meta.input.videoId,
    updatedAt: project.meta.updatedAt,
    scriptSha256: createHash('sha256').update(project.meta.input.script, 'utf8').digest('hex'),
    audio: allTargetIds(project).map((target) => ({
      targetId: target,
      ref: narrationRef(project, target),
      sha256: digestOfFile(targetAudioAbsPath(project, target)),
    })),
  };
}

export function readExportIdentity(videoId: string): ExportIdentity | null {
  const project = loadProject(videoId);
  return project ? identityOf(project) : null;
}

export function sameExportIdentity(left: ExportIdentity | null | undefined, right: ExportIdentity | null | undefined): boolean {
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}
