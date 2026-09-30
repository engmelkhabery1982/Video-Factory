import React from 'react';
import type { RemotionSceneCompositionSpec } from '@buildtrack/core';
import type { BrandPreset, Scene, BackgroundVariantId, TransitionVariantId, HookVariantId, ExplanationVariantId } from '@buildtrack/core';
import { theme } from '../brand/theme';
import { SceneRenderer } from './SceneRenderer';

/**
 * Phase 5C - Real renderer wiring
 * 
 * Maps RemotionSceneCompositionSpec (authoritative Phase 5B rendererKey) to existing
 * SceneRenderer which uses real Hook, Explanation, CtaCard, Background, Chrome components.
 * 
 * This is the smallest deterministic adapter required to invoke real existing rendering components.
 * No duplication of Hook/Explanation/CTA logic, no second visual system, no redesign.
 * 
 * Renderer mapping (authoritative Phase 5B key preserved):
 * - hook:* → existing Hook path (variant after ':' if compatible, else question with documented gap)
 * - explanation:* → existing Explanation path (variant after ':' if compatible)
 * - cta:cta_card → existing CtaCard path
 * - generic/background → safe generic behavior (key_statement)
 * 
 * Diagnostic metadata behind debug flag default OFF.
 */

const HOOK_VARIANTS = new Set<string>([
  'question',
  'surprising_number',
  'before_after',
  'common_mistake',
  'risk_warning',
  'scenario_story',
  'document_zoom',
  'product_result',
]);

const EXPLANATION_VARIANTS = new Set<string>([
  'animated_checklist',
  'number_comparison',
  'progressive_table',
  'timeline',
  'process_flow',
  'document_annotation',
  'site_footage_callouts',
  'split_screen',
  'key_statement',
  'dashboard_demo',
  'chart_animation',
  'myth_vs_reality',
  'problem_cause_solution',
]);

const BACKGROUND_VARIANTS = new Set<string>([
  'site_footage',
  'dark_grid',
  'document_closeup',
  'light_technical',
  'blueprint',
  'dashboard_ui',
  'full_typography',
  'split_visual',
]);

const TRANSITION_VARIANTS = new Set<string>([
  'direct_cut',
  'push',
  'zoom',
  'mask_reveal',
  'data_wipe',
  'document_page',
  'match_cut',
]);

/**
 * Maps Phase 5B rendererKey to legacy variant compatible with existing SceneRenderer
 * Preserves specific variant after ':' where compatible.
 */
export function mapRendererKeyToVariant(rendererKey: string): {
  variant: HookVariantId | ExplanationVariantId | 'cta_card' | 'endcard';
  isHook: boolean;
  isCta: boolean;
  compatibilityGap?: string;
} {
  const [category, rawVariant] = rendererKey.split(':');
  const variant = rawVariant ?? 'generic';

  if (category === 'hook') {
    if (HOOK_VARIANTS.has(variant)) {
      return { variant: variant as HookVariantId, isHook: true, isCta: false };
    }
    return {
      variant: 'question' as HookVariantId,
      isHook: true,
      isCta: false,
      compatibilityGap: `hook:generic → question fallback (generic not in HookVariantId, documented gap)`,
    };
  }

  if (category === 'explanation') {
    if (EXPLANATION_VARIANTS.has(variant)) {
      return { variant: variant as ExplanationVariantId, isHook: false, isCta: false };
    }
    return {
      variant: 'key_statement' as ExplanationVariantId,
      isHook: false,
      isCta: false,
      compatibilityGap: variant === 'generic' ? `explanation:generic → key_statement fallback` : `unknown explanation variant ${variant} → key_statement`,
    };
  }

  if (category === 'cta') {
    return { variant: 'cta_card' as const, isHook: false, isCta: true };
  }

  if (category === 'background' || category === 'generic') {
    return {
      variant: 'key_statement' as ExplanationVariantId,
      isHook: false,
      isCta: false,
      compatibilityGap: `${rendererKey} → key_statement safe generic`,
    };
  }

  return {
    variant: 'key_statement' as ExplanationVariantId,
    isHook: false,
    isCta: false,
    compatibilityGap: `unknown category ${category} → key_statement fallback`,
  };
}

function mapBackgroundVariant(bg: string): BackgroundVariantId {
  if (BACKGROUND_VARIANTS.has(bg)) {
    return bg as BackgroundVariantId;
  }
  if (bg.includes('dark') || bg.includes('grid')) return 'dark_grid';
  if (bg.includes('light')) return 'light_technical';
  if (bg.includes('blueprint')) return 'blueprint';
  if (bg.includes('site') || bg.includes('footage')) return 'site_footage';
  if (bg.includes('document')) return 'document_closeup';
  if (bg.includes('dashboard') || bg.includes('ui')) return 'dashboard_ui';
  return 'dark_grid';
}

function mapTransitionVariant(type: string, rendererKey: string): TransitionVariantId {
  const candidate = rendererKey && TRANSITION_VARIANTS.has(rendererKey) ? rendererKey : type;
  if (TRANSITION_VARIANTS.has(candidate)) {
    return candidate as TransitionVariantId;
  }
  const lower = String(type).toLowerCase();
  if (lower === 'dissolve' || lower === 'fade_black') return 'zoom';
  if (lower === 'wipe') return 'push';
  if (lower === 'cut' || lower === 'none') return 'direct_cut';
  return 'direct_cut';
}

export function remotionSceneToLegacyScene(
  scene: RemotionSceneCompositionSpec,
  options?: { ctaText?: string }
): Scene {
  const { variant, isHook, isCta } = mapRendererKeyToVariant(scene.rendererKey);

  const role = isCta ? 'cta' : isHook ? 'hook' : 'body';
  const section = scene.narrativePurpose ?? scene.title ?? scene.sceneId;
  const background = mapBackgroundVariant(scene.visualTreatment.background ?? 'dark_grid');
  const transitionIn = mapTransitionVariant(scene.transition.type, scene.transition.rendererKey);
  const accent = scene.visualTreatment.accent ?? '#3B82F6';

  const firstSpoken = scene.beats.find(b => b.spokenText)?.spokenText ?? '';
  const allSpoken = scene.beats.map(b => b.spokenText).filter(Boolean) as string[];
  const headline = scene.title ?? scene.onScreenInfo?.title ?? firstSpoken ?? scene.sceneId;
  const subline = scene.onScreenInfo?.subtitle ?? (allSpoken[1] ?? undefined);
  const items = scene.onScreenInfo?.bulletPoints && scene.onScreenInfo.bulletPoints.length > 0
    ? scene.onScreenInfo.bulletPoints
    : allSpoken.length > 1 ? allSpoken.slice(0, 5) : (scene.onScreenInfo?.title ? [scene.onScreenInfo.title] : []);

  let stat: string | null = null;
  let stat2: string | null = null;
  const percentMatch = firstSpoken.match(/(\d+(?:\.\d+)?%)/);
  if (percentMatch) {
    stat = percentMatch[1];
  }

  const content = {
    headline: String(headline).slice(0, 200),
    subline: subline ? String(subline).slice(0, 300) : undefined,
    items: items.map(i => String(i).slice(0, 200)).slice(0, 5),
    stat,
    stat2,
    statLabel: null,
    statLabel2: null,
    takeaway: scene.onScreenInfo?.callout ?? null,
    sideLabels: null,
    intent: undefined,
    source: firstSpoken || null,
    emphasis: null,
    label: null,
  };

  const narration = allSpoken.join(' ') || headline;

  return {
    id: scene.sceneId,
    index: scene.sceneIndex,
    role: role as any,
    section,
    variant: variant as any,
    background,
    transitionIn,
    textPosition: 'center',
    accent,
    duration: scene.actualDurationSeconds,
    startTime: scene.actualStartSeconds,
    narration,
    captionIds: scene.captionCues.map(c => c.id),
    content,
    assetIds: scene.assetRefs.map(a => a.assetRef),
    reason: {
      detected: `Phase 5B rendererKey ${scene.rendererKey} → ${variant}`,
      evidence: `narrativePurpose ${scene.narrativePurpose}`,
      notUsedRecently: [],
      alternatives: [],
    },
    locked: false,
    userEdited: false,
  };
}

export const PlanSceneRenderer: React.FC<{
  scene: RemotionSceneCompositionSpec;
  brand?: BrandPreset;
  format?: 'long' | 'short';
  ctaText?: string;
  productName?: string;
  logoSrc?: string | null;
  mediaUrl?: string | null;
  progress?: number;
  parallax?: number;
  reveal?: number;
  debug?: boolean;
}> = ({
  scene,
  brand,
  format = 'long',
  ctaText = 'Start your free trial',
  productName = 'BuildTrack',
  logoSrc = null,
  mediaUrl = null,
  progress = 0,
  parallax = 0,
  reveal = 1,
  debug = false,
}) => {
  const brandPreset = brand as any;
  const t = theme(brandPreset ?? { colors: { primary: '#3B82F6', secondary: '#10B981', accent: '#3B82F6', surfaceDark: '#0B1220', surfaceLight: '#FFFFFF', textOnDark: '#E6EDF6', textOnLight: '#0B1220' }, cornerRadius: 12, fonts: { heading: 'Inter', body: 'Inter', numeric: 'JetBrains Mono' }, logoAssetId: null, id: 'buildtrack', name: 'BuildTrack', iconStyle: 'line', professionalism: 'clean', captionStyleDefault: 'boxed_center' });

  const legacyScene = React.useMemo(() => remotionSceneToLegacyScene(scene, { ctaText }), [scene, ctaText]);
  const mapping = React.useMemo(() => mapRendererKeyToVariant(scene.rendererKey), [scene.rendererKey]);

  return (
    <div style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <SceneRenderer
        scene={legacyScene}
        t={t}
        format={format}
        ctaAnimation="slide_in"
        ctaText={ctaText}
        productName={productName}
        logoSrc={logoSrc}
        mediaUrl={mediaUrl ?? null}
        progress={progress}
        parallax={parallax}
        reveal={reveal}
      />
      {debug ? (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '8px 16px', background: 'rgba(0,0,0,0.7)', color: '#FFF', fontFamily: 'monospace', fontSize: 12, zIndex: 100 }}>
          <div>DEBUG: {scene.rendererKey} → {String(legacyScene.variant)} {mapping.compatibilityGap ? `gap: ${mapping.compatibilityGap}` : ''}</div>
          <div>Scene {scene.sceneIndex} [{scene.startFrame},{scene.endFrame}) {scene.actualDurationSeconds.toFixed(2)}s</div>
          <div>Beats: {scene.beats.length} Audio: {scene.assetRefs.length} Captions: {scene.captionCues.length}</div>
        </div>
      ) : null}
    </div>
  );
};

export function resolveRendererComponent(rendererKey: string): { exists: boolean; category: string | null; variant: string | null; usesRealRenderer: boolean } {
  const known = new Set([
    'hook:question',
    'hook:surprising_number',
    'hook:before_after',
    'hook:common_mistake',
    'hook:risk_warning',
    'hook:scenario_story',
    'hook:document_zoom',
    'hook:product_result',
    'hook:generic',
    'explanation:animated_checklist',
    'explanation:number_comparison',
    'explanation:progressive_table',
    'explanation:timeline',
    'explanation:process_flow',
    'explanation:document_annotation',
    'explanation:site_footage_callouts',
    'explanation:split_screen',
    'explanation:dashboard_demo',
    'explanation:chart_animation',
    'explanation:myth_vs_reality',
    'explanation:key_statement',
    'explanation:problem_cause_solution',
    'explanation:generic',
    'cta:cta_card',
    'cta:generic',
    'background:generic',
    'generic:generic',
  ]);
  if (known.has(rendererKey)) {
    const [cat, variant] = rendererKey.split(':');
    return { exists: true, category: cat, variant, usesRealRenderer: true };
  }
  return { exists: false, category: null, variant: null, usesRealRenderer: false };
}

export function resolveRendererComponentLegacy(rendererKey: string): { exists: boolean; category: string | null } {
  const res = resolveRendererComponent(rendererKey);
  return { exists: res.exists, category: res.category };
}
