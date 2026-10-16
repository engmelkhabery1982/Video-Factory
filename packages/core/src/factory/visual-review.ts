/**
 * Local picture understanding: the strict observation contract and the review rules.
 *
 * A local vision model reads ONE picture and returns ONE JSON object. The server parses it strictly before anything
 * is stored. Nothing here calls a provider. An observation is a suggestion until a person reviews it; only a reviewed
 * description can be used in a still prompt, and only by an explicit choice per picture.
 *
 * Religious stills: a picture that shows lettering, scripture or a brand is refused as a reviewed reference. A religious
 * still carries no brand, identity or lettering, so such a description cannot become a reference for one.
 */
import { parseVisualDescription, religiousRefusals, validateVisualDescription, type StillProfile } from './still-prompt.js';

export const VISION_OBSERVATION_KEYS = [
  'subject',
  'environment',
  'lighting',
  'composition',
  'shot',
  'exclude',
  'containsText',
  'containsLogoOrBrand',
  'containsPeople',
  'uncertainties',
] as const;

export interface VisionObservation {
  subject: string;
  environment: string;
  lighting: string;
  composition: string;
  shot: string;
  exclude: string;
  containsText: boolean;
  containsLogoOrBrand: boolean;
  containsPeople: boolean;
  uncertainties: string[];
}

export const VISION_LIMITS = { textField: 200, uncertainties: 5, uncertaintyLength: 120, reviewedText: 600 } as const;

export type ObservationParse = { ok: true; value: VisionObservation } | { ok: false; reason: string };

const TEXT_KEYS = ['subject', 'environment', 'lighting', 'composition', 'shot', 'exclude'] as const;
const BOOL_KEYS = ['containsText', 'containsLogoOrBrand', 'containsPeople'] as const;

/** Strict parse of the model's answer. Unknown keys, wrong types and empty subjects are refused. Raw text is not kept. */
export function parseVisionObservation(raw: string): ObservationParse {
  let obj: unknown;
  try {
    obj = JSON.parse(String(raw ?? '').trim());
  } catch {
    return { ok: false, reason: 'The answer was not one JSON object.' };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return { ok: false, reason: 'The answer was not one JSON object.' };
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!(VISION_OBSERVATION_KEYS as readonly string[]).includes(key)) return { ok: false, reason: `Unexpected field "${key}".` };
  }
  const out: Partial<VisionObservation> = {};
  for (const key of TEXT_KEYS) {
    const v = rec[key];
    if (typeof v !== 'string') return { ok: false, reason: `Field "${key}" must be text.` };
    const t = v.replace(/\s+/g, ' ').trim();
    if (t.length > VISION_LIMITS.textField) return { ok: false, reason: `Field "${key}" is longer than ${VISION_LIMITS.textField} characters.` };
    out[key] = t;
  }
  if (!out.subject) return { ok: false, reason: 'The subject is empty. Say what the picture shows.' };
  for (const key of BOOL_KEYS) {
    const v = rec[key];
    if (typeof v !== 'boolean') return { ok: false, reason: `Field "${key}" must be true or false.` };
    out[key] = v;
  }
  const u = rec.uncertainties;
  if (!Array.isArray(u) || u.length > VISION_LIMITS.uncertainties) return { ok: false, reason: `Field "uncertainties" must be a list of at most ${VISION_LIMITS.uncertainties} items.` };
  const items: string[] = [];
  for (const x of u) {
    if (typeof x !== 'string') return { ok: false, reason: 'Each uncertainty must be text.' };
    const t = x.replace(/\s+/g, ' ').trim();
    if (t.length > VISION_LIMITS.uncertaintyLength) return { ok: false, reason: `An uncertainty is longer than ${VISION_LIMITS.uncertaintyLength} characters.` };
    if (t) items.push(t);
  }
  out.uncertainties = items;
  return { ok: true, value: out as VisionObservation };
}

/** The labelled description a reviewer edits. Same labels as the still prompt, so it can be used without rewriting. */
export function observationVisualText(o: VisionObservation): string {
  return [
    ['Subject', o.subject],
    ['Environment', o.environment],
    ['Lighting', o.lighting],
    ['Composition', o.composition],
    ['Shot', o.shot],
    ['Exclude', o.exclude],
  ]
    .filter(([, v]) => v.length > 0)
    .map(([label, v]) => `${label}: ${v}`)
    .join('; ');
}

/** The instructions sent with one picture. They ask for the strict shape only. Explicitly no invented facts. */
export const VISION_SYSTEM_PROMPT = 'You describe one picture for a video maker. You output one JSON object only. No markdown, no commentary.';
export const VISION_USER_PROMPT = [
  'Describe only what is visible in this picture. Do not guess names, places, dates, quotations or brands.',
  'Return exactly these fields:',
  '{"subject": text, "environment": text, "lighting": text, "composition": text, "shot": text, "exclude": text,',
  ' "containsText": true or false (any lettering or writing is visible), "containsLogoOrBrand": true or false,',
  ' "containsPeople": true or false, "uncertainties": list of short text items (what you are not sure of)}.',
  'Keep each text field under 200 characters. Use empty text for a field you cannot see.',
].join('\n');

/**
 * Refusals for a reviewed description used as a still reference. Empty when it may be used.
 * Religious: lettering, a brand or a religious-brand term refuses it. The labelled text must be valid.
 */
export function reviewRefusals(text: string, profile: StillProfile | string | null | undefined, flags: Pick<VisionObservation, 'containsText' | 'containsLogoOrBrand'> | null): string[] {
  const out: string[] = [];
  if (text.length > VISION_LIMITS.reviewedText) out.push(`The reviewed description is longer than ${VISION_LIMITS.reviewedText} characters.`);
  // Labelled parts are required (an edited text that lost its labels is refused). Religious refusals come with them.
  out.push(...validateVisualDescription(text, profile));
  if (profile === 'religious') {
    out.push(...religiousRefusals(parseVisualDescription(text), profile));
    if (flags && (flags.containsText || flags.containsLogoOrBrand)) {
      out.push('This picture shows lettering or a brand. A religious still cannot use it as a reference. Reject this description, or choose another picture.');
    }
  }
  return [...new Set(out)];
}

/** One clause added to a still prompt from reviewed references. Only the subject, environment and lighting are used. */
export function referenceClauseOf(reviewedTexts: string[]): string {
  const bits = reviewedTexts
    .map((t) => parseVisualDescription(t))
    .map((p) => [p.subject, p.environment, p.lighting].map((x) => x.replace(/[;.,\s]+$/g, '').trim()).filter(Boolean).join(', '))
    .filter((x) => x.length > 0);
  if (bits.length === 0) return '';
  return `reference (reviewed): ${bits.join('; ')}`.slice(0, 200);
}

export interface VisualReviewRecord {
  /** The vision job that produced the observation. */
  jobId: string;
  /** SHA-256 of the picture bytes that were analysed. A changed picture no longer matches. */
  sha256: string;
  state: 'reviewed' | 'rejected';
  /** The reviewed labelled description (rejected: empty). */
  text: string;
  /** Use the reviewed description in still prompts for this picture. */
  useInPrompts: boolean;
  /** The picture flags the analysis reported. Kept so a religious refusal can be checked again from stored data. */
  flags: Pick<VisionObservation, 'containsText' | 'containsLogoOrBrand' | 'containsPeople'>;
}

export interface ConditioningSetting {
  assetId: string;
  /** Strength of the IP-Adapter injection. 0.1 to 1.0. */
  strength: number;
}

export const CONDITIONING_STRENGTH = { min: 0.1, max: 1.0, default: 0.7, step: 0.05 } as const;
