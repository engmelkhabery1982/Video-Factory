/**
 * Local-rules planning for the Milestone 2 draft (no text provider).
 *
 * Every rule here is a deterministic heuristic over the SUPPLIED words. The
 * output is labelled `local_rules` by the API. Narration text is only sliced
 * and reordered, never rewritten, so supplied words, facts and scripture stay
 * exactly as entered.
 */
import {
  languageAllowsTechnique,
  VISUAL_TECHNIQUES,
  type VisualLanguageId,
  type VisualTechniqueId,
} from '../visual-language.js';
import { GRAPHIC_LIMITS, type EditorGraphic } from '../editor/graphics.js';
import {
  buildKineticGraphic,
  buildProcessGraphic,
  graphicProblems,
  phrasesFromNarration,
  stepsFromNarration,
  type GraphicPacing,
} from '../editor/graphic-builders.js';
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

/** One role's visual request. The technique decides what the renderer makes; framing and motion apply to stills. */
export interface RoleVisual {
  /** Set for visual-language treatments. Legacy treatments carry none, and their output has no technique. */
  technique?: VisualTechniqueId;
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
  /** Pacing of the treatment's procedural graphics. Timing only; narration and captions never move. Legacy: none. */
  pacing?: GraphicPacing;
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

/**
 * Three treatments per profile. Each differs from the others in TECHNIQUE per role and in PACING, not only in
 * labels. Order, beats and speaker roles are kept as before; the planner never rewrites narration.
 * Religious treatments invent no quotations or depictions: pictures are owner images, text is supplied passage text.
 */
const CARD = 'card overlay (text card is not rendered; the supplied words still appear as captions)';

/**
 * Legacy treatments (no visual language). This table is frozen at its pre-language values so that drafts made
 * without a language keep their treatments, motion and gap notes exactly. Visual-language treatments use SPECS.
 */
const LEGACY_SPECS: Record<FactoryContentProfile, TreatmentSpec[]> = {
  religious: [
    {
      id: 'rel-reading-sequence',
      title: 'Reading sequence',
      rationale: 'Keeps the supplied order. Each passage is read in the reader voice over a held frame, so scripture is never cut away from its own speech. Reflections use a slow push on a calm image.',
      order: (r) => r.slice(),
      beat: { passage: 'passage_reading', reflection: 'reflection' },
      speaker: { passage: 'reader', reflection: 'narrator' },
      visual: {
        passage: { intent: 'Held frame on one calm owner image. The renderer reads the supplied passage over it; the picture carries no lettering.', framing: 'full', motion: 'none' },
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
        passage: { intent: 'Close framing on the owner image. The renderer reads the passage; the picture carries no lettering.', framing: 'tight', motion: 'none' },
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
        passage: { intent: 'Centred held frame in the reader voice. Nothing else competes with the picture.', framing: 'full', motion: 'none' },
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

const SPECS: Record<FactoryContentProfile, TreatmentSpec[]> = {
  religious: [
    {
      id: 'rel-reading-sequence',
      title: 'Reading sequence',
      rationale: 'Keeps the supplied order. Each passage is read in the reader voice over a held owner still, so scripture is never cut away from its own speech. Reflections use a slow push on a calm still. Held pacing.',
      pacing: 'held',
      order: (r) => r.slice(),
      beat: { passage: 'passage_reading', reflection: 'reflection' },
      speaker: { passage: 'reader', reflection: 'narrator' },
      visual: {
        passage: { technique: 'still_image', intent: 'Held frame on one calm owner image. The reader voice speaks over it; the picture carries no lettering.', framing: 'full', motion: 'none' },
        reflection: { technique: 'still_image', intent: 'Slow push on an owner image chosen for the subject of this reflection.', framing: 'full', motion: 'slow_push' },
      },
    },
    {
      id: 'rel-reflection-then-anchor',
      title: 'Reflection first, passage as anchor',
      rationale: 'Introduces the meaning first as key words that appear in order on a calm background, then closes on the passage over a tight owner still in the reader voice. Measured pacing.',
      pacing: 'measured',
      order: stableByRank({ reflection: 0, passage: 1 }),
      beat: { reflection: 'reflection_opening', passage: 'passage_anchor' },
      speaker: { reflection: 'narrator', passage: 'reader' },
      visual: {
        reflection: { technique: 'kinetic_text', intent: 'Key words of the supplied reflection appear in order on a calm background, with no picture lettering.', framing: 'full', motion: 'none' },
        passage: { technique: 'still_image', intent: 'Close framing on the owner image while the passage is read. The renderer reads the passage; the picture carries no lettering.', framing: 'tight', motion: 'none' },
      },
    },
    {
      id: 'rel-passage-at-centre',
      title: 'Reflection frames a central passage',
      rationale: 'Opens on the first reflection on a still, places every passage at the centre as phrases that appear one at a time, and returns to reflection at the close. Brisk pacing. Passage phrases need no quotation marks; a line that has them is refused with a reason.',
      pacing: 'brisk',
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
        reflection: { technique: 'still_image', intent: 'Still owner image for the reflection; no motion so the frame sets the tone.', framing: 'full', motion: 'none' },
        passage: { technique: 'kinetic_text', intent: 'Phrases of the supplied passage appear one at a time, quick and centred, in the reader voice. Nothing else competes.', framing: 'full', motion: 'none' },
      },
    },
  ],
  educational: [
    {
      id: 'edu-problem-example-action',
      title: 'Problem, example, action',
      rationale: 'Names the problem as words first, works one example through with exact supplied values as bars, then ends on the action as a phrase sequence. Measured pacing.',
      pacing: 'measured',
      order: stableByRank({ problem: 0, explanation: 1, example: 2, action: 3 }),
      beat: { problem: 'problem', explanation: 'explanation', example: 'example', action: 'action' },
      speaker: { problem: 'learner', explanation: 'instructor', example: 'instructor', action: 'instructor' },
      visual: {
        problem: { technique: 'kinetic_text', intent: 'The problem as words on screen, before it is explained.', framing: 'full', motion: 'none' },
        explanation: { technique: 'process_path', intent: 'Ordered steps of the explanation, one node per step, with a marker that travels once along them.', framing: 'full', motion: 'none' },
        example: { technique: 'numeric_comparison', intent: 'Bars with the exact values supplied for the example. Values are entered by the owner; nothing is estimated.', framing: 'full', motion: 'none' },
        action: { technique: 'kinetic_text', intent: 'The single action as phrases, one after another.', framing: 'full', motion: 'none' },
      },
    },
    {
      id: 'edu-question-walkthrough',
      title: 'Question-led walkthrough',
      rationale: 'Opens on the question as words, walks through the explanation and example as ordered steps, and closes on the action as a recap. Brisk pacing. The learner voice asks; the instructor answers.',
      pacing: 'brisk',
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
        problem: { technique: 'kinetic_text', intent: 'The question as words, one phrase at a time.', framing: 'full', motion: 'none' },
        explanation: { technique: 'process_path', intent: 'Walkthrough steps of the explanation as ordered nodes; the marker moves along them.', framing: 'full', motion: 'none' },
        example: { technique: 'process_path', intent: 'Steps of the example as a short ordered walkthrough, framed tight on the steps.', framing: 'tight', motion: 'none' },
        action: { technique: 'kinetic_text', intent: 'Recap of the action as the final phrases.', framing: 'full', motion: 'none' },
      },
    },
    {
      id: 'edu-worked-example-first',
      title: 'Worked example first',
      rationale: 'Shows the exact values of the example first as bars, then the original condition as a held still, then the explanation as steps. The learner demonstrates; the instructor explains why it works. Held pacing.',
      pacing: 'held',
      order: stableByRank({ example: 0, problem: 1, explanation: 2, action: 3 }),
      beat: { example: 'worked_example', problem: 'problem_context', explanation: 'explanation', action: 'action' },
      speaker: { example: 'learner', problem: 'instructor', explanation: 'instructor', action: 'learner' },
      visual: {
        example: { technique: 'numeric_comparison', intent: 'The finished result of the example as bars with the exact supplied values first.', framing: 'full', motion: 'none' },
        problem: { technique: 'still_image', intent: 'Held owner image of the original condition, to compare with the result.', framing: 'full', motion: 'none' },
        explanation: { technique: 'process_path', intent: 'Ordered steps that explain the reason behind the result.', framing: 'full', motion: 'none' },
        action: { technique: 'kinetic_text', intent: 'The action to repeat on the viewer\'s own project, as phrases.', framing: 'full', motion: 'none' },
      },
    },
  ],
  promotional: [
    {
      id: 'promo-problem-proof-cta',
      title: 'Problem, proof, call to action',
      rationale: 'States the problem on an owner still, shows the benefit on a real recording, shows the proof, and closes on one call to action as words. Measured pacing. The product appears only after the problem is named.',
      pacing: 'measured',
      order: stableByRank({ problem: 0, benefit: 1, proof: 2, cta: 3 }),
      beat: { problem: 'problem', benefit: 'benefit', proof: 'proof', cta: 'cta' },
      speaker: { problem: 'host', benefit: 'host', proof: 'customer', cta: 'host' },
      visual: {
        problem: { technique: 'still_image', intent: 'Owner image of the problem as the viewer meets it.', framing: 'full', motion: 'none' },
        benefit: { technique: 'screen_recording', intent: 'Real product screen recording that shows the benefit named in the narration. Needs a supplied recording.', framing: 'full', motion: 'none', needsFootage: true },
        proof: { technique: 'still_image', intent: 'Owner evidence frame with the figure or result exactly as supplied.', framing: 'full', motion: 'none' },
        cta: { technique: 'kinetic_text', intent: 'One call to action as words on a plain background.', framing: 'full', motion: 'none' },
      },
    },
    {
      id: 'promo-demo-first',
      title: 'Demo first',
      rationale: 'Opens on the real recording as a demonstration, steps back to the problem on a slow pan, shows the proof as supplied figures, and closes on one call to action. Brisk pacing.',
      pacing: 'brisk',
      order: stableByRank({ benefit: 0, problem: 1, proof: 2, cta: 3 }),
      beat: { benefit: 'demo', problem: 'problem_return', proof: 'proof', cta: 'cta' },
      speaker: { benefit: 'host', problem: 'host', proof: 'customer', cta: 'host' },
      visual: {
        benefit: { technique: 'screen_recording', intent: 'Real product screen recording as the opening demonstration. Needs a supplied recording.', framing: 'tight', motion: 'none', needsFootage: true },
        problem: { technique: 'still_image', intent: 'Return to the everyday problem the demonstration solved, with a slow pan.', framing: 'full', motion: 'pan_left' },
        proof: { technique: 'kinetic_text', intent: 'Figures from the proof as words, exactly as supplied.', framing: 'full', motion: 'none' },
        cta: { technique: 'kinetic_text', intent: 'One call to action as words.', framing: 'full', motion: 'none' },
      },
    },
    {
      id: 'promo-proof-first',
      title: 'Proof first',
      rationale: 'Opens on evidence on a slow push, names the problem as words, shows the benefit on supplied footage, and finishes on one call to action. Held pacing.',
      pacing: 'held',
      order: stableByRank({ proof: 0, problem: 1, benefit: 2, cta: 3 }),
      beat: { proof: 'proof_open', problem: 'problem', benefit: 'benefit', cta: 'cta' },
      speaker: { proof: 'customer', problem: 'host', benefit: 'host', cta: 'host' },
      visual: {
        proof: { technique: 'still_image', intent: 'Owner evidence frame opens the video, before any product claim.', framing: 'full', motion: 'slow_push' },
        problem: { technique: 'kinetic_text', intent: 'The problem as words, one phrase at a time.', framing: 'full', motion: 'none' },
        benefit: { technique: 'footage_clip', intent: 'Supplied product footage for the benefit. No generated footage.', framing: 'full', motion: 'none' },
        cta: { technique: 'kinetic_text', intent: 'One call to action as words.', framing: 'full', motion: 'none' },
      },
    },
  ],
};

/**
 * The renderer executes stills with crop framing and slow_push / pan motion.
 * Footage clips take no motion. Anything the intent asks for beyond that is a gap.
 */
export function visualDecisionFor(visual: Pick<RoleVisual, 'intent' | 'framing' | 'motion' | 'needsFootage' | 'gaps'>, kind: 'image' | 'video' | null, pacing?: GraphicPacing): FactoryVisualDecision {
  const unexecuted = [...(visual.gaps ?? [])];
  let motion = visual.motion;
  if (kind === 'video' && motion !== 'none') {
    unexecuted.push(`${motion} on footage (the renderer applies motion to stills only; the clip plays as supplied)`);
    motion = 'none';
  }
  if (visual.needsFootage && kind !== 'video') {
    unexecuted.push('screen recording: a still image is shown, not a recording. Supply footage for this scene.');
  }
  const decision: FactoryVisualDecision = { framing: visual.framing, motion, unexecuted };
  if (pacing !== undefined) decision.pacing = pacing;
  return decision;
}

/** Treatment ids are stable and profile-scoped. */
export function treatmentIdsFor(profile: FactoryContentProfile): string[] {
  return SPECS[profile].map((s) => s.id);
}

/** The visual request of one role in one treatment. Used by tests and the UI copy. */
export function visualRequestFor(profile: FactoryContentProfile, treatmentId: string, role: string): RoleVisual | null {
  return SPECS[profile].find((t) => t.id === treatmentId)?.visual[role] ?? null;
}

/** Pacing of one treatment. Used by tests and the UI copy. */
export function pacingFor(profile: FactoryContentProfile, treatmentId: string): GraphicPacing | null {
  return SPECS[profile].find((t) => t.id === treatmentId)?.pacing ?? null;
}

export interface BuildTreatmentsOptions {
  /** Keep the supplied narration order in every treatment (supplied audio or supplied times). */
  orderLocked?: boolean;
  /** Kind of each assigned visual, to decide what the renderer can execute. */
  assetKinds?: Map<string, 'image' | 'video'>;
  /**
   * Project visual language. When set, every shot gets a technique the language allows, or an explicit reason
   * why it has none. When null (legacy), shots carry no technique and behave as before.
   */
  visualLanguage?: VisualLanguageId | null;
  format?: 'landscape' | 'portrait';
}

/**
 * Derive a procedural graphic from SUPPLIED words only. Returns the graphic (actions empty: the shot duration is not
 * known at planning time) or the reason no graphic can be made. Never invents text, values or quotations.
 */
export function deriveGraphic(
  technique: VisualTechniqueId,
  narration: string,
  profile: FactoryContentProfile,
  format: 'landscape' | 'portrait',
): { graphic: EditorGraphic | null; reason: string | null } {
  const direction = detectLanguage(narration) === 'ar' ? 'rtl' : 'ltr';
  if (technique === 'kinetic_text') {
    const phrases = phrasesFromNarration(narration);
    if (!phrases) return { graphic: null, reason: 'This line is too long for kinetic text (more than eight phrases). Shorten the line or choose another technique for this shot.' };
    const graphic = buildKineticGraphic({ title: '', items: phrases }, format, null, { direction, pacing: 'measured' });
    const problems = graphicProblems(graphic, GRAPHIC_LIMITS.maxSec, format, profile);
    return problems.length ? { graphic: null, reason: problems[0] } : { graphic, reason: null };
  }
  if (technique === 'process_path') {
    const steps = stepsFromNarration(narration);
    if (!steps) return { graphic: null, reason: 'A process needs two to six steps in the supplied line, separated by commas or semicolons. A line that introduces an example is not a sequence: enter the steps for this shot.' };
    const graphic = buildProcessGraphic({ title: '', items: steps }, format, null, { direction });
    const problems = graphicProblems(graphic, GRAPHIC_LIMITS.maxSec, format, profile);
    return problems.length ? { graphic: null, reason: problems[0] } : { graphic, reason: null };
  }
  if (technique === 'numeric_comparison') {
    return { graphic: null, reason: 'Enter the supplied values, labels and scale for this shot. No values are invented from the narration.' };
  }
  if (technique === 'actor_action') {
    return { graphic: null, reason: 'Enter the 2D action steps for this shot. The narration does not define a pose.' };
  }
  return { graphic: null, reason: null };
}

/**
 * Build the three treatment alternatives for a draft. Every treatment contains every supplied unit exactly once,
 * with its supplied text unchanged. When the order is locked, treatments differ in technique, pacing and labels;
 * they never move supplied speech.
 */
export function buildTreatments(
  profile: FactoryContentProfile,
  units: FactoryPlanUnit[],
  opts: BuildTreatmentsOptions = {},
): FactoryTreatment[] {
  const roled = units.map((unit) => ({ unit, role: classifyUnit(profile, unit.narration) }));
  const locked = opts.orderLocked === true;
  const language = opts.visualLanguage ?? null;
  const format = opts.format ?? 'landscape';
  // No visual language: the frozen legacy treatments. A language: the language treatments.
  const specList = language === null ? LEGACY_SPECS[profile] : SPECS[profile];
  return specList.map((spec) => {
    const ordered = locked ? roled.slice() : spec.order(roled);
    const scenes: FactoryDraftScene[] = ordered.map(({ unit, role }) => {
      const visual = spec.visual[role] ?? { technique: 'still_image' as const, intent: 'Owner or library image chosen for this line.', framing: 'full' as const, motion: 'none' as const };
      // Only visual-language treatments carry a technique; a missing one is a still, as before.
      const requested: VisualTechniqueId = visual.technique ?? 'still_image';
      const hasAsset = Boolean(unit.assetId);
      const base: FactoryDraftScene = {
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
        assetOrigin: hasAsset ? (unit.assetOriginHint ?? 'supplied') : null,
        timingSource: unit.startSec !== null && unit.endSec !== null ? 'supplied' : 'unknown' as FactoryTimingSource,
        visualDecision: visualDecisionFor(visual, hasAsset ? (opts.assetKinds?.get(unit.assetId as string) ?? null) : null),
      };
      if (language === null) return base;
      // A supplied picture or clip is the owner's binding. It is kept, and a planned graphic never replaces it
      // silently: the row takes the matching media technique and says which planned technique was not used.
      // Only an explicit binding (a storyboard or reviewed scene picture, with no planner origin hint) is the owner's.
      // A picture the planner spread from the pool does not override a planned graphic.
      // A planner-spread clip on a planned still is footage, not a still: the same rule, reported the same way.
      const kindOfBound = hasAsset ? (opts.assetKinds?.get(unit.assetId as string) ?? 'image') : null;
      const ownerBound = hasAsset && unit.assetOriginHint === undefined;
      if (hasAsset && (ownerBound || (requested === 'still_image' && kindOfBound === 'video'))) {
        const kind: 'image' | 'video' = kindOfBound ?? 'image';
        const mediaTechnique = kind === 'video' ? 'footage_clip' : 'still_image';
        const notes = [...visualDecisionFor(visual, kind, undefined).unexecuted];
        if (requested !== mediaTechnique) {
          const noun = kind === 'video' ? 'clip' : 'picture';
          notes.push(`The ${noun} ${ownerBound ? 'supplied for' : 'assigned to'} this shot is kept. ${VISUAL_TECHNIQUES[requested].label} is not used here.`);
        }
        const decision = { ...visualDecisionFor(visual, kind, undefined), unexecuted: notes };
        if (!languageAllowsTechnique(language, mediaTechnique)) {
          decision.unexecuted = [...notes, `${VISUAL_TECHNIQUES[mediaTechnique].label} is not part of this visual language. Choose a technique for this shot.`];
          return { ...base, technique: null, graphic: null, visualDecision: decision };
        }
        return { ...base, technique: mediaTechnique, graphic: null, visualDecision: decision };
      }
      // Visual language is set: the shot carries a technique, or an explicit reason it has none.
      if (!languageAllowsTechnique(language, requested)) {
        const label = VISUAL_TECHNIQUES[requested].label;
        return {
          ...base,
          technique: null,
          graphic: null,
          visualDecision: { ...visualDecisionFor(visual, null, undefined), unexecuted: [`${label} is not part of this visual language. Choose a technique for this shot.`] },
        };
      }
      const technique = requested;
      const tech = VISUAL_TECHNIQUES[technique];
      if (tech.engine === 'procedural_svg') {
        const derived = deriveGraphic(technique, unit.narration, profile, format);
        const decision = visualDecisionFor(visual, null, spec.pacing);
        if (derived.reason) decision.unexecuted = [...decision.unexecuted, derived.reason];
        return { ...base, assetId: null, assetOrigin: null, technique, graphic: derived.graphic, visualDecision: decision };
      }
      return { ...base, technique, graphic: null };
    });
    return {
      id: spec.id,
      title: spec.title,
      rationale: locked
        ? `${spec.rationale} Scene order is fixed to the supplied narration order, so this treatment varies techniques, pacing and labels only.`
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
