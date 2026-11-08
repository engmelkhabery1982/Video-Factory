/**
 * Masked-correction UI component tests with LABELLED HTTP/client doubles.
 * No engine, real image output, HTTP server, or browser/owner acceptance claim.
 */
// @vitest-environment happy-dom
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaskedCorrectionPanel } from '../../apps/web/src/components/factory/MaskedCorrectionPanel';
import type {
  FactoryAiClient,
  FactoryDraftEnvelope,
  MaskedCorrectionClient,
  MaskedCorrectionJob,
  MaskedCorrectionReadiness,
  ShotList,
} from '../../apps/web/src/lib/factory-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const env = { draftId: 'dft_mask', revision: 4, status: 'review_required', selectedTreatmentId: 't1', treatments: [] } as unknown as FactoryDraftEnvelope;
const originalHash = 'a'.repeat(64);
const resultHash = 'b'.repeat(64);
const shotList: ShotList = {
  draftId: env.draftId, revision: 4, format: 'landscape', aspect: '16:9', treatmentId: 't1',
  scenes: [{
    index: 0, sceneId: 'sc_1', sourceUnitId: 'u1', narration: 'Bound still', shotType: 'wide', why: 'Owned test',
    assetNeed: 'existing_library', visualRequirement: 'Owned fixture', boundAssetId: 'original-1', locked: false,
    boundAssetSha256: originalHash, boundAssetWidth: 4, boundAssetHeight: 3, boundAssetMimeType: 'image/png',
    status: 'bound', reason: null, mediaType: 'image', source: 'Owned fixture', license: 'Owned', prompt: null,
    imagePrompt: null, visualDescription: null, negativePrompt: null, promptWarnings: [], promptRefusals: [], screenRecordingBrief: null,
  }],
};
const readiness: MaskedCorrectionReadiness = {
  ready: true, runner: { id: 'labelled-double', version: 'fixture-1', fixture: true },
  reason: 'Labelled test double only. This is not a real inpainting engine.', missing: [], jobsAtOnce: 1, busy: false, activeJobId: null,
  limits: { maxRegions: 64, maxAttempts: 3, maxJobsPerDraft: 50, maxTotalJobs: 500, maxJobFileBytes: 2097152, runnerTimeoutMs: 120000 },
};
const job = (over: Partial<MaskedCorrectionJob> = {}): MaskedCorrectionJob => ({
  schemaVersion: 1, id: 'mc-0123456789abcdef01234567', draftId: env.draftId, sceneId: 'sc_1', status: 'completed',
  originalAssetId: 'original-1', originalHash,
  original: { width: 4, height: 3, mimeType: 'image/png', source: 'Owned fixture', license: 'Owned' },
  maskHash: 'c'.repeat(64), parameters: { maskData: 'fixture', instructions: 'Correct the marked pixel' },
  targetFingerprint: 'd'.repeat(64), inputFingerprint: 'e'.repeat(64), reviewFingerprint: null,
  resultAssetId: 'result-1', resultHash, resultVerification: 'verified', error: null, errorCode: null,
  reviewed: false, reviewNotes: null, revision: 4, reviewedRevision: null, appliedRevision: null,
  attempts: 1, maxAttempts: 3, runner: { id: 'labelled-double', version: 'fixture-1', fixture: true },
  createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z', targetCurrent: true, targetIssue: null,
  ...over,
});

function clientDouble(initial: MaskedCorrectionJob[] = [], ready = readiness) {
  let jobs = [...initial];
  const client: MaskedCorrectionClient = {
    readiness: vi.fn(async () => ready),
    list: vi.fn(async () => jobs),
    create: vi.fn(async () => { jobs = [job()]; return jobs[0]; }),
    get: vi.fn(async (id) => jobs.find((item) => item.id === id)!),
    cancel: vi.fn(async (id) => job({ id, status: 'cancelled' })),
    retry: vi.fn(async (id) => job({ id, status: 'pending', resultAssetId: null, resultHash: null, resultVerification: 'pending' })),
    review: vi.fn(async (id, state) => job({ id, status: state === 'approved' ? 'reviewed' : 'rejected', reviewed: true, reviewFingerprint: state === 'approved' ? 'f'.repeat(64) : null })),
    apply: vi.fn(async () => ({ ...env, revision: 5 })),
    remove: vi.fn(async (jobId) => { jobs = jobs.filter((item) => item.id !== jobId); return { deleted: true as const, jobId }; }),
    assetUrl: (id) => `/media/asset/${id}`,
  };
  return client;
}

async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); }
async function mount(client: MaskedCorrectionClient, onAdopt = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const ai = { shotList: vi.fn(async () => shotList) } as unknown as FactoryAiClient;
  await act(async () => { root!.render(<MaskedCorrectionPanel env={env} ai={ai} corrections={client} onAdopt={onAdopt} />); });
  await flush();
  return { onAdopt };
}
const q = <T extends HTMLElement = HTMLElement>(id: string) => host!.querySelector(`[data-testid="${id}"]`) as T | null;
async function click(id: string) { await act(async () => { q(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await flush(); }
async function input(id: string, value: string) {
  await act(async () => {
    const field = q<HTMLTextAreaElement>(id)!;
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const button = (text: string) => [...host!.querySelectorAll('button')].find((item) => item.textContent === text)!;
async function clickText(text: string) { await act(async () => { button(text).dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await flush(); }

describe('masked correction current-editor workflow (labelled client double)', () => {
  it('keeps mask editing/validation available while the real runner gate is closed', async () => {
    const client = clientDouble([], { ...readiness, ready: false, runner: null, reason: 'No masked correction runner configured.' });
    await mount(client);
    expect(q('masked-readiness')!.textContent).toMatch(/No masked correction runner/);
    expect(q<HTMLButtonElement>('masked-create')!.disabled).toBe(true);
    await input('masked-width', '2');
    await click('masked-validate');
    expect(q('masked-notice')!.textContent).toMatch(/locally valid/);
    expect(client.create).not.toHaveBeenCalled();
  });

  it('submits the current revision, actual bound id/hash and canonical pixel mask; fixture provenance stays visible', async () => {
    const client = clientDouble();
    await mount(client);
    await input('masked-width', '2');
    await input('masked-height', '2');
    await input('masked-instructions', 'Correct only the marked region');
    await click('masked-create');
    expect(client.create).toHaveBeenCalledTimes(1);
    const [draftId, body] = (client.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(draftId).toBe(env.draftId);
    expect(body).toMatchObject({ sceneId: 'sc_1', expectedRevision: 4, originalAssetId: 'original-1', originalHash, instructions: 'Correct only the marked region' });
    const mask = JSON.parse(atob(body.maskData));
    expect(mask).toEqual({ version: 1, coordinateSpace: 'pixels', width: 4, height: 3, regions: [{ x: 0, y: 0, width: 2, height: 2 }] });
    expect(host!.textContent).toMatch(/FIXTURE \/ not an engine/);
    expect(host!.textContent).toMatch(/not real inpainting output/i);
  });

  it('reloads persisted jobs and shows separate original/result provenance before review', async () => {
    const client = clientDouble([job()]);
    await mount(client);
    expect(client.list).toHaveBeenCalledWith(env.draftId);
    const original = host!.querySelector<HTMLImageElement>('img[alt^="Original still"]')!;
    const result = host!.querySelector<HTMLImageElement>('img[alt^="Corrected candidate"]')!;
    expect(original.src).toContain('/media/asset/original-1');
    expect(result.src).toContain('/media/asset/result-1');
    expect(host!.textContent).toContain(originalHash);
    expect(host!.textContent).toContain(resultHash);
  });

  it('approves and rejects through explicit review actions', async () => {
    const client = clientDouble([job()]);
    await mount(client);
    await input('masked-notes', 'Compared owned fixture pixels');
    await clickText('Approve result');
    expect(client.review).toHaveBeenCalledWith(job().id, 'approved', 'Compared owned fixture pixels');
    await clickText('Reject');
    expect(client.review).toHaveBeenCalledWith(job().id, 'rejected', 'Compared owned fixture pixels');
  });

  it('retries a rejected job within its visible attempt budget', async () => {
    const client = clientDouble([job({ status: 'rejected', reviewed: true })]);
    await mount(client);
    await clickText('Retry');
    expect(client.retry).toHaveBeenCalledWith(job().id);
  });

  it('applies only a reviewed current target with the latest revision and adopts the returned envelope', async () => {
    const reviewed = job({ status: 'reviewed', reviewed: true, reviewFingerprint: 'f'.repeat(64), reviewedRevision: 3 });
    const client = clientDouble([reviewed]);
    const { onAdopt } = await mount(client);
    await click(`masked-apply-${reviewed.id}`);
    expect(client.apply).toHaveBeenCalledWith(reviewed.id, 4);
    expect(onAdopt).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 }));
  });

  it('offers explicit reconciliation after a bind/job-state interruption', async () => {
    const interrupted = job({ status: 'applying', reviewed: true, reviewFingerprint: 'f'.repeat(64), targetCurrent: null });
    const client = clientDouble([interrupted]);
    const { onAdopt } = await mount(client);
    expect(button('Reconcile Apply')).toBeDefined();
    await click(`masked-apply-${interrupted.id}`);
    expect(client.apply).toHaveBeenCalledWith(interrupted.id, 4);
    expect(onAdopt).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 }));
  });

  it('shows stale target errors and disables Apply instead of hiding the job', async () => {
    const stale = job({ status: 'reviewed', reviewed: true, reviewFingerprint: 'f'.repeat(64), targetCurrent: false, targetIssue: 'A newer original is bound.' });
    const client = clientDouble([stale]);
    await mount(client);
    expect(host!.textContent).toMatch(/A newer original is bound/);
    expect(q<HTMLButtonElement>(`masked-apply-${stale.id}`)!.disabled).toBe(true);
    expect(client.apply).not.toHaveBeenCalled();
  });

  it('surfaces an HTTP/client error without fabricating a result', async () => {
    const client = clientDouble();
    client.create = vi.fn(async () => { throw new Error('FACTORY_CANDIDATE_STALE: target changed'); });
    await mount(client);
    await input('masked-instructions', 'Correct marked pixels');
    await click('masked-create');
    expect(q('masked-error')!.textContent).toMatch(/FACTORY_CANDIDATE_STALE/);
    expect(host!.querySelector('img[alt^="Corrected candidate"]')).toBeNull();
  });
});

it('does not adopt an Apply response after its draft editor has unmounted', async () => {
  const client = clientDouble([job({ status: 'reviewed', reviewed: true, reviewFingerprint: 'f'.repeat(64) })]);
  let resolve!: (value: FactoryDraftEnvelope) => void;
  vi.mocked(client.apply).mockImplementation(() => new Promise(r => { resolve = r; }));
  const { onAdopt } = await mount(client);
  await act(async () => { q(`masked-apply-${job().id}`)!.click(); });
  expect(client.apply).toHaveBeenCalledTimes(1);
  await act(async () => root!.unmount());
  root = null;
  await act(async () => { resolve({ ...env, revision: 5 }); await Promise.resolve(); });
  expect(onAdopt).not.toHaveBeenCalled();
});
