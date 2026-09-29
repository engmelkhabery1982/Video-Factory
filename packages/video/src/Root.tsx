import React from 'react';
import { Composition } from 'remotion';
import { getBrandPreset } from '@buildtrack/core';
import { VideoComposition, type VideoProps } from './compositions/VideoComposition';
import { LAYOUT, FPS } from './brand/theme';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';

const emptyScenes: VideoProps['scenes'] = [];

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
    </>
  );
};
