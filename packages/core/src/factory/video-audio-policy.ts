/**
 * Explicit policy for the audio embedded in supplied video clips. Pure rules, no I/O:
 * the API measures whether each clip actually carries an audio stream and passes
 * those facts in; this module only decides whether the owner's policy is satisfiable
 * and which clips keep their sound in the editor document.
 *
 * Rendering the mixed/kept stream itself belongs to the export lane; here the decision
 * is validated and written onto the canonical document so no later stage has to guess.
 */
import type { FactoryMissingItem, FactoryNarrationMode, FactoryVideoAudioPolicy } from './contract.js';

export interface VideoAudioShotFact {
  sceneId: string;
  /** Null for a procedural graphic; 'image' for a still; 'video' for a clip. */
  kind: 'image' | 'video' | null;
  /** Measured from the clip's streams. Meaningful only for kind 'video'. */
  hasAudio: boolean;
  /**
   * True when the clip could not be measured (missing/unreadable file or a failed probe).
   * Such a clip must never be claimed silent: policies that need its sound refuse precisely.
   */
  unmeasured?: boolean;
  assetId: string | null;
}

export interface VideoAudioPolicyInput {
  policy: FactoryVideoAudioPolicy | null;
  /** Resolved narration mode for the draft (legacy auto resolution already applied). */
  narrationMode: FactoryNarrationMode;
  /** A separate full-narration audio asset is attached. */
  separateAudioAttached: boolean;
  /** At least one scene carries words that could be spoken. */
  hasNarrationWords: boolean;
  shots: VideoAudioShotFact[];
}

export interface VideoAudioPolicyResult {
  /** Precise, actionable problems. Empty means the policy is satisfiable as stated. */
  problems: Array<Pick<FactoryMissingItem, 'kind' | 'sceneId' | 'reason'>>;
  /** Clip asset ids whose embedded audio must survive into the export under this policy. */
  keepAudioAssetIds: string[];
  /** True when the policy mutes every clip (replace keeps narration, silent has no sound at all). */
  clipsMuted: boolean;
}

const problem = (kind: FactoryMissingItem['kind'], reason: string, sceneId: string | null = null) => ({ kind, sceneId, reason });

/**
 * Decide policy problems and clip audio membership. A null policy is the legacy path:
 * no rule is added and clips keep their legacy muted behaviour.
 */
export function evaluateVideoAudioPolicy(input: VideoAudioPolicyInput): VideoAudioPolicyResult {
  const { policy } = input;
  const videoShots = input.shots.filter((s) => s.kind === 'video');
  if (!policy) {
    return { problems: [], keepAudioAssetIds: [], clipsMuted: true };
  }
  const problems: VideoAudioPolicyResult['problems'] = [];
  if (videoShots.length === 0) {
    problems.push(problem('asset', `The video audio policy “${policy}” needs at least one video clip. Attach footage, or clear the policy for a stills-only draft.`));
  }
  if (policy === 'silent') {
    if (input.narrationMode !== 'none') {
      problems.push(problem('conflict', 'Video audio policy “silent” allows no sound. Set narration to none, or choose another policy.'));
    }
    return { problems, keepAudioAssetIds: [], clipsMuted: true };
  }

  if (policy === 'original') {
    if (input.separateAudioAttached) {
      problems.push(problem('conflict', 'Policy “original” uses the clips’ own audio and cannot also use a separate narration audio asset. Remove it, or choose “add” to keep both.'));
    }
    // Narration none is coherent here: the clips’ own audio is the entire soundtrack, with no separate narration track.
    for (const s of videoShots) {
      if (s.unmeasured) {
        problems.push(problem('asset', `Video “${s.assetId}” in scene ${s.sceneId} could not be measured, so “original” cannot be confirmed. Re-upload a readable clip or change the policy; nothing is assumed.`, s.sceneId));
      } else if (!s.hasAudio) {
        problems.push(problem('asset', `Video “${s.assetId}” in scene ${s.sceneId} has no audio stream, so “original” cannot use its sound. Supply a clip with audio or change the policy.`, s.sceneId));
      }
    }
    const keep = videoShots.filter((s) => s.hasAudio).map((s) => s.assetId as string);
    return { problems, keepAudioAssetIds: [...new Set(keep)], clipsMuted: false };
  }

  if (policy === 'add') {
    if (input.narrationMode === 'none' || (!input.separateAudioAttached && !input.hasNarrationWords)) {
      problems.push(problem('conflict', 'Policy “add” keeps clip audio and adds narration. Supply narration audio or reviewed words to speak, or choose original/silent.'));
    }
    for (const s of videoShots) {
      if (s.unmeasured) {
        problems.push(problem('asset', `Video “${s.assetId}” in scene ${s.sceneId} could not be measured, so “add” cannot confirm its sound. Re-upload a readable clip or change the policy; nothing is assumed.`, s.sceneId));
      } else if (!s.hasAudio) {
        problems.push(problem('asset', `Video “${s.assetId}” in scene ${s.sceneId} has no audio stream to keep. Supply a clip with audio or change the policy.`, s.sceneId));
      }
    }
    const keep = videoShots.filter((s) => s.hasAudio).map((s) => s.assetId as string);
    return { problems, keepAudioAssetIds: [...new Set(keep)], clipsMuted: false };
  }

  // replace: clips muted, narration comes from the existing speech paths.
  if (input.narrationMode === 'none') {
    problems.push(problem('conflict', 'Policy “replace” mutes the clips and needs narration to replace it. Choose original/add to keep clip audio, or silent for no sound.'));
  }
  if (!input.separateAudioAttached && !input.hasNarrationWords) {
    problems.push(problem('audio', 'Policy “replace” needs narration: supply approved audio or reviewed words that can be spoken.'));
  }
  return { problems, keepAudioAssetIds: [], clipsMuted: true };
}
