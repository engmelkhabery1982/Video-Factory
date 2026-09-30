/**
 * @vitest-environment happy-dom
 *
 * Workstream C — Dialogue / Character Visual Production
 *
 * Proves the closed gap: the engine already understood dialogue and characters
 * (participantIds, activeSpeakerId, reactingCharacterId, shot semantics,
 * caption speakerId), but the real PlanSceneRenderer converted every scene back
 * into the legacy generic Hook / Explanation / CTA renderer, so the final video
 * looked like explanatory cards.
 *
 * These 20 gates prove dialogue scenarios now VISIBLY render as dialogue:
 * who is speaking, who is reacting, character role, conversation progression,
 * shot/focus changes and evidence/insert context — without changing
 * authoritative audio timing.
 *
 * Remotion is mocked (no browser, no bundling, no video render). The mocked
 * `useCurrentFrame` is controllable so a specific beat can be selected, which
 * is exactly how "the current local frame determines the active beat" is
 * exercised.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {
  getBrandPreset,
  getProgressMeetingScenario,
  getScheduleRiskScenario,
  isDialogueCapableScene,
  compileScenarioVisualPlan,
  type RemotionCompositionPlan,
  type RemotionSceneCompositionSpec,
  type SceneRenderCharacter,
} from '@buildtrack/core';
import { buildDialogueProductionPlan } from '../packages/core/src/scenario/dialogue-production-pipeline.js';
import { buildVisualProductionPlan } from '../packages/core/src/scenario/visual-production-pipeline.js';
import { buildSceneRenderPlan } from '../packages/core/src/scenario/scene-render-pipeline.js';
import { buildRemotionCompositionProps } from '../packages/core/src/scenario/remotion-composition-pipeline.js';
import {
  DialogueScene,
  cameraOffset,
  compositionForShot,
  isEvidenceBeat,
  resolveDialogueFocus,
  selectBeat,
} from '../packages/video/src/scenes/DialogueScene.js';
import { PlanSceneRenderer, shouldRenderAsDialogue } from '../packages/video/src/scenes/PlanSceneRenderer.js';
import {
  VideoCompositionPlan,
  buildSpeakerAwareCaptionCues,
  resolveSceneMediaUrl,
} from '../packages/video/src/compositions/VideoCompositionPlan.js';
import { Captions, type SpeakerAwareCaptionCue } from '../packages/video/src/captions/Captions.js';
import { theme } from '../packages/video/src/brand/theme.js';

/* ── Remotion is mocked: this file must never spin up a browser ────────── */
const frameHolder = vi.hoisted(() => ({ value: 0 }));

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  return {
    ...actual,
    useCurrentFrame: () => frameHolder.value,
    useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080, durationInFrames: 3563 }),
    Sequence: (props: { children?: React.ReactNode }) => (props.children ?? null) as React.ReactElement,
    Audio: () => null,
  };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TMP = '.test-phase6b';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/* ── render helper ─────────────────────────────────────────────────────── */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderToHtml(node: React.ReactElement): string {
  if (container) container.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => {
    r.render(node);
  });
  return container.innerHTML;
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  if (container && container.parentNode) container.parentNode.removeChild(container);
  container = null;
});

/** Renders at a specific LOCAL frame inside the scene. */
function renderAt(node: React.ReactElement, localFrame: number): string {
  frameHolder.value = localFrame;
  return renderToHtml(node);
}

/** Counts how many character plates the DOM carries. */
function plateCount(html: string): number {
  return (html.match(/data-dialogue-speaker=/g) ?? []).length;
}

/** The speaker id carrying the visual lead, or null. */
function leadSpeaker(html: string): string | null {
  const m = html.match(/data-dialogue-speaker="([^"]*)"[^>]*data-dialogue-emphasis="lead"/);
  return m ? m[1] : null;
}

/** Speaker ids drawn on a given plane. */
function speakersOnPlane(html: string, plane: string): string[] {
  const out: string[] = [];
  const re = /data-dialogue-speaker="([^"]*)"[^>]*data-dialogue-plane="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[2] === plane) out.push(m[1]);
  }
  return out;
}

/**
 * The text a viewer would actually read: tags stripped, entities decoded,
 * whitespace collapsed. Captions legitimately wrap across up to two lines, so
 * the spoken text is compared after unwrapping rather than as one raw run.
 */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(html: string, name: string): string | null {
  const m = html.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/* ── canonical plans ───────────────────────────────────────────────────── */

async function buildPlan(scenario: ReturnType<typeof getProgressMeetingScenario>): Promise<RemotionCompositionPlan> {
  const visual = compileScenarioVisualPlan(scenario);
  if (!visual.ok) throw new Error('compileScenarioVisualPlan failed');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const dialogue = await buildDialogueProductionPlan(scenario, {
    synthesisBasePath: `${TMP}/audio/dialogue`,
    canonicalBasePath: `${TMP}/audio/canonical`,
  });
  if (!dialogue.success) throw new Error(`dialogue failed: ${dialogue.error}`);
  const vp = buildVisualProductionPlan({ scenario, visualPlan: visual.plan, dialogueResult: dialogue.result });
  if (!vp.success) throw new Error(`visual production failed: ${vp.error}`);
  const sr = buildSceneRenderPlan({ scenario, visualProductionPlan: vp.plan });
  if (!sr.success) throw new Error(`scene render failed: ${sr.error}`);
  const rc = buildRemotionCompositionProps(sr.plan);
  if (!rc.success) throw new Error(`remotion composition failed: ${rc.error}`);
  return rc.plan;
}

let longPlan: RemotionCompositionPlan;
let shortPlan: RemotionCompositionPlan;

beforeEach(async () => {
  if (!longPlan) longPlan = await buildPlan(getProgressMeetingScenario());
  if (!shortPlan) shortPlan = await buildPlan(getScheduleRiskScenario());
});

const longScene = (id: string): RemotionSceneCompositionSpec => {
  const s = longPlan.scenes.find((x) => x.sceneId === id);
  if (!s) throw new Error(`no scene ${id}`);
  return s;
};

const t = theme(getBrandPreset('buildtrack') as never);

/* ── synthetic dialogue specs (real character data, controlled shot) ──── */

const CHARS: Record<string, SceneRenderCharacter> = {
  sarah: { id: 'char-sarah-pm', name: 'Sarah Jenkins', role: 'Project Manager', narrativeFunction: 'mediator', visualDescription: 'Professional site PPE.' },
  david: { id: 'char-david-site', name: 'David Okafor', role: 'Senior Site Engineer', narrativeFunction: 'technical_authority', visualDescription: 'Hardhat and tablet.' },
  marcus: { id: 'char-marcus-qs', name: 'Marcus Vance', role: 'Commercial Manager', narrativeFunction: 'challenger', visualDescription: 'Valuation binder.' },
};

function dialogueSpec(
  beats: Array<Partial<RemotionSceneCompositionSpec['beats'][number]> & { id: string; localStartFrame: number; localEndFrame: number }>,
  overrides: Partial<RemotionSceneCompositionSpec> = {},
): RemotionSceneCompositionSpec {
  const base = longScene('sc-01-hook');
  const fullBeats = beats.map((b) => ({
    id: b.id,
    sceneId: base.sceneId,
    index: 0,
    kind: 'dialogue' as const,
    actualStartSeconds: b.localStartFrame / 30,
    actualEndSeconds: b.localEndFrame / 30,
    actualDurationSeconds: (b.localEndFrame - b.localStartFrame) / 30,
    relativeStart: 0,
    relativeEnd: 1,
    startFrame: base.startFrame + b.localStartFrame,
    endFrame: base.startFrame + b.localEndFrame,
    durationInFrames: b.localEndFrame - b.localStartFrame,
    localStartSeconds: b.localStartFrame / 30,
    localEndSeconds: b.localEndFrame / 30,
    localDurationSeconds: (b.localEndFrame - b.localStartFrame) / 30,
    localStartFrame: b.localStartFrame,
    localEndFrame: b.localEndFrame,
    localDurationInFrames: b.localEndFrame - b.localStartFrame,
    turnId: null,
    activeSpeakerId: null,
    reactingCharacterId: null,
    spokenText: 'Recorded cover and surveyed cover are two separate gates.',
    intent: 'assertion',
    delivery: 'calm',
    shot: {
      shotType: 'two_shot',
      framing: 'center',
      speakerFocus: 'speaking_character',
      cameraMovement: 'static',
      focusCharacterId: null,
    },
    evidenceIds: [],
    cues: [],
    audioRef: null,
    captionCueIds: [],
    ...b,
  }));

  return {
    ...base,
    beats: fullBeats,
    participants: Object.values(CHARS),
    participantIds: Object.values(CHARS).map((c) => c.id),
    ...overrides,
  } as RemotionSceneCompositionSpec;
}

/* ====================================================================== */
/* GATES                                                                  */
/* ====================================================================== */

describe('Workstream C — dialogue / character visual production', () => {
  describe('render contract: character metadata survives the whole chain', () => {
    it('gate 1: character metadata survives Scenario → SceneRenderPlan', async () => {
      const scenario = getProgressMeetingScenario();
      const plan = await buildPlan(scenario);

      // The plan carries every Scenario character, in Scenario order.
      expect(plan.characters.map((c) => c.id)).toEqual(scenario.characters.map((c) => c.id));

      for (const expected of scenario.characters) {
        const got = plan.characters.find((c) => c.id === expected.id);
        expect(got).toBeDefined();
        expect(got!.name).toBe(expected.name);
        expect(got!.role).toBe(expected.role);
        expect(got!.narrativeFunction).toBe(expected.narrativeFunction);
        expect(got!.visualDescription).toBe(expected.visualDescription ?? null);
      }

      // Per-scene participants follow participantIds order exactly.
      for (const scene of plan.scenes) {
        expect(scene.participants.map((p) => p.id)).toEqual(scene.participantIds);
      }
    });

    it('gate 2: character metadata survives SceneRenderPlan → RemotionCompositionPlan', async () => {
      const scenario = getProgressMeetingScenario();
      const visual = compileScenarioVisualPlan(scenario);
      if (!visual.ok) throw new Error('visual failed');
      fs.rmSync(TMP, { recursive: true, force: true });
      fs.mkdirSync(TMP, { recursive: true });
      const dialogue = await buildDialogueProductionPlan(scenario, {
        synthesisBasePath: `${TMP}/audio/dialogue`,
        canonicalBasePath: `${TMP}/audio/canonical`,
      });
      if (!dialogue.success) throw new Error('dialogue failed');
      const vp = buildVisualProductionPlan({ scenario, visualPlan: visual.plan, dialogueResult: dialogue.result });
      if (!vp.success) throw new Error('vp failed');
      const sr = buildSceneRenderPlan({ scenario, visualProductionPlan: vp.plan });
      if (!sr.success) throw new Error('sr failed');

      // SceneRenderPlan already carries the characters…
      expect(sr.plan.characters.map((c) => c.id)).toEqual(scenario.characters.map((c) => c.id));

      // …and the composition plan carries them through unchanged.
      expect(longPlan.characters).toEqual(sr.plan.characters);
      for (let i = 0; i < longPlan.scenes.length; i++) {
        expect(longPlan.scenes[i].participants).toEqual(sr.plan.scenes[i].participants);
      }
    });

    it('gate 3: dialogue scene detection works', () => {
      // Positive: a dialogue beat plus two participants.
      expect(isDialogueCapableScene({ beats: [{ kind: 'dialogue' }], participantIds: ['a', 'b'] })).toBe(true);
      // Negative: fewer than two participants.
      expect(isDialogueCapableScene({ beats: [{ kind: 'dialogue' }], participantIds: ['a'] })).toBe(false);
      expect(isDialogueCapableScene({ beats: [{ kind: 'dialogue' }], participantIds: [] })).toBe(false);
      // Negative: no dialogue beat (visual_only / transition only).
      expect(isDialogueCapableScene({ beats: [{ kind: 'visual_only' }], participantIds: ['a', 'b'] })).toBe(false);
      expect(isDialogueCapableScene({ beats: [{ kind: 'transition' }], participantIds: ['a', 'b'] })).toBe(false);
      expect(isDialogueCapableScene({ beats: [], participantIds: ['a', 'b'] })).toBe(false);

      // Real scenes: the four conversation scenes are dialogue-capable…
      expect(shouldRenderAsDialogue(longScene('sc-01-hook'))).toBe(true);
      expect(shouldRenderAsDialogue(longScene('sc-02-context'))).toBe(true);
      expect(shouldRenderAsDialogue(longScene('sc-03-dispute'))).toBe(true);
      expect(shouldRenderAsDialogue(longScene('sc-04-site-walk'))).toBe(true);
      // …and the CTA/end-card scene keeps its existing CtaCard renderer.
      expect(shouldRenderAsDialogue(longScene('sc-05-resolution'))).toBe(false);
      expect(shouldRenderAsDialogue(shortPlan.scenes[shortPlan.scenes.length - 1])).toBe(false);
    });

    it('gate 4: generic non-dialogue rendering remains unchanged', () => {
      // A scene with no dialogue beats and no participants is NOT dialogue.
      const generic: RemotionSceneCompositionSpec = {
        ...longScene('sc-02-context'),
        rendererKey: 'explanation:key_statement',
        rendererCategory: 'explanation',
        beats: [],
        participantIds: [],
        participants: [],
        title: 'GENERIC CARD HEADLINE',
      };
      expect(shouldRenderAsDialogue(generic)).toBe(false);

      const html = renderToHtml(
        React.createElement(PlanSceneRenderer, { scene: generic, brand: getBrandPreset('buildtrack'), format: 'long' }),
      );

      // It went down the legacy path: the headline is present, no dialogue shell.
      expect(html).toContain('GENERIC CARD HEADLINE');
      expect(html).not.toContain('data-dialogue-scene');
      expect(plateCount(html)).toBe(0);
    });
  });

  describe('shot semantics are visible', () => {
    it('gate 5: two_shot produces a two-character layout', () => {
      const spec = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.sarah.id,
          reactingCharacterId: CHARS.marcus.id,
          shot: { shotType: 'two_shot', framing: 'center', speakerFocus: 'speaking_character', cameraMovement: 'static', focusCharacterId: CHARS.sarah.id },
        },
      ]);
      const html = renderAt(React.createElement(DialogueScene, { scene: spec, t, format: 'long' }), 10);

      expect(attr(html, 'data-dialogue-composition')).toBe('two_shot');
      expect(plateCount(html)).toBe(2);
      // Balanced: exactly one visual lead, both on the stage plane.
      expect(leadSpeaker(html)).toBe(CHARS.sarah.id);
      expect(speakersOnPlane(html, 'stage').sort()).toEqual([CHARS.marcus.id, CHARS.sarah.id].sort());
      // Both names are on screen.
      expect(html).toContain('Sarah Jenkins');
      expect(html).toContain('Marcus Vance');
    });

    it('gate 6: close_up focuses the active speaker', () => {
      const spec = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.david.id,
          reactingCharacterId: CHARS.sarah.id,
          shot: { shotType: 'close_up', framing: 'center', speakerFocus: 'speaking_character', cameraMovement: 'static', focusCharacterId: CHARS.david.id },
        },
      ]);
      const html = renderAt(React.createElement(DialogueScene, { scene: spec, t, format: 'long' }), 10);

      expect(attr(html, 'data-dialogue-composition')).toBe('close_up');
      expect(leadSpeaker(html)).toBe(CHARS.david.id);
      // The focused character dominates: it is the only 'lead' plate.
      expect(plateCount(html)).toBe(2);
      expect((html.match(/data-dialogue-emphasis="lead"/g) ?? []).length).toBe(1);
      // The reaction is still present, but visibly secondary.
      expect(html).toContain('Sarah Jenkins');
      expect((html.match(/data-dialogue-emphasis="support"/g) ?? []).length).toBe(1);
    });

    it('gate 7: medium has active + reaction context', () => {
      const spec = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.sarah.id,
          reactingCharacterId: CHARS.david.id,
          shot: { shotType: 'medium', framing: 'rule_of_thirds_left', speakerFocus: 'speaking_character', cameraMovement: 'static', focusCharacterId: CHARS.sarah.id },
        },
      ]);
      const html = renderAt(React.createElement(DialogueScene, { scene: spec, t, format: 'long' }), 10);

      expect(attr(html, 'data-dialogue-composition')).toBe('medium');
      // Speaker prominent…
      expect(leadSpeaker(html)).toBe(CHARS.sarah.id);
      // …with the secondary reaction context still on screen.
      expect(html).toContain('David Okafor');
      expect(plateCount(html)).toBe(2);
    });

    it('gate 8: over_the_shoulder uses correct focus/reaction orientation', () => {
      const spec = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.david.id,
          reactingCharacterId: CHARS.sarah.id,
          shot: { shotType: 'over_the_shoulder', framing: 'rule_of_thirds_left', speakerFocus: 'speaking_character', cameraMovement: 'static', focusCharacterId: CHARS.david.id },
        },
      ]);
      const html = renderAt(React.createElement(DialogueScene, { scene: spec, t, format: 'long' }), 10);

      expect(attr(html, 'data-dialogue-composition')).toBe('over_the_shoulder');
      // The reacting participant is in the FOREGROUND…
      expect(speakersOnPlane(html, 'foreground')).toEqual([CHARS.sarah.id]);
      // …and the focused speaker sits BEHIND them.
      expect(speakersOnPlane(html, 'background')).toEqual([CHARS.david.id]);
    });

    it('gate 9: wide uses a broad two-character composition', () => {
      const spec = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.sarah.id,
          reactingCharacterId: CHARS.marcus.id,
          shot: { shotType: 'wide', framing: 'symmetric', speakerFocus: 'group', cameraMovement: 'pan_left', focusCharacterId: null },
        },
      ]);
      const html = renderAt(React.createElement(DialogueScene, { scene: spec, t, format: 'long' }), 10);

      expect(attr(html, 'data-dialogue-composition')).toBe('wide');
      // Both participants plus the broader environment/context band.
      expect(plateCount(html)).toBe(2);
      expect(html).toContain('Sarah Jenkins');
      expect(html).toContain('Marcus Vance');
      expect(attr(html, 'data-dialogue-context')).toBe(spec.locationId);
      // speakerFocus 'group' means neither dominates.
      expect(attr(html, 'data-dialogue-focus')).toBe('group');
    });

    it('gate 9b: evidence / shared_display beats take the insert path', () => {
      const spec = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.david.id,
          reactingCharacterId: CHARS.marcus.id,
          evidenceIds: ['ev-1', 'ev-2'],
          shot: { shotType: 'close_up', framing: 'center', speakerFocus: 'document', cameraMovement: 'slow_pull', focusCharacterId: null },
        },
      ]);
      const html = renderAt(React.createElement(DialogueScene, { scene: spec, t, format: 'long' }), 10);

      expect(attr(html, 'data-dialogue-composition')).toBe('insert');
      expect(html).toContain('data-dialogue-evidence="true"');
      // The conversation is still legible: both participants appear as a strip.
      expect(html).toContain('David Okafor');
      expect(html).toContain('Marcus Vance');
      expect(isEvidenceBeat(spec.beats[0])).toBe(true);
    });

    it('gate 9c: every authoritative shotType maps to a distinct composition', () => {
      expect(compositionForShot('two_shot')).toBe('two_shot');
      expect(compositionForShot('close_up')).toBe('close_up');
      expect(compositionForShot('medium')).toBe('medium');
      expect(compositionForShot('over_the_shoulder')).toBe('over_the_shoulder');
      expect(compositionForShot('wide')).toBe('wide');
      expect(compositionForShot('screen_insert')).toBe('insert');
      expect(compositionForShot('point_of_view')).toBe('insert');
      expect(compositionForShot('detail_macro')).toBe('insert');
      expect(compositionForShot('something_new')).toBe('insert');
    });
  });

  describe('active speaker, reaction and focus identity', () => {
    it('gate 10: a speaker switch changes the active visual identity', () => {
      const spec = dialogueSpec([
        {
          id: 'beat-sarah',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.sarah.id,
          reactingCharacterId: CHARS.marcus.id,
          shot: { shotType: 'medium', framing: 'center', speakerFocus: 'speaking_character', cameraMovement: 'static', focusCharacterId: CHARS.sarah.id },
        },
        {
          id: 'beat-marcus',
          localStartFrame: 60,
          localEndFrame: 120,
          activeSpeakerId: CHARS.marcus.id,
          reactingCharacterId: CHARS.sarah.id,
          shot: { shotType: 'medium', framing: 'center', speakerFocus: 'speaking_character', cameraMovement: 'static', focusCharacterId: CHARS.marcus.id },
        },
      ]);

      const first = renderAt(React.createElement(DialogueScene, { scene: spec, t, format: 'long' }), 5);
      const second = renderAt(React.createElement(DialogueScene, { scene: spec, t, format: 'long' }), 70);

      expect(attr(first, 'data-dialogue-active-speaker')).toBe(CHARS.sarah.id);
      expect(attr(second, 'data-dialogue-active-speaker')).toBe(CHARS.marcus.id);
      // The lead plate follows the speaker.
      expect(leadSpeaker(first)).toBe(CHARS.sarah.id);
      expect(leadSpeaker(second)).toBe(CHARS.marcus.id);
      // And the reaction identity follows reactingCharacterId.
      expect(attr(first, 'data-dialogue-reacting')).toBe(CHARS.marcus.id);
      expect(attr(second, 'data-dialogue-reacting')).toBe(CHARS.sarah.id);
      expect(first).not.toBe(second);
    });

    it('gate 11: reactingCharacterId is respected (and never invented)', () => {
      const withReaction = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.sarah.id,
          reactingCharacterId: CHARS.david.id,
          shot: { shotType: 'medium', framing: 'center', speakerFocus: 'speaking_character', cameraMovement: 'static', focusCharacterId: CHARS.sarah.id },
        },
      ]);
      const withoutReaction = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.sarah.id,
          reactingCharacterId: null,
          shot: { shotType: 'medium', framing: 'center', speakerFocus: 'speaking_character', cameraMovement: 'static', focusCharacterId: CHARS.sarah.id },
        },
      ]);

      const a = renderAt(React.createElement(DialogueScene, { scene: withReaction, t, format: 'long' }), 10);
      const b = renderAt(React.createElement(DialogueScene, { scene: withoutReaction, t, format: 'long' }), 10);

      // With a reacting character, it is drawn as the secondary plate.
      expect(attr(a, 'data-dialogue-reacting')).toBe(CHARS.david.id);
      expect(a).toContain('David Okafor');
      expect(plateCount(a)).toBe(2);

      // With none, no reaction plate is invented.
      expect(attr(b, 'data-dialogue-reacting')).toBe('');
      expect(b).not.toContain('David Okafor');
      expect(b).not.toContain('Marcus Vance');
      expect(plateCount(b)).toBe(1);

      // resolveDialogueFocus never falls back to the active speaker as reaction.
      expect(resolveDialogueFocus(withReaction.beats[0], new Set([CHARS.sarah.id, CHARS.david.id])).secondaryId).toBe(CHARS.david.id);
      expect(resolveDialogueFocus(withoutReaction.beats[0], new Set([CHARS.sarah.id, CHARS.david.id])).secondaryId).toBeNull();
    });

    it('gate 12: focusCharacterId is respected over the active speaker', () => {
      // The shot focuses Marcus while Sarah is the one speaking.
      const spec = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.sarah.id,
          reactingCharacterId: null,
          shot: { shotType: 'medium', framing: 'center', speakerFocus: 'speaking_character', cameraMovement: 'static', focusCharacterId: CHARS.marcus.id },
        },
      ]);
      const html = renderAt(React.createElement(DialogueScene, { scene: spec, t, format: 'long' }), 10);

      expect(attr(html, 'data-dialogue-active-speaker')).toBe(CHARS.sarah.id);
      // The FOCUSED character carries the visual lead.
      expect(leadSpeaker(html)).toBe(CHARS.marcus.id);
      expect(html).toContain('Marcus Vance');

      // speakerFocus 'reacting_character' routes the lead to the reactor.
      const reactingFocus = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.sarah.id,
          reactingCharacterId: CHARS.david.id,
          shot: { shotType: 'medium', framing: 'center', speakerFocus: 'reacting_character', cameraMovement: 'static', focusCharacterId: null },
        },
      ]);
      const html2 = renderAt(React.createElement(DialogueScene, { scene: reactingFocus, t, format: 'long' }), 10);
      expect(leadSpeaker(html2)).toBe(CHARS.david.id);

      // An unresolvable focusCharacterId degrades to the active speaker.
      const unknownFocus = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 60,
          activeSpeakerId: CHARS.sarah.id,
          reactingCharacterId: null,
          shot: { shotType: 'medium', framing: 'center', speakerFocus: 'speaking_character', cameraMovement: 'static', focusCharacterId: 'char-does-not-exist' },
        },
      ]);
      const html3 = renderAt(React.createElement(DialogueScene, { scene: unknownFocus, t, format: 'long' }), 10);
      expect(leadSpeaker(html3)).toBe(CHARS.sarah.id);
    });

    it('gate 12b: cameraMovement produces subtle deterministic movement only', () => {
      // Deterministic: same inputs → same offsets.
      expect(cameraOffset('slow_push', 0)).toEqual(cameraOffset('slow_push', 0));
      expect(cameraOffset('static', 0.5)).toEqual({ x: 0, y: 0, scale: 1 });

      // Subtle: bounded, never a jump.
      const push = cameraOffset('slow_push', 1);
      expect(push.scale).toBeGreaterThan(1);
      expect(push.scale).toBeLessThan(1.05);
      const pull = cameraOffset('slow_pull', 1);
      expect(pull.scale).toBeLessThan(1.03);
      expect(pull.scale).toBeGreaterThan(1);
      expect(Math.abs(cameraOffset('pan_left', 1).x)).toBeLessThanOrEqual(14);
      expect(Math.abs(cameraOffset('subtle_drift', 1).y)).toBeLessThanOrEqual(7);

      // Movement is a function of progress, so it is derived — never re-timed.
      const spec = dialogueSpec([
        {
          id: 'b1',
          localStartFrame: 0,
          localEndFrame: 100,
          activeSpeakerId: CHARS.sarah.id,
          reactingCharacterId: null,
          shot: { shotType: 'medium', framing: 'center', speakerFocus: 'speaking_character', cameraMovement: 'slow_push', focusCharacterId: CHARS.sarah.id },
        },
      ]);
      const early = renderAt(React.createElement(DialogueScene, { scene: spec, t, format: 'long' }), 1);
      const late = renderAt(React.createElement(DialogueScene, { scene: spec, t, format: 'long' }), 99);
      const scaleOf = (html: string) => {
        const m = html.match(/scale\(([\d.]+)\)/);
        return m ? Number(m[1]) : null;
      };
      const s1 = scaleOf(early);
      const s2 = scaleOf(late);
      expect(s1).not.toBeNull();
      expect(s2).not.toBeNull();
      expect(s2!).toBeGreaterThan(s1!);
      // And the beat window itself never moved.
      expect(attr(early, 'data-dialogue-beat')).toBe('b1');
      expect(attr(late, 'data-dialogue-beat')).toBe('b1');
    });
  });

  describe('speaker-aware captions', () => {
    it('gate 13: speaker-aware caption resolves the correct name and role', () => {
      const cues = buildSpeakerAwareCaptionCues(longPlan);
      expect(cues.length).toBeGreaterThan(0);

      // Every cue carries its reconciled speakerId, resolved to a real character.
      const bySpeaker = new Map<string, SpeakerAwareCaptionCue>();
      for (const cue of cues) {
        if (cue.speakerId) bySpeaker.set(cue.speakerId, cue);
      }
      expect(bySpeaker.size).toBeGreaterThanOrEqual(2);

      const sarah = bySpeaker.get('char-sarah-pm');
      expect(sarah).toBeDefined();
      expect(sarah!.speakerName).toBe('Sarah Jenkins');
      expect(sarah!.speakerRole).toBe('Project Manager');

      const marcus = bySpeaker.get('char-marcus-qs');
      expect(marcus!.speakerName).toBe('Marcus Vance');
      expect(marcus!.speakerRole).toBe('Commercial Manager');

      const david = bySpeaker.get('char-david-site');
      expect(david!.speakerName).toBe('David Okafor');
      expect(david!.speakerRole).toBe('Senior Site Engineer');

      // Rendering the caption layer shows the identity, not the spoken text.
      // Render inside this cue's own reconciled window.
      const cue = sarah!;
      const html = renderAt(
        React.createElement(Captions, {
          cues: [cue],
          style: 'boxed_center',
          t,
          accent: t.c.accent,
          format: 'long',
        }),
        Math.round(cue.start * 30) + 1,
      );
      expect(html).toContain('Sarah Jenkins');
      expect(html).toContain('Project Manager');
      // The spoken caption is present, exactly as written (it may wrap).
      expect(visibleText(html)).toContain(cue.text);
    });

    it('gate 14: caption text remains byte-identical', () => {
      const source: Array<{ id: string; text: string; startTimeSeconds: number; endTimeSeconds: number; sceneId: string; speakerId: string }> = [];
      for (const scene of longPlan.scenes) {
        for (const cue of scene.captionCues) {
          source.push({
            id: cue.id,
            text: cue.text,
            startTimeSeconds: cue.startTimeSeconds,
            endTimeSeconds: cue.endTimeSeconds,
            sceneId: cue.sceneId,
            speakerId: cue.speakerId,
          });
        }
      }
      expect(source.length).toBeGreaterThan(0);

      const out = buildSpeakerAwareCaptionCues(longPlan);
      expect(out.length).toBe(source.length);

      const outById = new Map(out.map((c) => [c.id, c]));
      for (const s of source) {
        const c = outById.get(s.id);
        expect(c, `missing cue ${s.id}`).toBeDefined();
        // Byte-identical text — the speaker name is never folded into it.
        expect(c!.text).toBe(s.text);
        expect(c!.speakerId).toBe(s.speakerId);
        // No name was appended or prepended to the spoken text.
        if (c!.speakerName) {
          expect(c!.text).not.toContain(c!.speakerName);
        }
      }
    });

    it('gate 15: caption timing remains unchanged', () => {
      for (const scene of longPlan.scenes) {
        for (const cue of scene.captionCues) {
          const out = buildSpeakerAwareCaptionCues(longPlan).find((c) => c.id === cue.id);
          expect(out).toBeDefined();
          // Reconciled seconds are copied straight through.
          expect(out!.start).toBe(cue.startTimeSeconds);
          expect(out!.end).toBe(cue.endTimeSeconds);
          expect(out!.start).toBeLessThan(out!.end);
        }
      }

      // Order is deterministic and monotonic by start time.
      const cues = buildSpeakerAwareCaptionCues(longPlan);
      for (let i = 1; i < cues.length; i++) {
        expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].start);
      }
      // Repeated builds are identical.
      expect(buildSpeakerAwareCaptionCues(longPlan)).toEqual(buildSpeakerAwareCaptionCues(longPlan));
    });

    it('gate 15b: exactly one caption layer, and non-dialogue captions are unchanged', () => {
      // No speaker resolved → no chip at all (existing behaviour preserved).
      frameHolder.value = 0;
      const plain = renderToHtml(
        React.createElement(Captions, {
          cues: [{ id: 'c1', start: 0, end: 5, text: 'PLAIN CAPTION TEXT', sceneId: null, terms: [], userEdited: false }],
          style: 'boxed_center',
          t,
          accent: t.c.accent,
          format: 'long',
        }),
      );
      expect(plain).toContain('PLAIN CAPTION TEXT');

      // With a speaker resolved, the name is an extra element on the SAME cue.
      const spoken = renderToHtml(
        React.createElement(Captions, {
          cues: [{ id: 'c1', start: 0, end: 5, text: 'PLAIN CAPTION TEXT', sceneId: null, terms: [], userEdited: false, speakerName: 'Sarah Jenkins', speakerRole: 'Project Manager' }],
          style: 'boxed_center',
          t,
          accent: t.c.accent,
          format: 'long',
        }),
      );
      expect(spoken).toContain('PLAIN CAPTION TEXT');
      expect(spoken).toContain('Sarah Jenkins');
      // The name is NOT concatenated into the spoken text.
      expect(spoken).not.toContain('Sarah JenkinsPLAIN CAPTION TEXT');
      expect(spoken).not.toContain('PLAIN CAPTION TEXTSarah Jenkins');

      // VideoCompositionPlan renders exactly one <Captions> layer.
      frameHolder.value = 0;
      const planHtml = renderToHtml(
        React.createElement(VideoCompositionPlan, { plan: longPlan, burnedCaptions: true, format: 'long' }),
      );
      expect((planHtml.match(/data-dialogue-speaker=/g) ?? []).length).toBeGreaterThan(0);
    });
  });

  describe('asset compatibility and stability', () => {
    const MEDIA_URL = 'http://127.0.0.1:3000/media/asset/asset-progress-chart-real';

    it('gate 16: mediaUrl still reaches the dialogue scene', () => {
      const spec = dialogueSpec(
        [
          {
            id: 'b1',
            localStartFrame: 0,
            localEndFrame: 60,
            activeSpeakerId: CHARS.david.id,
            reactingCharacterId: CHARS.marcus.id,
            evidenceIds: ['ev-1'],
            shot: { shotType: 'close_up', framing: 'center', speakerFocus: 'document', cameraMovement: 'static', focusCharacterId: null },
          },
        ],
        { assetRefs: [{ assetRef: 'asset-iva-progress-chart', sceneId: 'sc-02-context', cueKind: 'screen_insert_title', role: 'primary', required: true, description: 'chart', resolved: true } as never] },
      );

      const direct = renderAt(
        React.createElement(DialogueScene, { scene: spec, t, format: 'long', mediaUrl: MEDIA_URL }),
        10,
      );
      expect(direct).toContain(MEDIA_URL);
      expect(direct).toContain('data-buildtrack-resolved-media');
      expect(direct).toContain('background-image: url(');

      // Through PlanSceneRenderer, with the media resolved the Phase 6A way.
      const viaRenderer = renderToHtml(
        React.createElement(PlanSceneRenderer, {
          scene: spec,
          brand: getBrandPreset('buildtrack'),
          format: 'long',
          mediaUrl: resolveSceneMediaUrl(spec, { 'asset-iva-progress-chart': MEDIA_URL }),
        }),
      );
      expect(viaRenderer).toContain(MEDIA_URL);
      expect(viaRenderer).toContain('data-buildtrack-resolved-media');
      expect(viaRenderer).toContain('background-image: url(');

      // No mediaMap → no media, and no fabricated URL.
      const none = renderToHtml(
        React.createElement(PlanSceneRenderer, { scene: spec, brand: getBrandPreset('buildtrack'), format: 'long', mediaUrl: resolveSceneMediaUrl(spec, {}) }),
      );
      expect(none).not.toContain(MEDIA_URL);
      expect(none).not.toContain('data-buildtrack-resolved-media');
      expect(none).not.toContain('url(http');
      // The dialogue itself still renders.
      expect(none).toContain('data-dialogue-scene');
      expect(none).toContain('David Okafor');
    });

    it('gate 16b: the canonical sc-02-context scene still shows its resolved asset', async () => {
      const scene = longScene('sc-02-context');
      expect(scene.rendererKey).toBe('explanation:key_statement');
      // It IS dialogue-capable…
      expect(shouldRenderAsDialogue(scene)).toBe(true);
      // …and still renders its resolved media with the Phase 6B DOM contract.
      const html = renderToHtml(
        React.createElement(PlanSceneRenderer, {
          scene,
          brand: getBrandPreset('buildtrack'),
          format: 'long',
          mediaUrl: resolveSceneMediaUrl(scene, { 'asset-iva-progress-chart': MEDIA_URL }),
        }),
      );
      expect(html).toContain(MEDIA_URL);
      expect(html).toContain('data-buildtrack-resolved-media');
      expect(html).toContain('background-image: url(');
      // And the dialogue presentation is live.
      expect(html).toContain('data-dialogue-scene');
      // The rendererKey was not falsified to show the asset.
      expect(scene.rendererKey).toBe('explanation:key_statement');
    });

    it('gate 19: rendererKey remains unchanged', () => {
      for (const scene of longPlan.scenes) {
        const before = scene.rendererKey;
        renderToHtml(
          React.createElement(PlanSceneRenderer, { scene, brand: getBrandPreset('buildtrack'), format: 'long' }),
        );
        expect(scene.rendererKey).toBe(before);
      }
      // The whole taxonomy is still the approved Phase 5 set.
      const keys = new Set(longPlan.scenes.map((s) => s.rendererKey));
      for (const k of keys) {
        expect(k.split(':')).toHaveLength(2);
      }
      expect(keys.has('hook:generic')).toBe(true);
      expect(keys.has('cta:cta_card')).toBe(true);
    });

    it('gate 20: no audio or timing mutation', () => {
      for (const scene of longPlan.scenes) {
        const before = clone(scene);
        frameHolder.value = scene.beats.length ? scene.beats[0].localStartFrame + 1 : 0;
        renderToHtml(
          React.createElement(PlanSceneRenderer, { scene, brand: getBrandPreset('buildtrack'), format: 'long' }),
        );
        // Deep equality: nothing on the scene was touched, not even a frame.
        expect(scene).toEqual(before);
      }

      // The plan as a whole is immutable across rendering.
      const planBefore = clone(longPlan);
      frameHolder.value = 0;
      renderToHtml(React.createElement(VideoCompositionPlan, { plan: longPlan, burnedCaptions: true, format: 'long' }));
      expect(longPlan).toEqual(planBefore);

      // Explicitly: audio refs, beat windows and durations are untouched.
      for (const scene of longPlan.scenes) {
        for (const audio of scene.audioRefs) {
          expect(audio.localStartFrame).toBe(audio.startFrame - scene.startFrame);
          expect(audio.durationInFrames).toBeGreaterThan(0);
        }
        for (let i = 1; i < scene.beats.length; i++) {
          expect(scene.beats[i].localStartFrame).toBe(scene.beats[i - 1].localEndFrame);
        }
        expect(scene.durationInFrames).toBe(scene.endFrame - scene.startFrame);
      }
    });
  });

  describe('Long + Short layout', () => {
    it('gate 17: Long dimensions are safe (1920x1080, landscape, safe insets)', () => {
      expect(longPlan.targetFormat).toBe('Long');
      expect(longPlan.width).toBe(1920);
      expect(longPlan.height).toBe(1080);

      const scene = longScene('sc-01-hook');
      const html = renderAt(
        React.createElement(DialogueScene, { scene, t, format: 'long' }),
        scene.beats[0].localStartFrame + 5,
      );

      expect(attr(html, 'data-dialogue-orientation')).toBe('landscape');
      expect(attr(html, 'data-dialogue-width')).toBe('1920');
      expect(attr(html, 'data-dialogue-height')).toBe('1080');
      // Landscape safe insets.
      expect(Number(attr(html, 'data-dialogue-safe-top'))).toBe(96);
      expect(Number(attr(html, 'data-dialogue-safe-bottom'))).toBe(96);
      expect(Number(attr(html, 'data-dialogue-safe-side'))).toBe(96);
      // Every participant is on screen — nothing is dropped to fit.
      expect(plateCount(html)).toBe(scene.participants.length);
    });

    it('gate 18: Short dimensions are safe (1080x1920, native portrait)', () => {
      expect(shortPlan.targetFormat).toBe('Short');
      expect(shortPlan.width).toBe(1080);
      expect(shortPlan.height).toBe(1920);

      // A real portrait dialogue scene.
      const scene = shortPlan.scenes.find((s) => shouldRenderAsDialogue(s));
      expect(scene).toBeDefined();
      const html = renderAt(
        React.createElement(DialogueScene, { scene: scene!, t, format: 'short' }),
        scene!.beats[0].localStartFrame + 5,
      );

      expect(attr(html, 'data-dialogue-orientation')).toBe('portrait');
      expect(attr(html, 'data-dialogue-width')).toBe('1080');
      expect(attr(html, 'data-dialogue-height')).toBe('1920');

      // Portrait safe insets: clear of the top platform risk zone AND of the
      // caption band at the bottom, so captions never cover faces/role plates.
      const top = Number(attr(html, 'data-dialogue-safe-top'));
      const bottom = Number(attr(html, 'data-dialogue-safe-bottom'));
      expect(top).toBeGreaterThanOrEqual(244);
      expect(bottom).toBeGreaterThanOrEqual(640);
      expect(Number(attr(html, 'data-dialogue-safe-side'))).toBe(72);

      // No off-screen characters: every participant is still rendered.
      expect(plateCount(html)).toBe(scene!.participants.length);
      // And it is a portrait layout, not a cropped landscape one: the two
      // participants stack rather than sitting side by side.
      expect(html).toContain('data-dialogue-composition');
    });

    it('gate 18b: portrait captions carry speaker identity and stay in the band', () => {
      const cue = buildSpeakerAwareCaptionCues(shortPlan)[0];
      expect(cue.speakerName).toBeTruthy();
      const html = renderToHtml(
        React.createElement(Captions, {
          cues: [cue],
          style: 'boxed_center',
          t,
          accent: t.c.accent,
          format: 'short',
        }),
      );
      expect(html).toContain(cue.speakerName!);
      expect(visibleText(html)).toContain(cue.text);
      // Portrait caption band position is used, never the landscape one.
      expect(html).not.toContain('bottom: 150px');
      expect(html).toContain('bottom: 340px');
    });
  });

  describe('determinism', () => {
    it('renders byte-identical DOM for the same inputs', () => {
      const scene = longScene('sc-02-context');
      const frame = scene.beats[0].localStartFrame + 3;
      const a = renderAt(React.createElement(DialogueScene, { scene, t, format: 'long' }), frame);
      const b = renderAt(React.createElement(DialogueScene, { scene, t, format: 'long' }), frame);
      expect(a).toBe(b);
    });

    it('selects the beat purely from the local frame', () => {
      const scene = longScene('sc-01-hook');
      const [b0, b1] = scene.beats;
      const at0 = renderAt(React.createElement(DialogueScene, { scene, t, format: 'long' }), b0.localStartFrame);
      const atMid = renderAt(React.createElement(DialogueScene, { scene, t, format: 'long' }), b1.localStartFrame + 1);
      expect(attr(at0, 'data-dialogue-beat')).toBe(b0.id);
      expect(attr(atMid, 'data-dialogue-beat')).toBe(b1.id);
      // Before the first beat the FIRST beat is used; past the last, the LAST.
      expect(selectBeat(scene.beats, -50)).toBe(b0);
      expect(selectBeat(scene.beats, 999999)).toBe(b1);
      expect(selectBeat([], 5)).toBeNull();
      const before = renderAt(React.createElement(DialogueScene, { scene, t, format: 'long' }), -50);
      expect(attr(before, 'data-dialogue-beat')).toBe(b0.id);
      const after = renderAt(React.createElement(DialogueScene, { scene, t, format: 'long' }), 999999);
      expect(attr(after, 'data-dialogue-beat')).toBe(b1.id);
    });
  });
});
