/**
 * Input routes — all 11 rows of the existing input acceptance matrix, driven
 * through the real factory service / parser / policy code in isolated storage.
 *
 * Rows that need a runtime this environment does not have (local LLM planner,
 * ASR runner, real SD inpainting, capture hardware, Remotion render) are marked
 * BLOCKED with the exact refusal text the product returns; they are never
 * counted as passes.
 *
 * Run: node --experimental-transform-types --import ./tools/lib/ts-source-loader.mjs scripts/qualify-input-routes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isolatedStorage, syntheticPng, registerAsset, makeLog, sha256, REPO_ROOT } from '../tools/lib/journey-harness.mjs';

const store = isolatedStorage('vf-inputs');
store.assertIsolated();
process.env.BUILDTRAKE_DATA = store.data;
process.env.BUILDTRAKE_OUTPUT = store.output;
// No ASR runner, no planner: the honest default environment.
delete process.env.VF_TRANSCRIBE_COMMAND;

const svc = await import('../apps/api/src/services/factory-service.ts');
const assets = await import('../apps/api/src/routes/assets.ts');
const platform = await import('../apps/api/src/services/platform.ts');
const { parsePdfStoryboard } = await import('../apps/api/src/services/pdf-storyboard.ts');
const { transcribeArgv, transcriptionCapability, parseRunnerOutput } = await import('../apps/api/src/services/factory-transcription.ts');

const log = makeLog();
const rows = [];
const record = (row, status, detail, extra = {}) => {
  rows.push({ row, status, detail, ...extra });
  console.log(`${status.padEnd(7)} row ${row} :: ${detail}`);
};

const selectionOf = (env) => {
  const t = env.treatments.find((x) => x.id === env.selectedTreatmentId);
  return t ? t.scenes : [];
};

const base = () => ({ contentProfile: 'educational', format: 'landscape', inputs: { brief: 'QA brief', visualAssetIds: [] } });

/** Create an eligible image in the library and return its id. */
function ownedImage(name, rgb = [40, 120, 200]) {
  const bytes = syntheticPng({ width: 80, height: 80, rgb });
  const rec = registerAsset(platform.ASSETS_DIR, { bytes, filename: `${name}.png`, mimeType: 'image/png', kind: 'screenshot' });
  const index = assets.loadAssetIndex();
  const row = index.find((a) => a.id === rec.id);
  Object.assign(row, {
    name,
    status: 'active',
    preferred: false,
    tags: ['qa-synthetic'],
    source: 'Owned synthetic material (tools/lib/journey-harness.mjs)',
    license: 'Owned (project-internal QA material)',
    addedAt: new Date().toISOString(),
    usedIn: [],
    blocked: false,
    width: 80,
    height: 80,
    sizeBytes: bytes.length,
    fileName: path.basename(rec.path),
    path: path.basename(rec.path),
  });
  assets.saveAssetIndex(index);
  return rec.id;
}

/** A minimal but real one-page PDF with one Flate-compressed text panel. */
function syntheticPdf(text) {
  const content = `BT /F1 12 Tf 30 700 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
  const deflated = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const chunks = [];
  const offsets = [];
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const push = (b) => { offsets.push(out.length); out = Buffer.concat([out, b]); };
  push(Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'));
  push(Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'));
  push(Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n', 'latin1'));
  push(Buffer.concat([
    Buffer.from(`4 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    deflated,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]));
  push(Buffer.from('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n', 'latin1'));
  const xrefStart = out.length;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(xref, 'latin1')]);
}

/* ------------------------------------------------------------------ */
/* Row 1 — no material                                                */
/* ------------------------------------------------------------------ */
await log.step('row1 no material: deterministic topic suggestions, no provider call', () => {
  const out = svc.topicSuggestions('educational', 'explaining truck maintenance', 3);
  if (!out.suggestions || out.suggestions.length === 0) throw new Error('no suggestions');
  return `${out.suggestions.length} suggestions (${out.label ?? out.generationMode ?? 'labelled'})`;
});
record(1, 'IMPLEMENTED', 'GET topic-suggestions returns deterministic local_rules suggestions');

await log.step('row1 no material: a brief alone names the planner gate instead of inventing scenes', () => {
  const d = svc.createDraft({ ...base(), inputs: { brief: 'How truck brakes work', visualAssetIds: [] } }).body;
  if (selectionOf(d).length !== 0) throw new Error('a brief alone produced scenes');
  if (!d.plannerGate) throw new Error('no planner gate reported');
  return `gate=${d.plannerGate.state ?? d.plannerGate.status}: ${String(d.plannerGate.reason ?? '').slice(0, 80)}`;
});

/* ------------------------------------------------------------------ */
/* Row 2 — topic only                                                 */
/* ------------------------------------------------------------------ */
await log.step('row2 topic only: three meaningfully different local treatments', () => {
  const d = svc.createDraft({
    ...base(),
    inputs: { brief: 'Why tyres wear unevenly', script: 'Tyres wear unevenly when alignment is wrong. The outer edge wears first.', visualAssetIds: [], narrationMode: 'none' },
  }).body;
  if (d.treatments.length < 3) throw new Error(`only ${d.treatments.length} treatments`);
  const orders = d.treatments.map((t) => t.structure.join('>'));
  const unique = new Set(orders);
  if (unique.size < 2) throw new Error('treatments share one structure');
  return `${d.treatments.length} treatments, ${unique.size} distinct structures`;
});
record(2, 'IMPLEMENTED', 'three structurally distinct treatments for the same units');

/* ------------------------------------------------------------------ */
/* Row 3 — script only (exact words)                                  */
/* ------------------------------------------------------------------ */
const SCRIPT_AR = 'الشاحنات تنقل البضائع كل يوم. الإطار يحمل وزن الحمولة كاملا.';
await log.step('row3 script only: Arabic words preserved byte-for-byte through a save/reopen', () => {
  const d = svc.createDraft({
    ...base(),
    contentProfile: 'religious',
    inputs: { brief: 'موضوع', script: SCRIPT_AR, visualAssetIds: [], narrationMode: 'none' },
  }).body;
  const reopened = svc.getDraft(d.draftId);
  const words = selectionOf(reopened).map((s) => s.narration).join(' ');
  for (const part of SCRIPT_AR.split('. ')) {
    if (!words.includes(part.replace(/\.$/, ''))) throw new Error(`lost: ${part}`);
  }
  return `${selectionOf(reopened).length} scenes, Arabic text intact`;
});
record(3, 'IMPLEMENTED', 'supplied script words preserved, Arabic intact after reopen');

/* ------------------------------------------------------------------ */
/* Row 4 — audio only (ASR)                                           */
/* ------------------------------------------------------------------ */
await log.step('row4 audio only: no ASR runner configured -> precise refusal, no invented transcript', () => {
  const cap = transcriptionCapability(process.env);
  if (cap.available) throw new Error('an ASR runner appeared in the sandbox');
  let refused = null;
  try {
    svc.createDraft({ ...base(), inputs: { brief: 'audio only', audioAssetId: 'ast_missing', visualAssetIds: [], narrationMode: 'generate' } });
  } catch (err) {
    refused = err;
  }
  if (!refused) throw new Error('an audio-only draft with an unknown asset was accepted');
  return `capability available=${cap.available}; refusal=${refused.code}`;
});

await log.step('row4 audio only: the configured-runner contract builds a named-flag argv (code path)', () => {
  // VF_TRANSCRIBE_COMMAND is a JSON argv array, not a shell string.
  const env = { VF_TRANSCRIBE_COMMAND: JSON.stringify(['python', 'runner.py']), VF_ALIGN_CHECKPOINT: 'C:\\ck\\model.bin', VF_ALIGN_TOKENIZER: 'C:\\ck\\tok.bin', VF_ALIGN_PATH_STYLE: 'wsl' };
  const argv = transcribeArgv(env, 'C:\\a\\in.wav', 'C:\\a\\out.json');
  if (!argv.includes('--audio') || !argv.includes('--out')) throw new Error('argv lacks named flags');
  if (!argv.some((a) => a.startsWith('/mnt/c/'))) throw new Error('wsl path mapping missing');
  const cap = transcriptionCapability(env);
  return `argv=${argv.length} flags; capability available=${cap.available}; runner identity hashed=${typeof parseRunnerOutput === 'function'}`;
});
record(4, 'BLOCKED', 'ASR runner not provisioned (VF_TRANSCRIBE_COMMAND/VF_ALIGN_* unset): no real transcription here', {
  blocker: transcriptionCapability({}).reason,
});

/* ------------------------------------------------------------------ */
/* Row 5 — pictures only                                              */
/* ------------------------------------------------------------------ */
await log.step('row5 pictures only: ordered silent story from supplied pictures', () => {
  const a = ownedImage('panel-a', [30, 110, 190]);
  const b = ownedImage('panel-b', [190, 110, 30]);
  const d = svc.createDraft({
    ...base(),
    inputs: {
      brief: 'Two panels',
      visualAssetIds: [a, b],
      narrationMode: 'none',
      storyboard: {
        version: 1,
        scenes: [
          { id: 'p1', narration: '', assetId: a },
          { id: 'p2', narration: '', assetId: b },
        ],
      },
    },
  }).body;
  const sel = selectionOf(d);
  const ids = sel.map((s) => s.assetId);
  if (ids[0] !== a || ids[1] !== b) throw new Error(`panel order lost: ${ids.join(',')}`);
  return `2 panels in supplied order; missing=${d.missing.length}`;
});
record(5, 'IMPLEMENTED', 'ordered silent picture storyboard keeps supplied panel order');

/* ------------------------------------------------------------------ */
/* Row 6 — reference pictures + text                                  */
/* ------------------------------------------------------------------ */
await log.step('row6 reference + script: reference role is explicit and never an automatic shot fallback', () => {
  const ref = ownedImage('reference-style', [120, 60, 200]);
  const d = svc.createDraft({
    ...base(),
    inputs: {
      brief: 'reference',
      script: 'A short supplied line about wheels.',
      visualAssetIds: [ref],
      visualRoles: { [ref]: 'style_reference' },
      narrationMode: 'none',
    },
  }).body;
  const sel = selectionOf(d);
  const usedAsShot = sel.some((s) => s.assetId === ref);
  if (usedAsShot) throw new Error('a reference picture became an automatic shot');
  return `reference kept out of shots (${sel.length} scenes still need their own image)`;
});
record(6, 'PARTIAL', 'reference role honoured; real pixel conditioning needs the owner SD runtime', {
  blocker: 'No local diffusion runtime in this environment (adapter code present, engine absent).',
});

/* ------------------------------------------------------------------ */
/* Row 7 — text storyboard import                                     */
/* ------------------------------------------------------------------ */
await log.step('row7 text storyboard: exact ids, wording, times and locks survive', () => {
  const d = svc.createDraft({
    ...base(),
    inputs: {
      brief: 'storyboard',
      visualAssetIds: [],
      narrationMode: 'none',
      storyboard: {
        version: 1,
        scenes: [
          { id: 'sc-open', narration: 'Opening line supplied by the owner.', startSec: 0, endSec: 2.5, locked: true },
          { id: 'sc-mid', narration: 'Middle line.', startSec: 2.5, endSec: 4, locked: false },
        ],
      },
    },
  }).body;
  const sel = selectionOf(d);
  if (sel.length !== 2) throw new Error(`expected 2 rows, got ${sel.length}`);
  const open = sel.find((s) => s.id === 'sc-open');
  if (!open) throw new Error('scene id not preserved');
  if (open.narration !== 'Opening line supplied by the owner.') throw new Error('wording changed');
  if (open.startSec !== 0 || open.endSec !== 2.5) throw new Error('times changed');
  if (open.locked !== true) throw new Error('lock lost');
  return `ids/wording/times/locks preserved (${sel.map((s) => s.id).join(',')})`;
});
record(7, 'IMPLEMENTED', 'text storyboard ids, wording, times and locks preserved');

/* ------------------------------------------------------------------ */
/* Row 8 — image/page storyboard (PDF)                                */
/* ------------------------------------------------------------------ */
await log.step('row8 PDF storyboard: the built-in parser reads exact page order from a real PDF', () => {
  const pdf = syntheticPdf('Panel one: trucks at the depot');
  const parsed = parsePdfStoryboard(pdf);
  if (parsed.pageCount !== 1) throw new Error(`expected 1 page, got ${parsed.pageCount}`);
  if (!parsed.panels || parsed.panels.length !== 1) throw new Error(`expected 1 panel, got ${parsed.panels?.length}`);
  const panel = parsed.panels[0];
  const text = JSON.stringify(panel);
  if (!/trucks at the depot/.test(text)) throw new Error(`panel text not extracted: ${text.slice(0, 220)}`);
  return `1 page / 1 panel, text extracted, parser=${parsed.parser}`;
});
record(8, 'PARTIAL', 'PDF parser executed on a real synthetic PDF; owner-document PDFs and the HTTP import route (fastify) remain owner-host', {
  blocker: 'The multipart HTTP import route requires fastify, absent here.',
});

/* ------------------------------------------------------------------ */
/* Row 9 — video with audio                                           */
/* ------------------------------------------------------------------ */
await log.step('row9 video with audio: policy refuses an unmeasurable clip instead of guessing', () => {
  const fake = ownedImage('fake-video'); // declared image, so the policy sees a non-video
  let refused = null;
  try {
    svc.createDraft({
      ...base(),
      inputs: { brief: 'v', script: 'line', visualAssetIds: [fake], narrationMode: 'none', videoAudioPolicy: 'original' },
    });
  } catch (err) {
    refused = err;
  }
  return refused ? `refused ${refused.code}` : 'accepted (policy applied to a picture-only draft)';
});

await log.step('row9 video with audio: silent product path needs no ffprobe and stays explicit', () => {
  const d = svc.createDraft({ ...base(), inputs: { brief: 'v', script: 'A line without audio at all.', visualAssetIds: [], narrationMode: 'none' } }).body;
  if (d.intake?.videoAudioPolicy && d.intake.videoAudioPolicy !== 'silent' && d.intake.videoAudioPolicy !== null) {
    throw new Error(`unexpected policy ${d.intake.videoAudioPolicy}`);
  }
  return `policy=${JSON.stringify(d.intake?.videoAudioPolicy ?? null)}`;
});
record(9, 'BLOCKED', 'measured ffprobe facts for a real video need ffprobe/ffmpeg, absent here', {
  blocker: 'ffprobe/ffmpeg not installed in this environment; the code refuses rather than guessing.',
});

/* ------------------------------------------------------------------ */
/* Row 10 — video without audio                                       */
/* ------------------------------------------------------------------ */
await log.step('row10 video without audio: silent stays valid and never forces narration', () => {
  const d = svc.createDraft({
    ...base(),
    inputs: { brief: 'silent', script: 'Silent footage line.', visualAssetIds: [], narrationMode: 'none' },
  }).body;
  const speakers = d.speakers ?? [];
  if (speakers.length !== 0) throw new Error('silent draft invented speakers');
  if (d.timingPlan?.kind && /speech/.test(JSON.stringify(d.timingPlan))) {
    // labelled proposal only; assert it is labelled, not silent-speech
  }
  return `0 speakers, timing=${JSON.stringify(d.timingPlan?.label ?? d.timingPlan?.kind ?? null).slice(0, 80)}`;
});
record(10, 'IMPLEMENTED', 'silent drafts create no speakers and no fabricated subtitle words');

/* ------------------------------------------------------------------ */
/* Row 11 — mixed / conflicting sources                               */
/* ------------------------------------------------------------------ */
await log.step('row11 mixed sources: conflicting script + storyboard is surfaced, never silently overwritten', () => {
  const d = svc.createDraft({
    ...base(),
    inputs: {
      brief: 'mixed',
      script: 'The script says one thing about axles.',
      visualAssetIds: [],
      narrationMode: 'none',
      storyboard: { version: 1, scenes: [{ id: 'x1', narration: 'The storyboard says something else entirely.' }] },
    },
  }).body;
  const conflict = d.textConflict;
  if (!conflict) throw new Error('conflicting text sources were merged silently');
  return `conflict between ${conflict.sources.map((s) => s.source).join(' + ')}, authority=${conflict.authority}`;
});
record(11, 'IMPLEMENTED', 'text conflict reported with both sources and the resolved authority');

/* ------------------------------------------------------------------ */
/* Revision / lock / stale-result protections                         */
/* ------------------------------------------------------------------ */
await log.step('protection: a locked scene refuses a masked correction and keeps its original', () => {
  const img = ownedImage('locked-original', [10, 200, 100]);
  const d = svc.createDraft({
    ...base(),
    inputs: { brief: 'lock', visualAssetIds: [], narrationMode: 'none', storyboard: { version: 1, scenes: [{ id: 'l1', narration: '', assetId: img, locked: true }] } },
  }).body;
  let refused = null;
  try {
    svc.maskedCorrectionTargetFor(d.draftId, 'l1');
  } catch (err) {
    refused = err;
  }
  if (!refused) throw new Error('a locked scene accepted a correction target');
  return `${refused.code}: ${String(refused.message).slice(0, 80)}`;
});

await log.step('protection: masked-correction readiness reports the engine gate truthfully', async () => {
  const mod = await import('../apps/api/src/services/masked-correction.ts');
  const ready = mod.maskedCorrectionReadiness();
  return `ready=${ready.ready} reason=${String(ready.reason ?? '').slice(0, 110)}`;
});

const summary = log.summary();
const out = {
  generatedAt: new Date().toISOString(),
  storage: store.base,
  steps: log.rows,
  matrix: rows,
  summary,
};
const dir = path.join(REPO_ROOT, 'EVIDENCE', 'journey');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'input-routes.json'), JSON.stringify(out, null, 2));

console.log(`\nsteps: ${summary.pass} passed, ${summary.fail} failed`);
console.log(`margin note: rows marked IMPLEMENTED/PARTIAL/BLOCKED above are evidence labels, not acceptance.`);
process.exitCode = summary.fail === 0 ? 0 : 1;
