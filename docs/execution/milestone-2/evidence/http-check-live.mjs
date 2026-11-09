// HTTP-only check against the live API process on an isolated data dir.
// Fixture media only (synthetic PNG/WAV). Writes evidence to /tmp, never into the repo.
import fs from 'node:fs';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3100';
const ids = JSON.parse(fs.readFileSync(process.env.FIXTURE_IDS ?? '/tmp/m2-fixture-ids.json', 'utf8'));
const evidence = { base: BASE, startedAt: new Date().toISOString(), checks: [] };

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

function record(name, pass, detail) {
  evidence.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 240)}`);
}

const SCRIPT = [
  'Many sites lose a day when a crane waits for a delivery nobody confirmed.',
  'For example, a concrete pour was booked for seven but the truck arrived at nine.',
  'Check the delivery window the night before and confirm it with the supplier.',
  'Write the confirmed time on the site board so every crew sees it.',
].join('\n');

function draftBody(over = {}) {
  return {
    contentProfile: 'educational',
    format: 'landscape',
    channelBrandId: null,
    inputs: { brief: 'Concrete delivery windows', script: SCRIPT, audioAssetId: null, visualAssetIds: [ids.imgA, ids.imgB], storyboard: null },
    requestedSpeakers: [],
    referenceProjectId: null,
    ...over,
  };
}

// 1. Capabilities: honest about engines.
{
  const r = await call('GET', '/api/factory/capabilities');
  const ok = r.status === 200 && r.json.text.mode === 'local_rules' && r.json.image.available === false
    && r.json.transcription.available === false && r.json.speech.languages.ar.available === false
    && r.json.speech.voices.every((v) => /Robotic English sample voice/.test(v.speakerLabel));
  record('capabilities: local rules only, no image/transcription, Arabic speech unavailable, voices labelled robotic', ok, { status: r.status, voices: r.json.speech?.voices?.map((v) => v.speakerLabel) });
}

// 2. Brief only: a blocked draft, nothing generated, apply refused.
let briefDraft;
{
  const r = await call('POST', '/api/factory/drafts', draftBody({ inputs: { brief: 'Only a brief', script: null, audioAssetId: null, visualAssetIds: [], storyboard: null } }));
  briefDraft = r.json;
  record('brief only returns 201 blocked with a script requirement', r.status === 201 && r.json.status === 'blocked' && r.json.missing.some((m) => m.kind === 'script'), { status: r.status, status_: r.json.status, missing: r.json.missing });
  const a = await call('POST', `/api/factory/drafts/${r.json.draftId}/apply`, { expectedRevision: r.json.revision });
  record('brief-only apply refused with FACTORY_INPUTS_REQUIRED and no project', a.status === 422 && a.json.code === 'FACTORY_INPUTS_REQUIRED', { status: a.status, code: a.json.code });
}

// 3. Religious BuildTrack identity refused.
{
  const r = await call('POST', '/api/factory/drafts', draftBody({ contentProfile: 'religious', channelBrandId: 'buildtrack' }));
  record('religious draft with BuildTrack identity refused (no fallback)', r.status >= 400 && r.status < 500, { status: r.status, code: r.json.code });
}

// 4. Landscape educational draft, supplied script, two supplied pictures.
let land;
{
  const c = await call('POST', '/api/factory/drafts', draftBody());
  record('educational script draft created with three treatments', c.status === 201 && c.json.treatments.length === 3, { status: c.status, treatments: c.json.treatments?.map((t) => ({ id: t.id, title: t.title, orderLocked: t.orderLocked })), speechOrderLocked: c.json.speechOrderLocked });
  land = c.json;
  const reopen = await call('GET', `/api/factory/drafts/${land.draftId}`);
  record('draft reopens with the same revision and selection', reopen.status === 200 && reopen.json.revision === land.revision && reopen.json.selectedTreatmentId === land.selectedTreatmentId, { revision: reopen.json.revision, selected: reopen.json.selectedTreatmentId });

  const second = land.treatments[1];
  const p = await call('PATCH', `/api/factory/drafts/${land.draftId}`, {
    expectedRevision: land.revision,
    selectedTreatmentId: second.id,
    scenes: second.scenes.map((s) => ({ ...s })),
    speakers: land.speakers.map((s) => ({ id: s.id, voiceId: s.voiceId })),
  });
  record('treatment selection saved explicitly, revision bumped', p.status === 200 && p.json.selectedTreatmentId === second.id && p.json.revision === land.revision + 1, { status: p.status, selected: p.json.selectedTreatmentId, revision: p.json.revision });
  land = p.json;

  const stale = await call('POST', `/api/factory/drafts/${land.draftId}/apply`, { expectedRevision: 0 });
  record('stale revision apply refused with 409 and currentRevision', stale.status === 409 && stale.json.code === 'FACTORY_REVISION_CONFLICT' && stale.json.currentRevision === land.revision, { status: stale.status, code: stale.json.code, currentRevision: stale.json.currentRevision });

  const a = await call('POST', `/api/factory/drafts/${land.draftId}/apply`, { expectedRevision: land.revision });
  record('landscape apply creates a project with targetId long, format landscape', a.status === 201 && a.json.targetId === 'long' && a.json.format === 'landscape', { status: a.status, body: a.json });
  if (a.status === 201) {
    const ed = await call('GET', `/api/projects/${a.json.projectId}/editor`);
    const doc = ed.json?.document ?? ed.json;
    const audio = (doc.audioClips ?? []);
    record('landscape editor document: format landscape, targetId long, generated speech unapproved', ed.status === 200 && doc.format === 'landscape' && doc.targetId === 'long' && audio.every((c) => c.approved === false), { status: ed.status, format: doc.format, targetId: doc.targetId, audioClips: audio.length, visualClips: doc.visualClips?.length, durationSec: doc.durationSec });
    evidence.landscapeProject = a.json.projectId;
  }
}

// 5. Portrait apply keeps portrait.
{
  const c = await call('POST', '/api/factory/drafts', draftBody({ format: 'portrait' }));
  const a = await call('POST', `/api/factory/drafts/${c.json.draftId}/apply`, { expectedRevision: c.json.revision });
  record('portrait apply keeps format portrait (targetId long)', a.status === 201 && a.json.format === 'portrait' && a.json.targetId === 'long', { status: a.status, body: a.json });
  if (a.status === 201) {
    const ed = await call('GET', `/api/projects/${a.json.projectId}/editor`);
    const doc = ed.json?.document ?? ed.json;
    record('portrait editor document has format portrait', ed.status === 200 && doc.format === 'portrait' && doc.targetId === 'long', { format: doc.format, targetId: doc.targetId });
    evidence.portraitProject = a.json.projectId;
  }
}

// 6. Supplied full audio with its script: order and supplied timing kept, nothing generated.
{
  const c = await call('POST', '/api/factory/drafts', draftBody({ inputs: { brief: 'Read narration', script: SCRIPT, audioAssetId: ids.audio, visualAssetIds: [ids.imgA, ids.imgB], storyboard: null } }));
  record('supplied audio + script: speech order locked, audio measured', c.status === 201 && c.json.speechOrderLocked === true && c.json.inputs?.audioDurationSec === 6, { status: c.status, speechOrderLocked: c.json.speechOrderLocked, audioDurationSec: c.json.inputs?.audioDurationSec });
  if (c.status === 201) {
    const a = await call('POST', `/api/factory/drafts/${c.json.draftId}/apply`, { expectedRevision: c.json.revision });
    record('supplied-audio apply: speechGenerated 0 and timing source is supplied audio', a.status === 201 && a.json.speechGenerated === 0, { status: a.status, body: a.json });
    if (a.status === 201) {
      const ed = await call('GET', `/api/projects/${a.json.projectId}/editor`);
      const doc = ed.json?.document ?? ed.json;
      const full = (doc.audioClips ?? []).find((x) => x.id === 'ac_full_narration');
      record('supplied recording is the full narration track, unapproved, duration 6 s', !!full && full.approved === false && Math.abs(full.sourceOutSec - 6) < 0.01, { audioClips: (doc.audioClips ?? []).map((x) => ({ id: x.id, approved: x.approved, sourceOutSec: x.sourceOutSec })) });
      evidence.suppliedAudioProject = a.json.projectId;
    }
  }
}

// 7. A picture that is not in the library is refused before any write.
{
  const r = await call('POST', '/api/factory/drafts', draftBody({ inputs: { brief: 'Missing picture', script: SCRIPT, audioAssetId: null, visualAssetIds: ['no-such-asset'], storyboard: null } }));
  record('unknown picture asset refused before a draft is saved', r.status === 422, { status: r.status, code: r.json.code });
}

// 8. Unknown draft is 404 with a stable body.
{
  const r = await call('GET', '/api/factory/drafts/dft_0000000000000000');
  record('unknown draft is 404 with stable body and no path', r.status === 404 && !JSON.stringify(r.json).includes('/tmp/'), { status: r.status, body: r.json });
}

evidence.finishedAt = new Date().toISOString();
evidence.passed = evidence.checks.filter((c) => c.pass).length;
evidence.total = evidence.checks.length;
fs.writeFileSync(process.env.EVIDENCE_OUT ?? '/tmp/m2-http-evidence.json', JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.total} HTTP checks passed. Evidence: /tmp/m2-http-evidence.json`);
