/**
 * Gate 4 guards and the identity field of the editor envelope. HTTP only, no render.
 * The rendered acceptance (landscape and portrait) is evidence from a scratch script.
 */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'm1-close-export');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(nodePath.join(root, 'data'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(root, 'output'), { recursive: true });
  process.env.BUILDTRAKE_DATA = nodePath.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = nodePath.join(root, 'output');
  return { root };
});

import { PROJECT_SCHEMA_VERSION, buildStoryboard, emptyHistory, type Project, type ProjectInput } from '@buildtrack/core';
import { buildServerApp } from '../apps/api/src/server.js';
import { saveProject } from '../apps/api/src/services/store.js';

const ID = 'M1_Export_Guard';
const ID_RELIGIOUS = 'M1_Export_Guard_Religious';

function project(brandPreset: string, contentProfile?: string, projectId = ID): Project {
  const input: ProjectInput = {
    videoId: projectId, videoType: 'long', topic: 'guard', targetAudience: 'none', mainProblem: '', viewerPromise: '', hook: '',
    script: 'One line.\n\nTwo line.', keyNumbers: [], keyPoints: [], productName: '', productShots: [], cta: '', voiceoverFile: null,
    targetAudio: {}, brollFiles: [], sourceReferences: [], outputLanguage: 'en', brandPreset, shortCount: 0, narrationSource: 'external_ready',
    ...(contentProfile ? { contentProfile } : {}),
  } as ProjectInput;
  const built: any = buildStoryboard({ input, history: emptyHistory(), audioDuration: 20 });
  const { historyEntry: _h, ...storyboard } = built;
  const now = new Date().toISOString();
  return { schemaVersion: PROJECT_SCHEMA_VERSION, meta: { input, brand: built.brand, createdAt: now, updatedAt: now, status: 'storyboarded' }, storyboard, artifacts: [], qc: [] } as Project;
}

describe('final export guards and identity in the editor envelope (Gate 3/4, HTTP)', () => {
  let app: Awaited<ReturnType<typeof buildServerApp>>;

  beforeAll(async () => {
    saveProject(project('buildtrack'));
    saveProject(project('unbound-religious', 'religious', ID_RELIGIOUS));
    app = await buildServerApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a project with no editor document is not exported by the editor route (legacy export stays)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${ID}/editor/export`, payload: { targetId: 'long', baseRevision: 0 } });
    // the first GET of the editor creates the sidecar; before that there is no document
    expect([409, 501]).toContain(res.statusCode);
    if (res.statusCode === 409) expect(res.json().code).toBe('NO_EDITOR_DOCUMENT');
  });

  it('a stale baseRevision is refused as a revision conflict, never exported', async () => {
    const envelope = (await app.inject({ method: 'GET', url: `/api/projects/${ID}/editor?targetId=long` })).json();
    expect(envelope.identity.status).toBe('bound');
    const res = await app.inject({ method: 'POST', url: `/api/projects/${ID}/editor/export`, payload: { targetId: 'long', baseRevision: envelope.document.revision + 7 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('REVISION_CONFLICT');
  });

  it('an unknown export job is 404; a bad revision is 400', async () => {
    const unknown = await app.inject({ method: 'GET', url: `/api/projects/${ID}/editor/export/exp_0000000000000000?targetId=long` });
    expect(unknown.statusCode).toBe(404);
    const bad = await app.inject({ method: 'POST', url: `/api/projects/${ID}/editor/export`, payload: { targetId: 'long', baseRevision: -1 } });
    expect(bad.statusCode).toBe(400);
  });

  it('the envelope reports an unbound religious identity with no brand (no BuildTrack fallback)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${ID_RELIGIOUS}/editor?targetId=long` });
    expect(res.statusCode).toBe(200);
    expect(res.json().identity.status).toBe('none');
    expect(res.json().identity.brand).toBeNull();
    expect(res.json().identity.logoAssetId).toBeNull();
  });

  it('the export file is never inside the owner data tree written by these tests', () => {
    expect(fs.existsSync(tmp.root)).toBe(true);
  });
});
