/** Synthetic SILENT starting shot only. Never seeds actor graphics; those must be authored by the caller/UI. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { EditorDocument } from '@buildtrack/core';
import { ASSETS_DIR, DATA_DIR } from '../../apps/api/src/services/platform.js';
import { loadAssetIndex, saveAssetIndex } from '../../apps/api/src/routes/assets.js';

export async function qaRequest(app: FastifyInstance, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const res = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'content-type': 'application/json' } });
  return { status: res.statusCode, json: res.json() };
}

export async function seedActorQaProject(app: FastifyInstance) {
  // An explicit sandbox guard: this helper must never overwrite an owner's library or projects.
  assert(DATA_DIR.startsWith(path.join(process.cwd(), '.stills') + path.sep), 'Actor QA requires an isolated .stills data directory');
  const id = 'actor-qa-starting-image';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSETS_DIR, `${id}.png`), png);
  saveAssetIndex([...loadAssetIndex().filter((asset) => asset.id !== id), {
    id, name: 'Synthetic actor QA starting image', kind: 'broll', fileName: `${id}.png`, path: `${id}.png`, mimeType: 'image/png', sizeBytes: png.length,
    tags: [], status: 'active', preferred: false, source: 'Synthetic ACTOR01 QA', license: 'Synthetic test fixture', addedAt: new Date().toISOString(), usedIn: [], blocked: false,
  }] as never);
  const created = await qaRequest(app, 'POST', '/api/factory/drafts', {
    contentProfile: 'educational', format: 'landscape', channelBrandId: null, requestedSpeakers: [], referenceProjectId: null, visualLanguage: null,
    inputs: {
      brief: '', script: null, audioAssetId: null, visualAssetIds: [id], narrationMode: 'none', captions: false,
      storyboard: { version: 1, scenes: [{ id: 'actor-shot', narration: '', speakerId: null, assetId: id, startSec: 0, endSec: 3, locked: false }] },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const applied = await qaRequest(app, 'POST', `/api/factory/drafts/${created.json.draftId}/apply`, { expectedRevision: created.json.revision, confirmSpeechCalls: 0 });
  assert.equal(applied.status, 201, JSON.stringify(applied.json));
  assert.equal(applied.json.speechGenerated, 0);
  const projectId = applied.json.projectId as string;
  const editor = await qaRequest(app, 'GET', `/api/projects/${projectId}/editor?targetId=long`);
  assert.equal(editor.status, 200);
  const document = editor.json.document as EditorDocument;
  assert.equal(document.visualClips.length, 1);
  assert.equal(document.visualClips[0].graphic ?? null, null);
  assert.equal(document.durationSec, 3);
  assert.deepEqual(document.audioClips, []); assert.deepEqual(document.captions, []);
  return { projectId, clipId: document.visualClips[0].id, document };
}
