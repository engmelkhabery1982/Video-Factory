import { describe, expect, it } from 'vitest';
import { TREATMENT_METHODS, type GeneratedPlan } from '@buildtrack/core';
import { refineRepeatedLocalVisuals } from '../apps/api/src/services/local-visual-refinement.js';
const cfg = { enabled: true, url: 'http://127.0.0.1:8196', model: 'LABELLED-TEST-DOUBLE', license: 'TEST', timeoutMs: 2000, maxTokens: 256 };
function plan(): GeneratedPlan {
  return { schemaVersion: 1, profile: 'educational', script: { lines: [
    { id: 'L01', speaker: 'narrator', language: 'en', text: 'Inspect the empty trench.', quotedSourceRef: null },
    { id: 'L02', speaker: 'narrator', language: 'en', text: 'Place the blue pipe.', quotedSourceRef: null },
  ] }, treatments: TREATMENT_METHODS.educational.map((method, i) => ({ id: `T${i}`, title: method, method, rationale: 'TEST', scenes: ['L01', 'L02'].map((id, j) => ({ id: `T${i}S${j}`, lineIds: [id], shotType: 'wide', visualRequirement: 'Subject: empty trench; Environment: open ground; Lighting: ambient light; Composition: empty trench; Shot: wide; Exclude: none', why: 'TEST', assetNeed: 'image_needed' })) })), sourceNotes: [], productMention: { enabled: false, factId: null, text: null } } as GeneratedPlan;
}
function double(failAt = 0, composition = 'visible worked demonstration') {
  const calls: any[] = [];
  const fetchImpl = async (_url: string, init: any) => {
    const body = JSON.parse(init.body); calls.push(body);
    const pipe = body.messages[1].content.includes('Place the blue pipe.');
    const properties = body.response_format.json_schema.schema.properties;
    const fields = properties.composition ? { subject: properties.subject.const, action: properties.action.const, composition: calls.length === failAt ? 'bad; injected' : composition } : { subject: pipe ? 'blue pipe' : 'empty trench', action: pipe ? 'place' : 'inspect' };
    return { status: 200, ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(fields) } }] }) };
  };
  return { calls, fetchImpl };
}
describe('bounded visual refinement (labelled provider doubles, not native quality)', () => {
  it('isolates each current line, preserves originals and bounds two bindings plus six scenes', async () => {
    const original = plan(); const snapshot = structuredClone(original); const d = double();
    const result = await refineRepeatedLocalVisuals({ plan: original, cfg, signal: new AbortController().signal, fetchImpl: d.fetchImpl });
    expect(result.requests).toBe(8); expect(d.calls).toHaveLength(8);
    expect(original).toEqual(snapshot); expect(result.plan.script).toEqual(snapshot.script);
    expect(result.plan.treatments.map(t => t.scenes.map(s => s.lineIds))).toEqual(snapshot.treatments.map(t => t.scenes.map(s => s.lineIds)));
    expect(result.plan.treatments[0].scenes[1].visualRequirement).toContain('blue pipe, place');
    expect(d.calls[1].messages[1].content).not.toContain('Inspect the empty trench.');
    expect(d.calls[4].messages[1].content).toContain('two visible participants');
    expect(d.calls[6].messages[1].content).toContain('before/after');
  });
  it('does not silently start an unbounded scene batch', async () => {
    const original = plan(); original.treatments[0].scenes.push(structuredClone(original.treatments[0].scenes[0])); const d = double();
    const result = await refineRepeatedLocalVisuals({ plan: original, cfg, signal: new AbortController().signal, fetchImpl: d.fetchImpl });
    expect(result.status).toBe('review_required_over_budget'); expect(result.plan).toBe(original); expect(d.calls).toHaveLength(0);
  });
  it('leaves other profiles untouched', async () => {
    const original = plan(); original.profile = 'religious'; const d = double();
    expect((await refineRepeatedLocalVisuals({ plan: original, cfg, signal: new AbortController().signal, fetchImpl: d.fetchImpl })).plan).toBe(original);
    expect(d.calls).toHaveLength(0);
  });
  it('rejects malformed fields without partial changes to the original plan', async () => {
    const original = plan(); const snapshot = structuredClone(original); const d = double(4);
    await expect(refineRepeatedLocalVisuals({ plan: original, cfg, signal: new AbortController().signal, fetchImpl: d.fetchImpl })).rejects.toMatchObject({ code: 'FACTORY_AI_INVALID_OUTPUT' });
    expect(original).toEqual(snapshot); expect(d.calls).toHaveLength(4);
  });
  it('honours cancellation before any model request', async () => {
    const d = double(); const controller = new AbortController(); controller.abort();
    await expect(refineRepeatedLocalVisuals({ plan: plan(), cfg, signal: controller.signal, fetchImpl: d.fetchImpl })).rejects.toMatchObject({ code: 'FACTORY_JOB_CANCELLED' });
    expect(d.calls).toHaveLength(0);
  });
  it.each([
    'pipe placement ready for an',
    'close-up of the pipe being placed in the t-',
    'person standing with the pipe in hand, facing',
    'pipe placement ready for an.',
    'close-up of the pipe being placed in the t-.',
  ])('refuses the observed incomplete native phrase: %s', async phrase => {
    const original = plan(); const snapshot = structuredClone(original); const d = double(0, phrase);
    await expect(refineRepeatedLocalVisuals({ plan: original, cfg, signal: new AbortController().signal, fetchImpl: d.fetchImpl })).rejects.toMatchObject({ code: 'FACTORY_AI_INVALID_OUTPUT' });
    expect(original).toEqual(snapshot); expect(d.calls).toHaveLength(3);
  });
  it('allows a completed directional phrase without claiming its semantic correctness', async () => {
    const d = double(0, 'A person facing the pipe.');
    expect((await refineRepeatedLocalVisuals({ plan: plan(), cfg, signal: new AbortController().signal, fetchImpl: d.fetchImpl })).status).toBe('refined_unreviewed');
  });
});
