/**
 * BuildTrack Video Factory - Phase 3A Scenario Diversity & Anti-Repetition
 *
 * Implements deterministic signals for detecting repetitive speaker patterns,
 * identical sentences, stagnant shot framings, uniform scene purposes, and
 * participation imbalances.
 */

import { Scenario, ScenarioScene } from './types.js';

export interface SpeakerParticipationMetric {
  characterId: string;
  turnCount: number;
  wordCount: number;
  turnSharePercent: number;
  wordSharePercent: number;
}

export interface RepetitionSequence {
  type: 'consecutive_speaker' | 'repeated_shot' | 'repeated_setting' | 'repeated_purpose';
  value: string;
  count: number;
  locations: { sceneId?: string; sceneIndex?: number; turnId?: string }[];
  isJustified: boolean;
  justification?: string;
}

export interface RepeatedSentenceOccurrence {
  sentence: string;
  occurrences: {
    sceneId: string;
    sceneIndex: number;
    turnId: string;
    speakerId: string;
  }[];
}

export interface ScenarioDiversityReport {
  consecutiveSpeakerRuns: RepetitionSequence[];
  repeatedSentences: RepeatedSentenceOccurrence[];
  repeatedShotRuns: RepetitionSequence[];
  repeatedSettingRuns: RepetitionSequence[];
  repeatedPurposeRuns: RepetitionSequence[];
  participation: SpeakerParticipationMetric[];
  evidenceDistribution: {
    evidenceId: string;
    sceneUsageCount: number;
    turnUsageCount: number;
  }[];
  overallDiversityScore: number; // 0 to 100 deterministic scale
}

function normalizeSentence(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"']/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Analyzes diversity and repetition signals across a scenario deterministically.
 */
export function analyzeScenarioDiversity(scenario: Scenario): ScenarioDiversityReport {
  const consecutiveSpeakerRuns: RepetitionSequence[] = [];
  const repeatedSentencesMap = new Map<string, RepeatedSentenceOccurrence['occurrences']>();
  const repeatedShotRuns: RepetitionSequence[] = [];
  const repeatedSettingRuns: RepetitionSequence[] = [];
  const repeatedPurposeRuns: RepetitionSequence[] = [];

  const characterWords = new Map<string, number>();
  const characterTurns = new Map<string, number>();

  let totalWords = 0;
  let totalTurns = 0;

  // Initialize character counters
  for (const c of scenario.characters || []) {
    characterWords.set(c.id, 0);
    characterTurns.set(c.id, 0);
  }

  // 1. Traverse scenes and turns for sentence repetition, speaker runs, participation
  let globalLastSpeakerId: string | null = null;
  let currentSpeakerRunCount = 0;
  let currentSpeakerRunLocs: { sceneId: string; sceneIndex: number; turnId: string }[] = [];
  let currentSpeakerJustified = false;
  let currentSpeakerJustification = '';

  for (const scene of scenario.scenes || []) {
    for (const turn of scene.turns || []) {
      totalTurns++;
      const words = turn.spokenText.trim().split(/\s+/).filter(Boolean).length;
      totalWords += words;

      characterTurns.set(turn.speakerId, (characterTurns.get(turn.speakerId) || 0) + 1);
      characterWords.set(turn.speakerId, (characterWords.get(turn.speakerId) || 0) + words);

      // Sentence analysis
      const sentences = turn.spokenText
        .split(/[.!?]+/)
        .map(s => normalizeSentence(s))
        .filter(s => s.length > 15); // only consider substantive sentences (>= 15 chars)

      for (const sent of sentences) {
        if (!repeatedSentencesMap.has(sent)) {
          repeatedSentencesMap.set(sent, []);
        }
        repeatedSentencesMap.get(sent)!.push({
          sceneId: scene.id,
          sceneIndex: scene.index,
          turnId: turn.id,
          speakerId: turn.speakerId,
        });
      }

      // Consecutive speaker analysis
      if (turn.speakerId === globalLastSpeakerId) {
        currentSpeakerRunCount++;
        currentSpeakerRunLocs.push({ sceneId: scene.id, sceneIndex: scene.index, turnId: turn.id });
        if (turn.monologueReason) {
          currentSpeakerJustified = true;
          currentSpeakerJustification = turn.monologueReason;
        }
      } else {
        if (currentSpeakerRunCount > 1 && globalLastSpeakerId) {
          consecutiveSpeakerRuns.push({
            type: 'consecutive_speaker',
            value: globalLastSpeakerId,
            count: currentSpeakerRunCount,
            locations: [...currentSpeakerRunLocs],
            isJustified: currentSpeakerJustified,
            justification: currentSpeakerJustification || undefined,
          });
        }
        globalLastSpeakerId = turn.speakerId;
        currentSpeakerRunCount = 1;
        currentSpeakerRunLocs = [{ sceneId: scene.id, sceneIndex: scene.index, turnId: turn.id }];
        currentSpeakerJustified = !!turn.monologueReason;
        currentSpeakerJustification = turn.monologueReason || '';
      }
    }
  }

  // End of loop check for consecutive speaker run
  if (currentSpeakerRunCount > 1 && globalLastSpeakerId) {
    consecutiveSpeakerRuns.push({
      type: 'consecutive_speaker',
      value: globalLastSpeakerId,
      count: currentSpeakerRunCount,
      locations: [...currentSpeakerRunLocs],
      isJustified: currentSpeakerJustified,
      justification: currentSpeakerJustification || undefined,
    });
  }

  // 2. Shot type, setting, and purpose runs across scenes
  const scenes = scenario.scenes || [];
  let currentShotRun: { shot: string; count: number; locs: { sceneId: string; sceneIndex: number }[]; justified: boolean; just?: string } | null = null;
  let currentSettingRun: { setting: string; count: number; locs: { sceneId: string; sceneIndex: number }[]; justified: boolean; just?: string } | null = null;
  let currentPurposeRun: { purpose: string; count: number; locs: { sceneId: string; sceneIndex: number }[] } | null = null;

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const shot = s.production?.shotType || 'medium';
    const setting = s.locationId;
    const purpose = s.narrativePurpose;

    // Shot run
    if (currentShotRun && currentShotRun.shot === shot) {
      currentShotRun.count++;
      currentShotRun.locs.push({ sceneId: s.id, sceneIndex: s.index });
      if (s.justifications?.repeatedShot) {
        currentShotRun.justified = true;
        currentShotRun.just = s.justifications.repeatedShot;
      }
    } else {
      if (currentShotRun && currentShotRun.count > 1) {
        repeatedShotRuns.push({
          type: 'repeated_shot',
          value: currentShotRun.shot,
          count: currentShotRun.count,
          locations: currentShotRun.locs,
          isJustified: currentShotRun.justified,
          justification: currentShotRun.just,
        });
      }
      currentShotRun = {
        shot,
        count: 1,
        locs: [{ sceneId: s.id, sceneIndex: s.index }],
        justified: !!s.justifications?.repeatedShot,
        just: s.justifications?.repeatedShot,
      };
    }

    // Setting run
    if (currentSettingRun && currentSettingRun.setting === setting) {
      currentSettingRun.count++;
      currentSettingRun.locs.push({ sceneId: s.id, sceneIndex: s.index });
      if (s.justifications?.repeatedSetting) {
        currentSettingRun.justified = true;
        currentSettingRun.just = s.justifications.repeatedSetting;
      }
    } else {
      if (currentSettingRun && currentSettingRun.count > 1) {
        repeatedSettingRuns.push({
          type: 'repeated_setting',
          value: currentSettingRun.setting,
          count: currentSettingRun.count,
          locations: currentSettingRun.locs,
          isJustified: currentSettingRun.justified,
          justification: currentSettingRun.just,
        });
      }
      currentSettingRun = {
        setting,
        count: 1,
        locs: [{ sceneId: s.id, sceneIndex: s.index }],
        justified: !!s.justifications?.repeatedSetting,
        just: s.justifications?.repeatedSetting,
      };
    }

    // Purpose run
    if (currentPurposeRun && currentPurposeRun.purpose === purpose) {
      currentPurposeRun.count++;
      currentPurposeRun.locs.push({ sceneId: s.id, sceneIndex: s.index });
    } else {
      if (currentPurposeRun && currentPurposeRun.count > 1) {
        repeatedPurposeRuns.push({
          type: 'repeated_purpose',
          value: currentPurposeRun.purpose,
          count: currentPurposeRun.count,
          locations: currentPurposeRun.locs,
          isJustified: false,
        });
      }
      currentPurposeRun = {
        purpose,
        count: 1,
        locs: [{ sceneId: s.id, sceneIndex: s.index }],
      };
    }
  }

  if (currentShotRun && currentShotRun.count > 1) {
    repeatedShotRuns.push({
      type: 'repeated_shot',
      value: currentShotRun.shot,
      count: currentShotRun.count,
      locations: currentShotRun.locs,
      isJustified: currentShotRun.justified,
      justification: currentShotRun.just,
    });
  }

  if (currentSettingRun && currentSettingRun.count > 1) {
    repeatedSettingRuns.push({
      type: 'repeated_setting',
      value: currentSettingRun.setting,
      count: currentSettingRun.count,
      locations: currentSettingRun.locs,
      isJustified: currentSettingRun.justified,
      justification: currentSettingRun.just,
    });
  }

  if (currentPurposeRun && currentPurposeRun.count > 1) {
    repeatedPurposeRuns.push({
      type: 'repeated_purpose',
      value: currentPurposeRun.purpose,
      count: currentPurposeRun.count,
      locations: currentPurposeRun.locs,
      isJustified: false,
    });
  }

  // Filter repeated sentences with > 1 occurrence
  const repeatedSentences: RepeatedSentenceOccurrence[] = [];
  for (const [sentence, occurrences] of repeatedSentencesMap.entries()) {
    if (occurrences.length > 1) {
      repeatedSentences.push({ sentence, occurrences });
    }
  }

  // Participation breakdown
  const participation: SpeakerParticipationMetric[] = (scenario.characters || []).map(c => {
    const turns = characterTurns.get(c.id) || 0;
    const words = characterWords.get(c.id) || 0;
    return {
      characterId: c.id,
      turnCount: turns,
      wordCount: words,
      turnSharePercent: totalTurns > 0 ? Math.round((turns / totalTurns) * 1000) / 10 : 0,
      wordSharePercent: totalWords > 0 ? Math.round((words / totalWords) * 1000) / 10 : 0,
    };
  });

  // Evidence distribution
  const evidenceDistribution = (scenario.evidence || []).map(ev => ({
    evidenceId: ev.id,
    sceneUsageCount: (ev.usedInSceneIds || []).length,
    turnUsageCount: (ev.usedInTurnIds || []).length,
  }));

  // Deterministic diversity score calculation (100 base, deductions for unjustified repetition)
  let score = 100;
  for (const r of consecutiveSpeakerRuns) {
    if (!r.isJustified && r.count > 2) score -= Math.min(20, (r.count - 2) * 8);
  }
  for (const s of repeatedSentences) {
    score -= Math.min(25, (s.occurrences.length - 1) * 10);
  }
  for (const sh of repeatedShotRuns) {
    if (!sh.isJustified && sh.count > 2) score -= Math.min(15, (sh.count - 2) * 5);
  }
  for (const p of repeatedPurposeRuns) {
    if (p.count > 2) score -= Math.min(15, (p.count - 2) * 5);
  }

  return {
    consecutiveSpeakerRuns,
    repeatedSentences,
    repeatedShotRuns,
    repeatedSettingRuns,
    repeatedPurposeRuns,
    participation,
    evidenceDistribution,
    overallDiversityScore: Math.max(0, Math.min(100, score)),
  };
}
