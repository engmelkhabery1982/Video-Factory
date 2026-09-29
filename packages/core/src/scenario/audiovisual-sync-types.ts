/**
 * BuildTrack Video Factory - Phase 5D Audiovisual Sync Contract
 *
 * Deterministic validation/report contract for E2E synchronization:
 * Scenario → DialogueProductionResult → VisualProductionPlan → SceneRenderPlan → RemotionCompositionPlan
 *
 * Timing policy (approved, from baseline 056e6b3):
 * - FPS = 30 exact
 * - Authoritative domain = seconds from Phase 4 reconciled timing, never replaced by frame-derived seconds
 * - Renderer domain = frames, half-open [start, endExclusive)
 * - Structural boundaries: Math.round(seconds * 30)
 * - Content coverage: start = round(start*30), endExclusive = ceil(end*30) or composition.durationInFrames if final
 * - Canonical fixture: 118.74s → raw 3562.2 → ceil 3563, valid frames 0..3562, 3563 exclusive only, tail 0.026666s = 0.8 frame expected
 * - Authoritative total field: dialogueResult.reconciledDialogue.actualTotalDurationSeconds (Phase 4)
 */

import type { Scenario } from './types.js';
import type { DialogueProductionResult } from './dialogue-production-types.js';
import type { VisualProductionPlan } from './visual-production-types.js';
import type { SceneRenderPlan } from './scene-render-types.js';
import type { RemotionCompositionPlan } from './remotion-composition-types.js';

export const AUDIOVISUAL_SYNC_VERSION = '1.0.0' as const;
export const AUDIOVISUAL_SYNC_FPS = 30 as const;

export type AudiovisualSyncErrorCode =
  | 'MISSING_PHASE_OUTPUT'
  | 'PIPELINE_IDENTITY_MISMATCH'
  | 'SCENE_SYNC_MISMATCH'
  | 'TURN_AUDIO_SYNC_MISMATCH'
  | 'AUDIO_FRAME_SYNC_MISMATCH'
  | 'AUDIO_TIMING_MISMATCH'
  | 'CAPTION_AUDIO_SYNC_MISMATCH'
  | 'CAPTION_FRAME_SYNC_MISMATCH'
  | 'CAPTION_IDENTITY_MISMATCH'
  | 'VISUAL_AUDIO_SYNC_MISMATCH'
  | 'VISUAL_BEAT_SYNC_MISMATCH'
  | 'TRANSITION_SYNC_MISMATCH'
  | 'FINAL_CONTENT_TRUNCATION'
  | 'ORPHAN_AUDIO_REF'
  | 'ORPHAN_CAPTION_REF'
  | 'DUPLICATE_AUDIO_ASSIGNMENT'
  | 'DUPLICATE_CAPTION_ID'
  | 'DUPLICATE_SCENE_ID'
  | 'PRODUCTION_AUDIO_MUTED'
  | 'ESTIMATED_TIMING_REGRESSION'
  | 'BOUNDARY_PROJECTION_ERROR'
  | 'INVALID_FRAME_RANGE'
  | 'COMPOSITION_DURATION_MISMATCH';

export interface AudiovisualSyncFinding {
  severity: 'error' | 'warning';
  code: AudiovisualSyncErrorCode;
  message: string;
  location?: {
    scenarioId?: string;
    projectId?: string;
    sceneId?: string;
    turnId?: string;
    clipId?: string;
    cueId?: string;
    beatId?: string;
    assetRef?: string;
    rendererKey?: string;
    transitionKey?: string;
    speakerId?: string;
    voiceSlot?: string;
  };
  details?: Record<string, unknown>;
}

export interface AudiovisualSyncSummary {
  scenarioId: string;
  projectId: string;
  fps: number;
  authoritativeDurationSeconds: number;
  compositionDurationInFrames: number;
  rawFramePosition: number;
  finalValidFrameIndex: number;
  finalExclusiveBoundary: number;
  finalCapacityTailSeconds: number;
  sceneCount: number;
  turnCount: number;
  audioClipCount: number;
  captionCueCount: number;
  visualBeatCount: number;
  transitionCount: number;
  assetRefCount: number;
  maximumBoundaryProjectionErrorFrames: number;
  warningCount: number;
  errorCount: number;
  status: 'ok' | 'warning' | 'error';
}

export interface AudiovisualSyncReport {
  version: typeof AUDIOVISUAL_SYNC_VERSION;
  scenarioId: string;
  projectId: string;
  fps: number;
  authoritativeDurationSeconds: number;
  compositionDurationInFrames: number;
  summary: AudiovisualSyncSummary;
  findings: AudiovisualSyncFinding[];
  valid: boolean;
}

export type AudiovisualSyncInput = {
  scenario?: Scenario;
  dialogueResult?: DialogueProductionResult;
  visualProductionPlan?: VisualProductionPlan;
  sceneRenderPlan?: SceneRenderPlan;
  remotionCompositionPlan?: RemotionCompositionPlan;
};

export type ValidateAudiovisualSyncResult =
  | { success: true; report: AudiovisualSyncReport }
  | { success: false; error: string; findings: AudiovisualSyncFinding[]; report?: AudiovisualSyncReport };

export class AudiovisualSyncError extends Error {
  public readonly code: AudiovisualSyncErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly findings?: AudiovisualSyncFinding[];

  constructor(code: AudiovisualSyncErrorCode, message: string, details?: Record<string, unknown>, findings?: AudiovisualSyncFinding[]) {
    super(message);
    this.name = 'AudiovisualSyncError';
    this.code = code;
    this.details = details;
    this.findings = findings;
  }
}
