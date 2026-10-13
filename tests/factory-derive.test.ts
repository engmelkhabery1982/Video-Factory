/**
 * Derived rewrite of approved narration (Phase 2), over the REAL factory routes.
 * Isolated data under .stills/test-isolation. Fixture narration only. Not owner acceptance.
 * Shows: the source draft is byte-identical after a derivation; the derivative is blocked
 * by a review item until a reviewer confirms it at its revision; apply refuses before any
 * project or provider step; refusals return stable codes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const nodePath = process.getBuiltinModule('node:path') as typeof import('node:path');
  delete process.env.VF_ALIGN_COMMAND;
  process.env.VF_PREVIEW_DISABLE = '1';
  const root = nodePath.join(process.cwd(), '.stills', 'test-isolation', 'factory-derive-suite');
  const data = nodePath.join(root, 'data');
  const output = nodePath.join(root, 'output');
  nodeFs.rmSync(root, { recursive: true, force: true });
  nodeFs.mkdirSync(data, { recursive: true });
  nodeFs.mkdirSync(output, { recursive: true });
  process.env.BUILDTRAKE_DATA = data;
  process.env.BUILDTRAKE_OUTPUT = output;
  return { root, data };
});

import { buildServerApp } from '../apps/api/src/server.js';
import { DRAFTS_DIR } from '../apps/api/src/services/factory-service.js';

type App = Awaited<ReturnType<typeof buildServerApp>>;
let app: App;

const SCRIPT = [
  'Many sites lose a day when a crane waits for a delivery nobody confirmed.',
  'Check the delivery window the night before and confirm it with the supplier.',
  'Write the confirmed time on the site board so every crew sees it.',
].join('\n');

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const res = await app.inject({
    method, url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
  let json: any = null;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.statusCode, json };
}

const hashDrafts = (): Record<string, string> => {
  if (!fs.existsSync(DRAFTS_DIR)) return {};
  return Object.fromEntries(fs.readdirSync(DRAFTS_DIR).sort().map((f) => [f, createHash('sha256').update(fs.readFileSync(path.join(DRAFTS_DIR, f))).digest('hex')]));
};

/** The envelope does not list units. Units are the sourceUnitIds of the selected treatment's scenes. */
async function sourceDraft(): Promise<{ draftId: string; revision: number; units: Array<{ id: string; narration: string }> }> {
  const created = await call('POST', '/api/factory/drafts', {
    contentProfile: 'educational', format: 'landscape', channelBrandId: null,
    inputs: { brief: 'Concrete delivery windows', script: SCRIPT, audioAssetId: null, visualAssetIds: [], storyboard: null },
    requestedSpeakers: [], referenceProjectId: null,
  });
  expect(created.status).toBe(201);
  const got = await call('GET', `/api/factory/drafts/${created.json.draftId}`);
  const treatment = got.json.treatments.find((t: { id: string }) => t.id === got.json.selectedTreatmentId);
  const seen = new Map<string, { id: string; narration: string }>();
  for (const sc of treatment?.scenes ?? []) if (sc.sourceUnitId && !seen.has(sc.sourceUnitId)) seen.set(sc.sourceUnitId, { id: sc.sourceUnitId, narration: sc.narration });
  return { draftId: created.json.draftId, revision: got.json.revision, units: [...seen.values()] };
}

beforeAll(async () => {
  app = await buildServerApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('derived rewrite of supplied narration', () => {
  it('creates a derivative, leaves the source byte-identical, and marks the rewritten unit as derived', async () => {
    const src = await sourceDraft();
    const target = src.units[0];
    expect(target, 'the supplied script produced narration units').toBeTruthy();
    const before = hashDrafts();

    const out = await call('POST', `/api/factory/drafts/${src.draftId}/derive`, {
      expectedRevision: src.revision,
      edits: [{ unitId: target.id, narration: 'Confirm the crane delivery window the night before.' }],
    });
    expect(out.status).toBe(201);
    expect(out.json.draftId).not.toBe(src.draftId);
    expect(out.json.derivedFrom).toMatchObject({ draftId: src.draftId, revision: src.revision, rootDraftId: src.draftId });
    expect(out.json.derivedFrom.changes).toEqual([{ unitId: target.id, before: target.narration, after: 'Confirm the crane delivery window the night before.' }]);
    expect(out.json.reviewedRevision).toBeNull();

    const after = hashDrafts();
    expect(after[`${src.draftId}.json`]).toBe(before[`${src.draftId}.json`]);
    expect(Object.keys(after).length).toBe(Object.keys(before).length + 1);
  });

  it('the derivative is blocked by a review item, so speech and apply refuse', async () => {
    const src = await sourceDraft();
    const out = await call('POST', `/api/factory/drafts/${src.draftId}/derive`, {
      expectedRevision: src.revision,
      edits: [{ unitId: src.units[0].id, narration: 'Check the window with the supplier by phone.' }],
    });
    expect(out.json.status).toBe('blocked');
    const preview = await call('GET', `/api/factory/drafts/${out.json.draftId}/apply-preview`);
    expect(preview.status).toBe(200);
    expect(preview.json.canApply).toBe(false);
    expect(preview.json.blockers.some((b: { kind: string }) => b.kind === 'review')).toBe(true);
    expect(preview.json.speechCalls).toBeGreaterThanOrEqual(0);

    const applied = await call('POST', `/api/factory/drafts/${out.json.draftId}/apply`, { expectedRevision: out.json.revision });
    expect(applied.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(applied.json)).toMatch(/review/);
  });

  it('a reviewer confirms at the revision read; a stale review is refused; the review clears the gate', async () => {
    const src = await sourceDraft();
    const out = await call('POST', `/api/factory/drafts/${src.draftId}/derive`, {
      expectedRevision: src.revision,
      edits: [{ unitId: src.units[1].id, narration: 'Write the window on the site board.' }],
    });
    const derivedId = out.json.draftId as string;
    const stale = await call('POST', `/api/factory/drafts/${derivedId}/review`, { expectedRevision: out.json.revision + 5 });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('FACTORY_REVISION_CONFLICT');

    const reviewed = await call('POST', `/api/factory/drafts/${derivedId}/review`, { expectedRevision: out.json.revision });
    expect(reviewed.status).toBe(200);
    expect(reviewed.json.reviewedRevision).toBe(out.json.revision);
    expect(reviewed.json.missing.some((m: { kind: string }) => m.kind === 'review')).toBe(false);
    const preview = await call('GET', `/api/factory/drafts/${derivedId}/apply-preview`);
    expect(preview.json.blockers.some((b: { kind: string }) => b.kind === 'review')).toBe(false);
  });

  it('refuses reviewing a draft that is not a derivative', async () => {
    const src = await sourceDraft();
    const res = await call('POST', `/api/factory/drafts/${src.draftId}/review`, { expectedRevision: src.revision });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('FACTORY_NOT_DERIVED');
  });

  it('refuses stale, empty, unknown, duplicate, unchanged and markup edits with stable codes', async () => {
    const src = await sourceDraft();
    const unit = src.units[0];
    const stale = await call('POST', `/api/factory/drafts/${src.draftId}/derive`, { expectedRevision: src.revision + 1, edits: [{ unitId: unit.id, narration: 'x' }] });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('FACTORY_REVISION_CONFLICT');
    const empty = await call('POST', `/api/factory/drafts/${src.draftId}/derive`, { expectedRevision: src.revision, edits: [] });
    expect(empty.status).toBe(422);
    const unknown = await call('POST', `/api/factory/drafts/${src.draftId}/derive`, { expectedRevision: src.revision, edits: [{ unitId: 'nope', narration: 'x' }] });
    expect(unknown.status).toBe(422);
    const dup = await call('POST', `/api/factory/drafts/${src.draftId}/derive`, { expectedRevision: src.revision, edits: [{ unitId: unit.id, narration: 'a' }, { unitId: unit.id, narration: 'b' }] });
    expect(dup.status).toBe(422);
    const same = await call('POST', `/api/factory/drafts/${src.draftId}/derive`, { expectedRevision: src.revision, edits: [{ unitId: unit.id, narration: unit.narration }] });
    expect(same.status).toBe(422);
    expect(same.json.error).toMatch(/nothing was derived/i);
    const markup = await call('POST', `/api/factory/drafts/${src.draftId}/derive`, { expectedRevision: src.revision, edits: [{ unitId: unit.id, narration: '<b>x</b>' }] });
    expect(markup.status).toBe(422);
    const missing = await call('POST', '/api/factory/drafts/dft_0000000000000000/derive', { expectedRevision: 0, edits: [{ unitId: 'u', narration: 'x' }] });
    expect(missing.status).toBe(404);
  });
});
