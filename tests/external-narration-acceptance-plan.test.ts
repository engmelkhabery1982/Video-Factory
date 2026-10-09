/**
 * VS7 — the later outside-narration acceptance is a plan, not a render.
 *
 * No speech, no model, no MP4, no workflow dispatch. The planner rejects an
 * inside-repo, symlink, or voice-audio path, and the executor may send only
 * the stored-narration read, one Long final export, and a job poll.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_DURATION_MAX_SEC,
  ACCEPTANCE_DURATION_MIN_SEC,
  classifyAcceptanceAudioPath,
  executeAcceptancePlan,
  interpretExportStatus,
  interpretJobStatus,
  narrationGateFromView,
  planExternalNarrationAcceptance,
  redactAcceptanceDiagnostic,
  wavDurationSec,
  type AcceptanceClient,
  type CandidateAudioFacts,
  type StoredNarrationGate,
} from '../scripts/external-narration-acceptance-plan.js';

const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function stored(overrides: Partial<StoredNarrationGate> = {}): StoredNarrationGate {
  return {
    projectId: 'Video_01',
    targetId: 'long',
    sha256: SHA,
    durationSec: 24,
    exportAttemptReady: true,
    publicationApproved: false,
    blockedCodes: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateAudioFacts> = {}): CandidateAudioFacts {
  return {
    label: 'slima.wav',
    sha256: SHA,
    durationSec: 24,
    pathAllowed: true,
    pathProblems: [],
    ...overrides,
  };
}

function view(ready = true) {
  return {
    projectId: 'Video_01',
    targets: [
      {
        targetId: 'long',
        import: { sha256: SHA, durationSec: 24, fileName: 'slima.wav' },
        readiness: {
          exportAttemptReady: ready,
          publicationApproved: false,
          blockers: ready ? [] : [{ code: 'TIMING-APPROVAL-MISSING', message: 'Review timing.' }],
        },
      },
    ],
  };
}

describe('VS7 acceptance planner', () => {
  it('rejects an inside-repo path, a symlink, and a voice-audio path without printing them', () => {
    const repo = '/work/Video-Factory';
    const inside = classifyAcceptanceAudioPath({
      candidatePath: '/work/Video-Factory/data/voiceover/clip.wav',
      repoRoot: repo,
      realPath: '/work/Video-Factory/data/voiceover/clip.wav',
      isSymlink: false,
    });
    const link = classifyAcceptanceAudioPath({
      candidatePath: '/outside/link.wav',
      repoRoot: repo,
      realPath: '/outside/real.wav',
      isSymlink: true,
    });
    const voice = classifyAcceptanceAudioPath({
      candidatePath: '/outside/projects/Video_01/voice-audio/previews/clip.wav',
      repoRoot: repo,
      realPath: '/outside/projects/Video_01/voice-audio/previews/clip.wav',
      isSymlink: false,
    });
    const outside = classifyAcceptanceAudioPath({
      candidatePath: '/outside/recordings/slima.wav',
      repoRoot: repo,
      realPath: '/outside/recordings/slima.wav',
      isSymlink: false,
    });
    expect(inside.allowed).toBe(false);
    expect(link.allowed).toBe(false);
    expect(voice.allowed).toBe(false);
    expect(outside.allowed).toBe(true);
    expect(outside.label).toBe('slima.wav');
    const printed = JSON.stringify([inside, link, voice, outside]);
    expect(printed).not.toContain('/work/');
    expect(printed).not.toContain('/outside/');
    expect(printed).not.toContain('voiceover/');
  });

  it('plans one Long final export and no override, import, or retry', () => {
    const plan = planExternalNarrationAcceptance({
      projectId: 'Video_01',
      candidate: candidate(),
      stored: stored(),
    });
    expect(plan.allowed).toBe(true);
    expect(plan.sendOverride).toBe(false);
    expect(plan.retryExport).toBe(false);
    expect(plan.exportAttempts).toBe(1);
    expect(plan.requests.map((item) => item.purpose)).toEqual([
      'read-stored-narration',
      'export-final-long',
      'poll-job',
    ]);
    const post = plan.requests.find((item) => item.method === 'POST');
    expect(post?.path).toBe('/api/projects/Video_01/export');
    expect(post?.body).toEqual({ kind: 'final', includeShorts: false });
    expect(post?.body).not.toHaveProperty('override');
    expect(JSON.stringify(plan.requests)).not.toMatch(/approval|external\/|voice-audio|override/);
  });

  it('rejects a digest mismatch, a duration outside 20–30 seconds, and a blocked gate', () => {
    const mismatch = planExternalNarrationAcceptance({
      projectId: 'Video_01',
      candidate: candidate({ sha256: OTHER }),
      stored: stored(),
    });
    const short = planExternalNarrationAcceptance({
      projectId: 'Video_01',
      candidate: candidate({ durationSec: ACCEPTANCE_DURATION_MIN_SEC - 0.1 }),
      stored: stored(),
    });
    const long = planExternalNarrationAcceptance({
      projectId: 'Video_01',
      candidate: candidate({ durationSec: ACCEPTANCE_DURATION_MAX_SEC + 0.1 }),
      stored: stored({ durationSec: 31 }),
    });
    const blocked = planExternalNarrationAcceptance({
      projectId: 'Video_01',
      candidate: candidate(),
      stored: stored({ exportAttemptReady: false, blockedCodes: ['TIMING-APPROVAL-STALE'] }),
    });
    const published = planExternalNarrationAcceptance({
      projectId: 'Video_01',
      candidate: candidate(),
      stored: stored({ publicationApproved: true }),
    });
    for (const plan of [mismatch, short, long, blocked, published]) {
      expect(plan.allowed).toBe(false);
      expect(plan.requests).toEqual([]);
      expect(plan.exportAttempts).toBe(0);
    }
    expect(mismatch.problems.join(' ')).toContain('digest');
    expect(blocked.problems.join(' ')).toContain('not import or re-approve');
    expect(published.problems.join(' ')).toContain('Publication approval');
  });

  it('stops on 409 and never sends override or a second export', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const client: AcceptanceClient = {
      async request(call) {
        calls.push(call);
        if (call.method === 'GET' && call.path.endsWith('/external-narration')) {
          return { status: 200, body: view(true) };
        }
        if (call.method === 'POST') return { status: 409, body: { error: 'QC blocked the final export', qc: { file: '/home/user/secret.mp4' } } };
        throw new Error('job poll must not run after 409');
      },
    };
    const plan = planExternalNarrationAcceptance({ projectId: 'Video_01', candidate: candidate(), stored: stored() });
    const result = await executeAcceptancePlan({ client, plan, candidate: candidate() });
    expect(result.ok).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.exportAttempts).toBe(1);
    expect(result.sentOverride).toBe(false);
    expect(result.retriedExport).toBe(false);
    expect(result.publicationApproved).toBe(false);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ kind: 'final', includeShorts: false });
    expect(JSON.stringify(result.problems)).not.toContain('/home/');
    expect(interpretExportStatus(409)).toMatchObject({ stop: true, retryExport: false, sendOverride: false });
    expect(interpretJobStatus('failed').action).toBe('stop');
  });

  it('reads the stored digest from the narration view and polls the job path', async () => {
    const gate = narrationGateFromView(view(false), 'Video_01');
    expect(gate?.sha256).toBe(SHA);
    expect(gate?.exportAttemptReady).toBe(false);
    const calls: string[] = [];
    const client: AcceptanceClient = {
      async request(call) {
        calls.push(`${call.method} ${call.path}`);
        if (call.path.endsWith('/external-narration')) return { status: 200, body: view(true) };
        if (call.method === 'POST') return { status: 202, body: { jobId: 'Video_01:final:1', status: 'running' } };
        return { status: 200, body: { status: 'done' } };
      },
    };
    const plan = planExternalNarrationAcceptance({ projectId: 'Video_01', candidate: candidate(), stored: stored() });
    const result = await executeAcceptancePlan({ client, plan, candidate: candidate(), maxPolls: 2 });
    expect(result.ok).toBe(true);
    expect(result.publicationApproved).toBe(false);
    expect(result.jobStatus).toBe('done');
    expect(calls).toEqual([
      'GET /api/projects/Video_01/external-narration',
      'POST /api/projects/Video_01/export',
      'GET /api/jobs/Video_01:final:1',
    ]);
  });

  it('redacts absolute paths and reads a WAV duration from the header', () => {
    expect(redactAcceptanceDiagnostic('failed at /home/user/Video-Factory/data/voiceover/clip.wav')).not.toContain('/home/');
    expect(redactAcceptanceDiagnostic('voiceover/Video_01_long_abc.wav missing')).not.toContain('voiceover/');
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(48000 * 24, 40);
    expect(wavDurationSec(header)).toBe(24);
    expect(wavDurationSec(Buffer.from('not-a-wav'))).toBeNull();
  });

  it('is not referenced by a workflow', () => {
    const workflows = fs.readdirSync(path.join(process.cwd(), '.github', 'workflows'));
    const text = workflows.map((name) => fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', name), 'utf8')).join('\n');
    expect(text).not.toContain('external-narration-acceptance-plan');
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'external-narration-acceptance-plan.ts'), 'utf8');
    expect(source).not.toMatch(/target-audio\/.+\/external/);
    expect(source).not.toContain('/external/approval');
    expect(source).not.toContain('includeShorts: true');
  });

  it('classifies a real file outside a temporary repository root', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vs7-repo-'));
    const outside = path.join(os.tmpdir(), `vs7-clip-${Date.now()}.wav`);
    fs.writeFileSync(outside, Buffer.from('RIFF'));
    const classified = classifyAcceptanceAudioPath({
      candidatePath: outside,
      repoRoot: repo,
      realPath: fs.realpathSync(outside),
      isSymlink: false,
    });
    expect(classified.allowed).toBe(true);
    expect(JSON.stringify(classified)).not.toContain(outside);
    fs.rmSync(outside);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
