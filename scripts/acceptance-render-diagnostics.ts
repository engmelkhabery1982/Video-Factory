/** Keep a failed production job's actual per-target error visible in CI. */
export function productionJobFailureDetail(job: unknown): Record<string, unknown> {
  const record = job && typeof job === 'object' ? job as Record<string, unknown> : {};
  const result = record.result && typeof record.result === 'object'
    ? record.result as Record<string, unknown>
    : {};
  const render = result.renderResults && typeof result.renderResults === 'object'
    ? result.renderResults as Record<string, unknown>
    : {};
  const results = Array.isArray(render.results) ? render.results : [];
  return {
    jobStatus: record.status ?? null,
    status: result.status ?? null,
    error: record.error ?? null,
    renderStatus: render.status ?? null,
    failedTargetIds: render.failedTargetIds ?? [],
    targetErrors: results.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === 'object' && (entry as Record<string, unknown>).success === false),
    ).map((entry) => ({ targetId: entry.targetId ?? null, error: entry.error ?? null })),
  };
}
