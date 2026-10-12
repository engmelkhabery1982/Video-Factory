/**
 * Content-led planning for the existing scene / audio / asset / render path.
 *
 * This module does not render, does not invent scripture, and does not turn a
 * missing recording into a still. A plan that cannot name its source blocks.
 */
import { getBrandPreset, BRAND_PRESETS } from './brand.js';
import type {
  BrandPreset,
  CaptionCue,
  ContentProfileId,
  NarrativeTreatment,
  QcFinding,
  Scene,
  ScenePlanRecord,
  Storyboard,
} from './types.js';

export type { ContentProfileId, NarrativeTreatment, ScenePlanRecord };

export const CONSTRUCTION_BACKGROUNDS = ['blueprint', 'dark_grid', 'light_technical', 'dashboard_ui', 'split_visual', 'site_footage'] as const;
export const TEMPLATE_SLIDE_VARIANTS = ['animated_checklist', 'process_flow', 'cta_card'] as const;

export const PROMOTIONAL_STRUCTURE_TITLES = [
  'Missing opening hook',
  'CTA count is not exactly one',
  'Product only appears at the end',
  'Short CTA count',
  'Short missing hook',
  'Short is not natively vertical',
] as const;

const PROMOTIONAL_TITLE_SET = new Set<string>(PROMOTIONAL_STRUCTURE_TITLES);

export interface ApprovedInterval {
  id: string;
  text: string;
  start: number;
  end: number;
  /** Same id means one picture held across those spoken lines. Times stay as given. */
  visualGroup?: string | null;
  emphasis?: string | null;
  assetId?: string | null;
}

export interface SampleAsset {
  id: string;
  kind: 'video' | 'image';
  mimeType: string;
  source: string;
  license: string;
  /** Owner- or license-holder path. Not proof the file is in this workspace. */
  path?: string | null;
  sha256?: string | null;
}

export interface BrandResolution {
  brand: BrandPreset;
  identityBound: boolean;
  refusedPreset: string | null;
  refusal: string | null;
}

export interface MissingAsset {
  id: string;
  path: string | null;
  sha256: string | null;
  reason: string;
}

export function contentProfileOf(input: { contentProfile?: unknown } | null | undefined): ContentProfileId | null {
  const value = input?.contentProfile;
  if (value === 'religious' || value === 'educational' || value === 'promotional') return value;
  return null;
}

export function promotionalStructureApplies(profile: ContentProfileId | null | undefined): boolean {
  return profile !== 'religious' && profile !== 'educational';
}

/**
 * Dialogue-structure rules assume a generated hook, one CTA, and product proof.
 * Imported narration must not be failed for refusing to invent those. Other
 * critical findings stay critical.
 */
export function omitPromotionalStructureFindings(
  findings: readonly QcFinding[],
  narrationSource: unknown,
): QcFinding[] {
  if (narrationSource !== 'external_ready') return [...findings];
  return findings.flatMap((finding) => {
    if (PROMOTIONAL_TITLE_SET.has(finding.title)) return [];
    if (finding.title === 'Caption exceeds two lines' && finding.severity === 'critical') {
      return [{
        ...finding,
        severity: 'warn' as const,
        detail: `${finding.detail} The spoken words were not rewritten to fit the caption box.`,
      }];
    }
    return [finding];
  });
}

export function resolveContentBrand(input: { brandPreset?: string | null; contentProfile?: unknown }): BrandResolution {
  const profile = contentProfileOf(input);
  const requested = (input.brandPreset ?? '').trim();
  if (profile === 'religious') {
    if (requested && requested !== 'buildtrack' && requested !== 'unbound-religious' && BRAND_PRESETS[requested]) {
      const brand = getBrandPreset(requested);
      if (brand.id === 'buildtrack' || brand.logoAssetId === 'brand-logo-buildtrack') {
        return unboundReligious(requested, 'The selected brand still points at BuildTrack. It was not used.');
      }
      return {
        brand,
        identityBound: Boolean(brand.logoAssetId),
        refusedPreset: null,
        refusal: brand.logoAssetId ? null : 'The selected religious brand has no identity asset. No logo was invented.',
      };
    }
    const refused = requested === 'buildtrack' ? 'buildtrack' : requested && requested !== 'unbound-religious' ? requested : null;
    const refusal = requested === 'buildtrack'
      ? 'BuildTrack was not substituted for religious content. The unbound visual system has no logo and is not a channel identity.'
      : requested && !BRAND_PRESETS[requested]
        ? `Brand preset "${requested}" is not registered. BuildTrack was not used as a fallback.`
        : 'No religious channel identity is bound. The unbound visual system is not a logo and is not the channel name.';
    return unboundReligious(refused, refusal);
  }
  if (profile === 'educational') {
    if (requested && BRAND_PRESETS[requested]) {
      const brand = getBrandPreset(requested);
      return {
        brand,
        identityBound: requested !== 'unbound-educational' && Boolean(brand.logoAssetId),
        refusedPreset: null,
        refusal: requested === 'unbound-educational' ? 'No educational channel identity is bound. BuildTrack was not assumed.' : null,
      };
    }
    return {
      brand: getBrandPreset('unbound-educational'),
      identityBound: false,
      refusedPreset: requested || null,
      refusal: requested
        ? `Brand preset "${requested}" is not registered. BuildTrack was not used as a fallback.`
        : 'No educational brand was selected. BuildTrack was not assumed.',
    };
  }
  return {
    brand: getBrandPreset(requested || 'buildtrack'),
    identityBound: Boolean(getBrandPreset(requested || 'buildtrack').logoAssetId),
    refusedPreset: null,
    refusal: null,
  };
}

function unboundReligious(refusedPreset: string | null, refusal: string): BrandResolution {
  return {
    brand: getBrandPreset('unbound-religious'),
    identityBound: false,
    refusedPreset,
    refusal,
  };
}

/** The logo that renders is the brand's own asset, never the first logo in the library. */
export function boundLogoAsset<T extends { id: string; kind: string; status: string; blocked?: boolean }>(
  assets: readonly T[],
  brand: { id: string; logoAssetId: string | null },
): T | null {
  if (brand.id === 'unbound-religious' || brand.id === 'unbound-educational') return null;
  if (!brand.logoAssetId) return null;
  return assets.find((asset) => asset.id === brand.logoAssetId && asset.kind === 'logo' && asset.status === 'active' && asset.blocked !== true) ?? null;
}

/** The built-in BuildTrack wordmark is only for that brand, and never for religious content. */
export function showBuiltInWordmark(brandId: string, contentProfile: string | null | undefined, logoBound: boolean): boolean {
  if (contentProfile === 'religious') return false;
  if (contentProfile === 'educational' && brandId !== 'buildtrack') return false;
  if (logoBound) return false;
  return brandId === 'buildtrack';
}

export function mediaPlaybackKind(url: string | null | undefined, mimeType?: string | null): 'video' | 'image' | 'none' {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (!url) return 'none';
  const path = url.split('?')[0].split('#')[0].toLowerCase();
  if (/\.(mp4|webm|mov|mkv)$/.test(path)) return 'video';
  if (/\.(png|jpe?g|webp|gif|svg)$/.test(path)) return 'image';
  return 'none';
}

/** The scene renderer switches on this. Image slots do not. */
export function playbackElementFor(kind: 'video' | 'image' | 'none'): 'video' | 'image' | 'none' {
  return kind;
}

export function footageBindingEligibility(asset: {
  status?: string;
  blocked?: boolean;
  source?: string | null;
  license?: string | null;
  mimeType?: string | null;
}): { eligible: boolean; reason: string | null } {
  if (asset.status !== 'active') return { eligible: false, reason: `status is '${asset.status ?? ''}', not active` };
  if (asset.blocked) return { eligible: false, reason: 'asset is blocked' };
  if (typeof asset.source !== 'string' || asset.source.trim().length === 0) return { eligible: false, reason: 'missing source provenance' };
  if (typeof asset.license !== 'string' || asset.license.trim().length === 0) return { eligible: false, reason: 'missing license provenance' };
  const mime = (asset.mimeType ?? '').toLowerCase();
  if (!mime.startsWith('video/')) {
    return {
      eligible: false,
      reason: mime.startsWith('image/') ? 'still image is not screen-recording footage' : `mimeType '${asset.mimeType ?? ''}' is not playable video`,
    };
  }
  return { eligible: true, reason: null };
}

export function isTruncatedDuplicate(headline: string, narration: string): boolean {
  const head = headline.trim();
  const spoken = narration.trim();
  if (!head || !spoken || head === spoken) return false;
  return spoken.startsWith(head);
}

export function selectContiguousWindow(
  intervals: readonly ApprovedInterval[],
  minSec: number,
  maxSec: number,
): { ok: true; intervals: ApprovedInterval[]; durationSec: number } | { ok: false; reason: string } {
  if (intervals.length === 0) {
    return { ok: false, reason: 'No approved intervals were supplied. Times were not estimated and no sentence was cut.' };
  }
  for (let i = 0; i < intervals.length; i += 1) {
    const item = intervals[i];
    if (!(item.end > item.start)) return { ok: false, reason: `Interval ${item.id} has no positive duration. It was not rewritten.` };
    if (i > 0 && item.start + 0.0005 < intervals[i - 1].end) {
      return { ok: false, reason: 'Approved intervals overlap. They were not rewritten to force a sample window.' };
    }
  }
  for (let start = 0; start < intervals.length; start += 1) {
    for (let end = start; end < intervals.length; end += 1) {
      const durationSec = Number((intervals[end].end - intervals[start].start).toFixed(3));
      if (durationSec + 1e-9 >= minSec && durationSec <= maxSec + 1e-9) {
        return { ok: true, intervals: intervals.slice(start, end + 1).map((item) => ({ ...item })), durationSec };
      }
    }
  }
  return {
    ok: false,
    reason: `No contiguous approved slice is between ${minSec}s and ${maxSec}s. No sentence was cut to force the length.`,
  };
}

function finding(
  category: QcFinding['category'],
  severity: QcFinding['severity'],
  title: string,
  detail: string,
  where?: string,
): QcFinding {
  return {
    id: `${category}_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 48)}`,
    category,
    severity,
    title,
    detail,
    where,
  };
}

export function contentLedFindings(
  storyboard: Storyboard,
  input?: { contentProfile?: unknown } | null,
): QcFinding[] {
  const profile = storyboard.contentProfile ?? contentProfileOf(input);
  if (!profile || profile === 'promotional') return [];
  const findings: QcFinding[] = [];
  if (profile === 'religious') {
    if (storyboard.brand.id === 'buildtrack' || storyboard.brand.logoAssetId === 'brand-logo-buildtrack') {
      findings.push(finding(
        'content',
        'critical',
        'BuildTrack identity in religious content',
        'Religious content is still bound to the BuildTrack brand or its logo. No logo was substituted automatically.',
        storyboard.brand.id,
      ));
    }
    for (const scene of storyboard.long.scenes) {
      if (scene.role === 'cta' || scene.variant === 'cta_card') {
        findings.push(finding('content', 'critical', 'Sales CTA in religious narration', `Scene ${scene.id} is a call to action. Imported religious narration does not add one.`, scene.id));
      }
      if ((CONSTRUCTION_BACKGROUNDS as readonly string[]).includes(scene.background) && scene.content.presentation !== 'owner_picture') {
        findings.push(finding('visual', 'critical', 'Construction background in religious content', `Scene ${scene.id} uses "${scene.background}".`, scene.id));
      }
      if ((TEMPLATE_SLIDE_VARIANTS as readonly string[]).includes(scene.variant)) {
        findings.push(finding('visual', 'critical', 'Template slide in religious content', `Scene ${scene.id} uses "${scene.variant}" instead of the bound picture.`, scene.id));
      }
      if (isTruncatedDuplicate(scene.content?.headline ?? '', scene.narration)) {
        findings.push(finding('visual', 'critical', 'Truncated headline duplicates narration', `Scene ${scene.id} shows a cut-off copy of the spoken line.`, scene.id));
      }
      if (scene.content?.presentation === 'screen_recording') {
        findings.push(finding('content', 'critical', 'Screen recording claimed for religious scene', `Scene ${scene.id} is not a screen recording.`, scene.id));
      }
      if (scene.content?.presentation !== 'owner_picture' || scene.assetIds.length === 0) {
        findings.push(finding('content', 'critical', 'Owner visual not bound', `Scene ${scene.id} has no licensed or owner-provided picture. A text slide was not accepted as the visual.`, scene.id));
      }
    }
  }
  if (profile === 'educational') {
    for (const scene of storyboard.long.scenes) {
      if (scene.content?.presentation === 'screen_recording' && scene.content.mediaKind !== 'video') {
        findings.push(finding(
          'content',
          'critical',
          'Still presented as a screen recording',
          `Scene ${scene.id} claims a screen recording but its media is not playable video. A pan or zoom of a still is not footage.`,
          scene.id,
        ));
      }
    }
    for (const record of storyboard.scenePlan ?? []) {
      if (record.treatment === 'screen_walkthrough' && record.sourceKind !== 'owner_video') {
        findings.push(finding(
          'content',
          'critical',
          'Walkthrough has no recording',
          record.blockReason ?? `Scene ${record.sceneId} is not a screen recording.`,
          record.sceneId,
        ));
      }
    }
  }
  return findings;
}

export interface SamplePlan {
  profile: 'religious' | 'educational';
  videoId: string;
  derivedFrom: string | null;
  brandResolution: BrandResolution;
  durationSec: number | null;
  intervals: ApprovedInterval[];
  scenePlan: ScenePlanRecord[];
  canRender: boolean;
  missing: MissingAsset[];
  wordsInserted: false;
  timingsRewritten: false;
}

function assetById(assets: readonly SampleAsset[], id: string | null | undefined): SampleAsset | null {
  if (!id) return null;
  return assets.find((asset) => asset.id === id) ?? null;
}

function usableImage(asset: SampleAsset | null): boolean {
  return !!asset && asset.kind === 'image' && mediaPlaybackKind(asset.path, asset.mimeType) === 'image' && asset.source.trim().length > 0 && asset.license.trim().length > 0;
}

function usableVideo(asset: SampleAsset | null): boolean {
  return !!asset
    && asset.kind === 'video'
    && mediaPlaybackKind(asset.path, asset.mimeType) === 'video'
    && asset.source.trim().length > 0
    && asset.license.trim().length > 0;
}

export function planDerivedSample(request: {
  profile: 'religious' | 'educational';
  videoId: string;
  derivedFrom?: string | null;
  brandPreset?: string | null;
  intervals?: readonly ApprovedInterval[] | null;
  assets?: readonly SampleAsset[] | null;
  action?: string | null;
  pointer?: { x: number; y: number; width: number; height: number } | null;
  minSec?: number;
  maxSec?: number;
}): SamplePlan {
  const minSec = request.minSec ?? (request.profile === 'religious' ? 12 : 15);
  const maxSec = request.maxSec ?? 20;
  const brandResolution = resolveContentBrand({ brandPreset: request.brandPreset, contentProfile: request.profile });
  const assets = request.assets ?? [];
  const missing: MissingAsset[] = [];
  if (brandResolution.refusal) {
    missing.push({ id: 'channel-identity', path: null, sha256: null, reason: brandResolution.refusal });
  }
  const window = selectContiguousWindow(request.intervals ?? [], minSec, maxSec);
  if (!window.ok) {
    missing.push({ id: 'approved-intervals', path: null, sha256: null, reason: window.reason });
    return {
      profile: request.profile,
      videoId: request.videoId,
      derivedFrom: request.derivedFrom ?? null,
      brandResolution,
      durationSec: null,
      intervals: [],
      scenePlan: [],
      canRender: false,
      missing,
      wordsInserted: false,
      timingsRewritten: false,
    };
  }

  const scenePlan: ScenePlanRecord[] = window.intervals.map((interval) => {
    const bound = assetById(assets, interval.assetId);
    if (request.profile === 'religious') {
      const image = usableImage(bound);
      const blockReason = image ? null : 'No licensed or owner-provided picture is bound to this spoken line. A stock download, a text card, and the BuildTrack template were not used.';
      if (!image) missing.push({ id: `visual-${interval.id}`, path: bound?.path ?? null, sha256: bound?.sha256 ?? null, reason: blockReason! });
      return {
        sceneId: interval.id,
        treatment: 'reflective_narration',
        narrativePurpose: 'Hold the spoken line without adding a lesson, a name, or a call to action.',
        proposedVisual: image ? `Owner or licensed picture ${bound!.id}` : 'No picture bound',
        whyThisVisual: image
          ? 'The picture is the visual. The caption carries the approved words. The line was not turned into a checklist.'
          : 'Meaning cannot choose a picture that was not supplied.',
        sourceAssetId: image ? bound!.id : null,
        sourceKind: image ? 'owner_image' : 'missing',
        motion: 'hold',
        emphasis: interval.emphasis ?? null,
        captionPlacement: 'lower_contrast',
        audioStart: interval.start,
        audioEnd: interval.end,
        spokenText: interval.text,
        blocksRender: !image,
        blockReason,
      };
    }
    const video = usableVideo(bound);
    const action = (request.action ?? '').trim();
    let blockReason: string | null = null;
    if (!action) blockReason = 'The one workbook action was not specified. It was not invented.';
    else if (!video) blockReason = bound && mediaPlaybackKind(bound.path, bound.mimeType) === 'image'
      ? 'The bound file is a still. It is not a screen recording, and a pan or zoom of it will not be presented as one.'
      : 'The Excel screen recording is not bound. A still or an animated screenshot was not substituted.';
    if (blockReason) missing.push({ id: `recording-${interval.id}`, path: bound?.path ?? null, sha256: bound?.sha256 ?? null, reason: blockReason });
    return {
      sceneId: interval.id,
      treatment: 'screen_walkthrough',
      narrativePurpose: action || 'One workbook action, not yet specified.',
      proposedVisual: video ? `Play ${bound!.id} and hold the supplied highlight` : 'No recording bound',
      whyThisVisual: 'The visual is the recording of that action. The caption follows the approved interval. Cells are not redrawn.',
      sourceAssetId: video ? bound!.id : null,
      sourceKind: video ? 'owner_video' : 'missing',
      motion: video && request.pointer ? 'timed_pointer' : video ? 'genuine_footage' : 'still_not_footage',
      emphasis: action || null,
      captionPlacement: 'lower_contrast',
      audioStart: interval.start,
      audioEnd: interval.end,
      spokenText: interval.text,
      blocksRender: blockReason !== null,
      blockReason,
    };
  });

  return {
    profile: request.profile,
    videoId: request.videoId,
    derivedFrom: request.derivedFrom ?? null,
    brandResolution,
    durationSec: window.durationSec,
    intervals: window.intervals,
    scenePlan,
    canRender: scenePlan.length > 0 && scenePlan.every((record) => !record.blocksRender) && brandResolution.identityBound,
    missing,
    wordsInserted: false,
    timingsRewritten: false,
  };
}

/**
 * Assets required for the two derived samples named in the 12 October 2026
 * work order. Paths are the owner's. This workspace does not contain them.
 */
export function requiredSampleAssets(): MissingAsset[] {
  return [
    {
      id: 'religious-approved-audio',
      path: 'data/voiceover/Rahman_Raheem_Test_01_long_7d51848161d4.wav',
      sha256: 'dc8e6f2422be7777d0ddfab9fc5014cdd68090a5eb7489edf29ca5caa46bd6b7',
      reason: 'Approved 58.84s narration. It must be preserved. It is not in this workspace, so no sample audio was synthesized.',
    },
    {
      id: 'religious-approved-timings',
      path: 'data/projects/Rahman_Raheem_Test_01/project.json',
      sha256: null,
      reason: 'The 16 approved timings live in the project. Sentence 2 is said to start at 6.022s from CTC emissions. That value was not hardcoded and the project is not in this workspace.',
    },
    {
      id: 'religious-owner-visuals',
      path: null,
      sha256: null,
      reason: 'Licensed or owner-provided pictures for the opening lines and the names. None were supplied. No stock image was downloaded and no depiction of Allah was created.',
    },
    {
      id: 'religious-channel-identity',
      path: null,
      sha256: null,
      reason: 'An explicit religious channel identity. BuildTrack was not selected in its place. The unbound visual system is not that identity.',
    },
    {
      id: 'religious-reference-video',
      path: 'F:/فيديوهات القناة الدينية/Asmaa_EP02_Final_v2.mp4',
      sha256: null,
      reason: 'Reference only. It is not in this workspace and must not be used as a frame source.',
    },
    {
      id: 'educational-screen-recording',
      path: 'data/screen-recordings/BuildTrack_T03_Excel_01.mp4',
      sha256: null,
      reason: 'The existing Excel screen recording. It is not in this workspace. A still, a pan, or an animated screenshot was not created in its place.',
    },
    {
      id: 'educational-narration',
      path: null,
      sha256: null,
      reason: 'The narration aligned to that recording, and the one action to show. Neither was in this workspace, so no teaching example was invented.',
    },
  ];
}

export interface SupportRow {
  input: string;
  status: 'supported' | 'partial' | 'unsupported';
  detail: string;
}

export function inputSupportMatrix(): SupportRow[] {
  return [
    { input: 'Image import', status: 'supported', detail: 'The asset library accepts images. Generated image slots still require an active image with source and license.' },
    { input: 'Storyboard import', status: 'unsupported', detail: 'There is no separate storyboard-file importer. A storyboard is generated from the project script and approved timings.' },
    { input: 'Script', status: 'supported', detail: 'The entered script is the spoken reference for external narration. The factory does not add a hook, a question, or a call to action to it.' },
    { input: 'Text-to-speech', status: 'partial', detail: 'In-app dialogue can use the local speech engine. Approved external narration must not be replaced by generated speech.' },
    { input: 'Audio-only transcription', status: 'partial', detail: 'A transcript is not timing. CTC alignment is a separate review path and does not by itself approve a recording.' },
    { input: 'Native video playback', status: 'partial', detail: 'A screen-walkthrough scene plays a video asset in the existing scene renderer. Generated image slots still reject video. A still pan is not playback.' },
    { input: 'Video B-roll in an image slot', status: 'unsupported', detail: 'Image slots remain image-only. Offering a video there would claim a renderer path that slot does not use.' },
    { input: 'Automatic first logo', status: 'unsupported', detail: 'The rendered logo is the selected brand asset only. The first active logo is not chosen.' },
  ];
}

export function treatmentSupport(): Array<{ id: NarrativeTreatment; status: 'renderable' | 'partial' | 'not_implemented'; detail: string }> {
  return [
    { id: 'reflective_narration', status: 'partial', detail: 'The existing scene renderer can hold an owner picture with calm captions. It does not render without that picture, and it does not depict Allah.' },
    { id: 'short_human_situation', status: 'not_implemented', detail: 'No actor or situation footage path was added. It is not claimed as working.' },
    { id: 'two_voice_dialogue', status: 'partial', detail: 'The existing in-app dialogue path remains. It is not the religious external-narration path and must not replace an approved recording.' },
    { id: 'screen_walkthrough', status: 'partial', detail: 'Playable when a real video asset, one action, and approved intervals are bound. A still is refused.' },
    { id: 'evidence_comparison', status: 'partial', detail: 'Promotional comparison layouts exist. They were not retargeted as educational evidence and must not mix fictional figures into a real workbook.' },
    { id: 'worked_example', status: 'not_implemented', detail: 'No separate worked-example renderer was added.' },
    { id: 'question_to_answer', status: 'not_implemented', detail: 'No separate question-to-answer renderer was added. External narration does not invent a question or an answer.' },
  ];
}

/**
 * Scenes for the existing renderer. Times and spoken text are copied.
 * A blocked plan still refuses the construction template, and it does not
 * claim a still is footage.
 */
export function scenesFromSamplePlan(
  plan: SamplePlan,
  pointer?: { x: number; y: number; width: number; height: number } | null,
): { scenes: Scene[]; captions: CaptionCue[] } {
  const scenes: Scene[] = [];
  const captions: CaptionCue[] = [];
  plan.scenePlan.forEach((record, index) => {
    const video = record.sourceKind === 'owner_video';
    const image = record.sourceKind === 'owner_image' || record.sourceKind === 'licensed_image';
    const presentation = plan.profile === 'educational'
      ? (video ? 'screen_recording' as const : 'reflective' as const)
      : (image ? 'owner_picture' as const : 'reflective' as const);
    const id = record.sceneId;
    const cueId = `cap_${id}`;
    scenes.push({
      id,
      index,
      role: 'body',
      section: '',
      variant: 'key_statement',
      background: 'full_typography',
      transitionIn: 'direct_cut',
      textPosition: 'lower_third',
      accent: plan.brandResolution.brand.colors.accent,
      duration: Number((record.audioEnd - record.audioStart).toFixed(3)),
      startTime: record.audioStart,
      narration: record.spokenText,
      captionIds: [cueId],
      content: {
        headline: '',
        items: [],
        stat: null,
        statLabel: null,
        stat2: null,
        statLabel2: null,
        takeaway: null,
        source: null,
        emphasis: record.emphasis,
        presentation,
        mediaKind: video ? 'video' : image ? 'image' : 'none',
        pointer: video ? pointer ?? null : null,
      },
      assetIds: record.sourceAssetId ? [record.sourceAssetId] : [],
      reason: {
        detected: record.treatment ?? 'content-led',
        evidence: record.whyThisVisual,
        notUsedRecently: [],
        alternatives: [],
      },
      locked: false,
      userEdited: false,
    });
    captions.push({
      id: cueId,
      start: record.audioStart,
      end: record.audioEnd,
      text: record.spokenText,
      sceneId: id,
      terms: [],
      userEdited: false,
    });
  });
  return { scenes, captions };
}

/** Known owner paths checked by the sample report. Existence is not provenance. */
export function localSamplePaths(): Array<{ id: string; path: string }> {
  return [
    { id: 'religious-approved-audio', path: 'data/voiceover/Rahman_Raheem_Test_01_long_7d51848161d4.wav' },
    { id: 'religious-approved-project', path: 'data/projects/Rahman_Raheem_Test_01/project.json' },
    { id: 'failed-preview', path: 'output/Rahman_Raheem_Test_01/long/Rahman_Raheem_Test_01_long_preview.mp4' },
    { id: 'educational-screen-recording', path: 'data/screen-recordings/BuildTrack_T03_Excel_01.mp4' },
  ];
}
