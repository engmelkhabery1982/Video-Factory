import { ACCENT_PALETTE } from './brand.js';
import type {
  BackgroundVariant,
  BackgroundVariantId,
  CaptionStyleId,
  CtaAnimationId,
  ExplanationVariant,
  ExplanationVariantId,
  HookVariant,
  HookVariantId,
  TextPositionId,
  TransitionVariant,
  TransitionVariantId,
  VariantLibrary,
} from './types.js';

/* ------------------------------------------------------------------ */
/* HOOK VARIANTS (6+ required)                                        */
/* ------------------------------------------------------------------ */

export const HOOK_VARIANTS: HookVariant[] = [
  { id: 'question', label: 'Question Hook', fits: ['question', 'hook'], minSeconds: 4 },
  { id: 'surprising_number', label: 'Surprising Number', fits: ['comparison', 'data', 'hook'], minSeconds: 4 },
  { id: 'before_after', label: 'Before vs After', fits: ['comparison', 'hook'], minSeconds: 5 },
  { id: 'common_mistake', label: 'Common Mistake', fits: ['warning', 'hook'], minSeconds: 5 },
  { id: 'risk_warning', label: 'Risk / Warning', fits: ['warning', 'hook'], minSeconds: 5 },
  { id: 'scenario_story', label: 'Scenario / Story', fits: ['example', 'hook'], minSeconds: 6 },
  { id: 'document_zoom', label: 'Document Zoom', fits: ['table', 'example', 'hook'], minSeconds: 5 },
  { id: 'product_result', label: 'Product Result Preview', fits: ['product_proof', 'hook'], minSeconds: 5 },
];

/* ------------------------------------------------------------------ */
/* EXPLANATION VARIANTS (12 required)                                 */
/* ------------------------------------------------------------------ */

export const EXPLANATION_VARIANTS: ExplanationVariant[] = [
  { id: 'animated_checklist', label: 'Animated Checklist', fits: ['steps', 'summary', 'promise', 'data', 'example', 'warning'], prefers: ['light_technical', 'dashboard_ui'], shortsSafe: true },
  { id: 'number_comparison', label: 'Number Comparison', fits: ['comparison', 'data', 'question'], prefers: ['dark_grid', 'split_visual'], shortsSafe: true },
  { id: 'progressive_table', label: 'Progressive Table Reveal', fits: ['table', 'comparison', 'data', 'timeline'], prefers: ['light_technical', 'document_closeup'], shortsSafe: false },
  { id: 'timeline', label: 'Timeline', fits: ['timeline', 'steps', 'data', 'promise', 'comparison'], prefers: ['dark_grid', 'blueprint'], shortsSafe: true },
  { id: 'process_flow', label: 'Process Flow', fits: ['steps', 'promise', 'table', 'example', 'product_proof'], prefers: ['light_technical', 'blueprint'], shortsSafe: true },
  { id: 'document_annotation', label: 'Document Annotation', fits: ['example', 'table', 'myth', 'data'], prefers: ['document_closeup', 'site_footage'], shortsSafe: false },
  { id: 'site_footage_callouts', label: 'Site Footage with Callouts', fits: ['example', 'product_proof', 'data'], prefers: ['site_footage'], shortsSafe: false },
  { id: 'split_screen', label: 'Split Screen', fits: ['comparison', 'myth', 'warning', 'question', 'steps'], prefers: ['split_visual', 'dark_grid'], shortsSafe: true },
  { id: 'dashboard_demo', label: 'Dashboard Demo', fits: ['product_proof', 'data', 'comparison', 'promise'], prefers: ['dashboard_ui', 'site_footage'], shortsSafe: true },
  { id: 'chart_animation', label: 'Chart Animation', fits: ['data', 'comparison', 'timeline', 'example', 'summary', 'product_proof'], prefers: ['dark_grid', 'light_technical'], shortsSafe: true },
  { id: 'myth_vs_reality', label: 'Myth vs Reality', fits: ['myth', 'comparison', 'question', 'warning', 'product_proof'], prefers: ['split_visual', 'blueprint'], shortsSafe: true },
  { id: 'problem_cause_solution', label: 'Problem -> Cause -> Solution', fits: ['promise', 'summary', 'steps', 'question', 'example', 'warning', 'timeline'], prefers: ['light_technical', 'dark_grid'], shortsSafe: true },
];

/* ------------------------------------------------------------------ */
/* TRANSITIONS (7 required)                                           */
/* ------------------------------------------------------------------ */

export const TRANSITION_VARIANTS: TransitionVariant[] = [
  { id: 'direct_cut', label: 'Direct Cut', frames: 0 },
  { id: 'push', label: 'Push', frames: 12 },
  { id: 'zoom', label: 'Zoom', frames: 14 },
  { id: 'mask_reveal', label: 'Mask Reveal', frames: 12 },
  { id: 'data_wipe', label: 'Data Wipe', frames: 10 },
  { id: 'document_page', label: 'Document / Page Transition', frames: 16 },
  { id: 'match_cut', label: 'Match Cut (number / shape)', frames: 12 },
];

/* ------------------------------------------------------------------ */
/* BACKGROUNDS (8 required)                                           */
/* ------------------------------------------------------------------ */

export const BACKGROUND_VARIANTS: BackgroundVariant[] = [
  { id: 'site_footage', label: 'Site Footage', maxContinuousSeconds: 15, needsMedia: true },
  { id: 'dark_grid', label: 'Dark Grid', maxContinuousSeconds: 15, needsMedia: false },
  { id: 'document_closeup', label: 'Document Close-up', maxContinuousSeconds: 15, needsMedia: true },
  { id: 'light_technical', label: 'Light Technical Layout', maxContinuousSeconds: 15, needsMedia: false },
  { id: 'blueprint', label: 'Blueprint Style', maxContinuousSeconds: 15, needsMedia: false },
  { id: 'dashboard_ui', label: 'Dashboard UI', maxContinuousSeconds: 15, needsMedia: true },
  { id: 'full_typography', label: 'Full-screen Typography', maxContinuousSeconds: 12, needsMedia: false },
  { id: 'split_visual', label: 'Split Visual Layout', maxContinuousSeconds: 15, needsMedia: false },
];

/* ------------------------------------------------------------------ */
/* MISC VARIANT AXES                                                  */
/* ------------------------------------------------------------------ */

export const TEXT_POSITIONS: TextPositionId[] = [
  'top_left',
  'top_center',
  'center',
  'left_column',
  'right_column',
  'lower_third',
  'bottom_center',
  'full_frame_center',
];

export const CAPTION_STYLES: CaptionStyleId[] = ['boxed_center', 'word_pop', 'lower_band', 'side_panel', 'highlight_box'];

export const CTA_ANIMATIONS: CtaAnimationId[] = ['slide_in', 'typewriter', 'counter_up', 'scale_pop', 'wipe_reveal'];

export const VARIANT_LIBRARY: VariantLibrary = {
  hooks: HOOK_VARIANTS,
  explanations: EXPLANATION_VARIANTS,
  transitions: TRANSITION_VARIANTS,
  backgrounds: BACKGROUND_VARIANTS,
  textPositions: TEXT_POSITIONS,
  captionStyles: CAPTION_STYLES,
  ctaAnimations: CTA_ANIMATIONS,
  accents: ACCENT_PALETTE,
};

export function explanationById(id: ExplanationVariantId): ExplanationVariant {
  const v = EXPLANATION_VARIANTS.find((x) => x.id === id);
  if (!v) throw new Error(`Unknown explanation variant: ${id}`);
  return v;
}

export function hookById(id: HookVariantId): HookVariant {
  const v = HOOK_VARIANTS.find((x) => x.id === id);
  if (!v) throw new Error(`Unknown hook variant: ${id}`);
  return v;
}

export function backgroundById(id: BackgroundVariantId): BackgroundVariant {
  const v = BACKGROUND_VARIANTS.find((x) => x.id === id);
  if (!v) throw new Error(`Unknown background variant: ${id}`);
  return v;
}

export function transitionFrames(id: TransitionVariantId): number {
  return TRANSITION_VARIANTS.find((x) => x.id === id)?.frames ?? 0;
}
