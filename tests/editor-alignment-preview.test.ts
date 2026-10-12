/**
 * Milestone 1 editor — alignment bridge, narration binding, previews (backend).
 *
 * Runs the REAL server routes. The alignment runner is a TEST FIXTURE
 * (tests/fixtures/fake-align-runner.mjs), so these tests prove the bridge's
 * protocol, staleness, locking and undo behaviour, not alignment quality. No
 * real preview render is started here. Owner acceptance is run locally on
 * the owner's Windows host with the real vf-align WSL runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'editor-align-suite');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  const fixture = nodePath.join(process.cwd(), 'tests', 'fixtures', 'fake-align-runner.mjs');
  process.env.VF_ALIGN_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.VF_ALIGN_CHECKPOINT = nodePath.join(root, 'fixture-checkpoint.bin');
  process.env.VF_ALIGN_TOKENIZER = nodePath.join(root, 'fixture-tokenizer.model');
  process.env.VF_ALIGN_REVIEW_ROOT = nodePath.join(root, 'review');
  process.env.VF_PREVIEW_DISABLE = '1';
  return { root, data };
});

import {
  PROJECT_SCHEMA_VERSION,
  buildStoryboard,
  emptyHistory,
  type Project,
  type ProjectInput,
} from '@buildtrack/core';
import { saveProject } from '../apps/api/src/services/store.js';
import { buildServerApp } from '../apps/api/src/server.js';
import { loadVoiceAudioState, saveVoiceAudioState, newVoiceAudioState } from '../apps/api/src/services/voice-audio-state.js';
import { previewFrames, audioGraphFor, previewAvailability } from '../apps/api/src/services/editor-render.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

const VIDEO_ID = 'Editor_Align_Fixture';
const ARABIC = 'يَا أَيُّهَا الَّذِينَ آمَنُوا اتَّقُوا اللَّهَ. وَاعْتَصِمُوا بِحَبْلِ اللَّهِ جَمِيعًا.';

function wavBytes(seconds: number, fill = 0): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(seconds * rate * 2, fill);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function projectInput(): ProjectInput {
  return {
    videoId: VIDEO_ID, videoType: 'long', topic: 'Safe Building Practice', targetAudience: 'Site managers',
    mainProblem: 'Unsafe habits', viewerPromise: 'Practical safety', hook: 'Are your teams protected?',
    script: ARABIC, keyNumbers: ['100%'], keyPoints: ['Hard hats'], productName: 'Kit', productShots: [],
    cta: 'Book your audit', voiceoverFile: null, targetAudio: {}, brollFiles: [], sourceReferences: [],
    outputLanguage: 'ar', brandPreset: 'safety_first', shortCount: 1,
  };
}

function createProject(): Project {
  const input = projectInput();
  const sb = buildStoryboard({ input, history: emptyHistory(), audioDuration: 60 });
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

function writeAssetIndex() {
  fs.mkdirSync(path.join(tmp.data, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(tmp.data, 'assets', 'index.json'), JSON.stringify([
    { id: 'img_owner', name: 'Owner still', mimeType: 'image/png', status: 'active', source: 'owner', license: 'owner', blocked: false, durationSec: null },
  ]), 'utf8');
}

const narrationFile = () => path.join(tmp.data, 'voiceover', 'owner_narration_fixture.wav');
let narrationBytes = wavBytes(20, 0);

/** Import a narration file the way the existing route records it (declaration + sha + duration). */
function importNarration(bytes: Buffer, importId: string) {
  fs.mkdirSync(path.join(tmp.data, 'voiceover'), { recursive: true });
  fs.writeFileSync(narrationFile(), bytes);
  const sha = require_sha(bytes);
  const state = loadVoiceAudioState(VIDEO_ID);
  const next = state.externalNarration ?? { imports: {}, approvals: {}, dialogueImports: [] };
  next.imports.long = {
    importId,
    projectId: VIDEO_ID,
    targetId: 'long',
    fileName: 'owner_narration.wav',
    storedRef: 'voiceover/owner_narration_fixture.wav',
    mimeType: 'audio/wav',
    byteSize: bytes.length,
    sha256: sha,
    durationSec: (bytes.length - 44) / 16000,
    durationSource: 'ffprobe',
    scriptText: ARABIC,
    scriptSha256: 'a'.repeat(64),
    declaration: { sourceKind: 'own_recording', ownershipConfirmed: true, ownershipStatement: 'fixture', speakerName: 'Owner' },
    alignment: {},
    createdAt: new Date().toISOString(),
  } as unknown as NonNullable<typeof next.imports.long>;
  saveVoiceAudioState({ ...state, externalNarration: next });
}

import crypto from 'node:crypto';
const require_sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

interface EditorDoc {
  revision: number;
  captions: Array<{ id: string; text: string; startSec: number; endSec: number; locked: boolean }>;
  visualClips: Array<{ id: string; startSec: number; durationSec: number }>;
  alignment: { status: string; proposalId: string | null };
  assets: Array<{ id: string; sha256?: string }>;
  [k: string]: unknown;
}

async function getEditor(targetId = 'long') {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/editor?targetId=${targetId}` });
  return res;
}
async function doc(): Promise<EditorDoc> {
  const res = await getEditor();
  expect(res.statusCode).toBe(200);
  return res.json().document as EditorDoc;
}

async function waitForJob(jobId: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/editor/alignment/${jobId}` });
    const body = res.json();
    if (body.status !== 'running') return body;
    if (Date.now() > until) throw new Error('alignment job did not finish in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function startAlignment(baseRevision: number, targetId = 'long') {
  return app.inject({
    method: 'POST',
    url: `/api/projects/${VIDEO_ID}/editor/alignment`,
    payload: { targetId, sourceAudioId: 'narration', baseRevision },
  });
}

async function patchCaption(baseRevision: number, captionId: string, text: string) {
  return app.inject({
    method: 'PATCH',
    url: `/api/projects/${VIDEO_ID}/editor`,
    payload: { targetId: 'long', baseRevision, operations: [{ type: 'update', collection: 'captions', id: captionId, changes: { text } }] },
  });
}

beforeAll(async () => {
  createProject();
  writeAssetIndex();
  importNarration(narrationBytes, 'imp_fixture_one');
  app = await buildServerApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  try { fs.rmSync(tmp.root, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.VF_FAKE_ALIGN_MODE;
});

describe('alignment bridge: availability and first open', () => {
  it('reports alignment available when the runtime is configured, and preview switched off with a reason', async () => {
    const res = await getEditor();
    const caps = res.json().capabilities;
    expect(caps.alignment.available).toBe(true);
    expect(caps.alignment.targetId).toBe('long');
    expect(caps.preview.available).toBe(false);
    expect(caps.preview.reason).toContain('VF_PREVIEW_DISABLE');
  });

  it('opens with the existing narration bound at revision 0 and no history', async () => {
    const res = await getEditor();
    const body = res.json();
    expect(body.document.revision).toBe(0);
    expect(body.undoAvailable).toBe(false);
    const narr = body.document.assets.find((a: { id: string }) => a.id === 'narration');
    expect(narr).toBeDefined();
    expect(narr.sha256).toBe(require_sha(narrationBytes));
    expect(body.document.audioClips.find((c: { sourceAssetId: string }) => c.sourceAssetId === 'narration').approved).toBe(false);
  });

  it('serves the owner import bytes through the narration media route', async () => {
    const state = loadVoiceAudioState(VIDEO_ID);
    const importId = state.externalNarration!.imports.long!.importId;
    const res = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/editor/media/narration/${importId}` });
    expect(res.statusCode).toBe(200);
    expect(require_sha(res.rawPayload)).toBe(require_sha(narrationBytes));
  });

  it('requires sourceAudioId and refuses one that is not the current narration', async () => {
    const missing = await app.inject({ method: 'POST', url: `/api/projects/${VIDEO_ID}/editor/alignment`, payload: { targetId: 'long' } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('EDITOR_BAD_AUDIO');
    const wrong = await app.inject({ method: 'POST', url: `/api/projects/${VIDEO_ID}/editor/alignment`, payload: { targetId: 'long', sourceAudioId: 'img_owner' } });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().code).toBe('ALIGNMENT_SOURCE_MISMATCH');
  });

  it('refuses alignment for a short target instead of guessing its script', async () => {
    const res = await startAlignment(0, 'short_1');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('ALIGNMENT_TARGET_UNSUPPORTED');
  });
});

describe('alignment bridge: proposal lifecycle', () => {
  let before: EditorDoc;
  let jobId: string;
  let proposalId: string;

  it('starts a job without changing the document, then records a proposal', async () => {
    before = await doc();
    const res = await startAlignment(before.revision);
    expect(res.statusCode).toBe(202);
    jobId = res.json().jobId;
    const job = await waitForJob(jobId);
    expect(job.status).toBe('proposed');
    expect(job.proposal.status).toBe('proposed');
    expect(job.proposal.rows.length).toBeGreaterThan(0);
    expect(job.rows.length).toBe(job.proposal.rows.length);
    expect(job.unresolved).toEqual([]);
    proposalId = job.proposalId;
    expect(job.proposal.rows[0].startSec).toBe(0);
    const after = await doc();
    expect(after.revision).toBe(before.revision);
    expect(after.alignment.status).toBe('proposed');
  });

  it('accepts only with reviewed:true, applies captions in one revision, and keeps visual clips', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/editor/alignment/${proposalId}/accept`,
      payload: { targetId: 'long', baseRevision: before.revision, reviewed: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.document.revision).toBe(before.revision + 1);
    expect(body.document.alignment.status).toBe('approved');
    expect(body.undoAvailable).toBe(true);
    expect(body.document.visualClips).toEqual(before.visualClips);
    expect(body.document.captions.map((c: { text: string }) => c.text)).toEqual(before.captions.map((c) => c.text));
  });

  it('undo restores the exact pre-accept captions and a re-accept of the applied proposal is refused', async () => {
    const after = await doc();
    const undo = await app.inject({ method: 'POST', url: `/api/projects/${VIDEO_ID}/editor/undo`, payload: { targetId: 'long', baseRevision: after.revision } });
    expect(undo.statusCode).toBe(200);
    const restored = undo.json().document as EditorDoc;
    expect(restored.captions).toEqual(before.captions);
    const again = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/editor/alignment/${proposalId}/accept`,
      payload: { targetId: 'long', baseRevision: restored.revision, reviewed: true },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('ALIGNMENT_PROPOSAL_NOT_ACCEPTABLE');
  });

  it('a proposal goes stale when the document changes, and nothing is applied', async () => {
    const cur = await doc();
    const res = await startAlignment(cur.revision);
    expect(res.statusCode).toBe(202);
    const job = await waitForJob(res.json().jobId);
    expect(job.status).toBe('proposed');
    const edit = await patchCaption(cur.revision, cur.captions[0].id, 'تعديل بعد الاقتراح');
    expect(edit.statusCode).toBe(200);
    const edited = edit.json().document as EditorDoc;
    const accept = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/editor/alignment/${job.proposalId}/accept`,
      payload: { targetId: 'long', baseRevision: edited.revision, reviewed: true },
    });
    expect(accept.statusCode).toBe(409);
    expect(accept.json().code).toBe('ALIGNMENT_PROPOSAL_STALE');
    expect(accept.json().message).toContain('caption text');
    const after = await doc();
    expect(after.captions[0].text).toBe('تعديل بعد الاقتراح');
    expect(after.alignment.status).toBe('not_requested');
    const job2 = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/editor/alignment/${job.jobId}` });
    expect(job2.json().proposal.status).toBe('stale');
  });

  it('a visual split after the proposal keeps it fresh, and captions land through the narration offset', async () => {
    const cur = await doc();
    const res = await startAlignment(cur.revision);
    expect(res.statusCode).toBe(202);
    const job = await waitForJob(res.json().jobId);
    expect(job.status).toBe('proposed');
    const visual = [...cur.visualClips].sort((a, b) => b.durationSec - a.durationSec)[0];
    const split = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${VIDEO_ID}/editor`,
      payload: {
        targetId: 'long',
        baseRevision: cur.revision,
        operations: [{ type: 'split', collection: 'visualClips', id: visual.id, atSec: visual.startSec + visual.durationSec / 2 }],
      },
    });
    expect(split.statusCode).toBe(200);
    const splitDoc = split.json().document as EditorDoc;
    expect(splitDoc.revision).toBeGreaterThan(cur.revision);
    const accept = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/editor/alignment/${job.proposalId}/accept`,
      payload: { targetId: 'long', baseRevision: splitDoc.revision, reviewed: true },
    });
    expect(accept.statusCode).toBe(200);
    const accepted = accept.json().document as EditorDoc & { audioClips: Array<{ id: string; startSec: number; sourceInSec: number; sourceOutSec: number }> };
    const audio = accepted.audioClips.find((c) => c.id === 'ac_narration')!;
    // The fixture worker spreads the captions evenly over the narration in source time.
    const n = accepted.captions.length;
    const seg = (audio.sourceOutSec - audio.sourceInSec) / n;
    accepted.captions.forEach((cap, i) => {
      const srcStart = Number((i * seg).toFixed(3));
      expect(cap.startSec).toBeCloseTo(audio.startSec + (srcStart - audio.sourceInSec), 2);
    });
    // The split is still there: alignment did not touch visual clips.
    expect(accepted.visualClips.length).toBe(splitDoc.visualClips.length);
  });

  it('a second start while one is running is refused with 409', async () => {
    process.env.VF_FAKE_ALIGN_MODE = 'slow';
    try {
      const cur = await doc();
      const first = await startAlignment(cur.revision);
      expect(first.statusCode).toBe(202);
      const second = await startAlignment(cur.revision);
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('ALIGNMENT_ALREADY_RUNNING');
      await waitForJob(first.json().jobId, 30_000);
    } finally {
      delete process.env.VF_FAKE_ALIGN_MODE;
    }
  });
});

describe('alignment bridge: honest failures change nothing', () => {
  it('a runner that reports unavailable produces no proposal and no document change', async () => {
    const before = await doc();
    process.env.VF_FAKE_ALIGN_MODE = 'unavailable';
    try {
      const res = await startAlignment(before.revision);
      const job = await waitForJob(res.json().jobId);
      expect(job.status).toBe('unavailable');
      expect(job.detail).toContain('unavailable');
      expect(job.proposalId).toBeNull();
      const after = await doc();
      expect(after.revision).toBe(before.revision);
      expect(after.alignment.status).toBe('not_requested');
    } finally {
      delete process.env.VF_FAKE_ALIGN_MODE;
    }
  });

  it('a runner BLOCKER fails the job with that blocker name and changes nothing', async () => {
    const before = await doc();
    process.env.VF_FAKE_ALIGN_MODE = 'blocker';
    try {
      const res = await startAlignment(before.revision);
      const job = await waitForJob(res.json().jobId);
      expect(job.status).toBe('failed');
      expect(job.error).toContain('BLOCKER=fixture_blocker');
      const after = await doc();
      expect(after.revision).toBe(before.revision);
    } finally {
      delete process.env.VF_FAKE_ALIGN_MODE;
    }
  });

  it('a narration file whose bytes changed on disk is refused, not silently dropped', async () => {
    const original = fs.readFileSync(narrationFile());
    fs.writeFileSync(narrationFile(), wavBytes(20, 7));
    try {
      const res = await getEditor();
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('EDITOR_NARRATION_CHANGED');
    } finally {
      fs.writeFileSync(narrationFile(), original);
    }
    expect((await getEditor()).statusCode).toBe(200);
  });
});

describe('narration replacement', () => {
  it('a new import is a new revision with empty history and a new narration sha', async () => {
    const before = await doc();
    narrationBytes = wavBytes(12, 3);
    importNarration(narrationBytes, 'imp_fixture_two');
    const res = await getEditor();
    const body = res.json();
    expect(body.document.revision).toBe(before.revision + 1);
    expect(body.undoAvailable).toBe(false);
    expect(body.redoAvailable).toBe(false);
    const narr = body.document.assets.find((a: { id: string }) => a.id === 'narration');
    expect(narr.sha256).toBe(require_sha(narrationBytes));
    expect(body.document.alignment.status).toBe('not_requested');
  });
});

describe('preview: switched off, and pure range rules', () => {
  it('POST preview is refused with 501 and nothing starts', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${VIDEO_ID}/editor/preview`, payload: { targetId: 'long', baseRevision: 0 } });
    expect(res.statusCode).toBe(501);
    expect(res.json().code).toBe('PREVIEW_UNAVAILABLE');
    expect(previewAvailability().available).toBe(false);
  });

  it('frames are exact for a 5-second range starting at 10 s (exclusive end)', () => {
    const d = { durationSec: 60, revision: 0 } as unknown as Parameters<typeof previewFrames>[0];
    expect(previewFrames(d, { startSec: 10, endSec: 15 })).toEqual({ startFrame: 300, endFrame: 450 });
  });

  it('refuses ranges longer than 30 s, outside the document, or empty', () => {
    const d = { durationSec: 60, revision: 0 } as unknown as Parameters<typeof previewFrames>[0];
    expect(() => previewFrames(d, { startSec: 0, endSec: 31 })).toThrow(/at most 30/);
    expect(() => previewFrames(d, { startSec: 50, endSec: 61 })).toThrow(/ends after/);
    expect(() => previewFrames(d, { startSec: 5, endSec: 5 })).toThrow(/after it starts/);
  });

  it('partial preview offsets: a clip that starts after the range start is delayed, one that started before is read from its own offset', () => {
    const doc = {
      durationSec: 60,
      audioClips: [{ id: 'ac_narration', sourceAssetId: 'narration', startSec: 4, sourceInSec: 2, sourceOutSec: 10, gainDb: 0 }],
    } as unknown as Parameters<typeof audioGraphFor>[0];
    const later = audioGraphFor(doc, { startSec: 0, endSec: 6 });
    expect(later.clipCount).toBe(1);
    expect(later.inputAssetIds).toEqual(['narration']);
    expect(later.filter).toContain('atrim=start=2.000:duration=2.000');
    expect(later.filter).toContain('adelay=4000|4000');
    const mid = audioGraphFor(doc, { startSec: 5, endSec: 9 });
    expect(mid.filter).toContain('atrim=start=3.000:duration=4.000');
    expect(mid.filter).not.toContain('adelay');
    const before = audioGraphFor(doc, { startSec: 0, endSec: 3 });
    expect(before.clipCount).toBe(0);
    expect(before.inputAssetIds).toEqual([]);
  });

  it('every overlapping audio clip is mixed, each with its own offset and gain', () => {
    const doc = {
      durationSec: 60,
      audioClips: [
        { id: 'ac_a', sourceAssetId: 'narration', startSec: 0, sourceInSec: 0, sourceOutSec: 4, gainDb: -6 },
        { id: 'ac_b', sourceAssetId: 'music', startSec: 5, sourceInSec: 1, sourceOutSec: 3, gainDb: 3 },
      ],
    } as unknown as Parameters<typeof audioGraphFor>[0];
    const g = audioGraphFor(doc, { startSec: 0, endSec: 8 });
    expect(g.clipCount).toBe(2);
    expect(g.inputAssetIds).toEqual(['narration', 'music']);
    expect(g.filter).toContain('[1:a]');
    expect(g.filter).toContain('[2:a]');
    expect(g.filter).toContain('volume=-6.00dB');
    expect(g.filter).toContain('volume=3.00dB');
    expect(g.filter).toContain('adelay=5000|5000');
    expect(g.filter).toContain('amerge=inputs=2');
    expect(g.filter).toContain('pan=stereo|c0=c0+c2|c1=c1+c3');
    // A label never follows a comma: ffmpeg would read that as an empty filter name.
    expect(g.filter).not.toMatch(/,\[/);
    expect(g.filter).not.toMatch(/;;|,;|;,/);
    expect(g.filter).not.toContain('amix');
  });
});

describe('legacy project file', () => {
  it('the project record is never rewritten by the alignment bridge', () => {
    const projectJson = JSON.parse(fs.readFileSync(path.join(tmp.data, 'projects', VIDEO_ID, 'project.json'), 'utf8')) as Project;
    expect(projectJson.meta.input.videoId).toBe(VIDEO_ID);
    expect(loadVoiceAudioState(VIDEO_ID).projectId).toBe(VIDEO_ID);
    expect(newVoiceAudioState(VIDEO_ID).projectId).toBe(VIDEO_ID);
  });
});
