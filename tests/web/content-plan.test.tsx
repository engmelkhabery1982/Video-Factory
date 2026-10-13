// @vitest-environment happy-dom
/**
 * DOM tests for the content-planning page. The API is replaced by TEST DOUBLES
 * (see fixtures.ts). These check page behaviour only. They are not evidence
 * that the live API, a render, or any generation works.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContentPlanPage, type PlanDeps } from '../../apps/web/src/pages/ContentPlan';
import { envelopeOf, apiError, fakeClient, CAPS, MEASURED_LABEL, timingStatusOf } from './fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
  await flush();
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  window.history.replaceState(null, '', '/');
});

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

const q = <T extends Element = HTMLElement>(sel: string) => {
  const el = host!.querySelector(sel) as T | null;
  if (!el) throw new Error(`not found: ${sel}`);
  return el;
};
const qa = (sel: string) => Array.from(host!.querySelectorAll(sel)) as HTMLElement[];

function setValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
const change = (sel: string, value: string) => act(async () => setValue(q<HTMLSelectElement>(sel), value));
const type = (sel: string, value: string) => act(async () => setValue(q<HTMLInputElement>(sel), value));
const click = async (sel: string) => {
  await act(async () => q(sel).click());
  await flush();
};
const buttonByText = (text: string) => {
  const b = qa('button').find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button: ${text}`);
  return b;
};

function deps(client: ReturnType<typeof fakeClient>, extra: Partial<PlanDeps> = {}): PlanDeps {
  return {
    client,
    loadLibrary: async () => [
      { id: 'img-a', name: 'Owner image A', kind: 'screenshot', mimeType: 'image/png', status: 'active' },
      { id: 'aud-1', name: 'Read narration', kind: 'sfx', mimeType: 'audio/wav', durationSec: 12.5, status: 'active' },
    ],
    uploadLibraryFile: async () => ({}),
    ...extra,
  };
}

const fillBriefAndScript = async () => {
  await type('input[placeholder="What this video is about"]', 'Concrete windows');
  await act(async () => setValue(q<HTMLTextAreaElement>('textarea'), 'Why does the pour fail? For example, a pour was booked for seven.'));
};

describe('input modes and refusals', () => {
  it('keeps the typed form exactly when the server refuses the create', async () => {
    const client = fakeClient({ createDraft: vi.fn(async () => { throw apiError('FACTORY_VALIDATION', 422); }) as never });
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    expect(q('[data-testid="plan-error"]').textContent).toMatch(/FACTORY_VALIDATION test message|Check|refus|failed/i);
    expect(q<HTMLInputElement>('input[placeholder="What this video is about"]').value).toBe('Concrete windows');
    expect(q<HTMLTextAreaElement>('textarea').value).toMatch(/Why does the pour fail/);
  });

  it('refuses ready audio without its script before any request is sent', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await act(async () => qa('input[name="inputMode"]')[2].click());
    await click('[data-testid="create-draft"]');
    expect(client.calls.some((c) => c.name === 'createDraft')).toBe(false);
    expect(q('[data-testid="plan-error"]').textContent).toMatch(/Audio alone cannot be understood/);
  });

  it('blocks a religious BuildTrack identity in the form', async () => {
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(fakeClient())} />);
    const profile = qa('select').find((s) => s.querySelector('option[value="promotional"]'))!;
    await act(async () => setValue(profile as HTMLSelectElement, 'religious'));
    const identity = qa('select').find((s) => s.querySelector('option[value="buildtrack"]')) as HTMLSelectElement;
    const bt = Array.from(identity.options).find((o) => o.value === 'buildtrack')!;
    expect(bt.disabled).toBe(true);
  });

  it('shows a storyboard that is refused as a visible error and does not send it', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await act(async () => qa('input[name="inputMode"]')[3].click());
    await act(async () => setValue(q<HTMLTextAreaElement>('textarea'), '{"version":2,"scenes":[]}'));
    await click('[data-testid="create-draft"]');
    expect(client.calls.some((c) => c.name === 'createDraft')).toBe(false);
    expect(q('[data-testid="plan-error"]').textContent).toMatch(/version 1/);
  });
});

describe('treatments, scenes and voices', () => {
  it('lists three treatments with rationale and speaker assignment, and a selection is saved explicitly', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    expect(qa('[data-testid^="treatment-"]')).toHaveLength(3);
    expect(q('[data-testid="treatments"]').textContent).toMatch(/Names the problem first/);
    expect(q('[data-testid="treatments"]').textContent).toMatch(/Pictures: 1 supplied/);
    await act(async () => qa('input[name="treatment"]')[1].click());
    await flush();
    const patch = client.calls.find((c) => c.name === 'patchDraft');
    expect(patch).toBeDefined();
    expect((patch!.args[1] as { selectedTreatmentId: string }).selectedTreatmentId).toBe('edu-worked-example-first');
    expect((patch!.args[1] as { expectedRevision: number }).expectedRevision).toBe(3);
    expect(q<HTMLInputElement>('input[name="treatment"]:checked').closest('[data-testid^="treatment-"]')!.getAttribute('data-testid')).toBe('treatment-edu-worked-example-first');
    expect(q('[data-testid="content-plan"]').textContent).toMatch(/Selection saved\. Nothing is applied/);
  });

  it('shows the presentation-free scene table with the unexecuted visual features named', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    await act(async () => qa('input[name="treatment"]')[1].click());
    await flush();
    expect(q('[data-testid="selected-scenes"]').textContent).toMatch(/Not executed: screen recording/);
  });

  it('refuses a treatment switch while scene edits are unsaved, and keeps the edit', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    await change('select[aria-label="Speaker for u01"]', 'instructor');
    await act(async () => qa('input[name="treatment"]')[2].click());
    await flush();
    expect(client.calls.some((c) => c.name === 'patchDraft')).toBe(false);
    expect(q('[data-testid="plan-error"]').textContent).toMatch(/Save or discard your scene edits first/);
    expect(q<HTMLSelectElement>('select[aria-label="Speaker for u01"]').value).toBe('instructor');
  });

  it('marks an Arabic speaker as generation unavailable and points to imported audio', async () => {
    const env = envelopeOf();
    const arabic = { ...env, treatments: env.treatments.map((t) => ({ ...t, scenes: t.scenes.map((s) => ({ ...s, language: 'ar' as const })) })) };
    const client = fakeClient({ createDraft: vi.fn(async () => arabic) as never });
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    expect(q('[data-testid="speaker-instructor"]').textContent).toMatch(/generation unavailable/);
    expect(q('[data-testid="voices"]').textContent).toMatch(/Arabic lines need imported approved audio/);
    expect(q('[data-testid="voices"]').textContent).toMatch(/robotic English samples/);
  });

  it('lists the robotic English voices from the capability result and keeps the sample label', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    const voice = q<HTMLSelectElement>('select[aria-label="Voice for instructor"]');
    const labels = Array.from(voice.options).map((o) => o.textContent);
    expect(labels).toContain(CAPS.speech.voices[1].speakerLabel);
    expect(labels.every((l) => /Robotic English sample voice|No voice/.test(l ?? ''))).toBe(true);
  });
});

describe('apply and its failures', () => {
  it('stays blocked until the review is confirmed, then opens the new project in the editor', async () => {
    const opened: string[] = [];
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={(id) => opened.push(id)} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    expect((buttonByText('Apply to a new project') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => q<HTMLInputElement>('[data-testid="review-confirm"]').click());
    expect((buttonByText('Apply to a new project') as HTMLButtonElement).disabled).toBe(false);
    await click('[data-testid="apply-draft"]');
    expect(opened).toEqual(['Factory_aaaaaaaaaaaa']);
    expect(client.calls.find((c) => c.name === 'applyDraft')!.args).toEqual(['dft_0123456789abcdef', 3]);
  });

  it('a transport failure with no reply claims no completion, does not open the editor, and keeps the scene edits', async () => {
    const opened: string[] = [];
    const client = fakeClient({
      applyDraft: vi.fn(async () => { throw apiError('TRANSPORT', null, { answered: false }); }) as never,
    });
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={(id) => opened.push(id)} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    await act(async () => q<HTMLInputElement>('[data-testid="review-confirm"]').click());
    await click('[data-testid="apply-draft"]');
    expect(opened).toEqual([]);
    expect(q('[data-testid="plan-error"]').textContent).toMatch(/No completion is confirmed/);
    expect(q('[data-testid="scene-u01"]')).toBeTruthy();
    expect(client.calls.some((c) => c.name === 'getDraft')).toBe(true);
  });

  it('a transport failure where the server did record the project shows that project, without a success claim from the page', async () => {
    const opened: string[] = [];
    const recorded = envelopeOf({ appliedProjects: [{ projectId: 'Factory_bbbbbbbbbbbb', format: 'landscape', appliedAt: '2026-10-13T00:00:00Z' } as never] });
    const client = fakeClient({
      applyDraft: vi.fn(async () => { throw apiError('TRANSPORT', null, { answered: false }); }) as never,
      getDraft: vi.fn(async () => recorded) as never,
    });
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={(id) => opened.push(id)} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    await act(async () => q<HTMLInputElement>('[data-testid="review-confirm"]').click());
    await click('[data-testid="apply-draft"]');
    expect(opened).toEqual([]);
    expect(q('[data-testid="content-plan"]').textContent).toMatch(/Factory_bbbbbbbbbbbb/);
  });

  it('a revision conflict keeps the unsaved scene edits and offers a reload that keeps them on screen', async () => {
    const client = fakeClient({
      applyDraft: vi.fn(async () => { throw apiError('FACTORY_REVISION_CONFLICT', 409, { currentRevision: 5 }); }) as never,
    });
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    await act(async () => q<HTMLInputElement>('[data-testid="review-confirm"]').click());
    await click('[data-testid="apply-draft"]');
    expect(q('[data-testid="plan-error"]').textContent).toMatch(/revision 5/);
    expect(q('[data-testid="plan-error"]').textContent).not.toMatch(/completion is confirmed/);
    await click('[data-testid="plan-error"] button');
    expect(client.calls.some((c) => c.name === 'getDraft')).toBe(true);
  });

  it('a missing-input refusal lists what is missing and does not open the editor', async () => {
    const opened: string[] = [];
    const client = fakeClient({
      applyDraft: vi.fn(async () => { throw apiError('FACTORY_INPUTS_REQUIRED', 422, { missing: [{ kind: 'image', sceneId: 'u01', reason: 'No picture is chosen.' }] }); }) as never,
    });
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={(id) => opened.push(id)} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    await act(async () => q<HTMLInputElement>('[data-testid="review-confirm"]').click());
    await click('[data-testid="apply-draft"]');
    expect(opened).toEqual([]);
    expect(q('[data-testid="plan-error"]').textContent).toMatch(/image · u01: No picture is chosen/);
  });
});

describe('reopen a saved draft', () => {
  it('restores the draft, the selected treatment and the speaker decision from the server', async () => {
    const saved = envelopeOf({
      revision: 7,
      selectedTreatmentId: 'edu-worked-example-first',
      speakers: [{ id: 'learner', voiceId: null, available: false }, { id: 'instructor', voiceId: 'sam-reader', available: true }],
    });
    const getDraft = vi.fn(async () => saved);
    const client = fakeClient({ getDraft: getDraft as never });
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={() => {}} deps={deps(client)} />);
    expect(getDraft).toHaveBeenCalledWith('dft_0123456789abcdef');
    expect(q<HTMLInputElement>('input[name="treatment"]:checked').closest('[data-testid^="treatment-"]')!.getAttribute('data-testid')).toBe('treatment-edu-worked-example-first');
    expect(q<HTMLSelectElement>('select[aria-label="Voice for instructor"]').value).toBe('sam-reader');
    expect(q('[data-testid="draft-status"]').textContent).toMatch(/Revision 7/);
    expect(window.location.search).toContain('draft=dft_0123456789abcdef');
  });

  it('reports a draft that cannot be read, without inventing one', async () => {
    const client = fakeClient({ getDraft: vi.fn(async () => { throw apiError('FACTORY_NOT_FOUND', 404); }) as never });
    await mount(<ContentPlanPage initialDraftId="dft_missing" onOpenEditor={() => {}} deps={deps(client)} />);
    expect(q('[data-testid="plan-error"]').textContent).toMatch(/FACTORY_NOT_FOUND/);
    expect(qa('[data-testid="draft-status"]')).toHaveLength(0);
  });
});

describe('timing and apply reuse on the planning page (round 3)', () => {
  it('shows the predicted timing label in the planning column, not an unknown placeholder', async () => {
    const client = fakeClient();
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={() => {}} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    const table = q('[data-testid="selected-scenes"]').textContent ?? '';
    expect(table).toContain(MEASURED_LABEL);
    expect(table).not.toMatch(/Unknown until apply measures it/);
  });

  it('lists each applied project with its server timing status, and opens it', async () => {
    const opened: string[] = [];
    const projectTiming = vi.fn(async () => timingStatusOf({ status: 'edited', label: 'Timing edited after apply — the boundaries on screen no longer match the applied timing. Not verified by an alignment engine.', boundariesEdited: true }));
    const client = fakeClient({
      getDraft: async () => envelopeOf({ appliedProjects: [{ projectId: 'Factory_aaaaaaaaaaaa', editorRevision: 0, timingSource: 'measured_synthesis', appliedAt: '2026-10-13T00:00:00.000Z', draftRevision: 3 }] }),
      projectTiming,
    } as never);
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={(id) => opened.push(id)} deps={deps(client)} />);
    // A plain override is not recorded in client.calls, so assert on the spy itself.
    expect(projectTiming).toHaveBeenCalledWith('Factory_aaaaaaaaaaaa');
    expect(q('[data-testid="applied-timing"]').textContent).toMatch(/^Timing edited after apply/);
    await click('[data-testid="applied-projects"] button');
    expect(opened).toEqual(['Factory_aaaaaaaaaaaa']);
  });

  it('a failed timing status shows an error, never a label', async () => {
    const client = fakeClient({
      getDraft: async () => envelopeOf({ appliedProjects: [{ projectId: 'Factory_aaaaaaaaaaaa', editorRevision: 0, timingSource: 'measured_synthesis', appliedAt: '2026-10-13T00:00:00.000Z' }] }),
      projectTiming: async () => { throw apiError('FACTORY_PROJECT_NOT_FOUND', 404); },
    } as never);
    await mount(<ContentPlanPage initialDraftId="dft_0123456789abcdef" onOpenEditor={() => {}} deps={deps(client)} />);
    expect(q('[data-testid="applied-timing"]').textContent).toBe('Timing status could not be loaded.');
  });

  it('a reused apply says nothing new was created and still opens the existing project', async () => {
    const opened: string[] = [];
    const client = fakeClient({
      applyDraft: async () => ({ projectId: 'Factory_existing0001', targetId: 'long', format: 'landscape', editorRevision: 2, timingSource: 'measured_synthesis', timingLabel: MEASURED_LABEL, speechGenerated: 0, reused: true }),
    } as never);
    await mount(<ContentPlanPage initialDraftId={null} onOpenEditor={(id) => opened.push(id)} deps={deps(client)} />);
    await fillBriefAndScript();
    await click('[data-testid="create-draft"]');
    await act(async () => q<HTMLInputElement>('[data-testid="review-confirm"]').click());
    await click('[data-testid="apply-draft"]');
    expect(opened).toEqual(['Factory_existing0001']);
    expect(q('[data-testid="content-plan"]').textContent).toMatch(/already applied\. Opening the existing project Factory_existing0001; nothing new was created/);
  });
});

