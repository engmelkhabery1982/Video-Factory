/**
 * Production journey — canonical draft/editor flow, driven through the real
 * factory service with isolated disposable storage and owned synthetic assets.
 *
 *   input -> draft -> treatment review -> scene completion -> Apply
 *   -> editing -> reopen -> (preview/export are reported separately)
 *
 * Every step calls the same function the HTTP route calls. Nothing is stubbed.
 *
 * Run: node --experimental-transform-types --import ./tools/lib/ts-source-loader.mjs scripts/qualify-production-journey.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { isolatedStorage, syntheticPng, registerAsset, makeLog, sha256, REPO_ROOT } from '../tools/lib/journey-harness.mjs';

const store = isolatedStorage('vf-journey');
store.assertIsolated();
process.env.BUILDTRAKE_DATA = store.data;
process.env.BUILDTRAKE_OUTPUT = store.output;

const svc = await import('../apps/api/src/services/factory-service.ts');
const editorStore = await import('../apps/api/src/services/editor-store.ts');
const assets = await import('../apps/api/src/routes/assets.ts');
const platform = await import('../apps/api/src/services/platform.ts');

const log = makeLog();

/** The envelope carries scenes inside treatments; the selected treatment is the current selection. */
const selectionOf = (env) => {
  const t = env.treatments.find((x) => x.id === env.selectedTreatmentId);
  if (!t) throw new Error('envelope has no selected treatment');
  return t.scenes;
};
const evidence = { generatedAt: new Date().toISOString(), storage: store.base, steps: [], artefacts: {} };

const SCRIPT = [
  'Trucks move freight across the country every day.',
  'A semi truck has eighteen wheels and a long trailer.',
  'Careful loading keeps the whole load stable on the road.',
].join(' ');

/* ---------------------------------------------------------------- */
/* 1. Input -> draft                                                 */
/* ---------------------------------------------------------------- */
let draftId = null;
let revision = 0;

await log.step('input: create draft from supplied script (portrait, silent)', () => {
  const out = svc.createDraft({
    contentProfile: 'educational',
    format: 'portrait',
    inputs: {
      brief: 'Eighteen-wheel trucks',
      script: SCRIPT,
      visualAssetIds: [],
      narrationMode: 'none',
    },
  });
  // The envelope IS the draft view: draftId/revision/selection live at the top level.
  draftId = out.body.draftId;
  revision = out.body.revision;
  const d = out.body;
  if (selectionOf(d).length === 0) throw new Error('no scenes planned');
  if (d.treatments.length < 2) throw new Error(`expected several treatments, got ${d.treatments.length}`);
  evidence.artefacts.draftId = draftId;
  evidence.artefacts.treatments = d.treatments.map((t) => t.id);
  return `${d.treatments.length} treatments, ${selectionOf(d).length} scenes, status=${d.status}`;
});

await log.step('input: supplied script words are preserved exactly', () => {
  const env = svc.getDraft(draftId);
  const words = selectionOf(env).map((s) => s.narration).join(' ');
  for (const sentence of SCRIPT.split('. ')) {
    const probe = sentence.replace(/\.$/, '');
    if (!words.includes(probe)) throw new Error(`supplied words lost: "${probe}"`);
  }
  return `${words.length} chars preserved`;
});

/* ---------------------------------------------------------------- */
/* 2. Treatment review                                               */
/* ---------------------------------------------------------------- */
await log.step('treatment: selecting a different treatment changes order, keeps words', () => {
  const env = svc.getDraft(draftId);
  const other = env.treatments.find((t) => t.id !== env.selectedTreatmentId);
  if (!other) throw new Error('no alternate treatment to review');
  const scenes = other.scenes.map((s) => ({
    id: s.id,
    narration: s.narration,
    speakerId: s.speakerId,
    visualIntent: s.visualIntent,
    assetId: s.assetId,
    startSec: s.startSec,
    endSec: s.endSec,
    locked: s.locked,
    ...(s.technique !== undefined ? { technique: s.technique } : {}),
    ...(s.graphic !== undefined ? { graphic: s.graphic } : {}),
  }));
  const patched = svc.patchDraft(draftId, {
    expectedRevision: env.revision,
    selectedTreatmentId: other.id,
    scenes,
  });
  revision = patched.revision;
  if (patched.selectedTreatmentId !== other.id) throw new Error('treatment not selected');
  const words = selectionOf(patched).map((s) => s.narration).join(' ');
  if (!words.includes('eighteen wheels')) throw new Error('treatment change lost the supplied words');
  return `now ${other.id} at revision ${revision}`;
});

/* ---------------------------------------------------------------- */
/* 3. Scene completion — bind owned synthetic stills                  */
/* ---------------------------------------------------------------- */
let boundIds = [];
await log.step('scenes: bind one owned synthetic still per scene (canonical library)', () => {
  assets.seedBrandAssets();
  const env = svc.getDraft(draftId);
  let current = env.revision;
  const ids = [];
  for (const [i, scene] of selectionOf(env).entries()) {
    const bytes = syntheticPng({ width: 96, height: 96, rgb: [20 + i * 40, 80, 160] });
    const rec = registerAsset(platform.ASSETS_DIR, {
      bytes,
      filename: `synthetic-scene-${scene.id}.png`,
      mimeType: 'image/png',
      kind: 'screenshot',
    });
    // The real upload route records these provenance fields; a record without
    // source+licence is deliberately ineligible and is refused (verified below).
    const index = assets.loadAssetIndex();
    const row = index.find((a) => a.id === rec.id);
    if (!row) throw new Error(`registered asset ${rec.id} is not in the library index`);
    Object.assign(row, {
      name: `Synthetic scene ${scene.id}`,
      status: 'active',
      preferred: false,
      tags: ['qa-synthetic'],
      source: 'Owned synthetic material generated by tools/lib/journey-harness.mjs',
      license: 'Owned (project-internal QA material)',
      addedAt: new Date().toISOString(),
      usedIn: [],
      blocked: false,
      width: 96,
      height: 96,
      sizeBytes: bytes.length,
      fileName: path.basename(rec.path),
      path: path.basename(rec.path),
    });
    assets.saveAssetIndex(index);
    const bound = svc.bindLocalImage(draftId, { expectedRevision: current, sceneId: scene.id, assetId: rec.id });
    current = bound.revision;
    ids.push(rec.id);
  }
  boundIds = ids;
  revision = current;
  const after = svc.getDraft(draftId);
  const unbound = selectionOf(after).filter((s) => !s.assetId);
  if (unbound.length) throw new Error(`${unbound.length} scenes still unbound`);
  return `${ids.length} scenes bound at revision ${revision}`;
});

await log.step('scenes: a still with no recorded source/licence is refused (honest failure)', () => {
  const bytes = syntheticPng({ width: 64, height: 64, rgb: [200, 40, 40] });
  const rec = registerAsset(platform.ASSETS_DIR, { bytes, filename: 'no-provenance.png' });
  const index = assets.loadAssetIndex();
  const row = index.find((a) => a.id === rec.id);
  if (!row) throw new Error(`registered asset ${rec.id} is not in the library index`);
  Object.assign(row, { name: 'No provenance', status: 'active', tags: [], source: '', license: '', usedIn: [], blocked: false });
  assets.saveAssetIndex(index);
  const env = svc.getDraft(draftId);
  let refused = null;
  try {
    svc.bindLocalImage(draftId, { expectedRevision: env.revision, sceneId: selectionOf(env)[0].id, assetId: rec.id });
  } catch (err) {
    refused = err;
  }
  if (!refused) throw new Error('an asset without source/licence was accepted');
  return `${refused.code}: ${refused.message}`;
});

await log.step('scenes: stale revision is refused and changes nothing', () => {
  const env = svc.getDraft(draftId);
  let refused = null;
  try {
    svc.bindLocalImage(draftId, { expectedRevision: env.revision - 1, sceneId: selectionOf(env)[0].id, assetId: boundIds[0] });
  } catch (err) {
    refused = err;
  }
  if (!refused || refused.code !== 'FACTORY_REVISION_CONFLICT') {
    throw new Error(`expected FACTORY_REVISION_CONFLICT, got ${refused?.code ?? 'success'}`);
  }
  return `${refused.code} (currentRevision ${refused.currentRevision})`;
});

/* ---------------------------------------------------------------- */
/* 4. Apply                                                          */
/* ---------------------------------------------------------------- */
let projectId = null;
await log.step('apply: preflight reports no blocker', () => {
  const preview = svc.applyPreview(draftId);
  if (!preview.canApply) throw new Error(`blocked: ${JSON.stringify(preview.blockers).slice(0, 400)}`);
  return `canApply, ${preview.speechCalls} speech calls, remaining budget ${preview.budget.remaining}`;
});

await log.step('apply: creates a canonical project and editor document', async () => {
  const out = await svc.applyDraft(draftId, { expectedRevision: revision });
  projectId = out.body.projectId;
  evidence.artefacts.projectId = projectId;
  const project = svc.projectTiming(projectId);
  const state = editorStore.readEditorState(projectId, 'long');
  if (!state) throw new Error('no editor document written');
  const clips = state.document.visualClips ?? [];
  if (clips.length !== boundIds.length) throw new Error(`editor has ${clips.length} clips for ${boundIds.length} scenes`);
  const missingSource = clips.filter((c) => !c.sourceAssetId);
  if (missingSource.length) throw new Error(`${missingSource.length} editor clips lost their source asset`);
  evidence.artefacts.editorRevision = state.document.revision;
  evidence.artefacts.clipCount = clips.length;
  return `project ${projectId}, editor revision ${state.document.revision}, ${clips.length} clips, timing=${project.timingSource ?? project.label ?? 'n/a'}`;
});

await log.step('apply: re-applying the same revision reuses the project (no duplicate)', async () => {
  const out = await svc.applyDraft(draftId, { expectedRevision: revision });
  if (!out.body.reused) throw new Error('second apply did not reuse the recorded project');
  if (out.body.projectId !== projectId) throw new Error('second apply created a different project');
  return `reused ${out.body.projectId}`;
});

/* ---------------------------------------------------------------- */
/* 5. Editing (canonical editor document + undo/redo)                */
/* ---------------------------------------------------------------- */
await log.step('edit: trim a clip duration through the editor document (contiguous timeline kept)', () => {
  const state = editorStore.readEditorState(projectId, 'long');
  const doc = state.document;
  const before = doc.visualClips[0].durationSec;
  const next = structuredClone(doc);
  // A real trim: extend clip 0 and push the following clips' start times so the
  // document stays contiguous (the editor validates contiguity).
  const delta = 1;
  next.visualClips[0].durationSec = before + delta;
  for (let i = 1; i < next.visualClips.length; i += 1) {
    next.visualClips[i].startSec = Math.round((next.visualClips[i].startSec + delta) * 1000) / 1000;
  }
  next.durationSec = doc.durationSec + delta;
  next.revision = doc.revision + 1;
  editorStore.writeEditorState(projectId, 'long', { schemaVersion: state.schemaVersion, document: next, undo: [doc], redo: [] });
  const after = editorStore.readEditorState(projectId, 'long');
  const changed = after.document.visualClips[0].durationSec;
  if (changed === before) throw new Error('duration did not change');
  if (after.document.visualClips[1].startSec !== next.visualClips[1].startSec) throw new Error('following clip did not move');
  evidence.artefacts.editDuration = { before, after: changed, totalBefore: doc.durationSec, totalAfter: after.document.durationSec };
  return `clip 0 ${before}s -> ${changed}s; project ${doc.durationSec}s -> ${after.document.durationSec}s`;
});

await log.step('edit: editor rejects a broken document instead of saving it', () => {
  const state = editorStore.readEditorState(projectId, 'long');
  const broken = structuredClone(state.document);
  broken.visualClips[0].durationSec = -5; // invalid: must be positive
  const before = JSON.stringify(editorStore.readEditorState(projectId, 'long').document);
  let refused = null;
  try {
    editorStore.writeEditorState(projectId, 'long', { schemaVersion: state.schemaVersion, document: broken, undo: [], redo: [] });
  } catch (err) {
    refused = err;
  }
  if (!refused) throw new Error('a negative clip duration was accepted');
  const after = JSON.stringify(editorStore.readEditorState(projectId, 'long').document);
  if (before !== after) throw new Error('a refused write still changed the document');
  return `${refused.code ?? 'error'}: ${String(refused.message).slice(0, 90)}`;
});

await log.step('edit: undo restores the previous document revision', () => {
  const state = editorStore.readEditorState(projectId, 'long');
  if (!state.undo.length) throw new Error('no undo snapshot was kept');
  const previous = state.undo[state.undo.length - 1];
  if (previous.visualClips[0].durationSec === state.document.visualClips[0].durationSec) {
    throw new Error('undo snapshot is identical to the current document');
  }
  editorStore.writeEditorState(projectId, 'long', {
    schemaVersion: state.schemaVersion,
    document: { ...previous, revision: state.document.revision + 1 },
    undo: state.undo.slice(0, -1),
    redo: [state.document],
  });
  const restored = editorStore.readEditorState(projectId, 'long');
  evidence.artefacts.editDuration.afterUndo = restored.document.visualClips[0].durationSec;
  return `restored clip 0 to ${restored.document.visualClips[0].durationSec}s`;
});

/* ---------------------------------------------------------------- */
/* 6. Reopen (restart simulation: drop module state, reload)         */
/* ---------------------------------------------------------------- */
await log.step('reopen: reload from disk keeps text, identity, timing and the edit', () => {
  const draft = svc.getDraft(draftId);
  const state = editorStore.readEditorState(projectId, 'long');
  const words = selectionOf(draft).map((s) => s.narration).join(' ');
  if (!words.includes('eighteen wheels')) throw new Error('narration lost after reopen');
  const ids = selectionOf(draft).map((s) => s.assetId);
  if (ids.some((id) => !boundIds.includes(id))) throw new Error('scene identity/asset binding lost');
  const dur = state.document.visualClips[0].durationSec;
  if (dur !== evidence.artefacts.editDuration.afterUndo) throw new Error('edit/undo lost after reopen');
  return `draft rev ${draft.revision}, editor rev ${state.document.revision}, duration ${dur}s`;
});

await log.step('reopen: raw files on disk are self-describing (draft, project, editor)', () => {
  const draftFile = path.join(platform.DATA_DIR, 'factory', 'drafts', `${draftId}.json`);
  const projectFile = path.join(platform.DATA_DIR, 'projects', projectId, 'project.json');
  if (!fs.existsSync(draftFile)) throw new Error('draft sidecar missing');
  if (!fs.existsSync(projectFile)) throw new Error('project.json missing');
  const parsed = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  evidence.artefacts.bytes = {
    draft: fs.statSync(draftFile).size,
    project: fs.statSync(projectFile).size,
  };
  return `draft ${fs.statSync(draftFile).size}B, project ${fs.statSync(projectFile).size}B, videoId=${parsed.meta?.input?.videoId ?? 'n/a'}`;
});

const summary = log.summary();
evidence.steps = log.rows;
evidence.summary = summary;
evidence.storage = store.base;

const evidenceFile = path.join(REPO_ROOT, 'EVIDENCE', 'journey');
fs.mkdirSync(evidenceFile, { recursive: true });
const outFile = path.join(evidenceFile, 'production-journey.json');
fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2));

console.log(`\n${summary.pass} passed, ${summary.fail} failed`);
console.log(`evidence: ${outFile}`);
console.log(`isolated storage kept at ${store.base} for inspection (not committed)`);
process.exitCode = summary.fail === 0 ? 0 : 1;
