import type { BrandPreset } from '@buildtrack/core';

/**
 * The FIXED identity layer.
 * Nothing in this file may be randomised - two BuildTrack videos must look like
 * the same brand even when their visual storytelling is completely different.
 */

export const FPS = 30;

export const LAYOUT = {
  long: { width: 1920, height: 1080, safe: 96 },
  short: { width: 1080, height: 1920, safe: 72 },
} as const;

/** Platform UI risk zones - kept free of key content. */
export const SHORTS_UNSAFE = {
  rightRail: { top: 0, height: 1920, width: 210 },
  bottom: { top: 1560, height: 360, width: 1080 },
  top: { top: 0, height: 220, width: 1080 },
} as const;

export const FONTS = {
  heading: '"Inter Variable", "Inter", "Segoe UI", Arial, sans-serif',
  body: '"Inter Variable", "Inter", "Segoe UI", Arial, sans-serif',
  numeric: '"JetBrains Mono", "SF Mono", Menlo, monospace',
};

export function theme(brand: BrandPreset) {
  return {
    c: brand.colors,
    radius: brand.cornerRadius,
    heading: brand.fonts.heading,
    numeric: brand.fonts.numeric,
  };
}

export type Theme = ReturnType<typeof theme>;

/** Type scale, expressed in "steps of the base size" per format. */
export function typeScale(format: 'long' | 'short') {
  return format === 'long'
    ? { hero: 132, h1: 86, h2: 62, body: 34, caption: 40, stat: 210, micro: 22 }
    : { hero: 132, h1: 104, h2: 78, body: 50, caption: 62, stat: 260, micro: 34 };
}
