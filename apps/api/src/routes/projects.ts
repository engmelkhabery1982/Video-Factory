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
  exportTargetIds,
} from '@buildtrack/core';
import { generateStoryboard, listProjects, loadHistory, loadProject, newProject, saveHistory, saveProject } from '../services/store.js';
import {
  invalidateDownstreamForInputChange,
  isStaleAgainstInput,
  loadProductionHistory,
  loadProductionState,
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
  exportValidationHooks,
  readExportIdentity,
  sameExportIdentity,
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
    const input = req.body as ProjectInput;
    if (!input?.videoId) return reply.code(400).send({ error: 'videoId is required' });
    if (loadProject(input.videoId)) return reply.code(409).send({ error: 'A project with that Video ID already exists' });
    const project = newProject(input);
    saveProject(project);
    return { project };
  });

  app.put('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = loadProject(id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const body = req.body as { input?: Partial<ProjectInput> };
    if (body?.input) {
      p.meta.input = { ...p.meta.input, ...body.input } as ProjectInput;
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
    const updated = generateStoryboard(p, loadHistory(), { preserveEdits: true });
    return { project: updated };
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
    let exportIdentity = null as ReturnType<typeof readExportIdentity>;
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
        await exportValidationHooks.beforeConsume?.();
        const current = readExportIdentity(id);
        if (!sameExportIdentity(current, externalGate.identity)) {
          return reply.code(409).send({
            error: 'The project or narration changed during validation.',
            blockReason: 'Export was not started. The approved check does not apply to the project or audio now on disk.',
          });
        }
        exportIdentity = externalGate.identity;
        exportProjectSnapshot = loadProject(id) ?? p;
      }
    }

    if (kind === 'final') {
      // pre-export gate is an explicit PROJECT-wide check (all targets)
      const gate = await runQc({ project: exportProjectSnapshot, history: loadHistory(), target: 'project', file: null, override: body.override ?? null });
      if (gate.blocked && !body.override) {
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
        if (exportIdentity && !sameExportIdentity(readExportIdentity(id), exportIdentity)) {
          throw new Error('The project or narration changed before rendering. Nothing was rendered.');
        }
        const rendering = loadProject(id) ?? exportProjectSnapshot;
        const targetAudio = await finalExportSeam.resolveTargetAudio(rendering);
        if (exportIdentity && !sameExportIdentity(readExportIdentity(id), exportIdentity)) {
          throw new Error('The project or narration changed before rendering. Nothing was rendered.');
        }
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
        const j = jobs.get(jobId);
        if (j) {
          j.status = 'failed';
          j.error = (e as Error).message;
        }
        log(`FAILED: ${(e as Error).message}`);
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
