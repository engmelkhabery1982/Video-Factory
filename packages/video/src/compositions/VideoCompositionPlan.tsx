import React from 'react';
import { AbsoluteFill, Audio, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { RemotionCompositionPlan, RemotionSceneCompositionSpec } from '@buildtrack/core';
import { theme } from '../brand/theme';
import { PlanSceneRenderer } from '../scenes/PlanSceneRenderer';
import { Transition } from '../scenes/Transitions';
import { Captions } from '../captions/Captions';
import type { BrandPreset, CaptionCue } from '@buildtrack/core';
import { getBrandPreset } from '@buildtrack/core';

export interface VideoCompositionPlanProps {
  plan: RemotionCompositionPlan;
  brand?: BrandPreset;
  format?: 'long' | 'short';
  captionStyle?: 'boxed_center' | 'word_pop' | 'lower_band' | 'side_panel' | 'highlight_box';
  ctaAnimation?: string;
  ctaText?: string;
  productName?: string;
  logoSrc?: string | null;
  burnedCaptions?: boolean;
  mediaMap?: Record<string, string>;
}

/**
 * Phase 6A — deterministic scene media lookup.
 *
 * Resolves the first renderable URL for a scene from a media map keyed by
 * logical asset reference (contract owned by the Core production asset
 * resolver): Record<logicalAssetRef, renderableUrlOrPath>.
 *
 * Rules:
 * - Iterates scene.assetRefs in their existing order (never reordered).
 * - Returns the FIRST reference whose mediaMap value is a non-empty string.
 * - Otherwise returns null (scene falls back to its existing non-media visual path).
 * - No fuzzy matching, no inference, no treating assetRef itself as a URL.
 * - Pure: never mutates scene or mediaMap, never substitutes another scene's media.
 */
export function resolveSceneMediaUrl(
  scene: Pick<RemotionSceneCompositionSpec, 'assetRefs'>,
  mediaMap?: Record<string, string>,
): string | null {
  if (!mediaMap) return null;
  for (const assetRef of scene.assetRefs) {
    const url = mediaMap[assetRef.assetRef];
    if (typeof url === 'string' && url.trim().length > 0) {
      return url.trim();
    }
  }
  return null;
}

/**
 * Remotion composition that renders a RemotionCompositionPlan.
 * Uses existing primitives: Sequence, Audio, Captions, Transitions, Backgrounds.
 * Timeline wiring: each scene placed at its actual frame range using Sequence.
 * No re-estimation, no retiming, actual Phase 4 timing drives placement.
 */
export const VideoCompositionPlan: React.FC<VideoCompositionPlanProps> = ({
  plan,
  brand,
  format = 'long',
  captionStyle = 'boxed_center',
  burnedCaptions = true,
  mediaMap,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const brandPreset = brand ?? getBrandPreset('buildtrack');
  const t = theme(brandPreset as any);

  // Build caption cues for global caption layer from plan
  const allCaptionCues: CaptionCue[] = React.useMemo(() => {
    const cues: CaptionCue[] = [];
    for (const scene of plan.scenes) {
      for (const cue of scene.captionCues) {
        cues.push({
          id: cue.id,
          start: cue.startTimeSeconds,
          end: cue.endTimeSeconds,
          text: cue.text,
          sceneId: cue.sceneId,
          terms: (cue as any).terms ?? [],
          userEdited: false,
        });
      }
    }
    // Deterministic order by start time
    cues.sort((a, b) => a.start - b.start);
    return cues;
  }, [plan]);

  // Scene texts for caption redundancy check (Phase 0C logic)
  const sceneTexts = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const scene of plan.scenes) {
      out[scene.sceneId] = scene.title ?? scene.sceneId;
    }
    return out;
  }, [plan]);

  // Find current scene for transition handling
  const currentScene = plan.scenes.find((s) => frame >= s.startFrame && frame < s.endFrame) ?? plan.scenes[plan.scenes.length - 1];

  return (
    <AbsoluteFill style={{ backgroundColor: t.c.surfaceDark }}>
      {/* Render all scenes as Sequences at their frame ranges */}
      {plan.scenes.map((scene) => (
        <Sequence key={scene.sceneId} from={scene.startFrame} durationInFrames={scene.durationInFrames}>
          <AbsoluteFill>
            <PlanSceneRenderer
              scene={scene}
              brand={brandPreset}
              format={format}
              mediaUrl={resolveSceneMediaUrl(scene, mediaMap)}
            />

            {/* Transition at start of scene if applicable */}
            {(() => {
              const localFrame = frame - scene.startFrame;
              const tDuration = scene.transition.durationInFrames;
              if (tDuration && localFrame < tDuration && scene.startFrame > 0 && scene.transition.type !== 'cut' && scene.transition.type !== 'none' && scene.transition.type !== 'direct_cut') {
                const p = tDuration > 0 ? localFrame / tDuration : 1;
                const variant = (scene.transition.rendererKey as any) ?? (scene.transition.type as any);
                // Map TransitionType to video TransitionVariant if needed
                const mappedVariant = (() => {
                  const v = String(variant);
                  if (['push', 'zoom', 'mask_reveal', 'data_wipe', 'document_page', 'match_cut', 'direct_cut'].includes(v)) return v;
                  // Map generic types
                  if (v === 'dissolve') return 'zoom';
                  if (v === 'fade_black') return 'zoom';
                  if (v === 'wipe') return 'push';
                  return 'direct_cut';
                })();
                if (mappedVariant !== 'direct_cut') {
                  return (
                    <Transition variant={mappedVariant as any} p={p} accent={scene.visualTreatment.accent ?? '#3B82F6'} fromSide={scene.sceneIndex % 2 === 0 ? 'left' : 'right'} />
                  );
                }
              }
              return null;
            })()}

            {/* Audio wiring - canonical only, reconciled timing, audible in production */}
            {scene.audioRefs.map((audio) => (
              <Sequence key={audio.clipId} from={audio.localStartFrame} durationInFrames={audio.durationInFrames}>
                {/* Production audio must be audible - canonical Phase 4 audio authoritative, no mute */}
                <Audio src={audio.canonicalPath} />
              </Sequence>
            ))}
          </AbsoluteFill>
        </Sequence>
      ))}

      {/* Global fade in/out */}
      <AbsoluteFill
        style={{
          backgroundColor: '#000',
          opacity: (() => {
            const total = plan.durationInFrames;
            if (frame < 12) return 1 - frame / 12;
            if (frame > total - 14) return (frame - (total - 14)) / 14;
            return 0;
          })(),
          pointerEvents: 'none',
        }}
      />

      {/* Caption wiring - exact text, reconciled timing */}
      {burnedCaptions ? (
        <Captions cues={allCaptionCues} style={captionStyle as any} t={t} accent={t.c.accent} format={format} sceneAccent={currentScene?.visualTreatment.accent} sceneTexts={sceneTexts} />
      ) : null}
    </AbsoluteFill>
  );
};

export default VideoCompositionPlan;
