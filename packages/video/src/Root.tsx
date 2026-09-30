import React from 'react';
import { Composition } from 'remotion';
import { getBrandPreset, REMOTION_FPS, REMOTION_LAYOUT, type RemotionCompositionPlan } from '@buildtrack/core';
import { VideoComposition, type VideoProps } from './compositions/VideoComposition';
import { VideoCompositionPlan } from './compositions/VideoCompositionPlan';
import { LAYOUT, FPS } from './brand/theme';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';

const emptyScenes: VideoProps['scenes'] = [];

const emptyPlan: RemotionCompositionPlan = {
  planVersion: '1.0.0',
  scenarioId: 'empty',
  projectId: 'empty',
  language: 'en',
  targetFormat: 'Long',
  fps: REMOTION_FPS,
  width: REMOTION_LAYOUT.long.width,
  height: REMOTION_LAYOUT.long.height,
  durationInFrames: REMOTION_FPS * 60,
  totalActualDurationSeconds: 60,
  totalEstimatedDurationSeconds: 60,
  totalDeltaSeconds: 0,
  characters: [],
  scenes: [],
  summary: {
    scenarioId: 'empty',
    projectId: 'empty',
    language: 'en',
    targetFormat: 'Long',
    fps: REMOTION_FPS,
    width: REMOTION_LAYOUT.long.width,
    height: REMOTION_LAYOUT.long.height,
    sceneCount: 0,
    rendererKeysUsed: [],
    rendererCategoriesUsed: [],
    beatCount: 0,
    audioRefCount: 0,
    captionCueCount: 0,
    assetRefCount: 0,
    transitionCount: 0,
    fallbackCount: 0,
    totalActualDurationSeconds: 60,
    totalDurationInFrames: REMOTION_FPS * 60,
    warningCount: 0,
    status: 'ok',
  },
  findings: [],
  valid: true,
};

const defaults: VideoProps = {
  scenes: emptyScenes,
  captions: [],
  brand: getBrandPreset('buildtrack'),
  format: 'long',
  ctaAnimation: 'slide_in',
  captionStyle: 'boxed_center',
  ctaText: 'Start your free trial',
  productName: 'BuildTrack',
  logoSrc: null,
  audioSrc: null,
  burnedCaptions: true,
  mediaMap: {},
};

/**
 * Remotion entry point. The API passes the whole project as input props, so
 * there is exactly one place that turns a storyboard into pixels.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="LongVideo"
        component={VideoComposition}
        durationInFrames={FPS * 60}
        fps={FPS}
        width={LAYOUT.long.width}
        height={LAYOUT.long.height}
        defaultProps={{ ...defaults, format: 'long' }}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(
            1,
            Math.round(props.scenes.reduce((a: number, s: { duration: number }) => a + s.duration, 0) * FPS),
          ),
          width: LAYOUT.long.width,
          height: LAYOUT.long.height,
          fps: FPS,
        })}
      />
      <Composition
        id="ShortVideo"
        component={VideoComposition}
        durationInFrames={FPS * 30}
        fps={FPS}
        width={LAYOUT.short.width}
        height={LAYOUT.short.height}
        defaultProps={{ ...defaults, format: 'short' }}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(
            1,
            Math.round(props.scenes.reduce((a: number, s: { duration: number }) => a + s.duration, 0) * FPS),
          ),
          width: LAYOUT.short.width,
          height: LAYOUT.short.height,
          fps: FPS,
        })}
      />
      <Composition
        id="VideoPlan"
        component={VideoCompositionPlan}
        durationInFrames={FPS * 60}
        fps={FPS}
        width={LAYOUT.long.width}
        height={LAYOUT.long.height}
        defaultProps={{ plan: emptyPlan, format: 'long' as const, captionStyle: 'boxed_center' as const, burnedCaptions: true }}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(1, props.plan?.durationInFrames ?? FPS * 60),
          width: props.plan?.width ?? LAYOUT.long.width,
          height: props.plan?.height ?? LAYOUT.long.height,
          fps: props.plan?.fps ?? FPS,
        })}
      />
    </>
  );
};
