/**
 * Still-image prompt composition for the local runner (stable-diffusion.cpp, SD 1.x).
 *
 * The planner writes each image shot's visual description as labelled parts:
 *
 *   Subject: <what is in the frame, concrete nouns, count, position>;
 *   Environment: <place, materials, time of day>;
 *   Lighting: <light source, quality, colour>;
 *   Composition: <what sits where, how much empty space>;
 *   Shot: <wide | medium | close-up | overhead | ...>;
 *   Exclude: <things that must not appear in THIS image, or none>
 *
 * This module turns those parts into the positive prompt and the per-shot negative prompt.
 * It is deterministic and has no model in it. It never bans people globally: people are excluded
 * only when the shot's own Exclude part names them. Religious content gets its own safeguards and
 * never a brand or identity. Text, lettering and quotations are excluded for religious shots.
 *
 * Limits, stated plainly: the composer cannot make a vague description concrete. Concreteness comes
 * from the planner, which is held to the labelled form by validateVisualDescription (one repair in
 * the normal planning flow). A supplied free-text description is used as the subject and flagged.
 */

export const VISUAL_LABELS = ['Subject', 'Environment', 'Lighting', 'Composition', 'Shot', 'Exclude'] as const;
export type VisualLabel = (typeof VISUAL_LABELS)[number];
/** Labels a planner description must carry. Exclude is optional and may be "none". */
export const REQUIRED_VISUAL_LABELS: readonly VisualLabel[] = ['Subject', 'Environment', 'Lighting', 'Composition', 'Shot'];

export type StillProfile = 'educational' | 'religious' | 'promotional';

export interface VisualParts {
  subject: string;
  environment: string;
  lighting: string;
  composition: string;
  shot: string;
  exclude: string;
  /** False when the text has none of the labels. The whole text is then the subject. */
  structured: boolean;
}

const LABEL_RE = /(?:^|;|\n)\s*(Subject|Environment|Lighting|Composition|Shot|Exclude)\s*:\s*/gi;

function cleanPart(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/[;.,\s]+$/g, '').trim();
}

/** Splits a labelled description into its parts. Unknown text before the first label is kept with the subject. */
export function parseVisualDescription(text: string): VisualParts {
  const source = String(text ?? '');
  const matches = [...source.matchAll(LABEL_RE)];
  const out: Record<string, string> = {};
  if (matches.length === 0) {
    return { subject: cleanPart(source), environment: '', lighting: '', composition: '', shot: '', exclude: '', structured: false };
  }
  const leading = cleanPart(source.slice(0, matches[0].index ?? 0));
  matches.forEach((m, i) => {
    const label = m[1].toLowerCase();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? source.length) : source.length;
    const value = cleanPart(source.slice(start, end));
    out[label] = out[label] ? `${out[label]}, ${value}` : value;
  });
  const subject = [leading, out.subject ?? ''].filter(Boolean).join(', ');
  return {
    subject,
    environment: out.environment ?? '',
    lighting: out.lighting ?? '',
    composition: out.composition ?? '',
    shot: out.shot ?? '',
    exclude: out.exclude ?? '',
    structured: true,
  };
}

/**
 * Religious refusal. A religious still carries no brand, identity, lettering or scripture in the picture.
 * This checks the RENDERED parts (subject, environment, lighting, composition, shot). It does not check the
 * Exclude part, because listing a thing to keep out of the picture is allowed. A term is not a request when
 * it is negated in its own clause (no, not, without, avoid, free of, or "-free"). People, plain books and
 * religious context are not refused. A negative prompt is not a refusal: this rule rejects the request itself.
 */
export type RefusalKind = 'branding' | 'lettering' | 'scripture';

const REFUSAL_TERMS: ReadonlyArray<{ kind: RefusalKind; source: string }> = [
  {
    kind: 'branding',
    source: String.raw`buildtrack|build\s+track|logos?|brands?|branding|branded|trademarks?|watermarks?|company\s+names?|identity\s+marks?|emblems?|corporate\s+identity`,
  },
  {
    kind: 'lettering',
    source: String.raw`lettering|letters?|words?|texts?|typography|typeset|calligraph\w*|inscriptions?|inscribed|writing|written|script|arabic\s+script|arabic\s+text|signage|sign\s+(?:reading|saying)|captions?\s+(?:on|with|in|reading)|quote\s+(?:card|text|overlay)|quotations?|quoted`,
  },
  {
    kind: 'scripture',
    source: String.raw`scriptures?|qur['\u2019]?an|koran|bible|verses?|ayahs?|ayat|surahs?|hadiths?|psalms?|gospels?|sacred\s+texts?`,
  },
];

const NEGATED_BEFORE = /\b(?:no|not|without|never|free\s+of|avoid|avoiding|avoids|nothing|absent|none|exclude|excluding|omit|omitting|unlettered|unbranded)\b/i;

const KIND_REASON: Record<RefusalKind, string> = {
  branding: 'a brand or identity',
  lettering: 'lettering or text',
  scripture: 'scripture or a named scripture',
};

function isNegated(text: string, index: number, length: number): boolean {
  const before = text.slice(0, index);
  const clauseStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf(','), before.lastIndexOf('.')) + 1;
  if (NEGATED_BEFORE.test(before.slice(clauseStart))) return true;
  return /^-free\b/i.test(text.slice(index + length));
}

/** One refusal message per (part, term). Empty when the religious rendering request is acceptable. */
export function religiousRefusals(parts: VisualParts, profile: string | null | undefined): string[] {
  if (profile !== 'religious') return [];
  const rendered: Array<[string, string]> = [
    ['Subject', parts.subject],
    ['Environment', parts.environment],
    ['Lighting', parts.lighting],
    ['Composition', parts.composition],
    ['Shot', parts.shot],
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [part, text] of rendered) {
    if (!text) continue;
    for (const { kind, source } of REFUSAL_TERMS) {
      const re = new RegExp(`\\b(?:${source})\\b`, 'gi');
      for (const m of text.matchAll(re)) {
        const term = m[0];
        if (isNegated(text, m.index ?? 0, term.length)) continue;
        const key = `${part}|${kind}|${term.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          `${part}: "${term}" asks for ${KIND_REASON[kind]} in a religious still. A religious image carries no brand, identity, lettering or scripture. Describe the object or scene instead (for example, a plain closed book). To keep something out of the picture, list it under Exclude.`,
        );
      }
    }
  }
  return out;
}

/**
 * Validation for planner output. Returns one message per problem; empty when the description is usable.
 * Each part needs a phrase of at least two words (Shot needs a name). So "Lighting: good" is refused.
 */
export function validateVisualDescription(text: string, profile?: string | null): string[] {
  const parts = parseVisualDescription(text);
  const refusals = religiousRefusals(parts, profile);
  if (!parts.structured) {
    return [`visualRequirement must use labelled parts: ${REQUIRED_VISUAL_LABELS.map((l) => `${l}:`).join(' ')} (Exclude: optional).`, ...refusals];
  }
  const errors: string[] = [];
  const byLabel: Record<VisualLabel, string> = {
    Subject: parts.subject,
    Environment: parts.environment,
    Lighting: parts.lighting,
    Composition: parts.composition,
    Shot: parts.shot,
    Exclude: parts.exclude,
  };
  for (const label of REQUIRED_VISUAL_LABELS) {
    const words = byLabel[label].split(/\s+/).filter(Boolean).length;
    // A shot is named in one word (wide, medium, close-up). Every other part needs a phrase.
    const minimum = label === 'Shot' ? 1 : 2;
    if (words < minimum) errors.push(`visualRequirement is missing a concrete ${label} part (${minimum === 1 ? 'a shot name' : 'at least two words'}).`);
  }
  return [...errors, ...refusals];
}

/** Framing words used only when the description has no Shot part. */
const FRAMING_FOR_SHOT_TYPE: Record<string, string> = {
  wide: 'wide shot',
  medium: 'medium shot',
  close_up: 'close-up',
  overlay_on_still: 'wide shot',
  split_comparison: 'two clear halves side by side',
  title_card: 'centred, plain background',
};

const STYLE_BY_PROFILE: Record<StillProfile, string> = {
  religious: 'quiet, reverent, realistic photograph, soft warm light, uncluttered',
  educational: 'clean editorial illustration, flat colours, clear simple shapes',
  promotional: 'clean commercial photograph, sharp focus',
};

/** Base negatives for every still. Text and branding only. People are never in this list. */
const BASE_NEGATIVE = ['text', 'letters', 'words', 'numbers', 'caption', 'watermark', 'logo', 'signature', 'blurry', 'low quality', 'deformed', 'duplicate objects'];
/** Added for religious shots: no lettering, scripture or brands in the picture at all. */
const RELIGIOUS_NEGATIVE = ['scripture', 'quotation', 'calligraphy', 'Arabic script', 'brand name'];

/** SD 1.x text encoders keep about 77 tokens. Longer prompts lose their end, where the style sits. */
export const STILL_PROMPT_WORD_WARNING = 60;

export interface ComposedStillPrompt {
  prompt: string;
  negativePrompt: string;
  /** Words in the positive prompt. */
  wordCount: number;
  /** Human-readable reasons to look again before generating. Empty when the prompt is usable as written. */
  warnings: string[];
  /** Requests the rendered religious image must not carry (branding, lettering, scripture). Empty when acceptable. A composed prompt with refusals must not be generated. */
  refusals: string[];
  /** The parts used, for review. */
  parts: VisualParts;
}

export interface ComposeStillInput {
  /** The shot's visual description (the editable visual intent, or the planner's visualRequirement). */
  visual: string;
  profile: StillProfile;
  shotType?: string | null;
  aspect: 'landscape' | 'portrait';
}

function splitExclusions(exclude: string): string[] {
  const t = exclude.trim();
  if (!t || /^(none|no)\.?$/i.test(t)) return [];
  return t
    .split(/[,]/)
    .map((x) => x.replace(/^\s*(no|not|without)\s+/i, '').trim())
    .filter((x) => x.length > 0 && x.length <= 60)
    .slice(0, 12);
}

export function composeStillPrompt(input: ComposeStillInput): ComposedStillPrompt {
  const parts = parseVisualDescription(input.visual);
  const warnings: string[] = [];
  const framing = parts.shot || FRAMING_FOR_SHOT_TYPE[input.shotType ?? ''] || '';
  if (!parts.structured) warnings.push('The description has no labelled parts. The image may be weak. Correct it with Subject, Environment, Lighting, Composition, Shot.');
  if (!parts.subject) warnings.push('No subject is named. Name the objects or the place to show.');

  // Order matters: the composition words come first, so a truncated tail loses only the style.
  const positive = [
    parts.subject,
    parts.environment,
    parts.lighting,
    parts.composition,
    framing,
    input.aspect === 'portrait' ? '9:16 frame' : '16:9 frame',
    STYLE_BY_PROFILE[input.profile],
  ]
    .map((x) => x.replace(/[;.,\s]+$/g, '').trim())
    .filter((x) => x.length > 0)
    .join(', ');

  const wordCount = positive.split(/\s+/).filter(Boolean).length;
  if (wordCount > STILL_PROMPT_WORD_WARNING) {
    warnings.push(`The prompt is ${wordCount} words. SD 1.x keeps about 77 tokens, so the end of a long prompt may be cut. Shorten the subject or environment.`);
  }

  const exclusions = splitExclusions(parts.exclude);
  const negatives = [
    ...BASE_NEGATIVE,
    ...(input.profile === 'religious' ? RELIGIOUS_NEGATIVE : []),
    ...exclusions,
  ];
  const negativePrompt = [...new Set(negatives.map((x) => x.toLowerCase()))].join(', ');

  const refusals = religiousRefusals(parts, input.profile);
  return { prompt: positive, negativePrompt, wordCount, warnings, refusals, parts };
}
