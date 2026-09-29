/**
 * BuildTrack Video Factory - Phase 3E Scenario Caption Compiler
 *
 * Compiles a validated canonical Scenario and its Phase 3C DialogueAudioPlan
 * into deterministic, speaker-aware, timed caption cues.
 */

import { Scenario, ScenarioTargetFormat } from './types.js';
import { DialogueAudioPlan } from './dialogue-audio-types.js';
import { validateScenario } from './validate.js';
import { validateDialogueAudioPlan } from './validate-dialogue-audio-plan.js';
import { validateScenarioCaptionPlan } from './validate-scenario-captions.js';
import {
  CAPTION_PROFILES,
  CaptionFormatProfile,
  CompileScenarioCaptionsResult,
  SCENARIO_CAPTION_PLAN_SCHEMA_VERSION,
  ScenarioCaptionCue,
  ScenarioCaptionFinding,
  ScenarioCaptionOptions,
  ScenarioCaptionPlan,
  ScenarioCaptionScene,
  ScenarioCaptionSpeaker,
  scenarioCaptionCueId,
} from './scenario-caption-types.js';

/**
 * Wraps text into lines according to character and line budget.
 */
function wrapCaptionLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = '';

  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if ((cur + ' ' + w).length <= maxChars) {
      cur += ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) {
        break;
      }
    }
  }

  const placedWords = lines.flatMap(l => l.split(' '));
  if (placedWords.length < words.length) {
    const remaining = words.slice(placedWords.length).join(' ');
    lines.push(remaining);
  } else if (cur && lines.length < maxLines) {
    lines.push(cur);
  }

  return lines.slice(0, maxLines);
}

/**
 * Splits turn spoken text into coherent, balanced caption chunks.
 * Strict guarantees:
 * - Every word is preserved exactly once in sequence.
 * - No invented punctuation or speaker labels.
 * - Respects sentence and clause boundaries.
 * - Avoids 1-word orphan fragments unless the entire turn is a 1-word utterance.
 */
export function chunkTurnSpokenText(
  text: string,
  profile: CaptionFormatProfile,
  maxCharsPerCue?: number
): { text: string; wordCount: number; sourceWordStart: number; sourceWordEnd: number }[] {
  const clean = String(text).trim().replace(/\s+/g, ' ');
  if (!clean) return [];

  const totalWords = clean.split(' ').filter(Boolean);
  if (totalWords.length === 0) return [];

  // If the entire turn is a single word (e.g. "Agreed.")
  if (totalWords.length === 1) {
    return [{
      text: clean,
      wordCount: 1,
      sourceWordStart: 0,
      sourceWordEnd: 1,
    }];
  }

  const maxBudget = maxCharsPerCue ?? profile.maxCharsPerCue;

  // Split first by sentence boundaries
  const sentenceRegex = /(?<=[.!?\u061F])\s+(?=[A-Z0-9"\u0600-\u06FF])/;
  const rawSentences = clean.split(sentenceRegex).filter(Boolean);

  // Merge any single-word sentences (e.g. "Agreed.") with neighbor if turn has multiple words
  const mergedSentences: string[] = [];
  for (let i = 0; i < rawSentences.length; i++) {
    const s = rawSentences[i].trim();
    const sWords = s.split(' ').filter(Boolean);

    if (sWords.length === 1 && i + 1 < rawSentences.length) {
      // Merge with next sentence
      rawSentences[i + 1] = s + ' ' + rawSentences[i + 1].trim();
    } else if (sWords.length === 1 && mergedSentences.length > 0) {
      // Merge with previous sentence
      const prev = mergedSentences.pop()!;
      mergedSentences.push(prev + ' ' + s);
    } else {
      mergedSentences.push(s);
    }
  }

  const chunks: { text: string; wordCount: number; sourceWordStart: number; sourceWordEnd: number }[] = [];
  let globalWordIndex = 0;

  for (const sentence of mergedSentences) {
    const sWords = sentence.split(' ').filter(Boolean);
    if (sWords.length === 0) continue;

    // If sentence fits comfortably in one cue
    if (sentence.length <= maxBudget) {
      chunks.push({
        text: sentence,
        wordCount: sWords.length,
        sourceWordStart: globalWordIndex,
        sourceWordEnd: globalWordIndex + sWords.length,
      });
      globalWordIndex += sWords.length;
      continue;
    }

    // Sentence exceeds max budget: split at clause boundaries or balanced word boundary
    const subChunks = splitSentenceIntoBalancedChunks(sWords, maxBudget);
    for (const sub of subChunks) {
      chunks.push({
        text: sub.text,
        wordCount: sub.wordCount,
        sourceWordStart: globalWordIndex,
        sourceWordEnd: globalWordIndex + sub.wordCount,
      });
      globalWordIndex += sub.wordCount;
    }
  }

  // Safety post-pass: ensure no 1-word chunks exist if totalWords > 1
  if (totalWords.length > 1 && chunks.length > 1) {
    for (let c = 0; c < chunks.length; c++) {
      if (chunks[c].wordCount === 1) {
        if (c > 0) {
          // Merge with previous
          const prev = chunks[c - 1];
          const merged = {
            text: prev.text + ' ' + chunks[c].text,
            wordCount: prev.wordCount + 1,
            sourceWordStart: prev.sourceWordStart,
            sourceWordEnd: chunks[c].sourceWordEnd,
          };
          chunks.splice(c - 1, 2, merged);
          c--;
        } else if (c + 1 < chunks.length) {
          // Merge with next
          const next = chunks[c + 1];
          const merged = {
            text: chunks[c].text + ' ' + next.text,
            wordCount: next.wordCount + 1,
            sourceWordStart: chunks[c].sourceWordStart,
            sourceWordEnd: next.sourceWordEnd,
          };
          chunks.splice(c, 2, merged);
        }
      }
    }
  }

  return chunks;
}

/**
 * Splits a long sentence into balanced sub-chunks without leaving 1-word orphans.
 */
function splitSentenceIntoBalancedChunks(
  words: string[],
  maxBudget: number
): { text: string; wordCount: number }[] {
  if (words.length <= 3) {
    return [{ text: words.join(' '), wordCount: words.length }];
  }

  const result: { text: string; wordCount: number }[] = [];
  let currentWords: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const candidate = [...currentWords, w].join(' ');
    const remainingWordsCount = words.length - (i + 1);

    if (candidate.length > maxBudget && currentWords.length >= 2) {
      if (remainingWordsCount === 1) {
        if (currentWords.length > 2) {
          const popped = currentWords.pop()!;
          result.push({ text: currentWords.join(' '), wordCount: currentWords.length });
          currentWords = [popped, w];
        } else {
          result.push({ text: currentWords.join(' '), wordCount: currentWords.length });
          currentWords = [w];
        }
      } else {
        result.push({ text: currentWords.join(' '), wordCount: currentWords.length });
        currentWords = [w];
      }
    } else {
      currentWords.push(w);
    }
  }

  if (currentWords.length > 0) {
    if (currentWords.length === 1 && result.length > 0) {
      const prev = result[result.length - 1];
      result[result.length - 1] = {
        text: prev.text + ' ' + currentWords[0],
        wordCount: prev.wordCount + 1,
      };
    } else {
      result.push({ text: currentWords.join(' '), wordCount: currentWords.length });
    }
  }

  return result;
}

/**
 * Compiles a Scenario and its DialogueAudioPlan into a ScenarioCaptionPlan.
 */
export function compileScenarioCaptions(
  scenario: Scenario,
  audioPlan: DialogueAudioPlan,
  options: ScenarioCaptionOptions = {}
): CompileScenarioCaptionsResult {
  const findings: ScenarioCaptionFinding[] = [];

  // 1. Basic validation of inputs
  if (!scenario || typeof scenario !== 'object') {
    return {
      success: false,
      error: 'Invalid input: scenario must be a non-null object.',
      findings: [{
        severity: 'error',
        category: 'schema',
        ruleId: 'SCP-000-INVALID-SCENARIO',
        message: 'Scenario is missing or invalid.',
      }],
    };
  }

  if (!audioPlan || typeof audioPlan !== 'object') {
    return {
      success: false,
      error: 'Invalid input: audioPlan must be a non-null object.',
      findings: [{
        severity: 'error',
        category: 'schema',
        ruleId: 'SCP-000-INVALID-AUDIO-PLAN',
        message: 'DialogueAudioPlan is missing or invalid.',
      }],
    };
  }

  // Cross-check scenario & audioPlan consistency
  if (scenario.metadata?.id !== audioPlan.scenarioId) {
    const msg = `Scenario ID mismatch: scenario has '${scenario.metadata?.id}', audioPlan has '${audioPlan.scenarioId}'.`;
    return {
      success: false,
      error: msg,
      findings: [{
        severity: 'error',
        category: 'integrity',
        ruleId: 'SCP-001-SCENARIO-ID-MISMATCH',
        message: msg,
        location: { scenarioId: scenario.metadata?.id },
      }],
    };
  }

  if (scenario.metadata?.targetFormat !== audioPlan.targetFormat) {
    const msg = `Target format mismatch: scenario has '${scenario.metadata?.targetFormat}', audioPlan has '${audioPlan.targetFormat}'.`;
    return {
      success: false,
      error: msg,
      findings: [{
        severity: 'error',
        category: 'integrity',
        ruleId: 'SCP-002-TARGET-FORMAT-MISMATCH',
        message: msg,
        location: { scenarioId: scenario.metadata?.id },
      }],
    };
  }

  if (scenario.metadata?.projectId !== audioPlan.projectId || scenario.metadata?.language !== audioPlan.language) {
    const msg = 'Scenario project/language metadata does not match the DialogueAudioPlan.';
    return { success: false, error: msg, findings: [{ severity: 'error', category: 'integrity', ruleId: 'SCP-002-AUDIO-METADATA-MISMATCH', message: msg, location: { scenarioId: scenario.metadata?.id } }] };
  }

  try {
    const scenarioReport = validateScenario(scenario);
    if (!scenarioReport.valid) {
      const mapped = scenarioReport.findings.filter((finding) => finding.severity === 'error').map((finding) => ({
        severity: 'error' as const,
        category: 'integrity' as const,
        ruleId: `SCP-SOURCE-${finding.ruleId}`,
        message: finding.message,
        location: { scenarioId: scenario.metadata.id, sceneId: finding.location?.sceneId, turnId: finding.location?.turnId },
      }));
      return { success: false, error: 'Source Scenario failed validation.', findings: mapped };
    }
    const audioReport = validateDialogueAudioPlan(audioPlan, scenario);
    if (!audioReport.valid) {
      const mapped = audioReport.findings.filter((finding) => finding.severity === 'error').map((finding) => ({
        severity: 'error' as const,
        category: (finding.category === 'timing' ? 'timing' : finding.category === 'path' ? 'path' : 'integrity') as ScenarioCaptionFinding['category'],
        ruleId: `SCP-AUDIO-${finding.ruleId}`,
        message: finding.message,
        location: finding.location,
      }));
      return { success: false, error: 'DialogueAudioPlan failed validation.', findings: mapped };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Input validation failed: ${message}`, findings: [{ severity: 'error', category: 'schema', ruleId: 'SCP-000-INPUT-UNREADABLE', message }] };
  }

  if ((options.maxCharsPerLine !== undefined && (!Number.isInteger(options.maxCharsPerLine) || options.maxCharsPerLine < 8)) ||
      (options.maxLines !== undefined && (!Number.isInteger(options.maxLines) || options.maxLines < 1))) {
    const msg = 'Caption overrides require maxCharsPerLine >= 8 and maxLines >= 1.';
    return { success: false, error: msg, findings: [{ severity: 'error', category: 'schema', ruleId: 'SCP-002-INVALID-OPTIONS', message: msg }] };
  }

  const targetFormat: ScenarioTargetFormat = scenario.metadata.targetFormat || 'Long';
  const baseProfile = CAPTION_PROFILES[targetFormat] || CAPTION_PROFILES.Long;
  const profile: CaptionFormatProfile = {
    ...baseProfile,
    maxCharsPerLine: options.maxCharsPerLine ?? baseProfile.maxCharsPerLine,
    maxLines: options.maxLines ?? baseProfile.maxLines,
    maxCharsPerCue: options.maxCharsPerLine || options.maxLines
      ? (options.maxCharsPerLine ?? baseProfile.maxCharsPerLine) * (options.maxLines ?? baseProfile.maxLines)
      : baseProfile.maxCharsPerCue,
  };

  // Build audio clip lookup
  const clipMap = new Map<string, typeof audioPlan.clips[0]>();
  for (const clip of audioPlan.clips || []) {
    clipMap.set(clip.turnId, clip);
  }

  // Build character lookup
  const characterMap = new Map((scenario.characters || []).map(c => [c.id, c]));

  // Build speakers list
  const speakers: ScenarioCaptionSpeaker[] = (audioPlan.characters || []).map(ac => {
    const char = characterMap.get(ac.characterId);
    return {
      speakerId: ac.characterId,
      name: char?.name || ac.name,
      role: char?.role || ac.role,
      voiceSlot: ac.voiceSlot,
    };
  });

  // Reading direction
  const isRtl = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(
    (scenario.scenes || []).flatMap(s => s.turns || []).map(t => t.spokenText).join(' ')
  );
  const direction: 'ltr' | 'rtl' = options.direction ?? (isRtl ? 'rtl' : 'ltr');

  const captionScenes: ScenarioCaptionScene[] = [];
  const allCues: ScenarioCaptionCue[] = [];
  let globalCueIndex = 0;
  let totalWordCount = 0;

  for (let sIdx = 0; sIdx < (scenario.scenes || []).length; sIdx++) {
    const scene = scenario.scenes[sIdx];
    const sceneCues: ScenarioCaptionCue[] = [];
    const audioScene = audioPlan.scenes[sIdx];
    let sceneStartTime = audioScene.startTimeSeconds;
    let sceneEndTime = audioScene.endTimeSeconds;

    for (let tIdx = 0; tIdx < (scene.turns || []).length; tIdx++) {
      const turn = scene.turns[tIdx];
      const clip = clipMap.get(turn.id);

      if (!clip) {
        const msg = `Dialogue turn '${turn.id}' in scene '${scene.id}' has no matching clip in DialogueAudioPlan.`;
        return {
          success: false,
          error: msg,
          findings: [{
            severity: 'error',
            category: 'integrity',
            ruleId: 'SCP-003-CLIP-NOT-FOUND',
            message: msg,
            location: { scenarioId: scenario.metadata.id, sceneId: scene.id, turnId: turn.id },
          }],
        };
      }

      // Chunk spoken text
      const chunks = chunkTurnSpokenText(turn.spokenText, profile);
      const totalCuesInTurn = chunks.length;

      // Word-weighted timing allocation strictly within speech interval [clip.startTimeSeconds, clip.endTimeSeconds]
      // NEVER extends into pauseAfterSeconds!
      const totalTurnWords = chunks.reduce((acc, c) => acc + c.wordCount, 0);
      const speechDurationMs = Math.round(clip.durationSeconds * 1000);
      const clipStartMs = Math.round(clip.startTimeSeconds * 1000);

      let accumulatedWords = 0;

      for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
        const chunk = chunks[cIdx];
        const cueId = scenarioCaptionCueId(scene.id, turn.id, cIdx);

        // Integer millisecond calculations
        const startMs = cIdx === 0
          ? clipStartMs
          : clipStartMs + Math.round((accumulatedWords / totalTurnWords) * speechDurationMs);

        accumulatedWords += chunk.wordCount;

        const endMs = cIdx === chunks.length - 1
          ? clipStartMs + speechDurationMs
          : clipStartMs + Math.round((accumulatedWords / totalTurnWords) * speechDurationMs);

        const startSeconds = startMs / 1000;
        const endSeconds = endMs / 1000;
        const durationSeconds = Math.round((endSeconds - startSeconds) * 1000) / 1000;

        // Wrap lines
        const lines = wrapCaptionLines(chunk.text, profile.maxCharsPerLine, profile.maxLines);

        const cue: ScenarioCaptionCue = {
          id: cueId,
          scenarioId: scenario.metadata.id,
          sceneId: scene.id,
          sceneIndex: sIdx,
          turnId: turn.id,
          turnIndex: tIdx,
          clipId: clip.clipId,
          speakerId: turn.speakerId,
          reactingCharacterId: turn.reactionTargetId,
          voiceSlot: clip.voiceSlot,
          startSeconds,
          endSeconds,
          durationSeconds,
          text: chunk.text,
          lines,
          cueIndex: cIdx,
          totalCuesInTurn,
          globalCueIndex,
          sourceWordStart: chunk.sourceWordStart,
          sourceWordEnd: chunk.sourceWordEnd,
          wordCount: chunk.wordCount,
          targetFormat,
          direction,
          intent: turn.intent,
          delivery: turn.delivery,
        };

        sceneCues.push(cue);
        allCues.push(cue);
        globalCueIndex++;
        totalWordCount += chunk.wordCount;

      }
    }

    captionScenes.push({
      sceneId: scene.id,
      sceneIndex: sIdx,
      title: scene.title,
      startSeconds: sceneStartTime,
      endSeconds: sceneEndTime,
      cues: sceneCues,
    });
  }

  const plan: ScenarioCaptionPlan = {
    schemaVersion: SCENARIO_CAPTION_PLAN_SCHEMA_VERSION,
    scenarioId: scenario.metadata.id,
    projectId: scenario.metadata.projectId,
    targetFormat,
    language: scenario.metadata.language || 'en',
    direction,
    profile,
    totalDurationSeconds: audioPlan.totalDurationSeconds,
    totalSpeechDurationSeconds: audioPlan.totalSpeechDurationSeconds,
    cueCount: allCues.length,
    totalWordCount,
    speakers,
    scenes: captionScenes,
    cues: allCues,
  };

  const validation = validateScenarioCaptionPlan(plan, scenario, audioPlan);
  if (!validation.valid) return {
    success: false,
    error: 'Compiled caption plan failed deterministic validation.',
    findings: validation.findings,
  };

  return {
    success: true,
    plan,
    warnings: findings,
  };
}
