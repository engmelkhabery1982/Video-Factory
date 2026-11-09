/** Saved narration choice. Absence is not a conversion. */
export function usesExternalReadyNarration(input: { narrationSource?: unknown } | null | undefined): boolean {
  return input?.narrationSource === 'external_ready';
}
