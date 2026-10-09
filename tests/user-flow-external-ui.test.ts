/**
 * @vitest-environment happy-dom
 *
 * The pages the operator actually opens. This is not a browser test.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastHost } from '../apps/web/src/components/ui.js';
import { api } from '../apps/web/src/lib/api.js';
import { NewProject } from '../apps/web/src/pages/NewProject.js';
import { CaptionsPage } from '../apps/web/src/pages/Captions.js';
import { ExportPage } from '../apps/web/src/pages/Export.js';
import { storyboardModeForProject } from '../apps/web/src/lib/production-navigation.js';

const SCRIPT = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ\n\nاللَّهُمَّ إِنِّي أَسْأَلُكَ بِرَحْمَتِكَ.';

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('external narration is the page the operator opens', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('creating an external project does not call production generation', async () => {
    vi.spyOn(api, 'assets').mockResolvedValue({ assets: [] } as never);
    const create = vi.spyOn(api, 'createProject').mockResolvedValue({ project: { meta: { input: {} } } } as never);
    const storyboard = vi.spyOn(api, 'storyboard').mockResolvedValue({ project: {} } as never);
    const generate = vi.spyOn(api, 'productionGenerate').mockResolvedValue({ production: { targets: [] } } as never);
    await act(async () => {
      root.render(React.createElement(ToastHost, null, React.createElement(NewProject, { onCreated: () => {}, onCancel: () => {} })));
    });
    const external = container.querySelector('input[name="narrationSource"][value], input[type="radio"]') as HTMLInputElement | null;
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    await act(async () => {
      radios[1].click();
    });
    const setNative = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[];
    const textareas = Array.from(container.querySelectorAll('textarea')) as HTMLTextAreaElement[];
    const idInput = inputs.find((input) => input.value.startsWith('Video_')) ?? inputs[0];
    await act(async () => {
      setNative(idInput, 'Rahman_UI');
      const topic = inputs.find((input) => input.placeholder?.includes('Executed')) ?? inputs[1];
      setNative(topic, 'رحمة');
      setNative(textareas[0], SCRIPT);
    });
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('Create project'));
    expect(button?.textContent).toContain('from this script');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(create).toHaveBeenCalled();
    const sent = create.mock.calls[0][0] as { narrationSource?: string; script?: string };
    expect(sent.narrationSource).toBe('external_ready');
    expect(sent.script).toContain('الرَّحْمَٰنِ');
    expect(storyboard).toHaveBeenCalledWith('Rahman_UI', false);
    expect(generate).not.toHaveBeenCalled();
    void external;
  });

  it('shows the external card even when a production sidecar exists', async () => {
    vi.spyOn(api, 'variants').mockResolvedValue({ glossary: [] } as never);
    vi.spyOn(api, 'project').mockResolvedValue({
      project: {
        meta: { input: { narrationSource: 'external_ready', videoId: 'Ext' } },
        storyboard: { captions: [{ id: 'cap_01', text: SCRIPT, start: 0, end: 2 }], long: { scenes: [] } },
      },
      assets: [],
    } as never);
    vi.spyOn(api, 'production').mockResolvedValue({ production: { exists: true, targets: ['long'], status: 'generated' } } as never);
    const captions = vi.spyOn(api, 'productionCaptions').mockResolvedValue({ captions: [] } as never);
    vi.spyOn(api, 'targetAudio').mockResolvedValue({ targets: [] } as never);
    vi.spyOn(api, 'externalNarration').mockResolvedValue({
      importedCount: 0,
      totalTargets: 1,
      readyCount: 0,
      blockedCount: 0,
      targets: [{ targetId: 'long', label: 'Long', import: null, approval: null, ready: false, readiness: null }],
    } as never);
    await act(async () => {
      root.render(React.createElement(CaptionsPage, { projectId: 'Ext', onNext: () => {}, onBack: () => {}, toast: () => {} }));
    });
    await flush();
    expect(container.textContent).toContain('Narration from outside the app');
    expect(container.textContent).toContain('No narration file yet');
    expect(container.textContent).not.toContain('Kokoro dialogue track');
    expect(captions).not.toHaveBeenCalled();
  });

  it('exports an external project through the ordinary export, not production export', async () => {
    vi.spyOn(api, 'project').mockResolvedValue({
      project: {
        meta: { input: { narrationSource: 'external_ready' } },
        storyboard: { similarity: null },
        artifacts: [],
      },
    } as never);
    vi.spyOn(api, 'production').mockResolvedValue({
      production: { exists: true, status: 'generated', targets: ['long'], audioEngine: 'kokoro-js' },
    } as never);
    vi.spyOn(api, 'externalNarration').mockResolvedValue({
      importedCount: 1,
      targets: [{
        targetId: 'long',
        label: 'Long',
        import: { importId: 'imp', fileName: 'narration.wav' },
        approval: null,
        ready: false,
        readiness: {
          applies: true,
          inheritsLongNarration: false,
          exportAttemptReady: false,
          publicationApproved: false,
          lines: [{ key: 'export', label: 'Export', state: 'Blocked', ok: false, detail: 'Listen first' }],
          blockers: [{ code: 'IMPORT-APPROVAL-MISSING', message: 'Listen first', remediation: 'Approve it.', control: 'Approve', where: 'captions' }],
        },
      }],
    } as never);
    const productionExport = vi.spyOn(api, 'productionExport').mockResolvedValue({ jobId: 'prod' } as never);
    const startExport = vi.spyOn(api, 'startExport').mockResolvedValue({ jobId: 'ordinary' } as never);
    await act(async () => {
      root.render(React.createElement(ExportPage, { projectId: 'Ext', onBack: () => {}, toast: () => {} }));
    });
    await flush();
    expect(container.textContent).toContain('Ready narration export');
    expect(container.textContent).not.toContain('Final production export');
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Final export');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(productionExport).not.toHaveBeenCalled();
    expect(startExport).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Listen first');
  });

  it('keeps a leftover production sidecar off the storyboard when the choice is external', () => {
    expect(storyboardModeForProject({ narrationSource: 'external_ready' }, { exists: true })).toBe('legacy');
    expect(storyboardModeForProject({ narrationSource: null }, { exists: true })).toBe('production');
    expect(storyboardModeForProject({}, { exists: false })).toBe('legacy');
  });

  it('sends one JSON content type when the page records listening approval', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await api.externalNarrationApproval('Video_01', 'long', { decision: 'approved', listened: true, decidedBy: 'project-owner' });
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const contentTypes = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'content-type');
    expect(contentTypes).toEqual([['Content-Type', 'application/json']]);
    expect(String(contentTypes[0]?.[1])).not.toContain(',');
  });
});
