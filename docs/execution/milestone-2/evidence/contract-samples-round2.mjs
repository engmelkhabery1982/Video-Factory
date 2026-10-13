// Captures trimmed, real responses from a running API (fixture media only) into contract-samples-round2.json.
// Usage: API_BASE=http://127.0.0.1:3100 FIXTURE_IDS=docs/execution/milestone-2/evidence/fixture-asset-ids.json node <this file>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3100';
const here = path.dirname(fileURLToPath(import.meta.url));
const ids = JSON.parse(fs.readFileSync(process.env.FIXTURE_IDS ?? path.join(here, 'fixture-asset-ids.json'), 'utf8'));

const SCRIPT = [
  'Many sites lose a day when a crane waits for a delivery nobody confirmed.',
  'For example, a concrete pour was booked for seven but the truck arrived at nine.',
  'Check the delivery window the night before and confirm it with the supplier.',
  'Write the confirmed time on the site board so every crew sees it.',
].join('\n');

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const draft = (over = {}) => ({
  contentProfile: 'educational',
  format: 'landscape',
  channelBrandId: null,
  inputs: { brief: 'Concrete delivery windows', script: SCRIPT, audioAssetId: null, visualAssetIds: [ids.imgA, ids.imgB], storyboard: null },
  requestedSpeakers: [],
  referenceProjectId: null,
  ...over,
});

const trimEnvelope = (env) => ({
  ...env,
  treatments: env.treatments.slice(0, 1).map((t) => ({ ...t, scenes: t.scenes.slice(0, 2) })),
  warnings: env.warnings.slice(0, 2),
  _treatmentsShown: `1 of ${env.treatments.length}`,
});

const out = { note: 'Trimmed real responses from an isolated live API run on fixture media only. Not owner evidence.', base: BASE, capturedAt: new Date().toISOString() };

// 1. Educational landscape draft.
const created = await call('POST', '/api/factory/drafts', draft());
out.createEducationalLandscape = { status: created.status, body: trimEnvelope(created.body) };

// 2. Stale revision: bump the revision with an explicit selection save, then apply with the old revision.
const first = created.body;
const bumped = await call('PATCH', `/api/factory/drafts/${first.draftId}`, {
  expectedRevision: first.revision,
  selectedTreatmentId: first.selectedTreatmentId,
  scenes: first.treatments.find((t) => t.id === first.selectedTreatmentId).scenes,
  speakers: first.speakers.map((s) => ({ id: s.id, voiceId: s.voiceId })),
});
const stale = await call('POST', `/api/factory/drafts/${first.draftId}/apply`, { expectedRevision: first.revision });
out.staleRevisionApply = { patchStatus: bumped.status, status: stale.status, body: stale.body };

// 3. Apply at the current revision: creates a derived project.
const applied = await call('POST', `/api/factory/drafts/${first.draftId}/apply`, { expectedRevision: bumped.body.revision });
out.applyLandscape = { status: applied.status, body: applied.body };
if (applied.status === 201) {
  const ed = await call('GET', `/api/projects/${applied.body.projectId}/editor`);
  const doc = ed.body.document ?? ed.body;
  out.editorDocumentLandscapeExcerpt = {
    status: ed.status,
    format: doc.format,
    targetId: doc.targetId,
    alignment: doc.alignment,
    durationSec: doc.durationSec,
    audioClipsShown: doc.audioClips.slice(0, 2).map((c) => ({ id: c.id, speakerId: c.speakerId, approved: c.approved, sourceOutSec: c.sourceOutSec })),
    visualClipsShown: doc.visualClips.slice(0, 2).map((c) => ({ id: c.id, crop: c.crop, motion: c.motion })),
  };
}

// 4. Portrait apply keeps the requested format.
const port = await call('POST', '/api/factory/drafts', draft({ format: 'portrait' }));
const portApply = await call('POST', `/api/factory/drafts/${port.body.draftId}/apply`, { expectedRevision: port.body.revision });
out.applyPortrait = { status: portApply.status, body: portApply.body };

// 5. Refusals.
out.religiousBuildTrackRefused = await call('POST', '/api/factory/drafts', draft({ contentProfile: 'religious', channelBrandId: 'buildtrack' }));
const brief = await call('POST', '/api/factory/drafts', draft({ inputs: { brief: 'Only a brief', script: null, audioAssetId: null, visualAssetIds: [], storyboard: null } }));
out.briefOnlyDraft = { status: brief.status, body: trimEnvelope(brief.body) };
out.briefOnlyApply = await call('POST', `/api/factory/drafts/${brief.body.draftId}/apply`, { expectedRevision: brief.body.revision });
out.unknownDraft = await call('GET', '/api/factory/drafts/dft_0000000000000000');
out.unknownVisualAsset = await call('POST', '/api/factory/drafts', draft({ inputs: { brief: 'x', script: SCRIPT, audioAssetId: null, visualAssetIds: ['no-such-asset'], storyboard: null } }));

fs.writeFileSync(path.join(here, 'contract-samples-round2.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote contract-samples-round2.json');
console.log(JSON.stringify({
  create: out.createEducationalLandscape.status,
  stalePatch: out.staleRevisionApply.patchStatus,
  staleApply: out.staleRevisionApply.status,
  apply: out.applyLandscape.body,
  portrait: out.applyPortrait.body,
  ident: out.religiousBuildTrackRefused.status,
  briefApply: out.briefOnlyApply.body,
  notFound: out.unknownDraft.status,
  badAsset: out.unknownVisualAsset.status,
}));
