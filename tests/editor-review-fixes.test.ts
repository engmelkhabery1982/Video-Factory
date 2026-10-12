/**
 * Regressions for the independent-review blockers (milestone 1 backend).
 *
 * Route checks run on the REAL server app against an isolated fixture tree under
 * `.stills/test-isolation/editor-review-suite/` (never `data/`). Pure checks run
 * on core and the alignment snapshot. Fixture success is not acceptance.
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
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'editor-review-suite');
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
  deriveEditorDocument,
  editorDocumentToRenderPlan,
  mergeLibraryAssets,
  applyEditorOperations,
  alignmentIdentityPayload,
  alignmentUnits,
  narrationMappingOf,
  applyAlignmentRows,
  reconcileNarration,
  validateAlignmentRows,
  type EditorDocument,
  type NarrationBinding,
  type Project,
  type ProjectInput,
} from '@buildtrack/core';
import { saveProject } from '../apps/api/src/services/store.js';
import { buildServerApp } from '../apps/api/src/server.js';
import { loadVoiceAudioState, saveVoiceAudioState } from '../apps/api/src/services/voice-audio-state.js';
import { buildAlignmentSnapshot } from '../apps/api/src/services/editor-alignment.js';
import { parseSingleByteRange } from '../apps/api/src/services/byte-range.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

const VIDEO_ID = 'Editor_Review_Fixture';
const ARABIC = 'يَا أَيُّهَا الَّذِينَ آمَنُوا اتَّقُوا اللَّهَ. وَاعْتَصِمُوا بِحَبْلِ اللَّهِ جَمِيعًا.';
const IMPORT_ID = 'imp_review_1';
const SHA_NOTHING = 'f'.repeat(64);

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
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const narrationBytes = wavBytes(20, 3);
const narrationFile = () => path.join(tmp.data, 'voiceover', 'owner_review_narration.wav');

function projectInput(): ProjectInput {
  return {
    videoId: VIDEO_ID, videoType: 'long', topic: 'Safe Building Practice', targetAudience: 'Site managers',
    mainProblem: 'Unsafe habits', viewerPromise: 'Practical safety', hook: 'Are your teams protected?',
    script: ARABIC, keyNumbers: ['100%'], keyPoints: ['Hard hats'], productName: 'Kit', productShots: [],
    cta: 'Book your audit', voiceoverFile: null, targetAudio: {}, brollFiles: [], sourceReferences: [],
    outputLanguage: 'ar', brandPreset: 'safety_first', shortCount: 1,
  };
}

function buildProject(): Project {
  const input = projectInput();
  const sb = buildStoryboard({ input, history: emptyHistory(), audioDuration: 60 });
  const { historyEntry: _h, ...storyboard } = sb;
  const scenes = storyboard.long?.scenes ?? [];
  if (scenes[0]) (scenes[0] as unknown as { assetIds: string[] }).assetIds = ['img_owner'];
  const now = new Date().toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    meta: { input, brand: sb.brand, createdAt: now, updatedAt: now, status: 'storyboarded' },
    storyboard,
    artifacts: [],
    qc: [],
  } as Project;
}

function writeAssetIndex(extra: Array<Record<string, unknown>> = []) {
  fs.mkdirSync(path.join(tmp.data, 'assets'), { recursive: true });
  const base = [
    { id: 'img_owner', name: 'Owner still', mimeType: 'image/png', status: 'active', source: 'owner', license: 'owner', blocked: false, durationSec: null },
  ];
  fs.writeFileSync(path.join(tmp.data, 'assets', 'index.json'), JSON.stringify([...base, ...extra]), 'utf8');
}

/** Import narration as the owner's existing route records it, with the given listening decision. */
function importNarration(approved: boolean | null) {
  fs.mkdirSync(path.join(tmp.data, 'voiceover'), { recursive: true });
  fs.writeFileSync(narrationFile(), narrationBytes);
  const digest = sha(narrationBytes);
  const state = loadVoiceAudioState(VIDEO_ID);
  const ext = state.externalNarration ?? { imports: {}, approvals: {}, dialogueImports: [] };
  ext.imports.long = {
    importId: IMPORT_ID, projectId: VIDEO_ID, targetId: 'long', fileName: 'owner_review_narration.wav',
    storedRef: 'voiceover/owner_review_narration.wav', mimeType: 'audio/wav', byteSize: narrationBytes.length,
    sha256: digest, durationSec: (narrationBytes.length - 44) / 16000, durationSource: 'ffprobe',
    scriptText: ARABIC, scriptSha256: 'a'.repeat(64),
    declaration: { sourceKind: 'own_recording', ownershipConfirmed: true, ownershipStatement: 'fixture', speakerName: 'Owner' },
    alignment: {}, createdAt: new Date().toISOString(),
  } as unknown as NonNullable<typeof ext.imports.long>;
  ext.approvals = approved === null
    ? {}
    : { long: { decision: approved ? 'approved' : 'rejected', importId: IMPORT_ID, artifactSha256: digest } as never };
  saveVoiceAudioState({ ...state, externalNarration: ext });
}

interface EnvelopeBody {
  document: EditorDocument;
  undoAvailable: boolean;
  redoAvailable: boolean;
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

const audioOf = (doc: EditorDocument) => doc.audioClips.find((c) => c.id === 'ac_narration')!;

beforeAll(async () => {
  saveProject(buildProject());
  writeAssetIndex();
  app = await buildServerApp();
});

afterAll(async () => {
  await app?.close();
});

describe('blocker 1: narration trim keeps its invalidation across GET, save and reopen', () => {
  it('a trimmed approved clip stays unapproved; a later project-side decision still applies', async () => {
    importNarration(true);
    const first = await getEditor();
    expect(audioOf(first.document).approved).toBe(true);
    const r0 = first.document.revision;

    const trimmed = await patch(r0, [{ type: 'update', collection: 'audioClips', id: 'ac_narration', changes: { sourceInSec: 1 } }]);
    expect(trimmed.statusCode).toBe(200);
    const afterTrim = trimmed.json() as EnvelopeBody;
    expect(audioOf(afterTrim.document).approved).toBe(false);
    expect(afterTrim.document.revision).toBe(r0 + 1);

    // GET must not restore approval, bump the revision, or clear undo.
    const readBack = await getEditor();
    expect(audioOf(readBack.document).approved).toBe(false);
    expect(readBack.document.revision).toBe(r0 + 1);
    expect(readBack.undoAvailable).toBe(true);
    const again = await getEditor();
    expect(again.document.revision).toBe(r0 + 1);

    // Reopen: a fresh app instance reads the same files from disk.
    await app.close();
    app = await buildServerApp();
    const reopened = await getEditor();
    expect(audioOf(reopened.document).approved).toBe(false);
    expect(reopened.document.revision).toBe(r0 + 1);
    expect(reopened.undoAvailable).toBe(true);

    // The owner withdraws approval: that project-side change does apply.
    importNarration(false);
    const withdrawn = await getEditor();
    expect(audioOf(withdrawn.document).approved).toBe(false);
    expect(withdrawn.document.revision).toBe(r0 + 2);
    expect(withdrawn.undoAvailable).toBe(false);
  });
});

describe('blocker 2: library assets uploaded after init are assignable', () => {
  it('an active unused image added after the editor opened can be assigned to a clip', async () => {
    const before = await getEditor();
    expect(before.document.assets.some((a) => a.id === 'img_late')).toBe(false);
    writeAssetIndex([
      { id: 'img_late', name: 'Late still', mimeType: 'image/png', status: 'active', source: 'owner', license: 'owner', blocked: false, durationSec: null },
      { id: 'img_blocked', name: 'Blocked still', mimeType: 'image/png', status: 'active', source: 'owner', license: 'owner', blocked: true, durationSec: null },
    ]);
    const synced = await getEditor();
    expect(synced.document.assets.some((a) => a.id === 'img_late')).toBe(true);
    expect(synced.document.assets.some((a) => a.id === 'img_blocked')).toBe(false);
    expect(synced.document.revision).toBe(before.document.revision + 1);

    const scene0 = synced.document.visualClips[0];
    const assign = await patch(synced.document.revision, [
      { type: 'update', collection: 'visualClips', id: scene0.id, changes: { sourceAssetId: 'img_late' } },
    ]);
    expect(assign.statusCode).toBe(200);
    expect((assign.json() as EnvelopeBody).document.visualClips[0].sourceAssetId).toBe('img_late');
  });

  it('an ineligible (blocked) asset is still refused by the assignment', async () => {
    const env = await getEditor();
    const scene0 = env.document.visualClips[0];
    const res = await patch(env.document.revision, [
      { type: 'update', collection: 'visualClips', id: scene0.id, changes: { sourceAssetId: 'img_blocked' } },
    ]);
    expect(res.statusCode).toBe(422);
  });
});

describe('blocker 3: HTTP Range on narration media', () => {
  const url = () => `/api/projects/${VIDEO_ID}/editor/media/narration/${IMPORT_ID}`;

  it('a bounded range returns 206 with exactly those bytes', async () => {
    importNarration(true);
    const res = await app.inject({ method: 'GET', url: url(), headers: { range: 'bytes=0-43' } });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-43/${narrationBytes.length}`);
    expect(res.headers['content-length']).toBe('44');
    expect(Buffer.compare(res.rawPayload, narrationBytes.subarray(0, 44))).toBe(0);
  });

  it('a suffix range and an open range return the right slice', async () => {
    const tail = await app.inject({ method: 'GET', url: url(), headers: { range: 'bytes=-10' } });
    expect(tail.statusCode).toBe(206);
    expect(Buffer.compare(tail.rawPayload, narrationBytes.subarray(narrationBytes.length - 10))).toBe(0);
    const open = await app.inject({ method: 'GET', url: url(), headers: { range: `bytes=${narrationBytes.length - 5}-` } });
    expect(open.statusCode).toBe(206);
    expect(open.rawPayload.length).toBe(5);
  });

  it('a start past the end is 416; no header is the full 200 file', async () => {
    const bad = await app.inject({ method: 'GET', url: url(), headers: { range: `bytes=${narrationBytes.length + 10}-` } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${narrationBytes.length}`);
    const full = await app.inject({ method: 'GET', url: url() });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.length).toBe(narrationBytes.length);
    expect(full.headers['accept-ranges']).toBe('bytes');
  });

  it('access checks still apply: an unknown import is 404 even with a valid range', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/editor/media/narration/imp_nope_9`, headers: { range: 'bytes=0-9' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('blocker 4: alignment input is the editor snapshot, and identity hashes the same units', () => {
  it('the snapshot scenes are the caption units, keyed by caption id, and the identity covers them', () => {
    const doc = deriveEditorDocument({ project: buildProject(), targetId: 'long' });
    const built = buildAlignmentSnapshot(doc, 'long');
    const scenes = (built.snapshot.storyboard as { long: { scenes: Array<{ id: string; narration: string }> } }).long.scenes;
    const units = alignmentUnits(doc);
    expect(scenes.map((s) => s.id)).toEqual(doc.captions.map((c) => c.id));
    expect(scenes.map((s) => s.narration)).toEqual(units.map((u) => u.text));
    // The identity is a function of the same units the worker reads, plus the narration mapping.
    expect(alignmentIdentityPayload(doc)).toBe(JSON.stringify({ units, narration: narrationMappingOf(doc) }));
  });

  it('a caption edit changes both the identity and the snapshot text', () => {
    const doc = deriveEditorDocument({ project: buildProject(), targetId: 'long' });
    const edited = applyEditorOperations(doc, [{ type: 'update', collection: 'captions', id: doc.captions[0].id, changes: { text: 'مَرْحَبًا' } }]);
    expect(alignmentIdentityPayload(edited)).not.toBe(alignmentIdentityPayload(doc));
    expect(buildAlignmentSnapshot(edited, 'long').text).not.toBe(buildAlignmentSnapshot(doc, 'long').text);
  });

  it('a visual split leaves the caption units, the snapshot and the identity unchanged', () => {
    const doc = deriveEditorDocument({ project: buildProject(), targetId: 'long' });
    const split = applyEditorOperations(doc, [{ type: 'split', collection: 'visualClips', id: doc.visualClips[1].id, atSec: doc.visualClips[1].startSec + doc.visualClips[1].durationSec / 2 }]);
    expect(alignmentIdentityPayload(split)).toBe(alignmentIdentityPayload(doc));
    expect(buildAlignmentSnapshot(split, 'long').snapshot.storyboard).toEqual(buildAlignmentSnapshot(doc, 'long').snapshot.storyboard);
  });

  it('rows keyed by an id that is not a caption are refused', () => {
    const bound = reconcileNarration(deriveEditorDocument({ project: buildProject(), targetId: 'long' }), {
      importId: IMPORT_ID, name: 'n', mediaUrl: '/n', source: 's', license: 'l', durationSec: 20, sha256: 'b'.repeat(64), approved: true,
    }).doc;
    const rows = validateAlignmentRows([{ sceneId: 'vc_lng_01', startSec: 0, endSec: 1 }], 20);
    expect(() => applyAlignmentRows(bound, rows, { audioSha256: 'c'.repeat(64), proposalId: 'p', sourceRevision: 0 }))
      .toThrow(/no caption with id vc_lng_01/);
  });
});

describe('blocker 5: the render plan keeps caption style, orientation and channel', () => {
  it('per-cue font size, position, direction, format and channel reach the plan', () => {
    const project = buildProject();
    const doc = deriveEditorDocument({ project, targetId: 'long' });
    expect(doc.channelBrandId).toBe('safety_first');
    const cap = doc.captions[0];
    const styled = applyEditorOperations(doc, [{ type: 'update', collection: 'captions', id: cap.id, changes: { fontSizePx: 72, position: { x: 0.2, y: 0.3 }, direction: 'ltr' } }]);
    const plan = editorDocumentToRenderPlan(styled);
    const cue = plan.captions.find((c) => c.id === cap.id)!;
    expect(cue.fontSizePx).toBe(72);
    expect(cue.position).toEqual({ x: 0.2, y: 0.3 });
    expect(cue.direction).toBe('ltr');
    expect(plan.format).toBe('landscape');
    expect(plan.channelBrandId).toBe('safety_first');
  });

  it('a portrait document maps to the portrait orientation in the plan', () => {
    const doc = deriveEditorDocument({ project: buildProject(), targetId: 'long' });
    const portrait = applyEditorOperations(doc, [{ type: 'setDocument', changes: { format: 'portrait' } } as never]);
    expect(editorDocumentToRenderPlan(portrait).format).toBe('portrait');
  });
});

describe('core: reconcile, library merge and byte ranges', () => {
  const binding = (over: Partial<NarrationBinding> = {}): NarrationBinding => ({
    importId: IMPORT_ID, name: 'n', mediaUrl: '/n', source: 's', license: 'l', durationSec: 20, sha256: 'b'.repeat(64), approved: true, ...over,
  });

  it('reconcile with an unchanged project binding is a no-op for a trimmed, unapproved clip', () => {
    const base = reconcileNarration(deriveEditorDocument({ project: buildProject(), targetId: 'long' }), binding()).doc;
    const trimmed = applyEditorOperations(base, [{ type: 'update', collection: 'audioClips', id: 'ac_narration', changes: { sourceInSec: 1 } }]);
    expect(audioOf(trimmed).approved).toBe(false);
    const again = reconcileNarration(trimmed, binding());
    expect(again.changed).toBe(false);
    expect(audioOf(again.doc).approved).toBe(false);
  });

  it('a legacy narration asset without approvedSeen is brought in line once', () => {
    const base = reconcileNarration(deriveEditorDocument({ project: buildProject(), targetId: 'long' }), binding()).doc;
    const legacy = JSON.parse(JSON.stringify(base)) as EditorDocument;
    delete legacy.assets.find((a) => a.id === 'narration')!.approvedSeen;
    legacy.audioClips.find((c) => c.id === 'ac_narration')!.approved = false;
    const once = reconcileNarration(legacy, binding({ approved: true }));
    expect(once.changed).toBe(true);
    expect(audioOf(once.doc).approved).toBe(true);
    expect(reconcileNarration(once.doc, binding({ approved: true })).changed).toBe(false);
  });

  it('mergeLibraryAssets adds eligible unused images and videos only, once', () => {
    const doc = deriveEditorDocument({ project: buildProject(), targetId: 'long' });
    const refs = [
      { id: 'img_owner', kind: 'image' as const, name: 'a', mediaUrl: '/x', durationSec: null, source: 's', license: 'l' },
      { id: 'vid_new', kind: 'video' as const, name: 'v', mediaUrl: '/v', durationSec: 30, source: 's', license: 'l' },
      { id: 'aud_x', kind: 'audio' as const, name: 'm', mediaUrl: '/m', durationSec: 9, source: 's', license: 'l' },
    ];
    const merged = mergeLibraryAssets(doc, refs);
    expect(merged.assets.map((a) => a.id)).toEqual(['img_owner', 'vid_new']);
    expect(mergeLibraryAssets(merged, refs)).toBe(merged);
  });

  it('parseSingleByteRange: bounded, suffix, open, and refused forms', () => {
    expect(parseSingleByteRange('bytes=0-43', 100)).toEqual({ kind: 'partial', start: 0, end: 43 });
    expect(parseSingleByteRange('bytes=-10', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseSingleByteRange('bytes=95-', 100)).toEqual({ kind: 'partial', start: 95, end: 99 });
    expect(parseSingleByteRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseSingleByteRange('bytes=0-1,4-5', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseSingleByteRange(undefined, 100)).toEqual({ kind: 'absent' });
  });
});
