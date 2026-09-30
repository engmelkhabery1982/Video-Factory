/**
 * BuildTrack Video Factory - Phase 6B Real Production Render Contract
 *
 * The renderer-facing API contract that turns an approved Phase 5
 * `RemotionCompositionPlan` into real media through the existing Remotion
 * infrastructure (`getServeUrl` → `selectComposition('VideoPlan')` →
 * `renderMedia`).
 *
 * Timing authority: the plan. `plan.durationInFrames` is used as-is. It is
 * never recomputed from scene durations, from the Phase 3A estimator, from a
 * legacy storyboard sum or from a probed audio file length.
 *
 * Audio policy: canonical Phase 4 dialogue is embedded in the plan as
 * `scene.audioRefs` and rendered by the `VideoPlan` composition's `<Audio>`
 * elements. The plan render path never mutes, replaces or re-muxes it.
 *
 * Asset policy: `mediaMap` is `Record<logicalAssetRef, renderableUrlOrPath>` -
 * exactly `ProductionAssetResolutionReport.mediaMap` from Phase 6A. It is passed
 * straight through; the renderer never resolves assets itself.
 */

import type { RemotionCompositionPlan } from './remotion-composition-types.js';

export const PLAN_RENDER_VERSION = '1.0.0' as const;

/** The composition the Phase 6B plan renderer selects. Never Long/ShortVideo. */
export const PLAN_RENDER_COMPOSITION_ID = 'VideoPlan' as const;

/**
 * Locked Phase 5C/5D/5E final-frame policy, restated here so the render path can
 * assert it without re-deriving it. Owners: `audiovisual-sync-pipeline.ts`,
 * `phase5-closure-pipeline.ts`, `remotion-composition-pipeline.ts`.
 *
 * 118.74s * 30fps = 3562.2 raw -> structural capacity ceil -> 3563 frames.
 * Valid frame indices 0..3562; 3563 is the exclusive boundary.
 * The Phase 3A estimator's 102s is NOT a render authority.
 */
export const PLAN_RENDER_CANONICAL = {
  fps: 30,
  authoritativeSeconds: 118.74,
  rawFrameValue: 3562.2,
  durationInFrames: 3563,
  lastValidFrame: 3562,
  estimatorSeconds: 102,
} as const;

/**
 * The exact input props handed to the `VideoPlan` composition.
 * Mirrors `VideoCompositionPlanProps` in `packages/video`.
 */
export interface VideoPlanInputProps {
  plan: RemotionCompositionPlan;
  /** Phase 6A `ProductionAssetResolutionReport.mediaMap`, passed through. */
  mediaMap: Record<string, string>;
  brand?: unknown;
  format?: 'long' | 'short';
  captionStyle?: string;
  burnedCaptions?: boolean;
}

/** Input of `renderCompositionPlan(...)`. */
export interface PlanRenderInput {
  /** The authoritative production plan. */
  plan: RemotionCompositionPlan;
  /** Output file path. Must end in `.mp4`. */
  outputFile: string;
  /**
   * Optional Phase 6A mediaMap override. When omitted the renderer has no media
   * to show, which is a legitimate "unresolved optional media" case.
   */
  mediaMap?: Record<string, string>;
  brand?: unknown;
  format?: 'long' | 'short';
  captionStyle?: string;
  burnedCaptions?: boolean;
  /**
   * Optional inclusive frame sub-range `[firstFrame, lastFrame]` for a short
   * real render. This encodes fewer frames; it never changes the plan.
   */
  frameRange?: [number, number] | null;
  quality?: 'preview' | 'final';
  onProgress?: (progress: number, note?: string) => void;
}

/** Result of `renderCompositionPlan(...)`. */
export interface PlanRenderResult {
  /** Absolute path of the produced media. */
  outputFile: string;
  /** Composition id used. Always `VideoPlan`. */
  compositionId: string;
  scenarioId: string;
  projectId: string;
  fps: number;
  width: number;
  height: number;
  /** The plan's authoritative duration (exclusive boundary). */
  durationInFrames: number;
  /** Frames this call actually encoded (a sub-range render is shorter). */
  renderedFrameCount: number;
  /** `plan.totalActualDurationSeconds` - never the estimator value. */
  authoritativeDurationSeconds: number;
  /** True when the encoded file carries an audio stream. */
  renderedWithAudio: boolean;
  /** Number of entries in the mediaMap handed to the composition. */
  mediaMapEntryCount: number;
  renderTimeMs: number;
}

export type PlanRenderErrorCode =
  | 'PLAN_RENDER_INVALID_INPUT'
  | 'PLAN_RENDER_INVALID_PLAN'
  | 'PLAN_RENDER_COMPOSITION_NOT_FOUND'
  | 'PLAN_RENDER_FAILED'
  | 'PLAN_RENDER_OUTPUT_MISSING'
  | 'PLAN_RENDER_AUDIO_MISSING'
  | 'PLAN_RENDER_MEDIA_NOT_VISIBLE'
  | 'PLAN_RENDER_TIMING_MISMATCH'
  | 'PLAN_RENDER_INVALID_FRAME_COUNT';

/**
 * Small structured error for the plan render path. Deliberately not a parallel
 * framework: it carries a stable code plus optional details.
 */
export class PlanRenderError extends Error {
  public readonly code: PlanRenderErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: PlanRenderErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PlanRenderError';
    this.code = code;
    this.details = details;
  }
}

/** Structural finding produced by `validatePlanForRender`. */
export interface PlanRenderFinding {
  severity: 'error' | 'warning';
  code: PlanRenderErrorCode;
  message: string;
  sceneId?: string;
}
