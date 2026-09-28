import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import { buildStoryboard, emptyHistory, appendHistory, getBrandPreset } from '@buildtrack/core';
import { DEMO_PROJECTS } from '../tests/fixtures/demo-projects.js';

const ROOT = path.resolve(process.cwd());
const BROWSER = path.join(ROOT, '.browser', 'chrome');
process.env.LD_LIBRARY_PATH = [path.join(ROOT, '.browser', 'lib'), path.join(ROOT, '.browser'), process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(':');

async function main() {
  const t0 = Date.now();
  console.log('bundling...');
  const serveUrl = await bundle({
    entryPoint: path.join(ROOT, 'packages/video/src/index.ts'),
    onProgress: (p) => process.stdout.write(`\r  ${(p * 100).toFixed(0)}%`),
    outDir: path.join(ROOT, '.remotion'),
  });
  console.log(`\nbundled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const sb: any = buildStoryboard({ input: DEMO_PROJECTS[0], history: emptyHistory() });
  const props = {
    scenes: sb.long.scenes,
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

  console.log('selecting composition...');
  const comp = await selectComposition({ serveUrl, id: 'LongVideo', inputProps: props, browserExecutable: BROWSER });
  console.log('composition:', comp.id, comp.width + 'x' + comp.height, comp.durationInFrames, 'frames');

  const out = path.join(ROOT, '.test-render.mp4');
  console.log('rendering 60 frames...');
  const t1 = Date.now();
  await renderMedia({
    composition: comp,
    serveUrl,
    codec: 'h264',
    outputLocation: out,
    inputProps: props,
    browserExecutable: BROWSER,
    chromiumOptions: { gl: 'swangle', headless: true, ignoreCertificateErrors: false },
    concurrency: 2,
    imageFormat: 'jpeg',
    jpegQuality: 92,
    onProgress: ({ progress }) => process.stdout.write(`\r  ${(progress * 100).toFixed(0)}%`),
  });
  console.log(`\nrendered in ${((Date.now() - t1) / 1000).toFixed(1)}s -> ${out} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB)`);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
