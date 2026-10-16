/**
 * Graphic scenes keep the same channel identity rules as every other scene, through the real SceneRenderer branch
 * that VideoComposition renders. Static markup, no browser. Fixture content is labelled FIXTURE.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// Static markup has no Remotion composition, so the two frame-clock hooks are given a fixed frame and config.
// Every other Remotion export and all identity and layout code is real. This is static markup, not a browser render.
vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  return {
    ...actual,
    useCurrentFrame: () => 0,
    useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30, durationInFrames: 300, id: 'fixture', defaultProps: {}, props: {}, defaultCodec: null, defaultOutName: null, defaultVideoImageFormat: null, nonce: 0 }),
  };
});
import { renderToStaticMarkup } from 'react-dom/server';
import { getBrandPreset } from '@buildtrack/core';
import { SceneRenderer } from '../packages/video/src/scenes/SceneRenderer.tsx';
import { theme } from '../packages/video/src/brand/theme.ts';
import { proofNumeric } from './fixtures/graphic-proof-specs.ts';

function graphicScene(role: 'body' | 'cta' = 'body') {
  return {
    id: 'g1', index: 0, role, section: 'Scheduling', variant: 'key_statement', background: 'full_typography',
    transitionIn: 'direct_cut', textPosition: 'lower_third', accent: '#E4C98A', duration: 10, startTime: 0,
    narration: 'x', captionIds: ['c1'], assetIds: [], locked: false, userEdited: false,
    content: { headline: '', items: [], presentation: 'reflective', mediaKind: 'none', graphic: proofNumeric('landscape') },
    reason: { detected: 'x', evidence: '', notUsedRecently: [], alternatives: [] },
  } as unknown as Parameters<typeof SceneRenderer>[0]['scene'];
}

function render(opts: { brandId: string; profile: 'educational' | 'religious' | 'promotional' | null; logoSrc: string | null; role?: 'body' | 'cta' }) {
  const brand = getBrandPreset(opts.brandId);
  return renderToStaticMarkup(
    <SceneRenderer
      scene={graphicScene(opts.role)}
      t={theme(brand)}
      format="long"
      ctaAnimation="slide_in"
      ctaText=""
      productName=""
      logoSrc={opts.logoSrc}
      contentProfile={opts.profile}
      progress={0.5}
    />,
  );
}

const LOGO = '/media/asset/owner-logo-fixture';

describe('graphic scene identity (FIXTURE logo and brand)', () => {
  it('renders the procedural graphic itself (not a card or a still)', () => {
    const html = render({ brandId: 'unbound-educational', profile: 'educational', logoSrc: null });
    expect(html).toContain('data-graphic-kind="numeric_comparison"');
    expect(html).toContain('9.5 h');
  });

  it('a bound educational identity shows the owner logo over a graphic scene', () => {
    const html = render({ brandId: 'buildtrack', profile: 'educational', logoSrc: LOGO });
    expect(html).toContain(`src="${LOGO}"`);
    expect(html).toContain('data-graphic-kind="numeric_comparison"');
  });

  it('an unbound educational graphic shows no identity name, wordmark or logo', () => {
    const html = render({ brandId: 'unbound-educational', profile: 'educational', logoSrc: null });
    expect(html).not.toContain('BuildTrack');
    expect(html).not.toContain(LOGO);
    expect(html).not.toMatch(/<img/);
  });

  it('a religious graphic shows no BuildTrack identity, even when a logo is supplied', () => {
    const html = render({ brandId: 'unbound-religious', profile: 'religious', logoSrc: LOGO });
    expect(html).not.toContain('BuildTrack');
    expect(html).not.toContain(LOGO);
    expect(html).not.toMatch(/<img/);
    expect(html).toContain('data-graphic-kind="numeric_comparison"');
  });

  it('a religious graphic with the BuildTrack theme still shows no BuildTrack wordmark', () => {
    const html = render({ brandId: 'buildtrack', profile: 'religious', logoSrc: null });
    expect(html).not.toContain('BuildTrack');
  });

  it('the safe box keeps the graphic clear of the logo band at the bottom', async () => {
    const { graphicSafeBox } = await import('../packages/video/src/graphics/graphicSafeBox.ts');
    const landscape = graphicSafeBox('long', 1920, 1080);
    const portrait = graphicSafeBox('short', 1080, 1920);
    expect(landscape.top + landscape.height).toBeLessThanOrEqual(1080 - 120);
    expect(portrait.top + portrait.height).toBeLessThanOrEqual(1920 - 260);
    expect(landscape.left).toBeGreaterThanOrEqual(96);
    expect(portrait.width).toBeLessThanOrEqual(1080 - 2 * 72);
  });
});
