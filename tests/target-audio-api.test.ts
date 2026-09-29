/**
 * Phase 0B target audio backend test suite.
 * Validates endpoints GET, POST, DELETE /api/projects/:id/target-audio/:target
 * and upload safety, isolation, relative references, and legacy project support.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodeOs = process.getBuiltinModule('node:os') as typeof import('node:os');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'vf-target-audio-test-'));
  const testData = nodePath.join(dir, 'data');
  const testOut = nodePath.join(dir, 'output');
  nodeFs.mkdirSync(testData, { recursive: true });
  nodeFs.mkdirSync(testOut, { recursive: true });
  process.env.BUILDTRAKE_DATA = testData;
  process.env.BUILDTRAKE_OUTPUT = testOut;
  return { dir, testData, testOut };
});

const tempDir = tmp.dir;
const testDataDir = tmp.testData;
const testOutputDir = tmp.testOut;

import {
  PROJECT_SCHEMA_VERSION,
  buildStoryboard,
  emptyHistory,
  type Project,
  type ProjectInput,
} from '@buildtrack/core';
import { saveProject, loadProject } from '../apps/api/src/services/store.js';
import { registerTargetAudioRoutes, isManagedVoiceoverPath } from '../apps/api/src/routes/target-audio.js';
import { resolveDataPath } from '../apps/api/src/services/targets.js';

function makeWavBuffer(seconds = 1, sampleRate = 8000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function makeMultipart(fieldName: string, filename: string, mimeType: string, content: Buffer) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([prefix, content, suffix]);
  return {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  };
}

function createTestProject(videoId: string, shortCount = 2, voiceoverFile: string | null = null): Project {
  const input: ProjectInput = {
    videoId,
    videoType: 'long',
    topic: 'Safety Gear on Site',
    targetAudience: 'Site managers',
    mainProblem: 'PPE non-compliance',
    viewerPromise: 'Practical compliance checklist',
    hook: 'Are your teams truly protected?',
    script: 'Every site supervisor knows safety inspections take time.',
    keyNumbers: ['100% compliance', '0 incidents'],
    keyPoints: ['Hard hats', 'Steel boots'],
    productName: 'BuildTrack PPE Kit',
    productShots: [],
    cta: 'Book your site audit now',
    voiceoverFile,
    targetAudio: {},
    brollFiles: [],
    sourceReferences: [],
    outputLanguage: 'en',
    brandPreset: 'safety_first',
    shortCount,
  };

  const sb = buildStoryboard({
    input,
    history: emptyHistory(),
    audioDuration: 60,
  });

  const { historyEntry: _h, ...storyboard } = sb;
  const now = new Date().toISOString();
  const project: Project = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    meta: {
      input,
      brand: sb.brand,
      createdAt: now,
      updatedAt: now,
      status: 'storyboarded',
    },
    storyboard,
    artifacts: [],
    qc: [],
  };
  saveProject(project);
  return project;
}

describe('Phase 0B: Target Audio API', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await registerTargetAudioRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('1. GET returns the correct status for Long and every existing Short', async () => {
    const p = createTestProject('Test_Project_01', 2);
    // Storyboard has long + short_1 + short_2
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${p.meta.input.videoId}/target-audio`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.projectId).toBe('Test_Project_01');
    expect(body.totalTargets).toBe(3);
    expect(body.readyCount).toBe(0);
    expect(body.missingCount).toBe(3);
    expect(body.targets).toHaveLength(3);

    const ids = body.targets.map((t: any) => t.targetId);
    expect(ids).toEqual(['long', 'short_1', 'short_2']);
    for (const t of body.targets) {
      expect(t.status).toBe('missing');
      expect(t.ready).toBe(false);
      expect(t.storedRef).toBeNull();
      expect(t.fileName).toBeNull();
      expect(t.durationSec).toBeNull();
      expect(t.explanation).toBeDefined();
    }
  });

  it('2. Uploading Long audio changes only voiceoverFile', async () => {
    const p = createTestProject('Test_Project_02', 2);
    const audioBuf = makeWavBuffer(3);
    const mp = makeMultipart('file', 'long_audio.wav', 'audio/wav', audioBuf);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/long`,
      headers: mp.headers,
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.message).toContain('Regenerate the storyboard');

    const updated = loadProject('Test_Project_02')!;
    expect(updated.meta.input.voiceoverFile).toBe('voiceover/Test_Project_02_long.wav');
    // Shorts must remain completely untouched
    expect(updated.meta.input.targetAudio).toEqual({});

    // Summary must show Long ready
    expect(body.summary.readyCount).toBe(1);
    const longTarget = body.summary.targets.find((t: any) => t.targetId === 'long');
    expect(longTarget.ready).toBe(true);
    expect(longTarget.status).toBe('ready');
    expect(longTarget.fileName).toBe('Test_Project_02_long.wav');
    expect(longTarget.durationSec).toBeCloseTo(3.0, 1);
  });

  it('3. Uploading short_1 changes only targetAudio.short_1', async () => {
    const p = createTestProject('Test_Project_03', 2);
    const audioBuf = makeWavBuffer(2);
    const mp = makeMultipart('file', 'narrate_short1.wav', 'audio/wav', audioBuf);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_1`,
      headers: mp.headers,
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(200);
    const updated = loadProject('Test_Project_03')!;
    expect(updated.meta.input.voiceoverFile).toBeNull();
    expect(updated.meta.input.targetAudio?.short_1).toBe('voiceover/Test_Project_03_short_1.wav');
    expect(updated.meta.input.targetAudio?.short_2).toBeUndefined();
  });

  it('4. Uploading one Short does not alter another target', async () => {
    const p = createTestProject('Test_Project_04', 2);
    // First upload short_1
    const buf1 = makeWavBuffer(2);
    const mp1 = makeMultipart('file', 'short1.wav', 'audio/wav', buf1);
    await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_1`,
      headers: mp1.headers,
      payload: mp1.payload,
    });

    // Next upload short_2
    const buf2 = makeWavBuffer(4);
    const mp2 = makeMultipart('file', 'short2.wav', 'audio/wav', buf2);
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_2`,
      headers: mp2.headers,
      payload: mp2.payload,
    });

    expect(res2.statusCode).toBe(200);
    const updated = loadProject('Test_Project_04')!;
    expect(updated.meta.input.targetAudio?.short_1).toBe('voiceover/Test_Project_04_short_1.wav');
    expect(updated.meta.input.targetAudio?.short_2).toBe('voiceover/Test_Project_04_short_2.wav');
    expect(updated.meta.input.voiceoverFile).toBeNull();
  });

  it('5. Invalid target IDs are rejected', async () => {
    const p = createTestProject('Test_Project_05', 2);
    const buf = makeWavBuffer(1);
    const mp = makeMultipart('file', 'audio.wav', 'audio/wav', buf);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/invalid_target`,
      headers: mp.headers,
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('Invalid target ID');
  });

  it('6. A Short absent from the storyboard is rejected', async () => {
    // Project only has short_1 (shortCount = 1)
    const p = createTestProject('Test_Project_06', 1);
    expect(p.storyboard.shorts.map((s) => s.id)).toEqual(['short_1']);

    const buf = makeWavBuffer(1);
    const mp = makeMultipart('file', 'audio.wav', 'audio/wav', buf);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_3`,
      headers: mp.headers,
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('not present in project');
  });

  it('7. Empty files are rejected', async () => {
    const p = createTestProject('Test_Project_07', 2);
    const mp = makeMultipart('file', 'empty.wav', 'audio/wav', Buffer.alloc(0));

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_1`,
      headers: mp.headers,
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/empty/i);
  });

  it('8. Unsupported file formats are rejected', async () => {
    const p = createTestProject('Test_Project_08', 2);
    const fakeText = Buffer.from('console.log("not audio")');
    const mp = makeMultipart('file', 'script.js', 'text/javascript', fakeText);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_1`,
      headers: mp.headers,
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/unsupported audio format/i);
  });

  it('9. Invalid audio content is rejected', async () => {
    const p = createTestProject('Test_Project_09', 2);
    // Garbage data with a .wav extension
    const garbage = Buffer.from('NOT_A_VALID_RIFF_HEADER_1234567890');
    const mp = makeMultipart('file', 'corrupt.wav', 'audio/wav', garbage);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_1`,
      headers: mp.headers,
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/audio/i);
  });

  it('10. Stored files remain inside the managed voiceover directory', async () => {
    const p = createTestProject('Test_Project_10', 2);
    const buf = makeWavBuffer(1);
    const mp = makeMultipart('file', '../../../evil.wav', 'audio/wav', buf);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_1`,
      headers: mp.headers,
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(200);
    const updated = loadProject('Test_Project_10')!;
    const ref = updated.meta.input.targetAudio?.short_1!;
    expect(ref).toBe('voiceover/Test_Project_10_short_1.wav');
    expect(isManagedVoiceoverPath(ref)).toBe(true);

    const absPath = resolveDataPath(ref);
    expect(fs.existsSync(absPath)).toBe(true);
    expect(absPath.startsWith(path.join(testDataDir, 'voiceover'))).toBe(true);
  });

  it('11. Stored project references are relative', async () => {
    const p = createTestProject('Test_Project_11', 2);
    const buf = makeWavBuffer(1);
    const mp = makeMultipart('file', 'test.wav', 'audio/wav', buf);

    await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/long`,
      headers: mp.headers,
      payload: mp.payload,
    });

    const updated = loadProject('Test_Project_11')!;
    expect(path.isAbsolute(updated.meta.input.voiceoverFile!)).toBe(false);
    expect(updated.meta.input.voiceoverFile).toBe('voiceover/Test_Project_11_long.wav');
  });

  it('12. Failed uploads leave no partial managed file', async () => {
    const p = createTestProject('Test_Project_12', 2);
    const voiceoverDir = path.join(testDataDir, 'voiceover');
    const filesBefore = fs.existsSync(voiceoverDir) ? fs.readdirSync(voiceoverDir) : [];

    const corrupt = Buffer.from('not audio');
    const mp = makeMultipart('file', 'corrupt.wav', 'audio/wav', corrupt);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_1`,
      headers: mp.headers,
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(400);
    const filesAfter = fs.existsSync(voiceoverDir) ? fs.readdirSync(voiceoverDir) : [];
    expect(filesAfter).toEqual(filesBefore);
  });

  it('13. Failed uploads do not corrupt or partially update project JSON', async () => {
    const p = createTestProject('Test_Project_13', 2);
    const originalJson = JSON.stringify(p);

    const corrupt = Buffer.from('not audio');
    const mp = makeMultipart('file', 'corrupt.wav', 'audio/wav', corrupt);

    await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_1`,
      headers: mp.headers,
      payload: mp.payload,
    });

    const after = loadProject('Test_Project_13')!;
    expect(after.meta.input.targetAudio).toEqual({});
    expect(after.meta.input.voiceoverFile).toBeNull();
  });

  it('14. Removing one target leaves all other targets untouched', async () => {
    const p = createTestProject('Test_Project_14', 2);

    // Upload long and short_1
    const bufLong = makeWavBuffer(2);
    const mpLong = makeMultipart('file', 'long.wav', 'audio/wav', bufLong);
    await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/long`,
      headers: mpLong.headers,
      payload: mpLong.payload,
    });

    const bufShort = makeWavBuffer(2);
    const mpShort = makeMultipart('file', 'short1.wav', 'audio/wav', bufShort);
    await app.inject({
      method: 'POST',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_1`,
      headers: mpShort.headers,
      payload: mpShort.payload,
    });

    // Delete only short_1
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/short_1`,
    });

    expect(delRes.statusCode).toBe(200);
    const updated = loadProject('Test_Project_14')!;
    expect(updated.meta.input.voiceoverFile).toBe('voiceover/Test_Project_14_long.wav');
    expect(updated.meta.input.targetAudio?.short_1).toBeUndefined();

    // The managed file for short_1 should be removed
    const shortFile = resolveDataPath('voiceover/Test_Project_14_short_1.wav');
    expect(fs.existsSync(shortFile)).toBe(false);

    // The file for long should still exist
    const longFile = resolveDataPath('voiceover/Test_Project_14_long.wav');
    expect(fs.existsSync(longFile)).toBe(true);
  });

  it('15. Removing audio cannot delete an arbitrary external file', async () => {
    // External file outside the data directory
    const externalFile = path.join(tempDir, 'sensitive_external.wav');
    fs.writeFileSync(externalFile, makeWavBuffer(1));
    expect(fs.existsSync(externalFile)).toBe(true);

    const p = createTestProject('Test_Project_15', 2);
    // Manually set an external path on the project
    p.meta.input.voiceoverFile = externalFile;
    saveProject(p);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${p.meta.input.videoId}/target-audio/long`,
    });

    expect(delRes.statusCode).toBe(200);
    // Project reference cleared
    const updated = loadProject('Test_Project_15')!;
    expect(updated.meta.input.voiceoverFile).toBeNull();
    // Crucial safety check: external file must NOT be deleted
    expect(fs.existsSync(externalFile)).toBe(true);
  });

  it('16. Legacy projects display their Long status and missing Short statuses correctly', async () => {
    // Create a legacy audio file in data/voiceover
    const voiceoverDir = path.join(testDataDir, 'voiceover');
    fs.mkdirSync(voiceoverDir, { recursive: true });
    const legacyFile = path.join(voiceoverDir, 'Legacy_01.wav');
    fs.writeFileSync(legacyFile, makeWavBuffer(5));

    // Create legacy project with voiceoverFile pointing to it and no targetAudio
    const p = createTestProject('Legacy_01', 3, 'voiceover/Legacy_01.wav');

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${p.meta.input.videoId}/target-audio`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.readyCount).toBe(1);
    expect(body.missingCount).toBe(3);
    expect(body.blockedTargets).toEqual(['Short 1', 'Short 2', 'Short 3']);

    const longTarget = body.targets.find((t: any) => t.targetId === 'long');
    expect(longTarget.ready).toBe(true);
    expect(longTarget.status).toBe('ready');
    expect(longTarget.fileName).toBe('Legacy_01.wav');
    expect(longTarget.durationSec).toBeCloseTo(5.0, 1);

    for (const shortId of ['short_1', 'short_2', 'short_3']) {
      const s = body.targets.find((t: any) => t.targetId === shortId);
      expect(s.ready).toBe(false);
      expect(s.status).toBe('missing');
    }
  });
});
