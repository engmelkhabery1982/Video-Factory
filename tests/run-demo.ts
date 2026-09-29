/**
 * Demo runner - creates the three required BuildTrack demo projects, generates
 * their storyboards and performs a real Final Export (long + 3 shorts +
 * thumbnails), then writes a verification report.
 *
 * Usage:  npm run demo
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_PROJECTS } from './fixtures/demo-projects.js';
import { ensureDirs, OUTPUT_DIR, prepareBrowserEnv, DATA_DIR } from '../apps/api/src/services/platform.js';
import { loadHistory, loadProject, newProject, saveProject, generateStoryboard, saveHistory } from '../apps/api/src/services/store.js';
import { exportProject } from '../apps/api/src/services/pipeline.js';
import { seedBrandAssets, saveAssetIndex, loadAssetIndex } from '../apps/api/src/routes/assets.js';
import { durationOf } from '../apps/api/src/services/media.js';
import { resolveTargetAudio } from '../apps/api/src/services/targets.js';
import { SHORT_IDS, targetNarration, type ShortId } from '../packages/core/src/index.js';

const t0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`[${stamp()}] ${m}`);

/** `target` is 'long' or a Short id; each target has its own narration file. */
async function registerVoiceover(videoId: string, target: 'long' | ShortId = 'long'): Promise<string> {
  const stem = target === 'long' ? videoId : `${videoId}_${target}`;
  const rel = `voiceover/${stem}.mp3`;
  const abs = path.join(DATA_DIR, rel);
  if (!fs.existsSync(abs)) throw new Error(`Missing narration: ${abs} - run \`npm run voiceovers\``);
  const list = loadAssetIndex();
  if (!list.some((a) => a.path.endsWith(rel))) {
    list.push({
      id: `voiceover-${stem.toLowerCase()}`,
      name: `${stem} narration`,
      kind: 'broll',
      fileName: `${stem}.mp3`,
      path: rel,
      mimeType: 'audio/mpeg',
      sizeBytes: fs.statSync(abs).size,
      durationSec: await durationOf(abs),
      tags: ['voiceover', 'narration'],
      status: 'active',
      preferred: true,
      source: 'Synthesised narration for the demo',
      license: 'Demo asset',
      addedAt: new Date().toISOString(),
      usedIn: [],
      blocked: false,
    });
    saveAssetIndex(list);
  }
  return rel;
}

async function main() {
  ensureDirs();
  prepareBrowserEnv();
  seedBrandAssets();

  // `npm run demo`            -> every demo project
  // `npm run demo Video_02`   -> one project only
  const arg = process.argv[2] ?? null;
  const only = !arg || arg === 'all' ? null : arg;
  const includeShorts = process.env.DEMO_SHORTS !== '0';
  const includeThumbs = process.env.DEMO_THUMBS !== '0';
  // DEMO_TARGETS=short_1 renders only the listed targets (bounded verification)
  const onlyTargets = process.env.DEMO_TARGETS ? process.env.DEMO_TARGETS.split(',').map((x) => x.trim()) : null;

  const summary: any[] = [];
  let history = loadHistory();

  for (const input of DEMO_PROJECTS) {
    if (only && input.videoId !== only) continue;
    log(`=== ${input.videoId}: ${input.topic} ===`);

    const voicePath = await registerVoiceover(input.videoId);
    const shortCount = Math.max(0, Math.min(3, input.shortCount ?? 3));
    const targetAudioRefs: Partial<Record<ShortId, string>> = {};
    for (const sid of SHORT_IDS.slice(0, shortCount)) targetAudioRefs[sid] = await registerVoiceover(input.videoId, sid);
    const enriched = { ...input, voiceoverFile: voicePath, targetAudio: targetAudioRefs };

    let project = loadProject(input.videoId);
    if (!project) {
      project = newProject(enriched);
      saveProject(project);
    } else {
      project.meta.input = enriched;
      saveProject(project);
    }

    const audioDuration = await durationOf(path.join(DATA_DIR, voicePath));
    log(`narration: ${audioDuration.toFixed(1)}s`);

    const targetAudio = await resolveTargetAudio(project);
    const shortAudioDurations = Object.fromEntries(SHORT_IDS.map((sid) => [sid, targetAudio[sid]?.durationSec ?? null]));
    project = generateStoryboard(project, history, {
      audioDuration,
      shortAudioDurations,
      hasMedia: false,
      preserveEdits: true,
    });
    history = loadHistory();

    const st = project.storyboard;
    // the Short narration must be the speech of THIS storyboard's Short scenes
    for (const plan of st.shorts) {
      const sidecar = path.join(DATA_DIR, 'voiceover', `${input.videoId}_${plan.id}.txt`);
      const spoken = fs.existsSync(sidecar) ? fs.readFileSync(sidecar, 'utf8').trim() : null;
      if (spoken !== null && spoken !== targetNarration(plan.scenes)) {
        throw new Error(`${input.videoId} ${plan.id}: its narration audio was generated from different scene text. Delete data/voiceover/${input.videoId}_${plan.id}.* and run \`npm run voiceovers\`.`);
      }
    }
    log(
      `storyboard: ${st.long.scenes.length} long scenes / ${st.long.totalDuration.toFixed(1)}s, ` +
        `${st.shorts.length} shorts (${st.shorts.map((s) => `${s.totalDuration.toFixed(0)}s`).join(', ')}), ` +
        `${st.captions.length} caption cues, similarity ${st.similarity?.score}%`,
    );
    if (st.warnings.length) log(`warnings: ${st.warnings.join(' | ')}`);

    const assets = loadAssetIndex();
    const assetUrls: Record<string, string> = {};

    log('rendering final export…');
    const res = await exportProject(project, {
      kind: 'final',
      videoId: input.videoId,
      includeShorts,
      onlyTargets,
      includeThumbnails: includeThumbs,
      history,
      assets,
      ctaAnimation: 'slide_in',
      captionStyle: 'boxed_center',
      targetAudio,
      // The renderer serves media from a local static server started below.
      assetUrls,
      logoUrl: null,
      onLog: (m) => log(`  ${m}`),
    });

    for (const r of res.results) {
      log(`  ${r.target}: ${r.qc.verdict.toUpperCase()} (${r.qc.findings.filter((f) => f.severity === 'critical').length} critical)`);
    }

    summary.push({
      videoId: input.videoId,
      topic: input.topic,
      longScenes: st.long.scenes.length,
      longDuration: st.long.totalDuration,
      hook: st.long.scenes[0]?.variant,
      sceneOrder: st.long.scenes.map((s) => s.variant),
      backgrounds: st.long.scenes.map((s) => s.background),
      transitions: st.long.scenes.map((s) => s.transitionIn),
      shorts: st.shorts.map((s) => ({ id: s.id, hook: s.hookVariant, duration: s.totalDuration, order: s.scenes.map((x) => x.variant) })),
      similarity: st.similarity?.score,
      similarityReasons: st.similarity?.reasons,
      results: res.results.map((r) => ({
        target: r.target,
        file: path.relative(OUTPUT_DIR, r.file),
        verdict: r.qc.verdict,
        criticals: r.qc.findings.filter((f) => f.severity === 'critical').map((f) => f.title),
        warnings: r.qc.findings.filter((f) => f.severity === 'warn').length,
        metrics: r.qc.metrics,
      })),
    });

    // refresh the stored project so the UI shows the exported artifacts
    const fresh = loadProject(input.videoId)!;
    fresh.artifacts = res.results.filter((r) => r.file).map((r) => ({
      kind: 'final' as const,
      target: r.target as never,
      fileName: path.basename(r.file),
      relPath: path.relative(OUTPUT_DIR, r.file),
      createdAt: new Date().toISOString(),
      durationSec: Number(r.qc.metrics.durationSec ?? 0),
      width: Number(r.qc.metrics.width ?? 0),
      height: Number(r.qc.metrics.height ?? 0),
      sizeBytes: fs.existsSync(r.file) ? fs.statSync(r.file).size : 0,
      probe: r.qc.metrics as Record<string, unknown>,
    }));
    fresh.qc = res.results.map((r) => r.qc);
    fresh.meta.status = 'exported';
    saveProject(fresh);
  }

  const outFile = path.join(OUTPUT_DIR, 'demo_summary.json');
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), summary }, null, 2), 'utf8');
  saveHistory(history);
  log(`summary written to ${outFile}`);
  log(`total time ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

main().catch((e) => {
  console.error('DEMO FAILED:', e);
  process.exit(1);
});
