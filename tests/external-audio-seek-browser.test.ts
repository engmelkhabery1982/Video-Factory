/**
 * Real browser seek against the real narration route.
 *
 * This is not a render and not a speech engine. The recording is a generated
 * tone. If no runnable browser exists, this test fails closed instead of
 * claiming the player was checked.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'external-audio-seek-browser');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  return { root, data, output };
});

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { PROJECT_SCHEMA_VERSION, buildStoryboard, emptyHistory, type Project, type ProjectInput } from '@buildtrack/core';
import { buildServerApp } from '../apps/api/src/server.js';
import { saveProject } from '../apps/api/src/services/store.js';
import { resolveChrome } from '../tools/chrome-resolution.mjs';
import { referenceWavBuffer } from './helpers/chatterbox-worker-fixtures.js';

const VIDEO_ID = 'Seek_Browser_Fixture';
const SCRIPT = [
  'This fixture tone is not a person speaking.',
  'The second line is also only a test tone.',
  'The third line gives the player a caption to seek from.',
].join('\n\n');

interface AudioHit {
  status: number;
  range?: string;
  contentRange?: string;
  acceptRanges?: string;
}

function runnableChrome(): string {
  const resolved = resolveChrome();
  if (resolved.ok) return resolved.path;
  const candidates = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No runnable browser, so player seeking was not proven. ${resolved.message}`);
}

function multipart(content: Buffer) {
  const boundary = '----seek' + Math.random().toString(36).slice(2);
  const fields: Record<string, string> = {
    scriptText: SCRIPT,
    sourceKind: 'authorized_external_synthesis',
    ownershipConfirmed: 'true',
    ownershipStatement: 'TEST/FIXTURE',
    speakerName: 'fixture speaker',
    engineName: 'fixture-engine',
    modelName: 'not-a-cloned-voice',
    voiceName: 'synthetic',
  };
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture-tone.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

describe('browser narration seeking', () => {
  let app: Awaited<ReturnType<typeof buildServerApp>>;
  let browser: Browser;
  let page: Page;
  let origin = '';
  const hits: AudioHit[] = [];
  let sceneId = '';
  let cueId = '';

  beforeAll(async () => {
    const chrome = runnableChrome();
    execFileSync('npm', ['run', 'build:web'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    app = await buildServerApp();
    await app.ready();
    const input: ProjectInput = {
      videoId: VIDEO_ID,
      videoType: 'long',
      topic: 'seek fixture',
      targetAudience: 'none',
      mainProblem: '',
      viewerPromise: '',
      hook: '',
      script: SCRIPT,
      keyNumbers: [],
      keyPoints: [],
      productName: '',
      productShots: [],
      cta: '',
      voiceoverFile: null,
      targetAudio: {},
      brollFiles: [],
      sourceReferences: [],
      outputLanguage: 'en',
      brandPreset: 'buildtrack',
      shortCount: 0,
      narrationSource: 'external_ready',
    };
    const built = buildStoryboard({ input, history: emptyHistory(), audioDuration: 60 });
    const { historyEntry: _ignored, ...storyboard } = built;
    const now = new Date().toISOString();
    const project: Project = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      meta: { input, brand: built.brand, createdAt: now, updatedAt: now, status: 'storyboarded' },
      storyboard,
      artifacts: [],
      qc: [],
    };
    saveProject(project);
    const imported = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/target-audio/long/external`,
      ...multipart(referenceWavBuffer('seek-browser-fixture-not-a-user-recording', 60)),
    });
    expect(imported.statusCode).toBe(201);
    const refit = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/storyboard`,
      payload: { preserveEdits: false },
    });
    expect(refit.statusCode).toBe(200);
    const timing = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/external-narration/timing/long` });
    expect(timing.statusCode).toBe(200);
    const review = timing.json().timing;
    expect(review.audioDurationSec).toBeGreaterThan(50);
    expect(review.scenes.length).toBeGreaterThan(0);
    expect(review.captions.length).toBeGreaterThan(0);
    sceneId = review.scenes[0].sceneId;
    cueId = review.captions[0].cueId;

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('The seek server did not bind a port.');
    origin = `http://127.0.0.1:${address.port}`;

    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    });
    page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    page.on('response', (response) => {
      if (!response.url().includes('/external/audio')) return;
      hits.push({
        status: response.status(),
        range: response.request().headers().range,
        contentRange: response.headers()['content-range'],
        acceptRanges: response.headers()['accept-ranges'],
      });
    });
    await page.goto(`${origin}/?p=${VIDEO_ID}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    try {
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button.step')].find((el) => el.textContent?.includes('Captions')) as HTMLButtonElement | undefined;
        return Boolean(button && !button.disabled);
      }, { timeout: 15000 });
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('button.step')].find((el) => el.textContent?.includes('Captions')) as HTMLButtonElement | undefined;
        button?.click();
      });
      await page.waitForSelector('audio[aria-label="Listen to the imported narration for Long video"]', { timeout: 15000 });
      await page.waitForFunction(() => {
        const audio = document.querySelector('audio');
        return Boolean(audio && Number.isFinite(audio.duration) && audio.duration > 50);
      }, { timeout: 15000 });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} hits=${JSON.stringify(hits)} pageErrors=${pageErrors.join(' | ')}`);
    }
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
  });

  async function holdAt(seconds: number) {
    return page.evaluate(async (target) => {
      const audio = document.querySelector('audio');
      if (!audio) return { ok: false, currentTime: -1, src: '' };
      const src = audio.currentSrc || audio.src;
      audio.currentTime = target;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        audio.addEventListener('seeked', done, { once: true });
        setTimeout(done, 2500);
      });
      await audio.play().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 700));
      return {
        ok: Math.abs(audio.currentTime - target) < 1.5 && audio.currentTime > target - 1.5,
        currentTime: audio.currentTime,
        src,
        srcChanged: (audio.currentSrc || audio.src) !== src,
        paused: audio.paused,
      };
    }, seconds);
  }

  async function clickPlayFrom(kind: 'scene' | 'caption', id: string, seconds: number) {
    const label = kind === 'scene'
      ? `Scene ${id} start for Long video`
      : `Caption ${id} start for Long video`;
    const button = kind === 'scene'
      ? `Play from scene ${id} for Long video`
      : `Play from caption ${id} for Long video`;
    await page.evaluate((inputLabel, value) => {
      const input = document.querySelector(`input[aria-label="${inputLabel}"]`) as HTMLInputElement | null;
      if (!input) throw new Error(`Missing ${inputLabel}`);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, label, seconds.toFixed(2));
    const srcBefore = await page.evaluate(() => document.querySelector('audio')?.currentSrc ?? '');
    await page.click(`button[aria-label="${button}"]`);
    await page.waitForFunction((target) => {
      const audio = document.querySelector('audio');
      return Boolean(audio && Math.abs(audio.currentTime - target) < 1.5 && audio.currentTime > 1);
    }, { timeout: 8000 }, seconds);
    await new Promise((resolve) => setTimeout(resolve, 700));
    return page.evaluate((target, previousSrc) => {
      const audio = document.querySelector('audio');
      return {
        currentTime: audio?.currentTime ?? -1,
        srcChanged: (audio?.currentSrc || audio?.src || '') !== previousSrc,
        stayed: Boolean(audio && Math.abs(audio.currentTime - target) < 1.5 && audio.currentTime > 1),
      };
    }, seconds, srcBefore);
  }

  it('seeks the native player to 10, 30, and 50 seconds without returning to the start', async () => {
    for (const seconds of [10, 30, 50]) {
      const result = await holdAt(seconds);
      expect(result.srcChanged, `manual ${seconds}`).toBe(false);
      expect(result.currentTime, `manual ${seconds}`).toBeGreaterThan(seconds - 1.5);
      expect(result.currentTime, `manual ${seconds}`).toBeLessThan(seconds + 1.5);
      expect(result.ok, `manual ${seconds}`).toBe(true);
    }
  }, 30_000);

  it('seeks from the scene and caption buttons and keeps playing there', async () => {
    await page.click('button[aria-label="Review the scene timing for Long video"]');
    await page.waitForSelector(`button[aria-label="Play from scene ${sceneId} for Long video"]`);
    const scene = await clickPlayFrom('scene', sceneId, 10);
    expect(scene.srcChanged).toBe(false);
    expect(scene.stayed).toBe(true);
    const caption = await clickPlayFrom('caption', cueId, 30);
    expect(caption.srcChanged).toBe(false);
    expect(caption.stayed).toBe(true);
    const later = await clickPlayFrom('caption', cueId, 50);
    expect(later.srcChanged).toBe(false);
    expect(later.stayed).toBe(true);
    expect(later.currentTime).toBeGreaterThan(48);
  }, 30_000);

  it('advertises byte ranges and does not answer a range request with the whole file', () => {
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.acceptRanges === 'bytes' || hit.status === 206)).toBe(true);
    for (const hit of hits) {
      if (hit.range) {
        expect(hit.status).toBe(206);
        expect(hit.contentRange).toMatch(/^bytes \d+-\d+\/\d+$/);
      }
    }
  });
});
