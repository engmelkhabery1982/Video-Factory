import React from 'react';
import type { RemotionSceneCompositionSpec } from '@buildtrack/core';
import { Background } from './Backgrounds';
import { theme } from '../brand/theme';
import type { BrandPreset } from '@buildtrack/core';

/**
 * Minimal adapter that renders a SceneRenderSpec using existing visual primitives.
 * Reuses Background component and theme, shows rendererKey, title, beats for validation.
 * This is the smallest bridge - upstream contract unchanged, no redesign.
 */

export const PlanSceneRenderer: React.FC<{
  scene: RemotionSceneCompositionSpec;
  brand?: BrandPreset;
  format?: 'long' | 'short';
}> = ({ scene, brand, format = 'long' }) => {
  const t = brand ? theme(brand as any) : null;
  const accent = scene.visualTreatment.accent ?? '#3B82F6';
  const backgroundVariant = (scene.visualTreatment.background as any) ?? 'dark_grid';

  return (
    <div style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'hidden', background: t?.c.surfaceDark ?? '#0B1220' }}>
      <div style={{ position: 'absolute', inset: -48 }}>
        {t ? (
          <Background variant={backgroundVariant} t={t} accent={accent} seed={scene.sceneIndex + 1} mediaUrl={null} />
        ) : (
          <div style={{ width: '100%', height: '100%', background: '#0B1220' }} />
        )}
      </div>

      <div style={{ position: 'absolute', inset: 0, padding: format === 'long' ? '130px 96px 150px' : '220px 72px 360px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ display: 'inline-flex', padding: '8px 16px', borderRadius: 8, background: `${accent}22`, border: `1px solid ${accent}66`, color: accent, fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: 18, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 16 }}>
          {scene.rendererKey} · {scene.rendererCategory} {scene.fallbackUsed ? `· fallback from ${scene.fallbackFrom}` : ''}
        </div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontWeight: 800, fontSize: format === 'long' ? 48 : 56, color: '#E6EDF6', lineHeight: 1.1, marginBottom: 16 }}>
          {scene.title ?? scene.sceneId}
        </div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 20, color: '#9FB6CF', marginBottom: 24 }}>
          Scene {scene.sceneIndex} · {scene.narrativePurpose} · {scene.actualDurationSeconds.toFixed(2)}s · frames [{scene.startFrame}, {scene.endFrame}) · {scene.durationInFrames}f
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 1200 }}>
          {scene.beats.slice(0, 5).map((beat) => (
            <div key={beat.id} style={{ display: 'flex', gap: 12, alignItems: 'center', fontFamily: 'Inter, sans-serif', fontSize: 16, color: '#DCE9F8', opacity: 0.9 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent, flexShrink: 0 }} />
              <span style={{ fontWeight: 600 }}>{beat.id}</span>
              <span style={{ opacity: 0.6 }}>{beat.kind}</span>
              <span style={{ opacity: 0.6 }}>{beat.actualStartSeconds.toFixed(2)}-{beat.actualEndSeconds.toFixed(2)}s</span>
              <span style={{ opacity: 0.6 }}>[{beat.startFrame},{beat.endFrame}) local [{beat.localStartFrame},{beat.localEndFrame})</span>
              {beat.spokenText ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 400 }}>{beat.spokenText.slice(0, 80)}</span> : null}
            </div>
          ))}
          {scene.beats.length > 5 ? <div style={{ color: '#9FB6CF', fontSize: 14 }}>+{scene.beats.length - 5} more beats</div> : null}
        </div>
        <div style={{ marginTop: 20, display: 'flex', gap: 24, fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#7FA0C8' }}>
          <span>Assets: {scene.assetRefs.length}</span>
          <span>Audio: {scene.audioRefs.length}</span>
          <span>Captions: {scene.captionCues.length}</span>
          <span>Transition: {scene.transition.type} ({scene.transition.rendererKey})</span>
        </div>
      </div>
    </div>
  );
};

/** Resolver - deterministic mapping rendererKey → component existence */
export function resolveRendererComponent(rendererKey: string): { exists: boolean; category: string | null } {
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
    return { exists: true, category: rendererKey.split(':')[0] };
  }
  return { exists: false, category: null };
}
