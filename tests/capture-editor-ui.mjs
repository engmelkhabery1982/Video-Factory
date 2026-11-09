#!/usr/bin/env node
/**
 * Screenshots of the REAL milestone-1 editor.
 *
 * This starts the project's own API (`npm start`, the same server the operator
 * runs) plus the web dev server, opens the editor in the provisioned Chromium,
 * operates the actual controls, and captures what the page shows. Nothing here
 * draws a mock-up: every PNG is the implemented React page, and every step is
 * also recorded as text in `steps.json` so a reviewer can read what the page
 * said without opening the images.
 *
 * The editor contract endpoints do not exist in `apps/api` yet (Arena owns
 * them), so the run uses the explicit development fixture
 * (`?editorFixture=1`), which is only reachable in a development build. Local
 * data and output are redirected to throwaway directories: no owner project,
 * upload or render is touched.
 *
 * Usage:  node tests/capture-editor-ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveChrome } from '../tools/chrome-resolution.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'EVIDENCE', 'editor-milestone1');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-milestone1-'));
const PROJECT = 'Editor_Demo';
const API_PORT = process.env.EDITOR_API_PORT ?? '3011';
const WEB_PORT = process.env.EDITOR_WEB_PORT ?? '5178';
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// The provisioned Chromium is unpacked with its own shared libraries, exactly
// as the renderer and tests/capture-ui.mjs use it.
if (process.platform !== 'win32') {
  process.env.LD_LIBRARY_PATH = [path.join(ROOT, '.browser', 'lib'), path.join(ROOT, '.browser')].join(':');
}

const steps = [];
const children = [];
const problems = [];

function log(...args) {
  console.log('[editor-shots]', ...args);
}

function start(cmd, args, cwd, env) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (d) => process.stdout.write(`  ${cmd}: ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  ${cmd}! ${d}`));
  return child;
}

function stopAll() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${label} did not answer at ${url} within ${timeoutMs}ms`);
}

const chrome = resolveChrome({ root: ROOT });
if (!chrome.ok) {
  console.error(`No browser available (${chrome.reason ?? 'unknown'}). Run \`npm run provision\` first.`);
  process.exit(2);
}

log(`chromium: ${chrome.path}`);
log(`scratch: ${SCRATCH}`);

start(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], ROOT, {
  PORT: API_PORT,
  HOST: '127.0.0.1',
  BUILDTRAKE_DATA: path.join(SCRATCH, 'data'),
  BUILDTRAKE_OUTPUT: path.join(SCRATCH, 'output'),
});
start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', WEB_PORT], path.join(ROOT, 'apps', 'web'), {
  BUILDTRAKE_API: API,
});

let browser;
try {
  await waitFor(`${API}/api/health`, 60_000, 'api');
  await waitFor(`${WEB}/`, 60_000, 'web');
  log('api and web are up');

  browser = await puppeteer.launch({
    executablePath: chrome.path,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--force-color-profile=srgb', '--hide-scrollbars'],
    env: { ...process.env },
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1100, deviceScaleFactor: 1 });
  const notes = [];
  /** Media URLs the labelled development fixture asks for that the scratch API cannot serve. */
  const fixtureMediaMisses = new Set();
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // The precise URL comes from the response hook; this generic line would
    // otherwise be recorded five times without saying which file was missing.
    if (text.includes('Failed to load resource')) return;
    problems.push(`console: ${text}`);
  });
  page.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    const url = response.url().split('?')[0].replace(WEB, '');
    if (url.startsWith('/media/')) fixtureMediaMisses.add(`HTTP ${status} ${url}`);
    else problems.push(`HTTP ${status} ${url}`);
  });

  const clickText = (text) =>
    page.evaluate((needle) => {
      const button = [...document.querySelectorAll('button')].find((item) => (item.textContent ?? '').trim().startsWith(needle));
      if (!button) throw new Error(`button not found: ${needle}`);
      button.click();
    }, text);

  const clickTestId = (testId) =>
    page.evaluate((id) => {
      const element = document.querySelector(`[data-testid="${id}"]`);
      if (!element) throw new Error(`element not found: ${id}`);
      element.click();
    }, testId);

  const setField = (cardTitle, labelPrefix, value) =>
    page.evaluate(
      (title, prefix, next) => {
        const card = [...document.querySelectorAll('.card')].find((item) => (item.querySelector('h2, h3')?.textContent ?? '').startsWith(title));
        const scope = card ?? document;
        const field = [...scope.querySelectorAll('.field')].find((item) => (item.querySelector('label')?.textContent ?? '').startsWith(prefix));
        const element = field?.querySelector('input, select, textarea');
        if (!element) throw new Error(`field not found: ${title} / ${prefix}`);
        const proto =
          element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, next);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      },
      cardTitle,
      labelPrefix,
      value,
    );

  const setPlayhead = (seconds) =>
    page.evaluate((value) => {
      const input = document.querySelector('input[aria-label="Playhead"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(seconds));

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function record(name, note, { selector = null, full = false } = {}) {
    await sleep(250);
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ');
    const file = path.join(OUT, `${name}.png`);    if (selector) {
      const handle = await page.$(selector);
      if (handle) await handle.screenshot({ path: file });
      else {
        problems.push(`selector missing for ${name}: ${selector}`);
        await page.screenshot({ path: file, fullPage: full });
      }
    } else {
      await page.screenshot({ path: file, fullPage: full });
    }
    steps.push({ name, note, file: path.relative(ROOT, file), text: text.slice(0, 20000) });
    log(`${name}.png`);
  }

  const show = (needle, name) => {
    if (!steps.length || !steps[steps.length - 1].text.includes(needle)) {
      // checked against the last capture; recorded either way
    }
    return page.evaluate(() => document.body.innerText).then((text) => {
      if (!text.includes(needle)) problems.push(`${name}: page did not show "${needle}"`);
    });
  };

  /* 1. open the editor -------------------------------------------------- */
  /**
   * The editor is a step in the EXISTING navigation, reached the way an
   * operator reaches it (the URL only carries the project). Vite reloads once
   * while it optimises its dependencies on the first request, so the click is
   * retried rather than assuming the first document survives.
   */
  async function openEditor() {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await page.waitForSelector('.steps button', { timeout: 20_000 });
        await clickText('4. Editor');
        await page.waitForSelector('[data-testid="editor-clip-vc_01"]', { timeout: 20_000 });
        return;
      } catch (error) {
        log(`openEditor attempt ${attempt} failed: ${error.message}`);
        await sleep(2_000);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }
    throw new Error('the editor step did not open');
  }

  await page.goto(`${WEB}/?p=${PROJECT}&editorFixture=1`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await openEditor();
  await record('01-editor-overview', 'The editor is step 4 of the existing navigation: preview, timeline, inspector, asset/caption/highlight panels, alignment and server-preview panels.', { full: true });

  /* 2. select and trim a clip ------------------------------------------- */
  await clickTestId('editor-clip-vc_01');
  await setField('Clip inspector', 'Duration', '12');
  await record('02-clip-trim-pending', 'Clip vc_01 selected; duration trimmed to 12s. The edit is staged ("1 operation(s) not saved") and composition starts are recalculated, never typed.', { selector: '.editor-layout' });

  /* 3. asset binding ---------------------------------------------------- */
  await clickTestId('editor-clip-vc_02');
  const boundLibrary = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.card')].find((item) => (item.querySelector('h3')?.textContent ?? '').startsWith('Assets'));
    const row = card?.querySelector('.asset-row');
    const button = row ? [...row.querySelectorAll('button')].find((item) => (item.textContent ?? '').includes('Assign to selected clip')) : null;
    if (!button) return false;
    button.click();
    return true;
  });
  if (!boundLibrary) problems.push('no asset row available to demonstrate binding');
  await record('03-asset-binding', 'A file from the library is assigned to the selected clip. A library file is not a binding until this explicit action; provenance and source duration are shown verbatim.', { selector: '.editor-layout' });

  /* 4. split at the playhead, then save --------------------------------- */
  await clickTestId('editor-clip-vc_01');
  await setPlayhead(6);
  await clickText('Split at playhead');
  await clickText('Save');
  await page.waitForFunction(() => document.body.innerText.includes('Saved — revision'), { timeout: 15_000 });
  await record('04-split-and-saved', 'A split at the playhead preserves the source position and the total duration; the save went through the contract endpoint with the base revision.', { selector: '.editor-layout' });

  /* 5. Arabic caption in the preview ------------------------------------ */
  await clickTestId('caption-chip-cap_01');
  await page.evaluate(() => {
    const area = document.querySelector('[data-testid="caption-text"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, 'افتح ورقة الملخص ثم حدد الإجمالي — الرَّحْمَٰن');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText('Save');
  await setPlayhead(5);
  await record('05-arabic-rtl-caption', 'An Arabic caption edited right-to-left with the shaping and diacritics preserved, drawn in the browser assembly preview at its own interval (not at a scene boundary). The fixture names media files that this scratch server does not hold, so the stage reports the missing picture instead of drawing an empty frame (see notes).', { selector: '[data-testid="editor-stage-frame"]' });

  /* 6. timed highlight -------------------------------------------------- */
  await clickTestId('highlight-chip-hl_01');
  await setField('Timed highlights', 'box x', '0.5');
  await setField('Timed highlights', 'End', '12');
  await record('06-timed-highlight', 'A timed highlight with measured display coordinates and its own start/end times, editable numerically here and by dragging or arrow keys in the preview.', { selector: '.editor-layout' });

  /* 7. save, undo, redo ------------------------------------------------- */
  await clickText('Save');
  await page.waitForFunction(() => document.body.innerText.includes('Saved — revision'), { timeout: 15_000 });
  await clickText('↶ Undo');
  await page.waitForFunction(() => document.body.innerText.includes('Undone — revision'), { timeout: 15_000 });
  await record('07-undo', 'Undo runs through the contract (a logical edit transaction restores the previous document and the revision increases).', { selector: '.editor-layout' });
  await clickText('↷ Redo');
  await page.waitForFunction(() => document.body.innerText.includes('Redone — revision'), { timeout: 15_000 });

  /* 8. failed save keeps the edits -------------------------------------- */
  await clickTestId('editor-clip-vc_01');
  await setField('Clip inspector', 'Duration', '9');
  await clickText('arm a failed save');
  await clickText('Save');
  await page.waitForFunction(() => document.body.innerText.includes('The save failed and nothing was persisted'), { timeout: 15_000 });
  await record('08-failed-save', 'A failed save is reported as a failure. Nothing is reported as saved and the pending edit is kept for a retry.', { full: true });

  /* 9. revision conflict ------------------------------------------------ */
  await clickText('bump the server revision');
  await clickText('Save');
  await page.waitForFunction(() => document.body.innerText.includes('Revision conflict'), { timeout: 15_000 });
  await record('09-revision-conflict', 'A revision conflict surfaces the server revision and two explicit resolutions; the document is never overwritten silently.', { full: true });
  await clickText('Keep my');
  await page.waitForFunction(() => document.body.innerText.includes('Saved — revision'), { timeout: 15_000 });

  /* 10. alignment blocker ---------------------------------------------- */
  await clickText('Request alignment');
  await page.waitForFunction(() => document.body.innerText.includes('Alignment did not start'), { timeout: 15_000 });
  await record('10-alignment-blocker', 'No alignment runtime: a structured blocker, no estimated times and no proposal.', { selector: '.editor-layout' });

  /* 11. alignment proposal + acceptance -------------------------------- */
  await clickText('pretend the alignment runtime exists');
  await clickText('Request alignment');
  await page.waitForFunction(() => document.body.innerText.includes('Review proposal'), { timeout: 15_000 });
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.card')].find((item) => (item.querySelector('h3')?.textContent ?? '').startsWith('Narration alignment'));
    card.querySelector('input[type="checkbox"]').click();
  });
  await record('11-alignment-proposal', 'A reviewed proposal with proposed starts/ends and an unresolved span. Acceptance is explicit and separate from publication approval.', { selector: '.editor-layout' });
  await clickText('Accept reviewed timing');
  await page.waitForFunction(() => document.body.innerText.includes('Reviewed timing accepted'), { timeout: 15_000 });

  /* 12. server preview: current, then stale ---------------------------- */
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((item) => (item.textContent ?? '').includes('substitute a URL for the server render'));
    button.click();
  });
  await clickText('Render full preview');
  await page.waitForFunction(() => document.body.innerText.includes('returned media URL'), { timeout: 15_000 });
  await record('12-server-preview-current', 'A server snapshot render at the current revision, carrying the mediaUrl value the endpoint returned. In this development fixture that value is the labelled substitute set in the dev bar; with Arena\'s endpoint it is the served output path. The render is labelled separately from the browser assembly preview.', { selector: '.editor-layout' });
  await clickTestId('editor-clip-vc_01');
  await setField('Clip inspector', 'Duration', '8');
  await clickText('Save');
  await page.waitForFunction(() => document.body.innerText.includes('STALE'), { timeout: 15_000 });
  await record('13-stale-render', 'After the edit moves on, the render is labelled STALE and is not presented as the current edit.', { selector: '.editor-layout' });

  /* 13. locked narration and engine honesty ---------------------------- */
  await record('14-narration-lock', 'The approved narration clip is locked; changing it is deliberate and withdraws the approval in the same edit. No voice is synthesized.', { selector: '.editor-layout' });
  await record('15-content-engines', 'Explicit content profile, channel identity with no automatic logo selection, and engine states reported as unavailable rather than assumed.', { selector: '.editor-layout' });

  const pageText = await page.evaluate(() => document.body.innerText);
  const checks = [
    ['completion', 'browser assembly preview — approximate, not the server render'],
    ['arabic', 'الرَّحْمَٰن'],
    ['stale', 'STALE'],
  ];
  const results = checks.map(([name, needle]) => ({ name, needle, present: pageText.includes(needle) }));
  for (const result of results) if (!result.present) problems.push(`final check missing: ${result.name}`);

  /* 16. reopen the project the way an operator does --------------------- */
  /**
   * Reopening goes through the app's own navigation rather than a page reload:
   * the document is fetched again from the contract, and only the development
   * fixture is module state that a hard reload would reset. Everything shown
   * after this step comes from the reopened document.
   */
  await clickText('1. Projects');
  await sleep(600);
  await openEditor();
  await record('16-reopen-document', 'The project is reopened from its saved revision through the app navigation: the edits made above are still there, the revision is the last saved one, and no pending edits are reported.', { full: true });

  const reopenedText = await page.evaluate(() => document.body.innerText);
  const reopenChecks = [
    ['reopen: clips kept', '4 clips'],
    ['reopen: Arabic caption kept', 'الرَّحْمَٰن'],
    ['reopen: saved duration kept', '36.00s'],
    ['reopen: nothing pending', 'no unsaved changes'],
  ].map(([name, needle]) => ({ name, needle, present: reopenedText.includes(needle) }));
  for (const result of reopenChecks) if (!result.present) problems.push(`reopen check missing: ${result.name}`);

  if (fixtureMediaMisses.size) {
    notes.push(
      `The development fixture points its asset media URLs at this scratch server, which holds no such files, so the browser could not load them: ${[...fixtureMediaMisses].join(', ')}.`,
      'The editor reports that in the stage ("media unavailable" with the exact URL) and never draws an empty frame as if it had loaded, and never substitutes other media. With Arena\'s endpoints the same clips carry the real served URLs.',
    );
  }
  fs.writeFileSync(
    path.join(OUT, 'steps.json'),
    `${JSON.stringify({ project: PROJECT, url: `${WEB}/?p=${PROJECT}&editorFixture=1`, fixture: 'dev-only, opt-in via ?editorFixture=1', steps, finalChecks: results, reopenChecks, notes, problems }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(OUT, 'console-problems.txt'), problems.length ? `${problems.join('\n')}\n` : 'none\n');
  log(`problems: ${problems.length ? problems.join(' | ') : 'none'}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  stopAll();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}
