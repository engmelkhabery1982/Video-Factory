/**
 * Official omniASR_CTC_300M_v2 readiness.
 *
 * The public transcribe() path returns text only. This service never turns
 * that text, or a silence detector, into sentence times.
 */
import fs from 'node:fs';
import { OMNIASR_CTC_300M, unavailableProposal, type CtcTimingProposal } from '@buildtrack/core';

export function omnilingualCtcProposal(env: NodeJS.ProcessEnv = process.env, platform = process.platform): CtcTimingProposal {
  if (platform === 'win32') {
    return unavailableProposal(
      'omniASR_CTC_300M_v2 cannot run through fairseq2 on native Windows. fairseq2 has no native Windows build. A transcript would not be timing, the 328 MB int8 file is not used, and saved timings were not replaced.',
    );
  }
  const checkpoint = env.BUILDTRACK_OMNIASR_CTC_300M?.trim() ?? '';
  if (!checkpoint || !fs.existsSync(checkpoint)) {
    return unavailableProposal(
      `Official ${OMNIASR_CTC_300M.modelCard} weights are not installed (${OMNIASR_CTC_300M.downloadSize}, ${OMNIASR_CTC_300M.license}, ${OMNIASR_CTC_300M.officialUrl}). The 328 MB int8 export was not used. Saved timings were not replaced, and pause estimation was not used.`,
    );
  }
  const base = checkpoint.split(/[\\/]/).pop() ?? '';
  if (base !== OMNIASR_CTC_300M.checkpointName) {
    return unavailableProposal(
      `The configured checkpoint is ${base}, not the official ${OMNIASR_CTC_300M.checkpointName}. It was not treated as an alignment model.`,
    );
  }
  return unavailableProposal(
    'The official checkpoint is present, but CTC frame emissions are not extracted in this build. Greedy transcription was not used as timing, and saved timings were not replaced.',
  );
}
