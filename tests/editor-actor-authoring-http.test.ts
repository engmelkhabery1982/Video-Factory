/** ACTOR01: real canonical routes/persistence on synthetic isolated data. HTTP, not browser or rendered output. */
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const path = process.getBuiltinModule('node:path') as typeof import('node:path');
  const base = path.join(process.cwd(), '.stills', 'test-isolation'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'actor-authoring-http-'));
  process.env.BUILDTRAKE_DATA = path.join(root, 'data'); process.env.BUILDTRAKE_OUTPUT = path.join(root, 'output');
  process.env.VF_PREVIEW_DISABLE = '1'; delete process.env.VF_ALIGN_COMMAND;
});

import { editorDocumentToRenderPlan, type EditorDocument, type EditorGraphic } from '@buildtrack/core';
import { buildServerApp } from '../apps/api/src/server.js';
import { editorStateFile } from '../apps/api/src/services/editor-store.js';
import { qaRequest, seedActorQaProject } from './helpers/actor-authoring-qa.js';
import { actorRemovalProblem, emptyActorGraphic, newActorObject } from '../apps/web/src/lib/actor-form';
import { planGraphicValues, planTechniqueChange } from '../apps/web/src/lib/graphic-clip-edit';
import { opUpdate } from '../apps/web/src/lib/editor-model';

let app: Awaited<ReturnType<typeof buildServerApp>>;
let seed: Awaited<ReturnType<typeof seedActorQaProject>>;
beforeAll(async () => { app = await buildServerApp(); await app.ready(); });
beforeEach(async () => { seed = await seedActorQaProject(app); });
afterAll(async () => { await app?.close(); });
const route = () => `/api/projects/${seed.projectId}/editor`;
async function current(): Promise<EditorDocument> {
  const result = await qaRequest(app, 'GET', `${route()}?targetId=long`); expect(result.status).toBe(200); return result.json.document;
}
async function save(graphic: EditorGraphic, baseRevision?: number) {
  const plan = planGraphicValues('actor_action', graphic); expect(plan.status).toBe('stage');
  return qaRequest(app, 'PATCH', route(), { targetId: 'long', baseRevision: baseRevision ?? (await current()).revision, operations: [opUpdate('visualClips', seed.clipId, plan.status === 'stage' ? plan.changes : {})] });
}
function actor() {
  const graphic = emptyActorGraphic();
  graphic.objects.push(newActorObject(graphic, 'figure'), newActorObject(graphic, 'box'));
  return graphic;
}
function motion(graphic: EditorGraphic): EditorGraphic {
  return { ...graphic, actions: [
    { id: 'action-1', targetId: 'figure-1', property: 'armAngle', from: 15, to: 70, startSec: 0.25, endSec: 2, easing: 'ease_in_out' },
    { id: 'action-2', targetId: 'box-1', property: 'x', from: 0.65, to: 0.75, startSec: 0.5, endSec: 2.5, easing: 'linear' },
  ] };
}
const bytes = () => fs.readFileSync(editorStateFile(seed.projectId, 'long'), 'utf8');

function unchangedTracks(before: EditorDocument, after: EditorDocument) {
  expect(after.durationSec).toBe(before.durationSec); expect(after.audioClips).toEqual(before.audioClips); expect(after.captions).toEqual(before.captions);
  expect(after.visualClips.map((c) => [c.id, c.startSec, c.durationSec])).toEqual(before.visualClips.map((c) => [c.id, c.startSec, c.durationSec]));
}

describe('actor creation and editing through canonical transactions (HTTP)', () => {
  it('keeps a selected-but-empty actor technique incomplete and refuses forced empty/box-only graphics atomically', async () => {
    expect(planTechniqueChange(seed.document.visualClips[0], 'actor_action', null).status).toBe('pending');
    const before = bytes();
    const empty = await save(emptyActorGraphic()); expect(empty.status).toBe(422); expect(empty.json.code).toBe('EDITOR_INVALID_CHANGE');
    const boxOnly = emptyActorGraphic(); boxOnly.objects.push(newActorObject(boxOnly, 'box'));
    expect((await save(boxOnly)).status).toBe(422); expect(bytes()).toBe(before);
  });

  it('creates, edits, adds explicit actions, saves, restarts the app and reopens identical IDs/values/actions/times on the shared render plan', async () => {
    const graphic = actor();
    expect((await save(graphic)).status).toBe(200);
    expect((await current()).visualClips[0].graphic!.actions).toEqual([]);
    const edited = { ...graphic, title: 'Move the kit', direction: 'rtl' as const, background: '#172b34', objects: graphic.objects.map((o) => o.type === 'figure' ? { ...o, x: 0.27, y: 0.62, scale: 1.1, armAngle: 15 } : { ...o, label: 'Crew kit', color: '#00aa66', w: 0.18, h: 0.14 }) };
    expect((await save(edited)).status).toBe(200);
    const animated = motion(edited); expect((await save(animated)).status).toBe(200);
    const saved = await current(); unchangedTracks(seed.document, saved);
    expect(saved.visualClips[0]).toMatchObject({ graphic: animated, technique: 'actor_action', sourceAssetId: null, sourceInSec: null, sourceOutSec: null });
    const file = JSON.parse(bytes()); expect(file.document).toEqual(saved);
    await app.close(); app = await buildServerApp(); await app.ready();
    const reopened = await current(); expect(reopened).toEqual(saved);
    const plan = editorDocumentToRenderPlan(reopened);
    expect(plan.scenes[0].content.graphic).toEqual(animated); expect(plan.scenes[0].duration).toBe(3);
  });

  it('undo/redo restore whole creation and action transactions; stale saves/history are 409 and leave bytes untouched', async () => {
    const graphic = actor(); expect((await save(graphic)).status).toBe(200);
    let doc = await current();
    const undo = await qaRequest(app, 'POST', `${route()}/undo`, { targetId: 'long', baseRevision: doc.revision }); expect(undo.status).toBe(200);
    expect((await current()).visualClips[0]).toEqual(seed.document.visualClips[0]);
    const afterUndo = bytes();
    expect((await qaRequest(app, 'POST', `${route()}/redo`, { targetId: 'long', baseRevision: doc.revision })).status).toBe(409); expect(bytes()).toBe(afterUndo);
    const redo = await qaRequest(app, 'POST', `${route()}/redo`, { targetId: 'long', baseRevision: undo.json.document.revision }); expect(redo.status).toBe(200);
    expect((await current()).visualClips[0].graphic).toEqual(graphic);
    const animated = motion(graphic); expect((await save(animated)).status).toBe(200); doc = await current();
    const staleBytes = bytes(); const stale = await save({ ...animated, title: 'Stale edit' }, doc.revision - 1);
    expect(stale.status).toBe(409); expect(stale.json.code).toBe('REVISION_CONFLICT'); expect(bytes()).toBe(staleBytes);
    const noActions = await qaRequest(app, 'POST', `${route()}/undo`, { targetId: 'long', baseRevision: doc.revision }); expect(noActions.status).toBe(200);
    expect((await current()).visualClips[0].graphic).toEqual(graphic);
    expect((await qaRequest(app, 'POST', `${route()}/redo`, { targetId: 'long', baseRevision: noActions.json.document.revision })).status).toBe(200);
    expect((await current()).visualClips[0].graphic).toEqual(animated); unchangedTracks(seed.document, await current());
  });

  it('refuses invalid colour, numbers, pose, IDs, bounds, action times and unsupported kinds before touching canonical bytes', async () => {
    const graphic = motion(actor()); expect((await save(graphic)).status).toBe(200);
    const before = bytes();
    const cases: EditorGraphic[] = [
      { ...graphic, objects: graphic.objects.map((o, i) => i === 0 ? { ...o, color: 'red' } : o) },
      { ...graphic, objects: graphic.objects.map((o, i) => i === 0 ? { ...o, x: NaN } : o) },
      { ...graphic, objects: graphic.objects.map((o, i) => i === 0 ? { ...o, scale: Infinity } : o) },
      { ...graphic, objects: graphic.objects.map((o, i) => i === 0 ? { ...o, armAngle: 181 } : o) },
      { ...graphic, objects: graphic.objects.map((o, i) => i === 1 ? { ...o, x: 1 } : o) },
      { ...graphic, objects: graphic.objects.map((o, i) => i === 1 ? { ...o, w: 0.7 } : o) },
      { ...graphic, objects: graphic.objects.map((o) => ({ ...o, id: 'duplicate' })) },
      { ...graphic, actions: graphic.actions.map((a) => ({ ...a, id: 'duplicate' })) },
      { ...graphic, actions: graphic.actions.map((a) => ({ ...a, endSec: 4 })) },
      { ...graphic, actions: graphic.actions.map((a) => ({ ...a, startSec: -1 })) },
      { ...graphic, objects: [...graphic.objects, { id: 'word', type: 'word', text: 'Not an actor', x: 0.5, y: 0.5, size: 0.1 }] },
    ];
    for (const bad of cases) { const r = await save(bad); expect(r.status).toBe(422); expect(r.json.code).toBe('EDITOR_INVALID_CHANGE'); expect(bytes()).toBe(before); }
  });

  it('refuses referenced-object deletion, accepts explicit resolution and restores all references on undo', async () => {
    const graphic = motion(actor()); expect((await save(graphic)).status).toBe(200);
    expect(actorRemovalProblem(graphic, 'box-1')).toContain('action-2');
    const before = bytes(); const withoutBox = { ...graphic, objects: graphic.objects.filter((o) => o.id !== 'box-1') };
    expect((await save(withoutBox)).status).toBe(422); expect(bytes()).toBe(before);
    const resolved = { ...withoutBox, actions: graphic.actions.filter((a) => a.targetId !== 'box-1') };
    expect((await save(resolved)).status).toBe(200); expect((await current()).visualClips[0].graphic).toEqual(resolved);
    const undone = await qaRequest(app, 'POST', `${route()}/undo`, { targetId: 'long', baseRevision: (await current()).revision }); expect(undone.status).toBe(200);
    expect((await current()).visualClips[0].graphic).toEqual(graphic);
    expect((await qaRequest(app, 'POST', `${route()}/redo`, { targetId: 'long', baseRevision: undone.json.document.revision })).status).toBe(200);
    expect((await current()).visualClips[0].graphic).toEqual(resolved); unchangedTracks(seed.document, await current());
  });

  it('keeps clip locks authoritative for actor edits', async () => {
    expect((await save(actor())).status).toBe(200);
    const locked = await qaRequest(app, 'PATCH', route(), { targetId: 'long', baseRevision: (await current()).revision, operations: [opUpdate('visualClips', seed.clipId, { locked: true })] });
    expect(locked.status).toBe(200); const before = bytes();
    const refused = await save({ ...actor(), title: 'Cannot change a locked clip' });
    expect(refused.status).toBe(423); expect(bytes()).toBe(before);
  });

  it('labels preview/export refusal as blocked, not rendered output (renderer deliberately disabled in this HTTP suite)', async () => {
    expect((await save(motion(actor()))).status).toBe(200);
    const revision = (await current()).revision;
    for (const kind of ['preview', 'export']) {
      const r = await qaRequest(app, 'POST', `${route()}/${kind}`, { targetId: 'long', baseRevision: revision, range: { startSec: 0, endSec: 3 } });
      expect(r.status).toBe(501); expect(r.json.status).toBe('blocked');
    }
  });
});
