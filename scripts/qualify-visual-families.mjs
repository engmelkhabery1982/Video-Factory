/**
 * Visual families — the seven required families, driven through the real
 * canonical draft -> Apply path in isolated storage.
 *
 * What this proves: the technique registry, graphic validation, the draft
 * pipeline and Apply accept and preserve each family's structured values, and
 * that a family with no supplied input is refused rather than faked.
 *
 * What this does NOT prove (stated so it is never mistaken for acceptance):
 * rendered pixels, direction quality, or any generated-video / 3D /
 * talking-character engine. Rendering needs Remotion + Chromium, absent here.
 *
 * Run: node --experimental-transform-types --import ./tools/lib/ts-source-loader.mjs scripts/qualify-visual-families.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { isolatedStorage, makeLog, REPO_ROOT } from '../tools/lib/journey-harness.mjs';

const store = isolatedStorage('vf-families');
store.assertIsolated();
process.env.BUILDTRAKE_DATA = store.data;
process.env.BUILDTRAKE_OUTPUT = store.output;

const svc = await import('../apps/api/src/services/factory-service.ts');
const core = await import('../packages/core/src/index.ts');

const log = makeLog();
const rows = [];
const record = (family, status, detail, extra = {}) => {
  rows.push({ family, status, detail, ...extra });
  console.log(`${status.padEnd(10)} ${family} :: ${detail}`);
};

const base = (extra = {}) => ({
  contentProfile: 'educational',
  format: 'landscape',
  ...extra,
});

const GRAPHIC_DEFAULTS = {
  schemaVersion: 1,
  title: null,
  background: '#0b1020',
  textColor: '#f5f7fa',
  accent: '#4da3ff',
  direction: 'ltr',
  scaleMax: null,
  actions: [],
};

/** Create a silent draft whose single scene carries this graphic, then Apply it. */
async function applyGraphic({ label, technique, graphic, narration = 'A supplied line for this shot.' }) {
  const created = svc.createDraft(
    base({
      inputs: {
        brief: label,
        script: narration,
        visualAssetIds: [],
        narrationMode: 'none',
      },
    }),
  ).body;
  const env = svc.getDraft(created.draftId);
  const scenes = (env.treatments.find((t) => t.id === env.selectedTreatmentId) ?? { scenes: [] }).scenes;
  const patchScenes = scenes.map((s, i) => ({
    id: s.id,
    narration: s.narration,
    speakerId: s.speakerId,
    visualIntent: s.visualIntent,
    assetId: null,
    startSec: s.startSec,
    endSec: s.endSec,
    locked: s.locked,
    ...(i === 0 ? { technique, graphic } : { technique: null, graphic: null }),
  }));
  const patched = svc.patchDraft(created.draftId, {
    expectedRevision: env.revision,
    selectedTreatmentId: env.selectedTreatmentId,
    scenes: patchScenes,
  });
  const after = svc.getDraft(created.draftId);
  const afterScenes = (after.treatments.find((t) => t.id === after.selectedTreatmentId) ?? { scenes: [] }).scenes;
  const first = afterScenes[0];
  if (first.technique !== technique) throw new Error(`technique not stored (${first.technique})`);
  if (JSON.stringify(first.graphic) !== JSON.stringify(graphic)) {
    throw new Error('graphic values were changed by the save');
  }
  const preview = svc.applyPreview(created.draftId);
  const graphicBlockers = preview.blockers.filter((b) => b.sceneId === first.id);
  if (graphicBlockers.length) throw new Error(`graphic scene blocked: ${graphicBlockers[0].reason}`);
  return { draftId: created.draftId, revision: after.revision, preview };
}

/* 1 — motion-graphics explainer (process_path) */
await log.step('family 1 motion-graphics explainer: process_path graphic survives save + preflight', async () => {
  const graphic = {
    ...GRAPHIC_DEFAULTS,
    kind: 'process_path',
    objects: [
      { id: 'n1', type: 'node', x: 0.12, y: 0.5, label: 'Inspect', color: '#4da3ff' },
      { id: 'n2', type: 'node', x: 0.40, y: 0.5, label: 'Tighten', color: '#4da3ff' },
      { id: 'n3', type: 'node', x: 0.68, y: 0.5, label: 'Verify', color: '#4da3ff' },
      { id: 'm1', type: 'marker', x: 0.12, y: 0.35, progress: 0 },
    ],
    actions: [{ id: 'a1', targetId: 'm1', property: 'progress', from: 0, to: 1, startSec: 0, endSec: 3, easing: 'linear' }],
  };
  const out = await applyGraphic({ label: 'process', technique: 'process_path', graphic });
  return `stored exactly, ${out.preview.blockers.length} total blockers, revision ${out.revision}`;
});
record('motion-graphics explainer', 'IMPLEMENTED', 'process_path values persist and pass Apply preflight; pixels need Remotion');

/* 2 — procedural 2D actors (actor_action) */
await log.step('family 2 procedural 2D actors: actor_action figure + timed arm action', async () => {
  const graphic = {
    ...GRAPHIC_DEFAULTS,
    kind: 'actor_action',
    objects: [
      { id: 'f1', type: 'figure', x: 0.4, y: 0.6, scale: 1, armAngle: 0, color: '#ffcc66' },
    ],
    actions: [{ id: 'a1', targetId: 'f1', property: 'armAngle', from: 0, to: 45, startSec: 0.5, endSec: 2.5, easing: 'ease_in_out' }],
  };
  const out = await applyGraphic({ label: 'actor', technique: 'actor_action', graphic });
  return `figure + arm action stored, revision ${out.revision}`;
});
record('procedural 2D actors', 'IMPLEMENTED', 'actor_action values persist; render needs Remotion. Not generated cinema, not lip-sync');

/* 3 — illustrated narrative (still_image) */
await log.step('family 3 illustrated narrative: a still shot refuses to apply with no image', () => {
  const created = svc.createDraft(
    base({ inputs: { brief: 'illustrated', script: 'One illustrated line.', visualAssetIds: [], narrationMode: 'none' } }),
  ).body;
  const env = svc.getDraft(created.draftId);
  const scenes = (env.treatments.find((t) => t.id === env.selectedTreatmentId) ?? { scenes: [] }).scenes;
  const patched = svc.patchDraft(created.draftId, {
    expectedRevision: env.revision,
    selectedTreatmentId: env.selectedTreatmentId,
    scenes: scenes.map((s) => ({ id: s.id, narration: s.narration, speakerId: s.speakerId, visualIntent: s.visualIntent, assetId: null, startSec: s.startSec, endSec: s.endSec, locked: s.locked, technique: 'still_image', graphic: null })),
  });
  const preview = svc.applyPreview(created.draftId);
  if (preview.canApply) throw new Error('a still_image family applied with no image at all');
  const reason = preview.blockers.find((b) => b.sceneId)?.reason ?? preview.blockers[0]?.reason ?? '';
  return `refused as designed: ${String(reason).slice(0, 100)}`;
});
record('illustrated narrative', 'PARTIAL', 'supplied-image path is wired and refuses an empty shot; local generation needs the owner SD runtime');

/* 4 — real screen tutorial (screen_recording) */
await log.step('family 4 real screen tutorial: a still is never accepted as a screen recording', () => {
  const created = svc.createDraft(
    base({ inputs: { brief: 'screen', script: 'A screen tutorial line.', visualAssetIds: [], narrationMode: 'none' } }),
  ).body;
  const env = svc.getDraft(created.draftId);
  const scenes = (env.treatments.find((t) => t.id === env.selectedTreatmentId) ?? { scenes: [] }).scenes;
  svc.patchDraft(created.draftId, {
    expectedRevision: env.revision,
    selectedTreatmentId: env.selectedTreatmentId,
    scenes: scenes.map((s) => ({ id: s.id, narration: s.narration, speakerId: s.speakerId, visualIntent: s.visualIntent, assetId: null, startSec: s.startSec, endSec: s.endSec, locked: s.locked, technique: 'screen_recording', graphic: null })),
  });
  const envAfter = svc.getDraft(created.draftId);
  const reason = envAfter.missing.find((b) => b.sceneId)?.reason ?? '';
  if (!/screen recording/i.test(String(reason))) throw new Error(`unexpected refusal: ${reason}`);
  const preview = svc.applyPreview(created.draftId);
  if (preview.canApply) throw new Error('screen_recording applied with no recording supplied');
  return `refused as designed: ${String(reason).slice(0, 100)}`;
});
record('real screen tutorial', 'BLOCKED', 'requires a real consented capture (G10) or a supplied recording; nothing is fabricated', {
  blocker: 'Native getDisplayMedia capture is unavailable here and is never performed implicitly.',
});

/* 5 — footage documentary (footage_clip) */
await log.step('family 5 footage documentary: footage_clip refuses with no supplied footage', () => {
  const created = svc.createDraft(
    base({ inputs: { brief: 'footage', script: 'A documentary line.', visualAssetIds: [], narrationMode: 'none' } }),
  ).body;
  const env = svc.getDraft(created.draftId);
  const scenes = (env.treatments.find((t) => t.id === env.selectedTreatmentId) ?? { scenes: [] }).scenes;
  svc.patchDraft(created.draftId, {
    expectedRevision: env.revision,
    selectedTreatmentId: env.selectedTreatmentId,
    scenes: scenes.map((s) => ({ id: s.id, narration: s.narration, speakerId: s.speakerId, visualIntent: s.visualIntent, assetId: null, startSec: s.startSec, endSec: s.endSec, locked: s.locked, technique: 'footage_clip', graphic: null })),
  });
  const preview = svc.applyPreview(created.draftId);
  if (preview.canApply) throw new Error('footage_clip applied with no footage');
  return `refused as designed: ${String(preview.blockers[0]?.reason ?? '').slice(0, 100)}`;
});
record('footage documentary', 'BLOCKED', 'needs a real supplied video and measured audio facts (ffprobe absent here)');

/* 6 — kinetic typography (kinetic_text) */
await log.step('family 6 kinetic typography: Arabic words preserved with RTL direction', async () => {
  const graphic = {
    ...GRAPHIC_DEFAULTS,
    kind: 'kinetic_text',
    direction: 'rtl',
    objects: [
      { id: 'w1', type: 'word', x: 0.5, y: 0.35, text: 'الشاحنة', emphasis: 'strong', size: 0.12 },
      { id: 'w2', type: 'word', x: 0.5, y: 0.55, text: 'تحمل', emphasis: 'normal', size: 0.09 },
    ],
    actions: [
      { id: 'a1', targetId: 'w1', property: 'opacity', from: 0, to: 1, startSec: 0, endSec: 0.6, easing: 'ease_out' },
      { id: 'a2', targetId: 'w2', property: 'opacity', from: 0, to: 1, startSec: 0.6, endSec: 1.2, easing: 'ease_out' },
    ],
  };
  const out = await applyGraphic({ label: 'kinetic', technique: 'kinetic_text', graphic, narration: 'الشاحنة تحمل.' });
  const reopened = svc.getDraft(out.draftId);
  const scenes = (reopened.treatments.find((t) => t.id === reopened.selectedTreatmentId) ?? { scenes: [] }).scenes;
  if (scenes[0].graphic.direction !== 'rtl') throw new Error('direction lost');
  if (scenes[0].graphic.objects[0].text !== 'الشاحنة') throw new Error('Arabic text lost');
  return 'RTL direction and Arabic words intact after reopen';
});
record('kinetic typography', 'IMPLEMENTED', 'kinetic_text stores exact words and RTL direction; render needs Remotion');

/* 7 — mixed treatment */
await log.step('family 7 mixed scenes: a graphic scene and a supplied-image scene coexist in one draft', async () => {
  const graphic = {
    ...GRAPHIC_DEFAULTS,
    kind: 'numeric_comparison',
    scaleMax: 100,
    objects: [
      { id: 'b1', type: 'bar', x: 0.2, y: 0.7, w: 0.1, label: 'Diesel', value: 12.3456, unit: 'mpg', decimals: 3, color: '#4da3ff' },
      { id: 'b2', type: 'bar', x: 0.5, y: 0.7, w: 0.1, label: 'Electric', value: 88.2, unit: 'mpge', decimals: 1, color: '#66dd88' },
    ],
    actions: [{ id: 'a1', targetId: 'b1', property: 'progress', from: 0, to: 1, startSec: 0, endSec: 1, easing: 'linear' }],
  };
  const created = svc.createDraft(
    base({ inputs: { brief: 'mixed', script: 'First a comparison. Second a supplied picture.', visualAssetIds: [], narrationMode: 'none' } }),
  ).body;
  const env = svc.getDraft(created.draftId);
  const scenes = (env.treatments.find((t) => t.id === env.selectedTreatmentId) ?? { scenes: [] }).scenes;
  if (scenes.length < 2) throw new Error('need at least two scenes for a mixed treatment');
  const patched = svc.patchDraft(created.draftId, {
    expectedRevision: env.revision,
    selectedTreatmentId: env.selectedTreatmentId,
    scenes: scenes.map((s, i) => ({
      id: s.id, narration: s.narration, speakerId: s.speakerId, visualIntent: s.visualIntent,
      assetId: null, startSec: s.startSec, endSec: s.endSec, locked: s.locked,
      ...(i === 0 ? { technique: 'numeric_comparison', graphic } : { technique: 'still_image', graphic: null }),
    })),
  });
  const after = svc.getDraft(created.draftId);
  const rowsNow = (after.treatments.find((t) => t.id === after.selectedTreatmentId) ?? { scenes: [] }).scenes;
  if (rowsNow[0].technique !== 'numeric_comparison' || rowsNow[1].technique !== 'still_image') {
    throw new Error(`mixed techniques lost: ${rowsNow.map((r) => r.technique).join(',')}`);
  }
  // The exact numeric value must survive: 12.3456 is not rounded to 12.3.
  const bar = rowsNow[0].graphic.objects.find((o) => o.id === 'b1');
  if (bar.value !== 12.3456) throw new Error(`numeric value changed: ${bar.value}`);
  const preview = svc.applyPreview(created.draftId);
  const imageBlocked = preview.blockers.some((b) => b.sceneId === rowsNow[1].id);
  return `two families in one draft; exact value 12.3456 kept; image shot blocked=${imageBlocked}`;
});
record('mixed treatment', 'IMPLEMENTED', 'graphic + image techniques coexist and keep exact numeric values');

/* Registry coverage: every required family maps to a real technique or an honest gate */
await log.step('registry: each of the seven families resolves to a registered technique', () => {
  const ids = Object.keys(core.VISUAL_TECHNIQUES);
  const required = ['process_path', 'numeric_comparison', 'actor_action', 'kinetic_text', 'still_image', 'footage_clip', 'screen_recording'];
  const missing = required.filter((r) => !ids.includes(r));
  if (missing.length) throw new Error(`missing techniques: ${missing.join(',')}`);
  const gates = required.map((r) => `${r}=${core.VISUAL_TECHNIQUES[r].capability}`).join(' ');
  return gates;
});
record('registry', 'IMPLEMENTED', 'all seven techniques registered with an explicit capability label');

/* Distinct direction, not a repeated slideshow */
await log.step('direction: different content profiles produce different treatment structures', () => {
  const script = 'First point. Second point. Third point.';
  const seen = {};
  for (const profile of ['religious', 'educational', 'promotional']) {
    const d = svc.createDraft({ contentProfile: profile, format: 'landscape', inputs: { brief: 'x', script, visualAssetIds: [], narrationMode: 'none' } }).body;
    seen[profile] = d.treatments.map((t) => t.id).join('|');
  }
  const unique = new Set(Object.values(seen));
  if (unique.size < 2) throw new Error('all profiles share one treatment set');
  return `${unique.size} distinct treatment sets across 3 profiles`;
});
record('direction', 'PARTIAL', 'treatment sets differ by profile in code; visual direction quality is an owner review gate');

const summary = log.summary();
const dir = path.join(REPO_ROOT, 'EVIDENCE', 'journey');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'visual-families.json'), JSON.stringify({ generatedAt: new Date().toISOString(), storage: store.base, steps: log.rows, families: rows, summary }, null, 2));
console.log(`\n${summary.pass} passed, ${summary.fail} failed`);
process.exitCode = summary.fail === 0 ? 0 : 1;
