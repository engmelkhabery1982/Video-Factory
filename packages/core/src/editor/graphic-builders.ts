/**
 * Procedural graphic builders. Pure: no fetch, no React, no Node built-ins.
 *
 * Shared by the server (treatment derivation from SUPPLIED words only) and the web form (owner-typed values).
 * Every value a builder writes comes from its input. Nothing is estimated, rounded or invented.
 *
 * Pacing changes timing only: how long the default actions take inside the shot. It never moves narration,
 * captions or the shot's own start and end, which belong to the source unit.
 */
import {
  GRAPHIC_LIMITS,
  GRAPHIC_MIN_SPACING,
  GRAPHIC_SCHEMA_VERSION,
  validateGraphic,
  type EditorGraphic,
  type GraphicAction,
  type GraphicDirection,
  type GraphicObject,
} from './graphics.js';

export const GRAPHIC_PACINGS = ['measured', 'brisk', 'held'] as const;
export type GraphicPacing = (typeof GRAPHIC_PACINGS)[number];
export type GraphicFormat = 'landscape' | 'portrait';

export const GRAPHIC_PACING_LABELS: Record<GraphicPacing, string> = {
  measured: 'Measured: actions spread across most of the shot',
  brisk: 'Brisk: actions finish in the first half of the shot',
  held: 'Held: actions finish early, then the frame holds',
};

export interface NumericRowInput { label: string; value: string; unit: string }
export interface NumericFormInput { title: string; scaleMax: string; rows: NumericRowInput[] }
export interface ListFormInput { title: string; items: string[] }

export interface GraphicBuildOptions {
  direction?: GraphicDirection;
  pacing?: GraphicPacing;
}

const PALETTE = ['#7fa6c9', '#f2b84b', '#8fd19e', '#e58f8f', '#b49ce0', '#9fd3d3'];
const BASE = { schemaVersion: GRAPHIC_SCHEMA_VERSION, background: '#14202b', textColor: '#f2f5f7', accent: '#f2b84b' } as const;

/** Decimal places the owner typed (0..3). The label shows exactly that many, never a rounded or recomputed value. */
export function decimalsOf(text: string): number {
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(3, text.length - dot - 1);
}

/** Lay out n items centred on the frame, spaced a little more than the validator's minimum for this format. */
function centredPositions(n: number, format: GraphicFormat): number[] {
  if (n <= 0) return [];
  const step = GRAPHIC_MIN_SPACING[format] + 0.02;
  const start = 0.5 - ((n - 1) * step) / 2;
  return Array.from({ length: n }, (_, i) => Math.round((start + i * step) * 1000) / 1000);
}

function clampSec(value: number, durationSec: number): number {
  return Math.max(0, Math.min(value, Math.max(0, durationSec - 0.1)));
}

function cleanAll<T extends object>(items: T[]): T[] {
  return items.map((item) => Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)) as T);
}

/** Reasons a numeric form is not yet complete. Empty array = complete. */
export function numericIncomplete(form: NumericFormInput): string[] {
  const reasons: string[] = [];
  if (form.rows.length < 2) reasons.push('Add at least two values to compare.');
  if (form.rows.length > 6) reasons.push('Use at most six values in one comparison.');
  form.rows.forEach((r, i) => {
    if (!r.label.trim()) reasons.push(`Value ${i + 1} needs a label.`);
    const v = Number(r.value);
    if (r.value.trim() === '' || !Number.isFinite(v)) reasons.push(`Value ${i + 1} must be a number as you supplied it.`);
    else if (v < 0) reasons.push(`Value ${i + 1} cannot be negative.`);
  });
  const max = Number(form.scaleMax);
  if (form.scaleMax.trim() === '' || !Number.isFinite(max) || max <= 0) reasons.push('Set the scale maximum: the value a full bar represents.');
  return reasons;
}

/** Build a numeric_comparison graphic. Call only when numericIncomplete is empty. durationSec null = no actions yet. */
export function buildNumericGraphic(form: NumericFormInput, format: GraphicFormat, durationSec: number | null, opts: GraphicBuildOptions = {}): EditorGraphic {
  const n = form.rows.length;
  const xs = centredPositions(n, format);
  const y = format === 'portrait' ? 0.72 : 0.82;
  const objects: GraphicObject[] = form.rows.map((r, i) => ({
    id: `bar${i + 1}`,
    type: 'bar',
    x: xs[i],
    y,
    w: 0.1,
    label: r.label.trim(),
    value: Number(r.value),
    unit: r.unit.trim() || undefined,
    decimals: decimalsOf(r.value),
    color: PALETTE[i % PALETTE.length],
  }));
  const graphic: EditorGraphic = {
    ...BASE,
    kind: 'numeric_comparison',
    title: form.title.trim() || null,
    direction: opts.direction ?? 'ltr',
    scaleMax: Number(form.scaleMax),
    objects: cleanAll(objects),
    actions: [],
  };
  graphic.actions = defaultGraphicActions(graphic, durationSec, opts.pacing ?? 'measured');
  return graphic;
}

/** Reasons a list form is not yet complete for the given kind. */
export function listIncomplete(kind: 'kinetic_text' | 'process_path', form: ListFormInput): string[] {
  const items = form.items.map((t) => t.trim()).filter((t) => t.length > 0);
  const reasons: string[] = [];
  if (kind === 'kinetic_text') {
    if (items.length < 1) reasons.push('Add at least one word or phrase.');
    if (items.length > 8) reasons.push('Use at most eight words or phrases.');
  } else {
    if (items.length < 2) reasons.push('A process needs at least two steps.');
    if (items.length > 6) reasons.push('Use at most six steps.');
  }
  for (const t of items) {
    if (t.length > GRAPHIC_LIMITS.maxTextChars) reasons.push(`"${t.slice(0, 20)}…" is longer than ${GRAPHIC_LIMITS.maxTextChars} characters.`);
  }
  return reasons;
}

/** Build a kinetic_text graphic: each supplied phrase appears in order. */
export function buildKineticGraphic(form: ListFormInput, format: GraphicFormat, durationSec: number | null, opts: GraphicBuildOptions = {}): EditorGraphic {
  const items = form.items.map((t) => t.trim()).filter((t) => t.length > 0);
  const step = GRAPHIC_MIN_SPACING[format] + 0.02;
  const start = format === 'portrait' ? 0.28 : 0.3;
  const objects: GraphicObject[] = items.map((text, i) => ({
    id: `word${i + 1}`,
    type: 'word',
    x: 0.5,
    y: Math.round((start + i * step) * 1000) / 1000,
    text,
    emphasis: i === 0 ? 'strong' : 'normal',
    // Required by the validator (0.02 to 0.2 of frame height). 0.08 matches the renderer default.
    size: i === 0 ? 0.1 : 0.08,
  }));
  const graphic: EditorGraphic = {
    ...BASE,
    kind: 'kinetic_text',
    title: form.title.trim() || null,
    direction: opts.direction ?? 'ltr',
    scaleMax: null,
    objects: cleanAll(objects),
    actions: [],
  };
  graphic.actions = defaultGraphicActions(graphic, durationSec, opts.pacing ?? 'measured');
  return graphic;
}

/** Build a process_path graphic: steps in order, and one marker that travels along them. */
export function buildProcessGraphic(form: ListFormInput, format: GraphicFormat, durationSec: number | null, opts: GraphicBuildOptions = {}): EditorGraphic {
  const items = form.items.map((t) => t.trim()).filter((t) => t.length > 0);
  const n = items.length;
  const pos = centredPositions(n, format);
  const nodes: GraphicObject[] = items.map((label, i) => ({
    id: `step${i + 1}`,
    type: 'node',
    x: format === 'portrait' ? 0.5 : pos[i],
    y: format === 'portrait' ? Math.round((0.25 + (i * 0.55) / Math.max(1, n - 1)) * 1000) / 1000 : 0.5,
    label,
  }));
  const marker: GraphicObject = { id: 'marker', type: 'marker', x: nodes[0].x, y: nodes[0].y, color: '#f2b84b' };
  const graphic: EditorGraphic = {
    ...BASE,
    kind: 'process_path',
    title: form.title.trim() || null,
    direction: opts.direction ?? 'ltr',
    scaleMax: null,
    objects: cleanAll([...nodes, marker]),
    actions: [],
  };
  graphic.actions = defaultGraphicActions(graphic, durationSec, opts.pacing ?? 'measured');
  return graphic;
}

/**
 * Timing per pacing, in seconds on the clip's own clock. measured reproduces the original defaults exactly.
 * usable is the time span the actions share; processEnd is where the marker stops.
 */
function windowFor(pacing: GraphicPacing, durationSec: number): {
  numericLead: number; kineticLead: number; processLead: number; usable: number; fade: number; gapMax: number; spanMax: number; processEnd: number;
} {
  if (pacing === 'brisk') {
    const usable = Math.max(0.5, durationSec * 0.5);
    return { numericLead: 0.3, kineticLead: 0.2, processLead: 0.2, usable, fade: 0.3, gapMax: 0.3, spanMax: 1.2, processEnd: usable };
  }
  if (pacing === 'held') {
    const usable = Math.max(0.5, durationSec * 0.35);
    return { numericLead: 0.4, kineticLead: 0.3, processLead: 0.3, usable, fade: 0.4, gapMax: 0.4, spanMax: 1.5, processEnd: usable };
  }
  const usable = Math.max(0.5, durationSec - 0.6);
  return { numericLead: 0.4, kineticLead: 0.3, processLead: 0.3, usable, fade: 0.5, gapMax: 0.6, spanMax: 2, processEnd: usable };
}

/**
 * Default timing from the shot duration. Every value is a starting point the owner can edit.
 * numeric: bars grow in order. kinetic: words fade in in order. process: steps light up and the marker travels once.
 * Returns no actions when the duration is not known yet (the timing is set later, from the real shot length).
 */
export function defaultGraphicActions(graphic: EditorGraphic, durationSec: number | null, pacing: GraphicPacing = 'measured'): GraphicAction[] {
  if (durationSec === null || !(durationSec > 0)) return [];
  const actions: GraphicAction[] = [];
  const w = windowFor(pacing, durationSec);
  if (graphic.kind === 'numeric_comparison') {
    const bars = graphic.objects.filter((o) => o.type === 'bar');
    const span = Math.min(w.spanMax, w.usable / Math.max(1, bars.length));
    bars.forEach((b, i) => {
      const start = clampSec(w.numericLead + i * (span * 0.5), durationSec);
      actions.push({ id: `grow-${b.id}`, targetId: b.id, property: 'progress', from: 0, to: 1, startSec: start, endSec: clampSec(start + span, durationSec), easing: 'ease_out' });
    });
  } else if (graphic.kind === 'kinetic_text') {
    const words = graphic.objects.filter((o) => o.type === 'word');
    const gap = Math.min(w.gapMax, w.usable / Math.max(1, words.length));
    words.forEach((word, i) => {
      const start = clampSec(w.kineticLead + i * gap, durationSec);
      actions.push({ id: `in-${word.id}`, targetId: word.id, property: 'opacity', from: 0, to: 1, startSec: start, endSec: clampSec(start + w.fade, durationSec), easing: 'ease_out' });
    });
  } else if (graphic.kind === 'process_path') {
    actions.push({ id: 'travel-marker', targetId: 'marker', property: 'progress', from: 0, to: 1, startSec: clampSec(w.processLead, durationSec), endSec: clampSec(w.processEnd, durationSec), easing: 'linear' });
  }
  return actions;
}

/** Problems against the same rules the server applies. Empty = valid for this shot. */
export function graphicProblems(graphic: EditorGraphic, durationSec: number, format: GraphicFormat, profile: 'religious' | 'educational' | 'promotional' | null): string[] {
  return validateGraphic(graphic, { durationSec, format, contentProfile: profile });
}

/**
 * Sentence-led phrases for kinetic text, taken from SUPPLIED words only. Tokens keep their original spelling and
 * punctuation. A phrase holds at most six tokens and forty characters. Returns null when the line would need more
 * than eight phrases; the caller then reports why instead of guessing.
 */
export function phrasesFromNarration(text: string): string[] | null {
  const out: string[] = [];
  const sentences = text.split(/(?<=[.!?؟])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const sentence of sentences) {
    let current: string[] = [];
    const flush = () => {
      if (current.length > 0) out.push(current.join(' '));
      current = [];
    };
    for (const token of sentence.split(/\s+/)) {
      const next = [...current, token].join(' ');
      if (current.length >= 6 || next.length > GRAPHIC_LIMITS.maxTextChars) flush();
      current.push(token);
    }
    flush();
  }
  return out.length >= 1 && out.length <= 8 ? out : null;
}

/**
 * Steps for a process path, taken from SUPPLIED clauses only (split at commas and semicolons). Returns null unless
 * the line gives two to six clauses of at most forty characters each.
 */
/** A line that introduces an example is not a sequence: its first clause is a marker, not a step. */
const EXAMPLE_LEAD = /^(for example|for instance|such as|e\.g\.|على سبيل المثال|مثلا|مثال)(?=[\s,:،]|$)/iu;

export function stepsFromNarration(text: string): string[] | null {
  const steps = text.split(/[,;،؛]/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (steps.length < 2 || steps.length > 6) return null;
  if (EXAMPLE_LEAD.test(steps[0])) return null;
  if (steps.some((s) => s.length > GRAPHIC_LIMITS.maxTextChars)) return null;
  return steps;
}
