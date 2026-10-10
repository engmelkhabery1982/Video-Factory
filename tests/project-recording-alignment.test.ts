/**
 * The confirmed project recording is not in this environment.
 * This test must not pass by aligning a synthetic tone.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { omnilingualCtcProposal } from '../apps/api/src/services/omnilingual-ctc.js';

const WINDOWS_PROJECT = 'F:\\VideoFactory_Test_VS7_4ac181a';
const WINDOWS_DOWNLOAD = 'C:\\Users\\ASUS\\Downloads\\GeminiTTS\\rahman_raheem_narration.wav';

describe('confirmed project recording', () => {
  it('is not mounted here, so alignment of that recording is not claimed', () => {
    expect(fs.existsSync(WINDOWS_PROJECT)).toBe(false);
    expect(fs.existsSync(WINDOWS_DOWNLOAD)).toBe(false);
    expect(process.env.BUILDTRACK_PROJECT_AUDIO ?? '').toBe('');
    const proposal = omnilingualCtcProposal({ BUILDTRACK_OMNIASR_CTC_300M: '' }, 'linux');
    expect(proposal.available).toBe(false);
    expect(proposal.saved).toBe(false);
    expect(proposal.rows).toEqual([]);
    expect(proposal.detail).toContain('1.3 GiB');
    expect(proposal.detail).toContain('328 MB');
    expect(proposal.detail).toContain('pause estimation was not used');
  });

  it('does not accept a native Windows fairseq2 run or an unofficial checkpoint name', () => {
    const windows = omnilingualCtcProposal({}, 'win32');
    expect(windows.available).toBe(false);
    expect(windows.detail).toContain('native Windows');
    expect(windows.detail).toContain('not be timing');
    const renamed = omnilingualCtcProposal({ BUILDTRACK_OMNIASR_CTC_300M: import.meta.filename }, 'linux');
    expect(renamed.available).toBe(false);
    expect(renamed.detail).toContain('omniASR-CTC-300M-v2.pt');
  });
});

describe.skipIf(!process.env.BUILDTRACK_PROJECT_AUDIO)('local project recording, when a confirmed copy is provided', () => {
  it('aligns that copy and does not invent a 6.00 start', () => {
    const audio = process.env.BUILDTRACK_PROJECT_AUDIO ?? '';
    expect(fs.existsSync(audio)).toBe(true);
    const proposal = omnilingualCtcProposal({
      ...process.env,
      BUILDTRACK_OMNIASR_CTC_300M: process.env.BUILDTRACK_OMNIASR_CTC_300M,
    });
    expect(proposal.saved).toBe(false);
    expect(proposal.method).not.toBe('speech_intervals');
    expect(proposal.method).not.toBe('script_proportion');
    if (proposal.available) {
      const second = proposal.rows[1];
      expect(second).toBeDefined();
      expect(second.proposedStart).not.toBe(6);
      expect(second.proposedStart).not.toBe(4.89);
      expect(second.proposedStart).not.toBe(2.23);
    } else {
      expect(proposal.unresolved.length + proposal.warnings.length).toBeGreaterThan(0);
    }
  });
});
