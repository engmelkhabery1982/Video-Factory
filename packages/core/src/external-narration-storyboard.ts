/**
 * Storyboard for narration that already exists outside the app.
 *
 * The entered script is the spoken reference. Scenes may split it, but they
 * must not add an introduction, a question, an answer, a call to action, a
 * character name, or a product line. Visual titles are a slice of the same
 * words. Estimated timing is not acoustic alignment.
 */
import { getBrandPreset } from './brand.js';
import { computeSimilarity } from './history.js';
import type {
  BackgroundVariantId,
  CaptionCue,
  ExplanationVariantId,
  HistoryEntry,
  ProjectInput,
  Scene,
  Storyboard,
  TextPositionId,
  TransitionVariantId,
  VisualHistory,
} from './types.js';

export const EXTERNAL_READY_NARRATION = 'external_ready' as const;
export const IN_APP_DIALOGUE_NARRATION = 'in_app_dialogue' as const;
export type NarrationSource = typeof EXTERNAL_READY_NARRATION | typeof IN_APP_DIALOGUE_NARRATION;

export function narrationSourceOf(input: { narrationSource?: unknown } | null | undefined): NarrationSource | null {
  if (input?.narrationSource === EXTERNAL_READY_NARRATION || input?.narrationSource === IN_APP_DIALOGUE_NARRATION) {
    return input.narrationSource;
  }
  return null;
}

export function usesExternalReadyNarration(input: { narrationSource?: unknown } | null | undefined): boolean {
  return narrationSourceOf(input) === EXTERNAL_READY_NARRATION;
}

/** Paragraphs in written order. Blank lines are the only safe split. */
export function spokenParagraphs(script: string): string[] {
  return script
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function normalizeSpokenScript(script: string): string {
  return spokenParagraphs(script).join('\n\n');
}

function spokenUnits(text: string): number {
  const base = text.normalize('NFD').replace(/\p{M}/gu, '');
  return base.match(/\p{L}|\p{N}/gu)?.length ?? 0;
}

function displayHeadline(text: string): string {
  const chars = Array.from(text);
  let end = Math.min(42, chars.length);
  while (end < chars.length && /\p{M}/u.test(chars[end] ?? '')) end += 1;
  const slice = chars.slice(0, end).join('').trim();
  return slice || text;
}

function allocateDurations(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const safeTotal = Number(total.toFixed(3));
  if (!(safeTotal > 0)) return weights.map(() => 1);
  const safe = weights.map((weight) => (weight > 0 ? weight : 1));
  const sum = safe.reduce((acc, weight) => acc + weight, 0);
  const out = safe.map((weight) => Number(((weight / sum) * safeTotal).toFixed(3)));
  const drift = Number((safeTotal - out.reduce((acc, value) => acc + value, 0)).toFixed(3));
  out[out.length - 1] = Number((out[out.length - 1] + drift).toFixed(3));
  if (out[out.length - 1] <= 0) {
    const each = Number((safeTotal / weights.length).toFixed(3));
    const even = weights.map(() => each);
    const evenDrift = Number((safeTotal - even.reduce((acc, value) => acc + value, 0)).toFixed(3));
    even[even.length - 1] = Number((even[even.length - 1] + evenDrift).toFixed(3));
    return even;
  }
  return out;
}

const BACKGROUNDS: BackgroundVariantId[] = ['full_typography', 'dark_grid', 'light_technical', 'blueprint'];
const TRANSITIONS: TransitionVariantId[] = ['direct_cut', 'push', 'data_wipe'];
const POSITIONS: TextPositionId[] = ['center', 'lower_third', 'left_column'];
const VARIANTS: ExplanationVariantId[] = ['key_statement', 'animated_checklist', 'process_flow'];

export function buildFaithfulExternalStoryboard(options: {
  input: ProjectInput;
  history: VisualHistory;
  audioDuration?: number | null;
}): Storyboard & { historyEntry: HistoryEntry } {
  const { input, history } = options;
  const brand = getBrandPreset(input.brandPreset);
  const paragraphs = spokenParagraphs(input.script);
  const warnings: string[] = [];
  const measured = typeof options.audioDuration === 'number' && options.audioDuration > 0 ? options.audioDuration : null;

  if (paragraphs.length === 0) {
    warnings.push('The spoken script is empty. No speech was invented.');
  }
  if (paragraphs.length === 1 && spokenUnits(paragraphs[0] ?? '') > 400) {
    warnings.push(
      'The script was kept as one scene because a safe split could not be found. Spoken words were not cut apart or rewritten.',
    );
  }
  if (paragraphs.length > 0 && !/\n\s*\n/.test(input.script.replace(/\r\n/g, '\n')) && input.script.includes('\n')) {
    warnings.push(
      'Blank lines are the safe scene boundaries. Single line breaks were not used as cuts, so the spoken order stays intact.',
    );
  }
  if ((input.shortCount ?? 0) > 0) {
    warnings.push(
      'Shorts were not generated. External narration does not invent a short script. Import a separate recording for each Short, or set the short count to 0.',
    );
  }
  if (measured === null) {
    warnings.push(
      'Scene timing is an estimate from the script length. It is not acoustic alignment. Import the recording and fit the scenes to its measured duration before export.',
    );
  } else {
    warnings.push(
      'Scene durations were fitted to the measured narration length so the timeline covers the audio. This is not acoustic alignment.',
    );
  }

  const weights = paragraphs.map((paragraph) => Math.max(1, spokenUnits(paragraph)));
  const estimated = Math.max(paragraphs.length * 1.5, weights.reduce((acc, weight) => acc + weight, 0) / 12);
  const total = measured ?? Number(estimated.toFixed(3));
  const durations = allocateDurations(total, weights);

  const scenes: Scene[] = [];
  const cues: CaptionCue[] = [];
  let cursor = 0;
  paragraphs.forEach((narration, index) => {
    const duration = durations[index] ?? 1;
    const startTime = Number(cursor.toFixed(3));
    const id = `lng_${String(index + 1).padStart(2, '0')}`;
    const cueId = `cap_${String(index + 1).padStart(2, '0')}`;
    const end = Number((startTime + duration).toFixed(3));
    scenes.push({
      id,
      index,
      role: 'body',
      section: `Spoken ${index + 1}`,
      variant: VARIANTS[index % VARIANTS.length],
      background: BACKGROUNDS[index % BACKGROUNDS.length],
      transitionIn: TRANSITIONS[index % TRANSITIONS.length],
      textPosition: POSITIONS[index % POSITIONS.length],
      accent: brand.colors.accent,
      duration,
      startTime,
      narration,
      captionIds: [cueId],
      content: {
        headline: displayHeadline(narration),
        items: [],
        stat: null,
        statLabel: null,
        stat2: null,
        statLabel2: null,
        takeaway: null,
        source: narration,
        emphasis: narration,
      },
      assetIds: [],
      reason: {
        detected: 'external narration paragraph',
        evidence: 'Spoken text is this paragraph of the entered script. No introduction, question, answer, call to action, or product line was added.',
        notUsedRecently: [],
        alternatives: [],
      },
      locked: false,
      userEdited: false,
    });
    cues.push({
      id: cueId,
      start: startTime,
      end,
      text: narration,
      sceneId: id,
      terms: [],
      userEdited: false,
    });
    cursor = end;
  });

  const longTotal = Number(cursor.toFixed(3));
  const historyEntry: HistoryEntry = {
    videoId: input.videoId,
    createdAt: new Date().toISOString(),
    topic: input.topic,
    hookVariant: 'scenario_story',
    sceneOrder: scenes.map((scene) => scene.variant),
    backgrounds: scenes.map((scene) => scene.background),
    transitions: scenes.map((scene) => scene.transitionIn),
    textPositions: scenes.map((scene) => scene.textPosition),
    accents: scenes.map((scene) => scene.accent),
    sceneDurations: scenes.map((scene) => scene.duration),
    ctaAnimation: 'slide_in',
    captionStyle: 'lower_band',
    shortHooks: [],
    shortOrders: [],
    assetIds: [],
    thumbConcepts: [],
  };

  return {
    videoId: input.videoId,
    createdAt: historyEntry.createdAt,
    brand,
    long: { scenes, totalDuration: longTotal, endScreenReserveSeconds: 0 },
    shorts: [],
    captions: cues,
    shortCaptions: {},
    segments: scenes.map((scene, index) => ({
      index,
      start: scene.startTime,
      end: Number((scene.startTime + scene.duration).toFixed(3)),
      text: scene.narration,
    })),
    warnings,
    similarity: computeSimilarity(historyEntry, input.videoId, history),
    historyEntry,
  };
}
