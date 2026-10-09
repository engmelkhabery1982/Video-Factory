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

/** Stream a narration file for listening. Never leaks a path in an error. */
async function streamNarration(file: string, reply: FastifyReply): Promise<unknown> {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return reply.code(404).send(JSON_ERROR('The imported narration file is not readable.'));
  }
  const ext = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
  };
  reply.header('Content-Type', types[ext] ?? 'application/octet-stream');
  reply.header('Cache-Control', 'no-cache');
  return reply.send(fs.createReadStream(file));
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
      return streamNarration(abs, reply);
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
