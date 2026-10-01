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
import { loadAssetIndex } from './assets.js';
import { OUTPUT_DIR } from '../services/platform.js';
import {
  appendProductionHistoryEntry,
  deleteProductionState,
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

/** Assets eligible for production binding: active, not blocked, real provenance. */
function eligibleBindingAssets(assets: Asset[]): Asset[] {
  return assets.filter(
    (a) =>
      a.status === 'active' &&
      !a.blocked &&
      typeof a.source === 'string' && a.source.trim().length > 0 &&
      typeof a.license === 'string' && a.license.trim().length > 0,
  );
}

function stateSummary(project: Project, state: ProductionState | null) {
  const stale = state ? isStaleAgainstInput(state, project.meta.input) : false;
  const status = state ? (stale ? 'needs_regeneration' : productionStatusFor(state, project)) : 'not_generated';
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
    lastBuild: state?.builds.length ? state.builds[state.builds.length - 1] : null,
    lastQcSummary: state?.lastQcSummary ?? null,
    artifacts: state?.artifacts ?? [],
    inputFingerprint: state?.inputFingerprint ?? null,
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
      const state = generateProductionState(p, loadHistory());
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
    return { assets: eligibleBindingAssets(assets), ineligibleCount: assets.length - eligibleBindingAssets(assets).length };
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
    if (!eligibleBindingAssets([asset]).length) {
      return reply.code(422).send({ error: 'asset is not eligible (must be active, not blocked, with source and license)' });
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
      const port = localPort(app);
      for (const k of Object.keys(assetUrlById)) assetUrlById[k] = `http://127.0.0.1:${port}/media/asset/${k}`;
      void port;

      if (body.target) {
        requireProductionTarget(state, body.target);
        const plan = await buildTargetPlan(state, body.target, { synthesisBasePath: `.production/${id}/audio/dialogue`, canonicalBasePath: `.production/${id}/audio/canonical` }, assets, assetUrlById);
        return {
          target: plan.target,
          mediaMap: plan.mediaMap,
          resolution: plan.resolution,
          planSummary: { scenarioId: plan.plan.scenarioId, durationInFrames: plan.plan.durationInFrames, totalActualDurationSeconds: plan.plan.totalActualDurationSeconds },
        };
      }
      const plans = await buildAllTargetPlans(state, { synthesisBasePath: `.production/${id}/audio/dialogue`, canonicalBasePath: `.production/${id}/audio/canonical` }, assets, assetUrlById);
      return {
        targets: plans.map((pl) => ({
          target: pl.target,
          scenarioId: pl.plan.scenarioId,
          durationInFrames: pl.plan.durationInFrames,
          mediaMap: pl.mediaMap,
          unresolvedRequired: pl.resolution.bindings.filter((b) => b.required && !b.resolved).map((b) => b.assetRef),
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
      const plan = await buildTargetPlan(state, target, { synthesisBasePath: `.production/${id}/audio/dialogue`, canonicalBasePath: `.production/${id}/audio/canonical` }, assets, assetUrlById);
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
    return startProductionJob(app, id, p, state, 'preview');
  });

  /* ── final export (plan-based + Phase 6D package) ─────────────── */
  app.post('/api/projects/:id/production/export', async (req, reply) => {
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
      const plans = await buildAllTargetPlans(
        state,
        { synthesisBasePath: `.production/${id}/audio/dialogue`, canonicalBasePath: `.production/${id}/audio/canonical` },
        assets,
        assetUrlById,
      );

      log(`running ${kind} build through Phase 6C${kind === 'final' ? ' + Phase 6D package' : ''}`);
      const result = await runProductionBuild({ project: p, state, kind, plans, onLog: log });

      if (kind === 'final' && result.status === 'ok') {
        const obs = personaObservationFromState(state);
        appendProductionHistoryEntry({ videoId: id, at: new Date().toISOString(), casting: obs.personas, styleFingerprint: obs.styleFingerprint ?? '' });
        log('production history updated (casting/style observation recorded)');
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

/** Exposed for API-level tests. */
export { TARGETS, eligibleBindingAssets };
