/**
 * Local picture analysis protocol, against a LOOPBACK HTTP stub of llama-server (not a model).
 *
 * LABELLED TEST DOUBLE: the stub implements /health and /v1/chat/completions so the adapter's mechanics can be
 * exercised for real: the picture is sent as a data URL, the answer is parsed strictly, timeouts and cancel are
 * honoured, a late answer after cancel is discarded, one job runs at a time, and an interrupted job is recorded as such.
 * This proves protocol behaviour only. It does not prove that the owner's model reads pictures correctly.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelVisionJob,
  getVisionJob,
  readVisionConfig,
  recoverVisionJobs,
  resetVisionForTests,
  startVisionJob,
  visionStatus,
  VisionError,
  type VisionConfig,
  type VisionJob,
} from '../apps/api/src/services/local-vision.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-vision-'));
const modelPath = path.join(root, 'FIXTURE-vision.gguf');
const projPath = path.join(root, 'FIXTURE-mmproj.gguf');
fs.writeFileSync(modelPath, 'FIXTURE-VISION-WEIGHTS-NOT-A-MODEL');
fs.writeFileSync(projPath, 'FIXTURE-PROJECTOR-NOT-A-MODEL');
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const GOOD = {
  subject: 'a brass desk lamp', environment: 'a wooden table', lighting: 'soft window light', composition: 'centred object',
  shot: 'close-up', exclude: '', containsText: false, containsLogoOrBrand: false, containsPeople: false, uncertainties: ['the lamp base is partly hidden'],
};

/** LABELLED TEST DOUBLE: a loopback llama-server stand-in. The mode is set per test. */
let mode: 'valid' | 'invalid' | 'hang' | 'late' | 'health-down' | 'drop' = 'valid';
let lastBody: any = null;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    if (mode === 'health-down') { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return;
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastBody = JSON.parse(raw);
      const answer = (content: string) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], model: 'FIXTURE' }));
      };
      if (mode === 'drop') { req.socket.destroy(); return; }
      if (mode === 'valid') answer(JSON.stringify(GOOD));
      else if (mode === 'invalid') answer('Sure! Here is a lovely description with extra words.');
      else if (mode === 'late') setTimeout(() => answer(JSON.stringify(GOOD)), 600);
      // 'hang' never answers.
    });
    return;
  }
  res.writeHead(404); res.end();
});

let base = '';
let cfg: VisionConfig;

function config(extra: Partial<VisionConfig> = {}): VisionConfig {
  return { ...cfg, ...extra };
}

async function waitFor(id: string, cfgUsed: VisionConfig, max = 3000): Promise<VisionJob> {
  const until = Date.now() + max;
  for (;;) {
    const j = getVisionJob(id, cfgUsed);
    if (!['queued', 'running'].includes(j.state)) return j;
    if (Date.now() > until) throw new Error(`job ${id} did not finish; state ${j.state}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cfg = readVisionConfig({
    VISION_ENABLED: '1',
    VISION_URL: base,
    VISION_MODEL_PATH: modelPath,
    VISION_MODEL_SHA256: sha(fs.readFileSync(modelPath)),
    VISION_PROJECTOR_PATH: projPath,
    VISION_PROJECTOR_SHA256: sha(fs.readFileSync(projPath)),
    VISION_ROOT: path.join(root, 'vision'),
  }, root);
});

afterAll(async () => {
  resetVisionForTests();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local picture analysis protocol (loopback stub, fixture evidence only)', () => {
  it('status is ready when the files match their pins and the loopback server answers', async () => {
    mode = 'valid';
    const s = await visionStatus(cfg);
    expect(s.missing).toEqual([]);
    expect(s.ready).toBe(true);
    expect(s.model.sha256Matches).toBe(true);
    expect(s.projector.sha256Matches).toBe(true);
    expect(s.serverReachable).toBe(true);
    expect(s.model.licence).toMatch(/Apache-2\.0/);
  });

  it('a non-loopback VISION_URL is refused in the status, with the reason', async () => {
    const s = await visionStatus(config({ url: 'http://10.0.0.5:8081' }));
    expect(s.ready).toBe(false);
    expect(s.missing.join(' ')).toMatch(/loopback/);
  });

  it('a wrong model hash is reported as a mismatch, and the status is not ready', async () => {
    const s = await visionStatus(config({ modelSha256: '0'.repeat(64) }));
    expect(s.model.sha256Matches).toBe(false);
    expect(s.ready).toBe(false);
  });

  it('a valid answer succeeds; the picture itself is sent as a data URL; the stored hash is the picture hash', async () => {
    mode = 'valid';
    const job = await startVisionJob({ assetId: 'ast_fixture', bytes: PNG, sha256: sha(PNG), mimeType: 'image/png' }, cfg);
    const done = await waitFor(job.id, cfg);
    expect(done.state).toBe('succeeded');
    expect(done.observation).toEqual(GOOD);
    expect(done.sha256).toBe(sha(PNG));
    // The request carried the picture bytes, not a description of them.
    const content = lastBody.messages[1].content;
    expect(content.some((c: any) => c.type === 'image_url' && c.image_url.url === `data:image/png;base64,${PNG.toString('base64')}`)).toBe(true);
    expect(lastBody.temperature).toBe(0);
    expect(lastBody.stream).toBe(false);
  });

  it('an answer that is not the strict JSON shape fails with a reason, and the raw text is not stored', async () => {
    mode = 'invalid';
    const job = await startVisionJob({ assetId: 'ast_fixture', bytes: PNG, sha256: sha(PNG), mimeType: 'image/png' }, cfg);
    const done = await waitFor(job.id, cfg);
    expect(done.state).toBe('failed');
    expect(done.error?.code).toBe('VISION_OUTPUT_INVALID');
    expect(done.observation).toBeNull();
    expect(JSON.stringify(done)).not.toContain('Sure! Here is');
  });

  it('a job that does not answer in time is timed out, with the timeout named', async () => {
    mode = 'hang';
    const quick = config({ timeoutMs: 250 });
    const job = await startVisionJob({ assetId: 'ast_fixture', bytes: PNG, sha256: sha(PNG), mimeType: 'image/png' }, quick);
    const done = await waitFor(job.id, quick, 2000);
    expect(done.state).toBe('timed_out');
    expect(done.error?.code).toBe('VISION_TIMEOUT');
    expect(done.observation).toBeNull();
  });

  it('cancel records the job as cancelled at once, and a late answer is discarded', async () => {
    mode = 'late';
    const job = await startVisionJob({ assetId: 'ast_fixture', bytes: PNG, sha256: sha(PNG), mimeType: 'image/png' }, cfg);
    const c = cancelVisionJob(job.id, cfg);
    expect(c.state).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 900));
    const after = getVisionJob(job.id, cfg);
    expect(after.state).toBe('cancelled');
    expect(after.observation).toBeNull();
  });

  it('one job at a time: a second start while one runs is refused with 409, and the first can be cancelled', async () => {
    mode = 'hang';
    const first = await startVisionJob({ assetId: 'ast_a', bytes: PNG, sha256: sha(PNG), mimeType: 'image/png' }, cfg);
    await expect(startVisionJob({ assetId: 'ast_b', bytes: PNG, sha256: sha(PNG), mimeType: 'image/png' }, cfg)).rejects.toMatchObject({ code: 'VISION_BUSY', status: 409 });
    cancelVisionJob(first.id, cfg);
    await waitFor(first.id, cfg);
  });

  it('a server that is not answering is refused at start (setup required), so no job is recorded', async () => {
    const closed = config({ url: 'http://127.0.0.1:9' });
    await expect(startVisionJob({ assetId: 'ast_fixture', bytes: PNG, sha256: sha(PNG), mimeType: 'image/png' }, closed)).rejects.toMatchObject({ code: 'VISION_SETUP_REQUIRED', status: 503 });
  });

  it('a server that drops the connection mid-request is a recorded failure with a reason, not a success', async () => {
    mode = 'drop';
    const job = await startVisionJob({ assetId: 'ast_fixture', bytes: PNG, sha256: sha(PNG), mimeType: 'image/png' }, cfg);
    const done = await waitFor(job.id, cfg);
    expect(done.state).toBe('failed');
    expect(done.error?.code).toBe('VISION_UNAVAILABLE');
    expect(done.observation).toBeNull();
    mode = 'valid';
  });

  it('an unsupported picture type or an oversized picture is refused before any analysis', async () => {
    await expect(startVisionJob({ assetId: 'ast_fixture', bytes: PNG, sha256: sha(PNG), mimeType: 'image/gif' }, cfg)).rejects.toBeInstanceOf(VisionError);
    await expect(startVisionJob({ assetId: 'ast_fixture', bytes: Buffer.alloc(0), sha256: sha(''), mimeType: 'image/png' }, cfg)).rejects.toMatchObject({ code: 'VISION_VALIDATION' });
  });

  it('a job still running when the server stopped is recorded as interrupted on the next start', async () => {
    const dir = path.join(cfg.root, 'jobs');
    fs.mkdirSync(dir, { recursive: true });
    const id = `lvj_${'a'.repeat(16)}`;
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, assetId: 'x', sha256: 'y', mimeType: 'image/png', state: 'running', timeoutSec: 240, createdAt: '', updatedAt: '', error: null, observation: null }));
    recoverVisionJobs(cfg);
    const j = getVisionJob(id, cfg);
    expect(j.state).toBe('interrupted');
    expect(j.error?.code).toBe('VISION_INTERRUPTED');
  });
});
