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
  /**
   * Not a channel identity and not a logo. Used only so religious content has
   * a calm visual system when no owner identity has been bound. BuildTrack
   * must not be selected in its place.
   */
  'unbound-religious': {
    id: 'unbound-religious',
    name: 'Unbound religious visual system',
    colors: {
      primary: '#1C3A32',
      secondary: '#C4A574',
      accent: '#E4C98A',
      surfaceDark: '#101614',
      surfaceLight: '#F6F1E7',
      textOnDark: '#F7F1E4',
      textOnLight: '#1A1714',
    },
    fonts: {
      heading: '"Noto Naskh Arabic", "Noto Sans Arabic", "Amiri", Tahoma, sans-serif',
      body: '"Noto Naskh Arabic", "Noto Sans Arabic", "Amiri", Tahoma, sans-serif',
      numeric: '"Noto Naskh Arabic", Tahoma, sans-serif',
    },
    logoAssetId: null,
    cornerRadius: 8,
    captionStyleDefault: 'lower_band',
    iconStyle: 'line',
    professionalism: 'clean',
    readingDirection: 'rtl',
    captionMinPx: 64,
  },
  /**
   * Not a channel identity. An educational project must name its brand.
   * BuildTrack is used only when that preset is selected explicitly.
   */
  'unbound-educational': {
    id: 'unbound-educational',
    name: 'Unbound educational visual system',
    colors: {
      primary: '#1F3A5F',
      secondary: '#4C7EA8',
      accent: '#D7E6F2',
      surfaceDark: '#121820',
      surfaceLight: '#F4F7FB',
      textOnDark: '#F7FAFF',
      textOnLight: '#142033',
    },
    fonts: {
      heading: 'Inter',
      body: 'Inter',
      numeric: 'JetBrains Mono',
    },
    logoAssetId: null,
    cornerRadius: 10,
    captionStyleDefault: 'boxed_center',
    iconStyle: 'line',
    professionalism: 'clean',
    readingDirection: 'ltr',
    captionMinPx: 48,
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
