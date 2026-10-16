/**
 * Library audio in the editor: two distinct uploaded audio sources are added to
 * the document once each (with their own sha256), resolve through the validated
 * asset path, and are refused when their bytes change or they are blocked.
 * Fixture audio only; no owner recordings are used here.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  delete process.env.VF_ALIGN_COMMAND;
  process.env.VF_PREVIEW_DISABLE = '1';
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'editor-library-audio');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  return { root, data };
});

import { PROJECT_SCHEMA_VERSION, buildStoryboard, emptyHistory, type Project, type ProjectInput, type EditorDocument } from '@buildtrack/core';
import { saveProject } from '../apps/api/src/services/store.js';
import { buildServerApp } from '../apps/api/src/server.js';
import { audioFilesForDocument } from '../apps/api/src/services/editor-preview.js';
import { audioGraphFor } from '../apps/api/src/services/editor-render.js';
import { libraryAudioFile, sha256File } from '../apps/api/src/services/editor-library-audio.js';
import { ASSETS_DIR } from '../apps/api/src/services/platform.js';
import { narrationForTarget, beginAlignment } from '../apps/api/src/services/editor-alignment.js';
import { readEditorState, writeEditorState } from '../apps/api/src/services/editor-store.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

const VIDEO_ID = 'Editor_Library_Audio';
const MUSIC = 'music_bed_a';
const SFX = 'sfx_b';
const NO_DURATION = 'audio_no_duration';
const BLOCKED = 'audio_blocked';

function wavBytes(seconds: number, fill: number): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(seconds * rate * 2, fill);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const shaOf = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

const musicBytes = wavBytes(2, 17);
const sfxBytes = wavBytes(1, 42);

function indexEntries(): Array<Record<string, unknown>> {
  const audio = (id: string, file: string, extra: Record<string, unknown> = {}) => ({
    id, name: id, kind: 'broll', fileName: file, path: `assets/${file}`, mimeType: 'audio/wav',
    status: 'active', source: 'fixture', license: 'fixture', blocked: false, durationSec: 2, tags: [], ...extra,
  });
  return [
    { id: 'img_owner', name: 'Owner still', kind: 'screenshot', fileName: 'owner.png', path: 'assets/owner.png', mimeType: 'image/png', status: 'active', source: 'owner', license: 'owner', blocked: false, durationSec: null, tags: [] },
    audio(MUSIC, `${MUSIC}.wav`),
    audio(SFX, `${SFX}.wav`, { durationSec: 1 }),
    audio(NO_DURATION, 'no_duration.wav', { durationSec: null }),
    audio(BLOCKED, 'blocked.wav', { blocked: true }),
  ];
}

function writeIndex(entries: Array<Record<string, unknown>> = indexEntries()) {
  fs.writeFileSync(path.join(tmp.data, 'assets', 'index.json'), JSON.stringify(entries), 'utf8');
}

function projectInput(): ProjectInput {
  return {
    videoId: VIDEO_ID, videoType: 'long', topic: 'Library audio', targetAudience: 'Site managers',
    mainProblem: 'Unsafe habits', viewerPromise: 'Practical safety', hook: 'Are your teams protected?',
    script: 'يَا أَيُّهَا الَّذِينَ آمَنُوا', keyNumbers: ['100%'], keyPoints: ['Hard hats'], productName: 'Kit', productShots: [],
    cta: 'Book your audit', voiceoverFile: null, targetAudio: {}, brollFiles: [], sourceReferences: [],
    outputLanguage: 'ar', brandPreset: 'safety_first', shortCount: 1,
  };
}

function buildProject(): Project {
  const input = projectInput();
  const sb = buildStoryboard({ input, history: emptyHistory(), audioDuration: 60 });
  const { historyEntry: _h, ...storyboard } = sb;
  const now = new Date().toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    meta: { input, brand: sb.brand, createdAt: now, updatedAt: now, status: 'storyboarded' },
    storyboard,
    artifacts: [],
    qc: [],
  } as Project;
}

async function getDoc(): Promise<{ document: EditorDocument; revision: number }> {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/editor?targetId=long` });
  expect(res.statusCode).toBe(200);
  return { document: res.json().document as EditorDocument, revision: res.json().document.revision };
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp.data, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(tmp.data, 'assets', `${MUSIC}.wav`), musicBytes);
  fs.writeFileSync(path.join(tmp.data, 'assets', `${SFX}.wav`), sfxBytes);
  fs.writeFileSync(path.join(tmp.data, 'assets', 'no_duration.wav'), wavBytes(1, 9));
  fs.writeFileSync(path.join(tmp.data, 'assets', 'blocked.wav'), wavBytes(1, 9));
  writeIndex();
  saveProject(buildProject());
  app = await buildServerApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('library audio: add once, with a sha256, and only when eligible', () => {
  it('adds the two distinct eligible audio sources with their own sha256, and no others', async () => {
    const { document } = await getDoc();
    const audio = document.assets.filter((a) => a.kind === 'audio');
    expect(audio.map((a) => a.id).sort()).toEqual([MUSIC, SFX].sort());
    expect(audio.find((a) => a.id === MUSIC)!.sha256).toBe(shaOf(musicBytes));
    expect(audio.find((a) => a.id === SFX)!.sha256).toBe(shaOf(sfxBytes));
    expect(audio.find((a) => a.id === MUSIC)!.sha256).not.toBe(audio.find((a) => a.id === SFX)!.sha256);
  });

  it('does not add the same audio again, and does not change the revision on a plain read', async () => {
    const first = await getDoc();
    const second = await getDoc();
    expect(second.revision).toBe(first.revision);
    expect(second.document.assets.filter((a) => a.kind === 'audio')).toHaveLength(2);
  });
});

describe('library audio: two independent sources in one document', () => {
  let doc: EditorDocument;
  let revision: number;

  beforeAll(async () => {
    ({ document: doc, revision } = await getDoc());
  });

  it('inserts a music bed and a sound effect as separate audio clips', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${VIDEO_ID}/editor`,
      payload: {
        targetId: 'long',
        baseRevision: revision,
        operations: [
          { type: 'insert', collection: 'audioClips', item: { id: 'ac_music', sourceAssetId: MUSIC, speakerId: null, startSec: 0, sourceInSec: 0, sourceOutSec: 2, gainDb: -12, locked: false, approved: false } },
          { type: 'insert', collection: 'audioClips', item: { id: 'ac_sfx', sourceAssetId: SFX, speakerId: null, startSec: 0.5, sourceInSec: 0, sourceOutSec: 1, gainDb: -6, locked: false, approved: false } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    doc = res.json().document as EditorDocument;
    expect(new Set(doc.audioClips.map((c) => c.sourceAssetId))).toEqual(new Set([MUSIC, SFX]));
  });

  it('resolves each source to its own file under the assets folder, checked against its sha256', () => {
    const index = indexEntries();
    const files = audioFilesForDocument(VIDEO_ID, 'long', doc, index as unknown as Array<Record<string, unknown>>);
    expect(Object.keys(files).sort()).toEqual([MUSIC, SFX].sort());
    expect(files[MUSIC]).toBe(path.join(ASSETS_DIR, `${MUSIC}.wav`));
    expect(files[SFX]).toBe(path.join(ASSETS_DIR, `${SFX}.wav`));
    expect(sha256File(files[MUSIC])).toBe(shaOf(musicBytes));
  });

  it('mixes both sources as two inputs in the preview graph', () => {
    const graph = audioGraphFor(doc, { startSec: 0, endSec: 2 });
    expect(graph.clipCount).toBe(2);
    expect(graph.inputAssetIds.sort()).toEqual([MUSIC, SFX].sort());
  });

  it('refuses a source whose bytes changed after it was added, with 409 and no file', () => {
    const file = path.join(ASSETS_DIR, `${SFX}.wav`);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, wavBytes(1, 99));
    try {
      expect(() => audioFilesForDocument(VIDEO_ID, 'long', doc, indexEntries() as unknown as Array<Record<string, unknown>>))
        .toThrow(expect.objectContaining({ code: 'EDITOR_AUDIO_CHANGED', status: 409 }));
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  it('refuses a source that is blocked in the library now', () => {
    const entries = indexEntries().map((a) => (a.id === SFX ? { ...a, blocked: true } : a));
    expect(() => audioFilesForDocument(VIDEO_ID, 'long', doc, entries as unknown as Array<Record<string, unknown>>))
      .toThrow(expect.objectContaining({ code: 'EDITOR_AUDIO_UNAVAILABLE' }));
  });
});

describe('library audio: file resolution stays inside the assets folder', () => {
  it('uses only the basename of the index path', () => {
    expect(libraryAudioFile({ path: `assets/${MUSIC}.wav` })).toBe(path.join(ASSETS_DIR, `${MUSIC}.wav`));
    expect(libraryAudioFile({ path: '../../../../etc/passwd' })).toBeNull();
    expect(libraryAudioFile({ path: `assets/missing-${SFX}.wav` })).toBeNull();
    expect(libraryAudioFile({})).toBeNull();
  });

  it('never adds an audio asset without a duration', async () => {
    const { document } = await getDoc();
    expect(document.assets.some((a) => a.id === NO_DURATION || a.id === BLOCKED)).toBe(false);
  });
});

describe('library audio: document guards', () => {
  it('refuses an audio clip that points at a non-audio or unknown asset', async () => {
    const { revision } = await getDoc();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${VIDEO_ID}/editor`,
      payload: {
        targetId: 'long',
        baseRevision: revision,
        operations: [{ type: 'insert', collection: 'audioClips', item: { id: 'ac_bad', sourceAssetId: 'img_owner', speakerId: null, startSec: 0, sourceInSec: 0, sourceOutSec: 1, gainDb: 0, locked: false, approved: false } }],
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe('one supplied library narration can align without a second audio track', () => {
  it('resolves the recorded bytes and builds private runner inputs without importing or duplicating audio', async () => {
    writeIndex();
    fs.writeFileSync(path.join(ASSETS_DIR, `${MUSIC}.wav`), musicBytes);
    await getDoc();
    const state = readEditorState(VIDEO_ID, 'long')!;
    state.document.audioClips = [{id:'ac_supplied',sourceAssetId:MUSIC,speakerId:null,startSec:0,sourceInSec:0,sourceOutSec:2,gainDb:0,locked:false,approved:false}];
    writeEditorState(VIDEO_ID,'long',state);
    const binding = narrationForTarget(VIDEO_ID,'long')!;
    expect(binding.importId).toBe('library:'+MUSIC);
    expect(binding.sha256).toBe(shaOf(musicBytes));
    const job = beginAlignment(VIDEO_ID,'long',state,binding,{available:true,reviewRoot:path.join(tmp.root,'alignment')} as any);
    expect(job.libraryWavFile).toBe(path.join(ASSETS_DIR,`${MUSIC}.wav`));
    expect(JSON.parse(fs.readFileSync(job.libraryStateFile!,'utf8')).externalNarration.imports.long.scriptText).toBeTruthy();
    expect(readEditorState(VIDEO_ID,'long')!.document.audioClips).toHaveLength(1);
    fs.writeFileSync(path.join(ASSETS_DIR, `${MUSIC}.wav`), wavBytes(2,99));
    expect(narrationForTarget(VIDEO_ID,'long')).toBeNull();
    fs.writeFileSync(path.join(ASSETS_DIR, `${MUSIC}.wav`), musicBytes);
  });
  it('does not guess the spoken source among two audio tracks', () => {
    const state = readEditorState(VIDEO_ID,'long')!;
    state.document.audioClips.push({...state.document.audioClips[0],id:'another_voice',sourceAssetId:SFX,sourceOutSec:1});
    writeEditorState(VIDEO_ID,'long',state);
    expect(narrationForTarget(VIDEO_ID,'long')).toBeNull();
  });
});
