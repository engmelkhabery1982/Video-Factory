/**
 * VideoComposition logo rules (review finding 2): a religious composition never passes a logo to the scene
 * renderer, whatever logoSrc is supplied; other profiles pass the supplied logo through unchanged.
 * Direct render of the real VideoComposition. SceneRenderer is replaced by a capturing stub so the test
 * reads the exact props. Static markup with a fixed Remotion clock. Not a browser render; fixture data only.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => [] as Array<{ logoSrc: string | null | undefined; contentProfile: string | null | undefined }>);

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  return {
    ...actual,
    useCurrentFrame: () => 0,
    useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30, durationInFrames: 300, id: 'fixture', defaultProps: {}, props: {}, defaultCodec: null, defaultOutName: null, defaultVideoImageFormat: null } as never),
  };
});

vi.mock('../packages/video/src/scenes/SceneRenderer.tsx', () => ({
  SceneRenderer: (props: { logoSrc?: string | null; contentProfile?: string | null }) => {
    seen.push({ logoSrc: props.logoSrc, contentProfile: props.contentProfile });
    return null;
  },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { getBrandPreset } from '@buildtrack/core';
import { VideoComposition } from '../packages/video/src/compositions/VideoComposition.tsx';

const LOGO = '/media/asset/owner-logo-fixture';

function scene(id: string) {
  return {
    id, index: 0, role: 'body', section: 'Fixture', variant: 'key_statement', background: 'full_typography',
    transitionIn: 'direct_cut', textPosition: 'lower_third', accent: '#E4C98A', duration: 4, startTime: 0,
    narration: 'x', captionIds: [], assetIds: [], locked: false, userEdited: false,
    content: { headline: 'FIXTURE', items: [], presentation: 'reflective', mediaKind: 'none' },
    reason: { detected: 'x', evidence: '', notUsedRecently: [], alternatives: [] },
  } as never;
}

function renderWith(profile: 'religious' | 'educational' | 'promotional' | null, logoSrc: string | null, brandId: string) {
  seen.length = 0;
  renderToStaticMarkup(
    <VideoComposition
      scenes={[scene(`s-${profile}`)]}
      captions={[]}
      brand={getBrandPreset(brandId)}
      format="long"
      ctaAnimation="slide_in"
      captionStyle={'plain' as never}
      ctaText=""
      productName=""
      logoSrc={logoSrc}
      contentProfile={profile}
      audioSrc={null}
    />,
  );
  return seen.slice();
}

describe('VideoComposition logo nulling (FIXTURE)', () => {
  it('religious content never passes a logo to the scene renderer, even when one is supplied', () => {
    const calls = renderWith('religious', LOGO, 'unbound-religious');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.contentProfile).toBe('religious');
      expect(c.logoSrc).toBeNull();
    }
  });

  it('educational content passes a supplied logo through unchanged', () => {
    const calls = renderWith('educational', LOGO, 'buildtrack');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.logoSrc === LOGO)).toBe(true);
  });

  it('promotional content passes a supplied logo through unchanged', () => {
    const calls = renderWith('promotional', LOGO, 'buildtrack');
    expect(calls.every((c) => c.logoSrc === LOGO)).toBe(true);
  });

  it('with no logo supplied, no profile invents one', () => {
    const calls = renderWith('educational', null, 'unbound-educational');
    expect(calls.every((c) => c.logoSrc === null)).toBe(true);
  });
});
