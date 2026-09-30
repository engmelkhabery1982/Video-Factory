/**
 * @vitest-environment happy-dom
 *
 * Phase 6A — Parallel Track B: Remotion Renderer Asset Consumption
 *
 * Proves the renderer consumes the Core production asset resolver contract:
 *
 *   mediaMap: Record<logicalAssetRef, renderableUrlOrPath>
 *
 * Scope (Track B only — resolution itself is Track A):
 * - resolveSceneMediaUrl: first resolved logical ref in existing assetRefs order
 * - VideoCompositionPlan: mediaMap consumed per scene, mediaUrl passed to
 *   PlanSceneRenderer → SceneRenderer (existing Background / Explanation path)
 * - Unresolved refs → mediaUrl null → scene renders through its existing
 *   non-media visual path (no error, no substitution)
 * - Plan / scene / map inputs are never mutated
 * - Scene timing, FPS, frame boundaries, audio, captions, transitions unchanged
 *
 * The only mocked surface is Remotion's frame/config context hooks and the
 * Sequence timeline wrapper (vitest runs outside a registered Remotion root);
 * every BuildTrack component under test is the real source module.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemotionCompositionPlan, RemotionSceneCompositionSpec } from '@buildtrack/core';
import {
  VideoCompositionPlan,
  resolveSceneMediaUrl,
} from '../packages/video/src/compositions/VideoCompositionPlan.js';

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  return {
    ...actual,
    useCurrentFrame: () => 0,
    useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080, durationInFrames: 2000 }),
    Sequence: (props: { children?: React.ReactNode }) => (props.children ?? null) as React.ReactElement,
  };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Deterministic typed fixture (mirrors the Phase 5C contract shapes; the
// canonical logical ref `asset-iva-progress-chart` is evidenced from the real
// pipeline output — see PHASE6A handoff).
// ---------------------------------------------------------------------------

const CITE = {
  scenarioId: 'scenario-pm-01',
  projectId: 'scenario-pm-01',
  sceneId: 'sc-02-context',
  beatId: 'sc-02-context/beat-0',
  cueId: 'scenario-pm-01/sc-02-context/cue/screen_insert_title',
};

const REAL_URL = 'http://127.0.0.1:3000/media/asset/asset-progress-chart-real';

function assetRef(overrides: Partial<{ assetRef: string; order: number; cueKind: string; cueId: string }> = {}) {
  return {
    assetRef: 'asset-iva-progress-chart',
    cueKind: 'screen_insert_title',
    cueId: CITE.cueId,
    beatId: CITE.beatId,
    sceneId: CITE.sceneId,
    required: true,
    order: 0,
    ...overrides,
  };
}

function captionCue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `${CITE.sceneId}/cue-0`,
    sceneId: CITE.sceneId,
    sceneIndex: 1,
    turnId: 'turn-0',
    turnIndex: 0,
    globalTurnIndex: 0,
    clipId: 'clip-0',
    text: 'Executed versus accepted work.',
    speakerId: 'speaker-1',
    voiceSlot: 'narrator',
    startTimeSeconds: 23.67,
    endTimeSeconds: 25.67,
    durationSeconds: 2,
    estimatedStartTimeSeconds: 23.67,
    estimatedEndTimeSeconds: 25.67,
    estimatedDurationSeconds: 2,
    wordCount: 4,
    isSingleWord: false,
    globalCueIndex: 0,
    startFrame: 710,
    endFrame: 770,
    durationInFrames: 60,
    localStartFrame: 0,
    localEndFrame: 60,
    localStartSeconds: 0,
    localEndSeconds: 2,
    ...overrides,
  };
}

function transitionSpec() {
  return {
    type: 'cut',
    rendererKey: 'direct_cut',
    durationSeconds: 0,
    source: 'default' as const,
    actualStartSeconds: null,
    actualEndSeconds: null,
    actualDurationSeconds: null,
    startFrame: null,
    endFrame: null,
    durationInFrames: null,
    localStartFrame: null,
    localEndFrame: null,
    outgoingSceneId: null,
    incomingSceneId: CITE.sceneId,
  };
}

function sceneSpec(
  overrides: Partial<RemotionSceneCompositionSpec> & { assetRefs?: RemotionSceneCompositionSpec['assetRefs'] } = {},
): RemotionSceneCompositionSpec {
  return {
    scenarioId: CITE.scenarioId,
    projectId: CITE.projectId,
    sceneId: CITE.sceneId,
    sourceSceneId: CITE.sceneId,
    sceneIndex: 1,
    renderOrder: 1,
    title: 'Context',
    narrativePurpose: 'context',
    rendererKey: 'explanation:key_statement',
    rendererCategory: 'explanation',
    fallbackUsed: false,
    actualStartSeconds: 23.67,
    actualEndSeconds: 43.86,
    actualDurationSeconds: 20.19,
    estimatedStartSeconds: 23.67,
    estimatedEndSeconds: 43.86,
    estimatedDurationSeconds: 20.19,
    startFrame: 710,
    endFrame: 1316,
    durationInFrames: 606,
    visualTreatment: { background: 'dark_grid', accent: '#3B82F6' },
    production: {
      shotType: 'medium',
      framing: 'center',
      speakerFocus: 'shared_display',
      cameraMovement: 'static',
    },
    onScreenInfo: { title: 'Context' },
    locationId: 'loc-1',
    participantIds: [],
    turnIds: [],
    speakerIds: [],
    visualOnly: false,
    beats: [],
    assetRefs: [assetRef()],
    audioRefs: [],
    captionCues: [captionCue()],
    transition: transitionSpec(),
    targetFormat: 'Long',
    formatInfo: { orientation: 'landscape', aspectRatio: '16:9' },
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

function planSpec(scenes: RemotionSceneCompositionSpec[]): RemotionCompositionPlan {
  const totalFrames = scenes.reduce((sum, s) => sum + s.durationInFrames, 0);
  const totalSeconds = scenes.reduce((sum, s) => sum + s.actualDurationSeconds, 0);
  return {
    planVersion: '1.0.0',
    scenarioId: CITE.scenarioId,
    projectId: CITE.projectId,
    language: 'en',
    targetFormat: 'Long',
    fps: 30,
    width: 1920,
    height: 1080,
    durationInFrames: totalFrames,
    totalActualDurationSeconds: totalSeconds,
    totalEstimatedDurationSeconds: totalSeconds,
    totalDeltaSeconds: 0,
    scenes,
    summary: {
      scenarioId: CITE.scenarioId,
      projectId: CITE.projectId,
      language: 'en',
      targetFormat: 'Long',
      fps: 30,
      width: 1920,
      height: 1080,
      sceneCount: scenes.length,
      rendererKeysUsed: ['explanation:key_statement'],
      rendererCategoriesUsed: ['explanation'],
      beatCount: 0,
      audioRefCount: 0,
      captionCueCount: scenes.length,
      assetRefCount: scenes.reduce((sum, s) => sum + s.assetRefs.length, 0),
      transitionCount: scenes.length,
      fallbackCount: 0,
      totalActualDurationSeconds: totalSeconds,
      totalDurationInFrames: totalFrames,
      warningCount: 0,
      status: 'ok',
    },
    findings: [],
    valid: true,
  };
}

/** Build a scene with the given logical refs, in order. */
function sceneWithRefs(refs: string[], overrides: Partial<RemotionSceneCompositionSpec> = {}): RemotionSceneCompositionSpec {
  return sceneSpec({
    ...overrides,
    assetRefs: refs.map((ref, i) => assetRef({ assetRef: ref, order: i, cueId: `${CITE.cueId}-${i}` })),
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 1) Pure deterministic lookup
// ---------------------------------------------------------------------------

describe('Phase 6A — resolveSceneMediaUrl (deterministic scene media lookup)', () => {
  it('1. exact logical ref resolves to the supplied URL', () => {
    const scene = sceneWithRefs(['asset-iva-progress-chart']);
    expect(resolveSceneMediaUrl(scene, { 'asset-iva-progress-chart': REAL_URL })).toBe(REAL_URL);
  });

  it('2. canonical ref asset-iva-progress-chart resolves correctly (canonical contract shape)', () => {
    const scene = sceneSpec();
    const map: Record<string, string> = {
      'asset-iva-progress-chart': 'http://127.0.0.1:3000/media/asset/asset-progress-chart-real',
    };
    expect(resolveSceneMediaUrl(scene, map)).toBe('http://127.0.0.1:3000/media/asset/asset-progress-chart-real');
  });

  it('3. unrelated map key is ignored (no fuzzy match, no inference)', () => {
    const scene = sceneWithRefs(['asset-iva-progress-chart']);
    const map: Record<string, string> = {
      'asset-iva-progress-chart-other': REAL_URL,
      'asset:screen-insert:xyz': REAL_URL,
      'asset-progress-chart-real': REAL_URL,
    };
    expect(resolveSceneMediaUrl(scene, map)).toBeNull();
  });

  it('4. unresolved asset returns null (no error, no substitution)', () => {
    const scene = sceneWithRefs(['asset-iva-progress-chart', 'asset-2-b-roll']);
    expect(resolveSceneMediaUrl(scene, {})).toBeNull();
    // Assets resolved for OTHER scenes never substitute into this scene:
    expect(resolveSceneMediaUrl(scene, { 'asset-from-another-scene': REAL_URL })).toBeNull();
  });

  it('5. multiple refs choose the FIRST resolved in existing plan order (order never reordered)', () => {
    const scene = sceneSpec({
      assetRefs: [
        assetRef({ assetRef: 'asset-iva-progress-chart', order: 0, cueKind: 'screen_insert_title' }),
        assetRef({ assetRef: 'asset-second-ref', order: 1, cueKind: 'screen_insert_description', cueId: 'cue-2' }),
        assetRef({ assetRef: 'asset-third-ref', order: 2, cueKind: 'screen_insert_callout', cueId: 'cue-3' }),
      ],
    });
    const map: Record<string, string> = {
      'asset-third-ref': 'http://example.com/third.png',
      'asset-second-ref': 'http://example.com/second.png',
      'asset-iva-progress-chart': REAL_URL,
    };
    expect(resolveSceneMediaUrl(scene, map)).toBe(REAL_URL);
  });

  it('6. empty-string URL is ignored and a later ref still wins', () => {
    const scene = sceneSpec({
      assetRefs: [
        assetRef({ assetRef: 'asset-empty-url', order: 0 }),
        assetRef({ assetRef: 'asset-iva-progress-chart', order: 1 }),
      ],
    });
    const map: Record<string, string> = {
      'asset-empty-url': '',
      'asset-iva-progress-chart': REAL_URL,
    };
    expect(resolveSceneMediaUrl(scene, map)).toBe(REAL_URL);
    expect(resolveSceneMediaUrl(scene, { 'asset-empty-url': '' })).toBeNull();
  });

  it('7. no mediaMap works safely (undefined and empty map)', () => {
    const scene = sceneSpec();
    expect(resolveSceneMediaUrl(scene, undefined)).toBeNull();
    expect(resolveSceneMediaUrl(scene, {})).toBeNull();
  });

  it('8. plan, scene and mediaMap inputs are not mutated', () => {
    const planA = planSpec([sceneWithRefs(['asset-iva-progress-chart'])]);
    const planB = planSpec([sceneWithRefs(['asset-iva-progress-chart'])]);
    const mapA: Record<string, string> = { 'asset-iva-progress-chart': REAL_URL };
    const mapB: Record<string, string> = { 'asset-iva-progress-chart': REAL_URL };

    resolveSceneMediaUrl(planA.scenes[0]!, mapA);

    expect(planA).toEqual(planB);
    expect(mapA).toEqual(mapB);
    expect(Object.keys(mapA).length).toBe(1);
    expect(planA.scenes[0]!.assetRefs.length).toBe(planB.scenes[0]!.assetRefs.length);
  });

  it('9. frame/timing/audio/caption information is unchanged by lookup', () => {
    const scene = sceneSpec();
    const snapshot = JSON.parse(JSON.stringify(scene));
    resolveSceneMediaUrl(scene, { 'asset-iva-progress-chart': REAL_URL });
    resolveSceneMediaUrl(scene, {});
    resolveSceneMediaUrl(scene, undefined);
    expect(scene.startFrame).toBe(snapshot.startFrame);
    expect(scene.endFrame).toBe(snapshot.endFrame);
    expect(scene.durationInFrames).toBe(snapshot.durationInFrames);
    expect(scene.actualStartSeconds).toBe(snapshot.actualStartSeconds);
    expect(scene.actualEndSeconds).toBe(snapshot.actualEndSeconds);
    expect(scene.actualDurationSeconds).toBe(snapshot.actualDurationSeconds);
    expect(scene.audioRefs).toEqual(snapshot.audioRefs);
    expect(scene.captionCues).toEqual(snapshot.captionCues);
    expect(scene.transition).toEqual(snapshot.transition);
    expect(scene).toEqual(snapshot);
  });

  it('10. repeated lookup is deterministic (same input → same URL, repeated)', () => {
    const scene = sceneWithRefs(['asset-iva-progress-chart', 'asset-second-ref']);
    const map: Record<string, string> = {
      'asset-iva-progress-chart': REAL_URL,
      'asset-second-ref': 'http://example.com/second.png',
    };
    const results = Array.from({ length: 5 }, () => resolveSceneMediaUrl(scene, map));
    expect(results).toEqual([REAL_URL, REAL_URL, REAL_URL, REAL_URL, REAL_URL]);
  });

  it('11. scene with no assetRefs returns null (never invents media)', () => {
    const scene = sceneSpec({ assetRefs: [] });
    expect(resolveSceneMediaUrl(scene, { 'asset-iva-progress-chart': REAL_URL })).toBeNull();
    expect(resolveSceneMediaUrl(scene, undefined)).toBeNull();
  });

  it('12. lookup follows existing assetRefs order, not map key order', () => {
    const scene = sceneWithRefs(['asset-zzz', 'asset-aaa']);
    const map: Record<string, string> = { 'asset-aaa': REAL_URL, 'asset-zzz': 'http://example.com/zzz.png' };
    // Both resolved: first-in-plan-order (asset-zzz) wins despite key insertion order.
    expect(resolveSceneMediaUrl(scene, map)).toBe('http://example.com/zzz.png');
    expect(scene.assetRefs.map((r) => r.assetRef)).toEqual(['asset-zzz', 'asset-aaa']);
  });
});

// ---------------------------------------------------------------------------
// 2) VideoCompositionPlan consumption (DOM-level wiring evidence)
// ---------------------------------------------------------------------------

/**
 * Both fixture scenes use explanation:site_footage_callouts / site_footage so
 * the resolved URL is visible in the DOM through the existing media path
 * (Background SiteFootage plate + Explanation site_footage_callouts plate).
 */
function siteFootageScene(refs: string[], overrides: Partial<RemotionSceneCompositionSpec> = {}): RemotionSceneCompositionSpec {
  return sceneWithRefs(refs, {
    rendererKey: 'explanation:site_footage_callouts',
    visualTreatment: { background: 'site_footage', accent: '#3B82F6' },
    ...overrides,
  });
}

function renderCompositionToHtml(props: Record<string, unknown>): string {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root | null = null;
  act(() => {
    root = createRoot(host);
    root.render(React.createElement(VideoCompositionPlan, props as never));
  });
  return host.innerHTML;
}

describe('Phase 6A — VideoCompositionPlan mediaMap consumption (DOM-level)', () => {
  it('resolved URL reaches the real SceneRenderer DOM; unresolved scene gets nothing', () => {
    const sceneWithMedia = siteFootageScene(['asset-iva-progress-chart']);
    const sceneWithoutMedia = siteFootageScene(['asset-unresolved-ref'], {
      sceneId: 'sc-03-dispute',
      sceneIndex: 2,
      renderOrder: 2,
      actualStartSeconds: 43.86,
      actualEndSeconds: 77.73,
      actualDurationSeconds: 33.87,
      estimatedStartSeconds: 43.86,
      estimatedEndSeconds: 77.73,
      estimatedDurationSeconds: 33.87,
      startFrame: 1316,
      endFrame: 2332,
      durationInFrames: 1016,
    });
    const plan = planSpec([sceneWithMedia, sceneWithoutMedia]);

    const html = renderCompositionToHtml({
      plan,
      mediaMap: { 'asset-iva-progress-chart': REAL_URL },
      burnedCaptions: false,
    });

    // Resolved logical ref consumed through the existing Background/Explanation media path.
    expect(html).toContain(REAL_URL);
    // Exactly the one resolved scene renders it (its background plate + explanation plate):
    // proves the unresolved scene received mediaUrl=null (no cross-scene substitution).
    const occurrences = html.split(REAL_URL).length - 1;
    expect(occurrences).toBe(2);
  });

  it('no mediaMap: every scene renders through its existing non-media path (no error)', () => {
    const plan = planSpec([siteFootageScene(['asset-iva-progress-chart'])]);
    const html = renderCompositionToHtml({ plan, burnedCaptions: false });
    expect(html.length).toBeGreaterThan(0);
    expect(html).not.toContain(REAL_URL);
    expect(html).not.toContain('url(http');
  });

  it('empty-string URL in the map is treated as unresolved (non-media path)', () => {
    const plan = planSpec([siteFootageScene(['asset-iva-progress-chart'])]);
    const html = renderCompositionToHtml({
      plan,
      mediaMap: { 'asset-iva-progress-chart': '' },
      burnedCaptions: false,
    });
    expect(html.length).toBeGreaterThan(0);
    expect(html).not.toContain('url(http');
  });
});
