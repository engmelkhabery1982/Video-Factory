/**
 * VS4 — external narration import (no local synthesis engine involved).
 *
 * Narration produced outside this app (Kaggle, a studio, a licensed vendor) is
 * imported as a file through the SAME upload path as ordinary narration
 * (`acceptNarrationUpload`), then declared, listened to, approved and finally
 * tied to the target's scene/caption timing.
 *
 * What this module deliberately does NOT do:
 *   - it never runs, downloads or provisions a voice engine;
 *   - it never trims, accelerates or slices accepted audio to fit old scene
 *     durations — the measured duration is the authority and the timeline is
 *     regenerated around it;
 *   - it never treats a declared engine/model/voice name as proof of rights;
 *   - it never lets a Short inherit the Long's narration;
 *   - it never calls estimated scene timing "verified alignment";
 *   - it never serves a private reference recording (those stay in the
 *     project-private voice-audio state and are not reachable from here).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { finished, pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  captionsForTarget,
  describeTimingReview,
  evaluateExternalDialogueCoverage,
  evaluateExternalNarrationReadiness,
  evaluateExternalTimingApproval,
  externalNarrationIntendedSpokenSha256,
  externalNarrationScriptSha256,
  externalNarrationSpeechTimingRevision,
  externalNarrationTimingRevision,
  validateSpeechTiming,
  type ExternalDialogueTurnExpectation,
  type ExternalDialogueTurnImport,
  type ExternalNarrationAlignment,
  type ExternalNarrationApproval,
  type ExternalNarrationDeclaration,
  type ExternalNarrationFinding,
  type ExternalNarrationImport,
  type ExternalNarrationReadiness,
  type ExternalNarrationSourceKind,
  type ExternalNarrationTimingApproval,
  type Project,
  type Scene,
  type SceneTiming,
  type SpeechCaptionTiming,
  type SpeechSceneTiming,
  type SpeechTimingSnapshot,
  type TargetId,
  type TimingReviewDescription,
} from '@buildtrack/core';
import { contentRangeHeader, parseSingleByteRange, unsatisfiableRangeHeader } from '../services/byte-range.js';
import { DATA_DIR, productionAudioBasePaths } from '../services/platform.js';
import { loadProject, saveProject } from '../services/store.js';
import { durationOf } from '../services/media.js';
import {
  acceptStagedNarration,
  formatAudioByteLimit,
  isValidTargetId,
  isTargetInProject,
  maxAudioUploadBytes,
  stageNarrationPart,
  targetLabel,
  validateNarrationFileType,
  type AcceptedNarrationUpload,
} from './target-audio.js';
import { isSafeVideoId, loadVoiceAudioState, saveVoiceAudioState, type VoiceAudioPersistedState } from '../services/voice-audio-state.js';

/** Silent end card allowed after the last spoken word of a target. */
export const END_CARD_SECONDS: Record<TargetId, number> = {
  long: 8,
  short_1: 0.3,
  short_2: 0.3,
  short_3: 0.3,
};

const SOURCE_KINDS: readonly ExternalNarrationSourceKind[] = [
  'own_recording',
  'authorized_external_synthesis',
];

function JSON_ERROR(message: string): { error: string } {
  return { error: message };
}

/** Best-effort drain of a rejected multipart part. */
async function drainPart(part: any): Promise<void> {
  try {
    part.file?.resume?.();
    const { finished } = await import('node:stream/promises');
    await finished(part.file);
  } catch {
    /* the request is already being rejected; draining is best effort */
  }
}

function newImportId(): string {
  return `imp_${randomBytes(8).toString('hex')}`;
}

/** Sanitize a free-text field: trim, cap length, drop control characters. */
function cleanText(value: unknown, max = 4000): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function cleanOptionalText(value: unknown, max = 200): string | null {
  const text = cleanText(value, max);
  return text.length > 0 ? text : null;
}

function readDeclaration(fields: Record<string, unknown>): {
  declaration?: ExternalNarrationDeclaration;
  error?: string;
} {
  const sourceKind = cleanText(fields.sourceKind, 60);
  if (!SOURCE_KINDS.includes(sourceKind as ExternalNarrationSourceKind)) {
    return {
      error:
        'Declare where this narration came from: "own_recording" (you recorded it) or "authorized_external_synthesis" (somebody else generated it and you are allowed to publish it).',
    };
  }
  const ownershipConfirmed = fields.ownershipConfirmed === true || fields.ownershipConfirmed === 'true';
  const ownershipStatement = cleanText(fields.ownershipStatement, 600);
  if (!ownershipConfirmed || !ownershipStatement) {
    return {
      error:
        'Confirm that you own this recording or are authorized to publish it, and type the confirmation statement.',
    };
  }
  const speakerName = cleanText(fields.speakerName, 120);
  if (!speakerName) {
    return { error: 'Name the speaker heard in this narration.' };
  }
  return {
    declaration: {
      sourceKind: sourceKind as ExternalNarrationSourceKind,
      ownershipConfirmed,
      ownershipStatement,
      speakerName,
      speakerId: cleanOptionalText(fields.speakerId, 80),
      // Documented source info. Typed in by the operator; never verified here.
      engineName: cleanOptionalText(fields.engineName, 120),
      modelName: cleanOptionalText(fields.modelName, 120),
      voiceName: cleanOptionalText(fields.voiceName, 120),
      sourceNotes: cleanOptionalText(fields.sourceNotes, 600),
    },
  };
}

/**
 * Per-scene timing that ships next to an imported narration file:
 * `<audio>.timing.json`. Exact alignment is only ever claimed when the texts
 * match the scenes word for word; otherwise it is an estimate.
 */
function readSceneTiming(absAudioPath: string): SceneTiming[] | null {
  const sidecar = absAudioPath.replace(/\.[^.]+$/, '.timing.json');
  try {
    const raw = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as { scenes?: SceneTiming[] };
    return Array.isArray(raw.scenes) ? raw.scenes : null;
  } catch {
    return null;
  }
}

export function externalNarrationAlignment(
  timing: SceneTiming[] | null,
  scenes: readonly Scene[],
): ExternalNarrationAlignment {
  if (timing && timing.length > 0 && scenes.length > 0 && timing.length === scenes.length) {
    const matches = timing.every((t, i) => t.duration > 0 && t.text.trim() === (scenes[i].narration ?? '').trim());
    if (matches) {
      return {
        mode: 'exact_scene_timing',
        verified: true,
        sceneCount: timing.length,
        detail:
          'A timing file matches every scene word for word. That proves the script matches the file. It is not proof that anyone listened to the synchronization.',
      };
    }
  }
  if (timing && timing.length > 0) {
    return {
      mode: 'estimated_from_script',
      verified: false,
      sceneCount: timing.length,
      detail:
        'A timing file was found but its per-scene text does not match the scenes word for word, so scene durations remain ESTIMATES from the script, not verified alignment.',
    };
  }
  return {
    mode: 'estimated_from_script',
    verified: false,
    sceneCount: null,
    detail:
      'No per-scene speech timing is available, so scene and caption times are ESTIMATES derived from the script and the measured total duration. They are not verified alignment.',
  };
}

/**
 * Spoken-content identity for one target. Long includes the project script.
 * A Short uses only its own narration, never the Long script.
 */
export function intendedSpokenSha256Of(project: Project, target: TargetId): string {
  return externalNarrationIntendedSpokenSha256({
    targetId: target,
    projectScript: target === 'long' ? project.meta.input.script : '',
    narration: scenesOf(project, target).map((scene) => scene.narration ?? ''),
  });
}

/** Scenes of one target from the current storyboard. */
export function scenesOf(project: Project, target: TargetId): Scene[] {
  if (target === 'long') return project.storyboard.long?.scenes ?? [];
  const plan = (project.storyboard.shorts ?? []).find((s) => s.id === target);
  return plan?.scenes ?? [];
}

/** Planned timeline length of one target (scene durations, incl. end card). */
export function timelineDurationOf(project: Project, target: TargetId): number | null {
  if (target === 'long') {
    const total = project.storyboard.long?.totalDuration;
    return typeof total === 'number' && total > 0 ? Number(total.toFixed(3)) : null;
  }
  const plan = (project.storyboard.shorts ?? []).find((s) => s.id === target);
  const total = plan?.totalDuration;
  return typeof total === 'number' && total > 0 ? Number(total.toFixed(3)) : null;
}

/**
 * Absolute path of a target's narration, contained inside the data root.
 * A symlink (or a parent symlink that escapes the data root) is a refusal,
 * never a file to stream.
 */
export function targetAudioAbsPath(project: Project, target: TargetId): string | null {
  const ref =
    target === 'long'
      ? project.meta.input.voiceoverFile ?? null
      : project.meta.input.targetAudio?.[target as 'short_1' | 'short_2' | 'short_3'] ?? null;
  if (!ref || ref.includes('\0')) return null;
  const abs = path.resolve(path.isAbsolute(ref) ? ref : path.join(DATA_DIR, ref));
  const root = path.resolve(DATA_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const listed = fs.lstatSync(abs);
    if (!listed.isFile() || listed.isSymbolicLink()) return null;
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(abs);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  } catch {
    return null;
  }
  return abs;
}

export function digestOfFile(filePath: string | null): string | null {
  if (!filePath) return null;
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

export async function measuredDuration(filePath: string | null): Promise<number | null> {
  if (!filePath) return null;
  try {
    const seconds = await durationOf(filePath);
    return Number.isFinite(seconds) && seconds > 0 ? Number(seconds.toFixed(3)) : null;
  } catch {
    return null;
  }
}

/** Speaker identity currently assigned to this project, when one exists. */
function currentSpeakerId(state: VoiceAudioPersistedState): string | null {
  const assignment = state.assignments.find((a) => !!a.speakerId);
  return assignment?.speakerId ?? null;
}

export interface ExternalNarrationReadinessLine {
  key: 'source' | 'listening' | 'rights' | 'timing' | 'coverage' | 'export' | 'publication';
  label: string;
  state: string;
  /** Null is informational. False blocks an export attempt. True does not mean publication. */
  ok: boolean | null;
  detail: string;
}

export interface ExternalNarrationReadinessBlocker {
  code: string;
  message: string;
  remediation: string;
  /** Existing control on the Captions page. Not a new route. */
  control: string;
  where: 'captions';
}

/**
 * Projection of the evaluation the export gate already runs.
 * `exportAttemptReady` is that gate's per-target result. It is never publication approval.
 */
export interface ExternalNarrationReadinessSummary {
  targetId: TargetId;
  /** True only when an outside import is recorded for this target. */
  applies: boolean;
  /** This Short's file pointer is the Long file. Export must not treat that as its own audio. */
  inheritsLongNarration: boolean;
  exportAttemptReady: boolean;
  /** Always false. A passing check is not commercial clearance or publication approval. */
  publicationApproved: false;
  lines: ExternalNarrationReadinessLine[];
  blockers: ExternalNarrationReadinessBlocker[];
}

export interface ExternalNarrationTargetView {
  targetId: TargetId;
  label: string;
  import: ExternalNarrationImport | null;
  approval: ExternalNarrationApproval | null;
  /** VS5 timing approval. Null when this target has an import but no timing approval yet. */
  timingApproval: ExternalNarrationTimingApproval | null;
  ready: boolean;
  summary: string;
  blockReasons: string[];
  findings: ExternalNarrationReadiness['findings'];
  alignment: ExternalNarrationAlignment | null;
  audioDurationSec: number | null;
  timelineDurationSec: number | null;
  endCardSeconds: number;
  /** Coarse timeline revision. Not used to revoke the listening approval. */
  timingRevision: string;
  /** Digest of caption/scene speech times. The timing approval is bound to this. */
  speechTimingRevision: string | null;
  timingReview: TimingReviewDescription | null;
  /** Same checks the export gate uses, projected for the review and export pages. */
  readiness: ExternalNarrationReadinessSummary;
}

/**
 * Everything the UI and the export gate need to know about one target.
 *
 * The listening approval is not revoked by a timing-only edit. Caption and
 * scene corrections are gated by the separate timing approval, which is bound
 * to the speech-timing revision.
 */

/**
 * Alignment of the narration that is on disk RIGHT NOW. A `.timing.json`
 * sidecar next to it gives exact per-scene timing when its text matches the
 * scenes word for word; anything else stays an estimate and is labelled as one.
 */
function absAlignment(
  project: Project,
  target: TargetId,
  record: ExternalNarrationImport | null,
): ExternalNarrationAlignment | null {
  const abs = targetAudioAbsPath(project, target);
  if (abs) {
    return externalNarrationAlignment(readSceneTiming(abs), scenesOf(project, target));
  }
  return record?.alignment ?? null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function captionsOf(project: Project, target: TargetId) {
  return captionsForTarget(project.storyboard, target);
}

export function speechSnapshot(
  project: Project,
  target: TargetId,
  artifactSha256: string,
  scriptSha256: string,
  audioDurationSec: number,
): { snapshot: SpeechTimingSnapshot; validationInput: Parameters<typeof validateSpeechTiming>[0] } {
  const scenes = scenesOf(project, target);
  const captions = captionsOf(project, target);
  const snapshot: SpeechTimingSnapshot = {
    projectId: project.meta.input.videoId,
    targetId: target,
    artifactSha256,
    scriptSha256,
    audioDurationSec,
    endCardSeconds: END_CARD_SECONDS[target],
    scenes: scenes.map((scene) => ({
      sceneId: scene.id,
      startTime: scene.startTime,
      durationSec: scene.duration,
      narration: scene.narration ?? '',
      role: scene.role,
    })),
    captions: captions.map((cue) => ({
      cueId: cue.id,
      sceneId: cue.sceneId,
      start: cue.start,
      end: cue.end,
      text: cue.text,
    })),
  };
  return {
    snapshot,
    validationInput: {
      snapshot,
      ownedSceneIds: scenes.map((scene) => scene.id),
      ownedCueIds: captions.map((cue) => cue.id),
      storedNarrationByScene: Object.fromEntries(scenes.map((scene) => [scene.id, scene.narration ?? ''])),
      storedCaptionTextByCue: Object.fromEntries(captions.map((cue) => [cue.id, cue.text])),
    },
  };
}

function proposedSpeech(
  project: Project,
  target: TargetId,
  artifactSha256: string,
  scriptSha256: string,
  audioDurationSec: number,
  body: { scenes?: unknown; captions?: unknown },
): { snapshot: SpeechTimingSnapshot; validationInput: Parameters<typeof validateSpeechTiming>[0]; textErrors: ExternalNarrationFinding[] } {
  const current = speechSnapshot(project, target, artifactSha256, scriptSha256, audioDurationSec);
  const textErrors: ExternalNarrationFinding[] = [];
  const scenePatches = new Map<string, { startTime: number; durationSec: number }>();
  const cuePatches = new Map<string, { start: number; end: number }>();
  if (!Array.isArray(body.scenes) || !Array.isArray(body.captions)) {
    textErrors.push({
      code: 'TIMING-SCENE-COVERAGE',
      severity: 'error',
      message: 'A timing correction needs the scenes and captions of this target.',
      remediation: 'Send every scene and every caption of the selected target.',
    });
    return { ...current, textErrors };
  }
  for (const raw of body.scenes) {
    const row = raw as { sceneId?: unknown; startTime?: unknown; durationSec?: unknown; narration?: unknown };
    const sceneId = typeof row.sceneId === 'string' ? row.sceneId : '';
    const startTime = readNumber(row.startTime);
    const durationSec = readNumber(row.durationSec);
    if (!sceneId || startTime === null || durationSec === null) {
      textErrors.push({
        code: 'TIMING-TIME-INVALID',
        severity: 'error',
        message: 'Each scene needs a sceneId and finite startTime and durationSec.',
        remediation: 'Correct the scene times and submit again.',
      });
      continue;
    }
    if (typeof row.narration === 'string' && current.validationInput.storedNarrationByScene[sceneId] !== undefined && row.narration !== current.validationInput.storedNarrationByScene[sceneId]) {
      textErrors.push({
        code: 'TIMING-SCRIPT-ALTERED',
        severity: 'error',
        message: `Scene ${sceneId} narration text cannot be changed from the timing review.`,
        remediation: 'Keep the spoken words. Change only the times.',
      });
    }
    scenePatches.set(sceneId, { startTime, durationSec });
  }
  for (const raw of body.captions) {
    const row = raw as { cueId?: unknown; start?: unknown; end?: unknown; text?: unknown };
    const cueId = typeof row.cueId === 'string' ? row.cueId : '';
    const start = readNumber(row.start);
    const end = readNumber(row.end);
    if (!cueId || start === null || end === null) {
      textErrors.push({
        code: 'TIMING-TIME-INVALID',
        severity: 'error',
        message: 'Each caption needs a cueId and finite start and end.',
        remediation: 'Correct the caption times and submit again.',
      });
      continue;
    }
    if (typeof row.text === 'string' && current.validationInput.storedCaptionTextByCue[cueId] !== undefined && row.text !== current.validationInput.storedCaptionTextByCue[cueId]) {
      textErrors.push({
        code: 'TIMING-SCRIPT-ALTERED',
        severity: 'error',
        message: `Caption ${cueId} text cannot be changed from the timing review.`,
        remediation: 'Keep the caption words. Change only the times.',
      });
    }
    cuePatches.set(cueId, { start, end });
  }
  const scenes: SpeechSceneTiming[] = current.snapshot.scenes.map((scene) => {
    const patch = scenePatches.get(scene.sceneId);
    return patch ? { ...scene, startTime: patch.startTime, durationSec: patch.durationSec } : scene;
  });
  for (const [sceneId, patch] of scenePatches) {
    if (!current.snapshot.scenes.some((scene) => scene.sceneId === sceneId)) {
      scenes.push({ sceneId, startTime: patch.startTime, durationSec: patch.durationSec, narration: '' });
    }
  }
  const captions: SpeechCaptionTiming[] = current.snapshot.captions.map((cue) => {
    const patch = cuePatches.get(cue.cueId);
    return patch ? { ...cue, start: patch.start, end: patch.end } : cue;
  });
  for (const [cueId, patch] of cuePatches) {
    if (!current.snapshot.captions.some((cue) => cue.cueId === cueId)) {
      captions.push({ cueId, sceneId: null, start: patch.start, end: patch.end, text: '' });
    }
  }
  const snapshot: SpeechTimingSnapshot = { ...current.snapshot, scenes, captions };
  return { snapshot, validationInput: { ...current.validationInput, snapshot }, textErrors };
}

function applySpeechTiming(project: Project, target: TargetId, snapshot: SpeechTimingSnapshot): void {
  const scenes = scenesOf(project, target);
  for (const scene of scenes) {
    const next = snapshot.scenes.find((item) => item.sceneId === scene.id);
    if (!next) continue;
    scene.startTime = Number(next.startTime.toFixed(3));
    scene.duration = Number(next.durationSec.toFixed(3));
    scene.userEdited = true;
  }
  const ordered = scenes.slice().sort((a, b) => a.startTime - b.startTime);
  const total = ordered.length ? ordered[ordered.length - 1].startTime + ordered[ordered.length - 1].duration : 0;
  if (target === 'long') {
    project.storyboard.long.totalDuration = Number(total.toFixed(3));
    project.storyboard.captions = project.storyboard.captions.map((cue) => {
      const next = snapshot.captions.find((item) => item.cueId === cue.id);
      if (!next) return cue;
      return { ...cue, start: Number(next.start.toFixed(3)), end: Number(next.end.toFixed(3)), userEdited: true };
    });
  } else {
    const plan = project.storyboard.shorts.find((item) => item.id === target);
    if (plan) plan.totalDuration = Number(total.toFixed(3));
    const current = captionsForTarget(project.storyboard, target).map((cue) => {
      const next = snapshot.captions.find((item) => item.cueId === cue.id);
      if (!next) return cue;
      return { ...cue, start: Number(next.start.toFixed(3)), end: Number(next.end.toFixed(3)), userEdited: true };
    });
    project.storyboard.shortCaptions = { ...(project.storyboard.shortCaptions ?? {}), [target]: current };
  }
  project.meta.updatedAt = new Date().toISOString();
}

function keepExternal(
  state: VoiceAudioPersistedState,
  patch: Partial<NonNullable<VoiceAudioPersistedState['externalNarration']>>,
): void {
  const current = state.externalNarration;
  state.externalNarration = {
    imports: patch.imports ?? current?.imports ?? {},
    approvals: patch.approvals ?? current?.approvals ?? {},
    dialogueImports: patch.dialogueImports ?? current?.dialogueImports ?? [],
    timingApprovals: patch.timingApprovals ?? current?.timingApprovals ?? {},
  };
}

function storedNarrationRef(project: Project, target: TargetId): string | null {
  if (target === 'long') return project.meta.input.voiceoverFile ?? null;
  return project.meta.input.targetAudio?.[target as 'short_1' | 'short_2' | 'short_3'] ?? null;
}

/** A display name only. Directory segments are never returned. */
function safeBaseName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.includes('\0') || normalized.split('/').includes('..')) return null;
  const base = path.posix.basename(normalized);
  return base && base !== '.' && base !== '..' ? base : null;
}

function formatMeasured(value: number | null): string {
  return value !== null && Number.isFinite(value) ? `${value.toFixed(2)}s measured` : 'duration not measured';
}

function hasError(findings: ExternalNarrationFinding[], code: string): boolean {
  return findings.some((finding) => finding.severity === 'error' && finding.code === code);
}

function controlFor(code: string): string {
  if (code === 'IMPORT-APPROVAL-MISSING' || code === 'IMPORT-LISTENING-NOT-CONFIRMED' || code === 'IMPORT-APPROVAL-REJECTED') {
    return 'Approve this exact audio';
  }
  if (code === 'IMPORT-OWNERSHIP-UNCONFIRMED' || code === 'IMPORT-DECLARATION-INCOMPLETE' || code === 'IMPORT-SCRIPT-MISSING') {
    return 'Replace import';
  }
  if (code.startsWith('TIMING-') || code === 'IMPORT-APPROVAL-STALE-TIMING') return 'Review timing';
  if (code === 'IMPORT-APPROVAL-STALE-TARGET') return 'Replace import';
  if (code === 'IMPORT-APPROVAL-STALE-INTENDED-SCRIPT') return 'Approve this exact audio';
  return 'Replace import';
}

const COVERAGE_CODES = new Set([
  'TIMING-TIMELINE-SHORTER-THAN-AUDIO',
  'TIMING-SPEECH-SHORTER-THAN-AUDIO',
  'TIMING-SCENE-COVERAGE',
]);

const LISTENING_STALE_CODES = [
  'IMPORT-APPROVAL-STALE-TARGET',
  'IMPORT-APPROVAL-STALE-ARTIFACT',
  'IMPORT-APPROVAL-STALE-SCRIPT',
  'IMPORT-APPROVAL-STALE-INTENDED-SCRIPT',
  'IMPORT-APPROVAL-STALE-SPEAKER',
  'IMPORT-APPROVAL-STALE-TIMING',
];

/**
 * Turn the evaluation already stored on a target view into the lines the
 * review and export pages show. This does not run a second check.
 */
export function projectExternalNarrationReadiness(input: {
  targetId: TargetId;
  label: string;
  import: ExternalNarrationImport | null;
  approval: ExternalNarrationApproval | null;
  ready: boolean;
  findings: ExternalNarrationFinding[];
  audioDurationSec: number | null;
  timelineDurationSec: number | null;
  timingReview: TimingReviewDescription | null;
  activeFileName: string | null;
  inheritsLongNarration: boolean;
}): ExternalNarrationReadinessSummary {
  const errors = input.findings.filter((finding) => finding.severity === 'error');
  const applies = input.import !== null;
  const measured = formatMeasured(input.audioDurationSec);
  const fileName = safeBaseName(input.import?.fileName) ?? input.activeFileName;

  let sourceState = 'No narration for this target';
  let sourceDetail = 'No audio file is attached to this target. It will not inherit another target\'s narration.';
  let sourceOk: boolean | null = null;
  if (input.inheritsLongNarration) {
    sourceState = 'This Short points at the Long narration';
    sourceDetail = 'A Short cannot inherit the Long audio or its approval. Import a separate file for this Short. No other voice is substituted.';
    sourceOk = false;
  } else if (!applies && input.activeFileName) {
    sourceState = 'Uploaded narration for this target';
    sourceDetail = `${input.activeFileName} · ${measured}. This is not an outside import, so the outside-import checks do not apply. It is not another target's file.`;
  } else if (applies && hasError(errors, 'IMPORT-ARTIFACT-MISSING')) {
    sourceState = 'Imported narration unreadable';
    sourceDetail = 'The imported file for this target cannot be read. Export will not substitute a different file or another target\'s audio.';
    sourceOk = false;
  } else if (applies && hasError(errors, 'IMPORT-APPROVAL-STALE-ARTIFACT')) {
    sourceState = 'File does not match the reviewed import';
    sourceDetail = `${fileName ?? 'The reviewed file'} was approved, but the file now on this target is different. Export will not fall back to another voice.`;
    sourceOk = false;
  } else if (applies) {
    sourceState = 'Imported narration for this target';
    sourceDetail = `${fileName ?? 'Imported file'} · ${measured}. A final export of this target muxes this file. It does not fall back to another target or to a voice generated inside the app.`;
    sourceOk = true;
  }

  let listeningState = 'Not applicable';
  let listeningDetail = 'There is no outside import to approve.';
  let listeningOk: boolean | null = null;
  if (applies && hasError(errors, 'IMPORT-APPROVAL-MISSING')) {
    listeningState = 'Listening not approved';
    listeningDetail = 'Listen to this exact file, then approve it. Approval of another target does not count.';
    listeningOk = false;
  } else if (applies && hasError(errors, 'IMPORT-LISTENING-NOT-CONFIRMED')) {
    listeningState = 'Listening not confirmed';
    listeningDetail = 'The approval does not record that this exact file was heard.';
    listeningOk = false;
  } else if (applies && hasError(errors, 'IMPORT-APPROVAL-REJECTED')) {
    listeningState = 'Listening rejected';
    listeningDetail = 'This file was rejected. Import a corrected file and approve it explicitly.';
    listeningOk = false;
  } else if (applies && LISTENING_STALE_CODES.some((code) => hasError(errors, code))) {
    listeningState = 'Listening approval stale';
    listeningDetail = 'The listening approval does not match this target\'s current audio, spoken script, or speaker. It is not reused from another target.';
    listeningOk = false;
  } else if (applies && input.approval?.decision === 'approved' && input.approval.listened) {
    listeningState = 'Listening approved';
    listeningDetail = 'These exact bytes were listened to and approved. That is not acoustic verification of the captions.';
    listeningOk = true;
  } else if (applies) {
    listeningState = 'Listening not approved';
    listeningDetail = 'Listen to this exact file, then approve it.';
    listeningOk = false;
  }

  const rightsMissing = hasError(errors, 'IMPORT-OWNERSHIP-UNCONFIRMED') || hasError(errors, 'IMPORT-DECLARATION-INCOMPLETE');
  const statement = input.import?.declaration.ownershipStatement?.trim() ?? '';
  let rightsState = 'Not applicable';
  let rightsDetail = 'There is no outside import to attach a consent statement to.';
  let rightsOk: boolean | null = null;
  if (applies && rightsMissing) {
    rightsState = 'Rights and consent missing';
    rightsDetail = 'A rights and consent statement is required before export. An engine name is not a clearance.';
    rightsOk = false;
  } else if (applies && input.import?.declaration.ownershipConfirmed && statement) {
    rightsState = 'Statement recorded';
    rightsDetail = 'A rights and consent statement is on record. It is not a legal clearance, and it is not publication approval.';
    rightsOk = true;
  } else if (applies) {
    rightsState = 'Rights and consent missing';
    rightsDetail = 'Confirm that you may publish this recording, in your own words. A declared engine name does not do that.';
    rightsOk = false;
  }

  const timingBlocked = errors.some((finding) => finding.code.startsWith('TIMING-') || finding.code === 'IMPORT-APPROVAL-STALE-TIMING');
  let timingState = 'Not applicable';
  let timingDetail = 'There is no outside import to time.';
  let timingOk: boolean | null = null;
  if (applies && input.timingReview) {
    timingState = `${input.timingReview.sourceLabel} · ${input.timingReview.reviewLabel}`;
    timingDetail = `${input.timingReview.detail} Estimated timing is not acoustic alignment. A script match is not heard-word sync. Manual timing approval is not acoustic verification.`;
    timingOk = input.timingReview.review === 'approved' && !timingBlocked;
  } else if (applies) {
    timingState = 'Timing not reviewed';
    timingDetail = 'Review the caption and scene times against this audio. Estimated timing is not acoustic alignment.';
    timingOk = false;
  }

  const coverageError = errors.find((finding) => COVERAGE_CODES.has(finding.code));
  let coverageState = 'Not applicable';
  let coverageDetail = 'There is no imported audio to cover.';
  let coverageOk: boolean | null = null;
  if (applies && coverageError) {
    coverageState = 'Storyboard does not cover the measured audio';
    coverageDetail = `${coverageError.message} ${coverageError.remediation}`;
    coverageOk = false;
  } else if (applies && input.audioDurationSec === null) {
    coverageState = 'Coverage unknown';
    coverageDetail = 'The audio duration was not measured, so coverage cannot be confirmed. Export will not guess.';
    coverageOk = false;
  } else if (applies) {
    coverageState = 'Spoken scenes cover the measured audio';
    coverageDetail = `Spoken scenes cover ${formatMeasured(input.audioDurationSec)}. Timeline ${formatMeasured(input.timelineDurationSec)}. This is not a listening check, and a caption gap inside the audio is not forbidden.`;
    coverageOk = true;
  }

  const exportAttemptReady = applies && input.ready && !input.inheritsLongNarration && !rightsMissing && listeningOk !== false && timingOk !== false && coverageOk !== false && sourceOk !== false;
  const exportState = !applies && !input.inheritsLongNarration
    ? 'Outside-import checks do not apply'
    : exportAttemptReady
      ? 'Ready to attempt export'
      : 'Export attempt blocked';
  const exportDetail = exportAttemptReady
    ? 'The server checks for this target pass. This is not a completed render, not commercial-rights clearance, and not publication approval.'
    : input.inheritsLongNarration
      ? 'Final export will not use the Long narration for this Short.'
      : applies
        ? 'Final export of this target is blocked until the findings below are fixed. A preview is not this check.'
        : 'This target has no outside import. The ordinary upload path, if any, is unchanged.';

  const blockers: ExternalNarrationReadinessBlocker[] = [];
  if (input.inheritsLongNarration) {
    blockers.push({
      code: 'IMPORT-APPROVAL-STALE-TARGET',
      message: `${input.label} uses the Long video's narration. A Short needs narration of its own.`,
      remediation: `Import a separate narration for ${input.label}.`,
      control: 'Replace import',
      where: 'captions',
    });
  }
  if (applies) {
    for (const finding of errors) {
      blockers.push({
        code: finding.code,
        message: finding.message,
        remediation: finding.remediation,
        control: controlFor(finding.code),
        where: 'captions',
      });
    }
  }

  return {
    targetId: input.targetId,
    applies,
    inheritsLongNarration: input.inheritsLongNarration,
    exportAttemptReady,
    publicationApproved: false,
    lines: [
      { key: 'source', label: 'Audio source', state: sourceState, ok: sourceOk, detail: sourceDetail },
      { key: 'listening', label: 'Listening approval', state: listeningState, ok: listeningOk, detail: listeningDetail },
      { key: 'rights', label: 'Rights and consent', state: rightsState, ok: rightsOk, detail: rightsDetail },
      { key: 'timing', label: 'Timing', state: timingState, ok: timingOk, detail: timingDetail },
      { key: 'coverage', label: 'Scene coverage', state: coverageState, ok: coverageOk, detail: coverageDetail },
      { key: 'export', label: 'Export attempt', state: exportState, ok: exportAttemptReady ? true : applies || input.inheritsLongNarration ? false : null, detail: exportDetail },
      {
        key: 'publication',
        label: 'Publication',
        state: 'Not publication approved',
        ok: null,
        detail: 'Nothing in this check clears the video for publication. A render, if one is made later, is still not a rights clearance.',
      },
    ],
    blockers,
  };
}

export async function externalNarrationTargetView(
  project: Project,
  target: TargetId,
  state: VoiceAudioPersistedState,
  audioSha256: string | null,
  audioDurationSec: number | null,
): Promise<ExternalNarrationTargetView> {
  const record = state.externalNarration?.imports?.[target] ?? null;
  const approval = state.externalNarration?.approvals?.[target] ?? null;
  const absPath = targetAudioAbsPath(project, target);
  /* Alignment is read LIVE from the narration that is on disk right now, so a
   * per-scene timing file placed next to it is honoured (and changes the timing
   * revision, which invalidates a stale approval until it is reviewed again).
   * The import record keeps the alignment observed at import time. */
  const alignment = absAlignment(project, target, record);
  const timelineDurationSec = timelineDurationOf(project, target);
  const endCardSeconds = END_CARD_SECONDS[target];
  const durationSec = audioDurationSec ?? record?.durationSec ?? null;

  const timingRevision = externalNarrationTimingRevision({
    projectId: project.meta.input.videoId,
    targetId: target,
    artifactSha256: audioSha256 ?? record?.sha256 ?? '',
    scriptSha256: record?.scriptSha256 ?? '',
    audioDurationSec: durationSec ?? 0,
    alignment:
      alignment ?? {
        mode: 'none',
        verified: false,
        sceneCount: null,
        detail: 'No imported narration for this target.',
      },
    timelineDurationSec,
    endCardSeconds,
  });

  const timingApproval = state.externalNarration?.timingApprovals?.[target] ?? null;
  const speech = record ? speechSnapshot(project, target, audioSha256 ?? record.sha256, record.scriptSha256, durationSec ?? 0) : null;
  const speechTimingRevision = speech ? externalNarrationSpeechTimingRevision(speech.snapshot) : null;
  const timingGate = record && speech
    ? evaluateExternalTimingApproval({
        projectId: project.meta.input.videoId,
        targetId: target,
        artifactSha256: audioSha256 ?? record.sha256,
        scriptSha256: record.scriptSha256,
        speechTimingRevision: speechTimingRevision ?? '',
        approval: timingApproval,
      })
    : null;
  /* Listening approval is compared with its own stored revision so a caption
   * or scene edit does not revoke ownership consent or the listening record.
   * Coverage of the measured audio is still checked against the live timeline. */
  const readiness = evaluateExternalNarrationReadiness({
    projectId: project.meta.input.videoId,
    targetId: target,
    import: record,
    currentArtifactSha256: audioSha256,
    approval,
    currentSpeakerId: currentSpeakerId(state),
    timing: {
      targetId: target,
      audioDurationSec: durationSec,
      timelineDurationSec,
      endCardSeconds,
      approvedTimingRevision: approval?.timingRevision ?? null,
      currentTimingRevision: approval?.timingRevision ?? timingRevision,
      alignment,
    },
    extraFindings: timingGate?.findings ?? [],
    currentIntendedSpokenSha256: intendedSpokenSha256Of(project, target),
  });
  const validationAllowed = speech ? validateSpeechTiming(speech.validationInput).allowed : true;
  const timingReview = record
    ? describeTimingReview({
        alignment,
        approval: timingApproval,
        validationAllowed,
        approvalAllowed: timingGate?.allowed === true,
      })
    : null;
  const ownRef = storedNarrationRef(project, target);
  const longRef = storedNarrationRef(project, 'long');
  const inheritsLongNarration = target !== 'long' && !!ownRef && !!longRef && ownRef === longRef;
  const projected = projectExternalNarrationReadiness({
    targetId: target,
    label: targetLabel(target),
    import: record,
    approval,
    ready: readiness.ready,
    findings: readiness.findings,
    audioDurationSec: durationSec,
    timelineDurationSec,
    timingReview,
    activeFileName: safeBaseName(ownRef),
    inheritsLongNarration,
  });

  return {
    targetId: target,
    label: targetLabel(target),
    import: record,
    approval,
    timingApproval,
    ready: readiness.ready,
    summary: readiness.summary,
    blockReasons: readiness.blockReasons,
    findings: readiness.findings,
    alignment,
    audioDurationSec: durationSec,
    timelineDurationSec,
    endCardSeconds,
    timingRevision,
    speechTimingRevision,
    timingReview,
    readiness: projected,
  };
}

/** Every target a project can have narration for. */
export function allTargetIds(project: Project): TargetId[] {
  return ['long', ...(project.storyboard.shorts ?? []).map((s) => s.id)];
}

/** Attach the imported narration to the project through the existing store. */
function commitNarration(project: Project, target: TargetId, upload: AcceptedNarrationUpload): Project | null {
  const next = structuredClone(project);
  if (target === 'long') {
    next.meta.input.voiceoverFile = upload.relativeRef;
  } else {
    next.meta.input.targetAudio = {
      ...(next.meta.input.targetAudio ?? {}),
      [target]: upload.relativeRef,
    };
  }
  next.meta.updatedAt = new Date().toISOString();
  try {
    saveProject(next);
    return next;
  } catch {
    return null;
  }
}

const NARRATION_MEDIA_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
};

function narrationRangeHeader(req: FastifyRequest): string | undefined {
  const value = req.headers.range;
  if (Array.isArray(value)) return value.join(',');
  return value;
}

/**
 * Stream a narration file for listening. Never leaks a path in an error.
 *
 * A player seek sends Range. Answering that with the whole file and no
 * Content-Range makes the browser restart at the beginning.
 */
async function streamNarration(file: string, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  let size = 0;
  try {
    const info = fs.statSync(file);
    if (!info.isFile()) return reply.code(404).send(JSON_ERROR('The imported narration file is not readable.'));
    size = info.size;
  } catch {
    return reply.code(404).send(JSON_ERROR('The imported narration file is not readable.'));
  }
  const ext = path.extname(file).toLowerCase();
  const type = NARRATION_MEDIA_TYPES[ext] ?? 'application/octet-stream';
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', 'no-cache');

  const plan = parseSingleByteRange(narrationRangeHeader(req), size);
  if (plan.kind === 'unsatisfiable') {
    reply.header('Content-Range', unsatisfiableRangeHeader(size));
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return reply.code(416).send({
      error: 'The requested byte range cannot be satisfied.',
      code: 'RANGE_NOT_SATISFIABLE',
    });
  }
  reply.header('Content-Type', type);
  if (plan.kind === 'partial') {
    const length = plan.end - plan.start + 1;
    reply.header('Content-Range', contentRangeHeader(plan.start, plan.end, size));
    reply.header('Content-Length', length);
    return reply.code(206).send(fs.createReadStream(file, { start: plan.start, end: plan.end }));
  }
  reply.header('Content-Length', size);
  return reply.code(200).send(fs.createReadStream(file));
}

/** The editable timing review of one target: per scene, with honest labels. */
async function timingReview(project: Project, target: TargetId, state: VoiceAudioPersistedState) {
  const record = state.externalNarration?.imports?.[target] ?? null;
  const approval = state.externalNarration?.approvals?.[target] ?? null;
  const abs = targetAudioAbsPath(project, target);
  const scenes = scenesOf(project, target);
  const alignment = absAlignment(project, target, record);

  const view = await externalNarrationTargetView(
    project,
    target,
    state,
    digestOfFile(abs),
    await measuredDuration(abs),
  );

  const captions = captionsOf(project, target);
  const source = view.timingReview?.source ?? 'estimated';
  return {
    targetId: target,
    label: targetLabel(target),
    audioDurationSec: view.audioDurationSec,
    timelineDurationSec: view.timelineDurationSec,
    endCardSeconds: view.endCardSeconds,
    timingRevision: view.timingRevision,
    speechTimingRevision: view.speechTimingRevision,
    approvedTimingRevision: approval?.timingRevision ?? null,
    alignment,
    timingReview: view.timingReview,
    timingApproval: view.timingApproval,
    /** Structural script match only. Never acoustic verification. */
    alignmentVerified: alignment?.verified === true,
    acousticVerification: false as const,
    scenes: scenes.map((scene, index) => ({
      sceneId: scene.id,
      index,
      role: scene.role,
      startTime: Number((scene.startTime ?? 0).toFixed(3)),
      durationSec: Number((scene.duration ?? 0).toFixed(3)),
      narration: scene.narration ?? '',
      timingSource: alignment?.verified === true ? ('exact' as const) : ('estimated' as const),
    })),
    captions: captions.map((cue) => ({
      cueId: cue.id,
      sceneId: cue.sceneId,
      start: Number(cue.start.toFixed(3)),
      end: Number(cue.end.toFixed(3)),
      text: cue.text,
      timingSource: alignment?.verified === true ? ('exact' as const) : ('estimated' as const),
    })),
    findings: view.findings,
    blockReasons: view.blockReasons,
  };
}

/**
 * Per-turn dialogue coverage against the turns the scenario actually has.
 * A combined track never becomes verified per-speaker audio.
 */
function dialogueCoverage(project: Project, state: VoiceAudioPersistedState) {
  const expectations: ExternalDialogueTurnExpectation[] = [];
  for (const short of project.storyboard.shorts ?? []) {
    for (const scene of short.scenes ?? []) {
      const turns = (scene as unknown as { turns?: { id?: string; speakerId?: string; text?: string }[] }).turns;
      if (Array.isArray(turns)) {
        for (const turn of turns) {
          if (turn?.id && turn?.speakerId && turn?.text) {
            expectations.push({ sceneId: scene.id, turnId: turn.id, speakerId: turn.speakerId, spokenText: turn.text });
          }
        }
      }
    }
  }
  return evaluateExternalDialogueCoverage(expectations, state.externalNarration?.dialogueImports ?? []);
}


/**
 * Stream one dialogue clip part straight to its final path with the shared
 * byte limit. Returns the staged byte count, or the refusal to report.
 */
async function stageDialogueClip(
  part: any,
  clipAbsPath: string,
): Promise<{ byteSize: number } | { error: { status: number; error: string } }> {
  const limit = maxAudioUploadBytes();
  let bytes = 0;
  const writeStream = fs.createWriteStream(clipAbsPath);
  try {
    await pipeline(
      part.file,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > limit) {
            throw Object.assign(new Error('Upload limit exceeded'), { code: 'LIMIT_EXCEEDED' });
          }
          yield chunk;
        }
      },
      writeStream,
    );
  } catch (err: any) {
    writeStream.destroy();
    try { await finished(writeStream); } catch { /* the original error is authoritative */ }
    try { fs.rmSync(clipAbsPath, { force: true }); } catch { /* best effort */ }
    if (err.code === 'LIMIT_EXCEEDED') {
      return {
        error: {
          status: 413,
          error: `Dialogue clip exceeds the maximum allowed size of ${formatAudioByteLimit(limit)}.`,
        },
      };
    }
    return { error: { status: 400, error: 'The dialogue clip could not be stored.' } };
  }
  if (bytes === 0) {
    try { fs.rmSync(clipAbsPath, { force: true }); } catch { /* best effort */ }
    return { error: { status: 400, error: 'The uploaded dialogue clip is empty.' } };
  }
  return { byteSize: bytes };
}


/** True when the caller must stop: the id is not a plain project identifier. */
function rejectUnsafeProjectId(id: string, reply: FastifyReply): boolean {
  if (isSafeVideoId(id)) return false;
  reply.code(400).send(JSON_ERROR('Invalid project id.'));
  return true;
}

/** Remove a staged narration temp file. Never throws, never reports a path. */
function discardStaged(staged: { tempPath: string } | null): void {
  if (!staged?.tempPath) return;
  try { fs.rmSync(staged.tempPath, { force: true }); } catch { /* best effort */ }
}

/**
 * A new per-turn clip inside the EXISTING production dialogue root.
 * Refuses an unsafe id, a path that leaves `.production`, and any symlink
 * already on the way there. The stored ref stays the repo-relative contract
 * path `productionAudioBasePaths()` already owns.
 */
function containedDialogueClip(videoId: string, clipId: string): { absPath: string; storedRef: string } | null {
  if (!isSafeVideoId(videoId) || !/^ext_[a-f0-9]{16}$/.test(clipId)) return null;
  const { synthesisBasePath } = productionAudioBasePaths(videoId);
  const storedRef = `${synthesisBasePath}/${clipId}.wav`;
  const root = path.resolve(process.cwd(), '.production');
  const absPath = path.resolve(process.cwd(), storedRef);
  const rel = path.relative(root, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let cursor = path.resolve(process.cwd());
  for (const part of path.relative(cursor, absPath).split(path.sep)) {
    if (!part || part === '.') continue;
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    } catch {
      break;
    }
  }
  return { absPath, storedRef };
}

export function registerExternalNarrationRoutes(app: FastifyInstance) {
  /* ---------------- import (multipart: file + declaration) --------------- */

  app.post(
    '/api/projects/:id/target-audio/:target/external',
    async (req: FastifyRequest<{ Params: { id: string; target: string } }>, reply: FastifyReply) => {
      const { id, target } = req.params;
      if (rejectUnsafeProjectId(id, reply)) return;
      if (!isValidTargetId(target)) {
        return reply.code(400).send(JSON_ERROR(`Invalid target ID "${target}".`));
      }
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
      if (!isTargetInProject(project, target)) {
        return reply.code(400).send(JSON_ERROR(`Target "${target}" is not present in this project's storyboard.`));
      }

      /* The file part is drained AS IT IS READ: holding an unconsumed part
       * while asking for the next one stalls the request. */
      const parts = (req as any).parts();
      let staged: { tempPath: string; bytesWritten: number } | null = null;
      let originalFilename = 'narration.wav';
      let mimeType = '';
      const fields: Record<string, unknown> = {};
      let stageError: { status: number; error: string } | null = null;
      for await (const part of parts) {
        if (part.type === 'file') {
          originalFilename = String(part.filename ?? originalFilename);
          mimeType = String(part.mimetype ?? '');
          const typeCheck = validateNarrationFileType(originalFilename, mimeType);
          if (!typeCheck.ok) {
            await drainPart(part);
            stageError = { status: typeCheck.status, error: typeCheck.error };
            break;
          }
          const stagedResult = await stageNarrationPart(part, typeCheck.ext);
          if ('error' in stagedResult) {
            stageError = { status: stagedResult.error.status, error: stagedResult.error.error };
            break;
          }
          staged = stagedResult.staged;
        } else if (part.type === 'field' && typeof part.fieldname === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
      if (stageError) {
        discardStaged(staged);
        return reply.code(stageError.status).send(JSON_ERROR(stageError.error));
      }
      if (!staged) {
        return reply.code(400).send(JSON_ERROR('No narration file was uploaded.'));
      }

      const scriptText = cleanText(fields.scriptText, 20000);
      if (!scriptText) {
        discardStaged(staged);
        return reply.code(400).send(
          JSON_ERROR('Enter the exact spoken script of this narration before importing it.'),
        );
      }

      const { declaration, error } = readDeclaration(fields);
      if (!declaration) {
        discardStaged(staged);
        return reply.code(400).send(JSON_ERROR(error ?? 'The source declaration is incomplete.'));
      }

      /* ONE upload system: the same real decoding, measuring and staging the
       * ordinary narration upload uses. */
      const accepted = await acceptStagedNarration(project, target, staged, originalFilename, mimeType);
      if (!accepted.ok) {
        return reply.code(accepted.status).send(JSON_ERROR(accepted.error));
      }

      const record: ExternalNarrationImport = {
        importId: newImportId(),
        projectId: id,
        targetId: target,
        fileName: accepted.upload.fileName,
        storedRef: accepted.upload.relativeRef,
        mimeType: accepted.upload.mimeType,
        byteSize: accepted.upload.byteSize,
        sha256: accepted.upload.sha256,
        durationSec: accepted.upload.durationSec,
        durationSource: 'ffprobe',
        scriptText,
        scriptSha256: externalNarrationScriptSha256(scriptText),
        declaration,
        alignment: externalNarrationAlignment(readSceneTiming(accepted.upload.absPath), scenesOf(project, target)),
        createdAt: new Date().toISOString(),
      };

      const savedProject = commitNarration(project, target, accepted.upload);
      if (!savedProject) {
        try { fs.rmSync(accepted.upload.absPath, { force: true }); } catch { /* best effort */ }
        return reply.code(500).send(JSON_ERROR('Failed to attach the imported narration to this project.'));
      }

      const nextState = loadVoiceAudioState(id);
      const approvals = { ...(nextState.externalNarration?.approvals ?? {}) };
      const timingApprovals = { ...(nextState.externalNarration?.timingApprovals ?? {}) };
      // A new import invalidates the previous listening approval AND timing approval of THIS target only.
      delete approvals[target];
      delete timingApprovals[target];
      keepExternal(nextState, {
        imports: { ...(nextState.externalNarration?.imports ?? {}), [target]: record },
        approvals,
        timingApprovals,
        dialogueImports: nextState.externalNarration?.dialogueImports ?? [],
      });
      saveVoiceAudioState(nextState);

      const view = await externalNarrationTargetView(
        savedProject,
        target,
        nextState,
        accepted.upload.sha256,
        accepted.upload.durationSec,
      );
      return reply.code(201).send({
        ok: true,
        import: record,
        view,
        message:
          'Imported. Regenerate the storyboard so scenes and captions follow the measured duration, then listen and approve.',
      });
    },
  );

  /* ---------------- listening (project-scoped, read-only) --------------- */

  app.get(
    '/api/projects/:id/target-audio/:target/external/audio',
    async (req: FastifyRequest<{ Params: { id: string; target: string } }>, reply: FastifyReply) => {
      const { id, target } = req.params;
      if (rejectUnsafeProjectId(id, reply)) return;
      if (!isValidTargetId(target)) {
        return reply.code(400).send(JSON_ERROR(`Invalid target ID "${target}".`));
      }
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
      const state = loadVoiceAudioState(id);
      if (!state.externalNarration?.imports?.[target]) {
        return reply.code(404).send(JSON_ERROR('No imported narration for this target.'));
      }
      const abs = targetAudioAbsPath(project, target);
      if (!abs) {
        return reply.code(404).send(JSON_ERROR('The imported narration file is not readable.'));
      }
      return streamNarration(abs, req, reply);
    },
  );

  /* ---------------- approve / reject the exact bytes -------------------- */

  app.post(
    '/api/projects/:id/target-audio/:target/external/approval',
    async (req: FastifyRequest<{ Params: { id: string; target: string } }>, reply: FastifyReply) => {
      const { id, target } = req.params;
      if (rejectUnsafeProjectId(id, reply)) return;
      if (!isValidTargetId(target)) {
        return reply.code(400).send(JSON_ERROR(`Invalid target ID "${target}".`));
      }
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));

      const body = (req.body ?? {}) as Record<string, unknown>;
      const decision = cleanText(body.decision, 20);
      if (decision !== 'approved' && decision !== 'rejected') {
        return reply.code(400).send(JSON_ERROR('The approval decision must be "approved" or "rejected".'));
      }
      const listened = body.listened === true;
      if (decision === 'approved' && !listened) {
        return reply.code(400).send(
          JSON_ERROR('Listen to the whole imported file, then approve it with the listening confirmation.'),
        );
      }
      const state = loadVoiceAudioState(id);
      const record = state.externalNarration?.imports?.[target];
      if (!record) {
        return reply.code(409).send(JSON_ERROR('Import the narration for this target before approving it.'));
      }
      const abs = targetAudioAbsPath(project, target);
      const audioSha256 = digestOfFile(abs);
      if (!audioSha256) {
        return reply.code(409).send(JSON_ERROR('The imported narration file is not readable on disk.'));
      }
      const view = await externalNarrationTargetView(
        project,
        target,
        state,
        audioSha256,
        await measuredDuration(abs),
      );

      const approval: ExternalNarrationApproval = {
        decision,
        importId: record.importId,
        projectId: id,
        targetId: target,
        artifactSha256: audioSha256,
        scriptSha256: record.scriptSha256,
        intendedSpokenSha256: intendedSpokenSha256Of(project, target),
        speakerId: record.declaration.speakerId ?? record.declaration.speakerName,
        timingRevision: view.timingRevision,
        listened,
        decidedAt: new Date().toISOString(),
        decidedBy: cleanText(body.decidedBy, 120) || 'project-owner',
        note: cleanOptionalText(body.note, 600) ?? undefined,
      };

      keepExternal(state, {
        approvals: { ...(state.externalNarration?.approvals ?? {}), [target]: approval },
      });
      saveVoiceAudioState(state);

      const nextView = await externalNarrationTargetView(
        project,
        target,
        state,
        audioSha256,
        view.audioDurationSec,
      );
      return reply.code(200).send({ ok: true, approval, view: nextView });
    },
  );

  /* ---------------- per-target record + timing review ------------------- */

  app.get(
    '/api/projects/:id/target-audio/:target/external',
    async (req: FastifyRequest<{ Params: { id: string; target: string } }>, reply: FastifyReply) => {
      const { id, target } = req.params;
      if (rejectUnsafeProjectId(id, reply)) return;
      if (!isValidTargetId(target)) {
        return reply.code(400).send(JSON_ERROR(`Invalid target ID "${target}".`));
      }
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
      const state = loadVoiceAudioState(id);
      if (!state.externalNarration?.imports?.[target]) {
        return reply.code(404).send(JSON_ERROR('No imported narration for this target.'));
      }
      return {
        targetId: target,
        view: await externalNarrationTargetView(
          project,
          target,
          state,
          digestOfFile(targetAudioAbsPath(project, target)),
          await measuredDuration(targetAudioAbsPath(project, target)),
        ),
        timing: await timingReview(project, target, state),
      };
    },
  );

  /* ---------------- editable timing review ------------------------------ */

  app.get(
    '/api/projects/:id/external-narration/timing/:target',
    async (req: FastifyRequest<{ Params: { id: string; target: string } }>, reply: FastifyReply) => {
      const { id, target } = req.params;
      if (rejectUnsafeProjectId(id, reply)) return;
      if (!isValidTargetId(target)) {
        return reply.code(400).send(JSON_ERROR(`Invalid target ID "${target}".`));
      }
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
      const state = loadVoiceAudioState(id);
      if (!state.externalNarration?.imports?.[target]) {
        return reply.code(404).send(JSON_ERROR('No imported narration for this target.'));
      }
      return { targetId: target, timing: await timingReview(project, target, state) };
    },
  );

  async function timingContext(id: string, target: string, reply: FastifyReply) {
    if (rejectUnsafeProjectId(id, reply)) return null;
    if (!isValidTargetId(target)) {
      reply.code(400).send(JSON_ERROR(`Invalid target ID "${target}".`));
      return null;
    }
    const project = loadProject(id);
    if (!project) {
      reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
      return null;
    }
    const state = loadVoiceAudioState(id);
    const record = state.externalNarration?.imports?.[target] ?? null;
    if (!record) {
      reply.code(404).send(JSON_ERROR('No imported narration for this target.'));
      return null;
    }
    const abs = targetAudioAbsPath(project, target);
    return {
      project,
      state,
      record,
      target,
      abs,
      audioSha256: digestOfFile(abs),
      audioDurationSec: await measuredDuration(abs),
    };
  }

  app.post(
    '/api/projects/:id/external-narration/timing/:target/validate',
    async (req: FastifyRequest<{ Params: { id: string; target: string } }>, reply: FastifyReply) => {
      const loaded = await timingContext(req.params.id, req.params.target, reply);
      if (!loaded) return;
      const proposed = proposedSpeech(
        loaded.project,
        loaded.target,
        loaded.audioSha256 ?? loaded.record.sha256,
        loaded.record.scriptSha256,
        loaded.audioDurationSec ?? loaded.record.durationSec,
        (req.body ?? {}) as { scenes?: unknown; captions?: unknown },
      );
      const validation = validateSpeechTiming(proposed.validationInput);
      const issues = [...proposed.textErrors, ...validation.issues];
      const blocking = issues.filter((item) => item.severity === 'error');
      return { allowed: blocking.length === 0, issues, blocking };
    },
  );

  app.put(
    '/api/projects/:id/external-narration/timing/:target',
    async (req: FastifyRequest<{ Params: { id: string; target: string } }>, reply: FastifyReply) => {
      const loaded = await timingContext(req.params.id, req.params.target, reply);
      if (!loaded) return;
      const { target } = loaded;
      const proposed = proposedSpeech(
        loaded.project,
        target,
        loaded.audioSha256 ?? loaded.record.sha256,
        loaded.record.scriptSha256,
        loaded.audioDurationSec ?? loaded.record.durationSec,
        (req.body ?? {}) as { scenes?: unknown; captions?: unknown },
      );
      const validation = validateSpeechTiming(proposed.validationInput);
      const issues = [...proposed.textErrors, ...validation.issues];
      const blocking = issues.filter((item) => item.severity === 'error');
      if (blocking.length > 0) {
        return reply.code(400).send({
          error: blocking[0].message,
          issues,
          blocking,
        });
      }
      applySpeechTiming(loaded.project, target, proposed.snapshot);
      saveProject(loaded.project);
      const fresh = loadProject(loaded.project.meta.input.videoId);
      if (!fresh) return reply.code(500).send(JSON_ERROR('The timing could not be saved.'));
      return {
        ok: true,
        timing: await timingReview(fresh, target, loadVoiceAudioState(loaded.project.meta.input.videoId)),
      };
    },
  );

  app.post(
    '/api/projects/:id/external-narration/timing/:target/approval',
    async (req: FastifyRequest<{ Params: { id: string; target: string } }>, reply: FastifyReply) => {
      const loaded = await timingContext(req.params.id, req.params.target, reply);
      if (!loaded) return;
      const { target } = loaded;
      const id = loaded.project.meta.input.videoId;
      const body = (req.body ?? {}) as { decision?: unknown; reviewed?: unknown; decidedBy?: unknown; note?: unknown };
      const decision = body.decision === 'rejected' ? 'rejected' : body.decision === 'approved' ? 'approved' : null;
      if (!decision) {
        return reply.code(400).send(JSON_ERROR('Choose approved or rejected for this timing revision.'));
      }
      const reviewed = body.reviewed === true;
      if (decision === 'approved' && !reviewed) {
        return reply.code(400).send(JSON_ERROR('Review the times against the audio before approving this timing.'));
      }
      const view = await externalNarrationTargetView(
        loaded.project,
        target,
        loaded.state,
        loaded.audioSha256,
        loaded.audioDurationSec,
      );
      const listeningBlocked = view.findings.some((item) => item.code.startsWith('IMPORT-') && item.severity === 'error');
      if (listeningBlocked) {
        return reply.code(409).send({
          error: view.blockReasons.find((reason) => !reason.toLowerCase().includes('timing has not been approved')) ?? view.blockReasons[0] ?? 'Approve the narration before approving its timing.',
          blockReasons: view.blockReasons,
        });
      }
      const current = speechSnapshot(
        loaded.project,
        target,
        loaded.audioSha256 ?? loaded.record.sha256,
        loaded.record.scriptSha256,
        loaded.audioDurationSec ?? loaded.record.durationSec,
      );
      const validation = validateSpeechTiming(current.validationInput);
      if (!validation.allowed) {
        return reply.code(409).send({
          error: validation.blocking[0]?.message ?? 'The current timing is not valid.',
          issues: validation.issues,
          blocking: validation.blocking,
        });
      }
      const timingApproval: ExternalNarrationTimingApproval = {
        decision,
        projectId: id,
        targetId: target,
        artifactSha256: loaded.audioSha256 ?? loaded.record.sha256,
        scriptSha256: loaded.record.scriptSha256,
        speechTimingRevision: externalNarrationSpeechTimingRevision(current.snapshot),
        reviewed,
        decidedAt: new Date().toISOString(),
        decidedBy: cleanText(body.decidedBy, 120) || 'project-owner',
        note: cleanOptionalText(body.note, 600) ?? undefined,
      };
      const timingApprovals = { ...(loaded.state.externalNarration?.timingApprovals ?? {}), [target]: timingApproval };
      keepExternal(loaded.state, { timingApprovals });
      saveVoiceAudioState(loaded.state);
      const nextView = await externalNarrationTargetView(
        loaded.project,
        target,
        loaded.state,
        loaded.audioSha256,
        loaded.audioDurationSec,
      );
      return reply.code(200).send({
        ok: true,
        timingApproval,
        view: nextView,
        timing: await timingReview(loaded.project, target, loaded.state),
      });
    },
  );

  /* ---------------- project-wide readiness ------------------------------ */

  app.get('/api/projects/:id/external-narration', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (rejectUnsafeProjectId(id, reply)) return;
    const project = loadProject(id);
    if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
    const state = loadVoiceAudioState(id);
    const views: ExternalNarrationTargetView[] = [];
    for (const target of allTargetIds(project)) {
      const abs = targetAudioAbsPath(project, target);
      views.push(
        await externalNarrationTargetView(project, target, state, digestOfFile(abs), await measuredDuration(abs)),
      );
    }
    const imported = views.filter((v) => v.import !== null);
    return {
      projectId: id,
      totalTargets: views.length,
      importedCount: imported.length,
      readyCount: imported.filter((v) => v.ready).length,
      blockedCount: imported.filter((v) => !v.ready).length,
      targets: views,
    };
  });

  /* ---------------- per-turn dialogue imports --------------------------- */

  app.post(
    '/api/projects/:id/external-narration/dialogue-turns',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      if (rejectUnsafeProjectId(id, reply)) return;
      const project = loadProject(id);
      if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));

      /* The clip is written to its final location AS IT IS READ (draining the
       * part immediately keeps the form from stalling), under the same byte
       * limit every other narration upload uses. If the turn identity turns out
       * to be incomplete, the staged file is removed again. */
      const clipId = `ext_${randomBytes(8).toString('hex')}`;
      const clip = containedDialogueClip(id, clipId);
      if (!clip) {
        return reply.code(400).send(JSON_ERROR('The dialogue clip could not be stored.'));
      }
      const clipAbsPath = clip.absPath;
      fs.mkdirSync(path.dirname(clipAbsPath), { recursive: true });

      const parts = (req as any).parts();
      let stagedClip: { byteSize: number } | null = null;
      const fields: Record<string, unknown> = {};
      let stageError: { status: number; error: string } | null = null;
      for await (const part of parts) {
        if (part.type === 'file') {
          const staged = await stageDialogueClip(part, clipAbsPath);
          if ('error' in staged) {
            stageError = { status: staged.error.status, error: staged.error.error };
            break;
          }
          stagedClip = staged;
        } else if (part.type === 'field' && typeof part.fieldname === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
      if (stageError) {
        try { fs.rmSync(clipAbsPath, { force: true }); } catch { /* best effort */ }
        return reply.code(stageError.status).send(JSON_ERROR(stageError.error));
      }
      if (!stagedClip) {
        return reply.code(400).send(JSON_ERROR('No dialogue clip was uploaded.'));
      }

      const sceneId = cleanText(fields.sceneId, 80);
      const turnId = cleanText(fields.turnId, 80);
      const speakerId = cleanText(fields.speakerId, 80);
      const speakerName = cleanText(fields.speakerName, 120);
      const spokenText = cleanText(fields.spokenText, 8000);
      const combinedTrack = fields.combinedTrack === 'true' || fields.combinedTrack === true;
      if (!sceneId || !turnId || !speakerId || !spokenText) {
        try { fs.rmSync(clipAbsPath, { force: true }); } catch { /* best effort */ }
        return reply.code(400).send(
          JSON_ERROR(
            'A dialogue clip import needs sceneId, turnId, speakerId and the exact spoken text of that turn.',
          ),
        );
      }

      /* The clip already sits in the EXISTING per-turn dialogue audio root, so
       * the existing canonical-dialogue and production contracts own it. */
      const clipDuration = await measuredDuration(clipAbsPath);
      if (clipDuration === null) {
        try { fs.rmSync(clipAbsPath, { force: true }); } catch { /* best effort */ }
        return reply.code(400).send(JSON_ERROR('The dialogue clip has no measurable duration.'));
      }

      const record: ExternalDialogueTurnImport = {
        importId: clipId,
        projectId: id,
        scenarioId: cleanText(fields.scenarioId, 80) || id,
        sceneId,
        turnId,
        speakerId,
        speakerName: speakerName || speakerId,
        spokenText,
        spokenTextSha256: externalNarrationScriptSha256(spokenText),
        storedRef: clip.storedRef,
        sha256: digestOfFile(clipAbsPath) ?? '',
        durationSec: clipDuration,
        combinedTrack,
        engineName: cleanOptionalText(fields.engineName, 120),
        modelName: cleanOptionalText(fields.modelName, 120),
        voiceName: cleanOptionalText(fields.voiceName, 120),
        createdAt: new Date().toISOString(),
      };

      const state = loadVoiceAudioState(id);
      const dialogueImports = [
        ...(state.externalNarration?.dialogueImports ?? []).filter(
          (clip) => !(clip.sceneId === sceneId && clip.turnId === turnId),
        ),
        record,
      ];
      keepExternal(state, { dialogueImports });
      saveVoiceAudioState(state);

      return reply.code(201).send({ ok: true, import: record, coverage: dialogueCoverage(project, state) });
    },
  );

  app.get('/api/projects/:id/external-narration/dialogue', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (rejectUnsafeProjectId(id, reply)) return;
    const project = loadProject(id);
    if (!project) return reply.code(404).send(JSON_ERROR(`Project not found: ${id}`));
    const state = loadVoiceAudioState(id);
    return dialogueCoverage(project, state);
  });
}
