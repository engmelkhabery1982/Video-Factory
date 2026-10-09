/**
 * The operator journey after choosing ready narration.
 *
 * No speech engine, no model download, and no Remotion render. A fixture WAV
 * is not a human listening approval or a rights clearance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'user-flow-external');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  return { root, data, output };
});

import { normalizeSpokenScript } from '@buildtrack/core';
import { finalExportSeam } from '../apps/api/src/routes/projects.js';
import { exportValidationHooks } from '../apps/api/src/services/export-snapshot.js';
import { buildServerApp } from '../apps/api/src/server.js';
import { exportSpecFor, finalNarrationLengthRefusal, muxAndEncode } from '../apps/api/src/services/render.js';
import { referenceWavBuffer } from './helpers/chatterbox-worker-fixtures.js';

const SCRIPT = [
  'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
  'اللَّهُمَّ إِنِّي أَسْأَلُكَ بِرَحْمَتِكَ الَّتِي وَسِعَتْ كُلَّ شَيْءٍ.',
  'وَلَكِنْ هَذَا كَلَامُ الْمُشَغِّلِ، وَلَيْسَ اقْتِبَاسًا مَنْسُوبًا.',
].join('\n\n');

const INVENTED = /By the end of this video|BuildTrack shows|In short:|records|claims|evidence|Quran|hadith|رواه/i;

function projectBody(videoId: string, narrationSource?: 'external_ready' | 'in_app_dialogue', outputLanguage = 'ar') {
  return {
    videoId,
    videoType: 'long',
    topic: 'رحمة',
    targetAudience: 'listeners',
    mainProblem: '',
    viewerPromise: '',
    hook: 'Where are the project records?',
    script: SCRIPT,
    keyNumbers: [],
    keyPoints: ['records', 'claims', 'evidence'],
    productName: 'BuildTrack',
    productShots: [],
    cta: '',
    voiceoverFile: null,
    brollFiles: [],
    sourceReferences: [],
    outputLanguage,
    brandPreset: 'buildtrack',
    shortCount: 0,
    ...(narrationSource ? { narrationSource } : {}),
  };
}

function multipart(filename: string, content: Buffer, extra: Record<string, string>) {
  const boundary = '----userflow' + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(extra)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

const declaration = {
  scriptText: SCRIPT,
  sourceKind: 'own_recording',
  ownershipConfirmed: 'true',
  ownershipStatement: 'The operator owns this recording. This sentence is not a license by itself.',
  speakerName: 'Operator',
};

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;
const originalExport = finalExportSeam.exportProject;

beforeAll(async () => {
  app = await buildServerApp();
  await app.ready();
});

afterAll(async () => {
  finalExportSeam.exportProject = originalExport;
  exportValidationHooks.beforeConsume = undefined;
  await app.close();
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

function spoken(project: { storyboard: { long: { scenes: Array<{ narration: string }> } } }) {
  return project.storyboard.long.scenes.map((scene) => scene.narration).join('\n\n');
}

async function createExternal(videoId: string) {
  const created = await app.inject({ method: 'POST', url: '/api/projects', payload: projectBody(videoId, 'external_ready') });
  expect(created.statusCode).toBe(200);
  const boarded = await app.inject({ method: 'POST', url: `/api/projects/${videoId}/storyboard`, payload: { preserveEdits: false } });
  expect(boarded.statusCode).toBe(200);
  return boarded.json().project;
}

describe('ready narration does not invent speech or start Kokoro', () => {
  it('keeps the Arabic script, diacritics, and order, and does not speak the hook or key points', async () => {
    const project = await createExternal('Arabic_Script');
    expect(spoken(project)).toBe(normalizeSpokenScript(SCRIPT));
    expect(spoken(project)).toContain('الرَّحْمَٰنِ');
    expect(spoken(project)).not.toMatch(INVENTED);
    expect(project.storyboard.captions.map((cue: { text: string }) => cue.text).join('\n\n')).toBe(normalizeSpokenScript(SCRIPT));
    expect(project.storyboard.shorts).toEqual([]);
    expect(project.storyboard.warnings.join(' ')).toMatch(/not acoustic alignment/i);
    expect(fs.existsSync(path.join(tmp.data, 'projects', 'Arabic_Script', 'production.json'))).toBe(false);
  });

  it('refuses production generation, captions, and production export for an external project', async () => {
    await createExternal('No_Kokoro');
    fs.writeFileSync(path.join(tmp.data, 'projects', 'No_Kokoro', 'production-state.json'), '{"schemaVersion":1,"scenarios":{"long":{}}}');
    const generated = await app.inject({ method: 'POST', url: '/api/projects/No_Kokoro/production/generate' });
    expect(generated.statusCode).toBe(409);
    expect(generated.json().code).toBe('EXTERNAL_NARRATION_PATH');
    const captions = await app.inject({ method: 'GET', url: '/api/projects/No_Kokoro/production/captions/long' });
    expect(captions.statusCode).toBe(409);
    expect(captions.json().code).toBe('EXTERNAL_NARRATION_PATH');
    expect(captions.body).not.toContain('Internal Server Error');
    const exported = await app.inject({ method: 'POST', url: '/api/projects/No_Kokoro/production/export' });
    expect(exported.statusCode).toBe(409);
    expect(exported.json().code).toBe('EXTERNAL_NARRATION_PATH');
    expect(exported.json().jobId).toBeUndefined();
    expect(fs.existsSync(path.join(tmp.data, 'projects', 'No_Kokoro', 'production-state.json'))).toBe(true);
  });

  it('does not convert a project by opening it, and an explicit switch keeps production files', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: projectBody('Old_Dialogue', 'in_app_dialogue', 'en') });
    expect(created.statusCode).toBe(200);
    const opened = await app.inject({ method: 'GET', url: '/api/projects/Old_Dialogue' });
    expect(opened.json().project.meta.input.narrationSource).toBe('in_app_dialogue');
    const untouched = await app.inject({ method: 'POST', url: '/api/projects', payload: projectBody('No_Choice') });
    expect(untouched.json().project.meta.input.narrationSource).toBeUndefined();
    const still = await app.inject({ method: 'GET', url: '/api/projects/No_Choice' });
    expect(still.json().project.meta.input.narrationSource).toBeUndefined();
    const quiet = await app.inject({
      method: 'PUT',
      url: '/api/projects/No_Choice',
      payload: { input: { narrationSource: 'external_ready', topic: 'رحمة' } },
    });
    expect(quiet.json().project.meta.input.narrationSource).toBeUndefined();
    fs.writeFileSync(path.join(tmp.data, 'projects', 'No_Choice', 'production-state.json'), '{"schemaVersion":1,"scenarios":{}}');
    const unconfirmed = await app.inject({
      method: 'POST',
      url: '/api/projects/No_Choice/narration-source',
      payload: { narrationSource: 'external_ready' },
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().code).toBe('CONFIRMATION_REQUIRED');
    const switched = await app.inject({
      method: 'POST',
      url: '/api/projects/No_Choice/narration-source',
      payload: { narrationSource: 'external_ready', confirm: true },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().productionPreserved).toBe(true);
    expect(spoken(switched.json().project)).toBe(normalizeSpokenScript(SCRIPT));
    expect(fs.existsSync(path.join(tmp.data, 'projects', 'No_Choice', 'production-state.json'))).toBe(true);
  });

  it('still generates dialogue for a project that chose the in-app path', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: projectBody('Dialogue_Still', 'in_app_dialogue', 'en') });
    const generated = await app.inject({ method: 'POST', url: '/api/projects/Dialogue_Still/production/generate' });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().production.exists).toBe(true);
  });
});

describe('production captions name the failure instead of a generic 500', () => {
  it('returns a clear unprovisioned-engine status for an English dialogue project', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: projectBody('Caption_En', 'in_app_dialogue', 'en') });
    await app.inject({ method: 'POST', url: '/api/projects/Caption_En/production/generate' });
    const captions = await app.inject({ method: 'GET', url: '/api/projects/Caption_En/production/captions/long' });
    expect(captions.statusCode).toBe(503);
    expect(captions.json().code).toBe('ENGINE_NOT_PROVISIONED');
    expect(captions.json().error).toMatch(/Synthesizer 'kokoro-js' is not available/);
    expect(captions.json().diagnosis).toMatch(/not a missing narration file/i);
    expect(captions.body).not.toContain('Internal Server Error');
  });

  it('records the Arabic voice-language exception instead of hiding it', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: projectBody('Caption_Ar', 'in_app_dialogue', 'ar') });
    await app.inject({ method: 'POST', url: '/api/projects/Caption_Ar/production/generate' });
    const captions = await app.inject({ method: 'GET', url: '/api/projects/Caption_Ar/production/captions/long' });
    expect(captions.statusCode).toBe(422);
    expect(captions.json().code).toBe('DIALOGUE_LANGUAGE_UNSUPPORTED');
    expect(captions.json().error).toMatch(/does not support requested language 'ar'/);
    expect(captions.body).not.toContain('Internal Server Error');
  });

  it('distinguishes no production state from corrupt production data', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: projectBody('Caption_None', 'in_app_dialogue', 'en') });
    const absent = await app.inject({ method: 'GET', url: '/api/projects/Caption_None/production/captions/long' });
    expect(absent.statusCode).toBe(409);
    expect(absent.json().code).toBe('NO_PRODUCTION_STATE');
    fs.writeFileSync(path.join(tmp.data, 'projects', 'Caption_None', 'production-state.json'), '{');
    const corrupt = await app.inject({ method: 'GET', url: '/api/projects/Caption_None/production/captions/long' });
    expect(corrupt.statusCode).toBe(422);
    expect(corrupt.json().code).toBe('PRODUCTION_STATE_CORRUPT');
  });
});

describe('final export cannot skip an unknown narration length', () => {
  it('refuses when durationSec is null or the measurement is missing', () => {
    expect(
      finalNarrationLengthRefusal({ finalExport: true, hasAudio: true, durationSec: null, measuredSeconds: 4 }),
    ).toMatch(/durationSec was missing/);
    expect(
      finalNarrationLengthRefusal({ finalExport: true, hasAudio: true, durationSec: 6, measuredSeconds: null }),
    ).toMatch(/could not be measured/);
    expect(finalNarrationLengthRefusal({ finalExport: false, hasAudio: true, durationSec: null, measuredSeconds: null })).toBeNull();
  });

  it('does not start ffmpeg when a final mux has no planned duration', async () => {
    const audio = path.join(tmp.root, 'measured.wav');
    fs.writeFileSync(audio, referenceWavBuffer('measured', 2));
    await expect(
      muxAndEncode({
        rawVideo: path.join(tmp.root, 'missing-raw.mp4'),
        audioFile: audio,
        outFile: path.join(tmp.root, 'should-not-exist.mp4'),
        spec: exportSpecFor('long'),
        videoBitrate: '1M',
        maxrate: '1M',
        durationSec: undefined,
        finalExport: true,
      }),
    ).rejects.toThrow(/length check was not skipped/i);
    expect(fs.existsSync(path.join(tmp.root, 'should-not-exist.mp4'))).toBe(false);
  });
});

describe('the ordinary export consumes the frozen external audio', () => {
  async function ready(videoId: string) {
    await createExternal(videoId);
    const imported = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/target-audio/long/external`,
      ...multipart('narration.wav', referenceWavBuffer(videoId, 4), declaration),
    });
    expect([200, 201]).toContain(imported.statusCode);
    expect(imported.json().import.durationSec).toBeGreaterThan(3);
    const reloaded = await app.inject({ method: 'GET', url: `/api/projects/${videoId}/external-narration` });
    expect(reloaded.json().targets.find((target: { targetId: string }) => target.targetId === 'long').import).toBeTruthy();
    await app.inject({ method: 'POST', url: `/api/projects/${videoId}/storyboard`, payload: { preserveEdits: false } });
    const review = await app.inject({ method: 'GET', url: `/api/projects/${videoId}/external-narration/timing/long` });
    expect(review.statusCode).toBe(200);
    const timing = review.json().timing;
    const audio = Number(timing.audioDurationSec);
    const scenes = (timing.scenes as Array<{ sceneId: string; durationSec: number }>).map((scene, index, all) => {
      const durationSec = index === all.length - 1 ? Number((audio - index * (audio / all.length)).toFixed(3)) : Number((audio / all.length).toFixed(3));
      return { sceneId: scene.sceneId, startTime: 0, durationSec };
    });
    let cursor = 0;
    for (const scene of scenes) {
      scene.startTime = Number(cursor.toFixed(3));
      cursor += scene.durationSec;
    }
    const cues = timing.captions as Array<{ cueId: string }>;
    const captions = cues.map((cue, index) => {
      const slot = audio / Math.max(1, cues.length);
      return { cueId: cue.cueId, start: Number((index * slot).toFixed(3)), end: Number(Math.min(audio, (index + 1) * slot).toFixed(3)) };
    });
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/projects/${videoId}/external-narration/timing/long`,
      payload: { scenes, captions },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const listened = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/target-audio/long/external/approval`,
      payload: { decision: 'approved', listened: true, decidedBy: 'project-owner' },
    });
    expect(listened.statusCode, listened.body).toBe(200);
    const timed = await app.inject({
      method: 'POST',
      url: `/api/projects/${videoId}/external-narration/timing/long/approval`,
      payload: { decision: 'approved', reviewed: true, decidedBy: 'project-owner' },
    });
    expect(timed.statusCode, timed.body).toBe(200);
  }

  it('blocks export until listening and timing are approved', async () => {
    await createExternal('Needs_Approval');
    await app.inject({
      method: 'POST',
      url: '/api/projects/Needs_Approval/target-audio/long/external',
      ...multipart('narration.wav', referenceWavBuffer('Needs_Approval', 4), declaration),
    });
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/projects/Needs_Approval/export',
      payload: { kind: 'final', includeShorts: false, includeThumbnails: false },
    });
    expect(blocked.statusCode).toBe(409);
    expect(JSON.stringify(blocked.json())).toMatch(/IMPORT-NOT-APPROVED|approval/i);
  });

  it('uses the frozen copy, rejects a caption change, and ignores a swapped original', async () => {
    await ready('Frozen_Export');
    const project = (await app.inject({ method: 'GET', url: '/api/projects/Frozen_Export' })).json().project;
    const original = path.resolve(tmp.data, project.meta.input.voiceoverFile);
    const approved = fs.readFileSync(original);
    const seen: Array<{ file: string; text: string; sha256: string }> = [];
    finalExportSeam.exportProject = (async (rendering, opts) => {
      const file = opts.targetAudio.long?.file ?? '';
      fs.writeFileSync(original, Buffer.from('replaced-after-the-snapshot'));
      seen.push({
        file,
        text: rendering.storyboard.long.scenes.map((scene) => scene.narration).join('\n\n'),
        sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      });
      return { results: [], summary: { ok: true } };
    }) as typeof finalExportSeam.exportProject;
    const exported = await app.inject({
      method: 'POST',
      url: '/api/projects/Frozen_Export/export',
      payload: { kind: 'final', includeShorts: false, includeThumbnails: false, override: { reason: 'fixture only, not rights clearance' } },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const jobId = exported.json().jobId as string;
    let job: { status: string; error?: string } = { status: 'running' };
    for (let i = 0; i < 20 && job.status === 'running'; i++) {
      job = (await app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(jobId)}` })).json();
    }
    expect(job.status, job.error).toBe('done');
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe(normalizeSpokenScript(SCRIPT));
    expect(seen[0].file).not.toBe(original);
    expect(seen[0].sha256).toBe(createHash('sha256').update(approved).digest('hex'));
    expect(fs.readFileSync(original).equals(Buffer.from('replaced-after-the-snapshot'))).toBe(true);
    fs.writeFileSync(original, approved);
    finalExportSeam.exportProject = originalExport;
    exportValidationHooks.beforeConsume = async () => {
      exportValidationHooks.beforeConsume = undefined;
      await app.inject({
        method: 'PATCH',
        url: `/api/projects/Frozen_Export/captions/${project.storyboard.captions[0].id}`,
        payload: { text: 'نَصٌّ تَغَيَّرَ أَثْنَاءَ الْفَحْصِ' },
      });
    };
    const during = await app.inject({
      method: 'POST',
      url: '/api/projects/Frozen_Export/export',
      payload: { kind: 'final', includeShorts: false, includeThumbnails: false },
    });
    expect(during.statusCode).toBe(409);
    expect(during.json().error).toMatch(/changed|timing|approval/i);
    exportValidationHooks.beforeConsume = undefined;

    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/projects/Frozen_Export/captions/${project.storyboard.captions[0].id}`,
      payload: { text: 'نَصٌّ مُخْتَلِفٌ' },
    });
    expect(changed.statusCode).toBe(200);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/projects/Frozen_Export/export',
      payload: { kind: 'final', includeShorts: false, includeThumbnails: false },
    });
    expect(stale.statusCode).toBe(409);
    expect(JSON.stringify(stale.json())).toMatch(/timing|approval|changed/i);
  });
});

describe('media streaming closes the FileHandle it opens', () => {
  it('does not leak a descriptor per response', async () => {
    const file = path.join(tmp.output, 'probe.txt');
    fs.writeFileSync(file, 'hello');
    const before = fs.readdirSync('/proc/self/fd').length;
    for (let i = 0; i < 12; i++) {
      const response = await app.inject({ method: 'GET', url: '/output/probe.txt' });
      expect(response.statusCode).toBe(200);
    }
    const after = fs.readdirSync('/proc/self/fd').length;
    expect(after - before).toBeLessThan(4);
  });
});
