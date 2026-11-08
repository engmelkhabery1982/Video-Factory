/**
 * PURE regression tests for a repaired observable defect.
 *
 * Defect (CLOSEOUT06): choosing `screen_recording` or `footage_clip` for a draft row
 * did not change the row's media requirement. `sceneNeedOf` still answered
 * `image_needed`, so an eligible still could be bound to a "screen recording" row,
 * the draft then reported `review_required` with an empty `missing` list (i.e. "ready"),
 * and the failure only appeared later in Apply as EDITOR_VALIDATION_FAILED.
 *
 * This runs against the real factory service with isolated disposable storage and
 * owned synthetic assets. It is not a fixture: the same functions the routes call
 * are executed.
 *
 * Run: node --experimental-transform-types --import ./tools/lib/ts-source-loader.mjs \
 *        --test tests/factory-technique-media-need.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isolatedStorage, syntheticPng, registerAsset } from '../tools/lib/journey-harness.mjs';

const store = isolatedStorage('vf-need');
store.assertIsolated();
process.env.BUILDTRAKE_DATA = store.data;
process.env.BUILDTRAKE_OUTPUT = store.output;

const svc = await import('../apps/api/src/services/factory-service.ts');
const assets = await import('../apps/api/src/routes/assets.ts');
const platform = await import('../apps/api/src/services/platform.ts');

/** An eligible owned image in the canonical library index. */
function ownedImage(name) {
  const bytes = syntheticPng({ width: 72, height: 72 });
  const rec = registerAsset(platform.ASSETS_DIR, { bytes, filename: `${name}.png`, mimeType: 'image/png', kind: 'screenshot' });
  const index = assets.loadAssetIndex();
  const row = index.find((a) => a.id === rec.id);
  Object.assign(row, {
    name,
    status: 'active',
    preferred: false,
    tags: ['qa-synthetic'],
    source: 'Owned synthetic material',
    license: 'Owned (QA)',
    addedAt: new Date().toISOString(),
    usedIn: [],
    blocked: false,
    width: 72,
    height: 72,
    sizeBytes: bytes.length,
    fileName: path.basename(rec.path),
    path: path.basename(rec.path),
  });
  assets.saveAssetIndex(index);
  return rec.id;
}

const scenesOf = (env) => (env.treatments.find((t) => t.id === env.selectedTreatmentId) ?? { scenes: [] }).scenes;

/** Create a silent one-line draft and set its single row to `technique`. */
function draftWithTechnique(technique) {
  const created = svc.createDraft({
    contentProfile: 'educational',
    format: 'landscape',
    inputs: { brief: 'need', script: 'One supplied line.', visualAssetIds: [], narrationMode: 'none' },
  }).body;
  const env = svc.getDraft(created.draftId);
  const patched = svc.patchDraft(created.draftId, {
    expectedRevision: env.revision,
    selectedTreatmentId: env.selectedTreatmentId,
    scenes: scenesOf(env).map((s) => ({
      id: s.id,
      narration: s.narration,
      speakerId: s.speakerId,
      visualIntent: s.visualIntent,
      assetId: null,
      startSec: s.startSec,
      endSec: s.endSec,
      locked: s.locked,
      technique,
      graphic: null,
    })),
  });
  return { draftId: created.draftId, env: patched, sceneId: scenesOf(patched)[0].id };
}

test('screen_recording without a recording is reported as a missing recording, not a missing image', () => {
  const { env, sceneId } = draftWithTechnique('screen_recording');
  const item = env.missing.find((m) => m.sceneId === sceneId);
  assert.ok(item, 'the row must be reported as missing');
  assert.equal(item.kind, 'recording');
  assert.match(item.reason, /screen recording/i);
  assert.equal(env.status, 'blocked');
});

test('footage_clip without footage is reported as a missing video asset', () => {
  const { env, sceneId } = draftWithTechnique('footage_clip');
  const item = env.missing.find((m) => m.sceneId === sceneId);
  assert.ok(item, 'the row must be reported as missing');
  assert.equal(item.kind, 'asset');
  assert.match(item.reason, /footage/i);
});

test('a still cannot be bound to a screen_recording row (refused at bind time, not at Apply)', () => {
  const { draftId, env, sceneId } = draftWithTechnique('screen_recording');
  const still = ownedImage('regression-still');
  let refused = null;
  try {
    svc.bindLocalImage(draftId, { expectedRevision: env.revision, sceneId, assetId: still });
  } catch (err) {
    refused = err;
  }
  assert.ok(refused, 'binding a still to a recording row must be refused');
  assert.equal(refused.status, 409);
  // The draft must be unchanged: still blocked, nothing bound, revision untouched.
  const after = svc.getDraft(draftId);
  assert.equal(after.revision, env.revision);
  assert.equal(scenesOf(after)[0].assetId, null);
  assert.equal(after.status, 'blocked');
});

test('a still_image row still takes a still, and then the draft can be ready', () => {
  const { draftId, env, sceneId } = draftWithTechnique('still_image');
  const still = ownedImage('control-still');
  const bound = svc.bindLocalImage(draftId, { expectedRevision: env.revision, sceneId, assetId: still });
  assert.equal(scenesOf(bound).find((s) => s.id === sceneId).assetId, still);
  assert.equal(bound.missing.filter((m) => m.sceneId === sceneId).length, 0);
});

test('control: the repaired rule does not loosen a real Apply', async () => {
  const { draftId, env } = draftWithTechnique('screen_recording');
  await assert.rejects(
    () => svc.applyDraft(draftId, { expectedRevision: env.revision }),
    (err) => err.code === 'FACTORY_INPUTS_REQUIRED' || err.status >= 400,
  );
});

test.after?.(() => store.cleanup());
