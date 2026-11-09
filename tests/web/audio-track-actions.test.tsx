// @vitest-environment happy-dom
/**
 * DOM tests for the editor's ADD AUDIO and REPLACE SELECTED AUDIO controls.
 * `stage` is a TEST DOUBLE that records operations; it is not the editor's commit path.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AudioTrackActions } from '../../apps/web/src/components/editor/AudioTrackActions';
import type { AudioTrackRef, LibraryAudio } from '../../apps/web/src/lib/audio-track-ops';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const track: AudioTrackRef = { id: 'ac_full', sourceAssetId: 'old-audio', speakerId: 'instructor', startSec: 0, sourceInSec: 0, sourceOutSec: 10, gainDb: 0, locked: false, approved: true };
const library: LibraryAudio[] = [
  { id: 'old-audio', name: 'Old read', kind: 'sfx', mimeType: 'audio/wav', durationSec: 10, status: 'active' },
  { id: 'new-audio', name: 'New read', kind: 'sfx', mimeType: 'audio/wav', durationSec: 7.25, status: 'active' },
  { id: 'pic', name: 'Picture', kind: 'screenshot', mimeType: 'image/png', status: 'active' },
];

async function mount(props: Partial<React.ComponentProps<typeof AudioTrackActions>> = {}) {
  const stage = (props.stage as unknown as ReturnType<typeof vi.fn>) ?? vi.fn(() => [] as unknown[]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<AudioTrackActions audioClips={[track]} selectedAudioId="ac_full" library={library} stage={stage} disabled={false} {...props} />);
  });
  return { stage };
}
const q = <T extends Element = HTMLElement>(sel: string) => {
  const el = host!.querySelector(sel) as T | null;
  if (!el) throw new Error(`not found: ${sel}`);
  return el;
};
function setSelect(sel: string, value: string) {
  const el = q<HTMLSelectElement>(sel);
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function setInput(sel: string, value: string) {
  const el = q<HTMLInputElement>(sel);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ADD AUDIO and REPLACE SELECTED AUDIO are separate actions', () => {
  it('renders two distinct sections and never offers a picture as audio', async () => {
    await mount();
    expect(q('[data-testid="add-audio"] h4').textContent).toBe('ADD AUDIO');
    expect(q('[data-testid="replace-audio"] h4').textContent).toBe('REPLACE SELECTED AUDIO');
    const options = Array.from(q<HTMLSelectElement>('select[aria-label="Audio file to add"]').options).map((o) => o.textContent ?? '');
    expect(options.some((t) => t.includes('Picture'))).toBe(false);
  });

  it('ADD sends one insert operation and no update to the existing track', async () => {
    const { stage } = await mount();
    await act(async () => setSelect('select[aria-label="Audio file to add"]', 'new-audio'));
    await act(async () => q<HTMLButtonElement>('[data-testid="add-audio-submit"]').click());
    expect(stage).toHaveBeenCalledTimes(1);
    const ops = stage.mock.calls[0][0] as Array<{ type: string }>;
    expect(ops.map((o) => o.type)).toEqual(['insert']);
    expect(q('[data-testid="audio-track-actions"]').textContent).toMatch(/Added track aud_2/);
  });

  it('REPLACE stays disabled until this track is reviewed and its id is typed', async () => {
    const { stage } = await mount();
    await act(async () => setSelect('select[aria-label="Replacement audio file"]', 'new-audio'));
    const submit = () => q<HTMLButtonElement>('[data-testid="replace-audio-submit"]');
    expect(submit().disabled).toBe(true);
    await act(async () => q<HTMLInputElement>('[data-testid="replace-review"]').click());
    expect(submit().disabled).toBe(true);
    await act(async () => setInput('input[aria-label="Confirm track id"]', 'ac_wrong'));
    expect(submit().disabled).toBe(true);
    await act(async () => setInput('input[aria-label="Confirm track id"]', 'ac_full'));
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    expect(stage).toHaveBeenCalledTimes(1);
    const ops = stage.mock.calls[0][0] as Array<{ type: string; id?: string; changes?: Record<string, unknown> }>;
    expect(ops).toEqual([{ type: 'update', collection: 'audioClips', id: 'ac_full', changes: { sourceAssetId: 'new-audio', sourceInSec: 0, sourceOutSec: 7.25, approved: false } }]);
  });

  it('a refused replace leaves the form as it was and says the track is unchanged', async () => {
    const refusing = vi.fn(() => [{ code: 'FACTORY_SCENE_LOCKED' }] as unknown[]);
    const { stage } = await mount({ stage: refusing as never });
    expect(stage).toBe(refusing);
    await act(async () => setSelect('select[aria-label="Replacement audio file"]', 'new-audio'));
    await act(async () => q<HTMLInputElement>('[data-testid="replace-review"]').click());
    await act(async () => setInput('input[aria-label="Confirm track id"]', 'ac_full'));
    await act(async () => q<HTMLButtonElement>('[data-testid="replace-audio-submit"]').click());
    expect(stage).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="audio-track-actions"]').textContent).toMatch(/The track is unchanged/);
    expect(q<HTMLSelectElement>('select[aria-label="Replacement audio file"]').value).toBe('new-audio');
  });

  it('a locked track cannot be replaced: the file picker is disabled and no replace is offered', async () => {
    await mount({ audioClips: [{ ...track, locked: true }] });
    expect(q<HTMLSelectElement>('select[aria-label="Replacement audio file"]').disabled).toBe(true);
  });

  it('asks the user to select a track before replacing', async () => {
    await mount({ selectedAudioId: null });
    expect(q('[data-testid="replace-audio"]').textContent).toMatch(/Select an audio track first/);
  });
});
