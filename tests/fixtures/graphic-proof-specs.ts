/**
 * Synthetic proof fixtures for procedural graphics. Labelled FIXTURE: the values, words and layout are invented for
 * the proof and are not owner content. Nothing here is a quotation, a supplied recording, or a generated image.
 *
 * Each builder returns the scene list for one proof and one orientation. Both orientations are authored separately
 * (no stretching): portrait uses its own coordinates and at most four labelled items.
 */
import type { EditorGraphic } from '../../packages/core/src/editor/graphics.js';

export type ProofFormat = 'landscape' | 'portrait';

export type ProofScene =
  | { kind: 'graphic'; id: string; durationSec: number; graphic: EditorGraphic }
  | { kind: 'still'; id: string; durationSec: number; illustration: 'closed_book_and_lamp' };

export const PROOF_FPS = 30;

/** P1: numeric comparison with exact supplied values (FIXTURE: booked 7.0 h, arrived 9.5 h). */
export function proofNumeric(format: ProofFormat): EditorGraphic {
  const portrait = format === 'portrait';
  const [xa, xb, y] = portrait ? [0.3, 0.7, 0.72] : [0.36, 0.64, 0.82];
  return {
    schemaVersion: 1,
    kind: 'numeric_comparison',
    title: 'FIXTURE: booked against arrived',
    background: '#14202b',
    textColor: '#f2f5f7',
    accent: '#f2b84b',
    direction: 'ltr',
    scaleMax: 10,
    objects: [
      { id: 'booked', type: 'bar', x: xa, y, w: 0.1, label: 'Booked', value: 7, unit: 'h', decimals: 1, color: '#7fa6c9' },
      { id: 'arrived', type: 'bar', x: xb, y, w: 0.1, label: 'Arrived', value: 9.5, unit: 'h', decimals: 1, color: '#f2b84b' },
    ],
    actions: [
      { id: 'grow-booked', targetId: 'booked', property: 'progress', from: 0, to: 1, startSec: 0.5, endSec: 2.5, easing: 'ease_out' },
      { id: 'grow-arrived', targetId: 'arrived', property: 'progress', from: 0, to: 1, startSec: 1.5, endSec: 3.5, easing: 'ease_out' },
    ],
  };
}

/** P2: a 2D actor picks up a box, carries it to a tray, and a tick appears. Multi-step timed action with interaction. */
export function proofActor(format: ProofFormat): EditorGraphic {
  const portrait = format === 'portrait';
  const p = portrait
    ? { worker: [0.18, 0.5], pick: [0.3, 0.5], carryEnd: 0.76, boxY: 0.5, tray: [0.8, 0.58], tick: [0.8, 0.36], boxW: 0.22, boxH: 0.05, trayW: 0.22 }
    : { worker: [0.2, 0.72], pick: [0.3, 0.6], carryEnd: 0.78, boxY: 0.6, tray: [0.8, 0.66], tick: [0.8, 0.4], boxW: 0.09, boxH: 0.08, trayW: 0.16 };
  return {
    schemaVersion: 1,
    kind: 'actor_action',
    title: 'FIXTURE: move the box to the tray',
    background: '#1d2a22',
    textColor: '#f2f5f7',
    accent: '#d9a441',
    direction: 'ltr',
    scaleMax: null,
    objects: [
      { id: 'worker', type: 'figure', x: p.worker[0], y: p.worker[1], scale: 1, armAngle: 0, opacity: 1, color: '#e8eef2' },
      { id: 'box', type: 'box', x: p.pick[0], y: p.boxY, w: p.boxW, h: p.boxH, label: 'Box', color: '#d9a441', rotation: 0, scale: 1, opacity: 1 },
      { id: 'tray', type: 'box', x: p.tray[0], y: p.tray[1] + 0.04, w: p.trayW, h: 0.03, label: '', color: '#55606b', rotation: 0, scale: 1, opacity: 1 },
      { id: 'tick', type: 'tick', x: p.tick[0], y: p.tick[1], scale: 0.2, opacity: 0, color: '#7ad39b' },
    ],
    actions: [
      { id: 'reach-out', targetId: 'worker', property: 'armAngle', from: 0, to: 70, startSec: 0.5, endSec: 1.5, easing: 'ease_in_out' },
      { id: 'pick-up', targetId: 'box', property: 'x', from: p.pick[0], to: p.pick[0] - 0.02, startSec: 1.5, endSec: 2.0, easing: 'ease_out' },
      { id: 'carry', targetId: 'box', property: 'x', from: p.pick[0] - 0.02, to: p.carryEnd, startSec: 2.0, endSec: 4.5, easing: 'ease_in_out' },
      { id: 'set-down', targetId: 'box', property: 'y', from: p.boxY, to: p.tray[1] - 0.01, startSec: 4.5, endSec: 5.0, easing: 'ease_in' },
      { id: 'arm-back', targetId: 'worker', property: 'armAngle', from: 70, to: 0, startSec: 4.5, endSec: 5.5, easing: 'ease_in_out' },
      { id: 'tick-scale', targetId: 'tick', property: 'scale', from: 0.2, to: 1, startSec: 5.5, endSec: 6.5, easing: 'ease_out' },
      { id: 'tick-show', targetId: 'tick', property: 'opacity', from: 0, to: 1, startSec: 5.5, endSec: 6.0, easing: 'linear' },
    ],
  };
}

/** P3 (religious part): kinetic text with no brand and no quotation marks. FIXTURE wording, not scripture. */
export function proofKinetic(format: ProofFormat): EditorGraphic {
  const portrait = format === 'portrait';
  const ys = portrait ? [0.28, 0.52, 0.76] : [0.4, 0.55, 0.7];
  return {
    schemaVersion: 1,
    kind: 'kinetic_text',
    title: null,
    background: '#1b1a22',
    textColor: '#efe9dc',
    accent: '#e4c98a',
    direction: 'ltr',
    scaleMax: null,
    objects: [
      { id: 'w1', type: 'word', x: 0.5, y: ys[0], text: 'Patience', emphasis: 'strong', size: portrait ? 0.07 : 0.11, color: '#e4c98a', opacity: 0, scale: 0.9 },
      { id: 'w2', type: 'word', x: 0.5, y: ys[1], text: 'one task', emphasis: 'normal', size: portrait ? 0.05 : 0.07, opacity: 0, scale: 1 },
      { id: 'w3', type: 'word', x: 0.5, y: ys[2], text: 'at a time', emphasis: 'normal', size: portrait ? 0.05 : 0.07, opacity: 0, scale: 1 },
    ],
    actions: [
      { id: 'in-1', targetId: 'w1', property: 'opacity', from: 0, to: 1, startSec: 0.3, endSec: 1.0, easing: 'ease_out' },
      { id: 'scale-1', targetId: 'w1', property: 'scale', from: 0.9, to: 1, startSec: 0.3, endSec: 1.0, easing: 'ease_out' },
      { id: 'in-2', targetId: 'w2', property: 'opacity', from: 0, to: 1, startSec: 1.2, endSec: 1.9, easing: 'ease_out' },
      { id: 'in-3', targetId: 'w3', property: 'opacity', from: 0, to: 1, startSec: 2.1, endSec: 2.8, easing: 'ease_out' },
    ],
  };
}

/** The three proofs for one orientation. Durations are within the 8 to 12 second proof window. */
export function proofScenes(format: ProofFormat): Record<'educational' | 'procedural_2d' | 'mixed_religious', ProofScene[]> {
  return {
    educational: [{ kind: 'graphic', id: 'p1-numeric', durationSec: 10, graphic: proofNumeric(format) }],
    procedural_2d: [{ kind: 'graphic', id: 'p2-actor', durationSec: 10, graphic: proofActor(format) }],
    mixed_religious: [
      { kind: 'still', id: 'p3-still', durationSec: 4, illustration: 'closed_book_and_lamp' },
      { kind: 'graphic', id: 'p3-kinetic', durationSec: 6, graphic: proofKinetic(format) },
    ],
  };
}

/** The religious proof's document profile. Used by the validator in tests and by the harness. */
export const RELIGIOUS_PROOF_PROFILE = 'religious' as const;
