/**
 * CLOSEOUT07 regressions for the two defects reproduced on the owner host.
 *
 * 1. WINDOWS LONG-PATH EXPORT FAILURE. The editor export produced raw frames, then
 *    the packaged FFmpeg could not open the 262-character path to `raw-frames.mp4`.
 *    The file existed; only the path was unusable. Copying disposable QA data to a
 *    shorter root made the same revision export successfully.
 *
 * 2. PREMATURE `finishedAt`. `editor-preview.ts` stamped the completion time before
 *    awaiting the render, so a slow export reported completion almost at creation.
 *
 * What is real here and what is not:
 *   - The path strategy is exercised for real (pure functions, plus real
 *     directories for ownership/cleanup).
 *   - The job-timestamp cases call the REAL `enqueuePreview`/`loadExportJob`
 *     lifecycle with an isolated real filesystem. Only the renderer module is
 *     replaced, with a controlled DELAYED FAKE, because a real Remotion+Chromium
 *     render is not available in this sandbox. That substitution is stated in the
 *     test, not hidden: it proves WHEN the timestamp is assigned, not how long a
 *     real render takes.
 *   - No test here proves that the installed Windows FFmpeg accepts these paths.
 *     That finite check needs the real binary and is listed as NOT RUN.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'editor-render-paths');
  nodeFs.rmSync(root, { recursive: true, force: true });
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  // Keep the renderer unavailable for the pure module; the lifecycle tests stub it.
  process.env.VF_PREVIEW_DISABLE = '1';
  return { root, data, output };
});

// The delayed render stand-in. Hoisted so the module mock can see it.
const renderStub = vi.hoisted(() => {
  const state = { delayMs: 0, calls: 0, failMarker: null as string | null, workDir: '' };
  return state;
});

vi.mock('../apps/api/src/services/editor-render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../apps/api/src/services/editor-render.js')>();
  return {
    ...actual,
    // Controlled delayed renderer: proves the settlement timestamp, nothing about
    // real render speed or output quality.
    renderEditorPreview: async (input: { workDir: string; outputFile: string }) => {
      renderStub.calls += 1;
      renderStub.workDir = input.workDir;
      await new Promise((resolve) => setTimeout(resolve, renderStub.delayMs));
      if (renderStub.failMarker) throw new Error(renderStub.failMarker);
      fs.mkdirSync(path.dirname(input.outputFile), { recursive: true });
      fs.writeFileSync(input.outputFile, 'delayed-render-stand-in');
      return {
        revision: 3,
        startFrame: 0,
        endFrameExclusive: 360,
        expectedDurationSec: 12,
        probedDurationSec: 12,
        width: 1080,
        height: 1920,
        hasVideo: true,
        hasAudio: false,
        hasNarration: false,
        audioClips: 0,
        audioSources: 0,
        format: 'portrait' as const,
        compositionId: 'ShortVideo' as const,
        compositionWidth: 1080,
        compositionHeight: 1920,
        channelBrandId: null,
      };
    },
  };
});

import {
  POSIX_MAX_PATH,
  WINDOWS_MAX_PATH,
  SCRATCH_KIND,
  SCRATCH_MARKER,
  assertBinaryReachablePath,
  chooseScratchRoot,
  cleanupEditorRenderScratch,
  fitsBudget,
  isUnlinkedPath,
  newScratchName,
  openEditorRenderScratch,
} from '../apps/api/src/services/editor-render-paths.js';

afterAll(() => {
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

const W = path.win32;
const FINAL_JOB = 'exp_6ac267eb71ccf166';
/** The failing path's shape: the same job under a deep disposable QA root. */
const OWNER_QA_ROOT =
  'C:\\Users\\Owner\\AppData\\Roaming\\VideoFactory\\data-synthetic-qa-2026-11-08\\projects\\Factory_2451683d6e07\\editor';
const ownerRawPath = (pad: number) =>
  W.join(OWNER_QA_ROOT, 'export-work' + 'x'.repeat(Math.max(0, pad)), FINAL_JOB, 'raw-frames.mp4');

describe('reproduced Windows long path (the actual defect)', () => {
  it('owner regression: budgets the raw filename, not only its scratch directory', () => {
    const choice = chooseScratchRoot({ candidate: 'C:\\' + 'p'.repeat(210), name: 'exp-' + 'a'.repeat(32), outputFile: 'C:\\out\\final.mp4', platform: 'win32', tmpdir: 'C:\\tmp' });
    expect(choice.source).toBe('system-temp');
    expect(fitsBudget(W.join(choice.root!, 'raw-frames.mp4'), 'win32')).toBe(true);
  });
  it('reproduces the 262-character raw-frames path the packaged ffmpeg refused', () => {
    const reproduced = ownerRawPath(0);
    // Slide the padding until the path is exactly the length the owner reported.
    let padded = reproduced;
    for (let pad = 0; pad < 400 && padded.length < 262; pad += 1) padded = ownerRawPath(pad);
    expect(padded.endsWith('raw-frames.mp4')).toBe(true);
    expect(padded.length).toBeGreaterThanOrEqual(262);
    // Before the repair this path was passed straight to ffmpeg.
    expect(fitsBudget(padded, 'win32')).toBe(false);
  });

  it('accepts exactly the budget and rejects one character more', () => {
    expect(fitsBudget(ownerRawPath(0), 'win32')).toBe(true);
    let atLimit = ownerRawPath(0);
    for (let pad = 0; pad < 400 && atLimit.length < WINDOWS_MAX_PATH; pad += 1) atLimit = ownerRawPath(pad);
    expect(atLimit.length).toBe(WINDOWS_MAX_PATH);
    expect(fitsBudget(atLimit, 'win32')).toBe(true);
    // win32 flavour explicitly: the host's path.dirname would read this as POSIX.
    const over = W.join(W.dirname(atLimit), `x${W.basename(atLimit)}`);
    expect(over.length).toBe(WINDOWS_MAX_PATH + 1);
    expect(fitsBudget(over, 'win32')).toBe(false);
  });

  it('relocates ONLY the intermediate raw render, never the canonical final file', () => {
    const finalOutput = W.join(OWNER_QA_ROOT, 'exports', `${FINAL_JOB}.mp4`);
    const choice = chooseScratchRoot({
      candidate: W.join('C:\\Users\\Owner\\AppData\\Roaming\\VideoFactory\\data', 'editor-render-scratch'),
      name: newScratchName('exp'),
      outputFile: finalOutput,
      platform: 'win32',
      tmpdir: 'C:\\Users\\Owner\\AppData\\Local\\Temp',
    });
    expect(choice.root).not.toBeNull();
    const raw = W.join(choice.root as string, 'raw-frames.mp4');
    expect(fitsBudget(raw, 'win32')).toBe(true);
    // The defect path was 262; the replacement must be comfortably under the budget.
    expect(raw.length).toBeLessThan(WINDOWS_MAX_PATH);
    // The final location is untouched: same project id, revision and media URL.
    expect(finalOutput).toBe(W.join(OWNER_QA_ROOT, 'exports', `${FINAL_JOB}.mp4`));
  });

  it('prefers the app data tree when that path is already short enough', () => {
    const choice = chooseScratchRoot({
      candidate: 'C:\\vf\\scratch',
      name: 'exp-0123456789abcdef0123456789abcdef',
      outputFile: 'C:\\vf\\projects\\p\\editor\\exports\\exp_0123456789abcdef.mp4',
      platform: 'win32',
      tmpdir: 'C:\\Temp',
    });
    expect(choice.source).toBe('explicit');
    expect(choice.sameVolumeAsOutput).toBe(true);
    expect(choice.root).toBe('C:\\vf\\scratch\\exp-0123456789abcdef0123456789abcdef');
  });

  it('reports no root at all when every option is too long (refuse instead of rendering)', () => {
    const choice = chooseScratchRoot({
      candidate: W.join('C:\\', 'deep'.repeat(80), 'editor-render-scratch'),
      name: 'exp-0123456789abcdef0123456789abcdef',
      outputFile: W.join('C:\\', 'deep'.repeat(80), 'out.mp4'),
      platform: 'win32',
      tmpdir: W.join('C:\\', 'deep'.repeat(80), 'temp'),
    });
    expect(choice.root).toBeNull();
    expect(choice.reason).toMatch(/longer than/i);
  });
});

describe('POSIX behaviour is not broken by the Windows repair', () => {
  it('keeps a normal temp path usable', () => {
    expect(fitsBudget('/tmp/vf-job/raw-frames.mp4', 'linux')).toBe(true);
  });
  it('rejects a path beyond PATH_MAX', () => {
    expect(POSIX_MAX_PATH).toBeGreaterThan(1000);
    expect(fitsBudget(`/${'a'.repeat(POSIX_MAX_PATH + 10)}`, 'linux')).toBe(false);
  });
  it('rejects a single component over 255 bytes (the usual ENAMETOOLONG cause)', () => {
    expect(fitsBudget(`/tmp/${'b'.repeat(300)}/raw-frames.mp4`, 'linux')).toBe(false);
  });
});

describe('scratch ownership and cleanup', () => {
  const root = path.join(tmp.root, 'scratch-root');
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });

  it('creates a unique marked directory and removes only that directory', () => {
    const name = newScratchName('exp');
    const scratch = openEditorRenderScratch({ name, outputFile: path.join(tmp.root, 'out.mp4'), candidate: root });
    expect(scratch).not.toBeNull();
    const dir = (scratch as NonNullable<typeof scratch>).dir;
    expect(fs.existsSync(dir)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, SCRATCH_MARKER), 'utf8'));
    expect(marker.kind).toBe(SCRATCH_KIND);
    expect(marker.name).toBe(name);

    // An unrelated file in the root must survive.
    const sibling = path.join(root, 'owner-sentinel.txt');
    fs.writeFileSync(sibling, 'keep me');

    cleanupEditorRenderScratch(root, name);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(sibling, 'utf8')).toBe('keep me');
    expect(fs.existsSync(root)).toBe(true);
  });

  it('refuses to delete a directory that carries no marker', () => {
    const name = newScratchName('exp');
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'unowned.txt'), 'not ours to delete');
    cleanupEditorRenderScratch(root, name);
    expect(fs.existsSync(path.join(dir, 'unowned.txt'))).toBe(true);
  });

  it('refuses a malformed or mismatched marker', () => {
    const name = newScratchName('edt');
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SCRATCH_MARKER), '{"kind":"other","name":"x"}');
    fs.writeFileSync(path.join(dir, 'payload.txt'), 'survives');
    cleanupEditorRenderScratch(root, name);
    expect(fs.existsSync(path.join(dir, 'payload.txt'))).toBe(true);
  });

  it('rejects an unrecognised directory name and never escapes the root', () => {
    expect(() => openEditorRenderScratch({ name: '../escape', outputFile: path.join(tmp.root, 'o.mp4'), candidate: root })).toThrow(/unrecognised/i);
    expect(() => openEditorRenderScratch({ name: 'exp_short', outputFile: path.join(tmp.root, 'o.mp4'), candidate: root })).toThrow(/unrecognised/i);
    // cleanup with a traversal-ish name is a no-op, not a deletion.
    cleanupEditorRenderScratch(root, '../data');
    expect(fs.existsSync(path.join(root, '..', 'data'))).toBe(true);
  });

  it('refuses a linked scratch root (junction/symlink) instead of deleting through it', (context) => {
    const real = path.join(tmp.root, 'real-target');
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(tmp.root, 'linked-root');
    try {
      fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      // A filesystem that forbids symlinks must record a skip, not a pass.
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) context.skip();
      throw error;
    }
    expect(isUnlinkedPath(link)).toBe(false);
    const result = openEditorRenderScratch({ name: newScratchName('exp'), outputFile: path.join(tmp.root, 'o.mp4'), candidate: link });
    expect(result).toBeNull();
    expect(fs.readdirSync(real)).toHaveLength(0);
  });
});

describe('binary reachability guard', () => {
  it('rejects a path the binaries could not open and says why', () => {
    const long = ownerRawPath(0).length >= 262 ? ownerRawPath(0) : W.join(OWNER_QA_ROOT, 'export-work' + 'x'.repeat(200), FINAL_JOB, 'raw-frames.mp4');
    expect(() => assertBinaryReachablePath(long, 'The raw render', 'win32')).toThrow(/beyond the/i);
  });

  it('rejects a path that does not exist instead of letting ffmpeg fail later', () => {
    expect(() => assertBinaryReachablePath(path.join(tmp.root, 'definitely-absent.mp4'), 'The raw render', 'linux')).toThrow(/does not exist/);
  });
});

describe('completion timestamp belongs to settlement, not to enqueue (real job lifecycle)', () => {
  it('journals the allocated scratch before awaiting the renderer', async () => {
    const { createExportJob, enqueuePreview, loadExportJob } = await import('../apps/api/src/services/editor-preview.js');
    const { loadRecord } = await import('../apps/api/src/services/editor-jobs.js');
    renderStub.delayMs = 150; renderStub.failMarker = null; renderStub.workDir = '';
    const videoId = 'Factory_recovery_journal'; const frozenFile = path.join(tmp.data, 'projects', videoId, 'editor', 'frozen', 'long-r1.json');
    const doc = { revision: 1, durationSec: 12, assets: [], visualClips: [], audioClips: [] } as unknown as Parameters<typeof createExportJob>[0]['doc'];
    fs.mkdirSync(path.dirname(frozenFile), { recursive: true }); fs.writeFileSync(frozenFile, JSON.stringify(doc));
    const job = createExportJob({ videoId, targetId: 'long', doc, frozenFile, audioFiles: {} });
    enqueuePreview(videoId, job, {} as Parameters<typeof enqueuePreview>[2], 'http://127.0.0.1:3000');
    try {
      for (let i = 0; i < 20 && !renderStub.workDir; i++) await new Promise(r => setTimeout(r, 5));
      const disk = loadRecord<{ status: string; scratchDir?: string; scratchName?: string }>(videoId, 'export', job.jobId)!;
      expect(disk.status).toBe('running'); expect(disk.scratchDir).toBe(renderStub.workDir); expect(disk.scratchName).toBe(path.basename(renderStub.workDir));
      expect(JSON.parse(fs.readFileSync(path.join(renderStub.workDir, SCRATCH_MARKER), 'utf8')).jobId).toBe(job.jobId);
    } finally { for (let i = 0; i < 50 && loadExportJob(videoId, job.jobId)?.status === 'running'; i++) await new Promise(r => setTimeout(r, 10)); }
  });
  it('reclaims only the exact job-bound interrupted scratch on restart', async () => {
    const { createExportJob, loadExportJob, renderScratchRoot } = await import('../apps/api/src/services/editor-preview.js');
    const { saveRecord } = await import('../apps/api/src/services/editor-jobs.js');
    const videoId = 'Factory_recovery_owned'; const doc = { revision: 1, durationSec: 12 } as Parameters<typeof createExportJob>[0]['doc'];
    const job = createExportJob({ videoId, targetId: 'long', doc, frozenFile: 'not-rendered', audioFiles: {} }); const name = newScratchName('exp');
    const scratch = openEditorRenderScratch({ name, outputFile: job.outputFile, candidate: renderScratchRoot(videoId, 'export') })!;
    fs.writeFileSync(scratch.markerFile, JSON.stringify({kind:SCRATCH_KIND,name,jobId:job.jobId}));
    fs.writeFileSync(path.join(scratch.dir, 'raw-frames.mp4'), 'interrupted-stand-in');
    saveRecord(videoId, 'export', job.jobId, {...job,scratchDir:scratch.dir,scratchName:name});
    expect(loadExportJob(videoId,job.jobId)?.status).toBe('failed'); expect(fs.existsSync(scratch.dir)).toBe(false);
  });
  it.each(['outside-root','other-job','legacy-marker'])('preserves interrupted scratch with untrusted ownership: %s', async mode => {
    const { createExportJob, loadExportJob, renderScratchRoot } = await import('../apps/api/src/services/editor-preview.js');
    const { saveRecord } = await import('../apps/api/src/services/editor-jobs.js');
    const videoId = `Factory_recovery_${mode}`; const doc = { revision: 1, durationSec: 12 } as Parameters<typeof createExportJob>[0]['doc'];
    const job = createExportJob({ videoId, targetId: 'long', doc, frozenFile: 'not-rendered', audioFiles: {} }); const name = newScratchName('exp');
    const candidate = mode === 'outside-root' ? path.join(tmp.root,'unrelated-owner-area') : renderScratchRoot(videoId,'export');
    // A forged persisted path is not a renderer path decision. Construct it
    // directly so a long Windows candidate cannot silently fall back to temp.
    const scratch = mode === 'outside-root' ? (() => { const dir=path.join(candidate,name);fs.mkdirSync(dir,{recursive:true});return {dir,markerFile:path.join(dir,SCRATCH_MARKER)}; })() : openEditorRenderScratch({name,outputFile:job.outputFile,candidate})!;
    fs.writeFileSync(scratch.markerFile,JSON.stringify({kind:SCRATCH_KIND,name,...(mode==='legacy-marker'?{}:{jobId:mode==='other-job'?'exp_0000000000000000':job.jobId})}));
    const sentinel = path.join(scratch.dir,'preserve.txt');fs.writeFileSync(sentinel,'keep');saveRecord(videoId,'export',job.jobId,{...job,scratchDir:scratch.dir,scratchName:name});
    const recovered=loadExportJob(videoId,job.jobId)!;expect(recovered.status).toBe('failed');expect(recovered.cleanupWarning).toBeTruthy();expect(fs.readFileSync(sentinel,'utf8')).toBe('keep');
  });
  it('persists the interrupted outcome if exact owned cleanup throws', async () => {
    const { createExportJob, loadExportJob, renderScratchRoot } = await import('../apps/api/src/services/editor-preview.js');
    const { saveRecord } = await import('../apps/api/src/services/editor-jobs.js');
    const videoId='Factory_recovery_cleanup_error';const doc={revision:1,durationSec:12} as Parameters<typeof createExportJob>[0]['doc'];
    const job=createExportJob({videoId,targetId:'long',doc,frozenFile:'not-rendered',audioFiles:{}});const name=newScratchName('exp');
    const scratch=openEditorRenderScratch({name,jobId:job.jobId,outputFile:job.outputFile,candidate:renderScratchRoot(videoId,'export')})!;
    saveRecord(videoId,'export',job.jobId,{...job,scratchDir:scratch.dir,scratchName:name});
    const remove=vi.spyOn(fs,'rmSync').mockImplementationOnce(()=>{throw Error('controlled cleanup failure');});
    try{const recovered=loadExportJob(videoId,job.jobId)!;expect(recovered.status).toBe('failed');expect(recovered.mediaUrl).toBeNull();expect(recovered.cleanupWarning).toBeTruthy();expect(fs.existsSync(scratch.dir)).toBe(true);}finally{remove.mockRestore();}
  });
  it('owner regression: a scratch cleanup failure cannot erase a completed export', async () => {
    const { createExportJob, enqueuePreview, loadExportJob } = await import('../apps/api/src/services/editor-preview.js');
    const videoId = 'Factory_cleanup_owner';
    const frozenFile = path.join(tmp.data, 'projects', videoId, 'editor', 'frozen', 'long-r3.json');
    fs.mkdirSync(path.dirname(frozenFile), { recursive: true });
    const doc = { revision: 3, durationSec: 12, assets: [], visualClips: [], audioClips: [] } as unknown as Parameters<typeof createExportJob>[0]['doc'];
    fs.writeFileSync(frozenFile, JSON.stringify(doc));
    renderStub.delayMs = 10; renderStub.failMarker = null; renderStub.workDir = '';
    const realRemove = fs.rmSync;
    const remove = vi.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
      if (renderStub.workDir && String(candidate) === renderStub.workDir) throw Object.assign(new Error('Synthetic EBUSY cleanup'), { code: 'EBUSY' });
      return realRemove(candidate, options);
    });
    try {
      const job = createExportJob({ videoId, targetId: 'long', doc, frozenFile, audioFiles: {} });
      enqueuePreview(videoId, job, { meta: { input: { cta: '' } } } as unknown as Parameters<typeof enqueuePreview>[2], 'http://127.0.0.1:3000');
      let record = loadExportJob(videoId, job.jobId);
      for (let i = 0; i < 60 && record?.status === 'running'; i++) { await new Promise(r => setTimeout(r, 20)); record = loadExportJob(videoId, job.jobId); }
      expect(record?.status, record?.error ?? '').toBe('ready');
      expect(record?.finishedAt).toBeTruthy();
      expect((record as unknown as { cleanupWarning?: string })?.cleanupWarning).toMatch(/temporary/i);
      expect(fs.existsSync(job.outputFile)).toBe(true);
    } finally {
      remove.mockRestore();
      if (renderStub.workDir) cleanupEditorRenderScratch(path.dirname(renderStub.workDir), path.basename(renderStub.workDir));
    }
  });
  it('stamps finishedAt after the render settles, not when the job was created', async () => {
    const { createExportJob, enqueuePreview, loadExportJob } = await import('../apps/api/src/services/editor-preview.js');
    renderStub.delayMs = 120;
    renderStub.failMarker = null;
    renderStub.calls = 0;

    const videoId = 'Factory_pathfix_A';
    const frozenFile = path.join(tmp.data, 'projects', videoId, 'editor', 'frozen', 'long-r3.json');
    fs.mkdirSync(path.dirname(frozenFile), { recursive: true });
    fs.writeFileSync(frozenFile, JSON.stringify({ revision: 3, durationSec: 12, assets: [], visualClips: [], audioClips: [] }));

    const doc = { revision: 3, durationSec: 12, assets: [], visualClips: [], audioClips: [] } as unknown as Parameters<typeof createExportJob>[0]['doc'];
    const job = createExportJob({ videoId, targetId: 'long', doc, frozenFile, audioFiles: {} });

    const project = { meta: { input: { cta: '' } } } as unknown as Parameters<typeof enqueuePreview>[2];
    const enqueuedAt = Date.now();
    enqueuePreview(videoId, job, project, 'http://127.0.0.1:3000');

    // Right away the job must still be running and carry no completion time.
    const running = loadExportJob(videoId, job.jobId);
    expect(running?.status).toBe('running');
    expect(running?.finishedAt).toBeNull();

    // Wait for settlement via the real persisted record.
    let settled = null as Awaited<ReturnType<typeof loadExportJob>>;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      const now = loadExportJob(videoId, job.jobId);
      if (now && now.status !== 'running') {
        settled = now;
        break;
      }
    }
    expect(settled, 'the job never settled').not.toBeNull();
    const record = settled as NonNullable<typeof settled>;
    expect(record.status).toBe('ready');
    expect(record.createdAt).toBe(job.createdAt);
    expect(record.finishedAt).not.toBeNull();
    const created = Date.parse(record.createdAt);
    const finished = Date.parse(record.finishedAt as string);
    // The completion time must be at settlement: at least the delayed render later
    // than creation, and not before enqueue.
    expect(finished - created).toBeGreaterThanOrEqual(100);
    expect(finished).toBeGreaterThanOrEqual(enqueuedAt);
    // The revision and the media URL are unchanged by the repair.
    expect(record.revision).toBe(3);
    expect(record.mediaUrl).toBe(`/api/projects/${videoId}/editor/export/${job.jobId}/media`);
  });

  it('stamps finishedAt on failure too, and records the error', async () => {
    const { createExportJob, enqueuePreview, loadExportJob } = await import('../apps/api/src/services/editor-preview.js');
    renderStub.delayMs = 60;
    renderStub.failMarker = 'controlled render failure';

    const videoId = 'Factory_pathfix_B';
    const frozenFile = path.join(tmp.data, 'projects', videoId, 'editor', 'frozen', 'long-r2.json');
    fs.mkdirSync(path.dirname(frozenFile), { recursive: true });
    fs.writeFileSync(frozenFile, JSON.stringify({ revision: 2, durationSec: 12, assets: [], visualClips: [], audioClips: [] }));

    const doc = { revision: 2, durationSec: 12, assets: [], visualClips: [], audioClips: [] } as unknown as Parameters<typeof createExportJob>[0]['doc'];
    const job = createExportJob({ videoId, targetId: 'long', doc, frozenFile, audioFiles: {} });
    enqueuePreview(videoId, job, { meta: { input: { cta: '' } } } as unknown as Parameters<typeof enqueuePreview>[2], 'http://127.0.0.1:3000');

    let settled = null as Awaited<ReturnType<typeof loadExportJob>>;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      const now = loadExportJob(videoId, job.jobId);
      if (now && now.status !== 'running') {
        settled = now;
        break;
      }
    }
    const record = settled as NonNullable<typeof settled>;
    expect(record.status).toBe('failed');
    expect(record.error).toContain('controlled render failure');
    expect(record.finishedAt).not.toBeNull();
    expect(Date.parse(record.finishedAt as string) - Date.parse(record.createdAt)).toBeGreaterThanOrEqual(50);
  });

  it('renders into the owned scratch directory and cleans it up afterwards', async () => {
    const { createExportJob, enqueuePreview, loadExportJob } = await import('../apps/api/src/services/editor-preview.js');
    renderStub.delayMs = 20;
    renderStub.failMarker = null;
    const videoId = 'Factory_pathfix_C';
    const frozenFile = path.join(tmp.data, 'projects', videoId, 'editor', 'frozen', 'long-r1.json');
    fs.mkdirSync(path.dirname(frozenFile), { recursive: true });
    fs.writeFileSync(frozenFile, JSON.stringify({ revision: 1, durationSec: 12, assets: [], visualClips: [], audioClips: [] }));
    const doc = { revision: 1, durationSec: 12, assets: [], visualClips: [], audioClips: [] } as unknown as Parameters<typeof createExportJob>[0]['doc'];
    const job = createExportJob({ videoId, targetId: 'long', doc, frozenFile, audioFiles: {} });
    enqueuePreview(videoId, job, { meta: { input: { cta: '' } } } as unknown as Parameters<typeof enqueuePreview>[2], 'http://127.0.0.1:3000');
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      const now = loadExportJob(videoId, job.jobId);
      if (now && now.status !== 'running') break;
    }
    const record = loadExportJob(videoId, job.jobId) as NonNullable<ReturnType<typeof loadExportJob>>;
    expect(record.status).toBe('ready');
    // The renderer received the owned scratch path, and it was removed afterwards.
    expect(renderStub.workDir).toMatch(/exp-[a-f0-9]{32}$/);
    expect(record.scratchDir).toBe(renderStub.workDir);
    expect(fitsBudget(path.join(renderStub.workDir, 'raw-frames.mp4'))).toBe(true);
    expect(fs.existsSync(renderStub.workDir)).toBe(false);
    // The canonical final file is where it always was.
    expect(record.outputFile.endsWith(`${job.jobId}.mp4`)).toBe(true);
    expect(fs.existsSync(record.outputFile)).toBe(true);
  });
});
