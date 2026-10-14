/**
 * Local still-image panel. happy-dom component checks with LABELLED client doubles (test-only).
 * No provider, no real HTTP, no real runner. This is code-level evidence, not browser acceptance
 * and not local generation on the owner's machine.
 */
// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LocalImagePanel } from '../../apps/web/src/components/plan/LocalImagePanel';
import {
  FactoryApiError,
  type FactoryAiClient,
  type FactoryDraftEnvelope,
  type LocalImageClient,
  type LocalImageJob,
  type LocalImageStatus,
  type ShotList,
} from '../../apps/web/src/lib/factory-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
});

const READY: LocalImageStatus = {
  state: 'ready', ready: true, reason: 'Ready.', missing: [], project: 'stable-diffusion.cpp', release: 'master-964-1d0a58a',
  backend: 'cpu', steps: 20, timeoutSec: 900, googleUsed: false, paidSpend: false, jobsAtOnce: 1, busy: false,
  model: { name: 'FIXTURE', license: 'CreativeML Open RAIL-M', sha256Pinned: true, sha256Matches: true },
  flagsChecked: [], flagsMissing: [],
};
const SETUP: LocalImageStatus = { ...READY, state: 'setup_required', ready: false, reason: 'Setup required.', missing: ['LOCAL_IMAGE_RUNNER is not set (path to sd-cli.exe, outside Git).'] };

function envOf(over: Partial<FactoryDraftEnvelope> = {}): FactoryDraftEnvelope {
  return { draftId: 'dft_test', revision: 4, status: 'review_required', generationMode: 'local_llm', speechOrderLocked: false, selectedTreatmentId: 't1', treatments: [], ...over } as unknown as FactoryDraftEnvelope;
}

const LIST: ShotList = {
  draftId: 'dft_test', revision: 4, format: 'landscape', aspect: '16:9', treatmentId: 't1',
  scenes: [
    { index: 0, sceneId: 'sc_still', sourceUnitId: 'u1', narration: 'Line one.', shotType: 'wide', why: 'Shows the site.', assetNeed: 'image_needed', visualRequirement: 'a wide site', boundAssetId: null, status: 'missing', reason: null, mediaType: null, source: null, license: null, prompt: 'Create a still image in 16:9 for a video scene.', screenRecordingBrief: null },
    { index: 1, sceneId: 'sc_rec', sourceUnitId: 'u2', narration: 'Line two.', shotType: 'screen', why: 'Shows the tool.', assetNeed: 'screen_recording_needed', visualRequirement: 'the tool', boundAssetId: null, status: 'missing', reason: null, mediaType: null, source: null, license: null, prompt: null, screenRecordingBrief: 'Record the real tool.' },
  ],
};

const job = (over: Partial<LocalImageJob> = {}): LocalImageJob => ({
  id: 'lij_0123456789abcdef', draftId: 'dft_test', sceneId: 'sc_still', state: 'running', progress: 0.25, prompt: 'p',
  width: 640, height: 360, seed: 42, steps: 20, backend: 'cpu', error: null, approvedAssetId: null,
  provenance: null, ...over,
});
const SUCCEEDED = job({
  state: 'succeeded', progress: 1,
  provenance: { project: 'stable-diffusion.cpp', release: 'master-964-1d0a58a', modelName: 'FIXTURE.safetensors', modelSha256: 'a'.repeat(64), modelLicense: 'CreativeML Open RAIL-M', promptSha256: 'b'.repeat(64), seed: 42, width: 640, height: 360, steps: 20, backend: 'cpu', outputSha256: 'c'.repeat(64), generatedAt: '2026-10-14T00:00:00Z' },
});

/** LABELLED TEST DOUBLE for the local image client. Records every call. */
function imagesDouble(script: Partial<LocalImageClient> & { jobs?: LocalImageJob[] } = {}) {
  const calls: Array<[string, unknown]> = [];
  const queue = [...(script.jobs ?? [])];
  const client: LocalImageClient = {
    status: vi.fn(async () => (script.status ? await script.status() : READY)),
    start: vi.fn(async (body) => {
      calls.push(['start', body]);
      if (script.start) return script.start(body);
      return job({ ...(queue[0] ?? {}) });
    }),
    job: vi.fn(async (id) => {
      calls.push(['job', id]);
      if (script.job) return script.job(id);
      return queue.length > 1 ? queue.shift()! : (queue[0] ?? job());
    }),
    cancel: vi.fn(async (id) => {
      calls.push(['cancel', id]);
      if (script.cancel) return script.cancel(id);
      return job({ id, state: 'cancelled', error: { code: 'LOCAL_IMAGE_STATE', message: 'Cancelled. Nothing was saved.' } });
    }),
    approve: vi.fn(async (id) => {
      calls.push(['approve', id]);
      if (script.approve) return script.approve(id);
      return { job: SUCCEEDED, assetId: 'loc_0123456789abcdef' };
    }),
    imageUrl: (id) => `/api/local-images/jobs/${id}/image`,
    bind: vi.fn(async (draftId, body) => {
      calls.push(['bind', { draftId, ...body }]);
      if (script.bind) return script.bind(draftId, body);
      return envOf({ revision: 5 });
    }),
  };
  return { client, calls };
}

const aiDouble = { shotList: vi.fn(async () => LIST) } as unknown as FactoryAiClient;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

async function mount(images: LocalImageClient, env = envOf(), onAdopt = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<LocalImagePanel ai={aiDouble} images={images} env={env} onAdopt={onAdopt} pollMs={5} />);
  });
  await flush();
  return { onAdopt };
}

/** Waits for a condition, polling the act-wrapped flush. Bounded, so a real failure still fails. */
async function until(cond: () => unknown, tries = 400) {
  for (let i = 0; i < tries && !cond(); i++) await flush();
}

const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (id: string) => {
  await act(async () => {
    q(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
};

describe('local still panel: setup, generate, preview, approve, bind (labelled client double)', () => {
  it('keeps replacement available for a bound library still, never for bound footage', async () => {
    vi.mocked(aiDouble.shotList).mockResolvedValueOnce({...LIST,scenes:[
      {...LIST.scenes[0],assetNeed:'existing_library',status:'bound',mediaType:'image',boundAssetId:'owner-still'},
      {...LIST.scenes[1],assetNeed:'existing_library',status:'bound',mediaType:'video',boundAssetId:'owner-recording'},
    ]});
    const {client}=imagesDouble();
    await mount(client);
    expect(q('local-generate-sc_still')?.textContent).toMatch(/replacement locally/);
    expect(q('local-generate-sc_rec')).toBeNull();
    expect(client.start).not.toHaveBeenCalled();
  });
  it('shows setup required with the missing item, and disables generation', async () => {
    const { client } = imagesDouble({ status: async () => SETUP });
    await mount(client);
    expect(q('local-images-setup')?.textContent).toMatch(/Setup required/);
    expect(q('local-images-missing')?.textContent).toMatch(/LOCAL_IMAGE_RUNNER/);
    expect((q('local-generate-sc_still') as HTMLButtonElement).disabled).toBe(true);
    // Reading status makes no generation call.
    expect(client.start).not.toHaveBeenCalled();
  });

  it('shows the recording shot without any generate control: a still is not a recording', async () => {
    const { client } = imagesDouble();
    await mount(client);
    expect(q('local-shot-sc_rec')).toBeNull();
    expect(q('local-shot-sc_still')).not.toBeNull();
  });

  it('generate sends the reviewed revision, shows progress, and offers a preview only on success', async () => {
    // Gated double: the job stays running until the test releases it, so the progress assertions
    // do not race the poll timer. Success is released explicitly below.
    let released = false;
    const { client, calls } = imagesDouble({
      job: async () => (released ? SUCCEEDED : job({ progress: 0.5 })),
    });
    await mount(client);
    await click('local-generate-sc_still');
    expect(calls[0]).toEqual(['start', { draftId: 'dft_test', sceneId: 'sc_still', expectedRevision: 4 }]);
    await until(() => q('local-progress-sc_still'));
    expect(q('local-progress-sc_still')?.textContent).toMatch(/Generating on this computer/);
    expect(q('local-preview-sc_still')).toBeNull();
    released = true;
    await until(() => q('local-preview-sc_still'));
    const img = q('local-preview-sc_still') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('/api/local-images/jobs/lij_0123456789abcdef/image');
    expect(q('local-candidate-sc_still')?.textContent).toMatch(/Preview only until approved/);
    expect(q('local-candidate-sc_still')?.textContent).toMatch(/seed 42/);
  });

  it('approve then bind: the bind carries the draft revision and the approved asset id, and adopts the new draft', async () => {
    const { client, calls } = imagesDouble({ jobs: [SUCCEEDED] });
    const { onAdopt } = await mount(client);
    await click('local-generate-sc_still');
    await until(() => q('local-approve-sc_still'));
    await click('local-approve-sc_still');
    expect(calls.some(([k]) => k === 'approve')).toBe(true);
    await click('local-bind-sc_still');
    expect(calls.find(([k]) => k === 'bind')?.[1]).toEqual({ draftId: 'dft_test', expectedRevision: 4, sceneId: 'sc_still', assetId: 'loc_0123456789abcdef' });
    expect(onAdopt).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 }));
  });

  it('cancel shows Cancelled, never a preview; a late success from the poll is ignored', async () => {
    let release: ((j: LocalImageJob) => void) | null = null;
    const { client } = imagesDouble({
      jobs: [job({ progress: 0.2 })],
      job: async () => new Promise<LocalImageJob>((r) => { release = r; }),
    });
    await mount(client);
    await click('local-generate-sc_still');
    await click('local-cancel-sc_still');
    expect(q('local-cancelled-sc_still')?.textContent).toMatch(/Nothing was saved/);
    // The poll that was already in flight now returns a late success. It must not show.
    release?.(SUCCEEDED);
    await flush();
    await flush();
    expect(q('local-preview-sc_still')).toBeNull();
    expect(q('local-approve-sc_still')).toBeNull();
  });

  it('a runner timeout or failure is shown as an error with no preview', async () => {
    const { client } = imagesDouble({ jobs: [job({ state: 'timed_out', error: { code: 'LOCAL_IMAGE_TIMEOUT', message: 'The generation did not finish within 900 seconds. Nothing was saved.' } })] });
    await mount(client);
    await click('local-generate-sc_still');
    await until(() => host!.textContent?.includes('did not finish within 900 seconds'));
    expect(host!.textContent).toMatch(/did not finish within 900 seconds/);
    expect(q('local-preview-sc_still')).toBeNull();
  });

  it('a busy runner refuses a second start and keeps the shot on screen', async () => {
    const { client } = imagesDouble({
      start: async () => { throw new FactoryApiError({ message: 'Another local image is being generated. Wait for it or cancel it.', status: 409, code: 'LOCAL_IMAGE_BUSY', answered: true }); },
    });
    await mount(client);
    await click('local-generate-sc_still');
    expect(host!.textContent).toMatch(/Another local image is being generated/);
    expect(q('local-shot-sc_still')).not.toBeNull();
  });

  it('a bind at a stale revision is refused with a clear message; the candidate stays and nothing is adopted', async () => {
    const { client } = imagesDouble({
      jobs: [SUCCEEDED],
      bind: async () => { throw new FactoryApiError({ message: 'The draft changed since you loaded it. Reload and bind again.', status: 409, code: 'FACTORY_REVISION_CONFLICT', answered: true, currentRevision: 6 }); },
    });
    const { onAdopt } = await mount(client);
    await click('local-generate-sc_still');
    await until(() => q('local-approve-sc_still'));
    await click('local-approve-sc_still');
    await click('local-bind-sc_still');
    expect(host!.textContent).toMatch(/changed since this preview was made/);
    expect(q('local-bind-sc_still')).not.toBeNull();
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it('a transport failure while starting keeps the shot and says nothing was confirmed', async () => {
    const { client } = imagesDouble({
      start: async () => { throw new FactoryApiError({ message: 'The server did not reply. Nothing is confirmed.', status: null, code: 'TRANSPORT', answered: false }); },
    });
    await mount(client);
    await click('local-generate-sc_still');
    expect(host!.textContent).toMatch(/Nothing is confirmed/);
    expect(q('local-shot-sc_still')).not.toBeNull();
  });
});
