/**
 * BuildTrack Video Factory - Phase 5B Scene Render Pipeline
 *
 * Deterministic mapping from Phase 5A VisualProductionPlan to SceneRenderPlan.
 * No rendering, no Remotion, no frame generation.
 *
 * Renderer mapping policy:
 *   Use existing scene renderer/component concepts from packages/video/src/scenes:
 *   - Hook variants: question, surprising_number, before_after, common_mistake, risk_warning, scenario_story, document_zoom, product_result
 *   - Explanation variants: animated_checklist, number_comparison, progressive_table, timeline, process_flow, document_annotation, site_footage_callouts, split_screen, dashboard_demo, chart_animation, myth_vs_reality, key_statement, problem_cause_solution
 *   - CTA: cta_card
 *   Mapping from narrativePurpose:
 *     hook -> hook:generic (or more specific based on turn intents if available)
 *     cta -> cta:cta_card
 *     context -> explanation:key_statement
 *     problem -> explanation:problem_cause_solution
 *     evidence -> explanation:dashboard_demo or number_comparison if numeric
 *     disagreement -> explanation:myth_vs_reality
 *     clarification -> explanation:animated_checklist
 *     decision -> explanation:process_flow
 *     solution -> explanation:process_flow
 *     demonstration -> explanation:site_footage_callouts or dashboard_demo if screenInsert
 *     result -> explanation:chart_animation
 *     otherwise -> explanation:generic
 *   Deterministic: same narrativePurpose + production hints → same rendererKey
 *
 * Fallback policy:
 *   If narrativePurpose is unknown or not in mapping, use generic:generic renderer only if explicitly allowed via options.allowGenericFallback.
 *   Otherwise return structured error UNSUPPORTED_SCENE_TYPE.
 *   Any fallback must record requested scene type, renderer selected, whether fallback used.
 *   No invisible fallback — fallbackUsed flag and fallbackFrom recorded.
 */

import { Scenario } from './types.js';
import { VisualProductionPlan, VisualProductionScene } from './visual-production-types.js';
import {
  SceneRenderPlan,
  SceneRenderSpec,
  SceneRenderBeat,
  SceneRenderSummary,
  SceneRenderFinding,
  SceneRenderErrorCode,
  SCENE_RENDER_PLAN_VERSION,
  BuildSceneRenderResult,
  SceneRendererKey,
  RendererCategory,
} from './scene-render-types.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeFinding(
  severity: 'error' | 'warning',
  code: SceneRenderErrorCode,
  message: string,
  location?: SceneRenderFinding['location']
): SceneRenderFinding {
  return { severity, code, message, location };
}

/** Renderer mapping registry — deterministic */
const NARRATIVE_PURPOSE_TO_RENDERER: Record<string, { rendererKey: SceneRendererKey; category: RendererCategory }> = {
  hook: { rendererKey: 'hook:generic', category: 'hook' },
  cta: { rendererKey: 'cta:cta_card', category: 'cta' },
  context: { rendererKey: 'explanation:key_statement', category: 'explanation' },
  problem: { rendererKey: 'explanation:problem_cause_solution', category: 'explanation' },
  evidence: { rendererKey: 'explanation:dashboard_demo', category: 'explanation' },
  disagreement: { rendererKey: 'explanation:myth_vs_reality', category: 'explanation' },
  clarification: { rendererKey: 'explanation:animated_checklist', category: 'explanation' },
  decision: { rendererKey: 'explanation:process_flow', category: 'explanation' },
  solution: { rendererKey: 'explanation:process_flow', category: 'explanation' },
  demonstration: { rendererKey: 'explanation:site_footage_callouts', category: 'explanation' },
  result: { rendererKey: 'explanation:chart_animation', category: 'explanation' },
};

/** More specific mapping based on production hints */
function mapSceneToRenderer(
  scene: VisualProductionScene,
  options: { allowGenericFallback: boolean }
): { rendererKey: SceneRendererKey; category: RendererCategory; fallbackUsed: boolean; fallbackFrom?: string; error?: string } {
  const purpose = scene.narrativePurpose;

  // Direct mapping
  const direct = NARRATIVE_PURPOSE_TO_RENDERER[purpose];
  if (direct) {
    // Refine based on production hints for evidence/result/demonstration
    if (purpose === 'evidence') {
      // If has screenInsert with assetRef, maybe dashboard_demo, else number_comparison if numeric facts?
      const hasScreenInsert = !!scene.production.screenInsert;
      const hasNumeric = scene.beats.some(b => b.evidenceIds.length > 0);
      if (hasNumeric) {
        return { rendererKey: 'explanation:number_comparison', category: 'explanation', fallbackUsed: false };
      }
      if (hasScreenInsert) {
        return { rendererKey: 'explanation:dashboard_demo', category: 'explanation', fallbackUsed: false };
      }
      return { ...direct, fallbackUsed: false };
    }
    if (purpose === 'demonstration') {
      if (scene.production.screenInsert) {
        return { rendererKey: 'explanation:dashboard_demo', category: 'explanation', fallbackUsed: false };
      }
      if (scene.production.bRollIntent) {
        return { rendererKey: 'explanation:site_footage_callouts', category: 'explanation', fallbackUsed: false };
      }
      return { ...direct, fallbackUsed: false };
    }
    if (purpose === 'result') {
      const hasChart = scene.production.overlayIntent?.toLowerCase().includes('chart') || scene.production.bRollIntent?.toLowerCase().includes('chart');
      if (hasChart) {
        return { rendererKey: 'explanation:chart_animation', category: 'explanation', fallbackUsed: false };
      }
      return { ...direct, fallbackUsed: false };
    }
    if (purpose === 'hook') {
      // For hook, we could map to more specific hook variant based on turn intents, but we preserve generic for determinism
      // If first turn intent is question, map to hook:question, etc.
      const firstTurnIntent = scene.beats.find(b => b.intent)?.intent;
      if (firstTurnIntent === 'question') {
        return { rendererKey: 'hook:question', category: 'hook', fallbackUsed: false };
      }
      // Check spoken text for numeric
      const hasNumber = scene.beats.some(b => b.spokenText && /\d+%|\d+\s*percent/i.test(b.spokenText));
      if (hasNumber) {
        return { rendererKey: 'hook:surprising_number', category: 'hook', fallbackUsed: false };
      }
      return { ...direct, fallbackUsed: false };
    }
    return { ...direct, fallbackUsed: false };
  }

  // Unknown purpose
  if (options.allowGenericFallback) {
    return {
      rendererKey: 'generic:generic',
      category: 'generic',
      fallbackUsed: true,
      fallbackFrom: purpose,
    };
  }

  return {
    rendererKey: 'generic:generic' as any,
    category: 'generic' as any,
    fallbackUsed: false,
    error: `Unsupported scene type/narrativePurpose '${purpose}' for scene '${scene.sceneId}'`,
  };
}

function validateIdentities(inputs: {
  scenario: Scenario;
  visualProductionPlan: VisualProductionPlan;
}): SceneRenderFinding[] {
  const findings: SceneRenderFinding[] = [];
  const { scenario, visualProductionPlan } = inputs;
  const err = (code: SceneRenderErrorCode, msg: string, loc?: any) => {
    findings.push(makeFinding('error', code, msg, loc));
  };

  const scenarioId = scenario.metadata.id;

  if (visualProductionPlan.scenarioId !== scenarioId) {
    err('PIPELINE_IDENTITY_MISMATCH', `visualProductionPlan.scenarioId mismatch: expected '${scenarioId}', got '${visualProductionPlan.scenarioId}'`, { scenarioId });
  }
  if (visualProductionPlan.projectId !== scenario.metadata.projectId) {
    err('PIPELINE_IDENTITY_MISMATCH', `projectId mismatch`, { scenarioId });
  }
  if (visualProductionPlan.targetFormat !== scenario.metadata.targetFormat) {
    err('PIPELINE_IDENTITY_MISMATCH', `targetFormat mismatch`, { scenarioId });
  }

  const scenarioSceneIds = scenario.scenes.map(s => s.id);
  const prodSceneIds = visualProductionPlan.scenes.map(s => s.sourceSceneId);

  if (JSON.stringify(scenarioSceneIds) !== JSON.stringify(prodSceneIds)) {
    err('VISUAL_SCENE_MISMATCH', `Scene IDs/order mismatch scenario vs visualProductionPlan: ${scenarioSceneIds.join(',')} vs ${prodSceneIds.join(',')}`, { scenarioId });
  }

  if (visualProductionPlan.scenes.length !== scenario.scenes.length) {
    err('VISUAL_SCENE_MISMATCH', `Scene count mismatch`, { scenarioId });
  }

  // Duplicate scene IDs
  const seen = new Set<string>();
  for (const s of visualProductionPlan.scenes) {
    if (seen.has(s.sourceSceneId)) {
      err('DUPLICATE_SCENE_ID', `Duplicate sceneId '${s.sourceSceneId}' in visualProductionPlan`, { sceneId: s.sourceSceneId });
    }
    seen.add(s.sourceSceneId);
  }

  return findings;
}

function validateInvariants(plan: SceneRenderPlan): SceneRenderFinding[] {
  const findings: SceneRenderFinding[] = [];
  const err = (code: SceneRenderErrorCode, msg: string, loc?: any) => {
    findings.push(makeFinding('error', code, msg, loc));
  };

  // Render order deterministic, no missing, no duplicate
  const seenOrders = new Set<number>();
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i];
    if (scene.renderOrder !== i || scene.sceneIndex !== i) {
      err('DUPLICATE_RENDER_ORDER', `Render order mismatch for scene '${scene.sceneId}': expected ${i}, got renderOrder ${scene.renderOrder}, sceneIndex ${scene.sceneIndex}`, {
        sceneId: scene.sceneId,
      });
    }
    if (seenOrders.has(scene.renderOrder)) {
      err('DUPLICATE_RENDER_ORDER', `Duplicate renderOrder ${scene.renderOrder}`, { sceneId: scene.sceneId });
    }
    seenOrders.add(scene.renderOrder);

    // Scene timing positive and monotonic, no overlap
    if (scene.actualDurationSeconds <= 0) {
      err('INVALID_DURATION', `Scene '${scene.sceneId}' actual duration must be positive`, { sceneId: scene.sceneId });
    }
    if (scene.actualStartSeconds < 0 || scene.actualEndSeconds <= scene.actualStartSeconds) {
      err('INVALID_DURATION', `Scene '${scene.sceneId}' invalid actual timing`, { sceneId: scene.sceneId });
    }
    if (i > 0) {
      const prev = plan.scenes[i - 1];
      if (prev.actualEndSeconds > scene.actualStartSeconds + 0.001) {
        err('OVERLAP_DETECTED', `Scene overlap between '${prev.sceneId}' and '${scene.sceneId}'`, { sceneId: scene.sceneId });
      }
    }

    // Renderer key valid
    if (!scene.rendererKey || typeof scene.rendererKey !== 'string') {
      err('RENDERER_MAPPING_MISSING', `Missing rendererKey for scene '${scene.sceneId}'`, { sceneId: scene.sceneId });
    }
    // Check renderer key is known
    const knownKeys = new Set([
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
    if (!knownKeys.has(scene.rendererKey)) {
      err('RENDERER_MAPPING_INVALID', `Invalid rendererKey '${scene.rendererKey}' for scene '${scene.sceneId}'`, { sceneId: scene.sceneId, rendererKey: scene.rendererKey });
    }

    // Beat outside scene timing
    for (const beat of scene.beats) {
      if (beat.actualStartSeconds < scene.actualStartSeconds - 0.001 || beat.actualEndSeconds > scene.actualEndSeconds + 0.001) {
        err('VISUAL_BEAT_MISMATCH', `Beat '${beat.id}' outside scene '${scene.sceneId}' interval`, { sceneId: scene.sceneId, beatId: beat.id });
      }
      if (beat.sceneId !== scene.sourceSceneId && beat.sceneId !== scene.sceneId) {
        // In our mapping, beat.sceneId is original visual beat sceneId, sourceSceneId is prod scene source
        // Allow both, but check
        // For Phase 5A, beat.sceneId is original sceneId, sourceSceneId is also sourceSceneId
        // So we check if beat belongs to this scene
        if (!scene.beats.some(b => b.id === beat.id)) {
          // This check is redundant
        }
      }
    }

    // Audio from another scene
    for (const audio of scene.audioRefs) {
      if (audio.sceneId !== scene.sourceSceneId && audio.sceneId !== scene.sceneId) {
        err('AUDIO_BINDING_MISMATCH', `Audio clip '${audio.clipId}' sceneId '${audio.sceneId}' does not match scene '${scene.sceneId}'`, {
          sceneId: scene.sceneId,
          clipId: audio.clipId,
        });
      }
      if (!audio.canonicalPath || !audio.canonicalPath.includes('audio/canonical')) {
        err('AUDIO_BINDING_MISMATCH', `Audio clip '${audio.clipId}' must use canonical path, got '${audio.canonicalPath}'`, { sceneId: scene.sceneId, clipId: audio.clipId });
      }
    }

    // Caption from another scene
    for (const cue of scene.captionCues) {
      if (cue.sceneId !== scene.sourceSceneId && cue.sceneId !== scene.sceneId) {
        err('CAPTION_BINDING_MISMATCH', `Caption cue '${cue.id}' sceneId '${cue.sceneId}' does not match scene '${scene.sceneId}'`, {
          sceneId: scene.sceneId,
          cueId: cue.id,
        });
      }
      // Timing within scene
      if (cue.startTimeSeconds < scene.actualStartSeconds - 0.001 || cue.endTimeSeconds > scene.actualEndSeconds + 0.001) {
        err('CAPTION_BINDING_MISMATCH', `Caption cue '${cue.id}' outside scene '${scene.sceneId}' interval`, { sceneId: scene.sceneId, cueId: cue.id });
      }
    }

    // Asset bound to wrong scene
    for (const asset of scene.assetRefs) {
      if (asset.sceneId !== scene.sourceSceneId && asset.sceneId !== scene.sceneId) {
        err('ASSET_BINDING_MISMATCH', `Asset '${asset.assetRef}' sceneId '${asset.sceneId}' does not match scene '${scene.sceneId}'`, {
          sceneId: scene.sceneId,
          assetRef: asset.assetRef,
        });
      }
    }

    // Transition reference invalid
    if (scene.transition) {
      if (typeof scene.transition.type !== 'string' || !scene.transition.type) {
        err('TRANSITION_BINDING_INVALID', `Invalid transition type for scene '${scene.sceneId}'`, { sceneId: scene.sceneId });
      }
      if (scene.transition.actualDurationSeconds !== null && scene.transition.actualDurationSeconds !== undefined) {
        if (scene.transition.actualDurationSeconds < 0) {
          err('TRANSITION_BINDING_INVALID', `Transition duration negative for scene '${scene.sceneId}'`, { sceneId: scene.sceneId });
        }
      }
    }
  }

  // Total duration matches Phase 5A total actual
  if (plan.scenes.length > 0) {
    const last = plan.scenes[plan.scenes.length - 1];
    if (Math.abs(last.actualEndSeconds - plan.totalActualDurationSeconds) > 0.01) {
      err('SCENE_RENDER_INVARIANT_FAILED', `Total duration mismatch: last scene ends ${last.actualEndSeconds}, plan total ${plan.totalActualDurationSeconds}`);
    }
    const sum = plan.scenes.reduce((s, sc) => s + sc.actualDurationSeconds, 0);
    if (Math.abs(sum - plan.totalActualDurationSeconds) > 0.01) {
      err('SCENE_RENDER_INVARIANT_FAILED', `Sum scene durations ${sum} vs total ${plan.totalActualDurationSeconds}`);
    }
  }

  return findings;
}

function buildSummary(plan: Omit<SceneRenderPlan, 'summary' | 'findings' | 'valid'>, findings: SceneRenderFinding[]): SceneRenderSummary {
  const warnings = findings.filter(f => f.severity === 'warning').length;
  const hasError = findings.some(f => f.severity === 'error');

  const rendererKeys = [...new Set(plan.scenes.map(s => s.rendererKey))].sort() as any;
  const categories = [...new Set(plan.scenes.map(s => s.rendererCategory))].sort() as any;

  const totalEstimated = plan.scenes.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);

  return {
    scenarioId: plan.scenarioId,
    projectId: plan.projectId,
    language: plan.language,
    targetFormat: plan.targetFormat,
    sceneCount: plan.scenes.length,
    rendererKeysUsed: rendererKeys,
    rendererCategoriesUsed: categories,
    beatCount: plan.scenes.reduce((sum, s) => sum + s.beats.length, 0),
    audioRefCount: plan.scenes.reduce((sum, s) => sum + s.audioRefs.length, 0),
    captionCueCount: plan.scenes.reduce((sum, s) => sum + s.captionCues.length, 0),
    assetRefCount: plan.scenes.reduce((sum, s) => sum + s.assetRefs.length, 0),
    transitionCount: plan.scenes.filter(s => s.transition && s.transition.type && s.transition.type !== 'cut' && s.transition.type !== 'none').length,
    fallbackCount: plan.scenes.filter(s => s.fallbackUsed).length,
    totalActualDurationSeconds: round2(plan.totalActualDurationSeconds),
    totalEstimatedDurationSeconds: round2(totalEstimated),
    totalDeltaSeconds: round2(plan.totalActualDurationSeconds - totalEstimated),
    warningCount: warnings,
    status: hasError ? 'error' : warnings > 0 ? 'warning' : 'ok',
  };
}

export interface SceneRenderOptions {
  allowGenericFallback?: boolean;
}

export function buildSceneRenderPlan(inputs: {
  scenario: Scenario;
  visualProductionPlan: VisualProductionPlan;
  options?: SceneRenderOptions;
}): BuildSceneRenderResult {
  const { scenario, visualProductionPlan, options } = inputs;
  const opts = { allowGenericFallback: options?.allowGenericFallback ?? false };

  if (!scenario || !visualProductionPlan) {
    const missing: string[] = [];
    if (!scenario) missing.push('scenario');
    if (!visualProductionPlan) missing.push('visualProductionPlan');
    return {
      success: false,
      error: `Missing phase outputs: ${missing.join(', ')}`,
      findings: missing.map(name => ({
        severity: 'error' as const,
        code: 'MISSING_PHASE_OUTPUT' as const,
        message: `Missing phase output: ${name}`,
      })),
    };
  }

  // Identity validation
  const identityFindings = validateIdentities({ scenario, visualProductionPlan });
  if (identityFindings.some(f => f.severity === 'error')) {
    return {
      success: false,
      error: `Identity validation failed: ${identityFindings.filter(f => f.severity === 'error').map(f => f.message).join('; ')}`,
      findings: identityFindings,
    };
  }

  const findings: SceneRenderFinding[] = [...identityFindings];
  const scenes: SceneRenderSpec[] = [];

  for (let sIdx = 0; sIdx < visualProductionPlan.scenes.length; sIdx++) {
    const vScene = visualProductionPlan.scenes[sIdx];

    // Renderer mapping
    const mapping = mapSceneToRenderer(vScene, { allowGenericFallback: opts.allowGenericFallback });
    if (mapping.error) {
      findings.push(makeFinding('error', 'UNSUPPORTED_SCENE_TYPE', mapping.error, { sceneId: vScene.sceneId }));
      if (!opts.allowGenericFallback) {
        // Fail fast if no fallback allowed
        return {
          success: false,
          error: mapping.error,
          findings,
        };
      }
    }

    const rendererKey = mapping.rendererKey;
    const rendererCategory = mapping.category;
    const fallbackUsed = mapping.fallbackUsed;
    const fallbackFrom = mapping.fallbackFrom;

    if (fallbackUsed) {
      findings.push(
        makeFinding('warning', 'RENDERER_MAPPING_MISSING', `Fallback used for scene '${vScene.sceneId}': requested '${fallbackFrom}' → '${rendererKey}'`, {
          sceneId: vScene.sceneId,
          rendererKey,
        })
      );
    }

    // Beats — preserve Phase 5A timing, do not change
    const beats: SceneRenderBeat[] = vScene.beats.map(b => ({
      id: b.id,
      sceneId: b.sceneId,
      index: b.index,
      kind: b.kind as any,
      actualStartSeconds: b.actualStartSeconds,
      actualEndSeconds: b.actualEndSeconds,
      actualDurationSeconds: b.actualDurationSeconds,
      relativeStart: b.relativeStart,
      relativeEnd: b.relativeEnd,
      turnId: b.turnId,
      activeSpeakerId: b.activeSpeakerId,
      reactingCharacterId: b.reactingCharacterId,
      spokenText: b.spokenText,
      intent: b.intent,
      delivery: b.delivery,
      shot: {
        shotType: b.shot.shotType,
        framing: b.shot.framing,
        speakerFocus: b.shot.speakerFocus,
        cameraMovement: b.shot.cameraMovement,
        focusCharacterId: b.shot.focusCharacterId,
      },
      evidenceIds: [...b.evidenceIds],
      cues: b.cues.map(c => ({
        id: c.id,
        kind: c.kind,
        text: c.text,
        actualStartSeconds: c.actualStartSeconds,
        actualEndSeconds: c.actualEndSeconds,
        actualDurationSeconds: c.actualDurationSeconds,
        assetRef: c.assetRef,
      })),
      audioRef: b.audioRef ? { ...b.audioRef } : null,
      captionCueIds: [...b.captionCueIds],
    }));

    // Visual treatment
    const visualTreatment = {
      background: (vScene.production as any).background ?? vScene.production.shotType ?? 'dark_grid',
      accent: (vScene.production as any).accent,
      screenInsert: vScene.production.screenInsert,
      bRollIntent: vScene.production.bRollIntent,
      overlayIntent: vScene.production.overlayIntent,
      environmentalAction: vScene.production.environmentalAction,
    };

    // Transition mapping
    const transition = {
      type: vScene.transition.type as any,
      durationSeconds: vScene.transition.durationSeconds,
      source: vScene.transition.source,
      actualStartSeconds: vScene.transition.actualStartSeconds,
      actualEndSeconds: vScene.transition.actualEndSeconds,
      actualDurationSeconds: vScene.transition.actualDurationSeconds,
      rendererKey: vScene.transition.type, // direct mapping for now, future Phase 5C will map to actual animation
    };

    scenes.push({
      scenarioId: visualProductionPlan.scenarioId,
      projectId: visualProductionPlan.projectId,
      sceneId: vScene.sceneId,
      sourceSceneId: vScene.sourceSceneId,
      sceneIndex: vScene.index,
      renderOrder: vScene.renderOrder,
      title: vScene.title,
      narrativePurpose: vScene.narrativePurpose as any,
      rendererKey,
      rendererCategory,
      fallbackUsed,
      fallbackFrom,
      actualStartSeconds: vScene.actualStartSeconds,
      actualEndSeconds: vScene.actualEndSeconds,
      actualDurationSeconds: vScene.actualDurationSeconds,
      estimatedStartSeconds: vScene.estimatedStartSeconds,
      estimatedEndSeconds: vScene.estimatedEndSeconds,
      estimatedDurationSeconds: vScene.estimatedDurationSeconds,
      visualTreatment,
      production: vScene.production,
      onScreenInfo: vScene.onScreenInfo,
      locationId: vScene.locationId,
      participantIds: [...vScene.participantIds],
      turnIds: [...vScene.turnIds],
      speakerIds: [...vScene.speakerIds],
      visualOnly: vScene.visualOnly,
      beats,
      assetRefs: [...vScene.assetRefs],
      audioRefs: [...vScene.audioRefs],
      captionCues: [...vScene.captionCues],
      transition,
      targetFormat: visualProductionPlan.targetFormat,
      formatInfo: undefined, // could be filled from visualPlan if available
    });
  }

  const totalActual = visualProductionPlan.totalActualDurationSeconds;
  const totalEstimated = visualProductionPlan.totalEstimatedDurationSeconds;

  const partialPlan: Omit<SceneRenderPlan, 'summary' | 'findings' | 'valid'> = {
    planVersion: SCENE_RENDER_PLAN_VERSION,
    scenarioId: visualProductionPlan.scenarioId,
    projectId: visualProductionPlan.projectId,
    language: visualProductionPlan.language,
    targetFormat: visualProductionPlan.targetFormat,
    totalActualDurationSeconds: round2(totalActual),
    totalEstimatedDurationSeconds: round2(totalEstimated),
    totalDeltaSeconds: round2(totalActual - totalEstimated),
    scenes,
  };

  const summary = buildSummary(partialPlan, findings);
  const invariantFindings = (() => {
    const tempPlan: SceneRenderPlan = {
      ...partialPlan,
      summary,
      findings,
      valid: true,
    };
    return validateInvariants(tempPlan);
  })();

  const allFindings = [...findings, ...invariantFindings];
  const finalSummary = buildSummary(partialPlan, allFindings);
  const hasError = allFindings.some(f => f.severity === 'error');

  const finalPlan: SceneRenderPlan = {
    ...partialPlan,
    summary: finalSummary,
    findings: allFindings,
    valid: !hasError,
  };

  if (hasError) {
    return {
      success: false,
      error: `Scene render invariants failed: ${allFindings.filter(f => f.severity === 'error').map(f => f.message).join('; ')}`,
      findings: allFindings,
      partialPlan: finalPlan,
    };
  }

  return {
    success: true,
    plan: finalPlan,
  };
}

export function validateSceneRenderPlan(plan: SceneRenderPlan): { valid: boolean; findings: SceneRenderFinding[] } {
  if (!plan || typeof plan !== 'object') {
    return {
      valid: false,
      findings: [makeFinding('error', 'MISSING_PHASE_OUTPUT', 'SceneRenderPlan must be non-null object')],
    };
  }

  const findings: SceneRenderFinding[] = [...(plan.findings ?? [])];
  const invariantFindings = validateInvariants(plan);
  const allFindings = [...findings, ...invariantFindings];

  return {
    valid: !allFindings.some(f => f.severity === 'error'),
    findings: allFindings,
  };
}
