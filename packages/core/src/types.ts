/**
 * BuildTrack Video Factory - core domain types.
 *
 * Brand consistency is modelled separately from Visual storytelling so that the
 * same identity can be applied to many different-looking videos.
 */

/* ------------------------------------------------------------------ */
/* Project inputs (section 3 of the brief)                            */
/* ------------------------------------------------------------------ */

export type VideoType = 'long' | 'short';

/** Roles a script segment can play. Drives scene-variant selection (section 7). */
export type ScriptFunction =
  | 'hook'
  | 'promise'
  | 'question'
  | 'comparison'
  | 'steps'
  | 'timeline'
  | 'table'
  | 'warning'
  | 'product_proof'
  | 'data'
  | 'example'
  | 'myth'
  | 'summary'
  | 'cta';

export interface ProjectInput {
  videoId: string;
  videoType: VideoType;
  topic: string;
  targetAudience: string;
  mainProblem: string;
  viewerPromise: string;
  hook: string;
  script: string;
  keyNumbers: string[];
  keyPoints: string[];
  productName: string;
  productShots: string[];
  cta: string;
  voiceoverFile: string | null;
  brollFiles: string[];
  sourceReferences: string[];
  outputLanguage: string;
  brandPreset: string;
  /** Extra shorts (0-3). The brief allows up to 3 independent shorts per long video. */
  shortCount?: number;
}

/* ------------------------------------------------------------------ */
/* Variant library (section 6)                                        */
/* ------------------------------------------------------------------ */

export type HookVariantId =
  | 'question'
  | 'surprising_number'
  | 'before_after'
  | 'common_mistake'
  | 'risk_warning'
  | 'scenario_story'
  | 'document_zoom'
  | 'product_result';

export type ExplanationVariantId =
  | 'animated_checklist'
  | 'number_comparison'
  | 'progressive_table'
  | 'timeline'
  | 'process_flow'
  | 'document_annotation'
  | 'site_footage_callouts'
  | 'split_screen'
  | 'dashboard_demo'
  | 'chart_animation'
  | 'myth_vs_reality'
  | 'problem_cause_solution';

export type TransitionVariantId =
  | 'direct_cut'
  | 'push'
  | 'zoom'
  | 'mask_reveal'
  | 'data_wipe'
  | 'document_page'
  | 'match_cut';

export type BackgroundVariantId =
  | 'site_footage'
  | 'dark_grid'
  | 'document_closeup'
  | 'light_technical'
  | 'blueprint'
  | 'dashboard_ui'
  | 'full_typography'
  | 'split_visual';

export type TextPositionId =
  | 'top_left'
  | 'top_center'
  | 'center'
  | 'left_column'
  | 'right_column'
  | 'lower_third'
  | 'bottom_center'
  | 'full_frame_center';

export type CaptionStyleId = 'boxed_center' | 'word_pop' | 'lower_band' | 'side_panel' | 'highlight_box';

export type CtaAnimationId = 'slide_in' | 'typewriter' | 'counter_up' | 'scale_pop' | 'wipe_reveal';

export type SceneVariantId = ExplanationVariantId | HookVariantId | 'cta_card' | 'endcard';

export interface HookVariant {
  id: HookVariantId;
  label: string;
  /** Functions this hook is allowed to introduce. */
  fits: ScriptFunction[];
  /** Minimum seconds this hook is legible. */
  minSeconds: number;
}

export interface ExplanationVariant {
  id: ExplanationVariantId;
  label: string;
  fits: ScriptFunction[];
  /** Preferred background family for this variant. */
  prefers: BackgroundVariantId[];
  /** Shorts cannot show a shrunken landscape slide: variants marked true must be re-laid out natively. */
  shortsSafe: boolean;
}

export interface TransitionVariant {
  id: TransitionVariantId;
  label: string;
  /** duration of the transition in frames @30fps */
  frames: number;
}

export interface BackgroundVariant {
  id: BackgroundVariantId;
  label: string;
  /** max continuous seconds allowed for this background (section 8) */
  maxContinuousSeconds: number;
  needsMedia: boolean;
}

export interface VariantLibrary {
  hooks: HookVariant[];
  explanations: ExplanationVariant[];
  transitions: TransitionVariant[];
  backgrounds: BackgroundVariant[];
  textPositions: TextPositionId[];
  captionStyles: CaptionStyleId[];
  ctaAnimations: CtaAnimationId[];
  /** accent colors available per brand preset (section 8: "accent colors") */
  accents: Record<string, string[]>;
}

/* ------------------------------------------------------------------ */
/* Storyboard (section 13)                                            */
/* ------------------------------------------------------------------ */

export interface SceneReason {
  /** The rule from section 7 that fired, e.g. "narration compares two numbers". */
  detected: string;
  /** Which script segment / signal triggered it */
  evidence: string;
  /** Anti-repetition bookkeeping */
  notUsedRecently: string[];
  alternatives: SceneVariantId[];
}

export interface SceneContent {
  /** Short headline shown on screen (large type). */
  headline: string;
  /** Optional sub line. */
  subline?: string;
  /** Ordered data points to animate in. */
  items: string[];
  /** Big number to feature, e.g. "70%" */
  stat?: string | null;
  statLabel?: string | null;
  /** Second stat for comparison scenes. */
  stat2?: string | null;
  statLabel2?: string | null;
  /** Optional on-screen formula / takeaway */
  takeaway?: string | null;
}

export interface Scene {
  id: string;
  index: number;
  role: 'hook' | 'body' | 'summary' | 'cta' | 'endcard';
  section: string;
  variant: ExplanationVariantId | HookVariantId | 'cta_card' | 'endcard';
  background: BackgroundVariantId;
  transitionIn: TransitionVariantId;
  textPosition: TextPositionId;
  accent: string;
  /** seconds */
  duration: number;
  startTime: number;
  /** exact voiceover slice this scene covers */
  narration: string;
  captionIds: string[];
  content: SceneContent;
  /** asset ids from the library that are shown in this scene */
  assetIds: string[];
  reason: SceneReason;
  /** user locked the scene: never auto-regenerate it */
  locked: boolean;
  /** user edited: never silently overwrite on regenerate */
  userEdited: boolean;
}

/* ------------------------------------------------------------------ */
/* Captions (section 11)                                              */
/* ------------------------------------------------------------------ */

export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  text: string;
  /** linked scene id */
  sceneId: string | null;
  /** words flagged as glossary terms, used for highlight styling */
  terms: string[];
  userEdited: boolean;
}

export interface AudioSegment {
  index: number;
  start: number;
  end: number;
  text: string;
}

/* ------------------------------------------------------------------ */
/* Visual history (section 8)                                         */
/* ------------------------------------------------------------------ */

export interface HistoryEntry {
  videoId: string;
  createdAt: string;
  topic: string;
  hookVariant: HookVariantId;
  /** ordered variant ids for the long video (hook variants included) */
  sceneOrder: SceneVariantId[];
  backgrounds: BackgroundVariantId[];
  transitions: TransitionVariantId[];
  textPositions: TextPositionId[];
  accents: string[];
  sceneDurations: number[];
  ctaAnimation: CtaAnimationId;
  captionStyle: CaptionStyleId;
  /** short hooks for each short */
  shortHooks: HookVariantId[];
  shortOrders: SceneVariantId[][];
  assetIds: string[];
  thumbConcepts: string[];
}

export interface VisualHistory {
  version: number;
  videos: HistoryEntry[];
}

export interface SimilarityFactor {
  label: string;
  weight: number;
  score: number;
  detail: string;
}

export interface SimilarityResult {
  /** 0..100 - 100 means identical */
  score: number;
  against: { videoId: string; topic: string; score: number }[];
  factors: SimilarityFactor[];
  /** human readable reasons, surfaced in the UI before export is allowed */
  reasons: string[];
  blocking: boolean;
  threshold: number;
}

/* ------------------------------------------------------------------ */
/* Assets (section 12)                                                */
/* ------------------------------------------------------------------ */

export type AssetKind =
  | 'logo'
  | 'screenshot'
  | 'chart'
  | 'icon'
  | 'broll'
  | 'document'
  | 'texture'
  | 'sfx'
  | 'font';

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  fileName: string;
  /** relative path under data/assets */
  path: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
  tags: string[];
  status: 'active' | 'archived';
  preferred: boolean;
  /** license / provenance - never auto-download unknown-license stock */
  source: string;
  license: string;
  addedAt: string;
  /** populated after a render so the UI can answer "where was this used?" */
  usedIn: { videoId: string; sceneId: string; role: string }[];
  /** user pinned this asset out of automatic selection */
  blocked: boolean;
}

/* ------------------------------------------------------------------ */
/* QC (section 14)                                                    */
/* ------------------------------------------------------------------ */

export type QcSeverity = 'pass' | 'warn' | 'critical';

export interface QcFinding {
  id: string;
  category: 'technical' | 'visual' | 'content';
  severity: QcSeverity;
  title: string;
  detail: string;
  /** scene index or timestamp when applicable */
  where?: string;
  autoFixable?: boolean;
}

export interface QcReport {
  videoId: string;
  target: 'long' | `short_${number}` | 'thumbnails' | 'captions';
  generatedAt: string;
  verdict: 'pass' | 'warn' | 'fail';
  findings: QcFinding[];
  metrics: Record<string, string | number | boolean>;
  similarity?: SimilarityResult | null;
  override?: { reason: string; at: string } | null;
}

/* ------------------------------------------------------------------ */
/* Project                                                            */
/* ------------------------------------------------------------------ */

export interface BrandPreset {
  id: string;
  name: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    surfaceDark: string;
    surfaceLight: string;
    textOnDark: string;
    textOnLight: string;
  };
  fonts: { heading: string; body: string; numeric: string };
  logoAssetId: string | null;
  /** fixed identity - never randomised */
  cornerRadius: number;
  captionStyleDefault: CaptionStyleId;
  iconStyle: 'line' | 'filled' | 'duotone';
  professionalism: 'clean' | 'premium' | 'technical';
}

export interface LongPlan {
  scenes: Scene[];
  totalDuration: number;
  endScreenReserveSeconds: number;
}

export interface ShortPlan {
  id: 'short_1' | 'short_2' | 'short_3';
  angle: 'question_problem' | 'number_comparison' | 'mistake_warning_result';
  hookVariant: HookVariantId;
  scenes: Scene[];
  totalDuration: number;
  /** 9:16 native layout - never a resized landscape frame */
  native: true;
}

export interface Storyboard {
  videoId: string;
  createdAt: string;
  brand: BrandPreset;
  long: LongPlan;
  shorts: ShortPlan[];
  captions: CaptionCue[];
  segments: AudioSegment[];
  warnings: string[];
  similarity: SimilarityResult | null;
}

export interface ProjectMeta {
  input: ProjectInput;
  brand: BrandPreset;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'storyboarded' | 'previewed' | 'exported';
}

export interface RenderArtifact {
  kind: 'preview' | 'final';
  target: 'long' | `short_${number}`;
  fileName: string;
  relPath: string;
  createdAt: string;
  durationSec: number;
  width: number;
  height: number;
  sizeBytes: number;
  probe: Record<string, unknown> | null;
}

export interface Project {
  meta: ProjectMeta;
  storyboard: Storyboard;
  artifacts: RenderArtifact[];
  qc: QcReport[];
}
