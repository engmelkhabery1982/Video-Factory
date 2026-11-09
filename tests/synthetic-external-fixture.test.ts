/**
 * The synthetic render request must be a complete ProjectInput.
 *
 * The original create body omitted productShots. Metadata then threw
 * "input.productShots is not iterable" while writing the export kit.
 * These tests use isolated directories and the real metadata writer.
 * They do not render.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'synthetic-external-fixture');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  return { root, data, output };
});

import { provenance } from '@buildtrack/core';
import type { FastifyInstance } from 'fastify';
import { buildServerApp } from '../apps/api/src/server.js';
import { writeMetadata } from '../apps/api/src/services/pipeline.js';
import { loadProject } from '../apps/api/src/services/store.js';
import { syntheticExternalProjectInput } from '../scripts/synthetic-external-fixture.js';

/** The create body that failed in the synthetic-render job, before media lists existed. */
const ORIGINAL_INCOMPLETE = {
  videoId: 'Synthetic_External_Render',
  videoType: 'long',
  topic: 'رحمة',
  script: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ.',
  hook: 'Where are the project records?',
  keyPoints: ['records', 'claims'],
  productName: 'BuildTrack',
  cta: '',
  narrationSource: 'external_ready',
  outputLanguage: 'ar',
  shortCount: 0,
  keyNumbers: [],
  sourceReferences: [],
};

describe('synthetic external fixture input', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServerApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects the original incomplete fixture before saving', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: ORIGINAL_INCOMPLETE });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/productShots/);
    expect(res.json().error).toMatch(/brollFiles/);
    expect(loadProject(ORIGINAL_INCOMPLETE.videoId)).toBeNull();
  });

  it('rejects malformed media lists instead of storing them as empty arrays', async () => {
    const cases = [
      ['null', null],
      ['object', { file: 'shots/a.png' }],
      ['number', 1],
      ['string', 'shots/a.png'],
      ['number member', [1]],
      ['null member', [null]],
      ['object member', [{ path: 'shots/a.png' }]],
    ] as const;
    for (const [label, productShots] of cases) {
      const videoId = `Bad_shots_${label.replace(/\s+/g, '_')}`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { ...syntheticExternalProjectInput(), videoId, productShots },
      });
      expect(res.statusCode, label).toBe(400);
      expect(res.json().error, label).toMatch(/productShots/);
      expect(loadProject(videoId), label).toBeNull();
    }
    const broll = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...syntheticExternalProjectInput(), videoId: 'Bad_broll', brollFiles: 'clip.mp4' },
    });
    expect(broll.statusCode).toBe(400);
    expect(broll.json().error).toMatch(/brollFiles/);
    expect(loadProject('Bad_broll')).toBeNull();
  });

  it('accepts the corrected fixture and the real metadata writer can iterate the lists', async () => {
    const input = syntheticExternalProjectInput();
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: input });
    expect(res.statusCode).toBe(200);
    const project = loadProject(input.videoId);
    expect(project).not.toBeNull();
    expect(project!.meta.input.productShots).toEqual([]);
    expect(project!.meta.input.brollFiles).toEqual([]);
    expect(project!.meta.input.voiceoverFile).toBeNull();
    expect(project!.meta.input.targetAudio).toEqual({});
    expect(project!.meta.input.brandPreset).toBe('buildtrack');
    expect(project!.meta.input.narrationSource).toBe('external_ready');
    expect(project!.meta.input.shortCount).toBe(0);
    expect(project!.meta.input.script).toBe(input.script);
    const dir = writeMetadata(project!, []);
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'asset_provenance.json'), 'utf8')) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(dir.startsWith(tmp.output)).toBe(true);
  });

  it('does not let an ordinary update replace a valid list with a malformed one', async () => {
    const videoId = 'Synthetic_Fixture_Update';
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...syntheticExternalProjectInput(), videoId },
    });
    expect(created.statusCode).toBe(200);

    const malformed = await app.inject({
      method: 'PUT',
      url: `/api/projects/${videoId}`,
      payload: { input: { productShots: null, topic: 'should not be saved' } },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toMatch(/productShots/);
    expect(loadProject(videoId)!.meta.input.productShots).toEqual([]);
    expect(loadProject(videoId)!.meta.input.topic).toBe('synthetic external render fixture');

    const badMember = await app.inject({
      method: 'PUT',
      url: `/api/projects/${videoId}`,
      payload: { input: { brollFiles: [1] } },
    });
    expect(badMember.statusCode).toBe(400);
    expect(loadProject(videoId)!.meta.input.brollFiles).toEqual([]);

    const kept = await app.inject({
      method: 'PUT',
      url: `/api/projects/${videoId}`,
      payload: { input: { topic: 'still a fixture' } },
    });
    expect(kept.statusCode).toBe(200);
    expect(loadProject(videoId)!.meta.input.topic).toBe('still a fixture');
    expect(loadProject(videoId)!.meta.input.productShots).toEqual([]);
    expect(loadProject(videoId)!.meta.input.brollFiles).toEqual([]);

    const replaced = await app.inject({
      method: 'PUT',
      url: `/api/projects/${videoId}`,
      payload: { input: { productShots: ['shots/fixture.png'] } },
    });
    expect(replaced.statusCode).toBe(200);
    expect(loadProject(videoId)!.meta.input.productShots).toEqual(['shots/fixture.png']);
  });

  it('still throws if the original incomplete shape reaches provenance', () => {
    expect(() => provenance(ORIGINAL_INCOMPLETE as never, [], ORIGINAL_INCOMPLETE.videoId)).toThrow(/productShots/);
  });
});
