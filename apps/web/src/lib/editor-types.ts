/**
 * Editor contract v1 — frontend-local DTOs.
 *
 * This file mirrors the SHARED CONTRACT (`EDITOR_CONTRACT_V1.md`, 13 October
 * 2026) exactly. Arena owns the server DTO in `apps/api`; these types exist so
 * the frontend can be built and tested against the FIXED JSON interface while
 * the backend is implemented in parallel. If the server shape and this file
 * disagree, the difference is reported — the backend is never patched from
 * here, and the frontend never invents a second API for a missing endpoint.
 *
 * All numeric times are seconds. Source offsets (`sourceInSec`/`sourceOutSec`)
 * and composition time (`startSec`) are distinct.
 */

export const EDITOR_SCHEMA_VERSION = 1;

export type EditorTargetId = 'long' | 'short_1' | 'short_2' | 'short_3';
export type ContentProfile = 'religious' | 'educational' | 'promotional';
export type EditorFormat = 'landscape' | 'portrait';
export type EditorAssetKind = 'image' | 'video' | 'audio';
export type ImageMotion = 'none' | 'slow_push' | 'pan_left' | 'pan_right';
export type ClipTransition = 'cut' | 'dissolve' | 'fade';
export type CaptionDirection = 'rtl' | 'ltr';
export type AlignmentState = 'unavailable' | 'not_requested' | 'running' | 'proposed' | 'approved';

export const EDITOR_TARGET_IDS: EditorTargetId[] = ['long', 'short_1', 'short_2', 'short_3'];
export const IMAGE_MOTIONS: ImageMotion[] = ['none', 'slow_push', 'pan_left', 'pan_right'];
export const CLIP_TRANSITIONS: ClipTransition[] = ['cut', 'dissolve', 'fade'];
export const ALIGNMENT_STATES: AlignmentState[] = ['unavailable', 'not_requested', 'running', 'proposed', 'approved'];

/** Normalized rectangle. A crop is in source coordinates; a highlight box is in DISPLAY-frame coordinates. */
export interface EditorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditorAssetRef {
  id: string;
  kind: EditorAssetKind;
  name: string;
  /** local served URL (`/media/asset/:id`); empty when the server has no URL yet */
  mediaUrl: string;
  durationSec: number | null;
  source: string;
  license: string;
  /**
   * Present only when the server measured the file. Non-empty metadata is not
   * proof of a licence, and a missing hash is not a zero hash.
   */
  sha256?: string | null;
}

export interface EditorVisualClip {
  id: string;
  sourceAssetId: string | null;
  startSec: number;
  durationSec: number;
  sourceInSec: number | null;
  /** null for stills: a still has no source out-point */
  sourceOutSec: number | null;
  /** normalized SOURCE coordinates; default full frame */
  crop: EditorBox;
  motion: ImageMotion;
  transition: ClipTransition;
  locked: boolean;
}

export interface EditorAudioClip {
  id: string;
  sourceAssetId: string;
  speakerId: string | null;
  startSec: number;
  sourceInSec: number;
  sourceOutSec: number;
  gainDb: number;
  locked: boolean;
  /**
   * An approved trim/replacement must explicitly invalidate affected approvals.
   * This milestone does not synthesize new voices.
   */
  approved: boolean;
}

export interface EditorCaption {
  id: string;
  startSec: number;
  endSec: number;
  /** complete words, shaping and diacritics preserved */
  text: string;
  language: string;
  direction: CaptionDirection;
  fontSizePx: number;
  /** normalized x/y of the caption anchor inside the frame */
  position: { x: number; y: number };
  locked: boolean;
  /** Translation link: the spoken cue this translation shares timing with. Null for spoken cues. */
  cueOf?: string | null;
}

export interface EditorHighlight {
  id: string;
  startSec: number;
  endSec: number;
  visualClipId: string;
  /** normalized DISPLAY-frame coordinates */
  box: EditorBox;
  label: string | null;
  locked: boolean;
}

export type SyncVerdict = 'verified' | 'discrepancy' | 'unverified' | 'stale' | 'not_requested';

export interface EditorAlignment {
  state: AlignmentState;
  audioHash?: string | null;
  sourceRevision?: number | null;
  proposalId?: string | null;
  /** Identity of the narration excerpt the alignment was made for. */
  excerptSha256?: string | null;
  /** Forced alignment alone is unverified. The verdict says what the transcript comparison showed. */
  syncVerdict?: SyncVerdict | null;
}

export interface EditorDocument {
  schemaVersion: number;
  projectId: string;
  revision: number;
  contentProfile: ContentProfile;
  channelBrandId: string | null;
  targetId: EditorTargetId;
  format: EditorFormat;
  durationSec: number;
  assets: EditorAssetRef[];
  visualClips: EditorVisualClip[];
  audioClips: EditorAudioClip[];
  captions: EditorCaption[];
  highlights: EditorHighlight[];
  alignment: EditorAlignment;
}

export interface EditorEngineState {
  available: boolean;
  /** why it is unavailable, when the server says so */
  reason?: string | null;
}

export interface EditorCapabilities {
  /** targets with a real editor document; absent means unknown, never "all" */
  targets?: EditorTargetId[];
  alignment?: EditorEngineState & { engine?: string | null };
  voiceGeneration?: EditorEngineState & { engines?: Array<{ id: string; available: boolean; reason?: string | null }> };
  preview?: EditorEngineState;
  render?: EditorEngineState;
  notes?: string[];
}

export interface EditorEnvelope {
  document: EditorDocument;
  undoAvailable: boolean;
  redoAvailable: boolean;
  capabilities: EditorCapabilities;
  /** Channel identity of the SAVED revision, from the server's resolver. */
  identity?: import('@buildtrack/core').DocumentIdentity;
}

export type EditorCollection = 'visualClips' | 'audioClips' | 'captions' | 'highlights';

export type EditorOperation =
  | { type: 'insert'; collection: EditorCollection; item: unknown }
  | { type: 'update'; collection: EditorCollection; id: string; changes: Record<string, unknown> }
  | { type: 'remove'; collection: EditorCollection; id: string }
  | { type: 'reorder'; collection: 'visualClips'; ids: string[] }
  | { type: 'split'; collection: 'visualClips'; id: string; atSec: number }
  | { type: 'setDocument'; changes: Partial<Pick<EditorDocument, 'contentProfile' | 'channelBrandId' | 'format'>> };

export interface EditorPatchRequest {
  targetId: EditorTargetId;
  baseRevision: number;
  operations: EditorOperation[];
}

export interface EditorUndoRequest {
  targetId: EditorTargetId;
  baseRevision: number;
}

export interface AlignmentStartResult {
  jobId?: string;
  status: 'running' | string;
  /** structured blocker when no real job started — never guessed times */
  blocker?: { code: string; message: string; missing?: string[] } | null;
}

export interface AlignmentRow {
  sceneId: string;
  cueId: string | null;
  proposedStartSec: number | null;
  proposedEndSec: number | null;
  unresolvedSpan: boolean;
  note?: string | null;
}

export interface AlignmentProposalSummary {
  proposalId: string;
  status: string;
  stale: boolean;
  staleReasons: string[];
  /** Verdict of the transcript comparison. A discrepancy cannot be accepted. */
  syncVerdict: SyncVerdict;
  syncReasons: string[];
  transcriptAvailable: boolean;
  acceptable: boolean;
}

export interface AlignmentJobResult {
  status: 'running' | 'proposed' | 'failed' | 'unavailable' | string;
  proposalId?: string | null;
  rows?: AlignmentRow[];
  error?: string | null;
  proposal?: AlignmentProposalSummary | null;
}

export interface PreviewStartResult {
  jobId?: string;
  status: 'running' | string;
  blocker?: { code: string; message: string } | null;
}

export interface PreviewJobResult {
  status: 'running' | 'ready' | 'failed' | 'unavailable' | string;
  /** the frozen revision the media was rendered from */
  revision?: number | null;
  range?: { startSec: number; endSec: number } | null;
  /** the actual returned local media URL */
  mediaUrl?: string | null;
  error?: string | null;
}

/** `GET /api/projects/:id/brand` — existing route, reused for channel identity. */
export interface ResolvedBrand {
  id: string;
  name: string;
  logoAssetId: string | null;
}
