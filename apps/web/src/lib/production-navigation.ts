/**
 * Storyboard navigation policy for the two project generations (audit item M).
 *
 * DOCUMENTED LEGACY-PROJECT POLICY
 * --------------------------------
 * This product has two generations of project:
 *
 *   - PRODUCTION projects — they have a production sidecar (`data/projects/<id>/production.json`,
 *     surfaced by `GET /api/projects/:id/production` as `production.exists === true`).
 *     They are produced by the production authority
 *     (Scenario → production audio → Phase 5 → Phase 6A → Phase 6C → Phase 6D).
 *
 *   - LEGACY projects — created before the production engine; they have a storyboard
 *     but no production sidecar. They remain SUPPORTED on their original pipeline:
 *     their storyboard, captions and export stay the legacy ones. They are never
 *     silently migrated, and they are never routed into the production surfaces,
 *     which would show "no production state" and could not export their existing work.
 *
 * The decision is therefore driven by the presence of production state alone:
 * production state → production storyboard; anything else (no sidecar, failed
 * sidecar read) → legacy storyboard. A failed status read must not silently
 * pretend a legacy project is a production project.
 */
export type StoryboardMode = 'loading' | 'production' | 'legacy';

/**
 * True when the project is a production project.
 *
 * Only `production.exists === true` counts. `null`/`undefined` (request failed or
 * response had no summary) and objects without `exists` are treated as legacy so
 * the operator keeps the working legacy path instead of a broken production view.
 */
export function hasProductionState(production: unknown): boolean {
  return Boolean(production && typeof production === 'object' && (production as { exists?: unknown }).exists === true);
}

/** Storyboard mode for a production summary once the request has resolved. */
export function storyboardModeForProduction(production: unknown): StoryboardMode {
  return hasProductionState(production) ? 'production' : 'legacy';
}
