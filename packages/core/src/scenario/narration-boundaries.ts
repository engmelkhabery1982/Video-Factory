/**
 * Pause-aware sentence boundaries for imported narration.
 *
 * This is not a speech model and not acoustic verification. Measured pauses
 * come from the existing ffmpeg silence detector. Sentence time inside those
 * pauses is script length only. Displayed text is never rewritten.
 */

export const NARRATION_SILENCE_NOISE_DB = -32;
export const NARRATION_SILENCE_MIN_SEC = 0.22;
export const MIN_READABLE_CAPTION_SEC = 0.45;
const TIE_SEC = 0.02;
const ROUND = 1000;

export type NarrationEstimateMethod = 'speech_intervals' | 'script_proportion' | 'unavailable';

export interface NarrationSilenceInterval {
  start: number;
  end: number;
}

export interface NarrationBoundaryUnit {
  sceneId: string;
  cueId: string | null;
  text: string;
  userEdited: boolean;
}

export interface NarrationBoundaryInput {
  audioDurationSec: number;
  silences: readonly NarrationSilenceInterval[];
  detectionFailed: boolean;
  detectionMessage?: string;
  units: readonly NarrationBoundaryUnit[];
}

export interface NarrationBoundaryRow {
  sceneId: string;
  cueId: string | null;
  text: string;
  userEdited: boolean;
  proposedStart: number;
  proposedDurationSec: number;
  proposedCaptionStart: number;
  proposedCaptionEnd: number;
  warnings: string[];
}

export interface NarrationBoundaryProposal {
  available: boolean;
  method: NarrationEstimateMethod;
  sourceLabel: string;
  detail: string;
  acousticVerification: false;
  verified: false;
  silenceCount: number;
  rows: NarrationBoundaryRow[];
  warnings: string[];
}

export interface EditableBoundaryScene {
  sceneId: string;
  startTime: number;
  durationSec: number;
}

export interface EditableBoundaryCue {
  cueId: string;
  sceneId: string | null;
  start: number;
  end: number;
}

export interface BoundaryEditResult {
  applied: boolean;
  scenes: EditableBoundaryScene[];
  captions: EditableBoundaryCue[];
  warnings: string[];
}

export interface ProposalApplication {
  ok: boolean;
  message: string;
  scenes: Array<{ sceneId: string; startTime: number; durationSec: number; narration: string; role?: string }>;
  captions: Array<{ cueId: string; sceneId: string | null; start: number; end: number; text: string }>;
  warnings: string[];
}

function round3(value: number): number {
  return Math.round(value * ROUND) / ROUND;
}

function tied(left: number, right: number): boolean {
  return Math.abs(left - right) <= TIE_SEC;
}

/** Letters and numbers only. Diacritics and tatweel do not change the weight or the displayed text. */
export function narrationWeight(text: string): number {
  const stripped = text.normalize('NFD').replace(/\p{M}/gu, '').replace(/\u0640/g, '');
  return stripped.match(/\p{L}|\p{N}/gu)?.length ?? 0;
}

export function sentenceTerminatorCount(text: string): number {
  return text.match(/[.!?؟۔](?=\s|$)/g)?.length ?? 0;
}

export function parseSilenceDetectLog(stderr: string, duration: number): NarrationSilenceInterval[] {
  if (!(duration > 0)) return [];
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const silences: NarrationSilenceInterval[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = Math.max(0, starts[i] ?? 0);
    const end = Math.min(duration, ends[i] ?? duration);
    if (end - start > 0.001) silences.push({ start: round3(start), end: round3(end) });
  }
  return silences;
}

export function speechIntervalsFromSilence(
  duration: number,
  silences: readonly NarrationSilenceInterval[],
): NarrationSilenceInterval[] {
  if (!(duration > 0)) return [];
  const merged: NarrationSilenceInterval[] = [];
  const ordered = silences
    .map((item) => ({ start: Math.max(0, item.start), end: Math.min(duration, item.end) }))
    .filter((item) => item.end - item.start > 0.001)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const item of ordered) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end + 0.001) last.end = Math.max(last.end, item.end);
    else merged.push({ ...item });
  }
  const speech: NarrationSilenceInterval[] = [];
  let cursor = 0;
  for (const item of merged) {
    if (item.start > cursor + 0.001) speech.push({ start: round3(cursor), end: round3(item.start) });
    cursor = Math.max(cursor, item.end);
  }
  if (duration > cursor + 0.001) speech.push({ start: round3(cursor), end: round3(duration) });
  return speech.filter((item) => item.end - item.start > 0.001);
}

interface SpeechSpan {
  speechStart: number;
  speechEnd: number;
}

function walkBudgets(chunks: readonly NarrationSilenceInterval[], weights: readonly number[]): SpeechSpan[] {
  const safe = weights.map((weight) => (weight > 0 ? weight : 1));
  const speechTotal = chunks.reduce((sum, chunk) => sum + (chunk.end - chunk.start), 0);
  const weightTotal = safe.reduce((sum, weight) => sum + weight, 0);
  const budgets = safe.map((weight) => (weight / weightTotal) * speechTotal);
  const drift = speechTotal - budgets.reduce((sum, value) => sum + value, 0);
  budgets[budgets.length - 1] += drift;

  let chunkIndex = 0;
  let position = chunks[0]?.start ?? 0;
  return budgets.map((budget) => {
    const start = position;
    let remaining = budget;
    while (remaining > 0.0005 && chunkIndex < chunks.length) {
      const chunk = chunks[chunkIndex];
      const available = chunk.end - position;
      if (available <= 0.0005) {
        chunkIndex += 1;
        position = chunks[chunkIndex]?.start ?? position;
        continue;
      }
      const take = Math.min(available, remaining);
      position += take;
      remaining -= take;
      if (position >= chunk.end - 0.0005) {
        chunkIndex += 1;
        position = chunks[chunkIndex]?.start ?? position;
      }
    }
    return { speechStart: start, speechEnd: position };
  });
}

function mergeShortestGaps(chunks: NarrationSilenceInterval[], targetCount: number): NarrationSilenceInterval[][] {
  const groups = chunks.map((chunk) => [chunk]);
  while (groups.length > targetCount) {
    let best = 0;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < groups.length - 1; i += 1) {
      const left = groups[i][groups[i].length - 1];
      const right = groups[i + 1][0];
      const gap = right.start - left.end;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    groups.splice(best, 2, [...groups[best], ...groups[best + 1]]);
  }
  return groups;
}

function spansForChunks(chunks: NarrationSilenceInterval[], weights: number[]): { spans: SpeechSpan[]; note: string } {
  if (chunks.length === weights.length) {
    return {
      spans: chunks.map((chunk) => ({ speechStart: chunk.start, speechEnd: chunk.end })),
      note: 'Each measured speech stretch was given one sentence.',
    };
  }
  if (chunks.length > weights.length) {
    const groups = mergeShortestGaps(chunks, weights.length);
    return {
      spans: groups.map((group) => ({
        speechStart: group[0].start,
        speechEnd: group[group.length - 1].end,
      })),
      note: 'Short pauses were kept inside a sentence. They were not turned into extra captions.',
    };
  }
  return {
    spans: walkBudgets(chunks, weights),
    note: 'Fewer pauses were measured than sentences, so a shared stretch was divided by script length.',
  };
}

function unavailable(message: string, silenceCount: number): NarrationBoundaryProposal {
  return {
    available: false,
    method: 'unavailable',
    sourceLabel: 'Alignment unavailable',
    detail: message,
    acousticVerification: false,
    verified: false,
    silenceCount,
    rows: [],
    warnings: [message],
  };
}

function rowWarnings(text: string, captionStart: number, captionEnd: number): string[] {
  const warnings: string[] = [];
  if (sentenceTerminatorCount(text) > 1) {
    warnings.push('This scene contains more than one sentence. The boundary covers the whole scene, not each sentence inside it.');
  }
  const duration = captionEnd - captionStart;
  const weight = narrationWeight(text);
  if (weight > 0 && (duration < MIN_READABLE_CAPTION_SEC || weight / Math.max(duration, 0.001) > 21)) {
    warnings.push('This caption is too short to read comfortably. It was not stretched into the next sentence.');
  }
  return warnings;
}

export function proposeNarrationBoundaries(input: NarrationBoundaryInput): NarrationBoundaryProposal {
  const duration = input.audioDurationSec;
  const silenceCount = input.silences.length;
  if (!Number.isFinite(duration) || duration <= 0) {
    return unavailable('The recording has no measured duration, so boundaries were not proposed.', silenceCount);
  }
  if (input.units.length === 0) {
    return unavailable('There are no spoken scenes to place. Boundaries were not proposed.', silenceCount);
  }
  if (input.detectionFailed) {
    return unavailable(
      input.detectionMessage
        || 'Pause detection could not read this recording. Current timings were not changed. This is not alignment.',
      silenceCount,
    );
  }

  const speech = speechIntervalsFromSilence(duration, input.silences);
  if (speech.length === 0) {
    return unavailable('No speech was measured in this recording. Current timings were not changed.', silenceCount);
  }

  const weights = input.units.map((unit) => Math.max(1, narrationWeight(unit.text)));
  const usedPauses = input.silences.some((item) => item.end - item.start >= NARRATION_SILENCE_MIN_SEC - 0.001);
  const placement = usedPauses && speech.length > 0 && !(speech.length === 1 && speech[0].start <= 0.001 && tied(speech[0].end, duration))
    ? spansForChunks(speech, weights)
    : {
        spans: walkBudgets([{ start: 0, end: duration }], weights),
        note: 'No pauses were measured, so this is still a script-length estimate across the whole recording.',
      };
  const method: NarrationEstimateMethod = placement.note.startsWith('No pauses') ? 'script_proportion' : 'speech_intervals';
  const starts = placement.spans.map((span, index) => (index === 0 ? 0 : round3(span.speechStart)));
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i] <= starts[i - 1]) starts[i] = round3(starts[i - 1] + 0.001);
  }
  if (starts[starts.length - 1] >= duration) {
    return unavailable('The measured speech could not be placed inside the recording. Current timings were not changed.', silenceCount);
  }
  const durations = starts.map((start, index) => (
    index === starts.length - 1 ? round3(duration - start) : round3(starts[index + 1] - start)
  ));

  const rows: NarrationBoundaryRow[] = input.units.map((unit, index) => {
    const sceneStart = starts[index];
    const sceneDuration = durations[index];
    const sceneEnd = round3(sceneStart + sceneDuration);
    const span = placement.spans[index];
    let captionStart = index === 0 ? round3(Math.max(sceneStart, span.speechStart)) : sceneStart;
    let captionEnd = round3(Math.min(sceneEnd, Math.max(captionStart + 0.001, span.speechEnd)));
    const pauseAfter = sceneEnd - captionEnd;
    if (captionEnd - captionStart < 0.8 && pauseAfter > 0.05 && index < input.units.length - 1) {
      const extend = Math.min(0.35, pauseAfter, 0.8 - (captionEnd - captionStart));
      captionEnd = round3(captionEnd + extend);
    }
    if (captionEnd > sceneEnd) captionEnd = sceneEnd;
    if (captionEnd <= captionStart) captionEnd = round3(Math.min(sceneEnd, captionStart + 0.001));
    return {
      sceneId: unit.sceneId,
      cueId: unit.cueId,
      text: unit.text,
      userEdited: unit.userEdited,
      proposedStart: sceneStart,
      proposedDurationSec: sceneDuration,
      proposedCaptionStart: captionStart,
      proposedCaptionEnd: captionEnd,
      warnings: rowWarnings(unit.text, captionStart, captionEnd),
    };
  });

  const warnings = [placement.note];
  if (rows.some((row) => row.warnings.length > 0)) {
    warnings.push('Some proposed captions are short or contain more than one sentence. Review them before replacing current timings.');
  }
  return {
    available: true,
    method,
    sourceLabel: method === 'speech_intervals' ? 'Pause-aware estimate' : 'Estimated timing',
    detail: method === 'speech_intervals'
      ? `${placement.note} Sentence times follow measured pauses and script length. A pause between sentences is not given its own caption. This is not word-accurate alignment and not acoustically verified.`
      : 'No pauses were measured, so these boundaries are still a script-length estimate. They are not word-accurate alignment and not acoustically verified.',
    acousticVerification: false,
    verified: false,
    silenceCount,
    rows,
    warnings,
  };
}

function cloneScenes(scenes: readonly EditableBoundaryScene[]): EditableBoundaryScene[] {
  return scenes.map((scene) => ({ ...scene }));
}

function cloneCues(captions: readonly EditableBoundaryCue[]): EditableBoundaryCue[] {
  return captions.map((cue) => ({ ...cue }));
}

function endOf(scene: EditableBoundaryScene): number {
  return round3(scene.startTime + scene.durationSec);
}

function syncTiedCaptions(
  scenes: EditableBoundaryScene[],
  captions: EditableBoundaryCue[],
  previous: EditableBoundaryScene[],
): void {
  scenes.forEach((scene, index) => {
    const old = previous[index];
    if (!old) return;
    const oldEnd = endOf(old);
    const nextEnd = endOf(scene);
    const linked = captions.filter((cue) => cue.sceneId === scene.sceneId);
    if (linked.length === 1) {
      const cue = linked[0];
      if (tied(cue.start, old.startTime)) cue.start = scene.startTime;
      if (tied(cue.end, oldEnd)) cue.end = nextEnd;
      if (cue.end <= cue.start) cue.end = nextEnd;
      return;
    }
    const delta = scene.startTime - old.startTime;
    for (const cue of linked) {
      if (tied(cue.start, old.startTime)) cue.start = scene.startTime;
      else cue.start = round3(cue.start + delta);
      if (tied(cue.end, oldEnd)) cue.end = nextEnd;
      else cue.end = round3(cue.end + delta);
      if (cue.start < scene.startTime) cue.start = scene.startTime;
      if (cue.end > nextEnd) cue.end = nextEnd;
      if (cue.end <= cue.start) cue.end = round3(Math.min(nextEnd, cue.start + 0.001));
    }
  });
}

function deriveDurations(scenes: EditableBoundaryScene[], audioDurationSec: number): string | null {
  if (scenes.length === 0) return 'There are no scenes to retile.';
  for (let i = 1; i < scenes.length; i += 1) {
    if (scenes[i].startTime <= scenes[i - 1].startTime + 0.02) {
      return `Scene ${scenes[i].sceneId} would overlap ${scenes[i - 1].sceneId}. The previous timings were kept.`;
    }
    scenes[i - 1].durationSec = round3(scenes[i].startTime - scenes[i - 1].startTime);
  }
  const last = scenes[scenes.length - 1];
  if (last.startTime >= audioDurationSec - 0.02) {
    return 'That start is past the end of the recording. The previous timings were kept.';
  }
  last.durationSec = round3(audioDurationSec - last.startTime);
  if (last.durationSec <= 0) return 'The last scene would have no duration. The previous timings were kept.';
  return null;
}

function readabilityWarnings(captions: readonly EditableBoundaryCue[]): string[] {
  return captions.flatMap((cue) => {
    const duration = cue.end - cue.start;
    if (duration > 0 && duration < MIN_READABLE_CAPTION_SEC) {
      return [`Caption ${cue.cueId} is only ${duration.toFixed(2)}s. It was not stretched into the next sentence.`];
    }
    return [];
  });
}

export function applyBoundaryEdit(input: {
  scenes: readonly EditableBoundaryScene[];
  captions: readonly EditableBoundaryCue[];
  audioDurationSec: number;
  edit:
    | { kind: 'scene-start'; sceneId: string; startTime: number }
    | { kind: 'scene-duration'; sceneId: string; durationSec: number }
    | { kind: 'caption-start'; cueId: string; start: number }
    | { kind: 'caption-end'; cueId: string; end: number };
}): BoundaryEditResult {
  const scenes = cloneScenes(input.scenes);
  const captions = cloneCues(input.captions);
  const previous = cloneScenes(input.scenes);
  const audio = input.audioDurationSec;
  const refuse = (message: string): BoundaryEditResult => ({
    applied: false,
    scenes: cloneScenes(input.scenes),
    captions: cloneCues(input.captions),
    warnings: [message],
  });

  if (!Number.isFinite(audio) || audio <= 0) return refuse('The recording duration is unknown. Boundaries were not changed.');
  const edit = input.edit;

  if (edit.kind === 'caption-start' || edit.kind === 'caption-end') {
    const cue = captions.find((item) => item.cueId === edit.cueId);
    if (!cue) return refuse('That caption is not on this target. The previous timings were kept.');
    const start = edit.kind === 'caption-start' ? edit.start : cue.start;
    const end = edit.kind === 'caption-end' ? edit.end : cue.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return refuse('The caption must end after it starts. The previous timings were kept.');
    }
    if (start < -0.001 || end > audio + 0.05) {
      return refuse('That caption runs outside the recording. The previous timings were kept.');
    }
    const index = captions.findIndex((item) => item.cueId === cue.cueId);
    const previousCue = captions[index - 1];
    const followingCue = captions[index + 1];
    if (previousCue && start < previousCue.end - 0.001) {
      return refuse(`Caption ${cue.cueId} would overlap ${previousCue.cueId}. The previous timings were kept.`);
    }
    if (followingCue && end > followingCue.start + 0.001) {
      return refuse(`Caption ${cue.cueId} would overlap ${followingCue.cueId}. It was not stretched into the next sentence.`);
    }
    cue.start = round3(start);
    cue.end = round3(end);
    const warnings = readabilityWarnings(captions);
    return { applied: true, scenes, captions, warnings };
  }

  if (edit.kind === 'scene-start') {
    const resolvedId = edit.sceneId;
    const startTime = edit.startTime;
    if (!resolvedId) return refuse('That caption is not linked to a scene. The previous timings were kept.');
    const index = scenes.findIndex((scene) => scene.sceneId === resolvedId);
    if (index < 0) return refuse('That scene is not on this target. The previous timings were kept.');
    if (!Number.isFinite(startTime) || startTime < 0) return refuse('Enter a start at or after 0. The previous timings were kept.');
    if (index === 0 && startTime > TIE_SEC) {
      return refuse('The first scene stays at 0 so the timeline does not start late. The previous timings were kept.');
    }
    const next = scenes[index + 1];
    const previousScene = scenes[index - 1];
    if (previousScene && startTime <= previousScene.startTime + 0.05) {
      return refuse(`Scene ${resolvedId} must start after ${previousScene.sceneId}. The previous timings were kept.`);
    }
    if (next && startTime >= next.startTime - 0.05) {
      return refuse(`Scene ${resolvedId} must start before ${next.sceneId}. The previous timings were kept.`);
    }
    if (!next && startTime >= audio - 0.05) return refuse('That start is past the end of the recording. The previous timings were kept.');
    scenes[index].startTime = round3(index === 0 ? 0 : startTime);
  } else if (edit.kind === 'scene-duration') {
    const durationEdit = edit;
    const index = scenes.findIndex((scene) => scene.sceneId === durationEdit.sceneId);
    if (index < 0) return refuse('That scene is not on this target. The previous timings were kept.');
    if (!Number.isFinite(durationEdit.durationSec) || durationEdit.durationSec <= 0) {
      return refuse('Duration must be greater than 0. The previous timings were kept.');
    }
    const nextStart = round3(scenes[index].startTime + durationEdit.durationSec);
    const following = scenes[index + 1];
    if (!following) {
      if (nextStart > audio + 0.05) return refuse('That duration runs past the recording. The previous timings were kept.');
      scenes[index].durationSec = round3(durationEdit.durationSec);
    } else {
      const followingEnd = endOf(following);
      if (nextStart >= followingEnd - 0.05) {
        return refuse(`That duration would erase ${following.sceneId}. The previous timings were kept.`);
      }
      following.startTime = nextStart;
    }
  } else {
    return refuse('That boundary edit is not supported. The previous timings were kept.');
  }

  const problem = deriveDurations(scenes, audio);
  if (problem) return refuse(problem);
  syncTiedCaptions(scenes, captions, previous);
  for (const cue of captions) {
    cue.start = round3(cue.start);
    cue.end = round3(cue.end);
  }
  return {
    applied: true,
    scenes,
    captions,
    warnings: readabilityWarnings(captions),
  };
}

export function repairDurationsFromStarts(input: {
  scenes: readonly EditableBoundaryScene[];
  captions: readonly EditableBoundaryCue[];
  audioDurationSec: number;
}): BoundaryEditResult {
  const scenes = cloneScenes(input.scenes);
  const previous = cloneScenes(input.scenes);
  const captions = cloneCues(input.captions);
  if (scenes.length === 0) {
    return { applied: false, scenes, captions, warnings: ['There are no scenes to repair.'] };
  }
  if (scenes[0].startTime > TIE_SEC) {
    return {
      applied: false,
      scenes: cloneScenes(input.scenes),
      captions: cloneCues(input.captions),
      warnings: ['The first scene does not start at 0. Durations were not changed.'],
    };
  }
  scenes[0].startTime = 0;
  const problem = deriveDurations(scenes, input.audioDurationSec);
  if (problem) {
    return { applied: false, scenes: cloneScenes(input.scenes), captions: cloneCues(input.captions), warnings: [problem] };
  }
  syncTiedCaptions(scenes, captions, previous);
  return { applied: true, scenes, captions, warnings: readabilityWarnings(captions) };
}

export function applyNarrationProposal(input: {
  audioDurationSec: number;
  includeManual: boolean;
  currentScenes: readonly { sceneId: string; startTime: number; durationSec: number; narration: string; role?: string; userEdited?: boolean }[];
  currentCaptions: readonly { cueId: string; sceneId: string | null; start: number; end: number; text: string; userEdited?: boolean }[];
  proposal: { available: boolean; detail: string; warnings: string[]; rows: readonly NarrationBoundaryRow[] };
}): ProposalApplication {
  const unchanged = {
    ok: false,
    scenes: input.currentScenes.map((scene) => ({ ...scene })),
    captions: input.currentCaptions.map((cue) => ({ ...cue })),
    warnings: input.proposal.warnings,
  };
  if (!input.proposal.available) {
    return { ...unchanged, message: input.proposal.detail || 'Alignment is unavailable. Current timings were not changed.' };
  }
  const rows = new Map(input.proposal.rows.map((row) => [row.sceneId, row]));
  const scenes = input.currentScenes.map((scene) => ({ ...scene }));
  for (const scene of scenes) {
    const keep = !input.includeManual && scene.userEdited === true;
    const row = rows.get(scene.sceneId);
    if (!row || keep) continue;
    scene.startTime = row.proposedStart;
  }
  if (scenes.length > 0) scenes[0].startTime = 0;
  for (let i = 1; i < scenes.length; i += 1) {
    if (scenes[i].startTime <= scenes[i - 1].startTime + 0.02) {
      return {
        ...unchanged,
        message: `Scene ${scenes[i].sceneId} would overlap ${scenes[i - 1].sceneId} if manual edits are kept. Current timings were not changed.`,
      };
    }
    scenes[i - 1].durationSec = round3(scenes[i].startTime - scenes[i - 1].startTime);
  }
  const last = scenes[scenes.length - 1];
  if (last && last.startTime >= input.audioDurationSec - 0.02) {
    return { ...unchanged, message: 'A kept manual edit leaves no room at the end of the recording. Current timings were not changed.' };
  }
  if (last) last.durationSec = round3(input.audioDurationSec - last.startTime);

  const captions = input.currentCaptions.map((cue) => ({ ...cue }));
  for (const cue of captions) {
    const keep = !input.includeManual && cue.userEdited === true;
    const row = input.proposal.rows.find((item) => item.cueId === cue.cueId);
    if (!row || keep) continue;
    const scene = scenes.find((item) => item.sceneId === cue.sceneId);
    const sceneStart = scene?.startTime ?? row.proposedCaptionStart;
    const sceneEnd = scene ? round3(scene.startTime + scene.durationSec) : row.proposedCaptionEnd;
    let start = Math.max(sceneStart, row.proposedCaptionStart);
    let end = Math.min(sceneEnd, row.proposedCaptionEnd);
    if (end <= start) end = Math.min(sceneEnd, round3(start + 0.001));
    cue.start = round3(start);
    cue.end = round3(end);
  }
  const ordered = captions.slice().sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end - 0.001) {
      return {
        ...unchanged,
        message: `Caption ${ordered[i].cueId} would overlap ${ordered[i - 1].cueId} if manual edits are kept. Current timings were not changed.`,
      };
    }
  }
  return {
    ok: true,
    message: input.includeManual
      ? 'The proposal replaced the current boundaries, including manual edits. It is still not verified alignment.'
      : 'The proposal replaced only rows that were not manually edited. Manual edits were kept.',
    scenes,
    captions,
    warnings: input.proposal.warnings,
  };
}

export function preserveReviewedExternalTiming<TScene extends { id: string; narration?: string; startTime: number; duration: number; userEdited?: boolean }, TCue extends { id: string; sceneId: string | null; text: string; start: number; end: number; userEdited?: boolean }>(input: {
  previousScenes: readonly TScene[];
  previousCaptions: readonly TCue[];
  nextScenes: readonly TScene[];
  nextCaptions: readonly TCue[];
  audioDurationSec: number;
}): { scenes: TScene[]; captions: TCue[]; totalDuration: number; warning: string | null } {
  const scenes = input.nextScenes.map((scene) => ({ ...scene }));
  const captions = input.nextCaptions.map((cue) => ({ ...cue }));
  let kept = false;
  for (const scene of scenes) {
    const old = input.previousScenes.find((item) => item.id === scene.id);
    if (!old?.userEdited) continue;
    if ((old.narration ?? '') !== (scene.narration ?? '')) continue;
    scene.startTime = old.startTime;
    scene.duration = old.duration;
    scene.userEdited = true;
    kept = true;
  }
  for (const cue of captions) {
    const old = input.previousCaptions.find((item) => item.id === cue.id)
      ?? input.previousCaptions.find((item) => item.sceneId === cue.sceneId && item.text === cue.text);
    if (!old?.userEdited || old.text !== cue.text) continue;
    cue.start = old.start;
    cue.end = old.end;
    cue.userEdited = true;
    kept = true;
  }
  if (!kept) {
    const total = scenes.length === 0 ? 0 : round3(scenes[scenes.length - 1].startTime + scenes[scenes.length - 1].duration);
    return { scenes, captions, totalDuration: total, warning: null };
  }
  const ordered = scenes.slice().sort((a, b) => a.startTime - b.startTime);
  let invalid = ordered.length > 0 && ordered[0].startTime > TIE_SEC;
  for (let i = 1; i < ordered.length; i += 1) {
    const previousEnd = ordered[i - 1].startTime + ordered[i - 1].duration;
    if (Math.abs(ordered[i].startTime - previousEnd) > TIE_SEC) invalid = true;
  }
  const spokenEnd = ordered.length === 0 ? 0 : ordered[ordered.length - 1].startTime + ordered[ordered.length - 1].duration;
  if (input.audioDurationSec > 0 && spokenEnd + 0.05 < input.audioDurationSec) invalid = true;
  if (!invalid) {
    return {
      scenes,
      captions,
      totalDuration: round3(spokenEnd),
      warning: 'Manually reviewed scene times were kept. They were not replaced by a new estimate.',
    };
  }
  const restoredScenes = input.nextScenes.map((scene) => {
    const old = input.previousScenes.find((item) => item.id === scene.id);
    if (!old) return { ...scene };
    return { ...scene, startTime: old.startTime, duration: old.duration, userEdited: old.userEdited };
  });
  const restoredCaptions = input.nextCaptions.map((cue) => {
    const old = input.previousCaptions.find((item) => item.id === cue.id)
      ?? input.previousCaptions.find((item) => item.sceneId === cue.sceneId && item.text === cue.text);
    if (!old) return { ...cue };
    return { ...cue, start: old.start, end: old.end, userEdited: old.userEdited };
  });
  const restoredEnd = restoredScenes.length === 0
    ? 0
    : restoredScenes[restoredScenes.length - 1].startTime + restoredScenes[restoredScenes.length - 1].duration;
  return {
    scenes: restoredScenes,
    captions: restoredCaptions,
    totalDuration: round3(restoredEnd),
    warning: 'Reviewed timings could not be mixed with a new estimate, so the previous timings were kept.',
  };
}
