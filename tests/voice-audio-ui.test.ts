/**
 * @vitest-environment happy-dom
 *
 * VS3 — "Voice & Audio" UI suite.
 *
 * These render and operate the REAL `VoiceAudioPanel` (no stand-in markup), with
 * only the API client mocked, exactly like the target-audio UI suite. The point
 * is the integrated workflow a user sees: truthful engine states with remedies,
 * upload → confirm authorization → approve reference (three separate facts),
 * speaker assignment, preview generation with progress, playback of THIS
 * project's artifact and approval bound to it.
 *
 * No engine, no model, no network: the panel only reflects what the API returns.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceAudioPanel, type VoiceAudioStatePayload } from '../apps/web/src/components/VoiceAudioPanel.js';
import { api } from '../apps/web/src/lib/api.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const REF = 'ref_0123456789abcdef';

function state(overrides: Partial<VoiceAudioStatePayload> = {}): VoiceAudioStatePayload {
  return {
    projectId: 'Video_01',
    engines: [
      {
        engine: 'chatterbox',
        engineId: 'chatterbox-tts',
        label: 'Chatterbox voice cloning (multilingual)',
        state: 'available',
        detail: 'Provisioned chatterbox-multilingual-v3.',
        remedy: null,
        selectable: true,
        generatable: true,
        unverifiedPath: false,
        lastFailure: null,
      },
      {
        engine: 'kokoro',
        engineId: 'kokoro-js',
        label: 'Kokoro 82M presets (local, CPU)',
        state: 'not_provisioned',
        detail: 'The Kokoro model cache is not present.',
        remedy: 'npm run provision:tts',
        selectable: false,
        generatable: false,
        unverifiedPath: false,
        lastFailure: null,
      },
    ],
    kokoroSeparateChoice: true,
    references: [],
    assignments: [],
    speakers: [{ speakerId: 'narrator', speakerName: 'Narrator', assigned: false }],
    preview: null,
    approval: null,
    renderGate: {
      allowed: true,
      notApplicable: true,
      blockedCodes: ['VOICE-AUDIO-000-NO-CLONED-VOICE'],
      findings: [],
      reason: 'No cloned voice is selected; the existing narration flow applies.',
    },
    clonedVoiceSelected: false,
    ...overrides,
  } as VoiceAudioStatePayload;
}

function approvedReference(overrides: Record<string, unknown> = {}) {
  return {
    referenceId: REF,
    displayName: 'Operator voice',
    sha256Prefix: '2f23fb9e7524',
    durationSeconds: 6,
    sampleRate: 24000,
    channels: 1,
    container: 'wav',
    sizeBytes: 288044,
    createdAt: '2026-10-08T12:00:00.000Z',
    authorized: true,
    authorizedAt: '2026-10-08T12:00:00.000Z',
    approved: true,
    approvalState: 'approved' as const,
    approvedAt: '2026-10-08T12:01:00.000Z',
    blockedCodes: [] as string[],
    ...overrides,
  };
}

function assigned(overrides: Record<string, unknown> = {}) {
  return {
    speakerId: 'narrator',
    engine: 'chatterbox' as const,
    referenceId: REF,
    presetVoiceId: null,
    referenceDisplayName: 'Operator voice',
    referenceApproved: true,
    speakerLabel: 'Narrator',
    ...overrides,
  };
}

function readyPreview(overrides: Record<string, unknown> = {}) {
  return {
    previewId: 'prv_abcdef',
    status: 'ready' as const,
    durationSeconds: 3.4,
    language: 'en',
    engineSummary: 'Chatterbox (chatterbox-tts)',
    createdAt: '2026-10-08T12:02:00.000Z',
    artifactAvailable: true,
    audioUrl: '/api/projects/Video_01/voice-audio/previews/prv_abcdef/audio',
    segments: 1,
    timing: {
      mode: 'full_duration_preserved',
      perSceneAlignment: false,
      durationSeconds: 3.4,
      integrationPoint: 'services/store.ts#generateStoryboard',
    },
    error: null,
    ...overrides,
  };
}

function button(host: HTMLElement, testId: string): HTMLButtonElement {
  const found = host.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  if (!found) throw new Error(`Element not found: ${testId}`);
  return found;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('VS3: real VoiceAudioPanel behavior', () => {
  let host: HTMLDivElement;
  let root: Root;
  let toast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    toast = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function renderPanel(payload: VoiceAudioStatePayload): Promise<void> {
    vi.spyOn(api, 'voiceAudio').mockResolvedValue(payload as any);
    await act(async () => {
      root.render(React.createElement(VoiceAudioPanel, { projectId: 'Video_01', toast }));
    });
    await flush();
  }

  /* ---------------- A. engine availability ---------------- */

  it('states an unavailable engine truthfully and shows the provisioning remedy', async () => {
    await renderPanel(
      state({
        engines: [
          {
            engine: 'chatterbox',
            engineId: 'chatterbox-tts',
            label: 'Chatterbox voice cloning (multilingual)',
            state: 'not_provisioned',
            detail: 'Runtime present but the model/environment is not verified as provisioned.',
            remedy: 'npm run provision:voice-clone -- --apply',
            selectable: false,
            generatable: false,
            unverifiedPath: false,
            lastFailure: null,
          },
          {
            engine: 'kokoro',
            engineId: 'kokoro-js',
            label: 'Kokoro 82M presets (local, CPU)',
            state: 'not_provisioned',
            detail: 'The Kokoro model cache is not present.',
            remedy: 'npm run provision:tts',
            selectable: false,
            generatable: false,
            unverifiedPath: false,
            lastFailure: null,
          },
        ],
      })
    );

    const engines = host.querySelector('[data-testid="engine-status"]')!;
    expect(engines.textContent).toContain('Not provisioned');
    expect(engines.textContent).toContain('npm run provision:voice-clone -- --apply');
    expect(engines.textContent).toContain('nothing is downloaded automatically');
    /* No claim of availability anywhere, and the upload path is closed. */
    expect(engines.textContent).not.toContain('Available');
    expect((host.querySelector('[data-testid="reference-file"]') as HTMLInputElement).disabled).toBe(true);
    expect((host.querySelector('[data-testid="reference-display-name"]') as HTMLInputElement).disabled).toBe(true);
  });

  it('says the CPU path is opt-in and not verified when only the GPU is missing', async () => {
    await renderPanel(
      state({
        engines: [
          {
            engine: 'chatterbox',
            engineId: 'chatterbox-tts',
            label: 'Chatterbox voice cloning (multilingual)',
            state: 'device_unsupported',
            detail: 'No NVIDIA GPU detected. CUDA execution is required unless CPU is explicitly opted in.',
            remedy: 'Set CHATTERBOX_ALLOW_CPU=1 only after verifying CPU synthesis on this host.',
            selectable: false,
            generatable: false,
            unverifiedPath: true,
            lastFailure: null,
          },
        ],
      })
    );
    const engines = host.querySelector('[data-testid="engine-status"]')!;
    expect(engines.textContent).toContain('Device unsupported');
    expect(engines.textContent).toContain('NOT verified');
    expect(engines.textContent).toContain('opt-in');
  });

  it('keeps Kokoro an explicit separate choice', async () => {
    await renderPanel(state());
    expect(host.textContent).toContain('Kokoro presets stay a separate explicit choice');
    const kokoroOption = [...host.querySelectorAll('option')].find((o) => o.getAttribute('value') === 'kokoro')!;
    expect(kokoroOption.textContent).toContain('not a clone');
    expect(kokoroOption.disabled).toBe(true);
    const chatterboxOption = [...host.querySelectorAll('option')].find((o) => o.getAttribute('value') === 'chatterbox')!;
    /* No approved reference yet, so the cloned option cannot be picked. */
    expect(chatterboxOption.disabled).toBe(true);
  });

  /* ---------------- B. reference upload + the three facts ---------------- */

  it('uploads a recording and grants nothing: authorization and approval stay separate', async () => {
    const uploaded = approvedReference({
      authorized: false,
      authorizedAt: null,
      approved: false,
      approvalState: 'pending',
      approvedAt: null,
    });
    vi.spyOn(api, 'uploadVoiceReference').mockResolvedValue({
      ok: true,
      reference: uploaded,
      validation: {
        durationSeconds: 6,
        sampleRate: 24000,
        channels: 1,
        container: 'wav',
        sizeBytes: 288044,
        checkedBy: 'ffprobe content inspection (not the file extension alone)',
      },
      authorized: false,
      approved: false,
    } as any);
    /* The panel reloads after the upload: the second read shows the stored
     * recording, which is exactly the state an upload must produce. */
    vi.spyOn(api, 'voiceAudio')
      .mockResolvedValueOnce(state() as any)
      .mockResolvedValueOnce(state({ references: [uploaded] }) as any);
    await act(async () => {
      root.render(React.createElement(VoiceAudioPanel, { projectId: 'Video_01', toast }));
    });
    await flush();

    expect(host.textContent).toContain('Uploading one grants nothing');

    const input = host.querySelector('[data-testid="reference-file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'take.wav', { type: 'audio/wav' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();

    expect(api.uploadVoiceReference).toHaveBeenCalledWith('Video_01', expect.any(FormData));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Confirm authorization to continue'), 'ok');

    const card = host.querySelector(`[data-testid="reference-${REF}"]`)!;
    expect(card.textContent).toContain('Authorization not confirmed');
    expect(card.textContent).toContain('Reference not approved');
    /* The authorization button is inert until the user writes a real statement. */
    const authorize = button(host, `authorize-${REF}`);
    expect(authorize.disabled).toBe(true);
    const statement = host.querySelector(`[data-testid="authorization-statement-${REF}"]`) as HTMLTextAreaElement;
    await act(async () => {
      /* React tracks the value: set it through the native setter so onChange fires. */
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(statement, 'This is my own voice and I authorize its use.');
      statement.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(button(host, `authorize-${REF}`).disabled).toBe(false);
  });

  it('records authorization explicitly, then approval with commercial-use evidence', async () => {
    vi.spyOn(api, 'authorizeVoiceReference').mockResolvedValue({ ok: true } as any);
    vi.spyOn(api, 'approveVoiceReference').mockResolvedValue({ ok: true } as any);
    const pending = approvedReference({
      authorized: false,
      authorizedAt: null,
      approved: false,
      approvalState: 'pending',
      approvedAt: null,
    });
    const authorized = approvedReference({ approved: false, approvalState: 'pending', approvedAt: null });
    vi.spyOn(api, 'voiceAudio')
      .mockResolvedValueOnce(state({ references: [pending] }) as any)
      .mockResolvedValueOnce(state({ references: [authorized] }) as any);
    await act(async () => {
      root.render(React.createElement(VoiceAudioPanel, { projectId: 'Video_01', toast }));
    });
    await flush();

    const statement = host.querySelector(`[data-testid="authorization-statement-${REF}"]`) as HTMLTextAreaElement;
    await act(async () => {
      /* React tracks the value: set it through the native setter so onChange fires. */
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(statement, 'This is my own voice and I authorize its use.');
      statement.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await act(async () => {
      button(host, `authorize-${REF}`).click();
    });
    await flush();

    expect(api.authorizeVoiceReference).toHaveBeenCalledWith('Video_01', REF, {
      ownerConfirmed: true,
      statement: 'This is my own voice and I authorize its use.',
      confirmedBy: 'project-owner',
    });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('still needs explicit approval'), 'ok');

    /* The reload after authorization shows the approval controls; approval needs rights. */
    const card = host.querySelector(`[data-testid="reference-${REF}"]`)!;
    expect(card.textContent).toContain('Authorization recorded');
    expect(card.textContent).toContain('Reference not approved');
    expect(card.textContent).toContain('A licence that is silent about commerce is not permission');

    await act(async () => {
      button(host, `approve-reference-${REF}`).click();
    });
    await flush();

    expect(api.approveVoiceReference).toHaveBeenCalledWith('Video_01', REF, {
      decision: 'approved',
      approver: 'project-owner',
      rights: expect.objectContaining({ commercialUse: 'permitted', evidenceKind: 'written_permission' }),
    });
  });

  it('removes a reference only after an explicit confirmation', async () => {
    vi.spyOn(api, 'removeVoiceReference').mockResolvedValue({ ok: true } as any);
    await renderPanel(state({ references: [approvedReference()] }));

    expect(api.removeVoiceReference).not.toHaveBeenCalled();
    await act(async () => {
      button(host, `remove-${REF}`).click();
    });
    await flush();
    expect(api.removeVoiceReference).not.toHaveBeenCalled();
    expect(host.textContent).toContain('delete the stored recording?');

    await act(async () => {
      button(host, `confirm-remove-${REF}`).click();
    });
    await flush();
    expect(api.removeVoiceReference).toHaveBeenCalledWith('Video_01', REF);
    /* Assignments are NOT cleared silently: the panel never passes the flag. */
    expect(vi.mocked(api.removeVoiceReference).mock.calls[0]).toHaveLength(2);
  });

  /* ---------------- C. assignment, preview, approval ---------------- */

  it('assigns the approved reference to the speaker and never implies a second voice', async () => {
    vi.spyOn(api, 'setVoiceAssignments').mockResolvedValue({ ok: true, assignments: [], renderGate: {} } as any);
    await renderPanel(state({ references: [approvedReference()] }));

    expect(host.textContent).toContain('Two different names do not imply two different voices');
    const engineSelect = host.querySelector('[data-testid="engine-narrator"]') as HTMLSelectElement;
    await act(async () => {
      engineSelect.value = 'chatterbox';
      engineSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(api.setVoiceAssignments).toHaveBeenCalledWith('Video_01', [
      { speakerId: 'narrator', engine: 'chatterbox', referenceId: REF, presetVoiceId: undefined },
    ]);
  });

  it('generates the complete preview, plays THIS project artifact and approves exactly it', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'voiceAudio').mockResolvedValue(state({ assignments: [assigned()] }) as any);
    vi.spyOn(api, 'generateVoicePreview').mockResolvedValue({
      jobId: 'job-1',
      previewId: 'prv_abcdef',
      status: 'running',
      totalSegments: 1,
    } as any);
    vi.spyOn(api, 'voiceAudioJob').mockResolvedValue({
      status: 'done',
      progress: { completed: 1, total: 1 },
      log: [],
    } as any);
    vi.spyOn(api, 'decideVoicePreview').mockResolvedValue({ ok: true } as any);

    await act(async () => {
      root.render(React.createElement(VoiceAudioPanel, { projectId: 'Video_01', toast }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      button(host, 'generate-preview').click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(host.querySelector('[data-testid="generation-progress"]')?.textContent).toContain('0/1');

    /* The job settles, the panel reloads and the real artifact becomes playable. */
    vi.spyOn(api, 'voiceAudio').mockResolvedValue(
      state({ assignments: [assigned()], preview: readyPreview(), clonedVoiceSelected: true }) as any
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(api.voiceAudioJob).toHaveBeenCalledWith('Video_01', 'job-1');
    const player = host.querySelector('[data-testid="preview-audio"]') as HTMLAudioElement;
    expect(player.getAttribute('src')).toBe('/api/projects/Video_01/voice-audio/previews/prv_abcdef/audio');
    expect(host.querySelector('[data-testid="preview-status"]')?.textContent).toContain('Preview ready');
    expect(host.querySelector('[data-testid="timing-note"]')?.textContent).toContain(
      'rendering with a cloned voice stays blocked'
    );

    await act(async () => {
      button(host, 'approve-preview').click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.decideVoicePreview).toHaveBeenCalledWith('Video_01', 'prv_abcdef', {
      decision: 'approved',
      approvedBy: 'project-owner',
    });
  });

  it('shows a stale approval instead of pretending it is still valid', async () => {
    await renderPanel(
      state({
        assignments: [assigned()],
        preview: readyPreview(),
        approval: {
          decision: 'approved',
          approvedAt: '2026-10-08T12:03:00.000Z',
          approvedBy: 'project-owner',
          boundToCurrentPreview: false,
          staleCodes: ['APPROVAL-STALE-IDENTITY'],
        },
        clonedVoiceSelected: true,
        renderGate: {
          allowed: false,
          notApplicable: false,
          blockedCodes: ['APPROVAL-STALE-IDENTITY', 'VOICE-AUDIO-060-TIMING-ALIGNMENT-PENDING'],
          findings: [
            {
              code: 'APPROVAL-STALE-IDENTITY',
              message: 'The approved audio was generated from different inputs.',
              remediation: 'Generate a new preview and approve it again.',
            },
            {
              code: 'VOICE-AUDIO-060-TIMING-ALIGNMENT-PENDING',
              message: 'Per-scene timing alignment is not connected yet.',
              remediation: 'Connect the timing integration point before rendering cloned audio.',
            },
          ],
          reason: 'Cloned audio is blocked.',
        },
      })
    );

    expect(host.querySelector('[data-testid="approval-state"]')?.textContent).toContain('Approval stale');
    const gate = host.querySelector('[data-testid="render-gate"]')!;
    expect(gate.textContent).toContain('Rendering blocked for cloned audio');
    expect(gate.textContent).toContain('APPROVAL-STALE-IDENTITY');
    expect(gate.textContent).toContain('VOICE-AUDIO-060-TIMING-ALIGNMENT-PENDING');
  });

  it('surfaces a generation failure with its code and never shows a path', async () => {
    await renderPanel(
      state({
        assignments: [assigned()],
        preview: readyPreview({
          status: 'failed',
          durationSeconds: null,
          artifactAvailable: false,
          audioUrl: null,
          error: { code: 'CHATTERBOX_WORKER_EXIT_NONZERO', message: 'The worker exited with a non-zero status.' },
        }),
        clonedVoiceSelected: true,
      })
    );
    expect(host.querySelector('[data-testid="preview-status"]')?.textContent).toContain('Generation failed');
    expect(host.textContent).toContain('CHATTERBOX_WORKER_EXIT_NONZERO');
    expect(host.querySelector('[data-testid="preview-audio"]')).toBeNull();
    expect(host.textContent).not.toContain('/home/user');
    expect(host.textContent).not.toContain('data/projects');
  });
});
