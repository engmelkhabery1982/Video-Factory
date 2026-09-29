import type { BrandPreset } from './types.js';

/**
 * Brand layer - FIXED identity.
 *
 * Everything in this file is deliberately deterministic: colours, type, logo
 * treatment and caption shape never change between videos. The variable layer
 * (hook, scene order, background, motion) lives in `diversity.ts`.
 */

export const BRAND_PRESETS: Record<string, BrandPreset> = {
  buildtrack: {
    id: 'buildtrack',
    name: 'BuildTrack (Construction Progress Intelligence)',
    colors: {
      primary: '#0B3D91',
      secondary: '#00B4D8',
      accent: '#FFB703',
      surfaceDark: '#08121F',
      surfaceLight: '#F4F7FB',
      textOnDark: '#F7FAFF',
      textOnLight: '#0B1220',
    },
    fonts: {
      heading: 'Inter',
      body: 'Inter',
      numeric: 'JetBrains Mono',
    },
    logoAssetId: 'brand-logo-buildtrack',
    cornerRadius: 18,
    captionStyleDefault: 'boxed_center',
    iconStyle: 'duotone',
    professionalism: 'premium',
  },
};

/** Accent palette offered to the Diversity Engine. Chosen per project, never fixed. */
export const ACCENT_PALETTE: Record<string, string[]> = {
  buildtrack: ['#FFB703', '#00B4D8', '#2EC4B6', '#8AC926', '#FF6B6B', '#C77DFF'],
};

export function getBrandPreset(id: string): BrandPreset {
  const found = BRAND_PRESETS[id] ?? BRAND_PRESETS.buildtrack;
  // clone so callers can mutate freely without corrupting the registry
  return { ...found, colors: { ...found.colors }, fonts: { ...found.fonts } };
}

/**
 * Inline SVG wordmark, used as the built-in fallback logo so the app never
 * depends on an external download. Drawn from scratch for this project, so the
 * provenance is unambiguous.
 */
export const BUILTRACK_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 120" width="420" height="120" role="img" aria-label="BuildTrack">
  <defs>
    <linearGradient id="btg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#00B4D8"/>
      <stop offset="100%" stop-color="#0B3D91"/>
    </linearGradient>
  </defs>
  <g transform="translate(12 14)">
    <rect x="0" y="0" width="92" height="92" rx="22" fill="url(#btg)"/>
    <path d="M22 68 L40 34 L52 52 L62 38 L74 68 Z" fill="#0B1220" opacity="0.85"/>
    <rect x="18" y="72" width="58" height="6" rx="3" fill="#FFB703"/>
  </g>
  <text x="122" y="58" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="800" fill="#F7FAFF" letter-spacing="-0.5">Build</text>
  <text x="236" y="58" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="800" fill="#00B4D8" letter-spacing="-0.5">Track</text>
  <text x="124" y="84" font-family="Inter, Arial, sans-serif" font-size="17" font-weight="600" fill="#7FA0C8" letter-spacing="3.4">PROGRESS INTELLIGENCE</text>
</svg>`;
