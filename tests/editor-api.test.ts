/**
 * Milestone 1 editor API — EDITOR_CONTRACT_V1, backend side.
 *
 * Exercises the REAL registered routes on the REAL server app (`buildServerApp`)
 * against a project saved through the ordinary store. Fixture only: the owner's
 * recording is NOT used here, and passing these tests is not acceptance.
 *
 * Alignment and preview are checked as honest blockers (503 / 501), not as
 * working features. All state lives under the Git-ignored
 * `.stills/test-isolation/` tree, never under the real `data/` directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'editor-api-suite');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
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

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

const VIDEO_ID = 'Editor_Api_Fixture';
const ARABIC_SCRIPT =
  'يَا أَيُّهَا الَّذِينَ آمَنُوا اتَّقُوا اللَّهَ حَقَّ تُقَاتِهِ. ' +
  'وَاعْتَصِمُوا بِحَبْلِ اللَّهِ جَمِيعًا وَلَا تَفَرَّقُوا. ' +
  'وَاذْكُرُوا نِعْمَةَ اللَّهِ عَلَيْكُمْ إِذْ كُنْتُمْ أَعْدَاءً فَأَلَّفَ بَيْنَ قُلُوبِكُمْ.';
const EDITED_ARABIC = 'مَرْحَبًا بِكُمْ فِي الْبِنَاءِ الْآمِنِ';

const projectFilePath = () => path.join(tmp.data, 'projects', VIDEO_ID, 'project.json');
const editorDirPath = () => path.join(tmp.data, 'projects', VIDEO_ID, 'editor');
const lockPath = () => path.join(editorDirPath(), '.lock');

function projectInput(): ProjectInput {
  return {
    videoId: VIDEO_ID,
    videoType: 'long',
    topic: 'Safe Building Practice',
    targetAudience: 'Site managers',
    mainProblem: 'Unsafe habits',
    viewerPromise: 'Practical safety',
    hook: 'Are your teams protected?',
    script: ARABIC_SCRIPT,
    keyNumbers: ['100% compliance'],
    keyPoints: ['Hard hats'],
    productName: 'Kit',
    productShots: [],
    cta: 'Book your audit',
    voiceoverFile: null,
    targetAudio: {},
    brollFiles: [],
    sourceReferences: [],
    outputLanguage: 'ar',
    brandPreset: 'safety_first',
    shortCount: 1,
  };
}

/** Owner asset index: one still and one video, both owner-sourced and licensed. */
function writeAssetIndex() {
  const assets = [
    { id: 'img_owner', name: 'Owner still', mimeType: 'image/png', status: 'active', source: 'owner', license: 'owner', blocked: false, durationSec: null },
    { id: 'vid_owner', name: 'Owner footage', mimeType: 'video/mp4', status: 'active', source: 'owner', license: 'owner', blocked: false, durationSec: 120 },
  ];
  fs.mkdirSync(path.join(tmp.data, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(tmp.data, 'assets', 'index.json'), JSON.stringify(assets), 'utf8');
}

function createProject(): Project {
  const input = projectInput();
  const sb = buildStoryboard({ input, history: emptyHistory(), audioDuration: 60 });
  const { historyEntry: _h, ...storyboard } = sb;
  const scenes = storyboard.long?.scenes ?? [];
  // Give the first scene an owner still and the second scene owner footage, so
  // the video clip starts after composition time zero.
  if (scenes[0]) (scenes[0] as unknown as { assetIds: string[] }).assetIds = ['img_owner'];
  if (scenes[1]) (scenes[1] as unknown as { assetIds: string[] }).assetIds = ['vid_owner'];
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

interface EditorDoc {
  revision: number;
  targetId: string;
  visualClips: Array<{ id: string; startSec: number; durationSec: number; sourceAssetId: string | null; sourceInSec: number | null; sourceOutSec: number | null; locked: boolean }>;
  captions: Array<{ id: string; text: string; direction: string }>;
  audioClips: unknown[];
  highlights: unknown[];
  [k: string]: unknown;
}
interface EnvelopeBody {
  document: EditorDoc;
  undoAvailable: boolean;
  redoAvailable: boolean;
  capabilities: Record<string, any>;
}

async function getEditor(): Promise<EnvelopeBody> {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/editor?targetId=long` });
  expect(res.statusCode).toBe(200);
  return res.json() as EnvelopeBody;
}

async function patch(baseRevision: number, operations: unknown[]) {
  return app.inject({
    method: 'PATCH',
    url: `/api/projects/${VIDEO_ID}/editor`,
    payload: { targetId: 'long', baseRevision, operations },
  });
}

/** Document without the revision, for content comparison across revisions. */
const content = (d: EditorDoc) => {
  const { revision: _r, ...rest } = d;
  return rest;
};

let legacyBytesAtStart: Buffer;

beforeAll(async () => {
  createProject();
  writeAssetIndex();
  legacyBytesAtStart = fs.readFileSync(projectFilePath());
  app = await buildServerApp();
  await app.ready();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  try {
    fs.rmSync(tmp.root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('editor: open and derivation', () => {
  it('opens a legacy project at revision 0 with the full envelope', async () => {
    const body = await getEditor();
    expect(body.document.revision).toBe(0);
    expect(body.document.targetId).toBe('long');
    expect(body.undoAvailable).toBe(false);
    expect(body.redoAvailable).toBe(false);
    expect(body.capabilities.transitions).toEqual({ cut: true, dissolve: false, fade: false });
  });

  it('derives a video clip starting after time zero with source offset zero', async () => {
    const body = await getEditor();
    const video = body.document.visualClips.find((c) => c.sourceAssetId === 'vid_owner');
    expect(video).toBeDefined();
    expect(video!.startSec).toBeGreaterThan(0);
    expect(video!.sourceInSec).toBe(0);
    expect(video!.sourceOutSec).toBeCloseTo(video!.durationSec, 6);
  });

  it('keeps the Arabic caption text exactly as the legacy project stores it', async () => {
    const legacy = JSON.parse(fs.readFileSync(projectFilePath(), 'utf8')) as Project;
    const legacyTexts = (legacy.storyboard.captions ?? []).map((c) => c.text);
    expect(legacyTexts.length).toBeGreaterThan(0);
    const body = await getEditor();
    expect(body.document.captions.length).toBe(legacyTexts.length);
    for (const cap of body.document.captions) {
      expect(cap.direction).toBe('rtl');
      expect(legacyTexts).toContain(cap.text);
    }
  });

  it('rejects an unknown targetId and a non-integer baseRevision', async () => {
    const bad = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/editor?targetId=nope` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('EDITOR_BAD_TARGET');
    const badRev = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${VIDEO_ID}/editor`,
      payload: { targetId: 'long', baseRevision: 'zero', operations: [] },
    });
    expect(badRev.statusCode).toBe(400);
    expect(badRev.json().code).toBe('EDITOR_BAD_REVISION');
  });

  it('refuses a missing project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/Does_Not_Exist/editor?targetId=long' });
    expect(res.statusCode).toBe(404);
  });
});

describe('editor: commits, revisions and reopen parity', () => {
  let afterCaption: EditorDoc;
  let afterSplit: EditorDoc;
  let revision0: EditorDoc;

  it('commits a caption text change that keeps Arabic diacritics byte-for-byte', async () => {
    const before = await getEditor();
    revision0 = before.document;
    const cap = before.document.captions[0];
    const res = await patch(0, [{ type: 'update', collection: 'captions', id: cap.id, changes: { text: EDITED_ARABIC } }]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as EnvelopeBody;
    expect(body.document.revision).toBe(1);
    expect(body.undoAvailable).toBe(true);
    expect(body.document.captions.find((c) => c.id === cap.id)!.text).toBe(EDITED_ARABIC);
    afterCaption = body.document;
  });

  it('reopens to the same document that the save returned (save/reopen parity)', async () => {
    const reopened = await getEditor();
    expect(reopened.document).toEqual(afterCaption);
  });

  it('returns 409 REVISION_CONFLICT with the current revision for a stale baseRevision', async () => {
    const res = await patch(0, [{ type: 'update', collection: 'captions', id: revision0.captions[0].id, changes: { text: 'stale' } }]);
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe('REVISION_CONFLICT');
    expect(body.currentRevision).toBe(1);
    expect(typeof body.message).toBe('string');
    const reopened = await getEditor();
    expect(reopened.document.captions[0].text).toBe(EDITED_ARABIC);
  });

  it('splits a video clip after time zero and keeps the source continuous across the cut', async () => {
    const doc = (await getEditor()).document;
    const video = doc.visualClips.find((c) => c.sourceAssetId === 'vid_owner')!;
    const res = await patch(1, [{ type: 'split', collection: 'visualClips', id: video.id, atSec: video.startSec + 2 }]);
    expect(res.statusCode).toBe(200);
    const next = (res.json() as EnvelopeBody).document;
    afterSplit = next;
    const idx = next.visualClips.findIndex((c) => c.id === video.id);
    const a = next.visualClips[idx];
    const b = next.visualClips[idx + 1];
    expect(a.startSec).toBe(video.startSec);
    expect(a.sourceInSec).toBe(0);
    expect(a.sourceOutSec).toBeCloseTo(2, 6);
    expect(b.sourceAssetId).toBe('vid_owner');
    expect(b.startSec).toBeCloseTo(video.startSec + 2, 6);
    // Source offset is the position inside the owner's footage, not the composition time.
    expect(b.sourceInSec).toBeCloseTo(2, 6);
    expect(b.sourceOutSec).toBeCloseTo(video.durationSec, 6);
    expect(next.visualClips.reduce((s, c) => s + c.durationSec, 0)).toBeCloseTo(video.durationSec + doc.visualClips.filter((c) => c.id !== video.id).reduce((s, c) => s + c.durationSec, 0), 6);
  });

  it('keeps the Arabic caption text after the split', async () => {
    const reopened = await getEditor();
    expect(reopened.document.captions.find((c) => c.text === EDITED_ARABIC)).toBeDefined();
  });

  it('undoes whole transactions and redoes them, restoring exact content', async () => {
    const u1 = await app.inject({ method: 'POST', url: `/api/projects/${VIDEO_ID}/editor/undo`, payload: { targetId: 'long', baseRevision: 2 } });
    expect(u1.statusCode).toBe(200);
    const d3 = (u1.json() as EnvelopeBody).document;
    expect(d3.revision).toBe(3);
    expect(content(d3)).toEqual(content(afterCaption));

    const u2 = await app.inject({ method: 'POST', url: `/api/projects/${VIDEO_ID}/editor/undo`, payload: { targetId: 'long', baseRevision: 3 } });
    expect(u2.statusCode).toBe(200);
    const body2 = u2.json() as EnvelopeBody;
    expect(body2.document.revision).toBe(4);
    expect(content(body2.document)).toEqual(content(revision0));
    expect(body2.undoAvailable).toBe(false);
    expect(body2.redoAvailable).toBe(true);

    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${VIDEO_ID}/editor/redo`, payload: { targetId: 'long', baseRevision: 4 } });
    expect(r1.statusCode).toBe(200);
    expect(content((r1.json() as EnvelopeBody).document)).toEqual(content(afterCaption));
  });

  it('clears redo on any new commit', async () => {
    const r1 = await getEditor();
    // Redo still holds the split snapshot after the redo above; a fresh commit must clear it.
    expect(r1.redoAvailable).toBe(true);
    const cap = r1.document.captions[0];
    const res = await patch(r1.document.revision, [{ type: 'update', collection: 'captions', id: cap.id, changes: { text: 'مرحبا' } }]);
    expect(res.statusCode).toBe(200);
    expect((res.json() as EnvelopeBody).redoAvailable).toBe(false);
    const redo = await app.inject({ method: 'POST', url: `/api/projects/${VIDEO_ID}/editor/redo`, payload: { targetId: 'long', baseRevision: (res.json() as EnvelopeBody).document.revision } });
    expect(redo.statusCode).toBe(409);
    expect(redo.json().code).toBe('EDITOR_NOTHING_TO_REDO');
    void afterSplit;
  });

  it('refuses an operation list that is not a non-empty array', async () => {
    const r = await getEditor();
    const res = await patch(r.document.revision, []);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('EDITOR_INVALID_CHANGE');
  });
});

describe('editor: locks and storage failure', () => {
  it('returns 423 EDITOR_LOCKED while another writer holds a fresh lock, and changes nothing', async () => {
    const before = await getEditor();
    fs.mkdirSync(editorDirPath(), { recursive: true });
    fs.writeFileSync(lockPath(), 'other-writer\n');
    try {
      const res = await patch(before.document.revision, [{ type: 'update', collection: 'captions', id: before.document.captions[0].id, changes: { text: 'locked-out' } }]);
      expect(res.statusCode).toBe(423);
      expect(res.json().code).toBe('EDITOR_LOCKED');
    } finally {
      fs.rmSync(lockPath(), { force: true });
    }
    const after = await getEditor();
    expect(after.document).toEqual(before.document);
  });

  it('takes over a stale lock left by a crashed writer', async () => {
    const before = await getEditor();
    fs.mkdirSync(editorDirPath(), { recursive: true });
    fs.writeFileSync(lockPath(), 'crashed-writer\n');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath(), old, old);
    const res = await patch(before.document.revision, [{ type: 'update', collection: 'captions', id: before.document.captions[0].id, changes: { text: EDITED_ARABIC } }]);
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('reports EDITOR_STORAGE_FAILED, keeps the last saved revision, and leaves no temp file behind', async () => {
    const before = await getEditor();
    const cap = before.document.captions[0];
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated disk failure');
    });
    try {
      const res = await patch(before.document.revision, [{ type: 'update', collection: 'captions', id: cap.id, changes: { text: 'never-saved' } }]);
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe('EDITOR_STORAGE_FAILED');
    } finally {
      spy.mockRestore();
    }
    const after = await getEditor();
    expect(after.document.revision).toBe(before.document.revision);
    expect(after.document.captions[0].text).toBe(EDITED_ARABIC);
    const leftovers = fs.readdirSync(editorDirPath()).filter((f) => f.endsWith('.tmp') || f === '.lock');
    expect(leftovers).toEqual([]);
  });
});

describe('editor: capability blockers are honest', () => {
  it('reports alignment and preview unavailable with reasons, and dissolve/fade unavailable', async () => {
    const body = await getEditor();
    expect(body.capabilities.alignment.available).toBe(false);
    expect(typeof body.capabilities.alignment.reason).toBe('string');
    expect(body.capabilities.preview.available).toBe(false);
    expect(typeof body.capabilities.preview.reason).toBe('string');
    expect(body.capabilities.transitions.dissolve).toBe(false);
    expect(body.capabilities.transitions.fade).toBe(false);
  });

  it('alignment start returns 503 ALIGNMENT_RUNTIME_UNAVAILABLE and creates no job', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/editor/alignment`,
      payload: { targetId: 'long', sourceAudioId: 'nar_none' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('ALIGNMENT_RUNTIME_UNAVAILABLE');
  });

  it('alignment job lookup returns 404 and never a fake job', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/editor/alignment/job_1` });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ALIGNMENT_JOB_NOT_FOUND');
  });

  it('accepting a proposal without reviewed:true is refused; with it, nothing is applied', async () => {
    const before = await getEditor();
    const noReview = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/editor/alignment/prop_1/accept`,
      payload: { targetId: 'long', baseRevision: before.document.revision },
    });
    expect(noReview.statusCode).toBe(400);
    expect(noReview.json().code).toBe('EDITOR_REVIEW_REQUIRED');

    const reviewed = await app.inject({
      method: 'POST',
      url: `/api/projects/${VIDEO_ID}/editor/alignment/prop_1/accept`,
      payload: { targetId: 'long', baseRevision: before.document.revision, reviewed: true },
    });
    expect(reviewed.statusCode).toBe(404);
    expect(reviewed.json().code).toBe('ALIGNMENT_PROPOSAL_NOT_FOUND');
    const after = await getEditor();
    expect(after.document).toEqual(before.document);
  });

  it('preview start returns 501 PREVIEW_UNAVAILABLE and preview lookup returns 404', async () => {
    const start = await app.inject({ method: 'POST', url: `/api/projects/${VIDEO_ID}/editor/preview`, payload: { targetId: 'long' } });
    expect(start.statusCode).toBe(501);
    expect(start.json().code).toBe('PREVIEW_UNAVAILABLE');
    const look = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/editor/preview/prev_1` });
    expect(look.statusCode).toBe(404);
  });
});

describe('legacy project file', () => {
  it('is byte-for-byte unchanged by every editor request in this suite', () => {
    expect(fs.readFileSync(projectFilePath()).equals(legacyBytesAtStart)).toBe(true);
  });
});
