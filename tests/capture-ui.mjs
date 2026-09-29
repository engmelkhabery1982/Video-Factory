/**
 * UI screenshot capture.
 *
 * Drives the local Chromium (already provisioned for the renderer) against a
 * running app, so the review screenshots are of the real UI with real data -
 * not a mock.
 *
 * Usage:  node tests/capture-ui.mjs            # assumes the app is on :3000
 *         APP_URL=http://localhost:3000 node tests/capture-ui.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'EVIDENCE');
const APP = process.env.APP_URL ?? 'http://localhost:3000';
const CHROME = path.join(ROOT, '.browser', 'chrome');

fs.mkdirSync(OUT, { recursive: true });
if (process.platform !== 'win32') {
  process.env.LD_LIBRARY_PATH = [path.join(ROOT, '.browser', 'lib'), path.join(ROOT, '.browser')].join(':');
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
  ],
  env: { ...process.env },
});

const page = await browser.newPage();
await page.setViewport({ width: 1680, height: 1150, deviceScaleFactor: 1 });

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

/**
 * Capture the CURRENT view. Only the first call navigates; navigating again
 * would bounce back to the project list and silently save the same screenshot
 * under a different name.
 */
let firstShot = true;
async function shot(name, waitFor) {
  if (firstShot) {
    await page.goto(APP, { waitUntil: 'networkidle2', timeout: 60_000 });
    firstShot = false;
  }
  if (waitFor) {
    await page.waitForSelector(waitFor, { timeout: 30_000 }).catch(() => {
      problems.push(`selector never appeared on ${name}: ${waitFor}`);
    });
  }
  await new Promise((r) => setTimeout(r, 1200));
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const bytes = fs.statSync(file).size;
  console.log(`  saved ${path.relative(ROOT, file)} (${bytes} bytes)`);
  return bytes;
}

console.log(`Capturing the UI from ${APP}`);
await shot('ui-projects', 'body');

// Open the first project. The row is a <tr className="clickable">, not a
// button or a link, so match the row and read its Video_0N cell.
const opened = await page.evaluate(() => {
  const row = [...document.querySelectorAll('tr.clickable')][0];
  if (!row) return null;
  row.click();
  return (row.textContent ?? '').trim().slice(0, 30);
});
if (opened) {
  await new Promise((r) => setTimeout(r, 1500));
  await shot('ui-storyboard', 'body');
  for (const [name, label] of [
    ['ui-captions', 'Caption'],
    ['ui-qc', 'QC'],
  ]) {
    const clicked = await page.evaluate((l) => {
      const el = [...document.querySelectorAll('button, a, [role="tab"]')].find((n) =>
        (n.textContent ?? '').trim().toLowerCase().startsWith(l.toLowerCase()),
      );
      if (!el) return false;
      el.click();
      return true;
    }, label);
    if (clicked) {
      await new Promise((r) => setTimeout(r, 1500));
      await shot(name, 'body');
    }
  }
} else {
  problems.push('no project link found on the project list');
}

// A duplicated screenshot means navigation silently failed; that is misleading
// evidence, so fail loudly rather than shipping two identical "different" shots.
if (fs.existsSync(path.join(OUT, 'ui-projects.png')) && fs.existsSync(path.join(OUT, 'ui-storyboard.png'))) {
  const a = fs.readFileSync(path.join(OUT, 'ui-projects.png'));
  const b = fs.readFileSync(path.join(OUT, 'ui-storyboard.png'));
  if (a.equals(b)) {
    problems.push('ui-projects.png and ui-storyboard.png are byte-identical - navigation to the storyboard did not happen');
  }
}

await browser.close();

if (problems.length) {
  console.log('\nBrowser problems:');
  for (const p of [...new Set(problems)]) console.log(`  ! ${p}`);
  process.exitCode = 1;
} else {
  console.log('\nNo console errors.');
}
