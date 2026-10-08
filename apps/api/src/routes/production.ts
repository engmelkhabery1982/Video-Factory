/**
 * BuildTrack Video Factory - Workstream D Production API Routes
 *
 * Thin production surface under the EXISTING project resource (no second
 * server, same Fastify instance):
 *
 *   POST   /api/projects/:id/production/generate        Workstream A generation -> sidecar
 *   GET    /api/projects/:id/production                 status + scenarios summary + artifacts
 *   PATCH  /api/projects/:id/production/scenes/:target/:sceneId
 *   PATCH  /api/projects/:id/production/turns/:target/:turnId
 *   PUT    /api/projects/:id/production/assets/:target/:logicalRef      { assetId }
 *   DELETE /api/projects/:id/production/assets/:target/:logicalRef
 *   GET    /api/projects/:id/production/assets                          eligible binding assets
 *   POST   /api/projects/:id/production/preview        plan-based preview (production audio)
 *   POST   /api/projects/:id/production/export         final plan-based build + Phase 6D package
 *   GET    /api/projects/:id/production/captions/:target   reconciled production captions
 *
 * Final video authority is ALWAYS: Scenario -> production audio (Kokoro) ->
 * Phase 5 plan -> Phase 6A resolution -> Phase 6C render -> Phase 6D package.
 * The legacy exportProject video path is never called here.
 */

import type { FastifyInstance } from 'fastify';
import {
  type Asset,
  type DeliveryTargetId,
  type Project,
} from '@buildtrack/core';
import { loadProject, loadHistory } from '../services/store.js';
import { clonedAudioRenderGate } from '../services/voice-audio-gate.js';
import { loadAssetIndex } from './assets.js';
import { OUTPUT_DIR, productionAudioPlanPaths } from '../services/platform.js';
import {
  appendProductionHistoryEntry,
  deleteProductionState,
  finalDeliverySucceeded,
  isStaleAgainstInput,
  loadProductionHistory,
  loadProductionState,
  productionStateFile,
} from '../services/production-state.js';
import {
  buildAllTargetPlans,
  buildTargetPlan,
  generateProductionState,
  patchProductionScene,
  patchProductionTurn,
  rerollProductionScene,
  personaObservationFromState,
  productionCaptionsForTarget,
  productionStatusFor,
  runProductionBuild,
  setProductionAssetBinding,
  PRODUCTION_AUDIO_ENGINE,
  ProductionError,
} from '../services/production-engine.js';
import type { ProductionState, ProductionTargetId } from '../services/production-state.js';

const TARGETS: ProductionTargetId[] = ['long', 'short_1', 'short_2', 'short_3'];

function isTarget(t: string): t is ProductionTargetId {
  return (TARGETS as string[]).includes(t);
}

/**
 * RENDERABLE-ASSET ELIGIBILITY for generated media slots.
 *
 * The current generated slot is a `screenInsert` source-record image: the
 * renderer displays an IMAGE. Offering an asset the renderer cannot actually
 * display would be a misleading product, so binding eligibility requires a
 * genuine, renderable image asset:
 *
 *   - status is active;
 *   - not blocked;
 *   - real source provenance;
 *   - real license provenance;
 *   - MIME type starts with `image/`;
 *   - kind is not a non-image category (video B-roll / audio / font / document).
 *
 * Video B-roll, audio, fonts and documents are deliberately NOT offered: the
 * production renderer does not support them yet, and this product does not
 * pretend otherwise. B-roll video stays a deliberate later capability.
 */
export const NON_IMAGE_ASSET_KINDS = ['broll', 'sfx', 'font', 'document'] as const;

export function assetBindingEligibility(asset: Asset): { eligible: boolean; reason: string | null } {
  if (asset.status !== 'active') return { eligible: false, reason: `status is '${asset.status}', not active` };
  if (asset.blocked) return { eligible: false, reason: 'asset is blocked' };
  if (typeof asset.source !== 'string' || asset.source.trim().length === 0) return { eligible: false, reason: 'missing source provenance' };
  if (typeof asset.license !== 'string' || asset.license.trim().length === 0) return { eligible: false, reason: 'missing license provenance' };
  if ((NON_IMAGE_ASSET_KINDS as readonly string[]).includes(asset.kind)) {
    return { eligible: false, reason: `kind '${asset.kind}' is not renderable in a generated image slot` };
  }
  const mime = typeof asset.mimeType === 'string' ? asset.mimeType.toLowerCase() : '';
  if (!mime.startsWith('image/')) {
    return { eligible: false, reason: `mimeType '${asset.mimeType ?? ''}' is not a renderable image` };
  }
  return { eligible: true, reason: null };
}

/** Assets eligible for production binding: active, real provenance, renderable image. */
function eligibleBindingAssets(assets: Asset[]): Asset[] {
  return assets.filter((a) => assetBindingEligibility(a).eligible);
}

/** Assets deliberately NOT offered, with the deterministic reason for each. */
function ineligibleBindingAssets(assets: Asset[]): Array<{ id: string; name: string; kind: string; mimeType: string; reason: string }> {
  return assets
    .map((a) => ({ asset: a, verdict: assetBindingEligibility(a) }))
    .filter((x) => !x.verdict.eligible)
    .map((x) => ({
      id: x.asset.id,
      name: x.asset.name,
      kind: x.asset.kind,
      mimeType: x.asset.mimeType,
      reason: x.verdict.reason ?? 'ineligible',
    }));
}

function stateSummary(project: Project, state: ProductionState | null) {
  const stale = state ? isStaleAgainstInput(state, project.meta.input) : false;
  const status = state ? (stale ? 'needs_regeneration' : productionStatusFor(state, project)) : 'not_generated';
  /*
   * DEFENSIVE STALENESS: when the ProjectInput changed, every derived record
   * (builds, artifacts, Phase 6D QC, readiness, product kit) describes the OLD
   * content and must not be presented as current — even for a sidecar written
   * before this rule existed. The scenarios/targets/bindings/edits are kept so
   * the operator can still see the content that needs regenerating.
   */
  const derived = stale
    ? {
        lastBuild: null as ProductionState['builds'][number] | null,
        lastQcSummary: null,
        lastReadiness: null,
        productKitPath: null as string | null,
        artifacts: [] as ProductionState['artifacts'],
      }
    : {
        lastBuild: state?.builds.length ? state.builds[state.builds.length - 1] : null,
        lastQcSummary: state?.lastQcSummary ?? null,
        lastReadiness: state?.lastReadiness ?? null,
        productKitPath: state?.productKitPath ?? null,
        artifacts: state?.artifacts ?? [],
      };
  return {
    exists: !!state,
    schemaVersion: state?.schemaVersion ?? null,
    status,
    stale,
    audioEngine: PRODUCTION_AUDIO_ENGINE,
    targets: state ? (Object.keys(state.scenarios) as ProductionTargetId[]) : [],
    generationFindings: state?.generationFindings ?? [],
    edits: state?.edits ?? [],
    locks: state?.locks ?? {},
    assetBindings: state?.assetBindings ?? [],
    lastBuild: derived.lastBuild,
    lastQcSummary: derived.lastQcSummary,
    /** PRODUCTION readiness QC (production authority; never ready with a blocking finding) */
    lastReadiness: derived.lastReadiness,
    /** product-kit root (production-native non-video deliverables), output-root relative */
    productKitPath: derived.productKitPath,
    artifacts: derived.artifacts,
    /**
     * True only when the LATEST final delivery genuinely succeeded: final build
     * + ready Phase 6D package + written product kit + ready readiness QC.
     */
    deliveryReady: state ? !stale && finalDeliverySucceeded(state) : false,
    inputFingerprint: state?.inputFingerprint ?? null,
    /** which casting/style history source generation consumed (audit evidence) */
    historyInput: state?.historyInput ?? null,
  };
}

function requireProductionTarget(state: ProductionState, target: string): asserts target is ProductionTargetId {
  if (!isTarget(target)) throw new ProductionError('UNKNOWN_TARGET', `Unknown production target '${target}'.`);
  if (!state.scenarios[target]) throw new ProductionError('TARGET_NOT_GENERATED', `Target '${target}' has not been generated.`);
}

export async function registerProductionRoutes(app: FastifyInstance) {
  /* ── generate ─────────────────────────────────────────────────── */
  app.post('/api/projects/:id/production/generate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    try {
      // The REAL production casting/style history is the generation authority.
      // Legacy visual history is supplied only as a fallback for projects that
      // have no production observations yet.
      const state = generateProductionState(p, {
        productionHistory: loadProductionHistory(),
        legacyVisualHistory: loadHistory(),
      });
      return { production: stateSummary(p, state), stateFile: productionStateFile(id).split(/[\\/]/).pop() };
    } catch (e) {
      if (e instanceof ProductionError) {
        return reply.code(422).send({ error: e.message, code: e.code, details: e.details });
      }
      throw e;
    }
  });

  /* ── read state ───────────────────────────────────────────────── */
  app.get('/api/projects/:id/production', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const state = loadProductionState(id);
    return {
      production: stateSummary(p, state),
      scenarios: state
        ? Object.fromEntries(
            Object.entries(state.scenarios).map(([t, sc]) => {
              const s = sc as { metadata?: { id?: string; title?: string }; scenes?: unknown[]; characters?: unknown[] };
              return [
                t,
                {
                  scenarioId: s?.metadata?.id ?? null,
                  title: s?.metadata?.title ?? null,
                  sceneCount: Array.isArray(s?.scenes) ? s.scenes.length : 0,
                  characterCount: Array.isArray(s?.characters) ? s.characters.length : 0,
                },
              ];
            }),
          )
        : {},
      /**
       * Complete generated Scenario objects per target.
       *
       * The Production Storyboard needs the real scenes, characters,
       * production directions, dialogue turns and the generated
       * `screenInsert.assetRef` logical media slots. The derived `scenarios`
       * summaries above are deliberately kept unchanged so existing callers
       * and tests keep working; this field is additive.
       */
      fullScenarios: state ? (state.scenarios as Record<string, unknown>) : {},
    };
  });

  /* ── scene edits ──────────────────────────────────────────────── */
  app.patch('/api/projects/:id/production/scenes/:target/:sceneId', async (req, reply) => {
    const { id, target, sceneId } = req.params as { id: string; target: string; sceneId: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const state = loadProductionState(id);
    if (!state) return reply.code(409).send({ error: 'production state not generated' });
    try {
      requireProductionTarget(state, target);
      patchProductionScene(state, target, sceneId, (req.body ?? {}) as Record<string, unknown>);
      return { production: stateSummary(p, loadProductionState(id)) };
    } catch (e) {
      if (e instanceof ProductionError) return reply.code(e.code === 'SCENE_LOCKED' ? 409 : 422).send({ error: e.message, code: e.code });
      throw e;
    }
  });

  /* ── deterministic single-scene re-roll (production equivalent) ── */
  app.post('/api/projects/:id/production/scenes/:target/:sceneId/reroll', async (req, reply) => {
    const { id, target, sceneId } = req.params as { id: string; target: string; sceneId: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const state = loadProductionState(id);
    if (!state) return reply.code(409).send({ error: 'production state not generated' });
    try {
      requireProductionTarget(state, target);
      const result = rerollProductionScene(state, target, sceneId);
      return { production: stateSummary(p, loadProductionState(id)), direction: result.direction };
    } catch (e) {
      if (e instanceof ProductionError) return reply.code(e.code === 'SCENE_LOCKED' ? 409 : 422).send({ error: e.message, code: e.code });
      throw e;
    }
  });

  /* ── dialogue (turn) edits ────────────────────────────────────── */
  app.patch('/api/projects/:id/production/turns/:target/:turnId', async (req, reply) => {
    const { id, target, turnId } = req.params as { id: string; target: string; turnId: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const state = loadProductionState(id);
    if (!state) return reply.code(409).send({ error: 'production state not generated' });
    try {
      requireProductionTarget(state, target);
      patchProductionTurn(state, target, turnId, (req.body ?? {}) as Record<string, unknown>);
      return { production: stateSummary(p, loadProductionState(id)) };
    } catch (e) {
      if (e instanceof ProductionError) return reply.code(422).send({ error: e.message, code: e.code, details: e.details });
      throw e;
    }
  });

  /* ── asset bindings ───────────────────────────────────────────── */
  app.get('/api/projects/:id/production/assets', async (req) => {
    const { id } = req.params as { id: string };
    const assets = loadAssetIndex();
    const eligible = eligibleBindingAssets(assets);
    return {
      assets: eligible,
      ineligibleCount: assets.length - eligible.length,
      /**
       * Additive product clarity: the eligible set is images only, and every
       * excluded asset carries the deterministic reason.
       */
      eligibleMimePrefix: 'image/',
      eligibleRule:
        'generated media slots are screen-insert images: active, not blocked, real source+license, MIME image/*, non-image kinds excluded',
      ineligible: ineligibleBindingAssets(assets),
    };
  });

  app.put('/api/projects/:id/production/assets/:target/:logicalRef', async (req, reply) => {
    const { id, target, logicalRef } = req.params as { id: string; target: string; logicalRef: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const state = loadProductionState(id);
    if (!state) return reply.code(409).send({ error: 'production state not generated' });
    const body = (req.body ?? {}) as { assetId?: string };
    if (!body.assetId) return reply.code(400).send({ error: 'assetId is required' });
    const asset = loadAssetIndex().find((a) => a.id === body.assetId);
    if (!asset) return reply.code(404).send({ error: 'asset not found' });
    const verdict = assetBindingEligibility(asset);
    if (!verdict.eligible) {
      return reply.code(422).send({
        error: `asset is not eligible for a generated image slot: ${verdict.reason}`,
        code: 'ASSET_NOT_RENDERABLE',
        details: { assetId: asset.id, kind: asset.kind, mimeType: asset.mimeType, reason: verdict.reason },
      });
    }
    try {
      requireProductionTarget(state, target);
      setProductionAssetBinding(state, target, logicalRef, body.assetId);
      return { production: stateSummary(p, loadProductionState(id)) };
    } catch (e) {
      if (e instanceof ProductionError) return reply.code(422).send({ error: e.message, code: e.code });
      throw e;
    }
  });

  app.delete('/api/projects/:id/production/assets/:target/:logicalRef', async (req, reply) => {
    const { id, target, logicalRef } = req.params as { id: string; target: string; logicalRef: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const state = loadProductionState(id);
    if (!state) return reply.code(409).send({ error: 'production state not generated' });
    try {
      requireProductionTarget(state, target);
      setProductionAssetBinding(state, target, logicalRef, null);
      return { production: stateSummary(p, loadProductionState(id)) };
    } catch (e) {
      if (e instanceof ProductionError) return reply.code(422).send({ error: e.message, code: e.code });
      throw e;
    }
  });

  /* ── production plan build (audio + Phase 5 + 6A) ─────────────── */
  app.post('/api/projects/:id/production/build', async (req, reply) => {
    const { id } = req.params as { id: string };
    /* VS3: the plan build drives every render; cloned audio must be approved
     * for the current inputs first (no-op when no cloned voice is selected). */
    const buildGate = clonedAudioRenderGate(id);
    if (!buildGate.allowed) {
      return reply.code(409).send({
        error: buildGate.reason,
        clonedAudioGate: buildGate,
        blockReason: buildGate.findings[0]?.message ?? buildGate.reason,
      });
    }
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const state = loadProductionState(id);
    if (!state) return reply.code(409).send({ error: 'production state not generated' });
    if (isStaleAgainstInput(state, p.meta.input)) {
      return reply.code(409).send({ error: 'production state is stale: ProjectInput changed after generation. Regenerate first.', code: 'STALE_INPUT' });
    }
    const body = (req.body ?? {}) as { target?: string };
    try {
      const assets = loadAssetIndex();
      const assetUrlById: Record<string, string> = {};
      for (const a of eligibleBindingAssets(assets)) {
        assetUrlById[a.id] = `/media/asset/${a.id}`;
      }
      for (const k of Object.keys(assetUrlById)) assetUrlById[k] = `http://127.0.0.1:${localPort(app)}/media/asset/${k}`;

      if (body.target) {
        requireProductionTarget(state, body.target);
        const plan = await buildTargetPlan(state, body.target, productionAudioPlanPaths(id), assets, assetUrlById);
        return {
          target: plan.target,
          mediaMap: plan.mediaMap,
          resolution: plan.resolution,
          planSummary: { scenarioId: plan.plan.scenarioId, durationInFrames: plan.plan.durationInFrames, totalActualDurationSeconds: plan.plan.totalActualDurationSeconds },
        };
      }
      const plans = await buildAllTargetPlans(state, productionAudioPlanPaths(id), assets, assetUrlById);
      return {
        targets: plans.map((pl) => ({
          target: pl.target,
          scenarioId: pl.plan.scenarioId,
          durationInFrames: pl.plan.durationInFrames,
          mediaMap: pl.mediaMap,
          unresolvedRequired: pl.resolution.bindings.filter((b) => b.required && !b.resolved).map((b) => b.assetRef),
          /**
           * The same asset-resolution DTO the single-target response returns:
           * it carries the resolved asset usage per scene, which acceptance
           * uses to prove the asset was really composited into its planned
           * display window. It is derived from the plan already built above
           * (no extra work, no extra synthesis).
           */
          resolution: pl.resolution,
        })),
      };
    } catch (e) {
      return productionErrorReply(reply, e);
    }
  });

  /* ── reconciled production captions ───────────────────────────── */
  app.get('/api/projects/:id/production/captions/:target', async (req, reply) => {
    const { id, target } = req.params as { id: string; target: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const state = loadProductionState(id);
    if (!state) return reply.code(409).send({ error: 'production state not generated' });
    try {
      requireProductionTarget(state, target);
      const assets = loadAssetIndex();
      const assetUrlById: Record<string, string> = {};
      for (const a of eligibleBindingAssets(assets)) assetUrlById[a.id] = `http://127.0.0.1:${localPort(app)}/media/asset/${a.id}`;
      const plan = await buildTargetPlan(state, target, productionAudioPlanPaths(id), assets, assetUrlById);
      return { target, captions: productionCaptionsForTarget(plan.plan), audioEngine: PRODUCTION_AUDIO_ENGINE };
    } catch (e) {
      return productionErrorReply(reply, e);
    }
  });

  /* ── preview (plan-based, production audio, reduced quality) ──── */
  app.post('/api/projects/:id/production/preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const state = loadProductionState(id);
    if (!state) return reply.code(409).send({ error: 'production state not generated' });
    if (isStaleAgainstInput(state, p.meta.input)) {
      return reply.code(409).send({ error: 'production state is stale: regenerate first.', code: 'STALE_INPUT' });
    }
    /**
     * Optional target subset: `{ targets: ['short_1'] }` renders only those
     * generated targets (a cheap early smoke for one target). Omitting it keeps
     * the original behaviour exactly: every generated target of the project.
     */
    const body = (req.body ?? {}) as { targets?: unknown };
    let targets: string[] | undefined;
    if (body.targets !== undefined) {
      if (!Array.isArray(body.targets) || body.targets.length === 0 || body.targets.some((t) => typeof t !== 'string')) {
        return reply.code(422).send({ error: 'targets must be a non-empty array of target ids', code: 'INVALID_TARGETS' });
      }
      targets = body.targets as string[];
      try {
        for (const t of targets) requireProductionTarget(state, t);
      } catch (e) {
        if (e instanceof ProductionError) return reply.code(422).send({ error: e.message, code: e.code });
        throw e;
      }
    }
    return startProductionJob(app, id, p, state, 'preview', targets);
  });

  /* ── final export (plan-based + Phase 6D package) ─────────────── */
  app.post('/api/projects/:id/production/export', async (req, reply) => {
    const { id: gateVideoId } = req.params as { id: string };
    const clonedGate = clonedAudioRenderGate(gateVideoId);
    if (!clonedGate.allowed) {
      return reply.code(409).send({
        error: clonedGate.reason,
        clonedAudioGate: clonedGate,
        blockReason: clonedGate.findings[0]?.message ?? clonedGate.reason,
      });
    }
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const state = loadProductionState(id);
    if (!state) return reply.code(409).send({ error: 'production state not generated' });
    if (isStaleAgainstInput(state, p.meta.input)) {
      return reply.code(409).send({ error: 'production state is stale: regenerate first.', code: 'STALE_INPUT' });
    }
    return startProductionJob(app, id, p, state, 'final');
  });

  /* ── delete sidecar when the project is deleted (safety net) ──── */
  app.delete('/api/projects/:id/production', async (req) => {
    const { id } = req.params as { id: string };
    deleteProductionState(id);
    return { ok: true };
  });

  /* ── production job polling ───────────────────────────────────── */
  app.get('/api/projects/:id/production/jobs/:jobId', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const j = productionJobRegistry.get(jobId);
    if (!j) return reply.code(404).send({ status: 'unknown' });
    return j;
  });

  /* ── production history (casting/style observations) ──────────── */
  app.get('/api/production-history', async () => ({ entries: loadProductionHistory() }));
}

/* ------------------------------------------------------------------ */
/*  Job plumbing (same Fastify app, own registry for production jobs)  */
/* ------------------------------------------------------------------ */

export interface ProductionJob {
  status: 'running' | 'done' | 'failed';
  kind: 'preview' | 'final';
  log: string[];
  startedAt: string;
  result?: unknown;
  error?: string;
}

const productionJobRegistry = new Map<string, ProductionJob>();

function localPort(app: FastifyInstance): number {
  const a = app.server.address();
  return typeof a === 'object' && a ? a.port : 3000;
}

function productionErrorReply(reply: { code: (n: number) => { send: (x: unknown) => unknown } }, e: unknown) {
  if (e instanceof ProductionError) {
    const cacheMiss = /provision:tts/.test(e.message);
    return reply.code(cacheMiss ? 503 : 422).send({ error: e.message, code: e.code, ...(cacheMiss ? { fix: 'npm run provision:tts' } : {}), details: e.details });
  }
  throw e;
}

function startProductionJob(
  app: FastifyInstance,
  id: string,
  p: Project,
  state: ProductionState,
  kind: 'preview' | 'final',
  targets?: readonly string[],
) {
  const jobId = `${id}:production-${kind}:${Date.now()}`;
  const job: ProductionJob = { status: 'running', kind, log: [], startedAt: new Date().toISOString() };
  productionJobRegistry.set(jobId, job);
  const log = (m: string) => {
    job.log.push(`${new Date().toISOString().slice(11, 19)}  ${m}`);
    if (job.log.length > 500) job.log.splice(0, 100);
  };

  void (async () => {
    try {
      const assets = loadAssetIndex();
      const assetUrlById: Record<string, string> = {};
      for (const a of eligibleBindingAssets(assets)) assetUrlById[a.id] = `http://127.0.0.1:${localPort(app)}/media/asset/${a.id}`;

      log(`building production plans (audio engine: ${PRODUCTION_AUDIO_ENGINE}, cache-only)`);
      const allPlans = await buildAllTargetPlans(state, productionAudioPlanPaths(id), assets, assetUrlById);
      const plans = targets && targets.length > 0
        ? allPlans.filter((plan) => targets.includes(plan.target))
        : allPlans;
      if (targets && targets.length > 0) log(`target subset requested: ${targets.join(', ')} (${plans.length} plan(s) built)`);

      log(`running ${kind} build through Phase 6C${kind === 'final' ? ' + Phase 6D package' : ''}`);
      const result = await runProductionBuild({ project: p, state, kind, plans, onLog: log });

      /*
       * PRODUCTION HISTORY GATE (audit item E).
       *
       * `status === 'ok'` only means the render returned ok. A history
       * observation may be appended ONLY after a genuinely successful, ready
       * final delivery: ready Phase 6D package, written product kit, readiness
       * `ready` with no blocking finding. Partial renders, failed/blocked
       * packages, incomplete kits and deliverable-writer failures never enter
       * the cross-project history.
       */
      if (kind === 'final') {
        if (productionHistoryEligible(kind, state)) {
          const obs = personaObservationFromState(state);
          appendProductionHistoryEntry({ videoId: id, at: new Date().toISOString(), casting: obs.personas, styleFingerprint: obs.styleFingerprint ?? '' });
          log('production history updated (casting/style observation recorded)');
        } else {
          log(
            `production history NOT updated: the final delivery is not ready ` +
              `(render=${String(result.status)}, package=${String(result.packageStatus ?? 'none')}, ` +
              `readiness=${String(result.readiness?.status ?? 'none')}, readyForProductionDelivery=${String(result.readiness?.readyForProductionDelivery ?? false)}, ` +
              `productKit=${String(result.productKit ?? 'none')})`,
          );
        }
      }

      job.status = 'done';
      job.result = result;
    } catch (e) {
      job.status = 'failed';
      job.error = e instanceof Error ? e.message : String(e);
      log(`FAILED: ${job.error}`);
      if (e instanceof ProductionError && /provision:tts/.test(job.error ?? '')) {
        log('fix: npm run provision:tts');
      }
    }
  })();

  return { jobId, status: 'running' };
}

/**
 * PRODUCTION HISTORY GATE (audit item E), exported so the exact production code
 * path can be tested without rendering: a casting/style observation may be
 * appended only for a FINAL build whose delivery genuinely succeeded (ready
 * Phase 6D package + written product kit + ready readiness with no blocking
 * finding). A render that merely returned `ok`, a partial render, a failed or
 * blocked package, an incomplete kit and a failed deliverable writer all fail
 * this gate.
 */
export function productionHistoryEligible(kind: 'preview' | 'final', state: ProductionState): boolean {
  return kind === 'final' && finalDeliverySucceeded(state);
}

/** Exposed for API-level tests. */
export { TARGETS, eligibleBindingAssets, ineligibleBindingAssets };
