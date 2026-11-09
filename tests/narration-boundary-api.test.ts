/**
 * Proposal and accept use a generated tone with pauses, not a user recording.
 * The route must not rewrite the audio or save a proposal before it is accepted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'narration-boundary-api');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  return { root, data, output };
});

import { PROJECT_SCHEMA_VERSION, buildFaithfulExternalStoryboard, emptyHistory, type Project, type ProjectInput } from '@buildtrack/core';
import { buildServerApp } from '../apps/api/src/server.js';
import { loadProject, saveProject } from '../apps/api/src/services/store.js';
import { referenceWavBuffer } from './helpers/chatterbox-worker-fixtures.js';

const VIDEO_ID = 'Boundary_Fixture';
const SCRIPT = [
  'First fixture sentence.',
  'Second fixture sentence.',
  'Third fixture sentence.',
].join('\n\n');

function pausedWav(): Buffer {
  const wav = referenceWavBuffer('boundary-fixture-not-a-user-recording', 4.2);
  const rate = 24000;
  const zero = (startSec: number, endSec: number) => {
    const from = 44 + Math.round(startSec * rate) * 2;
    const to = 44 + Math.round(endSec * rate) * 2;
    wav.fill(0, from, Math.min(to, wav.length));
  };
  zero(1, 1.6);
  zero(2.6, 3.2);
  return wav;
}

function multipart(content: Buffer) {
  const boundary = '----boundary' + Math.random().toString(36).slice(2);
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

describe('narration boundary proposal API', () => {
  let app: Awaited<ReturnType<typeof buildServerApp>>;
  let audioPath = '';
  let audioHash = '';

  beforeAll(async () => {
    app = await buildServerApp();
    await app.ready();
    const input: ProjectInput = {
      videoId: VIDEO_ID,
      videoType: 'long',
      topic: 'boundary fixture',
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
    const built = buildFaithfulExternalStoryboard({ input, history: emptyHistory(), audioDuration: 4.2 });
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
      ...multipart(pausedWav()),
    });
    expect(imported.statusCode).toBe(201);
    audioPath = path.join(tmp.data, imported.json().import.storedRef as string);
    audioHash = createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex');
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not replace timings with a pause estimate when CTC alignment is unavailable', async () => {
    const before = loadProject(VIDEO_ID);
    const firstStart = before?.storyboard.long.scenes[1]?.startTime;
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/external-narration/timing/long/proposal`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.saved).toBe(false);
    expect(body.audioChanged).toBe(false);
    expect(body.acousticVerification).toBe(false);
    expect(body.proposal.verified).toBe(false);
    expect(body.proposal.method).toBe('unavailable');
    expect(body.proposal.method).not.toBe('speech_intervals');
    expect(body.proposal.method).not.toBe('script_proportion');
    expect(body.proposal.sourceLabel).toBe('Alignment unavailable');
    expect(body.proposal.detail).toContain('pause estimation was not used');
    expect(body.proposal.detail).toContain('1.3 GiB');
    expect(body.proposal.rows).toEqual([]);
    expect(res.body).not.toContain(tmp.data);
    expect(res.body).not.toContain('/home/');
    expect(loadProject(VIDEO_ID)?.storyboard.long.scenes[1]?.startTime).toBe(firstStart);
    expect(createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex')).toBe(audioHash);
  });

  it('saves an accepted proposal, keeps a manual edit, and reloads the same times', async () => {
    const project = loadProject(VIDEO_ID);
    if (!project) throw new Error('fixture project missing');
    project.storyboard.long.scenes[1].userEdited = true;
    project.storyboard.long.scenes[1].startTime = 1.7;
    project.storyboard.long.scenes[1].duration = 1.4;
    project.storyboard.long.scenes[0].duration = 1.7;
    project.storyboard.captions[1].userEdited = true;
    project.storyboard.captions[1].start = 1.7;
    project.storyboard.captions[1].end = 3.1;
    saveProject(project);

    const kept = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/external-narration/timing/long/proposal/accept`,
      payload: { includeManual: false },
    });
    expect(kept.statusCode).toBe(409);
    expect(kept.json().saved).toBe(false);
    expect(kept.json().audioChanged).toBe(false);
    expect(kept.json().error).toContain('pause estimation was not used');
    expect(kept.json().proposal.rows).toEqual([]);
    const reloaded = loadProject(VIDEO_ID);
    expect(reloaded?.storyboard.long.scenes[1].startTime).toBeCloseTo(1.7, 2);
    expect(reloaded?.storyboard.captions[1].start).toBeCloseTo(1.7, 2);
    expect(createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex')).toBe(audioHash);

    const again = await app.inject({
      method: 'GET',
      url: `/api/projects/${VIDEO_ID}/external-narration/timing/long`,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().timing.scenes[1].startTime).toBeCloseTo(1.7, 2);
    expect(again.json().timing.timingReview.source).toBe('estimated');
    expect(again.json().timing.timingReview.sourceLabel).not.toBe('CTC word alignment');
  });
});
