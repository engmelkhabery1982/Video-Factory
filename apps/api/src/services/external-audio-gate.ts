/**
 * VS4 — external-narration export gate.
 *
 * Called by the project export (`POST /api/projects/:id/export`), the renderer
 * that muxes this imported narration. Projects that never imported narration
 * from outside the app are explicitly NOT AFFECTED (`notApplicable`) and keep
 * the existing flow. The separate production-plan export synthesizes its own
 * dialogue and does not mux this file. As soon as a target has an imported narration,
 * that target may only be exported when
 *
 *   - the import is fully declared (source + ownership confirmation + script),
 *   - exactly those bytes were listened to and approved,
 *   - the approval still matches the current audio, script, speaker and
 *     timing/alignment revision, and
 *   - the planned timeline COVERS the measured audio (the final words are never
 *     cut) and was regenerated after the import.
 *
 * The gate also refuses a Short that points at the Long narration, so imported
 * audio can never silently make a Short inherit the Long's speech.
 */
import type {
  ExternalNarrationFinding,
  Project,
  TargetId,
} from '@buildtrack/core';
import { loadProject } from './store.js';
import { loadVoiceAudioState, type VoiceAudioPersistedState } from './voice-audio-state.js';
import {
  allTargetIds,
  digestOfFile,
  externalNarrationTargetView,
  measuredDuration,
  targetAudioAbsPath,
  type ExternalNarrationTargetView,
} from '../routes/external-narration.js';

export interface ExternalNarrationGateResult {
  allowed: boolean;
  /** True when this project has no imported narration at all. */
  notApplicable: boolean;
  blockedCodes: string[];
  findings: ExternalNarrationFinding[];
  reason: string;
  /** Per-target readiness, so the UI can show exactly what is missing. */
  targets: ExternalNarrationTargetView[];
}

const OK: ExternalNarrationGateResult = {
  allowed: true,
  notApplicable: true,
  blockedCodes: [],
  findings: [],
  reason: 'No narration was imported from outside the app for this project.',
  targets: [],
};

function gate(
  allowed: boolean,
  notApplicable: boolean,
  findings: ExternalNarrationFinding[],
  targets: ExternalNarrationTargetView[],
  reason: string,
): ExternalNarrationGateResult {
  return {
    allowed,
    notApplicable,
    blockedCodes: findings.map((f) => f.code),
    findings,
    reason,
    targets,
  };
}

function narrationRefOf(project: Project, target: TargetId): string | null {
  return target === 'long'
    ? project.meta.input.voiceoverFile ?? null
    : project.meta.input.targetAudio?.[target as 'short_1' | 'short_2' | 'short_3'] ?? null;
}

/** Evaluate the imported narration of one project for export. */
export async function externalNarrationRenderGate(videoId: string): Promise<ExternalNarrationGateResult> {
  const project = loadProject(videoId);
  const state: VoiceAudioPersistedState | null = project ? loadVoiceAudioState(videoId) : null;
  if (!project || !state) {
    return gate(false, false, [
      {
        code: 'IMPORT-MISSING',
        severity: 'error',
        message: 'Project not found.',
        remediation: 'Reload the project.',
      },
    ], [], 'Project not found.');
  }

  const views: ExternalNarrationTargetView[] = [];
  for (const target of allTargetIds(project)) {
    const abs = targetAudioAbsPath(project, target);
    views.push(
      await externalNarrationTargetView(project, target, state, digestOfFile(abs), await measuredDuration(abs)),
    );
  }

  const imported = views.filter((v) => v.import !== null);
  if (imported.length === 0) return OK;

  const findings: ExternalNarrationFinding[] = [];
  for (const view of imported) {
    for (const finding of view.findings) {
      if (finding.severity === 'error') findings.push(finding);
    }
  }

  /* Defence in depth: a Short may never point at the Long narration. */
  const longRef = narrationRefOf(project, 'long');
  if (longRef) {
    for (const view of imported) {
      if (view.targetId === 'long') continue;
      const shortRef = narrationRefOf(project, view.targetId);
      if (shortRef && shortRef === longRef) {
        findings.push({
          code: 'IMPORT-APPROVAL-STALE-TARGET',
          severity: 'error',
          message: `${view.label} uses the Long video's narration. A Short needs narration of its own.`,
          remediation: `Import a separate narration for ${view.label}.`,
        });
      }
    }
  }

  if (findings.length === 0) {
    return gate(true, false, [], views, `Imported narration approved for ${imported.length} target(s).`);
  }
  const blocked = [...new Set(imported.filter((v) => !v.ready).map((v) => v.label))];
  return gate(
    false,
    false,
    findings,
    views,
    `Imported narration is not ready for export${blocked.length ? ` (${blocked.join(', ')})` : ''}: ${findings[0].message}`,
  );
}
