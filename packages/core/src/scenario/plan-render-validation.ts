/**
 * BuildTrack Video Factory - Phase 6B Plan Render Validation
 *
 * Pure, dependency-free checks the plan renderer runs before touching the
 * browser. Kept in Core (next to the plan contract) so the same rules can be
 * asserted by tests, the API service and any future caller without duplicating
 * them.
 *
 * What these rules protect:
 *  - the plan is the timing authority (no estimator / storyboard / audio-length
 *    fallback can ever size the composition);
 *  - the scene timeline tiles the composition exactly, with no gap and no
 *    truncation before the authoritative end;
 *  - canonical audio is not silently muted;
 *  - declared media that resolved must be reachable by the scene's renderer.
 */

import { REMOTION_FPS, type RemotionCompositionPlan, type RemotionSceneCompositionSpec } from './remotion-composition-types.js';
import { PLAN_RENDER_CANONICAL, PlanRenderError, type PlanRenderFinding } from './plan-render-types.js';
import { isDialogueCapableScene, isDialogueEvidenceBeat } from './scene-render-types.js';

/**
 * Renderer keys whose video-package implementation visibly consumes `mediaUrl`.
 *
 * `explanation:key_statement` is on this list because Phase 6B made the approved
 * key-statement presentation incorporate resolved production media when the plan
 * carries it (see packages/video/src/scenes/Explanations.tsx). The list is the
 * contract the canonical visibility test asserts against.
 */
export const MEDIA_CONSUMING_RENDERER_KEYS: ReadonlySet<string> = new Set([
  'explanation:key_statement',
  'explanation:site_footage_callouts',
  'explanation:document_annotation',
  'explanation:dashboard_demo',
  'explanation:chart_animation',
]);

/** Renderer keys that *require* media to make sense; without it they fall back safely. */
export const MEDIA_DEPENDENT_RENDERER_KEYS: ReadonlySet<string> = new Set([
  'explanation:site_footage_callouts',
]);

const finding = (
  severity: PlanRenderFinding['severity'],
  code: PlanRenderFinding['code'],
  message: string,
  sceneId?: string,
): PlanRenderFinding => ({ severity, code, message, ...(sceneId ? { sceneId } : {}) });

/** Frames the plan says it needs, derived from its OWN authoritative seconds. */
export function expectedFramesForPlan(plan: Pick<RemotionCompositionPlan, 'totalActualDurationSeconds' | 'fps'>): number {
  const seconds = Number(plan.totalActualDurationSeconds);
  const fps = Number(plan.fps);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  return Math.ceil(seconds * fps);
}

/** Media URL a scene's renderer will actually be handed, or null. */
export function sceneMediaUrl(
  scene: Pick<RemotionSceneCompositionSpec, 'assetRefs'>,
  mediaMap?: Record<string, string> | null,
): string | null {
  if (!mediaMap) return null;
  for (const ref of scene.assetRefs) {
    const url = mediaMap[ref.assetRef];
    if (typeof url === 'string' && url.trim().length > 0) return url.trim();
  }
  return null;
}

/** Match the actual PlanSceneRenderer route, including dialogue evidence inserts. */
function sceneConsumesMedia(scene: RemotionSceneCompositionSpec): boolean {
  if (isDialogueCapableScene(scene) && scene.rendererCategory !== 'cta') {
    return scene.beats.some((beat) => isDialogueEvidenceBeat(beat));
  }
  return MEDIA_CONSUMING_RENDERER_KEYS.has(scene.rendererKey);
}

/**
 * Structural validation of a plan before it reaches Remotion.
 * `error` findings are fatal for the render path; `warning` findings are not
 * (an unresolved *optional* asset must still render).
 *
 * `mediaMap` is optional. When supplied, a scene whose media RESOLVED must be
 * handled by a renderer that visibly consumes it - otherwise the asset would be
 * silently dropped, which is the Phase 6B defect this rule exists to prevent.
 */
export function validatePlanForRender(plan: unknown, mediaMap?: Record<string, string> | null): PlanRenderFinding[] {
  const out: PlanRenderFinding[] = [];

  if (plan === null || typeof plan !== 'object') {
    return [finding('error', 'PLAN_RENDER_INVALID_INPUT', 'plan must be an object')];
  }
  const p = plan as Partial<RemotionCompositionPlan>;

  if (typeof p.scenarioId !== 'string' || !p.scenarioId.length) {
    out.push(finding('error', 'PLAN_RENDER_INVALID_PLAN', 'plan.scenarioId is required'));
  }
  if (typeof p.projectId !== 'string' || !p.projectId.length) {
    out.push(finding('error', 'PLAN_RENDER_INVALID_PLAN', 'plan.projectId is required'));
  }
  if (!Array.isArray(p.scenes) || p.scenes.length === 0) {
    out.push(finding('error', 'PLAN_RENDER_INVALID_PLAN', 'plan.scenes must be a non-empty array'));
    return out;
  }
  if (!Number.isInteger(p.durationInFrames) || (p.durationInFrames ?? 0) <= 0) {
    out.push(
      finding('error', 'PLAN_RENDER_INVALID_FRAME_COUNT', `plan.durationInFrames must be a positive integer, got ${String(p.durationInFrames)}`),
    );
    return out;
  }
  if (p.fps !== REMOTION_FPS) {
    out.push(finding('error', 'PLAN_RENDER_TIMING_MISMATCH', `plan.fps must be the locked ${REMOTION_FPS}, got ${String(p.fps)}`));
  }
  if (!(Number(p.width) > 0) || !(Number(p.height) > 0)) {
    out.push(finding('error', 'PLAN_RENDER_INVALID_PLAN', 'plan.width and plan.height must be positive'));
  }

  // ── Timing authority ────────────────────────────────────────────────
  const expected = expectedFramesForPlan(p as RemotionCompositionPlan);
  if (expected > 0 && expected !== p.durationInFrames) {
    out.push(
      finding(
        'error',
        'PLAN_RENDER_TIMING_MISMATCH',
        `plan.durationInFrames ${p.durationInFrames} does not match the authoritative ${expected} frames for ${p.totalActualDurationSeconds}s @ ${p.fps}fps`,
      ),
    );
  }
  const estimatorSeconds = Number(p.totalEstimatedDurationSeconds);
  const planFps = Number(p.fps);
  if (Number.isFinite(estimatorSeconds) && estimatorSeconds > 0 && Number.isFinite(planFps)) {
    const estimatorFrames = Math.ceil(estimatorSeconds * planFps);
    if (estimatorFrames === p.durationInFrames && estimatorFrames !== expected) {
      out.push(
        finding(
          'error',
          'PLAN_RENDER_TIMING_MISMATCH',
          `plan.durationInFrames equals the estimator-derived ${estimatorFrames} frames; the render authority is the Phase 4 actual timing`,
        ),
      );
    }
  }

  // ── Scene timeline ─────────────────────────────────────────────────
  let cursor = 0;
  const seen = new Set<string>();
  for (const scene of p.scenes) {
    if (seen.has(scene.sceneId)) {
      out.push(finding('error', 'PLAN_RENDER_INVALID_PLAN', `duplicate scene id ${scene.sceneId}`, scene.sceneId));
    }
    seen.add(scene.sceneId);

    if (scene.startFrame !== cursor) {
      out.push(
        finding('error', 'PLAN_RENDER_TIMING_MISMATCH', `scene ${scene.sceneId} starts at frame ${scene.startFrame} but the timeline cursor is ${cursor}`, scene.sceneId),
      );
    }
    if (!(scene.endFrame > scene.startFrame)) {
      out.push(finding('error', 'PLAN_RENDER_INVALID_FRAME_COUNT', `scene ${scene.sceneId} has a non-positive frame span ${scene.startFrame}..${scene.endFrame}`, scene.sceneId));
    }
    if (scene.durationInFrames !== scene.endFrame - scene.startFrame) {
      out.push(finding('error', 'PLAN_RENDER_TIMING_MISMATCH', `scene ${scene.sceneId} durationInFrames does not match its frame bounds`, scene.sceneId));
    }
    if (scene.endFrame > p.durationInFrames!) {
      out.push(finding('error', 'PLAN_RENDER_TIMING_MISMATCH', `scene ${scene.sceneId} extends past the composition end`, scene.sceneId));
    }
    cursor = scene.endFrame;
  }
  if (cursor !== p.durationInFrames) {
    out.push(
      finding(
        'error',
        'PLAN_RENDER_TIMING_MISMATCH',
        `scene timeline ends at frame ${cursor} but plan.durationInFrames is ${p.durationInFrames}; the authoritative content would be truncated or padded`,
      ),
    );
  }

  // ── Audio ──────────────────────────────────────────────────────────
  const scenesWithAudio = p.scenes.filter((s) => (s.audioRefs ?? []).length > 0);
  const audioRefCount = p.scenes.reduce((n, s) => n + (s.audioRefs?.length ?? 0), 0);
  if (audioRefCount === 0) {
    out.push(
      finding(
        'warning',
        'PLAN_RENDER_AUDIO_MISSING',
        'plan carries no canonical audio refs; the render will have no audio stream (only valid for a deliberately silent plan)',
      ),
    );
  }
  for (const scene of scenesWithAudio) {
    for (const audio of scene.audioRefs) {
      if (typeof audio.canonicalPath !== 'string' || !audio.canonicalPath.trim().length) {
        out.push(finding('error', 'PLAN_RENDER_AUDIO_MISSING', `scene ${scene.sceneId} audio ref ${audio.clipId} has no canonical path`, scene.sceneId));
      }
      if (!(Number(audio.durationInFrames) > 0) && !(Number(audio.actualDurationSeconds) > 0)) {
        out.push(finding('error', 'PLAN_RENDER_AUDIO_MISSING', `scene ${scene.sceneId} audio ref ${audio.clipId} has no usable duration`, scene.sceneId));
      }
    }
  }

  // ── Media visibility ───────────────────────────────────────────────
  // Only meaningful when the caller supplies the mediaMap the renderer will
  // receive. Unresolved refs are optional and never fatal; a RESOLVED ref whose
  // scene renderer cannot show it is a silent-drop defect and is fatal.
  if (mediaMap) {
    for (const scene of p.scenes) {
      const url = sceneMediaUrl(scene as RemotionSceneCompositionSpec, mediaMap);
      if (!url) continue;
      if (!sceneConsumesMedia(scene as RemotionSceneCompositionSpec)) {
        out.push(
          finding(
            'error',
            'PLAN_RENDER_MEDIA_NOT_VISIBLE',
            `scene ${scene.sceneId} has resolved media but renderer "${scene.rendererKey}" does not consume it`,
            scene.sceneId,
          ),
        );
      }
    }
    for (const scene of p.scenes) {
      const unresolved = (scene.assetRefs ?? []).filter((r) => !sceneMediaUrl({ assetRefs: [r] } as RemotionSceneCompositionSpec, mediaMap));
      if (unresolved.length && (scene.assetRefs ?? []).length) {
        out.push(
          finding(
            'warning',
            'PLAN_RENDER_MEDIA_NOT_VISIBLE',
            `scene ${scene.sceneId} declares ${unresolved.map((u) => u.assetRef).join(', ')} with no entry in mediaMap; rendering its non-media path`,
            scene.sceneId,
          ),
        );
      }
    }
  }

  return out;
}

/** The first fatal finding, if any. */
export function firstPlanRenderError(plan: unknown, mediaMap?: Record<string, string> | null): PlanRenderFinding | null {
  return validatePlanForRender(plan, mediaMap).find((f) => f.severity === 'error') ?? null;
}

/**
 * The canonical asset-visibility gate for one scene.
 * Throws the structured Phase 6B error when a scene's media resolved but its
 * approved renderer would not show it.
 */
export function assertSceneMediaVisible(
  scene: RemotionSceneCompositionSpec,
  mediaMap?: Record<string, string> | null,
): string | null {
  const url = sceneMediaUrl(scene as RemotionSceneCompositionSpec, mediaMap);
  if (!url) return null;
  if (!sceneConsumesMedia(scene)) {
    throw new PlanRenderError(
      'PLAN_RENDER_MEDIA_NOT_VISIBLE',
      `scene ${scene.sceneId} has resolved media but renderer "${scene.rendererKey}" does not consume it`,
      { sceneId: scene.sceneId, rendererKey: scene.rendererKey, mediaUrl: url },
    );
  }
  return url;
}

/** The canonical timing facts, for tests and the handoff. */
export function canonicalTimingFacts() {
  return { ...PLAN_RENDER_CANONICAL };
}
