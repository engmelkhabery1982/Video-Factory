/**
 * BuildTrack Video Factory - Phase 5E Final Closure Contract
 *
 * Deterministic final validation/closure result proving that all approved Phase 5 contracts align.
 *
 * Pipeline:
 * Scenario → DialogueProductionResult → VisualProductionPlan → SceneRenderPlan → RemotionCompositionPlan → AudiovisualSyncReport → Phase5ClosureReport
 *
 * Authority:
 * - authoritative total = dialogueResult.reconciledDialogue.actualTotalDurationSeconds
 * - FPS = 30, canonical 118.74s → raw 3562.2 → 3563 frames, valid 0..3562, 3563 exclusive
 */

import type { Scenario } from './types.js';
import type { DialogueProductionResult } from './dialogue-production-types.js';
import type { VisualProductionPlan } from './visual-production-types.js';
import type { SceneRenderPlan } from './scene-render-types.js';
import type { RemotionCompositionPlan } from './remotion-composition-types.js';
import type { AudiovisualSyncReport } from './audiovisual-sync-types.js';

export const PHASE5_CLOSURE_VERSION = '1.0.0' as const;
export const PHASE5_CLOSURE_FPS = 30 as const;

export type Phase5ClosureErrorCode =
  | 'MISSING_PHASE_OUTPUT'
  | 'PHASE5_CLOSURE_MISSING_OUTPUT'
  | 'PHASE5_CLOSURE_IDENTITY_MISMATCH'
  | 'PHASE5_CLOSURE_PHASE4_INVALID'
  | 'PHASE5_CLOSURE_VISUAL_INVALID'
  | 'PHASE5_CLOSURE_SCENE_RENDER_INVALID'
  | 'PHASE5_CLOSURE_REMOTION_INVALID'
  | 'PHASE5_CLOSURE_SYNC_INVALID'
  | 'PHASE5_CLOSURE_DURATION_MISMATCH'
  | 'PHASE5_CLOSURE_FRAME_POLICY_MISMATCH'
  | 'PHASE5_CLOSURE_COUNT_MISMATCH'
  | 'PHASE5_CLOSURE_RENDERER_INVALID'
  | 'PHASE5_CLOSURE_NON_DETERMINISTIC'
  | 'PHASE5_CLOSURE_ESTIMATED_REGRESSION'
  | 'PHASE5_CLOSURE_FINAL_FRAME_MISMATCH'
  | 'PHASE5_CLOSURE_AUDIO_MISMATCH'
  | 'PHASE5_CLOSURE_CAPTION_MISMATCH'
  | 'PHASE5_CLOSURE_SCENE_MISMATCH';

export interface Phase5ClosureFinding {
  severity: 'error' | 'warning';
  code: Phase5ClosureErrorCode;
  message: string;
  location?: {
    scenarioId?: string;
    projectId?: string;
    sceneId?: string;
    turnId?: string;
    clipId?: string;
    cueId?: string;
    beatId?: string;
    rendererKey?: string;
    assetRef?: string;
  };
  details?: Record<string, unknown>;
}

export interface Phase5ClosureSummary {
  scenarioId: string;
  projectId: string;
  phase4ResultValid: boolean;
  visualProductionValid: boolean;
  sceneRenderValid: boolean;
  remotionCompositionValid: boolean;
  audiovisualSyncValid: boolean;
  fps: number;
  authoritativeDurationSeconds: number;
  compositionDurationInFrames: number;
  rawFramePosition: number;
  finalValidFrameIndex: number;
  finalExclusiveBoundary: number;
  sceneCount: number;
  turnCount: number;
  audioClipCount: number;
  captionCueCount: number;
  visualBeatCount: number;
  assetRefCount: number;
  transitionCount: number;
  rendererKeyCount: number;
  warningCount: number;
  errorCount: number;
  status: 'ok' | 'warning' | 'error';
  closureReady: boolean;
}

export interface Phase5ClosureReport {
  version: typeof PHASE5_CLOSURE_VERSION;
  scenarioId: string;
  projectId: string;
  fps: number;
  authoritativeDurationSeconds: number;
  compositionDurationInFrames: number;
  summary: Phase5ClosureSummary;
  findings: Phase5ClosureFinding[];
  valid: boolean;
  closureReady: boolean;
  // Traceability - counts from approved pipeline
  details?: {
    phase4: {
      sceneCount: number;
      turnCount: number;
      clipCount: number;
      captionCueCount: number;
      totalActualDurationSeconds: number;
      totalEstimatedDurationSeconds?: number;
    };
    visualProduction: {
      sceneCount: number;
      audioClipCount: number;
      captionCueCount: number;
      visualBeatCount: number;
      assetRefCount: number;
    };
    sceneRender: {
      sceneCount: number;
      rendererKeysUsed: string[];
      fallbackCount: number;
    };
    remotionComposition: {
      sceneCount: number;
      fps: number;
      width: number;
      height: number;
      durationInFrames: number;
      totalActualDurationSeconds: number;
    };
    audiovisualSync: {
      valid: boolean;
      status: string;
      maxProjectionErrorFrames: number;
      sceneCount: number;
      turnCount: number;
      audioClipCount: number;
      captionCueCount: number;
      visualBeatCount: number;
    };
  };
}

export type Phase5ClosureInput = {
  scenario?: Scenario;
  dialogueResult?: DialogueProductionResult;
  visualProductionPlan?: VisualProductionPlan;
  sceneRenderPlan?: SceneRenderPlan;
  remotionCompositionPlan?: RemotionCompositionPlan;
  audiovisualSyncReport?: AudiovisualSyncReport;
};

export type ValidatePhase5ClosureResult =
  | { success: true; report: Phase5ClosureReport }
  | { success: false; error: string; findings: Phase5ClosureFinding[]; report?: Phase5ClosureReport };

export class Phase5ClosureError extends Error {
  public readonly code: Phase5ClosureErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly findings?: Phase5ClosureFinding[];

  constructor(code: Phase5ClosureErrorCode, message: string, details?: Record<string, unknown>, findings?: Phase5ClosureFinding[]) {
    super(message);
    this.name = 'Phase5ClosureError';
    this.code = code;
    this.details = details;
    this.findings = findings;
  }
}
