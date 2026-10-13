/**
 * Pure contract for the Gemini provider adapter (Milestone 3). No I/O, no fetch.
 * It holds: the REST request shapes, the JSON schema sent for structured output,
 * a strict validator for the returned plan, the prompt builder (which takes only
 * the explicit brief and supplied references), and a WAV validator for audio.
 *
 * Official references (checked 13 Oct 2026, generateContent API pages):
 *  - Structured outputs: generationConfig.responseMimeType + responseJsonSchema.
 *    NOTE: the same docs also show generationConfig.responseFormat in REST. The two
 *    shapes are not verified against the live API here. Live verification gate.
 *  - Speech: generationConfig.responseModalities ["AUDIO"], speechConfig.voiceConfig,
 *    parts[].text is the verbatim transcript, parts[].speech_metadata.style is the
 *    delivery direction. Unary output is a RIFF WAV, 24 kHz, mono, 16-bit PCM.
 */

export const GEMINI_DEFAULT_TEXT_MODEL = 'gemini-2.5-flash';
export const GEMINI_DEFAULT_TTS_MODEL = 'gemini-3.8-flash-tts';

/** Hard caps for one verification session. Config may lower them, never raise them. */
export const GEMINI_HARD_CAPS = {
  textRequests: 2,
  voicePreviews: 2,
  maxOutputTokens: 4096,
  maxPreviewSec: 20,
  maxPreviewChars: 350,
  maxStyleChars: 200,
  /** Production speech: hard ceiling on turns per session. Config may set a lower number, default 0 (off). */
  productionTurns: 200,
  /** Production speech: per-turn sanity ceiling. Longer clips are refused, never truncated. */
  maxProductionTurnSec: 60,
} as const;

export const PLAN_PROFILES = ['educational', 'religious', 'promotional'] as const;
export type PlanProfile = (typeof PLAN_PROFILES)[number];

/** Allowed treatment methods per profile. Each method changes the storytelling and the shot sequence. */
export const TREATMENT_METHODS: Record<PlanProfile, readonly string[]> = {
  educational: ['problem_worked_example_action', 'conversational_walkthrough', 'result_then_explanation'],
  religious: ['passage_then_reflection', 'reflection_then_passage', 'reflection_without_quotation'],
  promotional: ['problem_solution_offer', 'customer_story', 'feature_tour'],
};

export const AI_SHOT_TYPES = [
  'wide',
  'medium',
  'close_up',
  'screen_recording',
  'overlay_on_still',
  'split_comparison',
  'title_card',
] as const;
export type AiShotType = (typeof AI_SHOT_TYPES)[number];

export const AI_ASSET_NEEDS = ['existing_library', 'screen_recording_needed', 'image_needed', 'none'] as const;

/** JSON schema for structured output. Kept to the subset the docs list as supported. */
export const PLAN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    script: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique line id, for example L01.' },
              speaker: { type: 'string', description: 'Speaker label, for example narrator or instructor.' },
              language: { type: 'string', enum: ['ar', 'en'] },
              text: { type: 'string', description: 'The spoken words only. No stage directions.' },
              quotedSourceRef: { type: 'string', nullable: true, description: 'Supplied reference this line quotes, or null.' },
            },
            required: ['id', 'speaker', 'language', 'text', 'quotedSourceRef'],
          },
        },
      },
      required: ['lines'],
    },
    treatments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          method: { type: 'string' },
          rationale: { type: 'string' },
          scenes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                lineIds: { type: 'array', items: { type: 'string' } },
                shotType: { type: 'string', enum: [...AI_SHOT_TYPES] },
                visualRequirement: { type: 'string' },
                why: { type: 'string', description: 'Why this shot serves the line.' },
                assetNeed: { type: 'string', enum: [...AI_ASSET_NEEDS] },
              },
              required: ['id', 'lineIds', 'shotType', 'visualRequirement', 'why', 'assetNeed'],
            },
          },
        },
        required: ['id', 'title', 'method', 'rationale', 'scenes'],
      },
    },
    sourceNotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          status: { type: 'string', enum: ['needs_verification', 'supplied_source'] },
          sourceRef: { type: 'string', nullable: true },
        },
        required: ['claim', 'status', 'sourceRef'],
      },
    },
    productMention: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        factId: { type: 'string', nullable: true },
        text: { type: 'string', nullable: true },
      },
      required: ['enabled', 'factId', 'text'],
    },
  },
  required: ['script', 'treatments', 'sourceNotes', 'productMention'],
} as const;

export interface PlanLine {
  id: string;
  speaker: string;
  language: 'ar' | 'en';
  text: string;
  quotedSourceRef: string | null;
}
export interface PlanScene {
  id: string;
  lineIds: string[];
  shotType: AiShotType;
  visualRequirement: string;
  why: string;
  assetNeed: (typeof AI_ASSET_NEEDS)[number];
}
export interface PlanTreatment {
  id: string;
  title: string;
  method: string;
  rationale: string;
  scenes: PlanScene[];
}
export interface PlanSourceNote {
  claim: string;
  status: 'needs_verification' | 'supplied_source';
  sourceRef: string | null;
}
export interface PlanProductMention {
  enabled: boolean;
  factId: string | null;
  text: string | null;
}
export interface GeneratedPlan {
  schemaVersion: 1;
  profile: PlanProfile;
  script: { lines: PlanLine[] };
  treatments: PlanTreatment[];
  sourceNotes: PlanSourceNote[];
  productMention: PlanProductMention;
}

export interface PlanValidationContext {
  profile: PlanProfile;
  /** Reference ids the owner supplied. Only these may be cited. */
  suppliedReferenceIds: readonly string[];
  /** Owner-supplied product facts. Only these may be mentioned. */
  productFactIds: readonly string[];
  /** The owner explicitly asked for a contextual product mention. Default false. */
  productMentionRequested: boolean;
}

export interface PlanValidationResult {
  ok: boolean;
  errors: string[];
  plan: GeneratedPlan | null;
}

const QUOTE_RE = /["“”«»]/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Strict validation of model output. Returns every error found, not just the first.
 * Never repairs data silently: the caller decides whether one repair request is allowed.
 */
export function validateGeneratedPlan(raw: unknown, ctx: PlanValidationContext): PlanValidationResult {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['The response is not a JSON object.'], plan: null };
  const profile = ctx.profile;

  // Script
  const script = isObj(raw.script) ? raw.script : null;
  const lines = script && Array.isArray(script.lines) ? script.lines : null;
  if (!lines) errors.push('script.lines is missing.');
  const lineIds = new Set<string>();
  const cleanLines: PlanLine[] = [];
  if (lines) {
    if (lines.length < 2 || lines.length > 40) errors.push('script.lines must have 2 to 40 lines.');
    lines.forEach((l, i) => {
      if (!isObj(l)) { errors.push(`line ${i} is not an object.`); return; }
      const id = typeof l.id === 'string' ? l.id.trim() : '';
      const text = typeof l.text === 'string' ? l.text.trim() : '';
      const speaker = typeof l.speaker === 'string' ? l.speaker.trim() : '';
      const language = l.language;
      const quoted = typeof l.quotedSourceRef === 'string' ? l.quotedSourceRef : null;
      if (!id) errors.push(`line ${i} has no id.`);
      if (id && lineIds.has(id)) errors.push(`line id "${id}" is duplicated.`);
      if (!text) errors.push(`line ${id || i} has empty narration.`);
      if (text.length > 400) errors.push(`line ${id || i} is longer than 400 characters.`);
      if (!speaker || speaker.length > 40) errors.push(`line ${id || i} needs a speaker label of 1 to 40 characters.`);
      if (language !== 'ar' && language !== 'en') errors.push(`line ${id || i} language must be "ar" or "en".`);
      if (profile === 'religious' && text && QUOTE_RE.test(text) && !(quoted && ctx.suppliedReferenceIds.includes(quoted))) {
        errors.push(`line ${id || i} quotes text without a supplied reference. Remove the quotation or cite a supplied reference.`);
      }
      if (quoted !== null && !ctx.suppliedReferenceIds.includes(quoted)) {
        errors.push(`line ${id || i} cites "${quoted}", which was not supplied.`);
      }
      if (id) lineIds.add(id);
      cleanLines.push({ id, speaker, language: language === 'ar' ? 'ar' : 'en', text, quotedSourceRef: quoted });
    });
  }

  // Treatments
  const treatments = Array.isArray(raw.treatments) ? raw.treatments : null;
  const cleanTreatments: PlanTreatment[] = [];
  if (!treatments) errors.push('treatments is missing.');
  const allowed = TREATMENT_METHODS[profile];
  if (treatments) {
    if (treatments.length !== 3) errors.push('treatments must contain exactly 3 entries.');
    const methods = new Set<string>();
    const shotSequences = new Set<string>();
    treatments.forEach((t, ti) => {
      if (!isObj(t)) { errors.push(`treatment ${ti} is not an object.`); return; }
      const method = typeof t.method === 'string' ? t.method : '';
      const title = typeof t.title === 'string' ? t.title.trim() : '';
      const rationale = typeof t.rationale === 'string' ? t.rationale.trim() : '';
      if (!allowed.includes(method)) errors.push(`treatment ${ti} method "${method}" is not allowed for ${profile}.`);
      if (methods.has(method)) errors.push(`treatment method "${method}" is repeated.`);
      methods.add(method);
      if (!title) errors.push(`treatment ${ti} has no title.`);
      if (!rationale) errors.push(`treatment ${ti} has no rationale.`);
      const scenes = Array.isArray(t.scenes) ? t.scenes : [];
      if (scenes.length < 2 || scenes.length > 8) errors.push(`treatment ${ti} must have 2 to 8 scenes.`);
      const covered: string[] = [];
      const cleanScenes: PlanScene[] = [];
      scenes.forEach((s, si) => {
        if (!isObj(s)) { errors.push(`treatment ${ti} scene ${si} is not an object.`); return; }
        const ids = Array.isArray(s.lineIds) ? s.lineIds.filter((x): x is string => typeof x === 'string') : [];
        if (ids.length === 0) errors.push(`treatment ${ti} scene ${si} covers no line.`);
        for (const id of ids) {
          if (!lineIds.has(id)) errors.push(`treatment ${ti} scene ${si} refers to unknown line "${id}".`);
          covered.push(id);
        }
        const shotType = s.shotType as AiShotType;
        if (!(AI_SHOT_TYPES as readonly string[]).includes(shotType)) errors.push(`treatment ${ti} scene ${si} has an unknown shotType.`);
        if (profile === 'religious' && shotType === 'screen_recording') {
          errors.push(`treatment ${ti} scene ${si}: religious content does not use screen recordings.`);
        }
        const assetNeed = s.assetNeed as PlanScene['assetNeed'];
        if (!(AI_ASSET_NEEDS as readonly string[]).includes(assetNeed)) errors.push(`treatment ${ti} scene ${si} has an unknown assetNeed.`);
        const visualRequirement = typeof s.visualRequirement === 'string' ? s.visualRequirement.trim() : '';
        const why = typeof s.why === 'string' ? s.why.trim() : '';
        if (!visualRequirement) errors.push(`treatment ${ti} scene ${si} has no visualRequirement.`);
        if (!why) errors.push(`treatment ${ti} scene ${si} has no "why".`);
        cleanScenes.push({
          id: typeof s.id === 'string' ? s.id : `T${ti}S${si}`,
          lineIds: ids,
          shotType,
          visualRequirement,
          why,
          assetNeed,
        });
      });
      // Every treatment must use every line once: the owner's script is complete in each.
      const sorted = [...covered].sort();
      const expected = [...lineIds].sort();
      if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
        errors.push(`treatment ${ti} must use every script line exactly once.`);
      }
      shotSequences.add(cleanScenes.map((s) => s.shotType).join('>'));
      cleanTreatments.push({ id: typeof t.id === 'string' ? t.id : `T${ti}`, title, method, rationale, scenes: cleanScenes });
    });
    if (shotSequences.size !== treatments.length) {
      errors.push('treatments must use different shot sequences, not only different titles.');
    }
  }

  // Source notes: only supplied references may be cited as sources.
  const notes = Array.isArray(raw.sourceNotes) ? raw.sourceNotes : [];
  const cleanNotes: PlanSourceNote[] = [];
  notes.forEach((n, i) => {
    if (!isObj(n)) { errors.push(`sourceNotes ${i} is not an object.`); return; }
    const claim = typeof n.claim === 'string' ? n.claim.trim() : '';
    const status = n.status;
    const sourceRef = typeof n.sourceRef === 'string' ? n.sourceRef : null;
    if (!claim) errors.push(`sourceNotes ${i} has no claim.`);
    if (status !== 'needs_verification' && status !== 'supplied_source') errors.push(`sourceNotes ${i} has an unknown status.`);
    if (status === 'supplied_source' && (!sourceRef || !ctx.suppliedReferenceIds.includes(sourceRef))) {
      errors.push(`sourceNotes ${i} cites a source that was not supplied.`);
    }
    if (status === 'needs_verification' && sourceRef !== null) errors.push(`sourceNotes ${i} needs verification and must not name a source.`);
    cleanNotes.push({ claim, status: status === 'supplied_source' ? 'supplied_source' : 'needs_verification', sourceRef });
  });

  // Product mention: default off. Religious content never mentions a product.
  const pm = isObj(raw.productMention) ? raw.productMention : null;
  const enabled = pm?.enabled === true;
  const factId = pm && typeof pm.factId === 'string' ? pm.factId : null;
  const text = pm && typeof pm.text === 'string' ? pm.text.trim() : null;
  if (!pm) errors.push('productMention is missing.');
  if (profile === 'religious' && enabled) errors.push('religious content cannot include a product mention.');
  if (enabled && !ctx.productMentionRequested) errors.push('a product mention was not requested.');
  if (enabled && (!factId || !ctx.productFactIds.includes(factId))) errors.push('the product mention must cite an owner-supplied product fact.');
  if (enabled && !text) errors.push('the product mention has no text.');

  if (errors.length > 0) return { ok: false, errors, plan: null };
  return {
    ok: true,
    errors: [],
    plan: {
      schemaVersion: 1,
      profile,
      script: { lines: cleanLines },
      treatments: cleanTreatments,
      sourceNotes: cleanNotes,
      productMention: { enabled, factId: enabled ? factId : null, text: enabled ? text : null },
    },
  };
}

export interface PlanPromptInput {
  profile: PlanProfile;
  format: 'landscape' | 'portrait';
  brief: string;
  /** Owner-supplied reference passages, each with an id. Only these may be cited. */
  references: Array<{ id: string; text: string }>;
  /** Owner-supplied product facts. Included only when a mention was requested. */
  productFacts: Array<{ id: string; text: string }>;
  productMentionRequested: boolean;
  /** Validator errors from a previous attempt, for one bounded repair. */
  repairErrors?: string[];
}

/**
 * The only text sent to the planning model. Project folders, recordings, the library
 * and approved timings are never included.
 */
export function buildPlanPrompt(input: PlanPromptInput): string {
  const parts: string[] = [];
  parts.push(
    'You plan a short educational or religious or promotional video as structured JSON.',
    `Profile: ${input.profile}. Format: ${input.format}.`,
    `Treatment methods allowed for this profile: ${TREATMENT_METHODS[input.profile].join(', ')}. Use exactly three distinct methods, one per treatment.`,
    'Write a complete script of short spoken lines. The speech is verbatim: no stage directions inside text.',
    'Every treatment must use every script line exactly once, and its scenes must differ in shot sequence from the other treatments.',
    'Mark any factual claim that needs checking as needs_verification with sourceRef null. Never invent a source, a quotation or a scripture reference.',
    'Cite a source only from the supplied references list below.',
    input.profile === 'religious'
      ? 'Religious content: restrained imagery and pacing. Do not invent scripture or quotations. Quote only supplied passages and set quotedSourceRef. No product mention.'
      : 'Do not include a product mention unless it is explicitly requested below.',
    input.productMentionRequested
      ? 'A short contextual product mention is requested. Use only the supplied product facts, cite the fact id, and keep it to one line.'
      : 'A product mention is NOT requested: set productMention.enabled to false.',
    '',
    `Brief: ${input.brief}`,
    '',
    'Supplied references (id: text):',
    ...(input.references.length ? input.references.map((r) => `${r.id}: ${r.text}`) : ['(none supplied)']),
  );
  if (input.productMentionRequested) {
    parts.push('', 'Supplied product facts (id: text):', ...input.productFacts.map((f) => `${f.id}: ${f.text}`));
  }
  if (input.repairErrors && input.repairErrors.length > 0) {
    parts.push('', 'Your previous answer failed validation. Correct these problems and return the full JSON again:', ...input.repairErrors.map((e) => `- ${e}`));
  }
  return parts.join('\n');
}

/**
 * Request body for structured text output (generateContent, REST).
 * Field names follow the primary API reference: GenerationConfig.responseFormat.text
 * (TextResponseFormat: mimeType enum APPLICATION_JSON, schema). responseMimeType and
 * responseJsonSchema are deprecated there and are not sent.
 */
export function buildTextRequestBody(prompt: string, maxOutputTokens: number = GEMINI_HARD_CAPS.maxOutputTokens) {
  const cap = Math.min(Math.max(1, Math.floor(maxOutputTokens)), GEMINI_HARD_CAPS.maxOutputTokens);
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: PLAN_RESPONSE_SCHEMA } },
      maxOutputTokens: cap,
    },
  };
}

/** Output format requested for every speech turn. WAV is named explicitly; compressed or raw PCM is never requested. */
export const GEMINI_SPEECH_OUTPUT = { mimeType: 'AUDIO_WAV', delivery: 'INLINE', sampleRate: 24000 } as const;

/**
 * Speech language codes accepted by SpeechConfig.languageCode (primary reference list).
 * Arabic is ar-XA in that list. Other languages are refused, not guessed.
 */
export const GEMINI_SPEECH_LANGUAGE_CODE: Record<string, string> = { en: 'en-US', ar: 'ar-XA' };

/**
 * Request body for one speech turn: one unary call, one speaker, one prebuilt voice.
 * The text is verbatim; the style travels only in the part's speechMetadata. Delivery
 * style is never concatenated into the narration text.
 */
export function buildSpeechRequestBody(opts: { text: string; style: string; voiceName: string; language?: string }) {
  const text = opts.text;
  const style = opts.style.trim();
  if (!text.trim()) throw new Error('speech text is empty');
  if (text.length > GEMINI_HARD_CAPS.maxPreviewChars) throw new Error('speech text exceeds the preview limit');
  if (style.length > GEMINI_HARD_CAPS.maxStyleChars) throw new Error('style exceeds the limit');
  if (/[<>]/.test(text)) {
    // Inline tags would blur verbatim text and delivery direction. Keep text clean.
    throw new Error('angle-bracket tags are not allowed in speech text; use speech style instead');
  }
  const languageCode = opts.language ? GEMINI_SPEECH_LANGUAGE_CODE[opts.language] : undefined;
  if (opts.language && !languageCode) throw new Error(`speech language \"${opts.language}\" has no verified language code`);
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text, speechMetadata: style ? { style } : {} }],
      },
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voiceName } },
        ...(languageCode ? { languageCode } : {}),
      },
      responseFormat: { audio: { ...GEMINI_SPEECH_OUTPUT } },
    },
  };
}

export interface WavInfo {
  valid: boolean;
  reason: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitsPerSample: number | null;
  durationSec: number | null;
  dataBytes: number;
}

/** Reads a RIFF/WAVE PCM header and checks the audio is real, non-empty and in a supported format. */
export function parseWav(bytes: Uint8Array): WavInfo {
  const fail = (reason: string): WavInfo => ({ valid: false, reason, sampleRate: null, channels: null, bitsPerSample: null, durationSec: null, dataBytes: 0 });
  if (bytes.byteLength < 44) return fail('The audio is shorter than a WAV header.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return fail('The audio is not a RIFF/WAVE file.');
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataBytes = -1;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= bytes.byteLength) {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      // A declared data size larger than the bytes present means the clip was cut short. Never accept it.
      if (size > bytes.byteLength - body) return fail('The WAV data chunk is truncated.');
      dataBytes = size;
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt) return fail('The WAV file has no fmt chunk.');
  if (dataBytes <= 0) return fail('The WAV file has no audio data.');
  if (fmt.format !== 1) return fail('The WAV file is not PCM.');
  if (fmt.bits !== 16) return fail('The WAV file is not 16-bit.');
  if (fmt.channels < 1 || fmt.channels > 2) return fail('The WAV file has an unsupported channel count.');
  if (fmt.sampleRate < 8000 || fmt.sampleRate > 48000) return fail('The WAV file has an unsupported sample rate.');
  const frameBytes = fmt.channels * 2;
  const durationSec = Math.round((dataBytes / frameBytes / fmt.sampleRate) * 1000) / 1000;
  return {
    valid: true,
    reason: null,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bits,
    durationSec,
    dataBytes,
  };
}

/** The 30 prebuilt studio voices listed in the TTS docs. Only these may be requested. */
export const GEMINI_PREBUILT_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
] as const;

/**
 * Evidence states, kept separate per language. A language is `fixture_only` until a
 * live generation for that language has been recorded and reviewed.
 */
export const SPEECH_EVIDENCE_STATES = ['fixture_only', 'live_unverified', 'live_verified_unreviewed', 'listened_reviewed'] as const;
export type SpeechEvidenceState = (typeof SPEECH_EVIDENCE_STATES)[number];
