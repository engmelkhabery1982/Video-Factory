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

const t0 = Date.now();
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`[${stamp()}] ${m}`);

async function registerVoiceover(videoId: string): Promise<string> {
  const rel = `voiceover/${videoId}.mp3`;
  const abs = path.join(DATA_DIR, rel);
  if (!fs.existsSync(abs)) throw new Error(`Missing narration: ${abs}`);
  const list = loadAssetIndex();
  if (!list.some((a) => a.path.endsWith(rel))) {
    list.push({
      id: `voiceover-${videoId.toLowerCase()}`,
      name: `${videoId} narration`,
      kind: 'broll',
      fileName: `${videoId}.mp3`,
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

  const summary: any[] = [];
  let history = loadHistory();

  for (const input of DEMO_PROJECTS) {
    if (only && input.videoId !== only) continue;
    log(`=== ${input.videoId}: ${input.topic} ===`);

    const voicePath = await registerVoiceover(input.videoId);
    const enriched = { ...input, voiceoverFile: voicePath };

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

    project = generateStoryboard(project, history, {
      audioDuration,
      hasMedia: false,
      preserveEdits: true,
    });
    history = loadHistory();

    const st = project.storyboard;
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
      includeThumbnails: includeThumbs,
      history,
      assets,
      ctaAnimation: 'slide_in',
      captionStyle: 'boxed_center',
      audioFile: path.join(DATA_DIR, voicePath),
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
    fresh.artifacts = res.results.map((r) => ({
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
