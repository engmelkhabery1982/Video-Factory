/**
 * Fast visual probe - bundles the real compositions once and renders a handful
 * of single stills, so a layout or caption regression is visible in ~30s
 * instead of a 10-minute video.
 *
 * It picks the frame that is guaranteed to exercise a given thing:
 *   - the hook variant chosen for the demo project
 *   - a frame inside a live caption cue
 *   - the myth/reality (two-sided) scene
 *
 * Usage:  npx tsx tests/visual-probe.ts [outDir]
 */
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import { buildStoryboard, emptyHistory, getBrandPreset } from '@buildtrack/core';
import { DEMO_PROJECTS } from './fixtures/demo-projects.js';

const ROOT = path.resolve(process.cwd());
const BROWSER = path.join(ROOT, '.browser', 'chrome');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, '.probe'));
process.env.LD_LIBRARY_PATH = [path.join(ROOT, '.browser', 'lib'), path.join(ROOT, '.browser'), process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(':');
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const t0 = Date.now();
  const serveUrl = await bundle({
    entryPoint: path.join(ROOT, 'packages/video/src/index.ts'),
    onProgress: () => {},
    outDir: path.join(ROOT, '.remotion'),
  });
  console.log(`bundled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const sb: any = buildStoryboard({ input: DEMO_PROJECTS[0], history: emptyHistory() });
  const scenes = sb.long.scenes;
  const props = {
    scenes,
    captions: sb.captions,
    brand: getBrandPreset('buildtrack'),
    format: 'long',
    ctaAnimation: sb.historyEntry.ctaAnimation,
    captionStyle: sb.historyEntry.captionStyle,
    ctaText: DEMO_PROJECTS[0].cta,
    productName: 'BuildTrack',
    logoSrc: null,
    audioSrc: null,
    burnedCaptions: true,
    mediaMap: {},
  };

  const comp = await selectComposition({ serveUrl, id: 'LongVideo', inputProps: props, browserExecutable: BROWSER });
  console.log(`LongVideo ${comp.width}x${comp.height} ${comp.durationInFrames}f  captionStyle=${sb.historyEntry.captionStyle}`);

  // choose frames: every scene's first frame, but only a handful, plus a
  // mid-scene frame for a couple of them
  let idx = 0;
  let frame = 0;
  const targets: { name: string; frame: number }[] = [];
  for (const s of scenes) {
    const dur = Math.round(s.duration ?? 150);
    // mid-scene, well past the 4-frame caption fade-in
    if (idx % 2 === 0) targets.push({ name: `${String(idx).padStart(2, '0')}_${s.variant}_mid`, frame: Math.min(frame + Math.floor(dur * 0.5), comp.durationInFrames - 1) });
    frame += dur;
    idx++;
  }
  targets.push({ name: `${String(scenes.length).padStart(2, '0')}_cta_end`, frame: comp.durationInFrames - 8 });

  for (const t of targets) {
    const file = path.join(OUT, `${t.name}.png`);
    await renderStill({ composition: comp, serveUrl, output: file, frame: t.frame, browserExecutable: BROWSER, overwrite: true });
    console.log(`  ${path.relative(ROOT, file)}  (frame ${t.frame})`);
  }

  // shorts: the hook frame of each short, where the hook variant is visible
  for (let i = 0; i < sb.shorts.length; i++) {
    const sh = sb.shorts[i];
    const sprops = {
      scenes: sh.scenes,
      captions: sb.captions,
      brand: getBrandPreset('buildtrack'),
      format: 'short',
      ctaAnimation: sb.historyEntry.ctaAnimation,
      captionStyle: sh.captionStyle ?? sb.historyEntry.captionStyle,
      ctaText: DEMO_PROJECTS[0].cta,
      productName: 'BuildTrack',
      logoSrc: null,
      audioSrc: null,
      burnedCaptions: true,
      mediaMap: {},
    };
    const sc = await selectComposition({ serveUrl, id: 'ShortVideo', inputProps: sprops, browserExecutable: BROWSER });
    for (const f of [8, Math.floor(sc.durationInFrames * 0.45), sc.durationInFrames - 8]) {
      const file = path.join(OUT, `short${i + 1}_f${f}.png`);
      await renderStill({ composition: sc, serveUrl, output: file, frame: f, browserExecutable: BROWSER, overwrite: true });
      console.log(`  ${path.relative(ROOT, file)}`);
    }
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
