/**
 * Turn a production-caption failure into a diagnosis the page can show.
 * The exception is kept, redacted, and never replaced with an empty success.
 */

export interface ProductionFailureDiagnosis {
  status: number;
  code: string;
  error: string;
  diagnosis: string;
}

export function redactProductionMessage(message: string): string {
  return message
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '[path]')
    .replace(/\/(?:home|Users|tmp|var|opt|private)\/[^\s'"]+/g, '[path]')
    .slice(0, 500);
}

export function classifyProductionFailure(error: unknown): ProductionFailureDiagnosis {
  const name = error instanceof Error ? error.name : 'Error';
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactProductionMessage(raw);
  const lower = message.toLowerCase();
  if (
    /provision:tts/.test(message) ||
    /synthesizer_unavailable/.test(lower) ||
    /not present in local cache/.test(lower) ||
    (/not available/.test(lower) && /kokoro|synthesizer|chatterbox/.test(lower))
  ) {
    return {
      status: 503,
      code: 'ENGINE_NOT_PROVISIONED',
      error: message,
      diagnosis:
        'The speech engine is not provisioned. This is not a missing narration file, not old production state, and not corrupt data. No empty caption list was returned.',
    };
  }
  if (/does not support requested language/.test(message) || /unsupported language/.test(lower)) {
    return {
      status: 422,
      code: 'DIALOGUE_LANGUAGE_UNSUPPORTED',
      error: message,
      diagnosis:
        'The in-app dialogue voice does not support this language. This is not an unprovisioned engine and not a missing narration file. No caption list was invented.',
    };
  }
  return {
    status: 500,
    code: 'PRODUCTION_CAPTIONS_FAILED',
    error: `${name}: ${message}`,
    diagnosis: 'Unexpected production-caption failure. The exception is included. This is not an empty success.',
  };
}
