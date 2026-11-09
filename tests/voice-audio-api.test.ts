/**
 * VS3 — Voice & Audio API suite.
 *
 * Exercises the REAL registered routes on the REAL server app
 * (`buildServerApp`), with a project created through the ordinary store, so the
 * integrated workflow is what is being tested: engine availability, reference
 * upload + content validation, the three separate facts (authorization,
 * reference approval, generated-audio approval), assignments, preview
 * generation, artifact-bound approval, invalidation, the cloned-audio render
 * gate, privacy and failure cleanup.
 *
 * TEST/FIXTURE, explicitly: chatterbox synthesis runs the deterministic FAKE
 * worker (`tests/fixtures/chatterbox-fake-worker.py`) behind
 * `BUILDTRAKE_CHATTERBOX_TEST_WORKER=1`. It is stdlib-only, downloads nothing,
 * loads no model and is never enabled in normal operation. Its output is NOT
 * real cloned speech; nothing here claims otherwise.
 *
 * All state lives under the Git-ignored `.stills/test-isolation/` tree, never in
 * the repository's real `data/` directory or `.chatterbox/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'va-api-suite');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  process.env.BUILDTRAKE_CHATTERBOX_TEST_WORKER = '1';
  process.env.BUILDTRAKE_CHATTERBOX_MARKER = nodePath.join(root, 'provision.json');
  process.env.CHATTERBOX_ALLOW_CPU = '1';
  return { root, data, output, marker: nodePath.join(root, 'provision.json') };
});

import {
  PROJECT_SCHEMA_VERSION,
  buildStoryboard,
  emptyHistory,
  type Project,
  type ProjectInput,
} from '@buildtrack/core';
import { loadProject, saveProject } from '../apps/api/src/services/store.js';
import { ffmpegPath } from '../apps/api/src/services/platform.js';
import { buildServerApp } from '../apps/api/src/server.js';
import { referenceWavBuffer, resolveTestPython, FAKE_MODEL_REVISION } from './helpers/chatterbox-worker-fixtures.js';
import { planSegments, VoiceAudioPlanningError } from '../apps/api/src/routes/voice-audio.js';
import { loadVoiceAudioState } from '../apps/api/src/services/voice-audio-state.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

const STORY = 'Every site supervisor knows that safety inspections take time and discipline.';

function projectInput(videoId: string, script: string): ProjectInput {
  return {
    videoId,
    videoType: 'long',
    topic: 'Safety Gear on Site',
    targetAudience: 'Site managers',
    mainProblem: 'PPE non-compliance',
    viewerPromise: 'Practical compliance checklist',
    hook: 'Are your teams truly protected?',
    script,
    keyNumbers: ['100% compliance'],
    keyPoints: ['Hard hats'],
    productName: 'BuildTrack PPE Kit',
    productShots: [],
    cta: 'Book your site audit now',
    voiceoverFile: null,
    targetAudio: {},
    brollFiles: [],
    sourceReferences: [],
    outputLanguage: 'en',
    brandPreset: 'safety_first',
    shortCount: 1,
  };
}

/** A project saved through the ordinary store, as the app itself would. */
function createProject(videoId: string, script = STORY, turns?: { speakerId: string; speakerName: string; text: string }[]): Project {
  const input = projectInput(videoId, script);
  const sb = buildStoryboard({ input, history: emptyHistory(), audioDuration: 60 });
  const { historyEntry: _h, ...storyboard } = sb;
  if (turns && storyboard.long?.scenes?.[0]) {
    (storyboard.long.scenes[0] as unknown as { turns: unknown }).turns = turns;
  }
  const now = new Date().toISOString();
  const project: Project = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    meta: { input, brand: sb.brand, createdAt: now, updatedAt: now, status: 'storyboarded' },
    storyboard,
    artifacts: [],
    qc: [],
  };
  saveProject(project);
  return project;
}

function multipart(fieldName: string, filename: string, mimeType: string, content: Buffer, extra: Record<string, string> = {}) {
  const boundary = '----vs3boundary' + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(extra)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    )
  );
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Upload + authorize + approve a real reference recording; returns its id. */
async function fullyApprovedReference(videoId: string, name = 'Operator voice'): Promise<string> {
  /* 6 s: the route refuses references shorter than one second (a real rule). */
  const wav = referenceWavBuffer(`${videoId}-reference-recording`, 6);
  const up = await app.inject({
    method: 'POST',
    url: `/api/projects/${videoId}/voice-audio/references`,
    ...multipart('file', 'take.wav', 'audio/wav', wav, { displayName: name }),
  });
  expect(up.statusCode).toBe(201);
  const referenceId = up.json().reference.referenceId as string;

  const auth = await app.inject({
    method: 'POST',
    url: `/api/projects/${videoId}/voice-audio/references/${referenceId}/authorize`,
    payload: { ownerConfirmed: true, statement: 'This is my own voice and I authorize its use.', confirmedBy: 'project-owner' },
  });
  expect(auth.statusCode).toBe(200);

  const approve = await app.inject({
    method: 'POST',
    url: `/api/projects/${videoId}/voice-audio/references/${referenceId}/approve`,
    payload: {
      decision: 'approved',
      approver: 'project-owner',
      rights: {
        sourceProvider: 'first-party recording (operator-owned)',
        licenseName: 'First-party own-voice written release',
        evidenceUrl: 'https://rights.example.invalid/own-voice',
        evidenceKind: 'written_permission',
        accessedAt: '2026-10-08',
        commercialUse: 'permitted',
      },
    },
  });
  expect(approve.statusCode).toBe(200);
  return referenceId;
}

async function assignChatterbox(videoId: string, referenceId: string, speakerId = 'narrator'): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${videoId}/voice-audio/assignments`,
    payload: { assignments: [{ speakerId, engine: 'chatterbox', referenceId }] },
  });
  expect(res.statusCode).toBe(200);
}

/** Poll the real job endpoint until it settles (bounded). */
async function waitForJob(videoId: string, jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i += 1) {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${videoId}/voice-audio/jobs/${encodeURIComponent(jobId)}` });
    expect(res.statusCode).toBe(200);
    const job = res.json() as Record<string, unknown>;
    if (job.status === 'done' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('generation job did not settle in time');
}

async function generatePreview(videoId: string): Promise<Record<string, unknown>> {
  const started = await app.inject({ method: 'POST', url: `/api/projects/${videoId}/voice-audio/previews`, payload: {} });
  expect(started.statusCode).toBe(202);
  return waitForJob(videoId, started.json().jobId as string);
}

describe('VS3: Voice & Audio API', () => {
  beforeAll(async () => {
    fs.writeFileSync(
      tmp.marker,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          packageVersion: '0.1.7',
          engineContractId: 'chatterbox-multilingual-v3',
          modelId: 'ResembleAI/chatterbox',
          modelRevision: FAKE_MODEL_REVISION,
          modelVariant: 'v3',
          pythonPath: resolveTestPython(),
          modelDir: '.chatterbox/models',
          provisionedAt: '2026-10-08T00:00:00.000Z',
          watermark: 'resemble-perth',
          notes: 'VS3 API test fixture marker (never a real provisioning result)',
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    app = await buildServerApp();
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    try {
      fs.rmSync(tmp.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /* ------------------------------------------------------------------ */
  /*  A. Engine availability                                            */
  /* ------------------------------------------------------------------ */

  it('reports both engines truthfully and keeps Kokoro a separate explicit choice', async () => {
    createProject('VA_Engines');
    const res = await app.inject({ method: 'GET', url: '/api/projects/VA_Engines/voice-audio' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kokoroSeparateChoice).toBe(true);
    expect(body.engines).toHaveLength(2);
    const chatterbox = body.engines.find((e: any) => e.engine === 'chatterbox');
    const kokoro = body.engines.find((e: any) => e.engine === 'kokoro');
    expect(chatterbox.state).toBe('available');
    /* Fixture-backed availability is stated as such, never as a real provision. */
    expect(chatterbox.notes.join(' ')).toMatch(/TEST FIXTURE/i);
    expect(chatterbox.cpuRequiresOptIn).toBe(true);
    /* Kokoro is not provisioned here (no model cache) and must not be claimed. */
    expect(kokoro.state).toBe('not_provisioned');
    expect(kokoro.remedy).toContain('provision');
    expect(kokoro.selectable).toBe(false);
  });

  it('answers "not provisioned" with the provisioning command when nothing is provisioned', async () => {
    const previousWorker = process.env.BUILDTRAKE_CHATTERBOX_TEST_WORKER;
    const previousMarker = process.env.BUILDTRAKE_CHATTERBOX_MARKER;
    process.env.BUILDTRAKE_CHATTERBOX_TEST_WORKER = '0';
    process.env.BUILDTRAKE_CHATTERBOX_MARKER = path.join(tmp.root, 'absent-marker.json');
    try {
      const res = await app.inject({ method: 'GET', url: '/api/projects/VA_Engines/voice-audio' });
      const chatterbox = res.json().engines.find((e: any) => e.engine === 'chatterbox');
      expect(chatterbox.state).toBe('not_provisioned');
      expect(chatterbox.provisioned).toBe(false);
      expect(chatterbox.remedy).toBe('npm run provision:voice-clone -- --apply');
      expect(chatterbox.detail).toMatch(/not verified as provisioned/i);
      expect(chatterbox.deviceDetail).toBeTruthy();
    } finally {
      process.env.BUILDTRAKE_CHATTERBOX_TEST_WORKER = previousWorker;
      process.env.BUILDTRAKE_CHATTERBOX_MARKER = previousMarker;
    }
  });

  it('answers "device unsupported" (with the CPU opt-in remedy) when only the GPU is missing', async () => {
    const previousWorker = process.env.BUILDTRAKE_CHATTERBOX_TEST_WORKER;
    const previousCpu = process.env.CHATTERBOX_ALLOW_CPU;
    process.env.BUILDTRAKE_CHATTERBOX_TEST_WORKER = '0';
    delete process.env.CHATTERBOX_ALLOW_CPU;
    try {
      const res = await app.inject({ method: 'GET', url: '/api/projects/VA_Engines/voice-audio' });
      const chatterbox = res.json().engines.find((e: any) => e.engine === 'chatterbox');
      expect(chatterbox.provisioned).toBe(true);
      expect(chatterbox.deviceSatisfied).toBe(false);
      expect(chatterbox.state).toBe('device_unsupported');
      expect(chatterbox.detail).toMatch(/No NVIDIA GPU/i);
      expect(chatterbox.remedy).toMatch(/CPU/);
      expect(chatterbox.selectable).toBe(false);
    } finally {
      process.env.BUILDTRAKE_CHATTERBOX_TEST_WORKER = previousWorker;
      process.env.CHATTERBOX_ALLOW_CPU = previousCpu;
    }
  });

  it('is project-scoped: an unknown project is 404 and state never leaks across projects', async () => {
    createProject('VA_Peer');
    expect((await app.inject({ method: 'GET', url: '/api/projects/VA_Nope/voice-audio' })).statusCode).toBe(404);
    const peer = await app.inject({ method: 'GET', url: '/api/projects/VA_Peer/voice-audio' });
    expect(peer.json().references).toHaveLength(0);
    expect(peer.json().renderGate.notApplicable).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  B. Uploads                                                        */
  /* ------------------------------------------------------------------ */

  it('rejects an unsupported extension, a bad MIME type and an empty file', async () => {
    const videoId = 'VA_Upload';
    createProject(videoId);
    const url = `/api/projects/${videoId}/voice-audio/references`;

    const badExt = await app.inject({
      method: 'POST',
      url,
      ...multipart('file', 'voice.txt', 'text/plain', Buffer.from('hello')),
    });
    expect(badExt.statusCode).toBe(400);
    expect(badExt.json().error).toMatch(/Unsupported reference format|not an accepted audio type/);

    const badMime = await app.inject({
      method: 'POST',
      url,
      ...multipart('file', 'voice.wav', 'image/png', referenceWavBuffer('x')),
    });
    expect(badMime.statusCode).toBe(400);
    expect(badMime.json().error).toMatch(/not an accepted audio type/);

    const empty = await app.inject({ method: 'POST', url, ...multipart('file', 'voice.wav', 'audio/wav', Buffer.alloc(0)) });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toMatch(/empty/i);

    /* Nothing was stored. */
    expect(loadVoiceAudioState(videoId).references).toHaveLength(0);
  });

  it('rejects a MISLEADING upload: a .wav extension whose content is not audio', async () => {
    const videoId = 'VA_Upload';
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/references`,
      ...multipart('file', 'honest.wav', 'audio/wav', Buffer.from('this is definitely not a wave file, it is text')),
    });
    expect(res.statusCode).toBe(400);
    /* Content inspection (ffprobe), not the extension, is the authority. */
    expect(res.json().error).toMatch(/audio|probe|decode|stream/i);
    expect(fs.readdirSync(path.join(tmp.data, 'projects', videoId, 'voice-audio', 'references'))).toEqual([]);
  });

  it('rejects an upload whose declared container does not match its extension', async () => {
    const videoId = 'VA_Upload';
    /* A real MP3 payload carried under a .wav name. */
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/references`,
      ...multipart('file', 'wrong.wav', 'audio/wav', await mp3Fixture()),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/do not match its extension/i);
  });

  it('rejects an oversized upload with 413 and leaves nothing behind', async () => {
    const videoId = 'VA_Upload';
    const oversized = Buffer.alloc(65 * 1024 * 1024, 7);
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/references`,
      ...multipart('file', 'big.wav', 'audio/wav', oversized),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/maximum size/i);
    const dir = path.join(tmp.data, 'projects', videoId, 'voice-audio', 'references');
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  }, 60_000);

  it('accepts a valid recording, validates it by content, and reports duration/metrics without consent', async () => {
    const videoId = 'VA_Upload';
    const wav = referenceWavBuffer('valid reference', 6);
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/references`,
      ...multipart('file', 'mine.wav', 'audio/wav', wav, { displayName: 'My own voice' }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    /* Upload grants NOTHING: three separate facts, all still false/pending. */
    expect(body.authorized).toBe(false);
    expect(body.reference.approved).toBe(false);
    expect(body.reference.approvalState).toBe('pending');
    expect(body.validation.checkedBy).toMatch(/ffprobe/);
    expect(body.validation.durationSeconds).toBeGreaterThan(0);
    expect(body.validation.sizeBytes).toBe(wav.length);
    /* Public projection never exposes a filesystem path or stored file name. */
    const json = JSON.stringify(body);
    expect(json).not.toContain(tmp.root);
    expect(json).not.toContain('references/ref_');
    expect(json).not.toContain('.wav');
  });

  it('refuses to approve a reference that was only uploaded (upload cannot grant approval)', async () => {
    const videoId = 'VA_Upload';
    const state = loadVoiceAudioState(videoId);
    const referenceId = state.references[0].referenceId;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/references/${referenceId}/approve`,
      payload: {
        decision: 'approved',
        approver: 'project-owner',
        rights: { sourceProvider: 'x', licenseName: 'y', evidenceUrl: 'https://e.invalid/a', accessedAt: '2026-10-08', commercialUse: 'permitted' },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().blockedCodes.length).toBeGreaterThan(0);
    expect(loadVoiceAudioState(videoId).references[0].approval.state).toBe('pending');
  });

  it('requires a literal owner confirmation and a real statement before recording authorization', async () => {
    const videoId = 'VA_Upload';
    const referenceId = loadVoiceAudioState(videoId).references[0].referenceId;

    const notConfirmed = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/references/${referenceId}/authorize`,
      payload: { ownerConfirmed: false, statement: 'I am the owner of this voice.', confirmedBy: 'me' },
    });
    expect(notConfirmed.statusCode).toBe(400);

    const tooShort = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/references/${referenceId}/authorize`,
      payload: { ownerConfirmed: true, statement: 'yes', confirmedBy: 'me' },
    });
    expect(tooShort.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/references/${referenceId}/authorize`,
      payload: {
        ownerConfirmed: true,
        statement: 'This is my own voice and I authorize its use in this project.',
        confirmedBy: 'project-owner',
      },
    });
    expect(ok.statusCode).toBe(200);
    const state = loadVoiceAudioState(videoId);
    expect(state.references[0].authorization?.ownerConfirmed).toBe(true);
    /* Authorization alone still does not approve the reference. */
    expect(state.references[0].approval.state).toBe('pending');
    /* A recorded authorization artifact exists for the VS1 gate to inspect. */
    expect(state.references[0].consentEvidenceRef).toMatch(/consent\.json$/);
    expect(fs.existsSync(path.join(process.cwd(), state.references[0].consentEvidenceRef!))).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  Reference removal + traversal/symlink safety                      */
  /* ------------------------------------------------------------------ */

  it('refuses path traversal in identifiers and unknown reference ids', async () => {
    createProject('VA_Safe');
    const traversal = await app.inject({ method: 'GET', url: '/api/projects/..%2F..%2Fetc/voice-audio' });
    expect([400, 404]).toContain(traversal.statusCode);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/projects/VA_Safe/voice-audio/references/../../project.json',
    });
    expect([400, 404]).toContain(res.statusCode);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/projects/VA_Safe/voice-audio/references/ref_0000000000000000/authorize',
      payload: { ownerConfirmed: true, statement: 'I authorize this voice recording.', confirmedBy: 'me' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses to remove a referenced recording without an explicit reassignment, then removes it deliberately', async () => {
    const videoId = 'VA_Remove';
    createProject(videoId);
    const referenceId = await fullyApprovedReference(videoId);
    await assignChatterbox(videoId, referenceId);

    const blocked = await app.inject({ method: 'DELETE', url: `/api/projects/${videoId}/voice-audio/references/${referenceId}` });
    expect(blocked.statusCode).toBe(409);
    const stateAfterBlock = loadVoiceAudioState(videoId);
    expect(stateAfterBlock.references.filter((r) => !r.removedAt)).toHaveLength(1);
    expect(fs.existsSync(path.join(process.cwd(), stateAfterBlock.references[0].storedRef))).toBe(true);

    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${videoId}/voice-audio/references/${referenceId}?clearAssignments=true`,
    });
    expect(cleared.statusCode).toBe(200);
    const state = loadVoiceAudioState(videoId);
    expect(state.assignments).toHaveLength(0);
    expect(state.references.every((r) => r.removedAt)).toBe(true);
    /* The private file is gone from disk: removal is deliberate, real deletion. */
    expect(fs.existsSync(path.join(process.cwd(), state.references[0].storedRef))).toBe(false);
  });

  it('never follows a symlinked reference when deleting: the link target survives', async () => {
    const videoId = 'VA_Symlink';
    createProject(videoId);
    const referenceId = await fullyApprovedReference(videoId);
    const state = loadVoiceAudioState(videoId);
    const storedAbs = path.join(process.cwd(), state.references[0].storedRef);
    const outside = path.join(tmp.root, 'outside-source.wav');
    fs.copyFileSync(storedAbs, outside);
    fs.rmSync(storedAbs);
    fs.symlinkSync(outside, storedAbs);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${videoId}/voice-audio/references/${referenceId}?clearAssignments=true`,
    });
    /* Either refused outright, or the link itself is removed — never the target. */
    expect([200, 409]).toContain(res.statusCode);
    expect(fs.existsSync(outside)).toBe(true);

    /* And a symlinked reference never counts as a valid reference recording. */
    const check = await app.inject({ method: 'GET', url: `/api/projects/${videoId}/voice-audio` });
    const listed = check.json().references[0];
    if (listed) expect(listed.approved).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  C. Generation, playback, approval                                 */
  /* ------------------------------------------------------------------ */

  it('generates the complete narration, serves exactly that artifact, and binds approval to it', async () => {
    const videoId = 'VA_Generate';
    createProject(videoId, STORY);
    const referenceId = await fullyApprovedReference(videoId, 'Main narrator');
    await assignChatterbox(videoId, referenceId);

    const job = await generatePreview(videoId);
    expect(job.status).toBe('done');

    const stateRes = await app.inject({ method: 'GET', url: `/api/projects/${videoId}/voice-audio` });
    const payload = stateRes.json();
    expect(payload.preview.status).toBe('ready');
    expect(payload.preview.durationSeconds).toBeGreaterThan(0);
    expect(payload.preview.timing.mode).toBe('full_duration_preserved');
    expect(payload.preview.timing.perSceneAlignment).toBe(false);
    expect(payload.preview.audioUrl).toBe(`/api/projects/${videoId}/voice-audio/previews/${payload.preview.previewId}/audio`);
    expect(payload.approval).toBeNull();

    /* Playback returns THIS project's artifact, byte for byte. */
    const audio = await app.inject({ method: 'GET', url: payload.preview.audioUrl });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toContain('audio/wav');
    expect(audio.headers['cache-control']).toBe('no-store');
    const stored = loadVoiceAudioState(videoId);
    expect(sha256(audio.rawPayload)).toBe(stored.preview!.artifactSha256);
    expect(audio.rawPayload.length).toBeGreaterThan(1000);

    /* Approving stores a decision bound to the identity + artifact digest. */
    const approval = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/previews/${payload.preview.previewId}/approval`,
      payload: { decision: 'approved', approvedBy: 'project-owner' },
    });
    expect(approval.statusCode).toBe(200);
    const after = loadVoiceAudioState(videoId);
    expect(after.approval?.artifactSha256).toBe(after.preview?.artifactSha256);
    expect(after.approval?.identityDigest).toBe(after.preview?.identityDigest);

    const gate = await app.inject({ method: 'GET', url: `/api/projects/${videoId}/voice-audio/render-gate` });
    expect(gate.statusCode).toBe(409);
    expect(gate.json().allowed).toBe(false);
    /* The only remaining blocker is the documented timing integration point. */
    expect(gate.json().blockedCodes).toContain('VOICE-AUDIO-060-TIMING-ALIGNMENT-PENDING');
  }, 120_000);

  it('keeps every character of the script: the planning + request text is byte-identical', async () => {
    const videoId = 'VA_Generate';
    const project = loadProject(videoId)!;
    const state = loadVoiceAudioState(videoId);
    const planned = planSegments(project, state);
    expect(planned).toHaveLength(1);
    /* The text handed to the synthesizer is EXACTLY the script — no trimming of
     * sentences, no re-timing, no fixed-duration slicing. */
    expect(planned[0].spokenText).toBe(STORY);
    expect(sha256(Buffer.from(planned[0].spokenText, 'utf8'))).toBe(
      sha256(Buffer.from(project.meta.input.script, 'utf8'))
    );
    const previewSegment = loadVoiceAudioState(videoId).preview!.segments[0];
    expect(previewSegment.spokenText).toBe(STORY);
    expect(previewSegment.textSha256).toHaveLength(64);
    /* And the measured duration is the real duration of the produced speech. */
    expect(previewSegment.durationSeconds).toBeGreaterThan(0);
  });

  it('blocks planning (never dropping words) when a speaker has no assignment', () => {
    const videoId = 'VA_Dialogue';
    createProject(videoId, 'First line. Second line.', [
      { speakerId: 'host', speakerName: 'Host', text: 'First line.' },
      { speakerId: 'guest', speakerName: 'Guest', text: 'Second line.' },
    ]);
    const project = loadProject(videoId)!;
    const state = loadVoiceAudioState(videoId);
    state.assignments = [
      {
        speakerId: 'host',
        engine: 'kokoro',
        engineId: 'kokoro-js',
        modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
        modelRevision: 'v1.0',
        presetVoiceId: 'af_heart',
      } as never,
    ];
    expect(() => planSegments(project, state)).toThrow(VoiceAudioPlanningError);
    expect(() => planSegments(project, state)).toThrow(/no voice assignment/i);
  });

  it('refuses to start generation when no voice is assigned or the engine cannot run', async () => {
    const videoId = 'VA_Peer';
    const noAssignment = await app.inject({ method: 'POST', url: `/api/projects/${videoId}/voice-audio/previews`, payload: {} });
    expect(noAssignment.statusCode).toBe(409);
    expect(noAssignment.json().error).toMatch(/assign a voice/i);
  });

  it('never silently falls back to Kokoro: an unusable cloned engine blocks generation', async () => {
    const videoId = 'VA_NoFallback';
    createProject(videoId);
    const referenceId = await fullyApprovedReference(videoId);
    await assignChatterbox(videoId, referenceId);

    const previousWorker = process.env.BUILDTRAKE_CHATTERBOX_TEST_WORKER;
    const previousMarker = process.env.BUILDTRAKE_CHATTERBOX_MARKER;
    const previousCpu = process.env.CHATTERBOX_ALLOW_CPU;
    /* A truthfully unusable engine: no verified provisioning marker, no CPU opt-in. */
    process.env.BUILDTRAKE_CHATTERBOX_TEST_WORKER = '0';
    process.env.BUILDTRAKE_CHATTERBOX_MARKER = path.join(tmp.root, 'absent-marker.json');
    delete process.env.CHATTERBOX_ALLOW_CPU;
    try {
      const res = await app.inject({ method: 'POST', url: `/api/projects/${videoId}/voice-audio/previews`, payload: {} });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.engine).toBe('chatterbox');
      expect(body.remedy).toContain('provision');
      expect(JSON.stringify(body)).not.toMatch(/kokoro/i);
      /* No artifact, no approval, and the assignment is untouched. */
      const state = loadVoiceAudioState(videoId);
      expect(state.preview).toBeNull();
      expect(state.assignments[0].engine).toBe('chatterbox');
    } finally {
      process.env.BUILDTRAKE_CHATTERBOX_TEST_WORKER = previousWorker;
      process.env.BUILDTRAKE_CHATTERBOX_MARKER = previousMarker;
      if (previousCpu === undefined) delete process.env.CHATTERBOX_ALLOW_CPU;
      else process.env.CHATTERBOX_ALLOW_CPU = previousCpu;
    }
  });

  it('cleans up a failed generation without touching the source recording', async () => {
    const videoId = 'VA_Failure';
    createProject(videoId);
    const referenceId = await fullyApprovedReference(videoId);
    await assignChatterbox(videoId, referenceId);
    const before = loadVoiceAudioState(videoId).references[0];
    const referenceAbs = path.join(process.cwd(), before.storedRef);
    const referenceShaBefore = sha256(fs.readFileSync(referenceAbs));

    process.env.FAKE_CHATTERBOX_MODE = 'nonzero';
    try {
      const started = await app.inject({ method: 'POST', url: `/api/projects/${videoId}/voice-audio/previews`, payload: {} });
      const job = await waitForJob(videoId, started.json().jobId as string);
      expect(job.status).toBe('failed');
      const error = job.error as { code: string; message: string };
      expect(error.code).toMatch(/CHATTERBOX/);
      /* Sanitized: no absolute paths leak into the error. */
      expect(error.message).not.toContain(tmp.root);
      expect(error.message).not.toContain(process.cwd());

      const state = loadVoiceAudioState(videoId);
      expect(state.preview?.status).toBe('failed');
      expect(state.approval).toBeNull();
      /* The source recording is untouched: same bytes, same hash, still there. */
      expect(fs.existsSync(referenceAbs)).toBe(true);
      expect(sha256(fs.readFileSync(referenceAbs))).toBe(referenceShaBefore);
      /* No partial preview artifacts survive. */
      const previewsDir = path.join(tmp.data, 'projects', videoId, 'voice-audio', 'previews');
      const leftovers = fs.existsSync(previewsDir)
        ? fs.readdirSync(previewsDir).flatMap((entry) => {
            const p = path.join(previewsDir, entry);
            return fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => path.join(entry, f)) : [entry];
          })
        : [];
      expect(leftovers).toEqual([]);
    } finally {
      delete process.env.FAKE_CHATTERBOX_MODE;
    }
  }, 120_000);

  it('propagates a synthesized failure state into the engine availability answer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/VA_Failure/voice-audio' });
    const chatterbox = res.json().engines.find((e: any) => e.engine === 'chatterbox');
    expect(chatterbox.state).toBe('generation_failed');
    expect(chatterbox.lastFailure?.code).toMatch(/CHATTERBOX/);
  });

  it('rejects a preview for another project and a superseded preview id', async () => {
    const videoId = 'VA_Generate';
    const other = 'VA_Peer';
    const state = loadVoiceAudioState(videoId);
    const previewId = state.preview!.previewId;
    expect(
      (await app.inject({ method: 'GET', url: `/api/projects/${other}/voice-audio/previews/${previewId}/audio` })).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/projects/${other}/voice-audio/previews/${previewId}/approval`,
          payload: { decision: 'approved', approvedBy: 'x' },
        })
      ).statusCode
    ).toBe(404);
  });

  /* ------------------------------------------------------------------ */
  /*  D. Invalidation                                                   */
  /* ------------------------------------------------------------------ */

  it('invalidates the approval when the script changes, through the digest', async () => {
    const videoId = 'VA_Invalidate';
    createProject(videoId, STORY);
    const referenceId = await fullyApprovedReference(videoId);
    await assignChatterbox(videoId, referenceId);
    expect((await generatePreview(videoId)).status).toBe('done');

    const previewId = loadVoiceAudioState(videoId).preview!.previewId;
    const approved = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/previews/${previewId}/approval`,
      payload: { decision: 'approved', approvedBy: 'project-owner' },
    });
    expect(approved.statusCode).toBe(200);

    /* The user edits the script through the ordinary project route. */
    const project = loadProject(videoId)!;
    const changed: Project = {
      ...project,
      meta: { ...project.meta, input: { ...project.meta.input, script: `${STORY} And one more sentence.` } },
    };
    saveProject(changed);

    const after = await app.inject({ method: 'GET', url: `/api/projects/${videoId}/voice-audio` });
    const payload = after.json();
    expect(payload.approval?.boundToCurrentPreview).toBe(false);
    expect(payload.approval?.staleCodes).toContain('APPROVAL-STALE-IDENTITY');
    expect(payload.renderGate.allowed).toBe(false);
    expect(payload.renderGate.blockedCodes).toContain('APPROVAL-STALE-IDENTITY');
  }, 120_000);

  it('invalidates the approval when the reference, the speaker or the engine changes', async () => {
    const videoId = 'VA_Invalidate2';
    createProject(videoId);
    const first = await fullyApprovedReference(videoId, 'First take');
    await assignChatterbox(videoId, first);
    expect((await generatePreview(videoId)).status).toBe('done');
    const previewId = loadVoiceAudioState(videoId).preview!.previewId;
    await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/previews/${previewId}/approval`,
      payload: { decision: 'approved', approvedBy: 'project-owner' },
    });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${videoId}/voice-audio` })).json().approval?.boundToCurrentPreview).toBe(true);

    /* A second, DIFFERENT reference: reassigning invalidates the approval. */
    const second = await fullyApprovedReference(videoId, 'Second take');
    await assignChatterbox(videoId, second);
    let payload = (await app.inject({ method: 'GET', url: `/api/projects/${videoId}/voice-audio` })).json();
    expect(payload.approval?.boundToCurrentPreview).toBe(false);
    expect(payload.renderGate.allowed).toBe(false);

    /* Switching the engine is a different identity as well. */
    const switched = await app.inject({
      method: 'PUT',
      url: `/api/projects/${videoId}/voice-audio/assignments`,
      payload: { assignments: [{ speakerId: 'narrator', engine: 'kokoro', presetVoiceId: 'af_heart' }] },
    });
    expect(switched.statusCode).toBe(200);
    payload = (await app.inject({ method: 'GET', url: `/api/projects/${videoId}/voice-audio` })).json();
    expect(payload.approval?.boundToCurrentPreview).toBe(false);
    /* Now NOTHING clones a voice, so the render gate is not applicable again. */
    expect(payload.clonedVoiceSelected).toBe(false);
    expect(payload.renderGate.notApplicable).toBe(true);
    void first;
  }, 180_000);

  it('refuses a cloned assignment for a reference that is not approved yet', async () => {
    const videoId = 'VA_Unapproved';
    createProject(videoId);
    const wav = referenceWavBuffer('unapproved reference', 6);
    const up = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/voice-audio/references`,
      ...multipart('file', 'take.wav', 'audio/wav', wav, { displayName: 'Not approved yet' }),
    });
    const referenceId = up.json().reference.referenceId as string;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${videoId}/voice-audio/assignments`,
      payload: { assignments: [{ speakerId: 'narrator', engine: 'chatterbox', referenceId }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().blockedCodes.join(' ')).toMatch(/NOT-APPROVED|NOT-AUTHORIZED/);
    expect(loadVoiceAudioState(videoId).assignments).toHaveLength(0);
  });

  /* ------------------------------------------------------------------ */
  /*  Render gate integration                                           */
  /* ------------------------------------------------------------------ */

  it('blocks a final export while the cloned audio is unapproved, and leaves non-cloning projects alone', async () => {
    const videoId = 'VA_Export';
    createProject(videoId);
    const referenceId = await fullyApprovedReference(videoId);
    await assignChatterbox(videoId, referenceId);

    const blocked = await app.inject({ method: 'POST', url: `/api/projects/${videoId}/export`, payload: { kind: 'final' } });
    expect(blocked.statusCode).toBe(409);
    const gate = blocked.json().clonedAudioGate;
    expect(gate.allowed).toBe(false);
    expect(gate.blockedCodes).toEqual(expect.arrayContaining(['PREVIEW-MISSING']));
    expect(blocked.json().blockReason).toBeTruthy();

    /*
     * A project with no cloned voice is explicitly not affected by this gate.
     * The script is deliberately empty so ordinary QC blocks this export: the
     * test then proves the voice gate stayed out of the way WITHOUT ever
     * starting a render (no video is produced by this suite).
     */
    createProject('VA_Plain', '');
    /* No scenes at all: ordinary QC blocks this export deterministically, so the
     * assertion proves the voice gate stayed out of the way WITHOUT the test
     * ever starting a video render. */
    const plainProject = loadProject('VA_Plain')!;
    plainProject.storyboard.long.scenes = [];
    plainProject.storyboard.shorts = [];
    saveProject(plainProject);
    const plain = await app.inject({ method: 'POST', url: '/api/projects/VA_Plain/export', payload: { kind: 'final' } });
    expect(plain.statusCode).toBe(409);
    expect(plain.json().clonedAudioGate).toBeUndefined();
    expect(plain.json().error).toBeTruthy();
  });

  it('reports the render gate as not applicable for a project with no cloned voice', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/VA_Plain/voice-audio/render-gate' });
    expect(res.statusCode).toBe(200);
    expect(res.json().notApplicable).toBe(true);
    expect(res.json().allowed).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  Privacy                                                           */
  /* ------------------------------------------------------------------ */

  it('keeps reference recordings out of the public file listing and never reports a path', async () => {
    const videoId = 'VA_Generate';
    const files = await app.inject({ method: 'GET', url: '/api/files' });
    expect(files.statusCode).toBe(200);
    const text = JSON.stringify(files.json());
    expect(text).not.toContain('voice-audio');
    expect(text).not.toContain(loadVoiceAudioState(videoId).references[0].storedRef);

    const refs = loadVoiceAudioState(videoId).references[0];
    expect(refs.storedRef.startsWith('data/') || refs.storedRef.includes('voice-audio')).toBe(true);
    /* The service root is confined to the project's own voice-audio directory. */
    expect(refs.storedRef).toContain(path.join('projects', videoId, 'voice-audio'));
  });

  /* ------------------------------------------------------------------ */
  /*  Reload / persistence                                              */
  /* ------------------------------------------------------------------ */

  it('restores the same valid state after a reload (fresh read from disk)', async () => {
    const videoId = 'VA_Generate';
    const before = loadVoiceAudioState(videoId);
    const res = await app.inject({ method: 'GET', url: `/api/projects/${videoId}/voice-audio` });
    const payload = res.json();
    expect(payload.references.map((r: any) => r.referenceId)).toEqual(before.references.map((r) => r.referenceId));
    expect(payload.references[0].approved).toBe(true);
    expect(payload.approval.decision).toBe('approved');
    expect(payload.approval.boundToCurrentPreview).toBe(true);
    expect(payload.assignments[0].referenceId).toBe(before.assignments[0].referenceId);
    expect(loadProject(videoId)).toBeTruthy();
  });

  /* ------------------------------------------------------------------ */
  /*  Kokoro workflow unchanged                                         */
  /* ------------------------------------------------------------------ */

  it('keeps the Kokoro path explicit and truthful when Kokoro is not provisioned', async () => {
    const videoId = 'VA_Kokoro';
    createProject(videoId);
    const assigned = await app.inject({
      method: 'PUT',
      url: `/api/projects/${videoId}/voice-audio/assignments`,
      payload: { assignments: [{ speakerId: 'narrator', engine: 'kokoro', presetVoiceId: 'af_heart' }] },
    });
    expect(assigned.statusCode).toBe(200);

    const res = await app.inject({ method: 'POST', url: `/api/projects/${videoId}/voice-audio/previews`, payload: {} });
    /* In this sandbox Kokoro's model cache is absent, so it must say so — and it
     * must NOT quietly synthesize with the fixture-backed clone engine. */
    expect(res.statusCode).toBe(409);
    expect(res.json().engine).toBe('kokoro');
    expect(JSON.stringify(res.json())).not.toMatch(/fixture/i);
    const state = loadVoiceAudioState(videoId);
    expect(state.preview).toBeNull();
    expect(state.assignments[0].engine).toBe('kokoro');
  });
});

/**
 * A REAL mp3 payload (encoded with the application's own ffmpeg from the
 * synthetic WAV), so the "declared container does not match the extension" case
 * is judged by ffprobe exactly as a genuine mp3 upload would be.
 */
async function mp3Fixture(): Promise<Buffer> {
  if (mp3Bytes) return mp3Bytes;
  const wavAbs = path.join(tmp.root, 'mp3-source.wav');
  const mp3Abs = path.join(tmp.root, 'mp3-source.mp3');
  fs.writeFileSync(wavAbs, referenceWavBuffer('mp3 source audio', 2));
  await new Promise<void>((resolve, reject) => {
    execFile(ffmpegPath(), ['-y', '-i', wavAbs, '-codec:a', 'libmp3lame', '-b:a', '64k', mp3Abs], (error) =>
      error ? reject(error) : resolve()
    );
  });
  mp3Bytes = fs.readFileSync(mp3Abs);
  return mp3Bytes;
}
let mp3Bytes: Buffer | null = null;
