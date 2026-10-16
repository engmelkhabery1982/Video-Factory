// @vitest-environment happy-dom
/**
 * DOM tests for the optional-input panels. The API is a LABELLED TEST DOUBLE (fixtures.ts). These check page
 * behaviour and request shape only. They are not browser evidence, not a render, and not evidence that a real
 * transcription engine or a vision engine works. Transcription here is a fake job; the real contract is tested
 * through the routes in tests/factory-intake-http.test.ts.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContentPlanPage, type PlanDeps } from '../../apps/web/src/pages/ContentPlan';
import { IntakeReview, NarrationChoice, PictureRoles, StoryboardCards, TranscriptionPanel } from '../../apps/web/src/components/factory/IntakePanels';
import type { FactoryDraftEnvelope, FactoryTranscriptionJob } from '../../apps/web/src/lib/factory-api';
import { envelopeOf, apiError, fakeClient } from './fixtures';
import { panelsFromStoryboard, panelsToStoryboard } from '../../apps/web/src/lib/factory-model';

it('preserves reviewed timing, speaker and locks across storyboard card import/export', () => {
  const scene = { id: 'reviewed', narration: 'نَصٌّ مُرَاجَعٌ', assetId: 'img-a', startSec: 6.25, endSec: 9.5, speakerId: 'reader', locked: true };
  const roundTrip = panelsToStoryboard(panelsFromStoryboard({ version: 1, scenes: [scene] }));
  expect(roundTrip.scenes).toEqual([scene]);
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  window.history.replaceState(null, '', '/');
});

const q = <T extends Element = HTMLElement>(sel: string): T => {
  const el = (host ?? document.body).querySelector(sel) as T | null;
  if (!el) throw new Error(`not found: ${sel}`);
  return el;
};
const qa = (sel: string) => Array.from((host ?? document.body).querySelectorAll(sel)) as HTMLElement[];
const buttonNamed = (label: string) => qa('button').find((b) => b.textContent?.trim() === label)!;
function setValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
const click = (el: HTMLElement) => act(async () => el.click());
const flush = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const LIB = [{ id: 'img-a', name: 'Owner image A' }, { id: 'img-b', name: 'Owner image B' }];

describe('storyboard cards', () => {
  it('create, order, edit and remove panels; words are optional; the order is what the cards show', async () => {
    const changes: Array<Array<{ id: string; narration: string }>> = [];
    function Harness() {
      const [panels, setPanels] = React.useState<import('../../apps/web/src/lib/factory-model').StoryboardPanelDraft[]>([]);
      return (
        <StoryboardCards
          panels={panels}
          pictures={LIB}
          onChange={(next) => {
            changes.push(next.map((p) => ({ id: p.id, narration: p.narration })));
            setPanels(next);
          }}
        />
      );
    }
    await render(<Harness />);
    await click(buttonNamed('Add panel'));
    await click(buttonNamed('Add panel'));
    expect(qa('[data-testid="storyboard-card"]')).toHaveLength(2);
    await act(async () => setValue(q<HTMLTextAreaElement>('textarea[aria-label="Words for panel 2"]'), 'Second panel words.'));
    await click(q('button[aria-label="Move panel 2 up"]'));
    expect(changes.at(-1)).toEqual([{ id: 'p02', narration: 'Second panel words.' }, { id: 'p01', narration: '' }]);
    // After the move, panel 1 is p02 (with words) and panel 2 is p01. Removing panel 2 keeps the words.
    await click(q('button[aria-label="Remove panel 2"]'));
    expect(qa('[data-testid="storyboard-card"]')).toHaveLength(1);
    expect(q('[data-testid="storyboard-card"]').textContent).toMatch(/Second panel words/);
  });

  it('export writes the versioned storyboard; import of a version other than 1 is refused and changes nothing', async () => {
    const onChange = vi.fn();
    await render(<StoryboardCards panels={[{ key: 'k1', id: 'p01', narration: 'One.', assetId: 'img-a' }]} pictures={LIB} onChange={onChange} />);
    await click(buttonNamed('Export JSON'));
    const text = q<HTMLTextAreaElement>('textarea[aria-label="Storyboard JSON"]').value;
    expect(JSON.parse(text)).toEqual({ version: 1, scenes: [expect.objectContaining({ id: 'p01', narration: 'One.', assetId: 'img-a' })] });
    await act(async () => setValue(q<HTMLTextAreaElement>('textarea[aria-label="Storyboard JSON"]'), '{"version":2,"scenes":[]}'));
    await click(buttonNamed('Import panels'));
    expect(onChange).not.toHaveBeenCalled();
    expect(q('[role="alert"]').textContent).toMatch(/version 1/);
  });
});

describe('narration, picture roles and the vision note', () => {
  it('narration choice is explicit and "none" sends the silent choice', async () => {
    const onChange = vi.fn();
    await render(<NarrationChoice value="auto" onChange={onChange} audioAttached={false} />);
    await click(q('[data-testid="narration-none"]'));
    expect(onChange).toHaveBeenCalledWith('none');
    expect(q('[data-testid="narration-choice"]').textContent).toMatch(/Silent video needs no speaker, voice, transcript, alignment or audio approval/);
  });

  it('a picture defaults to a final shot; a reference role is shown as never a shot; automatic description is labelled unavailable', async () => {
    const onChange = vi.fn();
    await render(<PictureRoles pictures={LIB} roles={{}} onChange={onChange} />);
    expect((q(`select[aria-label="Role of Owner image A"]`) as HTMLSelectElement).value).toBe('final_shot');
    await act(async () => setValue(q<HTMLSelectElement>('select[aria-label="Role of Owner image B"]'), 'style_reference'));
    expect(onChange).toHaveBeenCalledWith({ 'img-b': 'style_reference' });
    expect(q('[data-testid="vision-note"]').textContent).toMatch(/Automatic description of pictures is unavailable/);
  });
});

describe('local transcription (labelled fake job)', () => {
  const job = (over: Partial<FactoryTranscriptionJob>): FactoryTranscriptionJob => ({
    jobId: 'trs_0123456789abcdef', audioAssetId: 'aud-1', audioSha256: 'x', status: 'queued', progress: null, reason: null,
    transcript: null, reviewedText: null, provenance: null, revision: 1, ...over,
  });

  it('with no runner the panel shows the exact reason and offers no cancel', async () => {
    const client = fakeClient({ startTranscription: vi.fn(async () => job({ status: 'unavailable', reason: 'No local transcription runtime is configured (VF_TRANSCRIBE_COMMAND is not set).' })) as never });
    await render(<TranscriptionPanel client={client} audioAssetId="aud-1" attachedJobId={null} onAttach={() => {}} />);
    await click(q('[data-testid="transcribe-start"]'));
    expect(q('[data-testid="transcription-status"]').textContent).toMatch(/unavailable/);
    expect(q('[data-testid="transcription-status"]').textContent).toMatch(/VF_TRANSCRIBE_COMMAND/);
    expect(document.querySelector('[data-testid="transcribe-cancel"]')).toBeNull();
  });

  it('running, then a fixture result: the output is labelled FIXTURE, the owner reviews it, and the reviewed text is attached with the job id', async () => {
    const onAttach = vi.fn();
    // Overrides are held by reference: the fake's call log records only the default fakes.
    const getTranscription = vi.fn(async () => job({
      status: 'succeeded', progress: 1, revision: 2, transcript: 'Machine text.', provenance: { method: 'fixture_stand_in', fixture: true, independentOfScript: true, engine: 'fixture', emissionsSha256: null },
    }));
    const reviewTranscription = vi.fn(async (_id: string, text: string) => job({ status: 'succeeded', revision: 3, transcript: 'Machine text.', reviewedText: text }));
    const client = fakeClient({
      startTranscription: vi.fn(async () => job({ status: 'running', progress: 0.5, revision: 1 })) as never,
      getTranscription: getTranscription as never,
      reviewTranscription: reviewTranscription as never,
    });
    await render(<TranscriptionPanel client={client} audioAssetId="aud-1" attachedJobId={null} onAttach={onAttach} />);
    await click(q('[data-testid="transcribe-start"]'));
    expect(q('[data-testid="transcription-status"]').textContent).toMatch(/running · 50%/);
    await flush(900);
    expect(getTranscription).toHaveBeenCalledWith('trs_0123456789abcdef');
    expect(q('[data-testid="transcription-status"]').textContent).toMatch(/succeeded/);
    expect(q('[role="note"]').textContent).toMatch(/FIXTURE output \(tests only\)/);
    await act(async () => setValue(q<HTMLTextAreaElement>('textarea[aria-label="Transcript to review"]'), 'Reviewed words.'));
    await click(q('[data-testid="transcribe-accept"]'));
    expect(reviewTranscription).toHaveBeenCalledWith('trs_0123456789abcdef', 'Reviewed words.', 2);
    expect(onAttach).toHaveBeenCalledWith('trs_0123456789abcdef');
  });

  it('cancel calls the cancel route and shows the canceled state', async () => {
    const cancelTranscription = vi.fn(async () => job({ status: 'canceled', revision: 2 }));
    const client = fakeClient({
      startTranscription: vi.fn(async () => job({ status: 'running', revision: 1 })) as never,
      cancelTranscription: cancelTranscription as never,
    });
    await render(<TranscriptionPanel client={client} audioAssetId="aud-1" attachedJobId={null} onAttach={() => {}} />);
    await click(q('[data-testid="transcribe-start"]'));
    await click(q('[data-testid="transcribe-cancel"]'));
    expect(cancelTranscription).toHaveBeenCalledWith('trs_0123456789abcdef');
    expect(q('[data-testid="transcription-status"]').textContent).toMatch(/canceled/);
  });
});

describe('review queue', () => {
  const env = envelopeOf({
    status: 'blocked',
    textConflict: {
      sources: [{ source: 'script', label: 'Reviewed script', units: ['First line.'] }, { source: 'storyboard', label: 'Storyboard', units: ['Other.'] }],
      authority: null,
      labels: { script: 'Reviewed script', storyboard: 'Storyboard' },
    },
    completion: [
      { id: 'c1', kind: 'conflict', required: true, sceneId: null, label: 'Choose the authority.', action: 'Pick a text below.' },
      { id: 'c2', kind: 'library_picture', required: false, sceneId: 's1', label: 'A library picture could fill s1.', action: 'Optional: attach one.' },
    ],
  } as Partial<FactoryDraftEnvelope>);

  it('required gaps are listed apart from optional suggestions, and a conflict offers each text as the authority', async () => {
    const onPatch = vi.fn();
    await render(<IntakeReview env={env} busy={false} onPatch={onPatch} />);
    expect(q('[data-testid="queue-required"]').textContent).toMatch(/Choose the authority/);
    expect(q('[data-testid="queue-optional"]').textContent).toMatch(/A library picture could fill s1/);
    expect(q('[data-testid="queue-required"]').textContent).not.toMatch(/library picture/);
    await click(q('[data-testid="authority-storyboard"]'));
    expect(onPatch).toHaveBeenCalledWith({ textAuthority: 'storyboard' });
  });
});

describe('page: the optional inputs reach the server and the review queue', () => {
  function deps(client: ReturnType<typeof fakeClient>): PlanDeps {
    return {
      client,
      loadLibrary: async () => [
        { id: 'img-a', name: 'Owner image A', kind: 'screenshot', mimeType: 'image/png', status: 'active' },
      ],
      uploadLibraryFile: async () => ({}),
      ai: {
        shotList: async () => ({ draftId: 'fixture-intake', revision: 0, scenes: [] }),
        aiStatus: async () => { throw new Error('LABELLED FAKE: no Gemini status in this suite'); },
      } as unknown as PlanDeps['ai'],
      images: {
        status: async () => ({ ready: false, missing: ['LABELLED FIXTURE: local generation is not exercised here'] }),
      } as unknown as PlanDeps['images'],
    } as PlanDeps;
  }

  it('a silent storyboard is created with narration none, its panel picture, and no speech field', async () => {
    const client = fakeClient();
    await render(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await act(async () => setValue(q<HTMLInputElement>('input[placeholder="What this video is about"]'), 'Silent explainer.'));
    await click(buttonNamed('Add panel'));
    await act(async () => setValue(q<HTMLSelectElement>('select[aria-label="Picture for panel 1"]'), 'img-a'));
    await click(q('[data-testid="narration-none"]'));
    await click(q('[data-testid="create-draft"]'));
    const body = client.calls.find((c) => c.name === 'createDraft')!.args[0] as { inputs: Record<string, any> };
    expect(body.inputs.narrationMode).toBe('none');
    expect(body.inputs.storyboard).toEqual({ version: 1, scenes: [expect.objectContaining({ id: 'p01', narration: '', assetId: 'img-a' })] });
    expect(body.inputs.transcriptJobId).toBeNull();
  });

  it('a conflict from the server is shown, and choosing a text sends one revision-checked intake patch', async () => {
    const created = envelopeOf({
      draftId: 'dft_0123456789abcdef', revision: 4, status: 'blocked',
      textConflict: { sources: [{ source: 'script', label: 'Reviewed script', units: ['A.'] }, { source: 'storyboard', label: 'Storyboard', units: ['B.'] }], authority: null, labels: {} },
      completion: [{ id: 'c1', kind: 'conflict', required: true, sceneId: null, label: 'Choose the authority.', action: 'Pick a text.' }],
    } as Partial<FactoryDraftEnvelope>);
    const client = fakeClient({ createDraft: vi.fn(async () => created) as never });
    await render(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await act(async () => setValue(q<HTMLInputElement>('input[placeholder="What this video is about"]'), 'Conflict.'));
    await act(async () => setValue(q<HTMLTextAreaElement>('textarea[rows="8"]'), 'Script line.'));
    await click(q('[data-testid="create-draft"]'));
    expect(q('[data-testid="text-conflict"]').textContent).toMatch(/Nothing has been replaced/);
    await click(q('[data-testid="authority-script"]'));
    const patch = client.calls.find((c) => c.name === 'patchIntake')!;
    expect(patch.args).toEqual(['dft_0123456789abcdef', { expectedRevision: 4, textAuthority: 'script' }]);
  });

  it('a refused intake change (409) keeps the draft and the conflict on screen, and says why', async () => {
    const created = envelopeOf({
      draftId: 'dft_0123456789abcdef', revision: 4, status: 'blocked',
      textConflict: { sources: [{ source: 'script', label: 'Reviewed script', units: ['A.'] }, { source: 'storyboard', label: 'Storyboard', units: ['B.'] }], authority: null, labels: {} },
      completion: [{ id: 'c1', kind: 'conflict', required: true, sceneId: null, label: 'Choose the authority.', action: 'Pick a text.' }],
    } as Partial<FactoryDraftEnvelope>);
    const client = fakeClient({
      createDraft: vi.fn(async () => created) as never,
      patchIntake: vi.fn(async () => { throw apiError('FACTORY_REVISION_CONFLICT', 409); }) as never,
    });
    await render(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await act(async () => setValue(q<HTMLInputElement>('input[placeholder="What this video is about"]'), 'Conflict.'));
    await act(async () => setValue(q<HTMLTextAreaElement>('textarea[rows="8"]'), 'Script line.'));
    await click(q('[data-testid="create-draft"]'));
    await click(q('[data-testid="authority-storyboard"]'));
    expect(q('[data-testid="plan-error"]').textContent).toBeTruthy();
    expect(q('[data-testid="text-conflict"]').textContent).toMatch(/Nothing has been replaced/);
    expect(q('[data-testid="draft-status"]').textContent).toMatch(/Revision 4/);
  });
});
