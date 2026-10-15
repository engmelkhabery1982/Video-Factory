/**
 * Procedural graphic specs for editor visual clips (schema version 1).
 *
 * A graphic is structured data, not code and not markup. It holds objects (nodes, bars, actors, words) with
 * normalised positions, and ordered timed actions that move one property of one object from `from` to `to`
 * between `startSec` and `endSec` on the clip's own clock. The same evaluator (`graphicStateAt`) gives the
 * renderer and the tests the same frame state, so a saved value is the value that is drawn.
 *
 * Refused, with a reason: unknown kinds, unknown keys (no executable or extra content can be stored), non-finite
 * numbers, positions outside the safe area, text that contains markup or control characters, colours that are not
 * #rrggbb, actions that are unordered, overlapping, discontinuous, out of the clip, or on a property the object
 * does not have, and in a religious document any brand or identity name or quotation marks.
 */
import { GRAPHIC_TECHNIQUE_IDS, type GraphicTechniqueId } from '../visual-language.js';

/** Same value as document.ts TIME_EPSILON. Repeated here so this module does not import the document (no cycle). */
const TIME_EPSILON = 0.001;

export const GRAPHIC_SCHEMA_VERSION = 1 as const;
export const GRAPHIC_EASINGS = ['linear', 'ease_in', 'ease_out', 'ease_in_out', 'hold'] as const;
export type GraphicEasing = (typeof GRAPHIC_EASINGS)[number];
export const GRAPHIC_DIRECTIONS = ['ltr', 'rtl'] as const;
export type GraphicDirection = (typeof GRAPHIC_DIRECTIONS)[number];
export type GraphicKind = GraphicTechniqueId;
export const GRAPHIC_PROPERTIES = ['opacity', 'scale', 'x', 'y', 'rotation', 'armAngle', 'progress'] as const;
export type GraphicProperty = (typeof GRAPHIC_PROPERTIES)[number];

/** Limits. A larger request is refused, never truncated. */
export const GRAPHIC_LIMITS = {
  maxObjects: 12,
  maxActions: 60,
  maxTextChars: 40,
  maxTitleChars: 80,
  maxUnitChars: 8,
  maxIdChars: 40,
  maxSec: 600,
  maxValue: 1_000_000_000,
} as const;

/** Positions are normalised to the frame. Objects and their animated positions stay inside this band (safe area). */
export const GRAPHIC_SAFE_MIN = 0.05;
export const GRAPHIC_SAFE_MAX = 0.95;
/** Minimum spacing between labelled items (nodes, bars, words) on the axis that separates them. Portrait is tighter. */
export const GRAPHIC_MIN_SPACING = { landscape: 0.14, portrait: 0.22 } as const;
/** Portrait frames carry fewer labelled items per row, so each item stays readable. */
export const GRAPHIC_PORTRAIT_MAX_ITEMS = 4;

export const GRAPHIC_OBJECT_TYPES = ['node', 'marker', 'bar', 'figure', 'box', 'tick', 'word'] as const;
export type GraphicObjectType = (typeof GRAPHIC_OBJECT_TYPES)[number];

/** Which properties each object type may animate. Anything else is refused. */
export const GRAPHIC_ANIMATABLE: Record<GraphicObjectType, readonly GraphicProperty[]> = {
  node: ['opacity', 'scale'],
  marker: ['progress'],
  bar: ['progress', 'opacity'],
  figure: ['x', 'y', 'scale', 'armAngle', 'opacity'],
  box: ['x', 'y', 'rotation', 'scale', 'opacity'],
  tick: ['opacity', 'scale'],
  word: ['opacity', 'scale', 'y'],
};

/** Allowed value ranges for animated properties (the actions must stay inside them). */
export const GRAPHIC_PROPERTY_RANGE: Record<GraphicProperty, { min: number; max: number }> = {
  opacity: { min: 0, max: 1 },
  scale: { min: 0.2, max: 3 },
  x: { min: GRAPHIC_SAFE_MIN, max: GRAPHIC_SAFE_MAX },
  y: { min: GRAPHIC_SAFE_MIN, max: GRAPHIC_SAFE_MAX },
  rotation: { min: -360, max: 360 },
  armAngle: { min: -180, max: 180 },
  progress: { min: 0, max: 1 },
};

const OBJECT_KEYS: Record<GraphicObjectType, readonly string[]> = {
  node: ['id', 'type', 'x', 'y', 'label', 'color', 'opacity', 'scale'],
  marker: ['id', 'type', 'x', 'y', 'color', 'progress'],
  bar: ['id', 'type', 'x', 'y', 'w', 'label', 'value', 'unit', 'decimals', 'color', 'progress', 'opacity'],
  figure: ['id', 'type', 'x', 'y', 'scale', 'armAngle', 'opacity', 'color'],
  box: ['id', 'type', 'x', 'y', 'w', 'h', 'label', 'color', 'rotation', 'scale', 'opacity'],
  tick: ['id', 'type', 'x', 'y', 'scale', 'opacity', 'color'],
  word: ['id', 'type', 'x', 'y', 'text', 'emphasis', 'size', 'color', 'opacity', 'scale'],
};
const GRAPHIC_KEYS = ['schemaVersion', 'kind', 'title', 'background', 'textColor', 'accent', 'direction', 'scaleMax', 'objects', 'actions'] as const;
const ACTION_KEYS = ['id', 'targetId', 'property', 'from', 'to', 'startSec', 'endSec', 'easing'] as const;

export interface GraphicObject {
  id: string;
  type: GraphicObjectType;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  label?: string;
  value?: number;
  unit?: string;
  decimals?: number;
  text?: string;
  emphasis?: 'normal' | 'strong';
  size?: number;
  color?: string;
  opacity?: number;
  scale?: number;
  rotation?: number;
  armAngle?: number;
  progress?: number;
}

export interface GraphicAction {
  id: string;
  targetId: string;
  property: GraphicProperty;
  from: number;
  to: number;
  /** Seconds on the clip's own clock (0 = the clip's first frame). */
  startSec: number;
  endSec: number;
  easing: GraphicEasing;
}

export interface EditorGraphic {
  schemaVersion: typeof GRAPHIC_SCHEMA_VERSION;
  kind: GraphicKind;
  title: string | null;
  background: string;
  textColor: string;
  accent: string;
  direction: GraphicDirection;
  /** numeric_comparison only: the value that a full bar represents. Every value must not exceed it. */
  scaleMax: number | null;
  objects: GraphicObject[];
  actions: GraphicAction[];
}

export interface GraphicContext {
  durationSec: number;
  format: 'landscape' | 'portrait';
  contentProfile: 'religious' | 'educational' | 'promotional' | null;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const HEX = /^#[0-9a-fA-F]{6}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
/** Angle brackets and control characters are never stored in graphic text. */
const MARKUP = /[<>\u0000-\u001f\u007f]/;
/** Identity terms that must never appear in religious content. */
const IDENTITY_TERMS = /build\s*track/i;
/** Quotation marks. A religious graphic must not carry typed quotations; quoted text needs its own reviewed source. */
const QUOTE_MARKS = /["\u201c\u201d\u00ab\u00bb]/;

function inSafe(v: number): boolean {
  return v >= GRAPHIC_SAFE_MIN - TIME_EPSILON && v <= GRAPHIC_SAFE_MAX + TIME_EPSILON;
}

/** Every problem in a graphic, as readable strings. Empty means valid. Never rewrites a value. */
export function validateGraphic(raw: unknown, ctx: GraphicContext): string[] {
  const problems: string[] = [];
  const add = (m: string) => problems.push(m);
  if (!isObj(raw)) return ['graphic must be an object'];
  for (const key of Object.keys(raw)) {
    if (!(GRAPHIC_KEYS as readonly string[]).includes(key)) add(`graphic has an unknown key "${key}"`);
  }
  if (raw.schemaVersion !== GRAPHIC_SCHEMA_VERSION) add(`graphic schemaVersion must be ${GRAPHIC_SCHEMA_VERSION}`);
  if (!(GRAPHIC_TECHNIQUE_IDS as readonly string[]).includes(raw.kind as string)) {
    add(`graphic kind must be one of ${GRAPHIC_TECHNIQUE_IDS.join(', ')}`);
    return problems;
  }
  const kind = raw.kind as GraphicKind;
  const profile = ctx.contentProfile;
  const checkText = (value: unknown, what: string, max: number, required: boolean) => {
    if (value === undefined || value === null || value === '') {
      if (required) add(`${what} is required`);
      return;
    }
    if (typeof value !== 'string') { add(`${what} must be text`); return; }
    if (value.trim().length === 0 && required) { add(`${what} is required`); return; }
    if (Array.from(value).length > max) add(`${what} is longer than ${max} characters`);
    if (MARKUP.test(value)) add(`${what} contains markup or control characters. Graphic text is plain text only.`);
    if (profile === 'religious') {
      if (IDENTITY_TERMS.test(value)) add(`${what} names a brand identity. Religious content carries no BuildTrack identity.`);
      if (QUOTE_MARKS.test(value)) add(`${what} contains quotation marks. Religious graphics must not carry typed quotations; use reviewed supplied text.`);
    }
  };
  checkText(raw.title, 'title', GRAPHIC_LIMITS.maxTitleChars, false);
  for (const key of ['background', 'textColor', 'accent'] as const) {
    if (typeof raw[key] !== 'string' || !HEX.test(raw[key] as string)) add(`${key} must be a #rrggbb colour`);
  }
  if (raw.direction !== undefined && !(GRAPHIC_DIRECTIONS as readonly string[]).includes(raw.direction as string)) add('direction must be ltr or rtl');
  if (!ctx.format || !['landscape', 'portrait'].includes(ctx.format)) add('format must be landscape or portrait');

  if (!Number.isFinite(ctx.durationSec) || ctx.durationSec <= 0 || ctx.durationSec > GRAPHIC_LIMITS.maxSec) {
    add(`clip duration must be a positive number no longer than ${GRAPHIC_LIMITS.maxSec} seconds`);
  }

  const objects = Array.isArray(raw.objects) ? (raw.objects as unknown[]) : null;
  if (!objects) { add('objects must be an array'); return problems; }
  if (objects.length === 0 || objects.length > GRAPHIC_LIMITS.maxObjects) add(`objects must hold 1 to ${GRAPHIC_LIMITS.maxObjects} items`);

  const byId = new Map<string, GraphicObject>();
  const count: Partial<Record<GraphicObjectType, number>> = {};
  objects.forEach((o, i) => {
    if (!isObj(o)) { add(`object ${i} must be an object`); return; }
    const type = o.type as GraphicObjectType;
    if (!(GRAPHIC_OBJECT_TYPES as readonly string[]).includes(type)) { add(`object ${i} has an unknown type`); return; }
    for (const key of Object.keys(o)) {
      if (!OBJECT_KEYS[type].includes(key)) add(`object ${String(o.id)} (${type}) has an unknown key "${key}"`);
    }
    if (typeof o.id !== 'string' || !ID.test(o.id)) { add(`object ${i} needs an id of letters, digits, _ or - (up to 40)`); return; }
    if (byId.has(o.id)) { add(`duplicate object id ${o.id}`); return; }
    byId.set(o.id, o as unknown as GraphicObject);
    count[type] = (count[type] ?? 0) + 1;
    const pos = (key: 'x' | 'y') => {
      if (o[key] === undefined) return;
      if (!isFiniteNumber(o[key]) || !inSafe(o[key] as number)) add(`${o.id} ${key} must be a finite number inside the safe area (${GRAPHIC_SAFE_MIN} to ${GRAPHIC_SAFE_MAX})`);
    };
    pos('x'); pos('y');
    if (o.color !== undefined && (typeof o.color !== 'string' || !HEX.test(o.color))) add(`${o.id} color must be #rrggbb`);
    const num = (key: string, min: number, max: number, required = false) => {
      if (o[key] === undefined) { if (required) add(`${o.id} ${key} is required`); return; }
      if (!isFiniteNumber(o[key]) || (o[key] as number) < min || (o[key] as number) > max) add(`${o.id} ${key} must be a finite number from ${min} to ${max}`);
    };
    if (type === 'node') {
      checkText(o.label, `${o.id} label`, GRAPHIC_LIMITS.maxTextChars, true);
      num('opacity', 0, 1); num('scale', 0.2, 3);
      if (!isFiniteNumber(o.x) || !isFiniteNumber(o.y)) add(`${o.id} needs x and y`);
    }
    if (type === 'marker') { num('progress', 0, 1); if (!isFiniteNumber(o.x) || !isFiniteNumber(o.y)) add(`${o.id} needs x and y`); }
    if (type === 'bar') {
      checkText(o.label, `${o.id} label`, GRAPHIC_LIMITS.maxTextChars, true);
      checkText(o.unit, `${o.id} unit`, GRAPHIC_LIMITS.maxUnitChars, false);
      if (!isFiniteNumber(o.value) || (o.value as number) < 0 || (o.value as number) > GRAPHIC_LIMITS.maxValue) add(`${o.id} value must be a finite number, 0 or more`);
      if (o.decimals !== undefined && (!Number.isInteger(o.decimals) || (o.decimals as number) < 0 || (o.decimals as number) > 3)) add(`${o.id} decimals must be an integer from 0 to 3`);
      if (!isFiniteNumber(o.x) || !isFiniteNumber(o.y)) add(`${o.id} needs x (centre) and y (baseline)`);
      num('progress', 0, 1); num('opacity', 0, 1);
    }
    if (type === 'figure') { num('armAngle', -180, 180); num('scale', 0.2, 3); num('opacity', 0, 1); if (!isFiniteNumber(o.x) || !isFiniteNumber(o.y)) add(`${o.id} needs x and y`); }
    if (type === 'box') {
      checkText(o.label, `${o.id} label`, GRAPHIC_LIMITS.maxTextChars, false);
      num('w', 0.02, 0.6, true); num('h', 0.02, 0.6, true);
      num('rotation', -360, 360); num('scale', 0.2, 3); num('opacity', 0, 1);
      if (!isFiniteNumber(o.x) || !isFiniteNumber(o.y)) add(`${o.id} needs x and y`);
    }
    if (type === 'tick') { num('scale', 0.2, 3); num('opacity', 0, 1); if (!isFiniteNumber(o.x) || !isFiniteNumber(o.y)) add(`${o.id} needs x and y`); }
    if (type === 'word') {
      checkText(o.text, `${o.id} text`, GRAPHIC_LIMITS.maxTextChars, true);
      if (o.emphasis !== undefined && !['normal', 'strong'].includes(o.emphasis as string)) add(`${o.id} emphasis must be normal or strong`);
      num('size', 0.02, 0.2, true); num('opacity', 0, 1); num('scale', 0.2, 3);
      if (!isFiniteNumber(o.x) || !isFiniteNumber(o.y)) add(`${o.id} needs x and y`);
    }
  });

  // Kind-specific shape of the objects.
  const need = (type: GraphicObjectType, min: number, max: number) => {
    const n = count[type] ?? 0;
    if (n < min || n > max) add(`${kind} needs ${min === max ? min : `${min} to ${max}`} ${type} object${max === 1 && min === 1 ? '' : 's'} (found ${n})`);
  };
  const otherTypes = (allowed: GraphicObjectType[]) => {
    for (const t of GRAPHIC_OBJECT_TYPES) if (!allowed.includes(t) && (count[t] ?? 0) > 0) add(`${kind} does not use ${t} objects`);
  };
  const portrait = ctx.format === 'portrait';
  if (kind === 'process_path') {
    otherTypes(['node', 'marker']);
    need('node', 2, 6);
    need('marker', 0, 1);
  } else if (kind === 'numeric_comparison') {
    otherTypes(['bar']);
    need('bar', 2, 6);
    if (!isFiniteNumber(raw.scaleMax) || (raw.scaleMax as number) <= 0 || (raw.scaleMax as number) > GRAPHIC_LIMITS.maxValue) {
      add('scaleMax must be a positive finite number: the value a full bar represents');
    } else {
      for (const o of byId.values()) {
        if (o.type === 'bar' && isFiniteNumber(o.value) && o.value > (raw.scaleMax as number)) add(`${o.id} value ${o.value} is above scaleMax ${raw.scaleMax}`);
      }
    }
  } else if (kind === 'actor_action') {
    otherTypes(['figure', 'box', 'tick']);
    need('figure', 1, 3);
    if ((count.box ?? 0) > 6) add('actor_action allows at most 6 boxes');
    if ((count.tick ?? 0) > 3) add('actor_action allows at most 3 ticks');
  } else if (kind === 'kinetic_text') {
    otherTypes(['word']);
    need('word', 1, 8);
  }
  if (raw.scaleMax !== undefined && raw.scaleMax !== null && kind !== 'numeric_comparison') add('scaleMax applies to numeric_comparison only');

  // Labelled items must not collide: they need spacing on one axis, tighter in portrait.
  if (kind === 'process_path' || kind === 'numeric_comparison' || kind === 'kinetic_text') {
    const items = [...byId.values()].filter((o) => ['node', 'bar', 'word'].includes(o.type));
    if (portrait && items.length > GRAPHIC_PORTRAIT_MAX_ITEMS) add(`a portrait ${kind} carries at most ${GRAPHIC_PORTRAIT_MAX_ITEMS} labelled items; split it across shots`);
    const minSep = GRAPHIC_MIN_SPACING[portrait ? 'portrait' : 'landscape'];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]; const b = items[j];
        if (!isFiniteNumber(a.x) || !isFiniteNumber(a.y) || !isFiniteNumber(b.x) || !isFiniteNumber(b.y)) continue;
        const dx = Math.abs((a.x as number) - (b.x as number));
        const dy = Math.abs((a.y as number) - (b.y as number));
        if (dx < minSep && dy < minSep) add(`${a.id} and ${b.id} are too close to read (spacing ${minSep} needed on one axis, ${portrait ? 'portrait' : 'landscape'})`);
      }
    }
  }

  // Actions.
  const actions = Array.isArray(raw.actions) ? (raw.actions as unknown[]) : null;
  if (!actions) { add('actions must be an array'); return problems; }
  if (actions.length > GRAPHIC_LIMITS.maxActions) add(`at most ${GRAPHIC_LIMITS.maxActions} actions`);
  const actionIds = new Set<string>();
  const perProperty = new Map<string, Array<{ idx: number; a: GraphicAction }>>();
  actions.forEach((raw, idx) => {
    if (!isObj(raw)) { add(`action ${idx} must be an object`); return; }
    for (const key of Object.keys(raw)) if (!(ACTION_KEYS as readonly string[]).includes(key)) add(`action ${idx} has an unknown key "${key}"`);
    const a = raw as unknown as GraphicAction;
    const label = `action ${typeof a.id === 'string' ? a.id : idx}`;
    if (typeof a.id !== 'string' || !ID.test(a.id)) add(`action ${idx} needs an id of letters, digits, _ or - (up to 40)`);
    else if (actionIds.has(a.id)) add(`duplicate action id ${a.id}`);
    else actionIds.add(a.id);
    const target = typeof a.targetId === 'string' ? byId.get(a.targetId) : undefined;
    if (!target) { add(`${label} targets an object that does not exist (${String(a.targetId)})`); return; }
    if (!(GRAPHIC_PROPERTIES as readonly string[]).includes(a.property)) { add(`${label} animates an unknown property`); return; }
    if (!GRAPHIC_ANIMATABLE[target.type].includes(a.property)) add(`${label}: a ${target.type} cannot animate ${a.property}`);
    const range = GRAPHIC_PROPERTY_RANGE[a.property];
    for (const k of ['from', 'to'] as const) {
      const v = a[k];
      if (!isFiniteNumber(v) || v < range.min - TIME_EPSILON || v > range.max + TIME_EPSILON) add(`${label} ${k} must be a finite ${a.property} from ${range.min} to ${range.max}`);
    }
    if (!isFiniteNumber(a.startSec) || !isFiniteNumber(a.endSec)) add(`${label} needs finite startSec and endSec`);
    else {
      if (a.startSec < 0 || a.endSec <= a.startSec) add(`${label} needs 0 <= startSec < endSec`);
      if (a.endSec > ctx.durationSec + TIME_EPSILON) add(`${label} ends at ${a.endSec}s, after the clip (${ctx.durationSec}s). Shorten the action or lengthen the clip.`);
    }
    if (!(GRAPHIC_EASINGS as readonly string[]).includes(a.easing)) add(`${label} easing must be one of ${GRAPHIC_EASINGS.join(', ')}`);
    const key = `${a.targetId}|${a.property}`;
    perProperty.set(key, [...(perProperty.get(key) ?? []), { idx, a }]);
  });
  for (const [key, list] of perProperty) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1].a; const cur = list[i].a;
      if (!isFiniteNumber(prev.endSec) || !isFiniteNumber(cur.startSec)) continue;
      if (cur.startSec < prev.endSec - TIME_EPSILON) add(`actions on ${key.replace('|', ' ')} overlap or are out of order (${prev.id} ends after ${cur.id} starts)`);
      else if (Math.abs(cur.from - prev.to) > TIME_EPSILON) add(`${cur.id} starts at ${cur.from} but ${prev.id} ended at ${prev.to}. Make each action start where the last one ended.`);
    }
  }
  return problems;
}

/** Throws the first problem as a plain Error. Callers that need the whole list use validateGraphic. */
export function assertValidGraphic(raw: unknown, ctx: GraphicContext): EditorGraphic {
  const problems = validateGraphic(raw, ctx);
  if (problems.length > 0) throw new GraphicInvalidError(problems);
  return raw as EditorGraphic;
}

export class GraphicInvalidError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems[0] ?? 'invalid graphic');
    this.name = 'GraphicInvalidError';
  }
}

/* ------------------------------------------------------------------ */
/* Evaluator: the one place where time becomes a value.                */
/* ------------------------------------------------------------------ */

export interface GraphicObjectState {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  rotation: number;
  opacity: number;
  armAngle: number;
  progress: number;
  /** word or box text, copied for the renderer. Not animated. */
  label: string;
}

export function applyEasing(easing: GraphicEasing, t: number): number {
  const c = Math.min(1, Math.max(0, t));
  switch (easing) {
    case 'linear': return c;
    case 'ease_in': return c * c;
    case 'ease_out': return 1 - (1 - c) * (1 - c);
    case 'ease_in_out': return c * c * (3 - 2 * c);
    case 'hold': return c >= 1 ? 1 : 0;
  }
}

/** Value of one animated property at clip time `t`. Before the first action it holds the first `from`; after the last it holds the last `to`. */
export function animatedValueAt(actions: readonly GraphicAction[], t: number): number | undefined {
  if (actions.length === 0) return undefined;
  const first = actions[0];
  if (t <= first.startSec) return first.from;
  const last = actions[actions.length - 1];
  if (t >= last.endSec) return last.to;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (t >= a.startSec && t < a.endSec) {
      const k = applyEasing(a.easing, (t - a.startSec) / (a.endSec - a.startSec));
      if (a.easing === 'hold') return k >= 1 ? a.to : a.from;
      return a.from + (a.to - a.from) * k;
    }
    const next = actions[i + 1];
    if (next && t >= a.endSec && t < next.startSec) return a.to;
  }
  return last.to;
}

/**
 * Resolved state of every object at clip time `timeSec`. Defaults come from the object's own fields, then from
 * the type. Only validated graphics are evaluated; an invalid graphic throws.
 */
export function graphicStateAt(graphic: EditorGraphic, timeSec: number): Map<string, GraphicObjectState> {
  const out = new Map<string, GraphicObjectState>();
  const byTarget = new Map<string, Map<GraphicProperty, GraphicAction[]>>();
  for (const a of graphic.actions) {
    const perProp = byTarget.get(a.targetId) ?? new Map<GraphicProperty, GraphicAction[]>();
    perProp.set(a.property, [...(perProp.get(a.property) ?? []), a]);
    byTarget.set(a.targetId, perProp);
  }
  for (const o of graphic.objects) {
    const base: GraphicObjectState = {
      x: o.x ?? 0.5,
      y: o.y ?? (o.type === 'bar' ? 0.85 : 0.5),
      w: o.w ?? (o.type === 'bar' ? 0.08 : 0.2),
      h: o.h ?? 0.2,
      scale: o.scale ?? 1,
      rotation: o.rotation ?? 0,
      opacity: o.opacity ?? 1,
      armAngle: o.armAngle ?? 0,
      progress: o.progress ?? (o.type === 'marker' ? 0 : 1),
      label: o.label ?? o.text ?? '',
    };
    const perProp = byTarget.get(o.id);
    if (perProp) {
      for (const [prop, list] of perProp) {
        const v = animatedValueAt(list, timeSec);
        if (v !== undefined) (base as unknown as Record<string, number>)[prop] = v;
      }
    }
    out.set(o.id, base);
  }
  return out;
}

/** Point on the polyline through `points` at fraction `p` (0..1) of its total length. Used by the process path marker. */
export function pathPointAt(points: ReadonlyArray<{ x: number; y: number }>, p: number): { x: number; y: number } {
  if (points.length === 0) return { x: 0.5, y: 0.5 };
  if (points.length === 1) return points[0];
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    segs.push(d);
    total += d;
  }
  if (total <= 0) return points[0];
  let target = Math.min(1, Math.max(0, p)) * total;
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i] || i === segs.length - 1) {
      const f = segs[i] === 0 ? 0 : Math.min(1, target / segs[i]);
      return { x: points[i].x + (points[i + 1].x - points[i].x) * f, y: points[i].y + (points[i + 1].y - points[i].y) * f };
    }
    target -= segs[i];
  }
  return points[points.length - 1];
}

/** The exact text a numeric bar shows: the supplied value, fixed to its declared decimals, plus its unit. Never rounded further. */
export function exactValueLabel(o: GraphicObject): string {
  const decimals = o.decimals ?? 0;
  return `${(o.value as number).toFixed(decimals)}${o.unit ? ` ${o.unit}` : ''}`;
}
