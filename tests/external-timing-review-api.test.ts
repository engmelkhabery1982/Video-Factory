/**
 * VS5 — timing review API.
 *
 * TEST/FIXTURE evidence only. The WAV buffers are generated in-process. This
 * file does not import a real recording, generate speech, download a model, or
 * render a video.
 *
 * Smoke: import fixture audio → approve audio → edit timing → save → reload →
 * approve timing → readiness → replace audio → stale block.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'vs5-timing-api');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  return { root, data, output };
});

import { PROJECT_SCHEMA_VERSION, buildStoryboard, emptyHistory, type Project, type ProjectInput } from '@buildtrack/core';
import { loadProject, saveProject } from '../apps/api/src/services/store.js';
import { buildServerApp } from '../apps/api/src/server.js';
import { loadVoiceAudioState } from '../apps/api/src/services/voice-audio-state.js';
import { referenceWavBuffer, sha256OfBuffer } from './helpers/chatterbox-worker-fixtures.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;
const STORY = 'Every site supervisor knows that safety inspections take time and discipline.';

function narrationWav(seconds: number): Buffer {
  return referenceWavBuffer(`vs5-narration-${seconds.toFixed(2)}`, seconds);
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

function createProject(videoId: string, audioDuration = 10): Project {
  const input = projectInput(videoId, STORY);
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

function multipart(content: Buffer, extra: Record<string, string>) {
  const boundary = '----vs5boundary';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(extra)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) };
}

const DECLARATION = {
  scriptText: STORY,
  sourceKind: 'own_recording',
  ownershipConfirmed: 'true',
  ownershipStatement: 'TEST/FIXTURE recording owned by the operator',
  speakerName: 'Fixture speaker',
  speakerId: 'fixture-speaker',
};

async function importNarration(videoId: string, target: string, wav: Buffer, extra: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/projects/${videoId}/target-audio/${target}/external`,
    ...multipart(wav, { ...DECLARATION, ...extra }),
  });
}


/** A valid correction of the generated plan: speech covers the audio, end card stays inside its allowance. */
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
    return { sceneId: scene.sceneId, startTime, durationSec: Number(durationSec.toFixed(3)), narration: scene.narration };
  });
  const cues = timing.captions as any[];
  const captions = cues.map((cue, index) => {
    const slot = audio / Math.max(1, cues.length);
    const start = Number((index * slot + 0.05).toFixed(3));
    const end = Number((Math.min(audio - 0.05, (index + 1) * slot - 0.05)).toFixed(3));
    return { cueId: cue.cueId, start, end: Math.max(start + 0.2, end), text: cue.text };
  });
  return { scenes: nextScenes, captions };
}

function timingPayload(timing: any, mutate?: (body: { scenes: any[]; captions: any[] }) => void) {
  const body = {
    scenes: timing.scenes.map((scene: any) => ({ sceneId: scene.sceneId, startTime: scene.startTime, durationSec: scene.durationSec, narration: scene.narration })),
    captions: timing.captions.map((cue: any) => ({ cueId: cue.cueId, start: cue.start, end: cue.end, text: cue.text })),
  };
  mutate?.(body);
  return body;
}

beforeAll(async () => {
  app = await buildServerApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('VS5 TEST/FIXTURE smoke: review, save, approve, then block a replaced audio', () => {
  it('walks the editor flow and keeps the fixture audio bytes intact', async () => {
    createProject('Video_VS5Smoke', 10);
    const wav = narrationWav(10);
    const imported = await importNarration('Video_VS5Smoke', 'long', wav);
    expect(imported.statusCode).toBe(201);
    expect(imported.json().view.alignment.verified).toBe(false);
    expect(JSON.stringify(imported.json())).not.toContain('acoustically verified');

    const regen = await app.inject({ method: 'POST', url: '/api/projects/Video_VS5Smoke/storyboard', payload: { preserveEdits: false } });
    expect(regen.statusCode).toBe(200);
    const audioApproval = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_VS5Smoke/target-audio/long/external/approval',
      payload: { decision: 'approved', listened: true, decidedBy: 'project-owner' },
    });
    expect(audioApproval.statusCode).toBe(200);
    expect(audioApproval.json().view.ready).toBe(false);

    const blocked = await app.inject({ method: 'POST', url: '/api/projects/Video_VS5Smoke/export', payload: { kind: 'final' } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().externalNarrationGate.blockedCodes).toContain('TIMING-APPROVAL-MISSING');

    const before = await app.inject({ method: 'GET', url: '/api/projects/Video_VS5Smoke/external-narration/timing/long' });
    const timing = before.json().timing;
    expect(timing.acousticVerification).toBe(false);
    expect(timing.timingReview.source).toBe('estimated');
    const audioRef = loadProject('Video_VS5Smoke')!.meta.input.voiceoverFile!;
    const audioPath = path.isAbsolute(audioRef) ? audioRef : path.join(tmp.data, audioRef);
    const audioHashBefore = createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex');
    const narrationBefore = timing.scenes.map((scene: any) => scene.narration).join('\n');
    const captionTextBefore = timing.captions.map((cue: any) => cue.text).join('\n');

    const fitted = coveringTiming(timing);
    const expectedEnd = Number((fitted.captions[0].end - 0.1).toFixed(3));
    fitted.captions[0].end = expectedEnd;
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_VS5Smoke/external-narration/timing/long',
      payload: fitted,
    });
    expect(saved.statusCode, JSON.stringify(saved.json())).toBe(200);
    expect(saved.json().timing.captions[0].end).toBeCloseTo(expectedEnd, 2);

    const reloaded = await app.inject({ method: 'GET', url: '/api/projects/Video_VS5Smoke/external-narration/timing/long' });
    expect(reloaded.json().timing.captions[0].end).toBeCloseTo(expectedEnd, 2);
    expect(reloaded.json().timing.scenes.map((scene: any) => scene.narration).join('\n')).toBe(narrationBefore);
    expect(reloaded.json().timing.captions.map((cue: any) => cue.text).join('\n')).toBe(captionTextBefore);
    expect(reloaded.json().timing.captions).toHaveLength(timing.captions.length);
    expect(createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex')).toBe(audioHashBefore);
    expect(sha256OfBuffer(fs.readFileSync(audioPath))).toBe(audioHashBefore);

    const timingApproval = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_VS5Smoke/external-narration/timing/long/approval',
      payload: { decision: 'approved', reviewed: true, decidedBy: 'project-owner' },
    });
    expect(timingApproval.statusCode).toBe(200);
    expect(timingApproval.json().view.ready).toBe(true);
    expect(timingApproval.json().view.timingReview.review).toBe('approved');
    expect(timingApproval.json().view.timingReview.acousticVerification).toBe(false);

    const replaced = await importNarration('Video_VS5Smoke', 'long', narrationWav(11));
    expect(replaced.statusCode).toBe(201);
    expect(replaced.json().view.approval).toBeNull();
    expect(replaced.json().view.timingApproval).toBeNull();
    const afterReplace = await app.inject({ method: 'POST', url: '/api/projects/Video_VS5Smoke/export', payload: { kind: 'final' } });
    expect(afterReplace.statusCode).toBe(409);
    expect(afterReplace.json().externalNarrationGate.blockedCodes).toContain('IMPORT-APPROVAL-MISSING');
    expect(JSON.stringify(afterReplace.json())).not.toMatch(/\/home\/|voiceover\//);
  });
});

describe('VS5: invalid timing is rejected and not persisted', () => {
  it('rejects negative and reversed times without writing them', async () => {
    createProject('Video_VS5Bad', 10);
    await importNarration('Video_VS5Bad', 'long', narrationWav(10));
    await app.inject({ method: 'POST', url: '/api/projects/Video_VS5Bad/storyboard', payload: { preserveEdits: false } });
    const review = await app.inject({ method: 'GET', url: '/api/projects/Video_VS5Bad/external-narration/timing/long' });
    const original = review.json().timing.captions[0].start;
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_VS5Bad/external-narration/timing/long',
      payload: timingPayload(review.json().timing, (body) => {
        body.captions[0].start = -2;
        body.captions[0].end = -1;
      }),
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().blocking.map((item: { code: string }) => item.code)).toContain('TIMING-TIME-INVALID');
    expect(JSON.stringify(rejected.json())).not.toMatch(/\/home\/|voiceover\//);
    const again = await app.inject({ method: 'GET', url: '/api/projects/Video_VS5Bad/external-narration/timing/long' });
    expect(again.json().timing.captions[0].start).toBe(original);
  });

  it('rejects a scene gap and a script deletion', async () => {
    createProject('Video_VS5Overlap', 10);
    await importNarration('Video_VS5Overlap', 'long', narrationWav(10));
    await app.inject({ method: 'POST', url: '/api/projects/Video_VS5Overlap/storyboard', payload: { preserveEdits: false } });
    const review = await app.inject({ method: 'GET', url: '/api/projects/Video_VS5Overlap/external-narration/timing/long' });
    const fitted = coveringTiming(review.json().timing);
    fitted.scenes[1].startTime = Number((fitted.scenes[1].startTime + 0.4).toFixed(3));
    const overlap = await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_VS5Overlap/external-narration/timing/long',
      payload: fitted,
    });
    expect(overlap.statusCode).toBe(400);
    expect(overlap.json().blocking.map((item: { code: string }) => item.code)).toContain('TIMING-SCENE-GAP');

    const deleted = await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_VS5Overlap/external-narration/timing/long',
      payload: timingPayload(review.json().timing, (body) => {
        body.captions[0].text = '';
      }),
    });
    expect(deleted.statusCode).toBe(400);
    expect(deleted.json().blocking.map((item: { code: string }) => item.code)).toContain('TIMING-SCRIPT-ALTERED');
  });
});

describe('VS5: target independence, presentation, and end card', () => {
  it('does not let a Short inherit or overwrite Long timing', async () => {
    createProject('Video_VS5Targets', 10);
    await importNarration('Video_VS5Targets', 'long', narrationWav(10));
    await importNarration('Video_VS5Targets', 'short_1', narrationWav(8));
    await app.inject({ method: 'POST', url: '/api/projects/Video_VS5Targets/storyboard', payload: { preserveEdits: false } });
    const longBefore = await app.inject({ method: 'GET', url: '/api/projects/Video_VS5Targets/external-narration/timing/long' });
    const shortReview = await app.inject({ method: 'GET', url: '/api/projects/Video_VS5Targets/external-narration/timing/short_1' });
    const foreign = await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_VS5Targets/external-narration/timing/short_1',
      payload: timingPayload(longBefore.json().timing),
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().blocking.map((item: { code: string }) => item.code)).toContain('TIMING-TARGET-MISMATCH');

    const shortFitted = coveringTiming(shortReview.json().timing, 0.2);
    if (shortFitted.captions[0]) shortFitted.captions[0].end = Number((shortFitted.captions[0].end - 0.05).toFixed(3));
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_VS5Targets/external-narration/timing/short_1',
      payload: shortFitted,
    });
    expect(saved.statusCode).toBe(200);
    const longAfter = await app.inject({ method: 'GET', url: '/api/projects/Video_VS5Targets/external-narration/timing/long' });
    expect(longAfter.json().timing.scenes).toEqual(longBefore.json().timing.scenes);
    expect(longAfter.json().timing.captions).toEqual(longBefore.json().timing.captions);
  });

  it('does not revoke audio or timing approval when only the scene presentation changes', async () => {
    createProject('Video_VS5Visual', 10);
    await importNarration('Video_VS5Visual', 'long', narrationWav(10));
    await app.inject({ method: 'POST', url: '/api/projects/Video_VS5Visual/storyboard', payload: { preserveEdits: false } });
    await app.inject({
      method: 'POST',
      url: '/api/projects/Video_VS5Visual/target-audio/long/external/approval',
      payload: { decision: 'approved', listened: true },
    });
    const review = await app.inject({ method: 'GET', url: '/api/projects/Video_VS5Visual/external-narration/timing/long' });
    const visualSave = await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_VS5Visual/external-narration/timing/long',
      payload: coveringTiming(review.json().timing),
    });
    expect(visualSave.statusCode, JSON.stringify(visualSave.json())).toBe(200);
    const approved = await app.inject({
      method: 'POST',
      url: '/api/projects/Video_VS5Visual/external-narration/timing/long/approval',
      payload: { decision: 'approved', reviewed: true },
    });
    expect(approved.json().view.ready).toBe(true);
    const sceneId = loadProject('Video_VS5Visual')!.storyboard.long.scenes[0].id;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/projects/Video_VS5Visual/scenes/${sceneId}`,
      payload: { background: 'dark_grid' },
    });
    expect(patched.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/projects/Video_VS5Visual/external-narration' });
    expect(after.json().targets[0].ready).toBe(true);
    expect(after.json().targets[0].approval.decision).toBe('approved');
    expect(after.json().targets[0].timingApproval.decision).toBe('approved');
  });

  it('extends the end card without shortening speech or changing the audio bytes', async () => {
    createProject('Video_VS5End', 10);
    const wav = narrationWav(10);
    await importNarration('Video_VS5End', 'long', wav);
    await app.inject({ method: 'POST', url: '/api/projects/Video_VS5End/storyboard', payload: { preserveEdits: false } });
    const review = await app.inject({ method: 'GET', url: '/api/projects/Video_VS5End/external-narration/timing/long' });
    const timing = review.json().timing;
    const last = timing.scenes[timing.scenes.length - 1];
    const speech = timing.scenes.slice(0, -1);
    const audioRef = loadProject('Video_VS5End')!.meta.input.voiceoverFile!;
    const audioPath = path.isAbsolute(audioRef) ? audioRef : path.join(tmp.data, audioRef);
    const beforeHash = createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex');
    const base = coveringTiming(timing);
    const speechDurations = base.scenes.slice(0, -1).map((scene) => scene.durationSec);
    const lastDuration = base.scenes[base.scenes.length - 1].durationSec;
    base.scenes[base.scenes.length - 1].durationSec = Number((lastDuration + 0.4).toFixed(3));
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/projects/Video_VS5End/external-narration/timing/long',
      payload: base,
    });
    expect(saved.statusCode, JSON.stringify(saved.json())).toBe(200);
    const next = saved.json().timing;
    expect(next.scenes.slice(0, -1).map((scene: any) => scene.durationSec)).toEqual(speechDurations);
    expect(next.scenes[next.scenes.length - 1].durationSec).toBeCloseTo(lastDuration + 0.4, 2);
    expect(next.scenes.map((scene: any) => scene.narration)).toEqual(timing.scenes.map((scene: any) => scene.narration));
    expect(createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex')).toBe(beforeHash);
    expect(loadVoiceAudioState('Video_VS5End').externalNarration?.imports?.long?.durationSec).toBeGreaterThan(0);
  });
});
