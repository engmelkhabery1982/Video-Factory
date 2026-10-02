/**
 * @vitest-environment happy-dom
 *
 * AUDIT ITEM M — storyboard navigation for legacy vs production projects.
 *
 * The Storyboard step used to hold an always-production ternary
 * (`exists ? 'production' : 'production'`), i.e. the legacy storyboard was
 * unreachable and a legacy project was silently routed into a production view
 * with no production state. The documented policy (see
 * `apps/web/src/lib/production-navigation.ts`) is:
 *
 *   production state  → production storyboard (new authority)
 *   no state / failed read → legacy storyboard (original supported pipeline)
 *
 * This suite tests the policy function directly AND mounts the real
 * `StoryboardGate` (with the two page components stubbed) to prove the rendered
 * navigation, including the "reopen a different project" transition where the
 * gate must re-decide for the NEW project rather than keep the old mode.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storyboardModeForProduction } from '../apps/web/src/lib/production-navigation.js';

import { api } from '../apps/web/src/lib/api.js';

vi.mock('../apps/web/src/pages/ProductionStoryboard.js', () => ({
  ProductionStoryboardPage: () => React.createElement('div', null, 'PRODUCTION_STORYBOARD'),
}));
vi.mock('../apps/web/src/pages/Storyboard.js', () => ({
  StoryboardPage: () => React.createElement('div', null, 'LEGACY_STORYBOARD'),
}));

import { StoryboardGate } from '../apps/web/src/App.js';

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
  });
}

describe('audit M — storyboard navigation resolves per project generation', () => {
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

  it('M1 — policy: production state → production storyboard; anything else → legacy', () => {
    expect(storyboardModeForProduction({ exists: true, status: 'generated' })).toBe('production');
    expect(storyboardModeForProduction({ exists: true, status: 'needs_regeneration', stale: true })).toBe('production');
    expect(storyboardModeForProduction({ exists: false })).toBe('legacy');
    expect(storyboardModeForProduction({})).toBe('legacy');
    expect(storyboardModeForProduction(null)).toBe('legacy');
    expect(storyboardModeForProduction(undefined)).toBe('legacy');
    // A truthy non-boolean `exists` must not count as production state.
    expect(storyboardModeForProduction({ exists: 'yes' })).toBe('legacy');
  });

  it('M2 — a production project renders the production storyboard', async () => {
    vi.spyOn(api, 'production').mockResolvedValue({ production: { exists: true, status: 'generated' } } as any);
    act(() => root.render(React.createElement(StoryboardGate, { projectId: 'Prod_01', onNext: () => {}, onAssets: () => {}, toast: () => {} })));
    await flush();
    expect(container.textContent).toContain('PRODUCTION_STORYBOARD');
    expect(container.textContent).not.toContain('LEGACY_STORYBOARD');
    expect(api.production).toHaveBeenCalledWith('Prod_01');
  });

  it('M3 — a legacy project renders the legacy storyboard, never a production view without state', async () => {
    vi.spyOn(api, 'production').mockResolvedValue({ production: { exists: false } } as any);
    act(() => root.render(React.createElement(StoryboardGate, { projectId: 'Legacy_01', onNext: () => {}, onAssets: () => {}, toast: () => {} })));
    await flush();
    expect(container.textContent).toContain('LEGACY_STORYBOARD');
    expect(container.textContent).not.toContain('PRODUCTION_STORYBOARD');
  });

  it('M4 — a failed production-state read falls back to the legacy storyboard, not to an empty production view', async () => {
    vi.spyOn(api, 'production').mockRejectedValue(new Error('sidecar unreadable'));
    act(() => root.render(React.createElement(StoryboardGate, { projectId: 'Broken_01', onNext: () => {}, onAssets: () => {}, toast: () => {} })));
    await flush();
    expect(container.textContent).toContain('LEGACY_STORYBOARD');
  });

  it('M5 — reopen/navigation: switching to another project re-decides the mode for the new project', async () => {
    const spy = vi.spyOn(api, 'production');
    spy.mockResolvedValueOnce({ production: { exists: false } } as any);
    act(() => root.render(React.createElement(StoryboardGate, { projectId: 'First_legacy', onNext: () => {}, onAssets: () => {}, toast: () => {} })));
    await flush();
    expect(container.textContent).toContain('LEGACY_STORYBOARD');

    // Reopen the same app on a production project (fresh navigation, new id).
    spy.mockResolvedValueOnce({ production: { exists: true, status: 'generated' } } as any);
    act(() => root.render(React.createElement(StoryboardGate, { projectId: 'Second_production', onNext: () => {}, onAssets: () => {}, toast: () => {} })));
    await flush();
    expect(container.textContent).toContain('PRODUCTION_STORYBOARD');
    expect(api.production).toHaveBeenLastCalledWith('Second_production');

    // ...and back to a legacy project: no stale production mode is kept.
    spy.mockResolvedValueOnce({ production: { exists: false } } as any);
    act(() => root.render(React.createElement(StoryboardGate, { projectId: 'Third_legacy', onNext: () => {}, onAssets: () => {}, toast: () => {} })));
    await flush();
    expect(container.textContent).toContain('LEGACY_STORYBOARD');
    expect(api.production).toHaveBeenLastCalledWith('Third_legacy');
  });
});
