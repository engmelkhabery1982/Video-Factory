/**
 * Local-rules planning for the Milestone 2 draft (no text provider).
 *
 * Every rule here is a deterministic heuristic over the SUPPLIED words. The
 * output is labelled `local_rules` by the API. Narration text is only sliced
 * and reordered, never rewritten, so supplied words, facts and scripture stay
 * exactly as entered.
 */
import type {
  FactoryContentProfile,
  FactoryDraftScene,
  FactoryFraming,
  FactoryLanguage,
  FactoryTimingSource,
  FactoryTreatment,
  FactoryVisualDecision,
} from './contract.js';

/** Maximum units accepted from one script. Bounds planning and editor size. */
export const FACTORY_MAX_UNITS = 60;

export interface FactoryPlanUnit {
  id: string;
  narration: string;
  language: FactoryLanguage;
  speakerHint: string | null;
  assetId: string | null;
  /** Where the asset came from when the planner fulfilled it. */
  assetOriginHint?: 'supplied' | 'library';
  startSec: number | null;
  endSec: number | null;
  locked: boolean;
  /** Where the narration came from. Generated narration is editable until apply; supplied narration is immutable. */
  /** 'derived' marks narration rewritten in a derived draft. It is unapproved until reviewed. */
  origin?: 'supplied' | 'generated' | 'derived';
}

/** Speaker roles per profile. Roles are the ids a treatment assigns by default. */
export const FACTORY_SPEAKER_ROLES: Record<FactoryContentProfile, readonly string[]> = {
  religious: ['reader', 'narrator'],
  educational: ['instructor', 'learner'],
  promotional: ['host', 'customer'],
};

/**
 * Split a supplied script into narration units. Lines are kept as boundaries.
 * Each unit ends at sentence punctuation (Latin or Arabic). Text is trimmed at
 * the edges only.
 */
export function splitNarrationUnits(script: string): string[] {
  const units: string[] = [];
  for (const line of script.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pieces = trimmed.match(/[^.!?؟۔]+[.!?؟۔]+|[^.!?؟۔]+$/g) ?? [trimmed];
    for (const piece of pieces) {
      const t = piece.trim();
      if (t) units.push(t);
    }
  }
  return units;
}

export function detectLanguage(text: string): FactoryLanguage {
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (/[A-Za-z]/.test(text)) return 'en';
  return 'und';
}

/** Classify one unit into a beat role for the profile. Heuristic, not semantic. */
export function classifyUnit(profile: FactoryContentProfile, text: string): string {
  if (profile === 'religious') {
    // \b is ASCII-only in JavaScript, so Arabic words are matched as substrings.
    return /[﴿﴾«»"“”]|قال|يقول|تعالى/.test(text) ? 'passage' : 'reflection';
  }
  if (profile === 'educational') {
    if (/\?|؟|\bproblem\b|\bmistake\b|\bissue\b|\brisk\b|\b(lose|lost|fail|fails|delay|delays|waste|wrong)\b|مشكلة|خطأ|مشكل/i.test(text)) return 'problem';
    if (/\bexample\b|\bfor instance\b|\be\.g\./i.test(text) || /مثال|على سبيل/.test(text)) return 'example';
    if (/\bstep\b|\bcheck\b|\bchoose\b|\bcreate\b|\binstall\b|\buse\b|\bdo\b|\bwrite\b|\bconfirm\b|\brecord\b|\bset\b|اتبع|خطوة|تحقق|اختر|ابدأ|افعل|استخدم|اكتب/i.test(text)) return 'action';
    return 'explanation';
  }
  if (/\bcall\b|\bbook\b|\bvisit\b|\bdownload\b|\bcontact\b|اتصل|احجز|زر|سجل/i.test(text)) return 'cta';
  if (/%|\d|\bresults?\b|\bcustomers?\b|\bproof\b|عميل|نتائج/i.test(text)) return 'proof';
  if (/\bproblem\b|\bchallenge\b|\bcost\b|مشكلة|تحدي/i.test(text)) return 'problem';
  return 'benefit';
}

/** One role's visual request. Only `framing` and `motion` reach the renderer. */
export interface RoleVisual {
  intent: string;
  framing: FactoryFraming;
  motion: FactoryVisualDecision['motion'];
  /** The intent needs footage of a live screen. A still image cannot satisfy it. */
  needsFootage?: boolean;
  /** Requested features the renderer does not execute. Reported, never applied. */
  gaps?: string[];
}

interface TreatmentSpec {
  id: string;
  title: string;
  rationale: string;
  /** Returns the units in treatment order, with their role for each. */
  order: (roled: Array<{ unit: FactoryPlanUnit; role: string }>) => Array<{ unit: FactoryPlanUnit; role: string }>;
  beat: Record<string, string>;
  speaker: Record<string, string>;
  visual: Record<string, RoleVisual>;
}

/** Stable sort of roled units by a rank map. Unknown roles sort last, in source order. */
function stableByRank(rank: Record<string, number>) {
  return (items: Array<{ unit: FactoryPlanUnit; role: string }>) => items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (rank[a.item.role] ?? 99) - (rank[b.item.role] ?? 99) || a.index - b.index)
    .map((x) => x.item);
}

const CARD = 'card overlay (text card is not rendered; the supplied words still appear as captions)';

const SPECS: Record<FactoryContentProfile, TreatmentSpec[]> = {
  religious: [
    {
      id: 'rel-reading-sequence',
      title: 'Reading sequence',
      rationale: 'Keeps the supplied order. Each passage is read in the reader voice over a held frame, so scripture is never cut away from its own speech. Reflections use a slow push on a calm image.',
      order: (r) => r.slice(),
      beat: { passage: 'passage_reading', reflection: 'reflection' },
      speaker: { passage: 'reader', reflection: 'narrator' },
      visual: {
        passage: { intent: 'Held frame on one calm owner image. The supplied passage is the only caption; no wording is added.', framing: 'full', motion: 'none' },
        reflection: { intent: 'Slow push on an owner image chosen for the subject of this reflection.', framing: 'full', motion: 'slow_push' },
      },
    },
    {
      id: 'rel-reflection-then-anchor',
      title: 'Reflection first, passage as anchor',
      rationale: 'Introduces the meaning in the narrator voice first, then closes on the passages in the reader voice. Visuals open wide and tighten onto the passage caption at the end.',
      order: stableByRank({ reflection: 0, passage: 1 }),
      beat: { reflection: 'reflection_opening', passage: 'passage_anchor' },
      speaker: { reflection: 'narrator', passage: 'reader' },
      visual: {
        reflection: { intent: 'Wide establishing owner image while the meaning is introduced.', framing: 'full', motion: 'none' },
        passage: { intent: 'Close framing on the owner image. The passage text is the only caption on screen.', framing: 'tight', motion: 'none' },
      },
    },
    {
      id: 'rel-passage-at-centre',
      title: 'Reflection frames a central passage',
      rationale: 'Opens on the first reflection, places every passage at the centre in the reader voice, and returns to reflection at the close. The passage is the middle of the arc, not the opening.',
      order: (r) => {
        const firstReflection = r.findIndex((x) => x.role === 'reflection');
        const head = firstReflection >= 0 ? [r[firstReflection]] : [];
        const rest = r.filter((_, i) => i !== firstReflection);
        const passages = rest.filter((x) => x.role === 'passage');
        const tail = rest.filter((x) => x.role !== 'passage');
        return [...head, ...passages, ...tail];
      },
      beat: { reflection: 'reflection_frame', passage: 'passage_centre' },
      speaker: { reflection: 'narrator', passage: 'reader' },
      visual: {
        reflection: { intent: 'Still owner image with the reflection caption; no motion so the frame sets the tone.', framing: 'full', motion: 'none' },
        passage: { intent: 'Centred held frame in the reader voice. Nothing else competes with the passage text.', framing: 'full', motion: 'none' },
      },
    },
  ],
  educational: [
    {
      id: 'edu-problem-example-action',
      title: 'Problem, example, action',
      rationale: 'Names the problem first, works one example through on screen, then ends on the action the viewer can take. Each unit is placed by its role, so the structure is visible in the timeline.',
      order: stableByRank({ problem: 0, explanation: 1, example: 2, action: 3 }),
      beat: { problem: 'problem', explanation: 'explanation', example: 'example', action: 'action' },
      speaker: { problem: 'learner', explanation: 'instructor', example: 'instructor', action: 'instructor' },
      visual: {
        problem: { intent: 'Show the failing condition on the owner image so the problem is seen before it is explained.', framing: 'full', motion: 'none' },
        explanation: { intent: 'Owner image that names the concept; one label per idea.', framing: 'full', motion: 'none' },
        example: { intent: 'Walk through the example on screen, one highlighted step per scene.', framing: 'tight', motion: 'none', needsFootage: true, gaps: ['per-step highlight (not rendered from the treatment)'] },
        action: { intent: 'Checklist card with the single action and where to apply it.', framing: 'full', motion: 'none', gaps: [CARD] },
      },
    },
    {
      id: 'edu-question-walkthrough',
      title: 'Question-led walkthrough',
      rationale: 'Opens on the question, walks through the explanation and example in the supplied order, and closes on the final action as a recap. The learner voice asks; the instructor answers.',
      order: (r) => {
        const question = r.find((x) => x.role === 'problem') ?? r[0];
        const rest = r.filter((x) => x !== question);
        const recap = [...rest].reverse().find((x) => x.role === 'action');
        const steps = rest.filter((x) => x.role === 'action' && x !== recap);
        const others = rest.filter((x) => x.role !== 'action');
        return [question, ...steps, ...others, ...(recap ? [recap] : [])];
      },
      beat: { problem: 'question', explanation: 'walkthrough_explanation', example: 'walkthrough_example', action: 'walkthrough_step' },
      speaker: { problem: 'learner', explanation: 'instructor', example: 'learner', action: 'instructor' },
      visual: {
        problem: { intent: 'Full-frame question card on the owner image.', framing: 'full', motion: 'none', gaps: ['question card (text card is not rendered)'] },
        explanation: { intent: 'Walkthrough step on the owner image; one highlight per step.', framing: 'full', motion: 'none', gaps: ['per-step highlight (not rendered from the treatment)'] },
        example: { intent: 'Screen step for the example; the result is shown beside the input.', framing: 'tight', motion: 'none', needsFootage: true, gaps: ['result beside the input (split view is not rendered)'] },
        action: { intent: 'Recap checklist with the action as the final line.', framing: 'full', motion: 'none', gaps: [CARD] },
      },
    },
    {
      id: 'edu-worked-example-first',
      title: 'Worked example first',
      rationale: 'Shows the result of the example before the problem is explained, then returns to the original condition. The learner demonstrates the example; the instructor explains why it works.',
      order: stableByRank({ example: 0, problem: 1, explanation: 2, action: 3 }),
      beat: { example: 'worked_example', problem: 'problem_context', explanation: 'explanation', action: 'action' },
      speaker: { example: 'learner', problem: 'instructor', explanation: 'instructor', action: 'learner' },
      visual: {
        example: { intent: 'Show the finished result of the example on the owner screenshot first.', framing: 'full', motion: 'none' },
        problem: { intent: 'Return to the original condition in the same frame to compare it with the result.', framing: 'full', motion: 'pan_right', gaps: ['side-by-side comparison (split view is not rendered)'] },
        explanation: { intent: 'Owner image that explains the reason behind the result.', framing: 'full', motion: 'none' },
        action: { intent: 'Checklist card with the action to repeat on the viewer\'s own project.', framing: 'full', motion: 'none', gaps: [CARD] },
      },
    },
  ],
  promotional: [
    {
      id: 'promo-problem-proof-cta',
      title: 'Problem, proof, call to action',
      rationale: 'States the problem, shows the proof, and closes on one call to action. The product appears only after the problem is named.',
      order: stableByRank({ problem: 0, benefit: 1, proof: 2, cta: 3 }),
      beat: { problem: 'problem', benefit: 'benefit', proof: 'proof', cta: 'cta' },
      speaker: { problem: 'host', benefit: 'host', proof: 'customer', cta: 'host' },
      visual: {
        problem: { intent: 'Owner image of the problem as the viewer meets it.', framing: 'full', motion: 'none' },
        benefit: { intent: 'Product screen that shows the benefit named in the narration.', framing: 'full', motion: 'slow_push', needsFootage: true },
        proof: { intent: 'Owner evidence frame with the figure or result exactly as supplied.', framing: 'full', motion: 'none' },
        cta: { intent: 'Single call-to-action card; nothing else on screen.', framing: 'full', motion: 'none', gaps: [CARD] },
      },
    },
    {
      id: 'promo-demo-first',
      title: 'Demo first',
      rationale: 'Opens on the product benefit as a demonstration, then steps back to the problem it solves, then proof and one call to action.',
      order: stableByRank({ benefit: 0, problem: 1, proof: 2, cta: 3 }),
      beat: { benefit: 'demo', problem: 'problem_return', proof: 'proof', cta: 'cta' },
      speaker: { benefit: 'host', problem: 'host', proof: 'customer', cta: 'host' },
      visual: {
        benefit: { intent: 'Live product screen as the opening demonstration.', framing: 'tight', motion: 'none', needsFootage: true },
        problem: { intent: 'Return to the everyday problem the demonstration solved.', framing: 'full', motion: 'pan_left' },
        proof: { intent: 'Owner evidence frame with the supplied figure.', framing: 'full', motion: 'none' },
        cta: { intent: 'Single call-to-action card.', framing: 'full', motion: 'none', gaps: [CARD] },
      },
    },
    {
      id: 'promo-proof-first',
      title: 'Proof first',
      rationale: 'Opens on evidence from a customer voice, names the problem it answers, and finishes on the benefit and one call to action.',
      order: stableByRank({ proof: 0, problem: 1, benefit: 2, cta: 3 }),
      beat: { proof: 'proof_open', problem: 'problem', benefit: 'benefit', cta: 'cta' },
      speaker: { proof: 'customer', problem: 'host', benefit: 'host', cta: 'host' },
      visual: {
        proof: { intent: 'Owner evidence frame opens the video, before any product claim.', framing: 'full', motion: 'slow_push' },
        problem: { intent: 'Owner image of the situation the evidence refers to.', framing: 'full', motion: 'none' },
        benefit: { intent: 'Product screen for the benefit.', framing: 'full', motion: 'none', needsFootage: true },
        cta: { intent: 'Single call-to-action card.', framing: 'full', motion: 'none', gaps: [CARD] },
      },
    },
  ],
};

/**
 * The renderer executes stills with crop framing and slow_push / pan motion.
 * Footage clips take no motion. Anything the intent asks for beyond that is a gap.
 */
export function visualDecisionFor(visual: RoleVisual, kind: 'image' | 'video' | null): FactoryVisualDecision {
  const unexecuted = [...(visual.gaps ?? [])];
  let motion = visual.motion;
  if (kind === 'video' && motion !== 'none') {
    unexecuted.push(`${motion} on footage (the renderer applies motion to stills only; the clip plays as supplied)`);
    motion = 'none';
  }
  if (visual.needsFootage && kind !== 'video') {
    unexecuted.push('screen recording: a still image is shown, not a recording. Supply footage for this scene.');
  }
  return { framing: visual.framing, motion, unexecuted };
}

/** Treatment ids are stable and profile-scoped. */
export function treatmentIdsFor(profile: FactoryContentProfile): string[] {
  return SPECS[profile].map((s) => s.id);
}

/** The visual request of one role in one treatment. Used by tests and the UI copy. */
export function visualRequestFor(profile: FactoryContentProfile, treatmentId: string, role: string): RoleVisual | null {
  return SPECS[profile].find((t) => t.id === treatmentId)?.visual[role] ?? null;
}

export interface BuildTreatmentsOptions {
  /** Keep the supplied narration order in every treatment (supplied audio or supplied times). */
  orderLocked?: boolean;
  /** Kind of each assigned visual, to decide what the renderer can execute. */
  assetKinds?: Map<string, 'image' | 'video'>;
}

/**
 * Build the three treatment alternatives for a draft. Every treatment contains
 * every supplied unit exactly once, with its supplied text unchanged. When the
 * order is locked, treatments differ only in beats, speaker labels and visual
 * decisions; they never move supplied speech.
 */
export function buildTreatments(
  profile: FactoryContentProfile,
  units: FactoryPlanUnit[],
  opts: BuildTreatmentsOptions = {},
): FactoryTreatment[] {
  const roled = units.map((unit) => ({ unit, role: classifyUnit(profile, unit.narration) }));
  const locked = opts.orderLocked === true;
  return SPECS[profile].map((spec) => {
    const ordered = locked ? roled.slice() : spec.order(roled);
    const scenes: FactoryDraftScene[] = ordered.map(({ unit, role }) => {
      const visual = spec.visual[role] ?? { intent: 'Owner or library image chosen for this line.', framing: 'full' as const, motion: 'none' as const };
      const kind = unit.assetId ? (opts.assetKinds?.get(unit.assetId) ?? null) : null;
      return {
        id: unit.id,
        narration: unit.narration,
        speakerId: unit.speakerHint ?? spec.speaker[role] ?? FACTORY_SPEAKER_ROLES[profile][0],
        visualIntent: visual.intent,
        assetId: unit.assetId,
        startSec: unit.startSec,
        endSec: unit.endSec,
        locked: unit.locked,
        sourceUnitId: unit.id,
        beat: spec.beat[role] ?? role,
        language: unit.language,
        assetOrigin: unit.assetId ? (unit.assetOriginHint ?? 'supplied') : null,
        timingSource: unit.startSec !== null && unit.endSec !== null ? 'supplied' : 'unknown' as FactoryTimingSource,
        visualDecision: visualDecisionFor(visual, kind),
      };
    });
    return {
      id: spec.id,
      title: spec.title,
      rationale: locked
        ? `${spec.rationale} Scene order is fixed to the supplied narration order, so this treatment varies visuals and labels only.`
        : spec.rationale,
      orderLocked: locked,
      structure: scenes.map((s) => s.beat),
      scenes,
    };
  });
}

/** Human-readable treatment check used by tests and the API warnings. */
export function treatmentOrders(treatments: FactoryTreatment[]): string[][] {
  return treatments.map((t) => t.scenes.map((s) => s.sourceUnitId));
}
