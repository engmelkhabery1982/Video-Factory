/**
 * Caption language and translation links over the REAL editor routes (buildServerApp).
 * Fixture project, isolated data under .stills/test-isolation. Not browser acceptance.
 * Shows: the selected language is saved and reopened, translation links keep their
 * spoken cue timing through text edits, and the render plan shows one language.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  delete process.env.VF_ALIGN_COMMAND;
  process.env.VF_PREVIEW_DISABLE = '1';
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'editor-caption-language-api');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  return { root, data };
});

import { PROJECT_SCHEMA_VERSION, buildStoryboard, editorDocumentToRenderPlan, emptyHistory, type EditorDocument, type Project, type ProjectInput } from '@buildtrack/core';
import { saveProject } from '../apps/api/src/services/store.js';
import { buildServerApp } from '../apps/api/src/server.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;
const VIDEO_ID = 'Caption_Language_Api';
const SCRIPT =
  'اتقوا الله في الجميع. وتنسى ما أعطيت. وعليك بالصبر في كل حال.';

function projectInput(): ProjectInput {
  return {
    videoId: VIDEO_ID, videoType: 'long', topic: 'Safe Building Practice', targetAudience: 'Site managers',
    mainProblem: 'Unsafe habits', viewerPromise: 'Practical safety', hook: 'Are your teams protected?',
    script: SCRIPT, keyNumbers: ['100% compliance'], keyPoints: ['Hard hats'], productName: 'Kit', productShots: [],
    cta: 'Book your audit', voiceoverFile: null, targetAudio: {}, brollFiles: [], sourceReferences: [],
    outputLanguage: 'ar', brandPreset: 'safety_first', shortCount: 1,
  };
}

function createProject(): void {
  const input = projectInput();
  const sb = buildStoryboard({ input, history: emptyHistory(), audioDuration: 60 });
  const { historyEntry: _h, ...storyboard } = sb;
  const now = new Date().toISOString();
  const project: Project = { schemaVersion: PROJECT_SCHEMA_VERSION, meta: { input, brand: sb.brand, createdAt: now, updatedAt: now, status: 'storyboarded' }, storyboard, artifacts: [], qc: [] };
  saveProject(project);
}

async function getDoc(): Promise<{ revision: number; document: EditorDocument }> {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${VIDEO_ID}/editor?targetId=long` });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { document: EditorDocument };
  return { revision: body.document.revision, document: body.document };
}

async function patch(baseRevision: number, operations: unknown[]) {
  return app.inject({ method: 'PATCH', url: `/api/projects/${VIDEO_ID}/editor`, payload: { targetId: 'long', baseRevision, operations } });
}

beforeAll(async () => {
  createProject();
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

describe('caption language over the editor routes', () => {
  it('a translation links to a spoken cue, the language is saved, and a reopen keeps both', async () => {
    const first = await getDoc();
    const spoken = first.document.captions.find((c) => !c.cueOf);
    expect(spoken, 'the fixture project has a spoken caption').toBeTruthy();

    const added = await patch(first.revision, [
      { type: 'insert', collection: 'captions', item: { id: 'tr_api_1', cueOf: spoken!.id, text: 'Fear God in all', language: 'en', direction: 'ltr', fontSizePx: 44, position: { x: 0.5, y: 0.82 }, locked: false } },
      { type: 'setDocument', changes: { captionLanguage: 'en' } },
    ]);
    expect(added.statusCode).toBe(200);

    const reopened = await getDoc();
    expect(reopened.document.captionLanguage).toBe('en');
    const link = reopened.document.captions.find((c) => c.id === 'tr_api_1')!;
    expect(link).toMatchObject({ cueOf: spoken!.id, startSec: spoken!.startSec, endSec: spoken!.endSec, text: 'Fear God in all' });
  });

  it('a text edit of the translation keeps the link and the timing after reopen', async () => {
    const before = await getDoc();
    const link = before.document.captions.find((c) => c.id === 'tr_api_1')!;
    const edited = await patch(before.revision, [{ type: 'update', collection: 'captions', id: 'tr_api_1', changes: { text: 'Be mindful of God in all things' } }]);
    expect(edited.statusCode).toBe(200);
    const after = await getDoc();
    const moved = after.document.captions.find((c) => c.id === 'tr_api_1')!;
    expect(moved).toMatchObject({ cueOf: link.cueOf, startSec: link.startSec, endSec: link.endSec, text: 'Be mindful of God in all things' });
  });

  it('the selected language shows the translation only, and the other spoken cues are reported missing', async () => {
    const { document } = await getDoc();
    const plan = editorDocumentToRenderPlan(document);
    expect(plan.captionLanguage).toBe('en');
    expect(plan.captions.map((c) => c.id)).toContain('tr_api_1');
    const linkedSpoken = document.captions.find((c) => c.id === 'tr_api_1')!.cueOf!;
    expect(plan.captions.some((c) => c.id === linkedSpoken)).toBe(false);
    expect(plan.missingTranslations.length).toBeGreaterThan(0);
    expect(plan.missingTranslations).not.toContain(linkedSpoken);
  });

  it('an invalid caption language is refused by the route and the document is unchanged', async () => {
    const before = await getDoc();
    const res = await patch(before.revision, [{ type: 'setDocument', changes: { captionLanguage: 'English' } }]);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const after = await getDoc();
    expect(after.document.captionLanguage).toBe('en');
    expect(after.revision).toBe(before.revision);
  });
});
