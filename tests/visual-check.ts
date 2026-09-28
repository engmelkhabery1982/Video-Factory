import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import { buildStoryboard, emptyHistory, appendHistory, getBrandPreset } from '@buildtrack/core';
import { DEMO_PROJECTS } from './fixtures/demo-projects.js';

/** Renders a handful of stills per demo so the visual layer can be reviewed fast. */

const ROOT = path.resolve(process.cwd());
const CHROME = path.join(ROOT, '.browser', 'chrome');
process.env.LD_LIBRARY_PATH = [path.join(ROOT, '.browser', 'lib'), path.join(ROOT, '.browser')].join(':');

const h: any = emptyHistory();
const served = await bundle({ entryPoint: path.join(ROOT, 'packages/video/src/index.ts'), outDir: path.join(ROOT, '.remotion') });
fs.mkdirSync(path.join(ROOT, '.stills'), { recursive: true });

for (let i = 0; i < DEMO_PROJECTS.length; i++) {
  const sb: any = buildStoryboard({ input: DEMO_PROJECTS[i], history: h });
  const entry = sb.historyEntry;
  // the engine mutates its own history copy; emulate the real run
  h.videos.push(entry);

  const props = {
    scenes: sb.long.scenes,
    captions: sb.captions,
    brand: getBrandPreset('buildtrack'),
    format: 'long',
    ctaAnimation: entry.ctaAnimation,
    captionStyle: entry.captionStyle,
    ctaText: DEMO_PROJECTS[i].cta,
    productName: 'BuildTrack',
    logoSrc: null,
    audioSrc: null,
    burnedCaptions: true,
    mediaMap: {},
  };
  const comp = await selectComposition({ serveUrl: served, id: 'LongVideo', inputProps: props, browserExecutable: CHROME });
  for (const f of [0.08, 0.45, 0.93]) {
    const frame = Math.round(comp.durationInFrames * f);
    await renderStill({
      composition: comp,
      serveUrl: served,
      output: path.join(ROOT, '.stills', `v${i + 1}-long-${Math.round(f * 100)}.png`),
      inputProps: props,
      frame,
      browserExecutable: CHROME,
      chromiumOptions: { gl: 'swangle', headless: true },
    });
  }
  const sp = { ...props, format: 'short', scenes: sb.shorts[0].scenes };
  const sc = await selectComposition({ serveUrl: served, id: 'ShortVideo', inputProps: sp, browserExecutable: CHROME });
  for (const f of [0.05, 0.35]) {
    await renderStill({
      composition: sc,
      serveUrl: served,
      output: path.join(ROOT, '.stills', `v${i + 1}-short-${Math.round(f * 100)}.png`),
      inputProps: sp,
      frame: Math.round(sc.durationInFrames * f),
      browserExecutable: CHROME,
      chromiumOptions: { gl: 'swangle', headless: true },
    });
  }
  console.log(
    `v${i + 1} hook=${entry.hookVariant} bgs=[${[...new Set(entry.backgrounds)].join(',')}] cta=${entry.ctaAnimation} caps=${entry.captionStyle} sim=${sb.similarity.score}%`,
  );
}
console.log('done');
