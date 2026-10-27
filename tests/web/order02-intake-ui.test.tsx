// @vitest-environment happy-dom
/**
 * DOM evidence (happy-dom, not a real browser) for the Order 02 intake additions:
 * rule-based topic starter, explicit video-audio policy, built-in PDF import and the exact
 * local planner gate. The factory client is a LABELLED TEST DOUBLE: no server, model, parser
 * or provider runs here. The matching real-route evidence lives in:
 *  - tests/topic-starter.test.ts (pure rules), tests/factory-video-audio-policy-http.test.ts (HTTP),
 *  - tests/pdf-storyboard-parser.test.ts + tests/factory-pdf-import-http.test.ts (real parse/HTTP).
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PdfStoryboardImport,
  PlannerGateNote,
  TopicStarter,
  VideoAudioPolicyChoice,
} from '../../apps/web/src/components/factory/IntakePanels';
import { FactoryApiError } from '../../apps/web/src/lib/factory-api';
import { fakeClient } from './fixtures';

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
});

const q = <T extends Element = HTMLElement>(sel: string): T => {
  const el = (host ?? document.body).querySelector(sel) as T | null;
  if (!el) throw new Error(`not found: ${sel}`);
  return el;
};
const qa = (sel: string) => Array.from((host ?? document.body).querySelectorAll(sel)) as HTMLElement[];
const click = (el: HTMLElement) => act(async () => el.click());
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function pickFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('TopicStarter (local rules, no model)', () => {
  it('requests suggestions with the profile and purpose, labels the route and fills the brief on use', async () => {
    const client = fakeClient();
    const onUse = vi.fn();
    await render(<TopicStarter client={client} profile="educational" onUseTopic={onUse} />);

    setValue(q<HTMLInputElement>('input[aria-label="Channel purpose for topic suggestions"]'), 'pump maintenance');
    await click(q('[data-testid="topic-suggest"]'));
    await flush();

    const call = client.calls.find((c) => c.name === 'topicSuggestions');
    expect(call).toBeTruthy();
    expect(call!.args).toEqual(['educational', 'pump maintenance']);
    expect(q('[data-testid="topic-results"]').textContent).toContain('local_rules');
    expect(qa('[data-testid="topic-item"]')).toHaveLength(3);

    await click(q('[data-testid="topic-use-topic-1"]'));
    expect(onUse).toHaveBeenCalledWith('The one mistake beginners make with pumps');
  });

  it('surfaces a server refusal as an alert and never invents topics', async () => {
    const client = fakeClient({
      topicSuggestions: vi.fn(async () => {
        throw new FactoryApiError({ message: 'profile must be religious, educational or promotional.', status: 422, code: 'FACTORY_VALIDATION', answered: true });
      }),
    });
    await render(<TopicStarter client={client} profile="promotional" onUseTopic={() => undefined} />);
    await click(q('[data-testid="topic-suggest"]'));
    await flush();
    expect(q('[role="alert"]').textContent).toContain('profile must be religious');
    expect(qa('[data-testid="topic-item"]')).toHaveLength(0);
  });
});

describe('VideoAudioPolicyChoice', () => {
  it('offers the legacy mute default plus the four explicit policies and reports each choice', async () => {
    const onChange = vi.fn();
    await render(<VideoAudioPolicyChoice value={null} onChange={onChange} />);
    const radios = qa('input[name="videoAudioPolicy"]') as HTMLInputElement[];
    expect(radios).toHaveLength(5);
    expect(q<HTMLInputElement>('[data-testid="video-audio-legacy"]').checked).toBe(true);

    await click(q('[data-testid="video-audio-original"]'));
    expect(onChange).toHaveBeenLastCalledWith('original');
    await click(q('[data-testid="video-audio-silent"]'));
    expect(onChange).toHaveBeenLastCalledWith('silent');
  });

  it('reflects a stored policy and can be disabled while a request is in flight', async () => {
    await render(<VideoAudioPolicyChoice value="add" onChange={() => undefined} disabled />);
    expect(q<HTMLInputElement>('[data-testid="video-audio-add"]').checked).toBe(true);
    expect(qa('input[name="videoAudioPolicy"]').every((r) => (r as HTMLInputElement).disabled)).toBe(true);
  });
});

describe('PdfStoryboardImport', () => {
  it('refuses to send without source and licence, making no client call', async () => {
    const client = fakeClient();
    await render(<PdfStoryboardImport client={client} onImported={() => undefined} />);
    pickFile(q<HTMLInputElement>('input[aria-label="PDF storyboard file"]'), new File(['%PDF-1.4'], 'sb.pdf', { type: 'application/pdf' }));
    await click(q('[data-testid="pdf-import-submit"]'));
    expect(q('[data-testid="pdf-import-error"]').textContent).toContain('source and licence');
    expect(client.calls.some((c) => c.name === 'importStoryboardPdf')).toBe(false);
  });

  it('sends the multipart import and hands the ordered storyboard and picture ids to the parent', async () => {
    const client = fakeClient();
    const onImported = vi.fn();
    await render(<PdfStoryboardImport client={client} onImported={onImported} />);
    pickFile(q<HTMLInputElement>('input[aria-label="PDF storyboard file"]'), new File(['%PDF-1.4'], 'storyboard.pdf', { type: 'application/pdf' }));
    setValue(q<HTMLInputElement>('input[aria-label="PDF source"]'), 'Synthetic fixture');
    setValue(q<HTMLInputElement>('input[aria-label="PDF licence"]'), 'Test only');
    await click(q('[data-testid="pdf-import-submit"]'));
    await flush();

    const call = client.calls.find((c) => c.name === 'importStoryboardPdf');
    expect(call).toBeTruthy();
    const [file, source, license] = call!.args as [File, string, string];
    expect(file.name).toBe('storyboard.pdf');
    expect(source).toBe('Synthetic fixture');
    expect(license).toBe('Test only');
    expect(onImported).toHaveBeenCalledTimes(1);
    const result = onImported.mock.calls[0][0];
    expect(result.storyboard.scenes.map((s: { id: string }) => s.id)).toEqual(['page-01', 'page-02']);
    expect(result.visualAssetIds).toEqual(['pic-1']);
    expect(q('[data-testid="pdf-import-note"]').textContent).toContain('2 page(s)');
  });

  it('shows a precise parser refusal and keeps the form contents', async () => {
    const client = fakeClient({
      importStoryboardPdf: vi.fn(async () => {
        throw new FactoryApiError({ message: 'Encrypted PDFs are not supported. Remove the password and save an unencrypted copy.', status: 422, code: 'FACTORY_PDF_ENCRYPTED', answered: true });
      }),
    });
    await render(<PdfStoryboardImport client={client} onImported={() => undefined} />);
    pickFile(q<HTMLInputElement>('input[aria-label="PDF storyboard file"]'), new File(['%PDF-1.4'], 'locked.pdf', { type: 'application/pdf' }));
    setValue(q<HTMLInputElement>('input[aria-label="PDF source"]'), 'Synthetic fixture');
    setValue(q<HTMLInputElement>('input[aria-label="PDF licence"]'), 'Test only');
    await click(q('[data-testid="pdf-import-submit"]'));
    await flush();
    expect(q('[data-testid="pdf-import-error"]').textContent).toMatch(/Encrypted/);
    expect((q<HTMLInputElement>('input[aria-label="PDF source"]')).value).toBe('Synthetic fixture');
  });
});

describe('PlannerGateNote', () => {
  it('names every missing local setting and states Google is not used', async () => {
    await render(
      <PlannerGateNote
        gate={{
          ready: false,
          route: 'local_llm',
          reason: 'Semantic planning is unavailable: LOCAL_LLM_ENABLED=1 is not set. Google is not used for planning.',
          missing: ['LOCAL_LLM_ENABLED=1 is not set', 'LOCAL_LLM_ENDPOINT is not set'],
          model: null,
          license: null,
          endpoint: 'loopback only',
          googleUsed: false,
          pinnedModel: 'pinned-model',
          licenceMatchesPin: null,
        }}
      />,
    );
    const note = q('[data-testid="planner-gate"]').textContent ?? '';
    expect(note).toContain('LOCAL_LLM_ENABLED');
    expect(note).toContain('Google used: false');
    expect(qa('[data-testid="planner-gate-missing"] li')).toHaveLength(2);
  });

  it('announces readiness without a missing-settings list when the local planner is configured', async () => {
    await render(
      <PlannerGateNote
        gate={{
          ready: true,
          route: 'local_llm',
          reason: 'Local semantic planner reachable on the loopback endpoint.',
          missing: [],
          model: 'pinned-model',
          license: 'apache-2.0',
          endpoint: 'loopback only',
          googleUsed: false,
          pinnedModel: 'pinned-model',
          licenceMatchesPin: true,
        }}
      />,
    );
    expect(qa('[data-testid="planner-gate-missing"]')).toHaveLength(0);
    expect(q('[data-testid="planner-gate"]').textContent).toContain('configured on this host');
  });
});
