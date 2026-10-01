/**
 * @vitest-environment happy-dom
 *
 * PRODUCTION UI CONTRACT (Part 8).
 *
 * These tests render the REAL pages and operate them:
 *
 *   8A Captions — a production project shows the reconciled PRODUCTION caption
 *      plan and does NOT render the legacy caption editor or the legacy
 *      TargetAudioPanel (neither would change the production video).
 *   8B Export — a production project drives preview/final through the
 *      production API only; the legacy `exportProject`/`runQc` video authority
 *      is never invoked, and stale state is surfaced instead of exported.
 *   8C Project list — production status, targets, build/artifact counts and the
 *      real production casting history are surfaced; the legacy visual history
 *      is explicitly labelled as legacy-only.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../apps/web/src/lib/api.js';
import { CaptionsPage } from '../apps/web/src/pages/Captions.js';
import { ExportPage } from '../apps/web/src/pages/Export.js';
import { ProjectList } from '../apps/web/src/pages/ProjectList.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const productionSummary = {
  exists: true,
  status: 'generated',
  stale: false,
  targets: ['long', 'short_1'],
  builds: [{ kind: 'preview', status: 'ok', at: '2026-10-01T00:00:00.000Z' }],
  artifacts: [{ target: 'preview', kind: 'video', relPath: 'Prod_01/preview/long.mp4', sizeBytes: 10, createdAt: '2026-10-01T00:00:00.000Z' }],
  lastReadiness: { status: 'incomplete', readyForProductionDelivery: false, dimensions: [], findings: [] },
  lastQcSummary: null,
  productKitPath: null,
  packageRoot: null,
};

const captionsPayload = {
  target: 'long',
  audioEngine: 'kokoro-js',
  captions: [
    { cueId: 'cue-1', text: 'Your site is 70% finished but only 59.5% accepted.', start: 0.4, end: 3.1, sceneId: 'sc-prod-01', speakerId: 'char-prod-challenger', voiceSlot: 'voice_en_male_practical' },
    { cueId: 'cue-2', text: 'That 10.5 percent gap is a commercial risk.', start: 3.4, end: 6.2, sceneId: 'sc-prod-02', speakerId: 'char-prod-controls', voiceSlot: 'voice_us_male_executive' },
  ],
};

function projectFixture() {
  return {
    project: {
      meta: {
        input: { videoId: 'Prod_01', topic: 'Executed versus accepted', keyNumbers: ['70%', '59.5%'], keyPoints: [] },
        status: 'storyboarded',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      storyboard: {
        long: { scenes: [] },
        shorts: [],
        captions: [{ id: 'legacy-cue-1', text: 'LEGACY CUE TEXT', start: 0, end: 2 }],
        similarity: { score: 0.1 },
      },
      artifacts: [],
      variants: {},
    },
    assets: [],
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('production UI contract', () => {
  let host: HTMLDivElement;
  let root: Root;
  let toast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    toast = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('8A — Captions renders the production cue plan and neither the legacy editor nor the legacy target-audio panel', async () => {
    vi.spyOn(api, 'project').mockResolvedValue(projectFixture() as any);
    vi.spyOn(api, 'production').mockResolvedValue({ production: productionSummary } as any);
    vi.spyOn(api, 'productionCaptions').mockResolvedValue(captionsPayload as any);
    vi.spyOn(api, 'variants').mockResolvedValue({} as any);

    await act(async () => {
      root.render(React.createElement(CaptionsPage, { projectId: 'Prod_01', onNext: () => {}, onBack: () => {}, toast }));
    });
    await flush();

    // Production authority is visible…
    expect(host.textContent).toContain('Production captions');
    expect(host.textContent).toContain('Your site is 70% finished but only 59.5% accepted.');
    expect(host.textContent).toContain('That 10.5 percent gap is a commercial risk.');
    expect(host.textContent).toContain('audio authority');
    // …and points wording changes at the Production Storyboard.
    expect(host.textContent).toContain('Production Storyboard');

    // Legacy authorities are absent.
    expect(host.textContent).not.toContain('LEGACY CUE TEXT');
    expect(api.productionCaptions).toHaveBeenCalledWith('Prod_01', 'long');
    // No manual timing nudges and no target-audio panel in production mode.
    const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(buttons.some((t) => /−0\.1|−0.1|\+0\.1|\+0.1/.test(t))).toBe(false);
    expect(host.querySelector('[data-testid^="target-audio-"]')).toBeNull();
    expect(host.textContent).not.toContain('Narration audio');
  });

  it('8B — Export drives preview/final through the production API and never calls the legacy export or QC runners', async () => {
    vi.spyOn(api, 'project').mockResolvedValue(projectFixture() as any);
    vi.spyOn(api, 'production').mockResolvedValue({ production: productionSummary } as any);
    vi.spyOn(api, 'variants').mockResolvedValue({} as any);
    const preview = vi.spyOn(api, 'productionPreview').mockResolvedValue({ jobId: 'job-preview', production: true, status: 'running' } as any);
    const exportFinal = vi.spyOn(api, 'productionExport').mockResolvedValue({ jobId: 'job-final', production: true, status: 'running' } as any);
    const legacyExport = vi.spyOn(api, 'startExport').mockResolvedValue({ jobId: 'legacy-job' } as any);
    const legacyQc = vi.spyOn(api, 'runQc').mockResolvedValue({} as any);
    vi.spyOn(api, 'productionJob').mockResolvedValue({ jobId: 'job-preview', status: 'running' } as any);

    const buttonByText = (needle: string): HTMLButtonElement => {
      const button = [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(needle));
      if (!button) throw new Error(`button not found: ${needle}`);
      return button as HTMLButtonElement;
    };

    // One running build at a time is a product invariant: drive each action in
    // its own mount cycle (fresh page = no running job).
    await act(async () => {
      root.render(React.createElement(ExportPage, { projectId: 'Prod_01', onBack: () => {}, toast }));
    });
    await flush();
    expect(host.textContent).toContain('Production QC & export');
    expect(host.textContent).toContain('Kokoro dialogue audio');
    expect(host.textContent).toContain('long');
    expect(host.textContent).toContain('short_1');
    await act(async () => buttonByText('Generate preview').click());
    await flush();
    expect(preview).toHaveBeenCalledWith('Prod_01');

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(ExportPage, { projectId: 'Prod_01', onBack: () => {}, toast }));
    });
    await flush();
    await act(async () => buttonByText('Final production export').click());
    await flush();
    expect(exportFinal).toHaveBeenCalledWith('Prod_01');

    expect(legacyExport).not.toHaveBeenCalled();
    expect(legacyQc).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Run QC now');

    // Production artifacts are listed with real output URLs.
    const links = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(links.some((href) => href.includes('/output/Prod_01/preview/long.mp4'))).toBe(true);
  });

  it('8B — a stale production project cannot be exported and is told to regenerate', async () => {
    vi.spyOn(api, 'project').mockResolvedValue(projectFixture() as any);
    vi.spyOn(api, 'production').mockResolvedValue({
      production: { ...productionSummary, status: 'needs_regeneration', stale: true },
    } as any);
    vi.spyOn(api, 'variants').mockResolvedValue({} as any);
    const preview = vi.spyOn(api, 'productionPreview').mockResolvedValue({ jobId: 'x', production: true } as any);
    const exportFinal = vi.spyOn(api, 'productionExport').mockResolvedValue({ jobId: 'y', production: true } as any);

    await act(async () => {
      root.render(React.createElement(ExportPage, { projectId: 'Prod_01', onBack: () => {}, toast }));
    });
    await flush();

    expect(host.textContent).toMatch(/stale/i);
    expect(host.textContent).toMatch(/regenerate/i);
    const buttons = [...host.querySelectorAll('button')].filter((b) => /preview|final production/i.test(b.textContent ?? ''));
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(preview).not.toHaveBeenCalled();
    expect(exportFinal).not.toHaveBeenCalled();
  });

  it('8C — the project list surfaces production status/targets/artifact counts and the real production history', async () => {
    vi.spyOn(api, 'projects').mockResolvedValue({
      projects: [
        {
          videoId: 'Prod_01',
          topic: 'Executed versus accepted',
          status: 'storyboarded',
          updatedAt: '2026-10-01T00:00:00.000Z',
          scenes: 0,
          shorts: 0,
          artifacts: 0,
          production: {
            exists: true,
            status: 'needs_regeneration',
            stale: true,
            targets: ['long', 'short_1'],
            artifactCount: 4,
            buildCount: 2,
            lastBuild: { kind: 'preview', status: 'ok', at: '2026-10-01T00:00:00.000Z' },
            readiness: { status: 'blocked', readyForProductionDelivery: false },
            packageStatus: 'failed',
            hasProductKit: true,
          },
        },
        {
          videoId: 'Legacy_01',
          topic: 'Legacy project',
          status: 'exported',
          updatedAt: '2026-09-01T00:00:00.000Z',
          scenes: 5,
          shorts: 3,
          artifacts: 2,
          production: null,
        },
      ],
      history: { videos: [{ videoId: 'Legacy_01', hookVariant: 'question', ctaAnimation: 'none', captionStyle: 'clean', sceneOrder: ['hook', 'cta'] }] },
      productionHistory: [
        {
          videoId: 'Prod_00',
          at: '2026-09-30T00:00:00.000Z',
          casting: { challenger: 'persona-a', technical_authority: 'persona-b', decision_maker: 'persona-c' },
          styleFingerprint: '{"targets":["long"]}',
        },
      ],
    } as any);

    await act(async () => {
      root.render(React.createElement(ProjectList, { onOpen: () => {}, onNew: () => {} }));
    });
    await flush();

    // Production project row shows production facts.
    expect(host.textContent).toContain('needs regeneration');
    expect(host.textContent).toContain('stale');
    expect(host.textContent).toContain('long, short_1');
    expect(host.textContent).toContain('2 build(s) · 4 artifact(s)');
    expect(host.textContent).toContain('QC blocked');

    // Legacy project row keeps legacy facts, clearly separated.
    expect(host.textContent).toContain('5 scenes / 3 shorts');
    expect(host.textContent).toContain('2 artifact(s)');
    expect(host.textContent).toContain('1 production project(s) · 1 legacy/reference project(s)');

    // Real production casting history is shown, with the legacy log labelled.
    expect(host.textContent).toContain('Production anti-repetition log (production_history.json)');
    expect(host.textContent).toContain('Prod_00');
    expect(host.textContent).toContain('persona-a');
    expect(host.textContent).toContain('per-target semantic fingerprint');
    expect(host.textContent).toContain('Legacy visual history (visual_history.json) — legacy/reference projects only');
    expect(host.textContent).toContain('not the authority for production projects');
  });
});
