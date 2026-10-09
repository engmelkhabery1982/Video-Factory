import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  EXPLANATION_VARIANTS,
  HOOK_VARIANTS,
  BACKGROUND_VARIANTS,
  TRANSITION_VARIANTS,
  TEXT_POSITIONS,
  CAPTION_STYLES,
  CTA_ANIMATIONS,
  GLOSSARY,
  getBrandPreset,
  BRAND_PRESETS,
  retimeCues,
  recomputeSimilarity,
  type ProjectInput,
  type Scene,
  type Project,
  type TargetAudioMap,
  exportTargetIds,
  usesExternalReadyNarration,
  type NarrationSource,
} from '@buildtrack/core';
import { generateStoryboard, listProjects, loadHistory, loadProject, newProject, saveHistory, saveProject } from '../services/store.js';
import {
  invalidateDownstreamForInputChange,
  isStaleAgainstInput,
  loadProductionHistory,
  loadProductionState,
  productionStateFile,
  saveProductionState,
} from '../services/production-state.js';
import { productionStatusFor } from '../services/production-engine.js';
import { loadAssetIndex } from './assets.js';
import { ASSETS_DIR, OUTPUT_DIR, projectAssetDir, projectDir, run } from '../services/platform.js';
import { durationOf } from '../services/media.js';
import { resolveTargetAudio, shortTimingOptions } from '../services/targets.js';
import { exportProject, runQc, writeCaptions, writeMetadata } from '../services/pipeline.js';
import { clonedAudioRenderGate } from '../services/voice-audio-gate.js';
import { externalNarrationRenderGate } from '../services/external-audio-gate.js';
import {
  cleanupExportAudioJob,
  exportValidationHooks,
  freezeApprovedAudio,
  readExportIdentity,
  sameExportIdentity,
  type ExportIdentity,
} from '../services/export-snapshot.js';

/**
 * Test seam. Production calls the real renderer. A regression replaces
 * `exportProject` so a coherence failure cannot start a real render.
 */
export const finalExportSeam = {
  exportProject,
  resolveTargetAudio,
};

/** in-flight render jobs, so the UI can poll progress */
const jobs = new Map<string, { status: string; log: string[]; startedAt: string; result?: unknown; error?: string }>();

const MEDIA_LIST_FIELDS = ['productShots', 'brollFiles'] as const;

function receivedType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Media lists are required string arrays on create. An omitted list is not a
 * stored empty array. A supplied invalid value is rejected, not erased.
 * An ordinary update validates only the lists it actually supplies.
 */
export function mediaListRejection(input: Record<string, unknown>, requirePresent: boolean): { error: string; code: 'INVALID_MEDIA_LIST' } | null {
  const errors: string[] = [];
  for (const field of MEDIA_LIST_FIELDS) {
    const present = Object.prototype.hasOwnProperty.call(input, field);
    if (!present) {
      if (requirePresent) errors.push(`${field} is required and must be an array of strings. Send [] when there are none.`);
      continue;
    }
    const value = input[field];
    if (!Array.isArray(value)) {
      errors.push(`${field} must be an array of strings, received ${receivedType(value)}.`);
      continue;
    }
    const bad = value.findIndex((item) => typeof item !== 'string');
    if (bad >= 0) errors.push(`${field} must contain only strings. Member at index ${bad} is ${receivedType(value[bad])}.`);
  }
  if (errors.length === 0) return null;
  return { error: errors.join(' '), code: 'INVALID_MEDIA_LIST' };
}

export async function registerProjectRoutes(app: FastifyInstance) {
  app.get('/api/variants', async () => ({
    hooks: HOOK_VARIANTS,
    explanations: EXPLANATION_VARIANTS,
    transitions: TRANSITION_VARIANTS,
    backgrounds: BACKGROUND_VARIANTS,
    textPositions: TEXT_POSITIONS,
    captionStyles: CAPTION_STYLES,
    ctaAnimations: CTA_ANIMATIONS,
    glossary: GLOSSARY,
    brands: Object.values(BRAND_PRESETS),
  }));

  app.get('/api/projects', async () => {
    const ids = listProjects();
    return {
      projects: ids.map((id) => {
        const p = loadProject(id);
        /**
         * PRODUCTION summary (additive).
         *
         * For projects with production state the list surfaces the PRODUCTION
         * status — not the legacy `meta.status` — plus targets, the latest
         * production build/artifact count and the stale/needs-regeneration
         * flag. `meta.status` stays present for legacy/reference projects.
         */
        const state = loadProductionState(id);
        let production: Record<string, unknown> | null = null;
        if (state && p) {
          const stale = state.inputFingerprint !== null && state.status !== undefined
            ? isStaleAgainstInput(state, p.meta.input)
            : false;
          const lastBuild = state.builds.length ? state.builds[state.builds.length - 1] : null;
          /*
           * Stale input => no derived record is current: builds, artifacts,
           * readiness and the product kit all describe the replaced content.
           * They are reported as absent rather than as current state.
           */
          production = {
            exists: true,
            status: stale ? 'needs_regeneration' : productionStatusFor(state, p),
            stale,
            targets: Object.keys(state.scenarios),
            artifactCount: stale ? 0 : state.artifacts.length,
            buildCount: stale ? 0 : state.builds.length,
            lastBuild: !stale && lastBuild ? { kind: lastBuild.kind, status: lastBuild.status, at: lastBuild.at } : null,
            readiness: !stale && state.lastReadiness ? { status: state.lastReadiness.status, readyForProductionDelivery: state.lastReadiness.readyForProductionDelivery } : null,
            packageStatus: stale ? null : (state.lastQcSummary?.packageStatus ?? null),
            hasProductKit: !stale && Boolean(state.productKitPath),
          };
        }
        return {
          videoId: id,
          topic: p?.meta.input.topic,
          status: p?.meta.status,
          updatedAt: p?.meta.updatedAt,
          scenes: p?.storyboard.long.scenes.length ?? 0,
          shorts: p?.storyboard.shorts.length ?? 0,
          similarity: p?.storyboard.similarity?.score ?? null,
          artifacts: p?.artifacts.length ?? 0,
          production,
        };
      }),
      history: loadHistory(),
      /**
       * The REAL production casting/style history (the anti-repetition authority
       * for production projects). `history` above remains the legacy visual
       * history for legacy/reference projects only.
       */
      productionHistory: loadProductionHistory(),
    };
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const l = path.join(OUTPUT_DIR, id);
    return { project: p, outputDir: l, assets: loadAssetIndex(), history: loadHistory() };
  });

  app.post('/api/projects', async (req, reply) => {
    const raw = req.body as ProjectInput & { narrationSource?: unknown };
    if (!raw?.videoId) return reply.code(400).send({ error: 'videoId is required' });
    if (raw.narrationSource !== undefined && raw.narrationSource !== null && raw.narrationSource !== 'in_app_dialogue' && raw.narrationSource !== 'external_ready') {
      return reply.code(400).send({ error: 'narrationSource must be in_app_dialogue or external_ready.', code: 'INVALID_NARRATION_SOURCE' });
    }
    const mediaError = mediaListRejection(raw as unknown as Record<string, unknown>, true);
    if (mediaError) return reply.code(400).send(mediaError);
    if (loadProject(raw.videoId)) return reply.code(409).send({ error: 'A project with that Video ID already exists' });
    const input = { ...raw } as ProjectInput;
    if (raw.narrationSource === undefined || raw.narrationSource === null) delete input.narrationSource;
    const project = newProject(input);
    saveProject(project);
    return { project };
  });

  app.put('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const body = req.body as { input?: Partial<ProjectInput> & { narrationSource?: unknown } };
    if (body?.input) {
      const mediaError = mediaListRejection(body.input as unknown as Record<string, unknown>, false);
      if (mediaError) return reply.code(400).send(mediaError);
      // Saving the form must not switch the narration source. That is a separate explicit action.
      const { narrationSource: _ignored, ...rest } = body.input;
      void _ignored;
      p.meta.input = { ...p.meta.input, ...rest } as ProjectInput;
      p.meta.updatedAt = new Date().toISOString();
      saveProject(p);

      /*
       * Changing the ProjectInput invalidates everything derived from the
       * Scenarios generated from the OLD input. Invalidate the production state
       * immediately (not only defensively at read time) so old builds, package
       * artifacts, QC/readiness and the product-kit link stop being current.
       */
      const state = loadProductionState(id);
      if (state && isStaleAgainstInput(state, p.meta.input)) {
        invalidateDownstreamForInputChange(state);
        saveProductionState(state);
      }
    }
    return { project: p };
  });

  app.delete('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    fs.rmSync(projectDir(id), { recursive: true, force: true });
    return { ok: true };
  });

  /* ---------------- storyboard ---------------- */

  app.post('/api/projects/:id/storyboard', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const opts = (req.body ?? {}) as { preserveEdits?: boolean };

    // each target is timed to its own narration; Long <- voiceoverFile only
    const targetAudio = await resolveTargetAudio(p);
    const audioDuration = targetAudio.long?.durationSec ?? null;
    const audioFile = targetAudio.long?.file ?? null;

    const assets = loadAssetIndex();
    const projectAssetIds = assets.filter((a) => (a.kind === 'broll' || a.kind === 'screenshot' || a.kind === 'document') && a.status === 'active').map((a) => a.id);

    const updated = generateStoryboard(p, loadHistory(), {
      audioDuration,
      ...shortTimingOptions(targetAudio),
      assetIds: projectAssetIds,
      hasMedia: projectAssetIds.length > 0,
      preserveEdits: opts.preserveEdits !== false,
    });
    return { project: updated, audioDuration, audioFile };
  });

  /* ---------------- scene editing (brief section 13) ---------------- */

  app.patch('/api/projects/:id/scenes/:sceneId', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const patch = req.body as Partial<Scene> & { reset?: boolean };
    const all: Scene[] = [...p.storyboard.long.scenes, ...p.storyboard.shorts.flatMap((s) => s.scenes)];
    const scene = all.find((s) => s.id === sceneId);
    if (!scene) return reply.code(404).send({ error: 'scene not found' });

    if (patch.reset) {
      scene.locked = false;
      scene.userEdited = false;
    } else {
      const editable: (keyof Scene)[] = ['variant', 'background', 'transitionIn', 'textPosition', 'duration', 'content', 'assetIds', 'locked', 'accent'];
      for (const k of editable) {
        if (k in patch && (patch as any)[k] !== undefined) (scene as any)[k] = (patch as any)[k];
      }
      scene.userEdited = true;
    }

    // A presentation-only edit must not rewrite speech timing. Duration edits
    // still recompute the contiguous timeline.
    if (patch.reset || patch.duration !== undefined) retimeProject(p, scene);
    p.meta.updatedAt = new Date().toISOString();
    saveProject(p);
    return { project: p };
  });

  app.post('/api/projects/:id/regenerate-scene/:sceneId', async (req, reply) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const all: Scene[] = [...p.storyboard.long.scenes, ...p.storyboard.shorts.flatMap((s) => s.scenes)];
    const scene = all.find((s) => s.id === sceneId);
    if (!scene) return reply.code(404).send({ error: 'scene not found' });
    if (scene.locked) return reply.code(409).send({ error: 'Scene is locked. Unlock it first.' });

    // offer the strongest unused alternative for this scene's function
    const used = new Set(all.map((s) => s.variant));
    const candidates = EXPLANATION_VARIANTS.filter((v) => v.fits.includes(scene.reason.detected.includes('=') ? guessFn(scene.reason.detected) : guessFn(scene.reason.detected)));
    const pick = candidates.find((c) => !used.has(c.id)) ?? candidates[0];
    if (!pick) return reply.code(400).send({ error: 'no alternative variant available' });
    scene.variant = pick.id as Scene['variant'];
    scene.reason.evidence = `Manually re-rolled to "${pick.label}" by the operator. ${pick.id} fits the scene function.`;
    scene.userEdited = true;
    retimeProject(p, scene);
    saveProject(p);
    return { project: p };
  });

  app.post('/api/projects/:id/regenerate', async (req) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return { error: 'not found' };
    const external = usesExternalReadyNarration(p.meta.input);
    const targetAudio = external ? await resolveTargetAudio(p) : null;
    const updated = generateStoryboard(p, loadHistory(), {
      preserveEdits: !external,
      ...(external ? { audioDuration: targetAudio?.long?.durationSec ?? null } : {}),
    });
    return { project: updated };
  });

  /* Explicit narration-source transition. Opening a page does not call this. */
  app.post('/api/projects/:id/narration-source', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const body = (req.body ?? {}) as { narrationSource?: unknown; confirm?: boolean };
    if (body.confirm !== true) {
      return reply.code(400).send({
        error: 'Switching narration source requires an explicit confirmation. Opening a page does not switch it.',
        code: 'CONFIRMATION_REQUIRED',
      });
    }
    if (body.narrationSource !== 'in_app_dialogue' && body.narrationSource !== 'external_ready') {
      return reply.code(400).send({ error: 'narrationSource must be in_app_dialogue or external_ready.', code: 'INVALID_NARRATION_SOURCE' });
    }
    const source = body.narrationSource as NarrationSource;
    const hadProduction = fs.existsSync(productionStateFile(id));
    p.meta.input = { ...p.meta.input, narrationSource: source };
    p.meta.updatedAt = new Date().toISOString();
    saveProject(p);
    let project = p;
    if (source === 'external_ready') {
      const targetAudio = await resolveTargetAudio(p);
      project = generateStoryboard(p, loadHistory(), { audioDuration: targetAudio.long?.durationSec ?? null, preserveEdits: false });
    }
    return {
      project,
      productionPreserved: hadProduction && fs.existsSync(productionStateFile(id)),
      narrationSource: source,
    };
  });

  /* ---------------- captions ---------------- */

  app.patch('/api/projects/:id/captions/:cueId', async (req, reply) => {
    const { id, cueId } = req.params as { id: string; cueId: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const body = req.body as { text?: string; start?: number; end?: number };
    const i = p.storyboard.captions.findIndex((c) => c.id === cueId);
    if (i < 0) return reply.code(404).send({ error: 'cue not found' });
    if (body.text !== undefined) p.storyboard.captions[i] = { ...p.storyboard.captions[i], text: body.text, userEdited: true };
    if (body.start !== undefined || body.end !== undefined) {
      const c = p.storyboard.captions[i];
      p.storyboard.captions = retimeCues(p.storyboard.captions, cueId, body.start ?? c.start, body.end ?? c.end);
    }
    saveProject(p);
    return { project: p };
  });

  app.post('/api/projects/:id/captions/rebuild', async (req) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return { error: 'not found' };
    const targetAudio = await resolveTargetAudio(p);
    const dur: number | null = targetAudio.long?.durationSec ?? p.storyboard.long.totalDuration;
    const updated = generateStoryboard(p, loadHistory(), { audioDuration: dur, ...shortTimingOptions(targetAudio), preserveEdits: true });
    return { project: updated };
  });

  /* ---------------- history / similarity ---------------- */

  app.get('/api/history', async () => loadHistory());

  app.post('/api/projects/:id/recheck-similarity', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const history = loadHistory();
    const entry = history.videos.find((v) => v.videoId === id);
    if (!entry) return reply.code(400).send({ error: 'no history entry for this project yet' });
    const sim = recomputeSimilarity(p.storyboard, entry, id, history);
    p.storyboard.similarity = sim;
    saveProject(p);
    return { similarity: sim, project: p };
  });

  /* ---------------- QC ---------------- */

  app.get('/api/projects/:id/qc', async (req) => {
    const { id } = req.params as { id: string };
    return { qc: loadProject(id)?.qc ?? [] };
  });

  app.post('/api/projects/:id/qc', async (req) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return { error: 'not found' };
    const body = req.body as { target?: 'long' | 'short_1' | 'short_2' | 'short_3' | 'thumbnails' | 'captions'; file?: string; override?: { reason: string } | null };
    const target = body.target ?? 'long';
    const res = await runQc({ project: p, history: loadHistory(), target, file: body.file ?? null, override: body.override ?? null });
    p.qc = p.qc.filter((q) => q.target !== target);
    p.qc.push(res.report);
    saveProject(p);
    return res;
  });

  /* ---------------- export (background job) ---------------- */

  app.post('/api/projects/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const body = (req.body ?? {}) as { kind?: 'preview' | 'final'; override?: { reason: string } | null; includeShorts?: boolean; includeThumbnails?: boolean };
    const kind = body.kind ?? 'final';

    /* VS3: cloned audio must be authorized, generated and approved for the
     * CURRENT inputs before ANY final render. Without a cloned voice this is
     * `notApplicable` and the existing flow is untouched. */
    if (kind === 'final') {
      const gate = clonedAudioRenderGate(id);
      if (!gate.allowed) {
        return reply.code(409).send({
          error: gate.reason,
          clonedAudioGate: gate,
          blockReason: gate.findings[0]?.message ?? gate.reason,
        });
      }
    }

    /* VS4/VS6: narration imported from outside the app must pass the same
     * readiness the review shows, for the targets this request will actually
     * render. The check reloads the project and the audio bytes; it does not
     * reuse a previous response. Projects without an import are not affected.
     * A QC override does not bypass this gate. Preview is not this check. */
    let exportProjectSnapshot = p;
    let exportIdentity: ExportIdentity | null = null;
    let frozenAudio: TargetAudioMap | null = null;
    let scratchToken: string | null = null;
    if (kind === 'final') {
      const requestedTargetIds = exportTargetIds(p, { includeShorts: body.includeShorts });
      const externalGate = await externalNarrationRenderGate(id, { requestedTargetIds });
      if (!externalGate.notApplicable && !externalGate.allowed) {
        return reply.code(409).send({
          error: externalGate.reason,
          externalNarrationGate: {
            blockedCodes: externalGate.blockedCodes,
            findings: externalGate.findings,
            targets: externalGate.targets
              .filter((t) => requestedTargetIds.includes(t.targetId))
              .map((t) => ({
                targetId: t.targetId,
                label: t.label,
                ready: t.ready,
                summary: t.summary,
                blockReasons: t.blockReasons,
                audioDurationSec: t.audioDurationSec,
                timelineDurationSec: t.timelineDurationSec,
                readiness: t.readiness,
              })),
          },
          blockReason: externalGate.findings[0]?.message ?? externalGate.reason,
        });
      }
      if (externalGate.identity) {
        if (!externalGate.approvedProject) {
          return reply.code(409).send({
            error: 'The project or narration changed during validation.',
            blockReason: 'Export was not started. The approved check does not apply to the project or audio now on disk.',
          });
        }
        await exportValidationHooks.beforeConsume?.();
        const current = readExportIdentity(id, externalGate.identity.reviewTargets);
        if (!sameExportIdentity(current, externalGate.identity)) {
          return reply.code(409).send({
            error: 'The project or narration changed during validation.',
            blockReason: 'Export was not started. The approved check does not apply to the project or audio now on disk.',
          });
        }
        const frozen = await freezeApprovedAudio({
          project: externalGate.approvedProject,
          identity: externalGate.identity,
        });
        if (!frozen.ok) {
          return reply.code(409).send({
            error: frozen.error,
            blockReason: 'Export was not started. The approved audio bytes could not be frozen.',
          });
        }
        exportIdentity = externalGate.identity;
        exportProjectSnapshot = externalGate.approvedProject;
        frozenAudio = frozen.audio;
        scratchToken = frozen.token;
      }
    }

    if (kind === 'final') {
      // pre-export gate is an explicit PROJECT-wide check (all targets)
      const gate = await runQc({ project: exportProjectSnapshot, history: loadHistory(), target: 'project', file: null, override: body.override ?? null });
      if (gate.blocked && !body.override) {
        if (scratchToken) cleanupExportAudioJob(scratchToken);
        return reply.code(409).send({ error: 'QC blocked the final export', qc: gate.report, blockReason: gate.blockReason });
      }
    }

    const jobId = `${id}:${kind}:${Date.now()}`;
    jobs.set(jobId, { status: 'running', log: [], startedAt: new Date().toISOString() });
    const log = (m: string) => {
      const j = jobs.get(jobId);
      if (j) {
        j.log.push(`${new Date().toISOString().slice(11, 19)}  ${m}`);
        if (j.log.length > 500) j.log.splice(0, 100);
      }
    };

    void (async () => {
      try {
        if (exportIdentity && !sameExportIdentity(readExportIdentity(id, exportIdentity.reviewTargets), exportIdentity)) {
          throw new Error('The project or narration changed before rendering. Nothing was rendered.');
        }
        /* The approved project and frozen audio are the export. A later save
         * or a replacement of the original file is not reloaded into this job. */
        const rendering = exportProjectSnapshot;
        const targetAudio = frozenAudio ?? await finalExportSeam.resolveTargetAudio(rendering);
        const assets = loadAssetIndex();
        const assetUrls: Record<string, string> = {};
        for (const a of assets) {
          if (a.status === 'active' && !a.blocked) assetUrls[a.id] = `http://127.0.0.1:${localPort(app)}/media/asset/${a.id}`;
        }
        const logo = assets.find((a) => a.kind === 'logo' && a.status === 'active');
        const res = await finalExportSeam.exportProject(rendering, {
          kind,
          videoId: id,
          includeShorts: body.includeShorts,
          includeThumbnails: body.includeThumbnails,
          history: loadHistory(),
          assets,
          ctaAnimation: 'slide_in',
          captionStyle: 'boxed_center',
          targetAudio,
          assetUrls,
          logoUrl: logo ? `http://127.0.0.1:${localPort(app)}/media/asset/${logo.id}` : null,
          override: body.override ?? null,
          onLog: log,
        });
        const fresh = loadProject(id);
        if (fresh) {
          fresh.artifacts = [
            ...fresh.artifacts,
            ...res.results.filter((r) => !r.blocked || r.file).map((r) => ({
              kind,
              target: r.target as never,
              fileName: path.basename(r.file),
              relPath: path.relative(OUTPUT_DIR, r.file),
              createdAt: new Date().toISOString(),
              durationSec: Number((res.summary as any)?.results?.length ? 0 : 0),
              width: 0,
              height: 0,
              sizeBytes: fs.existsSync(r.file) ? fs.statSync(r.file).size : 0,
              probe: r.qc.metrics as Record<string, unknown>,
            })),
          ];
          fresh.qc = [...fresh.qc.filter((q) => !res.results.some((r) => q.target === r.target)), ...res.results.map((r) => r.qc)];
          fresh.meta.status = 'exported';
          fresh.meta.updatedAt = new Date().toISOString();
          saveProject(fresh);
        }
        const j = jobs.get(jobId);
        if (j) {
          j.status = 'done';
          j.result = res.summary;
        }
      } catch (e) {
        const err = e as Error;
        const j = jobs.get(jobId);
        if (j) {
          j.status = 'failed';
          j.error = err.message;
        }
        log(`FAILED: ${err.message}`);
        for (const frame of (err.stack ?? '').split('\n').slice(1, 9)) log(frame.trim());
      } finally {
        if (scratchToken) cleanupExportAudioJob(scratchToken);
      }
    })();

    return { jobId, status: 'running' };
  });

  app.get('/api/jobs/:jobId', async (req) => {
    const { jobId } = req.params as { jobId: string };
    return jobs.get(jobId) ?? { status: 'unknown' };
  });

  /* ---------------- deliverable writers ---------------- */

  app.post('/api/projects/:id/deliverables', async (req) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return { error: 'not found' };
    const captions = writeCaptions(p);
    const metadata = writeMetadata(p, loadAssetIndex());
    return { captions, metadata };
  });

  app.get('/api/projects/:id/brand', async (req) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return { error: 'not found' };
    return { brand: getBrandPreset(p.meta.input.brandPreset) };
  });

  app.get('/api/files', async () => {
    const out: { rel: string; size: number }[] = [];
    const walk = (dir: string, base: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, base);
        else out.push({ rel: path.relative(base, full).replace(/\\/g, '/'), size: fs.statSync(full).size });
      }
    };
    walk(OUTPUT_DIR, OUTPUT_DIR);
    return { root: OUTPUT_DIR, files: out };
  });
}

function localPort(app: FastifyInstance) {
  const a = app.server.address() as AddressInfo | null;
  return a?.port ?? 3000;
}

function guessFn(detected: string): never {
  const m = detected.match(/function = (\w+)/);
  return (m?.[1] ?? 'promise') as never;
}

/** Recompute start times after any duration change so the timeline stays valid. */
function retimeProject(p: Project, scene: Scene) {
  void scene;
  for (const s of p.storyboard.long.scenes) {
    if (s.startTime < 0) s.startTime = 0;
  }
  let t = 0;
  for (const s of p.storyboard.long.scenes) {
    s.startTime = Number(t.toFixed(3));
    t += s.duration;
  }
  p.storyboard.long.totalDuration = Number(t.toFixed(2));
  for (const sh of p.storyboard.shorts) {
    let at = 0;
    for (const s of sh.scenes) {
      s.startTime = Number(at.toFixed(3));
      at += s.duration;
    }
    sh.totalDuration = Number(at.toFixed(2));
  }
  // captions follow their linked scene so sync survives a duration change
  for (const c of p.storyboard.captions) {
    const sc = p.storyboard.long.scenes.find((s) => s.id === c.sceneId);
    if (sc && c.end > sc.startTime + sc.duration) c.end = Number((sc.startTime + sc.duration).toFixed(3));
  }
}

export { saveHistory, projectAssetDir, run };
