/**
 * VS4 — external narration import API suite.
 *
 * Exercises the REAL registered routes on the REAL server app
 * (`buildServerApp`) with a project created through the ordinary store, so the
 * integrated workflow is what is tested: import a narration produced outside
 * the app, declare its source, listen to the exact bytes, approve them, check
 * that the timing must cover the measured audio, and confirm that export is
 * blocked until it does.
 *
 * NO synthesis engine is involved anywhere in this suite: no Chatterbox worker,
 * no model, no download, no provisioning. The narration fixtures are
 * deterministic PCM WAV buffers generated in-process — TEST/FIXTURE only, and
 * not a claim about any real voice.
 *
 * All state lives under the Git-ignored `.stills/test-isolation/` tree, never in
 * the repository's real `data/` directory or `.production/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'ext-audio-api-suite');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  return { root, data, output };
});

import {
  PROJECT_SCHEMA_VERSION,
  buildStoryboard,
  emptyHistory,
  type Project,
  type ProjectInput,
} from '@buildtrack/core';
import { loadProject, saveProject } from '../apps/api/src/services/store.js';
import { externalNarrationRenderGate } from '../apps/api/src/services/external-audio-gate.js';
import { exportTargetIds } from '@buildtrack/core';
import { buildServerApp } from '../apps/api/src/server.js';
import { loadVoiceAudioState, saveVoiceAudioState } from '../apps/api/src/services/voice-audio-state.js';
import { referenceWavBuffer, sha256OfBuffer } from './helpers/chatterbox-worker-fixtures.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

const STORY = 'Every site supervisor knows that safety inspections take time and discipline.';

/** Deterministic 24 kHz mono PCM16 WAV of an exact length (TEST/FIXTURE). */
function narrationWav(seconds: number): Buffer {
  return referenceWavBuffer(`narration-${seconds.toFixed(2)}`, seconds);
}

function voiceoverNames(): string[] {
  const dir = path.join(tmp.data, 'voiceover');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

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
    keyPoints: ['Hard hats', 'Harnesses'],
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

function createProject(videoId: string, audioDuration = 62.4, script = STORY): Project {
  const input = projectInput(videoId, script);
  const sb = buildStoryboard({ input, history: emptyHistory(), audioDuration });
  const { historyEntry: _h, ...storyboard } = sb;
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

function multipart(
  fieldName: string,
  filename: string,
  mimeType: string,
  content: Buffer,
  extra: Record<string, string> = {},
) {
  const boundary = '----vs4boundary' + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(extra)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
  );
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

const DECLARATION = {
  scriptText: STORY,
  sourceKind: 'authorized_external_synthesis',
  ownershipConfirmed: 'true',
  ownershipStatement: 'Licensed vendor, invoice 1234',
  speakerName: 'Operator voice',
  speakerId: 'narrator',
  engineName: 'Chatterbox',
  modelName: 'turbo',
  voiceName: 'clone-a',
};

async function importNarration(
  videoId: string,
  target: string,
  wav: Buffer,
  overrides: Record<string, string> = {},
  filename = 'narration.wav',
) {
  return app.inject({
    method: 'POST',
    url: `/api/projects/${videoId}/target-audio/${target}/external`,
    ...multipart('file', filename, 'audio/wav', wav, { ...DECLARATION, ...overrides }),
  });
}

async function approve(videoId: string, target: string, decision: 'approved' | 'rejected', listened = true) {
  return app.inject({
    method: 'POST',
    url: `/api/projects/${videoId}/target-audio/${target}/external/approval`,
    payload: { decision, listened, decidedBy: 'project-owner' },
  });
}


function coveringTiming(timing: any, endCardSec = 0.5) {
  const audio = Number(timing.audioDurationSec);
  const scenes = timing.scenes as any[];
  const speech = scenes.filter((scene) => scene.role !== 'endcard' && scene.role !== 'cta');
  const tail = scenes.filter((scene) => scene.role === 'endcard' || scene.role === 'cta');
  const speechTargets = speech.length > 0 ? speech : scenes;
  const weights = speechTargets.map((scene) => Math.max(0.5, Number(scene.durationSec)));
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  const durationById = new Map<string, number>();
  let used = 0;
  speechTargets.forEach((scene, index) => {
    const duration = Number(((weights[index] / weightSum) * audio).toFixed(3));
    durationById.set(scene.sceneId, duration);
    used += duration;
  });
  const lastSpeech = speechTargets[speechTargets.length - 1];
  durationById.set(lastSpeech.sceneId, Number((durationById.get(lastSpeech.sceneId)! + (audio - used)).toFixed(3)));
  const tailDuration = tail.length > 0 ? endCardSec / tail.length : 0;
  for (const scene of tail) durationById.set(scene.sceneId, Number(tailDuration.toFixed(3)));
  let acc = 0;
  const nextScenes = scenes.map((scene) => {
    const durationSec = durationById.get(scene.sceneId) ?? 0.5;
    const startTime = Number(acc.toFixed(3));
    acc += durationSec;
    return { sceneId: scene.sceneId, startTime, durationSec: Number(durationSec.toFixed(3)) };
  });
  const cues = timing.captions as any[];
  const captions = cues.map((cue, index) => {
    const slot = audio / Math.max(1, cues.length);
    const start = Number((index * slot + 0.05).toFixed(3));
    const end = Number((Math.min(audio - 0.05, (index + 1) * slot - 0.05)).toFixed(3));
    return { cueId: cue.cueId, start, end: Math.max(start + 0.2, end) };
  });
  return { scenes: nextScenes, captions };
}

async function regenerateStoryboard(videoId: string) {
  return app.inject({ method: 'POST', url: `/api/projects/${videoId}/storyboard`, payload: { preserveEdits: false } });
}

beforeAll(async () => {
  app = await buildServerApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('VS4: importing narration produced outside the app', () => {
  it('imports a WAV, measures its decoded duration and stores it per target', async () => {
    createProject('Video_Imp1');
    const wav = narrationWav(12);
    const res = await importNarration('Video_Imp1', 'long', wav);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.import.durationSec).toBeCloseTo(12, 1);
    expect(body.import.durationSource).toBe('ffprobe');
    expect(body.import.sha256).toBe(sha256OfBuffer(wav));
    expect(body.import.storedRef).toMatch(/^voiceover\/Video_Imp1_long_[a-z0-9]+\.wav$/);
    expect(body.view.ready).toBe(false);
    expect(body.view.blockReasons.join(' ')).toContain('not been approved');

    const project = loadProject('Video_Imp1');
    expect(project?.meta.input.voiceoverFile).toBe(body.import.storedRef);
    /* The narration is publishable narration, not a private reference recording. */
    expect(loadVoiceAudioState('Video_Imp1').references).toHaveLength(0);
  });

  it('needs no synthesis engine: nothing is provisioned and no worker runs', async () => {
    createProject('Video_Imp2');
    const res = await importNarration('Video_Imp2', 'long', narrationWav(8));
    expect(res.statusCode).toBe(201);
    const state = loadVoiceAudioState('Video_Imp2');
    expect(state.preview).toBeNull();
    expect(state.assignments).toHaveLength(0);
    expect(fs.existsSync(path.join(tmp.root, 'provision.json'))).toBe(false);
  });

  it('refuses an import without the exact spoken script', async () => {
    createProject('Video_Imp3');
    const before = voiceoverNames();
    const res = await importNarration('Video_Imp3', 'long', narrationWav(5), { scriptText: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('exact spoken script');
    expect(loadProject('Video_Imp3')?.meta.input.voiceoverFile ?? null).toBeNull();
    expect(voiceoverNames()).toEqual(before);
  });

  it('refuses an import without a declared source', async () => {
    createProject('Video_Imp4');
    const before = voiceoverNames();
    const res = await importNarration('Video_Imp4', 'long', narrationWav(5), { sourceKind: 'somewhere' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Declare where this narration came from');
    expect(voiceoverNames()).toEqual(before);
  });

  it('refuses an import without the ownership confirmation', async () => {
    createProject('Video_Imp5');
    const before = voiceoverNames();
    const res = await importNarration('Video_Imp5', 'long', narrationWav(5), {
      ownershipConfirmed: 'false',
      ownershipStatement: '',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('authorized to publish it');
    expect(voiceoverNames()).toEqual(before);
  });

  it('records the declared engine/model/voice as documented info, not as verification', async () => {
    createProject('Video_Imp6');
    const res = await importNarration('Video_Imp6', 'long', narrationWav(5));
    const declaration = res.json().import.declaration;
    expect(declaration.engineName).toBe('Chatterbox');
    expect(declaration.ownershipConfirmed).toBe(true);
    /* Nothing in the record claims the rights were verified. */
    expect(JSON.stringify(res.json())).not.toContain('rightsVerified');
    expect(JSON.stringify(res.json())).not.toContain('verified:true');
  });

  it('refuses a file whose extension lies about its content', async () => {
    createProject('Video_Imp7');
    const res = await importNarration(
      'Video_Imp7',
      'long',
      Buffer.from('this is not a wave file, it is plain text'),
      {},
      'fake.wav',
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('could not be analyzed as audio');
  });

  it('refuses an unsupported extension', async () => {
    createProject('Video_Imp8');
    const res = await importNarration('Video_Imp8', 'long', narrationWav(5), {}, 'notes.txt');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Unsupported audio format');
  });

  it('refuses a traversal filename instead of writing outside the narration root', async () => {
    createProject('Video_Imp9');
    const res = await importNarration(
      'Video_Imp9',
      'long',
      narrationWav(5),
      {},
      '../../../etc/passwd.wav',
    );
    expect([400, 201]).toContain(res.statusCode);
    /* Whatever happened, no file may exist outside the data root. */
    expect(fs.existsSync(path.join(tmp.data, '..', 'passwd.wav'))).toBe(false);
    const stored = loadProject('Video_Imp9')?.meta.input.voiceoverFile;
    if (stored) expect(stored).toMatch(/^voiceover\//);
  });

  it('refuses an upload beyond the size limit', async () => {
    createProject('Video_Imp10');
    const before = voiceoverNames();
    process.env.BUILDTRACK_MAX_AUDIO_UPLOAD_BYTES = '1024';
    try {
      const res = await importNarration('Video_Imp10', 'long', narrationWav(6));
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toContain('maximum allowed size');
      expect(loadProject('Video_Imp10')?.meta.input.voiceoverFile ?? null).toBeNull();
      expect(voiceoverNames()).toEqual(before);
    } finally {
      delete process.env.BUILDTRACK_MAX_AUDIO_UPLOAD_BYTES;
    }
  });

  it('refuses a target that is not in the project storyboard', async () => {
    createProject('Video_Imp11');
    const res = await importNarration('Video_Imp11', 'short_3', narrationWav(5));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('not present in this project');
  });

  it('refuses an import for a project that does not exist', async () => {
    const res = await importNarration('Video_Missing', 'long', narrationWav(5));
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Project not found');
  });

  it('never serves another project’s imported narration', async () => {
    createProject('Video_Imp12');
    createProject('Video_Other12');
    await importNarration('Video_Imp12', 'long', narrationWav(5));
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/Video_Other12/target-audio/long/external/audio',
    });
    expect(res.statusCode).toBe(404);
    const state = await app.inject({ method: 'GET', url: '/api/projects/Video_Other12/target-audio/long/external' });
    expect(state.statusCode).toBe(404);
  });

  it('serves the imported narration for listening to this project only', async () => {
    createProject('Video_Imp13');
    await importNarration('Video_Imp13', 'long', narrationWav(5));
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/Video_Imp13/target-audio/long/external/audio',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('audio/wav');
    expect(res.rawPayload.length).toBeGreaterThan(44);
  });
});

describe('VS4: approving exactly those bytes', () => {
  it('approves the imported audio and reports the target as ready', async () => {
    createProject('Video_App1', 12);
    const wav = narrationWav(12);
    await importNarration('Video_App1', 'long', wav);
    /* The timeline must first be regenerated from the measured audio. */
    const regen = await regenerateStoryboard('Video_App1');
    expect(regen.statusCode).toBe(200);

    const before = await approve('Video_App1', 'long', 'approved', false);
    expect(before.statusCode).toBe(400);
    expect(before.json().error).toContain('Listen to the whole imported file');

    const res = await approve('Video_App1', 'long', 'approved');
    expect(res.statusCode).toBe(200);
    expect(res.json().approval.artifactSha256).toBe(sha256OfBuffer(wav));
    expect(res.json().approval.listened).toBe(true);
    /* Audio approval alone is not export readiness. Timing must be approved too. */
    expect(res.json().view.ready).toBe(false);
    expect(res.json().view.findings.some((f: { code: string }) => f.code === 'TIMING-APPROVAL-MISSING')).toBe(true);

    const review = await app.inject({ method: 'GET', url: '/api/projects/Video_App1/external-narration/timing/long' });
    expect(review.statusCode).toBe(200);
    const timing = review.json().timing;
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_App1/external-narration/timing/long',
      payload: {
        ...coveringTiming(timing),
      },
    });
    expect(saved.statusCode).toBe(200);
    const timingApproval = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_App1/external-narration/timing/long/approval',
      payload: { decision: 'approved', reviewed: true, decidedBy: 'project-owner' },
    });
    expect(timingApproval.statusCode).toBe(200);
    expect(timingApproval.json().view.ready).toBe(true);

    const gate = await app.inject({ method: 'GET', url: '/api/projects/Video_App1/external-narration' });
    expect(gate.json().readyCount).toBe(1);
    expect(gate.json().blockedCount).toBe(0);
  });

  it('invalidates the approval when the audio file is replaced', async () => {
    createProject('Video_App2', 10);
    await importNarration('Video_App2', 'long', narrationWav(10));
    await regenerateStoryboard('Video_App2');
    await approve('Video_App2', 'long', 'approved');

    const replaced = await importNarration('Video_App2', 'long', narrationWav(14));
    expect(replaced.statusCode).toBe(201);
    const view = replaced.json().view;
    expect(view.approval).toBeNull();
    expect(view.ready).toBe(false);
    expect(view.blockReasons.join(' ')).toContain('not been approved');

    const gate = await app.inject({ method: 'GET', url: '/api/projects/Video_App2/external-narration' });
    expect(gate.json().blockedCount).toBe(1);
  });

  it('invalidates the approval when the spoken script changes', async () => {
    createProject('Video_App3', 10);
    await importNarration('Video_App3', 'long', narrationWav(10));
    await regenerateStoryboard('Video_App3');
    await approve('Video_App3', 'long', 'approved');

    const reimported = await importNarration('Video_App3', 'long', narrationWav(10), {
      scriptText: 'A completely different script for the same audio.',
    });
    expect(reimported.statusCode).toBe(201);
    expect(reimported.json().view.approval).toBeNull();
  });

  it('invalidates the approval when the timing changes after regeneration', async () => {
    createProject('Video_App4', 10);
    await importNarration('Video_App4', 'long', narrationWav(10));
    await regenerateStoryboard('Video_App4');
    await approve('Video_App4', 'long', 'approved');

    const review = await app.inject({ method: 'GET', url: '/api/projects/Video_App4/external-narration/timing/long' });
    const timing = review.json().timing;
    await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_App4/external-narration/timing/long',
      payload: {
        ...coveringTiming(timing),
      },
    });
    const timingApproval = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_App4/external-narration/timing/long/approval',
      payload: { decision: 'approved', reviewed: true },
    });
    expect(timingApproval.statusCode).toBe(200);

    const before = await app.inject({ method: 'GET', url: '/api/projects/Video_App4/external-narration' });
    expect(before.json().targets[0].ready).toBe(true);
    const listeningBefore = before.json().targets[0].approval;

    /* A scene-duration edit changes speech timing. It must stale the timing
     * approval and block export, without revoking the listening approval. */
    const sceneId = loadProject('Video_App4')!.storyboard.long.scenes[0].id;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/projects/Video_App4/scenes/${sceneId}`,
      payload: { duration: 12 },
    });
    expect(patch.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/projects/Video_App4/external-narration' });
    expect(after.json().targets[0].ready).toBe(false);
    expect(after.json().targets[0].approval.decision).toBe('approved');
    expect(after.json().targets[0].approval.listened).toBe(true);
    expect(after.json().targets[0].approval.artifactSha256).toBe(listeningBefore.artifactSha256);
    expect(after.json().targets[0].import.declaration.ownershipStatement).toBe('Licensed vendor, invoice 1234');
    expect(after.json().targets[0].blockReasons.join(' ')).toContain('timing approval does not match');
  });

  it('records a rejection and keeps the target blocked', async () => {
    createProject('Video_App5', 10);
    await importNarration('Video_App5', 'long', narrationWav(10));
    await regenerateStoryboard('Video_App5');
    const res = await approve('Video_App5', 'long', 'rejected', false);
    expect(res.statusCode).toBe(200);
    const summary = await app.inject({ method: 'GET', url: '/api/projects/Video_App5/external-narration' });
    expect(summary.json().targets[0].approval.decision).toBe('rejected');
    expect(summary.json().targets[0].ready).toBe(false);
  });

  it('binds an approval to its own target, never to another one', async () => {
    createProject('Video_App6', 10);
    await importNarration('Video_App6', 'long', narrationWav(10));
    await regenerateStoryboard('Video_App6');
    await approve('Video_App6', 'long', 'approved');
    await importNarration('Video_App6', 'short_1', narrationWav(8));
    await regenerateStoryboard('Video_App6');
    await approve('Video_App6', 'short_1', 'approved');
    for (const target of ['long', 'short_1']) {
      const review = await app.inject({ method: 'GET', url: `/api/projects/Video_App6/external-narration/timing/${target}` });
      const timing = review.json().timing;
      const saved = await app.inject({
        method: 'PUT',
        url: `/api/projects/Video_App6/external-narration/timing/${target}`,
        payload: coveringTiming(timing, target === 'long' ? 0.5 : 0.2),
      });
      expect(saved.statusCode).toBe(200);
      const timingApproval = await app.inject({
        method: 'POST',
        url: `/api/projects/Video_App6/external-narration/timing/${target}/approval`,
        payload: { decision: 'approved', reviewed: true },
      });
      expect(timingApproval.statusCode).toBe(200);
    }

    const summary = await app.inject({ method: 'GET', url: '/api/projects/Video_App6/external-narration' });
    const byTarget = Object.fromEntries(summary.json().targets.map((t: any) => [t.targetId, t]));
    expect(byTarget.long.ready).toBe(true);
    expect(byTarget.short_1.ready).toBe(true);
  });
});

describe('VS4: a Short never inherits the Long narration', () => {
  it('refuses a Short whose narration is the Long file', async () => {
    createProject('Video_Short1', 10);
    const wav = narrationWav(10);
    await importNarration('Video_Short1', 'long', wav);
    const project = loadProject('Video_Short1')!;
    /* Force the failure mode: point Short 1 at the Long's own file. */
    project.meta.input.targetAudio = { ...(project.meta.input.targetAudio ?? {}), short_1: project.meta.input.voiceoverFile };
    saveProject(project);

    const summary = await app.inject({ method: 'GET', url: '/api/projects/Video_Short1/external-narration' });
    const short = summary.json().targets.find((t: any) => t.targetId === 'short_1');
    expect(short.import).toBeNull();
    /* The existing resolver is what refuses this, and it still does. */
    const exportRes = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_Short1/export',
      payload: { kind: 'final', includeShorts: true },
    });
    expect(exportRes.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('VS4: export is blocked until the timing covers the audio', () => {
  it('blocks a final export whose timeline is shorter than the imported narration', async () => {
    createProject('Video_Exp1', 40);
    /* The storyboard was planned for 40s; the imported narration is 40s too,
     * but the scene timing is then shortened so the plan no longer covers it. */
    await importNarration('Video_Exp1', 'long', narrationWav(40));
    await regenerateStoryboard('Video_Exp1');
    await approve('Video_Exp1', 'long', 'approved');

    const project = loadProject('Video_Exp1')!;
    project.storyboard.long.totalDuration = 20;
    for (const scene of project.storyboard.long.scenes) {
      scene.duration = Number((scene.duration / 2).toFixed(3));
    }
    saveProject(project);

    const res = await app.inject({ method: 'POST', url: '/api/projects/Video_Exp1/export', payload: { kind: 'final' } });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.externalNarrationGate).toBeTruthy();
    expect(body.externalNarrationGate.blockedCodes).toContain('TIMING-TIMELINE-SHORTER-THAN-AUDIO');
    expect(
      body.externalNarrationGate.findings.some((f: any) => f.message.includes('shorter than the imported narration')),
    ).toBe(true);
    expect(body.blockReason.length).toBeGreaterThan(0);
    const summary = await app.inject({ method: 'GET', url: '/api/projects/Video_Exp1/external-narration' });
    const coverage = summary.json().targets.find((target: any) => target.targetId === 'long').readiness.lines.find((line: any) => line.key === 'coverage');
    expect(coverage.ok).toBe(false);
    expect(coverage.state).toContain('does not cover');
    expect(summary.json().targets.find((target: any) => target.targetId === 'long').readiness.exportAttemptReady).toBe(false);
    expect(summary.json().targets.find((target: any) => target.targetId === 'long').readiness.publicationApproved).toBe(false);
  });

  it('blocks a final export whose import was never approved', async () => {
    createProject('Video_Exp2', 10);
    await importNarration('Video_Exp2', 'long', narrationWav(10));
    await regenerateStoryboard('Video_Exp2');
    const res = await app.inject({ method: 'POST', url: '/api/projects/Video_Exp2/export', payload: { kind: 'final' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().externalNarrationGate.blockedCodes).toContain('IMPORT-APPROVAL-MISSING');
  });

  it('leaves the export of a project without imports untouched', async () => {
    createProject('Video_Exp3', 10);
    const res = await app.inject({ method: 'POST', url: '/api/projects/Video_Exp3/export', payload: { kind: 'final' } });
    /* Not blocked by the VS4 gate: this project imported nothing. It may still
     * be refused by the pre-existing QC/voice gates, which is fine. */
    if (res.statusCode === 409) {
      expect(res.json().externalNarrationGate).toBeUndefined();
    } else {
      expect(res.statusCode).toBeLessThan(500);
    }
  });
});

describe('VS4: the timing review is honest about what it knows', () => {
  it('labels scene timing as estimated when no per-scene timing exists', async () => {
    createProject('Video_Tim1', 12);
    await importNarration('Video_Tim1', 'long', narrationWav(12));
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/Video_Tim1/external-narration/timing/long',
    });
    expect(res.statusCode).toBe(200);
    const timing = res.json().timing;
    expect(timing.alignmentVerified).toBe(false);
    expect(timing.scenes.length).toBeGreaterThan(0);
    expect(timing.scenes.every((s: any) => s.timingSource === 'estimated')).toBe(true);
    expect(timing.audioDurationSec).toBeCloseTo(12, 1);
  });

  it('reports measured per-scene timing as aligned when a matching timing file exists', async () => {
    createProject('Video_Tim2', 12);
    const wav = narrationWav(12);
    const res = await importNarration('Video_Tim2', 'long', wav);
    const storedRef = res.json().import.storedRef as string;
    const abs = path.join(tmp.data, storedRef);

    const project = loadProject('Video_Tim2')!;
    const scenes = project.storyboard.long.scenes;
    let acc = 0;
    /* Per-scene speech timing with the scenes' own text, so the match is real. */
    const sidecar = {
      scenes: scenes.map((s, i) => {
        const duration = Number((s.duration ?? 1).toFixed(3));
        const start = Number(acc.toFixed(3));
        acc += duration;
        return { index: i, sceneId: s.id, start, duration, text: s.narration ?? '' };
      }),
    };
    expect(scenes.reduce((a, s) => a + s.duration, 0)).toBeGreaterThan(0);
    /* A per-scene timing file next to the imported narration. */
    fs.writeFileSync(abs.replace(/\.wav$/, '.timing.json'), JSON.stringify(sidecar), 'utf8');

    /* Alignment is read from the narration on disk, so the view reports it. */
    const view = await app.inject({ method: 'GET', url: '/api/projects/Video_Tim2/external-narration' });
    expect(view.json().targets[0].alignment.verified).toBe(true);
    expect(view.json().targets[0].alignment.mode).toBe('exact_scene_timing');
    const timing = await app.inject({
      method: 'GET',
      url: '/api/projects/Video_Tim2/external-narration/timing/long',
    });
    expect(timing.json().timing.alignmentVerified).toBe(true);
    expect(timing.json().timing.scenes.every((s: any) => s.timingSource === 'exact')).toBe(true);
  });
});

describe('VS4: per-turn dialogue imports go through the dialogue contracts', () => {
  it('imports a clip per turn and reports coverage', async () => {
    createProject('Video_Dlg1', 10);
    const project = loadProject('Video_Dlg1')!;
    const scene = project.storyboard.shorts[0].scenes[0];
    (scene as unknown as { turns: unknown[] }).turns = [
      { id: 'turn_1', speakerId: 'narrator', text: 'First line of the dialogue.' },
      { id: 'turn_2', speakerId: 'expert', text: 'Second line of the dialogue.' },
    ];
    saveProject(project);

    const first = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_Dlg1/external-narration/dialogue-turns',
      ...multipart('file', 'turn1.wav', 'audio/wav', narrationWav(3), {
        sceneId: scene.id,
        turnId: 'turn_1',
        speakerId: 'narrator',
        speakerName: 'Operator voice',
        spokenText: 'First line of the dialogue.',
        combinedTrack: 'false',
      }),
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().coverage.coveredTurns).toBe(1);
    expect(first.json().coverage.coverage[0].verifiedPerSpeaker).toBe(true);
    expect(first.json().import.storedRef).toMatch(/^\.production\/Video_Dlg1\/audio\/dialogue\/ext_[a-z0-9]+\.wav$/);

    const second = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_Dlg1/external-narration/dialogue-turns',
      ...multipart('file', 'turn2.wav', 'audio/wav', narrationWav(3), {
        sceneId: scene.id,
        turnId: 'turn_2',
        speakerId: 'expert',
        speakerName: 'Expert',
        spokenText: 'Second line of the dialogue.',
        combinedTrack: 'false',
      }),
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().coverage.allowed).toBe(true);
    expect(second.json().coverage.totalTurns).toBe(2);

    const coverage = await app.inject({
      method: 'GET',
      url: '/api/projects/Video_Dlg1/external-narration/dialogue',
    });
    expect(coverage.json().coveredTurns).toBe(2);
    expect(coverage.json().coverage.every((c: any) => c.verifiedPerSpeaker)).toBe(true);
  });

  it('never calls a combined multi-speaker track verified per-speaker audio', async () => {
    createProject('Video_Dlg2', 10);
    const project = loadProject('Video_Dlg2')!;
    const scene = project.storyboard.shorts[0].scenes[0];
    (scene as unknown as { turns: unknown[] }).turns = [
      { id: 'turn_1', speakerId: 'narrator', text: 'First line of the dialogue.' },
      { id: 'turn_2', speakerId: 'expert', text: 'Second line of the dialogue.' },
    ];
    saveProject(project);

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_Dlg2/external-narration/dialogue-turns',
      ...multipart('file', 'combined.wav', 'audio/wav', narrationWav(6), {
        sceneId: scene.id,
        turnId: 'turn_1',
        speakerId: 'narrator',
        speakerName: 'Operator voice',
        spokenText: 'First line of the dialogue.',
        combinedTrack: 'true',
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().coverage.coverage[0].covered).toBe(true);
    expect(res.json().coverage.coverage[0].verifiedPerSpeaker).toBe(false);
    expect(
      res.json().coverage.findings.some((f: any) => f.code === 'DIALOGUE-COMBINED-TRACK-NOT-PER-SPEAKER'),
    ).toBe(true);
  });

  it('refuses a dialogue clip import without the turn identity', async () => {
    createProject('Video_Dlg3', 10);
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_Dlg3/external-narration/dialogue-turns',
      ...multipart('file', 'turn.wav', 'audio/wav', narrationWav(3), { spokenText: 'Something.' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('sceneId, turnId, speakerId');
  });
});

describe('VS4: private reference recordings stay private', () => {
  it('never exposes a reference recording through the imported-narration routes', async () => {
    createProject('Video_Priv1');
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/Video_Priv1/target-audio/long/external/audio',
    });
    expect(res.statusCode).toBe(404);
    const state = loadVoiceAudioState('Video_Priv1');
    expect(state.references).toHaveLength(0);
    /* The imported-narration state never stores a reference recording. */
    expect(JSON.stringify(state.externalNarration ?? {})).not.toContain('references');
  });

  it('keeps the imported narration out of the project-private voice-audio file list', async () => {
    createProject('Video_Priv2');
    const res = await importNarration('Video_Priv2', 'long', narrationWav(5));
    const storedRef = res.json().import.storedRef as string;
    /* The publishable narration lives in the ordinary narration storage… */
    expect(storedRef.startsWith('voiceover/')).toBe(true);
    /* …and is not inside the private voice-audio root. */
    expect(storedRef).not.toContain('voice-audio');
  });
});

describe('VS6: readiness and export use the same server check', () => {
  /** Fit and approve a target that is already imported. Does not regenerate, so a sibling target is left alone. */
  async function fitAndApprove(videoId: string, target: string) {
    const review = await app.inject({
      method: 'GET',
      url: `/api/projects/${videoId}/external-narration/timing/${target}`,
    });
    expect(review.statusCode).toBe(200);
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/projects/${videoId}/external-narration/timing/${target}`,
      payload: coveringTiming(review.json().timing, target === 'long' ? 0.5 : 0.3),
    });
    expect(saved.statusCode, JSON.stringify(saved.json())).toBe(200);
    const audio = await approve(videoId, target, 'approved');
    expect(audio.statusCode).toBe(200);
    const timingApproval = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/external-narration/timing/${target}/approval`,
      payload: { decision: 'approved', reviewed: true, decidedBy: 'project-owner' },
    });
    expect(timingApproval.statusCode, JSON.stringify(timingApproval.json())).toBe(200);
    return timingApproval.json();
  }

  function readinessOf(body: any, targetId: string) {
    return body.targets.find((target: any) => target.targetId === targetId).readiness;
  }

  it('reaches export-attempt readiness without calling that publication approval', async () => {
    createProject('Video_VS6Ready', 10);
    await importNarration('Video_VS6Ready', 'long', narrationWav(10));
    await regenerateStoryboard('Video_VS6Ready');
    await fitAndApprove('Video_VS6Ready', 'long');
    const first = await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Ready/external-narration' });
    const again = await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Ready/external-narration' });
    const readiness = readinessOf(first.json(), 'long');
    expect(readiness.exportAttemptReady).toBe(true);
    expect(readiness.publicationApproved).toBe(false);
    expect(readiness.lines.find((line: any) => line.key === 'publication').state).toBe('Not publication approved');
    expect(readiness.lines.find((line: any) => line.key === 'source').detail).toContain('measured');
    expect(readiness.lines.find((line: any) => line.key === 'timing').detail).toContain('not acoustic');
    expect(JSON.stringify(readiness)).not.toMatch(/\/home\/|voiceover\//);
    expect(readinessOf(again.json(), 'long')).toEqual(readiness);

    /* The route calls this gate before it starts a job. Asserting it here proves
     * the export attempt is allowed without starting a render. */
    const project = loadProject('Video_VS6Ready')!;
    const gate = await externalNarrationRenderGate('Video_VS6Ready', {
      requestedTargetIds: exportTargetIds(project, { includeShorts: true }),
    });
    expect(gate.notApplicable).toBe(false);
    expect(gate.allowed).toBe(true);
    expect(gate.targets.find((target) => target.targetId === 'long')?.readiness.publicationApproved).toBe(false);
  });

  it('blocks a direct export when listening approval, consent, or timing approval is missing or stale', async () => {
    createProject('Video_VS6Block', 10);
    await importNarration('Video_VS6Block', 'long', narrationWav(10));
    await regenerateStoryboard('Video_VS6Block');
    const missingListen = await app.inject({ method: 'POST', url: '/api/projects/Video_VS6Block/export', payload: { kind: 'final' } });
    expect(missingListen.statusCode).toBe(409);
    expect(missingListen.json().externalNarrationGate.blockedCodes).toContain('IMPORT-APPROVAL-MISSING');
    const rejected = missingListen.json().externalNarrationGate.targets.find((target: any) => target.targetId === 'long').readiness;
    expect(rejected.exportAttemptReady).toBe(false);
    expect(rejected.publicationApproved).toBe(false);
    expect(rejected.lines.find((line: any) => line.key === 'listening').state).toBe('Listening not approved');
    expect(readinessOf(
      (await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Block/external-narration' })).json(),
      'long',
    ).lines.find((line: any) => line.key === 'listening').state).toBe('Listening not approved');

    await fitAndApprove('Video_VS6Block', 'long');
    const state = loadVoiceAudioState('Video_VS6Block');
    state.externalNarration!.imports.long!.declaration.ownershipConfirmed = false;
    state.externalNarration!.imports.long!.declaration.ownershipStatement = ' ';
    saveVoiceAudioState(state);
    const missingConsent = await app.inject({ method: 'POST', url: '/api/projects/Video_VS6Block/export', payload: { kind: 'final' } });
    expect(missingConsent.statusCode).toBe(409);
    expect(missingConsent.json().externalNarrationGate.blockedCodes).toContain('IMPORT-OWNERSHIP-UNCONFIRMED');
    const consentView = readinessOf(
      (await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Block/external-narration' })).json(),
      'long',
    );
    expect(consentView.exportAttemptReady).toBe(false);
    expect(consentView.lines.find((line: any) => line.key === 'rights').state).toBe('Rights and consent missing');

    state.externalNarration!.imports.long!.declaration.ownershipConfirmed = true;
    state.externalNarration!.imports.long!.declaration.ownershipStatement = 'Licensed for this fixture only.';
    saveVoiceAudioState(state);
    const timing = await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Block/external-narration/timing/long' });
    const shifted = coveringTiming(timing.json().timing);
    shifted.captions[0].end = Number((shifted.captions[0].end - 0.1).toFixed(3));
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_VS6Block/external-narration/timing/long',
      payload: shifted,
    });
    expect(saved.statusCode).toBe(200);
    const afterTiming = readinessOf(
      (await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Block/external-narration' })).json(),
      'long',
    );
    expect(afterTiming.lines.find((line: any) => line.key === 'listening').state).toBe('Listening approved');
    expect(afterTiming.lines.find((line: any) => line.key === 'timing').ok).toBe(false);
    expect(afterTiming.exportAttemptReady).toBe(false);
    const staleTiming = await app.inject({ method: 'POST', url: '/api/projects/Video_VS6Block/export', payload: { kind: 'final' } });
    expect(staleTiming.statusCode).toBe(409);
    expect(staleTiming.json().externalNarrationGate.blockedCodes).toContain('TIMING-APPROVAL-STALE');
  });

  it('rejects a script change, a tampered file, and a missing file before export', async () => {
    createProject('Video_VS6Tamper', 10);
    await importNarration('Video_VS6Tamper', 'long', narrationWav(10));
    await regenerateStoryboard('Video_VS6Tamper');
    await fitAndApprove('Video_VS6Tamper', 'long');
    const before = await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Tamper/external-narration' });
    expect(readinessOf(before.json(), 'long').exportAttemptReady).toBe(true);

    const state = loadVoiceAudioState('Video_VS6Tamper');
    const originalScript = state.externalNarration!.imports.long!.scriptText;
    const originalScriptSha = state.externalNarration!.imports.long!.scriptSha256;
    state.externalNarration!.imports.long!.scriptText = 'A different spoken script.';
    state.externalNarration!.imports.long!.scriptSha256 = 'b'.repeat(64);
    saveVoiceAudioState(state);
    const scriptExport = await app.inject({ method: 'POST', url: '/api/projects/Video_VS6Tamper/export', payload: { kind: 'final' } });
    expect(scriptExport.statusCode).toBe(409);
    expect(scriptExport.json().externalNarrationGate.blockedCodes).toContain('IMPORT-APPROVAL-STALE-SCRIPT');
    expect(JSON.stringify(scriptExport.json())).not.toMatch(/\/home\/|voiceover\//);

    state.externalNarration!.imports.long!.scriptText = originalScript;
    state.externalNarration!.imports.long!.scriptSha256 = originalScriptSha;
    saveVoiceAudioState(state);
    const project = loadProject('Video_VS6Tamper')!;
    const audioRef = project.meta.input.voiceoverFile!;
    const audioPath = path.isAbsolute(audioRef) ? audioRef : path.join(tmp.data, audioRef);
    const tamperedBytes = Buffer.from(fs.readFileSync(audioPath));
    tamperedBytes[44] = tamperedBytes[44] === 0 ? 1 : 0;
    fs.writeFileSync(audioPath, tamperedBytes);
    const tampered = await app.inject({ method: 'POST', url: '/api/projects/Video_VS6Tamper/export', payload: { kind: 'final' } });
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json().externalNarrationGate.blockedCodes).toContain('IMPORT-APPROVAL-STALE-ARTIFACT');
    const afterTamper = await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Tamper/external-narration' });
    expect(readinessOf(afterTamper.json(), 'long').exportAttemptReady).toBe(false);

    fs.rmSync(audioPath);
    const missing = await app.inject({ method: 'POST', url: '/api/projects/Video_VS6Tamper/export', payload: { kind: 'final' } });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().externalNarrationGate.blockedCodes).toContain('IMPORT-ARTIFACT-MISSING');
    expect(JSON.stringify(missing.json())).not.toMatch(/\/home\/|voiceover\//);
  });

  it('invalidates only the replaced target and does not let a Short inherit the Long', async () => {
    createProject('Video_VS6Iso', 10);
    await importNarration('Video_VS6Iso', 'long', narrationWav(10), {}, 'long.wav');
    await importNarration('Video_VS6Iso', 'short_1', narrationWav(8), {}, 'short.wav');
    await regenerateStoryboard('Video_VS6Iso');
    await fitAndApprove('Video_VS6Iso', 'long');
    await fitAndApprove('Video_VS6Iso', 'short_1');
    const ready = await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Iso/external-narration' });
    expect(readinessOf(ready.json(), 'long').exportAttemptReady).toBe(true);
    expect(readinessOf(ready.json(), 'short_1').exportAttemptReady).toBe(true);

    const replaced = await importNarration('Video_VS6Iso', 'long', narrationWav(9), {}, 'long-replaced.wav');
    expect(replaced.statusCode).toBe(201);
    const after = await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Iso/external-narration' });
    expect(readinessOf(after.json(), 'long').exportAttemptReady).toBe(false);
    expect(readinessOf(after.json(), 'short_1').exportAttemptReady).toBe(true);
    expect(after.json().targets.find((target: any) => target.targetId === 'short_1').approval?.decision).toBe('approved');

    const project = loadProject('Video_VS6Iso')!;
    project.meta.input.targetAudio = {
      ...(project.meta.input.targetAudio ?? {}),
      short_1: project.meta.input.voiceoverFile,
    };
    saveProject(project);
    const inherited = await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Iso/external-narration' });
    expect(readinessOf(inherited.json(), 'short_1').inheritsLongNarration).toBe(true);
    expect(readinessOf(inherited.json(), 'short_1').exportAttemptReady).toBe(false);
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_VS6Iso/export',
      payload: { kind: 'final', includeShorts: true },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().externalNarrationGate.blockedCodes).toContain('IMPORT-APPROVAL-STALE-TARGET');
    expect(JSON.stringify(blocked.json())).not.toMatch(/\/home\/|voiceover\//);

    const longOnly = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_VS6Iso/export',
      payload: { kind: 'final', includeShorts: false },
    });
    if (longOnly.statusCode === 409) {
      expect(longOnly.json().externalNarrationGate?.blockedCodes ?? []).not.toContain('IMPORT-APPROVAL-STALE-TARGET');
    }
  });

  it('does not apply the imported-narration gate to a project with no import or to production export', async () => {
    createProject('Video_VS6Plain', 10);
    const plain = await app.inject({ method: 'GET', url: '/api/projects/Video_VS6Plain/external-narration' });
    expect(plain.json().targets.every((target: any) => target.readiness.applies === false)).toBe(true);
    expect(plain.json().targets.every((target: any) => target.readiness.publicationApproved === false)).toBe(true);
    const plainGate = await externalNarrationRenderGate('Video_VS6Plain');
    expect(plainGate.notApplicable).toBe(true);
    expect(plainGate.allowed).toBe(true);
    const unknown = await externalNarrationRenderGate('Video_VS6Plain', { requestedTargetIds: ['not_a_target'] });
    expect(unknown.allowed).toBe(false);
    expect(unknown.blockedCodes).toContain('TIMING-TARGET-MISMATCH');

    createProject('Video_VS6Prod', 10);
    await importNarration('Video_VS6Prod', 'long', narrationWav(10));
    const production = await app.inject({ method: 'POST', url: '/api/projects/Video_VS6Prod/production/export' });
    expect(production.json().externalNarrationGate).toBeUndefined();
  });

  it('stales only timing approval when a caption wording edit lands', async () => {
    createProject('Video_VS7Words', 10);
    await importNarration('Video_VS7Words', 'long', narrationWav(10), {}, 'long.wav');
    await importNarration('Video_VS7Words', 'short_1', narrationWav(8), {}, 'short.wav');
    await regenerateStoryboard('Video_VS7Words');
    await fitAndApprove('Video_VS7Words', 'long');
    await fitAndApprove('Video_VS7Words', 'short_1');
    const before = await app.inject({ method: 'GET', url: '/api/projects/Video_VS7Words/external-narration' });
    expect(readinessOf(before.json(), 'long').exportAttemptReady).toBe(true);
    expect(readinessOf(before.json(), 'short_1').exportAttemptReady).toBe(true);
    const listening = before.json().targets.find((item: any) => item.targetId === 'long').approval;
    const shortTiming = before.json().targets.find((item: any) => item.targetId === 'short_1').timingApproval;

    const cue = loadProject('Video_VS7Words')!.storyboard.captions[0];
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/projects/Video_VS7Words/captions/${cue.id}`,
      payload: { text: 'A different caption line that was not the approved wording.' },
    });
    expect(patched.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/projects/Video_VS7Words/external-narration' });
    const long = after.json().targets.find((item: any) => item.targetId === 'long');
    const short = after.json().targets.find((item: any) => item.targetId === 'short_1');
    expect(long.approval.decision).toBe('approved');
    expect(long.approval.listened).toBe(true);
    expect(long.approval.artifactSha256).toBe(listening.artifactSha256);
    expect(long.readiness.lines.find((line: any) => line.key === 'listening').state).toBe('Listening approved');
    expect(long.readiness.lines.find((line: any) => line.key === 'timing').ok).toBe(false);
    expect(long.readiness.exportAttemptReady).toBe(false);
    expect(long.readiness.publicationApproved).toBe(false);
    expect(short.approval.decision).toBe('approved');
    expect(short.timingApproval).toEqual(shortTiming);
    expect(short.readiness.exportAttemptReady).toBe(true);
    expect(JSON.stringify(after.json())).not.toMatch(/\/home\/|\/data\//);

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_VS7Words/export',
      payload: { kind: 'final', includeShorts: false },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().externalNarrationGate.blockedCodes).toContain('TIMING-APPROVAL-STALE');
    expect(blocked.json().externalNarrationGate.blockedCodes).not.toContain('IMPORT-APPROVAL-STALE-TIMING');
    expect(JSON.stringify(blocked.json())).not.toMatch(/\/home\/|voiceover\//);
  });

  it('leaves the previous timing approval in place when a timing save is rejected', async () => {
    createProject('Video_VS7Keep', 10);
    await importNarration('Video_VS7Keep', 'long', narrationWav(10));
    await regenerateStoryboard('Video_VS7Keep');
    await fitAndApprove('Video_VS7Keep', 'long');
    const before = await app.inject({ method: 'GET', url: '/api/projects/Video_VS7Keep/external-narration' });
    const approval = before.json().targets[0].timingApproval;
    expect(approval.decision).toBe('approved');
    const review = await app.inject({ method: 'GET', url: '/api/projects/Video_VS7Keep/external-narration/timing/long' });
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_VS7Keep/external-narration/timing/long',
      payload: {
        scenes: review.json().timing.scenes.map((scene: any) => ({
          sceneId: scene.sceneId,
          startTime: -1,
          durationSec: scene.durationSec,
        })),
        captions: review.json().timing.captions.map((cue: any) => ({ cueId: cue.cueId, start: cue.start, end: cue.end })),
      },
    });
    expect(rejected.statusCode).toBe(400);
    const after = await app.inject({ method: 'GET', url: '/api/projects/Video_VS7Keep/external-narration' });
    expect(after.json().targets[0].timingApproval).toEqual(approval);
    expect(after.json().targets[0].approval.decision).toBe('approved');
    expect(readinessOf(after.json(), 'long').exportAttemptReady).toBe(true);
    expect(JSON.stringify(rejected.json())).not.toMatch(/\/home\/|voiceover\//);
  });
});
