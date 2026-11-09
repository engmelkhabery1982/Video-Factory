/**
 * Transcription runner contract (service level). FIXTURE evidence only: the runner is tests/fixtures/…mjs, which
 * decodes nothing. These tests prove the invocation contract (no script or text argument, named flags, path
 * mapping), provenance acceptance and refusal, dedupe and reuse rules, and the failure states. They are not evidence
 * that the real model transcribes anything. That needs the owner-host run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';


const realSetTimeout = globalThis.setTimeout;
const RUNNER = path.resolve('tests/fixtures/transcription-runner-fixture.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trs-runner-'));
let svc: typeof import('../apps/api/src/services/factory-transcription.ts');
let audioA: string;
let audioB: string;
let audioC: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VF_TRANSCRIBE_COMMAND: JSON.stringify(['node', RUNNER]),
    VF_ALIGN_CHECKPOINT: path.join(root, 'ckpt.pt'),
    VF_ALIGN_TOKENIZER: path.join(root, 'tok.model'),
    VF_ALIGN_PATH_STYLE: 'native',
    VF_ALLOW_FIXTURE_TRANSCRIPT: '1',
    FIXTURE_RUNNER_MODE: '',
    FIXTURE_SHAPE: '',
    FIXTURE_DELAY_MS: '0',
    FIXTURE_IGNORE_TERM: '',
    FIXTURE_WRONG_SHA: '',
    FIXTURE_NO_DECODER: '',
    FIXTURE_ARGV_LOG: path.join(root, 'argv.log'),
    ...extra,
  };
}

async function settle(jobId: string, statuses: string[] = ['succeeded', 'failed', 'canceled', 'unavailable'], ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const job = svc.loadJob(jobId);
    if (job && statuses.includes(job.status)) return job;
    if (Date.now() > until) throw new Error(`job ${jobId} did not settle: ${job?.status}`);
    await new Promise((r) => realSetTimeout(r, 40));
  }
}

function argvLog(): string[][] {
  const file = path.join(root, 'argv.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
}

beforeAll(async () => {
  process.env.BUILDTRAKE_DATA = path.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = path.join(root, 'output');
  svc = await import('../apps/api/src/services/factory-transcription.ts');
  audioA = path.join(root, 'rec-a.wav');
  audioB = path.join(root, 'rec-b.wav');
  audioC = path.join(root, 'rec-c.wav');
  fs.writeFileSync(audioA, Buffer.from('RIFF-fixture-audio-A'));
  fs.writeFileSync(audioB, Buffer.from('RIFF-fixture-audio-B'));
  fs.writeFileSync(audioC, Buffer.from('RIFF-fixture-audio-C'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('invocation contract: no script, named flags only', () => {
  it('the runner receives audio and output paths plus checkpoint and tokenizer, and nothing textual', async () => {
    fs.rmSync(path.join(root, 'argv.log'), { force: true });
    const started = svc.startJob({ audioAssetId: 'aud-inv', audioFile: audioA, audioDurationSec: 3, env: env({ FIXTURE_SHAPE: 'greedy' }), rerun: true });
    await settle(started.job.jobId);
    const [argv] = argvLog();
    expect(argv).toBeDefined();
    const flags = argv.filter((a) => a.startsWith('--'));
    expect(flags).toEqual(['--audio', '--out', '--checkpoint', '--tokenizer'].filter((f) => flags.includes(f)));
    expect(flags).toHaveLength(4);
    // No argument may name a textual input. Paths are checked as values, not by their words.
    for (const a of argv.filter((x) => x.startsWith('--'))) expect(a).toMatch(/^--(audio|out|checkpoint|tokenizer)$/);
    expect(argv[argv.indexOf('--audio') + 1]).toBe(audioA);
  });

  it('the argv builder maps Windows paths to WSL with the existing runnerPath rule, and nothing else', () => {
    const argv = svc.transcribeArgv(
      {
        VF_TRANSCRIBE_COMMAND: JSON.stringify(['wsl.exe', '-d', 'Ubuntu', '--', '/opt/vf/python', '/mnt/c/vf/transcribe_recording.py']),
        VF_ALIGN_PATH_STYLE: 'wsl',
        VF_ALIGN_CHECKPOINT: 'C:\\models\\ckpt.pt',
        VF_ALIGN_TOKENIZER: 'C:\\models\\tok.model',
      },
      'C:\\owner\\recordings\\rec.wav',
      'D:\\qa\\out.json',
    );
    expect(argv).toEqual([
      '-d', 'Ubuntu', '--', '/opt/vf/python', '/mnt/c/vf/transcribe_recording.py',
      '--audio', '/mnt/c/owner/recordings/rec.wav',
      '--out', '/mnt/d/qa/out.json',
      '--checkpoint', '/mnt/c/models/ckpt.pt',
      '--tokenizer', '/mnt/c/models/tok.model',
    ]);
    expect(argv.join(' ')).not.toMatch(/[A-Za-z]:\\\\/);
  });

  it('a missing checkpoint or tokenizer is reported exactly and nothing runs', () => {
    const cap = svc.transcriptionCapability(env({ VF_ALIGN_CHECKPOINT: '' }));
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/VF_ALIGN_CHECKPOINT and VF_ALIGN_TOKENIZER/);
    const job = svc.startJob({ audioAssetId: 'aud-missing', audioFile: audioA, audioDurationSec: 3, env: env({ VF_ALIGN_CHECKPOINT: '' }), rerun: true });
    expect(job.job.status).toBe('unavailable');
  });
});

describe('provenance: independent, identity-bearing, hash-checked', () => {
  it('a greedy-shaped result is accepted with method, emissions and model identity recorded', async () => {
    const started = svc.startJob({ audioAssetId: 'aud-greedy', audioFile: audioB, audioDurationSec: 3, env: env({ FIXTURE_SHAPE: 'greedy' }), rerun: true });
    const job = await settle(started.job.jobId);
    expect(job.status).toBe('succeeded');
    expect(job.provenance).toMatchObject({
      method: 'greedy_ctc',
      fixture: false,
      independentOfScript: true,
      emissionsSha256: 'a'.repeat(64),
      model: { arch: '300m_v2', checkpointBytes: 1304065508, tokenizerBytes: 91481 },
      frames: 1000,
    });
    expect(job.reason).toBeNull();
    expect(job.runnerIdentity).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a result that names other audio is refused: no transcript is kept', async () => {
    const started = svc.startJob({ audioAssetId: 'aud-wrong', audioFile: audioA, audioDurationSec: 3, env: env({ FIXTURE_SHAPE: 'greedy', FIXTURE_WRONG_SHA: '1' }), rerun: true });
    const job = await settle(started.job.jobId);
    expect(job.status).toBe('failed');
    expect(job.reason).toMatch(/names other audio/);
    expect(job.transcript).toBeNull();
  });

  it('a runner that reports no decoder yields a failed job with its reason, never a copied text', async () => {
    const started = svc.startJob({ audioAssetId: 'aud-nodec', audioFile: audioA, audioDurationSec: 3, env: env({ FIXTURE_SHAPE: 'greedy', FIXTURE_NO_DECODER: '1' }), rerun: true });
    const job = await settle(started.job.jobId);
    expect(job.status).toBe('failed');
    expect(job.reason).toMatch(/character decoder is unavailable/);
    expect(job.transcript).toBeNull();
  });

  it('acceptance refuses script-copied, non-emission, fixture-without-flag and emission-less results', () => {
    const base = { transcript: 'x', audioSha256: 'f'.repeat(64), engine: 'e' };
    const ok = { method: 'greedy_ctc', source: 'frame_emissions', independentOfScript: true, scriptCopied: false, fixture: false, emissionsSha256: 'a'.repeat(64) };
    expect(typeof svc.parseRunnerOutput({ ...base, provenance: ok }, 'f'.repeat(64), {})).toBe('object');
    expect(svc.parseRunnerOutput({ ...base, provenance: { ...ok, scriptCopied: true } }, 'f'.repeat(64), {})).toMatch(/not an independent decode/);
    expect(svc.parseRunnerOutput({ ...base, provenance: { ...ok, source: 'script' } }, 'f'.repeat(64), {})).toMatch(/frame emissions/);
    expect(svc.parseRunnerOutput({ ...base, provenance: { ...ok, emissionsSha256: '' } }, 'f'.repeat(64), {})).toMatch(/no emissions/);
    expect(svc.parseRunnerOutput({ ...base, provenance: { ...ok, fixture: true, method: 'fixture_stand_in' } }, 'f'.repeat(64), {})).toMatch(/only in tests/);
  });
});

describe('dedupe, reuse and identity', () => {
  it('identical concurrent requests share one running job', async () => {
    const a = svc.startJob({ audioAssetId: 'aud-dup', audioFile: audioA, audioDurationSec: 3, env: env({ FIXTURE_DELAY_MS: '500', FIXTURE_SHAPE: 'greedy' }), rerun: true });
    const b = svc.startJob({ audioAssetId: 'aud-dup', audioFile: audioA, audioDurationSec: 3, env: env({ FIXTURE_DELAY_MS: '500', FIXTURE_SHAPE: 'greedy' }), rerun: true });
    expect(b.created).toBe(false);
    expect(b.job.jobId).toBe(a.job.jobId);
    await settle(a.job.jobId);
  });

  it('a completed greedy result is reused for the same audio and runner identity, without another run', async () => {
    const first = svc.startJob({ audioAssetId: 'aud-reuse', audioFile: audioB, audioDurationSec: 3, env: env({ FIXTURE_SHAPE: 'greedy' }), rerun: true });
    await settle(first.job.jobId);
    const runs = argvLog().length;
    const again = svc.startJob({ audioAssetId: 'aud-reuse', audioFile: audioB, audioDurationSec: 3, env: env({ FIXTURE_SHAPE: 'greedy' }) });
    expect(again.created).toBe(false);
    expect(again.job.jobId).toBe(first.job.jobId);
    expect(argvLog().length).toBe(runs);
  });

  it('rerun forces a new run', async () => {
    const first = svc.startJob({ audioAssetId: 'aud-rerun', audioFile: audioB, audioDurationSec: 3, env: env({ FIXTURE_SHAPE: 'greedy' }), rerun: true });
    await settle(first.job.jobId);
    const again = svc.startJob({ audioAssetId: 'aud-rerun', audioFile: audioB, audioDurationSec: 3, env: env({ FIXTURE_SHAPE: 'greedy' }), rerun: true });
    expect(again.created).toBe(true);
    expect(again.job.jobId).not.toBe(first.job.jobId);
    await settle(again.job.jobId);
  });

  it('a different runner identity (tokenizer changed) does not reuse, and fixture results are never reused', async () => {
    const greedy = svc.startJob({ audioAssetId: 'aud-ident', audioFile: audioB, audioDurationSec: 3, env: env({ FIXTURE_SHAPE: 'greedy' }), rerun: true });
    await settle(greedy.job.jobId);
    const other = svc.startJob({ audioAssetId: 'aud-ident', audioFile: audioB, audioDurationSec: 3, env: env({ FIXTURE_SHAPE: 'greedy', VF_ALIGN_TOKENIZER: path.join(root, 'other.model') }) });
    expect(other.created).toBe(true);
    await settle(other.job.jobId);
    // audioC has no real result, so the only completed job for it is a fixture; it must not be reused.
    const fixture = svc.startJob({ audioAssetId: 'aud-fix', audioFile: audioC, audioDurationSec: 3, env: env({}), rerun: true });
    await settle(fixture.job.jobId);
    expect(svc.loadJob(fixture.job.jobId)?.provenance?.fixture).toBe(true);
    const again = svc.startJob({ audioAssetId: 'aud-fix', audioFile: audioC, audioDurationSec: 3, env: env({}) });
    expect(again.created).toBe(true);
    await settle(again.job.jobId);
  });
});

describe('timeout and cancel', () => {
  it('a runner that exceeds the timeout is stopped and the job fails with the timeout reason', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const started = svc.startJob({ audioAssetId: 'aud-timeout', audioFile: audioA, audioDurationSec: 3, env: env({ FIXTURE_DELAY_MS: '600000', VF_TRANSCRIBE_TIMEOUT_SEC: '60' }), rerun: true });
      vi.advanceTimersByTime(60_000);
      const job = await settle(started.job.jobId, ['failed', 'succeeded', 'canceled'], 20000);
      expect(job.status).toBe('failed');
      expect(job.reason).toMatch(/did not finish within 60 seconds/);
      expect(job.transcript).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel discards a late answer: the job stays canceled and gets no transcript', async () => {
    const started = svc.startJob({ audioAssetId: 'aud-cancel', audioFile: audioA, audioDurationSec: 3, env: env({ FIXTURE_DELAY_MS: '700', FIXTURE_SHAPE: 'greedy' }), rerun: true });
    svc.cancelJob(started.job.jobId);
    await new Promise((r) => realSetTimeout(r, 1500));
    const job = svc.loadJob(started.job.jobId);
    expect(job?.status).toBe('canceled');
    expect(job?.transcript).toBeNull();
  });
});
